// The spawn's landmark ($STEVE Craft survival): a blocky guy in a teal shirt and blue trousers, one fist out,
// punching a tree ("punch a tree" is the coin's lore). Our own build: one block per pixel of our own player art
// (client/src/render/textures.ts makeSkin, the gold "$" on the chest included), 32 blocks tall on a grassy dais in the
// middle of the plaza, facing east into an oak whose trunk his fist meets. Built by shared/hub12.ts; deterministic
// (integer hashes only), so every client builds exactly the same blocks.

import { B } from "./blocks.ts";
import { hash2 } from "./noise.ts";

/** The face, 8 x 8: row 0 at the top, column 0 on his right (south, as he faces east). H hair, d dark hair, S skin,
 *  W eye white, B eye blue, N shade, M mouth. */
export const FACE_ROWS = ["HHHHHHHH", "HHHHHHHH", "HHHSSSSd", "dSSSSSSS", "SWBSSBWS", "SSSNNSSS", "SNMMMMNS", "SSSSSSSS"];
/** The torso's front, 8 x 12: T shirt, S skin (the neck), G gold (the "$"), L belt. */
export const CHEST_ROWS = [
  "TTTSSTTT",
  "TTTSSTTT",
  "TTTTTTTT",
  "TTTGTTTT",
  "TTTGGTTT",
  "TTGTTTTT",
  "TTTGTTTT",
  "TTTTGTTT",
  "TTGGTTTT",
  "TTTGTTTT",
  "TTTTTTTT",
  "LLLLLLLL",
];

const SKIN = B.SMOOTH_TAN;
const SHADE = B.TERRACOTTA; // plain terracotta: the nose, the mouth's corners
const HAIR = B.WOOL_BROWN;
const HAIR_DARK = B.TERRACOTTA + 5; // charcoal
const SHIRT = B.SMOOTH_TEAL;
const TROUSERS = B.SMOOTH_BLUE;
const SHOES = B.WOOL_GREY;
const BELT = B.TERRACOTTA + 5;
const FACE: Record<string, number> = { H: HAIR, d: HAIR_DARK, S: SKIN, W: B.WOOL_WHITE, B: B.SMOOTH_BLUE, N: SHADE, M: B.TERRACOTTA + 2 };
const CHEST: Record<string, number> = { T: SHIRT, S: SKIN, G: B.GOLD_BLOCK, L: BELT };

export interface Landmark {
  /** The plaque ("$STEVE Craft") on the dais's south rim, facing the arrival: a 9 x 2 wall. */
  board: { x0: number; x1: number; y0: number; y1: number; z: number };
  /** Where the figure stands (its feet), its head's top, and the tree. */
  figure: { x: number; z: number; y0: number; top: number };
  tree: { x: number; z: number; top: number };
}

type Set = (x: number, y: number, z: number, id: number) => void;

/** The dais (r 11.5 round CX, CZ, its top at sh + 1), the figure, the tree and the plaque. The caller has checked
 *  that the ground from (CX - 13, CZ - 13) to (CX + 13, CZ + 14) holds no kept tile (the crown overhangs a little). */
export function buildLandmark(set: Set, CX: number, CZ: number, sh: number, seed: number): Landmark {
  const dist = (dx: number, dz: number) => Math.sqrt(dx * dx + dz * dz);
  // ---- the dais: a lawn one block up in a stone-brick rim, a slab step all round
  for (let dz = -13; dz <= 13; dz++)
    for (let dx = -13; dx <= 13; dx++) {
      const d = dist(dx, dz);
      if (d > 12.5) continue;
      if (d > 11.5) set(CX + dx, sh + 1, CZ + dz, B.STONE_BRICK_SLAB);
      else if (d > 10.5) set(CX + dx, sh + 1, CZ + dz, B.STONE_BRICKS);
      else {
        set(CX + dx, sh, CZ + dz, B.DIRT);
        set(CX + dx, sh + 1, CZ + dz, B.GRASS);
      }
    }

  // ---- the figure: facing east (+x), so his right side is south (+z). Feet on the lawn.
  const sx = CX - 6; // the torso spans x sx-2..sx+1 (4 deep)
  const sz = CZ - 1; // and z sz-4..sz+3 (8 wide)
  const y0 = sh + 2;
  const box = (x0: number, x1: number, y0b: number, y1: number, z0: number, z1: number, id: number | ((x: number, y: number, z: number) => number)) => {
    for (let y = y0b; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) set(x, y, z, typeof id === "number" ? id : id(x, y, z));
  };
  // legs: 12 tall, trousers with shoes at the bottom (the right leg south, the left north)
  box(sx - 2, sx + 1, y0, y0 + 11, sz - 4, sz + 3, (_x, y) => (y - y0 < 3 ? SHOES : TROUSERS));
  // torso: 12 tall; the front (x = sx + 1) carries the chest, the rest is shirt with the belt round the bottom
  box(sx - 2, sx + 1, y0 + 12, y0 + 23, sz - 4, sz + 3, (x, y, z) => {
    const row = y0 + 23 - y;
    if (x === sx + 1) return CHEST[CHEST_ROWS[row][sz + 3 - z]];
    return row === 11 ? BELT : SHIRT;
  });
  // the left arm (north) hangs at his side: a teal sleeve, then skin
  box(sx - 2, sx + 1, y0 + 12, y0 + 23, sz - 8, sz - 5, (_x, y) => (y >= y0 + 20 ? SHIRT : SKIN));
  // the right arm (south) punches straight ahead at shoulder height: the sleeve, then the arm, the fist at the end
  box(sx - 2, sx + 9, y0 + 20, y0 + 23, sz + 4, sz + 7, (x) => (x <= sx + 1 ? SHIRT : SKIN));
  // the head: 8 x 8 x 8, hair on top and round the back, the face looking east at the tree
  box(sx - 4, sx + 3, y0 + 24, y0 + 31, sz - 4, sz + 3, (x, y, z) => {
    const row = y0 + 31 - y;
    if (x === sx + 3) return FACE[FACE_ROWS[row][sz + 3 - z]];
    if (row <= 1) return HAIR; // the top two rows all round
    if (x === sx - 4) return row <= 6 ? HAIR : SKIN; // the back of the head
    if ((z === sz - 4 || z === sz + 3) && row === 2) return HAIR; // the sides
    if ((z === sz - 4 || z === sz + 3) && row === 4 && x === sx - 1) return SHADE; // the ears
    return SKIN;
  });

  // ---- the tree he is punching: a thick oak (4 x 4 trunk) right where his fist lands, a big round crown above
  const tx = sx + 10; // the trunk spans x tx..tx+3, z sz+4..sz+7 (in line with the fist)
  const tz = sz + 4;
  const trunkTop = y0 + 27;
  for (let dz = -1; dz <= 4; dz++) for (let dx = -1; dx <= 4; dx++) set(tx + dx, sh + 1, tz + dz, B.GRASS);
  box(tx, tx + 3, sh + 2, trunkTop, tz, tz + 3, B.OAK_LOG);
  // roots flaring out at the foot, and two boughs into the crown
  for (const [rx, rz, h] of [[-1, 1, 2], [4, 2, 2], [1, -1, 1], [2, 4, 3], [4, 0, 1], [-1, 3, 1]] as [number, number, number][])
    for (let y = sh + 2; y < sh + 2 + h; y++) set(tx + rx, y, tz + rz, B.OAK_LOG);
  for (let k = 0; k < 4; k++) {
    set(tx + 4 + k, trunkTop - 3 + (k >> 1), tz + 2, B.OAK_LOG);
    set(tx + 1, trunkTop - 2 + (k >> 1), tz + 4 + k, B.OAK_LOG);
  }
  // the crown: an uneven ball of leaves (kept off his head: it starts 2 blocks east of it)
  const ccx = tx + 2.5;
  const ccy = trunkTop + 3;
  const ccz = tz + 3;
  const RX = 7.5;
  const RY = 6;
  const RZ = 7.5;
  let crownTop = trunkTop;
  for (let y = Math.floor(ccy - RY); y <= Math.ceil(ccy + RY); y++)
    for (let z = Math.floor(ccz - RZ); z <= Math.ceil(ccz + RZ); z++)
      for (let x = Math.floor(ccx - RX); x <= Math.ceil(ccx + RX); x++) {
        if (x <= sx + 5 && y <= y0 + 33) continue; // clear of the head
        const e = ((x - ccx) / RX) ** 2 + ((y - ccy) / RY) ** 2 + ((z - ccz) / RZ) ** 2;
        if (e > 1 - 0.22 * hash2(x * 7 + y, z * 3 - y, seed + 1301)) continue;
        if (x >= tx && x <= tx + 3 && z >= tz && z <= tz + 3 && y <= trunkTop) continue; // the trunk
        set(x, y, z, B.OAK_LEAVES);
        if (y > crownTop) crownTop = y;
      }
  // the trunk shows through the middle of the crown
  box(tx + 1, tx + 2, trunkTop + 1, trunkTop + 3, tz + 1, tz + 2, B.OAK_LOG);

  // ---- a few flowers and tufts on the lawn, clear of his feet, the roots and the plaque
  for (let dz = -10; dz <= 10; dz++)
    for (let dx = -10; dx <= 10; dx++) {
      if (dist(dx, dz) > 9.6) continue;
      const x = CX + dx;
      const z = CZ + dz;
      if (x >= sx - 3 && x <= sx + 2 && z >= sz - 9 && z <= sz + 8) continue;
      if (x >= tx - 2 && x <= tx + 5 && z >= tz - 2 && z <= tz + 5) continue;
      if (dz >= 7) continue;
      const h = hash2(x, z, seed + 1302);
      if (h < 0.1) set(x, sh + 2, z, B.TALL_GRASS);
      else if (h < 0.15) set(x, sh + 2, z, [B.DANDELION, B.POPPY, B.BLUEBELL][Math.floor(hash2(x, z, seed + 1303) * 3)]);
    }

  // ---- the plaque on the south rim, facing the arrival: a low wall with a slab cap; lanterns on the rim
  const pz = CZ + 10;
  for (let x = CX - 4; x <= CX + 4; x++) {
    set(x, sh + 2, pz, B.STONE_BRICKS);
    set(x, sh + 3, pz, B.STONE_BRICKS);
    set(x, sh + 4, pz, B.STONE_BRICK_SLAB);
  }
  for (const [dx, dz] of [[8, -8], [-8, -8], [-8, 8], [8, 8]] as [number, number][]) set(CX + dx, sh + 2, CZ + dz, B.LANTERN);

  return {
    board: { x0: CX - 4, x1: CX + 4, y0: sh + 2, y1: sh + 3, z: pz },
    figure: { x: sx, z: sz, y0, top: y0 + 31 },
    tree: { x: tx, z: tz, top: crownTop },
  };
}
