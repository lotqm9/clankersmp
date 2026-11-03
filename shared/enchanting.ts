// Enchanting (protocol v13): the enchanting table makes gear better for rubies, the island's money. There is no XP in
// this world, and rubies already are what everything is worth (mined deep, traded with the villagers), so the table
// takes rubies where Java takes levels and lapis. Bookshelves round the table (Java's ring: two blocks out, at the
// table's height or one up) unlock the higher levels, like Java's 15 shelves for the top offers.
//   Sharpness   swords and axes       +0.5 x level + 0.5 damage a hit
//   Efficiency  pickaxes and shovels  +level^2 + 1 mining speed
//   Protection  every piece of armour 4% less damage a level, all the pieces together (at most 80%)
// One enchantment an item, level I to III; an enchanted item can be taken higher (paying for the new level). It keeps
// its wear. Enchanted gear is its own item (shared/items.ts ENCHANTABLE), so nothing about stacks or saves changes.

import { B, IS_WATER } from "./blocks.ts";
import { ENCH_MAX, enchKindOf, enchantedId, itemDef, plainOf, type EnchKind } from "./items.ts";

/** Lava from the smith's bucket sets into obsidian the moment it meets water (Java's rule for a lava source): it can
 *  be poured into water, or onto a spot with water beside it (any of the six sides). */
export function waterBeside(get: (x: number, y: number, z: number) => number, x: number, y: number, z: number): boolean {
  for (const [dx, dy, dz] of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) if (IS_WATER[get(x + dx, y + dy, z + dz)]) return true;
  return false;
}

/** Rubies a level costs (index = level). */
export const ENCH_COST = [0, 2, 4, 7];
/** Bookshelves round the table a level needs. */
export const ENCH_SHELVES = [0, 0, 5, 10];

/** Bookshelves round an enchanting table at (x, y, z): the 5 x 5 ring two blocks out, on the table's level and the
 *  one above (up to 32). */
export function shelvesAround(get: (x: number, y: number, z: number) => number, x: number, y: number, z: number): number {
  let n = 0;
  for (let dy = 0; dy <= 1; dy++)
    for (let dz = -2; dz <= 2; dz++)
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== 2) continue;
        if (get(x + dx, y + dy, z + dz) === B.BOOKSHELF) n++;
      }
  return n;
}

/** The highest level the shelves round a table allow. */
export function levelForShelves(shelves: number): number {
  let l = 1;
  while (l < ENCH_MAX && shelves >= ENCH_SHELVES[l + 1]) l++;
  return l;
}

export interface EnchantPlan {
  id: number; // the enchanted item it becomes (0: none)
  level: number;
  cost: number;
  kind: EnchKind | null;
  why?: string;
}

/** What enchanting `held` would do: the highest level the shelves allow and the rubies pay for (or `want`, if that
 *  is allowed and paid for), never a level the item already has. */
export function planEnchant(held: number, rubies: number, shelves: number, want = 0): EnchantPlan {
  const base = plainOf(held);
  const kind = enchKindOf(base);
  if (!kind) return { id: 0, level: 0, cost: 0, kind: null, why: "only swords, axes, pickaxes, shovels and armour can be enchanted" };
  const has = itemDef(held)?.ench?.level ?? 0;
  const top = levelForShelves(shelves);
  if (has >= ENCH_MAX) return { id: 0, level: 0, cost: 0, kind, why: "it is already enchanted as high as it goes" };
  let level = want ? Math.min(want, top) : top;
  if (want > top) return { id: 0, level: 0, cost: 0, kind, why: `level ${want} needs ${ENCH_SHELVES[want]} bookshelves round the table (there are ${shelves})` };
  while (level > has && ENCH_COST[level] > rubies && !want) level--;
  if (level <= has) return { id: 0, level: 0, cost: 0, kind, why: has ? `it already has level ${has}${top <= has ? ` (more bookshelves round the table for level ${has + 1}: ${ENCH_SHELVES[has + 1]})` : ` (level ${has + 1} costs ${ENCH_COST[has + 1]} rubies, you have ${rubies})`}` : `level 1 costs ${ENCH_COST[1]} rubies, you have ${rubies}` };
  if (ENCH_COST[level] > rubies) return { id: 0, level: 0, cost: 0, kind, why: `level ${level} costs ${ENCH_COST[level]} rubies, you have ${rubies}` };
  return { id: enchantedId(base, level), level, cost: ENCH_COST[level], kind };
}
