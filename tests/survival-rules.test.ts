// The shared survival rules: recipes (every one, in the table and, if it fits, the 2x2), mining speed and harvest
// tiers, drops, and every inventory click (pick, split, place, swap, shift, number keys, drag, collect, throw,
// recipe-book fill), plus a fuzz test that no sequence of clicks ever creates or loses an item.

import { test } from "node:test";
import assert from "node:assert/strict";
import { B } from "../shared/blocks.ts";
import { I, ITEMS, itemDef, maxStack, toolId, type Stack } from "../shared/items.ts";
import { RECIPES, matchRecipe, recipeSize } from "../shared/recipes.ts";
import { blockDrops, breakTicks, canHarvest } from "../shared/mining.ts";
import { Menu, addToInventory, countItems, newPlayerInv, type Click, type Items } from "../shared/inventory.ts";
import { mulberry32 } from "../shared/noise.ts";

const S = (id: number, n = 1, d = 0): Stack => ({ id, n, d });

/** Lay a recipe into a size x size grid at (ox, oy), optionally mirrored, using the first accepted item. */
function layRecipe(r: (typeof RECIPES)[number], size: number, ox: number, oy: number, mirror = false): number[] | null {
  const [w, h] = recipeSize(r);
  if (ox + w > size || oy + h > size) return null;
  const g = new Array(size * size).fill(0);
  if (r.shape) {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const ch = r.shape[y][mirror ? w - 1 - x : x];
        if (ch !== " ") g[(oy + y) * size + ox + x] = r.key![ch][0];
      }
  } else r.shapeless!.forEach((ing, k) => (g[(oy + Math.floor(k / size)) * size + ox + (k % size)] = ing[0]));
  return g;
}

test("every recipe matches in the crafting table, anywhere and mirrored, and in the 2x2 grid when it fits", () => {
  const ids = new Set<string>();
  for (const r of RECIPES) {
    assert.ok(!ids.has(r.id), `unique id ${r.id}`);
    ids.add(r.id);
    assert.ok(itemDef(r.out.id), `${r.id} makes a real item`);
    const [w, h] = recipeSize(r);
    for (let oy = 0; oy + h <= 3; oy++)
      for (let ox = 0; ox + w <= 3; ox++)
        for (const m of [false, true]) {
          const g = layRecipe(r, 3, ox, oy, m)!;
          assert.equal(matchRecipe(g, 3)?.id, r.id, `${r.id} at ${ox},${oy}${m ? " mirrored" : ""}`);
        }
    const g2 = layRecipe(r, 2, 0, 0);
    if (g2) assert.equal(matchRecipe(g2, 2)?.id, r.id, `${r.id} in 2x2`);
  }
  assert.ok(RECIPES.length >= 50, `${RECIPES.length} recipes`);
  // the minimum set from the brief
  for (const need of ["oak_planks", "sticks", "crafting_table", "wooden_pickaxe", "stone_axe", "iron_shovel", "golden_sword", "diamond_pickaxe", "torch", "furnace", "chest", "door", "ladder", "fence", "oak_stairs", "oak_slab", "bed", "bowl", "glass_pane", "iron_block", "iron_from_block", "ruby_block", "diamond_block"])
    assert.ok(ids.has(need), need);
});

test("both plank kinds work; nothing matches an empty or nonsense grid", () => {
  const birch = [B.BIRCH_PLANKS, B.BIRCH_PLANKS, B.BIRCH_PLANKS, B.BIRCH_PLANKS];
  assert.equal(matchRecipe(birch, 2)?.id, "crafting_table");
  const mixed = [B.OAK_PLANKS, B.BIRCH_PLANKS, B.BIRCH_PLANKS, B.OAK_PLANKS];
  assert.equal(matchRecipe(mixed, 2)?.id, "crafting_table");
  assert.equal(matchRecipe([0, 0, 0, 0], 2), null);
  assert.equal(matchRecipe([B.DIRT, 0, 0, B.SAND], 2), null);
});

test("mining speeds follow Java (ticks) and harvest tiers gate the drops", () => {
  const hand = 0;
  const woodPick = toolId(0, 0);
  const stonePick = toolId(1, 0);
  const ironPick = toolId(2, 0);
  const diaPick = toolId(4, 0);
  const goldPick = toolId(3, 0);
  assert.equal(breakTicks(B.STONE, hand), 150); // 7.5 s by hand, and no cobblestone
  assert.equal(breakTicks(B.STONE, woodPick), 23); // 1.15 s
  assert.equal(breakTicks(B.STONE, diaPick), 6);
  assert.equal(breakTicks(B.STONE, goldPick), 4);
  assert.equal(breakTicks(B.DIRT, hand), 15);
  assert.equal(breakTicks(B.DIRT, toolId(0, 2)), 8);
  assert.equal(breakTicks(B.OAK_LOG, hand), 60);
  assert.equal(breakTicks(B.OAK_LOG, toolId(0, 1)), 30);
  assert.equal(breakTicks(B.STONE, woodPick, true), 113, "under water: 5x slower");
  assert.equal(breakTicks(B.STONE, woodPick, false, false), 113, "in the air: 5x slower");
  assert.equal(breakTicks(B.TORCH, hand), 0);
  assert.equal(breakTicks(B.BEDROCK, diaPick), -1);
  const r = () => 0.5;
  assert.deepEqual(blockDrops(B.STONE, hand, r), [], "stone by hand drops nothing");
  assert.deepEqual(blockDrops(B.STONE, woodPick, r), [S(B.COBBLESTONE)]);
  assert.deepEqual(blockDrops(B.IRON_ORE, woodPick, r), [], "iron ore needs stone+");
  assert.deepEqual(blockDrops(B.IRON_ORE, stonePick, r), [S(I.RAW_IRON)]);
  assert.deepEqual(blockDrops(B.DIAMOND_ORE, stonePick, r), [], "diamond needs iron+");
  assert.deepEqual(blockDrops(B.DIAMOND_ORE, ironPick, r), [S(I.DIAMOND)]);
  assert.deepEqual(blockDrops(B.GOLD_ORE, stonePick, r), []);
  assert.deepEqual(blockDrops(B.GOLD_ORE, ironPick, r), [S(I.RAW_GOLD)]);
  assert.deepEqual(blockDrops(B.COAL_ORE, woodPick, r), [S(I.COAL)]);
  assert.deepEqual(blockDrops(B.COAL_ORE, goldPick, r), [S(I.COAL)], "gold is wood tier");
  assert.equal(canHarvest(B.RUBY_ORE, goldPick), false);
  assert.deepEqual(blockDrops(B.GRASS, hand, r), [S(B.DIRT)]);
  assert.deepEqual(blockDrops(B.GLASS, hand, r), []);
  assert.deepEqual(blockDrops(B.OAK_STAIRS + 6, toolId(0, 1), r), [S(B.OAK_STAIRS)]);
  assert.deepEqual(blockDrops(B.OAK_SLAB + 1, hand, r), [S(B.OAK_SLAB)]);
  assert.deepEqual(blockDrops(B.OAK_DOOR + 9, hand, r), [S(B.OAK_DOOR)]);
  assert.deepEqual(blockDrops(B.FURNACE + 6, woodPick, r), [S(B.FURNACE)], "a lit furnace drops a furnace");
  assert.deepEqual(blockDrops(B.CHEST + 3, hand, r), [S(B.CHEST)]);
  // leaves: saplings ~1/20, sticks ~1/50, apples ~1/200 (oak only)
  const rnd = mulberry32(5);
  const got = new Map<number, number>();
  for (let k = 0; k < 20000; k++) for (const d of blockDrops(B.OAK_LEAVES, hand, rnd)) got.set(d.id, (got.get(d.id) ?? 0) + 1);
  const sap = (got.get(B.OAK_SAPLING) ?? 0) / 20000;
  const apples = (got.get(I.APPLE) ?? 0) / 20000;
  assert.ok(sap > 0.04 && sap < 0.06, `saplings ${sap}`);
  assert.ok(apples > 0.002 && apples < 0.008, `apples ${apples}`);
  assert.equal([...got.keys()].includes(B.OAK_LEAVES), false, "leaves never drop themselves");
});

function setup(kind: "player" | "crafting" | "furnace" | "chest", fill: [number, Stack][] = [], container?: Items) {
  const p = newPlayerInv();
  for (const [s, st] of fill) p.inv[s] = st;
  const c = container ?? (kind === "crafting" ? new Array(9).fill(null) : kind === "furnace" ? new Array(3).fill(null) : kind === "chest" ? new Array(27).fill(null) : null);
  const m = new Menu(kind, p, c);
  return { p, c, m, cur: { s: null as Stack | null } };
}

test("2x2 crafting: one log makes four planks; shift-click crafts the whole stack into the inventory", () => {
  const { p, m, cur } = setup("player");
  p.craft[0] = S(B.OAK_LOG, 1);
  m.updateResult();
  assert.deepEqual(m.get(0), S(B.OAK_PLANKS, 4));
  m.click({ m: "pick", s: 0, b: 0 }, cur);
  assert.deepEqual(cur.s, S(B.OAK_PLANKS, 4));
  assert.equal(p.craft[0], null);
  assert.equal(m.get(0), null);
  // shift: 64 logs -> 256 planks in 4 stacks, hotbar end first
  const t = setup("player");
  t.p.craft[3] = S(B.OAK_LOG, 64);
  t.m.updateResult();
  const r = t.m.click({ m: "shift", s: 0 }, t.cur);
  assert.equal(r.crafted.length, 64);
  assert.equal(t.p.craft[3], null);
  const planks = t.p.inv.filter((s) => s?.id === B.OAK_PLANKS);
  assert.equal(planks.length, 4);
  assert.equal(planks.reduce((n, s) => n + s!.n, 0), 256);
  assert.equal(t.p.inv[8]?.n, 64, "hotbar's last slot first");
});

test("the result slot only crafts when the cursor can take it; the table's 3x3 makes tools", () => {
  const { c, m, cur } = setup("crafting");
  c![0] = S(B.COBBLESTONE, 2);
  c![1] = S(B.COBBLESTONE, 2);
  c![2] = S(B.COBBLESTONE, 2);
  c![4] = S(I.STICK, 2);
  c![7] = S(I.STICK, 2);
  m.updateResult();
  assert.equal(m.get(0)?.id, toolId(1, 0));
  m.click({ m: "pick", s: 0, b: 0 }, cur);
  assert.equal(cur.s?.id, toolId(1, 0));
  m.click({ m: "pick", s: 0, b: 0 }, cur); // cursor holds a pickaxe (stack 1): can't take another
  assert.equal(c![0]?.n, 1, "second craft refused");
  assert.equal(maxStack(toolId(1, 0)), 1);
});

test("pick, split, place one, merge, swap", () => {
  const { p, m, cur } = setup("player", [[9, S(B.DIRT, 10)], [10, S(B.SAND, 5)], [11, S(B.DIRT, 60)]]);
  // slot 9 in the inventory array is window slot 9
  m.click({ m: "pick", s: 9, b: 1 }, cur); // right: half (5)
  assert.deepEqual(cur.s, S(B.DIRT, 5));
  assert.equal(p.inv[9]?.n, 5);
  m.click({ m: "pick", s: 12, b: 1 }, cur); // place one into an empty slot
  assert.equal(p.inv[12]?.n, 1);
  assert.equal(cur.s?.n, 4);
  m.click({ m: "pick", s: 11, b: 0 }, cur); // merge into 60/64: 4 fit
  assert.equal(p.inv[11]?.n, 64);
  assert.equal(cur.s, null);
  m.click({ m: "pick", s: 10, b: 0 }, cur); // take sand
  m.click({ m: "pick", s: 9, b: 0 }, cur); // swap with dirt
  assert.deepEqual(p.inv[9], S(B.SAND, 5));
  assert.deepEqual(cur.s, S(B.DIRT, 5));
});

test("shift-click routes: chest <-> inventory, furnace input/fuel, inventory <-> hotbar; number keys swap", () => {
  const ch = setup("chest", [[0, S(B.STONE, 20)]]);
  ch.m.click({ m: "shift", s: ch.m.hotStart + 0 }, ch.cur); // hotbar -> chest
  assert.deepEqual(ch.c![0], S(B.STONE, 20));
  ch.m.click({ m: "shift", s: 0 }, ch.cur); // chest -> inventory (hotbar end first)
  assert.deepEqual(ch.p.inv[8], S(B.STONE, 20));
  const f = setup("furnace", [[9, S(I.RAW_IRON, 3)], [10, S(I.COAL, 2)], [11, S(B.DIRT, 1)]]);
  f.m.click({ m: "shift", s: f.m.invStart + 0 }, f.cur);
  f.m.click({ m: "shift", s: f.m.invStart + 1 }, f.cur);
  f.m.click({ m: "shift", s: f.m.invStart + 2 }, f.cur);
  assert.deepEqual(f.c![0], S(I.RAW_IRON, 3), "raw iron -> input");
  assert.deepEqual(f.c![1], S(I.COAL, 2), "coal -> fuel");
  assert.deepEqual(f.p.inv[0], S(B.DIRT, 1), "dirt -> hotbar");
  // fuel slot refuses non-fuel
  f.cur.s = S(B.DIRT, 1);
  f.p.inv[0] = null;
  const before = f.c![1];
  f.m.click({ m: "pick", s: 1, b: 0 }, f.cur);
  assert.deepEqual(f.c![1], before);
  // number key: swap hovered slot with hotbar slot 3
  const k = setup("player", [[20, S(B.GRAVEL, 7)], [3, S(B.SAND, 2)]]);
  k.m.click({ m: "swap", s: 20, h: 3 }, k.cur);
  assert.deepEqual(k.p.inv[3], S(B.GRAVEL, 7));
  assert.deepEqual(k.p.inv[20], S(B.SAND, 2));
});

test("drag spreads evenly (left) or one each (right); double-click collects; throw and click-outside drop", () => {
  const d = setup("player");
  d.cur.s = S(B.DIRT, 10);
  d.m.click({ m: "drag", b: 0, list: [9, 10, 11] }, d.cur);
  assert.deepEqual([d.p.inv[9]?.n, d.p.inv[10]?.n, d.p.inv[11]?.n], [3, 3, 3]);
  assert.equal(d.cur.s?.n, 1);
  d.cur.s = S(B.DIRT, 5);
  d.m.click({ m: "drag", b: 1, list: [12, 13] }, d.cur);
  assert.deepEqual([d.p.inv[12]?.n, d.p.inv[13]?.n, d.cur.s?.n], [1, 1, 3]);
  d.m.click({ m: "collect", s: 9 }, d.cur);
  assert.equal(d.cur.s?.n, 3 + 3 + 3 + 3 + 1 + 1);
  const r = d.m.click({ m: "out", b: 1 }, d.cur);
  assert.deepEqual(r.drops, [S(B.DIRT, 1)]);
  const t = setup("player", [[15, S(B.SAND, 6)]]);
  assert.deepEqual(t.m.click({ m: "throw", s: 15, all: false }, t.cur).drops, [S(B.SAND, 1)]);
  assert.deepEqual(t.m.click({ m: "throw", s: 15, all: true }, t.cur).drops, [S(B.SAND, 5)]);
  assert.equal(t.p.inv[15], null);
});

test("recipe book fill: lays the recipe from the inventory (once or as many as possible), or does nothing", () => {
  const f = setup("player", [[9, S(B.OAK_PLANKS, 10)], [0, S(B.BIRCH_PLANKS, 3)]]);
  f.m.click({ m: "fill", r: "crafting_table", all: false }, f.cur);
  assert.equal(f.m.get(0)?.id, B.CRAFTING_TABLE);
  assert.equal(f.p.craft.filter(Boolean).length, 4);
  const all = setup("crafting", [[9, S(I.STICK, 64)], [10, S(B.COBBLESTONE, 64)], [11, S(B.COBBLESTONE, 30)]]);
  all.m.click({ m: "fill", r: "stone_pickaxe", all: true }, all.cur);
  assert.deepEqual(all.c!.map((s) => s?.n ?? 0), [31, 31, 31, 0, 31, 0, 0, 31, 0], "31 pickaxes' worth (94 cobble / 3)");
  const none = setup("player", [[9, S(B.OAK_PLANKS, 3)]]);
  none.m.click({ m: "fill", r: "crafting_table", all: false }, none.cur);
  assert.equal(none.p.craft.filter(Boolean).length, 0, "3 planks aren't enough");
  assert.equal(none.p.inv[9]?.n, 3);
});

test("closing returns the grid and the cursor to the inventory (and drops what doesn't fit)", () => {
  const f = setup("player");
  f.p.craft[1] = S(B.OAK_LOG, 3);
  f.cur.s = S(B.DIRT, 4);
  const drops = f.m.close(f.cur);
  assert.deepEqual(drops, []);
  assert.equal(f.cur.s, null);
  assert.deepEqual(countItems(f.p.inv).get(`${B.OAK_LOG}:0`), 3);
  const full = setup("player", [...Array(36).keys()].map((s) => [s, S(B.SAND, 64)] as [number, Stack]));
  full.p.craft[0] = S(B.OAK_LOG, 2);
  assert.deepEqual(full.m.close(full.cur), [S(B.OAK_LOG, 2)]);
});

test("addToInventory: hotbar first, merges, reports what didn't fit", () => {
  const inv: Items = new Array(36).fill(null);
  inv[20] = S(B.DIRT, 60);
  assert.equal(addToInventory(inv, S(B.DIRT, 10)), 0);
  assert.equal(inv[20]?.n, 64);
  assert.deepEqual(inv[0], S(B.DIRT, 6));
  for (let s = 0; s < 36; s++) inv[s] = S(B.SAND, 64);
  assert.equal(addToInventory(inv, S(B.DIRT, 5)), 5);
});

test("anti-dupe fuzz: 20,000 random clicks in every kind of window never create or lose an item", () => {
  const rnd = mulberry32(99);
  const pickItem = () => [B.DIRT, B.SAND, B.COBBLESTONE, I.STICK, I.COAL, I.RAW_IRON, toolId(2, 0), B.OAK_LOG][Math.floor(rnd() * 8)];
  for (const kind of ["player", "chest", "furnace", "crafting"] as const) {
    for (let round = 0; round < 50; round++) {
      const t = setup(kind);
      // random contents everywhere (non-result slots)
      for (let s = 0; s < t.m.size; s++) {
        if (rnd() < 0.5) continue;
        const id = pickItem();
        const st = S(id, 1 + Math.floor(rnd() * maxStack(id)));
        const probe = new Menu(kind, t.p, t.c);
        void probe;
        if (s < t.m.invStart) {
          if (kind === "chest") t.c![s] = st;
          else if (kind === "furnace") t.c![s] = st;
        } else t.p.inv[s < t.m.hotStart ? s - t.m.invStart + 9 : s - t.m.hotStart] = st;
      }
      const all = () => countItems(t.p.inv, t.p.craft, t.p.armor, t.c ?? [], [t.cur.s]);
      const sum = (m: Map<string, number>, plus: Stack[] = []) => {
        const out = new Map(m);
        for (const d of plus) out.set(`${d.id}:${d.d}`, (out.get(`${d.id}:${d.d}`) ?? 0) + d.n);
        return out;
      };
      let total = all();
      const dropped: Stack[] = [];
      for (let k = 0; k < 100; k++) {
        const s = Math.floor(rnd() * t.m.size);
        const r = rnd();
        // clicks on the crafting result are tested separately (they convert items by design)
        const isResult = (kind === "player" || kind === "crafting") && s === 0;
        let c: Click;
        if (r < 0.35) c = { m: "pick", s, b: rnd() < 0.5 ? 0 : 1 };
        else if (r < 0.5) c = { m: "shift", s };
        else if (r < 0.62) c = { m: "swap", s, h: Math.floor(rnd() * 9) };
        else if (r < 0.7) c = { m: "drag", b: rnd() < 0.5 ? 0 : 1, list: [s, (s + 1) % t.m.size, (s + 5) % t.m.size] };
        else if (r < 0.8) c = { m: "collect", s };
        else if (r < 0.88) c = { m: "throw", s, all: rnd() < 0.5 };
        else if (r < 0.93) c = { m: "out", b: rnd() < 0.5 ? 0 : 1 };
        else c = { m: "pick", s: (s + 3) % t.m.size, b: 0 };
        if (isResult || ("s" in c && (kind === "player" || kind === "crafting") && c.s === 0)) continue;
        const res = t.m.click(c, t.cur);
        dropped.push(...res.drops);
        assert.equal(res.crafted.length, 0);
        const now = sum(all(), dropped);
        assert.deepEqual(now, total, `${kind} round ${round} click ${k}: ${JSON.stringify(c)}`);
        // and no stack is over its limit or empty
        for (const st of [...t.p.inv, ...(t.c ?? []), t.cur.s]) if (st) assert.ok(st.n >= 1 && st.n <= maxStack(st.id), `stack size ${st.n}`);
      }
      total = sum(all(), dropped);
    }
  }
});

test("crafting conserves: the grid loses exactly the recipe's inputs for every craft", () => {
  const t = setup("crafting");
  t.c![0] = S(B.OAK_PLANKS, 10);
  t.c![3] = S(B.OAK_PLANKS, 7);
  t.m.updateResult();
  assert.equal(t.m.get(0)?.id, I.STICK);
  t.m.click({ m: "shift", s: 0 }, t.cur);
  assert.deepEqual([t.c![0]?.n, t.c![3]], [3, null], "7 crafts");
  assert.equal(countItems(t.p.inv).get(`${I.STICK}:0`), 28);
});

test("item registry: every recipe output and drop is a real item with a name and a stack size", () => {
  for (const it of ITEMS) {
    if (!it) continue;
    assert.ok(it.name && it.stack >= 1 && it.stack <= 64, it.key);
    if (it.tool) assert.equal(it.stack, 1);
  }
  assert.equal(itemDef(toolId(4, 0))?.name, "Diamond Pickaxe");
  assert.equal(itemDef(toolId(3, 3))?.name, "Golden Sword");
});
