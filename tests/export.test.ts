import test from 'node:test'
import assert from 'node:assert/strict'
import Module from 'manifold-3d'
import JSZip from 'jszip'
import { buildModel } from '../src/geometry'
import { createExportFile, layoutPrintPlate, serializeSTL } from '../src/export'
import { initCAD } from '../src/cad'
import type { CadRecipe } from '../src/cad-types'
import { parseDesignFile } from '../src/design'
import { DEFAULT_PARAMS, partOverrideKey } from '../src/types'
import { close, readCAD } from './cad-reader'

const module = await Module()
module.setup()
await initCAD()

test('default download is one STEP with independent, nonoverlapping parts on Z=0', async context => {
  const fetch = context.mock.method(globalThis, 'fetch', async () => { throw new Error('Export must stay offline') })
  // True CAD fillets must survive placement without being re-quantized to preview meshes.
  for (const radius of [DEFAULT_PARAMS.radius, 0.001, 0.0002]) {
    const model = buildModel(module, { ...DEFAULT_PARAMS, radius })
    const sourcePositions = model.parts.map(part => new Float32Array(part.positions))
    const file = await createExportFile(model)
    assert.equal(file.filename, 'openboxhub_all_parts_flat_mm.step')
    assert.equal(file.blob.type, 'model/step')
    const parts = await readCAD(file.blob)
    assert.equal(parts.length, model.parts.length)
    const expected = layoutPrintPlate(model.parts).placements
    const remaining = [...parts]
    model.parts.forEach((part, index) => {
      const match = remaining.findIndex(solid => solid.bounds.every((size, axis) => Math.abs(size - part.bounds[axis]) < 0.001)
        && [0, 1].every(axis => Math.abs((solid.min[axis] + solid.max[axis]) / 2 - expected[index].offset[axis]) < 0.001))
      assert.ok(match >= 0, `STEP must preserve the planned placement of ${part.id}`)
      remaining.splice(match, 1)
      assert.deepEqual(part.positions, sourcePositions[index], 'layout must not mutate printable source meshes')
    })
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      close(part.min[2], 0)
      assert.equal(part.linearTriangles, 0)
      for (let j = i + 1; j < parts.length; j++) {
        const other = parts[j]
        assert.ok(part.max[0] <= other.min[0] || other.max[0] <= part.min[0] ||
          part.max[1] <= other.min[1] || other.max[1] <= part.min[1], `solid ${i} overlaps solid ${j}`)
      }
    }
  }
  assert.equal(fetch.mock.callCount(), 0)
})

test('STEP singles and ZIP filenames agree with the manifest and preserve editable JSON settings', async context => {
  const fetch = context.mock.method(globalThis, 'fetch', async () => { throw new Error('Export must stay offline') })
  const groups = [[0, 1, 3], [2], [4], [5]]
  const overrides = { [partOverrideKey(groups[1])]: { height: 12, wall: 1.2, bottom: 1.2 } }
  const model = buildModel(module, { ...DEFAULT_PARAMS, lidType: 'inset' }, groups, overrides)
  const single = await createExportFile(model, 'inner-1')
  assert.equal(single.filename, 'insert_01.step')
  assert.equal(single.blob.type, 'model/step')
  const singleSolids = await readCAD(single.blob)
  assert.equal(singleSolids.length, 1)
  singleSolids[0].bounds.forEach((size, axis) => close(size, model.parts[1].bounds[axis], 0.001))
  const file = await createExportFile(model, 'kit', 'step')
  assert.match(file.filename, /_step_mm\.zip$/)
  const zip = await JSZip.loadAsync(await file.blob.arrayBuffer())
  const files = Object.keys(zip.files)
  assert.equal(files.filter(name => name.endsWith('.step')).length, model.parts.length)
  assert.equal(files.filter(name => name.endsWith('.stl')).length, 0)
  const manifestText = await zip.file('manifest.json')!.async('text')
  const manifest = JSON.parse(manifestText)
  assert.deepEqual(manifest.parts.map((part: { file: string }) => part.file),
    ['outer_box.step', 'insert_01.step', 'insert_02.step', 'insert_03.step', 'insert_04.step', 'inset_lid.step'])
  for (const part of manifest.parts) {
    const document = await zip.file(part.file)!.async('text')
    const solids = await readCAD(document)
    assert.equal(solids.length, 1)
    assert.equal(solids[0].linearTriangles, 0)
    solids[0].bounds.forEach((size, axis) => close(size, part.bounds[axis], 0.001))
  }
  for (const source of [manifestText, await zip.file('design.json')!.async('text')]) {
    const config = parseDesignFile(source)
    assert.deepEqual(config, { params: model.params, groups, overrides, locked: false })
    const rebuilt = buildModel(module, config.params, config.groups, config.overrides)
    rebuilt.parts.forEach((part, index) => {
      assert.deepEqual(part.positions, model.parts[index].positions)
      assert.deepEqual(part.indices, model.parts[index].indices)
    })
  }
  assert.equal(fetch.mock.callCount(), 0)
})

test('explicit STL retains binary compatibility offline and rejects invalid export selections', async context => {
  const fetch = context.mock.method(globalThis, 'fetch', async () => { throw new Error('Export must stay offline') })
  const model = buildModel(module, DEFAULT_PARAMS)
  const step = await createExportFile(model, 'outer', 'step')
  const stl = await createExportFile(model, 'outer', 'stl')
  assert.equal(step.filename, 'outer_box.step')
  assert.equal(stl.filename, 'outer_box.stl')
  assert.equal(stl.blob.type, 'model/stl')
  assert.deepEqual(await stl.blob.arrayBuffer(), serializeSTL(model.parts[0]))
  const file = await createExportFile(model, 'kit', 'stl')
  const zip = await JSZip.loadAsync(await file.blob.arrayBuffer())
  assert.match(file.filename, /_stl_mm\.zip$/)
  assert.equal(Object.keys(zip.files).filter(name => name.endsWith('.step')).length, 0)
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('text'))
  for (const part of manifest.parts) {
    assert.ok(part.file.endsWith('.stl'))
    const original = model.parts.find(source => source.id === part.id)!
    assert.deepEqual(await zip.file(part.file)!.async('arraybuffer'), serializeSTL(original))
  }
  await assert.rejects(createExportFile(model, 'missing', 'step'), /重新选择/)
  await assert.rejects(createExportFile(model, 'missing', 'stl'), /重新选择/)
  await assert.rejects(createExportFile(model, 'outer', 'obj' as 'step'), /导出格式|STEP|STL/)
  assert.equal(fetch.mock.callCount(), 0)
})

test('FreeCAD downloads package independent construction recipes and correct print placements offline', async context => {
  const fetch = context.mock.method(globalThis, 'fetch', async () => { throw new Error('Export must stay offline') })
  const model = buildModel(module, { ...DEFAULT_PARAMS, lidType: 'inset' }, [[0, 1, 3], [2], [4], [5]])
  const recipe = (macro: string): CadRecipe => {
    const encoded = macro.match(/^_openboxhub_recipe = json\.loads\((.*)\)$/m)
    assert.ok(encoded, 'macro must carry its construction recipe as escaped data')
    return JSON.parse(JSON.parse(encoded[1]))
  }
  const plate = await createExportFile(model, 'plate', 'freecad')
  assert.equal(plate.filename, 'openboxhub_all_parts_flat_mm.FCMacro')
  const flat = recipe(await plate.blob.text())
  assert.deepEqual(flat.parts.map(part => ({ id: part.id, offset: part.offset })), layoutPrintPlate(model.parts).placements)
  flat.parts.forEach((part, index) => {
    assert.deepEqual(part.dimensions, model.parts[index].dimensions)
    assert.equal(part.operations[0].kind, 'add')
    assert.ok(part.operations.length >= 2)
    part.operations.forEach(operation => assert.match(operation.profileBrep, /CASCADE Topology/))
  })
  const single = await createExportFile(model, 'inner-1', 'freecad')
  assert.equal(single.filename, 'insert_01.FCMacro')
  const singleRecipe = recipe(await single.blob.text())
  assert.equal(singleRecipe.parts.length, 1)
  assert.equal(singleRecipe.parts[0].id, 'inner-1')
  assert.deepEqual(singleRecipe.parts[0].offset, [0, 0, 0])
  const kit = await createExportFile(model, 'kit', 'freecad')
  assert.match(kit.filename, /_freecad_mm\.zip$/)
  const zip = await JSZip.loadAsync(await kit.blob.arrayBuffer())
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('text'))
  assert.equal(Object.keys(zip.files).filter(name => name.endsWith('.FCMacro')).length, model.parts.length + 1)
  for (const part of manifest.parts) {
    assert.ok(part.file.endsWith('.FCMacro'))
    const standalone = recipe(await zip.file(part.file)!.async('text'))
    assert.equal(standalone.parts.length, 1)
    assert.equal(standalone.parts[0].id, part.id)
    assert.deepEqual(standalone.parts[0].offset, [0, 0, 0])
  }
  assert.deepEqual(recipe(await zip.file(plate.filename)!.async('text')).parts.map(part => part.offset), flat.parts.map(part => part.offset))
  assert.deepEqual(parseDesignFile(await zip.file('design.json')!.async('text')),
    { params: model.params, groups: model.groups, overrides: model.overrides, locked: false })
  await assert.rejects(createExportFile(model, 'missing', 'freecad'), /重新选择/)
  assert.equal(fetch.mock.callCount(), 0)
})
