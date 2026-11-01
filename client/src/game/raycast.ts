// Voxel ray cast (Amanatides & Woo) for picking the targeted block and face.

import { B, IS_WATER, RENDER } from "../../../shared/blocks.ts";
import { WORLD_HEIGHT, WORLD_SIZE } from "../../../shared/constants.ts";
import { pickBoxes16, selectionBox16, type Nb } from "../../../shared/shapes.ts";
import type { Box } from "../render/effects.ts";

export interface Hit {
  x: number;
  y: number;
  z: number;
  id: number;
  face: number; // 0 +X, 1 -X, 2 +Y, 3 -Y, 4 +Z, 5 -Z (the face that was hit)
  nx: number;
  ny: number;
  nz: number;
  dist: number;
  /** Height of the hit point inside the block, 0..1 (slabs and stairs use it to pick top or bottom). */
  fy: number;
}

/** Outline shape of a block in its cell (plants, torches and model blocks are smaller). */
export function selectionBox(id: number, get?: (x: number, y: number, z: number) => number, x = 0, y = 0, z = 0): Box {
  const kind = RENDER[id];
  if (kind === 6) {
    const nb: Nb = (dx, dy, dz) => (get ? safeGet(get, x + dx, y + dy, z + dz) : B.AIR);
    const b = selectionBox16(id, nb);
    return { x0: b[0] / 16, y0: b[1] / 16, z0: b[2] / 16, x1: b[3] / 16, y1: b[4] / 16, z1: b[5] / 16 };
  }
  if (kind === 4) return { x0: 2 / 16, y0: 0, z0: 2 / 16, x1: 14 / 16, y1: 13 / 16, z1: 14 / 16 };
  // v7 crops: as tall as they have grown
  if (kind === 7) return { x0: 0, y0: 0, z0: 0, x1: 1, y1: ((id - B.WHEAT + 1) * 2) / 16, z1: 1 };
  if (kind === 5) return { x0: 6 / 16, y0: 0, z0: 6 / 16, x1: 10 / 16, y1: 10 / 16, z1: 10 / 16 };
  return { x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 1 };
}

const FACE_N = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

function safeGet(get: (x: number, y: number, z: number) => number, x: number, y: number, z: number): number {
  if (x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE || y < 0 || y >= WORLD_HEIGHT) return B.AIR;
  return get(x, y, z);
}

function rayBox(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, b: Box, max: number): { t: number; face: number } | null {
  let tmin = 0;
  let tmax = max;
  let face = -1;
  const axes: [number, number, number, number, number, number][] = [
    [ox, dx, b.x0, b.x1, 1, 0],
    [oy, dy, b.y0, b.y1, 3, 2],
    [oz, dz, b.z0, b.z1, 5, 4],
  ];
  for (const [o, d, lo, hi, faceLo, faceHi] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null;
      continue;
    }
    let t1 = (lo - o) / d;
    let t2 = (hi - o) / d;
    let f1 = faceLo;
    let f2 = faceHi;
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      [f1, f2] = [f2, f1];
    }
    if (t1 > tmin) {
      tmin = t1;
      face = f1;
    }
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return face < 0 ? null : { t: tmin, face };
}

export function raycast(
  get: (x: number, y: number, z: number) => number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
  water = false,
): Hit | null {
  let x = Math.floor(ox);
  let y = Math.floor(oy);
  let z = Math.floor(oz);
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;
  const tDeltaX = Math.abs(1 / dx);
  const tDeltaY = Math.abs(1 / dy);
  const tDeltaZ = Math.abs(1 / dz);
  let tMaxX = dx > 0 ? (x + 1 - ox) * tDeltaX : (ox - x) * tDeltaX;
  let tMaxY = dy > 0 ? (y + 1 - oy) * tDeltaY : (oy - y) * tDeltaY;
  let tMaxZ = dz > 0 ? (z + 1 - oz) * tDeltaZ : (oz - z) * tDeltaZ;
  let t = 0;
  let face = -1;
  for (let i = 0; i < 64 && t <= maxDist; i++) {
    if (x >= 0 && z >= 0 && x < WORLD_SIZE && z < WORLD_SIZE && y >= 0 && y < WORLD_HEIGHT) {
      const id = get(x, y, z);
      // v7 `water`: a water source stops the ray too (a bucket scooping it up)
      if (id !== B.AIR && (!IS_WATER[id] || (water && id === B.WATER))) {
        const kind = RENDER[id];
        if (kind === 4 || kind === 5 || kind === 7) {
          const b = selectionBox(id);
          const r = rayBox(ox - x, oy - y, oz - z, dx, dy, dz, b, maxDist);
          if (r && r.t <= maxDist) {
            const n = FACE_N[r.face];
            return { x, y, z, id, face: r.face, nx: n[0], ny: n[1], nz: n[2], dist: r.t, fy: oy + dy * r.t - y };
          }
        } else if (kind === 6) {
          // Model blocks: test each box so stairs, fences and doors pick by their real shape.
          const nb: Nb = (ddx, ddy, ddz) => safeGet(get, x + ddx, y + ddy, z + ddz);
          let best: { t: number; face: number } | null = null;
          for (const b16 of pickBoxes16(id, nb)) {
            const b = { x0: b16[0] / 16, y0: b16[1] / 16, z0: b16[2] / 16, x1: b16[3] / 16, y1: b16[4] / 16, z1: b16[5] / 16 };
            const r = rayBox(ox - x, oy - y, oz - z, dx, dy, dz, b, maxDist);
            if (r && r.t <= maxDist && (!best || r.t < best.t)) best = r;
          }
          if (best) {
            const n = FACE_N[best.face];
            return { x, y, z, id, face: best.face, nx: n[0], ny: n[1], nz: n[2], dist: best.t, fy: oy + dy * best.t - y };
          }
        } else if (face >= 0) {
          const n = FACE_N[face];
          return { x, y, z, id, face, nx: n[0], ny: n[1], nz: n[2], dist: t, fy: oy + dy * t - y };
        }
      }
    }
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX;
      t = tMaxX;
      tMaxX += tDeltaX;
      face = stepX > 0 ? 1 : 0;
    } else if (tMaxY < tMaxZ) {
      y += stepY;
      t = tMaxY;
      tMaxY += tDeltaY;
      face = stepY > 0 ? 3 : 2;
    } else {
      z += stepZ;
      t = tMaxZ;
      tMaxZ += tDeltaZ;
      face = stepZ > 0 ? 5 : 4;
    }
  }
  return null;
}
