// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { splineFromKnots, valueAt } from './bezier-spline';
import { board, getLength, getWidthAtPos, type BezierBoard } from './board';
import { knot, knotFromArray } from './knot';
import { vec2 } from './vec2';
import {
  boardChannelProblems,
  boardChannels,
  defaultChannelParams,
  layoutChannels,
  scaleBoardChannels,
  type ChannelParams,
} from './channel-layout';
import { channelDepthAt } from './channels';
import { tessellateBoard } from './tessellate';
import { parseBrdGeometry } from './test-support/brd-geometry';

const here = dirname(fileURLToPath(import.meta.url));
const shortboard = parseBrdGeometry(
  readFileSync(resolve(here, '../../../docs/specs/golden/shortboard.brd'), 'utf8'),
);

const P: ChannelParams = {
  count: 4,
  layout: 'parallel',
  depth: 0.5,
  tailEnd: 15,
  length: 75,
  runIn: 20,
  inner: 3,
  railMargin: 4,
  land: 1.5,
  frontSpread: 1,
  frontWidth: 1,
  wall: { shape: 'square' },
};
const typed = (p: Partial<ChannelParams> = {}): BezierBoard => {
  const b = shortboard;
  return board(b.outline, b.bottom, b.deck, b.crossSections, b.interpolationType, b.fins, {
    from: 'numbers',
    params: { ...P, ...p },
  });
};
const half = (x: number) => getWidthAtPos(shortboard, x) / 2;
const wallsAt = (b: BezierBoard, x: number) =>
  boardChannels(b).map((c) => [c.inner && valueAt(c.inner, x), valueAt(c.outer, x)]);

describe('typed-in channels', () => {
  it('lay four out from the inner offset to the rail margin, lands between, at the tail end', () => {
    const w = wallsAt(typed(), 15) as [number, number][];
    const [i1, o1] = w[0]!;
    const [i2, o2] = w[1]!;
    expect(i1).toBeCloseTo(3, 9);
    expect(i2! - o1!).toBeCloseTo(1.5, 9); // the land
    expect(o2).toBeCloseTo(half(15) - 4, 9); // the rail margin
    expect(o1! - i1!).toBeCloseTo(o2! - i2!, 9); // equal widths
  });

  it('put an odd one on the stringer, as wide as the others', () => {
    const cs = boardChannels(typed({ count: 5 }));
    expect(cs).toHaveLength(3);
    expect(cs[0]!.inner).toBeNull();
    const centre = 2 * valueAt(cs[0]!.outer, 15);
    const side = valueAt(cs[1]!.outer, 15) - valueAt(cs[1]!.inner!, 15);
    expect(centre).toBeCloseTo(side, 9);
    expect(valueAt(cs[1]!.inner!, 15) - valueAt(cs[0]!.outer, 15)).toBeCloseTo(1.5, 9);
  });

  it('run parallel to the stringer, or keep their share of the width along the outline', () => {
    const [pi] = wallsAt(typed(), 60)[0]!;
    expect(pi).toBeCloseTo(3, 9);
    const share = (x: number) =>
      (wallsAt(typed({ layout: 'outline' }), x)[1]![1] as number) / half(x);
    expect(share(60)).toBeCloseTo(share(15), 2);
    expect(share(40)).toBeCloseTo(share(15), 2);
  });

  it('are full depth from the tail end, fading in smoothly to nothing at the front', () => {
    const cs = boardChannels(typed());
    const d = (x: number) => channelDepthAt(cs, x, 4);
    expect(d(15)).toBeCloseTo(0.5, 9);
    expect(d(55)).toBeCloseTo(0.5, 9);
    expect(d(75)).toBeCloseTo(0, 9);
    expect(d(65)).toBeGreaterThan(0.1);
    expect(d(65)).toBeLessThan(0.4);
    for (let x = 55; x < 75; x += 1) expect(d(x + 1)).toBeLessThanOrEqual(d(x) + 1e-12);
    expect(d(14)).toBe(0);
  });

  it('say when they do not fit, and cut nothing', () => {
    const b = typed({ count: 8, land: 4 });
    expect(boardChannels(b)).toEqual([]);
    expect(boardChannelProblems(b)[0]).toMatch(/don't fit across the bottom/);
  });

  it('start sensibly on a board, with no problems', () => {
    const b = shortboard;
    const p = defaultChannelParams(b);
    // The golden shortboard comes to a point: the defaults start where it has width.
    expect(p.tailEnd).toBeGreaterThan(0);
    const withDefaults = board(b.outline, b.bottom, b.deck, b.crossSections, b.interpolationType, b.fins, { from: 'numbers', params: p }); // prettier-ignore
    expect(boardChannelProblems(withDefaults)).toEqual([]);
    expect(boardChannels(withDefaults)).toHaveLength(2);
  });

  it('cut the same hull as the same curves drawn', () => {
    const b = typed();
    const drawn = board(b.outline, b.bottom, b.deck, b.crossSections, b.interpolationType, b.fins, { from: 'drawn', channels: layoutChannels(b, b.channels!.from === 'numbers' ? b.channels!.params : P) }); // prettier-ignore
    const opts = { lengthSteps: 30, ringSteps: 32 };
    expect(tessellateBoard(drawn, opts).positions).toEqual(tessellateBoard(b, opts).positions);
  });

  it('scale with the board', () => {
    const s = scaleBoardChannels({ from: 'numbers', params: P }, 2, 1.5, 0.5);
    expect(s).toEqual({
      from: 'numbers',
      params: { ...P, depth: 0.25, tailEnd: 30, length: 150, runIn: 40, inner: 4.5, railMargin: 6, land: 2.25 }, // prettier-ignore
    });
  });

  it('set side by side from the stringer: steps that abut, no land, no inner offset', () => {
    const b = typed({ inner: 0, land: 0, wall: { shape: 'step', radius: 0 } });
    const w = wallsAt(b, 20) as [number, number][];
    const [i1, o1] = w[0]!;
    const [i2, o2] = w[1]!;
    expect(i1).toBe(0);
    expect(i2).toBeCloseTo(o1!, 9);
    expect(o2).toBeCloseTo(half(15) - 4, 9);
    const cs = boardChannels(b);
    expect(channelDepthAt(cs, 20, o1! - 1e-3)).toBeCloseTo(0.5, 2); // deep at the wall
    expect(channelDepthAt(cs, 20, o1! + 1e-3)).toBeCloseTo(0, 2); // the next starts afresh
  });

  it('fan out toward the tail and start as points, when asked', () => {
    const b = typed({ frontSpread: 0.6, frontWidth: 0 });
    const cs = boardChannels(b);
    const tail = wallsAt(b, 15) as [number, number][];
    const front = wallsAt(b, 75) as [number, number][];
    cs.forEach((_, k) => {
      const centre = (tail[k]![0] + tail[k]![1]) / 2;
      expect(front[k]![0]).toBeCloseTo(front[k]![1], 9); // a point
      expect(front[k]![0]).toBeCloseTo(centre * 0.6, 9); // nearer the stringer
    });
    // Halfway, half as much narrower.
    const mid = wallsAt(b, 45) as [number, number][];
    expect(mid[0]![1] - mid[0]![0]).toBeCloseTo((tail[0]![1] - tail[0]![0]) / 2, 9);
    expect(boardChannelProblems(b)).toEqual([]);
  });
});

describe('the default channels', () => {
  it('run out through a tail wide enough, as steps side by side', () => {
    const L = getLength(shortboard);
    const third = (ax: number, ay: number, bx: number, by: number): [number, number] => [
      ax + (bx - ax) / 3,
      ay + (by - ay) / 3,
    ];
    // A swallow 18 cm wide at the tips: wide enough for channels to run out.
    const swallow = splineFromKnots([
      knotFromArray([18, 0, 18, 0, ...third(18, 0, 0, 9)], false, false),
      knotFromArray([0, 9, ...third(0, 9, 18, 0), ...third(0, 9, 90, 23.5)], false, false),
      knotFromArray([90, 23.5, ...third(90, 23.5, 0, 9), ...third(90, 23.5, L, 0)], false, false),
      knotFromArray([L, 0, ...third(L, 0, 90, 23.5), L, 0], false, false),
    ]);
    const s = shortboard;
    // The golden deck meets the bottom at the tail; a real tail is a couple of cm thick.
    const deck = splineFromKnots(
      s.deck.knots.map((k) =>
        knot(
          vec2(k.end.x, k.end.y + 2),
          vec2(k.tangentToPrev.x, k.tangentToPrev.y + 2),
          vec2(k.tangentToNext.x, k.tangentToNext.y + 2),
          k.continuous,
        ),
      ),
    );
    const fish = board(swallow, s.bottom, deck, s.crossSections, s.interpolationType, s.fins);
    const p = defaultChannelParams(fish);
    expect(p.tailEnd).toBe(0);
    expect(p.wall).toEqual({ shape: 'step', radius: 0 });
    expect([p.inner, p.land, p.frontWidth]).toEqual([0, 0, 0]);
    const cut = board(swallow, s.bottom, deck, s.crossSections, s.interpolationType, s.fins, { from: 'numbers', params: p }); // prettier-ignore
    expect(boardChannelProblems(cut)).toEqual([]);
    const mesh = tessellateBoard(cut, { lengthSteps: 40, ringSteps: 40 });
    expect(mesh.positions.every(Number.isFinite)).toBe(true);
  });
});
