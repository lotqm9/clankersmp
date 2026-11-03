// Wire protocol. Hot paths (movement, block updates, position batches) are binary; everything else is JSON.
// The world is 512 x 512, so x and z travel as u16 everywhere.

import type { WireOffer } from "./trades.ts";
import { PROTOCOL_NAME } from "./constants.ts";
import type { Click } from "./inventory.ts";
import type { WireStack } from "./items.ts";

export const OP = {
  MOVE: 1, // C2S [op u8][x f32][y f32][z f32][yaw f32][pitch f32][flags u8][selected hotbar slot u8]
  EDITS: 16, // S2C full edit list on join: [op u8][count u32] + deflate-raw(count * BLOCK_ENTRY)
  BLOCKS: 17, // S2C block changes: [op u8][count u32] + count * BLOCK_ENTRY (not compressed)
  PLAYERS: 18, // S2C [op u8][serverTick u32][n u16] then n * PLAYER_ENTRY bytes
  WORLD: 19, // S2C [op u8][hash u32] + deflate-raw(blocks): full world fallback when terrain hashes differ
  // 20, 21: animals (shared/animals.ts); 22-24: dropped items (shared/drops.ts); 25, 26: night mobs (shared/mobs.ts);
  // 27, 28: boats (shared/boats.ts, v8)
} as const;

export const MOVE_BYTES = 23;
export const BLOCK_ENTRY = 6; // x u16, z u16, y u8, id u8
export const PLAYER_ENTRY = 14; // id u16, x u16 (1/128), y u16 (1/256), z u16 (1/128), yaw u16, pitch i8, flags u8, held u16

/** Fixed-point scales for player positions: x/z cover 0..512, y covers 0..256. */
export const XZ_SCALE = 128;
export const Y_SCALE = 256;

export const FLAG = {
  SNEAK: 1, // the crouching pose (1.5 tall)
  SPRINT: 2,
  GROUND: 4,
  WATER: 8,
  SLEEP: 16, // set by the server: lying in a bed
  DEAD: 32, // set by the server: on the death screen (hidden)
  EAT: 64, // eating (the arm bobs)
  HURT: 128, // set by the server for half a second after taking damage (red flash)
} as const;

export interface MoveMsg {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  flags: number;
  held: number;
}

export function encodeMove(m: MoveMsg): ArrayBuffer {
  const buf = new ArrayBuffer(MOVE_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, OP.MOVE);
  v.setFloat32(1, m.x, true);
  v.setFloat32(5, m.y, true);
  v.setFloat32(9, m.z, true);
  v.setFloat32(13, m.yaw, true);
  v.setFloat32(17, m.pitch, true);
  v.setUint8(21, m.flags & 255);
  v.setUint8(22, m.held & 255); // v5: the selected hotbar slot
  return buf;
}

export function decodeMove(v: DataView): MoveMsg | null {
  if (v.byteLength !== MOVE_BYTES) return null;
  const m = {
    x: v.getFloat32(1, true),
    y: v.getFloat32(5, true),
    z: v.getFloat32(9, true),
    yaw: v.getFloat32(13, true),
    pitch: v.getFloat32(17, true),
    flags: v.getUint8(21),
    held: v.getUint8(22),
  };
  if (![m.x, m.y, m.z, m.yaw, m.pitch].every(Number.isFinite)) return null;
  return m;
}

export interface BlockChange {
  x: number;
  y: number;
  z: number;
  id: number;
}

/** Writes one block entry at byte offset o. */
export function writeBlockEntry(out: Uint8Array, o: number, x: number, y: number, z: number, id: number): void {
  out[o] = x & 255;
  out[o + 1] = x >> 8;
  out[o + 2] = z & 255;
  out[o + 3] = z >> 8;
  out[o + 4] = y;
  out[o + 5] = id;
}

/** Decodes a raw list of block entries (the inflated EDITS payload, or the body of a BLOCKS message) into a flat
 *  x,y,z,id,... array. */
export function readBlockEntries(raw: Uint8Array, start = 0, count = Math.floor((raw.length - start) / BLOCK_ENTRY)): number[] {
  const out: number[] = new Array(count * 4);
  let o = start;
  let k = 0;
  for (let n = 0; n < count && o + BLOCK_ENTRY <= raw.length; n++, o += BLOCK_ENTRY) {
    out[k++] = raw[o] | (raw[o + 1] << 8);
    out[k++] = raw[o + 4];
    out[k++] = raw[o + 2] | (raw[o + 3] << 8);
    out[k++] = raw[o + 5];
  }
  out.length = k;
  return out;
}

export function encodeBlocks(op: number, list: BlockChange[]): Uint8Array {
  const out = new Uint8Array(5 + list.length * BLOCK_ENTRY);
  const v = new DataView(out.buffer);
  v.setUint8(0, op);
  v.setUint32(1, list.length, true);
  let o = 5;
  for (const c of list) {
    writeBlockEntry(out, o, c.x, c.y, c.z, c.id);
    o += BLOCK_ENTRY;
  }
  return out;
}

export function decodeBlocks(v: DataView): BlockChange[] {
  const n = v.getUint32(1, true);
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  const flat = readBlockEntries(bytes, 5, n);
  const out: BlockChange[] = [];
  for (let k = 0; k + 3 < flat.length; k += 4) out.push({ x: flat[k], y: flat[k + 1], z: flat[k + 2], id: flat[k + 3] });
  return out;
}

export interface PlayerSnap {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  flags: number;
  held: number;
}

export function encodePlayers(tick: number, list: PlayerSnap[]): Uint8Array {
  const out = new Uint8Array(7 + list.length * PLAYER_ENTRY);
  const v = new DataView(out.buffer);
  v.setUint8(0, OP.PLAYERS);
  v.setUint32(1, tick >>> 0, true);
  v.setUint16(5, list.length, true);
  let o = 7;
  for (const p of list) {
    v.setUint16(o, p.id, true);
    v.setUint16(o + 2, q16(p.x, XZ_SCALE), true);
    v.setUint16(o + 4, q16(p.y, Y_SCALE), true);
    v.setUint16(o + 6, q16(p.z, XZ_SCALE), true);
    v.setUint16(o + 8, Math.round((((p.yaw % 360) + 360) % 360) * (65536 / 360)) & 0xffff, true);
    v.setInt8(o + 10, Math.max(-127, Math.min(127, Math.round((p.pitch / 90) * 127))));
    v.setUint8(o + 11, p.flags & 255);
    v.setUint16(o + 12, p.held & 0xffff, true);
    o += PLAYER_ENTRY;
  }
  return out;
}

export function decodePlayers(v: DataView): { tick: number; list: PlayerSnap[] } {
  const tick = v.getUint32(1, true);
  const n = v.getUint16(5, true);
  const list: PlayerSnap[] = [];
  let o = 7;
  for (let i = 0; i < n && o + PLAYER_ENTRY <= v.byteLength; i++) {
    list.push({
      id: v.getUint16(o, true),
      x: v.getUint16(o + 2, true) / XZ_SCALE,
      y: v.getUint16(o + 4, true) / Y_SCALE,
      z: v.getUint16(o + 6, true) / XZ_SCALE,
      yaw: (v.getUint16(o + 8, true) * 360) / 65536,
      pitch: (v.getInt8(o + 10) * 90) / 127,
      flags: v.getUint8(o + 11),
      held: v.getUint16(o + 12, true),
    });
    o += PLAYER_ENTRY;
  }
  return { tick, list };
}

export function q16(v: number, scale: number): number {
  return Math.max(0, Math.min(65535, Math.round(v * scale)));
}

// ---- JSON messages ----

export interface PlayerInfo {
  id: number;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  skin: number; // shirt colour variant
  held: number;
  armor?: number; // v6: what they wear (shared/combat.ts packArmor)
}

/** The charity meter: state prelaunch (no coin yet), live (real on-chain numbers), or unavailable.
 *  `name` / `x` are the charity (CHARITY_NAME / CHARITY_X); both empty until the charity is chosen. */
export interface CharityInfo {
  state: "prelaunch" | "live" | "unavailable";
  name?: string;
  x?: string;
  totalSol?: number;
  donatedSol?: number;
  pendingSol?: number;
  updatedAt?: number;
}

export interface ShardInfo {
  n: number; // 1-based shard number ("Server 1")
  players: number;
  cap: number;
}

export type C2S =
  | { t: "hello"; g: typeof PROTOCOL_NAME; v: number; name?: string; token?: string; shard?: number; agent?: string; follow?: string } // clankersmp: agent = the AI secret; anyone else spectates `follow`
  | { t: "dig"; a: "start" | "abort" | "finish"; x: number; y: number; z: number }
  | { t: "place"; x: number; y: number; z: number; id: number }
  | { t: "use"; x: number; y: number; z: number }
  | { t: "hit"; id: number; mob?: boolean; boat?: boolean; villager?: boolean; player?: boolean } // v2: left-click on an animal; v6: or on a night mob; v8: or a boat; v9: or a villager (a poke: no damage)
  | { t: "chat"; text: string }
  | { t: "swing" }
  | { t: "ping"; c: number }
  | { t: "resync" }
  // v5 survival
  | { t: "sel"; s: number } // selected hotbar slot
  | { t: "click"; w: number; n: number; c: Click } // a click in an open window (n: client sequence)
  | { t: "close"; w: number }
  | { t: "eat"; a: "start" | "finish" | "abort" }
  | { t: "drop"; all: boolean } // Q: throw the held item (one, or the stack)
  | { t: "respawn" }
  | { t: "wake" }
  | { t: "cset"; s: number; id: number } // creative only: put any item in a hotbar slot
  // v7
  | { t: "bow"; a: "start" | "release" | "abort" } // draw the bow, loose the arrow (the server times the draw)
  | { t: "milk"; id: number } // right-click on a cow with an empty bucket
  // v8
  | { t: "boat_place"; x: number; y: number; z: number } // a boat from your hand onto the water (or ground) you look at
  | { t: "mount"; id: number } // right-click on a boat: sit in it
  | { t: "dismount" } // sneak: get out
  | { t: "boat"; id: number; x: number; y: number; z: number; yaw: number; r: number } // the driver's boat (r: BF row flags)
  // v9
  | { t: "talk"; id: number } // right-click on a villager: its trade window
  | { t: "trade"; w: number; o: number; all?: boolean } // trade offer o in trade window w (all: as many times as it can)
  // v11 proximity voice (shared/voice.ts; the frames themselves are binary OP_VOICE_UP)
  | { t: "voice"; mic: boolean; hear: boolean; opus: boolean } // voice on (may send), wants to hear, can decode Opus
  | { t: "vmute"; ids: number[] } // the players (online now) this player muted
  // clankersmp
  | { t: "craft"; r: string; n?: number } // an AI crafts a recipe (shared/recipes.ts id) straight from its inventory, n times
  | { t: "hold"; id: number } // an AI takes an item in hand (swapped into the selected hotbar slot)
  | { t: "wear" } // an AI puts on the best armour it carries
  | { t: "smelt"; id: number; n?: number } // an AI smelts n of an item in a furnace within reach (its own fuel)
  | { t: "aloot" } // an AI takes everything from the chest within reach
  | { t: "atrades"; job?: number } // an AI asks about the nearest villager (v13 job: of that trade, within 64 blocks): where it is and what it trades
  | { t: "atrade"; v: number; o: number; n?: number } // an AI makes villager v's offer o, n times
  | { t: "follow"; name: string } // a spectator watches another AI
  // v13
  | { t: "enchant"; l?: number; a?: number } // an AI enchants what it holds (a: or the armour it wears in slot a) at the enchanting table within reach (l: the level, else the best it can)
  // v14 (additive: no new version)
  | { t: "aswap"; a: number; b: number } // an AI sorting its inventory: the stack in slot a onto slot b (0-35: merged into the same item, else swapped)
  | { t: "ainv"; open: boolean }; // an AI has its inventory screen open (or closed it): its watchers see it

export type GameMode = "survival" | "creative";

export interface Stats {
  hp: number; // 0..20 (half hearts)
  food: number; // 0..20
  sat: number;
  air: number; // 0..300 ticks
  queasy?: boolean; // v6: spoiled food is making you hungrier (the food bar turns sickly green)
}

export type WindowKind = "player" | "crafting" | "furnace" | "chest" | "trade";

export type S2C =
  | {
      t: "welcome";
      g: typeof PROTOCOL_NAME;
      v: number;
      id: number;
      name: string;
      token: string;
      shard: ShardInfo;
      shards: ShardInfo[];
      seed: number;
      genHash: number;
      time: number; // world time in ticks at `tick`
      tick: number; // server tick counter
      spawn: { x: number; y: number; z: number };
      you: { x: number; y: number; z: number; yaw: number; pitch: number };
      players: PlayerInfo[];
      spawnRadius: number; // v5: the safe zone radius (no building, no damage, no hostile mobs)
      skin: number;
      gm: GameMode;
      inv: WireStack[]; // 36 slots: 0-8 hotbar
      armor: WireStack[]; // v6: 4 slots: head, chest, legs, feet
      sel: number;
      stats: Stats;
      first: boolean; // first time on this server (survival tips)
      rides?: [number, number, number][]; // v8: who sits in which boat: [player id, boat id, seat]
      villages?: number[]; // v9: the village sites this world has (shared/villages.ts): build these ones
      hub?: { keep: number[]; roads: number[] }; // v10: the bigger hub's plan (shared/hub12.ts): build it the same way
      voice?: { on: boolean; adminMuted: boolean }; // v11: proximity voice allowed on this server; this player muted by an admin
      spec?: string; // clankersmp: this connection only watches; the AI it follows
    }
  | { t: "join"; p: PlayerInfo }
  | { t: "leave"; id: number; name: string }
  | { t: "chat"; from: string | null; text: string; kind: "player" | "system" | "join" | "leave" }
  | { t: "time"; time: number; tick: number }
  | { t: "tp"; x: number; y: number; z: number }
  | { t: "swing"; id: number }
  | { t: "count"; shard: ShardInfo; shards: ShardInfo[] }
  | { t: "pong"; c: number; tick: number }
  | { t: "notice"; text: string }
  | { t: "kick"; reason: string; server?: number; g?: string }
  | { t: "charity"; c: CharityInfo }
  | { t: "reload"; reason: string }
  // v5 survival
  | { t: "slots"; list: [number, WireStack][] } // inventory slots changed outside a window (pickup, place, eat, wear); v6: 36-39 = armour
  | { t: "open"; w: number; kind: WindowKind; title: string; items: WireStack[]; cursor: WireStack; vid?: number; offers?: WireOffer[] } // v9: a trade window has the villager and its offers
  | { t: "win"; w: number; n: number; items: WireStack[]; cursor: WireStack } // a window's whole contents
  | { t: "close"; w: number }
  | { t: "furnace"; w: number; burn: number; cook: number } // 0..1
  | { t: "stats"; s: Stats }
  | { t: "hurt"; cause: string; dx?: number; dz?: number; kb?: [number, number, number] } // you took damage (dx/dz: from where; v6 kb: knockback velocity)
  | { t: "dead"; msg: string }
  | { t: "respawned"; x: number; y: number; z: number; yaw: number }
  | { t: "gm"; mode: GameMode }
  | { t: "sleep"; on: boolean; sleeping: number; needed: number; you: boolean }
  | { t: "fx"; k: "tool_break" | "burp" | "eat" | "level" | "crit" | "hit" | "equip" | "mob_die" | "bone_meal" | "till" | "bucket_fill" | "bucket_empty" | "drink" | "pickup" | "chime" | "boat_place" | "boat_break" | "path" | "pot" | "barrel" | "trade" | "trade_no" | "enchant" | "hiss"; id?: number; x?: number; y?: number; z?: number } // v13: enchant (at the table), hiss (lava setting into obsidian)
  // v6
  | { t: "wear"; id: number; armor: number } // a player's armour changed (packArmor)
  | { t: "arrow"; id: number; x: number; y: number; z: number; vx: number; vy: number; vz: number } // shot (simulate with arrowMove)
  | { t: "arrow_end"; id: number; x: number; y: number; z: number; stuck: boolean } // it hit a block (stuck), a player or vanished
  | { t: "struck"; id: number; mob: boolean; dmg: number; crit: boolean; kills: boolean } // your hit landed (what it did)
  // v7
  | { t: "arrow_gone"; id: number } // a stuck arrow was picked up, or went after a minute
  // v8
  | { t: "ride"; p: number; b: number; s: number } // player p now sits in boat b, seat s (b 0: got out)
  | { t: "boat_tp"; id: number; x: number; y: number; z: number; yaw: number } // the driver's boat put back (a correction)
  // v9
  | { t: "offers"; w: number; offers: WireOffer[] } // a trade window's villager's stock changed
  // v11 proximity voice (the frames are binary OP_VOICE)
  | { t: "talking"; ids: number[] } // who is talking now (speaking icons over heads and in the player list)
  | { t: "vcodec"; adpcm: boolean } // send the fallback codec (someone in range can only play that) or Opus again
  | { t: "vstate"; adminMuted: boolean } // an admin turned this player's voice off (or on again)
  // clankersmp: what a spectator is sent about the AI it watches (its HUD; the body comes in the PLAYERS stream)
  | { t: "fol"; name: string; id: number; online: boolean; dead: boolean; msg?: string; stats?: Stats; sel?: number; hot?: WireStack[]; armor?: WireStack[]; bag?: WireStack[]; open?: boolean } // v14: bag (slots 9-35), open (its inventory screen is open)
  | { t: "fdig"; id: number; a: "start" | "abort" | "finish"; x: number; y: number; z: number } // the watched AI digs (the crack and the arm)
  | { t: "crafted"; r: string; n: number } // an AI's craft: how many were made
  | { t: "smelting"; n: number; ms: number; why?: string } // an AI's smelt: how many go in, and when they come out
  | { t: "looted"; got: [number, number][]; why?: string } // what an AI took from a chest
  | { t: "atrades"; v: { vid: number; name: string; job: number; x: number; y: number; z: number; offers: { a: [number, number]; b?: [number, number]; r: [number, number]; n: number; m: number }[] } | null }
  | { t: "atraded"; n: number; why?: string } // how many times an AI's trade went through
  // v13
  | { t: "enchanted"; id: number; l: number; cost: number; why?: string } // an AI's enchanting: what it holds now, the level, the rubies paid (id 0: nothing happened, why)
  // v14
  | { t: "fcraft"; r: string; n: number }; // the watched AI crafted recipe r, n times (its watchers see the grid)
