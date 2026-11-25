// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Native CNC fin panel document (`.finpanel.json`): a self-contained, versioned
 * serialization of a multi-fin panel layout (`panel-nest.ts`).
 *
 * Lengths are written in millimetres (matching `.fin.json`) and converted to/from
 * kernel centimetres on load/save. Unique fin designs are embedded once by id so
 * reopening a saved panel works anywhere without re-selecting the source folder.
 */
import {
  vec2,
  type FinDesign,
  type PanelDimensions,
  type PanelPairingMode,
  type PanelPlacement,
  type PanelSetupMode,
  type Vec2,
} from '@openshaper/kernel';
import { readFinJson, writeFinJson, type FinJson } from './fin-json';
import { isObject } from './knot-json';

export const FIN_PANEL_JSON_FORMAT = 'openshaper-fin-panel';
export const FIN_PANEL_JSON_VERSION = 1;

export interface FinPanelDocument {
  readonly mode: PanelSetupMode;
  readonly pairing?: PanelPairingMode;
  readonly panel: PanelDimensions;
  readonly toolWidth: number;
  readonly placements: readonly PanelPlacement[];
}

export interface FinPanelPlacementJson {
  finId: string;
  name: string;
  x: number;
  y: number;
  rotation: number;
  pose: { angle: number; tilt: number };
  requiredThickness: number;
  spanLo: number;
  spanHi: number;
  boxW: number;
  boxH: number;
  outline: [number, number][];
  tabOutlines: [number, number][][];
}

export interface FinPanelJson {
  format: typeof FIN_PANEL_JSON_FORMAT;
  version: number;
  units: 'mm';
  mode: PanelSetupMode;
  pairing?: PanelPairingMode;
  panel: { length: number; width: number; thickness: number };
  toolWidth: number;
  /** Unique embedded fin designs, keyed by `placement.finId`. */
  fins: Record<string, FinJson>;
  placements: FinPanelPlacementJson[];
}

export class FinPanelJsonError extends Error {}

const MM_PER_CM = 10;
const toMm = (cm: number) => cm * MM_PER_CM;
const toCm = (mm: number) => mm / MM_PER_CM;

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const fail = (message: string): never => {
  throw new FinPanelJsonError(message);
};

const ptsToMm = (pts: readonly Vec2[]): [number, number][] =>
  pts.map((p) => [toMm(p.x), toMm(p.y)]);

const ptsFromMm = (raw: unknown, where: string): Vec2[] => {
  if (!Array.isArray(raw)) return fail(`Malformed panel file: ${where} is not a point list`);
  return raw.map((pt) => {
    if (!Array.isArray(pt) || pt.length !== 2 || !isNumber(pt[0]) || !isNumber(pt[1])) {
      return fail(`Malformed panel file: invalid point in ${where}`);
    }
    return vec2(toCm(pt[0]), toCm(pt[1]));
  });
};

/** Serialize a fin panel layout to a `.finpanel.json` string. */
export const writeFinPanelJson = (doc: FinPanelDocument): string => {
  const fins: Record<string, FinJson> = {};
  for (const pl of doc.placements) {
    if (!fins[pl.finId]) {
      fins[pl.finId] = JSON.parse(writeFinJson(pl.design)) as FinJson;
    }
  }
  const out: FinPanelJson = {
    format: FIN_PANEL_JSON_FORMAT,
    version: FIN_PANEL_JSON_VERSION,
    units: 'mm',
    mode: doc.mode,
    ...(doc.pairing ? { pairing: doc.pairing } : {}),
    panel: {
      length: toMm(doc.panel.length),
      width: toMm(doc.panel.width),
      thickness: toMm(doc.panel.thickness),
    },
    toolWidth: toMm(doc.toolWidth),
    fins,
    placements: doc.placements.map((pl) => ({
      finId: pl.finId,
      name: pl.name,
      x: toMm(pl.x),
      y: toMm(pl.y),
      rotation: pl.rotation,
      pose: { angle: pl.pose.angle, tilt: pl.pose.tilt },
      requiredThickness: toMm(pl.requiredThickness),
      spanLo: toMm(pl.spanLo),
      spanHi: toMm(pl.spanHi),
      boxW: toMm(pl.boxW),
      boxH: toMm(pl.boxH),
      outline: ptsToMm(pl.outline),
      tabOutlines: pl.tabOutlines.map(ptsToMm),
    })),
  };
  return JSON.stringify(out, null, 2);
};

/** Parse a `.finpanel.json` string back into a panel layout document. */
export const readFinPanelJson = (text: string): FinPanelDocument => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return fail(`Not valid JSON: ${(e as Error).message}`);
  }
  if (!isObject(parsed) || parsed.format !== FIN_PANEL_JSON_FORMAT) {
    return fail('Not an OpenFinShaper panel file (missing format marker)');
  }
  if (!isNumber(parsed.version) || parsed.version > FIN_PANEL_JSON_VERSION) {
    return fail(
      `Panel version ${String(parsed.version)} is newer than supported (${FIN_PANEL_JSON_VERSION})`,
    );
  }
  if (parsed.units !== 'mm') return fail('Malformed panel file: units must be mm');
  if (parsed.mode !== 'calculate-size' && parsed.mode !== 'recommend-fill') {
    return fail('Malformed panel file: unknown mode');
  }
  const pairing = parsed.pairing;
  if (pairing !== undefined && pairing !== 'pairs-only' && pairing !== 'pairs-plus-odd') {
    return fail('Malformed panel file: unknown pairing mode');
  }
  const panel = parsed.panel;
  if (
    !isObject(panel) ||
    !isNumber(panel.length) ||
    !isNumber(panel.width) ||
    !isNumber(panel.thickness) ||
    panel.length < 0 ||
    panel.width < 0 ||
    panel.thickness < 0
  ) {
    return fail('Malformed panel file: invalid panel dimensions');
  }
  if (!isNumber(parsed.toolWidth) || parsed.toolWidth < 0) {
    return fail('Malformed panel file: invalid tool cut width');
  }
  if (!isObject(parsed.fins)) return fail('Malformed panel file: missing fins');
  const designs = new Map<string, FinDesign>();
  for (const [id, rawFin] of Object.entries(parsed.fins)) {
    try {
      designs.set(id, readFinJson(JSON.stringify(rawFin)).design);
    } catch (e) {
      return fail(
        `Malformed panel file: embedded fin "${id}" is invalid (${(e as Error).message})`,
      );
    }
  }
  if (!Array.isArray(parsed.placements)) {
    return fail('Malformed panel file: placements must be a list');
  }
  const placements: PanelPlacement[] = parsed.placements.map((raw, i) => {
    if (!isObject(raw)) return fail(`Malformed panel file: placement ${i + 1} is damaged`);
    const finId = raw.finId;
    const name = raw.name;
    if (typeof finId !== 'string' || typeof name !== 'string') {
      return fail(`Malformed panel file: placement ${i + 1} is missing finId or name`);
    }
    const design = designs.get(finId);
    if (!design) return fail(`Malformed panel file: unknown finId "${finId}"`);
    const pose = raw.pose;
    if (
      !isNumber(raw.x) ||
      !isNumber(raw.y) ||
      !isNumber(raw.rotation) ||
      !isObject(pose) ||
      !isNumber(pose.angle) ||
      !isNumber(pose.tilt) ||
      !isNumber(raw.requiredThickness) ||
      !isNumber(raw.spanLo) ||
      !isNumber(raw.spanHi) ||
      !isNumber(raw.boxW) ||
      !isNumber(raw.boxH)
    ) {
      return fail(`Malformed panel file: placement ${i + 1} has invalid coordinates`);
    }
    if (!Array.isArray(raw.tabOutlines)) {
      return fail(`Malformed panel file: placement ${i + 1} is missing tabOutlines`);
    }
    return {
      finId,
      name,
      design,
      x: toCm(raw.x),
      y: toCm(raw.y),
      rotation: raw.rotation,
      pose: { angle: pose.angle, tilt: pose.tilt },
      requiredThickness: toCm(raw.requiredThickness),
      spanLo: toCm(raw.spanLo),
      spanHi: toCm(raw.spanHi),
      boxW: toCm(raw.boxW),
      boxH: toCm(raw.boxH),
      outline: ptsFromMm(raw.outline, `placement ${i + 1} outline`),
      tabOutlines: raw.tabOutlines.map((lp, j) =>
        ptsFromMm(lp, `placement ${i + 1} tab outline ${j + 1}`),
      ),
    };
  });

  return {
    mode: parsed.mode,
    ...(pairing ? { pairing } : {}),
    panel: {
      length: toCm(panel.length),
      width: toCm(panel.width),
      thickness: toCm(panel.thickness),
    },
    toolWidth: toCm(parsed.toolWidth),
    placements,
  };
};
