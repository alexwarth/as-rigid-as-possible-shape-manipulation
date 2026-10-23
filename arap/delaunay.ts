// Bowyer-Watson Delaunay triangulation plus constraint-edge recovery.
// O(n²), which is fine for the few hundred points a shape mesh needs.

import type { Triangle, Vec2 } from './types.ts';

interface Tri { a: number; b: number; c: number; ux: number; uy: number; r2: number }

/**
 * Delaunay triangulation of `points`. Returns index triples with consistent
 * orientation (counter-clockwise in y-up, clockwise in y-down coordinates).
 */
export function delaunayTriangulate(points: Vec2[]): Triangle[] {
  const n = points.length;
  if (n < 3) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const dmax = Math.max(maxX - minX, maxY - minY) || 1;
  const midx = (minX + maxX) / 2, midy = (minY + maxY) / 2;
  const pts: Vec2[] = points.map((p) => [p[0], p[1]]);
  // Super-triangle that comfortably contains every input point.
  pts.push([midx - 30 * dmax, midy - dmax], [midx, midy + 30 * dmax], [midx + 30 * dmax, midy - dmax]);
  const N = pts.length;

  function makeTri(a: number, b: number, c: number): Tri {
    const [ax, ay] = pts[a], [bx, by] = pts[b], [cx, cy] = pts[c];
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    let ux: number, uy: number, r2: number;
    if (Math.abs(d) < 1e-12) {
      ux = (ax + bx + cx) / 3; uy = (ay + by + cy) / 3; r2 = Infinity;
    } else {
      const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
      ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
      uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
      r2 = (ax - ux) ** 2 + (ay - uy) ** 2;
    }
    return { a, b, c, ux, uy, r2 };
  }

  let tris: Tri[] = [makeTri(N - 3, N - 2, N - 1)];
  const edgeMap = new Map<number, { u: number; v: number; count: number }>();
  for (let i = 0; i < n; i++) {
    const [px, py] = pts[i];
    const keep: Tri[] = [];
    edgeMap.clear();
    for (const t of tris) {
      const dx = t.ux - px, dy = t.uy - py;
      if (dx * dx + dy * dy < t.r2) {
        // Triangle is "bad": its circumcircle contains the new point.
        for (const [u, v] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]] as const) {
          const key = u < v ? u * N + v : v * N + u;
          const e = edgeMap.get(key);
          if (e) e.count++; else edgeMap.set(key, { u, v, count: 1 });
        }
      } else keep.push(t);
    }
    // Edges used by exactly one bad triangle form the cavity boundary.
    for (const e of edgeMap.values()) if (e.count === 1) keep.push(makeTri(e.u, e.v, i));
    tris = keep;
  }
  return tris.filter((t) => t.a < n && t.b < n && t.c < n).map((t) => [t.a, t.b, t.c] as Triangle);
}

/**
 * Constrained Delaunay triangulation: a Delaunay triangulation in which every
 * edge in `constraints` ([i, j] pairs) is guaranteed to appear. Missing
 * constraint edges are recovered by flipping the edges that cross them
 * (Sloan 1993). Used to make sure a shape's silhouette is part of its mesh.
 */
export function constrainedDelaunayTriangulate(points: Vec2[], constraints: [number, number][]): Triangle[] {
  const tris = delaunayTriangulate(points).map((t) => ccw(points, t));
  const key = (a: number, b: number) => (a < b ? a * 1e6 + b : b * 1e6 + a);
  // edge key -> set of triangle indices using it
  const edgeTris = new Map<number, Set<number>>();
  const addTri = (ti: number) => {
    const t = tris[ti];
    for (let r = 0; r < 3; r++) {
      const k = key(t[r], t[(r + 1) % 3]);
      let s = edgeTris.get(k);
      if (!s) edgeTris.set(k, (s = new Set()));
      s.add(ti);
    }
  };
  const removeTri = (ti: number) => {
    const t = tris[ti];
    for (let r = 0; r < 3; r++) edgeTris.get(key(t[r], t[(r + 1) % 3]))?.delete(ti);
  };
  tris.forEach((_, i) => addTri(i));

  const orient = (a: Vec2, b: Vec2, c: Vec2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const properlyCross = (a: Vec2, b: Vec2, c: Vec2, d: Vec2) =>
    orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0;

  for (const [u, v] of constraints) {
    if (edgeTris.has(key(u, v))) continue;
    const pu = points[u], pv = points[v];
    // Collect the edges that cross the missing constraint.
    const queue: [number, number][] = [];
    for (const [k, set] of edgeTris) {
      if (set.size !== 2) continue;
      const a = Math.floor(k / 1e6), b = k % 1e6;
      if (a === u || a === v || b === u || b === v) continue;
      if (properlyCross(pu, pv, points[a], points[b])) queue.push([a, b]);
    }
    let guard = queue.length * queue.length + 100;
    while (queue.length && guard-- > 0) {
      const [a, b] = queue.shift()!;
      const set = edgeTris.get(key(a, b));
      if (!set || set.size !== 2) continue;
      const [t1, t2] = [...set];
      const r = tris[t1].find((x) => x !== a && x !== b)!;
      const s = tris[t2].find((x) => x !== a && x !== b)!;
      // Flipping is only valid when the quad a-r-b-s is convex, i.e. the
      // diagonals ab and rs cross each other.
      if (!properlyCross(points[a], points[b], points[r], points[s])) { queue.push([a, b]); continue; }
      removeTri(t1); removeTri(t2);
      tris[t1] = ccw(points, [a, r, s]);
      tris[t2] = ccw(points, [b, s, r]);
      addTri(t1); addTri(t2);
      if (r !== u && r !== v && s !== u && s !== v && properlyCross(pu, pv, points[r], points[s])) queue.push([r, s]);
    }
  }
  return tris;
}

function ccw(points: Vec2[], t: Triangle): Triangle {
  const [a, b, c] = t;
  const area = (points[b][0] - points[a][0]) * (points[c][1] - points[a][1]) - (points[b][1] - points[a][1]) * (points[c][0] - points[a][0]);
  return area < 0 ? [a, c, b] : [a, b, c];
}
