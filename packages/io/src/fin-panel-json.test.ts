// SPDX-License-Identifier: GPL-3.0-or-later
import { calculatePanelSize, defaultFinDesign } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import {
  FIN_PANEL_JSON_FORMAT,
  FIN_PANEL_JSON_VERSION,
  FinPanelJsonError,
  readFinPanelJson,
  writeFinPanelJson,
} from './fin-panel-json';

describe('.finpanel.json', () => {
  it('round-trips a multi-fin panel layout in mm with deduplicated embedded fins', () => {
    const side = defaultFinDesign('side', 'left');
    const centre = defaultFinDesign('centre');
    const layout = calculatePanelSize(
      [
        { id: 'side', name: 'Thruster Side', design: side, count: 2 },
        { id: 'centre', name: 'Thruster Centre', design: centre, count: 1 },
      ],
      { toolWidth: 0.6 },
    );

    const text = writeFinPanelJson({
      mode: layout.mode,
      pairing: 'pairs-plus-odd',
      panel: layout.panel,
      toolWidth: layout.toolWidth,
      placements: layout.placements,
    });
    const raw = JSON.parse(text) as Record<string, unknown>;
    expect(raw.format).toBe(FIN_PANEL_JSON_FORMAT);
    expect(raw.version).toBe(FIN_PANEL_JSON_VERSION);
    expect(raw.units).toBe('mm');
    expect(raw.pairing).toBe('pairs-plus-odd');
    // Two copies of 'side' share one embedded fin entry.
    expect(Object.keys(raw.fins as Record<string, unknown>).sort()).toEqual(['centre', 'side']);

    const back = readFinPanelJson(text);
    expect(back.mode).toBe('calculate-size');
    expect(back.pairing).toBe('pairs-plus-odd');
    expect(back.panel.length).toBeCloseTo(layout.panel.length, 12);
    expect(back.panel.width).toBeCloseTo(layout.panel.width, 12);
    expect(back.panel.thickness).toBeCloseTo(layout.panel.thickness, 12);
    expect(back.toolWidth).toBeCloseTo(0.6, 12);
    expect(back.placements).toHaveLength(3);
    back.placements.forEach((pl, i) => {
      const orig = layout.placements[i]!;
      expect(pl.finId).toBe(orig.finId);
      expect(pl.name).toBe(orig.name);
      expect(pl.x).toBeCloseTo(orig.x, 12);
      expect(pl.y).toBeCloseTo(orig.y, 12);
      expect(pl.rotation).toBe(orig.rotation);
      expect(pl.pose).toEqual(orig.pose);
      expect(pl.requiredThickness).toBeCloseTo(orig.requiredThickness, 12);
      expect(pl.outline).toHaveLength(orig.outline.length);
    });
  });

  it('rejects non-panel or damaged files', () => {
    expect(() => readFinPanelJson('not json')).toThrow(FinPanelJsonError);
    expect(() => readFinPanelJson(JSON.stringify({ format: 'wrong' }))).toThrow(FinPanelJsonError);
    expect(() =>
      readFinPanelJson(
        JSON.stringify({
          format: FIN_PANEL_JSON_FORMAT,
          version: 99,
          units: 'mm',
        }),
      ),
    ).toThrow(/newer than supported/);
  });
});
