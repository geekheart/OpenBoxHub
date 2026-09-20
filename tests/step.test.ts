import test from 'node:test'
import assert from 'node:assert/strict'
import Module from 'manifold-3d'
import { getOC, iterTopo, measureVolume } from 'replicad'
import { buildModel } from '../src/geometry'
import { buildCAD, exportCADSTEP, initCAD } from '../src/cad'
import { serializeSTEP } from '../src/step'
import { DEFAULT_PARAMS, partOverrideKey } from '../src/types'
import type { ModelData, Params, Vec3 } from '../src/types'
import { close, readCAD } from './cad-reader'

const module = await Module()
module.setup()
await initCAD()

const roundedArea = (width: number, depth: number, radius: number) => width * depth - (4 - Math.PI) * radius * radius
const outerVolume = (p: Params) => roundedArea(p.width, p.depth, p.radius) * p.height -
  roundedArea(p.width - 2 * p.wall, p.depth - 2 * p.wall, Math.max(0, p.radius - p.wall)) * (p.height - p.bottom)

async function checkModel(model: ModelData): Promise<void> {
  const stats = await readCAD(await serializeSTEP(model))
  assert.equal(stats.length, model.parts.length)
  const remaining = [...stats]
  for (const part of model.parts) {
    const index = remaining.findIndex(solid => solid.bounds.every((size, axis) => Math.abs(size - part.bounds[axis]) < 0.001)
      && Math.abs(solid.volume - part.volume) < Math.max(0.02, part.volume * 0.005))
    assert.ok(index >= 0, `no analytic CAD solid matches ${part.id}'s dimensions and material volume`)
    const [solid] = remaining.splice(index, 1)
    close(solid.min[2], 0)
    close(solid.min[0] + solid.max[0], 0)
    close(solid.min[1] + solid.max[1], 0)
    assert.equal(solid.linearTriangles, 0, `${part.id} must not contain a triangle mesh disguised as planar CAD faces`)
    assert.ok(solid.faces < part.indices.length / 3, `${part.id} should have CAD faces rather than one face per mesh triangle`)
  }
}

/** Check the actual CAD bodies against an independent Manifold material reference. */
function checkBuiltCAD(model: ModelData, exactBounds = new Map<string, Vec3>()) {
  const cad = buildCAD(model)
  const stats = new Map<string, { bounds: Vec3; volume: number }>()
  try {
    assert.equal(cad.parts.length, model.parts.length)
    for (const expected of model.parts) {
      const part = cad.parts.find(candidate => candidate.id === expected.id)
      assert.ok(part, `missing CAD part ${expected.id}`)
      const check = new (getOC()).BRepCheck_Analyzer(part.shape.wrapped, true)
      const solids = part.shape.solids
      const shells = [...iterTopo(part.shape.wrapped, 'shell')]
      const box = part.shape.boundingBox
      try {
        assert.equal(solids.length, 1, `${expected.id} must be one solid`)
        assert.ok(check.IsValid(), `${expected.id} must be geometrically valid`)
        assert.ok(shells.length > 0 && shells.every(shell => getOC().BRep_Tool.IsClosed(shell)), `${expected.id} must be closed`)
        const [min, max] = box.bounds
        const bounds = max.map((value, axis) => value - min[axis]) as Vec3
        // A valid thin plate is insufficient: all walls must reach the requested height.
        assert.ok(Math.abs(bounds[2] - expected.dimensions.height) <= 0.0001,
          `${expected.id}: expected full height ${expected.dimensions.height}, read ${bounds[2]}`)
        close(min[2], 0)
        close(min[0] + max[0], 0)
        close(min[1] + max[1], 0)
        const reference = exactBounds.get(expected.id) ?? expected.bounds
        const xyTolerance = exactBounds.has(expected.id) ? 0.0001 : 0.001
        close(bounds[0], reference[0], xyTolerance)
        close(bounds[1], reference[1], xyTolerance)
        const volume = measureVolume(part.shape)
        assert.ok(Math.abs(volume - expected.volume) <= Math.max(0.02, expected.volume * 0.005),
          `${expected.id}: CAD material volume ${volume} differs from independent preview ${expected.volume}`)
        stats.set(expected.id, { bounds, volume })
      } finally {
        box.delete(); shells.forEach(shell => shell.delete()); solids.forEach(solid => solid.delete()); check.delete()
      }
    }
    return stats
  } finally { cad.dispose() }
}

/** Exact circle/rectangle intersection for a single corner cell, then its gap inset. */
function cornerCellBounds(p: Params): Vec3 {
  const width = p.width - 2 * p.wall, depth = p.depth - 2 * p.wall
  const left = -width / 2 + p.gap, right = -width / 2 + width / p.cols - p.gap
  const bottom = depth / 2 - depth / p.rows + p.gap, top = depth / 2 - p.gap
  const cx = -p.width / 2 + p.radius, cy = p.depth / 2 - p.radius
  const radius = p.radius - p.wall - p.gap
  // Erosion distributes over the intersection: inset the circle and cell edges.
  const minX = Math.max(left, cx - Math.sqrt(radius ** 2 - Math.max(0, bottom - cy) ** 2))
  const maxY = Math.min(top, cy + Math.sqrt(radius ** 2 - Math.max(0, cx - right) ** 2))
  return [right - minX, maxY - bottom, p.height - p.bottom - p.lidDepth - p.lidClearance]
}

function checkSymmetricParts(stats: ReturnType<typeof checkBuiltCAD>, ids: string[]): void {
  const first = stats.get(ids[0])!
  for (const id of ids.slice(1)) {
    const part = stats.get(id)!
    part.bounds.forEach((size, axis) => close(size, first.bounds[axis], 0.0001))
    close(part.volume, first.volume, 0.001)
  }
}

test('STEP rebuilds smooth analytic solids with cylindrical corners and exact parametric outer volume', async () => {
  const model = buildModel(module, DEFAULT_PARAMS)
  const text = await serializeSTEP(model, 'default.step')
  assert.doesNotMatch(text, /FACETED_BREP|TESSELLATED_FACE_SET/)
  const solids = await readCAD(text)
  assert.equal(solids.length, 8)
  const outer = solids.find(solid => Math.abs(solid.bounds[0] - model.params.width) < 0.0001 &&
    Math.abs(solid.bounds[1] - model.params.depth) < 0.0001 && Math.abs(solid.bounds[2] - model.params.height) < 0.0001)!
  assert.ok(outer)
  assert.ok((outer.surfaces.CYLINDRE ?? 0) >= 8, 'both external and cavity corners must remain analytic cylinders')
  assert.ok(outer.faces <= 24, 'ordinary outer shell must use a small set of full CAD faces')
  close(outer.volume, outerVolume(model.params), 0.0001)
  assert.ok(solids.every(solid => solid.linearTriangles === 0))
})

test('all lid styles and merged L, U and ring contours survive CAD STEP roundtrips', async () => {
  for (const lidType of ['none', 'sleeve', 'inset'] as const) await checkModel(buildModel(module, { ...DEFAULT_PARAMS, lidType }))
  await checkModel(buildModel(module, DEFAULT_PARAMS, [[0, 1, 3], [2], [4], [5]]))
  await checkModel(buildModel(module, { ...DEFAULT_PARAMS, rows: 3, cols: 3 }, [[0, 2, 3, 5, 6, 7, 8], [1], [4]]))
  await checkModel(buildModel(module, { ...DEFAULT_PARAMS, rows: 3, cols: 3 }, [[0, 1, 2, 3, 5, 6, 7, 8], [4]]))
})

test('all perforations are real CAD cutouts with analytic circle and slot walls', async () => {
  for (const baseStyle of ['honeycomb', 'circles', 'grid', 'slots'] as const) {
    const params = { ...DEFAULT_PARAMS, baseStyle }
    const model = buildModel(module, params)
    const cad = buildCAD(model)
    try {
      const outer = cad.parts.find(part => part.id === 'outer')!
      const [solid] = await readCAD(exportCADSTEP([outer]))
      const holeArea = baseStyle === 'circles' ? Math.PI * (params.holeSize / 2) ** 2
        : baseStyle === 'slots' ? Math.PI * (params.holeSize / 2) ** 2 + params.holeSize * (params.slotLength - params.holeSize)
          : baseStyle === 'honeycomb' ? Math.sqrt(3) / 2 * params.holeSize ** 2 : params.holeSize ** 2
      close(solid.volume, outerVolume(params) - model.metrics.holeCount * holeArea * params.bottom, 0.001)
      assert.equal(solid.linearTriangles, 0)
      if (baseStyle === 'circles') assert.ok((solid.surfaces.CYLINDRE ?? 0) >= model.metrics.holeCount)
      if (baseStyle === 'slots') assert.ok((solid.surfaces.CYLINDRE ?? 0) >= model.metrics.holeCount * 2)
    } finally { cad.dispose() }
  }
})

test('independent anisotropic inserts and cover dimensions remain editable analytic CAD', async () => {
  const groups = [[0, 1, 3], [2], [4], [5]]
  const original = buildModel(module, DEFAULT_PARAMS, groups)
  const first = original.parts[1].dimensions
  const custom = buildModel(module, DEFAULT_PARAMS, groups, {
    [partOverrideKey(groups[0])]: { width: first.width * 0.85, depth: first.depth * 0.9, height: 14, wall: 1.2, bottom: 1.1 },
    lid: { bottom: 1.8 },
  })
  await checkModel(custom)
})

test('near-half-depth corner radii preserve complete symmetric insert walls', () => {
  const model = buildModel(module, { ...DEFAULT_PARAMS, radius: 69.9 })
  const corners = ['inner-1', 'inner-3', 'inner-4', 'inner-6']
  const stats = checkBuiltCAD(model, new Map(corners.map(id => [id, cornerCellBounds(model.params)])))
  checkSymmetricParts(stats, corners)
})

test('the 12 by 12 maximum grid retains full-height corner boxes and all 144 insert solids', () => {
  const model = buildModel(module, { ...DEFAULT_PARAMS, width: 250, depth: 250, rows: 12, cols: 12, radius: 30 })
  assert.equal(model.parts.filter(part => part.kind === 'inner').length, 144)
  const corners = ['inner-1', 'inner-12', 'inner-133', 'inner-144']
  const stats = checkBuiltCAD(model, new Map(corners.map(id => [id, cornerCellBounds(model.params)])))
  checkSymmetricParts(stats, corners)
})

test('a merged box with two enclosed holes preserves both surrounding walls and material volume', async () => {
  const groups = [[0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13, 14], [6], [8]]
  const model = buildModel(module, { ...DEFAULT_PARAMS, rows: 3, cols: 5 }, groups)
  await checkModel(model)
})

test('excluded grid cells meeting at a vertex still produce a complete editable merged insert', async () => {
  const params = { ...DEFAULT_PARAMS, width: 90, depth: 70, height: 30, rows: 4, cols: 4,
    radius: 4, gap: 0.3662479864666238, innerWall: 1.3044581152498722, lidType: 'none' as const }
  const groups = [[0, 4, 5, 6, 7, 8, 10, 11, 13, 14], [1], [2], [3], [9], [12], [15]]
  await checkModel(buildModel(module, params, groups))
})

test('STEP is generated from design parameters rather than preview triangles or scene transforms', async () => {
  const model = buildModel(module, DEFAULT_PARAMS)
  const before = await readCAD(await serializeSTEP(model))
  const tampered: ModelData = { ...model, parts: model.parts.map(part => ({ ...part,
    positions: new Float32Array([NaN, Infinity, -999]), indices: new Uint32Array(),
    assemblyPosition: [1000, -500, 900] as Vec3, assemblyRotation: [1, 2, 3] as Vec3,
  })) }
  const after = await readCAD(await serializeSTEP(tampered))
  assert.deepEqual(after, before)
  await assert.rejects(serializeSTEP({ ...model, params: { ...model.params, width: NaN } }), /尺寸|数字|参数/)
})
