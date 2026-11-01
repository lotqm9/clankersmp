// Renders a shaded top-down map of the generated world to a PNG and prints generation stats.
// Usage: node tools/map-preview.ts [seed] [out.png]
import { BLOCKS, B } from "../shared/blocks.ts";
import { DEFAULT_SEED, WORLD_HEIGHT, WORLD_SIZE, idx } from "../shared/constants.ts";
import { generateWorld, hashBlocks } from "../shared/worldgen.ts";
import { writePNG } from "./png.ts";

const seed = Number(process.argv[2] ?? DEFAULT_SEED);
const out = process.argv[3] ?? "map.png";
const t0 = performance.now();
const { blocks, info } = generateWorld(seed);
const t1 = performance.now();
const hash = hashBlocks(blocks);
const t2 = performance.now();

const S = Number(process.env.S ?? 2);
const img = new Uint8Array(WORLD_SIZE * S * WORLD_SIZE * S * 4);
const counts = new Map<number, number>();
const tops = new Int16Array(WORLD_SIZE * WORLD_SIZE);
for (let z = 0; z < WORLD_SIZE; z++) {
  for (let x = 0; x < WORLD_SIZE; x++) {
    let y = WORLD_HEIGHT - 1;
    while (y > 0 && blocks[idx(x, y, z)] === B.AIR) y--;
    tops[z * WORLD_SIZE + x] = y;
  }
}
for (let z = 0; z < WORLD_SIZE; z++) {
  for (let x = 0; x < WORLD_SIZE; x++) {
    const y = tops[z * WORLD_SIZE + x];
    const id = blocks[idx(x, y, z)];
    counts.set(id, (counts.get(id) ?? 0) + 1);
    let c = BLOCKS[id].color;
    let r = (c >> 16) & 255;
    let g = (c >> 8) & 255;
    let b = c & 255;
    if (id === B.WATER) {
      let d = y;
      while (d > 0 && blocks[idx(x, d, z)] === B.WATER) d--;
      const depth = y - d;
      const k = Math.max(0.45, 1 - depth * 0.05);
      r *= k;
      g *= k;
      b *= k;
    } else {
      const west = tops[z * WORLD_SIZE + Math.max(0, x - 1)];
      const north = tops[Math.max(0, z - 1) * WORLD_SIZE + x];
      const k = 1 + (y - west) * 0.08 + (y - north) * 0.08;
      const kk = Math.max(0.6, Math.min(1.3, k));
      r = Math.min(255, r * kk);
      g = Math.min(255, g * kk);
      b = Math.min(255, b * kk);
    }
    c = 0;
    for (let dy = 0; dy < S; dy++)
      for (let dx = 0; dx < S; dx++) {
        const o = ((z * S + dy) * WORLD_SIZE * S + (x * S + dx)) * 4;
        img[o] = r;
        img[o + 1] = g;
        img[o + 2] = b;
        img[o + 3] = 255;
      }
  }
}
writePNG(out, WORLD_SIZE * S, WORLD_SIZE * S, img);
console.log(`seed ${seed}: generated in ${(t1 - t0).toFixed(0)} ms, hash ${hash.toString(16)} in ${(t2 - t1).toFixed(0)} ms`);
console.log("spawn", info.spawn, "board", info.board);
const named = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${BLOCKS[id].key}:${n}`);
console.log("top blocks:", named.join(" "));
let logs = 0;
for (let i = 0; i < blocks.length; i++) if (blocks[i] === B.OAK_LOG || blocks[i] === B.BIRCH_LOG) logs++;
console.log("log blocks:", logs, "-> roughly", Math.round(logs / 5), "trees");
