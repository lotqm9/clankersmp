// clankersmp (v14): an AI keeps its inventory the way a tidy player does (Laith: "organize their tools better inside
// their inventory so it's not messy"). The hotbar has fixed places, so a tool is a key press away and never a swap:
//   0 weapon (the best sword, else the best axe)   1 pickaxe   2 axe   3 shovel   4 food   5 torches
//   6, 7 building blocks (the most it carries)     8 spare: the bow, else a third block; anything else taken in hand
//   goes here, so the rest stay put (Body.hold)
// Part stacks of the same thing are put together. It sorts with its inventory screen open (server: ainv), a move at a
// time (aswap), so whoever watches it sees it working in its inventory. Junk goes out with Body.tidyInventory.

import type { Body } from "./body.ts";
import { B } from "../shared/blocks.ts";
import { I, itemDef, maxStack, plainOf, sameItem, type Stack } from "../shared/items.ts";

/** The blocks a builder keeps to hand, best first. */
const BLOCKS_TO_HAND = [B.COBBLESTONE, B.OAK_PLANKS, B.STONE_BRICKS, B.BIRCH_PLANKS, B.STONE, B.BRICKS, B.DIRT];

/** What each hotbar slot should hold now (item ids; 0: nothing in particular). */
export function hotbarPlan(b: Body): number[] {
  const plan = new Array(9).fill(0);
  const stacks = b.inv.filter((s): s is Stack => !!s);
  const best = (kind: string, score: (id: number) => number) => {
    let id = 0;
    let top = -Infinity;
    for (const s of stacks) {
      if (itemDef(plainOf(s.id))?.tool?.kind !== kind) continue;
      const v = score(s.id);
      if (v > top) [top, id] = [v, s.id];
    }
    return id;
  };
  const dmg = (id: number) => itemDef(id)?.tool?.damage ?? 0;
  const dig = (id: number) => (itemDef(id)?.tool?.tier ?? 0) * 100 + (itemDef(id)?.tool?.speed ?? 0);
  const sword = best("sword", dmg);
  const axe = best("axe", (id) => dig(id) + dmg(id));
  plan[0] = sword || axe;
  plan[1] = best("pickaxe", dig);
  plan[2] = sword ? axe : 0;
  plan[3] = best("shovel", dig);
  // food: the most filling that doesn't make it queasy (spoiled flesh last of all)
  let food = 0;
  let fv = -Infinity;
  for (const s of stacks) {
    const f = itemDef(s.id)?.food;
    if (!f) continue;
    const v = f.hunger + f.sat * 0.5 - (f.queasy ? 20 : 0);
    if (v > fv) [fv, food] = [v, s.id];
  }
  plan[4] = food;
  plan[5] = b.has(B.TORCH) ? B.TORCH : 0;
  const blocks = BLOCKS_TO_HAND.filter((id) => b.count(id) >= 4).sort((p, q) => b.count(q) - b.count(p));
  plan[6] = blocks[0] ?? 0;
  plan[7] = blocks[1] ?? 0;
  plan[8] = b.has(I.BOW) ? I.BOW : (blocks[2] ?? 0);
  return plan;
}

/** The moves that would tidy it: part stacks put together, then each hotbar place given its thing. */
function nextMove(inv: (Stack | null)[], plan: number[]): [number, number] | null {
  // two part stacks of the same thing: the smaller onto the bigger
  for (let k = 0; k < 36; k++) {
    const a = inv[k];
    if (!a || a.n >= maxStack(a.id)) continue;
    for (let j = 0; j < 36; j++) {
      const c = inv[j];
      if (j === k || !c || !sameItem(a, c) || c.n >= maxStack(c.id) || c.n < a.n || (c.n === a.n && j > k)) continue;
      return [k, j];
    }
  }
  // the hotbar's places, in order
  for (let s = 0; s < 9; s++) {
    const want = plan[s];
    if (!want || inv[s]?.id === want) continue;
    // the biggest stack of it not already in its own planned place
    let from = -1;
    for (let k = 0; k < 36; k++) {
      if (k === s || inv[k]?.id !== want || (k < 9 && plan[k] === want && inv[k]?.id === want)) continue;
      if (from < 0 || inv[k]!.n > inv[from]!.n) from = k;
    }
    if (from >= 0) return [from, s];
  }
  return null;
}

/** How far it is from tidy: the moves sorting would make (capped). */
export function messiness(b: Body): number {
  const plan = hotbarPlan(b);
  const copy = b.inv.map((s) => (s ? { ...s } : null));
  let n = 0;
  for (; n < 20; n++) {
    const m = nextMove(copy, plan);
    if (!m) break;
    const [a, c] = m;
    const A = copy[a]!;
    const C = copy[c];
    if (C && sameItem(A, C) && maxStack(A.id) > 1) {
      const k = Math.min(maxStack(A.id) - C.n, A.n);
      copy[c] = { ...C, n: C.n + k };
      copy[a] = A.n - k > 0 ? { ...A, n: A.n - k } : null;
    } else {
      copy[a] = C;
      copy[c] = A;
    }
  }
  return n;
}

/** Sort the inventory with its screen open, a move at a time (watchers see each one): part stacks together, the
 *  hotbar's fixed places filled. What it did. */
export async function organize(b: Body, maxMoves = 24): Promise<string> {
  const plan = hotbarPlan(b);
  let moves = 0;
  b.halt();
  b.send({ t: "ainv", open: true });
  await b.wait(8); // the screen comes up for whoever watches
  try {
    for (; moves < maxMoves && !b.abort && !b.dead; moves++) {
      const m = nextMove(b.inv, plan);
      if (!m) break;
      const before = JSON.stringify([b.inv[m[0]], b.inv[m[1]]]);
      b.send({ t: "aswap", a: m[0], b: m[1] });
      // the slots come back with the server's next tick; a beat between moves, the pace of a hand on a mouse
      for (let t = 0; t < 12 && JSON.stringify([b.inv[m[0]], b.inv[m[1]]]) === before; t++) await b.nextTick();
      await b.wait(3);
    }
    // the thing it held is still in its hand: its place on the hotbar
    const held = b.inv.findIndex((s, k) => k < 9 && !!s && s.id === plan[0]);
    if (held >= 0 && b.sel !== held) {
      b.sel = held;
      b.send({ t: "sel", s: held });
    }
  } finally {
    await b.wait(6);
    b.send({ t: "ainv", open: false });
  }
  return moves ? `sorted its inventory (${moves} moves): ${describe(b)}` : `its inventory was in order: ${describe(b)}`;
}

/** The hotbar in words. */
export function describe(b: Body): string {
  const names = ["weapon", "pickaxe", "axe", "shovel", "food", "torches", "blocks", "blocks", "spare"];
  return b.inv
    .slice(0, 9)
    .map((s, k) => (s ? `${k + 1} ${itemDef(s.id)?.key ?? s.id}${s.n > 1 ? ` x${s.n}` : ""}` : `${k + 1} (${names[k]}: none)`))
    .join(", ");
}
