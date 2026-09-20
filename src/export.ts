import JSZip from 'jszip';
import { createDesignFile } from './design';
import { initCAD, buildCAD, exportCADSTEP } from './cad';
import { createFreeCADMacro } from './freecad';
import type { CadRecipe } from './cad-types';
import type { ModelData, PartData, Vec3 } from './types';

export type ExportFormat = 'step' | 'stl' | 'freecad';

const formatExtension = (format: ExportFormat) => format === 'freecad' ? 'FCMacro' : format;

function freeCADBlob(recipe: CadRecipe): Blob {
  return new Blob([createFreeCADMacro(recipe)], { type: 'text/x-python;charset=utf-8' });
}

export function partFilename(part: PartData, format: ExportFormat = 'stl'): string {
  const extension = formatExtension(format);
  if (part.kind === 'outer') return `outer_box.${extension}`;
  if (part.kind === 'lid') return `${part.name.includes('外套') ? 'sleeve_lid' : 'inset_lid'}.${extension}`;
  return `insert_${part.id.replace('inner-', '').padStart(2, '0')}.${extension}`;
}

/** Binary STL stores mm coordinates in the part's print orientation, never scene transforms. */
export function serializeSTL(part: Pick<PartData, 'positions' | 'indices'>): ArrayBuffer {
  const triangleCount = part.indices.length / 3;
  if (!Number.isInteger(triangleCount)) throw new Error('STL 三角网格索引不完整。');
  const buffer = new ArrayBuffer(84 + triangleCount * 50);
  const bytes = new Uint8Array(buffer);
  bytes.set(new TextEncoder().encode('OpenBoxHub | units: millimeters | print orientation | binary STL'));
  const data = new DataView(buffer);
  data.setUint32(80, triangleCount, true);
  const positions = part.positions, indices = part.indices;
  for (let face = 0; face < triangleCount; face++) {
    const a = indices[face * 3] * 3, b = indices[face * 3 + 1] * 3, c = indices[face * 3 + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (length > 0) { nx /= length; ny /= length; nz /= length; }
    const base = 84 + face * 50;
    data.setFloat32(base, nx, true); data.setFloat32(base + 4, ny, true); data.setFloat32(base + 8, nz, true);
    for (let corner = 0; corner < 3; corner++) {
      const index = indices[face * 3 + corner] * 3;
      for (let axis = 0; axis < 3; axis++) data.setFloat32(base + 12 + corner * 12 + axis * 4, positions[index + axis], true);
    }
    data.setUint16(base + 48, 0, true);
  }
  return buffer;
}

/** Lay every canonical part flat and separately on Z=0. No scene/explosion state is involved. */
export function layoutPrintPlate(parts: PartData[], spacing = 8): { positions: Float32Array; indices: Uint32Array; bounds: Vec3; placements: { id: string; offset: Vec3 }[] } {
  const area = parts.reduce((sum, p) => sum + (p.bounds[0] + spacing) * (p.bounds[1] + spacing), 0);
  const rowWidth = Math.max(...parts.map(p => p.bounds[0]), Math.sqrt(area) * 1.2);
  let x = 0, y = 0, rowDepth = 0, width = 0, depth = 0, height = 0;
  const placements = parts.map(part => {
    const [w, d, h] = part.bounds;
    if (x > 0 && x + w > rowWidth) { x = 0; y += rowDepth + spacing; rowDepth = 0; }
    const offset: Vec3 = [x + w / 2, y + d / 2, 0];
    x += w + spacing; rowDepth = Math.max(rowDepth, d);
    width = Math.max(width, x - spacing); depth = Math.max(depth, y + d); height = Math.max(height, h);
    return { id: part.id, offset };
  });
  const positions = new Float32Array(parts.reduce((sum, p) => sum + p.positions.length, 0));
  const indices = new Uint32Array(parts.reduce((sum, p) => sum + p.indices.length, 0));
  let pv = 0, pi = 0;
  parts.forEach((part, n) => {
    const offset = placements[n].offset;
    for (let i = 0; i < part.positions.length; i++) positions[pv + i] = part.positions[i] + offset[i % 3];
    for (let i = 0; i < part.indices.length; i++) indices[pi + i] = part.indices[i] + pv / 3;
    pv += part.positions.length; pi += part.indices.length;
  });
  return { positions, indices, bounds: [width, depth, height], placements };
}

export function createManifest(model: ModelData, format: ExportFormat = 'stl'): object {
  return {
    format: 'openboxhub-parametric-kit', version: 1, units: 'mm', generatedAt: new Date().toISOString(),
    params: model.params, groups: model.groups, overrides: model.overrides,
    metrics: model.metrics, warnings: model.warnings,
    printOrientation: 'All part files are centered in XY, rest on Z=0, and use millimeters. Lid top face rests on the bed; its locating skirt faces up.',
    printNotes: `${format === 'freecad' ? 'Run each FCMacro in FreeCAD to create editable Bodies, sketches, Pads and Pockets, then save as FCStd. Export STEP or STL from FreeCAD for slicing. ' : 'Import individual part files into Bambu Studio as separate objects, then arrange and slice. '}Check bed dimensions. Export contains no filament or printer profile. Fit clearance may need calibration for your printer and material.`,
    parts: model.parts.map(part => ({ id: part.id, name: part.name, file: partFilename(part, format),
      kind: part.kind, bounds: part.bounds, dimensions: part.dimensions, volumeMm3: part.volume, cells: part.cellIds,
      assemblyPosition: part.assemblyPosition, assemblyRotation: part.assemblyRotation ?? [0, 0, 0] })),
  };
}

export async function createKitZIP(model: ModelData, format: ExportFormat = 'stl'): Promise<Blob> {
  const zip = new JSZip();
  if (format === 'stl') {
    for (const part of model.parts) zip.file(partFilename(part, format), serializeSTL(part));
  } else {
    await initCAD();
    const cad = buildCAD(model);
    try {
      for (const part of model.parts) {
        const cadPart = cad.parts.find(candidate => candidate.id === part.id);
        if (!cadPart) throw new Error(`未生成 ${part.name} 的 CAD 实体。`);
        const blob = format === 'step' ? exportCADSTEP([cadPart]) : freeCADBlob({ parts: [{ ...cadPart.recipe, offset: [0, 0, 0] }] });
        zip.file(partFilename(part, format), await blob.arrayBuffer());
      }
      if (format === 'freecad') {
        const offsets = new Map(layoutPrintPlate(model.parts).placements.map(placement => [placement.id, placement.offset]));
        zip.file('openboxhub_all_parts_flat_mm.FCMacro', createFreeCADMacro({
          parts: cad.recipe.parts.map(part => ({ ...part, offset: offsets.get(part.id) ?? [0, 0, 0] })),
        }));
      }
    } finally {
      cad.dispose();
    }
  }
  zip.file('manifest.json', JSON.stringify(createManifest(model, format), null, 2));
  const design = createDesignFile({ params: model.params, groups: model.groups, overrides: model.overrides, locked: false });
  zip.file('design.json', await design.blob.text());
  zip.file('README.txt', [
    'OpenBoxHub 参数化收纳盒',
    `所有 ${format === 'freecad' ? 'FreeCAD 工程' : format.toUpperCase()} 使用毫米 (mm)，每个零件均独立、平放于 Z=0。`,
    format === 'freecad'
      ? '在 FreeCAD 中运行 .FCMacro，生成可编辑草图、拉伸与切除，再另存为 .FCStd；需要切片时从 FreeCAD 导出 STEP 或 STL。整套平铺宏可一次生成全部零件。'
      : `在 Bambu Studio 中导入 ${format.toUpperCase()} 作为独立对象，自动摆盘并检查打印机平台尺寸后切片。`,
    '盖子已按顶板朝下、裙边朝上导出。不要按装配展示的朝向打印盖子。',
    format === 'step' ? 'STEP 直接由参数构建解析 CAD 实体，保留圆弧与曲面，不包含参数化建模历史。'
      : format === 'freecad' ? 'FreeCAD 草图轮廓可编辑；高度与底厚可在参数对象中修改。宏在新文档中建模，不覆盖现有工程。'
      : 'STL 不保存单位和打印配置；导入时使用毫米，不缩放。',
    '默认内盒单边间隙为 gap，相邻内盒间隙为 2×gap；独立调整尺寸后以实际几何为准。',
    '所有盖型统一为内盒预留 lidDepth + lidClearance 高度，便于换盖。',
    '实际配合受材料、机器和切片影响，建议先打印一套小尺寸校准件。',
    '在 OpenBoxHub 中导入 design.json 可恢复参数、内盒合并分组和独立尺寸；也支持导入 manifest.json。',
    `零件尺寸与装配变换见 manifest.json；外盒 ${model.params.width} × ${model.params.depth} × ${model.params.height} mm。`,
  ].join('\n'));
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/** Prepare the complete file before the user clicks its native browser download link. */
export async function createExportFile(model: ModelData, target = 'plate', format: ExportFormat = 'step'): Promise<{ blob: Blob; filename: string }> {
  if (format !== 'step' && format !== 'stl' && format !== 'freecad') throw new Error('请选择 STEP、STL 或 FreeCAD 导出格式。');
  if (target === 'kit') return {
    blob: await createKitZIP(model, format),
    filename: `openboxhub_${model.params.width}x${model.params.depth}x${model.params.height}_${format}_mm.zip`,
  };
  const part = target === 'plate' ? undefined : model.parts.find(part => part.id === target);
  if (target !== 'plate' && !part) throw new Error('请重新选择需要导出的零件。');
  const plate = target === 'plate' ? layoutPrintPlate(model.parts) : undefined;
  const filename = part ? partFilename(part, format) : `openboxhub_all_parts_flat_mm.${formatExtension(format)}`;
  if (format === 'stl') return { blob: new Blob([serializeSTL(part ?? plate!)], { type: 'model/stl' }), filename };

  // CAD is rebuilt from the parameters and planar profiles, never from display meshes.
  await initCAD();
  const cad = buildCAD(model);
  try {
    const parts = part ? cad.parts.filter(candidate => candidate.id === part.id) : cad.parts;
    if (!parts.length) throw new Error('未生成所选零件的 CAD 实体。');
    const offsets = plate ? new Map(plate.placements.map(placement => [placement.id, placement.offset])) : undefined;
    const blob = format === 'step' ? exportCADSTEP(parts, offsets) : freeCADBlob({
      parts: parts.map(candidate => ({ ...candidate.recipe, offset: offsets?.get(candidate.id) ?? [0, 0, 0] })),
    });
    return { blob, filename };
  } finally {
    cad.dispose();
  }
}
