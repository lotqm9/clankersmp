// The islands (world update, protocol v8): six smaller islands out in the open sea around the main island, each with
// its own character and worth sailing to:
//   Palm Cay (north-west)      white sand, palms that drop coconuts, a green middle, clay in the shallows
//   The Crag (north-east)      a tall rock with ore veins in its cliffs and a sea cave you can row into (diamonds
//                              at the back)
//   Old Keep (south-west)      a grassy hill crowned by a ruined keep in mossy stone, with a treasure chest
//   Bluebell Isle (south-east) a meadow of bluebells (the blue for dyes) around a clay pond with sugar cane
//   Gull Rock, The Sandbar     a sea stack and a little sand spit with two palms, for the way there
// They are stamped into the generated world as its very last step, and only into columns that are open ocean (water
// at sea level, nothing above), so the main island, the hub and every edit players made there stay exactly as they
// were: no world reset. Deterministic like the rest of worldgen: + - * / floor sqrt, integer hashes and simplex
// noise only (no trig), so every JavaScript engine stamps the same islands.

import { B } from "./blocks.ts";
import { SEA_LEVEL, WORLD_HEIGHT, WORLD_SIZE, idx } from "./constants.ts";
import { clamp, fbm, hash2, lerp, makeSimplex2D, mulberry32, smoothstep } from "./noise.ts";
import { growTree } from "./trees.ts";

export type IslandKind = "palm" | "crag" | "ruin" | "meadow" | "rock" | "sandbar";

export interface Island {
  key: string;
  name: string;
  kind: IslandKind;
  x: number; // centre
  z: number;
  r: number; // radius of the land (the shelf reaches further)
}

// Centres picked from the open sea (tools: .local/pa/ocean.ts measured each spot's distance to land and the edge).
export const ISLANDS: Island[] = [
  { key: "palm_cay", name: "Palm Cay", kind: "palm", x: 52, z: 52, r: 19 },
  { key: "the_crag", name: "The Crag", kind: "crag", x: 456, z: 56, r: 22 },
  { key: "old_keep", name: "Old Keep", kind: "ruin", x: 60, z: 436, r: 24 },
  { key: "bluebell_isle", name: "Bluebell Isle", kind: "meadow", x: 460, z: 460, r: 20 },
  { key: "gull_rock", name: "Gull Rock", kind: "rock", x: 476, z: 380, r: 6 },
  { key: "the_sandbar", name: "The Sandbar", kind: "sandbar", x: 172, z: 36, r: 7 },
];

/** How far the underwater shelf reaches past the shore, as a fraction of the radius. */
const SHELF = 0.45;
/** The most the coast noise bends a column's distance on each axis, as a fraction of the radius. */
const WARP = 0.25;
const SEA = SEA_LEVEL;

/** The radius around an island's centre that it may touch (land, beach and shelf). */
export const islandReach = (s: Island) => Math.ceil(s.r * (1 + SHELF + 1.42 * WARP)) + 2;

export interface IslandInfo {
  list: Island[];
  /** Treasure chests: the server fills each one once per world. */
  chests: { x: number; y: number; z: number; island: string }[];
  /** How many cells the islands changed (tests). */
  changed: number;
}

const FREE = (id: number) => id === B.AIR || id === B.TALL_GRASS || id === B.DANDELION || id === B.POPPY || id === B.BLUEBELL;

export function buildIslands(blocks: Uint8Array, seed: number): IslandInfo {
  const info: IslandInfo = { list: ISLANDS, chests: [], changed: 0 };
  const nWarpX = makeSimplex2D(seed ^ 0x15a1c3);
  const nWarpZ = makeSimplex2D(seed ^ 0x25a2d4);
  const nDetail = makeSimplex2D(seed ^ 0x35a3e5);
  const nPatch = makeSimplex2D(seed ^ 0x45a4f6);
  const inW = (x: number, y: number, z: number) => x >= 0 && z >= 0 && x < WORLD_SIZE && z < WORLD_SIZE && y >= 0 && y < WORLD_HEIGHT;
  const get = (x: number, y: number, z: number) => (inW(x, y, z) ? blocks[idx(x, y, z)] : B.STONE);
  const set = (x: number, y: number, z: number, id: number) => {
    if (!inW(x, y, z)) return;
    const i = idx(x, y, z);
    if (blocks[i] === id) return;
    blocks[i] = id;
    info.changed++;
  };
  /** Open sea: water at sea level with air above (only these columns are ever touched). */
  const ocean = (x: number, z: number) => get(x, SEA - 1, z) === B.WATER && get(x, SEA, z) === B.AIR;
  const floorOf = (x: number, z: number) => {
    let y = SEA - 1;
    while (y > 0 && get(x, y, z) === B.WATER) y--;
    return y;
  };

  for (const s of ISLANDS) {
    const R = islandReach(s);
    const D = R * 2 + 1;
    const H = new Int16Array(D * D).fill(-1); // target surface y per column (-1: untouched)
    const TT = new Float32Array(D * D); // t: 1 at the centre, 0 at the shore, negative on the shelf
    const at = (dx: number, dz: number) => (dz + R) * D + dx + R;
    // ---- pass 1: the shape
    for (let dz = -R; dz <= R; dz++)
      for (let dx = -R; dx <= R; dx++) {
        const x = s.x + dx;
        const z = s.z + dz;
        if (x < 2 || z < 2 || x >= WORLD_SIZE - 2 || z >= WORLD_SIZE - 2 || !ocean(x, z)) continue;
        const wx = dx + clamp(fbm(nWarpX, x / 15, z / 15, 2), -1, 1) * WARP * s.r;
        const wz = dz + clamp(fbm(nWarpZ, x / 15, z / 15, 2), -1, 1) * WARP * s.r;
        const t = 1 - Math.sqrt(wx * wx + wz * wz) / s.r;
        if (t <= -SHELF) continue;
        const floor0 = floorOf(x, z);
        let h: number;
        if (t > 0) h = Math.floor(landHeight(s.kind, t, nDetail(x / 9, z / 9)));
        else h = Math.floor(lerp(floor0, SEA - 2, smoothstep(-SHELF, 0, t)));
        H[at(dx, dz)] = Math.max(h, floor0);
        TT[at(dx, dz)] = t;
      }
    // the keep stands on a level hilltop
    if (s.kind === "ruin") {
      for (let dz = -7; dz <= 7; dz++) for (let dx = -7; dx <= 7; dx++) if (H[at(dx, dz)] >= 0) H[at(dx, dz)] = Math.max(H[at(dx, dz)], SEA + 8);
      for (let dz = -6; dz <= 6; dz++) for (let dx = -6; dx <= 6; dx++) if (H[at(dx, dz)] >= 0) H[at(dx, dz)] = SEA + 8;
    }
    // Bluebell Isle's pond: a bowl that the sea water already in it fills (sloping down to a low rim, no pit)
    const pondAt: [number, number] = [-5, 3];
    if (s.kind === "meadow") {
      for (let dz = -8; dz <= 8; dz++)
        for (let dx = -8; dx <= 8; dx++) {
          const k = at(pondAt[0] + dx, pondAt[1] + dz);
          if (H[k] < 0) continue;
          const d = Math.sqrt(dx * dx + dz * dz);
          if (d <= 3.2) H[k] = SEA - 3;
          else if (d <= 4.4) H[k] = SEA - 1;
          else if (d <= 6) H[k] = Math.min(H[k], SEA);
          else if (d <= 7.6) H[k] = Math.min(H[k], SEA + 1);
        }
    }
    const steep = (dx: number, dz: number) => {
      const h = H[at(dx, dz)];
      let m = 0;
      for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (Math.abs(dx + ax) > R || Math.abs(dz + az) > R) continue;
        const n = H[at(dx + ax, dz + az)];
        if (n >= 0) m = Math.max(m, Math.abs(n - h));
      }
      return m;
    };
    // ---- pass 2: fill the columns
    for (let dz = -R; dz <= R; dz++)
      for (let dx = -R; dx <= R; dx++) {
        const h = H[at(dx, dz)];
        if (h < 0) continue;
        const x = s.x + dx;
        const z = s.z + dz;
        const floor0 = floorOf(x, z);
        if (h <= floor0) continue;
        const t = TT[at(dx, dz)];
        const p = nPatch(x / 7, z / 7);
        const top = surfaceBlock(s.kind, h, t, p, steep(dx, dz), hash2(x, z, seed + 901));
        for (let y = floor0 + 1; y <= h; y++) {
          const depth = h - y;
          let id: number = B.STONE;
          if (depth === 0) id = top;
          else if (depth <= 3) {
            if (top === B.GRASS) id = B.DIRT;
            else if (top === B.SAND) id = B.SAND;
            else if (top === B.CLAY) id = depth === 1 ? B.CLAY : B.SAND;
            else if (top === B.GRAVEL && depth === 1) id = B.GRAVEL;
          }
          set(x, y, z, id);
        }
      }
    // ---- pass 3: what grows and what was built
    const rand = mulberry32((seed * 131 + s.x * 7919 + s.z * 104729) | 0);
    const surf = (dx: number, dz: number) => H[at(dx, dz)];
    const land = (dx: number, dz: number) => Math.abs(dx) <= R && Math.abs(dz) <= R && surf(dx, dz) >= SEA && TT[at(dx, dz)] > 0;
    if (s.kind === "palm" || s.kind === "sandbar") {
      const palms: [number, number][] = [];
      const want = s.kind === "palm" ? 9 : 2;
      for (let k = 0; k < 400 && palms.length < want; k++) {
        const dx = Math.floor((rand() * 2 - 1) * s.r * 0.85);
        const dz = Math.floor((rand() * 2 - 1) * s.r * 0.85);
        if (!land(dx, dz) || TT[at(dx, dz)] < 0.12) continue;
        if (palms.some(([px, pz]) => (px - dx) ** 2 + (pz - dz) ** 2 < 20)) continue;
        palms.push([dx, dz]);
        palm(s.x + dx, surf(dx, dz) + 1, s.z + dz, 5 + Math.floor(rand() * 3), Math.floor(rand() * 4), get, set);
      }
    }
    if (s.kind === "crag") crag(s, R, surf, land, rand, get, set);
    if (s.kind === "ruin") {
      for (let k = 0, n = 0; k < 300 && n < 6; k++) {
        const dx = Math.floor((rand() * 2 - 1) * s.r * 0.8);
        const dz = Math.floor((rand() * 2 - 1) * s.r * 0.8);
        if (!land(dx, dz) || Math.abs(dx) < 9 && Math.abs(dz) < 9) continue;
        if (get(s.x + dx, surf(dx, dz), s.z + dz) !== B.GRASS) continue;
        growTree(blocks, s.x + dx, surf(dx, dz) + 1, s.z + dz, rand() < 0.3, seed + 77);
        n++;
      }
      info.chests.push(keep(s.x, SEA + 8, s.z, rand, get, set));
    }
    if (s.kind === "meadow") {
      pond(s.x + pondAt[0], s.z + pondAt[1], get, set, rand);
      for (let k = 0, n = 0; k < 200 && n < 3; k++) {
        const dx = Math.floor((rand() * 2 - 1) * s.r * 0.7);
        const dz = Math.floor((rand() * 2 - 1) * s.r * 0.7);
        if (!land(dx, dz) || (dx + 5) ** 2 + (dz - 3) ** 2 < 49) continue;
        if (get(s.x + dx, surf(dx, dz), s.z + dz) !== B.GRASS) continue;
        growTree(blocks, s.x + dx, surf(dx, dz) + 1, s.z + dz, rand() < 0.5, seed + 78);
        n++;
      }
    }
    // ground cover: bluebells (lots on Bluebell Isle), grass and a few other flowers
    for (let dz = -R; dz <= R; dz++)
      for (let dx = -R; dx <= R; dx++) {
        if (!land(dx, dz)) continue;
        const x = s.x + dx;
        const z = s.z + dz;
        const y = surf(dx, dz);
        if (get(x, y, z) !== B.GRASS || get(x, y + 1, z) !== B.AIR) continue;
        const r1 = hash2(x, z, seed + 911);
        // bluebells grow in drifts (thick on Bluebell Isle)
        const drift = smoothstep(-0.15, 0.45, nPatch(x / 9 + 40, z / 9 - 40));
        const bells = s.kind === "meadow" ? 0.06 + 0.42 * drift : s.kind === "palm" ? 0.02 + 0.08 * drift : s.kind === "ruin" ? 0.02 + 0.06 * drift : 0.02;
        if (r1 < bells) set(x, y + 1, z, B.BLUEBELL);
        else if (r1 < bells + 0.13) set(x, y + 1, z, B.TALL_GRASS);
        else if (r1 < bells + 0.16 && s.kind !== "palm") set(x, y + 1, z, hash2(x, z, seed + 912) < 0.5 ? B.DANDELION : B.POPPY);
      }
  }
  return info;
}

/** Land height from t (0 at the shore, 1 at the centre) and a little detail noise, per kind. */
function landHeight(kind: IslandKind, t: number, n: number): number {
  const base = SEA - 0.4;
  switch (kind) {
    case "palm":
      return base + smoothstep(0, 0.7, t) * 3 + n * 0.9 * smoothstep(0.1, 0.5, t);
    case "sandbar":
      return base + smoothstep(0, 0.7, t) * 1.6;
    case "crag":
      return base + smoothstep(0, 0.45, t) * 13 + smoothstep(0.35, 1, t) * 9 + n * 3 * smoothstep(0.2, 0.6, t);
    case "rock":
      return base + 1 + smoothstep(0, 0.55, t) * 12 + n * 1.5;
    case "ruin":
      return base + smoothstep(0, 0.8, t) * 9.5 + n * 0.8 * smoothstep(0.1, 0.5, t);
    case "meadow":
      return base + smoothstep(0, 0.6, t) * 3.2 + n * 0.8 * smoothstep(0.1, 0.4, t);
  }
}

/** The top block of a column. `p` is a patch noise (-1..1), `steep` the biggest height step to a neighbour. */
function surfaceBlock(kind: IslandKind, h: number, t: number, p: number, steep: number, r: number): number {
  const clayIsles = kind === "palm" || kind === "meadow" || kind === "sandbar";
  if (h < SEA - 1) {
    // the shelf under water: sand, gravel patches, and clay off the sandy isles
    if (clayIsles && p < -0.25 && h >= SEA - 5) return B.CLAY;
    return p > 0.45 ? B.GRAVEL : B.SAND;
  }
  if (h <= SEA) {
    if (kind === "crag" || kind === "rock") return p > -0.1 ? B.GRAVEL : B.STONE;
    if (clayIsles && p < -0.35 && h === SEA - 1) return B.CLAY;
    return B.SAND;
  }
  switch (kind) {
    case "palm":
      return t > 0.5 && h >= SEA + 2 ? B.GRASS : B.SAND;
    case "sandbar":
      return B.SAND;
    case "rock":
      return r < 0.12 ? B.GRAVEL : B.STONE;
    case "crag":
      if (steep >= 2 || h < SEA + 3) return p > 0.55 ? B.GRAVEL : B.STONE;
      return h > SEA + 8 && p > -0.3 ? B.GRASS : p > 0.5 ? B.GRAVEL : B.STONE;
    default:
      return h <= SEA + 1 && t < 0.15 ? B.SAND : B.GRASS;
  }
}

type Get = (x: number, y: number, z: number) => number;
type Set = (x: number, y: number, z: number, id: number) => void;

/** A palm: a ringed trunk that leans over a block two thirds of the way up, and a crown of drooping fronds. */
function palm(x: number, y: number, z: number, h: number, dir: number, get: Get, set: Set): void {
  if (y + h + 2 >= WORLD_HEIGHT) return;
  const [lx, lz] = [[1, 0], [0, 1], [-1, 0], [0, -1]][dir & 3];
  let tx = x;
  let tz = z;
  for (let j = 0; j < h; j++) {
    if (j === Math.floor(h * 0.65)) {
      tx += lx;
      tz += lz;
    }
    if (FREE(get(tx, y + j, tz))) set(tx, y + j, tz, B.PALM_LOG);
  }
  const top = y + h;
  const leaf = (ax: number, ay: number, az: number) => {
    if (FREE(get(tx + ax, top + ay, tz + az))) set(tx + ax, top + ay, tz + az, B.PALM_LEAVES);
  };
  leaf(0, 0, 0);
  leaf(0, 1, 0);
  for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    leaf(ax, 0, az);
    leaf(ax * 2, 0, az * 2);
    leaf(ax * 3, -1, az * 3);
  }
  for (const [ax, az] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    leaf(ax, 0, az);
    leaf(ax * 2, -1, az * 2);
  }
}

/** The Crag: ore veins showing in its cliffs (coal, iron, a little gold and glowing ruby), birches on the grassy top,
 *  and a sea cave on its east side, high enough to row into, with diamonds in the back wall. */
function crag(s: Island, R: number, surf: (dx: number, dz: number) => number, land: (dx: number, dz: number) => boolean, rand: () => number, get: Get, set: Set): void {
  // exposed stone: a stone cell of the crag with air beside it
  const faces: [number, number, number][] = [];
  for (let dz = -R; dz <= R; dz++)
    for (let dx = -R; dx <= R; dx++) {
      if (!land(dx, dz)) continue;
      const x = s.x + dx;
      const z = s.z + dz;
      for (let y = SEA; y <= surf(dx, dz); y++) {
        if (get(x, y, z) !== B.STONE) continue;
        if (get(x + 1, y, z) === B.AIR || get(x - 1, y, z) === B.AIR || get(x, y, z + 1) === B.AIR || get(x, y, z - 1) === B.AIR || get(x, y + 1, z) === B.AIR) faces.push([x, y, z]);
      }
    }
  const vein = (id: number, count: number, len: [number, number]) => {
    for (let v = 0; v < count && faces.length; v++) {
      let [x, y, z] = faces[Math.floor(rand() * faces.length)];
      const n = len[0] + Math.floor(rand() * (len[1] - len[0] + 1));
      for (let k = 0; k < n; k++) {
        if (get(x, y, z) === B.STONE) set(x, y, z, id);
        const d = Math.floor(rand() * 6);
        x += d === 0 ? 1 : d === 1 ? -1 : 0;
        y += d === 2 ? 1 : d === 3 ? -1 : 0;
        z += d === 4 ? 1 : d === 5 ? -1 : 0;
      }
    }
  };
  vein(B.COAL_ORE, 16, [4, 8]);
  vein(B.IRON_ORE, 11, [3, 6]);
  vein(B.GOLD_ORE, 3, [2, 4]);
  vein(B.RUBY_ORE, 4, [2, 4]);
  // birches on the grass up top
  for (let k = 0, n = 0; k < 200 && n < 4; k++) {
    const dx = Math.floor((rand() * 2 - 1) * s.r * 0.6);
    const dz = Math.floor((rand() * 2 - 1) * s.r * 0.6);
    if (!land(dx, dz) || get(s.x + dx, surf(dx, dz), s.z + dz) !== B.GRASS) continue;
    growTree0(s.x + dx, surf(dx, dz) + 1, s.z + dz, get, set, rand);
    n++;
  }
  // the sea cave: from the east shore straight in, water below sea level and air above
  let mouth = 0;
  for (let dx = 0; dx <= R; dx++) if (land(dx, 0)) mouth = dx;
  const endX = s.x + Math.max(2, Math.floor(s.r * 0.15));
  for (let x = s.x + mouth + 1; x >= endX; x--) {
    for (let z = s.z - 3; z <= s.z + 3; z++)
      for (let y = SEA - 2; y <= SEA + 4; y++) {
        const dz = (z - s.z) / 2.6;
        const dy = (y + 0.5 - (SEA + 0.5)) / 3.2;
        if (dz * dz + dy * dy >= 1) continue;
        if (get(x, y, z) === B.WATER || get(x, y, z) === B.AIR) continue;
        set(x, y, z, y <= SEA - 1 ? B.WATER : B.AIR);
      }
  }
  // a dry ledge at the back, and the diamonds in the wall behind it (with a little gold)
  for (let z = s.z - 1; z <= s.z + 1; z++) {
    set(endX, SEA - 1, z, B.STONE);
    set(endX + 1, SEA - 1, z, B.STONE);
    set(endX, SEA - 2, z, B.STONE);
    set(endX + 1, SEA - 2, z, B.STONE);
  }
  const wall = endX - 1;
  for (const [y, z, id] of [[SEA, s.z, B.DIAMOND_ORE], [SEA + 1, s.z, B.DIAMOND_ORE], [SEA, s.z + 1, B.DIAMOND_ORE], [SEA + 1, s.z - 1, B.GOLD_ORE], [SEA + 2, s.z, B.GOLD_ORE]] as [number, number, number][]) {
    if (get(wall, y, z) === B.STONE || get(wall, y, z) === B.AIR) set(wall, y, z, id);
  }
}

/** A small birch for the Crag (the classic shape, like worldgen's), written through `set`. */
function growTree0(x: number, y: number, z: number, get: Get, set: Set, rand: () => number): void {
  const th = 5 + Math.floor(rand() * 2);
  if (y + th + 1 >= WORLD_HEIGHT) return;
  for (let yy = y + th - 3; yy <= y + th; yy++) {
    const i4 = yy - (y + th);
    const rad = 1 - Math.trunc(i4 / 2);
    for (let dx = -rad; dx <= rad; dx++)
      for (let dz = -rad; dz <= rad; dz++) {
        const corner = Math.abs(dx) === rad && Math.abs(dz) === rad;
        if (corner && (i4 === 0 || rand() < 0.5)) continue;
        if (FREE(get(x + dx, yy, z + dz))) set(x + dx, yy, z + dz, B.BIRCH_LEAVES);
      }
  }
  for (let j = 0; j < th; j++) set(x, y + j, z, B.BIRCH_LOG);
  set(x, y - 1, z, B.DIRT);
}

/** Old Keep: a ruined square keep in mossy stone on the hilltop (centre cx, cz, floor at fy): broken walls of
 *  uneven height, taller corner towers, a gateway on the south side, a crumbling stair, ivy (leaves) on the wall
 *  tops, and the treasure chest in the north-east corner. Returns the chest. */
function keep(cx: number, fy: number, cz: number, rand: () => number, get: Get, set: Set): { x: number; y: number; z: number; island: string } {
  const S = 4;
  const stones = [B.STONE_BRICKS, B.MOSSY_STONE_BRICKS, B.MOSSY_STONE_BRICKS, B.COBBLESTONE, B.MOSSY_COBBLE];
  const stone = () => stones[Math.floor(rand() * stones.length)];
  // the floor, and nothing growing inside
  for (let dz = -S; dz <= S; dz++)
    for (let dx = -S; dx <= S; dx++) {
      const r = rand();
      set(cx + dx, fy, cz + dz, r < 0.55 ? B.STONE_BRICKS : r < 0.82 ? B.MOSSY_STONE_BRICKS : r < 0.93 ? B.COBBLESTONE : B.GRAVEL);
      for (let y = fy + 1; y <= fy + 8; y++) set(cx + dx, y, cz + dz, B.AIR);
    }
  // the walls
  for (let dz = -S; dz <= S; dz++)
    for (let dx = -S; dx <= S; dx++) {
      if (Math.abs(dx) !== S && Math.abs(dz) !== S) continue;
      const corner = Math.abs(dx) === S && Math.abs(dz) === S;
      const gate = dz === S && (dx === 0 || dx === 1);
      if (gate) continue;
      let h = corner ? 5 + Math.floor(rand() * 2) : 1 + Math.floor(rand() * 3.6);
      if (!corner && rand() < 0.12) h = 0; // fallen in
      for (let k = 1; k <= h; k++) set(cx + dx, fy + k, cz + dz, stone());
      if (h >= 2 && rand() < 0.4) set(cx + dx, fy + h + 1, cz + dz, B.OAK_LEAVES);
      else if (h >= 2 && rand() < 0.2) set(cx + dx, fy + h + 1, cz + dz, B.COBBLE_WALL);
    }
  // gateposts and a slab step in the gateway
  set(cx - 1, fy + 3, cz + S, B.MOSSY_STONE_BRICKS);
  set(cx + 2, fy + 3, cz + S, B.STONE_BRICKS);
  for (const dx of [-1, 2]) for (let k = 1; k <= 2; k++) set(cx + dx, fy + k, cz + S, B.STONE_BRICKS);
  set(cx, fy + 1, cz + S + 1, B.STONE_BRICK_SLAB);
  set(cx + 1, fy + 1, cz + S + 1, B.STONE_BRICK_SLAB);
  // a crumbling stair up the inside of the west wall (stairs facing north climb toward -z)
  for (let k = 0; k < 3; k++) {
    for (let j = 0; j < k; j++) set(cx - S + 1, fy + 1 + j, cz + 2 - k, B.STONE_BRICKS);
    set(cx - S + 1, fy + 1 + k, cz + 2 - k, B.STONE_BRICK_STAIRS + 0);
  }
  // a broken pillar and a fallen slab
  for (let k = 1; k <= 2; k++) set(cx - 1, fy + k, cz - 1, B.MOSSY_STONE_BRICKS);
  set(cx + 1, fy + 1, cz + 1, B.STONE_BRICK_SLAB);
  // the treasure chest, its front to the courtyard (south)
  const chest = { x: cx + S - 1, y: fy + 1, z: cz - S + 1, island: "old_keep" };
  set(chest.x, chest.y, chest.z, B.CHEST + 2);
  void get;
  return chest;
}

/** Bluebell Isle's pond (its bowl was shaped with the land and holds the sea water that was there): a clay bed, and
 *  sugar cane on the rim where it touches the water. */
function pond(px: number, pz: number, get: Get, set: Set, rand: () => number): void {
  for (let dz = -4; dz <= 4; dz++)
    for (let dx = -4; dx <= 4; dx++) {
      if (dx * dx + dz * dz > 3.2 * 3.2) continue;
      if (get(px + dx, SEA - 2, pz + dz) === B.WATER) set(px + dx, SEA - 3, pz + dz, B.CLAY);
    }
  for (let dz = -5; dz <= 5; dz++)
    for (let dx = -5; dx <= 5; dx++) {
      const x = px + dx;
      const z = pz + dz;
      const g = get(x, SEA - 1, z);
      if ((g !== B.SAND && g !== B.GRASS && g !== B.DIRT) || get(x, SEA, z) !== B.AIR) continue;
      const wet = get(x + 1, SEA - 1, z) === B.WATER || get(x - 1, SEA - 1, z) === B.WATER || get(x, SEA - 1, z + 1) === B.WATER || get(x, SEA - 1, z - 1) === B.WATER;
      if (!wet || rand() > 0.45) continue;
      const tall = 1 + Math.floor(rand() * 3);
      for (let k = 0; k < tall; k++) set(x, SEA + k, z, B.SUGAR_CANE);
    }
}
