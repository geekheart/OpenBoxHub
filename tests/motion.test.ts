import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'manifold-3d';
import type { Manifold } from 'manifold-3d';
import { buildModel } from '../src/geometry';
import { serializeSTL } from '../src/export';
import { serializeSTEP } from '../src/step';
import { createCollisionWorld } from '../src/collision';
import { advanceMotion, createMotionPlan, pathLength, sampleMotion } from '../src/motion';
import type { MotionCursor, MotionOffsets, MotionPath, MotionPlan, ViewMode } from '../src/motion';
import { DEFAULT_PARAMS, partOverrideKey } from '../src/types';
import type { ModelData, Params, Vec3 } from '../src/types';

const module = await Module();
module.setup();
const EPSILON = 0.00001;

/** Independent 3D CSG oracle: deliberately does not use collision.ts or its XY sweeps. */
function collisionOracle(model: ModelData) {
  const assembled = model.parts.map(part => {
    let solid = new module.Manifold(new module.Mesh({ numProp: 3, vertProperties: part.positions, triVerts: part.indices }));
    if (part.assemblyRotation) {
      const rotated = solid.rotate(part.assemblyRotation.map(value => value * 180 / Math.PI) as Vec3);
      solid.delete(); solid = rotated;
    }
    const translated = solid.translate(part.assemblyPosition);
    solid.delete();
    return translated;
  });
  return {
    firstOverlap(offsets: MotionOffsets): string | null {
      const solids: Manifold[] = [];
      try {
        assembled.forEach((solid, index) => solids.push(solid.translate(offsets[index])));
        const bounds = solids.map(solid => solid.boundingBox());
        for (let a = 0; a < solids.length; a++) for (let b = a + 1; b < solids.length; b++) {
          // Broad phase only skips pairs that cannot possibly share positive volume.
          if (![0, 1, 2].every(axis => Math.min(bounds[a].max[axis], bounds[b].max[axis]) -
            Math.max(bounds[a].min[axis], bounds[b].min[axis]) > 1e-7)) continue;
          const intersection = solids[a].intersect(solids[b]);
          try {
            if (intersection.volume() > EPSILON) return `${model.parts[a].id} / ${model.parts[b].id}`;
          } finally { intersection.delete(); }
        }
        return null;
      } finally { solids.forEach(solid => solid.delete()); }
    },
    dispose() { assembled.forEach(solid => solid.delete()); },
  };
}

function segmentSamples(path: MotionPath): number[] {
  const distances = new Set(path.distances);
  for (let index = 1; index < path.distances.length; index++) {
    const from = path.distances[index - 1], length = path.distances[index] - from;
    if (length > 1e-9) for (const fraction of [0.25, 0.5, 0.75]) distances.add(from + length * fraction);
  }
  return [...distances].sort((a, b) => a - b);
}

function checkPlan(model: ModelData, plan: MotionPlan): void {
  const oracle = collisionOracle(model);
  const continuous = createCollisionWorld(module, model.parts);
  try {
    for (const branch of ['open', 'exploded'] as const) {
      const path = plan[branch];
      assert.deepEqual(sampleMotion(plan, { branch, distance: 0 }), model.parts.map(() => [0, 0, 0]));
      for (let index = 1; index < path.points.length; index++) {
        assert.ok(path.distances[index] >= path.distances[index - 1]);
        let horizontal = false, vertical = false;
        path.points[index].forEach((offset, partIndex) => offset.forEach((value, axis) => {
          if (Math.abs(value - path.points[index - 1][partIndex][axis]) > 1e-8) {
            if (axis === 2) vertical = true;
            else horizontal = true;
          }
        }));
        assert.ok(!(horizontal && vertical), `${branch} segment ${index} moves diagonally instead of lifting before spreading`);
        assert.equal(continuous.firstCollision(path.points[index - 1], path.points[index]), null,
          `${branch} segment ${index} has a collision between its sampled poses`);
        assert.equal(continuous.firstCollision(path.points[index], path.points[index - 1]), null,
          `${branch} segment ${index} cannot safely return along the same path`);
        model.parts.forEach((part, partIndex) => {
          if (part.kind !== 'inner') return;
          const before = path.points[index - 1][partIndex], after = path.points[index][partIndex];
          if (Math.abs(before[0] - after[0]) > 1e-8 || Math.abs(before[1] - after[1]) > 1e-8)
            assert.ok(part.assemblyPosition[2] + before[2] > model.params.height,
              'an insert must clear the outer box before its horizontal motion begins');
        });
      }
      for (const distance of segmentSamples(path)) {
        assert.equal(oracle.firstOverlap(sampleMotion(plan, { branch, distance })), null,
          `${branch} contains a 3D overlap at distance ${distance}`);
      }
    }
    for (const fraction of [0, 0.25, 0.5, 1]) {
      assert.deepEqual(sampleMotion(plan, { branch: 'open', distance: plan.junction * fraction }),
        sampleMotion(plan, { branch: 'exploded', distance: plan.junction * fraction }));
    }
    const final = finalExplosion(plan);
    model.parts.forEach((part, index) => {
      if (part.kind === 'inner') assert.ok(part.assemblyPosition[2] + final[index][2] > model.params.height,
        'every fully exploded insert must be lifted out of the outer box, including centered rings');
    });
  } finally { continuous.dispose(); oracle.dispose(); }
}

function finalExplosion(plan: MotionPlan): MotionOffsets {
  return sampleMotion(plan, { branch: 'exploded', distance: pathLength(plan.exploded) });
}

function onionGroups(size: number): number[][] {
  const groups: number[][] = [];
  for (let layer = 0; layer < Math.ceil(size / 2); layer++) {
    const cells: number[] = [];
    for (let row = layer; row < size - layer; row++) for (let col = layer; col < size - layer; col++) {
      if (row === layer || col === layer || row === size - layer - 1 || col === size - layer - 1)
        cells.push(row * size + col);
    }
    groups.push(cells);
  }
  return groups;
}

function checkNestedLayers(model: ModelData, plan: MotionPlan, outsideToInside: number[][]): void {
  const final = finalExplosion(plan);
  const indices = outsideToInside.map(group => model.parts.findIndex(part =>
    part.cellIds?.length === group.length && group.every(cell => part.cellIds!.includes(cell))));
  assert.ok(indices.every(index => index >= 0));
  for (let i = 1; i < indices.length; i++) {
    const lower = indices[i - 1], upper = indices[i];
    const lowerTop = model.parts[lower].assemblyPosition[2] + final[lower][2] + model.parts[lower].bounds[2];
    const upperBottom = model.parts[upper].assemblyPosition[2] + final[upper][2];
    assert.ok(upperBottom > lowerTop + 0.0001,
      `${model.parts[upper].id} must be lifted above the surrounding ${model.parts[lower].id}, not hidden inside its ring`);
  }
}

function checkFullSpread(model: ModelData, plan: MotionPlan): void {
  const final = finalExplosion(plan);
  model.parts.forEach((part, index) => {
    if (part.kind !== 'inner') return;
    for (const axis of [0, 1]) assert.ok(Math.abs(final[index][axis] - part.assemblyPosition[axis] * 1.1) < 0.0001,
      `${part.id} must retain its full radial spread after obstacles are lifted into separate layers`);
  });
}

function rotateCells(cells: number[], size: number): number[] {
  return cells.map(cell => (cell % size) * size + size - 1 - Math.floor(cell / size)).sort((a, b) => a - b);
}

function fillWithSingleCells(size: number, groups: number[][]): number[][] {
  const used = new Set(groups.flat());
  return [...groups, ...Array.from({ length: size * size }, (_, cell) => cell).filter(cell => !used.has(cell)).map(cell => [cell])];
}

test('all lid styles have collision-free assembled, open and exploded path endpoints and intermediate poses', () => {
  for (const lidType of ['sleeve', 'inset', 'none'] as const) {
    const model = buildModel(module, { ...DEFAULT_PARAMS, lidType });
    const plan = createMotionPlan(module, model);
    assert.equal(plan.spreadScale, 1, 'ordinary separate inserts should retain the full radial spread');
    const final = finalExplosion(plan);
    const heights = model.parts.flatMap((part, index) => part.kind === 'inner' ? [final[index][2]] : []);
    assert.ok(Math.max(...heights) - Math.min(...heights) < EPSILON, 'ordinary inserts need only one shared layer');
    checkFullSpread(model, plan);
    checkPlan(model, plan);
  }
});

test('a 4×4 ring stays below its four central inserts so every part keeps its full horizontal spread', () => {
  const params: Params = { ...DEFAULT_PARAMS, rows: 4, cols: 4 };
  const center = [5, 6, 9, 10];
  const ring = Array.from({ length: 16 }, (_, index) => index).filter(index => !center.includes(index));
  assert.equal(ring.length, 12);
  const model = buildModel(module, params, [ring, ...center.map(cell => [cell])]);
  const plan = createMotionPlan(module, model);
  checkFullSpread(model, plan);
  for (const cell of center) checkNestedLayers(model, plan, [ring, [cell]]);
  checkPlan(model, plan);
  const oracle = collisionOracle(model);
  try {
    const final = finalExplosion(plan);
    const ringIndex = model.parts.findIndex(part => part.cellIds?.length === ring.length);
    const unsafeFullSpread = [0.25, 0.5, 0.75, 1].some(fraction => {
      const offsets = final.map((offset, index): Vec3 => model.parts[index].kind === 'inner'
        ? [model.parts[index].assemblyPosition[0] * 1.1 * fraction,
          model.parts[index].assemblyPosition[1] * 1.1 * fraction, final[ringIndex][2]] : [...offset]);
      return oracle.firstOverlap(offsets) !== null;
    });
    assert.ok(unsafeFullSpread, 'the regression must contain a real collision when its additional layers are removed');
  } finally { oracle.dispose(); }
});

test('a centered insert rises above a 3×3 ring even though its radial displacement is zero', () => {
  const groups = onionGroups(3);
  const model = buildModel(module, { ...DEFAULT_PARAMS, rows: 3, cols: 3 }, groups);
  const plan = createMotionPlan(module, model);
  checkNestedLayers(model, plan, groups);
  checkFullSpread(model, plan);
  const center = model.parts.findIndex(part => part.cellIds?.length === 1);
  assert.ok(finalExplosion(plan)[center].slice(0, 2).every(value => Math.abs(value) < EPSILON));
  checkPlan(model, plan);
});

test('U-shaped pockets raise their center inserts in all four opening directions', () => {
  let u = [0, 2, 3, 5, 6, 7, 8];
  for (let direction = 0; direction < 4; direction++) {
    const groups = fillWithSingleCells(3, [u, [4]]);
    const model = buildModel(module, { ...DEFAULT_PARAMS, rows: 3, cols: 3 }, groups);
    const plan = createMotionPlan(module, model);
    checkNestedLayers(model, plan, [u, [4]]);
    checkFullSpread(model, plan);
    checkPlan(model, plan);
    u = rotateCells(u, 3);
  }
});

test('a long center insert moving toward a U opening rises before spreading while still inside the arms', () => {
  let u = [0, 2, 3, 5, 6, 7, 8], center = [1, 4];
  for (let direction = 0; direction < 4; direction++) {
    const lidType = (['none', 'sleeve', 'inset', 'inset'] as const)[direction];
    const model = buildModel(module, { ...DEFAULT_PARAMS, height: 80, rows: 3, cols: 3, lidType }, [u, center], {
      [partOverrideKey(u)]: { height: [55, 12, 40, 25][direction] },
      [partOverrideKey(center)]: { height: [12, 40, 20, 55][direction] },
    });
    const plan = createMotionPlan(module, model);
    checkNestedLayers(model, plan, [u, center]);
    checkFullSpread(model, plan);
    const final = finalExplosion(plan), uPart = model.parts[1], centerPart = model.parts[2];
    assert.ok(Math.hypot(...final[2].slice(0, 2)) > 1, 'this regression must exercise nonzero horizontal center movement');
    assert.ok([0, 1].every(axis => {
      const uCenter = uPart.assemblyPosition[axis] + final[1][axis];
      const blockCenter = centerPart.assemblyPosition[axis] + final[2][axis];
      return Math.abs(uCenter - blockCenter) < (uPart.bounds[axis] + centerPart.bounds[axis]) / 2;
    }), 'the center block must still overlap the U footprint after its full motion toward the opening');
    checkPlan(model, plan);
    u = rotateCells(u, 3); center = rotateCells(center, 3);
  }
});

test('wide and interior U pockets also lift centered or co-moving inserts above their arms', () => {
  const smallU = [0, 2, 3, 5, 6, 7, 8];
  const fixtures = [
    { size: 5, u: Array.from({ length: 25 }, (_, cell) => cell).filter(cell => cell % 5 === 0 || cell % 5 === 4 || Math.floor(cell / 5) === 4), center: 12 },
    { size: 5, u: smallU.map(cell => (Math.floor(cell / 3) + 1) * 5 + cell % 3 + 1), center: 12 },
    { size: 6, u: smallU.map(cell => (Math.floor(cell / 3) + 1) * 6 + cell % 3 + 1), center: 14 },
  ];
  for (const { size, u, center } of fixtures) {
    // Put the contained box first: layer order must come from its shape, not IDs.
    const groups = fillWithSingleCells(size, [[center], u]);
    const model = buildModel(module, { ...DEFAULT_PARAMS, rows: size, cols: size, lidType: 'none' }, groups);
    const plan = createMotionPlan(module, model);
    checkNestedLayers(model, plan, [u, [center]]);
    checkFullSpread(model, plan);
    checkPlan(model, plan);
  }
});

test('adjacent L-shaped corners do not create false pocket layers', () => {
  let l = [0, 3, 6, 7, 8];
  for (let direction = 0; direction < 4; direction++) {
    const model = buildModel(module, { ...DEFAULT_PARAMS, rows: 3, cols: 3 }, fillWithSingleCells(3, [l]));
    const plan = createMotionPlan(module, model), final = finalExplosion(plan);
    const heights = model.parts.flatMap((part, index) => part.kind === 'inner' ? [final[index][2]] : []);
    assert.ok(Math.max(...heights) - Math.min(...heights) < EPSILON,
      'two adjacent L walls must not be treated as opposing U walls');
    checkFullSpread(model, plan);
    checkPlan(model, plan);
    l = rotateCells(l, 3);
  }
});

test('nested rings get successive visible layers independent of input group ordering', () => {
  for (const size of [5, 6]) {
    const groups = onionGroups(size);
    const permuted = [groups[2], groups[0], groups[1]];
    const model = buildModel(module, { ...DEFAULT_PARAMS, rows: size, cols: size }, permuted);
    const plan = createMotionPlan(module, model);
    checkNestedLayers(model, plan, groups);
    checkFullSpread(model, plan);
    checkPlan(model, plan);
  }
});

test('layer clearance uses independently edited heights and leaves room for every lid style', () => {
  const groups = onionGroups(5);
  for (const lidType of ['none', 'sleeve', 'inset'] as const) {
    const params: Params = { ...DEFAULT_PARAMS, height: 80, rows: 5, cols: 5, lidType };
    const overrides = Object.fromEntries(groups.map((group, index) => [partOverrideKey(group), { height: [55, 12, 40][index] }]));
    const model = buildModel(module, params, groups, overrides);
    const plan = createMotionPlan(module, model);
    checkNestedLayers(model, plan, groups);
    checkFullSpread(model, plan);
    checkPlan(model, plan);
  }
});

test('L-shaped groups, independently resized parts and extreme heights retain safe paths', () => {
  const groups = [[0, 1, 3], [2], [4], [5]];
  const original = buildModel(module, DEFAULT_PARAMS, groups);
  const merged = original.parts.find(part => part.cellIds?.length === 3)!;
  const customized = buildModel(module, DEFAULT_PARAMS, groups, {
    [partOverrideKey(groups[0])]: { width: merged.bounds[0] * 0.85, depth: merged.bounds[1] * 0.9, height: 14, wall: 1.2, bottom: 1.1 },
    lid: { bottom: 1.8 },
  });
  const tall = buildModel(module, { ...DEFAULT_PARAMS, width: 80, depth: 60, height: 400,
    lidType: 'inset', lidDepth: 20, lidThickness: 20, lidClearance: 2 });
  const short = buildModel(module, { ...DEFAULT_PARAMS, width: 30, depth: 30, height: 8, rows: 1, cols: 1 });
  for (const model of [customized, tall, short]) checkPlan(model, createMotionPlan(module, model));
});

test('rapid mode changes and reversed explosion sliders retrace their branch before switching', () => {
  const params = { ...DEFAULT_PARAMS, rows: 4, cols: 4 };
  const center = [5, 6, 9, 10];
  const groups = [Array.from({ length: 16 }, (_, index) => index).filter(index => !center.includes(index)), ...center.map(cell => [cell])];
  const model = buildModel(module, params, groups);
  const plan = createMotionPlan(module, model);
  const oracle = collisionOracle(model);
  let cursor: MotionCursor = { branch: 'exploded', distance: pathLength(plan.exploded) };
  let switched = 0, backwards = 0;
  const settleFrames = Math.ceil((pathLength(plan.open) + pathLength(plan.exploded)) / (plan.speed * 0.04)) + 5;
  const commands: { mode: ViewMode; explosion: number; frames: number }[] = [
    { mode: 'open', explosion: 100, frames: 2 },
    { mode: 'exploded', explosion: 15, frames: 3 },
    { mode: 'open', explosion: 100, frames: settleFrames },
    { mode: 'exploded', explosion: 100, frames: settleFrames },
    { mode: 'exploded', explosion: 0, frames: settleFrames },
    { mode: 'exploded', explosion: 100, frames: settleFrames },
    { mode: 'assembly', explosion: 100, frames: settleFrames },
  ];
  try {
    for (const command of commands) for (let frame = 0; frame < command.frames; frame++) {
      const before = cursor;
      const beforeCopy = { ...before };
      cursor = advanceMotion(plan, before, command.mode, command.explosion, 0.04);
      assert.deepEqual(before, beforeCopy, 'advancing must not mutate a previously sampled cursor');
      assert.ok(Number.isFinite(cursor.distance) && cursor.distance >= 0 && cursor.distance <= pathLength(plan[cursor.branch]));
      assert.ok(Math.abs(cursor.distance - before.distance) <= plan.speed * 0.04 + 1e-7);
      if (cursor.distance < before.distance) backwards++;
      if (cursor.branch !== before.branch) {
        switched++;
        assert.ok(before.distance <= plan.junction + 1e-8, 'branch switches must use the shared lid-release prefix');
        assert.deepEqual(sampleMotion(plan, before), sampleMotion(plan, { ...before, branch: cursor.branch }));
      }
      const requestedBranch = command.mode === 'assembly' ? before.branch : command.mode;
      if (requestedBranch !== before.branch && before.distance > plan.junction + 1e-8) {
        assert.equal(cursor.branch, before.branch);
        assert.ok(cursor.distance >= plan.junction && cursor.distance < before.distance,
          'the active path must return to the junction before following the other path');
      }
      // Representative transient poses, junction changes and every command end use full 3D CSG.
      if (frame === 0 || frame === command.frames - 1 || cursor.branch !== before.branch)
        assert.equal(oracle.firstOverlap(sampleMotion(plan, cursor)), null);
    }
    assert.ok(switched >= 2 && backwards > 10, 'the sequence must exercise switching and reverse motion');
    assert.equal(cursor.distance, 0);
    assert.deepEqual(sampleMotion(plan, cursor), model.parts.map(() => [0, 0, 0]));
  } finally { oracle.dispose(); }
});

test('layered display motion leaves assembly transforms and canonical STEP/STL geometry unchanged', () => {
  const model = buildModel(module, { ...DEFAULT_PARAMS, rows: 5, cols: 5 }, onionGroups(5));
  const stls = model.parts.map(serializeSTL);
  const step = serializeSTEP(model.parts).split('\nDATA;\n')[1];
  const positions = model.parts.map(part => new Float32Array(part.positions));
  const indices = model.parts.map(part => new Uint32Array(part.indices));
  const transforms = model.parts.map(part => ({ position: [...part.assemblyPosition], rotation: part.assemblyRotation && [...part.assemblyRotation] }));
  const plan = createMotionPlan(module, model);
  for (const branch of ['open', 'exploded'] as const) {
    for (const distance of segmentSamples(plan[branch])) {
      const cursor = { branch, distance };
      const sampled = sampleMotion(plan, cursor);
      const expected = sampled.map(offset => [...offset]);
      sampled[0][0] += 1000;
      assert.deepEqual(sampleMotion(plan, cursor), expected, 'sample arrays must not alias path keyframes');
      advanceMotion(plan, cursor, 'assembly', 0, 0.016);
    }
  }
  model.parts.forEach((part, index) => {
    assert.deepEqual(part.positions, positions[index]);
    assert.deepEqual(part.indices, indices[index]);
    assert.deepEqual({ position: part.assemblyPosition, rotation: part.assemblyRotation }, transforms[index]);
    assert.deepEqual(serializeSTL(part), stls[index]);
  });
  assert.equal(serializeSTEP(model.parts).split('\nDATA;\n')[1], step);
});
