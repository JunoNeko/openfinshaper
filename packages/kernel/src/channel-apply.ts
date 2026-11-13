// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Applying typed-in channels, and reshaping them a cross-section at a time (print
 * version, owner request 2026-11).
 *
 * **Apply** turns channels typed in as numbers into drawn ones: each wall and each
 * channel's depth becomes a curve with a key at every cross-section the channels pass
 * (and at their ends, where full depth begins and ends, and in between where the
 * cross-sections are far apart). The numbers are kept with
 * them, so **Reset** can go back.
 *
 * A key is a point the curve passes through with a slope; the curve runs through the
 * keys, each handle a third of the way to its neighbour (a Hermite curve as Bézier).
 * Moving the key at a cross-section moves the keys between it and the cross-sections
 * either side by an eased share, so the channel changes smoothly from one cross-section
 * to the next and nowhere else.
 *
 * The cut itself is unchanged: drawn channels go through the same loft as typed-in ones
 * (`loft.ts`), walls kept crisp between stations. Nothing is written into the
 * cross-section curves, which the loft blends point by point and would smear.
 */
import { splineFromKnots, valueAt, type Spline } from './bezier-spline';
import type { BezierBoard } from './board';
import {
  channelDepthShare,
  layoutChannels,
  type BoardChannels,
  type ChannelParams,
} from './channel-layout';
import { splineSpan, type BottomChannel } from './channels';
import { knot } from './knot';
import { vec2 } from './vec2';

/** A point a curve passes through, and its slope there. */
interface Key {
  readonly x: number;
  readonly y: number;
  readonly slope: number;
}

/** Keys closer than this along the board are the same key (cm). */
const SAME_X = 1e-6;
/** Step for slopes taken numerically (cm). */
const SLOPE_STEP = 1e-3;

/** The curve through `keys` (ascending x), each handle a third of the way to its neighbour. */
const through = (keys: readonly Key[]): Spline =>
  splineFromKnots(
    keys.map((k, i) => {
      const hp = i > 0 ? (k.x - keys[i - 1]!.x) / 3 : 0;
      const hn = i < keys.length - 1 ? (keys[i + 1]!.x - k.x) / 3 : 0;
      return knot(
        vec2(k.x, k.y),
        vec2(k.x - hp, k.y - k.slope * hp),
        vec2(k.x + hn, k.y + k.slope * hn),
        true,
      );
    }),
  );

/** The keys of a curve made by {@link through} (or any curve running along x). */
const keysOf = (s: Spline): Key[] =>
  s.knots.map((k) => {
    const n = k.tangentToNext;
    const p = k.tangentToPrev;
    const dn = n.x - k.end.x;
    const dp = k.end.x - p.x;
    const slope =
      Math.abs(dn) > 1e-12 ? (n.y - k.end.y) / dn : Math.abs(dp) > 1e-12 ? (k.end.y - p.y) / dp : 0;
    return { x: k.end.x, y: k.end.y, slope };
  });

/** The slope of `f` at `x`, taken inside [a, b]. */
const slopeOf = (f: (x: number) => number, x: number, a: number, b: number): number => {
  const lo = Math.max(a, x - SLOPE_STEP);
  const hi = Math.min(b, x + SLOPE_STEP);
  return hi > lo ? (f(hi) - f(lo)) / (hi - lo) : 0;
};

/** The keys of `f` at `xs` (ascending, duplicates dropped), slopes taken inside [a, b]. */
const keysAt = (f: (x: number) => number, xs: readonly number[], a: number, b: number): Key[] => {
  const out: Key[] = [];
  for (const x of [...xs].sort((p, q) => p - q)) {
    if (x < a - SAME_X || x > b + SAME_X) continue;
    if (out.length && Math.abs(out[out.length - 1]!.x - x) < SAME_X) continue;
    out.push({ x, y: f(x), slope: slopeOf(f, x, a, b) });
  }
  return out;
};

/**
 * `s` with its value at `x` set to `y` (a key added there if it had none), the change
 * easing out to nothing at the cross-sections either side of `x` (or the curve's ends):
 * every key between them moves by its share, so the curve changes smoothly from one
 * cross-section to the next, not just between the keys nearest `x`.
 */
const withKeyAt = (s: Spline, x: number, y: number, stations: readonly number[]): Spline => {
  const keys = keysOf(s);
  const [a, b] = splineSpan(s);
  if (!keys.some((k) => Math.abs(k.x - x) < SAME_X)) {
    const at = (v: number) => valueAt(s, v);
    keys.push({ x, y: at(x), slope: slopeOf(at, x, a, b) });
    keys.sort((p, q) => p.x - q.x);
  }
  const here = keys.find((k) => Math.abs(k.x - x) < SAME_X)!;
  const delta = y - here.y;
  const lo = Math.max(a, ...stations.filter((v) => v < x - SAME_X));
  const hi = Math.min(b, ...stations.filter((v) => v > x + SAME_X));
  return through(
    keys.map((k) => {
      if (Math.abs(k.x - x) < SAME_X) return { ...k, y };
      if (k.x <= lo || k.x >= hi) return k;
      // Smoothstep from the neighbour (0) to here (1), and its slope along the board.
      const before = k.x < x;
      const t = before ? (k.x - lo) / (x - lo) : (hi - k.x) / (hi - x);
      const w = t * t * (3 - 2 * t);
      const dw = ((6 * t * (1 - t)) / (before ? x - lo : hi - x)) * (before ? 1 : -1);
      return { x: k.x, y: Math.max(0, k.y + delta * w), slope: k.slope + delta * dw };
    }),
  );
};

/** The longest stretch left between keys (cm): a wall following the outline stays true. */
const MAX_KEY_GAP = 8;

/** `xs` sorted, with keys added evenly wherever two are more than {@link MAX_KEY_GAP} apart. */
const filled = (xs: readonly number[]): number[] => {
  const sorted = [...xs].sort((a, b) => a - b);
  const out: number[] = [];
  sorted.forEach((x, i) => {
    if (i > 0) {
      const prev = sorted[i - 1]!;
      const n = Math.ceil((x - prev) / MAX_KEY_GAP);
      for (let j = 1; j < n; j++) out.push(prev + ((x - prev) * j) / n);
    }
    out.push(x);
  });
  return out;
};

/**
 * Typed-in channels `p` on board `b`, applied: drawn, with a key on every wall and
 * depth curve at each of `stations` (the cross-sections' positions) inside the
 * channels, and the numbers kept for {@link resetChannels}.
 */
export const applyChannels = (
  b: BezierBoard,
  p: ChannelParams,
  stations: readonly number[],
): BoardChannels => {
  const laid = layoutChannels(b, p);
  const inside = stations.filter((x) => x > p.start + SAME_X && x < p.end - SAME_X);
  const wallXs = [p.start, ...inside, p.end];
  const depthXs = filled([p.start, p.fullFrom, p.fullTo, p.end, ...inside]);
  const depthAt = (x: number) => p.depth * channelDepthShare(p, x);
  // The laid-out wall's own knots are keys too, so a wall that follows the outline
  // keeps its shape.
  const wall = (s: Spline): Spline =>
    through(
      keysAt(
        (x) => valueAt(s, x),
        filled([...wallXs, ...s.knots.map((k) => k.end.x)]),
        p.start,
        p.end,
      ),
    );
  return {
    from: 'drawn',
    params: p,
    channels: laid.map((c) => ({
      inner: c.inner && wall(c.inner),
      outer: wall(c.outer),
      depth: through(keysAt(depthAt, depthXs, p.start, p.end)),
      wall: c.wall,
    })),
  };
};

/** Applied channels back to the numbers they were applied from, every edit dropped. */
export const resetChannels = (c: BoardChannels): BoardChannels | null =>
  c.from === 'drawn' && c.params ? { from: 'numbers', params: c.params } : null;

/** What a key on a channel moves: a wall across the board, or the depth. */
export type ChannelKeyPart = 'inner' | 'outer' | 'depth';

/**
 * `channels` with channel `k`'s `part` set to `value` at station `x` (cm out from the
 * stringer for a wall, cm deep for the depth), a key added there if it had none, the
 * change easing out to nothing at the `stations` (cross-sections) either side. A wall
 * that another channel shares (`joined`: the next one's inner wall on this one's outer)
 * moves with it, so channels side by side stay side by side.
 */
export const moveChannelKey = (
  channels: readonly BottomChannel[],
  x: number,
  k: number,
  part: ChannelKeyPart,
  value: number,
  stations: readonly number[],
  joined?: number,
): BottomChannel[] => {
  const v = Math.max(0, value);
  const set = (s: Spline) => withKeyAt(s, x, v, stations);
  return channels.map((c, i) => {
    if (i === k) {
      if (part === 'depth') return { ...c, depth: set(c.depth) };
      if (part === 'outer') return { ...c, outer: set(c.outer) };
      return c.inner ? { ...c, inner: set(c.inner) } : c;
    }
    if (i === joined && c.inner && part === 'outer') return { ...c, inner: set(c.inner) };
    return c;
  });
};
