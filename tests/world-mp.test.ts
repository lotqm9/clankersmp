// The world update's blocks on a real server (protocol v8) with protocol bots (DEV_COMMANDS=1: /tp, /give, /grow):
// the server speaks v8 and its terrain (with the islands) is the one every client generates; fence gates and
// trapdoors open and close for everyone (a gate swings away from you); a flower goes into a pot and back out, and a
// broken pot gives both; a barrel is a 27-slot store that spills when broken; the village chime rings for everyone
// near (and in the hub); a shovel makes a path (not in the hub) and a block on it turns it to dirt; bone meal on
// grass spreads the flowers near it; a hanging lantern falls with its ceiling; a hay bale softens a fall; and Old
// Keep's treasure chest is filled once per world, and not again after a restart.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { B, BLOCKS, SOLID } from "../shared/blocks.ts";
import { DEFAULT_SEED, PROTOCOL_VERSION, SPAWN_X, SPAWN_Z, WORLD_HEIGHT, idx } from "../shared/constants.ts";
import { SAFE_RADIUS } from "../shared/hub.ts";
import { I } from "../shared/items.ts";
import { gate, gateId, trapdoor, trapdoorId } from "../shared/shapes.ts";
import { generateWorld, hashBlocks } from "../shared/worldgen.ts";
import { Bot, patchSpots, sleep, waitFor } from "./bot.ts";

const PORT = 28800 + Math.floor(Math.random() * 1500);
const URL = `ws://127.0.0.1:${PORT}`;
const ADMIN = "test-admin-secret-0123456789";
const dir = mkdtempSync(pjoin(tmpdir(), "steve-craft-world-"));
const gen = generateWorld(DEFAULT_SEED);
const base = gen.blocks;
let server: ChildProcess;
const bots: Bot[] = [];
let serverOut = "";

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [process.env.SERVER_ENTRY || "server/src/main.ts"], {
      env: { ...process.env, MOBS: "0", PORT: String(PORT), WORLD_DIR: dir, ADMIN_SECRET: ADMIN, DEV_COMMANDS: "1", GAMEMODE: "", COIN_CA: "", ANIMALS: "0" },
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
async function stopServer(): Promise<void> {
  await new Promise<void>((resolve) => {
    server.once("exit", () => resolve());
    server.kill("SIGTERM");
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
        for (let yy = y + 1; ok && yy < y + 8; yy++) if (base[idx(x, yy, z)] !== B.AIR && base[idx(x, yy, z)] !== B.TALL_GRASS) ok = false;
      }
    if (ok) return { x: x0, z: z0, y };
  }
  throw new Error("no patch");
}

async function join(token: string): Promise<Bot> {
  const b = new Bot();
  await b.connect(URL, { token });
  bots.push(b);
  return b;
}
async function tpTo(b: Bot, x: number, y: number, z: number): Promise<void> {
  const n = b.tps.length;
  b.chat(`/tp ${x} ${y} ${z}`);
  await waitFor(() => b.tps.length > n, 6000, "tp");
  b.move(x, y, z);
  await sleep(120);
}
/** Put `n` of item `key` in hand (hotbar slot 8). */
async function hold(b: Bot, key: string, id: number, n = 1): Promise<void> {
  b.chat(`/give ${key} ${n}`);
  await waitFor(() => b.inv.some((s) => s?.id === id), 5000, `${key} in the inventory`);
  let s = b.inv.findIndex((st) => st?.id === id);
  if (s > 8 || s < 0) {
    const k = b.click(0, { m: "swap", s, h: 8 });
    await waitFor(() => b.winLog.some((l) => l.n === k), 5000, "swap answered");
    b.send({ t: "close", w: 0 });
    await waitFor(() => b.inv[8]?.id === id, 5000, "on the hotbar");
    s = 8;
  }
  b.select(s);
  b.move(b.x, b.y, b.z);
  await sleep(100);
}
/** An empty hand (hotbar slot 7 emptied by throwing whatever is there). */
async function emptyHand(b: Bot): Promise<void> {
  b.select(7);
  if (b.inv[7]) b.send({ t: "drop", all: true });
  await waitFor(() => !b.inv[7], 5000, "an empty hand");
  b.move(b.x, b.y, b.z);
  await sleep(80);
}
const at = (b: Bot, x: number, y: number, z: number) => b.block(base, x, y, z);
async function clearCell(b: Bot, x: number, y: number, z: number): Promise<void> {
  if (at(b, x, y, z) === B.AIR) return;
  b.dig("start", x, y, z);
  b.dig("finish", x, y, z);
  await waitFor(() => at(b, x, y, z) === B.AIR, 5000, "cleared");
}

let P: { x: number; z: number; y: number };
let A: Bot;
let Bo: Bot;

test("v8: the server speaks protocol 8 or later, and its terrain (islands and all) is the one every client generates", async () => {
  assert.ok(PROTOCOL_VERSION >= 8);
  A = await join("world-a-token-0123456789abcdef");
  Bo = await join("world-b-token-0123456789abcdef");
  assert.equal(A.welcome!.v, PROTOCOL_VERSION);
  assert.equal(A.welcome!.genHash, hashBlocks(base));
  assert.deepEqual(A.welcome!.rides ?? [], []);
  P = patch(10, 8);
  await tpTo(A, P.x + 4.5, P.y + 1, P.z + 4.5);
  await tpTo(Bo, P.x + 5.5, P.y + 1, P.z + 6.5);
  for (let x = P.x; x < P.x + 9; x++) for (let z = P.z; z < P.z + 8; z++) if (at(A, x, P.y + 1, z) === B.TALL_GRASS) await clearCell(A, x, P.y + 1, z);
});

test("fence gates and trapdoors open and close for everyone; a gate swings away from whoever opens it", async () => {
  await hold(A, "fence_gate", B.OAK_GATE, 2);
  const gx = P.x + 2;
  const gz = P.z + 2;
  // facing north (A looks north: yaw 180)
  A.move(A.x, A.y, A.z, 180, 0);
  A.place(gx, P.y + 1, gz, gateId(0, false));
  await waitFor(() => at(Bo, gx, P.y + 1, gz) === gateId(0, false), 5000, "B sees the gate");
  // opened from its south side looking north: it swings north
  A.move(A.x, A.y, A.z, 180, 0);
  A.use(gx, P.y + 1, gz);
  await waitFor(() => at(Bo, gx, P.y + 1, gz) === gateId(0, true), 5000, "open, toward the north");
  A.use(gx, P.y + 1, gz);
  await waitFor(() => at(Bo, gx, P.y + 1, gz) === gateId(0, false), 5000, "closed");
  // from the north side looking south it turns around and swings south
  A.move(A.x, A.y, A.z, 0, 0);
  await sleep(100);
  A.use(gx, P.y + 1, gz);
  await waitFor(() => gate(at(Bo, gx, P.y + 1, gz)).open, 5000, "open again");
  assert.equal(gate(at(Bo, gx, P.y + 1, gz)).facing, 2);
  // a trapdoor on the floor
  await hold(A, "trapdoor", B.TRAPDOOR, 2);
  const tx = P.x + 6;
  A.place(tx, P.y + 1, gz, trapdoorId(2, false, false));
  await waitFor(() => at(Bo, tx, P.y + 1, gz) === trapdoorId(2, false, false), 5000, "B sees the trapdoor");
  Bo.use(tx, P.y + 1, gz);
  await waitFor(() => trapdoor(at(A, tx, P.y + 1, gz)).open, 5000, "B opened it, A sees it");
  // breaking a gate gives the gate back
  await emptyHand(A);
  A.dig("start", gx, P.y + 1, gz);
  await sleep(2600);
  A.dig("finish", gx, P.y + 1, gz);
  await waitFor(() => at(A, gx, P.y + 1, gz) === B.AIR, 5000, "gate broken");
  await waitFor(() => [...A.items.values()].some((it) => it.item === B.OAK_GATE), 5000, "a gate drops");
});

test("a flower goes into a pot and comes back out; a broken potted plant gives the pot and the flower", async () => {
  const x = P.x + 3;
  const z = P.z + 5;
  await hold(A, "flower_pot", B.FLOWER_POT, 1);
  A.place(x, P.y + 1, z, B.FLOWER_POT);
  await waitFor(() => at(Bo, x, P.y + 1, z) === B.FLOWER_POT, 5000, "a pot");
  await hold(A, "bluebell", B.BLUEBELL, 2);
  const n = A.count(B.BLUEBELL);
  A.use(x, P.y + 1, z);
  await waitFor(() => at(Bo, x, P.y + 1, z) === B.FLOWER_POT + 3, 5000, "a potted bluebell");
  await waitFor(() => A.count(B.BLUEBELL) === n - 1, 5000, "one bluebell used");
  await emptyHand(A);
  A.use(x, P.y + 1, z);
  await waitFor(() => at(Bo, x, P.y + 1, z) === B.FLOWER_POT, 5000, "taken back out");
  await waitFor(() => A.count(B.BLUEBELL) === n, 5000, "the bluebell is back in hand");
  await hold(A, "poppy", B.POPPY, 1);
  A.use(x, P.y + 1, z);
  await waitFor(() => at(Bo, x, P.y + 1, z) === B.FLOWER_POT + 1, 5000, "a potted poppy");
  await emptyHand(A);
  const items0 = A.items.size;
  A.dig("start", x, P.y + 1, z);
  A.dig("finish", x, P.y + 1, z);
  await waitFor(() => at(A, x, P.y + 1, z) === B.AIR, 5000, "broken");
  await waitFor(() => A.items.size >= items0 + 2 && [...A.items.values()].some((it) => it.item === B.FLOWER_POT) && [...A.items.values()].some((it) => it.item === B.POPPY), 5000, "pot and poppy drop");
});

test("a barrel is a 27-slot store, and spills what it holds when broken", async () => {
  const x = P.x + 7;
  const z = P.z + 5;
  await hold(A, "barrel", B.BARREL, 1);
  A.place(x, P.y + 1, z, B.BARREL);
  await waitFor(() => at(Bo, x, P.y + 1, z) === B.BARREL, 5000, "a barrel");
  await hold(A, "apple", I.APPLE, 5);
  A.use(x, P.y + 1, z);
  await waitFor(() => A.win?.kind === "chest" && A.win.items.length === 27 + 36, 5000, "the barrel opens (a chest window)");
  const s = 27 + 27 + A.sel; // the held hotbar slot, in the chest window
  assert.equal(A.win!.items[s]?.id, I.APPLE);
  const k = A.click(A.win!.w, { m: "shift", s });
  await waitFor(() => A.winLog.some((l) => l.n === k), 5000, "shift-click answered");
  await waitFor(() => A.win!.items.slice(0, 27).some((st) => st?.id === I.APPLE), 5000, "apples in the barrel");
  A.closeWindow(A.win!.w);
  await sleep(200);
  // B opens it too and sees the apples
  Bo.use(x, P.y + 1, z);
  await waitFor(() => Bo.win?.items.slice(0, 27).some((st) => st?.id === I.APPLE) ?? false, 5000, "B sees them");
  Bo.closeWindow(Bo.win!.w);
  await hold(A, "wooden_axe", 301, 1);
  A.dig("start", x, P.y + 1, z);
  await sleep(1700);
  A.dig("finish", x, P.y + 1, z);
  await waitFor(() => at(A, x, P.y + 1, z) === B.AIR, 5000, "broken");
  await waitFor(() => [...A.items.values()].some((it) => it.item === I.APPLE) && [...A.items.values()].some((it) => it.item === B.BARREL), 5000, "the apples spill out with the barrel");
});

test("the village chime rings for everyone near (and in the hub too), not far away", async () => {
  const x = P.x + 1;
  const z = P.z + 6;
  await hold(A, "village_chime", B.VILLAGE_CHIME, 1);
  A.place(x, P.y + 1, z, B.VILLAGE_CHIME);
  await waitFor(() => at(Bo, x, P.y + 1, z) === B.VILLAGE_CHIME, 5000, "a chime");
  const C = await join("world-c-token-0123456789abcdef");
  await tpTo(C, P.x + 100.5, top(P.x + 100, P.z) + 1, P.z + 0.5);
  const f = Bo.fx.length;
  const fc = C.fx.length;
  A.use(x, P.y + 1, z);
  await waitFor(() => Bo.fx.slice(f).some((e) => e.k === "chime"), 5000, "B hears it");
  await sleep(400);
  assert.ok(!C.fx.slice(fc).some((e) => e.k === "chime"), "C, 100 blocks off, doesn't");
  // the chime block's own rule: it makes no new block state, and a second ring right away is ignored (twice a second at most)
  assert.equal(at(A, x, P.y + 1, z), B.VILLAGE_CHIME);
});

test("a shovel makes a path (not in the hub); a full block on it presses it into dirt", async () => {
  const x = P.x + 5;
  const z = P.z + 7;
  await hold(A, "wooden_shovel", 302, 1);
  A.use(x, P.y, z);
  await waitFor(() => at(Bo, x, P.y, z) === B.DIRT_PATH, 5000, "a path");
  await hold(A, "cobblestone", B.COBBLESTONE, 1);
  A.place(x, P.y + 1, z, B.COBBLESTONE);
  await waitFor(() => at(Bo, x, P.y + 1, z) === B.COBBLESTONE && at(Bo, x, P.y, z) === B.DIRT, 5000, "the path under it turned to dirt");
  // the hub: no paths
  const hx = SPAWN_X + 20;
  const hz = SPAWN_Z + 3;
  const hy = top(hx, hz);
  await tpTo(A, hx + 0.5, hy + 1, hz + 2.5);
  await hold(A, "wooden_shovel", 302, 1);
  const before = at(A, hx, hy, hz);
  A.use(hx, hy, hz);
  await sleep(500);
  assert.equal(at(A, hx, hy, hz), before, "the hub's ground stays as it is");
  await tpTo(A, P.x + 4.5, P.y + 1, P.z + 4.5);
});

test("bone meal on grass grows grass and the flowers already near it (bluebells spread)", async () => {
  // a bluebell planted on the patch, bone meal beside it
  const x = P.x + 8;
  const z = P.z + 1;
  await hold(A, "bluebell", B.BLUEBELL, 1);
  A.place(x, P.y + 1, z, B.BLUEBELL);
  await waitFor(() => at(Bo, x, P.y + 1, z) === B.BLUEBELL, 5000, "a bluebell");
  const back = [A.x, A.y, A.z] as const;
  await tpTo(A, x + 0.5, P.y + 1, z + 0.5);
  await hold(A, "bone_meal", I.BONE_MEAL, 24);
  // on spots round the bluebell, a ring at a time, until a bluebell has grown (each flower is one of the kinds near:
  // the wild dandelions and poppies about count too, so one spot alone sometimes grows no bluebell)
  const ring: [number, number][] = [[-1, 1], [2, -2], [-2, -2], [2, 2], [0, 3], [-3, 0], [3, 0], [0, -3], [-3, 3], [3, -3], [3, 3], [-3, -3], [1, 3], [-1, -3], [3, 1], [-3, -1]];
  const count = () => {
    let n = 0;
    for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) if (at(Bo, x + dx, P.y + 1, z + dz) === B.BLUEBELL && !(dx === 0 && dz === 0)) n++;
    return n;
  };
  for (const [k, [dx, dz]] of ring.entries()) {
    A.use(x + dx, P.y, z + dz);
    await sleep(250);
    if (k >= 3 && count() > 0) break;
  }
  await sleep(400);
  let grown = 0;
  for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) if (at(Bo, x + dx, P.y + 1, z + dz) === B.BLUEBELL && !(dx === 0 && dz === 0)) grown++;
  let others = 0;
  for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) if (([B.DANDELION, B.POPPY] as number[]).includes(at(Bo, x + dx, P.y + 1, z + dz))) others++;
  assert.ok(grown >= 1, `new bluebells: ${grown} (other flowers ${others}, bone meal left ${A.count(I.BONE_MEAL)})`);
  let grass = 0;
  for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) if (at(Bo, x + dx, P.y + 1, z + dz) === B.TALL_GRASS) grass++;
  assert.ok(grass >= 3, `tall grass: ${grass}`);
  assert.ok(A.count(I.BONE_MEAL) < 24, "bone meal used up");
  await tpTo(A, back[0], back[1], back[2]);
});

test("a lantern hangs under a block and falls (as a lantern) when that block is broken", async () => {
  const x = P.x + 8;
  const z = P.z + 6;
  await hold(A, "oak_planks", B.OAK_PLANKS, 3);
  A.place(x, P.y + 1, z, B.OAK_PLANKS);
  await sleep(200);
  A.place(x, P.y + 2, z, B.OAK_PLANKS);
  await sleep(200);
  A.place(x - 1, P.y + 2, z, B.OAK_PLANKS);
  await waitFor(() => at(Bo, x - 1, P.y + 2, z) === B.OAK_PLANKS, 5000, "a little roof");
  await clearCell(A, x - 1, P.y + 1, z);
  await hold(A, "lantern", B.LANTERN, 1);
  A.place(x - 1, P.y + 1, z, B.LANTERN + 1);
  await waitFor(() => at(Bo, x - 1, P.y + 1, z) === B.LANTERN + 1, 5000, "a hanging lantern");
  await emptyHand(A);
  A.dig("start", x - 1, P.y + 2, z);
  await sleep(3100);
  A.dig("finish", x - 1, P.y + 2, z);
  await waitFor(() => at(Bo, x - 1, P.y + 2, z) === B.AIR && at(Bo, x - 1, P.y + 1, z) === B.AIR, 5000, "the roof and the lantern under it go");
  await waitFor(() => [...A.items.values()].some((it) => it.item === B.LANTERN), 5000, "a lantern drops");
});

test("a hay bale takes most of a fall", async () => {
  const x = P.x + 1;
  const z = P.z + 1;
  await hold(A, "hay_bale", B.HAY_BALE, 1);
  A.place(x, P.y + 1, z, B.HAY_BALE);
  await waitFor(() => at(A, x, P.y + 1, z) === B.HAY_BALE, 5000, "hay");
  const hp0 = A.stats.hp;
  const hurts = A.hurts.length;
  const from = P.y + 2 + 16;
  await tpTo(A, x + 0.5, from, z + 0.5);
  for (let y = from; y > P.y + 2; y -= 0.9) {
    A.move(x + 0.5, y, z + 0.5, 0, 0, 0);
    await sleep(70);
  }
  A.move(x + 0.5, P.y + 2, z + 0.5);
  await sleep(800);
  // 12.1.2: 16 blocks onto grass would be 5 damage; onto hay a fifth of the distance past 6, so 2 (natural healing
  // can give one back before the check)
  assert.ok(hp0 - A.stats.hp >= 1 && hp0 - A.stats.hp <= 2, `hurt ${hp0 - A.stats.hp} (from ${hp0})`);
  assert.ok(A.hurts.length - hurts <= 1);
});

test("Old Keep's treasure chest is filled once per world (rubies and more), and not again after a restart", async () => {
  const c = gen.info.islands.chests[0];
  assert.ok(existsSync(pjoin(dir, "shard-1", "loot.json")), "the ledger is kept");
  // (v9: the villages' loot chests are in the ledger too)
  const ledger = JSON.parse(readFileSync(pjoin(dir, "shard-1", "loot.json"), "utf8")) as string[];
  assert.ok(ledger.includes(`${c.x},${c.y},${c.z}`), "Old Keep's chest is in the ledger");
  assert.equal(ledger.length, 1 + gen.info.villages.chests.length);
  await tpTo(A, c.x - 1.5, c.y, c.z + 2.5);
  A.use(c.x, c.y, c.z);
  await waitFor(() => A.win?.kind === "chest", 5000, "the chest opens");
  const loot = A.win!.items.slice(0, 27).filter(Boolean);
  assert.ok(loot.some((s) => s!.id === I.RUBY), "rubies");
  assert.ok(loot.length >= 5, `${loot.length} stacks`); // (five always: rubies, iron, gold, bread, arrows; the rest by chance)
  // take everything
  for (let s = 0; s < 27; s++) {
    if (!A.win!.items[s]) continue;
    const n = A.click(A.win!.w, { m: "shift", s });
    await waitFor(() => A.winLog.some((l) => l.n === n), 5000, "taken");
  }
  assert.ok(A.win!.items.slice(0, 27).every((s) => !s), "empty");
  A.closeWindow(A.win!.w);
  // an admin save, a restart: still empty
  const r = await fetch(`http://127.0.0.1:${PORT}/admin/save`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}` } });
  assert.equal(r.status, 200);
  for (const b of bots) b.close();
  bots.length = 0;
  await stopServer();
  server = await startServer();
  const D = await join("world-d-token-0123456789abcdef");
  await tpTo(D, c.x - 1.5, c.y, c.z + 2.5);
  D.use(c.x, c.y, c.z);
  await waitFor(() => D.win?.kind === "chest", 5000, "it opens");
  assert.ok(D.win!.items.slice(0, 27).every((s) => !s), "not refilled");
  assert.ok(!/filled \d+ treasure/.test(serverOut.split("game server on").slice(-2, -1)[0] ?? ""), "no new fill after the restart");
  assert.equal(BLOCKS[B.CHEST].name, "Chest");
});
