// Trading (update 11): every job's offers are rubies one way, real items the other; a trade pays the cost and
// delivers the goods exactly, or changes nothing at all (short of the cost, no room); an anti-dupe fuzz of random
// inventories and random trades (once and "as many as you can") never makes or loses an item; stock runs down, never
// below zero, and comes back in full every 10 minutes; and no chain of trades, crafting, smelting or breaking makes
// rubies out of nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { B } from "../shared/blocks.ts";
import { I, SMELT, itemDef, maxStack, type Stack } from "../shared/items.ts";
import { countItems, type Items } from "../shared/inventory.ts";
import { blockDrops } from "../shared/mining.ts";
import { mulberry32 } from "../shared/noise.ts";
import { RECIPES } from "../shared/recipes.ts";
import { RESTOCK_MS, TRADES, canAfford, countOf, fullStock, tradeOnce, type Offer } from "../shared/trades.ts";
import { JOBS } from "../shared/villagers.ts";
import { VillagerManager } from "../server/src/villagers.ts";
import { DEFAULT_SEED, WORLD_HEIGHT, WORLD_SIZE, idx } from "../shared/constants.ts";
import { generateWorld } from "../shared/worldgen.ts";

const S = (id: number, n: number): Stack => ({ id, n, d: 0 });
const inv = (...st: (Stack | null)[]): Items => {
  const a: Items = new Array(36).fill(null);
  st.forEach((s, k) => (a[k] = s));
  return a;
};

test("every job has a handful of trades, rubies on one side, real items on the other", () => {
  assert.equal(TRADES.length, JOBS.length);
  for (const [j, list] of TRADES.entries()) {
    assert.ok(list.length >= 4 && list.length <= 6, `${JOBS[j].name}: ${list.length} trades`); // v13: the smith's lava, the librarian's books
    for (const o of list) {
      assert.ok((o.buy[0] === I.RUBY) !== (o.sell[0] === I.RUBY), `${JOBS[j].name}: rubies on exactly one side`);
      for (const [id, n] of [o.buy, o.sell, ...(o.buy2 ? [o.buy2] : [])]) {
        assert.ok(itemDef(id), `${JOBS[j].name}: item ${id} exists`);
        assert.ok(n >= 1 && n <= 64, "a sensible count");
      }
      assert.ok(o.sell[1] <= maxStack(o.sell[0]), `${JOBS[j].name}: the goods fit in one stack`);
      assert.ok(o.max >= 2 && o.max <= 16);
    }
    assert.ok(list.some((o) => o.sell[0] === I.RUBY), `${JOBS[j].name} buys something (a way to earn rubies)`);
    assert.ok(list.some((o) => o.buy[0] === I.RUBY), `${JOBS[j].name} sells something`);
  }
  assert.equal(itemDef(I.SMOKED_FISH)?.food?.hunger, 6, "the fisher's smoked fish is food");
});

test("a trade pays exactly and delivers exactly, or changes nothing", () => {
  const sell20 = TRADES[0][0]; // 20 wheat -> 1 ruby
  const a = inv(S(I.WHEAT, 15), null, S(I.WHEAT, 10));
  assert.ok(tradeOnce(a, sell20));
  assert.equal(countOf(a, I.WHEAT), 5);
  assert.equal(countOf(a, I.RUBY), 1);
  // short of the cost: nothing changes
  const b = inv(S(I.WHEAT, 19));
  const before = JSON.stringify(b);
  assert.equal(tradeOnce(b, sell20), false);
  assert.equal(JSON.stringify(b), before);
  // no room for the goods: nothing changes (36 full stacks of something else, plus the cost spread out)
  const full: Items = new Array(36).fill(null).map((_, k) => (k < 2 ? S(I.WHEAT, 10) : S(B.DIRT, 64)));
  const f0 = JSON.stringify(full);
  assert.ok(tradeOnce(full, sell20), "paying frees the slots the goods go into");
  const crammed: Items = new Array(36).fill(null).map((_, k) => (k === 0 ? S(I.RUBY, 64) : S(B.DIRT, 64)));
  const c0 = JSON.stringify(crammed);
  assert.equal(tradeOnce(crammed, TRADES[0][2]), false, "a ruby for bread with no room left for the bread");
  assert.equal(JSON.stringify(crammed), c0);
  void f0;
  // a two-item cost (none of ours yet, but the code supports it)
  const two: Offer = { buy: [I.RUBY, 2], buy2: [I.STICK, 1], sell: [I.BOW, 1], max: 1 };
  const t = inv(S(I.RUBY, 3), S(I.STICK, 1));
  assert.ok(canAfford(t, two) && tradeOnce(t, two));
  assert.deepEqual([countOf(t, I.RUBY), countOf(t, I.STICK), countOf(t, I.BOW)], [1, 0, 1]);
  // damaged items are not money: a worn tool isn't counted as the cost
  const worn: Offer = { buy: [I.RUBY, 1], sell: [I.APPLE, 1], max: 1 };
  assert.equal(canAfford(inv({ id: I.RUBY, n: 1, d: 3 }), worn), false);
});

test("anti-dupe fuzz: random inventories, random trades (once or as many as it can): nothing is ever made or lost", () => {
  const rand = mulberry32(1109);
  const pool = [...new Set(TRADES.flat().flatMap((o) => [o.buy[0], o.sell[0]]))];
  const dir = mkdtempSync(join(tmpdir(), "steve-craft-trade-"));
  // a real villager manager (its stock and its trade loop), on a world with every village
  const { blocks, info } = generateWorld(DEFAULT_SEED, undefined, { villages: [0] });
  const get = (x: number, y: number, z: number) => (x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE || y < 0 || y >= WORLD_HEIGHT ? 0 : blocks[idx(x, y, z)]);
  const m = new VillagerManager(get, dir, info.villages.list);
  const vs = [...m.villagers.values()];
  let trades = 0;
  let refused = 0;
  for (let round = 0; round < 4000; round++) {
    const a: Items = new Array(36).fill(null);
    for (let k = 0; k < 36; k++) {
      if (rand() < 0.45) continue;
      const id = pool[Math.floor(rand() * pool.length)];
      a[k] = S(id, 1 + Math.floor(rand() * maxStack(id)));
    }
    const v = vs[Math.floor(rand() * vs.length)];
    const k = Math.floor(rand() * TRADES[v.job].length);
    const o = TRADES[v.job][k];
    const all = rand() < 0.3;
    const stock = v.stock[k];
    const before = countItems(a);
    const n = m.trade(v, k, a, all);
    const after = countItems(a);
    assert.ok(n <= stock && v.stock[k] === stock - n && v.stock[k] >= 0, "stock goes down by the trades made");
    assert.ok(all || n <= 1);
    // every item: after = before - n * cost + n * goods
    const want = new Map(before);
    const add = (id: number, d: number) => want.set(`${id}:0`, (want.get(`${id}:0`) ?? 0) + d);
    add(o.buy[0], -n * o.buy[1]);
    if (o.buy2) add(o.buy2[0], -n * o.buy2[1]);
    add(o.sell[0], n * o.sell[1]);
    for (const [key, c] of want) if (c === 0) want.delete(key);
    assert.deepEqual(new Map([...after].sort()), new Map([...want].sort()), `round ${round}: items in = items out`);
    for (const s of a) if (s) assert.ok(s.n >= 1 && s.n <= maxStack(s.id), "no broken stacks");
    if (n) trades += n;
    else refused++;
    if (round % 400 === 0) m.maybeRestock(Date.now() + RESTOCK_MS * 2);
  }
  assert.ok(trades > 250 && refused > 300, `${trades} trades, ${refused} refused`);
});

test("stock: sold out stays sold out, then it all comes back every 10 minutes (and is saved)", () => {
  const dir = mkdtempSync(join(tmpdir(), "steve-craft-stock-"));
  const { blocks, info } = generateWorld(DEFAULT_SEED, undefined, { villages: [0] });
  const get = (x: number, y: number, z: number) => (x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE || y < 0 || y >= WORLD_HEIGHT ? 0 : blocks[idx(x, y, z)]);
  const m = new VillagerManager(get, dir, info.villages.list);
  const farmer = [...m.villagers.values()].find((v) => v.job === 0)!;
  const rich = (): Items => new Array(36).fill(null).map((_, k) => (k < 20 ? S(I.RUBY, 64) : null));
  const a = rich();
  assert.equal(m.trade(farmer, 2, a, true), 12, "12 lots of bread, then sold out");
  assert.equal(m.trade(farmer, 2, a, false), 0);
  m.save();
  const m2 = new VillagerManager(get, dir, info.villages.list);
  m2.load(4000);
  const f2 = m2.villagers.get(farmer.id)!;
  assert.equal(f2.stock[2], 0, "the stock is kept over a restart");
  assert.equal(m2.maybeRestock(Date.now() + 1000), false, "not yet");
  assert.equal(m2.maybeRestock(m2.restockAt + 1), true, "after 10 minutes");
  assert.deepEqual(f2.stock, fullStock(0));
  assert.equal(RESTOCK_MS, 600_000);
});

test("no rubies from nothing: nothing a villager sells crafts, smelts or breaks into something a villager buys for more", () => {
  const bought = new Map<number, number>(); // item -> rubies a villager pays for one
  const sold = new Map<number, number>(); // item -> rubies one costs
  for (const o of TRADES.flat()) {
    if (o.sell[0] === I.RUBY) bought.set(o.buy[0], Math.max(bought.get(o.buy[0]) ?? 0, o.sell[1] / o.buy[1]));
    else sold.set(o.sell[0], Math.min(sold.get(o.sell[0]) ?? 99, o.buy[1] / o.sell[1]));
  }
  for (const id of sold.keys()) assert.ok(!bought.has(id), `${itemDef(id)!.name} is sold and bought`);
  for (const r of RECIPES) {
    if (!bought.has(r.out.id)) continue;
    const ings = (r.shapeless ?? Object.values(r.key ?? {})).flat();
    for (const id of ings) assert.ok(!sold.has(id), `${r.id}: a villager's goods craft into what villagers buy`);
  }
  for (const [from, to] of Object.entries(SMELT)) assert.ok(!(sold.has(Number(from)) && bought.has(to)), `smelting ${from}`);
  for (const id of sold.keys()) {
    if (id >= 256) continue;
    for (const st of blockDrops(id, 0, () => 0.5).concat(blockDrops(id, 300 + 2 * 4, () => 0.5))) {
      if (!bought.has(st.id)) continue;
      assert.ok(st.n * bought.get(st.id)! < sold.get(id)!, `breaking ${itemDef(id)!.name} pays less than it cost`);
    }
  }
});
