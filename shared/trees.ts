// A planted sapling growing into a tree (protocol v5): the same small oak/birch shape as worldgen's trees, as a list
// of block changes, so the server can apply (and broadcast) it. Wood stays renewable on a shared island.

import { B } from "./blocks.ts";
import { WORLD_HEIGHT, WORLD_SIZE, idx } from "./constants.ts";
import { hash2 } from "./noise.ts";

type Get = (x: number, y: number, z: number) => number;
export type TreeChange = [number, number, number, number];

const free = (id: number) => id === B.AIR || id === B.TALL_GRASS || id === B.DANDELION || id === B.POPPY || id === B.BLUEBELL;

/** The cells a tree grown from a sapling at (x, y, z) fills, or null if there is no room for its trunk. */
export function treeChanges(get: Get, x: number, y: number, z: number, birch: boolean, rand: () => number): TreeChange[] | null {
  const log = birch ? B.BIRCH_LOG : B.OAK_LOG;
  const leaves = birch ? B.BIRCH_LEAVES : B.OAK_LEAVES;
  const th = (birch ? 5 : 4) + Math.floor(rand() * 3);
  if (y + th + 1 >= WORLD_HEIGHT || x < 2 || z < 2 || x >= WORLD_SIZE - 2 || z >= WORLD_SIZE - 2) return null;
  for (let k = 1; k < th + 1; k++) if (!free(get(x, y + k, z))) return null;
  const out: TreeChange[] = [];
  const set = new Map<string, number>();
  for (let yy = y + th - 3; yy <= y + th; yy++) {
    const i4 = yy - (y + th);
    const rad = 1 - Math.trunc(i4 / 2);
    for (let dx = -rad; dx <= rad; dx++)
      for (let dz = -rad; dz <= rad; dz++) {
        const corner = Math.abs(dx) === rad && Math.abs(dz) === rad;
        if (corner && (i4 === 0 || rand() < 0.5)) continue;
        if (!free(get(x + dx, yy, z + dz))) continue;
        set.set(`${x + dx},${yy},${z + dz}`, leaves);
      }
  }
  for (let j = 0; j < th; j++) set.set(`${x},${y + j},${z}`, log);
  for (const [k, id] of set) {
    const [a, b, c] = k.split(",").map(Number);
    out.push([a, b, c, id]);
  }
  out.push([x, y - 1, z, B.DIRT]);
  return out;
}

// ---- worldgen trees (moved here from worldgen.ts in v8 so the islands can plant them too; unchanged)

const W = WORLD_SIZE;

export function setIfAir(blocks: Uint8Array, x: number, y: number, z: number, id: number): void {
  if (x < 0 || z < 0 || x >= W || z >= W || y < 0 || y >= WORLD_HEIGHT) return;
  const i = idx(x, y, z);
  const cur = blocks[i];
  if (cur === 0 || cur === B.TALL_GRASS || cur === B.DANDELION || cur === B.POPPY || cur === B.BLUEBELL) blocks[i] = id;
}

/** The classic small-tree shape: 4 leaf layers, radius 2,2,1,1, random corners, bare top corners. */
export function growTree(blocks: Uint8Array, x: number, y: number, z: number, birch: boolean, seed: number): void {
  const log = birch ? B.BIRCH_LOG : B.OAK_LOG;
  const leaves = birch ? B.BIRCH_LEAVES : B.OAK_LEAVES;
  const th = (birch ? 5 : 4) + Math.floor(hash2(x, z, seed + 41) * 3);
  if (y + th + 1 >= WORLD_HEIGHT) return;
  for (let yy = y + th - 3; yy <= y + th; yy++) {
    const i4 = yy - (y + th);
    const rad = 1 - Math.trunc(i4 / 2);
    for (let dx = -rad; dx <= rad; dx++) {
      for (let dz = -rad; dz <= rad; dz++) {
        const corner = Math.abs(dx) === rad && Math.abs(dz) === rad;
        if (corner && (i4 === 0 || hash2(x * 31 + dx, z * 17 + dz, seed + yy) < 0.5)) continue;
        setIfAir(blocks, x + dx, yy, z + dz, leaves);
      }
    }
  }
  for (let j = 0; j < th; j++) {
    const i = idx(x, y + j, z);
    const cur = blocks[i];
    if (cur === 0 || cur === leaves || cur === B.TALL_GRASS || cur === B.DANDELION || cur === B.POPPY || cur === B.BLUEBELL) blocks[i] = log;
  }
  blocks[idx(x, y - 1, z)] = B.DIRT;
}

