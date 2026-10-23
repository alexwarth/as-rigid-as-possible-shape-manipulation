// EXTENSION (not part of the paper's algorithm): depth ordering of
// overlapping parts.
//
// The two-step solve produces flat 2D positions, so when a deformed shape
// folds over itself nothing says which part is in front. Section 5.1 of the
// paper discusses this ("collision detection and depth adjustment") and
// handles it by detecting self-intersections at runtime and assigning depths
// to the overlapping regions, starting from a predefined order; it leaves the
// general ordering question open. This module is a practical take on that:
//
//   1. Find pairs of triangles that overlap in the deformed configuration and
//      are not neighbors in the rest mesh (neighbors may legitimately overlap
//      a little when squashed, so they are ignored).
//   2. Partition the triangles involved into "sheets": two-color each
//      connected component of the overlap graph (overlapping triangles must
//      be on different sheets), then merge the sides of nearby components by
//      rest-space proximity. Components that cannot be two-colored (three or
//      more parts piled up) fall back to a seed-based split.
//   3. Order the sheets, back to front. An order established earlier is kept;
//      a sheet moves in front of another only when a handle near it moved
//      clearly more recently and the other sheet is not held by a finger. New
//      relations are decided by recency, then by closeness to a handle.
//
// Triangles that overlap nothing are drawn first, in their natural order.

import type { Triangle } from './types.ts';

export interface OverlapOptions {
  /**
   * Rest-space centroid distance below which an overlapping pair is ignored
   * (pairs sharing a vertex always are). Default: the mean edge length.
   */
  minRestDistance?: number;
  /**
   * Rest-space distance within which the sides of separate overlap
   * components are merged into the same sheets. Default: 3 x mean edge length.
   */
  mergeDistance?: number;
  /** Milliseconds within which handle moves count as simultaneous. Default 250. */
  recencyTolerance?: number;
}

/** A handle as seen by the sorter: which vertex, when it last moved, and whether a finger is still on it. */
export interface Handle {
  vertex: number;
  time: number;
  active?: boolean;
}

/** A set of triangles drawn as one layer. */
export interface Sheet {
  triangles: number[];
  /** 1 = furthest back; triangles that overlap nothing have depth 0. */
  depth: number;
  /** Last-move time of the nearest handle. */
  time: number;
  /** Whether that handle is held by a finger. */
  active: boolean;
  /** Rest-space distance to the nearest handle. */
  dist: number;
  prevDepth: number;
  minIndex: number;
}

export interface OverlapResult {
  /** Triangle indices in back-to-front drawing order. */
  order: number[];
  sheets: Sheet[];
}

export class OverlapDepthSorter {
  readonly triangles: Triangle[];
  readonly meanEdge: number;
  readonly minRestDistance: number;
  readonly mergeDistance: number;
  readonly recencyTolerance: number;
  /** Per-triangle depth from the last update (0 = not overlapping). */
  readonly depth: Float64Array;
  sheets: Sheet[] = [];
  private readonly rest: ArrayLike<number>;
  private readonly restCentroid: Float64Array;

  constructor(rest: ArrayLike<number>, triangles: Triangle[], opts: OverlapOptions = {}) {
    this.triangles = triangles;
    const m = triangles.length;
    this.restCentroid = new Float64Array(2 * m);
    let edgeSum = 0;
    triangles.forEach(([a, b, c], t) => {
      this.restCentroid[2 * t] = (rest[2 * a] + rest[2 * b] + rest[2 * c]) / 3;
      this.restCentroid[2 * t + 1] = (rest[2 * a + 1] + rest[2 * b + 1] + rest[2 * c + 1]) / 3;
      edgeSum += Math.hypot(rest[2 * b] - rest[2 * a], rest[2 * b + 1] - rest[2 * a + 1]);
    });
    this.rest = rest;
    this.meanEdge = edgeSum / Math.max(m, 1);
    this.minRestDistance = opts.minRestDistance ?? this.meanEdge;
    this.mergeDistance = opts.mergeDistance ?? 3 * this.meanEdge;
    this.recencyTolerance = opts.recencyTolerance ?? 250;
    this.depth = new Float64Array(m);
  }

  /** Forgets the established order (e.g. when the shape is reset). */
  reset(): void {
    this.depth.fill(0);
    this.sheets = [];
  }

  /**
   * @param pos  deformed vertex positions, flat
   * @param handles  current handles
   */
  update(pos: ArrayLike<number>, handles: Handle[] = []): OverlapResult {
    const { triangles } = this;
    const m = triangles.length;
    const pairs = this.overlappingPairs(pos);
    if (pairs.length === 0) {
      this.reset();
      return { order: Array.from({ length: m }, (_, i) => i), sheets: [] };
    }

    // -- 2. Partition the involved triangles into sheets.
    const rc = this.restCentroid;
    const restDist = (s: number, t: number) => Math.hypot(rc[2 * s] - rc[2 * t], rc[2 * s + 1] - rc[2 * t + 1]);
    const adj = new Map<number, number[]>();
    const neighbors = (t: number) => { let l = adj.get(t); if (!l) adj.set(t, (l = [])); return l; };
    for (const [a, b] of pairs) { neighbors(a).push(b); neighbors(b).push(a); }
    // Two-color each connected component of the overlap graph.
    const color = new Map<number, number>();
    const components: number[][][] = []; // each: sides (arrays of triangles) that must be on different sheets
    for (const start of adj.keys()) {
      if (color.has(start)) continue;
      const comp = [start], queue = [start];
      color.set(start, 0);
      let bipartite = true;
      while (queue.length) {
        const t = queue.shift()!;
        for (const u of adj.get(t)!) {
          if (!color.has(u)) { color.set(u, 1 - color.get(t)!); comp.push(u); queue.push(u); }
          else if (color.get(u) === color.get(t)) bipartite = false;
        }
      }
      if (bipartite) {
        components.push([comp.filter((t) => color.get(t) === 0), comp.filter((t) => color.get(t) === 1)]);
      } else {
        // Three or more parts piled up: split by proximity to seeds, adding
        // seeds until no overlapping pair shares a side.
        const inComp = new Set(comp);
        const cpairs = pairs.filter(([a, b]) => inComp.has(a) && inComp.has(b));
        let farthest = cpairs[0], far = -1;
        for (const p of cpairs) { const d = restDist(p[0], p[1]); if (d > far) { far = d; farthest = p; } }
        const seeds = [farthest[0], farthest[1]];
        const sideOf = new Map<number, number>();
        for (let iter = 0; iter < 8; iter++) {
          for (const t of comp) {
            let best = 0, bd = Infinity;
            seeds.forEach((sd, i) => { const d = restDist(sd, t); if (d < bd) { bd = d; best = i; } });
            sideOf.set(t, best);
          }
          const bad = cpairs.find(([a, b]) => sideOf.get(a) === sideOf.get(b));
          if (!bad) break;
          const sd = seeds[sideOf.get(bad[0])!];
          seeds.push(restDist(sd, bad[0]) > restDist(sd, bad[1]) ? bad[0] : bad[1]);
        }
        const sides: number[][] = seeds.map(() => []);
        for (const t of comp) sides[sideOf.get(t)!].push(t);
        components.push(sides.filter((sd) => sd.length > 0));
      }
    }
    // Merge the sides of nearby components into shared sheets, so e.g. the
    // triangles at an arm's root and the main part of the arm end up on the
    // same sheet even if they overlap the other part in separate places.
    components.sort((a, b) => b.flat().length - a.flat().length);
    const sheetTris: number[][] = [];
    const minDist = (P: number[], S: number[]) => {
      let best = Infinity;
      for (const p of P) for (const q of S) { const d = restDist(p, q); if (d < best) best = d; }
      return best;
    };
    for (const sides of components) {
      const used = new Set<number>();
      for (const side of sides) {
        let best = -1, bd = this.mergeDistance;
        sheetTris.forEach((S, i) => { if (used.has(i)) return; const d = minDist(side, S); if (d < bd) { bd = d; best = i; } });
        if (best < 0) { best = sheetTris.length; sheetTris.push([]); }
        used.add(best);
        sheetTris[best].push(...side);
      }
    }
    const sheets: Sheet[] = sheetTris.map((tris) => ({ triangles: tris, depth: 0, time: -Infinity, active: false, dist: Infinity, prevDepth: 0, minIndex: Math.min(...tris) }));

    // -- 3. Score each sheet: nearest handle (in rest space) with its recency,
    //       and the sheet's depth in the previous frame (ignoring triangles
    //       that were not overlapping then).
    for (const sh of sheets) {
      let sum = 0, cnt = 0;
      for (const t of sh.triangles) {
        if (this.depth[t] > 0) { sum += this.depth[t]; cnt++; }
        for (const h of handles) {
          const hx = this.rest[2 * h.vertex], hy = this.rest[2 * h.vertex + 1];
          const d = Math.hypot(rc[2 * t] - hx, rc[2 * t + 1] - hy);
          if (d < sh.dist) { sh.dist = d; sh.time = h.time; sh.active = !!h.active; }
        }
      }
      sh.prevDepth = cnt ? sum / cnt : 0;
    }
    const tol = this.recencyTolerance;
    const newer = (a: Sheet, b: Sheet) => a.time - b.time > tol || (a.time > b.time && !isFinite(a.time - b.time));
    sheets.sort((a, b) => {
      if (a.prevDepth > 0 && b.prevDepth > 0 && a.prevDepth !== b.prevDepth) {
        // Keep the established order unless the lower sheet is clearly the one
        // being manipulated now and the upper one is not held by a finger.
        const [lo, hi] = a.prevDepth < b.prevDepth ? [a, b] : [b, a];
        if (newer(lo, hi) && !hi.active) return lo === a ? 1 : -1;
        return a.prevDepth - b.prevDepth;
      }
      if (newer(a, b)) return 1; // a more recently manipulated -> on top
      if (newer(b, a)) return -1;
      if (a.dist !== b.dist) return b.dist - a.dist; // farther from any handle -> below
      return a.minIndex - b.minIndex; // deterministic fallback
    });
    this.depth.fill(0);
    sheets.forEach((sh, i) => { sh.depth = i + 1; for (const t of sh.triangles) this.depth[t] = i + 1; });
    this.sheets = sheets;

    const order = Array.from({ length: m }, (_, i) => i);
    order.sort((a, b) => this.depth[a] - this.depth[b]); // stable: natural order within a depth
    return { order, sheets: this.sheets };
  }

  /** Pairs of overlapping triangles that are not neighbors in the rest mesh. */
  private overlappingPairs(pos: ArrayLike<number>): [number, number][] {
    const { triangles } = this;
    const m = triangles.length;
    // Bounding boxes and a uniform grid for the broad phase.
    const bb = new Float64Array(4 * m);
    let cell = 0;
    triangles.forEach(([a, b, c], t) => {
      const xs = [pos[2 * a], pos[2 * b], pos[2 * c]], ys = [pos[2 * a + 1], pos[2 * b + 1], pos[2 * c + 1]];
      bb[4 * t] = Math.min(...xs); bb[4 * t + 1] = Math.min(...ys); bb[4 * t + 2] = Math.max(...xs); bb[4 * t + 3] = Math.max(...ys);
      cell = Math.max(cell, bb[4 * t + 2] - bb[4 * t], bb[4 * t + 3] - bb[4 * t + 1]);
    });
    cell = cell || 1;
    const grid = new Map<number, number[]>();
    for (let t = 0; t < m; t++) {
      const x0 = Math.floor(bb[4 * t] / cell), x1 = Math.floor(bb[4 * t + 2] / cell);
      const y0 = Math.floor(bb[4 * t + 1] / cell), y1 = Math.floor(bb[4 * t + 3] / cell);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const k = (x * 73856093) ^ (y * 19349663);
        let list = grid.get(k);
        if (!list) grid.set(k, (list = []));
        list.push(t);
      }
    }
    const tested = new Set<number>();
    const pairs: [number, number][] = [];
    const rc = this.restCentroid, minD2 = this.minRestDistance ** 2;
    for (const list of grid.values()) {
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const s = Math.min(list[i], list[j]), t = Math.max(list[i], list[j]);
        const key = s * m + t;
        if (tested.has(key)) continue;
        tested.add(key);
        if (bb[4 * s + 2] < bb[4 * t] || bb[4 * t + 2] < bb[4 * s] || bb[4 * s + 3] < bb[4 * t + 1] || bb[4 * t + 3] < bb[4 * s + 1]) continue;
        const dx = rc[2 * s] - rc[2 * t], dy = rc[2 * s + 1] - rc[2 * t + 1];
        if (dx * dx + dy * dy < minD2) continue; // neighbors in the rest mesh
        const ta = triangles[s], tb = triangles[t];
        if (ta.includes(tb[0]) || ta.includes(tb[1]) || ta.includes(tb[2])) continue; // share a vertex
        if (trianglesOverlap(pos, ta, tb)) pairs.push([s, t]);
      }
    }
    return pairs;
  }
}

/** Separating-axis test for two triangles; touching along an edge does not count. */
export function trianglesOverlap(pos: ArrayLike<number>, ta: Triangle, tb: Triangle, eps = 0.5): boolean {
  const corners = (t: Triangle): [number, number][] => [[pos[2 * t[0]], pos[2 * t[0] + 1]], [pos[2 * t[1]], pos[2 * t[1] + 1]], [pos[2 * t[2]], pos[2 * t[2] + 1]]];
  const A = corners(ta), B = corners(tb);
  for (const tri of [A, B]) {
    for (let i = 0; i < 3; i++) {
      const [x0, y0] = tri[i], [x1, y1] = tri[(i + 1) % 3];
      const nx = y0 - y1, ny = x1 - x0, len = Math.hypot(nx, ny) || 1;
      let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
      for (const [x, y] of A) { const p = (x * nx + y * ny) / len; if (p < aMin) aMin = p; if (p > aMax) aMax = p; }
      for (const [x, y] of B) { const p = (x * nx + y * ny) / len; if (p < bMin) bMin = p; if (p > bMax) bMax = p; }
      if (aMax <= bMin + eps || bMax <= aMin + eps) return false;
    }
  }
  return true;
}
