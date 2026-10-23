// Canvas 2D rendering helpers: texture-mapped triangles plus wireframes.
import type { Triangle, Vec2 } from '../arap/index.ts';

export interface TexturedMeshOptions {
  /** World units by which each triangle's clip region grows away from its centroid, to hide seams. */
  expand?: number;
  /** From ShapeMesh: which triangle edges lie on the silhouette. */
  boundaryEdges?: Uint8Array | null;
  /** From ShapeMesh: the traced outline per silhouette edge; null draws straight edges. */
  boundaryDetail?: Map<number, Float64Array> | null;
  /** Image pixels by which the traced outline is pushed outward to cover the anti-aliased fringe. */
  outlineExpand?: number;
  /** Triangle indices, back to front, so overlapping parts can be layered. */
  order?: number[] | null;
}

/**
 * Draws `image` mapped from rest coordinates `uv` onto deformed positions `pos`.
 * Mesh edges are straight but the shape's silhouette is not. When
 * `boundaryDetail` (from meshFromMask) is given, a silhouette triangle is
 * clipped to the traced outline instead of its straight edge, so the sliver
 * of image between the two is drawn too, with that triangle's transform.
 * The clip path is built in rest coordinates under the triangle's affine map,
 * so it is exact and neighboring triangles never overlap.
 */
export function drawTexturedMesh(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  uv: ArrayLike<number>,
  pos: ArrayLike<number>,
  triangles: Triangle[],
  { expand = 0.5, boundaryEdges = null, boundaryDetail = null, outlineExpand = 1.5, order = null }: TexturedMeshOptions = {},
): void {
  const nV = uv.length / 2;
  const seq = order ?? triangles.map((_, i) => i);
  for (const ti of seq) {
    const [a, b, c] = triangles[ti];
    const u0 = uv[2 * a], v0 = uv[2 * a + 1], u1 = uv[2 * b], v1 = uv[2 * b + 1], u2 = uv[2 * c], v2 = uv[2 * c + 1];
    const x0 = pos[2 * a], y0 = pos[2 * a + 1], x1 = pos[2 * b], y1 = pos[2 * b + 1], x2 = pos[2 * c], y2 = pos[2 * c + 1];
    // Affine map (u,v) -> (x,y)
    const du1 = u1 - u0, dv1 = v1 - v0, du2 = u2 - u0, dv2 = v2 - v0;
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-9) continue;
    const dx1 = x1 - x0, dy1 = y1 - y0, dx2 = x2 - x0, dy2 = y2 - y0;
    const ma = (dx1 * dv2 - dx2 * dv1) / det, mb = (dy1 * dv2 - dy2 * dv1) / det;
    const mc = (dx2 * du1 - dx1 * du2) / det, md = (dy2 * du1 - dy1 * du2) / det;
    const me = x0 - ma * u0 - mc * v0, mf = y0 - mb * u0 - md * v0;
    // The clip path is built in rest (image) space. Slightly expand the
    // triangle away from its centroid to hide seams between triangles.
    const cu = (u0 + u1 + u2) / 3, cv = (v0 + v1 + v2) / 3;
    const grow = (u: number, v: number): Vec2 => { const d = Math.hypot(u - cu, v - cv) || 1; return [u + ((u - cu) / d) * expand, v + ((v - cv) / d) * expand]; };
    const P = [grow(u0, v0), grow(u1, v1), grow(u2, v2)];
    const V = [a, b, c];
    const mask = boundaryDetail && boundaryEdges ? boundaryEdges[ti] : 0;
    ctx.save();
    ctx.transform(ma, mb, mc, md, me, mf);
    ctx.beginPath();
    for (let r = 0; r < 3; r++) {
      const [ax, ay] = P[r], [bx, by] = P[(r + 1) % 3];
      if (r === 0) ctx.moveTo(ax, ay); else ctx.lineTo(ax, ay);
      const detail = mask & (1 << r) ? boundaryDetail!.get(V[r] * nV + V[(r + 1) % 3]) : undefined;
      if (detail) {
        // Follow the traced outline, pushed outward a touch to cover the
        // image's anti-aliased fringe. Outward = away from the third vertex.
        const ex = bx - ax, ey = by - ay, len = Math.hypot(ex, ey) || 1;
        let nx = -ey / len, ny = ex / len;
        const [qx, qy] = P[(r + 2) % 3];
        if (nx * (qx - ax) + ny * (qy - ay) > 0) { nx = -nx; ny = -ny; }
        for (let i = 0; i < detail.length; i += 2) ctx.lineTo(detail[i] + nx * outlineExpand, detail[i + 1] + ny * outlineExpand);
      }
    }
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(image, 0, 0);
    ctx.restore();
  }
}

export interface StrokeOptions { stroke?: string; width?: number; dash?: number[] | null }

export function drawWireframe(ctx: CanvasRenderingContext2D, pos: ArrayLike<number>, triangles: Triangle[], { stroke = '#000', width = 1, dash = null }: StrokeOptions = {}): void {
  ctx.save();
  ctx.strokeStyle = stroke; ctx.lineWidth = width;
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  for (const [a, b, c] of triangles) {
    ctx.moveTo(pos[2 * a], pos[2 * a + 1]);
    ctx.lineTo(pos[2 * b], pos[2 * b + 1]);
    ctx.lineTo(pos[2 * c], pos[2 * c + 1]);
    ctx.closePath();
  }
  ctx.stroke();
  ctx.restore();
}

/** Draws a flat list of independent triangles (6 numbers each). */
export function drawTriangleList(ctx: CanvasRenderingContext2D, tris: ArrayLike<number>, { stroke = '#000', fill = null, width = 1 }: { stroke?: string; fill?: string | null; width?: number } = {}): void {
  ctx.save();
  ctx.strokeStyle = stroke; ctx.lineWidth = width;
  if (fill) ctx.fillStyle = fill;
  ctx.beginPath();
  for (let t = 0; t + 5 < tris.length; t += 6) {
    ctx.moveTo(tris[t], tris[t + 1]);
    ctx.lineTo(tris[t + 2], tris[t + 3]);
    ctx.lineTo(tris[t + 4], tris[t + 5]);
    ctx.closePath();
  }
  if (fill) ctx.fill();
  ctx.stroke();
  ctx.restore();
}

export function drawContours(ctx: CanvasRenderingContext2D, contours: Vec2[][], { stroke = '#000', width = 1, dash = null }: StrokeOptions = {}): void {
  ctx.save();
  ctx.strokeStyle = stroke; ctx.lineWidth = width;
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  for (const loop of contours) {
    loop.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
  }
  ctx.stroke();
  ctx.restore();
}
