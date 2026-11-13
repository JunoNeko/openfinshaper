// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { board, getLength, getThicknessAtPos, getWidthAtPos, type BezierBoard } from './board';
import { splineFromKnots } from './bezier-spline';
import {
  CHANNEL_FLOOR_POINTS,
  SQUARE_WALL_GAP,
  channelAnchors,
  channelDepthAt,
  channelProblems,
  scaleChannels,
  type BottomChannel,
  type ChannelWall,
} from './channels';
import { knotFromArray } from './knot';
import { loftRing } from './loft';
import { hasTailCutout } from './outline-cutout';
import { bottomZAt } from './surface';
import { tessellateBoard, type BoardMesh } from './tessellate';
import { parseBrdGeometry } from './test-support/brd-geometry';
import { polylineSpline } from './test-support/synthetic-boards';

const here = dirname(fileURLToPath(import.meta.url));
const golden = resolve(here, '../../../docs/specs/golden');
const shortboard = parseBrdGeometry(readFileSync(resolve(golden, 'shortboard.brd'), 'utf8'));

const withChannels = (b: BezierBoard, channels: BottomChannel[]): BezierBoard =>
  board(b.outline, b.bottom, b.deck, b.crossSections, b.interpolationType, b.fins, {
    from: 'drawn',
    channels,
  });

/**
 * A straight channel `yi`–`yo` cm out, full `depth` from `start` to `hold`, out by `end`.
 * Starting 10 cm up: the golden shortboard comes to a point at the tail.
 */
const straight = (
  yi: number | null,
  yo: number,
  depth: number,
  wall: ChannelWall = { shape: 'square' },
  hold = 40,
  end = 60,
  start = 10,
): BottomChannel => ({
  inner:
    yi === null
      ? null
      : polylineSpline([
          [start, yi],
          [end, yi],
        ]),
  outer: polylineSpline([
    [start, yo],
    [end, yo],
  ]),
  depth: polylineSpline([
    [start, depth],
    [hold, depth],
    [end, 0],
  ]),
  wall,
});

describe('channel depth across the board', () => {
  const at = (wall: ChannelWall, y: number, inner: number | null = 4) =>
    channelDepthAt([straight(inner, 10, 0.5, wall)], 20, y);

  it('is the full depth between square walls, and nothing outside them, either side', () => {
    expect(at({ shape: 'square' }, 4.01)).toBe(0.5);
    expect(at({ shape: 'square' }, -7)).toBe(0.5);
    expect(at({ shape: 'square' }, 3.99)).toBe(0);
    expect(at({ shape: 'square' }, 10.01)).toBe(0);
  });

  it('ramps across a bevel, and rounds into a round wall', () => {
    expect(at({ shape: 'bevel', width: 1 }, 4.5)).toBeCloseTo(0.25, 12);
    expect(at({ shape: 'bevel', width: 1 }, 7)).toBe(0.5);
    // A quarter round: vertical at the wall, level at the radius.
    expect(at({ shape: 'round', radius: 1 }, 4)).toBe(0);
    expect(at({ shape: 'round', radius: 1 }, 4.5)).toBeCloseTo(0.5 * Math.sqrt(0.75), 12);
    expect(at({ shape: 'round', radius: 1 }, 5)).toBe(0.5);
  });

  it('scoops: nothing at the walls, deepest midway', () => {
    expect(at({ shape: 'scoop' }, 4)).toBeCloseTo(0, 12);
    expect(at({ shape: 'scoop' }, 7)).toBeCloseTo(0.5, 12);
    // Centred on the stringer: deepest on it.
    expect(at({ shape: 'scoop' }, 0, null)).toBeCloseTo(0.5, 12);
    expect(at({ shape: 'scoop' }, 10, null)).toBeCloseTo(0, 12);
  });

  it('follows the depth curve along the board, and stops where it ends', () => {
    const c = [straight(4, 10, 0.5)];
    expect(channelDepthAt(c, 20, 7)).toBe(0.5);
    expect(channelDepthAt(c, 50, 7)).toBeCloseTo(0.25, 9);
    expect(channelDepthAt(c, 61, 7)).toBe(0);
  });
});

describe("the common sections, side by side (the owner's reference drawing)", () => {
  /** Two channels a side from the stringer to 12 cm out, abutting, 0.4 deep. */
  const pair = (wall: ChannelWall) => [straight(0, 6, 0.4, wall), straight(6, 12, 0.4, wall)];
  const d = (wall: ChannelWall, y: number) => channelDepthAt(pair(wall), 20, y);

  it('steps: deepest at the rail-side wall, ramping straight back to nothing at the stringer side', () => {
    const step: ChannelWall = { shape: 'step', radius: 0, lip: 0 };
    expect(d(step, 0.001)).toBeCloseTo(0, 3);
    expect(d(step, 3)).toBeCloseTo(0.2, 9);
    expect(d(step, 5.999)).toBeCloseTo(0.4, 3);
    // Over the wall: the next channel starts again from nothing.
    expect(d(step, 6.001)).toBeCloseTo(0, 3);
    expect(d(step, 9)).toBeCloseTo(0.2, 9);
  });

  it('steps with a rounded top: a vertical wall, its top eased into the floor', () => {
    const rounded: ChannelWall = { shape: 'step', radius: 0.2, lip: 0 };
    const sharp: ChannelWall = { shape: 'step', radius: 0, lip: 0 };
    expect(d(rounded, 5.9999999)).toBeCloseTo(0.2, 3); // the wall stands 0.4 - 0.2
    expect(d(rounded, 5.9)).toBeLessThan(d(sharp, 5.9));
    expect(d(rounded, 5.9)).toBeGreaterThan(0.3);
    expect(d(rounded, 5)).toBeCloseTo((5 / 6) * 0.4, 9); // past the radius: the plain ramp
  });

  it('steps with a rounded lip: the wall stands in from the edge, rounded into the bottom', () => {
    const lipped: ChannelWall = { shape: 'step', radius: 0, lip: 0.1 };
    expect(d(lipped, 5.9999)).toBeCloseTo(0, 3); // tangent to the uncut bottom
    // Halfway round the lip: 1 - cos 30°... its height at 0.05 in from the edge.
    expect(d(lipped, 5.95)).toBeCloseTo(0.1 - Math.sqrt(0.01 - 0.0025), 9);
    expect(d(lipped, 5.90001)).toBeCloseTo(0.1, 2); // the wall's foot
    expect(d(lipped, 5.8999)).toBeCloseTo(0.4, 2); // its top
    // Shallower than its radius (the end of a fade), the lip is the whole wall.
    const shallow = [straight(0, 6, 0.05, lipped)];
    expect(channelDepthAt(shallow, 20, 5.95)).toBeCloseTo(0.05, 6);
  });

  it('scoops: arcs deepest midway, meeting in a sharp ridge', () => {
    const scoop: ChannelWall = { shape: 'scoop' };
    expect(d(scoop, 3)).toBeCloseTo(0.4, 9);
    expect(d(scoop, 6)).toBeCloseTo(0, 9);
    const slope = (y: number) => (d(scoop, y + 1e-4) - d(scoop, y - 1e-4)) / 2e-4;
    expect(slope(6 - 0.01)).toBeLessThan(-0.15); // falling into the ridge...
    expect(slope(6 + 0.01)).toBeGreaterThan(0.15); // ...and rising out: an edge
  });

  it('waves: smooth all the way across, a rounded crest between neighbours', () => {
    const wave: ChannelWall = { shape: 'wave' };
    expect(d(wave, 3)).toBeCloseTo(0.4, 9);
    expect(d(wave, 6)).toBeCloseTo(0, 9);
    const slope = (y: number) => (d(wave, y + 1e-4) - d(wave, y - 1e-4)) / 2e-4;
    expect(Math.abs(slope(6 - 0.01))).toBeLessThan(0.01);
    expect(Math.abs(slope(6 + 0.01))).toBeLessThan(0.01);
  });

  it('a centred step is a V: nothing on the stringer, full depth at both walls', () => {
    const v = [straight(null, 6, 0.4, { shape: 'step', radius: 0, lip: 0 })];
    expect(channelDepthAt(v, 20, 0)).toBeCloseTo(0, 9);
    expect(channelDepthAt(v, 20, 3)).toBeCloseTo(0.2, 9);
    expect(channelDepthAt(v, 20, -5.999)).toBeCloseTo(0.4, 3);
  });

  it('cuts all four into a watertight hull', () => {
    for (const wall of [
      { shape: 'step', radius: 0, lip: 0 },
      { shape: 'step', radius: 0.15, lip: 0.1 },
      { shape: 'scoop' },
      { shape: 'wave' },
    ] as ChannelWall[]) {
      const b = withChannels(shortboard, pair(wall));
      const mesh = tessellateBoard(b, { lengthSteps: 50, ringSteps: 48 });
      expect(badEdges(mesh), wall.shape).toBe(0);
    }
  });
});

describe('channel anchors', () => {
  it('are the same number at every station, sorted, on the walls', () => {
    const c = [straight(4, 10, 0.5), straight(null, 2, 0.3, { shape: 'round', radius: 0.5 })];
    const counts = [0, 20, 59, 100, 180].map((x) => channelAnchors(c, x).length);
    expect(new Set(counts).size).toBe(1);
    // Square: both sides of each wall; round: five stops on its one wall; floors.
    expect(counts[0]).toBe(4 + 5 + 2 * CHANNEL_FLOOR_POINTS);
    const ys = channelAnchors(c, 20);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(ys).toContain(4 - SQUARE_WALL_GAP);
    expect(ys).toContain(10 + SQUARE_WALL_GAP);
  });

  it('never land on the stringer, where the ring already has a point', () => {
    const c = [straight(0, 6, 0.4, { shape: 'step', radius: 0, lip: 0 })];
    expect(Math.min(...channelAnchors(c, 20))).toBeGreaterThan(0);
  });
});

/**
 * Edges not shared by exactly two faces, after welding coincident points, short of
 * x = `before`. A watertight mesh has none.
 */
const badEdges = (mesh: BoardMesh, before = Infinity): number => {
  const q = (v: number) => Math.round(v * 1e7);
  const id = new Map<string, number>();
  const xs: number[] = [];
  const weld = (i: number) => {
    const k = `${q(mesh.positions[i * 3]!)},${q(mesh.positions[i * 3 + 1]!)},${q(mesh.positions[i * 3 + 2]!)}`;
    if (!id.has(k)) {
      xs[id.size] = mesh.positions[i * 3]!;
      id.set(k, id.size);
    }
    return id.get(k)!;
  };
  const uses = new Map<string, number>();
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const v = [0, 1, 2].map((j) => weld(mesh.indices[t + j]!));
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue; // a sliver, no edges
    for (let j = 0; j < 3; j++) {
      const a = v[j]!;
      const b = v[(j + 1) % 3]!;
      const k = a < b ? `${a}-${b}` : `${b}-${a}`;
      uses.set(k, (uses.get(k) ?? 0) + 1);
    }
  }
  return [...uses.entries()].filter(([k, n]) => {
    const [a, b] = k.split('-').map(Number);
    return n !== 2 && Math.min(xs[a!]!, xs[b!]!) < before;
  }).length;
};

describe('channels in the hull', () => {
  const depth = 0.4;
  const cut = withChannels(shortboard, [straight(3, 7, depth), straight(9, 12, depth)]);

  it('leave a board without them exactly as it was', () => {
    expect('channels' in withChannels(shortboard, [])).toBe(false);
    const a = tessellateBoard(shortboard, { lengthSteps: 40, ringSteps: 48 });
    const b = tessellateBoard(withChannels(shortboard, []), { lengthSteps: 40, ringSteps: 48 });
    expect(b.positions).toEqual(a.positions);
    expect(b.indices).toEqual(a.indices);
  });

  it('give every ring the same points, a wall at the same index all along the channel', () => {
    expect(new Set([2, 10, 25, 70, 120].map((x) => loftRing(cut, x, 48)!.length)).size).toBe(1);
    const rings = [20, 25, 45, 59].map((x) => loftRing(cut, x, 48)!);
    // A point just inside the first wall: the same index everywhere, on the wall.
    const i = rings[2]!.findIndex((v) => Math.abs(v.y - (3 + SQUARE_WALL_GAP)) < 1e-6);
    expect(i).toBeGreaterThan(0);
    for (const r of rings) expect(r[i]!.y).toBeCloseTo(3 + SQUARE_WALL_GAP, 6);
  });

  it('cut square walls straight up, the channel floor lifted by the depth', () => {
    const x = 25;
    const ring = loftRing(cut, x, 48)!;
    const near = (y: number) => ring.find((v) => Math.abs(v.y - y) < 1e-6)!;
    const outside = near(3 - SQUARE_WALL_GAP);
    const inside = near(3 + SQUARE_WALL_GAP);
    expect(inside.z - outside.z).toBeCloseTo(depth, 3);
    // The floor, against the bottom without channels.
    for (const v of ring.filter((p) => p.y > 3.5 && p.y < 6.5 && p.z < 3)) {
      expect(v.z - bottomZAt(shortboard, x, v.y)).toBeCloseTo(depth, 2);
    }
    // The deck isn't touched.
    const deck = (b: BezierBoard) => Math.max(...loftRing(b, x, 48)!.map((p) => p.z));
    expect(deck(cut)).toBeCloseTo(deck(shortboard), 9);
  });

  it('stay closed: a watertight mesh', () => {
    expect(badEdges(tessellateBoard(cut, { lengthSteps: 60, ringSteps: 48 }))).toBe(0);
  });

  it('cut a swallow tail too, adding no open edges', () => {
    const L = getLength(shortboard);
    const third = (ax: number, ay: number, bx: number, by: number): [number, number] => [
      ax + (bx - ax) / 3,
      ay + (by - ay) / 3,
    ];
    const swallow = splineFromKnots([
      knotFromArray([18, 0, 18, 0, ...third(18, 0, 0, 9)], false, false),
      knotFromArray([0, 9, ...third(0, 9, 18, 0), ...third(0, 9, 90, 23.5)], false, false),
      knotFromArray([90, 23.5, ...third(90, 23.5, 0, 9), ...third(90, 23.5, L, 0)], false, false),
      knotFromArray([L, 0, ...third(L, 0, 90, 23.5), L, 0], false, false),
    ]);
    const fish = board(
      swallow,
      shortboard.bottom,
      shortboard.deck,
      shortboard.crossSections,
      shortboard.interpolationType,
      shortboard.fins,
      {
        from: 'drawn',
        channels: [straight(null, 6, depth, { shape: 'round', radius: 1 }, 50, 90, 0)],
      },
    );
    expect(hasTailCutout(fish.outline)).toBe(true);
    const mesh = tessellateBoard(fish, { lengthSteps: 60, ringSteps: 48 });
    expect(mesh.positions.every(Number.isFinite)).toBe(true);
    // Cut: the bottom by the stringer is higher than the plain fish's at the same place.
    const lowestNear = (m: BoardMesh, x: number) => {
      let z = Infinity;
      for (let i = 0; i < m.positions.length; i += 3) {
        if (Math.abs(m.positions[i]! - x) < 1.5 && Math.abs(m.positions[i + 1]!) < 1) {
          z = Math.min(z, m.positions[i + 2]!);
        }
      }
      return z;
    };
    const plain = tessellateBoard({ ...fish, channels: undefined } as BezierBoard, {
      lengthSteps: 60,
      ringSteps: 48,
    });
    expect(lowestNear(mesh, 40) - lowestNear(plain, 40)).toBeCloseTo(depth, 1);
    // Closed, but for the swallow path's own seam at the nose tip, where its last
    // ring's two halves meet face to face with or without channels (left out here).
    expect(badEdges(plain)).toBeGreaterThan(0);
    expect(badEdges(plain, L - 1)).toBe(0);
    expect(badEdges(mesh, L - 1)).toBe(0);
  });
});

describe('channel problems', () => {
  const half = (x: number) => getWidthAtPos(shortboard, x) / 2;
  const thick = (x: number) => getThicknessAtPos(shortboard, x);

  it('has none for channels that fit', () => {
    expect(channelProblems([straight(3, 7, 0.4)], half, thick)).toEqual([]);
  });

  it('says when walls cross, run off the bottom, or cut too deep', () => {
    expect(channelProblems([straight(7, 3, 0.4)], half, thick)).toEqual([
      'Channel 1: its walls cross.',
    ]);
    expect(channelProblems([straight(3, 40, 0.4)], half, thick)[0]).toMatch(/runs off the bottom/);
    expect(channelProblems([straight(3, 7, 4)], half, thick)[0]).toMatch(/deeper than half/);
  });

  it('wants walls that run along the board', () => {
    const back = {
      ...straight(3, 7, 0.4),
      outer: polylineSpline([
        [10, 7],
        [30, 8],
        [20, 9],
      ]),
    };
    expect(channelProblems([back], half, thick)[0]).toMatch(/run along the board/);
  });
});

describe('scaling channels with the board', () => {
  it('scales walls across, depth with thickness, and length along', () => {
    const [c] = scaleChannels([straight(4, 10, 0.5, { shape: 'bevel', width: 1 })], 2, 1.5, 0.5);
    expect(channelDepthAt([c!], 40, 1.5 * 7)).toBeCloseTo(0.25, 9);
    expect(channelDepthAt([c!], 119, 1.5 * 7)).toBeGreaterThan(0);
    expect(c!.wall).toEqual({ shape: 'bevel', width: 1.5 });
  });
});
