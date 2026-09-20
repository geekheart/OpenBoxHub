import type { PartData } from './types';

type StepPart = Pick<PartData, 'id' | 'indices'> & { positions: Float32Array | Float64Array };
type Point = [number, number, number];
type Triangle = [number, number, number];
type ValidatedMesh = { points: Point[]; triangles: Triangle[] };

const difference = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Point, b: Point): Point => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Point, b: Point): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v: Point): Point => { const length = Math.hypot(...v); return v.map(value => value / length) as Point; };

/** STEP REAL literals require a decimal point, including the mantissa in exponent notation. */
function real(value: number): string {
  const [mantissa, exponent] = (Object.is(value, -0) ? '0' : String(value)).toUpperCase().split('E');
  return `${mantissa.includes('.') ? mantissa : `${mantissa}.`}${exponent === undefined ? '' : `E${exponent}`}`;
}

/** ISO 10303-21 strings: doubled quotes/backslashes and explicit Unicode escapes. */
function quoted(value: string): string {
  let encoded = '';
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) throw new Error('STEP 文本包含无效的 Unicode 字符。');
    if (character === "'") encoded += "''";
    else if (character === '\\') encoded += '\\\\';
    else if (point >= 32 && point <= 126) encoded += character;
    else if (point <= 0xffff) encoded += `\\X2\\${point.toString(16).toUpperCase().padStart(4, '0')}\\X0\\`;
    else encoded += `\\X4\\${point.toString(16).toUpperCase().padStart(8, '0')}\\X0\\`;
  }
  return `'${encoded}'`;
}

/** Validate the actual welded coordinates, rather than relying on a mesh's original indices. */
function validateMesh(part: StepPart): ValidatedMesh {
  const fail = (reason: string): never => { throw new Error(`零件 ${part.id} 无法导出 STEP：${reason}`); };
  const { positions, indices } = part;
  if (!positions || positions.length < 12 || positions.length % 3 || !indices || indices.length < 12 || indices.length % 3)
    fail('三角网格数据不完整。');
  const points: Point[] = [], remap: number[] = [], welded = new Map<string, number>();
  for (let i = 0; i < positions.length; i += 3) {
    const point: Point = [positions[i], positions[i + 1], positions[i + 2]];
    if (point.some(value => !Number.isFinite(value))) fail('坐标必须是有限数字。');
    const key = point.join(',');
    let index = welded.get(key);
    if (index === undefined) { index = points.length; welded.set(key, index); points.push(point); }
    remap.push(index);
  }
  const triangles: Triangle[] = [];
  const seenFaces = new Set<string>();
  const edges = new Map<string, { count: number; balance: number; faces: number[] }>();
  const vertexLinks = points.map(() => new Map<number, Set<number>>());
  const origin = points[0];
  let volume6 = 0, correction = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const source = [indices[i], indices[i + 1], indices[i + 2]];
    if (source.some(index => !Number.isInteger(index) || index < 0 || index >= remap.length)) fail('三角面索引超出范围。');
    const face = source.map(index => remap[index]) as Triangle;
    if (new Set(face).size !== 3) fail('焊接后存在退化三角面。');
    const [a, b, c] = face.map(index => points[index]);
    const normal = cross(difference(b, a), difference(c, a));
    const area = Math.hypot(...normal);
    if (!Number.isFinite(area) || area <= 1e-12) fail('存在零面积或退化三角面。');
    const faceKey = [...face].sort((x, y) => x - y).join(',');
    if (seenFaces.has(faceKey)) fail('存在重复三角面。');
    seenFaces.add(faceKey);
    const faceIndex = triangles.length;
    triangles.push(face);
    for (let corner = 0; corner < 3; corner++) {
      const from = face[corner], to = face[(corner + 1) % 3];
      const edgeKey = `${Math.min(from, to)},${Math.max(from, to)}`;
      const edge = edges.get(edgeKey) ?? { count: 0, balance: 0, faces: [] };
      edge.count++; edge.balance += from < to ? 1 : -1; edge.faces.push(faceIndex); edges.set(edgeKey, edge);
      const opposite = face[(corner + 2) % 3], link = vertexLinks[from];
      if (!link.has(to)) link.set(to, new Set());
      if (!link.has(opposite)) link.set(opposite, new Set());
      link.get(to)!.add(opposite); link.get(opposite)!.add(to);
    }
    // Relative coordinates and compensated summation avoid cancellation on a translated print plate.
    const contribution = dot(difference(a, origin), cross(difference(b, origin), difference(c, origin))) - correction;
    const next = volume6 + contribution;
    correction = (next - volume6) - contribution; volume6 = next;
  }
  const adjacent = triangles.map(() => [] as number[]);
  for (const edge of edges.values()) {
    if (edge.count !== 2 || edge.balance !== 0) fail('网格不是闭合且方向一致的实体。');
    adjacent[edge.faces[0]].push(edge.faces[1]); adjacent[edge.faces[1]].push(edge.faces[0]);
  }
  const visited = new Set<number>([0]), pending = [0];
  for (let i = 0; i < pending.length; i++) for (const neighbor of adjacent[pending[i]]) {
    if (!visited.has(neighbor)) { visited.add(neighbor); pending.push(neighbor); }
  }
  if (visited.size !== triangles.length) fail('一个零件必须对应一个连通的闭合壳体。');
  for (const link of vertexLinks) {
    if (!link.size) continue;
    const first = link.keys().next().value!;
    const found = new Set([first]), queue = [first];
    for (let i = 0; i < queue.length; i++) {
      const neighbors = link.get(queue[i])!;
      if (neighbors.size !== 2) fail('顶点处存在非流形连接。');
      for (const neighbor of neighbors) if (!found.has(neighbor)) { found.add(neighbor); queue.push(neighbor); }
    }
    if (found.size !== link.size) fail('顶点处存在非流形连接。');
  }
  if (!Number.isFinite(volume6) || volume6 <= 1e-12) fail('实体体积必须为正，且所有表面应朝外。');
  return { points, triangles };
}

/**
 * AP214 planar FACETED_BREP, using the input print coordinates verbatim.
 * Each part has its own PRODUCT and shape representation; no display transforms are read.
 * Schema references (STEP Tools' published EXPRESS definitions):
 * https://www.steptools.com/docs/stp_aim/html/t_faceted_brep_shape_representation.html
 * https://www.steptools.com/docs/stp_aim/html/t_face_surface.html
 * https://www.steptools.com/docs/stp_aim/html/t_poly_loop.html
 * The source is the already validated Manifold mesh, not a recovered analytic CAD surface.
 */
export function serializeSTEP(parts: StepPart[], filename = 'openboxhub.step'): string {
  if (!Array.isArray(parts) || !parts.length) throw new Error('请至少选择一个零件导出 STEP。');
  if (typeof filename !== 'string' || !filename.trim()) throw new Error('STEP 文件名不能为空。');
  const ids = new Set<string>();
  const meshes = parts.map(part => {
    if (!part || typeof part.id !== 'string' || !part.id.trim() || ids.has(part.id)) throw new Error('STEP 零件标识必须唯一且非空。');
    ids.add(part.id);
    return validateMesh(part);
  });
  const entities: string[] = [];
  const entity = (body: string): string => { const id = `#${entities.length + 1}`; entities.push(`${id}=${body};`); return id; };
  const application = entity("APPLICATION_CONTEXT('core data for automotive mechanical design processes')");
  entity(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${application})`);
  const productContext = entity(`PRODUCT_CONTEXT('',${application},'mechanical')`);
  const definitionContext = entity(`PRODUCT_DEFINITION_CONTEXT('part definition',${application},'design')`);
  const lengthUnit = entity('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))');
  const angleUnit = entity('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))');
  const solidAngleUnit = entity('(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())');
  const uncertainty = entity(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-7),${lengthUnit},'distance_accuracy_value','')`);
  const context = entity(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${uncertainty}))GLOBAL_UNIT_ASSIGNED_CONTEXT((${lengthUnit},${angleUnit},${solidAngleUnit}))REPRESENTATION_CONTEXT('','3D'))`);
  const origin = entity("CARTESIAN_POINT('',(0.,0.,0.))");
  const zAxis = entity("DIRECTION('',(0.,0.,1.))"), xAxis = entity("DIRECTION('',(1.,0.,0.))");
  const placement = entity(`AXIS2_PLACEMENT_3D('',${origin},${zAxis},${xAxis})`);
  const products: string[] = [];
  meshes.forEach((mesh, index) => {
    const label = quoted(parts[index].id);
    const points = mesh.points.map(point => entity(`CARTESIAN_POINT('',(${point.map(real).join(',')}))`));
    const faces = mesh.triangles.map(triangle => {
      const [a, b, c] = triangle.map(vertex => mesh.points[vertex]);
      const normal = unit(cross(difference(b, a), difference(c, a)));
      const reference = unit(difference(b, a));
      const normalId = entity(`DIRECTION('',(${normal.map(real).join(',')}))`);
      const referenceId = entity(`DIRECTION('',(${reference.map(real).join(',')}))`);
      const frame = entity(`AXIS2_PLACEMENT_3D('',${points[triangle[0]]},${normalId},${referenceId})`);
      const plane = entity(`PLANE('',${frame})`);
      const loop = entity(`POLY_LOOP('',(${triangle.map(vertex => points[vertex]).join(',')}))`);
      const bound = entity(`FACE_OUTER_BOUND('',${loop},.T.)`);
      return entity(`FACE_SURFACE('',(${bound}),${plane},.T.)`);
    });
    const shell = entity(`CLOSED_SHELL(${label},(${faces.join(',')}))`);
    const brep = entity(`FACETED_BREP(${label},${shell})`);
    const representation = entity(`FACETED_BREP_SHAPE_REPRESENTATION(${label},(${placement},${brep}),${context})`);
    const product = entity(`PRODUCT(${label},${label},'',(${productContext}))`);
    products.push(product);
    const formation = entity(`PRODUCT_DEFINITION_FORMATION('1','',${product})`);
    const definition = entity(`PRODUCT_DEFINITION('design','',${formation},${definitionContext})`);
    const shape = entity(`PRODUCT_DEFINITION_SHAPE('','',${definition})`);
    entity(`SHAPE_DEFINITION_REPRESENTATION(${shape},${representation})`);
  });
  entity(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(${products.join(',')}))`);
  return [
    'ISO-10303-21;', 'HEADER;',
    "FILE_DESCRIPTION(('OpenBoxHub planar faceted solids; millimeters; print orientation'),'2;1');",
    `FILE_NAME(${quoted(filename)},${quoted(new Date().toISOString())},(''),(''),'OpenBoxHub','OpenBoxHub','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));", 'ENDSEC;', 'DATA;',
    ...entities, 'ENDSEC;', 'END-ISO-10303-21;', '',
  ].join('\n');
}
