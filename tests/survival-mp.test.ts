// Survival on a real server with protocol bots (DEV_COMMANDS=1 for /tp, /give, /time, /summon, /kill, /hunger):
// joining with the first-join kit, the safe zone, digging with the right tool (harvest tiers, drops, pickup),
// placing takes the item from your hand, crafting in the 2x2 and at a crafting table, a furnace smelting on its
// own, a chest shared by two players with no way to duplicate, death drops and respawning at the bed or the hub,
// falls, eating, sleeping through the night, killing an animal for food, tool wear, Q to throw, and a cursor
// stack surviving a disconnect.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { B, SOLID } from "../shared/blocks.ts";
import { DEFAULT_SEED, WORLD_HEIGHT, idx } from "../shared/constants.ts";
import { SAFE_RADIUS } from "../shared/hub.ts";
import { I, toolId } from "../shared/items.ts";
import { generateWorld } from "../shared/worldgen.ts";
import { Bot, patchSpots, sleep, waitFor } from "./bot.ts";

const PORT = 23000 + Math.floor(Math.random() * 2000);
const URL = `ws://127.0.0.1:${PORT}`;
const dir = mkdtempSync(pjoin(tmpdir(), "steve-craft-surv-"));
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

/** A w x d patch of level grass outside the safe zone, open above. */
function patch(w: number, d: number, avoid: { x: number; z: number }[] = []): { x: number; z: number; y: number } {
  for (const [x0, z0] of patchSpots(SAFE_RADIUS + 6, 180)) {
    if (avoid.some((v) => Math.abs(v.x - x0) < 16 && Math.abs(v.z - z0) < 16)) continue;
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

/** Walk (at walking speed, so the server accepts it) to (x, z) on level ground at height y. */
async function walkTo(b: Bot, x: number, y: number, z: number): Promise<void> {
  for (let k = 0; k < 200; k++) {
    const dx = x - b.x;
    const dz = z - b.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) break;
    const step = Math.min(0.2, d);
    b.move(b.x + (dx / d) * step, y, b.z + (dz / d) * step);
    await sleep(50);
  }
}

async function give(b: Bot, key: string, n = 1): Promise<void> {
  const id = key;
  b.chat(`/give ${id} ${n}`);
  await sleep(150);
}

async function join(token: string): Promise<Bot> {
  const b = new Bot();
  await b.connect(URL, { token });
  bots.push(b);
  return b;
}

/** Slot index of an item in the bot's inventory (hotbar first), or -1. */
const slotOf = (b: Bot, id: number) => b.inv.findIndex((s) => s?.id === id);

async function holdItem(b: Bot, id: number): Promise<void> {
  await waitFor(() => slotOf(b, id) >= 0, 6000, `item ${id} in inventory`);
  let s = slotOf(b, id);
  if (s > 8) {
    // like a player: hover it in the inventory and press 9 (swap with the last hotbar slot)
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

async function dig(b: Bot, x: number, y: number, z: number, ticks: number): Promise<void> {
  b.dig("start", x, y, z);
  await sleep(ticks * 50 + 120);
  b.dig("finish", x, y, z);
  await waitFor(() => b.block(base, x, y, z) === B.AIR || IS_WATER_OR_AIR(b.block(base, x, y, z)), 6000, `block at ${x},${y},${z} gone`);
}
const IS_WATER_OR_AIR = (id: number) => id === B.AIR;

let P: { x: number; z: number; y: number };

test("joining: survival mode, full health and food, and three apples the first time (only)", async () => {
  P = patch(10, 10);
  const a = await join("surv-a-token-0123456789abcdef");
  assert.equal(a.gm, "survival");
  assert.deepEqual([a.stats.hp, a.stats.food], [20, 20]);
  assert.equal(a.first, true);
  assert.equal(a.count(I.APPLE), 3);
  a.close();
  bots.pop();
  await sleep(300);
  const again = await join("surv-a-token-0123456789abcdef");
  assert.equal(again.first, false);
  assert.equal(again.count(I.APPLE), 3, "the inventory was saved, not given twice");
});

test("the safe zone: no breaking or placing in the hub, but its crafting tables work", async () => {
  const a = bots[bots.length - 1];
  const st = gen.info.hub.stations.find((s) => s.id === B.CRAFTING_TABLE)!;
  await tpTo(a, st.x + 0.5, st.y, st.z + 2.5);
  const notices = a.notices.length;
  a.dig("start", st.x, st.y - 1, st.z + 2);
  await sleep(100);
  a.dig("finish", st.x, st.y - 1, st.z + 2);
  await waitFor(() => a.notices.length > notices, 5000, "safe zone notice");
  assert.match(a.notices[a.notices.length - 1], /safe zone/i);
  assert.notEqual(a.block(base, st.x, st.y - 1, st.z + 2), B.AIR);
  a.use(st.x, st.y, st.z);
  await waitFor(() => a.win?.kind === "crafting", 5000, "hub crafting table opens");
  a.closeWindow(a.win!.w);
});

test("digging: stone needs a pickaxe for cobblestone, iron ore needs stone+, drops are picked up by walking over them", async () => {
  const a = bots[bots.length - 1];
  const x = P.x;
  const z = P.z;
  await tpTo(a, x + 0.5, P.y + 1, z + 2.5);
  // build test blocks from items (placing takes them from the hand)
  await give(a, "stone", 2);
  await give(a, "iron_ore", 1);
  await holdItem(a, B.STONE);
  a.place(x, P.y + 1, z, B.STONE);
  await waitFor(() => a.block(base, x, P.y + 1, z) === B.STONE, 5000, "stone placed");
  assert.equal(a.count(B.STONE), 1, "placing used one stone");
  // stone by hand: 150 ticks, and nothing drops
  await holdItem(a, B.STONE);
  a.select(8); // an empty hand
  a.move(a.x, a.y, a.z);
  await sleep(80);
  await dig(a, x, P.y + 1, z, 150);
  await sleep(400);
  assert.equal([...a.items.values()].filter((it) => it.item === B.COBBLESTONE).length, 0, "stone by hand drops nothing");
  // with a wooden pickaxe: cobblestone, picked up when we stand on it
  await give(a, "wooden_pickaxe", 1);
  await holdItem(a, B.STONE);
  a.place(x, P.y + 1, z, B.STONE);
  await waitFor(() => a.block(base, x, P.y + 1, z) === B.STONE, 5000, "stone placed again");
  await holdItem(a, toolId(0, 0));
  await dig(a, x, P.y + 1, z, 23);
  await waitFor(() => [...a.items.values()].some((it) => it.item === B.COBBLESTONE), 5000, "a cobblestone drop");
  a.move(x + 0.5, P.y + 1, z + 1.4);
  await sleep(150);
  a.move(x + 0.5, P.y + 1, z + 0.5);
  await waitFor(() => a.count(B.COBBLESTONE) === 1, 6000, "picked up the cobblestone");
  assert.ok(a.pickups.length >= 1, "pickup animation sent");
  // iron ore with a wooden pickaxe: nothing
  await holdItem(a, B.IRON_ORE);
  a.place(x + 1, P.y + 1, z, B.IRON_ORE);
  await waitFor(() => a.block(base, x + 1, P.y + 1, z) === B.IRON_ORE, 5000, "iron ore placed");
  await holdItem(a, toolId(0, 0));
  await dig(a, x + 1, P.y + 1, z, 150);
  await sleep(500);
  assert.equal([...a.items.values()].filter((it) => it.item === I.RAW_IRON).length, 0, "iron ore needs a stone pickaxe");
  // digging faster than the tool allows is refused
  await holdItem(a, B.COBBLESTONE);
  a.place(x + 2, P.y + 1, z, B.COBBLESTONE);
  await waitFor(() => a.block(base, x + 2, P.y + 1, z) === B.COBBLESTONE, 5000, "cobble placed");
  a.select(8);
  a.move(a.x, a.y, a.z);
  await sleep(80);
  a.dig("start", x + 2, P.y + 1, z);
  await sleep(500);
  a.dig("finish", x + 2, P.y + 1, z); // by hand cobble takes 200 ticks
  await sleep(400);
  assert.equal(a.block(base, x + 2, P.y + 1, z), B.COBBLESTONE, "too fast: reverted");
  a.dig("finish", x + 2, P.y + 1, z); // finishing a dig that was never started
  await sleep(400);
  assert.equal(a.block(base, x + 2, P.y + 1, z), B.COBBLESTONE, "never started: reverted");
});

test("placing needs the item in hand: an empty hand (or the wrong item) places nothing", async () => {
  const a = bots[bots.length - 1];
  a.select(7);
  a.move(a.x, a.y, a.z);
  await sleep(100);
  a.place(P.x + 4, P.y + 1, P.z, B.GOLD_BLOCK);
  await sleep(400);
  assert.equal(a.block(base, P.x + 4, P.y + 1, P.z), B.AIR);
});

test("crafting: logs to planks in the 2x2 grid; a crafting table's 3x3 makes a stone pickaxe", async () => {
  const a = bots[bots.length - 1];
  await give(a, "oak_log", 3);
  await waitFor(() => a.count(B.OAK_LOG) === 3, 5000, "logs");
  const s = slotOf(a, B.OAK_LOG);
  const ws = s < 9 ? 36 + s : s; // player window slot of that inventory slot
  a.click(0, { m: "pick", s: ws, b: 0 }); // pick up the logs
  a.click(0, { m: "pick", s: 1, b: 1 }); // place one log in the grid
  const n = a.click(0, { m: "shift", s: 0 }); // shift-click the result: all planks it can make (1 log -> 4)
  await waitFor(() => a.winLog.some((l) => l.n === n), 5000, "click answers");
  a.click(0, { m: "pick", s: ws, b: 0 }); // put the 2 logs back
  a.send({ t: "close", w: 0 });
  await waitFor(() => a.count(B.OAK_PLANKS) === 4 && a.count(B.OAK_LOG) === 2, 6000, "4 planks, 2 logs left");
  // a table from 4 planks, placed, opened; then a stone pickaxe
  const ps = slotOf(a, B.OAK_PLANKS);
  a.click(0, { m: "pick", s: ps < 9 ? 36 + ps : ps, b: 0 });
  a.click(0, { m: "drag", b: 0, list: [1, 2, 3, 4] });
  const n2 = a.click(0, { m: "pick", s: 0, b: 0 });
  await waitFor(() => a.winLog.some((l) => l.n === n2), 5000, "table crafted");
  assert.equal(a.win0?.cursor?.id, B.CRAFTING_TABLE);
  const free = a.inv.findIndex((x, k) => k < 9 && !x);
  a.click(0, { m: "pick", s: 36 + free, b: 0 });
  a.send({ t: "close", w: 0 });
  await waitFor(() => a.count(B.CRAFTING_TABLE) === 1, 5000, "table in inventory");
  await holdItem(a, B.CRAFTING_TABLE);
  a.place(P.x + 3, P.y + 1, P.z + 3, B.CRAFTING_TABLE);
  await waitFor(() => a.block(base, P.x + 3, P.y + 1, P.z + 3) === B.CRAFTING_TABLE, 5000, "table placed");
  await give(a, "cobblestone", 3);
  await give(a, "stick", 2);
  await waitFor(() => a.count(B.COBBLESTONE) >= 3 && a.count(I.STICK) >= 2, 5000, "cobble and sticks");
  a.use(P.x + 3, P.y + 1, P.z + 3);
  await waitFor(() => a.win?.kind === "crafting", 5000, "table window");
  const w = a.win!.w;
  const nf = a.click(w, { m: "fill", r: "stone_pickaxe", all: false });
  await waitFor(() => a.winLog.some((l) => l.n === nf), 5000, "fill answered");
  assert.equal(a.win!.items[0]?.id, toolId(1, 0), "the result shows a stone pickaxe");
  const nt = a.click(w, { m: "shift", s: 0 });
  await waitFor(() => a.winLog.some((l) => l.n === nt), 5000, "crafted");
  a.closeWindow(w);
  await waitFor(() => a.count(toolId(1, 0)) === 1, 5000, "stone pickaxe");
});

test("a furnace smelts on its own (fuel burns, the block lights up), and its window shows the progress", async () => {
  const a = bots[bots.length - 1];
  await tpTo(a, P.x + 5.5, P.y + 1, P.z + 5.5);
  await give(a, "furnace", 1);
  await give(a, "raw_iron", 2);
  await give(a, "coal", 1);
  await holdItem(a, B.FURNACE);
  a.place(P.x + 5, P.y + 1, P.z + 3, B.FURNACE + 2);
  await waitFor(() => (a.block(base, P.x + 5, P.y + 1, P.z + 3) & ~7) === (B.FURNACE & ~7) || a.block(base, P.x + 5, P.y + 1, P.z + 3) >= B.FURNACE, 5000, "furnace placed");
  a.use(P.x + 5, P.y + 1, P.z + 3);
  await waitFor(() => a.win?.kind === "furnace", 5000, "furnace window");
  const w = a.win!.w;
  await waitFor(() => slotOf(a, I.RAW_IRON) >= 0 && slotOf(a, I.COAL) >= 0, 5000, "iron and coal arrived");
  const iron = slotOf(a, I.RAW_IRON);
  const coal = slotOf(a, I.COAL);
  const ws = (s: number) => (s < 9 ? 30 + s : s - 9 + 3);
  a.click(w, { m: "shift", s: ws(iron) });
  a.click(w, { m: "shift", s: ws(coal) });
  // the coal goes straight in as burning fuel, so the fuel slot may already be empty again
  await waitFor(() => !!a.win?.items[0] && a.count(I.COAL) === 0, 5000, "input and fuel in");
  await waitFor(() => a.block(base, P.x + 5, P.y + 1, P.z + 3) >= B.FURNACE + 4, 6000, "the furnace lights up");
  await waitFor(() => (a.furnace?.cook ?? 0) > 0.2, 6000, "progress arrives");
  await waitFor(() => a.win?.items[2]?.id === I.IRON_INGOT && a.win!.items[2]!.n === 2, 25000, "two iron ingots");
  const outN = a.click(w, { m: "shift", s: 2 });
  await waitFor(() => a.winLog.some((l) => l.n === outN), 5000, "took the ingots");
  a.closeWindow(w);
  await waitFor(() => a.count(I.IRON_INGOT) === 2, 5000, "ingots in the inventory");
});

test("chests: shared by two players, and two players grabbing the same stack can't both get it", async () => {
  const a = bots[bots.length - 1];
  const b = await join("surv-b-token-0123456789abcdef");
  await tpTo(a, P.x + 7.5, P.y + 1, P.z + 1.5);
  await tpTo(b, P.x + 7.5, P.y + 1, P.z + 5.5);
  await give(a, "chest", 1);
  await give(a, "diamond", 5);
  await holdItem(a, B.CHEST);
  a.place(P.x + 7, P.y + 1, P.z + 3, B.CHEST + 2);
  await sleep(500);
  if (process.env.DEBUG_CHEST) console.log("DEBUG", JSON.stringify({ sel: a.sel, inv: a.inv, notices: a.notices.slice(-5), pos: [a.x, a.y, a.z], P, blk: a.block(base, P.x + 7, P.y + 1, P.z + 3), kicked: a.kicked, closed: a.closed }));
  await waitFor(() => a.block(base, P.x + 7, P.y + 1, P.z + 3) >= B.CHEST && a.block(base, P.x + 7, P.y + 1, P.z + 3) < B.CHEST + 4, 5000, "chest placed");
  a.use(P.x + 7, P.y + 1, P.z + 3);
  await waitFor(() => a.win?.kind === "chest", 5000, "chest window");
  await waitFor(() => slotOf(a, I.DIAMOND) >= 0, 5000, "diamonds arrived");
  const d = slotOf(a, I.DIAMOND);
  a.click(a.win!.w, { m: "shift", s: d < 9 ? 54 + d : d - 9 + 27 });
  await waitFor(() => a.win!.items.slice(0, 27).some((s) => s?.id === I.DIAMOND), 5000, "diamonds in the chest");
  b.use(P.x + 7, P.y + 1, P.z + 3);
  await waitFor(() => b.win?.kind === "chest" && b.win.items.slice(0, 27).some((s) => s?.id === I.DIAMOND), 5000, "b sees the diamonds");
  const slot = b.win!.items.findIndex((s) => s?.id === I.DIAMOND);
  // both shift-click the same slot at once
  a.click(a.win!.w, { m: "shift", s: slot });
  b.click(b.win!.w, { m: "shift", s: slot });
  await sleep(600);
  a.closeWindow(a.win!.w);
  b.closeWindow(b.win!.w);
  await sleep(400);
  assert.equal(a.count(I.DIAMOND) + b.count(I.DIAMOND), 5, `exactly 5 diamonds exist (a ${a.count(I.DIAMOND)}, b ${b.count(I.DIAMOND)})`);
  b.close();
  bots.splice(bots.indexOf(b), 1);
});

test("breaking a chest spills its contents; a cursor stack held when you disconnect comes back", async () => {
  const a = bots[bots.length - 1];
  await tpTo(a, P.x + 1.5, P.y + 1, P.z + 8.5);
  await give(a, "chest", 1);
  await give(a, "gold_ingot", 7);
  await holdItem(a, B.CHEST);
  a.place(P.x + 1, P.y + 1, P.z + 6, B.CHEST);
  await waitFor(() => a.block(base, P.x + 1, P.y + 1, P.z + 6) >= B.CHEST, 5000, "chest 2");
  a.use(P.x + 1, P.y + 1, P.z + 6);
  await waitFor(() => a.win?.kind === "chest", 5000, "chest 2 window");
  await waitFor(() => slotOf(a, I.GOLD_INGOT) >= 0, 5000, "gold arrived");
  const g = slotOf(a, I.GOLD_INGOT);
  a.click(a.win!.w, { m: "shift", s: g < 9 ? 54 + g : g - 9 + 27 });
  await sleep(300);
  a.closeWindow(a.win!.w);
  a.select(8);
  a.move(a.x, a.y, a.z);
  await sleep(100);
  await dig(a, P.x + 1, P.y + 1, P.z + 6, 75);
  await waitFor(() => [...a.items.values()].some((it) => it.item === I.GOLD_INGOT && it.n === 7), 6000, "the gold spilled out");
  // pick up some planks onto the cursor, then disconnect
  await give(a, "birch_planks", 9);
  await waitFor(() => a.count(B.BIRCH_PLANKS) === 9, 5000, "planks");
  const s = slotOf(a, B.BIRCH_PLANKS);
  const n = a.click(0, { m: "pick", s: s < 9 ? 36 + s : s, b: 0 });
  await waitFor(() => a.winLog.some((l) => l.n === n), 5000, "on the cursor");
  a.close();
  bots.pop();
  await sleep(400);
  const back = await join("surv-a-token-0123456789abcdef");
  assert.equal(back.count(B.BIRCH_PLANKS), 9, "the cursor stack went back into the inventory");
});

test("death: everything drops where you died, you respawn at the hub (or your bed), and can pick it all up", async () => {
  const a = bots[bots.length - 1];
  await tpTo(a, P.x + 4.5, P.y + 1, P.z + 8.5);
  const before = a.inv.filter(Boolean).length;
  assert.ok(before >= 3);
  const had = new Map<number, number>();
  for (const st of a.inv) if (st) had.set(st.id, (had.get(st.id) ?? 0) + st.n);
  const deaths = a.deaths.length;
  a.chat("/kill");
  await waitFor(() => a.deaths.length > deaths, 5000, "dead");
  await waitFor(() => a.inv.filter(Boolean).length === 0, 5000, "inventory emptied");
  await waitFor(() => a.items.size > 0, 5000, "drops near the body");
  a.send({ t: "respawn" });
  await waitFor(() => a.respawns.length > 0, 5000, "respawned");
  const r = a.respawns[a.respawns.length - 1];
  assert.ok(Math.hypot(r.x - gen.info.spawn.x, r.z - gen.info.spawn.z) < 1, "at the hub spawn");
  await waitFor(() => a.stats.hp === 20, 5000, "full health again");
  // walk back (teleport) and collect everything
  await tpTo(a, P.x + 4.5, P.y + 1, P.z + 8.5);
  await sleep(2500); // thrown items wait 2 s before they can be picked up
  // walk over every drop near where we died
  for (let round = 0; round < 3; round++) {
    for (const it of [...a.items.values()]) {
      if (Math.hypot(it.x - (P.x + 4.5), it.z - (P.z + 8.5)) > 6) continue;
      await walkTo(a, it.x, P.y + 1, it.z);
      await sleep(100);
    }
  }
  for (const [id, n] of had) assert.ok(a.count(id) >= n, `picked up all of item ${id} (${a.count(id)}/${n})`);
  // a bed sets the respawn point (step off the spot first: you can't place a bed where you stand)
  await walkTo(a, P.x + 2.5, P.y + 1, P.z + 5.5);
  await give(a, "red_bed", 1);
  await holdItem(a, B.RED_BED);
  a.place(P.x + 2, P.y + 1, P.z + 8, B.RED_BED + 1);
  await waitFor(() => a.block(base, P.x + 2, P.y + 1, P.z + 8) === B.RED_BED + 1, 5000, "bed placed");
  const notices = a.notices.length;
  a.use(P.x + 2, P.y + 1, P.z + 8);
  await waitFor(() => a.notices.slice(notices).some((t) => /respawn point/i.test(t)), 5000, "respawn point set");
  await tpTo(a, P.x + 9.5, P.y + 1, P.z + 0.5);
  a.chat("/kill");
  await waitFor(() => a.deaths.length > deaths + 1, 5000, "dead again");
  a.send({ t: "respawn" });
  await waitFor(() => a.respawns.length > 1, 5000, "respawned again");
  const r2 = a.respawns[a.respawns.length - 1];
  assert.ok(Math.hypot(r2.x - (P.x + 2.5), r2.z - (P.z + 8.5)) < 3, `next to the bed (${r2.x}, ${r2.z})`);
});

test("falls hurt (12.1.2: half a heart per 2 blocks past 6); eating restores hunger", async () => {
  const a = bots[bots.length - 1];
  await tpTo(a, P.x + 6.5, P.y + 11, P.z + 6.5);
  for (let y = P.y + 11; y > P.y + 1; y -= 0.9) {
    a.move(P.x + 6.5, y, P.z + 6.5, 0, 0, 0);
    await sleep(70);
  }
  a.move(P.x + 6.5, P.y + 1, P.z + 6.5);
  await waitFor(() => a.hurts.some((h) => h.cause === "fall"), 5000, "fall damage");
  await waitFor(() => a.stats.hp === 18, 5000, `hp 18 after a 10-block fall (got ${a.stats.hp})`);
  a.chat("/hunger 10");
  await give(a, "apple", 1);
  await holdItem(a, I.APPLE);
  const apples = a.count(I.APPLE);
  a.send({ t: "eat", a: "start" });
  await sleep(1700);
  a.send({ t: "eat", a: "finish" });
  await waitFor(() => a.stats.food === 14, 5000, `food 14 after an apple (got ${a.stats.food})`);
  await waitFor(() => a.count(I.APPLE) === apples - 1, 5000, "one apple eaten");
});

test("falls (12.1.2): 6 blocks do nothing, 7 blocks half a heart; a server correction mid-air starts the fall over", async () => {
  const a = bots[bots.length - 1];
  const x = P.x + 6.5;
  const z = P.z + 6.5;
  const drop = async (from: number) => {
    await tpTo(a, x, P.y + 1 + from, z);
    for (let y = P.y + 1 + from; y > P.y + 1; y -= 0.9) {
      a.move(x, y, z, 0, 0, 0);
      await sleep(70);
    }
    a.move(x, P.y + 1, z);
    await sleep(500);
  };
  const hp0 = a.stats.hp;
  const falls0 = a.hurts.filter((h) => h.cause === "fall").length;
  await drop(3);
  assert.equal(a.stats.hp, hp0, "a 3-block drop does nothing");
  await drop(6);
  assert.equal(a.stats.hp, hp0, "a 6-block drop does nothing (12.1.2)");
  await drop(7);
  await waitFor(() => a.stats.hp === hp0 - 1, 5000, `a 7-block drop costs half a heart (hp ${a.stats.hp})`);
  // a 10-block fall, but the server pulls the player back 2 blocks above the ground (a lag snapback)
  await tpTo(a, x, P.y + 11, z);
  for (let y = P.y + 11; y > P.y + 3; y -= 0.9) {
    a.move(x, y, z, 0, 0, 0);
    await sleep(70);
  }
  a.move(x, P.y + 3, z, 0, 0, 0);
  await sleep(70);
  const tps = a.tps.length;
  a.move(x + 30, P.y + 3, z, 0, 0, 0); // far too fast: corrected back to the last valid spot
  await waitFor(() => a.tps.length > tps, 5000, "corrected");
  const back = a.tps[a.tps.length - 1];
  for (let y = back.y; y > P.y + 1; y -= 0.9) {
    a.move(back.x, y, back.z, 0, 0, 0);
    await sleep(70);
  }
  a.move(back.x, P.y + 1, back.z);
  await sleep(600);
  assert.equal(a.stats.hp, hp0 - 1, "no damage for the part of the fall before the correction");
  assert.equal(a.hurts.filter((h) => h.cause === "fall").length, falls0 + 1, "one fall hurt in all");
});

test("sleeping at night skips to the morning", async () => {
  const a = bots[bots.length - 1];
  await tpTo(a, P.x + 4.5, P.y + 1, P.z + 8.5);
  a.chat("/time 14000");
  await sleep(200);
  const msgs = a.sleepMsgs.length;
  a.use(P.x + 2, P.y + 1, P.z + 8);
  await waitFor(() => a.sleepMsgs.slice(msgs).some((m) => m.sleeping === 1), 5000, "sleeping");
  await waitFor(() => a.times.length > 0 && a.times[a.times.length - 1] < 1000, 9000, "morning");
  await waitFor(() => a.sleepMsgs[a.sleepMsgs.length - 1].sleeping === 0, 6000, "woke up");
  a.chat("/time 6000");
});

test("animals: a wooden sword (4 damage) kills a chicken (4 health) in one hit, and it drops raw chicken", async () => {
  const a = bots[bots.length - 1];
  await tpTo(a, P.x + 5.5, P.y + 1, P.z + 0.5);
  const chickenBefore = a.count(I.CHICKEN);
  a.chat("/summon chicken 1");
  await waitFor(() => [...a.animals.values()].some((an) => an.kind === 3 && Math.hypot(an.x - a.x, an.z - a.z) < 4), 6000, "a chicken");
  const c = [...a.animals.values()].find((an) => an.kind === 3 && Math.hypot(an.x - a.x, an.z - a.z) < 4)!;
  await give(a, "wooden_sword", 1);
  await holdItem(a, toolId(0, 3));
  await sleep(700); // v6: a sword just taken in hand needs its swing charged (0.625 s)
  const cur = a.animals.get(c.id)!;
  await walkTo(a, cur.x + 1.5, P.y + 1, cur.z);
  a.hit(c.id);
  await waitFor(() => !!((a.animals.get(c.id)?.flags ?? 64) & 64), 5000, "the chicken dies");
  // (the bot may already have walked over it and picked it up)
  await waitFor(() => [...a.items.values()].some((it) => it.item === I.CHICKEN) || a.count(I.CHICKEN) > chickenBefore, 6000, "raw chicken dropped");
});

test("tools wear out: a gold pickaxe breaks after 32 blocks (with a sound for everyone)", async () => {
  const a = bots[bots.length - 1];
  await tpTo(a, P.x + 0.5, P.y + 1, P.z + 0.5);
  await give(a, "golden_pickaxe", 1);
  await give(a, "cobblestone", 32);
  for (let k = 0; k < 32; k++) {
    const x = P.x + (k % 4); // four spots on the ground, used again and again
    const z = P.z - 2;
    const y = P.y + 1;
    await holdItem(a, B.COBBLESTONE);
    a.place(x, y, z, B.COBBLESTONE);
    await waitFor(() => a.block(base, x, y, z) === B.COBBLESTONE, 5000, `cobble ${k}`);
    await holdItem(a, toolId(3, 0));
    await dig(a, x, y, z, 5);
  }
  await waitFor(() => a.fx.some((f) => f.k === "tool_break"), 6000, "the pickaxe broke");
  await waitFor(() => a.count(toolId(3, 0)) === 0, 5000, "and is gone from the inventory");
});

test("lag: a finish that arrives early (start and finish bunched together) breaks the block after the full dig time", async () => {
  const a = bots[bots.length - 1];
  await tpTo(a, P.x + 0.5, P.y + 1, P.z + 0.5);
  await give(a, "wooden_pickaxe", 1);
  await give(a, "cobblestone", 1);
  const x = P.x + 1;
  const y = P.y + 1;
  const z = P.z - 2;
  await holdItem(a, B.COBBLESTONE);
  a.place(x, y, z, B.COBBLESTONE);
  await waitFor(() => a.block(base, x, y, z) === B.COBBLESTONE, 5000, "cobble placed");
  await holdItem(a, toolId(0, 0));
  const cobble = a.count(B.COBBLESTONE);
  const t0 = Date.now();
  a.dig("start", x, y, z); // a wooden pickaxe takes 30 ticks (1.5 s) on cobblestone
  a.dig("finish", x, y, z);
  await sleep(600);
  assert.equal(a.block(base, x, y, z), B.COBBLESTONE, "not broken early");
  await waitFor(() => a.block(base, x, y, z) === B.AIR, 6000, "broken once the dig time has passed");
  assert.ok(Date.now() - t0 >= 1300, `never faster than honest digging (${Date.now() - t0} ms)`);
  await tpTo(a, x + 0.5, y, z + 0.5);
  await waitFor(() => a.count(B.COBBLESTONE) > cobble, 6000, "and it dropped (picked up by walking onto it)");
});

test("Q throws the held item in front of you", async () => {
  const a = bots[bots.length - 1];
  await give(a, "feather", 3);
  await holdItem(a, I.FEATHER);
  await sleep(300);
  const feathers = a.count(I.FEATHER);
  a.send({ t: "drop", all: false });
  await waitFor(() => a.count(I.FEATHER) === feathers - 1, 5000, "one thrown");
  await waitFor(() => [...a.items.values()].some((it) => it.item === I.FEATHER), 5000, "the feather on the ground");
});

test("a planted sapling grows into a tree (forced with /grow in tests; about 4 minutes in play)", async () => {
  const a = bots[bots.length - 1];
  await tpTo(a, P.x + 8.5, P.y + 1, P.z + 9.5);
  await give(a, "oak_sapling", 1);
  await holdItem(a, B.OAK_SAPLING);
  a.place(P.x + 9, P.y + 1, P.z + 7, B.OAK_SAPLING);
  await waitFor(() => a.block(base, P.x + 9, P.y + 1, P.z + 7) === B.OAK_SAPLING, 5000, "sapling planted");
  a.chat("/grow");
  await waitFor(() => a.block(base, P.x + 9, P.y + 1, P.z + 7) === B.OAK_LOG && a.block(base, P.x + 9, P.y + 2, P.z + 7) === B.OAK_LOG, 5000, "a tree");
});
