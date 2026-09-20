import type { CrossSection, Manifold, ManifoldToplevel, Vec2 } from 'manifold-3d';
import { defaultGroups, partOverrideKey } from './types';
import type { ModelData, Params, PartData, PartDimensions, PartOverrides, Vec3 } from './types';

type Disposable = { delete(): void };
const ARC_SEGMENTS = 64;
const EPSILON = 0.0001;

export function isConnectedGroup(group: number[], rows: number, cols: number): boolean {
  if (!group.length || new Set(group).size !== group.length) return false;
  const cells = new Set(group);
  if (group.some(i => !Number.isInteger(i) || i < 0 || i >= rows * cols)) return false;
  const visited = new Set<number>([group[0]]);
  const queue = [group[0]];
  for (let n = 0; n < queue.length; n++) {
    const cell = queue[n];
    const r = Math.floor(cell / cols), c = cell % cols;
    const neighbors = [r > 0 ? cell - cols : -1, r + 1 < rows ? cell + cols : -1,
      c > 0 ? cell - 1 : -1, c + 1 < cols ? cell + 1 : -1];
    for (const next of neighbors) if (cells.has(next) && !visited.has(next)) {
      visited.add(next); queue.push(next);
    }
  }
  return visited.size === group.length;
}

/** Returns user-facing errors; parameters are never silently clamped or changed. */
export function validateParams(p: Params, groups?: number[][]): string[] {
  const errors: string[] = [];
  const fields = ['width', 'depth', 'height', 'wall', 'bottom', 'radius', 'rows', 'cols',
    'gap', 'innerWall', 'innerBottom', 'lidThickness', 'lidDepth', 'lidClearance',
    'holeSize', 'ribWidth', 'holeMargin', 'slotLength'] as const;
  if (fields.some(key => !Number.isFinite(p[key]))) return ['所有尺寸必须是有效数字。'];
  if (p.width < 20 || p.width > 500 || p.depth < 20 || p.depth > 500 || p.height < 8 || p.height > 400)
    errors.push('外盒长宽需为 20–500 mm，高度需为 8–400 mm。');
  if (p.wall < 0.8 || p.bottom < 0.8 || p.innerWall < 0.6 || p.innerBottom < 0.6)
    errors.push('外盒壁厚/底厚至少 0.8 mm，内盒壁厚/底厚至少 0.6 mm。');
  if (p.wall > 20 || p.bottom > 20 || p.innerWall > 10 || p.innerBottom > 10 || p.lidThickness > 20)
    errors.push('外盒壁厚、底厚与盖板厚度不超过 20 mm，内盒壁厚与底厚不超过 10 mm。');
  if (p.radius < 0 || p.radius >= Math.min(p.width, p.depth) / 2)
    errors.push('圆角半径需 ≥ 0，且小于外盒短边的一半。');
  if (!Number.isInteger(p.rows) || !Number.isInteger(p.cols) || p.rows < 1 || p.cols < 1 || p.rows > 12 || p.cols > 12)
    errors.push('行数和列数必须是 1–12 的整数。');
  if (p.gap < 0.1 || p.gap > 3) errors.push('内盒单边间隙需为 0.1–3 mm。');
  if (p.lidClearance < 0.1 || p.lidClearance > 2) errors.push('盒盖单边间隙需为 0.1–2 mm。');
  if (p.lidThickness < 0.8 || p.lidThickness > 20 || p.lidDepth < 1 || p.lidDepth > 20)
    errors.push('盒盖顶板需为 0.8–20 mm，装配深度需为 1–20 mm。');
  if (!['none', 'sleeve', 'inset'].includes(p.lidType)) errors.push('不支持的盖型。');
  if (!['solid', 'honeycomb', 'circles', 'grid', 'slots'].includes(p.baseStyle)) errors.push('不支持的底板样式。');
  if (p.holeSize < 2 || p.holeSize > 100) errors.push('孔宽需为 2–100 mm。');
  if (p.ribWidth < 0.8 || p.ribWidth > 20) errors.push('最小筋宽需为 0.8–20 mm。');
  if (p.holeMargin < 0.8 || p.holeMargin > 50) errors.push('内壁留边需为 0.8–50 mm。');
  if (p.slotLength < 2 || p.slotLength > 200 || (p.baseStyle === 'slots' && p.slotLength < p.holeSize))
    errors.push('长圆孔总长需为 2–200 mm；长圆孔模式下，总长不能小于孔宽。');
  const iw = p.width - 2 * p.wall, id = p.depth - 2 * p.wall;
  if (iw / p.cols <= 2 * (p.innerWall + p.gap) + 2 || id / p.rows <= 2 * (p.innerWall + p.gap) + 2)
    errors.push('格子过小，请减少行列数或降低壁厚；每格需留出至少 2 mm 的可用内腔。');
  if (p.height - p.bottom - p.lidDepth - p.lidClearance <= p.innerBottom + 1)
    errors.push('高度不足以容纳内盒底板与盒盖定位部分，请增加盒高或减小装配深度。');
  if (Math.min(iw, id) <= 2 * (p.wall + p.lidClearance) + 2)
    errors.push('外盒内腔不足以容纳内嵌盖定位裙边。');
  if (!errors.length) {
    groups ??= defaultGroups(p.rows, p.cols);
    const allCells = groups.flat();
    if (!groups.length || allCells.length !== p.rows * p.cols || new Set(allCells).size !== p.rows * p.cols ||
        allCells.some(i => !Number.isInteger(i) || i < 0 || i >= p.rows * p.cols))
      errors.push('分组必须完整覆盖所有格子，且格子不能重复。');
    else if (groups.some(group => !isConnectedGroup(group, p.rows, p.cols)))
      errors.push('一个内盒中的格子必须通过共边相连；仅对角接触不能合并。');
  }
  return errors;
}

/** Validate imported customizations before allocating any WASM objects. */
export function validateOverrides(params: Params, groups: number[][], overrides: PartOverrides): string[] {
  const isPlainObject = (value: unknown): value is object => value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  if (!isPlainObject(overrides)) return ['独立零件参数必须是对象。'];
  const allowedKeys = new Set(['lid', ...groups.map(partOverrideKey)]);
  const fields = new Set(['width', 'depth', 'height', 'wall', 'bottom']);
  const errors: string[] = [];
  for (const [key, values] of Object.entries(overrides)) {
    if (!allowedKeys.has(key)) { errors.push(`独立零件参数包含无效零件：${key}。`); continue; }
    if (!isPlainObject(values)) { errors.push(`零件 ${key} 的参数必须是对象。`); continue; }
    for (const [field, value] of Object.entries(values)) {
      if (!fields.has(field)) errors.push(`零件 ${key} 包含不支持的参数：${field}。`);
      else if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`零件 ${key} 的尺寸必须是有效数字。`);
      else if (value <= 0 || value > 550) errors.push(`零件 ${key} 的尺寸需大于 0，且不超过 550 mm。`);
    }
    if (key === 'lid' && values.wall !== undefined && (values.wall < 0.8 || values.wall > 20)) errors.push('盒盖壁厚需为 0.8–20 mm。');
    if (key === 'lid' && values.bottom !== undefined && (values.bottom < 0.8 || values.bottom > 20)) errors.push('盒盖顶板厚度需为 0.8–20 mm。');
    if (key === 'lid') {
      const skirtDepth = (values.height ?? params.lidThickness + params.lidDepth) - (values.bottom ?? params.lidThickness);
      if (skirtDepth < 1 - EPSILON || skirtDepth > 20 + EPSILON || skirtDepth > params.height - params.bottom)
        errors.push('盒盖总高减去顶板厚度后，裙边深度需为 1–20 mm，且不能超过外盒可用高度。');
    }
    if (key !== 'lid') {
      if (values.wall !== undefined && (values.wall < 0.6 || values.wall > 10)) errors.push('独立内盒壁厚需为 0.6–10 mm。');
      if (values.bottom !== undefined && (values.bottom < 0.6 || values.bottom > 10)) errors.push('独立内盒底厚需为 0.6–10 mm。');
      if (values.height !== undefined && values.height > params.height - params.bottom - params.lidDepth - params.lidClearance + EPSILON)
        errors.push('独立内盒高度超过盒盖预留空间下的可用高度。');
    }
  }
  return errors;
}

/** Uses an initialized Manifold module. All WASM handles are disposed before return. */
export function buildModel(module: ManifoldToplevel, params: Params, groups?: number[][], overrides: PartOverrides = {}): ModelData {
  const errors = validateParams(params, groups);
  if (errors.length) throw new Error(errors.join('\n'));
  groups ??= defaultGroups(params.rows, params.cols);
  const overrideErrors = validateOverrides(params, groups, overrides);
  if (overrideErrors.length) throw new Error(overrideErrors.join('\n'));
  const p = { ...params };
  const resources: Disposable[] = [];
  const keep = <T extends Disposable>(value: T): T => { resources.push(value); return value; };
  const C = module.CrossSection;
  const roundedRect = (width: number, depth: number, radius: number): CrossSection => {
    if (radius < EPSILON) return keep(C.square([width, depth], true));
    return keep(keep(C.square([width - 2 * radius, depth - 2 * radius], true))
      .offset(radius, 'Round', 2, ARC_SEGMENTS));
  };
  const offset = (shape: CrossSection, amount: number): CrossSection =>
    keep(shape.offset(amount, 'Round', 2, ARC_SEGMENTS));
  const shell = (outside: CrossSection, inside: CrossSection, height: number, bottom: number): Manifold => {
    const solid = keep(outside.extrude(height));
    const hollow = keep(keep(inside.extrude(height - bottom + 1)).translate([0, 0, bottom]));
    return keep(solid.subtract(hollow));
  };
  const assertSingle = (shape: CrossSection, name: string): void => {
    if (shape.isEmpty() || shape.area() < EPSILON) throw new Error(`${name}被壁厚或圆角完全占用，请调整参数。`);
    const components = shape.decompose();
    components.forEach(keep);
    if (components.length !== 1) throw new Error(`${name}出现断开区域，请降低壁厚、间隙或圆角半径。`);
  };
  const resize = (shape: CrossSection, width: number, depth: number): CrossSection => {
    const bounds = shape.bounds();
    const w = bounds.max[0] - bounds.min[0], d = bounds.max[1] - bounds.min[1];
    if (Math.abs(width - w) < 1e-8 && Math.abs(depth - d) < 1e-8) return shape;
    const center: Vec2 = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2];
    const centered = keep(shape.translate([-center[0], -center[1]]));
    const scaled = keep(centered.scale([width / w, depth / d]));
    return keep(scaled.translate(center));
  };
  const dimensions = (shape: CrossSection, height: number, wall: number, bottom: number): PartDimensions => {
    const bounds = shape.bounds();
    return { width: bounds.max[0] - bounds.min[0], depth: bounds.max[1] - bounds.min[1], height, wall, bottom };
  };
  const assertContained = (inside: CrossSection, outside: CrossSection, message: string): void => {
    if (keep(inside.subtract(outside)).area() > EPSILON) throw new Error(message);
  };
  const toPart = (solid: Manifold, data: Pick<PartData, 'id' | 'name' | 'kind' | 'dimensions' | 'isRectangular'> & Partial<Pick<PartData, 'cellIds' | 'assemblyPosition' | 'assemblyRotation' | 'overrideKey'>>): PartData => {
    if (solid.status() !== 'NoError' || solid.isEmpty()) throw new Error(`${data.name}生成失败：${solid.status()}`);
    const box = solid.boundingBox();
    const cx = (box.min[0] + box.max[0]) / 2, cy = (box.min[1] + box.max[1]) / 2;
    const mesh = solid.getMesh();
    const positions = new Float32Array(mesh.numVert * 3);
    for (let i = 0; i < mesh.numVert; i++) {
      positions[3 * i] = mesh.vertProperties[mesh.numProp * i] - cx;
      positions[3 * i + 1] = mesh.vertProperties[mesh.numProp * i + 1] - cy;
      positions[3 * i + 2] = mesh.vertProperties[mesh.numProp * i + 2] - box.min[2];
    }
    // STL and Three.js consume Float32 coordinates. Rebuild at that exact precision so
    // tiny offset-generated edges that collapse during quantization cannot leave
    // duplicate-vertex or collinear faces in the exported watertight surface.
    const quantized = keep(new module.Manifold(new module.Mesh({
      numProp: 3, vertProperties: positions, triVerts: mesh.triVerts,
    })));
    const cleaned = keep(quantized.simplify(0.000001));
    if (cleaned.status() !== 'NoError' || cleaned.isEmpty()) throw new Error(`${data.name}网格精度校验失败。`);
    const cleanMesh = cleaned.getMesh();
    return { ...data, positions: new Float32Array(cleanMesh.vertProperties), indices: new Uint32Array(cleanMesh.triVerts),
      assemblyPosition: data.assemblyPosition ?? [cx, cy, box.min[2]],
      dimensions: { ...data.dimensions, width: box.max[0] - box.min[0], depth: box.max[1] - box.min[1], height: box.max[2] - box.min[2] },
      bounds: box.max.map((n, i) => n - box.min[i]) as Vec3, volume: cleaned.volume() };
  };

  try {
    const iw = p.width - 2 * p.wall, id = p.depth - 2 * p.wall;
    const cw = iw / p.cols, cd = id / p.rows;
    // Reserve space for the inset locating skirt in every lid mode so lids remain interchangeable.
    const ih = p.height - p.bottom - p.lidDepth - p.lidClearance;
    const outline = roundedRect(p.width, p.depth, p.radius);
    const cavity = offset(outline, -p.wall);
    assertSingle(cavity, '外盒内腔');
    let outer = shell(outline, cavity, p.height, p.bottom);
    const warnings: string[] = [];
    let holeCount = 0;
    if (p.baseStyle !== 'solid') {
      const safe = offset(cavity, -p.holeMargin);
      const holeSections: CrossSection[] = [];
      let hole: CrossSection;
      const holeWidth = p.baseStyle === 'slots' ? p.slotLength : p.holeSize;
      const xPitch = holeWidth + p.ribWidth;
      const yPitch = p.baseStyle === 'honeycomb'
        ? (p.holeSize + p.ribWidth) * Math.sqrt(3) / 2 : p.holeSize + p.ribWidth;
      const xCount = Math.ceil(iw / xPitch / 2), yCount = Math.ceil(id / yPitch / 2);
      const candidateCount = (2 * xCount + 1) * (2 * yCount + 1);
      if (candidateCount > 2500)
        throw new Error(`镂空孔阵列过密（需检查 ${candidateCount} 个孔位，上限 2500）；请增大孔宽或筋宽，或缩小外盒。`);
      if (p.baseStyle === 'honeycomb') {
        const radius = p.holeSize / Math.sqrt(3);
        const polygon: Vec2[] = Array.from({ length: 6 }, (_, k) => [
          radius * Math.cos((30 + k * 60) * Math.PI / 180), radius * Math.sin((30 + k * 60) * Math.PI / 180),
        ]);
        hole = keep(new C([polygon]));
      } else if (p.baseStyle === 'circles') {
        hole = keep(C.circle(p.holeSize / 2, ARC_SEGMENTS));
      } else if (p.baseStyle === 'grid') {
        hole = keep(C.square([p.holeSize, p.holeSize], true));
      } else {
        const circle = keep(C.circle(p.holeSize / 2, ARC_SEGMENTS));
        const halfStraight = (p.slotLength - p.holeSize) / 2;
        hole = halfStraight < EPSILON ? circle : keep(C.hull([
          keep(circle.translate([-halfStraight, 0])), keep(circle.translate([halfStraight, 0])),
        ]));
      }
      const holeArea = hole.area();
      for (let row = -yCount; row <= yCount; row++) {
        for (let col = -xCount; col <= xCount; col++) {
          const stagger = p.baseStyle === 'honeycomb' ? (Math.abs(row) % 2) / 2 : 0;
          const translated = keep(hole.translate([(col + stagger) * xPitch, row * yPitch]));
          const clipped = keep(translated.intersect(safe));
          // Only full holes: no partial cutouts or fragile slivers at the solid perimeter.
          if (Math.abs(clipped.area() - holeArea) < EPSILON) holeSections.push(translated);
        }
      }
      holeCount = holeSections.length;
      if (holeSections.length) {
        const holes = keep(C.union(holeSections));
        const cutters = keep(keep(holes.extrude(p.bottom + 2)).translate([0, 0, -1]));
        outer = keep(outer.subtract(cutters));
      } else warnings.push('当前孔尺寸与留边无法放置完整孔洞，已保留实体底板。');
      warnings.push('镂空底板含贯通孔，不适合散装细小物品。');
    }
    const parts: PartData[] = [toPart(outer, { id: 'outer', name: '外盒', kind: 'outer', assemblyPosition: [0, 0, 0],
      dimensions: { width: p.width, depth: p.depth, height: p.height, wall: p.wall, bottom: p.bottom }, isRectangular: true })];
    const insertSections: CrossSection[] = [];
    const insertSolids: Manifold[] = [];
    const insertEnvelope = offset(cavity, -p.gap);
    groups.forEach((group, i) => {
      const tiles = group.map(cell => {
        const row = Math.floor(cell / p.cols), col = cell % p.cols;
        return keep(keep(C.square([cw, cd], true)).translate([
          -iw / 2 + (col + 0.5) * cw, id / 2 - (row + 0.5) * cd,
        ]));
      });
      // Union first: merged cells never retain internal divider walls, including L shapes.
      const joined = keep(C.union(tiles));
      const fitted = keep(joined.intersect(cavity));
      const original = offset(fitted, -p.gap);
      assertSingle(original, `内盒 ${i + 1} 外轮廓`);
      const overrideKey = partOverrideKey(group);
      const custom = overrides[overrideKey] ?? {};
      const size = { ...dimensions(original, ih, p.innerWall, p.innerBottom), ...custom };
      if (size.width <= 2 * size.wall + 2 || size.depth <= 2 * size.wall + 2 || size.height <= size.bottom + 1)
        throw new Error(`内盒 ${i + 1} 尺寸不足，请为内腔保留至少 2 mm 长宽和 1 mm 高度。`);
      const outside = resize(original, size.width, size.depth);
      assertSingle(outside, `内盒 ${i + 1} 外轮廓`);
      assertContained(outside, insertEnvelope, `内盒 ${i + 1} 超出外盒可用内腔，请减小长宽或增加外盒尺寸。`);
      for (let j = 0; j < insertSections.length; j++) {
        const a = outside.bounds(), b = insertSections[j].bounds();
        if (a.min[0] >= b.max[0] || b.min[0] >= a.max[0] || a.min[1] >= b.max[1] || b.min[1] >= a.max[1]) continue;
        if (keep(outside.intersect(insertSections[j])).area() > EPSILON)
          throw new Error(`内盒 ${i + 1} 与内盒 ${j + 1} 相交，请减小独立尺寸。`);
      }
      const inside = offset(outside, -size.wall);
      assertSingle(inside, `内盒 ${i + 1} 内腔`);
      const solid = shell(outside, inside, size.height, size.bottom);
      const rows = group.map(cell => Math.floor(cell / p.cols)), cols = group.map(cell => cell % p.cols);
      const isRectangular = (Math.max(...rows) - Math.min(...rows) + 1) * (Math.max(...cols) - Math.min(...cols) + 1) === group.length;
      const part = toPart(solid, { id: `inner-${i + 1}`, name: `内盒 ${String(i + 1).padStart(2, '0')}`, kind: 'inner', cellIds: [...group],
        dimensions: size, overrideKey, isRectangular });
      part.assemblyPosition[2] = p.bottom;
      insertSections.push(outside);
      insertSolids.push(keep(solid.translate([0, 0, p.bottom])));
      parts.push(part);
    });
    if (p.lidType !== 'none') {
      let lid: Manifold;
      const custom = overrides.lid ?? {};
      const originalFit = p.lidType === 'sleeve' ? offset(outline, p.lidClearance) : offset(cavity, -p.lidClearance);
      const originalOutside = p.lidType === 'sleeve' ? offset(originalFit, p.wall) : outline;
      const size = { ...dimensions(originalOutside, p.lidThickness + p.lidDepth, p.wall, p.lidThickness), ...custom };
      const skirtDepth = size.height - size.bottom;
      if (skirtDepth < 1 - EPSILON || skirtDepth > 20 + EPSILON || skirtDepth > p.height - p.bottom)
        throw new Error('盒盖总高减去顶板厚度后，裙边深度需为 1–20 mm，且不能超过外盒可用高度。');
      if (size.width <= 2 * size.wall + 2 || size.depth <= 2 * size.wall + 2)
        throw new Error('盒盖长宽不足以容纳当前壁厚，请增大盒盖尺寸或减小壁厚。');
      const lidOutside = resize(originalOutside, size.width, size.depth);
      if (p.lidType === 'sleeve') {
        const fit = lidOutside === originalOutside && size.wall === p.wall ? originalFit : offset(lidOutside, -size.wall);
        assertSingle(fit, '外套盖内腔');
        assertContained(originalFit, fit, '外套盖内腔过小，无法套入外盒；请增大长宽或减小壁厚。');
        lid = shell(lidOutside, fit, size.height, size.bottom);
      } else {
        const fit = lidOutside === outline ? originalFit : offset(lidOutside, -p.wall - p.lidClearance);
        assertSingle(fit, '盒盖定位裙边');
        assertContained(fit, originalFit, '内嵌盖定位裙边超出外盒内腔，请减小盒盖长宽。');
        assertContained(offset(cavity, 0.6), lidOutside, '内嵌盖顶板过小，无法覆盖外盒开口；请增大盒盖长宽。');
        const ringInside = offset(fit, -size.wall);
        assertSingle(ringInside, '盒盖定位裙边内腔');
        const plate = keep(lidOutside.extrude(size.bottom));
        const ring = keep(fit.subtract(ringInside));
        const skirt = keep(keep(ring.extrude(skirtDepth)).translate([0, 0, size.bottom]));
        lid = keep(plate.add(skirt));
      }
      const assembledLid = keep(keep(lid.rotate([180, 0, 0])).translate([0, 0, p.height + size.bottom]));
      for (let i = 0; i < insertSolids.length; i++) {
        if (keep(assembledLid.intersect(insertSolids[i])).volume() > EPSILON)
          throw new Error(`盒盖定位裙边与内盒 ${i + 1} 相交，请减小盖高或降低该内盒高度。`);
      }
      parts.push(toPart(lid, { id: 'lid', name: p.lidType === 'sleeve' ? '外套盖' : '内嵌定位盖', kind: 'lid',
        assemblyPosition: [0, 0, p.height + size.bottom], assemblyRotation: [Math.PI, 0, 0], dimensions: size, overrideKey: 'lid', isRectangular: true }));
    }
    return { params: p, groups: groups.map(g => [...g]), overrides: Object.fromEntries(Object.entries(overrides).map(([key, values]) => [key, { ...values }])), parts, warnings, metrics: {
      innerWidth: iw, innerDepth: id, innerHeight: ih, cellWidth: cw, cellDepth: cd,
      insertCount: groups.length, totalVolume: parts.reduce((sum, part) => sum + part.volume, 0),
      triangleCount: parts.reduce((sum, part) => sum + part.indices.length / 3, 0), holeCount,
    } };
  } finally {
    for (let i = resources.length - 1; i >= 0; i--) resources[i].delete();
  }
}
