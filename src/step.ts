import { buildCAD, exportCADSTEP, initCAD } from './cad'
import type { ModelData } from './types'

/** Exact CAD STEP rebuilt from design parameters; display meshes are never converted. */
export async function serializeSTEP(model: ModelData, _filename = 'openboxhub.step'): Promise<string> {
  await initCAD()
  const cad = buildCAD(model)
  try { return await exportCADSTEP(cad.parts).text() }
  finally { cad.dispose() }
}
