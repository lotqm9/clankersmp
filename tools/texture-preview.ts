// Writes every generated block texture layer to one PNG sheet (8x scale) for review.
// Usage: node tools/texture-preview.ts [out.png]
import { TEX, TEX_LAYERS } from "../shared/blocks.ts";
import { T, buildTextureLayers } from "../shared/textures.ts";
import { writePNG } from "./png.ts";

const out = process.argv[2] ?? "textures.png";
const layers = buildTextureLayers();
const S = 8;
const COLS = 10;
const GAP = 6;
const rows = Math.ceil(TEX_LAYERS / COLS);
const W = COLS * (T * S + GAP) + GAP;
const H = rows * (T * S + GAP) + GAP;
const img = new Uint8Array(W * H * 4);
for (let i = 0; i < W * H; i++) {
  img[i * 4] = 40;
  img[i * 4 + 1] = 40;
  img[i * 4 + 2] = 48;
  img[i * 4 + 3] = 255;
}
for (let l = 0; l < TEX_LAYERS; l++) {
  const ox = GAP + (l % COLS) * (T * S + GAP);
  const oy = GAP + Math.floor(l / COLS) * (T * S + GAP);
  const src = layers[l];
  for (let y = 0; y < T * S; y++)
    for (let x = 0; x < T * S; x++) {
      const sx = Math.floor(x / S);
      const sy = Math.floor(y / S);
      const so = (sy * T + sx) * 4;
      const a = src[so + 3] / 255;
      const check = ((x >> 3) + (y >> 3)) % 2 ? 150 : 110;
      const o = ((oy + y) * W + ox + x) * 4;
      img[o] = src[so] * a + check * (1 - a);
      img[o + 1] = src[so + 1] * a + check * (1 - a);
      img[o + 2] = src[so + 2] * a + check * (1 - a);
      img[o + 3] = 255;
    }
}
writePNG(out, W, H, img);
const names = Object.entries(TEX).map(([k, v]) => `${v}:${k}`);
console.log(`wrote ${out} (${W}x${H}); layers: ${names.join(" ")}`);
