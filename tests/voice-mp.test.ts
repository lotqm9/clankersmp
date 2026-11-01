// Proximity voice on a real server (protocol v11, update 13): the welcome says voice is on; a player's frames reach
// a player 10 blocks away intact and in order, not one 60 away, never the speaker; everyone learns who is talking and
// when they stop; a muted speaker, a listener who turned "hear voice chat" off, and a speaker whose voice is off are
// all silent; an admin can turn one player's voice off and on again (and the secret is checked); a server started
// with VOICE_OFF=1 says so and relays nothing.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { PROTOCOL_VERSION, SPAWN_X, SPAWN_Z } from "../shared/constants.ts";
import { generateWorld } from "../shared/worldgen.ts";
import { Bot, sleep, waitFor } from "./bot.ts";

const PORT = 33600 + Math.floor(Math.random() * 1500);
const ADMIN = "test-admin-secret-0123456789";
const dirs: string[] = [];
const procs: ChildProcess[] = [];
const bots: Bot[] = [];
let out = "";
const gen = generateWorld(1014);
const Y = gen.info.spawnHeight + 1;

function startServer(port: number, env: Record<string, string> = {}): Promise<ChildProcess> {
  const dir = mkdtempSync(pjoin(tmpdir(), "steve-craft-voice-"));
  dirs.push(dir);
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [process.env.SERVER_ENTRY || "server/src/main.ts"], {
      env: { ...process.env, MOBS: "0", ANIMALS: "0", PORT: String(port), WORLD_DIR: dir, ADMIN_SECRET: ADMIN, DEV_COMMANDS: "1", GAMEMODE: "creative", COIN_CA: "", VOICE_OFF: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.push(p);
    const timer = setTimeout(() => reject(new Error("server did not start")), 30000);
    p.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
      if (d.toString().includes("game server on")) {
        clearTimeout(timer);
        resolve(p);
      }
    });
    p.stderr!.on("data", (d: Buffer) => (out += d.toString()));
  });
}

async function stop(p: ChildProcess): Promise<void> {
  await new Promise<void>((resolve) => {
    if (p.exitCode !== null) return resolve();
    p.once("exit", () => resolve());
    p.kill("SIGTERM");
    setTimeout(resolve, 4000);
  });
}

before(async () => {
  await startServer(PORT);
});
after(async () => {
  if (process.env.SHOW_SERVER) console.log(out.split(/\r?\n/).slice(-40).join("\n"));
  for (const b of bots) b.close();
  for (const p of procs) await stop(p);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function join(name: string, port = PORT): Promise<Bot> {
  const b = new Bot();
  await b.connect(`ws://127.0.0.1:${port}`, { name, token: `voice-${name}-0123456789abcdef` });
  bots.push(b);
  return b;
}
async function tpTo(b: Bot, x: number, y: number, z: number): Promise<void> {
  const n = b.tps.length;
  b.chat(`/tp ${x} ${y} ${z}`);
  await waitFor(() => b.tps.length > n, 6000, "tp");
  b.move(x, y, z);
  await sleep(200);
}
/** A speaker's 40 ms frames, 25 a second, each tagged with its number. */
async function talk(b: Bot, frames: number, size = 100): Promise<void> {
  for (let k = 0; k < frames; k++) {
    const d = new Uint8Array(size).fill(k & 255);
    d[0] = 0xab;
    b.speak(d);
    await sleep(40);
  }
}

let A: Bot;
let B: Bot;
let C: Bot;

test("a voice reaches a player 10 blocks away, intact and in order; not one 60 away; never its speaker; everyone sees who is talking", async () => {
  A = await join("Talker");
  B = await join("Near");
  C = await join("Far");
  assert.equal(A.welcome!.v, PROTOCOL_VERSION);
  assert.ok(PROTOCOL_VERSION >= 11);
  assert.deepEqual(A.welcome!.voice, { on: true, adminMuted: false });
  await tpTo(A, SPAWN_X + 0.5, Y, SPAWN_Z + 30.5);
  await tpTo(B, SPAWN_X + 10.5, Y, SPAWN_Z + 30.5);
  await tpTo(C, SPAWN_X + 0.5, Y, SPAWN_Z - 29.5);
  for (const b of [A, B, C]) b.voice(true);
  await sleep(300);
  await talk(A, 25);
  await waitFor(() => B.heard(A.id).length >= 25, 4000, "B hears all of A");
  const f = B.heard(A.id);
  assert.deepEqual(f.map((x) => x.seq), Array.from({ length: 25 }, (_, k) => k), "in order");
  assert.ok(f.every((x, k) => x.data.length === 100 && x.data[0] === 0xab && x.data[1] === (k & 255) && x.codec === 1), "intact");
  assert.equal(C.heard(A.id).length, 0, "60 blocks away: nothing");
  assert.equal(A.heard(A.id).length, 0, "not your own voice");
  assert.ok(B.voiceMsgs <= 25 && B.voiceMsgs >= 10, `batched by tick (${B.voiceMsgs} messages for 25 frames)`);
  await waitFor(() => C.talkingLog.some((ids) => ids.includes(A.id)), 3000, "C (out of range) still sees that A is talking");
  await waitFor(() => C.talking.length === 0, 3000, "and that A stopped");
});

test("silence from a muted speaker, for a listener who turned voice chat off, and from a speaker whose voice is off", async () => {
  B.send({ t: "vmute", ids: [A.id] });
  await sleep(200);
  const n0 = B.heard(A.id).length;
  await talk(A, 10);
  await sleep(300);
  assert.equal(B.heard(A.id).length, n0, "muted");
  B.send({ t: "vmute", ids: [] });
  B.voice(true, false); // hear: off
  await sleep(200);
  await talk(A, 10);
  await sleep(300);
  assert.equal(B.heard(A.id).length, n0, "not listening");
  B.voice(true, true);
  A.voice(false); // A's voice off
  await sleep(200);
  await talk(A, 10);
  await sleep(300);
  assert.equal(B.heard(A.id).length, n0, "a speaker with voice off is never relayed");
  A.voice(true);
  await sleep(200);
  await talk(A, 5);
  await waitFor(() => B.heard(A.id).length === n0 + 5, 3000, "and back again");
});

test("an admin turns one player's voice off and on again (the secret is checked)", async () => {
  const http = `http://127.0.0.1:${PORT}`;
  const no = await fetch(`${http}/admin/voice-mute`, { method: "POST", headers: { authorization: "Bearer wrong-secret-0000000000", "content-type": "application/json" }, body: JSON.stringify({ name: A.name }) });
  assert.equal(no.status, 401);
  const res = await fetch(`${http}/admin/voice-mute`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ name: A.name }) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, player: A.name, muted: true });
  await waitFor(() => A.vstate.at(-1) === true, 3000, "A is told");
  assert.ok(A.notices.some((n) => /voice chat off/i.test(n)));
  const n0 = B.heard(A.id).length;
  await talk(A, 10);
  await sleep(300);
  assert.equal(B.heard(A.id).length, n0, "muted by the admin");
  const un = await fetch(`${http}/admin/voice-mute`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ name: A.name, mute: false }) });
  assert.deepEqual(await un.json(), { ok: true, player: A.name, muted: false });
  await talk(A, 5);
  await waitFor(() => B.heard(A.id).length === n0 + 5, 3000, "heard again");
  const st = await (await fetch(`${http}/status`)).json();
  assert.equal(st.voice.on, true);
  assert.equal(st.protocol, PROTOCOL_VERSION);
});

test("a server started with VOICE_OFF=1 says so and relays nothing", async () => {
  const port = PORT + 1;
  await startServer(port, { VOICE_OFF: "1" });
  const X = await join("OffA", port);
  const Z = await join("OffB", port);
  assert.deepEqual(X.welcome!.voice, { on: false, adminMuted: false });
  await tpTo(X, SPAWN_X + 0.5, Y, SPAWN_Z + 30.5);
  await tpTo(Z, SPAWN_X + 4.5, Y, SPAWN_Z + 30.5);
  X.voice(true);
  Z.voice(true);
  await sleep(200);
  await talk(X, 10);
  await sleep(400);
  assert.equal(Z.heard(X.id).length, 0);
  const st = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
  assert.equal(st.voice.on, false);
});
