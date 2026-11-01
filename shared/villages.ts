// Villages (update 11, protocol v9): up to four villages on the main island, away from the spawn hub. Each one is a
// 49 x 49 square levelled to one height (blended into the land around it over 8 blocks), with:
//   - a plaza in the middle: a stone well with a little roof, the village chime and lamp posts
//   - two crossing dirt-path roads out to the edges, lamp posts at their ends
//   - five houses of our own design along the roads, one per job, each with a door, glass windows, a bed and a chest,
//     and its job's things: the farmer's cottage (cream terracotta, a brick roof), the smithy (stone bricks, two
//     furnaces, a chimney), the library (birch, bookshelves), the fisher's hut (planks and a blue band, barrels) and
//     the mason's house (bricks, a slate floor); crafting tables and furnaces among them
//   - two wheat farms (moist farmland round a water channel, the wheat growing, a log border, lanterns), trees and
//     flower pots in the spare lots
// Some houses' chests (the farmer's and the smith's) are loot chests, filled once per world.
//
// No world reset: a village is stamped only where the world has no edits at all (the server decides once per world,
// server/src/shard.ts, and keeps the choice in villages.json; the client builds the villages the server names in its
// welcome). Stamped as the very last worldgen step. Deterministic like the rest: integer hashes, + - * / floor only.

import { B, IS_WATER } from "./blocks.ts";
import { SEA_LEVEL, SPAWN_X, SPAWN_Z, WORLD_HEIGHT, WORLD_SIZE, idx } from "./constants.ts";
import { doorId } from "./shapes.ts";
import { hash2 } from "./noise.ts";
import { growTree } from "./trees.ts";
import { JOBS, VILLAGER_NAMES } from "./villagers.ts";

export interface VillageSite {
  key: string;
  name: string;
  x: number; // plaza centre
  z: number;
}

// The first five (update 11), picked by .local/pa/village-sites.ts: the flattest dry land 118+ blocks from spawn,
// 95+ apart. A world first takes the first four of these with no edits in their square.
// Then (update 11.1) more sites for worlds whose players had already built on those: .local/pa/village-sites2.ts,
// land that levels (a height range of 20 at most, a pond at most) all over the main island, the eased square clear of
// the bigger hub. They may overlap each other and the first five: a world only ever builds villages whose squares
// don't overlap (chooseVillages). Never reorder or remove a site: a world keeps its villages by index.
export const VILLAGE_SITES: VillageSite[] = [
  { key: "larkholm", name: "Larkholm", x: 416, z: 328 },
  { key: "thistle_end", name: "Thistle End", x: 364, z: 204 },
  { key: "mossford", name: "Mossford", x: 148, z: 304 },
  { key: "pennywhistle", name: "Pennywhistle", x: 280, z: 140 },
  { key: "honeybrook", name: "Honeybrook", x: 236, z: 380 },
  // update 11.1
  { key: "bramblewick", name: "Bramblewick", x: 436, z: 300 },
  { key: "fernhollow", name: "Fernhollow", x: 356, z: 96 },
  { key: "oakmere", name: "Oakmere", x: 376, z: 120 },
  { key: "starling_green", name: "Starling Green", x: 448, z: 272 },
  { key: "cobblecombe", name: "Cobblecombe", x: 264, z: 68 },
  { key: "wrenfield", name: "Wrenfield", x: 372, z: 292 },
  { key: "millbrook", name: "Millbrook", x: 392, z: 160 },
  { key: "hearthstone", name: "Hearthstone", x: 264, z: 380 },
  { key: "larchford", name: "Larchford", x: 404, z: 300 },
  { key: "copperfield", name: "Copperfield", x: 288, z: 96 },
  { key: "willowmere", name: "Willowmere", x: 112, z: 340 },
  { key: "foxglove", name: "Foxglove", x: 444, z: 332 },
  { key: "rookwood", name: "Rookwood", x: 392, z: 196 },
  { key: "dovecote", name: "Dovecote", x: 348, z: 64 },
  { key: "sorrelby", name: "Sorrelby", x: 372, z: 232 },
  { key: "saltmarsh", name: "Saltmarsh", x: 404, z: 388 },
  { key: "ashby_green", name: "Ashby Green", x: 308, z: 120 },
  { key: "marlow_end", name: "Marlow End", x: 336, z: 392 },
  { key: "pebblebrook", name: "Pebblebrook", x: 144, z: 412 },
  { key: "tansy_hill", name: "Tansy Hill", x: 252, z: 140 },
  { key: "kestrel_rise", name: "Kestrel Rise", x: 260, z: 108 },
  { key: "hawthorn_reach", name: "Hawthorn Reach", x: 64, z: 168 },
  { key: "bellwether", name: "Bellwether", x: 108, z: 200 },
  { key: "juniper_cross", name: "Juniper Cross", x: 140, z: 224 },
];
/** How many of the sites are the first ones (update 11's own choice: the first four of these with no edits). */
export const FIRST_SITES = 5;
export const MAX_VILLAGES = 4;
export const VILLAGE_R = 24; // the levelled square: centre +- 24
export const VILLAGE_BLEND = 8; // and the land eased back to its own height over 8 more
/** Any edit in this square (centre +- VILLAGE_CHECK, every height) keeps a village away. */
export const VILLAGE_CHECK = VILLAGE_R + VILLAGE_BLEND + 4;
/** The worlds made before villages existed, or a fresh one: the first four sites. */
export const DEFAULT_VILLAGES = [0, 1, 2, 3];

export interface HouseInfo {
  job: number;
  door: [number, number, number]; // the door's lower cell
  inside: [number, number, number]; // where its villager stands at night (feet cell)
  work: [number, number, number]; // where it stands by day, outside the door
  bed: [number, number, number]; // the foot of the bed
}

export interface VillagerDef {
  id: number;
  job: number;
  name: string;
  village: number; // site index
  home: [number, number, number];
  work: [number, number, number];
}

export interface VillageInfo {
  site: number;
  key: string;
  name: string;
  x: number;
  z: number;
  y: number; // the plaza's ground level (floors are at this y, you stand at y + 1)
  houses: HouseInfo[];
  villagers: VillagerDef[];
  chests: { x: number; y: number; z: number; kind: string }[]; // loot chests (kind: the job whose house it is in)
  chime: [number, number, number];
}

export interface VillagesInfo {
  list: VillageInfo[];
  chests: { x: number; y: number; z: number; village: number; kind: string }[];
  changed: number;
}

/** The square a village keeps free of edits (inclusive). */
export function villageBox(site: number): { x0: number; z0: number; x1: number; z1: number } {
  const s = VILLAGE_SITES[site];
  return { x0: s.x - VILLAGE_CHECK, z0: s.z - VILLAGE_CHECK, x1: s.x + VILLAGE_CHECK, z1: s.z + VILLAGE_CHECK };
}

/** Do two sites' squares overlap (then only one of them can ever be a village in a world)? */
export function sitesOverlap(a: number, b: number): boolean {
  const p = VILLAGE_SITES[a];
  const q = VILLAGE_SITES[b];
  return Math.abs(p.x - q.x) <= 2 * VILLAGE_CHECK && Math.abs(p.z - q.z) <= 2 * VILLAGE_CHECK;
}

/** The villages a world gets. `edited(site)`: does that site's square hold any edit? `decided`: the villages the
 *  world already has (never changed: they are kept exactly as they are).
 *  - A world deciding for the first time (update 11's rule) takes the first four of the first five sites with no
 *    edits.
 *  - Then (update 11.1), while it has fewer than four, it adds the site with no edits whose square overlaps none of
 *    its villages and lies farthest from them (the villages spread out over the island; ties: the earlier site). */
export function chooseVillages(edited: (site: number) => boolean, decided?: number[]): number[] {
  const out: number[] = decided ? [...decided] : [];
  if (!decided) for (let i = 0; i < FIRST_SITES && out.length < MAX_VILLAGES; i++) if (!edited(i)) out.push(i);
  while (out.length < MAX_VILLAGES) {
    let best = -1;
    let far = -1;
    for (let i = 0; i < VILLAGE_SITES.length; i++) {
      if (out.includes(i) || out.some((k) => sitesOverlap(i, k)) || edited(i)) continue;
      const s = VILLAGE_SITES[i];
      const d = out.length ? Math.min(...out.map((k) => Math.hypot(VILLAGE_SITES[k].x - s.x, VILLAGE_SITES[k].z - s.z))) : 0;
      if (d > far) {
        far = d;
        best = i;
      }
    }
    if (best < 0) break;
    out.push(best);
  }
  return out;
}

/** A villager's id: stable per site and house (1 + site * 8 + house). */
export const villagerId = (site: number, house: number) => 1 + site * 8 + house;

const PLANT = new Set<number>([B.TALL_GRASS, B.DANDELION, B.POPPY, B.BLUEBELL, B.SUGAR_CANE]);
const TREE = new Set<number>([B.OAK_LOG, B.OAK_LEAVES, B.BIRCH_LOG, B.BIRCH_LEAVES, B.PALM_LOG, B.PALM_LEAVES]);

/** The ground under a column: the highest solid-ground block (not plants, not trees), and whether it is water. */
function ground(blocks: Uint8Array, x: number, z: number): { y: number; water: boolean } {
  for (let y = WORLD_HEIGHT - 1; y > 0; y--) {
    const id = blocks[idx(x, y, z)];
    if (id === B.AIR || PLANT.has(id) || TREE.has(id)) continue;
    return { y, water: IS_WATER[id] === 1 };
  }
  return { y: 0, water: false };
}

/** A house's own frame: u along its front, v from the front wall in; world facings of +u and +v. */
interface Frame {
  ox: number;
  oz: number;
  ux: number;
  uz: number;
  vx: number;
  vz: number;
  fu: number;
  fv: number;
}

type HouseKind = "cottage" | "smithy" | "library" | "hut" | "mason";
const KIND_OF_JOB: HouseKind[] = ["cottage", "smithy", "library", "hut", "mason"];

export function buildVillages(blocks: Uint8Array, seed: number, active: number[]): VillagesInfo {
  const out: VillagesInfo = { list: [], chests: [], changed: 0 };
  const sites = [...new Set(active)].filter((i) => Number.isInteger(i) && i >= 0 && i < VILLAGE_SITES.length).sort((a, b) => a - b);
  const built: number[] = [];
  for (const i of sites) {
    if (built.some((k) => sitesOverlap(i, k))) continue; // (never two villages on the same ground)
    built.push(i);
    const v = buildVillage(blocks, seed, i, out);
    out.list.push(v);
    for (const c of v.chests) out.chests.push({ ...c, village: i });
  }
  return out;
}

function buildVillage(blocks: Uint8Array, seed: number, site: number, out: VillagesInfo): VillageInfo {
  const S = VILLAGE_SITES[site];
  const cx = S.x;
  const cz = S.z;
  const salt = seed + 9100 + site * 131;
  const set = (x: number, y: number, z: number, id: number) => {
    if (x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE || y < 1 || y >= WORLD_HEIGHT) return;
    const i = idx(x, y, z);
    if (blocks[i] !== id) {
      blocks[i] = id;
      out.changed++;
    }
  };
  const get = (x: number, y: number, z: number) => blocks[idx(x, y, z)];

  // ---- the level: the median ground height around the plaza
  const hs: number[] = [];
  for (let dz = -10; dz <= 10; dz += 2) for (let dx = -10; dx <= 10; dx += 2) hs.push(ground(blocks, cx + dx, cz + dz).y);
  hs.sort((a, b) => a - b);
  const H = Math.max(SEA_LEVEL + 2, Math.min(WORLD_HEIGHT - 30, hs[Math.floor(hs.length / 2)]));

  // ---- trees out of the square (and a little beyond, so no canopy hangs over the houses)
  const RT = VILLAGE_R + VILLAGE_BLEND + 3;
  for (let dz = -RT; dz <= RT; dz++)
    for (let dx = -RT; dx <= RT; dx++)
      for (let y = SEA_LEVEL - 2; y < WORLD_HEIGHT; y++) {
        const id = get(cx + dx, y, cz + dz);
        if (TREE.has(id)) set(cx + dx, y, cz + dz, B.AIR);
      }

  // ---- level the square, ease the ring back to the land's own height
  const RB = VILLAGE_R + VILLAGE_BLEND;
  for (let dz = -RB; dz <= RB; dz++)
    for (let dx = -RB; dx <= RB; dx++) {
      const x = cx + dx;
      const z = cz + dz;
      const g = ground(blocks, x, z);
      const d = Math.max(Math.abs(dx), Math.abs(dz));
      if (d > VILLAGE_R && g.water) continue; // lakes and the sea stay as they are
      let target = H;
      if (d > VILLAGE_R) {
        const t = (d - VILLAGE_R) / VILLAGE_BLEND;
        const k = t * t * (3 - 2 * t);
        target = Math.floor(H + (g.y - H) * k + 0.5);
      }
      if (target === g.y && !g.water && d > VILLAGE_R) {
        continue; // already at its height
      }
      // clear above, fill below
      for (let y = target + 1; y < WORLD_HEIGHT; y++) if (get(x, y, z) !== B.AIR) set(x, y, z, B.AIR);
      for (let y = Math.min(g.y + 1, target); y < target; y++) set(x, y, z, B.DIRT);
      if (g.water) for (let y = target - 1; y > SEA_LEVEL - 8 && IS_WATER[get(x, y, z)]; y--) set(x, y, z, B.DIRT);
      set(x, target, z, B.GRASS);
      if (g.y > target) {
        set(x, target - 1, z, B.DIRT);
        set(x, target - 2, z, B.DIRT);
      }
    }

  const at = (dx: number, dy: number, dz: number, id: number) => set(cx + dx, H + dy, cz + dz, id);

  // ---- roads: two crossing dirt paths, three wide, to the square's edges
  for (let k = -VILLAGE_R; k <= VILLAGE_R; k++)
    for (let w = -1; w <= 1; w++) {
      at(w, 0, k, B.DIRT_PATH);
      at(k, 0, w, B.DIRT_PATH);
    }
  // ---- the plaza: stone and cobbles, a well with a roof, the chime, lamp posts
  for (let dz = -5; dz <= 5; dz++)
    for (let dx = -5; dx <= 5; dx++) {
      const r = hash2(cx + dx, cz + dz, salt + 1);
      const ring = Math.max(Math.abs(dx), Math.abs(dz));
      at(dx, 0, dz, ring === 5 ? B.STONE_BRICKS : r < 0.45 ? B.COBBLESTONE : r < 0.8 ? B.STONE_BRICKS : r < 0.9 ? B.MOSSY_COBBLE : B.DIRT_PATH);
    }
  for (let dz = -2; dz <= 2; dz++)
    for (let dx = -2; dx <= 2; dx++) {
      const edge = Math.abs(dx) === 2 || Math.abs(dz) === 2;
      if (edge) {
        at(dx, 0, dz, B.COBBLESTONE);
        at(dx, 1, dz, Math.abs(dx) === 2 && Math.abs(dz) === 2 ? B.COBBLESTONE : B.COBBLE_WALL);
      } else {
        at(dx, -3, dz, B.COBBLESTONE);
        for (let y = -2; y <= 0; y++) at(dx, y, dz, B.WATER);
      }
    }
  for (const [dx, dz] of [
    [-2, -2],
    [2, -2],
    [-2, 2],
    [2, 2],
  ]) {
    at(dx, 2, dz, B.OAK_FENCE);
    at(dx, 3, dz, B.OAK_FENCE);
  }
  for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) at(dx, 4, dz, B.OAK_SLAB);
  at(0, 5, 0, B.OAK_SLAB);
  const chime: [number, number, number] = [cx + 4, H + 1, cz - 4];
  at(4, 1, -4, B.VILLAGE_CHIME);
  const lamp = (dx: number, dz: number) => {
    at(dx, 1, dz, B.OAK_FENCE);
    at(dx, 2, dz, B.OAK_FENCE);
    at(dx, 3, dz, B.LANTERN);
  };
  for (const [dx, dz] of [
    [-5, -5],
    [5, -5],
    [-5, 5],
    [5, 5],
  ])
    lamp(dx, dz);
  lamp(2, -VILLAGE_R + 2);
  lamp(-2, VILLAGE_R - 2);
  lamp(VILLAGE_R - 2, 2);
  lamp(-VILLAGE_R + 2, -2);

  // ---- the lots: in each quarter, a house by each road and a farm (or a tree) in the far corner
  const quarters: [number, number][] = [
    [1, -1],
    [1, 1],
    [-1, 1],
    [-1, -1],
  ];
  const slots: Frame[] = [];
  for (const [sx, sz] of quarters) {
    // by the north-south road: the front faces it, u runs away from the plaza
    slots.push({ ox: cx + 3 * sx, oz: cz + 12 * sz, ux: 0, uz: sz, vx: sx, vz: 0, fu: sz > 0 ? 2 : 0, fv: sx > 0 ? 1 : 3 });
    // by the east-west road
    slots.push({ ox: cx + 12 * sx, oz: cz + 3 * sz, ux: sx, uz: 0, vx: 0, vz: sz, fu: sx > 0 ? 1 : 3, fv: sz > 0 ? 2 : 0 });
  }
  // which slots get houses: five of the eight, turned per village
  const turn = Math.floor(hash2(site, 7, salt) * 8);
  const order = [0, 3, 4, 7, 1, 2, 5, 6].map((k) => (k + turn) % 8);
  const houses: HouseInfo[] = [];
  const chests: { x: number; y: number; z: number; kind: string }[] = [];
  const used = new Set<number>();
  for (let j = 0; j < JOBS.length; j++) {
    const slot = order[j];
    used.add(slot);
    const h = buildHouse(KIND_OF_JOB[j], j, slots[slot], H, set, get, hash2(site, j, salt + 5));
    houses.push(h.info);
    if (h.loot) chests.push({ ...h.loot, kind: JOBS[j].key });
  }
  // spare slots: a tree and flowers
  for (let k = 0; k < 8; k++) {
    if (used.has(k)) continue;
    const f = slots[k];
    const wx = (u: number, v: number) => f.ox + u * f.ux + v * f.vx;
    const wz = (u: number, v: number) => f.oz + u * f.uz + v * f.vz;
    growTree(blocks, wx(4, 4), H + 1, wz(4, 4), hash2(k, site, salt + 11) < 0.4, seed + site);
    out.changed += 20;
    for (let n = 0; n < 6; n++) {
      const u = 1 + Math.floor(hash2(k, n, salt + 12) * 7);
      const v = 1 + Math.floor(hash2(n, k, salt + 13) * 7);
      if (Math.abs(u - 4) <= 1 && Math.abs(v - 4) <= 1) continue;
      const fl = [B.POPPY, B.DANDELION, B.BLUEBELL, B.TALL_GRASS][Math.floor(hash2(u, v, salt + 14) * 4)];
      if (get(wx(u, v), H + 1, wz(u, v)) === B.AIR) set(wx(u, v), H + 1, wz(u, v), fl);
    }
  }
  // the far corners: two farms, two trees
  const farmAt = Math.floor(hash2(site, 3, salt + 20) * 4);
  for (let q = 0; q < 4; q++) {
    const [sx, sz] = quarters[q];
    if (q === farmAt || q === (farmAt + 2) % 4) buildFarm(cx, cz, sx, sz, H, set, salt + q);
    else {
      growTree(blocks, cx + 17 * sx, H + 1, cz + 17 * sz, hash2(q, site, salt + 21) < 0.5, seed + site + q);
      out.changed += 20;
      set(cx + 15 * sx, H + 1, cz + 19 * sz, B.HAY_BALE);
      set(cx + 19 * sx, H + 1, cz + 15 * sz, B.FLOWER_POT + 1 + Math.floor(hash2(q, 1, salt) * 3));
    }
  }

  const villagers: VillagerDef[] = [];
  const names = new Set<number>();
  houses.forEach((h, k) => {
    let n = Math.floor(hash2(site, k, salt + 30) * VILLAGER_NAMES.length);
    while (names.has(n)) n = (n + 1) % VILLAGER_NAMES.length;
    names.add(n);
    villagers.push({ id: villagerId(site, k), job: h.job, name: VILLAGER_NAMES[n], village: site, home: h.inside, work: h.work });
  });
  return { site, key: S.key, name: S.name, x: cx, z: cz, y: H, houses, villagers, chests, chime };
}

type SetFn = (x: number, y: number, z: number, id: number) => void;
type GetFn = (x: number, y: number, z: number) => number;

function buildFarm(cx: number, cz: number, sx: number, sz: number, H: number, set: SetFn, salt: number): void {
  // a 9 x 9 plot (13..21 out from the plaza) with a water channel across its middle, in a log border
  for (let a = 12; a <= 22; a++)
    for (let b = 12; b <= 22; b++) {
      const x = cx + a * sx;
      const z = cz + b * sz;
      const border = a === 12 || a === 22 || b === 12 || b === 22;
      if (border) {
        set(x, H, z, B.OAK_LOG);
        continue;
      }
      if (b === 17) {
        set(x, H, z, B.WATER);
        set(x, H - 1, z, B.DIRT);
        continue;
      }
      set(x, H, z, B.FARMLAND + 1); // moist: the channel is within 4
      set(x, H - 1, z, B.DIRT);
      const stage = 3 + Math.floor(hash2(x, z, salt) * 5);
      set(x, H + 1, z, B.WHEAT + stage);
    }
  // lanterns on posts at two corners, a hay bale by the gate side
  for (const [a, b] of [
    [12, 12],
    [22, 22],
  ]) {
    set(cx + a * sx, H + 1, cz + b * sz, B.OAK_FENCE);
    set(cx + a * sx, H + 2, cz + b * sz, B.LANTERN);
  }
  set(cx + 23 * sx, H + 1, cz + 14 * sz, B.HAY_BALE);
  set(cx + 23 * sx, H + 1, cz + 15 * sz, B.HAY_BALE);
  set(cx + 23 * sx, H + 2, cz + 14 * sz, B.HAY_BALE);
}

interface Palette {
  W: number;
  D: number;
  wall: number;
  corner: number;
  floor: number;
  stairs: number; // the roof's stair block (base id)
  ridge: number;
  band?: number; // a coloured band at the top of the walls
}

const PALETTES: Record<HouseKind, Palette> = {
  cottage: { W: 7, D: 7, wall: B.TERRACOTTA + 1, corner: B.OAK_LOG, floor: B.OAK_PLANKS, stairs: B.BRICK_STAIRS, ridge: B.BRICKS },
  smithy: { W: 9, D: 7, wall: B.STONE_BRICKS, corner: B.COBBLESTONE, floor: B.COBBLESTONE, stairs: B.COBBLE_STAIRS, ridge: B.COBBLESTONE },
  library: { W: 7, D: 9, wall: B.BIRCH_PLANKS, corner: B.OAK_LOG, floor: B.OAK_PLANKS, stairs: B.OAK_STAIRS, ridge: B.OAK_PLANKS },
  hut: { W: 7, D: 7, wall: B.OAK_PLANKS, corner: B.BIRCH_LOG, floor: B.BIRCH_PLANKS, stairs: B.BIRCH_STAIRS, ridge: B.BIRCH_PLANKS, band: B.WOOL_LIGHT_BLUE },
  mason: { W: 7, D: 7, wall: B.BRICKS, corner: B.STONE_BRICKS, floor: B.TERRACOTTA + 4, stairs: B.STONE_BRICK_STAIRS, ridge: B.STONE_BRICKS },
};

/** One house in a frame: walls, windows, door, roof, furniture. Returns its info and its loot chest (if any). */
function buildHouse(kind: HouseKind, job: number, f: Frame, H: number, set: SetFn, get: GetFn, r: number): { info: HouseInfo; loot: { x: number; y: number; z: number } | null } {
  const P = PALETTES[kind];
  const { W, D } = P;
  const mid = (W - 1) / 2;
  const wx = (u: number, v: number) => f.ox + u * f.ux + v * f.vx;
  const wz = (u: number, v: number) => f.oz + u * f.uz + v * f.vz;
  const put = (u: number, dy: number, v: number, id: number) => set(wx(u, v), H + dy, wz(u, v), id);
  const IN = f.fv;
  const OUT = (f.fv + 2) % 4;
  const RIGHT = f.fu;
  const LEFT = (f.fu + 2) % 4;
  void get;
  // clear the space, a cobble footing under the walls, the floor inside
  for (let u = -1; u <= W; u++) for (let v = -1; v <= D; v++) for (let dy = 1; dy <= 6 + W / 2; dy++) put(u, dy, v, B.AIR);
  for (let u = 0; u < W; u++)
    for (let v = 0; v < D; v++) {
      const ring = u === 0 || v === 0 || u === W - 1 || v === D - 1;
      put(u, 0, v, ring ? B.COBBLESTONE : P.floor);
      put(u, -1, v, B.DIRT);
    }
  // walls with log (or stone) corners
  for (let u = 0; u < W; u++)
    for (let v = 0; v < D; v++) {
      if (!(u === 0 || v === 0 || u === W - 1 || v === D - 1)) continue;
      const corner = (u === 0 || u === W - 1) && (v === 0 || v === D - 1);
      for (let dy = 1; dy <= 3; dy++) put(u, dy, v, corner ? P.corner : dy === 3 && P.band ? P.band : P.wall);
    }
  // windows: either side of the door, in the side walls, in the back wall
  const pane = (u: number, v: number) => put(u, 2, v, B.GLASS_PANE);
  pane(1, 0);
  pane(W - 2, 0);
  for (let v = 2; v < D - 1; v += D > 7 ? 3 : 2) {
    pane(0, v);
    pane(W - 1, v);
  }
  pane(mid, D - 1);
  // the door, and the path to it
  put(mid, 1, 0, doorId(IN, false, false));
  put(mid, 2, 0, doorId(IN, false, true));
  put(mid, 0, -1, B.DIRT_PATH);
  // a gable roof, its ridge running front to back, with eaves all round
  const roofY = (u: number) => (u < 0 || u >= W ? 4 : 5 + Math.min(u, W - 1 - u));
  for (let u = -1; u <= W; u++)
    for (let v = -1; v <= D; v++) {
      if (u === mid) put(u, roofY(u), v, P.ridge);
      else put(u, roofY(u), v, P.stairs + (u < mid ? RIGHT : LEFT));
    }
  // the gables: wall up to the roof, front and back, a little window in the front one
  for (let u = 0; u < W; u++) for (const v of [0, D - 1]) for (let dy = 4; dy < roofY(u); dy++) put(u, dy, v, P.wall);
  put(mid, 5, 0, B.GLASS_PANE);
  // a hanging lantern under the ridge
  put(mid, roofY(mid) - 1, Math.floor(D / 2), B.LANTERN + 1);
  // flower pots either side of the path
  put(mid - 2, 1, -1, B.FLOWER_POT + 1 + Math.floor(r * 3));
  put(mid + 2, 1, -1, B.FLOWER_POT + 1 + Math.floor(r * 7) % 3);

  const cell = (u: number, dy: number, v: number): [number, number, number] => [wx(u, v), H + dy, wz(u, v)];
  const bed = (u: number, v: number) => {
    // foot at (u, v), head one further in
    put(u, 1, v, B.RED_BED + IN);
    put(u, 1, v + 1, B.RED_BED + IN + 4);
  };
  let loot: [number, number, number] | null = null;
  let inside: [number, number, number];
  let bedAt: [number, number, number];
  const chest = (u: number, v: number, isLoot: boolean) => {
    put(u, 1, v, B.CHEST + OUT);
    if (isLoot) loot = cell(u, 1, v);
  };
  if (kind === "cottage") {
    bed(1, D - 3);
    bedAt = cell(1, 1, D - 3);
    chest(W - 2, D - 2, true);
    put(W - 2, 1, D - 3, B.CRAFTING_TABLE);
    put(W - 2, 1, 1, B.HAY_BALE);
    put(1, 1, 1, B.BARREL);
    inside = cell(2, 1, 3);
  } else if (kind === "smithy") {
    put(1, 1, D - 2, B.FURNACE + OUT);
    put(2, 1, D - 2, B.FURNACE + OUT);
    chest(W - 2, D - 2, true);
    put(W - 2, 1, D - 3, B.CRAFTING_TABLE);
    bed(W - 2, 1);
    bedAt = cell(W - 2, 1, 1);
    // the chimney: a brick stack through the roof over the furnaces
    for (let dy = 4; dy <= roofY(1) + 2; dy++) put(1, dy, D - 1, B.BRICKS);
    inside = cell(mid, 1, 3);
  } else if (kind === "library") {
    for (const u of [1, W - 2]) for (let v = 2; v <= D - 4; v++) for (let dy = 1; dy <= 2; dy++) put(u, dy, v, B.BOOKSHELF);
    bed(2, D - 3);
    bedAt = cell(2, 1, D - 3);
    chest(W - 3, D - 2, false);
    put(W - 2, 1, D - 2, B.CRAFTING_TABLE);
    put(W - 2, 1, 1, B.LANTERN);
    inside = cell(mid, 1, D - 4);
  } else if (kind === "hut") {
    put(1, 1, 1, B.BARREL);
    put(1, 2, 1, B.BARREL);
    put(1, 1, 2, B.BARREL);
    chest(W - 2, D - 2, false);
    put(W - 2, 1, D - 3, B.FURNACE + LEFT);
    bed(1, D - 3);
    bedAt = cell(1, 1, D - 3);
    put(W - 2, 1, 1, B.LANTERN);
    put(-1, 1, 1, B.BARREL); // and one outside by the wall
    inside = cell(mid, 1, 3);
  } else {
    put(1, 1, D - 2, B.FURNACE + OUT);
    put(2, 1, D - 2, B.CRAFTING_TABLE);
    chest(W - 2, D - 2, false);
    bed(W - 2, 1);
    bedAt = cell(W - 2, 1, 1);
    put(1, 1, 1, B.CLAY);
    inside = cell(mid, 1, 3);
  }
  void LEFT;
  void RIGHT;
  const work = cell(mid + 1, 1, -1);
  const lootCell = loot as [number, number, number] | null;
  return {
    info: { job, door: cell(mid, 1, 0), inside, work, bed: bedAt },
    loot: lootCell ? { x: lootCell[0], y: lootCell[1], z: lootCell[2] } : null,
  };
}

/** Horizontal distance from the spawn centre to the nearest point of a village's square (tests, the hub). */
export function villageDistanceToSpawn(site: number): number {
  const s = VILLAGE_SITES[site];
  const R = VILLAGE_R + VILLAGE_BLEND;
  const dx = Math.max(0, Math.abs(s.x - SPAWN_X) - R);
  const dz = Math.max(0, Math.abs(s.z - SPAWN_Z) - R);
  return Math.sqrt(dx * dx + dz * dz);
}

