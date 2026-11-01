// Server pieces of survival, without a network: furnace ticks (fuel, smelting time, lit state, falling back without
// fuel, a full output, persistence), dropped items (falling, merging, pickup with its delay, partial pickup, despawn,
// saving), and the hunger/health rules.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { B } from "../shared/blocks.ts";
import { I, SMELT_TICKS, type Stack } from "../shared/items.ts";
import { Containers } from "../server/src/containers.ts";
import { ItemManager } from "../server/src/items.ts";
import { ITEM_DESPAWN } from "../shared/drops.ts";
import { EXHAUST, HUNGER_RATE, JAVA_EXHAUST, MAX_AIR, MAX_HP, eat, exhaust, fallDamage, newBody, tickAir, tickFood } from "../shared/survival.ts";

const dir = mkdtempSync(join(tmpdir(), "steve-craft-surv-unit-"));
const S = (id: number, n = 1): Stack => ({ id, n, d: 0 });

test("furnace: coal burns 1600 ticks and smelts 8 items, 200 ticks each; lit while burning", () => {
  const c = new Containers(dir);
  const f = c.furnace(100);
  f.items[0] = S(I.RAW_IRON, 10);
  f.items[1] = S(I.COAL, 1);
  c.wake(100);
  const lit: boolean[] = [];
  for (let t = 0; t < SMELT_TICKS; t++) c.tick((_cell, l) => lit.push(l));
  assert.deepEqual(lit, [true], "lit once at the start");
  assert.deepEqual(f.items[2], S(I.IRON_INGOT, 1), "one ingot after 200 ticks");
  assert.equal(f.items[1], null, "the coal is burning");
  for (let t = 0; t < 1600 - SMELT_TICKS; t++) c.tick((_cell, l) => lit.push(l));
  assert.equal(f.items[2]!.n, 8, "8 per coal");
  for (let t = 0; t < 50; t++) c.tick((_cell, l) => lit.push(l));
  assert.deepEqual(lit, [true, false], "goes out when the fuel is spent");
  assert.equal(f.items[0]!.n, 2);
});

test("furnace: without fuel the progress falls back; a full or different output stops it; sand to glass, logs to charcoal", () => {
  const c = new Containers(dir);
  const f = c.furnace(200);
  f.items[0] = S(B.SAND, 1);
  f.items[1] = S(B.OAK_PLANKS, 1); // 300 ticks
  c.wake(200);
  for (let t = 0; t < 250; t++) c.tick(() => {});
  assert.deepEqual(f.items[2], S(B.GLASS, 1));
  const g = c.furnace(201);
  g.items[0] = S(B.OAK_LOG, 2);
  g.items[1] = S(I.STICK, 1); // 100 ticks: not enough for 200
  c.wake(201);
  for (let t = 0; t < 100; t++) c.tick(() => {});
  const cook = g.cook;
  assert.ok(cook > 90, `cooked ${cook}`);
  for (let t = 0; t < 20; t++) c.tick(() => {});
  assert.ok(g.cook < cook, "falls back without fuel");
  const h = c.furnace(202);
  h.items[0] = S(I.RAW_GOLD, 3);
  h.items[1] = S(I.COAL, 1);
  h.items[2] = S(I.IRON_INGOT, 5); // a different item in the output: nothing to do
  c.wake(202);
  for (let t = 0; t < 300; t++) c.tick(() => {});
  assert.equal(h.items[0]!.n, 3);
  assert.deepEqual(h.items[1], S(I.COAL, 1), "doesn't even light");
});

test("furnaces and chests are saved and come back (only where the block still is)", () => {
  const d2 = mkdtempSync(join(tmpdir(), "steve-craft-cont-"));
  const c = new Containers(d2);
  c.furnace(5).items[0] = S(I.BEEF, 4);
  c.chest(9)[3] = S(I.DIAMOND, 2);
  c.chest(11)[0] = S(B.DIRT, 1);
  c.save();
  const blocks: Record<number, number> = { 5: B.FURNACE + 1, 9: B.CHEST, 11: B.AIR };
  const back = new Containers(d2);
  back.load((cell) => blocks[cell] ?? 0);
  assert.deepEqual(back.furnace(5).items[0], S(I.BEEF, 4));
  assert.deepEqual(back.chest(9)[3], S(I.DIAMOND, 2));
  assert.equal(back.chests.has(11), false, "the chest at 11 is gone, so are its contents");
  assert.deepEqual(back.remove(9), [S(I.DIAMOND, 2)]);
});

// a flat floor at y = 40 (the top of y 39)
const floor = (_x: number, y: number) => (y < 40 ? B.STONE : B.AIR);

test("dropped items fall to the ground, merge, and are picked up by walking over them (after the delay)", () => {
  const m = new ItemManager(floor, dir);
  m.spawn(S(B.DIRT, 5), 100.5, 45, 100.5, 0, 0, 0, 10);
  m.spawn(S(B.DIRT, 7), 100.7, 44, 100.4, 0, 0, 0, 10);
  const players = [{ id: 1, key: "k", x: 110, y: 40, z: 110, alive: true }];
  const got: Stack[] = [];
  for (let t = 0; t < 80; t++) m.tick(players, (_p, st) => (got.push(st), 0), t);
  assert.equal(m.items.size, 1, "merged");
  const e = [...m.items.values()][0];
  assert.equal(e.st.n, 12);
  assert.ok(Math.abs(e.y - 40) < 0.01, `on the floor (y ${e.y})`);
  players[0].x = e.x;
  players[0].z = e.z;
  for (let t = 80; t < 85; t++) m.tick(players, (_p, st) => (got.push(st), 0), t);
  assert.equal(m.items.size, 0);
  assert.deepEqual(got, [S(B.DIRT, 12)]);
  assert.ok(m.pickupMessage(), "a pickup animation to send");
});

test("partial pickup leaves the rest; thrown items wait longer for the thrower; items despawn after 5 minutes", () => {
  const m = new ItemManager(floor, dir);
  m.spawn(S(B.SAND, 10), 50.5, 40, 50.5, 0, 0, 0, 0);
  const p = [{ id: 1, key: "a", x: 50.5, y: 40, z: 50.5, alive: true }];
  m.tick(p, () => 6, 1); // only 4 fit
  assert.equal([...m.items.values()][0].st.n, 6);
  // a thrown stack: the thrower waits 40 ticks, someone else 10
  m.clear();
  m.spawn(S(B.GRAVEL, 1), 60.5, 40, 60.5, 0, 0, 0, 40, "a");
  const thrower = [{ id: 1, key: "a", x: 60.5, y: 40, z: 60.5, alive: true }];
  for (let t = 0; t < 20; t++) m.tick(thrower, () => 0, t);
  assert.equal(m.items.size, 1, "not back in the thrower's hands yet");
  const other = [{ id: 2, key: "b", x: 60.5, y: 40, z: 60.5, alive: true }];
  m.tick(other, () => 0, 21);
  assert.equal(m.items.size, 0, "someone else can catch it");
  m.spawn(S(B.DIRT, 1), 70.5, 40, 70.5, 0, 0, 0, 0);
  for (let t = 0; t < ITEM_DESPAWN + 1; t++) m.tick([], () => 0, t);
  assert.equal(m.items.size, 0, "gone after 5 minutes");
});

test("dropped items are saved and loaded", () => {
  const d3 = mkdtempSync(join(tmpdir(), "steve-craft-items-"));
  const m = new ItemManager(floor, d3);
  m.spawn(S(I.APPLE, 3), 20.5, 40, 20.5, 0, 0, 0, 0);
  m.save();
  const back = new ItemManager(floor, d3);
  back.load();
  assert.deepEqual([...back.totals()], [[`${I.APPLE}:0`, 3]]);
});

test("hunger and health: regen when fed, starving down to half a heart (not in the safe zone), falls, drowning", () => {
  const b = newBody();
  b.hp = 10;
  let healed = 0;
  for (let t = 0; t < 800; t++) {
    const before = b.hp;
    tickFood(b, false);
    if (b.hp > before) healed++;
  }
  assert.ok(healed >= 8, `healed ${healed} times`);
  assert.ok(b.food < 20 || b.sat < 5, "healing costs hunger");
  const s = newBody();
  s.food = 0;
  s.sat = 0;
  s.hp = 3;
  let dmg = 0;
  for (let t = 0; t < 80 * 5; t++) {
    const r = tickFood(s, false);
    dmg += r.starve;
    s.hp -= r.starve;
  }
  assert.equal(s.hp, 1, "starving stops at half a heart");
  assert.equal(dmg, 2);
  const safe = newBody();
  safe.food = 0;
  safe.sat = 0;
  let safeDmg = 0;
  for (let t = 0; t < 400; t++) safeDmg += tickFood(safe, true).starve;
  assert.equal(safeDmg, 0, "no starving in the safe zone");
  assert.deepEqual([fallDamage(3), fallDamage(4), fallDamage(10), fallDamage(23.5)], [0, 0, 2, 9]);
  const w = newBody();
  let drown = 0;
  for (let t = 0; t < MAX_AIR + 100; t++) drown += tickAir(w, true);
  assert.equal(drown, 2 * 5, "15 s of air, then 2 damage a second");
  for (let t = 0; t < 80; t++) tickAir(w, false);
  assert.equal(w.air, MAX_AIR, "air comes back quickly");
  const e = newBody();
  e.food = 10;
  e.sat = 0;
  eat(e, 8, 12.8);
  assert.deepEqual([e.food, e.sat], [18, 12.8]);
});

test("update 13: food lasts about eight times as long as Java's under the same activity (10.1 twice, 12.1 four times)", () => {
  assert.equal(HUNGER_RATE, 0.125);
  for (const k of Object.keys(JAVA_EXHAUST) as (keyof typeof JAVA_EXHAUST)[]) {
    assert.ok(Math.abs(EXHAUST[k] - JAVA_EXHAUST[k] / 8) < 1e-12, `${k} costs an eighth`);
  }
  // a busy survival minute, tick by tick: sprinting 5.6 blocks/s with a sprint jump every second, swimming 2 blocks/s
  // for one second in ten, a block mined every 1.5 s, a swing every second; with `fights`, also a 3-damage hit every
  // 15 s (natural healing then has work to do). Counts ticks from a full bar (20 food, 5 saturation) to an empty one.
  const run = (cost: typeof EXHAUST, rate: number, fights: boolean): number => {
    const b = newBody();
    for (let t = 1; t < 20 * 60 * 60; t++) {
      if (t % 200 < 20) exhaust(b, cost.swimPerBlock * 0.1);
      else exhaust(b, cost.sprintPerBlock * 0.28);
      if (t % 20 === 0) exhaust(b, cost.sprintJump);
      if (t % 30 === 0) exhaust(b, cost.breakBlock);
      if (t % 20 === 10) exhaust(b, cost.attack);
      if (fights && t % 300 === 0 && b.hp > 4) {
        b.hp -= 3;
        exhaust(b, cost.damage);
      }
      tickFood(b, false, rate);
      if (b.food <= 0) return t;
    }
    return Infinity;
  };
  const min = (t: number) => (t / 1200).toFixed(1);
  const java = run(JAVA_EXHAUST, 1, false);
  const now = run(EXHAUST, HUNGER_RATE, false);
  assert.ok(now / java > 7.8 && now / java < 8.2, `busy, no fights: ${min(java)} min at Java's rates, ${min(now)} min now (x${(now / java).toFixed(2)})`);
  // with fights it is a little under x8: a bar that stays above 18 for longer keeps healing for longer (that healing
  // costs an eighth too)
  const javaF = run(JAVA_EXHAUST, 1, true);
  const nowF = run(EXHAUST, HUNGER_RATE, true);
  assert.ok(nowF / javaF > 6.8 && nowF / javaF < 8.4, `busy with fights: ${min(javaF)} min at Java's rates, ${min(nowF)} min now (x${(nowF / javaF).toFixed(2)})`);
  // each half heart of natural healing costs an eighth of Java's: the fast heal at a full bar (Java: the saturation it
  // has, up to 6) and the slow heal at 18+ (Java: 6)
  const healCost = (food: number, sat: number, ticks: number, rate: number): number => {
    const h = newBody();
    h.hp = 10;
    h.food = food;
    h.sat = sat;
    for (let t = 0; t < ticks; t++) tickFood(h, false, rate);
    assert.equal(h.hp, 11, "healed half a heart");
    return h.exh;
  };
  assert.deepEqual([healCost(20, 5, 10, 1), healCost(20, 5, 10, HUNGER_RATE)], [5, 0.625], "fast heal");
  assert.deepEqual([healCost(19, 0, 80, 1), healCost(19, 0, 80, HUNGER_RATE)], [6, 0.75], "slow heal");
  // a quiet walk (no exhaustion) and the same food still feed you the same
  const w = newBody();
  w.hp = MAX_HP;
  for (let t = 0; t < 20 * 60 * 10; t++) tickFood(w, false);
  assert.deepEqual([w.food, w.sat], [20, 5], "walking costs nothing (as in Java), and nothing drains at rest");
  const e = newBody();
  e.food = 4;
  e.sat = 0;
  eat(e, 8, 12.8);
  assert.deepEqual([e.food, e.sat], [12, 12], "food values unchanged (saturation capped at hunger)");
  // starving is unchanged too: half a heart every 4 s at an empty bar
  const s = newBody();
  s.food = 0;
  s.sat = 0;
  let dmg = 0;
  for (let t = 0; t < 80 * 3; t++) dmg += tickFood(s, false).starve;
  assert.equal(dmg, 3);
});
