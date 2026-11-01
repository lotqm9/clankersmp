// Darkness for the night mobs (protocol v6), without a light engine on the server:
//   - every light-giving block (torches, lamps, lit furnaces, glowing ore) is kept in a spatial hash, so "is this
//     spot lit?" is a look at the emitters nearby: a block of light L lights cells within Manhattan distance L - 1
//     (walls are ignored, which errs on the safe side: a torch keeps mobs away even behind a thin wall)
//   - every column's highest sky-blocking block is kept in a height map: above it a spot is under the open sky
//     (where the sun burns the undead), below it the spot is roofed (where caves are dark even by day)
// Both are built from the world once at start and kept up to date on every block change (Shard.setBlock).

import { EMIT, LIGHT_OPACITY, OPAQUE } from "../../shared/blocks.ts";
import { LAYER, VOLUME, WORLD_BITS, WORLD_HEIGHT, WORLD_SIZE, cellX, cellY, cellZ, idx } from "../../shared/constants.ts";

const B = 16; // bucket size for the emitter hash
const bucketKey = (x: number, y: number, z: number) => (Math.floor(y / B) * 64 + Math.floor(z / B)) * 64 + Math.floor(x / B);

/** Blocks that stop sunlight from reaching a spot (anything opaque, or that dims light: leaves, water). */
const blocksSky = (id: number) => OPAQUE[id] === 1 || LIGHT_OPACITY[id] > 0;

export class LightIndex {
  private world: Uint8Array;
  private buckets = new Map<number, Map<number, number>>(); // bucket -> (cell -> light)
  /** Per column (x + z * 512): the y of the highest sky-blocking block, or -1. */
  readonly height = new Int16Array(WORLD_SIZE * WORLD_SIZE).fill(-1);
  emitters = 0;

  constructor(world: Uint8Array) {
    this.world = world;
    for (let i = 0; i < VOLUME; i++) {
      const id = world[i];
      if (id === 0) continue;
      if (EMIT[id]) this.addEmitter(i, EMIT[id]);
    }
    for (let c = 0; c < WORLD_SIZE * WORLD_SIZE; c++) this.height[c] = this.scanDown(c, WORLD_HEIGHT - 1);
  }

  private scanDown(col: number, from: number): number {
    for (let y = from; y >= 0; y--) if (blocksSky(this.world[y * LAYER + col])) return y;
    return -1;
  }

  private addEmitter(i: number, light: number): void {
    const k = bucketKey(cellX(i), cellY(i), cellZ(i));
    let m = this.buckets.get(k);
    if (!m) this.buckets.set(k, (m = new Map()));
    if (!m.has(i)) this.emitters++;
    m.set(i, light);
  }

  private removeEmitter(i: number): void {
    const k = bucketKey(cellX(i), cellY(i), cellZ(i));
    const m = this.buckets.get(k);
    if (m?.delete(i)) {
      this.emitters--;
      if (!m.size) this.buckets.delete(k);
    }
  }

  /** A cell changed from `old` to `id` (the world already holds `id`). */
  changed(i: number, old: number, id: number): void {
    if (EMIT[old]) this.removeEmitter(i);
    if (EMIT[id]) this.addEmitter(i, EMIT[id]);
    if (blocksSky(old) === blocksSky(id)) return;
    const col = i & (LAYER - 1);
    const y = i >> (WORLD_BITS * 2);
    if (blocksSky(id)) {
      if (y > this.height[col]) this.height[col] = y;
    } else if (y >= this.height[col]) this.height[col] = this.scanDown(col, y);
  }

  /** The strongest block light reaching a cell from the emitters near it (0 = dark). */
  blockLight(x: number, y: number, z: number): number {
    let best = 0;
    const bx0 = Math.floor((x - 15) / B);
    const bx1 = Math.floor((x + 15) / B);
    const by0 = Math.floor((y - 15) / B);
    const by1 = Math.floor((y + 15) / B);
    const bz0 = Math.floor((z - 15) / B);
    const bz1 = Math.floor((z + 15) / B);
    for (let by = by0; by <= by1; by++)
      for (let bz = bz0; bz <= bz1; bz++)
        for (let bx = bx0; bx <= bx1; bx++) {
          if (bx < 0 || bz < 0 || by < 0) continue;
          const m = this.buckets.get((by * 64 + bz) * 64 + bx);
          if (!m) continue;
          for (const [i, l] of m) {
            const d = Math.abs(cellX(i) - x) + Math.abs(cellY(i) - y) + Math.abs(cellZ(i) - z);
            if (l - d > best) best = l - d;
          }
        }
    return best;
  }

  /** Under the open sky (nothing above blocks the sun). */
  sky(x: number, y: number, z: number): boolean {
    if (x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE) return true;
    return y > this.height[x + z * WORLD_SIZE];
  }

  /** The top of a column's sky-blocking blocks (-1: open to the bottom). */
  top(x: number, z: number): number {
    if (x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE) return -1;
    return this.height[x + z * WORLD_SIZE];
  }

  /** Dark enough for daytime spawns: roofed deeply, and roofed a little everywhere around (no light from a cave
   *  mouth next to it). */
  deepDark(x: number, y: number, z: number): boolean {
    if (y > this.top(x, z) - 6) return false;
    for (const [dx, dz] of [[6, 0], [-6, 0], [0, 6], [0, -6], [4, 4], [-4, 4], [4, -4], [-4, -4]]) if (y > this.top(x + dx, z + dz) - 3) return false;
    return true;
  }

  /** Test helper: is cell (x, y, z) a known emitter? */
  isEmitter(x: number, y: number, z: number): boolean {
    return this.buckets.get(bucketKey(x, y, z))?.has(idx(x, y, z)) ?? false;
  }
}
