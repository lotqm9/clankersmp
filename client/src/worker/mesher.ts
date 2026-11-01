// Section mesher: 16x16x16 blocks -> vertex buffers with Java-style smooth lighting.
//
// Per vertex: position (f32 x3, world space), uv (u8 x4: u*16, v*16, 0, 0) and data
// (u8 x4: texture layer, sky light * 16, block light * 16, shade * 255). Shade combines the
// fixed face shading (top 1.0, bottom 0.5, N/S 0.8, E/W 0.6) with ambient occlusion.

import { AO_OCC, B, BLOCKS, IS_WATER, OPAQUE, RENDER, SOLID, TEX, isFarmland, isPot, pottedFlower } from "../../../shared/blocks.ts";
import { surfaceHeight } from "../../../shared/water.ts";
import { CHUNK, WORLD_BITS, WORLD_HEIGHT, WORLD_SIZE, Y_SHIFT } from "../../../shared/constants.ts";
import { faceUV, renderBoxes, rotateTop, type Nb } from "../../../shared/shapes.ts";

const R_CUBE = 1;
const R_CUTOUT = 2;
const R_WATER = 3;
const R_CROSS = 4;
const R_TORCH = 5;
const R_MODEL = 6;
const R_CROP = 7; // v7: wheat

const P = CHUNK + 2; // padded edge
const OUT = 255; // id used for cells outside the world (behaves as opaque)

const pBlocks = new Uint8Array(P * P * P);
const pLight = new Uint8Array(P * P * P);
const pidx = (x: number, y: number, z: number) => (y * P + z) * P + x;
const delta = (dx: number, dy: number, dz: number) => (dy * P + dz) * P + dx;

const NORMALS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
// Corners counter-clockwise seen from outside: bottom-left, bottom-right, top-right, top-left.
const CORNERS = [
  [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]],
  [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
  [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]],
  [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
  [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],
];
const UVS = [
  [0, 16],
  [16, 16],
  [16, 0],
  [0, 0],
];
const FACE_SHADE = [0.6, 0.6, 1.0, 0.5, 0.8, 0.8];

// Neighbour offsets (padded index) for every face and corner: F (face), A, B (edges), C (corner).
const OFF_N = new Int32Array(6);
const OFF = new Int32Array(6 * 4 * 3);
for (let f = 0; f < 6; f++) {
  const n = NORMALS[f];
  OFF_N[f] = delta(n[0], n[1], n[2]);
  const axis = n[0] !== 0 ? 0 : n[1] !== 0 ? 1 : 2;
  const t1 = axis === 0 ? 1 : 0;
  const t2 = axis === 2 ? 1 : 2;
  for (let c = 0; c < 4; c++) {
    const corner = CORNERS[f][c];
    const s1 = corner[t1] === 0 ? -1 : 1;
    const s2 = corner[t2] === 0 ? -1 : 1;
    const a = [n[0], n[1], n[2]];
    const b = [n[0], n[1], n[2]];
    a[t1] += s1;
    b[t2] += s2;
    const cc = [n[0], n[1], n[2]];
    cc[t1] += s1;
    cc[t2] += s2;
    OFF[(f * 4 + c) * 3] = delta(a[0], a[1], a[2]);
    OFF[(f * 4 + c) * 3 + 1] = delta(b[0], b[1], b[2]);
    OFF[(f * 4 + c) * 3 + 2] = delta(cc[0], cc[1], cc[2]);
  }
}

const TEXF = BLOCKS.map((b) => b.tex);

class Buf {
  pos: Float32Array;
  uv: Uint8Array;
  data: Uint8Array;
  index: Uint32Array;
  nv = 0;
  ni = 0;
  constructor(maxQuads: number) {
    this.pos = new Float32Array(maxQuads * 4 * 3);
    this.uv = new Uint8Array(maxQuads * 4 * 4);
    this.data = new Uint8Array(maxQuads * 4 * 4);
    this.index = new Uint32Array(maxQuads * 6);
  }
  reset(): void {
    this.nv = 0;
    this.ni = 0;
  }
  ensure(quads: number): void {
    if ((this.nv + quads * 4) * 3 <= this.pos.length) return;
    const cap = Math.max(this.pos.length / 12, this.nv / 4 + quads) * 2;
    const pos = new Float32Array(cap * 12);
    pos.set(this.pos);
    const uv = new Uint8Array(cap * 16);
    uv.set(this.uv);
    const data = new Uint8Array(cap * 16);
    data.set(this.data);
    const index = new Uint32Array(cap * 6);
    index.set(this.index);
    this.pos = pos;
    this.uv = uv;
    this.data = data;
    this.index = index;
  }
  vert(x: number, y: number, z: number, u: number, v: number, layer: number, sky: number, blk: number, shade: number): void {
    const n = this.nv++;
    this.pos[n * 3] = x;
    this.pos[n * 3 + 1] = y;
    this.pos[n * 3 + 2] = z;
    this.uv[n * 4] = u;
    this.uv[n * 4 + 1] = v;
    this.data[n * 4] = layer;
    this.data[n * 4 + 1] = sky;
    this.data[n * 4 + 2] = blk;
    this.data[n * 4 + 3] = shade;
  }
  quad(flip: boolean): void {
    const b = this.nv - 4;
    const i = this.ni;
    if (flip) {
      this.index[i] = b + 1;
      this.index[i + 1] = b + 2;
      this.index[i + 2] = b + 3;
      this.index[i + 3] = b + 1;
      this.index[i + 4] = b + 3;
      this.index[i + 5] = b;
    } else {
      this.index[i] = b;
      this.index[i + 1] = b + 1;
      this.index[i + 2] = b + 2;
      this.index[i + 3] = b;
      this.index[i + 4] = b + 2;
      this.index[i + 5] = b + 3;
    }
    this.ni += 6;
  }
  export(): MeshArrays | null {
    if (this.nv === 0) return null;
    const index = this.nv <= 65535 ? Uint16Array.from(this.index.subarray(0, this.ni)) : this.index.slice(0, this.ni);
    return {
      pos: this.pos.slice(0, this.nv * 3),
      uv: this.uv.slice(0, this.nv * 4),
      data: this.data.slice(0, this.nv * 4),
      index,
    };
  }
}

export interface MeshArrays {
  pos: Float32Array;
  uv: Uint8Array;
  data: Uint8Array;
  index: Uint16Array | Uint32Array;
}

const solid = new Buf(4096);
const water = new Buf(1024);

/** Copy the section plus a one-block border into the padded scratch arrays. Returns false if all air. */
function gather(blocks: Uint8Array, light: Uint8Array, cx: number, cy: number, cz: number): boolean {
  const x0 = cx * CHUNK - 1;
  const y0 = cy * CHUNK - 1;
  const z0 = cz * CHUNK - 1;
  let any = false;
  for (let ly = 0; ly < P; ly++) {
    const wy = y0 + ly;
    for (let lz = 0; lz < P; lz++) {
      const wz = z0 + lz;
      let o = pidx(0, ly, lz);
      for (let lx = 0; lx < P; lx++, o++) {
        const wx = x0 + lx;
        if (wx < 0 || wz < 0 || wx >= WORLD_SIZE || wz >= WORLD_SIZE || wy < 0) {
          pBlocks[o] = OUT;
          pLight[o] = wy < 0 ? 0 : 0xf0;
        } else if (wy >= WORLD_HEIGHT) {
          pBlocks[o] = 0;
          pLight[o] = 0xf0;
        } else {
          const i = (wy << Y_SHIFT) | (wz << WORLD_BITS) | wx;
          const id = blocks[i];
          pBlocks[o] = id;
          pLight[o] = light[i];
          if (id !== 0 && lx > 0 && lx < P - 1 && ly > 0 && ly < P - 1 && lz > 0 && lz < P - 1) any = true;
        }
      }
    }
  }
  return any;
}

export function meshSection(
  blocks: Uint8Array,
  light: Uint8Array,
  cx: number,
  cy: number,
  cz: number,
): { solid: MeshArrays | null; water: MeshArrays | null } {
  solid.reset();
  water.reset();
  if (!gather(blocks, light, cx, cy, cz)) return { solid: null, water: null };
  const bx = cx * CHUNK;
  const by = cy * CHUNK;
  const bz = cz * CHUNK;

  for (let ly = 1; ly <= CHUNK; ly++) {
    for (let lz = 1; lz <= CHUNK; lz++) {
      let p = pidx(1, ly, lz);
      for (let lx = 1; lx <= CHUNK; lx++, p++) {
        const id = pBlocks[p];
        if (id === 0) continue;
        const kind = RENDER[id];
        const wx = bx + lx - 1;
        const wy = by + ly - 1;
        const wz = bz + lz - 1;
        if (kind === R_CUBE || kind === R_CUTOUT) {
          const cullSame = id === B.GLASS;
          for (let f = 0; f < 6; f++) {
            const np = p + OFF_N[f];
            const nid = pBlocks[np];
            if (OPAQUE[nid]) continue;
            if (cullSame && nid === id) continue;
            cubeFace(p, f, wx, wy, wz, TEXF[id][f]);
          }
        } else if (kind === R_WATER) {
          waterBlock(p, wx, wy, wz);
        } else if (kind === R_CROSS) {
          crossBlock(p, wx, wy, wz, TEXF[id][0]);
        } else if (kind === R_TORCH) {
          torchBlock(p, wx, wy, wz, TEXF[id][0]);
        } else if (kind === R_MODEL) {
          modelBlock(p, id, wx, wy, wz);
          // v8: a potted flower: the pot (its model) and a small crossed flower standing in the soil
          if (isPot(id) && pottedFlower(id)) potPlant(p, wx, wy, wz, TEXF[pottedFlower(id)][0]);
        } else if (kind === R_CROP) {
          cropBlock(p, wx, wy, wz, TEXF[id][0]);
        }
      }
    }
  }
  return { solid: solid.export(), water: water.export() };
}

const sk = [0, 0, 0, 0];
const bl = [0, 0, 0, 0];
const sh = [0, 0, 0, 0];

function cubeFace(p: number, f: number, wx: number, wy: number, wz: number, layer: number): void {
  solid.ensure(1);
  const pF = p + OFF_N[f];
  const lF = pLight[pF];
  const sF = lF >> 4;
  const bF = lF & 15;
  const faceShade = FACE_SHADE[f];
  for (let c = 0; c < 4; c++) {
    const o = (f * 4 + c) * 3;
    const pA = p + OFF[o];
    const pB = p + OFF[o + 1];
    const pC = p + OFF[o + 2];
    const occA = AO_OCC[pBlocks[pA]];
    const occB = AO_OCC[pBlocks[pB]];
    const occC = occA && occB ? 1 : AO_OCC[pBlocks[pC]];
    const lA = pLight[pA];
    const lB = pLight[pB];
    const lC = occA && occB ? 0 : pLight[pC];
    // Java's blend: zero-light neighbours borrow the face's light so walls do not double-darken.
    const sA = lA >> 4 || sF;
    const sB = lB >> 4 || sF;
    const sC = lC >> 4 || sF;
    const bA = lA & 15 || bF;
    const bB = lB & 15 || bF;
    const bC = lC & 15 || bF;
    sk[c] = (sF + sA + sB + sC) * 4; // average * 16
    bl[c] = (bF + bA + bB + bC) * 4;
    const ao = (1 + (occA ? 0.2 : 1) + (occB ? 0.2 : 1) + (occC ? 0.2 : 1)) * 0.25;
    sh[c] = ao * faceShade * 255;
  }
  for (let c = 0; c < 4; c++) {
    const corner = CORNERS[f][c];
    solid.vert(wx + corner[0], wy + corner[1], wz + corner[2], UVS[c][0], UVS[c][1], layer, sk[c], bl[c], sh[c]);
  }
  // Split the quad along the diagonal that keeps a dark corner from bleeding across the face.
  const b0 = sh[0] * (sk[0] + bl[0] + 8);
  const b1 = sh[1] * (sk[1] + bl[1] + 8);
  const b2 = sh[2] * (sk[2] + bl[2] + 8);
  const b3 = sh[3] * (sk[3] + bl[3] + 8);
  solid.quad(b0 + b2 < b1 + b3);
}

/** Height of the water surface at one corner of a cell: the average over the (up to) four cells that share the
 *  corner, where air pulls it down and solid blocks do not count; full if any of them has water on top. */
function cornerHeight(p: number, cx: number, cz: number): number {
  let sum = 0;
  let n = 0;
  for (let dz = cz - 1; dz <= cz; dz++)
    for (let dx = cx - 1; dx <= cx; dx++) {
      const q = p + delta(dx, 0, dz);
      const id = pBlocks[q];
      if (IS_WATER[id]) {
        const above = pBlocks[q + OFF_N[2]];
        if (IS_WATER[above]) return 1;
        sum += surfaceHeight(id, above);
        n++;
      } else if (!SOLID[id] && id !== OUT) {
        n++; // open air at the corner: the surface slopes down to it
      }
    }
  return n ? sum / n : 14 / 16;
}

function waterBlock(p: number, wx: number, wy: number, wz: number): void {
  const self = pBlocks[p];
  const above = pBlocks[p + OFF_N[2]];
  const full = IS_WATER[above] === 1;
  // Corner heights: [x][z]
  const h00 = full ? 1 : cornerHeight(p, 0, 0);
  const h10 = full ? 1 : cornerHeight(p, 1, 0);
  const h01 = full ? 1 : cornerHeight(p, 0, 1);
  const h11 = full ? 1 : cornerHeight(p, 1, 1);
  const H = [
    [h00, h01],
    [h10, h11],
  ];
  void self;
  for (let f = 0; f < 6; f++) {
    const np = p + OFF_N[f];
    const nid = pBlocks[np];
    if (IS_WATER[nid] || OPAQUE[nid]) continue;
    if (nid === OUT) continue;
    water.ensure(2);
    const l = pLight[np];
    const s = (l >> 4) * 16;
    const b = (l & 15) * 16;
    const shade = FACE_SHADE[f] * 255;
    const cs = CORNERS[f];
    for (let c = 0; c < 4; c++) {
      const cy = cs[c][1] === 1 ? H[cs[c][0]][cs[c][2]] : 0;
      // Side faces show the texture only up to the water line, so it does not stretch.
      const v = cs[c][1] === 1 && f !== 2 && f !== 3 ? Math.round(16 - cy * 16) : UVS[c][1];
      water.vert(wx + cs[c][0], wy + cy, wz + cs[c][2], UVS[c][0], v, TEX.water0, s, b, shade);
    }
    water.quad(false);
    if (f === 2) {
      // The surface seen from below.
      for (let c = 3; c >= 0; c--) {
        water.vert(wx + cs[c][0], wy + H[cs[c][0]][cs[c][2]], wz + cs[c][2], UVS[c][0], UVS[c][1], TEX.water0, s, b, 0.7 * 255);
      }
      water.quad(false);
    }
  }
}

function crossBlock(p: number, wx: number, wy: number, wz: number, layer: number): void {
  solid.ensure(4);
  const l = pLight[p];
  const s = (l >> 4) * 16;
  const b = (l & 15) * 16;
  const a = 0.05;
  const e = 0.95;
  const planes = [
    [a, a, e, e],
    [a, e, e, a],
  ];
  for (const [x0, z0, x1, z1] of planes) {
    // front
    solid.vert(wx + x0, wy, wz + z0, 0, 16, layer, s, b, 255);
    solid.vert(wx + x1, wy, wz + z1, 16, 16, layer, s, b, 255);
    solid.vert(wx + x1, wy + 1, wz + z1, 16, 0, layer, s, b, 255);
    solid.vert(wx + x0, wy + 1, wz + z0, 0, 0, layer, s, b, 255);
    solid.quad(false);
    // back
    solid.vert(wx + x1, wy, wz + z1, 16, 16, layer, s, b, 255);
    solid.vert(wx + x0, wy, wz + z0, 0, 16, layer, s, b, 255);
    solid.vert(wx + x0, wy + 1, wz + z0, 0, 0, layer, s, b, 255);
    solid.vert(wx + x1, wy + 1, wz + z1, 16, 0, layer, s, b, 255);
    solid.quad(false);
  }
}

/** v8: a potted flower, three quarters size, its stem in the pot's soil (5 px up). */
function potPlant(p: number, wx: number, wy: number, wz: number, layer: number): void {
  solid.ensure(4);
  const l = pLight[p];
  const s = (l >> 4) * 16;
  const b = (l & 15) * 16;
  const a = 0.2;
  const e = 0.8;
  const y0 = wy + 4 / 16;
  const y1 = y0 + 0.75;
  for (const [x0, z0, x1, z1] of [[a, a, e, e], [a, e, e, a]]) {
    solid.vert(wx + x0, y0, wz + z0, 0, 16, layer, s, b, 255);
    solid.vert(wx + x1, y0, wz + z1, 16, 16, layer, s, b, 255);
    solid.vert(wx + x1, y1, wz + z1, 16, 0, layer, s, b, 255);
    solid.vert(wx + x0, y1, wz + z0, 0, 0, layer, s, b, 255);
    solid.quad(false);
    solid.vert(wx + x1, y0, wz + z1, 16, 16, layer, s, b, 255);
    solid.vert(wx + x0, y0, wz + z0, 0, 16, layer, s, b, 255);
    solid.vert(wx + x0, y1, wz + z0, 0, 0, layer, s, b, 255);
    solid.vert(wx + x1, y1, wz + z1, 16, 0, layer, s, b, 255);
    solid.quad(false);
  }
}

/** v7 crops, the classic way: four upright planes in a # (two each way, 4 px in from the sides), sunk a pixel
 *  into the farmland they grow on. */
function cropBlock(p: number, wx: number, wy: number, wz: number, layer: number): void {
  solid.ensure(8);
  const l = pLight[p];
  const s = (l >> 4) * 16;
  const b = (l & 15) * 16;
  const y0 = wy + (isFarmland(pBlocks[p + OFF_N[3]]) ? -1 / 16 : 0);
  const y1 = y0 + 1;
  const planes = [
    [0, 4 / 16, 1, 4 / 16],
    [0, 12 / 16, 1, 12 / 16],
    [4 / 16, 0, 4 / 16, 1],
    [12 / 16, 0, 12 / 16, 1],
  ];
  for (const [x0, z0, x1, z1] of planes) {
    solid.vert(wx + x0, y0, wz + z0, 0, 16, layer, s, b, 255);
    solid.vert(wx + x1, y0, wz + z1, 16, 16, layer, s, b, 255);
    solid.vert(wx + x1, y1, wz + z1, 16, 0, layer, s, b, 255);
    solid.vert(wx + x0, y1, wz + z0, 0, 0, layer, s, b, 255);
    solid.quad(false);
    solid.vert(wx + x1, y0, wz + z1, 16, 16, layer, s, b, 255);
    solid.vert(wx + x0, y0, wz + z0, 0, 16, layer, s, b, 255);
    solid.vert(wx + x0, y1, wz + z0, 0, 0, layer, s, b, 255);
    solid.vert(wx + x1, y1, wz + z1, 16, 0, layer, s, b, 255);
    solid.quad(false);
  }
}

// Torch: a 2x10x2 pixel stick in the middle of the cell.
const TX0 = 7 / 16;
const TX1 = 9 / 16;
const TY1 = 10 / 16;

function torchBlock(p: number, wx: number, wy: number, wz: number, layer: number): void {
  solid.ensure(6);
  const l = pLight[p];
  const s = (l >> 4) * 16;
  const b = Math.max(l & 15, 14) * 16;
  for (let f = 0; f < 6; f++) {
    const cs = CORNERS[f];
    const shade = FACE_SHADE[f] * 255;
    for (let c = 0; c < 4; c++) {
      const x = cs[c][0] ? TX1 : TX0;
      const y = cs[c][1] ? TY1 : 0;
      const z = cs[c][2] ? TX1 : TX0;
      let u: number;
      let v: number;
      if (f === 2) {
        u = cs[c][0] ? 9 : 7;
        v = cs[c][2] ? 8 : 6;
      } else if (f === 3) {
        u = cs[c][0] ? 9 : 7;
        v = cs[c][2] ? 16 : 14;
      } else {
        u = UVS[c][0] ? 9 : 7;
        v = UVS[c][1] ? 16 : 6;
      }
      solid.vert(wx + x, wy + y, wz + z, u, v, layer, s, b, shade);
    }
    solid.quad(false);
  }
}

// ------------------------------------------------------------------ model blocks (doors, stairs, slabs...)

let modelP = 0;
const modelNb: Nb = (dx, dy, dz) => pBlocks[modelP + delta(dx, dy, dz)];

function modelBlock(p: number, id: number, wx: number, wy: number, wz: number): void {
  modelP = p;
  const boxes = renderBoxes(id, modelNb);
  const own = pLight[p];
  for (const mb of boxes) {
    const [x0, y0, z0, x1, y1, z1] = mb.b;
    const lo = [x0, y0, z0];
    const hi = [x1, y1, z1];
    for (let f = 0; f < 6; f++) {
      // On the cell boundary a full opaque neighbour hides the face; inside the cell faces always draw.
      const boundary = (f === 0 && x1 === 16) || (f === 1 && x0 === 0) || (f === 2 && y1 === 16) || (f === 3 && y0 === 0) || (f === 4 && z1 === 16) || (f === 5 && z0 === 0);
      let l = own;
      if (boundary) {
        const n = pBlocks[p + OFF_N[f]];
        if (OPAQUE[n]) continue;
        l = pLight[p + OFF_N[f]];
      }
      solid.ensure(1);
      const s = (l >> 4) * 16;
      const b = (l & 15) * 16;
      const shade = FACE_SHADE[f] * 255;
      const cs = CORNERS[f];
      for (let c = 0; c < 4; c++) {
        const px = cs[c][0] ? hi[0] : lo[0];
        const py = cs[c][1] ? hi[1] : lo[1];
        const pz = cs[c][2] ? hi[2] : lo[2];
        let [u, v] = faceUV(f, px, py, pz);
        if (f === 2 && mb.topRot) [u, v] = rotateTop(u, v, mb.topRot);
        solid.vert(wx + px / 16, wy + py / 16, wz + pz / 16, u, v, mb.tex[f], s, b, shade);
      }
      solid.quad(false);
    }
  }
}
