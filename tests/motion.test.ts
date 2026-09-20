import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'manifold-3d';
import type { Manifold } from 'manifold-3d';
import { buildModel } from '../src/geometry';
import { serializeSTL } from '../src/export';
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
    const spreadStart = plan.exploded.points[2];
    model.parts.forEach((part, index) => {
      if (part.kind === 'inner') assert.ok(part.assemblyPosition[2] + spreadStart[index][2] > model.params.height,
        'inserts must clear the outer box before any radial motion');
    });
  } finally { oracle.dispose(); }
}

test('all lid styles have collision-free assembled, open and exploded path endpoints and intermediate poses', () => {
  for (const lidType of ['sleeve', 'inset', 'none'] as const) {
    const model = buildModel(module, { ...DEFAULT_PARAMS, lidType });
    const plan = createMotionPlan(module, model);
    assert.equal(plan.spreadScale, 1, 'ordinary separate inserts should retain the full radial spread');
    checkPlan(model, plan);
  }
});

test('an outer 4×4 ring limits the four central inserts before they pass through its walls', () => {
  const params: Params = { ...DEFAULT_PARAMS, rows: 4, cols: 4 };
  const center = [5, 6, 9, 10];
  const ring = Array.from({ length: 16 }, (_, index) => index).filter(index => !center.includes(index));
  assert.equal(ring.length, 12);
  const model = buildModel(module, params, [ring, ...center.map(cell => [cell])]);
  const plan = createMotionPlan(module, model);
  assert.ok(plan.spreadScale > 0 && plan.spreadScale < 1, 'a surrounding ring requires a reduced radial spread');
  checkPlan(model, plan);
  const oracle = collisionOracle(model);
  try {
    const unsafeFullSpread = [0.25, 0.5, 0.75, 1].some(fraction => {
      const offsets = plan.exploded.points[2].map((offset, index): Vec3 => model.parts[index].kind === 'inner'
        ? [model.parts[index].assemblyPosition[0] * 1.1 * fraction,
          model.parts[index].assemblyPosition[1] * 1.1 * fraction, offset[2]] : [...offset]);
      return oracle.firstOverlap(offsets) !== null;
    });
    assert.ok(unsafeFullSpread, 'the regression must contain a real collision if radial clipping is removed');
  } finally { oracle.dispose(); }
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
  const commands: { mode: ViewMode; explosion: number; frames: number }[] = [
    { mode: 'open', explosion: 100, frames: 2 },
    { mode: 'exploded', explosion: 15, frames: 3 },
    { mode: 'open', explosion: 100, frames: 24 },
    { mode: 'exploded', explosion: 100, frames: 30 },
    { mode: 'exploded', explosion: 0, frames: 30 },
    { mode: 'exploded', explosion: 100, frames: 30 },
    { mode: 'assembly', explosion: 100, frames: 30 },
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

test('display motion leaves assembly transforms and canonical STL geometry unchanged', () => {
  const model = buildModel(module, DEFAULT_PARAMS);
  const stls = model.parts.map(serializeSTL);
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
});
