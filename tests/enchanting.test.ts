// Enchanting (protocol v13): the way there (obsidian from the smith's lava on water, books, the table's recipe), the
// table's rules (rubies for levels, bookshelves round it for the higher ones, never a level an item has), and what
// the enchantments do: Sharpness hits harder, Efficiency mines faster, Protection takes damage off, and enchanted
// armour counts as better when choosing what to wear. Enchanted gear is its own item: it keeps its stats otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { B } from "../shared/blocks.ts";
import { afterProtection, armorOf, armorValue, attackDamageOf } from "../shared/combat.ts";
import { ENCH_COST, ENCH_SHELVES, levelForShelves, planEnchant, shelvesAround, waterBeside } from "../shared/enchanting.ts";
import { ENCHANTABLE, I, armorId, enchKindOf, enchantedId, itemDef, maxDurability, plainOf, toolId } from "../shared/items.ts";
import { blockDrops, breakTicks, canHarvest } from "../shared/mining.ts";
import { RECIPES, canMake } from "../shared/recipes.ts";
import { TRADES } from "../shared/trades.ts";
import { JOB } from "../shared/villagers.ts";

test("enchanted gear: one item per piece and level, the plain item's stats made better, and the way back to it", () => {
  const seen = new Set<number>();
  for (const base of ENCHANTABLE) {
    const kind = enchKindOf(base);
    assert.ok(kind, `${itemDef(base)!.name} takes an enchantment`);
    for (let l = 1; l <= 3; l++) {
      const id = enchantedId(base, l);
      assert.ok(id >= I.ENCH0 && !seen.has(id), "its own id");
      seen.add(id);
      const d = itemDef(id)!;
      assert.equal(plainOf(id), base);
      assert.equal(d.ench?.level, l);
      assert.equal(d.tex, itemDef(base)!.tex, "drawn like the plain one (with a glint)");
      assert.equal(maxDurability(id), maxDurability(base), "it wears the same");
    }
  }
  assert.equal(enchantedId(I.BOW, 1), 0, "the bow isn't enchantable");
  assert.equal(enchantedId(toolId(2, 3), 4), 0, "level 3 is the top");
  // Java 1.9+: Sharpness +0.5 x level + 0.5; Efficiency +level^2 + 1
  assert.equal(attackDamageOf(enchantedId(toolId(2, 3), 3)), 6 + 2);
  assert.equal(attackDamageOf(enchantedId(toolId(4, 3), 1)), 7 + 1);
  const pick = toolId(2, 0);
  assert.ok(breakTicks(B.STONE, enchantedId(pick, 3)) < breakTicks(B.STONE, pick) / 2, "Efficiency III mines stone more than twice as fast");
});

test("Protection: 4% a level over all the pieces worn, after the armour, at most 80%; armour choice counts it", () => {
  assert.equal(afterProtection(10, 0), 10);
  assert.ok(Math.abs(afterProtection(10, 4) - 8.4) < 1e-9);
  assert.ok(Math.abs(afterProtection(10, 40) - 2) < 1e-9, "capped at 80%");
  const worn = [0, 1, 2, 3].map((k) => ({ id: enchantedId(armorId(1, k), 2), n: 1, d: 0 }));
  const a = armorOf(worn);
  assert.equal(a.points, 15, "the iron's points stay");
  assert.equal(a.prot, 8);
  assert.ok(armorValue(enchantedId(armorId(1, 1), 1)) > armorValue(armorId(1, 1)), "an enchanted chestplate beats a plain one");
  assert.ok(armorValue(armorId(2, 1)) > armorValue(armorId(1, 1)), "diamond beats iron");
});

test("the way there: obsidian takes a diamond pickaxe, the smith sells lava, a book and the table have recipes", () => {
  assert.ok(!canHarvest(B.OBSIDIAN, toolId(2, 0)), "iron can't get obsidian out whole");
  assert.ok(canHarvest(B.OBSIDIAN, toolId(4, 0)) && canHarvest(B.OBSIDIAN, enchantedId(toolId(4, 0), 2)), "diamond can (enchanted too)");
  assert.deepEqual(blockDrops(B.OBSIDIAN, toolId(4, 0), () => 0.5), [{ id: B.OBSIDIAN, n: 1, d: 0 }]);
  assert.ok(breakTicks(B.OBSIDIAN, toolId(4, 0)) > 150, "nine seconds or so with a diamond pickaxe");
  const lava = TRADES[JOB.SMITH].find((o) => o.sell[0] === I.LAVA_BUCKET);
  assert.ok(lava && lava.buy[0] === I.RUBY && lava.buy2?.[0] === I.BUCKET, "the smith: rubies and your bucket for lava");
  assert.equal(itemDef(I.LAVA_BUCKET)!.remainder, I.BUCKET, "poured out, the bucket is left");
  assert.equal(itemDef(I.LAVA_BUCKET)!.block, B.OBSIDIAN, "and what it pours is obsidian (where water is beside it)");
  const book = RECIPES.find((r) => r.id === "book")!;
  assert.ok(canMake(book, new Map([[I.PAPER, 3], [I.LEATHER, 1]])) && !canMake(book, new Map([[I.PAPER, 3]])));
  const table = RECIPES.find((r) => r.id === "enchanting_table")!;
  assert.equal(table.out.id, B.ENCHANTING_TABLE);
  assert.ok(canMake(table, new Map([[I.BOOK, 1], [I.DIAMOND, 2], [B.OBSIDIAN, 4]])) && !canMake(table, new Map([[I.BOOK, 1], [I.DIAMOND, 2], [B.OBSIDIAN, 3]])));
});

test("lava sets only where water is beside it", () => {
  const world = new Map<string, number>([["5,5,5", B.WATER]]);
  const get = (x: number, y: number, z: number) => world.get(`${x},${y},${z}`) ?? B.AIR;
  assert.ok(waterBeside(get, 5, 6, 5), "on top of the water");
  assert.ok(waterBeside(get, 6, 5, 5), "beside it");
  assert.ok(waterBeside(get, 5, 5, 5), "into it");
  assert.ok(!waterBeside(get, 6, 6, 5), "not diagonally");
  assert.ok(!waterBeside(get, 9, 9, 9));
});

test("the table: rubies for a level, bookshelves round it for the higher ones, never a level it already has", () => {
  const sword = toolId(2, 3);
  assert.deepEqual([ENCH_COST[1], ENCH_COST[2], ENCH_COST[3]], [2, 4, 7]);
  assert.deepEqual([levelForShelves(0), levelForShelves(ENCH_SHELVES[2]), levelForShelves(ENCH_SHELVES[3] - 1), levelForShelves(32)], [1, 2, 2, 3]);
  let p = planEnchant(sword, 10, 0);
  assert.equal(p.id, enchantedId(sword, 1), "no shelves: level 1");
  p = planEnchant(sword, 10, 10);
  assert.deepEqual([p.id, p.level, p.cost], [enchantedId(sword, 3), 3, 7], "ten shelves and the rubies: level 3");
  p = planEnchant(sword, 5, 10);
  assert.equal(p.level, 2, "five rubies: the best it can pay for");
  p = planEnchant(sword, 1, 10);
  assert.equal(p.id, 0, "a ruby isn't enough for anything");
  p = planEnchant(sword, 10, 0, 3);
  assert.ok(!p.id && /bookshelves/.test(p.why!), "level 3 asked with no shelves: says why");
  p = planEnchant(enchantedId(sword, 2), 10, 10);
  assert.equal(p.id, enchantedId(sword, 3), "an enchanted sword goes higher");
  p = planEnchant(enchantedId(sword, 2), 10, 0);
  assert.equal(p.id, 0, "but never down or sideways");
  assert.equal(planEnchant(I.BOW, 10, 10).id, 0);
  assert.equal(planEnchant(B.DIRT, 10, 10).id, 0);
  // the ring: two out, on the table's level and one up
  const shelves = new Set<string>();
  for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) if (Math.max(Math.abs(dx), Math.abs(dz)) === 2) shelves.add(`${dx},0,${dz}`);
  shelves.add("0,1,2");
  shelves.add("1,0,1"); // too close: doesn't count
  const get = (x: number, y: number, z: number) => (shelves.has(`${x},${y},${z}`) ? B.BOOKSHELF : B.AIR);
  assert.equal(shelvesAround(get, 0, 0, 0), 17);
});
