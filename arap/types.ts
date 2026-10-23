// Shared types for the ARAP library.

/** A 2D point, [x, y]. */
export type Vec2 = [number, number];

/** A triangle as three vertex indices. */
export type Triangle = [number, number, number];

/**
 * Vertex positions as a flat array [x0, y0, x1, y1, ...]. Functions that take
 * positions also accept an array of [x, y] pairs.
 */
export type FlatPoints = ArrayLike<number>;
export type Points = FlatPoints | Vec2[];

/** Converts either representation of points to a flat Float64Array. */
export function toFlat(v: Points): Float64Array {
  if (v instanceof Float64Array) return v;
  if (Array.isArray(v) && v.length > 0 && Array.isArray(v[0])) {
    const pairs = v as Vec2[];
    const out = new Float64Array(pairs.length * 2);
    pairs.forEach((p, i) => { out[2 * i] = p[0]; out[2 * i + 1] = p[1]; });
    return out;
  }
  return Float64Array.from(v as ArrayLike<number>);
}
