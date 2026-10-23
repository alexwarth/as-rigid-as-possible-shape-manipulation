// The plaything: a multi-touch UI on top of the ARAP library.
import { ArapDeformer, meshFromMask, OverlapDepthSorter } from '../arap/index.ts';
import type { ShapeMesh, Vec2 } from '../arap/index.ts';
import { drawTexturedMesh, drawWireframe, drawTriangleList, drawContours } from './render.ts';
import { makeDefaultShape } from './default-shape.ts';
import { prepareImage, type PreparedImage } from './image-mask.ts';
import gingerbreadUrl from '../assets/gingerbread.svg';
import frogUrl from '../assets/frog.svg';
import whaleUrl from '../assets/whale.svg';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  showImage: $<HTMLInputElement>('showImage'), showMesh: $<HTMLInputElement>('showMesh'), showRest: $<HTMLInputElement>('showRest'),
  showInter: $<HTMLInputElement>('showInter'), showFitted: $<HTMLInputElement>('showFitted'), showHandles: $<HTMLInputElement>('showHandles'),
  scaleAdjust: $<HTMLInputElement>('scaleAdjust'), skirt: $<HTMLInputElement>('skirt'), overlap: $<HTMLInputElement>('overlap'),
  density: $<HTMLInputElement>('density'), stats: $<HTMLSpanElement>('stats'), file: $<HTMLInputElement>('file'),
  shape: $<HTMLSelectElement>('shape'),
};

/** A finger (or mouse button) currently holding a vertex. */
interface Touch {
  vertex: number;
  /** Where the vertex is being asked to go, in world (image) coordinates. */
  target: Vec2;
  /** Offset between the pointer and the vertex when grabbed. */
  ox: number; oy: number;
  startX: number; startY: number;
  moved: boolean;
  t0: number;
  /** Whether the pointer picked up an existing pin. */
  fromPin: boolean;
}

interface State {
  image: HTMLCanvasElement | null; width: number; height: number; mask: Uint8Array | null;
  mesh: ShapeMesh | null; rest: Float64Array | null; pos: Float64Array | null;
  inter: Float64Array | null; fitted: Float64Array | null;
  deformer: ArapDeformer | null;
  spacing: number;
  pins: Map<number, Vec2>;       // vertex index -> position (persistent handles)
  touches: Map<number, Touch>;   // pointerId -> live handle
  handleTimes: Map<number, number>; // vertex index -> when that handle last moved (for overlap ordering)
  sorter: OverlapDepthSorter | null; drawOrder: number[] | null; // extension: depth ordering of overlapping parts
  handleOrder: number[];         // vertex indices in the order given to setHandles
  view: { scale: number; tx: number; ty: number };
  compileMs: number; solveMs: number;
  dirty: boolean;
}

const state: State = {
  image: null, width: 0, height: 0, mask: null,
  mesh: null, rest: null, pos: null, inter: null, fitted: null, deformer: null,
  spacing: 24,
  pins: new Map(), touches: new Map(), handleTimes: new Map(),
  sorter: null, drawOrder: null,
  handleOrder: [],
  view: { scale: 1, tx: 0, ty: 0 },
  compileMs: 0, solveMs: 0,
  dirty: true,
};

// ---- Shape / mesh setup --------------------------------------------------

function setImage(prepared: PreparedImage): void {
  state.image = prepared.canvas; state.width = prepared.width; state.height = prepared.height; state.mask = prepared.mask;
  fitView();
  buildMesh();
}

function buildMesh(): void {
  if (!state.mask) return;
  const spacing = Number(ui.density.value) * (Math.max(state.width, state.height) / 512);
  state.spacing = spacing;
  let mesh: ShapeMesh;
  try {
    mesh = meshFromMask(state.mask, state.width, state.height, { spacing });
  } catch (err) {
    alert(`Could not build a mesh from this image: ${(err as Error).message}`);
    return;
  }
  state.mesh = mesh;
  state.rest = mesh.vertices;
  state.pos = Float64Array.from(state.rest);
  state.inter = null; state.fitted = null;
  state.deformer = new ArapDeformer(state.rest, mesh.triangles);
  state.sorter = new OverlapDepthSorter(state.rest, mesh.triangles);
  state.drawOrder = null;
  state.pins.clear(); state.touches.clear(); state.handleTimes.clear();
  recompile();
  state.dirty = true;
}

function fitView(): void {
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  const scale = Math.min(cw / state.width, ch / state.height) * 0.75;
  state.view = { scale, tx: (cw - state.width * scale) / 2, ty: (ch - state.height * scale) / 2 };
}

// ---- Handles -------------------------------------------------------------

/** "Compilation" in the paper's terms: re-factor whenever the handle set changes. */
function recompile(): void {
  if (!state.deformer) return;
  const order = [...state.pins.keys()];
  for (const t of state.touches.values()) if (!order.includes(t.vertex)) order.push(t.vertex);
  state.handleOrder = order;
  const t0 = performance.now();
  state.deformer.setHandles(order);
  if (order.length >= 2) state.compileMs = performance.now() - t0;
  state.dirty = true;
}

function handleTarget(v: number): Vec2 {
  for (const t of state.touches.values()) if (t.vertex === v) return t.target;
  return state.pins.get(v)!;
}

/** Runs the two-step solve (or a plain translation for a single handle). */
function update(): void {
  const h = state.handleOrder.length;
  if (h === 0 || !state.pos || !state.deformer) return;
  const t0 = performance.now();
  if (h === 1) {
    const v = state.handleOrder[0], [tx, ty] = handleTarget(v);
    const dx = tx - state.pos[2 * v], dy = ty - state.pos[2 * v + 1];
    // Translate everything, including the last step-one/fitted visualizations.
    for (const arr of [state.pos, state.inter, state.fitted]) {
      if (!arr) continue;
      for (let i = 0; i < arr.length; i += 2) { arr[i] += dx; arr[i + 1] += dy; }
    }
  } else {
    const q = state.handleOrder.map(handleTarget);
    const res = state.deformer.solve(q, { scaleAdjust: ui.scaleAdjust.checked });
    state.pos = res.vertices; state.inter = res.intermediate; state.fitted = res.fitted;
    state.solveMs = performance.now() - t0;
    updateOverlapOrder();
  }
}

/** Extension: decide which overlapping parts are drawn on top (see arap/overlap.ts). */
function updateOverlapOrder(): void {
  if (!ui.overlap.checked || !state.sorter || !state.pos) { state.drawOrder = null; return; }
  const held = new Set([...state.touches.values()].map((t) => t.vertex));
  const handles = state.handleOrder.map((v) => ({ vertex: v, time: state.handleTimes.get(v) ?? -Infinity, active: held.has(v) }));
  state.drawOrder = state.sorter.update(state.pos, handles).order;
}

function toWorld(clientX: number, clientY: number): Vec2 {
  const r = canvas.getBoundingClientRect();
  const { scale, tx, ty } = state.view;
  return [(clientX - r.left - tx) / scale, (clientY - r.top - ty) / scale];
}

function nearestVertex(x: number, y: number, maxDist: number, exclude: (i: number) => boolean): number {
  let best = -1, bestD = maxDist * maxDist;
  const pos = state.pos!;
  for (let i = 0; i < pos.length / 2; i++) {
    if (exclude(i)) continue;
    const d = (pos[2 * i] - x) ** 2 + (pos[2 * i + 1] - y) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function onPointerDown(e: PointerEvent): void {
  if (!state.pos) return;
  e.preventDefault();
  try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
  const [x, y] = toWorld(e.clientX, e.clientY);
  const inUse = (i: number) => [...state.touches.values()].some((t) => t.vertex === i);
  const pickRadius = 44 / state.view.scale;
  // Grab an existing pin if one is close, otherwise the nearest free vertex.
  let v = nearestVertex(x, y, pickRadius * 0.6, (i) => !state.pins.has(i) || inUse(i));
  const fromPin = v >= 0;
  if (!fromPin) v = nearestVertex(x, y, pickRadius, (i) => state.pins.has(i) || inUse(i));
  if (v < 0) return;
  const target: Vec2 = fromPin ? [...state.pins.get(v)!] : [state.pos[2 * v], state.pos[2 * v + 1]];
  if (fromPin) state.pins.delete(v);
  state.touches.set(e.pointerId, {
    vertex: v, target, ox: x - target[0], oy: y - target[1],
    startX: e.clientX, startY: e.clientY, moved: false, t0: performance.now(), fromPin,
  });
  recompile();
}

function onPointerMove(e: PointerEvent): void {
  const t = state.touches.get(e.pointerId);
  if (!t) return;
  e.preventDefault();
  if (Math.hypot(e.clientX - t.startX, e.clientY - t.startY) > 8) t.moved = true;
  const [x, y] = toWorld(e.clientX, e.clientY);
  t.target = [x - t.ox, y - t.oy];
  state.handleTimes.set(t.vertex, performance.now());
  state.dirty = true;
}

function onPointerUp(e: PointerEvent): void {
  const t = state.touches.get(e.pointerId);
  if (!t || !state.pos) return;
  e.preventDefault();
  state.touches.delete(e.pointerId);
  const tap = !t.moved && performance.now() - t.t0 < 400;
  const othersHolding = state.pins.size + state.touches.size;
  if (t.fromPin) {
    if (!tap) state.pins.set(t.vertex, t.target); // a dragged pin stays pinned at its new place
    else state.handleTimes.delete(t.vertex);
  } else if (tap) {
    state.pins.set(t.vertex, [state.pos[2 * t.vertex], state.pos[2 * t.vertex + 1]]);
    state.handleTimes.set(t.vertex, performance.now());
  } else if (othersHolding >= 2) {
    // The solve is a pure function of the handles (Section 4.1: no memory of
    // the previous result), so with two or more other handles still holding
    // the shape, this point would spring back. Leave a pin so the pose stays.
    state.pins.set(t.vertex, t.target);
  } else {
    state.handleTimes.delete(t.vertex);
  }
  recompile();
}

canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointermove', onPointerMove);
canvas.addEventListener('pointerup', onPointerUp);
canvas.addEventListener('pointercancel', onPointerUp);
canvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ---- Rendering -----------------------------------------------------------

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  if (state.image) fitView();
  state.dirty = true;
}

function render(): void {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  const { mesh, rest, pos, inter, fitted, image } = state;
  if (!mesh || !rest || !pos || !image) return;
  const { scale, tx, ty } = state.view;
  ctx.translate(tx, ty); ctx.scale(scale, scale);
  const px = 1 / scale; // one screen pixel in world units

  if (ui.showRest.checked) {
    drawWireframe(ctx, rest, mesh.triangles, { stroke: 'rgba(0,0,0,0.12)', width: px });
    drawContours(ctx, mesh.contours, { stroke: 'rgba(0,0,0,0.35)', width: 1.5 * px, dash: [6 * px, 4 * px] });
  }
  if (ui.showImage.checked) {
    drawTexturedMesh(ctx, image, rest, pos, mesh.triangles, {
      expand: 1.0 * px, boundaryEdges: mesh.boundaryEdges, boundaryDetail: ui.skirt.checked ? mesh.boundaryDetail : null,
      order: state.drawOrder,
    });
  }
  if (ui.showMesh.checked) drawWireframe(ctx, pos, mesh.triangles, { stroke: 'rgba(29,95,191,0.8)', width: px });
  if (ui.showInter.checked && inter) {
    drawWireframe(ctx, inter, mesh.triangles, { stroke: 'rgba(242,140,40,0.85)', width: px });
  }
  if (ui.showFitted.checked && fitted && ui.scaleAdjust.checked) {
    drawTriangleList(ctx, fitted, { stroke: 'rgba(46,158,107,0.9)', fill: 'rgba(46,158,107,0.12)', width: px });
  }
  if (ui.showHandles.checked) {
    for (const [x, y] of state.pins.values()) drawPin(x, y, px, false);
    for (const t of state.touches.values()) drawPin(t.target[0], t.target[1], px, true);
  }
  ui.stats.textContent = `${rest.length / 2} vertices · ${mesh.triangles.length} triangles · compile ${state.compileMs.toFixed(0)} ms · solve ${state.solveMs.toFixed(1)} ms`;
}

function drawPin(x: number, y: number, px: number, live: boolean): void {
  ctx.save();
  ctx.lineWidth = 2 * px;
  if (live) {
    ctx.strokeStyle = 'rgba(29,95,191,0.9)'; ctx.fillStyle = 'rgba(29,95,191,0.18)';
    ctx.beginPath(); ctx.arc(x, y, 22 * px, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  } else {
    ctx.strokeStyle = '#fff'; ctx.fillStyle = '#d6303e';
    ctx.beginPath(); ctx.arc(x, y, 8 * px, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

function frame(): void {
  if (state.dirty) {
    state.dirty = false;
    if (state.mesh) update();
    render();
  }
  requestAnimationFrame(frame);
}

// ---- UI wiring -----------------------------------------------------------

for (const el of [ui.showImage, ui.showMesh, ui.showRest, ui.showInter, ui.showFitted, ui.showHandles, ui.skirt]) {
  el.addEventListener('change', () => { state.dirty = true; });
}
ui.scaleAdjust.addEventListener('change', () => { state.dirty = true; });
ui.overlap.addEventListener('change', () => { updateOverlapOrder(); state.dirty = true; });
ui.density.addEventListener('change', () => buildMesh());
$('reset').addEventListener('click', () => {
  if (!state.rest) return;
  state.pos = Float64Array.from(state.rest); state.pins.clear(); state.touches.clear(); state.handleTimes.clear();
  state.inter = null; state.fitted = null; state.drawOrder = null;
  state.sorter?.reset();
  recompile();
});
$('clearPins').addEventListener('click', () => { state.pins.clear(); state.handleTimes.clear(); recompile(); });
$('load').addEventListener('click', () => ui.file.click());
ui.file.addEventListener('change', () => {
  const f = ui.file.files?.[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  const img = new Image();
  img.onload = () => { URL.revokeObjectURL(url); setImage(prepareImage(img)); ui.shape.value = 'custom'; };
  img.onerror = () => alert('Could not load that image.');
  img.src = url;
  ui.file.value = '';
});

window.addEventListener('resize', resize);
new ResizeObserver(resize).observe(canvas);
resize();

// Built-in shapes: the gingerbread man (Figure 2) and the frog (Figure 14)
// from the paper, traced into SVG from the PDF's figures, and a whale drawn
// after the one in Figure 1; see README.
const BUILT_IN: Record<string, string> = { gingerbread: gingerbreadUrl, frog: frogUrl, whale: whaleUrl };
function loadBuiltIn(name: string): void {
  const img = new Image();
  img.onload = () => setImage(prepareImage(img));
  img.onerror = () => {
    // Fall back to a procedurally drawn cookie if the asset cannot load.
    const def = makeDefaultShape(512);
    const data = def.getContext('2d')!.getImageData(0, 0, def.width, def.height).data;
    const mask = new Uint8Array(def.width * def.height);
    for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
    setImage({ canvas: def, width: def.width, height: def.height, mask });
  };
  img.src = BUILT_IN[name];
}
ui.shape.addEventListener('change', () => { if (BUILT_IN[ui.shape.value]) loadBuiltIn(ui.shape.value); });
loadBuiltIn('gingerbread');
requestAnimationFrame(frame);

// Handy for poking at the plaything from the console.
declare global {
  interface Window { arapApp: { state: State; setImage: typeof setImage; prepareImage: typeof prepareImage; buildMesh: typeof buildMesh } }
}
window.arapApp = { state, setImage, prepareImage, buildMesh };
