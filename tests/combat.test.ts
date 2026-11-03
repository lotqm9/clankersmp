// Combat and armour rules (protocol v6), Java 1.9+ numbers: the attack cooldown curve per item, damage scaling with
// the charge, critical hits only while falling, the armour formula and wear, armour items and recipes, and the
// inventory's armour slots (only the matching piece fits; shift-click puts armour on; nothing duplicates).

import { test } from "node:test";
import assert from "node:assert/strict";
import { B } from "../shared/blocks.ts";
import { afterArmor, armorOf, armorWear, attackDamageOf, attackStrength, cooldownTicks, isCrit, packArmor, swingDamage, wornMaterial } from "../shared/combat.ts";
import { HAND_DAMAGE, I, ITEMS, armorId, itemDef, maxDurability, toolId, type Stack } from "../shared/items.ts";
import { Menu, countItems, newPlayerInv } from "../shared/inventory.ts";
import { RECIPES, matchRecipe } from "../shared/recipes.ts";
import { mulberry32 } from "../shared/noise.ts";

const S = (id: number, n = 1, d = 0): Stack => ({ id, n, d });
const SWORD = (m: number) => toolId(m, 3);
const AXE = (m: number) => toolId(m, 1);
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

test("attack cooldown: an empty hand recharges in 5 ticks, swords in 12.5, axes in 25-20; damage scales with the charge", () => {
  assert.equal(cooldownTicks(0), 5);
  assert.equal(cooldownTicks(SWORD(2)), 12.5);
  assert.equal(cooldownTicks(AXE(0)), 25);
  assert.equal(cooldownTicks(AXE(4)), 20);
  assert.equal(attackStrength(0, SWORD(2)), 0.5 / 12.5, "a swing right after another is weak");
  assert.equal(attackStrength(12, SWORD(2)), 1, "fully charged after 12.5 ticks");
  assert.ok(near(attackStrength(6, SWORD(2)), 6.5 / 12.5));
  assert.equal(attackDamageOf(0), HAND_DAMAGE);
  assert.equal(attackDamageOf(SWORD(4)), 7, "a diamond sword: 7");
  assert.equal(attackDamageOf(AXE(1)), 9, "a stone axe: 9 (slow)");
  assert.ok(near(swingDamage(SWORD(2), 1, false), 6), "an iron sword, charged: 6");
  assert.ok(near(swingDamage(SWORD(2), 0, false), 6 * 0.2), "spam: a fifth of it");
  assert.ok(near(swingDamage(SWORD(2), 0.5, false), 6 * (0.2 + 0.25 * 0.8)));
  assert.ok(near(swingDamage(SWORD(2), 1, true), 9), "a critical hit: x1.5");
});

test("critical hits: charged, falling, not on the ground, a ladder, in water, or sprinting", () => {
  const air = { falling: true, onGround: false, climbing: false, inWater: false, sprinting: false };
  assert.ok(isCrit(1, air));
  assert.ok(!isCrit(0.85, air), "needs over 0.9 charge");
  assert.ok(!isCrit(1, { ...air, falling: false }), "going up is no crit");
  assert.ok(!isCrit(1, { ...air, onGround: true }));
  assert.ok(!isCrit(1, { ...air, climbing: true }));
  assert.ok(!isCrit(1, { ...air, inWater: true }));
  assert.ok(!isCrit(1, { ...air, sprinting: true }));
});

test("armour: Java's formula, toughness, wear per hit, and what others see", () => {
  // a full diamond set: 20 points, toughness 8
  const dia = [0, 1, 2, 3].map((k) => S(armorId(2, k)));
  const a = armorOf(dia);
  assert.deepEqual(a, { points: 20, tough: 8, prot: 0 }); // v13: and no Protection on it
  assert.ok(near(afterArmor(10, a.points, a.tough), 3), "10 damage through full diamond: 3");
  const iron = armorOf([0, 1, 2, 3].map((k) => S(armorId(1, k))));
  assert.deepEqual(iron, { points: 15, tough: 0, prot: 0 });
  assert.ok(near(afterArmor(3, iron.points, 0), 3 * (1 - 13.5 / 25)), "a Shambler's 3 through full iron: 1.38");
  const leather = armorOf([0, 1, 2, 3].map((k) => S(armorId(0, k))));
  assert.equal(leather.points, 7);
  assert.equal(afterArmor(5, 0, 0), 5, "no armour, no change");
  assert.equal(armorWear(3), 1);
  assert.equal(armorWear(9), 2);
  const packed = packArmor([S(armorId(1, 0)), null, S(armorId(2, 2)), S(armorId(0, 3))]);
  assert.deepEqual([0, 1, 2, 3].map((k) => wornMaterial(packed, k)), [1, -1, 2, 0]);
  assert.equal(packArmor([S(armorId(1, 2)), null, null, null]), 0, "a piece in the wrong slot doesn't count");
});

test("armour items: 12 pieces with points, durability and a classic recipe each; mob drops are items", () => {
  let pieces = 0;
  for (const d of ITEMS) if (d?.armor && !d.ench) pieces++; // v13: the enchanted ones are the same pieces made better
  assert.equal(pieces, 12);
  for (let m = 0; m < 3; m++)
    for (let k = 0; k < 4; k++) {
      const id = armorId(m, k);
      const d = itemDef(id)!;
      assert.equal(d.armor!.slot, k);
      assert.equal(d.stack, 1, "armour doesn't stack");
      assert.ok(maxDurability(id) > 0);
      assert.ok(RECIPES.some((r) => r.out.id === id), `${d.name} has a recipe`);
    }
  // the chestplate: M_M / MMM / MMM in iron ingots
  const g = [I.IRON_INGOT, 0, I.IRON_INGOT, I.IRON_INGOT, I.IRON_INGOT, I.IRON_INGOT, I.IRON_INGOT, I.IRON_INGOT, I.IRON_INGOT];
  assert.equal(matchRecipe(g, 3)?.out.id, armorId(1, 1));
  for (const id of [I.SPOILED_FLESH, I.BONE, I.STRING, I.BONE_MEAL]) assert.ok(itemDef(id)?.name, `item ${id}`);
  assert.ok(itemDef(I.SPOILED_FLESH)!.food!.queasy! > 0, "spoiled flesh can make you queasy");
  assert.equal(matchRecipe([I.BONE, 0, 0, 0], 2)?.out.id, I.BONE_MEAL, "a bone makes bone meal");
  assert.equal(matchRecipe([I.STRING, I.STRING, I.STRING, I.STRING], 2)?.out.id, B.WOOL_WHITE, "four string make wool");
});

test("the inventory's armour slots: only the matching piece fits; shift-click puts armour on (and takes it off)", () => {
  const p = newPlayerInv();
  const m = new Menu("player", p);
  const cur = { s: null as Stack | null };
  const helmet = S(armorId(1, 0));
  // the cursor holds a helmet: it won't go in the chest slot (6), it goes in the head slot (5)
  cur.s = { ...helmet };
  m.click({ m: "pick", s: 6, b: 0 }, cur);
  assert.equal(p.armor[1], null, "a helmet doesn't fit the chest slot");
  m.click({ m: "pick", s: 5, b: 0 }, cur);
  assert.equal(p.armor[0]?.id, helmet.id, "it fits the head slot");
  assert.equal(cur.s, null);
  // a stick never goes into an armour slot
  cur.s = S(I.STICK, 5);
  m.click({ m: "pick", s: 7, b: 0 }, cur);
  assert.equal(p.armor[2], null);
  cur.s = null;
  // shift-click: boots from the inventory go straight onto the feet
  p.inv[12] = S(armorId(2, 3));
  m.click({ m: "shift", s: m.invStart + 3, b: 0 } as never, cur);
  assert.equal(p.armor[3]?.id, armorId(2, 3), "shift-click wears them");
  assert.equal(p.inv[12], null);
  // and shift-click on a worn piece takes it off into the inventory
  m.click({ m: "shift", s: 8 } as never, cur);
  assert.equal(p.armor[3], null);
  assert.equal(countItems(p.inv).get(`${armorId(2, 3)}:0`), 1);
});

test("anti-dupe fuzz with armour: random clicks in the inventory never create or lose a piece", () => {
  const rnd = mulberry32(606);
  const ids = [armorId(0, 0), armorId(1, 1), armorId(2, 2), armorId(0, 3), I.STICK, B.DIRT, SWORD(2)];
  for (let round = 0; round < 200; round++) {
    const p = newPlayerInv();
    for (let k = 0; k < 36; k++) if (rnd() < 0.4) {
      const id = ids[Math.floor(rnd() * ids.length)];
      p.inv[k] = S(id, itemDef(id)!.stack === 1 ? 1 : 1 + Math.floor(rnd() * 16));
    }
    const total = (cur: Stack | null) => {
      const t = new Map<number, number>();
      for (const st of [...p.inv, ...p.armor, ...p.craft, cur]) if (st) t.set(st.id, (t.get(st.id) ?? 0) + st.n);
      return t;
    };
    const cur = { s: null as Stack | null };
    const m = new Menu("player", p);
    const before = total(null);
    const thrown = new Map<number, number>();
    for (let c = 0; c < 100; c++) {
      const s = Math.floor(rnd() * m.size);
      const kind = Math.floor(rnd() * 6);
      const click = kind === 0 ? { m: "pick" as const, s, b: (rnd() < 0.5 ? 0 : 1) as 0 | 1 } : kind === 1 ? { m: "shift" as const, s } : kind === 2 ? { m: "swap" as const, s, h: Math.floor(rnd() * 9) } : kind === 3 ? { m: "collect" as const, s } : kind === 4 ? { m: "drag" as const, b: 0 as const, list: [s, (s + 1) % m.size, (s + 9) % m.size] } : { m: "pick" as const, s, b: 0 as const };
      const res = m.click(click, cur);
      for (const d of res.drops) thrown.set(d.id, (thrown.get(d.id) ?? 0) + d.n);
      for (const k of [0, 1, 2, 3]) {
        const st = p.armor[k];
        if (st) assert.equal(itemDef(st.id)?.armor?.slot, k, "only the matching piece is ever worn");
      }
    }
    for (const d of m.close(cur)) thrown.set(d.id, (thrown.get(d.id) ?? 0) + d.n);
    const after = total(cur.s);
    for (const [id, n] of before) assert.equal((after.get(id) ?? 0) + (thrown.get(id) ?? 0), n, `item ${id} conserved`);
  }
});
