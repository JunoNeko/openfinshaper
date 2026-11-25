// SPDX-License-Identifier: GPL-3.0-or-later
/** Binary STL writer for triangle meshes (`BoardMesh`). */
import type { BoardMesh } from '@openshaper/kernel';

interface P3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

const triNormal = (a: P3, b: P3, c: P3): P3 => {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const uz = b.z - a.z;
  const vx = c.x - a.x;
  const vy = c.y - a.y;
  const vz = c.z - a.z;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len > 0) {
    nx /= len;
    ny /= len;
    nz /= len;
  }
  return { x: nx, y: ny, z: nz };
};

/** One facet as 12 numbers: the unit normal, then the three vertices. */
const writeFacet = (out: number[], a: P3, b: P3, c: P3): void => {
  const n = triNormal(a, b, c);
  out.push(n.x, n.y, n.z, a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
};

/**
 * Facets (12 numbers each: normal, then three vertices) as a binary STL, named in the
 * header.
 */
export const encodeBinaryStl = (
  facets: readonly number[],
  name: string,
  product: string,
): Uint8Array => {
  const count = facets.length / 12;
  const bytes = new Uint8Array(84 + count * 50);
  const header = `${product} STL ${name}`.slice(0, 80);
  for (let i = 0; i < header.length; i++) bytes[i] = header.charCodeAt(i) & 0x7f;
  const view = new DataView(bytes.buffer);
  view.setUint32(80, count, true);
  let o = 84;
  for (let i = 0; i < facets.length; i += 12) {
    for (let k = 0; k < 12; k++) {
      const v = facets[i + k]!;
      view.setFloat32(o, Number.isFinite(v) ? v : 0, true);
      o += 4;
    }
    o += 2; // attribute byte count: 0
  }
  return bytes;
};

/**
 * The volume a closed mesh encloses, signed: positive when its triangles are wound so
 * their faces point out (the divergence theorem over the faces).
 */
const signedVolume = ({ positions: p, indices: ix }: BoardMesh): number => {
  let v = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t]! * 3;
    const b = ix[t + 1]! * 3;
    const c = ix[t + 2]! * 3;
    v +=
      p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) -
      p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) +
      p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!);
  }
  return v / 6;
};

/**
 * Append a mesh's triangles as facets, coordinates multiplied by `scale` (a unit change),
 * wound so the faces point out of the solid: a mirrored fin's mesh comes wound inside
 * out, and a slicer reads an inside-out solid as a hole.
 */
export const writeMesh = (out: number[], mesh: BoardMesh, scale = 1): void => {
  const flip = signedVolume(mesh) < 0;
  const { positions, indices } = mesh;
  const at = (i: number): P3 =>
    scale === 1
      ? { x: positions[i * 3]!, y: positions[i * 3 + 1]!, z: positions[i * 3 + 2]! }
      : {
          x: positions[i * 3]! * scale,
          y: positions[i * 3 + 1]! * scale,
          z: positions[i * 3 + 2]! * scale,
        };
  for (let t = 0; t < indices.length; t += 3) {
    const a = at(indices[t]!);
    const b = at(indices[t + 1]!);
    const c = at(indices[t + 2]!);
    if (flip) writeFacet(out, a, c, b);
    else writeFacet(out, a, b, c);
  }
};
