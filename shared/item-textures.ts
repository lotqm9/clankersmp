// Original 16x16 pixel art for the survival blocks and the item sprites (protocol v5). Everything is drawn here
// from masks and palettes: no textures from any other game. Each mask is 16 rows of 16 characters; every letter is a
// palette group, shaded automatically (lit from the top left: a pixel with nothing above or to its left gets the light
// tone, one with nothing below or to its right gets the dark tone, the rest the middle tone). "." is transparent.

import { mulberry32 } from "./noise.ts";

type RGB = [number, number, number];
type Img = Uint8Array;
const T = 16;

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const newImg = (): Img => new Uint8Array(T * T * 4);
function put(img: Img, x: number, y: number, c: RGB, a = 255): void {
  if (x < 0 || y < 0 || x >= T || y >= T) return;
  const o = (y * T + x) * 4;
  img[o] = c[0];
  img[o + 1] = c[1];
  img[o + 2] = c[2];
  img[o + 3] = a;
}
const scale = (c: RGB, k: number): RGB => [Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k)];

/** [dark, mid, light] */
export type Pal = [RGB, RGB, RGB];
const pal = (d: string, m: string, l: string): Pal => [hex(d), hex(m), hex(l)];

export const PAL = {
  handle: pal("#4a361f", "#6e5331", "#8f7044"),
  wood: pal("#6a5230", "#9b7b48", "#c4a46c"),
  stone: pal("#555558", "#7f7f84", "#a6a6aa"),
  iron: pal("#8c8c90", "#cfcfd2", "#f4f4f6"),
  gold: pal("#b07d0c", "#f0bf36", "#fff09a"),
  diamond: pal("#1c8e96", "#4dd6da", "#c9fbff"),
  ruby: pal("#8e1a1a", "#e0362e", "#ff9e8e"),
  coal: pal("#141316", "#2a292d", "#4d4b51"),
  charcoal: pal("#1d1712", "#3a2c22", "#5a4636"),
  rawIron: pal("#8d6a4f", "#c19a78", "#e4c6a6"),
  rawGold: pal("#a0700c", "#e6b43a", "#fbe58c"),
  raw: pal("#a3343a", "#dc5a5e", "#f39a96"),
  rawPork: pal("#c26d78", "#ef9fa6", "#fbc9cc"),
  cooked: pal("#5b3418", "#8c5428", "#b97c43"),
  cookedLight: pal("#8a5a26", "#c08a44", "#e2b56c"),
  rawChicken: pal("#c9998a", "#efc9b8", "#fbe6da"),
  fat: pal("#d8d0c4", "#f0ebe2", "#ffffff"),
  bone: pal("#bdb6a4", "#e8e2d2", "#ffffff"),
  leather: pal("#6b3a1c", "#985a2e", "#c07a46"),
  feather: pal("#b9bcc4", "#e6e8ee", "#ffffff"),
  quill: pal("#6e6e74", "#9a9aa2", "#c4c4cc"),
  apple: pal("#9e1712", "#e0302a", "#ff8a6e"),
  leaf: pal("#2f6a18", "#4c9a2a", "#7cc24a"),
  stem: pal("#3c2a14", "#5c4020", "#7a5a30"),
};

/** Draw a mask: each letter maps to a palette (auto-shaded) or, with a trailing "!", a flat colour. */
function sprite(mask: string[], groups: Record<string, Pal>, base?: Img): Img {
  const img = base ?? newImg();
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= T || y >= T ? "." : mask[y][x]);
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const ch = mask[y][x];
      if (ch === "." || ch === " ") continue;
      const p = groups[ch];
      if (!p) continue;
      const up = at(x, y - 1) !== ch;
      const left = at(x - 1, y) !== ch;
      const down = at(x, y + 1) !== ch;
      const right = at(x + 1, y) !== ch;
      let c = p[1];
      if (down || right) c = p[0];
      if ((up || left) && !(down && right)) c = p[2];
      put(img, x, y, c);
    }
  }
  return img;
}

// ------------------------------------------------------------------ tools

/** The handle every tool shares: a diagonal stick from the bottom left. `len` pixels up from (2, 13). */
function handle(img: Img, len: number): void {
  const [d, m, l] = PAL.handle;
  for (let t = 0; t <= len; t++) {
    put(img, 2 + t, 13 - t, l);
    put(img, 3 + t, 13 - t, m);
    put(img, 3 + t, 14 - t, d);
  }
}

/** The pickaxe head: a crescent around the top of the handle, drawn from geometry so it stays smooth. */
function pickHead(img: Img, p: Pal): void {
  const cx = 6.6;
  const cy = 9.4;
  const R = 6.9;
  const mask: string[] = [];
  for (let y = 0; y < T; y++) {
    let row = "";
    for (let x = 0; x < T; x++) {
      const dx = x + 0.5 - cx;
      const dy = cy - (y + 0.5);
      const r = Math.hypot(dx, dy);
      const ang = (Math.atan2(dy, dx) * 180) / Math.PI; // 45 = along the handle
      const off = Math.abs(ang - 45);
      const w = off < 70 ? 1.45 - (off / 70) * 0.75 : -1;
      row += w > 0 && Math.abs(r - R) <= w ? "#" : ".";
    }
    mask.push(row);
  }
  sprite(mask, { "#": p }, img);
}

const AXE = [
  "................",
  "......##........",
  "....######......",
  "...########.....",
  "...#########....",
  "....########....",
  ".....######.....",
  ".......##.......",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
];

const SHOVEL = [
  "................",
  "...........###..",
  "..........#####.",
  "..........######",
  ".........######.",
  "..........####..",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
];

const SWORD = [
  ".............###",
  "............####",
  "...........####.",
  "..........####..",
  ".........####...",
  "........####....",
  ".......####.....",
  "..##..####......",
  "...######.......",
  "....####........",
  "...######.......",
  "..##....##......",
  "................",
  "................",
  "................",
  "................",
];

export const TOOL_KINDS = ["pickaxe", "axe", "shovel", "sword"] as const;
export const TOOL_MATERIALS = ["wood", "stone", "iron", "gold", "diamond"] as const;

export function toolSprite(material: number, kind: number): Img {
  const p = [PAL.wood, PAL.stone, PAL.iron, PAL.gold, PAL.diamond][material];
  const img = newImg();
  if (kind === 0) {
    handle(img, 9);
    pickHead(img, p);
  } else if (kind === 1) {
    handle(img, 9);
    sprite(AXE, { "#": p }, img);
    // the handle shows through the eye of the head
    put(img, 10, 4, PAL.handle[1]);
    put(img, 11, 3, PAL.handle[2]);
  } else if (kind === 2) {
    handle(img, 8);
    sprite(SHOVEL, { "#": p }, img);
  } else {
    // sword: a short grip, the guard, then the blade
    const [d, m, l] = PAL.handle;
    for (let t = 0; t <= 3; t++) {
      put(img, 1 + t, 14 - t, l);
      put(img, 2 + t, 14 - t, m);
      put(img, 2 + t, 15 - t, d);
    }
    sprite(SWORD, { "#": p }, img);
  }
  return img;
}

// ------------------------------------------------------------------ materials and food

export function stick(): Img {
  const img = newImg();
  const [d, m, l] = PAL.handle;
  for (let t = 0; t <= 10; t++) {
    put(img, 3 + t, 13 - t, l);
    put(img, 4 + t, 13 - t, m);
    put(img, 4 + t, 14 - t, d);
  }
  return img;
}

const LUMP = [
  "................",
  "................",
  "................",
  "......####......",
  "....########....",
  "...##########...",
  "...###########..",
  "..############..",
  "..############..",
  "..###########...",
  "...##########...",
  "....########....",
  ".....######.....",
  "................",
  "................",
  "................",
];

/** A lump (coal, raw ore) with a few speckles. */
export function lump(p: Pal, seed: number, speck?: Pal): Img {
  const img = sprite(LUMP, { "#": p });
  const r = mulberry32(seed);
  for (let k = 0; k < 7; k++) {
    const x = 4 + Math.floor(r() * 8);
    const y = 5 + Math.floor(r() * 6);
    if (LUMP[y][x] !== "#") continue;
    put(img, x, y, (speck ?? p)[r() < 0.5 ? 0 : 2]);
  }
  return img;
}

const INGOT = [
  "................",
  "................",
  "................",
  "................",
  "................",
  "......#######...",
  ".....#########..",
  "....#########...",
  "...#########....",
  "..#########.....",
  "..########......",
  "................",
  "................",
  "................",
  "................",
  "................",
];

const GEM = [
  "................",
  "................",
  "................",
  ".....######.....",
  "....##abba##....",
  "...##abbbba##...",
  "..##########....",
  "...########.....",
  "....######......",
  ".....####.......",
  "......##........",
  "................",
  "................",
  "................",
  "................",
  "................",
];

export function gem(p: Pal): Img {
  // facets: the crown lighter, the pavilion in the body tones
  const crown: Pal = [p[1], p[2], [255, 255, 255]];
  return sprite(GEM.map((r) => r.replace(/[ab]/g, "c")), { "#": p, c: crown });
}

export function ingot(p: Pal): Img {
  return sprite(INGOT, { "#": p });
}

const APPLE = [
  "................",
  "........s.......",
  "........sLL.....",
  "........LL......",
  "....###.###.....",
  "...#########....",
  "..###########...",
  "..###########...",
  "..###########...",
  "..###########...",
  "...#########....",
  "...#########....",
  "....###.###.....",
  "................",
  "................",
  "................",
];

export function apple(): Img {
  return sprite(APPLE, { "#": PAL.apple, s: PAL.stem, L: PAL.leaf });
}

const CHOP = [
  "................",
  "................",
  "................",
  "......#####.....",
  "....#########...",
  "...###########..",
  "..############..",
  "..####ff######..",
  "..###ff#######..",
  "..###########...",
  "...########ww...",
  ".....####..www..",
  "............ww..",
  "................",
  "................",
  "................",
];

const SLAB = [
  "................",
  "................",
  "................",
  "................",
  "....#########...",
  "...###########..",
  "..####ff#######.",
  "..###########ff.",
  "..#ff##########.",
  "..############..",
  "...##########...",
  "................",
  "................",
  "................",
  "................",
  "................",
];

const LEG = [
  "................",
  "................",
  "................",
  ".....#####......",
  "....#######.....",
  "...#########....",
  "...#########....",
  "...#########....",
  "....#######.....",
  ".....#####......",
  "......##........",
  ".......ww.......",
  "........ww......",
  ".......wwww.....",
  "........ww......",
  "................",
];

export function chop(meat: Pal, fat: Pal): Img {
  return sprite(CHOP, { "#": meat, f: fat, w: PAL.bone });
}
export function slab(meat: Pal, fat: Pal): Img {
  return sprite(SLAB, { "#": meat, f: fat });
}
export function leg(meat: Pal): Img {
  return sprite(LEG, { "#": meat, w: PAL.bone });
}

const HIDE = [
  "................",
  "................",
  "...##......##...",
  "...##########...",
  "....########....",
  "...##########...",
  "..############..",
  "..############..",
  "..############..",
  "...##########...",
  "....########....",
  "...##########...",
  "...##......##...",
  "................",
  "................",
  "................",
];

export function leather(): Img {
  return sprite(HIDE, { "#": PAL.leather });
}

const FEATHER = [
  "................",
  "............##..",
  "..........#####.",
  ".........######.",
  "........######..",
  ".......######...",
  "......######....",
  ".....######.....",
  "....######......",
  "....#####.......",
  "...q###.........",
  "..q.............",
  ".q..............",
  "................",
  "................",
  "................",
];

export function feather(): Img {
  return sprite(FEATHER, { "#": PAL.feather, q: PAL.quill });
}

const BOWL = [
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "..############..",
  "..#oooooooooo#..",
  "..############..",
  "...##########...",
  "....########....",
  ".....######.....",
  "................",
  "................",
  "................",
  "................",
];

export function bowl(): Img {
  return sprite(BOWL, { "#": PAL.wood, o: [hex("#3a2a14"), hex("#4a3418"), hex("#5a4020")] });
}

// ------------------------------------------------------------------ v6: night-mob drops, bone meal, armour

const FLESH = [
  "................",
  "................",
  "......####......",
  "....########....",
  "...##########...",
  "..####ss######..",
  "..###ssss######.",
  ".#####ss#######.",
  ".##############.",
  ".####s#####ss##.",
  "..###sss##ssss#.",
  "..####s#####s#..",
  "...##########...",
  "....######......",
  "................",
  "................",
];

/** Spoiled flesh: a greyish-green lump with dark rot spots. */
export function spoiledFlesh(): Img {
  return sprite(FLESH, { "#": pal("#4d5a2b", "#788a45", "#a3b46b"), s: pal("#4a2a35", "#6e3b4c", "#8f5568") });
}

const BONE = [
  "................",
  "...........##...",
  "..........####..",
  "..........#####.",
  "...........###..",
  "..........##....",
  ".........##.....",
  "........##......",
  ".......##.......",
  "......##........",
  ".....##.........",
  "..###...........",
  ".#####..........",
  "..####..........",
  "...##...........",
  "................",
];

export function bone(): Img {
  return sprite(BONE, { "#": PAL.bone });
}

const STRING = [
  "................",
  "................",
  "..........s.....",
  ".........s.s....",
  "........s...s...",
  ".......s.....s..",
  "......s.......s.",
  ".....s..........",
  "....s...........",
  "...s.......ss...",
  "..s.......s..s..",
  "...s.....s......",
  "....s...s.......",
  ".....sss........",
  "................",
  "................",
];

export function string(): Img {
  return sprite(STRING, { s: pal("#8f8b80", "#cfcabd", "#f2efe6") });
}

const MEAL = [
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "..........#.....",
  ".......#........",
  ".....#####......",
  "....#######..#..",
  "...#########....",
  "..###########...",
  "..############..",
  "...##########...",
  "................",
  "................",
];

export function boneMeal(): Img {
  return sprite(MEAL, { "#": pal("#c9c4b6", "#ece8de", "#ffffff") });
}

const ARMOR_MASKS = [
  [
    "................",
    "................",
    "................",
    "....########....",
    "...##########...",
    "..############..",
    "..############..",
    "..####....####..",
    "..###......###..",
    "..###......###..",
    "..aa........aa..",
    "................",
    "................",
    "................",
    "................",
    "................",
  ],
  [
    "................",
    "..####....####..",
    ".#####aaaa#####.",
    ".##############.",
    ".##############.",
    ".###.######.###.",
    ".aa..######..aa.",
    ".....######.....",
    "....########....",
    "....########....",
    "....########....",
    "....aaaaaaaa....",
    "................",
    "................",
    "................",
    "................",
  ],
  [
    "................",
    "................",
    "....aaaaaaaa....",
    "....########....",
    "....########....",
    "....###..###....",
    "....###..###....",
    "....###..###....",
    "....###..###....",
    "....###..###....",
    "....###..###....",
    "....###..###....",
    "................",
    "................",
    "................",
    "................",
  ],
  [
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "...###....###...",
    "...###....###...",
    "...###....###...",
    "..####...####...",
    ".#####..#####...",
    ".aaaaa..aaaaa...",
    "................",
    "................",
    "................",
    "................",
  ],
];

/** Armour pieces: leather (brown with darker stitched trim), iron (pale grey plates), diamond (cyan). */
export function armorSprite(material: number, slot: number): Img {
  const body = [PAL.leather, PAL.iron, PAL.diamond][material];
  const trim = [pal("#3e2210", "#59331a", "#734528"), pal("#5f5f64", "#8a8a90", "#b4b4ba"), pal("#0f5a60", "#1f8a92", "#4cc2c8")][material];
  const img = sprite(ARMOR_MASKS[slot], { "#": body, a: trim });
  // leather gets a few stitches, iron rivets, diamond a sparkle
  const mark = [hex("#3e2210"), hex("#ffffff"), hex("#e9ffff")][material];
  const spots = [[[6, 5], [9, 5]], [[7, 4], [8, 8], [5, 9]], [[6, 3], [9, 3]], [[3, 8], [11, 8]]][slot];
  for (const [x, y] of spots) put(img, x, y, mark);
  return img;
}

// ------------------------------------------------------------------ blocks

const OAK: RGB[] = ["#8a6c3d", "#9b7b48", "#ab8a55", "#b99862"].map(hex);
const OAK_DARK = hex("#5e4628");

function planksBase(seed: number): Img {
  const r = mulberry32(seed);
  const img = newImg();
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      let c = OAK[Math.floor(r() * 4)];
      if (y % 4 === 3) c = scale(c, 0.78);
      put(img, x, y, c);
    }
  return img;
}

/** Crafting table top: a planed board with a carved 3x3 grid. */
export function craftingTop(): Img {
  const img = planksBase(741);
  const line = hex("#4e3a20");
  for (let k = 0; k < T; k++) {
    for (const g of [1, 6, 11]) {
      put(img, g, k, line);
      put(img, k, g, line);
    }
    put(img, 0, k, OAK_DARK);
    put(img, T - 1, k, OAK_DARK);
    put(img, k, 0, OAK_DARK);
    put(img, k, T - 1, OAK_DARK);
  }
  return img;
}

/** Crafting table side: planks with a dark top band; the front adds a saw and a hammer hung on it. */
export function craftingSide(front: boolean): Img {
  const img = planksBase(front ? 742 : 743);
  for (let x = 0; x < T; x++) for (let y = 0; y < 3; y++) put(img, x, y, y === 2 ? OAK_DARK : scale(OAK[1 + (x % 2)], 0.82));
  if (front) {
    const steel: Pal = PAL.iron;
    // a saw blade with teeth
    for (let x = 2; x <= 7; x++) for (let y = 5; y <= 7; y++) put(img, x, y, y === 5 ? steel[2] : steel[1]);
    for (let x = 2; x <= 7; x += 2) put(img, x, 8, steel[0]);
    put(img, 8, 5, PAL.handle[1]);
    put(img, 8, 6, PAL.handle[1]);
    put(img, 9, 6, PAL.handle[0]);
    // a hammer
    for (let y = 5; y <= 12; y++) put(img, 12, y, PAL.handle[1]);
    for (let x = 10; x <= 14; x++) put(img, x, 4, steel[1]);
    for (let x = 10; x <= 14; x++) put(img, x, 5, steel[0]);
  } else {
    // a pair of tongs
    for (let y = 5; y <= 12; y++) {
      put(img, 5 + (y > 9 ? 1 : 0), y, hex("#56565a"));
      put(img, 10 - (y > 9 ? 1 : 0), y, hex("#56565a"));
    }
  }
  return img;
}

function smoothStone(seed: number): Img {
  const r = mulberry32(seed);
  const img = newImg();
  const tones = ["#6d6d70", "#757578", "#7d7d80", "#68686b"].map(hex);
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      let c = tones[Math.floor(r() * 4)];
      if (x === 0 || y === 0) c = scale(c, 1.12);
      if (x === T - 1 || y === T - 1) c = scale(c, 0.8);
      put(img, x, y, c);
    }
  return img;
}

/** Furnace: smooth stone with a stone-lined mouth; lit, the mouth glows with a fire of our own. */
export function furnaceFront(lit: boolean): Img {
  const img = smoothStone(lit ? 771 : 770);
  const r = mulberry32(772);
  for (let y = 7; y <= 13; y++)
    for (let x = 3; x <= 12; x++) {
      const edge = y === 7 || x === 3 || x === 12;
      if (edge) {
        put(img, x, y, hex("#4a4a4d"));
        continue;
      }
      if (!lit) put(img, x, y, y < 10 ? hex("#1a1a1c") : hex("#232326"));
      else {
        const h = 13 - y + r() * 2.2;
        const c = h > 4.4 ? hex("#ffd36a") : h > 2.8 ? hex("#ff8a2a") : h > 1.4 ? hex("#e04a1c") : hex("#6a1a10");
        put(img, x, y, (x + y) % 5 === 0 && h > 3 ? hex("#fff1b0") : c);
      }
    }
  // a lintel and a small vent
  for (let x = 2; x <= 13; x++) put(img, x, 6, hex("#58585b"));
  for (let x = 6; x <= 9; x++) put(img, x, 3, hex("#3a3a3d"));
  return img;
}

export function furnaceSide(): Img {
  const img = smoothStone(773);
  for (let x = 0; x < T; x++) put(img, x, 6, hex("#5e5e61"));
  return img;
}

export function furnaceTop(): Img {
  const img = smoothStone(774);
  for (let k = 2; k <= 13; k++) {
    put(img, k, 2, hex("#5e5e61"));
    put(img, k, 13, hex("#8a8a8d"));
    put(img, 2, k, hex("#5e5e61"));
    put(img, 13, k, hex("#8a8a8d"));
  }
  return img;
}

const CHEST_WOOD: RGB[] = ["#9a6a2e", "#a8773a", "#b78645", "#8c5f28"].map(hex);
const CHEST_TRIM = hex("#4e3214");

/** Chest: drawn for the box (1..15 wide, 0..14 tall), so the trims land on its edges. */
export function chestSide(front: boolean): Img {
  const r = mulberry32(front ? 781 : 782);
  const img = newImg();
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      let c = CHEST_WOOD[Math.floor(r() * 4)];
      if ((y - 2) % 4 === 3) c = scale(c, 0.85);
      put(img, x, y, c);
    }
  // trims along the box edges (box rows 2..15 on the texture, columns 1..14) and the lid seam
  for (let x = 1; x <= 14; x++) {
    put(img, x, 2, CHEST_TRIM);
    put(img, x, 15, CHEST_TRIM);
    put(img, x, 7, CHEST_TRIM);
  }
  for (let y = 2; y <= 15; y++) {
    put(img, 1, y, CHEST_TRIM);
    put(img, 14, y, CHEST_TRIM);
  }
  if (front) {
    // the latch, in the brand red with a dark keyhole
    for (let y = 6; y <= 9; y++) for (let x = 7; x <= 8; x++) put(img, x, y, y === 6 ? hex("#ff6a5c") : hex("#e0362e"));
    put(img, 7, 9, hex("#8a1a14"));
    put(img, 8, 9, hex("#8a1a14"));
  }
  return img;
}

export function chestTop(): Img {
  const r = mulberry32(783);
  const img = newImg();
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      let c = CHEST_WOOD[Math.floor(r() * 4)];
      if (x % 4 === 3) c = scale(c, 0.86);
      put(img, x, y, c);
    }
  for (let k = 1; k <= 14; k++) {
    put(img, k, 1, CHEST_TRIM);
    put(img, k, 14, CHEST_TRIM);
    put(img, 1, k, CHEST_TRIM);
    put(img, 14, k, CHEST_TRIM);
  }
  return img;
}

const SAPLING = [
  "................",
  "................",
  "......LL........",
  ".....LLLL.LL....",
  "....LLLLLLLLL...",
  "...LLLLLLLLLL...",
  "....LLLLLLLL....",
  ".....LLsLLL.....",
  "......LsL.......",
  ".......s........",
  ".......s........",
  ".......s........",
  ".......s........",
  ".......s........",
  ".......s........",
  ".......s........",
];

export function sapling(leaves: Pal, bark: Pal): Img {
  return sprite(SAPLING, { L: leaves, s: bark });
}

/** Metal and gem blocks: four plates with a bevel each (our own pattern). */
export function metalBlock(p: Pal, seed: number, gemFacets = false): Img {
  const r = mulberry32(seed);
  const img = newImg();
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      const px = x % 8;
      const py = y % 8;
      let c = p[1];
      if (px === 0 || py === 0) c = p[2];
      if (px === 7 || py === 7) c = p[0];
      if (gemFacets && px > 1 && px < 6 && py > 1 && py < 6 && (px + py) % 3 === 0) c = p[2];
      put(img, x, y, scale(c, 1 + (r() - 0.5) * 0.05));
    }
  return img;
}

export function coalBlock(): Img {
  const r = mulberry32(791);
  const img = newImg();
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      const k = r();
      put(img, x, y, k < 0.12 ? PAL.coal[2] : k < 0.6 ? PAL.coal[1] : PAL.coal[0]);
    }
  return img;
}

// ------------------------------------------------------------------ HUD icons (9x9, drawn on canvases by the UI)

/** 9x9 masks for the HUD: "o" outline, "#" fill, "h" highlight. */
export const HUD_HEART = [
  ".oo...oo.",
  "o##o.o##o",
  "o#h#o###o",
  "o#######o",
  ".o#####o.",
  "..o###o..",
  "...o#o...",
  "....o....",
  ".........",
];

export const HUD_FOOD = [
  "......oo.",
  ".....owwo",
  "....o#wo.",
  ".ooo##o..",
  "o#h###o..",
  "o#####o..",
  "o####o...",
  ".oooo....",
  ".........",
];

export const HUD_ARMOR = [
  ".ooo.ooo.",
  "o#h#o#h#o",
  "o#######o",
  ".o#####o.",
  ".o#h###o.",
  ".o#####o.",
  ".o#####o.",
  ".ooooooo.",
  ".........",
];

export const HUD_BUBBLE = [
  "..ooooo..",
  ".o#####o.",
  "o#hh###bo",
  "o#h####bo",
  "o######bo",
  "o#####bbo",
  ".o#bbbbo.",
  "..ooooo..",
  ".........",
];

// ------------------------------------------------------------------ v7: farming, food, buckets, the bow and arrows

/** Wheat crops, stage 0 (sprouts) to 7 (ripe): rows of stalks drawn for the crop's four upright planes. */
export function wheatStage(stage: number): Img {
  const img = newImg();
  const r = mulberry32(900 + stage);
  const green: Pal = pal("#2f6a1c", "#4a8f2a", "#6cb03c");
  const ripe: Pal = pal("#8a6a1c", "#c09a34", "#e2c35a");
  const t = stage / 7; // 0 young .. 1 ripe
  const h = [2, 4, 6, 8, 10, 12, 14, 15][stage];
  const cols = [1, 4, 6, 9, 11, 14];
  for (const c0 of cols) {
    const sh = Math.max(1, h - Math.floor(r() * 2.5));
    let x = c0;
    for (let k = 0; k < sh; k++) {
      const y = 15 - k;
      // the stalk: green below, turning gold up top as it ripens
      const gold = stage >= 4 && k > sh * (1.15 - t);
      const p = gold ? ripe : green;
      put(img, x, y, p[k === 0 ? 0 : (x + y) % 3 === 0 ? 2 : 1]);
      // a leaf now and then
      if (k > 0 && k < sh - 2 && r() < 0.22) put(img, x + (r() < 0.5 ? -1 : 1), y - 1, p[r() < 0.5 ? 1 : 2]);
      if (k > 2 && r() < 0.12) x += r() < 0.5 ? -1 : 1;
      x = Math.max(0, Math.min(15, x));
    }
    // an ear on the ripening stalks: two pixels wide, light and dark grains
    if (stage >= 5) {
      const top = 16 - sh;
      const len = stage === 7 ? 4 : 3;
      for (let k = 0; k < len; k++) {
        const y = top + k;
        const ear = stage === 7 ? ripe : pal("#7f8a2a", "#a6a63a", "#c8c25a");
        put(img, x, y, ear[(k % 2) * 2]);
        put(img, Math.min(15, x + 1), y, ear[1]);
      }
      if (stage === 7) put(img, x, top - 1, ripe[2]); // the awn
    }
  }
  return img;
}

/** Sugar cane: three pale green stalks with knuckled joints and a few leaves. */
export function sugarCane(): Img {
  const img = newImg();
  const r = mulberry32(951);
  const stalk: Pal = pal("#5f9a3a", "#8cc45a", "#b9e283");
  const node = hex("#4c7f2e");
  for (const [x0, shift] of [[2, 1], [7, 3], [12, 0]] as [number, number][]) {
    for (let y = 0; y < T; y++) {
      const joint = (y + shift) % 5 === 0;
      put(img, x0, y, joint ? node : stalk[2]);
      put(img, x0 + 1, y, joint ? node : stalk[1]);
      if (!joint && r() < 0.1) put(img, x0 + 1, y, stalk[0]);
    }
    // leaves from two joints
    for (const jy of [((15 - shift) % 5) + 5, ((15 - shift) % 5) + 10]) {
      const side = r() < 0.5 ? -1 : 1;
      const lx = side < 0 ? x0 - 1 : x0 + 2;
      put(img, lx, jy - 1, stalk[1]);
      put(img, lx + side, jy - 2, stalk[2]);
    }
  }
  return img;
}

const SEEDS = [
  "................",
  "................",
  "................",
  "................",
  "................",
  "......##........",
  "...##..##.##....",
  "...##.....##....",
  ".......##....##.",
  "..##...##....##.",
  "..##.##...##....",
  "......##..##....",
  "....##..........",
  "....##....##....",
  "..........##....",
  "................",
];

export function wheatSeeds(): Img {
  return sprite(SEEDS, { "#": pal("#3f6a1e", "#6f9a32", "#a9c45a") });
}

/** A sheaf of wheat: three stalks fanning out from a tied bundle, golden ears at the top right. */
export function wheatItem(): Img {
  const img = newImg();
  const stem: Pal = pal("#7a6018", "#b0902a", "#d8bc56");
  const ear: Pal = pal("#9a7014", "#d6aa36", "#f4dc80");
  const tops: [number, number][] = [[8, 2], [11, 4], [13, 7]];
  for (const [tx, ty] of tops) {
    const bx = 3;
    const by = 13;
    const n = Math.max(Math.abs(tx - bx), Math.abs(ty - by));
    for (let k = 0; k <= n; k++) {
      const x = Math.round(bx + ((tx - bx) * k) / n);
      const y = Math.round(by + ((ty - by) * k) / n);
      if (k >= n - 4) {
        // the ear: two pixels wide, grains alternating
        put(img, x, y, ear[k % 2 ? 2 : 1]);
        put(img, x + 1, y, ear[k % 2 ? 1 : 0]);
      } else put(img, x, y, stem[k % 3 === 0 ? 2 : 1]);
    }
    put(img, tx + 1, ty - 1, ear[2]); // an awn
  }
  // the bundle's tie
  const tie: Pal = pal("#4a2e10", "#6e4a1c", "#8c6228");
  put(img, 3, 11, tie[1]);
  put(img, 4, 11, tie[2]);
  put(img, 5, 10, tie[1]);
  put(img, 4, 10, tie[0]);
  // the cut ends
  put(img, 2, 14, stem[0]);
  put(img, 3, 14, stem[1]);
  return img;
}

const BREAD = [
  "................",
  "................",
  "................",
  "................",
  "......#####.....",
  "....####l####...",
  "...###l###l###..",
  "..###l###l###l#.",
  "..##l###l###l##.",
  "..#############.",
  "..############..",
  "...##########...",
  "....bbbbbbbb....",
  "................",
  "................",
  "................",
];

/** A loaf: a golden crust with three scores across it. */
export function bread(): Img {
  return sprite(BREAD, { "#": pal("#8a5222", "#c0823c", "#e2ae64"), l: pal("#e6c48a", "#f0d6a2", "#fbe9c6"), b: pal("#5a3412", "#6e4218", "#7a4a1e") });
}

const SUGAR = [
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  ".......#........",
  "......###.......",
  ".....#####..#...",
  "....#######.....",
  "...#########....",
  "..###########...",
  "...#########....",
  "................",
  "................",
];

export function sugar(): Img {
  const img = sprite(SUGAR, { "#": pal("#c6c6cc", "#ececf0", "#ffffff") });
  for (const [x, y] of [[6, 10], [9, 11], [5, 12], [10, 12]]) put(img, x, y, hex("#d6d6dc"));
  return img;
}

const PAPER = [
  "................",
  "................",
  "....#########...",
  "...#########l...",
  "...##########...",
  "...#l#######l...",
  "..##########....",
  "..#l#######l....",
  "..##########....",
  "..##########....",
  ".#l########l....",
  ".##########.....",
  ".##########.....",
  "................",
  "................",
  "................",
];

export function paper(): Img {
  return sprite(PAPER, { "#": pal("#c8c4b8", "#ece8de", "#fbfaf4"), l: pal("#b8b4a6", "#d0ccc0", "#e0dcd0") });
}

const EGG = [
  "................",
  "................",
  "................",
  "................",
  "......####......",
  ".....######.....",
  "....########....",
  "....########....",
  "...##########...",
  "...##########...",
  "...##########...",
  "...##########...",
  "....########....",
  ".....######.....",
  "................",
  "................",
];

export function egg(): Img {
  const img = sprite(EGG, { "#": pal("#b8a378", "#e2d2ad", "#f7efdc") });
  put(img, 9, 8, hex("#c7b28a"));
  put(img, 6, 11, hex("#c7b28a"));
  return img;
}

const FLINT = [
  "................",
  "................",
  "................",
  "........#.......",
  ".......###......",
  "......#####.....",
  ".....#######....",
  "....#########...",
  "....##########..",
  "...##########...",
  "...#########....",
  "....#######.....",
  ".....####.......",
  "................",
  "................",
  "................",
];

export function flint(): Img {
  const img = sprite(FLINT, { "#": pal("#26262c", "#46464e", "#76767f") });
  for (const [x, y] of [[7, 6], [9, 8], [6, 9]]) put(img, x, y, hex("#9a9aa4"));
  return img;
}

/** A line of pixels from (x0, y0) to (x1, y1). */
function line(img: Img, x0: number, y0: number, x1: number, y1: number, c: RGB): void {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let k = 0; k <= n; k++) put(img, Math.round(x0 + ((x1 - x0) * k) / (n || 1)), Math.round(y0 + ((y1 - y0) * k) / (n || 1)), c);
}

/** The bow, held diagonally: a curved wooden stave from the top left to the bottom right, bowed toward the top
 *  right, and its string; `pull` 0 at rest, 1..3 drawn back further and further with an arrow on the string. */
export function bowSprite(pull: number): Img {
  const img = newImg();
  const wood = PAL.wood;
  const grip = PAL.handle;
  const pts: [number, number][] = [];
  for (let k = 0; k <= 24; k++) {
    const a = (k / 24) * (Math.PI / 2);
    pts.push([Math.round(1.5 + Math.sin(a) * 12.5), Math.round(13.5 - Math.cos(a) * 12.5)]);
  }
  pts.forEach(([x, y], k) => {
    const mid = k > 9 && k < 15;
    put(img, x, y, mid ? grip[1] : wood[k % 3 === 0 ? 2 : 1]);
    if (!mid) put(img, x - 1, y + 1, wood[0]);
  });
  // the string: straight at rest, pulled down and left when drawn (with the arrow on it)
  const s = hex("#e8e4da");
  const [ax, ay] = pts[0];
  const [bx, by] = pts[pts.length - 1];
  if (pull === 0) line(img, ax, ay + 1, bx - 1, by, s);
  else {
    const back = [0, 2, 3, 4][pull];
    const px = 7 - back;
    const py = 8 + back;
    line(img, ax, ay + 1, px, py, s);
    line(img, px, py, bx - 1, by, s);
    // the arrow along the draw, its head at the top right past the stave
    const shaft = PAL.handle;
    for (let k = 0; k <= 8; k++) put(img, px + k, py - k, shaft[k % 2 ? 1 : 2]);
    const hx = px + 9;
    const hy = py - 9;
    put(img, hx, hy, hex("#5a5a62"));
    put(img, hx + 1, hy - 1, hex("#8a8a94"));
    put(img, hx - 1, hy, hex("#46464e"));
    put(img, hx, hy + 1, hex("#46464e"));
    put(img, px - 1, py, hex("#f0f0f4"));
    put(img, px, py + 1, hex("#d6d6de"));
  }
  // Painted with the stave bulging to the top right, then mirrored: in the hand the bow is held upright with the
  // string toward you, and when it is drawn the arrow (to the top left here) points at the crosshair.
  return mirrorX(img);
}

/** The image flipped left to right. */
function mirrorX(img: Img): Img {
  const out = newImg();
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      const a = (y * T + x) * 4;
      const b = (y * T + (T - 1 - x)) * 4;
      for (let c = 0; c < 4; c++) out[b + c] = img[a + c];
    }
  return out;
}

/** An arrow, nose to the top right: a flint head, a wooden shaft and grey fletching. */
export function arrowSprite(): Img {
  const img = newImg();
  const shaft = PAL.handle;
  for (let k = 0; k <= 9; k++) put(img, 3 + k, 12 - k, shaft[k % 2 ? 1 : 2]);
  // the head
  const head: Pal = pal("#3a3a42", "#62626c", "#9a9aa4");
  put(img, 13, 2, head[2]);
  put(img, 12, 2, head[1]);
  put(img, 13, 3, head[1]);
  put(img, 14, 1, head[2]);
  put(img, 11, 2, head[0]);
  put(img, 13, 4, head[0]);
  // the fletching
  const f: Pal = pal("#9a9aa2", "#d0d0d8", "#f4f4f8");
  for (const [x, y, c] of [[2, 12, 2], [1, 13, 1], [3, 13, 1], [2, 14, 0], [1, 11, 2], [4, 14, 0], [3, 11, 1], [4, 12, 2]] as [number, number, number][]) put(img, x, y, f[c]);
  return img;
}

const BUCKET = [
  "................",
  "....hhhhhhhh....",
  "...h........h...",
  "..h..........h..",
  "..#cccccccccc#..",
  "..#CCCCCCCCCC#..",
  "..############..",
  "..############..",
  "...##########...",
  "...##########...",
  "...##########...",
  "....########....",
  "....########....",
  "................",
  "................",
  "................",
];

/** A bucket: grey iron with a handle; `contents` fills its mouth (water or milk), or it shows the dark inside. */
export function bucket(contents: "none" | "water" | "milk"): Img {
  const inside = contents === "water" ? pal("#1f4fb8", "#3a72e0", "#78a8ff") : contents === "milk" ? pal("#cfcfd6", "#f0f0f3", "#ffffff") : pal("#232327", "#34343a", "#45454c");
  const deep: Pal = [scale(inside[0], 0.85), scale(inside[1], 0.85), scale(inside[1], 0.95)];
  return sprite(BUCKET, { "#": pal("#5e5e66", "#9a9aa2", "#c8c8ce"), h: pal("#4a4a52", "#76767e", "#a4a4ac"), c: inside, C: deep });
}

const HOE_HEAD = [
  "................",
  ".....#######....",
  "....########....",
  "...........##...",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
];

/** A hoe: the common handle and a flat blade turned back over it. */
export function hoeSprite(material: number): Img {
  const p = [PAL.wood, PAL.stone, PAL.iron, PAL.gold, PAL.diamond][material];
  const img = newImg();
  handle(img, 9);
  sprite(HOE_HEAD, { "#": p }, img);
  return img;
}

// ------------------------------------------------------------------ v8: the boat, clay and bricks, coconuts

const BOAT = [
  "................",
  "................",
  "................",
  "..........o.....",
  ".........o......",
  "........o.......",
  ".......o........",
  "#.....o........#",
  "##sssssssssssss#",
  ".##rrrrrrrrrrr#.",
  ".#############..",
  "..###########...",
  "...#########....",
  "................",
  "................",
  "................",
];

/** The boat as an item: a little rowboat side on, with a teal stripe along the gunwale and an oar across it. */
export function boatItem(): Img {
  return sprite(BOAT, {
    "#": pal("#5a3e1e", "#8a6334", "#b08446"),
    s: pal("#7a5528", "#a87c42", "#d0a86a"),
    r: pal("#14706f", "#22a3a3", "#5fd0cc"),
    o: pal("#4a361f", "#6e5331", "#8f7044"),
  });
}

/** A ball of clay, grey-blue and smooth. */
export function clayBall(): Img {
  return lump(pal("#7c8492", "#a2aab7", "#c9cfd8"), 1701);
}

const BRICK = [
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "....##########..",
  "...##########...",
  "..##########....",
  "..#########.....",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
];

/** One fired brick. */
export function brickItem(): Img {
  const img = sprite(BRICK, { "#": pal("#7a3626", "#a4503a", "#c8705a") });
  put(img, 6, 7, hex("#8a4030"));
  put(img, 9, 8, hex("#8a4030"));
  return img;
}

const COCONUT = [
  "................",
  "................",
  "................",
  "......####......",
  "....########....",
  "...##########...",
  "..############..",
  "..############..",
  "..############..",
  "..############..",
  "...##########...",
  "....########....",
  "......####......",
  "................",
  "................",
  "................",
];

/** A coconut: a round brown husk, fibrous, with the three dark eyes. */
export function coconut(): Img {
  const img = sprite(COCONUT, { "#": pal("#4a2e18", "#6e4524", "#94643a") });
  const r = mulberry32(1702);
  for (let k = 0; k < 14; k++) {
    const x = 3 + Math.floor(r() * 10);
    const y = 4 + Math.floor(r() * 8);
    if (COCONUT[y][x] === "#") put(img, x, y, hex(r() < 0.5 ? "#5a381c" : "#a6764a"));
  }
  for (const [x, y] of [[7, 5], [9, 5], [8, 7]]) put(img, x, y, hex("#2a1a0c"));
  return img;
}

const SMOKED_FISH = [
  "................",
  "................",
  "................",
  "..........##....",
  ".........#..#...",
  "...#####.#..#...",
  "..#######...#...",
  ".##o#######.#...",
  ".###########....",
  "..##########.#..",
  "...#######..##..",
  "............#...",
  "................",
  "................",
  "................",
  "................",
];

/** v9: smoked fish (the fisher's): a golden-brown fish on a loop of string, darker along the back, a bright eye. */
export function smokedFish(): Img {
  const img = sprite(SMOKED_FISH, { "#": pal("#7a4a1e", "#a86a2c", "#d29a4c"), o: pal("#f2e6c8", "#f2e6c8", "#f2e6c8") });
  // the back darker, the belly lighter, a few smoky stripes
  for (let x = 2; x <= 11; x++) {
    if (SMOKED_FISH[6][x] === "#") put(img, x, 6, hex("#5e3816"));
    if (SMOKED_FISH[9][x] === "#") put(img, x, 9, hex("#e0ae62"));
  }
  for (const x of [5, 8]) for (let y = 6; y <= 9; y++) if (SMOKED_FISH[y][x] === "#") put(img, x, y, hex("#6a3e18"));
  // the string loop through the tail: pale grey
  for (const [x, y] of [[10, 3], [11, 3], [9, 4], [12, 4], [9, 5], [12, 5], [12, 6], [12, 7], [13, 9], [12, 10], [13, 10], [12, 11]]) put(img, x, y, hex("#cfcac0"));
  put(img, 3, 7, hex("#1e140a"));
  return img;
}
