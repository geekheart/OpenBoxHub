import { validateOverrides, validateParams } from './geometry';
import { DEFAULT_PARAMS, partOverrideKey } from './types';
import type { Params, PartDimensions, PartOverrides } from './types';

export interface DesignConfig {
  params: Params;
  groups: number[][];
  overrides: PartOverrides;
  locked: boolean;
}

export const MAX_DESIGN_FILE_BYTES = 1_048_576;

const DESIGN_KEYS = ['format', 'version', 'units', 'params', 'groups', 'overrides', 'locked'];
const MANIFEST_KEYS = [...DESIGN_KEYS, 'generatedAt', 'metrics', 'warnings', 'printOrientation', 'printNotes', 'parts'];
const PARAM_KEYS = Object.keys(DEFAULT_PARAMS) as (keyof Params)[];
const LEGACY_OPTIONAL_PARAMS = new Set<keyof Params>(['baseStyle', 'holeSize', 'ribWidth', 'holeMargin', 'slotLength']);
const DIMENSION_KEYS: (keyof PartDimensions)[] = ['width', 'depth', 'height', 'wall', 'bottom'];
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name}必须是对象。`);
  return value as Record<string, unknown>;
}

function knownKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${name}包含不支持的字段。`);
}

/** Reject unsafe keys even in ignored manifest metadata; never merge arbitrary input objects. */
function checkObjectTree(root: unknown): void {
  const pending: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (value === null || typeof value !== 'object') continue;
    if (depth > 24) throw new Error('参数文件层级过多。');
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) throw new Error('参数文件包含不允许的字段。');
      if (child !== null && typeof child === 'object') pending.push({ value: child, depth: depth + 1 });
    }
  }
}

/** Parse a portable design or the manifest from an exported kit. No storage or network access. */
export function parseDesignFile(text: string): DesignConfig {
  if (typeof text !== 'string') throw new Error('请选择 JSON 参数文件。');
  if (text.length > MAX_DESIGN_FILE_BYTES || new TextEncoder().encode(text).byteLength > MAX_DESIGN_FILE_BYTES)
    throw new Error('参数文件不能超过 1 MB。');
  let parsed: unknown;
  try { parsed = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error('文件不是有效的 JSON，请选择 OpenBoxHub 参数文件。'); }
  checkObjectTree(parsed);
  const input = object(parsed, '参数文件');
  const legacy = input.format === 'openboxhub-parametric-kit';
  if (input.format !== 'openboxhub-design' && !legacy) throw new Error('这不是 OpenBoxHub 参数文件或装配清单。');
  if (input.version !== 1) throw new Error('不支持该参数文件版本。');
  if (input.units !== 'mm') throw new Error('参数文件的单位必须为 mm（毫米）。');
  knownKeys(input, legacy ? MANIFEST_KEYS : DESIGN_KEYS, '参数文件');
  if (input.locked !== undefined && typeof input.locked !== 'boolean') throw new Error('外盒锁定状态必须为 true 或 false。');

  const sourceParams = object(input.params, '参数');
  knownKeys(sourceParams, PARAM_KEYS, '参数');
  const params = {} as Params;
  for (const key of PARAM_KEYS) {
    let value = sourceParams[key];
    if (value === undefined && legacy && LEGACY_OPTIONAL_PARAMS.has(key)) value = DEFAULT_PARAMS[key];
    if (value === undefined) throw new Error(`参数文件缺少 ${key}。`);
    if (key === 'lidType' || key === 'baseStyle') {
      if (typeof value !== 'string') throw new Error(`参数 ${key} 必须是有效选项。`);
    } else if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`参数 ${key} 必须是有限数字。`);
    }
    // Only fixed, known keys are copied; values are checked by validateParams below.
    Object.assign(params, { [key]: value });
  }

  if (!Array.isArray(input.groups) || input.groups.length > 144 || input.groups.some(group =>
    !Array.isArray(group) || group.length > 144 || group.some(cell => typeof cell !== 'number' || !Number.isInteger(cell))))
    throw new Error('内盒分组必须是格子编号的二维整数数组。');
  const groups = input.groups.map(group => [...group] as number[]);
  const errors = validateParams(params, groups);
  if (errors.length) throw new Error(errors.join('\n'));

  const sourceOverrides = object(input.overrides === undefined && legacy ? {} : input.overrides, '独立盒子参数');
  const validKeys = new Set([...groups.map(partOverrideKey), 'lid']);
  const overrides: PartOverrides = {};
  for (const [key, raw] of Object.entries(sourceOverrides)) {
    if (!validKeys.has(key)) throw new Error('独立盒子参数对应的零件不存在。');
    const patch = object(raw, '独立盒子参数');
    knownKeys(patch, DIMENSION_KEYS, '独立盒子参数');
    const values: Partial<PartDimensions> = {};
    for (const field of DIMENSION_KEYS) {
      if (patch[field] === undefined) continue;
      const value = patch[field];
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        throw new Error(`独立盒子参数 ${field} 必须是大于 0 的有限数字。`);
      values[field] = value;
    }
    overrides[key] = values;
  }
  const overrideErrors = validateOverrides(params, groups, overrides);
  if (overrideErrors.length) throw new Error(overrideErrors.join('\n'));
  return { params, groups, overrides, locked: input.locked === true };
}

/** Build a native-download file containing settings only, without persisting browser history. */
export function createDesignFile(config: DesignConfig): { blob: Blob; filename: string } {
  const payload = { format: 'openboxhub-design', version: 1, units: 'mm',
    params: config.params, groups: config.groups, overrides: config.overrides, locked: config.locked };
  const text = JSON.stringify(payload, null, 2);
  // Do not emit a settings file that our importer cannot read.
  parseDesignFile(text);
  return {
    blob: new Blob([text], { type: 'application/json' }),
    filename: `openboxhub_${config.params.width}x${config.params.depth}x${config.params.height}.json`,
  };
}
