// Passive animals (protocol v2): the four kinds, their sizes and speeds, and the cheap binary sync format.
// The server owns every animal (AI + physics); clients only interpolate the snapshots and draw them.

import { WORLD_SIZE } from "./constants.ts";
import { XZ_SCALE, Y_SCALE, q16 } from "./protocol.ts";

export const ANIMAL = { PIG: 0, COW: 1, SHEEP: 2, CHICKEN: 3 } as const;
export type AnimalKind = (typeof ANIMAL)[keyof typeof ANIMAL];

export interface AnimalSpec {
  key: "pig" | "cow" | "sheep" | "chicken";
  name: string;
  w: number; // box width (x and z), blocks
  h: number; // box height
  walk: number; // wandering speed, blocks per tick
  panic: number; // fleeing speed, blocks per tick
  herd: [number, number]; // how many spawn together
  weight: number; // how common
  hp: number; // health in half hearts (v5)
}

export const SPECS: AnimalSpec[] = [
  { key: "pig", name: "Pig", w: 0.9, h: 0.9, walk: 0.05, panic: 0.125, herd: [2, 4], weight: 3, hp: 10 },
  { key: "cow", name: "Cow", w: 0.9, h: 1.4, walk: 0.045, panic: 0.115, herd: [2, 4], weight: 3, hp: 10 },
  { key: "sheep", name: "Sheep", w: 0.9, h: 1.3, walk: 0.048, panic: 0.12, herd: [2, 4], weight: 3, hp: 8 },
  { key: "chicken", name: "Chicken", w: 0.5, h: 0.7, walk: 0.045, panic: 0.13, herd: [2, 5], weight: 3, hp: 4 },
];

/** Animal flags on the wire. */
export const AF = {
  MOVING: 1,
  PANIC: 2,
  HURT: 4, // set for half a second after a hit: clients play the hurt sound on its rising edge and flash red
  GROUND: 8,
  EAT: 16, // grazing / pecking pose
  SWIM: 32,
  DEAD: 64, // v5: dying (tips over, then it's gone)
} as const;

// S2C ops (binary)
export const OP_ANIMALS = 20; // [op u8][tick u32][n u16] then n * ANIMAL_ENTRY
export const OP_ANIMALS_GONE = 21; // [op u8][n u16] then n * id u16: out of range or removed
export const ANIMAL_ENTRY = 11; // id u16, kind u8, x u16 (1/128), y u16 (1/256), z u16 (1/128), yaw u8, flags u8

/** How far animals are tracked for a player (blocks, horizontal), and the hysteresis before "gone". */
export const ANIMAL_RANGE = 96;
export const ANIMAL_RANGE_OUT = 104;
/** The server's hit reach (eye to the animal's box), like block reach. */
export const ANIMAL_REACH = 5.25;

export interface AnimalSnap {
  id: number;
  kind: number;
  x: number;
  y: number;
  z: number;
  yaw: number; // degrees, Java convention
  flags: number;
}

/** Animal snapshots; v6 night mobs use the same layout under their own op (shared/mobs.ts). */
export function encodeAnimals(tick: number, list: AnimalSnap[], op: number = OP_ANIMALS): Uint8Array {
  const out = new Uint8Array(7 + list.length * ANIMAL_ENTRY);
  const v = new DataView(out.buffer);
  v.setUint8(0, op);
  v.setUint32(1, tick >>> 0, true);
  v.setUint16(5, list.length, true);
  let o = 7;
  for (const a of list) {
    v.setUint16(o, a.id, true);
    v.setUint8(o + 2, a.kind);
    v.setUint16(o + 3, q16(a.x, XZ_SCALE), true);
    v.setUint16(o + 5, q16(a.y, Y_SCALE), true);
    v.setUint16(o + 7, q16(a.z, XZ_SCALE), true);
    v.setUint8(o + 9, Math.round((((a.yaw % 360) + 360) % 360) * (256 / 360)) & 255);
    v.setUint8(o + 10, a.flags & 255);
    o += ANIMAL_ENTRY;
  }
  return out;
}

export function decodeAnimals(v: DataView): { tick: number; list: AnimalSnap[] } {
  const tick = v.getUint32(1, true);
  const n = v.getUint16(5, true);
  const list: AnimalSnap[] = [];
  let o = 7;
  for (let i = 0; i < n && o + ANIMAL_ENTRY <= v.byteLength; i++, o += ANIMAL_ENTRY) {
    list.push({
      id: v.getUint16(o, true),
      kind: v.getUint8(o + 2),
      x: v.getUint16(o + 3, true) / XZ_SCALE,
      y: v.getUint16(o + 5, true) / Y_SCALE,
      z: v.getUint16(o + 7, true) / XZ_SCALE,
      yaw: (v.getUint8(o + 9) * 360) / 256,
      flags: v.getUint8(o + 10),
    });
  }
  return { tick, list };
}

export function encodeGone(ids: number[], op: number = OP_ANIMALS_GONE): Uint8Array {
  const out = new Uint8Array(3 + ids.length * 2);
  const v = new DataView(out.buffer);
  v.setUint8(0, op);
  v.setUint16(1, ids.length, true);
  ids.forEach((id, k) => v.setUint16(3 + k * 2, id, true));
  return out;
}

export function decodeGone(v: DataView): number[] {
  const n = v.getUint16(1, true);
  const out: number[] = [];
  for (let k = 0; k < n && 3 + k * 2 + 2 <= v.byteLength; k++) out.push(v.getUint16(3 + k * 2, true));
  return out;
}

/** Ray (from the eye) against an animal's box; returns the distance or -1. */
export function rayHitsBox(ex: number, ey: number, ez: number, dx: number, dy: number, dz: number, max: number, x: number, y: number, z: number, w: number, h: number): number {
  const hw = w / 2;
  const lo = [x - hw, y, z - hw];
  const hi = [x + hw, y + h, z + hw];
  const o = [ex, ey, ez];
  const d = [dx, dy, dz];
  let t0 = 0;
  let t1 = max;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-9) {
      if (o[k] < lo[k] || o[k] > hi[k]) return -1;
      continue;
    }
    let a = (lo[k] - o[k]) / d[k];
    let b = (hi[k] - o[k]) / d[k];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return -1;
  }
  return t0;
}

/** Distance from a point to an animal's box (0 inside). */
export function distToBox(px: number, py: number, pz: number, x: number, y: number, z: number, w: number, h: number): number {
  const hw = w / 2;
  const cx = Math.max(x - hw, Math.min(x + hw, px));
  const cy = Math.max(y, Math.min(y + h, py));
  const cz = Math.max(z - hw, Math.min(z + hw, pz));
  return Math.hypot(px - cx, py - cy, pz - cz);
}

/** Does a block cell overlap an animal's box? (Placement never goes inside an animal.) */
export function cellHitsAnimal(bx: number, by: number, bz: number, x: number, y: number, z: number, w: number, h: number, shrink = 0.05): boolean {
  const hw = w / 2 - shrink;
  return bx + 1 > x - hw && bx < x + hw && by + 1 > y + shrink && by < y + h - shrink && bz + 1 > z - hw && bz < z + hw;
}

export const inWorldXZ = (x: number, z: number) => x > 0.5 && z > 0.5 && x < WORLD_SIZE - 0.5 && z < WORLD_SIZE - 0.5;
