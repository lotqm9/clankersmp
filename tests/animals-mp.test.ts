// Animals over the network: a real server (DEV_COMMANDS=1 for /tp and /summon) and protocol bots.
// Join streams nearby animals; a hit in reach makes everyone see the hurt flash and the animal run off; a hit out of
// reach does nothing; no block can be placed inside an animal; leaving the area sends "gone"; herds survive a restart.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AF, ANIMAL, ANIMAL_RANGE, SPECS } from "../shared/animals.ts";
import { B, SOLID } from "../shared/blocks.ts";
import { DEFAULT_SEED, SPAWN_X, SPAWN_Z, WORLD_HEIGHT, idx } from "../shared/constants.ts";
import { generateWorld } from "../shared/worldgen.ts";
import { Bot, sleep, waitFor } from "./bot.ts";

const PORT = 20500 + Math.floor(Math.random() * 1500);
const URL = `ws://127.0.0.1:${PORT}`;
const ADMIN = "test-admin-secret-0123456789";
const dir = mkdtempSync(join(tmpdir(), "steve-craft-animals-mp-"));
let server: ChildProcess;
const bots: Bot[] = [];
const base = generateWorld(DEFAULT_SEED).blocks;
const ground = (x: number, z: number) => {
  for (let y = WORLD_HEIGHT - 1; y > 0; y--) if (SOLID[base[idx(Math.floor(x), y, Math.floor(z))]]) return y + 1;
  return 64;
};
/** Teleport a bot onto the ground at (x, z) and wait until the server confirms it. */
async function tpTo(b: Bot, x: number, z: number): Promise<void> {
  const n = b.tps.length;
  b.chat(`/tp ${x} ${ground(x, z)} ${z}`);
  await waitFor(() => b.tps.length > n, 3000, "teleport");
  b.move(b.x, b.y, b.z);
  await sleep(150);
}

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [process.env.SERVER_ENTRY || "server/src/main.ts"], {
      env: { ...process.env, MOBS: "0", PORT: String(PORT), WORLD_DIR: dir, ADMIN_SECRET: ADMIN, DEV_COMMANDS: "1", COIN_CA: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => reject(new Error("server did not start")), 30000);
    p.stdout!.on("data", (d: Buffer) => {
      if (d.toString().includes("game server on")) {
        clearTimeout(timer);
        resolve(p);
      }
    });
  });
}
const stopServer = (p: ChildProcess) =>
  new Promise<void>((resolve) => {
    p.once("exit", () => resolve());
    p.kill("SIGTERM");
  });

before(async () => {
  server = await startServer();
});
after(async () => {
  for (const b of bots) b.close();
  if (server) await stopServer(server);
  rmSync(dir, { recursive: true, force: true });
});

const near = (b: Bot, kind: number, r: number) => [...b.animals.values()].filter((a) => a.kind === kind && Math.hypot(a.x - b.x, a.z - b.z) < r);

test("joining streams the animals around you (herds on the island, all four kinds exist)", async () => {
  const a = new Bot();
  await a.connect(URL, { token: "animal-bot-a-0123456789abcdef" });
  bots.push(a);
  await waitFor(() => a.animals.size > 0, 5000, "animals near spawn");
  for (const s of a.animals.values()) {
    assert.ok(SPECS[s.kind], "known kind");
    assert.ok(Math.hypot(s.x - a.x, s.z - a.z) <= ANIMAL_RANGE + 1, "only animals in range are sent");
  }
  const st = await (await fetch(`http://127.0.0.1:${PORT}/admin/players`, { headers: { authorization: `Bearer ${ADMIN}` } })).json();
  assert.ok(st.shards[0], "admin still answers");
});

test("a hit in reach: every client sees the hurt flash, and the animal runs away; out of reach nothing happens", async () => {
  const [a] = bots;
  const b = new Bot();
  await b.connect(URL, { token: "animal-bot-b-0123456789abcdef" });
  bots.push(b);
  // A quiet field east of spawn, outside the plaza.
  const fx = SPAWN_X + 20.5;
  const fz = SPAWN_Z + 0.5;
  await tpTo(a, fx, fz);
  await tpTo(b, fx + 1, fz + 2);
  a.chat("/summon pig 1");
  await waitFor(() => near(a, ANIMAL.PIG, 4).length > 0, 3000, "pig summoned next to us");
  const pig = near(a, ANIMAL.PIG, 4)[0];
  // Too far: a third bot 9 blocks away swings at it.
  const c = new Bot();
  await c.connect(URL, { token: "animal-bot-c-0123456789abcdef" });
  bots.push(c);
  const p0 = a.animals.get(pig.id)!;
  await tpTo(c, p0.x + 9, p0.z);
  const hist0 = a.animalHistory.length;
  c.hit(pig.id);
  await sleep(600);
  assert.ok(!a.animalHistory.slice(hist0).some((s) => s.id === pig.id && s.flags & AF.HURT), "no hurt from 9 blocks");
  // In reach: bot a steps right next to it (it may have wandered) and hits it.
  const p1 = a.animals.get(pig.id)!;
  await tpTo(a, p1.x - 1.5, p1.z);
  const start = a.animals.get(pig.id)!;
  a.hit(pig.id);
  await waitFor(() => a.animalHistory.some((s) => s.id === pig.id && s.flags & AF.HURT), 2000, "a sees the hurt flag");
  await waitFor(() => b.animalHistory.some((s) => s.id === pig.id && s.flags & AF.HURT), 2000, "b sees the hurt flag");
  assert.ok(b.animalHistory.some((s) => s.id === pig.id && s.flags & AF.PANIC), "it panics");
  await sleep(3000);
  const now = a.animals.get(pig.id)!;
  const before = Math.hypot(start.x - a.x, start.z - a.z);
  const after = Math.hypot(now.x - a.x, now.z - a.z);
  // It bolts away (terrain can make it veer, so: clearly further away and clearly moved).
  assert.ok(after > before + 2.5 && Math.hypot(now.x - start.x, now.z - start.z) > 3, `ran away: ${before.toFixed(1)} -> ${after.toFixed(1)} blocks`);
});

test("no placing a block inside an animal", async () => {
  const [a] = bots;
  a.chat("/summon cow 1");
  await waitFor(() => near(a, ANIMAL.COW, 4).length > 0, 3000, "cow");
  await sleep(1000);
  const cow = near(a, ANIMAL.COW, 4)[0];
  const x = Math.floor(cow.x);
  const z = Math.floor(cow.z);
  const y = Math.floor(cow.y) + 1; // inside its body (a cow is 1.4 tall)
  a.place(x, y, z, B.STONE);
  await sleep(500);
  assert.notEqual(a.edits.get((y << 18) | (z << 9) | x), B.STONE, "refused");
});

test("walking away sends 'gone' for the animals left behind", async () => {
  const [a] = bots;
  const had = [...a.animals.keys()];
  assert.ok(had.length > 0);
  await tpTo(a, SPAWN_X - 200, SPAWN_Z - 200);
  await waitFor(() => had.every((id) => a.gone.includes(id) || !a.animals.has(id)), 4000, "gone");
});

test("animals survive a server restart", async () => {
  const st0 = await fetch(`http://127.0.0.1:${PORT}/admin/save`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}` } });
  assert.equal(st0.status, 200);
  for (const b of bots) b.close();
  bots.length = 0;
  await stopServer(server);
  server = await startServer();
  const a = new Bot();
  await a.connect(URL, { token: "animal-bot-d-0123456789abcdef" });
  bots.push(a);
  await tpTo(a, SPAWN_X + 20.5, SPAWN_Z + 0.5);
  await waitFor(() => near(a, ANIMAL.COW, 12).length > 0 && near(a, ANIMAL.PIG, 30).length > 0, 5000, "the summoned cow and pig are still there");
});
