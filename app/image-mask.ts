// Turns an arbitrary image into a (canvas, mask) pair for the mesh builder.
// Images with transparency use their alpha channel as the silhouette; opaque
// images get a simple chroma key against the corner (background) color, the
// manual "remove background" step the paper mentions in Section 3.

export interface PreparedImage {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  /** width*height, 1 inside the shape. */
  mask: Uint8Array;
  /** True when the background was removed by color keying rather than alpha. */
  keyed?: boolean;
}

export function prepareImage(img: HTMLImageElement, maxSize = 1024): PreparedImage {
  // Always rasterize at maxSize: vector images (SVG) come out crisp at any
  // size, and the mesh builder scales its spacing with the image size.
  const scale = maxSize / Math.max(img.width, img.height);
  const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  const mask = new Uint8Array(w * h);
  let transparent = 0;
  for (let i = 0; i < w * h; i++) if (px[i * 4 + 3] < 128) transparent++;
  let keyed = false;
  if (transparent > w * h * 0.005) {
    for (let i = 0; i < w * h; i++) mask[i] = px[i * 4 + 3] >= 128 ? 1 : 0;
  } else {
    keyed = true;
    // Background color = average of the four corners. Only pixels connected
    // to the border through near-background colors are removed, so white
    // details inside the shape (eyes, icing) survive.
    const corners = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + w - 1) * 4];
    let r = 0, g = 0, b = 0;
    for (const c of corners) { r += px[c]; g += px[c + 1]; b += px[c + 2]; }
    r /= 4; g /= 4; b /= 4;
    const tol = 60;
    const isBg = (i: number) => Math.hypot(px[i * 4] - r, px[i * 4 + 1] - g, px[i * 4 + 2] - b) < tol;
    mask.fill(1);
    const stack: number[] = [];
    const visit = (i: number) => { if (mask[i] && isBg(i)) { mask[i] = 0; stack.push(i); } };
    for (let x = 0; x < w; x++) { visit(x); visit((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { visit(y * w); visit(y * w + w - 1); }
    while (stack.length) {
      const i = stack.pop()!, x = i % w, y = (i - x) / w;
      if (x > 0) visit(i - 1);
      if (x < w - 1) visit(i + 1);
      if (y > 0) visit(i - w);
      if (y < h - 1) visit(i + w);
    }
    for (let i = 0; i < w * h; i++) if (!mask[i]) px[i * 4 + 3] = 0;
    ctx.putImageData(data, 0, 0);
  }
  return { canvas, width: w, height: h, mask, keyed };
}
