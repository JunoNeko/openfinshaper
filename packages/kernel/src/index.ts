// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * @openshaper/kernel — pure fin geometry, spline, B-spline, and CNC panel nesting kernel.
 *
 * Framework-agnostic and side-effect free (no React, DOM, or Three.js dependencies).
 */
export * from './vec2';
export * from './constants';
export * from './math';
export * from './knot';
export * from './bezier-curve';
export * from './bezier-spline';
export * from './mesh';
export * from './bspline-surface';
export * from './fin-design/futures-tab';
export * from './fin-design/fin-tab';
export * from './fin-design/fin-design';
export * from './fin-design/fin-rules';
export * from './fin-design/fin-readouts';
export * from './fin-design/blade';
export * from './fin-design/blade-surface';
export * from './fin-design/fin-placement';
export * from './fin-design/fin-clearance';
export * from './fin-design/naca';
export * from './fin-design/split-foil';
export * from './fin-design/mesh-slice';
export * from './fin-design/fin-mesh';
export * from './fin-design/fairness';
export * from './fin-design/smooth-blade';
export * from './fin-design/panel-fit';
export * from './fin-design/panel-nest';
export * from './fin-design/fin-flex';
export {
  defaultCanard,
  defaultFinDesign,
  defaultKeel,
  defaultSingleFin,
  defaultTwinFin,
  defaultTaper,
  flatFace,
} from './fin-design/fin-defaults';
export * from './fin-design/swept-loft';
export { yAtX } from './fin-design/curve-shape';
