// SPDX-License-Identifier: GPL-3.0-or-later
/** Multi-fin panel STEP export (fin-panel-step.ts). */
import { calculatePanelSize, defaultFinDesign } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import { exportFinPanelStep } from './fin-panel-step';
import { asList, parse, type Entity } from './step-reader.test-helper';

const FIXED = '2026-11-25T00:00:00';

const refOf = (v: unknown): number => (v as { ref: number }).ref;
const raw = (v: unknown): string => (v as { raw: string }).raw;
const str = (v: unknown): string => (v as { str: string }).str;
const refsOf = (v: Entity['args'][number] | undefined): number[] => asList(v).map(refOf);

const allEdgesOf = (m: Map<number, Entity>, face: Entity): [number, boolean][] => {
  const out: [number, boolean][] = [];
  for (const bid of refsOf(face.args[1])) {
    const loop = m.get(refOf(m.get(bid)!.args[1]))!;
    for (const oid of refsOf(loop.args[1])) {
      const oe = m.get(oid)!;
      out.push([refOf(oe.args[3]), raw(oe.args[4]) === '.T.']);
    }
  }
  return out;
};

describe('exportFinPanelStep', () => {
  const sideL = defaultFinDesign('side', 'left');
  const centre = defaultFinDesign('centre');
  const layout = calculatePanelSize(
    [
      { id: 'side', name: 'Side L', design: sideL, count: 2 },
      { id: 'centre', name: 'Centre', design: centre, count: 1 },
    ],
    { toolWidth: 0.6 },
  );
  const step = exportFinPanelStep(layout, { timestamp: FIXED, name: 'thruster-panel' });
  const m = parse(step);
  const solids = [...m.values()]
    .filter((e) => e.name === 'MANIFOLD_SOLID_BREP')
    .map((e) => {
      const shell = m.get(refOf(e.args[1]))!;
      return {
        name: str(e.args[0]),
        faces: refsOf(shell.args[1]).map((id) => m.get(id)!),
      };
    });

  it('writes two closed solids (blade + tab) per placed fin, and no stock block', () => {
    expect(solids).toHaveLength(6); // 3 fins × (blade + tab)
    expect(solids.map((s) => s.name)).toEqual([
      expect.stringMatching(/^1-.*-blade$/),
      expect.stringMatching(/^1-.*-tab$/),
      expect.stringMatching(/^2-.*-blade$/),
      expect.stringMatching(/^2-.*-tab$/),
      expect.stringMatching(/^3-.*-blade$/),
      expect.stringMatching(/^3-.*-tab$/),
    ]);
  });

  it('keeps every solid watertight: each edge used once each way', () => {
    for (const s of solids) {
      const uses = new Map<number, boolean[]>();
      for (const f of s.faces) {
        for (const [edge, sense] of allEdgesOf(m, f)) {
          uses.set(edge, [...(uses.get(edge) ?? []), sense]);
        }
      }
      for (const senses of uses.values()) expect(senses.sort()).toEqual([false, true]);
    }
  });

  it('positions every fin inside the panel bounds [0, L] × [0, W] × [0, thickness]', () => {
    const pts = [...m.values()]
      .filter((e) => e.name === 'VERTEX_POINT')
      .map((e) => {
        const cp = m.get(refOf(e.args[1]))!;
        return asList(cp.args[1]).map((v) => (v as { num: number }).num);
      });
    expect(pts.length).toBeGreaterThan(30);
    const L = layout.panel.length * 10;
    const W = layout.panel.width * 10;
    const T = layout.panel.thickness * 10;
    const xs = pts.map((p) => p[0]!);
    const ys = pts.map((p) => p[1]!);
    const zs = pts.map((p) => p[2]!);
    expect(Math.min(...xs)).toBeGreaterThan(-0.5);
    expect(Math.max(...xs)).toBeLessThan(L + 0.5);
    expect(Math.min(...ys)).toBeGreaterThan(-0.5);
    expect(Math.max(...ys)).toBeLessThan(W + 0.5);
    expect(Math.min(...zs)).toBeGreaterThan(-0.5);
    expect(Math.max(...zs)).toBeLessThan(T + 0.5);
  });
});
