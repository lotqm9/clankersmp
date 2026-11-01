// Mining (protocol v5): how long a block takes to break with what you hold, whether it drops anything, and what.
// Java Edition's rules: each block has a hardness, a preferred tool and (for stone-like blocks) a tool it needs.
//   speed  = the tool's speed if it is the block's tool, else 1; / 5 under water; / 5 in the air
//   damage = speed / hardness / (can harvest ? 30 : 100) per tick; ticks = ceil(1 / damage) (instant if damage > 1)
// Without the right tool a "needs a tool" block still breaks (slowly) but drops nothing: stone by hand, iron ore
// with a wooden pickaxe. Shared by the client (dig prediction and the crack animation) and the server (checks and
// drops), so both always agree.

import { B, BLOCKS, isCake, isPot, isWheat, pottedFlower, wheatAge } from "./blocks.ts";
import { I, itemDef, itemOfBlock, type Stack, type ToolKind } from "./items.ts";
import { isBed, isDoor, slabBase, stairBase } from "./shapes.ts";

export interface MineInfo {
  hardness: number; // -1 unbreakable
  tool: ToolKind | null; // the tool that speeds it up
  needs: number; // harvest tier needed for drops (0 = anything, 1 wood, 2 stone, 3 iron)
}

const INFO: MineInfo[] = [];
const set = (ids: number[], hardness: number, tool: ToolKind | null, needs = 0) => {
  for (const id of ids) INFO[id] = { hardness, tool, needs };
};
const range = (from: number, n: number) => Array.from({ length: n }, (_, k) => from + k);

set([B.AIR], -1, null);
set([B.GRASS], 0.6, "shovel");
set([B.DIRT, B.SAND], 0.5, "shovel");
set([B.GRAVEL], 0.6, "shovel");
set([B.STONE, B.STONE_BRICKS, ...range(B.STONE_BRICK_STAIRS, 8), ...range(B.STONE_BRICK_SLAB, 2), ...range(B.STONE_SLAB, 2)], 1.5, "pickaxe", 1);
set([B.COBBLESTONE, B.BRICKS, ...range(B.COBBLE_STAIRS, 8), ...range(B.BRICK_STAIRS, 8), ...range(B.COBBLE_SLAB, 2), ...range(B.BRICK_SLAB, 2)], 2, "pickaxe", 1);
set([B.OAK_LOG, B.BIRCH_LOG, B.OAK_PLANKS, B.BIRCH_PLANKS, B.OAK_FENCE, ...range(B.OAK_STAIRS, 8), ...range(B.OAK_SLAB, 2)], 2, "axe");
set([B.OAK_LEAVES, B.BIRCH_LEAVES], 0.2, null);
set([B.GLASS, B.GLASS_PANE, B.LAMP], 0.3, null);
set([B.WOOL_WHITE, B.WOOL_RED, B.WOOL_ORANGE, B.WOOL_YELLOW, B.WOOL_LIME, B.WOOL_BLUE, B.WOOL_PURPLE, B.WOOL_BLACK, B.WOOL_CYAN, B.WOOL_PINK], 0.8, null);
set([B.TORCH, B.TALL_GRASS, B.DANDELION, B.POPPY, B.OAK_SAPLING, B.BIRCH_SAPLING], 0, null);
set([B.BEDROCK], -1, null);
set(range(B.OAK_DOOR, 16), 3, "axe");
set(range(B.LADDER, 4), 0.4, "axe");
set(range(B.RED_BED, 8), 0.2, null);
set([B.SMOOTH_TEAL, B.SMOOTH_BLUE, B.SMOOTH_TAN], 1.5, "pickaxe", 1);
set([B.COAL_ORE], 3, "pickaxe", 1);
set([B.IRON_ORE], 3, "pickaxe", 2);
set([B.GOLD_ORE, B.DIAMOND_ORE, B.RUBY_ORE], 3, "pickaxe", 3);
set(range(B.WATER_FLOW, 7).concat([B.WATER, B.WATER_FALL]), -1, null);
set([B.CRAFTING_TABLE], 2.5, "axe");
set(range(B.CHEST, 4), 2.5, "axe");
set(range(B.FURNACE, 8), 3.5, "pickaxe", 1);
set([B.COAL_BLOCK], 5, "pickaxe", 1);
set([B.IRON_BLOCK], 5, "pickaxe", 2);
set([B.GOLD_BLOCK, B.DIAMOND_BLOCK, B.RUBY_BLOCK], 5, "pickaxe", 3);
// v7
set([B.FARMLAND, B.FARMLAND + 1], 0.6, "shovel");
set([...range(B.WHEAT, 8), B.SUGAR_CANE], 0, null);
set(range(B.CAKE, 7), 0.5, null);
// v8
set([B.COBBLE_WALL, B.MOSSY_COBBLE], 2, "pickaxe", 1);
set([B.STONE_BRICK_WALL, B.MOSSY_STONE_BRICKS], 1.5, "pickaxe", 1);
set([B.CLAY], 0.6, "shovel");
set(range(B.TERRACOTTA, 6), 1.25, "pickaxe", 1);
set([B.WOOL_BROWN, B.WOOL_GREEN, B.WOOL_GREY, B.WOOL_LIGHT_BLUE], 0.8, null);
set([B.DIRT_PATH], 0.65, "shovel");
set(range(B.LANTERN, 2), 3.5, "pickaxe");
set([B.BARREL], 2.5, "axe");
set([B.BOOKSHELF], 1.5, "axe");
set([B.HAY_BALE], 0.5, "hoe");
set(range(B.FLOWER_POT, 4), 0, null);
set([B.VILLAGE_CHIME, B.PALM_LOG, B.BIRCH_FENCE, ...range(B.OAK_GATE, 8), ...range(B.BIRCH_STAIRS, 8), ...range(B.BIRCH_SLAB, 2)], 2, "axe");
set(range(B.TRAPDOOR, 16), 3, "axe");
set([B.BLUEBELL], 0, null);
set([B.PALM_LEAVES], 0.2, null);
for (const b of BLOCKS) if (!INFO[b.id]) INFO[b.id] = { hardness: 1, tool: null, needs: 0 };

export function mineInfo(block: number): MineInfo {
  return INFO[block] ?? { hardness: -1, tool: null, needs: 0 };
}

/** Can the held item harvest this block (get its drops)? */
export function canHarvest(block: number, held: number): boolean {
  const m = mineInfo(block);
  if (m.needs === 0) return true;
  const t = itemDef(held)?.tool;
  return !!t && t.kind === m.tool && t.tier >= m.needs;
}

/** Ticks to break `block` holding `held` (0 = instant, -1 = never). */
export function breakTicks(block: number, held: number, inWater = false, onGround = true): number {
  const m = mineInfo(block);
  if (m.hardness < 0) return -1;
  if (m.hardness === 0) return 0;
  const t = itemDef(held)?.tool;
  let speed = 1;
  if (t && t.kind === m.tool) speed = t.speed;
  if (t && t.kind === "sword" && (block === B.OAK_LEAVES || block === B.BIRCH_LEAVES || block === B.PALM_LEAVES)) speed = 1.5;
  if (inWater) speed /= 5;
  if (!onGround) speed /= 5;
  const damage = speed / m.hardness / (canHarvest(block, held) ? 30 : 100);
  if (damage >= 1) return 0;
  return Math.ceil(1 / damage);
}

/** A random source in [0, 1): the server passes Math.random, tests a seeded one. */
export type Rand = () => number;

/** What breaking `block` with `held` drops (empty when it needs a tool you don't have). */
export function blockDrops(block: number, held: number, rand: Rand): Stack[] {
  if (!canHarvest(block, held)) return [];
  const one = (id: number, n = 1): Stack[] => (id ? [{ id, n, d: 0 }] : []);
  switch (block) {
    case B.GRASS:
      return one(B.DIRT);
    case B.STONE:
      return one(B.COBBLESTONE);
    case B.COAL_ORE:
      return one(I.COAL);
    case B.IRON_ORE:
      return one(I.RAW_IRON);
    case B.GOLD_ORE:
      return one(I.RAW_GOLD);
    case B.DIAMOND_ORE:
      return one(I.DIAMOND);
    case B.RUBY_ORE:
      return one(I.RUBY, rand() < 0.3 ? 2 : 1);
    case B.GLASS:
    case B.GLASS_PANE:
      return [];
    case B.TALL_GRASS:
      // v7: now and then a seed (1 in 8, like the classic game)
      return rand() < 0.125 ? one(I.WHEAT_SEEDS) : [];
    case B.GRAVEL:
      // v7: flint 1 time in 10, else the gravel itself
      return rand() < 0.1 ? one(I.FLINT) : one(B.GRAVEL);
    case B.OAK_LEAVES:
    case B.BIRCH_LEAVES: {
      // Java-like odds: a sapling 1 in 20, sticks 1 in 50, an apple 1 in 200 (oak only).
      const out: Stack[] = [];
      if (rand() < 0.05) out.push({ id: block === B.OAK_LEAVES ? B.OAK_SAPLING : B.BIRCH_SAPLING, n: 1, d: 0 });
      if (rand() < 0.02) out.push({ id: I.STICK, n: rand() < 0.5 ? 1 : 2, d: 0 });
      if (block === B.OAK_LEAVES && rand() < 0.005) out.push({ id: I.APPLE, n: 1, d: 0 });
      return out;
    }
    // v8
    case B.PALM_LEAVES: {
      // palms grow no saplings here: now and then a stick, and coconuts (1 in 10)
      const out: Stack[] = [];
      if (rand() < 0.02) out.push({ id: I.STICK, n: 1, d: 0 });
      if (rand() < 0.1) out.push({ id: I.COCONUT, n: 1, d: 0 });
      return out;
    }
    case B.CLAY:
      return one(I.CLAY_BALL, 4);
    case B.DIRT_PATH:
      return one(B.DIRT);
  }
  if (isPot(block)) return [...one(B.FLOWER_POT), ...one(pottedFlower(block))]; // the pot, and the flower in it
  if (isWheat(block)) {
    // ripe: the wheat and 1-4 seeds (Java's odds); not yet: the seed back
    if (wheatAge(block) < 7) return one(I.WHEAT_SEEDS);
    let seeds = 1;
    for (let k = 0; k < 3; k++) if (rand() < 0.5714) seeds++;
    return [...one(I.WHEAT), ...one(I.WHEAT_SEEDS, seeds)];
  }
  if (isCake(block)) return []; // a cake is eaten, not picked up
  if (isDoor(block)) return one(B.OAK_DOOR); // the server breaks both halves and asks for one drop
  if (isBed(block)) return one(B.RED_BED);
  const sl = slabBase(block);
  if (sl >= 0) return one(sl);
  const st = stairBase(block);
  if (st >= 0) return one(st);
  return one(itemOfBlock(block));
}

/** Tool wear: 1 per block with hardness > 0 (2 for swords), 0 for instant blocks. */
export function toolWearForBlock(block: number, held: number): number {
  const t = itemDef(held)?.tool;
  if (!t) return 0;
  if (mineInfo(block).hardness <= 0) return 0;
  return t.kind === "sword" ? 2 : 1;
}
