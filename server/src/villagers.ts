// The villagers of one shard (update 11, protocol v9): five to a village (shared/villages.ts), one per house and job.
// The server runs them at 20 Hz like the animals (server/src/animals.ts: real paths, the same walk physics) and
// streams them the same way (encodeAnimals with OP_VILLAGERS, job as the kind).
//   - By day they wander their village: the plaza, the roads, their own front door. They never leave its square.
//   - At night (and in the evening) they walk home, through the door, and stay in until morning. Doors open as they
//     reach them and close behind them (the door cell only: a server change, not a player's edit).
//   - Someone trading with one: it stops and faces them. Poked: a flinch, no damage (villagers can't be hurt, so a
//     village always has its traders). Night mobs never target them (mobs only hunt players).
//   - A broken house still works: no path home, and it stands by its door instead; inside a block, it steps out.
// Far from every player they don't think at all; out of sight, one that is in the wrong place for the time of day
// (out at night, at home by day) is simply put where it should be.
// Their trade stock (shared/trades.ts) is kept in WORLD_DIR/shard-N/villagers.json and comes back in full every
// 10 minutes.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SOLID } from "../../shared/blocks.ts";
import { encodeAnimals, encodeGone, cellHitsAnimal, type AnimalSnap } from "../../shared/animals.ts";
import { WORLD_HEIGHT, WORLD_SIZE, idx } from "../../shared/constants.ts";
import { DRAG_Y, GRAVITY, JUMP_VELOCITY, bodyInWater, bodyInsideSolid, boxHitsSolid, moveBody, solidAt, type Body, type GetBlock } from "../../shared/physics.ts";
import { door, doorId, isDoor } from "../../shared/shapes.ts";
import { RESTOCK_MS, TRADES, fullStock, tradeOnce, wireOffers, type WireOffer } from "../../shared/trades.ts";
import { OP_VILLAGERS, OP_VILLAGERS_GONE, VF, VILLAGER_H, VILLAGER_RANGE, VILLAGER_RANGE_OUT, VILLAGER_W } from "../../shared/villagers.ts";
import { VILLAGE_R, type VillageInfo, type VillagerDef } from "../../shared/villages.ts";
import type { Items } from "../../shared/inventory.ts";
import { PathFinder, STEP, type PathPoint } from "./pathfind.ts";

const SLEEP_RANGE = 128;
const SNAP_RANGE = 64; // no player this close: a villager in the wrong place is just put right
const WALK = 0.06;
const HURRY = 0.085;
const REST_VY = -GRAVITY * DRAG_Y;
/** Evening to dawn (world time): indoors. A little before the mobs come out, a little after they burn. */
export const HOME_FROM = 12000;
export const HOME_UNTIL = 23500;
export const isHomeTime = (t: number) => t >= HOME_FROM && t < HOME_UNTIL;

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const randi = (a: number, b: number) => Math.floor(rand(a, b + 1));
const wrap = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

export interface Villager extends Body {
  id: number;
  def: VillagerDef;
  job: number;
  village: VillageInfo;
  yaw: number;
  state: "idle" | "walk";
  timer: number;
  path: PathPoint[] | null;
  pi: number;
  goal: "home" | "out" | null;
  prog: number;
  px: number;
  py: number;
  pz: number;
  stuck: number;
  fails: number; // paths home that could not be found (a broken house): stand by the door instead
  jumpCool: number;
  climb: number;
  inWater: boolean;
  hurt: number;
  flags: number;
  key: number;
  version: number;
  talkers: Map<number, { x: number; z: number }>; // player id -> where they stand
  stock: number[];
}

export interface Viewer {
  id: number;
  x: number;
  y: number;
  z: number;
}

export type Seen = Map<number, number>;

export class VillagerManager {
  readonly villagers = new Map<number, Villager>();
  private get: GetBlock;
  /** The world as villagers see it: doors are no obstacle (they open them on the way; a doorway is only a block
   *  wide, and an open door's panel would leave them a hair's width). */
  private vget: GetBlock;
  private pf: PathFinder;
  private path: string;
  private streets = new Map<number, [number, number][]>(); // village site -> road and plaza cells
  private removed: number[] = [];
  private opened = new Map<number, number>(); // a door's lower cell -> the tick it may close
  restockAt = 0;
  dirty = false;
  /** Opens or closes a door (both halves) in the real world: the shard's server change. */
  setDoor: (x: number, y: number, z: number, lowerId: number) => void = () => {};

  constructor(get: GetBlock, dir: string, villages: VillageInfo[]) {
    this.get = get;
    this.vget = (x, y, z) => {
      const id = get(x, y, z);
      return isDoor(id) ? 0 : id;
    };
    this.pf = new PathFinder(this.vget);
    this.path = join(dir, "villagers.json");
    for (const v of villages) {
      const cells: [number, number][] = [];
      for (let k = -VILLAGE_R + 2; k <= VILLAGE_R - 2; k++)
        for (let w = -1; w <= 1; w++) {
          if (Math.abs(k) <= 5) continue;
          cells.push([v.x + w, v.z + k], [v.x + k, v.z + w]);
        }
      for (let dz = -5; dz <= 5; dz++) for (let dx = -5; dx <= 5; dx++) if (Math.max(Math.abs(dx), Math.abs(dz)) >= 3 && Math.max(Math.abs(dx), Math.abs(dz)) <= 4) cells.push([v.x + dx, v.z + dz]);
      this.streets.set(v.site, cells);
      for (const d of v.villagers) this.add(d, v);
    }
    this.restockAt = Date.now() + RESTOCK_MS;
  }

  private add(d: VillagerDef, v: VillageInfo): void {
    const [x, y, z] = d.work;
    const p: Villager = {
      id: d.id, def: d, job: d.job, village: v, x: x + 0.5, y, z: z + 0.5, yaw: rand(-180, 180), vx: 0, vy: 0, vz: 0,
      hw: VILLAGER_W / 2, h: VILLAGER_H, onGround: false, collidedH: false, state: "idle", timer: randi(20, 100), path: null,
      pi: 0, goal: null, prog: 0, px: x, py: y, pz: z, stuck: 0, fails: 0, jumpCool: 0, climb: 0, inWater: false, hurt: 0,
      flags: 0, key: -1, version: 1, talkers: new Map(), stock: fullStock(d.job),
    };
    this.villagers.set(d.id, p);
  }

  // ---------------------------------------------------------------- persistence

  load(time: number): void {
    if (existsSync(this.path)) {
      try {
        const j = JSON.parse(readFileSync(this.path, "utf8")) as { restockAt?: number; list?: { id: number; stock: number[]; x?: number; y?: number; z?: number }[] };
        if (Number.isFinite(j.restockAt)) this.restockAt = j.restockAt!;
        for (const s of j.list ?? []) {
          const v = this.villagers.get(s.id);
          if (!v || !Array.isArray(s.stock)) continue;
          const max = fullStock(v.job);
          v.stock = max.map((m, k) => Math.max(0, Math.min(m, Math.floor(Number(s.stock[k]) || 0))));
          if ([s.x, s.y, s.z].every(Number.isFinite) && Math.abs(s.x! - v.village.x) <= VILLAGE_R + 2 && Math.abs(s.z! - v.village.z) <= VILLAGE_R + 2 && s.y! > 0 && s.y! < WORLD_HEIGHT) {
            v.x = s.x!;
            v.y = s.y!;
            v.z = s.z!;
          }
        }
      } catch {
        /* a broken file: full stock, everyone at their door */
      }
    }
    for (const v of this.villagers.values()) {
      this.place(v, isHomeTime(time));
      if (bodyInsideSolid(this.vget, v)) this.place(v, isHomeTime(time), true);
    }
    this.maybeRestock();
  }

  save(): void {
    const list = [...this.villagers.values()].map((v) => ({ id: v.id, stock: v.stock, x: +v.x.toFixed(2), y: +v.y.toFixed(2), z: +v.z.toFixed(2) }));
    try {
      writeFileSync(this.path + ".tmp", JSON.stringify({ restockAt: this.restockAt, list }));
      renameSync(this.path + ".tmp", this.path);
      this.dirty = false;
    } catch {
      /* disk issues should not stop the game */
    }
  }

  /** Every 10 minutes: every offer's stock back in full. */
  maybeRestock(now = Date.now()): boolean {
    if (now < this.restockAt) return false;
    for (const v of this.villagers.values()) v.stock = fullStock(v.job);
    this.restockAt = now + RESTOCK_MS;
    this.dirty = true;
    return true;
  }

  /** Put a villager where it belongs now (out of sight): at home at night, by its door by day. */
  private place(v: Villager, night: boolean, force = false): void {
    const spot = night ? v.def.home : v.def.work;
    const inVillage = Math.abs(v.x - v.village.x) <= VILLAGE_R && Math.abs(v.z - v.village.z) <= VILLAGE_R;
    if (!force && inVillage && !night) return;
    const cand: [number, number, number][] = [spot, v.def.work, v.def.home];
    for (const [x, y, z] of cand) {
      for (let dy = 0; dy < 4; dy++) {
        const b = { ...v, x: x + 0.5, y: y + dy, z: z + 0.5 };
        if (!bodyInsideSolid(this.vget, b) && boxHitsSolid(this.vget, b.x - b.hw, b.y - 0.1, b.z - b.hw, b.x + b.hw, b.y, b.z + b.hw)) {
          v.x = b.x;
          v.y = b.y;
          v.z = b.z;
          v.vx = v.vy = v.vz = 0;
          v.path = null;
          v.state = "idle";
          v.goal = night ? "home" : null;
          return;
        }
      }
    }
  }

  // ---------------------------------------------------------------- interaction

  /** Does any villager's box overlap this block cell? (No placing blocks inside villagers.) */
  blocksCell(x: number, y: number, z: number): boolean {
    for (const v of this.villagers.values()) {
      if (Math.abs(v.x - x - 0.5) > 2 || Math.abs(v.z - z - 0.5) > 2) continue;
      if (cellHitsAnimal(x, y, z, v.x, v.y, v.z, VILLAGER_W, VILLAGER_H)) return true;
    }
    return false;
  }

  /** Poked by a player: a flinch and a little step back, facing them. No damage: villagers can't be hurt. */
  poke(v: Villager, fromX: number, fromZ: number): void {
    if (v.hurt > 0) return;
    v.hurt = 10;
    const dx = v.x - fromX;
    const dz = v.z - fromZ;
    const d = Math.hypot(dx, dz) || 1;
    v.vx += (dx / d) * 0.2;
    v.vz += (dz / d) * 0.2;
    v.vy = Math.max(v.vy, 0.2);
    v.yaw = (Math.atan2(dx, -dz) * 180) / Math.PI;
  }

  startTalk(v: Villager, playerId: number, x: number, z: number): void {
    v.talkers.set(playerId, { x, z });
    v.path = null;
    v.state = "idle";
  }

  endTalk(v: Villager, playerId: number): void {
    v.talkers.delete(playerId);
  }

  offers(v: Villager): WireOffer[] {
    return wireOffers(v.job, v.stock);
  }

  /** Trade offer `k` once (or, `all`, as many times as stock, the cost and room allow) on an inventory. Returns how
   *  many trades happened (0: none, and the inventory is unchanged). */
  trade(v: Villager, k: number, inv: Items, all: boolean): number {
    const o = TRADES[v.job]?.[k];
    if (!o) return 0;
    let n = 0;
    const most = all ? 64 : 1;
    while (n < most && v.stock[k] > 0 && tradeOnce(inv, o)) {
      v.stock[k]--;
      n++;
    }
    if (n) this.dirty = true;
    return n;
  }

  // ---------------------------------------------------------------- the day

  tick(players: Viewer[], time: number, tick: number): void {
    const night = isHomeTime(time);
    for (const v of this.villagers.values()) {
      let near2 = Infinity;
      for (const p of players) {
        const d2 = (p.x - v.x) ** 2 + (p.z - v.z) ** 2;
        if (d2 < near2) near2 = d2;
      }
      if (near2 > SNAP_RANGE * SNAP_RANGE) {
        // out of sight: put it where it belongs
        const home = Math.hypot(v.x - v.def.home[0] - 0.5, v.z - v.def.home[2] - 0.5) < 1.5;
        if ((night && !home) || (!night && home)) {
          this.place(v, night, true);
          this.changed(v);
        }
        if (near2 > SLEEP_RANGE * SLEEP_RANGE) continue;
      }
      this.think(v, night, players);
      this.physics(v);
      this.doors(v, tick);
    }
    if (tick % 10 === 0) this.closeDoors(tick);
    if (tick % 200 === 0) this.maybeRestock();
  }

  private think(v: Villager, night: boolean, players: Viewer[]): void {
    if (v.hurt > 0) v.hurt--;
    if (v.jumpCool > 0) v.jumpCool--;
    if (v.climb > 0) v.climb--;
    v.timer--;
    // trading: stand still, face the (first) customer
    if (v.talkers.size) {
      for (const id of [...v.talkers.keys()]) {
        const p = players.find((q) => q.id === id);
        if (!p) v.talkers.delete(id);
        else v.talkers.set(id, { x: p.x, z: p.z });
      }
      const t = v.talkers.values().next().value;
      if (t) {
        v.yaw = wrap(v.yaw + Math.max(-25, Math.min(25, wrap((Math.atan2(-(t.x - v.x), t.z - v.z) * 180) / Math.PI - v.yaw))));
        v.path = null;
        v.state = "idle";
        this.brake(v);
        return;
      }
    }
    const [hx, , hz] = v.def.home;
    const atHome = Math.hypot(v.x - hx - 0.5, v.z - hz - 0.5) < 0.9;
    if (night) {
      if (v.goal !== "home") {
        v.goal = "home";
        v.fails = 0;
        v.path = null;
      }
      if (!atHome && !v.path && v.timer <= 0) {
        // home (or, if the way is broken, its own doorstep)
        const ok = v.fails < 3 ? this.walkTo(v, hx + 0.5, hz + 0.5) : this.walkTo(v, v.def.work[0] + 0.5, v.def.work[2] + 0.5);
        if (!ok) v.fails++;
        v.timer = ok ? randi(20, 40) : randi(60, 120);
      }
      if (atHome && !v.path) {
        this.brake(v);
        if (Math.random() < 1 / 120) v.yaw = wrap(v.yaw + rand(-60, 60));
        return;
      }
    } else {
      if (v.goal === "home") {
        // morning: out of the house
        v.goal = "out";
        v.path = null;
        v.timer = randi(0, 100);
      }
      if (!v.path && v.timer <= 0) {
        const r = Math.random();
        if (r < 0.35) {
          v.timer = randi(60, 200); // stand about
          // and look at whoever is near
          let best: Viewer | null = null;
          let bd = 36;
          for (const p of players) {
            const d2 = (p.x - v.x) ** 2 + (p.z - v.z) ** 2;
            if (d2 < bd) {
              bd = d2;
              best = p;
            }
          }
          if (best) v.yaw = (Math.atan2(-(best.x - v.x), best.z - v.z) * 180) / Math.PI;
        } else {
          const cells = this.streets.get(v.village.site)!;
          const [tx, tz] = r < 0.6 ? [v.def.work[0], v.def.work[2]] : cells[randi(0, cells.length - 1)];
          if (!this.walkTo(v, tx + 0.5, tz + 0.5)) v.timer = randi(40, 100);
          else v.timer = randi(40, 160);
          v.goal = null;
        }
      }
    }
    if (v.path) {
      this.follow(v, night ? HURRY : WALK);
      this.checkStuck(v);
    } else this.brake(v);
  }

  private brake(v: Villager): void {
    if (v.onGround) {
      v.vx *= 0.5;
      v.vz *= 0.5;
    }
  }

  walkTo(v: Villager, x: number, z: number): boolean {
    const r = Math.ceil(Math.max(Math.abs(x - v.x), Math.abs(z - v.z))) + 4;
    const s = this.pf.search(v.x, v.y, v.z, { hw: v.hw, h: v.h, maxNodes: 4000, radius: Math.min(r, 48), water: false, aim: true }, { x: Math.floor(x), z: Math.floor(z) });
    if (!s) return false;
    const end = s.reached >= 0 ? s.reached : -1;
    if (end <= 0) return false;
    const path = s.pathTo(end);
    // never out of the village's square
    if (path.some((q) => Math.abs(q.x + 0.5 - v.village.x) > VILLAGE_R + 1 || Math.abs(q.z + 0.5 - v.village.z) > VILLAGE_R + 1)) return false;
    v.path = path;
    v.pi = 0;
    v.prog = 0;
    v.px = v.x;
    v.py = v.y;
    v.pz = v.z;
    v.state = "walk";
    return true;
  }

  private follow(v: Villager, speed: number): void {
    const path = v.path!;
    let wp = path[v.pi];
    let dx = wp.x + 0.5 - v.x;
    let dz = wp.z + 0.5 - v.z;
    let d = Math.hypot(dx, dz);
    const last = v.pi === path.length - 1;
    // through a doorway: right through its middle (no cutting the corner of the wall)
    const tight = isDoor(this.get(wp.x, Math.floor(wp.f + 0.01), wp.z)) || (v.pi > 0 && isDoor(this.get(path[v.pi - 1].x, Math.floor(path[v.pi - 1].f + 0.01), path[v.pi - 1].z)));
    if (d < (last ? 0.3 : tight ? 0.2 : 0.55) && v.y > wp.f - 0.45 && (v.onGround || last)) {
      v.pi++;
      if (v.pi >= path.length) {
        v.path = null;
        v.state = "idle";
        v.timer = randi(40, 160);
        v.vx *= 0.4;
        v.vz *= 0.4;
        return;
      }
      wp = path[v.pi];
      dx = wp.x + 0.5 - v.x;
      dz = wp.z + 0.5 - v.z;
      d = Math.hypot(dx, dz);
    }
    const heading = (Math.atan2(-dx, dz) * 180) / Math.PI;
    v.yaw = wrap(v.yaw + Math.max(-30, Math.min(30, wrap(heading - v.yaw))));
    const off = Math.abs(wrap(heading - v.yaw));
    const k = off > 80 ? 0.2 : off > 40 ? 0.6 : 1;
    const mx = d > 1e-6 ? dx / d : 0;
    const mz = d > 1e-6 ? dz / d : 0;
    const control = v.onGround ? 1 : v.inWater ? 0.5 : v.climb > 0 ? 0.35 : 0.15;
    v.vx += (mx * speed * k - v.vx) * control;
    v.vz += (mz * speed * k - v.vz) * control;
    const rise = wp.f - v.y;
    if (rise > STEP - 0.05 && v.jumpCool === 0 && v.onGround && (v.collidedH || d < v.hw + 0.85)) this.jump(v);
    else if (v.collidedH && v.onGround && v.jumpCool === 0 && this.climbable(v, mx, mz)) this.jump(v);
  }

  private jump(v: Villager): void {
    v.vy = JUMP_VELOCITY;
    v.jumpCool = 8;
    v.climb = 10;
  }

  private climbable(v: Villager, mx: number, mz: number): boolean {
    const feet = Math.floor(v.y + 0.01);
    const cells: [number, number][] = [];
    if (Math.abs(mx) > 0.2) {
      const cx = Math.floor(v.x + Math.sign(mx) * (v.hw + 0.2));
      cells.push([cx, Math.floor(v.z - v.hw + 0.01)], [cx, Math.floor(v.z + v.hw - 0.01)]);
    }
    if (Math.abs(mz) > 0.2) {
      const cz = Math.floor(v.z + Math.sign(mz) * (v.hw + 0.2));
      cells.push([Math.floor(v.x - v.hw + 0.01), cz], [Math.floor(v.x + v.hw - 0.01), cz]);
    }
    let step = false;
    for (const [cx, cz] of cells) {
      if (!solidAt(this.vget, cx, feet, cz)) continue;
      for (let k = 1; k <= 2; k++) if (solidAt(this.vget, cx, feet + k, cz)) return false;
      step = true;
    }
    if (!step) return false;
    return !boxHitsSolid(this.vget, v.x - v.hw, v.y + v.h, v.z - v.hw, v.x + v.hw, v.y + v.h + 1.1, v.z + v.hw);
  }

  private checkStuck(v: Villager): void {
    if (++v.prog < 20) return;
    const moved = Math.hypot(v.x - v.px, v.z - v.pz) + Math.abs(v.y - v.py);
    v.prog = 0;
    v.px = v.x;
    v.py = v.y;
    v.pz = v.z;
    if (moved > 0.3) {
      v.stuck = 0;
      return;
    }
    if (++v.stuck >= 2) {
      // re-plan once toward the same end, then give up and stand
      const end = v.path?.[v.path.length - 1];
      v.path = null;
      v.state = "idle";
      v.timer = randi(20, 60);
      v.stuck = 0;
      if (end && v.goal === "home") v.fails++;
      if (end && Math.random() < 0.5) this.walkTo(v, end.x + 0.5, end.z + 0.5);
    }
  }

  private physics(v: Villager): void {
    v.inWater = bodyInWater(this.vget, v);
    if (v.inWater) {
      v.vy += 0.04;
      moveBody(this.vget, v, v.vx, v.vy, v.vz);
      v.vx *= 0.8;
      v.vz *= 0.8;
      v.vy = v.vy * 0.8 - 0.02;
    } else if (v.onGround && Math.abs(v.vx) < 0.002 && Math.abs(v.vz) < 0.002 && v.vy <= 0 && v.hurt === 0) {
      v.vx = v.vz = 0;
      v.vy = REST_VY;
      if (!boxHitsSolid(this.vget, v.x - v.hw, v.y - 0.05, v.z - v.hw, v.x + v.hw, v.y, v.z + v.hw)) v.onGround = false;
    } else {
      moveBody(this.vget, v, v.vx, v.vy, v.vz);
      v.vy = (v.vy - GRAVITY) * DRAG_Y;
      if (!v.onGround) {
        v.vx *= 0.91;
        v.vz *= 0.91;
      }
    }
    for (let k = 0; k < 3 && bodyInsideSolid(this.vget, v, 0.1); k++) v.y = Math.floor(v.y) + 1;
    v.x = Math.max(v.hw + 0.01, Math.min(WORLD_SIZE - v.hw - 0.01, v.x));
    v.z = Math.max(v.hw + 0.01, Math.min(WORLD_SIZE - v.hw - 0.01, v.z));
    if (v.y < 1) this.place(v, false, true);
    this.changed(v);
  }

  /** Flags and the change key (a change bumps the version: it is sent again). */
  private changed(v: Villager): void {
    let f = 0;
    if (Math.hypot(v.vx, v.vz) > 0.01) f |= VF.MOVING;
    if (v.talkers.size) f |= VF.TALK;
    if (Math.hypot(v.x - v.def.home[0] - 0.5, v.z - v.def.home[2] - 0.5) < 1.5) f |= VF.HOME;
    if (v.onGround) f |= VF.GROUND;
    if (v.hurt > 0) f |= VF.HURT;
    v.flags = f;
    const key = ((Math.round(v.x * 32) * 73856093) ^ (Math.round(v.y * 32) * 19349663) ^ (Math.round(v.z * 32) * 83492791) ^ (Math.round((((v.yaw % 360) + 360) % 360) * (256 / 360)) << 8) ^ f) | 0;
    if (key !== v.key) {
      v.key = key;
      v.version++;
    }
  }

  // ---------------------------------------------------------------- doors

  /** A closed door in the way (the cells the body is in, and the next path node's): open it. */
  private doors(v: Villager, tick: number): void {
    if (!v.path && Math.hypot(v.vx, v.vz) < 0.005) return;
    const cells: [number, number][] = [];
    for (const ox of [-v.hw - 0.15, v.hw + 0.15]) for (const oz of [-v.hw - 0.15, v.hw + 0.15]) cells.push([Math.floor(v.x + ox), Math.floor(v.z + oz)]);
    const wp = v.path?.[v.pi];
    if (wp) cells.push([wp.x, wp.z]);
    const fy = Math.floor(v.y + 0.01);
    for (const [x, z] of cells) {
      for (const y of [fy, fy + 1]) {
        const id = this.get(x, y, z);
        if (!isDoor(id)) continue;
        const d = door(id);
        const ly = d.upper ? y - 1 : y;
        const key = idx(x, ly, z);
        if (!d.open) {
          const low = this.get(x, ly, z);
          if (!isDoor(low)) continue;
          this.setDoor(x, ly, z, doorId(door(low).facing, true, false));
          this.opened.set(key, tick + 30);
        } else if (this.opened.has(key)) this.opened.set(key, tick + 30);
      }
    }
  }

  /** Doors a villager opened close again once nobody (no villager) is in them. */
  private closeDoors(tick: number): void {
    for (const [key, due] of this.opened) {
      if (tick < due) continue;
      const x = key & (WORLD_SIZE - 1);
      const z = (key >> 9) & (WORLD_SIZE - 1);
      const y = key >> 18;
      let busy = false;
      // in the doorway (its box over the door cell), or about to be: on a path through it
      for (const v of this.villagers.values()) {
        if (Math.abs(v.y - y) >= 2) continue;
        if (Math.abs(v.x - x - 0.5) < 0.5 + v.hw + 0.05 && Math.abs(v.z - z - 0.5) < 0.5 + v.hw + 0.05) busy = true;
        const wp = v.path?.[v.pi];
        if (wp && wp.x === x && wp.z === z) busy = true;
      }
      if (busy) {
        this.opened.set(key, tick + 20);
        continue;
      }
      this.opened.delete(key);
      const id = this.get(x, y, z);
      if (isDoor(id) && door(id).open && !door(id).upper) this.setDoor(x, y, z, doorId(door(id).facing, false, false));
    }
  }

  // ---------------------------------------------------------------- sync

  messages(p: { x: number; z: number }, seen: Seen, tick: number): Uint8Array[] {
    const out: Uint8Array[] = [];
    const list: AnimalSnap[] = [];
    const gone: number[] = [];
    for (const v of this.villagers.values()) {
      const d2 = (v.x - p.x) ** 2 + (v.z - p.z) ** 2;
      const last = seen.get(v.id);
      if (d2 > VILLAGER_RANGE_OUT * VILLAGER_RANGE_OUT) {
        if (last !== undefined) {
          gone.push(v.id);
          seen.delete(v.id);
        }
        continue;
      }
      if (d2 > VILLAGER_RANGE * VILLAGER_RANGE && last === undefined) continue;
      if (last === v.version) continue;
      if (last !== undefined && d2 > 32 * 32 && tick % 4 !== 0) continue;
      list.push({ id: v.id, kind: v.job, x: v.x, y: v.y, z: v.z, yaw: v.yaw, flags: v.flags });
      seen.set(v.id, v.version);
    }
    for (const id of this.removed) if (seen.delete(id)) gone.push(id);
    if (list.length) out.push(encodeAnimals(tick, list, OP_VILLAGERS));
    if (gone.length) out.push(encodeGone(gone, OP_VILLAGERS_GONE));
    return out;
  }

  flushRemoved(): void {
    this.removed.length = 0;
  }
}

/** Is a cell somewhere a villager could stand (feet there)? (tests) */
export function standable(get: GetBlock, x: number, y: number, z: number): boolean {
  return SOLID[get(x, y - 1, z)] === 1 && !SOLID[get(x, y, z)] && !SOLID[get(x, y + 1, z)];
}

