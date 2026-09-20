import type { PartDimensions, PartKind, Vec3 } from './types'

export interface CadOperation {
  kind: 'add' | 'cut'
  label: string
  /** Analytic OCCT planar faces at Z=0, not tessellated geometry. */
  profileBrep: string
  z: number
  height: number
  zExpression?: string
  heightExpression?: string
}
export interface CadPartRecipe {
  id: string
  name: string
  kind: PartKind
  dimensions: PartDimensions
  operations: CadOperation[]
  offset: Vec3
}
export interface CadRecipe { parts: CadPartRecipe[] }
