import type { CrossSection, ManifoldToplevel, Vec2 } from 'manifold-3d'
import type { PartData, Vec3 } from './types'

const DISTANCE_EPSILON = 0.00001
const AREA_EPSILON = 0.00001
type Bounds2 = { min: Vec2; max: Vec2 }
type Layer = { low: number; high: number; section: CrossSection; bounds: Bounds2; contours: Vec2[][] }
type Body = { layers: Layer[]; min: Vec3; max: Vec3 }
interface EmbindVector<T> { size(): number; get(index: number): T; delete(): void }

function readContours(section: CrossSection): Vec2[][] {
  // manifold-3d 3.5.3's public toPolygons wrapper deletes only the outer
  // vector, leaking each Embind inner-vector handle returned by get(). Keep
  // this version-specific bridge local and release both levels explicitly.
  const source = section as CrossSection & {
    _ToPolygons?: () => EmbindVector<EmbindVector<{ x: number; y: number }>>
  }
  if (typeof source._ToPolygons !== 'function') throw new Error('当前几何库不支持安全读取碰撞轮廓。')
  const polygons = source._ToPolygons()
  try {
    const contours: Vec2[][] = []
    for (let i = 0; i < polygons.size(); i++) {
      const polygon = polygons.get(i)
      try {
        const points: Vec2[] = []
        for (let j = 0; j < polygon.size(); j++) {
          const point = polygon.get(j)
          points.push([point.x, point.y])
        }
        contours.push(points)
      } finally { polygon.delete() }
    }
    return contours
  } finally { polygons.delete() }
}
export type CollisionPair = { a: number; b: number }
export type CollisionWorld = {
  /** Offsets from the fixed assembly transforms; tests the entire linear segment. */
  firstCollision(from: Vec3[], to: Vec3[]): CollisionPair | null
  dispose(): void
}

/**
 * The generated boxes have horizontal plates and vertical walls. Their exact
 * Float32 solids can therefore be represented by constant XY sections between
 * successive Z levels, including concave contours and holes. Bounding boxes
 * only reject impossible pairs; overlap is decided by actual solid sections.
 */
export function createCollisionWorld(module: ManifoldToplevel, parts: PartData[]): CollisionWorld {
  const sections: CrossSection[] = []
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const section of sections) section.delete()
  }
  let bodies: Body[]
  let unitSquare: CrossSection
  try {
    bodies = parts.map(part => {
      const rotation = part.assemblyRotation ?? [0, 0, 0]
      if (rotation.some(value => !Number.isFinite(value)) ||
          rotation.slice(0, 2).some(value => Math.abs(Math.sin(value)) > 1e-8))
        throw new Error('碰撞检测仅支持保持竖直截面的固定装配旋转。')
      const { positions, indices } = part
      for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3
        const zSpan = Math.max(positions[a + 2], positions[b + 2], positions[c + 2]) -
          Math.min(positions[a + 2], positions[b + 2], positions[c + 2])
        const projectedArea = Math.abs((positions[b] - positions[a]) * (positions[c + 1] - positions[a + 1]) -
          (positions[b + 1] - positions[a + 1]) * (positions[c] - positions[a]))
        if (zSpan > DISTANCE_EPSILON && projectedArea > AREA_EPSILON)
          throw new Error('碰撞检测需要水平底板与竖直侧壁，当前零件含倾斜表面。')
      }
      let solid = new module.Manifold(new module.Mesh({ numProp: 3, vertProperties: positions, triVerts: indices }))
      try {
        if (rotation.some(value => value !== 0)) {
          const next = solid.rotate(rotation.map(value => value * 180 / Math.PI) as Vec3)
          solid.delete(); solid = next
        }
        const next = solid.translate(part.assemblyPosition)
        solid.delete(); solid = next
        if (solid.status() !== 'NoError' || solid.isEmpty()) throw new Error(`${part.name}无法建立碰撞实体。`)
        const mesh = solid.getMesh()
        const levels: number[] = []
        for (let i = 2; i < mesh.vertProperties.length; i += mesh.numProp) levels.push(mesh.vertProperties[i])
        levels.sort((a, b) => a - b)
        const unique = levels.filter((level, i) => i === 0 || level - levels[i - 1] > DISTANCE_EPSILON)
        const layers: Layer[] = []
        for (let i = 0; i + 1 < unique.length; i++) {
          const low = unique[i], high = unique[i + 1]
          const section = solid.slice((low + high) / 2)
          sections.push(section)
          if (!section.isEmpty()) layers.push({ low, high, section, bounds: section.bounds(), contours: readContours(section) })
        }
        const bounds = solid.boundingBox()
        return { layers, min: bounds.min, max: bounds.max }
      } finally { solid.delete() }
    })
    unitSquare = module.CrossSection.square([1, 1])
    sections.push(unitSquare)
  } catch (error) { dispose(); throw error }

  const overlap = (lowA: number, highA: number, lowB: number, highB: number) =>
    Math.min(highA, highB) - Math.max(lowA, lowB) > DISTANCE_EPSILON
  const xyOverlap = (a: { min: readonly number[]; max: readonly number[] }, b: { min: readonly number[]; max: readonly number[] }, start: Vec3, delta: Vec3) =>
    [0, 1].every(axis => overlap(
      a.min[axis] + start[axis] + Math.min(0, delta[axis]),
      a.max[axis] + start[axis] + Math.max(0, delta[axis]), b.min[axis], b.max[axis]))

  const intersects = (a: Layer, b: Layer, start: Vec3, delta: Vec3): boolean => {
    const resources: CrossSection[] = []
    const keep = (section: CrossSection) => { resources.push(section); return section }
    try {
      let moving = a.section
      if (start[0] !== 0 || start[1] !== 0) moving = keep(moving.translate([start[0], start[1]]))
      if (Math.abs(delta[0]) > DISTANCE_EPSILON || Math.abs(delta[1]) > DISTANCE_EPSILON) {
        const sweep = [moving, keep(moving.translate([delta[0], delta[1]]))]
        // Every boundary edge traces a parallelogram. Unioning those strips with
        // the original filled section is its exact translation sweep, even for
        // inner hole contours; a convex hull would incorrectly fill the holes.
        for (const contour of a.contours) for (let i = 0; i < contour.length; i++) {
          const p = contour[i], q = contour[(i + 1) % contour.length]
          if (Math.abs((q[0] - p[0]) * delta[1] - (q[1] - p[1]) * delta[0]) <= AREA_EPSILON) continue
          // A transformed unit square is this exact parallelogram. It also
          // avoids the same version's polygon-constructor vector leak.
          sweep.push(keep(unitSquare.transform([
            q[0] - p[0], q[1] - p[1], 0,
            delta[0], delta[1], 0,
            p[0] + start[0], p[1] + start[1], 1,
          ])))
        }
        moving = keep(module.CrossSection.union(sweep))
      }
      return keep(moving.intersect(b.section)).area() > AREA_EPSILON
    } finally { for (let i = resources.length - 1; i >= 0; i--) resources[i].delete() }
  }

  return {
    dispose,
    firstCollision(from, to) {
      if (disposed) throw new Error('碰撞检测资源已释放。')
      if (from.length !== parts.length || to.length !== parts.length ||
          [...from, ...to].some(offset => offset.length !== 3 || offset.some(value => !Number.isFinite(value))))
        throw new Error('碰撞检测位移必须与零件数量一致，且为有限三维向量。')
      const deltas = to.map((offset, i) => offset.map((value, axis) => value - from[i][axis]) as Vec3)
      // Reject unsupported diagonal paths before returning a collision result.
      // Simultaneous translations use relative motion, not either body's path.
      for (let a = 0; a < bodies.length; a++) for (let b = a + 1; b < bodies.length; b++) {
        const relative = deltas[a].map((value, axis) => value - deltas[b][axis])
        if (Math.abs(relative[2]) > DISTANCE_EPSILON &&
            (Math.abs(relative[0]) > DISTANCE_EPSILON || Math.abs(relative[1]) > DISTANCE_EPSILON))
          throw new Error('碰撞路径必须分为竖直运动与水平运动，不能同时斜向移动。')
      }
      for (let a = 0; a < bodies.length; a++) for (let b = a + 1; b < bodies.length; b++) {
        const start = from[a].map((value, axis) => value - from[b][axis]) as Vec3
        const delta = deltas[a].map((value, axis) => value - deltas[b][axis]) as Vec3
        const bodyA = bodies[a], bodyB = bodies[b]
        if (!xyOverlap(bodyA, bodyB, start, delta) || !overlap(
          bodyA.min[2] + start[2] + Math.min(0, delta[2]),
          bodyA.max[2] + start[2] + Math.max(0, delta[2]), bodyB.min[2], bodyB.max[2])) continue
        for (const layerA of bodyA.layers) for (const layerB of bodyB.layers) {
          if (!overlap(layerA.low + start[2] + Math.min(0, delta[2]),
            layerA.high + start[2] + Math.max(0, delta[2]), layerB.low, layerB.high)) continue
          if (xyOverlap(layerA.bounds, layerB.bounds, start, delta) && intersects(layerA, layerB, start, delta))
            return { a, b }
        }
      }
      return null
    },
  }
}
