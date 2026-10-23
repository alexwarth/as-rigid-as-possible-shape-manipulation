"""Vectorizes a small flat-color figure (e.g. one cropped out of a paper's PDF)
into a crisp SVG: upscale, classify pixels by nearest palette color, remove the
background by flood fill from the border, smooth each color mask and trace it
with potrace.

    pip install potracer numpy Pillow
    python3 tools/trace-figure.py analyze figure.png 5        # print the palette
    python3 tools/trace-figure.py vectorize '{"src": "figure.png", "out": "figure.svg",
        "palette": [["bg", [255,255,255], "#ffffff"], ["orange", [229,174,63], "#e5ae3f"],
                    ["black", [29,14,5], "#1d0e05"]], "outline": "black"}'

The palette entry named "bg" is the background; "outline" names the border
color, which is used to fill the whole silhouette underneath the other colors
(so the outer edge is always the border color); interior background-colored
regions (eyes...) get their own layer. This is how assets/gingerbread.svg and assets/frog.svg were made from
Figures 2 and 14 of the paper.
"""
import sys, json
import numpy as np, potrace
from PIL import Image, ImageFilter
from collections import deque

def kmeans(pix, k, iters=20, seed=0):
    rng = np.random.default_rng(seed)
    cent = pix[rng.choice(len(pix), k, replace=False)].astype(float)
    for _ in range(iters):
        d = ((pix[:, None, :] - cent[None, :, :]) ** 2).sum(-1)
        lab = d.argmin(1)
        for j in range(k):
            if (lab == j).any(): cent[j] = pix[lab == j].mean(0)
    return cent, lab

def analyze(path, k):
    im = np.asarray(Image.open(path).convert("RGB")).reshape(-1, 3).astype(float)
    cent, lab = kmeans(im, k)
    counts = np.bincount(lab, minlength=k)
    order = np.argsort(-counts)
    print(path, "palette (rgb, share):")
    for j in order: print("  ", tuple(int(v) for v in cent[j]), f"{counts[j]/len(lab):.3f}")

def path_d(path, scale):
    parts = []
    for curve in path:
        s = curve.start_point
        parts.append(f"M{s.x*scale:.2f},{s.y*scale:.2f}")
        for seg in curve.segments:
            if seg.is_corner:
                parts.append(f"L{seg.c.x*scale:.2f},{seg.c.y*scale:.2f}L{seg.end_point.x*scale:.2f},{seg.end_point.y*scale:.2f}")
            else:
                parts.append(f"C{seg.c1.x*scale:.2f},{seg.c1.y*scale:.2f} {seg.c2.x*scale:.2f},{seg.c2.y*scale:.2f} {seg.end_point.x*scale:.2f},{seg.end_point.y*scale:.2f}")
        parts.append("z")
    return "".join(parts)

def trace_mask(mask, turd, alphamax=1.3, opttol=0.8):
    bmp = potrace.Bitmap(~mask)  # potracer treats False as "black" (foreground)
    return bmp.trace(turdsize=turd, alphamax=alphamax, opticurve=True, opttolerance=opttol)

def vectorize(src, out, palette, outline="black", S=3, blur=1.5, turd=8, alphamax=1.3, opttol=0.8, erase=(), erase_color=None):
    """palette: list of (name, rgb, hex[, layer]); 'bg' is the background (removed by flood fill
    from the border); `outline` names the palette color of the border; `erase` lists
    retouches painted with `erase_color` (default: the first color that is neither bg
    nor outline) before tracing: [cx, cy, r] discs or [x1, y1, x2, y2, ..., width]
    stroked polylines, in source pixels."""
    im = Image.open(src).convert("RGB")
    up = im.resize((im.width * S, im.height * S), Image.LANCZOS)
    arr = np.asarray(up).astype(float)
    H, W, _ = arr.shape
    # A palette entry may have a 4th element naming another entry whose layer
    # it belongs to, e.g. ["darkgreen", [50,123,52], "#38f53f", "green"] for the
    # darker green that JPEG blur produces in thin gaps between black lines.
    alias = {i: [q[0] for q in palette].index(p[3]) for i, p in enumerate(palette) if len(p) > 3}
    if erase:
        ec = erase_color or [p[0] for p in palette if p[0] not in ("bg", outline)][0]
        rgb = np.array([p[1] for p in palette if p[0] == ec][0], float)
        yy, xx = np.mgrid[0:H, 0:W]
        px, py = (xx + 0.5) / S, (yy + 0.5) / S
        for e in erase:
            if len(e) == 3:  # disc [cx, cy, r]
                cx, cy, r = e
                arr[(px - cx) ** 2 + (py - cy) ** 2 <= r * r] = rgb
            else:  # stroked polyline [x1, y1, x2, y2, ..., width]
                w = e[-1]; pts = list(zip(e[0:-1:2], e[1:-1:2]))
                for (ax, ay), (bx, by) in zip(pts, pts[1:]):
                    dx, dy = bx - ax, by - ay; l2 = dx * dx + dy * dy or 1.0
                    t = np.clip(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1)
                    arr[(px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2 <= (w / 2) ** 2] = rgb
    cols = np.array([p[1] for p in palette], float)
    # Anti-aliased (and JPEG-blurred) edge pixels are blends of two palette
    # colors, e.g. gray between black and white. Nearest-color labelling gets
    # those wrong (gray is nearer to orange than to black or white). Instead,
    # project each pixel onto the segment between every pair of palette colors
    # and take the best-fitting pair; the label is the nearer end of it.
    k = len(cols)
    best = np.full((H, W), np.inf); lab = np.zeros((H, W), int)
    for i in range(k):
        for j in range(i + 1, k):
            v = cols[j] - cols[i]; vv = float(v @ v)
            t = np.clip(((arr - cols[i]) @ v) / vv, 0, 1)
            res = ((arr - (cols[i] + t[..., None] * v)) ** 2).sum(-1)
            better = res < best
            best = np.where(better, res, best)
            lab = np.where(better, np.where(t < 0.5, i, j), lab)
    for i, j in alias.items(): lab[lab == i] = j
    names = [p[0] for p in palette]
    bgi = names.index("bg")
    # background = bg-labelled pixels connected to the border
    isbg = lab == bgi
    seen = np.zeros((H, W), bool); q = deque()
    for x in range(W):
        for y in (0, H - 1):
            if isbg[y, x] and not seen[y, x]: seen[y, x] = True; q.append((y, x))
    for y in range(H):
        for x in (0, W - 1):
            if isbg[y, x] and not seen[y, x]: seen[y, x] = True; q.append((y, x))
    while q:
        y, x = q.popleft()
        for ny, nx in ((y+1,x),(y-1,x),(y,x+1),(y,x-1)):
            if 0 <= ny < H and 0 <= nx < W and isbg[ny, nx] and not seen[ny, nx]: seen[ny, nx] = True; q.append((ny, nx))
    shape = ~seen
    # interior pixels labelled bg (e.g. white eyes) belong to a 'white' layer if present
    def smooth(m):
        g = Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(blur))
        return np.asarray(g) > 127
    # Stacking: the whole silhouette in the outline color first, then each
    # other color on top. The outer edge is therefore always the outline
    # color, and any hairline mismatch between traced layers shows outline
    # color rather than body color bleeding past the border.
    layers = [(outline, [p for p in palette if p[0] == outline][0][2], smooth(shape))]
    for idx, (name, rgb, hx, *rest) in enumerate(palette):
        if name in ("bg", outline) or idx in alias: continue
        m = (lab == idx) & shape
        layers.append((name, hx, smooth(m)))
    # interior background-colored regions (eyes etc.) get painted explicitly
    inner_bg = isbg & shape
    if inner_bg.sum() > 50 * S * S:
        layers.append(("inner", palette[bgi][2], smooth(inner_bg)))
    scale = 1.0 / S  # SVG units = source pixels
    svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{im.width}" height="{im.height}" viewBox="0 0 {im.width} {im.height}">']
    svg.append(f'<!-- Traced from a figure of Igarashi, Moscovich, Hughes, "As-Rigid-As-Possible Shape Manipulation", SIGGRAPH 2005. -->')
    for name, hx, m in layers:
        if not m.any(): continue
        p = trace_mask(m, turd, alphamax, opttol)
        dstr = path_d(p, scale)
        svg.append(f'<path id="{name}" fill="{hx}" fill-rule="evenodd" d="{dstr}"/>')
    svg.append("</svg>")
    open(out, "w").write("\n".join(svg))
    print("wrote", out, "layers:", [l[0] for l in layers], "size", im.size)

def blobs(path, bg=(255, 255, 255), tol=60):
    """Lists light blobs inside the figure (eyes, markers...) with centroid and radius in source px."""
    arr = np.asarray(Image.open(path).convert("RGB")).astype(float)
    H, W, _ = arr.shape
    light = np.sqrt(((arr - np.array(bg, float)) ** 2).sum(-1)) < tol
    seen = np.zeros((H, W), bool)
    comps = []
    for sy in range(H):
        for sx in range(W):
            if not light[sy, sx] or seen[sy, sx]: continue
            q = deque([(sy, sx)]); seen[sy, sx] = True; pts = []
            while q:
                y, x = q.popleft(); pts.append((y, x))
                for ny, nx in ((y+1,x),(y-1,x),(y,x+1),(y,x-1)):
                    if 0 <= ny < H and 0 <= nx < W and light[ny, nx] and not seen[ny, nx]: seen[ny, nx] = True; q.append((ny, nx))
            touches_border = any(y in (0, H-1) or x in (0, W-1) for y, x in pts)
            if not touches_border:
                ys, xs = zip(*pts)
                comps.append((len(pts), sum(xs)/len(xs) + 0.5, sum(ys)/len(ys) + 0.5))
    for area, cx, cy in sorted(comps, key=lambda c: c[2]):
        print(f"  blob at ({cx:.1f}, {cy:.1f}) area {area} px, radius ~{(area/3.14159)**0.5:.1f}")

if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "analyze": analyze(sys.argv[2], int(sys.argv[3]))
    elif cmd == "blobs": blobs(sys.argv[2])
    elif cmd == "vectorize": vectorize(**json.loads(sys.argv[2]))
    else: print(__doc__)
