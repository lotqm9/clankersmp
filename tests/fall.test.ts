// Fall damage like Java (update 7.1): a real player body (shared/physics.ts, the client's own physics) walks off
// ledges, jumps and goes down steps, and the server's judgement (FallTracker fed with positions 10 times a second,
// "grounded" from the collision boxes under the feet along the path since the last position, water and ladders
// soft) must give Java's numbers: 3 blocks 0, 4 blocks
// 1, 10 blocks 7, jumps and stairs 0, landing in water 0, and a server correction mid-air starts the fall over.

import { test } from "node:test";
import assert from "node:assert/strict";
import { B, CLIMB, IS_WATER } from "../shared/blocks.ts";
import { newPhysState, tickPlayer, type GetBlock, type MoveInput } from "../shared/physics.ts";
import { FallTracker, fallDamage, groundedAlong, javaFallDistance } from "../shared/survival.ts";

const FLOOR = 40; // the ground's top surface (blocks at y 39 and below)

/** A world: stone below FLOOR, plus `extra` cells. */
function world(extra: (x: number, y: number, z: number) => number): GetBlock {
  return (x, y, z) => {
    const e = extra(x, y, z);
    if (e >= 0) return e;
    return y < FLOOR ? B.STONE : B.AIR;
  };
}


function soft(get: GetBlock, x: number, y: number, z: number): boolean {
  const feet = get(Math.floor(x), Math.floor(y), Math.floor(z));
  const head = get(Math.floor(x), Math.floor(y + 1), Math.floor(z));
  return !!(IS_WATER[feet] || IS_WATER[head] || CLIMB[feet] || CLIMB[head]);
}

interface Run {
  damage: number;
  hits: number;
}

/** Walk (and maybe jump) for `ticks`, sending the server a position every 2 ticks like the client does. */
function play(get: GetBlock, x: number, y: number, z: number, ticks: number, input: Partial<MoveInput>, opts: { correctAt?: (s: { y: number }) => boolean } = {}): Run {
  const s = newPhysState(x, y, z);
  s.onGround = true;
  const fall = new FallTracker();
  let prevY = y;
  let prevX = x;
  let prevZ = z;
  const run: Run = { damage: 0, hits: 0 };
  let corrected = false;
  for (let t = 1; t <= ticks; t++) {
    tickPlayer(s, { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, yaw: 0, ...input }, get);
    if (t % 2) continue;
    if (!corrected && opts.correctAt?.(s)) {
      // the server pulls the player back to this (valid) spot: a correction resets the fall
      corrected = true;
      fall.reset();
      [prevX, prevY, prevZ] = [s.x, s.y, s.z];
      continue;
    }
    const d = fall.update(s.y, prevY, groundedAlong(get, s.x, s.y, s.z, prevX, prevZ), soft(get, s.x, s.y, s.z));
    if (d > 0) {
      run.damage += d;
      run.hits++;
    }
    [prevX, prevY, prevZ] = [s.x, s.y, s.z];
  }
  return run;
}

/** A platform `h` blocks high for z < 10; walk +z off its edge. */
const ledge = (h: number) => world((_x, y, z) => (z < 10 && y >= FLOOR && y < FLOOR + h ? B.STONE : -1));

test("Java's fall distance: the tick that lands doesn't count", () => {
  assert.ok(Math.abs(javaFallDistance(3) - 2.6944) < 0.01, `${javaFallDistance(3)}`);
  assert.ok(Math.abs(javaFallDistance(4) - 3.3461) < 0.01, `${javaFallDistance(4)}`);
  assert.ok(Math.abs(javaFallDistance(10) - 9.6667) < 0.01, `${javaFallDistance(10)}`);
  assert.deepEqual([3, 3.5, 4, 5, 10, 23].map((h) => fallDamage(javaFallDistance(h))), [0, 0, 0, 0, 2, 8]);
});

test("walking off a ledge (12.1.2, safe to 6, half damage): 6 blocks 0, 7 blocks 1 (half a heart), 10 blocks 2", () => {
  for (const [h, want] of [[1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 1], [10, 2]]) {
    const r = play(ledge(h), 8.5, FLOOR + h, 8.5, 80, { forward: 1 });
    assert.equal(r.damage, want, `a ${h}-block drop does ${r.damage}`);
    assert.ok(r.hits <= 1, "one landing, one hit");
  }
});

test("sprint-jumping off a 2-block ledge does nothing; off a 3-block ledge, half a heart at most", () => {
  const two = play(ledge(2), 8.5, FLOOR + 2, 8.5, 80, { forward: 1, sprint: true, jump: true });
  assert.equal(two.damage, 0, "2 blocks + a jump");
  const three = play(ledge(3), 8.5, FLOOR + 3, 8.5, 80, { forward: 1, sprint: true, jump: true });
  assert.ok(three.damage <= 1, `3 blocks + a jump: ${three.damage}`);
});

test("jumping on flat ground, over and over, never hurts", () => {
  const r = play(world(() => -1), 8.5, FLOOR, 8.5, 400, { forward: 1, jump: true, sprint: true });
  assert.equal(r.damage, 0);
});

test("walking (and sprint-jumping) down a staircase of 1-block steps and a slab ramp: no damage", () => {
  // steps: one block lower every block in +z, 12 steps
  const steps = world((_x, y, z) => (z >= 0 && z < 14 && y >= FLOOR && y < FLOOR + Math.max(0, 12 - z) ? B.STONE : -1));
  assert.equal(play(steps, 8.5, FLOOR + 12, 0.5, 200, { forward: 1 }).damage, 0, "walking down");
  // half steps: a slab, then a full block lower, alternating
  const ramp = world((_x, y, z) => {
    if (z < 0 || z >= 20) return -1;
    const top = 10 - z * 0.5; // surface height above the floor
    const full = Math.floor(top);
    if (y < FLOOR) return -1;
    if (y < FLOOR + full) return B.STONE;
    if (y === FLOOR + full && top - full >= 0.5) return B.STONE_SLAB;
    return -1;
  });
  assert.equal(play(ramp, 8.5, FLOOR + 10, 0.5, 200, { forward: 1, sprint: true }).damage, 0, "a slab ramp");
});

test("landing in water never hurts, from any height", () => {
  const pool = world((_x, y, z) => (z < 10 && y >= FLOOR && y < FLOOR + 20 ? B.STONE : z >= 10 && z < 20 && y >= FLOOR - 3 && y < FLOOR + 1 ? B.WATER : -1));
  assert.equal(play(pool, 8.5, FLOOR + 20, 8.5, 120, { forward: 1 }).damage, 0);
});

test("a ladder breaks the fall: climbing down a tall ladder and stepping off is safe", () => {
  // a 12-high wall at z = 10 with a ladder on its +z side at z = 11 (falling down the ladder column)
  const L = world((_x, y, z) => (z === 10 && y >= FLOOR && y < FLOOR + 12 ? B.STONE : z === 11 && y >= FLOOR && y < FLOOR + 12 ? B.LADDER : -1));
  assert.equal(play(L, 8.5, FLOOR + 12, 11.5, 200, {}).damage, 0);
});

test("a server correction mid-air starts the fall over (no damage from the part before it)", () => {
  // a 10-block drop, corrected when the player is 2 blocks above the ground: what's left is a 2-block fall
  const r = play(ledge(10), 8.5, FLOOR + 10, 8.5, 80, { forward: 1 }, { correctAt: (s) => s.y < FLOOR + 2.2 });
  assert.equal(r.damage, 0);
  // and without the correction it is the full 2 (12.1.2)
  assert.equal(play(ledge(10), 8.5, FLOOR + 10, 8.5, 80, { forward: 1 }).damage, 2);
});

test("12.1.2: a client standing on a block the server can't see restarts the fall there (no phantom fall)", () => {
  const f = new FallTracker();
  // up on something only the client has, 12 blocks above the ground: the server sees no ground, the client does
  for (let i = 0; i < 20; i++) assert.equal(f.update(12, 12, false, false, true), 0);
  // a real 1-block step down onto the server's ground: no damage (it would have been a 12-block fall before)
  assert.equal(f.update(11.5, 12, false, false, false), 0);
  assert.equal(f.update(11, 11.5, true, false, false), 0);
  // without the client's word, the same path is a real fall from 12 to 0
  const g = new FallTracker();
  g.update(12, 12, false, false, false);
  assert.equal(g.update(0, 12, true, false, false), fallDamage(javaFallDistance(12)));
});
