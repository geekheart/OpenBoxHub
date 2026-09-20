export type Vec3 = [number, number, number];
export type LidType = 'none' | 'sleeve' | 'inset';
export type BaseStyle = 'solid' | 'honeycomb' | 'circles' | 'grid' | 'slots';
export interface Params {
  width: number;
  depth: number;
  height: number;
  wall: number;
  bottom: number;
  radius: number;
  rows: number;
  cols: number;
  /** Clearance from each insert to grid boundaries and outer inner walls, in mm. */
  gap: number;
  innerWall: number;
  innerBottom: number;
  lidType: LidType;
  lidThickness: number;
  lidDepth: number;
  lidClearance: number;
  baseStyle: BaseStyle;
  /** Perforation width; for hexagons this is the distance between opposite sides. */
  holeSize: number;
  ribWidth: number;
  holeMargin: number;
  /** Total capsule length, used only for slots. */
  slotLength: number;
}
export type PartKind = 'outer' | 'inner' | 'lid';
export interface PartData {
  id: string;
  name: string;
  kind: PartKind;
  /** Canonical print orientation: centered XY, minimum Z = 0. Units are mm. */
  positions: Float32Array;
  indices: Uint32Array;
  assemblyPosition: Vec3;
  assemblyRotation?: Vec3;
  /** Width, depth and height in canonical print orientation. */
  bounds: Vec3;
  volume: number;
  cellIds?: number[];
}
export interface ModelMetrics {
  innerWidth: number;
  innerDepth: number;
  innerHeight: number;
  cellWidth: number;
  cellDepth: number;
  insertCount: number;
  totalVolume: number;
  triangleCount: number;
  holeCount: number;
}
export interface ModelData {
  params: Params;
  groups: number[][];
  parts: PartData[];
  metrics: ModelMetrics;
  warnings: string[];
}
export const DEFAULT_PARAMS: Params = {
  width: 145.4, depth: 111.2, height: 24, wall: 2, bottom: 2, radius: 5,
  rows: 2, cols: 3, gap: 0.35, innerWall: 1, innerBottom: 1,
  lidType: 'sleeve', lidThickness: 1.5, lidDepth: 3, lidClearance: 0.25,
  baseStyle: 'solid', holeSize: 12, ribWidth: 1.6, holeMargin: 3, slotLength: 22,
};
export function defaultGroups(rows: number, cols: number): number[][] {
  return Array.from({ length: rows * cols }, (_, i) => [i]);
}
