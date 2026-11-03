// Items (protocol v5, armour and night-mob drops v6, farming, buckets and bows v7). Item ids are part of the protocol
// and the save format: append only.
//   1..255   block items: the id of the block state the item places (its picker/base state, e.g. stairs facing
//            north); the block's own name and icon
//   256..    other items: materials, food and tools, drawn as flat sprites from the block texture array
// A stack is { id, n, d }: item, count, and damage taken (tools only).

import { B, BLOCKS, TEX } from "./blocks.ts";

export type ToolKind = "pickaxe" | "axe" | "shovel" | "sword" | "hoe";

export interface Tool {
  kind: ToolKind;
  material: number; // 0 wood, 1 stone, 2 iron, 3 gold, 4 diamond
  tier: number; // harvest level: wood/gold 1, stone 2, iron 3, diamond 4
  speed: number; // mining speed on its own blocks (Java: 2, 4, 6, 12 for gold, 8)
  durability: number; // uses before it breaks
  damage: number; // attack damage in half hearts at full strength (hand = 1), Java 1.9+
  attackSpeed: number; // full-strength attacks per second (hand 4, swords 1.6, axes 0.8-1)
}

export const ARMOR_SLOTS = ["helmet", "chestplate", "leggings", "boots"] as const;

export interface Armor {
  slot: number; // 0 head, 1 chest, 2 legs, 3 feet (the armour slot it goes in)
  material: number; // 0 leather, 1 iron, 2 diamond
  points: number; // armour points (half a shirt icon each)
  tough: number; // armour toughness (diamond 2)
  durability: number;
  /** v13: Protection's level (Java's enchantment protection factor: 4% less damage a level, all pieces together). */
  prot?: number;
}

/** v13: what an enchanted item has on it (enchanted gear is its own item: the base item's stats, made better). */
export type EnchKind = "sharpness" | "efficiency" | "protection";
export interface Enchant {
  kind: EnchKind;
  level: number; // 1..3
  base: number; // the plain item it was made from
}

export interface Food {
  hunger: number; // half drumsticks restored
  sat: number; // saturation added
  queasy?: number; // chance of 30 s of extra hunger (spoiled flesh: 0.8)
}

export interface ItemDef {
  id: number;
  key: string;
  name: string;
  stack: number; // max stack size
  block: number; // block placed (0 = not placeable)
  tex: number; // texture layer for flat items, -1 for block items (block icon)
  tool?: Tool;
  armor?: Armor;
  food?: Food;
  fuel?: number; // furnace burn time in ticks
  /** v7: uses before it breaks, for things that wear but aren't tools or armour (the bow). */
  durability?: number;
  /** v7: drunk like food is eaten (the milk bucket: it settles a queasy stomach), at any hunger. */
  drink?: boolean;
  /** v7: what stays in the crafting grid when it is used up (a milk bucket leaves its bucket). */
  remainder?: number;
  /** v13: enchanted gear: the enchantment, its level and the plain item underneath. */
  ench?: Enchant;
}

export interface Stack {
  id: number;
  n: number;
  d: number;
}

export const I = {
  STICK: 256,
  COAL: 257,
  CHARCOAL: 258,
  RAW_IRON: 259,
  RAW_GOLD: 260,
  IRON_INGOT: 261,
  GOLD_INGOT: 262,
  DIAMOND: 263,
  RUBY: 264,
  APPLE: 265,
  PORKCHOP: 266,
  COOKED_PORKCHOP: 267,
  BEEF: 268,
  STEAK: 269,
  MUTTON: 270,
  COOKED_MUTTON: 271,
  CHICKEN: 272,
  COOKED_CHICKEN: 273,
  LEATHER: 274,
  FEATHER: 275,
  BOWL: 276,
  // v6: what night mobs drop, and what bones make
  SPOILED_FLESH: 277,
  BONE: 278,
  STRING: 279,
  BONE_MEAL: 280,
  // v7: farming, cooking, buckets, bows
  WHEAT_SEEDS: 281,
  WHEAT: 282,
  BREAD: 283,
  SUGAR: 284,
  PAPER: 285,
  EGG: 286,
  FLINT: 287,
  BOW: 288,
  ARROW: 289,
  BUCKET: 290,
  WATER_BUCKET: 291,
  MILK_BUCKET: 292,
  // v8: boats, clay and bricks, the palm island's coconuts
  BOAT: 293,
  CLAY_BALL: 294,
  BRICK: 295,
  COCONUT: 296,
  // v9: the fisher sells it (the only way to get one)
  SMOKED_FISH: 297,
  // v13: books (paper and leather) for the enchanting table; lava from the smith's forge, which sets into obsidian
  // where it meets water
  BOOK: 298,
  LAVA_BUCKET: 299,
  // tools: 300 + material * 4 + kind (pickaxe, axe, shovel, sword); materials wood, stone, iron, gold, diamond
  TOOL0: 300,
  // v7 hoes: 320 + material
  HOE0: 320,
  // v6 armour: 340 + material * 4 + slot (helmet, chestplate, leggings, boots); materials leather, iron, diamond
  ARMOR0: 340,
  // v13 enchanted gear: 400 + ENCHANTABLE index * 3 + level - 1
  ENCH0: 400,
} as const;

export const TOOL_KINDS: ToolKind[] = ["pickaxe", "axe", "shovel", "sword"];
export const MATERIAL_NAMES = ["Wooden", "Stone", "Iron", "Golden", "Diamond"];
const TIER = [1, 2, 3, 1, 4];
const SPEED = [2, 4, 6, 12, 8];
const DURABILITY = [59, 131, 250, 32, 1561];
// Java 1.9+ attack damage and speed (the attack cooldown makes heavy axes slow and swords quick).
const DAMAGE: Record<ToolKind, number[]> = {
  pickaxe: [2, 3, 4, 2, 5],
  axe: [7, 9, 9, 7, 9],
  shovel: [2.5, 3.5, 4.5, 2.5, 5.5],
  sword: [4, 5, 6, 4, 7],
  hoe: [1, 1, 1, 1, 1],
};
const ATTACK_SPEED: Record<ToolKind, number[]> = {
  pickaxe: [1.2, 1.2, 1.2, 1.2, 1.2],
  axe: [0.8, 0.8, 0.9, 1, 1],
  shovel: [1, 1, 1, 1, 1],
  sword: [1.6, 1.6, 1.6, 1.6, 1.6],
  hoe: [1, 2, 3, 1, 4],
};
/** An empty hand (or any item that isn't a tool): 1 damage, 4 attacks a second. */
export const HAND_DAMAGE = 1;
export const HAND_SPEED = 4;

export const ARMOR_MATERIALS = ["Leather", "Iron", "Diamond"];
const ARMOR_NAMES = [
  ["Leather Cap", "Leather Tunic", "Leather Pants", "Leather Boots"],
  ["Iron Helmet", "Iron Chestplate", "Iron Leggings", "Iron Boots"],
  ["Diamond Helmet", "Diamond Chestplate", "Diamond Leggings", "Diamond Boots"],
];
const ARMOR_POINTS = [[1, 3, 2, 1], [2, 6, 5, 2], [3, 8, 6, 3]];
const ARMOR_TOUGH = [0, 0, 2];
const ARMOR_DURABILITY = [[55, 80, 75, 65], [165, 240, 225, 195], [363, 528, 495, 429]];

export const toolId = (material: number, kind: number) => I.TOOL0 + material * 4 + kind;
/** v7: the hoe of a material (0 wood .. 4 diamond). */
export const hoeId = (material: number) => I.HOE0 + material;
export const isHoe = (id: number) => id >= I.HOE0 && id < I.HOE0 + 5;
export const armorId = (material: number, slot: number) => I.ARMOR0 + material * 4 + slot;

/** Every item, indexed by id (sparse). */
export const ITEMS: ItemDef[] = [];

function add(d: ItemDef): void {
  if (ITEMS[d.id]) throw new Error(`item id ${d.id} used twice`);
  ITEMS[d.id] = d;
}

// Block items: every block that is its own item and placeable (the picker set), plus water (not obtainable in
// survival but kept for creative builders).
for (const b of BLOCKS) {
  if (b.id === B.AIR || b.item !== b.id || !b.placeable) continue;
  add({ id: b.id, key: b.key, name: b.name, stack: b.id === B.CAKE ? 1 : b.id === B.RED_BED || b.id === B.OAK_DOOR ? 16 : 64, block: b.id, tex: -1 });
}
// Fuel values (ticks) for wooden blocks, like Java: logs and planks 300, coal block 16000.
for (const id of [B.OAK_LOG, B.BIRCH_LOG, B.OAK_PLANKS, B.BIRCH_PLANKS, B.OAK_STAIRS, B.OAK_FENCE, B.CRAFTING_TABLE, B.CHEST, B.LADDER,
  // v8
  B.PALM_LOG, B.BIRCH_STAIRS, B.BIRCH_FENCE, B.OAK_GATE, B.TRAPDOOR, B.BARREL, B.BOOKSHELF, B.VILLAGE_CHIME]) {
  if (ITEMS[id]) ITEMS[id].fuel = 300;
}
if (ITEMS[B.OAK_SLAB]) ITEMS[B.OAK_SLAB].fuel = 150;
if (ITEMS[B.BIRCH_SLAB]) ITEMS[B.BIRCH_SLAB].fuel = 150;
if (ITEMS[B.OAK_SAPLING]) ITEMS[B.OAK_SAPLING].fuel = 100;
if (ITEMS[B.BIRCH_SAPLING]) ITEMS[B.BIRCH_SAPLING].fuel = 100;
if (ITEMS[B.COAL_BLOCK]) ITEMS[B.COAL_BLOCK].fuel = 16000;
if (ITEMS[B.OAK_DOOR]) ITEMS[B.OAK_DOOR].fuel = 200;

const item = (id: number, key: string, name: string, tex: number, more: Partial<ItemDef> = {}) =>
  add({ id, key, name, stack: 64, block: 0, tex, ...more });

item(I.STICK, "stick", "Stick", TEX.stick, { fuel: 100 });
item(I.COAL, "coal", "Coal", TEX.coal, { fuel: 1600 });
item(I.CHARCOAL, "charcoal", "Charcoal", TEX.charcoal, { fuel: 1600 });
item(I.RAW_IRON, "raw_iron", "Raw Iron", TEX.raw_iron);
item(I.RAW_GOLD, "raw_gold", "Raw Gold", TEX.raw_gold);
item(I.IRON_INGOT, "iron_ingot", "Iron Ingot", TEX.iron_ingot);
item(I.GOLD_INGOT, "gold_ingot", "Gold Ingot", TEX.gold_ingot);
item(I.DIAMOND, "diamond", "Diamond", TEX.diamond);
item(I.RUBY, "ruby", "Ruby", TEX.ruby);
// Food values follow Java (hunger in half drumsticks, saturation).
item(I.APPLE, "apple", "Apple", TEX.apple, { food: { hunger: 4, sat: 2.4 } });
item(I.PORKCHOP, "porkchop", "Raw Porkchop", TEX.porkchop, { food: { hunger: 3, sat: 1.8 } });
item(I.COOKED_PORKCHOP, "cooked_porkchop", "Cooked Porkchop", TEX.cooked_porkchop, { food: { hunger: 8, sat: 12.8 } });
item(I.BEEF, "beef", "Raw Beef", TEX.beef, { food: { hunger: 3, sat: 1.8 } });
item(I.STEAK, "steak", "Steak", TEX.steak, { food: { hunger: 8, sat: 12.8 } });
item(I.MUTTON, "mutton", "Raw Mutton", TEX.mutton, { food: { hunger: 2, sat: 1.2 } });
item(I.COOKED_MUTTON, "cooked_mutton", "Cooked Mutton", TEX.cooked_mutton, { food: { hunger: 6, sat: 9.6 } });
item(I.CHICKEN, "chicken", "Raw Chicken", TEX.chicken, { food: { hunger: 2, sat: 1.2 } });
item(I.COOKED_CHICKEN, "cooked_chicken", "Cooked Chicken", TEX.cooked_chicken, { food: { hunger: 6, sat: 7.2 } });
item(I.LEATHER, "leather", "Leather", TEX.leather);
item(I.FEATHER, "feather", "Feather", TEX.feather);
item(I.BOWL, "bowl", "Bowl", TEX.bowl, { fuel: 100 });
item(I.SPOILED_FLESH, "spoiled_flesh", "Spoiled Flesh", TEX.spoiled_flesh, { food: { hunger: 4, sat: 0.8, queasy: 0.8 } });
item(I.BONE, "bone", "Bone", TEX.bone);
item(I.STRING, "string", "String", TEX.string);
item(I.BONE_MEAL, "bone_meal", "Bone Meal", TEX.bone_meal);
// v7: farming and cooking (Java's food values), buckets, the bow and arrows
item(I.WHEAT_SEEDS, "wheat_seeds", "Wheat Seeds", TEX.wheat_seeds, { block: B.WHEAT });
item(I.WHEAT, "wheat", "Wheat", TEX.wheat);
item(I.BREAD, "bread", "Bread", TEX.bread, { food: { hunger: 5, sat: 6 } });
item(I.SUGAR, "sugar", "Sugar", TEX.sugar);
item(I.PAPER, "paper", "Paper", TEX.paper);
item(I.EGG, "egg", "Egg", TEX.egg, { stack: 16 });
item(I.FLINT, "flint", "Flint", TEX.flint);
item(I.BOW, "bow", "Bow", TEX.bow, { stack: 1, durability: 384, fuel: 300 });
item(I.ARROW, "arrow", "Arrow", TEX.arrow);
item(I.BUCKET, "bucket", "Bucket", TEX.bucket, { stack: 16 });
item(I.WATER_BUCKET, "water_bucket", "Water Bucket", TEX.water_bucket, { stack: 1, block: B.WATER, remainder: I.BUCKET });
item(I.MILK_BUCKET, "milk_bucket", "Milk Bucket", TEX.milk_bucket, { stack: 1, drink: true, remainder: I.BUCKET });
// v8: the boat (placed on water as an entity, not a block), clay and bricks, coconuts from the palms
item(I.BOAT, "boat", "Boat", TEX.boat, { stack: 1, fuel: 1200 });
item(I.CLAY_BALL, "clay_ball", "Clay Ball", TEX.clay_ball);
item(I.BRICK, "brick", "Brick", TEX.brick);
item(I.COCONUT, "coconut", "Coconut", TEX.coconut, { food: { hunger: 4, sat: 2.4 } });
item(I.SMOKED_FISH, "smoked_fish", "Smoked Fish", TEX.smoked_fish, { food: { hunger: 6, sat: 7.2 } });

for (let m = 0; m < 5; m++) {
  for (let k = 0; k < 4; k++) {
    const kind = TOOL_KINDS[k];
    const name = `${MATERIAL_NAMES[m]} ${kind[0].toUpperCase()}${kind.slice(1)}`;
    item(toolId(m, k), `${["wooden", "stone", "iron", "golden", "diamond"][m]}_${kind}`, name, TEX.tool0 + m * 4 + k, {
      stack: 1,
      fuel: m === 0 ? 200 : undefined,
      tool: { kind, material: m, tier: TIER[m], speed: SPEED[m], durability: DURABILITY[m], damage: DAMAGE[kind][m], attackSpeed: ATTACK_SPEED[kind][m] },
    });
  }
}
// v7 hoes: till grass and dirt into farmland. Java: 1 damage at any material, quicker swings the better the hoe.
for (let m = 0; m < 5; m++) {
  item(hoeId(m), `${["wooden", "stone", "iron", "golden", "diamond"][m]}_hoe`, `${MATERIAL_NAMES[m]} Hoe`, TEX.hoe0 + m, {
    stack: 1,
    fuel: m === 0 ? 200 : undefined,
    tool: { kind: "hoe", material: m, tier: TIER[m], speed: 1, durability: DURABILITY[m], damage: DAMAGE.hoe[m], attackSpeed: ATTACK_SPEED.hoe[m] },
  });
}
for (let m = 0; m < 3; m++) {
  for (let k = 0; k < 4; k++) {
    item(armorId(m, k), `${["leather", "iron", "diamond"][m]}_${ARMOR_SLOTS[k]}`, ARMOR_NAMES[m][k], TEX.armor0 + m * 4 + k, {
      stack: 1,
      armor: { slot: k, material: m, points: ARMOR_POINTS[m][k], tough: ARMOR_TOUGH[m], durability: ARMOR_DURABILITY[m][k] },
    });
  }
}

// v13: books, the smith's lava, and enchanted gear
item(I.BOOK, "book", "Book", TEX.book);
// poured out it sets at once into obsidian, so it only goes where water is beside it (shard.ts); the bucket is left
item(I.LAVA_BUCKET, "lava_bucket", "Lava Bucket", TEX.lava_bucket, { stack: 1, block: B.OBSIDIAN, remainder: I.BUCKET });

/** v13: what the enchanting table takes, in id order (append only): swords and axes (Sharpness), pickaxes and
 *  shovels (Efficiency), then every piece of armour (Protection). */
export const ENCHANTABLE: number[] = [
  ...[0, 1, 2, 3, 4].map((m) => toolId(m, 3)),
  ...[0, 1, 2, 3, 4].map((m) => toolId(m, 1)),
  ...[0, 1, 2, 3, 4].map((m) => toolId(m, 0)),
  ...[0, 1, 2, 3, 4].map((m) => toolId(m, 2)),
  ...[0, 1, 2].flatMap((m) => [0, 1, 2, 3].map((k) => armorId(m, k))),
];
export const ENCH_MAX = 3;
export const ENCH_NAMES: Record<EnchKind, string> = { sharpness: "Sharpness", efficiency: "Efficiency", protection: "Protection" };
const ROMAN = ["", "I", "II", "III"];
/** The enchantment a plain item takes (or null). */
export function enchKindOf(base: number): EnchKind | null {
  const d = ITEMS[base];
  if (!d || !ENCHANTABLE.includes(base)) return null;
  if (d.armor) return "protection";
  return d.tool?.kind === "sword" || d.tool?.kind === "axe" ? "sharpness" : "efficiency";
}
/** The enchanted item: `base` at `level` (1..3), or 0. */
export function enchantedId(base: number, level: number): number {
  const k = ENCHANTABLE.indexOf(base);
  return k < 0 || level < 1 || level > ENCH_MAX ? 0 : I.ENCH0 + k * ENCH_MAX + level - 1;
}
ENCHANTABLE.forEach((base) => {
  const d = ITEMS[base];
  const kind = enchKindOf(base)!;
  for (let level = 1; level <= ENCH_MAX; level++) {
    const v: ItemDef = { ...d, id: enchantedId(base, level), key: `${d.key}_${kind}_${level}`, name: `${d.name} (${ENCH_NAMES[kind]} ${ROMAN[level]})`, ench: { kind, level, base } };
    // Java 1.9+: Sharpness adds 0.5 x level + 0.5 damage; Efficiency adds level^2 + 1 to the mining speed; Protection
    // takes 4% a level off what gets through (shared/combat.ts)
    if (kind === "sharpness") v.tool = { ...d.tool!, damage: d.tool!.damage + 0.5 * level + 0.5 };
    else if (kind === "efficiency") v.tool = { ...d.tool!, speed: d.tool!.speed + level * level + 1 };
    else v.armor = { ...d.armor!, prot: level };
    add(v);
  }
});
/** The plain item under an enchanted one (itself if it isn't enchanted). */
export const plainOf = (id: number) => itemDef(id)?.ench?.base ?? id;

export function itemDef(id: number): ItemDef | undefined {
  return Number.isInteger(id) && id > 0 ? ITEMS[id] : undefined;
}

export function isValidItem(id: number): boolean {
  return !!itemDef(id);
}

export const maxStack = (id: number) => itemDef(id)?.stack ?? 64;

/** Uses before it breaks (tools, armour and, v7, the bow), 0 for everything else. */
export function maxDurability(id: number): number {
  const d = itemDef(id);
  return d?.tool?.durability ?? d?.armor?.durability ?? d?.durability ?? 0;
}

/** The item a block state drops as itself / is picked as (stairs facing east -> the stairs item). */
export function itemOfBlock(block: number): number {
  const b = BLOCKS[block];
  if (!b) return 0;
  return ITEMS[b.item] ? b.item : 0;
}

export const EMPTY: Stack | null = null;

export function stack(id: number, n = 1, d = 0): Stack {
  return { id, n, d };
}

export function sameItem(a: Stack | null, b: Stack | null): boolean {
  return !!a && !!b && a.id === b.id && a.d === b.d;
}

export function cloneStack(s: Stack | null): Stack | null {
  return s ? { id: s.id, n: s.n, d: s.d } : null;
}

/** Wire form: [id, n, d] or 0 for empty. */
export type WireStack = [number, number, number] | 0;
export const toWire = (s: Stack | null): WireStack => (s && s.n > 0 ? [s.id, s.n, s.d] : 0);
export function fromWire(w: unknown): Stack | null {
  if (!Array.isArray(w) || w.length !== 3) return null;
  const [id, n, d] = w as number[];
  if (!isValidItem(id) || !Number.isInteger(n) || n < 1 || n > maxStack(id) || !Number.isInteger(d) || d < 0) return null;
  return { id, n, d };
}

/** Display name; tools get no suffix (durability shows as a bar). */
export function itemName(id: number): string {
  return itemDef(id)?.name ?? "Unknown";
}

/** Furnace smelting: input item -> [output item, xp-free]. 200 ticks per item, like Java. */
export const SMELT: Record<number, number> = {
  [I.RAW_IRON]: I.IRON_INGOT,
  [I.RAW_GOLD]: I.GOLD_INGOT,
  [B.IRON_ORE]: I.IRON_INGOT,
  [B.GOLD_ORE]: I.GOLD_INGOT,
  [B.SAND]: B.GLASS,
  [B.COBBLESTONE]: B.STONE,
  [B.OAK_LOG]: I.CHARCOAL,
  [B.BIRCH_LOG]: I.CHARCOAL,
  [I.PORKCHOP]: I.COOKED_PORKCHOP,
  [I.BEEF]: I.STEAK,
  [I.MUTTON]: I.COOKED_MUTTON,
  [I.CHICKEN]: I.COOKED_CHICKEN,
  [B.COAL_ORE]: I.COAL,
  [B.DIAMOND_ORE]: I.DIAMOND,
  [B.RUBY_ORE]: I.RUBY,
  // v8: clay fires into bricks and terracotta; palm wood burns into charcoal
  [I.CLAY_BALL]: I.BRICK,
  [B.CLAY]: B.TERRACOTTA,
  [B.PALM_LOG]: I.CHARCOAL,
};
export const SMELT_TICKS = 200;

export const fuelTicks = (id: number) => itemDef(id)?.fuel ?? 0;
