// SPDX-License-Identifier: GPL-3.0-or-later
/** Pure spline knot editing helpers shared by the fin store. */
import {
  closestPointOnSpline,
  coeffsOf,
  curveFromPoints,
  curveLength,
  knot,
  knotLock,
  splineFromKnots,
  splitCurve,
  vec2,
  withHandles,
  type Knot,
  type Spline,
  type Vec2,
} from '@openshaper/kernel';

const projectOntoLock = (end: Vec2, handle: Vec2, dir: Vec2): Vec2 => {
  const dx = handle.x - end.x;
  const dy = handle.y - end.y;
  const along = dx * dir.x + dy * dir.y;
  if (along >= 0 && Math.abs(dx * dir.y - dy * dir.x) <= 1e-9) return handle;
  const len = Math.max(0, along);
  return vec2(end.x + dir.x * len, end.y + dir.y * len);
};

const constrainToLock = (k: Knot): Knot => {
  const { lock } = k;
  if (!lock) return k;
  const prev = lock.prev ? projectOntoLock(k.end, k.tangentToPrev, lock.prev) : k.tangentToPrev;
  const next = lock.next ? projectOntoLock(k.end, k.tangentToNext, lock.next) : k.tangentToNext;
  return prev === k.tangentToPrev && next === k.tangentToNext ? k : withHandles(k, prev, next);
};

const reversed = (d: Vec2): Vec2 => vec2(-d.x, -d.y);

const replaceKnot = (s: Spline, index: number, k: Knot): Spline =>
  splineFromKnots(s.knots.map((kk, i) => (i === index ? constrainToLock(k) : kk)));

/** Move a knot's endpoint to `end`, translating its two tangent handles by the same delta. */
export const moveKnotEnd = (s: Spline, index: number, end: Vec2): Spline => {
  const k = s.knots[index]!;
  const dx = end.x - k.end.x;
  const dy = end.y - k.end.y;
  return replaceKnot(
    s,
    index,
    knot(
      end,
      vec2(k.tangentToPrev.x + dx, k.tangentToPrev.y + dy),
      vec2(k.tangentToNext.x + dx, k.tangentToNext.y + dy),
      k.continuous,
      k.other,
      k.lock,
    ),
  );
};

/** Move one tangent handle to `pos`, keeping the opposite handle collinear if continuous. */
export const moveKnotTangent = (
  s: Spline,
  index: number,
  which: 'prev' | 'next',
  pos: Vec2,
): Spline => {
  const k = s.knots[index]!;
  const ownLock = which === 'prev' ? k.lock?.prev : k.lock?.next;
  const oppositeLock = which === 'prev' ? k.lock?.next : k.lock?.prev;
  const moved = ownLock ? projectOntoLock(k.end, pos, ownLock) : pos;
  let prev = which === 'prev' ? moved : k.tangentToPrev;
  let next = which === 'next' ? moved : k.tangentToNext;

  if (k.continuous && !oppositeLock) {
    const movedToEnd = vec2(k.end.x - moved.x, k.end.y - moved.y);
    const len = Math.hypot(movedToEnd.x, movedToEnd.y);
    const opp = which === 'prev' ? k.tangentToNext : k.tangentToPrev;
    const oppLen = Math.hypot(opp.x - k.end.x, opp.y - k.end.y);
    if (len > 1e-9) {
      const ux = movedToEnd.x / len;
      const uy = movedToEnd.y / len;
      const mirrored = vec2(k.end.x + ux * oppLen, k.end.y + uy * oppLen);
      if (which === 'prev') next = mirrored;
      else prev = mirrored;
    }
  }
  return replaceKnot(s, index, withHandles(k, prev, next));
};

/** Toggle a knot between continuous (smooth) and corner. */
export const setKnotContinuous = (s: Spline, index: number, continuous: boolean): Spline => {
  const k = s.knots[index]!;
  const lock =
    continuous && k.lock
      ? knotLock(
          k.lock.prev ?? (k.lock.next && reversed(k.lock.next)),
          k.lock.next ?? (k.lock.prev && reversed(k.lock.prev)),
        )
      : k.lock;
  return replaceKnot(
    s,
    index,
    knot(k.end, k.tangentToPrev, k.tangentToNext, continuous, k.other, lock),
  );
};

const SAME_POINT = 1e-9;
const SPLIT_END = 1e-6;
const onePoint = (a: Vec2, b: Vec2): boolean =>
  Math.abs(a.x - b.x) <= SAME_POINT && Math.abs(a.y - b.y) <= SAME_POINT;

/** Insert a control point on the spline nearest to `p`, splitting the segment via de Casteljau. */
export const insertKnotAt = (s: Spline, p: Vec2): { spline: Spline; index: number } | null => {
  const hit = closestPointOnSpline(s, p);
  if (!hit) return null;
  const split = splitCurve(s.curves[hit.index]!, hit.t);
  const start = s.knots[hit.index]!;
  const end = s.knots[hit.index + 1]!;
  if (hit.t < SPLIT_END || hit.t > 1 - SPLIT_END) return null;
  if (onePoint(split.mid.end, start.end) || onePoint(split.mid.end, end.end)) return null;
  const insertIndex = hit.index + 1;

  const newStart = withHandles(start, start.tangentToPrev, split.startTangentToNext);
  const mid = knot(split.mid.end, split.mid.tangentToPrev, split.mid.tangentToNext, true, false);
  const newEnd = withHandles(end, split.endTangentToPrev, end.tangentToNext);

  const knots = [
    ...s.knots.slice(0, hit.index),
    newStart,
    mid,
    newEnd,
    ...s.knots.slice(hit.index + 2),
  ];
  return { spline: splineFromKnots(knots), index: insertIndex };
};

export const canDeleteKnot = (s: Spline, index: number): boolean =>
  s.knots.length > 2 && index > 0 && index < s.knots.length - 1;

const DELETE_MAX_ITERATIONS = 1000;
const DELETE_LENGTH_TOLERANCE = 0.1;

const scaleHandle = (end: Vec2, handle: Vec2, scale: number): Vec2 =>
  vec2(end.x + (handle.x - end.x) * scale, end.y + (handle.y - end.y) * scale);

/** Delete an interior knot, merging its two segments while preserving arc length. */
export const deleteKnot = (s: Spline, index: number): Spline => {
  if (!canDeleteKnot(s, index)) return s;
  const prev = s.knots[index - 1]!;
  const next = s.knots[index + 1]!;
  const targetLen = curveLength(s.coeffs[index - 1]!) + curveLength(s.coeffs[index]!);

  let pTanNext = prev.tangentToNext;
  let nTanPrev = next.tangentToPrev;
  for (let i = 0; i < DELETE_MAX_ITERATIONS; i++) {
    const len = curveLength(coeffsOf(curveFromPoints(prev.end, pTanNext, nTanPrev, next.end)));
    if (Math.abs(len - targetLen) < DELETE_LENGTH_TOLERANCE) break;
    const factor = targetLen / len;
    pTanNext = scaleHandle(prev.end, pTanNext, factor);
    nTanPrev = scaleHandle(next.end, nTanPrev, factor);
  }

  const newPrev = withHandles(prev, prev.tangentToPrev, pTanNext);
  const newNext = withHandles(next, nTanPrev, next.tangentToNext);
  const knots = [...s.knots.slice(0, index - 1), newPrev, newNext, ...s.knots.slice(index + 2)];
  return splineFromKnots(knots);
};

/** Collapse empty spans (stacked identical points with zero inner handles) without changing shape. */
export const withoutEmptySpans = (s: Spline): Spline => {
  const ks = s.knots;
  const empty = (i: number) =>
    onePoint(ks[i]!.end, ks[i + 1]!.end) &&
    onePoint(ks[i]!.tangentToNext, ks[i]!.end) &&
    onePoint(ks[i + 1]!.tangentToPrev, ks[i + 1]!.end);
  if (!ks.slice(0, -1).some((_, i) => empty(i))) return s;
  const out: Knot[] = [];
  for (let i = 0; i < ks.length; i++) {
    let j = i;
    while (j < ks.length - 1 && empty(j)) j++;
    const a = ks[i]!;
    const b = ks[j]!;
    out.push(i === j ? a : knot(a.end, a.tangentToPrev, b.tangentToNext, a.continuous, a.other));
    i = j;
  }
  return splineFromKnots(out);
};
