// Crafting recipes (protocol v5; armour, bone meal and wool from string v6; farming, food, buckets, bow and arrows v7;
// books and the enchanting table v13):
// the classic shapes (game mechanics; all art is our own). Shaped recipes match
// anywhere in the grid and mirrored left-right; the 2x2 grid in the inventory takes any recipe that fits in 2x2,
// the crafting table's 3x3 grid takes them all. Shared by the client (result preview, the recipe book) and the
// server (the authority).

import { B } from "./blocks.ts";
import { I, armorId, hoeId, toolId, type Stack } from "./items.ts";

/** One grid cell's accepted items (any of them). */
type Ingredient = number[];

export interface Recipe {
  id: string;
  cat: "basics" | "tools" | "combat" | "building" | "materials";
  out: Stack;
  /** Rows of a shaped recipe; spaces are empty cells. */
  shape?: string[];
  key?: Record<string, Ingredient>;
  /** Shapeless: these ingredients in any cells. */
  shapeless?: Ingredient[];
}

const PLANKS: Ingredient = [B.OAK_PLANKS, B.BIRCH_PLANKS];
const FUEL_COAL: Ingredient = [I.COAL, I.CHARCOAL];
const WOOL: Ingredient = [
  B.WOOL_WHITE, B.WOOL_RED, B.WOOL_ORANGE, B.WOOL_YELLOW, B.WOOL_LIME, B.WOOL_BLUE, B.WOOL_PURPLE, B.WOOL_BLACK, B.WOOL_CYAN, B.WOOL_PINK,
  B.WOOL_BROWN, B.WOOL_GREEN, B.WOOL_GREY, B.WOOL_LIGHT_BLUE, // v8
];
const STICK: Ingredient = [I.STICK];
const out = (id: number, n = 1): Stack => ({ id, n, d: 0 });

export const RECIPES: Recipe[] = [];
const shaped = (id: string, cat: Recipe["cat"], o: Stack, shape: string[], key: Record<string, Ingredient>) => RECIPES.push({ id, cat, out: o, shape, key });
const shapeless = (id: string, cat: Recipe["cat"], o: Stack, ings: Ingredient[]) => RECIPES.push({ id, cat, out: o, shapeless: ings });

// ---- basics
shapeless("oak_planks", "basics", out(B.OAK_PLANKS, 4), [[B.OAK_LOG]]);
shapeless("birch_planks", "basics", out(B.BIRCH_PLANKS, 4), [[B.BIRCH_LOG]]);
shapeless("oak_planks_from_palm", "basics", out(B.OAK_PLANKS, 4), [[B.PALM_LOG]]); // v8: palm wood is pale and plain
shaped("sticks", "basics", out(I.STICK, 4), ["P", "P"], { P: PLANKS });
shaped("crafting_table", "basics", out(B.CRAFTING_TABLE), ["PP", "PP"], { P: PLANKS });
shaped("torch", "basics", out(B.TORCH, 4), ["c", "s"], { c: FUEL_COAL, s: STICK });
shaped("furnace", "basics", out(B.FURNACE), ["CCC", "C C", "CCC"], { C: [B.COBBLESTONE] });
shaped("chest", "basics", out(B.CHEST), ["PPP", "P P", "PPP"], { P: PLANKS });
shaped("bed", "basics", out(B.RED_BED), ["WWW", "PPP"], { W: WOOL, P: PLANKS });
shaped("bowl", "basics", out(I.BOWL, 4), ["P P", " P "], { P: PLANKS });
shapeless("bone_meal", "basics", out(I.BONE_MEAL, 3), [[I.BONE]]);
shaped("wool_from_string", "basics", out(B.WOOL_WHITE), ["ss", "ss"], { s: [I.STRING] });

// ---- tools: wood, stone, iron, gold, diamond (the swords are listed in the Combat tab)
const HEADS: Ingredient[] = [PLANKS, [B.COBBLESTONE], [I.IRON_INGOT], [I.GOLD_INGOT], [I.DIAMOND]];
const MAT = ["wooden", "stone", "iron", "golden", "diamond"];
HEADS.forEach((m, k) => {
  shaped(`${MAT[k]}_pickaxe`, "tools", out(toolId(k, 0)), ["MMM", " s ", " s "], { M: m, s: STICK });
  shaped(`${MAT[k]}_axe`, "tools", out(toolId(k, 1)), ["MM", "Ms", " s"], { M: m, s: STICK });
  shaped(`${MAT[k]}_shovel`, "tools", out(toolId(k, 2)), ["M", "s", "s"], { M: m, s: STICK });
  shaped(`${MAT[k]}_sword`, "combat", out(toolId(k, 3)), ["M", "M", "s"], { M: m, s: STICK });
});

// v7 hoes (the classic shape), and the bucket
HEADS.forEach((m, k) => shaped(`${MAT[k]}_hoe`, "tools", out(hoeId(k)), ["MM", " s", " s"], { M: m, s: STICK }));
shaped("bucket", "tools", out(I.BUCKET), ["I I", " I "], { I: [I.IRON_INGOT] });
// v8: the boat (the classic shape), any planks
shaped("boat", "tools", out(I.BOAT), ["P P", "PPP"], { P: PLANKS });

// ---- v7 food: bread, sugar, cake (the milk buckets come back empty)
shaped("bread", "basics", out(I.BREAD), ["WWW"], { W: [I.WHEAT] });
shapeless("sugar", "basics", out(I.SUGAR), [[B.SUGAR_CANE]]);
shaped("cake", "basics", out(B.CAKE), ["MMM", "SES", "WWW"], { M: [I.MILK_BUCKET], S: [I.SUGAR], E: [I.EGG], W: [I.WHEAT] });
shaped("paper", "materials", out(I.PAPER, 3), ["CCC"], { C: [B.SUGAR_CANE] });

// ---- v7 combat: the bow and arrows
shaped("bow", "combat", out(I.BOW), [" sX", "s X", " sX"], { s: STICK, X: [I.STRING] });
shaped("arrow", "combat", out(I.ARROW, 4), ["F", "s", "f"], { F: [I.FLINT], s: STICK, f: [I.FEATHER] });

// ---- combat: the swords (above) and armour in leather, iron and diamond (the classic shapes)
const ARMOR_MATS: Ingredient[] = [[I.LEATHER], [I.IRON_INGOT], [I.DIAMOND]];
const ARMOR_KEYS = ["leather", "iron", "diamond"];
ARMOR_MATS.forEach((m, k) => {
  shaped(`${ARMOR_KEYS[k]}_helmet`, "combat", out(armorId(k, 0)), ["MMM", "M M"], { M: m });
  shaped(`${ARMOR_KEYS[k]}_chestplate`, "combat", out(armorId(k, 1)), ["M M", "MMM", "MMM"], { M: m });
  shaped(`${ARMOR_KEYS[k]}_leggings`, "combat", out(armorId(k, 2)), ["MMM", "M M", "M M"], { M: m });
  shaped(`${ARMOR_KEYS[k]}_boots`, "combat", out(armorId(k, 3)), ["M M", "M M"], { M: m });
});

// ---- building
shaped("door", "building", out(B.OAK_DOOR, 3), ["PP", "PP", "PP"], { P: PLANKS });
shaped("ladder", "building", out(B.LADDER, 3), ["s s", "sss", "s s"], { s: STICK });
// v8: oak and birch planks now make their own stairs, slabs and fences
shaped("fence", "building", out(B.OAK_FENCE, 3), ["PsP", "PsP"], { P: [B.OAK_PLANKS], s: STICK });
shaped("oak_stairs", "building", out(B.OAK_STAIRS, 4), ["P  ", "PP ", "PPP"], { P: [B.OAK_PLANKS] });
shaped("cobblestone_stairs", "building", out(B.COBBLE_STAIRS, 4), ["C  ", "CC ", "CCC"], { C: [B.COBBLESTONE] });
shaped("stone_brick_stairs", "building", out(B.STONE_BRICK_STAIRS, 4), ["C  ", "CC ", "CCC"], { C: [B.STONE_BRICKS] });
shaped("brick_stairs", "building", out(B.BRICK_STAIRS, 4), ["C  ", "CC ", "CCC"], { C: [B.BRICKS] });
shaped("oak_slab", "building", out(B.OAK_SLAB, 6), ["PPP"], { P: [B.OAK_PLANKS] });
shaped("cobblestone_slab", "building", out(B.COBBLE_SLAB, 6), ["CCC"], { C: [B.COBBLESTONE] });
shaped("stone_brick_slab", "building", out(B.STONE_BRICK_SLAB, 6), ["CCC"], { C: [B.STONE_BRICKS] });
shaped("brick_slab", "building", out(B.BRICK_SLAB, 6), ["CCC"], { C: [B.BRICKS] });
shaped("stone_slab", "building", out(B.STONE_SLAB, 6), ["CCC"], { C: [B.STONE] });
shaped("stone_bricks", "building", out(B.STONE_BRICKS, 4), ["SS", "SS"], { S: [B.STONE] });
shaped("glass_pane", "building", out(B.GLASS_PANE, 16), ["GGG", "GGG"], { G: [B.GLASS] });
shaped("lamp", "building", out(B.LAMP), ["GGG", "GtG", "GGG"], { G: [B.GLASS], t: [B.TORCH] });

// ---- v8: building blocks for villages and bases (our own recipes where the classic game has none)
shaped("birch_fence", "building", out(B.BIRCH_FENCE, 3), ["PsP", "PsP"], { P: [B.BIRCH_PLANKS], s: STICK });
shaped("birch_stairs", "building", out(B.BIRCH_STAIRS, 4), ["P  ", "PP ", "PPP"], { P: [B.BIRCH_PLANKS] });
shaped("birch_slab", "building", out(B.BIRCH_SLAB, 6), ["PPP"], { P: [B.BIRCH_PLANKS] });
shaped("fence_gate", "building", out(B.OAK_GATE), ["sPs", "sPs"], { P: PLANKS, s: STICK });
shaped("trapdoor", "building", out(B.TRAPDOOR, 2), ["PPP", "PPP"], { P: PLANKS });
shaped("cobblestone_wall", "building", out(B.COBBLE_WALL, 6), ["CCC", "CCC"], { C: [B.COBBLESTONE] });
shaped("stone_brick_wall", "building", out(B.STONE_BRICK_WALL, 6), ["CCC", "CCC"], { C: [B.STONE_BRICKS] });
shapeless("mossy_cobblestone", "building", out(B.MOSSY_COBBLE), [[B.COBBLESTONE], [I.BONE_MEAL]]); // bone meal grows moss
shapeless("mossy_stone_bricks", "building", out(B.MOSSY_STONE_BRICKS), [[B.STONE_BRICKS], [I.BONE_MEAL]]);
shaped("bricks", "building", out(B.BRICKS), ["bb", "bb"], { b: [I.BRICK] });
shaped("flower_pot", "building", out(B.FLOWER_POT), ["b b", " b "], { b: [I.BRICK] });
shaped("lantern", "building", out(B.LANTERN, 2), [" I ", "GtG", " I "], { I: [I.IRON_INGOT], G: [B.GLASS_PANE], t: [B.TORCH] });
shaped("barrel", "building", out(B.BARREL), ["PSP", "P P", "PSP"], { P: PLANKS, S: [B.OAK_SLAB, B.BIRCH_SLAB] });
shaped("bookshelf", "building", out(B.BOOKSHELF), ["PPP", "ppp", "PPP"], { P: PLANKS, p: [I.PAPER] });
shaped("hay_bale", "building", out(B.HAY_BALE), ["WWW", "WWW", "WWW"], { W: [I.WHEAT] });
shapeless("wheat_from_hay", "materials", out(I.WHEAT, 9), [[B.HAY_BALE]]);
shaped("village_chime", "building", out(B.VILLAGE_CHIME), ["PPP", "sgs", " g "], { P: PLANKS, s: STICK, g: [I.GOLD_INGOT] });
shaped("clay", "materials", out(B.CLAY), ["cc", "cc"], { c: [I.CLAY_BALL] });

// ---- v13: the way to enchanting: a book (three paper and a piece of leather) and the enchanting table (a book on
// two diamonds and four obsidian: the classic shapes)
shapeless("book", "materials", out(I.BOOK), [[I.PAPER], [I.PAPER], [I.PAPER], [I.LEATHER]]);
shaped("enchanting_table", "basics", out(B.ENCHANTING_TABLE), [" B ", "DOD", "OOO"], { B: [I.BOOK], D: [I.DIAMOND], O: [B.OBSIDIAN] });

// Colours, our own way (no dye items): eight white wool (or terracotta) around a flower, a sapling, coal or bone
// meal; then two wools mix into a third, like paint.
const TINT: [string, Ingredient][] = [
  ["red", [B.POPPY]],
  ["yellow", [B.DANDELION]],
  ["blue", [B.BLUEBELL]],
  ["black", [I.COAL, I.CHARCOAL]],
  ["green", [B.OAK_SAPLING, B.BIRCH_SAPLING]],
  ["white", [I.BONE_MEAL]],
];
const tint = (k: string) => TINT.find((t) => t[0] === k)![1];
for (const [key, wool] of [["red", B.WOOL_RED], ["yellow", B.WOOL_YELLOW], ["blue", B.WOOL_BLUE], ["black", B.WOOL_BLACK], ["green", B.WOOL_GREEN]] as [string, number][]) {
  shaped(`${key}_wool`, "building", out(wool, 8), ["WWW", "WxW", "WWW"], { W: [B.WOOL_WHITE], x: tint(key) });
}
for (const [key, a, b, wool] of [
  ["orange", B.WOOL_RED, B.WOOL_YELLOW, B.WOOL_ORANGE],
  ["pink", B.WOOL_RED, B.WOOL_WHITE, B.WOOL_PINK],
  ["lime", B.WOOL_GREEN, B.WOOL_WHITE, B.WOOL_LIME],
  ["cyan", B.WOOL_BLUE, B.WOOL_GREEN, B.WOOL_CYAN],
  ["purple", B.WOOL_RED, B.WOOL_BLUE, B.WOOL_PURPLE],
  ["light_blue", B.WOOL_BLUE, B.WOOL_WHITE, B.WOOL_LIGHT_BLUE],
  ["grey", B.WOOL_BLACK, B.WOOL_WHITE, B.WOOL_GREY],
  ["brown", B.WOOL_RED, B.WOOL_GREEN, B.WOOL_BROWN],
] as [string, number, number, number][]) {
  shapeless(`${key}_wool`, "building", out(wool, 2), [[a], [b]]);
}
for (const [key, k, t] of [["cream", 1, "white"], ["rust", 2, "red"], ["ochre", 3, "yellow"], ["slate", 4, "blue"], ["charcoal", 5, "black"]] as [string, number, string][]) {
  shaped(`${key}_terracotta`, "building", out(B.TERRACOTTA + k, 8), ["TTT", "TxT", "TTT"], { T: [B.TERRACOTTA], x: tint(t) });
}

// ---- materials: blocks of 9 and back
for (const [blk, it, name] of [
  [B.IRON_BLOCK, I.IRON_INGOT, "iron"],
  [B.GOLD_BLOCK, I.GOLD_INGOT, "gold"],
  [B.DIAMOND_BLOCK, I.DIAMOND, "diamond"],
  [B.RUBY_BLOCK, I.RUBY, "ruby"],
  [B.COAL_BLOCK, I.COAL, "coal"],
] as [number, number, string][]) {
  shaped(`${name}_block`, "materials", out(blk), ["XXX", "XXX", "XXX"], { X: [it] });
  shapeless(`${name}_from_block`, "materials", out(it, 9), [[blk]]);
}

for (const r of RECIPES) {
  if (r.shape) {
    const w = r.shape[0].length;
    if (r.shape.some((row) => row.length !== w)) throw new Error(`recipe ${r.id}: ragged shape`);
  }
}

/** Width and height a recipe needs. */
export function recipeSize(r: Recipe): [number, number] {
  if (r.shape) return [r.shape[0].length, r.shape.length];
  const n = r.shapeless!.length;
  return n <= 1 ? [1, 1] : n <= 4 ? [2, 2] : [3, 3];
}

/** Grid contents as item ids (0 = empty), row by row, `size` x `size`. */
export type Grid = number[];

/** The recipe matching a crafting grid (2x2 or 3x3), or null. */
export function matchRecipe(grid: Grid, size: number): Recipe | null {
  // bounding box of the filled cells
  let x0 = size;
  let y0 = size;
  let x1 = -1;
  let y1 = -1;
  let filled = 0;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if (grid[y * size + x]) {
        filled++;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
  if (!filled) return null;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const cell = (x: number, y: number) => grid[(y0 + y) * size + x0 + x];
  for (const r of RECIPES) {
    if (r.shape) {
      if (r.shape.length !== h || r.shape[0].length !== w) continue;
      for (const mirror of [false, true]) {
        let ok = true;
        for (let y = 0; y < h && ok; y++)
          for (let x = 0; x < w && ok; x++) {
            const ch = r.shape[y][mirror ? w - 1 - x : x];
            const id = cell(x, y);
            if (ch === " ") ok = id === 0;
            else ok = id !== 0 && r.key![ch].includes(id);
          }
        if (ok) return r;
      }
    } else {
      const ings = r.shapeless!;
      if (ings.length !== filled) continue;
      const left = ings.slice();
      let ok = true;
      for (let k = 0; k < size * size && ok; k++) {
        const id = grid[k];
        if (!id) continue;
        const j = left.findIndex((ing) => ing.includes(id));
        if (j < 0) ok = false;
        else left.splice(j, 1);
      }
      if (ok && !left.length) return r;
    }
  }
  return null;
}

/** The ingredients a recipe needs in total (for the recipe book's "craftable now"): [ingredient, count]. */
export function recipeNeeds(r: Recipe): [Ingredient, number][] {
  const m = new Map<string, [Ingredient, number]>();
  const addIng = (ing: Ingredient) => {
    const k = ing.join(",");
    const e = m.get(k);
    if (e) e[1]++;
    else m.set(k, [ing, 1]);
  };
  if (r.shape) for (const row of r.shape) for (const ch of row) if (ch !== " ") addIng(r.key![ch]);
  if (r.shapeless) for (const ing of r.shapeless) addIng(ing);
  return [...m.values()];
}

/** Could these items (id -> count available) make the recipe once? */
export function canMake(r: Recipe, have: Map<number, number>): boolean {
  const left = new Map(have);
  for (const [ing, n] of recipeNeeds(r)) {
    let need = n;
    for (const id of ing) {
      const k = Math.min(need, left.get(id) ?? 0);
      if (k) {
        left.set(id, (left.get(id) ?? 0) - k);
        need -= k;
      }
    }
    if (need > 0) return false;
  }
  return true;
}

/** A grid layout for a recipe in a `size` grid (top-left), choosing for each cell one of the ids the player has
 *  (most plentiful first); used by the recipe book to fill the grid. Null if it does not fit. */
export function layoutFor(r: Recipe, size: number, have: Map<number, number>): Grid | null {
  const [w, h] = recipeSize(r);
  if (w > size || h > size) return null;
  const grid: Grid = new Array(size * size).fill(0);
  const left = new Map(have);
  const pick = (ing: Ingredient): number => {
    const sorted = ing.slice().sort((a, b) => (left.get(b) ?? 0) - (left.get(a) ?? 0));
    const id = sorted[0];
    left.set(id, (left.get(id) ?? 0) - 1);
    return id;
  };
  if (r.shape) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (r.shape[y][x] !== " ") grid[y * size + x] = pick(r.key![r.shape[y][x]]);
  } else {
    r.shapeless!.forEach((ing, k) => (grid[Math.floor(k / size) * size + (k % size)] = pick(ing)));
  }
  return grid;
}
