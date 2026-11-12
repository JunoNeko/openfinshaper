// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { valueAt } from './bezier-spline';
import { board, getWidthAtPos, type BezierBoard } from './board';
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
});
