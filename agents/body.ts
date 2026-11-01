// clankersmp: an AI's body in the game. A headless client on the same protocol as the browser game: it builds the
// same world from the seed (shared/worldgen.ts) and keeps it current, moves with the shared physics 20 times a
// second, and acts only through the messages a player's own client sends (dig, place, hit, eat, craft). Its eyes
// turn smoothly, never snap: spectators watch the world through them. The brain (brain.ts) runs its skills one at a
// time; reflexes (guard) can cut a skill short to fight, flee, eat or dig in.

import WebSocket from "ws";
import { inflateRawSync } from "node:zlib";
import { EYE_HEIGHT, PROTOCOL_NAME, PROTOCOL_VERSION, WORLD_SIZE, idx, inWorld } from "../shared/constants.ts";
import { FLAG, OP, decodeBlocks, decodePlayers, encodeMove, readBlockEntries, type S2C, type Stats } from "../shared/protocol.ts";
import { OP_ANIMALS, OP_ANIMALS_GONE, SPECS as ANIMAL_SPECS, decodeAnimals, decodeGone } from "../shared/animals.ts";
import { OP_ITEMS, OP_ITEMS_GONE, OP_ITEM_PICKUP, decodeIds, decodeItems, decodePickups, type ItemSnap } from "../shared/drops.ts";
import { MF, MOB_SPECS, OP_MOBS, OP_MOBS_GONE } from "../shared/mobs.ts";
import { generateWorld, hashBlocks } from "../shared/worldgen.ts";
import { newPhysState, tickPlayer, type MoveInput, type PhysState } from "../shared/physics.ts";
import { PathFinder, type PathPoint } from "../server/src/pathfind.ts";
import { breakTicks } from "../shared/mining.ts";
import { B, BLOCKS, IS_WATER, SOLID, isFurnace } from "../shared/blocks.ts";
import { fromWire, itemDef, type Stack } from "../shared/items.ts";
import { cooldownTicks } from "../shared/combat.ts";
import { EAT_TICKS } from "../shared/survival.ts";
import { RECIPES, recipeSize } from "../shared/recipes.ts";

export const NIGHT_START = 12542;
export const NIGHT_END = 23459;
const REACH = 4.3; // a little inside the server's 5 (eye to block centre)
const HIT_REACH = 2.9;

/** One world for every body in this process: the same seed, the same edits (each body applies them; idempotent). */
let shared: { key: string; blocks: Uint8Array; hash: number } | null = null;

export interface Seen {
  id: number;
  kind: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  flags: number;
  at: number;
}

export interface Other {
  id: number;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  flags: number;
  held: number;
  at: number;
}

export type Target = { kind: "mob" | "animal" | "player"; id: number };

const deg = (r: number) => (r * 180) / Math.PI;
/** Smallest signed difference a - b in degrees. */
const angleDiff = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export class Body {
  readonly name: string;
  ws!: WebSocket;
  id = 0;
  blocks!: Uint8Array;
  phys: PhysState = newPhysState(256, 64, 256);
  yaw = 0;
  pitch = 0;
  wantYaw = 0;
  wantPitch = 0;
  input: MoveInput = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, yaw: 0 };
  inv: (Stack | null)[] = new Array(36).fill(null);
  armor: (Stack | null)[] = [null, null, null, null];
  sel = 0;
  stats: Stats = { hp: 20, food: 20, sat: 5, air: 300 };
  dead = false;
  deathMsg = "";
  kicked = "";
  closed = false;
  eating = false;
  asleep = false;
  private tps: number[] = [];
  private resyncAt = 0;
  others = new Map<number, Other>();
  names = new Map<number, string>();
  animals = new Map<number, Seen>();
  mobs = new Map<number, Seen>();
  items = new Map<number, ItemSnap & { at: number }>();
  /** Everything that happened that the brain should hear about, newest last (it drains it). */
  events: string[] = [];
  chat: { from: string | null; text: string; at: number }[] = [];
  lastHurt = { at: 0, cause: "", dx: 0, dz: 0 };
  tick = 0;
  /** The skill running now (shown on the site), and the flag that stops it. */
  action = "idle";
  abort = false;
  onEvent: (type: string, data?: Record<string, unknown>) => void = () => {};
  private time = 0;
  private timeAt = Date.now();
  private waiters: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSent = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, flags: -1, sel: -1, tick: -100 };
  private lastSwing = -100;
  private pf!: PathFinder;
  private crafted: ((n: number) => void) | null = null;
  private smelting: ((r: { n: number; ms: number; why?: string }) => void) | null = null;

  constructor(name: string) {
    this.name = name;
  }

  // ---------------------------------------------------------------- the connection

  connect(url: string, secret: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let welcomed = false;
      let edits = false;
      const timer = setTimeout(() => reject(new Error("join timeout")), 90000);
      const ready = () => {
        if (!welcomed || !edits) return;
        clearTimeout(timer);
        this.start();
        resolve();
      };
      ws.on("open", () => ws.send(JSON.stringify({ t: "hello", g: PROTOCOL_NAME, v: PROTOCOL_VERSION, name: this.name, agent: secret })));
      ws.on("message", (data: Buffer, isBinary: boolean) => {
        try {
          if (!isBinary) {
            const m = JSON.parse(data.toString()) as S2C;
            this.onJson(m);
            if (m.t === "welcome") {
              welcomed = true;
              ready();
            } else if (m.t === "kick" && !welcomed) {
              clearTimeout(timer);
              reject(new Error(m.reason));
            }
            return;
          }
          if (data[0] === OP.EDITS) {
            const flat = readBlockEntries(new Uint8Array(inflateRawSync(data.subarray(5))));
            for (let o = 0; o + 3 < flat.length; o += 4) this.blocks[idx(flat[o], flat[o + 1], flat[o + 2])] = flat[o + 3];
            edits = true;
            ready();
            return;
          }
          this.onBin(data);
        } catch (e) {
          console.error(`[${this.name}] message error`, e);
        }
      });
      ws.on("close", () => {
        this.closed = true;
        this.abort = true;
        this.stop();
        this.onEvent("closed", { reason: this.kicked });
      });
      ws.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  debug(text: string): void {
    if (process.env.BODY_DEBUG) console.log(`[${this.name}] ${text}`);
  }

  close(): void {
    this.stop();
    this.ws?.close();
  }

  private onJson(m: S2C): void {
    switch (m.t) {
      case "welcome": {
        this.id = m.id;
        const key = `${m.seed}:${JSON.stringify(m.villages ?? [])}:${JSON.stringify(m.hub ?? null)}`;
        if (!shared || shared.key !== key) {
          const gen = generateWorld(m.seed, undefined, { villages: m.villages ?? [], hub: m.hub ?? { keep: [], roads: m.villages ?? [] } });
          shared = { key, blocks: gen.blocks, hash: hashBlocks(gen.blocks) };
        }
        this.blocks = shared.blocks;
        if (shared.hash !== m.genHash) this.send({ t: "resync" });
        this.pf = new PathFinder(this.get);
        this.phys = newPhysState(m.you.x, m.you.y, m.you.z);
        this.yaw = this.wantYaw = m.you.yaw;
        this.pitch = this.wantPitch = 0;
        this.inv = m.inv.map((w) => fromWire(w));
        this.armor = (m.armor ?? []).map((w) => fromWire(w));
        while (this.armor.length < 4) this.armor.push(null);
        this.sel = m.sel;
        this.stats = m.stats;
        this.time = m.time;
        this.timeAt = Date.now();
        for (const p of m.players) {
          this.names.set(p.id, p.name);
          this.others.set(p.id, { id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, yaw: p.yaw, flags: 0, held: p.held, at: Date.now() });
        }
        break;
      }
      case "time":
        this.time = m.time;
        this.timeAt = Date.now();
        break;
      case "slots":
        for (const [k, w] of m.list) {
          if (k >= 36) this.armor[k - 36] = fromWire(w);
          else this.inv[k] = fromWire(w);
        }
        break;
      case "win":
        // the player window (w 0) carries the whole inventory after a click; we never open one, but keep it right
        break;
      case "stats":
        this.stats = m.s;
        break;
      case "hurt": {
        this.lastHurt = { at: Date.now(), cause: m.cause, dx: m.dx ?? 0, dz: m.dz ?? 0 };
        if (m.kb) {
          this.phys.vx = m.kb[0];
          this.phys.vy = m.kb[1];
          this.phys.vz = m.kb[2];
        }
        this.onEvent("hurt", { cause: m.cause });
        break;
      }
      case "dead":
        this.dead = true;
        this.deathMsg = m.msg;
        this.abort = true;
        this.halt();
        this.onEvent("death", { message: m.msg });
        break;
      case "tp": {
        // corrected again and again: its copy of the world is out of step with the server's, so ask for the server's
        const now = Date.now();
        this.tps = this.tps.filter((t) => now - t < 2000).concat(now);
        if (this.tps.length >= 8 && now - this.resyncAt > 30000) {
          this.resyncAt = now;
          this.send({ t: "resync" });
          this.debug("corrected 8 times in 2 s: asked for the whole world again");
        }
      }
        this.phys.x = m.x;
        this.phys.y = m.y;
        this.phys.z = m.z;
        this.phys.vx = this.phys.vy = this.phys.vz = 0;
        break;
      case "chat":
        this.chat.push({ from: m.from, text: m.text, at: Date.now() });
        if (this.chat.length > 60) this.chat.splice(0, this.chat.length - 60);
        if (m.from && m.from !== this.name) this.events.push(`${m.from} said: ${m.text}`);
        else if (!m.from && m.kind === "system" && !m.text.startsWith(this.name)) this.events.push(m.text);
        break;
      case "notice":
        this.events.push(`(game) ${m.text}`);
        break;
      case "join":
        this.names.set(m.p.id, m.p.name);
        this.others.set(m.p.id, { id: m.p.id, name: m.p.name, x: m.p.x, y: m.p.y, z: m.p.z, yaw: m.p.yaw, flags: 0, held: m.p.held, at: Date.now() });
        break;
      case "leave":
        this.names.delete(m.id);
        this.others.delete(m.id);
        break;
      case "crafted":
        this.crafted?.(m.n);
        this.crafted = null;
        break;
      case "smelting":
        this.smelting?.(m);
        this.smelting = null;
        break;
      case "sleep":
        this.asleep = m.you;
        if (m.on && !m.you && m.sleeping > 0) this.events.push(`${m.sleeping} of the players ${m.sleeping === 1 ? "is" : "are"} asleep in bed; the night is skipped once ${m.needed} ${m.needed === 1 ? "is" : "are"}.`);
        break;
      case "kick":
        this.kicked = m.reason;
        break;
    }
  }

  private onBin(data: Buffer): void {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const op = data[0];
    const now = Date.now();
    if (op === OP.BLOCKS) {
      for (const c of decodeBlocks(view)) this.blocks[idx(c.x, c.y, c.z)] = c.id;
    } else if (op === OP.WORLD) {
      // the server's terrain differs from ours (a different generator build): take its whole world
      this.blocks.set(new Uint8Array(inflateRawSync(data.subarray(5))));
    } else if (op === OP.PLAYERS) {
      for (const s of decodePlayers(view).list) {
        if (s.id === this.id) continue;
        const o = this.others.get(s.id);
        const name = this.names.get(s.id) ?? o?.name ?? "?";
        this.others.set(s.id, { id: s.id, name, x: s.x, y: s.y, z: s.z, yaw: s.yaw, flags: s.flags, held: s.held, at: now });
      }
    } else if (op === OP_ANIMALS || op === OP_MOBS) {
      const map = op === OP_MOBS ? this.mobs : this.animals;
      for (const a of decodeAnimals(view).list) map.set(a.id, { ...a, at: now });
    } else if (op === OP_ANIMALS_GONE || op === OP_MOBS_GONE) {
      const map = op === OP_MOBS_GONE ? this.mobs : this.animals;
      for (const id of decodeGone(view)) map.delete(id);
    } else if (op === OP_ITEMS) {
      for (const it of decodeItems(view).list) this.items.set(it.id, { ...it, at: now });
    } else if (op === OP_ITEMS_GONE) {
      for (const id of decodeIds(view)) this.items.delete(id);
    } else if (op === OP_ITEM_PICKUP) {
      for (const [id] of decodePickups(view)) this.items.delete(id);
    }
  }

  // ---------------------------------------------------------------- the world as this body sees it

  get = (x: number, y: number, z: number): number => {
    if (y < 0) return B.BEDROCK;
    if (!inWorld(x, y, z)) return 0;
    return this.blocks[idx(x, y, z)];
  };

  block(x: number, y: number, z: number): number {
    return this.get(x, y, z);
  }

  worldTime(): number {
    return this.time + Math.floor((Date.now() - this.timeAt) / 50);
  }

  timeOfDay(): number {
    return this.worldTime() % 24000;
  }

  day(): number {
    return Math.floor(this.worldTime() / 24000) + 1;
  }

  isNight(): boolean {
    const t = this.timeOfDay();
    return t >= NIGHT_START - 300 && t <= NIGHT_END;
  }

  get pos(): { x: number; y: number; z: number } {
    return { x: this.phys.x, y: this.phys.y, z: this.phys.z };
  }

  eye(): [number, number, number] {
    return [this.phys.x, this.phys.y + EYE_HEIGHT, this.phys.z];
  }

  distTo(x: number, y: number, z: number): number {
    return Math.hypot(x - this.phys.x, y - this.phys.y, z - this.phys.z);
  }

  /** Eye to the centre of a block. */
  reachTo(x: number, y: number, z: number): number {
    const [ex, ey, ez] = this.eye();
    return Math.hypot(x + 0.5 - ex, y + 0.5 - ey, z + 0.5 - ez);
  }

  heldId(): number {
    return this.inv[this.sel]?.id ?? 0;
  }

  count(id: number): number {
    let n = 0;
    for (const st of this.inv) if (st && st.id === id) n += st.n;
    return n;
  }

  has(id: number, n = 1): boolean {
    return this.count(id) >= n;
  }

  /** Is the body under a roof (no sky above its head)? */
  covered(): boolean {
    const x = Math.floor(this.phys.x);
    const z = Math.floor(this.phys.z);
    for (let y = Math.floor(this.phys.y) + 2; y < 128; y++) if (SOLID[this.get(x, y, z)]) return true;
    return false;
  }

  /** Walls on every side at foot and head height, and a roof: nothing can get in. */
  sealed(): boolean {
    const x = Math.floor(this.phys.x);
    const y = Math.floor(this.phys.y + 0.01);
    const z = Math.floor(this.phys.z);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1]) if (!SOLID[this.get(x + dx, y + dy, z + dz)]) return false;
    return SOLID[this.get(x, y + 2, z)] === 1;
  }

  hostiles(radius = 16): (Seen & { d: number; key: string })[] {
    const out: (Seen & { d: number; key: string })[] = [];
    for (const m of this.mobs.values()) {
      if (m.flags & MF.DEAD) continue;
      const d = this.distTo(m.x, m.y, m.z);
      if (d <= radius) out.push({ ...m, d, key: MOB_SPECS[m.kind]?.key ?? "mob" });
    }
    return out.sort((a, b) => a.d - b.d);
  }

  // ---------------------------------------------------------------- the tick: eyes, legs, the server

  /** 20 ticks a second on the wall clock: the timer is checked often and catches up on any tick it fell behind on
   *  (timers drift, on Windows by a lot), so its moves reach the server evenly and the spectators' camera stays smooth. */
  private start(): void {
    if (this.timer) return;
    const t0 = performance.now();
    let done = 0;
    this.timer = setInterval(() => {
      const due = Math.floor((performance.now() - t0) / 50);
      if (due - done > 20) done = due - 1; // a long stall (a sleeping laptop): don't replay seconds of physics
      while (done < due) {
        done++;
        try {
          this.step();
        } catch (e) {
          console.error(`[${this.name}] tick error`, e);
        }
      }
    }, 10);
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const w of this.waiters.splice(0)) w();
  }

  private step(): void {
    this.tick++;
    if (!this.dead) {
      // eyes ease toward where they want to look (about a third of the way each tick, at most 24 degrees)
      const dy = angleDiff(this.wantYaw, this.yaw);
      this.yaw = (this.yaw + clamp(dy * 0.38, -24, 24) + 360) % 360;
      this.pitch = clamp(this.pitch + clamp((this.wantPitch - this.pitch) * 0.38, -16, 16), -89, 89);
      if (this.phys.inWater && !this.input.jump && this.stats.air < 280) this.input.jump = true; // swim up for air
      tickPlayer(this.phys, { ...this.input, yaw: this.input.yaw }, this.get);
      this.sendMove();
    }
    for (const w of this.waiters.splice(0)) w();
  }

  private sendMove(): void {
    const p = this.phys;
    let flags = 0;
    if (p.crouched) flags |= FLAG.SNEAK;
    if (p.sprinting) flags |= FLAG.SPRINT;
    if (p.onGround) flags |= FLAG.GROUND;
    if (p.inWater) flags |= FLAG.WATER;
    if (this.eating) flags |= FLAG.EAT;
    const l = this.lastSent;
    const moved =
      Math.abs(l.x - p.x) > 0.001 || Math.abs(l.y - p.y) > 0.001 || Math.abs(l.z - p.z) > 0.001 ||
      Math.abs(angleDiff(l.yaw, this.yaw)) > 0.2 || Math.abs(l.pitch - this.pitch) > 0.2 || l.flags !== flags || l.sel !== this.sel;
    if (!moved && this.tick - l.tick < 20) return;
    if (this.ws?.readyState !== 1) return;
    this.ws.send(encodeMove({ x: p.x, y: p.y, z: p.z, yaw: this.yaw, pitch: this.pitch, flags, held: this.sel }));
    this.lastSent = { x: p.x, y: p.y, z: p.z, yaw: this.yaw, pitch: this.pitch, flags, sel: this.sel, tick: this.tick };
  }

  nextTick(): Promise<void> {
    if (this.closed) return Promise.resolve(); // the connection is gone: skills unwind instead of hanging
    return new Promise((r) => this.waiters.push(r));
  }

  async wait(ticks: number): Promise<void> {
    for (let k = 0; k < ticks && !this.abort && !this.dead; k++) await this.nextTick();
  }

  halt(): void {
    this.input.forward = 0;
    this.input.strafe = 0;
    this.input.jump = false;
    this.input.sprint = false;
    this.input.sneak = false;
  }

  // ---------------------------------------------------------------- looking

  look(x: number, y: number, z: number): void {
    const [ex, ey, ez] = this.eye();
    const dx = x - ex;
    const dz = z - ez;
    this.wantYaw = (deg(Math.atan2(-dx, dz)) + 360) % 360;
    this.wantPitch = clamp(-deg(Math.atan2(y - ey, Math.hypot(dx, dz))), -89, 89);
  }

  /** Look at a point and wait until the eyes are there (or close enough). */
  async lookAt(x: number, y: number, z: number, maxTicks = 20): Promise<void> {
    for (let k = 0; k < maxTicks && !this.abort; k++) {
      this.look(x, y, z);
      if (Math.abs(angleDiff(this.wantYaw, this.yaw)) < 4 && Math.abs(this.wantPitch - this.pitch) < 4) return;
      await this.nextTick();
    }
  }

  // ---------------------------------------------------------------- walking

  /** Steer the legs toward (x, z): turn first, then walk; jump up steps, sprint on long straight runs. */
  private steer(x: number, z: number, floorY: number, far: number): void {
    const dx = x - this.phys.x;
    const dz = z - this.phys.z;
    const yaw = (deg(Math.atan2(-dx, dz)) + 360) % 360;
    this.wantYaw = yaw;
    this.wantPitch = clamp(this.wantPitch * 0.9 + 12 * 0.1, -30, 40); // eyes a little down, at the ground ahead
    const off = Math.abs(angleDiff(yaw, this.yaw));
    this.input.yaw = this.yaw;
    this.input.forward = off < 80 ? 1 : off < 120 ? 0.35 : 0; // walk on through a turn, like a player curving round
    this.input.strafe = 0;
    const d = Math.hypot(dx, dz);
    this.input.jump = (floorY - this.phys.y > 0.55 && d < 1.8) || (this.phys.collidedH && this.phys.onGround) || this.phys.inWater;
    this.input.sprint = far > 7 && off < 20 && this.stats.food > 6 && !this.phys.inWater;
    // on dry land it never walks into water (ponds with steep banks are traps): only a swimmer swims; and never off a
    // ledge higher than it can take (a fall of more than 3 blocks hurts, and on low health any fall can kill)
    if (!this.phys.inWater && (this.waterAhead() || this.dropAhead() > (this.stats.hp <= 6 ? 1 : 3))) {
      this.input.forward = 0;
      this.input.sprint = false;
    }
  }

  /** How far down the ground is just ahead (0 when it's level or higher; up to 8). */
  private dropAhead(): number {
    if (!this.phys.onGround) return 0;
    const a = (this.input.yaw * Math.PI) / 180;
    const y = Math.floor(this.phys.y + 0.01);
    let worst = 0;
    for (const reach of [0.6, 1.1]) {
      const x = Math.floor(this.phys.x - Math.sin(a) * reach);
      const z = Math.floor(this.phys.z + Math.cos(a) * reach);
      if (SOLID[this.get(x, y, z)] || SOLID[this.get(x, y - 1, z)]) continue;
      let d = 1;
      while (d < 8 && !SOLID[this.get(x, y - 1 - d, z)] && !IS_WATER[this.get(x, y - 1 - d, z)]) d++;
      if (IS_WATER[this.get(x, y - 1 - d, z)]) return 99; // a drop into water: a pond below a bank is a trap too
      worst = Math.max(worst, d);
    }
    return worst;
  }

  /** Water just ahead of its feet, where its next steps would land. */
  private waterAhead(): boolean {
    const a = (this.input.yaw * Math.PI) / 180;
    const y = Math.floor(this.phys.y + 0.01);
    for (const reach of [0.6, 1.1]) {
      const x = Math.floor(this.phys.x - Math.sin(a) * reach);
      const z = Math.floor(this.phys.z + Math.cos(a) * reach);
      if (IS_WATER[this.get(x, y, z)] || (IS_WATER[this.get(x, y - 1, z)] && !SOLID[this.get(x, y, z)])) return true;
    }
    return false;
  }

  private plan(x: number, y: number, z: number): PathPoint[] | null {
    // around water, not through it (a swim is slow and ends in flooded holes), unless it's already swimming
    const s = this.pf.search(this.phys.x, this.phys.y, this.phys.z, { hw: 0.3, h: 1.8, maxNodes: 5000, radius: 40, water: this.phys.inWater, aim: true }, { x: Math.floor(x), z: Math.floor(z) });
    if (!s) return null;
    const i = s.reached >= 0 ? s.reached : s.closestTo(x, z);
    return s.pathTo(i);
  }

  /** Walk to within `range` of a point (or until `done()`), replanning as it goes. False if it couldn't. */
  async goto(x: number, y: number, z: number, range = 1.5, opts: { maxMs?: number; done?: () => boolean } = {}): Promise<boolean> {
    const t0 = Date.now();
    const maxMs = opts.maxMs ?? 60000;
    const arrived = () => (opts.done ? opts.done() : Math.hypot(x - this.phys.x, z - this.phys.z) <= range && Math.abs(y - this.phys.y) < 3);
    let best = Infinity;
    let fails = 0;
    while (!this.abort && !this.dead && Date.now() - t0 < maxMs) {
      if (arrived()) break;
      const d = Math.hypot(x - this.phys.x, z - this.phys.z);
      if (d < best - 0.5) {
        best = d;
        fails = 0;
      } else if (++fails > 3) break;
      // the path search only starts from somewhere it can stand: out of the water first
      if (this.phys.inWater && !this.plan(x, y, z)?.length) await this.escapeWater(200);
      const path = this.plan(x, y, z);
      if (!path || !path.length) {
        // nowhere to stand (mid-air, swimming) or boxed in: push straight at it for a moment
        if (!(await this.walkStraight(x, z, 30, arrived))) await this.unstick();
        continue;
      }
      await this.follow(path, x, z, arrived);
    }
    this.halt();
    return arrived();
  }

  /** Walk a path the way a player does: aim for the farthest node it can walk to in a straight line (a flat, clear,
   *  dry stretch), so it runs in smooth lines and curves instead of hopping from block to block; nodes that need a
   *  jump or a drop are taken one at a time. */
  private async follow(path: PathPoint[], gx: number, gz: number, arrived: () => boolean): Promise<void> {
    let i = 0;
    let best = Infinity;
    let since = this.tick;
    while (i < path.length) {
      if (this.abort || this.dead || arrived()) return;
      // past the nodes it has reached (or walked by)
      while (i < path.length) {
        const n = path[i];
        const d = Math.hypot(n.x + 0.5 - this.phys.x, n.z + 0.5 - this.phys.z);
        const nn = path[i + 1];
        const nearer = nn && Math.hypot(nn.x + 0.5 - this.phys.x, nn.z + 0.5 - this.phys.z) < d && Math.abs(nn.f - n.f) < 0.6;
        if ((d < 0.55 && this.phys.y > n.f - 0.6) || (nearer && d < 1.4)) {
          i++;
          best = Infinity;
          since = this.tick;
        } else break;
      }
      if (i >= path.length) break;
      // look ahead along a level stretch for the farthest node in a clear straight line
      let j = i;
      for (let k = i + 1; k < Math.min(path.length, i + 10); k++) {
        if (Math.abs(path[k].f - path[i].f) > 0.6 || path[k].water || !this.clearLine(path[k].x + 0.5, path[k].z + 0.5, path[i].f)) break;
        j = k;
      }
      const t = path[j];
      const di = Math.hypot(path[i].x + 0.5 - this.phys.x, path[i].z + 0.5 - this.phys.z);
      this.steer(t.x + 0.5, t.z + 0.5, path[i].f, Math.hypot(gx - this.phys.x, gz - this.phys.z));
      // stuck on the node it's working toward: let the caller replan
      if (di < best - 0.05) {
        best = di;
        since = this.tick;
      } else if (this.tick - since > 30) {
        this.halt();
        return;
      }
      await this.nextTick();
    }
  }

  /** A straight walk from here to (x, z) at floor height f: ground under every step, room for the body, no water. */
  private clearLine(x: number, z: number, f: number): boolean {
    const sx = this.phys.x;
    const sz = this.phys.z;
    const len = Math.hypot(x - sx, z - sz);
    const y = Math.floor(f + 0.01);
    for (let s = 0.4; s < len; s += 0.4) {
      const px = sx + ((x - sx) * s) / len;
      const pz = sz + ((z - sz) * s) / len;
      for (const [ox, oz] of [[0, 0], [0.3, 0.3], [-0.3, 0.3], [0.3, -0.3], [-0.3, -0.3]]) {
        const cx = Math.floor(px + ox);
        const cz = Math.floor(pz + oz);
        if (SOLID[this.get(cx, y, cz)] || SOLID[this.get(cx, y + 1, cz)] || IS_WATER[this.get(cx, y, cz)]) return false;
      }
      const cx = Math.floor(px);
      const cz = Math.floor(pz);
      if (!SOLID[this.get(cx, y - 1, cz)]) return false; // a hole or a drop on the way
    }
    return true;
  }

  private async walkStraight(x: number, z: number, ticks: number, arrived: () => boolean): Promise<boolean> {
    const from = Math.hypot(x - this.phys.x, z - this.phys.z);
    for (let k = 0; k < ticks && !this.abort && !this.dead && !arrived(); k++) {
      this.steer(x, z, this.phys.y, 0);
      await this.nextTick();
    }
    this.halt();
    return Math.hypot(x - this.phys.x, z - this.phys.z) < from - 1;
  }

  /** Out of a hole or a corner: jump around, else build up under itself. */
  async unstick(): Promise<void> {
    for (const a of [0, 90, 180, 270]) {
      if (this.abort || this.dead) return;
      const x = this.phys.x;
      const z = this.phys.z;
      this.input.yaw = this.wantYaw = (this.yaw + a) % 360;
      this.input.forward = 1;
      this.input.jump = true;
      await this.wait(12);
      this.halt();
      if (Math.hypot(this.phys.x - x, this.phys.z - z) > 1.2) return;
    }
    if (this.inHole()) await this.pillarUp(4);
  }

  /** Walls all round at head height: a pit. */
  inHole(): boolean {
    const x = Math.floor(this.phys.x);
    const y = Math.floor(this.phys.y + 0.01) + 1;
    const z = Math.floor(this.phys.z);
    return [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => SOLID[this.get(x + dx, y, z + dz)] === 1);
  }

  /** Jump and put a block under its feet at the top of each jump (the way out of a pit). */
  async pillarUp(n: number): Promise<number> {
    let up = 0;
    for (let k = 0; k < n && !this.abort && !this.dead; k++) {
      const filler = this.fillerBlock();
      if (!filler) break;
      const x = Math.floor(this.phys.x);
      const z = Math.floor(this.phys.z);
      const y0 = Math.floor(this.phys.y + 0.01);
      if (SOLID[this.get(x, y0 + 2, z)]) {
        // a roof: dig it first
        if (!(await this.mine(x, y0 + 2, z, false))) break;
      }
      await this.hold(filler);
      this.wantPitch = 89;
      await this.wait(4);
      this.input.jump = true;
      let placed = false;
      for (let t = 0; t < 14 && !placed; t++) {
        await this.nextTick();
        this.input.jump = false;
        if (this.phys.y >= y0 + 1.05) {
          this.send({ t: "place", x, y: y0, z, id: filler });
          this.swing();
          placed = true;
        }
      }
      await this.wait(8);
      if (Math.floor(this.phys.y + 0.01) > y0) up++;
      else break;
    }
    this.wantPitch = 10;
    return up;
  }

  // ---------------------------------------------------------------- hands

  swing(): void {
    this.send({ t: "swing" });
    this.lastSwing = this.tick;
  }

  /** Take an item in hand: select it on the hotbar, or have the server swap it into the selected slot. */
  async hold(id: number): Promise<boolean> {
    if (this.heldId() === id) return true;
    const k = this.inv.findIndex((st, i) => i < 9 && st?.id === id);
    if (k >= 0) {
      this.sel = k;
      this.send({ t: "sel", s: k });
      await this.nextTick();
      return true;
    }
    if (!this.has(id)) return false;
    this.send({ t: "hold", id });
    for (let t = 0; t < 20 && this.heldId() !== id; t++) await this.nextTick();
    return this.heldId() === id;
  }

  /** The fastest thing it has for breaking this block (its hand if nothing helps). */
  bestToolFor(block: number): number {
    let best = 0;
    let bt = breakTicks(block, 0);
    for (const st of this.inv) {
      if (!st || !itemDef(st.id)?.tool) continue;
      const t = breakTicks(block, st.id);
      if (t >= 0 && t < bt) {
        bt = t;
        best = st.id;
      }
    }
    return best;
  }

  bestWeapon(): number {
    let best = 0;
    let dmg = 1;
    for (const st of this.inv) {
      const t = st ? itemDef(st.id)?.tool : undefined;
      if (!t) continue;
      const d = t.damage;
      const score = d + (t.kind === "sword" ? 0.5 : 0);
      if (score > dmg) {
        dmg = score;
        best = st!.id;
      }
    }
    return best;
  }

  /** A plain block it can spare for building (dirt first, then cobblestone, then planks). */
  fillerBlock(): number {
    for (const id of [B.DIRT, B.COBBLESTONE, B.SAND, B.GRAVEL, B.OAK_PLANKS, B.BIRCH_PLANKS, B.STONE]) if (id !== undefined && this.has(id)) return id;
    return 0;
  }

  /** Mine one block: walk into reach, the best tool, look at it, dig for as long as it takes, then make sure it went. */
  async mine(x: number, y: number, z: number, approach = true): Promise<boolean> {
    const id = this.get(x, y, z);
    if (id === B.AIR || IS_WATER[id] || BLOCKS[id]?.breakTicks < 0) return false;
    if (this.reachTo(x, y, z) > REACH) {
      if (!approach) return false;
      const near = () => Math.hypot(x + 0.5 - this.phys.x, z + 0.5 - this.phys.z) < 2.6;
      // walk over (to above it, if it's underground), then dig down to it if it's still below reach
      let ok = await this.goto(x + 0.5, y, z + 0.5, 2, { maxMs: 15000, done: () => this.reachTo(x, y, z) <= REACH || (y < this.phys.y - 2 && near()) });
      if (!ok || this.reachTo(x, y, z) > REACH) ok = y < this.phys.y - 2 && near() && (await this.digDownTo(x, y, z));
      if (!ok) {
        this.debug(`can't reach ${BLOCKS[id]?.key} at ${x} ${y} ${z} (from ${this.phys.x.toFixed(1)} ${this.phys.y.toFixed(1)} ${this.phys.z.toFixed(1)})`);
        return false;
      }
    }
    const tool = this.bestToolFor(id);
    if (tool) await this.hold(tool);
    this.action = `mining ${BLOCKS[id]?.name ?? "a block"}`;
    await this.lookAt(x + 0.5, y + 0.5, z + 0.5, 15);
    if (breakTicks(id, this.heldId(), this.phys.inWater, true) < 0) return false;
    this.send({ t: "dig", a: "start", x, y, z });
    this.swing();
    // The server times the whole dig with the body as it is at the finish (on the ground or not, in water or not),
    // so finish once that much time has passed: the normal time on the ground, longer in the air or in water.
    const startAt = Date.now();
    for (let k = 0; ; k++) {
      if (this.abort || this.dead || this.get(x, y, z) !== id || k > 600 || this.reachTo(x, y, z) > REACH + 0.5) {
        this.send({ t: "dig", a: "abort", x, y, z });
        if (this.get(x, y, z) === id) this.debug(`dig of ${BLOCKS[id]?.key} at ${x} ${y} ${z} stopped (abort ${this.abort}, k ${k}, reach ${this.reachTo(x, y, z).toFixed(1)})`);
        return this.get(x, y, z) !== id;
      }
      const t = breakTicks(id, this.heldId(), this.phys.inWater, this.phys.onGround);
      if (Date.now() - startAt >= t * 50 + 60) break;
      this.look(x + 0.5, y + 0.5, z + 0.5);
      if (k % 5 === 4) this.swing();
      await this.nextTick();
    }
    this.send({ t: "dig", a: "finish", x, y, z });
    for (let k = 0; k < 30; k++) {
      if (this.get(x, y, z) !== id) return true;
      await this.nextTick();
    }
    return false;
  }

  /** Dig straight down where it stands until a block below comes into reach. Stops above water, bedrock and long
   *  drops (a cave right under it). */
  async digDownTo(x: number, y: number, z: number): Promise<boolean> {
    for (let k = 0; k < 12 && !this.abort && !this.dead; k++) {
      if (this.reachTo(x, y, z) <= REACH) return true;
      const fx = Math.floor(this.phys.x);
      const fz = Math.floor(this.phys.z);
      const fy = Math.floor(this.phys.y + 0.01) - 1;
      if (fy <= y || fy <= 30) return this.reachTo(x, y, z) <= REACH; // level with it, or as deep as it goes (the deep caves are deadly)
      const id = this.get(fx, fy, fz);
      if (IS_WATER[id] || id === B.BEDROCK) return false;
      if (!SOLID[this.get(fx, fy - 1, fz)] && !SOLID[this.get(fx, fy - 2, fz)] && !SOLID[this.get(fx, fy - 3, fz)]) return false;
      if (id !== B.AIR && !(await this.mine(fx, fy, fz, false))) return false;
      await this.dropInto(fx, fy, fz);
    }
    return this.reachTo(x, y, z) <= REACH;
  }

  /** Put a block from the inventory into a cell (in reach, next to something solid, not where it stands). */
  async place(item: number, x: number, y: number, z: number): Promise<boolean> {
    if (!this.has(item)) return false;
    const cur = this.get(x, y, z);
    if (cur !== B.AIR && !IS_WATER[cur] && !BLOCKS[cur]?.replaceable) return false;
    if (this.reachTo(x, y, z) > REACH) {
      const ok = await this.goto(x + 0.5, y, z + 0.5, 2.5, { maxMs: 20000, done: () => this.reachTo(x, y, z) <= REACH });
      if (!ok) return false;
    }
    if (!(await this.hold(item))) return false;
    await this.lookAt(x + 0.5, y + 0.5, z + 0.5, 15);
    const id = itemDef(item)?.block || item;
    this.send({ t: "place", x, y, z, id });
    this.swing();
    for (let k = 0; k < 20; k++) {
      await this.nextTick();
      if (this.get(x, y, z) !== cur) return true;
    }
    return false;
  }

  /** A free cell next to the body, on the ground, to put something (a crafting table, a furnace). */
  spotNearby(): [number, number, number] | null {
    const fx = Math.floor(this.phys.x);
    const fy = Math.floor(this.phys.y + 0.01);
    const fz = Math.floor(this.phys.z);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1], [2, 0], [0, 2], [-2, 0], [0, -2]]) {
      for (const dy of [0, -1, 1]) {
        const x = fx + dx;
        const y = fy + dy;
        const z = fz + dz;
        const here = this.get(x, y, z);
        if ((here === B.AIR || BLOCKS[here]?.replaceable) && SOLID[this.get(x, y - 1, z)] && !IS_WATER[here]) return [x, y, z];
      }
    }
    return null;
  }

  /** Walk over the dropped items near it to pick them up. */
  async pickUp(radius = 7, maxMs = 12000): Promise<number> {
    const t0 = Date.now();
    let got = 0;
    await this.wait(5); // a drop shows up in the items stream a few ticks after the block breaks
    for (let n = 0; n < 8 && !this.abort && !this.dead && Date.now() - t0 < maxMs; n++) {
      let best: (ItemSnap & { at: number }) | null = null;
      let bd = radius;
      for (const it of this.items.values()) {
        const d = this.distTo(it.x, it.y, it.z);
        if (d < bd && Math.abs(it.y - this.phys.y) < 4) {
          bd = d;
          best = it;
        }
      }
      if (!best) break;
      const id = best.id;
      await this.goto(best.x, best.y, best.z, 0.6, { maxMs: 6000, done: () => !this.items.has(id) });
      if (!this.items.has(id)) got++;
      else this.items.delete(id); // couldn't reach it: forget it for now
    }
    return got;
  }

  /** Nearest blocks of these ids within a radius, those with an open face first (reachable without tunnelling). */
  findBlocks(ids: number[], radius = 32, max = 12): [number, number, number][] {
    const want = new Uint8Array(256);
    for (const id of ids) want[id] = 1;
    const cx = Math.floor(this.phys.x);
    const cy = Math.floor(this.phys.y);
    const cz = Math.floor(this.phys.z);
    const out: [number, number, number, number][] = [];
    for (let y = Math.max(1, cy - 12); y <= Math.min(126, cy + 16); y++)
      for (let z = Math.max(0, cz - radius); z <= Math.min(WORLD_SIZE - 1, cz + radius); z++)
        for (let x = Math.max(0, cx - radius); x <= Math.min(WORLD_SIZE - 1, cx + radius); x++) {
          if (!want[this.blocks[idx(x, y, z)]]) continue;
          let open = false;
          for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
            const n = this.get(x + dx, y + dy, z + dz);
            if (!SOLID[n] && !IS_WATER[n]) open = true;
          }
          if (!open) continue;
          // what it can walk up to first; deep ones (it would have to dig down) only when nothing else is near
          const dy = y - cy;
          const d = Math.hypot(x - cx, dy * (dy < -2 ? 4 : dy > 3 ? 3 : 1.6), z - cz);
          out.push([x, y, z, d]);
        }
    out.sort((a, b) => a[3] - b[3]);
    return out.slice(0, max).map(([x, y, z]) => [x, y, z]);
  }

  // ---------------------------------------------------------------- crafting, eating, fighting

  recipeFor(rid: string) {
    return RECIPES.find((r) => r.id === rid);
  }

  tableInReach(): boolean {
    return this.blockInReach((id) => id === B.CRAFTING_TABLE);
  }

  blockInReach(test: (id: number) => boolean): boolean {
    const [ex, ey, ez] = this.eye();
    for (let y = Math.floor(ey) - 5; y <= Math.floor(ey) + 5; y++)
      for (let z = Math.floor(ez) - 5; z <= Math.floor(ez) + 5; z++)
        for (let x = Math.floor(ex) - 5; x <= Math.floor(ex) + 5; x++)
          if (test(this.get(x, y, z)) && Math.hypot(x + 0.5 - ex, y + 0.5 - ey, z + 0.5 - ez) <= 4.6) return true;
    return false;
  }

  /** Smelt n of an item: a furnace in reach (a near one, or one it carries put down), its own fuel, and it stays by
   *  the furnace while it burns (the results come out even if something pulls it away). */
  async smelt(item: number, n: number): Promise<string> {
    const furnace = (id: number) => isFurnace(id);
    if (!this.blockInReach(furnace)) {
      const near = this.findBlocks([0, 1, 2, 3, 4, 5, 6, 7].map((k) => B.FURNACE + k), 20, 1)[0];
      if (near) await this.goto(near[0] + 0.5, near[1], near[2] + 0.5, 2, { maxMs: 25000, done: () => this.blockInReach(furnace) });
      else if (this.has(B.FURNACE)) {
        const spot = this.spotNearby();
        if (spot) await this.place(B.FURNACE, ...spot);
      }
      if (!this.blockInReach(furnace)) return "there is no furnace here (craft one: furnace, from 8 cobblestone)";
    }
    const got = new Promise<{ n: number; ms: number; why?: string }>((res) => {
      this.smelting = res;
      setTimeout(() => res({ n: 0, ms: 0, why: "no answer from the server" }), 3000);
    });
    this.send({ t: "smelt", id: item, n });
    const r = await got;
    if (!r.n) return `couldn't smelt: ${r.why}`;
    this.action = `smelting ${itemDef(item)?.name ?? "something"}`;
    this.halt();
    await this.wait(Math.ceil(r.ms / 50) + 20);
    return this.abort ? `left the furnace early; the ${r.n} smelted items will drop there when done` : `smelted ${r.n} ${itemDef(item)?.key ?? ""}`;
  }

  /** Craft a recipe n times. 3x3 recipes go to a crafting table: a near one, or one it puts down. */
  async craft(rid: string, n: number): Promise<{ made: number; why?: string }> {
    const r = this.recipeFor(rid);
    if (!r) return { made: 0, why: `there is no recipe called ${rid}` };
    const [w, h] = recipeSize(r);
    if ((w > 2 || h > 2) && !this.tableInReach()) {
      const near = this.findBlocks([B.CRAFTING_TABLE], 20, 1)[0];
      if (near) await this.goto(near[0] + 0.5, near[1], near[2] + 0.5, 2, { maxMs: 25000, done: () => this.tableInReach() });
      else if (this.has(B.CRAFTING_TABLE)) {
        const spot = this.spotNearby();
        if (spot) await this.place(B.CRAFTING_TABLE, ...spot);
      }
      if (!this.tableInReach()) return { made: 0, why: "that needs a crafting table and there is none here (craft one: crafting_table)" };
    }
    const got = new Promise<number>((res) => {
      this.crafted = res;
      setTimeout(() => res(-1), 3000);
    });
    this.send({ t: "craft", r: rid, n });
    const made = await got;
    if (made < 0) return { made: 0, why: "no answer from the server" };
    if (made === 0) return { made: 0, why: "missing ingredients" };
    await this.wait(3); // the inventory slots arrive with the next server tick
    return { made };
  }

  /** Eat the best food it carries (not the spoiled flesh unless that's all there is). */
  async eat(): Promise<string> {
    if (this.stats.food >= 20) return "not hungry";
    const foods = this.inv.filter((st): st is Stack => !!st && !!itemDef(st.id)?.food);
    if (!foods.length) return "no food";
    foods.sort((a, b) => (itemDef(b.id)!.food!.hunger + (itemDef(b.id)!.food!.queasy ? -10 : 0)) - (itemDef(a.id)!.food!.hunger + (itemDef(a.id)!.food!.queasy ? -10 : 0)));
    const f = foods[0];
    if (!(await this.hold(f.id))) return "couldn't take it in hand";
    this.halt();
    const before = this.stats.food;
    this.send({ t: "eat", a: "start" });
    this.eating = true;
    await this.wait(EAT_TICKS + 3);
    this.send({ t: "eat", a: this.abort ? "abort" : "finish" });
    this.eating = false;
    await this.wait(4);
    return this.stats.food > before ? `ate ${itemDef(f.id)!.name}, hunger ${this.stats.food}/20` : "eating was interrupted";
  }

  targetPos(t: Target): { x: number; y: number; z: number; h: number } | null {
    if (t.kind === "player") {
      const o = this.others.get(t.id);
      return o && !(o.flags & FLAG.DEAD) ? { x: o.x, y: o.y, z: o.z, h: 1.8 } : null;
    }
    const m = (t.kind === "mob" ? this.mobs : this.animals).get(t.id);
    if (!m || (t.kind === "mob" && m.flags & MF.DEAD)) return null;
    const spec = t.kind === "mob" ? MOB_SPECS[m.kind] : ANIMAL_SPECS[m.kind];
    return { x: m.x, y: m.y, z: m.z, h: spec?.h ?? 1 };
  }

  /** Fight something until it is dead or gone, it gets away, or time runs out. */
  async fight(t: Target, maxMs = 25000): Promise<string> {
    const weapon = this.bestWeapon();
    if (weapon) await this.hold(weapon);
    const t0 = Date.now();
    let hits = 0;
    let closest = Infinity;
    let closedAt = Date.now();
    while (!this.abort && !this.dead && Date.now() - t0 < maxMs) {
      const p = this.targetPos(t);
      if (!p) {
        this.halt();
        return hits ? "it's dead or gone" : "it's gone";
      }
      const [ex, ey, ez] = this.eye();
      const d = Math.hypot(p.x - ex, p.y + p.h * 0.6 - ey, p.z - ez);
      if (d > 24) {
        this.halt();
        return "it got away";
      }
      // not getting any closer for 6 s (across water, up a cliff, round a fence): give up on this one
      if (d < closest - 0.7) {
        closest = d;
        closedAt = Date.now();
      } else if (d > HIT_REACH && Date.now() - closedAt > 6000) {
        this.halt();
        return hits ? "it got out of reach after a few hits" : "couldn't get to it (water, a drop or a wall in the way): try another one";
      }
      if (d > HIT_REACH - 0.4) {
        if (d > 16) {
          await this.goto(p.x, p.y, p.z, 2.2, { maxMs: 4000, done: () => this.inHitRange(t) });
          continue;
        }
        // run straight at it (a fleeing animal won't wait for a path), sprinting unless it's right there
        this.steer(p.x, p.z, p.y, 0);
        this.input.sprint = d > 3 && this.stats.food > 6 && !this.phys.inWater;
      } else this.halt();
      this.look(p.x, p.y + p.h * 0.6, p.z);
      const ready = this.tick - this.lastSwing >= Math.ceil(cooldownTicks(this.heldId()));
      if (d <= HIT_REACH && ready && Math.abs(angleDiff(this.wantYaw, this.yaw)) < 30) {
        this.send({ t: "hit", id: t.id, ...(t.kind === "mob" ? { mob: true } : t.kind === "player" ? { player: true } : {}) });
        this.swing();
        hits++;
      }
      await this.nextTick();
    }
    this.halt();
    return "ran out of time";
  }

  inHitRange(t: Target): boolean {
    const p = this.targetPos(t);
    if (!p) return true;
    const [ex, ey, ez] = this.eye();
    return Math.hypot(p.x - ex, p.y + p.h * 0.6 - ey, p.z - ez) <= HIT_REACH;
  }

  /** Run from a point for a few seconds. */
  async flee(fromX: number, fromZ: number, ticks = 80): Promise<void> {
    for (let k = 0; k < ticks && !this.dead; k++) {
      const dx = this.phys.x - fromX;
      const dz = this.phys.z - fromZ;
      const len = Math.hypot(dx, dz) || 1;
      this.steer(this.phys.x + (dx / len) * 6, this.phys.z + (dz / len) * 6, this.phys.y, 10);
      await this.nextTick();
    }
    this.halt();
  }

  /** Water within `r` blocks of a column, from `y0 - depth` up to y0 + 1 (a hole dug there would flood). */
  waterNear(x: number, y0: number, z: number, r = 2, depth = 4): boolean {
    for (let y = y0 - depth; y <= y0 + 1; y++)
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (IS_WATER[this.get(x + dx, y, z + dz)]) return true;
    return false;
  }

  /** Out of the water: swim to the nearest bank it can climb onto; with none in reach, build itself up out of it
   *  with a spare block (water can be built in), or dig a step into the wall. */
  async escapeWater(maxTicks = 300): Promise<boolean> {
    let stuck = 0;
    let lastY = this.phys.y;
    for (let k = 0; k < maxTicks && !this.dead && (this.phys.inWater || this.waterNear(Math.floor(this.phys.x), Math.floor(this.phys.y + 0.01), Math.floor(this.phys.z), 0, 0)); k++) {
      const bank = this.findBank(8);
      if (bank) {
        this.steer(bank[0] + 0.5, bank[2] + 0.5, bank[1], 10);
        this.input.jump = true;
        this.input.sprint = false;
      } else {
        this.halt();
        this.input.jump = true; // swim up
      }
      await this.nextTick();
      if (Math.abs(this.phys.y - lastY) < 0.05) stuck++;
      else stuck = 0;
      lastY = this.phys.y;
      if (stuck > 40) {
        // treading water against a wall: climb out the hard way
        stuck = 0;
        this.halt();
        if (this.fillerBlock()) await this.pillarUp(1);
        else await this.stepUp();
      }
    }
    this.halt();
    return !this.phys.inWater;
  }

  /** The nearest dry spot to stand on within r blocks that a swimmer can climb onto (its floor at most about a block
   *  over the water). */
  findBank(r: number): [number, number, number] | null {
    const fx = Math.floor(this.phys.x);
    const fz = Math.floor(this.phys.z);
    const top = this.phys.y + 1.3;
    let best: [number, number, number] | null = null;
    let bd = Infinity;
    for (let dz = -r; dz <= r; dz++)
      for (let dx = -r; dx <= r; dx++) {
        const x = fx + dx;
        const z = fz + dz;
        for (let y = Math.floor(top); y >= Math.floor(this.phys.y) - 2; y--) {
          const below = this.get(x, y - 1, z);
          if (!SOLID[below] || IS_WATER[this.get(x, y, z)] || SOLID[this.get(x, y, z)] || SOLID[this.get(x, y + 1, z)]) continue;
          const d = Math.hypot(dx, dz);
          if (d < bd && (dx || dz)) {
            bd = d;
            best = [x, y, z];
          }
          break;
        }
      }
    return best;
  }

  /** Dig in for the night: three blocks down, then a block over its head. */
  async digIn(): Promise<string> {
    if (this.sealed()) return "already sealed in";
    this.halt();
    if (this.phys.inWater) await this.escapeWater();
    // a hole next to water floods: walk a few blocks away from it first
    for (let tries = 0; tries < 3 && this.waterNear(Math.floor(this.phys.x), Math.floor(this.phys.y + 0.01), Math.floor(this.phys.z)); tries++) {
      const a = Math.random() * Math.PI * 2;
      await this.goto(this.phys.x + Math.cos(a) * 6, this.phys.y, this.phys.z + Math.sin(a) * 6, 1.5, { maxMs: 6000 });
    }
    if (this.phys.inWater) return "in water, can't dig in here";
    const x = Math.floor(this.phys.x);
    const z = Math.floor(this.phys.z);
    const y0 = Math.floor(this.phys.y + 0.01);
    for (let k = 1; k <= 3; k++) {
      if (this.abort || this.dead) return "interrupted";
      const id = this.get(x, y0 - k, z);
      if (IS_WATER[id]) return "water below, can't dig in here";
      if (id !== B.AIR && !(await this.mine(x, y0 - k, z, false))) return "couldn't dig down here";
      if (!(await this.dropInto(x, y0 - k, z))) return "dug a hole but couldn't get into it";
    }
    for (let k = 0; k < 30 && !this.fillerBlock(); k++) await this.nextTick(); // the dirt it fell onto gets picked up
    const filler = this.fillerBlock();
    if (!filler) return "dug down but has nothing to close the roof with";
    const roof = Math.floor(this.phys.y + 0.01) + 2;
    if (!SOLID[this.get(x, roof, z)]) {
      await this.hold(filler);
      this.wantPitch = -89;
      await this.wait(8);
      this.send({ t: "place", x, y: roof, z, id: filler });
      this.swing();
      await this.wait(6);
    }
    this.wantPitch = 0;
    const lit = await this.lightUp();
    return (this.sealed() ? "sealed in underground" : "dug in, but the hole isn't fully closed") + (lit ? ", with a torch" : "");
  }

  /** A torch beside it in a hole (a small nook dug into the wall for it): never sitting in the pitch dark. */
  async lightUp(): Promise<boolean> {
    if (!this.has(B.TORCH)) return false;
    const x = Math.floor(this.phys.x);
    const y = Math.floor(this.phys.y + 0.01);
    const z = Math.floor(this.phys.z);
    for (let r = -4; r <= 4; r++) for (let dy = -3; dy <= 3; dy++) for (let q = -4; q <= 4; q++) if (this.get(x + r, y + dy, z + q) === B.TORCH) return true;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const nz = z + dz;
      if (!SOLID[this.get(nx, y, nz)] || IS_WATER[this.get(nx, y + 1, nz)]) continue; // the nook needs a floor
      if (SOLID[this.get(nx, y + 1, nz)] && !(await this.mine(nx, y + 1, nz, false))) continue;
      if (await this.place(B.TORCH, nx, y + 1, nz)) return true;
    }
    return false;
  }

  /** Step to the middle of a block column (small careful steps, the head still) so the body fits a 1x1 hole. */
  async center(x: number, z: number, ticks = 30): Promise<void> {
    for (let k = 0; k < ticks && !this.abort; k++) {
      const dx = x + 0.5 - this.phys.x;
      const dz = z + 0.5 - this.phys.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.08) break;
      // no sneaking here: sneaking refuses to step off an edge, and the way into a hole is off an edge
      this.input.yaw = (deg(Math.atan2(-dx, dz)) + 360) % 360;
      this.input.forward = Math.min(1, d * 2.5);
      this.input.sneak = false;
      this.input.sprint = false;
      this.input.jump = false;
      await this.nextTick();
    }
    this.halt();
  }

  /** Into the hole just dug at (x, floorY, z): centre over it and wait to land. */
  async dropInto(x: number, floorY: number, z: number): Promise<boolean> {
    for (let k = 0; k < 60 && !this.abort && !this.dead; k++) {
      if (this.phys.y < floorY + 0.5 && this.phys.onGround) return true;
      if (Math.hypot(x + 0.5 - this.phys.x, z + 0.5 - this.phys.z) > 0.12) {
        const dx = x + 0.5 - this.phys.x;
        const dz = z + 0.5 - this.phys.z;
        this.input.yaw = (deg(Math.atan2(-dx, dz)) + 360) % 360;
        this.input.forward = Math.min(1, Math.hypot(dx, dz) * 2.5);
        this.input.sneak = false;
      } else this.halt();
      await this.nextTick();
    }
    this.halt();
    return this.phys.y < floorY + 0.5;
  }

  /** Sleep in a bed: a near one, or the one it carries put down where there is room for it. The server skips the
   *  night once half the living players are asleep; it wakes at sunrise, or if something hurts it. */
  async sleep(): Promise<string> {
    if (!this.isNight()) return "you can only sleep at night";
    const beds = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => B.RED_BED + k);
    let bed = this.findBlocks(beds, 16, 1)[0];
    const bedItem = BLOCKS[B.RED_BED].item || B.RED_BED;
    if (!bed && this.has(bedItem)) {
      const fx = Math.floor(this.phys.x);
      const fy = Math.floor(this.phys.y + 0.01);
      const fz = Math.floor(this.phys.z);
      const dirs: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // north, east, south, west (the facings)
      const free = (x: number, y: number, z: number) => !SOLID[this.get(x, y, z)] && !IS_WATER[this.get(x, y, z)] && SOLID[this.get(x, y - 1, z)] === 1;
      search: for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [0, 2], [-2, 0], [0, -2]])
        for (let f = 0; f < 4; f++) {
          const x = fx + ox;
          const z = fz + oz;
          const [dx, dz] = dirs[f];
          if (!free(x, fy, z) || !free(x + dx, fy, z + dz) || (x + dx === fx && z + dz === fz)) continue;
          if (!(await this.hold(bedItem))) break search;
          await this.lookAt(x + 0.5, fy + 0.3, z + 0.5, 12);
          this.send({ t: "place", x, y: fy, z, id: B.RED_BED + f });
          this.swing();
          await this.wait(6);
          if (beds.includes(this.get(x, fy, z))) {
            bed = [x, fy, z];
            break search;
          }
        }
    }
    if (!bed) return "there is no bed here (craft one: bed, from 3 wool and 3 planks)";
    const [bx, by, bz] = bed;
    if (this.reachTo(bx, by, bz) > REACH) await this.goto(bx + 0.5, by, bz + 0.5, 2, { maxMs: 20000, done: () => this.reachTo(bx, by, bz) <= REACH });
    await this.lookAt(bx + 0.5, by + 0.4, bz + 0.5, 12);
    this.send({ t: "use", x: bx, y: by, z: bz });
    for (let k = 0; k < 30 && !this.asleep; k++) await this.nextTick();
    if (!this.asleep) return "couldn't get into bed (monsters nearby, or it's not night)";
    this.action = "asleep in bed";
    while (this.asleep && !this.abort && !this.dead) await this.wait(20);
    if (this.asleep) this.send({ t: "wake" });
    return this.isNight() ? "woke up in the night" : "slept through the night";
  }

  /** Back to the surface, wherever it is underground: out of the pit it is in, then a staircase dug up through the
   *  rock in a straight line, one step at a time, until there is open sky over its head. */
  async digOut(): Promise<string> {
    const startY = this.phys.y;
    // caves usually lead somewhere higher: walk up them first, as far as they go
    for (let k = 0; k < 6 && !this.abort && !this.dead && !this.outInTheOpen(); k++) if (!(await this.walkUp())) break;
    let dir = -1; // the staircase keeps going the same way
    let walls = 0;
    for (let k = 0; k < 140 && !this.abort && !this.dead && !this.outInTheOpen(); k++) {
      const x = Math.floor(this.phys.x);
      const y = Math.floor(this.phys.y + 0.01);
      const z = Math.floor(this.phys.z);
      if (this.inHole() && this.fillerBlock() && !SOLID[this.get(x, y + 2, z)] && (await this.pillarUp(1)) > 0) continue;
      const used = await this.stepUp(dir);
      if (used >= 0) {
        dir = used;
        continue;
      }
      // in the open (a cave floor): go to the nearest wall and cut the stairs into it, toward the wall
      const wall = ++walls > 30 ? -1 : await this.toWall();
      this.debug(`dig_out: no step at y=${y}, wall ${wall}`);
      if (wall < 0) break;
      dir = wall;
    }
    const up = Math.round(this.phys.y - startY);
    if (this.outInTheOpen()) return `back up at the surface${up > 0 ? `, climbed ${up} blocks` : ""}`;
    if (this.surfaced()) return `under the sky but walled in (a ravine or a pit) at y=${Math.floor(this.phys.y)}`;
    return `still underground at y=${Math.floor(this.phys.y)}${up > 0 ? ` (climbed ${up} blocks)` : ""}`;
  }

  /** Walk to the highest spot it can reach on foot from here (a cave's way up). False when nothing is higher. */
  async walkUp(): Promise<boolean> {
    const s = this.pf.search(this.phys.x, this.phys.y, this.phys.z, { hw: 0.3, h: 1.8, maxNodes: 6000, radius: 32, water: false });
    if (!s) return false;
    let best = 0;
    for (let i = 1; i < s.pts.length; i++) {
      const a = s.pts[i];
      const b = s.pts[best];
      if (a.f > b.f + 0.5 || (Math.abs(a.f - b.f) <= 0.5 && s.cost[i] < s.cost[best])) best = i;
    }
    const top = s.pts[best];
    if (top.f < this.phys.y + 1.5) return false;
    const y0 = this.phys.y;
    await this.goto(top.x + 0.5, top.f, top.z + 0.5, 1.2, { maxMs: 30000 });
    return this.phys.y > y0 + 1;
  }

  /** Next to the nearest wall (rock at its feet and head height), for a staircase: returns the direction index of
   *  the wall from where it ends up (as stepUp numbers them), or -1 if there is none near. */
  async toWall(): Promise<number> {
    const fx = Math.floor(this.phys.x);
    const fy = Math.floor(this.phys.y + 0.01);
    const fz = Math.floor(this.phys.z);
    let best: [number, number] | null = null;
    let bd = Infinity;
    for (let dz = -6; dz <= 6; dz++)
      for (let dx = -6; dx <= 6; dx++) {
        const x = fx + dx;
        const z = fz + dz;
        if (!SOLID[this.get(x, fy, z)] || !SOLID[this.get(x, fy + 1, z)] || this.get(x, fy + 1, z) === B.BEDROCK) continue;
        const d = Math.hypot(dx, dz);
        if (d >= 1 && d < bd) {
          bd = d;
          best = [x, z];
        }
      }
    if (!best) return -1;
    const [wx, wz] = best;
    // stand in the cell right beside the wall (on its side facing us), centred, so the first step is that rock
    const dirs: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let pick = -1;
    let pd = Infinity;
    for (let d = 0; d < 4; d++) {
      const ax = wx - dirs[d][0];
      const az = wz - dirs[d][1];
      if (SOLID[this.get(ax, fy, az)] || SOLID[this.get(ax, fy + 1, az)] || !SOLID[this.get(ax, fy - 1, az)]) continue;
      const dd = Math.hypot(ax + 0.5 - this.phys.x, az + 0.5 - this.phys.z);
      if (dd < pd) {
        pd = dd;
        pick = d;
      }
    }
    if (pick < 0) return -1;
    const ax = wx - dirs[pick][0];
    const az = wz - dirs[pick][1];
    await this.goto(ax + 0.5, fy, az + 0.5, 0.8, { maxMs: 12000 });
    if (Math.hypot(ax + 0.5 - this.phys.x, az + 0.5 - this.phys.z) > 1.2) return -1;
    await this.center(ax, az, 20);
    return pick;
  }

  /** Out for real: sky over its head and room to walk away (not the floor of a ravine or a pit). */
  outInTheOpen(): boolean {
    if (!this.surfaced()) return false;
    const s = this.pf.search(this.phys.x, this.phys.y, this.phys.z, { hw: 0.3, h: 1.8, maxNodes: 500, radius: 20, water: false });
    return !!s && s.pts.length >= 200;
  }

  /** Sky over its head (a tree's leaves don't count: nothing solid in the six blocks above). */
  surfaced(): boolean {
    if (!this.covered()) return true;
    const x = Math.floor(this.phys.x);
    const y = Math.floor(this.phys.y + 0.01);
    const z = Math.floor(this.phys.z);
    for (let k = 2; k <= 7; k++) {
      const id = this.get(x, y + k, z);
      if (SOLID[id] && id !== B.OAK_LEAVES && id !== B.BIRCH_LEAVES && id !== B.PALM_LEAVES) return false;
    }
    return true;
  }

  /** Room over its head and a way out sideways: it can walk off. */
  free(): boolean {
    const x = Math.floor(this.phys.x);
    const y = Math.floor(this.phys.y + 0.01);
    const z = Math.floor(this.phys.z);
    return !this.inHole() && !SOLID[this.get(x, y + 2, z)];
  }

  /** One step of a staircase up: clear over its head and the two cells over the block beside it, then jump up onto
   *  that block (with no block there, put one down if it can). Tries `prefer` (a direction index) first; returns the
   *  direction it climbed, or -1. Needs no blocks to spare when the rock is there. */
  async stepUp(prefer = -1): Promise<number> {
    const x = Math.floor(this.phys.x);
    const y = Math.floor(this.phys.y + 0.01);
    const z = Math.floor(this.phys.z);
    const dirs: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const order = prefer >= 0 ? [prefer, ...[0, 1, 2, 3].filter((d) => d !== prefer)] : [0, 1, 2, 3];
    for (const d of order) {
      if (this.abort || this.dead) return -1;
      const [dx, dz] = dirs[d];
      const sx = x + dx;
      const sz = z + dz;
      const wet = [[sx, y + 1, sz], [sx, y + 2, sz], [x, y + 2, z], [sx, y + 3, sz]].some(([cx, cy, cz]) => IS_WATER[this.get(cx, cy, cz)]);
      if (wet) {
        this.debug(`stepUp ${d}: water`);
        continue;
      }
      if (!SOLID[this.get(sx, y, sz)]) {
        // nothing to step onto: build the step, if there is something under it to build on
        const filler = this.fillerBlock();
        if (!filler || !SOLID[this.get(sx, y - 1, sz)] || !(await this.place(filler, sx, y, sz))) {
          this.debug(`stepUp ${d}: no step (filler ${filler}, under solid ${SOLID[this.get(sx, y - 1, sz)]})`);
          continue;
        }
      }
      let blocked = false;
      // a jump up a step needs three blocks of room: over its own head (the top of the jump) and over the step
      for (const [cx, cy, cz] of [[x, y + 2, z], [x, y + 3, z], [sx, y + 1, sz], [sx, y + 2, sz], [sx, y + 3, sz]] as [number, number, number][]) {
        if (SOLID[this.get(cx, cy, cz)] && !(await this.mine(cx, cy, cz, false))) {
          blocked = true; // bedrock, or out of reach: another way round
          break;
        }
      }
      if (blocked) {
        this.debug(`stepUp ${d}: couldn't clear the way`);
        continue;
      }
      for (let t = 0; t < 24 && Math.floor(this.phys.y + 0.01) <= y; t++) {
        const tx = sx + 0.5 - this.phys.x;
        const tz = sz + 0.5 - this.phys.z;
        this.wantYaw = this.input.yaw = (deg(Math.atan2(-tx, tz)) + 360) % 360;
        this.wantPitch = -20; // looking up the stairs
        this.input.forward = 1;
        this.input.jump = true;
        await this.nextTick();
      }
      this.halt();
      if (Math.floor(this.phys.y + 0.01) > y) {
        await this.center(sx, sz, 12); // square on the step, so the next one lines up
        return d;
      }
      this.debug(`stepUp ${d}: the jump didn't land (at ${this.phys.x.toFixed(2)} ${this.phys.y.toFixed(2)} ${this.phys.z.toFixed(2)})`);
    }
    return -1;
  }

  /** Puts on the best armour it carries (the server swaps each better piece in). */
  wearBest(): void {
    this.send({ t: "wear" });
  }

  // ---------------------------------------------------------------- a home

  /** Its house, once it has built one: the room's two standing cells, its doorway, and its floor height. */
  home: { x0: number; z0: number; y: number; door: [number, number, number] } | null = null;

  /** Blocks it can build walls with, and how many it has. */
  buildingBlocks(): { ids: number[]; n: number } {
    const ids = [B.COBBLESTONE, B.OAK_PLANKS, B.BIRCH_PLANKS, B.DIRT, B.STONE, B.SAND, B.STONE_BRICKS, B.BRICKS];
    return { ids, n: ids.reduce((a, id) => a + this.count(id), 0) };
  }

  private nextBuildingBlock(): number {
    for (const id of this.buildingBlocks().ids) if (this.has(id)) return id;
    return 0;
  }

  /** A flat 4 by 4 patch near it (solid level ground, air above, no water close): the north-west corner, or null. */
  private houseSite(): [number, number, number] | null {
    const fx = Math.floor(this.phys.x);
    const fz = Math.floor(this.phys.z);
    const y = Math.floor(this.phys.y + 0.01);
    let best: [number, number, number] | null = null;
    let bd = Infinity;
    for (let oz = -6; oz <= 3; oz++)
      for (let ox = -6; ox <= 3; ox++) {
        const x0 = fx + ox;
        const z0 = fz + oz;
        let ok = true;
        for (let dz = 0; dz < 4 && ok; dz++)
          for (let dx = 0; dx < 4 && ok; dx++) {
            const g = this.get(x0 + dx, y - 1, z0 + dz);
            if (!SOLID[g] || IS_WATER[g] || g === B.OAK_LEAVES || g === B.BIRCH_LEAVES || g === B.PALM_LEAVES) ok = false;
            for (let h = 0; h < 3 && ok; h++) {
              const c = this.get(x0 + dx, y + h, z0 + dz);
              if (SOLID[c] || IS_WATER[c]) ok = false;
            }
          }
        if (!ok || this.waterNear(x0 + 2, y, z0 + 2, 3, 2)) continue;
        const d = Math.hypot(x0 + 2 - this.phys.x, z0 + 2 - this.phys.z);
        if (d < bd) {
          bd = d;
          best = [x0, y, z0];
        }
      }
    return best;
  }

  /** Build a small house: walls two blocks high round a 2 by 2 room, a flat roof, a doorway in the north wall (a door
   *  in it when it has one), a torch and its bed inside. About 38 blocks. Built from inside, so every block is in
   *  reach; it is home from then on. */
  async buildHouse(): Promise<string> {
    const have = this.buildingBlocks().n;
    if (have < 38) return `a house takes about 38 blocks (cobblestone, planks or dirt) and you have ${have}`;
    const site = this.houseSite();
    if (!site) return "there's no flat open ground here for a house (4 by 4): try somewhere flatter";
    const [x0, y, z0] = site;
    const door: [number, number, number] = [x0 + 1, y, z0];
    // into the room first (it builds round itself)
    await this.goto(x0 + 2, y, z0 + 2, 0.5, { maxMs: 20000, done: () => Math.floor(this.phys.x) >= x0 + 1 && Math.floor(this.phys.x) <= x0 + 2 && Math.floor(this.phys.z) >= z0 + 1 && Math.floor(this.phys.z) <= z0 + 2 });
    await this.center(x0 + 2, z0 + 2, 20);
    const ring: [number, number][] = [];
    for (let dx = 0; dx < 4; dx++) ring.push([x0 + dx, z0], [x0 + dx, z0 + 3]);
    for (let dz = 1; dz < 3; dz++) ring.push([x0, z0 + dz], [x0 + 3, z0 + dz]);
    let placed = 0;
    const put = async (x: number, yy: number, z: number): Promise<void> => {
      if (this.abort || this.dead || SOLID[this.get(x, yy, z)]) return;
      const id = this.nextBuildingBlock();
      if (id && (await this.place(id, x, yy, z))) placed++;
    };
    this.action = "building a house";
    for (const h of [0, 1]) for (const [x, z] of ring) if (!(x === door[0] && z === door[2])) await put(x, y + h, z);
    for (const [x, z] of ring) await put(x, y + 2, z); // the roof's edge on the walls first
    for (let dz = 1; dz < 3; dz++) for (let dx = 1; dx < 3; dx++) await put(x0 + dx, y + 2, z0 + dz);
    if (this.abort || this.dead) return `stopped building (${placed} blocks down)`;
    const doorItem = BLOCKS[B.OAK_DOOR]?.item || B.OAK_DOOR;
    if (this.has(doorItem)) {
      await this.hold(doorItem);
      await this.lookAt(door[0] + 0.5, y + 0.5, door[2] + 0.5, 12);
      this.send({ t: "place", x: door[0], y, z: door[2], id: B.OAK_DOOR + 2 });
      this.swing();
      await this.wait(6);
    }
    this.home = { x0, z0, y, door };
    // a light, and the bed, in the room's far side (it stands by the door)
    if (this.has(B.TORCH) && !SOLID[this.get(x0 + 1, y, z0 + 2)]) await this.place(B.TORCH, x0 + 1, y, z0 + 2);
    const bedItem = BLOCKS[B.RED_BED].item || B.RED_BED;
    if (this.has(bedItem)) {
      await this.hold(bedItem);
      await this.lookAt(x0 + 2.5, y + 0.3, z0 + 2.5, 12);
      this.send({ t: "place", x: x0 + 2, y, z: z0 + 2, id: B.RED_BED + 2 }); // facing south: the head in the last row... or the wall stops it
      this.swing();
      await this.wait(6);
    }
    const walls = ring.length * 2 - 2 + 16;
    const doorIn = this.get(door[0], y, door[2]) >= B.OAK_DOOR && this.get(door[0], y, door[2]) < B.OAK_DOOR + 16;
    return `built a house at x=${x0 + 1} z=${z0 + 1} (${placed} of ${walls} blocks placed, ${doorIn ? "with a door" : "an open doorway on the north side"})`;
  }

  /** Inside its house: in the room. */
  atHome(): boolean {
    const h = this.home;
    if (!h) return false;
    const x = Math.floor(this.phys.x);
    const z = Math.floor(this.phys.z);
    return x >= h.x0 + 1 && x <= h.x0 + 2 && z >= h.z0 + 1 && z <= h.z0 + 2 && Math.abs(this.phys.y - h.y) < 1;
  }

  /** Back home for the night: walk in, block the doorway behind it if there's no door, sleep if there's a bed. */
  async goHome(): Promise<string> {
    const h = this.home;
    if (!h) return "you have no house yet (build_house)";
    if (!this.atHome()) {
      await this.goto(h.x0 + 1.5, h.y, h.z0 + 1.5, 0.6, { maxMs: 60000, done: () => this.atHome() });
      if (!this.atHome()) return "couldn't get back into your house";
    }
    const [dx, dy, dz] = h.door;
    if (this.get(dx, dy, dz) === B.AIR || this.get(dx, dy + 1, dz) === B.AIR) {
      // no door: close the doorway with two blocks (taken out again in the morning)
      await this.center(h.x0 + 2, h.z0 + 2, 20);
      for (const yy of [dy, dy + 1]) if (!SOLID[this.get(dx, yy, dz)] && this.nextBuildingBlock()) await this.place(this.nextBuildingBlock(), dx, yy, dz);
    }
    if (this.isNight() && this.findBlocks([0, 1, 2, 3, 4, 5, 6, 7].map((k) => B.RED_BED + k), 3, 1).length) return `home, door shut: ${await this.sleep()}`;
    return "home, with the door shut";
  }

  /** Out of the house in the morning: open the doorway if it was blocked up. */
  async leaveHome(): Promise<string> {
    const h = this.home;
    if (!h || !this.atHome()) return "not at home";
    const [dx, dy, dz] = h.door;
    for (const yy of [dy + 1, dy]) {
      const id = this.get(dx, yy, dz);
      if (SOLID[id] && !(id >= B.OAK_DOOR && id < B.OAK_DOOR + 16)) await this.mine(dx, yy, dz, false);
    }
    await this.goto(dx + 0.5, dy, dz - 1.5, 0.8, { maxMs: 8000 });
    return "out of the house";
  }
}
