// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Channels typed in as numbers, and the board's channels whichever way they were made.
 *
 * A board's channels are one of two things (`BezierBoard.channels`):
 *
 * - **numbers** ({@link ChannelParams}): how many, how deep, how long, where across. The
 *   wall and depth curves are generated from them and the board each time
 *   ({@link layoutChannels}), so channels set to follow the outline follow it as the
 *   outline is edited.
 * - **drawn**: the curves themselves, once a wall has been reshaped by hand. The numbers
 *   they started from are kept, for the parts that still apply (depth, wall shape).
 *
 * Either way the loft sees curves (`channels.ts`): straight channels are just straight
 * walls.
 */
import { splineFromKnots, type Spline } from './bezier-spline';
import { getLength, getThicknessAtPos, getWidthAtPos, type BezierBoard } from './board';
import {
  channelProblems,
  scaleChannels,
  scaleWall,
  type BottomChannel,
  type ChannelWall,
} from './channels';
import { knot } from './knot';
import { vec2 } from './vec2';

/** How typed-in channels sit across the board. */
export type ChannelLayout =
  /** Straight, parallel to the stringer. */
  | 'parallel'
  /** Each wall keeps its share of the board's half-width, so the channels follow the outline. */
  | 'outline';

/** Channels as a shaper types them in. Lengths in cm. */
export interface ChannelParams {
  /** How many across the whole board: an odd count puts one on the stringer. */
  readonly count: number;
  readonly layout: ChannelLayout;
  /** How deep they are cut. */
  readonly depth: number;
  /** Where they end toward the tail, from the tail: 0 runs them out through it. */
  readonly tailEnd: number;
  /** Where they end toward the nose, from the tail. */
  readonly length: number;
  /** Over how much of their front end the depth fades in. */
  readonly runIn: number;
  /** From the stringer to the first wall (an even count; an odd one starts on the stringer). */
  readonly inner: number;
  /** From the rail to the outermost wall, where the channels end at the tail. */
  readonly railMargin: number;
  /** The flat bottom left between neighbouring channels. */
  readonly land: number;
  readonly wall: ChannelWall;
}

/** A board's channels: typed in, or drawn. */
export type BoardChannels =
  | { readonly from: 'numbers'; readonly params: ChannelParams }
  | {
      readonly from: 'drawn';
      readonly channels: readonly BottomChannel[];
      /** The numbers they were generated from, if they were. */
      readonly params?: ChannelParams;
    };

/** Most channels the dialog offers. */
export const MAX_CHANNELS = 9;

/** A start for typed-in channels on `b`: four, a hand's width either side of the stringer. */
export const defaultChannelParams = (b: BezierBoard): ChannelParams => {
  const L = getLength(b);
  // From where the tail has some width: a pointed tail has none at x = 0.
  let tailEnd = 0;
  while (tailEnd < L / 4 && getWidthAtPos(b, tailEnd) < getWidthAtPos(b, L / 2) * 0.55) {
    tailEnd += 1;
  }
  return {
    count: 4,
    layout: 'parallel',
    depth: 0.5,
    tailEnd,
    length: Math.min(L * 0.4, tailEnd + 75),
    runIn: 20,
    inner: 3,
    railMargin: 4,
    land: 1.5,
    wall: { shape: 'square' },
  };
};

/** Where the layout is measured across the board: where the channels end at the tail. */
const referenceX = (b: BezierBoard, p: ChannelParams): number =>
  Math.min(getLength(b), Math.max(0, p.tailEnd));

/** The walls across the board at the reference station: [inner or null, outer] per side channel. */
const wallsAcross = (
  halfWidth: number,
  p: ChannelParams,
): { readonly yi: number | null; readonly yo: number }[] => {
  const n = Math.round(p.count);
  if (!(n >= 1)) return [];
  const perSide = Math.floor(n / 2);
  const reach = halfWidth - p.railMargin;
  const out: { yi: number | null; yo: number }[] = [];
  if (n % 2 === 1) {
    // A centred channel as wide as the rest: half of it each side of the stringer.
    const half = (reach - perSide * p.land) / (1 + 2 * perSide);
    if (!(half > 0)) return [];
    out.push({ yi: null, yo: half });
    for (let k = 0; k < perSide; k++) {
      const yi = half + p.land + k * (2 * half + p.land);
      out.push({ yi, yo: yi + 2 * half });
    }
  } else {
    const w = (reach - p.inner - (perSide - 1) * p.land) / perSide;
    if (!(w > 0)) return [];
    for (let k = 0; k < perSide; k++) {
      const yi = p.inner + k * (w + p.land);
      out.push({ yi, yo: yi + w });
    }
  }
  return out;
};

/** Knots along a wall that follows the outline. */
const OUTLINE_WALL_KNOTS = 9;

/** A smooth curve through `pts` (Catmull-Rom tangents as Bézier handles). */
const smoothThrough = (pts: readonly (readonly [number, number])[]): Spline =>
  splineFromKnots(
    pts.map(([x, y], i) => {
      const p = pts[i - 1] ?? pts[i]!;
      const n = pts[i + 1] ?? pts[i]!;
      const tx = (n[0] - p[0]) / 6;
      const ty = (n[1] - p[1]) / 6;
      return knot(vec2(x, y), vec2(x - tx, y - ty), vec2(x + tx, y + ty), true);
    }),
  );

const straightWall = (x0: number, x1: number, y: number): Spline =>
  splineFromKnots([
    knot(vec2(x0, y), vec2(x0, y), vec2(x0 + (x1 - x0) / 3, y), true),
    knot(vec2(x1, y), vec2(x1 - (x1 - x0) / 3, y), vec2(x1, y), true),
  ]);

/** Full depth from the tail end, easing out to nothing over the run-in at the front. */
const depthCurve = (p: ChannelParams): Spline => {
  const x0 = p.tailEnd;
  const x1 = p.length;
  const xr = Math.max(x0, x1 - Math.max(0, p.runIn));
  const d = p.depth;
  const knots = [knot(vec2(x0, d), vec2(x0, d), vec2(x0 + (xr - x0) / 3, d), true)];
  if (xr > x0) {
    knots.push(knot(vec2(xr, d), vec2(xr - (xr - x0) / 3, d), vec2(xr + (x1 - xr) / 3, d), true));
  } else {
    knots[0] = knot(vec2(x0, d), vec2(x0, d), vec2(x0 + (x1 - x0) / 3, d), true);
  }
  // Flat handles both ends of the fade: it eases in rather than starting with a kink.
  knots.push(knot(vec2(x1, 0), vec2(x1 - (x1 - xr) / 3, 0), vec2(x1, 0), true));
  return splineFromKnots(knots);
};

/** The curves for typed-in channels on board `b`; none if they don't fit. */
export const layoutChannels = (b: BezierBoard, p: ChannelParams): BottomChannel[] => {
  if (!(p.length > p.tailEnd) || !(p.depth > 0)) return [];
  const half = (x: number) => getWidthAtPos(b, x) / 2;
  const xRef = referenceX(b, p);
  const wRef = half(xRef);
  const across = wallsAcross(wRef, p);
  if (!across.length || !(wRef > 0)) return [];
  const depth = depthCurve(p);
  const wall = (y: number): Spline => {
    if (p.layout === 'parallel') return straightWall(p.tailEnd, p.length, y);
    const pts: [number, number][] = [];
    for (let i = 0; i < OUTLINE_WALL_KNOTS; i++) {
      const x = p.tailEnd + ((p.length - p.tailEnd) * i) / (OUTLINE_WALL_KNOTS - 1);
      pts.push([x, (y * half(x)) / wRef]);
    }
    return smoothThrough(pts);
  };
  return across.map(({ yi, yo }) => ({
    inner: yi === null ? null : wall(yi),
    outer: wall(yo),
    depth,
    wall: p.wall,
  }));
};

const LAYOUT_CACHE = new WeakMap<BezierBoard, readonly BottomChannel[]>();

/** The channels cut into `b`, as curves: none unless it has some. Memoised per board. */
export const boardChannels = (b: BezierBoard): readonly BottomChannel[] => {
  const c = b.channels;
  if (!c) return [];
  if (c.from === 'drawn') return c.channels;
  let hit = LAYOUT_CACHE.get(b);
  if (!hit) {
    hit = layoutChannels(b, c.params);
    LAYOUT_CACHE.set(b, hit);
  }
  return hit;
};

/** What is wrong with `b`'s channels, said for the person making them. Empty if nothing. */
export const boardChannelProblems = (b: BezierBoard): string[] => {
  const c = b.channels;
  if (!c) return [];
  if (c.from === 'numbers') {
    const p = c.params;
    if (!(p.depth > 0)) return ['Channels need some depth.'];
    if (!(p.length > p.tailEnd)) return ['Channels must end further up the board than they start.'];
    if (!layoutChannels(b, p).length) {
      return [
        `${Math.round(p.count)} channels don't fit across the bottom where they end at the tail: ` +
          'start them further up, or make the lands, margin or inner offset smaller.',
      ];
    }
  }
  return channelProblems(
    boardChannels(b),
    (x) => getWidthAtPos(b, x) / 2,
    (x) => getThicknessAtPos(b, x),
  );
};

/** `p` on a board scaled by `fL` along, `fW` across and `fT` in thickness. */
const scaleParams = (p: ChannelParams, fL: number, fW: number, fT: number): ChannelParams => ({
  ...p,
  depth: p.depth * fT,
  tailEnd: p.tailEnd * fL,
  length: p.length * fL,
  runIn: p.runIn * fL,
  inner: p.inner * fW,
  railMargin: p.railMargin * fW,
  land: p.land * fW,
  wall: scaleWall(p.wall, fW),
});

/** A board's channels scaled with it. */
export const scaleBoardChannels = (
  c: BoardChannels,
  fL: number,
  fW: number,
  fT: number,
): BoardChannels =>
  c.from === 'numbers'
    ? { from: 'numbers', params: scaleParams(c.params, fL, fW, fT) }
    : {
        from: 'drawn',
        channels: scaleChannels(c.channels, fL, fW, fT),
        ...(c.params ? { params: scaleParams(c.params, fL, fW, fT) } : {}),
      };
