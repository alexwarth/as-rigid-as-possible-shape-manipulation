// Small dense linear-algebra helpers used by the ARAP deformer.
//
// The paper factors its (sparse) systems once per "compilation" and then
// back-substitutes on every frame. This module keeps things dependency-free
// with a dense-storage Cholesky factorization that exploits the band
// structure of the matrices (which follows from ordering mesh vertices
// spatially). That is plenty fast for the mesh sizes the paper recommends
// (100-300 vertices) and a few times beyond; swap in a real sparse solver if
// you need thousands of vertices.

/**
 * Cholesky factorization A = L Lᵀ of a dense, symmetric, positive-definite
 * matrix stored row-major in a Float64Array of length n*n.
 */
export class CholeskySolver {
  readonly n: number;
  /** Half-bandwidth of the matrix (0 for a diagonal matrix). */
  readonly band: number;
  private readonly L: Float64Array;
  private readonly LT: Float64Array;

  constructor(A: Float64Array, n: number) {
    this.n = n;
    // The systems are banded when mesh vertices are ordered spatially (see
    // meshFromMask), so we detect the bandwidth and skip the zeros outside it.
    let band = 0;
    for (let i = 0; i < n; i++) {
      const row = i * n;
      for (let j = i + band + 1; j < n; j++) if (A[row + j] !== 0) band = j - i;
    }
    this.band = band;
    const L = new Float64Array(n * n);
    // Tiny diagonal regularization guards against round-off in nearly
    // singular systems (e.g. two handles that are almost coincident).
    let trace = 0;
    for (let i = 0; i < n; i++) trace += A[i * n + i];
    const eps = (trace / Math.max(n, 1)) * 1e-12;
    for (let j = 0; j < n; j++) {
      const rowJ = j * n;
      const k0 = Math.max(0, j - band);
      let s = A[rowJ + j] + eps;
      for (let k = k0; k < j; k++) s -= L[rowJ + k] * L[rowJ + k];
      if (!(s > 0)) throw new Error(`Matrix is not positive definite (pivot ${j})`);
      const ljj = Math.sqrt(s);
      L[rowJ + j] = ljj;
      const iEnd = Math.min(n, j + band + 1);
      for (let i = j + 1; i < iEnd; i++) {
        const rowI = i * n;
        let t = A[rowI + j];
        for (let k = Math.max(k0, i - band); k < j; k++) t -= L[rowI + k] * L[rowJ + k];
        L[rowI + j] = t / ljj;
      }
    }
    this.L = L;
    // Store Lᵀ contiguously as well so back-substitution is cache friendly.
    const LT = new Float64Array(n * n);
    for (let i = 0; i < n; i++) for (let j = Math.max(0, i - band); j <= i; j++) LT[j * n + i] = L[i * n + j];
    this.LT = LT;
  }

  /** Solves A x = b. `b` is not modified; `x` may be supplied to avoid allocation. */
  solve(b: ArrayLike<number>, x: Float64Array = new Float64Array(this.n)): Float64Array {
    const { n, L, LT, band } = this;
    // Forward substitution: L y = b (y stored in x)
    for (let i = 0; i < n; i++) {
      const row = i * n;
      let s = b[i];
      for (let k = Math.max(0, i - band); k < i; k++) s -= L[row + k] * x[k];
      x[i] = s / L[row + i];
    }
    // Back substitution: Lᵀ x = y
    for (let i = n - 1; i >= 0; i--) {
      const row = i * n;
      let s = x[i];
      const kEnd = Math.min(n, i + band + 1);
      for (let k = i + 1; k < kEnd; k++) s -= LT[row + k] * x[k];
      x[i] = s / LT[row + i];
    }
    return x;
  }
}
