// Builds a triangle mesh ("rest shape") from a binary mask, following
// Section 3 of the paper: trace the silhouette with marching squares, then
// fill the interior with near-equilateral triangles of similar size.
//
// The paper uses a constrained Delaunay triangulation refined by a particle
// system. Here we get a similar mesh more simply: evenly resample the traced
// outline, drop a hexagonal lattice of points inside it, Delaunay-triangulate
// everything (constraining the outline edges), and discard the triangles
// that fall outside the outline polygon.

import { constrainedDelaunayTriangulate } from './delaunay.ts';
import type { Triangle, Vec2 } from './types.ts';

export interface MeshOptions {
  /** Target edge length in mask pixels. Default 24. */
  spacing?: number;
}

export interface ShapeMesh {
  /** Rest positions, flat [x0, y0, x1, y1, ...] in mask-pixel coordinates. */
  vertices: Float64Array;
  triangles: Triangle[];
  /** 1 for vertices that lie on the silhouette. */
  isBoundary: Uint8Array;
  /** Bit r of boundaryEdges[t] is set when edge (triangles[t][r], triangles[t][(r+1)%3]) lies on the silhouette. */
  boundaryEdges: Uint8Array;
  /**
   * The traced outline between neighboring silhouette vertices, keyed by
   * a * n + b for the directed edge a -> b (both directions are stored), as a
   * flat [x0, y0, x1, y1, ...] array. Lets a renderer clip to the real
   * silhouette instead of the straight mesh edge.
   */
  boundaryDetail: Map<number, Float64Array>;
  /** The resampled silhouette loops the mesh was built from. */
  contours: Vec2[][];
}

/**
 * @param mask  width*height, nonzero = inside the shape
 */
export function meshFromMask(mask: ArrayLike<number>, width: number, height: number, opts: MeshOptions = {}): ShapeMesh {
  const spacing = opts.spacing ?? 24;
  const contours = traceContours(mask, width, height);
  const resampled = contours
    .map((loop) => resampleLoop(loop, spacing * 0.85))
    .filter((r) => r.points.length >= 6);
  if (resampled.length === 0) throw new Error('No shape found in mask');
  const loops = resampled.map((r) => r.points);

  const points: Vec2[] = [];
  // Remember which boundary points are neighbors along their loop: the edge
  // between them is part of the silhouette and must survive filtering even
  // where (at a concave corner) it lies slightly outside the mask.
  const constraints: [number, number][] = [];
  const edgeDetail = new Map<number, { from: number; pts: Vec2[] }>(); // the traced outline between the two points
  const edgeKey = (a: number, b: number) => (a < b ? a * 1e6 + b : b * 1e6 + a);
  for (const { points: loop, details } of resampled) {
    const base = points.length;
    for (const p of loop) points.push(p);
    for (let i = 0; i < loop.length; i++) {
      const a = base + i, b = base + ((i + 1) % loop.length);
      constraints.push([a, b]);
      edgeDetail.set(edgeKey(a, b), { from: a, pts: details[i] });
    }
  }
  const nBoundary = points.length;

  // Interior points on a hexagonal lattice, kept away from the outline so we
  // don't get slivers. A deterministic jitter breaks the exact co-circularity
  // of a perfect lattice, which Bowyer-Watson handles poorly.
  const inside = (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    return xi >= 0 && yi >= 0 && xi < width && yi < height && mask[yi * width + xi] !== 0;
  };
  const rowH = spacing * (Math.sqrt(3) / 2);
  const minDist = spacing * 0.5;
  let row = 0;
  for (let y = spacing * 0.5; y < height; y += rowH, row++) {
    const xOff = row % 2 ? spacing / 2 : 0;
    let col = 0;
    for (let x = xOff + spacing * 0.5; x < width; x += spacing, col++) {
      const jx = x + (hash01(row, col, 1) - 0.5) * spacing * 0.15;
      const jy = y + (hash01(row, col, 2) - 0.5) * spacing * 0.15;
      if (!inside(jx, jy)) continue;
      if (distanceToLoops(jx, jy, loops) < minDist) continue;
      points.push([jx, jy]);
    }
  }

  // A constrained triangulation guarantees the silhouette edges are in the mesh.
  let triangles = constrainedDelaunayTriangulate(points, constraints);

  // Keep only triangles inside the shape. The outline edges are constraints
  // of the triangulation, so no triangle edge crosses the outline polygon and
  // every triangle is either entirely inside it or entirely outside: testing
  // the centroid against the polygon (even-odd over all loops, so holes work)
  // is exact. This keeps thin features such as fingertips, which a pixel-mask
  // test would drop.
  triangles = triangles.filter(([a, b, c]) => {
    const [ax, ay] = points[a], [bx, by] = points[b], [cx, cy] = points[c];
    return insidePolygon((ax + bx + cx) / 3, (ay + by + cy) / 3, loops);
  });

  // Keep the largest connected component and drop unused vertices. The
  // surviving vertices are ordered by row (y, then x) so that the deformer's
  // matrices are banded, which makes factoring them much cheaper.
  triangles = largestComponent(triangles, points.length);
  const used = new Set<number>();
  for (const tri of triangles) for (const v of tri) used.add(v);
  const order = [...used].sort((a, b) => points[a][1] - points[b][1] || points[a][0] - points[b][0]);
  const remap = new Int32Array(points.length).fill(-1);
  const vertices: number[] = [];
  const isBoundaryList: number[] = [];
  order.forEach((v, i) => {
    remap[v] = i;
    vertices.push(points[v][0], points[v][1]);
    isBoundaryList.push(v < nBoundary ? 1 : 0);
  });
  for (const tri of triangles) for (let i = 0; i < 3; i++) tri[i] = remap[tri[i]];
  // Edges used by a single triangle form the mesh boundary.
  const edgeUse = new Map<number, number>();
  for (const [a, b, c] of triangles) for (const [i, j] of [[a, b], [b, c], [c, a]]) edgeUse.set(edgeKey(i, j), (edgeUse.get(edgeKey(i, j)) ?? 0) + 1);
  const boundaryEdges = new Uint8Array(triangles.length);
  triangles.forEach((t, ti) => {
    for (let r = 0; r < 3; r++) if (edgeUse.get(edgeKey(t[r], t[(r + 1) % 3])) === 1) boundaryEdges[ti] |= 1 << r;
  });
  const nV = vertices.length / 2;
  const boundaryDetail = new Map<number, Float64Array>();
  for (const [k, { from, pts }] of edgeDetail) {
    const a0 = Math.floor(k / 1e6), b0 = k % 1e6;
    if (remap[a0] < 0 || remap[b0] < 0 || pts.length === 0) continue;
    const f = remap[from], t = remap[from === a0 ? b0 : a0];
    const flat = new Float64Array(pts.length * 2), rev = new Float64Array(pts.length * 2);
    pts.forEach(([x, y], i) => {
      flat[2 * i] = x; flat[2 * i + 1] = y;
      rev[2 * (pts.length - 1 - i)] = x; rev[2 * (pts.length - 1 - i) + 1] = y;
    });
    boundaryDetail.set(f * nV + t, flat);
    boundaryDetail.set(t * nV + f, rev);
  }
  return {
    vertices: Float64Array.from(vertices),
    triangles,
    isBoundary: Uint8Array.from(isBoundaryList),
    boundaryEdges,
    boundaryDetail,
    contours: loops,
  };
}

function hash01(a: number, b: number, c: number): number {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Even-odd point-in-polygon test over a set of closed loops. */
function insidePolygon(x: number, y: number, loops: Vec2[][]): boolean {
  let inside = false;
  for (const loop of loops) {
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const [xi, yi] = loop[i], [xj, yj] = loop[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function distanceToLoops(x: number, y: number, loops: Vec2[][]): number {
  let best = Infinity;
  for (const loop of loops) {
    for (let i = 0, n = loop.length; i < n; i++) {
      const [ax, ay] = loop[i], [bx, by] = loop[(i + 1) % n];
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy || 1;
      let t = ((x - ax) * dx + (y - ay) * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + t * dx - x, py = ay + t * dy - y;
      const d2 = px * px + py * py;
      if (d2 < best) best = d2;
    }
  }
  return Math.sqrt(best);
}

/** Marching squares on the mask; returns closed loops of [x, y] points. */
export function traceContours(mask: ArrayLike<number>, width: number, height: number): Vec2[][] {
  const M = (x: number, y: number) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : mask[y * width + x] ? 1 : 0);
  // Segment table indexed by (tl<<3 | tr<<2 | br<<1 | bl). Edge ids: T, R, B, L.
  const T = 0, R = 1, B = 2, L = 3;
  const table: [number, number][][] = [
    [], [[L, B]], [[B, R]], [[L, R]],
    [[T, R]], [[L, T], [B, R]], [[T, B]], [[L, T]],
    [[T, L]], [[T, B]], [[T, R], [B, L]], [[T, R]],
    [[L, R]], [[B, R]], [[L, B]], [],
  ];
  const adj = new Map<number, number[]>(); // point key -> neighbor keys
  const coords = new Map<number, Vec2>(); // key -> [x, y]
  const key = (x: number, y: number) => Math.round(x * 2) * 4 * (width + 2) + Math.round(y * 2);
  const edgePoint = (i: number, j: number, e: number): Vec2 => {
    // cell (i,j) spans pixel centers (i,j)..(i+1,j+1); convert to pixel-corner coords (+0.5)
    switch (e) {
      case T: return [i + 1, j + 0.5];
      case R: return [i + 1.5, j + 1];
      case B: return [i + 1, j + 1.5];
      default: return [i + 0.5, j + 1];
    }
  };
  const neighbors = (k: number) => { let l = adj.get(k); if (!l) adj.set(k, (l = [])); return l; };
  for (let j = -1; j < height; j++) {
    for (let i = -1; i < width; i++) {
      const idx = (M(i, j) << 3) | (M(i + 1, j) << 2) | (M(i + 1, j + 1) << 1) | M(i, j + 1);
      for (const [e0, e1] of table[idx]) {
        const p0 = edgePoint(i, j, e0), p1 = edgePoint(i, j, e1);
        const k0 = key(p0[0], p0[1]), k1 = key(p1[0], p1[1]);
        coords.set(k0, p0); coords.set(k1, p1);
        neighbors(k0).push(k1);
        neighbors(k1).push(k0);
      }
    }
  }
  const visited = new Set<number>();
  const loops: Vec2[][] = [];
  for (const start of adj.keys()) {
    if (visited.has(start)) continue;
    const loop: Vec2[] = [];
    let prev = -1, cur: number | undefined = start;
    while (cur !== undefined && !visited.has(cur)) {
      visited.add(cur);
      loop.push(coords.get(cur)!);
      const nb: number[] = adj.get(cur)!;
      const next: number | undefined = nb[0] !== prev ? nb[0] : nb[1];
      prev = cur; cur = next;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/**
 * Resamples a closed polyline at (roughly) uniform arc-length steps. Returns
 * the sample points and, for each sample, the original polyline vertices
 * that lie between it and the next sample.
 */
function resampleLoop(loop: Vec2[], step: number): { points: Vec2[]; details: Vec2[][] } {
  const n = loop.length;
  let total = 0;
  const segLen = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const [ax, ay] = loop[i], [bx, by] = loop[(i + 1) % n];
    segLen[i] = Math.hypot(bx - ax, by - ay);
    total += segLen[i];
  }
  const count = Math.max(3, Math.round(total / step));
  const actualStep = total / count;
  const points: Vec2[] = [], segs: number[] = [];
  let target = 0, acc = 0, seg = 0;
  for (let k = 0; k < count; k++) {
    while (seg < n && acc + segLen[seg] < target) { acc += segLen[seg]; seg++; }
    if (seg >= n) break;
    const t = segLen[seg] > 0 ? (target - acc) / segLen[seg] : 0;
    const [ax, ay] = loop[seg], [bx, by] = loop[(seg + 1) % n];
    points.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
    segs.push(seg);
    target += actualStep;
  }
  const details = points.map((_, k) => {
    const from = segs[k] + 1, to = segs[(k + 1) % points.length]; // raw vertex range (inclusive), wrapping
    const pts: Vec2[] = [];
    const span = k + 1 < points.length ? to - from + 1 : to - from + 1 + n;
    for (let i = 0; i < span; i++) pts.push(loop[(from + i) % n]);
    return pts;
  });
  return { points, details };
}

function largestComponent(triangles: Triangle[], nPoints: number): Triangle[] {
  const parent = new Int32Array(nPoints);
  for (let i = 0; i < nPoints; i++) parent[i] = i;
  const find = (a: number) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a: number, b: number) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  for (const [a, b, c] of triangles) { union(a, b); union(b, c); }
  const count = new Map<number, number>();
  for (const [a] of triangles) { const r = find(a); count.set(r, (count.get(r) ?? 0) + 1); }
  let bestRoot = -1, best = 0;
  for (const [r, c] of count) if (c > best) { best = c; bestRoot = r; }
  return triangles.filter(([a]) => find(a) === bestRoot);
}
