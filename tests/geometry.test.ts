import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'manifold-3d';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { buildModel, isConnectedGroup, validateOverrides, validateParams } from '../src/geometry';
import { createExportFile, createKitZIP, layoutPrintPlate, serializeSTL } from '../src/export';
import { DEFAULT_PARAMS, defaultGroups, partOverrideKey } from '../src/types';
import type { PartData, Params } from '../src/types';
import JSZip from 'jszip';

const module: ManifoldToplevel = await Module();
module.setup();

test('download files are complete without network or server storage', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => { throw new Error('Export must not make a network request'); });
  const model = buildModel(module, DEFAULT_PARAMS);
  const single = await createExportFile(model, 'outer', 'stl');
  assert.equal(single.filename, 'outer_box.stl');
  assert.equal(single.blob.type, 'model/stl');
  assert.deepEqual(await single.blob.arrayBuffer(), serializeSTL(model.parts[0]));
  const plate = await createExportFile(model, 'plate', 'stl');
  assert.deepEqual(await plate.blob.arrayBuffer(), serializeSTL(layoutPrintPlate(model.parts)));
  const kit = await createExportFile(model, 'kit', 'stl');
  assert.ok(kit.filename.endsWith('_mm.zip'));
  const zip = await JSZip.loadAsync(await kit.blob.arrayBuffer());
  assert.equal(Object.keys(zip.files).filter(name => name.endsWith('.stl')).length, model.parts.length);
  assert.deepEqual(await zip.file('outer_box.stl')!.async('arraybuffer'), await single.blob.arrayBuffer());
  await assert.rejects(createExportFile(model, 'missing-part', 'stl'), /重新选择/);
});

function close(actual: number, expected: number, tolerance = 0.0001): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected}`);
}
function checkMesh(part: PartData): void {
  const { positions, indices } = part;
  assert.ok(indices.length > 0 && indices.length % 3 === 0);
  assert.ok(positions.every(Number.isFinite));
  const edges = new Map<string, { count: number; balance: number }>();
  // STL repeats face vertices: topology must be checked after welding actual Float32 coordinates.
  const vertexIds = new Map<string, number>();
  const welded: number[] = [];
  for (let i = 0; i < positions.length; i += 3) {
    const key = `${positions[i]},${positions[i + 1]},${positions[i + 2]}`;
    if (!vertexIds.has(key)) vertexIds.set(key, vertexIds.size);
    welded.push(vertexIds.get(key)!);
  }
  let volume = 0;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3], positions[i]); max[i % 3] = Math.max(max[i % 3], positions[i]);
  }
  close(min[2], 0);
  close(min[0], -max[0]); close(min[1], -max[1]);
  for (let axis = 0; axis < 3; axis++) close(max[axis] - min[axis], part.bounds[axis]);
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]];
    const [wa, wb, wc] = [welded[a], welded[b], welded[c]];
    assert.ok(wa !== wb && wa !== wc && wb !== wc, `collapsed triangle in ${part.id}`);
    for (const [from, to] of [[wa, wb], [wb, wc], [wc, wa]]) {
      const key = `${Math.min(from, to)}:${Math.max(from, to)}`;
      const entry = edges.get(key) ?? { count: 0, balance: 0 };
      entry.count++; entry.balance += from < to ? 1 : -1; edges.set(key, entry);
    }
    const ai = a * 3, bi = b * 3, ci = c * 3;
    const u = [0, 1, 2].map(axis => positions[bi + axis] - positions[ai + axis]);
    const v = [0, 1, 2].map(axis => positions[ci + axis] - positions[ai + axis]);
    const twiceArea = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
    assert.ok(twiceArea > 1e-10, `zero-area face in ${part.id}`);
    volume += (positions[ai] * (positions[bi + 1] * positions[ci + 2] - positions[bi + 2] * positions[ci + 1])
      + positions[ai + 1] * (positions[bi + 2] * positions[ci] - positions[bi] * positions[ci + 2])
      + positions[ai + 2] * (positions[bi] * positions[ci + 1] - positions[bi + 1] * positions[ci])) / 6;
  }
  for (const [edge, entry] of edges) assert.deepEqual(entry, { count: 2, balance: 0 }, `open or misoriented edge ${edge} in ${part.id}`);
  assert.ok(volume > 0);
  close(volume, part.volume, part.volume * 0.00001);
}
function assembled(part: PartData): Manifold {
  let current = new module.Manifold(new module.Mesh({ numProp: 3, vertProperties: part.positions, triVerts: part.indices }));
  if (part.assemblyRotation) {
    const next = current.rotate(part.assemblyRotation.map(r => r * 180 / Math.PI) as [number, number, number]);
    current.delete(); current = next;
  }
  const translated = current.translate(part.assemblyPosition); current.delete(); return translated;
}
function checkAssembly(parts: PartData[]): void {
  const solids = parts.map(assembled);
  try {
    for (let i = 0; i < solids.length; i++) for (let j = i + 1; j < solids.length; j++) {
      const intersection = solids[i].intersect(solids[j]);
      try { assert.ok(Math.abs(intersection.volume()) < 0.0001, `${parts[i].id} overlaps ${parts[j].id}`); }
      finally { intersection.delete(); }
    }
  } finally { solids.forEach(s => s.delete()); }
}

test('default independent boxes are watertight, outward oriented, dimensionally correct and collision free', () => {
  const result = buildModel(module, DEFAULT_PARAMS);
  assert.equal(result.parts.length, 8);
  result.parts.forEach(checkMesh); checkAssembly(result.parts);
  const outer = result.parts[0];
  outer.bounds.forEach((v, i) => close(v, [200, 140, 40][i]));
  close(result.metrics.innerWidth, 196); close(result.metrics.innerDepth, 136);
  close(result.metrics.innerHeight, 34.75);
  const lid = result.parts.find(p => p.kind === 'lid')!;
  close(lid.bounds[0], 204.5); close(lid.bounds[1], 144.5); close(lid.bounds[2], 4.5);
});

test('L-shaped merging removes internal boundaries and preserves a single hollow, collision-free insert', () => {
  const groups = [[0, 1, 3], [2], [4], [5]];
  const result = buildModel(module, { ...DEFAULT_PARAMS, lidType: 'inset' }, groups);
  assert.equal(result.metrics.insertCount, 4);
  result.parts.forEach(checkMesh); checkAssembly(result.parts);
  assert.deepEqual(result.parts[1].cellIds, [0, 1, 3]);
  const separate = buildModel(module, { ...DEFAULT_PARAMS, lidType: 'inset' });
  assert.ok(result.parts[1].volume < [1, 2, 4].reduce((v, i) => v + separate.parts[i].volume, 0));
});

test('all cover choices use exactly the same outer and insert meshes', () => {
  const results = (['none', 'sleeve', 'inset'] as const).map(lidType => buildModel(module, { ...DEFAULT_PARAMS, lidType }));
  for (const result of results) { result.parts.forEach(checkMesh); checkAssembly(result.parts); }
  for (const result of results.slice(1)) for (let i = 0; i < results[0].parts.length; i++) {
    assert.deepEqual(result.parts[i].positions, results[0].parts[i].positions);
    assert.deepEqual(result.parts[i].indices, results[0].parts[i].indices);
  }
});

test('honeycomb makes genuine through-holes, preserves connected solid, and reduces volume', () => {
  const solid = buildModel(module, DEFAULT_PARAMS);
  const honeycomb = buildModel(module, { ...DEFAULT_PARAMS, baseStyle: 'honeycomb' });
  const outer = honeycomb.parts[0]; checkMesh(outer); checkAssembly(honeycomb.parts);
  assert.ok(outer.volume < solid.parts[0].volume - 1000);
  const shape = assembled(outer);
  const components = shape.decompose();
  try { assert.equal(components.length, 1); assert.ok(shape.genus() > 0); }
  finally { components.forEach(c => c.delete()); shape.delete(); }
});

test('one full-size insert and sharp-corner boxes remain valid', () => {
  const params = { ...DEFAULT_PARAMS, rows: 1, cols: 1, radius: 0, lidType: 'inset' as const };
  const result = buildModel(module, params);
  result.parts.forEach(checkMesh); checkAssembly(result.parts);
  close(result.parts[1].bounds[0], params.width - 2 * params.wall - 2 * params.gap);
});

test('ring-shaped connected group can surround a separately removable center insert', () => {
  const params = { ...DEFAULT_PARAMS, rows: 3, cols: 3 };
  const result = buildModel(module, params, [[0, 1, 2, 3, 5, 6, 7, 8], [4]]);
  result.parts.forEach(checkMesh); checkAssembly(result.parts);
});

test('validates ranges and rejects missing, repeated, or diagonally connected grid cells', () => {
  assert.deepEqual(validateParams(DEFAULT_PARAMS), []);
  assert.equal(isConnectedGroup([0, 4], 2, 3), false);
  assert.equal(isConnectedGroup([0, 1, 4], 2, 3), true);
  for (const groups of [[[0, 4], [1], [2], [3], [5]], [[0], [1]], [[0, 1], [1, 2, 3, 4, 5]]]) {
    assert.ok(validateParams(DEFAULT_PARAMS, groups).length > 0);
    assert.throws(() => buildModel(module, DEFAULT_PARAMS, groups));
  }
  for (const patch of [{ width: NaN }, { rows: 2.5 }, { gap: 0 }, { height: 8, lidDepth: 6 }, { radius: Math.min(DEFAULT_PARAMS.width, DEFAULT_PARAMS.depth) / 2 }, { cols: 12, width: 20 }, { lidThickness: 1e20 }])
    assert.ok(validateParams({ ...DEFAULT_PARAMS, ...patch }).length > 0);
});

test('binary STL is mm-scaled, includes all faces, and ignores assembly transforms', () => {
  const model = buildModel(module, DEFAULT_PARAMS);
  for (const part of model.parts) {
    const bytes = serializeSTL(part), view = new DataView(bytes);
    assert.equal(view.getUint32(80, true), part.indices.length / 3);
    assert.equal(bytes.byteLength, 84 + part.indices.length / 3 * 50);
    assert.deepEqual(bytes, serializeSTL({ ...part, assemblyPosition: [900, 900, 900], assemblyRotation: [1, 2, 3] } as PartData));
    for (let t = 0; t < part.indices.length / 3; t++) for (let c = 0; c < 3; c++) {
      close(view.getFloat32(84 + t * 50 + 12 + c * 12 + 8, true), part.positions[part.indices[t * 3 + c] * 3 + 2]);
    }
  }
});

test('flat kit layout keeps every part on the bed, with no 2D overlap', () => {
  const model = buildModel(module, DEFAULT_PARAMS), plate = layoutPrintPlate(model.parts);
  assert.equal(plate.indices.length, model.parts.reduce((n, p) => n + p.indices.length, 0));
  for (let i = 0; i < plate.placements.length; i++) {
    assert.equal(plate.placements[i].offset[2], 0);
    for (let j = i + 1; j < plate.placements.length; j++) {
      const [a, b] = [plate.placements[i].offset, plate.placements[j].offset];
      const [aa, bb] = [model.parts[i].bounds, model.parts[j].bounds];
      assert.ok(Math.abs(a[0] - b[0]) >= (aa[0] + bb[0]) / 2 + 7.999 || Math.abs(a[1] - b[1]) >= (aa[1] + bb[1]) / 2 + 7.999);
    }
  }
});

test('ZIP contains one STL per part and a reproducible millimeter manifest', async () => {
  const model = buildModel(module, DEFAULT_PARAMS);
  const blob = await createKitZIP(model);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  assert.equal(Object.keys(zip.files).filter(n => n.endsWith('.stl')).length, model.parts.length);
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
  assert.equal(manifest.units, 'mm'); assert.deepEqual(manifest.params, model.params);
  assert.deepEqual(manifest.groups, defaultGroups(2, 3));
  assert.ok(zip.file('README.txt'));
});


test('all perforation styles produce full printable holes of configured size', () => {
  for (const baseStyle of ['honeycomb', 'circles', 'grid', 'slots'] as const) {
    const result = buildModel(module, { ...DEFAULT_PARAMS, baseStyle });
    result.parts.forEach(checkMesh);
    assert.ok(result.metrics.holeCount > 0);
    const shape = assembled(result.parts[0]);
    const slice = shape.slice(DEFAULT_PARAMS.bottom / 2);
    try {
      assert.equal(shape.genus(), result.metrics.holeCount);
      const contours = slice.toPolygons();
      assert.equal(contours.length, result.metrics.holeCount + 1);
      const holes: Manifold[] = [];
      const wallsSection = shape.slice(DEFAULT_PARAMS.bottom + 0.5);
      const walls = wallsSection.extrude(1);
      try {
        for (const polygon of contours) {
          const width = Math.max(...polygon.map(p => p[0])) - Math.min(...polygon.map(p => p[0]));
          const depth = Math.max(...polygon.map(p => p[1])) - Math.min(...polygon.map(p => p[1]));
          if (width > DEFAULT_PARAMS.width - 1) continue; // the solid external perimeter
          close(width, baseStyle === 'slots' ? DEFAULT_PARAMS.slotLength : DEFAULT_PARAMS.holeSize);
          close(depth, baseStyle === 'honeycomb' ? DEFAULT_PARAMS.holeSize * 2 / Math.sqrt(3) : DEFAULT_PARAMS.holeSize);
          const crossSection = new module.CrossSection([polygon], 'EvenOdd');
          holes.push(crossSection.extrude(1)); crossSection.delete();
        }
        let nearestRib = Infinity;
        for (let i = 0; i < holes.length; i++) {
          assert.ok(holes[i].minGap(walls, DEFAULT_PARAMS.holeMargin + 1) >= DEFAULT_PARAMS.holeMargin - 0.0001);
          for (let j = i + 1; j < holes.length; j++) nearestRib = Math.min(nearestRib, holes[i].minGap(holes[j], DEFAULT_PARAMS.ribWidth + 1));
        }
        close(nearestRib, DEFAULT_PARAMS.ribWidth);
      } finally { holes.forEach(h => h.delete()); walls.delete(); wallsSection.delete(); }
    } finally { slice.delete(); shape.delete(); }
  }
});

test('zero complete holes is explicit and excessive hole density is rejected', () => {
  const tiny = buildModel(module, { ...DEFAULT_PARAMS, baseStyle: 'grid', holeSize: 100, holeMargin: 45 });
  assert.equal(tiny.metrics.holeCount, 0);
  assert.ok(tiny.warnings.some(w => w.includes('无法放置')));
  assert.throws(() => buildModel(module, { ...DEFAULT_PARAMS, width: 500, depth: 500, baseStyle: 'grid', holeSize: 2, ribWidth: 0.8 }), /过密/);
  assert.ok(validateParams({ ...DEFAULT_PARAMS, baseStyle: 'slots', slotLength: 10, holeSize: 12 }).length > 0);
  assert.deepEqual(validateParams({ ...DEFAULT_PARAMS, baseStyle: 'circles', slotLength: 10, holeSize: 12 }), []);
});

test('Float32-exported meshes have no collapsed faces at thin-wall and large-size limits', () => {
  for (const patch of [
    { width: 500, depth: 500 },
    { radius: 0.001 },
    { radius: 0.0002 },
    { wall: 0.8, bottom: 0.8, innerWall: 0.6, innerBottom: 0.6, lidThickness: 0.8, lidDepth: 1, lidClearance: 0.1 },
    { rows: 7, cols: 11, radius: 15, width: 240, depth: 180 },
  ]) {
    const result = buildModel(module, { ...DEFAULT_PARAMS, ...patch });
    result.parts.forEach(checkMesh);
  }
});

test('one insert can change all five dimensions without changing its siblings or assembly center', () => {
  const original = buildModel(module, DEFAULT_PARAMS);
  const before = original.parts[1];
  const dimensions = { width: before.bounds[0] - 4, depth: before.bounds[1] - 3, height: 15, wall: 1.4, bottom: 1.2 };
  const overrides = { [partOverrideKey([0])]: dimensions };
  const result = buildModel(module, DEFAULT_PARAMS, undefined, overrides);
  const changed = result.parts[1];
  result.parts.forEach(checkMesh); checkAssembly(result.parts);
  for (const key of ['width', 'depth', 'height', 'wall', 'bottom'] as const) close(changed.dimensions[key], dimensions[key]);
  changed.assemblyPosition.forEach((n, axis) => close(n, before.assemblyPosition[axis]));
  for (const part of result.parts.filter(part => part.id !== changed.id)) {
    const previous = original.parts.find(other => part.id === other.id)!;
    assert.deepEqual(part.positions, previous.positions);
    assert.deepEqual(part.indices, previous.indices);
  }
  const solid = assembled(changed);
  const wallSection = solid.slice(DEFAULT_PARAMS.bottom + dimensions.bottom + 0.5);
  const bottomSection = solid.slice(DEFAULT_PARAMS.bottom + dimensions.bottom - 0.1);
  try {
    const widths = wallSection.toPolygons().map(polygon => Math.max(...polygon.map(p => p[0])) - Math.min(...polygon.map(p => p[0]))).sort((a, b) => b - a);
    close((widths[0] - widths[1]) / 2, dimensions.wall);
    assert.equal(bottomSection.numContour(), 1);
    assert.equal(wallSection.numContour(), 2);
  } finally { wallSection.delete(); bottomSection.delete(); solid.delete(); }
  const requestedWidth = dimensions.width;
  overrides[partOverrideKey([0])].width = 5;
  close(result.overrides[partOverrideKey([0])].width!, requestedWidth);
});

test('merged L dimensions describe the bounding rectangle and customizations follow cell membership', () => {
  const groups = [[0, 1, 3], [2], [4], [5]];
  const original = buildModel(module, DEFAULT_PARAMS, groups);
  const key = partOverrideKey([3, 0, 1]);
  assert.equal(key, partOverrideKey([0, 1, 3]));
  const size = { width: original.parts[1].bounds[0] * 0.85, depth: original.parts[1].bounds[1] * 0.9, height: 14, wall: 1.2, bottom: 1.1 };
  const result = buildModel(module, DEFAULT_PARAMS, [[2], [3, 0, 1], [4], [5]], { [key]: size });
  const changed = result.parts.find(part => part.overrideKey === key)!;
  assert.equal(changed.id, 'inner-2'); assert.equal(changed.isRectangular, false);
  close(changed.bounds[0], size.width); close(changed.bounds[1], size.depth); close(changed.bounds[2], size.height);
  result.parts.forEach(checkMesh); checkAssembly(result.parts);
  const shape = assembled(changed), base = shape.slice(DEFAULT_PARAMS.bottom + size.bottom / 2);
  try {
    assert.equal(base.numContour(), 1);
    assert.ok(base.area() < size.width * size.depth * 0.85, 'the missing L corner must remain empty');
  } finally { base.delete(); shape.delete(); }
});

test('lid dimensions and skirt thickness are independent of the outer box and inserts', () => {
  for (const lidType of ['sleeve', 'inset'] as const) {
    const params = { ...DEFAULT_PARAMS, lidType };
    const original = buildModel(module, params);
    const before = original.parts.at(-1)!;
    const size = {
      width: before.bounds[0] + (lidType === 'sleeve' ? 1 : -0.5),
      depth: before.bounds[1] + (lidType === 'sleeve' ? 2 : -0.5),
      height: 4.2, wall: 2.2, bottom: 1.8,
    };
    const result = buildModel(module, params, undefined, { lid: size });
    result.parts.forEach(checkMesh); checkAssembly(result.parts);
    const lid = result.parts.at(-1)!;
    for (const key of ['width', 'depth', 'height', 'wall', 'bottom'] as const) close(lid.dimensions[key], size[key]);
    close(lid.assemblyPosition[2], params.height + size.bottom);
    for (let i = 0; i < original.parts.length - 1; i++) {
      assert.deepEqual(result.parts[i].positions, original.parts[i].positions);
      assert.deepEqual(result.parts[i].indices, original.parts[i].indices);
    }
  }
});

test('independent dimensions reject outer-boundary, neighboring-insert and lid interference', () => {
  const original = buildModel(module, DEFAULT_PARAMS);
  assert.throws(() => buildModel(module, DEFAULT_PARAMS, undefined, { 'inner:0': { width: original.parts[1].bounds[0] + 2 } }), /超出外盒/);
  assert.throws(() => buildModel(module, DEFAULT_PARAMS, undefined, { 'inner:1': { width: original.parts[2].bounds[0] + 2 } }), /相交/);
  assert.throws(() => buildModel(module, DEFAULT_PARAMS, undefined, { 'inner:0': { height: original.metrics.innerHeight + 0.1 } }), /可用高度/);
  assert.throws(() => buildModel(module, DEFAULT_PARAMS, undefined, { lid: { width: DEFAULT_PARAMS.width } }), /无法套入/);
  assert.throws(() => buildModel(module, { ...DEFAULT_PARAMS, lidType: 'inset' }, undefined, { lid: { height: 6 } }), /与内盒.*相交/);
  const ringParams = { ...DEFAULT_PARAMS, rows: 3, cols: 3 };
  const groups = [[0, 1, 2, 3, 5, 6, 7, 8], [4]];
  const ring = buildModel(module, ringParams, groups).parts[1];
  assert.throws(() => buildModel(module, ringParams, groups, { [partOverrideKey(groups[0])]: { width: ring.bounds[0] * 0.8 } }), /相交/);
});

test('runtime override validation rejects unknown parts, unsupported fields and invalid numerical values', () => {
  const groups = defaultGroups(2, 3);
  for (const overrides of [
    { outer: { width: 100 } }, { 'inner:5,4': { height: 10 } }, { lid: { width: Infinity } },
    { 'inner:0': { wall: 0.1 } }, { 'inner:0': { bottom: 11 } }, { lid: { wall: 0.1 } },
    { 'inner:0': { height: NaN } }, { lid: { unknown: 2 } }, { 'inner:0': null },
  ]) {
    assert.ok(validateOverrides(DEFAULT_PARAMS, groups, overrides as never).length > 0);
    assert.throws(() => buildModel(module, DEFAULT_PARAMS, groups, overrides as never));
  }
  const noLid = buildModel(module, { ...DEFAULT_PARAMS, lidType: 'none' }, groups, { lid: { wall: 1.5 } });
  assert.deepEqual(noLid.overrides, { lid: { wall: 1.5 } });
  assert.equal(noLid.parts.some(part => part.kind === 'lid'), false);
});
