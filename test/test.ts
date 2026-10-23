// Sanity tests for the ARAP library: run with `node test/test.ts` (Node 22.18+).
import { ArapDeformer, meshFromMask, OverlapDepthSorter, trianglesOverlap } from '../arap/index.ts';
import type { Triangle } from '../arap/index.ts';

const W = 200, H = 120;
const mask = new Uint8Array(W * H);
// A rounded bar with a notch, to exercise concavities.
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const inBar = x > 10 && x < 190 && y > 30 && y < 90;
  const notch = x > 90 && x < 110 && y > 60;
  mask[y * W + x] = inBar && !notch ? 1 : 0;
}
const mesh = meshFromMask(mask, W, H, { spacing: 12 });
const n = mesh.vertices.length / 2;
console.log(`mesh: ${n} vertices, ${mesh.triangles.length} triangles, ${mesh.contours.length} contour(s)`);
if (n < 50) throw new Error('mesh too small');

// Every mesh boundary edge should be a silhouette edge with outline detail.
{
  let boundary = 0, withDetail = 0;
  mesh.triangles.forEach((t, ti) => {
    for (let r = 0; r < 3; r++) if (mesh.boundaryEdges[ti] & (1 << r)) { boundary++; if (mesh.boundaryDetail.has(t[r] * n + t[(r + 1) % 3])) withDetail++; }
  });
  console.log(`boundary edges: ${boundary}, with outline detail: ${withDetail}`);
  if (boundary !== withDetail) throw new Error('mesh boundary does not follow the silhouette');
}

const arap = new ArapDeformer(mesh.vertices, mesh.triangles);
// Pick the left-most and right-most vertices as handles.
let left = 0, right = 0;
for (let i = 0; i < n; i++) {
  if (mesh.vertices[2 * i] < mesh.vertices[2 * left]) left = i;
  if (mesh.vertices[2 * i] > mesh.vertices[2 * right]) right = i;
}
let t0 = performance.now();
arap.setHandles([left, right]);
console.log(`compile: ${(performance.now() - t0).toFixed(1)} ms`);

// Test 1: moving handles rigidly (rotate 30° + translate) must reproduce the
// rigid motion for every vertex, with and without scale adjustment.
const ang = Math.PI / 6, c = Math.cos(ang), s = Math.sin(ang), tx = 40, ty = -25;
const rigid = (i: number): [number, number] => {
  const x = mesh.vertices[2 * i], y = mesh.vertices[2 * i + 1];
  return [c * x - s * y + tx, s * x + c * y + ty];
};
for (const scaleAdjust of [false, true]) {
  t0 = performance.now();
  const res = arap.solve([rigid(left), rigid(right)], { scaleAdjust });
  const dt = performance.now() - t0;
  let maxErr = 0;
  for (let i = 0; i < n; i++) {
    const [x, y] = rigid(i);
    maxErr = Math.max(maxErr, Math.hypot(res.vertices[2 * i] - x, res.vertices[2 * i + 1] - y));
  }
  console.log(`rigid motion, scaleAdjust=${scaleAdjust}: max error ${maxErr.toExponential(2)} (${dt.toFixed(2)} ms)`);
  if (maxErr > 1e-3) throw new Error('rigid motion not reproduced');
}

// Test 2: pulling the handles apart. Step one scales the shape up
// (Section 4.1); step two should keep edge lengths close to the rest lengths.
const stretch: [number, number][] = [[mesh.vertices[2 * left] - 40, mesh.vertices[2 * left + 1]], [mesh.vertices[2 * right] + 40, mesh.vertices[2 * right + 1]]];
const res = arap.solve(stretch);
const meanEdgeRatio = (v: Float64Array) => {
  let sum = 0, cnt = 0;
  for (const [a, b] of mesh.triangles) {
    const r0 = Math.hypot(mesh.vertices[2 * a] - mesh.vertices[2 * b], mesh.vertices[2 * a + 1] - mesh.vertices[2 * b + 1]);
    const r1 = Math.hypot(v[2 * a] - v[2 * b], v[2 * a + 1] - v[2 * b + 1]);
    sum += r1 / r0; cnt++;
  }
  return sum / cnt;
};
const r1 = meanEdgeRatio(res.intermediate), r2 = meanEdgeRatio(res.vertices);
console.log(`stretch: mean edge ratio step1=${r1.toFixed(3)} step2=${r2.toFixed(3)}`);
if (!(r1 > 1.2 && r2 < r1 && Math.abs(r2 - 1) < 0.2)) throw new Error('scale adjustment not behaving as expected');

// Test 3: one handle just translates.
arap.setHandles([left]);
const one = arap.solve([[mesh.vertices[2 * left] + 10, mesh.vertices[2 * left + 1] + 5]]);
if (Math.abs(one.vertices[2 * right] - mesh.vertices[2 * right] - 10) > 1e-9) throw new Error('single handle translate failed');

// Test 4 (extension): overlap depth ordering. Two squares far apart at rest;
// slide the second onto the first and check the ordering rules.
{
  const rest = Float64Array.from([0, 0, 10, 0, 10, 10, 0, 10, 100, 0, 110, 0, 110, 10, 100, 10]);
  const tris: Triangle[] = [[0, 1, 2], [0, 2, 3], [4, 5, 6], [4, 6, 7]];
  const sorter = new OverlapDepthSorter(rest, tris, { minRestDistance: 20 });
  const pos = Float64Array.from(rest);
  for (let i = 8; i < 16; i += 2) pos[i] -= 95;
  const top = (order: number[]) => (order[3] >= 2 ? 'second' : 'first');
  if (top(sorter.update(pos, [{ vertex: 0, time: 1000 }, { vertex: 4, time: 2000, active: true }]).order) !== 'second') throw new Error('recently moved part should be on top');
  if (top(sorter.update(pos, [{ vertex: 0, time: 3000, active: true }, { vertex: 4, time: 2000, active: true }]).order) !== 'second') throw new Error('order should be kept while both are held');
  if (top(sorter.update(pos, [{ vertex: 0, time: 3500, active: true }, { vertex: 4, time: 2000 }]).order) !== 'first') throw new Error('released part should yield to the manipulated one');
  if (top(sorter.update(pos, []).order) !== 'first') throw new Error('order should persist without handles');
  if (trianglesOverlap(Float64Array.from([0, 0, 10, 0, 0, 10, 10, 0, 10, 10, 0, 10]), [0, 1, 2], [3, 4, 5])) throw new Error('touching triangles must not count as overlapping');
  console.log('overlap ordering rules: ok');
}
console.log('all tests passed');
