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
  /** Insert elevation levels parallel to model.parts; outer box and lid use -1. */
  layers: number[]
  /** Number of occupied insert levels; ordinary independent grids use one. */
  layerCount: number
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
  const innerIndices = parts.flatMap((part, index) => part.kind === 'inner' ? [index] : [])
  const clearance = Math.max(18, Math.min(params.width, params.depth) * 0.15)
  const insertLift = Math.max(0, params.height + clearance - params.bottom)
  const minimumBottom = Math.min(params.bottom, ...innerIndices.map(index => parts[index].assemblyPosition[2]))
  const maximumTop = Math.max(params.bottom, ...innerIndices.map(index => parts[index].assemblyPosition[2] + parts[index].bounds[2]))
  const layerPitch = maximumTop - minimumBottom + clearance
  const lidIndex = parts.findIndex(p => p.kind === 'lid')
  const lidLift = (insertTop: number): number => lidIndex < 0 ? 0 : Math.max(28, params.height * 0.85,
    insertTop + clearance - (parts[lidIndex].assemblyPosition[2] - parts[lidIndex].bounds[2]))

  // Closed holes and open U/C-shaped pockets need separate levels even when
  // their inserts have no relative radial travel and cannot trigger a collision.
  const higherThan = new Map(innerIndices.map(index => [index, new Set<number>()]))
  const { rows, cols } = params
  const neighbors = (cell: number): number[] => {
    const row = Math.floor(cell / cols), col = cell % cols
    return [row > 0 ? cell - cols : -1, row + 1 < rows ? cell + cols : -1,
      col > 0 ? cell - 1 : -1, col + 1 < cols ? cell + 1 : -1].filter(value => value >= 0)
  }
  for (const container of innerIndices) {
    const occupied = new Set(parts[container].cellIds ?? [])
    if (!occupied.size) continue
    const rowMin = Array<number>(rows).fill(cols), rowMax = Array<number>(rows).fill(-1)
    const colMin = Array<number>(cols).fill(rows), colMax = Array<number>(cols).fill(-1)
    for (const cell of occupied) {
      const row = Math.floor(cell / cols), col = cell % cols
      rowMin[row] = Math.min(rowMin[row], col); rowMax[row] = Math.max(rowMax[row], col)
      colMin[col] = Math.min(colMin[col], row); colMax[col] = Math.max(colMax[col], row)
    }
    const outside = new Set<number>(), queue: number[] = []
    for (let cell = 0; cell < rows * cols; cell++) {
      const row = Math.floor(cell / cols), col = cell % cols
      if ((row === 0 || row === rows - 1 || col === 0 || col === cols - 1) && !occupied.has(cell)) {
        outside.add(cell); queue.push(cell)
      }
    }
    for (let n = 0; n < queue.length; n++) for (const next of neighbors(queue[n])) {
      if (!occupied.has(next) && !outside.has(next)) { outside.add(next); queue.push(next) }
    }
    // Opposite walls distinguish a U-shaped recess from an L-shaped corner.
    // The complete contained group must fit inside this pocket, not merely
    // overlap its bounding rectangle. These cells lie within the container's
    // convex hull, so disjoint connected groups cannot mutually contain one another.
    const inPocket = (cell: number): boolean => {
      if (occupied.has(cell)) return false
      if (!outside.has(cell)) return true
      const row = Math.floor(cell / cols), col = cell % cols
      return (rowMin[row] < col && col < rowMax[row]) || (colMin[col] < row && row < colMax[col])
    }
    for (const contained of innerIndices) {
      if (contained === container) continue
      const cells = parts[contained].cellIds ?? []
      if (cells.length && cells.every(inPocket)) higherThan.get(container)!.add(contained)
    }
  }

  const assignLayers = (): number[] => {
    const levels: number[] = parts.map(part => part.kind === 'inner' ? 0 : -1)
    const indegree = new Map(innerIndices.map(index => [index, 0]))
    for (const children of higherThan.values()) for (const child of children) indegree.set(child, indegree.get(child)! + 1)
    const queue = innerIndices.filter(index => indegree.get(index) === 0)
    for (let n = 0; n < queue.length; n++) for (const child of higherThan.get(queue[n])!) {
      levels[child] = Math.max(levels[child], levels[queue[n]] + 1)
      indegree.set(child, indegree.get(child)! - 1)
      if (indegree.get(child) === 0) queue.push(child)
    }
    if (queue.length !== innerIndices.length) throw new Error('内盒层级形成循环，无法生成安全的展开路径。')
    return levels
  }
  const lifted = (layers: number[], coverLift: number): MotionOffsets => parts.map((part, index): Vec3 =>
    [0, 0, part.kind === 'inner' ? insertLift + layers[index] * layerPitch : part.kind === 'lid' ? coverLift : 0])
  const spread = (from: MotionOffsets): MotionOffsets => from.map((offset, index): Vec3 => parts[index].kind === 'inner'
    ? [parts[index].assemblyPosition[0] * 1.1, parts[index].assemblyPosition[1] * 1.1, offset[2]] : [...offset])
  const world = createCollisionWorld(module, parts)
  try {
    let layers = assignLayers()
    // Temporarily park the cover above every possible layer while finding a
    // conflict-free level assignment. Its final height is recomputed below.
    const planningLidLift = lidLift(maximumTop + insertLift + Math.max(0, innerIndices.length - 1) * layerPitch)
    for (;;) {
      const from = lifted(layers, planningLidLift)
      const collision = world.firstCollision(from, spread(from))
      if (!collision) break
      const { a, b } = collision
      if (parts[a].kind !== 'inner' || parts[b].kind !== 'inner' || layers[a] !== layers[b])
        throw new Error(`${parts[a].name}与${parts[b].name}无法通过分层安全展开，请调整零件尺寸。`)
      const areaA = parts[a].bounds[0] * parts[a].bounds[1], areaB = parts[b].bounds[0] * parts[b].bounds[1]
      const radiusA = Math.hypot(parts[a].assemblyPosition[0], parts[a].assemblyPosition[1])
      const radiusB = Math.hypot(parts[b].assemblyPosition[0], parts[b].assemblyPosition[1])
      // Keep a larger surrounding footprint low; equally sized parts nearer
      // the center take the upper level. Equal-level constraints cannot cycle.
      const raiseA = Math.abs(areaA - areaB) > 1e-6 ? areaA < areaB
        : Math.abs(radiusA - radiusB) > 1e-6 ? radiusA < radiusB : a > b
      higherThan.get(raiseA ? b : a)!.add(raiseA ? a : b)
      layers = assignLayers()
    }
    const layerCount = innerIndices.length ? Math.max(...layers) + 1 : 0
    const insertTop = Math.max(params.height, ...innerIndices.map(index =>
      parts[index].assemblyPosition[2] + parts[index].bounds[2] + insertLift + layers[index] * layerPitch))
    const raisedLid = clone(zero)
    if (lidIndex >= 0) raisedLid[lidIndex][2] = lidLift(insertTop)
    const raisedInserts = lifted(parts.map(part => part.kind === 'inner' ? 0 : -1), lidLift(insertTop))
    const separated = lifted(layers, lidLift(insertTop))
    const opened = clone(raisedLid)
    if (lidIndex >= 0) opened[lidIndex][1] = params.depth * 0.68
    const points = [zero, raisedLid, raisedInserts]
    if (layerCount > 1) points.push(separated)
    points.push(spread(separated))
    const required: [MotionOffsets, MotionOffsets][] = [[zero, zero], [raisedLid, opened]]
    for (let index = 1; index < points.length; index++) required.push([points[index - 1], points[index]])
    for (const [from, to] of required) {
      const collision = world.firstCollision(from, to)
      if (collision) throw new Error(`${parts[collision.a].name}与${parts[collision.b].name}的展示路径相交，请调整零件尺寸。`)
    }
    const open = path([zero, raisedLid, opened])
    return { open, exploded: path(points), junction: open.distances[1], layers, layerCount, spreadScale: 1,
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
