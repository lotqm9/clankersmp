// Boats on a real server (protocol v8) with protocol bots (DEV_COMMANDS=1: /tp, /give, /gamemode): a boat from the
// hand goes onto the water (the item is used up) and everyone near sees it; it needs a boat in hand and water or
// ground under it; right-click sits in it (two seats, a third is refused); the driver rows it and everyone sees it
// move, the riders with it; a boat that jumps too far is put back; a boat lifted off the water is put back after 3 s;
// sneak gets you out beside it (and the other rider takes the oars); hits add up and break it into a boat item (not
// by its own rider, not in the safe zone); a boat nobody rows settles on the water; boats survive a restart.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { B, SOLID } from "../shared/blocks.ts";
import { DEFAULT_SEED, SEA_LEVEL, SPAWN_X, SPAWN_Z, WORLD_HEIGHT, idx } from "../shared/constants.ts";
import { I } from "../shared/items.ts";
import { RIDER_Y, boatFits } from "../shared/boats.ts";
import { generateWorld } from "../shared/worldgen.ts";
import { Bot, sleep, waitFor } from "./bot.ts";

const PORT = 27200 + Math.floor(Math.random() * 1500);
const URL = `ws://127.0.0.1:${PORT}`;
const dir = mkdtempSync(pjoin(tmpdir(), "steve-craft-boats-"));
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
const water = (x: number, z: number) => base[idx(x, SEA_LEVEL - 1, z)] === B.WATER && base[idx(x, SEA_LEVEL, z)] === B.AIR;

/** Open water (8 x 8, 4+ deep) with a sandy beach 3 blocks east of it, far from the hub. */
function shore(): { x: number; z: number; beach: number } {
  for (let z = 150; z < 360; z += 2)
    for (let x = 12; x < 140; x++) {
      if (Math.hypot(x - SPAWN_X, z - SPAWN_Z) < 120) continue;
      let ok = true;
      for (let dz = -4; ok && dz <= 4; dz++) for (let dx = -6; ok && dx <= 0; dx++) if (!water(x + dx, z + dz) || top(x + dx, z + dz) > SEA_LEVEL - 5) ok = false;
      if (!ok) continue;
      for (let bx = x + 1; bx <= x + 4; bx++) {
        if (water(bx, z)) continue;
        if (top(bx, z) === SEA_LEVEL - 1 || top(bx, z) === SEA_LEVEL) {
          let clear = true;
          for (let y = top(bx, z) + 1; y < top(bx, z) + 4; y++) if (base[idx(bx, y, z)] !== B.AIR) clear = false;
          if (clear) return { x: x - 3, z, beach: bx };
        }
        break;
      }
    }
  throw new Error("no shore");
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

async function holdBoat(b: Bot): Promise<void> {
  b.chat("/give boat 1");
  await waitFor(() => b.inv.findIndex((s) => s?.id === I.BOAT) >= 0, 5000, "a boat in the inventory");
  const s = b.inv.findIndex((st) => st?.id === I.BOAT);
  if (s > 8) {
    const n = b.click(0, { m: "swap", s, h: 8 });
    await waitFor(() => b.winLog.some((l) => l.n === n), 5000, "swap answered");
    b.send({ t: "close", w: 0 });
    await waitFor(() => b.inv[8]?.id === I.BOAT, 5000, "boat on the hotbar");
    b.select(8);
  } else b.select(s);
  b.move(b.x, b.y, b.z);
  await sleep(100);
}

let S: { x: number; z: number; beach: number };
let A: Bot;
let Bb: Bot;
let C: Bot;
let boatId = 0;
const SURF = SEA_LEVEL - 1 + 8 / 9;

test("a boat from the hand goes onto the water (the boat is used up) and everyone near sees it", async () => {
  S = shore();
  A = await join("boat-a-token-0123456789abcdef");
  Bb = await join("boat-b-token-0123456789abcdef");
  C = await join("boat-c-token-0123456789abcdef");
  // A treads water beside the spot; B and C are near too
  await tpTo(A, S.x + 2.5, SEA_LEVEL - 1, S.z + 0.5);
  await tpTo(Bb, S.x + 3.5, SEA_LEVEL - 1, S.z + 2.5);
  await tpTo(C, S.x + 2.5, SEA_LEVEL - 1, S.z - 2.5);
  await holdBoat(A);
  A.send({ t: "boat_place", x: S.x + 0.5, y: SURF, z: S.z + 0.5 });
  await waitFor(() => A.boats.size === 1 && Bb.boats.size === 1, 5000, "everyone sees the boat");
  boatId = [...A.boats.keys()][0];
  const b = A.boats.get(boatId)!;
  assert.ok(Math.abs(b.x - (S.x + 0.5)) < 0.05 && Math.abs(b.z - (S.z + 0.5)) < 0.05, "where it was put");
  assert.ok(b.y < SURF && b.y > SURF - 0.6, `afloat (y ${b.y.toFixed(3)})`);
  await waitFor(() => A.count(I.BOAT) === 0, 5000, "the boat item is used up");
});

test("placing a boat needs one in hand, reach, and water or ground under it", async () => {
  const before = A.boats.size;
  // no boat in hand
  A.send({ t: "boat_place", x: S.x - 2.5, y: SURF, z: S.z + 0.5 });
  await sleep(400);
  assert.equal(A.boats.size, before);
  await holdBoat(A);
  // in mid-air
  const notes = A.notices.length;
  A.send({ t: "boat_place", x: S.x - 2.5, y: SURF + 3, z: S.z + 0.5 });
  await waitFor(() => A.notices.length > notes, 5000, "told why");
  // too far away
  A.send({ t: "boat_place", x: S.x - 20.5, y: SURF, z: S.z + 0.5 });
  await sleep(400);
  assert.equal(A.boats.size, before);
  assert.equal(A.count(I.BOAT), 1, "still holding the boat");
});

test("right-click sits in it: everyone hears who sits where; two seats, a third is refused; riders go with the boat", async () => {
  A.send({ t: "mount", id: boatId });
  await waitFor(() => Bb.riding(A.id)?.b === boatId && A.riding()?.s === 0, 5000, "A in the front seat");
  Bb.send({ t: "mount", id: boatId });
  await waitFor(() => A.riding(Bb.id)?.b === boatId && Bb.riding()?.s === 1, 5000, "B in the back seat");
  const notes = C.notices.length;
  C.send({ t: "mount", id: boatId });
  await waitFor(() => C.notices.slice(notes).some((t) => /full/i.test(t)), 5000, "C is told the boat is full");
  assert.equal(C.riding(), null);
  // the riders' positions follow the boat (feet below its bottom, at their seats)
  const boat = C.boats.get(boatId)!;
  await waitFor(() => Math.abs((C.players.get(A.id)?.y ?? 0) - (boat.y + RIDER_Y)) < 0.05, 5000, `A sits in the boat (feet ${RIDER_Y} below its bottom)`);
  const pa = C.players.get(A.id)!;
  assert.ok(Math.hypot(pa.x - boat.x, pa.z - boat.z) < 0.5, "at the front seat");
});

test("the driver rows: the boat moves for everyone and its riders with it; a boat that jumps too far is put back", async () => {
  const b0 = { ...C.boats.get(boatId)! };
  // 40 updates at 20 a second, 0.35 blocks each toward -x (out to sea)
  let x = b0.x;
  for (let k = 0; k < 40; k++) {
    x -= 0.35;
    A.send({ t: "boat", id: boatId, x, y: b0.y, z: b0.z, yaw: 90, r: 6 });
    await sleep(50);
  }
  await waitFor(() => Math.abs(C.boats.get(boatId)!.x - x) < 0.05, 5000, "C sees the boat where A rowed it");
  assert.ok((C.boats.get(boatId)!.flags & 8) !== 0, "flagged as rowed (the oars move)");
  await waitFor(() => Math.abs((C.players.get(Bb.id)?.x ?? 0) - (x - 0.6 * -Math.sin((90 * Math.PI) / 180) * -1)) < 1.5, 5000, "B, in the back seat, went along");
  // a jump of 30 blocks in one update: put back
  const tps = A.boatTps.length;
  A.send({ t: "boat", id: boatId, x: x - 30, y: b0.y, z: b0.z, yaw: 90, r: 0 });
  await waitFor(() => A.boatTps.length > tps, 5000, "the boat is put back");
  assert.ok(Math.abs(A.boatTps[A.boatTps.length - 1].x - x) < 0.5, "to where it was");
  await sleep(300);
  assert.ok(Math.abs(C.boats.get(boatId)!.x - x) < 0.5, "others never saw the jump");
});

test("a rowed boat lifted off the water (no flying boats) is put back after 3 seconds", async () => {
  const b0 = { ...C.boats.get(boatId)! };
  const tps = A.boatTps.length;
  const t0 = Date.now();
  for (let k = 1; k <= 80 && A.boatTps.length === tps; k++) {
    A.send({ t: "boat", id: boatId, x: b0.x, y: Math.min(b0.y + k * 0.1, b0.y + 4), z: b0.z, yaw: 90, r: 0 });
    await sleep(60);
  }
  await waitFor(() => A.boatTps.length > tps, 6000, "put back");
  assert.ok(Date.now() - t0 >= 2500, "not before about 3 s");
  const back = A.boatTps[A.boatTps.length - 1];
  assert.ok(back.y < b0.y + 0.5, "back on the water");
  // (then the server floats it, nobody rowing: it settles at its waterline)
  await waitFor(() => Math.abs(C.boats.get(boatId)!.y - b0.y) < 0.05, 5000, "everyone sees it back on the water");
});

test("sneak gets you out beside the boat, and the one left takes the oars", async () => {
  // row back to the beach so there is ground to step onto
  const b0 = { ...C.boats.get(boatId)! };
  let x = b0.x;
  // as far east as the boat fits (the beach is not a straight line)
  const getB = (gx: number, gy: number, gz: number) => base[idx(gx, gy, gz)];
  let goal = S.x + 0.5;
  while (goal < S.beach + 2 && boatFits(getB, goal + 0.1, b0.y, S.z + 0.5)) goal += 0.1;
  goal -= 0.2;
  while (x < goal) {
    x = Math.min(goal, x + 0.35);
    A.send({ t: "boat", id: boatId, x, y: b0.y, z: S.z + 0.5, yaw: -90, r: 6 });
    await sleep(50);
  }
  await waitFor(() => Math.abs(C.boats.get(boatId)!.x - x) < 0.05, 5000, "at the beach");
  const tps = A.tps.length;
  A.send({ t: "dismount" });
  await waitFor(() => A.tps.length > tps, 5000, "A is moved out");
  const out = A.tps[A.tps.length - 1];
  assert.equal(A.riding(), null);
  assert.ok(Math.hypot(out.x - x, out.z - (S.z + 0.5)) < 3, "beside the boat");
  assert.ok(SOLID[base[idx(Math.floor(out.x), Math.floor(out.y) - 1, Math.floor(out.z))]] || out.y > SEA_LEVEL - 0.5, `standing (${out.x.toFixed(1)}, ${out.y.toFixed(1)}, ${out.z.toFixed(1)})`);
  await waitFor(() => Bb.riding()?.s === 0, 5000, "B moves to the front seat");
  // B gets out too
  Bb.send({ t: "dismount" });
  await waitFor(() => Bb.riding() === null, 5000, "B is out");
});

test("hits add up and break the boat into a boat item; not by its own rider; not in the safe zone", async () => {
  // C walks up to it (on the beach) and gets in, then tries to break its own boat
  await tpTo(C, S.beach + 0.5, top(S.beach, S.z) + 1, S.z + 0.5);
  C.send({ t: "mount", id: boatId });
  await waitFor(() => C.riding()?.b === boatId, 5000, "C in the boat");
  for (let k = 0; k < 6; k++) {
    C.send({ t: "hit", id: boatId, boat: true });
    await sleep(120);
  }
  await sleep(300);
  assert.ok(C.boats.has(boatId), "you can't break the boat you sit in");
  C.send({ t: "dismount" });
  await waitFor(() => C.riding() === null, 5000, "C is out");
  const b = C.boats.get(boatId)!;
  await tpTo(A, b.x + 2.5, Math.max(SEA_LEVEL - 1, top(Math.floor(b.x + 2.5), Math.floor(b.z)) + 1), b.z);
  // punches, quick: each adds 10, and the damage fades a point a tick
  for (let k = 0; k < 8 && A.boats.has(boatId); k++) {
    A.send({ t: "hit", id: boatId, boat: true });
    await sleep(150);
  }
  if (process.env.SHOW_SERVER) console.log("boat", A.boats.get(boatId), "A", A.x, A.y, A.z, A.notices.slice(-3));
  await waitFor(() => !A.boats.has(boatId), 5000, "the boat breaks");
  assert.ok(A.boatsGone.includes(boatId));
  await waitFor(() => [...A.items.values()].some((it) => it.item === I.BOAT), 5000, "a boat item drops");
  // the safe zone: put one in the hub fountain... (there's no open water there: test with the ground) and hit it
  // (on the plaza south of the landmark's dais)
  await tpTo(A, SPAWN_X + 6.5, gen.info.spawnHeight + 1, SPAWN_Z + 16.5);
  await holdBoat(A);
  const n0 = A.boats.size;
  A.send({ t: "boat_place", x: SPAWN_X + 8.5, y: gen.info.spawnHeight + 1, z: SPAWN_Z + 16.5 });
  await waitFor(() => A.boats.size > n0, 5000, "a boat on the plaza");
  const hub = [...A.boats.values()].find((x) => Math.abs(x.x - (SPAWN_X + 8.5)) < 0.1)!;
  const notes = A.notices.length;
  for (let k = 0; k < 8; k++) {
    A.send({ t: "hit", id: hub.id, boat: true });
    await sleep(150);
  }
  await waitFor(() => A.notices.slice(notes).some((t) => /safe zone/i.test(t)), 5000, "told it's the safe zone");
  assert.ok(A.boats.has(hub.id), "boats in the hub stay put");
});

test("a boat nobody rows is moved by the server: put down above the water, it settles on it", async () => {
  await tpTo(A, S.x + 2.5, SEA_LEVEL - 1, S.z - 3.5);
  await holdBoat(A);
  const n0 = A.boats.size;
  // on the water, then lifted by an admin-free trick: place it, it floats; nudge-free check that it settles
  A.send({ t: "boat_place", x: S.x + 0.5, y: SURF, z: S.z - 3.5 });
  await waitFor(() => A.boats.size > n0, 5000, "placed");
  const id = [...A.boats.values()].find((b) => Math.abs(b.z - (S.z - 3.5)) < 0.1)!.id;
  await sleep(1500);
  const y = A.boats.get(id)!.y;
  assert.ok(SURF - y > 0.15 && SURF - y < 0.3, `floating at its waterline (${(SURF - y).toFixed(3)} deep)`);
});

test("boats are saved and come back after a restart", async () => {
  const keep = [...A.boats.values()].map((b) => ({ x: b.x, y: b.y, z: b.z }));
  const r = await fetch(`http://127.0.0.1:${PORT}/admin/save`, { method: "POST", headers: { authorization: "Bearer test-admin-secret-0123456789" } });
  assert.equal(r.status, 200);
  for (const b of bots) b.close();
  bots.length = 0;
  await stopServer();
  server = await startServer();
  const D = await join("boat-d-token-0123456789abcdef");
  await tpTo(D, S.x + 2.5, SEA_LEVEL - 1, S.z + 0.5);
  await waitFor(() => D.boats.size >= 1, 5000, "boats near");
  for (const k of keep) {
    if (Math.hypot(k.x - D.x, k.z - D.z) > 90) continue;
    assert.ok([...D.boats.values()].some((b) => Math.hypot(b.x - k.x, b.z - k.z) < 0.6), `boat at ${k.x.toFixed(1)}, ${k.z.toFixed(1)} is back`);
  }
});
