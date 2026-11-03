// clankersmp: how a body walks, measured. A throwaway test server (CLANKER=1 DEV_COMMANDS=1 MOBS=0 SAFE_ZONE=0, a fresh
// WORLD_DIR: every scenario changes the ground it runs on), the seed-1014 island, one body. Each scenario runs one
// movement job and prints what came of it and how it looked: the time, blocks walked against how far it got, jumps,
// sharp turns back, the head's turning in degrees a minute, and spins (a whole turn of the head inside 3 s: the
// "spinning in circles" Laith saw on the site).
//   AGENT_SECRET=... node agents/nav-test.ts ws://127.0.0.1:8790 [think,village,hill,shut,logging,stairs,hole,nighthole,pocket,house,outoftown]
// Getting out of buildings: `town` writes a world with one of every building at its top tier, each on its own lot
// (start a test server on it: WORLD_DIR=<dir>), then `exits` puts the body down inside each one (at the far end of the
// room, in the middle, or by the door) and walks it out to the street:
//   node agents/nav-test.ts town <dir> [open|shut]
//   AGENT_SECRET=... node agents/nav-test.ts ws://127.0.0.1:8790 exits <dir> [far|mid|near]
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { B, IS_WATER, SOLID } from "../shared/blocks.ts";
import { idx } from "../shared/constants.ts";
import { door, doorId, isDoor, placementCells } from "../shared/shapes.ts";
import { generateWorld } from "../shared/worldgen.ts";
import { VILLAGE_SITES } from "../shared/villages.ts";
import { cellTarget, doorStep, maxTier, planFor, sizeFacing, type Plain } from "./civ.ts";

type Pose = { t: number; x: number; y: number; z: number; yaw: number };
const angle = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180;
const TREE = new Set<number>([B.OAK_LEAVES, B.BIRCH_LEAVES, B.PALM_LEAVES, B.OAK_LOG, B.BIRCH_LOG, B.PALM_LOG]);

/** How it moved: from its pose every tick (the distances at 4 a second, the way tools/motion.mjs samples the live game). */
function measure(tr: Pose[]): string {
  if (tr.length < 2) return "(no movement)";
  const secs = (tr[tr.length - 1].t - tr[0].t) / 1000;
  const q: Pose[] = [];
  for (const p of tr) if (!q.length || p.t - q[q.length - 1].t >= 250) q.push(p);
  let walked = 0;
  let jumps = 0;
  let rising = false;
  let back = 0;
  let dir: number | null = null;
  for (let i = 1; i < q.length; i++) {
    const d = Math.hypot(q[i].x - q[i - 1].x, q[i].z - q[i - 1].z);
    walked += d;
    if (q[i].y - q[i - 1].y > 0.3 && !rising) {
      jumps++;
      rising = true;
    }
    if (q[i].y <= q[i - 1].y) rising = false;
    if (d > 0.15) {
      const a = Math.atan2(q[i].z - q[i - 1].z, q[i].x - q[i - 1].x);
      if (dir !== null) {
        let t = Math.abs(a - dir);
        if (t > Math.PI) t = 2 * Math.PI - t;
        if (t > 2.2) back++;
      }
      dir = a;
    }
  }
  let turned = 0;
  let spins = 0;
  for (let i = 1, j = 0, acc = 0; i < tr.length; i++) {
    const t = Math.abs(angle(tr[i].yaw, tr[i - 1].yaw));
    turned += t;
    acc += t;
    while (tr[i].t - tr[j].t > 3000) {
      acc -= Math.abs(angle(tr[j + 1].yaw, tr[j].yaw));
      j++;
    }
    if (acc >= 360) {
      spins++;
      acc = 0;
      j = i;
    }
  }
  const net = Math.hypot(tr[tr.length - 1].x - tr[0].x, tr[tr.length - 1].z - tr[0].z);
  return `${secs.toFixed(1)} s, walked ${walked.toFixed(1)}, got ${net.toFixed(1)} from the start, ${jumps} jumps, ${back} sharp turns back, head turned ${Math.round((turned / Math.max(secs, 1)) * 60)} deg/min, ${spins} spins`;
}

// ---------------------------------------------------------------- the test town (no server needed)

if (process.argv[2] === "town") {
  const dir = process.argv[3];
  const shut = process.argv[4] === "shut";
  const villages = [0, 1, 2, 3];
  const { blocks } = generateWorld(1014, undefined, { villages, hub: { keep: [], roads: villages } });
  const get = (x: number, y: number, z: number) => (y < 0 || y > 127 ? 0 : blocks[idx(x, y, z)]);
  const top = (x: number, z: number) => {
    for (let y = 120; y > 1; y--) {
      const id = get(x, y, z);
      if (IS_WATER[id]) return -1;
      if (SOLID[id] && !TREE.has(id)) return y;
    }
    return -1;
  };
  const edits = new Map<number, number>();
  const set = (x: number, y: number, z: number, id: number) => (get(x, y, z) === id ? edits.delete(idx(x, y, z)) : edits.set(idx(x, y, z), id));
  const at = (x: number, y: number, z: number) => edits.get(idx(x, y, z)) ?? get(x, y, z);
  const kinds: Plain[] = ["house", "storehouse", "hall", "market", "tower", "keep", "smithy", "bakery", "tavern", "library", "chapel", "barn", "cathedral"];
  // lots on the land west and north-west of the hub, clear of it and of the villages
  const spots: [number, number][] = [];
  for (let z = 100; z <= 250; z += 34)
    for (let x = 60; x <= 240; x += 34) {
      if (Math.hypot(x - 256, z - 256) < 95 || villages.some((k) => Math.hypot(x - VILLAGE_SITES[k].x, z - VILLAGE_SITES[k].z) < 50)) continue;
      let land = 0;
      for (let dz = -10; dz <= 10; dz += 2) for (let dx = -10; dx <= 10; dx += 2) if (top(x + dx, z + dz) >= 0) land++;
      if (land > 110) spots.push([x, z]);
    }
  const sites: unknown[] = [];
  for (const [n, kind] of kinds.entries()) {
    const [cx, cz] = spots[n];
    const face = n % 4;
    const [w, d] = sizeFacing(kind, face);
    const x0 = cx - Math.floor(w / 2);
    const z0 = cz - Math.floor(d / 2);
    const [x1, z1] = [x0 + w - 1, z0 + d - 1];
    // the lot: flattened at the middle height of what's there, 6 blocks out round the building
    const hs: number[] = [];
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) hs.push(top(x, z));
    hs.sort((a, b) => a - b);
    const g = Math.max(44, hs[Math.floor(hs.length / 2)]);
    for (let x = x0 - 6; x <= x1 + 6; x++)
      for (let z = z0 - 6; z <= z1 + 6; z++) {
        for (let y = g + 1; y <= g + 30; y++) set(x, y, z, B.AIR);
        set(x, g, z, B.GRASS);
        for (let y = g - 4; y < g; y++) if (!SOLID[get(x, y, z)] || IS_WATER[get(x, y, z)]) set(x, y, z, B.DIRT);
      }
    const site = { kind, x0, z0, x1, z1, y: g + 1, face };
    const cells = planFor(site, maxTier(kind), () => g);
    const doors: number[][] = [];
    for (const [x, y, z, k] of cells) {
      const k0 = k.split("|")[0];
      const t = cellTarget(k0);
      let id = t ? t.id : k0 === "a" || k0 === "o" ? B.AIR : k0 === "p" || k0 === "?p" ? B.DIRT_PATH : k0 === "d" ? B.DIRT : k0 === "t" ? B.TORCH : k0 === "c" ? B.CHEST : -1;
      if (id < 0) continue;
      if (isDoor(id)) {
        if (door(id).upper) continue;
        id = doorId(door(id).facing, !shut, false);
        doors.push([x, y, z]);
      }
      for (const [px, py, pz, pid] of placementCells(id, x, y, z)) set(px, py, pz, pid);
    }
    const inside = cells.filter(([x, y, z, k]) => y === site.y && k.split("|")[0] === "a" && !SOLID[at(x, y, z)] && !SOLID[at(x, y + 1, z)] && SOLID[at(x, y - 1, z)]).map(([x, y, z]) => [x, y, z]);
    const step = doorStep({ ...site, by: [], done: true, at: 0 });
    const [ox, oz] = [[0, -1], [1, 0], [0, 1], [-1, 0]][face];
    sites.push({ ...site, doors, inside, goal: step ? [step[0] + ox * 5 + 0.5, site.y, step[1] + oz * 5 + 0.5] : null });
  }
  mkdirSync(join(dir, "shard-1"), { recursive: true });
  const buf = Buffer.alloc(8 + edits.size * 5);
  buf.writeUInt32LE(0x31585047, 0); // "GPX1": the world's edits, as server/src/store.ts keeps them
  buf.writeUInt32LE(edits.size, 4);
  let o = 8;
  for (const i of [...edits.keys()].sort((a, b) => a - b)) {
    buf.writeUInt32LE(i, o);
    buf[o + 4] = edits.get(i)!;
    o += 5;
  }
  writeFileSync(join(dir, "shard-1", "edits.bin"), buf);
  // the villages and the hub as the seed has them (the server decides them once, from a world with no edits there)
  writeFileSync(join(dir, "shard-1", "villages.json"), JSON.stringify({ sites: villages, decided: new Date().toISOString(), edits: 0, skipped: [] }));
  writeFileSync(join(dir, "shard-1", "hub.json"), JSON.stringify({ keep: [], roads: villages, villages, decided: new Date().toISOString(), edits: 0, nearHub: 0 }));
  writeFileSync(join(dir, "sites.json"), JSON.stringify(sites));
  console.log(`${kinds.length} buildings (doors ${shut ? "shut" : "open"}), ${edits.size} edits, in ${dir}`);
  process.exit(0);
}

// ---------------------------------------------------------------- on a test server

process.env.AGENT_STATE_DIR ||= mkdtempSync(join(tmpdir(), "nav-"));
const { Body } = await import("./body.ts");
const { Brain } = await import("./brain.ts");
const url = process.argv[2] || "ws://127.0.0.1:8790";
const which = (process.argv[3] || "think,village,hill,shut,logging,stairs,hole,nighthole,pocket,house,outoftown").split(",");
const b = new Body(process.env.NAME || "haiku");
await b.connect(url, process.env.AGENT_SECRET ?? "");
await b.wait(10);
const say = (text: string) => b.send({ t: "chat", text });
const ground = (x: number, z: number) => {
  for (let y = 120; y > 1; y--) if (SOLID[b.get(x, y, z)] && !TREE.has(b.get(x, y, z))) return y;
  return -1;
};
const to = async (x: number, z: number, y = ground(Math.floor(x), Math.floor(z)) + 1) => {
  say("/gamemode creative"); // no fall damage on the way down
  await b.wait(3);
  say(`/tp ${x} ${y} ${z}`);
  await b.wait(25);
  say("/gamemode survival");
  say("/hunger 20");
  await b.wait(10);
};
const give = async (...items: string[]) => {
  for (const it of items) say(`/give ${it}`);
  await b.wait(10);
};
const brain = new Brain(b.name, b, "test", "http://127.0.0.1:9", "http://127.0.0.1:9") as unknown as { thinking: boolean; whileThinking(): Promise<void>; load(): void; exec(n: string, i: Record<string, unknown>): Promise<string> };
const run = async (label: string, fn: () => Promise<unknown>) => {
  const tr: Pose[] = [];
  let on = true;
  void (async () => {
    while (on) {
      await b.nextTick();
      tr.push({ t: Date.now(), x: b.phys.x, y: b.phys.y, z: b.phys.z, yaw: b.yaw });
    }
  })();
  b.abort = false;
  const r = await fn();
  on = false;
  await b.wait(2);
  console.log(`${label.padEnd(12)} ${String(r).slice(0, 90)}\n${" ".repeat(13)}${measure(tr)}`);
};
say("/time 1000");
say("/mobs clear");

if (which[0] === "exits") {
  const dir = process.argv[4];
  const start = process.argv[5] || "far";
  const sites = JSON.parse(readFileSync(join(dir, "sites.json"), "utf8")).filter((s: { goal: unknown }) => s.goal);
  let out = 0;
  for (const s of sites) {
    const dc = s.doors[0] ?? s.inside[0];
    const byFar = [...s.inside].sort((p: number[], q: number[]) => Math.hypot(q[0] - dc[0], q[2] - dc[2]) - Math.hypot(p[0] - dc[0], p[2] - dc[2]));
    const st = start === "near" ? byFar[byFar.length - 1] : start === "mid" ? byFar[Math.floor(byFar.length / 2)] : byFar[0];
    await to(st[0] + 0.5, st[2] + 0.5, st[1]);
    let ok = false;
    await run(s.kind, async () => (ok = await b.goto(s.goal[0], s.goal[1], s.goal[2], 1.5, { maxMs: 45000 })) ? "out" : "STILL INSIDE");
    if (ok) out++;
  }
  console.log(`out of ${out} of ${sites.length} buildings (start ${start})`);
  b.close();
  process.exit(0);
}

for (const name of which) {
  if (name === "think") {
    // twenty seconds of thinking, nobody near
    await to(244.5, 382.5);
    brain.thinking = true;
    await run(name, async () => {
      const p = brain.whileThinking();
      await new Promise((r) => setTimeout(r, 20000));
      brain.thinking = false;
      await p;
      return "thought for 20 s";
    });
  } else if (name === "village") {
    // through Mossford, where haiku walked back and forth on the road (live, season 13)
    await to(144.5, 295.5);
    await run(name, () => b.goto(179.5, 50, 308.5, 1.5, { maxMs: 60000 }));
  } else if (name === "hill") {
    // up the hill east of 145,338, where sonnet "stopped at x=145 z=338, couldn't get further" (live, season 13)
    for (const [gx, gz] of [[160, 340], [175, 352]]) {
      await to(145.5, 338.5);
      await run(`hill ${gx},${gz}`, async () => ((await b.goto(gx + 0.5, ground(gx, gz) + 1, gz + 0.5, 2, { maxMs: 90000 })) ? "got there" : `stopped at x=${Math.round(b.phys.x)} z=${Math.round(b.phys.z)}`));
    }
  } else if (name === "shut") {
    // a spot inside a shut stone box (a house with its doorway blocked): how soon it sees it can't get in
    await to(370.5, 124.5);
    await give("cobblestone 32");
    const [cx, cy, cz] = [Math.floor(b.phys.x) + 4, Math.floor(b.phys.y + 0.1), Math.floor(b.phys.z)];
    for (let y = cy; y < cy + 3; y++) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if ((dx || dz || y === cy + 2) && !SOLID[b.get(cx + dx, y, cz + dz)]) await b.place(B.COBBLESTONE, cx + dx, y, cz + dz, 8000);
    await to(cx - 11.5, cz + 4.5);
    await run(name, async () => ((await b.goto(cx + 0.5, cy, cz + 0.5, 0.6, { maxMs: 60000 })) ? "got in?!" : "gave up: no way in"));
  } else if (name === "logging") {
    await to(178.5, 196.5);
    await give("stone_axe 1");
    await run(name, () => brain.exec("collect", { item: "oak_log", count: 8 }));
  } else if (name === "stairs") {
    // a staircase dug from flat open ground by day, and back up it
    await to(412.5, 394.5);
    await give("stone_pickaxe 1", "dirt 32", "torch 8");
    await run(name, () => b.stairMine([B.COBBLESTONE], 6));
  } else if (name === "hole" || name === "nighthole") {
    // a night hole (three down, roofed), then somewhere 15 blocks off: in the morning it climbs out and goes; at night
    // it stays shut in
    await to(name === "hole" ? 250.5 : 256.5, 388.5);
    await give("stone_pickaxe 1", "dirt 16");
    await b.digIn();
    if (name === "nighthole") {
      say("/time 15000");
      await b.wait(10);
    }
    const [gx, gz] = [Math.floor(b.phys.x) + 15, Math.floor(b.phys.z) + 4];
    await run(name, async () => `${(await b.goto(gx + 0.5, ground(gx, gz) + 1, gz + 0.5, 1.5, { maxMs: 45000 })) ? "got there" : "didn't go"}, ${b.sealed() ? "sealed in" : "not sealed in"}`);
    say("/time 1000");
  } else if (name === "pocket") {
    // walled itself in where it stood on the open ground (wallOff, sealIn), then off 12 blocks away
    await to(364.5, 118.5);
    await give("dirt 16");
    await b.center(Math.floor(b.phys.x), Math.floor(b.phys.z), 20);
    for (let k = 0; k < 3 && b.openGaps() > 1; k++) await b.sealIn();
    let gx = Math.floor(b.phys.x) + 12;
    const gz = Math.floor(b.phys.z) + 3;
    while (SOLID[b.get(gx, ground(gx, gz) + 1, gz)]) gx++;
    await run(name, () => b.goto(gx + 0.5, ground(gx, gz) + 1, gz + 0.5, 1.5, { maxMs: 45000 }));
  } else if (name === "house") {
    // build_house: the two by two shelter, built from inside round itself
    await to(406.5, 400.5);
    await give("cobblestone 64");
    await run(name, () => b.buildHouse());
  } else if (name === "outoftown") {
    // stone from inside the town's ground: out of the town first (sonnet paced this, live)
    await to(176.5, 303.5);
    await give("stone_pickaxe 1", "dirt 16");
    writeFileSync(join(process.env.AGENT_STATE_DIR!, "pack.json"), JSON.stringify({ plan: "", by: "", base: { x: 173, y: 50, z: 300 }, houses: {}, builds: [], trades: 0, stage: -1 }));
    brain.load();
    await run(name, () => brain.exec("collect", { item: "cobblestone", count: 6 }));
  }
}
b.close();
process.exit(0);
