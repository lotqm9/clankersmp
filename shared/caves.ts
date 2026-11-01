// Underground: winding cave tunnels (some open onto hillsides), a few big caverns, dirt and gravel pockets, and ore
// veins: coal, iron, gold, ruby and diamond, each at its own depths. Deterministic like the rest of worldgen:
// only +, -, *, /, Math.sqrt, Math.floor and integer hashes (no sin/cos), so every engine carves the same caves.

import { B } from "./blocks.ts";
import { SPAWN_X, SPAWN_Z, WORLD_HEIGHT, WORLD_SIZE, idx } from "./constants.ts";
import { mulberry32 } from "./noise.ts";

const W = WORLD_SIZE;
const REGION = 32; // one chance of a cave system per 32 x 32 area
const SPAWN_CLEAR = 62; // no caves under the spawn hub (it is flat out to 48, blended by 64)

export interface CaveStats {
  tunnels: number;
  caverns: number;
  carved: number;
  entrances: number;
  ores: Record<string, number>;
}

const isPlant = (id: number) => id === B.TALL_GRASS || id === B.DANDELION || id === B.POPPY || id === B.BLUEBELL;
/** Blocks a cave may cut through. Never bedrock, water, logs or leaves. */
const carvable = (id: number) => id === B.STONE || id === B.DIRT || id === B.GRAVEL || id === B.GRASS || id === B.SAND;

/**
 * Carve caves into a generated world. `height[z * W + x]` is the surface y of each column (before caves).
 * Returns stats for previews and tests.
 */
export function carveCaves(blocks: Uint8Array, height: Int16Array, seed: number): CaveStats {
  const stats: CaveStats = { tunnels: 0, caverns: 0, carved: 0, entrances: 0, ores: {} };

  /** Is there water right above this cell (within 3), or is it next to the sea? Then leave it (no flooded caves). */
  const nearWater = (x: number, y: number, z: number): boolean => {
    for (let dy = 0; dy <= 3; dy++) {
      const yy = y + dy;
      if (yy >= WORLD_HEIGHT) break;
      for (let d = 0; d < 5; d++) {
        const xx = x + (d === 1 ? 1 : d === 2 ? -1 : 0);
        const zz = z + (d === 3 ? 1 : d === 4 ? -1 : 0);
        if (xx < 0 || zz < 0 || xx >= W || zz >= W) return true;
        if (blocks[idx(xx, yy, zz)] === B.WATER) return true;
      }
    }
    return false;
  };

  const clear = (x: number, y: number, z: number): void => {
    if (x < 1 || z < 1 || x >= W - 1 || z >= W - 1 || y < 4 || y >= WORLD_HEIGHT - 1) return;
    const i = idx(x, y, z);
    const id = blocks[i];
    if (!carvable(id)) return;
    if (nearWater(x, y, z)) return;
    blocks[i] = B.AIR;
    stats.carved++;
    // Plants on top of the carved block would float: remove them too.
    const up = blocks[idx(x, y + 1, z)];
    if (isPlant(up)) blocks[idx(x, y + 1, z)] = B.AIR;
    if (y === height[z * W + x] && (id === B.GRASS || id === B.SAND)) stats.entrances++;
  };

  /** Carve an ellipsoid (radius r sideways, r * ry vertically) around (cx, cy, cz). */
  const blob = (cx: number, cy: number, cz: number, r: number, ry: number): void => {
    const rv = r * ry;
    const x0 = Math.floor(cx - r);
    const x1 = Math.floor(cx + r);
    const y0 = Math.floor(cy - rv);
    const y1 = Math.floor(cy + rv);
    const z0 = Math.floor(cz - r);
    const z1 = Math.floor(cz + r);
    for (let y = y0; y <= y1; y++) {
      const dy = (y + 0.5 - cy) / rv;
      for (let z = z0; z <= z1; z++) {
        const dz = (z + 0.5 - cz) / r;
        for (let x = x0; x <= x1; x++) {
          const dx = (x + 0.5 - cx) / r;
          if (dx * dx + dy * dy + dz * dz < 1) clear(x, y, z);
        }
      }
    }
  };

  const surfaceAt = (x: number, z: number) => height[Math.max(0, Math.min(W - 1, Math.floor(z))) * W + Math.max(0, Math.min(W - 1, Math.floor(x)))];

  /** One winding tunnel. Direction is a unit vector nudged by random vectors each step (no trigonometry). */
  const tunnel = (rand: () => number, x: number, y: number, z: number, dx: number, dy: number, dz: number, length: number, r0: number, depth: number): void => {
    stats.tunnels++;
    let r = r0;
    for (let step = 0; step < length; step++) {
      // wander
      dx += (rand() - 0.5) * 0.32;
      dz += (rand() - 0.5) * 0.32;
      dy = dy * 0.86 + (rand() - 0.5) * 0.12;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      dx /= len;
      dy /= len;
      dz /= len;
      x += dx;
      y += dy;
      z += dz;
      r += (rand() - 0.5) * 0.25;
      if (r < 1.3) r = 1.3;
      if (r > 3.1) r = 3.1;
      if (x < 4 || z < 4 || x >= W - 4 || z >= W - 4) break;
      if (y < 7) dy = Math.abs(dy) + 0.05; // bounce off the bedrock layer instead of ending
      const sx = x - SPAWN_X;
      const sz = z - SPAWN_Z;
      if (sx * sx + sz * sz < SPAWN_CLEAR * SPAWN_CLEAR) break;
      // Do not climb into the sky: stop a little above the surface (the hole is the entrance).
      if (y > surfaceAt(x, z) + 1) break;
      blob(x, y, z, r, 0.78);
      // Now and then a wide chamber, and now and then a side branch.
      if (rand() < 0.006 && depth < 2) {
        blob(x, y, z, r + 2.5 + rand() * 2.5, 0.6);
        stats.caverns++;
      }
      if (rand() < 0.018 && depth < 2 && step < length - 20) {
        // branch off roughly sideways: (dz, ., -dx) or (-dz, ., dx)
        const s = rand() < 0.5 ? 1 : -1;
        tunnel(rand, x, y, z, dz * s + dx * 0.3, dy * 0.5, -dx * s + dz * 0.3, Math.floor((length - step) * (0.4 + rand() * 0.3)), Math.max(1.3, r - 0.4), depth + 1);
      }
    }
  };

  for (let rz = 0; rz < W / REGION; rz++) {
    for (let rx = 0; rx < W / REGION; rx++) {
      const rand = mulberry32((seed * 31 + rz * 977 + rx * 131 + 0x5eed) | 0);
      if (rand() > 0.62) continue;
      const systems = 1 + (rand() < 0.35 ? 1 : 0);
      for (let s = 0; s < systems; s++) {
        const x = rx * REGION + rand() * REGION;
        const z = rz * REGION + rand() * REGION;
        const surf = surfaceAt(x, z);
        if (surf < 34) continue; // under the sea: skip (no flooded caves)
        const dirx = rand() - 0.5;
        const dirz = rand() - 0.5;
        if (rand() < 0.3) {
          // An entrance tunnel: starts at the surface and dives.
          tunnel(rand, x, surf, z, dirx, -0.55, dirz, 70 + Math.floor(rand() * 70), 1.6 + rand() * 0.8, 0);
        } else {
          const y = 10 + rand() * Math.max(4, surf - 18);
          tunnel(rand, x, y, z, dirx, (rand() - 0.5) * 0.3, dirz, 90 + Math.floor(rand() * 90), 1.5 + rand() * 1.2, 0);
          // a second tunnel the other way from the same point, so systems are not dead ends
          if (rand() < 0.6) tunnel(rand, x, y, z, -dirx, (rand() - 0.5) * 0.3, -dirz, 50 + Math.floor(rand() * 70), 1.4 + rand() * 1.0, 1);
        }
      }
    }
  }
  return stats;
}

interface OreSpec {
  id: number;
  key: string;
  perChunk: number; // veins per 16 x 16 column (fractions are a chance)
  minY: number;
  maxY: number;
  size: [number, number];
}

export const ORES: OreSpec[] = [
  { id: B.COAL_ORE, key: "coal", perChunk: 16, minY: 8, maxY: 80, size: [6, 14] },
  { id: B.IRON_ORE, key: "iron", perChunk: 10, minY: 5, maxY: 54, size: [4, 9] },
  { id: B.GOLD_ORE, key: "gold", perChunk: 2, minY: 4, maxY: 30, size: [3, 8] },
  { id: B.RUBY_ORE, key: "ruby", perChunk: 4, minY: 4, maxY: 22, size: [3, 8] },
  { id: B.DIAMOND_ORE, key: "diamond", perChunk: 0.8, minY: 4, maxY: 16, size: [2, 6] },
];

/** Ore veins (and dirt / gravel pockets) replace stone only. */
export function placeOres(blocks: Uint8Array, seed: number, stats: CaveStats): void {
  const C = 16;
  const pockets: OreSpec[] = [
    { id: B.DIRT, key: "dirt", perChunk: 3, minY: 6, maxY: 70, size: [12, 26] },
    { id: B.GRAVEL, key: "gravel", perChunk: 2, minY: 6, maxY: 70, size: [10, 22] },
  ];
  for (let cz = 0; cz < W / C; cz++) {
    for (let cx = 0; cx < W / C; cx++) {
      const rand = mulberry32((seed * 7919 + cz * 7333 + cx * 3109 + 0x07e5) | 0);
      for (const o of [...pockets, ...ORES]) {
        let veins = Math.floor(o.perChunk);
        if (rand() < o.perChunk - veins) veins++;
        for (let v = 0; v < veins; v++) {
          let x = cx * C + rand() * C;
          let y = o.minY + rand() * (o.maxY - o.minY);
          let z = cz * C + rand() * C;
          const n = o.size[0] + Math.floor(rand() * (o.size[1] - o.size[0] + 1));
          // A short random walk, filling a small cluster around each point.
          for (let k = 0; k < n; k++) {
            const bx = Math.floor(x);
            const by = Math.floor(y);
            const bz = Math.floor(z);
            for (let d = 0; d < 3; d++) {
              const ox = bx + (d === 1 && rand() < 0.5 ? 1 : 0);
              const oy = by + (d === 2 && rand() < 0.5 ? 1 : 0);
              const oz = bz + (d === 0 && rand() < 0.5 ? 1 : 0);
              if (ox < 0 || oz < 0 || ox >= W || oz >= W || oy < o.minY || oy > o.maxY || oy >= WORLD_HEIGHT) continue;
              const i = idx(ox, oy, oz);
              if (blocks[i] !== B.STONE) continue;
              blocks[i] = o.id;
              stats.ores[o.key] = (stats.ores[o.key] ?? 0) + 1;
            }
            x += rand() * 2 - 1;
            y += rand() * 1.4 - 0.7;
            z += rand() * 2 - 1;
          }
        }
      }
    }
  }
}
