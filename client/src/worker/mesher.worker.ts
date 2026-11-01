// Web Worker: owns a copy of the world plus its light, and turns dirty sections into vertex buffers.
// Only sections within the mesh radius of the player are meshed; sections far behind are dropped again, so
// GPU memory follows the render distance and not the (512 x 512) world size.

import { CHUNK, CHUNKS, SECTIONS, cellX, cellY, cellZ, idx } from "../../../shared/constants.ts";
import { LightEngine } from "./light.ts";
import { meshSection, type MeshArrays } from "./mesher.ts";

interface Ctx {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
}
const ctx = self as unknown as Ctx;

let blocks: Uint8Array | null = null;
let light: LightEngine | null = null;
const dirty = new Set<number>();
const meshed = new Set<number>(); // sections the main thread currently holds (or was told are empty)
let px = 8;
let py = 3;
let pz = 8;
let radius = 9; // chunks
let scheduled = false;

const key = (cx: number, cy: number, cz: number) => (cy * CHUNKS + cz) * CHUNKS + cx;
const keyX = (k: number) => k % CHUNKS;
const keyZ = (k: number) => Math.floor(k / CHUNKS) % CHUNKS;
const keyY = (k: number) => Math.floor(k / (CHUNKS * CHUNKS));

function inRange(cx: number, cz: number, r: number): boolean {
  const dx = cx + 0.5 - px;
  const dz = cz + 0.5 - pz;
  return dx * dx + dz * dz <= (r + 0.75) * (r + 0.75);
}

function markCell(i: number): void {
  const x = cellX(i);
  const z = cellZ(i);
  const y = cellY(i);
  const x0 = Math.max(0, (x - 1) >> 4);
  const x1 = Math.min(CHUNKS - 1, (x + 1) >> 4);
  const y0 = Math.max(0, (y - 1) >> 4);
  const y1 = Math.min(SECTIONS - 1, (y + 1) >> 4);
  const z0 = Math.max(0, (z - 1) >> 4);
  const z1 = Math.min(CHUNKS - 1, (z + 1) >> 4);
  for (let cz = z0; cz <= z1; cz++)
    for (let cx = x0; cx <= x1; cx++) {
      const near = inRange(cx, cz, radius);
      for (let cy = y0; cy <= y1; cy++) {
        const k = key(cx, cy, cz);
        if (near) dirty.add(k);
        else if (meshed.delete(k)) dropQueue.push(k); // stale and out of sight: rebuilt when the player comes near
      }
    }
  if (dropQueue.length) schedule();
}

const dropQueue: number[] = [];

/** Queue everything in range that is not meshed yet; drop what is far out of range. */
function refreshRange(all = false): void {
  const pcx = Math.floor(px);
  const pcz = Math.floor(pz);
  const r = Math.ceil(radius) + 1;
  for (let cz = Math.max(0, pcz - r); cz <= Math.min(CHUNKS - 1, pcz + r); cz++)
    for (let cx = Math.max(0, pcx - r); cx <= Math.min(CHUNKS - 1, pcx + r); cx++) {
      if (!inRange(cx, cz, radius)) continue;
      for (let cy = 0; cy < SECTIONS; cy++) {
        const k = key(cx, cy, cz);
        if (all || !meshed.has(k)) dirty.add(k);
      }
    }
  const drop: number[] = [];
  for (const k of meshed) {
    if (!inRange(keyX(k), keyZ(k), radius + 2)) {
      meshed.delete(k);
      drop.push(k);
    }
  }
  for (const k of dirty) if (!inRange(keyX(k), keyZ(k), radius + 1)) dirty.delete(k);
  dropQueue.push(...drop);
  schedule();
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  setTimeout(work, 0);
}

function dist(k: number): number {
  const dx = keyX(k) + 0.5 - px;
  const dz = keyZ(k) + 0.5 - pz;
  const dy = (keyY(k) + 0.5 - py) * 0.6;
  return dx * dx + dz * dz + dy * dy;
}

interface MeshOut {
  key: number;
  cx: number;
  cy: number;
  cz: number;
  solid: MeshArrays | null;
  water: MeshArrays | null;
}

function work(): void {
  scheduled = false;
  if (dropQueue.length) ctx.postMessage({ type: "drop", keys: dropQueue.splice(0) });
  if (!blocks || !light || dirty.size === 0) return;
  const list = [...dirty].sort((a, b) => dist(a) - dist(b));
  const t0 = performance.now();
  const out: MeshOut[] = [];
  const transfer: Transferable[] = [];
  for (const k of list) {
    dirty.delete(k);
    const cx = keyX(k);
    const cz = keyZ(k);
    const cy = keyY(k);
    const res = meshSection(blocks, light.light, cx, cy, cz);
    meshed.add(k);
    out.push({ key: k, cx, cy, cz, solid: res.solid, water: res.water });
    for (const m of [res.solid, res.water]) {
      if (!m) continue;
      transfer.push(m.pos.buffer, m.uv.buffer, m.data.buffer, m.index.buffer);
    }
    if (performance.now() - t0 > 10) break;
  }
  ctx.postMessage({ type: "meshes", list: out, pending: dirty.size }, transfer);
  if (dirty.size > 0) schedule();
}

ctx.onmessage = (e: MessageEvent) => {
  const m = e.data;
  switch (m.type) {
    case "init": {
      // The main thread generated the terrain and applied the edits; this is its copy, transferred.
      const t0 = performance.now();
      blocks = m.blocks as Uint8Array;
      light = new LightEngine(blocks);
      light.computeAll();
      light.onChange = markCell;
      px = m.x / CHUNK;
      py = m.y / CHUNK;
      pz = m.z / CHUNK;
      radius = m.radius ?? radius;
      ctx.postMessage({ type: "ready", lightMs: performance.now() - t0 });
      refreshRange(true);
      break;
    }
    case "full": {
      if (!blocks || !light) return;
      blocks.set(m.blocks);
      light.onChange = null;
      light.computeAll();
      light.onChange = markCell;
      refreshRange(true);
      break;
    }
    case "set": {
      if (!blocks || !light) return;
      const list: number[] = m.list; // flat x,y,z,id
      for (let o = 0; o + 3 < list.length; o += 4) {
        const i = idx(list[o], list[o + 1], list[o + 2]);
        const old = blocks[i];
        const id = list[o + 3];
        if (old === id) continue;
        blocks[i] = id;
        markCell(i);
        light.update(i, old);
      }
      schedule();
      break;
    }
    case "pos": {
      px = m.x / CHUNK;
      py = m.y / CHUNK;
      pz = m.z / CHUNK;
      refreshRange();
      break;
    }
    case "radius": {
      radius = Math.max(2, Math.min(16, Number(m.radius) || 9));
      refreshRange();
      break;
    }
    case "light": {
      // Light probe for entities: reply with sky/block light at a list of cells.
      if (!light) return;
      const cells: number[] = m.cells;
      const out = cells.map((i) => (i >= 0 && i < light!.light.length ? light!.light[i] : 0xf0));
      ctx.postMessage({ type: "light", id: m.id, values: out });
      break;
    }
  }
};
