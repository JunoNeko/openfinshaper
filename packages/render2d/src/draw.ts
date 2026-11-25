// SPDX-License-Identifier: GPL-3.0-or-later
import type { Knot, Spline, Vec2 } from '@openshaper/kernel';
import { screenToWorld, worldToScreen, type Viewport } from './viewport';
import type { Hit } from './hit';

export interface DrawStyle {
  curve: string;
  curveWidth: number;
  handleLine: string;
  point: string;
  pointCorner: string;
  pointSelected: string;
  tangent: string;
  tangentSelected: string;
}

export const defaultStyle: DrawStyle = {
  curve: '#22D3EE',
  curveWidth: 2,
  handleLine: 'rgba(138,155,179,0.55)',
  point: '#C7D2E0',
  pointCorner: '#22C55E',
  pointSelected: '#F97316',
  tangent: '#8A9BB3',
  tangentSelected: '#F97316',
};

export interface Mirror {
  mirrorX?: boolean;
  mirrorY?: boolean;
}

const reflections = (m: Mirror): ((p: Vec2) => Vec2)[] => {
  const fns: ((p: Vec2) => Vec2)[] = [(p) => p];
  if (m.mirrorY) fns.push((p) => ({ x: p.x, y: -p.y }));
  if (m.mirrorX) fns.push((p) => ({ x: -p.x, y: p.y }));
  return fns;
};

/** Trace the exact cubic segments in screen coordinates, including reflections. */
const traceSpline = (
  ctx: CanvasRenderingContext2D,
  spline: Spline,
  vp: Viewport,
  reflect: (p: Vec2) => Vec2,
): void => {
  ctx.beginPath();
  const first = worldToScreen(vp, reflect(spline.curves[0]!.p0));
  ctx.moveTo(first.x, first.y);
  for (const curve of spline.curves) {
    const c1 = worldToScreen(vp, reflect(curve.c1));
    const c2 = worldToScreen(vp, reflect(curve.c2));
    const end = worldToScreen(vp, reflect(curve.p3));
    ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y);
  }
};

/** Stroke a spline with native Canvas Bézier curves and any requested reflections. */
export const drawSpline = (
  ctx: CanvasRenderingContext2D,
  spline: Spline,
  vp: Viewport,
  style: DrawStyle,
  mirror: Mirror = {},
): void => {
  if (spline.curves.length === 0) return;
  ctx.strokeStyle = style.curve;
  ctx.lineWidth = style.curveWidth;
  for (const f of reflections(mirror)) {
    traceSpline(ctx, spline, vp, f);
    ctx.stroke();
  }
};

/** Stroke a ghost/reference spline (dashed, muted, no handles) under the live curves. */
export const drawGhostSpline = (
  ctx: CanvasRenderingContext2D,
  spline: Spline,
  vp: Viewport,
  mirror: Mirror = {},
  color?: string,
): void => {
  if (spline.curves.length === 0) return;
  ctx.save();
  ctx.strokeStyle = color ? `${color}8c` : 'rgba(180,184,196,0.55)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  for (const f of reflections(mirror)) {
    traceSpline(ctx, spline, vp, f);
    ctx.stroke();
  }
  ctx.restore();
};

const dot = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string) => {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
};

const square = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string) => {
  ctx.fillStyle = fill;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
};

const LOCK_BAR_AT = 12;
const LOCK_BAR_HALF = 4;

const drawLockBars = (
  ctx: CanvasRenderingContext2D,
  k: Knot,
  vp: Viewport,
  style: DrawStyle,
): void => {
  const end = worldToScreen(vp, k.end);
  ctx.lineWidth = 1.5;
  for (const [dir, handle] of [
    [k.lock?.prev, k.tangentToPrev],
    [k.lock?.next, k.tangentToNext],
  ] as const) {
    if (!dir) continue;
    const along = worldToScreen(vp, { x: k.end.x + dir.x, y: k.end.y + dir.y });
    const len = Math.hypot(along.x - end.x, along.y - end.y);
    if (len <= 1e-9) continue;
    const ux = (along.x - end.x) / len;
    const uy = (along.y - end.y) / len;
    const cx = end.x + ux * LOCK_BAR_AT;
    const cy = end.y + uy * LOCK_BAR_AT;
    const tip = worldToScreen(vp, handle);
    ctx.strokeStyle = style.tangent;
    ctx.beginPath();
    if (Math.hypot(tip.x - end.x, tip.y - end.y) < LOCK_BAR_AT) {
      ctx.moveTo(end.x, end.y);
      ctx.lineTo(cx, cy);
    }
    ctx.moveTo(cx - uy * LOCK_BAR_HALF, cy + ux * LOCK_BAR_HALF);
    ctx.lineTo(cx + uy * LOCK_BAR_HALF, cy - ux * LOCK_BAR_HALF);
    ctx.stroke();
  }
  ctx.lineWidth = 1;
};

/** Draw control points + tangent handles for a spline. */
export const drawControlPoints = (
  ctx: CanvasRenderingContext2D,
  spline: Spline,
  vp: Viewport,
  style: DrawStyle,
  selectedIndex: number | null,
  pointSize?: number,
  selectedKind: Hit['kind'] = 'end',
  hovered: Hit | null = null,
  alsoSelected: ReadonlySet<number> | null = null,
): void => {
  const r = pointSize ?? 5;
  const rSq = pointSize != null ? Math.max(1, pointSize - 1) : 4;
  spline.knots.forEach((k, i) => {
    const end = worldToScreen(vp, k.end);
    const prev = worldToScreen(vp, k.tangentToPrev);
    const next = worldToScreen(vp, k.tangentToNext);

    ctx.strokeStyle = style.handleLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    ctx.lineTo(end.x, end.y);
    ctx.lineTo(next.x, next.y);
    ctx.stroke();
    if (k.lock) drawLockBars(ctx, k, vp, style);

    const endSelected = (i === selectedIndex && selectedKind === 'end') || !!alsoSelected?.has(i);
    const endActive = endSelected || (hovered?.index === i && hovered.kind === 'end');
    const prevActive =
      (i === selectedIndex && selectedKind === 'prev') ||
      (hovered?.index === i && hovered.kind === 'prev');
    const nextActive =
      (i === selectedIndex && selectedKind === 'next') ||
      (hovered?.index === i && hovered.kind === 'next');
    const endFill = endSelected
      ? style.pointSelected
      : k.continuous
        ? style.point
        : style.pointCorner;

    const endScale = endActive ? 1.55 : 1;
    if (k.continuous) dot(ctx, end.x, end.y, r * endScale, endFill);
    else square(ctx, end.x, end.y, rSq * endScale, endFill);
    dot(
      ctx,
      prev.x,
      prev.y,
      3 * (prevActive ? 1.65 : 1),
      i === selectedIndex && selectedKind === 'prev' ? style.tangentSelected : style.tangent,
    );
    dot(
      ctx,
      next.x,
      next.y,
      3 * (nextActive ? 1.65 : 1),
      i === selectedIndex && selectedKind === 'next' ? style.tangentSelected : style.tangent,
    );
  });
};

/** Round a target spacing (cm) up to a "nice" 1 / 2 / 5 × 10ᵏ value. */
export const gridStep = (rawCm: number): number => {
  if (!Number.isFinite(rawCm) || rawCm <= 0) return 0;
  const pow = Math.pow(10, Math.floor(Math.log10(rawCm)));
  const n = rawCm / pow;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return nice * pow;
};

const hexToRgba = (hex: string, alpha: number, fallback: string): string => {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
  if (!m) return fallback;
  return `rgba(${parseInt(m[1]!, 16)},${parseInt(m[2]!, 16)},${parseInt(m[3]!, 16)},${alpha})`;
};

/** The closest a fixed grid's lines are drawn (px); see {@link drawGrid}. */
export const MIN_FIXED_GRID_PX = 6;

export const drawGrid = (
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  w: number,
  h: number,
  color?: string,
  fixed?: number,
): void => {
  const TARGET_PX = 64;
  let step = gridStep(TARGET_PX / vp.scale);
  if (fixed !== undefined && fixed > 0 && Number.isFinite(fixed)) {
    step = fixed;
    while (step * vp.scale < MIN_FIXED_GRID_PX) step *= 2;
  }
  if (step <= 0) return;

  const tl = screenToWorld(vp, { x: 0, y: 0 });
  const br = screenToWorld(vp, { x: w, y: h });
  const minX = Math.min(tl.x, br.x);
  const maxX = Math.max(tl.x, br.x);
  const minY = Math.min(tl.y, br.y);
  const maxY = Math.max(tl.y, br.y);

  const minorColor = color
    ? hexToRgba(color, 0.12, 'rgba(138,155,179,0.12)')
    : 'rgba(138,155,179,0.12)';
  const axisColor = color
    ? hexToRgba(color, 0.4, 'rgba(138,155,179,0.4)')
    : 'rgba(138,155,179,0.4)';

  ctx.save();
  ctx.strokeStyle = minorColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = Math.ceil(minX / step) * step; x <= maxX; x += step) {
    const sx = worldToScreen(vp, { x, y: 0 }).x;
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, h);
  }
  for (let y = Math.ceil(minY / step) * step; y <= maxY; y += step) {
    const sy = worldToScreen(vp, { x: 0, y }).y;
    ctx.moveTo(0, sy);
    ctx.lineTo(w, sy);
  }
  ctx.stroke();

  ctx.strokeStyle = axisColor;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  if (minX <= 0 && maxX >= 0) {
    const sx = worldToScreen(vp, { x: 0, y: 0 }).x;
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, h);
  }
  if (minY <= 0 && maxY >= 0) {
    const sy = worldToScreen(vp, { x: 0, y: 0 }).y;
    ctx.moveTo(0, sy);
    ctx.lineTo(w, sy);
  }
  ctx.stroke();
  ctx.restore();
};

export const clear = (ctx: CanvasRenderingContext2D, w: number, h: number, bg = '#0A1424') => {
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
};

export type { Hit };
