import { describe, it, expect } from 'vitest';
import type { TreeLayout } from '../../core/treeLayout';
import {
  NODE_WIDTH,
  NODE_HEIGHT,
  COL_STRIDE,
  ROW_STRIDE,
  CANVAS_PAD,
  LANE_PAD,
  MIN_SCALE,
  MAX_SCALE,
  lodTier,
  clampScale,
  deriveGeometry,
  edgeAnchors,
  bezierPath,
  fitToView,
  zoomAt,
  clampViewport,
  type GeometryNode,
} from '../../webview/lib/treeGeometry';

const node = (id: string, layout: TreeLayout): GeometryNode => ({ id, layout });

describe('treeGeometry — LOD thresholds', () => {
  it('near ≥ 0.75, mid ≥ 0.4, far < 0.4', () => {
    expect(lodTier(2)).toBe('near');
    expect(lodTier(0.75)).toBe('near');
    expect(lodTier(0.74)).toBe('mid');
    expect(lodTier(0.4)).toBe('mid');
    expect(lodTier(0.39)).toBe('far');
    expect(lodTier(0.2)).toBe('far');
  });
});

describe('treeGeometry — clampScale', () => {
  it('clamps to [MIN_SCALE, MAX_SCALE]', () => {
    expect(clampScale(10)).toBe(MAX_SCALE);
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(1)).toBe(1);
  });
});

describe('treeGeometry — deriveGeometry', () => {
  const laneOrder = ['Features', 'Misc', 'Bugs'];
  const bandOrder = ['v1', 'Backburner'];
  // Features lane: two depths in band v1, one branch (subRows 0 and 1).
  const nodes: GeometryNode[] = [
    node('A', { lane: 'Features', band: 'v1', depth: 0, subRow: 0 }),
    node('B', { lane: 'Features', band: 'v1', depth: 1, subRow: 0 }),
    node('C', { lane: 'Features', band: 'v1', depth: 1, subRow: 1 }),
    node('M', { lane: 'Misc', band: 'Backburner', depth: 0, subRow: 0 }),
    node('BUG', { lane: 'Bugs', band: '', depth: 0, subRow: 0 }),
  ];

  it('positions nodes from lane/band/depth/subRow and cell strides', () => {
    const g = deriveGeometry(nodes, laneOrder, bandOrder);
    const a = g.nodes.get('A')!;
    const b = g.nodes.get('B')!;
    const c = g.nodes.get('C')!;
    // A at band v1 column 0, Features lane row 0.
    expect(a.x).toBe(CANVAS_PAD);
    expect(a.y).toBe(CANVAS_PAD + LANE_PAD);
    // B one depth to the right of A.
    expect(b.x).toBe(a.x + COL_STRIDE);
    // C is B's sibling sub-row: same x, one row down.
    expect(c.x).toBe(b.x);
    expect(c.y).toBe(a.y + ROW_STRIDE);
    // node dimensions
    expect(a.width).toBe(NODE_WIDTH);
    expect(a.height).toBe(NODE_HEIGHT);
  });

  it('lays lanes top→down in laneOrder, skipping empty lanes', () => {
    const g = deriveGeometry(nodes, laneOrder, bandOrder);
    expect(g.lanes.map((l) => l.name)).toEqual(['Features', 'Misc', 'Bugs']);
    // lanes are vertically stacked, non-overlapping
    for (let i = 1; i < g.lanes.length; i++) {
      expect(g.lanes[i].y).toBeGreaterThanOrEqual(g.lanes[i - 1].y + g.lanes[i - 1].height);
    }
  });

  it('lays bands left→right in bandOrder, skipping bands with no nodes', () => {
    const g = deriveGeometry(nodes, laneOrder, bandOrder);
    // both v1 and Backburner have nodes here
    expect(g.bands.map((bnd) => bnd.name)).toEqual(['v1', 'Backburner']);
    expect(g.bands[1].x).toBeGreaterThan(g.bands[0].x + g.bands[0].width - 1);
  });

  it('anchors band-less bug nodes at the leftmost column', () => {
    const g = deriveGeometry(nodes, laneOrder, bandOrder);
    expect(g.nodes.get('BUG')!.x).toBe(CANVAS_PAD);
  });

  it('reports a positive content width/height', () => {
    const g = deriveGeometry(nodes, laneOrder, bandOrder);
    expect(g.width).toBeGreaterThan(0);
    expect(g.height).toBeGreaterThan(0);
  });

  it('is empty-safe', () => {
    const g = deriveGeometry([], [], []);
    expect(g.nodes.size).toBe(0);
    expect(g.lanes).toEqual([]);
    expect(g.bands).toEqual([]);
  });
});

describe('treeGeometry — edges', () => {
  it('anchors from source right-center to target left-center', () => {
    const src = { x: 0, y: 0, width: 200, height: 100 };
    const tgt = { x: 400, y: 200, width: 200, height: 100 };
    const { from, to } = edgeAnchors(src, tgt);
    expect(from).toEqual({ x: 200, y: 50 });
    expect(to).toEqual({ x: 400, y: 250 });
  });

  it('builds a cubic bezier path string', () => {
    const d = bezierPath({ x: 0, y: 0 }, { x: 100, y: 50 });
    expect(d.startsWith('M 0 0 C ')).toBe(true);
    expect(d).toContain('100 50');
  });
});

describe('treeGeometry — viewport math', () => {
  it('fitToView centers content and never scales above 1', () => {
    const vp = fitToView(100, 100, 1000, 1000, 0);
    expect(vp.scale).toBe(1); // content smaller than viewport → capped at 1
    expect(vp.tx).toBe(450);
    expect(vp.ty).toBe(450);
  });

  it('fitToView scales down large content to fit and clamps to MIN_SCALE', () => {
    const vp = fitToView(100000, 100000, 500, 500, 0);
    expect(vp.scale).toBe(MIN_SCALE);
  });

  it('zoomAt keeps the world point under the cursor fixed', () => {
    const start = { scale: 1, tx: 0, ty: 0 };
    const cx = 300;
    const cy = 200;
    const worldBefore = { x: (cx - start.tx) / start.scale, y: (cy - start.ty) / start.scale };
    const after = zoomAt(start, cx, cy, 1.5);
    const worldAfter = { x: (cx - after.tx) / after.scale, y: (cy - after.ty) / after.scale };
    expect(after.scale).toBeCloseTo(1.5, 5);
    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 5);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 5);
  });

  it('clampViewport centers content smaller than the viewport', () => {
    const vp = clampViewport({ scale: 1, tx: 9999, ty: -9999 }, 200, 200, 1000, 1000, 80);
    expect(vp.tx).toBe(400);
    expect(vp.ty).toBe(400);
  });

  it('clampViewport bounds panning of content larger than the viewport', () => {
    const vp = clampViewport({ scale: 1, tx: 5000, ty: 5000 }, 4000, 4000, 800, 800, 80);
    expect(vp.tx).toBeLessThanOrEqual(80);
    expect(vp.ty).toBeLessThanOrEqual(80);
  });
});
