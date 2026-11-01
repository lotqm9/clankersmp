// The five ore textures (and plain stone) side by side at 12x, labelled: a review image for the update.
// Usage: node tools/ore-sheet.ts <out.png>
import { BLOCKS, B } from "../shared/blocks.ts";
import { T, buildTextureLayers } from "../shared/textures.ts";
import { writePNG } from "./png.ts";

const out = process.argv[2] ?? "ores.png";
const L = buildTextureLayers();
const ids = [B.STONE, B.COAL_ORE, B.IRON_ORE, B.GOLD_ORE, B.RUBY_ORE, B.DIAMOND_ORE];
const S = 12;
const GAP = 24;
const W = ids.length * (T * S + GAP) + GAP;
const H = T * S + GAP * 2;
const img = new Uint8Array(W * H * 4);
for (let i = 0; i < W * H; i++) {
  img[i * 4] = 245;
  img[i * 4 + 1] = 242;
  img[i * 4 + 2] = 236;
  img[i * 4 + 3] = 255;
}
ids.forEach((id, k) => {
  const layer = L[BLOCKS[id].tex[0]];
  const ox = GAP + k * (T * S + GAP);
  for (let y = 0; y < T * S; y++)
    for (let x = 0; x < T * S; x++) {
      const s = (Math.floor(y / S) * T + Math.floor(x / S)) * 4;
      const o = ((GAP + y) * W + ox + x) * 4;
      img[o] = layer[s];
      img[o + 1] = layer[s + 1];
      img[o + 2] = layer[s + 2];
      img[o + 3] = 255;
    }
});
writePNG(out, W, H, img);
console.log(ids.map((id) => BLOCKS[id].name).join(" | "));
