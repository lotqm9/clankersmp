// The world update's building blocks (protocol v8, update 10): the registry (ids 159-222, u8-safe, textures within
// the 256 layers a GPU promises), how every new block is had in survival (a recipe, smelting or the islands), mining
// and drops, the shapes (walls, gates, trapdoors, lanterns, pots, the path, the chime), placement and support rules,
// opening and closing, and the recipes: every recipe in the game crafts from its own book layout (no two recipes
// fight over a grid), oak and birch pieces from their own planks, and colours from flowers, saplings, coal and bone
// meal (eight around one; two wools mix).
import { test } from "node:test";
import assert from "node:assert/strict";
import { B, BLOCKS, NEXT_FREE_BLOCK, OPAQUE, PICKER_ORDER, SHAPE, SOLID, TEX, TEX_LAYERS, isPot, potFor, pottedFlower } from "../shared/blocks.ts";
import { I, ITEMS, SMELT, fuelTicks, itemDef, maxStack } from "../shared/items.ts";
import { blockDrops, breakTicks, canHarvest, mineInfo } from "../shared/mining.ts";
import { RECIPES, layoutFor, matchRecipe, recipeNeeds } from "../shared/recipes.ts";
import {
  breakChanges, collisionBoxes16, gate, gateId, isOpen, itemBoxes, pathBreaksUnder, pickBoxes16, placeChanges, placementState, renderBoxes, toggleOpenable, trapdoor, trapdoorId, type Nb,
} from "../shared/shapes.ts";
import { buildTextureLayers } from "../shared/textures.ts";
import { generateWorld } from "../shared/worldgen.ts";
import { DEFAULT_SEED, idx } from "../shared/constants.ts";

const NEW = Array.from({ length: NEXT_FREE_BLOCK - B.COBBLE_WALL }, (_, k) => B.COBBLE_WALL + k);

test("v8 ids: 159-222 in order, all valid, the mesher's 255 left alone; textures fit the 256 layers; the picker has them", () => {
  assert.equal(BLOCKS.length, NEXT_FREE_BLOCK);
  assert.equal(NEXT_FREE_BLOCK, 225); // v13: obsidian, the enchanting table
  assert.ok(NEXT_FREE_BLOCK <= 255, "255 is the mesher's 'outside the world'");
  for (const id of NEW) {
    assert.equal(BLOCKS[id].id, id);
    assert.ok(BLOCKS[id].key && BLOCKS[id].name, `block ${id} named`);
  }
  assert.ok(TEX_LAYERS <= 256, `${TEX_LAYERS} texture layers`);
  const layers = buildTextureLayers();
  assert.equal(layers.length, TEX_LAYERS);
  for (let l = TEX.mossy_cobblestone; l < TEX_LAYERS; l++) {
    let opaque = 0;
    for (let k = 3; k < layers[l].length; k += 4) if (layers[l][k] > 0) opaque++;
    assert.ok(opaque > 20, `layer ${l} has art`);
  }
  for (const id of NEW) if (BLOCKS[id].placeable) assert.ok(PICKER_ORDER.includes(id), `${BLOCKS[id].name} in the creative picker`);
});

test("every new block (and item) can be had in survival: a recipe, the furnace, or the islands", () => {
  const made = new Set(RECIPES.map((r) => r.out.id));
  const smelted = new Set(Object.values(SMELT));
  const world = generateWorld(DEFAULT_SEED).blocks;
  const inWorld = new Set<number>();
  for (let i = 0; i < world.length; i++) if (world[i] >= B.COBBLE_WALL) inWorld.add(world[i]);
  const madeOtherwise = new Set<number>([B.DIRT_PATH, B.OBSIDIAN]); // a shovel on grass; v13: the smith's lava poured onto water
  for (const id of NEW) {
    if (!BLOCKS[id].placeable || BLOCKS[id].item !== id) continue;
    if (id === B.PALM_LEAVES) continue; // like the other leaves: they drop things, not themselves
    assert.ok(made.has(id) || smelted.has(id) || inWorld.has(id) || madeOtherwise.has(id), `${BLOCKS[id].name} obtainable`);
  }
  for (const id of [I.BOAT, I.BRICK, I.CLAY_BALL, I.COCONUT]) assert.ok(made.has(id) || smelted.has(id) || id === I.COCONUT || id === I.CLAY_BALL, `${itemDef(id)!.name}`);
  // the islands grow what the recipes need: bluebells (blue), clay (bricks, terracotta), palms
  for (const id of [B.BLUEBELL, B.CLAY, B.PALM_LOG, B.PALM_LEAVES, B.MOSSY_STONE_BRICKS, B.MOSSY_COBBLE]) assert.ok(inWorld.has(id), `${BLOCKS[id].name} in the world`);
  // bricks were not obtainable before v8: now clay balls fire into bricks
  assert.equal(SMELT[I.CLAY_BALL], I.BRICK);
  assert.equal(SMELT[B.CLAY], B.TERRACOTTA);
  assert.equal(SMELT[B.PALM_LOG], I.CHARCOAL);
});

test("items: the boat (one to a stack, burns a minute), clay balls, bricks, coconuts (food)", () => {
  assert.equal(maxStack(I.BOAT), 1);
  assert.equal(fuelTicks(I.BOAT), 1200);
  assert.deepEqual(itemDef(I.COCONUT)!.food, { hunger: 4, sat: 2.4 });
  assert.equal(maxStack(I.BRICK), 64);
  assert.ok(fuelTicks(B.BARREL) > 0 && fuelTicks(B.BIRCH_SLAB) === 150 && fuelTicks(B.OAK_GATE) > 0);
  assert.equal(fuelTicks(B.LANTERN), 0);
  for (const it of ITEMS) if (it && it.tex >= 0) assert.ok(it.tex < TEX_LAYERS, `${it.name} sprite`);
});

test("mining and drops: clay gives 4 balls, a path dirt, a potted plant its pot and flower, palms coconuts; walls need a pickaxe", () => {
  const r = () => 0.01; // every chance hits
  assert.deepEqual(blockDrops(B.CLAY, 0, r), [{ id: I.CLAY_BALL, n: 4, d: 0 }]);
  assert.deepEqual(blockDrops(B.DIRT_PATH, 0, r), [{ id: B.DIRT, n: 1, d: 0 }]);
  assert.deepEqual(blockDrops(B.FLOWER_POT + 3, 0, r), [{ id: B.FLOWER_POT, n: 1, d: 0 }, { id: B.BLUEBELL, n: 1, d: 0 }]);
  assert.deepEqual(blockDrops(B.FLOWER_POT, 0, r), [{ id: B.FLOWER_POT, n: 1, d: 0 }]);
  assert.deepEqual(blockDrops(B.PALM_LEAVES, 0, r).map((s) => s.id).sort(), [I.STICK, I.COCONUT].sort());
  assert.deepEqual(blockDrops(B.PALM_LEAVES, 0, () => 0.99), []);
  assert.deepEqual(blockDrops(B.LANTERN + 1, 0, r), [{ id: B.LANTERN, n: 1, d: 0 }]);
  assert.deepEqual(blockDrops(gateId(3, true), 0, r), [{ id: B.OAK_GATE, n: 1, d: 0 }]);
  assert.deepEqual(blockDrops(trapdoorId(2, true, true), 0, r), [{ id: B.TRAPDOOR, n: 1, d: 0 }]);
  assert.deepEqual(blockDrops(B.BIRCH_STAIRS + 6, 0, r), [{ id: B.BIRCH_STAIRS, n: 1, d: 0 }]);
  assert.deepEqual(blockDrops(B.BIRCH_SLAB + 1, 0, r), [{ id: B.BIRCH_SLAB, n: 1, d: 0 }]);
  assert.deepEqual(blockDrops(B.COBBLE_WALL, 0, r), [], "a wall by hand drops nothing (stone needs a pickaxe)");
  assert.deepEqual(blockDrops(B.COBBLE_WALL, 300, r), [{ id: B.COBBLE_WALL, n: 1, d: 0 }]); // a wooden pickaxe
  assert.ok(canHarvest(B.TERRACOTTA + 4, 300) && !canHarvest(B.TERRACOTTA + 4, 0));
  assert.equal(mineInfo(B.HAY_BALE).tool, "hoe");
  assert.equal(breakTicks(B.FLOWER_POT, 0), 0);
  assert.equal(breakTicks(B.BLUEBELL, 0), 0);
  for (const id of NEW) assert.ok(mineInfo(id).hardness >= 0, `${BLOCKS[id].name} breakable`);
});

/** A neighbour getter from a small map of placed blocks around (0, 0, 0). */
function around(cells: Record<string, number>): Nb {
  return (dx, dy, dz) => cells[`${dx},${dy},${dz}`] ?? B.AIR;
}

test("walls join walls, solid blocks and gates on their axis; a straight run has no post; 1.5 tall to jump", () => {
  const none = collisionBoxes16(B.COBBLE_WALL, around({}));
  assert.equal(none.length, 1);
  assert.equal(none[0][4], 24, "a wall is 1.5 blocks tall for collision");
  const run = around({ "0,0,-1": B.COBBLE_WALL, "0,0,1": B.STONE_BRICK_WALL });
  assert.equal(collisionBoxes16(B.COBBLE_WALL, run).length, 3);
  assert.deepEqual(renderBoxes(B.COBBLE_WALL, run).map((b) => b.b), [[5, 0, 0, 11, 14, 16]], "a straight run: no post");
  const corner = around({ "0,0,-1": B.COBBLE_WALL, "1,0,0": B.STONE });
  assert.equal(renderBoxes(B.COBBLE_WALL, corner).length, 3, "post + two arms");
  // a gate facing north runs along x: it joins the walls east and west of it, not north and south
  assert.equal(collisionBoxes16(B.COBBLE_WALL, around({ "1,0,0": gateId(0, false) })).length, 2);
  assert.equal(collisionBoxes16(B.COBBLE_WALL, around({ "0,0,1": gateId(0, false) })).length, 1);
  // fences too
  assert.equal(collisionBoxes16(B.OAK_FENCE, around({ "-1,0,0": gateId(2, true) })).length, 2);
  assert.equal(collisionBoxes16(B.BIRCH_FENCE, around({ "0,0,-1": gateId(2, false) })).length, 1);
  assert.equal(collisionBoxes16(B.BIRCH_FENCE, around({ "0,0,-1": B.OAK_FENCE })).length, 2, "oak and birch fences join");
  // a wall with something solid on top is full height
  assert.equal(renderBoxes(B.COBBLE_WALL, around({ "0,1,0": B.STONE, "0,0,-1": B.COBBLE_WALL, "0,0,1": B.COBBLE_WALL }))[0].b[4], 16);
});

test("gates: closed they block like a fence (1.5 tall), open nothing; they open away from you and pick by their posts", () => {
  const closed = collisionBoxes16(gateId(0, false), around({}));
  assert.deepEqual(closed, [[0, 0, 6, 16, 24, 10]]);
  assert.deepEqual(collisionBoxes16(gateId(1, false), around({})), [[6, 0, 0, 10, 24, 16]]);
  assert.deepEqual(collisionBoxes16(gateId(0, true), around({})), []);
  assert.ok(pickBoxes16(gateId(0, true), around({})).length >= 2, "an open gate can still be picked (its posts)");
  // placing: it faces the way you look (yaw 180 = north)
  assert.equal(placementState(B.OAK_GATE, 180, { x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, fy: 1 }), gateId(0, false));
  // opened from the south side (looking north) it swings north; from the north side (looking south) it turns around
  const at = (id: number) => (x: number, y: number, z: number) => (x === 5 && y === 5 && z === 5 ? id : B.AIR);
  assert.deepEqual(toggleOpenable(5, 5, 5, 180, at(gateId(0, false))), [[5, 5, 5, gateId(0, true)]]);
  assert.deepEqual(toggleOpenable(5, 5, 5, 0, at(gateId(0, false))), [[5, 5, 5, gateId(2, true)]]);
  assert.deepEqual(toggleOpenable(5, 5, 5, 0, at(gateId(2, true))), [[5, 5, 5, gateId(2, false)]]);
  assert.ok(isOpen(gateId(1, true)) && !isOpen(gateId(1, false)));
  assert.equal(gate(gateId(3, true)).facing, 3);
});

test("trapdoors: hinged on the wall you click (top or bottom half by where), or on the far side of a floor; they flip open", () => {
  // the north face of a block (normal -z), clicked high: facing north, top half
  const side = placementState(B.TRAPDOOR, 0, { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: -1, fy: 0.7 })!;
  assert.deepEqual(trapdoor(side), { facing: 0, open: false, top: true });
  // on a floor while looking north: hinged on the far (north) side, so it opens away from you
  const floor = placementState(B.TRAPDOOR, 180, { x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, fy: 1 })!;
  assert.deepEqual(trapdoor(floor), { facing: 2, open: false, top: false });
  // under a ceiling: the top half
  assert.equal(trapdoor(placementState(B.TRAPDOOR, 180, { x: 0, y: 0, z: 0, nx: 0, ny: -1, nz: 0, fy: 0 })!).top, true);
  assert.deepEqual(collisionBoxes16(trapdoorId(0, false, false), around({})), [[0, 0, 0, 16, 3, 16]]);
  assert.deepEqual(collisionBoxes16(trapdoorId(0, false, true), around({})), [[0, 13, 0, 16, 16, 16]]);
  assert.deepEqual(collisionBoxes16(trapdoorId(0, true, false), around({})), [[0, 0, 13, 16, 16, 16]], "open, against the wall it was hung on");
  const at = (x: number, y: number, z: number) => (x === 1 && y === 1 && z === 1 ? trapdoorId(1, false, true) : B.AIR);
  assert.deepEqual(toggleOpenable(1, 1, 1, 90, at), [[1, 1, 1, trapdoorId(1, true, true)]]);
});

test("lanterns stand on blocks or hang under them (and fall when that block goes); pots stand; a block on a path makes it dirt", () => {
  // a world: stone at y 10, air above; a plank ceiling at y 14 over (5, 13, 5)
  const cells = new Map<number, number>();
  const get = (x: number, y: number, z: number) => cells.get(idx(x, y, z)) ?? (y <= 10 ? B.STONE : B.AIR);
  cells.set(idx(5, 14, 5), B.OAK_PLANKS);
  assert.equal(placementState(B.LANTERN, 0, { x: 5, y: 14, z: 5, nx: 0, ny: -1, nz: 0, fy: 0 }), B.LANTERN + 1, "clicked under a block: it hangs");
  assert.deepEqual(placeChanges(B.LANTERN + 1, 5, 13, 5, get), [[5, 13, 5, B.LANTERN + 1]]);
  assert.deepEqual(placeChanges(B.LANTERN, 5, 11, 5, get), [[5, 11, 5, B.LANTERN]]);
  // nothing below but a ceiling above: it hangs instead; nothing either way: no lantern
  assert.deepEqual(placeChanges(B.LANTERN, 5, 13, 5, get), [[5, 13, 5, B.LANTERN + 1]]);
  assert.equal(placeChanges(B.LANTERN, 9, 13, 9, get), null);
  // the ceiling goes: the hanging lantern falls with it
  cells.set(idx(5, 13, 5), B.LANTERN + 1);
  const ch = breakChanges(5, 14, 5, get);
  assert.ok(ch.some(([x, y, z, id]) => x === 5 && y === 13 && z === 5 && id === B.AIR), "the lantern drops");
  // pots need something under them
  assert.equal(placeChanges(B.FLOWER_POT, 9, 13, 9, get), null);
  assert.deepEqual(placeChanges(B.FLOWER_POT, 9, 11, 9, get), [[9, 11, 9, B.FLOWER_POT]]);
  // flowers in pots
  assert.equal(potFor(B.POPPY), B.FLOWER_POT + 1);
  assert.equal(potFor(B.BLUEBELL), B.FLOWER_POT + 3);
  assert.equal(potFor(B.TALL_GRASS), -1);
  assert.equal(pottedFlower(B.FLOWER_POT + 2), B.DANDELION);
  assert.ok(isPot(B.FLOWER_POT + 3) && !isPot(B.VILLAGE_CHIME));
  // the path: a pixel low; full blocks on it press it into dirt, slabs and gates don't
  assert.deepEqual(collisionBoxes16(B.DIRT_PATH, around({})), [[0, 0, 0, 16, 15, 16]]);
  assert.ok(pathBreaksUnder(B.STONE) && !pathBreaksUnder(B.OAK_SLAB) && !pathBreaksUnder(gateId(0, false)) && !pathBreaksUnder(B.LANTERN));
  // shapes worth a glance
  assert.equal(SHAPE[B.VILLAGE_CHIME], 2);
  assert.ok(SOLID[B.LANTERN] && !OPAQUE[B.LANTERN] && BLOCKS[B.LANTERN].light === 15);
  assert.ok(renderBoxes(B.VILLAGE_CHIME, around({})).length >= 10, "the chime: base, posts, roof, beam, tubes");
  for (const id of [B.COBBLE_WALL, B.OAK_GATE, B.TRAPDOOR, B.LANTERN, B.FLOWER_POT, B.VILLAGE_CHIME, B.BIRCH_STAIRS, B.BIRCH_FENCE, B.DIRT_PATH]) {
    assert.ok((itemBoxes(id) ?? []).length > 0, `${BLOCKS[id].name} has an item model`);
  }
});

test("every recipe crafts from its own recipe-book layout (no two recipes fight over a grid)", () => {
  for (const r of RECIPES) {
    const have = new Map<number, number>();
    for (const [ing] of recipeNeeds(r)) for (const id of ing) have.set(id, 64);
    const grid = layoutFor(r, 3, have);
    assert.ok(grid, `${r.id} fits a 3x3 grid`);
    const m = matchRecipe(grid!, 3);
    assert.ok(m, `${r.id} matches`);
    assert.equal(m!.out.id, r.out.id, `${r.id}: the grid makes ${itemDef(m!.out.id)?.name} (${m!.id})`);
  }
});

test("oak and birch make their own stairs, slabs and fences; the new building recipes", () => {
  const grid = (rows: (number | 0)[][]) => rows.flat();
  const stairs = (p: number) => grid([[p, 0, 0], [p, p, 0], [p, p, p]]);
  assert.equal(matchRecipe(stairs(B.OAK_PLANKS), 3)!.out.id, B.OAK_STAIRS);
  assert.equal(matchRecipe(stairs(B.BIRCH_PLANKS), 3)!.out.id, B.BIRCH_STAIRS);
  assert.equal(matchRecipe(grid([[B.BIRCH_PLANKS, B.BIRCH_PLANKS, B.BIRCH_PLANKS], [0, 0, 0], [0, 0, 0]]), 3)!.out.id, B.BIRCH_SLAB);
  const s = I.STICK;
  assert.equal(matchRecipe(grid([[B.BIRCH_PLANKS, s, B.BIRCH_PLANKS], [B.BIRCH_PLANKS, s, B.BIRCH_PLANKS], [0, 0, 0]]), 3)!.out.id, B.BIRCH_FENCE);
  assert.equal(matchRecipe(grid([[s, B.BIRCH_PLANKS, s], [s, B.OAK_PLANKS, s], [0, 0, 0]]), 3)!.out.id, B.OAK_GATE);
  const P = B.OAK_PLANKS;
  assert.deepEqual(matchRecipe(grid([[P, 0, P], [P, P, P], [0, 0, 0]]), 3)!.out, { id: I.BOAT, n: 1, d: 0 });
  assert.deepEqual(matchRecipe([I.BRICK, I.BRICK, I.BRICK, I.BRICK], 2)!.out, { id: B.BRICKS, n: 1, d: 0 });
  assert.deepEqual(matchRecipe([I.CLAY_BALL, I.CLAY_BALL, I.CLAY_BALL, I.CLAY_BALL], 2)!.out, { id: B.CLAY, n: 1, d: 0 });
  assert.equal(matchRecipe([B.COBBLESTONE, I.BONE_MEAL, 0, 0], 2)!.out.id, B.MOSSY_COBBLE);
  assert.equal(matchRecipe([B.PALM_LOG, 0, 0, 0], 2)!.out.id, B.OAK_PLANKS);
  assert.equal(matchRecipe([B.HAY_BALE, 0, 0, 0], 2)!.out.n, 9);
});

test("colours: eight wool or terracotta around a flower, sapling, coal or bone meal; two wools mix into a third", () => {
  const ring = (around: number, mid: number) => [around, around, around, around, mid, around, around, around, around];
  const W = B.WOOL_WHITE;
  assert.deepEqual(matchRecipe(ring(W, B.POPPY), 3)!.out, { id: B.WOOL_RED, n: 8, d: 0 });
  assert.deepEqual(matchRecipe(ring(W, B.BLUEBELL), 3)!.out, { id: B.WOOL_BLUE, n: 8, d: 0 });
  assert.deepEqual(matchRecipe(ring(W, I.CHARCOAL), 3)!.out, { id: B.WOOL_BLACK, n: 8, d: 0 });
  assert.deepEqual(matchRecipe(ring(W, B.BIRCH_SAPLING), 3)!.out, { id: B.WOOL_GREEN, n: 8, d: 0 });
  assert.equal(matchRecipe(ring(W, B.TALL_GRASS), 3), null);
  const mix = (a: number, b: number) => matchRecipe([a, b, 0, 0], 2)?.out;
  assert.deepEqual(mix(B.WOOL_RED, B.WOOL_YELLOW), { id: B.WOOL_ORANGE, n: 2, d: 0 });
  assert.deepEqual(mix(B.WOOL_YELLOW, B.WOOL_RED), { id: B.WOOL_ORANGE, n: 2, d: 0 });
  assert.deepEqual(mix(B.WOOL_BLUE, B.WOOL_WHITE), { id: B.WOOL_LIGHT_BLUE, n: 2, d: 0 });
  assert.deepEqual(mix(B.WOOL_BLACK, B.WOOL_WHITE), { id: B.WOOL_GREY, n: 2, d: 0 });
  assert.deepEqual(mix(B.WOOL_RED, B.WOOL_GREEN), { id: B.WOOL_BROWN, n: 2, d: 0 });
  assert.deepEqual(mix(B.WOOL_BLUE, B.WOOL_GREEN), { id: B.WOOL_CYAN, n: 2, d: 0 });
  assert.equal(mix(W, W), undefined);
  // every wool colour can be made
  const made = new Set(RECIPES.map((r) => r.out.id));
  for (const w of [B.WOOL_RED, B.WOOL_ORANGE, B.WOOL_YELLOW, B.WOOL_LIME, B.WOOL_BLUE, B.WOOL_PURPLE, B.WOOL_BLACK, B.WOOL_CYAN, B.WOOL_PINK, B.WOOL_BROWN, B.WOOL_GREEN, B.WOOL_GREY, B.WOOL_LIGHT_BLUE]) assert.ok(made.has(w), BLOCKS[w].name);
  const T = B.TERRACOTTA;
  assert.deepEqual(matchRecipe(ring(T, I.BONE_MEAL), 3)!.out, { id: T + 1, n: 8, d: 0 });
  assert.deepEqual(matchRecipe(ring(T, B.BLUEBELL), 3)!.out, { id: T + 4, n: 8, d: 0 });
  for (let k = 1; k < 6; k++) assert.ok(made.has(T + k), BLOCKS[T + k].name);
  // a bed takes any wool, the new ones too
  assert.equal(matchRecipe([B.WOOL_GREY, B.WOOL_BROWN, B.WOOL_LIGHT_BLUE, B.OAK_PLANKS, B.OAK_PLANKS, B.BIRCH_PLANKS, 0, 0, 0], 3)!.out.id, B.RED_BED);
});
