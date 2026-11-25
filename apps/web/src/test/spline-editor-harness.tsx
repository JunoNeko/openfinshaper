/**
 * Shared layout & pointer stubs for driving `FinCurveEditor` panes under jsdom.
 */
import { act } from '@testing-library/react';

export const pane = { w: 600, h: 400, top: 0 };

/** ResizeObserver callbacks registered by the component under test. */
let observers: ResizeObserverCallback[] = [];

/** Resize the pane and flush the observer. */
export const resizeTo = (w: number, h: number) => {
  pane.w = w;
  pane.h = h;
  act(() => {
    for (const cb of observers) cb([], {} as ResizeObserver);
  });
};

/** Move the canvas down the page without resizing it — no observer fires. */
export const shiftTo = (top: number) => {
  act(() => {
    pane.top = top;
  });
};

class TestResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe() {
    observers.push(this.cb);
  }
  unobserve() {}
  disconnect() {
    observers = observers.filter((c) => c !== this.cb);
  }
}

const protos = [HTMLDivElement.prototype, HTMLCanvasElement.prototype];
const props = ['clientWidth', 'clientHeight', 'getBoundingClientRect'] as const;
let realRO: typeof ResizeObserver;
let saved: { p: object; entries: (readonly [string, PropertyDescriptor | undefined])[] }[] = [];

/** Call from `beforeEach`: stub layout onto `pane` and reset it to a fresh 600x400. */
export const installLayoutStubs = () => {
  observers = [];
  pane.w = 600;
  pane.h = 400;
  pane.top = 0;
  realRO = globalThis.ResizeObserver;
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
  saved = protos.map((p) => ({
    p,
    entries: props.map((n) => [n, Object.getOwnPropertyDescriptor(p, n)] as const),
  }));
  for (const p of protos) {
    Object.defineProperty(p, 'clientWidth', { configurable: true, get: () => pane.w });
    Object.defineProperty(p, 'clientHeight', { configurable: true, get: () => pane.h });
    Object.defineProperty(p, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 0,
        top: pane.top,
        right: pane.w,
        bottom: pane.top + pane.h,
        width: pane.w,
        height: pane.h,
      }),
    });
  }
};

/** Call from `afterEach`. */
export const removeLayoutStubs = () => {
  globalThis.ResizeObserver = realRO;
  for (const { p, entries } of saved) {
    for (const [name, d] of entries) {
      if (d) Object.defineProperty(p, name, d);
      else delete (p as unknown as Record<string, unknown>)[name];
    }
  }
};

export const MOUSE = { pointerId: 1, button: 0, pointerType: 'mouse' } as const;
export const TOUCH = { pointerId: 1, button: 0, pointerType: 'touch' } as const;
