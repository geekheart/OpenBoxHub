/** Optional independent-CAD fixtures: node --import tsx scripts/generate-step-fixtures.ts */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Module from 'manifold-3d'
import { buildModel } from '../src/geometry'
import { serializeSTEP } from '../src/step'
import { DEFAULT_PARAMS, partOverrideKey } from '../src/types'
import type { ModelData, PartData } from '../src/types'

const output = resolve(process.argv[2] ?? 'test-results/step-validation')
mkdirSync(output, { recursive: true })
const module = await Module()
module.setup()
const cases: { name: string; step: string; parts: { id: string; bounds: number[]; volume: number }[] }[] = []
function save(name: string, parts: PartData[]) {
  const filename = `${name}.step`
  writeFileSync(resolve(output, filename), serializeSTEP(parts, filename))
  cases.push({ name, step: filename, parts: parts.map(part => ({ id: part.id, bounds: part.bounds, volume: part.volume })) })
}
function kit(name: string, model: ModelData) { save(name, model.parts) }

const standard = buildModel(module, DEFAULT_PARAMS)
kit('default-eight-parts', standard)
kit('merged-L-inset', buildModel(module, { ...DEFAULT_PARAMS, lidType: 'inset' }, [[0, 1, 3], [2], [4], [5]]))
kit('merged-ring', buildModel(module, { ...DEFAULT_PARAMS, rows: 3, cols: 3 }, [[0, 1, 2, 3, 5, 6, 7, 8], [4]]))
const original = standard.parts[1].dimensions
kit('independent-insert', buildModel(module, DEFAULT_PARAMS, standard.groups, {
  [partOverrideKey(standard.groups[0])]: { width: original.width * 0.85, depth: original.depth * 0.85,
    height: original.height * 0.8, wall: 1.2, bottom: 1.2 },
}))
for (const baseStyle of ['honeycomb', 'circles', 'grid', 'slots'] as const) {
  const model = buildModel(module, { ...DEFAULT_PARAMS, baseStyle })
  save(`perforated-${baseStyle}`, model.parts.filter(part => part.kind === 'outer'))
}
writeFileSync(resolve(output, 'expected.json'), JSON.stringify({ units: 'mm', cases }, null, 2) + '\n')
console.log(`Wrote ${cases.length} STEP cases and expected.json to ${output}`)
