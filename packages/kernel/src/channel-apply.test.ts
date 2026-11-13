// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { valueAt } from './bezier-spline';
import { board, type BezierBoard } from './board';
import { applyChannels, moveChannelKey, resetChannels } from './channel-apply';
import {
  boardChannelProblems,
  boardChannels,
  type BoardChannels,
  type ChannelParams,
} from './channel-layout';
import { channelDepthAt } from './channels';
import { channelKeys } from './loft';
import { tessellateBoard } from './tessellate';
import { parseBrdGeometry } from './test-support/brd-geometry';

const here = dirname(fileURLToPath(import.meta.url));
const shortboard = parseBrdGeometry(
  readFileSync(resolve(here, '../../../docs/specs/golden/shortboard.brd'), 'utf8'),
);
const withChannels = (channels: BoardChannels): BezierBoard => {
  const b = shortboard;
  return board(b.outline, b.bottom, b.deck, b.crossSections, b.interpolationType, b.fins, channels); // prettier-ignore
};

const P: ChannelParams = {
  count: 4,
  wall: { shape: 'step', radius: 0, lip: 0.2 },
  width: 4,
  depth: 0.5,
  inner: 3,
  follow: 0.6,
  start: 15,
  end: 120,
  station: 40,
  fullFrom: 20,
  fullTo: 70,
};
/** The golden shortboard's real cross-sections inside the channels. */
const stations = shortboard.crossSections.slice(1, -1).map((cs) => cs.position);
const inside = stations.filter((x) => x > P.start && x < P.end);
const typed = withChannels({ from: 'numbers', params: P });
const applied = withChannels(applyChannels(typed, P, stations));

describe('applying typed-in channels', () => {
  it('has cross-sections to put keys on', () => {
    expect(inside.length).toBeGreaterThanOrEqual(2);
  });

  it('cuts the same channels, the walls within 0.3 mm', () => {
    const a = boardChannels(typed);
    const c = boardChannels(applied);
    let worst = 0;
    for (let x = 15; x <= 120; x += 2.5) {
      for (let y = 0; y <= 13; y += 0.25) {
        worst = Math.max(worst, Math.abs(channelDepthAt(a, x, y) - channelDepthAt(c, x, y)));
      }
    }
    // Walls that follow the outline are rebuilt through the keys: a wall a fraction of a
    // millimetre off moves the cut by the full depth right at it, so the walls themselves
    // are what to compare.
    for (let x = 15; x <= 120; x += 2.5) {
      for (const [ca, cc] of a.map((ch, i) => [ch, c[i]!] as const)) {
        expect(Math.abs(valueAt(ca.outer, x) - valueAt(cc.outer, x))).toBeLessThan(0.03);
      }
    }
    expect(worst).toBeLessThanOrEqual(0.5);
    expect(boardChannelProblems(applied)).toEqual([]);
  });

  it('puts a key on every wall and depth at each cross-section inside them', () => {
    for (const c of boardChannels(applied)) {
      const xs = (s: typeof c.outer) => s.knots.map((k) => k.end.x);
      for (const x of inside) {
        expect(xs(c.outer)).toContain(x);
        expect(xs(c.depth)).toContain(x);
        if (c.inner) expect(xs(c.inner)).toContain(x);
      }
    }
  });

  it('keeps the numbers, so reset goes back to them', () => {
    expect(resetChannels(applied.channels!)).toEqual({ from: 'numbers', params: P });
    expect(resetChannels(typed.channels!)).toBeNull();
  });
});

describe('channel keys at a cross-section', () => {
  const x = inside[0]!;

  it("are a point on each wall and at each channel's deepest, side-by-side walls shared", () => {
    const keys = channelKeys(applied, x);
    expect(keys.map((k) => k.id)).toEqual(['i0', 'o0', 'd0', 'o1', 'd1']);
    expect(keys.find((k) => k.id === 'o0')!.joined).toBe(1);
    const c = boardChannels(applied)[1]!;
    expect(keys.find((k) => k.id === 'o1')!.value).toBeCloseTo(valueAt(c.outer, x), 9);
    expect(keys.find((k) => k.id === 'd1')!.value).toBeCloseTo(valueAt(c.depth, x), 9);
    expect(channelKeys(typed, x)).toEqual([]); // apply first
  });

  it('move a shared wall: both channels follow, easing out to the cross-sections either side', () => {
    const cs = boardChannels(applied);
    const o0 = valueAt(cs[0]!.outer, x);
    const moved = moveChannelKey(cs, x, 0, 'outer', o0 + 1, stations, 1);
    const shift = (v: number) => valueAt(moved[0]!.outer, v) - valueAt(cs[0]!.outer, v);
    expect(shift(x)).toBeCloseTo(1, 9);
    expect(valueAt(moved[1]!.inner!, x)).toBeCloseTo(o0 + 1, 9);
    // Out to the next cross-section (or the start), easing smoothly.
    const before = Math.max(P.start, ...stations.filter((v) => v < x));
    const after = inside[1]!;
    expect(shift(before)).toBeCloseTo(0, 9);
    expect(shift(after)).toBeCloseTo(0, 9);
    expect(shift(after + 5)).toBeCloseTo(0, 9);
    const steps = 20;
    let last = 1;
    for (let j = 1; j < steps; j++) {
      const s = shift(x + ((after - x) * j) / steps);
      expect(s).toBeLessThanOrEqual(last + 1e-3);
      expect(s).toBeGreaterThan(-1e-3);
      last = s;
    }
    expect(shift((x + after) / 2)).toBeGreaterThan(0.3);
    expect(shift((x + after) / 2)).toBeLessThan(0.7);
  });

  it('move a depth, adding a key where a cross-section has none yet', () => {
    const cs = boardChannels(applied);
    const at = (inside[0]! + inside[1]!) / 2;
    const moved = moveChannelKey(cs, at, 1, 'depth', 0.8, stations);
    expect(valueAt(moved[1]!.depth, at)).toBeCloseTo(0.8, 9);
    expect(valueAt(moved[0]!.depth, at)).toBeCloseTo(valueAt(cs[0]!.depth, at), 9);
    const b = withChannels({ from: 'drawn', channels: moved, params: P });
    const mesh = tessellateBoard(b, { lengthSteps: 40, ringSteps: 40 });
    expect(mesh.positions.every(Number.isFinite)).toBe(true);
  });
});
