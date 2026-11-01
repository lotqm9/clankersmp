// The spawn hub (worldgen v3, survival): a safe zone around spawn built like a real server hub, in stone and wood
// with teal accents. Generated with the terrain (same seed, same hub, everywhere), so it can't
// differ between the client and the server. Only + - * / sqrt floor and integer hashes here (no trig), like the
// rest of worldgen, so every JavaScript engine builds exactly the same blocks.
//
// Layout (x east, z south, around the spawn centre; the spawn faces north to the monument):
//   plaza (r 11.6) with the sign monument on its north side (a diamond on top) and a teal block at the centre
//   four paths to the safe-zone border (r 44-46), a cobblestone ring with lamp posts outside it,
//     and a gateway on each path (two pillars and a beam: "Spawn" inside, "Wilderness" outside)
//   four boards beside the east and west paths: welcome + how to play, rules, the charity total, the latest update
//   north-east: the starter pavilion (crafting tables and furnaces anyone can use)
//   south: a fountain on the south path; south-east: a diamond of bluebells; north-west: a small grove; south-west:
//     flower beds; benches; lamps everywhere so the hub is lit at night

import { B } from "./blocks.ts";
import { SPAWN_X, SPAWN_Z, WORLD_HEIGHT, WORLD_SIZE, idx } from "./constants.ts";
import { hash2 } from "./noise.ts";
import { nextWater } from "./water.ts";

/** v10 (update 12): the safe zone is now the bigger hub's (shared/hub12.ts: 68, less any tiles kept for players'
 *  builds). The old hub below is still generated first, to its old size, so the tiles kept for builds stay as they
 *  were. */
export const SAFE_RADIUS = 68;
export const OLD_SAFE_RADIUS = 46; // the old safe zone (horizontal distance from the spawn centre, blocks)
export const HUB_FLAT = 48; // terrain is flat out to here, then blends into the wild by HUB_BLEND
export const HUB_BLEND = 64;

export interface Panel {
  kind: "welcome" | "rules" | "charity" | "updates" | "spawn" | "wild" | "starter"
    // v10 (update 12): the bigger hub's signs and boards
    | "arrival" | "beacon" | "hall" | "news" | "tips" | "directions" | "gate" | "harbour"
    // clankersmp: what the experiment is (in the hall that was the charity's; an old hub's "charity" board shows it too)
    | "experiment";
  x: number; // centre of the panel face, world coordinates
  y: number;
  z: number;
  w: number; // size in blocks
  h: number;
  nx: number; // the face's outward normal (x/z)
  nz: number;
  /** v10: a strip sign's words (else the kind's own), a board's lines (the directions board). */
  text?: string;
  lines?: string[];
}

export interface HubInfo {
  safeRadius: number;
  panels: Panel[];
  /** Crafting tables and furnaces in the starter pavilion. */
  stations: { x: number; y: number; z: number; id: number }[];
}

const CX = SPAWN_X;
const CZ = SPAWN_Z;

// on the diagonals, clear of the paths, the boards and the view from spawn to the monument
const PLAZA_POSTS: [number, number][] = [[7, 7], [-7, 7], [-7, -7], [7, -7]];
const RING_POSTS: [number, number][] = [
  [47, 6], [44, 18], [37, 29], [29, 37], [18, 44], [6, 47], [-6, 47], [-18, 44], [-29, 37], [-37, 29], [-44, 18], [-47, 6],
  [-47, -6], [-44, -18], [-37, -29], [-29, -37], [-18, -44], [-6, -47], [6, -47], [18, -44], [29, -37], [37, -29], [44, -18], [47, -6],
];

/** Directions of the four paths: [along x, along z] (north first). */
const DIRS: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];

export function buildHub(blocks: Uint8Array, sh: number, seed: number): HubInfo {
  const set = (x: number, y: number, z: number, id: number) => {
    if (x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE || y < 0 || y >= WORLD_HEIGHT) return;
    blocks[idx(x, y, z)] = id;
  };
  const get = (x: number, y: number, z: number) => (x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE || y < 0 || y >= WORLD_HEIGHT ? B.STONE : blocks[idx(x, y, z)]);
  const r2 = (dx: number, dz: number) => (dx + 0.5) * (dx + 0.5) + (dz + 0.5) * (dz + 0.5);
  const floor = (dx: number, dz: number, id: number) => set(CX + dx, sh, CZ + dz, id);
  const panels: Panel[] = [];
  const stations: HubInfo["stations"] = [];

  // ---- the ground: flat grass over dirt and stone, nothing standing on it (the terrain was flattened to here)
  const R = HUB_FLAT + 1;
  for (let dz = -R; dz <= R; dz++)
    for (let dx = -R; dx <= R; dx++) {
      if (r2(dx, dz) > (HUB_FLAT + 0.5) * (HUB_FLAT + 0.5)) continue;
      const x = CX + dx;
      const z = CZ + dz;
      for (let y = sh - 8; y < sh - 3; y++) if (get(x, y, z) === B.AIR || get(x, y, z) === B.WATER) set(x, y, z, B.STONE);
      for (let y = sh - 3; y < sh; y++) set(x, y, z, B.DIRT);
      set(x, sh, z, B.GRASS);
      for (let y = sh + 1; y < Math.min(WORLD_HEIGHT, sh + 40); y++) set(x, y, z, B.AIR);
    }

  const lampPost = (x: number, z: number, h = 2) => {
    set(x, sh, z, B.COBBLESTONE);
    for (let k = 1; k <= h; k++) set(x, sh + k, z, B.OAK_FENCE);
    set(x, sh + h + 1, z, B.LAMP);
  };

  // ---- plaza: stone bricks with a cobblestone rim, a smooth stone ring, a teal block at the centre
  for (let dz = -12; dz <= 12; dz++)
    for (let dx = -12; dx <= 12; dx++) {
      const d2 = r2(dx, dz);
      if (d2 > 11.6 * 11.6) continue;
      let id: number = B.STONE_BRICKS;
      if (d2 > 10.4 * 10.4) id = B.COBBLESTONE;
      else if (d2 > 4.6 * 4.6 && d2 <= 5.5 * 5.5) id = B.STONE;
      floor(dx, dz, id);
    }
  floor(0, 0, B.SMOOTH_TEAL);
  for (const [ax, az] of DIRS) floor(ax * 11, az * 11, B.SMOOTH_TEAL);
  for (const [dx, dz] of PLAZA_POSTS) lampPost(CX + dx, CZ + dz);

  // ---- the monument: the sign board between two log posts, a diamond on top
  const bz = CZ - 7;
  const bx0 = CX - 5;
  const bx1 = CX + 5;
  for (let y = sh + 1; y <= sh + 6; y++) {
    set(bx0, y, bz, B.OAK_LOG);
    set(bx1, y, bz, B.OAK_LOG);
  }
  for (let x = bx0 + 1; x < bx1; x++) {
    for (let y = sh + 3; y <= sh + 6; y++) set(x, y, bz, B.OAK_PLANKS);
    set(x, sh, bz, B.COBBLESTONE);
  }
  set(bx0, sh + 7, bz, B.TORCH);
  set(bx1, sh + 7, bz, B.TORCH);
  set(bx0, sh, bz, B.COBBLESTONE);
  set(bx1, sh, bz, B.COBBLESTONE);
  const top = sh + 12;
  GEM_ROWS.forEach((row, r) => {
    for (let c = 0; c < 7; c++) if (row[c] === "#") set(CX - 3 + c, top - r, bz, B.DIAMOND_BLOCK);
  });

  // ---- paths: stone bricks with cobblestone edges, from the plaza to the border; gravel trails beyond it
  for (const [ax, az] of DIRS) {
    const px = az !== 0 ? 1 : 0; // lateral axis
    const pz = ax !== 0 ? 1 : 0;
    for (let a = 11; a <= OLD_SAFE_RADIUS + 1; a++) {
      for (let off = -1; off <= 1; off++) {
        const dx = ax * a + px * off;
        const dz = az * a + pz * off;
        if (r2(dx, dz) <= 10.4 * 10.4) continue;
        let id: number = off === 0 ? B.STONE_BRICKS : B.COBBLESTONE;
        if (off === 0 && hash2(dx, dz, seed + 501) < 0.12) id = B.COBBLESTONE;
        floor(dx, dz, id);
      }
    }
    // lamp posts along the path, alternating sides
    for (const [a, side] of [[17, 1], [25, -1], [33, 1], [40, -1]] as [number, number][]) lampPost(CX + ax * a + px * 2 * side, CZ + az * a + pz * 2 * side);
    // the trail outside: gravel at the ground's height, thinning out
    for (let a = OLD_SAFE_RADIUS + 2; a <= OLD_SAFE_RADIUS + 16; a++)
      for (let off = -1; off <= 1; off++) {
        const x = CX + ax * a + px * off;
        const z = CZ + az * a + pz * off;
        if (hash2(x, z, seed + 502) < (a - OLD_SAFE_RADIUS - 2) / 16) continue;
        let y = Math.min(WORLD_HEIGHT - 2, sh + 12);
        while (y > 1 && (get(x, y, z) === B.AIR || get(x, y, z) === B.TALL_GRASS || get(x, y, z) === B.DANDELION || get(x, y, z) === B.POPPY)) y--;
        const g = get(x, y, z);
        if (g === B.GRASS || g === B.DIRT || g === B.SAND) {
          set(x, y, z, B.GRAVEL);
          const above = get(x, y + 1, z);
          if (above === B.TALL_GRASS || above === B.DANDELION || above === B.POPPY) set(x, y + 1, z, B.AIR);
        }
      }
  }

  // ---- the border: a cobblestone ring, lamp posts just outside it, and a gateway on each path
  for (let dz = -OLD_SAFE_RADIUS - 1; dz <= OLD_SAFE_RADIUS + 1; dz++)
    for (let dx = -OLD_SAFE_RADIUS - 1; dx <= OLD_SAFE_RADIUS + 1; dx++) {
      const d2 = r2(dx, dz);
      if (d2 < 44.3 * 44.3 || d2 > 45.6 * 45.6) continue;
      if (Math.abs(dx) <= 1 || Math.abs(dz) <= 1) continue; // the paths cross it
      floor(dx, dz, B.COBBLESTONE);
    }
  for (const [dx, dz] of RING_POSTS) lampPost(CX + dx, CZ + dz);
  for (const [ax, az] of DIRS) {
    const px = az !== 0 ? 1 : 0;
    const pz = ax !== 0 ? 1 : 0;
    const a = 45;
    for (const side of [-1, 1]) {
      const x = CX + ax * a + px * 3 * side;
      const z = CZ + az * a + pz * 3 * side;
      set(x, sh, z, B.STONE_BRICKS);
      for (let k = 1; k <= 4; k++) set(x, sh + k, z, k === 3 ? B.SMOOTH_TEAL : B.STONE_BRICKS);
      set(x, sh + 5, z, B.LAMP);
    }
    for (let off = -2; off <= 2; off++) set(CX + ax * a + px * off, sh + 4, CZ + az * a + pz * off, B.STONE_BRICK_SLAB + 1);
    // panel faces on the beam: inward "Spawn", outward "Wilderness"
    const bxc = CX + ax * a + 0.5;
    const bzc = CZ + az * a + 0.5;
    panels.push({ kind: "spawn", x: bxc - ax * 0.51, y: sh + 4.75, z: bzc - az * 0.51, w: 5, h: 0.5, nx: -ax, nz: -az });
    panels.push({ kind: "wild", x: bxc + ax * 0.51, y: sh + 4.75, z: bzc + az * 0.51, w: 5, h: 0.5, nx: ax, nz: az });
  }

  // ---- the four boards beside the east and west paths (7 wide, 4 tall, on two log posts, torches on top)
  const board = (bx: number, z0: number, facing: 1 | -1, kind: Panel["kind"]) => {
    // facing +1: the face looks east (+x); -1: west
    for (let y = sh + 1; y <= sh + 6; y++) {
      set(bx, y, z0 - 1, B.OAK_LOG);
      set(bx, y, z0 + 7, B.OAK_LOG);
    }
    set(bx, sh + 7, z0 - 1, B.TORCH);
    set(bx, sh + 7, z0 + 7, B.TORCH);
    for (let z = z0 - 1; z <= z0 + 7; z++) set(bx, sh, z, B.COBBLESTONE);
    for (let z = z0; z < z0 + 7; z++) {
      for (let y = sh + 2; y <= sh + 5; y++) set(bx, y, z, B.OAK_PLANKS);
      set(bx, sh + 6, z, B.OAK_SLAB);
      set(bx, sh + 1, z, B.OAK_FENCE);
    }
    // a strip of path in front of it
    for (let z = z0 - 1; z <= z0 + 7; z++) {
      const fx = bx + facing;
      if (get(fx, sh, z) === B.GRASS) set(fx, sh, z, B.COBBLESTONE);
    }
    panels.push({ kind, x: bx + 0.5 + facing * 0.51, y: sh + 4, z: z0 + 3.5, w: 7, h: 4, nx: facing, nz: 0 });
  };
  board(CX - 14, CZ - 11, 1, "welcome");
  board(CX - 14, CZ + 5, 1, "rules");
  board(CX + 14, CZ - 11, -1, "charity");
  board(CX + 14, CZ + 5, -1, "updates");

  // ---- the starter pavilion (north-east): an open oak pavilion with crafting tables and furnaces for everyone
  {
    const x0 = CX + 16;
    const x1 = CX + 28;
    const z0 = CZ - 28;
    const z1 = CZ - 19;
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) set(x, sh, z, B.OAK_PLANKS);
    for (let x = x0 - 1; x <= x1 + 1; x++) {
      set(x, sh, z0 - 1, B.COBBLESTONE);
      set(x, sh, z1 + 1, B.COBBLESTONE);
    }
    for (let z = z0 - 1; z <= z1 + 1; z++) {
      set(x0 - 1, sh, z, B.COBBLESTONE);
      set(x1 + 1, sh, z, B.COBBLESTONE);
    }
    const postsAt: [number, number][] = [[x0, z0], [x1, z0], [x0, z1], [x1, z1], [CX + 22, z0], [CX + 22, z1]];
    for (const [x, z] of postsAt) for (let y = sh + 1; y <= sh + 4; y++) set(x, y, z, B.OAK_LOG);
    // roof: planks with stair eaves all round and lamps set into it
    for (let z = z0 - 1; z <= z1 + 1; z++)
      for (let x = x0 - 1; x <= x1 + 1; x++) {
        const edge = z === z0 - 1 || z === z1 + 1 || x === x0 - 1 || x === x1 + 1;
        if (!edge) {
          set(x, sh + 5, z, B.OAK_PLANKS);
          continue;
        }
        // eaves: stairs facing out (high side inward)
        let facing = 0;
        if (z === z0 - 1) facing = 2;
        else if (z === z1 + 1) facing = 0;
        else if (x === x0 - 1) facing = 1;
        else facing = 3;
        set(x, sh + 5, z, B.OAK_STAIRS + facing);
      }
    for (const [x, z] of [[x0 + 3, z0 + 3], [x1 - 3, z0 + 3], [x0 + 3, z1 - 2], [x1 - 3, z1 - 2], [CX + 22, CZ - 23]] as [number, number][]) set(x, sh + 5, z, B.LAMP);
    for (const [x, z] of [[x0 + 1, z0 + 1], [x0 + 2, z0 + 1], [x0 + 3, z0 + 1], [x0 + 4, z0 + 1]] as [number, number][]) {
      set(x, sh + 1, z, B.CRAFTING_TABLE);
      stations.push({ x, y: sh + 1, z, id: B.CRAFTING_TABLE });
    }
    for (const [x, z] of [[x1 - 1, z0 + 1], [x1 - 2, z0 + 1], [x1 - 3, z0 + 1], [x1 - 4, z0 + 1]] as [number, number][]) {
      set(x, sh + 1, z, B.FURNACE + 2); // front to the south, into the pavilion
      stations.push({ x, y: sh + 1, z, id: B.FURNACE + 2 });
    }
    // a spur to the east path
    for (let z = z1 + 2; z <= CZ - 2; z++) for (let x = CX + 21; x <= CX + 23; x++) set(x, sh, z, x === CX + 22 ? B.STONE_BRICKS : B.COBBLESTONE);
    panels.push({ kind: "starter", x: CX + 22.5, y: sh + 5.5, z: z1 + 2 + 0.01, w: 7, h: 0.9, nx: 0, nz: 1 });
  }

  // ---- the fountain on the south path: a paved circle, a basin, and a pillar with water spilling off its top
  {
    const fz = 26;
    for (let dz = -8; dz <= 8; dz++)
      for (let dx = -8; dx <= 8; dx++) {
        const d2 = r2(dx, dz);
        if (d2 > 7.6 * 7.6) continue;
        floor(dx, fz + dz, d2 > 6.6 * 6.6 ? B.COBBLESTONE : B.STONE_BRICKS);
      }
    for (let dz = -5; dz <= 5; dz++)
      for (let dx = -5; dx <= 5; dx++) {
        const d2 = r2(dx, dz);
        if (d2 > 4.6 * 4.6) continue;
        const x = CX + dx;
        const z = CZ + fz + dz;
        if (d2 > 3.6 * 3.6) {
          set(x, sh, z, B.STONE_BRICKS);
          set(x, sh + 1, z, B.STONE_BRICK_SLAB);
        } else {
          set(x, sh - 1, z, B.STONE_BRICKS);
          set(x, sh, z, B.WATER);
        }
      }
    for (let y = sh; y <= sh + 2; y++) set(CX, y, CZ + fz, B.STONE_BRICKS);
    set(CX, sh + 3, CZ + fz, B.WATER);
    settleWater(blocks, CX - 5, sh - 1, CZ + fz - 5, CX + 5, sh + 4, CZ + fz + 5);
    for (const [dx, dz] of [[-6, -6], [6, -6], [-6, 6], [6, 6]] as [number, number][]) lampPost(CX + dx, CZ + fz + dz);
  }

  // ---- a diamond of bluebells (south-east), two blocks per pixel
  {
    const ox = CX + 18;
    const oz = CZ + 16;
    GEM_ROWS.forEach((row, r) => {
      for (let c = 0; c < 7; c++) {
        if (row[c] !== "#") continue;
        for (let k = 0; k < 4; k++) {
          const x = ox + c * 2 + (k & 1);
          const z = oz + r * 2 + (k >> 1);
          set(x, sh, z, B.GRASS);
          set(x, sh + 1, z, B.BLUEBELL);
        }
      }
    });
    // a low hedge frame and two benches facing it
    for (let x = ox - 2; x <= ox + 17; x++) {
      set(x, sh + 1, oz - 4, B.OAK_LEAVES);
      set(x, sh + 1, oz + 13, B.OAK_LEAVES);
    }
    for (const x of [ox + 5, ox + 6, ox + 9, ox + 10]) set(x, sh + 1, oz + 14, B.OAK_STAIRS + 2);
  }

  // ---- the grove (north-west): small oaks around a lawn, benches facing the north path
  for (const [dx, dz, th] of [[-24, -24, 4], [-30, -16, 5], [-17, -31, 4], [-34, -30, 5], [-22, -36, 4]] as [number, number, number][]) {
    hubTree(blocks, CX + dx, sh + 1, CZ + dz, th);
  }
  for (const z of [CZ - 20, CZ - 21, CZ - 30, CZ - 31]) set(CX - 3, sh + 1, z, B.OAK_STAIRS + 3);
  for (const z of [CZ - 20, CZ - 21, CZ - 30, CZ - 31]) set(CX + 3, sh + 1, z, B.OAK_STAIRS + 1);

  // ---- flower beds (south-west): rows of dandelions and poppies between gravel walks
  for (let bed = 0; bed < 4; bed++) {
    const z0 = CZ + 16 + bed * 4;
    for (let x = CX - 30; x <= CX - 16; x++) {
      for (let k = 0; k < 2; k++) {
        set(x, sh, z0 + k, B.GRASS);
        set(x, sh + 1, z0 + k, bed % 2 === 0 ? B.DANDELION : B.POPPY);
      }
      set(x, sh, z0 + 2, B.GRAVEL);
    }
  }

  // ---- a little ground cover on the remaining lawn
  for (let dz = -HUB_FLAT; dz <= HUB_FLAT; dz++)
    for (let dx = -HUB_FLAT; dx <= HUB_FLAT; dx++) {
      if (r2(dx, dz) > 47 * 47 || r2(dx, dz) < 12.5 * 12.5) continue;
      const x = CX + dx;
      const z = CZ + dz;
      if (get(x, sh, z) !== B.GRASS || get(x, sh + 1, z) !== B.AIR) continue;
      // keep the lawn next to paths and buildings tidy
      let near = false;
      for (let k = -1; k <= 1 && !near; k++) for (let j = -1; j <= 1 && !near; j++) if (get(x + k, sh, z + j) !== B.GRASS) near = true;
      if (near) continue;
      const h = hash2(x, z, seed + 503);
      if (h < 0.045) set(x, sh + 1, z, B.TALL_GRASS);
      else if (h < 0.052) set(x, sh + 1, z, hash2(x, z, seed + 504) < 0.5 ? B.DANDELION : B.POPPY);
    }

  return { safeRadius: OLD_SAFE_RADIUS, panels, stations };
}

/** A cut gem on a 7 x 5 grid (row 0 at the top): the diamonds on the monuments, the Beacon and the garden. */
export const GEM_ROWS = [".#####.", "#######", ".#####.", "..###..", "...#..."];

/** A small round oak for the grove (always the same shape). */
export function hubTree(blocks: Uint8Array, x: number, y: number, z: number, th: number): void {
  for (let yy = y + th - 2; yy <= y + th + 1; yy++) {
    const rad = yy <= y + th - 1 ? 2 : 1;
    for (let dx = -rad; dx <= rad; dx++)
      for (let dz = -rad; dz <= rad; dz++) {
        if (Math.abs(dx) === rad && Math.abs(dz) === rad && rad === 2) continue;
        if (yy === y + th + 1 && Math.abs(dx) + Math.abs(dz) > 1) continue;
        const i = idx(x + dx, yy, z + dz);
        if (blocks[i] === B.AIR) blocks[i] = B.OAK_LEAVES;
      }
  }
  for (let k = 0; k < th; k++) blocks[idx(x, y + k, z)] = B.OAK_LOG;
  blocks[idx(x, y - 1, z)] = B.DIRT;
}

/** Run the shared water rules on a small box until nothing changes, so worldgen ships the fountain already flowing
 *  (the server's water never needs to touch it). */
export function settleWater(blocks: Uint8Array, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
  const get = (x: number, y: number, z: number) => (x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE || y < 0 || y >= WORLD_HEIGHT ? B.STONE : blocks[idx(x, y, z)]);
  for (let round = 0; round < 64; round++) {
    const changes: [number, number][] = [];
    for (let y = y1; y >= y0; y--)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          const cur = blocks[idx(x, y, z)];
          const next = nextWater(get, x, y, z);
          if (next >= 0 && next !== cur) changes.push([idx(x, y, z), next]);
        }
    if (!changes.length) return;
    for (const [i, id] of changes) blocks[i] = id;
  }
}
