// Dropped items for one shard (protocol v5). The server owns them: physics at 20 Hz (they fall, slide, float up in
// water), nearby stacks of the same item merge, players pick them up by walking over them (after a short delay),
// and they disappear after 5 minutes. Only the items near a player are sent to them, and only when they move.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WORLD_SIZE } from "../../shared/constants.ts";
import { ITEM_DESPAWN, ITEM_RANGE, ITEM_RANGE_OUT, OP_ITEMS_GONE, PICKUP_DELAY, encodeIds, encodeItems, encodePickups, type ItemSnap } from "../../shared/drops.ts";
import { fromWire, maxStack, sameItem, toWire, type Stack } from "../../shared/items.ts";
import { bodyInWater, bodyInsideSolid, moveBody, type Body, type GetBlock } from "../../shared/physics.ts";

export interface ItemEntity extends Body {
  id: number;
  st: Stack;
  age: number;
  delay: number; // ticks before it can be picked up
  thrower: string; // player key that threw it (they wait longer to catch it back)
  key: number;
  version: number;
  resting: number; // ticks at rest (skips physics)
}

/** What a player looks like to the item manager. */
export interface Picker {
  id: number;
  key: string;
  x: number;
  y: number;
  z: number;
  alive: boolean;
}

export type Seen = Map<number, number>;

export const SHARD_ITEM_CAP = 3000;

export class ItemManager {
  readonly items = new Map<number, ItemEntity>();
  private nextId = 1;
  private get: GetBlock;
  private path: string;
  private removed: number[] = [];
  private pickups: [number, number][] = [];

  constructor(get: GetBlock, dir: string) {
    this.get = get;
    this.path = join(dir, "items.json");
  }

  /** Drop a stack at a point with a velocity (blocks per tick). Splits stacks over the max. */
  spawn(st: Stack, x: number, y: number, z: number, vx = 0, vy = 0.2, vz = 0, delay = PICKUP_DELAY, thrower = ""): void {
    let left = st.n;
    while (left > 0) {
      const n = Math.min(left, maxStack(st.id));
      left -= n;
      if (this.items.size >= SHARD_ITEM_CAP) this.removeOldest();
      let id = this.nextId;
      for (let k = 0; k < 65535 && this.items.has(id); k++) id = (id % 65534) + 1;
      this.nextId = (id % 65534) + 1;
      const e: ItemEntity = {
        id, st: { id: st.id, n, d: st.d }, x, y, z, vx, vy, vz, hw: 0.125, h: 0.25, onGround: false, collidedH: false,
        age: 0, delay, thrower, key: -1, version: 1, resting: 0,
      };
      this.items.set(id, e);
    }
  }

  /** Scatter drops the way a broken block does: from the block's centre, a small random pop. */
  dropAt(st: Stack, x: number, y: number, z: number): void {
    this.spawn(st, x + 0.25 + Math.random() * 0.5, y + 0.25 + Math.random() * 0.4, z + 0.25 + Math.random() * 0.5, (Math.random() - 0.5) * 0.1, 0.2, (Math.random() - 0.5) * 0.1);
  }

  private removeOldest(): void {
    let oldest: ItemEntity | null = null;
    for (const e of this.items.values()) if (!oldest || e.age > oldest.age) oldest = e;
    if (oldest) this.remove(oldest.id);
  }

  remove(id: number): void {
    if (this.items.delete(id)) this.removed.push(id);
  }

  clear(): void {
    for (const id of [...this.items.keys()]) this.remove(id);
  }

  /** Physics, merging, despawning and pickups. `give` adds to a player's inventory and returns what didn't fit. */
  tick(players: Picker[], give: (p: Picker, st: Stack) => number, tick: number): void {
    for (const e of this.items.values()) {
      e.age++;
      if (e.delay > 0) e.delay--;
      if (e.age >= ITEM_DESPAWN || e.y < -8) {
        this.remove(e.id);
        continue;
      }
      if (e.resting > 20 && tick % 20 !== e.id % 20) continue; // settled items wake up once a second
      this.physics(e);
    }
    if (tick % 10 === 0) this.merge();
    // pickups: the player's box, grown by 1 sideways and 0.5 up and down (like Java); items bucketed in 8x8 cells
    if (!players.length || !this.items.size) return;
    const grid = new Map<number, ItemEntity[]>();
    for (const e of this.items.values()) {
      const k = (Math.floor(e.x) >> 3) * 1024 + (Math.floor(e.z) >> 3);
      const l = grid.get(k);
      if (l) l.push(e);
      else grid.set(k, [e]);
    }
    for (const p of players) {
      if (!p.alive) continue;
      const near: ItemEntity[] = [];
      const cx = Math.floor(p.x) >> 3;
      const cz = Math.floor(p.z) >> 3;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) near.push(...(grid.get((cx + a) * 1024 + cz + b) ?? []));
      for (const e of near) {
        if (!this.items.has(e.id)) continue;
        if (e.delay > 0 && !(e.thrower && e.thrower !== p.key && e.delay <= 30)) continue;
        if (Math.abs(e.x - p.x) > 1.3 || Math.abs(e.z - p.z) > 1.3) continue;
        if (e.y + e.h < p.y - 0.5 || e.y > p.y + 1.8 + 0.5) continue;
        const left = give(p, e.st);
        if (left >= e.st.n) continue;
        if (left > 0) {
          e.st = { ...e.st, n: left };
          e.version++;
        } else {
          this.pickups.push([e.id, p.id]);
          this.remove(e.id);
        }
      }
    }
  }

  private physics(e: ItemEntity): void {
    const inWater = bodyInWater(this.get, e);
    if (inWater) {
      e.vy = Math.min(0.06, e.vy + 0.012);
      e.vx *= 0.9;
      e.vz *= 0.9;
    } else {
      e.vy -= 0.04;
    }
    const before = e.x + e.y * 7 + e.z * 13;
    moveBody(this.get, e, e.vx, e.vy, e.vz);
    e.vy *= 0.98;
    const f = e.onGround ? 0.6 * 0.98 : 0.98;
    e.vx *= f;
    e.vz *= f;
    if (Math.abs(e.vx) < 0.001) e.vx = 0;
    if (Math.abs(e.vz) < 0.001) e.vz = 0;
    // pushed out of blocks that appear around it
    for (let k = 0; k < 3 && bodyInsideSolid(this.get, e, 0.02); k++) e.y = Math.floor(e.y) + 1;
    e.x = Math.max(0.2, Math.min(WORLD_SIZE - 0.2, e.x));
    e.z = Math.max(0.2, Math.min(WORLD_SIZE - 0.2, e.z));
    const after = e.x + e.y * 7 + e.z * 13;
    e.resting = Math.abs(after - before) < 1e-4 && e.onGround ? e.resting + 1 : 0;
    const key = ((Math.round(e.x * 64) * 73856093) ^ (Math.round(e.y * 64) * 19349663) ^ (Math.round(e.z * 64) * 83492791)) | 0;
    if (key !== e.key) {
      e.key = key;
      e.version++;
    }
  }

  /** Stacks of the same item within half a block merge into the older one (up to the stack size). */
  private merge(): void {
    const list = [...this.items.values()];
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!this.items.has(a.id) || a.st.n >= maxStack(a.st.id)) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!this.items.has(b.id) || !sameItem(a.st, b.st)) continue;
        if (Math.abs(a.x - b.x) > 0.75 || Math.abs(a.z - b.z) > 0.75 || Math.abs(a.y - b.y) > 0.5) continue;
        const [keep, drop] = a.age >= b.age ? [a, b] : [b, a];
        const room = maxStack(keep.st.id) - keep.st.n;
        if (room <= 0) continue;
        const k = Math.min(room, drop.st.n);
        keep.st = { ...keep.st, n: keep.st.n + k };
        keep.version++;
        if (drop.st.n - k <= 0) this.remove(drop.id);
        else {
          drop.st = { ...drop.st, n: drop.st.n - k };
          drop.version++;
        }
        if (keep === b) break;
      }
    }
  }

  /** What to send one player this tick: changed items in range, gone ones, and pickup animations. */
  messages(p: { x: number; z: number }, seen: Seen, tick: number): Uint8Array[] {
    const out: Uint8Array[] = [];
    const list: ItemSnap[] = [];
    const gone: number[] = [];
    for (const e of this.items.values()) {
      const dx = e.x - p.x;
      const dz = e.z - p.z;
      const d2 = dx * dx + dz * dz;
      const last = seen.get(e.id);
      if (d2 > ITEM_RANGE_OUT * ITEM_RANGE_OUT) {
        if (last !== undefined) {
          gone.push(e.id);
          seen.delete(e.id);
        }
        continue;
      }
      if (d2 > ITEM_RANGE * ITEM_RANGE && last === undefined) continue;
      if (last === e.version) continue;
      list.push({ id: e.id, item: e.st.id, n: e.st.n, x: e.x, y: e.y, z: e.z });
      seen.set(e.id, e.version);
    }
    for (const id of this.removed) if (seen.delete(id)) gone.push(id);
    if (list.length) out.push(encodeItems(tick, list));
    if (gone.length) out.push(encodeIds(OP_ITEMS_GONE, gone));
    return out;
  }

  /** Pickup animations since the last flush (sent to everyone near). */
  pickupMessage(): Uint8Array | null {
    return this.pickups.length ? encodePickups(this.pickups) : null;
  }

  flush(): void {
    this.removed.length = 0;
    this.pickups.length = 0;
  }

  save(): void {
    const list = [...this.items.values()].map((e) => ({ s: toWire(e.st), x: +e.x.toFixed(2), y: +e.y.toFixed(2), z: +e.z.toFixed(2), a: e.age }));
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
      const list = JSON.parse(readFileSync(this.path, "utf8")) as { s: unknown; x: number; y: number; z: number; a: number }[];
      for (const r of list) {
        const st = fromWire(r.s);
        if (!st || ![r.x, r.y, r.z].every(Number.isFinite)) continue;
        this.spawn(st, r.x, r.y, r.z, 0, 0, 0, 0);
        const e = [...this.items.values()].pop();
        if (e) e.age = Math.max(0, Math.min(ITEM_DESPAWN - 1, r.a | 0));
      }
    } catch {
      /* a broken file just means no items */
    }
  }

  /** Total of every item on the ground (anti-dupe tests). */
  totals(): Map<string, number> {
    const m = new Map<string, number>();
    for (const e of this.items.values()) {
      const k = `${e.st.id}:${e.st.d}`;
      m.set(k, (m.get(k) ?? 0) + e.st.n);
    }
    return m;
  }
}
