// The bigger spawn (update 12, protocol v10): the hub grows from a 46-block safe zone to 68 and becomes a place worth a
// screenshot, built over the old one as the last worldgen step:
//   - a grand plaza (r 22) round the landmark (shared/landmark.ts): a blocky guy in a teal shirt and blue trousers,
//     32 blocks tall on a grassy dais, punching an oak; the "$STEVE Craft" plaque; a compass of teal lines
//   - the Beacon: a stone tower 58 blocks tall north of the plaza, with a lantern room and a gallery you can climb to
//     (a ladder inside), a diamond on each of its four faces and on its tip: seen from far across the island
//   - four avenues, the north one a reflecting pool to the Beacon; a ring road (r 57); lantern posts everywhere
//   - the arrival: you spawn in a courtyard south of the plaza facing the landmark and the Beacon, under a welcome arch,
//     the tips and directions boards either side of you, the welcome and rules boards along the avenue ahead
//   - the Charity Hall and the Updates House: proper buildings for the live charity board and the latest update
//   - the Workshop (free crafting tables and furnaces), a diamond of bluebells, flower beds, the grove, a fountain
//   - a gate on the ring for every road out: signposted roads (lanterns along them) to each of the world's villages
//     and to the Harbour on the south coast, where boats wait at the piers (the server keeps them there)
// "Like a server, but not too much": boards and signs in the world; no NPCs, menus, portals or anything in the way.
//
// Never eats a player's edit: the server decides once (server/src/shard.ts, hub.json) which 8 x 8 tiles hold an edit
// (or are within 3 blocks of one), and this pass leaves those tiles exactly as they were: no levelling, no paving,
// and no building that would reach into them (a building that would is left out whole; a road gaps). Those tiles
// stay out of the safe zone too, so their builders can keep building. Deterministic: + - * / floor sqrt and integer
// hashes only, so the client builds exactly the same blocks.

import { B, IS_WATER, SOLID } from "./blocks.ts";
import { SEA_LEVEL, SPAWN_X, SPAWN_Z, WORLD_HEIGHT, WORLD_SIZE, idx } from "./constants.ts";
import { hash2 } from "./noise.ts";
import { GEM_ROWS, OLD_SAFE_RADIUS, hubTree, settleWater, type HubInfo, type Panel } from "./hub.ts";
import { buildLandmark } from "./landmark.ts";
import { VILLAGE_BLEND, VILLAGE_R, type VillageInfo } from "./villages.ts";

export const SAFE_RADIUS_12 = 68;
export const HUB_R = 64; // levelled to the plaza's height out to here
export const HUB_EASE = 12; // then eased back to the land's own height by 76
export const TILE = 8;
export const TILES = WORLD_SIZE / TILE; // 64 per side
export const tileOf = (x: number, z: number) => Math.floor(z / TILE) * TILES + Math.floor(x / TILE);

/** The server's plan for the hub: tiles to leave alone (they hold edits) and the villages that get a road. */
export interface HubPlan {
  keep: number[];
  roads: number[]; // village sites
}

/** The harbour's spot: the south shore of the low islet off the peninsula south of the spawn (the nearest straight
 *  shore with deep open sea in front that boats can row out of to the islands; .local/pa/harbour-sites.ts and
 *  ascii.ts), and the way the sea lies from it (0 north, 1 east, 2 south, 3 west). The road crosses to it on a bridge. */
export const HARBOUR = { x: 290, z: 470, f: 2 };
/** A boat's yaw facing out to sea, per facing (yaw 0 looks south, +z). */
const SEA_YAW = [180, -90, 0, 90];

/** The tiles holding an edit, or within `margin` blocks of one (the plan's keep list). */
export function keepTiles(edits: Iterable<number>, margin = 3): number[] {
  const out = new Set<number>();
  const mask = WORLD_SIZE - 1;
  const add = (x: number, z: number) => {
    if (x >= 0 && z >= 0 && x < WORLD_SIZE && z < WORLD_SIZE) out.add(tileOf(x, z));
  };
  for (const i of edits) {
    const x = i & mask;
    const z = (i >> 9) & mask;
    // margin < TILE: the square's four corners cover every tile it touches
    add(x - margin, z - margin);
    add(x + margin, z - margin);
    add(x - margin, z + margin);
    add(x + margin, z + margin);
    add(x, z);
  }
  return [...out].sort((a, b) => a - b);
}

/** The safe zone of a world with the bigger hub: the old circle always, the new one minus the kept tiles. */
export class SafeZone {
  readonly keep: Set<number>;
  readonly radius: number;
  constructor(keep: Iterable<number> = [], radius = SAFE_RADIUS_12) {
    this.keep = new Set(keep);
    this.radius = radius;
  }
  /** Is (x, z) inside? `margin` widens both circles (animals and mobs keep a little further off). */
  /** clankersmp (SAFE_ZONE=0): no safe zone anywhere, hardcore everywhere. */
  off = false;
  contains(x: number, z: number, margin = 0): boolean {
    if (this.off) return false;
    const dx = x - SPAWN_X - 0.5;
    const dz = z - SPAWN_Z - 0.5;
    const d2 = dx * dx + dz * dz;
    if (d2 <= (OLD_SAFE_RADIUS + margin) * (OLD_SAFE_RADIUS + margin)) return true;
    if (d2 > (this.radius + margin) * (this.radius + margin)) return false;
    return !this.keep.has(tileOf(Math.floor(x), Math.floor(z)));
  }
  outside(x: number, z: number, margin = 0): boolean {
    return !this.contains(x, z, margin);
  }
}

const PLANT = new Set<number>([B.TALL_GRASS, B.DANDELION, B.POPPY, B.BLUEBELL, B.SUGAR_CANE]);
const TREE = new Set<number>([B.OAK_LOG, B.OAK_LEAVES, B.BIRCH_LOG, B.BIRCH_LEAVES, B.PALM_LOG, B.PALM_LEAVES]);

/** Unit directions of 16 compass points, north first, clockwise (x east, z south). Exact constants, no trig. */
const COMPASS: [number, number][] = [];
{
  const C = [1, 0.9238795325112867, 0.7071067811865476, 0.3826834323650898];
  const S = [0, 0.3826834323650898, 0.7071067811865476, 0.9238795325112867];
  for (let k = 0; k < 16; k++) {
    const s = S[k % 4];
    const c = C[k % 4];
    const quarter: [number, number][] = [[s, -c], [c, s], [-s, c], [-c, -s]];
    COMPASS.push(quarter[k >> 2]);
  }
}
const COMPASS_WORD = ["north", "north", "north-east", "east", "east", "east", "south-east", "south", "south", "south", "south-west", "west", "west", "west", "north-west", "north"];

/** The compass point (0-15) nearest a direction. */
function compassOf(dx: number, dz: number): number {
  let best = 0;
  let bd = -2;
  const l = Math.sqrt(dx * dx + dz * dz) || 1;
  for (let k = 0; k < 16; k++) {
    const d = (COMPASS[k][0] * dx + COMPASS[k][1] * dz) / l;
    if (d > bd) {
      bd = d;
      best = k;
    }
  }
  return best;
}

export interface Destination {
  name: string;
  kind: "village" | "harbour";
  x: number; // where its road ends
  z: number;
  dist: number; // blocks from spawn, to the nearest 10
  point: number; // the compass point of its gate (0-15)
  way: string; // "north", "south-east", ...
}

export interface HubExtra {
  keep: number[];
  destinations: Destination[];
  gates: { point: number; x: number; z: number; names: string[] }[];
  roads: { to: string; cells: number; reached: boolean }[];
  harbour: { x: number; y: number; z: number; slots: { x: number; y: number; z: number; yaw: number }[] } | null;
  beacon: { x: number; z: number; top: number } | null;
  /** The "punch a tree" landmark in the plaza (null where players' builds kept its ground). */
  landmark: { figure: { x: number; z: number; y0: number; top: number }; tree: { x: number; z: number; top: number } } | null;
}
export type HubInfo12 = HubInfo & HubExtra;

export interface Hub12Result {
  hub: HubInfo12;
  spawn: { x: number; y: number; z: number };
  board: { x0: number; x1: number; y0: number; y1: number; z: number };
}

export function buildHub12(
  blocks: Uint8Array,
  sh: number,
  seed: number,
  plan: HubPlan,
  villages: VillageInfo[],
  old: HubInfo,
  oldSpawn: { x: number; y: number; z: number },
  oldBoard: Hub12Result["board"],
): Hub12Result {
  const CX = SPAWN_X;
  const CZ = SPAWN_Z;
  const keep = new Set(plan.keep);
  const kept = (x: number, z: number) => keep.has(tileOf(x, z));
  const inW = (x: number, y: number, z: number) => x >= 0 && z >= 0 && x < WORLD_SIZE && z < WORLD_SIZE && y >= 0 && y < WORLD_HEIGHT;
  const set = (x: number, y: number, z: number, id: number) => {
    if (!inW(x, y, z) || kept(x, z)) return;
    blocks[idx(x, y, z)] = id;
  };
  const get = (x: number, y: number, z: number) => (inW(x, y, z) ? blocks[idx(x, y, z)] : B.STONE);
  /** No kept tile anywhere in this rectangle (world cells, inclusive): a building can stand here whole. */
  const free = (x0: number, z0: number, x1: number, z1: number) => {
    for (let tz = Math.floor(Math.min(z0, z1) / TILE); tz <= Math.floor(Math.max(z0, z1) / TILE); tz++)
      for (let tx = Math.floor(Math.min(x0, x1) / TILE); tx <= Math.floor(Math.max(x0, x1) / TILE); tx++) if (keep.has(tz * TILES + tx)) return false;
    return true;
  };
  const freeRel = (dx0: number, dz0: number, dx1: number, dz1: number) => free(CX + dx0, CZ + dz0, CX + dx1, CZ + dz1);
  const ground = (x: number, z: number): { y: number; water: boolean } => {
    for (let y = WORLD_HEIGHT - 1; y > 0; y--) {
      const id = get(x, y, z);
      if (id === B.AIR || PLANT.has(id) || TREE.has(id)) continue;
      return { y, water: IS_WATER[id] === 1 };
    }
    return { y: 0, water: false };
  };
  const floor = (dx: number, dz: number, id: number) => set(CX + dx, sh, CZ + dz, id);
  const put = (dx: number, dy: number, dz: number, id: number) => set(CX + dx, sh + dy, CZ + dz, id);
  const dist = (dx: number, dz: number) => Math.sqrt(dx * dx + dz * dz);
  // the old hub's boards and stations stay where their tile is kept (the rest of the old hub is built over)
  const panels: Panel[] = old.panels.filter((p) => kept(Math.floor(p.x), Math.floor(p.z)));
  const stations: HubInfo["stations"] = old.stations.filter((s) => kept(s.x, s.z));
  /** A lantern post: a cobblestone foot, fence, a lantern on top. */
  const post = (dx: number, dz: number, h = 2) => {
    if (!freeRel(dx, dz, dx, dz)) return;
    floor(dx, dz, B.COBBLESTONE);
    for (let k = 1; k <= h; k++) put(dx, k, dz, B.OAK_FENCE);
    put(dx, h + 1, dz, B.LANTERN);
  };

  // ================================================================ the ground: level to r 64, ease back by 76
  const RE = HUB_R + HUB_EASE;
  for (let dz = -RE - 3; dz <= RE + 3; dz++)
    for (let dx = -RE - 3; dx <= RE + 3; dx++) {
      const d = dist(dx, dz);
      if (d > RE + 3) continue;
      const x = CX + dx;
      const z = CZ + dz;
      if (kept(x, z)) continue;
      // trees out of the way (and a little beyond, so no canopy hangs over the edge)
      for (let y = SEA_LEVEL - 2; y < WORLD_HEIGHT; y++) if (TREE.has(get(x, y, z))) set(x, y, z, B.AIR);
      if (d > RE) continue;
      if (d <= HUB_R) {
        for (let y = sh - 8; y < sh - 3; y++) if (get(x, y, z) === B.AIR || IS_WATER[get(x, y, z)]) set(x, y, z, B.STONE);
        for (let y = sh - 3; y < sh; y++) set(x, y, z, B.DIRT);
        set(x, sh, z, B.GRASS);
        for (let y = sh + 1; y < Math.min(WORLD_HEIGHT, sh + 64); y++) if (get(x, y, z) !== B.AIR) set(x, y, z, B.AIR);
        continue;
      }
      const g = ground(x, z);
      if (g.water) continue;
      const t = (d - HUB_R) / HUB_EASE;
      const k = t * t * (3 - 2 * t);
      const target = Math.floor(sh + (g.y - sh) * k + 0.5);
      // the old hub's gravel trails and lamp posts out here go; the land keeps its plants
      for (let y = target + 1; y < WORLD_HEIGHT; y++) {
        const id = get(x, y, z);
        if (id !== B.AIR && !(target === g.y && y === g.y + 1 && PLANT.has(id))) set(x, y, z, B.AIR);
      }
      for (let y = Math.min(g.y + 1, target); y < target; y++) set(x, y, z, B.DIRT);
      if (get(x, target, z) === B.GRAVEL || target !== g.y) set(x, target, z, B.GRASS);
      if (g.y > target) set(x, target - 1, z, B.DIRT);
    }

  // ================================================================ the grand plaza and the monument
  for (let dz = -23; dz <= 23; dz++)
    for (let dx = -23; dx <= 23; dx++) {
      const d = dist(dx, dz);
      if (d > 22.5) continue;
      let id: number = B.STONE_BRICKS;
      if (d > 21.5) id = B.COBBLESTONE;
      else if (d > 20.5) id = B.STONE_BRICKS;
      else if (d > 14 && d <= 15) id = B.STONE;
      else if (d > 6) id = hash2(dx, dz, seed + 1201) < 0.08 ? B.MOSSY_STONE_BRICKS : (dx + dz) % 2 === 0 ? B.STONE_BRICKS : hash2(dx, dz, seed + 1202) < 0.5 ? B.STONE_BRICKS : B.STONE;
      // the compass: teal lines out to the four avenues (from the landmark's dais)
      if (d >= 13 && d <= 20 && (dx === 0 || dz === 0)) id = B.SMOOTH_TEAL;
      floor(dx, dz, id);
    }
  // the landmark: the figure punching a tree on its grassy dais, and the "$STEVE Craft" plaque facing the arrival
  let board = oldBoard;
  let landmark: HubExtra["landmark"] = null;
  // (its dais is centred 3 north of the plaza's centre, so from the arrival the punching arm passes under the Beacon's
  // lantern room and the plaque stands clear at the dais's south rim)
  const monument = freeRel(-13, -16, 13, 11);
  if (monument) {
    const lm = buildLandmark(set, CX, CZ - 3, sh, seed);
    board = lm.board;
    landmark = { figure: lm.figure, tree: lm.tree };
  } else if (!(kept(oldBoard.x0, oldBoard.z) && kept(oldBoard.x1, oldBoard.z))) board = { x0: -1, x1: -1, y0: -1, y1: -1, z: -1 };
  for (const [dx, dz] of [[13, 13], [-13, 13], [13, -13], [-13, -13], [18, 7], [-18, 7], [18, -7], [-18, -7], [7, 18], [-7, 18], [7, -18], [-7, -18]] as [number, number][]) post(dx, dz);
  // benches round the rim, facing the monument (a stair's facing is its back)
  for (const [dx, dz, f] of [[-3, 19, 2], [3, 19, 2], [-3, -19, 0], [3, -19, 0], [19, -3, 1], [19, 3, 1], [-19, -3, 3], [-19, 3, 3]] as [number, number, number][]) if (freeRel(dx, dz, dx, dz)) put(dx, 1, dz, B.OAK_STAIRS + f);

  // ================================================================ the avenues (5 wide); the north one a pool
  const DIRS: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  for (const [ax, az] of DIRS) {
    const px = -az;
    const pz = ax;
    for (let a = 22; a <= 56; a++)
      for (let l = -2; l <= 2; l++) {
        const dx = ax * a + px * l;
        const dz = az * a + pz * l;
        if (dist(dx, dz) <= 21.5) continue;
        floor(dx, dz, Math.abs(l) === 2 ? B.COBBLESTONE : hash2(dx, dz, seed + 1203) < 0.12 ? B.COBBLESTONE : B.STONE_BRICKS);
      }
    for (const a of [26, 34, 42, 50]) {
      if (az !== 0 && a < 50) continue; // north: the pool and the Beacon; south: the boards and the arrival
      for (const side of [-1, 1]) post(ax * a + px * 3 * side, az * a + pz * 3 * side);
    }
  }
  // the reflecting pool up the north avenue (3 wide in a stone rim, walks either side, hedges beyond)
  if (freeRel(-6, -29, 6, -23)) {
    for (let a = 23; a <= 29; a++)
      for (let l = -4; l <= 4; l++) {
        if (Math.abs(l) <= 1) {
          put(l, -1, -a, B.STONE_BRICKS);
          floor(l, -a, B.WATER);
        } else if (Math.abs(l) === 2) {
          floor(l, -a, B.STONE_BRICKS);
          put(l, 1, -a, B.STONE_BRICK_SLAB);
        } else floor(l, -a, Math.abs(l) === 3 ? B.STONE_BRICKS : B.COBBLESTONE);
      }
    for (const side of [-1, 1]) {
      for (let a = 23; a <= 29; a++) put(6 * side, 1, -a, B.OAK_LEAVES);
      post(5 * side, -23);
    }
  }

  // ================================================================ the ring road (r 57)
  for (let dz = -59; dz <= 59; dz++)
    for (let dx = -59; dx <= 59; dx++) {
      const d = dist(dx, dz);
      if (d < 55.5 || d > 58.5) continue;
      floor(dx, dz, d > 56.5 && d <= 57.5 ? B.DIRT_PATH : B.COBBLESTONE);
    }
  // lantern posts just outside it, half-way between the compass points (so never in a gate's way)
  {
    const C = [0.9807852804032304, 0.8314696123025452, 0.5555702330196022, 0.19509032201612825];
    const S = [0.19509032201612825, 0.5555702330196022, 0.8314696123025452, 0.9807852804032304];
    for (let k = 0; k < 16; k++) {
      const s = S[k % 4];
      const c = C[k % 4];
      const [ux, uz] = ([[s, -c], [c, s], [-s, c], [-c, -s]] as [number, number][])[k >> 2];
      post(Math.round(ux * 60.5), Math.round(uz * 60.5));
    }
  }

  // ================================================================ the Beacon (north): a tower you can climb
  let beacon: HubExtra["beacon"] = null;
  const TB = 36; // its centre, north of the plaza
  for (let dz = -TB - 6; dz <= -TB + 6; dz++) for (let dx = -8; dx <= 8; dx++) floor(dx, dz, Math.abs(dx) === 8 || dz === -TB - 6 || dz === -TB + 6 ? B.COBBLESTONE : B.STONE_BRICKS);
  if (freeRel(-5, -TB - 5, 5, -TB + 5)) {
    const H = 58;
    const at = (dx: number, dy: number, dz: number, id: number) => put(dx, dy, -TB + dz, id);
    // the base: 9 x 9, 8 high, a wide door to the south, moss at its foot; a ledge inside where the shaft begins
    for (let dy = 1; dy <= 8; dy++)
      for (let dz = -4; dz <= 4; dz++)
        for (let dx = -4; dx <= 4; dx++) {
          const ring4 = Math.abs(dx) === 4 || Math.abs(dz) === 4;
          if (!ring4) {
            if (dy === 8 && (Math.abs(dx) === 3 || Math.abs(dz) === 3)) at(dx, dy, dz, B.STONE_BRICKS);
            continue;
          }
          if (dz === 4 && Math.abs(dx) <= 1 && dy <= 4) continue;
          const corner = Math.abs(dx) === 4 && Math.abs(dz) === 4;
          at(dx, dy, dz, corner ? B.COBBLESTONE : dy <= 2 && hash2(dx * 7 + dz, dy, seed + 1204) < 0.35 ? B.MOSSY_STONE_BRICKS : B.STONE_BRICKS);
        }
    for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) at(dx, 0, dz, B.STONE_BRICKS);
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) if (Math.abs(dx) === 4 || Math.abs(dz) === 4) at(dx, 9, dz, B.STONE_BRICK_SLAB);
    // the shaft: 7 x 7, hollow, windows every six blocks, teal bands every twelve
    for (let dy = 9; dy <= 44; dy++)
      for (let dz = -3; dz <= 3; dz++)
        for (let dx = -3; dx <= 3; dx++) {
          if (Math.abs(dx) < 3 && Math.abs(dz) < 3) continue;
          const win = dy % 6 === 3 && (dx === 0 || dz === 0) && dz !== -3;
          at(dx, dy, dz, win ? B.GLASS_PANE : dy % 12 === 0 ? B.SMOOTH_TEAL : B.STONE_BRICKS);
        }
    // a diamond on each face near the top, one block proud of the shaft
    GEM_ROWS.forEach((row, r) => {
      for (let c = 0; c < 7; c++) {
        if (row[c] !== "#") continue;
        const dy = 41 - r;
        const o = c - 3;
        at(o, dy, 4, B.DIAMOND_BLOCK);
        at(-o, dy, -4, B.DIAMOND_BLOCK);
        at(4, dy, -o, B.DIAMOND_BLOCK);
        at(-4, dy, o, B.DIAMOND_BLOCK);
      }
    });
    // the gallery: an 11 x 11 floor with a railing and lanterns on its corners
    for (let dz = -5; dz <= 5; dz++)
      for (let dx = -5; dx <= 5; dx++) {
        at(dx, 45, dz, Math.abs(dx) <= 3 && Math.abs(dz) <= 3 ? B.STONE_BRICKS : B.STONE_BRICK_SLAB + 1);
        if (Math.abs(dx) === 5 || Math.abs(dz) === 5) at(dx, 46, dz, B.OAK_FENCE);
      }
    for (const [dx, dz] of [[-5, -5], [5, -5], [-5, 5], [5, 5]] as [number, number][]) at(dx, 47, dz, B.LANTERN);
    // the lantern room: glass all round, doors out to the gallery on three sides, the light in the middle
    for (let dy = 46; dy <= 51; dy++)
      for (let dz = -3; dz <= 3; dz++)
        for (let dx = -3; dx <= 3; dx++) {
          if (Math.abs(dx) < 3 && Math.abs(dz) < 3) continue;
          const corner = Math.abs(dx) === 3 && Math.abs(dz) === 3;
          const door = dy <= 47 && ((dz === 0 && Math.abs(dx) === 3) || (dx === 0 && dz === 3));
          const backing = dx === 0 && dz === -3 && dy <= 47; // behind the ladder's top
          at(dx, dy, dz, corner || backing ? B.STONE_BRICKS : door ? B.AIR : B.GLASS_PANE);
        }
    at(0, 46, 0, B.STONE_BRICKS);
    for (let dy = 47; dy <= 50; dy++) at(0, dy, 0, B.LAMP);
    // the roof, stepped in, a lamp at the tip and a diamond just above it
    for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) at(dx, 52, dz, B.STONE_BRICKS);
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) at(dx, 53, dz, B.STONE_BRICKS);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) at(dx, 54, dz, B.STONE_BRICKS);
    at(0, 55, 0, B.STONE_BRICKS);
    at(0, 56, 0, B.LAMP);
    at(0, H, 0, B.DIAMOND_BLOCK);
    // the climb: a ladder up the inside of the north wall (backed in the base by a pillar), out into the lantern room
    for (let dy = 1; dy <= 8; dy++) at(0, dy, -3, B.STONE_BRICKS);
    for (let dy = 1; dy <= 46; dy++) at(0, dy, -2, B.LADDER + 2);
    // lanterns hanging inside the shaft
    for (let dy = 12; dy <= 40; dy += 10) {
      at(2, dy + 1, 2, B.STONE_BRICKS);
      at(2, dy, 2, B.LANTERN + 1);
    }
    panels.push({ kind: "beacon", x: CX + 0.5, y: sh + 6.4, z: CZ - TB + 5 + 0.01, w: 5, h: 0.9, nx: 0, nz: 1, text: "The Beacon · climb to the top" });
    beacon = { x: CX, z: CZ - TB, top: sh + H };
  }

  // ================================================================ the arrival (south): the courtyard you spawn in
  // (paving may stop at a kept tile; the arch stands only whole)
  for (let dz = 38; dz <= 47; dz++) for (let dx = -7; dx <= 7; dx++) floor(dx, dz, Math.abs(dx) === 7 || dz === 47 ? B.COBBLESTONE : (dx + dz) % 2 ? B.STONE_BRICKS : B.STONE);
  floor(0, 44, B.SMOOTH_TEAL);
  if (freeRel(-5, 37, 5, 37)) {
    // the welcome arch at its north edge, tall enough to frame the landmark and the Beacon from the spawn point: two
    // pillars and a beam 9 wide, "Welcome to $STEVE Craft" facing you
    for (const side of [-1, 1]) {
      for (let dy = 1; dy <= 8; dy++) put(5 * side, dy, 37, dy === 4 ? B.SMOOTH_TEAL : B.STONE_BRICKS);
      put(5 * side, 9, 37, B.LANTERN);
    }
    for (let dx = -4; dx <= 4; dx++) put(dx, 8, 37, B.STONE_BRICKS);
    for (const side of [-1, 1]) put(4 * side, 7, 37, B.STONE_BRICK_SLAB + 1);
    panels.push({ kind: "arrival", x: CX + 0.5, y: sh + 8.5, z: CZ + 38 + 0.01, w: 9, h: 0.9, nx: 0, nz: 1, text: "Welcome to $STEVE Craft" });
    panels.push({ kind: "arrival", x: CX + 0.5, y: sh + 8.5, z: CZ + 37 - 0.01, w: 9, h: 0.9, nx: 0, nz: -1, text: "Arrivals" });
  }
  // the spawn point: the courtyard's teal block, unless a kept tile is that close (then the old spawn on the plaza's
  // south side, or the plaza's south edge)
  let spawn = oldSpawn;
  for (const [sx, sz] of [[0, 44], [0, 7], [0, 20]] as [number, number][])
    if (freeRel(sx - 1, sz - 1, sx + 1, sz + 1)) {
      spawn = { x: CX + sx + 0.5, y: sh + 1, z: CZ + sz + 0.5 };
      break;
    }

  /** A notice board, 7 wide and 4 tall on two log posts with lanterns, at the first of its spots clear of kept tiles.
   *  A spot: [the axis its face looks along ("x": east or west, "z": south or north), its plane's offset on that
   *  axis, where its 7 blocks start along the other axis, which way it faces (+1 or -1)]. */
  type Spot = ["x" | "z", number, number, 1 | -1];
  const boardAt = (spots: Spot[], kind: Panel["kind"], lines?: string[]) => {
    for (const [axis, at, from, facing] of spots) {
      const P = (u: number, n: number): [number, number] => (axis === "x" ? [at + n, u] : [u, at + n]);
      const [x0, z0] = P(from - 1, 0);
      const [x1, z1] = P(from + 7, facing);
      if (!freeRel(x0, z0, x1, z1)) continue;
      for (const u of [from - 1, from + 7]) {
        const [dx, dz] = P(u, 0);
        for (let y = 1; y <= 6; y++) put(dx, y, dz, B.OAK_LOG);
        put(dx, 7, dz, B.LANTERN);
      }
      for (let u = from - 1; u <= from + 7; u++) {
        floor(...P(u, 0), B.COBBLESTONE);
        floor(...P(u, facing), B.COBBLESTONE);
      }
      for (let u = from; u < from + 7; u++) {
        const [dx, dz] = P(u, 0);
        for (let y = 2; y <= 5; y++) put(dx, y, dz, B.OAK_PLANKS);
        put(dx, 6, dz, B.OAK_SLAB);
        put(dx, 1, dz, B.OAK_FENCE);
      }
      const [px, pz] = axis === "x" ? [at + 0.5 + facing * 0.51, from + 3.5] : [from + 3.5, at + 0.5 + facing * 0.51];
      panels.push({ kind, x: CX + px, y: sh + 4, z: CZ + pz, w: 7, h: 4, nx: axis === "x" ? facing : 0, nz: axis === "z" ? facing : 0, ...(lines ? { lines } : {}) });
      return;
    }
  };
  // the welcome and the rules along the avenue to the plaza
  boardAt([["x", -5, 27, 1]], "welcome");
  boardAt([["x", 5, 27, -1]], "rules");

  // ================================================================ the Charity Hall (east) and the Updates House (west)
  const hall = (sx: 1 | -1, kind: "charity" | "updates") => {
    // 11 wide (26..36 out from the centre), 9 deep (z 5..13), open on its avenue side
    const xa = sx > 0 ? 26 : -36;
    const xb = xa + 10;
    if (!freeRel(xa - 1, 3, xb + 1, 14)) return;
    const stone = kind === "charity";
    const wallId = stone ? B.STONE_BRICKS : B.OAK_PLANKS;
    const cornerId = stone ? B.COBBLESTONE : B.OAK_LOG;
    for (let dz = 5; dz <= 13; dz++) for (let dx = xa; dx <= xb; dx++) floor(dx, dz, stone ? B.STONE_BRICKS : B.OAK_PLANKS);
    for (let dx = xa; dx <= xb; dx++) floor(dx, 4, B.COBBLESTONE);
    // walls 6 high, the front open 7 wide and 4 high, windows down the sides, a trim (teal, or birch) at the top
    for (let dy = 1; dy <= 6; dy++)
      for (let dz = 5; dz <= 13; dz++)
        for (let dx = xa; dx <= xb; dx++) {
          if (!(dx === xa || dx === xb || dz === 5 || dz === 13)) continue;
          if (dz === 5 && dx > xa + 1 && dx < xb - 1 && dy <= 4) continue; // the wide open front
          const corner = (dx === xa || dx === xb) && (dz === 5 || dz === 13);
          const win = (dx === xa || dx === xb) && (dy === 2 || dy === 3) && dz >= 7 && dz <= 11 && dz % 2 === 1;
          put(dx, dy, dz, corner ? cornerId : win ? B.GLASS_PANE : dy === 6 ? (stone ? B.SMOOTH_TEAL : B.BIRCH_PLANKS) : wallId);
        }
    // a flat roof with stair eaves (a stair's facing is its high side, inward), lanterns hanging inside
    for (let dz = 4; dz <= 14; dz++)
      for (let dx = xa - 1; dx <= xb + 1; dx++) {
        const edge = dz === 4 || dz === 14 || dx === xa - 1 || dx === xb + 1;
        if (!edge) {
          put(dx, 7, dz, stone ? B.STONE_BRICK_SLAB : B.OAK_SLAB);
          continue;
        }
        const f = dz === 4 ? 2 : dz === 14 ? 0 : dx === xa - 1 ? 1 : 3;
        put(dx, 7, dz, (stone ? B.STONE_BRICK_STAIRS : B.OAK_STAIRS) + f);
      }
    for (const dx of [xa + 3, xb - 3]) for (const dz of [7, 11]) put(dx, 6, dz, B.LANTERN + 1);
    const mid = (xa + xb) / 2;
    // inside: a cyan runner from the door to the board, benches either side facing it, flowers in the corners
    for (let dz = 6; dz <= 12; dz++) floor(mid, dz, B.WOOL_CYAN);
    for (const dz of [8, 10]) for (const dx of [mid - 3, mid - 2, mid + 2, mid + 3]) put(dx, 1, dz, B.OAK_STAIRS);
    for (const dx of [xa + 1, xb - 1]) put(dx, 1, 12, B.FLOWER_POT + 3);
    // the board on the back wall inside, facing the door; the name over the door
    panels.push({ kind, x: CX + mid + 0.5, y: sh + 3.2, z: CZ + 13 - 0.01, w: 7, h: 3.6, nx: 0, nz: -1 });
    panels.push({ kind: stone ? "hall" : "news", x: CX + mid + 0.5, y: sh + 5.5, z: CZ + 5 - 0.01, w: 7, h: 0.9, nx: 0, nz: -1, text: stone ? "Charity Hall" : "Updates House" });
    // a path from the avenue to the door, flowers either side of it
    for (let dz = 3; dz <= 4; dz++) for (let dx = mid - 1; dx <= mid + 1; dx++) floor(dx, dz, B.COBBLESTONE);
    put(xa, 1, 4, B.FLOWER_POT + 1);
    put(xb, 1, 4, B.FLOWER_POT + 2);
  };
  hall(1, "charity");
  hall(-1, "updates");

  // ================================================================ the Workshop (north-east): the starter pavilion
  if (freeRel(15, -29, 29, -18)) {
    const x0 = CX + 16;
    const x1 = CX + 28;
    const z0 = CZ - 28;
    const z1 = CZ - 19;
    for (let z = z0 - 1; z <= z1 + 1; z++) for (let x = x0 - 1; x <= x1 + 1; x++) set(x, sh, z, x < x0 || x > x1 || z < z0 || z > z1 ? B.COBBLESTONE : B.OAK_PLANKS);
    for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1], [CX + 22, z0], [CX + 22, z1]] as [number, number][]) for (let y = sh + 1; y <= sh + 4; y++) set(x, y, z, B.OAK_LOG);
    for (let z = z0 - 1; z <= z1 + 1; z++)
      for (let x = x0 - 1; x <= x1 + 1; x++) {
        const edge = z === z0 - 1 || z === z1 + 1 || x === x0 - 1 || x === x1 + 1;
        if (!edge) {
          set(x, sh + 5, z, B.OAK_PLANKS);
          continue;
        }
        const f = z === z0 - 1 ? 2 : z === z1 + 1 ? 0 : x === x0 - 1 ? 1 : 3;
        set(x, sh + 5, z, B.OAK_STAIRS + f);
      }
    for (const [x, z] of [[x0 + 3, z0 + 3], [x1 - 3, z0 + 3], [x0 + 3, z1 - 2], [x1 - 3, z1 - 2], [CX + 22, CZ - 23]] as [number, number][]) set(x, sh + 4, z, B.LANTERN + 1);
    for (let k = 1; k <= 4; k++) {
      set(x0 + k, sh + 1, z0 + 1, B.CRAFTING_TABLE);
      stations.push({ x: x0 + k, y: sh + 1, z: z0 + 1, id: B.CRAFTING_TABLE });
      set(x1 - k, sh + 1, z0 + 1, B.FURNACE + 2);
      stations.push({ x: x1 - k, y: sh + 1, z: z0 + 1, id: B.FURNACE + 2 });
    }
    for (let z = z1 + 2; z <= CZ - 3; z++) for (let x = CX + 21; x <= CX + 23; x++) set(x, sh, z, x === CX + 22 ? B.STONE_BRICKS : B.COBBLESTONE);
    panels.push({ kind: "starter", x: CX + 22.5, y: sh + 5.5, z: z1 + 2 + 0.01, w: 7, h: 0.9, nx: 0, nz: 1, text: "Workshop · free crafting tables and furnaces" });
  }

  // ================================================================ gardens: a diamond of bluebells, flower beds, the grove
  {
    const ox = CX + 15;
    const oz = CZ + 20;
    GEM_ROWS.forEach((row, r) => {
      for (let c = 0; c < 7; c++) {
        if (row[c] !== "#") continue;
        for (let k = 0; k < 4; k++) {
          set(ox + c * 2 + (k & 1), sh, oz + r * 2 + (k >> 1), B.GRASS);
          set(ox + c * 2 + (k & 1), sh + 1, oz + r * 2 + (k >> 1), B.BLUEBELL);
        }
      }
    });
    for (let x = ox - 2; x <= ox + 17; x++) {
      set(x, sh + 1, oz - 4, B.OAK_LEAVES);
      set(x, sh + 1, oz + 13, B.OAK_LEAVES);
    }
    for (const x of [ox + 5, ox + 6, ox + 9, ox + 10]) set(x, sh + 1, oz + 14, B.OAK_STAIRS + 2);
  }
  {
    const kinds = [B.DANDELION, B.POPPY, B.BLUEBELL, B.POPPY];
    for (let bed = 0; bed < 4; bed++) {
      const z0 = CZ + 17 + bed * 3;
      for (let x = CX - 30; x <= CX - 14; x++) {
        for (let k = 0; k < 2; k++) {
          set(x, sh, z0 + k, B.GRASS);
          set(x, sh + 1, z0 + k, kinds[bed]);
        }
        set(x, sh, z0 + 2, B.GRAVEL);
      }
    }
  }
  const trees: [number, number, number][] = [[-24, -24, 4], [-30, -16, 5], [-17, -31, 4], [-34, -30, 5], [-22, -42, 4], [-42, -20, 5], [-14, -48, 5], [24, 40, 4], [34, 32, 5], [-26, 42, 4], [-38, 34, 5], [42, -38, 4], [46, 24, 5], [-46, 24, 5], [32, -44, 5], [48, -14, 4], [-48, -8, 4], [14, 48, 4]];
  for (const [dx, dz, th] of trees) if (freeRel(dx - 2, dz - 2, dx + 2, dz + 2)) hubTree(blocks, CX + dx, sh + 1, CZ + dz, th);

  // ================================================================ the fountain, behind the arrival
  if (freeRel(-4, 47, 4, 55)) {
    const fz = 51;
    for (let dz = -4; dz <= 4; dz++)
      for (let dx = -4; dx <= 4; dx++) {
        const d = dist(dx, dz);
        if (d > 3.6) continue;
        if (d > 2.6) {
          floor(dx, fz + dz, B.STONE_BRICKS);
          put(dx, 1, fz + dz, B.STONE_BRICK_SLAB);
        } else {
          put(dx, -1, fz + dz, B.STONE_BRICKS);
          floor(dx, fz + dz, B.WATER);
        }
      }
    for (let dy = 0; dy <= 2; dy++) put(0, dy, fz, B.STONE_BRICKS);
    put(0, 3, fz, B.WATER);
    settleWater(blocks, CX - 4, sh - 1, CZ + fz - 4, CX + 4, sh + 4, CZ + fz + 4);
  }

  // ================================================================ the Harbour: a quay, two piers, a hut, boats
  const H = HARBOUR;
  const HD: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const [hax, haz] = HD[H.f];
  const hqx = -haz; // along the shore
  const hqz = hax;
  const L = (a: number, s: number): [number, number] => [H.x + hax * a + hqx * s, H.z + haz * a + hqz * s];
  let harbourOk = true;
  for (let a = 2; a <= 16 && harbourOk; a++) if (!IS_WATER[get(L(a, 0)[0], SEA_LEVEL - 1, L(a, 0)[1])]) harbourOk = false;
  let harbour: HubExtra["harbour"] = null;
  if (harbourOk) {
    const Q = SEA_LEVEL; // the quay and the piers: a block over the water
    const at = (a: number, s: number, y: number, id: number) => {
      const [x, z] = L(a, s);
      set(x, y, z, id);
    };
    // the quay, level stone over the shore (9 deep, 21 wide), and the land behind it eased up to it
    for (let a = -16; a <= 0; a++)
      for (let s = -10; s <= 10; s++) {
        const [x, z] = L(a, s);
        if (kept(x, z)) continue;
        const g = ground(x, z);
        let target = Q;
        if (a < -8) {
          if (g.water) continue;
          const t = (-a - 8) / 8;
          target = Math.floor(Q + (g.y - Q) * t * t * (3 - 2 * t) + 0.5);
        }
        for (let y = target + 1; y < Math.min(WORLD_HEIGHT, Math.max(g.y, target) + 12); y++) set(x, y, z, B.AIR);
        for (let y = Math.min(g.y, target) - 2; y < target; y++) set(x, y, z, a < -8 ? B.DIRT : B.STONE);
        // over the water the quay goes down to the sea floor
        if (g.water) for (let y = target - 3; y > 1 && IS_WATER[get(x, y, z)]; y--) set(x, y, z, B.STONE);
        if (a < -8) set(x, target, z, B.GRASS);
        else set(x, target, z, a === 0 || Math.abs(s) === 10 ? B.STONE_BRICKS : hash2(x, z, seed + 1205) < 0.3 ? B.COBBLESTONE : B.STONE_BRICKS);
      }
    // two piers of planks on log piles, 14 out, a fence along each outer side, lanterns
    for (const ps of [-5, 5]) {
      const out = ps > 0 ? 1 : -1;
      for (let a = 1; a <= 14; a++)
        for (let s = ps - 1; s <= ps + 1; s++) {
          at(a, s, Q, B.OAK_PLANKS);
          for (let y = Q + 1; y <= Q + 3; y++) at(a, s, y, B.AIR);
        }
      for (const a of [3, 7, 11, 14])
        for (const s of [ps - 1, ps + 1]) {
          const [x, z] = L(a, s);
          for (let y = Q - 1; y > 1 && (IS_WATER[get(x, y, z)] || get(x, y, z) === B.AIR); y--) set(x, y, z, B.OAK_LOG);
        }
      for (let a = 2; a <= 14; a++) at(a, ps + out, Q + 1, B.OAK_FENCE);
      at(8, ps + out, Q + 2, B.LANTERN);
      at(14, ps + out, Q + 2, B.LANTERN);
      at(14, ps, Q + 1, B.OAK_FENCE);
      at(14, ps - out, Q + 1, B.OAK_FENCE);
    }
    // lantern posts by the boats' landing and on the quay's corners, a low wall along its sides, barrels and hay
    for (const [pa, ps] of [[0, -2], [0, 2], [-1, -10], [-1, 10], [-8, 10]] as [number, number][]) {
      at(pa, ps, Q + 1, B.OAK_FENCE);
      at(pa, ps, Q + 2, B.OAK_FENCE);
      at(pa, ps, Q + 3, B.LANTERN);
    }
    for (let a = -7; a <= -2; a++) for (const ps of [-10, 10]) at(a, ps, Q + 1, B.STONE_BRICK_WALL);
    for (const [pa, ps, id] of [[-1, 8, B.BARREL], [-1, 7, B.BARREL], [-2, 8, B.BARREL], [-1, -8, B.HAY_BALE], [-2, -8, B.BARREL]] as [number, number, number][]) at(pa, ps, Q + 1, id);
    // the harbour master's hut on the quay: 7 x 5, a door to the sea, windows either side
    const IN = (H.f + 2) & 3;
    for (let a = -7; a <= -3; a++)
      for (let s = -9; s <= -3; s++)
        for (let dy = 1; dy <= 4; dy++) {
          const edge = a === -7 || a === -3 || s === -9 || s === -3;
          if (dy === 4) {
            at(a, s, Q + dy, B.OAK_SLAB);
            continue;
          }
          if (!edge) {
            at(a, s, Q + dy, B.AIR);
            continue;
          }
          const door = a === -3 && s === -6 && dy <= 2;
          const win = a === -3 && (s === -8 || s === -4) && dy === 2;
          const corner = (a === -7 || a === -3) && (s === -9 || s === -3);
          at(a, s, Q + dy, door ? B.AIR : win ? B.GLASS_PANE : corner ? B.OAK_LOG : B.BIRCH_PLANKS);
        }
    at(-3, -6, Q + 1, B.OAK_DOOR + IN);
    at(-3, -6, Q + 2, B.OAK_DOOR + IN + 8);
    at(-5, -6, Q + 3, B.LANTERN + 1);
    at(-6, -8, Q + 1, B.BARREL);
    // the harbour's sign by the end of the road, facing the way you come
    {
      const [sx, sz] = L(-7, 2);
      if (!kept(sx, sz)) {
        set(sx, Q + 1, sz, B.OAK_FENCE);
        set(sx, Q + 2, sz, B.OAK_FENCE);
        panels.push({ kind: "harbour", x: sx + 0.5 - hax * 0.07, y: Q + 3.1, z: sz + 0.5 - haz * 0.07, w: 3.6, h: 0.75, nx: -hax, nz: -haz, text: "Harbour · boats to the islands" });
        panels.push({ kind: "harbour", x: sx + 0.5 + hax * 0.07, y: Q + 3.1, z: sz + 0.5 + haz * 0.07, w: 3.6, h: 0.75, nx: hax, nz: haz, text: "Road to spawn" });
      }
    }
    // where the boats wait: between the piers and outside them, bows to the open sea
    const slots: { x: number; y: number; z: number; yaw: number }[] = [];
    for (const [a, s] of [[4, 0], [9, 0], [5, -9], [5, 9], [11, -9], [11, 9]] as [number, number][]) {
      const [x, z] = L(a, s);
      if (!kept(x, z) && IS_WATER[get(x, SEA_LEVEL - 1, z)] && get(x, SEA_LEVEL, z) === B.AIR) slots.push({ x: x + 0.5, y: SEA_LEVEL - 1, z: z + 0.5, yaw: SEA_YAW[H.f] });
    }
    const [hx, hz] = L(0, 0);
    harbour = { x: hx, y: Q, z: hz, slots };
  }

  // ================================================================ where the roads go, and their gates on the ring
  const destinations: Destination[] = [];
  const roadVillages = plan.roads.map((site) => villages.find((q) => q.site === site)).filter((v): v is VillageInfo => !!v);
  for (const v of roadVillages) {
    // the end of the village's own road nearest the spawn
    const reach = VILLAGE_R + 2;
    const ends: [number, number][] = [[v.x, v.z - reach], [v.x + reach, v.z], [v.x, v.z + reach], [v.x - reach, v.z]];
    let e = ends[0];
    for (const c of ends) if ((c[0] - CX) ** 2 + (c[1] - CZ) ** 2 < (e[0] - CX) ** 2 + (e[1] - CZ) ** 2) e = c;
    const point = compassOf(v.x - CX, v.z - CZ);
    destinations.push({ name: v.name, kind: "village", x: e[0], z: e[1], dist: Math.round(dist(v.x - CX, v.z - CZ) / 10) * 10, point, way: COMPASS_WORD[point] });
  }
  if (harbour) {
    const [ex, ez] = L(-9, 0);
    const point = compassOf(H.x - CX, H.z - CZ);
    destinations.push({ name: "Harbour", kind: "harbour", x: ex, z: ez, dist: Math.round(dist(H.x - CX, H.z - CZ) / 10) * 10, point, way: COMPASS_WORD[point] });
  }
  // a gate per compass point in use (two roads the same way share one)
  const gates: HubExtra["gates"] = [];
  for (const d of destinations) {
    const g = gates.find((q) => q.point === d.point);
    if (g) g.names.push(d.name);
    else gates.push({ point: d.point, x: CX + Math.round(COMPASS[d.point][0] * 61), z: CZ + Math.round(COMPASS[d.point][1] * 61), names: [d.name] });
  }
  for (const g of gates) {
    const [ux, uz] = COMPASS[g.point];
    const qx = -uz;
    const qz = ux;
    // the paved way from the ring out through the gate to the plateau's edge
    for (let t = 56; t <= HUB_R + 1; t += 0.5)
      for (let l = -1.5; l <= 1.5; l += 0.5) {
        const dx = Math.round(ux * t + qx * l);
        const dz = Math.round(uz * t + qz * l);
        floor(dx, dz, Math.abs(l) > 0.75 ? B.COBBLESTONE : B.STONE_BRICKS);
        for (let dy = 1; dy <= 3; dy++) put(dx, dy, dz, B.AIR);
      }
    // its pillars, teal-banded with lanterns on top
    const gx = g.x - CX;
    const gz = g.z - CZ;
    for (const side of [-1, 1]) {
      const px = Math.round(gx + qx * 3 * side);
      const pz = Math.round(gz + qz * 3 * side);
      floor(px, pz, B.STONE_BRICKS);
      for (let dy = 1; dy <= 4; dy++) put(px, dy, pz, dy === 3 ? B.SMOOTH_TEAL : B.STONE_BRICKS);
      put(px, 5, pz, B.LANTERN);
    }
    // the signpost just inside it: where the road goes (facing in), and the way back (facing out); beside the road on
    // whichever side (or a little further in) has no kept tile
    for (const [iu, iq] of [[-3, 3], [-3, -3], [-6, 3], [-6, -3], [1, 3], [1, -3]] as [number, number][]) {
      const sx = Math.round(gx + ux * iu + qx * iq);
      const sz = Math.round(gz + uz * iu + qz * iq);
      if (!freeRel(sx, sz, sx, sz)) continue;
      floor(sx, sz, B.COBBLESTONE);
      put(sx, 1, sz, B.OAK_FENCE);
      put(sx, 2, sz, B.OAK_FENCE);
      const text = g.names.map((n) => `${n} · ${destinations.find((q) => q.name === n)!.dist} blocks`).join("  ·  ");
      panels.push({ kind: "gate", x: CX + sx + 0.5 - ux * 0.07, y: sh + 3.1, z: CZ + sz + 0.5 - uz * 0.07, w: 3.6, h: 0.75, nx: -ux, nz: -uz, text });
      panels.push({ kind: "gate", x: CX + sx + 0.5 + ux * 0.07, y: sh + 3.1, z: CZ + sz + 0.5 + uz * 0.07, w: 3.6, h: 0.75, nx: ux, nz: uz, text: "Spawn · safe zone" });
      break;
    }
  }

  // the tips and the directions boards either side of the arrival courtyard (the roads are known now)
  // (or, if a build is that close, at the plaza's south rim facing the way you come up the avenue)
  boardAt([["x", -8, 40, 1], ["z", 21, -13, 1]], "tips");
  boardAt([["x", 8, 40, -1], ["z", 21, 7, 1]], "directions", destinations.map((d) => `${d.name}: ${d.way}, ${d.dist} blocks${d.kind === "harbour" ? " (boats)" : ""}`));

  // ================================================================ a little ground cover on the lawns
  for (let dz = -HUB_R; dz <= HUB_R; dz++)
    for (let dx = -HUB_R; dx <= HUB_R; dx++) {
      const d = dist(dx, dz);
      if (d < 23 || d > HUB_R - 1) continue;
      const x = CX + dx;
      const z = CZ + dz;
      if (kept(x, z) || get(x, sh, z) !== B.GRASS || get(x, sh + 1, z) !== B.AIR) continue;
      let near = false;
      for (let k = -1; k <= 1 && !near; k++) for (let j = -1; j <= 1 && !near; j++) if (get(x + k, sh, z + j) !== B.GRASS || get(x + k, sh + 1, z + j) !== B.AIR) near = true;
      if (near) continue;
      const h = hash2(x, z, seed + 1206);
      if (h < 0.05) set(x, sh + 1, z, B.TALL_GRASS);
      else if (h < 0.058) set(x, sh + 1, z, [B.DANDELION, B.POPPY, B.BLUEBELL][Math.floor(hash2(x, z, seed + 1207) * 3)]);
    }

  // ================================================================ the roads out: over the land, round the water
  const roads: HubExtra["roads"] = [];
  const box = VILLAGE_R + VILLAGE_BLEND + 2;
  for (const d of destinations) {
    const g = gates.find((q) => q.names.includes(d.name))!;
    const [ux, uz] = COMPASS[g.point];
    const sx = CX + Math.round(ux * (HUB_R + 2));
    const sz = CZ + Math.round(uz * (HUB_R + 2));
    const own = villages.find((v) => v.name === d.name);
    const blocked = (x: number, z: number) =>
      dist(x - CX, z - CZ) <= HUB_R + 1 ||
      villages.some((v) => (v === own ? Math.abs(x - v.x) <= VILLAGE_R + 1 && Math.abs(z - v.z) <= VILLAGE_R + 1 : Math.abs(x - v.x) <= box && Math.abs(z - v.z) <= box));
    const path = route(blocks, sx, sz, d.x, d.z, blocked, (x, z) => (kept(x, z) ? 300 : 0));
    const last = path[path.length - 1];
    roads.push({ to: d.name, cells: path.length, reached: !!last && last[0] === d.x && last[1] === d.z });
    stampRoad(path, set, get, ground, kept);
  }

  return {
    hub: { safeRadius: SAFE_RADIUS_12, panels, stations, keep: [...keep].sort((a, b) => a - b), destinations, gates, roads, harbour, beacon, landmark },
    spawn,
    board,
  };
}

/** A walking route over the land from (sx, sz) to (tx, tz): A* over the columns' tops, gentle slopes cheap, steps
 *  dear, water dearer (it becomes a bridge), `blocked` cells never, `extra` added per cell. Deterministic: integer
 *  costs and a heap that breaks ties by insertion order. */
function route(blocks: Uint8Array, sx: number, sz: number, tx: number, tz: number, blocked: (x: number, z: number) => boolean, extra: (x: number, z: number) => number): [number, number][] {
  const W = WORLD_SIZE;
  const N = W * W;
  const top = (x: number, z: number): number => {
    for (let y = WORLD_HEIGHT - 1; y > 0; y--) {
      const id = blocks[idx(x, y, z)];
      if (id === B.AIR || PLANT.has(id) || TREE.has(id)) continue;
      return IS_WATER[id] ? -y : y;
    }
    return 0;
  };
  const g = new Int32Array(N).fill(0x7fffffff);
  const parent = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const hcache = new Int16Array(N).fill(-32768);
  const H = (i: number) => {
    if (hcache[i] === -32768) hcache[i] = top(i % W, (i / W) | 0);
    return hcache[i];
  };
  const heur = (x: number, z: number) => {
    const ax = Math.abs(x - tx);
    const az = Math.abs(z - tz);
    return 10 * Math.max(ax, az) + 4 * Math.min(ax, az);
  };
  // a binary heap of (f, order) -> cell
  const hf: number[] = [];
  const ho: number[] = [];
  const hi: number[] = [];
  let order = 0;
  const less = (a: number, b: number) => hf[a] < hf[b] || (hf[a] === hf[b] && ho[a] < ho[b]);
  const swap = (a: number, b: number) => {
    [hf[a], hf[b]] = [hf[b], hf[a]];
    [ho[a], ho[b]] = [ho[b], ho[a]];
    [hi[a], hi[b]] = [hi[b], hi[a]];
  };
  const push = (f: number, i: number) => {
    let k = hf.length;
    hf.push(f);
    ho.push(order++);
    hi.push(i);
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (!less(k, p)) break;
      swap(k, p);
      k = p;
    }
  };
  const pop = (): number => {
    const first = hi[0];
    const lf = hf.pop()!;
    const lo = ho.pop()!;
    const li = hi.pop()!;
    if (hf.length) {
      hf[0] = lf;
      ho[0] = lo;
      hi[0] = li;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < hf.length && less(l, m)) m = l;
        if (r < hf.length && less(r, m)) m = r;
        if (m === k) break;
        swap(m, k);
        k = m;
      }
    }
    return first;
  };
  const DX = [1, -1, 0, 0, 1, 1, -1, -1];
  const DZ = [0, 0, 1, -1, 1, -1, 1, -1];
  const start = sz * W + sx;
  const goal = tz * W + tx;
  g[start] = 0;
  push(heur(sx, sz), start);
  let found = false;
  for (let n = 0; hf.length && n < 250000; ) {
    const i = pop();
    if (closed[i]) continue;
    closed[i] = 1;
    n++;
    if (i === goal) {
      found = true;
      break;
    }
    const x = i % W;
    const z = (i / W) | 0;
    const h0 = Math.abs(H(i));
    for (let dir = 0; dir < 8; dir++) {
      const nx = x + DX[dir];
      const nz = z + DZ[dir];
      if (nx < 3 || nz < 3 || nx >= W - 3 || nz >= W - 3) continue;
      const j = nz * W + nx;
      if (closed[j] || (j !== goal && blocked(nx, nz))) continue;
      const h1 = H(j);
      const climb = Math.abs(h0 - Math.abs(h1));
      let c = dir < 4 ? 10 : 14;
      if (h1 < 0) c += 60;
      else if (climb === 1) c += 8;
      else if (climb > 1) c += 60 * climb;
      c += extra(nx, nz);
      const ng = g[i] + c;
      if (ng < g[j]) {
        g[j] = ng;
        parent[j] = i;
        push(ng + heur(nx, nz), j);
      }
    }
  }
  if (!found) return [];
  const out: [number, number][] = [];
  for (let k = goal; k >= 0; k = parent[k]) out.push([k % W, (k / W) | 0]);
  return out.reverse();
}

type SetFn = (x: number, y: number, z: number, id: number) => void;
type GetFn = (x: number, y: number, z: number) => number;

/** A road along a route: three wide, dirt path on the land (plants and trees cleared off it), planks over water, a
 *  lantern post beside it every 24 steps. Kept tiles (players' edits) are left alone: the road gaps there. */
function stampRoad(path: [number, number][], set: SetFn, get: GetFn, ground: (x: number, z: number) => { y: number; water: boolean }, kept: (x: number, z: number) => boolean): void {
  const done = new Set<number>();
  path.forEach(([px, pz], k) => {
    for (let oz = -1; oz <= 1; oz++)
      for (let ox = -1; ox <= 1; ox++) {
        const x = px + ox;
        const z = pz + oz;
        const key = z * WORLD_SIZE + x;
        if (done.has(key) || kept(x, z)) continue;
        done.add(key);
        const g = ground(x, z);
        if (g.y <= 0) continue;
        if (g.water) {
          set(x, Math.max(g.y + 1, SEA_LEVEL), z, B.OAK_PLANKS);
          continue;
        }
        const id = get(x, g.y, z);
        if (!SOLID[id] || id === B.OAK_PLANKS || id === B.STONE_BRICKS || id === B.COBBLESTONE || id === B.DIRT_PATH) continue; // a bridge, paving, a road
        set(x, g.y, z, B.DIRT_PATH);
        for (let y = g.y + 1; y <= g.y + 3; y++) if (get(x, y, z) !== B.AIR) set(x, y, z, B.AIR);
      }
    // trees off it: logs and leaves within 2 of the road, up to 10 over it
    const g0 = ground(px, pz);
    for (let oz = -2; oz <= 2; oz++)
      for (let ox = -2; ox <= 2; ox++) {
        if (kept(px + ox, pz + oz)) continue;
        for (let y = Math.max(1, g0.y + 1); y <= Math.min(WORLD_HEIGHT - 1, g0.y + 10); y++) if (TREE.has(get(px + ox, y, pz + oz))) set(px + ox, y, pz + oz, B.AIR);
      }
    // a lantern post beside it now and then
    if (k > 0 && k % 24 === 0 && k < path.length - 4) {
      const [nx, nz] = path[k + 1];
      const lx = px - (nz - pz) * 2;
      const lz = pz + (nx - px) * 2;
      const g = ground(lx, lz);
      if (!g.water && g.y > 0 && !kept(lx, lz) && SOLID[get(lx, g.y, lz)] && get(lx, g.y + 1, lz) === B.AIR && get(lx, g.y, lz) !== B.DIRT_PATH) {
        set(lx, g.y + 1, lz, B.OAK_FENCE);
        set(lx, g.y + 2, lz, B.OAK_FENCE);
        set(lx, g.y + 3, lz, B.LANTERN);
      }
    }
  });
}
