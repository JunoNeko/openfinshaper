// SPDX-License-Identifier: GPL-3.0-or-later
/** Multi-fin CNC panel nesting and 3D pose placement (panel-nest.ts). */
import { describe, expect, it } from 'vitest';
import { defaultCanard, defaultFinDesign, defaultKeel } from './fin-defaults';
import {
  calculatePanelSize,
  panelBasis,
  panelPlacementTransform,
  recommendPanelFins,
  transformPanelDir,
  transformPanelPoint,
} from './panel-nest';
import { finMesh } from './fin-mesh';

describe('panelBasis and panelPlacementTransform', () => {
  it('builds a right-handed orthonormal frame and centres the fin inside [0, panelThickness]', () => {
    const d = defaultFinDesign('side', 'left');
    const res = calculatePanelSize([{ id: 's', name: 'Side', design: d, count: 1 }], {
      toolWidth: 0.6,
    });
    const pl = res.placements[0]!;
    const [u, v, n] = panelBasis(pl.pose, 1);
    // Orthonormal and right-handed (u × v = n).
    const cross = {
      x: u.y * v.z - u.z * v.y,
      y: u.z * v.x - u.x * v.z,
      z: u.x * v.y - u.y * v.x,
    };
    expect(cross.x).toBeCloseTo(n.x, 12);
    expect(cross.y).toBeCloseTo(n.y, 12);
    expect(cross.z).toBeCloseTo(n.z, 12);

    const panelT = 2.0;
    const xform = panelPlacementTransform(pl, panelT);
    const mesh = finMesh(d, { rows: 24, stations: 24, minThickness: 0.05 });
    let minZ = Infinity;
    let maxZ = -Infinity;
    let minX = Infinity;
    let minY = Infinity;
    for (const m of [mesh.blade, mesh.tab]) {
      for (let i = 0; i < m.positions.length; i += 3) {
        const q = transformPanelPoint(xform, {
          x: m.positions[i]!,
          y: m.positions[i + 1]!,
          z: m.positions[i + 2]!,
        });
        if (q.z < minZ) minZ = q.z;
        if (q.z > maxZ) maxZ = q.z;
        if (q.x < minX) minX = q.x;
        if (q.y < minY) minY = q.y;
      }
    }
    expect(minX).toBeCloseTo(pl.x, 4);
    expect(minY).toBeCloseTo(pl.y, 4);
    expect(maxZ - minZ).toBeCloseTo(pl.requiredThickness, 4);
    expect((minZ + maxZ) / 2).toBeCloseTo(panelT / 2, 4);
    // Direction transform preserves unit length.
    const dn = transformPanelDir(xform, { x: 0, y: 1, z: 0 });
    expect(Math.hypot(dn.x, dn.y, dn.z)).toBeCloseTo(1, 12);
  });
});

describe('calculatePanelSize', () => {
  it('nests a thruster set tightly with tool clearance and reports panel dimensions', () => {
    const sideL = defaultFinDesign('side', 'left');
    const sideR = defaultFinDesign('side', 'right');
    const centre = defaultFinDesign('centre');
    const res = calculatePanelSize(
      [
        { id: 'l', name: 'Side L', design: sideL },
        { id: 'r', name: 'Side R', design: sideR },
        { id: 'c', name: 'Centre', design: centre },
      ],
      { toolWidth: 0.6 },
    );
    expect(res.placements).toHaveLength(3);
    expect(res.warnings).toEqual([]);
    expect(res.panel.length).toBeGreaterThanOrEqual(res.panel.width);
    expect(res.panel.thickness).toBeGreaterThanOrEqual(res.maxRequiredThickness);
    expect(res.utilisation).toBeGreaterThan(0.35);
    // Every placed fin sits inside the panel with margin.
    for (const pl of res.placements) {
      expect(pl.x).toBeGreaterThanOrEqual(0.59);
      expect(pl.y).toBeGreaterThanOrEqual(0.59);
      expect(pl.x + pl.boxW).toBeLessThanOrEqual(res.panel.length + 0.05);
      expect(pl.y + pl.boxH).toBeLessThanOrEqual(res.panel.width + 0.05);
    }
  });

  it('warns when any fin exceeds the supplied target panel thickness', () => {
    const side = { ...defaultFinDesign('side', 'left'), cant: 12 };
    const res = calculatePanelSize([{ id: 's', name: 'Canted side', design: side }], {
      toolWidth: 0.6,
      panelThickness: 0.5, // 5 mm, far too thin for a canted fin
    });
    expect(res.warnings.map((w) => w.code)).toContain('too-thick');
    expect(res.warnings[0]!.requiredThickness).toBeGreaterThan(0.5);
  });
});

describe('recommendPanelFins', () => {
  it('fills a panel with matched L+R pairs and centre fins, keeping tool clearance', () => {
    const sideL = defaultFinDesign('side', 'left');
    const centre = defaultFinDesign('centre');
    const res = recommendPanelFins(
      [
        { id: 'side', name: 'Thruster Side', design: sideL },
        { id: 'centre', name: 'Thruster Centre', design: centre },
      ],
      {
        panel: { length: 45, width: 25, thickness: 1.4 },
        toolWidth: 0.6,
      },
    );
    expect(res.placements.length).toBeGreaterThanOrEqual(4);
    expect(res.warnings).toEqual([]);
    // Side fins are always placed in matched L+R pairs.
    const leftCount = res.placements.filter((p) => p.design.hand === 'left').length;
    const rightCount = res.placements.filter((p) => p.design.hand === 'right').length;
    expect(leftCount).toBe(rightCount);
    expect(leftCount).toBeGreaterThanOrEqual(1);
    expect(res.utilisation).toBeGreaterThan(0.35);
  });

  it('excludes and warns on fins too thick for the panel while placing thinner ones', () => {
    const thickKeel = { ...defaultKeel('left'), cant: 12 };
    const thinCanard = defaultCanard('left');
    const res = recommendPanelFins(
      [
        { id: 'keel', name: 'Thick Keel', design: thickKeel },
        { id: 'canard', name: 'Canard', design: thinCanard },
      ],
      {
        panel: { length: 30, width: 20, thickness: 0.9 }, // 9 mm: canard fits, canted keel does not
        toolWidth: 0.6,
      },
    );
    expect(res.warnings.some((w) => w.code === 'too-thick' && w.finId === 'keel')).toBe(true);
    expect(res.placements.every((p) => p.finId !== 'keel')).toBe(true);
    expect(res.placements.length).toBeGreaterThanOrEqual(2);
  });

  it('fills leftover space with an odd fin in pairs-plus-odd mode while pairs-only keeps matched pairs', () => {
    const sideL = defaultFinDesign('side', 'left');
    // 600 × 600 mm sheet has space for an odd fin beyond matched pairs.
    const opts = {
      panel: { length: 60, width: 60, thickness: 1.4 },
      toolWidth: 0.6,
    } as const;
    const allPairs = recommendPanelFins([{ id: 'side', name: 'Side', design: sideL }], {
      ...opts,
      pairing: 'pairs-only',
    });
    const withOdd = recommendPanelFins([{ id: 'side', name: 'Side', design: sideL }], {
      ...opts,
      pairing: 'pairs-plus-odd',
    });
    expect(allPairs.pairing).toBe('pairs-only');
    expect(withOdd.pairing).toBe('pairs-plus-odd');
    expect(allPairs.placements.length % 2).toBe(0);
    expect(withOdd.placements.length).toBeGreaterThan(allPairs.placements.length);
    expect(withOdd.utilisation).toBeGreaterThan(allPairs.utilisation);
  });
});
