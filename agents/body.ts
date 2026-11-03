// clankersmp: an AI's body in the game. A headless client on the same protocol as the browser game: it builds the
// same world from the seed (shared/worldgen.ts) and keeps it current, moves with the shared physics 20 times a
// second, and acts only through the messages a player's own client sends (dig, place, hit, eat, craft). Its eyes
// turn smoothly, never snap: spectators watch the world through them. The brain (brain.ts) runs its skills one at a
// time; reflexes (guard) can cut a skill short to fight, flee, eat or dig in.

import WebSocket from "ws";
import { inflateRawSync } from "node:zlib";
import { EYE_HEIGHT, PROTOCOL_NAME, PROTOCOL_VERSION, SPAWN_X, SPAWN_Z, WORLD_SIZE, idx, inWorld } from "../shared/constants.ts";
import { HUB_R } from "../shared/hub12.ts";
import { FLAG, OP, decodeBlocks, decodePlayers, encodeMove, readBlockEntries, type S2C, type Stats } from "../shared/protocol.ts";
import { OP_ANIMALS, OP_ANIMALS_GONE, SPECS as ANIMAL_SPECS, decodeAnimals, decodeGone } from "../shared/animals.ts";
import { OP_ITEMS, OP_ITEMS_GONE, OP_ITEM_PICKUP, decodeIds, decodeItems, decodePickups, type ItemSnap } from "../shared/drops.ts";
import { ARROW_DRAG, ARROW_GRAVITY, MF, MOB_SPECS, OP_MOBS, OP_MOBS_GONE, meleeReachSq } from "../shared/mobs.ts";
import { generateWorld, hashBlocks, type GenInfo } from "../shared/worldgen.ts";
import { newPhysState, tickPlayer, type MoveInput, type PhysState } from "../shared/physics.ts";
import { PathFinder, type PathPoint } from "../server/src/pathfind.ts";
import { breakTicks } from "../shared/mining.ts";
import { B, BLOCKS, IS_WATER, OPAQUE, SOLID, isFarmland, isFurnace, isStorage as isStorageId } from "../shared/blocks.ts";
import { I, fromWire, isHoe as isHoeId, itemDef, type Stack } from "../shared/items.ts";
import { canHarvest } from "../shared/mining.ts";
import { BOW_SPEED, cooldownTicks } from "../shared/combat.ts";
import { EAT_TICKS } from "../shared/survival.ts";
import { RECIPES, recipeNeeds, recipeSize } from "../shared/recipes.ts";
import { JOBS } from "../shared/villagers.ts";
import { door, isBed, isDoor } from "../shared/shapes.ts";
import { accepts, cellTarget, itemOf } from "./civ.ts";

interface VillagerOffers {
  vid: number;
  name: string;
  job: number;
  x: number;
  y: number;
  z: number;
  offers: { a: [number, number]; b?: [number, number]; r: [number, number]; n: number; m: number }[];
}
export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}
/** One cell of a building plan: where, and what goes there (b building block, t torch, f fence, g glass, c chest). */
export type PlanCell = [number, number, number, string];

/** The spawn hub (its plaza, paths, boards and monument) is the world's landmark and is never dug up: sonnet
 *  staircase-mined for cobblestone 49 blocks from spawn on day 1 of season 7 and tore up its paths. */
export const inHub = (x: number, z: number) => Math.hypot(x + 0.5 - SPAWN_X, z + 0.5 - SPAWN_Z) < HUB_R + 4;

/** Town building materials: stone walls, wooden corners, trim and roofs. Dirt, sand and whatever was growing there
 *  never stay in a town building above the ground: they get dug out and the right block goes in. */
const STONES = [B.STONE_BRICKS, B.COBBLESTONE, B.STONE, B.BRICKS];
const WOODS = [B.OAK_PLANKS, B.BIRCH_PLANKS];
const ROUGH = new Set<number>([B.DIRT, B.GRASS, B.SAND, B.GRAVEL, B.OAK_LEAVES, B.BIRCH_LEAVES, B.PALM_LEAVES, B.OAK_LOG, B.BIRCH_LOG, B.PALM_LOG]);
const GROUND = new Set<number>([B.GRASS, B.DIRT, B.SAND, B.GRAVEL, B.CLAY, B.STONE] as number[]);
/** Stray building blocks: inside a town building's room they are in the way (a pillar left from building the roof). */
const CLUTTER = new Set<number>([B.COBBLESTONE, B.STONE, B.OAK_PLANKS, B.BIRCH_PLANKS, B.STONE_BRICKS, B.MOSSY_COBBLE, B.MOSSY_STONE_BRICKS, B.BRICKS, B.GLASS] as number[]);
/** Never dug out of the way of a plan: somebody's chest, bed or furnace (and what's in it). */
const KEEP = (id: number) => isStorageId(id) || isBed(id) || isFurnace(id);
const TREE = new Set<number>([B.OAK_LEAVES, B.BIRCH_LEAVES, B.PALM_LEAVES, B.OAK_LOG, B.BIRCH_LOG, B.PALM_LOG]);
const itemName = (id: number) => itemDef(id)?.key ?? BLOCKS[id]?.key ?? `item ${id}`;

export const NIGHT_START = 12542;
export const NIGHT_END = 23459;
/** Ground and plants it may dig straight through when they block its way (never what someone built). */
const NATURAL = new Set<number>([B.OAK_LEAVES, B.BIRCH_LEAVES, B.PALM_LEAVES, B.DIRT, B.GRASS, B.SAND, B.GRAVEL, B.CLAY, B.STONE] as number[]);
const REACH = 4.3; // a little inside the server's 5 (eye to block centre)
// The cell its feet are in is floor(y + 0.1), not floor(y): farmland and dirt paths are a pixel low (their top at
// .9375), and floor(y + 0.01) there took the ground itself for the feet cell (nudge then dug holes in the farm).
const HIT_REACH = 2.9;

/** One world for every body in this process: the same seed, the same edits (each body applies them; idempotent). */
let shared: { key: string; blocks: Uint8Array; hash: number; info: GenInfo } | null = null;

export interface Seen {
  id: number;
  kind: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  flags: number;
  at: number;
  /** v13: how it's moving (blocks a tick, from its last snapshots): where an arrow has to lead it. */
  vx?: number;
  vz?: number;
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
  /** What the world holds beyond the land: which village sites were built, the islands' treasure, the harbour. */
  world: { villages: number[]; info: GenInfo } | null = null;
  /** Agent-only requests waiting for the server's one answer, by the answer's type. */
  private answers = new Map<string, (m: unknown) => void>();
  /** Chests it has emptied (or found empty): not walked back to. */
  private looted = new Set<number>();
  /** v13: told when one of its hits or arrows lands (the server's "struck"). */
  onStruck = new Set<(m: { id: number; mob: boolean; dmg: number; crit: boolean; kills: boolean }) => void>();

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
          shared = { key, blocks: gen.blocks, hash: hashBlocks(gen.blocks), info: gen.info };
        }
        this.blocks = shared.blocks;
        this.world = { villages: (m.villages ?? []) as number[], info: shared.info };
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
      case "looted":
      case "atrades":
      case "atraded": {
        const f = this.answers.get(m.t);
        this.answers.delete(m.t);
        f?.(m);
        break;
      }
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
      case "struck":
        // v13: one of its hits (or arrows) landed: what it did
        for (const f of this.onStruck) f(m);
        break;
      case "enchanted": {
        const f = this.answers.get(m.t);
        this.answers.delete(m.t);
        f?.(m);
        break;
      }
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
      for (const a of decodeAnimals(view).list) {
        // its speed from the last snapshot (smoothed): what an arrow has to lead
        const was = map.get(a.id);
        const dt = was ? (now - was.at) / 50 : 0;
        const vx = was && dt >= 0.5 && dt < 20 ? 0.5 * (was.vx ?? 0) + (0.5 * (a.x - was.x)) / dt : (was?.vx ?? 0);
        const vz = was && dt >= 0.5 && dt < 20 ? 0.5 * (was.vz ?? 0) + (0.5 * (a.z - was.z)) / dt : (was?.vz ?? 0);
        map.set(a.id, { ...a, at: now, vx, vz });
      }
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

  /** Nearly full, it loses what it crafts or mines (opus crafted a crafting table three times at 36 of 36 slots and
   *  it was gone each time): throw out the least useful stacks until a few slots are free. What it threw, or "". */
  async tidyInventory(free = 5): Promise<string> {
    const used = () => this.inv.filter(Boolean).length;
    if (this.inv.length - used() >= free) return "";
    // least useful first, and how many of each to keep
    const order: [RegExp, number][] = [
      [/^spoiled_flesh$|^poppy$|^dandelion$|^bluebell$|flower|^tall_grass$|_leaves$/, 0],
      [/_sapling$/, 0],
      [/^gravel$/, 0],
      // (v14: a few kept: string makes a bow, flint and feathers arrows, bones bone meal)
      [/^flint$|^feather$/, 16],
      [/^string$|^bone$/, 8],
      [/^sand$/, 0],
      [/^dirt$/, 32],
      [/^wheat_seeds$/, 16],
      [/^cobblestone$/, 128],
    ];
    const thrown = new Map<string, number>();
    // throw it out ahead and up, then step back out of reach: dropped at its feet, it picked it all straight back up
    const a = (this.yaw * Math.PI) / 180;
    await this.lookAt(this.phys.x - Math.sin(a) * 4, this.phys.y + 2.6, this.phys.z + Math.cos(a) * 4, 10);
    for (const [re, keep] of order) {
      for (let k = 0; k < 12 && this.inv.length - used() < free && !this.abort; k++) {
        const id = this.inv.find((s) => s && re.test(itemName(s.id)) && this.count(s.id) > keep)?.id;
        if (id === undefined) break;
        const before = this.count(id);
        if (!(await this.hold(id))) break;
        this.send({ t: "drop", all: true });
        await this.wait(3);
        const went = before - this.count(id);
        if (went <= 0) break;
        thrown.set(itemName(id), (thrown.get(itemName(id)) ?? 0) + went);
      }
    }
    if (thrown.size) await this.goto(this.phys.x + Math.sin(a) * 5, this.phys.y, this.phys.z - Math.cos(a) * 5, 1, { maxMs: 5000 });
    return [...thrown].map(([k, n]) => `${n} ${k}`).join(", ");
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
    for (let y = Math.floor(this.phys.y + 0.1) + 2; y < 128; y++) if (SOLID[this.get(x, y, z)]) return true;
    return false;
  }

  /** Walls on every side at foot and head height, and a roof: nothing can get in. */
  sealed(): boolean {
    const x = Math.floor(this.phys.x);
    const y = Math.floor(this.phys.y + 0.1);
    const z = Math.floor(this.phys.z);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]])
      for (const dy of [0, 1]) if (!SOLID[this.get(x + dx, y + dy, z + dz)] && !this.closedNook(x + dx, y + dy, z + dz, dx, dz)) return false;
    return SOLID[this.get(x, y + 2, z)] === 1;
  }

  /** A torch in a nook dug one block into the wall (lightUp's), shut in by rock on every other side: as good as
   *  closed. (Counted as a gap, every dig_in with a torch said the hole wasn't closed, and it dug in again.) */
  private closedNook(x: number, y: number, z: number, dx: number, dz: number): boolean {
    if (this.get(x, y, z) !== B.TORCH) return false;
    const round: [number, number, number][] = [[x + dx, y, z + dz], [x + dz, y, z + dx], [x - dz, y, z - dx], [x, y + 1, z]];
    return round.every(([a, b, c]) => SOLID[this.get(a, b, c)] === 1);
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
    this.input.jump = (floorY - this.phys.y > 0.55 && d < 1.8) || (this.phys.collidedH && this.phys.onGround && this.stepAhead()) || this.phys.inWater;
    this.input.sprint = far > 7 && off < 20 && this.stats.food > 6 && !this.phys.inWater;
    // on dry land it never walks into water (ponds with steep banks are traps): only a swimmer swims; and never off a
    // ledge higher than it can take (a fall of more than 3 blocks hurts, and on low health any fall can kill)
    if (!this.phys.inWater && (this.waterAhead() || this.dropAhead() > (this.stats.hp <= 6 ? 1 : 3))) {
      this.input.forward = 0;
      this.input.sprint = false;
    }
  }

  /** A one-block step just ahead (a block at its feet with room for the body above it): the only bump worth a jump.
   *  Walls, fences, players and half-built houses are walked round or dug through, never hopped at. */
  private stepAhead(): boolean {
    const a = (this.input.yaw * Math.PI) / 180;
    const y = Math.floor(this.phys.y + 0.01);
    for (const reach of [0.5, 0.9]) {
      const x = Math.floor(this.phys.x - Math.sin(a) * reach);
      const z = Math.floor(this.phys.z + Math.cos(a) * reach);
      if (SOLID[this.get(x, y, z)] && !SOLID[this.get(x, y + 1, z)] && !SOLID[this.get(x, y + 2, z)]) return true;
    }
    return false;
  }

  /** How far down the ground is just ahead (0 when it's level or higher; up to 8). */
  private dropAhead(): number {
    if (!this.phys.onGround) return 0;
    const a = (this.input.yaw * Math.PI) / 180;
    const y = Math.floor(this.phys.y + 0.1);
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
    const y = Math.floor(this.phys.y + 0.1);
    for (const reach of [0.6, 1.1]) {
      const x = Math.floor(this.phys.x - Math.sin(a) * reach);
      const z = Math.floor(this.phys.z + Math.cos(a) * reach);
      if (IS_WATER[this.get(x, y, z)] || (IS_WATER[this.get(x, y - 1, z)] && !SOLID[this.get(x, y, z)])) return true;
    }
    return false;
  }

  private plan(x: number, y: number, z: number): PathPoint[] | null {
    // around water, not through it (a swim is slow and ends in flooded holes), unless it's already swimming
    // room to find the way round a ridge or a ravine on a long walk home (5000 nodes in 40 blocks gave up at 38 out)
    const far = Math.hypot(x - this.phys.x, z - this.phys.z) > 24;
    // the height counts too: aimed only at the column, haiku "got home" to a cave ten blocks under its house and opus
    // "built" the watchtower from a tunnel under it
    // (no height known, NaN: the column alone, as before)
    const gy = Number.isFinite(y) ? y : undefined;
    const s = this.pf.search(this.phys.x, this.phys.y, this.phys.z, { hw: 0.3, h: 1.8, maxNodes: far ? 14000 : 5000, radius: far ? 64 : 40, water: this.phys.inWater, aim: true }, { x: Math.floor(x), z: Math.floor(z), y: gy });
    if (!s) return null;
    const i = s.reached >= 0 ? s.reached : s.closestTo(x, z, gy);
    return s.pathTo(i);
  }

  /** Walk to within `range` of a point (or until `done()`), replanning as it goes. False if it couldn't. */
  async goto(x: number, y: number, z: number, range = 1.5, opts: { maxMs?: number; done?: () => boolean } = {}): Promise<boolean> {
    const t0 = Date.now();
    const maxMs = opts.maxMs ?? 60000;
    const arrived = () => (opts.done ? opts.done() : Math.hypot(x - this.phys.x, z - this.phys.z) <= range && Math.abs(y - this.phys.y) < 3);
    let best = Infinity;
    let fails = 0;
    let unstuck = false;
    // setting off from inside its own house: open the doorway first (blocked up for the night, or a shut door), or
    // every way out is a wall it won't dig through
    if (this.home && this.atHome() && Math.hypot(x - this.homeMiddle()[0], z - this.homeMiddle()[1]) > 1.5) await this.openDoorway();
    while (!this.abort && !this.dead && Date.now() - t0 < maxMs) {
      if (arrived()) break;
      const d = Math.hypot(x - this.phys.x, z - this.phys.z);
      if (d < best - 0.5) {
        best = d;
        fails = 0;
      } else if (++fails > 3) {
        // the same spot four times over: shake loose once (dig through, step round, climb out), then give up
        if (unstuck) break;
        unstuck = true;
        fails = 0;
        // shut in by a closed door (haiku slept in a village house's bed and couldn't get out in the morning): open it
        if (await this.openNearbyDoors()) continue;
        await this.nudge(x, z);
        await this.unstick();
        continue;
      }
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
    let nudges = 0;
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
      } else if (this.tick - since > 24) {
        // up against something: dig through soft blocks or step round, then carry on along the same path
        if (nudges++ < 2 && (await this.nudge(t.x + 0.5, t.z + 0.5))) {
          best = Infinity;
          since = this.tick;
          continue;
        }
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
    const y = Math.floor(f + 0.1);
    for (let s = 0.4; s < len; s += 0.4) {
      const px = sx + ((x - sx) * s) / len;
      const pz = sz + ((z - sz) * s) / len;
      for (const [ox, oz] of [[0, 0], [0.36, 0.36], [-0.36, 0.36], [0.36, -0.36], [-0.36, -0.36]]) {
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

  /** Blocked on the way to (tx, tz): dig through what's in the way if it's quick to break (leaves, dirt, sand, wood,
   *  stone with a pickaxe), the way a player does; otherwise back off a step and slide to the side with room. True if
   *  it changed something. */
  private async nudge(tx: number, tz: number): Promise<boolean> {
    const dx = tx - this.phys.x;
    const dz = tz - this.phys.z;
    const d = Math.hypot(dx, dz) || 1;
    const ux = dx / d;
    const uz = dz / d;
    const fy = Math.floor(this.phys.y + 0.1);
    const cx = Math.floor(this.phys.x + ux * 0.8);
    const cz = Math.floor(this.phys.z + uz * 0.8);
    const wet = (x: number, y: number, z: number) => [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].some(([a, b, c]) => IS_WATER[this.get(x + a, y + b, z + c)]);
    let dug = false;
    if (fy > 30) {
      for (const y of [fy + 1, fy]) {
        const id = this.get(cx, y, cz);
        if (!SOLID[id] || !NATURAL.has(id) || wet(cx, y, cz)) continue; // never through walls someone built
        const t = breakTicks(id, this.bestToolFor(id));
        if (t >= 0 && t <= 40 && (await this.mine(cx, y, cz, false))) dug = true;
      }
    }
    if (dug) return true;
    // back off and slide sideways, toward whichever side has room for a body
    const free = (x: number, z: number) => !SOLID[this.get(Math.floor(x), fy, Math.floor(z))] && !SOLID[this.get(Math.floor(x), fy + 1, Math.floor(z))] && SOLID[this.get(Math.floor(x), fy - 1, Math.floor(z))] === 1;
    const sides: [number, number][] = [[-uz, ux], [uz, -ux]];
    sides.sort(() => Math.random() - 0.5);
    const x0 = this.phys.x;
    const z0 = this.phys.z;
    for (const [px, pz] of sides) {
      const sx = x0 - ux * 0.7 + px * 1.2;
      const sz = z0 - uz * 0.7 + pz * 1.2;
      if (!free(sx, sz)) continue;
      await this.walkStraight(sx, sz, 16, () => Math.hypot(sx - this.phys.x, sz - this.phys.z) < 0.4);
      if (Math.hypot(this.phys.x - x0, this.phys.z - z0) > 0.6) return true;
    }
    return false;
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
    const y = Math.floor(this.phys.y + 0.1) + 1;
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
      const y0 = Math.floor(this.phys.y + 0.1);
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
      if (Math.floor(this.phys.y + 0.1) > y0) up++;
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
    // v14: into the spare place on the hotbar (8), so the weapon, the tools, the food and the blocks keep theirs
    if (this.sel !== 8) {
      this.sel = 8;
      this.send({ t: "sel", s: 8 });
      await this.nextTick();
    }
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

  /** Well armoured (iron or better on most of the body) with a real sword or axe: it can take a monster on rather
   *  than hide from it (opus dug in from a rattler in full iron with an iron sword). */
  strong(): boolean {
    const armor = this.armor.reduce((n, st) => n + ((st && itemDef(st.id)?.armor?.points) || 0), 0);
    const w = this.bestWeapon();
    return armor >= 12 && !!w && (itemDef(w)?.tool?.damage ?? 0) >= 5;
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
  /** How many blocks round it are open (the roof and both levels of the four sides): what sealing in needs. */
  openGaps(): number {
    const x = Math.floor(this.phys.x), y = Math.floor(this.phys.y + 0.1), z = Math.floor(this.phys.z);
    let n = SOLID[this.get(x, y + 2, z)] ? 0 : 1;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1]) if (!SOLID[this.get(x + dx, y + dy, z + dz)]) n++;
    return n;
  }

  /** Blocks it carries that fillerBlock() would use. */
  fillerCount(): number {
    return [B.DIRT, B.COBBLESTONE, B.SAND, B.GRAVEL, B.OAK_PLANKS, B.BIRCH_PLANKS, B.STONE].reduce((t, id) => t + (id !== undefined ? this.count(id) : 0), 0);
  }

  fillerBlock(): number {
    for (const id of [B.DIRT, B.COBBLESTONE, B.SAND, B.GRAVEL, B.OAK_PLANKS, B.BIRCH_PLANKS, B.STONE]) if (id !== undefined && this.has(id)) return id;
    return 0;
  }

  /** Mine one block: walk into reach, the best tool, look at it, dig for as long as it takes, then make sure it went. */
  async mine(x: number, y: number, z: number, approach = true): Promise<boolean> {
    if (inHub(x, z) && y >= (this.world?.info.spawnHeight ?? 0) - 6) return false;
    const id = this.get(x, y, z);
    if (id === B.AIR || IS_WATER[id] || BLOCKS[id]?.breakTicks < 0) return false;
    if (this.reachTo(x, y, z) > REACH) {
      if (!approach) return false;
      const flat = () => Math.hypot(x + 0.5 - this.phys.x, z + 0.5 - this.phys.z);
      const near = () => flat() < 2.6;
      // something underground: stop a step back from it (as far out as it is deep), then go down a staircase to it,
      // the way a player does; a straight shaft is the last resort (it means climbing out on a pillar after)
      const deep = () => y < this.phys.y - 2;
      let ok = await this.goto(x + 0.5, y, z + 0.5, 2, { maxMs: 15000, done: () => this.reachTo(x, y, z) <= REACH || (deep() && flat() <= Math.max(2.6, this.phys.y - y + 1)) });
      if (!ok || this.reachTo(x, y, z) > REACH) {
        ok = deep() && flat() < 16 && (await this.tunnelTo(x, y, z));
        if (!ok) ok = deep() && near() && (await this.digDownTo(x, y, z));
        if (!ok && flat() < 12) ok = await this.tunnelTo(x, y, z);
      }
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
      const fy = Math.floor(this.phys.y + 0.1) - 1;
      if (fy <= y || fy <= 30) return this.reachTo(x, y, z) <= REACH; // level with it, or as deep as it goes (the deep caves are deadly)
      const id = this.get(fx, fy, fz);
      if (IS_WATER[id] || id === B.BEDROCK) return false;
      if (!SOLID[this.get(fx, fy - 1, fz)] && !SOLID[this.get(fx, fy - 2, fz)] && !SOLID[this.get(fx, fy - 3, fz)]) return false;
      if (id !== B.AIR && !(await this.mine(fx, fy, fz, false))) return false;
      await this.dropInto(fx, fy, fz);
    }
    return this.reachTo(x, y, z) <= REACH;
  }

  /** Dig a walkway two blocks high toward a block it can't walk to, a step at a time, until it's in reach: ore inside
   *  a hillside. Up or down a step at a time toward its height; never into water or below y 30. */
  async tunnelTo(x: number, y: number, z: number): Promise<boolean> {
    for (let k = 0; k < 16 && !this.abort && !this.dead; k++) {
      if (this.reachTo(x, y, z) <= REACH) return true;
      const fx = Math.floor(this.phys.x);
      const fz = Math.floor(this.phys.z);
      const fy = Math.floor(this.phys.y + 0.1);
      const dx = x + 0.5 - this.phys.x;
      const dz = z + 0.5 - this.phys.z;
      const [sx, sz] = Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx), 0] : [0, Math.sign(dz)];
      if (!sx && !sz) break;
      const nx = fx + sx;
      const nz = fz + sz;
      const ny = y > fy + 1 ? fy + 1 : y < fy - 1 && fy - 1 > 31 ? fy - 1 : fy;
      if (ny > fy) {
        const h = this.get(fx, fy + 2, fz);
        if (IS_WATER[h]) return false;
        if (SOLID[h] && !(await this.mine(fx, fy + 2, fz, false))) return false;
      }
      // a step down is cut three high (the cell over its head as well), or the ceiling stops the jump back up and
      // the way down is a trap: a player cuts stairs the same way
      for (const cy of ny < fy ? [ny + 2, ny + 1, ny] : [ny + 1, ny]) {
        const c = this.get(nx, cy, nz);
        if (IS_WATER[c] || c === B.BEDROCK) return false;
        if (SOLID[c] && !(await this.mine(nx, cy, nz, false))) return false;
      }
      if (IS_WATER[this.get(nx, ny + 2, nz)]) return false;
      if (!SOLID[this.get(nx, ny - 1, nz)]) {
        const f = this.fillerBlock();
        if (!f || !(await this.place(f, nx, ny - 1, nz))) return false;
      }
      // down a step: centre over it and drop (walking tiptoes at ledges); level or up: walk (it jumps the step)
      if (ny < fy) await this.dropInto(nx, ny, nz);
      else await this.goto(nx + 0.5, ny, nz + 0.5, 0.45, { maxMs: 3000 });
      if (Math.floor(this.phys.x) === fx && Math.floor(this.phys.z) === fz) return this.reachTo(x, y, z) <= REACH;
    }
    return this.reachTo(x, y, z) <= REACH;
  }

  /** A spot to stand on with a cell in reach: solid underfoot, room for its body, not the cell itself; the nearest to
   *  it first. A wall's top or a roof's edge is in the air: walking at the cell itself, the path search aimed at a
   *  point it could never stand on and gave up ("out of reach" for the top of the town hall's front wall). */
  standFor(x: number, y: number, z: number, avoid?: Set<string>): [number, number, number] | null {
    let best: [number, number, number] | null = null;
    let bd = Infinity;
    for (let dz = -3; dz <= 3; dz++)
      for (let dx = -3; dx <= 3; dx++)
        for (let sy = y - 5; sy <= y + 1; sy++) {
          const sx = x + dx;
          const sz = z + dz;
          if (dx === 0 && dz === 0 && sy >= y - 1 && sy <= y) continue;
          // never in a cell of the building itself (a window still open, the top of a wall): a block goes in there
          // later and it's shut in (opus stood in the town hall's window when the glass went in, and stayed there)
          if (avoid && (avoid.has(`${sx},${sy},${sz}`) || avoid.has(`${sx},${sy + 1},${sz}`))) continue;
          if (!SOLID[this.get(sx, sy - 1, sz)] || SOLID[this.get(sx, sy, sz)] || SOLID[this.get(sx, sy + 1, sz)] || IS_WATER[this.get(sx, sy, sz)]) continue;
          if (Math.hypot(sx + 0.5 - (x + 0.5), sy + EYE_HEIGHT - (y + 0.5), sz + 0.5 - (z + 0.5)) > REACH - 0.3) continue;
          const d = Math.hypot(sx + 0.5 - this.phys.x, sy - this.phys.y, sz + 0.5 - this.phys.z);
          if (d < bd) {
            bd = d;
            best = [sx, sy, sz];
          }
        }
    return best;
  }

  /** Put a block from the inventory into a cell (in reach, next to something solid, not where it stands). */
  async place(item: number, x: number, y: number, z: number, walkMs = 20000, state?: number, avoid?: Set<string>): Promise<boolean> {
    if (!this.has(item)) return false;
    const cur = this.get(x, y, z);
    if (cur !== B.AIR && !IS_WATER[cur] && !BLOCKS[cur]?.replaceable) return false;
    if (this.reachTo(x, y, z) > REACH) {
      const inReach = () => this.reachTo(x, y, z) <= REACH;
      const spot = this.standFor(x, y, z, avoid);
      let ok = !!spot && (await this.goto(spot[0] + 0.5, spot[1], spot[2] + 0.5, 0.5, { maxMs: walkMs, done: inReach }));
      if (!ok && !this.abort) ok = await this.goto(x + 0.5, y, z + 0.5, 2.5, { maxMs: walkMs, done: inReach });
      if (!ok) return false;
    }
    if (!(await this.hold(item))) return false;
    await this.lookAt(x + 0.5, y + 0.5, z + 0.5, 15);
    const id = state ?? (itemDef(item)?.block || item);
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
    const fy = Math.floor(this.phys.y + 0.1);
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

  /** The nearest grove: a log of these ids with at least `min` more round it (within 5 across, 8 up or down), out to
   *  `radius`, leaving out the spots `skip` says (the town, the villages). With no grove, the nearest tree: the
   *  woods round season 8's town are thin, single oaks more than 5 apart, and sonnet came back with nothing. */
  findGrove(ids: number[], radius: number, skip?: (x: number, z: number) => boolean, min = 6): [number, number, number] | null {
    const logs = this.findBlocks(ids, radius, 1500).filter(([x, , z]) => !skip?.(x, z));
    for (const [x, y, z] of logs) {
      let n = 0;
      for (const [ox, oy, oz] of logs) if (Math.abs(ox - x) <= 5 && Math.abs(oz - z) <= 5 && Math.abs(oy - y) <= 8 && ++n > min) return [x, y, z];
    }
    return logs[0] ?? null;
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

  /** One agent-only request and the server's answer to it (or `fallback` if none comes). */
  private ask<T>(msg: Record<string, unknown>, answer: string, fallback: T, ms = 3000): Promise<T> {
    return new Promise<T>((res) => {
      const f = (m: unknown) => res(m as T);
      this.answers.set(answer, f);
      setTimeout(() => {
        if (this.answers.get(answer) === f) this.answers.delete(answer);
        res(fallback);
      }, ms);
      this.send(msg as never);
    });
  }

  /** v13: enchant what it holds (or the armour worn in `slot`) at the enchanting table within reach: the server's
   *  answer (id 0, and why, when nothing happened). */
  async enchantHeld(level: number, slot = -1): Promise<{ id: number; l: number; cost: number; why?: string }> {
    const r = await this.ask({ t: "enchant", l: level, ...(slot >= 0 ? { a: slot } : {}) }, "enchanted", { id: 0, l: 0, cost: 0, why: "no answer from the server" });
    await this.wait(4); // the slots come with the server's next tick
    return r;
  }

  /** Walk to the nearest chest it hasn't emptied yet (village houses and the islands have them) and take everything. */
  async lootChest(radius = 48): Promise<string> {
    const ids = [0, 1, 2, 3].map((k) => B.CHEST + k).concat([B.BARREL]);
    const found = this.findBlocks(ids, radius, 12).filter(([x, y, z]) => !this.looted.has(idx(x, y, z)));
    if (!found.length) return `no chest within ${radius} blocks that you haven't emptied (the villages' houses have them)`;
    for (const [x, y, z] of found.slice(0, 3)) {
      if (this.abort || this.dead) return "interrupted";
      const cell = idx(x, y, z);
      const inReach = () => this.reachTo(x, y, z) <= REACH - 0.3;
      if (!inReach()) await this.goto(x + 0.5, y, z + 0.5, 1.5, { maxMs: 30000, done: inReach });
      if (!inReach()) {
        this.looted.add(cell);
        continue;
      }
      this.halt();
      await this.lookAt(x + 0.5, y + 0.5, z + 0.5, 10);
      this.action = "opening a chest";
      const r = await this.ask<{ got: [number, number][]; why?: string }>({ t: "aloot" }, "looted", { got: [], why: "no answer from the server" });
      if (r.why !== "no room in your inventory") this.looted.add(cell);
      if (r.got.length) return `opened the chest at ${x} ${y} ${z} and took ${r.got.map(([id, n]) => `${n} ${itemName(id)}`).join(", ")}`;
      if (r.why === "no room in your inventory") return "the chest has things in it but your inventory is full";
    }
    return "the chests you reached were empty";
  }

  /** The nearest villager (within 24 blocks), what it trades, and a walk over to it. */
  private async nearVillager(job = -1): Promise<VillagerOffers | null> {
    const q = job >= 0 ? { t: "atrades", job } : { t: "atrades" };
    let v = (await this.ask<{ v: VillagerOffers | null }>(q, "atrades", { v: null })).v;
    for (let k = 0; v && k < 3 && Math.hypot(v.x - this.phys.x, v.z - this.phys.z) > 2.5; k++) {
      if (this.abort || this.dead) return null;
      const target = v;
      await this.goto(target.x, target.y, target.z, 2, { maxMs: 15000, done: () => Math.hypot(target.x - this.phys.x, target.z - this.phys.z) < 2.5 });
      v = (await this.ask<{ v: VillagerOffers | null }>(q, "atrades", { v: null })).v;
    }
    if (v) await this.lookAt(v.x, v.y + 1.5, v.z, 8);
    return v;
  }

  /** Trade with the nearest villager (v13: or the nearest of a trade, `job`): no offer = list what it trades; else make
   *  offer `o` up to `times` times. */
  async trade(o: number | undefined, times = 1, trade = -1): Promise<string> {
    const v = await this.nearVillager(trade);
    if (!v) return trade >= 0 ? `no ${JOBS[trade]?.key ?? "villager"} within 64 blocks (go into a village; they stay indoors at night)` : "no villager within 24 blocks (they live in the villages, and stay indoors at night)";
    const job = JOBS[v.job]?.key ?? "villager";
    const words = (w: [number, number]) => `${w[1]} ${itemName(w[0])}`;
    const list = v.offers.map((f, k) => `${k}: ${words(f.a)}${f.b ? ` + ${words(f.b)}` : ""} -> ${words(f.r)}${f.n ? "" : " (sold out)"}`).join("; ");
    if (o === undefined || !v.offers[o]) return `${v.name} the ${job} trades: ${list}. Rubies are the money.`;
    this.action = `trading with ${v.name}`;
    const r = await this.ask<{ n: number; why?: string }>({ t: "atrade", v: v.vid, o, n: times }, "atraded", { n: 0, why: "no answer from the server" });
    const f = v.offers[o];
    return r.n ? `traded with ${v.name} the ${job} ${r.n} time${r.n === 1 ? "" : "s"}: ${words(f.a)}${f.b ? ` + ${words(f.b)}` : ""} for ${words(f.r)} each` : `couldn't trade with ${v.name}: ${r.why}`;
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
        // put it down here, or a few steps off when there's no room (a thicket, a slope): never give up on the first try
        for (let k = 0; k < 4 && !this.tableInReach() && !this.abort; k++) {
          const spot = this.spotNearby();
          if (spot && (await this.place(B.CRAFTING_TABLE, ...spot))) break;
          const a = (k * Math.PI) / 2 + 0.6;
          await this.goto(this.phys.x + Math.cos(a) * 3, this.phys.y, this.phys.z + Math.sin(a) * 3, 1, { maxMs: 4000 });
        }
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
    if (made === 0) {
      // say exactly what's short, so it goes and gets that instead of asking again (sonnet asked for planks three
      // times in a row with no logs, told only "missing ingredients")
      const short = recipeNeeds(r)
        .map(([ing, need]) => ({ ing, need: need * n, have: ing.reduce((t, id) => t + this.count(id), 0) }))
        .filter((x) => x.have < x.need)
        .map((x) => `${x.need - x.have} more ${itemName(x.ing[0])}${x.ing.length > 1 ? " (or the like)" : ""}`);
      return { made: 0, why: short.length ? `missing ingredients: ${short.join(", ")}` : "missing ingredients" };
    }
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

  targetPos(t: Target): { x: number; y: number; z: number; h: number; w: number; vx: number; vz: number } | null {
    if (t.kind === "player") {
      const o = this.others.get(t.id);
      return o && !(o.flags & FLAG.DEAD) ? { x: o.x, y: o.y, z: o.z, h: 1.8, w: 0.6, vx: 0, vz: 0 } : null;
    }
    const m = (t.kind === "mob" ? this.mobs : this.animals).get(t.id);
    if (!m || (t.kind === "mob" && m.flags & MF.DEAD)) return null;
    const spec = t.kind === "mob" ? MOB_SPECS[m.kind] : ANIMAL_SPECS[m.kind];
    return { x: m.x, y: m.y, z: m.z, h: spec?.h ?? 1, w: spec?.w ?? 0.6, vx: m.vx ?? 0, vz: m.vz ?? 0 };
  }

  // ---------------------------------------------------------------- fighting (v13: the way a good player fights)

  /** From its eyes to the nearest point of a body's box: what a hit's reach is judged by (the classic 3 blocks). */
  boxDist(p: { x: number; y: number; z: number; h: number; w: number } | null): number {
    if (!p) return Infinity;
    const [ex, ey, ez] = this.eye();
    const hw = p.w / 2;
    return Math.hypot(ex - clamp(ex, p.x - hw, p.x + hw), ey - clamp(ey, p.y, p.y + p.h), ez - clamp(ez, p.z - hw, p.z + hw));
  }

  /** A clear line between two points: no full, opaque block in the way (how a monster sees, server/src/mobs.ts). */
  clearSight(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 0.4);
    for (let k = 1; k < n; k++) {
      const f = k / n;
      if (OPAQUE[this.get(Math.floor(x0 + (x1 - x0) * f), Math.floor(y0 + (y1 - y0) * f), Math.floor(z0 + (z1 - z0) * f))]) return false;
    }
    return true;
  }

  /** A clear path for an arrow between two points: nothing solid in the way (leaves and glass stop arrows, though a
   *  monster sees through them). */
  clearShot(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 0.3);
    for (let k = 1; k < n; k++) {
      const f = k / n;
      if (SOLID[this.get(Math.floor(x0 + (x1 - x0) * f), Math.floor(y0 + (y1 - y0) * f), Math.floor(z0 + (z1 - z0) * f))]) return false;
    }
    return true;
  }

  /** Can this monster see it (eye to eye)? An archer only shoots what it sees. */
  seenBy(m: Seen): boolean {
    const h = MOB_SPECS[m.kind]?.h ?? 1.9;
    const [ex, ey, ez] = this.eye();
    return this.clearSight(m.x, m.y + h * 0.85, m.z, ex, ey, ez);
  }

  /** Would a step this way (`yaw`, degrees) keep it safe: room for its body, ground no more than a block down, no water,
   *  no monster standing there. */
  safeStep(yaw: number): boolean {
    const a = (yaw * Math.PI) / 180;
    const ux = -Math.sin(a);
    const uz = Math.cos(a);
    const y = Math.floor(this.phys.y + 0.1);
    for (const r of [0.6, 1.2]) {
      const px = this.phys.x + ux * r;
      const pz = this.phys.z + uz * r;
      const x = Math.floor(px);
      const z = Math.floor(pz);
      if (SOLID[this.get(x, y, z)] || SOLID[this.get(x, y + 1, z)]) return false;
      if (IS_WATER[this.get(x, y, z)] || IS_WATER[this.get(x, y + 1, z)] || IS_WATER[this.get(x, y - 1, z)]) return false;
      let drop = 0;
      while (drop < 3 && !SOLID[this.get(x, y - 1 - drop, z)]) drop++;
      if (drop >= 2) return false; // a hole or a ledge: a fall, and a pit the monster walks into after it
      for (const m of this.mobs.values()) if (!(m.flags & MF.DEAD) && Math.hypot(m.x - px, m.z - pz) < 1.1 && Math.abs(m.y - this.phys.y) < 2) return false;
    }
    return true;
  }

  /** One tick of stepping back from (x, z) with its eyes still on it (a player backing off, not turning tail): straight
   *  back if that's safe, else back and to a side, else sideways. False if every way is a wall, a ledge, water or
   *  another monster. */
  retreatStep(fromX: number, fromZ: number): boolean {
    const away = (deg(Math.atan2(-(this.phys.x - fromX), this.phys.z - fromZ)) + 360) % 360;
    for (const off of [0, 35, -35, 70, -70, 105, -105]) {
      const yaw = (away + off + 360) % 360;
      if (!this.safeStep(yaw)) continue;
      this.input.yaw = yaw;
      this.input.forward = 1;
      this.input.strafe = 0;
      this.input.sprint = false;
      this.input.jump = false;
      return true;
    }
    return false;
  }

  private strafeDir = 1;
  private strafeUntil = 0;

  /** One tick of circling (x, z) sideways with its eyes on it, switching sides now and then or when the way is
   *  blocked: what a fighter does while the weapon recharges, out of the other's reach. False if neither side is safe. */
  strafeStep(x: number, z: number): boolean {
    if (this.tick >= this.strafeUntil) {
      this.strafeUntil = this.tick + 18 + Math.floor(Math.random() * 22);
      if (Math.random() < 0.6) this.strafeDir = -this.strafeDir;
    }
    const at = (deg(Math.atan2(-(x - this.phys.x), z - this.phys.z)) + 360) % 360;
    for (const dir of [this.strafeDir, -this.strafeDir]) {
      // strafe +1 is to its left (A), 90 degrees from where it faces
      if (!this.safeStep((at + (dir > 0 ? -90 : 90) + 360) % 360)) continue;
      this.strafeDir = dir;
      this.input.yaw = at;
      this.input.forward = 0;
      this.input.strafe = dir * 0.7;
      this.input.sprint = false;
      this.input.jump = false;
      return true;
    }
    return false;
  }

  /** Away from a fight it can't take, the way a player gets out of one: at a sprint, to a spot well away from all of
   *  them and (when there's one) out of every archer's sight, by a real path; again from there if they keep coming.
   *  Never into water or off a drop. What it did. */
  async runAway(threats: { x: number; y: number; z: number; kind: number }[], maxMs = 12000): Promise<string> {
    const t0 = Date.now();
    let legs = 0;
    while (!this.abort && !this.dead && Date.now() - t0 < maxMs && legs < 3) {
      const near = threats.map((m) => this.mobs.get((m as { id?: number }).id ?? -1) ?? m).filter((m) => Math.hypot(m.x - this.phys.x, m.z - this.phys.z) < 18);
      if (!near.length) break;
      const fy = Math.floor(this.phys.y + 0.1);
      let best: [number, number, number] | null = null;
      let bestScore = -Infinity;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        for (const r of [10, 15]) {
          const x = Math.floor(this.phys.x + Math.cos(a) * r);
          const z = Math.floor(this.phys.z + Math.sin(a) * r);
          // ground near its own height, dry, room to stand
          let y = -1;
          for (let dy = 3; dy >= -3; dy--) {
            const yy = fy + dy;
            if (SOLID[this.get(x, yy - 1, z)] && !IS_WATER[this.get(x, yy - 1, z)] && !SOLID[this.get(x, yy, z)] && !SOLID[this.get(x, yy + 1, z)] && !IS_WATER[this.get(x, yy, z)]) {
              y = yy;
              break;
            }
          }
          if (y < 0 || this.waterNear(x, y, z, 1, 1)) continue;
          // away from all of them (never past one), and out of the archers' sight
          let score = Math.min(...near.map((m) => Math.hypot(m.x - x, m.z - z)));
          const toward = near.some((m) => (m.x - this.phys.x) * (x - this.phys.x) + (m.z - this.phys.z) * (z - this.phys.z) > 0.2 * Math.hypot(m.x - this.phys.x, m.z - this.phys.z) * r);
          if (toward) score -= 12;
          for (const m of near) {
            if (MOB_SPECS[m.kind]?.key !== "rattler") continue;
            const h = MOB_SPECS[m.kind]?.h ?? 1.99;
            if (this.clearSight(m.x, m.y + h * 0.85, m.z, x + 0.5, y + EYE_HEIGHT, z + 0.5)) score -= 6;
          }
          score -= Math.abs(y - fy) * 1.5;
          if (score > bestScore) {
            bestScore = score;
            best = [x, y, z];
          }
        }
      }
      if (!best) break;
      legs++;
      const [x, y, z] = best;
      await this.goto(x + 0.5, y, z + 0.5, 1.5, { maxMs: 6000 });
    }
    this.halt();
    const still = threats.filter((m) => {
      const q = this.mobs.get((m as { id?: number }).id ?? -1) ?? m;
      return Math.hypot(q.x - this.phys.x, q.z - this.phys.z) < 10;
    }).length;
    return still ? `ran, but ${still} of them kept up` : "got away from them";
  }

  /** Fight something until it is dead or gone, it gets away, or time runs out. v13, the way a good player does it:
   *  - a charged swing only (a spammed one does a fifth), at arm's length (3 blocks to its box);
   *  - from a few blocks out it sprints in, and the sprinting hit knocks the monster well back;
   *  - closer, it jumps first and swings on the way down: a critical hit, half as much again;
   *  - while the weapon recharges it steps back out of the monster's reach, still facing it, so it never trades blows
   *    (a shambler hits from a block and a half, the player from three); never off a ledge, into water or into
   *    another monster;
   *  - an archer has no reach to keep out of: it stays on it. */
  async fight(t: Target, maxMs = 25000, bailHp = 0, leash = 0): Promise<string> {
    const weapon = this.bestWeapon();
    if (weapon) await this.hold(weapon);
    const t0 = Date.now();
    const x0 = this.phys.x;
    const z0 = this.phys.z;
    let hits = 0;
    let crits = 0;
    let closest = Infinity;
    let closedAt = Date.now();
    let jumpAt = -100;
    const seen = t.kind === "mob" ? this.mobs.get(t.id) : undefined;
    const spec = seen ? MOB_SPECS[seen.kind] : undefined;
    const archer = spec?.key === "rattler";
    // how far it hits from (centre to centre): a walker a block and a half, a crawler three, another player three and a
    // bit; an archer shoots (no reach to keep out of), an animal doesn't hit back
    const theirs = t.kind === "player" ? 3.4 : spec && !archer ? Math.sqrt(meleeReachSq(spec.w)) : 0;
    const what = () => `${hits} hits${crits ? `, ${crits} critical` : ""}`;
    // the server says which hits were critical
    const struck = (m: { id: number; crit: boolean }) => {
      if (m.id === t.id && m.crit) crits++;
    };
    this.onStruck.add(struck);
    try {
    while (!this.abort && !this.dead && Date.now() - t0 < maxMs) {
      if (bailHp && this.stats.hp < bailHp) {
        this.halt();
        return `backed off, down to ${Math.round(this.stats.hp)} health${hits ? ` after ${what()}` : ""}`;
      }
      // a leash: never chased off into the dark, away from the hole or the house it was in
      if (leash && Math.hypot(this.phys.x - x0, this.phys.z - z0) > leash) {
        this.halt();
        return `let it go rather than chase it more than ${leash} blocks${hits ? ` (${what()})` : ""}`;
      }
      const p = this.targetPos(t);
      if (!p) {
        this.halt();
        return hits ? `it's dead or gone (${what()})` : "it's gone";
      }
      const d = this.boxDist(p);
      const dh = Math.hypot(p.x - this.phys.x, p.z - this.phys.z);
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
        return hits ? `it got out of reach after ${what()}` : "couldn't get to it (water, a drop or a wall in the way): try another one";
      }
      const cool = Math.ceil(cooldownTicks(this.heldId()));
      const since = this.tick - this.lastSwing;
      const ready = since >= cool;
      const air = !this.phys.onGround && !this.phys.inWater;
      // the feet first (steering turns the eyes to the ground ahead), then the eyes back on it
      if (d > 16) {
        await this.goto(p.x, p.y, p.z, 2.2, { maxMs: 4000, done: () => this.boxDist(this.targetPos(t)) <= HIT_REACH });
        continue;
      }
      // is it coming at it? (a walker comes to you: wait for it rather than chase it about)
      const toward = dh > 0.01 ? -(p.vx * (p.x - this.phys.x) + p.vz * (p.z - this.phys.z)) / dh : 0;
      const coming = theirs > 0 && toward > 0.03;
      // room to jump (in a two-high tunnel a jump is a bump of the head: no critical there)
      const fx = Math.floor(this.phys.x);
      const fz = Math.floor(this.phys.z);
      const headroom = !SOLID[this.get(fx, Math.floor(this.phys.y + 0.1) + 2, fz)];
      const critJump = (sprinting = false) => {
        if ((theirs || archer) && t.kind !== "animal" && headroom && this.phys.onGround && (sprinting || !this.phys.sprinting) && this.tick - jumpAt > 14) {
          this.input.jump = true;
          jumpAt = this.tick;
        }
      };
      // backing off or running (an archer keeps its distance, and every hit knocks it further): chase it at a sprint
      const fleeing = archer || toward < -0.02;
      // the other walkers and crawlers about: any of them can land a hit while it deals with this one
      const crowd = t.kind === "mob" ? this.hostiles(7).filter((m) => m.id !== t.id && m.key !== "rattler") : [];
      const inTheirReach = crowd.filter((m) => Math.hypot(m.x - this.phys.x, m.z - this.phys.z) < Math.sqrt(meleeReachSq(MOB_SPECS[m.kind]?.w ?? 0.6)) + 1.2);
      if (since < cool - 3 && (inTheirReach.length || (theirs && dh < theirs + 1.2))) {
        // recharging inside the reach of it (or of another one): back off a step from all of them, facing it
        const from = [...inTheirReach, ...(theirs && dh < theirs + 1.2 ? [p] : [])];
        if (!this.retreatStep(from.reduce((a, m) => a + m.x, 0) / from.length, from.reduce((a, m) => a + m.z, 0) / from.length)) this.halt();
      } else if (theirs && since < cool - 3) {
        // recharging out of its reach: circle it, side to side, eyes on it (a fighter never stands still)
        if (!this.strafeStep(p.x, p.z)) this.halt();
      } else if (d > HIT_REACH - 0.25 && (since >= cool - 3 || !theirs)) {
        if (coming && d < 6) {
          // charged and it's on its way: stand and meet it; a jump as it comes into reach, so the swing lands on the
          // way down (a critical)
          this.halt();
          if (d < 3.6) critJump();
        } else if (fleeing && t.kind !== "animal") {
          // after one that keeps its distance: a sprint, then a sprint-jump from a few blocks out; on the way down it
          // lets go of the sprint, so the swing lands as a critical with an ordinary knockback (a sprinting hit would
          // throw it six blocks off, out of reach again)
          this.steer(p.x, p.z, p.y, 0);
          this.input.sprint = this.stats.food > 6 && !this.phys.inWater;
          // an archer's arrows go where you are, not where you're going: weave a little on the way in
          if (archer && d > 4.8 && this.phys.onGround) this.input.strafe = Math.sin(this.tick / 5) > 0 ? 0.65 : -0.65;
          if (d < 4.8) critJump(true);
          if (air && this.phys.vy < 0 && d < 3.8) {
            this.input.sprint = false;
            this.input.forward = Math.min(this.input.forward, 0.7);
          }
        } else {
          // close in: sprint from well out (a sprinting hit knocks it far back); from closer walk (a sprint and a
          // critical don't go together), and jump in
          this.steer(p.x, p.z, p.y, 0);
          const far = d > 5.5;
          this.input.sprint = far && this.stats.food > 6 && !this.phys.inWater;
          if (!far && this.phys.sprinting) this.input.forward = Math.min(this.input.forward, 0.7); // drop out of the sprint
          if (!far && d < 3.9) critJump();
        }
      } else this.halt();
      this.look(p.x, p.y + p.h * 0.6, p.z);
      const facing = Math.abs(angleDiff(this.wantYaw, this.yaw)) < 30;
      // charged with another one closer and in reach: that one gets the swing (whatever is about to hit it first)
      // (its eyes stay on that one while it's the nearer threat, so they don't flick back and forth)
      const closer = crowd.find((m) => {
        const q = this.targetPos({ kind: "mob", id: m.id });
        return !!q && this.boxDist(q) <= HIT_REACH && this.boxDist(q) < d - 0.4;
      });
      if (closer) {
        const q = this.targetPos({ kind: "mob", id: closer.id })!;
        this.look(q.x, q.y + q.h * 0.6, q.z);
        if (ready && Math.abs(angleDiff(this.wantYaw, this.yaw)) < 30 && !(air && this.phys.vy > 0.01)) {
          this.send({ t: "hit", id: closer.id, mob: true });
          this.swing();
          hits++;
        }
      } else if (d <= HIT_REACH && ready && facing) {
        // a jump on its way up: hold the swing for the fall (half as much again), unless it's about to land a hit
        const rising = air && this.phys.vy > 0.01;
        if (!rising || (theirs && dh < theirs + 0.5)) {
          this.send({ t: "hit", id: t.id, ...(t.kind === "mob" ? { mob: true } : t.kind === "player" ? { player: true } : {}) });
          this.swing();
          hits++;
        }
      }
      await this.nextTick();
    }
    this.halt();
    return hits ? `ran out of time (${what()})` : "ran out of time";
    } finally {
      this.onStruck.delete(struck);
    }
  }

  inHitRange(t: Target): boolean {
    const p = this.targetPos(t);
    return !p || this.boxDist(p) <= HIT_REACH;
  }

  /** The pitch (degrees; up is negative) that puts a fully drawn arrow from its eyes onto a point `dist` blocks away
   *  across the ground and `dy` above its eyes: the arrow's own flight (shared/mobs.ts: drag, then gravity). */
  static aimPitch(dist: number, dy: number): number {
    let lo = -70;
    let hi = 60;
    for (let k = 0; k < 26; k++) {
      const mid = (lo + hi) / 2;
      const r = (mid * Math.PI) / 180;
      let x = 0.3 * Math.cos(r);
      let y = -0.1;
      let vx = Math.cos(r) * BOW_SPEED;
      let vy = -Math.sin(r) * BOW_SPEED;
      let at = y;
      for (let tk = 0; tk < 120; tk++) {
        if (x + vx >= dist) {
          at = y + vy * ((dist - x) / vx);
          break;
        }
        x += vx;
        y += vy;
        vx *= ARROW_DRAG;
        vy = vy * ARROW_DRAG - ARROW_GRAVITY;
        at = y;
        if (vx < 0.05) break;
      }
      if (at > dy) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /** Shoot it with the bow from where it stands: a full draw each time (a second), aimed where it will be when the
   *  arrow gets there, dropped for the arrow's fall. Stops when it's dead or gone, comes within a few blocks (a sword's
   *  job), stays out of sight, or the arrows run out. */
  async duel(t: Target, maxMs = 25000, bailHp = 0): Promise<string> {
    if (!this.has(I.BOW) || !this.has(I.ARROW)) return "no bow and arrows";
    if (!(await this.hold(I.BOW))) return "couldn't take the bow in hand";
    const t0 = Date.now();
    let shots = 0;
    let hits = 0;
    let drawAt = -1;
    let unseen = 0;
    let steady = 0;
    const struck = (m: { id: number }) => {
      if (m.id === t.id) hits++;
    };
    this.onStruck.add(struck);
    const done = (s: string) => {
      if (drawAt >= 0) this.send({ t: "bow", a: "abort" });
      this.onStruck.delete(struck);
      this.halt();
      return s;
    };
    const tally = () => `${shots} arrows, ${hits} hit`;
    while (!this.abort && !this.dead && Date.now() - t0 < maxMs) {
      if (bailHp && this.stats.hp < bailHp) return done(`backed off, down to ${Math.round(this.stats.hp)} health (${tally()})`);
      const p = this.targetPos(t);
      if (!p) return done(shots ? `it's dead or gone (${tally()})` : "it's gone");
      const dh = Math.hypot(p.x - this.phys.x, p.z - this.phys.z);
      if (dh < 3.5) return done(`it came close (${tally()})`);
      // a walker or a crawler at arm's length: that's the sword's job now (drawing, it stood and took the hits)
      const close = this.hostiles(5).find((m) => m.key !== "rattler" && m.d < 3.4);
      if (close) return done(`a ${close.key} came at it (${tally()})`);
      if (dh > 32) return done(`it got away (${tally()})`);
      if (!this.has(I.ARROW)) return done(`out of arrows (${tally()})`);
      if (this.heldId() !== I.BOW) {
        drawAt = -1;
        if (!(await this.hold(I.BOW))) return done("lost the bow");
      }
      // where it will be when the arrow arrives (a few ticks at this range), its middle
      const lead = dh / 2.7;
      const tx = p.x + p.vx * lead;
      const tz = p.z + p.vz * lead;
      const [ex, ey, ez] = this.eye();
      const yaw = (deg(Math.atan2(-(tx - ex), tz - ez)) + 360) % 360;
      const pitch = Body.aimPitch(Math.hypot(tx - ex, tz - ez), p.y + p.h * 0.55 - ey);
      this.halt();
      this.wantYaw = yaw;
      this.wantPitch = clamp(pitch, -89, 89);
      const visible = this.clearShot(ex, ey - 0.1, ez, p.x, p.y + p.h * 0.55, p.z);
      unseen = visible ? 0 : unseen + 1;
      if (unseen > 50) return done(`lost sight of it (${tally()})`);
      const onIt = Math.abs(angleDiff(yaw, this.yaw)) < 0.9 && Math.abs(this.wantPitch - this.pitch) < 0.9;
      steady = onIt ? steady + 1 : 0;
      if (drawAt < 0) {
        if (visible) {
          this.send({ t: "bow", a: "start" });
          drawAt = this.tick;
        }
      } else if (this.tick - drawAt >= 22 && visible && steady >= 2) {
        this.send({ t: "bow", a: "release" });
        shots++;
        drawAt = -1;
      } else if (this.tick - drawAt > 70) {
        // held too long without a clear shot: let it down and draw again when it shows
        this.send({ t: "bow", a: "abort" });
        drawAt = -1;
      }
      await this.nextTick();
    }
    return done(`ran out of time (${tally()})`);
  }

  /** Two blocks up where it stands, and fight from there: a walker can't reach a body a block and a half above it, so
   *  shamblers stand below and take the hits (the classic pillar). Eats up there when hurt. Digs its pillar away again
   *  when they're dead or gone. Not against a crawler (it climbs) or with an archer about (it would be a target). */
  async pillarFight(maxMs = 45000): Promise<string> {
    const x = Math.floor(this.phys.x);
    const z = Math.floor(this.phys.z);
    const y0 = Math.floor(this.phys.y + 0.1);
    if (this.fillerCount() < 2) return "no blocks to pillar up with";
    if (SOLID[this.get(x, y0 + 2, z)] || SOLID[this.get(x, y0 + 3, z)] || SOLID[this.get(x, y0 + 4, z)]) return "no room overhead to pillar up";
    const up = await this.pillarUp(2);
    if (up < 2) return `couldn't get up out of reach (${up} of 2 blocks)`;
    const weapon = this.bestWeapon();
    if (weapon) await this.hold(weapon);
    const t0 = Date.now();
    let hits = 0;
    let why = "";
    this.halt();
    this.input.sneak = true; // never steps off the top
    while (!this.abort && !this.dead && Date.now() - t0 < maxMs) {
      const below = this.hostiles(12).filter((m) => m.key !== "rattler");
      if (!below.length) break;
      const archer = this.hostiles(16).find((m) => m.key === "rattler" && this.seenBy(m));
      if (archer) {
        why = ", a rattler had it in sight up there";
        break;
      }
      const near = below.map((m) => ({ m, d: this.boxDist({ x: m.x, y: m.y, z: m.z, h: MOB_SPECS[m.kind]?.h ?? 1.9, w: MOB_SPECS[m.kind]?.w ?? 0.6 }) })).sort((a, b) => a.d - b.d)[0];
      const h = MOB_SPECS[near.m.kind]?.h ?? 1.9;
      this.look(near.m.x, near.m.y + h * 0.75, near.m.z);
      const ready = this.tick - this.lastSwing >= Math.ceil(cooldownTicks(this.heldId()));
      if (near.d <= HIT_REACH && ready && Math.abs(angleDiff(this.wantYaw, this.yaw)) < 30) {
        this.send({ t: "hit", id: near.m.id, mob: true });
        this.swing();
        hits++;
      } else if (near.d > HIT_REACH + 1 && this.stats.hp <= 14 && this.stats.food < 20 && this.inv.some((s) => s && itemDef(s.id)?.food && !itemDef(s.id)?.food?.queasy)) {
        // out of their reach and none in ours: eat (a full stomach heals fast), then back to the weapon
        await this.eat();
        if (weapon) await this.hold(weapon);
        this.input.sneak = true;
      }
      await this.nextTick();
    }
    this.input.sneak = false;
    // down again, the blocks back in the bag (a dirt pole left standing is litter in the town)
    if (!this.dead && !this.abort && !this.hostiles(5).some((m) => m.key !== "rattler")) {
      for (const by of [y0 + 1, y0]) {
        if (Math.floor(this.phys.y + 0.1) !== by + 1 || !SOLID[this.get(x, by, z)]) continue;
        if (!(await this.mine(x, by, z, false))) break;
        await this.wait(8);
      }
      await this.pickUp(3, 3000);
    }
    return `pillared up out of reach and fought from there (${hits} hits)${why}`;
  }

  /** An archer has it in sight: a block wall two high between them (on its side), so the arrows stop and it has to come
   *  round the corner, into reach, to shoot again. True if it put up any. */
  async coverFrom(fromX: number, fromZ: number): Promise<boolean> {
    const x = Math.floor(this.phys.x);
    const y = Math.floor(this.phys.y + 0.1);
    const z = Math.floor(this.phys.z);
    // in the middle of its cell first: a block can't go where its body pokes into the cell beside it
    await this.center(x, z, 12);
    const dx = fromX - this.phys.x;
    const dz = fromZ - this.phys.z;
    const sx = Math.sign(dx) || 1;
    const sz = Math.sign(dz) || 1;
    // the side toward it, and the corner too when it's off at an angle
    const cols: [number, number][] = Math.abs(dx) >= Math.abs(dz) ? [[x + sx, z]] : [[x, z + sz]];
    if (Math.min(Math.abs(dx), Math.abs(dz)) > 0.45 * Math.max(Math.abs(dx), Math.abs(dz))) cols.push([x + sx, z + sz], Math.abs(dx) >= Math.abs(dz) ? [x, z + sz] : [x + sx, z]);
    let placed = 0;
    for (const [cx, cz] of cols)
      for (const cy of [y, y + 1]) {
        if (this.abort || this.dead) return placed > 0;
        if (SOLID[this.get(cx, cy, cz)]) continue;
        const f = this.fillerBlock();
        if (!f) return placed > 0;
        if (await this.place(f, cx, cy, cz, 0)) placed++;
      }
    this.wantPitch = 0;
    return placed > 0;
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
    for (let k = 0; k < maxTicks && !this.dead && (this.phys.inWater || this.waterNear(Math.floor(this.phys.x), Math.floor(this.phys.y + 0.1), Math.floor(this.phys.z), 0, 0)); k++) {
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
        // walled in two high all round (opus, in a pocket of farm water with dirt on three sides): cut a step, the
        // top block out of a wall, so there is a one block edge to climb onto. Whether or not a bank shows up
        // further off: that one was across the walls, and it swam at them for an hour
        if (await this.cutStepOutOfWater()) continue;
        if (this.fillerBlock()) await this.pillarUp(1);
        else await this.stepUp();
      }
    }
    this.halt();
    return !this.phys.inWater;
  }

  /** In water with a two-high wall on every side: break the top block of a wall beside it (never the town's own
   *  blocks if there's another choice), leaving a one block step. True if it cut one. */
  private async cutStepOutOfWater(): Promise<boolean> {
    const x = Math.floor(this.phys.x);
    const y = Math.floor(this.phys.y + 0.1);
    const z = Math.floor(this.phys.z);
    const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .map(([dx, dz]) => [x + dx, z + dz] as const)
      .filter(([sx, sz]) => SOLID[this.get(sx, y, sz)] && SOLID[this.get(sx, y + 1, sz)] && !SOLID[this.get(sx, y + 2, sz)] && !IS_WATER[this.get(sx, y + 1, sz)]);
    // natural ground first: dirt and grass, then anything else
    const natural = (sx: number, sz: number) => { const id = this.get(sx, y + 1, sz); return id === B.DIRT || id === B.GRASS ? 0 : 1; };
    sides.sort(([ax, az], [bx, bz]) => natural(ax, az) - natural(bx, bz));
    for (const [sx, sz] of sides) if (await this.mine(sx, y + 1, sz, false)) return true;
    return false;
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
    // never with a walker or a crawler at arm's length: it drops into the hole after it, and three blocks down is seconds
    // of its hits with nowhere to go (season 11: shamblers followed them down)
    const close = this.hostiles(5).find((m) => m.key !== "rattler");
    if (close) return `a ${close.key} is too close to dig in (it would follow you down): fight it, or wall it off first`;
    this.halt();
    if (this.phys.inWater) await this.escapeWater();
    // a hole next to water floods: walk a few blocks away from it first
    for (let tries = 0; tries < 3 && this.waterNear(Math.floor(this.phys.x), Math.floor(this.phys.y + 0.1), Math.floor(this.phys.z)); tries++) {
      const a = Math.random() * Math.PI * 2;
      await this.goto(this.phys.x + Math.cos(a) * 6, this.phys.y, this.phys.z + Math.sin(a) * 6, 1.5, { maxMs: 6000 });
    }
    if (this.phys.inWater) return "in water, can't dig in here";
    const x = Math.floor(this.phys.x);
    const z = Math.floor(this.phys.z);
    const y0 = Math.floor(this.phys.y + 0.1);
    for (let k = 1; k <= 3; k++) {
      if (this.abort || this.dead) return "interrupted";
      const id = this.get(x, y0 - k, z);
      if (IS_WATER[id]) return "water below, can't dig in here";
      if (id !== B.AIR && !(await this.mine(x, y0 - k, z, false))) return "couldn't dig down here";
      if (!(await this.dropInto(x, y0 - k, z))) return "dug a hole but couldn't get into it";
    }
    for (let k = 0; k < 30 && !this.fillerBlock(); k++) await this.nextTick(); // the dirt it fell onto gets picked up
    // in a cave the sides are open too: down further, into rock that closes round it, rather than run out of blocks
    // halfway (opus dug in at y=36 in a cave and was left with an open side)
    for (let k = 0; k < 4 && !this.abort && !this.dead && this.openGaps() > this.fillerCount(); k++) {
      const fx = Math.floor(this.phys.x), fy = Math.floor(this.phys.y + 0.1), fz = Math.floor(this.phys.z);
      const below = this.get(fx, fy - 1, fz);
      if (IS_WATER[below] || !SOLID[below] || !(await this.mine(fx, fy - 1, fz, false)) || !(await this.dropInto(fx, fy - 1, fz))) break;
      for (let t = 0; t < 10; t++) await this.nextTick();
    }
    if (!this.fillerBlock()) return "dug down but has nothing to close the roof with";
    await this.sealIn();
    const lit = await this.lightUp();
    return (this.sealed() ? "sealed in underground" : "dug in, but the hole isn't fully closed (out of blocks to close it?)") + (lit ? ", with a torch" : "");
  }

  /** Badly hurt with a monster at arm's length: digging three blocks down first takes seconds with it hitting all the
   *  while (opus died two seconds into it, 11/2). Back off a step if it's right up against it (no block goes into a
   *  cell it stands in), block its side first, then the rest round it where it stands. Only if that leaves a gap,
   *  dig in as before. */
  async wallOff(): Promise<string> {
    if (this.sealed()) return "already sealed in";
    this.halt();
    if (this.phys.inWater || this.openGaps() > this.fillerCount()) return this.digIn();
    const key = this.hostiles(5)[0]?.key ?? "monster";
    for (let k = 0; k < 3 && !this.sealed() && !this.dead && !this.abort; k++) {
      const m = this.hostiles(5)[0];
      if (m && this.mobInGap()) await this.flee(m.x, m.z, 8);
      await this.sealIn(true);
    }
    if (this.sealed()) return `walled itself off from the ${key}${(await this.lightUp()) ? ", with a torch" : ""}`;
    // never dig down with it at arm's length: it drops into the hole too, and gets sealed in with it (the test: dead
    // in a closed hole, a shambler inside)
    if (this.hostiles(4).length) return `couldn't wall the ${key} off (${this.openGaps()} gaps still open)`;
    return this.digIn();
  }

  /** A tunnel it can close in a step or two: few gaps round it, the blocks for them, none with a monster in it. */
  canWallOff(): boolean {
    const gaps = this.openGaps();
    return gaps <= 3 && this.fillerCount() >= gaps && !this.mobInGap() && !this.phys.inWater;
  }

  /** Is a monster standing in one of the cells round it (a side at its feet or head)? */
  mobInGap(): boolean {
    const x = Math.floor(this.phys.x), y = Math.floor(this.phys.y + 0.1), z = Math.floor(this.phys.z);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1]) if (this.mobIn(x + dx, y + dy, z + dz)) return true;
    return false;
  }

  private mobIn(gx: number, gy: number, gz: number): boolean {
    return this.hostiles(5).some((m) => {
      const w = (MOB_SPECS[m.kind]?.w ?? 0.6) / 2, h = MOB_SPECS[m.kind]?.h ?? 1.95;
      return m.x + w > gx && m.x - w < gx + 1 && m.z + w > gz && m.z - w < gz + 1 && m.y + h > gy && m.y < gy + 1;
    });
  }

  /** Close every gap round it: the roof over its head and the four sides at its feet and head (dug into a
   *  staircase or a cave, a hole three blocks down still opens onto the old tunnels). A torch or a plant in a gap
   *  comes out first. */
  async sealIn(mobFirst = false): Promise<void> {
    const x = Math.floor(this.phys.x);
    const y = Math.floor(this.phys.y + 0.1);
    const z = Math.floor(this.phys.z);
    let gaps: [number, number, number][] = [[x, y + 2, z]];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) gaps.push([x + dx, y + 1, z + dz], [x + dx, y, z + dz]);
    // walling a monster off: the side it's on first, the roof last, and a cell it stands in left till the end (a
    // block put there is refused, and waiting on it loses a second)
    const m = mobFirst ? this.hostiles(6)[0] : undefined;
    if (m) {
      // and the feet before the head on each side, the roof after them (a block needs one beside it to go on: in the
      // open a head-high one or the roof has nothing to go against till those are in)
      const far = (g: [number, number, number]) => (g[1] === y + 2 ? 99 : (g[1] - y) * 0.5) + Math.hypot(g[0] + 0.5 - m.x, g[2] + 0.5 - m.z) * 2;
      gaps = gaps.sort((p, q) => far(p) - far(q));
      gaps = [...gaps.filter((g) => !this.mobIn(...g)), ...gaps.filter((g) => this.mobIn(...g))];
    }
    for (const [gx, gy, gz] of gaps) {
      if (this.abort || this.dead) return;
      let id = this.get(gx, gy, gz);
      if (SOLID[id]) continue;
      if (m && this.mobIn(gx, gy, gz)) continue;
      if (id !== B.AIR && !IS_WATER[id] && !BLOCKS[id]?.replaceable) {
        await this.mine(gx, gy, gz, false);
        id = this.get(gx, gy, gz);
      }
      const filler = this.fillerBlock();
      if (!filler) return;
      await this.place(filler, gx, gy, gz, 0);
    }
    this.wantPitch = 0;
  }

  /** A torch beside it in a hole (a small nook dug into the wall for it): never sitting in the pitch dark. */
  async lightUp(): Promise<boolean> {
    if (!this.has(B.TORCH)) return false;
    const x = Math.floor(this.phys.x);
    const y = Math.floor(this.phys.y + 0.1);
    const z = Math.floor(this.phys.z);
    for (let r = -4; r <= 4; r++) for (let dy = -3; dy <= 3; dy++) for (let q = -4; q <= 4; q++) if (this.get(x + r, y + dy, z + q) === B.TORCH) return true;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const nz = z + dz;
      if (!SOLID[this.get(nx, y, nz)] || IS_WATER[this.get(nx, y + 1, nz)]) continue; // the nook needs a floor
      // and rock round it, so the nook doesn't open the hole onto a tunnel beyond
      if (![[nx + dx, y + 1, nz + dz], [nx + dz, y + 1, nz + dx], [nx - dz, y + 1, nz - dx], [nx, y + 2, nz]].every(([a, b, c]) => SOLID[this.get(a, b, c)] === 1)) continue;
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
    const beds = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => B.RED_BED + k);
    // dusk by its bed: wait there for nightfall (a bed only works from time 12542), instead of asking again and again
    const tod = this.timeOfDay();
    if (tod >= 10800 && tod < NIGHT_START + 20 && (this.atHome() || this.findBlocks(beds, 4, 1).length)) {
      this.action = "waiting by the bed for nightfall";
      while (this.timeOfDay() < NIGHT_START + 20 && this.timeOfDay() >= 10800 && !this.abort && !this.dead) await this.wait(20);
      if (this.abort || this.dead) return "stopped waiting for the night";
    }
    if (!this.isNight()) return `you can only sleep at night (from time ${NIGHT_START}; it is ${this.timeOfDay()})`;
    let bed = this.findBlocks(beds, 16, 1)[0];
    const bedItem = BLOCKS[B.RED_BED].item || B.RED_BED;
    // a bed goes in a house, never down a hole in the open
    if (!bed && this.has(bedItem) && !this.atHome()) return this.home ? "your bed belongs in your house: go_home and sleep there" : "a bed goes in a house: build_house first (it puts your bed inside), or dig_in for tonight";
    if (!bed && this.has(bedItem)) {
      const fx = Math.floor(this.phys.x);
      const fy = Math.floor(this.phys.y + 0.1);
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
      const y = Math.floor(this.phys.y + 0.1);
      const z = Math.floor(this.phys.z);
      // sealed in for the night: the roof it put over its head comes off first, or every jump out hits it (haiku
      // jumped at its own roof 137 times one morning). Not when water sits on top: that would flood the hole
      if (this.inHole() && SOLID[this.get(x, y + 2, z)] && !IS_WATER[this.get(x, y + 3, z)] && (await this.mine(x, y + 2, z, false))) continue;
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
    const fy = Math.floor(this.phys.y + 0.1);
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
    const y = Math.floor(this.phys.y + 0.1);
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
    const y = Math.floor(this.phys.y + 0.1);
    const z = Math.floor(this.phys.z);
    return !this.inHole() && !SOLID[this.get(x, y + 2, z)];
  }

  /** One step of a staircase up: clear over its head and the two cells over the block beside it, then jump up onto
   *  that block (with no block there, put one down if it can). Tries `prefer` (a direction index) first; returns the
   *  direction it climbed, or -1. Needs no blocks to spare when the rock is there. */
  async stepUp(prefer = -1): Promise<number> {
    const x = Math.floor(this.phys.x);
    const y = Math.floor(this.phys.y + 0.1);
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
      for (let t = 0; t < 24 && Math.floor(this.phys.y + 0.1) <= y; t++) {
        const tx = sx + 0.5 - this.phys.x;
        const tz = sz + 0.5 - this.phys.z;
        this.wantYaw = this.input.yaw = (deg(Math.atan2(-tx, tz)) + 360) % 360;
        this.wantPitch = -20; // looking up the stairs
        this.input.forward = 1;
        this.input.jump = true;
        await this.nextTick();
      }
      this.halt();
      if (Math.floor(this.phys.y + 0.1) > y) {
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

  /** Its house, once it has one: its north-west corner, its floor height and its doorway; `room` for a town cottage it
   *  moved into (the room inside), else the room is the two by two in a shelter it put up itself (build_house). */
  home: { x0: number; z0: number; y: number; door: [number, number, number]; room?: Rect } | null = null;
  /** When it last failed to get into its house: the evening reflex digs in instead of trying again in the dark. */
  homeFailAt = 0;

  /** The middle of its home's room. */
  homeMiddle(): [number, number] {
    const h = this.home!;
    return h.room ? [(h.room.x0 + h.room.x1 + 1) / 2, (h.room.z0 + h.room.z1 + 1) / 2] : [h.x0 + 2, h.z0 + 2];
  }

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
    const y = Math.floor(this.phys.y + 0.1);
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
        // and a way out: the doorway (north wall, x0 + 1) opens onto ground with room to walk, not into a wall
        if (SOLID[this.get(x0 + 1, y, z0 - 1)] || SOLID[this.get(x0 + 1, y + 1, z0 - 1)] || !SOLID[this.get(x0 + 1, y - 1, z0 - 1)]) continue;
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
    let bedIn = false;
    if (this.has(bedItem)) {
      // the bed runs along the room's east side, its head to the north (two cells, both inside); it stands in the
      // west side by the door, out of the bed's way
      await this.center(x0 + 1, z0 + 1, 20);
      await this.hold(bedItem);
      await this.lookAt(x0 + 2.5, y + 0.3, z0 + 2.5, 12);
      this.send({ t: "place", x: x0 + 2, y, z: z0 + 2, id: B.RED_BED });
      this.swing();
      for (let k = 0; k < 12 && !bedIn; k++) {
        await this.nextTick();
        bedIn = this.get(x0 + 2, y, z0 + 2) >= B.RED_BED && this.get(x0 + 2, y, z0 + 2) < B.RED_BED + 8;
      }
    }
    const walls = ring.length * 2 - 2 + 16;
    const doorIn = isDoor(this.get(door[0], y, door[2]));
    return `built a house at x=${x0 + 1} z=${z0 + 1} (${placed} of ${walls} blocks placed, ${doorIn ? "with a door" : "an open doorway on the north side"}${bedIn ? ", your bed inside" : ""})`;
  }

  // ---------------------------------------------------------------- mining like a player: a staircase

  /** Mine stone (and any ore beside the way) down a staircase: three blocks out per step and one step down, so it
   *  walks straight back up the same stairs instead of digging a shaft and pillaring out. */
  async stairMine(gets: number[], count: number, maxSteps = 26): Promise<string> {
    const have = () => gets.reduce((n, id) => n + this.count(id), 0);
    const start = have();
    const fx0 = Math.floor(this.phys.x);
    const fz0 = Math.floor(this.phys.z);
    const fy0 = Math.floor(this.phys.y + 0.1);
    const wetNear = (x: number, y: number, z: number) =>
      [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([a, b, c]) => IS_WATER[this.get(x + a, y + b, z + c)] === 1);
    const isOre = (id: number) => !!BLOCKS[id]?.key?.endsWith("_ore");
    // the way down with the most stone and no water
    let dir: [number, number] | null = null;
    let bestScore = -1;
    let anyWet = false;
    for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
      let score = 0;
      let wet = false;
      for (let k = 1; k <= 8 && !wet; k++)
        for (const dy of [-k - 1, -k, -k + 1]) {
          const id = this.get(fx0 + sx * k, fy0 + dy, fz0 + sz * k);
          if (IS_WATER[id]) wet = true;
          if (id === B.STONE || id === B.COBBLESTONE) score += 1;
          else if (isOre(id)) score += 3;
          // open air close by that way: its own old staircase (or a cave). Nothing to mine in it, and going back down
          // it the steps it dug before look like a cave: haiku went down the same two steps, "broke into a cave",
          // filled it and walked back up, over and over
          else if (id === B.AIR && k <= 3 && dy < 0) score -= 4; // (below its feet: open air at its feet is just the surface)
        }
      if (wet) anyWet = true;
      else if (score > bestScore) [bestScore, dir] = [score, [sx, sz]];
    }
    if (!dir) return anyWet ? "water all around here: move somewhere drier to mine" : "the rock round here is dug out already: move a few blocks and mine again";
    const [sx, sz] = dir;
    const stairs: [number, number, number][] = [[fx0, fy0, fz0]];
    // every cell this staircase opened, so a cave can be told from its own steps
    const dug = new Set<string>([`${fx0},${fy0},${fz0}`, `${fx0},${fy0 + 1},${fz0}`]);
    let caveAt = "";
    let x = fx0;
    let y = fy0;
    let z = fz0;
    this.action = "mining a staircase down";
    for (let k = 0; k < maxSteps && !this.abort && !this.dead && have() - start < count; k++) {
      const down = y > 34 && y > fy0 - 14;
      const nx = x + sx;
      const nz = z + sz;
      const ny = down ? y - 1 : y;
      const cells: [number, number, number][] = [[nx, y + 1, nz], [nx, y, nz]];
      if (down) cells.push([nx, y - 1, nz]);
      if (cells.some(([a, b, c]) => wetNear(a, b, c)) || this.get(nx, ny - 1, nz) === B.BEDROCK) break;
      let ok = true;
      for (const [a, b, c] of cells) {
        if (SOLID[this.get(a, b, c)] && !(await this.mine(a, b, c, false))) {
          ok = false;
          break;
        }
        dug.add(`${a},${b},${c}`);
      }
      if (!ok) break;
      // broke into a cave: open air round the new step that this staircase didn't dig. Monsters spawn in the dark
      // there even by day (haiku dug into one on season 10's first day, met a rattler and a shambler and died):
      // close the openings with spare blocks and stop going this way
      const open: [number, number, number][] = [];
      for (const [a, b, c] of [[nx + 1, ny, nz], [nx - 1, ny, nz], [nx, ny, nz + 1], [nx, ny, nz - 1], [nx + 1, ny + 1, nz], [nx - 1, ny + 1, nz], [nx, ny + 1, nz + 1], [nx, ny + 1, nz - 1], [nx, ny + 2, nz], [nx + sx, ny, nz + sz]] as [number, number, number][])
        if (!dug.has(`${a},${b},${c}`) && this.get(a, b, c) === B.AIR) open.push([a, b, c]);
      if (open.length >= 2) {
        for (const [a, b, c] of open) {
          const f = this.fillerBlock();
          if (!f) break;
          await this.place(f, a, b, c, 3000);
        }
        caveAt = `${nx} ${ny} ${nz}`;
        break;
      }
      if (!SOLID[this.get(nx, ny - 1, nz)]) {
        const f = this.fillerBlock();
        if (!f || !(await this.place(f, nx, ny - 1, nz))) break;
      }
      // step in: walking code tiptoes at ledges, so centre over the step and let it drop
      if (down) await this.dropInto(nx, ny, nz);
      else await this.center(nx, nz, 30);
      this.debug(`stair ${k}: ${x} ${y} ${z} -> ${nx} ${ny} ${nz}, now ${this.phys.x.toFixed(1)} ${this.phys.y.toFixed(1)} ${this.phys.z.toFixed(1)} (${cells.map(([a, b, c]) => BLOCKS[this.get(a, b, c)]?.key).join(",")})`);
      if (Math.floor(this.phys.x) !== nx || Math.floor(this.phys.z) !== nz) break;
      x = nx;
      y = ny;
      z = nz;
      stairs.push([x, y, z]);
      // ore in the walls right beside the stairs comes out too
      for (const [a, b, c] of [[x + sz, y, z + sx], [x - sz, y, z - sx], [x + sz, y + 1, z + sx], [x - sz, y + 1, z - sx]] as [number, number, number][]) {
        const id = this.get(a, b, c);
        if (isOre(id) && !wetNear(a, b, c) && canHarvest(id, this.bestToolFor(id))) await this.mine(a, b, c, false);
      }
      if (k % 3 === 2) await this.pickUp(3, 1500);
      // a torch every few steps down, the way a player lights a mine: monsters spawn in the dark, even by day
      if (k % 5 === 4 && this.has(B.TORCH) && stairs.length > 2) {
        const [tx, ty, tz] = stairs[stairs.length - 2];
        if (this.get(tx, ty, tz) === B.AIR && SOLID[this.get(tx, ty - 1, tz)]) await this.place(B.TORCH, tx, ty, tz, 2000);
      }
    }
    await this.pickUp(3, 2500);
    if (caveAt) this.debug(`stairMine: broke into a cave at ${caveAt}, closed it and stopped`);
    const got = have() - start;
    const depth = fy0 - Math.floor(this.phys.y + 0.1);
    // and back up the same stairs
    this.action = "walking back up the stairs";
    for (let k = stairs.length - 2; k >= 0 && !this.abort && !this.dead; k--) {
      const [a, b, c] = stairs[k];
      await this.goto(a + 0.5, b, c + 0.5, 0.5, { maxMs: 4000 });
    }
    return `dug a staircase ${stairs.length - 1} steps down (${depth} deep), got ${got} of ${count}${caveAt ? ", broke into a cave (closed it off: monsters wait in the dark there)" : ""}, and walked back up to the top`;
  }

  // ---------------------------------------------------------------- building the settlement

  /** The ground under a column near `near`: the top solid block, -1 for water, -2 for a tree. */
  /** The top of a column: its highest solid block that isn't a tree, -1 over water or where nothing is loaded. For
   *  "go to x z", where only the column is known. */
  surfaceAt(x: number, z: number): number {
    for (let y = 120; y >= 2; y--) {
      const id = this.get(x, y, z);
      if (IS_WATER[id]) return -1;
      if (SOLID[id] && !TREE.has(id)) return y;
    }
    return -1;
  }

  groundAt(x: number, z: number, near: number): number {
    for (let y = Math.min(126, near + 8); y >= Math.max(2, near - 10); y--) {
      const id = this.get(x, y, z);
      if (IS_WATER[id]) return -1;
      if (SOLID[id]) return TREE.has(id) ? -2 : y;
    }
    return -1;
  }

  /** The ground under a column if it's natural (grass, dirt, sand, gravel, clay, stone), else -3: a roof, a path or
   *  somebody's floor is never ground to build on (a well got planned on top of a village house's roof). */
  naturalGround(x: number, z: number, near: number): number {
    const g = this.groundAt(x, z, near);
    if (g < 0) return g;
    return GROUND.has(this.get(x, g, z)) ? g : -3;
  }

  /** A footprint w by d near (cx, cz), `near` to `far` blocks out: ground within 1 of level, no water or trees, clear
   *  of the rectangles in `avoid`. The north-west corner and the floor height (one above the highest ground). */
  siteNear(cx: number, cz: number, cy: number, w: number, d: number, avoid: Rect[], far = 18, near = 3, slope = 2): { x0: number; z0: number; y: number } | null {
    let best: { x0: number; z0: number; y: number } | null = null;
    let bd = Infinity;
    for (let oz = -far; oz <= far; oz++)
      for (let ox = -far; ox <= far; ox++) {
        const dist = Math.hypot(ox, oz);
        if (dist < near || dist > far || dist >= bd) continue;
        const x0 = cx + ox - Math.floor(w / 2);
        const z0 = cz + oz - Math.floor(d / 2);
        if (avoid.some((r) => x0 <= r.x1 + 1 && x0 + w - 1 >= r.x0 - 1 && z0 <= r.z1 + 1 && z0 + d - 1 >= r.z0 - 1)) continue;
        let lo = 999;
        let hi = -1;
        let ok = true;
        for (let dz = 0; dz < d && ok; dz++)
          for (let dx = 0; dx < w && ok; dx++) {
            const g = this.naturalGround(x0 + dx, z0 + dz, cy);
            if (g < 0) ok = false;
            else {
              lo = Math.min(lo, g);
              hi = Math.max(hi, g);
              if (hi - lo > slope) ok = false; // a little slope is fine: the plan fills a foundation under the low side
            }
          }
        if (!ok) continue;
        for (let dz = 0; dz < d && ok; dz++)
          for (let dx = 0; dx < w && ok; dx++) for (let yy = hi + 1; yy <= hi + 4 && ok; yy++) if (SOLID[this.get(x0 + dx, yy, z0 + dz)]) ok = false;
        if (!ok) continue;
        bd = dist;
        best = { x0, z0, y: hi + 1 };
      }
    return best;
  }

  /** The block it carries for one cell of an old-style plan: d = foundation (dirt first: it's underground), s = stone,
   *  w = wood (planks, else stone), b = stone or wood, f = fence (else planks or stone), g = glass, t = torch,
   *  c = chest, a = keep clear (nothing goes in). Never dirt or sand above the ground. 0 if it has none. Town plans
   *  name the exact block for each cell instead (wantFor). */
  blockFor(kind: string): number {
    if (kind === "t") return this.has(B.TORCH) ? B.TORCH : 0;
    if (kind === "c") return this.has(B.CHEST) ? B.CHEST : 0;
    if (kind === "f" && this.has(B.OAK_FENCE)) return B.OAK_FENCE;
    if (kind === "g") return this.has(B.GLASS) ? B.GLASS : 0;
    const order = kind === "a" ? [] : kind === "d" ? [B.DIRT, B.SAND, ...STONES, ...WOODS] : kind === "s" ? STONES : kind === "w" || kind === "f" ? [...WOODS, ...STONES] : [...STONES, ...WOODS];
    for (const id of order) if (this.has(id)) return id;
    return 0;
  }

  /** What it would put in a plan cell: the item it holds and the block state that goes in, or null if it has none
   *  (or nothing goes in). A town plan's cell names its block exactly: the roof's oak stairs facing the ridge, the
   *  door facing in. */
  wantFor(kind: string): { item: number; state: number } | null {
    const t = cellTarget(kind.split("|")[0]);
    if (!t) {
      const id = this.blockFor(kind);
      return id ? { item: id, state: itemDef(id)?.block || id } : null;
    }
    const item = itemOf(t.id);
    return this.has(item) ? { item, state: t.id } : null;
  }

  /** Blocks it carries that a town building can use above the ground: stone and planks. */
  townBlocks(): number {
    return [...STONES, ...WOODS].reduce((a, id) => a + this.count(id), 0);
  }

  /** A cell of a town plan that still needs work: empty, or the wrong block (dirt or leaves where a wall goes,
   *  cobblestone where an upgrade puts stone bricks, a fence where glass goes), or (a = keep clear) dirt, leaves or a
   *  stray block inside a building, or (o) anything solid in a doorway, or (p) grass still to be dug into a path.
   *  "|" adds blocks a later tier puts there, which do as well. */
  needsWork([x, y, z, k]: PlanCell): boolean {
    const id = this.get(x, y, z);
    const parts = k.split("|");
    const alts = parts.slice(1).map(Number);
    const k0 = parts[0];
    if (alts.some((a) => accepts(a, id))) return false;
    if (k0 === "a") return ROUGH.has(id) || CLUTTER.has(id);
    if (k0 === "o") return SOLID[id] === 1 && !isDoor(id);
    if (k0 === "p" || k0 === "?p") return id === B.GRASS || id === B.DIRT || !SOLID[id];
    const t = cellTarget(k0);
    if (t) return !accepts(t.id, id);
    if (k0 === "t") return id !== B.TORCH;
    if (k0 === "c") return !isStorageId(id);
    if (!SOLID[id]) return true;
    return k0 !== "d" && ROUGH.has(id);
  }

  /** The highest natural ground under a column (grass, dirt, sand, gravel, clay, stone), looking through anything built
   *  on it: the wall round the base stays planned on the ground it stands on, not on its own top. -1 water, -2 a tree. */
  landAt(x: number, z: number, near: number): number {
    for (let y = Math.min(126, near + 8); y >= Math.max(2, near - 10); y--) {
      const id = this.get(x, y, z);
      if (IS_WATER[id]) return -1;
      if (TREE.has(id)) return -2;
      if (GROUND.has(id)) return y;
    }
    return -1;
  }

  /** The top of the ground under a column near `near` as anyone walks on it (a path, paving, grass): plants aside,
   *  -1 water, -2 under a tree (a road goes round it, it doesn't fell it). */
  pathAt(x: number, z: number, near: number): number {
    for (let y = Math.min(126, near + 8); y >= Math.max(2, near - 10); y--) {
      const id = this.get(x, y, z);
      if (IS_WATER[id]) return -1;
      if (TREE.has(id)) return -2;
      if (SOLID[id]) return y;
    }
    return -1;
  }

  /** Open a shut door (its lower half at x, y, z) within reach. */
  async openDoor(x: number, y: number, z: number): Promise<void> {
    const id = this.get(x, y, z);
    if (!isDoor(id) || door(id).open) return;
    await this.lookAt(x + 0.5, y + 0.5, z + 0.5, 10);
    this.send({ t: "use", x, y, z });
    for (let k = 0; k < 10 && this.get(x, y, z) === id; k++) await this.nextTick();
  }

  /** Dig a path into the grass or dirt at (x, y, z) with a shovel (a block of dirt first where the ground dips). */
  async makePath(x: number, y: number, z: number): Promise<boolean> {
    const shovel = this.inv.find((st) => st && itemDef(st.id)?.tool?.kind === "shovel")?.id;
    if (!shovel) return false;
    if (!SOLID[this.get(x, y, z)]) {
      const f = this.has(B.DIRT) ? B.DIRT : 0;
      if (!f || !(await this.place(f, x, y, z, 8000))) return false;
    }
    const above = this.get(x, y + 1, z);
    if (above !== B.AIR && !SOLID[above]) await this.mine(x, y + 1, z);
    if (this.get(x, y + 1, z) !== B.AIR) return false;
    const id = this.get(x, y, z);
    if (id !== B.GRASS && id !== B.DIRT) return true;
    if (this.reachTo(x, y, z) > REACH - 0.3) await this.goto(x + 0.5, y + 1, z + 0.5, 2.2, { maxMs: 8000, done: () => this.reachTo(x, y, z) <= REACH - 0.3 });
    await this.hold(shovel);
    await this.lookAt(x + 0.5, y + 1, z + 0.5, 8);
    this.send({ t: "use", x, y, z });
    this.swing();
    for (let k = 0; k < 10; k++) {
      await this.nextTick();
      if (this.get(x, y, z) === B.DIRT_PATH) return true;
    }
    return false;
  }

  /** Place what is still missing of a plan (cells in build order), up to `max` blocks: wrong blocks come out first
   *  (dirt in a wall, cobblestone an upgrade turns into stone bricks), furniture and anyone's chest never do. `short`
   *  comes back with the items it ran out of, cell by cell, so the job can go and get them. */
  async buildCells(cells: PlanCell[], max: number, label: string, floorY = -1): Promise<{ placed: number; left: number; outOf: boolean; why: string; short: Map<number, number> }> {
    this.scaffoldNeed = 0;
    const missing = (c: PlanCell) => this.needsWork(c);
    const footprint = new Set(cells.map(([x, , z]) => `${x},${z}`));
    // the cells a block goes in: never somewhere to stand while it builds
    const blocks = new Set(cells.filter(([, , , k]) => { const t = cellTarget(k); return !!t && SOLID[t.id] === 1; }).map(([x, y, z]) => `${x},${y},${z}`));
    // the room inside (the kept-clear cells at floor height): a pillar can go up in there, on the floor, to the roof
    const inside = new Map<string, number>();
    for (const [x, y, z, k] of cells) if (y === floorY && k.split("|")[0] === "a") inside.set(`${x},${z}`, y - 1);
    const short = new Map<number, number>();
    // a town door stands open: a shut one is a wall to the path search (it built the storehouse's doors from inside
    // and couldn't get out to the lamp post)
    for (const [x, y, z] of cells) if (isDoor(this.get(x, y, z)) && !door(this.get(x, y, z)).open && !door(this.get(x, y, z)).upper && this.reachTo(x, y, z) <= REACH) await this.openDoor(x, y, z);
    let placed = 0;
    let outOf = false;
    let lifts = 0;
    let why = "";
    let misses = 0;
    this.action = label;
    const todo = cells.filter(missing);
    // a cell that won't go in goes to the back of the list, once (the blocks round it may make it reachable)
    const again = new Set<PlanCell>();
    const later = (c: PlanCell) => {
      if (again.has(c)) return;
      again.add(c);
      todo.push(c);
    };
    for (let i = 0; i < todo.length; i++) {
      // eight blocks in a row that wouldn't go in: something's wrong here (walled off, someone in the way), so stop
      // and say so rather than walk about trying every cell
      if (this.abort || this.dead || placed >= max || misses >= 8) break;
      const [x, y, z, k] = todo[i];
      if (!missing(todo[i])) continue;
      const k0 = k.split("|")[0];
      if (k0 === "a" || k0 === "o") {
        // leaves, a trunk, dirt or a leftover block inside the building, in a window or the doorway: dig it out
        if (!(await this.mine(x, y, z))) misses++;
        continue;
      }
      if (k0 === "p" || k0 === "?p") {
        if (await this.makePath(x, y, z)) placed++;
        else if (!why && !this.inv.some((st) => st && itemDef(st.id)?.tool?.kind === "shovel")) why = "no shovel to dig the path with (a shovel is a cobblestone or planks and two sticks)";
        continue;
      }
      const want = this.wantFor(k);
      if (!want) {
        // nothing of the right kind for this cell: carry on with the cells it can do, and say what ran out
        const t = cellTarget(k0);
        if (t && !t.optional) {
          outOf = true;
          const item = itemOf(t.id);
          short.set(item, (short.get(item) ?? 0) + 1);
        } else if (!t && k0 !== "t" && k0 !== "c" && k0 !== "g") outOf = true;
        continue;
      }
      const cur = this.get(x, y, z);
      // something else where this block goes: out with it first (a flower, dirt in a wall, the lower-grade block an
      // upgrade replaces), but never a chest, a bed or a furnace (someone's things), never another building's door
      if (cur !== B.AIR && !IS_WATER[cur] && !BLOCKS[cur]?.replaceable) {
        // a furnace someone put down where a wall goes comes up (it drops, with what's in it): opus set one on the
        // second cottage's spot to smelt iron and then couldn't build there ("something is in the way"). Chests and
        // beds stay: those are someone's things
        if (KEEP(cur) && !(isFurnace(cur) && (await this.mine(x, y, z, false)))) {
          misses++;
          if (!why) why = `${BLOCKS[cur]?.name ?? "something"} at x=${x} y=${y} z=${z} is in the way`;
          continue;
        }
        if (!(await this.mine(x, y, z))) {
          misses++;
          continue;
        }
        if (this.get(x, y, z) !== B.AIR && !IS_WATER[this.get(x, y, z)] && !BLOCKS[this.get(x, y, z)]?.replaceable) {
          misses++;
          continue;
        }
      }
      // never wall itself in: step off a cell before a block goes there
      const fy = Math.floor(this.phys.y + 0.1);
      const onIt = () => Math.floor(this.phys.x) === x && Math.floor(this.phys.z) === z && (y === Math.floor(this.phys.y + 0.1) || y === Math.floor(this.phys.y + 0.1) + 1);
      if (SOLID[want.state] && onIt()) {
        const spot = this.standFor(x, y, z, blocks);
        if (spot) await this.goto(spot[0] + 0.5, spot[1], spot[2] + 0.5, 0.5, { maxMs: 4000 });
        else await this.goto(x + 0.5 + (x % 2 ? 1.6 : -1.6), fy, z + 0.5, 0.8, { maxMs: 3000 });
        // still there: not this one now (a thin pane went in round it and shut it in a window)
        if (onIt()) {
          later(todo[i]);
          misses++;
          continue;
        }
      }
      // a cell well above the ground round it is out of reach from anywhere down there: no long walk about first
      const round = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) => !footprint.has(`${x + dx},${z + dz}`)).map(([dx, dz]) => this.groundAt(x + dx, z + dz, y));
      const high = (round.length > 0 && y - Math.max(...round) > 4) || y - fy > 4;
      if (await this.place(want.item, x, y, z, high ? 3000 : 12000, want.state, blocks)) {
        placed++;
        misses = 0;
        if (isDoor(want.state)) await this.openDoor(x, y, z);
        continue;
      }
      if (this.abort || this.dead) break;
      // too high to reach from the ground (a roof's ridge, the top of a tower): up a pillar beside it (or inside the
      // room, on the floor), every block in reach from up there, then back down the pillar
      if (this.reachTo(x, y, z) > REACH && lifts < 12) {
        lifts++;
        const up = await this.scaffoldTo(x, y, z, footprint, inside, todo.slice(i).filter(missing));
        if (up >= 0) {
          for (const c of todo.slice(i)) {
            if (this.abort || this.dead || placed >= max) break;
            const w = this.wantFor(c[3]);
            if (!w || !missing(c) || this.reachTo(c[0], c[1], c[2]) > REACH) continue;
            const here = this.get(c[0], c[1], c[2]);
            if (here !== B.AIR && !IS_WATER[here] && !BLOCKS[here]?.replaceable && (KEEP(here) || !(await this.mine(c[0], c[1], c[2], false)))) continue;
            if (await this.place(w.item, c[0], c[1], c[2], 20000, w.state)) placed++;
          }
          if (up > 0) await this.climbDown(up, { x: this.lastPillar.x, z: this.lastPillar.z, top: this.lastPillar.top, keep: blocks });
          if (!missing(todo[i])) {
            misses = 0;
            continue;
          }
        }
      }
      misses++;
      later(todo[i]);
      if (!why && missing(todo[i])) {
        const g = this.groundAt(x, z, y);
        why = this.reachTo(x, y, z) > REACH
          ? `the block at x=${x} y=${y} z=${z} is out of reach${g >= 0 && y - g > 3 ? ` (${y - g} above the ground there)` : ""}${this.scaffoldNeed ? `, and no spare blocks to build a pillar up to it (${this.scaffoldNeed} dirt would do)` : ""}`
          : `something is in the way at x=${x} y=${y} z=${z} (someone standing there, or a block that isn't yours to replace)`;
      }
    }
    return { placed, left: cells.filter(missing).length, outOf, why, short };
  }

  /** Up beside a cell it can't reach from the ground: a pillar of its spare blocks under its feet (the way a player
   *  builds up to a roof), next to the building and never on its walls, or on the floor of the room inside (it takes
   *  the pillar back down with it). How many blocks it went up, or -1 if there is no spot for one. */
  private async scaffoldTo(x: number, y: number, z: number, footprint: Set<string>, inside: Map<string, number> = new Map(), rest: PlanCell[] = []): Promise<number> {
    const R = REACH - 0.3;
    let best: { cx: number; cz: number; g: number; k: number; score: number } | null = null;
    for (let dz = -3; dz <= 3; dz++)
      for (let dx = -3; dx <= 3; dx++) {
        const cx = x + dx;
        const cz = z + dz;
        const h = Math.hypot(dx, dz);
        const key = `${cx},${cz}`;
        if (h > 3.7 || (h < 1 && !inside.has(key)) || (footprint.has(key) && !inside.has(key))) continue;
        const g = inside.get(key) ?? this.groundAt(cx, cz, y);
        if (g < 0) continue;
        // feet at g + 1 + k, the eyes EYE_HEIGHT above: high enough that the cell is in reach (and not in it)
        const k = Math.max(0, Math.ceil(y + 0.5 - (g + 1 + EYE_HEIGHT) - Math.sqrt(Math.max(0, R * R - h * h))));
        if (k > 10 || (h < 1 && g + 1 + k + 1 >= y)) continue;
        let room = true;
        for (let yy = g + 1; yy <= g + k + 2 && room; yy++) if (SOLID[this.get(cx, yy, cz)] || IS_WATER[this.get(cx, yy, cz)]) room = false;
        if (!room) continue;
        // the spot that brings the most of what's still missing into reach (a roof's whole row from one pillar)
        const ey = g + 1 + k + EYE_HEIGHT;
        let covers = 0;
        for (const c of rest) if (Math.hypot(c[0] - cx, c[1] + 0.5 - ey, c[2] - cz) <= R) covers++;
        const score = k * 3 + Math.hypot(cx + 0.5 - this.phys.x, cz + 0.5 - this.phys.z) - Math.min(covers, 40) * 0.5;
        if (!best || score < best.score) best = { cx, cz, g, k, score };
      }
    if (!best) return -1;
    const { cx, cz, g, k } = best;
    const there = () => Math.floor(this.phys.x) === cx && Math.floor(this.phys.z) === cz && Math.abs(this.phys.y - (g + 1)) < 0.6;
    if (!there()) await this.goto(cx + 0.5, g + 1, cz + 0.5, 0.4, { maxMs: 15000, done: there });
    if (!there()) return -1;
    await this.center(cx, cz, 20);
    if (k > 0 && this.buildingBlocks().n < k + 1) {
      this.scaffoldNeed = Math.max(this.scaffoldNeed, k + 1 - this.buildingBlocks().n);
      return -1;
    }
    this.lastPillar = { x: cx, z: cz, top: g + k };
    return k > 0 ? await this.pillarUp(k) : 0;
  }

  /** Where its last scaffold pillar went up: the column, and the height of its top block. */
  private lastPillar = { x: 0, z: 0, top: 0 };
  /** Spare blocks the last buildCells was short of for a pillar up to a cell out of reach (0: none short). */
  scaffoldNeed = 0;

  /** Down the pillar it stands on, a block at a time (it gets the blocks back). */
  private async climbDown(n: number, pillar?: { x: number; z: number; top: number; keep?: Set<string> }): Promise<void> {
    for (let k = 0; k < n && !this.dead; k++) {
      const x = Math.floor(this.phys.x);
      const z = Math.floor(this.phys.z);
      const y = Math.floor(this.phys.y + 0.1) - 1;
      // only its own pillar: stepped off it (onto a roof, the top of a wall), what's underfoot is the building, and it
      // ate the keep's battlements block by block on the way "down"
      if (pillar && (x !== pillar.x || z !== pillar.z || y > pillar.top || pillar.keep?.has(`${x},${y},${z}`))) break;
      if (!SOLID[this.get(x, y, z)] || !(await this.mine(x, y, z, false))) break;
      await this.dropInto(x, y, z);
    }
    await this.pickUp(3, 2000);
  }

  // ---------------------------------------------------------------- farming

  /** Till and plant a field beside water near (cx, cz): a pond it finds, or water it pours from a bucket. */
  async makeFarm(cx: number, cz: number, cy: number, avoid: Rect[]): Promise<{ text: string; rect?: Rect }> {
    const hoe = this.inv.find((st) => st && isHoeId(st.id))?.id;
    if (!hoe) return { text: "you need a hoe to farm (craft wooden_hoe or stone_hoe: 2 planks or cobblestone and 2 sticks)" };
    if (!this.has(I.WHEAT_SEEDS)) return { text: "you need wheat_seeds (break tall grass for them, or take them from a village farm or the farmer's chest)" };
    // ground to till beside water at level wy: grass or dirt at the water's level or one above (a pond's bank)
    const landAt = (x: number, z: number, wy: number): number => {
      for (const y of [wy, wy + 1]) {
        const id = this.get(x, y, z);
        if ((id === B.GRASS || id === B.DIRT || isFarmland(id)) && !SOLID[this.get(x, y + 1, z)] && !IS_WATER[this.get(x, y + 1, z)]) return y;
      }
      return -1;
    };
    let water: [number, number, number] | null = null;
    for (const [x, y, z] of this.findBlocks([B.WATER], 40, 120)) {
      if (Math.hypot(x - cx, z - cz) > 40 || avoid.some((r) => x >= r.x0 - 3 && x <= r.x1 + 3 && z >= r.z0 - 3 && z <= r.z1 + 3)) continue;
      if (SOLID[this.get(x, y + 1, z)] || IS_WATER[this.get(x, y + 1, z)]) continue;
      let land = 0;
      for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) if (Math.abs(dx) + Math.abs(dz) <= 4 && landAt(x + dx, z + dz, y) >= 0) land++;
      if (land >= 6) {
        water = [x, y, z];
        break;
      }
    }
    // no pond by the base: fill the empty bucket it carries at any water, and pour it into a hole at the base
    if (!water && !this.has(I.WATER_BUCKET) && this.has(I.BUCKET)) await this.fillBucket();
    if (!water && this.has(I.WATER_BUCKET)) {
      const s = this.siteNear(cx, cz, cy, 5, 5, avoid, 28, 4);
      if (s) {
        const [wx, wy, wz] = [s.x0 + 2, s.y - 1, s.z0 + 2];
        if (SOLID[this.get(wx, wy, wz)] && !(await this.mine(wx, wy, wz))) return { text: "couldn't dig the hole for the water" };
        await this.goto(wx + 1.5, wy + 1, wz + 0.5, 1.5, { maxMs: 12000 });
        await this.hold(I.WATER_BUCKET);
        await this.lookAt(wx + 0.5, wy + 0.5, wz + 0.5, 10);
        this.send({ t: "place", x: wx, y: wy, z: wz, id: B.WATER });
        this.swing();
        await this.wait(8);
        if (IS_WATER[this.get(wx, wy, wz)]) water = [wx, wy, wz];
      }
    }
    if (!water)
      return {
        text: this.has(I.WATER_BUCKET)
          ? "no flat open 5 by 5 patch of grass or dirt within 28 blocks of the base for the field (clear some trees or level a patch, then farm again)"
          : this.has(I.BUCKET)
            ? "couldn't fill your bucket or find a spot for the water near the base"
            : "no pond within 40 blocks of the base: craft a bucket (3 iron_ingot) and farm again, it fills the bucket and brings the water",
      };
    const [wx, wy, wz] = water;
    let tilled = 0;
    let planted = 0;
    this.action = "farming";
    const field: [number, number][] = [];
    for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) if ((dx || dz) && Math.abs(dx) + Math.abs(dz) <= 4) field.push([wx + dx, wz + dz]);
    field.sort((a, b) => Math.hypot(a[0] - this.phys.x, a[1] - this.phys.z) - Math.hypot(b[0] - this.phys.x, b[1] - this.phys.z));
    for (const [x, z] of field) {
      if (this.abort || this.dead || !this.has(I.WHEAT_SEEDS)) break;
      const y = landAt(x, z, wy);
      if (y < 0) continue;
      if (!isFarmland(this.get(x, y, z))) {
        if (this.get(x, y + 1, z) !== B.AIR) await this.mine(x, y + 1, z); // tall grass on top
        if (this.reachTo(x, y, z) > REACH - 0.5) await this.goto(x + 0.5, y + 1, z + 0.5, 2.2, { maxMs: 6000, done: () => this.reachTo(x, y, z) <= REACH - 0.5 });
        await this.hold(hoe);
        await this.lookAt(x + 0.5, y + 1, z + 0.5, 8);
        this.send({ t: "use", x, y, z });
        this.swing();
        await this.wait(4);
        if (isFarmland(this.get(x, y, z))) tilled++;
      }
      if (isFarmland(this.get(x, y, z)) && this.get(x, y + 1, z) === B.AIR && (await this.place(I.WHEAT_SEEDS, x, y + 1, z))) planted++;
    }
    if (!planted) return { text: `couldn't plant by the water at x=${wx} z=${wz} (no open grass or dirt right beside it)` };
    return { text: `tilled ${tilled} and planted ${planted} wheat beside the water at x=${wx} z=${wz}; it ripens in about a day, then harvest`, rect: { x0: wx - 3, z0: wz - 3, x1: wx + 3, z1: wz + 3 } };
  }

  /** Fill the empty bucket it carries at the nearest water (within 48 blocks). */
  async fillBucket(): Promise<boolean> {
    if (!this.has(I.BUCKET)) return false;
    const w = this.findBlocks([B.WATER], 48, 8).find(([x, y, z]) => !SOLID[this.get(x, y + 1, z)]);
    if (!w) return false;
    const [x, y, z] = w;
    this.action = "filling a bucket";
    const near = () => this.reachTo(x, y, z) <= REACH - 0.6;
    if (!near()) await this.goto(x + 0.5, y + 1, z + 0.5, 2.5, { maxMs: 40000, done: near });
    if (!near()) return false;
    await this.hold(I.BUCKET);
    await this.lookAt(x + 0.5, y + 0.8, z + 0.5, 10);
    this.send({ t: "use", x, y, z });
    this.swing();
    for (let k = 0; k < 20 && !this.has(I.WATER_BUCKET); k++) await this.nextTick();
    return this.has(I.WATER_BUCKET);
  }

  /** Cut ripe wheat near it and plant seeds straight back. */
  async harvest(radius = 24): Promise<string> {
    const ripe = this.findBlocks([B.WHEAT + 7], radius, 40);
    if (!ripe.length) return `no ripe wheat within ${radius} blocks (wheat ripens about a day after planting)`;
    const before = this.count(I.WHEAT);
    let replanted = 0;
    this.action = "harvesting wheat";
    for (const [x, y, z] of ripe) {
      if (this.abort || this.dead) break;
      if (!(await this.mine(x, y, z))) continue;
      await this.pickUp(2, 1200);
      if (this.has(I.WHEAT_SEEDS) && this.get(x, y, z) === B.AIR && isFarmland(this.get(x, y - 1, z)) && (await this.place(I.WHEAT_SEEDS, x, y, z))) replanted++;
    }
    await this.pickUp(4, 3000);
    return `harvested ${this.count(I.WHEAT) - before} wheat and replanted ${replanted} (3 wheat make bread)`;
  }

  /** Inside its house: in the room. */
  atHome(): boolean {
    const h = this.home;
    if (!h) return false;
    const x = Math.floor(this.phys.x);
    const z = Math.floor(this.phys.z);
    const r = h.room ?? { x0: h.x0 + 1, z0: h.z0 + 1, x1: h.x0 + 2, z1: h.z0 + 2 };
    return x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1 && Math.abs(this.phys.y - h.y) < 1;
  }

  /** Back home for the night: walk in, block the doorway behind it if there's no door, sleep if there's a bed. */
  async goHome(): Promise<string> {
    const h = this.home;
    if (!h) return "you have no house yet (build_house)";
    if (!this.atHome()) {
      const [mx, mz] = this.homeMiddle();
      const inside = () => this.goto(h.room ? mx : h.x0 + 1.5, h.y, h.room ? mz : h.z0 + 1.5, 0.6, { maxMs: 60000, done: () => this.atHome() });
      await inside();
      // the doorway it blocked up behind itself last night (no door) shuts it out from the outside too: sonnet
      // walked round its own house in the dark and was shot. Open it from outside and go in
      if (!this.atHome()) {
        const [dx, dy, dz] = h.door;
        for (const yy of [dy, dy + 1]) if (SOLID[this.get(dx, yy, dz)] && !isDoor(this.get(dx, yy, dz))) await this.mine(dx, yy, dz);
        await this.goto(h.room ? mx : h.x0 + 1.5, h.y, h.room ? mz : h.z0 + 1.5, 0.6, { maxMs: 20000, done: () => this.atHome() });
      }
      if (!this.atHome()) {
        this.homeFailAt = Date.now();
        return "couldn't get back into your house";
      }
    }
    const [dx, dy, dz] = h.door;
    const d = this.get(dx, dy, dz);
    if (isDoor(d) && door(d).open) {
      // its door, left open on the way out: shut it
      await this.lookAt(dx + 0.5, dy + 0.5, dz + 0.5, 10);
      this.send({ t: "use", x: dx, y: dy, z: dz });
      await this.wait(4);
    } else if (this.get(dx, dy, dz) === B.AIR || this.get(dx, dy + 1, dz) === B.AIR) {
      // no door: close the doorway with two blocks (taken out again in the morning)
      await this.center(h.x0 + 2, h.z0 + 2, 20);
      for (const yy of [dy, dy + 1]) if (!SOLID[this.get(dx, yy, dz)] && this.nextBuildingBlock()) await this.place(this.nextBuildingBlock(), dx, yy, dz);
    }
    // in for the night: to bed (at dusk it waits by the bed for the dark)
    const bedHere = this.findBlocks([0, 1, 2, 3, 4, 5, 6, 7].map((k) => B.RED_BED + k), 3, 1).length > 0 || this.has(BLOCKS[B.RED_BED].item || B.RED_BED);
    if ((this.isNight() || this.timeOfDay() >= 11600) && bedHere) return `home, door shut: ${await this.sleep()}`;
    return "home, with the door shut";
  }

  /** Out of the house in the morning: open the doorway if it was blocked up. */
  async leaveHome(): Promise<string> {
    const h = this.home;
    if (!h || !this.atHome()) return "not at home";
    const [dx, dy, dz] = h.door;
    // out through the door, the way away from the middle of the room
    const [mx, mz] = this.homeMiddle();
    const ox = Math.abs(dx + 0.5 - mx) > Math.abs(dz + 0.5 - mz) ? Math.sign(dx + 0.5 - mx) : 0;
    const oz = ox ? 0 : Math.sign(dz + 0.5 - mz) || -1;
    await this.openDoorway();
    await this.goto(dx + 0.5 + ox * 2, dy, dz + 0.5 + oz * 2, 0.8, { maxMs: 8000 });
    return "out of the house";
  }

  /** Its doorway, from inside the house: the blocks it shut it with come out, and a shut door is opened. */
  /** Open every closed door within a few blocks (the bottom half takes the click). True if it opened one. */
  async openNearbyDoors(r = 4): Promise<boolean> {
    const fx = Math.floor(this.phys.x);
    const fy = Math.floor(this.phys.y + 0.1);
    const fz = Math.floor(this.phys.z);
    let opened = false;
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -r; dz <= r; dz++)
        for (let dx = -r; dx <= r; dx++) {
          const x = fx + dx, y = fy + dy, z = fz + dz;
          const id = this.get(x, y, z);
          if (!isDoor(id) || door(id).open || isDoor(this.get(x, y - 1, z))) continue;
          if (this.reachTo(x, y, z) > REACH) await this.goto(x + 0.5, y, z + 0.5, 2, { maxMs: 4000, done: () => this.reachTo(x, y, z) <= REACH });
          await this.lookAt(x + 0.5, y + 0.5, z + 0.5, 10);
          this.send({ t: "use", x, y, z });
          for (let k = 0; k < 10 && this.get(x, y, z) === id; k++) await this.nextTick();
          if (this.get(x, y, z) !== id) opened = true;
        }
    return opened;
  }

  async openDoorway(): Promise<void> {
    const h = this.home;
    if (!h) return;
    const [dx, dy, dz] = h.door;
    for (const yy of [dy + 1, dy]) {
      const id = this.get(dx, yy, dz);
      if (isDoor(id)) {
        if (yy === dy && !door(id).open) {
          await this.lookAt(dx + 0.5, yy + 0.5, dz + 0.5, 10);
          this.send({ t: "use", x: dx, y: yy, z: dz });
          for (let k = 0; k < 10 && this.get(dx, yy, dz) === id; k++) await this.nextTick();
        }
      } else if (SOLID[id]) await this.mine(dx, yy, dz, false);
    }
  }
}
