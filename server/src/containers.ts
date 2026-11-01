// Furnaces and chests for one shard (protocol v5), keyed by block cell. The server owns their contents (players
// only ever click on them through windows, shared/inventory.ts) and ticks every furnace that has work to do at 20 Hz,
// whether anyone is near or not, so smelting carries on while you're away. Saved to containers.json.
//
// Furnace (Java): fuel burns for its burn time; while it burns and the input can be smelted into the output slot,
// cooking advances 1 a tick and one item is done every 200 ticks. With no fuel the progress falls back 2 a tick.
// The block shows lit while fuel burns.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { B, isFurnace, isStorage } from "../../shared/blocks.ts";
import { SMELT, SMELT_TICKS, fromWire, fuelTicks, maxStack, toWire, type Stack } from "../../shared/items.ts";
import type { Items } from "../../shared/inventory.ts";

export interface Furnace {
  items: Items; // input, fuel, output
  burn: number; // ticks of fuel left
  burnMax: number;
  cook: number; // 0..SMELT_TICKS
}

export class Containers {
  readonly furnaces = new Map<number, Furnace>();
  readonly chests = new Map<number, Items>();
  private active = new Set<number>();
  private path: string;
  /** Called when a furnace's contents (`items`) or just its progress changed (to update open windows). */
  onChange: (cell: number, items: boolean) => void = () => {};

  constructor(dir: string) {
    this.path = join(dir, "containers.json");
  }

  furnace(cell: number): Furnace {
    let f = this.furnaces.get(cell);
    if (!f) {
      f = { items: [null, null, null], burn: 0, burnMax: 0, cook: 0 };
      this.furnaces.set(cell, f);
    }
    return f;
  }

  chest(cell: number): Items {
    let c = this.chests.get(cell);
    if (!c) {
      c = new Array(27).fill(null);
      this.chests.set(cell, c);
    }
    return c;
  }

  /** A furnace's contents may have changed: check whether it has work to do. */
  wake(cell: number): void {
    if (this.furnaces.has(cell)) this.active.add(cell);
  }

  /** The block at `cell` went away: its contents, to drop on the ground. */
  remove(cell: number): Stack[] {
    const out: Stack[] = [];
    const f = this.furnaces.get(cell);
    if (f) for (const s of f.items) if (s) out.push(s);
    const c = this.chests.get(cell);
    if (c) for (const s of c) if (s) out.push(s);
    this.furnaces.delete(cell);
    this.chests.delete(cell);
    this.active.delete(cell);
    return out;
  }

  /** Drop the records whose block is no longer a furnace/chest (after a rollback or reset). Returns lost stacks. */
  prune(blockAt: (cell: number) => number): void {
    for (const cell of [...this.furnaces.keys()]) if (!isFurnace(blockAt(cell))) this.furnaces.delete(cell);
    for (const cell of [...this.chests.keys()]) if (!isStorage(blockAt(cell))) this.chests.delete(cell);
  }

  private canSmelt(f: Furnace): boolean {
    const inp = f.items[0];
    if (!inp) return false;
    const outId = SMELT[inp.id];
    if (outId === undefined) return false;
    const out = f.items[2];
    if (!out) return true;
    return out.id === outId && out.d === 0 && out.n < maxStack(outId);
  }

  /** One tick for every busy furnace. `setLit(cell, lit)` updates the block when the fire starts or goes out. */
  tick(setLit: (cell: number, lit: boolean) => void): void {
    for (const cell of [...this.active]) {
      const f = this.furnaces.get(cell);
      if (!f) {
        this.active.delete(cell);
        continue;
      }
      const wasLit = f.burn > 0;
      let changed = false;
      if (f.burn > 0) f.burn--;
      const can = this.canSmelt(f);
      if (f.burn === 0 && can && f.items[1]) {
        const ft = fuelTicks(f.items[1].id);
        if (ft > 0) {
          f.burn = f.burnMax = ft;
          f.items[1] = f.items[1].n > 1 ? { ...f.items[1], n: f.items[1].n - 1 } : null;
          changed = true;
        }
      }
      if (f.burn > 0 && can) {
        f.cook++;
        if (f.cook >= SMELT_TICKS) {
          f.cook = 0;
          const inp = f.items[0]!;
          const outId = SMELT[inp.id];
          f.items[0] = inp.n > 1 ? { ...inp, n: inp.n - 1 } : null;
          const out = f.items[2];
          f.items[2] = out ? { ...out, n: out.n + 1 } : { id: outId, n: 1, d: 0 };
          changed = true;
        }
      } else if (f.cook > 0) f.cook = Math.max(0, f.cook - 2);
      const lit = f.burn > 0;
      if (lit !== wasLit) setLit(cell, lit);
      if (changed || lit || f.cook > 0) this.onChange(cell, changed);
      // idle: nothing burning, nothing cooking, and nothing it could start
      if (!lit && f.cook === 0 && !(this.canSmelt(f) && f.items[1] && fuelTicks(f.items[1].id) > 0)) this.active.delete(cell);
    }
  }

  get activeCount(): number {
    return this.active.size;
  }

  save(): void {
    const data = {
      f: [...this.furnaces.entries()].filter(([, f]) => f.items.some(Boolean) || f.burn > 0).map(([c, f]) => [c, f.items.map(toWire), f.burn, f.burnMax, f.cook]),
      c: [...this.chests.entries()].filter(([, c]) => c.some(Boolean)).map(([cell, c]) => [cell, c.map(toWire)]),
    };
    try {
      writeFileSync(this.path + ".tmp", JSON.stringify(data));
      renameSync(this.path + ".tmp", this.path);
    } catch {
      /* disk issues should not stop the game */
    }
  }

  load(blockAt: (cell: number) => number): void {
    if (!existsSync(this.path)) return;
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8")) as { f: [number, unknown[], number, number, number][]; c: [number, unknown[]][] };
      for (const [cell, items, burn, burnMax, cook] of data.f ?? []) {
        if (!isFurnace(blockAt(cell))) continue;
        this.furnaces.set(cell, { items: [0, 1, 2].map((k) => fromWire(items[k])), burn: burn | 0, burnMax: burnMax | 0, cook: cook | 0 });
        this.active.add(cell);
      }
      for (const [cell, items] of data.c ?? []) {
        if (!isStorage(blockAt(cell))) continue; // v8: chests and barrels
        this.chests.set(cell, Array.from({ length: 27 }, (_, k) => fromWire(items[k])));
      }
    } catch {
      /* a broken file means empty containers */
    }
  }

  totals(): Map<string, number> {
    const m = new Map<string, number>();
    const add = (s: Stack | null) => {
      if (!s) return;
      const k = `${s.id}:${s.d}`;
      m.set(k, (m.get(k) ?? 0) + s.n);
    };
    for (const f of this.furnaces.values()) f.items.forEach(add);
    for (const c of this.chests.values()) c.forEach(add);
    return m;
  }
}

export const litFurnace = (id: number, lit: boolean) => B.FURNACE + (id - B.FURNACE) % 4 + (lit ? 4 : 0);
