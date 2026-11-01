// Passive animals for one shard: pigs, cows, sheep and chickens. The server owns them: it runs their AI and
// physics at 20 Hz, spawns herds on grass (capped per 64 x 64 area and per shard), keeps them across restarts, and
// streams only what changed to the players who are near (binary, ~11 bytes per animal, 5-10 Hz).
//
// Behaviour, like the classic passive mobs: stand and look around, graze or peck, and wander to a spot a few blocks
// away by a real path (server/src/pathfind.ts): they jump up one-block steps, walk around walls, never off cliffs
// or (when calm) into water, and can't jump fences. In water they paddle up and hop out at the nearest bank. When
// hit: a little knockback, a red flash, a hurt sound on every nearby client, and they run away along paths to a
// spot away from the player. Stuck (barely moved for a second while walking): they re-plan or stand still. Since
// v5 they can be killed: health per kind, a tip-over death (one second), and drops (meat, leather, wool, feathers).
// They keep out of the spawn safe zone (no herds spawn there, no paths lead in, strays walk back out). Far from
// every player they sleep (no AI, no physics, no traffic).

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { B, IS_WATER, SOLID } from "../../shared/blocks.ts";
import { AF, ANIMAL_RANGE, ANIMAL_RANGE_OUT, SPECS, cellHitsAnimal, encodeAnimals, encodeGone, type AnimalSnap } from "../../shared/animals.ts";
import { SPAWN_X, SPAWN_Z, WORLD_HEIGHT, WORLD_SIZE } from "../../shared/constants.ts";
import { SAFE_RADIUS } from "../../shared/hub.ts";
import { SafeZone } from "../../shared/hub12.ts";
import { I, type Stack } from "../../shared/items.ts";
import { DRAG_Y, GRAVITY, JUMP_VELOCITY, bodyInWater, bodyInsideSolid, boxHitsSolid, moveBody, solidAt, type Body, type GetBlock } from "../../shared/physics.ts";
import { bounded, flowAt } from "../../shared/water.ts";
import { PathFinder, STEP, type PathPoint } from "./pathfind.ts";

export const REGION = 64; // per-area cap applies to 64 x 64 squares
export const REGION_CAP = 6;
export const SHARD_CAP = 150;
export const INITIAL = 120;
const SLEEP_RANGE = 128; // no player this close: the animal sleeps
const DEG = Math.PI / 180;
const REST_VY = -GRAVITY * DRAG_Y; // the vertical speed of a body standing on the ground (Java order)

type State = "idle" | "wander" | "panic" | "goto";

export interface Animal extends Body {
  id: number;
  kind: number;
  yaw: number;
  state: State;
  timer: number;
  tx: number;
  tz: number;
  fleeX: number;
  fleeZ: number;
  hurt: number;
  eat: number;
  jumpCool: number;
  inWater: boolean;
  flags: number;
  key: number; // quantised state; a change bumps the version
  version: number;
  path: PathPoint[] | null; // nodes to walk through (wander, panic, goto)
  pi: number; // next node
  plan: number; // panic: ticks until the flee path is re-planned
  run: boolean; // goto at the panic speed
  climb: number; // ticks of extra air control after a jump (to land on the step)
  prog: number; // stuck check: ticks since the last check, and where it was then
  px: number;
  py: number;
  pz: number;
  stuck: number;
  hp: number;
  dying: number; // ticks left of the death animation (0 = alive)
}

/** Outside the spawn safe zone (where animals belong), with a margin. */
export const outsideHub = (x: number, z: number, margin = 2) => (x - SPAWN_X - 0.5) ** 2 + (z - SPAWN_Z - 0.5) ** 2 > (SAFE_RADIUS + margin) ** 2;

/** What an animal drops when killed. */
export function animalDrops(kind: number, rand: () => number = Math.random): Stack[] {
  const n = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const out: Stack[] = [];
  const add = (id: number, k: number) => {
    if (k > 0) out.push({ id, n: k, d: 0 });
  };
  if (kind === 0) add(I.PORKCHOP, n(1, 3));
  else if (kind === 1) {
    add(I.BEEF, n(1, 3));
    add(I.LEATHER, n(0, 2));
  } else if (kind === 2) {
    add(I.MUTTON, n(1, 2));
    add(B.WOOL_WHITE, 1);
  } else {
    add(I.CHICKEN, 1);
    add(I.FEATHER, n(0, 2));
  }
  return out;
}

/** What one player has been sent: animal id -> version. */
export type Seen = Map<number, number>;

export interface ViewerPos {
  x: number;
  y: number;
  z: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const randi = (a: number, b: number) => Math.floor(rand(a, b + 1));
const wrap = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

export class AnimalManager {
  readonly animals = new Map<number, Animal>();
  /** v10: the spawn safe zone (the bigger hub, less the tiles kept for players' builds: the shard sets it). */
  zone = new SafeZone();
  /** Outside the safe zone by `margin` blocks. */
  outsideHub(x: number, z: number, margin = 2): boolean {
    return this.zone.outside(x, z, margin);
  }
  private nextId = 1;
  private get: GetBlock;
  private path: string;
  private removed: number[] = [];

  private bget: GetBlock;
  private pf: PathFinder;
  /** How often an animal noticed it was stuck and re-planned (tests and the load test). */
  stuckCount = 0;
  /** Called when an animal is killed (as its death animation starts): spawn its drops. */
  onDeath: (a: Animal) => void = () => {};
  /** v7: a chicken lays an egg now and then (every 5 to 10 minutes while a player is near). */
  onEgg: (a: Animal) => void = () => {};
  private eggs = new Map<number, number>(); // chicken id -> ticks to its next egg

  constructor(get: GetBlock, dir: string) {
    this.get = get;
    this.bget = bounded(get);
    this.pf = new PathFinder(get);
    this.path = join(dir, "animals.json");
  }

  // ---------------------------------------------------------------- terrain helpers

  private block(x: number, y: number, z: number): number {
    if (x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE || y < 0 || y >= WORLD_HEIGHT) return B.AIR;
    return this.get(x, y, z);
  }

  /** Feet y on the highest standable block of a column (grass only when `grassOnly`), or -1. */
  standY(x: number, z: number, grassOnly: boolean): number {
    for (let y = WORLD_HEIGHT - 3; y > 1; y--) {
      const id = this.block(x, y, z);
      if (id === B.AIR || id === B.TALL_GRASS || id === B.DANDELION || id === B.POPPY || id === B.BLUEBELL) continue;
      if (IS_WATER[id] || id === B.OAK_LEAVES || id === B.BIRCH_LEAVES || id === B.PALM_LEAVES) return -1;
      if (grassOnly && id !== B.GRASS) return -1;
      if (!SOLID[id]) return -1;
      const a1 = this.block(x, y + 1, z);
      const a2 = this.block(x, y + 2, z);
      if (SOLID[a1] || SOLID[a2] || IS_WATER[a1]) return -1;
      return y + 1;
    }
    return -1;
  }

  /** Ground below a point: the y of the first solid block at or under `fromY` (within `depth`), else -99. */
  private groundBelow(x: number, fromY: number, z: number, depth: number): number {
    for (let y = fromY; y >= fromY - depth; y--) {
      const id = this.block(x, y, z);
      if (SOLID[id]) return y + 1;
      if (IS_WATER[id]) return -50; // water counts as a hazard for calm animals
    }
    return -99;
  }

  private regionCount(x: number, z: number): number {
    const rx = Math.floor(x / REGION);
    const rz = Math.floor(z / REGION);
    let n = 0;
    for (const a of this.animals.values()) if (Math.floor(a.x / REGION) === rx && Math.floor(a.z / REGION) === rz) n++;
    return n;
  }

  // ---------------------------------------------------------------- life cycle

  private add(kind: number, x: number, y: number, z: number, yaw = rand(0, 360)): Animal {
    let id = this.nextId;
    for (let k = 0; k < 65535 && this.animals.has(id); k++) id = (id % 65534) + 1;
    this.nextId = (id % 65534) + 1;
    const s = SPECS[kind];
    const a: Animal = {
      id, kind, x, y, z, yaw, vx: 0, vy: 0, vz: 0, hw: s.w / 2, h: s.h, onGround: false, collidedH: false,
      state: "idle", timer: randi(20, 120), tx: x, tz: z, fleeX: x, fleeZ: z, hurt: 0, eat: 0, jumpCool: 0,
      inWater: false, flags: 0, key: -1, version: 1,
      path: null, pi: 0, plan: 0, run: false, climb: 0, prog: 0, px: x, py: y, pz: z, stuck: 0,
      hp: s.hp, dying: 0,
    };
    this.animals.set(id, a);
    return a;
  }

  remove(id: number): void {
    this.eggs.delete(id);
    if (this.animals.delete(id)) this.removed.push(id);
  }

  /** One herd of one kind around (x, z). Respects the per-area and per-shard caps. Returns how many spawned. */
  spawnHerd(x: number, z: number, kind = pickKind()): number {
    if (this.animals.size >= SHARD_CAP) return 0;
    if (!this.outsideHub(x, z, 6)) return 0;
    const room = Math.min(REGION_CAP - this.regionCount(x, z), SHARD_CAP - this.animals.size);
    if (room <= 0) return 0;
    const [lo, hi] = SPECS[kind].herd;
    const want = Math.min(room, randi(lo, hi));
    let n = 0;
    for (let k = 0; k < want * 6 && n < want; k++) {
      const ax = Math.floor(x + rand(-3.5, 3.5));
      const az = Math.floor(z + rand(-3.5, 3.5));
      if (ax < 4 || az < 4 || ax >= WORLD_SIZE - 4 || az >= WORLD_SIZE - 4) continue;
      if (!this.outsideHub(ax, az, 3)) continue;
      const y = this.standY(ax, az, true);
      if (y < 0) continue;
      if (this.regionCount(ax + 0.5, az + 0.5) >= REGION_CAP) continue; // a herd near an area's edge may spill over
      const a = this.add(kind, ax + 0.5, y, az + 0.5);
      if (bodyInsideSolid(this.get, a)) {
        this.animals.delete(a.id);
        continue;
      }
      n++;
    }
    return n;
  }

  /** Fill the island at start (or after a reset): herds on random grass. */
  populate(target = INITIAL): void {
    if (process.env.ANIMALS === "0") return; // test servers that need an empty island (summon still works)
    for (let k = 0; k < 4000 && this.animals.size < target; k++) {
      const x = randi(8, WORLD_SIZE - 9);
      const z = randi(8, WORLD_SIZE - 9);
      if (this.standY(x, z, true) < 0) continue;
      this.spawnHerd(x + 0.5, z + 0.5);
    }
  }

  /** Every 30 s: top up toward the cap, out of sight (32+ blocks from every player). */
  respawn(players: ViewerPos[]): void {
    if (process.env.ANIMALS === "0") return;
    if (this.animals.size >= SHARD_CAP) return;
    for (let k = 0; k < 30; k++) {
      const x = randi(8, WORLD_SIZE - 9);
      const z = randi(8, WORLD_SIZE - 9);
      if (players.some((p) => Math.hypot(p.x - x, p.z - z) < 32)) continue;
      if (this.standY(x, z, true) < 0) continue;
      if (this.spawnHerd(x + 0.5, z + 0.5) > 0) return;
    }
  }

  /** Test/dev only (/summon with DEV_COMMANDS=1): one animal at a spot, on the ground there. Ignores area caps. */
  summon(kind: number, x: number, y: number, z: number): Animal | null {
    if (this.animals.size >= SHARD_CAP || !SPECS[kind]) return null;
    const gy = this.standY(Math.floor(x), Math.floor(z), false);
    return this.add(kind, x, gy > 0 ? gy : y, z);
  }

  reset(): void {
    for (const id of [...this.animals.keys()]) this.remove(id);
    this.populate();
  }

  load(): void {
    if (existsSync(this.path)) {
      try {
        const list = JSON.parse(readFileSync(this.path, "utf8")) as { k: number; x: number; y: number; z: number; yaw: number }[];
        for (const s of list) {
          if (!SPECS[s.k] || ![s.x, s.y, s.z].every(Number.isFinite)) continue;
          if (s.x < 1 || s.z < 1 || s.x > WORLD_SIZE - 1 || s.z > WORLD_SIZE - 1 || s.y < 1) continue;
          this.add(s.k, s.x, s.y, s.z, s.yaw);
          if (this.animals.size >= SHARD_CAP) break;
        }
      } catch {
        /* a broken file just means a fresh population */
      }
    }
    if (this.animals.size === 0) this.populate();
  }

  save(): void {
    const list = [...this.animals.values()].map((a) => ({ k: a.kind, x: +a.x.toFixed(2), y: +a.y.toFixed(2), z: +a.z.toFixed(2), yaw: Math.round(a.yaw) }));
    try {
      writeFileSync(this.path + ".tmp", JSON.stringify(list));
      renameSync(this.path + ".tmp", this.path);
    } catch {
      /* disk issues should not stop the game */
    }
  }

  // ---------------------------------------------------------------- interaction

  /** Does any animal's box overlap this block cell? (No placing blocks inside animals.) */
  blocksCell(x: number, y: number, z: number): boolean {
    for (const a of this.animals.values()) {
      if (Math.abs(a.x - x - 0.5) > 2 || Math.abs(a.z - z - 0.5) > 2) continue;
      if (cellHitsAnimal(x, y, z, a.x, a.y, a.z, a.hw * 2, a.h)) return true;
    }
    return false;
  }

  /** A player hit it for `damage` (half hearts): knockback away from them, a red flash and a hurt sound, then it
   *  runs away for a while; at 0 health it dies. Hits while it is still flashing do no damage (half a second).
   *  Returns true when this hit killed it. */
  hit(a: Animal, fromX: number, fromZ: number, damage = 0): boolean {
    if (a.dying) return false;
    if (damage > 0 && a.hurt > 0) return false;
    if (damage > 0) {
      a.hp -= damage;
      if (a.hp <= 0) {
        a.hp = 0;
        a.dying = 20;
        a.hurt = 10;
        a.state = "idle";
        a.path = null;
        a.vx *= 0.3;
        a.vz *= 0.3;
        this.onDeath(a);
        return true;
      }
    }
    const dx = a.x - fromX;
    const dz = a.z - fromZ;
    const d = Math.hypot(dx, dz) || 1;
    a.vx += (dx / d) * 0.38;
    a.vz += (dz / d) * 0.38;
    if (a.onGround) a.vy = 0.32;
    a.hurt = 10;
    a.eat = 0;
    a.state = "panic";
    a.timer = randi(80, 120);
    a.fleeX = fromX;
    a.fleeZ = fromZ;
    a.yaw = (Math.atan2(-dx, dz) * 180) / Math.PI;
    a.tx = a.yaw; // while panicking without a path, tx is the flee heading
    a.jumpCool = 4;
    a.path = null; // re-plan the escape once it lands
    a.plan = 0;
    a.run = false;
    return false;
  }

  // ---------------------------------------------------------------- simulation

  tick(players: ViewerPos[]): void {
    for (const a of this.animals.values()) {
      let near = false;
      for (const p of players) {
        const dx = p.x - a.x;
        const dz = p.z - a.z;
        if (dx * dx + dz * dz < SLEEP_RANGE * SLEEP_RANGE) {
          near = true;
          break;
        }
      }
      if (!near) continue;
      if (a.dying) {
        // the death animation: it lies still, then it's gone
        if (--a.dying <= 0) {
          this.remove(a.id);
          continue;
        }
        if (a.hurt > 0) a.hurt--;
        a.vx *= 0.6;
        a.vz *= 0.6;
        this.physics(a);
        continue;
      }
      this.think(a);
      this.physics(a);
      if (a.kind === 3) {
        const e = (this.eggs.get(a.id) ?? randi(6000, 12000)) - 1;
        if (e <= 0) {
          this.eggs.set(a.id, randi(6000, 12000));
          this.onEgg(a);
        } else this.eggs.set(a.id, e);
      }
      if (a.y < -4) this.remove(a.id);
    }
  }

  /** Walk to a spot by the best path (tests, and later anything that leads animals). Returns false if no path. */
  walkTo(a: Animal, x: number, z: number, run = false): boolean {
    const r = Math.ceil(Math.max(Math.abs(x - a.x), Math.abs(z - a.z))) + 4;
    const s = this.pf.search(a.x, a.y, a.z, { hw: a.hw, h: a.h, maxNodes: 2500, radius: Math.min(r, 40), water: false }, { x: Math.floor(x), z: Math.floor(z) });
    if (!s) return false;
    const end = s.reached >= 0 ? s.reached : s.closestTo(x, z);
    if (end === 0) return false;
    this.setPath(a, s.pathTo(end));
    a.state = "goto";
    a.run = run;
    a.timer = 1200;
    return true;
  }

  private setPath(a: Animal, path: PathPoint[]): void {
    a.path = path.length ? path : null;
    a.pi = 0;
    a.prog = 0;
    a.px = a.x;
    a.py = a.y;
    a.pz = a.z;
  }

  private think(a: Animal): void {
    const s = SPECS[a.kind];
    if (a.hurt > 0) a.hurt--;
    if (a.eat > 0) a.eat--;
    if (a.jumpCool > 0) a.jumpCool--;
    if (a.climb > 0) a.climb--;
    a.timer--;
    let speed = 0;
    if (a.state === "idle") {
      if (a.inWater) {
        // fell in: swim for the nearest shore
        this.planShore(a);
        if (a.path) {
          a.state = "wander";
          a.timer = 300;
        }
      } else if (a.timer <= 0 || (!this.outsideHub(a.x, a.z, 0) && a.timer > 20)) {
        if (Math.random() < 0.62 || !this.outsideHub(a.x, a.z, 0)) this.startWander(a);
        else {
          a.timer = randi(40, 160);
          // grazing (cows, sheep) or pecking (chickens) now and then
          if (Math.random() < (a.kind === 3 ? 0.5 : 0.35)) a.eat = a.kind === 3 ? 12 : randi(30, 50);
        }
      } else if (Math.random() < 1 / 70 && a.eat === 0) {
        a.yaw = wrap(a.yaw + rand(-70, 70)); // look around
      }
    }
    if (a.state === "wander" || a.state === "goto") {
      if (a.timer <= 0 || !a.path) this.toIdle(a);
      else speed = a.run ? s.panic : s.walk;
    } else if (a.state === "panic") {
      if (a.timer <= 0) this.toIdle(a, randi(40, 100));
      else {
        speed = s.panic;
        a.plan--;
        if ((!a.path || a.plan <= 0) && (a.onGround || a.inWater) && a.hurt < 6) this.planFlee(a);
      }
    }
    if (speed > 0 && a.eat > 0) a.eat = 0;
    if (speed === 0) {
      if (a.onGround) {
        a.vx *= 0.5;
        a.vz *= 0.5;
      }
      return;
    }
    if (a.path) this.follow(a, speed);
    else this.steer(a, speed);
    this.checkStuck(a);
  }

  private toIdle(a: Animal, timer = randi(40, 160)): void {
    a.state = "idle";
    a.timer = timer;
    a.path = null;
    a.run = false;
  }

  /** Follow the path: head for the next node's centre, jump when it is a block higher, re-plan if stuck. */
  private follow(a: Animal, speed: number): void {
    const path = a.path!;
    let wp = path[a.pi];
    let dx = wp.x + 0.5 - a.x;
    let dz = wp.z + 0.5 - a.z;
    let d = Math.hypot(dx, dz);
    const last = a.pi === path.length - 1;
    // Close enough (and up there): next node. Corners are cut a little, like the classic navigation.
    if (d < (last ? 0.35 : 0.6) && a.y > wp.f - 0.45 && (a.onGround || a.inWater || last)) {
      a.pi++;
      if (a.pi >= path.length) {
        if (a.state === "panic") {
          a.path = null;
          a.plan = 0;
        } else this.toIdle(a);
        a.vx *= 0.5;
        a.vz *= 0.5;
        return;
      }
      wp = path[a.pi];
      dx = wp.x + 0.5 - a.x;
      dz = wp.z + 0.5 - a.z;
      d = Math.hypot(dx, dz);
    }
    const heading = (Math.atan2(-dx, dz) * 180) / Math.PI;
    const maxTurn = a.state === "panic" || a.run ? 45 : 30;
    a.yaw = wrap(a.yaw + Math.max(-maxTurn, Math.min(maxTurn, wrap(heading - a.yaw))));
    const off = Math.abs(wrap(heading - a.yaw));
    const k = off > 80 ? 0.2 : off > 40 ? 0.6 : 1; // turn first, then walk
    const mx = d > 1e-6 ? dx / d : 0;
    const mz = d > 1e-6 ? dz / d : 0;
    this.push(a, mx * speed * k, mz * speed * k);
    // A node a block higher: jump when close (or already against it), with room overhead.
    const rise = wp.f - a.y;
    if (rise > STEP - 0.05 && a.jumpCool === 0 && a.onGround && (a.collidedH || d < a.hw + 0.85)) this.jump(a);
    else if (a.collidedH && a.onGround && a.jumpCool === 0 && this.climbable(a, mx, mz)) this.jump(a);
  }

  /** No path (mid-air, or nothing reachable): the plain heading, hopping steps and turning at walls and cliffs. */
  private steer(a: Animal, speed: number): void {
    if (a.state === "panic") {
      if (a.timer % 25 === 0) {
        const away = (Math.atan2(-(a.x - a.fleeX), a.z - a.fleeZ) * 180) / Math.PI;
        a.tx = away + rand(-50, 50); // tx holds the flee heading while panicking without a path
      }
      if (a.hurt === 0) a.yaw = wrap(a.yaw + Math.max(-30, Math.min(30, wrap(a.tx - a.yaw))));
    }
    const mx = -Math.sin(a.yaw * DEG);
    const mz = Math.cos(a.yaw * DEG);
    if (a.onGround) {
      // a drop of 4+ (or calm water) ahead: turn
      const ax = Math.floor(a.x + mx * (a.hw + 0.6));
      const az = Math.floor(a.z + mz * (a.hw + 0.6));
      const ahead = this.groundBelow(ax, Math.floor(a.y + 0.01) + 1, az, 4);
      if (ahead === -99 || (ahead === -50 && a.state !== "panic")) {
        a.yaw = wrap(a.yaw + (Math.random() < 0.5 ? 120 : -120));
        a.tx = a.yaw;
        a.vx *= 0.3;
        a.vz *= 0.3;
        return;
      }
    }
    this.push(a, mx * speed, mz * speed);
    if (a.collidedH && a.onGround && a.jumpCool === 0) {
      if (this.climbable(a, mx, mz)) this.jump(a);
      else {
        a.yaw = wrap(a.yaw + (Math.random() < 0.5 ? 100 : -100)); // a wall: turn away
        a.tx = a.yaw;
        a.jumpCool = 5;
      }
    }
  }

  private push(a: Animal, tvx: number, tvz: number): void {
    const control = a.onGround ? 1 : a.inWater ? 0.5 : a.climb > 0 ? 0.35 : 0.15;
    a.vx += (tvx - a.vx) * control;
    a.vz += (tvz - a.vz) * control;
  }

  private jump(a: Animal): void {
    a.vy = JUMP_VELOCITY;
    a.jumpCool = 8;
    a.climb = 10;
  }

  /** Is the cell ahead a one-block step with room above it (and above the animal for the jump)? */
  private climbable(a: Animal, mx: number, mz: number): boolean {
    const feet = Math.floor(a.y + 0.01);
    const tall = Math.ceil(a.h);
    const cells: [number, number][] = [];
    if (Math.abs(mx) > 0.2) {
      const cx = Math.floor(a.x + Math.sign(mx) * (a.hw + 0.2));
      cells.push([cx, Math.floor(a.z - a.hw + 0.01)], [cx, Math.floor(a.z + a.hw - 0.01)]);
    }
    if (Math.abs(mz) > 0.2) {
      const cz = Math.floor(a.z + Math.sign(mz) * (a.hw + 0.2));
      cells.push([Math.floor(a.x - a.hw + 0.01), cz], [Math.floor(a.x + a.hw - 0.01), cz]);
    }
    let step = false;
    for (const [cx, cz] of cells) {
      if (!solidAt(this.get, cx, feet, cz)) continue;
      for (let k = 1; k <= tall; k++) if (solidAt(this.get, cx, feet + k, cz)) return false; // a wall (or no room on top)
      step = true;
    }
    if (!step) return false;
    // room for the jump over the animal itself
    return !boxHitsSolid(this.get, a.x - a.hw, a.y + a.h, a.z - a.hw, a.x + a.hw, a.y + a.h + 1.1, a.z + a.hw);
  }

  /** Every 20 ticks of trying to move: barely moved means stuck, so re-plan (or give up and stand). */
  private checkStuck(a: Animal): void {
    if (++a.prog < 20) return;
    const moved = Math.hypot(a.x - a.px, a.z - a.pz) + Math.abs(a.y - a.py);
    a.prog = 0;
    a.px = a.x;
    a.py = a.y;
    a.pz = a.z;
    if (moved > 0.3) {
      a.stuck = 0;
      return;
    }
    a.stuck++;
    this.stuckCount++;
    if (a.state === "panic") {
      a.path = null;
      a.plan = 0;
      a.yaw = wrap(a.yaw + 180);
      a.tx = a.yaw;
    } else if (a.stuck >= 2 || a.state === "goto") {
      if (a.state === "goto" && a.stuck < 3) {
        const end = a.path?.[a.path.length - 1];
        if (end && this.walkTo(a, end.x + 0.5, end.z + 0.5, a.run)) return;
      }
      this.toIdle(a);
      a.stuck = 0;
    } else this.startWander(a);
  }

  private startWander(a: Animal): void {
    const s = this.pf.search(a.x, a.y, a.z, { hw: a.hw, h: a.h, maxNodes: 260, radius: 9, water: false });
    if (s) {
      const picks: number[] = [];
      const inside = !this.outsideHub(a.x, a.z, 0);
      const r0 = (a.x - SPAWN_X) ** 2 + (a.z - SPAWN_Z) ** 2;
      for (let i = 1; i < s.pts.length; i++) {
        const q = s.pts[i];
        if (s.cost[i] < 3 || s.cost[i] > 11 || q.water) continue;
        // never into the safe zone; a stray inside heads out
        if (inside ? (q.x - SPAWN_X) ** 2 + (q.z - SPAWN_Z) ** 2 <= r0 + 16 : !this.outsideHub(q.x, q.z, 1)) continue;
        picks.push(i);
      }
      if (picks.length) {
        this.setPath(a, s.pathTo(picks[randi(0, picks.length - 1)]));
        a.state = "wander";
        a.run = false;
        a.timer = randi(200, 320);
        return;
      }
    }
    a.timer = randi(40, 100);
  }

  /** Panic: a reachable spot well away from whoever hit it (water allowed, but it costs). */
  private planFlee(a: Animal): void {
    a.plan = randi(30, 45);
    const s = this.pf.search(a.x, a.y, a.z, { hw: a.hw, h: a.h, maxNodes: 420, radius: 10, water: true });
    if (!s) {
      a.path = null;
      return;
    }
    let best = 0;
    let score = -Infinity;
    for (let i = 1; i < s.pts.length; i++) {
      const p = s.pts[i];
      if (s.cost[i] > 14) continue;
      const v = Math.hypot(p.x + 0.5 - a.fleeX, p.z + 0.5 - a.fleeZ) - s.cost[i] * 0.3 + Math.random() * 2 - (this.outsideHub(p.x, p.z, 1) ? 0 : 50);
      if (v > score) {
        score = v;
        best = i;
      }
    }
    this.setPath(a, best ? s.pathTo(best) : []);
  }

  /** In water with no path: the nearest dry spot within 8 blocks a body could climb out onto. */
  private planShore(a: Animal): void {
    const fx = Math.floor(a.x);
    const fz = Math.floor(a.z);
    this.pf.reset(a.hw, a.h, a.y);
    for (let r = 1; r <= 8; r++) {
      let best: PathPoint | null = null;
      let bd = Infinity;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const p = this.pf.dryNear(fx + dx, fz + dz, a.y);
          if (!p) continue;
          const d = dx * dx + dz * dz;
          if (d < bd) {
            bd = d;
            best = p;
          }
        }
      }
      if (best) {
        this.setPath(a, [best]);
        return;
      }
    }
    a.path = null;
  }

  private physics(a: Animal): void {
    a.inWater = bodyInWater(this.get, a);
    if (a.inWater) {
      // Java's water travel: paddle up, move, water drag, and the hop out of the water at a bank.
      a.vy += 0.04;
      const [fx, fz] = flowAt(this.bget, a.x, a.y + 0.3, a.z); // and drift with the current
      a.vx += fx;
      a.vz += fz;
      const ivx = a.vx;
      const ivz = a.vz;
      moveBody(this.get, a, a.vx, a.vy, a.vz);
      a.vx *= 0.8;
      a.vz *= 0.8;
      a.vy = a.vy * 0.8 - 0.02;
      if (a.collidedH && !boxHitsSolid(this.get, a.x - a.hw + ivx, a.y + 0.6, a.z - a.hw + ivz, a.x + a.hw + ivx, a.y + a.h + 0.6, a.z + a.hw + ivz)) a.vy = 0.3;
    } else if (a.onGround && Math.abs(a.vx) < 0.002 && Math.abs(a.vz) < 0.002 && a.vy <= 0 && a.hurt === 0) {
      // Resting on the ground: no collision pass needed (unless the ground went away).
      a.vx = a.vz = 0;
      a.vy = REST_VY;
      if (!boxHitsSolid(this.get, a.x - a.hw, a.y - 0.05, a.z - a.hw, a.x + a.hw, a.y, a.z + a.hw)) a.onGround = false;
    } else {
      // Java order: move with this tick's velocity, then gravity and drag (a 0.42 jump peaks at 1.25 blocks).
      moveBody(this.get, a, a.vx, a.vy, a.vz);
      a.vy = (a.vy - GRAVITY) * DRAG_Y;
      if (a.kind === 3 && !a.onGround && a.vy < -0.07) a.vy = -0.07; // chickens flap and fall slowly
      if (!a.onGround) {
        a.vx *= 0.91;
        a.vz *= 0.91;
      }
    }
    // A block placed (or water moved) into it: step up out of it.
    for (let k = 0; k < 3 && bodyInsideSolid(this.get, a, 0.1); k++) a.y = Math.floor(a.y) + 1;
    a.x = Math.max(a.hw + 0.01, Math.min(WORLD_SIZE - a.hw - 0.01, a.x));
    a.z = Math.max(a.hw + 0.01, Math.min(WORLD_SIZE - a.hw - 0.01, a.z));
    let f = 0;
    if (Math.hypot(a.vx, a.vz) > 0.01) f |= AF.MOVING;
    if (a.state === "panic") f |= AF.PANIC;
    if (a.hurt > 0) f |= AF.HURT;
    if (a.dying) f |= AF.DEAD;
    if (a.onGround) f |= AF.GROUND;
    if (a.eat > 0) f |= AF.EAT;
    if (a.inWater) f |= AF.SWIM;
    a.flags = f;
    // 1/32 block, 256 yaw steps: finer changes are invisible after interpolation.
    const key = ((Math.round(a.x * 32) * 73856093) ^ (Math.round(a.y * 32) * 19349663) ^ (Math.round(a.z * 32) * 83492791) ^ (Math.round((((a.yaw % 360) + 360) % 360) * (256 / 360)) << 8) ^ f) | 0;
    if (key !== a.key) {
      a.key = key;
      a.version++;
    }
  }

  // ---------------------------------------------------------------- sync

  /** What to send one player this tick: changed animals in range (10 Hz near, 5 Hz far) and the ones gone. */
  messages(p: ViewerPos, seen: Seen, tick: number): Uint8Array[] {
    const out: Uint8Array[] = [];
    const list: AnimalSnap[] = [];
    const gone: number[] = [];
    for (const a of this.animals.values()) {
      const dx = a.x - p.x;
      const dz = a.z - p.z;
      const d2 = dx * dx + dz * dz;
      const last = seen.get(a.id);
      if (d2 > ANIMAL_RANGE_OUT * ANIMAL_RANGE_OUT) {
        if (last !== undefined) {
          gone.push(a.id);
          seen.delete(a.id);
        }
        continue;
      }
      if (d2 > ANIMAL_RANGE * ANIMAL_RANGE && last === undefined) continue;
      if (last === a.version) continue;
      if (last !== undefined && d2 > 32 * 32 && tick % 4 !== 0) continue;
      list.push({ id: a.id, kind: a.kind, x: a.x, y: a.y, z: a.z, yaw: a.yaw, flags: a.flags });
      seen.set(a.id, a.version);
    }
    for (const id of this.removed) if (seen.delete(id)) gone.push(id);
    if (list.length) out.push(encodeAnimals(tick, list));
    if (gone.length) out.push(encodeGone(gone));
    return out;
  }

  /** Call once per tick after every player got their messages. */
  flushRemoved(): void {
    this.removed.length = 0;
  }
}

function pickKind(): number {
  const total = SPECS.reduce((s, k) => s + k.weight, 0);
  let r = Math.random() * total;
  for (let i = 0; i < SPECS.length; i++) {
    r -= SPECS[i].weight;
    if (r < 0) return i;
  }
  return 0;
}
