import test from 'node:test'
import assert from 'node:assert/strict'
import Module from 'manifold-3d'
import JSZip from 'jszip'
import { buildModel } from '../src/geometry'
import { createExportFile, serializeSTL } from '../src/export'
import { parseDesignFile } from '../src/design'
import { DEFAULT_PARAMS, partOverrideKey } from '../src/types'
import type { Vec3 } from '../src/types'

const module = await Module()
module.setup()

/** Inspect actual exported placements without testing the STEP encoder again. */
function solidBounds(text: string): { id: string; min: Vec3; max: Vec3 }[] {
  const entities = new Map([...text.matchAll(/^#(\d+)=(.+);$/gm)].map(match => [Number(match[1]), match[2]]))
  const references = (body: string) => [...body.matchAll(/#(\d+)/g)].map(match => Number(match[1]))
  return [...entities.values()].filter(body => body.startsWith('FACETED_BREP(')).map(body => {
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity]
    const shell = entities.get(references(body)[0])!
    for (const faceId of references(shell)) {
      const bound = entities.get(references(entities.get(faceId)!)[0])!
      const loop = entities.get(references(bound)[0])!
      for (const pointId of references(loop)) {
        const point = entities.get(pointId)!
        const coordinates = /,\(([^()]+)\)\)$/.exec(point)![1].split(',').map(Number)
        coordinates.forEach((value, axis) => { min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value) })
      }
    }
    return { id: /^FACETED_BREP\('([^']+)'/.exec(body)![1], min, max }
  })
}

test('default download is one STEP with independent, nonoverlapping parts on Z=0', async context => {
  const fetch = context.mock.method(globalThis, 'fetch', async () => { throw new Error('Export must stay offline') })
  // Tiny but valid fillets previously collapsed when plate translation rounded
  // coordinates back into Float32. Read emitted STEP REAL coordinates as doubles.
  for (const radius of [DEFAULT_PARAMS.radius, 0.001, 0.0002]) {
    const model = buildModel(module, { ...DEFAULT_PARAMS, radius })
    const sourcePositions = model.parts.map(part => new Float32Array(part.positions))
    const file = await createExportFile(model)
    assert.equal(file.filename, 'openboxhub_all_parts_flat_mm.step')
    assert.equal(file.blob.type, 'model/step')
    const parts = solidBounds(await file.blob.text())
    assert.deepEqual(parts.map(part => part.id), model.parts.map(part => part.id))
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      assert.equal(part.min[2], 0)
      for (let axis = 0; axis < 3; axis++)
        assert.ok(Math.abs(part.max[axis] - part.min[axis] - model.parts[i].bounds[axis]) < 0.0001)
      for (let j = i + 1; j < parts.length; j++) {
        const other = parts[j]
        assert.ok(part.max[0] <= other.min[0] || other.max[0] <= part.min[0] ||
          part.max[1] <= other.min[1] || other.max[1] <= part.min[1], `${part.id} overlaps ${other.id}`)
      }
      assert.deepEqual(model.parts[i].positions, sourcePositions[i], 'layout must not mutate printable source meshes')
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
  assert.deepEqual(solidBounds(await single.blob.text()).map(part => part.id), ['inner-1'])
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
    assert.deepEqual(solidBounds(document).map(solid => solid.id), [part.id])
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
  await assert.rejects(createExportFile(model, 'outer', 'obj' as 'step'), /STEP 或 STL/)
  assert.equal(fetch.mock.callCount(), 0)
})
