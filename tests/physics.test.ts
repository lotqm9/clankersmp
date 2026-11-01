// Physics unit tests: Java Edition movement numbers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { B } from "../shared/blocks.ts";
import { newPhysState, tickPlayer, type GetBlock, type MoveInput } from "../shared/physics.ts";

const flat: GetBlock = (_x, y) => (y < 64 ? B.STONE : B.AIR);
const idle = (yaw = 0): MoveInput => ({ forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, yaw });

function settle(get: GetBlock, x: number, y: number, z: number) {
  const s = newPhysState(x, y, z);
  for (let i = 0; i < 40; i++) tickPlayer(s, idle(), get);
  return s;
}

test("standing on flat ground is stable and on ground", () => {
  const s = settle(flat, 100.5, 64, 100.5);
  assert.equal(s.onGround, true);
  assert.equal(s.y, 64);
});

test("a jump peaks at ~1.2522 blocks (Java: 0.42 initial, 0.08 gravity, 0.98 drag)", () => {
  const s = settle(flat, 100.5, 64, 100.5);
  let peak = 0;
  let airTicks = 0;
  tickPlayer(s, { ...idle(), jump: true }, flat);
  for (let i = 0; i < 40; i++) {
    peak = Math.max(peak, s.y - 64);
    if (!s.onGround) airTicks++;
    tickPlayer(s, idle(), flat);
  }
  assert.ok(Math.abs(peak - 1.2522) < 0.002, `peak ${peak}`);
  assert.equal(s.y, 64);
  assert.ok(airTicks >= 11 && airTicks <= 13, `air ticks ${airTicks}`);
});

function wall(height: number): GetBlock {
  return (x, y) => (y < 64 ? B.STONE : x === 103 && y < 64 + height ? B.STONE : B.AIR);
}

test("jumping clears a 1-block wall", () => {
  const get = wall(1);
  const s = settle(get, 100.5, 64, 100.5);
  for (let i = 0; i < 80; i++) tickPlayer(s, { ...idle(-90), forward: 1, jump: true }, get);
  assert.ok(s.x > 104, `x ${s.x}`);
});

test("jumping cannot clear a 2-block wall, even sprint-jumping", () => {
  const get = wall(2);
  const s = settle(get, 100.5, 64, 100.5);
  for (let i = 0; i < 200; i++) tickPlayer(s, { ...idle(-90), forward: 1, jump: true, sprint: true }, get);
  assert.ok(s.x <= 103 - 0.3 + 1e-9, `x ${s.x}`);
  assert.ok(s.y < 65.5, `y ${s.y}`);
});

test("no auto step-up: walking into a 1-block step without jumping stops you", () => {
  const get = wall(1);
  const s = settle(get, 100.5, 64, 100.5);
  for (let i = 0; i < 60; i++) tickPlayer(s, { ...idle(-90), forward: 1 }, get);
  assert.ok(Math.abs(s.x - (103 - 0.3)) < 1e-9, `x ${s.x}`);
  assert.equal(s.y, 64);
});

function speedOver(input: Partial<MoveInput>): number {
  const s = settle(flat, 20.5, 64, 20.5);
  const inp: MoveInput = { ...idle(-90), ...input };
  for (let i = 0; i < 100; i++) tickPlayer(s, inp, flat);
  const x0 = s.x;
  for (let i = 0; i < 100; i++) tickPlayer(s, inp, flat);
  return (s.x - x0) / 5; // 100 ticks = 5 s
}

test("walk speed is 4.317 m/s", () => {
  const v = speedOver({ forward: 1 });
  assert.ok(Math.abs(v - 4.317) < 0.01, `walk ${v}`);
});

test("sprint speed is 5.612 m/s", () => {
  const v = speedOver({ forward: 1, sprint: true });
  assert.ok(Math.abs(v - 5.612) < 0.01, `sprint ${v}`);
});

test("sneak speed is 1.295 m/s", () => {
  const v = speedOver({ forward: 1, sneak: true });
  assert.ok(Math.abs(v - 1.295) < 0.01, `sneak ${v}`);
});

test("sprint stops when sneaking or releasing forward", () => {
  const s = settle(flat, 20.5, 64, 20.5);
  for (let i = 0; i < 5; i++) tickPlayer(s, { ...idle(-90), forward: 1, sprint: true }, flat);
  assert.equal(s.sprinting, true);
  tickPlayer(s, { ...idle(-90), forward: 1, sprint: true, sneak: true }, flat);
  assert.equal(s.sprinting, false);
});

// A 10-wide platform floating at y=63 over a long drop.
const platform: GetBlock = (x, y) => (y === 63 && x >= 90 && x < 100 ? B.STONE : y === 0 ? B.BEDROCK : B.AIR);

test("sneaking stops you at the edge of a drop", () => {
  const s = settle(platform, 98.5, 64, 50.5);
  for (let i = 0; i < 200; i++) tickPlayer(s, { ...idle(-90), forward: 1, sneak: true }, platform);
  assert.equal(s.y, 64);
  assert.equal(s.onGround, true);
  assert.ok(s.x > 100 && s.x < 100.3, `x ${s.x}`); // the box hangs over the edge, like Java
});

test("sneaking also guards diagonal motion at a corner", () => {
  const s = settle(platform, 98.5, 64, 50.5);
  for (let i = 0; i < 200; i++) tickPlayer(s, { ...idle(-45), forward: 1, sneak: true }, platform);
  assert.equal(s.y, 64);
});

test("walking off the edge without sneaking falls", () => {
  const s = settle(platform, 98.5, 64, 50.5);
  for (let i = 0; i < 60; i++) tickPlayer(s, { ...idle(-90), forward: 1 }, platform);
  assert.ok(s.y < 60, `y ${s.y}`);
});

test("collision is per axis: walking diagonally into a wall slides along it", () => {
  const get: GetBlock = (x, y) => (y < 64 ? B.STONE : x === 103 ? B.STONE : B.AIR);
  const s = settle(get, 100.5, 64, 100.5);
  for (let i = 0; i < 60; i++) tickPlayer(s, { ...idle(-45), forward: 1 }, get); // facing +X and +Z
  assert.ok(Math.abs(s.x - 102.7) < 1e-9, `x ${s.x}`);
  assert.ok(s.z > 105, `z ${s.z}`);
});

test("the world border is solid", () => {
  const s = settle(flat, 1.5, 64, 50.5);
  for (let i = 0; i < 100; i++) tickPlayer(s, { ...idle(90), forward: 1 }, flat); // facing -X
  assert.ok(Math.abs(s.x - 0.3) < 1e-9, `x ${s.x}`);
});

test("water: you sink slowly, swim up with jump, and wading slows you", () => {
  const pool: GetBlock = (_x, y) => (y < 60 ? B.STONE : y < 64 ? B.WATER : B.AIR);
  const s = newPhysState(50.5, 63, 50.5);
  for (let i = 0; i < 20; i++) tickPlayer(s, idle(), pool);
  assert.equal(s.inWater, true);
  assert.ok(s.vy < 0 && s.vy > -0.13, `sink vy ${s.vy}`);
  const yLow = s.y;
  for (let i = 0; i < 20; i++) tickPlayer(s, { ...idle(), jump: true }, pool);
  assert.ok(s.y > yLow + 1, `swam from ${yLow} to ${s.y}`);
  // Horizontal water speed: accel 0.02 / (1 - 0.8) = 0.1 * 0.98 per tick ~ 1.96 m/s
  const w = newPhysState(50.5, 60, 50.5);
  for (let i = 0; i < 100; i++) tickPlayer(w, { ...idle(-90), forward: 1 }, pool);
  const x0 = w.x;
  for (let i = 0; i < 100; i++) tickPlayer(w, { ...idle(-90), forward: 1 }, pool);
  const v = (w.x - x0) / 5;
  assert.ok(v > 1.8 && v < 2.1, `water speed ${v}`);
});

test("footsteps fire roughly every 1.67 blocks walked", () => {
  const s = settle(flat, 20.5, 64, 20.5);
  let steps = 0;
  for (let i = 0; i < 200; i++) if (tickPlayer(s, { ...idle(-90), forward: 1 }, flat).step) steps++;
  const dist = s.x - 20.5;
  const expected = (dist * 0.6) | 0;
  assert.ok(Math.abs(steps - expected) <= 1, `steps ${steps} for ${dist.toFixed(1)} blocks`);
});

// ---- crouching (Java 1.14+ pose: 1.5 tall, eyes at 1.27)

// A 1.5-high gap: top slabs (their box is y 0.5..1 of the cell) at y = 65 for x >= 103.
const gap: GetBlock = (x, y) => (y < 64 ? B.STONE : y === 65 && x >= 103 && x < 110 ? B.STONE_SLAB + 1 : B.AIR);

test("crouching: you can sneak under a 1.5-high gap, but not walk in standing", () => {
  const s = settle(gap, 100.5, 64, 50.5);
  for (let i = 0; i < 120; i++) tickPlayer(s, { ...idle(-90), forward: 1 }, gap);
  assert.ok(s.x < 103, `standing: stopped at the gap (x ${s.x})`);
  for (let i = 0; i < 120; i++) tickPlayer(s, { ...idle(-90), forward: 1, sneak: true }, gap);
  assert.ok(s.x > 105, `sneaking: went under (x ${s.x})`);
  assert.equal(s.crouched, true);
  assert.equal(s.y, 64);
});

test("crouching: let go of sneak under the gap and you stay crouched (and slow) until there is room", () => {
  const s = settle(gap, 100.5, 64, 50.5);
  for (let i = 0; i < 200 && s.x < 106; i++) tickPlayer(s, { ...idle(-90), forward: 1, sneak: true }, gap);
  assert.ok(s.x > 105.9 && s.x < 107, `under the gap (x ${s.x})`);
  tickPlayer(s, { ...idle(-90), forward: 1 }, gap);
  assert.equal(s.sneaking, false);
  assert.equal(s.crouched, true, "no room to stand");
  const x0 = s.x;
  for (let i = 0; i < 20; i++) tickPlayer(s, { ...idle(-90), forward: 1 }, gap);
  const v = ((s.x - x0) / 20) * 20;
  assert.ok(v > 1.1 && v < 1.4, `crouched speed ${v.toFixed(3)} m/s`);
  for (let i = 0; i < 200 && s.x < 111; i++) tickPlayer(s, { ...idle(-90), forward: 1 }, gap);
  tickPlayer(s, idle(-90), gap);
  assert.equal(s.crouched, false, "out in the open: standing again");
  assert.ok(!s.sprinting);
});

test("crouching: no jitter at an edge (the position settles and stays put)", () => {
  const s = settle(platform, 98.5, 64, 50.5);
  const xs: number[] = [];
  for (let i = 0; i < 160; i++) {
    tickPlayer(s, { ...idle(-90), forward: 1, sneak: true }, platform);
    xs.push(s.x);
  }
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] >= xs[i - 1] - 1e-12, `never moves back (tick ${i})`);
  const tail = xs.slice(-60);
  assert.ok(Math.max(...tail) - Math.min(...tail) < 1e-9, "still at the edge, no shaking");
  // Strafing along the edge does not shake you off or toward it either.
  const along: number[] = [];
  for (let i = 0; i < 60; i++) {
    tickPlayer(s, { ...idle(-90), strafe: 1, sneak: true }, platform);
    along.push(s.x);
  }
  assert.ok(Math.max(...along) - Math.min(...along) < 0.051, `x stays at the edge while strafing (${Math.min(...along).toFixed(3)}..${Math.max(...along).toFixed(3)})`);
  assert.equal(s.y, 64);
});
