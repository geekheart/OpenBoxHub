import assert from 'node:assert/strict'
import { getOC, importSTEP, iterTopo, measureVolume } from 'replicad'
import type { Vec3 } from '../src/types'

export interface CADSolidStats {
  min: Vec3
  max: Vec3
  bounds: Vec3
  volume: number
  faces: number
  surfaces: Record<string, number>
  linearTriangles: number
}

/** Read the exported document through OCCT, independent of its writer's entity layout. */
export async function readCAD(blob: Blob | string): Promise<CADSolidStats[]> {
  const shape = await importSTEP(typeof blob === 'string' ? new Blob([blob], { type: 'model/step' }) : blob)
  const solids = shape.solids
  const oc = getOC()
  try {
    assert.ok(solids.length > 0, 'STEP must contain CAD solids')
    return solids.map(solid => {
      const check = new oc.BRepCheck_Analyzer(solid.wrapped, true)
      const shells = [...iterTopo(solid.wrapped, 'shell')]
      const bbox = solid.boundingBox
      const faces = solid.faces
      try {
        assert.equal(check.IsValid(), true, 'imported CAD solid must be topologically and geometrically valid')
        assert.ok(shells.length > 0 && shells.every(shell => oc.BRep_Tool.IsClosed(shell)), 'solid shells must be closed')
        const [min, max] = bbox.bounds as [Vec3, Vec3]
        const volume = measureVolume(solid)
        assert.ok(volume > 0, 'CAD solid must have positive material volume')
        const surfaces: Record<string, number> = {}
        let linearTriangles = 0
        for (const face of faces) {
          const type = face.geomType
          surfaces[type] = (surfaces[type] ?? 0) + 1
          const edges = face.edges
          try {
            if (type === 'PLANE' && edges.length === 3 && edges.every(edge => edge.geomType === 'LINE')) linearTriangles++
          } finally { edges.forEach(edge => edge.delete()) }
        }
        return { min, max, bounds: max.map((value, axis) => value - min[axis]) as Vec3,
          volume, faces: faces.length, surfaces, linearTriangles }
      } finally {
        faces.forEach(face => face.delete()); bbox.delete(); shells.forEach(shell => shell.delete()); check.delete()
      }
    })
  } finally { solids.forEach(solid => solid.delete()); shape.delete() }
}

export function close(actual: number, expected: number, tolerance = 0.0001): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected} by more than ${tolerance}`)
}
