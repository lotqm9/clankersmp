// Boats for one shard (protocol v8). The server owns every boat: where it is, who sits in it (two seats; the first
// rider rows), and what it has taken in hits. A boat with a driver moves as that driver's client rows it (the same
// shared physics, shared/boats.ts), checked here for speed, for fitting in the world and for staying on the water or
// the ground; any other boat the server moves itself while a player is near: it floats, drifts with the current and
// settles. Boats are kept across restarts (boats.json) and streamed like animals: only to players near them, only
// what changed (11 bytes a boat, 5-10 Hz).

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BF, BOAT_H, BOAT_HW, BOAT_RANGE, BOAT_RANGE_OUT, BS, OP_BOATS_GONE, boatFits, boatWater, encodeBoats, newBoat, seatPos, tickBoat, type BoatBody, type BoatSnap } from "../../shared/boats.ts";
import { encodeGone } from "../../shared/animals.ts";
import { SOLID } from "../../shared/blocks.ts";
import { WORLD_SIZE } from "../../shared/constants.ts";
import type { GetBlock } from "../../shared/physics.ts";

export const BOAT_CAP = 200; // per shard
export const BOATS_NEAR_CAP = 12; // within 10 blocks of a new one (no boat spam)
const WAKE_RANGE = 80; // nobody this close: the boat rests (no physics)
const DRIVER_TIMEOUT = 1500; // ms without word from the driver: the server takes the boat over

export interface Boat extends BoatBody {
  id: number;
  riders: number[]; // player ids, the driver first
  dmg: number; // hits taken (fades 1 a tick); over BOAT_BREAK it breaks
  hurtUntil: number; // tick
  flags: number;
  version: number;
  key: string;
  driverAt: number; // ms: the driver's last update
  unsupportedSince: number; // ms, 0 = on water or ground
  correctedAt: number; // ms: the last time the server put it back (the driver's packets sent before that are stale)
  last: { x: number; y: number; z: number; yaw: number }; // the last place it was on water or ground
}

export type Seen = Map<number, number>;

export class BoatManager {
  readonly boats = new Map<number, Boat>();
  private nextId = 1;
  private get: GetBlock;
  private path: string;
  private removed: number[] = [];
  /** Something to save (a boat placed, moved or gone). */
  dirty = false;
  /** Called when a boat moves: its riders go with it. */
  onMoved: (b: Boat) => void = () => {};

  constructor(get: GetBlock, dir: string) {
    this.get = get;
    this.path = join(dir, "boats.json");
  }

  spawn(x: number, y: number, z: number, yaw: number): Boat | null {
    if (this.boats.size >= BOAT_CAP) return null;
    let id = this.nextId;
    for (let k = 0; k < 65535 && this.boats.has(id); k++) id = (id % 65534) + 1;
    this.nextId = (id % 65534) + 1;
    const b: Boat = {
      ...newBoat(x, y, z, yaw), id, riders: [], dmg: 0, hurtUntil: 0, flags: 0, version: 1, key: "", driverAt: 0, unsupportedSince: 0, correctedAt: 0,
      last: { x, y, z, yaw },
    };
    this.boats.set(id, b);
    this.dirty = true;
    return b;
  }

  remove(id: number): void {
    if (this.boats.delete(id)) this.removed.push(id);
    this.dirty = true;
  }

  /** Boats within r blocks (horizontally) of a point. */
  near(x: number, z: number, r: number): number {
    let n = 0;
    for (const b of this.boats.values()) if ((b.x - x) ** 2 + (b.z - z) ** 2 <= r * r) n++;
    return n;
  }

  /** Does a block placed in this cell overlap a boat? */
  blocksCell(x: number, y: number, z: number): boolean {
    for (const b of this.boats.values()) {
      if (x + 1 > b.x - BOAT_HW && x < b.x + BOAT_HW && y + 1 > b.y && y < b.y + BOAT_H && z + 1 > b.z - BOAT_HW && z < b.z + BOAT_HW) return true;
    }
    return false;
  }

  /** On the water, or on (or just over) the ground? */
  supported(b: { x: number; y: number; z: number }): boolean {
    if (boatWater(this.get, b).level > b.y - 0.15) return true;
    const y = Math.floor(b.y - 0.2);
    for (const [dx, dz] of [[-BOAT_HW, -BOAT_HW], [BOAT_HW, -BOAT_HW], [-BOAT_HW, BOAT_HW], [BOAT_HW, BOAT_HW], [0, 0]]) {
      if (SOLID[this.get(Math.floor(b.x + dx * 0.98), y, Math.floor(b.z + dz * 0.98))]) return true;
    }
    return false;
  }

  /** Is the driver still rowing it (a recent update)? */
  driven(b: Boat, now = Date.now()): boolean {
    return b.riders.length > 0 && now - b.driverAt < DRIVER_TIMEOUT;
  }

  /** A driver's update was accepted: the boat is where they say. */
  driverMoved(b: Boat, x: number, y: number, z: number, yaw: number, rows: number): void {
    b.x = x;
    b.y = y;
    b.z = z;
    b.yaw = yaw;
    b.vx = b.vy = b.vz = 0;
    b.dyaw = 0;
    b.driverAt = Date.now();
    b.flags = (b.flags & BF.HURT) | BF.DRIVEN | (rows & (BF.ROW_L | BF.ROW_R)) | (this.supported(b) && boatWater(this.get, b).level > b.y ? BF.WATER : 0);
    this.touch(b);
    this.onMoved(b);
  }

  /** Put a boat somewhere (a correction): everyone near is told, its riders go with it. */
  setPos(b: Boat, x: number, y: number, z: number, yaw: number): void {
    b.x = x;
    b.y = y;
    b.z = z;
    b.yaw = yaw;
    b.vx = b.vy = b.vz = 0;
    b.dyaw = 0;
    b.version++;
    this.touch(b);
    this.onMoved(b);
  }

  private touch(b: Boat): void {
    const key = `${Math.round(b.x * 128)},${Math.round(b.y * 256)},${Math.round(b.z * 128)},${Math.round(b.yaw * 2)},${b.flags}`;
    if (key !== b.key) {
      b.key = key;
      b.version++;
      this.dirty = true;
    }
  }

  /** 20 Hz: hits fade, boats nobody rows float and drift (only while a player is near). */
  tick(players: { x: number; z: number }[], tick: number): void {
    const now = Date.now();
    for (const b of this.boats.values()) {
      if (b.dmg > 0) b.dmg = Math.max(0, b.dmg - 1);
      if (b.hurtUntil && tick >= b.hurtUntil) {
        b.hurtUntil = 0;
        b.flags &= ~BF.HURT;
        this.touch(b);
      }
      if (this.driven(b, now)) continue;
      if (!players.some((p) => (p.x - b.x) ** 2 + (p.z - b.z) ** 2 < WAKE_RANGE * WAKE_RANGE)) continue;
      tickBoat(b, null, this.get);
      if (b.y < -5) {
        this.remove(b.id);
        continue;
      }
      b.flags = (b.flags & BF.HURT) | (b.status === BS.WATER || b.status === BS.UNDER ? BF.WATER : 0);
      this.touch(b);
      if (b.riders.length) this.onMoved(b);
    }
  }

  messages(p: { x: number; z: number }, seen: Seen, tick: number): Uint8Array[] {
    const out: Uint8Array[] = [];
    const list: BoatSnap[] = [];
    const gone: number[] = [];
    for (const b of this.boats.values()) {
      const dx = b.x - p.x;
      const dz = b.z - p.z;
      const d2 = dx * dx + dz * dz;
      const last = seen.get(b.id);
      if (d2 > BOAT_RANGE_OUT * BOAT_RANGE_OUT) {
        if (last !== undefined) {
          gone.push(b.id);
          seen.delete(b.id);
        }
        continue;
      }
      if (d2 > BOAT_RANGE * BOAT_RANGE && last === undefined) continue;
      if (last === b.version) continue;
      if (last !== undefined && d2 > 48 * 48 && tick % 4 !== 0) continue;
      list.push({ id: b.id, x: b.x, y: b.y, z: b.z, yaw: b.yaw, flags: b.flags });
      seen.set(b.id, b.version);
    }
    for (const id of this.removed) if (seen.delete(id)) gone.push(id);
    if (list.length) out.push(encodeBoats(tick, list));
    if (gone.length) out.push(encodeGone(gone, OP_BOATS_GONE));
    return out;
  }

  flushRemoved(): void {
    this.removed.length = 0;
  }

  /** Where a rider gets out: beside the boat on the ground if there is room, else beside it in the water, else on
   *  top of it. Returns feet coordinates. */
  exitSpot(b: Boat, fits: (x: number, y: number, z: number) => boolean): { x: number; y: number; z: number } {
    const r = (b.yaw * Math.PI) / 180;
    const fx = -Math.sin(r);
    const fz = Math.cos(r);
    const sides: [number, number][] = [
      [fz * 1.3, -fx * 1.3], [-fz * 1.3, fx * 1.3], [fx * 1.6, fz * 1.6], [-fx * 1.6, -fz * 1.6],
      [fz * 1.3 + fx * 1.2, -fx * 1.3 + fz * 1.2], [-fz * 1.3 + fx * 1.2, fx * 1.3 + fz * 1.2],
      [fz * 1.3 - fx * 1.2, -fx * 1.3 - fz * 1.2], [-fz * 1.3 - fx * 1.2, fx * 1.3 - fz * 1.2],
      [fz * 2.3, -fx * 2.3], [-fz * 2.3, fx * 2.3],
    ];
    const by = Math.floor(b.y);
    for (const ground of [true, false])
      for (const [dx, dz] of sides) {
        const x = b.x + dx;
        const z = b.z + dz;
        if (x < 0.5 || z < 0.5 || x > WORLD_SIZE - 0.5 || z > WORLD_SIZE - 0.5) continue;
        for (const y of [by + 1, by, by + 2, by - 1]) {
          if (!fits(x, y, z)) continue;
          if (ground && !SOLID[this.get(Math.floor(x), y - 1, Math.floor(z))]) continue;
          return { x, y, z };
        }
      }
    return { x: b.x, y: b.y + BOAT_H, z: b.z };
  }

  /** Can a boat be put down at this spot (it fits, and it is on water or ground)? */
  canPlace(x: number, y: number, z: number): boolean {
    return boatFits(this.get, x, y, z) && this.supported({ x, y, z });
  }

  seatOf(b: Boat, playerId: number): { x: number; y: number; z: number } {
    const k = Math.max(0, b.riders.indexOf(playerId));
    return seatPos(b, k, b.riders.length);
  }

  save(): void {
    this.dirty = false;
    const list = [...this.boats.values()].map((b) => ({ x: +b.x.toFixed(3), y: +b.y.toFixed(3), z: +b.z.toFixed(3), yaw: +b.yaw.toFixed(1) }));
    try {
      writeFileSync(this.path + ".tmp", JSON.stringify(list));
      renameSync(this.path + ".tmp", this.path);
    } catch {
      /* disk issues should not stop the game */
    }
  }

  load(): void {
    if (!existsSync(this.path)) return;
    try {
      const list = JSON.parse(readFileSync(this.path, "utf8")) as { x: number; y: number; z: number; yaw: number }[];
      for (const s of list) {
        if (![s.x, s.y, s.z, s.yaw].every(Number.isFinite)) continue;
        if (s.x < 1 || s.z < 1 || s.x > WORLD_SIZE - 1 || s.z > WORLD_SIZE - 1 || s.y < 1) continue;
        this.spawn(s.x, s.y, s.z, s.yaw);
      }
    } catch {
      /* a broken file means no boats */
    }
  }

  clear(): void {
    for (const id of [...this.boats.keys()]) this.remove(id);
  }
}
