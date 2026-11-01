// Original 16x16 block textures, generated procedurally (no Mojang assets).
// Each layer is RGBA, 16*16*4 bytes. The client uploads them as a texture array; tools/ writes previews.

import { TEX, TEX_LAYERS, WATER_FRAMES, CRACK_STAGES } from "./blocks.ts";
import { mulberry32 } from "./noise.ts";
import * as IT from "./item-textures.ts";

export const T = 16;
type RGB = [number, number, number];
type Img = Uint8Array;

function hex(h: string): RGB {
  const n = parseInt(h.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function newImg(): Img {
  return new Uint8Array(T * T * 4);
}
function put(img: Img, x: number, y: number, c: RGB, a = 255): void {
  const o = (((y + T) % T) * T + ((x + T) % T)) * 4;
  img[o] = clamp255(c[0]);
  img[o + 1] = clamp255(c[1]);
  img[o + 2] = clamp255(c[2]);
  img[o + 3] = a;
}
function get(img: Img, x: number, y: number): RGB {
  const o = (((y + T) % T) * T + ((x + T) % T)) * 4;
  return [img[o], img[o + 1], img[o + 2]];
}
function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}
function scale(c: RGB, k: number): RGB {
  return [c[0] * k, c[1] * k, c[2] * k];
}
function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Tileable value noise on the 16x16 torus. `cells` controls blob size. */
function valueNoise(rand: () => number, cells: number, sx = 1, sy = 1): (x: number, y: number) => number {
  const gw = cells * sx;
  const gh = cells * sy;
  const g = new Float32Array(gw * gh);
  for (let i = 0; i < g.length; i++) g[i] = rand();
  return (x: number, y: number) => {
    const fx = (x / T) * gw;
    const fy = (y / T) * gh;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const sxx = tx * tx * (3 - 2 * tx);
    const syy = ty * ty * (3 - 2 * ty);
    const at = (ix: number, iy: number) => g[(((iy % gh) + gh) % gh) * gw + (((ix % gw) + gw) % gw)];
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sxx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sxx;
    return a + (b - a) * syy;
  };
}

/** Picks a palette entry from a 0..1 value with per-pixel jitter. */
function paletteNoise(img: Img, rand: () => number, pal: RGB[], field: (x: number, y: number) => number, jitter = 0.35): void {
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      const v = field(x, y) + (rand() - 0.5) * jitter;
      const i = Math.max(0, Math.min(pal.length - 1, Math.floor(v * pal.length)));
      put(img, x, y, pal[i]);
    }
}

// ---------------------------------------------------------------------------------------------

function dirt(seed = 1): Img {
  const r = mulberry32(seed);
  const img = newImg();
  const pal = ["#5b3f2a", "#6c4b31", "#7a563a", "#876143", "#946c4b"].map(hex);
  const n = valueNoise(r, 4);
  paletteNoise(img, r, pal, (x, y) => n(x, y) * 0.6 + 0.2, 0.75);
  // A few pebbles and dark crumbs.
  for (let i = 0; i < 6; i++) put(img, Math.floor(r() * T), Math.floor(r() * T), hex("#4a3322"));
  for (let i = 0; i < 4; i++) {
    const x = Math.floor(r() * T);
    const y = Math.floor(r() * T);
    put(img, x, y, hex("#9d8a74"));
  }
  return img;
}

const GRASS_PAL = ["#4c7f2b", "#578f31", "#619c37", "#6ca93d", "#79b746"].map(hex);

function grassTop(): Img {
  const r = mulberry32(2);
  const img = newImg();
  const n = valueNoise(r, 4);
  paletteNoise(img, r, GRASS_PAL, (x, y) => n(x, y) * 0.5 + 0.25, 0.8);
  return img;
}

function grassSide(): Img {
  const r = mulberry32(3);
  const img = dirt(1);
  const pal = GRASS_PAL.map((c) => scale(c, 0.92));
  for (let x = 0; x < T; x++) {
    const drip = 2 + Math.floor(r() * r() * 4.5);
    for (let y = 0; y < drip; y++) {
      put(img, x, y, pal[Math.floor(r() * pal.length)]);
    }
    // Soft shadow under the turf.
    const c = get(img, x, drip);
    put(img, x, drip, scale(c, 0.85));
  }
  return img;
}

function stone(): Img {
  const r = mulberry32(4);
  const img = newImg();
  const pal = ["#626262", "#6d6d6d", "#777777", "#818181", "#8b8b8b"].map(hex);
  const n = valueNoise(r, 3, 2, 3);
  paletteNoise(img, r, pal, (x, y) => n(x, y), 0.55);
  // Faint darker streaks.
  for (let i = 0; i < 5; i++) {
    const x = Math.floor(r() * T);
    const y = Math.floor(r() * T);
    const len = 2 + Math.floor(r() * 3);
    for (let k = 0; k < len; k++) put(img, x + k, y, scale(get(img, x + k, y), 0.88));
  }
  return img;
}

function cobblestone(): Img {
  const r = mulberry32(5);
  const img = newImg();
  // Jittered Voronoi cells on the torus.
  const pts: [number, number, number][] = [];
  const G = 3;
  for (let gy = 0; gy < G; gy++)
    for (let gx = 0; gx < G; gx++) {
      pts.push([(gx + 0.15 + r() * 0.7) * (T / G), (gy + 0.15 + r() * 0.7) * (T / G), 0.75 + r() * 0.5]);
    }
  const base = ["#5e5e5e", "#6e6e6e", "#7b7b7b", "#8a8a8a", "#969696"].map(hex);
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      let d1 = 1e9;
      let d2 = 1e9;
      let best = 0;
      for (let i = 0; i < pts.length; i++) {
        for (let oy = -1; oy <= 1; oy++)
          for (let ox = -1; ox <= 1; ox++) {
            const dx = x + 0.5 - (pts[i][0] + ox * T);
            const dy = y + 0.5 - (pts[i][1] + oy * T);
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < d1) {
              d2 = d1;
              d1 = d;
              best = i;
            } else if (d < d2) d2 = d;
          }
      }
      const edge = d2 - d1;
      if (edge < 1.1) {
        put(img, x, y, edge < 0.55 ? hex("#3a3a3a") : hex("#4c4c4c"));
      } else {
        const tone = pts[best][2];
        // Light from the top-left: pixels up-left of the cell centre are brighter.
        const dx = x + 0.5 - pts[best][0];
        const dy = y + 0.5 - pts[best][1];
        const lit = -(dx + dy) * 0.06;
        const v = Math.max(0, Math.min(0.999, 0.45 * tone + lit + (r() - 0.5) * 0.3));
        put(img, x, y, base[Math.floor(v * base.length)]);
      }
    }
  return img;
}

function logSide(pal: RGB[], groove: RGB, seed: number): Img {
  const r = mulberry32(seed);
  const img = newImg();
  for (let x = 0; x < T; x++) {
    const colTone = r();
    let run = 0;
    for (let y = 0; y < T; y++) {
      if (run <= 0) run = 2 + Math.floor(r() * 5);
      run--;
      const v = Math.max(0, Math.min(0.999, colTone * 0.6 + r() * 0.4));
      put(img, x, y, pal[Math.floor(v * pal.length)]);
    }
  }
  // Vertical grooves.
  for (let i = 0; i < 4; i++) {
    const x = Math.floor(r() * T);
    const y0 = Math.floor(r() * T);
    const len = 4 + Math.floor(r() * 8);
    for (let k = 0; k < len; k++) put(img, x, y0 + k, groove);
  }
  return img;
}

function logTop(rings: RGB[], bark: RGB[], seed: number): Img {
  const r = mulberry32(seed);
  const img = newImg();
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      const dx = Math.abs(x - 7.5);
      const dy = Math.abs(y - 7.5);
      const d = Math.max(dx, dy) * 0.7 + Math.sqrt(dx * dx + dy * dy) * 0.3;
      if (Math.max(dx, dy) > 6.6) {
        put(img, x, y, bark[Math.floor(r() * bark.length)]);
      } else {
        const ring = Math.floor(d + (r() - 0.5) * 0.5);
        put(img, x, y, rings[ring % 2 === 0 ? 0 : 1]);
        if (r() < 0.12) put(img, x, y, rings[2]);
      }
    }
  return img;
}

function planks(pal: RGB[], seam: RGB, seed: number): Img {
  const r = mulberry32(seed);
  const img = newImg();
  for (let b = 0; b < 4; b++) {
    const tone = 0.3 + r() * 0.4;
    const cut = Math.floor(r() * T);
    for (let y = b * 4; y < b * 4 + 4; y++)
      for (let x = 0; x < T; x++) {
        if (y === b * 4 + 3) {
          put(img, x, y, seam);
          continue;
        }
        let v = tone + (r() - 0.5) * 0.35;
        // Grain: short horizontal streaks.
        if ((x * 7 + y * 13 + b * 5) % 11 === 0) v -= 0.25;
        v = Math.max(0, Math.min(0.999, v));
        put(img, x, y, pal[Math.floor(v * pal.length)]);
      }
    // Vertical seam where two boards meet.
    for (let y = b * 4; y < b * 4 + 3; y++) put(img, cut, y, seam);
  }
  return img;
}

function leaves(pal: RGB[], seed: number): Img {
  const r = mulberry32(seed);
  const img = newImg();
  const n = valueNoise(r, 4);
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      const v = n(x, y);
      const hole = r() < 0.12 + (v < 0.35 ? 0.18 : 0);
      if (hole) {
        put(img, x, y, pal[0], 0);
        continue;
      }
      const t = Math.max(0, Math.min(0.999, v * 0.7 + r() * 0.45 - 0.05));
      put(img, x, y, pal[Math.floor(t * pal.length)]);
    }
  return img;
}

function sand(): Img {
  const r = mulberry32(12);
  const img = newImg();
  const pal = ["#cdc28a", "#d5cb95", "#dcd39f", "#e2daa9", "#e9e2b5"].map(hex);
  const n = valueNoise(r, 4);
  paletteNoise(img, r, pal, (x, y) => n(x, y) * 0.4 + 0.3, 0.7);
  return img;
}

function glass(): Img {
  const img = newImg();
  const frame = hex("#d6eef5");
  const shade = hex("#a7cfdb");
  for (let i = 0; i < T; i++) {
    put(img, i, 0, frame);
    put(img, 0, i, frame);
    put(img, i, T - 1, shade);
    put(img, T - 1, i, shade);
  }
  // Highlight streaks.
  const streak = hex("#ffffff");
  for (let k = 0; k < 4; k++) put(img, 3 + k, 5 - k, streak, 230);
  for (let k = 0; k < 2; k++) put(img, 4 + k, 7 - k, streak, 230);
  put(img, 11, 12, streak, 230);
  put(img, 12, 11, streak, 230);
  return img;
}

function bricks(): Img {
  const r = mulberry32(14);
  const img = newImg();
  const mortar = hex("#b0aa9c");
  const mortarDark = hex("#958f82");
  const pal = ["#83402f", "#8f4a38", "#9b5340", "#a65d48", "#b0664f"].map(hex);
  for (let row = 0; row < 4; row++) {
    const off = row % 2 === 0 ? 0 : 4;
    for (let y = row * 4; y < row * 4 + 4; y++)
      for (let x = 0; x < T; x++) {
        const lx = (x - off + T) % 8;
        if (y === row * 4 + 3) {
          put(img, x, y, r() < 0.3 ? mortarDark : mortar);
        } else if (lx === 0) {
          put(img, x, y, mortar);
        } else {
          const brick = Math.floor(((x - off + T) % T) / 8) + row * 2;
          const tone = ((brick * 37) % 5) / 5;
          let v = tone * 0.5 + r() * 0.5;
          if (y === row * 4) v += 0.2; // top edge catches light
          if (y === row * 4 + 2) v -= 0.15;
          put(img, x, y, pal[Math.max(0, Math.min(4, Math.floor(v * 5)))]);
        }
      }
  }
  return img;
}

function stoneBricks(): Img {
  const r = mulberry32(15);
  const img = newImg();
  const mortar = hex("#4b4b4b");
  const hi = hex("#9c9c9c");
  const lo = hex("#5f5f5f");
  const pal = ["#727272", "#7a7a7a", "#828282", "#898989"].map(hex);
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      const row = y < 8 ? 0 : 1;
      const ly = y % 8;
      const lx = row === 0 ? x : (x + 8) % T;
      if (ly === 7 || lx === 15) {
        put(img, x, y, mortar);
        continue;
      }
      if (ly === 0 || lx === 0) {
        put(img, x, y, hi);
        continue;
      }
      if (ly === 6 || lx === 14) {
        put(img, x, y, lo);
        continue;
      }
      put(img, x, y, pal[Math.floor(r() * pal.length)]);
    }
  // A couple of cracks.
  put(img, 4, 3, lo);
  put(img, 5, 4, lo);
  put(img, 12, 11, lo);
  return img;
}

function wool(base: RGB, seed: number): Img {
  const r = mulberry32(seed);
  const img = newImg();
  const n = valueNoise(r, 8);
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      let k = 1 + (n(x, y) - 0.5) * 0.16 + (r() - 0.5) * 0.06;
      // Knit: little diagonal ridges.
      if ((x + y * 3) % 4 === 0) k -= 0.07;
      if ((x * 3 + y) % 5 === 0) k += 0.04;
      put(img, x, y, scale(base, k));
    }
  return img;
}

function torch(): Img {
  const img = newImg(); // transparent
  const wood = [hex("#7d6040"), hex("#5c4329")];
  for (let y = 8; y < 16; y++) {
    put(img, 7, y, wood[0]);
    put(img, 8, y, wood[1]);
  }
  put(img, 7, 6, hex("#fff6c8"));
  put(img, 8, 6, hex("#ffe27a"));
  put(img, 7, 7, hex("#ffc93c"));
  put(img, 8, 7, hex("#f29c1f"));
  return img;
}

function lamp(): Img {
  const r = mulberry32(25);
  const img = newImg();
  const pal = ["#b9772f", "#d8983e", "#ecba57", "#f7d47c", "#fff0b4"].map(hex);
  const n = valueNoise(r, 4);
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      const v = Math.max(0, Math.min(0.999, n(x, y) * 0.8 + r() * 0.45 - 0.1));
      put(img, x, y, pal[Math.floor(v * pal.length)]);
    }
  // Dark seams between glowing cells.
  for (let i = 0; i < 18; i++) put(img, Math.floor(r() * T), Math.floor(r() * T), hex("#8a5524"));
  return img;
}

function tallGrass(): Img {
  const r = mulberry32(26);
  const img = newImg();
  const pal = ["#467d27", "#559031", "#62a138", "#71b242"].map(hex);
  for (let b = 0; b < 9; b++) {
    let x = 1 + Math.floor(r() * 14);
    const h = 5 + Math.floor(r() * 9);
    const lean = r() < 0.5 ? -1 : 1;
    for (let k = 0; k < h; k++) {
      const y = 15 - k;
      if (k > 2 && r() < 0.25) x += lean;
      if (x < 0 || x > 15) break;
      put(img, x, y, pal[Math.min(3, Math.floor((k / h) * 4 + r() * 0.8))]);
    }
  }
  return img;
}

function flower(petal: RGB, petalLight: RGB, center: RGB, seed: number): Img {
  const r = mulberry32(seed);
  const img = newImg();
  const stem = hex("#4d8a2c");
  const leaf = hex("#5fa236");
  for (let y = 9; y < 16; y++) put(img, 7 + (y > 12 ? 1 : 0) * 0, y, stem);
  put(img, 6, 12, leaf);
  put(img, 5, 11, leaf);
  put(img, 8, 13, leaf);
  put(img, 9, 12, leaf);
  // Head
  const cx = 7;
  const cy = 6;
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) {
      if (Math.abs(dx) === 2 && Math.abs(dy) === 2) continue;
      if (Math.abs(dx) + Math.abs(dy) > 3) continue;
      put(img, cx + dx, cy + dy, r() < 0.35 ? petalLight : petal);
    }
  put(img, cx, cy, center);
  return img;
}

function bedrock(): Img {
  const r = mulberry32(29);
  const img = newImg();
  const pal = ["#141414", "#2c2c2c", "#454545", "#5c5c5c", "#777777"].map(hex);
  const n = valueNoise(r, 5);
  paletteNoise(img, r, pal, (x, y) => n(x, y), 0.9);
  return img;
}

function gravel(): Img {
  const r = mulberry32(30);
  const img = newImg();
  const pal = ["#56504d", "#6b6562", "#7f7976", "#948e8b", "#aaa4a0"].map(hex);
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) put(img, x, y, pal[Math.floor(r() * 2)]);
  for (let i = 0; i < 26; i++) {
    const x = Math.floor(r() * T);
    const y = Math.floor(r() * T);
    const c = 2 + Math.floor(r() * 3);
    put(img, x, y, pal[c]);
    if (r() < 0.7) put(img, x + 1, y, pal[Math.max(1, c - 1)]);
    if (r() < 0.6) put(img, x, y + 1, pal[Math.max(1, c - 1)]);
  }
  return img;
}

function water(frame: number): Img {
  const img = newImg();
  const deep = hex("#2a54c8");
  const light = hex("#4a7ff0");
  const t = (frame / WATER_FRAMES) * Math.PI * 2;
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      const a = Math.sin(((x + y * 0.5) / T) * Math.PI * 2 + t);
      const b = Math.sin(((y - x * 0.3) / T) * Math.PI * 4 - t);
      const v = (a * 0.6 + b * 0.4) * 0.5 + 0.5;
      const c = mix(deep, light, v * v);
      put(img, x, y, c, 175);
    }
  return img;
}

/** Ten crack stages grown from a seed point, so later stages contain the earlier ones. */
function cracks(): Img[] {
  const r = mulberry32(50);
  const order = new Float32Array(T * T).fill(2);
  let time = 0;
  const branches: [number, number, number, number][] = [];
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2 + r() * 0.6;
    branches.push([7.5, 7.5, Math.cos(ang), Math.sin(ang)]);
  }
  const total = 120;
  for (let step = 0; step < total; step++) {
    const bi = step % branches.length;
    const b = branches[bi];
    b[0] += b[2] * 0.9;
    b[1] += b[3] * 0.9;
    const ang = Math.atan2(b[3], b[2]) + (r() - 0.5) * 0.9;
    b[2] = Math.cos(ang);
    b[3] = Math.sin(ang);
    if (b[0] < 0 || b[0] >= T || b[1] < 0 || b[1] >= T) {
      b[0] = 2 + r() * 12;
      b[1] = 2 + r() * 12;
    }
    if (r() < 0.06 && branches.length < 14) branches.push([b[0], b[1], -b[3], b[2]]);
    const px = Math.floor(b[0]);
    const py = Math.floor(b[1]);
    const o = py * T + px;
    time = step / total;
    if (order[o] > time) order[o] = time;
  }
  // Blended as 2 x crack x block: 20 is nearly black, 128 leaves the block unchanged.
  const out: Img[] = [];
  for (let s = 0; s < CRACK_STAGES; s++) {
    const img = newImg();
    const limit = (s + 1) / CRACK_STAGES;
    const set = (i: number, v: number) => {
      if (img[i * 4 + 3] && img[i * 4] <= v) return;
      img[i * 4] = v;
      img[i * 4 + 1] = v;
      img[i * 4 + 2] = v;
      img[i * 4 + 3] = 255;
    };
    for (let i = 0; i < T * T; i++) {
      if (order[i] > limit) continue;
      set(i, order[i] < limit - 0.25 ? 18 : 34);
      // Older cracks widen into a soft dark edge in the later stages.
      if (s >= 4 && order[i] < limit - 0.35) {
        const x = i % T;
        const y = (i / T) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= T || ny >= T) continue;
          const n = ny * T + nx;
          if (order[n] > limit) set(n, 80);
        }
      }
    }
    out.push(img);
  }
  return out;
}


// ---- building blocks (original art) ----

const OAK = ["#7d6136", "#8c6d3e", "#9b7b48", "#a98852"].map(hex);
const OAK_DARK = hex("#5c4527");

function doorHalf(upper: boolean): Img {
  const r = mulberry32(upper ? 61 : 60);
  const img = newImg();
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      const edge = x === 0 || x === T - 1 || (upper ? y === 0 : y === T - 1);
      if (edge) {
        put(img, x, y, OAK_DARK);
        continue;
      }
      // Two tall boards with a groove between them, a little grain.
      const groove = x === 7 || x === 8;
      const v = Math.max(0, Math.min(3, Math.floor(r() * 2.4 + (groove ? 0 : 1))));
      put(img, x, y, groove ? scale(OAK[1], 0.82) : OAK[v]);
    }
  if (upper) {
    // A four-pane window with a cross bar; the glass is see-through.
    for (let y = 3; y <= 10; y++)
      for (let x = 3; x <= 12; x++) {
        const bar = x === 7 || x === 8 || y === 6 || y === 7;
        const frame = x === 3 || x === 12 || y === 3 || y === 10;
        if (frame || bar) put(img, x, y, OAK_DARK);
        else put(img, x, y, hex("#cfe8f0"), 0);
      }
  } else {
    // Cross brace and a handle.
    for (let k = 2; k < 14; k++) put(img, k, 15 - k, scale(OAK[2], 0.9));
    put(img, 12, 2, hex("#2b2b2b"));
    put(img, 12, 3, hex("#4a4a4a"));
  }
  return img;
}

function ladder(): Img {
  const img = newImg();
  const rail = [hex("#6b5232"), hex("#7d6040")];
  for (let y = 0; y < T; y++) {
    put(img, 2, y, rail[1]);
    put(img, 3, y, rail[0]);
    put(img, 12, y, rail[1]);
    put(img, 13, y, rail[0]);
  }
  for (const y of [2, 6, 10, 14]) for (let x = 4; x < 12; x++) put(img, x, y, (x + y) % 3 ? hex("#8a6a42") : hex("#76593a"));
  return img;
}

const BED_RED = ["#9c2722", "#a8302a", "#b53a32"].map(hex);

function bedTop(head: boolean): Img {
  const r = mulberry32(head ? 63 : 64);
  const img = newImg();
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      if (head && y >= 1 && y <= 5 && x >= 2 && x <= 13) {
        const shade = y === 5 || x === 2 || x === 13 ? 0.86 : 1;
        put(img, x, y, scale(hex("#eeeeea"), shade - r() * 0.04));
        continue;
      }
      let c = BED_RED[Math.floor(r() * 3)];
      if (x === 0 || x === T - 1) c = scale(c, 0.8);
      if (!head && y === T - 1) c = scale(c, 0.78);
      if (head && y === 6) c = scale(c, 0.85);
      put(img, x, y, c);
    }
  return img;
}

function bedSide(): Img {
  const r = mulberry32(65);
  const img = newImg();
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      if (y < 7) put(img, x, y, BED_RED[0], 0);
      else if (y < 11) put(img, x, y, BED_RED[Math.floor(r() * 3)]);
      else if (y === 11) put(img, x, y, scale(BED_RED[0], 0.75));
      else if (y === 12) put(img, x, y, hex("#e6e4dc"));
      else put(img, x, y, (x === 0 || x === 1 || x === 14 || x === 15) && y >= 13 ? OAK_DARK : OAK[Math.floor(r() * 3)]);
    }
  return img;
}

/** A smooth block: a tile in one colour with a soft bevel and a faint grain. */
function pixelTile(base: RGB, seed: number): Img {
  const r = mulberry32(seed);
  const img = newImg();
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      let k = 1 + (r() - 0.5) * 0.035;
      if (x === 0 || y === 0) k *= 1.06;
      if (x === T - 1 || y === T - 1) k *= 0.9;
      put(img, x, y, scale(base, k));
    }
  return img;
}

/** Ore: the stone texture with small mineral clusters of our own design (seeded so each ore has its own pattern).
 *  `pal` is [shadow, body, highlight]; `crystal` draws angular facets (diamond, ruby) instead of rounded nuggets. */
function ore(pal: RGB[], seed: number, clusters: number, crystal: boolean): Img {
  const img = stone();
  const r = mulberry32(seed);
  const used = new Set<number>();
  for (let c = 0; c < clusters; c++) {
    let cx = 2 + Math.floor(r() * 12);
    let cy = 2 + Math.floor(r() * 12);
    for (let k = 0; k < 12 && used.has(cy * T + cx); k++) {
      cx = 2 + Math.floor(r() * 12);
      cy = 2 + Math.floor(r() * 12);
    }
    used.add(cy * T + cx);
    const shape = crystal
      ? [[0, 0, 1], [1, 0, 2], [0, 1, 1], [-1, 0, 0], [0, -1, 2], [1, 1, 0]]
      : [[0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 0], [-1, 0, 0], [0, -1, 2]];
    const n = crystal ? 4 + Math.floor(r() * 3) : 3 + Math.floor(r() * 4);
    for (let k = 0; k < n; k++) {
      const [dx, dy, tone] = shape[k];
      put(img, cx + dx, cy + dy, pal[tone]);
    }
    // a dark rim pixel below-right gives the nugget some depth
    put(img, cx + 1, cy + 2, scale(get(img, cx + 1, cy + 2), 0.75));
  }
  return img;
}

export const WOOL_COLORS: Record<string, string> = {
  wool_white: "#e8eaea",
  wool_red: "#a6312b",
  wool_orange: "#ea7a1f",
  wool_yellow: "#f2c42e",
  wool_lime: "#72b725",
  wool_blue: "#3a43a3",
  wool_purple: "#7a33ad",
  wool_black: "#1d1d22",
  wool_cyan: "#178d94",
  wool_pink: "#e991ad",
  // v8
  wool_brown: "#6f4527",
  wool_green: "#4a6a22",
  wool_grey: "#6b6e74",
  wool_light_blue: "#5aaed6",
};

let cache: Img[] | null = null;

/** All texture layers, indexed by TEX. */
export function buildTextureLayers(): Img[] {
  if (cache) return cache;
  const L: Img[] = new Array(TEX_LAYERS);
  L[TEX.grass_top] = grassTop();
  L[TEX.grass_side] = grassSide();
  L[TEX.dirt] = dirt(1);
  L[TEX.stone] = stone();
  L[TEX.cobblestone] = cobblestone();
  L[TEX.oak_log] = logSide(["#4b3720", "#584229", "#664e31", "#735a3b"].map(hex), hex("#3b2b18"), 6);
  L[TEX.oak_log_top] = logTop(["#a98552", "#94733f", "#7a5c33"].map(hex), ["#4b3720", "#584229"].map(hex), 7);
  L[TEX.oak_planks] = planks(["#8a6c3d", "#9b7b48", "#ab8a55", "#b99862", "#c4a46c"].map(hex), hex("#6a5230"), 8);
  L[TEX.oak_leaves] = leaves(["#2a6215", "#34741b", "#3f8722", "#4b992a", "#58aa33"].map(hex), 9);
  L[TEX.birch_log] = birchSide();
  L[TEX.birch_log_top] = logTop(["#cdbd8c", "#bba977", "#a8955f"].map(hex), ["#e4e3dc", "#d3d2ca"].map(hex), 11);
  L[TEX.birch_leaves] = leaves(["#4f7c2c", "#5c8b35", "#6a9b3f", "#78aa49", "#86b853"].map(hex), 12);
  L[TEX.sand] = sand();
  L[TEX.glass] = glass();
  L[TEX.bricks] = bricks();
  L[TEX.stone_bricks] = stoneBricks();
  let s = 16;
  for (const [k, c] of Object.entries(WOOL_COLORS)) L[(TEX as Record<string, number>)[k]] = wool(hex(c), s++);
  L[TEX.torch] = torch();
  L[TEX.lamp] = lamp();
  L[TEX.tall_grass] = tallGrass();
  L[TEX.dandelion] = flower(hex("#f3cf22"), hex("#fde467"), hex("#d99a12"), 27);
  L[TEX.poppy] = flower(hex("#c4231d"), hex("#e2463a"), hex("#2b2a12"), 28);
  L[TEX.bedrock] = bedrock();
  L[TEX.gravel] = gravel();
  L[TEX.birch_planks] = planks(["#b49c62", "#c2aa70", "#cdb67d", "#d8c38b", "#e0cc95"].map(hex), hex("#93804f"), 31);
  for (let f = 0; f < WATER_FRAMES; f++) L[TEX.water0 + f] = water(f);
  L[TEX.door_lower] = doorHalf(false);
  L[TEX.door_upper] = doorHalf(true);
  L[TEX.ladder] = ladder();
  L[TEX.bed_head_top] = bedTop(true);
  L[TEX.bed_foot_top] = bedTop(false);
  L[TEX.bed_side] = bedSide();
  L[TEX.smooth_teal] = pixelTile(hex("#22A3A3"), 66);
  L[TEX.smooth_blue] = pixelTile(hex("#3D4AA6"), 67);
  L[TEX.smooth_tan] = pixelTile(hex("#C9946A"), 68);
  L[TEX.coal_ore] = ore(["#1c1b1d", "#2c2b2e", "#4a484d"].map(hex), 69, 7, false);
  L[TEX.iron_ore] = ore(["#a07c5e", "#c99f7c", "#e6c7a8"].map(hex), 70, 6, false);
  L[TEX.gold_ore] = ore(["#b8860f", "#f0c03a", "#fff0a0"].map(hex), 71, 6, false);
  L[TEX.diamond_ore] = ore(["#2aa8b0", "#62e3e6", "#d8fbff"].map(hex), 72, 5, true);
  L[TEX.ruby_ore] = ore(["#9a1d1d", "#e0362e", "#ff9a8a"].map(hex), 73, 6, true);
  const cr = cracks();
  for (let i = 0; i < CRACK_STAGES; i++) L[TEX.crack0 + i] = cr[i];
  // Survival blocks and item sprites (shared/item-textures.ts).
  L[TEX.crafting_table_top] = IT.craftingTop();
  L[TEX.crafting_table_side] = IT.craftingSide(false);
  L[TEX.crafting_table_front] = IT.craftingSide(true);
  L[TEX.furnace_front] = IT.furnaceFront(false);
  L[TEX.furnace_front_lit] = IT.furnaceFront(true);
  L[TEX.furnace_side] = IT.furnaceSide();
  L[TEX.furnace_top] = IT.furnaceTop();
  L[TEX.chest_top] = IT.chestTop();
  L[TEX.chest_side] = IT.chestSide(false);
  L[TEX.chest_front] = IT.chestSide(true);
  L[TEX.oak_sapling] = IT.sapling(IT.PAL.leaf, IT.PAL.stem);
  L[TEX.birch_sapling] = IT.sapling([hex("#4f7c2c"), hex("#6a9b3f"), hex("#93c25e")], [hex("#9a998f"), hex("#cfcec6"), hex("#ecebe4")]);
  L[TEX.iron_block] = IT.metalBlock(IT.PAL.iron, 801);
  L[TEX.gold_block] = IT.metalBlock(IT.PAL.gold, 802);
  L[TEX.diamond_block] = IT.metalBlock(IT.PAL.diamond, 803, true);
  L[TEX.ruby_block] = IT.metalBlock(IT.PAL.ruby, 804, true);
  L[TEX.coal_block] = IT.coalBlock();
  L[TEX.stick] = IT.stick();
  L[TEX.coal] = IT.lump(IT.PAL.coal, 811);
  L[TEX.charcoal] = IT.lump(IT.PAL.charcoal, 812);
  L[TEX.raw_iron] = IT.lump(IT.PAL.rawIron, 813, IT.PAL.iron);
  L[TEX.raw_gold] = IT.lump(IT.PAL.rawGold, 814, IT.PAL.gold);
  L[TEX.iron_ingot] = IT.ingot(IT.PAL.iron);
  L[TEX.gold_ingot] = IT.ingot(IT.PAL.gold);
  L[TEX.diamond] = IT.gem(IT.PAL.diamond);
  L[TEX.ruby] = IT.gem(IT.PAL.ruby);
  L[TEX.apple] = IT.apple();
  L[TEX.porkchop] = IT.chop(IT.PAL.rawPork, IT.PAL.fat);
  L[TEX.cooked_porkchop] = IT.chop(IT.PAL.cookedLight, IT.PAL.cooked);
  L[TEX.beef] = IT.slab(IT.PAL.raw, IT.PAL.fat);
  L[TEX.steak] = IT.slab(IT.PAL.cooked, IT.PAL.cookedLight);
  L[TEX.mutton] = IT.chop(IT.PAL.raw, IT.PAL.fat);
  L[TEX.cooked_mutton] = IT.chop(IT.PAL.cooked, IT.PAL.cookedLight);
  L[TEX.chicken] = IT.leg(IT.PAL.rawChicken);
  L[TEX.cooked_chicken] = IT.leg(IT.PAL.cookedLight);
  L[TEX.leather] = IT.leather();
  L[TEX.feather] = IT.feather();
  L[TEX.bowl] = IT.bowl();
  for (let m = 0; m < 5; m++) for (let k = 0; k < 4; k++) L[TEX.tool0 + m * 4 + k] = IT.toolSprite(m, k);
  L[TEX.spoiled_flesh] = IT.spoiledFlesh();
  L[TEX.bone] = IT.bone();
  L[TEX.string] = IT.string();
  L[TEX.bone_meal] = IT.boneMeal();
  for (let m = 0; m < 3; m++) for (let k = 0; k < 4; k++) L[TEX.armor0 + m * 4 + k] = IT.armorSprite(m, k);
  L[TEX.fx_flame] = speckle(["#ffe27a", "#ffb02e", "#ff7a1c", "#e8441a"], 9301);
  L[TEX.fx_crit] = speckle(["#fff6c8", "#ffe9a0", "#ffffff", "#f6d27a"], 9302);
  L[TEX.fx_green] = speckle(["#7be36b", "#b6f59a", "#4fbf4a", "#e4ffd6"], 9303);
  L[TEX.fx_smoke] = speckle(["#d8d4cc", "#bdb8af", "#a39e95", "#ece9e3"], 9304);
  // v7 farming and depth
  L[TEX.farmland_dry] = farmland(false);
  L[TEX.farmland_moist] = farmland(true);
  for (let s = 0; s < 8; s++) L[TEX.wheat0 + s] = IT.wheatStage(s);
  L[TEX.sugar_cane] = IT.sugarCane();
  L[TEX.cake_top] = cakeTop();
  L[TEX.cake_side] = cakeSide(false);
  L[TEX.cake_inner] = cakeSide(true);
  L[TEX.cake_bottom] = cakeBottom();
  L[TEX.wheat_seeds] = IT.wheatSeeds();
  L[TEX.wheat] = IT.wheatItem();
  L[TEX.bread] = IT.bread();
  L[TEX.sugar] = IT.sugar();
  L[TEX.paper] = IT.paper();
  L[TEX.egg] = IT.egg();
  L[TEX.flint] = IT.flint();
  for (let k = 0; k < 4; k++) L[TEX.bow + k] = IT.bowSprite(k);
  L[TEX.arrow] = IT.arrowSprite();
  L[TEX.bucket] = IT.bucket("none");
  L[TEX.water_bucket] = IT.bucket("water");
  L[TEX.milk_bucket] = IT.bucket("milk");
  for (let m = 0; m < 5; m++) L[TEX.hoe0 + m] = IT.hoeSprite(m);
  // v8: building blocks, the islands' plants and wood, boats and clay
  L[TEX.mossy_cobblestone] = mossy(cobblestone(), 1601, true);
  L[TEX.mossy_stone_bricks] = mossy(stoneBricks(), 1602, false);
  L[TEX.clay] = clay();
  TERRACOTTA_COLORS.forEach((c, k) => (L[TEX.terracotta0 + k] = terracotta(hex(c), 1610 + k)));
  L[TEX.path_top] = pathTop();
  L[TEX.path_side] = pathSide();
  L[TEX.lantern] = lanternSide();
  L[TEX.lantern_top] = lanternTop();
  L[TEX.barrel_top] = barrelTop();
  L[TEX.barrel_side] = barrelSide();
  L[TEX.bookshelf] = bookshelf();
  L[TEX.hay_side] = haySide();
  L[TEX.hay_top] = hayTop();
  L[TEX.flower_pot] = flowerPot();
  L[TEX.chime] = chimeBrass();
  L[TEX.trapdoor] = trapdoor();
  L[TEX.bluebell] = bluebell();
  L[TEX.palm_log] = palmSide();
  L[TEX.palm_log_top] = logTop(["#c9b38a", "#b59d72", "#9d855c"].map(hex), ["#7a6448", "#8c7656"].map(hex), 1651);
  L[TEX.palm_leaves] = palmFronds();
  L[TEX.boat] = IT.boatItem();
  L[TEX.clay_ball] = IT.clayBall();
  L[TEX.brick] = IT.brickItem();
  L[TEX.coconut] = IT.coconut();
  L[TEX.smoked_fish] = IT.smokedFish();
  for (let i = 0; i < TEX_LAYERS; i++) if (!L[i]) L[i] = newImg();
  cache = L;
  return L;
}

// ---------------------------------------------------------------- v7: farmland and cake

/** Tilled dirt seen from above: furrows across it, a ridge of loose earth above each one. Watered: darker, richer. */
function farmland(moist: boolean): Img {
  const r = mulberry32(moist ? 1402 : 1401);
  const img = newImg();
  const pal = (moist ? ["#3b2516", "#462c1a", "#52341f", "#5d3b24", "#69442a"] : ["#6b4a2f", "#785437", "#845e3f", "#906848", "#9c7350"]).map(hex);
  const n = valueNoise(r, 4);
  paletteNoise(img, r, pal, (x, y) => n(x, y) * 0.5 + 0.25, 0.7);
  for (let y = 0; y < T; y++) {
    const row = y % 4;
    for (let x = 0; x < T; x++) {
      if (row === 3) put(img, x, y, scale(pal[0], r() < 0.2 ? 0.9 : 0.78)); // the furrow
      else if (row === 2) put(img, x, y, scale(get(img, x, y), 0.9));
      else if (row === 0 && r() < 0.55) put(img, x, y, pal[4]); // the ridge catches the light
    }
  }
  if (moist) for (let k = 0; k < 5; k++) put(img, Math.floor(r() * T), 3 + 4 * Math.floor(r() * 4), hex("#2a1a10"));
  return img;
}

const CREAM = ["#e9e1d4", "#f1ebe1", "#f8f4ed", "#ffffff"].map(hex);
const SPONGE = ["#c89a5c", "#d6a86a", "#e0b679", "#e9c48a"].map(hex);
const CRUST = ["#a8703c", "#b57d45", "#c08a50", "#b07842"].map(hex); // the baked outside
const CRUMB = ["#ecd396", "#f2dca6", "#e6c987", "#f5e3b4"].map(hex); // the open inside, paler
const JAM = hex("#c8302a");

/** Cake top: cream icing with a few red berries. */
function cakeTop(): Img {
  const r = mulberry32(1501);
  const img = newImg();
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) put(img, x, y, CREAM[Math.floor(r() * 3)]);
  for (const [x, y] of [[4, 4], [11, 3], [7, 8], [3, 11], [12, 10], [8, 13]]) {
    put(img, x, y, JAM);
    put(img, x + 1, y, scale(JAM, 0.8));
    put(img, x, y - 1, hex("#e86a5e"));
  }
  return img;
}

/** Cake side (the box is half a block tall, so the art is in the bottom half): icing dripping over golden sponge
 *  with a line of jam; the inside (once a slice is gone) is the open crumb. */
function cakeSide(inner: boolean): Img {
  const r = mulberry32(inner ? 1503 : 1502);
  const img = newImg();
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      let c = (inner ? CRUMB : CRUST)[Math.floor(r() * 4)];
      if (inner && r() < 0.2) c = scale(c, 0.84); // crumb holes
      put(img, x, y, c);
    }
  // icing on top (rows 8-9), dripping down here and there
  for (let x = 0; x < T; x++) {
    put(img, x, 8, CREAM[3]);
    put(img, x, 9, CREAM[1 + (x % 2)]);
    if (!inner && (x * 7 + 3) % 5 === 0) put(img, x, 10, CREAM[0]);
  }
  // a layer of jam in the middle (row 12)
  for (let x = 0; x < T; x++) put(img, x, 12, inner ? (x % 3 === 0 ? scale(JAM, 0.85) : JAM) : scale(JAM, 0.9));
  // the base
  for (let x = 0; x < T; x++) put(img, x, 15, scale(SPONGE[0], 0.85));
  return img;
}

function cakeBottom(): Img {
  const r = mulberry32(1504);
  const img = newImg();
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) put(img, x, y, scale(SPONGE[Math.floor(r() * 3)], 0.9));
  return img;
}

function birchSide(): Img {
  const r = mulberry32(10);
  const img = newImg();
  const pal = ["#d2d1c9", "#dddcd5", "#e8e7e1", "#c6c5bc"].map(hex);
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) put(img, x, y, pal[Math.floor(r() * 3)]);
  const dark = hex("#2e2d2a");
  const mid = hex("#5d5c56");
  for (let i = 0; i < 7; i++) {
    const y = Math.floor(r() * T);
    const x = Math.floor(r() * T);
    const len = 2 + Math.floor(r() * 4);
    for (let k = 0; k < len; k++) put(img, x + k, y, k === 0 || k === len - 1 ? mid : dark);
  }
  return img;
}

/** A particle layer: small clusters of a few colours (any 3x3 chip of it reads as a spark of that colour). */
function speckle(cols: string[], seed: number): Img {
  const r = mulberry32(seed);
  const img = newImg();
  const pal = cols.map(hex);
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) put(img, x, y, pal[Math.floor(r() * pal.length)]);
  return img;
}

/** Average colour of a layer (opaque pixels only), for particles and the map. */
export function averageColor(img: Img): RGB {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < img.length; i += 4) {
    if (img[i + 3] < 128) continue;
    r += img[i];
    g += img[i + 1];
    b += img[i + 2];
    n++;
  }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}

// ---------------------------------------------------------------- v8: building blocks, island plants and wood

/** Moss creeping over a stone texture: in the cracks and mortar first, then in soft patches. */
function mossy(base: Img, seed: number, cracks: boolean): Img {
  const r = mulberry32(seed);
  const n = valueNoise(r, 4);
  const moss = ["#3f5a26", "#4d6b2c", "#5b7d33", "#6c8f3c"].map(hex);
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      const c = get(base, x, y);
      const lum = (c[0] + c[1] + c[2]) / 3;
      const dark = lum < 80; // mortar and the gaps between stones
      const v = n(x, y) + (y < 6 ? 0.12 : 0) + (r() - 0.5) * 0.25;
      if ((dark && (cracks ? v > 0.35 : v > 0.3)) || v > 0.72) {
        const t = Math.max(0, Math.min(3, Math.floor((v - 0.3) * 6 + r() * 1.5)));
        put(base, x, y, scale(moss[t], dark ? 0.8 : 1));
      }
    }
  return base;
}

function clay(): Img {
  const r = mulberry32(1603);
  const img = newImg();
  const pal = ["#8b93a1", "#959daa", "#9fa7b4", "#a9b1bd", "#b4bbc6"].map(hex);
  const n = valueNoise(r, 3);
  paletteNoise(img, r, pal, (x, y) => n(x, y) * 0.5 + 0.25, 0.45);
  // a few smooth pebbles and wet streaks
  for (let k = 0; k < 5; k++) put(img, Math.floor(r() * T), Math.floor(r() * T), hex("#c5cbd4"));
  for (let k = 0; k < 4; k++) {
    const x = Math.floor(r() * T);
    const y = Math.floor(r() * T);
    put(img, x, y, hex("#7e8694"));
    put(img, x + 1, y, hex("#858d9b"));
  }
  return img;
}

/** Fired clay: matte, with faint layers from the kiln and a few speckles. Our own palette of six. */
export const TERRACOTTA_COLORS = ["#a35e3e", "#d5c09b", "#8d3a2a", "#b5832c", "#4f6070", "#3c302d"];
function terracotta(base: RGB, seed: number): Img {
  const r = mulberry32(seed);
  const img = newImg();
  const n = valueNoise(r, 5);
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      let k = 1 + (n(x, y) - 0.5) * 0.08 + (r() - 0.5) * 0.04;
      if (y % 5 === 2) k -= 0.035; // the strata
      put(img, x, y, scale(base, k));
    }
  for (let k = 0; k < 9; k++) put(img, Math.floor(r() * T), Math.floor(r() * T), scale(base, r() < 0.5 ? 0.86 : 1.1));
  return img;
}

const PATH_PAL = ["#7f633d", "#8c6e45", "#98794d", "#a38455", "#ae8f5f"].map(hex);
/** A trodden dirt path from above: packed earth with fine grit. */
function pathTop(): Img {
  const r = mulberry32(1620);
  const img = newImg();
  const n = valueNoise(r, 4);
  paletteNoise(img, r, PATH_PAL, (x, y) => n(x, y) * 0.5 + 0.25, 0.6);
  for (let k = 0; k < 10; k++) put(img, Math.floor(r() * T), Math.floor(r() * T), hex("#c2ab84"));
  for (let k = 0; k < 6; k++) put(img, Math.floor(r() * T), Math.floor(r() * T), hex("#6a5232"));
  return img;
}

/** Path side: dirt, with the packed top showing as a strip (the block is 15/16 tall, so row 0 is never seen). */
function pathSide(): Img {
  const r = mulberry32(1621);
  const img = dirt(1);
  for (let x = 0; x < T; x++) {
    put(img, x, 1, PATH_PAL[3 + (r() < 0.5 ? 1 : 0)]);
    put(img, x, 2, PATH_PAL[1 + Math.floor(r() * 2)]);
    if (r() < 0.5) put(img, x, 3, scale(get(img, x, 3), 0.85));
  }
  return img;
}

const IRON_D = hex("#2a2827");
const IRON_M = hex("#3d3a38");
const IRON_L = hex("#5e5955");
/** The lantern's sides. Laid out for its boxes (shapes.ts): the chain in u 7-8 rows 0-5, the cap in u 6-9 rows 6-7,
 *  the glass body in u 5-10 rows 8-15 (a warm flame behind four panes in an iron frame). */
function lanternSide(): Img {
  const img = newImg();
  for (let y = 0; y < 6; y++) {
    put(img, 7, y, y % 2 ? IRON_L : IRON_M);
    put(img, 8, y, y % 2 ? IRON_M : IRON_D);
  }
  for (let x = 6; x <= 9; x++) {
    put(img, x, 6, x === 6 ? IRON_L : IRON_M);
    put(img, x, 7, IRON_D);
  }
  const glow = ["#ffdf8a", "#ffc65a", "#f7a13a"].map(hex);
  for (let y = 8; y < 16; y++)
    for (let x = 5; x <= 10; x++) {
      const frame = x === 5 || x === 10 || y === 8 || y === 15;
      if (frame) {
        put(img, x, y, y === 8 || x === 5 ? IRON_L : IRON_D);
        continue;
      }
      // the flame: bright in the middle, a little lower than centre
      const d = Math.abs(x - 7.5) + Math.abs(y - 12) * 0.7;
      const c = d < 1.2 ? hex("#fff5d0") : glow[Math.min(2, Math.floor(d / 1.1))];
      put(img, x, y, c);
    }
  // a cross bar in the frame
  for (let x = 6; x <= 9; x++) put(img, x, 11, scale(IRON_M, 1.1));
  put(img, 7, 12, hex("#fffbe8"));
  put(img, 8, 12, hex("#fff1b8"));
  return img;
}

function lanternTop(): Img {
  const img = newImg();
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      const edge = x === 5 || x === 10 || y === 5 || y === 10 || x === 6 || x === 9 || y === 6 || y === 9;
      put(img, x, y, edge ? IRON_M : IRON_D);
    }
  for (let k = 6; k <= 9; k++) {
    put(img, k, 6, IRON_L);
    put(img, 6, k, IRON_L);
  }
  put(img, 7, 7, hex("#7a7470"));
  return img;
}

const STAVE = ["#6e4c28", "#7b5630", "#875f36", "#93693c"].map(hex);
const HOOP = [hex("#3a3634"), hex("#55504c"), hex("#6f6964")];
/** Barrel lid: boards inside an iron hoop, with a bung. */
function barrelTop(): Img {
  const r = mulberry32(1630);
  const img = newImg();
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      const board = Math.floor(x / 4);
      let c = STAVE[(board * 3 + Math.floor(r() * 2)) % 4];
      if (x % 4 === 3) c = scale(c, 0.8);
      put(img, x, y, c);
    }
  for (let k = 0; k < T; k++) {
    for (const [x, y] of [[k, 0], [k, T - 1], [0, k], [T - 1, k]]) put(img, x, y, HOOP[1]);
    for (const [x, y] of [[k, 1], [1, k]]) if (k > 0 && k < T - 1) put(img, x, y, HOOP[2]);
    for (const [x, y] of [[k, T - 2], [T - 2, k]]) if (k > 0 && k < T - 1) put(img, x, y, HOOP[0]);
  }
  for (const [x, y] of [[10, 5], [11, 5], [10, 6], [11, 6]]) put(img, x, y, hex("#4a3218"));
  return img;
}

/** Barrel side: upright staves bound by two iron hoops. */
function barrelSide(): Img {
  const r = mulberry32(1631);
  const img = newImg();
  for (let x = 0; x < T; x++) {
    const tone = Math.floor(r() * 4);
    for (let y = 0; y < T; y++) {
      let c = STAVE[(tone + (r() < 0.25 ? 1 : 0)) % 4];
      if (x % 4 === 0) c = scale(STAVE[0], 0.78); // the joins between staves
      put(img, x, y, c);
    }
  }
  for (const y0 of [2, 12]) {
    for (let x = 0; x < T; x++) {
      put(img, x, y0, HOOP[2]);
      put(img, x, y0 + 1, HOOP[0]);
    }
    for (let x = 1; x < T; x += 5) put(img, x, y0, hex("#8a847e")); // rivets
  }
  return img;
}

/** A bookshelf: two oak shelves of books in our own colours, some leaning, one gap. */
function bookshelf(): Img {
  const r = mulberry32(1640);
  const img = newImg();
  const shelf = (y: number) => {
    for (let x = 0; x < T; x++) put(img, x, y, OAK[1 + (x % 3 === 0 ? 1 : 0)]);
  };
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) put(img, x, y, hex("#3a2a18")); // the back of the case
  shelf(0);
  shelf(7);
  shelf(8);
  shelf(15);
  for (let y = 0; y < T; y++) {
    put(img, 0, y, OAK_DARK);
    put(img, T - 1, y, OAK_DARK);
  }
  const covers = ["#8e2f2a", "#2f4f7a", "#3f6b35", "#b0892e", "#6a3d72", "#2a6f6a", "#c9c2b0", "#7a4a26"].map(hex);
  for (const [top, bottom] of [[1, 6], [9, 14]]) {
    let x = 1;
    while (x < T - 1) {
      const w = r() < 0.7 ? 1 : 2;
      if (r() < 0.08) {
        x += 1; // a gap
        continue;
      }
      const h = bottom - top + 1 - (r() < 0.45 ? 1 : 0) - (r() < 0.2 ? 1 : 0);
      const c = covers[Math.floor(r() * covers.length)];
      for (let k = 0; k < w && x + k < T - 1; k++)
        for (let y = bottom; y > bottom - h; y--) {
          let cc = c;
          if (y === bottom - h + 1) cc = scale(c, 1.2); // the top of the spine catches light
          if (y === bottom - 2 && h > 3) cc = hex("#e2d6a8"); // a label band
          put(img, x + k, y, k === w - 1 && w > 1 ? scale(cc, 0.8) : cc);
        }
      x += w;
    }
  }
  return img;
}

const STRAW = ["#a8862e", "#bb9733", "#cca83d", "#dbb94b", "#e8c95e"].map(hex);
const TWINE = [hex("#6e4a22"), hex("#86602e")];
/** Hay bale side: straw lying across, held by two upright bands of twine (our own look). */
function haySide(): Img {
  const r = mulberry32(1641);
  const img = newImg();
  for (let y = 0; y < T; y++) {
    let x = 0;
    while (x < T) {
      const len = 2 + Math.floor(r() * 5);
      const c = STRAW[Math.floor(r() * 5)];
      for (let k = 0; k < len && x + k < T; k++) put(img, x + k, y, c);
      x += len;
    }
  }
  for (const x0 of [3, 12])
    for (let y = 0; y < T; y++) {
      put(img, x0, y, TWINE[1]);
      put(img, x0 + 1, y, TWINE[0]);
    }
  return img;
}

/** Hay bale top: the cut straw ends, and the twine crossing it. */
function hayTop(): Img {
  const r = mulberry32(1642);
  const img = newImg();
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) put(img, x, y, STRAW[1 + Math.floor(r() * 3)]);
  for (let k = 0; k < 40; k++) {
    const x = Math.floor(r() * T);
    const y = Math.floor(r() * T);
    put(img, x, y, STRAW[0]);
    put(img, x + 1, y, STRAW[4]);
  }
  for (const x0 of [3, 12])
    for (let y = 0; y < T; y++) {
      put(img, x0, y, TWINE[1]);
      put(img, x0 + 1, y, TWINE[0]);
    }
  return img;
}

/** Flower pot, laid out for its box (5..11 across, 6 tall): the sides in rows 10-15, the soil and rim on top in
 *  u/v 5..10. */
function flowerPot(): Img {
  const img = newImg();
  const pot = ["#7e4128", "#9a5233", "#b2643e", "#c7774c"].map(hex);
  for (let y = 10; y < 16; y++)
    for (let x = 5; x <= 10; x++) {
      let c = pot[1 + ((x + y) % 2)];
      if (y === 10) c = pot[3]; // the rim
      if (y === 11) c = pot[0];
      if (y === 15) c = scale(pot[0], 0.9);
      if (x === 5) c = scale(c, 1.08);
      put(img, x, y, c);
    }
  for (let y = 5; y <= 10; y++)
    for (let x = 5; x <= 10; x++) {
      const rim = x === 5 || x === 10 || y === 5 || y === 10;
      put(img, x, y, rim ? pot[3] : (x + y) % 3 === 0 ? hex("#3a2616") : hex("#4a3220"));
    }
  return img;
}

/** Brass for the village chime's tubes: bright with a rounded shine. */
function chimeBrass(): Img {
  const img = newImg();
  const cols = ["#7a5a1c", "#a87c26", "#d2a63a", "#f0d270", "#c8982e", "#8e6a20"].map(hex);
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      let c = cols[x % 6];
      if (y % 8 === 0) c = scale(c, 0.8);
      put(img, x, y, c);
    }
  return img;
}

/** Trapdoor: oak boards in a frame with a cross brace and two iron hinge straps (no holes; our own look). */
function trapdoor(): Img {
  const r = mulberry32(1660);
  const img = newImg();
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      const board = Math.floor(x / 4);
      let c = OAK[(board + Math.floor(r() * 2)) % 4];
      if (x % 4 === 3) c = scale(c, 0.82);
      if (x === 0 || y === 0 || x === T - 1 || y === T - 1) c = OAK_DARK;
      put(img, x, y, c);
    }
  for (let k = 2; k < 14; k++) put(img, k, k, scale(OAK[3], 0.92));
  for (const y0 of [3, 11]) {
    for (let x = 1; x < 7; x++) {
      put(img, x, y0, hex("#4c4844"));
      put(img, x, y0 + 1, hex("#2e2b29"));
    }
    put(img, 2, y0, hex("#8a847e"));
    put(img, 5, y0, hex("#8a847e"));
  }
  return img;
}

/** Bluebell: a curved stem with little bells nodding down one side, leaves at the foot. */
function bluebell(): Img {
  const img = newImg();
  const stem = hex("#4d8a2c");
  const leaf = [hex("#3f7a24"), hex("#5fa236")];
  const bell = [hex("#3a4fb8"), hex("#5470dc"), hex("#8aa2f2")];
  for (let y = 4; y < 16; y++) put(img, y < 6 ? 8 : 7, y, stem);
  put(img, 8, 3, stem);
  for (const [x, y] of [[5, 14], [6, 13], [6, 15], [9, 14], [10, 13], [10, 15], [4, 15], [11, 15]]) put(img, x, y, leaf[(x + y) % 2]);
  // bells hang off the right of the arching top
  for (const [x, y] of [[9, 3], [10, 5], [10, 8], [9, 10]]) {
    put(img, x, y, bell[1]);
    put(img, x + 1, y, bell[0]);
    put(img, x, y + 1, bell[2]);
    put(img, x + 1, y + 1, bell[1]);
    put(img, x + 2, y + 1, bell[0]);
  }
  put(img, 6, 6, bell[1]);
  put(img, 5, 7, bell[0]);
  put(img, 6, 7, bell[2]);
  return img;
}

/** Palm trunk: grey-tan bark in rings, each ring scaled with the scars of old fronds (a woven look). */
function palmSide(): Img {
  const r = mulberry32(1650);
  const img = newImg();
  const pal = ["#6e5a40", "#83704f", "#96825e", "#aa966f", "#bba882"].map(hex);
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      const band = Math.floor(y / 4);
      const ly = y % 4;
      // each ring: a lit upper edge, a body, a dark seam; the scars lean left and right on alternate rings
      const off = band % 2 ? 2 : 0;
      const scar = (x + off + (band % 2 ? ly : 3 - ly)) % 4 === 0;
      let c = ly === 0 ? pal[3] : ly === 3 ? pal[0] : pal[2 + (r() < 0.3 ? 1 : 0)];
      if (scar && ly > 0) c = ly === 3 ? scale(pal[0], 0.8) : pal[0];
      put(img, x, y, c);
    }
  return img;
}

/** Palm fronds: long leaflets in a herringbone, light at the tips, on see-through ground. */
function palmFronds(): Img {
  const r = mulberry32(1652);
  const img = newImg();
  const pal = ["#3a7424", "#4a8a2c", "#5ca036", "#73b742", "#94cc56"].map(hex);
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) put(img, x, y, pal[0], 0);
  for (const [rib, dir] of [[4, 1], [12, -1]]) {
    for (let x0 = -2; x0 < T; x0 += 3) {
      for (let k = 0; k < 6; k++) {
        const x = x0 + k;
        const up = rib - Math.floor(k * 0.7) - 1;
        const dn = rib + Math.floor(k * 0.7) + 1;
        const tone = pal[Math.min(4, 1 + Math.floor(k / 2) + (r() < 0.3 ? 1 : 0))];
        if (x >= 0 && x < T) {
          put(img, dir > 0 ? x : T - 1 - x, up, tone);
          put(img, dir > 0 ? x : T - 1 - x, dn, scale(tone, 0.9));
        }
      }
    }
    for (let x = 0; x < T; x++) put(img, x, rib, pal[1]);
  }
  return img;
}
