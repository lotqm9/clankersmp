// Night mobs for one shard (protocol v6): Shamblers, Rattlers and Skitters (shared/mobs.ts). The server owns them
// all: spawning, AI, physics (the players' collision code), combat, their arrows, and the sync to nearby players.
//
// Spawning, like the classic rules: every second, around each player out in the wild, a few tries at spots 24-48
// blocks away (never within 24 of anyone): on the surface at night, or on a roofed cave floor at any time when it
// is deep enough to be dark, always where no torch or lamp lights the spot (server/src/light.ts), on a solid,
// opaque floor with room for the body. At most 8 around a player and 90 in the shard. Never within 16 blocks of the
// spawn safe zone; a mob that ends up inside the zone vanishes, none target players in it, and arrows vanish at its
// edge (and nothing can hurt you there anyway). Far from every player they go: at once beyond 96 blocks, now and
// then beyond 32. They are not saved: a restart starts the night over.
//
// Behaviour: they notice a player in plain sight (a clear line between the eyes) within 16-20 blocks and follow
// along real paths (server/src/pathfind.ts) up to 24-35 blocks:
//   Shambler: walks at you and hits (1.5 hearts) when in reach, once a second
//   Rattler:  comes within ~12 blocks, then strafes and shoots: draws for a second, an arrow every two (ceil(2 x
//             speed) damage, aimed with a lead for the drop, a little spread)
//   Skitter:  runs at you, climbs straight up walls, and leaps from a few blocks away; calm by day unless hit
// In daylight under the open sky Shamblers and Rattlers catch fire (1 damage a second) until they die or find
// shade or water. Hit them back: knockback, half a second of invulnerability (only a harder hit gets through), and
// they die at 0 health (a short tip-over) and drop what they carry.
//
// v7: players' arrows (the bow) fly through the same code: they hit night mobs and animals, never players; one shot
// in survival that sticks in a block can be picked up again (a minute, then it is gone). Rattlers drop arrows too.

import { B, IS_WATER, OPAQUE, SOLID } from "../../shared/blocks.ts";
import { encodeAnimals, encodeGone, rayHitsBox, type AnimalSnap } from "../../shared/animals.ts";
import { KNOCKBACK, afterArmor } from "../../shared/combat.ts";
import { SPAWN_X, SPAWN_Z, WORLD_HEIGHT, WORLD_SIZE } from "../../shared/constants.ts";
import { SAFE_RADIUS } from "../../shared/hub.ts";
import { SafeZone } from "../../shared/hub12.ts";
import { I, type Stack } from "../../shared/items.ts";
import { ARROW_LIFE, ARROW_SPEED, MF, MOB, MOB_RANGE, MOB_RANGE_OUT, MOB_SPECS, OP_MOBS, OP_MOBS_GONE, arrowBlockHit, arrowDamage, arrowMove, meleeReachSq, type ArrowState } from "../../shared/mobs.ts";
import { DRAG_Y, GRAVITY, JUMP_VELOCITY, bodyInWater, bodyInsideSolid, boxHitsSolid, moveBody, type Body, type GetBlock } from "../../shared/physics.ts";
import { bounded, flowAt } from "../../shared/water.ts";
import type { LightIndex } from "./light.ts";
import { PathFinder, STEP, type PathPoint } from "./pathfind.ts";

export const MOB_CAP = 90; // per shard
export const LOCAL_CAP = 8; // within 48 blocks of a player
const DESPAWN_FAR = 96;
const DESPAWN_NEAR = 32;
const HUB_MARGIN = 16; // no spawns this close to the safe zone
const REST_VY = -GRAVITY * DRAG_Y;
/** Spawning happens at night from 13000 to 23000 (the surface is dark enough), and in deep caves at any time. */
export const isSpawnNight = (t: number) => t >= 13000 && t <= 23000;
/** The sun is up (the undead burn): outside the bed window, 12542..23459. */
export const isSunUp = (t: number) => t < 12542 || t > 23459;

export interface Mob extends Body {
  id: number;
  kind: number;
  yaw: number;
  hp: number;
  hurt: number; // ticks of the red flash (and of invulnerability)
  lastDmg: number; // the damage taken at the start of that window
  dying: number;
  target: number; // player id (0: none)
  provoked: number; // ticks of revenge after a player hit it (a calm Skitter fights back)
  scan: number; // ticks until it looks for a target again
  path: PathPoint[] | null;
  pi: number;
  replan: number;
  goalX: number;
  goalZ: number;
  timer: number; // wander / idle timer
  attackCool: number;
  swing: number; // ticks of the ATTACK flag after a melee hit
  draw: number; // Rattler: ticks with the bow drawn
  seen: number; // Rattler: ticks with the target in sight
  strafe: number; // Rattler: -1 / 1, and when it changes
  strafeTimer: number;
  leapCool: number;
  jumpCool: number;
  climbing: boolean;
  burn: number; // ticks left on fire
  /** Ticks a hit's knockback still carries it (its own legs wait: Java's knockback, a couple of blocks a hit). */
  knock: number;
  fireTicks: number; // ticks it has been burning (1 damage every 20)
  inWater: boolean;
  far: number; // ticks with nobody within 32 blocks
  los: boolean; // chasing in plain sight, close and level: straight at the target
  losAt: number; // ticks until that is checked again
  flags: number;
  key: number;
  version: number;
  prog: number;
  px: number;
  pz: number;
}

export interface Arrow extends ArrowState {
  id: number;
  owner: number; // the mob that shot it (0: a player's)
  age: number;
  /** v7: a player's arrow (their id): it hits mobs and animals, never players. */
  player?: number;
  /** Fully drawn: a critical arrow (a little extra damage). */
  crit?: boolean;
  /** Shot in survival: once it sticks, it can be picked up again. */
  pickup?: boolean;
}

/** v7: a player's arrow stuck in a block, waiting to be picked up (or to go after a minute). */
export interface StuckArrow {
  id: number;
  x: number;
  y: number;
  z: number;
  age: number;
}
/** Ticks a stuck arrow stays (Java: a minute). */
export const STUCK_LIFE = 1200;
/** At most this many arrows stuck in the ground on a shard (the oldest goes first): the entity budget. */
export const STUCK_MAX = 512;

/** What a player's arrow can hit besides the mobs (the shard's animals). */
export interface ArrowTarget {
  id: number;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
}

/** What the mob manager is told about each player. */
export interface MobTarget {
  id: number;
  x: number;
  y: number;
  z: number;
  h: number; // box height (1.8, or 1.5 crouched)
  eye: number; // eye height above the feet
  valid: boolean; // a survival player, alive, outside the safe zone: something to hunt
}

export interface MobHooks {
  /** A mob's hit (or arrow) landed on a player: damage in half hearts, knockback direction (unit, horizontal). */
  hurtPlayer(id: number, damage: number, cause: string, fromX: number, fromZ: number, dirX: number, dirZ: number): void;
  /** A mob died (its tip-over begins): drops. `byPlayer`: a player struck the last blow. */
  died(m: Mob, byPlayer: boolean): void;
  arrowShot(a: Arrow): void;
  arrowEnded(a: Arrow, stuck: boolean): void;
  /** v7: animals a player's arrow could hit near (x, z). */
  animalsNear(x: number, z: number, r: number): ArrowTarget[];
  /** v7: a player's arrow hit an animal: what it did. */
  hurtAnimal(id: number, dmg: number, fromX: number, fromZ: number): { dealt: number; killed: boolean };
  /** v7: a player's arrow landed on something: tell the archer. */
  arrowStruck(a: Arrow, id: number, mob: boolean, dealt: number, killed: boolean): void;
  /** v7: a stuck arrow was picked up (by `player`) or went away (player 0). */
  arrowGone(s: StuckArrow, player: number): void;
  /** v7: may this player take this arrow (room in the inventory)? Gives it when true. */
  pickupArrow(player: number): boolean;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const randi = (a: number, b: number) => Math.floor(rand(a, b + 1));
const wrap = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
/** Outside the spawn safe zone by `margin` blocks. */
export const outsideHub = (x: number, z: number, margin = 0) => (x - SPAWN_X - 0.5) ** 2 + (z - SPAWN_Z - 0.5) ** 2 > (SAFE_RADIUS + margin) ** 2;

function gauss(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** What a mob drops. */
export function mobDrops(kind: number, byPlayer: boolean, r: () => number = Math.random): Stack[] {
  const n = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const out: Stack[] = [];
  const add = (id: number, k: number) => {
    if (k > 0) out.push({ id, n: k, d: 0 });
  };
  if (kind === MOB.SHAMBLER) {
    add(I.SPOILED_FLESH, n(0, 2));
    if (byPlayer && r() < 0.025) add(I.IRON_INGOT, 1);
  } else if (kind === MOB.RATTLER) {
    add(I.BONE, n(0, 2));
    add(I.ARROW, n(0, 2)); // v7
  } else add(I.STRING, n(0, 2));
  return out;
}

export class MobManager {
  readonly mobs = new Map<number, Mob>();
  /** v10: the spawn safe zone (the bigger hub, less the tiles kept for players' builds: the shard sets it). */
  zone = new SafeZone();
  /** Outside the safe zone by `margin` blocks. */
  outsideHub(x: number, z: number, margin = 0): boolean {
    return this.zone.outside(x, z, margin);
  }
  readonly arrows = new Map<number, Arrow>();
  /** v7: players' arrows stuck in blocks (pick them up by walking over them). */
  readonly stuck = new Map<number, StuckArrow>();
  private nextId = 1;
  private nextArrow = 1;
  private get: GetBlock;
  private bget: GetBlock;
  private pf: PathFinder;
  private light: LightIndex;
  private removed: number[] = [];
  private searches = 0; // path searches this tick (a budget)
  hooks: MobHooks = {
    hurtPlayer: () => {},
    died: () => {},
    arrowShot: () => {},
    arrowEnded: () => {},
    animalsNear: () => [],
    hurtAnimal: () => ({ dealt: 0, killed: false }),
    arrowStruck: () => {},
    arrowGone: () => {},
    pickupArrow: () => false,
  };
  /** Natural spawning (MOBS=0 turns it off for test servers; /mobs on|off on DEV servers). */
  spawning = process.env.MOBS !== "0";
  /** Dev only (/mobs freeze): no AI (screenshots); they still fall and settle. */
  frozen = false;
  /** Counters for tests and the load test. */
  stats = { spawned: 0, despawned: 0, killed: 0, burned: 0, shots: 0, hits: 0, searches: 0 };

  constructor(get: GetBlock, light: LightIndex) {
    this.get = get;
    this.bget = bounded(get);
    this.pf = new PathFinder(get);
    this.light = light;
  }

  private block(x: number, y: number, z: number): number {
    if (x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE || y < 0 || y >= WORLD_HEIGHT) return B.AIR;
    return this.get(x, y, z);
  }

  // ---------------------------------------------------------------- spawning

  /** A floor a mob may spawn on: a full opaque block (no glass, leaves, slabs or the like), not bedrock. */
  private goodFloor(id: number): boolean {
    return OPAQUE[id] === 1 && SOLID[id] === 1 && id !== B.BEDROCK;
  }

  /** Room for a body of height h (and its width) with feet at (x, y, z) block cell, dry. */
  private room(x: number, y: number, z: number, h: number): boolean {
    for (let k = 0; k < Math.ceil(h); k++) {
      const id = this.block(x, y + k, z);
      if (SOLID[id] || IS_WATER[id]) return false;
    }
    return true;
  }

  /** The surface spot of a column (feet y), or -1. */
  surfaceY(x: number, z: number): number {
    for (let y = WORLD_HEIGHT - 3; y > 1; y--) {
      const id = this.block(x, y, z);
      if (id === B.AIR || !SOLID[id]) {
        if (IS_WATER[id]) return -1;
        continue;
      }
      if (!this.goodFloor(id)) return -1;
      return this.room(x, y + 1, z, 2) ? y + 1 : -1;
    }
    return -1;
  }

  /** A roofed floor in a column near height `near` (caves), or -1. */
  caveY(x: number, z: number, near: number): number {
    const top = this.light.top(x, z);
    const hi = Math.min(top - 2, Math.floor(near) + 12);
    const lo = Math.max(3, Math.floor(near) - 16);
    for (let y = hi; y >= lo; y--) {
      if (!this.goodFloor(this.block(x, y - 1, z))) continue;
      if (!this.room(x, y, z, 2)) continue;
      if (this.light.sky(x, y, z)) continue;
      return y;
    }
    return -1;
  }

  /** Dark enough here for a mob to appear? */
  dark(x: number, y: number, z: number, night: boolean): boolean {
    if (this.light.blockLight(x, y, z) > 0) return false;
    if (night) return true;
    return !this.light.sky(x, y, z) && this.light.deepDark(x, y, z);
  }

  private add(kind: number, x: number, y: number, z: number): Mob {
    let id = this.nextId;
    for (let k = 0; k < 65535 && this.mobs.has(id); k++) id = (id % 65534) + 1;
    this.nextId = (id % 65534) + 1;
    const s = MOB_SPECS[kind];
    const m: Mob = {
      id, kind, x, y, z, vx: 0, vy: 0, vz: 0, hw: s.w / 2, h: s.h, onGround: false, collidedH: false,
      yaw: rand(-180, 180), hp: s.hp, hurt: 0, lastDmg: 0, dying: 0, target: 0, provoked: 0, scan: randi(0, 10),
      path: null, pi: 0, replan: 0, goalX: 0, goalZ: 0, timer: randi(20, 80), attackCool: 0, swing: 0, draw: 0,
      seen: 0, strafe: Math.random() < 0.5 ? 1 : -1, strafeTimer: 0, leapCool: 0, jumpCool: 0, climbing: false,
      burn: 0, knock: 0, fireTicks: 0, inWater: false, far: 0, los: false, losAt: 0, flags: 0, key: -1, version: 1, prog: 0, px: x, pz: z,
    };
    this.mobs.set(id, m);
    this.stats.spawned++;
    return m;
  }

  remove(id: number): void {
    if (this.mobs.delete(id)) this.removed.push(id);
  }

  /** Test/dev (/summon with DEV_COMMANDS=1): one mob, on the ground at a spot. Ignores light and caps. */
  summon(kind: number, x: number, y: number, z: number): Mob | null {
    if (!MOB_SPECS[kind] || !this.outsideHub(x, z, 1)) return null;
    let fy = y;
    for (let k = 0; k < 6 && fy > 1 && !SOLID[this.block(Math.floor(x), Math.floor(fy) - 1, Math.floor(z))]; k++) fy--;
    const m = this.add(kind, x, Math.floor(fy), z);
    if (bodyInsideSolid(this.get, m)) m.y = Math.floor(m.y) + 1;
    return m;
  }

  private pickKind(cave: boolean): number {
    const w = MOB_SPECS.map((s, k) => s.weight * (cave && k !== MOB.SHAMBLER ? 1.3 : 1));
    let r = Math.random() * w.reduce((a, b) => a + b, 0);
    for (let k = 0; k < w.length; k++) {
      r -= w[k];
      if (r < 0) return k;
    }
    return 0;
  }

  /** Once a second: a few tries around each player out in the wild. */
  spawnTick(players: MobTarget[], time: number): number {
    if (!this.spawning) return 0;
    const night = isSpawnNight(time);
    let made = 0;
    const list = players.filter((p) => p.valid);
    for (let k = list.length - 1; k > 0; k--) {
      const j = Math.floor(Math.random() * (k + 1));
      [list[k], list[j]] = [list[j], list[k]];
    }
    for (const p of list) {
      if (this.mobs.size >= MOB_CAP) break;
      let near = 0;
      for (const m of this.mobs.values()) if ((m.x - p.x) ** 2 + (m.z - p.z) ** 2 < 48 * 48) near++;
      if (near >= LOCAL_CAP) continue;
      for (let attempt = 0; attempt < 3; attempt++) {
        const a = Math.random() * Math.PI * 2;
        const r = rand(24, 46);
        const x = Math.floor(p.x + Math.cos(a) * r);
        const z = Math.floor(p.z + Math.sin(a) * r);
        if (x < 4 || z < 4 || x >= WORLD_SIZE - 4 || z >= WORLD_SIZE - 4) continue;
        if (!this.outsideHub(x + 0.5, z + 0.5, HUB_MARGIN)) continue;
        let y = -1;
        let cave = false;
        if (night && Math.random() < 0.65) y = this.surfaceY(x, z);
        if (y < 0) {
          y = this.caveY(x, z, p.y);
          cave = y >= 0;
        }
        if (y < 0 || !this.dark(x, y, z, night)) continue;
        if (players.some((q) => (q.x - x - 0.5) ** 2 + (q.y - y) ** 2 + (q.z - z - 0.5) ** 2 < 24 * 24)) continue;
        const kind = this.pickKind(cave);
        const group = kind === MOB.SKITTER ? 1 : randi(1, 3);
        for (let g = 0; g < group && this.mobs.size < MOB_CAP; g++) {
          const gx = g === 0 ? x : x + randi(-2, 2);
          const gz = g === 0 ? z : z + randi(-2, 2);
          const gy = g === 0 ? y : cave ? this.caveY(gx, gz, y) : this.surfaceY(gx, gz);
          if (gy < 0 || Math.abs(gy - y) > 2 || !this.outsideHub(gx + 0.5, gz + 0.5, HUB_MARGIN)) continue;
          if (this.light.blockLight(gx, gy, gz) > 0) continue;
          if (players.some((q) => (q.x - gx - 0.5) ** 2 + (q.y - gy) ** 2 + (q.z - gz - 0.5) ** 2 < 24 * 24)) continue;
          const m = this.add(kind, gx + 0.5, gy, gz + 0.5);
          if (bodyInsideSolid(this.get, m)) {
            this.mobs.delete(m.id);
            this.stats.spawned--;
            continue;
          }
          made++;
        }
        break;
      }
    }
    return made;
  }

  // ---------------------------------------------------------------- combat

  /** Damage a mob (half hearts). From a player: knockback away from (fromX, fromZ) with strength `kb`, and it fights
   *  back. Within half a second of the last hit only a harder hit gets through, for the difference. Returns the
   *  damage dealt (0: none), and whether it died. */
  damage(m: Mob, amount: number, from: { x: number; z: number; kb: number; player: number } | null): { dealt: number; killed: boolean } {
    if (m.dying || amount <= 0) return { dealt: 0, killed: false };
    let d = amount;
    if (m.hurt > 0) {
      if (amount <= m.lastDmg) return { dealt: 0, killed: false };
      d = amount - m.lastDmg;
      m.lastDmg = amount;
    } else {
      m.lastDmg = amount;
      m.hurt = 10;
    }
    if (from) d = afterArmor(d, MOB_SPECS[m.kind].armor, 0); // armour softens blows, not fire
    m.hp -= d;
    if (from) {
      const dx = m.x - from.x;
      const dz = m.z - from.z;
      const l = Math.hypot(dx, dz) || 1;
      m.vx = m.vx / 2 + (dx / l) * from.kb;
      m.vz = m.vz / 2 + (dz / l) * from.kb;
      if (m.onGround) m.vy = Math.min(0.4, m.vy / 2 + 0.4);
      // v13: the knockback carries it: its AI used to set its speed back toward the player on the very next tick, so
      // a hit moved it half a block and a sprinting hit no further (Java's carry a zombie two blocks and five)
      m.knock = 10;
      m.provoked = 600;
      if (from.player) {
        m.target = from.player;
        m.path = null;
        m.replan = 0;
      }
    }
    if (m.hp <= 0) {
      m.hp = 0;
      m.dying = 20;
      m.path = null;
      m.target = 0;
      m.burn = 0;
      this.stats.killed++;
      this.hooks.died(m, !!from?.player);
      return { dealt: d, killed: true };
    }
    return { dealt: d, killed: false };
  }

  /** Does any mob's box overlap this block cell? (No placing blocks inside mobs.) */
  blocksCell(x: number, y: number, z: number): boolean {
    for (const m of this.mobs.values()) {
      if (Math.abs(m.x - x - 0.5) > 2 || Math.abs(m.z - z - 0.5) > 2) continue;
      const hw = m.hw - 0.05;
      if (x + 1 > m.x - hw && x < m.x + hw && y + 1 > m.y + 0.05 && y < m.y + m.h - 0.05 && z + 1 > m.z - hw && z < m.z + hw) return true;
    }
    return false;
  }

  /** Hostile mobs close to a spot (no sleeping with monsters nearby). */
  hostileNear(x: number, y: number, z: number, r: number, dy: number): boolean {
    for (const m of this.mobs.values()) if (!m.dying && Math.abs(m.y - y) <= dy && (m.x - x) ** 2 + (m.z - z) ** 2 <= r * r) return true;
    return false;
  }

  // ---------------------------------------------------------------- simulation

  tick(players: MobTarget[], time: number): void {
    this.searches = 0;
    const sun = isSunUp(time);
    const byId = new Map<number, MobTarget>();
    for (const p of players) byId.set(p.id, p);
    for (const m of this.mobs.values()) {
      let near2 = Infinity;
      for (const p of players) {
        const d2 = (p.x - m.x) ** 2 + (p.z - m.z) ** 2;
        if (d2 < near2) near2 = d2;
      }
      if (near2 > DESPAWN_FAR * DESPAWN_FAR || !this.outsideHub(m.x, m.z, 0)) {
        this.remove(m.id);
        this.stats.despawned++;
        continue;
      }
      if (near2 > DESPAWN_NEAR * DESPAWN_NEAR && !m.target) {
        if (++m.far > 600 && Math.random() < 1 / 800) {
          this.remove(m.id);
          this.stats.despawned++;
          continue;
        }
      } else m.far = 0;
      if (m.dying) {
        if (--m.dying <= 0) {
          this.remove(m.id);
          continue;
        }
        if (m.hurt > 0) m.hurt--;
        m.vx *= 0.6;
        m.vz *= 0.6;
        this.physics(m);
        continue;
      }
      if (m.hurt > 0) m.hurt--; // the hurt (invulnerable) time runs out whatever the AI does
      if (!this.frozen) this.think(m, players, byId, sun);
      else {
        m.vx *= 0.5;
        m.vz *= 0.5;
      }
      if (this.mobs.has(m.id)) this.physics(m);
      if (m.y < -4) this.remove(m.id);
    }
    this.tickArrows(players);
  }

  /** A clear line between two points (no opaque block in the way). */
  private sees(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
    const d = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    const n = Math.ceil(d / 0.4);
    for (let k = 1; k < n; k++) {
      const t = k / n;
      if (OPAQUE[this.block(Math.floor(x0 + (x1 - x0) * t), Math.floor(y0 + (y1 - y0) * t), Math.floor(z0 + (z1 - z0) * t))]) return false;
    }
    return true;
  }

  private eyeOf(m: Mob): number {
    return m.y + m.h * 0.85;
  }

  private findTarget(m: Mob, players: MobTarget[], sun: boolean): MobTarget | undefined {
    const s = MOB_SPECS[m.kind];
    if (s.key === "skitter" && sun && m.provoked <= 0) return undefined; // calm by day
    let best: MobTarget | undefined;
    let bd = s.sight * s.sight;
    for (const p of players) {
      if (!p.valid) continue;
      const d2 = (p.x - m.x) ** 2 + (p.y - m.y) ** 2 + (p.z - m.z) ** 2;
      if (d2 >= bd) continue;
      if (!this.sees(m.x, this.eyeOf(m), m.z, p.x, p.y + p.eye, p.z)) continue;
      bd = d2;
      best = p;
    }
    return best;
  }

  private think(m: Mob, players: MobTarget[], byId: Map<number, MobTarget>, sun: boolean): void {
    const s = MOB_SPECS[m.kind];
    if (m.attackCool > 0) m.attackCool--;
    if (m.swing > 0) m.swing--;
    if (m.leapCool > 0) m.leapCool--;
    if (m.jumpCool > 0) m.jumpCool--;
    if (m.provoked > 0) m.provoked--;
    if (m.replan > 0) m.replan--;
    m.timer--;
    // v13: knocked back: the hit carries it (ground friction once it lands) before its legs take over again
    const legs = m.knock <= 0;
    if (!legs) {
      m.knock--;
      if (m.onGround && m.knock < 8) {
        m.vx *= 0.6;
        m.vz *= 0.6;
      }
    }
    // the sun: the undead catch fire under the open sky (and water puts it out)
    if (s.burns && sun && !m.inWater && this.light.sky(Math.floor(m.x), Math.floor(m.y + m.h - 0.1), Math.floor(m.z))) m.burn = Math.max(m.burn, 160);
    if (m.inWater) m.burn = 0;
    if (m.burn > 0) {
      m.burn--;
      if (++m.fireTicks % 20 === 0) {
        const r = this.damage(m, 1, null);
        if (r.killed) this.stats.burned++;
        if (!this.mobs.has(m.id) || m.dying) return;
      }
    } else m.fireTicks = 0;
    // the target: still worth following?
    let t = m.target ? byId.get(m.target) : undefined;
    if (t) {
      const d2 = (t.x - m.x) ** 2 + (t.z - m.z) ** 2;
      const calm = s.key === "skitter" && sun && m.provoked <= 0;
      if (!t.valid || d2 > s.follow * s.follow || Math.abs(t.y - m.y) > 24 || calm) {
        t = undefined;
        m.target = 0;
        m.path = null;
        m.draw = 0;
      }
    }
    if (!t && --m.scan <= 0) {
      m.scan = 10;
      t = this.findTarget(m, players, sun);
      if (t) {
        m.target = t.id;
        m.path = null;
        m.replan = 0;
      }
    }
    if (!t) {
      m.draw = 0;
      if (legs) this.wander(m, s.walk);
      return;
    }
    // facing: at the target
    const dx = t.x - m.x;
    const dz = t.z - m.z;
    const dh = Math.hypot(dx, dz);
    const heading = (Math.atan2(-dx, dz) * 180) / Math.PI;
    const d2 = dx * dx + (t.y - m.y) ** 2 + dz * dz;
    if (s.key === "rattler") return this.archer(m, t, dh, heading, legs);
    // melee: Shambler and Skitter
    const close = dh < 2.6 && Math.abs(t.y - m.y) < 1.6;
    if (!legs) {
      // flying back from a hit: it only turns to face its target
      m.yaw = wrap(m.yaw + Math.max(-40, Math.min(40, wrap(heading - m.yaw))));
    } else if (close) {
      // up close: face it and come to arm's length, never into the player (there is no body push between them)
      m.path = null;
      m.yaw = wrap(m.yaw + Math.max(-40, Math.min(40, wrap(heading - m.yaw))));
      const stop = m.hw + 0.3 + 0.25;
      if (dh > stop) this.push(m, (dx / dh) * s.chase, (dz / dh) * s.chase);
      else if (dh < stop - 0.2) this.push(m, (-dx / (dh || 1)) * s.chase * 0.5, (-dz / (dh || 1)) * s.chase * 0.5);
      else this.brake(m);
    } else this.chase(m, t, s.chase);
    if (s.climbs) {
      // a Skitter goes straight up a wall it runs into, and leaps from a few blocks away
      m.climbing = m.collidedH && !m.inWater;
      if (legs && m.onGround && m.leapCool === 0 && dh > 2 && dh < 4.5 && Math.random() < 0.1 && this.sees(m.x, this.eyeOf(m), m.z, t.x, t.y + t.eye, t.z)) {
        m.vx = (dx / dh) * 0.4 * 0.8 + m.vx * 0.2;
        m.vz = (dz / dh) * 0.4 * 0.8 + m.vz * 0.2;
        m.vy = 0.4;
        m.leapCool = 40;
      }
    }
    if (m.attackCool === 0 && d2 <= meleeReachSq(s.w) && Math.abs(t.y - m.y) < 1.5) {
      m.attackCool = 20;
      m.swing = 10;
      this.stats.hits++;
      this.hooks.hurtPlayer(t.id, s.damage, `mob:${s.key}`, m.x, m.z, dx / (dh || 1), dz / (dh || 1));
    }
  }

  /** Rattler: close in to about 12 blocks, then hold the distance (strafing), draw and shoot when in sight. */
  private archer(m: Mob, t: MobTarget, dh: number, heading: number, legs = true): void {
    const s = MOB_SPECS[m.kind];
    const sees = this.sees(m.x, this.eyeOf(m), m.z, t.x, t.y + t.eye, t.z);
    m.seen = sees ? m.seen + 1 : Math.max(0, m.seen - 1);
    m.yaw = wrap(m.yaw + Math.max(-30, Math.min(30, wrap(heading - m.yaw))));
    if (!legs) {
      // knocked back: it still draws and shoots, but where it goes is the hit's
    } else if (dh > 12 || m.seen < 20) this.chase(m, t, s.chase);
    else {
      m.path = null;
      if (--m.strafeTimer <= 0) {
        m.strafeTimer = randi(20, 40);
        if (Math.random() < 0.3) m.strafe = -m.strafe;
      }
      const fx = (t.x - m.x) / (dh || 1);
      const fz = (t.z - m.z) / (dh || 1);
      const back = dh < 5 ? -1 : dh > 10 ? 0.6 : 0;
      const sp = s.chase * 0.6;
      // sideways (and back off when close), but never into the safe zone or off a cliff
      const vx = (-fz * m.strafe + fx * back) * sp;
      const vz = (fx * m.strafe + fz * back) * sp;
      if (this.safeStep(m, vx, vz)) this.push(m, vx, vz);
      else {
        m.strafe = -m.strafe;
        this.brake(m);
      }
    }
    if (sees && dh < 16) {
      m.draw++;
      if (m.draw >= 20 && m.attackCool === 0) {
        this.shoot(m, t);
        m.draw = 0;
        m.attackCool = randi(20, 30);
      }
    } else m.draw = Math.max(0, m.draw - 2);
  }

  /** Would a step this way keep it on solid ground outside the safe zone? */
  private safeStep(m: Mob, vx: number, vz: number): boolean {
    const l = Math.hypot(vx, vz) || 1;
    const ax = m.x + (vx / l) * (m.hw + 0.6);
    const az = m.z + (vz / l) * (m.hw + 0.6);
    if (!this.outsideHub(ax, az, 2)) return false;
    const fx = Math.floor(ax);
    const fz = Math.floor(az);
    const fy = Math.floor(m.y + 0.01);
    for (let y = fy; y >= fy - 3; y--) {
      const id = this.block(fx, y, fz);
      if (SOLID[id]) return true;
      if (IS_WATER[id]) return false;
    }
    return false;
  }

  /** An arrow from the Rattler's eyes at the target's chest, led for the drop, with a little spread. */
  private shoot(m: Mob, t: MobTarget): void {
    const sx = m.x;
    const sy = m.y + 1.5;
    const sz = m.z;
    const dx = t.x - sx;
    const dy = t.y + t.h / 3 - sy;
    const dz = t.z - sz;
    const dh = Math.hypot(dx, dz);
    let vx = dx;
    let vy = dy + dh * 0.2;
    let vz = dz;
    const l = Math.hypot(vx, vy, vz) || 1;
    const spread = 0.0075 * 6;
    vx = (vx / l + gauss() * spread) * ARROW_SPEED;
    vy = (vy / l + gauss() * spread) * ARROW_SPEED;
    vz = (vz / l + gauss() * spread) * ARROW_SPEED;
    const a: Arrow = { id: this.nextArrow++, owner: m.id, age: 0, x: sx + (dx / (dh || 1)) * 0.5, y: sy, z: sz + (dz / (dh || 1)) * 0.5, vx, vy, vz };
    if (this.nextArrow > 2_000_000_000) this.nextArrow = 1;
    this.arrows.set(a.id, a);
    this.stats.shots++;
    this.hooks.arrowShot(a);
  }

  /** v7: a player's arrow from (x, y, z) with this velocity (blocks a tick). */
  shootPlayerArrow(player: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, crit: boolean, pickup: boolean): Arrow {
    const a: Arrow = { id: this.nextArrow++, owner: 0, age: 0, x, y, z, vx, vy, vz, player, crit, pickup };
    if (this.nextArrow > 2_000_000_000) this.nextArrow = 1;
    this.arrows.set(a.id, a);
    this.hooks.arrowShot(a);
    return a;
  }

  /** v7: a player's arrow in flight: the first mob or animal in its way this tick (and how far), or null. */
  private playerArrowTarget(a: Arrow, ux: number, uy: number, uz: number, len: number): { t: number; mob: Mob | null; animal: number } | null {
    let best: { t: number; mob: Mob | null; animal: number } | null = null;
    for (const m of this.mobs.values()) {
      if (m.dying || Math.abs(m.x - a.x) > len + 2 || Math.abs(m.z - a.z) > len + 2) continue;
      const t = rayHitsBox(a.x, a.y, a.z, ux, uy, uz, len, m.x, m.y, m.z, m.hw * 2 + 0.3, m.h + 0.1);
      if (t >= 0 && (!best || t < best.t)) best = { t, mob: m, animal: -1 };
    }
    for (const an of this.hooks.animalsNear(a.x, a.z, len + 2)) {
      const t = rayHitsBox(a.x, a.y, a.z, ux, uy, uz, len, an.x, an.y, an.z, an.w + 0.3, an.h + 0.1);
      if (t >= 0 && (!best || t < best.t)) best = { t, mob: null, animal: an.id };
    }
    return best;
  }

  /** v7: stuck arrows: picked up by a player walking over one, or gone after a minute. */
  private tickStuck(players: MobTarget[]): void {
    for (const s of this.stuck.values()) {
      if (++s.age > STUCK_LIFE) {
        this.stuck.delete(s.id);
        this.hooks.arrowGone(s, 0);
        continue;
      }
      if (s.age < 10) continue; // a short moment before it can be taken
      for (const p of players) {
        if (!p.valid || Math.abs(p.x - s.x) > 1 || Math.abs(p.z - s.z) > 1 || s.y < p.y - 0.75 || s.y > p.y + p.h + 0.5) continue;
        if (!this.hooks.pickupArrow(p.id)) continue;
        this.stuck.delete(s.id);
        this.hooks.arrowGone(s, p.id);
        break;
      }
    }
  }

  private tickArrows(players: MobTarget[]): void {
    this.tickStuck(players);
    for (const a of this.arrows.values()) {
      a.age++;
      if (a.age > ARROW_LIFE) {
        this.endArrow(a, false);
        continue;
      }
      const len = Math.hypot(a.vx, a.vy, a.vz) || 1;
      const ux = a.vx / len;
      const uy = a.vy / len;
      const uz = a.vz / len;
      if (a.player !== undefined) {
        // a player's arrow: night mobs and animals in its way, never players
        const hit = this.playerArrowTarget(a, ux, uy, uz, len);
        const bt = arrowBlockHit(a, this.get);
        if (hit && (bt < 0 || hit.t / len <= bt)) {
          a.x += ux * hit.t;
          a.y += uy * hit.t;
          a.z += uz * hit.t;
          let dmg = arrowDamage(a);
          if (a.crit) dmg += randi(0, Math.floor(dmg / 2) + 1);
          const fromX = a.x - a.vx;
          const fromZ = a.z - a.vz;
          if (hit.mob) {
            const r = this.damage(hit.mob, dmg, { x: fromX, z: fromZ, kb: KNOCKBACK, player: a.player });
            this.hooks.arrowStruck(a, hit.mob.id, true, r.dealt, r.killed);
          } else {
            const r = this.hooks.hurtAnimal(hit.animal, dmg, fromX, fromZ);
            this.hooks.arrowStruck(a, hit.animal, false, r.dealt, r.killed);
          }
          this.stats.hits++;
          this.endArrow(a, false);
          continue;
        }
        if (bt >= 0) {
          a.x += a.vx * bt;
          a.y += a.vy * bt;
          a.z += a.vz * bt;
          this.endArrow(a, true);
          if (a.pickup) {
            this.stuck.set(a.id, { id: a.id, x: a.x, y: a.y, z: a.z, age: 0 });
            if (this.stuck.size > STUCK_MAX) {
              const oldest = this.stuck.values().next().value!;
              this.stuck.delete(oldest.id);
              this.hooks.arrowGone(oldest, 0);
            }
          }
          continue;
        }
        arrowMove(a, this.get);
        if (!this.outsideHub(a.x, a.z, 0) || a.y < 0) this.endArrow(a, false);
        continue;
      }
      let hitP: MobTarget | null = null;
      let ht = Infinity;
      for (const p of players) {
        if (!p.valid) continue;
        if (Math.abs(p.x - a.x) > len + 2 || Math.abs(p.z - a.z) > len + 2) continue;
        const t = rayHitsBox(a.x, a.y, a.z, ux, uy, uz, len, p.x, p.y, p.z, 0.6 + 0.3, p.h + 0.1);
        if (t >= 0 && t < ht) {
          ht = t;
          hitP = p;
        }
      }
      const bt = arrowBlockHit(a, this.get);
      if (hitP && (bt < 0 || ht / len <= bt)) {
        a.x += ux * ht;
        a.y += uy * ht;
        a.z += uz * ht;
        const dmg = arrowDamage(a);
        const hl = Math.hypot(a.vx, a.vz) || 1;
        this.hooks.hurtPlayer(hitP.id, dmg, "mob:rattler", a.x - a.vx, a.z - a.vz, a.vx / hl, a.vz / hl);
        this.endArrow(a, false);
        continue;
      }
      if (bt >= 0) {
        a.x += a.vx * bt;
        a.y += a.vy * bt;
        a.z += a.vz * bt;
        this.endArrow(a, true);
        continue;
      }
      arrowMove(a, this.get);
      if (!this.outsideHub(a.x, a.z, 0) || a.y < 0) this.endArrow(a, false);
    }
  }

  private endArrow(a: Arrow, stuck: boolean): void {
    this.arrows.delete(a.id);
    this.hooks.arrowEnded(a, stuck);
  }

  // ---------------------------------------------------------------- movement

  private brake(m: Mob): void {
    if (m.onGround) {
      m.vx *= 0.5;
      m.vz *= 0.5;
    }
  }

  private push(m: Mob, tvx: number, tvz: number): void {
    const control = m.onGround ? 1 : m.inWater ? 0.5 : m.climbing ? 0.6 : 0.2;
    m.vx += (tvx - m.vx) * control;
    m.vz += (tvz - m.vz) * control;
  }

  /** Follow a path to the target (re-planned when the target moves on or the path runs out). Close by, level and in
   *  plain sight it just walks straight at it (no search: most of a chase in the open). */
  private chase(m: Mob, t: MobTarget, speed: number): void {
    const dh = Math.hypot(t.x - m.x, t.z - m.z);
    if (dh < 8 && Math.abs(t.y - m.y) < 1.2) {
      if (m.losAt <= 0) {
        m.losAt = 5;
        m.los = this.sees(m.x, this.eyeOf(m), m.z, t.x, t.y + t.eye, t.z) && this.sees(m.x, m.y + 0.5, m.z, t.x, t.y + 0.5, t.z);
      }
      if (m.los) m.path = null;
    } else m.los = false;
    m.losAt--;
    const moved = Math.hypot(t.x - m.goalX, t.z - m.goalZ) > 2;
    if (!m.los && (!m.path || (moved && m.replan <= 0)) && (m.onGround || m.inWater || m.climbing) && this.searches < 3) {
      this.searches++;
      this.stats.searches++;
      m.replan = randi(20, 30);
      m.goalX = t.x;
      m.goalZ = t.z;
      const s = this.pf.search(m.x, m.y, m.z, { hw: m.hw, h: m.h, maxNodes: 360, radius: 22, water: true }, { x: Math.floor(t.x), z: Math.floor(t.z) });
      if (s) {
        const end = s.reached >= 0 ? s.reached : s.closestTo(t.x, t.z);
        // never into the safe zone: the path stops at its edge
        const path = s.pathTo(end);
        const cut = path.findIndex((q) => !this.outsideHub(q.x + 0.5, q.z + 0.5, 2));
        const keep = cut >= 0 ? path.slice(0, cut) : path;
        m.path = keep.length ? keep : null;
        m.pi = 0;
        m.prog = 0;
        m.px = m.x;
        m.pz = m.z;
      }
    }
    if (m.path) this.follow(m, speed);
    else {
      // no path yet (or none): straight at it, hopping steps
      const dx = t.x - m.x;
      const dz = t.z - m.z;
      const d = Math.hypot(dx, dz) || 1;
      if (!this.safeStep(m, dx, dz) && !MOB_SPECS[m.kind].climbs) return this.brake(m);
      m.yaw = wrap(m.yaw + Math.max(-30, Math.min(30, wrap((Math.atan2(-dx, dz) * 180) / Math.PI - m.yaw))));
      this.push(m, (dx / d) * speed, (dz / d) * speed);
      if (m.collidedH && m.onGround && m.jumpCool === 0 && !MOB_SPECS[m.kind].climbs) this.jump(m);
    }
  }

  private follow(m: Mob, speed: number): void {
    const path = m.path!;
    let wp = path[m.pi];
    let dx = wp.x + 0.5 - m.x;
    let dz = wp.z + 0.5 - m.z;
    let d = Math.hypot(dx, dz);
    const last = m.pi === path.length - 1;
    if (d < (last ? 0.4 : 0.6) && m.y > wp.f - 0.45 && (m.onGround || m.inWater || m.climbing || last)) {
      m.pi++;
      if (m.pi >= path.length) {
        m.path = null;
        return;
      }
      wp = path[m.pi];
      dx = wp.x + 0.5 - m.x;
      dz = wp.z + 0.5 - m.z;
      d = Math.hypot(dx, dz);
    }
    const heading = (Math.atan2(-dx, dz) * 180) / Math.PI;
    m.yaw = wrap(m.yaw + Math.max(-40, Math.min(40, wrap(heading - m.yaw))));
    const off = Math.abs(wrap(heading - m.yaw));
    const k = off > 80 ? 0.3 : off > 40 ? 0.7 : 1;
    this.push(m, (dx / (d || 1)) * speed * k, (dz / (d || 1)) * speed * k);
    const rise = wp.f - m.y;
    if (rise > STEP - 0.05 && m.jumpCool === 0 && m.onGround && (m.collidedH || d < m.hw + 0.85)) this.jump(m);
    else if (m.collidedH && m.onGround && m.jumpCool === 0) this.jump(m);
    // stuck: barely moved in a second while following: plan again
    if (++m.prog >= 20) {
      const moved = Math.hypot(m.x - m.px, m.z - m.pz);
      m.prog = 0;
      m.px = m.x;
      m.pz = m.z;
      if (moved < 0.3) {
        m.path = null;
        m.replan = 0;
      }
    }
  }

  private jump(m: Mob): void {
    m.vy = JUMP_VELOCITY;
    m.jumpCool = 8;
  }

  /** No target: stand about, now and then walk to a spot a few blocks away (never toward the safe zone). */
  private wander(m: Mob, speed: number): void {
    m.climbing = false;
    if (m.path) {
      this.follow(m, speed);
      if (m.timer <= 0) m.path = null;
      return;
    }
    this.brake(m);
    if (m.timer > 0 || !m.onGround || this.searches >= 5) return;
    this.searches++;
    m.timer = randi(80, 220);
    const s = this.pf.search(m.x, m.y, m.z, { hw: m.hw, h: m.h, maxNodes: 200, radius: 8, water: false });
    if (!s) return;
    const picks: number[] = [];
    for (let i = 1; i < s.pts.length; i++) {
      const q = s.pts[i];
      if (s.cost[i] < 3 || s.cost[i] > 9 || q.water || !this.outsideHub(q.x + 0.5, q.z + 0.5, 3)) continue;
      picks.push(i);
    }
    if (!picks.length) return;
    m.path = s.pathTo(picks[randi(0, picks.length - 1)]);
    m.pi = 0;
    m.prog = 0;
    m.px = m.x;
    m.pz = m.z;
  }

  private physics(m: Mob): void {
    m.inWater = bodyInWater(this.get, m);
    if (m.inWater) {
      m.vy += 0.04;
      const [fx, fz] = flowAt(this.bget, m.x, m.y + 0.3, m.z);
      m.vx += fx;
      m.vz += fz;
      const ivx = m.vx;
      const ivz = m.vz;
      moveBody(this.get, m, m.vx, m.vy, m.vz);
      m.vx *= 0.8;
      m.vz *= 0.8;
      m.vy = m.vy * 0.8 - 0.02;
      if (m.collidedH && !boxHitsSolid(this.get, m.x - m.hw + ivx, m.y + 0.6, m.z - m.hw + ivz, m.x + m.hw + ivx, m.y + m.h + 0.6, m.z + m.hw + ivz)) m.vy = 0.3;
    } else if (m.onGround && Math.abs(m.vx) < 0.002 && Math.abs(m.vz) < 0.002 && m.vy <= 0 && m.hurt === 0 && !m.climbing) {
      m.vx = m.vz = 0;
      m.vy = REST_VY;
      if (!boxHitsSolid(this.get, m.x - m.hw, m.y - 0.05, m.z - m.hw, m.x + m.hw, m.y, m.z + m.hw)) m.onGround = false;
    } else {
      const climb = m.climbing && m.collidedH;
      moveBody(this.get, m, m.vx, climb ? 0.2 : m.vy, m.vz);
      if (climb) m.vy = 0.2;
      else m.vy = (m.vy - GRAVITY) * DRAG_Y;
      if (!m.onGround) {
        m.vx *= 0.91;
        m.vz *= 0.91;
      }
    }
    for (let k = 0; k < 3 && bodyInsideSolid(this.get, m, 0.1); k++) m.y = Math.floor(m.y) + 1;
    m.x = Math.max(m.hw + 0.01, Math.min(WORLD_SIZE - m.hw - 0.01, m.x));
    m.z = Math.max(m.hw + 0.01, Math.min(WORLD_SIZE - m.hw - 0.01, m.z));
    let f = 0;
    if (Math.hypot(m.vx, m.vz) > 0.01) f |= MF.MOVING;
    if (m.target) f |= MF.AGGRO;
    if (m.hurt > 0) f |= MF.HURT;
    if (m.onGround) f |= MF.GROUND;
    if (m.swing > 0 || m.draw > 0) f |= MF.ATTACK;
    if (m.climbing && m.collidedH) f |= MF.CLIMB;
    if (m.dying) f |= MF.DEAD;
    if (m.burn > 0) f |= MF.BURN;
    m.flags = f;
    const key = ((Math.round(m.x * 32) * 73856093) ^ (Math.round(m.y * 32) * 19349663) ^ (Math.round(m.z * 32) * 83492791) ^ (Math.round((((m.yaw % 360) + 360) % 360) * (256 / 360)) << 8) ^ f) | 0;
    if (key !== m.key) {
      m.key = key;
      m.version++;
    }
  }

  // ---------------------------------------------------------------- sync

  /** What to send one player this tick: changed mobs in range (10 Hz near, 5 Hz far) and the ones gone. */
  messages(p: { x: number; z: number }, seen: Map<number, number>, tick: number): Uint8Array[] {
    const out: Uint8Array[] = [];
    const list: AnimalSnap[] = [];
    const gone: number[] = [];
    for (const m of this.mobs.values()) {
      const dx = m.x - p.x;
      const dz = m.z - p.z;
      const d2 = dx * dx + dz * dz;
      const last = seen.get(m.id);
      if (d2 > MOB_RANGE_OUT * MOB_RANGE_OUT) {
        if (last !== undefined) {
          gone.push(m.id);
          seen.delete(m.id);
        }
        continue;
      }
      if (d2 > MOB_RANGE * MOB_RANGE && last === undefined) continue;
      if (last === m.version) continue;
      if (last !== undefined && d2 > 32 * 32 && tick % 4 !== 0) continue;
      list.push({ id: m.id, kind: m.kind, x: m.x, y: m.y, z: m.z, yaw: m.yaw, flags: m.flags });
      seen.set(m.id, m.version);
    }
    for (const id of this.removed) if (seen.delete(id)) gone.push(id);
    if (list.length) out.push(encodeAnimals(tick, list, OP_MOBS));
    if (gone.length) out.push(encodeGone(gone, OP_MOBS_GONE));
    return out;
  }

  flushRemoved(): void {
    this.removed.length = 0;
  }

  clear(): void {
    for (const id of [...this.mobs.keys()]) this.remove(id);
    this.arrows.clear();
    this.stuck.clear();
  }
}
