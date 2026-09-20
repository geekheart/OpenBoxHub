import type { ManifoldToplevel } from 'manifold-3d'
import type { ModelData, Vec3 } from './types'
import { createCollisionWorld } from './collision'

export type ViewMode = 'assembly' | 'open' | 'exploded'
export type MotionOffsets = Vec3[]
export interface MotionPath {
  points: MotionOffsets[]
  /** Cumulative maximum part travel per segment, in millimeters. */
  distances: number[]
}
export interface MotionPlan {
  open: MotionPath
  exploded: MotionPath
  /** Both branches have exactly the same vertical lid-release prefix. */
  junction: number
  spreadScale: number
  speed: number
}
export interface MotionCursor { branch: 'open' | 'exploded'; distance: number }

const clone = (offsets: MotionOffsets): MotionOffsets => offsets.map(v => [...v] as Vec3)
function path(points: MotionOffsets[]): MotionPath {
  const distances = [0]
  for (let i = 1; i < points.length; i++) {
    const travel = Math.max(0, ...points[i].map((p, j) => Math.hypot(...p.map((v, axis) => v - points[i - 1][j][axis]))))
    distances.push(distances[i - 1] + travel)
  }
  return { points, distances }
}
export const pathLength = (p: MotionPath): number => p.distances[p.distances.length - 1]

/** Certify whole motion segments before exposing them to the renderer. */
export function createMotionPlan(module: ManifoldToplevel, model: ModelData): MotionPlan {
  const { parts, params } = model
  const zero = parts.map((): Vec3 => [0, 0, 0])
  const raisedLid = clone(zero), raisedInserts = clone(zero)
  const inners = parts.filter(p => p.kind === 'inner')
  const clearance = Math.max(18, Math.min(params.width, params.depth) * 0.15)
  const insertLift = Math.max(0, params.height + clearance - params.bottom)
  const insertTop = Math.max(params.height, ...inners.map(p => p.assemblyPosition[2] + p.bounds[2] + insertLift))
  const lidIndex = parts.findIndex(p => p.kind === 'lid')
  if (lidIndex >= 0) {
    const lid = parts[lidIndex]
    const lidBottom = lid.assemblyPosition[2] - lid.bounds[2]
    raisedLid[lidIndex][2] = Math.max(28, params.height * 0.85, insertTop + clearance - lidBottom)
  }
  for (let i = 0; i < parts.length; i++) {
    raisedInserts[i] = [...raisedLid[i]]
    if (parts[i].kind === 'inner') raisedInserts[i][2] = insertLift
  }
  const opened = clone(raisedLid)
  if (lidIndex >= 0) opened[lidIndex][1] = params.depth * 0.68
  const spread = (scale: number) => raisedInserts.map((offset, i): Vec3 => parts[i].kind === 'inner'
    ? [parts[i].assemblyPosition[0] * 1.1 * scale, parts[i].assemblyPosition[1] * 1.1 * scale, offset[2]]
    : [...offset])
  const world = createCollisionWorld(module, parts)
  let spreadScale = 1
  try {
    const required = [[zero, zero], [zero, raisedLid], [raisedLid, raisedInserts], [raisedLid, opened]]
    for (const [from, to] of required) {
      const collision = world.firstCollision(from, to)
      if (collision) throw new Error(`${parts[collision.a].name}与${parts[collision.b].name}的展示路径相交，请调整零件尺寸。`)
    }
    if (world.firstCollision(raisedInserts, spread(1))) {
      let low = 0, high = 1
      for (let i = 0; i < 16; i++) {
        const mid = (low + high) / 2
        if (world.firstCollision(raisedInserts, spread(mid))) high = mid
        else low = mid
      }
      // Retain a small margin before first contact, including numeric tolerance.
      spreadScale = low * 0.98
    }
    const exploded = path([zero, raisedLid, raisedInserts, spread(spreadScale)])
    if (world.firstCollision(raisedInserts, exploded.points[3])) throw new Error('无法生成安全的展开路径，请调整内盒布局。')
    const open = path([zero, raisedLid, opened])
    return { open, exploded, junction: open.distances[1], spreadScale,
      speed: Math.max(150, Math.max(params.width, params.depth, params.height) * 1.8) }
  } finally { world.dispose() }
}

/** Sample one shared path parameter; never interpolate individual mesh targets. */
export function sampleMotion(plan: MotionPlan, cursor: MotionCursor): MotionOffsets {
  const p = plan[cursor.branch]
  const d = Math.max(0, Math.min(pathLength(p), cursor.distance))
  for (let i = 1; i < p.points.length; i++) {
    const length = p.distances[i] - p.distances[i - 1]
    if (length <= 1e-9) continue
    if (d <= p.distances[i]) {
      const linear = (d - p.distances[i - 1]) / length
      const t = linear * linear * (3 - 2 * linear)
      return p.points[i].map((v, j): Vec3 => v.map((value, axis) => p.points[i - 1][j][axis] + (value - p.points[i - 1][j][axis]) * t) as Vec3)
    }
  }
  return clone(p.points[p.points.length - 1])
}

/** A mode switch retraces the certified branch to its shared lid-release node. */
export function advanceMotion(plan: MotionPlan, cursor: MotionCursor, mode: ViewMode, explosion: number, dt: number, instant = false): MotionCursor {
  const branch = mode === 'assembly' ? cursor.branch : mode
  const target = mode === 'assembly' ? 0 : mode === 'open' ? pathLength(plan.open)
    : pathLength(plan.exploded) * Math.max(0, Math.min(1, explosion / 100))
  if (instant) return { branch, distance: target }
  const step = Math.max(0, Math.min(dt, 0.05)) * plan.speed
  if (branch !== cursor.branch && cursor.distance > plan.junction + 1e-8) {
    return { branch: cursor.branch, distance: Math.max(plan.junction, cursor.distance - step) }
  }
  const distance = cursor.distance + Math.sign(target - cursor.distance) * Math.min(step, Math.abs(target - cursor.distance))
  return { branch, distance }
}
