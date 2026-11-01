// Windows ("menus") over item containers, and every click a player can make in them (protocol v5), following Java
// Edition's container rules: pick up / place / swap / split with the mouse, shift-click to move a stack across,
// number keys to swap with the hotbar, Q to throw, drag to spread a stack over slots, double-click to gather, and
// the recipe book filling the crafting grid. The server runs these on its own copies (the authority) and the client
// runs the same code to predict; the server's answer always wins. Items are only ever moved, crafted (inputs become
// the output) or thrown (become drops): never created, so a duplicate can't happen.
//
// Slot layouts (window slot indexes, like Java):
//   player:   0 craft result, 1-4 the 2x2 grid, 5-8 armour, 9-35 inventory, 36-44 hotbar
//   crafting: 0 result, 1-9 the 3x3 grid, 10-36 inventory, 37-45 hotbar
//   furnace:  0 input, 1 fuel, 2 output, 3-29 inventory, 30-38 hotbar
//   chest:    0-26 the chest, 27-53 inventory, 54-62 hotbar
//   trade:    0-26 inventory, 27-35 hotbar (v9: the villager's offers are drawn above, not slots)
// The player's own inventory array is 36 long: 0-8 hotbar, 9-35 the rest.

import { cloneStack, fuelTicks, itemDef, maxStack, sameItem, SMELT, type Stack } from "./items.ts";
import { layoutFor, matchRecipe, RECIPES, type Grid } from "./recipes.ts";

export type Items = (Stack | null)[];
export type MenuKind = "player" | "crafting" | "furnace" | "chest" | "trade";
type SlotKind = "normal" | "result" | "output" | "fuel" | "armor" | "grid";

interface Slot {
  c: Items;
  i: number;
  kind: SlotKind;
}

export type Click =
  | { m: "pick"; s: number; b: 0 | 1 }
  | { m: "shift"; s: number }
  | { m: "swap"; s: number; h: number }
  | { m: "throw"; s: number; all: boolean }
  | { m: "out"; b: 0 | 1 }
  | { m: "drag"; b: 0 | 1; list: number[] }
  | { m: "collect"; s: number }
  | { m: "fill"; r: string; all: boolean };

export interface ClickResult {
  drops: Stack[]; // thrown out of the window (the server spawns them in front of the player)
  crafted: Stack[]; // what the result slot produced (for stats and sounds)
}

export const INV_SIZE = 36;
export const HOTBAR = 9;

/** A player's own containers. */
export interface PlayerInv {
  inv: Items; // 36
  armor: Items; // 4: helmet, chestplate, leggings, boots (v6)
  craft: Items; // the 2x2 grid (4)
}

export function newPlayerInv(): PlayerInv {
  return { inv: new Array(INV_SIZE).fill(null), armor: new Array(4).fill(null), craft: new Array(4).fill(null) };
}

export class Menu {
  readonly kind: MenuKind;
  readonly slots: Slot[] = [];
  /** The player-inventory part of the window: [start, hotbarStart, end). */
  readonly invStart: number;
  readonly hotStart: number;
  readonly end: number;
  private grid: Items | null = null;
  private gridSize = 0;
  private result: Items = [null];

  constructor(kind: MenuKind, p: PlayerInv, container: Items | null = null) {
    this.kind = kind;
    const add = (c: Items, i: number, k: SlotKind) => this.slots.push({ c, i, kind: k });
    if (kind === "player") {
      add(this.result, 0, "result");
      for (let i = 0; i < 4; i++) add(p.craft, i, "grid");
      for (let i = 0; i < 4; i++) add(p.armor, i, "armor");
      this.grid = p.craft;
      this.gridSize = 2;
    } else if (kind === "crafting") {
      if (!container || container.length !== 9) throw new Error("crafting needs a 9-slot grid");
      add(this.result, 0, "result");
      for (let i = 0; i < 9; i++) add(container, i, "grid");
      this.grid = container;
      this.gridSize = 3;
    } else if (kind === "furnace") {
      if (!container || container.length !== 3) throw new Error("furnace needs 3 slots");
      add(container, 0, "normal");
      add(container, 1, "fuel");
      add(container, 2, "output");
    } else if (kind === "trade") {
      // v9: a villager's trades sit above; the window holds only your inventory (trades are their own message)
    } else {
      if (!container || container.length !== 27) throw new Error("chest needs 27 slots");
      for (let i = 0; i < 27; i++) add(container, i, "normal");
    }
    this.invStart = this.slots.length;
    for (let i = 9; i < 36; i++) add(p.inv, i, "normal");
    this.hotStart = this.slots.length;
    for (let i = 0; i < 9; i++) add(p.inv, i, "normal");
    this.end = this.slots.length;
    this.updateResult();
  }

  get size(): number {
    return this.slots.length;
  }

  get(s: number): Stack | null {
    const sl = this.slots[s];
    return sl ? sl.c[sl.i] : null;
  }

  private setSlot(s: number, v: Stack | null): void {
    const sl = this.slots[s];
    sl.c[sl.i] = v && v.n > 0 ? v : null;
    if (sl.kind === "grid") this.updateResult();
  }

  /** Everything in the window, for the wire. */
  contents(): (Stack | null)[] {
    return this.slots.map((s) => s.c[s.i]);
  }

  /** The client: take the server's contents for every slot (the crafting result is worked out again). */
  setContents(items: (Stack | null)[]): void {
    this.slots.forEach((sl, k) => {
      if (sl.kind === "result") return;
      sl.c[sl.i] = items[k] && items[k]!.n > 0 ? { ...items[k]! } : null;
    });
    this.updateResult();
  }

  /** What kind of slot this is (the UI draws result and output slots bigger). */
  slotKind(s: number): string {
    return this.slots[s]?.kind ?? "normal";
  }

  /** The crafting result for the grid now (recomputed after every change to the grid). */
  updateResult(): void {
    if (!this.grid) return;
    const r = matchRecipe(this.gridIds(), this.gridSize);
    this.result[0] = r ? { ...r.out } : null;
  }

  private gridIds(): Grid {
    return this.grid!.map((s) => (s ? s.id : 0));
  }

  private mayPlace(s: number, st: Stack): boolean {
    const k = this.slots[s].kind;
    if (k === "result" || k === "output") return false;
    if (k === "fuel") return fuelTicks(st.id) > 0;
    if (k === "armor") return itemDef(st.id)?.armor?.slot === this.slots[s].i; // only the matching piece
    return true;
  }

  /** Slot capacity for this item. */
  private cap(st: Stack): number {
    return maxStack(st.id);
  }

  // ---------------------------------------------------------------- crafting

  /** Take one craft from the result slot: consumes one item from every filled grid cell. Returns the output.
   *  v7: an ingredient with a remainder leaves it in its cell (a milk bucket leaves its empty bucket); those are
   *  single items, so the cell is always free for it. */
  private craftOnce(): Stack | null {
    const r = this.result[0];
    if (!r || !this.grid) return null;
    const outStack = cloneStack(r)!;
    for (let k = 0; k < this.grid.length; k++) {
      const g = this.grid[k];
      if (!g) continue;
      const rem = itemDef(g.id)?.remainder;
      g.n--;
      if (g.n <= 0) this.grid[k] = rem ? { id: rem, n: 1, d: 0 } : null;
    }
    this.updateResult();
    return outStack;
  }

  // ---------------------------------------------------------------- moving stacks

  /** Merge `st` into slots [start, end) (backwards if `rev`): existing stacks first, then empty slots. Returns what
   *  did not fit (or null). */
  private moveTo(st: Stack, start: number, end: number, rev: boolean): Stack | null {
    const order: number[] = [];
    for (let s = start; s < end; s++) order.push(s);
    if (rev) order.reverse();
    let left: Stack | null = cloneStack(st);
    for (const s of order) {
      if (!left) break;
      const cur = this.get(s);
      if (!cur || !sameItem(cur, left) || !this.mayPlace(s, left)) continue;
      const room = this.cap(left) - cur.n;
      if (room <= 0) continue;
      const k = Math.min(room, left.n);
      this.setSlot(s, { ...cur, n: cur.n + k });
      left.n -= k;
      if (left.n <= 0) left = null;
    }
    for (const s of order) {
      if (!left) break;
      if (this.get(s) || !this.mayPlace(s, left)) continue;
      const k = Math.min(this.cap(left), left.n);
      this.setSlot(s, { ...left, n: k });
      left.n -= k;
      if (left.n <= 0) left = null;
    }
    return left;
  }

  /** Where shift-click sends a stack from slot s: [start, end, reverse] ranges to try in order. */
  private shiftTargets(s: number, st: Stack): [number, number, boolean][] {
    const inv: [number, number, boolean] = [this.invStart, this.end, false];
    const invRev: [number, number, boolean] = [this.invStart, this.end, true];
    const main: [number, number, boolean] = [this.invStart, this.hotStart, false];
    const hot: [number, number, boolean] = [this.hotStart, this.end, false];
    const inPlayerPart = s >= this.invStart;
    if (this.kind === "chest") return inPlayerPart ? [[0, 27, false]] : [invRev];
    if (this.kind === "furnace") {
      if (!inPlayerPart) return [inv];
      const t: [number, number, boolean][] = [];
      if (SMELT[st.id] !== undefined) t.push([0, 1, false]);
      if (fuelTicks(st.id) > 0) t.push([1, 2, false]);
      t.push(s < this.hotStart ? hot : main);
      return t;
    }
    // player and crafting: grid/armour -> inventory; inventory <-> hotbar; armour from the inventory goes on first
    if (!inPlayerPart) return [inv];
    const a = itemDef(st.id)?.armor;
    if (this.kind === "player" && a && !this.get(5 + a.slot)) return [[5 + a.slot, 6 + a.slot, false]];
    return [s < this.hotStart ? hot : main];
  }

  // ---------------------------------------------------------------- clicks

  /** Apply a click. `cur` is the stack on the mouse cursor (mutated through the returned object). */
  click(c: Click, cursor: { s: Stack | null }): ClickResult {
    const res: ClickResult = { drops: [], crafted: [] };
    const valid = (s: number) => Number.isInteger(s) && s >= 0 && s < this.slots.length;
    switch (c.m) {
      case "pick": {
        if (!valid(c.s) || (c.b !== 0 && c.b !== 1)) return res;
        this.pick(c.s, c.b, cursor, res);
        break;
      }
      case "shift": {
        if (!valid(c.s)) return res;
        this.shift(c.s, res);
        break;
      }
      case "swap": {
        if (!valid(c.s) || !Number.isInteger(c.h) || c.h < 0 || c.h > 8) return res;
        this.swap(c.s, c.h, res);
        break;
      }
      case "throw": {
        if (!valid(c.s) || cursor.s) return res;
        const k = this.slots[c.s].kind;
        if (k === "result") {
          const o = this.craftOnce();
          if (o) {
            res.crafted.push(cloneStack(o)!);
            res.drops.push(o);
          }
          break;
        }
        const st = this.get(c.s);
        if (!st) return res;
        const n = c.all ? st.n : 1;
        res.drops.push({ ...st, n });
        this.setSlot(c.s, st.n - n > 0 ? { ...st, n: st.n - n } : null);
        break;
      }
      case "out": {
        if (!cursor.s) return res;
        if (c.b === 0) {
          res.drops.push(cursor.s);
          cursor.s = null;
        } else {
          res.drops.push({ ...cursor.s, n: 1 });
          cursor.s = cursor.s.n > 1 ? { ...cursor.s, n: cursor.s.n - 1 } : null;
        }
        break;
      }
      case "drag": {
        this.drag(c.b, c.list, cursor);
        break;
      }
      case "collect": {
        if (!valid(c.s) || !cursor.s) return res;
        const want = cursor.s;
        for (let s = 0; s < this.slots.length && want.n < this.cap(want); s++) {
          const k = this.slots[s].kind;
          if (k === "result" || k === "output" || k === "armor") continue;
          const st = this.get(s);
          if (!st || !sameItem(st, want)) continue;
          const take = Math.min(st.n, this.cap(want) - want.n);
          want.n += take;
          this.setSlot(s, st.n - take > 0 ? { ...st, n: st.n - take } : null);
        }
        break;
      }
      case "fill": {
        if (cursor.s) return res;
        this.fill(c.r, c.all);
        break;
      }
    }
    return res;
  }

  private pick(s: number, b: 0 | 1, cursor: { s: Stack | null }, res: ClickResult): void {
    const kind = this.slots[s].kind;
    const st = this.get(s);
    if (kind === "result") {
      const r = this.result[0];
      if (!r) return;
      if (cursor.s && !(sameItem(cursor.s, r) && cursor.s.n + r.n <= this.cap(r))) return;
      const o = this.craftOnce();
      if (!o) return;
      res.crafted.push(cloneStack(o)!);
      cursor.s = cursor.s ? { ...cursor.s, n: cursor.s.n + o.n } : o;
      return;
    }
    if (kind === "output") {
      if (!st) return;
      if (!cursor.s) {
        cursor.s = st;
        this.setSlot(s, null);
      } else if (sameItem(cursor.s, st)) {
        const k = Math.min(st.n, this.cap(st) - cursor.s.n);
        if (k <= 0) return;
        cursor.s = { ...cursor.s, n: cursor.s.n + k };
        this.setSlot(s, st.n - k > 0 ? { ...st, n: st.n - k } : null);
      }
      return;
    }
    if (!cursor.s) {
      if (!st) return;
      if (b === 0) {
        cursor.s = st;
        this.setSlot(s, null);
      } else {
        const k = Math.ceil(st.n / 2);
        cursor.s = { ...st, n: k };
        this.setSlot(s, st.n - k > 0 ? { ...st, n: st.n - k } : null);
      }
      return;
    }
    const cur = cursor.s;
    if (!this.mayPlace(s, cur)) {
      // A slot that won't take the cursor item can still give its own (fuel slot with a non-fuel cursor).
      return;
    }
    if (!st) {
      const k = b === 0 ? Math.min(cur.n, this.cap(cur)) : 1;
      this.setSlot(s, { ...cur, n: k });
      cursor.s = cur.n - k > 0 ? { ...cur, n: cur.n - k } : null;
      return;
    }
    if (sameItem(st, cur)) {
      const room = this.cap(cur) - st.n;
      const k = Math.min(room, b === 0 ? cur.n : 1);
      if (k <= 0) return;
      this.setSlot(s, { ...st, n: st.n + k });
      cursor.s = cur.n - k > 0 ? { ...cur, n: cur.n - k } : null;
      return;
    }
    if (cur.n <= this.cap(cur)) {
      this.setSlot(s, cur);
      cursor.s = st;
    }
  }

  private shift(s: number, res: ClickResult): void {
    const kind = this.slots[s].kind;
    if (kind === "result") {
      // Craft as many as fit, straight into the inventory (hotbar end first, like Java).
      for (let k = 0; k < 64; k++) {
        const r = this.result[0];
        if (!r) break;
        // only craft if the whole output fits
        if (!this.fits(r, this.invStart, this.end)) break;
        const o = this.craftOnce();
        if (!o) break;
        res.crafted.push(cloneStack(o)!);
        const left = this.moveTo(o, this.invStart, this.end, true);
        if (left) throw new Error("inventory changed while crafting"); // fits() said it would fit
      }
      return;
    }
    const st = this.get(s);
    if (!st) return;
    let left: Stack | null = st;
    for (const [a, b, rev] of this.shiftTargets(s, st)) {
      if (!left) break;
      left = this.moveTo(left, a, b, rev);
    }
    this.setSlot(s, left);
  }

  /** Would `st` fit completely into slots [start, end)? */
  private fits(st: Stack, start: number, end: number): boolean {
    let need = st.n;
    for (let s = start; s < end && need > 0; s++) {
      const cur = this.get(s);
      if (!cur) need -= this.cap(st);
      else if (sameItem(cur, st)) need -= this.cap(st) - cur.n;
    }
    return need <= 0;
  }

  private swap(s: number, h: number, res: ClickResult): void {
    const hs = this.hotStart + h;
    if (hs === s) return;
    const kind = this.slots[s].kind;
    const hot = this.get(hs);
    if (kind === "result") {
      const r = this.result[0];
      if (!r || hot) return;
      const o = this.craftOnce();
      if (!o) return;
      res.crafted.push(cloneStack(o)!);
      this.setSlot(hs, o);
      return;
    }
    const st = this.get(s);
    if (kind === "output") {
      if (!st) return;
      if (!hot) {
        this.setSlot(hs, st);
        this.setSlot(s, null);
      }
      return;
    }
    if (hot && !this.mayPlace(s, hot)) return;
    this.setSlot(s, hot);
    this.setSlot(hs, st);
  }

  private drag(b: 0 | 1, list: unknown, cursor: { s: Stack | null }): void {
    if (!cursor.s || !Array.isArray(list)) return;
    const cur = cursor.s;
    const seen = new Set<number>();
    const targets: number[] = [];
    for (const s of list) {
      if (!Number.isInteger(s) || s < 0 || s >= this.slots.length || seen.has(s)) continue;
      seen.add(s);
      const st = this.get(s);
      if (!this.mayPlace(s, cur)) continue;
      if (st && !sameItem(st, cur)) continue;
      targets.push(s);
    }
    if (!targets.length) return;
    const each = b === 0 ? Math.floor(cur.n / targets.length) : 1;
    if (each <= 0) return;
    let left = cur.n;
    for (const s of targets) {
      if (left <= 0) break;
      const st = this.get(s);
      const have = st ? st.n : 0;
      const k = Math.min(each, this.cap(cur) - have, left);
      if (k <= 0) continue;
      this.setSlot(s, { ...cur, n: have + k });
      left -= k;
    }
    cursor.s = left > 0 ? { ...cur, n: left } : null;
  }

  /** Recipe book: put the grid back into the inventory, then lay out the recipe from the inventory (once, or as many
   *  times as the ingredients and stack sizes allow). Nothing changes if the ingredients aren't all there. */
  private fill(id: string, all: boolean): void {
    if (!this.grid) return;
    const r = RECIPES.find((x) => x.id === id);
    if (!r) return;
    // 1. clear the grid into the inventory (abort if it doesn't fit)
    for (let k = 0; k < this.grid.length; k++) {
      const g = this.grid[k];
      if (!g) continue;
      if (!this.fits(g, this.invStart, this.end)) return;
      this.moveTo(g, this.invStart, this.end, false);
      this.grid[k] = null;
    }
    this.updateResult();
    // 2. count what the inventory holds
    const have = new Map<number, number>();
    for (let s = this.invStart; s < this.end; s++) {
      const st = this.get(s);
      if (st && st.d === 0) have.set(st.id, (have.get(st.id) ?? 0) + st.n);
    }
    const layout = layoutFor(r, this.gridSize, have);
    if (!layout) return;
    // 3. how many times: limited by the ingredients and by each cell's stack size
    let times = 1;
    if (all) {
      const per = new Map<number, number>();
      for (const id2 of layout) if (id2) per.set(id2, (per.get(id2) ?? 0) + 1);
      times = 64;
      for (const [id2, n] of per) times = Math.min(times, Math.floor((have.get(id2) ?? 0) / n), maxStack(id2));
    }
    for (const [id2, n] of countIds(layout)) if ((have.get(id2) ?? 0) < n * times) return;
    if (times <= 0) return;
    // 4. take the items out of the inventory into the grid
    for (let k = 0; k < layout.length; k++) {
      const id2 = layout[k];
      if (!id2) continue;
      let need = times;
      for (let s = this.invStart; s < this.end && need > 0; s++) {
        const st = this.get(s);
        if (!st || st.id !== id2 || st.d !== 0) continue;
        const take = Math.min(need, st.n);
        this.setSlot(s, st.n - take > 0 ? { ...st, n: st.n - take } : null);
        need -= take;
      }
      this.grid[k] = { id: id2, n: times, d: 0 };
    }
    this.updateResult();
  }

  /** Closing: the grid's items and the cursor go back into the inventory; whatever doesn't fit is dropped. */
  close(cursor: { s: Stack | null }): Stack[] {
    const drops: Stack[] = [];
    const back = (st: Stack) => {
      const left = this.moveTo(st, this.invStart, this.end, false);
      if (left) drops.push(left);
    };
    if (this.grid && this.kind === "player") {
      for (let k = 0; k < this.grid.length; k++) {
        const g = this.grid[k];
        if (g) {
          this.grid[k] = null;
          back(g);
        }
      }
      this.updateResult();
    }
    if (this.grid && this.kind === "crafting") {
      for (let k = 0; k < this.grid.length; k++) {
        const g = this.grid[k];
        if (g) {
          this.grid[k] = null;
          back(g);
        }
      }
      this.updateResult();
    }
    if (cursor.s) {
      back(cursor.s);
      cursor.s = null;
    }
    return drops;
  }
}

function countIds(layout: number[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const id of layout) if (id) m.set(id, (m.get(id) ?? 0) + 1);
  return m;
}

/** Add a stack to a player's inventory (pickup): hotbar first, then the rest; existing stacks before empty slots.
 *  Returns how many items did not fit. */
export function addToInventory(inv: Items, st: Stack): number {
  let left = st.n;
  const order = [...Array(INV_SIZE).keys()];
  const max = maxStack(st.id);
  for (const s of order) {
    const cur = inv[s];
    if (!cur || !sameItem(cur, st)) continue;
    const k = Math.min(max - cur.n, left);
    if (k <= 0) continue;
    inv[s] = { ...cur, n: cur.n + k };
    left -= k;
    if (!left) return 0;
  }
  for (const s of order) {
    if (inv[s]) continue;
    const k = Math.min(max, left);
    inv[s] = { ...st, n: k };
    left -= k;
    if (!left) return 0;
  }
  return left;
}

/** Total count of every item (for anti-dupe checks): id:damage -> count. */
export function countItems(...lists: (Items | (Stack | null)[])[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lists)
    for (const s of l) {
      if (!s) continue;
      const k = `${s.id}:${s.d}`;
      m.set(k, (m.get(k) ?? 0) + s.n);
    }
  return m;
}

export function isToolItem(id: number): boolean {
  return !!itemDef(id)?.tool;
}
