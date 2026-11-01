// Flowing water over the network: a placed source spreads for every client, a block placed in the source drains
// it, breaking the edge of a lake makes it pour out, and an admin rollback of the digging lets the water drain back.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { B, BREAK_TICKS, SOLID } from "../shared/blocks.ts";
import { DEFAULT_SEED, SEA_LEVEL, SPAWN_PROTECT_RADIUS, SPAWN_X, SPAWN_Z, WORLD_HEIGHT, WORLD_SIZE, idx } from "../shared/constants.ts";
import { flowId, isWater } from "../shared/water.ts";
import { generateWorld } from "../shared/worldgen.ts";
import { Bot, sleep, waitFor } from "./bot.ts";

const PORT = 22200 + Math.floor(Math.random() * 1500);
const URL = `ws://127.0.0.1:${PORT}`;
const ADMIN = "test-admin-secret-0123456789";
const dir = mkdtempSync(join(tmpdir(), "steve-craft-water-mp-"));
const base = generateWorld(DEFAULT_SEED).blocks;
let server: ChildProcess;
const bots: Bot[] = [];

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [process.env.SERVER_ENTRY || "server/src/main.ts"], {
      env: { ...process.env, MOBS: "0", PORT: String(PORT), WORLD_DIR: dir, ADMIN_SECRET: ADMIN, DEV_COMMANDS: "1", COIN_CA: "", GAMEMODE: "creative" },
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
before(async () => {
  server = await startServer();
});
after(async () => {
  for (const b of bots) b.close();
  server.kill("SIGTERM");
  await sleep(300);
  rmSync(dir, { recursive: true, force: true });
});

const top = (x: number, z: number) => {
  for (let y = WORLD_HEIGHT - 1; y > 0; y--) if (SOLID[base[idx(x, y, z)]]) return y;
  return 0;
};
/** A flat grass square (size x size, level ground all around) outside spawn protection. */
function flat(size: number, minR: number): { x: number; z: number; y: number } {
  for (let r = minR; r < 230; r += 3)
    for (let a = 0; a < 72; a++) {
      const x0 = Math.round(SPAWN_X + Math.cos((a / 72) * Math.PI * 2) * r);
      const z0 = Math.round(SPAWN_Z + Math.sin((a / 72) * Math.PI * 2) * r);
      if (x0 < 10 || z0 < 10 || x0 > WORLD_SIZE - 30 || z0 > WORLD_SIZE - 30) continue;
      const y = top(x0, z0);
      let ok = true;
      for (let x = x0; ok && x < x0 + size; x++)
        for (let z = z0; ok && z < z0 + size; z++) {
          if (Math.abs(x - SPAWN_X) <= SPAWN_PROTECT_RADIUS + 1 && Math.abs(z - SPAWN_Z) <= SPAWN_PROTECT_RADIUS + 1) ok = false;
          else if (top(x, z) !== y || base[idx(x, y, z)] !== B.GRASS || ![B.AIR, B.TALL_GRASS, B.DANDELION, B.POPPY].includes(base[idx(x, y + 1, z)] as 0)) ok = false;
        }
      if (ok) return { x: x0, z: z0, y };
    }
  throw new Error("no flat square");
}
async function tpTo(b: Bot, x: number, y: number, z: number): Promise<void> {
  const n = b.tps.length;
  b.chat(`/tp ${x} ${y} ${z}`);
  await waitFor(() => b.tps.length > n, 3000, "teleport");
  b.move(b.x, b.y, b.z);
  await sleep(1500); // chat (commands) is rate limited
}

test("a placed water source spreads for everyone, and a block in the source drains it", async () => {
  const a = new Bot();
  await a.connect(URL, { token: "water-bot-a-0123456789abcdef" });
  const b = new Bot();
  await b.connect(URL, { token: "water-bot-b-0123456789abcdef" });
  bots.push(a, b);
  const f = flat(15, 30);
  const sx = f.x + 7;
  const sz = f.z + 7;
  const y = f.y + 1;
  await tpTo(a, sx + 2.5, y, sz + 0.5);
  await tpTo(b, sx - 2.5, y, sz + 0.5);
  a.place(sx, y, sz, B.WATER);
  // On level ground it spreads one level thinner per block in every direction.
  await waitFor(() => [1, 2, 3, 4, 5].every((d) => b.block(base, sx + d, y, sz) === flowId(d) && b.block(base, sx - d, y, sz) === flowId(d) && b.block(base, sx, y, sz + d) === flowId(d) && b.block(base, sx, y, sz - d) === flowId(d)), 10000, "spread on b's screen");
  assert.equal(b.block(base, sx + 2, y, sz + 2), flowId(4), "a diamond");
  // Plug the source with a block: everything drains.
  a.place(sx, y, sz, B.COBBLESTONE);
  await waitFor(() => [1, 2, 3, 4, 5, 6, 7].every((d) => b.block(base, sx + d, y, sz) === B.AIR), 8000, "drained");
});

test("dig through a lake shore: the lake pours out; an admin rollback of the digging lets it drain back", async () => {
  const [a, b] = bots;
  // A lake shore: a land cell at sea level next to lake water, with lower land beyond it to pour into.
  let spot: { x: number; z: number; wx: number; wz: number } | null = null;
  for (let z = 30; z < WORLD_SIZE - 30 && !spot; z++)
    for (let x = 30; x < WORLD_SIZE - 30 && !spot; x++) {
      if (Math.hypot(x - SPAWN_X, z - SPAWN_Z) < 40) continue;
      if (base[idx(x, SEA_LEVEL - 1, z)] !== B.WATER) continue; // lake surface cell
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const lx = x + dx;
        const lz = z + dz;
        // the shore: solid at the water level with air above
        if (!SOLID[base[idx(lx, SEA_LEVEL - 1, lz)]] || base[idx(lx, SEA_LEVEL, lz)] !== B.AIR) continue;
        // and just beyond: solid at water level too, so the hole stays a channel
        if (!SOLID[base[idx(lx + dx, SEA_LEVEL - 1, lz + dz)]]) continue;
        if (base[idx(lx, SEA_LEVEL - 2, lz)] === B.WATER) continue;
        spot = { x: lx, z: lz, wx: x, wz: z };
        break;
      }
    }
  assert.ok(spot, "found a lake shore");
  const { x, z } = spot!;
  const dx = x - spot!.wx;
  const dz = z - spot!.wz;
  await tpTo(a, x + dx * 2 + 0.5, SEA_LEVEL + 1, z + dz * 2 + 0.5);
  // Dig the shore cell and the next two along: a channel at the lake's water level.
  for (let k = 0; k < 3; k++) {
    const cx = x + dx * k;
    const cz = z + dz * k;
    const id = a.block(base, cx, SEA_LEVEL - 1, cz);
    a.dig("start", cx, SEA_LEVEL - 1, cz);
    await sleep(Math.max(0, BREAK_TICKS[id]) * 50 + 200);
    a.dig("finish", cx, SEA_LEVEL - 1, cz);
    await sleep(300);
  }
  await waitFor(() => isWater(b.block(base, x, SEA_LEVEL - 1, z)) && isWater(b.block(base, x + dx * 2, SEA_LEVEL - 1, z + dz * 2)), 8000, "the lake pours into the channel");
  // Roll back what the digger did: the shore comes back, and the water in the channel drains away.
  const r = await fetch(`http://127.0.0.1:${PORT}/admin/rollback`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify({ player: a.name, minutes: 10 }),
  });
  const { reverted } = await r.json();
  assert.ok(reverted >= 1, `reverted ${reverted}`);
  await waitFor(() => SOLID[b.block(base, x, SEA_LEVEL - 1, z)] === 1, 4000, "shore restored");
  await waitFor(() => [1, 2].every((k) => !isWater(b.block(base, x + dx * k, SEA_LEVEL - 1, z + dz * k)) || SOLID[b.block(base, x + dx * k, SEA_LEVEL - 1, z + dz * k)] === 1), 8000, "channel dry or refilled with ground");
});
