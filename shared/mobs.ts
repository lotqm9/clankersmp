// Night mobs (protocol v6): three original creatures that come out in the dark. The server owns them (AI, physics,
// combat); clients interpolate the snapshots and draw them. The sync format is the animals' (11 bytes per mob, see
// shared/animals.ts) under its own ops, and arrows fly the same way on both sides (arrowStep), so a client draws an
// arrow from the moment it is shot without any further traffic until it lands.
//
//   Shambler  an undead walker in sackcloth: slow, follows you, hits for a heart and a half; burns in daylight
//   Rattler   a hooded bone archer: keeps its distance and shoots arrows; burns in daylight
//   Skitter   a low eight-legged crawler: fast, climbs walls, leaps at you; calm in daylight (unless hit)

import { IS_WATER, SOLID } from "./blocks.ts";
import { WORLD_HEIGHT, WORLD_SIZE } from "./constants.ts";
import type { GetBlock } from "./physics.ts";

export const MOB = { SHAMBLER: 0, RATTLER: 1, SKITTER: 2 } as const;

export interface MobSpec {
  key: "shambler" | "rattler" | "skitter";
  name: string;
  w: number; // box width (x and z), blocks
  h: number; // box height
  hp: number; // half hearts
  damage: number; // melee damage (half hearts); the Rattler's arrows deal ceil(speed x 2)
  walk: number; // wandering speed, blocks per tick
  chase: number; // chasing speed
  sight: number; // notices a player this close (with a clear line of sight)
  follow: number; // gives up beyond this
  burns: boolean; // catches fire in daylight under the open sky
  climbs: boolean; // walks up walls
  weight: number; // how common
  armor: number; // natural armour points (the classic undead walker has 2)
}

export const MOB_SPECS: MobSpec[] = [
  { key: "shambler", name: "Shambler", w: 0.6, h: 1.95, hp: 20, damage: 3, walk: 0.045, chase: 0.115, sight: 20, follow: 35, burns: true, climbs: false, weight: 5, armor: 2 },
  { key: "rattler", name: "Rattler", w: 0.6, h: 1.99, hp: 20, damage: 2, walk: 0.045, chase: 0.1, sight: 16, follow: 24, burns: true, climbs: false, weight: 3, armor: 0 },
  { key: "skitter", name: "Skitter", w: 1.4, h: 0.9, hp: 16, damage: 2, walk: 0.06, chase: 0.15, sight: 16, follow: 24, burns: false, climbs: true, weight: 2, armor: 0 },
];

/** Mob flags on the wire. */
export const MF = {
  MOVING: 1,
  AGGRO: 2, // has a target (arms up, eyes on you)
  HURT: 4, // half a second after a hit: red flash, and the hurt sound on its rising edge
  GROUND: 8,
  ATTACK: 16, // a melee swing, or the bow drawn
  CLIMB: 32, // a Skitter going up a wall
  DEAD: 64, // dying: tips over, then it's gone
  BURN: 128, // on fire
} as const;

// S2C ops (binary): the same layout as the animals' ops 20 and 21
export const OP_MOBS = 25;
export const OP_MOBS_GONE = 26;

/** How far mobs are tracked for a player (blocks, horizontal), and the hysteresis before "gone". */
export const MOB_RANGE = 72;
export const MOB_RANGE_OUT = 80;

/** Java's melee reach for a mob of width `w` against a player (0.6 wide): squared, from the mob's position to the
 *  target's feet. (2w)^2 + 0.6: about 1.4 blocks for a walker, 2.9 for a wide crawler. */
export const meleeReachSq = (w: number) => 4 * w * w + 0.6;

// ---------------------------------------------------------------- arrows

export const ARROW_GRAVITY = 0.05;
export const ARROW_DRAG = 0.99;
export const ARROW_WATER_DRAG = 0.6;
export const ARROW_SPEED = 1.6; // a Rattler's shot, blocks per tick
export const ARROW_LIFE = 100; // ticks in flight before it is gone

export interface ArrowState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

/** Where along this tick's path (0..1) the arrow first meets a solid block, or -1. Small steps, like a ray march. */
export function arrowBlockHit(a: ArrowState, get: GetBlock): number {
  const len = Math.hypot(a.vx, a.vy, a.vz);
  const n = Math.max(1, Math.ceil(len / 0.1));
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    const x = Math.floor(a.x + a.vx * t);
    const y = Math.floor(a.y + a.vy * t);
    const z = Math.floor(a.z + a.vz * t);
    if (x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE || y < 0) return t;
    if (y >= WORLD_HEIGHT) continue;
    if (SOLID[get(x, y, z)]) return Math.max(0, (k - 1) / n);
  }
  return -1;
}

/** One tick of flight after a hit test: move, then drag (stronger in water) and gravity (Java's order). */
export function arrowMove(a: ArrowState, get: GetBlock): void {
  a.x += a.vx;
  a.y += a.vy;
  a.z += a.vz;
  const bx = Math.floor(a.x);
  const by = Math.floor(a.y);
  const bz = Math.floor(a.z);
  const wet = bx >= 0 && bz >= 0 && bx < WORLD_SIZE && bz < WORLD_SIZE && by >= 0 && by < WORLD_HEIGHT && IS_WATER[get(bx, by, bz)];
  const drag = wet ? ARROW_WATER_DRAG : ARROW_DRAG;
  a.vx *= drag;
  a.vy = a.vy * drag - ARROW_GRAVITY;
  a.vz *= drag;
}

/** An arrow's damage when it lands at its current speed (Java: ceil(speed x 2)). */
export const arrowDamage = (a: ArrowState) => Math.max(1, Math.ceil(Math.hypot(a.vx, a.vy, a.vz) * 2));
