// Farming and depth (protocol v7) on synthetic worlds and in the shared rules: wheat grows a stage at a time (twice
// as fast on watered farmland, not in the dark) and ripens; farmland is watered by water within 4 blocks (and dries,
// and bare dry farmland goes back to dirt); sugar cane grows to 3 by water and falls (as items) without it;
// trampled farmland knocks its crop off; what crops, tall grass and gravel drop; the new recipes (a cake leaves its
// milk buckets behind: nothing made from nothing); the bow's power curve; the shapes (farmland a pixel low, a cake
// eaten from the side); what crops, cane and cake need under them; and chickens laying eggs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { B, BLOCKS, isWheat } from "../shared/blocks.ts";
import { bowPower } from "../shared/combat.ts";
import { VOLUME, WORLD_HEIGHT, WORLD_SIZE, idx } from "../shared/constants.ts";
import { hydratedAt } from "../shared/farming.ts";
import { Menu, newPlayerInv } from "../shared/inventory.ts";
import { I, hoeId, itemDef, maxDurability, type Stack } from "../shared/items.ts";
import { blockDrops } from "../shared/mining.ts";
import { matchRecipe } from "../shared/recipes.ts";
import { collisionBoxes16, renderBoxes, supported } from "../shared/shapes.ts";
import { FarmManager, WHEAT_GROW_DRY, WHEAT_GROW_WET } from "../server/src/farm.ts";
import { LightIndex } from "../server/src/light.ts";
import { AnimalManager } from "../server/src/animals.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GROUND = 40;
const world = new Uint8Array(VOLUME);
const get = (x: number, y: number, z: number) => (x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE || y < 0 || y >= WORLD_HEIGHT ? B.AIR : world[idx(x, y, z)]);
const WX = 90;
const WZ = 90;

function flat(): void {
  world.fill(0);
  for (let y = 0; y <= GROUND; y++) world.fill(y === GROUND ? B.GRASS : B.STONE, idx(0, y, 0), idx(0, y + 1, 0));
}

/** A farm manager on the synthetic world: changes go straight in (and back into the manager), drops are kept. */
function setup(): { farm: FarmManager; light: LightIndex; drops: Stack[] } {
  const light = new LightIndex(world);
  const drops: Stack[] = [];
  const farm: FarmManager = new FarmManager(get, light, {
    set: (i, id) => {
      const old = world[i];
      world[i] = id;
      light.changed(i, old, id);
      farm.changed(i, old, id);
    },
    drop: (st) => drops.push(st),
  });
  return { farm, light, drops };
}

const put = (s: { farm: FarmManager; light: LightIndex }, x: number, y: number, z: number, id: number) => {
  const i = idx(x, y, z);
  const old = world[i];
  world[i] = id;
  s.light.changed(i, old, id);
  s.farm.changed(i, old, id);
};

/** A seeded random source. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("wheat grows a stage at a time to ripe: about twice as fast on watered farmland; not at all in the dark", () => {
  flat();
  const s = setup();
  s.farm.rand = seeded(7);
  // watered (water 3 blocks off), dry (far from it), and one under a roof with no light
  put(s, WX + 3, GROUND, WZ, B.WATER);
  for (const [x, z] of [[WX, WZ], [WX + 20, WZ], [WX + 40, WZ]]) {
    put(s, x, GROUND, z, hydratedAt(get, x, GROUND, z) ? B.FARMLAND + 1 : B.FARMLAND);
    put(s, x, GROUND + 1, z, B.WHEAT);
  }
  assert.equal(get(WX, GROUND, WZ), B.FARMLAND + 1, "watered");
  assert.equal(get(WX + 20, GROUND, WZ), B.FARMLAND, "dry");
  for (let y = GROUND + 3; y <= GROUND + 4; y++) for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) put(s, WX + 40 + dx, y, WZ + dz, B.STONE);
  const ripeAt: Record<string, number> = {};
  for (let t = 1; t <= 1500; t++) {
    s.farm.tick();
    for (const [name, x] of [["wet", WX], ["dry", WX + 20]] as [string, number][]) if (!ripeAt[name] && get(x, GROUND + 1, WZ) === B.WHEAT + 7) ripeAt[name] = t;
  }
  assert.ok(ripeAt.wet && ripeAt.dry, `both ripen (${JSON.stringify(ripeAt)} s)`);
  const expectWet = 7 / WHEAT_GROW_WET;
  const expectDry = 7 / WHEAT_GROW_DRY;
  assert.ok(ripeAt.wet > expectWet * 0.4 && ripeAt.wet < expectWet * 2.2, `watered: ${ripeAt.wet} s (about ${expectWet})`);
  assert.ok(ripeAt.dry > expectDry * 0.4 && ripeAt.dry < expectDry * 2.2, `dry: ${ripeAt.dry} s (about ${expectDry})`);
  assert.equal(get(WX + 40, GROUND + 1, WZ), B.WHEAT, "nothing grows in the dark");
});

test("farmland: watered when water comes near, dried out when it goes, and dry bare farmland turns back to dirt", () => {
  flat();
  const s = setup();
  s.farm.rand = seeded(3);
  put(s, WX, GROUND, WZ, B.FARMLAND);
  put(s, WX + 6, GROUND, WZ, B.FARMLAND);
  put(s, WX + 6, GROUND + 1, WZ, B.WHEAT); // a crop keeps its farmland
  put(s, WX + 2, GROUND + 1, WZ, B.WATER); // one level up counts too
  s.farm.checkFarmland(idx(WX, GROUND, WZ));
  assert.equal(get(WX, GROUND, WZ), B.FARMLAND + 1, "watered");
  put(s, WX + 2, GROUND + 1, WZ, B.AIR);
  s.farm.checkFarmland(idx(WX, GROUND, WZ));
  assert.equal(get(WX, GROUND, WZ), B.FARMLAND, "dried out");
  for (let k = 0; k < 60 && get(WX, GROUND, WZ) !== B.DIRT; k++) s.farm.checkFarmland(idx(WX, GROUND, WZ));
  assert.equal(get(WX, GROUND, WZ), B.DIRT, "bare and dry: back to dirt");
  for (let k = 0; k < 60; k++) s.farm.checkFarmland(idx(WX + 6, GROUND, WZ));
  assert.equal(get(WX + 6, GROUND, WZ), B.FARMLAND, "with wheat on it, it stays");
  assert.ok(!hydratedAt(get, WX + 6, GROUND, WZ));
  put(s, WX + 10, GROUND, WZ, B.WATER);
  assert.ok(hydratedAt(get, WX + 6, GROUND, WZ), "4 blocks away is near enough");
  put(s, WX + 10, GROUND, WZ, B.GRASS);
  put(s, WX + 11, GROUND, WZ, B.WATER);
  assert.ok(!hydratedAt(get, WX + 6, GROUND, WZ), "5 is not");
});

test("trampled farmland knocks its crop off (the seeds drop) and is dirt", () => {
  flat();
  const s = setup();
  s.farm.rand = seeded(5);
  put(s, WX, GROUND, WZ, B.FARMLAND + 1);
  put(s, WX, GROUND + 1, WZ, B.WHEAT + 3);
  s.farm.toDirt(WX, GROUND, WZ);
  assert.equal(get(WX, GROUND, WZ), B.DIRT);
  assert.equal(get(WX, GROUND + 1, WZ), B.AIR);
  assert.deepEqual(s.drops.map((d) => [d.id, d.n]), [[I.WHEAT_SEEDS, 1]]);
});

test("sugar cane grows to 3 tall beside water (no higher), and falls as items when the water goes", () => {
  flat();
  const s = setup();
  s.farm.rand = () => 0; // always grows when it may
  put(s, WX, GROUND, WZ, B.SAND);
  put(s, WX + 1, GROUND, WZ, B.WATER);
  put(s, WX, GROUND + 1, WZ, B.SUGAR_CANE);
  for (let t = 0; t < 10; t++) s.farm.tick();
  assert.deepEqual([1, 2, 3, 4].map((k) => get(WX, GROUND + k, WZ)), [B.SUGAR_CANE, B.SUGAR_CANE, B.SUGAR_CANE, B.AIR], "3 tall, then it stops");
  put(s, WX + 1, GROUND, WZ, B.SAND);
  s.farm.tick();
  assert.deepEqual([1, 2, 3].map((k) => get(WX, GROUND + k, WZ)), [B.AIR, B.AIR, B.AIR], "no water: it falls");
  assert.equal(s.drops.filter((d) => d.id === B.SUGAR_CANE).length, 3, "3 sugar cane to pick up");
});

test("drops: ripe wheat gives wheat and 1-4 seeds, unripe a seed back; tall grass a seed 1 time in 8; gravel flint 1 in 10; a cake nothing", () => {
  const r = seeded(11);
  let seedsFromGrass = 0;
  let flint = 0;
  for (let k = 0; k < 8000; k++) {
    if (blockDrops(B.TALL_GRASS, 0, r).some((d) => d.id === I.WHEAT_SEEDS)) seedsFromGrass++;
    if (blockDrops(B.GRAVEL, 0, r)[0].id === I.FLINT) flint++;
  }
  assert.ok(Math.abs(seedsFromGrass / 8000 - 0.125) < 0.02, `seeds ${seedsFromGrass / 8000}`);
  assert.ok(Math.abs(flint / 8000 - 0.1) < 0.02, `flint ${flint / 8000}`);
  for (let k = 0; k < 200; k++) {
    const ripe = blockDrops(B.WHEAT + 7, 0, r);
    assert.equal(ripe.find((d) => d.id === I.WHEAT)?.n, 1);
    const n = ripe.find((d) => d.id === I.WHEAT_SEEDS)?.n ?? 0;
    assert.ok(n >= 1 && n <= 4);
  }
  assert.deepEqual(blockDrops(B.WHEAT + 4, 0, r), [{ id: I.WHEAT_SEEDS, n: 1, d: 0 }]);
  assert.deepEqual(blockDrops(B.CAKE + 2, 0, r), []);
  assert.deepEqual(blockDrops(B.FARMLAND + 1, 0, r), [{ id: B.DIRT, n: 1, d: 0 }]);
  assert.deepEqual(blockDrops(B.SUGAR_CANE, 0, r), [{ id: B.SUGAR_CANE, n: 1, d: 0 }]);
});

test("recipes: hoes, bread, sugar, paper, the bucket, the bow and arrows", () => {
  const g = (rows: number[][]) => rows.flat();
  assert.equal(matchRecipe(g([[B.OAK_PLANKS, B.OAK_PLANKS, 0], [0, I.STICK, 0], [0, I.STICK, 0]]), 3)?.out.id, hoeId(0));
  assert.equal(matchRecipe(g([[I.DIAMOND, I.DIAMOND, 0], [0, I.STICK, 0], [0, I.STICK, 0]]), 3)?.out.id, hoeId(4));
  assert.equal(matchRecipe(g([[I.WHEAT, I.WHEAT, I.WHEAT], [0, 0, 0], [0, 0, 0]]), 3)?.out.id, I.BREAD);
  assert.equal(matchRecipe([B.SUGAR_CANE, 0, 0, 0], 2)?.out.id, I.SUGAR);
  assert.deepEqual(matchRecipe(g([[B.SUGAR_CANE, B.SUGAR_CANE, B.SUGAR_CANE], [0, 0, 0], [0, 0, 0]]), 3)?.out, { id: I.PAPER, n: 3, d: 0 });
  assert.equal(matchRecipe(g([[I.IRON_INGOT, 0, I.IRON_INGOT], [0, I.IRON_INGOT, 0], [0, 0, 0]]), 3)?.out.id, I.BUCKET);
  assert.equal(matchRecipe(g([[0, I.STICK, I.STRING], [I.STICK, 0, I.STRING], [0, I.STICK, I.STRING]]), 3)?.out.id, I.BOW);
  assert.deepEqual(matchRecipe(g([[I.FLINT, 0, 0], [I.STICK, 0, 0], [I.FEATHER, 0, 0]]), 3)?.out, { id: I.ARROW, n: 4, d: 0 });
  assert.equal(maxDurability(I.BOW), 384, "the bow wears");
  assert.equal(itemDef(I.MILK_BUCKET)?.remainder, I.BUCKET);
});

test("a cake: three milk buckets, two sugar, an egg and three wheat; the buckets stay behind, empty (nothing made from nothing)", () => {
  const inv = newPlayerInv();
  const cursor = { s: null as Stack | null };
  const ids = [I.MILK_BUCKET, I.MILK_BUCKET, I.MILK_BUCKET, I.SUGAR, I.EGG, I.SUGAR, I.WHEAT, I.WHEAT, I.WHEAT];
  const grid: (Stack | null)[] = ids.map((id) => ({ id, n: 1, d: 0 }));
  const m = new Menu("crafting", inv, grid);
  assert.equal(m.get(0)?.id, B.CAKE, "the cake shows");
  m.click({ m: "pick", s: 0, b: 0 }, cursor);
  assert.equal(cursor.s?.id, B.CAKE, "taken");
  assert.deepEqual(grid.slice(0, 3).map((st) => st?.id), [I.BUCKET, I.BUCKET, I.BUCKET], "three empty buckets where the milk was");
  assert.ok(grid.slice(3).every((st) => st === null), "the rest is used up");
  assert.equal(m.get(0), null, "no second cake from empty buckets");
});

test("the bow's power: Java's curve, full after a second; a tap is nothing", () => {
  assert.ok(bowPower(1) < 0.1, "a tap");
  assert.ok(Math.abs(bowPower(10) - (0.25 + 1) / 3) < 1e-9, "half a second");
  assert.equal(bowPower(20), 1);
  assert.equal(bowPower(60), 1, "no more than full");
});

test("shapes: farmland is a pixel low (you sink into it), a cake is eaten from its west side, and what each needs under it", () => {
  const air = () => B.AIR;
  assert.deepEqual(collisionBoxes16(B.FARMLAND, air), [[0, 0, 0, 16, 15, 16]]);
  assert.deepEqual(collisionBoxes16(B.CAKE, air), [[1, 0, 1, 15, 8, 15]]);
  assert.deepEqual(collisionBoxes16(B.CAKE + 3, air), [[7, 0, 1, 15, 8, 15]]);
  const cut = renderBoxes(B.CAKE + 1, air)[0];
  assert.notEqual(cut.tex[1], cut.tex[0], "the cut side shows the inside");
  flat();
  assert.ok(!supported(B.WHEAT, WX, GROUND + 1, WZ, get), "wheat needs farmland");
  world[idx(WX, GROUND, WZ)] = B.FARMLAND;
  assert.ok(supported(B.WHEAT + 5, WX, GROUND + 1, WZ, get));
  assert.ok(!supported(B.SUGAR_CANE, WX, GROUND + 1, WZ + 5, get), "cane needs water by it");
  world[idx(WX, GROUND, WZ + 6)] = B.WATER;
  assert.ok(supported(B.SUGAR_CANE, WX, GROUND + 1, WZ + 5, get));
  assert.ok(supported(B.CAKE, WX + 2, GROUND + 1, WZ, get), "a cake on grass");
  assert.ok(!supported(B.CAKE, WX + 2, GROUND + 2, WZ, get), "not on air");
  assert.ok(isWheat(B.WHEAT) && isWheat(B.WHEAT + 7) && !isWheat(B.SUGAR_CANE));
  assert.equal(BLOCKS[B.WHEAT].item, I.WHEAT_SEEDS, "seeds are what you plant");
});

test("chickens lay eggs now and then", () => {
  flat();
  const dir = mkdtempSync(join(tmpdir(), "steve-craft-eggs-"));
  try {
    const am = new AnimalManager(get, dir);
    const c = am.summon(3, WX + 0.5, GROUND + 1, WZ + 0.5)!;
    let eggs = 0;
    am.onEgg = () => eggs++;
    (am as unknown as { eggs: Map<number, number> }).eggs.set(c.id, 3);
    for (let t = 0; t < 5; t++) am.tick([{ x: WX, y: GROUND + 1, z: WZ }]);
    assert.equal(eggs, 1, "an egg");
    const next = (am as unknown as { eggs: Map<number, number> }).eggs.get(c.id)!;
    assert.ok(next >= 6000 - 5 && next <= 12000, `the next one in 5-10 minutes (${next} ticks)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
