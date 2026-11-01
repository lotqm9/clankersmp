// Seeded terrain: a big island (512 x 512 world) with meadows, forested hills, rocky ridges, beaches and lakes,
// oak and birch trees, tall grass and flowers, caves and ores, plus the spawn hub (shared/hub.ts: the safe zone
// with the monument, paths, boards, the starter pavilion, the fountain and gardens; and over it the bigger hub with the
// "punch a tree" landmark: shared/hub12.ts, shared/landmark.ts). Same seed, same
// world, everywhere.

import { B } from "./blocks.ts";
import { SEA_LEVEL, SPAWN_X, SPAWN_Z, VOLUME, WORLD_HEIGHT, WORLD_SIZE, idx } from "./constants.ts";
import { carveCaves, placeOres, type CaveStats } from "./caves.ts";
import { GEM_ROWS, HUB_BLEND, HUB_FLAT, buildHub, type HubInfo } from "./hub.ts";
import { buildHub12, type HubExtra, type HubPlan } from "./hub12.ts";
import { clamp, fbm, hash2, lerp, makeSimplex2D, smoothstep } from "./noise.ts";
import { growTree } from "./trees.ts";
import { buildIslands, type IslandInfo } from "./islands.ts";
import { DEFAULT_VILLAGES, buildVillages, type VillagesInfo } from "./villages.ts";

export interface GenInfo {
  spawn: { x: number; y: number; z: number };
  spawnHeight: number; // y of the plaza surface block
  board: { x0: number; x1: number; y0: number; y1: number; z: number }; // the sign board, in blocks
  caves: CaveStats;
  /** The spawn hub; v10 (update 12): the bigger hub (shared/hub12.ts) with its roads, gates, harbour and kept tiles. */
  hub: HubInfo & Partial<HubExtra>;
  /** v8: the islands in the open sea (shared/islands.ts) and their treasure chests. */
  islands: IslandInfo;
  /** v9: the villages (shared/villages.ts): their houses, villagers and loot chests. */
  villages: VillagesInfo;
}

const W = WORLD_SIZE;

export { GEM_ROWS };

/** `opts.villages`: which village sites to build (the server's choice for its world; default the first four).
 *  `opts.hub` (v10): the server's plan for the bigger hub (the tiles it must leave alone, the villages that get a
 *  road; default: none kept, roads to every village); `false` builds only the old hub (tests compare with it). */
export function generateWorld(seed: number, out?: Uint8Array, opts: { islands?: boolean; villages?: number[]; hub?: HubPlan | false } = {}): { blocks: Uint8Array; info: GenInfo } {
  const blocks = out ?? new Uint8Array(VOLUME);
  blocks.fill(0);

  const nCoast = makeSimplex2D(seed ^ 0x1a2b3c);
  const nHills = makeSimplex2D(seed ^ 0x2b3c4d);
  const nRidge = makeSimplex2D(seed ^ 0x3c4d5e);
  const nMountMask = makeSimplex2D(seed ^ 0x4d5e6f);
  const nDetail = makeSimplex2D(seed ^ 0x5e6f70);
  const nForest = makeSimplex2D(seed ^ 0x6f7081);
  const nBirch = makeSimplex2D(seed ^ 0x708192);
  const nFlower = makeSimplex2D(seed ^ 0x8192a3);
  const nFloor = makeSimplex2D(seed ^ 0x92a3b4);
  const nMeadow = makeSimplex2D(seed ^ 0xa3b4c5);
  const nLake = makeSimplex2D(seed ^ 0xb4c5d6);

  /** 1 in flat meadows (plains-like, few trees), 0 in rolling hills. */
  const meadow = (x: number, z: number): number => smoothstep(-0.15, 0.35, fbm(nMeadow, x / 120, z / 120, 2));

  const landHeight = (x: number, z: number): number => {
    const m = meadow(x, z);
    const hills = fbm(nHills, x / 95, z / 95, 3);
    const detail = nDetail(x / 16, z / 16) * 0.5 * (1 - m * 0.8);
    let h = 45.5 + hills * lerp(11, 2.2, m) + detail;
    // Mountain ranges: ridged noise inside a low-frequency mask, kept away from the spawn meadow.
    const sx = x - SPAWN_X;
    const sz = z - SPAWN_Z;
    const away = smoothstep(80, 135, Math.sqrt(sx * sx + sz * sz));
    const mm = smoothstep(0.0, 0.42, fbm(nMountMask, x / 170, z / 170, 2)) * (1 - m * 0.7) * away;
    const r = 1 - Math.abs(fbm(nRidge, x / 62, z / 62, 4));
    h += mm * (r * r * 46 + 6);
    // Inland lakes: bowls whose middle sits well under sea level, so they fill with water.
    const lake = smoothstep(0.38, 0.6, fbm(nLake, x / 95, z / 95, 2)) * (1 - mm) * smoothstep(72, 100, Math.sqrt(sx * sx + sz * sz));
    h = lerp(h, SEA_LEVEL - 7, lake);
    return h;
  };

  const spawnHeight = clamp(Math.floor(landHeight(SPAWN_X, SPAWN_Z)), SEA_LEVEL + 5, SEA_LEVEL + 12);

  const height = new Int16Array(W * W);
  const landMask = new Float32Array(W * W);
  const surface = new Uint8Array(W * W); // 1 grass, 2 sand, 3 stone, 4 underwater floor

  // Pass 1: column heights. The island fills most of the world, with a ragged coast and bays.
  for (let z = 0; z < W; z++) {
    for (let x = 0; x < W; x++) {
      const cx = x + 0.5 - SPAWN_X;
      const cz = z + 0.5 - SPAWN_Z;
      const r = Math.sqrt(cx * cx + cz * cz);
      // Domain-warped distance: a big, irregular island with headlands and bays rather than a disc.
      const wx = cx + fbm(nCoast, x / 130 + 7, z / 130, 2) * 46;
      const wz = cz + fbm(nCoast, x / 130, z / 130 + 7, 2) * 46;
      const d = Math.sqrt(wx * wx + wz * wz) / (W / 2);
      const coast = fbm(nCoast, x / 160, z / 160, 2) * 0.22 + fbm(nCoast, x / 48 + 3, z / 48, 2) * 0.08;
      const land = smoothstep(0.95, 0.74, d + coast);
      const ocean = 29 + fbm(nFloor, x / 40, z / 40, 2) * 3;
      let h = lerp(ocean, landHeight(x, z), land);
      h = lerp(spawnHeight + 0.5, h, smoothstep(HUB_FLAT, HUB_BLEND, r));
      height[z * W + x] = clamp(Math.floor(h), 4, WORLD_HEIGHT - 20);
      landMask[z * W + x] = land;
    }
  }

  // Pass 2: surface kind. Beaches along the coast, sandy shores around inland lakes, bare rock up high.
  for (let z = 0; z < W; z++) {
    for (let x = 0; x < W; x++) {
      const hi = height[z * W + x];
      let kind = 1;
      if (hi < SEA_LEVEL) kind = 4;
      else if (hi <= SEA_LEVEL + 1 && landMask[z * W + x] < 0.985) kind = 2;
      else if (hi <= SEA_LEVEL + 2) {
        for (let dz = -2; dz <= 2 && kind === 1; dz++)
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx;
            const zz = z + dz;
            if (xx < 0 || zz < 0 || xx >= W || zz >= W) continue;
            if (height[zz * W + xx] < SEA_LEVEL) {
              kind = 2;
              break;
            }
          }
      } else if (hi > 78 + nDetail(x / 9 + 100, z / 9) * 4) kind = 3;
      surface[z * W + x] = kind;
    }
  }

  // Pass 3: fill columns.
  for (let z = 0; z < W; z++) {
    for (let x = 0; x < W; x++) {
      const hi = height[z * W + x];
      const kind = surface[z * W + x];
      // Bedrock floor with a ragged top.
      blocks[idx(x, 0, z)] = B.BEDROCK;
      if (hash2(x, z, seed + 11) < 0.5) blocks[idx(x, 1, z)] = B.BEDROCK;
      if (hash2(x, z, seed + 12) < 0.2) blocks[idx(x, 2, z)] = B.BEDROCK;

      for (let y = 1; y <= hi; y++) {
        const i = idx(x, y, z);
        if (blocks[i] !== 0) continue;
        const depth = hi - y;
        let id: number = B.STONE;
        if (kind === 1) {
          if (depth === 0) id = B.GRASS;
          else if (depth <= 3) id = B.DIRT;
        } else if (kind === 2) {
          if (depth <= 3) id = B.SAND;
        } else if (kind === 3) {
          if (depth === 0 && hash2(x, z, seed + 13) < 0.08) id = B.GRAVEL;
        } else if (depth <= 2) {
          const f = nFloor(x / 13 + 50, z / 13);
          id = f > 0.45 ? B.GRAVEL : f < -0.55 ? B.DIRT : B.SAND;
        }
        blocks[i] = id;
      }
      for (let y = hi + 1; y < SEA_LEVEL; y++) blocks[idx(x, y, z)] = B.WATER;
    }
  }

  // Underground: caves (a few open onto hillsides), then dirt/gravel pockets and ore veins in the stone.
  const caves = carveCaves(blocks, height, seed);
  placeOres(blocks, seed, caves);

  // Trees: one candidate per 5x5 cell, density from a forest noise.
  const CELL = 5;
  for (let gz = 0; gz < W / CELL; gz++) {
    for (let gx = 0; gx < W / CELL; gx++) {
      const x = gx * CELL + Math.floor(hash2(gx, gz, seed + 21) * CELL);
      const z = gz * CELL + Math.floor(hash2(gx, gz, seed + 22) * CELL);
      if (x < 4 || z < 4 || x >= W - 4 || z >= W - 4) continue;
      const cx = x + 0.5 - SPAWN_X;
      const cz = z + 0.5 - SPAWN_Z;
      if (cx * cx + cz * cz < 52 * 52) continue; // the hub plants its own
      if (surface[z * W + x] !== 1) continue;
      const h = height[z * W + x];
      if (h < SEA_LEVEL + 2 || h > 76) continue;
      if (blocks[idx(x, h, z)] !== B.GRASS) continue; // a cave opened the ground here
      const forest = fbm(nForest, x / 64, z / 64, 2);
      const density = (0.035 + smoothstep(-0.25, 0.55, forest) * 0.8) * (1 - 0.85 * meadow(x, z));
      if (hash2(x, z, seed + 23) > density) continue;
      const birch = nBirch(x / 52, z / 52) > 0.3 || hash2(x, z, seed + 24) < 0.08;
      growTree(blocks, x, h + 1, z, birch, seed);
    }
  }

  // Ground cover: tall grass and flower patches.
  for (let z = 1; z < W - 1; z++) {
    for (let x = 1; x < W - 1; x++) {
      if (surface[z * W + x] !== 1) continue;
      const h = height[z * W + x];
      if (h + 1 >= WORLD_HEIGHT) continue;
      if (blocks[idx(x, h, z)] !== B.GRASS || blocks[idx(x, h + 1, z)] !== 0) continue;
      const cx = x + 0.5 - SPAWN_X;
      const cz = z + 0.5 - SPAWN_Z;
      if (cx * cx + cz * cz < HUB_FLAT * HUB_FLAT) continue; // the hub does its own
      const r = hash2(x, z, seed + 31);
      const patch = nFlower(x / 18, z / 18);
      if (patch > 0.5 && r < 0.14) {
        blocks[idx(x, h + 1, z)] = hash2(x, z, seed + 32) < 0.55 ? B.DANDELION : B.POPPY;
      } else if (r < 0.1 + smoothstep(0.2, 0.8, patch) * 0.1) {
        blocks[idx(x, h + 1, z)] = B.TALL_GRASS;
      }
    }
  }

  // v7: sugar cane by the water, in patches: on grass, dirt or sand right beside water at the water's own level.
  // (Only ever into empty air, so a live world's edits still sit on top of it cell by cell: no reset needed.)
  for (let z = 1; z < W - 1; z++) {
    for (let x = 1; x < W - 1; x++) {
      const h = height[z * W + x];
      if (h !== SEA_LEVEL - 1 || h + 4 >= WORLD_HEIGHT) continue;
      const ground = blocks[idx(x, h, z)];
      if (ground !== B.GRASS && ground !== B.DIRT && ground !== B.SAND) continue;
      if (blocks[idx(x, h + 1, z)] !== 0) continue;
      const wet = blocks[idx(x + 1, h, z)] === B.WATER || blocks[idx(x - 1, h, z)] === B.WATER || blocks[idx(x, h, z + 1)] === B.WATER || blocks[idx(x, h, z - 1)] === B.WATER;
      if (!wet) continue;
      const cx = x + 0.5 - SPAWN_X;
      const cz = z + 0.5 - SPAWN_Z;
      if (cx * cx + cz * cz < HUB_FLAT * HUB_FLAT) continue;
      if (hash2(x >> 3, z >> 3, seed + 41) > 0.3 || hash2(x, z, seed + 42) > 0.5) continue;
      const tall = 1 + Math.floor(hash2(x, z, seed + 43) * 3);
      for (let k = 1; k <= tall; k++) {
        if (blocks[idx(x, h + k, z)] !== 0) break;
        blocks[idx(x, h + k, z)] = B.SUGAR_CANE;
      }
    }
  }

  const oldHub = buildHub(blocks, spawnHeight, seed);
  // v8: the islands, stamped last and only into open ocean, so nothing above changes (no reset of a live world)
  const islands = opts.islands === false ? { list: [], chests: [], changed: 0 } : buildIslands(blocks, seed);
  // v9: the villages, last, and only on land with no edits (the server picks them: shared/villages.ts)
  const villages = buildVillages(blocks, seed, opts.villages ?? DEFAULT_VILLAGES);
  // The old hub's spawn: the south edge of its plaza, facing north to the sign and its diamond.
  let spawn = { x: SPAWN_X + 0.5, y: spawnHeight + 1, z: SPAWN_Z + 7.5 };
  let board = { x0: SPAWN_X - 4, x1: SPAWN_X + 4, y0: spawnHeight + 3, y1: spawnHeight + 6, z: SPAWN_Z - 7 };
  let hub: GenInfo["hub"] = oldHub;
  // v10 (update 12): the bigger hub over the old one, last of all (it leaves the server's kept tiles as they are)
  if (opts.hub !== false) {
    const plan = opts.hub ?? { keep: [], roads: villages.list.map((v) => v.site) };
    const h = buildHub12(blocks, spawnHeight, seed, plan, villages.list, oldHub, spawn, board);
    hub = h.hub;
    spawn = h.spawn;
    board = h.board;
  }

  return {
    blocks,
    info: {
      // v10: spawn in the arrival courtyard south of the plaza, facing north to the landmark and the Beacon
      spawn,
      spawnHeight,
      board,
      caves,
      hub,
      islands,
      villages,
    },
  };
}

/** Fast 32-bit hash of the whole block array, used to confirm client and server terrain match. */
export function hashBlocks(blocks: Uint8Array): number {
  const words = new Uint32Array(blocks.buffer, blocks.byteOffset, blocks.byteLength >>> 2);
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < words.length; i++) {
    h = Math.imul(h ^ words[i], 0x01000193);
    h ^= h >>> 13;
  }
  return h >>> 0;
}
