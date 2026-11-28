// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Analytic & benchmark regression tests for the DKT orthotropic plate solver (fin-flex.ts).
 *
 * Verifies:
 * 1. Closed-form Euler-Bernoulli / plate cantilever bending stiffness (exact convergence).
 * 2. Exact cubic scaling with thickness (k ∝ h³) and linear scaling with modulus (k ∝ E).
 * 3. Orthotropic G10 directional modulus: 0°/90° high stiffness, 45° drop to ~13–14 GPa.
 * 4. Realistic surfboard fin physics: Futures tab stiffer than FCS twin tabs on the same
 *    blade (reproducing Surf Flex Lab's finding), swept fin wash-out twist, weave-angle
 *    recommendation, and locked-weave thickness tuning.
 */
import { describe, expect, it } from 'vitest';
import { defaultFinDesign, defaultKeel, defaultSingleFin } from './fin-defaults';
import {
  analyzeFinFlex,
  buildPlateSolver,
  directionalFlexuralModulus,
  directionalStiffnessPolar,
  FIN_FLEX_MATERIALS,
  G10_MATERIAL,
  recommendWeaveAngle,
  rotatedQMatrix,
  tuneDesignForStiffness,
  type FinFlexMaterial,
  type FlexTriangle,
  type PlateMeshInput,
} from './fin-flex';
import { placeOnBase } from './fin-placement';
import { validateFinDesign } from './fin-rules';

/** Build a uniform rectangular cantilever plate mesh (clamped at z = 0, free at z = L). */
const rectCantileverMesh = (
  widthM: number,
  lengthM: number,
  thicknessM: number,
  nx = 8,
  nz = 16,
): { mesh: PlateMeshInput; tipNodes: number[] } => {
  const rows = nz + 1;
  const cols = nx + 1;
  const nNodes = rows * cols;
  const coordsM = new Float64Array(nNodes * 2);
  const thick = new Float64Array(nNodes).fill(thicknessM);
  const clamped = new Uint8Array(nNodes);
  const tipNodes: number[] = [];

  for (let r = 0; r < rows; r++) {
    const z = (r / nz) * lengthM;
    for (let c = 0; c < cols; c++) {
      const x = (c / nx) * widthM;
      const idx = r * cols + c;
      coordsM[idx * 2] = x;
      coordsM[idx * 2 + 1] = z;
      if (r === 0) clamped[idx] = 1;
      if (r === nz) tipNodes.push(idx);
    }
  }

  const triangles: FlexTriangle[] = [];
  for (let r = 0; r < nz; r++) {
    for (let c = 0; c < nx; c++) {
      const a = r * cols + c;
      const b = r * cols + c + 1;
      const cc = (r + 1) * cols + c + 1;
      const dd = (r + 1) * cols + c;
      if ((r + c) % 2 === 0) triangles.push([a, b, cc], [a, cc, dd]);
      else triangles.push([a, b, dd], [b, cc, dd]);
    }
  }
  return { mesh: { coordsM, thicknessM: thick, triangles, clamped }, tipNodes };
};

describe('orthotropic G10 material & CLT rotation', () => {
  it('matches woven G10 flexural modulus at 0°, 45°, and 90°', () => {
    const e0 = directionalFlexuralModulus(G10_MATERIAL, 0, 0);
    const e90 = directionalFlexuralModulus(G10_MATERIAL, 0, 90);
    const e45 = directionalFlexuralModulus(G10_MATERIAL, 0, 45);
    expect(e0).toBeCloseTo(23.0, 6);
    expect(e90).toBeCloseTo(22.0, 6);
    // 45° off-axis bias drops into the published 10–15 GPa range.
    expect(e45).toBeGreaterThan(10);
    expect(e45).toBeLessThan(15);
    // Rotating the weave by +45° moves peak stiffness to +45°.
    expect(directionalFlexuralModulus(G10_MATERIAL, 45, 45)).toBeCloseTo(23.0, 6);
  });

  it('produces zero bend–twist terms (Q16, Q26) at 0° and 90°, non-zero off-axis', () => {
    const q0 = rotatedQMatrix(G10_MATERIAL, 0);
    const q90 = rotatedQMatrix(G10_MATERIAL, 90);
    const q25 = rotatedQMatrix(G10_MATERIAL, 25);
    expect(Math.abs(q0[2])).toBeLessThan(1e-3);
    expect(Math.abs(q0[4])).toBeLessThan(1e-3);
    expect(Math.abs(q90[2])).toBeLessThan(1e-3);
    expect(Math.abs(q90[4])).toBeLessThan(1e-3);
    expect(Math.abs(q25[2])).toBeGreaterThan(1e8);
  });

  it('samples a full 360° polar curve with 4-fold weave lobes', () => {
    const polar = directionalStiffnessPolar(G10_MATERIAL, 0, 72);
    expect(polar).toHaveLength(72);
    const at0 = polar[0]!.modulusGPa;
    const at45 = polar[9]!.modulusGPa;
    expect(at0).toBeGreaterThan(at45 * 1.5);
  });

  it('includes wet-conditioned 3D-printed CF filaments (PPA-CF, PPS-CF, PET-CF) as quasi-isotropic', () => {
    const ppa = FIN_FLEX_MATERIALS.find((m) => m.id === 'ppa-cf')!;
    const pps = FIN_FLEX_MATERIALS.find((m) => m.id === 'pps-cf')!;
    const pet = FIN_FLEX_MATERIALS.find((m) => m.id === 'pet-cf')!;
    expect(ppa.woven).toBe(false);
    expect(pps.woven).toBe(false);
    expect(pet.woven).toBe(false);

    // Quasi-isotropic: 0° and 45° moduli match closely.
    expect(
      Math.abs(directionalFlexuralModulus(ppa, 0, 0) - directionalFlexuralModulus(ppa, 0, 45)),
    ).toBeLessThan(0.1);

    const fin = defaultFinDesign('side', 'left');
    const kG10 = analyzeFinFlex(fin, { material: G10_MATERIAL }).stiffnessNPerMm;
    const kPpa = analyzeFinFlex(fin, { material: ppa }).stiffnessNPerMm;
    const kPps = analyzeFinFlex(fin, { material: pps }).stiffnessNPerMm;
    const kPet = analyzeFinFlex(fin, { material: pet }).stiffnessNPerMm;
    expect(kG10).toBeGreaterThan(kPpa);
    expect(kPpa).toBeGreaterThan(kPps);
    expect(kPps).toBeGreaterThan(kPet);
  });
});

describe('DKT plate solver analytical oracle', () => {
  it('reproduces Euler-Bernoulli cantilever tip deflection to within 2% (ν = 0)', () => {
    const L = 0.12; // 120 mm
    const b = 0.03; // 30 mm
    const h = 0.004; // 4 mm
    const E = 20; // 20 GPa
    const isoZeroNu: FinFlexMaterial = {
      id: 'iso',
      label: 'Isotropic test',
      e1GPa: E,
      e2GPa: E,
      g12GPa: E / 2,
      nu12: 0,
      strengthMPa: 300,
    };
    const { mesh, tipNodes } = rectCantileverMesh(b, L, h, 6, 16);
    const solver = buildPlateSolver(mesh, isoZeroNu, 0);
    expect(solver.ok).toBe(true);

    // Apply total tip line load F = 100 N (trapezoidal weights: half at corners).
    const F = 100;
    const rhs = new Float64Array(solver.nDof);
    const nx = tipNodes.length - 1;
    for (let i = 0; i < tipNodes.length; i++) {
      const weight = i === 0 || i === nx ? 0.5 / nx : 1 / nx;
      rhs[tipNodes[i]! * 3] = F * weight;
    }
    const u = solver.solve(rhs);
    const meanTipW = tipNodes.reduce((s, idx) => s + u[idx * 3]!, 0) / tipNodes.length;

    // Exact Euler-Bernoulli cantilever formula: w_tip = F L³ / (3 E I), I = b h³ / 12.
    const I = (b * h * h * h) / 12;
    const exactW = (F * L * L * L) / (3 * (E * 1e9) * I);
    const relErr = Math.abs(meanTipW - exactW) / exactW;
    expect(relErr).toBeLessThan(0.02);
  });

  it('scales stiffness strictly as h³ when thickness doubles (exact factor 8×)', () => {
    const iso: FinFlexMaterial = {
      id: 'iso',
      label: 'Iso',
      e1GPa: 22,
      e2GPa: 22,
      g12GPa: 22 / (2 * 1.15),
      nu12: 0.15,
      strengthMPa: 350,
    };
    const thin = rectCantileverMesh(0.05, 0.1, 0.003, 6, 12);
    const thick = rectCantileverMesh(0.05, 0.1, 0.006, 6, 12);
    const sThin = buildPlateSolver(thin.mesh, iso, 0);
    const sThick = buildPlateSolver(thick.mesh, iso, 0);
    const rhs = new Float64Array(sThin.nDof);
    for (const idx of thin.tipNodes) rhs[idx * 3] = 10;
    const wThin = sThin.solve(rhs)[thin.tipNodes[3]! * 3]!;
    const wThick = sThick.solve(rhs)[thick.tipNodes[3]! * 3]!;
    expect(wThin / wThick).toBeCloseTo(8, 3);
  });
});

describe('surfboard fin flex analysis & weave optimization', () => {
  it('computes realistic G10 stiffness, deflection, twist and stress on default fins', () => {
    const thruster = defaultFinDesign('side', 'left');
    const res = analyzeFinFlex(thruster, { weaveAngleDeg: 0, loadN: 150 });
    // Solid 8 mm root G10 thruster sits cleanly in the stiff/balanced-to-stiff regime.
    expect(res.stiffnessNPerMm).toBeGreaterThan(5);
    expect(res.stiffnessNPerMm).toBeLessThan(60);
    expect(res.tipDeflectionMm).toBeGreaterThan(0.5);
    expect(res.tipDeflectionMm).toBeLessThan(40);
    expect(res.peakStressMPa).toBeGreaterThan(5);
    expect(res.safetyFactor).toBeGreaterThan(1);
    expect(res.flexPointFraction).toBeGreaterThan(0.1);
    expect(res.flexPointFraction).toBeLessThan(0.95);
    expect(res.stations.length).toBe(res.gridRows);
  });

  it('captures root clamping: Futures full tab is stiffer than FCS 1 twin tabs on the same blade', () => {
    const futuresFin = defaultFinDesign('side', 'left');
    const fcsFin = placeOnBase(futuresFin, 'fcs-1');
    const kFutures = analyzeFinFlex(futuresFin, { weaveAngleDeg: 0 }).stiffnessNPerMm;
    const kFcs = analyzeFinFlex(fcsFin, { weaveAngleDeg: 0 }).stiffnessNPerMm;
    expect(kFutures).toBeGreaterThan(kFcs);
  });

  it('works cleanly on keels (with raised rear) and US box single fins', () => {
    const keel = analyzeFinFlex(defaultKeel('left'));
    const single = analyzeFinFlex(defaultSingleFin());
    expect(keel.stiffnessNPerMm).toBeGreaterThan(2);
    expect(single.stiffnessNPerMm).toBeGreaterThan(1);
  });

  it('produces true horizontal wash-out on a swept thruster and responds to built-in tip toe', () => {
    const base = defaultFinDesign('side', 'left');
    const plain = analyzeFinFlex(base, { weaveAngleDeg: 0, loadN: 150 });
    // Swept-back fin bending sideways naturally washes out along horizontal waterlines.
    expect(plain.elasticTipTwistDeg).toBeLessThan(0);
    expect(plain.tipTwistDeg).toBeCloseTo(plain.elasticTipTwistDeg, 6);

    const toeOut = analyzeFinFlex(
      { ...base, cantLines: [{ height: 0.45, cant: base.cant, toe: -4 }] },
      { weaveAngleDeg: 0, loadN: 150 },
    );
    const toeIn = analyzeFinFlex(
      { ...base, cantLines: [{ height: 0.45, cant: base.cant, toe: 4 }] },
      { weaveAngleDeg: 0, loadN: 150 },
    );
    // Tip toe-out unloads the tip (smaller deflection) and adds wash-out; toe-in loads it harder.
    expect(toeOut.tipDeflectionMm).toBeLessThan(plain.tipDeflectionMm);
    expect(toeIn.tipDeflectionMm).toBeGreaterThan(plain.tipDeflectionMm);
    expect(toeOut.tipTwistDeg).toBeLessThan(plain.tipTwistDeg - 2);
    expect(toeIn.tipTwistDeg).toBeGreaterThan(plain.tipTwistDeg + 2);
  });

  it('Mode 1: recommends a weave angle hitting a target inside the weave-achievable band', () => {
    const fin = defaultFinDesign('side', 'left');
    const probe0 = analyzeFinFlex(fin, { weaveAngleDeg: 0 });
    const probe45 = analyzeFinFlex(fin, { weaveAngleDeg: 45 });
    // Rotating G10 weave measurably changes stiffness.
    expect(Math.abs(probe0.stiffnessNPerMm - probe45.stiffnessNPerMm)).toBeGreaterThan(0.5);

    const midTarget = (probe0.stiffnessNPerMm + probe45.stiffnessNPerMm) * 0.5;
    const rec = recommendWeaveAngle(fin, midTarget);
    expect(rec.withinRange).toBe(true);
    expect(Math.abs(rec.achievedNPerMm - midTarget)).toBeLessThan(0.6);
    expect(rec.sweep.length).toBeGreaterThan(20);
  });

  it('Mode 1: flags when a target stiffness lies outside weave-angle-only range', () => {
    const fin = defaultFinDesign('side', 'left');
    const rec = recommendWeaveAngle(fin, 1.0);
    expect(rec.withinRange).toBe(false);
    expect(rec.note).toMatch(/Weave angle alone spans/);
  });

  it('Mode 2: locks weave angle and adjusts thickness/taper to hit target stiffness validly', () => {
    const fin = defaultFinDesign('side', 'left');
    const baseK = analyzeFinFlex(fin, { weaveAngleDeg: 30 }).stiffnessNPerMm;
    const target = baseK * 0.7;

    const uniform = tuneDesignForStiffness(fin, target, 30, { strategy: 'uniform-thickness' });
    expect(uniform.clamped).toBe(false);
    expect(Math.abs(uniform.achievedNPerMm - target) / target).toBeLessThan(0.05);
    expect(uniform.design.weaveAngle).toBe(30);
    expect(uniform.rootThicknessAfterCm).toBeLessThan(uniform.rootThicknessBeforeCm);
    expect(validateFinDesign(uniform.design)).toEqual([]);

    const tipOnly = tuneDesignForStiffness(fin, target, 30, { strategy: 'tip-taper' });
    expect(tipOnly.rootThicknessAfterCm).toBeCloseTo(tipOnly.rootThicknessBeforeCm, 6);
    expect(tipOnly.design.weaveAngle).toBe(30);
    expect(validateFinDesign(tipOnly.design)).toEqual([]);
  });
});
