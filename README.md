# As-Rigid-As-Possible Shape Manipulation — a plaything

An interactive, multi-touch implementation of

> Takeo Igarashi, Tomer Moscovich, John F. Hughes.
> *As-Rigid-As-Possible Shape Manipulation.* ACM SIGGRAPH 2005.
> https://www-ui.is.s.u-tokyo.ac.jp/~takeo/papers/takeo_siggraph2005.pdf

**Live demo:** <https://alexwarth.github.io/projects/as-rigid-as-possible-shape-manipulation/><br>
(best on an iPad or another multi-touch screen; a mouse works too)

Grab a 2D shape with your fingers and move, rotate, stretch and bend it, as in
Figure 1 of the paper. The important ideas from the paper live in a small
dependency-free library (`arap/`, TypeScript) that the UI (`app/`, `index.html`) sits on
top of, so the implementation can be reused elsewhere.

## Why

I was thinking about how much better it is to read a research paper when
you have a "plaything" to, well, play with while you read. It really
supports active reading, which I'm big on. I've tried to do that over the
years. For example:

* The [paper about Seymour](https://harc.github.io/seymour-live2017/) that
  I wrote with Saketh is full of interactive bits that can not only run the
  examples from the paper, but also let the user change them and see what
  happens.
* The [paper about Incremental Packrat
  Parsing](https://ohmjs.org/pubs/sle2017/incremental-packrat-parsing.pdf)
  that I wrote with Pat has a bunch of nice diagrams that explain our idea.
  We made those using an explorable explanation -- a tiny parser that
  implements our idea. We made [that
  explorable](https://ohmjs.org/sle17/memo-viz.html) available to the reader
  so they can play with it while reading the paper, too.

Recently it occurred to me that the LLMs had crossed a threshold where I
could use them to quickly make explorables for other people's work, too. So
I gave it a shot with Takeo Igarashi's [As-Rigid-As-Possible Shape
Manipulation](https://cs.brown.edu/people/jhughes/papers/Igarashi-ASM-2005/paper.pdf)
paper that I really enjoyed but never got around making a version of my own.
(This is one of our favorites in the
[Programmable Ink](https://www.inkandswitch.com/ink/) track at
[Ink & Switch](https://www.inkandswitch.com/)!)
I told Claude to make a little webpage that I could play with on my iPad,
with multi-touch support, and (as a bonus) I asked it to write it so that all
of the interesting stuff in the paper was written as a little library that
the explorable uses, to make it easy for me to use in my own prototypes.
Claude totally nailed it (!!) and now I have a version of that stuff that I
can play with. I was able to recreate the examples in the paper and get a
much better feeling for what works well and what doesn't about that
approach. Excited about this!

Alex Warth @ Ink & Switch<br>
Oct. 23, 2026

## Running it

It is a small [Vite](https://vite.dev) + TypeScript project with no runtime
dependencies. With Node.js (22.18 or newer) installed:

```bash
npm install
npm run dev
```

Vite prints a local URL (normally `http://localhost:5173/`) and a network URL
you can open on an iPad on the same Wi-Fi; your computer's Bonjour name
(`http://<name>.local:5173/`) works too. (Adding the page to the iPad's home screen gives you a full-screen,
scroll-free version.)

`npm run build` writes a static site to `dist/` that can be hosted anywhere,
including under a subpath such as GitHub Pages; `npm run preview` serves that
build. A GitHub Actions workflow (`.github/workflows/deploy.yml`) does this on
every push to `main` and publishes the result to the page linked above. `npm test` runs the library's tests (plain Node, no test framework),
`npm run typecheck` runs the TypeScript compiler, and `npm run build:lib`
compiles just the library to plain JavaScript plus `.d.ts` files in `lib/`.

## Using it

- **Drag** with one or more fingers (or the mouse). Each finger grabs the
  nearest mesh vertex and becomes a handle; the rest of the shape follows
  as rigidly as possible. One finger translates, two let you rotate and
  stretch, three or more bend.
- **Tap** to leave a pin (a persistent handle). Tap a pin to remove it; drag
  a pin to move it.
- When you **lift a finger** while at least two other handles are still
  holding the shape, a pin is left where you let go. The paper's solve is a
  pure function of the handle positions (it has no memory of the previous
  frame), so without that pin the pose would spring back.
- The shape menu offers the paper's own examples: the gingerbread man of
  Figure 2 and the frog of Figure 14, plus a whale drawn in the same style
  after the one in the Figure 1 photographs, which the PDF only contains
  partly hidden by hands. Its mouth is slightly open so that, as in Figure 1,
  the jaws are separate parts of the mesh and can be pulled apart. All three
  are SVGs in `assets/`: the first two were traced from the small JPEGs
  embedded in the PDF with `tools/trace-figure.py`, so they keep the
  hand-drawn outlines but stay crisp at any size. The script classifies each
  pixel as a blend of two palette colors (so anti-aliased edges land on the
  right side of the outline), removes the background by flood fill, and
  traces each color with potrace at a modest magnification so the curves
  follow the drawing rather than the JPEG's pixel grid. The three dots on the
  frog's belly in Figure 14 are the paper's handle markers, not part of the
  drawing, and were erased. They live in `assets/`.
- **Load image…** takes any PNG, JPEG or SVG. Images with transparency use the alpha
  channel as the silhouette; opaque images have their background removed by
  flood-filling the corner color from the border, so white details inside
  the shape survive. **Mesh density** rebuilds the mesh (it clears pins).

Visualization toggles, and the parts of the paper they correspond to:

| Toggle | Shows |
| --- | --- |
| Mesh | the triangle mesh of the deformed shape (Figure 17) |
| Rest shape | the original mesh and silhouette, for comparison |
| Step 1 result | the intermediate, *scale-free* result (orange). Pull two fingers apart and watch it inflate while the final shape doesn't — this is why step two exists (Section 4.1, Figure 3a) |
| Fitted triangles | each rest triangle rigidly fitted to its intermediate triangle (green, Figure 3b). The final result is the least-squares reconciliation of these (Figure 3c) |
| Scale adjustment (step 2) | turn it off to see what step one alone does |
| Overlap ordering | our extension (see below): when parts of the shape overlap, draw the most recently manipulated part on top. Off, overlapping triangles are drawn in arbitrary order |
| Curved outline | mesh edges are straight, but the drawing's outline is not. With this on, each silhouette triangle is clipped to the traced outline rather than its straight edge, so the sliver of image between the two is drawn with that triangle's transform. Turn it off, with a coarse mesh, to see the chords |

The status line shows the mesh size plus "compile" (the pre-computation that
happens whenever the set of handles changes) and "solve" (the per-frame
cost), matching Table 1 of the paper.

## The library

```ts
import { ArapDeformer, meshFromMask } from './arap/index.ts';

// Registration: build a mesh from a binary mask and precompute G and H.
const mesh = meshFromMask(mask, width, height, { spacing: 24 });
const arap = new ArapDeformer(mesh.vertices, mesh.triangles);

// Compilation: whenever the set of constrained vertices changes.
arap.setHandles([12, 57]);

// Manipulation: every frame.
const { vertices, intermediate, fitted } = arap.solve([[x1, y1], [x2, y2]]);
```

The library is written in TypeScript and exports its types (`Vec2`,
`Triangle`, `ShapeMesh`, `SolveResult`, `Handle`, ...). Vite, Bun, Deno and
recent Node (22.18+) can import the `.ts` files directly; for anything else,
`npm run build:lib` produces plain JavaScript and declaration files in `lib/`.

- `arap/arap.ts` — `ArapDeformer`, the two-step algorithm of Section 4,
  organized exactly as the paper's "Algorithm summary" (4.3): registration
  in the constructor, compilation in `setHandles`, manipulation in `solve`.
  Per-triangle rigidity weights (Section 5.2) are supported through the
  `weights` option. `solve(..., { scaleAdjust: false })` returns the step-one
  result only.
- `arap/mesh.ts` — `meshFromMask`: marching-squares silhouette tracing, an
  evenly resampled outline, a hexagonal lattice of interior points, a
  constrained Delaunay triangulation (the outline edges are enforced), and
  removal of the triangles outside the outline polygon. It also returns the
  traced outline between neighboring silhouette vertices for renderers.
- `arap/delaunay.ts` — a small Bowyer–Watson Delaunay triangulator plus
  constraint-edge recovery by edge flipping.
- `arap/linalg.ts` — a banded Cholesky factorization used for the
  pre-factored systems.

- `arap/types.ts` — the shared `Vec2`, `Triangle` and point types.

The files in `arap/` have no dependencies on the app or on each other beyond
plain imports, so they can be copied into another project as they are.
- `arap/overlap.ts` — `OverlapDepthSorter`, our depth-ordering extension
  (see below). It is separate from the deformer and optional.
- `app/render.ts` — Canvas 2D texture mapping of the deformed mesh (with the
  outline clipping described above) plus wireframe helpers.

Vertices are flat `Float64Array`s (`[x0, y0, x1, y1, …]`), triangles are
`[i, j, k]` index triples, and everything is in whatever coordinate system
you give it (the plaything uses image pixels).

## Extension: depth ordering of overlapping parts

This is **not part of the paper's algorithm**. The two-step solve produces
flat 2D positions, so when a deformed shape folds over itself nothing says
which part is in front, and a renderer that just draws triangles in array
order shows the interpenetration of Figure 7 (middle). Section 5.1 of the
paper handles this with runtime collision detection and depth assignment,
starting from a predefined order, and notes that deciding the order is an
open problem. `arap/overlap.ts` is our practical take on it, used by the
plaything when "Overlap ordering" is on (the default):

1. After each solve, find pairs of triangles that overlap on screen but are
   not neighbors in the rest mesh (pairs that share a vertex, or whose rest
   centroids are closer than one edge length, are ignored, since neighbors
   may legitimately overlap slightly when squashed). A uniform grid does the
   broad phase and a separating-axis test the rest.
2. Partition the triangles involved into *sheets*. Overlapping triangles must
   be on different sheets, so each connected component of the overlap graph
   is two-colored; the sides of components that lie close together in the
   rest mesh are merged into the same sheets, so the root of an arm and the
   rest of the arm stay together. A component that cannot be two-colored
   (three or more parts piled up) is split by proximity to seed triangles
   instead. For a foot landing on a hand this gives two sheets; for a limb
   folded over itself it splits at the fold.
3. Draw the sheets back to front. An order, once established, is kept from
   frame to frame so nothing flips mid-gesture; a sheet moves in front of
   another only when a handle near it moved clearly more recently (more than
   250 ms) and the other sheet is not held by a finger. A new relation is
   decided by recency, so the part you are manipulating comes forward as if
   you had picked it up, then by closeness to a handle. Triangles that overlap
   nothing are drawn first.

Limitations: a part can only be in front of or behind another as a whole (no
interleaving within one overlap), there is no collision response, and the
"most recently moved" rule is a heuristic, not the physically correct order.
Turn the toggle off to see the paper's algorithm's output unadorned.

## Notes on fidelity

The core algorithm follows the paper closely; the equations in the comments
refer to its equation numbers. A few practical differences:

- **Mesh generation.** The paper uses a constrained Delaunay triangulation
  refined by a particle system (Markosian et al.). The lattice-plus-constrained-
  Delaunay approach here gives similar near-equilateral meshes with much less
  code.
- **Fitting (4.2.1).** The paper finds the best *similarity* transform of each
  rest triangle by solving a 4×4 system, then rescales it to be rigid. The
  closed-form least-squares rotation about the centroids used here produces
  the same fitted triangle.
- **Linear algebra.** The paper uses a sparse LU solver. Here the matrices are
  stored densely, but vertices are ordered by row so the systems are banded,
  and the Cholesky factorization exploits that. Compilation takes a few
  milliseconds for the 100–300 vertex meshes the paper recommends and about
  20 ms for ~650 vertices.
- **One handle.** As in the paper, a single handle just translates the shape.
  The plaything translates the *current* pose rather than the rest shape.

Not implemented: the paper's own collision detection and depth adjustment
(5.1; see our extension above), the rigidity painting UI (5.2; the library
supports the weights), spatial keyframing (5.3) and curve editing (5.4).
