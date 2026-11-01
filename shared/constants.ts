// World and game constants shared by the client, the server and the tests.

/** The world is 2^WORLD_BITS blocks along x and z (512). Cell indices are bit-packed: x fastest, then z, then y. */
export const WORLD_BITS = 9;
export const WORLD_SIZE = 1 << WORLD_BITS; // 512 blocks along x and z
export const WORLD_MASK = WORLD_SIZE - 1;
export const WORLD_HEIGHT = 128; // blocks along y
export const Y_SHIFT = WORLD_BITS * 2; // one y layer = WORLD_SIZE^2 cells
export const LAYER = WORLD_SIZE * WORLD_SIZE;
export const CHUNK = 16;
export const CHUNKS = WORLD_SIZE / CHUNK; // 32 chunks per side
export const SECTIONS = WORLD_HEIGHT / CHUNK; // 8 vertical sections per chunk
export const VOLUME = WORLD_SIZE * WORLD_SIZE * WORLD_HEIGHT;
export const SEA_LEVEL = 40; // water fills y < SEA_LEVEL

export const TICK_RATE = 20; // Java Edition: 20 ticks per second
export const TICK_MS = 1000 / TICK_RATE;
export const DAY_TICKS = 24000; // one full day, 20 minutes

/** $STEVE Craft survival's own wire protocol. A client or server with a different name is a different game. The old
 *  $STEVE Craft builder (protocol 4) sent no name at all; the server tells such a page to reload (server/src/main.ts). */
export const PROTOCOL_NAME = "stevecraft";
export const PROTOCOL_VERSION = 12; // $STEVE Craft survival (2026-10-30): the survival engine (its wire format as of v11: survival, night mobs, combat,
// farming, boats, villages and trading, the big spawn hub, proximity voice) under its own protocol name. 1-4 were the
// builder (no protocol name), so the first survival version is 12: higher than any builder page knows, which makes an
// old builder page reload into the new game.
/** Bump whenever terrain generation changes: saved worlds are diffs against the generated terrain. */
export const WORLDGEN_VERSION = 4; // 4: $STEVE Craft survival: the spawn hub with the "punch a tree" landmark (a fresh world, in its own world dir)
/** Players on one server (shard) before new joins go to the next. 12.1.1: 100 (was 50); the server's MAX_PLAYERS_PER_SHARD env overrides it. */
export const MAX_PLAYERS_PER_SHARD = 100;

export const REACH = 4.5; // client pick distance (survival reach)
export const ENTITY_REACH = 3; // v6: how far you can hit an animal or a mob (the classic 3 blocks; the server allows lag)
export const SERVER_REACH = 5.0; // server-side hard limit, from eye to block
export const SPAWN_PROTECT_RADIUS = 12; // no edits within this many blocks of spawn (x/z)

export const PLAYER_WIDTH = 0.6;
export const PLAYER_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.62;
export const SNEAK_EYE_HEIGHT = 1.27; // the crouching pose (Java 1.14+): eyes 0.35 lower
export const CROUCH_HEIGHT = 1.5; // and the box 1.5 tall, so you can sneak under 1.5-high gaps

export const CHAT_MAX = 100;
export const DEFAULT_SEED = 1014;

/** Linear cell index: x fastest, then z, then y. */
export function idx(x: number, y: number, z: number): number {
  return (y << Y_SHIFT) | (z << WORLD_BITS) | x;
}
export const cellX = (i: number): number => i & WORLD_MASK;
export const cellZ = (i: number): number => (i >> WORLD_BITS) & WORLD_MASK;
export const cellY = (i: number): number => i >> Y_SHIFT;

export function inWorld(x: number, y: number, z: number): boolean {
  return x >= 0 && x < WORLD_SIZE && z >= 0 && z < WORLD_SIZE && y >= 0 && y < WORLD_HEIGHT;
}

export const SPAWN_X = WORLD_SIZE / 2;
export const SPAWN_Z = WORLD_SIZE / 2;
