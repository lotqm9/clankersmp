// The worst case for proximity voice (update 13): 50 players crowded on the plaza (everyone in range of everyone),
// 10 of them talking at once without a pause (Opus-sized frames, ~20 kbps, every 40 ms). Every listener then gets the
// closest 8 voices (the cap). Reports the server's CPU and memory, its tick, and the voice KB/s per client.
// Usage: SERVER_ENTRY=server/dist/server.mjs node tests/voice-stress.ts [bots=50] [talkers=10] [seconds=30]

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { PROTOCOL_NAME, PROTOCOL_VERSION, SPAWN_X, SPAWN_Z } from "../shared/constants.ts";
import { encodeMove } from "../shared/protocol.ts";
import { OP_VOICE, VOICE_MAX_STREAMS, encodeVoiceUp } from "../shared/voice.ts";
import { generateWorld } from "../shared/worldgen.ts";

const N = Number(process.argv[2] ?? 50);
const T = Number(process.argv[3] ?? 10);
const SECONDS = Number(process.argv[4] ?? 30);
const PORT = 34800 + Math.floor(Math.random() * 1000);
const dir = mkdtempSync(join(tmpdir(), "steve-craft-voice-stress-"));
const sh = generateWorld(1014).info.spawnHeight;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, [process.env.SERVER_ENTRY || "server/src/main.ts"], {
  env: { ...process.env, PORT: String(PORT), WORLD_DIR: dir, MAX_CONNECTIONS_PER_IP: "100", DEV_COMMANDS: "1", GAMEMODE: "creative", MOBS: "0", TICK_STATS: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout!.on("data", (d: Buffer) => {
  log += d.toString();
  if (process.env.SHOW_SERVER) process.stdout.write(d);
});
await new Promise<void>((resolve) => server.stdout!.on("data", (d: Buffer) => d.toString().includes("game server on") && resolve()));

interface Bot {
  ws: WebSocket;
  id: number;
  bytes: number;
  voiceBytes: number;
  voiceFrames: number;
  speakers: Set<number>;
  x: number;
  z: number;
}
const bots: Bot[] = [];
for (let i = 0; i < N; i++) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const b: Bot = { ws, id: 0, bytes: 0, voiceBytes: 0, voiceFrames: 0, speakers: new Set(), x: 0, z: 0 };
  await new Promise<void>((resolve) => {
    ws.on("open", () => ws.send(JSON.stringify({ t: "hello", g: PROTOCOL_NAME, v: PROTOCOL_VERSION, token: `vstress-${i}-${Date.now()}-abcdefgh` })));
    ws.on("message", (data: Buffer, bin: boolean) => {
      b.bytes += data.length;
      if (!bin) {
        const m = JSON.parse(data.toString());
        if (m.t === "welcome") {
          b.id = m.id;
          resolve();
        }
        return;
      }
      if (data[0] === OP_VOICE) {
        b.voiceBytes += data.length;
        let o = 2;
        for (let k = 0; k < data[1]; k++) {
          b.speakers.add(data.readUInt16LE(o));
          b.voiceFrames++;
          o += 7 + data.readUInt16LE(o + 5);
        }
      }
    });
  });
  bots.push(b);
}
// everyone on the plaza, within 12 blocks of its centre
for (const [i, b] of bots.entries()) {
  b.x = SPAWN_X - 10 + (i % 8) * 3 + 0.5;
  b.z = SPAWN_Z + 11 + Math.floor(i / 8) * 2 + 0.5;
  b.ws.send(JSON.stringify({ t: "chat", text: `/tp ${b.x} ${sh + 1} ${b.z}` }));
}
await sleep(1500);
for (const b of bots) b.ws.send(encodeMove({ x: b.x, y: sh + 1, z: b.z, yaw: 0, pitch: 0, flags: 4, held: 0 }));
const talkers = bots.slice(0, T);
for (const b of talkers) b.ws.send(JSON.stringify({ t: "voice", mic: true, hear: true, opus: true }));
await sleep(500);
const ps = (cmd: string) =>
  new Promise<string>((resolve) => {
    const p = spawn("powershell", ["-NoProfile", "-Command", cmd]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve(out.trim()));
  });
const cpu = async () => Number(await ps(`(Get-Process -Id ${server.pid}).CPU`)) || 0;
const mem = async () => Math.round(Number(await ps(`(Get-Process -Id ${server.pid}).WorkingSet64`)) / 1048576);

let seq = 0;
let sent = 0;
const b0 = bots.map((b) => [b.bytes, b.voiceBytes, b.voiceFrames]);
const c0 = await cpu();
const t0 = Date.now();
const timer = setInterval(() => {
  for (const b of talkers) {
    const payload = new Uint8Array(100 + (seq % 5));
    for (let j = 0; j < payload.length; j++) payload[j] = (j * 7 + seq) & 255;
    b.ws.send(new Uint8Array(encodeVoiceUp(1, seq++, payload)));
    sent++;
  }
}, 40);
// keep them "moving" in place (10 Hz moves, like real clients)
const mover = setInterval(() => {
  for (const b of bots) b.ws.send(encodeMove({ x: b.x, y: sh + 1, z: b.z, yaw: 0, pitch: 0, flags: 4, held: 0 }));
}, 100);
await sleep(SECONDS * 1000);
clearInterval(timer);
clearInterval(mover);
const secs = (Date.now() - t0) / 1000;
const c1 = await cpu();
const m = await mem();
const per = bots.map((b, k) => ({ all: (b.bytes - b0[k][0]) / secs / 1024, voice: (b.voiceBytes - b0[k][1]) / secs / 1024, frames: (b.voiceFrames - b0[k][2]) / secs, speakers: b.speakers.size }));
const listeners = per.slice(T);
const avg = (f: (p: (typeof per)[0]) => number, l = per) => l.reduce((s, p) => s + f(p), 0) / l.length;
const ticks = [...log.matchAll(/tick avg ([\d.]+) ms/g)].map((x) => Number(x[1]));
const voiceMs = [...log.matchAll(/voice ([\d.]+)/g)].map((x) => Number(x[1]));
console.log(
  JSON.stringify({
    bots: N,
    talkers: T,
    seconds: Math.round(secs),
    serverCpuPercent: Math.round(((c1 - c0) / secs) * 100),
    serverMemMB: m,
    tickMs: ticks.slice(-3),
    voiceTickMs: voiceMs.slice(-3),
    framesSentPerSec: Math.round(sent / secs),
    perClientKBps: +avg((p) => p.all).toFixed(1),
    voiceKBpsPerListener: +avg((p) => p.voice, listeners).toFixed(1),
    voiceKBpsMax: +Math.max(...per.map((p) => p.voice)).toFixed(1),
    voicesPerListener: +avg((p) => p.frames / 25, listeners).toFixed(1),
    cap: VOICE_MAX_STREAMS,
  }),
);
for (const b of bots) b.ws.close();
server.kill("SIGTERM");
await sleep(1000);
rmSync(dir, { recursive: true, force: true });
process.exit(0);
