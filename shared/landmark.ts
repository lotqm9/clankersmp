// The spawn's monument (clankersmp): the three AIs, opus, sonnet and haiku, as block statues standing together in
// the middle of the plaza, facing the arrival (south). Each is built a block per pixel of its own skin
// (client/src/render/textures.ts AGENT_LOOKS and agentSkin): the heads at full size (8 x 8 x 8, the faces pixel for
// pixel), the bodies at three quarters (a 6 x 10 torso, arms and legs 3 x 10, 4 deep), so a statue is 28 blocks tall
// and all three fit the plaza. sonnet stands in front, opus and haiku a step behind on either side, shoulder to
// shoulder with it. They stand on a stone base on a grassy dais; the base's front under sonnet is the plaque
// ("clankersmp" and the three dots, client/src/render/scenery.ts). Built by shared/hub12.ts; deterministic (integer
// hashes only), so every client builds exactly the same blocks.

import { B } from "./blocks.ts";
import { hash2 } from "./noise.ts";

const CREAM = B.TERRACOTTA + 1;
const RUST = B.TERRACOTTA + 2;
const OCHRE = B.TERRACOTTA + 3;
const SLATE = B.TERRACOTTA + 4;
const CHARCOAL = B.TERRACOTTA + 5;

/** A statue's look, read off its skin. Rows run top to bottom; a face or chest row runs from the statue's right
 *  (west, the viewer's left) to its left. Letters: c coat, k coat shade, D the hood's dark inside, s skin, n skin
 *  shade, h hair, d hair shade, W eye white, E eye, M mouth, p trousers, f shoe, F sole, and each look's own extras. */
export interface StatueLook {
  name: "opus" | "sonnet" | "haiku";
  /** The hood is up (the head's top, sides and back are the coat). */
  hood: boolean;
  face: string[]; // 8 x 8
  chest: string[]; // 6 x 10
  legs: string; // 10 rows, the same all round each leg
  arms: string; // 10 rows, the same all round each arm
  pal: Record<string, number>;
}

/** The hood's face (opus and haiku): the rim over the brow, the dark inside at the cheeks, the fringe under it. */
const HOOD_FACE = ["cccccccc", "DhhhhhhD", "DhdssshD", "DssssssD", "DWEssEWD", "DssnnssD", "DsMMMMsD", "DssssssD"];
/** sonnet's face: side-swept brown hair, blue eyes. */
const BARE_FACE = ["hhhhhhhh", "hhhhhhhh", "hhhssssd", "dsssssss", "sWEssEWs", "sssnnsss", "snMMMMns", "ssssssss"];

export const STATUE_LOOKS: StatueLook[] = [
  {
    // a red hoodie with the hood up: the neck opening, two white drawstrings, the front pocket; dark trousers, white
    // trainers
    name: "opus",
    hood: true,
    face: HOOD_FACE,
    chest: ["cWooWc", "cWccWc", "cWccWc", "cccccc", "cccccc", "ckkkkc", "ckkkkc", "ckkkkc", "cccccc", "kkkkkk"],
    legs: "pppppppffF",
    arms: "ccccccckss",
    pal: { c: B.WOOL_RED, k: RUST, D: RUST, o: CHARCOAL, s: CREAM, n: B.SMOOTH_TAN, h: CHARCOAL, d: B.WOOL_BLACK, W: B.WOOL_WHITE, E: CHARCOAL, M: B.WOOL_BROWN, p: B.WOOL_BLACK, f: B.WOOL_WHITE, F: B.CLAY },
  },
  {
    // a blue jacket: the light collar, a white tee at the neck, the zip, two pocket welts; grey trousers, brown shoes
    name: "sonnet",
    hood: false,
    face: BARE_FACE,
    chest: ["cLTTLc", "cckzcc", "cckzcc", "cckzcc", "cckzcc", "cckzcc", "cPkzPc", "cckzcc", "cckzcc", "kkkkkk"],
    legs: "pppppppffF",
    arms: "ccccccckss",
    pal: { c: B.SMOOTH_BLUE, k: B.WOOL_BLUE, L: B.WOOL_LIGHT_BLUE, T: B.WOOL_WHITE, z: B.CLAY, P: B.WOOL_BLUE, s: B.SMOOTH_TAN, n: B.TERRACOTTA, h: B.WOOL_BROWN, d: CHARCOAL, W: B.WOOL_WHITE, E: B.SMOOTH_BLUE, M: B.WOOL_BROWN, p: B.WOOL_GREY, f: B.WOOL_BROWN, F: CHARCOAL },
  },
  {
    // a yellow raincoat with the hood up: the collar, the placket, three dark toggles, the skirt over the thighs;
    // navy trousers and tall boots
    name: "haiku",
    hood: true,
    face: HOOD_FACE,
    chest: ["cknnkc", "ccktcc", "cckccc", "cckccc", "ccktcc", "cckccc", "cckccc", "ccktcc", "cckccc", "kkkkkk"],
    legs: "ccckpppppF",
    arms: "ccccccckss",
    pal: { c: B.WOOL_YELLOW, k: OCHRE, D: OCHRE, t: CHARCOAL, s: CREAM, n: B.SMOOTH_TAN, h: CHARCOAL, d: B.WOOL_BLACK, W: B.WOOL_WHITE, E: B.WOOL_BLACK, M: B.WOOL_BROWN, p: SLATE, F: B.WOOL_BLACK },
  },
];

export const STATUE_HEIGHT = 28; // legs 10, torso 10, head 8

export interface Statue {
  name: StatueLook["name"];
  /** Its west edge (the right arm's outer side; 12 wide), the north row of its body (4 deep; the head reaches 2
   *  further each way), its feet and the top of its head. */
  x0: number;
  zb: number;
  y0: number;
  top: number;
}

export interface Landmark {
  /** The plaque ("clankersmp" and the dots) on the base's front under sonnet, facing the arrival: a 10 x 2 wall. */
  board: { x0: number; x1: number; y0: number; y1: number; z: number };
  statues: Statue[];
}

type Set = (x: number, y: number, z: number, id: number) => void;

/** One statue, facing south (+z). */
function buildStatue(set: Set, L: StatueLook, x0: number, zb: number, y0: number): Statue {
  const P = L.pal;
  const id = (ch: string) => {
    const v = P[ch];
    if (v === undefined) throw new Error(`statue ${L.name}: no block for "${ch}"`);
    return v;
  };
  const box = (xa: number, xb: number, ya: number, yb: number, za: number, zbb: number, f: (x: number, y: number, z: number) => number) => {
    for (let y = ya; y <= yb; y++) for (let z = za; z <= zbb; z++) for (let x = xa; x <= xb; x++) set(x, y, z, f(x, y, z));
  };
  const front = zb + 3;
  // legs (the right leg west, the left east) and arms hang straight: each row the same all round
  box(x0 + 3, x0 + 8, y0, y0 + 9, zb, front, (_x, y) => id(L.legs[y0 + 9 - y]));
  for (const xa of [x0, x0 + 9]) box(xa, xa + 2, y0 + 10, y0 + 19, zb, front, (_x, y) => id(L.arms[y0 + 19 - y]));
  // the torso: the chest on its front, the coat round the rest with its darker hem
  box(x0 + 3, x0 + 8, y0 + 10, y0 + 19, zb, front, (x, y, z) => {
    const row = y0 + 19 - y;
    if (z === front) return id(L.chest[row][x - x0 - 3]);
    return id(row === 9 ? "k" : "c");
  });
  // the head: 8 x 8 x 8 over the torso, the face looking south
  const hx = x0 + 2;
  const hz = zb - 2;
  const hy = y0 + 20;
  box(hx, hx + 7, hy, hy + 7, hz, hz + 7, (x, y, z) => {
    const row = hy + 7 - y;
    if (z === hz + 7) return id(L.face[row][x - hx]);
    if (L.hood) {
      if (row < 7) {
        // the top, and the sides and the back: the hood, a seam down the back
        if (z === hz && x === hx + 4 && row > 0) return id("k");
        return id("c");
      }
      return id(z === hz || x === hx || x === hx + 7 ? "k" : "n"); // the hood's hem; the chin's underside
    }
    if (row === 0) return id("h");
    if (z === hz) return id(row === 7 ? "s" : "h"); // the back of the head is hair
    if (x === hx || x === hx + 7) {
      if (row <= 2) return id("h");
      if (row === 4 && z === hz + 2) return id("n"); // the ears
      return id("s");
    }
    return id(row === 7 ? "n" : "s");
  });
  return { name: L.name, x0, zb, y0, top: hy + 7 };
}

/** The monument: the dais (a lawn in a stone-brick rim, a slab step all round, its top at sh + 1; symmetric about
 *  the plaza's centre column CX), and on it the base, the three statues and the plaque (symmetric about the line
 *  between columns CX - 1 and CX: the statues are an even number of blocks wide). Its ground runs from (CX - 18,
 *  CZ - 12) to (CX + 18, CZ + 8) (daisDist); the caller has checked that none of it is kept. */
export function buildLandmark(set: Set, CX: number, CZ: number, sh: number, seed: number): Landmark {
  // ---- the dais: a rounded rectangle, a lawn one block up in a stone-brick rim, a slab step all round
  for (let dz = -13; dz <= 9; dz++)
    for (let dx = -19; dx <= 19; dx++) {
      const d = daisDist(dx, dz);
      if (d > 1) continue;
      const x = CX + dx;
      const z = CZ + dz;
      if (d > 0) set(x, sh + 1, z, B.STONE_BRICK_SLAB);
      else if (d > -1) set(x, sh + 1, z, B.STONE_BRICKS);
      else {
        set(x, sh, z, B.DIRT);
        set(x, sh + 1, z, B.GRASS);
      }
    }

  // ---- the base, two blocks of stone bricks: wide at the back for opus and haiku, and a step forward for sonnet
  // whose front is the plaque
  const onBase = (dx: number, dz: number) => (dx >= -14 && dx <= 13 && dz >= -8 && dz <= -2) || (dx >= -5 && dx <= 4 && dz >= -1 && dz <= 4);
  for (let dz = -8; dz <= 4; dz++)
    for (let dx = -14; dx <= 13; dx++) {
      if (!onBase(dx, dz)) continue;
      set(CX + dx, sh + 2, CZ + dz, B.STONE_BRICKS);
      set(CX + dx, sh + 3, CZ + dz, B.STONE_BRICKS);
    }

  // ---- the statues: sonnet in front, opus (west) and haiku (east) four blocks behind, each with its inner arm just
  // behind sonnet's
  const y0 = sh + 4;
  const [opus, sonnet, haiku] = STATUE_LOOKS;
  const statues = [buildStatue(set, opus, CX - 15, CZ - 6, y0), buildStatue(set, sonnet, CX - 6, CZ - 2, y0), buildStatue(set, haiku, CX + 3, CZ - 6, y0)];

  // ---- a few flowers and tufts on the lawn, clear of the base
  for (let dz = -11; dz <= 7; dz++)
    for (let dx = -17; dx <= 17; dx++) {
      if (daisDist(dx, dz) > -1.5) continue;
      let near = false;
      for (let k = -1; k <= 1 && !near; k++) for (let j = -1; j <= 1 && !near; j++) if (onBase(dx + k, dz + j)) near = true;
      if (near || (dx >= -6 && dx <= 5 && dz >= 4)) continue; // the plaque's front stays clear
      const x = CX + dx;
      const z = CZ + dz;
      const h = hash2(x, z, seed + 1302);
      if (h < 0.1) set(x, sh + 2, z, B.TALL_GRASS);
      else if (h < 0.15) set(x, sh + 2, z, [B.DANDELION, B.POPPY, B.BLUEBELL][Math.floor(hash2(x, z, seed + 1303) * 3)]);
    }
  // lanterns on the lawn by the corners
  for (const [dx, dz] of [[-15, -8], [14, -8], [-13, 5], [12, 5]] as [number, number][]) set(CX + dx, sh + 2, CZ + dz, B.LANTERN);

  return { board: { x0: CX - 5, x1: CX + 4, y0: sh + 2, y1: sh + 3, z: CZ + 4 }, statues };
}

/** How far (dx, dz) from the plaza's centre is outside the dais's lawn and rim (<= 0: on them; 0..1: its slab step;
 *  > 1: off it). A rounded rectangle 35 x 21 symmetric about the plaza's centre column (+ - * / sqrt only). */
export function daisDist(dx: number, dz: number): number {
  const px = Math.abs(dx);
  const pz = Math.abs(dz + 2);
  const R = 6;
  const qx = px - (17 - R);
  const qz = pz - (9.5 - R);
  const ox = qx > 0 ? qx : 0;
  const oz = qz > 0 ? qz : 0;
  return Math.sqrt(ox * ox + oz * oz) + Math.min(Math.max(qx, qz), 0) - R;
}
