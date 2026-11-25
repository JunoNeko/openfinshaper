// SPDX-License-Identifier: GPL-3.0-or-later
import { curveFromKnots, splitCurve } from '../bezier-curve';
import { knot, type Knot } from '../knot';

/**
 * Insert one knot at `seg`/`t` via exact de Casteljau split: the resulting spline traces
 * the identical curve, just sliced into one more segment.
 */
const insertKnotAtSegment = (knots: readonly Knot[], seg: number, t: number): Knot[] => {
  const before = knots[seg]!;
  const after = knots[seg + 1]!;
  const split = splitCurve(curveFromKnots(before, after), t);
  const result = [...knots];
  result[seg] = knot(
    before.end,
    before.tangentToPrev,
    split.startTangentToNext,
    before.continuous,
    before.other,
  );
  result[seg + 1] = knot(
    after.end,
    split.endTangentToPrev,
    after.tangentToNext,
    after.continuous,
    after.other,
  );
  result.splice(
    seg + 1,
    0,
    knot(split.mid.end, split.mid.tangentToPrev, split.mid.tangentToNext, true, false),
  );
  return result;
};

/**
 * Insert several knots (each `seg` index relative to the ORIGINAL `knots` array),
 * applied highest segment index first so earlier splices don't shift later ones.
 */
export const reslice = (knots: readonly Knot[], inserts: { seg: number; t: number }[]): Knot[] =>
  [...inserts]
    .sort((a, b) => b.seg - a.seg)
    .reduce((acc, { seg, t }) => insertKnotAtSegment(acc, seg, t), [...knots]);
