// Trading with villagers (update 11): rubies are the money. Each job has a handful of fair trades, each with a stock
// that runs down as you trade and comes back in full every 10 minutes (half a game day). The server runs every
// trade on its own copy of your inventory (server/src/survival.ts); the client only shows what it can afford.
// A trade only ever moves items: the cost leaves your inventory and the goods arrive, or nothing happens at all
// (not enough of the cost, no room for the goods, or sold out), so nothing can be duplicated.
// No loop makes rubies from nothing: nothing a villager sells can be turned back into something a villager buys.

import { B } from "./blocks.ts";
import { I, armorId, toolId, type Stack } from "./items.ts";
import { addToInventory, type Items } from "./inventory.ts";

export interface Offer {
  buy: [number, number]; // [item id, count] the villager wants
  buy2?: [number, number];
  sell: [number, number]; // what you get
  max: number; // stock after a restock
}

const R = I.RUBY;
/** Offers per job (shared/villagers.ts JOBS order). */
export const TRADES: Offer[][] = [
  // farmer
  [
    { buy: [I.WHEAT, 20], sell: [R, 1], max: 16 },
    { buy: [B.SUGAR_CANE, 24], sell: [R, 1], max: 16 },
    { buy: [R, 1], sell: [I.BREAD, 6], max: 12 },
    { buy: [R, 1], sell: [I.APPLE, 4], max: 12 },
    { buy: [R, 3], sell: [B.CAKE, 1], max: 4 },
  ],
  // smith
  [
    { buy: [I.COAL, 15], sell: [R, 1], max: 16 },
    { buy: [I.IRON_INGOT, 4], sell: [R, 1], max: 12 },
    { buy: [R, 2], sell: [toolId(2, 3), 1], max: 3 }, // iron sword
    { buy: [R, 3], sell: [toolId(2, 0), 1], max: 3 }, // iron pickaxe
    { buy: [R, 6], sell: [armorId(1, 1), 1], max: 2 }, // iron chestplate
    // v13: lava from the forge, in your own bucket (it sets into obsidian where it meets water)
    { buy: [R, 2], buy2: [I.BUCKET, 1], sell: [I.LAVA_BUCKET, 1], max: 4 },
  ],
  // librarian
  [
    { buy: [I.PAPER, 24], sell: [R, 1], max: 16 },
    { buy: [R, 1], sell: [B.BOOKSHELF, 1], max: 8 },
    { buy: [R, 1], sell: [B.LANTERN, 2], max: 8 },
    { buy: [R, 1], sell: [B.GLASS, 4], max: 12 },
    // v13: a bound book (three of your paper and a ruby for the binding)
    { buy: [R, 1], buy2: [I.PAPER, 3], sell: [I.BOOK, 1], max: 4 },
  ],
  // fisher
  [
    { buy: [I.STRING, 12], sell: [R, 1], max: 16 },
    { buy: [I.COCONUT, 6], sell: [R, 1], max: 12 },
    { buy: [R, 1], sell: [I.SMOKED_FISH, 4], max: 12 },
    { buy: [R, 2], sell: [I.BOAT, 1], max: 3 },
    { buy: [R, 1], sell: [I.BUCKET, 1], max: 4 },
  ],
  // mason
  [
    { buy: [I.CLAY_BALL, 12], sell: [R, 1], max: 16 },
    { buy: [B.COBBLESTONE, 20], sell: [R, 1], max: 16 },
    { buy: [R, 1], sell: [B.BRICKS, 8], max: 12 },
    { buy: [R, 1], sell: [B.TERRACOTTA + 1, 8], max: 12 }, // cream terracotta
    { buy: [R, 1], sell: [B.STONE_BRICKS, 6], max: 12 },
  ],
];

export const RESTOCK_MS = 10 * 60 * 1000;

/** How many of an item (undamaged) the 36 inventory slots hold. */
export function countOf(inv: Items, id: number): number {
  let n = 0;
  for (const s of inv) if (s && s.id === id && s.d === 0) n += s.n;
  return n;
}

export function canAfford(inv: Items, o: Offer): boolean {
  if (o.buy2 && o.buy2[0] === o.buy[0]) return countOf(inv, o.buy[0]) >= o.buy[1] + o.buy2[1];
  return countOf(inv, o.buy[0]) >= o.buy[1] && (!o.buy2 || countOf(inv, o.buy2[0]) >= o.buy2[1]);
}

/** Take `n` of an item: from the main inventory first (9-35, from the end), then the hotbar (8 down to 0). */
function take(inv: Items, id: number, n: number): void {
  const order = [...Array(27).keys()].map((k) => 35 - k).concat([8, 7, 6, 5, 4, 3, 2, 1, 0]);
  for (const k of order) {
    const s = inv[k];
    if (!s || s.id !== id || s.d !== 0) continue;
    const t = Math.min(n, s.n);
    inv[k] = s.n - t > 0 ? { ...s, n: s.n - t } : null;
    n -= t;
    if (n === 0) return;
  }
}

/** One trade on an inventory (36 slots): the cost goes, the goods arrive. False (and nothing changed) if the cost
 *  isn't there or the goods don't fit. */
export function tradeOnce(inv: Items, o: Offer): boolean {
  if (!canAfford(inv, o)) return false;
  const copy: Items = inv.map((s) => (s ? { ...s } : null));
  take(copy, o.buy[0], o.buy[1]);
  if (o.buy2) take(copy, o.buy2[0], o.buy2[1]);
  const goods: Stack = { id: o.sell[0], n: o.sell[1], d: 0 };
  if (addToInventory(copy, goods) > 0) return false;
  for (let k = 0; k < inv.length; k++) inv[k] = copy[k];
  return true;
}

/** An offer and its stock, for the wire: a/b the cost, r the goods, n left, m the full stock. */
export interface WireOffer {
  a: [number, number];
  b?: [number, number];
  r: [number, number];
  n: number;
  m: number;
}

export function wireOffers(job: number, stock: number[]): WireOffer[] {
  return (TRADES[job] ?? []).map((o, k) => ({ a: o.buy, ...(o.buy2 ? { b: o.buy2 } : {}), r: o.sell, n: stock[k] ?? 0, m: o.max }));
}

export const fullStock = (job: number) => (TRADES[job] ?? []).map((o) => o.max);
