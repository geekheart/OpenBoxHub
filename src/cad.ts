import initOpenCascade from 'replicad-opencascadejs'
import { draw, drawRoundedRectangle, drawCircle, drawFaceOutline, Drawing, Blueprint, Blueprints, CompoundBlueprint, Compound, Face, cast, exportSTEP, getOC, setOC, Sketches, measureArea, measureVolume } from 'replicad'
import type { Shape3D, AnyShape, Point2D, Wire } from 'replicad'
import type { ModelData, PartData, Vec3 } from './types'
import { validateParams } from './geometry'
import type { CadOperation, CadPartRecipe, CadRecipe } from './cad-types'

let initialized: Promise<void> | undefined
/** Browser: bundled WASM URL. Node: resolve the installed package without a network request. */
export function initCAD(wasmUrl?: string): Promise<void> {
  return initialized ??= initOpenCascade({ print: () => {}, ...(wasmUrl ? { locateFile: () => wasmUrl } : {}) }).then(setOC).catch(error => {
    initialized = undefined
    throw error
  })
}
export interface CadPart { id: string; shape: Shape3D; recipe: CadPartRecipe }
export interface CadModel { parts: CadPart[]; recipe: CadRecipe; dispose(): void }
const rectangle = (w: number, d: number, r = 0) => drawRoundedRectangle(w, d, Math.max(0, r))
function takeShape(raw: Parameters<typeof cast>[0]): AnyShape {
  try { return cast(raw) } finally { raw.delete() }
}
/** Unlike Replicad's makeCompound, this does not consume its input wrappers. */
function compoundOf(shapes: AnyShape[]): Compound {
  const oc = getOC(), builder = new oc.TopoDS_Builder(), result = new Compound(new oc.TopoDS_Compound())
  try {
    builder.MakeCompound(result.wrapped)
    shapes.forEach(shape => builder.Add(result.wrapped, shape.wrapped))
    return result
  } catch (error) { result.delete(); throw error }
  finally { builder.delete() }
}
/** Fix the support plane to global XY so converted p-curves retain design coordinates. */
function planarFace(wire: Wire): Face {
  const oc = getOC(), plane = new oc.gp_Pln()
  try {
    const builder = new oc.BRepBuilderAPI_MakeFace(plane, wire.wrapped, true)
    try {
      if (!builder.IsDone()) throw new Error('CAD 轮廓无法生成平面。')
      return new Face(builder.Face())
    } finally { builder.delete() }
  } finally { plane.delete() }
}
function wireBlueprint(wire: Wire): Blueprint {
  const face = planarFace(wire)
  try { return drawFaceOutline(face).blueprint }
  finally { face.delete() }
}
function drawingOf(shape: AnyShape): Drawing {
  const faces = shape.faces
  try {
    if (!faces.length) throw new Error('CAD 轮廓为空，请检查间隙与壁厚。')
    const profiles = faces.map(face => {
      const outer = face.clone().outerWire(), wires = face.wires
      try {
        const holes = wires.filter(wire => !wire.isSame(outer))
        return holes.length ? new CompoundBlueprint([wireBlueprint(outer), ...holes.map(wireBlueprint)]) : wireBlueprint(outer)
      } finally { outer.delete(); wires.forEach(wire => wire.delete()) }
    })
    return new Drawing(profiles.length === 1 ? profiles[0] : new Blueprints(profiles))
  } finally { faces.forEach(face => face.delete()) }
}
/** OCCT planar booleans preserve every hole and do not guess curve orientation. */
function planarBoolean(a: Drawing, b: Drawing, operation: 'cut' | 'intersect'): Drawing {
  const first = faceOf(a)
  try {
    const second = faceOf(b), oc = getOC()
    try {
      const builder = operation === 'cut' ? new oc.BRepAlgoAPI_Cut(first.wrapped, second.wrapped)
        : new oc.BRepAlgoAPI_Common(first.wrapped, second.wrapped)
      try {
        if (!builder.IsDone()) throw new Error('CAD 平面布尔运算失败。')
        const result = takeShape(builder.Shape())
        try { return drawingOf(result) } finally { result.delete() }
      } finally { builder.delete() }
    } finally { second.delete() }
  } finally { first.delete() }
}
function inset(shape: Drawing, amount: number): Drawing {
  // Replicad 1.1.0's 2D offsets can reverse clipped arcs and shrink compound holes.
  // Offset the complete native face instead: OCCT uses its oriented outer/inner wires.
  const profile = faceOf(shape), faces = profile.faces, oc = getOC()
  try {
    const profiles = faces.map(face => {
      const offsetter = new oc.BRepOffsetAPI_MakeOffset(face.wrapped, oc.GeomAbs_JoinType.GeomAbs_Arc, false)
      try {
        offsetter.Perform(amount, 0)
        if (!offsetter.IsDone()) throw new Error('CAD 轮廓偏移失败，请检查间隙与壁厚。')
        const result = takeShape(offsetter.Shape()), wires = result.wires
        try {
          if (!wires.length) throw new Error('CAD 轮廓被壁厚或间隙完全占用。')
          const areas = wires.map(wire => {
            const enclosed = planarFace(wire)
            try { return Math.abs(measureArea(enclosed)) } finally { enclosed.delete() }
          })
          const outerIndex = areas.indexOf(Math.max(...areas))
          const boundaries = [wires[outerIndex], ...wires.filter((_, index) => index !== outerIndex)]
          return boundaries.length === 1 ? wireBlueprint(boundaries[0]) : new CompoundBlueprint(boundaries.map(wireBlueprint))
        } finally { wires.forEach(wire => wire.delete()); result.delete() }
      } finally { offsetter.delete() }
    })
    if (!profiles.length) throw new Error('CAD 轮廓偏移后没有有效面。')
    return new Drawing(profiles.length === 1 ? profiles[0] : new Blueprints(profiles))
  } finally { faces.forEach(face => face.delete()); profile.delete() }
}
const polygon = (points: Point2D[]): Drawing => {
  const pen = draw(points[0])
  points.slice(1).forEach(point => pen.lineTo(point))
  return pen.close()
}

/** Exact Euclidean inset of integer-grid cells, built only from rectangles and arcs. */
function gridInset(group: number[], rows: number, cols: number, width: number, depth: number, amount: number): Drawing {
  const cells = new Set(group), cellWidth = width / cols, cellDepth = depth / rows
  const xs = group.map(cell => cell % cols), ys = group.map(cell => Math.floor(cell / cols))
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys)
  const center: Point2D = [-width / 2 + (left + right + 1) * cellWidth / 2, depth / 2 - (top + bottom + 1) * cellDepth / 2]
  // Erode the bounding rectangle and subtract dilated missing cells. Dilation
  // distributes over their union, including holes that touch only at a vertex.
  // This directly constructs valid line/arc boundaries without offsetting the
  // self-touching polygon that an unmodified integer grid can contain.
  let result = rectangle((right - left + 1) * cellWidth - 2 * amount,
    (bottom - top + 1) * cellDepth - 2 * amount).translate(center)
  for (let row = top; row <= bottom; row++) for (let col = left; col <= right; col++) {
    if (cells.has(row * cols + col)) continue
    const missing = rectangle(cellWidth + 2 * amount, cellDepth + 2 * amount, amount)
      .translate(-width / 2 + (col + 0.5) * cellWidth, depth / 2 - (row + 0.5) * cellDepth)
    result = planarBoolean(result, missing, 'cut')
  }
  return result
}
function resize(shape: Drawing, width?: number, depth?: number): Drawing {
  const box = shape.boundingBox, center = box.center
  // Replicad's stretch direction denotes the unchanged axis.
  let result = shape
  if (width !== undefined && Math.abs(width - box.width) > 1e-6) result = result.stretch(width / box.width, [0, 1], center)
  if (depth !== undefined && Math.abs(depth - box.height) > 1e-6) result = result.stretch(depth / box.height, [1, 0], center)
  return result
}
function faceOf(drawing: Drawing): AnyShape {
  const sketch = drawing.sketchOnPlane('XY')
  try { return sketch instanceof Sketches ? sketch.faces() : sketch.face() }
  finally {
    if (sketch instanceof Sketches) sketch.sketches.forEach(item => item.delete())
    else if ('delete' in sketch && typeof sketch.delete === 'function') sketch.delete()
  }
}
function extrudeProfile(profile: AnyShape, z: number, height: number): Shape3D {
  const oc = getOC(), vector = new oc.gp_Vec(0, 0, height)
  try {
    const builder = new oc.BRepPrimAPI_MakePrism(profile.wrapped, vector, false, true)
    try {
      const result = takeShape(builder.Shape())
      let solid: Shape3D
      try { solid = result.asShape3D() } catch (error) { result.delete(); throw error }
      // Replicad transformations consume the receiver; no obsolete wrapper is kept.
      try { return z ? solid.translateZ(z) : solid }
      catch (error) { solid.delete(); throw error }
    } finally { builder.delete() }
  } finally { vector.delete() }
}
function validateSolid(shape: Shape3D, name: string): void {
  const analyzer = new (getOC()).BRepCheck_Analyzer(shape.wrapped, true)
  try { if (!analyzer.IsValid()) throw new Error(`${name}的 CAD 实体无效，请调整尺寸。`) }
  finally { analyzer.delete() }
  const solids = shape.solids
  try {
    if (solids.length !== 1 || measureVolume(shape) <= 0) throw new Error(`${name}必须为单个闭合 CAD 实体。`)
  } finally { solids.forEach(solid => solid.delete()) }
}

/** Rebuild exact line/arc/offset profiles from parameters, never from preview triangles. */
export function buildCAD(model: ModelData): CadModel {
  const p = model.params, errors = validateParams(p, model.groups)
  if (errors.length) throw new Error(errors.join('\n'))
  const parts: CadPart[] = []
  const dispose = () => { parts.splice(0).forEach(part => part.shape.delete()) }
  type Operation = Omit<CadOperation, 'profileBrep'> & { profile: Drawing }
  const addPart = (part: PartData, outside: Drawing, operations: Operation[]) => {
    const center = outside.boundingBox.center
    let shape: Shape3D | undefined
    const recipe: CadPartRecipe = { id: part.id, name: part.name, kind: part.kind,
      dimensions: { ...part.dimensions }, offset: [0, 0, 0], operations: [] }
    try {
      for (const { profile, ...operation } of operations) {
        const normalized = profile.translate(-center[0], -center[1])
        const face = faceOf(normalized)
        let tool: Shape3D
        try {
          recipe.operations.push({ ...operation, profileBrep: face.serialize() })
          tool = extrudeProfile(face, operation.z, operation.height)
        } finally { face.delete() }
        if (!shape) shape = tool
        else {
          try {
            const next = operation.kind === 'add' ? shape.fuse(tool) : shape.cut(tool)
            shape.delete(); shape = next
          } finally { tool.delete() }
        }
      }
      if (!shape) throw new Error(`${part.name}没有建模步骤。`)
      const simplified = shape.simplify(); shape.delete(); shape = simplified
      validateSolid(shape, part.name)
      const box = shape.boundingBox
      try {
        if (Math.abs(box.bounds[0][2]) > 0.0001 || Math.abs(box.bounds[1][2] - part.dimensions.height) > 0.0001)
          throw new Error(`${part.name}的 CAD 高度或打印底面与设计不一致。`)
      } finally { box.delete() }
      parts.push({ id: part.id, shape, recipe }); shape = undefined
    } finally { shape?.delete() }
  }
  const shell = (outside: Drawing, inside: Drawing, height: number, bottom: number): Operation[] => [
    { kind: 'add', label: '外轮廓拉伸', profile: outside, z: 0, height, heightExpression: 'height' },
    { kind: 'cut', label: '内腔切除', profile: inside, z: bottom, height: height - bottom + 1, zExpression: 'bottom', heightExpression: 'height-bottom+1' },
  ]
  try {
    const iw = p.width - 2 * p.wall, depth = p.depth - 2 * p.wall
    const outline = rectangle(p.width, p.depth, p.radius)
    const cavity = rectangle(iw, depth, Math.max(0, p.radius - p.wall))
    addPart(model.parts[0], outline, shell(outline, cavity, p.height, p.bottom))
    if (p.baseStyle !== 'solid') {
      const safeWidth = iw - 2 * p.holeMargin, safeDepth = depth - 2 * p.holeMargin
      const safeRadius = Math.max(0, p.radius - p.wall - p.holeMargin)
      const within = (x: number, y: number, padding = 0): boolean => {
        const w = safeWidth / 2 - padding, h = safeDepth / 2 - padding, r = Math.max(0, safeRadius - padding)
        if (w <= 0 || h <= 0 || Math.abs(x) > w + 1e-7 || Math.abs(y) > h + 1e-7) return false
        return Math.max(Math.abs(x) - w + r, 0) ** 2 + Math.max(Math.abs(y) - h + r, 0) ** 2 <= r * r + 1e-7
      }
      const radius = p.holeSize / 2, halfStraight = p.baseStyle === 'slots' ? (p.slotLength - p.holeSize) / 2 : 0
      let hole: Drawing, vertices: Point2D[] = []
      if (p.baseStyle === 'honeycomb') {
        vertices = Array.from({ length: 6 }, (_, k) => [p.holeSize / Math.sqrt(3) * Math.cos((30 + k * 60) * Math.PI / 180),
          p.holeSize / Math.sqrt(3) * Math.sin((30 + k * 60) * Math.PI / 180)])
        hole = polygon(vertices)
      } else if (p.baseStyle === 'grid') {
        vertices = [[-radius, -radius], [radius, -radius], [radius, radius], [-radius, radius]]
        hole = polygon(vertices)
      } else if (halfStraight > 1e-7) hole = rectangle(p.slotLength, p.holeSize, radius)
      else hole = drawCircle(radius)
      const xPitch = (p.baseStyle === 'slots' ? p.slotLength : p.holeSize) + p.ribWidth
      const yPitch = (p.holeSize + p.ribWidth) * (p.baseStyle === 'honeycomb' ? Math.sqrt(3) / 2 : 1)
      const nx = Math.ceil(iw / xPitch / 2), ny = Math.ceil(depth / yPitch / 2)
      const holes: Drawing[] = []
      for (let row = -ny; row <= ny; row++) for (let col = -nx; col <= nx; col++) {
        const x = (col + (p.baseStyle === 'honeycomb' ? Math.abs(row) % 2 / 2 : 0)) * xPitch, y = row * yPitch
        const fits = vertices.length ? vertices.every(([vx, vy]) => within(x + vx, y + vy))
          : within(x - halfStraight, y, radius) && within(x + halfStraight, y, radius)
        if (fits) holes.push(hole.translate(x, y))
      }
      if (holes.length !== model.metrics.holeCount) throw new Error('CAD 孔阵列与预览不一致，请微调孔尺寸或留边后重试。')
      if (holes.length) {
        const faces: AnyShape[] = [], cutters: Shape3D[] = []
        try {
          holes.forEach(profile => faces.push(faceOf(profile)))
          const outer = parts[0], compound = compoundOf(faces)
          try { outer.recipe.operations.push({ kind: 'cut', label: '底板镂空', profileBrep: compound.serialize(),
            z: -1, height: p.bottom + 2, heightExpression: 'bottom+2' }) }
          finally { compound.delete() }
          faces.forEach(profile => cutters.push(extrudeProfile(profile, -1, p.bottom + 2)))
          const cutter = compoundOf(cutters)
          try {
            const cut = outer.shape.cut(cutter), cleaned = cut.simplify()
            cut.delete(); outer.shape.delete(); outer.shape = cleaned
            validateSolid(outer.shape, outer.recipe.name)
          } finally { cutter.delete() }
        } finally { faces.forEach(face => face.delete()); cutters.forEach(cutter => cutter.delete()) }
      }
    }
    const insertEnvelope = rectangle(iw - 2 * p.gap, depth - 2 * p.gap, Math.max(0, p.radius - p.wall - p.gap))
    for (const part of model.parts.filter(part => part.kind === 'inner')) {
      // Erosion distributes over intersection, so grid and rounded cavity can
      // be inset separately without changing the resulting usable footprint.
      const original = planarBoolean(gridInset(part.cellIds!, p.rows, p.cols, iw, depth, p.gap), insertEnvelope, 'intersect')
      const custom = model.overrides[part.overrideKey!] ?? {}
      const outside = resize(original, custom.width, custom.depth)
      const inside = inset(outside, -part.dimensions.wall)
      addPart(part, outside, shell(outside, inside, part.dimensions.height, part.dimensions.bottom))
    }
    const lid = model.parts.find(part => part.kind === 'lid')
    if (lid) {
      const custom = model.overrides.lid ?? {}, size = lid.dimensions
      const originalFit = p.lidType === 'sleeve'
        ? rectangle(p.width + 2 * p.lidClearance, p.depth + 2 * p.lidClearance, p.radius + p.lidClearance)
        : rectangle(iw - 2 * p.lidClearance, depth - 2 * p.lidClearance, Math.max(0, p.radius - p.wall - p.lidClearance))
      const originalOutside = p.lidType === 'sleeve'
        ? rectangle(p.width + 2 * (p.lidClearance + p.wall), p.depth + 2 * (p.lidClearance + p.wall), p.radius + p.lidClearance + p.wall) : outline
      const outside = resize(originalOutside, custom.width, custom.depth)
      if (p.lidType === 'sleeve') {
        const fit = outside === originalOutside && size.wall === p.wall ? originalFit : inset(outside, -size.wall)
        addPart(lid, outside, shell(outside, fit, size.height, size.bottom))
      } else {
        const fit = outside === outline ? originalFit : inset(outside, -p.wall - p.lidClearance)
        const ring = planarBoolean(fit, inset(fit, -size.wall), 'cut')
        addPart(lid, outside, [
          { kind: 'add', label: '盖板拉伸', profile: outside, z: 0, height: size.bottom, heightExpression: 'bottom' },
          { kind: 'add', label: '定位裙边拉伸', profile: ring, z: size.bottom, height: size.height - size.bottom,
            zExpression: 'bottom', heightExpression: 'height-bottom' },
        ])
      }
    }
    return { parts, recipe: { parts: parts.map(part => part.recipe) }, dispose }
  } catch (error) { dispose(); throw error }
}
export function exportCADSTEP(parts: CadPart[], offsets?: Map<string, Vec3>): Blob {
  if (!parts.length) throw new Error('请至少选择一个零件导出 STEP。')
  const copies: Shape3D[] = []
  try {
    const shapes = parts.map(part => {
      const shape = part.shape.clone().translate(offsets?.get(part.id) ?? [0, 0, 0])
      copies.push(shape)
      return { shape, name: part.id }
    })
    return new Blob([exportSTEP(shapes, { unit: 'MM', modelUnit: 'MM' })], { type: 'model/step' })
  } finally { copies.forEach(shape => shape.delete()) }
}
