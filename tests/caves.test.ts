// Caves and ores (worldgen v2): deterministic, plenty of caves, none under spawn, no cave touches water, ores only
// in stone at their own depths, rarer ores rarer, and the ores behave as blocks (break times, glow).
import { test } from "node:test";
import assert from "node:assert/strict";
import { B, BLOCKS, BREAK_TICKS, EMIT, SOLID } from "../shared/blocks.ts";
import { ORES } from "../shared/caves.ts";
import { DEFAULT_SEED, SEA_LEVEL, SPAWN_X, SPAWN_Z, WORLD_HEIGHT, WORLD_SIZE, idx } from "../shared/constants.ts";
import { generateWorld, hashBlocks } from "../shared/worldgen.ts";
import { ISLANDS, islandReach } from "../shared/islands.ts";

const a = generateWorld(DEFAULT_SEED);
const W = WORLD_SIZE;
const at = (x: number, y: number, z: number) => a.blocks[idx(x, y, z)];

test("worldgen with caves is deterministic (two runs, same hash)", () => {
  const b = generateWorld(DEFAULT_SEED);
  assert.equal(hashBlocks(a.blocks), hashBlocks(b.blocks));
  assert.deepEqual(a.info.caves, b.info.caves);
});

test("there are plenty of caves, a few big chambers and some entrances", () => {
  const c = a.info.caves;
  assert.ok(c.tunnels > 200, `tunnels ${c.tunnels}`);
  assert.ok(c.caverns > 40, `caverns ${c.caverns}`);
  assert.ok(c.carved > 150_000, `carved ${c.carved}`);
  assert.ok(c.entrances > 100, `entrance cells ${c.entrances}`);
});

test("no caves under the spawn plaza", () => {
  // Natural ground only (the sign board stands on posts with air under it; that is not a cave).
  const ground = new Set<number>([B.GRASS, B.DIRT, B.STONE, B.SAND, B.GRAVEL, B.STONE_BRICKS, B.COBBLESTONE]);
  for (let z = SPAWN_Z - 28; z <= SPAWN_Z + 28; z++)
    for (let x = SPAWN_X - 28; x <= SPAWN_X + 28; x++) {
      if (Math.hypot(x - SPAWN_X, z - SPAWN_Z) > 28) continue;
      let top = 0;
      for (let y = a.info.spawnHeight + 1; y > 0; y--)
        if (ground.has(at(x, y, z))) {
          top = y;
          break;
        }
      for (let y = 3; y < top; y++) assert.notEqual(at(x, y, z), B.AIR, `air under spawn at ${x},${y},${z}`);
    }
});

test("no cave air touches water (so no flooded or dripping caves at generation)", () => {
  let bad = 0;
  for (let y = 4; y < SEA_LEVEL; y++)
    for (let z = 1; z < W - 1; z++)
      for (let x = 1; x < W - 1; x++) {
        if (at(x, y, z) !== B.AIR) continue;
        if (at(x + 1, y, z) === B.WATER || at(x - 1, y, z) === B.WATER || at(x, y, z + 1) === B.WATER || at(x, y, z - 1) === B.WATER || at(x, y + 1, z) === B.WATER) bad++;
      }
  assert.equal(bad, 0);
});

test("ores sit only at their depths; every kind exists; diamond is the rarest", () => {
  const count = new Map<number, number>();
  const range = new Map(ORES.map((o) => [o.id, o]));
  // v8: the islands show their ores at the surface on purpose (the Crag's cliffs and sea cave): not counted here
  const island = new Uint8Array(W * W);
  for (const s of ISLANDS) {
    const R = islandReach(s);
    for (let z = s.z - R; z <= s.z + R; z++) for (let x = s.x - R; x <= s.x + R; x++) if (x >= 0 && z >= 0 && x < W && z < W) island[z * W + x] = 1;
  }
  for (let y = 0; y < WORLD_HEIGHT; y++)
    for (let z = 0; z < W; z++)
      for (let x = 0; x < W; x++) {
        if (island[z * W + x] && y >= SEA_LEVEL - 8) continue;
        const id = at(x, y, z);
        const o = range.get(id);
        if (!o) continue;
        count.set(id, (count.get(id) ?? 0) + 1);
        assert.ok(y >= o.minY && y <= o.maxY, `${BLOCKS[id].name} at y ${y}`);
      }
  for (const o of ORES) assert.ok((count.get(o.id) ?? 0) > 500, `${o.key}: ${count.get(o.id)}`);
  const diamonds = count.get(B.DIAMOND_ORE)!;
  for (const o of ORES) if (o.id !== B.DIAMOND_ORE) assert.ok(count.get(o.id)! > diamonds, `${o.key} more common than diamond`);
});

test("ore blocks: solid, a bit slower to break than stone, ruby glows faintly, all placeable", () => {
  for (const o of ORES) {
    assert.ok(SOLID[o.id]);
    assert.ok(BREAK_TICKS[o.id] > BREAK_TICKS[B.STONE]);
    assert.ok(BLOCKS[o.id].placeable);
  }
  assert.equal(EMIT[B.RUBY_ORE], 3);
  assert.equal(EMIT[B.DIAMOND_ORE], 0);
});
