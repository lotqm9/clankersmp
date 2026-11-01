// Farming and depth on a real server (protocol v7) with a protocol bot (DEV_COMMANDS=1: /tp, /give, /grow, /hunger,
// /time, /summon, /mobs): a hoe tills grass into farmland (watered when water is near, dry when not), seeds plant
// wheat on farmland only, /grow ripens it and ripe wheat drops wheat and seeds; landing on farmland from a jump
// tramples it back to dirt (and knocks the crop off); buckets scoop a water source and pour it out again, milk a
// cow, and milk settles a queasy stomach (the bucket is left); a cake is eaten a slice at a time, only when hungry;
// the bow: a second's draw looses a full-power, critical arrow that hits a mob, a tap shoots nothing, an arrow is
// used up and the bow wears, and an arrow stuck in the ground can be picked up again; and none of the tilling,
// pouring, scooping or shooting works in the spawn safe zone.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { B, IS_WATER, SOLID } from "../shared/blocks.ts";
import { afterArmor } from "../shared/combat.ts";
import { DEFAULT_SEED, PROTOCOL_VERSION, SPAWN_X, SPAWN_Z, WORLD_HEIGHT, idx } from "../shared/constants.ts";
import { SAFE_RADIUS } from "../shared/hub.ts";
import { I, hoeId, toolId } from "../shared/items.ts";
import { caneSupported } from "../shared/shapes.ts";
import { generateWorld } from "../shared/worldgen.ts";
import { Bot, patchSpots, sleep, waitFor } from "./bot.ts";

const PORT = 25600 + Math.floor(Math.random() * 1500);
const URL = `ws://127.0.0.1:${PORT}`;
const dir = mkdtempSync(pjoin(tmpdir(), "steve-craft-farm-"));
const gen = generateWorld(DEFAULT_SEED);
const base = gen.blocks;
let server: ChildProcess;
const bots: Bot[] = [];
let serverOut = "";

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [process.env.SERVER_ENTRY || "server/src/main.ts"], {
      env: { ...process.env, MOBS: "0", PORT: String(PORT), WORLD_DIR: dir, ADMIN_SECRET: "test-admin-secret-0123456789", DEV_COMMANDS: "1", GAMEMODE: "", COIN_CA: "", ANIMALS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => reject(new Error("server did not start")), 30000);
    p.stdout!.on("data", (d: Buffer) => {
      serverOut += d.toString();
      if (d.toString().includes("game server on")) {
        clearTimeout(timer);
        resolve(p);
      }
    });
    p.stderr!.on("data", (d: Buffer) => (serverOut += d.toString()));
  });
}

before(async () => {
  server = await startServer();
});
after(async () => {
  if (process.env.SHOW_SERVER) console.log(serverOut.split(/\r?\n/).filter((l) => !/joined|left/.test(l)).slice(-60).join("\n"));
  for (const b of bots) b.close();
  await new Promise<void>((resolve) => {
    server.once("exit", () => resolve());
    server.kill("SIGTERM");
    setTimeout(resolve, 3000);
  });
  rmSync(dir, { recursive: true, force: true });
});

const top = (x: number, z: number) => {
  for (let y = WORLD_HEIGHT - 1; y > 0; y--) if (SOLID[base[idx(x, y, z)]]) return y;
  return 0;
};

/** A w x d patch of level grass well outside the safe zone, open above. */
function patch(w: number, d: number, from = SAFE_RADIUS + 8): { x: number; z: number; y: number } {
  for (const [x0, z0] of patchSpots(from)) {
    const y = top(x0, z0);
    let ok = y > 41;
    for (let x = x0 - 1; ok && x <= x0 + w; x++)
      for (let z = z0 - 1; ok && z <= z0 + d; z++) {
        if (top(x, z) !== y || base[idx(x, y, z)] !== B.GRASS) ok = false;
        for (let yy = y + 1; ok && yy < y + 6; yy++) if (base[idx(x, yy, z)] !== B.AIR && base[idx(x, yy, z)] !== B.TALL_GRASS) ok = false;
      }
    if (ok) return { x: x0, z: z0, y };
  }
  throw new Error("no patch");
}

async function tpTo(b: Bot, x: number, y: number, z: number): Promise<void> {
  const n = b.tps.length;
  b.chat(`/tp ${x} ${y} ${z}`);
  await waitFor(() => b.tps.length > n, 6000, "tp");
  b.move(x, y, z);
  await sleep(120);
}

async function join(token: string): Promise<Bot> {
  const b = new Bot();
  await b.connect(URL, { token });
  bots.push(b);
  return b;
}

const slotOf = (b: Bot, id: number) => b.inv.findIndex((s) => s?.id === id);

async function give(b: Bot, key: string, n = 1): Promise<void> {
  b.chat(`/give ${key} ${n}`);
  await sleep(200);
}

async function holdItem(b: Bot, id: number): Promise<void> {
  await waitFor(() => slotOf(b, id) >= 0, 6000, `item ${id} in inventory`);
  let s = slotOf(b, id);
  if (s > 8) {
    const n = b.click(0, { m: "swap", s, h: 8 });
    await waitFor(() => b.winLog.some((l) => l.n === n), 5000, "swap answered");
    b.send({ t: "close", w: 0 });
    await waitFor(() => b.inv[8]?.id === id, 5000, "item on the hotbar");
    s = 8;
  }
  b.select(s);
  b.move(b.x, b.y, b.z);
  await sleep(80);
}

/** The block a client sees now (its edits over the generated world). */
const at = (b: Bot, x: number, y: number, z: number) => b.block(base, x, y, z);

/** Pull up the tall grass over (x, y, z), if any (a hoe needs air above the block). */
async function clearAbove(b: Bot, x: number, y: number, z: number): Promise<void> {
  if (at(b, x, y + 1, z) === B.AIR) return;
  b.dig("start", x, y + 1, z);
  b.dig("finish", x, y + 1, z);
  await waitFor(() => at(b, x, y + 1, z) === B.AIR, 5000, "grass pulled up");
}

let P: { x: number; z: number; y: number };
let pool: [number, number, number];

test("v7: the server speaks protocol 7 or later, and the world has sugar cane by the water (every stalk on grass, dirt or sand beside it)", async () => {
  assert.ok(PROTOCOL_VERSION >= 7); // v8 bumped it (world update)
  let stalks = 0;
  const get = (x: number, y: number, z: number) => base[idx(x, y, z)];
  for (let i = 0; i < base.length; i++) {
    if (base[i] !== B.SUGAR_CANE) continue;
    const x = i & 511;
    const z = (i >> 9) & 511;
    const y = i >> 18;
    if (get(x, y - 1, z) === B.SUGAR_CANE) continue;
    stalks++;
    assert.ok(caneSupported(x, y, z, get), `cane at ${x},${y},${z} stands by water`);
  }
  assert.ok(stalks > 100, `cane on the shores (${stalks} stalks)`);
  P = patch(10, 8);
  await join("farm-a-token-0123456789abcdef");
});

test("farming: a hoe tills grass (watered beside water, dry away from it), seeds go on farmland only, /grow ripens wheat, and ripe wheat drops wheat and seeds", async () => {
  const a = bots[0];
  const y = P.y;
  await tpTo(a, P.x + 3.5, y + 1, P.z + 0.5);
  // a pool to water the field: dig a hole and pour a water bucket into it
  pool = [P.x + 7, y, P.z + 2];
  await give(a, "wooden_shovel");
  await holdItem(a, toolId(0, 2));
  a.dig("start", ...pool);
  await sleep(900);
  a.dig("finish", ...pool);
  await waitFor(() => at(a, ...pool) === B.AIR, 5000, "the hole");
  await give(a, "water_bucket");
  await holdItem(a, I.WATER_BUCKET);
  a.place(...pool, B.WATER);
  await waitFor(() => at(a, ...pool) === B.WATER, 5000, "the pool");
  await waitFor(() => a.count(I.BUCKET) === 1 && a.count(I.WATER_BUCKET) === 0, 5000, "the bucket is empty again");
  // till one beside the water (watered) and one 6 blocks away (dry)
  await clearAbove(a, P.x + 6, y, P.z + 2);
  await clearAbove(a, P.x + 1, y, P.z + 2);
  await give(a, "wooden_hoe");
  await holdItem(a, hoeId(0));
  a.use(P.x + 6, y, P.z + 2);
  await waitFor(() => at(a, P.x + 6, y, P.z + 2) === B.FARMLAND + 1, 5000, "watered farmland");
  a.use(P.x + 1, y, P.z + 2);
  await waitFor(() => at(a, P.x + 1, y, P.z + 2) === B.FARMLAND, 5000, "dry farmland");
  await waitFor(() => a.inv[a.sel]?.id === hoeId(0) && a.inv[a.sel]!.d === 2, 5000, "the hoe wore twice");
  // seeds: on farmland they plant wheat; on grass they don't
  await give(a, "wheat_seeds", 4);
  await holdItem(a, I.WHEAT_SEEDS);
  a.place(P.x + 6, y + 1, P.z + 2, B.WHEAT);
  await waitFor(() => at(a, P.x + 6, y + 1, P.z + 2) === B.WHEAT, 5000, "wheat planted");
  a.place(P.x + 4, y + 1, P.z + 2, B.WHEAT);
  await sleep(500);
  assert.notEqual(at(a, P.x + 4, y + 1, P.z + 2), B.WHEAT, "no wheat on plain grass");
  assert.equal(a.count(I.WHEAT_SEEDS), 3, "one seed planted");
  // grow it, harvest it
  a.chat("/grow");
  await waitFor(() => at(a, P.x + 6, y + 1, P.z + 2) === B.WHEAT + 7, 5000, "ripe");
  await tpTo(a, P.x + 6.5, y + 1, P.z + 3.5);
  const seeds = a.count(I.WHEAT_SEEDS);
  a.dig("start", P.x + 6, y + 1, P.z + 2);
  a.dig("finish", P.x + 6, y + 1, P.z + 2);
  await waitFor(() => at(a, P.x + 6, y + 1, P.z + 2) === B.AIR, 5000, "harvested");
  await tpTo(a, P.x + 6.5, y + 1, P.z + 2.5); // over where it fell
  await waitFor(() => a.count(I.WHEAT) === 1 && a.count(I.WHEAT_SEEDS) > seeds, 6000, "a wheat and seeds picked up");
  assert.ok(a.count(I.WHEAT_SEEDS) - seeds >= 1 && a.count(I.WHEAT_SEEDS) - seeds <= 4, `1-4 seeds (${a.count(I.WHEAT_SEEDS) - seeds})`);
});

test("landing on farmland from a jump tramples it back to dirt, knocking the crop off it", async () => {
  const a = bots[0];
  const y = P.y;
  const fx = P.x + 2;
  const fz = P.z + 5;
  await tpTo(a, fx + 0.5, y + 1, fz + 1.5);
  await clearAbove(a, fx, y, fz);
  await holdItem(a, hoeId(0));
  a.use(fx, y, fz);
  await waitFor(() => at(a, fx, y, fz) === B.FARMLAND, 5000, "farmland");
  await holdItem(a, I.WHEAT_SEEDS);
  a.place(fx, y + 1, fz, B.WHEAT);
  await waitFor(() => at(a, fx, y + 1, fz) === B.WHEAT, 5000, "wheat");
  // stand on it (a pixel down) and jump until it gives
  const y0 = y + 15 / 16;
  await tpTo(a, fx + 0.5, y0, fz + 0.5);
  for (let k = 0; k < 14 && at(a, fx, y, fz) !== B.DIRT; k++) {
    for (const dy of [0.42, 0.75, 1.0, 1.17, 1.25, 1.17, 1.0, 0.75, 0.42]) {
      a.move(fx + 0.5, y0 + dy, fz + 0.5, 0, 0, 0);
      await sleep(50);
    }
    a.move(fx + 0.5, y0, fz + 0.5, 0, 0, 4);
    await sleep(250);
  }
  assert.equal(at(a, fx, y, fz), B.DIRT, "trampled to dirt");
  assert.equal(at(a, fx, y + 1, fz), B.AIR, "the wheat went with it");
});

test("buckets: an empty bucket scoops up a water source and pours it back; milk from a cow; milk settles a queasy stomach and leaves the bucket", async () => {
  const a = bots[0];
  const y = P.y;
  await tpTo(a, pool[0] - 1.5, y + 1, pool[2] + 0.5);
  await give(a, "bucket", 1);
  await waitFor(() => a.count(I.BUCKET) === 2, 5000, "two buckets");
  await holdItem(a, I.BUCKET);
  a.use(...pool);
  await waitFor(() => !IS_WATER[at(a, ...pool)], 5000, "the water is taken up");
  await waitFor(() => a.count(I.WATER_BUCKET) === 1 && a.count(I.BUCKET) === 1, 5000, "one of the two buckets filled");
  await holdItem(a, I.WATER_BUCKET);
  a.place(...pool, B.WATER);
  await waitFor(() => at(a, ...pool) === B.WATER, 5000, "poured back");
  await waitFor(() => a.count(I.WATER_BUCKET) === 0 && a.count(I.BUCKET) === 2, 5000, "both empty");
  // milk
  a.chat("/summon cow 1");
  await waitFor(() => [...a.animals.values()].some((an) => an.kind === 1), 5000, "a cow");
  const cow = [...a.animals.values()].find((an) => an.kind === 1)!;
  await tpTo(a, cow.x - 1.2, y + 1, cow.z);
  await holdItem(a, I.BUCKET);
  a.send({ t: "milk", id: cow.id });
  await waitFor(() => a.count(I.MILK_BUCKET) === 1, 5000, "milk");
  // queasy, then milk
  a.chat("/hunger 4");
  await give(a, "spoiled_flesh", 8);
  await holdItem(a, I.SPOILED_FLESH);
  for (let k = 0; k < 8 && !a.stats.queasy; k++) {
    const food = a.stats.food;
    a.send({ t: "eat", a: "start" });
    await sleep(1700);
    a.send({ t: "eat", a: "finish" });
    await waitFor(() => a.stats.food > food, 5000, "it fills");
  }
  assert.ok(a.stats.queasy, "queasy");
  await holdItem(a, I.MILK_BUCKET);
  const buckets = a.count(I.BUCKET);
  a.send({ t: "eat", a: "start" });
  await sleep(1700);
  a.send({ t: "eat", a: "finish" });
  await waitFor(() => !a.stats.queasy, 5000, "settled");
  await waitFor(() => a.count(I.MILK_BUCKET) === 0, 5000, "the milk is gone (the slot update can come a tick after the stats)");
  assert.equal(a.count(I.BUCKET), buckets + 1, "the bucket is left");
});

test("cake: placed on the ground, eaten a slice at a time when hungry (7 slices, 2 hunger each), not when full", async () => {
  const a = bots[0];
  const y = P.y;
  const c: [number, number, number] = [P.x + 8, y + 1, P.z + 6];
  await tpTo(a, c[0] - 1.5, y + 1, c[2] + 0.5);
  await give(a, "cake", 1);
  await holdItem(a, B.CAKE);
  a.place(...c, B.CAKE);
  await waitFor(() => at(a, ...c) === B.CAKE, 5000, "a cake");
  a.chat("/hunger 20");
  await waitFor(() => a.stats.food === 20, 5000, "full");
  a.use(...c);
  await sleep(500);
  assert.equal(at(a, ...c), B.CAKE, "not when full");
  a.chat("/hunger 0");
  await waitFor(() => a.stats.food === 0, 5000, "hungry");
  for (let k = 1; k <= 7; k++) {
    a.use(...c);
    await waitFor(() => at(a, ...c) === (k < 7 ? B.CAKE + k : B.AIR), 5000, `slice ${k}`);
    await waitFor(() => a.stats.food === 2 * k, 5000, `food ${2 * k}`);
  }
});

test("the bow: a second's draw looses a full-power critical arrow that hits a mob; a tap shoots nothing; an arrow is used and the bow wears; a stuck arrow can be picked up", async () => {
  const a = bots[0];
  // a patch of its own, away from the farm and the cow milked there (an animal in the way would take the arrow)
  const Q = patch(3, 10, SAFE_RADIUS + 60);
  const y = Q.y;
  await tpTo(a, Q.x + 1.5, y + 1, Q.z + 0.5);
  assert.ok([...a.animals.values()].every((an) => Math.hypot(an.x - a.x, an.z - a.z) > 16), "no animal near");
  await give(a, "bow", 1);
  await give(a, "arrow", 4);
  await holdItem(a, I.BOW);
  await waitFor(() => a.count(I.ARROW) === 4, 5000, "arrows");
  a.chat("/time 18000");
  a.chat("/mobs clear");
  a.move(a.x, a.y, a.z, 0, 0, 4);
  await sleep(200);
  a.chat("/summon shambler 1 7");
  await waitFor(() => a.mobs.size >= 1, 5000, "a Shambler");
  a.chat("/mobs freeze");
  try {
    await sleep(600);
    const m = [...a.mobs.values()][0];
    const dx = m.x - a.x;
    const dz = m.z - a.z;
    const dy = m.y + 1.0 - (a.y + 1.62);
    const yaw = (Math.atan2(-dx, dz) * 180) / Math.PI;
    const pitch = (-Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI;
    a.move(a.x, a.y, a.z, yaw, pitch, 4);
    await sleep(100);
    const struck = a.struck.length;
    a.send({ t: "bow", a: "start" });
    await sleep(1150);
    a.send({ t: "bow", a: "release" });
    await waitFor(() => a.struck.length > struck, 5000, "the arrow hit");
    const s = a.struck[struck];
    assert.ok(s.mob && s.crit, `a critical arrow (${JSON.stringify(s)})`);
    assert.ok(s.dmg >= afterArmor(6, 2, 0) - 0.01 && s.dmg <= afterArmor(10, 2, 0) + 0.01, `full power: 6-9 before its armour (${s.dmg})`);
    await waitFor(() => a.count(I.ARROW) === 3, 5000, "an arrow used");
    await waitFor(() => a.inv[a.sel]?.id === I.BOW && a.inv[a.sel]!.d === 1, 5000, "the bow wore");
    // a tap: nothing
    const shots = a.arrows.length;
    a.send({ t: "bow", a: "start" });
    a.send({ t: "bow", a: "release" });
    await sleep(500);
    assert.equal(a.arrows.length, shots, "a tap shoots nothing");
    assert.equal(a.count(I.ARROW), 3, "and uses no arrow");
  } finally {
    a.chat("/mobs freeze");
    a.chat("/mobs clear");
    await sleep(200);
  }
  // into the ground a few blocks ahead, then walk over it
  a.move(a.x, a.y, a.z, 0, 50, 4);
  await sleep(100);
  const ends = a.arrowEnds.length;
  a.send({ t: "bow", a: "start" });
  await sleep(1100);
  a.send({ t: "bow", a: "release" });
  await waitFor(() => a.arrowEnds.length > ends, 5000, "it landed");
  const e = a.arrowEnds[ends];
  assert.ok(e.stuck, "stuck in the ground");
  await waitFor(() => a.count(I.ARROW) === 2, 3000, `two left (${a.count(I.ARROW)})`); // the slot update can trail the landing
  await tpTo(a, e.x, y + 1, e.z);
  await waitFor(() => a.arrowGone.includes(e.id), 5000, "picked up");
  await waitFor(() => a.count(I.ARROW) === 3, 5000, "three again");
});

test("the safe zone: no tilling, no pouring water, no scooping the fountain and no arrows in the hub", async () => {
  const a = bots[0];
  // grass and a water source inside the safe zone
  let grass: [number, number, number] | null = null;
  let water: [number, number, number] | null = null;
  for (let r = 4; r < SAFE_RADIUS - 2 && (!grass || !water); r++)
    for (let k = 0; k < 64 && (!grass || !water); k++) {
      const x = Math.round(SPAWN_X + Math.cos((k / 64) * Math.PI * 2) * r);
      const z = Math.round(SPAWN_Z + Math.sin((k / 64) * Math.PI * 2) * r);
      for (let y = 30; y < 90; y++) {
        const id = base[idx(x, y, z)];
        if (!grass && id === B.GRASS && base[idx(x, y + 1, z)] === B.AIR) grass = [x, y, z];
        if (!water && id === B.WATER) water = [x, y, z];
      }
    }
  assert.ok(grass && water, "grass and the fountain in the hub");
  await tpTo(a, grass![0] + 0.5, grass![1] + 1, grass![2] + 1.5);
  await holdItem(a, hoeId(0));
  a.use(...grass!);
  await sleep(600);
  assert.equal(at(a, ...grass!), B.GRASS, "no tilling in the hub");
  await give(a, "water_bucket");
  await holdItem(a, I.WATER_BUCKET);
  a.place(grass![0], grass![1] + 1, grass![2], B.WATER);
  await sleep(600);
  assert.equal(at(a, grass![0], grass![1] + 1, grass![2]), B.AIR, "no pouring water in the hub");
  assert.equal(a.count(I.WATER_BUCKET), 1, "the water stays in the bucket");
  await tpTo(a, water![0] + 0.5, water![1] + 1, water![2] + 1.5);
  await holdItem(a, I.BUCKET);
  a.use(...water!);
  await sleep(600);
  assert.equal(at(a, ...water!), B.WATER, "the fountain keeps its water");
  // a full draw in the hub shoots nothing: no arrow used, none flies
  await give(a, "bow", 1);
  await give(a, "arrow", 2);
  await holdItem(a, I.BOW);
  await waitFor(() => a.count(I.ARROW) >= 2, 5000, "arrows");
  const arrows = a.count(I.ARROW);
  const flying = a.arrows.length;
  a.send({ t: "bow", a: "start" });
  await sleep(1200);
  a.send({ t: "bow", a: "release" });
  await sleep(700);
  assert.equal(a.count(I.ARROW), arrows, "no arrow used in the hub");
  assert.equal(a.arrows.length, flying, "no arrow flies from the hub");
});
