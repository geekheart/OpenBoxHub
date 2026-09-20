import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Module from 'manifold-3d';
import JSZip from 'jszip';
import { createDesignFile, MAX_DESIGN_FILE_BYTES, parseDesignFile } from '../src/design';
import type { DesignConfig } from '../src/design';
import { buildModel } from '../src/geometry';
import { createKitZIP, createManifest } from '../src/export';
import { DEFAULT_PARAMS, defaultGroups, partOverrideKey } from '../src/types';
import type { PartOverrides } from '../src/types';

const module = await Module();
module.setup();

function payload(): Record<string, unknown> {
  return { format: 'openboxhub-design', version: 1, units: 'mm', params: { ...DEFAULT_PARAMS },
    groups: defaultGroups(DEFAULT_PARAMS.rows, DEFAULT_PARAMS.cols), overrides: {}, locked: false };
}

test('parameter downloads round-trip merged groups, lock state and independent dimensions without network', async context => {
  context.mock.method(globalThis, 'fetch', async () => { throw new Error('Design files must not make network requests'); });
  const groups = [[0, 1, 3], [2], [4], [5]];
  const base = buildModel(module, DEFAULT_PARAMS, groups);
  const merged = base.parts.find(part => part.kind === 'inner' && part.cellIds!.length === 3)!;
  const overrides: PartOverrides = { [partOverrideKey(groups[0])]: {
    width: merged.bounds[0] * 0.9, depth: merged.bounds[1] * 0.9, height: 14, wall: 1.2, bottom: 1.3,
  }, lid: { bottom: 1.8 } };
  const config: DesignConfig = { params: { ...DEFAULT_PARAMS }, groups, overrides, locked: true };
  const before = buildModel(module, config.params, config.groups, config.overrides);
  const file = createDesignFile(config);
  assert.equal(file.blob.type, 'application/json');
  assert.equal(file.filename, 'openboxhub_200x140x40.json');
  const text = await file.blob.text();
  assert.equal(JSON.parse(text).format, 'openboxhub-design');
  const restored = parseDesignFile(text);
  assert.deepEqual(restored, config);
  const after = buildModel(module, restored.params, restored.groups, restored.overrides);
  assert.equal(after.parts.length, before.parts.length);
  before.parts.forEach((part, index) => {
    const regenerated = after.parts[index];
    assert.deepEqual(regenerated.dimensions, part.dimensions);
    assert.deepEqual(regenerated.bounds, part.bounds);
    assert.deepEqual(regenerated.positions, part.positions);
    assert.deepEqual(regenerated.indices, part.indices);
    assert.deepEqual(regenerated.assemblyPosition, part.assemblyPosition);
  });
});

test('ZIP includes a reusable design and manifest with independent parameters and dimensions', async () => {
  const overrides: PartOverrides = { 'inner:0': { height: 12, wall: 1.4, bottom: 1.1 } };
  const model = buildModel(module, DEFAULT_PARAMS, defaultGroups(2, 3), overrides);
  const zip = await JSZip.loadAsync(await (await createKitZIP(model)).arrayBuffer());
  const fromDesign = parseDesignFile(await zip.file('design.json')!.async('string'));
  const manifestText = await zip.file('manifest.json')!.async('string');
  const manifest = JSON.parse(manifestText);
  const fromManifest = parseDesignFile(manifestText);
  assert.deepEqual(fromDesign, fromManifest);
  assert.deepEqual(fromManifest.overrides, overrides);
  assert.deepEqual(manifest.parts.map((part: { dimensions: unknown }) => part.dimensions), model.parts.map(part => part.dimensions));
  assert.match(await zip.file('README.txt')!.async('string'), /design.json/);
});

test('previously exported manifests import without overrides and preserve original dimensions', async () => {
  for (const example of ['default_3x2', 'merged_L_inset']) {
    const text = await readFile(new URL(`../examples/${example}/manifest.json`, import.meta.url), 'utf8');
    const original = JSON.parse(text);
    const config = parseDesignFile(text);
    assert.deepEqual(config.params, original.params);
    assert.deepEqual(config.groups, original.groups);
    assert.deepEqual(config.overrides, {});
    assert.equal(config.locked, false);
  }
  const legacy = createManifest(buildModel(module, DEFAULT_PARAMS)) as Record<string, unknown>;
  const params = { ...DEFAULT_PARAMS } as Record<string, unknown>;
  for (const key of ['baseStyle', 'holeSize', 'ribWidth', 'holeMargin', 'slotLength']) delete params[key];
  legacy.params = params;
  assert.deepEqual(parseDesignFile(JSON.stringify(legacy)).params, DEFAULT_PARAMS);
  delete params.width;
  assert.throws(() => parseDesignFile(JSON.stringify(legacy)), /缺少 width/);
});

test('invalid JSON, unsupported schema and non-millimeter units are rejected', () => {
  for (const text of ['', '{', 'null', '[]', '42']) assert.throws(() => parseDesignFile(text));
  for (const patch of [
    { format: 'other-app' }, { version: 2 }, { version: '1' }, { units: 'cm' },
    { locked: 'false' }, { extraSettings: true }, { params: null }, { overrides: [] },
  ]) assert.throws(() => parseDesignFile(JSON.stringify({ ...payload(), ...patch })));
  const missing = payload();
  delete missing.overrides;
  assert.throws(() => parseDesignFile(JSON.stringify(missing)), /独立盒子参数/);
  const bom = parseDesignFile('\uFEFF' + JSON.stringify(payload()));
  assert.deepEqual(bom.params, DEFAULT_PARAMS);
});

test('parameters require all dimensions, finite numeric values and valid options', () => {
  for (const patch of [
    { width: '200' }, { height: null }, { cols: 2.5 }, { width: -1 }, { wall: 200 },
    { lidType: 'hinged' }, { baseStyle: 'unknown' }, { extraDimension: 2 },
  ]) assert.throws(() => parseDesignFile(JSON.stringify({ ...payload(), params: { ...DEFAULT_PARAMS, ...patch } })));
  const parameters = { ...DEFAULT_PARAMS } as Record<string, unknown>;
  delete parameters.holeSize;
  assert.throws(() => parseDesignFile(JSON.stringify({ ...payload(), params: parameters })), /缺少 holeSize/);
  const infinite = JSON.stringify(payload()).replace(`"width":${DEFAULT_PARAMS.width}`, '"width":1e999');
  assert.throws(() => parseDesignFile(infinite), /有限数字/);
});

test('groups must cover every cell exactly once and independent settings must match a real part', () => {
  for (const groups of [null, [], [[0], [1]], [[0, 0], [1], [2], [3], [4], [5]],
    [[0, 4], [1], [2], [3], [5]], [[0, '1'], [2], [3], [4], [5]], [[0, 6], [1], [2], [3], [4], [5]]]) {
    assert.throws(() => parseDesignFile(JSON.stringify({ ...payload(), groups })));
  }
  for (const overrides of [
    { 'inner:0,1': { width: 40 } }, { outer: { width: 100 } }, { 'inner:0': { width: '40' } },
    { 'inner:0': { wall: 0 } }, { 'inner:0': { width: 9999 } }, { 'inner:0': { random: 1 } },
    { 'inner:0': null },
  ]) assert.throws(() => parseDesignFile(JSON.stringify({ ...payload(), overrides })));
  // A hidden lid retains its settings so switching lid styles does not discard them.
  const hiddenLid = parseDesignFile(JSON.stringify({ ...payload(), params: { ...DEFAULT_PARAMS, lidType: 'none' }, overrides: { lid: { bottom: 2 } } }));
  assert.deepEqual(hiddenLid.overrides, { lid: { bottom: 2 } });
  assert.equal(partOverrideKey([3, 0, 1]), 'inner:0,1,3');
});

test('file-size, nesting and prototype-pollution inputs are rejected before settings are applied', () => {
  assert.throws(() => parseDesignFile(' '.repeat(MAX_DESIGN_FILE_BYTES + 1)), /不能超过 1 MB/);
  assert.throws(() => parseDesignFile('中'.repeat(Math.ceil(MAX_DESIGN_FILE_BYTES / 3))), /不能超过 1 MB/);
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const text = JSON.stringify(payload()).replace('"overrides":{}', `"overrides":{"${key}":{"width":20}}`);
    assert.throws(() => parseDesignFile(text), /不允许的字段/);
  }
  const deep = '{"a":'.repeat(26) + '0' + '}'.repeat(26);
  assert.throws(() => parseDesignFile(deep), /层级过多/);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'width'), false);
});
