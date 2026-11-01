// GPU textures built from the procedural pixel art: the block texture array, isometric block icons
// for the hotbar and picker, the (original) player skin, and the sun and moon.

import * as THREE from "three";
import { B, BLOCKS, RENDER, TEX, TEX_LAYERS } from "../../../shared/blocks.ts";
import { itemDef } from "../../../shared/items.ts";
import { faceUV, flatItem, isDoor, itemBoxes, type ModelBox } from "../../../shared/shapes.ts";
import { mulberry32 } from "../../../shared/noise.ts";
import { T, averageColor, buildTextureLayers } from "../../../shared/textures.ts";

let arrayTex: THREE.DataArrayTexture | null = null;

/** All block textures as one texture array (layer = TEX index). Transparent texels get the tile's
 *  average colour so mipmaps of leaves and glass do not grow dark fringes. */
export function blockTextureArray(): THREE.DataArrayTexture {
  if (arrayTex) return arrayTex;
  const layers = buildTextureLayers();
  const data = new Uint8Array(T * T * 4 * TEX_LAYERS);
  for (let l = 0; l < TEX_LAYERS; l++) {
    const src = layers[l];
    const [ar, ag, ab] = averageColor(src);
    const off = l * T * T * 4;
    for (let i = 0; i < T * T * 4; i += 4) {
      if (src[i + 3] === 0) {
        data[off + i] = ar;
        data[off + i + 1] = ag;
        data[off + i + 2] = ab;
        data[off + i + 3] = 0;
      } else {
        data[off + i] = src[i];
        data[off + i + 1] = src[i + 1];
        data[off + i + 2] = src[i + 2];
        data[off + i + 3] = src[i + 3];
      }
    }
  }
  const tex = new THREE.DataArrayTexture(data, T, T, TEX_LAYERS);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  arrayTex = tex;
  return tex;
}

/** A 16x16 layer as a canvas (optionally darkened). */
export function layerCanvas(layer: number, shade = 1): HTMLCanvasElement {
  const src = buildTextureLayers()[layer];
  const c = document.createElement("canvas");
  c.width = T;
  c.height = T;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(T, T);
  for (let i = 0; i < src.length; i += 4) {
    img.data[i] = src[i] * shade;
    img.data[i + 1] = src[i + 1] * shade;
    img.data[i + 2] = src[i + 2] * shade;
    img.data[i + 3] = src[i + 3];
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

const iconCache = new Map<number, HTMLCanvasElement>();

/** Inventory icon for any item: blocks as isometric blocks (furnaces show their front), items as their sprite. */
export function itemIcon(id: number): HTMLCanvasElement {
  if (id < 256) return blockIcon(id === B.FURNACE ? B.FURNACE + 2 : id);
  const cached = iconCache.get(id);
  if (cached) return cloneCanvas(cached);
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  const def = itemDef(id);
  if (def) ctx.drawImage(layerCanvas(def.tex), 0, 0, 64, 64);
  iconCache.set(id, c);
  return cloneCanvas(c);
}

/** Isometric inventory icon for a block (64x64 canvas). Plants and torches are drawn flat. */
export function blockIcon(id: number): HTMLCanvasElement {
  const cached = iconCache.get(id);
  if (cached) return cloneCanvas(cached);
  const S = 64;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  const def = BLOCKS[id];
  const kind = RENDER[id];
  if (isDoor(id)) {
    ctx.drawImage(layerCanvas(TEX.door_upper), S / 4, 0, S / 2, S / 2);
    ctx.drawImage(layerCanvas(TEX.door_lower), S / 4, S / 2, S / 2, S / 2);
  } else if (kind === 4 || kind === 5 || flatItem(id)) {
    ctx.drawImage(layerCanvas(def.tex[0]), 0, 0, S, S);
  } else if (kind === 6) {
    drawModelIcon(ctx, itemBoxes(id) ?? [], S / 32);
  } else {
    const k = S / 32;
    const top = layerCanvas(def.tex[2], 1);
    const left = layerCanvas(def.tex[4], 0.8);
    const right = layerCanvas(def.tex[0], 0.62);
    // Top rhombus: u -> towards the right vertex, v -> towards the left vertex.
    ctx.setTransform((14 / 16) * k, (7 / 16) * k, (-14 / 16) * k, (7 / 16) * k, 16 * k, 1 * k);
    ctx.drawImage(top, 0, 0);
    ctx.setTransform((14 / 16) * k, (7 / 16) * k, 0, k, 2 * k, 8 * k);
    ctx.drawImage(left, 0, 0);
    ctx.setTransform((14 / 16) * k, (-7 / 16) * k, 0, k, 16 * k, 15 * k);
    ctx.drawImage(right, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  iconCache.set(id, c);
  return cloneCanvas(c);
}

/** Isometric drawing of model boxes with the same projection as the cube icons:
 *  P(x, y, z) = k * (14/16 * (x - z) + 16, 7/16 * (x + z) + 17 - y), x/y/z in 1/16 block. Visible faces are
 *  the top, the south face (left) and the east face (right); boxes are drawn back to front. */
function drawModelIcon(ctx: CanvasRenderingContext2D, boxes: ModelBox[], k: number): void {
  const depth = (b: ModelBox["b"]) => (b[0] + b[3]) / 2 + ((b[1] + b[4]) / 2) * (7 / 8) + (b[2] + b[5]) / 2;
  const sorted = boxes.slice().sort((a, b) => depth(a.b) - depth(b.b));
  const face = (layer: number, shade: number, sx: number, sy: number, sw: number, sh: number) => {
    if (sw <= 0 || sh <= 0) return;
    ctx.drawImage(layerCanvas(layer, shade), sx, sy, sw, sh, sx, sy, sw, sh);
  };
  for (const mb of sorted) {
    const [x0, y0, z0, x1, y1, z1] = mb.b;
    // South (+Z) face at z1: u = x, v = 16 - y.
    ctx.setTransform((14 / 16) * k, (7 / 16) * k, 0, k, k * (16 - (14 / 16) * z1), k * (1 + (7 / 16) * z1));
    face(mb.tex[4], 0.8, x0, 16 - y1, x1 - x0, y1 - y0);
    // East (+X) face at x1: u = 16 - z, v = 16 - y.
    ctx.setTransform((14 / 16) * k, (-7 / 16) * k, 0, k, k * ((14 / 16) * x1 + 2), k * ((7 / 16) * x1 + 8));
    face(mb.tex[0], 0.62, 16 - z1, 16 - y1, z1 - z0, y1 - y0);
    // Top face at y1: u = x, v = z.
    ctx.setTransform((14 / 16) * k, (7 / 16) * k, (-14 / 16) * k, (7 / 16) * k, 16 * k, k * (17 - y1));
    const [u0, v0] = faceUV(2, x0, y1, z0);
    face(mb.tex[2], 1, u0, v0, x1 - x0, z1 - z0);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  c.getContext("2d")!.drawImage(src, 0, 0);
  return c;
}

// ------------------------------------------------------------------ player skin (original art)

export const SHIRTS = ["#3a8f3a", "#2f6fbf", "#c0392b", "#e08a1e", "#7d4fbf", "#1fa0a0", "#d4b21f", "#e05a9a"];
/** Skin tone, its shade, hair, hair shade. */
const TONES: [string, string, string, string][] = [
  ["#d39a6f", "#b97f57", "#4a2f1b", "#3a2414"],
  ["#f0c8a0", "#d9aa80", "#8a5a2b", "#6e4620"],
  ["#a86b45", "#8c5636", "#22180f", "#160f09"],
  ["#6e4529", "#5a371f", "#141010", "#0a0808"],
];

function hex(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 64x64 skin in the usual box-UV layout ($STEVE Craft's own player art): shirt colour and skin tone vary per player;
 *  a gold "$" on the chest. */
export function makeSkin(variant: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(64, 64);
  const rand = mulberry32(1234 + variant);
  const px = (x: number, y: number, col: string, jitter = 0.05) => {
    const [r, g, b] = hex(col);
    const k = 1 + (rand() - 0.5) * 2 * jitter;
    const o = (y * 64 + x) * 4;
    img.data[o] = Math.min(255, r * k);
    img.data[o + 1] = Math.min(255, g * k);
    img.data[o + 2] = Math.min(255, b * k);
    img.data[o + 3] = 255;
  };
  const rect = (x0: number, y0: number, x1: number, y1: number, col: string, jitter = 0.05) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px(x, y, col, jitter);
  };
  if (variant >= AGENT_SKIN_BASE && variant < AGENT_SKIN_BASE + AGENT_LOOKS.length) {
    agentSkin(variant - AGENT_SKIN_BASE, px, rect);
    ctx.putImageData(img, 0, 0);
    return c;
  }
  const shirt = SHIRTS[variant % SHIRTS.length];
  const shirtDark = shade(shirt, 0.78);
  const [skin, skinDark, hair, hairDark] = TONES[Math.floor(variant / SHIRTS.length) % TONES.length];
  const pants = "#34405f";
  const pantsDark = "#2a3450";
  const shoe = "#4a4a4f";
  const shoeDark = "#333338";
  const belt = "#3d2a19";

  // Head: top, bottom, right, front, left, back (u=0, v=0, 8x8x8)
  rect(8, 0, 16, 8, hair, 0.12);
  rect(16, 0, 24, 8, skinDark);
  for (const [x0] of [[0], [16], [24]]) {
    rect(x0, 8, x0 + 8, 16, skin);
    rect(x0, 8, x0 + 8, 11, hair, 0.12);
  }
  rect(24, 8, 32, 15, hair, 0.12); // back of the head is mostly hair
  px(2, 12, skinDark); // ears
  px(21, 12, skinDark);
  // Face
  rect(8, 8, 16, 16, skin, 0.03);
  rect(8, 8, 16, 10, hair, 0.12);
  rect(8, 10, 11, 11, hair, 0.12); // side-swept fringe
  px(15, 10, hairDark);
  px(8, 11, hairDark);
  px(9, 12, "#ffffff", 0);
  px(10, 12, "#2f6fd0", 0);
  px(13, 12, "#2f6fd0", 0);
  px(14, 12, "#ffffff", 0);
  px(11, 13, skinDark);
  px(12, 13, skinDark);
  rect(10, 14, 14, 15, "#8c4f3c", 0);
  px(9, 14, skinDark);
  px(14, 14, skinDark);

  // Body (u=16, v=16, 8x12x4)
  rect(20, 16, 28, 20, shirt);
  rect(28, 16, 36, 20, pantsDark);
  rect(16, 20, 40, 32, shirt, 0.06);
  rect(16, 20, 20, 32, shirtDark, 0.06);
  rect(28, 20, 32, 32, shirtDark, 0.06);
  rect(16, 31, 40, 32, belt, 0.04);
  px(23, 20, skin);
  px(24, 20, skin);
  px(23, 21, skin);
  px(24, 21, skin);
  // "$" on the chest, 3x5, gold (white on the gold shirt)
  const mark = shirt === "#d4b21f" ? "#ffffff" : "#ffd23f";
  const dollar = [".##", "#..", ".#.", "..#", "##."];
  dollar.forEach((row, ry) => [...row].forEach((ch, rx) => ch === "#" && px(22 + rx, 24 + ry, mark, 0)));
  px(23, 23, mark, 0);
  px(23, 29, mark, 0);

  // Arms (right u=40,v=16; left u=32,v=48), 4x12x4: short sleeves, skin below.
  for (const [u, v] of [
    [40, 16],
    [32, 48],
  ]) {
    rect(u + 4, v, u + 8, v + 4, shirt);
    rect(u + 8, v, u + 12, v + 4, skinDark);
    rect(u, v + 4, u + 16, v + 16, skin, 0.04);
    rect(u, v + 4, u + 16, v + 8, shirt, 0.06);
    rect(u, v + 4, u + 4, v + 8, shirtDark, 0.06);
    rect(u, v + 15, u + 16, v + 16, skinDark, 0.03);
  }
  // Legs (right u=0,v=16; left u=16,v=48), 4x12x4: trousers and shoes.
  for (const [u, v] of [
    [0, 16],
    [16, 48],
  ]) {
    rect(u + 4, v, u + 8, v + 4, pants);
    rect(u + 8, v, u + 12, v + 4, shoeDark);
    rect(u, v + 4, u + 16, v + 16, pants, 0.06);
    rect(u, v + 4, u + 4, v + 16, pantsDark, 0.06);
    rect(u, v + 13, u + 16, v + 16, shoe, 0.05);
    rect(u, v + 15, u + 16, v + 16, shoeDark, 0.03);
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** clankersmp's three wear their own clothes (skin variants 100, 101, 102; the server hands them out by name): opus
 *  in a red hoodie with the hood up, sonnet in a blue jacket, haiku in a yellow raincoat with the hood up. */
export const AGENT_SKIN_BASE = 100;
const AGENT_LOOKS = [
  { coat: "#c62f28", hood: true, tone: 1, hair: "#2b1d14", eye: "#3b2a1e", pants: "#2a3242", shoe: "#e9e9e6", shoeDark: "#b4b4ae" },
  { coat: "#2c5bd0", hood: false, tone: 0, hair: "#5b3a20", eye: "#2f6fd0", pants: "#3b3f48", shoe: "#5a3a22", shoeDark: "#43291a" },
  { coat: "#f0bd12", hood: true, tone: 1, hair: "#3a2414", eye: "#2a2a2a", pants: "#24314d", shoe: "#24314d", shoeDark: "#1a2438" },
];

type Px = (x: number, y: number, col: string, jitter?: number) => void;
type Rect = (x0: number, y0: number, x1: number, y1: number, col: string, jitter?: number) => void;

function agentSkin(i: number, px: Px, rect: Rect): void {
  const L = AGENT_LOOKS[i];
  const coat = L.coat;
  const coatDark = shade(coat, 0.78);
  const coatDeep = shade(coat, 0.58);
  const coatLight = shade(coat, 1.15);
  const [skin, skinDark] = TONES[L.tone];
  const hair = L.hair;
  const hairDark = shade(hair, 0.75);

  // Head (u=0, v=0, 8x8x8)
  if (L.hood) {
    rect(8, 0, 16, 8, coat, 0.06);
    rect(16, 0, 24, 8, skinDark);
    for (const x0 of [0, 16, 24]) rect(x0, 8, x0 + 8, 16, coat, 0.06);
    for (const x0 of [0, 16, 24]) rect(x0, 15, x0 + 8, 16, coatDark, 0.03); // the hood's hem
    for (let y = 8; y < 15; y++) px(28, y, coatDark, 0.03); // the seam down the back
    // the face, framed by the hood (its rim over the brow, its dark inside at the cheeks)
    rect(8, 8, 16, 9, coat, 0.04);
    for (let y = 9; y < 16; y++) {
      px(8, y, coatDeep, 0.03);
      px(15, y, coatDeep, 0.03);
    }
    rect(9, 9, 15, 16, skin, 0.03);
    rect(9, 9, 15, 10, hair, 0.12);
    px(9, 10, hair, 0.12);
    px(10, 10, hairDark);
    px(14, 10, hair, 0.12);
  } else {
    rect(8, 0, 16, 8, hair, 0.12);
    rect(16, 0, 24, 8, skinDark);
    for (const x0 of [0, 16, 24]) {
      rect(x0, 8, x0 + 8, 16, skin);
      rect(x0, 8, x0 + 8, 11, hair, 0.12);
    }
    rect(24, 8, 32, 15, hair, 0.12);
    px(2, 12, skinDark);
    px(21, 12, skinDark);
    rect(8, 8, 16, 16, skin, 0.03);
    rect(8, 8, 16, 10, hair, 0.12);
    rect(8, 10, 11, 11, hair, 0.12);
    px(15, 10, hairDark);
    px(8, 11, hairDark);
    px(9, 14, skinDark);
    px(14, 14, skinDark);
  }
  px(9, 12, "#ffffff", 0);
  px(10, 12, L.eye, 0);
  px(13, 12, L.eye, 0);
  px(14, 12, "#ffffff", 0);
  px(11, 13, skinDark);
  px(12, 13, skinDark);
  rect(10, 14, 14, 15, "#8c4f3c", 0);

  // Body (u=16, v=16, 8x12x4): the coat all round, a darker hem
  rect(20, 16, 28, 20, coat);
  rect(28, 16, 36, 20, L.pants);
  rect(16, 20, 40, 32, coat, 0.06);
  rect(16, 20, 20, 32, coatDark, 0.06);
  rect(28, 20, 32, 32, coatDark, 0.06);
  rect(16, 31, 40, 32, coatDark, 0.04);
  if (i === 0) {
    // hoodie: the neck opening, two white drawstrings, the front pocket
    px(23, 20, coatDeep, 0);
    px(24, 20, coatDeep, 0);
    for (let y = 20; y < 24; y++) {
      px(22, y, "#f1f1ee", 0);
      px(25, y, "#f1f1ee", 0);
    }
    rect(21, 26, 27, 30, coatDark, 0.04);
    rect(21, 26, 27, 27, coatDeep, 0.03);
  } else if (i === 1) {
    // jacket: the collar, a white tee at the neck, the zip, two pocket welts
    for (const x of [21, 22, 25, 26]) px(x, 20, coatLight, 0.03);
    px(23, 20, "#efefef", 0);
    px(24, 20, "#efefef", 0);
    for (let y = 21; y < 31; y++) {
      px(23, y, coatDark, 0.03);
      px(24, y, "#cfd3da", 0.02);
    }
    rect(21, 27, 23, 28, coatDeep, 0.03);
    rect(25, 27, 27, 28, coatDeep, 0.03);
  } else {
    // raincoat: the collar, the placket, three dark toggles
    rect(21, 20, 23, 21, coatDark, 0.03);
    rect(25, 20, 27, 21, coatDark, 0.03);
    px(23, 20, skinDark);
    px(24, 20, skinDark);
    for (let y = 21; y < 31; y++) px(23, y, coatDark, 0.03);
    for (const y of [22, 25, 28]) px(24, y, "#3a2a10", 0);
  }

  // Arms (right u=40,v=16; left u=32,v=48), 4x12x4: long sleeves, a cuff, the hand
  for (const [u, v] of [
    [40, 16],
    [32, 48],
  ]) {
    rect(u + 4, v, u + 8, v + 4, coat);
    rect(u + 8, v, u + 12, v + 4, skinDark);
    rect(u, v + 4, u + 16, v + 16, coat, 0.06);
    rect(u, v + 4, u + 4, v + 16, coatDark, 0.06);
    rect(u, v + 13, u + 16, v + 14, coatDark, 0.03);
    rect(u, v + 14, u + 16, v + 16, skin, 0.04);
    rect(u, v + 15, u + 16, v + 16, skinDark, 0.03);
  }
  // Legs (right u=0,v=16; left u=16,v=48), 4x12x4: trousers and shoes (haiku: the raincoat's skirt, tall boots)
  for (const [u, v] of [
    [0, 16],
    [16, 48],
  ]) {
    rect(u + 4, v, u + 8, v + 4, L.pants);
    rect(u + 8, v, u + 12, v + 4, L.shoeDark);
    rect(u, v + 4, u + 16, v + 16, L.pants, 0.06);
    rect(u, v + 4, u + 4, v + 16, shade(L.pants, 0.8), 0.06);
    if (i === 2) {
      rect(u, v + 4, u + 16, v + 8, coat, 0.06);
      rect(u, v + 4, u + 4, v + 8, coatDark, 0.06);
      rect(u, v + 8, u + 16, v + 9, coatDark, 0.04);
      rect(u, v + 11, u + 16, v + 16, L.shoe, 0.05);
    }
    rect(u, v + 13, u + 16, v + 16, L.shoe, 0.05);
    rect(u, v + 15, u + 16, v + 16, L.shoeDark, 0.03);
  }
}

function shade(h: string, k: number): string {
  const [r, g, b] = hex(h);
  const f = (v: number) => Math.round(v * k).toString(16).padStart(2, "0");
  return `#${f(r)}${f(g)}${f(b)}`;
}

export function canvasTexture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** Square sun with a soft rim (drawn additively). */
export function sunTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 32;
  c.height = 32;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "rgba(255, 220, 120, 0.25)";
  ctx.fillRect(4, 4, 24, 24);
  ctx.fillStyle = "rgba(255, 236, 160, 0.6)";
  ctx.fillRect(7, 7, 18, 18);
  ctx.fillStyle = "#fffbe6";
  ctx.fillRect(9, 9, 14, 14);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(11, 11, 10, 10);
  return canvasTexture(c);
}

/** Pale square moon with a few craters. */
export function moonTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 32;
  c.height = 32;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#e6eaf2";
  ctx.fillRect(9, 9, 14, 14);
  ctx.fillStyle = "#c3c9d6";
  for (const [x, y, w, h] of [
    [11, 11, 3, 3],
    [17, 12, 2, 2],
    [14, 17, 4, 3],
    [19, 19, 2, 2],
    [10, 19, 2, 2],
  ]) {
    ctx.fillRect(x, y, w, h);
  }
  return canvasTexture(c);
}
