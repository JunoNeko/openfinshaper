// SPDX-License-Identifier: GPL-3.0-or-later
/** @openshaper/render2d — canvas viewport and 2D fin curve editor. */
export {
  CSS_PX_PER_CM,
  worldToScreen,
  screenToWorld,
  fitToBounds,
  zoomAt,
  pan,
  lifeSizeViewport,
  viewportFromCenter,
  viewportCenter,
  reframeForSize,
  turnFitsLarger,
  paneToTurnedCanvas,
  turnedCanvasToPane,
  type ViewCenter,
  type Viewport,
  type Bounds,
  type ScreenPoint,
} from './viewport';
export { sampleSpline, boundsOf } from './sample';
export { handlePoint, hitTest, type Hit, type HandleKind } from './hit';
export {
  drawSpline,
  drawGhostSpline,
  drawControlPoints,
  drawGrid,
  MIN_FIXED_GRID_PX,
  gridStep,
  clear,
  defaultStyle,
  type DrawStyle,
  type Mirror,
} from './draw';
export { FinCurveEditor, type FinCurveEditorProps, type FinCurveMarker } from './FinCurveEditor';
export {
  HIT_TOL_PX,
  TOUCH_HIT_TOL_PX,
  dragTo,
  boundsToView,
  drawFinCurves,
  drawGuides,
  fromView,
  guideValueAt,
  layersBounds,
  FIN_CANVAS_FONT,
  FIN_CANVAS_LABEL,
  pickCurve,
  pickGuide,
  pickHandle,
  splineToView,
  toView,
  type FinCurveGuide,
  type FinCurveLayer,
  type FinCurvePick,
  type ViewMap,
  type ViewScale,
} from './fin-curve-view';
