// Load test (survival, v5): 50 bots on one shard for ~40 s, out in the wild around the hub. They wander at walking
// speed (10 Hz moves), place cobblestone every 3 s and mine it again with a stone pickaxe (drops, pickups), hit
// the animals around them with a sword now and then (deaths, drops), and chat. Reports server CPU, memory,
// per-client bandwidth, and the shares of animals and dropped items.
// v6: it is night, so the night mobs come for them: the bots swing at the nearest mob in reach every second,
// take hits and arrows, die and respawn; the report adds the mobs' share of the traffic and the fighting.
// v7: they farm and shoot too: every 6 s a bot clears the plant beside it, tills the grass, sows wheat and puts
// bone meal on it (the farm ticks every crop), and every 4 s it draws its bow for a second and looses an arrow the
// way it walks (player arrows: flight, hits, arrows stuck in the ground and picked up again).
// v8: every fifth bot is a sailor: out on the open sea by an island it puts a boat on the water, gets in and rows
// circles (the shared boat physics, 10 updates a second); the report adds the boats' share of the traffic.
// v9: every fifth bot (another fifth) is a trader: it goes to a villager in one of the villages (at night: at home)
// and every two seconds opens its trade window, trades (wheat for rubies, rubies for bread) and closes it again;
// the report adds the villagers' share of the traffic and the trades.
// Usage: node tests/loadtest.ts [bots] [seconds]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { SOLID, B } from "../shared/blocks.ts";
import { DEFAULT_SEED, PROTOCOL_NAME, PROTOCOL_VERSION, SPAWN_X, SPAWN_Z, WORLD_HEIGHT, idx } from "../shared/constants.ts";
import { decodePlayers, encodeMove, readBlockEntries } from "../shared/protocol.ts";
import { OP_ANIMALS, OP_ANIMALS_GONE, decodeAnimals } from "../shared/animals.ts";
import { OP_ITEMS, OP_ITEMS_GONE, OP_ITEM_PICKUP, decodeItems } from "../shared/drops.ts";
import { OP_MOBS, OP_MOBS_GONE } from "../shared/mobs.ts";
import { I } from "../shared/items.ts";
import { generateWorld } from "../shared/worldgen.ts";
import { OP_BOATS, OP_BOATS_GONE, decodeBoats, newBoat, tickBoat, type BoatBody } from "../shared/boats.ts";
import { ISLANDS, islandReach } from "../shared/islands.ts";
import { SEA_LEVEL } from "../shared/constants.ts";
import { OP_VILLAGERS, OP_VILLAGERS_GONE } from "../shared/villagers.ts";
import { OP_VOICE, encodeVoiceUp } from "../shared/voice.ts";

const N = Number(process.argv[2] ?? 50);
const SECONDS = Number(process.argv[3] ?? 40);
const PORT = 19500 + Math.floor(Math.random() * 400);
const dir = mkdtempSync(join(tmpdir(), "steve-craft-load-"));
const gen = generateWorld(DEFAULT_SEED);
const base = gen.blocks;
const edits = new Map<number, number>(); // shared view of placed/broken blocks (from BLOCKS messages)
const at = (x: number, y: number, z: number) => {
  const i = idx(x, y, z);
  return edits.has(i) ? edits.get(i)! : base[i];
};
const ground = (x: number, z: number) => {
  for (let y = WORLD_HEIGHT - 1; y > 0; y--) if (SOLID[at(x, y, z)]) return y;
  return 0;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const R0 = 72; // the bots stay in a ring outside the safe zone (v10: it reaches 68 now; it was 46)
const R1 = 108;

const server = spawn(process.execPath, [process.env.SERVER_ENTRY || "server/src/main.ts"], {
  env: { ...process.env, PORT: String(PORT), WORLD_DIR: dir, MAX_CONNECTIONS_PER_IP: "100", DEV_COMMANDS: "1", GAMEMODE: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let kicks = 0;
server.stdout!.on("data", (d: Buffer) => {
  const s = d.toString();
  if (s.includes("kicking")) kicks++;
  if (process.env.TICK_STATS) for (const l of s.split(/\r?\n/)) if (l.includes("tick avg") || l.includes("of a core")) console.log(l.trim());
});
await new Promise<void>((resolve) => server.stdout!.on("data", (d: Buffer) => d.toString().includes("game server on") && resolve()));

interface LBot {
  ws: WebSocket;
  x: number;
  y: number;
  z: number;
  dir: number;
  bytes: number;
  msgs: number;
  corrections: number;
  others: Set<number>;
  animalBytes: number;
  itemBytes: number;
  animals: Map<number, { x: number; y: number; z: number; flags: number }>;
  itemsSeen: Set<number>;
  pickups: number;
  inv: Map<number, number>; // item id -> count (from slot updates)
  slots: (number | null)[];
  sel: number;
  dig: { x: number; y: number; z: number; at: number } | null;
  // v6
  mobBytes: number;
  mobs: Map<number, { x: number; y: number; z: number; flags: number }>;
  mobsSeen: Set<number>;
  arrows: number;
  hurts: number;
  deaths: number;
  respawning: boolean;
  // v7
  farm: { x: number; y: number; z: number; at: number } | null;
  drawUntil: number;
  // v8
  id: number;
  sailor: boolean;
  boat: { id: number; body: BoatBody; turn: number } | null;
  boatsNear: Map<number, { x: number; y: number; z: number }>;
  boatsSeen: Set<number>;
  boatBytes: number;
  boatTps: number;
  // v9
  trader: boolean;
  villagers: Map<number, { x: number; y: number; z: number }>;
  villagersSeen: Set<number>;
  villagerBytes: number;
  tradeWin: number;
  tradeStep: number;
  tradeFx: number;
  tradeNo: number;
  windows: number;
  // v11
  talker: boolean;
  voiceBytes: number;
  voiceFrames: number;
  voiceSent: number;
}

const send = (b: LBot, m: Record<string, unknown>) => b.ws.readyState === 1 && b.ws.send(JSON.stringify(m));

const bots: LBot[] = [];
for (let i = 0; i < N; i++) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const b: LBot = {
    ws, x: 0, y: 0, z: 0, dir: Math.random() * Math.PI * 2, bytes: 0, msgs: 0, corrections: 0, others: new Set(), animalBytes: 0, itemBytes: 0,
    animals: new Map(), itemsSeen: new Set(), pickups: 0, inv: new Map(), slots: new Array(36).fill(null), sel: 0, dig: null,
    mobBytes: 0, mobs: new Map(), mobsSeen: new Set(), arrows: 0, hurts: 0, deaths: 0, respawning: false,
    farm: null, drawUntil: 0,
    id: 0, sailor: i % 5 === 0, boat: null, boatsNear: new Map(), boatsSeen: new Set(), boatBytes: 0, boatTps: 0,
    trader: i % 5 === 2, villagers: new Map(), villagersSeen: new Set(), villagerBytes: 0, tradeWin: 0, tradeStep: 0, tradeFx: 0, tradeNo: 0, windows: 0,
    talker: i % 5 === 4, voiceBytes: 0, voiceFrames: 0, voiceSent: 0,
  };
  await new Promise<void>((resolve) => {
    ws.on("open", () => ws.send(JSON.stringify({ t: "hello", g: PROTOCOL_NAME, v: PROTOCOL_VERSION, token: `load-${i}-${Date.now()}-abcdefgh` })));
    ws.on("message", (data: Buffer, bin: boolean) => {
      b.bytes += data.length;
      b.msgs++;
      if (!bin) {
        const m = JSON.parse(data.toString());
        if (m.t === "ride" && m.p === b.id && m.b) {
          const nb = b.boatsNear.get(m.b);
          if (nb && !b.boat) b.boat = { id: m.b, body: newBoat(nb.x, nb.y, nb.z, 0), turn: 0 };
        } else if (m.t === "boat_tp") {
          b.boatTps++;
          if (b.boat && b.boat.id === m.id) Object.assign(b.boat.body, { x: m.x, y: m.y, z: m.z, yaw: m.yaw, vx: 0, vy: 0, vz: 0 });
        } else if (m.t === "welcome") {
          b.id = m.id;
          b.x = m.you.x;
          b.y = m.you.y;
          b.z = m.you.z;
          resolve();
        } else if (m.t === "tp") {
          if (b.respawning) b.respawning = false; // back at the hub after dying: not a correction
          else b.corrections++;
          b.x = m.x;
          b.y = m.y;
          b.z = m.z;
        } else if (m.t === "arrow") {
          b.arrows++;
        } else if (m.t === "hurt") {
          b.hurts++;
        } else if (m.t === "dead") {
          b.deaths++;
          b.respawning = true;
          setTimeout(() => send(b, { t: "respawn" }), 1000);
        } else if (m.t === "slots") {
          for (const [k, w] of m.list) b.slots[k] = w ? w[0] : null;
        } else if (m.t === "open" && m.kind === "trade") {
          b.tradeWin = m.w;
          b.windows++;
        } else if (m.t === "close" && m.w === b.tradeWin) {
          b.tradeWin = 0;
        } else if (m.t === "fx" && (m.k === "trade" || m.k === "trade_no")) {
          if (m.k === "trade") b.tradeFx++;
          else b.tradeNo++;
        }
      } else if (data[0] === 17) {
        const flat = readBlockEntries(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), 5, data.readUInt32LE(1));
        for (let k = 0; k + 3 < flat.length; k += 4) edits.set(idx(flat[k], flat[k + 1], flat[k + 2]), flat[k + 3]);
      } else if (data[0] === OP_ANIMALS) {
        b.animalBytes += data.length;
        for (const a of decodeAnimals(new DataView(data.buffer, data.byteOffset, data.byteLength)).list) b.animals.set(a.id, a);
      } else if (data[0] === OP_ANIMALS_GONE) {
        b.animalBytes += data.length;
      } else if (data[0] === OP_MOBS) {
        b.mobBytes += data.length;
        for (const a of decodeAnimals(new DataView(data.buffer, data.byteOffset, data.byteLength)).list) {
          b.mobs.set(a.id, a);
          b.mobsSeen.add(a.id);
        }
      } else if (data[0] === OP_MOBS_GONE) {
        b.mobBytes += data.length;
        const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
        for (let k = 0; k < v.getUint16(1, true); k++) b.mobs.delete(v.getUint16(3 + k * 2, true));
      } else if (data[0] === OP_BOATS) {
        b.boatBytes += data.length;
        for (const bt of decodeBoats(new DataView(data.buffer, data.byteOffset, data.byteLength)).list) {
          b.boatsNear.set(bt.id, bt);
          b.boatsSeen.add(bt.id);
        }
      } else if (data[0] === OP_BOATS_GONE) {
        b.boatBytes += data.length;
      } else if (data[0] === OP_VILLAGERS) {
        b.villagerBytes += data.length;
        for (const v of decodeAnimals(new DataView(data.buffer, data.byteOffset, data.byteLength)).list) {
          b.villagers.set(v.id, v);
          b.villagersSeen.add(v.id);
        }
      } else if (data[0] === OP_VILLAGERS_GONE) {
        b.villagerBytes += data.length;
      } else if (data[0] === OP_ITEMS) {
        b.itemBytes += data.length;
        for (const it of decodeItems(new DataView(data.buffer, data.byteOffset, data.byteLength)).list) b.itemsSeen.add(it.id);
      } else if (data[0] === OP_ITEMS_GONE || data[0] === OP_ITEM_PICKUP) {
        b.itemBytes += data.length;
        if (data[0] === OP_ITEM_PICKUP) b.pickups++;
      } else if (data[0] === OP_VOICE) {
        b.voiceBytes += data.length;
        b.voiceFrames += data[1];
      } else if (data[0] === 18) {
        for (const p of decodePlayers(new DataView(data.buffer, data.byteOffset, data.byteLength)).list) b.others.add(p.id);
      }
    });
  });
  bots.push(b);
}
console.log(`${N} bots joined`);

// Out to the wild (a spot on a ring around the hub), with a stack of cobblestone, a stone pickaxe and a sword.
for (const [i, b] of bots.entries()) {
  if (b.sailor || b.trader) continue; // (they go to sea, or to the villages, below)
  const a = (i / N) * Math.PI * 2;
  const r = R0 + 6 + (i % 5) * 4;
  const x = Math.floor(SPAWN_X + Math.cos(a) * r) + 0.5;
  const z = Math.floor(SPAWN_Z + Math.sin(a) * r) + 0.5;
  send(b, { t: "chat", text: `/tp ${x} ${ground(Math.floor(x), Math.floor(z)) + 1} ${z}` });
  send(b, { t: "chat", text: "/give cobblestone 64" });
  send(b, { t: "chat", text: "/give stone_pickaxe 1" });
  send(b, { t: "chat", text: "/give wooden_sword 1" });
  for (const g of ["wooden_hoe 1", "wheat_seeds 32", "bone_meal 32", "bow 1", "arrow 64"]) send(b, { t: "chat", text: `/give ${g}` });
}
// v8: the sailors go out to sea by the islands (open water, a little way off each one's shore)
const sea = (x: number, z: number) => base[idx(x, SEA_LEVEL - 1, z)] === B.WATER && base[idx(x, SEA_LEVEL, z)] === B.AIR && ground(x, z) < SEA_LEVEL - 3;
const sailors = bots.filter((b) => b.sailor);
sailors.forEach((b, k) => {
  const isl = ISLANDS[k % 4];
  for (let t = 0; t < 64; t++) {
    const a = (k * 1.7 + t * 0.4) % (Math.PI * 2);
    const r = islandReach(isl) + 3 + (t % 4) * 3;
    const x = Math.floor(isl.x + Math.cos(a) * r);
    const z = Math.floor(isl.z + Math.sin(a) * r);
    if (x < 4 || z < 4 || x > 507 || z > 507 || !sea(x, z)) continue;
    b.x = x + 0.5;
    b.z = z + 0.5;
    b.y = SEA_LEVEL - 1;
    send(b, { t: "chat", text: `/tp ${b.x} ${b.y} ${b.z}` });
    send(b, { t: "chat", text: "/give boat 1" });
    break;
  }
});
// v9: the traders go to a villager each (at night they are at home)
const traders = bots.filter((b) => b.trader);
const villages = gen.info.villages.list;
const villagerOf = (k: number) => villages[k % villages.length].villagers[Math.floor(k / villages.length) % 5];
traders.forEach((b, k) => {
  const d = villagerOf(k);
  b.x = d.home[0] + 0.5;
  b.y = d.home[1];
  b.z = d.home[2] + 0.5;
  send(b, { t: "chat", text: `/tp ${b.x} ${b.y} ${b.z}` });
  send(b, { t: "chat", text: "/give wheat 64" });
  send(b, { t: "chat", text: "/give wheat 64" });
});
send(bots[0], { t: "chat", text: "/time 15000" }); // night: the mobs come out
await sleep(1500);
// the sailors put their boats on the water and get in
for (const b of sailors) {
  const s = b.slots.findIndex((x, k) => k < 9 && x === I.BOAT);
  if (s < 0) continue;
  b.sel = s;
  send(b, { t: "sel", s });
  b.ws.send(encodeMove({ x: b.x, y: b.y, z: b.z, yaw: 0, pitch: 0, flags: 0, held: s }));
  send(b, { t: "boat_place", x: b.x + 2, y: SEA_LEVEL - 1 + 8 / 9, z: b.z });
}
await sleep(1200);
for (const b of sailors) {
  let best = -1;
  let bd = 5;
  for (const [id, bt] of b.boatsNear) {
    const d = Math.hypot(bt.x - b.x, bt.z - b.z);
    if (d < bd) {
      bd = d;
      best = id;
    }
  }
  if (best >= 0) send(b, { t: "mount", id: best });
}
await sleep(800);
if (process.env.LOAD_DEBUG) for (const b of sailors) console.log("sailor", b.id, b.x.toFixed(1), b.z.toFixed(1), "boat slot", b.slots.findIndex((x) => x === I.BOAT), "boats near", b.boatsNear.size, "rowing", !!b.boat);
for (const b of bots) if (!b.boat) b.ws.send(encodeMove({ x: b.x, y: b.y, z: b.z, yaw: 0, pitch: 0, flags: 4, held: 0 }));
await sleep(300);
for (const b of bots) {
  b.corrections = 0; // the /tp answers above are not corrections
  b.boatTps = 0;
}
const boatGet = (x: number, y: number, z: number) => (x < 0 || z < 0 || x > 511 || z > 511 || y < 0 || y > 127 ? B.AIR : at(x, y, z));
let boatMoves = 0;
const slotOf = (b: LBot, id: number) => b.slots.findIndex((s, k) => k < 9 && s === id);

// v11: every fifth bot talks (voice on): about 20 kbps Opus-sized frames every 40 ms, 2.4 s on, 0.8 s off (the
// server never decodes them, so any bytes do); everyone hears (the default)
const talkers = bots.filter((b) => b.talker);
for (const b of talkers) send(b, { t: "voice", mic: true, hear: true, opus: true });
let voiceSeq = 0;
const voiceTimer = setInterval(() => {
  const phase = Date.now() % 3200;
  for (const [k, b] of talkers.entries()) {
    if ((phase + k * 320) % 3200 > 2400 || b.ws.readyState !== 1) continue;
    const payload = new Uint8Array(96 + (voiceSeq % 9));
    for (let j = 0; j < payload.length; j++) payload[j] = (j * 31 + voiceSeq) & 255;
    b.ws.send(new Uint8Array(encodeVoiceUp(1, voiceSeq++, payload)));
    b.voiceSent++;
  }
}, 40);
const vobytes0 = bots.reduce((s, b) => s + b.voiceBytes, 0);
const cpu0 = await serverCpu();
const t0 = Date.now();
const bytes0 = bots.reduce((s, b) => s + b.bytes, 0);
const abytes0 = bots.reduce((s, b) => s + b.animalBytes, 0);
const ibytes0 = bots.reduce((s, b) => s + b.itemBytes, 0);
const mbytes0 = bots.reduce((s, b) => s + b.mobBytes, 0);
const bbytes0 = bots.reduce((s, b) => s + b.boatBytes, 0);
const vbytes0 = bots.reduce((s, b) => s + b.villagerBytes, 0);
let ticks = 0;
let placed = 0;
let mined = 0;
let hits = 0;
let mobHits = 0;
let tills = 0;
let sows = 0;
let meals = 0;
let shots = 0;
let tradesSent = 0;
const select = (b: LBot, id: number): boolean => {
  const s = slotOf(b, id);
  if (s < 0) return false;
  if (b.sel !== s) {
    b.sel = s;
    send(b, { t: "sel", s });
  }
  return true;
};
while (Date.now() - t0 < SECONDS * 1000) {
  ticks++;
  for (const [i, b] of bots.entries()) {
    // v8: a sailor in its boat rows circles: two physics ticks per 100 ms, one update to the server
    if (b.boat) {
      const body = b.boat.body;
      b.boat.turn = (b.boat.turn + 1) % 60;
      const input = { forward: true, back: false, left: false, right: b.boat.turn < 12 };
      tickBoat(body, input, boatGet);
      tickBoat(body, input, boatGet);
      send(b, { t: "boat", id: b.boat.id, x: +body.x.toFixed(3), y: +body.y.toFixed(3), z: +body.z.toFixed(3), yaw: +body.yaw.toFixed(2), r: 6 });
      b.ws.send(encodeMove({ x: body.x, y: body.y - 0.4, z: body.z, yaw: body.yaw, pitch: 0, flags: 4, held: b.sel }));
      boatMoves++;
      continue;
    }
    if (b.sailor) continue; // (a sailor whose boat didn't make it treads water)
    // v9: a trader stands by its villager; every 2 s it opens the window, trades twice, and closes it
    if (b.trader) {
      if (ticks % 3 === 0) b.ws.send(encodeMove({ x: b.x, y: b.y, z: b.z, yaw: 0, pitch: 0, flags: 4, held: b.sel }));
      if (ticks % 20 === (i * 3) % 20) {
        const k = traders.indexOf(b);
        const d = villagerOf(k);
        const v = b.villagers.get(d.id);
        if (b.tradeWin) {
          send(b, { t: "close", w: b.tradeWin });
          b.tradeWin = 0;
        } else if (v) {
          if (Math.hypot(v.x - b.x, v.z - b.z) > 3) {
            // where it stands (a step to one side could be in a wall of its house: then every move is put back)
            b.x = v.x;
            b.y = v.y;
            b.z = v.z;
            b.respawning = true; // (the answer to our own /tp is not a correction)
            send(b, { t: "chat", text: `/tp ${b.x} ${b.y} ${b.z}` });
          }
          send(b, { t: "talk", id: d.id });
        }
      } else if (b.tradeWin && ticks % 20 === ((i * 3) % 20 + 5) % 20) {
        // wheat for a ruby (the farmers), or each job's first offer; then that ruby for its third
        send(b, { t: "trade", w: b.tradeWin, o: b.tradeStep % 2 === 0 ? 0 : 2 });
        b.tradeStep++;
        tradesSent++;
      }
      continue;
    }
    // Wander in the ring outside the hub, turning gently, at walking speed (0.43 blocks per 100 ms).
    b.dir += (Math.random() - 0.5) * 0.3;
    let nx = b.x - Math.sin(b.dir) * 0.43;
    let nz = b.z + Math.cos(b.dir) * 0.43;
    const r = Math.hypot(nx - SPAWN_X, nz - SPAWN_Z);
    if (r < R0 || r > R1) {
      b.dir = Math.atan2(-(SPAWN_X - nx), SPAWN_Z - nz) + (r < R0 ? Math.PI : 0);
      nx = b.x;
      nz = b.z;
    }
    let y = 0;
    for (const cx of [Math.floor(nx - 0.3), Math.floor(nx + 0.3)])
      for (const cz of [Math.floor(nz - 0.3), Math.floor(nz + 0.3)]) y = Math.max(y, ground(cx, cz) + 1);
    if (y - b.y > 1.2) {
      b.dir += Math.PI / 2;
      continue;
    }
    b.x = nx;
    b.z = nz;
    b.y = y;
    b.ws.send(encodeMove({ x: nx, y, z: nz, yaw: (-b.dir * 180) / Math.PI, pitch: 0, flags: 4, held: b.sel }));
    // Every 3 s: place a cobblestone next to us; a second later mine it with the pickaxe (it drops; we walk on).
    if (ticks % 30 === i % 30 && !b.drawUntil) {
      const s = slotOf(b, B.COBBLESTONE);
      if (s >= 0) {
        b.sel = s;
        send(b, { t: "sel", s });
        const px = Math.floor(nx) + 2;
        const pz = Math.floor(nz);
        const py = ground(px, pz) + 1;
        send(b, { t: "place", x: px, y: py, z: pz, id: B.COBBLESTONE });
        placed++;
        b.dig = { x: px, y: py, z: pz, at: ticks + 3 };
      }
    }
    if (b.dig && ticks === b.dig.at) {
      const s = slotOf(b, 300 + 1 * 4 + 0); // stone pickaxe
      if (s >= 0) {
        b.sel = s;
        send(b, { t: "sel", s });
        send(b, { t: "dig", a: "start", ...b.dig });
      }
    }
    if (b.dig && ticks === b.dig.at + 10) {
      send(b, { t: "dig", a: "finish", x: b.dig.x, y: b.dig.y, z: b.dig.z });
      mined++;
      b.dig = null;
    }
    if (ticks % 100 === i % 100) send(b, { t: "chat", text: `hello from bot ${i} at ${ticks}` });
    // v7: every 6 s, a little farm beside us: the plant on it picked, the grass tilled, wheat sown, bone meal
    if (ticks % 60 === (i * 7) % 60 && !b.farm && ticks >= b.drawUntil) {
      const fx = Math.floor(nx) - 2;
      const fz = Math.floor(nz) + 1;
      const fy = ground(fx, fz);
      b.farm = { x: fx, y: fy, z: fz, at: ticks };
      if (at(fx, fy + 1, fz) !== B.AIR) {
        send(b, { t: "dig", a: "start", x: fx, y: fy + 1, z: fz });
        send(b, { t: "dig", a: "finish", x: fx, y: fy + 1, z: fz });
      }
    }
    if (b.farm && ticks === b.farm.at + 2 && select(b, I.HOE0)) {
      send(b, { t: "use", x: b.farm.x, y: b.farm.y, z: b.farm.z });
      tills++;
    }
    if (b.farm && ticks === b.farm.at + 4 && select(b, I.WHEAT_SEEDS)) {
      send(b, { t: "place", x: b.farm.x, y: b.farm.y + 1, z: b.farm.z, id: B.WHEAT });
      sows++;
    }
    if (b.farm && ticks === b.farm.at + 6) {
      if (select(b, I.BONE_MEAL)) {
        send(b, { t: "use", x: b.farm.x, y: b.farm.y + 1, z: b.farm.z });
        meals++;
      }
      b.farm = null;
    }
    // v7: every 4 s, the bow drawn for a second, then loosed the way we walk
    if (ticks % 40 === (i * 3 + 20) % 40 && !b.farm && !b.dig && select(b, I.BOW)) {
      send(b, { t: "bow", a: "start" });
      b.drawUntil = ticks + 11;
    }
    if (b.drawUntil && ticks === b.drawUntil) {
      send(b, { t: "bow", a: "release" });
      shots++;
      b.drawUntil = 0;
    }
    if (b.drawUntil && ticks < b.drawUntil) continue; // no other hands while the bow is drawn
    // Every 5 s, a sword swing at the nearest animal in reach.
    if (ticks % 50 === (i + 25) % 50) {
      let best = -1;
      let bd = 4;
      for (const [id, a] of b.animals) {
        if (a.flags & 64) continue;
        const d = Math.hypot(a.x - nx, a.y - y, a.z - nz);
        if (d < bd) {
          bd = d;
          best = id;
        }
      }
      const s = slotOf(b, 300 + 0 * 4 + 3);
      if (best >= 0 && s >= 0) {
        b.sel = s;
        send(b, { t: "sel", s });
        send(b, { t: "hit", id: best });
        hits++;
      }
    }
    // Every second: a sword swing at the nearest night mob in reach (charged: once a second is slower than the
    // wooden sword's cooldown of 0.6 s).
    if (ticks % 10 === i % 10) {
      let best = -1;
      let bd = 4;
      for (const [id, m] of b.mobs) {
        if (m.flags & 64) continue;
        const d = Math.hypot(m.x - nx, m.y - y, m.z - nz);
        if (d < bd) {
          bd = d;
          best = id;
        }
      }
      const s = slotOf(b, 300 + 0 * 4 + 3);
      if (best >= 0 && s >= 0) {
        if (b.sel !== s) {
          b.sel = s;
          send(b, { t: "sel", s });
        }
        send(b, { t: "hit", id: best, mob: true });
        mobHits++;
      }
    }
  }
  await sleep(100);
}
const secs = (Date.now() - t0) / 1000;
clearInterval(voiceTimer);
const cpu1 = await serverCpu();
const bytes1 = bots.reduce((s, b) => s + b.bytes, 0);
const mem = await serverMem();
const perClient = (bytes1 - bytes0) / N / secs;
const animalPerClient = (bots.reduce((s, b) => s + b.animalBytes, 0) - abytes0) / N / secs;
const itemPerClient = (bots.reduce((s, b) => s + b.itemBytes, 0) - ibytes0) / N / secs;
const mobPerClient = (bots.reduce((s, b) => s + b.mobBytes, 0) - mbytes0) / N / secs;
const boatPerClient = (bots.reduce((s, b) => s + b.boatBytes, 0) - bbytes0) / N / secs;
const villagerPerClient = (bots.reduce((s, b) => s + b.villagerBytes, 0) - vbytes0) / N / secs;
const voicePerClient = (bots.reduce((s, b) => s + b.voiceBytes, 0) - vobytes0) / N / secs;
const voiceMax = Math.max(...bots.map((b) => b.voiceBytes)) / secs;
const seen = bots.map((b) => b.others.size);
const status = await fetch(`http://127.0.0.1:${PORT}/status`).then((r) => r.json()).catch(() => ({}));
console.log(JSON.stringify({
  bots: N,
  seconds: Math.round(secs),
  serverCpuPercent: Math.round(((cpu1 - cpu0) / secs) * 100),
  serverMemMB: mem,
  perClientKBps: +(perClient / 1024).toFixed(1),
  totalOutKBps: Math.round(((bytes1 - bytes0) / secs) / 1024),
  minOthersSeen: Math.min(...seen),
  corrections: bots.reduce((s, b) => s + b.corrections, 0),
  placesSent: placed,
  minedSent: mined,
  hitsSent: hits,
  animalKBpsPerClient: +(animalPerClient / 1024).toFixed(2),
  animalsTrackedAvg: Math.round(bots.reduce((s, b) => s + b.animals.size, 0) / N),
  itemKBpsPerClient: +(itemPerClient / 1024).toFixed(2),
  itemEntitiesSeen: new Set(bots.flatMap((b) => [...b.itemsSeen])).size,
  pickupEvents: bots.reduce((s, b) => s + b.pickups, 0),
  mobKBpsPerClient: +(mobPerClient / 1024).toFixed(2),
  mobsSeen: new Set(bots.flatMap((b) => [...b.mobsSeen])).size,
  mobsTrackedAvg: Math.round(bots.reduce((s, b) => s + b.mobs.size, 0) / N),
  mobHitsSent: mobHits,
  arrowsSeen: bots.reduce((s, b) => s + b.arrows, 0),
  tillsSent: tills,
  sowsSent: sows,
  bonemealSent: meals,
  bowShotsSent: shots,
  farmland: [...edits.values()].filter((id) => id === B.FARMLAND || id === B.FARMLAND + 1).length,
  crops: [...edits.values()].filter((id) => id >= B.WHEAT && id <= B.WHEAT + 7).length,
  sailors: sailors.length,
  sailorsRowing: sailors.filter((b) => b.boat).length,
  boatUpdatesSent: boatMoves,
  boatCorrections: bots.reduce((s, b) => s + b.boatTps, 0),
  boatsSeen: new Set(bots.flatMap((b) => [...b.boatsSeen])).size,
  boatKBpsPerClient: +(boatPerClient / 1024).toFixed(2),
  traders: traders.length,
  tradeWindows: traders.reduce((s, b) => s + b.windows, 0),
  tradesSent,
  tradeFx: traders.reduce((s, b) => s + b.tradeFx, 0),
  villagersSeen: new Set(bots.flatMap((b) => [...b.villagersSeen])).size,
  villagerKBpsPerClient: +(villagerPerClient / 1024).toFixed(2),
  talkers: talkers.length,
  voiceFramesSent: talkers.reduce((s, b) => s + b.voiceSent, 0),
  voiceFramesHeard: bots.reduce((s, b) => s + b.voiceFrames, 0),
  voiceKBpsPerClient: +(voicePerClient / 1024).toFixed(2),
  voiceKBpsMaxClient: +(voiceMax / 1024).toFixed(2),
  hurts: bots.reduce((s, b) => s + b.hurts, 0),
  deaths: bots.reduce((s, b) => s + b.deaths, 0),
  apples: bots.reduce((s, b) => s + (b.slots.filter((x) => x === I.APPLE).length > 0 ? 1 : 0), 0),
  status: { players: status.players },
  kicks,
}));
for (const b of bots) b.ws.close();
server.kill();
await sleep(500);
rmSync(dir, { recursive: true, force: true });
process.exit(0);

async function serverCpu(): Promise<number> {
  return Number(await ps(`(Get-Process -Id ${server.pid}).CPU`)) || 0;
}
async function serverMem(): Promise<number> {
  return Math.round(Number(await ps(`(Get-Process -Id ${server.pid}).WorkingSet64`)) / 1048576);
}
function ps(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn("powershell", ["-NoProfile", "-Command", cmd]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve(out.trim()));
  });
}
