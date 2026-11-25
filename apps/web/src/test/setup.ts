/** jsdom shims for the component tests. */
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library's auto-cleanup needs a global afterEach; we run without
// vitest globals, so unmount between tests explicitly.
afterEach(cleanup);

// FinCurveEditor sizes its canvas with a ResizeObserver, which jsdom lacks.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

// jsdom has no canvas implementation; FinCurveEditor handles a null 2D context,
// so return null quietly instead of jsdom's noisy "not implemented" error.
HTMLCanvasElement.prototype.getContext = (() =>
  null) as unknown as typeof HTMLCanvasElement.prototype.getContext;

// jsdom implements pointer events but not pointer capture, which FinCurveEditor
// uses to keep a drag alive when the pointer leaves the canvas.
HTMLElement.prototype.setPointerCapture ??= function setPointerCapture() {};
HTMLElement.prototype.releasePointerCapture ??= function releasePointerCapture() {};
HTMLElement.prototype.hasPointerCapture ??= function hasPointerCapture() {
  return false;
};
