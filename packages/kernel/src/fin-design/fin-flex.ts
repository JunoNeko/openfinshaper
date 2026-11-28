// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Fin flex & directional stiffness analysis for woven G10 (and other composite) fins.
 *
 * Models the fin blade as a variable-thickness orthotropic thin plate clamped along its
 * tab footprint using Discrete Kirchhoff Triangular (DKT) elements (Batoz, Bathe & Ho,
 * 1980). DKT has 3 DOFs per node (out-of-plane deflection `w` and slopes `w,x`, `w,z`),
 * is completely free of shear locking even at razor-thin fin tips, and naturally captures
 * both geometric bend–twist coupling (from sweep/rake and quarter-chord hydrodynamic
 * loading) and laminate bend–twist coupling (from off-axis G10 weave orientation).
 *
 * Units:
 * - Kernel geometry is cm (`smoothBlade`, `finTabOutline`); internally converted to
 *   SI (metres, Pascals, Newtons) for assembly, and reported in practical surfing
 *   engineering units: N/mm (bench stiffness), mm (deflection), degrees (twist & weave
 *   angle), and MPa (peak surface bending stress).
 *
 * Weave angle convention (`weaveAngleDeg`, −90° to +90°, default 0°):
 * - 0° aligns the G10 warp fibers (`E1`) parallel to the fin base (+X) and the fill
 *   fibers (`E2`) vertically up the fin depth (+Z).
 * - Positive angles rotate the warp/fill axes counter-clockwise in the profile (x, z)
 *   plane, tilting the warp toward the leading edge / swept tip.
 */
import { splineFromKnots, type Spline } from '../bezier-spline';
import { DEG_TO_RAD, RAD_TO_DEG } from '../constants';
import { knot } from '../knot';
import { vec2, type Vec2 } from '../vec2';
import { twistAt } from './blade';
import { finMinThickness, type FinDesign } from './fin-design';
import { finReadouts } from './fin-readouts';
import { finTabOutline } from './fin-tab';
import { smoothBlade } from './smooth-blade';
import { validateFinDesign } from './fin-rules';

/** Orthotropic laminate elastic properties in the material's principal (0°/90°) axes. */
export interface FinFlexMaterial {
  readonly id: string;
  readonly label: string;
  /** Warp (0°) flexural modulus (GPa). */
  readonly e1GPa: number;
  /** Fill (90°) flexural modulus (GPa). */
  readonly e2GPa: number;
  /** In-plane shear modulus G12 (GPa). Controls 45° bias compliance and torsion. */
  readonly g12GPa: number;
  /** Major in-plane Poisson's ratio ν12. */
  readonly nu12: number;
  /** Ultimate flexural strength (MPa), used for safety-factor reporting. */
  readonly strengthMPa: number;
  /**
   * True (default) for woven/directional laminates where weave orientation changes stiffness;
   * false for quasi-isotropic 3D-printed chopped-fiber filaments.
   */
  readonly woven?: boolean;
}

/** Standard woven E-glass / epoxy G10/FR-4 sheet (balanced orthogonal weave). */
export const G10_MATERIAL: FinFlexMaterial = {
  id: 'g10',
  label: 'G10 woven fiberglass',
  e1GPa: 23.0,
  e2GPa: 22.0,
  g12GPa: 4.5,
  nu12: 0.14,
  strengthMPa: 380,
  woven: true,
};

/** Built-in reference materials: woven composites and wet-conditioned 3D-printed CF filaments. */
export const FIN_FLEX_MATERIALS: readonly FinFlexMaterial[] = [
  G10_MATERIAL,
  {
    id: 'g10-stiff',
    label: 'G10 high-glass (dense)',
    e1GPa: 26.0,
    e2GPa: 25.0,
    g12GPa: 5.0,
    nu12: 0.14,
    strengthMPa: 410,
    woven: true,
  },
  {
    id: 'honeycomb',
    label: 'Fiberglass / honeycomb (effective)',
    e1GPa: 14.5,
    e2GPa: 14.0,
    g12GPa: 3.1,
    nu12: 0.15,
    strengthMPa: 240,
    woven: true,
  },
  {
    id: 'carbon-glass',
    label: 'Carbon / fiberglass hybrid',
    e1GPa: 36.0,
    e2GPa: 32.0,
    g12GPa: 6.2,
    nu12: 0.12,
    strengthMPa: 520,
    woven: true,
  },
  {
    id: 'ppa-cf',
    label: 'PPA-CF (3D print)',
    e1GPa: 9.6,
    e2GPa: 9.6,
    g12GPa: 3.55,
    nu12: 0.35,
    strengthMPa: 185,
    woven: false,
  },
  {
    id: 'pps-cf',
    label: 'PPS-CF (3D print)',
    e1GPa: 7.2,
    e2GPa: 7.2,
    g12GPa: 2.65,
    nu12: 0.35,
    strengthMPa: 155,
    woven: false,
  },
  {
    id: 'pet-cf',
    label: 'PET-CF (3D print)',
    e1GPa: 5.2,
    e2GPa: 5.2,
    g12GPa: 1.9,
    nu12: 0.36,
    strengthMPa: 115,
    woven: false,
  },
];

/** Default hydrodynamic turn load (N): representative strong bottom turn on one fin. */
export const DEFAULT_FLEX_LOAD_N = 150;

/** Allowed weave angle range (deg). */
export const WEAVE_ANGLE_LIMITS = { min: -90, max: 90 } as const;

/** Stiffness feel band, anchored to Surf Flex Lab (UOW) N/mm bench benchmarks. */
export type StiffnessBand = 'flexy' | 'balanced' | 'stiff';

export const classifyStiffness = (nPerMm: number): StiffnessBand =>
  nPerMm < 7 ? 'flexy' : nPerMm <= 13 ? 'balanced' : 'stiff';

export const STIFFNESS_BAND_LABEL: Record<StiffnessBand, string> = {
  flexy: 'Flexy (speed generating)',
  balanced: 'Balanced',
  stiff: 'Stiff (speed control)',
};

/** One spanwise station of the deflected fin under the hydrodynamic turn load. */
export interface FlexSpanStation {
  /** Fraction of depth from base (0) to tip (1). */
  readonly heightFraction: number;
  /** Mean lateral deflection across the chord at this height (mm). */
  readonly deflectionMm: number;
  /**
   * Chordwise twist angle (deg): negative is wash-out (trailing edge spills load,
   * reducing effective AoA); positive is wash-in (leading edge deflects further).
  /**
   * Net horizontal-waterline chordwise twist angle (deg) relative to the base:
   * `builtInTwistDeg + elasticTwistDeg`. Negative is wash-out (effective AoA decreases,
   * spilling load smoothly); positive is wash-in (effective AoA increases).
   */
  readonly twistDeg: number;
  /** Elastic twist caused purely by flex under load along the horizontal flow (deg). */
  readonly elasticTwistDeg: number;
  /** Built-in geometric toe change from cant lines relative to the base (deg). */
  readonly builtInTwistDeg: number;
  /** Mean bending curvature magnitude at this height (1/m). */
  readonly curvaturePerM: number;
  /** Representative profile (x, z) point on the mid-chord (cm). */
  readonly xCm: number;
  readonly zCm: number;
}

/** One mesh node in the 2D profile (tab frame, cm) with solved flex results. */
export interface FlexMeshNode {
  readonly xCm: number;
  readonly zCm: number;
  readonly thicknessCm: number;
  readonly deflectionMm: number;
  /** Normalized bending strain intensity 0..1 relative to the peak across the blade. */
  readonly strainRatio: number;
  readonly clamped: boolean;
}

/** One triangle of the solved plate mesh, indexing into `FlexAnalysis.nodes`. */
export type FlexTriangle = readonly [number, number, number];

/** Complete structural flex analysis of a fin design at a given weave angle and load. */
export interface FinFlexAnalysis {
  readonly material: FinFlexMaterial;
  readonly weaveAngleDeg: number;
  readonly loadN: number;
  /** Bench-rig lateral stiffness (N/mm) for a point load at 75% depth on the thickness path. */
  readonly stiffnessNPerMm: number;
  readonly band: StiffnessBand;
  /** Maximum tip lateral deflection (mm) under `loadN` hydrodynamic turn pressure. */
  readonly tipDeflectionMm: number;
  /**
   * Net tip twist (deg) at ~80% span under `loadN` (`builtInTipTwistDeg + elasticTipTwistDeg`).
   * Negative = wash-out (spills excess AoA smoothly), positive = wash-in.
   */
  readonly tipTwistDeg: number;
  /** Pure elastic tip twist from flex under `loadN` along horizontal waterlines (deg). */
  readonly elasticTipTwistDeg: number;
  /** Built-in geometric tip toe from cant lines relative to the base (deg). */
  readonly builtInTipTwistDeg: number;
  /** Total fin depth (cm), for true-height edge-bend plotting. */
  readonly depthCm: number;
  /**
   * Effective flex hinge along depth (0 = base, 1 = tip): curvature-weighted centroid of
   * bending strain along the span.
   */
  readonly flexPointFraction: number;
  /** Maximum surface bending stress (MPa) under `loadN`. */
  readonly peakStressMPa: number;
  /** Material flexural strength / peakStressMPa. */
  readonly safetyFactor: number;
  /** Primary bending axis angle (deg from +X base axis) for directional reporting. */
  readonly sweepAxisDeg: number;
  /** Effective flexural modulus along the fin's sweep axis at this weave angle (GPa). */
  readonly sweepModulusGPa: number;
  /** Spanwise deflection and twist stations from base to tip. */
  readonly stations: readonly FlexSpanStation[];
  /** Mesh nodes and triangles for 2D heatmap and 3D deflected visualization. */
  readonly nodes: readonly FlexMeshNode[];
  readonly triangles: readonly FlexTriangle[];
  /** Grid dimensions `(rows = nS + 1, cols = nU + 1)` matching `nodes` in row-major order. */
  readonly gridRows: number;
  readonly gridCols: number;
}

/** One sample on the stiffness-vs-weave-angle sweep curve. */
export interface WeaveSweepPoint {
  readonly angleDeg: number;
  readonly stiffnessNPerMm: number;
  readonly tipTwistDeg: number;
}

/** Result of recommending a G10 weave angle to hit a target stiffness without changing shape. */
export interface WeaveRecommendation {
  readonly targetNPerMm: number;
  readonly recommendedAngleDeg: number;
  readonly achievedNPerMm: number;
  readonly tipTwistDeg: number;
  readonly achievableMinNPerMm: number;
  readonly achievableMaxNPerMm: number;
  readonly withinRange: boolean;
  readonly sweep: readonly WeaveSweepPoint[];
  readonly note: string;
}

/** How to modify geometry when weave angle is locked and target stiffness is requested. */
export type FlexDesignAdjustStrategy = 'uniform-thickness' | 'tip-taper';

/** Result of adjusting a fin's thickness/taper at a locked weave angle to reach target stiffness. */
export interface FlexDesignAdjustment {
  readonly design: FinDesign;
  readonly strategy: FlexDesignAdjustStrategy;
  readonly weaveAngleDeg: number;
  readonly targetNPerMm: number;
  readonly achievedNPerMm: number;
  readonly rootThicknessBeforeCm: number;
  readonly rootThicknessAfterCm: number;
  readonly tipThicknessBeforeCm: number;
  readonly tipThicknessAfterCm: number;
  readonly clamped: boolean;
  readonly note: string;
}

// ---------------------------------------------------------------------------
// Orthotropic Classical Laminate Theory (CLT) elasticity helpers
// ---------------------------------------------------------------------------

/** 3×3 symmetric reduced stiffness matrix Q-bar (Pa) packed as [Q11, Q12, Q16, Q22, Q26, Q66]. */
export type QBar = readonly [number, number, number, number, number, number];

/**
 * Reduced plane-stress stiffness matrix rotated by `weaveAngleDeg` (CCW from +X) in Pa.
 * Strain vector is `[ε_xx, ε_zz, γ_xz]` (engineering shear strain).
 */
export const rotatedQMatrix = (mat: FinFlexMaterial, weaveAngleDeg: number): QBar => {
  const e1 = mat.e1GPa * 1e9;
  const e2 = mat.e2GPa * 1e9;
  const g12 = mat.g12GPa * 1e9;
  const nu12 = mat.nu12;
  const nu21 = (nu12 * e2) / e1;
  const denom = 1 - nu12 * nu21;
  const q11 = e1 / denom;
  const q22 = e2 / denom;
  const q12 = (nu12 * e2) / denom;
  const q66 = g12;

  const th = weaveAngleDeg * DEG_TO_RAD;
  const m = Math.cos(th);
  const n = Math.sin(th);
  const m2 = m * m;
  const n2 = n * n;
  const m3 = m2 * m;
  const n3 = n2 * n;
  const m4 = m2 * m2;
  const n4 = n2 * n2;

  const qb11 = q11 * m4 + 2 * (q12 + 2 * q66) * m2 * n2 + q22 * n4;
  const qb22 = q11 * n4 + 2 * (q12 + 2 * q66) * m2 * n2 + q22 * m4;
  const qb12 = (q11 + q22 - 4 * q66) * m2 * n2 + q12 * (m4 + n4);
  const qb66 = (q11 + q22 - 2 * q12 - 2 * q66) * m2 * n2 + q66 * (m4 + n4);
  const qb16 = (q11 - q12 - 2 * q66) * n * m3 + (q12 - q22 + 2 * q66) * n3 * m;
  const qb26 = (q11 - q12 - 2 * q66) * n3 * m + (q12 - q22 + 2 * q66) * n * m3;

  return [qb11, qb12, qb16, qb22, qb26, qb66];
};

/**
 * Effective uniaxial flexural modulus (GPa) along loading direction `directionDeg` (CCW
 * from +X) when the material's 0° warp is oriented at `weaveAngleDeg`.
 *
 * Uses the exact orthotropic compliance transformation `1 / E(φ) = S_11(φ)` where
 * `φ = directionDeg − weaveAngleDeg`.
 */
export const directionalFlexuralModulus = (
  mat: FinFlexMaterial,
  weaveAngleDeg: number,
  directionDeg: number,
): number => {
  const phi = (directionDeg - weaveAngleDeg) * DEG_TO_RAD;
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  const c2 = c * c;
  const s2 = s * s;
  const invE =
    (c2 * c2) / mat.e1GPa +
    (s2 * s2) / mat.e2GPa +
    (1 / mat.g12GPa - (2 * mat.nu12) / mat.e1GPa) * c2 * s2;
  return 1 / invE;
};

/**
 * Sample the 360° directional flexural modulus polar curve ("Flex Rose") for plotting.
 */
export const directionalStiffnessPolar = (
  mat: FinFlexMaterial,
  weaveAngleDeg: number,
  steps = 72,
): { angleDeg: number; modulusGPa: number }[] =>
  Array.from({ length: steps }, (_, i) => {
    const angleDeg = (i * 360) / steps;
    return { angleDeg, modulusGPa: directionalFlexuralModulus(mat, weaveAngleDeg, angleDeg) };
  });

// ---------------------------------------------------------------------------
// Discrete Kirchhoff Triangular (DKT) plate element (Batoz, Bathe & Ho 1980)
// ---------------------------------------------------------------------------

/** Three midpoint Gauss points in barycentric coordinates (L1, L2, L3), exact for degree 2. */
const GAUSS_3: readonly (readonly [number, number, number])[] = [
  [0.5, 0.5, 0],
  [0, 0.5, 0.5],
  [0.5, 0, 0.5],
];

/**
 * Compute the 3×9 DKT curvature matrix `B` at barycentric point `(L1, L2, L3)` for a
 * triangle with vertices `(x1, z1), (x2, z2), (x3, z3)` in metres.
 *
 * Nodal DOF order: `[w1, bx1, bz1, w2, bx2, bz2, w3, bx3, bz3]` where `bx = ∂w/∂x`
 * and `bz = ∂w/∂z`. Curvature vector is `[∂bx/∂x, ∂bz/∂z, ∂bx/∂z + ∂bz/∂x]`.
 */
const dktCurvatureMatrix = (
  x1: number,
  z1: number,
  x2: number,
  z2: number,
  x3: number,
  z3: number,
  L1: number,
  L2: number,
  L3: number,
): { area: number; B: Float64Array } | null => {
  const twoA = (x2 - x1) * (z3 - z1) - (x3 - x1) * (z2 - z1);
  if (Math.abs(twoA) < 1e-14) return null;
  const inv2A = 1 / twoA;

  // Constant gradients of barycentric coordinates L1, L2, L3 w.r.t. x and z.
  const dL1dx = (z2 - z3) * inv2A;
  const dL1dz = (x3 - x2) * inv2A;
  const dL2dx = (z3 - z1) * inv2A;
  const dL2dz = (x1 - x3) * inv2A;
  const dL3dx = (z1 - z2) * inv2A;
  const dL3dz = (x2 - x1) * inv2A;

  // Derivatives of the 6 quadratic shape functions (N1..N3 vertices, N4..N6 midpoints 12, 23, 31).
  const dNdx = [
    (4 * L1 - 1) * dL1dx,
    (4 * L2 - 1) * dL2dx,
    (4 * L3 - 1) * dL3dx,
    4 * (L1 * dL2dx + L2 * dL1dx),
    4 * (L2 * dL3dx + L3 * dL2dx),
    4 * (L3 * dL1dx + L1 * dL3dx),
  ];
  const dNdz = [
    (4 * L1 - 1) * dL1dz,
    (4 * L2 - 1) * dL2dz,
    (4 * L3 - 1) * dL3dz,
    4 * (L1 * dL2dz + L2 * dL1dz),
    4 * (L2 * dL3dz + L3 * dL2dz),
    4 * (L3 * dL1dz + L1 * dL3dz),
  ];

  // Edge vectors: edge 4 = (1→2), edge 5 = (2→3), edge 6 = (3→1).
  const edges: readonly [number, number, number, number, number][] = [
    [0, 1, x2 - x1, z2 - z1, 3],
    [1, 2, x3 - x2, z3 - z2, 4],
    [2, 0, x1 - x3, z1 - z3, 5],
  ];

  // Express βx = Σ Hx_j q_j and βz = Σ Hz_j q_j via their gradients (length 9 each).
  const dHxdx = new Float64Array(9);
  const dHxdz = new Float64Array(9);
  const dHzdx = new Float64Array(9);
  const dHzdz = new Float64Array(9);

  // Direct vertex contributions: βx at vertex i is q[3i+1], βz at vertex i is q[3i+2].
  for (let i = 0; i < 3; i++) {
    dHxdx[3 * i + 1] = dNdx[i]!;
    dHxdz[3 * i + 1] = dNdz[i]!;
    dHzdx[3 * i + 2] = dNdx[i]!;
    dHzdz[3 * i + 2] = dNdz[i]!;
  }

  // Midpoint contributions from Kirchhoff edge constraints (exact for linear curvature).
  for (const [ia, ib, dx, dz, midIdx] of edges) {
    const l2 = dx * dx + dz * dz;
    if (l2 < 1e-18) return null;
    const len = Math.sqrt(l2);
    const c = dx / len;
    const s = dz / len;
    const wx = (1.5 * c) / len;
    const wz = (1.5 * s) / len;
    const axx = 0.5 - 0.75 * c * c;
    const azz = 0.5 - 0.75 * s * s;
    const axz = -0.75 * c * s;

    const gx = dNdx[midIdx]!;
    const gz = dNdz[midIdx]!;

    // βx_mid = wx*(wb - wa) + axx*(bxa + bxb) + axz*(bza + bzb)
    dHxdx[3 * ia] = dHxdx[3 * ia]! - wx * gx;
    dHxdx[3 * ib] = dHxdx[3 * ib]! + wx * gx;
    dHxdx[3 * ia + 1] = dHxdx[3 * ia + 1]! + axx * gx;
    dHxdx[3 * ib + 1] = dHxdx[3 * ib + 1]! + axx * gx;
    dHxdx[3 * ia + 2] = dHxdx[3 * ia + 2]! + axz * gx;
    dHxdx[3 * ib + 2] = dHxdx[3 * ib + 2]! + axz * gx;

    dHxdz[3 * ia] = dHxdz[3 * ia]! - wx * gz;
    dHxdz[3 * ib] = dHxdz[3 * ib]! + wx * gz;
    dHxdz[3 * ia + 1] = dHxdz[3 * ia + 1]! + axx * gz;
    dHxdz[3 * ib + 1] = dHxdz[3 * ib + 1]! + axx * gz;
    dHxdz[3 * ia + 2] = dHxdz[3 * ia + 2]! + axz * gz;
    dHxdz[3 * ib + 2] = dHxdz[3 * ib + 2]! + axz * gz;

    // βz_mid = wz*(wb - wa) + axz*(bxa + bxb) + azz*(bza + bzb)
    dHzdx[3 * ia] = dHzdx[3 * ia]! - wz * gx;
    dHzdx[3 * ib] = dHzdx[3 * ib]! + wz * gx;
    dHzdx[3 * ia + 1] = dHzdx[3 * ia + 1]! + axz * gx;
    dHzdx[3 * ib + 1] = dHzdx[3 * ib + 1]! + axz * gx;
    dHzdx[3 * ia + 2] = dHzdx[3 * ia + 2]! + azz * gx;
    dHzdx[3 * ib + 2] = dHzdx[3 * ib + 2]! + azz * gx;

    dHzdz[3 * ia] = dHzdz[3 * ia]! - wz * gz;
    dHzdz[3 * ib] = dHzdz[3 * ib]! + wz * gz;
    dHzdz[3 * ia + 1] = dHzdz[3 * ia + 1]! + axz * gz;
    dHzdz[3 * ib + 1] = dHzdz[3 * ib + 1]! + axz * gz;
    dHzdz[3 * ia + 2] = dHzdz[3 * ia + 2]! + azz * gz;
    dHzdz[3 * ib + 2] = dHzdz[3 * ib + 2]! + azz * gz;
  }

  // Row 0: κ_xx = ∂βx/∂x, Row 1: κ_zz = ∂βz/∂z, Row 2: κ_xz = ∂βx/∂z + ∂βz/∂x.
  const B = new Float64Array(27);
  for (let j = 0; j < 9; j++) {
    B[j] = dHxdx[j]!;
    B[9 + j] = dHzdz[j]!;
    B[18 + j] = dHxdz[j]! + dHzdx[j]!;
  }
  return { area: Math.abs(twoA) * 0.5, B };
};

/**
 * Banded symmetric positive-definite Cholesky factorization `A = L L^T` in place.
 * Lower triangle stored as `band[row * (bw + 1) + (row - col)]` for `0 <= row - col <= bw`.
 */
const factorBandedCholesky = (band: Float64Array, n: number, bw: number): boolean => {
  const stride = bw + 1;
  for (let i = 0; i < n; i++) {
    const jStart = Math.max(0, i - bw);
    for (let j = jStart; j <= i; j++) {
      let sum = band[i * stride + (i - j)]!;
      const kStart = Math.max(0, i - bw);
      for (let k = kStart; k < j; k++) {
        sum -= band[i * stride + (i - k)]! * band[j * stride + (j - k)]!;
      }
      if (i === j) {
        if (!(sum > 1e-24)) return false;
        band[i * stride] = Math.sqrt(sum);
      } else {
        band[i * stride + (i - j)] = sum / band[j * stride]!;
      }
    }
  }
  return true;
};

/** Solve `L L^T x = rhs` using a factored lower-banded Cholesky matrix. */
const solveBandedCholesky = (
  band: Float64Array,
  n: number,
  bw: number,
  rhs: Float64Array,
): Float64Array => {
  const stride = bw + 1;
  const x = new Float64Array(rhs);
  // Forward substitution L y = rhs
  for (let i = 0; i < n; i++) {
    let sum = x[i]!;
    const jStart = Math.max(0, i - bw);
    for (let j = jStart; j < i; j++) {
      sum -= band[i * stride + (i - j)]! * x[j]!;
    }
    x[i] = sum / band[i * stride]!;
  }
  // Back substitution L^T x = y
  for (let i = n - 1; i >= 0; i--) {
    let sum = x[i]!;
    const jEnd = Math.min(n - 1, i + bw);
    for (let j = i + 1; j <= jEnd; j++) {
      sum -= band[j * stride + (j - i)]! * x[j]!;
    }
    x[i] = sum / band[i * stride]!;
  }
  return x;
};

/** Generic plate mesh input for both real fins and analytical benchmark plates (tests). */
export interface PlateMeshInput {
  /** Node coordinates in metres (`[x0, z0, x1, z1, ...]`). */
  readonly coordsM: Float64Array;
  /** Nodal plate thicknesses in metres. */
  readonly thicknessM: Float64Array;
  /** Triangles indexing into nodes. */
  readonly triangles: readonly FlexTriangle[];
  /** Boolean mask of clamped nodes (length = numNodes; all 3 DOFs fixed to 0). */
  readonly clamped: Uint8Array;
}

/**
 * Assemble and Cholesky-factor a DKT plate stiffness matrix for one mesh + material + weave.
 * Returns a reusable solver so multiple load cases (bench test + hydrodynamic turn load)
 * share a single matrix factorization.
 */
export const buildPlateSolver = (
  mesh: PlateMeshInput,
  material: FinFlexMaterial,
  weaveAngleDeg: number,
) => {
  const nNodes = mesh.thicknessM.length;
  const nDof = nNodes * 3;
  const qb = rotatedQMatrix(material, weaveAngleDeg);

  // Determine exact half-bandwidth across all triangles.
  let maxNodeDiff = 1;
  for (const [a, b, c] of mesh.triangles) {
    const d1 = Math.abs(a - b);
    const d2 = Math.abs(b - c);
    const d3 = Math.abs(c - a);
    if (d1 > maxNodeDiff) maxNodeDiff = d1;
    if (d2 > maxNodeDiff) maxNodeDiff = d2;
    if (d3 > maxNodeDiff) maxNodeDiff = d3;
  }
  const bw = Math.min(nDof - 1, (maxNodeDiff + 1) * 3 - 1);
  const stride = bw + 1;
  const band = new Float64Array(nDof * stride);

  const Ke = new Float64Array(81);
  const dofs = new Int32Array(9);

  for (const [i0, i1, i2] of mesh.triangles) {
    const x1 = mesh.coordsM[i0 * 2]!;
    const z1 = mesh.coordsM[i0 * 2 + 1]!;
    const x2 = mesh.coordsM[i1 * 2]!;
    const z2 = mesh.coordsM[i1 * 2 + 1]!;
    const x3 = mesh.coordsM[i2 * 2]!;
    const z3 = mesh.coordsM[i2 * 2 + 1]!;
    const h1 = mesh.thicknessM[i0]!;
    const h2 = mesh.thicknessM[i1]!;
    const h3 = mesh.thicknessM[i2]!;

    Ke.fill(0);
    let valid = true;
    for (const [L1, L2, L3] of GAUSS_3) {
      const res = dktCurvatureMatrix(x1, z1, x2, z2, x3, z3, L1, L2, L3);
      if (!res) {
        valid = false;
        break;
      }
      const { area, B } = res;
      const h = L1 * h1 + L2 * h2 + L3 * h3;
      const factor = ((h * h * h) / 12) * (area / 3);
      const d11 = qb[0] * factor;
      const d12 = qb[1] * factor;
      const d16 = qb[2] * factor;
      const d22 = qb[3] * factor;
      const d26 = qb[4] * factor;
      const d66 = qb[5] * factor;

      // Ke += B^T D B (only lower triangle needed, mirror at end or directly into band).
      for (let r = 0; r < 9; r++) {
        const b0 = B[r]!;
        const b1 = B[9 + r]!;
        const b2 = B[18 + r]!;
        const db0 = d11 * b0 + d12 * b1 + d16 * b2;
        const db1 = d12 * b0 + d22 * b1 + d26 * b2;
        const db2 = d16 * b0 + d26 * b1 + d66 * b2;
        for (let c = 0; c <= r; c++) {
          Ke[r * 9 + c] = Ke[r * 9 + c]! + db0 * B[c]! + db1 * B[9 + c]! + db2 * B[18 + c]!;
        }
      }
    }
    if (!valid) continue;

    dofs[0] = i0 * 3;
    dofs[1] = i0 * 3 + 1;
    dofs[2] = i0 * 3 + 2;
    dofs[3] = i1 * 3;
    dofs[4] = i1 * 3 + 1;
    dofs[5] = i1 * 3 + 2;
    dofs[6] = i2 * 3;
    dofs[7] = i2 * 3 + 1;
    dofs[8] = i2 * 3 + 2;

    for (let r = 0; r < 9; r++) {
      const gr = dofs[r]!;
      for (let c = 0; c <= r; c++) {
        const gc = dofs[c]!;
        const v = Ke[r * 9 + c]!;
        if (gr >= gc) {
          band[gr * stride + (gr - gc)] = band[gr * stride + (gr - gc)]! + v;
        } else {
          band[gc * stride + (gc - gr)] = band[gc * stride + (gc - gr)]! + v;
        }
      }
    }
  }

  // Apply Dirichlet boundary conditions (clamped DOFs) cleanly by zeroing rows/cols and setting diagonal to 1.
  // First compute a tiny regularization scale in case any corner node was isolated.
  let diagMax = 0;
  for (let i = 0; i < nDof; i++) {
    const d = band[i * stride]!;
    if (d > diagMax) diagMax = d;
  }
  const epsDiag = Math.max(1e-12, diagMax * 1e-12);
  for (let i = 0; i < nDof; i++) {
    if (band[i * stride]! < epsDiag) band[i * stride] = epsDiag;
  }

  const isFixed = (dof: number) => mesh.clamped[Math.floor(dof / 3)] === 1;
  for (let i = 0; i < nDof; i++) {
    if (isFixed(i)) {
      const jStart = Math.max(0, i - bw);
      for (let j = jStart; j < i; j++) band[i * stride + (i - j)] = 0;
      const jEnd = Math.min(nDof - 1, i + bw);
      for (let j = i + 1; j <= jEnd; j++) band[j * stride + (j - i)] = 0;
      band[i * stride] = 1;
    }
  }

  const ok = factorBandedCholesky(band, nDof, bw);
  return {
    ok,
    nDof,
    qb,
    solve: (rhs: Float64Array): Float64Array => {
      if (!ok) return new Float64Array(nDof);
      const clean = new Float64Array(rhs);
      for (let i = 0; i < nDof; i++) {
        if (isFixed(i)) clean[i] = 0;
      }
      return solveBandedCholesky(band, nDof, bw, clean);
    },
  };
};

// ---------------------------------------------------------------------------
// Fin blade meshing on SmoothBlade's elliptic (s, u) grid
// ---------------------------------------------------------------------------

/** Grid density balancing sub-2ms solve speed with smooth contours & accurate convergence. */
const GRID_S = 14;
const GRID_U = 10;
/** Stop slightly short of the tip sliver row `s = 1` so triangles remain well-conditioned. */
const S_MAX = 0.985;

const CM_TO_M = 0.01;

interface FinPlateMesh {
  readonly plate: PlateMeshInput;
  readonly rows: number;
  readonly cols: number;
  /** `(s, u)` parameters per node. */
  readonly sValues: Float64Array;
  readonly uValues: Float64Array;
  /** Profile coordinates in cm (`[x0, z0, ...]`). */
  readonly coordsCm: Float64Array;
  /** Blade thickness in cm per node. */
  readonly thicknessCm: Float64Array;
  /** Fin depth (cm) and sweep axis angle (deg from +X base axis). */
  readonly depthCm: number;
  readonly sweepAxisDeg: number;
  /** Built-in geometric toe change relative to the base (deg) at height fraction `0..1`. */
  readonly builtInToeAt: (heightFraction: number) => number;
}

const tabXSpans = (d: FinDesign): { x0: number; x1: number }[] => {
  const tab = finTabOutline(d.base, d.outline);
  return tab.parts.map((part) => {
    let x0 = Infinity;
    let x1 = -Infinity;
    for (const seg of part.segments) {
      x0 = Math.min(x0, seg.from.x, seg.to.x);
      x1 = Math.max(x1, seg.from.x, seg.to.x);
    }
    return { x0, x1 };
  });
};

const buildFinPlateMesh = (d: FinDesign): FinPlateMesh => {
  const sb = smoothBlade(d);
  const readouts = finReadouts(d);
  const rows = GRID_S + 1;
  const cols = GRID_U + 1;
  const nNodes = rows * cols;
  const coordsCm = new Float64Array(nNodes * 2);
  const coordsM = new Float64Array(nNodes * 2);
  const thicknessCm = new Float64Array(nNodes);
  const thicknessM = new Float64Array(nNodes);
  const sValues = new Float64Array(nNodes);
  const uValues = new Float64Array(nNodes);
  const clamped = new Uint8Array(nNodes);

  const minH = Math.max(0.03, finMinThickness(d));
  const spans = tabXSpans(d);
  const inTab = (x: number): boolean => spans.some((sp) => x >= sp.x0 - 0.12 && x <= sp.x1 + 0.12);

  let clampedCount = 0;
  for (let r = 0; r < rows; r++) {
    const s = (r / GRID_S) * S_MAX;
    for (let c = 0; c < cols; c++) {
      // Mild cosine clustering toward LE/TE captures sharper foil edges accurately.
      const t = c / GRID_U;
      const u = 0.5 * (1 - Math.cos(Math.PI * t)) * 0.35 + t * 0.65;
      const idx = r * cols + c;
      const pt = sb.point(s, u);
      const [out, ins] = sb.offsets(s, u);
      const hCm = Math.max(minH, out - ins);

      coordsCm[idx * 2] = pt.x;
      coordsCm[idx * 2 + 1] = pt.y;
      coordsM[idx * 2] = pt.x * CM_TO_M;
      coordsM[idx * 2 + 1] = pt.y * CM_TO_M;
      thicknessCm[idx] = hCm;
      thicknessM[idx] = hCm * CM_TO_M;
      sValues[idx] = s;
      uValues[idx] = u;

      // Clamp nodes resting on the tab top (y ≈ 0) within any tab part footprint.
      if (r === 0 && pt.y <= 0.08 && inTab(pt.x)) {
        clamped[idx] = 1;
        clampedCount++;
      }
    }
  }

  // Fallback if an unusual outline has < 2 nodes overlapping the tab: clamp the base row on y ≈ 0.
  if (clampedCount < 2) {
    for (let c = 0; c < cols; c++) {
      if (coordsCm[c * 2 + 1]! <= 0.08) {
        clamped[c] = 1;
        clampedCount++;
      }
    }
  }
  if (clampedCount < 2) {
    for (let c = 0; c < cols; c++) clamped[c] = 1;
  }

  // Alternate diagonal split across quads to keep triangle orientation bias symmetric.
  const triangles: FlexTriangle[] = [];
  for (let r = 0; r < GRID_S; r++) {
    for (let c = 0; c < GRID_U; c++) {
      const a = r * cols + c;
      const b = r * cols + c + 1;
      const cc = (r + 1) * cols + c + 1;
      const dd = (r + 1) * cols + c;
      if ((r + c) % 2 === 0) {
        triangles.push([a, b, cc], [a, cc, dd]);
      } else {
        triangles.push([a, b, dd], [b, cc, dd]);
      }
    }
  }

  // Primary structural sweep axis from mid-base to tip (deg CCW from +X).
  const baseMidX = (coordsCm[0]! + coordsCm[(cols - 1) * 2]!) * 0.5;
  const sweepAxisDeg = Math.atan2(readouts.tip.y, readouts.tip.x - baseMidX) * RAD_TO_DEG;

  const baseToe = twistAt(d, 0).toe;
  const builtInToeAt = (heightFraction: number): number =>
    twistAt(d, Math.min(1, Math.max(0, heightFraction))).toe - baseToe;

  return {
    plate: { coordsM, thicknessM, triangles, clamped },
    rows,
    cols,
    sValues,
    uValues,
    coordsCm,
    thicknessCm,
    depthCm: readouts.depth,
    sweepAxisDeg,
    builtInToeAt,
  };
};

// ---------------------------------------------------------------------------
// Load vectors: bench stiffness rig + realistic hydrodynamic turn pressure
// ---------------------------------------------------------------------------

/**
 * Bench test point load (100 N) applied at 75% depth along the blade's mid-chord/spine,
 * smoothly distributed across the nearest few nodes (radius ~8 mm) to avoid point-load
 * singularity while matching a mechanical load nose.
 */
const buildBenchLoad = (
  mesh: FinPlateMesh,
): { rhs: Float64Array; weights: Float64Array; totalForceN: number } => {
  const nNodes = mesh.thicknessCm.length;
  const rhs = new Float64Array(nNodes * 3);
  const weights = new Float64Array(nNodes);
  const totalForceN = 100;

  // Target point: row nearest s = 0.75, chord fraction nearest u = 0.38 (thickest path).
  const targetRow = Math.round(0.75 * GRID_S);
  let targetCol = Math.round(0.38 * GRID_U);
  let bestUDiff = Infinity;
  for (let c = 0; c < mesh.cols; c++) {
    const du = Math.abs(mesh.uValues[targetRow * mesh.cols + c]! - 0.38);
    if (du < bestUDiff) {
      bestUDiff = du;
      targetCol = c;
    }
  }
  const tIdx = targetRow * mesh.cols + targetCol;
  const tx = mesh.coordsCm[tIdx * 2]!;
  const tz = mesh.coordsCm[tIdx * 2 + 1]!;
  const sigmaCm = 0.8;

  let wSum = 0;
  for (let i = 0; i < nNodes; i++) {
    if (mesh.plate.clamped[i] === 1) continue;
    const dx = mesh.coordsCm[i * 2]! - tx;
    const dz = mesh.coordsCm[i * 2 + 1]! - tz;
    const d2 = dx * dx + dz * dz;
    if (d2 > 4 * sigmaCm * sigmaCm) continue;
    const w = Math.exp(-d2 / (2 * sigmaCm * sigmaCm));
    weights[i] = w;
    wSum += w;
  }
  if (wSum <= 0) {
    weights[tIdx] = 1;
    wSum = 1;
  }
  for (let i = 0; i < nNodes; i++) {
    weights[i] = weights[i]! / wSum;
    rhs[i * 3] = weights[i]! * totalForceN;
  }
  return { rhs, weights, totalForceN };
};

/** Reference turning angle of attack (deg) used to couple built-in tip toe into spanwise lift. */
const ALPHA_REF_DEG = 8;

/**
 * Hydrodynamic turning pressure distribution:
 * - Chordwise: thin-airfoil lift density peaking near the quarter-chord (`u ≈ 0.25`).
 * - Spanwise: elliptic lift distribution tapering toward the tip (`s → 1`), modulated by
 *   any built-in tip toe change from cant lines (`(α_ref + Δtoe(z)) / α_ref`).
 * Normalized so the integrated lateral force across the blade equals `loadN` exactly.
 */
const buildHydroLoad = (mesh: FinPlateMesh, loadN: number): Float64Array => {
  const nNodes = mesh.thicknessCm.length;
  const rhs = new Float64Array(nNodes * 3);
  const { coordsM, triangles } = mesh.plate;

  let total = 0;
  for (const [i0, i1, i2] of triangles) {
    const x1 = coordsM[i0 * 2]!;
    const z1 = coordsM[i0 * 2 + 1]!;
    const x2 = coordsM[i1 * 2]!;
    const z2 = coordsM[i1 * 2 + 1]!;
    const x3 = coordsM[i2 * 2]!;
    const z3 = coordsM[i2 * 2 + 1]!;
    const area = Math.abs((x2 - x1) * (z3 - z1) - (x3 - x1) * (z2 - z1)) * 0.5;
    if (area < 1e-12) continue;

    const sAvg = (mesh.sValues[i0]! + mesh.sValues[i1]! + mesh.sValues[i2]!) / 3;
    const uAvg = (mesh.uValues[i0]! + mesh.uValues[i1]! + mesh.uValues[i2]!) / 3;
    const zAvgCm =
      (mesh.coordsCm[i0 * 2 + 1]! + mesh.coordsCm[i1 * 2 + 1]! + mesh.coordsCm[i2 * 2 + 1]!) / 3;
    const hf = mesh.depthCm > 0 ? Math.min(1, Math.max(0, zAvgCm / mesh.depthCm)) : sAvg;
    const toeFactor = Math.max(0.5, ALPHA_REF_DEG + mesh.builtInToeAt(hf)) / ALPHA_REF_DEG;
    // Quarter-chord weighted airfoil pressure (CP ≈ 0.25–0.28) × elliptic span lift × toe AoA.
    const chordWeight = Math.sqrt(Math.max(0, 1 - uAvg) / (uAvg + 0.05));
    const spanWeight = Math.sqrt(Math.max(0.04, 1 - 0.9 * sAvg * sAvg)) * toeFactor;
    const fTri = area * chordWeight * spanWeight;
    total += fTri;
    const fNode = fTri / 3;
    rhs[i0 * 3] = rhs[i0 * 3]! + fNode;
    rhs[i1 * 3] = rhs[i1 * 3]! + fNode;
    rhs[i2 * 3] = rhs[i2 * 3]! + fNode;
  }

  if (total > 0) {
    const scale = loadN / total;
    for (let i = 0; i < nNodes; i++) {
      rhs[i * 3] = rhs[i * 3]! * scale;
    }
  }
  return rhs;
};

// ---------------------------------------------------------------------------
// Public analysis API
// ---------------------------------------------------------------------------

/**
 * Analyze a fin design's bending stiffness, tip deflection, chordwise twist, flex hinge,
 * and surface stress for a given material, G10 weave angle, and hydrodynamic turn load.
 */
export const analyzeFinFlex = (
  design: FinDesign,
  options: {
    readonly material?: FinFlexMaterial;
    readonly weaveAngleDeg?: number;
    readonly loadN?: number;
  } = {},
): FinFlexAnalysis => {
  const material = options.material ?? G10_MATERIAL;
  const weaveAngleDeg = options.weaveAngleDeg ?? design.weaveAngle ?? 0;
  const loadN = Math.max(1, options.loadN ?? DEFAULT_FLEX_LOAD_N);

  const mesh = buildFinPlateMesh(design);
  return analyzePreparedMesh(mesh, material, weaveAngleDeg, loadN);
};

const analyzePreparedMesh = (
  mesh: FinPlateMesh,
  material: FinFlexMaterial,
  weaveAngleDeg: number,
  loadN: number,
): FinFlexAnalysis => {
  const solver = buildPlateSolver(mesh.plate, material, weaveAngleDeg);
  const { coordsM, thicknessM, triangles, clamped } = mesh.plate;
  const nNodes = thicknessM.length;

  // 1. Bench stiffness (N/mm): load-weighted deflection under the 100 N bench pad.
  const bench = buildBenchLoad(mesh);
  const uBench = solver.solve(bench.rhs);
  let benchDeflM = 0;
  for (let i = 0; i < nNodes; i++) {
    benchDeflM += bench.weights[i]! * uBench[i * 3]!;
  }
  const benchDeflMm = Math.max(1e-6, Math.abs(benchDeflM) * 1000);
  const stiffnessNPerMm = bench.totalForceN / benchDeflMm;

  // 2. Hydrodynamic turn load response.
  const hydroRhs = buildHydroLoad(mesh, loadN);
  const uHydro = solver.solve(hydroRhs);

  // Compute element curvatures and surface bending stress (at z_plate = ±h/2).
  const nodeStrainSum = new Float64Array(nNodes);
  const nodeWeightSum = new Float64Array(nNodes);
  let peakStressPa = 0;
  const qb = solver.qb;

  for (const [i0, i1, i2] of triangles) {
    const x1 = coordsM[i0 * 2]!;
    const z1 = coordsM[i0 * 2 + 1]!;
    const x2 = coordsM[i1 * 2]!;
    const z2 = coordsM[i1 * 2 + 1]!;
    const x3 = coordsM[i2 * 2]!;
    const z3 = coordsM[i2 * 2 + 1]!;
    const res = dktCurvatureMatrix(x1, z1, x2, z2, x3, z3, 1 / 3, 1 / 3, 1 / 3);
    if (!res) continue;
    const { area, B } = res;

    const q = [
      uHydro[i0 * 3]!,
      uHydro[i0 * 3 + 1]!,
      uHydro[i0 * 3 + 2]!,
      uHydro[i1 * 3]!,
      uHydro[i1 * 3 + 1]!,
      uHydro[i1 * 3 + 2]!,
      uHydro[i2 * 3]!,
      uHydro[i2 * 3 + 1]!,
      uHydro[i2 * 3 + 2]!,
    ];

    let kxx = 0;
    let kzz = 0;
    let kxz = 0;
    for (let j = 0; j < 9; j++) {
      kxx += B[j]! * q[j]!;
      kzz += B[9 + j]! * q[j]!;
      kxz += B[18 + j]! * q[j]!;
    }
    const hAvg = (thicknessM[i0]! + thicknessM[i1]! + thicknessM[i2]!) / 3;
    // Outer-surface engineering strain ε = (h/2) * κ
    const halfH = 0.5 * hAvg;
    const exx = halfH * kxx;
    const ezz = halfH * kzz;
    const gxz = halfH * kxz;
    const sxx = qb[0] * exx + qb[1] * ezz + qb[2] * gxz;
    const szz = qb[1] * exx + qb[3] * ezz + qb[4] * gxz;
    const txz = qb[2] * exx + qb[4] * ezz + qb[5] * gxz;
    const vm = Math.sqrt(Math.max(0, sxx * sxx - sxx * szz + szz * szz + 3 * txz * txz));
    if (vm > peakStressPa) peakStressPa = vm;

    const curvMag = Math.hypot(kxx, kzz, 0.5 * kxz);
    for (const ni of [i0, i1, i2]) {
      nodeStrainSum[ni] = nodeStrainSum[ni]! + curvMag * area;
      nodeWeightSum[ni] = nodeWeightSum[ni]! + area;
    }
  }

  let maxCurv = 0;
  const nodeCurv = new Float64Array(nNodes);
  for (let i = 0; i < nNodes; i++) {
    const c = nodeWeightSum[i]! > 0 ? nodeStrainSum[i]! / nodeWeightSum[i]! : 0;
    nodeCurv[i] = c;
    if (c > maxCurv) maxCurv = c;
  }

  const nodes: FlexMeshNode[] = [];
  let maxDeflMm = 0;
  for (let i = 0; i < nNodes; i++) {
    const deflMm = uHydro[i * 3]! * 1000;
    if (Math.abs(deflMm) > Math.abs(maxDeflMm)) maxDeflMm = deflMm;
    nodes.push({
      xCm: mesh.coordsCm[i * 2]!,
      zCm: mesh.coordsCm[i * 2 + 1]!,
      thicknessCm: mesh.thicknessCm[i]!,
      deflectionMm: deflMm,
      strainRatio: maxCurv > 0 ? nodeCurv[i]! / maxCurv : 0,
      clamped: clamped[i] === 1,
    });
  }

  // Spanwise summary stations (one per grid row r = 0..GRID_S).
  const stations: FlexSpanStation[] = [];
  let hingeNum = 0;
  let hingeDen = 0;
  for (let r = 0; r < mesh.rows; r++) {
    const firstIdx = r * mesh.cols;
    const midIdx = firstIdx + Math.floor(mesh.cols / 2);

    let sumW = 0;
    let sumCurv = 0;
    let sumZ = 0;
    let sumBetaX = 0;
    for (let c = 0; c < mesh.cols; c++) {
      const idx = firstIdx + c;
      sumW += nodes[idx]!.deflectionMm;
      sumCurv += nodeCurv[idx]!;
      sumZ += nodes[idx]!.zCm;
      // Horizontal waterline slope βx = ∂w/∂x (rad): pure chordwise twist with zero
      // contamination from vertical bending ∂w/∂z on tilted swept grid rows.
      sumBetaX += uHydro[idx * 3 + 1]!;
    }
    const meanDeflMm = sumW / mesh.cols;
    const meanCurv = sumCurv / mesh.cols;
    const heightFraction =
      mesh.depthCm > 0 ? Math.min(1, Math.max(0, sumZ / mesh.cols / mesh.depthCm)) : r / GRID_S;

    // Negative elasticTwistDeg = ∂w/∂x < 0 → TE deflects more than LE at constant z → wash-out.
    const elasticTwistDeg = Math.atan(sumBetaX / mesh.cols) * RAD_TO_DEG;
    const builtInTwistDeg = mesh.builtInToeAt(heightFraction);
    const twistDeg = builtInTwistDeg + elasticTwistDeg;

    if (r > 0 && r < mesh.rows - 1) {
      hingeNum += heightFraction * meanCurv;
      hingeDen += meanCurv;
    }

    stations.push({
      heightFraction,
      deflectionMm: meanDeflMm,
      twistDeg,
      elasticTwistDeg,
      builtInTwistDeg,
      curvaturePerM: meanCurv,
      xCm: nodes[midIdx]!.xCm,
      zCm: nodes[midIdx]!.zCm,
    });
  }

  // Representative tip twist at ~80% span (where chord is still well-defined).
  const twistRow = Math.min(stations.length - 2, Math.max(1, Math.round(0.8 * GRID_S)));
  const tipStation = stations[twistRow];
  const tipTwistDeg = tipStation?.twistDeg ?? 0;
  const elasticTipTwistDeg = tipStation?.elasticTwistDeg ?? 0;
  const builtInTipTwistDeg = tipStation?.builtInTwistDeg ?? 0;
  const flexPointFraction = hingeDen > 0 ? hingeNum / hingeDen : 0.45;
  const peakStressMPa = peakStressPa / 1e6;
  const safetyFactor = peakStressMPa > 1e-6 ? material.strengthMPa / peakStressMPa : 999;

  return {
    material,
    weaveAngleDeg,
    loadN,
    stiffnessNPerMm,
    band: classifyStiffness(stiffnessNPerMm),
    tipDeflectionMm: maxDeflMm,
    tipTwistDeg,
    elasticTipTwistDeg,
    builtInTipTwistDeg,
    depthCm: mesh.depthCm,
    flexPointFraction,
    peakStressMPa,
    safetyFactor,
    sweepAxisDeg: mesh.sweepAxisDeg,
    sweepModulusGPa: directionalFlexuralModulus(material, weaveAngleDeg, mesh.sweepAxisDeg),
    stations,
    nodes,
    triangles,
    gridRows: mesh.rows,
    gridCols: mesh.cols,
  };
};

// ---------------------------------------------------------------------------
// Mode 1: Recommend weave angle for a target stiffness (keep geometry fixed)
// ---------------------------------------------------------------------------

/**
 * Sweep G10 weave orientations from −85° to +90° (5° steps, then 1° local refinement)
 * to recommend the weave angle that best matches `targetNPerMm` on the current fin.
 *
 * When two angles achieve near-identical stiffness (symmetric bias angles), prefers the
 * one with gentler wash-out twist (`tipTwistDeg <= 0`, smooth pressure shedding).
 */
export const recommendWeaveAngle = (
  design: FinDesign,
  targetNPerMm: number,
  options: { readonly material?: FinFlexMaterial; readonly loadN?: number } = {},
): WeaveRecommendation => {
  const material = options.material ?? G10_MATERIAL;
  const loadN = options.loadN ?? DEFAULT_FLEX_LOAD_N;
  const mesh = buildFinPlateMesh(design);

  const sweep: WeaveSweepPoint[] = [];
  let minK = Infinity;
  let maxK = -Infinity;
  for (let angleDeg = -85; angleDeg <= 90; angleDeg += 5) {
    const a = analyzePreparedMesh(mesh, material, angleDeg, loadN);
    sweep.push({ angleDeg, stiffnessNPerMm: a.stiffnessNPerMm, tipTwistDeg: a.tipTwistDeg });
    if (a.stiffnessNPerMm < minK) minK = a.stiffnessNPerMm;
    if (a.stiffnessNPerMm > maxK) maxK = a.stiffnessNPerMm;
  }

  // Score candidates: primary objective is closeness to target stiffness; tie-breaker
  // gently prefers wash-out twist (negative tipTwistDeg) over wash-in.
  const score = (pt: WeaveSweepPoint): number => {
    const err = Math.abs(pt.stiffnessNPerMm - targetNPerMm);
    const washInPenalty = pt.tipTwistDeg > 0 ? 0.08 * pt.tipTwistDeg : 0;
    return err + washInPenalty;
  };

  let best = sweep[0]!;
  for (const pt of sweep) {
    if (score(pt) < score(best)) best = pt;
  }

  // Local 1° refinement around the winning 5° bucket.
  let refined = best;
  for (let d = -4; d <= 4; d++) {
    const ang = best.angleDeg + d;
    if (ang < -90 || ang > 90) continue;
    const a = analyzePreparedMesh(mesh, material, ang, loadN);
    const cand: WeaveSweepPoint = {
      angleDeg: ang,
      stiffnessNPerMm: a.stiffnessNPerMm,
      tipTwistDeg: a.tipTwistDeg,
    };
    if (cand.stiffnessNPerMm < minK) minK = cand.stiffnessNPerMm;
    if (cand.stiffnessNPerMm > maxK) maxK = cand.stiffnessNPerMm;
    if (score(cand) < score(refined)) refined = cand;
  }

  const withinRange = targetNPerMm >= minK - 0.15 && targetNPerMm <= maxK + 0.15;
  const twistWord = refined.tipTwistDeg <= 0 ? 'wash-out' : 'wash-in';
  const note = withinRange
    ? `${refined.angleDeg}° weave hits ${refined.stiffnessNPerMm.toFixed(1)} N/mm with ${Math.abs(refined.tipTwistDeg).toFixed(1)}° ${twistWord}.`
    : targetNPerMm < minK
      ? `Weave angle alone spans ${minK.toFixed(1)}–${maxK.toFixed(1)} N/mm. ${refined.angleDeg}° is the softest orientation; thin the taper to reach ${targetNPerMm.toFixed(1)} N/mm.`
      : `Weave angle alone spans ${minK.toFixed(1)}–${maxK.toFixed(1)} N/mm. ${refined.angleDeg}° is the stiffest orientation; thicken the taper to reach ${targetNPerMm.toFixed(1)} N/mm.`;

  return {
    targetNPerMm,
    recommendedAngleDeg: refined.angleDeg,
    achievedNPerMm: refined.stiffnessNPerMm,
    tipTwistDeg: refined.tipTwistDeg,
    achievableMinNPerMm: minK,
    achievableMaxNPerMm: maxK,
    withinRange,
    sweep,
    note,
  };
};

// ---------------------------------------------------------------------------
// Mode 2: Lock weave angle & tune thickness/taper to hit target stiffness
// ---------------------------------------------------------------------------

/** Scale taper knots according to `strategy` and `factor`, respecting `minThickness`. */
const scaleTaperForFlex = (
  d: FinDesign,
  factor: number,
  strategy: FlexDesignAdjustStrategy,
): FinDesign => {
  const minH = finMinThickness(d);
  // Smooth weight along depth `x ∈ [0, 1]`: 1 everywhere for uniform, 0 at root → 1 at tip for tip-taper.
  const weight = (x: number): number => {
    if (strategy === 'uniform-thickness') return 1;
    const t = Math.min(1, Math.max(0, x));
    return t * t * (3 - 2 * t);
  };
  const scaleY = (p: Vec2): Vec2 => {
    const w = weight(p.x);
    const eff = 1 + (factor - 1) * w;
    return vec2(p.x, Math.max(minH, p.y * eff));
  };
  const taper: Spline = splineFromKnots(
    d.taper.knots.map((k, idx) => {
      // Pin the root end exactly for tip-taper so root thickness never drifts.
      if (strategy === 'tip-taper' && idx === 0) {
        return knot(k.end, k.tangentToPrev, scaleY(k.tangentToNext), k.continuous, k.other, k.lock);
      }
      return knot(
        scaleY(k.end),
        scaleY(k.tangentToPrev),
        scaleY(k.tangentToNext),
        k.continuous,
        k.other,
        k.lock,
      );
    }),
  );
  return { ...d, taper };
};

/**
 * Keep `weaveAngleDeg` fixed and adjust the fin's thickness taper (either uniformly or
 * tip-only while preserving root thickness) to reach `targetNPerMm`.
 *
 * Uses monotonic 1D bisection (since `k ∝ h³`) while enforcing `validateFinDesign` and
 * practical thickness bounds (0.4× to 2.2× current taper).
 */
export const tuneDesignForStiffness = (
  design: FinDesign,
  targetNPerMm: number,
  weaveAngleDeg: number,
  options: {
    readonly strategy?: FlexDesignAdjustStrategy;
    readonly material?: FinFlexMaterial;
    readonly loadN?: number;
  } = {},
): FlexDesignAdjustment => {
  const strategy = options.strategy ?? 'uniform-thickness';
  const material = options.material ?? G10_MATERIAL;
  const loadN = options.loadN ?? DEFAULT_FLEX_LOAD_N;
  const baseWithWeave: FinDesign = { ...design, weaveAngle: weaveAngleDeg };
  const hadIssues = new Set(validateFinDesign(baseWithWeave).map((i) => i.code));
  const isValid = (cand: FinDesign): boolean =>
    validateFinDesign(cand).every((i) => hadIssues.has(i.code));

  const rootBefore = design.taper.knots[0]!.end.y;
  const tipBefore = design.taper.knots[design.taper.knots.length - 1]!.end.y;

  const evalFactor = (f: number): { cand: FinDesign; k: number } => {
    const cand = scaleTaperForFlex(baseWithWeave, f, strategy);
    const k = analyzeFinFlex(cand, { material, weaveAngleDeg, loadN }).stiffnessNPerMm;
    return { cand, k };
  };

  const lo = 0.4;
  let hi = 2.2;
  // Respect panel thickness cap if the user already set a G10 panel thickness.
  if (design.panel && rootBefore > 0 && strategy === 'uniform-thickness') {
    const panelMaxFactor = Math.max(0.5, (design.panel.thickness * 0.96) / rootBefore);
    hi = Math.min(hi, panelMaxFactor);
  }

  const lowRes = evalFactor(lo);
  const highRes = evalFactor(hi);
  let chosen = evalFactor(1);
  let clamped = false;

  if (targetNPerMm <= lowRes.k) {
    chosen = lowRes;
    clamped = true;
  } else if (targetNPerMm >= highRes.k) {
    chosen = highRes;
    clamped = true;
  } else {
    let a = lo;
    let b = hi;
    for (let iter = 0; iter < 11; iter++) {
      const mid = (a + b) * 0.5;
      const res = evalFactor(mid);
      if (isValid(res.cand)) {
        chosen = res;
      }
      if (res.k < targetNPerMm) a = mid;
      else b = mid;
    }
  }

  const finalDesign = isValid(chosen.cand) ? chosen.cand : baseWithWeave;
  const finalK = isValid(chosen.cand)
    ? chosen.k
    : analyzeFinFlex(baseWithWeave, { material, weaveAngleDeg, loadN }).stiffnessNPerMm;
  const rootAfter = finalDesign.taper.knots[0]!.end.y;
  const tipAfter = finalDesign.taper.knots[finalDesign.taper.knots.length - 1]!.end.y;

  const note = clamped
    ? `Hit practical thickness limit at ${finalK.toFixed(1)} N/mm (target ${targetNPerMm.toFixed(1)} N/mm).`
    : strategy === 'tip-taper'
      ? `Kept root at ${(rootAfter * 10).toFixed(1)} mm and tuned tip taper (${(tipBefore * 10).toFixed(1)} → ${(tipAfter * 10).toFixed(1)} mm) to hit ${finalK.toFixed(1)} N/mm at ${weaveAngleDeg}° weave.`
      : `Scaled taper thickness (${(rootBefore * 10).toFixed(1)} → ${(rootAfter * 10).toFixed(1)} mm root) to hit ${finalK.toFixed(1)} N/mm at ${weaveAngleDeg}° weave.`;

  return {
    design: finalDesign,
    strategy,
    weaveAngleDeg,
    targetNPerMm,
    achievedNPerMm: finalK,
    rootThicknessBeforeCm: rootBefore,
    rootThicknessAfterCm: rootAfter,
    tipThicknessBeforeCm: tipBefore,
    tipThicknessAfterCm: tipAfter,
    clamped,
    note,
  };
};
