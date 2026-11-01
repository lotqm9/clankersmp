// v6: our own fire, for the flames on a burning mob (render/fire.ts). Two 16 x 16 animations of 32 frames each,
// side by side in one sheet (32 x 512): a small cellular fire (heat rises and cools), seeded so it is the same
// every time, coloured from deep red at the tips to a pale yellow core.

import { mulberry32 } from "./noise.ts";

export const FIRE_SIZE = 16;
export const FIRE_FRAMES = 32;

/** Heat (0-1) to colour, through deep red at the tips to a pale yellow core; under CUT it is see-through. */
const CUT = 0.2;
const STOPS: [number, number, number, number][] = [
  [0.2, 150, 28, 6],
  [0.32, 200, 52, 10],
  [0.46, 236, 98, 20],
  [0.6, 248, 146, 34],
  [0.74, 252, 196, 66],
  [0.88, 254, 232, 128],
  [1.0, 255, 250, 210],
];
function colour(h: number): [number, number, number] {
  for (let i = 1; i < STOPS.length; i++) {
    if (h <= STOPS[i][0]) {
      const [a0, r0, g0, b0] = STOPS[i - 1];
      const [a1, r1, g1, b1] = STOPS[i];
      const k = (h - a0) / (a1 - a0);
      // a few hard steps, like pixel art, not a smooth ramp
      const q = Math.round(k * 2) / 2;
      return [Math.round(r0 + (r1 - r0) * q), Math.round(g0 + (g1 - g0) * q), Math.round(b0 + (b1 - b0) * q)];
    }
  }
  return [STOPS[STOPS.length - 1][1], STOPS[STOPS.length - 1][2], STOPS[STOPS.length - 1][3]];
}

/** One fire's frames: heat (0-1), FIRE_SIZE x FIRE_SIZE each. The old demo-scene fire: each cell is the average of
 *  the cells under it, a little cooler, so heat rises in tongues; the fuel under the picture flickers in clumps. */
function simulate(seed: number, cooling: number): Float32Array[] {
  const W = FIRE_SIZE;
  const H = FIRE_SIZE + 3; // fuel rows under the picture
  const r = mulberry32(seed);
  let heat = new Float32Array(W * H);
  let next = new Float32Array(W * H);
  const at = (g: Float32Array, x: number, y: number) => (y >= H ? 0 : g[y * W + ((x + W) % W)]); // wraps sideways
  // the fuel: hot all along the bottom (fire fills the sheet's width), hottest in a few spots that wander about
  const spots = Array.from({ length: 5 }, () => ({ x: r() * W, v: (r() - 0.5) * 0.6 }));
  const frames: Float32Array[] = [];
  const step = () => {
    for (const s of spots) {
      s.v += (r() - 0.5) * 0.35;
      s.v = Math.max(-0.6, Math.min(0.6, s.v));
      s.x = (s.x + s.v + W) % W;
    }
    for (let y = H - 2; y < H; y++)
      for (let x = 0; x < W; x++) {
        let h = 0.55 + r() * 0.3;
        for (const s of spots) {
          const d = Math.min(Math.abs(x - s.x), W - Math.abs(x - s.x));
          h += Math.max(0, 1 - d / 1.9) * (0.7 + r() * 0.4);
        }
        next[y * W + x] = Math.min(1.3, h);
      }
    for (let y = 0; y < H - 2; y++)
      for (let x = 0; x < W; x++) {
        // mostly from straight below (tall tongues), a little from the sides
        const avg = at(heat, x - 1, y + 1) * 0.18 + at(heat, x, y + 1) * 0.42 + at(heat, x + 1, y + 1) * 0.18 + at(heat, x, y + 2) * 0.22;
        next[y * W + x] = Math.max(0, avg - cooling * (0.25 + r() * 1.5));
      }
    [heat, next] = [next, heat];
  };
  for (let k = 0; k < 80; k++) step(); // let it catch
  for (let f = 0; f < FIRE_FRAMES; f++) {
    step();
    frames.push(heat.slice(0, W * FIRE_SIZE));
  }
  return frames;
}

/** The sheet: fire 0 on the left, fire 1 on the right, frame f in rows 16f-16f+15. RGBA, alpha 0 or 255. */
export function fireSheet(): { width: number; height: number; rgba: Uint8Array } {
  const width = FIRE_SIZE * 2;
  const height = FIRE_SIZE * FIRE_FRAMES;
  const rgba = new Uint8Array(width * height * 4);
  [simulate(0xf17e, 0.08), simulate(0x0b1a2e, 0.088)].forEach((frames, v) => {
    frames.forEach((fr, f) => {
      for (let y = 0; y < FIRE_SIZE; y++)
        for (let x = 0; x < FIRE_SIZE; x++) {
          const h = Math.min(1, fr[y * FIRE_SIZE + x]);
          const o = ((f * FIRE_SIZE + y) * width + v * FIRE_SIZE + x) * 4;
          if (h < CUT) continue;
          const [cr, cg, cb] = colour(h);
          rgba[o] = cr;
          rgba[o + 1] = cg;
          rgba[o + 2] = cb;
          rgba[o + 3] = 255;
        }
    });
  });
  return { width, height, rgba };
}
