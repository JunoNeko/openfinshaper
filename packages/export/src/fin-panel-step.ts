// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Multi-fin CNC G10 panel STEP export: writes every placed fin in a {@link PanelLayoutResult}
 * rigidly transformed into its nested 2D position/rotation and optimal 3D panel pose,
 * centred vertically inside `Z ∈ [0, panel.thickness]`.
 *
 * Emits positioned fin solids only (ready for CAM stock setup). Unique fin designs are
 * surface-fitted once and reused across repeated placements on the sheet.
 */
import {
  fitBladeSurface,
  panelPlacementTransform,
  type BladeSurfaceModel,
  type PanelDimensions,
  type PanelPlacement,
} from '@openshaper/kernel';
import { FIN_BRAND } from './brand';
import { SHEET_UNIT, type SheetUnit } from './construction/units';
import { emitFinSolids } from './fin-step';
import { finishShape, header, productDefinition, unitContext, writerFor } from './step-writer';

export interface FinPanelStepOptions {
  /** Output unit written into the STEP file. Default 'mm'. */
  unit?: SheetUnit;
  /** `PRODUCT` name. Default 'fin-panel'. */
  name?: string;
  /** `FILE_NAME` timestamp for byte-reproducible output. */
  timestamp?: string;
  /** Blade surface fit tolerance (cm). */
  tolerance?: number;
  /** Export minimum edge/tip thickness (cm). */
  minThickness?: number;
}

const cleanLabel = (name: string): string =>
  name
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'fin';

/**
 * Encode all placed fins in a panel layout as a single multi-solid AP214 STEP file.
 * Frame (scaled to `unit`): X along panel length (0..L), Y along panel width (0..W),
 * Z across panel thickness (0..thickness).
 */
export const exportFinPanelStep = (
  layout: {
    readonly panel: PanelDimensions;
    readonly placements: readonly PanelPlacement[];
  },
  opts: FinPanelStepOptions = {},
): string => {
  const unit: SheetUnit = opts.unit ?? 'mm';
  const name = opts.name ?? 'fin-panel';
  const timestamp = opts.timestamp ?? new Date().toISOString().slice(0, 19);
  const factor = SHEET_UNIT[unit].factor;

  // Cache fitted blade surface per unique finId + hand so repeated copies fit once.
  const modelCache = new Map<string, BladeSurfaceModel>();
  const modelFor = (pl: PanelPlacement): BladeSurfaceModel => {
    const key = `${pl.finId}:${pl.design.hand ?? 'centre'}`;
    let model = modelCache.get(key);
    if (!model) {
      model = fitBladeSurface(pl.design, {
        ...(opts.tolerance === undefined ? {} : { tolerance: opts.tolerance }),
        ...(opts.minThickness === undefined ? {} : { minThickness: opts.minThickness }),
      });
      modelCache.set(key, model);
    }
    return model;
  };

  const w = writerFor(unit);
  header(
    w,
    'Nested surf fins in CNC panel as B-spline surfaces',
    `${name}.step`,
    timestamp,
    FIN_BRAND,
  );
  const defShape = productDefinition(w, name);
  const context = unitContext(w, unit);

  const solids: number[] = [];
  layout.placements.forEach((pl, idx) => {
    const model = modelFor(pl);
    const xform = panelPlacementTransform(pl, layout.panel.thickness, opts.minThickness);
    const prefix = `${idx + 1}-${cleanLabel(pl.name)}-`;
    solids.push(...emitFinSolids(w, pl.design, model, factor, { xform, prefix }));
  });

  return finishShape(w, defShape, context, solids);
};
