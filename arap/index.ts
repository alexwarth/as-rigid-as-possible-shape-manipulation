// As-Rigid-As-Possible Shape Manipulation (Igarashi, Moscovich, Hughes 2005)
// as a small reusable library.
//
//   import { ArapDeformer, meshFromMask } from './arap/index.ts';
//   const mesh = meshFromMask(mask, w, h, { spacing: 24 });
//   const arap = new ArapDeformer(mesh.vertices, mesh.triangles);
//   arap.setHandles([12, 57]);                             // compile
//   const { vertices } = arap.solve([[x1, y1], [x2, y2]]); // every frame
export { ArapDeformer } from './arap.ts';
export type { DeformerOptions, SolveOptions, SolveResult } from './arap.ts';
export { meshFromMask, traceContours } from './mesh.ts';
export type { MeshOptions, ShapeMesh } from './mesh.ts';
export { delaunayTriangulate, constrainedDelaunayTriangulate } from './delaunay.ts';
export { CholeskySolver } from './linalg.ts';
export { toFlat } from './types.ts';
export type { Vec2, Triangle, Points, FlatPoints } from './types.ts';
// Extension, not part of the paper's algorithm: see arap/overlap.ts.
export { OverlapDepthSorter, trianglesOverlap } from './overlap.ts';
export type { OverlapOptions, Handle, Sheet, OverlapResult } from './overlap.ts';
