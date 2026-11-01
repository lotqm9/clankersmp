// Health and hunger (protocol v5), Java Edition's rules on Normal difficulty:
//   - exhaustion builds up from sprinting, swimming, jumping, breaking blocks, attacking and taking damage; every 4.0
//     costs one saturation point, or one hunger point when saturation is gone
//   - with hunger 18+ you heal half a heart every 4 s (costs exhaustion); at a full bar with saturation left, every
//     half second
//   - at hunger 0 you lose half a heart every 4 s, down to half a heart (Normal never starves you to death)
//   - falls hurt 1 per block beyond SAFE_FALL (Java's fall distance: the landing tick does not count); drowning: 15 s
//     of air, then 2 every second
//   - v6: spoiled flesh usually makes you queasy for 30 s: 0.005 extra exhaustion a tick (the food bar turns green)
//   - update 10.1 (Laith, "make food last longer"): every activity and natural healing costs half Java's exhaustion
//     (HUNGER_RATE), so a full bar lasts about twice as long. Food values, starving and the bar are unchanged.
//   - update 12.1 (Laith, "losing hunger slower"): a quarter of Java's exhaustion, twice as long again; and ("fall
//     damage is a bit too sensitive") falls are free up to 4 blocks of fall distance instead of Java's 3.
//   - update 12.1.2 (Laith, "fall damage so sensitive and im taking damage for no reason"): falls are free up to 6
//     and cost half (SAFE_FALL, fallDamage), and a client that says it is standing on something restarts the fall
//     there (FallTracker), so a block the server can't see under the player never turns into a phantom fall.
// The server runs these (the authority); the client only shows the numbers it is sent.

import { boxHitsSolid, type GetBlock } from "./physics.ts";

export const MAX_HP = 20;
export const MAX_FOOD = 20;
export const MAX_AIR = 300;
export const START_SAT = 5;
export const HURT_TICKS = 10; // invulnerable for half a second after a hit

export interface Body {
  hp: number;
  food: number;
  sat: number;
  exh: number;
  air: number;
  foodTimer: number;
  queasy: number; // v6: ticks of extra hunger left (spoiled flesh)
}

export function newBody(): Body {
  return { hp: MAX_HP, food: MAX_FOOD, sat: START_SAT, exh: 0, air: MAX_AIR, foodTimer: 0, queasy: 0 };
}

export const QUEASY_TICKS = 600; // 30 s
export const QUEASY_EXHAUST = 0.005; // per tick (Java's Hunger I)

/** Java's exhaustion for each activity (Normal). */
export const JAVA_EXHAUST = {
  sprintPerBlock: 0.1,
  swimPerBlock: 0.01,
  jump: 0.05,
  sprintJump: 0.2,
  breakBlock: 0.005,
  attack: 0.1,
  damage: 0.1,
  heal: 6,
} as const;

/** Update 10.1: hunger drains at half Java's rate; 12.1: a quarter; 13 (Laith, "make sure hunger is less quicker to go"): an eighth. */
export const HUNGER_RATE = 0.125;

/** What each activity costs here: Java's numbers times HUNGER_RATE. */
export const EXHAUST = Object.fromEntries(
  Object.entries(JAVA_EXHAUST).map(([k, v]) => [k, v * HUNGER_RATE]),
) as { readonly [K in keyof typeof JAVA_EXHAUST]: number };

export function exhaust(b: Body, amount: number): void {
  b.exh = Math.min(40, b.exh + amount);
}

/** One tick of hunger and natural healing. `safe`: in the spawn safe zone (no starving damage). `rate` scales what
 *  healing costs (the tests pass 1 to compare with Java). Returns damage to apply this tick (starvation) and whether
 *  anything visible changed. */
export function tickFood(b: Body, safe: boolean, rate = HUNGER_RATE): { starve: number; changed: boolean } {
  let changed = false;
  if (b.queasy > 0) {
    exhaust(b, QUEASY_EXHAUST);
    if (--b.queasy === 0) changed = true;
  }
  if (b.exh >= 4) {
    b.exh -= 4;
    if (b.sat > 0) b.sat = Math.max(0, b.sat - 1);
    else b.food = Math.max(0, b.food - 1);
    changed = true;
  }
  let starve = 0;
  if (b.food >= MAX_FOOD && b.sat > 0 && b.hp > 0 && b.hp < MAX_HP) {
    if (++b.foodTimer >= 10) {
      const k = Math.min(b.sat, 6);
      b.hp = Math.min(MAX_HP, b.hp + 1);
      exhaust(b, k * rate);
      b.foodTimer = 0;
      changed = true;
    }
  } else if (b.food >= 18 && b.hp > 0 && b.hp < MAX_HP) {
    if (++b.foodTimer >= 80) {
      b.hp = Math.min(MAX_HP, b.hp + 1);
      exhaust(b, JAVA_EXHAUST.heal * rate);
      b.foodTimer = 0;
      changed = true;
    }
  } else if (b.food <= 0) {
    if (++b.foodTimer >= 80) {
      if (b.hp > 1 && !safe) starve = 1;
      b.foodTimer = 0;
    }
  } else b.foodTimer = 0;
  return { starve, changed };
}

/** Eat a food item: hunger and saturation (saturation never above hunger). */
export function eat(b: Body, hunger: number, sat: number): void {
  b.food = Math.min(MAX_FOOD, b.food + hunger);
  b.sat = Math.min(b.food, b.sat + sat);
}

export const EAT_TICKS = 32; // 1.6 s

/** The fall distance you can take for free (Java: 3; 12.1: 4; 12.1.2, Laith "fall damage so sensitive": 6, so a
 *  7-block drop, which counts 6.59, is the first that hurts). */
export const SAFE_FALL = 6;

/** Fall damage for a fall distance of `blocks`: 12.1.2, half Java's, ceil((distance - SAFE_FALL) / 2) half hearts.
 *  A 10-block drop costs 2 (one heart; Java 7), a 20-block drop 7. */
export function fallDamage(blocks: number): number {
  return blocks > SAFE_FALL ? Math.ceil((blocks - SAFE_FALL) / 2) : 0;
}

/** Java's fall distance for a drop of `h` blocks from rest. Java adds each tick's downward movement while in the air
 *  but not the tick that lands (it checks the ground first), so a 3-block drop counts 2.69, a 4-block drop 3.35 and a
 *  10-block drop 9.67. The server sees positions 10 times a second, so it works this out from the height instead. */
export function javaFallDistance(h: number): number {
  let m = 0.0784; // the first tick off a ledge (or just past the top of a jump)
  let cum = 0;
  for (let k = 0; k < 2000; k++) {
    if (cum + m >= h - 1e-6) return cum;
    cum += m;
    m = (m + 0.08) * 0.98;
  }
  return cum;
}

/** Standing on something, as the server judges it from a reported position: a collision box right under the feet,
 *  anywhere under the box's path since the last report. Java moves the vertical axis first, so a player who lands
 *  and steps on in the same tick is "on the ground" with the box already past the edge; positions arrive every
 *  other tick, so the path since the previous one counts too. */
export function groundedAlong(get: GetBlock, x: number, y: number, z: number, px: number, pz: number): boolean {
  return boxHitsSolid(get, Math.min(x, px) - 0.3, y - 0.05, Math.min(z, pz) - 0.3, Math.max(x, px) + 0.3, y, Math.max(z, pz) + 0.3);
}

/** Fall damage, judged by the server from the positions players send (Java rules): the highest point since you
 *  left the ground, to where you land; water, ladders and server corrections or teleports start it over. */
export class FallTracker {
  top: number | null = null;
  /** v7: the fall distance of the landing on the last update (0 if it was not a landing): farmland tramples. */
  landed = 0;

  /** After an accepted move from `prevY` to `y`. Returns the damage to apply now (half hearts). `clientGround`: the
   *  player's own client says it is standing on something (12.1.2). */
  update(y: number, prevY: number, grounded: boolean, soft: boolean, clientGround = false): number {
    this.landed = 0;
    if (soft) {
      this.top = null;
      return 0;
    }
    if (!grounded && clientGround) {
      // 12.1.2: the client stands on a block the server doesn't see under it (a block it predicted, a lag spike).
      // Start the fall over from here, so the server never charges a fall from a height the player was standing at.
      this.top = y;
      return 0;
    }
    if (grounded) {
      const dist = this.top === null ? 0 : javaFallDistance(this.top - y);
      this.landed = dist;
      this.top = null;
      return fallDamage(dist);
    }
    this.top = Math.max(this.top ?? Math.max(y, prevY), y);
    return 0;
  }

  reset(): void {
    this.top = null;
  }
}

/** One tick of breath: under water the air runs down (then 2 damage a second), otherwise it comes back fast. */
export function tickAir(b: Body, underwater: boolean): number {
  if (underwater) {
    b.air--;
    if (b.air <= -20) {
      b.air = 0;
      return 2;
    }
    return 0;
  }
  b.air = Math.min(MAX_AIR, b.air + 4);
  return 0;
}

/** Death messages, in plain words (no other game's phrasing needed). */
export function deathMessage(name: string, cause: string): string {
  switch (cause) {
    case "fall":
      return `${name} fell from a high place`;
    case "drown":
      return `${name} drowned`;
    case "starve":
      return `${name} starved`;
    case "void":
      return `${name} fell out of the world`;
    case "fire":
      return `${name} went up in flames`;
    case "mob:shambler":
      return `${name} was caught by a Shambler`;
    case "mob:rattler":
      return `${name} was shot by a Rattler`;
    case "mob:skitter":
      return `${name} was bitten by a Skitter`;
    default:
      if (cause.startsWith("player:")) return `${name} was killed by ${cause.slice(7)}`; // clankersmp
      return `${name} died`;
  }
}
