// Update 12 on a world like the live one (villages Pennywhistle, Sorrelby and Bellwether; players' builds just
// outside the old hub's edge and far out): the first v10 start decides the bigger hub round every build (hub.json),
// every build stays exactly where it was on the ground it stood on, the welcome carries the plan so clients build the
// same world, the builds' tiles stay out of the safe zone (their builders keep building) while the rest of the new
// zone is safe, boats wait at the harbour (an empty slot is filled again), and the next start keeps it all as it is.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { B, SOLID } from "../shared/blocks.ts";
import { DEFAULT_SEED, PROTOCOL_VERSION, SEA_LEVEL, SPAWN_X, SPAWN_Z, WORLDGEN_VERSION, WORLD_HEIGHT, idx } from "../shared/constants.ts";
import { SafeZone, TILE, TILES, keepTiles, tileOf } from "../shared/hub12.ts";
import { I } from "../shared/items.ts";
import { generateWorld, hashBlocks } from "../shared/worldgen.ts";
import { VILLAGE_SITES } from "../shared/villages.ts";
import { ShardStore } from "../server/src/store.ts";
import { Bot, sleep, waitFor } from "./bot.ts";

const PORT = 32000 + Math.floor(Math.random() * 1500);
const ADMIN = "test-admin-secret-0123456789";
const CX = SPAWN_X;
const CZ = SPAWN_Z;
const LIVE = [3, 19, 27];
let serverOut = "";
const procs: ChildProcess[] = [];
const bots: Bot[] = [];

function startServer(worldDir: string, port: number): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [process.env.SERVER_ENTRY || "server/src/main.ts"], {
      env: { ...process.env, MOBS: "0", PORT: String(port), WORLD_DIR: worldDir, ADMIN_SECRET: ADMIN, DEV_COMMANDS: "1", GAMEMODE: "", COIN_CA: "", ANIMALS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.push(p);
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

async function stopServer(p: ChildProcess): Promise<void> {
  await new Promise<void>((resolve) => {
    if (p.exitCode !== null) return resolve();
    p.once("exit", () => resolve());
    p.kill("SIGTERM");
    setTimeout(resolve, 4000);
  });
}

after(async () => {
  if (process.env.SHOW_SERVER) console.log(serverOut.split(/\r?\n/).slice(-60).join("\n"));
  for (const b of bots) b.close();
  for (const p of procs) await stopServer(p);
  rmSync(dir, { recursive: true, force: true });
});

// ---- the world: the live villages, and players' walls (two high, cobblestone) on the old terrain
const old = generateWorld(DEFAULT_SEED, undefined, { villages: LIVE, hub: false }).blocks;
const oldTop = (x: number, z: number) => {
  for (let y = WORLD_HEIGHT - 1; y > 0; y--) if (SOLID[old[idx(x, y, z)]]) return y;
  return 0;
};
const edits = new Map<number, number>();
function wall(x0: number, z0: number, w: number, d: number): void {
  for (let z = z0; z < z0 + d; z++)
    for (let x = x0; x < x0 + w; x++) {
      if (x !== x0 && x !== x0 + w - 1 && z !== z0 && z !== z0 + d - 1) continue;
      const y = oldTop(x, z);
      edits.set(idx(x, y + 1, z), B.COBBLESTONE);
      edits.set(idx(x, y + 2, z), B.COBBLESTONE);
    }
}
wall(CX + 44, CZ - 38, 5, 5); // north-east, just past the old edge (r 55-63)
wall(CX - 58, CZ + 6, 4, 4); // west, on the new ring road's line (r 55-58)
wall(CX + 16, CZ + 50, 5, 4); // south, by the fountain's corner (r 52-57)
wall(CX + 140, CZ + 96, 6, 6); // far out in the wild
// and, as on the live world, something built on every other village site (so no fourth village is added)
for (const [k, site] of VILLAGE_SITES.entries()) if (!LIVE.includes(k)) edits.set(idx(site.x, oldTop(site.x, site.z) + 1, site.z), B.OAK_PLANKS);
const A = { x: CX + 46, z: CZ - 36 }; // inside the first build

const dir = mkdtempSync(pjoin(tmpdir(), "steve-craft-hub-"));
{
  const st = new ShardStore(dir, 1);
  st.checkSeed(DEFAULT_SEED, WORLDGEN_VERSION);
  st.saveEdits(edits);
  writeFileSync(pjoin(st.dir, "villages.json"), JSON.stringify({ sites: LIVE, decided: "2026-10-16T12:00:00.000Z", edits: edits.size, skipped: [0, 1, 2] }));
}
const keep = keepTiles(edits.keys());

function tileSame(a: Uint8Array, b: Uint8Array, t: number): boolean {
  const x0 = (t % TILES) * TILE;
  const z0 = Math.floor(t / TILES) * TILE;
  for (let z = z0; z < z0 + TILE; z++) for (let x = x0; x < x0 + TILE; x++) for (let y = 0; y < WORLD_HEIGHT; y++) if (a[idx(x, y, z)] !== b[idx(x, y, z)]) return false;
  return true;
}

async function tpTo(b: Bot, x: number, y: number, z: number): Promise<void> {
  const n = b.tps.length;
  b.chat(`/tp ${x} ${y} ${z}`);
  await waitFor(() => b.tps.length > n, 6000, "tp");
  b.move(x, y, z);
  await sleep(150);
}

let server: ChildProcess;
let bot: Bot;
let gen12: ReturnType<typeof generateWorld>;

test("the first v10 start on a live-like world builds the bigger hub round every build, and the welcome carries the plan", async () => {
  server = await startServer(dir, PORT);
  bot = new Bot();
  await bot.connect(`ws://127.0.0.1:${PORT}`, { name: "Builder" });
  bots.push(bot);
  const w = bot.welcome!;
  assert.equal(w.v, PROTOCOL_VERSION);
  assert.ok(PROTOCOL_VERSION >= 10);
  assert.deepEqual(w.villages, LIVE, "the live villages, as they are");
  assert.deepEqual(w.hub!.keep, keep, "every build's tile kept");
  assert.deepEqual(w.hub!.roads, LIVE, "roads to the three villages");
  assert.equal(w.spawnRadius, 68);
  gen12 = generateWorld(DEFAULT_SEED, undefined, { villages: w.villages, hub: w.hub });
  assert.equal(w.genHash, hashBlocks(gen12.blocks), "the terrain every client builds from the welcome");
  for (const [i, id] of edits) assert.equal(bot.edits.get(i), id, "every build still there");
  for (const t of keep) assert.ok(tileSame(old, gen12.blocks, t), `the ground under the builds (tile ${t}) as it was`);
  assert.deepEqual(w.spawn, gen12.info.spawn);
  assert.equal(w.you.z, CZ + 44.5, "a new player arrives in the courtyard");
  assert.match(serverOut, /bigger hub decided: \d+ tiles kept for players' edits \(\d+ in or by the hub\), roads to Pennywhistle, Sorrelby, Bellwether and the harbour/);
  const rec = JSON.parse(readFileSync(pjoin(dir, "shard-1", "hub.json"), "utf8"));
  assert.deepEqual(rec.keep, keep);
  assert.deepEqual(rec.villages, LIVE);
  assert.equal(rec.edits, edits.size);
  // the hub still got its roads, the Beacon, the halls (the builds sit where nothing big stands)
  const h = gen12.info.hub;
  for (const r of h.roads!) assert.ok(r.reached, `the road to ${r.to}`);
  assert.ok(h.beacon && h.harbour);
  for (const k of ["charity", "updates", "welcome", "rules", "tips", "directions"]) assert.ok(h.panels.some((p) => p.kind === k), k);
});

test("the builds' tiles stay out of the safe zone (their builders build on); elsewhere at the same distance it is safe", async () => {
  bot.chat("/give cobblestone 8");
  await waitFor(() => bot.inv.some((s) => s?.id === B.COBBLESTONE), 5000, "cobblestone");
  let slot = bot.inv.findIndex((s) => s?.id === B.COBBLESTONE);
  if (slot > 8) {
    const n = bot.click(0, { m: "swap", s: slot, h: 8 });
    await waitFor(() => bot.winLog.some((l) => l.n === n), 5000, "swap answered");
    bot.send({ t: "close", w: 0 });
    await waitFor(() => bot.inv[8]?.id === B.COBBLESTONE, 5000, "on the hotbar");
    slot = 8;
  }
  bot.select(slot);
  const zone = new SafeZone(keep);
  // inside the north-east build: place on its floor
  const y = oldTop(A.x, A.z);
  assert.ok(!zone.contains(A.x + 0.5, A.z + 0.5) && keep.includes(tileOf(A.x, A.z)) && Math.hypot(A.x - CX, A.z - CZ) < 64);
  await tpTo(bot, A.x + 0.5, y + 1, A.z + 1.5);
  bot.place(A.x, y + 1, A.z, B.COBBLESTONE);
  await waitFor(() => bot.block(gen12.blocks, A.x, y + 1, A.z) === B.COBBLESTONE, 5000, "built on in the kept tile");
  // a spot of the new zone, as far out, nothing kept: refused
  const S = { x: CX - 30, z: CZ - 52 };
  assert.ok(zone.contains(S.x + 0.5, S.z + 0.5) && Math.hypot(S.x - CX, S.z - CZ) > 58);
  const sy = gen12.info.spawnHeight;
  await tpTo(bot, S.x + 0.5, sy + 1, S.z + 1.5);
  const notes = bot.notices.length;
  bot.place(S.x, sy + 1, S.z, B.COBBLESTONE);
  await waitFor(() => bot.notices.slice(notes).some((n) => /safe zone/i.test(n)), 5000, "told it's the safe zone");
  await sleep(300);
  assert.equal(bot.block(gen12.blocks, S.x, sy + 1, S.z), gen12.blocks[idx(S.x, sy + 1, S.z)], "nothing placed");
});

test("boats wait at the harbour; one taken is put back at the next start, which keeps the hub as decided", async () => {
  const h = gen12.info.hub.harbour!;
  await tpTo(bot, h.x + 0.5, h.y + 1, h.z - 4.5);
  const atSlot = () => h.slots.filter((s) => [...bot.boats.values()].some((b) => Math.hypot(b.x - s.x, b.z - s.z) < 1.5)).length;
  await waitFor(() => atSlot() === h.slots.length, 6000, "a boat at every slot");
  // take one away (break it: it's outside the safe zone)
  const s0 = h.slots[0];
  const b0 = [...bot.boats.values()].find((b) => Math.hypot(b.x - s0.x, b.z - s0.z) < 1.5)!;
  await tpTo(bot, s0.x + 2.5, SEA_LEVEL - 1, s0.z); // swimming beside it
  for (let k = 0; k < 10 && bot.boats.has(b0.id); k++) {
    bot.send({ t: "hit", id: b0.id, boat: true });
    await sleep(150);
  }
  await waitFor(() => !bot.boats.has(b0.id), 5000, "the boat breaks");
  assert.equal(atSlot(), h.slots.length - 1);
  bot.close();
  await stopServer(server);
  // the next start: the same plan from hub.json (no new decision), the same terrain, the slot filled again
  const before = serverOut.length;
  server = await startServer(dir, PORT + 1);
  const b2 = new Bot();
  await b2.connect(`ws://127.0.0.1:${PORT + 1}`, { name: "Builder" });
  bots.push(b2);
  assert.doesNotMatch(serverOut.slice(before), /bigger hub decided|villages added/);
  assert.deepEqual(b2.welcome!.hub, bot.welcome!.hub);
  assert.equal(b2.welcome!.genHash, bot.welcome!.genHash);
  assert.ok(existsSync(pjoin(dir, "shard-1", "hub.json")));
  await tpTo(b2, h.x + 0.5, h.y + 1, h.z - 4.5);
  const atSlot2 = () => h.slots.filter((s) => [...b2.boats.values()].some((b) => Math.hypot(b.x - s.x, b.z - s.z) < 1.5)).length;
  await waitFor(() => atSlot2() === h.slots.length, 6000, "every slot has a boat again");
  assert.ok(I.BOAT > 0);
});
