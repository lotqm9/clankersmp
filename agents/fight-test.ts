// clankersmp: fight tests. The agents' own reflexes (Brain.guard, no Claude calls) against summoned monsters, many
// trials at once in flat open arenas spread over the island, each with a fresh body and a known kit, health and
// armour. Prints how many lived, how many monsters died, and the health left.
// Test server: CLANKER=1 DEV_COMMANDS=1 MOBS=0 SAFE_ZONE=0 AGENTS=f1,...,f8 (never HARDCORE: a death is reset by
// reconnecting).
//   AGENT_SECRET=... node agents/fight-test.ts ws://127.0.0.1:8798 sh1,ra1 6 [out.jsonl]
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Body } from "./body.ts";
import { Brain } from "./brain.ts";
import { B, IS_WATER, SOLID } from "../shared/blocks.ts";
import { MF } from "../shared/mobs.ts";
import { VILLAGE_SITES } from "../shared/villages.ts";

process.env.AGENT_STATE_DIR ||= mkdtempSync(join(tmpdir(), "fight-"));
const URL = process.argv[2] || "ws://127.0.0.1:8798";
const WANT = (process.argv[3] || "sh1").split(",");
const TRIALS = Number(process.argv[4] || 4);
const OUT = process.argv[5] || "";
const SECRET = process.env.AGENT_SECRET ?? "";
const NAMES = ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BASE = ["dirt 32", "cobblestone 16", "torch 4", "cooked_porkchop 8", "stone_pickaxe 1"];
const STONE = ["stone_sword 1"];
const IRON = ["iron_sword 1", "iron_helmet 1", "iron_chestplate 1", "iron_leggings 1", "iron_boots 1"];
const BOW = ["bow 1", "arrow 32"];
const LEATHER = ["leather_helmet 1", "leather_chestplate 1", "leather_leggings 1", "leather_boots 1"];
interface Scenario {
  kit: string[];
  hp: number;
  mobs: [string, number, number][]; // kind, count, distance in front
  team?: boolean; // two agents side by side
  apart?: number; // ... or this far apart (the second behind the first): only the first is attacked
  tunnel?: boolean; // in a one-wide corridor four blocks down
  pit?: number; // at the bottom of a pit this deep (five across, a ravine's floor); the monsters up on the rim
  secs?: number;
}
const SCEN: Record<string, Scenario> = {
  sh1: { kit: [...BASE, ...STONE], hp: 20, mobs: [["shambler", 1, 8]] },
  sh1low: { kit: [...BASE, ...STONE], hp: 8, mobs: [["shambler", 1, 8]] },
  sh2: { kit: [...BASE, ...STONE], hp: 20, mobs: [["shambler", 2, 8]] },
  sh3iron: { kit: [...BASE, ...IRON], hp: 20, mobs: [["shambler", 3, 9]] },
  ra1: { kit: [...BASE, ...STONE, ...BOW], hp: 20, mobs: [["rattler", 1, 12]] },
  ra1low: { kit: [...BASE, ...STONE, ...BOW], hp: 10, mobs: [["rattler", 1, 12]] },
  ra2iron: { kit: [...BASE, ...IRON, ...BOW], hp: 20, mobs: [["rattler", 2, 12]] },
  sk1: { kit: [...BASE, ...STONE], hp: 20, mobs: [["skitter", 1, 8]] },
  mix: { kit: [...BASE, ...STONE, ...BOW], hp: 20, mobs: [["shambler", 1, 8], ["rattler", 1, 13]] },
  mixiron: { kit: [...BASE, ...IRON, ...BOW], hp: 20, mobs: [["shambler", 2, 8], ["rattler", 1, 13], ["skitter", 1, 10]] },
  team3: { kit: [...BASE, ...STONE], hp: 20, mobs: [["shambler", 3, 9]], team: true },
  // one attacked by two at low health, another of the pack 14 blocks off: does it come and help?
  help2: { kit: [...BASE, ...STONE], hp: 14, mobs: [["shambler", 2, 7]], team: true, apart: 14 },
  // v14: armed and armoured (a stone sword and leather, or full iron), no bow: they should take it on and finish it
  a_sh2: { kit: [...BASE, ...STONE, ...LEATHER], hp: 20, mobs: [["shambler", 2, 8]] },
  a_sk2: { kit: [...BASE, ...STONE, ...LEATHER], hp: 20, mobs: [["skitter", 2, 8]] },
  a_ra1: { kit: [...BASE, ...STONE, ...LEATHER], hp: 20, mobs: [["rattler", 1, 12]] },
  a_mix: { kit: [...BASE, ...STONE, ...LEATHER], hp: 20, mobs: [["shambler", 1, 8], ["rattler", 1, 13], ["skitter", 1, 10]] },
  i_ra2: { kit: [...BASE, ...IRON], hp: 20, mobs: [["rattler", 2, 12]] },
  i_mix: { kit: [...BASE, ...IRON], hp: 20, mobs: [["shambler", 2, 8], ["rattler", 1, 13], ["skitter", 1, 10]] },
  a_help: { kit: [...BASE, ...STONE, ...LEATHER], hp: 20, mobs: [["shambler", 2, 7], ["rattler", 1, 12]], team: true, apart: 14 },
  // haiku's death (season 13 day 11): iron helmet, chestplate and boots, no sword (a pickaxe in the kit), a rattler
  ip_ra1: { kit: [...BASE, "iron_helmet 1", "iron_chestplate 1", "iron_boots 1"], hp: 20, mobs: [["rattler", 1, 12]] },
  tunnel: { kit: [...BASE, ...STONE], hp: 7, mobs: [["shambler", 1, 4]], tunnel: true },
  // harder ones, like the real deaths: low health against two, three at once, an archer down a mine, no bow
  sh2low: { kit: [...BASE, ...STONE], hp: 10, mobs: [["shambler", 2, 7]] },
  sh3: { kit: [...BASE, ...STONE], hp: 20, mobs: [["shambler", 3, 8]] },
  tunnelra: { kit: [...BASE, ...STONE], hp: 14, mobs: [["rattler", 1, 4]], tunnel: true },
  ra1nobow: { kit: [...BASE, ...STONE], hp: 20, mobs: [["rattler", 1, 12]] },
  // opus's death (season 14): an iron helmet and chestplate, just dug out of a mine into a ravine, a rattler up on the
  // edge, out of reach from the floor; it charged twice, then put up blocks, and was shot dead
  pit_ra1: { kit: [...BASE, ...STONE, "iron_helmet 1", "iron_chestplate 1"], hp: 20, mobs: [["rattler", 1, 4]], pit: 3 },
  pit_ra2: { kit: [...BASE, ...STONE, "iron_helmet 1", "iron_chestplate 1"], hp: 20, mobs: [["rattler", 2, 4]], pit: 3 },
  // the same five deep: a rattler on the edge is out of a sword's reach from the floor
  pit5_ra1: { kit: [...BASE, ...STONE, "iron_helmet 1", "iron_chestplate 1"], hp: 20, mobs: [["rattler", 1, 4]], pit: 5 },
  pit5_ra2: { kit: [...BASE, ...STONE, "iron_helmet 1", "iron_chestplate 1"], hp: 20, mobs: [["rattler", 2, 4]], pit: 5 },
};

interface Result {
  scen: string;
  trial: number;
  alive: boolean;
  hp: number;
  killed: number;
  mobs: number;
  secs: number;
  minHp: number; // the lowest it got
  taken: number; // damage taken in all (half hearts)
  reflexes: string[];
  helps: number; // v14: how many times its help reflex fired (once a fight)
  death?: string;
}

/** Flat, dry, open spots away from the hub and the villages (the same island every time: seed 1014). */
function arenas(b: Body): { x: number; y: number; z: number; rough: number }[] {
  const villages = (b.world?.villages ?? []).map((k: number) => VILLAGE_SITES[k]).filter(Boolean);
  const plant = new Set<number>([B.AIR, B.TALL_GRASS, B.DANDELION, B.POPPY, B.BLUEBELL]);
  const tree = new Set<number>([B.OAK_LEAVES, B.BIRCH_LEAVES, B.PALM_LEAVES, B.OAK_LOG, B.BIRCH_LOG, B.PALM_LOG]);
  const top = (x: number, z: number) => {
    for (let y = 120; y > 1; y--) {
      const id = b.get(x, y, z);
      if (!plant.has(id)) return { y, id };
    }
    return { y: -1, id: 0 };
  };
  const out: { x: number; y: number; z: number; rough: number }[] = [];
  for (let cz = 30; cz < 482; cz += 3)
    for (let cx = 30; cx < 482; cx += 3) {
      if (Math.hypot(cx - 256, cz - 256) < 100) continue;
      if (villages.some((v: { x: number; z: number }) => Math.hypot(cx - v.x, cz - v.z) < 55)) continue;
      const c = top(cx, cz);
      if (c.id !== B.GRASS && c.id !== B.DIRT) continue;
      let ok = true;
      let rough = 0;
      for (let dz = -9; dz <= 9 && ok; dz++)
        for (let dx = -9; dx <= 9 && ok; dx++) {
          const r = Math.hypot(dx, dz);
          if (r > 9) continue;
          const t = top(cx + dx, cz + dz);
          if (IS_WATER[t.id]) ok = false;
          else if (tree.has(t.id)) ok = r > 6;
          else if (r <= 7) {
            rough += Math.abs(t.y - c.y);
            if (Math.abs(t.y - c.y) > 2 || !SOLID[t.id]) ok = false;
          }
        }
      if (ok) out.push({ x: cx, y: c.y + 1, z: cz, rough });
    }
  return out.sort((p, q) => p.rough - q.rough);
}

async function connect(name: string): Promise<Body> {
  for (let k = 0; ; k++) {
    const b = new Body(name);
    try {
      await b.connect(URL, SECRET);
      await b.wait(5);
      return b;
    } catch (e) {
      // the server limits how fast one address may connect (429): wait and try again
      if (k >= 6) throw e;
      await sleep(3000 + k * 2000);
    }
  }
}

const cmd = async (b: Body, text: string, ticks = 2) => {
  b.send({ t: "chat", text });
  await b.wait(ticks);
};

/** A body with nothing on it at full health: die over the sea (what it carried drops there), then join again. */
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

async function trial(scen: string, k: number, names: string[], at: { x: number; y: number; z: number }, bodies: Map<string, Body | null>): Promise<Result[]> {
  const s = SCEN[scen];
  const team: Body[] = [];
  for (const [j, name] of names.entries()) {
    const b = await fresh(name, bodies.get(name) ?? null);
    bodies.set(name, b);
    team.push(b);
    await cmd(b, `/tp ${at.x + 0.5 + (s.apart ? 0 : j * 2)} ${at.y + 0.5} ${at.z + 0.5 - (s.apart ? j * s.apart : 0)}`, 10);
    b.wantYaw = b.yaw = 0;
    b.wantPitch = b.pitch = 0;
    for (const g of s.kit) await cmd(b, `/give ${g}`, 1);
    await b.wait(6);
    b.wearBest();
    await b.wait(6);
  }
  const lead = team[0];
  if (s.tunnel) {
    const x = Math.floor(lead.phys.x), z = Math.floor(lead.phys.z), y = Math.floor(lead.phys.y + 0.1);
    for (let d = 1; d <= 4; d++) {
      await lead.mine(x, y - d, z, false);
      await lead.wait(6);
    }
    // a one-wide corridor two long, opening into a 3 x 3 chamber (a cave met by a mine): the monster is summoned in the
    // chamber (/summon scatters it a block either way, which in a one-wide corridor put it in the rock)
    const yy = Math.floor(lead.phys.y + 0.1);
    for (let dz = 1; dz <= 2; dz++) for (const dy of [0, 1]) await lead.mine(x, yy + dy, z + dz, false);
    for (let dz = 3; dz <= 5; dz++) for (let dx = -1; dx <= 1; dx++) for (const dy of [0, 1]) {
      if (!SOLID[lead.get(x + dx, yy + dy, z + dz)]) continue;
      if (lead.reachTo(x + dx, yy + dy, z + dz) > 4.2) await lead.goto(x + 0.5, yy, z + dz - 1.5, 0.6, { maxMs: 3000 });
      await lead.mine(x + dx, yy + dy, z + dz, false);
    }
    // back to the foot of the shaft, facing down the corridor (the monster is summoned four blocks in front)
    await lead.goto(x + 0.5, yy, z + 0.5, 0.8, { maxMs: 6000 });
    await lead.center(x, z, 40);
    lead.wantYaw = 0;
    await lead.wait(10);
    if (Math.hypot(lead.phys.x - x - 0.5, lead.phys.z - z - 0.5) > 0.4) console.log(`  (tunnel setup: not back at the shaft, at ${lead.phys.x.toFixed(1)} ${lead.phys.z.toFixed(1)})`);
  }
  if (s.pit) {
    // dug out a layer at a time, the eight round it then its own column (it drops with it), then faced one way
    const x = Math.floor(lead.phys.x), z = Math.floor(lead.phys.z), y = Math.floor(lead.phys.y + 0.1);
    for (let d = 1; d <= s.pit; d++) {
      const ring: [number, number][] = [];
      for (let a = -2; a <= 2; a++) for (let c = -2; c <= 2; c++) if (a || c) ring.push([a, c]);
      for (const [dx, dz] of [...ring.sort((p, q) => Math.hypot(...q) - Math.hypot(...p)), [0, 0]]) {
        if (SOLID[lead.get(x + dx, y - d, z + dz)]) await lead.mine(x + dx, y - d, z + dz, false);
        if (dx === 0 && dz === 0) await lead.wait(8);
      }
    }
    await lead.center(x, z, 30);
    lead.wantYaw = 0;
    await lead.wait(10);
    const fy = Math.floor(lead.phys.y + 0.1);
    if (fy !== y - s.pit) console.log(`  (pit setup: at y ${fy}, the pit's floor is ${y - s.pit})`);
  }
  for (const b of team) {
    await cmd(b, `/hunger 20`, 1);
    if (s.hp < 20) await cmd(b, `/hurt ${20 - s.hp}`, 1);
  }
  await lead.wait(4);
  for (const [kind, n, d] of s.mobs) await cmd(lead, `/summon ${kind} ${n} ${d}`, 2);
  await lead.wait(10);
  if (s.pit) {
    const up = lead.hostiles(16).filter((m) => m.y > lead.phys.y + 2);
    if (!up.length) console.log(`  (pit setup: no monster up on the rim: ${lead.hostiles(16).map((m) => `${m.key} ${m.y.toFixed(1)}`).join(", ") || "none"})`);
  }
  if (s.tunnel) {
    // the monster must be down here in the chamber (one that ended up in the rock is pushed up to the surface)
    const m = lead.hostiles(12)[0];
    if (!m || Math.abs(m.y - lead.phys.y) > 1.5) console.log(`  (tunnel setup: the monster isn't in the chamber: ${m ? `${m.x.toFixed(1)} ${m.y.toFixed(1)} ${m.z.toFixed(1)}` : "none"})`);
  }
  // the agents' reflexes, as in play (no night-out dig-in timer: the trial is about the monsters)
  const brains = team.map((b) => new Brain(b.name, b, "sk-test", "http://127.0.0.1:9", URL.replace(/^ws/, "http")));
  const reflexes = team.map(() => [] as string[]);
  brains.forEach((br, j) => {
    const r = br as unknown as { reflex: (label: string, fn: () => Promise<string>) => Promise<void> };
    const orig = r.reflex.bind(br);
    r.reflex = (label, fn) => {
      reflexes[j].push(label);
      return orig(label, fn);
    };
  });
  const seen = new Set<number>();
  const died = new Set<number>();
  const t0 = Date.now();
  const limit = (s.secs ?? 60) * 1000;
  const timers = brains.map((br) =>
    setInterval(() => {
      (br as unknown as { nightOutSince: number }).nightOutSince = Date.now() + 1e9;
      void (br as unknown as { guard: () => Promise<void> }).guard();
    }, 250),
  );
  // and, as in play, each one's line on the board every second (what it's doing: the others answer a call for help
  // only while the caller is still at it)
  const beats = brains.map((br) => setInterval(() => (br as unknown as { beat?: () => void }).beat?.(), 1000));
  let calm = 0;
  const minHp = team.map((b) => b.stats.hp);
  const lastHp = team.map((b) => b.stats.hp);
  const taken = team.map(() => 0);
  while (Date.now() - t0 < limit) {
    await sleep(250);
    team.forEach((b, j) => {
      const hp = b.dead ? 0 : b.stats.hp;
      if (hp < lastHp[j]) taken[j] += lastHp[j] - hp;
      lastHp[j] = hp;
      minHp[j] = Math.min(minHp[j], hp);
    });
    for (const b of team)
      for (const m of b.mobs.values()) {
        if (Math.hypot(m.x - at.x, m.z - at.z) > 40) continue;
        seen.add(m.id);
        if (m.flags & MF.DEAD) died.add(m.id);
      }
    if (team.every((b) => b.dead)) break;
    const live = team.filter((b) => !b.dead);
    const near = live.some((b) => b.hostiles(24).length > 0);
    calm = near ? 0 : calm + 1;
    if (calm > 12 && seen.size) break;
  }
  timers.forEach(clearInterval);
  beats.forEach(clearInterval);
  brains.forEach((br) => br.stop());
  await sleep(500);
  return team.map((b, j) => ({
    scen, trial: k, alive: !b.dead, hp: b.dead ? 0 : Math.round(b.stats.hp * 10) / 10, killed: died.size, mobs: Math.max(seen.size, s.mobs.reduce((a, m) => a + m[1], 0)),
    secs: Math.round((Date.now() - t0) / 1000), minHp: Math.round(minHp[j] * 10) / 10, taken: Math.round(taken[j] * 10) / 10, reflexes: [...new Set(reflexes[j])], helps: reflexes[j].filter((x) => x.startsWith("helping")).length, death: b.dead ? b.deathMsg : undefined,
  }));
}

const probe = await connect("f8");
const spots = arenas(probe);
await cmd(probe, "/time 18000", 4);
await cmd(probe, "/mobs clear", 4);
probe.close();
console.log(`${spots.length} arena spots`);
const used = new Map<string, number>();
const bodies = new Map<string, Body | null>();
const all: Result[] = [];
const jobs: { scen: string; k: number }[] = [];
for (let k = 0; k < TRIALS; k++) for (const sc of WANT) if (SCEN[sc]) jobs.push({ scen: sc, k });
while (jobs.length) {
  // a round: as many trials as there are bodies, each in its own arena, 85 blocks apart
  const round: { scen: string; k: number; names: string[]; at: { x: number; y: number; z: number } }[] = [];
  const free = [...NAMES.slice(0, 7)];
  const picked: { x: number; z: number }[] = [];
  while (jobs.length && free.length) {
    const job = jobs[0];
    const need = SCEN[job.scen].team ? 2 : 1;
    if (free.length < need) break;
    const at = spots
      .filter((p) => picked.every((q) => Math.hypot(p.x - q.x, p.z - q.z) >= 85))
      .sort((p, q) => (used.get(`${p.x},${p.z}`) ?? 0) - (used.get(`${q.x},${q.z}`) ?? 0) || p.rough - q.rough)[0];
    if (!at) break;
    jobs.shift();
    used.set(`${at.x},${at.z}`, (used.get(`${at.x},${at.z}`) ?? 0) + 1);
    // the next use of a spot is beside the last one (holes and walls left from the last fight)
    const n = used.get(`${at.x},${at.z}`)! - 1;
    const off = [[0, 0], [5, 0], [-5, 0], [0, 5], [0, -5], [5, 5], [-5, -5], [5, -5], [-5, 5]][n % 9];
    const spot = { x: at.x + off[0], y: at.y, z: at.z + off[1] };
    picked.push(at);
    round.push({ ...job, names: free.splice(0, need), at: spot });
  }
  const res = await Promise.all(round.map((r) => trial(r.scen, r.k, r.names, r.at, bodies).catch((e) => {
    console.error("trial failed", r.scen, e);
    return [] as Result[];
  })));
  for (const list of res)
    for (const r of list) {
      all.push(r);
      console.log(`${r.scen} #${r.trial}: ${r.alive ? `lived, ${r.hp} hp (low ${r.minHp}, took ${r.taken})` : `DIED (${r.death})`}, ${r.killed}/${r.mobs} monsters dead, ${r.secs}s | ${r.reflexes.join("; ")}`);
      if (OUT) appendFileSync(OUT, JSON.stringify(r) + "\n");
    }
  const any = bodies.values().next().value;
  if (any && !any.closed) await cmd(any, "/mobs clear", 4);
}
console.log("\nsummary");
for (const sc of WANT) {
  const rs = all.filter((r) => r.scen === sc);
  if (!rs.length) continue;
  const lived = rs.filter((r) => r.alive).length;
  const hp = rs.filter((r) => r.alive).reduce((a, r) => a + r.hp, 0) / Math.max(1, lived);
  const kills = rs.reduce((a, r) => a + r.killed, 0) / rs.length;
  const took = rs.reduce((a, r) => a + r.taken, 0) / rs.length;
  const secs = rs.reduce((a, r) => a + r.secs, 0) / rs.length;
  // gave ground: took cover, ran, walled off, dug in or went up a pillar
  const gave = rs.filter((r) => r.reflexes.some((x) => /cover|running|getting away|wall|dig|pillar|flee|line of sight/.test(x))).length;
  const helps = rs.reduce((a, r) => a + (r.helps ?? 0), 0);
  const cleared = rs.filter((r) => r.killed >= r.mobs).length;
  console.log(`${sc}: lived ${lived}/${rs.length}, damage taken ${took.toFixed(1)}, avg hp left ${hp.toFixed(1)}, monsters killed per trial ${kills.toFixed(2)}, killed them all in ${cleared}/${rs.length}, gave ground in ${gave}/${rs.length}${helps ? `, helped ${helps} times` : ""}, ${secs.toFixed(0)}s`);
}
for (const b of bodies.values()) b?.close();
process.exit(0);
