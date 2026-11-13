// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Triangulating a simple polygon in the plane, for capping a hull's blunt ends.
 *
 * A fan from the centre caps a convex end, which a board's tail is until channels run
 * out through it: then the end's outline has notches cut up into its bottom edge, and
 * fan triangles cross them, closing the channels' mouths with a web (owner report,
 * 2026-11). Ear clipping covers exactly the outline, notches and all.
 */

/** A point in the polygon's plane. */
export interface P2 {
  readonly x: number;
  readonly y: number;
}

/** Twice the signed area: positive when the points run anticlockwise. */
const signedArea2 = (pts: readonly P2[]): number => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a;
};

const cross = (a: P2, b: P2, c: P2) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

/** `p` strictly inside triangle abc (anticlockwise), with a little slack on the edges. */
const inside = (p: P2, a: P2, b: P2, c: P2, eps: number) =>
  cross(a, b, p) > eps && cross(b, c, p) > eps && cross(c, a, p) > eps;

/**
 * Triangles covering the simple polygon `pts` (closed implicitly, either direction), as
 * index triples wound the same way as the polygon runs. O(n²): fine for a hull's end
 * ring, a few hundred points.
 *
 * Points a hair apart (a channel's vertical wall is two points 1 µm apart) and points on
 * a straight run are handled: such an ear is clipped as a sliver, which is what the
 * outline is there.
 */
export const triangulatePolygon = (pts: readonly P2[]): [number, number, number][] => {
  const n = pts.length;
  if (n < 3) return [];
  const ccw = signedArea2(pts) >= 0;
  // Work anticlockwise; hand the triangles back in the polygon's own direction.
  const idx = Array.from({ length: n }, (_, i) => (ccw ? i : n - 1 - i));
  const at = (i: number) => pts[i]!;
  let scale = 0;
  for (const p of pts) scale = Math.max(scale, Math.abs(p.x), Math.abs(p.y));
  const eps = (scale * scale + 1e-30) * 1e-14;
  const out: [number, number, number][] = [];
  const emit = (a: number, b: number, c: number) => out.push(ccw ? [a, b, c] : [c, b, a]);

  let guard = n * n;
  while (idx.length > 3 && guard-- > 0) {
    const m = idx.length;
    let clipped = false;
    for (let k = 0; k < m; k++) {
      const ia = idx[(k + m - 1) % m]!;
      const ib = idx[k]!;
      const ic = idx[(k + 1) % m]!;
      const a = at(ia);
      const b = at(ib);
      const c = at(ic);
      if (cross(a, b, c) < -eps) continue; // reflex
      let blocked = false;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (inside(at(j), a, b, c, eps)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      emit(ia, ib, ic);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // Numerically stuck (it shouldn't be on a simple polygon): clip the least reflex
      // corner, so the cap still closes.
      let best = 0;
      let bestCross = -Infinity;
      for (let k = 0; k < idx.length; k++) {
        const c = cross(at(idx[(k + idx.length - 1) % idx.length]!), at(idx[k]!), at(idx[(k + 1) % idx.length]!)); // prettier-ignore
        if (c > bestCross) {
          bestCross = c;
          best = k;
        }
      }
      const m2 = idx.length;
      emit(idx[(best + m2 - 1) % m2]!, idx[best]!, idx[(best + 1) % m2]!);
      idx.splice(best, 1);
    }
  }
  if (idx.length === 3) emit(idx[0]!, idx[1]!, idx[2]!);
  return out;
};
