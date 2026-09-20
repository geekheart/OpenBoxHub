import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'manifold-3d';
import { buildModel } from '../src/geometry';
import { serializeSTEP } from '../src/step';
import { DEFAULT_PARAMS } from '../src/types';
import type { PartData } from '../src/types';

const module = await Module();
module.setup();
type Mesh = Pick<PartData, 'id' | 'positions' | 'indices'>;
type Point = [number, number, number];
const removeStrings = (value: string) => value.replace(/'(?:[^']|'')*'/g, "''");
const refs = (value: string) => [...removeStrings(value).matchAll(/#(\d+)/g)].map(match => Number(match[1]));
const dot = (a: Point, b: Point) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);
const subtract = (a: Point, b: Point): Point => a.map((value, axis) => value - b[axis]) as Point;
const cross = (a: Point, b: Point): Point => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Independently traverse emitted STEP topology, including the planar face frames. */
function readFacets(text: string): { entities: Map<number, string>; meshes: Mesh[] } {
  assert.ok(text.startsWith('ISO-10303-21;\nHEADER;\n'));
  assert.ok(text.endsWith('ENDSEC;\nEND-ISO-10303-21;\n'));
  assert.match(text, /FILE_SCHEMA\(\('AUTOMOTIVE_DESIGN'\)\);/);
  const data = text.split('\nDATA;\n')[1].split('\nENDSEC;')[0];
  const entities = new Map<number, string>();
  for (const line of data.split('\n')) {
    const match = /^#(\d+)=(.+);$/.exec(line);
    assert.ok(match, `invalid STEP entity: ${line}`);
    const id = Number(match[1]);
    assert.ok(!entities.has(id), 'STEP entity identifiers must be unique');
    entities.set(id, match[2]);
  }
  for (const body of entities.values()) for (const ref of refs(body)) assert.ok(entities.has(ref), `unresolved entity #${ref}`);
  const get = (id: number, kind: string): string => {
    const body = entities.get(id)!;
    assert.ok(body.startsWith(`${kind}(`), `#${id} must be ${kind}`);
    return body;
  };
  const tuple = (id: number, kind: 'CARTESIAN_POINT' | 'DIRECTION'): Point => {
    const body = get(id, kind), match = /,\(([^()]+)\)\)$/.exec(body);
    assert.ok(match);
    const values = match[1].split(',');
    assert.equal(values.length, 3);
    values.forEach(value => assert.match(value, /^[+-]?\d+\.\d*(?:E[+-]?\d+)?$/, 'coordinates and directions must use STEP REAL syntax'));
    const point = values.map(Number) as Point;
    assert.ok(point.every(Number.isFinite));
    return point;
  };
  const meshes: Mesh[] = [];
  const representations = [...entities.values()].filter(body => body.startsWith('FACETED_BREP_SHAPE_REPRESENTATION('));
  for (const [id, body] of entities) {
    if (!body.startsWith('FACETED_BREP(')) continue;
    assert.equal(representations.filter(rep => refs(rep).includes(id)).length, 1, 'each solid must have an independently referenced shape representation');
    const shell = get(refs(body)[0], 'CLOSED_SHELL');
    const vertices = new Map<number, number>(), coordinates: number[] = [], indices: number[] = [];
    for (const faceId of refs(shell)) {
      const face = get(faceId, 'FACE_SURFACE');
      assert.match(face, /,\.T\.\)$/);
      const [boundId, planeId] = refs(face);
      const bound = get(boundId, 'FACE_OUTER_BOUND');
      assert.match(bound, /,\.T\.\)$/);
      const loop = get(refs(bound)[0], 'POLY_LOOP');
      const triangle = refs(loop);
      assert.equal(triangle.length, 3);
      const points = triangle.map(vertex => tuple(vertex, 'CARTESIAN_POINT'));
      const frame = get(refs(get(planeId, 'PLANE'))[0], 'AXIS2_PLACEMENT_3D');
      const [anchorId, normalId, referenceId] = refs(frame);
      const anchor = tuple(anchorId, 'CARTESIAN_POINT'), normal = tuple(normalId, 'DIRECTION'), reference = tuple(referenceId, 'DIRECTION');
      assert.ok(Math.abs(Math.hypot(...normal) - 1) < 1e-10);
      assert.ok(Math.abs(Math.hypot(...reference) - 1) < 1e-10);
      assert.ok(Math.abs(dot(normal, reference)) < 1e-10);
      points.forEach(point => assert.ok(Math.abs(dot(subtract(point, anchor), normal)) < 1e-8, 'every loop point must lie on its face plane'));
      assert.ok(dot(cross(subtract(points[1], points[0]), subtract(points[2], points[0])), normal) > 0,
        'the face plane and polygon winding must have the same outward sense');
      triangle.forEach((vertex, corner) => {
        if (!vertices.has(vertex)) { vertices.set(vertex, vertices.size); coordinates.push(...points[corner]); }
        indices.push(vertices.get(vertex)!);
      });
    }
    const label = /^FACETED_BREP\('((?:[^']|'')*)',/.exec(body)![1].replace(/''/g, "'");
    meshes.push({ id: label, positions: new Float32Array(coordinates), indices: new Uint32Array(indices) });
  }
  assert.equal(meshes.length, representations.length);
  assert.equal([...entities.values()].filter(body => body.startsWith('PRODUCT(')).length, meshes.length);
  assert.equal([...entities.values()].filter(body => body.startsWith('SHAPE_DEFINITION_REPRESENTATION(')).length, meshes.length);
  return { entities, meshes };
}

function tetrahedron(id = 'tetrahedron'): Mesh {
  return { id, positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 4]),
    indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]) };
}

test('STEP independently represents all parts as correctly oriented planar solids in millimeters', () => {
  const model = buildModel(module, DEFAULT_PARAMS);
  const result = readFacets(serializeSTEP(model.parts));
  assert.equal(result.meshes.length, model.parts.length);
  assert.ok([...result.entities.values()].some(body => body === '(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))'));
  assert.ok(![...result.entities.values()].some(body => /^(OPEN_SHELL|ADVANCED_FACE|B_SPLINE_SURFACE|TESSELLATED_)/.test(body)));
  result.meshes.forEach((mesh, index) => {
    const expected = model.parts[index];
    assert.equal(mesh.id, expected.id);
    const solid = new module.Manifold(new module.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
    try {
      assert.equal(solid.status(), 'NoError');
      assert.ok(Math.abs(solid.volume() - expected.volume) < Math.max(0.0001, expected.volume * 1e-7));
      const bounds = solid.boundingBox();
      expected.bounds.forEach((size, axis) => assert.ok(Math.abs(bounds.max[axis] - bounds.min[axis] - size) < 0.0001));
      assert.equal(bounds.min[2], 0);
    } finally { solid.delete(); }
  });
});

test('merged L and ring outlines and perforation holes survive STEP face topology', () => {
  const models = [
    buildModel(module, DEFAULT_PARAMS, [[0, 1, 3], [2], [4], [5]]),
    buildModel(module, { ...DEFAULT_PARAMS, rows: 3, cols: 3 }, [[0, 1, 2, 3, 5, 6, 7, 8], [4]]),
    buildModel(module, { ...DEFAULT_PARAMS, baseStyle: 'honeycomb' }),
  ];
  for (const model of models) {
    const source = model.parts.filter(part => part.kind === 'inner' && part.cellIds!.length > 1 || part.kind === 'outer' && model.params.baseStyle !== 'solid');
    const restored = readFacets(serializeSTEP(source)).meshes;
    restored.forEach((mesh, index) => {
      const original = new module.Manifold(new module.Mesh({ numProp: 3, vertProperties: source[index].positions, triVerts: source[index].indices }));
      const roundtrip = new module.Manifold(new module.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
      try {
        assert.equal(roundtrip.status(), 'NoError');
        assert.equal(roundtrip.genus(), original.genus());
        assert.ok(Math.abs(roundtrip.volume() - original.volume()) < 0.0001);
      } finally { original.delete(); roundtrip.delete(); }
    });
  }
});

test('STEP uses only supplied print coordinates, preserves plate translations and never mutates the mesh', () => {
  const model = buildModel(module, DEFAULT_PARAMS);
  const part = model.parts.at(-1)!;
  const before = new Float32Array(part.positions), beforeIndices = new Uint32Array(part.indices);
  const first = serializeSTEP([part]).split('\nDATA;\n')[1];
  const movedDisplay = { ...part, assemblyPosition: [1000, -500, 900] as [number, number, number], assemblyRotation: [2, 1, 0] as [number, number, number] };
  assert.equal(serializeSTEP([movedDisplay]).split('\nDATA;\n')[1], first);
  const translated = { ...part, positions: part.positions.map((value, index) => value + [300, 200, 0][index % 3]) };
  const restored = readFacets(serializeSTEP([translated])).meshes[0];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  restored.positions.forEach((value, index) => { min[index % 3] = Math.min(min[index % 3], value); max[index % 3] = Math.max(max[index % 3], value); });
  assert.ok(Math.abs((min[0] + max[0]) / 2 - 300) < 0.0001);
  assert.ok(Math.abs((min[1] + max[1]) / 2 - 200) < 0.0001);
  assert.equal(min[2], 0);
  assert.deepEqual(part.positions, before); assert.deepEqual(part.indices, beforeIndices);
});

test('STEP welds coincident coordinates before checking edge topology', () => {
  const source = tetrahedron();
  const duplicated = { id: source.id, positions: new Float32Array([...source.indices].flatMap(index => [...source.positions.slice(index * 3, index * 3 + 3)])),
    indices: Uint32Array.from({ length: source.indices.length }, (_, index) => index) };
  const result = readFacets(serializeSTEP([duplicated]));
  assert.equal(result.meshes[0].positions.length, 12);
  assert.equal(result.meshes[0].indices.length, source.indices.length);
});

test('STEP rejects damaged, open, reversed, disconnected or non-finite source meshes', () => {
  const source = tetrahedron();
  assert.throws(() => serializeSTEP([]), /至少选择/);
  assert.throws(() => serializeSTEP([source, source]), /标识必须唯一/);
  assert.throws(() => serializeSTEP([{ ...source, id: '' }]), /标识必须唯一/);
  assert.throws(() => serializeSTEP([{ ...source, positions: new Float32Array([0, 0]) }]), /数据不完整/);
  assert.throws(() => serializeSTEP([{ ...source, positions: source.positions.map((value, index) => index === 0 ? Infinity : value) }]), /有限数字/);
  assert.throws(() => serializeSTEP([{ ...source, indices: new Uint32Array([...source.indices, 0]) }]), /数据不完整/);
  assert.throws(() => serializeSTEP([{ ...source, indices: source.indices.map((value, index) => index === 0 ? 99 : value) }]), /索引超出/);
  const invalidIndex = [...source.indices]; invalidIndex[0] = 0.5;
  assert.throws(() => serializeSTEP([{ ...source, indices: invalidIndex as unknown as Uint32Array }]), /索引超出/);
  assert.throws(() => serializeSTEP([{ ...source, indices: new Uint32Array([...source.indices, 0, 1, 2]) }]), /重复三角面/);
  const collapsed = new Float32Array(source.positions); collapsed.set([0, 0, 0], 3);
  assert.throws(() => serializeSTEP([{ ...source, positions: collapsed }]), /退化三角面/);
  const flat = source.positions.map((value, index) => index % 3 === 2 ? 0 : value);
  assert.throws(() => serializeSTEP([{ ...source, positions: flat }]), /退化三角面/);
  const cube = buildModel(module, DEFAULT_PARAMS).parts[0];
  assert.throws(() => serializeSTEP([{ ...cube, indices: cube.indices.slice(3) }]), /闭合且方向一致/);
  const oneReversed = new Uint32Array(source.indices); [oneReversed[0], oneReversed[1]] = [oneReversed[1], oneReversed[0]];
  assert.throws(() => serializeSTEP([{ ...source, indices: oneReversed }]), /闭合且方向一致/);
  const reversed = source.indices.map((_, index) => source.indices[Math.floor(index / 3) * 3 + 2 - index % 3]);
  assert.throws(() => serializeSTEP([{ ...source, indices: reversed }]), /体积必须为正/);
  const disconnected = { ...source,
    positions: new Float32Array([...source.positions, ...source.positions.map((value, index) => value + (index % 3 === 0 ? 10 : 0))]),
    indices: new Uint32Array([...source.indices, ...source.indices.map(index => index + 4)]),
  };
  assert.throws(() => serializeSTEP([disconnected]), /连通的闭合壳体/);
});

test('STEP safely escapes identifiers, Unicode, backslashes and file-name delimiters', () => {
  const source = tetrahedron("box'\\盒📦\n#999=OPEN_SHELL();");
  const output = serializeSTEP([source], "file'\nENDSEC;\\盒.step");
  assert.match(output, /box''\\\\\\X2\\76D2\\X0\\\\X4\\0001F4E6\\X0\\/);
  assert.match(output, /\\X2\\000A\\X0\\/);
  assert.equal(output.split('\nENDSEC;\n').length, 3);
  const result = readFacets(output);
  assert.equal(result.meshes.length, 1);
  assert.ok(![...result.entities.values()].some(body => body.startsWith('OPEN_SHELL(')));
  assert.throws(() => serializeSTEP([source], '\ud800'), /无效的 Unicode/);
});
