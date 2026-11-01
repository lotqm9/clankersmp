// Dropped items in the world (protocol v5): what breaking blocks, dying, killing animals and Q leave behind. The
// server owns them (physics, merging, pickup, despawn after 5 minutes); clients get small binary snapshots of the
// ones near them and draw them bobbing and spinning.

import { XZ_SCALE, Y_SCALE, q16 } from "./protocol.ts";

export const OP_ITEMS = 22; // [op u8][tick u32][n u16] then n * ITEM_ENTRY
export const OP_ITEMS_GONE = 23; // [op u8][n u16] then n * id u16 (out of range, merged or despawned)
export const OP_ITEM_PICKUP = 24; // [op u8][n u16] then n * (item entity id u16, player id u16): fly-to-player animation
export const ITEM_ENTRY = 11; // id u16, item u16, count u8, x u16 (1/128), y u16 (1/256), z u16 (1/128)

export const ITEM_RANGE = 48; // sent to players this close (horizontal)
export const ITEM_RANGE_OUT = 56;
export const ITEM_DESPAWN = 6000; // 5 minutes
export const PICKUP_DELAY = 10; // ticks after a drop before anyone can pick it up
export const THROW_DELAY = 40; // after a player throws it (so it can't be caught straight back)

export interface ItemSnap {
  id: number;
  item: number;
  n: number;
  x: number;
  y: number;
  z: number;
}

export function encodeItems(tick: number, list: ItemSnap[]): Uint8Array {
  const out = new Uint8Array(7 + list.length * ITEM_ENTRY);
  const v = new DataView(out.buffer);
  v.setUint8(0, OP_ITEMS);
  v.setUint32(1, tick >>> 0, true);
  v.setUint16(5, list.length, true);
  let o = 7;
  for (const s of list) {
    v.setUint16(o, s.id, true);
    v.setUint16(o + 2, s.item, true);
    v.setUint8(o + 4, Math.min(255, s.n));
    v.setUint16(o + 5, q16(s.x, XZ_SCALE), true);
    v.setUint16(o + 7, q16(s.y, Y_SCALE), true);
    v.setUint16(o + 9, q16(s.z, XZ_SCALE), true);
    o += ITEM_ENTRY;
  }
  return out;
}

export function decodeItems(v: DataView): { tick: number; list: ItemSnap[] } {
  const tick = v.getUint32(1, true);
  const n = v.getUint16(5, true);
  const list: ItemSnap[] = [];
  let o = 7;
  for (let i = 0; i < n && o + ITEM_ENTRY <= v.byteLength; i++) {
    list.push({
      id: v.getUint16(o, true),
      item: v.getUint16(o + 2, true),
      n: v.getUint8(o + 4),
      x: v.getUint16(o + 5, true) / XZ_SCALE,
      y: v.getUint16(o + 7, true) / Y_SCALE,
      z: v.getUint16(o + 9, true) / XZ_SCALE,
    });
    o += ITEM_ENTRY;
  }
  return { tick, list };
}

export function encodeIds(op: number, ids: number[]): Uint8Array {
  const out = new Uint8Array(3 + ids.length * 2);
  const v = new DataView(out.buffer);
  v.setUint8(0, op);
  v.setUint16(1, ids.length, true);
  ids.forEach((id, k) => v.setUint16(3 + k * 2, id, true));
  return out;
}

export function decodeIds(v: DataView): number[] {
  const n = v.getUint16(1, true);
  const out: number[] = [];
  for (let k = 0; k < n && 3 + k * 2 + 2 <= v.byteLength; k++) out.push(v.getUint16(3 + k * 2, true));
  return out;
}

export function encodePickups(list: [number, number][]): Uint8Array {
  return encodeIds(OP_ITEM_PICKUP, list.flat());
}

export function decodePickups(v: DataView): [number, number][] {
  const flat = decodeIds(v);
  const out: [number, number][] = [];
  for (let k = 0; k + 1 < flat.length; k += 2) out.push([flat[k], flat[k + 1]]);
  return out;
}
