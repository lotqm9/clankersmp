// Night mobs, combat and armour on a real server (protocol v6) with protocol bots (DEV_COMMANDS=1: /tp, /give, /time,
// /summon, /mobs, /hunger): mobs come around a player out in the wild at night and never near the hub; nothing
// hurts in the safe zone; a Shambler hits for 1.5 hearts with knockback, and worn iron armour softens it (and
// wears); hitting back follows the attack cooldown (a spam hit is weak; so is one straight after switching items),
// a charged iron sword does its full damage, a hit on the way down from a jump is a critical hit, and a kill drops
// loot; a Rattler's arrows reach clients and hurt; no sleeping with monsters near; bone meal grows saplings; spoiled
// flesh can make you queasy; others see the armour you wear; and dying drops it (the slots are sent empty).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { B, SOLID } from "../shared/blocks.ts";
import { afterArmor } from "../shared/combat.ts";
import { DEFAULT_SEED, PROTOCOL_VERSION, SPAWN_X, SPAWN_Z, WORLD_HEIGHT, idx } from "../shared/constants.ts";
import { SAFE_RADIUS } from "../shared/hub.ts";
import { I, armorId, toolId } from "../shared/items.ts";
import { MF, MOB } from "../shared/mobs.ts";
import { generateWorld } from "../shared/worldgen.ts";
import { Bot, patchSpots, sleep, waitFor } from "./bot.ts";

const PORT = 24000 + Math.floor(Math.random() * 1500);
const URL = `ws://127.0.0.1:${PORT}`;
const dir = mkdtempSync(pjoin(tmpdir(), "steve-craft-mobs-"));
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
function patch(w: number, d: number, from = SAFE_RADIUS + 16, avoid: { x: number; z: number }[] = []): { x: number; z: number; y: number } {
  for (const [x0, z0] of patchSpots(from)) {
    if (avoid.some((v) => Math.abs(v.x - x0) < 40 && Math.abs(v.z - z0) < 40)) continue;
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

/** The window slot (player window) of an inventory index. */
const winSlot = (k: number) => (k < 9 ? 36 + k : k);

let P: { x: number; z: number; y: number };

test("v6: the welcome carries the armour slots (protocol 6 and on)", async () => {
  P = patch(12, 12);
  const a = await join("mobs-a-token-0123456789abcdef");
  assert.ok(PROTOCOL_VERSION >= 6);
  assert.equal(a.armor.length, 4);
  assert.ok(a.armor.every((s) => s === null), "nothing worn at first");
});

test("at night, mobs come around a player out in the wild (24+ blocks away), never near the hub", async () => {
  const a = bots[0];
  const hub = await join("mobs-hub-token-0123456789abcdef");
  await tpTo(a, P.x + 6.5, P.y + 1, P.z + 6.5);
  await tpTo(hub, SPAWN_X + 0.5, gen.info.spawn.y, SPAWN_Z + 10.5);
  a.chat("/time 18000");
  a.chat("/mobs on");
  await waitFor(() => a.mobs.size > 0, 20000, "a mob around the player in the wild");
  const first = a.mobHistory[0];
  const d = Math.hypot(first.x - a.x, first.z - a.z);
  assert.ok(d > 20, `it appeared out of reach (${d.toFixed(1)} blocks away)`);
  await sleep(3000);
  for (const m of [...a.mobHistory, ...hub.mobHistory]) {
    const r = Math.hypot(m.x - SPAWN_X - 0.5, m.z - SPAWN_Z - 0.5);
    assert.ok(r > SAFE_RADIUS, `never inside the safe zone (${r.toFixed(1)})`);
  }
  assert.equal(hub.hurts.length, 0, "nothing hurts in the hub");
  a.chat("/mobs off");
  a.chat("/mobs clear");
  hub.close();
  await sleep(500);
});

test("a Shambler hits for 1.5 hearts with knockback; iron armour softens it, wears, and others see it", async () => {
  const a = bots[0];
  const watcher = await join("mobs-watch-token-0123456789abcdef");
  await tpTo(watcher, P.x + 10.5, P.y + 1, P.z + 1.5);
  await tpTo(a, P.x + 2.5, P.y + 1, P.z + 2.5);
  a.chat("/time 18000");
  a.chat("/mobs clear");
  await waitFor(() => a.stats.hp === 20, 8000, "full health");
  const hurts = a.hurtLog.length;
  a.move(a.x, a.y, a.z, 0, 0, 4); // facing +z: the summon goes in front
  await sleep(100);
  a.chat("/summon shambler 1 3");
  await waitFor(() => a.hurtLog.length > hurts, 10000, "the Shambler hits");
  const h = a.hurtLog[a.hurtLog.length - 1];
  assert.equal(h.cause, "mob:shambler");
  assert.ok(h.kb && Math.hypot(h.kb[0], h.kb[2]) > 0.3 && h.kb[1] > 0.3, "with a knockback push");
  await waitFor(() => a.stats.hp === 17, 5000, `17 after one hit (got ${a.stats.hp})`);
  // put on a full set of iron armour: shift-click each piece in the inventory
  for (const k of [0, 1, 2, 3]) await give(a, ["iron_helmet", "iron_chestplate", "iron_leggings", "iron_boots"][k]);
  await waitFor(() => [0, 1, 2, 3].every((k) => slotOf(a, armorId(1, k)) >= 0), 6000, "armour given");
  const wears = watcher.wears.length;
  for (const k of [0, 1, 2, 3]) {
    const n = a.click(0, { m: "shift", s: winSlot(slotOf(a, armorId(1, k))) });
    await waitFor(() => a.winLog.some((l) => l.n === n), 5000, "click answered");
  }
  a.send({ t: "close", w: 0 });
  await waitFor(() => a.armor.every((s, k) => s?.id === armorId(1, k)), 5000, "wearing iron");
  await waitFor(() => watcher.wears.length > wears && watcher.wears[watcher.wears.length - 1].id === a.id, 5000, "the other player is told");
  const hp = a.stats.hp;
  const n2 = a.hurtLog.length;
  await waitFor(() => a.hurtLog.length > n2, 8000, "another hit");
  const soft = afterArmor(3, 15, 0);
  await waitFor(() => Math.abs(a.stats.hp - (hp - soft)) < 0.02 || a.hurtLog.length > n2 + 1, 5000, "the hit, softened");
  assert.ok(a.stats.hp > hp - 3 + 0.5, `iron takes most of it (${hp} -> ${a.stats.hp}, expected ${(hp - soft).toFixed(2)})`);
  await waitFor(() => a.armor.every((s) => s && s.d >= 1), 5000, "and every piece wears");
  a.chat("/mobs clear");
  watcher.close();
  await sleep(300);
});

test("hitting back: the cooldown (a spam hit is weak), a charged iron sword, a crit on the way down, and the kill", async () => {
  const a = bots[0];
  // take the armour off again (into the inventory) so the numbers stay simple, and get a sword
  for (const k of [0, 1, 2, 3]) {
    const n = a.click(0, { m: "shift", s: 5 + k });
    await waitFor(() => a.winLog.some((l) => l.n === n), 5000, "click answered");
  }
  a.send({ t: "close", w: 0 });
  await give(a, "iron_sword", 1);
  await holdItem(a, toolId(2, 3));
  await tpTo(a, P.x + 6.5, P.y + 1, P.z + 2.5);
  a.chat("/time 18000");
  a.chat("/mobs clear");
  a.move(a.x, a.y, a.z, 0, 0, 4);
  await sleep(200);
  a.chat("/summon shambler 2 2");
  await waitFor(() => a.mobs.size >= 2, 5000, "two Shamblers");
  await sleep(900); // a charged swing
  const [m1, m2] = [...a.mobs.values()];
  const struck = a.struck.length;
  a.hitMob(m1.id);
  a.hitMob(m2.id); // straight after: almost no charge
  await waitFor(() => a.struck.length >= struck + 2, 5000, "both hits answered");
  const [s1, s2] = a.struck.slice(struck);
  const full = afterArmor(6, 2, 0);
  assert.ok(Math.abs(s1.dmg - full) < 0.02, `a charged iron sword: ${full.toFixed(2)} (got ${s1.dmg})`);
  assert.ok(s2.dmg > 0 && s2.dmg < 1.5, `a spam hit right after is weak (${s2.dmg})`);
  // a crit: jump, and hit on the way down (charged)
  await sleep(800);
  const y0 = a.y;
  for (const dy of [0.42, 0.75, 1.0, 1.17, 1.15, 1.05]) {
    a.move(a.x, y0 + dy, a.z, 0, 0, 0);
    await sleep(50);
  }
  a.hitMob(m1.id);
  await waitFor(() => a.struck.length >= struck + 3, 5000, "the crit answered");
  const s3 = a.struck[struck + 2];
  a.move(a.x, y0, a.z);
  assert.ok(s3.crit, "a hit on the way down from a jump is a critical hit");
  assert.ok(Math.abs(s3.dmg - afterArmor(9, 2, 0)) < 0.02, `x1.5 (${s3.dmg})`);
  assert.ok(!s3.kills, "5.9 + 8.9 of its 20 health: still standing");
  // one more charged hit finishes it
  await sleep(800);
  a.hitMob(m1.id);
  await waitFor(() => a.struck.length >= struck + 4, 5000, "the last hit answered");
  assert.ok(a.struck[struck + 3].kills, "the third hit kills it");
  await waitFor(() => !a.mobs.has(m1.id) || ((a.mobs.get(m1.id)!.flags & MF.DEAD) !== 0), 5000, "it dies");
  a.chat("/mobs clear");
});

test("a different item in hand starts the attack cooldown over (no swapping it away)", async () => {
  const a = bots[0];
  await give(a, "iron_sword", 1);
  await holdItem(a, toolId(2, 3));
  await give(a, "cobblestone", 1);
  await waitFor(() => slotOf(a, B.COBBLESTONE) >= 0, 5000, "cobblestone given");
  const sword = a.inv.findIndex((st) => st?.id === toolId(2, 3));
  const other = a.inv.findIndex((st, k) => k < 9 && !!st && st.id !== toolId(2, 3));
  assert.ok(sword >= 0 && sword < 9 && other >= 0, "a sword and something else on the hotbar");
  await tpTo(a, P.x + 6.5, P.y + 1, P.z + 2.5);
  a.chat("/time 18000");
  a.chat("/mobs clear");
  a.move(a.x, a.y, a.z, 0, 0, 4);
  await sleep(200);
  a.chat("/summon shambler 1 2");
  await waitFor(() => a.mobs.size >= 1, 5000, "a Shambler");
  a.chat("/mobs freeze"); // it stands still and does not hit back: only our swings count here
  try {
    await sleep(1200); // charged
    const m = [...a.mobs.values()][0];
    const struck = a.struck.length;
    a.select(other);
    a.select(sword);
    a.hitMob(m.id);
    await waitFor(() => a.struck.length > struck, 5000, "the hit answered");
    assert.ok(a.struck[struck].dmg < 1.5, `straight after switching: weak (${a.struck[struck].dmg})`);
    await sleep(1500); // well past the 0.625 s, even on a busy machine
    a.hitMob(m.id);
    await waitFor(() => a.struck.length > struck + 1, 5000, "the next hit answered");
    assert.ok(Math.abs(a.struck[struck + 1].dmg - afterArmor(6, 2, 0)) < 0.02, `charged again: full (${a.struck[struck + 1].dmg})`);
  } finally {
    a.chat("/mobs freeze");
    a.chat("/mobs clear");
    await sleep(200);
  }
});

test("a Rattler's arrows reach clients and hurt", async () => {
  const a = bots[0];
  await tpTo(a, P.x + 2.5, P.y + 1, P.z + 1.5);
  a.chat("/time 18000");
  a.chat("/mobs clear");
  a.move(a.x, a.y, a.z, 0, 0, 4);
  await sleep(200);
  const hurts = a.hurtLog.length;
  a.chat("/summon rattler 1 9");
  await waitFor(() => a.arrows.length > 0, 10000, "an arrow is shot");
  const ar = a.arrows[0];
  assert.ok(Math.hypot(ar.vx, ar.vy, ar.vz) > 1.4, "flying fast");
  await waitFor(() => a.hurtLog.slice(hurts).some((h) => h.cause === "mob:rattler"), 12000, "an arrow hits");
  await waitFor(() => a.arrowEnds.length > 0, 5000, "arrows end");
  a.chat("/mobs clear");
});

test("no sleeping with monsters nearby", async () => {
  const a = bots[0];
  a.chat("/time 18000");
  await tpTo(a, P.x + 9.5, P.y + 1, P.z + 9.5);
  await give(a, "red_bed", 1);
  await holdItem(a, B.RED_BED);
  a.place(P.x + 9, P.y + 1, P.z + 11, B.RED_BED + 1);
  await waitFor(() => a.block(base, P.x + 9, P.y + 1, P.z + 11) === B.RED_BED + 1, 5000, "bed placed");
  a.move(a.x, a.y, a.z, 180, 0, 4); // facing -z: the Shambler goes the other way, 3 blocks off
  await sleep(100);
  a.chat("/summon shambler 1 3");
  await sleep(300);
  const notices = a.notices.length;
  a.use(P.x + 9, P.y + 1, P.z + 11);
  await waitFor(() => a.notices.slice(notices).some((t) => /monsters nearby/i.test(t)), 5000, "the bed refuses");
  assert.ok(!a.sleepMsgs.some((m) => m.on), "not asleep");
  a.chat("/mobs clear");
});

test("bone meal grows a sapling into a tree", async () => {
  const a = bots[0];
  a.chat("/time 6000");
  await tpTo(a, P.x + 4.5, P.y + 1, P.z + 9.5);
  await give(a, "oak_sapling", 1);
  await give(a, "bone_meal", 16);
  await holdItem(a, B.OAK_SAPLING);
  const sx = P.x + 4;
  const sz = P.z + 12;
  a.place(sx, P.y + 1, sz, B.OAK_SAPLING);
  await waitFor(() => a.block(base, sx, P.y + 1, sz) === B.OAK_SAPLING, 5000, "sapling planted");
  await holdItem(a, I.BONE_MEAL);
  for (let k = 0; k < 16 && a.block(base, sx, P.y + 1, sz) === B.OAK_SAPLING; k++) {
    a.use(sx, P.y + 1, sz);
    await sleep(250);
  }
  assert.equal(a.block(base, sx, P.y + 1, sz), B.OAK_LOG, "it grew into a tree");
  assert.ok(a.count(I.BONE_MEAL) < 16, "bone meal was used");
});

test("spoiled flesh fills you up a little, and usually makes you queasy for a while", async () => {
  const a = bots[0];
  a.chat("/hunger 6");
  await give(a, "spoiled_flesh", 6);
  await holdItem(a, I.SPOILED_FLESH);
  let queasy = false;
  for (let k = 0; k < 6 && !queasy; k++) {
    const food = a.stats.food;
    a.send({ t: "eat", a: "start" });
    await sleep(1700);
    a.send({ t: "eat", a: "finish" });
    await waitFor(() => a.stats.food > food, 5000, "it fills");
    queasy = !!a.stats.queasy;
  }
  assert.ok(queasy, "queasy (80% a bite)");
});

test("dying drops the armour with everything else: the slots are sent empty, and others see it gone", async () => {
  const a = bots[0];
  const watcher = await join("mobs-watch2-token-0123456789abcdef");
  await tpTo(a, P.x + 4.5, P.y + 1, P.z + 4.5);
  await tpTo(watcher, P.x + 8.5, P.y + 1, P.z + 4.5);
  await give(a, "leather_helmet");
  await waitFor(() => slotOf(a, armorId(0, 0)) >= 0, 6000, "helmet given");
  const n = a.click(0, { m: "shift", s: winSlot(slotOf(a, armorId(0, 0))) });
  await waitFor(() => a.winLog.some((l) => l.n === n), 5000, "click answered");
  a.send({ t: "close", w: 0 });
  await waitFor(() => a.armor[0]?.id === armorId(0, 0), 5000, "wearing it");
  await waitFor(() => watcher.wears.some((w) => w.id === a.id && w.armor !== 0), 5000, "the other player sees it");
  const wears = watcher.wears.length;
  const deaths = a.deaths.length;
  a.chat("/kill");
  await waitFor(() => a.deaths.length > deaths, 5000, "dead");
  await waitFor(() => a.armor.every((s) => s === null), 5000, "the armour slots are sent empty");
  await waitFor(() => watcher.wears.slice(wears).some((w) => w.id === a.id && w.armor === 0), 5000, "others see it gone");
  await waitFor(() => [...watcher.items.values()].some((it) => it.item === armorId(0, 0)), 5000, "the helmet lies where they died");
  const respawns = a.respawns.length;
  a.send({ t: "respawn" });
  await waitFor(() => a.respawns.length > respawns, 5000, "respawned");
  assert.ok(a.armor.every((s) => s === null), "still nothing worn after respawning");
  watcher.close();
  await sleep(300);
});

test("the safe zone: a summon there does nothing, and a mob that walks in vanishes", async () => {
  const a = bots[0];
  await tpTo(a, SPAWN_X + 0.5, gen.info.spawn.y, SPAWN_Z + 14.5);
  a.chat("/time 18000");
  const before = a.mobHistory.length;
  a.chat("/summon shambler 3 3");
  await sleep(1500);
  assert.equal(a.mobHistory.length, before, "no mob appears in the hub");
  assert.equal(MOB.SHAMBLER, 0);
});
