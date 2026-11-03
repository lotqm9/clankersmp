// clankersmp v14: deep mining trips, measured. Each trial is a fresh body with a trip kit on open ground at dawn; the
// trip runs as in play (the brain's mine_trip, its reflexes on: the monsters of the deep caves come for it), carried
// on after a fight the way the brain's next turn would. It records how long until the first diamond, whether it came
// back up alive and before dusk, the haul and the fights.
// Test server: CLANKER=1 DEV_COMMANDS=1 MOBS=1 SAFE_ZONE=0 AGENTS=f1,...,f8 (never HARDCORE: a death is reset by
// reconnecting), its clock running from just before dawn: /time would stop the clock (the trip heads back by the time
// of day), so the world dir's shard-1/time.json shift sets it. One round of trials a server start; MINE_SEED picks
// other spots.
//   AGENT_SECRET=... node agents/mine-test.ts ws://127.0.0.1:8796 8 [min|iron] [out.jsonl]
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Body } from "./body.ts";
import { Brain } from "./brain.ts";
import { B, IS_WATER } from "../shared/blocks.ts";
import { I, itemDef } from "../shared/items.ts";
import { VILLAGE_SITES } from "../shared/villages.ts";

process.env.AGENT_STATE_DIR ||= mkdtempSync(join(tmpdir(), "mine-"));
const URL = process.argv[2] || "ws://127.0.0.1:8796";
const TRIALS = Number(process.argv[3] || 4);
const KIT_NAME = process.argv[4] || "min";
const OUT = process.argv[5] || "";
const SECRET = process.env.AGENT_SECRET ?? "";
const PARALLEL = 4;
const NAMES = ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// the least a trip lets it go with (an iron chestplate, a stone sword), and a full iron kit
const KITS: Record<string, string[]> = {
  min: ["iron_pickaxe 1", "stone_pickaxe 1", "stone_sword 1", "iron_chestplate 1", "torch 12", "bread 6", "cobblestone 24", "stone_shovel 1", "oak_planks 4"],
  iron: ["iron_pickaxe 1", "stone_pickaxe 1", "iron_sword 1", "iron_helmet 1", "iron_chestplate 1", "iron_leggings 1", "iron_boots 1", "torch 24", "cooked_porkchop 8", "cobblestone 32", "stone_shovel 1", "oak_planks 4"],
};
const KIT = KITS[KIT_NAME] ?? KITS.min;

interface Result {
  kit: string;
  trial: number;
  at: [number, number, number];
  diamondsNear: number; // diamond ore within 40 blocks across, at the diamond layer, when it set off
  alive: boolean;
  back: boolean; // out under the sky at the end
  beforeDusk: boolean; // and before time 11600
  startTime: number; // the time of day the trip set off, and when it was over
  endTime: number;
  firstDiamondS: number; // seconds into the trip (-1: none)
  secs: number;
  deepest: number;
  haul: Record<string, number>;
  minHp: number;
  reflexes: string[];
  calls: number; // how many times the trip was called (a fight cuts it short; the next turn carries on)
  result: string;
  trace: string[]; // every 10 s: time, depth, what it was doing
  death?: string;
}

async function connect(name: string): Promise<Body> {
  for (let k = 0; ; k++) {
    const b = new Body(name);
    try {
      await b.connect(URL, SECRET);
      await b.wait(5);
      return b;
    } catch (e) {
      if (k >= 6) throw e;
      await sleep(3000 + k * 2000);
    }
  }
}

const cmd = async (b: Body, text: string, ticks = 2) => {
  b.send({ t: "chat", text });
  await b.wait(ticks);
};

/** A body with nothing on it at full health (die over the sea, join again). */
async function fresh(name: string, old: Body | null): Promise<Body> {
  if (old && !old.closed) {
    if (!old.dead) {
      await cmd(old, "/tp 6 70 6", 4);
      await cmd(old, "/kill", 6);
    }
    old.close();
    await sleep(400);
  }
  const b = await connect(name);
  if (b.dead) {
    b.close();
    await sleep(400);
    return connect(name);
  }
  return b;
}

/** Open, dry grass away from the hub and the villages, on a 23-block grid (the same island every time). */
function startSpots(b: Body): { x: number; y: number; z: number; diamonds: number }[] {
  const villages = (b.world?.villages ?? []).map((k: number) => VILLAGE_SITES[k]).filter(Boolean);
  const top = (x: number, z: number) => {
    for (let y = 120; y > 1; y--) {
      const id = b.get(x, y, z);
      if (id !== B.AIR && id !== B.TALL_GRASS && id !== B.DANDELION && id !== B.POPPY && id !== B.BLUEBELL) return { y, id };
    }
    return { y: -1, id: 0 };
  };
  const out: { x: number; y: number; z: number; diamonds: number }[] = [];
  for (let z = 50; z < 470; z += 23)
    for (let x = 50; x < 470; x += 23) {
      if (Math.hypot(x - 256, z - 256) < 100 || villages.some((v: { x: number; z: number }) => Math.hypot(x - v.x, z - v.z) < 60)) continue;
      const t = top(x, z);
      if (t.id !== B.GRASS) continue;
      let dry = true;
      for (let dz = -5; dz <= 5 && dry; dz++) for (let dx = -5; dx <= 5 && dry; dx++) if (IS_WATER[top(x + dx, z + dz).id]) dry = false;
      if (!dry) continue;
      let diamonds = 0;
      for (let yy = 4; yy <= 16; yy++) for (let dz = -40; dz <= 40; dz++) for (let dx = -40; dx <= 40; dx++) if (b.get(x + dx, yy, z + dz) === B.DIAMOND_ORE) diamonds++;
      out.push({ x, y: t.y + 1, z, diamonds });
    }
  return out;
}

async function trial(k: number, name: string, at: { x: number; y: number; z: number; diamonds: number }, bodies: Map<string, Body | null>): Promise<Result> {
  const b = await fresh(name, bodies.get(name) ?? null);
  bodies.set(name, b);
  await cmd(b, `/tp ${at.x + 0.5} ${at.y + 0.5} ${at.z + 0.5}`, 12);
  for (const g of KIT) await cmd(b, `/give ${g}`, 1);
  await b.wait(6);
  b.wearBest();
  for (let w = 0; w < 60 && !b.armor.some(Boolean); w++) await b.wait(1);
  await cmd(b, "/hunger 20", 4);
  const br = new Brain(b.name, b, "sk-test", "http://127.0.0.1:9", URL.replace(/^ws/, "http"));
  const priv = br as unknown as {
    reflex: (label: string, fn: () => Promise<string>) => Promise<void>;
    exec: (name: string, i: Record<string, unknown>) => Promise<string>;
    exclusive: <T>(fn: () => Promise<T>) => Promise<T>;
    guard: () => Promise<void>;
    reflexing: boolean;
    skill: string;
    nightOutSince: number;
  };
  const reflexes: string[] = [];
  const orig = priv.reflex.bind(br);
  priv.reflex = (label, fn) => {
    reflexes.push(label);
    if (process.env.MINE_DEBUG) console.log(`[${name} ${new Date().toISOString().slice(11, 19)} y${Math.floor(b.phys.y)}] reflex: ${label}`);
    return orig(label, fn);
  };
  const timer = setInterval(() => {
    priv.nightOutSince = Date.now() + 1e9;
    void priv.guard();
  }, 250);
  let t0 = Date.now();
  let first = -1;
  let minHp = b.stats.hp;
  let deepest = Math.floor(b.phys.y);
  const before = new Map<number, number>([I.COAL, I.RAW_IRON, I.RAW_GOLD, I.RUBY, I.DIAMOND].map((id) => [id, b.count(id)]));
  const trace: string[] = [];
  let ticks = 0;
  const watch = setInterval(() => {
    if (ticks++ % 20 === 0) trace.push(`${Math.round((Date.now() - t0) / 1000)}s y${Math.floor(b.phys.y)} ${b.action}`);
    if (first < 0 && b.count(I.DIAMOND) > (before.get(I.DIAMOND) ?? 0)) first = (Date.now() - t0) / 1000;
    if (!b.dead) minHp = Math.min(minHp, b.stats.hp);
    deepest = Math.min(deepest, Math.floor(b.phys.y));
  }, 500);
  let result = "";
  let calls = 0;
  // daylight first (a trip is refused at night); the clock starts with the trip
  while (b.isNight() && !b.dead) await b.wait(10);
  t0 = Date.now();
  const startTime = b.timeOfDay();
  // the trip; cut short by a fight (or the climb-out reflex), the next turn calls it again
  for (; calls < 10 && !b.dead && Date.now() - t0 < 14 * 60000; ) {
    while (priv.reflexing) await sleep(250);
    if (b.dead) break;
    calls++;
    priv.skill = "mine_trip";
    result = await priv.exclusive(() => priv.exec("mine_trip", {}));
    priv.skill = "";
    console.log(`  ${name} #${k} (${((Date.now() - t0) / 1000).toFixed(0)}s, y ${Math.floor(b.phys.y)}, time ${b.timeOfDay()}): ${result.slice(0, 220)}`);
    if (!/still down the mine/.test(result)) break;
    await sleep(800);
  }
  // still below after all that: whatever the reflexes do next (the climb-out before dusk)
  for (let w = 0; w < 120 && !b.dead && priv.reflexing; w++) await sleep(500);
  clearInterval(timer);
  clearInterval(watch);
  br.stop();
  await sleep(500);
  const haul: Record<string, number> = {};
  for (const [id, n] of before) if (b.count(id) > n) haul[itemDef(id)?.key ?? String(id)] = b.count(id) - n;
  const fx = Math.floor(b.phys.x);
  const fy = Math.floor(b.phys.y + 0.1);
  const fz = Math.floor(b.phys.z);
  const back = !b.dead && b.underSky(fx, fy + 1, fz);
  return {
    kit: KIT_NAME, trial: k, at: [at.x, at.y, at.z], diamondsNear: at.diamonds, alive: !b.dead, back, beforeDusk: back && (b.timeOfDay() < 11600 || b.timeOfDay() > 23000),
    startTime, endTime: b.timeOfDay(), firstDiamondS: Math.round(first), secs: Math.round((Date.now() - t0) / 1000), deepest, haul, minHp: Math.round(minHp * 10) / 10,
    reflexes: [...new Set(reflexes)], calls, result: result.slice(0, 400), trace, death: b.dead ? b.deathMsg : undefined,
  };
}

const probe = await connect("f8");
const spots = startSpots(probe).filter((s) => s.diamonds > 0);
console.log(`${spots.length} start spots (diamond ore within 40: median ${spots.map((s) => s.diamonds).sort((p, q) => p - q)[Math.floor(spots.length / 2)]})`);
probe.close();
// spread the trials over the island: a shuffled pick of spots at least 60 apart
let seed = Number(process.env.MINE_SEED || 7);
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const order = spots.map((s) => ({ s, r: rand() })).sort((p, q) => p.r - q.r).map((o) => o.s);
const bodies = new Map<string, Body | null>();
const all: Result[] = [];
let next = 0;
for (let k0 = 0; k0 < TRIALS; k0 += PARALLEL) {
  const n = Math.min(PARALLEL, TRIALS - k0);
  const picked: typeof spots = [];
  while (picked.length < n && next < order.length) {
    const s = order[next++];
    if (picked.every((q) => Math.hypot(s.x - q.x, s.z - q.z) >= 60)) picked.push(s);
  }
  // the round starts at dawn (the clock runs: the server was started just before it)
  const any = await connect("f8");
  if (any.timeOfDay() < 22000 && any.timeOfDay() > 2000) console.log(`  (it's time ${any.timeOfDay()}, not dawn: start the server with its clock just before dawn)`);
  // (the trips set off once it is light: the bodies come in then, not into the last of the night)
  while (any.isNight()) await any.wait(20);
  await cmd(any, "/mobs clear", 4);
  any.close();
  console.log(`round ${k0 / PARALLEL + 1}: ${picked.map((p) => `${p.x},${p.z} (${p.diamonds} diamond ore near)`).join("; ")}`);
  const res = await Promise.all(picked.map((at, j) => trial(k0 + j, NAMES[j], at, bodies).catch((e) => {
    console.error("trial failed", e);
    return null;
  })));
  for (const r of res) {
    if (!r) continue;
    all.push(r);
    console.log(`${r.kit} #${r.trial} at ${r.at.join(" ")}: ${r.alive ? (r.back ? `back up alive${r.beforeDusk ? " before dusk" : " (after dusk)"}` : "ALIVE BUT STILL BELOW") : `DIED (${r.death})`}, first diamond ${r.firstDiamondS >= 0 ? `${r.firstDiamondS}s` : "never"}, ${r.secs}s, deepest y ${r.deepest}, haul ${JSON.stringify(r.haul)}, low hp ${r.minHp} | ${r.reflexes.join("; ")}`);
    if (OUT) appendFileSync(OUT, JSON.stringify(r) + "\n");
  }
}
console.log("\nsummary");
const got = all.filter((r) => r.firstDiamondS >= 0).map((r) => r.firstDiamondS).sort((p, q) => p - q);
const med = got.length ? got[Math.floor(got.length / 2)] : -1;
const diamonds = all.reduce((a, r) => a + (r.haul.diamond ?? 0), 0);
console.log(`${KIT_NAME}: ${all.length} trips, lived ${all.filter((r) => r.alive).length}, back up ${all.filter((r) => r.back).length} (before dusk ${all.filter((r) => r.beforeDusk).length}), a diamond in ${got.length}/${all.length} (first one after ${med >= 0 ? `${med}s median, ${got[0]}-${got[got.length - 1]}s` : "-"}), ${diamonds} diamonds in all, ${(all.reduce((a, r) => a + (r.haul.raw_iron ?? 0), 0) / Math.max(1, all.length)).toFixed(1)} raw iron and ${(all.reduce((a, r) => a + (r.haul.ruby ?? 0), 0) / Math.max(1, all.length)).toFixed(1)} rubies a trip, ${(all.reduce((a, r) => a + r.secs, 0) / Math.max(1, all.length) / 60).toFixed(1)} min a trip`);
for (const b of bodies.values()) b?.close();
process.exit(0);
