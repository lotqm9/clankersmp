// The islands (protocol v8, update 10): stamped into open ocean only, so the live world needs no reset (everything
// outside them is bit for bit the terrain players have built on, hash 898d2920); each one is out at sea with its own
// character: Palm Cay's palms, the Crag's ores and its sea cave with diamonds, Old Keep's ruin and treasure chest,
// Bluebell Isle's bluebells, clay pond and cane; clay in the shallows; deterministic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { B, IS_WATER } from "../shared/blocks.ts";
import { DEFAULT_SEED, SEA_LEVEL, WORLD_SIZE as W, cellX, cellZ, idx } from "../shared/constants.ts";
import { ISLANDS, islandReach } from "../shared/islands.ts";
import { generateWorld, hashBlocks } from "../shared/worldgen.ts";

// (v9, v10: without the villages and the bigger hub, which have their own tests: these compare the islands alone)
const plain = generateWorld(DEFAULT_SEED, undefined, { islands: false, villages: [], hub: false });
const world = generateWorld(DEFAULT_SEED, undefined, { villages: [], hub: false });
const a = plain.blocks;
const b = world.blocks;
const at = (x: number, y: number, z: number) => b[idx(x, y, z)];
const isle = (key: string) => ISLANDS.find((s) => s.key === key)!;
/** Every cell of an island's reach, as [x, y, z, id]. */
function* cells(key: string, y0 = 0, y1 = 127): Generator<[number, number, number, number]> {
  const s = isle(key);
  const R = islandReach(s);
  for (let z = Math.max(0, s.z - R); z <= Math.min(W - 1, s.z + R); z++)
    for (let x = Math.max(0, s.x - R); x <= Math.min(W - 1, s.x + R); x++) for (let y = y0; y <= y1; y++) yield [x, y, z, at(x, y, z)];
}
const count = (key: string, id: number, y0 = 0, y1 = 127) => {
  let n = 0;
  for (const c of cells(key, y0, y1)) if (c[3] === id) n++;
  return n;
};

test("without the islands the world is exactly the plain terrain (3c43755e): nothing on the main island changed", () => {
  assert.equal(hashBlocks(a).toString(16), "3c43755e");
});

test("the islands only touch open ocean, inside their own reach; generating twice gives the same world", () => {
  let changed = 0;
  const cols = new Set<number>();
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    changed++;
    cols.add(cellZ(i) * W + cellX(i));
  }
  assert.ok(changed > 50_000, `${changed} cells`);
  for (const c of cols) {
    const x = c % W;
    const z = Math.floor(c / W);
    assert.ok(a[idx(x, SEA_LEVEL - 1, z)] === B.WATER && a[idx(x, SEA_LEVEL, z)] === B.AIR, `column ${x},${z} was open sea`);
    assert.ok(ISLANDS.some((s) => (x - s.x) ** 2 + (z - s.z) ** 2 <= islandReach(s) ** 2), `column ${x},${z} in an island's reach`);
  }
  assert.equal(hashBlocks(generateWorld(DEFAULT_SEED, undefined, { villages: [], hub: false }).blocks), hashBlocks(b));
});

test("each island rises out of the sea, well away from the main island (worth the row)", () => {
  // land columns of the main island (before the islands)
  const land: [number, number][] = [];
  for (let z = 0; z < W; z += 3) for (let x = 0; x < W; x += 3) if (a[idx(x, SEA_LEVEL - 1, z)] !== B.WATER) land.push([x, z]);
  for (const s of ISLANDS) {
    let top = 0;
    let near = 1e9;
    for (let z = s.z - s.r; z <= s.z + s.r; z++)
      for (let x = s.x - s.r; x <= s.x + s.r; x++) {
        if (x < 0 || z < 0 || x >= W || z >= W) continue;
        if (at(x, SEA_LEVEL, z) === B.AIR || IS_WATER[at(x, SEA_LEVEL, z)]) continue;
        let y = SEA_LEVEL;
        while (y < 120 && at(x, y + 1, z) !== B.AIR) y++;
        top = Math.max(top, y);
        for (const [lx, lz] of land) near = Math.min(near, Math.hypot(lx - x, lz - z));
      }
    assert.ok(top >= SEA_LEVEL + 1, `${s.name} stands out of the water (top ${top})`);
    assert.ok(near >= 20, `${s.name} is ${near.toFixed(0)} blocks of sea from the main island`);
  }
});

test("Palm Cay: sand and palms (ringed trunks, frond crowns); the Sandbar has its two", () => {
  const trunks = (key: string) => {
    let n = 0;
    for (const [x, y, z, id] of cells(key, SEA_LEVEL, 70)) if (id === B.PALM_LOG && at(x, y - 1, z) !== B.PALM_LOG && at(x - 1, y - 1, z) !== B.PALM_LOG && at(x + 1, y - 1, z) !== B.PALM_LOG && at(x, y - 1, z - 1) !== B.PALM_LOG && at(x, y - 1, z + 1) !== B.PALM_LOG) n++;
    return n;
  };
  assert.ok(trunks("palm_cay") >= 6, `palms on Palm Cay: ${trunks("palm_cay")}`);
  assert.ok(count("palm_cay", B.PALM_LEAVES) > 100);
  assert.ok(count("palm_cay", B.SAND) > 500);
  assert.equal(trunks("the_sandbar"), 2);
});

test("the Crag: coal, iron, gold and ruby showing in its cliffs, and a sea cave you can row into with diamonds at the back", () => {
  const exposed = (id: number) => {
    let n = 0;
    for (const [x, y, z, c] of cells("the_crag", SEA_LEVEL - 2, 100)) {
      if (c !== id) continue;
      if ([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => at(x + dx, y + dy, z + dz) === B.AIR)) n++;
    }
    return n;
  };
  for (const id of [B.COAL_ORE, B.IRON_ORE, B.GOLD_ORE, B.RUBY_ORE]) assert.ok(exposed(id) > 0, `ore ${id} can be seen`);
  assert.ok(count("the_crag", B.COAL_ORE) > 30 && count("the_crag", B.IRON_ORE) > 15);
  const s = isle("the_crag");
  // the cave: water at sea level with air over it, running from the east shore in toward the middle
  let run = 0;
  for (let x = s.x + 4; x < s.x + s.r; x++) if (IS_WATER[at(x, SEA_LEVEL - 1, s.z)] && at(x, SEA_LEVEL + 1, s.z) === B.AIR) run++;
  assert.ok(run >= 6, `a sea cave ${run} blocks long`);
  assert.ok(count("the_crag", B.DIAMOND_ORE, SEA_LEVEL - 1, SEA_LEVEL + 3) >= 3, "diamonds at the back of the cave");
});

test("Old Keep: a ruined keep of mossy stone on the hill, and its treasure chest (in the world info for the server)", () => {
  assert.equal(world.info.islands.chests.length, 1);
  const c = world.info.islands.chests[0];
  assert.equal(c.island, "old_keep");
  assert.ok(at(c.x, c.y, c.z) >= B.CHEST && at(c.x, c.y, c.z) < B.CHEST + 4, "a chest is there");
  assert.ok(count("old_keep", B.MOSSY_STONE_BRICKS) + count("old_keep", B.MOSSY_COBBLE) >= 20, "mossy walls");
  assert.ok(count("old_keep", B.STONE_BRICKS) >= 30);
  assert.ok(count("old_keep", B.OAK_LOG) >= 8, "trees on the slopes");
});

test("Bluebell Isle: drifts of bluebells (the blue for dyes), a pond on a clay bed with sugar cane, clay in the shallows", () => {
  assert.ok(count("bluebell_isle", B.BLUEBELL) >= 60, `bluebells: ${count("bluebell_isle", B.BLUEBELL)}`);
  assert.ok(count("bluebell_isle", B.SUGAR_CANE) >= 2);
  assert.ok(count("bluebell_isle", B.CLAY) >= 20);
  let total = 0;
  for (const s of ISLANDS) total += count(s.key, B.CLAY);
  assert.ok(total >= 200, `clay around the sandy isles: ${total}`);
});
