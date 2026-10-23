// As-Rigid-As-Possible Shape Manipulation
// Igarashi, Moscovich, Hughes — SIGGRAPH 2005
//
// A faithful, dependency-free implementation of the paper's two-step
// closed-form algorithm (Section 4):
//
//   1. Registration   (constructor)   — build G and H from the rest shape.
//   2. Compilation    (setHandles)    — partition G and H by free/constrained
//                                       vertices and factor the free blocks.
//   3. Manipulation   (solve)         — step one: scale-free construction;
//                                       step two: rigid fit + scale adjustment.
//
// Vertices are flat Float64Arrays [x0, y0, x1, y1, ...].

import { CholeskySolver } from './linalg.ts';
import { toFlat, type Points, type Triangle } from './types.ts';

export interface DeformerOptions {
  /** Per-triangle rigidity weight (Section 5.2); default 1 for every triangle. */
  weights?: ArrayLike<number>;
}

export interface SolveOptions {
  /** Run step two (Section 4.2). Default true; false returns the step-one result. */
  scaleAdjust?: boolean;
}

export interface SolveResult {
  /** Final vertex positions, flat [x0, y0, ...]. */
  vertices: Float64Array;
  /** The step-one (scale-free) result. */
  intermediate: Float64Array;
  /** The rigidly fitted triangle for every triangle, 6 numbers each (Figure 3b); null when step two was skipped. */
  fitted: Float64Array | null;
}

export class ArapDeformer {
  /** Rest positions, flat. */
  readonly rest: Float64Array;
  /** Number of vertices. */
  readonly n: number;
  readonly triangles: Triangle[];
  readonly weights: Float64Array;
  /** Constrained vertex indices, in the order given to setHandles. */
  handles: number[] = [];
  /** Free (unconstrained) vertex indices. */
  free: number[] = [];

  private G!: Float64Array; // step-one error: E1 = v'ᵀ G v'   (eq. 5), 2n x 2n
  private H!: Float64Array; // step-two error, per component (eq. 13), n x n
  private local!: Float64Array; // {x01, y01} per triangle and rotation (eq. 1)
  private G01: Float64Array | null = null;
  private H01: Float64Array | null = null;
  private solver1: CholeskySolver | null = null;
  private solver2: CholeskySolver | null = null;
  private rhs1 = new Float64Array(0);
  private u1 = new Float64Array(0);
  private rhsX = new Float64Array(0);
  private rhsY = new Float64Array(0);
  private ux = new Float64Array(0);
  private uy = new Float64Array(0);

  constructor(restVertices: Points, triangles: Triangle[], opts: DeformerOptions = {}) {
    this.rest = toFlat(restVertices);
    this.n = this.rest.length / 2;
    this.triangles = triangles.map((t) => [t[0], t[1], t[2]] as Triangle);
    const m = this.triangles.length;
    this.weights = opts.weights ? Float64Array.from(opts.weights) : new Float64Array(m).fill(1);
    this.register();
  }

  // ---- 1. Registration ----------------------------------------------------

  private register(): void {
    const { rest, n, triangles, weights } = this;
    const N = 2 * n;
    const G = new Float64Array(N * N);
    const H = new Float64Array(n * n);
    // Local coordinates {x01, y01} of the third vertex for each of the three
    // cyclic rotations of each triangle (eq. 1).
    this.local = new Float64Array(triangles.length * 6);
    const idx = new Int32Array(6);
    const rowX = new Float64Array(6), rowY = new Float64Array(6);
    triangles.forEach((tri, t) => {
      const w = weights[t];
      for (let r = 0; r < 3; r++) {
        const i = tri[r], j = tri[(r + 1) % 3], k = tri[(r + 2) % 3];
        const dx = rest[2 * j] - rest[2 * i], dy = rest[2 * j + 1] - rest[2 * i + 1];
        const px = rest[2 * k] - rest[2 * i], py = rest[2 * k + 1] - rest[2 * i + 1];
        const len2 = dx * dx + dy * dy;
        // v_k = v_i + x (v_j - v_i) + y R90 (v_j - v_i),  R90 (dx,dy) = (dy, -dx)
        const x = (px * dx + py * dy) / len2;
        const y = (px * dy - py * dx) / len2;
        this.local[t * 6 + r * 2] = x;
        this.local[t * 6 + r * 2 + 1] = y;
        // Error for v_k (eq. 3) as a linear map of (v_i, v_j, v_k):
        //   e = v_k' - [v_i' + x (v_j' - v_i') + y R90 (v_j' - v_i')]
        idx[0] = 2 * i; idx[1] = 2 * i + 1; idx[2] = 2 * j; idx[3] = 2 * j + 1; idx[4] = 2 * k; idx[5] = 2 * k + 1;
        rowX[0] = x - 1; rowX[1] = y;     rowX[2] = -x; rowX[3] = -y; rowX[4] = 1; rowX[5] = 0;
        rowY[0] = -y;    rowY[1] = x - 1; rowY[2] = y;  rowY[3] = -x; rowY[4] = 0; rowY[5] = 1;
        for (let a = 0; a < 6; a++) {
          const ra = idx[a] * N;
          for (let b = 0; b < 6; b++) G[ra + idx[b]] += w * (rowX[a] * rowX[b] + rowY[a] * rowY[b]);
        }
      }
      // Step-two error is per edge (eq. 12): Σ |(v_j'' - v_i'') - (f_j - f_i)|²
      for (let r = 0; r < 3; r++) {
        const i = tri[r], j = tri[(r + 1) % 3];
        H[i * n + i] += w; H[j * n + j] += w; H[i * n + j] -= w; H[j * n + i] -= w;
      }
    });
    this.G = G;
    this.H = H;
  }

  // ---- 2. Compilation -----------------------------------------------------

  /**
   * Declares which vertices are constrained ("handles"). Must be called
   * whenever the set of handles changes; it re-factors the systems.
   */
  setHandles(handleIndices: number[]): void {
    const { n, G, H } = this;
    const N = 2 * n;
    const handles = Array.from(new Set(handleIndices));
    this.handles = handles;
    const isHandle = new Uint8Array(n);
    for (const h of handles) isHandle[h] = 1;
    const free: number[] = [];
    for (let i = 0; i < n; i++) if (!isHandle[i]) free.push(i);
    this.free = free;
    const m = free.length, h = handles.length;
    this.solver1 = this.solver2 = null;
    if (h < 2 || m === 0) return; // fewer than two handles: see solve()

    // G' = G00 (free block), B = G01 (free x constrained), eq. 7-8
    const M = 2 * m, Hh = 2 * h;
    const G00 = new Float64Array(M * M), G01 = new Float64Array(M * Hh);
    for (let a = 0; a < m; a++) {
      for (let c = 0; c < 2; c++) {
        const row = (2 * free[a] + c) * N, out = (2 * a + c);
        for (let b = 0; b < m; b++) {
          G00[out * M + 2 * b] = G[row + 2 * free[b]];
          G00[out * M + 2 * b + 1] = G[row + 2 * free[b] + 1];
        }
        for (let b = 0; b < h; b++) {
          G01[out * Hh + 2 * b] = G[row + 2 * handles[b]];
          G01[out * Hh + 2 * b + 1] = G[row + 2 * handles[b] + 1];
        }
      }
    }
    // H' = H00, D = H01, eq. 15-16 (same matrix for x and y)
    const H00 = new Float64Array(m * m), H01 = new Float64Array(m * h);
    for (let a = 0; a < m; a++) {
      const row = free[a] * n;
      for (let b = 0; b < m; b++) H00[a * m + b] = H[row + free[b]];
      for (let b = 0; b < h; b++) H01[a * h + b] = H[row + handles[b]];
    }
    this.G01 = G01; this.H01 = H01;
    this.solver1 = new CholeskySolver(G00, M);
    this.solver2 = new CholeskySolver(H00, m);
    this.rhs1 = new Float64Array(M); this.u1 = new Float64Array(M);
    this.rhsX = new Float64Array(m); this.rhsY = new Float64Array(m);
    this.ux = new Float64Array(m); this.uy = new Float64Array(m);
  }

  // ---- 3. Manipulation ----------------------------------------------------

  /**
   * Computes vertex positions for the given handle positions (one [x, y] per
   * handle, in the order given to setHandles).
   */
  solve(handlePositions: Points, opts: SolveOptions = {}): SolveResult {
    const scaleAdjust = opts.scaleAdjust ?? true;
    const { n, rest, handles } = this;
    const q = toFlat(handlePositions);
    const h = handles.length;
    if (h === 0) {
      const v = Float64Array.from(rest);
      return { vertices: v, intermediate: v, fitted: null };
    }
    if (h === 1 || !this.solver1 || !this.solver2 || !this.G01 || !this.H01) {
      // One handle cannot determine rotation or scale; the paper simply
      // translates the shape in this case.
      const tx = q[0] - rest[2 * handles[0]], ty = q[1] - rest[2 * handles[0] + 1];
      const v = new Float64Array(2 * n);
      for (let i = 0; i < n; i++) { v[2 * i] = rest[2 * i] + tx; v[2 * i + 1] = rest[2 * i + 1] + ty; }
      return { vertices: v, intermediate: v, fitted: null };
    }

    const { free, G01, H01, triangles, weights } = this;
    const m = free.length, M = 2 * m, Hh = 2 * h;

    // -- Step one: scale-free construction (Section 4.1): G' u = -B q
    const rhs1 = this.rhs1;
    for (let a = 0; a < M; a++) {
      let s = 0;
      const row = a * Hh;
      for (let b = 0; b < Hh; b++) s -= G01[row + b] * q[b];
      rhs1[a] = s;
    }
    const u1 = this.solver1.solve(rhs1, this.u1);
    const inter = new Float64Array(2 * n);
    for (let a = 0; a < m; a++) { inter[2 * free[a]] = u1[2 * a]; inter[2 * free[a] + 1] = u1[2 * a + 1]; }
    for (let b = 0; b < h; b++) { inter[2 * handles[b]] = q[2 * b]; inter[2 * handles[b] + 1] = q[2 * b + 1]; }
    if (!scaleAdjust) return { vertices: inter, intermediate: inter, fitted: null };

    // -- Step two (a): fit each rest triangle to its intermediate triangle
    //    with rotation + translation only (Section 4.2.1, Figure 5).
    //    The paper solves a 4x4 system for the best similarity transform and
    //    then normalizes its scale; the closed form below (least-squares
    //    rotation about the centroids) yields the same fitted triangle.
    const fitted = new Float64Array(triangles.length * 6);
    const bx = new Float64Array(n), by = new Float64Array(n);
    triangles.forEach((tri, t) => {
      const [i, j, k] = tri;
      const pcx = (rest[2 * i] + rest[2 * j] + rest[2 * k]) / 3, pcy = (rest[2 * i + 1] + rest[2 * j + 1] + rest[2 * k + 1]) / 3;
      const qcx = (inter[2 * i] + inter[2 * j] + inter[2 * k]) / 3, qcy = (inter[2 * i + 1] + inter[2 * j + 1] + inter[2 * k + 1]) / 3;
      let c = 0, s = 0;
      for (const v of tri) {
        const px = rest[2 * v] - pcx, py = rest[2 * v + 1] - pcy;
        const qx = inter[2 * v] - qcx, qy = inter[2 * v + 1] - qcy;
        c += px * qx + py * qy;
        s += qx * py - qy * px;
      }
      const len = Math.hypot(c, s);
      if (len > 1e-12) { c /= len; s /= len; } else { c = 1; s = 0; }
      // R = [[c, s], [-s, c]]; fitted vertex = R (p - pc) + qc
      for (let r = 0; r < 3; r++) {
        const v = tri[r];
        const px = rest[2 * v] - pcx, py = rest[2 * v + 1] - pcy;
        fitted[t * 6 + 2 * r] = c * px + s * py + qcx;
        fitted[t * 6 + 2 * r + 1] = -s * px + c * py + qcy;
      }
      // -- Step two (b): accumulate the linear term from fitted edge vectors
      //    (eq. 12-13). Minimizing Σ|(v_j - v_i) - d|² gives H v = b with
      //    b_j += d, b_i -= d for every edge (i, j).
      const w = weights[t];
      for (let r = 0; r < 3; r++) {
        const a = tri[r], b = tri[(r + 1) % 3];
        const dx = fitted[t * 6 + 2 * ((r + 1) % 3)] - fitted[t * 6 + 2 * r];
        const dy = fitted[t * 6 + 2 * ((r + 1) % 3) + 1] - fitted[t * 6 + 2 * r + 1];
        bx[b] += w * dx; bx[a] -= w * dx;
        by[b] += w * dy; by[a] -= w * dy;
      }
    });

    // -- Step two (b): H' u = b_free - D q, solved per component (eq. 16)
    const rhsX = this.rhsX, rhsY = this.rhsY;
    for (let a = 0; a < m; a++) {
      let sx = bx[free[a]], sy = by[free[a]];
      const row = a * h;
      for (let b = 0; b < h; b++) { sx -= H01[row + b] * q[2 * b]; sy -= H01[row + b] * q[2 * b + 1]; }
      rhsX[a] = sx; rhsY[a] = sy;
    }
    const ux = this.solver2.solve(rhsX, this.ux), uy = this.solver2.solve(rhsY, this.uy);
    const out = new Float64Array(2 * n);
    for (let a = 0; a < m; a++) { out[2 * free[a]] = ux[a]; out[2 * free[a] + 1] = uy[a]; }
    for (let b = 0; b < h; b++) { out[2 * handles[b]] = q[2 * b]; out[2 * handles[b] + 1] = q[2 * b + 1]; }
    return { vertices: out, intermediate: inter, fitted };
  }
}
