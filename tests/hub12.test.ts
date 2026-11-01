// Update 12 (shared/hub12.ts): the bigger hub never eats a player's edit. The tiles the server keeps (an edit within
// 3 blocks) stay exactly as the old world had them, a building that would reach into one is left out whole, and
// those tiles stay out of the safe zone. Roads reach every village the world has (live-like and fresh) and the
// harbour; the harbour's piers stand over the sea with boat slots on open water. The same plan builds the same world.

import { test } from "node:test";
import assert from "node:assert/strict";
import { B, IS_WATER, SOLID } from "../shared/blocks.ts";
import { DEFAULT_SEED, SEA_LEVEL, SPAWN_X, SPAWN_Z, WORLD_HEIGHT, WORLD_SIZE, idx } from "../shared/constants.ts";
import { HARBOUR, SafeZone, TILE, TILES, keepTiles, tileOf } from "../shared/hub12.ts";
import { generateWorld, hashBlocks } from "../shared/worldgen.ts";

const CX = SPAWN_X;
const CZ = SPAWN_Z;
const LIVE = [3, 19, 27]; // the live world's villages (Pennywhistle, Sorrelby, Bellwether)

/** Every cell (all heights) of a tile in two worlds: the same? */
function tileSame(a: Uint8Array, b: Uint8Array, t: number): boolean {
  const x0 = (t % TILES) * TILE;
  const z0 = Math.floor(t / TILES) * TILE;
  for (let z = z0; z < z0 + TILE; z++) for (let x = x0; x < x0 + TILE; x++) for (let y = 0; y < WORLD_HEIGHT; y++) if (a[idx(x, y, z)] !== b[idx(x, y, z)]) return false;
  return true;
}

test("keepTiles: an edit's own tile and every tile within 3 blocks of it", () => {
  const at = (x: number, z: number, y = 50) => idx(x, y, z);
  assert.deepEqual(keepTiles([at(100, 100)]), [tileOf(100, 100)], "inside its tile");
  assert.deepEqual(keepTiles([at(101, 101)]), [tileOf(97, 97), tileOf(104, 97), tileOf(97, 104), tileOf(104, 104)].sort((a, b) => a - b), "near a corner: four tiles");
  assert.deepEqual(keepTiles([at(0, 0), at(511, 511)]), [0, TILES * TILES - 1], "the world's edges");
  assert.deepEqual(keepTiles([]), []);
});

test("the safe zone: the old circle always, the new one except kept tiles, nothing beyond", () => {
  const z = new SafeZone([tileOf(CX + 55, CZ), tileOf(CX + 10, CZ)]);
  assert.ok(z.contains(CX + 10.5, CZ + 0.5), "inside the old circle a kept tile is still safe");
  assert.ok(z.contains(CX + 50.5, CZ - 20.5), "the new ring");
  assert.ok(!z.contains(CX + 55.5, CZ + 0.5), "a kept tile out there is wild (its builders keep building)");
  assert.ok(!z.contains(CX + 69.5, CZ + 0.5), "beyond 68");
  assert.ok(z.outside(CX + 62.5, CZ + 30.5) && z.contains(CX + 59.5, CZ + 30.5));
  assert.ok(!z.contains(CX + 75, CZ, 4) && z.contains(CX + 70, CZ, 4), "a margin widens it");
});

test("kept tiles stay cell for cell as the old world had them; a building touching one is left out whole; the rest is built", () => {
  // builds just outside the old hub's edge (r 48-62), on the Beacon's ground and in the east hall's footprint
  const edits = [idx(CX + 52, 47, CZ + 6), idx(CX - 40, 47, CZ - 38), idx(CX + 3, 60, CZ - 58), idx(CX + 30, 47, CZ + 9), idx(CX + 1, 50, CZ - 40)];
  const keep = keepTiles(edits);
  const old = generateWorld(DEFAULT_SEED, undefined, { villages: LIVE, hub: false }).blocks;
  const g = generateWorld(DEFAULT_SEED, undefined, { villages: LIVE, hub: { keep, roads: LIVE } });
  for (const t of keep) assert.ok(tileSame(old, g.blocks, t), `tile ${t} untouched`);
  assert.equal(g.info.hub.beacon, null, "no Beacon: its ground holds a build");
  assert.equal(g.info.hub.panels.filter((p) => p.kind === "charity").length, 0, "no Charity Hall over a build");
  assert.equal(g.info.hub.panels.filter((p) => p.kind === "updates").length, 1, "the Updates House still stands");
  assert.deepEqual(g.info.hub.keep, keep);
  // the rest of the hub is there: the landmark, the plaza, the arrival
  const lm = g.info.hub.landmark!;
  assert.ok(lm, "the landmark");
  assert.equal(g.blocks[idx(lm.figure.x + 9, lm.figure.y0 + 21, lm.figure.z + 5)], B.SMOOTH_TAN, "its fist");
  assert.equal(g.info.spawn.z, CZ + 44.5);
  // the safe zone leaves the builds' tiles out
  const zone = new SafeZone(keep);
  assert.ok(!zone.contains(CX + 52.5, CZ + 6.5), "the build at r 52 is in the wild");
  assert.ok(zone.contains(CX + 52.5, CZ + 30.5), "elsewhere at r 60 is safe");
});

test("a build by the arrival: the directions board moves to the plaza's south rim; the spawn stays in the courtyard", () => {
  const keep = keepTiles([idx(CX + 12, 47, CZ + 44)]);
  const g = generateWorld(DEFAULT_SEED, undefined, { villages: LIVE, hub: { keep, roads: LIVE } });
  const dir = g.info.hub.panels.find((p) => p.kind === "directions")!;
  assert.ok(dir && dir.nz === 1 && dir.z > CZ + 21 && dir.z < CZ + 23, `the directions board at the plaza's rim (${dir?.x}, ${dir?.z})`);
  assert.equal(g.info.hub.panels.filter((p) => p.kind === "tips" && p.nx === 1).length, 1, "the tips board still in the courtyard");
  assert.equal(g.info.spawn.z, CZ + 44.5);
  const near = keepTiles([idx(CX, 47, CZ + 44)]);
  assert.equal(generateWorld(DEFAULT_SEED, undefined, { villages: LIVE, hub: { keep: near, roads: LIVE } }).info.spawn.z, CZ + 7.5, "a build on the spawn point itself: the old spawn on the plaza");
});

test("a build on the landmark's ground: no landmark; the old monument (sign and diamond) stays and keeps its sign", () => {
  const keep = keepTiles([idx(CX, 47, CZ - 7)]);
  const old = generateWorld(DEFAULT_SEED, undefined, { villages: LIVE, hub: false });
  const g = generateWorld(DEFAULT_SEED, undefined, { villages: LIVE, hub: { keep, roads: LIVE } });
  for (const t of keep) assert.ok(tileSame(old.blocks, g.blocks, t));
  assert.deepEqual(g.info.board, old.info.board, "the old sign, where it stands");
  assert.equal(g.info.hub.landmark, null, "the landmark is left out whole");
});

test("roads reach every village a world has and the harbour (the live world's three, a fresh world's four), round the others' squares", () => {
  for (const villages of [LIVE, [0, 1, 2, 3]]) {
    const g = generateWorld(DEFAULT_SEED, undefined, { villages });
    const h = g.info.hub;
    assert.equal(h.roads!.length, villages.length + 1);
    for (const r of h.roads!) assert.ok(r.reached, `${villages}: the road to ${r.to}`);
    // each destination: dirt path (or planks) where its road ends, just outside the village's square
    for (const d of h.destinations!) {
      let y = WORLD_HEIGHT - 1;
      while (y > 0 && !SOLID[g.blocks[idx(d.x, y, d.z)]]) y--;
      const id = g.blocks[idx(d.x, y, d.z)];
      assert.ok(id === B.DIRT_PATH || id === B.OAK_PLANKS || id === B.STONE_BRICKS || id === B.COBBLESTONE, `${d.name}: the road's end (${id})`);
    }
    // the villages' own squares are as their village built them: no road crosses a house
    const noHub = generateWorld(DEFAULT_SEED, undefined, { villages, hub: false }).blocks;
    for (const v of g.info.villages.list)
      for (const hs of v.houses) assert.equal(g.blocks[idx(hs.door[0], hs.door[1], hs.door[2])], noHub[idx(hs.door[0], hs.door[1], hs.door[2])], `${v.name}'s houses untouched`);
  }
});

test("the harbour: two piers out over the sea, a quay, a hut with a door, boat slots on open water facing out", () => {
  const g = generateWorld(DEFAULT_SEED, undefined, { villages: LIVE });
  const h = g.info.hub.harbour!;
  assert.ok(h, "the harbour is built");
  assert.deepEqual([h.x, h.z], [HARBOUR.x, HARBOUR.z]);
  const at = (x: number, y: number, z: number) => g.blocks[idx(x, y, z)];
  for (const s of [-5, 5]) {
    for (let a = 1; a <= 14; a++) {
      assert.equal(at(HARBOUR.x - s, SEA_LEVEL, HARBOUR.z + a), B.OAK_PLANKS, `pier ${s} at ${a}`);
      if (a > 3) assert.ok(IS_WATER[at(HARBOUR.x - s - 2, SEA_LEVEL - 1, HARBOUR.z + a)] || at(HARBOUR.x - s - 2, SEA_LEVEL - 1, HARBOUR.z + a) === B.OAK_LOG, "over the sea");
    }
  }
  assert.ok(h.slots.length >= 4, `${h.slots.length} slots`);
  for (const s of h.slots) {
    assert.ok(IS_WATER[at(Math.floor(s.x), s.y, Math.floor(s.z))], "on water");
    assert.equal(at(Math.floor(s.x), s.y + 1, Math.floor(s.z)), B.AIR, "open above");
    assert.equal(s.yaw, 0, "bows to the open sea (south)");
  }
  let door = 0;
  for (let z = HARBOUR.z - 8; z <= HARBOUR.z; z++) for (let x = HARBOUR.x - 10; x <= HARBOUR.x + 10; x++) if (at(x, SEA_LEVEL + 1, z) >= B.OAK_DOOR && at(x, SEA_LEVEL + 1, z) < B.OAK_DOOR + 16) door++;
  assert.equal(door, 1, "the hut's door");
  assert.ok(g.info.hub.panels.some((p) => p.kind === "harbour" && p.text!.startsWith("Harbour")));
});

test("the same plan builds the same world (what lets every client build it too)", () => {
  const keep = keepTiles([idx(CX + 55, 47, CZ + 10)]);
  const a = generateWorld(DEFAULT_SEED, undefined, { villages: LIVE, hub: { keep, roads: LIVE } });
  const b = generateWorld(DEFAULT_SEED, undefined, { villages: LIVE, hub: { keep, roads: LIVE } });
  assert.equal(hashBlocks(a.blocks), hashBlocks(b.blocks));
  assert.notEqual(hashBlocks(a.blocks), hashBlocks(generateWorld(DEFAULT_SEED, undefined, { villages: LIVE }).blocks), "and a different plan another");
  assert.ok(WORLD_SIZE / TILE === TILES);
});
