// Headless multi-client test: a real server process and 4 protocol bots. The building tests run in creative mode
// (GAMEMODE=creative: any block, no items needed); survival rules are in survival-mp.test.ts.
// Covers joining, movement relay, shared place/break, chat (+filter), reach, rate limits, dig timing,
// spawn protection, speed checks, admin rollback/auth, persistence across a restart, the building blocks
// (doors, slabs, ladders, beds) with their shared rules, the charity meter message, /status, the protocol name
// and version checks. Every position is relative to spawn, so a new seed needs no edits here.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { B, BREAK_TICKS, SOLID } from "../shared/blocks.ts";
import { SafeZone } from "../shared/hub12.ts";
import { DEFAULT_SEED, PROTOCOL_NAME, PROTOCOL_VERSION, SPAWN_PROTECT_RADIUS, SPAWN_X, SPAWN_Z, WORLD_HEIGHT, idx } from "../shared/constants.ts";
import { doorId } from "../shared/shapes.ts";
import { NAME_RE } from "../shared/names.ts";
import { generateWorld } from "../shared/worldgen.ts";
import { Bot, sleep, waitFor } from "./bot.ts";

const PORT = 18000 + Math.floor(Math.random() * 2000);
const URL = `ws://127.0.0.1:${PORT}`;
const ADMIN = "test-admin-secret-0123456789";
const dir = mkdtempSync(join(tmpdir(), "steve-craft-test-"));
const gen = generateWorld(DEFAULT_SEED);
const base = gen.blocks;
let server: ChildProcess;
const bots: Bot[] = [];

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [process.env.SERVER_ENTRY || "server/src/main.ts"], {
      env: { ...process.env, MOBS: "0", PORT: String(PORT), WORLD_DIR: dir, ADMIN_SECRET: ADMIN, DEV_COMMANDS: "", COIN_CA: "", CHARITY_NAME: "", CHARITY_X: "", GAMEMODE: "creative" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => reject(new Error("server did not start")), 30000);
    p.stdout!.on("data", (d: Buffer) => {
      if (d.toString().includes("game server on")) {
        clearTimeout(timer);
        resolve(p);
      }
    });
    p.stderr!.on("data", () => {});
  });
}

function stopServer(p: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    p.once("exit", () => resolve());
    p.kill("SIGTERM");
    setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }, 3000);
  });
}

/** Top of the solid ground at a column, from the generated world plus what a bot has seen. */
function ground(bot: Bot, x: number, z: number): number {
  for (let y = WORLD_HEIGHT - 1; y > 0; y--) if (SOLID[bot.block(base, x, y, z)]) return y;
  return 0;
}

const protectedCell = (x: number, z: number) => Math.abs(x - SPAWN_X) <= SPAWN_PROTECT_RADIUS && Math.abs(z - SPAWN_Z) <= SPAWN_PROTECT_RADIUS;

const topOf = (x: number, z: number) => {
  for (let y = WORLD_HEIGHT - 1; y > 0; y--) if (SOLID[base[idx(x, y, z)]]) return y;
  return 0;
};

/** v10: the bots walk over the hub's flat ground, round its posts, boards and buildings: a way from one cell to
 *  another over cells at the same height with nothing solid over them (4 neighbours, so a 0.6-wide body walking
 *  from centre to centre never touches a neighbouring cell). Cell centres, or null. */
function flatPath(fx: number, fz: number, tx: number, tz: number): [number, number][] | null {
  const y0 = topOf(fx, fz);
  const R = 70;
  const key = (x: number, z: number) => (z - SPAWN_Z + R) * (2 * R + 1) + (x - SPAWN_X + R);
  const from = new Map<number, number>([[key(fx, fz), -1]]);
  const q: [number, number][] = [[fx, fz]];
  for (let i = 0; i < q.length; i++) {
    const [x, z] = q[i];
    if (x === tx && z === tz) {
      const out: [number, number][] = [];
      for (let k = key(x, z); k >= 0; k = from.get(k)!) out.push([(k % (2 * R + 1)) - R + SPAWN_X, Math.floor(k / (2 * R + 1)) - R + SPAWN_Z]);
      return out.reverse();
    }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const nz = z + dz;
      if (Math.abs(nx - SPAWN_X) > R || Math.abs(nz - SPAWN_Z) > R || from.has(key(nx, nz)) || topOf(nx, nz) !== y0) continue;
      from.set(key(nx, nz), key(x, z));
      q.push([nx, nz]);
    }
  }
  return null;
}

/** A w x d patch of level grass outside spawn protection, open above, that the bots can walk to from the spawn
 *  point (v10: the arrival courtyard), the nearest such walk first. */
function findPatch(w: number, d: number): { x: number; z: number; y: number } {
  const sp = gen.info.spawn;
  const sx = Math.floor(sp.x);
  const sz = Math.floor(sp.z);
  const cands: [number, number][] = [];
  for (let dz = -44; dz <= 44; dz++) for (let dx = -44; dx <= 44; dx++) cands.push([SPAWN_X + dx, SPAWN_Z + dz]);
  cands.sort((a, b) => Math.abs(a[0] - sx) + Math.abs(a[1] - sz) - (Math.abs(b[0] - sx) + Math.abs(b[1] - sz)));
  for (const [ox, oz] of cands) {
    if (Math.hypot(ox + w - SPAWN_X, oz + d - SPAWN_Z) > 44 || Math.hypot(ox - SPAWN_X, oz - SPAWN_Z) > 44) continue;
    const y = topOf(ox, oz);
    let ok = y === topOf(sx, sz);
    for (let x = ox; ok && x < ox + w; x++)
      for (let z = oz; ok && z < oz + d; z++) {
        if (topOf(x, z) !== y || base[idx(x, y, z)] !== B.GRASS || protectedCell(x, z)) ok = false;
        for (let yy = y + 1; ok && yy < y + 4; yy++) if (base[idx(x, yy, z)] !== B.AIR && base[idx(x, yy, z)] !== B.TALL_GRASS) ok = false; // (no flower bed)
      }
    if (ok && flatPath(sx, sz, ox + 2, oz + 1)) return { x: ox, z: oz, y };
  }
  throw new Error("no flat patch near spawn");
}

const P = findPatch(8, 6); // the patch every test builds on

/** Walk to (tx, tz) at walking speed: over the flat ground round anything in the way (flatPath), then straight. */
async function walk(bot: Bot, tx: number, tz: number): Promise<void> {
  const path = flatPath(Math.floor(bot.x), Math.floor(bot.z), Math.floor(tx), Math.floor(tz)) ?? [];
  // only the turns (a straight run is one leg)
  const legs: [number, number][] = [];
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    const a = path[i - 1];
    const b = path[i + 1];
    if (i === 0 || !b || a[0] - p[0] !== p[0] - b[0] || a[1] - p[1] !== p[1] - b[1]) legs.push([p[0] + 0.5, p[1] + 0.5]);
  }
  for (const [x, z] of legs.slice(0, -1)) await walkStraight(bot, x, z);
  await walkStraight(bot, tx, tz);
}

/** Walk in a straight line at walking speed (0.43 blocks per 100 ms), sending 10 Hz moves. */
async function walkStraight(bot: Bot, tx: number, tz: number): Promise<void> {
  for (let n = 0; ; n++) {
    if (n > 1500) throw new Error(`${bot.name} never got to ${tx}, ${tz} (stuck at ${bot.x.toFixed(1)}, ${bot.z.toFixed(1)})`);
    const dx = tx - bot.x;
    const dz = tz - bot.z;
    const d = Math.hypot(dx, dz);
    const step = Math.min(0.43, d);
    const nx = d > 0 ? bot.x + (dx / d) * step : bot.x;
    const nz = d > 0 ? bot.z + (dz / d) * step : bot.z;
    // Stand on the highest column the 0.6-wide box overlaps.
    let y = 0;
    for (const cx of [Math.floor(nx - 0.3), Math.floor(nx + 0.3)])
      for (const cz of [Math.floor(nz - 0.3), Math.floor(nz + 0.3)]) y = Math.max(y, ground(bot, cx, cz) + 1);
    bot.move(nx, y, nz, (Math.atan2(-dx, dz) * 180) / Math.PI);
    await sleep(100);
    if (d <= 0.43) break;
  }
}

before(async () => {
  server = await startServer();
});

after(async () => {
  for (const b of bots) b.close();
  if (server) await stopServer(server);
  rmSync(dir, { recursive: true, force: true });
});

test("4 bots join one shard with unique random names and see each other", async () => {
  for (let i = 0; i < 4; i++) {
    const b = new Bot();
    await b.connect(URL, { token: `bot-token-${i}-0123456789abcdef` });
    bots.push(b);
  }
  const names = bots.map((b) => b.name);
  assert.equal(new Set(names).size, 4);
  for (const n of names) assert.match(n, NAME_RE);
  assert.ok(names.every((n) => /^[A-Z][a-z]+[A-Z][a-z]+_\d{4}$/.test(n)), names.join(","));
  assert.ok(bots.every((b) => b.shard === 1));
  assert.equal(bots[0].welcome!.g, PROTOCOL_NAME);
  await waitFor(() => bots.every((b) => b.known.size === 3), 3000, "everyone knows everyone");
  await waitFor(() => bots[0].chats.some((c) => c.kind === "join"), 3000, "join lines");
});

test("movement is relayed to the others", async () => {
  const targets = [
    [P.x + 1.5, P.z + 1.5],
    [P.x + 2.5, P.z + 3.5],
    [P.x + 2.5, P.z + 0.5],
    [P.x + 4.5, P.z + 1.5],
  ];
  await Promise.all(bots.map((b, i) => walk(b, targets[i][0], targets[i][1])));
  await sleep(400);
  for (const b of bots) {
    for (const o of bots) {
      if (o === b) continue;
      const s = b.players.get(o.id);
      assert.ok(s, `${b.name} has a position for ${o.name}`);
      assert.ok(Math.abs(s!.x - o.x) < 0.05 && Math.abs(s!.z - o.z) < 0.05, `${b.name} sees ${o.name} at ${s!.x},${s!.z} vs ${o.x},${o.z}`);
    }
  }
  assert.equal(bots.reduce((n, b) => n + b.tps.length, 0), 0, "no movement corrections for legit walking");
});

test("a place and a break are shared with every client", async () => {
  const a = bots[0];
  const x = P.x + 1;
  const z = P.z + 3;
  const y = ground(a, x, z) + 1;
  a.place(x, y, z, B.BRICKS);
  await waitFor(() => bots.every((b) => b.block(base, x, y, z) === B.BRICKS), 3000, "brick everywhere");
  // Bot 1 digs it with the right timing (bricks: 30 ticks).
  const d = bots[1];
  d.dig("start", x, y, z);
  await sleep(30 * 50 + 150);
  d.dig("finish", x, y, z);
  await waitFor(() => bots.every((b) => b.block(base, x, y, z) === B.AIR), 3000, "air everywhere");
});

test("chat reaches everyone and profanity is masked", async () => {
  bots[2].chat("hello builders!");
  await waitFor(() => bots.every((b) => b.chats.some((c) => c.from === bots[2].name && c.text === "hello builders!")), 3000, "chat");
  bots[3].chat("what the fuck");
  await waitFor(() => bots.every((b) => b.chats.some((c) => c.from === bots[3].name && c.text.startsWith("what the"))), 3000, "chat 2");
  const seen = bots[0].chats.find((c) => c.from === bots[3].name)!;
  assert.equal(seen.text, "what the ****");
});

test("reach check rejects edits more than 5 blocks away", async () => {
  const a = bots[0];
  const x = Math.floor(a.x) + 10;
  const z = Math.floor(a.z);
  const y = ground(a, x, z) + 1;
  a.place(x, y, z, B.STONE);
  await sleep(500);
  assert.equal(bots[1].block(base, x, y, z), base[idx(x, y, z)], "others never see the far block");
  assert.equal(a.block(base, x, y, z), base[idx(x, y, z)], "sender is corrected back");
});

test("place rate limit caps a burst", async () => {
  const p = bots[3];
  const cells: [number, number, number][] = [];
  for (let dx = -2; dx <= 2; dx++)
    for (let dz = -3; dz <= 3; dz++) {
      if (Math.abs(dx) < 1 && Math.abs(dz) < 1) continue;
      const x = Math.floor(p.x) + dx;
      const z = Math.floor(p.z) + dz;
      if (protectedCell(x, z)) continue;
      cells.push([x, ground(p, x, z) + 1, z]);
    }
  const burst = cells.slice(0, 30);
  assert.ok(burst.length >= 20, `enough cells (${burst.length})`);
  for (const [x, y, z] of burst) p.place(x, y, z, B.WOOL_LIME);
  await sleep(800);
  const placed = burst.filter(([x, y, z]) => bots[0].block(base, x, y, z) === B.WOOL_LIME).length;
  assert.ok(placed >= 8 && placed <= 14, `placed ${placed} of ${burst.length} in a burst`);
});

test("chat rate limit: 5 messages every 5 seconds, a grey 'slow down' note, no repeats", async () => {
  const c = bots[1];
  const before = bots[0].chats.filter((m) => m.from === c.name).length;
  const notes = c.notices.length;
  for (let i = 0; i < 10; i++) c.chat(`spam ${i}`);
  await sleep(800);
  const got = bots[0].chats.filter((m) => m.from === c.name).length - before;
  assert.ok(got >= 5 && got <= 6, `delivered ${got} of 10`);
  assert.ok(c.notices.slice(notes).some((n) => /slow down/i.test(n)), "told to slow down");
  assert.equal(c.notices.slice(notes).length, 1, "one note, not one per dropped message");
  await sleep(2200);
  c.chat("same thing");
  await sleep(300);
  c.chat("same thing");
  await sleep(500);
  assert.equal(bots[0].chats.filter((m) => m.from === c.name && m.text === "same thing").length, 1, "a repeat is held back");
  assert.ok(c.notices.some((n) => /you just said that/i.test(n)));
});

test("commands have their own generous limit: 10 at once, then about 10 a second", async () => {
  const c = bots[2];
  await sleep(1200);
  const listAnswers = () => c.notices.filter((n) => / online: /.test(n)).length;
  const n0 = listAnswers();
  for (let i = 0; i < 10; i++) c.chat("/list");
  await waitFor(() => listAnswers() === n0 + 10, 3000, "10 commands in a burst all answered");
  await sleep(1100);
  const n1 = listAnswers();
  const notes = c.notices.length;
  for (let i = 0; i < 40; i++) c.chat("/list");
  await sleep(800);
  const answered = listAnswers() - n1;
  assert.ok(answered >= 10 && answered <= 20, `${answered} of 40 answered`);
  assert.ok(c.notices.slice(notes).some((n) => /slow down/i.test(n)), "told to slow down");
  // chat is unaffected by the commands
  const before = bots[0].chats.filter((m) => m.from === c.name).length;
  c.chat("still here");
  await waitFor(() => bots[0].chats.filter((m) => m.from === c.name).length === before + 1, 3000, "chat still works");
});

// Dig timing (too fast, never started) is a survival rule now: see survival-mp.test.ts.

test("spawn is a safe zone: a survival player can't break it (creative admins can build)", async () => {
  const s = new Bot();
  await s.connect(URL, { token: "spawn-bot-token-0123456789abcd" });
  bots.push(s);
  // the admin API switches this player to survival
  const res = await fetch(`http://127.0.0.1:${PORT}/admin/gamemode`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify({ player: s.name, mode: "survival" }),
  });
  assert.equal(res.status, 200);
  await waitFor(() => s.gm === "survival", 2000, "survival mode");
  // A block in reach of where the bot spawned (v10: the arrival courtyard), well inside the safe zone.
  const x = Math.floor(s.x) + 1;
  const z = Math.floor(s.z) - 2;
  assert.ok(new SafeZone().contains(x + 0.5, z + 0.5) && Math.hypot(x - SPAWN_X, z - SPAWN_Z) < 50);
  const y = ground(s, x, z);
  s.dig("start", x, y, z);
  await sleep(100);
  s.dig("finish", x, y, z);
  await sleep(500);
  assert.equal(bots[0].block(base, x, y, z), base[idx(x, y, z)]);
  assert.ok(s.notices.some((n) => /safe zone/i.test(n)));
});

test("speed and teleport checks send a correction", async () => {
  const b = bots[1];
  const tps = b.tps.length;
  const x0 = b.x;
  b.move(b.x + 30, b.y, b.z);
  await waitFor(() => b.tps.length > tps, 2000, "tp correction");
  const t = b.tps[b.tps.length - 1];
  assert.ok(t.x < x0 + 2, `pulled back to ${t.x}`);
});

test("admin API: auth, then roll back one player's edits", async () => {
  const http = `http://127.0.0.1:${PORT}`;
  const no = await fetch(`${http}/admin/players`, { headers: { authorization: "Bearer wrong-secret-0000000000" } });
  assert.equal(no.status, 401);
  const who = await fetch(`${http}/admin/players`, { headers: { authorization: `Bearer ${ADMIN}` } });
  assert.equal(who.status, 200);
  const list = await who.json();
  const editor = list.shards[0].editors.find((e: { name: string }) => e.name === bots[3].name);
  assert.ok(editor && editor.edits >= 8, "the lime-wool bot is listed as an editor");
  const limeBefore = [...bots[0].edits.values()].filter((v) => v === B.WOOL_LIME).length;
  assert.ok(limeBefore > 0);
  const chat = await (await fetch(`${http}/admin/chat?lines=50`, { headers: { authorization: `Bearer ${ADMIN}` } })).json();
  assert.ok(chat.lines.some((l: string) => l.includes("hello builders!")), "admin can read recent chat");
  const r = await fetch(`${http}/admin/rollback`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify({ shard: 1, player: bots[3].name, minutes: 30 }),
  });
  assert.equal(r.status, 200);
  const { reverted } = await r.json();
  assert.equal(reverted, limeBefore);
  await waitFor(() => [...bots[0].edits.values()].every((v) => v !== B.WOOL_LIME), 3000, "rollback broadcast");
});

test("/status: players online and this week, the charity meter, the game name", async () => {
  const s = await (await fetch(`http://127.0.0.1:${PORT}/status`)).json();
  assert.equal(s.game, PROTOCOL_NAME);
  assert.equal(s.protocol, PROTOCOL_VERSION);
  assert.equal(s.players, bots.length);
  assert.ok(s.week.players >= bots.length, `week ${s.week.players}`);
  assert.equal(s.charity.state, "prelaunch");
  assert.equal(s.charity.mint, null);
});

test("builds survive a server restart", async () => {
  const a = bots[0];
  const x = P.x + 3;
  const z = P.z + 4;
  const y = ground(a, x, z) + 1;
  a.place(x, y, z, B.WOOL_YELLOW);
  await waitFor(() => bots[1].block(base, x, y, z) === B.WOOL_YELLOW, 3000, "yellow placed");
  // A graceful stop saves (SIGTERM on Linux); Windows test runs cannot deliver SIGTERM, so ask for the save.
  await fetch(`http://127.0.0.1:${PORT}/admin/save`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}` } });
  for (const b of bots) b.close();
  bots.length = 0;
  await stopServer(server);
  server = await startServer();
  const n = new Bot();
  await n.connect(URL, { token: "after-restart-token-0123456789" });
  bots.push(n);
  assert.equal(n.block(base, x, y, z), B.WOOL_YELLOW);
  // The weekly player count survived too (stats.json on the volume).
  const s = await (await fetch(`http://127.0.0.1:${PORT}/status`)).json();
  assert.ok(s.week.players >= 5, `week after restart ${s.week.players}`);
});

test("building blocks: doors open for everyone, two-block structures, slab merge, bad states refused", async () => {
  const a = new Bot();
  await a.connect(URL, { token: "builder-a-token-0123456789abc" });
  const b = new Bot();
  await b.connect(URL, { token: "builder-b-token-0123456789abc" });
  bots.push(a, b);
  // The charity meter arrives on join; with no COIN_CA set it "starts at launch".
  await waitFor(() => a.charity !== null, 3000, "charity message");
  assert.deepEqual(a.charity, { state: "prelaunch" });
  const ox = P.x + 1;
  const oz = P.z + 1;
  await Promise.all([walk(a, ox + 1.5, oz + 1.5), walk(b, ox + 3.5, oz + 1.5)]);
  const y = P.y + 1;

  // Door: the bottom half brings its top half; the other player opens it and both halves swing.
  const closed = doorId(1, false, false);
  a.place(ox, y, oz, closed);
  await waitFor(() => b.block(base, ox, y, oz) === closed && b.block(base, ox, y + 1, oz) === closed + 8, 3000, "door, both halves");
  b.use(ox, y + 1, oz);
  await waitFor(() => a.block(base, ox, y, oz) === doorId(1, true, false) && a.block(base, ox, y + 1, oz) === doorId(1, true, true), 3000, "door opened");

  // Slab on the matching slab completes a full block; a ladder then hangs on it.
  a.place(ox + 2, y, oz, B.OAK_SLAB);
  await waitFor(() => b.block(base, ox + 2, y, oz) === B.OAK_SLAB, 3000, "slab");
  a.place(ox + 2, y, oz, B.OAK_SLAB + 1);
  await waitFor(() => b.block(base, ox + 2, y, oz) === B.OAK_PLANKS, 3000, "double slab");
  a.place(ox + 3, y, oz, B.LADDER + 1);
  await waitFor(() => b.block(base, ox + 3, y, oz) === B.LADDER + 1, 3000, "ladder on the planks");

  // Bad states are refused and corrected: a ladder with no wall behind it, a lone top half of a door.
  a.place(ox + 3, y, oz + 2, B.LADDER + 1);
  a.place(ox + 4, y, oz + 2, doorId(1, false, true));
  await sleep(500);
  assert.equal(b.block(base, ox + 3, y, oz + 2), B.AIR, "no floating ladder");
  assert.equal(b.block(base, ox + 4, y, oz + 2), B.AIR, "no half door");

  // Bed: foot + head; breaking the head takes the foot too.
  b.place(ox, y, oz + 2, B.RED_BED + 1);
  await waitFor(() => a.block(base, ox, y, oz + 2) === B.RED_BED + 1 && a.block(base, ox + 1, y, oz + 2) === B.RED_BED + 5, 3000, "bed, both parts");
  b.dig("start", ox + 1, y, oz + 2);
  await sleep(BREAK_TICKS[B.RED_BED] * 50 + 150);
  b.dig("finish", ox + 1, y, oz + 2);
  await waitFor(() => a.block(base, ox, y, oz + 2) === B.AIR && a.block(base, ox + 1, y, oz + 2) === B.AIR, 3000, "bed gone");

  // Digging out the ground under the door pops the whole door.
  b.dig("start", ox, y - 1, oz);
  await sleep(BREAK_TICKS[B.GRASS] * 50 + 150);
  b.dig("finish", ox, y - 1, oz);
  await waitFor(() => a.block(base, ox, y, oz) === B.AIR && a.block(base, ox, y + 1, oz) === B.AIR, 3000, "door popped");
});

function helloKick(hello: Record<string, unknown>): Promise<{ t: string; reason: string; server?: number; g?: string }> {
  const ws = new WebSocket(URL);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no kick")), 5000);
    ws.on("open", () => ws.send(JSON.stringify(hello)));
    ws.on("message", (d: Buffer) => {
      clearTimeout(timer);
      ws.close();
      resolve(JSON.parse(d.toString()));
    });
  });
}

test("an old client is told the server's version", async () => {
  const kick = await helloKick({ t: "hello", g: PROTOCOL_NAME, v: PROTOCOL_VERSION - 1, name: "Old", token: "old-client-token-0123456789" });
  assert.equal(kick.t, "kick");
  assert.equal(kick.server, PROTOCOL_VERSION);
});

test("the old $STEVE Craft builder page (protocol 4, no protocol name) is told the game was updated: it reloads", async () => {
  // exactly what sites/steve-game's client sends, and what it reads: a kick whose reason says "updated" and whose
  // server version is above its own 4 makes it reload the page once (then "Please refresh the page")
  const kick = await helloKick({ t: "hello", v: 4, name: "OldSteve_1234", token: "old-steve-token-0123456789" });
  assert.equal(kick.t, "kick");
  assert.match(kick.reason, /updated/i);
  assert.ok(typeof kick.server === "number" && kick.server > 4, `server version ${kick.server}`);
});

test("a client of another game (another protocol name) is refused", async () => {
  const kick = await helloKick({ t: "hello", g: "othergame", v: PROTOCOL_VERSION, name: "Other", token: "other-game-token-0123456789" });
  assert.equal(kick.t, "kick");
  assert.equal(kick.g, PROTOCOL_NAME);
  assert.match(kick.reason, /\$STEVE Craft/);
});

test("the generated world has the spawn landmark: the figure punching a tree, and the plaque", () => {
  const { board, spawnHeight } = gen.info;
  assert.equal(board.x1 - board.x0 + 1, 9);
  const lm = gen.info.hub.landmark!;
  assert.ok(lm);
  assert.equal(lm.figure.y0, spawnHeight + 2);
  let teal = 0;
  let blue = 0;
  for (let y = lm.figure.y0; y <= lm.figure.top; y++)
    for (let z = lm.figure.z - 8; z <= lm.figure.z + 7; z++)
      for (let x = lm.figure.x - 4; x <= lm.figure.x + 9; x++) {
        if (base[idx(x, y, z)] === B.SMOOTH_TEAL) teal++;
        if (base[idx(x, y, z)] === B.SMOOTH_BLUE) blue++;
      }
  assert.ok(teal > 300, `a teal shirt (${teal})`);
  assert.ok(blue > 250, `blue trousers (${blue})`);
  assert.equal(base[idx(lm.tree.x, lm.figure.y0 + 21, lm.figure.z + 5)], B.OAK_LOG, "the fist meets the tree");
});

test("crouching players are 1.5 tall on the server: under a 1.5-high gap only while crouched", async () => {
  const c = new Bot();
  await c.connect(URL, { token: "crouch-c-token-0123456789abcd" });
  bots.push(c);
  const cx = P.x + 6;
  const cz = P.z + 4;
  const y = P.y + 1;
  await walk(c, cx - 1.5, cz + 0.5);
  // A post beside the path to hang a top slab on (its box is y+1.5 .. y+2): a 1.5-high gap over the path.
  c.place(cx, y, cz + 1, B.STONE);
  await sleep(150);
  c.place(cx, y + 1, cz + 1, B.STONE);
  await sleep(150);
  c.place(cx, y + 1, cz, B.STONE_SLAB + 1);
  await waitFor(() => c.block(base, cx, y + 1, cz) === B.STONE_SLAB + 1, 3000, "top slab");
  const tps = c.tps.length;
  for (const x of [cx - 1, cx - 0.5, cx, cx + 0.5]) {
    c.move(x + 0.5, y, cz + 0.5, -90, 0, 4 | 1); // GROUND | SNEAK
    await sleep(110);
  }
  await sleep(300);
  assert.equal(c.tps.length, tps, "crouched under the gap: no correction");
  c.move(cx + 1, y, cz + 0.5, -90, 0, 4); // standing up under the slab
  await waitFor(() => c.tps.length > tps, 2000, "standing inside the slab is corrected");
});
