// Horizontal slices through the generated world (caves black, ores in colour) plus one vertical cut, as a PNG.
// Usage: node tools/cave-preview.ts [seed] [out.png]
import { B, BLOCKS } from "../shared/blocks.ts";
import { DEFAULT_SEED, WORLD_HEIGHT, WORLD_SIZE, idx } from "../shared/constants.ts";
import { generateWorld } from "../shared/worldgen.ts";
import { writePNG } from "./png.ts";

const seed = Number(process.argv[2] ?? DEFAULT_SEED);
const out = process.argv[3] ?? "caves.png";
const { blocks, info } = generateWorld(seed);
const W = WORLD_SIZE;
const ys = [14, 26, 38];
const GAP = 8;
const cutH = WORLD_HEIGHT;
const IW = W * ys.length + GAP * (ys.length - 1);
const IH = W + GAP + cutH * 2;
const img = new Uint8Array(IW * IH * 4).fill(255);
const ORE: Record<number, [number, number, number]> = {
  [B.COAL_ORE]: [20, 20, 20],
  [B.IRON_ORE]: [220, 160, 110],
  [B.GOLD_ORE]: [255, 210, 40],
  [B.DIAMOND_ORE]: [60, 230, 235],
  [B.RUBY_ORE]: [235, 40, 40],
};
function color(id: number): [number, number, number] {
  if (id === B.AIR) return [8, 8, 10];
  if (id === B.WATER) return [40, 80, 200];
  if (ORE[id]) return ORE[id];
  const c = BLOCKS[id].color;
  return [(c >> 16) & 255, (c >> 8) & 255, c & 255];
}
const px = (x: number, y: number, c: [number, number, number]) => {
  const o = (y * IW + x) * 4;
  img[o] = c[0];
  img[o + 1] = c[1];
  img[o + 2] = c[2];
  img[o + 3] = 255;
};
ys.forEach((y, k) => {
  for (let z = 0; z < W; z++) for (let x = 0; x < W; x++) px(k * (W + GAP) + x, z, color(blocks[idx(x, y, z)]));
});
// Vertical cut along z = 200 (x across, y up), drawn 2x tall.
const zc = 200;
for (let y = 0; y < cutH; y++)
  for (let x = 0; x < W; x++) {
    const c = color(blocks[idx(x, y, zc)]);
    px(x, W + GAP + (cutH - 1 - y) * 2, c);
    px(x, W + GAP + (cutH - 1 - y) * 2 + 1, c);
  }
writePNG(out, IW, IH, img);
console.log(JSON.stringify(info.caves));
