// Treasure chests placed by worldgen (v8: the chest in Old Keep on its island; v9: the farmer's and the smith's chests
// in every village). Each one
// is filled once per world: the first time the server starts with it in the world, then never again (a ledger in
// WORLD_DIR/shard-N/loot.json remembers it, even after the chest is emptied or broken).

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { I, toolId, type Stack } from "../../shared/items.ts";
import type { Items } from "../../shared/inventory.ts";

export interface LootChest {
  x: number;
  y: number;
  z: number;
  island: string;
}

/** What a treasure chest holds: rubies (the coin of the villages to come), metal, food and a little gear. */
export function lootFor(kind: string, rand: () => number = Math.random): Stack[] {
  const n = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const out: Stack[] = [];
  const add = (id: number, k: number) => {
    if (k > 0) out.push({ id, n: k, d: 0 });
  };
  if (kind === "village_farmer") {
    // v9: a farmhouse's chest: food and seed, a ruby or two
    add(I.BREAD, n(2, 5));
    add(I.WHEAT, n(3, 9));
    add(I.WHEAT_SEEDS, n(2, 6));
    add(I.APPLE, n(1, 3));
    if (rand() < 0.6) add(I.RUBY, n(1, 3));
    if (rand() < 0.4) add(I.EGG, n(1, 3));
    return out;
  }
  if (kind === "village_smith") {
    // v9: the smithy's chest: iron, coal, a ruby or two, maybe a blade
    add(I.IRON_INGOT, n(2, 5));
    add(I.COAL, n(3, 9));
    add(I.RUBY, n(1, 3));
    if (rand() < 0.3) add(toolId(2, 3), 1); // an iron sword
    else if (rand() < 0.3) add(toolId(2, 0), 1); // or an iron pickaxe
    if (rand() < 0.3) add(I.GOLD_INGOT, n(1, 3));
    return out;
  }
  add(I.RUBY, n(3, 7));
  add(I.IRON_INGOT, n(3, 6));
  add(I.GOLD_INGOT, n(2, 5));
  if (rand() < 0.6) add(I.DIAMOND, n(1, 2));
  add(I.BREAD, n(3, 5));
  add(I.ARROW, n(8, 16));
  if (rand() < 0.5) add(I.BOW, 1);
  if (rand() < 0.4) add(toolId(2, 0), 1); // an iron pickaxe
  else if (rand() < 0.5) add(toolId(2, 3), 1); // or an iron sword
  if (rand() < 0.5) add(I.COCONUT, n(2, 4));
  return out;
}

export class LootLedger {
  private path: string;
  private filled = new Set<string>();

  constructor(dir: string) {
    this.path = join(dir, "loot.json");
    if (existsSync(this.path)) {
      try {
        for (const k of JSON.parse(readFileSync(this.path, "utf8")) as string[]) this.filled.add(k);
      } catch {
        /* an unreadable ledger: chests that were filled stay as they are (their contents are in containers.json) */
      }
    }
  }

  /** Fill every chest not filled before. `chestAt` gives the chest's 27 slots if the cell holds a chest now. */
  fill(chests: LootChest[], chestAt: (c: LootChest) => Items | null, rand: () => number = Math.random): number {
    let n = 0;
    for (const c of chests) {
      const key = `${c.x},${c.y},${c.z}`;
      if (this.filled.has(key)) continue;
      this.filled.add(key);
      const slots = chestAt(c);
      if (!slots || slots.some(Boolean)) continue; // gone, or someone already uses it
      const free = slots.map((_, k) => k);
      for (const st of lootFor(c.island, rand)) {
        if (!free.length) break;
        const k = free.splice(Math.floor(rand() * free.length), 1)[0];
        slots[k] = st;
      }
      n++;
    }
    this.save();
    return n;
  }

  has(c: LootChest): boolean {
    return this.filled.has(`${c.x},${c.y},${c.z}`);
  }

  private save(): void {
    try {
      writeFileSync(this.path + ".tmp", JSON.stringify([...this.filled]));
      renameSync(this.path + ".tmp", this.path);
    } catch {
      /* disk issues should not stop the game */
    }
  }

  reset(): void {
    this.filled.clear();
    this.save();
  }
}
