// Leaf decay on a real server (LEAF_DECAY_MS=3000, so it takes seconds rather than a minute): a player cuts every
// log of an oak and its canopy withers away on its own, a leaf at a time (block changes to air, now and then a
// sapling on the ground); a leaf the player put down against that canopy stays; and a standing tree nearby keeps all
// its leaves.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { B, SOLID } from "../shared/blocks.ts";
import { DEFAULT_SEED, SPAWN_X, SPAWN_Z, WORLD_HEIGHT, WORLD_SIZE, idx } from "../shared/constants.ts";
import { SAFE_RADIUS } from "../shared/hub.ts";
import { villageBox } from "../shared/villages.ts";
import { generateWorld, hashBlocks } from "../shared/worldgen.ts";
import { Bot, sleep, waitFor } from "./bot.ts";

const PORT = 25600 + Math.floor(Math.random() * 1500);
const URL = `ws://127.0.0.1:${PORT}`;
const dir = mkdtempSync(pjoin(tmpdir(), "steve-craft-leaves-"));
let server: ChildProcess;
const bots: Bot[] = [];
let serverOut = "";
let base: Uint8Array;

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [process.env.SERVER_ENTRY || "server/src/main.ts"], {
      env: { ...process.env, MOBS: "0", PORT: String(PORT), WORLD_DIR: dir, ADMIN_SECRET: "test-admin-secret-0123456789", DEV_COMMANDS: "1", GAMEMODE: "", COIN_CA: "", ANIMALS: "0", LEAF_DECAY_MS: "3000" },
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

const LOGS = new Set<number>([B.OAK_LOG, B.BIRCH_LOG, B.PALM_LOG]);
const LEAVES = new Set<number>([B.OAK_LEAVES, B.BIRCH_LEAVES, B.PALM_LEAVES]);
const get = (x: number, y: number, z: number) => (x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE || y < 0 || y >= WORLD_HEIGHT ? B.AIR : base[idx(x, y, z)]);
const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

type Tree = { x: number; y: number; z: number; logs: [number, number, number][]; leaves: [number, number, number][] };

/** The oak standing on the ground at (x, y, z): its trunk, and every leaf within 6 of it through leaves. */
function treeAt(x: number, y: number, z: number): Tree {
  const logs: [number, number, number][] = [];
  for (let yy = y; get(x, yy, z) === B.OAK_LOG; yy++) logs.push([x, yy, z]);
  const seen = new Set<number>();
  let front = logs.map((c) => [...c] as [number, number, number]);
  for (let d = 1; d <= 6; d++) {
    const next: [number, number, number][] = [];
    for (const [cx, cy, cz] of front)
      for (const [dx, dy, dz] of N6) {
        const n: [number, number, number] = [cx + dx, cy + dy, cz + dz];
        if (!LEAVES.has(get(...n)) || seen.has(idx(...n))) continue;
        seen.add(idx(...n));
        next.push(n);
      }
    front = next;
  }
  return { x, y, z, logs, leaves: [...seen].map((i) => [i & (WORLD_SIZE - 1), Math.floor(i / (WORLD_SIZE * WORLD_SIZE)), Math.floor(i / WORLD_SIZE) & (WORLD_SIZE - 1)]) };
}

/** Oaks out of the safe zone and the villages with a plain trunk (no branches) at most 6 high, and no other log
 *  within 9 blocks of their leaves: the canopy is all theirs. */
function loneOaks(villages: number[]): Tree[] {
  const out: Tree[] = [];
  const boxes = villages.map((v) => villageBox(v));
  for (let z = 20; z < WORLD_SIZE - 20 && out.length < 6; z += 3)
    for (let x = 20; x < WORLD_SIZE - 20 && out.length < 6; x += 1) {
      if (Math.hypot(x - SPAWN_X, z - SPAWN_Z) < SAFE_RADIUS + 30) continue;
      if (boxes.some((b) => x >= b.x0 - 12 && x <= b.x1 + 12 && z >= b.z0 - 12 && z <= b.z1 + 12)) continue;
      for (let y = 40; y < 90; y++) {
        if (get(x, y, z) !== B.OAK_LOG || get(x, y - 1, z) !== B.GRASS && get(x, y - 1, z) !== B.DIRT) continue;
        const t = treeAt(x, y, z);
        if (t.logs.length < 3 || t.logs.length > 6 || t.leaves.length < 20) break;
        let alone = true;
        for (const [lx, ly, lz] of t.leaves)
          for (let dx = -9; alone && dx <= 9; dx++)
            for (let dz = -9; alone && dz <= 9; dz++)
              for (let dy = -9; alone && dy <= 9; dy++) {
                const id = get(lx + dx, ly + dy, lz + dz);
                if (LOGS.has(id) && !(lx + dx === x && lz + dz === z)) alone = false;
              }
        if (alone && !out.some((o) => Math.hypot(o.x - x, o.z - z) < 30)) out.push(t);
        break;
      }
    }
  return out;
}

async function tpTo(b: Bot, x: number, y: number, z: number): Promise<void> {
  const n = b.tps.length;
  b.chat(`/tp ${x} ${y} ${z}`);
  await waitFor(() => b.tps.length > n, 6000, "tp");
  b.move(x, y, z);
  await sleep(150);
}

test("an oak cut down loses its canopy within seconds, a leaf at a time; a leaf put down stays; a standing oak keeps its leaves", async () => {
  const b = new Bot();
  await b.connect(URL, { name: "Woodcutter" });
  bots.push(b);
  const w = b.welcome!;
  base = generateWorld(DEFAULT_SEED, undefined, { villages: w.villages, hub: w.hub }).blocks;
  assert.equal(w.genHash, hashBlocks(base), "the same terrain as the server's");
  const oaks = loneOaks(w.villages ?? []);
  assert.ok(oaks.length >= 2, `two lone oaks to test on (${oaks.length})`);
  const [cut, standing] = oaks;
  const at = (x: number, y: number, z: number) => b.block(base, x, y, z);
  b.chat("/gamemode creative");
  await sleep(300);
  // stand beside the trunk, on the ground
  let gy = cut.y;
  while (gy < WORLD_HEIGHT - 1 && SOLID[get(cut.x + 1, gy, cut.z)]) gy++;
  await tpTo(b, cut.x + 1.5, gy, cut.z + 0.5);
  // a leaf put down against the canopy's side, joined to it
  const low = Math.min(...cut.leaves.map((c) => c[1]));
  const edge = cut.leaves.filter((c) => c[1] === low).sort((p, q) => q[0] - p[0])[0];
  const mine: [number, number, number] = [edge[0] + 1, edge[1], edge[2]];
  assert.equal(at(...mine), B.AIR, "room for the leaf by the canopy");
  b.chat("/give oak_leaves 1");
  await waitFor(() => b.count(B.OAK_LEAVES) > 0, 6000, "leaves in hand");
  const s = b.inv.findIndex((st) => st?.id === B.OAK_LEAVES);
  assert.ok(s >= 0 && s < 9, "the leaves are on the hotbar");
  b.select(s);
  b.move(b.x, b.y, b.z);
  await sleep(120);
  b.place(...mine, B.OAK_LEAVES);
  await waitFor(() => at(...mine) === B.OAK_LEAVES, 5000, "the leaf put down");
  // every log of the trunk, from the foot up
  for (const [x, y, z] of cut.logs) {
    b.dig("start", x, y, z);
    b.dig("finish", x, y, z);
    await waitFor(() => at(x, y, z) === B.AIR, 5000, `the log at ${x} ${y} ${z} cut`);
    await sleep(150);
  }
  const t0 = Date.now();
  const left = () => cut.leaves.filter((c) => LEAVES.has(at(...c))).length;
  // not all at once
  await sleep(1000);
  assert.ok(left() > cut.leaves.length / 2, `the canopy goes a leaf at a time (${left()} of ${cut.leaves.length} left after a second)`);
  await waitFor(() => left() === 0, 25000, `the canopy to go (${cut.leaves.length} leaves)`);
  const secs = (Date.now() - t0) / 1000;
  assert.ok(secs > 1.5, `over a few seconds (${secs.toFixed(1)} s)`);
  await sleep(2000);
  assert.equal(at(...mine), B.OAK_LEAVES, "the leaf the player put down is still there");
  assert.equal(standing.leaves.filter((c) => LEAVES.has(at(...c))).length, standing.leaves.length, "the standing oak keeps every leaf");
});
