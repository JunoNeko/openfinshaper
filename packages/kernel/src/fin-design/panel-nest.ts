// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Multi-fin CNC G10 panel layout: optimal 3D pose per fin + interlocking 2D polygon
 * nesting (docs/design/fin-designer.md).
 *
 * Each fin is first oriented into its thinnest 3D panel pose ({@link bestPanelPose}),
 * giving a right-handed orthonormal frame `(u, v, n)` where `n` runs across the panel's
 * thickness (`+Z` in panel space) and `(u, v)` lie in the panel's plane. Rotating in
 * `(u, v)` by `rotation` degrees and translating by `(x, y)` gives a pure rigid 3D
 * transform ({@link panelPlacementTransform}) that maps the fin into `[0, length] ×
 * [0, width] × [0, thickness]` without distortion or reflection, so STEP and STL exports
 * stay exact and watertight.
 *
 * Interlocking 2D nesting rasterises each fin's actual projected triangle mesh (blade +
 * tab, preserving concave trailing edges, tips and tab pockets) onto a fine grid and
 * maintains a circularly dilated exclusion mask so every pair of placed fins is
 * guaranteed at least `toolWidth` apart in Euclidean distance.
 */
import type { Vert3 } from '../mesh';
import { vec2, type Vec2 } from '../vec2';
import { finOutward, type FinDesign, type FinHand } from './fin-design';
import { finMesh, tabProfilePoints, type FinMesh } from './fin-mesh';
import { finTabOutline } from './fin-tab';
import { bestPanelPose, panelNormal, panelSpan, panelPoints, type PanelPose } from './panel-fit';

const DEG = Math.PI / 180;

/** G10 panel dimensions (cm). */
export interface PanelDimensions {
  /** Longest side along panel +X (cm). */
  readonly length: number;
  /** Shorter side along panel +Y (cm). */
  readonly width: number;
  /** Panel thickness along panel +Z (cm). */
  readonly thickness: number;
}

export type PanelSetupMode = 'calculate-size' | 'recommend-fill';

/** How side fins are paired in `recommend-fill` mode. */
export type PanelPairingMode = 'pairs-only' | 'pairs-plus-odd';

/** One candidate fin design supplied to the panel planner. */
export interface PanelFinInput {
  readonly id: string;
  readonly name: string;
  readonly design: FinDesign;
  /** Desired number of copies in `calculate-size` mode (default 1). */
  readonly count?: number;
}

/** A pure rigid 3D transform (`p' = R·p + translate`, `det(R) = +1`). */
export interface PanelRigidTransform {
  /** Rows of the 3×3 rotation matrix R: panel +X, +Y, +Z expressed in fin coordinates. */
  readonly rows: readonly [Vert3, Vert3, Vert3];
  /** Translation added after rotation (cm, panel coordinates). */
  readonly translate: Vert3;
}

/** One placed fin on the panel, in panel coordinates (cm, deg). */
export interface PanelPlacement {
  /** Source `PanelFinInput.id`. */
  readonly finId: string;
  readonly name: string;
  readonly design: FinDesign;
  /** Bottom-left corner of the fin's rotated 2D bounding box on the panel (cm). */
  readonly x: number;
  readonly y: number;
  /** In-plane counter-clockwise rotation (deg) about panel +Z. */
  readonly rotation: number;
  /** Optimal 3D panel pose (deg) minimising required panel thickness. */
  readonly pose: PanelPose;
  /** Minimum panel thickness required by this fin in its optimal pose (cm). */
  readonly requiredThickness: number;
  /** Minimum and maximum projection along `panelNormal` in fin space (cm). */
  readonly spanLo: number;
  readonly spanHi: number;
  /** Fin's 2D bounding width and height after `rotation` (cm). */
  readonly boxW: number;
  readonly boxH: number;
  /** Projected 2D silhouettes in panel coordinates (cm), for visualisation. */
  readonly outline: readonly Vec2[];
  readonly tabOutlines: readonly (readonly Vec2[])[];
}

export type PanelWarningCode = 'too-thick' | 'too-large' | 'unplaced';

export interface PanelWarning {
  readonly code: PanelWarningCode;
  readonly finId: string;
  readonly finName: string;
  readonly message: string;
  /** Required thickness (cm), present on `too-thick` warnings. */
  readonly requiredThickness?: number;
  /** Panel thickness (cm), present on `too-thick` warnings. */
  readonly panelThickness?: number;
}

export interface PanelLayoutResult {
  readonly mode: PanelSetupMode;
  /** Pairing rule used in `recommend-fill` mode (`'pairs-only'` or `'pairs-plus-odd'`). */
  readonly pairing?: PanelPairingMode;
  readonly panel: PanelDimensions;
  readonly toolWidth: number;
  readonly placements: readonly PanelPlacement[];
  readonly warnings: readonly PanelWarning[];
  /** Fraction of panel area (`length × width`) covered by placed fins, 0 to 1. */
  readonly utilisation: number;
  /** Greatest `requiredThickness` among placed fins (cm), 0 if none placed. */
  readonly maxRequiredThickness: number;
}

export interface CalculatePanelSizeOptions {
  /** 2D CNC tool cut width / inter-fin clearance (cm). */
  readonly toolWidth: number;
  /** Optional target panel thickness (cm) to check fins against for warnings. */
  readonly panelThickness?: number;
  /** Minimum blade thickness used when measuring fins (cm). Default 0.05. */
  readonly minThickness?: number;
}

export interface RecommendPanelFinsOptions {
  readonly panel: PanelDimensions;
  /** 2D CNC tool cut width / inter-fin clearance (cm). */
  readonly toolWidth: number;
  /**
   * Side-fin pairing rule:
   * - `'pairs-only'` (default): only place matched L+R pairs for side fins (and single centre fins).
   * - `'pairs-plus-odd'`: place complete pairs first, then fill leftover space with individual fins.
   */
  readonly pairing?: PanelPairingMode;
  /** Minimum blade thickness used when measuring fins (cm). Default 0.05. */
  readonly minThickness?: number;
  /** Maximum number of fins to place on one panel. Default 120. */
  readonly maxFins?: number;
}

const dot3 = (a: Vert3, b: Vert3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross3 = (a: Vert3, b: Vert3): Vert3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

/**
 * Right-handed orthonormal basis `(u, v, n)` for a fin in `pose`, where `n` is
 * {@link panelNormal} (panel +Z, across thickness) and `u, v` lie in the panel plane.
 */
export const panelBasis = (
  pose: PanelPose,
  outward: 1 | -1 = 1,
): readonly [Vert3, Vert3, Vert3] => {
  const a = pose.angle * DEG;
  const u: Vert3 = { x: Math.cos(a), y: Math.sin(a), z: 0 };
  const n = panelNormal(pose, outward);
  const v = cross3(n, u);
  return [u, v, n];
};

/** Apply a {@link PanelRigidTransform} to a 3D point. */
export const transformPanelPoint = (t: PanelRigidTransform, p: Vert3): Vert3 => ({
  x: dot3(t.rows[0], p) + t.translate.x,
  y: dot3(t.rows[1], p) + t.translate.y,
  z: dot3(t.rows[2], p) + t.translate.z,
});

/** Apply a {@link PanelRigidTransform}'s rotation to a 3D direction vector. */
export const transformPanelDir = (t: PanelRigidTransform, v: Vert3): Vert3 => ({
  x: dot3(t.rows[0], v),
  y: dot3(t.rows[1], v),
  z: dot3(t.rows[2], v),
});

/**
 * Build the exact rigid 3D transform placing `placement.design` at `(placement.x, placement.y)`
 * with in-plane `placement.rotation`, 3D `placement.pose`, and centred vertically inside
 * `[0, panelThickness]`.
 */
export const panelPlacementTransform = (
  placement: Pick<PanelPlacement, 'design' | 'x' | 'y' | 'rotation' | 'pose' | 'spanLo' | 'spanHi'>,
  panelThickness: number,
  minThickness = 0.05,
): PanelRigidTransform => {
  const outward = finOutward(placement.design.hand);
  const [u, v, n] = panelBasis(placement.pose, outward);
  const rad = placement.rotation * DEG;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const rx: Vert3 = {
    x: u.x * c - v.x * s,
    y: u.y * c - v.y * s,
    z: u.z * c - v.z * s,
  };
  const ry: Vert3 = {
    x: u.x * s + v.x * c,
    y: u.y * s + v.y * c,
    z: u.z * s + v.z * c,
  };
  const mesh = finMesh(placement.design, { rows: 24, stations: 24, minThickness });
  let minX = Infinity;
  let minY = Infinity;
  for (const m of [mesh.blade, mesh.tab]) {
    const pos = m.positions;
    for (let i = 0; i < pos.length; i += 3) {
      const p = { x: pos[i]!, y: pos[i + 1]!, z: pos[i + 2]! };
      const px = dot3(rx, p);
      const py = dot3(ry, p);
      if (px < minX) minX = px;
      if (py < minY) minY = py;
    }
  }
  const wMid = (placement.spanLo + placement.spanHi) / 2;
  return {
    rows: [rx, ry, n],
    translate: {
      x: placement.x - minX,
      y: placement.y - minY,
      z: panelThickness / 2 - wMid,
    },
  };
};

// --- Internal prepared fin & 2D raster nesting ---

interface PreparedPanelFin {
  readonly id: string;
  readonly name: string;
  readonly design: FinDesign;
  readonly pose: PanelPose;
  readonly requiredThickness: number;
  readonly spanLo: number;
  readonly spanHi: number;
  readonly mesh: FinMesh;
  readonly uAxis: Vert3;
  readonly vAxis: Vert3;
  /** Projected 2D triangles `(ax, ay, bx, by, cx, cy)` in pose `(u, v)` space. */
  readonly tris2d: Float64Array;
  /** Crisp 2D polylines in pose `(u, v)` space for SVG rendering. */
  readonly bladeOutline: readonly Vec2[];
  readonly tabOutlines: readonly (readonly Vec2[])[];
  /** Approximate 2D projected area (cm²), used for sorting and utilisation. */
  readonly area: number;
  /** Precomputed local raster masks keyed by `${cell}:${rotDeg}`. */
  readonly rasterCache: Map<string, RotatedRaster>;
}

interface RowSpan {
  readonly y: number;
  readonly x0: number;
  readonly x1: number;
}

interface RotatedRaster {
  readonly rotDeg: number;
  readonly gw: number;
  readonly gh: number;
  readonly boxW: number;
  readonly boxH: number;
  readonly minX: number;
  readonly minY: number;
  readonly spans: readonly RowSpan[];
  readonly solidCount: number;
}

const NEST_ANGLES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330] as const;
const NEST_MESH = { rows: 24, stations: 24 } as const;

const project2d = (u: Vert3, v: Vert3, p: Vert3): Vec2 => vec2(dot3(u, p), dot3(v, p));

const sampleOutlineLoop = (design: FinDesign, u: Vert3, v: Vert3): Vec2[] => {
  const pts: Vec2[] = [];
  const curves = design.outline.curves;
  const stepsPerCurve = 16;
  for (const c of curves) {
    for (let i = 0; i < stepsPerCurve; i++) {
      const t = i / stepsPerCurve;
      const mt = 1 - t;
      const x =
        mt * mt * mt * c.p0.x +
        3 * mt * mt * t * c.c1.x +
        3 * mt * t * t * c.c2.x +
        t * t * t * c.p3.x;
      const z =
        mt * mt * mt * c.p0.y +
        3 * mt * mt * t * c.c1.y +
        3 * mt * t * t * c.c2.y +
        t * t * t * c.p3.y;
      pts.push(project2d(u, v, { x, y: 0, z }));
    }
  }
  const last = curves[curves.length - 1]!.p3;
  pts.push(project2d(u, v, { x: last.x, y: 0, z: last.y }));
  return pts;
};

const sampleTabLoops = (design: FinDesign, u: Vert3, v: Vert3): Vec2[][] => {
  const tab = finTabOutline(design.base, design.outline);
  const H = tab.height;
  return tab.parts.map((part) =>
    tabProfilePoints(part.segments, 0.02).map((p) => project2d(u, v, { x: p.x, y: 0, z: p.y - H })),
  );
};

const preparePanelFin = (
  input: Pick<PanelFinInput, 'id' | 'name' | 'design'>,
  minThickness: number,
): PreparedPanelFin => {
  const mesh = finMesh(input.design, { ...NEST_MESH, minThickness });
  const outward = finOutward(input.design.hand);
  const pts = panelPoints(mesh);
  const best = bestPanelPose(pts, outward);
  const pose: PanelPose = { angle: best.angle || 0, tilt: best.tilt || 0 };
  const span = panelSpan(pts, pose, outward);
  const [uAxis, vAxis] = panelBasis(pose, outward);

  const totalTris = (mesh.blade.indices.length + mesh.tab.indices.length) / 3;
  const tris2d = new Float64Array(totalTris * 6);
  let k = 0;
  for (const m of [mesh.blade, mesh.tab]) {
    const pos = m.positions;
    const idx = m.indices;
    for (let i = 0; i < idx.length; i += 3) {
      for (let j = 0; j < 3; j++) {
        const vi = idx[i + j]! * 3;
        const p: Vert3 = { x: pos[vi]!, y: pos[vi + 1]!, z: pos[vi + 2]! };
        tris2d[k++] = dot3(uAxis, p);
        tris2d[k++] = dot3(vAxis, p);
      }
    }
  }

  const bladeOutline = sampleOutlineLoop(input.design, uAxis, vAxis);
  const tabOutlines = sampleTabLoops(input.design, uAxis, vAxis);
  const fin: PreparedPanelFin = {
    id: input.id,
    name: input.name,
    design: input.design,
    pose,
    requiredThickness: span.width,
    spanLo: span.lo,
    spanHi: span.hi,
    mesh,
    uAxis,
    vAxis,
    tris2d,
    bladeOutline,
    tabOutlines,
    area: 0,
    rasterCache: new Map(),
  };
  const r0 = rasterFor(fin, 0, 0.2);
  return { ...fin, area: r0.solidCount * 0.2 * 0.2 };
};

/** Rasterise a prepared fin rotated by `rotDeg` onto a tight local grid of cell size `cell` cm. */
const rasterFor = (fin: PreparedPanelFin, rotDeg: number, cell: number): RotatedRaster => {
  const key = `${cell.toFixed(4)}:${rotDeg}`;
  const hit = fin.rasterCache.get(key);
  if (hit) return hit;

  const rad = rotDeg * DEG;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const src = fin.tris2d;
  const n = src.length;
  const rot = new Float64Array(n);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i += 2) {
    const x = src[i]! * c - src[i + 1]! * s;
    const y = src[i]! * s + src[i + 1]! * c;
    rot[i] = x;
    rot[i + 1] = y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const boxW = Math.max(cell, maxX - minX);
  const boxH = Math.max(cell, maxY - minY);
  const gw = Math.max(1, Math.ceil(boxW / cell));
  const gh = Math.max(1, Math.ceil(boxH / cell));
  const grid = new Uint8Array(gw * gh);

  // Conservative triangle rasterisation: mark any cell whose bbox overlaps the triangle
  // (using edge tests expanded by half a cell so thin edges and tips never vanish).
  const half = cell * 0.5;
  for (let i = 0; i < n; i += 6) {
    const ax = rot[i]! - minX;
    const ay = rot[i + 1]! - minY;
    const bx = rot[i + 2]! - minX;
    const by = rot[i + 3]! - minY;
    const cx = rot[i + 4]! - minX;
    const cy = rot[i + 5]! - minY;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx) / cell));
    const x1 = Math.min(gw - 1, Math.floor(Math.max(ax, bx, cx) / cell));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy) / cell));
    const y1 = Math.min(gh - 1, Math.floor(Math.max(ay, by, cy) / cell));
    const area2 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const sign = area2 >= 0 ? 1 : -1;
    const e0len = Math.hypot(bx - ax, by - ay);
    const e1len = Math.hypot(cx - bx, cy - by);
    const e2len = Math.hypot(ax - cx, ay - cy);
    for (let gy = y0; gy <= y1; gy++) {
      const py = (gy + 0.5) * cell;
      const rowOff = gy * gw;
      for (let gx = x0; gx <= x1; gx++) {
        if (grid[rowOff + gx]) continue;
        const px = (gx + 0.5) * cell;
        const w0 = sign * ((bx - ax) * (py - ay) - (by - ay) * (px - ax));
        const w1 = sign * ((cx - bx) * (py - by) - (cy - by) * (px - bx));
        const w2 = sign * ((ax - cx) * (py - cy) - (ay - cy) * (px - cx));
        if (w0 >= -half * e0len && w1 >= -half * e1len && w2 >= -half * e2len) {
          grid[rowOff + gx] = 1;
        }
      }
    }
  }

  // Compress into contiguous horizontal spans for fast collision checks.
  const spans: RowSpan[] = [];
  let solidCount = 0;
  for (let y = 0; y < gh; y++) {
    const rowOff = y * gw;
    let x = 0;
    while (x < gw) {
      while (x < gw && !grid[rowOff + x]) x++;
      if (x >= gw) break;
      const x0 = x;
      while (x < gw && grid[rowOff + x]) x++;
      spans.push({ y, x0, x1: x });
      solidCount += x - x0;
    }
  }

  const out: RotatedRaster = { rotDeg, gw, gh, boxW, boxH, minX, minY, spans, solidCount };
  fin.rasterCache.set(key, out);
  return out;
};

/** Precompute circular disk offsets of radius `r` cells for Minkowski dilation. */
const diskOffsets = (r: number): [number, number][] => {
  const out: [number, number][] = [];
  const r2 = r * r;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= r2) out.push([dx, dy]);
    }
  }
  return out;
};

/** Mutable 2D occupancy sheet for fast interlocking placement with rollback support. */
class NestSheet {
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  readonly marginCells: number;
  readonly dilateDisk: readonly [number, number][];
  blocked: Uint8Array;
  usedMaxCol = 0;
  usedMaxRow = 0;
  solidCells = 0;

  constructor(lengthCm: number, widthCm: number, toolWidthCm: number, cell: number) {
    this.cell = cell;
    this.cols = Math.max(1, Math.floor(lengthCm / cell));
    this.rows = Math.max(1, Math.floor(widthCm / cell));
    this.marginCells = toolWidthCm > 0 ? Math.ceil(toolWidthCm / cell) : 0;
    // Pad dilation by √2·cell so discrete grid placement guarantees continuous clearance >= toolWidth.
    const dilateR = toolWidthCm > 0 ? Math.ceil((toolWidthCm + cell * 1.42) / cell) : 1;
    this.dilateDisk = diskOffsets(dilateR);
    this.blocked = new Uint8Array(this.cols * this.rows);
  }

  snapshot(): { blocked: Uint8Array; usedMaxCol: number; usedMaxRow: number; solidCells: number } {
    return {
      blocked: this.blocked.slice(),
      usedMaxCol: this.usedMaxCol,
      usedMaxRow: this.usedMaxRow,
      solidCells: this.solidCells,
    };
  }

  restore(snap: {
    blocked: Uint8Array;
    usedMaxCol: number;
    usedMaxRow: number;
    solidCells: number;
  }): void {
    this.blocked = snap.blocked;
    this.usedMaxCol = snap.usedMaxCol;
    this.usedMaxRow = snap.usedMaxRow;
    this.solidCells = snap.solidCells;
  }

  fits(r: RotatedRaster, gx: number, gy: number): boolean {
    const cols = this.cols;
    const blocked = this.blocked;
    for (let i = 0; i < r.spans.length; i++) {
      const sp = r.spans[i]!;
      const rowOff = (gy + sp.y) * cols;
      for (let x = gx + sp.x0; x < gx + sp.x1; x++) {
        if (blocked[rowOff + x]) return false;
      }
    }
    return true;
  }

  /** Find the tightest placement `(gx, gy, rotDeg)` on this sheet, or null if none fits. */
  findBest(
    fin: PreparedPanelFin,
    objective: 'min-length' | 'pack-left',
  ): { gx: number; gy: number; raster: RotatedRaster } | null {
    const m = this.marginCells;
    let bestScore = Infinity;
    let best: { gx: number; gy: number; raster: RotatedRaster } | null = null;
    // Coarse step 2 cells for speed on big panels, then refine ±2 around first hit per column.
    const step = this.cols * this.rows > 60_000 ? 2 : 1;

    for (const rotDeg of NEST_ANGLES) {
      const r = rasterFor(fin, rotDeg, this.cell);
      const maxGx = this.cols - m - r.gw;
      const maxGy = this.rows - m - r.gh;
      if (maxGx < m || maxGy < m) continue;

      for (let gx = m; gx <= maxGx; gx += step) {
        // Lower bound on score for this column: prune if it cannot beat bestScore.
        const colBound =
          objective === 'min-length'
            ? Math.max(this.usedMaxCol, gx + r.gw) * 10_000 + m
            : gx * 2 + m;
        if (colBound >= bestScore) break;

        for (let gy = m; gy <= maxGy; gy += step) {
          if (!this.fits(r, gx, gy)) continue;
          // Refine within [gx - step + 1, gx] × [gy - step + 1, gy] when stepping > 1.
          let rx = gx;
          let ry = gy;
          if (step > 1) {
            for (let tx = Math.max(m, gx - step + 1); tx <= gx; tx++) {
              let found = false;
              for (let ty = Math.max(m, gy - step + 1); ty <= gy; ty++) {
                if (this.fits(r, tx, ty)) {
                  rx = tx;
                  ry = ty;
                  found = true;
                  break;
                }
              }
              if (found) break;
            }
          }
          const score =
            objective === 'min-length'
              ? Math.max(this.usedMaxCol, rx + r.gw) * 10_000 + ry * 10 + rx
              : rx * 2 + ry;
          if (score < bestScore) {
            bestScore = score;
            best = { gx: rx, gy: ry, raster: r };
          }
          break; // lowest gy in this column is always best for this gx
        }
      }
    }
    return best;
  }

  stamp(r: RotatedRaster, gx: number, gy: number): void {
    const cols = this.cols;
    const rows = this.rows;
    const blocked = this.blocked;
    const disk = this.dilateDisk;
    // Stamp solid cells and their dilated clearance neighbourhood.
    for (let i = 0; i < r.spans.length; i++) {
      const sp = r.spans[i]!;
      const y = gy + sp.y;
      for (let x = gx + sp.x0; x < gx + sp.x1; x++) {
        // Interior cells only need dilation at span ends or row boundaries,
        // but checking edge cells vs stamping small disk is very fast.
        for (let d = 0; d < disk.length; d++) {
          const [dx, dy] = disk[d]!;
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < cols && ny >= 0 && ny < rows) {
            blocked[ny * cols + nx] = 1;
          }
        }
      }
    }
    if (gx + r.gw > this.usedMaxCol) this.usedMaxCol = gx + r.gw;
    if (gy + r.gh > this.usedMaxRow) this.usedMaxRow = gy + r.gh;
    this.solidCells += r.solidCount;
  }
}

const transformLoop2d = (
  pts: readonly Vec2[],
  rotDeg: number,
  shiftX: number,
  shiftY: number,
): Vec2[] => {
  const rad = rotDeg * DEG;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return pts.map((p) => vec2(p.x * c - p.y * s + shiftX, p.x * s + p.y * c + shiftY));
};

const buildPlacement = (
  fin: PreparedPanelFin,
  gx: number,
  gy: number,
  r: RotatedRaster,
  cell: number,
): PanelPlacement => {
  const x = gx * cell;
  const y = gy * cell;
  const shiftX = x - r.minX;
  const shiftY = y - r.minY;
  return {
    finId: fin.id,
    name: fin.name,
    design: fin.design,
    x,
    y,
    rotation: r.rotDeg,
    pose: fin.pose,
    requiredThickness: fin.requiredThickness,
    spanLo: fin.spanLo,
    spanHi: fin.spanHi,
    boxW: r.boxW,
    boxH: r.boxH,
    outline: transformLoop2d(fin.bladeOutline, r.rotDeg, shiftX, shiftY),
    tabOutlines: fin.tabOutlines.map((lp) => transformLoop2d(lp, r.rotDeg, shiftX, shiftY)),
  };
};

const chooseCellSize = (lengthCm: number, widthCm: number): number => {
  const maxDim = Math.max(lengthCm, widthCm);
  if (maxDim <= 100) return 0.2;
  if (maxDim <= 180) return 0.3;
  return Math.max(0.4, maxDim / 500);
};

const roundUpMm = (cm: number, stepMm = 1): number =>
  Math.ceil((cm * 10 - 1e-6) / stepMm) * (stepMm / 10);

const mirrorHand = (d: FinDesign): FinDesign => {
  const other: FinHand | null = d.hand === 'left' ? 'right' : d.hand === 'right' ? 'left' : null;
  return other ? { ...d, hand: other } : d;
};

/**
 * Mode 1: Calculate the minimum G10 panel size needed to cut a collection of fins.
 *
 * Tests several candidate strip widths and picks the smallest enclosing panel area
 * (normalised to `length >= width`). If `panelThickness` is supplied, emits `too-thick`
 * warnings for any fin whose optimal 3D pose still exceeds it.
 */
export const calculatePanelSize = (
  finsIn: readonly PanelFinInput[],
  opts: CalculatePanelSizeOptions,
): PanelLayoutResult => {
  const toolWidth = Math.max(0, opts.toolWidth);
  const minThickness = opts.minThickness ?? 0.05;
  const warnings: PanelWarning[] = [];

  const preparedById = new Map<string, PreparedPanelFin>();
  const copies: PreparedPanelFin[] = [];
  for (const item of finsIn) {
    const qty = Math.max(0, Math.round(item.count ?? 1));
    if (qty === 0) continue;
    let prep = preparedById.get(item.id);
    if (!prep) {
      prep = preparePanelFin(item, minThickness);
      preparedById.set(item.id, prep);
      if (
        opts.panelThickness !== undefined &&
        prep.requiredThickness > opts.panelThickness + 1e-6
      ) {
        warnings.push({
          code: 'too-thick',
          finId: prep.id,
          finName: prep.name,
          requiredThickness: prep.requiredThickness,
          panelThickness: opts.panelThickness,
          message: `${prep.name} needs ${(prep.requiredThickness * 10).toFixed(1)} mm thickness (panel is ${(opts.panelThickness * 10).toFixed(1)} mm).`,
        });
      }
    }
    for (let k = 0; k < qty; k++) copies.push(prep);
  }

  if (copies.length === 0) {
    return {
      mode: 'calculate-size',
      panel: { length: 0, width: 0, thickness: opts.panelThickness ?? 0 },
      toolWidth,
      placements: [],
      warnings,
      utilisation: 0,
      maxRequiredThickness: 0,
    };
  }

  // Place largest fins first for tightest interlocking.
  copies.sort((a, b) => b.area - a.area || a.id.localeCompare(b.id));

  let maxSpan = 0;
  let minSpan = Infinity;
  let totalArea = 0;
  let maxRequiredThickness = 0;
  for (const f of copies) {
    const r0 = rasterFor(f, 0, 0.2);
    const diag = Math.hypot(r0.boxW, r0.boxH);
    if (diag > maxSpan) maxSpan = diag;
    const sm = Math.min(r0.boxW, r0.boxH);
    if (sm < minSpan) minSpan = sm;
    totalArea += f.area;
    if (f.requiredThickness > maxRequiredThickness) maxRequiredThickness = f.requiredThickness;
  }

  const margin = toolWidth;
  const estSide = Math.sqrt(totalArea * 1.55) + 2 * margin;
  const minW = Math.max(minSpan + 2 * margin + 0.5, 10);
  const candidateWidths = [
    minW,
    maxSpan + 2 * margin + 0.5,
    estSide * 0.7,
    estSide,
    estSide * 1.35,
    estSide * 1.8,
  ]
    .map((w) => Math.max(minW, Math.ceil(w)))
    .filter((w, i, arr) => arr.indexOf(w) === i);

  const maxStripLength = Math.max(estSide * 4, maxSpan * copies.length + 2 * margin + 10);

  let bestTrial: {
    length: number;
    width: number;
    area: number;
    placements: PanelPlacement[];
    solidArea: number;
  } | null = null;

  for (const stripW of candidateWidths) {
    const cell = chooseCellSize(maxStripLength, stripW);
    const sheet = new NestSheet(maxStripLength, stripW, toolWidth, cell);
    const placed: PanelPlacement[] = [];
    let ok = true;
    for (const fin of copies) {
      const hit = sheet.findBest(fin, 'min-length');
      if (!hit) {
        ok = false;
        break;
      }
      sheet.stamp(hit.raster, hit.gx, hit.gy);
      placed.push(buildPlacement(fin, hit.gx, hit.gy, hit.raster, cell));
    }
    if (!ok) continue;
    const usedL = roundUpMm(sheet.usedMaxCol * cell + margin, 1);
    const usedW = roundUpMm(sheet.usedMaxRow * cell + margin, 1);
    const panelArea = usedL * usedW;
    if (!bestTrial || panelArea < bestTrial.area - 1e-6) {
      bestTrial = {
        length: usedL,
        width: usedW,
        area: panelArea,
        placements: placed,
        solidArea: sheet.solidCells * cell * cell,
      };
    }
  }

  if (!bestTrial) {
    return {
      mode: 'calculate-size',
      panel: { length: 0, width: 0, thickness: roundUpMm(maxRequiredThickness, 0.5) },
      toolWidth,
      placements: [],
      warnings: [
        ...warnings,
        {
          code: 'unplaced',
          finId: copies[0]!.id,
          finName: copies[0]!.name,
          message: 'Could not lay out the selected fins.',
        },
      ],
      utilisation: 0,
      maxRequiredThickness,
    };
  }

  // Normalise so length >= width (if taller than wide, rotate the whole layout 90°).
  let length = bestTrial.length;
  let width = bestTrial.width;
  let placements = bestTrial.placements;
  if (width > length) {
    const oldL = length;
    length = width;
    width = oldL;
    // Rotate layout 90° clockwise: (x, y) -> (y, oldL - x) so [0, oldL]×[0, oldW] maps to [0, oldW]×[0, oldL].
    const rotPt = (p: Vec2) => vec2(p.y, oldL - p.x);
    placements = placements.map((pl) => ({
      ...pl,
      x: pl.y,
      y: oldL - pl.x - pl.boxW,
      rotation: (pl.rotation + 270) % 360,
      boxW: pl.boxH,
      boxH: pl.boxW,
      outline: pl.outline.map(rotPt),
      tabOutlines: pl.tabOutlines.map((lp) => lp.map(rotPt)),
    }));
  }

  const thickness = roundUpMm(maxRequiredThickness, 0.5);
  const utilisation = length * width > 0 ? Math.min(1, bestTrial.solidArea / (length * width)) : 0;

  return {
    mode: 'calculate-size',
    panel: { length, width, thickness },
    toolWidth,
    placements,
    warnings,
    utilisation,
    maxRequiredThickness,
  };
};

interface CandidateUnit {
  readonly key: string;
  readonly fins: readonly PreparedPanelFin[];
  readonly totalArea: number;
}

/**
 * Mode 2: Recommend a fin collection from `library` that fills the given G10 panel.
 *
 * Excludes fins thicker than `panel.thickness` (emitting `too-thick` warnings), groups
 * side fins into matched Left + Right pairs, and repeats pairs/centre fins to pack the
 * panel as tightly as possible with interlocking 2D polygon nesting.
 */
export const recommendPanelFins = (
  library: readonly PanelFinInput[],
  opts: RecommendPanelFinsOptions,
): PanelLayoutResult => {
  const { panel } = opts;
  const toolWidth = Math.max(0, opts.toolWidth);
  const pairing: PanelPairingMode = opts.pairing ?? 'pairs-only';
  const minThickness = opts.minThickness ?? 0.05;
  const maxFins = opts.maxFins ?? 120;
  const warnings: PanelWarning[] = [];

  const fitting: PreparedPanelFin[] = [];
  for (const item of library) {
    const prep = preparePanelFin(item, minThickness);
    if (prep.requiredThickness > panel.thickness + 1e-6) {
      warnings.push({
        code: 'too-thick',
        finId: prep.id,
        finName: prep.name,
        requiredThickness: prep.requiredThickness,
        panelThickness: panel.thickness,
        message: `${prep.name} needs ${(prep.requiredThickness * 10).toFixed(1)} mm thickness (panel is ${(panel.thickness * 10).toFixed(1)} mm).`,
      });
      continue;
    }
    fitting.push(prep);
  }

  // Group side/quad-rear fins into matched L+R pairs; centre fins stay singletons.
  const units: CandidateUnit[] = [];
  const usedIdx = new Set<number>();
  const baseName = (name: string) =>
    name.replace(/(?:[-_\s](?:left|right|l|r))$/i, '').toLowerCase();

  for (let i = 0; i < fitting.length; i++) {
    if (usedIdx.has(i)) continue;
    const f = fitting[i]!;
    usedIdx.add(i);
    if (f.design.hand === null) {
      units.push({ key: f.id, fins: [f], totalArea: f.area });
      continue;
    }
    const wantHand: FinHand = f.design.hand === 'left' ? 'right' : 'left';
    let mateIdx = -1;
    const bn = baseName(f.name);
    for (let j = i + 1; j < fitting.length; j++) {
      if (usedIdx.has(j)) continue;
      const g = fitting[j]!;
      if (g.design.hand === wantHand && baseName(g.name) === bn) {
        mateIdx = j;
        break;
      }
    }
    if (mateIdx !== -1) {
      usedIdx.add(mateIdx);
      const mate = fitting[mateIdx]!;
      units.push({ key: `${f.id}+${mate.id}`, fins: [f, mate], totalArea: f.area + mate.area });
    } else {
      // Automatically create the matched opposite-hand fin so the operator gets a complete pair.
      const mirrorDesign = mirrorHand(f.design);
      const suffix = wantHand === 'left' ? 'L' : 'R';
      const mate = preparePanelFin(
        { id: `${f.id}~${wantHand}`, name: `${f.name} (${suffix})`, design: mirrorDesign },
        minThickness,
      );
      units.push({ key: `${f.id}+pair`, fins: [f, mate], totalArea: f.area + mate.area });
    }
  }

  // Largest units first, deterministic tie-break.
  units.sort((a, b) => b.totalArea - a.totalArea || a.key.localeCompare(b.key));

  const cell = chooseCellSize(panel.length, panel.width);
  const sheet = new NestSheet(panel.length, panel.width, toolWidth, cell);
  const placements: PanelPlacement[] = [];

  // Check which units can fit on an empty panel (for helpful too-large warnings).
  const emptyCheck = new NestSheet(panel.length, panel.width, toolWidth, cell);
  const viable: CandidateUnit[] = [];
  const oddUnits: CandidateUnit[] = [];
  for (const unit of units) {
    const snap = emptyCheck.snapshot();
    let ok = true;
    for (const fin of unit.fins) {
      const hit = emptyCheck.findBest(fin, 'pack-left');
      if (!hit) {
        ok = false;
        break;
      }
      emptyCheck.stamp(hit.raster, hit.gx, hit.gy);
    }
    emptyCheck.restore(snap);
    if (ok) {
      viable.push(unit);
      oddUnits.push(unit);
    } else if (
      pairing === 'pairs-plus-odd' &&
      unit.fins.length > 1 &&
      unit.fins.some((fin) => emptyCheck.findBest(fin, 'pack-left') !== null)
    ) {
      // A full pair doesn't fit on the panel, but at least one single fin does.
      oddUnits.push(unit);
    } else {
      const f0 = unit.fins[0]!;
      warnings.push({
        code: 'too-large',
        finId: f0.id,
        finName: f0.name,
        message: `${f0.name}${unit.fins.length > 1 && pairing === 'pairs-only' ? ' (pair)' : ''} does not fit within the ${(panel.length * 10).toFixed(0)} × ${(panel.width * 10).toFixed(0)} mm panel.`,
      });
    }
  }

  const placedCounts = new Map<string, number>();
  const recordPlacement = (pl: PanelPlacement) => {
    placements.push(pl);
    placedCounts.set(pl.finId, (placedCounts.get(pl.finId) ?? 0) + 1);
  };

  const tryPlaceUnit = (unit: CandidateUnit): boolean => {
    if (placements.length + unit.fins.length > maxFins) return false;
    const snap = sheet.snapshot();
    const added: PanelPlacement[] = [];
    for (const fin of unit.fins) {
      const hit = sheet.findBest(fin, 'pack-left');
      if (!hit) {
        sheet.restore(snap);
        return false;
      }
      sheet.stamp(hit.raster, hit.gx, hit.gy);
      added.push(buildPlacement(fin, hit.gx, hit.gy, hit.raster, cell));
    }
    for (const pl of added) recordPlacement(pl);
    return true;
  };

  // Phase 1: round-robin pass across viable units so diverse fin sets are represented, then
  // greedily repeat complete pairs / centre fins until no more full units fit.
  let progress = true;
  while (progress && placements.length < maxFins) {
    progress = false;
    for (const unit of viable) {
      if (tryPlaceUnit(unit)) progress = true;
    }
  }

  // Phase 2 (Pairs + odd fins): fill leftover pockets with individual fins, preferring the
  // largest single fin that fits and keeping L/R counts as balanced as possible.
  if (pairing === 'pairs-plus-odd' && oddUnits.length > 0) {
    const bySingleArea = [...oddUnits].sort(
      (a, b) => b.fins[0]!.area - a.fins[0]!.area || a.key.localeCompare(b.key),
    );
    let oddProgress = true;
    while (oddProgress && placements.length < maxFins) {
      oddProgress = false;
      for (const unit of bySingleArea) {
        if (placements.length >= maxFins) break;
        // Try the less-placed hand first so any even number of odd fills stays balanced.
        const ordered = [...unit.fins].sort(
          (a, b) => (placedCounts.get(a.id) ?? 0) - (placedCounts.get(b.id) ?? 0),
        );
        for (const fin of ordered) {
          const hit = sheet.findBest(fin, 'pack-left');
          if (!hit) continue;
          sheet.stamp(hit.raster, hit.gx, hit.gy);
          recordPlacement(buildPlacement(fin, hit.gx, hit.gy, hit.raster, cell));
          oddProgress = true;
          break;
        }
      }
    }
  }

  const maxRequiredThickness = placements.reduce((m, p) => Math.max(m, p.requiredThickness), 0);
  const panelArea = panel.length * panel.width;
  const utilisation = panelArea > 0 ? Math.min(1, (sheet.solidCells * cell * cell) / panelArea) : 0;

  return {
    mode: 'recommend-fill',
    pairing,
    panel,
    toolWidth,
    placements,
    warnings,
    utilisation,
    maxRequiredThickness,
  };
};
