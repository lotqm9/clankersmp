// Worn armour (protocol v6) drawn on players: original textures painted in code for leather (stitched brown hide),
// iron (pale plates with rivets) and diamond (cyan facets with a sparkle), in the player-skin layout so the pieces
// wrap the same boxes a little bigger, like the classic armour layers:
//   layer 1: the helmet (the head + 1 px, open at the face), the chestplate (the body and the upper arms + 1 px),
//            the boots (the lower legs + 1 px)
//   layer 2: the leggings (the hips and the upper legs + 0.5 px)
// Used by the avatars (render/players.ts) and the 3D player in the inventory (player-preview.ts).

import { mulberry32 } from "../../../shared/noise.ts";

const T = 64;

type Box = { u: number; v: number; w: number; h: number; d: number };
type FaceName = "top" | "bottom" | "right" | "front" | "left" | "back";

export const ARMOR_BOX = {
  head: { u: 0, v: 0, w: 8, h: 8, d: 8 },
  body: { u: 16, v: 16, w: 8, h: 12, d: 4 },
  armR: { u: 40, v: 16, w: 4, h: 12, d: 4 },
  armL: { u: 32, v: 48, w: 4, h: 12, d: 4 },
  legR: { u: 0, v: 16, w: 4, h: 12, d: 4 },
  legL: { u: 16, v: 48, w: 4, h: 12, d: 4 },
} as const;

function rects(b: Box): Record<FaceName, [number, number, number, number]> {
  const { u, v, w, h, d } = b;
  return {
    top: [u + d, v, w, d],
    bottom: [u + d + w, v, w, d],
    right: [u, v + d, d, h],
    front: [u + d, v + d, w, h],
    left: [u + d + w, v + d, d, h],
    back: [u + d + w + d, v + d, w, h],
  };
}

const PALETTES = [
  { base: [139, 90, 43], dark: [110, 68, 32], light: [168, 114, 63], mark: [62, 34, 16] }, // leather
  { base: [200, 200, 204], dark: [154, 154, 160], light: [232, 232, 236], mark: [112, 112, 118] }, // iron
  { base: [79, 209, 217], dark: [42, 154, 163], light: [159, 243, 247], mark: [233, 255, 255] }, // diamond
];

const cache = new Map<string, HTMLCanvasElement>();

/** The texture for one material and layer (64 x 64, transparent where the piece doesn't cover). */
export function armorCanvas(material: number, layer: 1 | 2): HTMLCanvasElement {
  const key = `${material}:${layer}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = T;
  c.height = T;
  const g = c.getContext("2d")!;
  const img = g.createImageData(T, T);
  const pal = PALETTES[material];
  const rand = mulberry32(5100 + material * 7 + layer);
  const put = (x: number, y: number, rgb: number[]) => {
    if (x < 0 || y < 0 || x >= T || y >= T) return;
    const k = 1 + (rand() - 0.5) * 0.08;
    const o = (y * T + x) * 4;
    img.data[o] = Math.min(255, rgb[0] * k);
    img.data[o + 1] = Math.min(255, rgb[1] * k);
    img.data[o + 2] = Math.min(255, rgb[2] * k);
    img.data[o + 3] = 255;
  };
  /** Paint the rows [y0, y1) of a face (face-local), with an edge line on its first and last painted rows. */
  const fill = (b: Box, f: FaceName, y0: number, y1: number, skip?: (x: number, y: number) => boolean) => {
    const [fx, fy, w, h] = rects(b)[f];
    for (let y = Math.max(0, y0); y < Math.min(h, y1); y++)
      for (let x = 0; x < w; x++) {
        if (skip?.(x, y)) continue;
        const edge = y === Math.max(0, y0) || y === Math.min(h, y1) - 1;
        put(fx + x, fy + y, edge ? pal.dark : (x + y) % 5 === 0 ? pal.light : pal.base);
      }
  };
  const marks = (b: Box, f: FaceName, pts: [number, number][]) => {
    const [fx, fy] = rects(b)[f];
    for (const [x, y] of pts) put(fx + x, fy + y, pal.mark);
  };
  const sides: FaceName[] = ["front", "back", "left", "right"];
  if (layer === 1) {
    // helmet: crown, brow, cheek guards; open at the face
    const H = ARMOR_BOX.head;
    fill(H, "top", 0, 8);
    fill(H, "back", 0, 7);
    fill(H, "left", 0, 6);
    fill(H, "right", 0, 6);
    fill(H, "front", 0, 3);
    fill(H, "front", 3, 6, (x) => x > 0 && x < 7);
    marks(H, "front", [[1, 1], [6, 1]]);
    // chestplate: body (with a neck notch) and the upper arms
    const B = ARMOR_BOX.body;
    for (const f of sides) fill(B, f, 0, 10, f === "front" ? (x, y) => y === 0 && (x === 3 || x === 4) : undefined);
    fill(B, "top", 0, 4);
    marks(B, "front", material === 1 ? [[1, 2], [6, 2], [1, 7], [6, 7]] : material === 0 ? [[2, 3], [5, 3], [2, 6], [5, 6], [3, 8], [4, 8]] : [[2, 2], [5, 5]]);
    for (const A of [ARMOR_BOX.armR, ARMOR_BOX.armL]) {
      for (const f of sides) fill(A, f, 0, 6);
      fill(A, "top", 0, 4);
      marks(A, "front", [[1, 2]]);
    }
    // boots: the lower legs and the soles
    for (const L of [ARMOR_BOX.legR, ARMOR_BOX.legL]) {
      for (const f of sides) fill(L, f, 8, 12);
      fill(L, "bottom", 0, 4);
      marks(L, "front", [[1, 9]]);
    }
  } else {
    // leggings: the hips (a belt) and the upper legs
    const B = ARMOR_BOX.body;
    for (const f of sides) fill(B, f, 8, 12);
    marks(B, "front", [[3, 8], [4, 8]]);
    for (const L of [ARMOR_BOX.legR, ARMOR_BOX.legL]) {
      for (const f of sides) fill(L, f, 0, 9);
      fill(L, "top", 0, 4);
      marks(L, "front", [[1, 3], [2, 6]]);
    }
  }
  g.putImageData(img, 0, 0);
  cache.set(key, c);
  return c;
}

/** The four pieces: which layer each uses, which boxes it covers, and how much bigger than the body (px). */
export const PIECES: { slot: number; layer: 1 | 2; grow: number; parts: (keyof typeof ARMOR_BOX)[] }[] = [
  { slot: 0, layer: 1, grow: 1, parts: ["head"] },
  { slot: 1, layer: 1, grow: 1, parts: ["body", "armR", "armL"] },
  { slot: 2, layer: 2, grow: 0.5, parts: ["body", "legR", "legL"] },
  { slot: 3, layer: 1, grow: 1, parts: ["legR", "legL"] },
];
