// Leaf decay (server/src/leaves.ts) on a synthetic world: a tree's canopy withers once its trunk is cut, over the next
// seconds to a minute, dropping what leaves drop; a leaf a player put down stays; leaves with a log still in reach
// (another tree's canopy touching it) stay; leaves that were never joined to the cut log through leaves (a hedge)
// are never looked at; a canopy longer than the reach goes all the way, a leaf at a time; and the leaves players
// put down survive a restart, from leaves.json or (a world from before) the edit log.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { B } from "../shared/blocks.ts";
import { VOLUME, WORLD_HEIGHT, WORLD_SIZE, idx } from "../shared/constants.ts";
import { I, type Stack } from "../shared/items.ts";
import { DECAY_MIN, DECAY_SPREAD, LEAF_REACH, LeafDecay } from "../server/src/leaves.ts";

const GROUND = 40;
const world = new Uint8Array(VOLUME);
const get = (x: number, y: number, z: number) => (x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE || y < 0 || y >= WORLD_HEIGHT ? B.AIR : world[idx(x, y, z)]);

function flat(): void {
  world.fill(0);
  for (let y = 0; y <= GROUND; y++) world.fill(y === GROUND ? B.GRASS : B.STONE, idx(0, y, 0), idx(0, y + 1, 0));
}

/** An oak: a trunk `h` high on the ground at (x, z), a canopy of radius 2 round its top three blocks and a cap. */
function oak(x: number, z: number, h = 5, leaves: number = B.OAK_LEAVES, log: number = B.OAK_LOG): number[] {
  const cells: number[] = [];
  for (let k = 1; k <= h; k++) world[idx(x, GROUND + k, z)] = log;
  for (let y = GROUND + h - 2; y <= GROUND + h + 1; y++) {
    const r = y > GROUND + h - 1 ? 1 : 2;
    for (let dx = -r; dx <= r; dx++)
      for (let dz = -r; dz <= r; dz++) {
        const i = idx(x + dx, y, z + dz);
        if (world[i] !== B.AIR) continue;
        world[i] = leaves;
        cells.push(i);
      }
  }
  return cells;
}

/** A leaf manager on the synthetic world: its changes go straight in, drops are kept. */
function setup(dir: string | null = null): { lv: LeafDecay; drops: Stack[] } {
  const drops: Stack[] = [];
  const lv = new LeafDecay(get, { set: (i, id) => (world[i] = id), drop: (st) => drops.push(st) }, dir);
  return { lv, drops };
}

/** Cut a block the way a player does: out of the world, then the manager hears of it. */
function cut(lv: LeafDecay, x: number, y: number, z: number, now: number): void {
  const i = idx(x, y, z);
  const old = world[i];
  world[i] = B.AIR;
  lv.changed(i, old, B.AIR, true, now);
}

/** Run the manager a second at a time for `secs` seconds from `t0`. */
function run(lv: LeafDecay, t0: number, secs: number): void {
  for (let s = 0; s <= secs; s++) lv.tick(t0 + s * 1000);
}

const count = (cells: number[], id?: number) => cells.filter((i) => (id === undefined ? world[i] !== B.AIR : world[i] === id)).length;

test("a felled oak's canopy withers within a minute, dropping saplings, sticks and apples at the usual odds", () => {
  flat();
  const leaves: number[] = [];
  for (let k = 0; k < 40; k++) leaves.push(...oak(20 + (k % 8) * 12, 20 + Math.floor(k / 8) * 12));
  const { lv, drops } = setup();
  let r = 7;
  lv.rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  const t0 = 1_000_000;
  // nothing happens to a standing tree
  run(lv, t0, 5);
  assert.equal(count(leaves), leaves.length, "a standing tree keeps its leaves");
  for (let k = 0; k < 40; k++) for (let y = 1; y <= 5; y++) cut(lv, 20 + (k % 8) * 12, GROUND + y, 20 + Math.floor(k / 8) * 12, t0 + 6000);
  assert.ok(lv.due.size >= leaves.length, `every leaf of the canopies is due a look (${lv.due.size} of ${leaves.length})`);
  // not all at once: a few seconds on, most are still there
  run(lv, t0 + 6000, 4);
  const early = count(leaves);
  assert.ok(early > leaves.length * 0.6 && early < leaves.length, `they go one by one (${early} of ${leaves.length} left after 4 s)`);
  run(lv, t0 + 10000, Math.ceil((DECAY_MIN + DECAY_SPREAD) / 1000) + 20);
  assert.equal(count(leaves), 0, "the whole canopy is gone within a minute");
  assert.equal(lv.due.size, 0, "nothing left to look at");
  const n = (id: number) => drops.filter((d) => d.id === id).reduce((a, d) => a + d.n, 0);
  const saplings = n(B.OAK_SAPLING);
  // 1 in 20 of ~1600 leaves: about 80 saplings
  assert.ok(saplings > leaves.length / 40 && saplings < leaves.length / 10, `saplings at about 1 in 20 (${saplings} from ${leaves.length})`);
  assert.ok(n(I.STICK) > 0 && n(I.APPLE) >= 0, "sticks too (and now and then an apple)");
  assert.equal(lv.stats.decayed, leaves.length);
});

test("a leaf a player put down never decays, and leaves with another trunk in reach stay", () => {
  flat();
  const a = oak(50, 50);
  // a second oak whose canopy touches the first one's
  const b = oak(55, 50);
  // a leaf a player put down on top of the first canopy, joined to it
  const mine = idx(50, GROUND + 7, 50);
  const { lv } = setup();
  world[mine] = B.OAK_LEAVES;
  lv.changed(mine, B.AIR, B.OAK_LEAVES, true, 0);
  const t0 = 2_000_000;
  for (let y = 1; y <= 5; y++) cut(lv, 50, GROUND + y, 50, t0);
  // what still has the second trunk in reach once the first is cut
  const held = a.filter((i) => lv.supported(i & (WORLD_SIZE - 1), Math.floor(i / (WORLD_SIZE * WORLD_SIZE)), Math.floor(i / WORLD_SIZE) & (WORLD_SIZE - 1)));
  run(lv, t0, 3 * Math.ceil((DECAY_MIN + DECAY_SPREAD) / 1000) + 20);
  assert.equal(world[mine], B.OAK_LEAVES, "the leaf the player put down is still there");
  assert.equal(count(b), b.length, "the second oak keeps every leaf");
  // the first oak's leaves within reach of the second trunk (through leaves) stay; the far side goes
  const left = a.filter((i) => world[i] !== B.AIR);
  assert.ok(held.length > 0 && held.length < a.length, `some of the first canopy has the second trunk in reach (${held.length} of ${a.length})`);
  assert.deepEqual(left.sort(), held.sort(), "exactly those are left");
  for (const i of left) assert.ok((i & (WORLD_SIZE - 1)) >= 49, "and they are the side by the second trunk");
});

test("leaves never joined to a cut log are never looked at (a hedge beside a felled tree stays)", () => {
  flat();
  const tree = oak(80, 80);
  // a hedge along the ground 3 blocks from the trunk, not touching the canopy (which starts 3 above the ground)
  const hedge: number[] = [];
  for (let x = 74; x <= 86; x++) {
    const i = idx(x, GROUND + 1, 83);
    world[i] = B.OAK_LEAVES;
    hedge.push(i);
  }
  const { lv } = setup();
  const t0 = 3_000_000;
  for (let y = 1; y <= 5; y++) cut(lv, 80, GROUND + y, 80, t0);
  run(lv, t0, Math.ceil((DECAY_MIN + DECAY_SPREAD) / 1000) + 20);
  assert.equal(count(tree), 0, "the canopy is gone");
  assert.equal(count(hedge), hedge.length, "the hedge is all there");
  // and a hedge leaf broken by hand wakes nothing either
  cut(lv, 80, GROUND + 1, 83, t0 + 70000);
  run(lv, t0 + 70000, Math.ceil((DECAY_MIN + DECAY_SPREAD) / 1000) + 20);
  assert.equal(count(hedge), hedge.length - 1, "the rest of the hedge stays");
});

test("a canopy reaching past the reach goes all the way, and birch leaves go the same", () => {
  flat();
  // a birch with a long arm of leaves out to 12 blocks from the trunk
  const tree = oak(120, 120, 6, B.BIRCH_LEAVES, B.BIRCH_LOG);
  const arm: number[] = [];
  for (let x = 123; x <= 132; x++) {
    const i = idx(x, GROUND + 5, 120);
    if (world[i] === B.AIR) world[i] = B.BIRCH_LEAVES;
    arm.push(i);
  }
  const { lv, drops } = setup();
  const t0 = 4_000_000;
  for (let y = 1; y <= 6; y++) cut(lv, 120, GROUND + y, 120, t0);
  assert.ok(!lv.due.has(idx(132, GROUND + 5, 120)), `the arm's end is past the first look (${LEAF_REACH} from the trunk)`);
  run(lv, t0, 4 * Math.ceil((DECAY_MIN + DECAY_SPREAD) / 1000) + 30);
  assert.equal(count(tree) + count(arm), 0, "the arm went too, a leaf at a time");
  assert.ok(drops.every((d) => d.id !== I.APPLE && d.id !== B.OAK_SAPLING), "a birch drops birch saplings, never apples");
});

test("the leaves players put down survive a restart (leaves.json), and a world from before finds them in its edit log", () => {
  flat();
  const dir = mkdtempSync(join(tmpdir(), "steve-craft-leaves-"));
  try {
    const { lv } = setup(dir);
    const a = idx(150, GROUND + 1, 150);
    world[a] = B.OAK_LEAVES;
    lv.changed(a, B.AIR, B.OAK_LEAVES, true, 0);
    const tree = oak(160, 160);
    const t0 = 5_000_000;
    for (let y = 1; y <= 5; y++) cut(lv, 160, GROUND + y, 160, t0);
    lv.save(t0);
    const back = setup(dir).lv;
    assert.equal(back.load(t0), true);
    assert.ok(back.placed.has(a), "the leaf put down is remembered");
    assert.equal(back.due.size, lv.due.size, "and so are the leaves still to look at");
    run(back, t0, Math.ceil((DECAY_MIN + DECAY_SPREAD) / 1000) + 20);
    assert.equal(count(tree), 0, "the canopy still goes after the restart");
    // no leaves.json: the edit log says who put what down (the last edit of a cell decides; "admin" is the world's own)
    const fresh = setup(null).lv;
    const b = idx(151, GROUND + 1, 150);
    world[b] = B.BIRCH_LEAVES;
    fresh.seed([
      { i: a, n: B.OAK_LEAVES, k: "player-1" },
      { i: b, n: B.BIRCH_LEAVES, k: "admin" },
      { i: idx(152, GROUND + 1, 150), n: B.OAK_LEAVES, k: "player-1" },
      { i: idx(152, GROUND + 1, 150), n: B.AIR, k: "player-1" },
    ], world);
    assert.deepEqual([...fresh.placed], [a]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a world from before leaf decay: the canopies of the trees its players cut go after its first start", () => {
  flat();
  // an oak whose trunk a player cut before this (in the edit log), its canopy still hanging; and a hedge nearby
  const canopy = oak(200, 200);
  const trunk = [1, 2, 3, 4, 5].map((y) => idx(200, GROUND + y, 200));
  for (const i of trunk) world[i] = B.AIR;
  const hedge = idx(196, GROUND + 1, 200);
  world[hedge] = B.OAK_LEAVES;
  const { lv } = setup(null);
  const t0 = 6_000_000;
  const woken = lv.seed(trunk.map((i) => ({ i, o: B.OAK_LOG, n: B.AIR, k: "player-2" })), world, t0);
  assert.ok(woken >= canopy.length * 0.9, `the old canopy is woken (${woken} of ${canopy.length})`);
  run(lv, t0, Math.ceil((DECAY_MIN + DECAY_SPREAD) / 1000) + 20);
  assert.equal(count(canopy), 0, "and it's gone within a minute");
  assert.equal(world[hedge], B.OAK_LEAVES, "the hedge is still there");
});
