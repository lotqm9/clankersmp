// One shard = one shared world ("Server 1", "Server 2", ...). The server is authoritative for blocks:
// every place/break is validated (reach, rate, the spawn safe zone, dig time with the tool in hand, support, not
// inside a player, the item in hand) before it is applied and broadcast. Movement is client-simulated and
// server-checked. Survival (v5: inventories, windows, drops, health) lives in survival.ts, dropped items in
// items.ts, furnaces and chests in containers.ts; v6 night mobs and their arrows in mobs.ts (with light.ts for
// where it is dark).

import { deflateRawSync, deflateRaw } from "node:zlib";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { B, BLOCKS, IS_WATER, SOLID, isFurnace, isStorage, isValidBlockId } from "../../shared/blocks.ts";
import { breakChanges, door, doorId, isDoor, isOpenable, pathBreaksUnder, placeChanges, placementCells, toggleOpenable } from "../../shared/shapes.ts";
import { BF, BOAT_BREAK, BOAT_H, BOAT_W, MAX_RIDERS, boatFits } from "../../shared/boats.ts";
import { BOATS_NEAR_CAP, BoatManager, type Boat } from "./boats.ts";
import { LootLedger } from "./loot.ts";
import { VoiceRelay, newVoiceState, type VoiceState } from "./voice.ts";
import { OP_VOICE_UP } from "../../shared/voice.ts";
import { VillagerManager, type Villager } from "./villagers.ts";
import { MAX_VILLAGES, VILLAGE_SITES, chooseVillages, villageBox } from "../../shared/villages.ts";
import { TALK_REACH_SERVER, VILLAGER_H, VILLAGER_W } from "../../shared/villagers.ts";
import { waterSurface } from "../../shared/physics.ts";
import {
  CHAT_MAX,
  CROUCH_HEIGHT,
  DAY_TICKS,
  EYE_HEIGHT,
  MAX_PLAYERS_PER_SHARD,
  PLAYER_HEIGHT,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  SERVER_REACH,
  SNEAK_EYE_HEIGHT,
  SPAWN_X,
  SPAWN_Z,
  VOLUME,
  WORLDGEN_VERSION,
  WORLD_HEIGHT,
  WORLD_SIZE,
  cellX,
  cellY,
  cellZ,
  idx,
  inWorld,
} from "../../shared/constants.ts";
import { playerInsideSolid, shapeIntersectsPlayer } from "../../shared/physics.ts";
import {
  BLOCK_ENTRY,
  FLAG,
  OP,
  decodeMove,
  encodeBlocks,
  encodePlayers,
  writeBlockEntry,
  type BlockChange,
  type C2S,
  type CharityInfo,
  type MoveMsg,
  type PlayerInfo,
  type PlayerSnap,
  type S2C,
  type ShardInfo,
} from "../../shared/protocol.ts";
import { generateWorld, hashBlocks, type GenInfo } from "../../shared/worldgen.ts";
import { ANIMAL_REACH, SPECS, distToBox } from "../../shared/animals.ts";
import { AnimalManager, type Seen } from "./animals.ts";
import { MOB_SPECS } from "../../shared/mobs.ts";
import { packArmor } from "../../shared/combat.ts";
import { LightIndex } from "./light.ts";
import { MobManager, type MobTarget } from "./mobs.ts";
import { FarmManager } from "./farm.ts";
import { LeafDecay } from "./leaves.ts";
import { ItemManager } from "./items.ts";
import { Containers } from "./containers.ts";
import { Survival, newSurvival, type SurvivalData, type SurvivalState } from "./survival.ts";
import { SafeZone, TILE, TILES, keepTiles, type HubPlan } from "../../shared/hub12.ts";
import { I, itemDef, ITEMS, toWire } from "../../shared/items.ts";
import { waterBeside } from "../../shared/enchanting.ts";
import { blockDrops } from "../../shared/mining.ts";
import { treeChanges } from "../../shared/trees.ts";
import { isSapling } from "../../shared/blocks.ts";
import { WaterSim } from "./water.ts";
import { filterText, sanitizeChat } from "./filter.ts";
import { ShardStore, type EditEntry, type SavedPos } from "./store.ts";
import { Bucket, log } from "./util.ts";

/** 12.1.1: players per shard: the MAX_PLAYERS_PER_SHARD env if set, else the shared default (100). */
export const PLAYER_CAP = Math.max(1, Math.floor(Number(process.env.MAX_PLAYERS_PER_SHARD) || MAX_PLAYERS_PER_SHARD));

/** Commands that only exist on test servers (DEV_COMMANDS=1). */
const DEV_ONLY = new Set(["tp", "summon", "give", "grow", "gamemode", "kill", "hunger", "hurt", "time", "mobs"]);

export interface Player {
  id: number;
  name: string;
  key: string; // hashed client token (stable per browser)
  ip: string; // hashed ip
  ws: WebSocket;
  skin: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  flags: number;
  held: number;
  version: number;
  sent: Map<number, number>;
  lastMoveAt: number;
  vx: number; // last valid position
  vy: number;
  vz: number;
  pendingTp: { x: number; y: number; z: number; until: number } | null;
  dig: { x: number; y: number; z: number; at: number } | null; // at: Date.now() when the dig started
  /** A dig whose "finish" came a little early (lag bunched the start and the finish): it completes once the full
   *  dig time has passed since the server saw the start (Java's delayed destroy). One at a time. */
  delayedDig: { x: number; y: number; z: number; at: number; id: number } | null;
  place: Bucket;
  brk: Bucket;
  chat: Bucket; // public chat: 5 messages, then one a second (5 per 5 s)
  cmds: Bucket; // slash commands: 10 at once, 10 a second
  slowNoticeAt: number; // the "slow down" notice at most once a second
  moves: Bucket;
  msgs: Bucket; // every message, any kind: flood guard
  violations: number;
  violationWindow: number;
  lastChat: string;
  lastChatAt: number;
  joinedAt: number;
  groundedAt: number;
  groundedY: number;
  lastResync: number;
  seenAnimals: Seen;
  hits: Bucket;
  // v5 survival
  sv: SurvivalState;
  sflags: number; // flags the server sets (sleeping, dead, eating, hurt), sent with the client's own
  hurtFlagUntil: number;
  seenItems: Seen;
  // v6
  armor: number; // what they wear (packArmor), for the other players
  seenMobs: Seen;
  // v8
  riding: number; // the boat they sit in (0: none)
  boatMoves: Bucket; // the driver's boat updates
  seenBoats: Seen;
  // v9
  seenVillagers: Seen;
  /** v11: proximity voice (server/src/voice.ts). */
  voice: VoiceState;
  /** clankersmp: one of the AIs (opus, sonnet, haiku). */
  agent?: boolean;
  /** v14: an AI with its inventory screen open (its watchers see it). */
  invOpen?: boolean;
  /** clankersmp spectators (Shard.specs, never in `players`): the AI they watch, and the last HUD sent for it. */
  follow?: string;
  folSent?: string;
  corrLogAt?: number;
  /** "inside block" snapbacks in a row, and since when: a loop when the spot it is sent back to is itself bad. */
  insideN?: number;
  insideAt?: number;
}

export interface ShardHooks {
  counts(): ShardInfo[];
  charity(): CharityInfo;
  onCountChange(): void;
  kick(p: Player, reason: string): void;
  /** clankersmp hardcore: an AI died (it never comes back), and how a dead one went. */
  died?(p: Player, msg: string): void;
  deathOf?(name: string): string | null;
}

export interface RollbackFilter {
  key?: string;
  name?: string;
  ip?: string;
  area?: { x1: number; z1: number; x2: number; z2: number; y1?: number; y2?: number };
  sinceMs: number;
}

const SKINS = 32; // 8 shirt colours x 4 skin tones
/** clankersmp's three wear their own clothes (client textures.ts: AGENT_SKIN_BASE): a red hoodie, a blue jacket, a yellow raincoat. */
const AGENT_SKINS: Record<string, number> = { opus: 100, sonnet: 101, haiku: 102 };
const HARBOUR_BOAT_CAP = 150; // the harbour stops putting boats out when the shard has this many (BOAT_CAP is 200)

export class Shard {
  readonly n: number;
  readonly seed: number;
  readonly world: Uint8Array;
  readonly base: Uint8Array;
  readonly genHash: number;
  readonly info: GenInfo;
  readonly store: ShardStore;
  edits = new Map<number, number>();
  log: EditEntry[] = [];
  players = new Map<number, Player>();
  /** clankersmp: spectators. Not in the world (mobs, items and players never see them): each is sent what someone
   *  standing where its AI stands would be. */
  specs = new Map<number, Player>();
  positions = new Map<string, SavedPos>();
  readonly animals: AnimalManager;
  readonly water: WaterSim;
  readonly items: ItemManager;
  readonly containers: Containers;
  readonly survival: Survival;
  readonly light: LightIndex;
  readonly mobs: MobManager;
  /** v7: crops, sugar cane and farmland (server/src/farm.ts). */
  readonly farm: FarmManager;
  /** Leaves wither once their tree is cut down (server/src/leaves.ts). */
  readonly leaves: LeafDecay;
  /** v8: boats (server/src/boats.ts) and the treasure chests filled once per world (server/src/loot.ts). */
  readonly boats: BoatManager;
  readonly loot: LootLedger;
  /** Ticks added to the clock by skipped nights (saved). */
  private timeShift = 0;
  /** Planted saplings (cells): each grows into a tree after a few minutes on average. */
  readonly saplings = new Set<number>();
  tickCount = 0;
  private pending: BlockChange[] = [];
  private dirty = false;
  private editsVersion = 0;
  private editsBlob: { version: number; buf: Buffer } | null = null;
  private worldBlob: { version: number; buf: Buffer } | null = null;
  private hooks: ShardHooks;
  private chatLogPath: string;
  /** v9: the village sites in this world (sent in the welcome: the client builds the same ones). */
  villageSites: number[] = [];
  villagers!: VillagerManager;
  /** v11: proximity voice: the relay (server/src/voice.ts). */
  readonly voice: VoiceRelay;
  /** v10 (update 12): the bigger hub's plan (decided once, kept in hub.json: the tiles left alone for players' builds,
   *  the villages with a road) and its safe zone. */
  hubPlan: HubPlan = { keep: [], roads: [] };
  readonly zone: SafeZone;

  constructor(n: number, seed: number, worldDir: string, hooks: ShardHooks) {
    this.n = n;
    this.seed = seed;
    this.hooks = hooks;
    this.store = new ShardStore(worldDir, n);
    this.chatLogPath = join(this.store.dir, "chat.log");
    if (!this.store.checkSeed(seed, WORLDGEN_VERSION)) log(`shard ${n}: seed or terrain version changed, previous world moved aside`);
    this.edits = this.store.loadEdits();
    // v9: the villages go only where this world has no edits at all (decided once, kept in villages.json)
    this.villageSites = this.chooseVillageSites();
    // v10: the bigger hub, built round every player's edit (decided once, kept in hub.json)
    this.hubPlan = this.chooseHubPlan();
    this.zone = new SafeZone(this.hubPlan.keep);
    if (process.env.SAFE_ZONE === "0") this.zone.off = true;
    const gen = generateWorld(seed, undefined, { villages: this.villageSites, hub: this.hubPlan });
    this.base = gen.blocks;
    this.info = gen.info;
    this.genHash = hashBlocks(this.base);
    this.world = new Uint8Array(VOLUME);
    this.world.set(this.base);
    for (const [i, id] of this.edits) if (i >= 0 && i < VOLUME && isValidBlockId(id)) this.world[i] = id;
    for (const [i, id] of this.edits) if (isSapling(id) && this.world[i] === id) this.saplings.add(i);
    this.log = this.store.loadLog();
    this.positions = this.store.loadPlayers();
    this.animals = new AnimalManager(this.getBlock, this.store.dir);
    this.animals.zone = this.zone;
    this.animals.load();
    this.water = new WaterSim(this.getBlock, (i, id) => this.setBlock(i, id, null, true), this.store.dir);
    this.water.load(0);
    this.items = new ItemManager(this.getBlock, this.store.dir);
    this.items.load();
    // leaves wither once no log is near them (a felled tree's canopy goes); the ones players put down stay. A world
    // from before this has no leaves.json yet: the leaves players put down come from the edit log
    this.leaves = new LeafDecay(this.getBlock, {
      set: (i, id) => {
        this.setBlock(i, id, null, false, true);
        this.water.touched(i, this.tickCount);
      },
      drop: (st, x, y, z) => this.items.dropAt(st, x, y, z),
    }, this.store.dir);
    if (!this.leaves.load()) this.leaves.seed(this.log, this.world);
    this.containers = new Containers(this.store.dir);
    this.containers.load((c) => this.world[c]);
    // v8: the islands' treasure chests, filled once per world
    this.loot = new LootLedger(this.store.dir);
    this.fillLoot();
    this.boats = new BoatManager(this.getBlock, this.store.dir);
    this.boats.load();
    this.boats.onMoved = (b) => this.ridersFollow(b);
    this.harbourBoats(); // v10: boats waiting at the harbour
    this.light = new LightIndex(this.world);
    this.farm = new FarmManager(this.getBlock, this.light, {
      set: (i, id) => this.setBlock(i, id, null, false, true),
      drop: (st, x, y, z) => this.items.dropAt(st, x, y, z),
    });
    this.farm.scan(this.world);
    this.mobs = new MobManager(this.getBlock, this.light);
    this.mobs.zone = this.zone;
    this.survival = new Survival(this);
    this.survival.attachMobs();
    this.mobs.hooks.arrowShot = (a) => this.broadcastNearPoint(a.x, a.z, { t: "arrow", id: a.id, x: +a.x.toFixed(3), y: +a.y.toFixed(3), z: +a.z.toFixed(3), vx: +a.vx.toFixed(4), vy: +a.vy.toFixed(4), vz: +a.vz.toFixed(4) }, 80);
    this.mobs.hooks.arrowEnded = (a, stuck) => this.broadcastNearPoint(a.x, a.z, { t: "arrow_end", id: a.id, x: +a.x.toFixed(3), y: +a.y.toFixed(3), z: +a.z.toFixed(3), stuck }, 96);
    try {
      const tf = join(this.store.dir, "time.json");
      if (existsSync(tf)) this.timeShift = Number(JSON.parse(readFileSync(tf, "utf8")).shift) || 0;
    } catch {
      /* keep the clock */
    }
    // v9: the villagers (after the clock: at night they start at home)
    this.villagers = new VillagerManager(this.getBlock, this.store.dir, this.info.villages.list);
    this.villagers.setDoor = (x, y, z, lowerId) => {
      // both halves; a server change (like a growing crop), not a player's edit
      const d = door(lowerId);
      this.setBlock(idx(x, y, z), lowerId, null, false, true);
      if (y + 1 < WORLD_HEIGHT && isDoor(this.world[idx(x, y + 1, z)])) this.setBlock(idx(x, y + 1, z), doorId(d.facing, d.open, true), null, false, true);
    };
    this.villagers.load(this.worldTime());
    // v11: proximity voice, relayed by the server to players in range (VOICE_OFF=1 turns it off)
    this.voice = new VoiceRelay(this.store.dir, {
      sendBin: (q, data) => this.sendBin(q as Player, data),
      backlogged: (q) => (q as Player).ws.bufferedAmount > 256 * 1024,
      send: (q, msg) => this.send(q as Player, msg as S2C),
      broadcast: (msg) => this.broadcast(msg as S2C),
    });
    log(`shard ${n}: ${this.edits.size} edits, ${this.log.length} log entries, ${this.animals.animals.size} animals, ${this.boats.boats.size} boats, ${this.info.villages.list.length} villages (${this.info.villages.list.map((v) => v.name).join(", ") || "none"}), terrain hash ${this.genHash.toString(16)}`);
  }

  /** v9: which village sites this world has. Decided the first time a server with villages starts on it: the
   *  sites whose square has no edits (shared/villages.ts chooseVillages), then kept in villages.json for good.
   *  v9 (update 11.1): a world with fewer than four (its players had built on the first sites) gets more at the next
   *  start: sites further out with no edits at all in their square, spread out. The villages it has stay as they are. */
  private chooseVillageSites(): number[] {
    // v10: once the bigger hub is decided its roads lead to these villages, so they stay as they are
    const hub = this.readHubJson();
    if (hub) return hub.villages;
    const f = join(this.store.dir, "villages.json");
    let decided: number[] | undefined;
    let before: Record<string, unknown> = {};
    if (existsSync(f)) {
      try {
        const j = JSON.parse(readFileSync(f, "utf8")) as { sites?: unknown };
        if (Array.isArray(j.sites) && j.sites.every((k) => Number.isInteger(k) && k >= 0 && k < VILLAGE_SITES.length)) {
          decided = j.sites as number[];
          before = j as Record<string, unknown>;
        }
      } catch {
        /* decide again below (from the same edits: the same answer) */
      }
    }
    if (decided && decided.length >= MAX_VILLAGES) return decided;
    // which sites' squares hold an edit (one pass over the edits)
    const boxes = VILLAGE_SITES.map((_, k) => villageBox(k));
    const touched = new Set<number>();
    for (const i of this.edits.keys()) {
      const x = cellX(i);
      const z = cellZ(i);
      boxes.forEach((q, k) => {
        if (x >= q.x0 && x <= q.x1 && z >= q.z0 && z <= q.z1) touched.add(k);
      });
    }
    const sites = chooseVillages((k) => touched.has(k), decided);
    if (decided && sites.length === decided.length) return decided; // nothing free to add (try again next start)
    const added = sites.filter((k) => !decided?.includes(k));
    try {
      const record = { ...before, sites, decided: before.decided ?? new Date().toISOString(), edits: this.edits.size, skipped: [...touched].sort((a, c) => a - c) };
      if (decided) Object.assign(record, { added: [...((before.added as unknown[]) ?? []), { sites: added, at: new Date().toISOString() }] });
      writeFileSync(f, JSON.stringify(record));
    } catch {
      /* the choice is the same next time (edits only grow outside the villages) */
    }
    const names = (l: number[]) => l.map((k) => VILLAGE_SITES[k].name).join(", ") || "none";
    if (decided) log(`shard ${this.n}: villages added: ${names(added)} (kept: ${names(decided)}; ${touched.size} sites edited)`);
    else log(`shard ${this.n}: villages decided: ${names(sites)}${touched.size ? ` (${touched.size} sites edited)` : ""}`);
    return sites;
  }

  /** v10: hub.json, if this world's bigger hub is decided (and the file is sound). */
  private readHubJson(): { keep: number[]; roads: number[]; villages: number[] } | null {
    const f = join(this.store.dir, "hub.json");
    if (!existsSync(f)) return null;
    try {
      const j = JSON.parse(readFileSync(f, "utf8")) as { keep?: unknown; roads?: unknown; villages?: unknown };
      const ints = (a: unknown, max: number): a is number[] => Array.isArray(a) && a.every((k) => Number.isInteger(k) && k >= 0 && k < max);
      if (ints(j.keep, TILES * TILES) && ints(j.roads, VILLAGE_SITES.length) && ints(j.villages, VILLAGE_SITES.length)) return { keep: j.keep, roads: j.roads, villages: j.villages };
    } catch {
      /* decided again below */
    }
    log(`shard ${this.n}: hub.json unreadable, deciding the hub again`);
    return null;
  }

  /** v10 (update 12): the bigger hub's plan for this world. Decided the first time a v10 server starts on it: every
   *  8 x 8 tile holding an edit (or within 3 blocks of one) is left exactly as it is, and stays out of the safe zone,
   *  so nothing a player built is touched; roads lead to the villages the world has. Kept in hub.json for good: the
   *  terrain never changes under anyone again (and no more villages are added: the roads lead to these). */
  private chooseHubPlan(): HubPlan {
    const saved = this.readHubJson();
    if (saved) return { keep: saved.keep, roads: saved.roads };
    const plan: HubPlan = { keep: keepTiles(this.edits.keys()), roads: [...this.villageSites] };
    // how many of them are in or by the hub (r 84: the levelled hub, its eased edge and a tile more)
    const near = plan.keep.filter((t) => {
      const x = (t % TILES) * TILE + TILE / 2 - SPAWN_X;
      const z = Math.floor(t / TILES) * TILE + TILE / 2 - SPAWN_Z;
      return x * x + z * z <= 84 * 84;
    });
    try {
      writeFileSync(join(this.store.dir, "hub.json"), JSON.stringify({ ...plan, villages: this.villageSites, decided: new Date().toISOString(), edits: this.edits.size, nearHub: near.length }));
    } catch {
      /* decided again next start (from the edits then) */
    }
    log(`shard ${this.n}: bigger hub decided: ${plan.keep.length} tiles kept for players' edits (${near.length} in or by the hub), roads to ${plan.roads.map((k) => VILLAGE_SITES[k].name).join(", ") || "no villages"} and the harbour`);
    return plan;
  }

  /** v10: boats wait at the harbour. An empty slot gets a boat (only with nobody near it, so none pops up under
   *  anyone, and while the shard has under HARBOUR_BOAT_CAP boats). Returns how many were put out. */
  harbourBoats(): number {
    const slots = this.info.hub.harbour?.slots ?? [];
    let n = 0;
    for (const s of slots) {
      if (this.boats.boats.size >= HARBOUR_BOAT_CAP) break;
      if (this.boats.near(s.x, s.z, 2.5) > 0) continue;
      let near = false;
      for (const p of this.players.values()) if ((p.x - s.x) ** 2 + (p.z - s.z) ** 2 < 16 * 16) near = true;
      if (near) continue;
      const bx = Math.floor(s.x);
      const bz = Math.floor(s.z);
      if (!IS_WATER[this.getBlock(bx, s.y, bz)]) continue;
      const y = waterSurface(this.getBlock, bx, s.y, bz) - 0.225;
      if (!this.boats.canPlace(s.x, y, s.z)) continue;
      if (this.boats.spawn(s.x, y, s.z, s.yaw)) n++;
    }
    return n;
  }

  get name(): string {
    return `Server ${this.n}`;
  }
  get count(): number {
    return this.players.size;
  }
  get full(): boolean {
    return this.players.size >= PLAYER_CAP;
  }

  getBlock = (x: number, y: number, z: number): number => {
    if (x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE || y < 0 || y >= WORLD_HEIGHT) return B.AIR;
    return this.world[idx(x, y, z)];
  };

  /** World time in ticks, from the wall clock (plus any skipped nights) so every restart agrees. */
  worldTime(): number {
    if (this.timeOffset) return Math.floor(this.timeOffset) % DAY_TICKS;
    return ((Math.floor(Date.now() / 50 + 6000 + this.timeShift) % DAY_TICKS) + DAY_TICKS) % DAY_TICKS;
  }
  timeOffset = 0;

  /** Everyone slept: jump the clock to the morning (time 0) and tell the clients. */
  skipToMorning(): void {
    if (this.timeOffset) this.timeOffset = DAY_TICKS;
    else {
      const t = this.worldTime();
      this.timeShift += (DAY_TICKS - t) % DAY_TICKS;
      try {
        writeFileSync(join(this.store.dir, "time.json"), JSON.stringify({ shift: this.timeShift }));
      } catch {
        /* the next night just isn't skipped across a restart */
      }
    }
    this.broadcast({ t: "time", time: this.worldTime(), tick: this.tickCount });
  }

  /** Creative players are admins (or dev tests): they may build in the safe zone. */
  adminBuild(p: Player): boolean {
    return p.sv.gm === "creative";
  }

  info_(): ShardInfo {
    return { n: this.n, players: this.players.size, cap: PLAYER_CAP };
  }

  // ---------------------------------------------------------------- sending

  send(p: Player, msg: S2C): void {
    if (p.agent && (msg.t === "hurt" || msg.t === "dead")) this.toFollowers(p, msg);
    if (p.ws.readyState !== 1) return;
    if (p.ws.bufferedAmount > 8 * 1024 * 1024) {
      this.hooks.kick(p, "Connection too slow");
      return;
    }
    p.ws.send(JSON.stringify(msg));
  }

  sendBin(p: Player, data: Uint8Array | Buffer): void {
    if (p.ws.readyState !== 1) return;
    if (p.ws.bufferedAmount > 8 * 1024 * 1024) {
      this.hooks.kick(p, "Connection too slow");
      return;
    }
    p.ws.send(data, { binary: true });
  }

  broadcast(msg: S2C, except?: Player): void {
    const s = JSON.stringify(msg);
    for (const p of this.viewers()) if (p !== except && p.ws.readyState === 1) p.ws.send(s);
  }

  notice(p: Player, text: string): void {
    this.send(p, { t: "notice", text });
  }

  system(text: string): void {
    this.broadcast({ t: "chat", from: null, text, kind: "system" });
  }

  // ---------------------------------------------------------------- join / leave

  private playerInfo(p: Player): PlayerInfo {
    return { id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, skin: p.skin, held: p.held, armor: p.armor };
  }

  private editsMessage(): Buffer {
    if (this.editsBlob && this.editsBlob.version === this.editsVersion) return this.editsBlob.buf;
    const raw = Buffer.alloc(this.edits.size * BLOCK_ENTRY);
    let o = 0;
    for (const [i, id] of this.edits) {
      writeBlockEntry(raw, o, cellX(i), cellY(i), cellZ(i), id);
      o += BLOCK_ENTRY;
    }
    const z = deflateRawSync(raw, { level: 6 });
    const buf = Buffer.alloc(5 + z.length);
    buf[0] = OP.EDITS;
    buf.writeUInt32LE(this.edits.size, 1);
    z.copy(buf, 5);
    this.editsBlob = { version: this.editsVersion, buf };
    return buf;
  }

  join(ws: WebSocket, id: number, name: string, key: string, ip: string, agent = false): Player {
    const now = Date.now();
    let sx = this.info.spawn.x;
    let sy = this.info.spawn.y;
    let sz = this.info.spawn.z;
    let yaw = 180;
    let pitch = -14; // looking up a little at the monument
    const saved = this.positions.get(key) as (SavedPos & { s?: SurvivalData }) | undefined;
    if (saved && saved.x > 0.5 && saved.x < WORLD_SIZE - 0.5 && saved.z > 0.5 && saved.z < WORLD_SIZE - 0.5 && saved.y > 1) {
      if (!playerInsideSolid(this.getBlock, saved.x, saved.y, saved.z, 0.05)) {
        sx = saved.x;
        sy = saved.y;
        sz = saved.z;
        yaw = saved.yaw;
        pitch = saved.pitch;
      } else if (agent) {
        // clankersmp: its saved spot is taken (asleep in a bed when the server restarted, a block put where it
        // stood): the nearest free spot right beside it. Sent off across the island instead, an AI asleep in its
        // house woke up on a hilltop 120 blocks away and fell to its death on the walk home.
        const near = this.freeSpotNear(saved.x, saved.y, saved.z);
        if (near) {
          [sx, sy, sz] = near;
          yaw = saved.yaw;
          pitch = 0;
        }
      }
    }
    if (agent && sx === this.info.spawn.x && sy === this.info.spawn.y && sz === this.info.spawn.z) {
      // new, or its saved spot is blocked now: out in the wild, never on the monument
      const at = this.agentSpawn(name);
      sx = at.x;
      sy = at.y;
      sz = at.z;
      yaw = at.yaw;
      pitch = 0;
    }
    let h = 0;
    for (const c of key) h = (h * 31 + c.charCodeAt(0)) | 0;
    const p: Player = {
      id, name, key, ip, ws,
      skin: AGENT_SKINS[name] ?? Math.abs(h) % SKINS,
      x: sx, y: sy, z: sz, yaw, pitch, flags: 0, held: 0,
      version: 0, sent: new Map(), lastMoveAt: now,
      vx: sx, vy: sy, vz: sz, pendingTp: null, dig: null, delayedDig: null,
      place: new Bucket(10, 6),
      brk: new Bucket(15, 10),
      chat: new Bucket(5, 1),
      cmds: new Bucket(10, 10),
      slowNoticeAt: 0,
      moves: new Bucket(40, 25),
      msgs: new Bucket(150, 60),
      violations: 0, violationWindow: now,
      lastChat: "", lastChatAt: 0, joinedAt: now,
      groundedAt: now, groundedY: sy, lastResync: 0,
      seenAnimals: new Map(), hits: new Bucket(8, 5),
      sv: newSurvival(), sflags: 0, hurtFlagUntil: 0, seenItems: new Map(),
      armor: 0, seenMobs: new Map(),
      riding: 0, boatMoves: new Bucket(40, 25), seenBoats: new Map(), seenVillagers: new Map(), voice: newVoiceState(),
    };
    if (agent) {
      p.agent = true;
      p.moves = new Bucket(60, 45); // an AI's body sends its moves every tick (20 a second: a smooth camera for its spectators)
    }
    if (process.env.GAMEMODE === "creative") p.sv.gm = "creative";
    this.survival.init(p, saved?.s);
    if (process.env.GAMEMODE === "creative") p.sv.gm = "creative";
    sx = p.x;
    sy = p.y;
    sz = p.z;
    p.held = this.survival.heldId(p);
    p.armor = packArmor(p.sv.inv.armor);
    this.players.set(id, p);
    const counts = this.hooks.counts();
    this.send(p, {
      t: "welcome",
      g: PROTOCOL_NAME,
      v: PROTOCOL_VERSION,
      id,
      name,
      token: "",
      shard: this.info_(),
      shards: counts,
      seed: this.seed,
      genHash: this.genHash,
      time: this.worldTime(),
      tick: this.tickCount,
      spawn: this.info.spawn,
      you: { x: sx, y: sy, z: sz, yaw, pitch },
      players: [...this.players.values()].filter((q) => q !== p).map((q) => this.playerInfo(q)),
      spawnRadius: this.zone.off ? 0 : this.zone.radius,
      hub: this.hubPlan,
      skin: p.skin,
      gm: p.sv.gm,
      inv: p.sv.inv.inv.map(toWire),
      armor: p.sv.inv.armor.map(toWire),
      sel: p.sv.sel,
      stats: this.survival.stats(p),
      first: p.sv.first,
      rides: this.rides(),
      villages: this.villageSites,
      voice: { on: !this.voice.off, adminMuted: this.voice.isAdminMuted(p) },
    });
    this.sendBin(p, this.editsMessage());
    this.send(p, { t: "charity", c: this.hooks.charity() });
    this.broadcast({ t: "join", p: this.playerInfo(p) }, p);
    this.broadcast({ t: "chat", from: null, text: `${name} joined the game`, kind: "join" }, p);
    this.chatLog(`* ${name} joined (${key.slice(0, 6)} ${ip})`);
    this.hooks.onCountChange();
    return p;
  }

  leave(p: Player): void {
    if (!this.players.has(p.id)) return;
    if (p.riding) this.dismount(p);
    this.survival.leave(p);
    this.players.delete(p.id);
    this.positions.set(p.key, this.savedOf(p));
    for (const q of this.players.values()) q.sent.delete(p.id);
    this.broadcast({ t: "leave", id: p.id, name: p.name });
    this.broadcast({ t: "chat", from: null, text: `${p.name} left the game`, kind: "leave" });
    this.chatLog(`* ${p.name} left`);
    this.hooks.onCountChange();
  }

  /** What is saved for a player: where they are and their survival state. */
  private savedOf(p: Player): SavedPos & { s: SurvivalData } {
    return { x: p.vx, y: p.vy, z: p.vz, yaw: p.yaw, pitch: p.pitch, t: Date.now(), s: this.survival.data(p) };
  }

  // ---------------------------------------------------------------- messages

  onMessage(p: Player, data: Buffer, isBinary: boolean): void {
    // v11: voice frames have their own limits (server/src/voice.ts), not the message flood guard's
    if (isBinary && data.length > 0 && data[0] === OP_VOICE_UP) {
      this.voice.onFrame(p, data, this.players.values());
      return;
    }
    if (!p.msgs.take()) {
      this.violation(p, "message flood");
      return;
    }
    if (isBinary) {
      if (data.length > 0 && data[0] === OP.MOVE) {
        this.onMove(p, decodeMove(new DataView(data.buffer, data.byteOffset, data.byteLength)));
      }
      return;
    }
    let msg: C2S;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      this.violation(p, "bad message");
      return;
    }
    if (!msg || typeof msg !== "object") return;
    switch (msg.t) {
      case "dig":
        this.onDig(p, msg);
        if (p.agent && (msg.a === "start" || msg.a === "abort" || msg.a === "finish") && [msg.x, msg.y, msg.z].every(Number.isInteger))
          this.toFollowers(p, { t: "fdig", id: p.id, a: msg.a, x: msg.x, y: msg.y, z: msg.z });
        break;
      case "wear":
        if (p.agent) this.survival.wearBest(p);
        break;
      case "hold":
        if (p.agent && Number.isInteger(msg.id)) this.survival.hold(p, msg.id);
        break;
      case "smelt":
        if (p.agent && Number.isInteger(msg.id)) this.send(p, { t: "smelting", ...this.survival.smelt(p, msg.id, Math.max(1, Math.min(16, Math.floor(Number(msg.n) || 1)))) });
        break;
      case "aloot":
        if (p.agent) this.send(p, { t: "looted", ...this.survival.agentLoot(p) });
        break;
      case "atrades":
        // v13: job: the nearest villager of that trade, anywhere in a village (64 blocks)
        if (p.agent) this.send(p, { t: "atrades", v: Number.isInteger(msg.job) && (msg.job as number) >= 0 ? this.survival.agentTrades(p, 64, msg.job as number) : this.survival.agentTrades(p) });
        break;
      case "atrade":
        if (p.agent && Number.isInteger(msg.v) && Number.isInteger(msg.o))
          this.send(p, { t: "atraded", ...this.survival.agentTrade(p, msg.v, msg.o, Math.max(1, Math.min(16, Math.floor(Number(msg.n) || 1)))) });
        break;
      case "enchant": {
        // v13: an AI at the enchanting table (a player right-clicks the table instead)
        if (!p.agent) break;
        const slot = Number.isInteger(msg.a) && (msg.a as number) >= 0 && (msg.a as number) < 4 ? (msg.a as number) : -1;
        const r = this.survival.enchant(p, Math.max(0, Math.min(3, Math.floor(Number(msg.l) || 0))), undefined, slot);
        this.send(p, { t: "enchanted", id: r.id, l: r.level, cost: r.cost, why: r.why });
        break;
      }
      case "craft": {
        if (!p.agent || typeof msg.r !== "string") break;
        const n = this.survival.craft(p, msg.r, Math.max(1, Math.min(64, Math.floor(Number(msg.n) || 1))));
        this.send(p, { t: "crafted", r: msg.r.slice(0, 40), n });
        // v14: its watchers see it at the crafting grid
        if (n) this.toFollowers(p, { t: "fcraft", r: msg.r.slice(0, 40), n });
        break;
      }
      case "aswap":
        // v14: an AI sorting its inventory: one stack onto another slot (merged into a stack of the same, else swapped)
        if (p.agent && Number.isInteger(msg.a) && Number.isInteger(msg.b)) this.survival.agentSwap(p, msg.a as number, msg.b as number);
        break;
      case "ainv":
        // v14: an AI with its inventory screen open (sorting it): its watchers see the screen too
        if (p.agent) p.invOpen = msg.open === true;
        break;
      case "place":
        this.onPlace(p, msg);
        break;
      case "use":
        this.onUse(p, msg);
        break;
      case "hit":
        this.onHit(p, msg);
        break;
      case "chat":
        this.onChat(p, msg.text);
        break;
      case "swing":
        this.survival.swung(p);
        if (p.moves.take()) this.broadcastNear(p, { t: "swing", id: p.id }, 64);
        break;
      case "ping":
        if (typeof msg.c === "number" && p.chat.take(0.1)) this.send(p, { t: "pong", c: msg.c, tick: this.tickCount });
        break;
      case "resync":
        this.sendWorld(p);
        break;
      case "sel":
      case "click":
      case "close":
      case "eat":
      case "bow":
      case "drop":
      case "respawn":
      case "wake":
      case "cset":
        this.survival.onMessage(p, msg as unknown as { t: string; [k: string]: unknown });
        break;
      case "milk":
        this.onMilk(p, msg);
        break;
      // v8: boats
      case "boat_place":
        this.onBoatPlace(p, msg);
        break;
      case "mount":
        this.onMount(p, msg);
        break;
      case "dismount":
        if (p.riding) this.dismount(p);
        break;
      case "boat":
        this.onBoatMove(p, msg);
        break;
      // v9: villagers
      case "talk":
        this.onTalk(p, msg);
        break;
      case "voice":
        this.voice.onState(p, msg);
        break;
      case "vmute":
        this.voice.onMutes(p, msg.ids);
        break;
      case "trade":
        this.survival.onMessage(p, msg as unknown as { t: string; [k: string]: unknown });
        break;
    }
  }

  /** v9: right-click on a villager: its trade window (reach checked here, the window in survival). */
  private onTalk(p: Player, m: { id: number }): void {
    if (!Number.isInteger(m.id)) return this.violation(p, "bad talk");
    const v = this.villagers.villagers.get(m.id);
    if (!v || p.sv.dead) return;
    if (!p.place.take()) return;
    const [ex, ey, ez] = this.eye(p);
    if (distToBox(ex, ey, ez, v.x, v.y, v.z, VILLAGER_W, VILLAGER_H) > TALK_REACH_SERVER) return;
    this.survival.openTrade(p, v);
  }

  /** v9: a villager, for survival's trade windows. */
  villager(id: number): Villager | undefined {
    return this.villagers.villagers.get(id);
  }

  // ---------------------------------------------------------------- v8: boats

  /** Who sits where: [player id, boat id, seat]. */
  private rides(): [number, number, number][] {
    const out: [number, number, number][] = [];
    for (const b of this.boats.boats.values()) b.riders.forEach((id, k) => out.push([id, b.id, k]));
    return out;
  }

  /** The boat moved: its riders go with it (the server's copy of where they are), and never count it as a fall. */
  private ridersFollow(b: Boat): void {
    const now = Date.now();
    for (const id of b.riders) {
      const q = this.players.get(id);
      if (!q) continue;
      const s = this.boats.seatOf(b, id);
      q.x = q.vx = s.x;
      q.y = q.vy = s.y;
      q.z = q.vz = s.z;
      q.version++;
      q.sv.fall.reset();
      q.groundedAt = now;
      q.groundedY = s.y;
    }
  }

  /** A boat from the hand onto the water (or the ground) the player looks at. */
  private onBoatPlace(p: Player, m: { x: number; y: number; z: number }): void {
    if (![m.x, m.y, m.z].every(Number.isFinite)) return this.violation(p, "bad boat");
    if (p.sv.dead || p.riding) return;
    if (this.survival.heldId(p) !== I.BOAT) return this.survival.sendInventory(p);
    if (!p.place.take()) return;
    const [ex, ey, ez] = this.eye(p);
    if (Math.hypot(m.x - ex, m.y - ey, m.z - ez) > SERVER_REACH + 0.5) return this.violation(p, "reach");
    if (m.x < 1 || m.z < 1 || m.x > WORLD_SIZE - 1 || m.z > WORLD_SIZE - 1 || m.y < 1 || m.y >= WORLD_HEIGHT - 1) return;
    // on water it floats at its waterline; on the ground it sits on it
    const bx = Math.floor(m.x);
    const bz = Math.floor(m.z);
    const cy = Math.floor(m.y - 0.01);
    let y = m.y;
    if (IS_WATER[this.getBlock(bx, cy, bz)]) y = waterSurface(this.getBlock, bx, cy, bz) - 0.225;
    else if (!SOLID[this.getBlock(bx, cy, bz)]) return this.notice(p, "Put the boat on water (or on the ground).");
    if (!this.boats.canPlace(m.x, y, m.z)) return this.notice(p, "There's no room for a boat there.");
    if (this.boats.near(m.x, m.z, 10) >= BOATS_NEAR_CAP) return this.notice(p, "There are a lot of boats here already.");
    const b = this.boats.spawn(m.x, y, m.z, p.yaw);
    if (!b) return this.notice(p, "There are a lot of boats on this server already.");
    this.survival.consumePlaced(p);
    this.broadcastNearPoint(m.x, m.z, { t: "fx", k: "boat_place", x: +m.x.toFixed(2), y: +(y + 0.3).toFixed(2), z: +m.z.toFixed(2) }, 32);
  }

  /** Right-click on a boat: sit in it (two seats; the first rider rows). */
  private onMount(p: Player, m: { id: number }): void {
    if (!Number.isInteger(m.id)) return this.violation(p, "bad mount");
    const b = this.boats.boats.get(m.id);
    if (!b || p.sv.dead || p.sv.sleeping || p.riding) return;
    if (!p.place.take()) return;
    const [ex, ey, ez] = this.eye(p);
    if (distToBox(ex, ey, ez, b.x, b.y, b.z, BOAT_W, BOAT_H) > ANIMAL_REACH + 0.25) return this.violation(p, "reach");
    if (b.riders.length >= MAX_RIDERS) return this.notice(p, "This boat is full.");
    b.riders.push(p.id);
    p.riding = b.id;
    if (b.riders.length === 1) b.driverAt = 0; // the server keeps it until they row
    this.ridersFollow(b);
    this.broadcast({ t: "ride", p: p.id, b: b.id, s: b.riders.length - 1 });
  }

  /** Out of the boat (sneak, death, leaving, a teleport): beside it, on the ground if there is room. */
  dismount(p: Player): void {
    const b = this.boats.boats.get(p.riding);
    p.riding = 0;
    this.broadcast({ t: "ride", p: p.id, b: 0, s: 0 });
    if (!b) return;
    b.riders = b.riders.filter((id) => id !== p.id);
    // the one left in the boat moves to the front seat and rows
    b.riders.forEach((id, k) => this.broadcast({ t: "ride", p: id, b: b.id, s: k }));
    if (b.riders.length) b.driverAt = 0;
    this.ridersFollow(b);
    const at = this.boats.exitSpot(b, (x, y, z) => !playerInsideSolid(this.getBlock, x, y, z, 0.05));
    this.teleport(p, at.x, at.y, at.z);
  }

  /** The driver's boat: accepted if it moved like a boat can (speed, room, on water or ground), else put back. */
  private onBoatMove(p: Player, m: { id: number; x: number; y: number; z: number; yaw: number; r: number }): void {
    if (![m.x, m.y, m.z, m.yaw].every(Number.isFinite) || !Number.isInteger(m.id)) return this.violation(p, "bad boat move");
    const b = this.boats.boats.get(m.id);
    if (!b || p.riding !== b.id || b.riders[0] !== p.id) return;
    if (!p.boatMoves.take()) return;
    const now = Date.now();
    const horiz = Math.hypot(m.x - b.x, m.z - b.z);
    const dy = m.y - b.y;
    // packets the driver sent before our correction reached them are stale: drop them quietly
    if (now - b.correctedAt < 600 && (horiz > 1 || Math.abs(dy) > 0.6)) return;
    const dt = b.driverAt ? Math.min(2, Math.max(0.05, (now - b.driverAt) / 1000)) : 0.1;
    const out = m.x < 0.6 || m.z < 0.6 || m.x > WORLD_SIZE - 0.6 || m.z > WORLD_SIZE - 0.6 || m.y < 0 || m.y > WORLD_HEIGHT;
    if (out || horiz > 12 * dt + 1.2 || dy > 1 + 4 * dt || !boatFits(this.getBlock, m.x, m.y, m.z)) return this.correctBoat(p, b, "boat moved too quickly");
    this.boats.driverMoved(b, m.x, m.y, m.z, m.yaw, Number(m.r) | 0);
    if (this.boats.supported(b)) {
      b.unsupportedSince = 0;
      b.last = { x: b.x, y: b.y, z: b.z, yaw: b.yaw };
    } else if (!b.unsupportedSince) b.unsupportedSince = now;
  }

  private correctBoat(p: Player, b: Boat, why: string): void {
    this.violation(p, why);
    const at = this.boats.supported(b) ? { x: b.x, y: b.y, z: b.z, yaw: b.yaw } : b.last;
    b.unsupportedSince = 0;
    b.correctedAt = Date.now();
    this.boats.setPos(b, at.x, at.y, at.z, at.yaw);
    this.send(p, { t: "boat_tp", id: b.id, x: b.x, y: b.y, z: b.z, yaw: b.yaw });
  }

  /** No hovering boats either: a driven boat that stays off water and ground for 3 s is put back. */
  private checkBoatHover(): void {
    const now = Date.now();
    for (const b of this.boats.boats.values()) {
      if (!b.unsupportedSince || !b.riders.length) continue;
      if (this.boats.supported(b)) {
        b.unsupportedSince = 0;
        continue;
      }
      if (now - b.unsupportedSince > 3000) {
        const p = this.players.get(b.riders[0]);
        if (p) this.correctBoat(p, b, "hovering boat");
        b.driverAt = 0;
      }
    }
  }

  /** Hits on a boat add up (and fade a little each tick); enough breaks it into a boat item. Not in the safe zone,
   *  and not the boat you sit in. */
  private hitBoat(p: Player, b: Boat): void {
    if (b.riders.includes(p.id)) return;
    if (p.sv.gm !== "creative" && this.survival.inSafe(b.x, b.z)) return this.notice(p, "Spawn is a safe zone: boats here stay put.");
    const t = itemDef(this.survival.heldId(p))?.tool;
    b.dmg += p.sv.gm === "creative" ? 100 : 10 * Math.max(1, t?.damage ?? 1);
    b.hurtUntil = this.tickCount + 10;
    b.flags |= BF.HURT;
    b.version++;
    if (b.dmg <= BOAT_BREAK) return;
    for (const id of [...b.riders]) {
      const q = this.players.get(id);
      if (q) this.dismount(q);
    }
    this.boats.remove(b.id);
    if (p.sv.gm !== "creative") this.items.spawn({ id: I.BOAT, n: 1, d: 0 }, b.x, b.y + 0.3, b.z, 0, 0.15, 0);
    this.broadcastNearPoint(b.x, b.z, { t: "fx", k: "boat_break", x: +b.x.toFixed(2), y: +(b.y + 0.3).toFixed(2), z: +b.z.toFixed(2) }, 32);
  }

  /** The islands' treasure chests and (v9) the villages' loot chests: each filled the first time it exists. */
  private fillLoot(): void {
    // v9: and the loot chests in the villages' houses (the farmer's and the smith's)
    const chests = [...this.info.islands.chests, ...this.info.villages.chests.map((c) => ({ x: c.x, y: c.y, z: c.z, island: `village_${c.kind}` }))];
    const n = this.loot.fill(chests, (c) => (isStorage(this.world[idx(c.x, c.y, c.z)]) ? this.containers.chest(idx(c.x, c.y, c.z)) : null));
    if (n) {
      this.containers.save();
      log(`shard ${this.n}: filled ${n} treasure chest${n === 1 ? "" : "s"}`);
    }
  }

  /** v7: right-click on a cow with an empty bucket (reach and rate checked here, the rest in survival). */
  private onMilk(p: Player, m: { id: number }): void {
    if (!Number.isInteger(m.id)) return this.violation(p, "bad milk");
    const a = this.animals.animals.get(m.id);
    if (!a) return;
    if (!p.place.take()) return;
    const [ex, ey, ez] = this.eye(p);
    if (distToBox(ex, ey, ez, a.x, a.y, a.z, a.hw * 2, a.h) > ANIMAL_REACH + 0.25) return this.violation(p, "reach");
    this.survival.milkCow(p, a);
  }

  /** Everyone within `radius` blocks (horizontally) of a point. */
  broadcastNearPoint(x: number, z: number, msg: S2C, radius: number): void {
    const s = JSON.stringify(msg);
    for (const q of this.viewers()) {
      if (q.ws.readyState !== 1) continue;
      if ((q.x - x) ** 2 + (q.z - z) ** 2 <= radius * radius) q.ws.send(s);
    }
  }

  broadcastNear(from: Player, msg: S2C, radius: number, includeSelf = false): void {
    const s = JSON.stringify(msg);
    for (const q of this.viewers()) {
      if ((q === from && !includeSelf) || q.ws.readyState !== 1) continue;
      const dx = q.x - from.x;
      const dz = q.z - from.z;
      if (dx * dx + dz * dz <= radius * radius) q.ws.send(s);
    }
  }

  violation(p: Player, why: string): void {
    const now = Date.now();
    if (now - p.violationWindow > 10000) {
      p.violationWindow = now;
      p.violations = 0;
    }
    p.violations++;
    if (p.violations > 40 && !p.agent) {
      // (an AI is our own process: its moves are still corrected, it is never kicked for them)
      log(`shard ${this.n}: kicking ${p.name} (${why})`);
      this.hooks.kick(p, why === "moved too quickly" ? "Moved too quickly" : "Too many invalid actions");
    }
  }

  private correct(p: Player, why: string): void {
    this.violation(p, why);
    // sent back over and over to a spot that is itself no good (a block went in beside it: opus was snapped back
    // to the same water channel in a farm hundreds of times): put it on the nearest free ground instead
    if (why === "inside block") {
      const now = Date.now();
      if (!p.insideAt || now - p.insideAt > 15000) {
        p.insideAt = now;
        p.insideN = 0;
      }
      p.insideN = (p.insideN ?? 0) + 1;
      if (p.insideN >= 10) {
        const spot = this.freeSpotNear(p.vx, p.vy, p.vz);
        if (spot) {
          log(`shard ${this.n}: ${p.name} stuck in a snapback loop at ${p.vx.toFixed(2)} ${p.vy.toFixed(2)} ${p.vz.toFixed(2)}: moved to ${spot.join(" ")}`);
          [p.vx, p.vy, p.vz] = spot;
        }
        p.insideN = 0;
        p.insideAt = now;
      }
    }
    if (p.agent && Date.now() - (p.corrLogAt ?? 0) > 3000) {
      // an AI's moves being refused is a bug in its body: say why, where
      p.corrLogAt = Date.now();
      log(`shard ${this.n}: ${p.name} corrected (${why}) at ${p.vx.toFixed(2)} ${p.vy.toFixed(2)} ${p.vz.toFixed(2)}`);
    }
    p.sv.fall.reset(); // a snapback never counts as a fall
    p.pendingTp = { x: p.vx, y: p.vy, z: p.vz, until: Date.now() + 1500 };
    this.send(p, { t: "tp", x: p.vx, y: p.vy, z: p.vz });
  }

  teleport(p: Player, x: number, y: number, z: number): void {
    if (p.riding) {
      // v8: a teleport (respawn, /spawn) takes you out of your boat first
      const b = this.boats.boats.get(p.riding);
      p.riding = 0;
      this.broadcast({ t: "ride", p: p.id, b: 0, s: 0 });
      if (b) {
        b.riders = b.riders.filter((id) => id !== p.id);
        b.riders.forEach((id, k) => this.broadcast({ t: "ride", p: id, b: b.id, s: k }));
        this.ridersFollow(b);
      }
    }
    p.sv.fall.reset(); // nor does a teleport (respawn, the hub, the hover check)
    p.vx = p.x = x;
    p.vy = p.y = y;
    p.vz = p.z = z;
    p.version++;
    p.groundedAt = Date.now();
    p.groundedY = y;
    p.pendingTp = { x, y, z, until: Date.now() + 1500 };
    this.send(p, { t: "tp", x, y, z });
  }

  private onMove(p: Player, m: MoveMsg | null): void {
    if (!m) return this.violation(p, "bad move");
    if (!p.moves.take()) return;
    if (p.sv.dead) return; // on the death screen: nothing moves until they respawn
    if (m.held >= 0 && m.held <= 8 && m.held !== p.sv.sel) this.survival.onMessage(p, { t: "sel", s: m.held });
    const now = Date.now();
    if (p.riding) {
      // v8: in a boat the boat decides where you are (ridersFollow); a move only says where you look
      p.yaw = m.yaw;
      p.pitch = Math.max(-90, Math.min(90, m.pitch));
      p.flags = m.flags & (FLAG.GROUND | FLAG.EAT);
      p.lastMoveAt = now;
      p.version++;
      return;
    }
    if (p.pendingTp) {
      const dx = m.x - p.pendingTp.x;
      const dy = m.y - p.pendingTp.y;
      const dz = m.z - p.pendingTp.z;
      if (dx * dx + dy * dy + dz * dz > 2.25) {
        if (now > p.pendingTp.until) this.correct(p, "ignored teleport");
        return;
      }
      p.pendingTp = null;
      p.lastMoveAt = now;
    }
    if (m.x < 0.29 || m.x > WORLD_SIZE - 0.29 || m.z < 0.29 || m.z > WORLD_SIZE - 0.29 || m.y < 0 || m.y > 320) {
      return this.correct(p, "out of bounds");
    }
    const dt = Math.min(2, Math.max(0.05, (now - p.lastMoveAt) / 1000));
    const dx = m.x - p.vx;
    const dz = m.z - p.vz;
    const dy = m.y - p.vy;
    const horiz = Math.sqrt(dx * dx + dz * dz);
    // Sprint-jumping tops out near 7 m/s; allow 11 m/s plus slack for jitter.
    if (horiz > 11 * dt + 1.2 || dy > 1.4 + 9 * dt) return this.correct(p, "moved too quickly");
    // Crouched players are 1.5 tall (they can sneak under 1.5-high gaps).
    if (playerInsideSolid(this.getBlock, m.x, m.y, m.z, 0.2, m.flags & FLAG.SNEAK ? CROUCH_HEIGHT : PLAYER_HEIGHT)) return this.correct(p, "inside block");
    const px = p.vx;
    const py = p.vy;
    const pz = p.vz;
    if (p.sv.sleeping && Math.hypot(m.x - px, m.z - pz) < 0.3) {
      // lying in bed: the client may still report tiny moves; keep them in the bed
      p.yaw = m.yaw;
      p.pitch = Math.max(-90, Math.min(90, m.pitch));
      p.lastMoveAt = now;
      return;
    }
    p.x = p.vx = m.x;
    p.y = p.vy = m.y;
    p.z = p.vz = m.z;
    p.yaw = m.yaw;
    p.pitch = Math.max(-90, Math.min(90, m.pitch));
    p.flags = m.flags & (FLAG.SNEAK | FLAG.SPRINT | FLAG.GROUND | FLAG.WATER | FLAG.EAT);
    p.lastMoveAt = now;
    p.version++;
    this.survival.onMoved(p, px, py, pz);
    // Client flags are untrusted; "grounded" is judged from the server's own blocks.
    if (this.supported(p)) {
      p.groundedAt = now;
      p.groundedY = m.y;
    }
  }

  /** Is there something under (or around) the player that could hold them up? */
  private supported(p: Player): boolean {
    const x0 = Math.floor(p.x - 0.3);
    const x1 = Math.floor(p.x + 0.3);
    const z0 = Math.floor(p.z - 0.3);
    const z1 = Math.floor(p.z + 0.3);
    const y0 = Math.floor(p.y - 0.6);
    const y1 = Math.floor(p.y + 1.8);
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++)
        for (let y = y0; y <= y1; y++) {
          const id = this.getBlock(x, y, z);
          if (SOLID[id] || IS_WATER[id]) return true;
        }
    return false;
  }

  /** Hover check: nobody can stay in the air for 4 s without falling (there is no flying). */
  private checkHover(): void {
    const now = Date.now();
    for (const p of this.players.values()) {
      if (p.pendingTp || p.riding) continue; // v8: a boat holds its riders up
      // Idle players (or background tabs) send no moves; judge them from where they stand now.
      if (this.supported(p)) {
        p.groundedAt = now;
        p.groundedY = p.y;
        continue;
      }
      if (now - p.groundedAt > 4000 && p.y >= p.groundedY - 1) {
        let y = Math.floor(p.y);
        while (y > 0 && !SOLID[this.getBlock(Math.floor(p.x), y - 1, Math.floor(p.z))]) y--;
        log(`shard ${this.n}: ${p.name} hovering, dropping to ground`);
        this.violation(p, "hovering");
        this.teleport(p, p.x, y, p.z);
      }
    }
  }

  private eye(p: Player): [number, number, number] {
    return [p.x, p.y + (p.flags & FLAG.SNEAK ? SNEAK_EYE_HEIGHT : EYE_HEIGHT), p.z];
  }

  inReach(p: Player, x: number, y: number, z: number): boolean {
    const [ex, ey, ez] = this.eye(p);
    const cx = Math.max(x, Math.min(x + 1, ex));
    const cy = Math.max(y, Math.min(y + 1, ey));
    const cz = Math.max(z, Math.min(z + 1, ez));
    const dx = ex - cx;
    const dy = ey - cy;
    const dz = ez - cz;
    return dx * dx + dy * dy + dz * dz <= (SERVER_REACH + 0.25) * (SERVER_REACH + 0.25);
  }

  /** No building in the spawn safe zone (creative admins excepted). */
  private protectedFor(p: Player, x: number, z: number): boolean {
    if (this.survival.canEdit(p, x, z)) return false;
    this.notice(p, "Spawn is a safe zone: no building here. Head out past the gate!");
    return true;
  }

  private revert(p: Player, x: number, y: number, z: number): void {
    if (!inWorld(x, y, z)) return;
    this.sendBin(p, encodeBlocks(OP.BLOCKS, [{ x, y, z, id: this.world[idx(x, y, z)] }]));
  }

  private onPlace(p: Player, m: { x: number; y: number; z: number; id: number }): void {
    const { x, y, z, id } = m;
    if (![x, y, z, id].every(Number.isInteger) || !inWorld(x, y, z)) return this.violation(p, "bad place");
    // The client predicted these cells; any rejection sends their true contents back.
    const touched = isValidBlockId(id) ? placementCells(id, x, y, z) : [[x, y, z, id]];
    const revertAll = () => {
      for (const [cx, cy, cz] of touched) this.revert(p, cx, cy, cz);
    };
    if (!isValidBlockId(id) || !BLOCKS[id].clientPlace) return revertAll();
    if (!p.place.take()) {
      this.violation(p, "place rate");
      return revertAll();
    }
    if (!this.inReach(p, x, y, z)) {
      this.violation(p, "reach");
      return revertAll();
    }
    if (!this.survival.takeForPlace(p, id)) {
      this.survival.sendInventory(p);
      return revertAll();
    }
    // v13: lava poured from the smith's bucket sets into obsidian, so it needs water beside it (or in the spot)
    const lava = id === B.OBSIDIAN && this.survival.heldId(p) === I.LAVA_BUCKET;
    if (lava && !waterBeside(this.getBlock, x, y, z)) {
      this.notice(p, "Lava needs water beside it to set into obsidian: pour it next to water.");
      this.survival.sendInventory(p);
      return revertAll();
    }
    const changes = placeChanges(id, x, y, z, this.getBlock);
    if (!changes) return revertAll();
    for (const [cx, , cz] of changes) if (this.protectedFor(p, cx, cz)) return revertAll();
    for (const [cx, cy, cz, cid] of changes) if (SOLID[cid] && this.boats.blocksCell(cx, cy, cz)) return revertAll();
    const merged = changes[0][3] !== id; // a slab completed into a full block
    if (!merged && !this.hasNeighbor(x, y, z)) return revertAll();
    for (const [cx, cy, cz, cid] of changes) {
      if (!SOLID[cid]) continue;
      for (const q of this.players.values()) {
        if (shapeIntersectsPlayer(cid, cx, cy, cz, q.x, q.y, q.z, this.getBlock, 0.05, q.flags & FLAG.SNEAK ? CROUCH_HEIGHT : PLAYER_HEIGHT)) return revertAll();
      }
      if (this.animals.blocksCell(cx, cy, cz) || this.mobs.blocksCell(cx, cy, cz) || this.villagers.blocksCell(cx, cy, cz)) return revertAll();
    }
    for (const [cx, cy, cz, cid] of changes) this.setBlock(idx(cx, cy, cz), cid, p);
    // v8: a full block on a dirt path presses it back into dirt
    for (const [cx, cy, cz, cid] of changes) if (pathBreaksUnder(cid) && this.getBlock(cx, cy - 1, cz) === B.DIRT_PATH) this.setBlock(idx(cx, cy - 1, cz), B.DIRT, p);
    this.survival.consumePlaced(p);
    if (id === B.WATER) this.broadcastNear(p, { t: "fx", k: "bucket_empty", x: x + 0.5, y: y + 0.5, z: z + 0.5 }, 24);
    if (lava) this.broadcastNearPoint(x + 0.5, z + 0.5, { t: "fx", k: "hiss", x: x + 0.5, y: y + 0.9, z: z + 0.5 }, 32);
  }

  /** Right-click on a block: doors open and close (anywhere), crafting tables, furnaces and chests open, beds are
   *  slept in. */
  private onUse(p: Player, m: { x: number; y: number; z: number }): void {
    const { x, y, z } = m;
    if (![x, y, z].every(Number.isInteger) || !inWorld(x, y, z)) return this.violation(p, "bad use");
    if (!p.place.take()) return this.revert(p, x, y, z);
    if (!this.inReach(p, x, y, z)) {
      this.violation(p, "reach");
      return this.revert(p, x, y, z);
    }
    // v8: doors, fence gates and trapdoors open and close (anywhere, the hub too)
    if (!isOpenable(this.getBlock(x, y, z))) {
      if (!this.survival.useBlock(p, x, y, z)) this.revert(p, x, y, z);
      return;
    }
    const changes = toggleOpenable(x, y, z, p.yaw, this.getBlock);
    if (!changes) return this.revert(p, x, y, z);
    for (const [cx, cy, cz, cid] of changes) this.setBlock(idx(cx, cy, cz), cid, p);
  }

  /** Left-click on an animal (or, v6, a night mob): reach and rate checked, then the hit lands. */
  private onHit(p: Player, m: { id: number; mob?: boolean; boat?: boolean; villager?: boolean; player?: boolean }): void {
    if (!Number.isInteger(m.id)) return this.violation(p, "bad hit");
    if (m.player) {
      // clankersmp: the AIs can hit each other (nothing stops them); nobody else is in the world
      const q = this.players.get(m.id);
      if (!q || q === p || !p.agent || !q.agent) return;
      if (!p.hits.take()) return this.violation(p, "hit rate");
      const [ex, ey, ez] = this.eye(p);
      if (distToBox(ex, ey, ez, q.x, q.y, q.z, 0.6, PLAYER_HEIGHT) > ANIMAL_REACH + 0.25) return this.violation(p, "reach");
      if (p.sv.dead || q.sv.dead) return;
      return this.survival.hitPlayer(p, q);
    }
    if (m.villager) {
      const v = this.villagers.villagers.get(m.id);
      if (!v) return;
      if (!p.hits.take()) return this.violation(p, "hit rate");
      const [ex, ey, ez] = this.eye(p);
      if (distToBox(ex, ey, ez, v.x, v.y, v.z, VILLAGER_W, VILLAGER_H) > ANIMAL_REACH + 0.25) return this.violation(p, "reach");
      if (p.sv.dead) return;
      this.survival.swung(p);
      this.villagers.poke(v, p.x, p.z);
      return;
    }
    if (m.boat) {
      const b = this.boats.boats.get(m.id);
      if (!b) return;
      if (!p.hits.take()) return this.violation(p, "hit rate");
      const [ex, ey, ez] = this.eye(p);
      if (distToBox(ex, ey, ez, b.x, b.y, b.z, BOAT_W, BOAT_H) > ANIMAL_REACH + 0.25) return this.violation(p, "reach");
      if (p.sv.dead) return;
      return this.hitBoat(p, b);
    }
    if (m.mob) {
      const mob = this.mobs.mobs.get(m.id);
      if (!mob) return;
      if (!p.hits.take()) return this.violation(p, "hit rate");
      const [ex, ey, ez] = this.eye(p);
      if (distToBox(ex, ey, ez, mob.x, mob.y, mob.z, mob.hw * 2, mob.h) > ANIMAL_REACH + 0.25) return this.violation(p, "reach");
      if (p.sv.dead) return;
      return this.survival.hitMob(p, mob);
    }
    const a = this.animals.animals.get(m.id);
    if (!a) return;
    if (!p.hits.take()) return this.violation(p, "hit rate");
    const [ex, ey, ez] = this.eye(p);
    if (distToBox(ex, ey, ez, a.x, a.y, a.z, a.hw * 2, a.h) > ANIMAL_REACH + 0.25) return this.violation(p, "reach");
    if (p.sv.dead) return;
    this.survival.hitAnimal(p, a);
  }

  private hasNeighbor(x: number, y: number, z: number): boolean {
    const n = [
      [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
    ];
    for (const [dx, dy, dz] of n) {
      const id = this.getBlock(x + dx, y + dy, z + dz);
      if (id !== B.AIR && !IS_WATER[id]) return true;
    }
    return false;
  }

  private onDig(p: Player, m: { a: string; x: number; y: number; z: number }): void {
    const { x, y, z } = m;
    if (![x, y, z].every(Number.isInteger) || !inWorld(x, y, z)) return this.violation(p, "bad dig");
    if (m.a === "start") {
      p.dig = { x, y, z, at: Date.now() };
      return;
    }
    if (m.a === "abort") {
      p.dig = null;
      return;
    }
    if (m.a !== "finish") return;
    const i = idx(x, y, z);
    const cur = this.world[i];
    if (p.sv.dead) return this.revert(p, x, y, z);
    const bt = this.survival.breakTicksFor(p, cur);
    if (cur === B.AIR || IS_WATER[cur] || bt < 0) return this.revert(p, x, y, z);
    if (!p.brk.take()) {
      this.violation(p, "break rate");
      return this.revert(p, x, y, z);
    }
    if (this.protectedFor(p, x, z)) return this.revert(p, x, y, z);
    if (!this.inReach(p, x, y, z)) {
      this.violation(p, "reach");
      return this.revert(p, x, y, z);
    }
    if (bt > 0) {
      const d = p.dig;
      // wall-clock time: at least 70% of the dig time (minus a tick of slack for the network)
      const need = bt * 50 * 0.7 - 100;
      const took = d && d.x === x && d.y === y && d.z === z ? Date.now() - d.at : -1;
      if (took < need) {
        // Up to a second short (a lag spike delivered the start late): Java's delayed destroy. The block breaks
        // when the FULL dig time has passed since the server saw the start, so it is never faster than honest play.
        if (d && took >= 0 && took >= need - 1000 && !p.delayedDig) {
          p.delayedDig = { x, y, z, at: d.at, id: cur };
          p.dig = null;
          return;
        }
        this.violation(p, "dig too fast");
        return this.revert(p, x, y, z);
      }
    }
    p.dig = null;
    this.breakBlock(x, y, z, p);
  }

  /** Finish the delayed digs whose time has come (or drop them: the block changed, the player died or moved away). */
  private tickDelayedDigs(): void {
    for (const p of this.players.values()) {
      const d = p.delayedDig;
      if (!d) continue;
      const cur = this.world[idx(d.x, d.y, d.z)];
      const bt = cur === d.id && !p.sv.dead && this.inReach(p, d.x, d.y, d.z) ? this.survival.breakTicksFor(p, cur) : -1;
      if (bt < 0) {
        p.delayedDig = null;
        if (cur !== B.AIR) this.revert(p, d.x, d.y, d.z);
      } else if (Date.now() - d.at >= bt * 50 - 100) {
        p.delayedDig = null;
        this.breakBlock(d.x, d.y, d.z, p);
      }
    }
  }

  /** Break a block: the other half of a door or bed goes too, and torches, plants, doors and ladders that lost
   *  what held them pop off (shared/shapes.ts). Water next to the hole flows in on its own (water.ts). A player
   *  gets the drops (and tool wear); a furnace or chest spills what it held. */
  breakBlock(x: number, y: number, z: number, by: Player | null): void {
    const changes = breakChanges(x, y, z, this.getBlock);
    const olds = changes.map(([cx, cy, cz]) => this.getBlock(cx, cy, cz));
    for (const [cx, cy, cz, id] of changes) this.setBlock(idx(cx, cy, cz), id, by);
    if (by) this.survival.afterBreak(by, x, y, z, changes, olds);
    else {
      const cell = idx(x, y, z);
      for (const st of this.containers.remove(cell)) this.items.dropAt(st, x, y, z);
      this.survival.closeViewers(cell);
    }
  }

  /** Set one cell. `byWater` marks changes made by the water itself: they are not in the edit log (rollbacks
   *  undo what players did; the water then re-settles on its own) and the water sim schedules its own neighbours.
   *  v7 `growth`: the world's own change (a crop growing, farmland drying out): saved, but not in the edit log. */
  setBlock(i: number, id: number, by: Player | null, byWater = false, growth = false): void {
    const old = this.world[i];
    if (old === id) return;
    this.light?.changed(i, old, id);
    // A furnace lighting up or going out is the server's own change: like water, not in the edit log.
    const system = byWater && isFurnace(old) && isFurnace(id);
    // Water washing away a torch, a flower, a sapling or (v7) a crop leaves it on the ground.
    if (byWater && !system && old !== B.AIR && !IS_WATER[old]) for (const st of blockDrops(old, 0, Math.random)) this.items.dropAt(st, cellX(i), cellY(i), cellZ(i));
    this.world[i] = id;
    if (isSapling(old)) this.saplings.delete(i);
    if (isSapling(id)) this.saplings.add(i);
    this.farm?.changed(i, old, id);
    this.leaves?.changed(i, old, id, !!by);
    if (id === this.base[i]) this.edits.delete(i);
    else this.edits.set(i, id);
    this.editsVersion++;
    this.dirty = true;
    this.pending.push({ x: cellX(i), y: cellY(i), z: cellZ(i), id });
    if (byWater || growth) return;
    this.water.touched(i, this.tickCount);
    const e: EditEntry = { t: Date.now(), i, o: old, n: id, k: by ? by.key : "admin", p: by ? by.name : "admin", ip: by ? by.ip : "" };
    this.log.push(e);
    this.store.queueLog(e);
    if (this.log.length > 1_200_000) this.log.splice(0, 200_000);
  }

  private onChat(p: Player, raw: unknown): void {
    const text = sanitizeChat(raw, CHAT_MAX);
    if (!text) return;
    const now = Date.now();
    if (text.startsWith("/")) {
      // Commands have their own, generous limit (10 a second) and no repeat filter: /spawn twice is fine.
      // Test servers (DEV_COMMANDS=1) run their test-only commands (/tp, /give, ...) without any limit.
      const [cmd] = text.slice(1).split(/\s+/);
      if (process.env.DEV_COMMANDS === "1" && DEV_ONLY.has((cmd ?? "").toLowerCase())) return this.command(p, text);
      if (!p.cmds.take()) return this.slowDown(p, "Slow down: that's a lot of commands at once.");
      return this.command(p, text);
    }
    if (!p.chat.take()) return this.slowDown(p, "Slow down: you can send 5 chat messages every 5 seconds.");
    if (text === p.lastChat && now - p.lastChatAt < 15000) return this.slowDown(p, "You just said that.");
    p.lastChat = text;
    p.lastChatAt = now;
    const clean = filterText(text);
    this.broadcast({ t: "chat", from: p.name, text: clean, kind: "player" });
    this.chatLog(`<${p.name}> ${text}${clean !== text ? "   [filtered]" : ""}`);
  }

  /** A throttled message gets a grey note in chat (at most one a second), never a silent drop. */
  private slowDown(p: Player, text: string): void {
    const now = Date.now();
    if (now - p.slowNoticeAt < 1000) return;
    p.slowNoticeAt = now;
    this.notice(p, text);
  }

  private command(p: Player, text: string): void {
    const [cmd] = text.slice(1).split(/\s+/);
    switch ((cmd ?? "").toLowerCase()) {
      case "help":
        this.notice(p, "Commands: /list, /spawn, /server. Hold left click to break, right click to place or use, E for your inventory, T to chat, V to talk (turn voice chat on in Options).");
        break;
      case "list":
        this.notice(p, `${this.players.size} online: ${[...this.players.values()].map((q) => q.name).join(", ")}`);
        break;
      case "spawn": {
        // Back to the hub, unless you were hurt in the last 10 seconds (no escaping a fall mid-air).
        if (p.sv.dead) break;
        if (this.tickCount - p.sv.hurtUntil < 200 && p.sv.hurtUntil > 0) return this.notice(p, "You can't use /spawn right after taking damage.");
        const s = this.info.spawn;
        p.sv.fall.reset();
        this.teleport(p, s.x, s.y, s.z);
        break;
      }
      case "server":
        this.notice(p, `You are on ${this.name} (${this.players.size}/${PLAYER_CAP}).`);
        break;
      case "tp": {
        // Test-only: DEV_COMMANDS=1 must be set on the server. Never enabled in production.
        if (process.env.DEV_COMMANDS !== "1") return this.notice(p, "Unknown command. Try /help");
        const [, xs, ys, zs] = text.trim().split(/\s+/);
        const x = Number(xs);
        const y = Number(ys);
        const z = Number(zs);
        if (![x, y, z].every(Number.isFinite)) return this.notice(p, "Usage: /tp x y z");
        this.teleport(p, Math.min(WORLD_SIZE - 0.5, Math.max(0.5, x)), Math.max(1, y), Math.min(WORLD_SIZE - 0.5, Math.max(0.5, z)));
        break;
      }
      case "summon": {
        // Test-only: DEV_COMMANDS=1. /summon <pig|cow|sheep|chicken|shambler|rattler|skitter> [count] [distance]
        if (process.env.DEV_COMMANDS !== "1") return this.notice(p, "Unknown command. Try /help");
        const [, what, count, dist] = text.trim().split(/\s+/);
        const n = Math.max(1, Math.min(10, Number(count) || 1));
        const mob = MOB_SPECS.findIndex((s) => s.key === what);
        if (mob >= 0) {
          // in front of the player, `distance` blocks away (default 6)
          const d = Math.max(1, Math.min(30, Number(dist) || 6));
          const yr = (p.yaw * Math.PI) / 180;
          for (let k = 0; k < n; k++) this.mobs.summon(mob, p.x - Math.sin(yr) * d + (Math.random() - 0.5) * 2, p.y + 1, p.z + Math.cos(yr) * d + (Math.random() - 0.5) * 2);
          break;
        }
        const kind = SPECS.findIndex((s) => s.key === what);
        if (kind < 0) return this.notice(p, "Usage: /summon pig|cow|sheep|chicken|shambler|rattler|skitter [count]");
        for (let k = 0; k < n; k++) this.animals.summon(kind, p.x + (Math.random() - 0.5) * 4, p.y, p.z + (Math.random() - 0.5) * 4);
        break;
      }
      case "give": {
        // Test-only: DEV_COMMANDS=1. /give <item key or id> [count]
        if (process.env.DEV_COMMANDS !== "1") return this.notice(p, "Unknown command. Try /help");
        const [, what, count] = text.trim().split(/\s+/);
        const id = Number.isInteger(Number(what)) ? Number(what) : ITEMS.findIndex((d) => d?.key === what);
        const def = itemDef(id);
        if (!def) return this.notice(p, "Usage: /give <item> [count]");
        let n = Math.max(1, Math.min(64 * 36, Number(count) || 1));
        while (n > 0) {
          const k = Math.min(n, def.stack);
          n -= k;
          const left = this.survival.give(p, { id, n: k, d: 0 });
          if (left) this.items.spawn({ id, n: left, d: 0 }, p.x, p.y + 1, p.z);
        }
        break;
      }
      case "grow": {
        // Test-only: DEV_COMMANDS=1. Grows the saplings within 16 blocks now (v7: ripens the crops and fills out the
        // sugar cane too).
        if (process.env.DEV_COMMANDS !== "1") return this.notice(p, "Unknown command. Try /help");
        this.farm.growAll(Math.floor(p.x), Math.floor(p.z), 16);
        for (const i of [...this.saplings]) {
          if (Math.abs(cellX(i) - p.x) > 16 || Math.abs(cellZ(i) - p.z) > 16) continue;
          const ch = treeChanges(this.getBlock, cellX(i), cellY(i), cellZ(i), this.world[i] === B.BIRCH_SAPLING, Math.random);
          if (ch) for (const [cx, cy, cz, cid] of ch) this.setBlock(idx(cx, cy, cz), cid, null);
        }
        break;
      }
      case "gamemode": {
        if (process.env.DEV_COMMANDS !== "1") return this.notice(p, "Unknown command. Try /help");
        const mode = text.trim().split(/\s+/)[1];
        if (mode !== "survival" && mode !== "creative") return this.notice(p, "Usage: /gamemode survival|creative");
        this.survival.setGameMode(p, mode);
        break;
      }
      case "kill": {
        if (process.env.DEV_COMMANDS !== "1") return this.notice(p, "Unknown command. Try /help");
        this.survival.die(p, "void");
        break;
      }
      case "hunger": {
        if (process.env.DEV_COMMANDS !== "1") return this.notice(p, "Unknown command. Try /help");
        const v = Number(text.trim().split(/\s+/)[1]);
        if (!Number.isFinite(v)) return;
        p.sv.body.food = Math.max(0, Math.min(20, Math.round(v)));
        p.sv.body.sat = Math.min(p.sv.body.sat, p.sv.body.food);
        p.sv.statsDirty = true;
        break;
      }
      case "hurt": {
        if (process.env.DEV_COMMANDS !== "1") return this.notice(p, "Unknown command. Try /help");
        const v = Number(text.trim().split(/\s+/)[1]);
        if (Number.isFinite(v) && v > 0) {
          p.sv.body.hp = Math.max(1, p.sv.body.hp - Math.round(v));
          p.sv.statsDirty = true;
        }
        break;
      }
      case "mobs": {
        // Test-only: DEV_COMMANDS=1. /mobs on|off (natural spawning) | clear (remove them all) | freeze (AI on/off)
        if (process.env.DEV_COMMANDS !== "1") return this.notice(p, "Unknown command. Try /help");
        const what = text.trim().split(/\s+/)[1];
        if (what === "on" || what === "off") this.mobs.spawning = what === "on";
        else if (what === "clear") this.mobs.clear();
        else if (what === "freeze") this.mobs.frozen = !this.mobs.frozen;
        else return this.notice(p, "Usage: /mobs on|off|clear|freeze");
        this.notice(p, `Mobs: spawning ${this.mobs.spawning ? "on" : "off"}, ${this.mobs.mobs.size} around`);
        break;
      }
      case "time": {
        if (process.env.DEV_COMMANDS !== "1") return this.notice(p, "Unknown command. Try /help");
        this.timeOffset = Number(text.trim().split(/\s+/)[1]) || 0;
        this.broadcast({ t: "time", time: this.worldTime(), tick: this.tickCount });
        break;
      }
      default:
        this.notice(p, "Unknown command. Try /help");
    }
  }

  /** Recent chat and joins (unfiltered), for the admin API. */
  recentChat: string[] = [];

  private chatLog(line: string): void {
    this.recentChat.push(`${new Date().toISOString()} ${line}`);
    if (this.recentChat.length > 500) this.recentChat.splice(0, this.recentChat.length - 500);
    try {
      appendFileSync(this.chatLogPath, `${new Date().toISOString()} ${line}\n`);
    } catch {
      /* disk issues should not stop the game */
    }
  }

  sendWorld(p: Player): void {
    const now = Date.now();
    if (now - p.lastResync < 30000) return;
    p.lastResync = now;
    const send = (buf: Buffer) => this.sendBin(p, buf);
    if (this.worldBlob && this.worldBlob.version === this.editsVersion) return send(this.worldBlob.buf);
    const version = this.editsVersion;
    deflateRaw(Buffer.from(this.world.buffer, this.world.byteOffset, this.world.byteLength), { level: 6 }, (err, z) => {
      if (err) return;
      const buf = Buffer.alloc(5 + z.length);
      buf[0] = OP.WORLD;
      buf.writeUInt32LE(this.genHash, 1);
      z.copy(buf, 5);
      this.worldBlob = { version, buf };
      send(buf);
    });
  }

  // ---------------------------------------------------------------- tick

  /** Time spent per part of the tick (TICK_STATS=1: logged every 10 s by main.ts). */
  readonly prof = new Map<string, number>();
  private lap(name: string, t0: number): number {
    const t = performance.now();
    if (process.env.TICK_STATS) this.prof.set(name, (this.prof.get(name) ?? 0) + t - t0);
    return t;
  }

  tick(): void {
    this.tickCount++;
    let t = performance.now();
    this.water.tick(this.tickCount);
    t = this.lap("water", t);
    if (this.pending.length) {
      const msg = encodeBlocks(OP.BLOCKS, this.pending);
      this.pending = [];
      for (const p of this.viewers()) this.sendBin(p, msg);
    }
    if (this.specs.size) this.tickSpecs();
    if (this.tickCount % 2 === 0) this.broadcastPlayers();
    t = this.lap("players", t);
    if (this.players.size) {
      const pos = [...this.players.values()];
      this.animals.tick(pos);
      t = this.lap("animals", t);
      if (this.tickCount % 2 === 0) {
        for (const p of this.viewers()) for (const m of this.animals.messages(p, p.seenAnimals, this.tickCount)) this.sendBin(p, m);
        this.animals.flushRemoved();
      }
      if (this.tickCount % 600 === 0) this.animals.respawn(pos);
      t = this.lap("animal-msgs", t);
      // v6 night mobs: AI, arrows, spawning once a second, and the nearby ones to each player
      const time = this.worldTime();
      const targets = this.mobTargets();
      this.mobs.tick(targets, time);
      t = this.lap("mobs", t);
      if (this.tickCount % 20 === 11) this.mobs.spawnTick(targets, time);
      t = this.lap("mob-spawn", t);
      if (this.tickCount % 2 === 0) {
        for (const p of this.viewers()) for (const m of this.mobs.messages(p, p.seenMobs, this.tickCount)) this.sendBin(p, m);
        this.mobs.flushRemoved();
      }
      t = this.lap("mob-msgs", t);
      // v9 villagers: their day, and the nearby ones to each player
      this.villagers.tick(pos, time, this.tickCount);
      if (this.tickCount % 2 === 0) {
        for (const p of this.viewers()) for (const m of this.villagers.messages(p, p.seenVillagers, this.tickCount)) this.sendBin(p, m);
        this.villagers.flushRemoved();
      }
      if (this.tickCount % 200 === 29 && this.villagers.dirty) this.villagers.save();
      t = this.lap("villagers", t);
    }
    // v11: voice: each listener's frames for this tick, the closest voices re-picked, who is talking
    this.voice.tick([...this.players.values()], this.tickCount);
    t = this.lap("voice", t);
    // v8 boats: the ones nobody rows float and drift; everyone near gets what changed
    this.boats.tick([...this.players.values()], this.tickCount);
    if (this.tickCount % 2 === 0) {
      for (const p of this.viewers()) for (const m of this.boats.messages(p, p.seenBoats, this.tickCount)) this.sendBin(p, m);
      this.boats.flushRemoved();
    }
    if (this.tickCount % 20 === 3) this.checkBoatHover();
    if (this.tickCount % 600 === 301) this.harbourBoats(); // v10: an empty harbour slot gets a new boat
    if (this.tickCount % 200 === 17 && this.boats.dirty) this.boats.save(); // boats are kept even through a crash
    t = this.lap("boats", t);
    // dropped items: physics, merging, pickups; then the nearby ones to each player
    const pickers = [...this.players.values()].map((p) => ({ id: p.id, key: p.key, x: p.x, y: p.y, z: p.z, alive: !p.sv.dead, p }));
    this.items.tick(pickers, (pk, st) => this.survival.give((pk as unknown as { p: Player }).p, st), this.tickCount);
    t = this.lap("items", t);
    const pick = this.items.pickupMessage();
    if (this.tickCount % 2 === 0 || pick) {
      for (const p of this.viewers()) {
        if (this.tickCount % 2 === 0) for (const m of this.items.messages(p, p.seenItems, this.tickCount)) this.sendBin(p, m);
      }
    }
    if (pick) for (const p of this.viewers()) this.sendBin(p, pick);
    if (this.tickCount % 2 === 0 || pick) this.items.flush();
    t = this.lap("item-msgs", t);
    this.survival.tick();
    this.tickDelayedDigs();
    t = this.lap("survival", t);
    if (this.tickCount % 20 === 7) this.growSaplings();
    if (this.tickCount % 20 === 17) this.leaves.tick();
    if (this.tickCount % 20 === 13) {
      this.farm.tick();
      t = this.lap("farm", t);
    }
    if (this.tickCount % 200 === 0) this.broadcast({ t: "time", time: this.worldTime(), tick: this.tickCount });
    if (this.tickCount % 20 === 0) this.checkHover();
    if (this.tickCount % 100 === 0 && this.dirty) this.save();
    else if (this.tickCount % 1200 === 0) this.save();
  }

  /** What the night mobs know about each player: where, how tall, and whether they are fair game (survival, alive,
   *  outside the safe zone). */
  private mobTargets(): MobTarget[] {
    const out: MobTarget[] = [];
    for (const p of this.players.values()) {
      const crouch = (p.flags & FLAG.SNEAK) !== 0;
      out.push({
        id: p.id, x: p.x, y: p.y, z: p.z, h: crouch ? CROUCH_HEIGHT : PLAYER_HEIGHT, eye: crouch ? SNEAK_EYE_HEIGHT : EYE_HEIGHT,
        valid: !p.sv.dead && p.sv.gm === "survival" && this.zone.outside(p.x, p.z, 0),
      });
    }
    return out;
  }

  /** Once a second each sapling has a 1 in 240 chance to grow (about 4 minutes on average), if there's room. */
  private growSaplings(): void {
    for (const i of [...this.saplings]) {
      if (Math.random() >= 1 / 240) continue;
      this.growSapling(i);
    }
  }

  /** Grow the sapling at cell i into a tree now, if it has room (never into a player, an animal or a mob). */
  growSapling(i: number): boolean {
    const id = this.world[i];
    if (!isSapling(id)) {
      this.saplings.delete(i);
      return false;
    }
    const x = cellX(i);
    const y = cellY(i);
    const z = cellZ(i);
    const ch = treeChanges(this.getBlock, x, y, z, id === B.BIRCH_SAPLING, Math.random);
    if (!ch) return false;
    for (const [cx, cy, cz] of ch) {
      for (const q of this.players.values()) if (shapeIntersectsPlayer(B.OAK_LOG, cx, cy, cz, q.x, q.y, q.z, this.getBlock, 0.05)) return false;
      if (this.animals.blocksCell(cx, cy, cz) || this.mobs.blocksCell(cx, cy, cz)) return false;
    }
    for (const [cx, cy, cz, cid] of ch) this.setBlock(idx(cx, cy, cz), cid, null);
    return true;
  }

  // ---------------------------------------------------------------- clankersmp spectators

  /** Everyone who is sent the world: the players, then the spectators. */
  *viewers(): IterableIterator<Player> {
    yield* this.players.values();
    yield* this.specs.values();
  }

  /** A new AI starts out in the wild, not on the hub's monument: the three side by side on land about 80 blocks
   *  out from the hub (east if there is land there), facing away from it. */
  agentSpawn(name: string): { x: number; y: number; z: number; yaw: number } {
    const k = Math.max(0, ["opus", "sonnet", "haiku"].indexOf(name));
    // a wild start: well away from the spawn hub and from every village, so they found a town from nothing (Laith:
    // "it should have no base or nearby village"; 80 blocks out of the hub put season 14's town next to Mossford).
    // Dry, level ground with no water close by; the same spot for all three, the same every time for this world
    const villages = this.villageSites.map((v) => VILLAGE_SITES[v]).filter(Boolean);
    let wild: { x: number; z: number; ys: number[]; score: number } | null = null;
    for (let z = 48; z <= WORLD_SIZE - 48; z += 12)
      for (let x = 48; x <= WORLD_SIZE - 48; x += 12) {
        if (Math.hypot(x - this.info.spawn.x, z - this.info.spawn.z) < 140) continue;
        if (villages.some((v) => Math.hypot(x - v.x, z - v.z) < 100)) continue;
        const ys = [-3, 0, 3].map((o) => this.standY(x + o, z));
        if (ys.some((y) => y < 0) || Math.max(...ys) - Math.min(...ys) > 1) continue;
        let wet = false;
        for (let dz = -10; dz <= 10 && !wet; dz++) for (let dx = -12; dx <= 12 && !wet; dx++) for (let y = ys[1] - 4; y <= ys[1] + 1 && !wet; y++) wet = IS_WATER[this.getBlock(x + dx, y, z + dz)] === 1;
        if (wet) continue;
        // level land round it (room for a town) counts most, then not too far out toward the coast
        let rough = 0;
        for (let dz = -8; dz <= 8; dz += 4) for (let dx = -8; dx <= 8; dx += 4) { const y = this.standY(x + dx, z + dz); rough += y < 0 ? 6 : Math.abs(y - ys[1]); }
        const score = rough + Math.hypot(x - WORLD_SIZE / 2, z - WORLD_SIZE / 2) * 0.02;
        if (!wild || score < wild.score) wild = { x, z, ys, score };
      }
    if (wild) return { x: wild.x + (k - 1) * 3 + 0.5, y: wild.ys[k], z: wild.z + 0.5, yaw: 180 };
    // the same place for all three: the first direction where all three spots are dry land
    for (const d of [0, 90, 180, 270, 45, 135, 225, 315]) {
      const a = (d * Math.PI) / 180;
      const bx = Math.floor(this.info.spawn.x + Math.cos(a) * 80);
      const z = Math.floor(this.info.spawn.z + Math.sin(a) * 80);
      const ys = [-3, 0, 3].map((o) => this.standY(bx + o, z));
      if (ys.some((y) => y < 0)) continue;
      // and no water close by (a pond next to the start is where the first holes flood)
      let wet = false;
      for (let dz = -7; dz <= 7 && !wet; dz++) for (let dx = -10; dx <= 10 && !wet; dx++) for (let y = ys[1] - 4; y <= ys[1] + 1 && !wet; y++) wet = IS_WATER[this.getBlock(bx + dx, y, z + dz)] === 1;
      if (wet) continue;
      const yaw = (((Math.atan2(-Math.cos(a), Math.sin(a)) * 180) / Math.PI) + 360) % 360;
      return { x: bx + (k - 1) * 3 + 0.5, y: ys[k], z: z + 0.5, yaw };
    }
    return { x: this.info.spawn.x, y: this.info.spawn.y, z: this.info.spawn.z, yaw: 180 };
  }

  /** A free spot for a body within 3 blocks of (x, y, z), closest first: room for it and solid ground under its feet,
   *  out of the water, at most a couple of blocks up or down. Null if there is none. */
  private freeSpotNear(x: number, y: number, z: number): [number, number, number] | null {
    const fx = Math.floor(x);
    const fy = Math.floor(y + 0.1);
    const fz = Math.floor(z);
    const spots: [number, number, number, number][] = [];
    for (let dz = -3; dz <= 3; dz++)
      for (let dx = -3; dx <= 3; dx++)
        for (const dy of [0, 1, -1, 2, -2]) spots.push([fx + dx, fy + dy, fz + dz, Math.hypot(dx, dz) + Math.abs(dy) * 0.6]);
    spots.sort((a, b) => a[3] - b[3]);
    for (const [cx, cy, cz] of spots) {
      if (cy < 2 || !inWorld(cx, cy, cz)) continue;
      const below = this.getBlock(cx, cy - 1, cz);
      if (!SOLID[below] || IS_WATER[this.getBlock(cx, cy, cz)]) continue;
      if (playerInsideSolid(this.getBlock, cx + 0.5, cy, cz + 0.5, 0.05)) continue;
      return [cx + 0.5, cy, cz + 0.5];
    }
    return null;
  }

  /** Where to stand in a column: on its top solid block, dry land only (no water, no tree tops). -1: nowhere. */
  private standY(x: number, z: number): number {
    for (let y = 120; y > 30; y--) {
      const id = this.getBlock(x, y, z);
      if (IS_WATER[id]) return -1;
      if (!SOLID[id]) continue;
      if (id === B.OAK_LEAVES || id === B.BIRCH_LEAVES || id === B.PALM_LEAVES) return -1;
      return y + 1;
    }
    return -1;
  }

  agentByName(name: string): Player | undefined {
    for (const p of this.players.values()) if (p.agent && p.name === name) return p;
    return undefined;
  }

  /** A spectator: no body in the world. It is sent what someone standing where its AI stands would be (blocks,
   *  players, animals, mobs, items), that AI's moves every tick and its HUD (fol); {t:"follow"} switches AI. */
  joinSpectator(ws: WebSocket, id: number, follow: string, ip: string): Player {
    const now = Date.now();
    const agents = [...this.players.values()].filter((q) => q.agent);
    const t = agents.find((q) => q.name === follow) ?? agents.find((q) => !q.sv.dead) ?? agents[0];
    const name = t?.name ?? (follow || "opus");
    const sx = t?.x ?? this.info.spawn.x;
    const sy = t?.y ?? this.info.spawn.y;
    const sz = t?.z ?? this.info.spawn.z;
    const sp: Player = {
      id, name: "spectator", key: "spec:" + id, ip, ws, skin: 0,
      x: sx, y: sy, z: sz, yaw: t?.yaw ?? 180, pitch: t?.pitch ?? 0, flags: 0, held: 0,
      version: 0, sent: new Map(), lastMoveAt: now,
      vx: sx, vy: sy, vz: sz, pendingTp: null, dig: null, delayedDig: null,
      place: new Bucket(1, 1),
      brk: new Bucket(1, 1),
      chat: new Bucket(5, 1),
      cmds: new Bucket(1, 1),
      slowNoticeAt: 0,
      moves: new Bucket(1, 1),
      msgs: new Bucket(60, 20),
      violations: 0, violationWindow: now,
      lastChat: "", lastChatAt: 0, joinedAt: now,
      groundedAt: now, groundedY: sy, lastResync: 0,
      seenAnimals: new Map(), hits: new Bucket(1, 1),
      sv: newSurvival(), sflags: 0, hurtFlagUntil: 0, seenItems: new Map(),
      armor: 0, seenMobs: new Map(),
      riding: 0, boatMoves: new Bucket(1, 1), seenBoats: new Map(), seenVillagers: new Map(), voice: newVoiceState(),
      follow: name, folSent: "",
    };
    this.specs.set(id, sp);
    this.send(sp, {
      t: "welcome",
      g: PROTOCOL_NAME,
      v: PROTOCOL_VERSION,
      id,
      name: "spectator",
      token: "",
      shard: this.info_(),
      shards: this.hooks.counts(),
      seed: this.seed,
      genHash: this.genHash,
      time: this.worldTime(),
      tick: this.tickCount,
      spawn: this.info.spawn,
      you: { x: sx, y: sy, z: sz, yaw: sp.yaw, pitch: sp.pitch },
      players: [...this.players.values()].map((q) => this.playerInfo(q)),
      spawnRadius: this.zone.off ? 0 : this.zone.radius,
      hub: this.hubPlan,
      skin: 0,
      gm: "survival",
      inv: sp.sv.inv.inv.map(toWire),
      armor: sp.sv.inv.armor.map(toWire),
      sel: 0,
      stats: this.survival.stats(sp),
      first: false,
      rides: this.rides(),
      villages: this.villageSites,
      voice: { on: false, adminMuted: false },
      spec: name,
    });
    this.sendBin(sp, this.editsMessage());
    this.send(sp, { t: "charity", c: this.hooks.charity() });
    return sp;
  }

  leaveSpectator(sp: Player): void {
    this.specs.delete(sp.id);
  }

  /** A spectator only pings, asks for the world again, or switches AI. */
  onSpectatorMessage(sp: Player, data: Buffer, isBinary: boolean): void {
    if (isBinary || !sp.msgs.take()) return;
    let m: { t?: unknown; c?: unknown; name?: unknown };
    try {
      m = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }
    if (!m || typeof m !== "object") return;
    if (m.t === "ping" && typeof m.c === "number" && sp.chat.take(0.1)) this.send(sp, { t: "pong", c: m.c, tick: this.tickCount });
    else if (m.t === "follow" && typeof m.name === "string" && m.name.length <= 16) {
      sp.follow = m.name.toLowerCase();
      sp.folSent = "";
    } else if (m.t === "resync") this.sendWorld(sp);
  }

  /** What the AI's own client is told that its spectators should see too (its hurt flash, its death screen). */
  private toFollowers(p: Player, msg: S2C): void {
    if (!this.specs.size) return;
    const s = JSON.stringify(msg);
    for (const sp of this.specs.values()) if (sp.follow === p.name && sp.ws.readyState === 1) sp.ws.send(s);
  }

  /** Each spectator stands where its AI stands, gets that AI's moves every tick (a smooth first-person camera)
   *  and its HUD whenever it changes. */
  private tickSpecs(): void {
    for (const sp of this.specs.values()) {
      const q = this.agentByName(sp.follow ?? "");
      if (q) {
        sp.x = q.x;
        sp.y = q.y;
        sp.z = q.z;
        if (sp.sent.get(q.id) !== q.version) {
          sp.sent.set(q.id, q.version);
          this.sendBin(sp, encodePlayers(this.tickCount, [{ id: q.id, x: q.x, y: q.y, z: q.z, yaw: q.yaw, pitch: q.pitch, flags: q.flags | q.sflags, held: q.held }]));
        }
      }
      if (this.tickCount % 2 === 0 && sp.ws.readyState === 1) {
        const st = JSON.stringify(this.followState(sp, q));
        if (st !== sp.folSent) {
          sp.folSent = st;
          sp.ws.send(st);
        }
      }
    }
  }

  private followState(sp: Player, q: Player | undefined): S2C {
    const name = q?.name ?? sp.follow ?? "";
    const death = !q || q.sv.dead ? (this.hooks.deathOf?.(name) ?? null) : null;
    if (!q) return { t: "fol", name, id: 0, online: false, dead: death !== null, ...(death ? { msg: death } : {}) };
    const s = q.sv;
    return {
      t: "fol", name, id: q.id, online: true, dead: s.dead, ...(death ? { msg: death } : {}),
      stats: this.survival.stats(q), sel: s.sel, hot: s.inv.inv.slice(0, 9).map(toWire), armor: s.inv.armor.map(toWire),
      // v14: the rest of its inventory (E opens it for the watcher), and whether it has its own inventory open
      bag: s.inv.inv.slice(9).map(toWire), ...(q.invOpen ? { open: true } : {}),
    };
  }

  /** clankersmp hardcore: an AI died (main.ts keeps it out for good). */
  agentDied(p: Player, msg: string): void {
    this.hooks.died?.(p, msg);
  }

  private broadcastPlayers(): void {
    for (const r of this.viewers()) {
      const list: PlayerSnap[] = [];
      for (const q of this.players.values()) {
        if (q === r) continue;
        const last = r.sent.get(q.id);
        if (last === q.version) continue;
        const dx = q.x - r.x;
        const dz = q.z - r.z;
        const d2 = dx * dx + dz * dz;
        // Interest management: 10 Hz within 48 blocks, 5 Hz to 128, 2 Hz beyond.
        const every = d2 > 128 * 128 ? 10 : d2 > 48 * 48 ? 4 : 2;
        if (last !== undefined && this.tickCount % every !== 0) continue;
        list.push({ id: q.id, x: q.x, y: q.y, z: q.z, yaw: q.yaw, pitch: q.pitch, flags: q.flags | q.sflags, held: q.held });
        r.sent.set(q.id, q.version);
      }
      if (list.length) this.sendBin(r, encodePlayers(this.tickCount, list));
    }
  }

  /** Saves edits, the log and positions; animals every minute, when the shard is empty, or when `all` (admin save,
   *  shutdown). */
  save(all = false): void {
    try {
      if (this.dirty) {
        this.store.saveEdits(this.edits);
        this.dirty = false;
      }
      this.store.flushLog();
      // Keep the edit log file bounded: past ~200 MB, rewrite it with the entries still in memory.
      if (this.store.logBytes() > 200 * 1024 * 1024) this.store.rewriteLog(this.log);
      for (const p of this.players.values()) this.positions.set(p.key, this.savedOf(p));
      this.store.savePlayers(this.positions);
      if (all || this.tickCount % 1200 === 0 || !this.players.size) this.animals.save();
      this.water.save();
      this.leaves.save();
      this.containers.save();
      this.boats.save();
      this.villagers.save();
      if (all || this.tickCount % 600 === 0 || !this.players.size) this.items.save();
    } catch (e) {
      log(`shard ${this.n}: save failed`, e);
    }
  }

  // ---------------------------------------------------------------- admin

  rollback(f: RollbackFilter): number {
    const entries = this.log.slice();
    let count = 0;
    const a = f.area;
    for (let j = entries.length - 1; j >= 0; j--) {
      const e = entries[j];
      if (e.t < f.sinceMs) break;
      if (e.k === "admin") continue;
      if (f.key && e.k !== f.key) continue;
      if (f.name && e.p.toLowerCase() !== f.name.toLowerCase()) continue;
      if (f.ip && e.ip !== f.ip) continue;
      if (a) {
        const x = cellX(e.i);
        const z = cellZ(e.i);
        const y = cellY(e.i);
        if (x < Math.min(a.x1, a.x2) || x > Math.max(a.x1, a.x2) || z < Math.min(a.z1, a.z2) || z > Math.max(a.z1, a.z2)) continue;
        if (a.y1 !== undefined && y < Math.min(a.y1, a.y2 ?? a.y1)) continue;
        if (a.y2 !== undefined && y > Math.max(a.y1 ?? a.y2, a.y2)) continue;
      }
      // Still what they left there; a hole they dug may since have filled with water (flowing, or a new source).
      const now = this.world[e.i];
      const unlit = (id: number) => (isFurnace(id) ? B.FURNACE + ((id - B.FURNACE) % 4) : id);
      if (unlit(now) === unlit(e.n) || (e.n === B.AIR && IS_WATER[now])) {
        this.setBlock(e.i, e.o, null);
        count++;
      }
    }
    if (count) {
      this.containers.prune((c) => this.world[c]);
      this.save();
    }
    return count;
  }

  resetWorld(): void {
    this.world.set(this.base);
    this.edits.clear();
    this.editsVersion++;
    this.dirty = true;
    this.positions.clear();
    this.water.clear();
    this.animals.reset();
    this.mobs.clear();
    this.items.clear();
    this.containers.furnaces.clear();
    this.containers.chests.clear();
    for (const p of this.players.values()) p.riding = 0;
    this.boats.clear();
    this.survival.reset();
    this.store.resetWorld();
    this.loot.reset();
    this.fillLoot();
    this.save();
    this.broadcast({ t: "reload", reason: "The world was reset." });
  }

  findPlayer(name: string): Player | undefined {
    const n = name.toLowerCase();
    for (const p of this.players.values()) if (p.name.toLowerCase() === n) return p;
    return undefined;
  }

  /** Recent editors (for the admin listing). */
  editors(sinceMs: number): { name: string; key: string; ip: string; edits: number; last: number }[] {
    const m = new Map<string, { name: string; key: string; ip: string; edits: number; last: number }>();
    for (let j = this.log.length - 1; j >= 0; j--) {
      const e = this.log[j];
      if (e.t < sinceMs) break;
      if (e.k === "admin") continue;
      const r = m.get(e.k) ?? { name: e.p, key: e.k, ip: e.ip, edits: 0, last: e.t };
      r.edits++;
      m.set(e.k, r);
    }
    return [...m.values()].sort((a, b) => b.edits - a.edits);
  }
}
