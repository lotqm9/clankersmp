// Headless protocol bot for tests: joins a shard, tracks the world diff, players and chat.

import WebSocket from "ws";
import { inflateRawSync } from "node:zlib";
import { PROTOCOL_NAME, PROTOCOL_VERSION, idx } from "../shared/constants.ts";
import { OP, decodeBlocks, decodePlayers, encodeMove, readBlockEntries, type CharityInfo, type PlayerSnap, type S2C } from "../shared/protocol.ts";
import { OP_ANIMALS, OP_ANIMALS_GONE, decodeAnimals, decodeGone, type AnimalSnap } from "../shared/animals.ts";
import { OP_ITEMS, OP_ITEMS_GONE, OP_ITEM_PICKUP, decodeIds, decodeItems, decodePickups, type ItemSnap } from "../shared/drops.ts";
import { OP_MOBS, OP_MOBS_GONE } from "../shared/mobs.ts";
import { OP_BOATS, OP_BOATS_GONE, decodeBoats, type BoatSnap } from "../shared/boats.ts";
import { OP_VILLAGERS, OP_VILLAGERS_GONE } from "../shared/villagers.ts";
import type { WireOffer } from "../shared/trades.ts";
import { OP_VOICE, decodeVoice, encodeVoiceUp, type VoiceFrame } from "../shared/voice.ts";
import { fromWire, type Stack } from "../shared/items.ts";
import type { Click } from "../shared/inventory.ts";
import type { GameMode, Stats, WindowKind } from "../shared/protocol.ts";

export class Bot {
  ws!: WebSocket;
  id = 0;
  name = "";
  shard = 0;
  welcome: Extract<S2C, { t: "welcome" }> | null = null;
  edits = new Map<number, number>(); // cell -> id, as seen by this client
  blockMsgs = 0;
  players = new Map<number, PlayerSnap>();
  known = new Map<number, string>(); // id -> name
  chats: { from: string | null; text: string; kind: string }[] = [];
  notices: string[] = [];
  tps: { x: number; y: number; z: number }[] = [];
  kicked = "";
  charity: CharityInfo | null = null;
  animals = new Map<number, AnimalSnap>();
  animalHistory: AnimalSnap[] = []; // every animal snapshot received, in order
  gone: number[] = [];
  animalBytes = 0;
  closed = false;
  x = 0;
  y = 0;
  z = 0;
  // v5 survival
  sel = 0;
  gm: GameMode = "survival";
  inv: (Stack | null)[] = new Array(36).fill(null);
  stats: Stats = { hp: 20, food: 20, sat: 5, air: 300 };
  statsLog: Stats[] = [];
  first = false;
  win: { w: number; kind: WindowKind; items: (Stack | null)[]; cursor: Stack | null } | null = null;
  winLog: { w: number; n: number }[] = [];
  closes: number[] = [];
  furnace: { burn: number; cook: number } | null = null;
  hurts: { cause: string }[] = [];
  deaths: string[] = [];
  respawns: { x: number; y: number; z: number }[] = [];
  sleepMsgs: { on: boolean; sleeping: number; needed: number }[] = [];
  fx: { k: string; id?: number }[] = [];
  times: number[] = [];
  items = new Map<number, ItemSnap>();
  pickups: [number, number][] = [];
  // v6
  armor: (Stack | null)[] = [null, null, null, null];
  mobs = new Map<number, AnimalSnap>();
  mobHistory: AnimalSnap[] = [];
  mobsGone: number[] = [];
  mobBytes = 0;
  arrows: { id: number; x: number; y: number; z: number; vx: number; vy: number; vz: number }[] = [];
  arrowEnds: { id: number; stuck: boolean; x: number; y: number; z: number }[] = [];
  struck: { id: number; mob: boolean; dmg: number; crit: boolean; kills: boolean }[] = [];
  wears: { id: number; armor: number }[] = [];
  hurtLog: { cause: string; kb?: [number, number, number] }[] = [];
  arrowGone: number[] = []; // v7: stuck arrows picked up (or gone)
  // v8
  boats = new Map<number, BoatSnap>();
  boatsGone: number[] = [];
  boatBytes = 0;
  rides: { p: number; b: number; s: number }[] = [];
  boatTps: { id: number; x: number; y: number; z: number; yaw: number }[] = [];
  // v9
  villagers = new Map<number, AnimalSnap>();
  villagerBytes = 0;
  offers: WireOffer[] | null = null; // the open trade window's offers
  tradeVid = 0;
  offerUpdates = 0;
  // v11 voice
  voiceIn: VoiceFrame[] = []; // every frame received
  voiceMsgs = 0;
  voiceBytes = 0;
  talking: number[] = [];
  talkingLog: number[][] = [];
  vcodec: boolean[] = []; // the server's codec hints (true: use the fallback)
  vstate: boolean[] = []; // admin mutes (true) and unmutes
  private voiceSeq = 0;
  private seq = 0;

  connect(url: string, opts: { name?: string; token?: string; shard?: number } = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let gotEdits = false;
      const timer = setTimeout(() => reject(new Error("join timeout")), 15000);
      const check = () => {
        if (this.welcome && gotEdits) {
          clearTimeout(timer);
          resolve();
        }
      };
      ws.on("open", () => ws.send(JSON.stringify({ t: "hello", g: PROTOCOL_NAME, v: PROTOCOL_VERSION, name: opts.name, token: opts.token, shard: opts.shard })));
      ws.on("message", (data: Buffer, isBinary: boolean) => {
        if (!isBinary) {
          const m = JSON.parse(data.toString()) as S2C;
          this.onJson(m);
          if (m.t === "welcome") check();
          if (m.t === "kick") {
            clearTimeout(timer);
            if (!this.welcome) reject(new Error("kicked: " + m.reason));
          }
          return;
        }
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const op = data[0];
        if (op === OP.EDITS) {
          const flat = readBlockEntries(new Uint8Array(inflateRawSync(data.subarray(5))));
          for (let o = 0; o + 3 < flat.length; o += 4) this.edits.set(idx(flat[o], flat[o + 1], flat[o + 2]), flat[o + 3]);
          gotEdits = true;
          check();
        } else if (op === OP.BLOCKS) {
          this.blockMsgs++;
          for (const c of decodeBlocks(view)) this.edits.set(idx(c.x, c.y, c.z), c.id);
        } else if (op === OP.PLAYERS) {
          for (const s of decodePlayers(view).list) this.players.set(s.id, s);
        } else if (op === OP_ANIMALS) {
          this.animalBytes += data.length;
          for (const a of decodeAnimals(view).list) {
            this.animals.set(a.id, a);
            this.animalHistory.push(a);
          }
        } else if (op === OP_ITEMS) {
          for (const it of decodeItems(view).list) this.items.set(it.id, it);
        } else if (op === OP_ITEMS_GONE) {
          for (const id of decodeIds(view)) this.items.delete(id);
        } else if (op === OP_ITEM_PICKUP) {
          for (const pk of decodePickups(view)) {
            this.pickups.push(pk);
            this.items.delete(pk[0]);
          }
        } else if (op === OP_MOBS) {
          this.mobBytes += data.length;
          for (const a of decodeAnimals(view).list) {
            this.mobs.set(a.id, a);
            this.mobHistory.push(a);
          }
        } else if (op === OP_MOBS_GONE) {
          this.mobBytes += data.length;
          for (const id of decodeGone(view)) {
            this.mobs.delete(id);
            this.mobsGone.push(id);
          }
        } else if (op === OP_VILLAGERS) {
          this.villagerBytes += data.length;
          for (const a of decodeAnimals(view).list) this.villagers.set(a.id, a);
        } else if (op === OP_VILLAGERS_GONE) {
          this.villagerBytes += data.length;
          for (const id of decodeGone(view)) this.villagers.delete(id);
        } else if (op === OP_BOATS) {
          this.boatBytes += data.length;
          for (const b of decodeBoats(view).list) this.boats.set(b.id, b);
        } else if (op === OP_BOATS_GONE) {
          this.boatBytes += data.length;
          for (const id of decodeGone(view)) {
            this.boats.delete(id);
            this.boatsGone.push(id);
          }
        } else if (op === OP_VOICE) {
          this.voiceMsgs++;
          this.voiceBytes += data.length;
          for (const f of decodeVoice(view)) this.voiceIn.push({ ...f, data: new Uint8Array(f.data) });
        } else if (op === OP_ANIMALS_GONE) {
          this.animalBytes += data.length;
          for (const id of decodeGone(view)) {
            this.animals.delete(id);
            this.gone.push(id);
          }
        }
      });
      ws.on("close", () => (this.closed = true));
      ws.on("error", (e) => reject(e));
    });
  }

  /** v11: voice on/off, hearing, and whether we can decode Opus. */
  voice(mic: boolean, hear = true, opus = true): void {
    this.send({ t: "voice", mic, hear, opus });
  }
  /** v11: one voice frame (any bytes: the server never decodes them). */
  speak(payload: Uint8Array, codec = 1): void {
    if (this.ws?.readyState === 1) this.ws.send(new Uint8Array(encodeVoiceUp(codec, this.voiceSeq++, payload)));
  }
  /** Frames received from one speaker. */
  heard(speaker: number): VoiceFrame[] {
    return this.voiceIn.filter((f) => f.speaker === speaker);
  }

  private onJson(m: S2C): void {
    switch (m.t) {
      case "talking":
        this.talking = m.ids;
        this.talkingLog.push(m.ids);
        break;
      case "vcodec":
        this.vcodec.push(m.adpcm);
        break;
      case "vstate":
        this.vstate.push(m.adminMuted);
        break;
      case "welcome":
        this.welcome = m;
        this.id = m.id;
        this.name = m.name;
        this.shard = m.shard.n;
        this.x = m.you.x;
        this.y = m.you.y;
        this.z = m.you.z;
        for (const p of m.players) this.known.set(p.id, p.name);
        this.gm = m.gm;
        this.inv = m.inv.map((w) => fromWire(w));
        this.armor = (m.armor ?? []).map((w) => fromWire(w));
        while (this.armor.length < 4) this.armor.push(null);
        this.sel = m.sel;
        this.stats = m.stats;
        this.first = m.first;
        break;
      case "time":
        this.times.push(m.time);
        break;
      case "slots":
        for (const [k, w] of m.list) {
          if (k >= 36) this.armor[k - 36] = fromWire(w);
          else this.inv[k] = fromWire(w);
        }
        break;
      case "arrow":
        this.arrows.push({ id: m.id, x: m.x, y: m.y, z: m.z, vx: m.vx, vy: m.vy, vz: m.vz });
        break;
      case "arrow_end":
        this.arrowEnds.push({ id: m.id, stuck: m.stuck, x: m.x, y: m.y, z: m.z });
        break;
      case "arrow_gone":
        this.arrowGone.push(m.id);
        break;
      case "ride":
        this.rides.push({ p: m.p, b: m.b, s: m.s });
        break;
      case "boat_tp":
        this.boatTps.push({ id: m.id, x: m.x, y: m.y, z: m.z, yaw: m.yaw });
        break;
      case "struck":
        this.struck.push({ id: m.id, mob: m.mob, dmg: m.dmg, crit: m.crit, kills: m.kills });
        break;
      case "wear":
        this.wears.push({ id: m.id, armor: m.armor });
        break;
      case "open":
        this.win = { w: m.w, kind: m.kind, items: m.items.map((x) => fromWire(x)), cursor: fromWire(m.cursor) };
        if (m.kind === "trade") {
          this.offers = m.offers ?? [];
          this.tradeVid = m.vid ?? 0;
        }
        break;
      case "offers":
        if (this.win && this.win.w === m.w) {
          this.offers = m.offers;
          this.offerUpdates++;
        }
        break;
      case "win":
        this.winLog.push({ w: m.w, n: m.n });
        if (m.w === 0 || (this.win && this.win.w === m.w)) {
          const items = m.items.map((x) => fromWire(x));
          if (m.w === 0) this.win0 = { items, cursor: fromWire(m.cursor) };
          else this.win = { ...this.win!, items, cursor: fromWire(m.cursor) };
          this.syncInvFrom(m.w === 0 ? "player" : this.win!.kind, items);
        }
        break;
      case "close":
        this.closes.push(m.w);
        if (this.win && this.win.w === m.w) this.win = null;
        break;
      case "furnace":
        this.furnace = { burn: m.burn, cook: m.cook };
        break;
      case "stats":
        this.stats = m.s;
        this.statsLog.push(m.s);
        break;
      case "hurt":
        this.hurts.push({ cause: m.cause });
        this.hurtLog.push({ cause: m.cause, kb: m.kb });
        break;
      case "dead":
        this.deaths.push(m.msg);
        break;
      case "respawned":
        this.respawns.push({ x: m.x, y: m.y, z: m.z });
        this.x = m.x;
        this.y = m.y;
        this.z = m.z;
        break;
      case "gm":
        this.gm = m.mode;
        break;
      case "sleep":
        this.sleepMsgs.push({ on: m.on, sleeping: m.sleeping, needed: m.needed });
        break;
      case "fx":
        this.fx.push({ k: m.k, id: m.id });
        break;
      case "join":
        this.known.set(m.p.id, m.p.name);
        break;
      case "leave":
        this.known.delete(m.id);
        this.players.delete(m.id);
        break;
      case "chat":
        this.chats.push({ from: m.from, text: m.text, kind: m.kind });
        break;
      case "notice":
        this.notices.push(m.text);
        break;
      case "tp":
        this.tps.push({ x: m.x, y: m.y, z: m.z });
        this.x = m.x;
        this.y = m.y;
        this.z = m.z;
        break;
      case "kick":
        this.kicked = m.reason;
        break;
      case "charity":
        this.charity = m.c;
        break;
    }
  }

  move(x: number, y: number, z: number, yaw = 0, pitch = 0, flags = 4): void {
    this.x = x;
    this.y = y;
    this.z = z;
    this.ws.send(encodeMove({ x, y, z, yaw, pitch, flags, held: this.sel }));
  }

  // ---- v5 survival
  win0: { items: (Stack | null)[]; cursor: Stack | null } | null = null;

  /** The player-inventory part of a window's contents back into `inv`. */
  private syncInvFrom(kind: WindowKind, items: (Stack | null)[]): void {
    if (kind === "player") for (let k = 0; k < 4; k++) this.armor[k] = items[5 + k] ?? null;
    const start = kind === "player" ? 9 : kind === "crafting" ? 10 : kind === "furnace" ? 3 : kind === "trade" ? 0 : 27;
    for (let k = 0; k < 27; k++) this.inv[9 + k] = items[start + k] ?? null;
    for (let k = 0; k < 9; k++) this.inv[k] = items[start + 27 + k] ?? null;
  }

  select(s: number): void {
    this.sel = s;
    this.ws.send(JSON.stringify({ t: "sel", s }));
  }

  click(w: number, c: Click): number {
    const n = ++this.seq;
    this.ws.send(JSON.stringify({ t: "click", w, n, c }));
    return n;
  }

  closeWindow(w: number): void {
    this.ws.send(JSON.stringify({ t: "close", w }));
    if (this.win && this.win.w === w) this.win = null;
  }

  send(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  count(id: number): number {
    return this.inv.reduce((n, s) => n + (s && s.id === id ? s.n : 0), 0);
  }

  place(x: number, y: number, z: number, id: number): void {
    this.ws.send(JSON.stringify({ t: "place", x, y, z, id }));
  }

  /** Left-click an animal. */
  hit(id: number): void {
    this.ws.send(JSON.stringify({ t: "hit", id }));
  }

  /** v6: hit a night mob. */
  hitMob(id: number): void {
    this.ws.send(JSON.stringify({ t: "hit", id, mob: true }));
  }

  /** A swing at nothing (starts the attack cooldown over). */
  swing(): void {
    this.ws.send(JSON.stringify({ t: "swing" }));
  }

  /** Right-click a door. */
  use(x: number, y: number, z: number): void {
    this.ws.send(JSON.stringify({ t: "use", x, y, z }));
  }

  dig(a: "start" | "abort" | "finish", x: number, y: number, z: number): void {
    this.ws.send(JSON.stringify({ t: "dig", a, x, y, z }));
  }

  chat(text: string): void {
    this.ws.send(JSON.stringify({ t: "chat", text }));
  }

  /** v8: where this player sits now (from the ride messages): [boat id, seat], or null. */
  riding(playerId = this.id): { b: number; s: number } | null {
    for (let k = this.rides.length - 1; k >= 0; k--) if (this.rides[k].p === playerId) return this.rides[k].b ? { b: this.rides[k].b, s: this.rides[k].s } : null;
    return null;
  }

  /** Block id at a cell as this client believes it: its diff over the generated world. */
  block(base: Uint8Array, x: number, y: number, z: number): number {
    const i = idx(x, y, z);
    return this.edits.has(i) ? this.edits.get(i)! : base[i];
  }

  close(): void {
    this.ws.close();
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(pred: () => boolean, ms = 5000, what = "condition"): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** v10 (the bigger hub): corners to try for a test's flat patch, nearest the spawn first, from `from` blocks out
 *  (every 2 blocks over the whole island: the land round the bigger hub has fewer flat spots than the old one's). */
export function patchSpots(from: number, to = 220): [number, number][] {
  const c: [number, number, number][] = [];
  for (let z = 8; z < 504; z += 2)
    for (let x = 8; x < 504; x += 2) {
      const r = Math.hypot(x - 256, z - 256);
      if (r >= from && r < to) c.push([x, z, r]);
    }
  c.sort((a, b) => a[2] - b[2] || a[1] - b[1] || a[0] - b[0]);
  return c.map(([x, z]) => [x, z]);
}
