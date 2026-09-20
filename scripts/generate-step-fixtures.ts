/** Optional independent CAD fixtures: node --import tsx scripts/generate-step-fixtures.ts */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Module from 'manifold-3d'
import { buildModel } from '../src/geometry'
import { buildCAD, exportCADSTEP, initCAD } from '../src/cad'
import { layoutPrintPlate } from '../src/export'
import { createFreeCADMacro } from '../src/freecad'
import { DEFAULT_PARAMS, partOverrideKey } from '../src/types'
import type { ModelData, Params, PartData, Vec3 } from '../src/types'

const output = resolve(process.argv[2] ?? 'test-results/cad-validation')
mkdirSync(output, { recursive: true })
const module = await Module()
module.setup()
await initCAD()

function expectedPart(model: ModelData, part: PartData, offset: Vec3 = [0, 0, 0], exactBounds?: Vec3) {
  const p = model.params
  // Preview volume is an independent approximate reference for merged profiles;
  // analytic arcs differ slightly from the preview's polygonal approximation.
  let volume = part.volume, volumeRelativeTolerance = 0.005
  if (part.kind === 'outer') {
    const roundedArea = (width: number, depth: number, radius: number) => width * depth - (4 - Math.PI) * radius * radius
    const radius = p.holeSize / 2
    const holeArea = p.baseStyle === 'solid' ? 0 : p.baseStyle === 'circles' ? Math.PI * radius ** 2
      : p.baseStyle === 'slots' ? Math.PI * radius ** 2 + p.holeSize * (p.slotLength - p.holeSize)
        : p.baseStyle === 'honeycomb' ? Math.sqrt(3) / 2 * p.holeSize ** 2 : p.holeSize ** 2
    volume = roundedArea(p.width, p.depth, p.radius) * p.height -
      roundedArea(p.width - 2 * p.wall, p.depth - 2 * p.wall, Math.max(0, p.radius - p.wall)) * (p.height - p.bottom) -
      model.metrics.holeCount * holeArea * p.bottom
    volumeRelativeTolerance = 0.00000001
  }
  return { id: part.id, bounds: exactBounds ?? part.bounds, offset, volume, volumeRelativeTolerance,
    dimensionToleranceMm: 0.0001, heightToleranceMm: 0.0001,
    volumeToleranceMm3: 0.001, maxTriangleFaces: 0,
    ...(part.kind === 'outer' && p.baseStyle === 'solid' ? { maxFaces: 24,
      minCylinderFaces: p.radius > p.wall ? 8 : p.radius > 0 ? 4 : 0 } : {}) }
}
const cases: { name: string; step: string; flat?: boolean; parts: ReturnType<typeof expectedPart>[] }[] = []
function cornerBounds(p: Params): Vec3 {
  const width = p.width - 2 * p.wall, depth = p.depth - 2 * p.wall
  const left = -width / 2 + p.gap, right = -width / 2 + width / p.cols - p.gap
  const bottom = depth / 2 - depth / p.rows + p.gap, top = depth / 2 - p.gap
  const cx = -p.width / 2 + p.radius, cy = p.depth / 2 - p.radius, r = p.radius - p.wall - p.gap
  return [right - Math.max(left, cx - Math.sqrt(r * r - Math.max(0, bottom - cy) ** 2)),
    Math.min(top, cy + Math.sqrt(r * r - Math.max(0, cx - right) ** 2)) - bottom,
    p.height - p.bottom - p.lidDepth - p.lidClearance]
}
async function save(name: string, model: ModelData, options: { partIds?: string[]; flat?: boolean; exactCornerIds?: string[] } = {}) {
  const filename = `${name}.step`
  const selected = model.parts.filter(part => !options.partIds || options.partIds.includes(part.id))
  const offsets = options.flat ? new Map(layoutPrintPlate(selected).placements.map(part => [part.id, part.offset])) : undefined
  const cad = buildCAD(model)
  try {
    const parts = cad.parts.filter(part => selected.some(expected => expected.id === part.id))
    const recipe = { parts: parts.map(part => ({ ...part.recipe, offset: offsets?.get(part.id) ?? [0, 0, 0] as Vec3 })) }
    writeFileSync(resolve(output, filename), await exportCADSTEP(parts, offsets).text())
    writeFileSync(resolve(output, `${name}.recipe.json`), JSON.stringify(recipe, null, 2) + '\n')
    writeFileSync(resolve(output, `${name}.FCMacro`), createFreeCADMacro(recipe))
  } finally { cad.dispose() }
  cases.push({ name, step: filename, ...(options.flat ? { flat: true } : {}),
    parts: selected.map(part => expectedPart(model, part, offsets?.get(part.id),
      options.exactCornerIds?.includes(part.id) ? cornerBounds(model.params) : undefined)) })
}

const standard = buildModel(module, DEFAULT_PARAMS)
await save('default-eight-parts', standard)
await save('default-flat', standard, { flat: true })
await save('merged-L-inset', buildModel(module, { ...DEFAULT_PARAMS, lidType: 'inset' }, [[0, 1, 3], [2], [4], [5]]))
await save('merged-U', buildModel(module, { ...DEFAULT_PARAMS, rows: 3, cols: 3 }, [[0, 2, 3, 5, 6, 7, 8], [1], [4]]))
await save('merged-ring', buildModel(module, { ...DEFAULT_PARAMS, rows: 3, cols: 3 }, [[0, 1, 2, 3, 5, 6, 7, 8], [4]]))
const original = standard.parts[1].dimensions
await save('independent-insert', buildModel(module, DEFAULT_PARAMS, standard.groups, {
  [partOverrideKey(standard.groups[0])]: { width: original.width * 0.85, depth: original.depth * 0.9,
    height: original.height * 0.8, wall: 1.2, bottom: 1.2 },
}))
for (const baseStyle of ['honeycomb', 'circles', 'grid', 'slots'] as const)
  await save(`perforated-${baseStyle}`, buildModel(module, { ...DEFAULT_PARAMS, baseStyle }), { partIds: ['outer'] })
await save('large-radius', buildModel(module, { ...DEFAULT_PARAMS, radius: 69.9 }),
  { exactCornerIds: ['inner-1', 'inner-3', 'inner-4', 'inner-6'] })
await save('dense-grid-corners', buildModel(module, { ...DEFAULT_PARAMS, width: 250, depth: 250, rows: 12, cols: 12, radius: 30 }),
  { partIds: ['inner-1', 'inner-12', 'inner-133', 'inner-144'], exactCornerIds: ['inner-1', 'inner-12', 'inner-133', 'inner-144'] })
await save('two-hole-insert', buildModel(module, { ...DEFAULT_PARAMS, rows: 3, cols: 5 },
  [[0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13, 14], [6], [8]]))
await save('vertex-touching-cells', buildModel(module, {
  ...DEFAULT_PARAMS, width: 90, depth: 70, height: 30, rows: 4, cols: 4,
  radius: 4, gap: 0.3662479864666238, innerWall: 1.3044581152498722, lidType: 'none',
}, [[0, 4, 5, 6, 7, 8, 10, 11, 13, 14], [1], [2], [3], [9], [12], [15]]))
writeFileSync(resolve(output, 'expected.json'), JSON.stringify({ units: 'mm', cases }, null, 2) + '\n')
console.log(`Wrote ${cases.length} analytic STEP cases and expected.json to ${output}`)
