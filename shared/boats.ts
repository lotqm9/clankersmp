// Boats (world update, protocol v8): physics shared by the client (the driver rows with prediction) and the server
// (it moves boats nobody drives: they float, drift with the current and settle), the seats, and the binary sync.
//
// Our own code after the classic boat's feel (game mechanics): W rows forward (0.04 a tick), S backs a little, A/D
// turn (the turn builds up a degree a tick and eases off), turning alone creeps forward; in water the boat keeps 90%
// of its speed each tick (top speed about 8 blocks a second), on land it barely scrapes along; buoyancy holds it with
// its floor just above the water line; flowing water pushes it along. No stepping up blocks: a boat can't climb out.
// Positions are the boat's box: feet (bottom) centre, 1.375 wide and 0.5625 tall, like the classic one.

import { IS_WATER } from "./blocks.ts";
import { WORLD_HEIGHT, WORLD_SIZE } from "./constants.ts";
import { boxHitsSolid, moveBody, waterSurface, type Body, type GetBlock } from "./physics.ts";
import { XZ_SCALE, Y_SCALE, q16 } from "./protocol.ts";
import { bounded, flowAt } from "./water.ts";

export const BOAT_W = 1.375;
export const BOAT_HW = BOAT_W / 2;
export const BOAT_H = 0.5625;
/** Where a rider's feet are, below the boat's bottom (they sit with their legs out on the floor). */
export const RIDER_Y = -0.4;
/** The boat's floor: just above where it floats, so no water shows inside it. */
export const FLOOR_Y = 0.28;
export const MAX_RIDERS = 2;
/** The fastest an honest boat goes (blocks per tick: 0.4 in still water, a little more with the current). */
export const BOAT_MAX_SPEED = 0.6;
/** How many hits break a boat in survival (the damage adds up and fades away, like the classic one). */
export const BOAT_BREAK = 40;

const GRAVITY = 0.04;
const BUOYANCY = 0.1; // equilibrium: (level - y) / H * 0.1 = 0.04 -> it floats 0.225 deep
export const BS = { WATER: 0, UNDER: 1, LAND: 2, AIR: 3 } as const;

export interface BoatBody extends Body {
  yaw: number; // degrees, Java convention (0 = +Z south, 90 = -X west): the way the bow points
  dyaw: number; // the turn being made, degrees per tick
  status: number;
}

export interface BoatInput {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
}

export function newBoat(x: number, y: number, z: number, yaw: number): BoatBody {
  return { x, y, z, vx: 0, vy: 0, vz: 0, hw: BOAT_HW, h: BOAT_H, onGround: false, collidedH: false, yaw, dyaw: 0, status: BS.AIR };
}

/** The water around the boat: the highest surface touching its box (-1 if none), and whether it is under water. */
export function boatWater(get: GetBlock, b: { x: number; y: number; z: number }): { level: number; under: boolean } {
  const x0 = Math.floor(b.x - BOAT_HW + 0.001);
  const x1 = Math.floor(b.x + BOAT_HW - 0.001);
  const z0 = Math.floor(b.z - BOAT_HW + 0.001);
  const z1 = Math.floor(b.z + BOAT_HW - 0.001);
  const y0 = Math.max(0, Math.floor(b.y - 0.05));
  const y1 = Math.min(WORLD_HEIGHT - 1, Math.floor(b.y + BOAT_H + 0.001));
  let level = -1;
  let wet = 0;
  let cells = 0;
  for (let bx = x0; bx <= x1; bx++)
    for (let bz = z0; bz <= z1; bz++) {
      if (bx < 0 || bz < 0 || bx >= WORLD_SIZE || bz >= WORLD_SIZE) continue;
      cells++;
      for (let by = y0; by <= y1; by++) {
        if (!IS_WATER[get(bx, by, bz)]) continue;
        const s = waterSurface(get, bx, by, bz);
        if (s > b.y - 0.05 && s > level) level = s;
      }
      // the cell over the boat's top: water there means it is under the surface
      if (IS_WATER[get(bx, Math.min(WORLD_HEIGHT - 1, Math.floor(b.y + BOAT_H + 0.001)), bz)] && waterSurface(get, bx, Math.floor(b.y + BOAT_H + 0.001), bz) > b.y + BOAT_H + 0.001) wet++;
    }
  return { level, under: cells > 0 && wet === cells };
}

/** One 50 ms tick of a boat. `input` is the driver's (null: nobody rows). Mutates `b`. */
export function tickBoat(b: BoatBody, input: BoatInput | null, get: GetBlock): void {
  const w = boatWater(get, b);
  const before = b.status;
  b.status = w.under ? BS.UNDER : w.level > b.y ? BS.WATER : b.onGround ? BS.LAND : BS.AIR;
  // dropping into water from the air: settle on the surface (no plunge)
  if (before === BS.AIR && b.status === BS.WATER && b.vy < 0) b.vy *= 0.2;
  let friction = 0.9;
  let gravity = -GRAVITY;
  let lift = 0;
  if (b.status === BS.WATER) lift = (w.level - b.y) / BOAT_H;
  else if (b.status === BS.UNDER) {
    gravity = 0.01;
    friction = 0.45;
  } else if (b.status === BS.LAND) friction = input ? 0.3 : 0.6;
  b.vx *= friction;
  b.vz *= friction;
  b.vy += gravity;
  b.dyaw *= friction;
  if (lift > 0) b.vy = (b.vy + lift * BUOYANCY) * 0.75;
  // the current
  if (b.status === BS.WATER || b.status === BS.UNDER) {
    const [fx, fz] = flowAt(bounded(get), b.x, b.y + 0.1, b.z);
    b.vx += fx;
    b.vz += fz;
  }
  if (input) {
    if (input.left) b.dyaw -= 1;
    if (input.right) b.dyaw += 1;
    let f = 0;
    if (input.right !== input.left && !input.forward && !input.back) f += 0.005;
    if (input.forward) f += 0.04;
    if (input.back) f -= 0.005;
    b.yaw = wrap(b.yaw + b.dyaw);
    const r = (b.yaw * Math.PI) / 180;
    b.vx += -Math.sin(r) * f;
    b.vz += Math.cos(r) * f;
  } else b.yaw = wrap(b.yaw + b.dyaw);
  if (Math.abs(b.vx) < 1e-4) b.vx = 0;
  if (Math.abs(b.vz) < 1e-4) b.vz = 0;
  moveBody(get, b, b.vx, b.vy, b.vz, 0);
  // never past the edge of the world
  b.x = Math.max(BOAT_HW + 0.01, Math.min(WORLD_SIZE - BOAT_HW - 0.01, b.x));
  b.z = Math.max(BOAT_HW + 0.01, Math.min(WORLD_SIZE - BOAT_HW - 0.01, b.z));
}

const wrap = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

/** Which oars dip this tick (the left one when rowing forward or turning right, and the other way round). */
export function paddles(input: BoatInput): { left: boolean; right: boolean } {
  return { left: (input.right && !input.left) || input.forward, right: (input.left && !input.right) || input.forward };
}

/** Seat k's offset along the boat (one rider sits in the middle; two sit fore and aft). */
export const seatOffset = (seat: number, riders: number) => (riders > 1 ? (seat === 0 ? 0.2 : -0.6) : 0);

/** Where a rider's feet are: on the boat's long axis, at `seatOffset`, RIDER_Y below its bottom. */
export function seatPos(b: { x: number; y: number; z: number; yaw: number }, seat: number, riders: number): { x: number; y: number; z: number } {
  const off = seatOffset(seat, riders);
  const r = (b.yaw * Math.PI) / 180;
  return { x: b.x - Math.sin(r) * off, y: b.y + RIDER_Y, z: b.z + Math.cos(r) * off };
}

/** Does a boat's box fit here (no solid block in it)? */
export const boatFits = (get: GetBlock, x: number, y: number, z: number) =>
  !boxHitsSolid(get, x - BOAT_HW + 0.02, y + 0.02, z - BOAT_HW + 0.02, x + BOAT_HW - 0.02, y + BOAT_H - 0.02, z + BOAT_HW - 0.02);

// ------------------------------------------------------------------ the wire

/** Boat flags on the wire. */
export const BF = {
  HURT: 1, // just hit: it rocks
  ROW_L: 2, // the left oar dips
  ROW_R: 4,
  DRIVEN: 8, // someone rows it
  WATER: 16, // afloat
} as const;

export const OP_BOATS = 27; // [op u8][tick u32][n u16] then n * BOAT_ENTRY
export const OP_BOATS_GONE = 28; // [op u8][n u16] then n * id u16
export const BOAT_ENTRY = 11; // id u16, x u16 (1/128), y u16 (1/256), z u16 (1/128), yaw u16, flags u8
export const BOAT_RANGE = 96;
export const BOAT_RANGE_OUT = 104;

export interface BoatSnap {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  flags: number;
}

export function encodeBoats(tick: number, list: BoatSnap[]): Uint8Array {
  const out = new Uint8Array(7 + list.length * BOAT_ENTRY);
  const v = new DataView(out.buffer);
  v.setUint8(0, OP_BOATS);
  v.setUint32(1, tick >>> 0, true);
  v.setUint16(5, list.length, true);
  let o = 7;
  for (const b of list) {
    v.setUint16(o, b.id, true);
    v.setUint16(o + 2, q16(b.x, XZ_SCALE), true);
    v.setUint16(o + 4, q16(b.y, Y_SCALE), true);
    v.setUint16(o + 6, q16(b.z, XZ_SCALE), true);
    v.setUint16(o + 8, Math.round((((b.yaw % 360) + 360) % 360) * (65536 / 360)) & 0xffff, true);
    v.setUint8(o + 10, b.flags & 255);
    o += BOAT_ENTRY;
  }
  return out;
}

export function decodeBoats(v: DataView): { tick: number; list: BoatSnap[] } {
  const tick = v.getUint32(1, true);
  const n = v.getUint16(5, true);
  const list: BoatSnap[] = [];
  let o = 7;
  for (let i = 0; i < n && o + BOAT_ENTRY <= v.byteLength; i++, o += BOAT_ENTRY) {
    list.push({
      id: v.getUint16(o, true),
      x: v.getUint16(o + 2, true) / XZ_SCALE,
      y: v.getUint16(o + 4, true) / Y_SCALE,
      z: v.getUint16(o + 6, true) / XZ_SCALE,
      yaw: (v.getUint16(o + 8, true) * 360) / 65536,
      flags: v.getUint8(o + 10),
    });
  }
  return { tick, list };
}
