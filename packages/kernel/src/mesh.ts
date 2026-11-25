// SPDX-License-Identifier: GPL-3.0-or-later
/** Shared 3D point and triangle mesh primitives used across the fin kernel and exporters. */

export interface Vert3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * A triangle mesh ready for GPU upload or binary STL export.
 *
 * `positions` and `normals` are flat xyz triples (cm); `indices` are triangle vertex
 * indices (3 per triangle).
 */
export interface BoardMesh {
  positions: Float32Array;
  indices: Uint32Array;
  normals: Float32Array;
}

/** Build a {@link BoardMesh} with area-weighted vertex normals from flat positions and indices. */
export const meshWithNormals = (positions: number[], indices: number[]): BoardMesh => {
  const normals = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t]!;
    const ib = indices[t + 1]!;
    const ic = indices[t + 2]!;
    const ax = positions[ia * 3]!;
    const ay = positions[ia * 3 + 1]!;
    const az = positions[ia * 3 + 2]!;
    const e1x = positions[ib * 3]! - ax;
    const e1y = positions[ib * 3 + 1]! - ay;
    const e1z = positions[ib * 3 + 2]! - az;
    const e2x = positions[ic * 3]! - ax;
    const e2y = positions[ic * 3 + 1]! - ay;
    const e2z = positions[ic * 3 + 2]! - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    for (const vi of [ia, ib, ic]) {
      normals[vi * 3] = normals[vi * 3]! + nx;
      normals[vi * 3 + 1] = normals[vi * 3 + 1]! + ny;
      normals[vi * 3 + 2] = normals[vi * 3 + 2]! + nz;
    }
  }
  for (let v = 0; v < positions.length / 3; v++) {
    const len = Math.hypot(normals[v * 3]!, normals[v * 3 + 1]!, normals[v * 3 + 2]!);
    if (len > 1e-9) {
      normals[v * 3] = normals[v * 3]! / len;
      normals[v * 3 + 1] = normals[v * 3 + 1]! / len;
      normals[v * 3 + 2] = normals[v * 3 + 2]! / len;
    } else {
      normals[v * 3 + 2] = 1;
    }
  }
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    normals,
  };
};
