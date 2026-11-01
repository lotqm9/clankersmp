// Sky light and block light, flood-filled like Java Edition (levels 0..15).
// light[i] = sky << 4 | block. Incremental updates use the usual removal + re-propagation BFS.

import { EMIT, LIGHT_OPACITY, OPAQUE } from "../../../shared/blocks.ts";
import { VOLUME, WORLD_BITS, WORLD_HEIGHT, WORLD_MASK, WORLD_SIZE, Y_SHIFT } from "../../../shared/constants.ts";

const W = WORLD_SIZE;
const H = WORLD_HEIGHT;
const LAYER = W * W; // stride of one y step

/** Queue of cell indices (with an optional value) backed by growable typed arrays. */
class Queue {
  a: Int32Array;
  v: Uint8Array;
  head = 0;
  tail = 0;
  constructor(cap: number) {
    this.a = new Int32Array(cap);
    this.v = new Uint8Array(cap);
  }
  push(i: number, val = 0): void {
    if (this.tail === this.a.length) {
      if (this.head > 0) {
        this.a.copyWithin(0, this.head, this.tail);
        this.v.copyWithin(0, this.head, this.tail);
        this.tail -= this.head;
        this.head = 0;
      } else {
        const na = new Int32Array(this.a.length * 2);
        na.set(this.a);
        const nv = new Uint8Array(this.v.length * 2);
        nv.set(this.v);
        this.a = na;
        this.v = nv;
      }
    }
    this.a[this.tail] = i;
    this.v[this.tail] = val;
    this.tail++;
  }
  get size(): number {
    return this.tail - this.head;
  }
  reset(): void {
    this.head = 0;
    this.tail = 0;
  }
}

export type DirtyFn = (cell: number) => void;

export class LightEngine {
  blocks: Uint8Array;
  light: Uint8Array;
  private add = new Queue(1 << 16);
  private rem = new Queue(1 << 16);
  onChange: DirtyFn | null = null;

  constructor(blocks: Uint8Array) {
    this.blocks = blocks;
    this.light = new Uint8Array(VOLUME);
  }

  /** Full computation from scratch. */
  computeAll(): void {
    const { blocks, light } = this;
    light.fill(0);
    const top = new Int16Array(W * W); // 1 + y of the highest cell that dims light (leaves, water, solid)
    // Sunlight columns.
    for (let z = 0; z < W; z++) {
      for (let x = 0; x < W; x++) {
        let level = 15;
        let firstDim = -1;
        let y = H - 1;
        let i = (y << Y_SHIFT) | (z << WORLD_BITS) | x;
        for (; y >= 0; y--, i -= LAYER) {
          const id = blocks[i];
          if (OPAQUE[id]) {
            if (firstDim < 0) firstDim = y + 1;
            break;
          }
          const op = LIGHT_OPACITY[id];
          if (op > 0) {
            if (firstDim < 0) firstDim = y + 1;
            level = Math.max(0, level - op);
          }
          light[i] = level << 4;
          if (level === 0) break;
        }
        top[z * W + x] = firstDim < 0 ? 0 : firstDim;
      }
    }
    // Seed the spread from every lit cell next to a darker transparent neighbour.
    const q = this.add;
    q.reset();
    for (let z = 0; z < W; z++) {
      for (let x = 0; x < W; x++) {
        let maxN = top[z * W + x];
        if (x > 0) maxN = Math.max(maxN, top[z * W + x - 1]);
        if (x < W - 1) maxN = Math.max(maxN, top[z * W + x + 1]);
        if (z > 0) maxN = Math.max(maxN, top[(z - 1) * W + x]);
        if (z < W - 1) maxN = Math.max(maxN, top[(z + 1) * W + x]);
        const y0 = Math.max(0, top[z * W + x] - 1);
        for (let y = y0; y <= Math.min(H - 1, maxN + 1); y++) {
          const i = (y << Y_SHIFT) | (z << WORLD_BITS) | x;
          if (light[i] >> 4 > 1) q.push(i);
        }
      }
    }
    this.spreadSky(false);
    // Block light sources.
    q.reset();
    for (let i = 0; i < VOLUME; i++) {
      const e = EMIT[blocks[i]];
      if (e > 0) {
        light[i] = (light[i] & 0xf0) | e;
        q.push(i);
      }
    }
    this.spreadBlock(false);
  }

  private notify(i: number): void {
    if (this.onChange) this.onChange(i);
  }

  /** BFS spread of sky light from the add queue. */
  private spreadSky(track: boolean): void {
    const { blocks, light } = this;
    const q = this.add;
    while (q.size > 0) {
      const i = q.a[q.head++];
      const L = light[i] >> 4;
      if (L <= 1) continue;
      const x = i & WORLD_MASK;
      const z = (i >> WORLD_BITS) & WORLD_MASK;
      const y = i >> Y_SHIFT;
      for (let d = 0; d < 6; d++) {
        let n: number;
        if (d === 0) {
          if (x === W - 1) continue;
          n = i + 1;
        } else if (d === 1) {
          if (x === 0) continue;
          n = i - 1;
        } else if (d === 2) {
          if (y === H - 1) continue;
          n = i + LAYER;
        } else if (d === 3) {
          if (y === 0) continue;
          n = i - LAYER;
        } else if (d === 4) {
          if (z === W - 1) continue;
          n = i + W;
        } else {
          if (z === 0) continue;
          n = i - W;
        }
        const id = blocks[n];
        if (OPAQUE[id]) continue;
        const op = LIGHT_OPACITY[id];
        let nl = d === 3 && L === 15 && op === 0 ? 15 : L - (op > 1 ? op : 1);
        if (nl < 0) nl = 0;
        if (nl > light[n] >> 4) {
          light[n] = (nl << 4) | (light[n] & 15);
          q.push(n);
          if (track) this.notify(n);
        }
      }
    }
    q.reset();
  }

  private spreadBlock(track: boolean): void {
    const { blocks, light } = this;
    const q = this.add;
    while (q.size > 0) {
      const i = q.a[q.head++];
      const L = light[i] & 15;
      if (L <= 1) continue;
      const x = i & WORLD_MASK;
      const z = (i >> WORLD_BITS) & WORLD_MASK;
      const y = i >> Y_SHIFT;
      for (let d = 0; d < 6; d++) {
        let n: number;
        if (d === 0) {
          if (x === W - 1) continue;
          n = i + 1;
        } else if (d === 1) {
          if (x === 0) continue;
          n = i - 1;
        } else if (d === 2) {
          if (y === H - 1) continue;
          n = i + LAYER;
        } else if (d === 3) {
          if (y === 0) continue;
          n = i - LAYER;
        } else if (d === 4) {
          if (z === W - 1) continue;
          n = i + W;
        } else {
          if (z === 0) continue;
          n = i - W;
        }
        const id = blocks[n];
        if (OPAQUE[id]) continue;
        const op = LIGHT_OPACITY[id];
        const nl = L - (op > 1 ? op : 1);
        if (nl > (light[n] & 15)) {
          light[n] = (light[n] & 0xf0) | nl;
          q.push(n);
          if (track) this.notify(n);
        }
      }
    }
    q.reset();
  }

  private neighbors(i: number, out: number[]): number {
    const x = i & WORLD_MASK;
    const z = (i >> WORLD_BITS) & WORLD_MASK;
    const y = i >> Y_SHIFT;
    let k = 0;
    if (x < W - 1) out[k++] = i + 1;
    if (x > 0) out[k++] = i - 1;
    if (y < H - 1) out[k++] = i + LAYER;
    if (y > 0) out[k++] = i - LAYER;
    if (z < W - 1) out[k++] = i + W;
    if (z > 0) out[k++] = i - W;
    return k;
  }

  /** Apply a block change at cell i (blocks[i] must already hold the new id). */
  update(i: number, oldId: number): void {
    const { blocks, light } = this;
    const newId = blocks[i];
    const nb: number[] = [0, 0, 0, 0, 0, 0];

    // ---- block light ----
    const oldBL = light[i] & 15;
    const darker = OPAQUE[newId] > OPAQUE[oldId] || LIGHT_OPACITY[newId] > LIGHT_OPACITY[oldId] || EMIT[oldId] > EMIT[newId];
    if (darker && oldBL > 0) {
      const rem = this.rem;
      rem.reset();
      light[i] &= 0xf0;
      this.notify(i);
      rem.push(i, oldBL);
      while (rem.size > 0) {
        const c = rem.a[rem.head];
        const v = rem.v[rem.head];
        rem.head++;
        const k = this.neighbors(c, nb);
        for (let j = 0; j < k; j++) {
          const n = nb[j];
          const nl = light[n] & 15;
          if (nl !== 0 && nl < v) {
            light[n] &= 0xf0;
            this.notify(n);
            rem.push(n, nl);
            const e = EMIT[blocks[n]];
            if (e > 0) {
              light[n] = (light[n] & 0xf0) | e;
              this.add.push(n);
            }
          } else if (nl >= v) {
            this.add.push(n);
          }
        }
      }
      rem.reset();
    }
    const emit = EMIT[newId];
    if (emit > (light[i] & 15)) {
      light[i] = (light[i] & 0xf0) | emit;
      this.notify(i);
      this.add.push(i);
    }
    if (!OPAQUE[newId]) {
      const k = this.neighbors(i, nb);
      for (let j = 0; j < k; j++) if ((light[nb[j]] & 15) > 1) this.add.push(nb[j]);
    } else if (!emit) {
      light[i] &= 0xf0;
    }
    this.spreadBlock(true);

    // ---- sky light ----
    const oldSL = light[i] >> 4;
    const skyDarker = OPAQUE[newId] > OPAQUE[oldId] || LIGHT_OPACITY[newId] > LIGHT_OPACITY[oldId];
    if (skyDarker && oldSL > 0) {
      const rem = this.rem;
      rem.reset();
      light[i] &= 15;
      this.notify(i);
      rem.push(i, oldSL);
      while (rem.size > 0) {
        const c = rem.a[rem.head];
        const v = rem.v[rem.head];
        rem.head++;
        const k = this.neighbors(c, nb);
        for (let j = 0; j < k; j++) {
          const n = nb[j];
          const nl = light[n] >> 4;
          const below = n === c - LAYER;
          if (nl !== 0 && (nl < v || (below && v === 15 && nl === 15))) {
            light[n] &= 15;
            this.notify(n);
            rem.push(n, nl);
          } else if (nl >= v) {
            this.add.push(n);
          }
        }
      }
      rem.reset();
    }
    if (!OPAQUE[newId]) {
      const k = this.neighbors(i, nb);
      for (let j = 0; j < k; j++) if (light[nb[j]] >> 4 > 1 || nb[j] === i + LAYER) this.add.push(nb[j]);
      // Open sky directly above: sunlight falls straight in.
      const y = i >> Y_SHIFT;
      if (y === H - 1) {
        light[i] = (15 << 4) | (light[i] & 15);
        this.add.push(i);
      }
    } else {
      light[i] &= 15;
    }
    this.spreadSky(true);
  }
}
