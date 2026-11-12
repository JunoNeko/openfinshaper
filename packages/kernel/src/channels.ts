// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Bottom channels: grooves cut up into the bottom, running along the board, usually
 * through the tail. (owner request, print version)
 *
 * ## What a channel is
 *
 * Two walls drawn in plan and a depth along the board:
 *
 * - `outer` and `inner` are curves in the outline's frame: x along the board (cm from
 *   the tail), y the distance from the stringer (cm). A straight channel has straight
 *   walls; a curved one, curved walls. `inner: null` is one channel centred on the
 *   stringer, spanning both sides of it.
 * - `depth` is a curve of x against how far the bottom is cut up (cm). The channel
 *   exists where `depth` is defined and positive: it ramps in, holds, runs out.
 * - `wall` says how the bottom steps down into the channel across the board.
 *
 * Boards are symmetric, so each channel is cut on both sides of the stringer.
 *
 * ## Why walls are curves, even for straight channels
 *
 * Designers draw curved channels (the owner's reference board has one wide centred
 * channel whose walls bow out through the middle and flare to the swallow tips), and
 * straight ones are typed in as numbers. Both end up as these curves, so the loft, the
 * mesh, the STL and the tests have one shape to handle; numbers only generate it.
 *
 * ## How it reaches the hull
 *
 * Not through the cross-sections: they are sparse stations blended in between, which
 * would smear a channel's fade and could only keep its walls sharp if every station
 * had matching points on them. Instead the loft lifts each bottom point by
 * {@link channelDepthAt} (vertically: channels sit on the bottom's flat middle, where
 * the bottom is within a few degrees of level), and puts ring points exactly on the
 * walls ({@link channelAnchors}) so the walls stay crisp in the mesh. See `loft.ts`.
 *
 * Pure functions of the board, like the rest of the kernel.
 */
import { scaleSpline, valueAt, type Spline } from './bezier-spline';

/** How the bottom steps down into a channel, seen in cross-section. */
export type ChannelWall =
  /** A vertical step, the full depth at the wall. */
  | { readonly shape: 'square' }
  /** A straight ramp from the wall to full depth over `width` (cm). */
  | { readonly shape: 'bevel'; readonly width: number }
  /** A quarter round from the wall to full depth over `radius` (cm). */
  | { readonly shape: 'round'; readonly radius: number }
  /** A smooth scoop: no step at either wall, deepest in the middle. */
  | { readonly shape: 'scoop' };

export interface BottomChannel {
  /** The wall nearer the stringer, or null: a channel centred on the stringer. */
  readonly inner: Spline | null;
  /** The wall nearer the rail. */
  readonly outer: Spline;
  /** Depth into the bottom (cm) against x; the channel's length is this curve's. */
  readonly depth: Spline;
  readonly wall: ChannelWall;
}

/** A spline's x span, whichever way it was drawn. */
export const splineSpan = (s: Spline): readonly [number, number] => {
  const a = s.knots[0]?.end.x ?? 0;
  const b = s.knots[s.knots.length - 1]?.end.x ?? 0;
  return a <= b ? [a, b] : [b, a];
};

/** `s` at `x`, held at its end value beyond either end. */
const heldAt = (s: Spline, x: number): number => {
  const [a, b] = splineSpan(s);
  return valueAt(s, Math.min(b, Math.max(a, x)));
};

/** Where a channel is at station `x`: its walls (y, cm) and depth, or null where it isn't. */
interface ChannelAtX {
  /** Inner wall, or null for a channel centred on the stringer. */
  readonly yi: number | null;
  readonly yo: number;
  readonly depth: number;
}

/** The channel's full depth at `x` (0 outside its length). */
export const channelFullDepth = (c: BottomChannel, x: number): number => {
  const [a, b] = splineSpan(c.depth);
  if (x < a || x > b) return 0;
  const d = valueAt(c.depth, x);
  return Number.isFinite(d) && d > 0 ? d : 0;
};

/** The walls at `x`, whether or not the channel has depth there (for anchors). */
const wallsAt = (c: BottomChannel, x: number): { yi: number | null; yo: number } => {
  const yo = Math.max(0, heldAt(c.outer, x));
  const yi = c.inner ? Math.min(yo, Math.max(0, heldAt(c.inner, x))) : null;
  return { yi, yo };
};

const at = (c: BottomChannel, x: number): ChannelAtX => ({
  ...wallsAt(c, x),
  depth: channelFullDepth(c, x),
});

/** The share of full depth at distance `d` (cm) in from the nearer wall, `u` ∈ [0, 1] across. */
const wallShare = (wall: ChannelWall, d: number, u: number): number => {
  switch (wall.shape) {
    case 'square':
      return 1;
    case 'bevel':
      return wall.width > 0 ? Math.min(1, d / wall.width) : 1;
    case 'round': {
      if (!(wall.radius > 0) || d >= wall.radius) return 1;
      const t = 1 - d / wall.radius;
      return Math.sqrt(Math.max(0, 1 - t * t));
    }
    case 'scoop':
      return Math.sin(Math.PI * Math.min(1, Math.max(0, u)));
  }
};

/**
 * How far the bottom is cut up (cm) at station `x`, distance `y` from the stringer
 * (either side). 0 outside every channel. Where channels overlap, the deeper wins.
 */
export const channelDepthAt = (
  channels: readonly BottomChannel[],
  x: number,
  y: number,
): number => {
  const ay = Math.abs(y);
  let out = 0;
  for (const c of channels) {
    const { yi, yo, depth } = at(c, x);
    if (depth <= 0) continue;
    if (yi === null) {
      // Centred: one channel from -yo to yo, its only walls the outer ones.
      if (ay > yo) continue;
      const d = yo - ay;
      const u = 0.5 + (0.5 * ay) / Math.max(yo, 1e-9); // the middle is u = 0.5
      out = Math.max(out, depth * wallShare(c.wall, d, u));
    } else {
      if (ay < yi || ay > yo || yo - yi <= 0) continue;
      const d = Math.min(ay - yi, yo - ay);
      const u = (ay - yi) / (yo - yi);
      out = Math.max(out, depth * wallShare(c.wall, d, u));
    }
  }
  return out;
};

/** Points spread across a channel's floor, besides those its walls need. */
export const CHANNEL_FLOOR_POINTS = 6;

/**
 * A square wall is a vertical step: two ring points this far (cm) either side of it,
 * one on the bottom and one on the channel floor. 1 µm: vertical to any machine.
 */
export const SQUARE_WALL_GAP = 1e-4;

/** Where a rounded wall gets points, as shares of its radius in from the wall. */
const ROUND_STOPS = [0, 0.05, 0.2, 0.45, 1] as const;

/** Offsets (cm) in from a wall that need a ring point, for its shape. */
const wallStops = (wall: ChannelWall): readonly number[] => {
  switch (wall.shape) {
    case 'square':
      return [-SQUARE_WALL_GAP, SQUARE_WALL_GAP];
    case 'bevel':
      return [0, wall.width];
    case 'round':
      return ROUND_STOPS.map((s) => s * wall.radius);
    case 'scoop':
      return [0];
  }
};

/**
 * The distances from the stringer (cm, ascending) at which the ring at station `x`
 * needs a point for the channels to be cut true: on each wall (both sides of a square
 * one), across a bevel or round, and spread over each floor.
 *
 * The COUNT never depends on `x`: the mesh joins neighbouring rings point by point, so
 * every ring needs the same number in the same order. A channel is anchored even where
 * it has no depth (its walls held at their end values), and those points simply sit on
 * the uncut bottom.
 */
export const channelAnchors = (channels: readonly BottomChannel[], x: number): number[] => {
  const ys: number[] = [];
  for (const c of channels) {
    const { yi, yo } = wallsAt(c, x);
    const lo = yi ?? 0;
    const inside = (y: number) => Math.min(yo + SQUARE_WALL_GAP, Math.max(lo - SQUARE_WALL_GAP, y));
    for (const s of wallStops(c.wall)) {
      ys.push(inside(yo - s));
      if (yi !== null) ys.push(inside(yi + s));
    }
    for (let k = 1; k <= CHANNEL_FLOOR_POINTS; k++) {
      ys.push(lo + ((yo - lo) * k) / (CHANNEL_FLOOR_POINTS + 1));
    }
  }
  return ys.map((y) => Math.max(0, y)).sort((a, b) => a - b);
};

/** Samples along a channel's length when checking it. */
const CHECK_SAMPLES = 64;

/**
 * What is wrong with `channels` on a board whose half-width at x is `halfWidth(x)` and
 * thickness `thickness(x)`, said for the person drawing them. Empty when they can be cut.
 */
export const channelProblems = (
  channels: readonly BottomChannel[],
  halfWidth: (x: number) => number,
  thickness: (x: number) => number,
): string[] => {
  const out: string[] = [];
  channels.forEach((c, i) => {
    const name = `Channel ${i + 1}`;
    const runsLengthways = (s: Spline) => {
      const xs = s.knots.map((k) => k.end.x);
      const up = xs.every((v, j) => j === 0 || v > xs[j - 1]!);
      const down = xs.every((v, j) => j === 0 || v < xs[j - 1]!);
      return xs.length >= 2 && (up || down);
    };
    if (!runsLengthways(c.outer) || (c.inner && !runsLengthways(c.inner))) {
      out.push(`${name}: each wall must run along the board, one point across at each station.`);
      return;
    }
    const [a, b] = splineSpan(c.depth);
    if (!(b > a)) {
      out.push(`${name} has no length.`);
      return;
    }
    let crossed = false;
    let offBottom = false;
    let tooDeep = false;
    for (let k = 0; k <= CHECK_SAMPLES; k++) {
      const x = a + ((b - a) * k) / CHECK_SAMPLES;
      const { yi, yo, depth } = at(c, x);
      if (yi !== null && yi >= yo) crossed = true;
      if (depth > 0 && yo >= halfWidth(x)) offBottom = true;
      if (depth > 0 && depth >= thickness(x) / 2) tooDeep = true;
    }
    if (crossed) out.push(`${name}: its walls cross.`);
    if (offBottom) out.push(`${name} runs off the bottom: keep its outer wall inside the rail.`);
    if (tooDeep) out.push(`${name} is deeper than half the board's thickness.`);
  });
  return out;
};

/** A wall's size scaled across the board by `fW`. */
export const scaleWall = (w: ChannelWall, fW: number): ChannelWall =>
  w.shape === 'bevel'
    ? { shape: 'bevel', width: w.width * fW }
    : w.shape === 'round'
      ? { shape: 'round', radius: w.radius * fW }
      : w;

/** `channels` on a board scaled by `fL` along, `fW` across and `fT` in thickness. */
export const scaleChannels = (
  channels: readonly BottomChannel[],
  fL: number,
  fW: number,
  fT: number,
): BottomChannel[] =>
  channels.map((c) => ({
    inner: c.inner && scaleSpline(c.inner, fW, fL),
    outer: scaleSpline(c.outer, fW, fL),
    depth: scaleSpline(c.depth, fT, fL),
    wall: scaleWall(c.wall, fW),
  }));
