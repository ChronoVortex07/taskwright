import type { TreeLayout } from '../../core/treeLayout';

/* ------------------------------------------------------------------ *
 * Sizing constants — the single source of truth for canvas geometry. *
 * ------------------------------------------------------------------ */
export const NODE_WIDTH = 208;
export const NODE_HEIGHT = 92;
/** Horizontal gap between depth columns within a band. */
export const COL_GAP = 56;
/** Vertical gap between sub-rows within a lane. */
export const ROW_GAP = 18;
/** Vertical padding inside a lane strip (top and bottom each). */
export const LANE_PAD = 16;
/** Extra horizontal gap between adjacent age bands. */
export const BAND_GAP = 48;
/** Outer padding around all content. */
export const CANVAS_PAD = 48;

/** Distance from one column's left edge to the next column's left edge. */
export const COL_STRIDE = NODE_WIDTH + COL_GAP;
/** Distance from one sub-row's top to the next sub-row's top. */
export const ROW_STRIDE = NODE_HEIGHT + ROW_GAP;

export const MIN_SCALE = 0.2;
export const MAX_SCALE = 2;

/* Level-of-detail thresholds (spec §5): near ≥ 0.75, mid ≥ 0.4, far < 0.4. */
export const LOD_NEAR = 0.75;
export const LOD_MID = 0.4;

export type LodTier = 'near' | 'mid' | 'far';

export interface GeometryNode {
  id: string;
  layout: TreeLayout;
}

export interface NodeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaneRange {
  name: string;
  y: number;
  height: number;
  rows: number;
}

export interface BandRange {
  name: string;
  x: number;
  width: number;
  cols: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Viewport {
  scale: number;
  tx: number;
  ty: number;
}

export interface TreeGeometry {
  nodes: Map<string, NodeBox>;
  lanes: LaneRange[];
  bands: BandRange[];
  width: number;
  height: number;
}

export function lodTier(scale: number): LodTier {
  if (scale >= LOD_NEAR) return 'near';
  if (scale >= LOD_MID) return 'mid';
  return 'far';
}

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * Map P1 layout → absolute pixel boxes, plus lane (row-strip) and band
 * (column-group) ranges. Lanes/bands with no nodes reserve no space. Bug nodes
 * (`band: ''`) anchor at the leftmost column.
 */
export function deriveGeometry(
  nodes: GeometryNode[],
  laneOrder: string[],
  bandOrder: string[]
): TreeGeometry {
  const bandCols = new Map<string, number>();
  const laneRows = new Map<string, number>();
  for (const n of nodes) {
    const { band, lane, depth, subRow } = n.layout;
    if (band) bandCols.set(band, Math.max(bandCols.get(band) ?? 0, depth + 1));
    laneRows.set(lane, Math.max(laneRows.get(lane) ?? 0, subRow + 1));
  }

  const bands: BandRange[] = [];
  const bandX = new Map<string, number>();
  let x = CANVAS_PAD;
  for (const name of bandOrder) {
    const cols = bandCols.get(name) ?? 0;
    if (cols === 0) continue;
    const width = cols * COL_STRIDE - COL_GAP; // trim the trailing inter-column gap
    bands.push({ name, x, width, cols });
    bandX.set(name, x);
    x += width + BAND_GAP;
  }
  const width = bands.length > 0 ? x - BAND_GAP + CANVAS_PAD : CANVAS_PAD * 2;

  const lanes: LaneRange[] = [];
  const laneTop = new Map<string, number>(); // y of first node row in the lane
  let y = CANVAS_PAD;
  for (const name of laneOrder) {
    const rows = laneRows.get(name) ?? 0;
    if (rows === 0) continue;
    const height = rows * ROW_STRIDE - ROW_GAP + LANE_PAD * 2;
    lanes.push({ name, y, height, rows });
    laneTop.set(name, y + LANE_PAD);
    y += height;
  }
  const height = lanes.length > 0 ? y + CANVAS_PAD : CANVAS_PAD * 2;

  const boxes = new Map<string, NodeBox>();
  for (const n of nodes) {
    const { band, lane, depth, subRow } = n.layout;
    const bx = band && bandX.has(band) ? bandX.get(band)! : CANVAS_PAD;
    const ly = laneTop.get(lane) ?? CANVAS_PAD;
    boxes.set(n.id, {
      x: bx + depth * COL_STRIDE,
      y: ly + subRow * ROW_STRIDE,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    });
  }

  return { nodes: boxes, lanes, bands, width, height };
}

/** Prereq→dependent edge anchors: source right-center → target left-center. */
export function edgeAnchors(source: NodeBox, target: NodeBox): { from: Point; to: Point } {
  return {
    from: { x: source.x + source.width, y: source.y + source.height / 2 },
    to: { x: target.x, y: target.y + target.height / 2 },
  };
}

/** A horizontal cubic bezier between two anchor points. */
export function bezierPath(from: Point, to: Point): string {
  const dx = Math.max(COL_GAP, Math.abs(to.x - from.x) / 2);
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
}

/** Center content in the viewport at a scale that fits, never above 1x. */
export function fitToView(
  contentW: number,
  contentH: number,
  viewportW: number,
  viewportH: number,
  pad = 24
): Viewport {
  if (contentW <= 0 || contentH <= 0 || viewportW <= 0 || viewportH <= 0) {
    return { scale: 1, tx: 0, ty: 0 };
  }
  const scale = clampScale(
    Math.min((viewportW - pad * 2) / contentW, (viewportH - pad * 2) / contentH, 1)
  );
  return {
    scale,
    tx: (viewportW - contentW * scale) / 2,
    ty: (viewportH - contentH * scale) / 2,
  };
}

/** Zoom by `factor` while keeping the world point under (cursorX, cursorY) fixed. */
export function zoomAt(vp: Viewport, cursorX: number, cursorY: number, factor: number): Viewport {
  const scale = clampScale(vp.scale * factor);
  const worldX = (cursorX - vp.tx) / vp.scale;
  const worldY = (cursorY - vp.ty) / vp.scale;
  return { scale, tx: cursorX - worldX * scale, ty: cursorY - worldY * scale };
}

/**
 * Keep the surface within reach: content smaller than the viewport is centered;
 * larger content may pan but not drift entirely off-screen (leaves `margin` px).
 */
export function clampViewport(
  vp: Viewport,
  contentW: number,
  contentH: number,
  viewportW: number,
  viewportH: number,
  margin = 80
): Viewport {
  const scaledW = contentW * vp.scale;
  const scaledH = contentH * vp.scale;
  const clamp = (v: number, lo: number, hi: number) =>
    lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v));
  return {
    scale: vp.scale,
    tx: clamp(vp.tx, viewportW - scaledW - margin, margin),
    ty: clamp(vp.ty, viewportH - scaledH - margin, margin),
  };
}

/* ------------------------------------------------------------------ *
 * Geometry inverse (P3b) — screen→world + world→lane/band/cell + the  *
 * hittable reslot strips (covering empty lanes/bands too).            *
 * ------------------------------------------------------------------ */

/** Pointer-drag threshold (screen px): movement under this is a click, not a drag. */
export const DRAG_THRESHOLD = 6;

/** Min hittable strip size for empty (zero-node) reslot lanes/bands. */
export const RESLOT_MIN_W = NODE_WIDTH;
export const RESLOT_MIN_H = ROW_STRIDE;

export interface ReslotLaneTarget {
  name: string;
  y: number;
  height: number;
  /** false = synthesized strip for a lane with no nodes. */
  populated: boolean;
}
export interface ReslotBandTarget {
  name: string;
  x: number;
  width: number;
  populated: boolean;
}
export interface ReslotTargets {
  lanes: ReslotLaneTarget[];
  bands: ReslotBandTarget[];
}

/** Screen point → world point under `vp` (inverse of the surface transform). */
export function screenToWorld(vp: Viewport, screenX: number, screenY: number): Point {
  return { x: (screenX - vp.tx) / vp.scale, y: (screenY - vp.ty) / vp.scale };
}

/** Populated lane whose vertical range contains `worldY`; undefined in a gap. */
export function laneAtY(geometry: TreeGeometry, worldY: number): string | undefined {
  for (const l of geometry.lanes) {
    if (worldY >= l.y && worldY < l.y + l.height) return l.name;
  }
  return undefined;
}

/** Populated band whose horizontal range contains `worldX`; undefined in a gap. */
export function bandAtX(geometry: TreeGeometry, worldX: number): string | undefined {
  for (const b of geometry.bands) {
    if (worldX >= b.x && worldX < b.x + b.width) return b.name;
  }
  return undefined;
}

/**
 * Drop / click cell at a world point. Either component may be undefined (a gap /
 * empty lane or band) — the caller maps undefined lane → Misc (no category) and
 * undefined band → Backburner (no milestone).
 */
export function cellAt(
  geometry: TreeGeometry,
  worldX: number,
  worldY: number
): { lane?: string; band?: string } {
  return { lane: laneAtY(geometry, worldY), band: bandAtX(geometry, worldX) };
}

/**
 * Hittable reslot strips covering EVERY lane/band in order. Populated lanes/bands
 * use their exact geometry range (authoritative — they match rendered nodes); empty
 * ones get `RESLOT_MIN_*` strips appended past the content bottom/right so they never
 * overlap a populated range yet stay reachable (band-expand-on-hover makes them easy).
 */
export function reslotTargets(
  geometry: TreeGeometry,
  laneOrder: string[],
  bandOrder: string[],
  minW = RESLOT_MIN_W,
  minH = RESLOT_MIN_H
): ReslotTargets {
  const laneByName = new Map(geometry.lanes.map((l) => [l.name, l]));
  const bandByName = new Map(geometry.bands.map((b) => [b.name, b]));

  const lanes: ReslotLaneTarget[] = [];
  for (const name of laneOrder) {
    const g = laneByName.get(name);
    if (g) lanes.push({ name, y: g.y, height: g.height, populated: true });
  }
  // Empty lanes: stack min-height strips below the last populated row (deriveGeometry:
  // height = contentBottom + CANVAS_PAD, so contentBottom = height - CANVAS_PAD).
  let ly = geometry.lanes.length > 0 ? geometry.height - CANVAS_PAD : CANVAS_PAD;
  for (const name of laneOrder) {
    if (laneByName.has(name)) continue;
    lanes.push({ name, y: ly, height: minH, populated: false });
    ly += minH;
  }

  const bands: ReslotBandTarget[] = [];
  for (const name of bandOrder) {
    const g = bandByName.get(name);
    if (g) bands.push({ name, x: g.x, width: g.width, populated: true });
  }
  // Empty bands: min-width strips right of the last populated column
  // (width = contentRight + CANVAS_PAD, so contentRight = width - CANVAS_PAD).
  let bx = geometry.bands.length > 0 ? geometry.width - CANVAS_PAD : CANVAS_PAD;
  for (const name of bandOrder) {
    if (bandByName.has(name)) continue;
    bands.push({ name, x: bx, width: minW, populated: false });
    bx += minW + BAND_GAP;
  }

  // Keep both axes in the given order (populated first, then appended empties) —
  // callers rely on `.map(name)` matching laneOrder/bandOrder.
  lanes.sort((a, b) => laneOrder.indexOf(a.name) - laneOrder.indexOf(b.name));
  bands.sort((a, b) => bandOrder.indexOf(a.name) - bandOrder.indexOf(b.name));
  return { lanes, bands };
}
