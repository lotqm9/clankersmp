// Villages and trading on a real server (protocol v9) with protocol bots (DEV_COMMANDS=1: /tp, /give, /time): a fresh
// world gets the first four villages and says so in the welcome; a world with edits in a village's square never
// gets that village; villagers reach a player who comes near; a right click opens the native trade window with the
// villager's offers (not from too far); a trade pays and delivers exactly, a shift-trade does as many as it can, the
// stock is shared (another player watching sees it fall) and kept over a restart; refused trades change nothing
// (short of the cost, a stale window, no window); walking away closes the window; poking a villager does no harm;
// no block goes into a villager; the farmer's and the smith's loot chests are filled.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { B } from "../shared/blocks.ts";
import { DEFAULT_SEED, WORLDGEN_VERSION, idx } from "../shared/constants.ts";
import { I } from "../shared/items.ts";
import { VF } from "../shared/villagers.ts";
import { VILLAGE_SITES, chooseVillages, villageBox } from "../shared/villages.ts";
import { generateWorld, hashBlocks } from "../shared/worldgen.ts";
import { ShardStore } from "../server/src/store.ts";
import { Bot, sleep, waitFor } from "./bot.ts";

const PORT = 30400 + Math.floor(Math.random() * 1500);
const URL = `ws://127.0.0.1:${PORT}`;
const ADMIN = "test-admin-secret-0123456789";
const dir = mkdtempSync(pjoin(tmpdir(), "steve-craft-villages-"));
const gen = generateWorld(DEFAULT_SEED);
const village = gen.info.villages.list[0];
let server: ChildProcess;
const bots: Bot[] = [];
const extra: ChildProcess[] = [];
let serverOut = "";

function startServer(worldDir = dir, port = PORT): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [process.env.SERVER_ENTRY || "server/src/main.ts"], {
      env: { ...process.env, MOBS: "0", PORT: String(port), WORLD_DIR: worldDir, ADMIN_SECRET: ADMIN, DEV_COMMANDS: "1", GAMEMODE: "", COIN_CA: "", ANIMALS: "0" },
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

async function stopServer(p = server): Promise<void> {
  await new Promise<void>((resolve) => {
    if (p.exitCode !== null) return resolve();
    p.once("exit", () => resolve());
    p.kill("SIGTERM");
    setTimeout(resolve, 4000);
  });
}

before(async () => {
  server = await startServer();
});
after(async () => {
  if (process.env.SHOW_SERVER) console.log(serverOut.split(/\r?\n/).slice(-60).join("\n"));
  for (const b of bots) b.close();
  await stopServer();
  for (const p of extra) if (p.exitCode === null) await stopServer(p);
  rmSync(dir, { recursive: true, force: true });
});

async function join(name: string): Promise<Bot> {
  const b = new Bot();
  await b.connect(URL, { name });
  bots.push(b);
  return b;
}

async function tpTo(b: Bot, x: number, y: number, z: number): Promise<void> {
  const n = b.tps.length;
  b.chat(`/tp ${x} ${y} ${z}`);
  await waitFor(() => b.tps.length > n, 6000, "tp");
  b.move(x, y, z);
  await sleep(150);
}

const count = (b: Bot, id: number) => b.inv.reduce((n, s) => n + (s && s.id === id ? s.n : 0), 0);

/** Stand next to a villager (1.6 blocks east of it), facing it. */
async function nextTo(b: Bot, id: number): Promise<void> {
  if (!b.villagers.has(id)) await tpTo(b, village.x + 0.5, village.y + 1, village.z + 6.5);
  await waitFor(() => b.villagers.has(id), 6000, `villager ${id} seen`);
  const v = b.villagers.get(id)!;
  await tpTo(b, v.x + 1.6, v.y + 0.05, v.z);
}

let A: Bot;
let C: Bot;
const farmer = village.villagers.find((d) => d.job === 0)!;

test("a fresh world gets the first four villages, and the welcome names them (the client builds the same)", async () => {
  A = await join("Trader");
  assert.deepEqual(A.welcome!.villages, [0, 1, 2, 3]);
  assert.equal(A.welcome!.genHash, (await import("../shared/worldgen.ts")).hashBlocks(gen.blocks), "the same terrain on both sides");
  assert.match(serverOut, /4 villages \(Larkholm, Thistle End, Mossford, Pennywhistle\)/);
  const f = pjoin(dir, "shard-1", "villages.json");
  assert.ok(existsSync(f));
  assert.deepEqual(JSON.parse(readFileSync(f, "utf8")).sites, [0, 1, 2, 3]);
});

test("near a village its villagers reach you: five, one of each job", async () => {
  A.chat("/time 4000");
  await tpTo(A, village.x + 0.5, village.y + 1, village.z + 6.5);
  await waitFor(() => village.villagers.every((d) => A.villagers.has(d.id)), 8000, "all five villagers");
  assert.deepEqual(village.villagers.map((d) => A.villagers.get(d.id)!.kind).sort(), [0, 1, 2, 3, 4]);
  for (const d of village.villagers) {
    const s = A.villagers.get(d.id)!;
    assert.ok(Math.abs(s.x - village.x) <= 26 && Math.abs(s.z - village.z) <= 26, "in their village");
  }
});

test("right click: the trade window with the villager's offers; not from across the street", async () => {
  await tpTo(A, village.x + 0.5, village.y + 1, village.z + 20.5);
  A.send({ t: "talk", id: farmer.id });
  await sleep(600);
  assert.ok(!A.win || A.win.kind !== "trade", "too far: no window");
  await nextTo(A, farmer.id);
  A.send({ t: "talk", id: farmer.id });
  await waitFor(() => A.win?.kind === "trade", 4000, "trade window");
  assert.equal(A.tradeVid, farmer.id);
  assert.equal(A.offers!.length, 5);
  assert.deepEqual(A.offers![0], { a: [I.WHEAT, 20], r: [I.RUBY, 1], n: 16, m: 16 });
  await waitFor(() => !!((A.villagers.get(farmer.id)?.flags ?? 0) & VF.TALK), 4000, "the farmer stops to talk");
});

test("a trade pays and delivers exactly; shift-trade does as many as it can; the stock is shared and falls", async () => {
  A.chat("/give wheat 50");
  await waitFor(() => count(A, I.WHEAT) === 50, 4000, "50 wheat");
  C = await join("Watcher");
  await nextTo(C, farmer.id);
  C.send({ t: "talk", id: farmer.id });
  await waitFor(() => C.win?.kind === "trade", 4000, "C's trade window");
  const w = A.win!.w;
  A.send({ t: "trade", w, o: 0 });
  await waitFor(() => count(A, I.RUBY) === 1, 4000, "a ruby");
  assert.equal(count(A, I.WHEAT), 30);
  await waitFor(() => A.offers![0].n === 15 && C.offers?.[0].n === 15, 4000, "both see 15 left");
  // shift: as many as it can (30 wheat: one more lot of 20)
  A.send({ t: "trade", w, o: 0, all: true });
  await waitFor(() => count(A, I.RUBY) === 2, 4000, "a second ruby");
  assert.equal(count(A, I.WHEAT), 10);
  await waitFor(() => C.offers?.[0].n === 14, 4000, "14 left");
  // buy bread with the rubies: 2 rubies, all -> 12 bread
  A.send({ t: "trade", w, o: 2, all: true });
  await waitFor(() => count(A, I.BREAD) === 12, 4000, "12 bread");
  assert.equal(count(A, I.RUBY), 0);
  assert.ok(A.fx.some((f) => f.k === "trade"), "the trade sound");
});

test("refused trades change nothing: short of the cost, a stale window, no window at all", async () => {
  const w = A.win!.w;
  const inv0 = JSON.stringify(A.inv);
  const fx0 = A.fx.length;
  A.send({ t: "trade", w, o: 0 }); // 10 wheat, needs 20
  await waitFor(() => A.fx.slice(fx0).some((f) => f.k === "trade_no"), 4000, "the no sound");
  assert.equal(JSON.stringify(A.inv), inv0);
  assert.equal(A.offers![0].n, 14);
  const closes = A.closes.length;
  A.send({ t: "trade", w: w + 7, o: 0 });
  await waitFor(() => A.closes.length > closes, 4000, "a stale window is closed");
  assert.equal(JSON.stringify(A.inv), inv0);
  A.send({ t: "trade", w, o: 99 });
  A.send({ t: "trade", w, o: -1 });
  await sleep(300);
  assert.equal(JSON.stringify(A.inv), inv0);
});

test("walking away closes the trade window; the villager goes back to its day", async () => {
  const w = C.win!.w;
  const closes = C.closes.length;
  await tpTo(C, village.x + 0.5, village.y + 1, village.z + 20.5);
  await waitFor(() => C.closes.length > closes && C.closes.includes(w), 4000, "C's window closed");
  A.closeWindow(A.win!.w);
  await waitFor(() => !((A.villagers.get(farmer.id)?.flags ?? 0) & VF.TALK), 4000, "the farmer is free again");
});

test("a poke does no harm; no block can be placed in a villager", async () => {
  await nextTo(A, farmer.id);
  A.send({ t: "hit", id: farmer.id, villager: true });
  await waitFor(() => !!((A.villagers.get(farmer.id)?.flags ?? 0) & VF.HURT), 4000, "it flinches");
  await sleep(700);
  assert.ok(A.villagers.has(farmer.id), "and is still there");
  // a block in its feet
  A.chat("/give cobblestone 1");
  await waitFor(() => count(A, B.COBBLESTONE) === 1, 4000, "cobblestone");
  const s = A.inv.findIndex((st) => st?.id === B.COBBLESTONE);
  if (s >= 0 && s <= 8) A.select(s);
  const v = A.villagers.get(farmer.id)!;
  A.send({ t: "place", x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z), id: B.COBBLESTONE });
  await sleep(500);
  assert.notEqual(A.edits.get(idx(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z))), B.COBBLESTONE, "refused");
});

test("the farmer's and the smith's chests are loot chests, filled once", async () => {
  for (const c of village.chests) {
    await tpTo(A, c.x + 0.5, c.y, c.z + 1.5);
    A.send({ t: "use", x: c.x, y: c.y, z: c.z });
    await waitFor(() => A.win?.kind === "chest", 4000, `the ${c.kind}'s chest opens`);
    const items = A.win!.items.slice(0, 27).filter(Boolean);
    assert.ok(items.length >= 3, `${items.length} stacks in the ${c.kind}'s chest`);
    A.closeWindow(A.win!.w);
    await sleep(200);
  }
});

test("the stock and the village choice are kept over a restart", async () => {
  for (const b of bots) b.close();
  bots.length = 0;
  await fetch(`http://127.0.0.1:${PORT}/admin/save`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}` } });
  await stopServer();
  server = await startServer();
  const D = await join("Again");
  assert.deepEqual(D.welcome!.villages, [0, 1, 2, 3]);
  D.chat("/time 4000");
  await nextTo(D, farmer.id);
  D.send({ t: "talk", id: farmer.id });
  await waitFor(() => D.win?.kind === "trade", 4000, "trade window");
  assert.equal(D.offers![0].n, 14, "14 left, as before the restart");
  assert.equal(D.offers![2].n, 10, "bread: 10 left");
});

test("a world with an edit in a village's square never gets that village", async () => {
  const d2 = mkdtempSync(pjoin(tmpdir(), "steve-craft-villages-edited-"));
  const st = new ShardStore(d2, 1);
  st.checkSeed(DEFAULT_SEED, WORLDGEN_VERSION);
  const q = villageBox(1); // Thistle End
  const x = q.x0 + 3;
  const z = q.z1 - 3;
  let y = 120;
  while (y > 1 && gen.blocks[idx(x, y, z)] === 0) y--;
  st.saveEdits(new Map([[idx(x, y + 1, z), B.COBBLESTONE]]));
  const port2 = PORT + 1;
  const s2 = await startServer(d2, port2);
  try {
    const E = new Bot();
    await E.connect(`ws://127.0.0.1:${port2}`, { name: "Edited" });
    assert.deepEqual(E.welcome!.villages, [0, 2, 3, 4], `${VILLAGE_SITES[1].name} skipped, ${VILLAGE_SITES[4].name} instead`);
    assert.equal(E.edits.get(idx(x, y + 1, z)), B.COBBLESTONE, "the player's block is still there");
    E.close();
  } finally {
    await stopServer(s2);
    rmSync(d2, { recursive: true, force: true });
  }
});

// ---- update 11.1: more villages for a world whose players built on the first sites

/** A world dir like a live one: players' 20 x 20 stone bases in the middle of these first sites (`builds`), and
 *  optionally the villages.json update 11 wrote. */
function liveLikeWorld(builds: number[], decided?: number[]): { dir: string; edits: Map<number, number> } {
  const d = mkdtempSync(pjoin(tmpdir(), "steve-craft-villages-live-"));
  const st = new ShardStore(d, 1);
  st.checkSeed(DEFAULT_SEED, WORLDGEN_VERSION);
  const base = generateWorld(DEFAULT_SEED, undefined, { villages: [] }).blocks;
  const edits = new Map<number, number>();
  for (const b of builds) {
    const s = VILLAGE_SITES[b];
    for (let dz = -10; dz < 10; dz++)
      for (let dx = -10; dx < 10; dx++) {
        const x = s.x + dx;
        const z = s.z + dz;
        let y = 120;
        while (y > 1 && base[idx(x, y, z)] === 0) y--;
        if ((dx + dz) % 3 === 0) edits.set(idx(x, y + 1, z), B.COBBLESTONE);
      }
  }
  st.saveEdits(edits);
  if (decided) writeFileSync(pjoin(st.dir, "villages.json"), JSON.stringify({ sites: decided, decided: "2026-10-16T12:00:00.000Z", edits: edits.size, skipped: builds }));
  return { dir: d, edits };
}

async function bootAndJoin(d: string, port: number): Promise<{ p: ChildProcess; bot: Bot; out: string }> {
  const start = serverOut.length;
  const p = await startServer(d, port);
  extra.push(p); // (stopped at the end even if a test fails half-way)
  const bot = new Bot();
  bots.push(bot);
  await bot.connect(`ws://127.0.0.1:${port}`, { name: "LiveLike" });
  return { p, bot, out: serverOut.slice(start) };
}

test("update 11.1: a world like the live one (Pennywhistle only, builds on the other four first sites) gets three more villages at its next start; its builds and Pennywhistle untouched", async () => {
  const { dir: d, edits } = liveLikeWorld([0, 1, 2, 4], [3]);
  const want = chooseVillages((k) => {
    const q = villageBox(k);
    for (const i of edits.keys()) {
      const x = i & 511;
      const z = (i >> 9) & 511;
      if (x >= q.x0 && x <= q.x1 && z >= q.z0 && z <= q.z1) return true;
    }
    return false;
  }, [3]);
  const port = PORT + 2;
  try {
    const { p, bot, out } = await bootAndJoin(d, port);
    const sites = bot.welcome!.villages!;
    assert.equal(sites.length, 4, `four villages: ${sites.map((k) => VILLAGE_SITES[k].name).join(", ")}`);
    assert.deepEqual(sites, want);
    assert.equal(sites[0], 3, "Pennywhistle kept");
    assert.equal(bot.welcome!.genHash, hashBlocks(generateWorld(DEFAULT_SEED, undefined, { villages: sites, hub: bot.welcome!.hub }).blocks), "the terrain every client builds");
    for (const [i, id] of edits) assert.equal(bot.edits.get(i), id, "every build still there");
    assert.match(out, /villages added: /);
    const rec = JSON.parse(readFileSync(pjoin(d, "shard-1", "villages.json"), "utf8"));
    assert.deepEqual(rec.sites, sites);
    assert.equal(rec.added.length, 1);
    assert.equal(rec.decided, "2026-10-16T12:00:00.000Z", "the first decision's date kept");
    // the new villagers are there to trade with (one village's, near its plaza)
    const v = generateWorld(DEFAULT_SEED, undefined, { villages: sites, hub: bot.welcome!.hub }).info.villages.list.find((q) => q.site === sites[1])!;
    bot.chat("/time 4000");
    const n = bot.tps.length;
    bot.chat(`/tp ${v.x + 0.5} ${v.y + 1} ${v.z + 6.5}`);
    await waitFor(() => bot.tps.length > n, 6000, "tp");
    bot.move(v.x + 0.5, v.y + 1, v.z + 6.5);
    await waitFor(() => v.villagers.every((q) => bot.villagers.has(q.id)), 8000, `${v.name}'s villagers`);
    bot.close();
    await stopServer(p);
    // the next start: the same four, nothing added
    const again = await bootAndJoin(d, port);
    assert.deepEqual(again.bot.welcome!.villages, sites);
    assert.doesNotMatch(again.out, /villages added/);
    again.bot.close();
    await stopServer(again.p);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("update 11.1: builds on three of the first sites (deciding for the first time): four villages too", async () => {
  const { dir: d, edits } = liveLikeWorld([0, 1, 2]);
  const port = PORT + 3;
  try {
    const { p, bot } = await bootAndJoin(d, port);
    const sites = bot.welcome!.villages!;
    assert.equal(sites.length, 4, `four: ${sites.map((k) => VILLAGE_SITES[k].name).join(", ")}`);
    assert.deepEqual(sites.slice(0, 2), [3, 4], "Pennywhistle and Honeybrook (nobody built there), then two more");
    for (const [i, id] of edits) assert.equal(bot.edits.get(i), id);
    bot.close();
    await stopServer(p);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
