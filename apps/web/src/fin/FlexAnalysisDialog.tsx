// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * "Flex / Stiffness" dialog: 4-step workflow for modeling orthotropic fin flex,
 * directional weave angle, and thickness tuning.
 *
 * Layout follows the design mockup in `docs/design/flex-stiffness-ui-mockup.png`:
 * - Left sidebar: 4 numbered steps with clickable load presets under the load slider,
 *   gradient target stiffness slider + expandable surfer reference table, material
 *   selector + inline radio weave-angle buttons (with conditional dashed Recommend box),
 *   and geometry tuning summary + cyan primary CTA.
 * - Right workspace: headline stiffness readout + Current/Tuned toggle -> full-width hero
 *   blade flex heatmap with integrated inline callout columns (Tip Flex, Tip Twist,
 *   mid/lower blade callouts, Flex Hinge, Peak Stress) -> bottom row pairing the compact
 *   Edge bend / Weave curve chart with the Twist guide & Lab bench measurement card.
 */
import {
  analyzeFinFlex,
  FIN_FLEX_MATERIALS,
  G10_MATERIAL,
  recommendWeaveAngle,
  tuneDesignForStiffness,
  type FinDesign,
  type FinFlexAnalysis,
  type FlexDesignAdjustStrategy,
  type WeaveSweepPoint,
} from '@openshaper/kernel';
import { Button, Panel, PanelBody, PanelHeader, PanelTitle } from '@openshaper/ui';
import { Activity, AlertTriangle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Modal } from '../components/modal';
import { fmtThick, type LengthUnit } from '../format';
import { finStore } from './fin-store';

type WeaveChoice = '90-0' | '45' | 'recommend';
type SecondaryChart = 'deflected' | 'weave-curve';
type PreviewTarget = 'tuned' | 'current';

/** Exact SI gravity conversion: 1 kgf = 9.80665 N. */
const N_PER_KG = 9.80665;
/** Convert bench stiffness N/mm -> kg per 10 mm bend (`N/mm * 10 / 9.80665`). */
const nPerMmToKgPer10Mm = (nPerMm: number): number => (nPerMm * 10) / N_PER_KG;
/** Convert target stiffness kg per 10 mm bend -> N/mm. */
const kgPer10MmToNPerMm = (kgPer10Mm: number): number => (kgPer10Mm * N_PER_KG) / 10;

const MIN_TARGET_KG = 3;
const MAX_TARGET_KG = 26;

const LOAD_PRESETS = [
  { id: '7.5', label: 'Cruise 7.5', valueKg: 7.5 },
  { id: '15', label: 'Turns 15', valueKg: 15 },
  { id: '25', label: 'Heavy 25', valueKg: 25 },
] as const;

/** Research-backed surfer weight & wave power reference table (Surf Flex Lab / UOW). */
const SURFER_REFERENCE_ROWS = [
  {
    profile: 'Light (~55–65 kg) · mellow surf',
    loadRange: '9–12 kg',
    stiffnessRange: '6–9 kg / 10 mm*',
    loadKg: 10,
    targetKg: 7.5,
  },
  {
    profile: 'Average (~70–80 kg) · all-round',
    loadRange: '13–17 kg',
    stiffnessRange: '9–13 kg / 10 mm*',
    loadKg: 15,
    targetKg: 11,
  },
  {
    profile: 'Heavy (~85–100+ kg) · powerful',
    loadRange: '20–30 kg',
    stiffnessRange: '13–20+ kg / 10 mm*',
    loadKg: 25,
    targetKg: 16,
  },
] as const;

/** Map 0..1 intensity onto a dark-UI friendly navy -> cyan -> emerald -> amber ramp. */
const heatColor = (t: number): string => {
  const c = Math.min(1, Math.max(0, t));
  const stops: readonly [number, number, number, number][] = [
    [0.0, 29, 78, 216], // deep cobalt (stiff root)
    [0.35, 14, 165, 233], // sky cyan
    [0.7, 52, 211, 153], // emerald
    [1.0, 245, 158, 11], // warm amber (peak tip flex)
  ];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]!;
    const b = stops[i]!;
    if (c <= b[0]) {
      const f = (c - a[0]) / (b[0] - a[0] || 1);
      const r = Math.round(a[1] + (b[1] - a[1]) * f);
      const g = Math.round(a[2] + (b[2] - a[2]) * f);
      const bl = Math.round(a[3] + (b[3] - a[3]) * f);
      return `rgb(${r}, ${g}, ${bl})`;
    }
  }
  return 'rgb(245, 158, 11)';
};

const fmtSignedDeg = (deg: number, digits = 0): string =>
  `${deg > 0 ? '+' : deg < 0 ? '−' : ''}${Math.abs(deg).toFixed(digits)}°`;

const fmtTwistLabel = (deg: number): string =>
  Math.abs(deg) < 0.05
    ? '0.0° neutral'
    : `${deg > 0 ? '+' : '−'}${Math.abs(deg).toFixed(1)}° ${deg < 0 ? 'wash-out' : 'wash-in'}`;

const fmtDeflMm = (mm: number): string =>
  Math.abs(mm) < 0.1 && Math.abs(mm) > 0.005 ? `${mm.toFixed(2)} mm` : `${mm.toFixed(1)} mm`;

/** Shared segmented control used for pill switches (Current/Tuned, Whole/Tip, chart tabs). */
function SegmentedControl<T extends string>({
  ariaLabel,
  value,
  options,
  onChange,
  fullWidth = false,
  compact = false,
}: {
  ariaLabel: string;
  value: T;
  options: readonly { readonly id: T; readonly label: string }[];
  onChange: (next: T) => void;
  fullWidth?: boolean;
  compact?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`inline-flex rounded-md border border-border bg-muted/40 p-0.5 ${
        fullWidth ? 'flex w-full' : 'shrink-0'
      }`}
    >
      {options.map((opt) => {
        const active = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.id)}
            className={`whitespace-nowrap rounded-[5px] font-medium transition-colors ${
              fullWidth ? 'flex-1' : ''
            } ${compact ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs'} ${
              active
                ? 'bg-background text-foreground shadow-sm ring-1 ring-border/80'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/** Flush-aligned step header: circular step badge + title left, cyan tabular value right. */
function StepHeader({ num, title, value }: { num: number; title: string; value?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-500/75 text-[11px] font-bold tabular-nums text-white ring-1 ring-slate-300/40">
          {num}
        </span>
        <h3 className="text-[13px] font-semibold tracking-tight text-foreground">{title}</h3>
      </div>
      {value && <span className="text-xs font-semibold tabular-nums text-sky-400">{value}</span>}
    </div>
  );
}

/** Custom-rendered range slider with crisp circular thumb aligned cleanly over the track. */
function CleanSlider({
  id,
  ariaLabel,
  min,
  max,
  step,
  value,
  onChange,
  trackGradient,
}: {
  id: string;
  ariaLabel: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (next: number) => void;
  trackGradient?: string;
}) {
  const pct = max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0;
  return (
    <div className="relative flex h-6 items-center">
      <div
        className="pointer-events-none h-2 w-full overflow-hidden rounded-full bg-muted/80"
        style={trackGradient ? { background: trackGradient } : undefined}
      >
        {!trackGradient && (
          <div className="h-full rounded-full bg-sky-500/80" style={{ width: `${pct}%` }} />
        )}
      </div>
      <div
        className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-slate-950 bg-white shadow"
        style={{ left: `${pct}%` }}
      />
      <input
        id={id}
        aria-label={ariaLabel}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      />
    </div>
  );
}

/**
 * Full-width Hero Blade Flex Heatmap with integrated inline callout columns:
 *  - Row 1 (Tip):         TIP FLEX (load)      | TIP TWIST
 *  - Row 2 (Upper mid):   deflection mm        | twist wash-out/in
 *  - Row 3 (Flex hinge):  FLEX HINGE (% depth) | PEAK STRESS (MPa, SF×)  [amber dashed across fin]
 *  - Row 4 (Lower blade): deflection mm        | twist wash-out/in
 */
function HeroFinFlexSvg({
  analysis,
  loadLabel,
  showWeave = true,
}: {
  analysis: FinFlexAnalysis;
  loadLabel: string;
  showWeave?: boolean;
}) {
  const { nodes, triangles, stations, weaveAngleDeg, flexPointFraction, gridRows, gridCols } =
    analysis;
  if (nodes.length === 0 || stations.length < 4) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let maxAbsDefl = 0;
  for (const n of nodes) {
    if (n.xCm < minX) minX = n.xCm;
    if (n.xCm > maxX) maxX = n.xCm;
    if (n.zCm < minZ) minZ = n.zCm;
    if (n.zCm > maxZ) maxZ = n.zCm;
    if (Math.abs(n.deflectionMm) > maxAbsDefl) maxAbsDefl = Math.abs(n.deflectionMm);
  }
  const spanX = Math.max(1, maxX - minX);
  const spanZ = Math.max(1, maxZ - minZ);

  // Fixed spacious viewBox in SVG pixels so typography stays crisp and consistent across fin sizes.
  const VB_W = 720;
  const VB_H = 380;
  const finBoxLeft = 36;
  const finBoxRight = 355;
  const finBoxTop = 34;
  const finBoxBottom = 346;
  const scale = Math.min((finBoxRight - finBoxLeft) / spanX, (finBoxBottom - finBoxTop) / spanZ);
  const drawnW = spanX * scale;
  const drawnH = spanZ * scale;
  const offX = finBoxLeft + (finBoxRight - finBoxLeft - drawnW) * 0.45;
  const offY = finBoxTop + (finBoxBottom - finBoxTop - drawnH) * 0.5;

  const toX = (xCm: number) => offX + (maxX - xCm) * scale;
  const toY = (zCm: number) => offY + (maxZ - zCm) * scale;

  // Fin outline polygon for clipping weave & crisp white rim stroke.
  const boundaryPts: string[] = [];
  for (let c = 0; c < gridCols; c++) {
    const n = nodes[c]!;
    boundaryPts.push(`${toX(n.xCm).toFixed(1)},${toY(n.zCm).toFixed(1)}`);
  }
  for (let r = 1; r < gridRows; r++) {
    const n = nodes[r * gridCols + (gridCols - 1)]!;
    boundaryPts.push(`${toX(n.xCm).toFixed(1)},${toY(n.zCm).toFixed(1)}`);
  }
  for (let c = gridCols - 2; c >= 0; c--) {
    const n = nodes[(gridRows - 1) * gridCols + c]!;
    boundaryPts.push(`${toX(n.xCm).toFixed(1)},${toY(n.zCm).toFixed(1)}`);
  }
  for (let r = gridRows - 2; r >= 1; r--) {
    const n = nodes[r * gridCols]!;
    boundaryPts.push(`${toX(n.xCm).toFixed(1)},${toY(n.zCm).toFixed(1)}`);
  }
  const clipPoly = boundaryPts.join(' ');

  // Weave overlay geometry centered on fin bbox.
  const cx = offX + drawnW * 0.5;
  const cy = offY + drawnH * 0.5;
  const weaveSpan = Math.hypot(drawnW, drawnH) * 0.85;
  const weaveStep = 18;
  const weaveOffsets: number[] = [];
  for (let d = -weaveSpan; d <= weaveSpan; d += weaveStep) weaveOffsets.push(d);

  // Pick 4 well-separated vertical stations so inline callouts never collide on any fin shape:
  // Row 1 = tip (~0.92), Row 3 = flex hinge, Row 2 = mid between hinge & tip, Row 4 = lower blade.
  const hingeFrac = Math.min(0.68, Math.max(0.28, flexPointFraction));
  const tipFrac = 0.92;
  const upperFrac = Math.min(0.8, Math.max(hingeFrac + 0.16, (hingeFrac + tipFrac) * 0.52));
  const lowerFrac = Math.max(0.14, Math.min(hingeFrac - 0.16, hingeFrac * 0.45));

  const rowIndexFor = (frac: number) =>
    Math.min(stations.length - 1, Math.max(1, Math.round(frac * (stations.length - 1))));

  const tipRow = rowIndexFor(tipFrac);
  const upperRow = rowIndexFor(upperFrac);
  const hingeRow = rowIndexFor(hingeFrac);
  const lowerRow = rowIndexFor(lowerFrac);

  const teXOfRow = (rowIdx: number) => {
    const teNode = nodes[rowIdx * gridCols + (gridCols - 1)]!;
    return toX(teNode.xCm);
  };
  const leXOfRow = (rowIdx: number) => {
    const leNode = nodes[rowIdx * gridCols]!;
    return toX(leNode.xCm);
  };
  const yOfFrac = (frac: number) => toY(minZ + frac * spanZ);

  const tipY = yOfFrac(tipFrac);
  const upperY = yOfFrac(upperFrac);
  const hingeY = yOfFrac(hingeFrac);
  const lowerY = yOfFrac(lowerFrac);

  const upperSt = stations[upperRow]!;
  const lowerSt = stations[lowerRow]!;

  // Aligned column x-coordinates (CRAP Alignment: two crisp vertical rails).
  const leaderEndX = 438;
  const col1X = 452;
  const col2X = 576;

  return (
    <svg
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      className="h-auto max-h-[370px] w-full"
      role="img"
      aria-label={`Fin flex heatmap at ${weaveAngleDeg}° weave, ${nPerMmToKgPer10Mm(analysis.stiffnessNPerMm).toFixed(1)} kg per 10 mm`}
    >
      <defs>
        <clipPath id="hero-fin-flex-outline-clip">
          <polygon points={clipPoly} />
        </clipPath>
      </defs>

      {/* Smooth heatmap triangles */}
      {triangles.map(([a, b, c], i) => {
        const na = nodes[a]!;
        const nb = nodes[b]!;
        const nc = nodes[c]!;
        const val =
          maxAbsDefl > 0
            ? (Math.abs(na.deflectionMm) + Math.abs(nb.deflectionMm) + Math.abs(nc.deflectionMm)) /
              (3 * maxAbsDefl)
            : 0;
        const fill = heatColor(val);
        const pts = `${toX(na.xCm).toFixed(1)},${toY(na.zCm).toFixed(1)} ${toX(nb.xCm).toFixed(1)},${toY(nb.zCm).toFixed(1)} ${toX(nc.xCm).toFixed(1)},${toY(nc.zCm).toFixed(1)}`;
        return (
          <polygon
            key={i}
            points={pts}
            fill={fill}
            fillOpacity={0.94}
            stroke={fill}
            strokeWidth={0.8}
          />
        );
      })}

      {/* Subtle woven laminate grid (woven materials only) */}
      {showWeave && (
        <g
          clipPath="url(#hero-fin-flex-outline-clip)"
          transform={`rotate(${weaveAngleDeg} ${cx.toFixed(1)} ${cy.toFixed(1)})`}
          pointerEvents="none"
        >
          {weaveOffsets.map((d, i) => (
            <g key={i}>
              <line
                x1={cx - weaveSpan}
                y1={cy + d}
                x2={cx + weaveSpan}
                y2={cy + d}
                stroke="#ffffff"
                strokeOpacity={0.14}
                strokeWidth={0.9}
              />
              <line
                x1={cx + d}
                y1={cy - weaveSpan}
                x2={cx + d}
                y2={cy + weaveSpan}
                stroke="#ffffff"
                strokeOpacity={0.08}
                strokeWidth={0.7}
              />
            </g>
          ))}
        </g>
      )}

      {/* Clean outer blade rim */}
      <polygon
        points={clipPoly}
        fill="none"
        stroke="#e2e8f0"
        strokeOpacity={0.78}
        strokeWidth={1.35}
      />

      {/* Row 1: Tip flex & tip twist */}
      <line
        x1={teXOfRow(tipRow) - 10}
        y1={tipY}
        x2={leaderEndX}
        y2={tipY}
        stroke="#e2e8f0"
        strokeOpacity={0.62}
        strokeWidth={1.15}
        strokeDasharray="4 4"
      />
      <text
        x={col1X}
        y={tipY - 12}
        fontSize={10.5}
        fontWeight={600}
        letterSpacing="0.06em"
        fill="#94a3b8"
      >
        TIP FLEX ({loadLabel.toUpperCase()})
      </text>
      <text x={col1X} y={tipY + 12} fontSize={16} fontWeight={600} fill="#f8fafc">
        {analysis.tipDeflectionMm.toFixed(1)} mm
      </text>

      <text
        x={col2X}
        y={tipY - 12}
        fontSize={10.5}
        fontWeight={600}
        letterSpacing="0.06em"
        fill="#94a3b8"
      >
        TIP TWIST
      </text>
      <text x={col2X} y={tipY + 12} fontSize={15} fontWeight={500} fill="#f8fafc">
        {fmtTwistLabel(analysis.tipTwistDeg)}
      </text>
      {Math.abs(analysis.builtInTipTwistDeg) >= 0.05 && (
        <text x={col2X} y={tipY + 27} fontSize={10} fill="#94a3b8">
          flex {fmtSignedDeg(analysis.elasticTipTwistDeg, 1)} · toe{' '}
          {fmtSignedDeg(analysis.builtInTipTwistDeg, 1)}
        </text>
      )}

      {/* Row 2: Upper-mid blade station */}
      <line
        x1={teXOfRow(upperRow) - 6}
        y1={upperY}
        x2={leaderEndX}
        y2={upperY}
        stroke="#e2e8f0"
        strokeOpacity={0.55}
        strokeWidth={1.15}
        strokeDasharray="4 4"
      />
      <text x={col1X} y={upperY + 5} fontSize={15} fontWeight={500} fill="#f1f5f9">
        {fmtDeflMm(upperSt.deflectionMm)}
      </text>
      <text x={col2X} y={upperY + 5} fontSize={14.5} fontWeight={500} fill="#e2e8f0">
        {fmtTwistLabel(upperSt.twistDeg)}
      </text>

      {/* Row 3: Flex hinge amber line across entire blade -> FLEX HINGE | PEAK STRESS */}
      <line
        x1={leXOfRow(hingeRow)}
        y1={hingeY}
        x2={leaderEndX}
        y2={hingeY}
        stroke="#f59e0b"
        strokeOpacity={0.82}
        strokeWidth={1.3}
        strokeDasharray="4 4"
      />
      <text
        x={col1X}
        y={hingeY - 9}
        fontSize={10.5}
        fontWeight={600}
        letterSpacing="0.06em"
        fill="#fbbf24"
      >
        FLEX HINGE
      </text>
      <text x={col1X} y={hingeY + 13} fontSize={15.5} fontWeight={700} fill="#fde68a">
        {Math.round(analysis.flexPointFraction * 100)}% depth
      </text>

      <text
        x={col2X}
        y={hingeY - 9}
        fontSize={10.5}
        fontWeight={600}
        letterSpacing="0.06em"
        fill="#fbbf24"
      >
        PEAK STRESS
      </text>
      <text x={col2X} y={hingeY + 13} fontSize={15} fontWeight={600} fill="#fde68a">
        {analysis.peakStressMPa.toFixed(0)} MPa ({analysis.safetyFactor.toFixed(1)}×)
      </text>

      {/* Row 4: Lower blade station */}
      <line
        x1={teXOfRow(lowerRow) - 6}
        y1={lowerY}
        x2={leaderEndX}
        y2={lowerY}
        stroke="#e2e8f0"
        strokeOpacity={0.5}
        strokeWidth={1.15}
        strokeDasharray="4 4"
      />
      <text x={col1X} y={lowerY + 5} fontSize={15} fontWeight={500} fill="#f1f5f9">
        {fmtDeflMm(lowerSt.deflectionMm)}
      </text>
      <text x={col2X} y={lowerY + 5} fontSize={14.5} fontWeight={500} fill="#e2e8f0">
        {fmtTwistLabel(lowerSt.twistDeg)}
      </text>
    </svg>
  );
}

/** Compact edge-on deflected profile showing undeformed vertical fin vs bent LE/TE curves. */
function DeflectedEdgeSvg({
  analysis,
  loadKg,
  exaggeration,
}: {
  analysis: FinFlexAnalysis;
  loadKg: number;
  exaggeration: number;
}) {
  const { stations, nodes, gridRows, gridCols, depthCm } = analysis;
  const W = 280;
  const H = 176;
  const baseY = 148;
  const topY = 26;
  const midX = 82;
  const maxDefl = Math.max(4, Math.abs(analysis.tipDeflectionMm) * exaggeration);
  const scaleX = 146 / maxDefl;
  const invDepth = depthCm > 0 ? 1 / depthCm : 1;

  const toPt = (deflMm: number, hFrac: number): string =>
    `${(midX + deflMm * exaggeration * scaleX).toFixed(1)},${(baseY - Math.min(1, Math.max(0, hFrac)) * (baseY - topY)).toFixed(1)}`;

  const midPts = stations.map((st) => toPt(st.deflectionMm, st.heightFraction)).join(' ');
  const lePts = Array.from({ length: gridRows }, (_, r) => {
    const n = nodes[r * gridCols]!;
    return toPt(n.deflectionMm, n.zCm * invDepth);
  }).join(' ');
  const tePts = Array.from({ length: gridRows }, (_, r) => {
    const n = nodes[r * gridCols + (gridCols - 1)]!;
    return toPt(n.deflectionMm, n.zCm * invDepth);
  }).join(' ');

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-[176px] w-full"
      role="img"
      aria-label={`Deflected edge profile showing ${analysis.tipDeflectionMm.toFixed(1)} mm tip deflection`}
    >
      <line
        x1={26}
        y1={baseY}
        x2={254}
        y2={baseY}
        stroke="currentColor"
        strokeOpacity={0.38}
        strokeWidth={1.6}
      />
      <line
        x1={midX}
        y1={baseY}
        x2={midX}
        y2={topY}
        stroke="currentColor"
        strokeOpacity={0.28}
        strokeWidth={1.1}
        strokeDasharray="4 4"
      />
      <polyline points={lePts} fill="none" stroke="#38bdf8" strokeWidth={1.7} strokeOpacity={0.9} />
      <polyline points={tePts} fill="none" stroke="#fbbf24" strokeWidth={1.7} strokeOpacity={0.9} />
      <polyline points={midPts} fill="none" stroke="#f8fafc" strokeWidth={2.2} />

      <text x={24} y={16} fontSize={10.5} fill="currentColor" opacity={0.7}>
        {exaggeration}× bend @ {loadKg.toFixed(1).replace(/\.0$/, '')} kg load
      </text>
      <text x={24} y={168} fontSize={10} fill="#38bdf8">
        Cyan = Leading edge
      </text>
      <text x={254} y={168} textAnchor="end" fontSize={10} fill="#fbbf24">
        Amber = Trailing edge
      </text>
    </svg>
  );
}

/** Compact stiffness (kg / 10 mm*) vs weave angle curve (−85°..+90°). */
function WeaveSweepSvg({
  sweep,
  activeAngleDeg,
  targetKgPer10Mm,
}: {
  sweep: readonly WeaveSweepPoint[];
  activeAngleDeg: number;
  targetKgPer10Mm: number | null;
}) {
  if (sweep.length < 2) return null;
  const W = 280;
  const H = 176;
  const padL = 38;
  const padR = 16;
  const padT = 26;
  const padB = 28;
  const vals = sweep.map((p) => nPerMmToKgPer10Mm(p.stiffnessNPerMm));
  const minK = Math.min(...vals, targetKgPer10Mm ?? Infinity) * 0.92;
  const maxK = Math.max(...vals, targetKgPer10Mm ?? -Infinity) * 1.06;
  const spanK = Math.max(0.5, maxK - minK);

  const sx = (ang: number) => padL + ((ang + 90) / 180) * (W - padL - padR);
  const sy = (k: number) => H - padB - ((k - minK) / spanK) * (H - padT - padB);

  const pathPts = sweep
    .map((p, i) => `${sx(p.angleDeg).toFixed(1)},${sy(vals[i]!).toFixed(1)}`)
    .join(' ');
  const activeX = sx(activeAngleDeg);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-[176px] w-full"
      role="img"
      aria-label="Stiffness versus G10 weave angle chart"
    >
      <line
        x1={padL}
        y1={H - padB}
        x2={W - padR}
        y2={H - padB}
        stroke="currentColor"
        strokeOpacity={0.25}
      />
      <line
        x1={padL}
        y1={padT}
        x2={padL}
        y2={H - padB}
        stroke="currentColor"
        strokeOpacity={0.25}
      />
      {targetKgPer10Mm !== null && (
        <line
          x1={padL}
          y1={sy(targetKgPer10Mm)}
          x2={W - padR}
          y2={sy(targetKgPer10Mm)}
          stroke="#fbbf24"
          strokeWidth={1.3}
          strokeDasharray="4 3"
        />
      )}
      <line
        x1={activeX}
        y1={padT}
        x2={activeX}
        y2={H - padB}
        stroke="#34d399"
        strokeWidth={1.5}
        strokeDasharray="4 3"
      />
      <polyline points={pathPts} fill="none" stroke="#38bdf8" strokeWidth={2} />
      <text x={padL} y={15} fontSize={10.5} fill="currentColor" opacity={0.75}>
        Stiffness (kg / 10 mm*) vs Weave (°)
      </text>
      <text
        x={padL - 5}
        y={padT + 4}
        textAnchor="end"
        fontSize={9.5}
        fill="currentColor"
        opacity={0.7}
      >
        {maxK.toFixed(0)}
      </text>
      <text
        x={padL - 5}
        y={H - padB}
        textAnchor="end"
        fontSize={9.5}
        fill="currentColor"
        opacity={0.7}
      >
        {minK.toFixed(0)}
      </text>
      <text
        x={sx(-90)}
        y={H - 10}
        textAnchor="middle"
        fontSize={9.5}
        fill="currentColor"
        opacity={0.7}
      >
        −90°
      </text>
      <text
        x={sx(0)}
        y={H - 10}
        textAnchor="middle"
        fontSize={9.5}
        fill="currentColor"
        opacity={0.7}
      >
        0°
      </text>
      <text
        x={sx(90)}
        y={H - 10}
        textAnchor="middle"
        fontSize={9.5}
        fill="currentColor"
        opacity={0.7}
      >
        +90°
      </text>
    </svg>
  );
}

/** Pick whichever of ±45° gives better wash-out twist on this fin's rake. */
const bestBias45 = (
  design: FinDesign,
  material: (typeof FIN_FLEX_MATERIALS)[number],
  loadN: number,
): 45 | -45 => {
  const pos = analyzeFinFlex(design, { material, weaveAngleDeg: 45, loadN });
  const neg = analyzeFinFlex(design, { material, weaveAngleDeg: -45, loadN });
  return neg.tipTwistDeg < pos.tipTwistDeg ? -45 : 45;
};

export function FlexAnalysisDialog({
  design,
  units,
  onClose,
}: {
  design: FinDesign;
  units: LengthUnit;
  onClose: () => void;
}) {
  const [loadKg, setLoadKg] = useState<number>(15);
  const [targetKgPer10Mm, setTargetKgPer10Mm] = useState<number>(11);
  const [showRefChart, setShowRefChart] = useState<boolean>(false);
  const [materialId, setMaterialId] = useState<string>(G10_MATERIAL.id);
  const [weaveChoice, setWeaveChoice] = useState<WeaveChoice>(() => {
    const saved = design.weaveAngle ?? 0;
    if (saved === 0) return '90-0';
    if (Math.abs(saved) === 45) return '45';
    return 'recommend';
  });
  const [recommendOpen, setRecommendOpen] = useState<boolean>(
    () => (design.weaveAngle ?? 0) !== 0 && Math.abs(design.weaveAngle ?? 0) !== 45,
  );
  const [biasSign, setBiasSign] = useState<45 | -45 | null>(() => {
    const saved = design.weaveAngle ?? 0;
    return saved === 45 ? 45 : saved === -45 ? -45 : null;
  });
  const [adjustStrategy, setAdjustStrategy] =
    useState<FlexDesignAdjustStrategy>('uniform-thickness');
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget>('tuned');
  const [secondaryChart, setSecondaryChart] = useState<SecondaryChart>('deflected');
  const [exaggeration, setExaggeration] = useState<number>(3);
  const [appliedMsg, setAppliedMsg] = useState<string | null>(null);

  const loadN = loadKg * N_PER_KG;
  const targetNPerMm = kgPer10MmToNPerMm(targetKgPer10Mm);

  const material = useMemo(
    () => FIN_FLEX_MATERIALS.find((m) => m.id === materialId) ?? G10_MATERIAL,
    [materialId],
  );
  const isWoven = material.woven !== false;

  const recommendation = useMemo(
    () => recommendWeaveAngle(design, targetNPerMm, { material, loadN }),
    [design, targetNPerMm, material, loadN],
  );

  const autoBias45 = useMemo(() => bestBias45(design, material, loadN), [design, material, loadN]);
  const effectiveBias45 = biasSign ?? autoBias45;

  const activeWeave = !isWoven
    ? (design.weaveAngle ?? 0)
    : weaveChoice === '90-0'
      ? 0
      : weaveChoice === '45'
        ? effectiveBias45
        : recommendation.recommendedAngleDeg;

  const tuning = useMemo(
    () =>
      tuneDesignForStiffness(design, targetNPerMm, activeWeave, {
        strategy: adjustStrategy,
        material,
        loadN,
      }),
    [design, targetNPerMm, activeWeave, adjustStrategy, material, loadN],
  );

  const currentAnalysis = useMemo(
    () => analyzeFinFlex(design, { material, weaveAngleDeg: activeWeave, loadN }),
    [design, material, activeWeave, loadN],
  );
  const tunedAnalysis = useMemo(
    () => analyzeFinFlex(tuning.design, { material, weaveAngleDeg: activeWeave, loadN }),
    [tuning.design, material, activeWeave, loadN],
  );

  const analysis = previewTarget === 'tuned' ? tunedAnalysis : currentAnalysis;
  const displayStiffnessKg = nPerMmToKgPer10Mm(analysis.stiffnessNPerMm);
  const tunedStiffnessKg = nPerMmToKgPer10Mm(tuning.achievedNPerMm);

  const savedWeave = design.weaveAngle ?? 0;
  const weaveUnsaved = activeWeave !== savedWeave;

  const applyWeaveOnly = () => {
    finStore.getState().setWeaveAngle(activeWeave);
    setRecommendOpen(false);
    setAppliedMsg(`Saved ${fmtSignedDeg(activeWeave)} G10 weave angle.`);
  };

  const applyTunedDesign = () => {
    const label =
      adjustStrategy === 'tip-taper'
        ? `Tune tip flex to ${targetKgPer10Mm.toFixed(1)} kg / 10 mm`
        : `Tune thickness flex to ${targetKgPer10Mm.toFixed(1)} kg / 10 mm`;
    const ok = finStore.getState().applyFlexDesign(tuning.design, label);
    if (ok) {
      setAppliedMsg(
        `Applied tuned taper & ${fmtSignedDeg(activeWeave)} weave (${tunedStiffnessKg.toFixed(1)} kg / 10 mm*). Cmd/Ctrl+Z to undo.`,
      );
    }
  };

  const stiffnessSliderPos = MAX_TARGET_KG + MIN_TARGET_KG - targetKgPer10Mm;
  const loadLabel = `${loadKg.toFixed(1).replace(/\.0$/, '')} kg`;

  return (
    <Modal
      name="fin-flex-analysis"
      label="Flex / stiffness analysis and control"
      onClose={onClose}
      className="grid place-items-center p-4"
    >
      <Panel
        className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <PanelHeader className="flex items-center justify-between gap-2 px-5 py-3">
          <div className="flex items-center gap-2.5">
            <Activity className="h-4 w-4 text-sky-400" aria-hidden="true" />
            <PanelTitle className="text-sm font-semibold">
              Flex / stiffness analysis and control
            </PanelTitle>
          </div>
          <Button size="sm" variant="ghost" title="Close" onClick={onClose}>
            ✕
          </Button>
        </PanelHeader>

        <PanelBody className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto p-0 md:grid-cols-[316px_1fr]">
          {/* LEFT SIDEBAR: 4 generously spaced steps */}
          <aside className="flex flex-col justify-between gap-7 border-b border-border bg-muted/15 px-5 py-6 md:border-b-0 md:border-r">
            {/* Step 1: Select lateral load */}
            <section className="space-y-1.5">
              <StepHeader num={1} title="Select lateral load" value={loadLabel} />
              <CleanSlider
                id="flex-load-slider"
                ariaLabel="Select lateral load (kg)"
                min={5}
                max={30}
                step={0.5}
                value={loadKg}
                onChange={setLoadKg}
              />
              <div
                role="radiogroup"
                aria-label="Lateral load presets"
                className="flex items-center justify-between px-0.5 text-[11px]"
              >
                {LOAD_PRESETS.map((p) => {
                  const active = Math.abs(p.valueKg - loadKg) < 0.1;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setLoadKg(p.valueKg)}
                      className={`transition-colors ${
                        active
                          ? 'font-semibold text-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Step 2: Select target stiffness */}
            <section className="space-y-1.5">
              <StepHeader
                num={2}
                title="Select target stiffness"
                value={`${targetKgPer10Mm.toFixed(1)} kg / 10 mm*`}
              />
              <CleanSlider
                id="flex-target-slider"
                ariaLabel="Select target stiffness (kg per 10 mm)"
                min={MIN_TARGET_KG}
                max={MAX_TARGET_KG}
                step={0.5}
                value={stiffnessSliderPos}
                onChange={(pos) => {
                  setTargetKgPer10Mm(MAX_TARGET_KG + MIN_TARGET_KG - pos);
                  setAppliedMsg(null);
                }}
                trackGradient="linear-gradient(90deg, #1d4ed8 0%, #0ea5e9 34%, #10b981 62%, #f59e0b 100%)"
              />
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>Stiff (&gt;13)</span>
                <span>Balanced (7–13)</span>
                <span>Flexy (&lt;7)</span>
              </div>
              <button
                type="button"
                onClick={() => setShowRefChart((v) => !v)}
                className="pt-0.5 text-left text-xs font-medium text-sky-400 underline underline-offset-4 hover:text-sky-300"
              >
                {showRefChart
                  ? 'Hide surfer weight / power reference chart'
                  : 'Surfer weight / power reference chart'}
              </button>
              {showRefChart && (
                <div className="space-y-1.5 rounded-lg border border-border bg-background/70 p-2.5 text-[11px]">
                  <p className="font-semibold text-foreground">
                    Weight &amp; wave power guide (click a row to apply)
                  </p>
                  <table className="w-full border-collapse text-left">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground">
                        <th className="py-1 pr-1.5 font-medium">Surfer / surf</th>
                        <th className="py-1 pr-1.5 font-medium">Load</th>
                        <th className="py-1 font-medium">Target</th>
                      </tr>
                    </thead>
                    <tbody>
                      {SURFER_REFERENCE_ROWS.map((row) => (
                        <tr
                          key={row.profile}
                          onClick={() => {
                            setLoadKg(row.loadKg);
                            setTargetKgPer10Mm(row.targetKg);
                            setAppliedMsg(null);
                          }}
                          className="cursor-pointer border-b border-border/50 last:border-b-0 hover:bg-muted/60"
                        >
                          <td className="py-1.5 pr-1.5">{row.profile}</td>
                          <td className="whitespace-nowrap py-1.5 pr-1.5 tabular-nums">
                            {row.loadRange}
                          </td>
                          <td className="whitespace-nowrap py-1.5 font-medium tabular-nums text-sky-400">
                            {row.stiffnessRange}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Step 3: Select fin material & weave angle */}
            <section className="relative z-20 space-y-2.5">
              <StepHeader
                num={3}
                title="Select fin material"
                value={isWoven ? fmtSignedDeg(activeWeave) : '3D print'}
              />
              <select
                aria-label="Laminate material"
                value={materialId}
                onChange={(e) => {
                  const nextId = e.target.value;
                  setMaterialId(nextId);
                  setAppliedMsg(null);
                  const nextMat = FIN_FLEX_MATERIALS.find((m) => m.id === nextId);
                  if (nextMat?.woven === false) {
                    setRecommendOpen(false);
                    if (secondaryChart === 'weave-curve') setSecondaryChart('deflected');
                  }
                }}
                className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-xs text-foreground"
              >
                {FIN_FLEX_MATERIALS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} ({m.woven === false ? `${m.e1GPa} GPa` : `${m.e1GPa}/${m.e2GPa} GPa`})
                  </option>
                ))}
              </select>

              {isWoven ? (
                <>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      <span>Weave angle</span>
                      {weaveChoice === '45' && (
                        <button
                          type="button"
                          onClick={() => {
                            setBiasSign(effectiveBias45 === 45 ? -45 : 45);
                            setAppliedMsg(null);
                          }}
                          className="normal-case tracking-normal text-sky-400 underline underline-offset-2 hover:text-sky-300"
                        >
                          Flip to {effectiveBias45 === 45 ? '−45°' : '+45°'}
                        </button>
                      )}
                      {weaveChoice === 'recommend' && !recommendOpen && (
                        <button
                          type="button"
                          onClick={() => setRecommendOpen(true)}
                          className="normal-case tracking-normal text-sky-400 underline underline-offset-2 hover:text-sky-300"
                        >
                          Show recommendation
                        </button>
                      )}
                    </div>
                    <div
                      role="radiogroup"
                      aria-label="Weave angle"
                      className="flex items-center justify-between gap-2 pt-0.5 text-xs"
                    >
                      {(
                        [
                          { id: '90-0', label: '90/0' },
                          { id: '45', label: '45°' },
                          { id: 'recommend', label: 'Recommend' },
                        ] as const
                      ).map((opt) => {
                        const checked = weaveChoice === opt.id;
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            role="radio"
                            aria-checked={checked}
                            onClick={() => {
                              setWeaveChoice(opt.id);
                              setAppliedMsg(null);
                              if (opt.id === 'recommend') {
                                setRecommendOpen(true);
                                setSecondaryChart('weave-curve');
                              } else {
                                setRecommendOpen(false);
                              }
                            }}
                            className={`flex items-center gap-2 transition-colors ${
                              checked
                                ? 'font-semibold text-foreground'
                                : 'text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            <span>{opt.label}</span>
                            <span
                              aria-hidden="true"
                              className={`flex h-3.5 w-3.5 items-center justify-center rounded-full border-2 ${
                                checked
                                  ? 'border-white bg-slate-950'
                                  : 'border-white/70 bg-white/90'
                              }`}
                            >
                              {checked && <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {weaveChoice !== 'recommend' && weaveUnsaved && (
                    <Button size="sm" variant="outline" className="w-full" onClick={applyWeaveOnly}>
                      Save {fmtSignedDeg(activeWeave)} weave angle
                    </Button>
                  )}

                  {/* Floating Recommend card positioned over Step 4 so layout never jumps */}
                  {weaveChoice === 'recommend' && recommendOpen && (
                    <div
                      role="region"
                      aria-label="Recommended weave angle"
                      className="absolute left-0 right-0 top-full z-30 mt-2 space-y-2.5 rounded-lg border border-dashed border-sky-400/50 bg-slate-950/95 p-3.5 text-xs shadow-2xl ring-1 ring-border/80 backdrop-blur-md"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-muted-foreground">
                          Optimal weave angle for target stiffness
                        </span>
                        <div className="flex items-center gap-2">
                          <span className="whitespace-nowrap font-bold tabular-nums text-sky-400">
                            {fmtSignedDeg(recommendation.recommendedAngleDeg)}
                          </span>
                          <button
                            type="button"
                            aria-label="Close recommendation"
                            onClick={() => setRecommendOpen(false)}
                            className="rounded px-1 text-[11px] text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                        <span>Weave-only range</span>
                        <span className="tabular-nums text-foreground/85">
                          {nPerMmToKgPer10Mm(recommendation.achievableMinNPerMm).toFixed(1)}–
                          {nPerMmToKgPer10Mm(recommendation.achievableMaxNPerMm).toFixed(1)} kg / 10
                          mm*
                        </span>
                      </div>
                      {!recommendation.withinRange && (
                        <div className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-200">
                          <AlertTriangle
                            className="mt-0.5 h-3.5 w-3.5 shrink-0"
                            aria-hidden="true"
                          />
                          <span>Outside weave-only range — adjust thickness in Step 4 below.</span>
                        </div>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full"
                        onClick={applyWeaveOnly}
                      >
                        Apply
                      </Button>
                    </div>
                  )}
                </>
              ) : (
                <p className="rounded-lg border border-border/70 bg-background/50 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
                  Chopped-CF 3D-printed filament is quasi-isotropic (no weave angle) and modeled
                  with seawater-conditioned stiffness. Print flat on its side with 5–6+ solid walls
                  through the tab, and use Step 4 below to thicken for your target stiffness.
                </p>
              )}
            </section>

            {/* Step 4: Adjust geometry */}
            <section className="space-y-3">
              <StepHeader num={4} title="Adjust geometry" />
              <SegmentedControl
                ariaLabel="Geometry adjustment strategy"
                value={adjustStrategy}
                options={[
                  { id: 'uniform-thickness', label: 'Whole thickness' },
                  { id: 'tip-taper', label: 'Tip taper (keep root)' },
                ]}
                onChange={(strat) => {
                  setAdjustStrategy(strat);
                  setPreviewTarget('tuned');
                  setAppliedMsg(null);
                }}
                fullWidth
              />

              <div className="space-y-1.5 px-0.5 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Root thickness</span>
                  <span className="tabular-nums text-muted-foreground">
                    {fmtThick(tuning.rootThicknessBeforeCm, units)} →{' '}
                    <strong className="text-foreground">
                      {fmtThick(tuning.rootThicknessAfterCm, units)}
                    </strong>
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Tip thickness</span>
                  <span className="tabular-nums text-muted-foreground">
                    {fmtThick(tuning.tipThicknessBeforeCm, units)} →{' '}
                    <strong className="text-foreground">
                      {fmtThick(tuning.tipThicknessAfterCm, units)}
                    </strong>
                  </span>
                </div>
                <div className="flex justify-between pt-1">
                  <span className="text-muted-foreground">Resulting stiffness</span>
                  <span className="font-bold tabular-nums text-emerald-400">
                    {tunedStiffnessKg.toFixed(1)} kg / 10 mm*
                  </span>
                </div>
              </div>

              <button
                type="button"
                onClick={applyTunedDesign}
                className="w-full rounded-md bg-cyan-400 px-3 py-2 text-xs font-bold text-slate-950 shadow-sm transition-colors hover:bg-cyan-300"
              >
                Apply tuned taper
              </button>

              {appliedMsg && (
                <p role="status" className="text-xs font-medium text-emerald-400">
                  {appliedMsg}
                </p>
              )}
            </section>
          </aside>

          {/* RIGHT WORKSPACE: Headline -> Full-Width Hero Flex Map -> Bottom Chart + Guide Row */}
          <div className="flex flex-col gap-3.5 p-5">
            {/* Top Bar: Headline Stiffness + Current / Tuned Toggle */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-medium tracking-tight tabular-nums text-foreground">
                {previewTarget === 'tuned' ? 'Target stiffness:' : 'Current fin stiffness:'}{' '}
                <span className="font-semibold">
                  {displayStiffnessKg.toFixed(1)} kg / 10 mm bend*
                </span>
              </h2>
              <SegmentedControl
                ariaLabel="Preview current or tuned fin"
                value={previewTarget}
                options={[
                  { id: 'current', label: 'Current fin' },
                  { id: 'tuned', label: 'Tuned preview' },
                ]}
                onChange={setPreviewTarget}
              />
            </div>

            {/* Hero Card: Full-width Blade Flex Map with integrated inline KPI & station callouts */}
            <div className="rounded-xl border border-border/70 bg-slate-950/55 px-3 py-2">
              <HeroFinFlexSvg analysis={analysis} loadLabel={loadLabel} showWeave={isWoven} />
            </div>

            {/* Bottom Row: Edge Bend / Weave Curve (left) + Twist Guide & Lab Footnote (right) */}
            <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-[0.88fr_1.12fr]">
              {/* Bottom-left: Edge Bend / Weave Curve */}
              <div className="flex flex-col rounded-xl border border-border/70 bg-muted/15 p-2.5">
                <div className="mb-1 flex items-center justify-between gap-2">
                  {isWoven ? (
                    <SegmentedControl
                      ariaLabel="Secondary chart"
                      value={secondaryChart}
                      options={[
                        { id: 'deflected', label: 'Edge bend' },
                        { id: 'weave-curve', label: 'Weave curve' },
                      ]}
                      onChange={setSecondaryChart}
                      compact
                    />
                  ) : (
                    <span className="px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Edge bend
                    </span>
                  )}
                  {(!isWoven || secondaryChart === 'deflected') && (
                    <SegmentedControl
                      ariaLabel="Bend exaggeration"
                      value={String(exaggeration) as '1' | '3'}
                      options={[
                        { id: '1', label: '1×' },
                        { id: '3', label: '3×' },
                      ]}
                      onChange={(v) => setExaggeration(Number(v))}
                      compact
                    />
                  )}
                </div>
                {!isWoven || secondaryChart === 'deflected' ? (
                  <DeflectedEdgeSvg
                    analysis={analysis}
                    loadKg={loadKg}
                    exaggeration={exaggeration}
                  />
                ) : (
                  <WeaveSweepSvg
                    sweep={recommendation.sweep}
                    activeAngleDeg={activeWeave}
                    targetKgPer10Mm={targetKgPer10Mm}
                  />
                )}
              </div>

              {/* Bottom-right: Twist Guide + Lab Bench Measurement */}
              <div className="flex flex-col justify-between gap-4 rounded-xl border border-border/70 bg-muted/10 p-4 text-xs leading-relaxed text-muted-foreground">
                <div className="space-y-0.5">
                  <p className="font-semibold text-foreground">Twist guide:</p>
                  <p>
                    <strong className="text-foreground">Wash-out (−)</strong> spills load smoothly
                    to lower tip AoA
                  </p>
                  <p>
                    <strong className="text-foreground">Wash-in (+)</strong> twists the leading edge
                    steeper into the flow (higher stall risk).
                  </p>
                </div>
                <div className="space-y-0.5">
                  <p className="font-semibold text-foreground">* Lab bench measurement:</p>
                  <p>
                    sideways push (kg) at 75% depth to bend a clamped fin 10 mm. In water, pressure
                    spreads across the fin blade (~40–45% depth), so tip flex at the same load is
                    smaller.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </PanelBody>

        <div className="flex items-center justify-between border-t border-border px-5 py-2.5 text-xs text-muted-foreground">
          <span>
            2D orthotropic Kirchhoff plate model (clamped on {design.base} tab) · nominal laminate
            properties.
          </span>
          <Button size="sm" variant="secondary" onClick={onClose}>
            Done
          </Button>
        </div>
      </Panel>
    </Modal>
  );
}
