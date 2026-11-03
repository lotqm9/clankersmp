// clankersmp: the way to enchanted gear (v13), after the basics. Iron tools and armour, diamonds, obsidian (the smith's
// lava poured onto water, mined with a diamond pickaxe), a book, the enchanting table at the base with bookshelves
// round it, then the gear enchanted for rubies (shared/enchanting.ts). The brain shows the step each turn (techText)
// and has two skills for the new parts: making obsidian and enchanting.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Body, Rect } from "./body.ts";
import { B, BLOCKS, IS_WATER, SOLID } from "../shared/blocks.ts";
import { ENCH_COST, ENCH_SHELVES, levelForShelves, planEnchant, shelvesAround } from "../shared/enchanting.ts";
import { ENCH_MAX, I, enchKindOf, itemDef, plainOf, type Stack } from "../shared/items.ts";
import { canHarvest } from "../shared/mining.ts";
import { LAST_START, tripNeeds } from "./mine.ts";

/** Where the pack's enchanting table stands (one for all three), kept with the agents' state. */
const TECH: { table: [number, number, number] | null } = { table: null };
let techFile = "";
function load(): void {
  if (techFile) return;
  techFile = join(process.env.AGENT_STATE_DIR || join(process.cwd(), "agent-state"), "tech.json");
  try {
    const j = JSON.parse(readFileSync(techFile, "utf8"));
    if (Array.isArray(j.table) && j.table.length === 3 && j.table.every(Number.isInteger)) TECH.table = j.table;
  } catch {
    // nothing yet
  }
}
function save(): void {
  try {
    mkdirSync(dirname(techFile), { recursive: true });
    writeFileSync(techFile, JSON.stringify(TECH));
  } catch (e) {
    console.error("couldn't save the tech state", (e as Error).message);
  }
}

const all = (b: Body): Stack[] => [...b.inv, ...b.armor].filter((s): s is Stack => !!s);
const plain = (id: number) => itemDef(plainOf(id));
/** Iron or better armour pieces it has (worn or carried), one per slot. */
function goodArmour(b: Body): number {
  const slots = new Set<number>();
  for (const s of all(b)) {
    const a = plain(s.id)?.armor;
    if (a && a.material >= 1) slots.add(a.slot);
  }
  return slots.size;
}
const hasTool = (b: Body, kind: string, tier: number) => all(b).some((s) => plain(s.id)?.tool?.kind === kind && (plain(s.id)?.tool?.tier ?? 0) >= tier);
const diamondPick = (b: Body) => b.inv.some((s) => s && canHarvest(B.OBSIDIAN, s.id));
const enchanted = (b: Body) => all(b).filter((s) => itemDef(s.id)?.ench).length;

/** The pack's table, if it still stands (checked against what this body sees of the world). */
export function tableAt(b: Body): [number, number, number] | null {
  load();
  if (TECH.table && b.get(...TECH.table) === B.ENCHANTING_TABLE) return TECH.table;
  const f = b.findBlocks([B.ENCHANTING_TABLE], 48, 1)[0];
  if (f) {
    TECH.table = f;
    save();
    return f;
  }
  return null;
}

/** What its next gear wants from the deep ("" if nothing): iron for the armour, diamonds, rubies for enchanting. */
export function deepGoal(b: Body): string {
  if (!hasTool(b, "pickaxe", 3)) return "";
  if (goodArmour(b) < 4) return "iron for your armour";
  const table = tableAt(b);
  if (!diamondPick(b) && !table) return "diamonds";
  if (table && b.count(I.RUBY) < ENCH_COST[levelForShelves(shelvesAround(b.get, ...table))]) return "rubies for enchanting";
  return "";
}

/** One line for the turn: what it has along the way to enchanted gear, and the next step. */
export function techText(b: Body): string {
  const armour = goodArmour(b);
  const obsidian = b.count(B.OBSIDIAN);
  const table = tableAt(b);
  const rubies = b.count(I.RUBY);
  // v14: the deep trip (agents/mine.ts) is how diamonds, rubies and iron by the stack come: is it ready for one?
  const needs = tripNeeds(b);
  const trip = `a mine_trip in the morning (dawn to time ${LAST_START})${needs.length ? ` once you have ${needs.join(", ")}` : ": you're ready for one"}`;
  let next = "";
  if (!hasTool(b, "pickaxe", 3)) next = "an iron_pickaxe (iron_ore with a stone pickaxe, smelted)";
  else if (!hasTool(b, "sword", 3) && !hasTool(b, "axe", 3)) next = "an iron_sword";
  else if (armour < 4) next = `iron armour, ${armour}/4 pieces (24 iron for all four: it takes more than half off every hit): iron_ore near the surface with collect, or by the stack on ${trip}`;
  else if (!diamondPick(b) && !table) next = `diamonds, deep (y 4 to 16): 3 for a diamond_pickaxe, 2 for the enchanting table. They come from ${trip} (it digs down to them, mines every ore on the way and is back up before dusk)`;
  else if (!table && !b.has(B.ENCHANTING_TABLE) && obsidian < 4) next = `obsidian ${obsidian}/4: a smith sells a lava_bucket for 2 rubies and your empty bucket, then collect obsidian pours it onto water and mines it with the diamond pickaxe`;
  else if (!table && !b.has(B.ENCHANTING_TABLE) && !b.has(I.BOOK)) next = "a book (3 paper from sugar_cane, 1 leather from a cow; or a librarian binds one for a ruby and 3 paper)";
  else if (!table && !b.has(B.ENCHANTING_TABLE)) next = "craft the enchanting_table (a book on 2 diamonds and 4 obsidian, at a crafting table)";
  else if (!table) next = "put the enchanting table up at the base: enchant does it";
  else {
    const shelves = shelvesAround(b.get, ...table);
    const top = levelForShelves(shelves);
    next = `enchant your gear (sword, armour, pickaxe) at the table: level ${top} now, ${ENCH_COST[top]} rubies each (you have ${rubies}${rubies < ENCH_COST[top] ? `: ruby_ore is deep, ${trip}, or trade` : ""})${top < ENCH_MAX ? `; ${ENCH_SHELVES[top + 1]} bookshelves round it make level ${top + 1} (${shelves} now: enchant puts any you carry in)` : ""}`;
  }
  const have: string[] = [];
  if (armour) have.push(`iron+ armour ${armour}/4`);
  if (diamondPick(b)) have.push("a diamond pickaxe");
  if (obsidian) have.push(`${obsidian} obsidian`);
  if (b.has(I.BOOK)) have.push("a book");
  if (table) have.push(`the enchanting table at x=${table[0]} z=${table[2]}`);
  if (enchanted(b)) have.push(`${enchanted(b)} enchanted`);
  return `Gear (after the basics, the way to enchanted gear): ${have.length ? `you have ${have.join(", ")}; ` : ""}next: ${next}.`;
}

// ---------------------------------------------------------------- obsidian

const SIDES: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

interface ObsidianSite {
  lava: [number, number, number]; // where the lava goes: on top of a water source
  stand: [number, number, number]; // the bank beside the water it stands on (its feet one up)
  post: [number, number, number] | null; // a block to put beside the lava's cell first (a block needs one beside it)
}

/** Where lava can be set into obsidian and the obsidian picked up again: a water source with air over it (the lava
 *  goes there) and a dry bank beside it at the water's level to stand on, so the obsidian mined over the water drops
 *  onto it within reach (a pool sunk below the bank would swallow it). */
function obsidianSite(b: Body, r: number, near?: [number, number, number]): ObsidianSite | null {
  const [fx, fy, fz] = near ?? [Math.floor(b.phys.x), Math.floor(b.phys.y + 0.1), Math.floor(b.phys.z)];
  let best: ObsidianSite | null = null;
  let bd = Infinity;
  const standable = (x: number, y: number, z: number) => SOLID[b.get(x, y, z)] && !IS_WATER[b.get(x, y, z)] && !SOLID[b.get(x, y + 1, z)] && !IS_WATER[b.get(x, y + 1, z)] && !SOLID[b.get(x, y + 2, z)];
  for (let dz = -r; dz <= r; dz++)
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -4; dy <= 2; dy++) {
        const x = fx + dx;
        const y = fy - 1 + dy; // the water's level (one below the feet when it's flush with the ground)
        const z = fz + dz;
        if (b.get(x, y, z) !== B.WATER || b.get(x, y + 1, z) !== B.AIR) continue;
        for (const [sx, sz] of SIDES) {
          if (!standable(x + sx, y, z + sz)) continue;
          // the lava's cell needs a block beside it: one there already, or a post on the bank across from the stand
          let post: [number, number, number] | null = null;
          let ok = false;
          for (const [qx, qz] of SIDES) {
            if (qx === sx && qz === sz) continue;
            const c = b.get(x + qx, y + 1, z + qz);
            if (SOLID[c] && !IS_WATER[c]) ok = true;
            else if (!post && c === B.AIR && SOLID[b.get(x + qx, y, z + qz)] && !IS_WATER[b.get(x + qx, y, z + qz)]) post = [x + qx, y + 1, z + qz];
          }
          if (!ok && !post) continue;
          const d = Math.hypot(x + sx - fx, y - (fy - 1), z + sz - fz);
          if (d < bd) {
            bd = d;
            best = { lava: [x, y + 1, z], stand: [x + sx, y, z + sz], post: ok ? null : post };
          }
        }
      }
  return best;
}

/** Obsidian the way it forms: the smith's lava poured onto water sets at once (a hiss of steam), and only a diamond
 *  pickaxe gets it out whole (9 seconds a block). At water near it (a pond's edge, the shore) or a little pool of its
 *  own from its water bucket (a pit a block deep, filled in again after). It stands on the bank the whole time. */
export async function collectObsidian(b: Body, want: number): Promise<string> {
  const start = b.count(B.OBSIDIAN);
  if (!b.has(I.LAVA_BUCKET)) return "obsidian is lava set by water, and you have no lava: a smith in a village sells a lava_bucket for 2 rubies and an empty bucket (trade with: smith), one per obsidian";
  if (!diamondPick(b)) return "only a diamond pickaxe mines obsidian (3 diamonds and 2 sticks): get one first, then come back with the lava";
  let site = obsidianSite(b, 12);
  let pool: [number, number, number] | null = null;
  if (!site && !b.has(I.WATER_BUCKET) && b.has(I.BUCKET)) await b.fillBucket();
  if (!site && b.has(I.WATER_BUCKET)) {
    // a pool of its own beside it: the ground block out, the water in, flush with the ground
    const fx = Math.floor(b.phys.x);
    const fz = Math.floor(b.phys.z);
    const gy = Math.floor(b.phys.y + 0.1) - 1;
    for (const [sx, sz] of SIDES) {
      const x = fx + sx;
      const z = fz + sz;
      if (!SOLID[b.get(x, gy, z)] || !SOLID[b.get(x, gy - 1, z)] || SOLID[b.get(x, gy + 1, z)] || SOLID[b.get(x, gy + 2, z)] || b.waterNear(x, gy, z, 1, 1)) continue;
      if (!(await b.mine(x, gy, z, false))) continue;
      if (!(await b.place(I.WATER_BUCKET, x, gy, z, 0))) continue;
      pool = [x, gy, z];
      await b.wait(6);
      site = obsidianSite(b, 2);
      break;
    }
  }
  if (!site) return "no water to pour the lava onto near here: go to a pond or the shore, or carry a water_bucket (it makes a pool)";
  const [x, y, z] = site.lava;
  const [sx, sy, sz] = site.stand;
  await b.goto(sx + 0.5, sy + 1, sz + 0.5, 0.35, { maxMs: 20000 });
  if (b.reachTo(x, y, z) > 4) return "couldn't get to the water's edge";
  let placedPost = false;
  if (site.post) {
    const f = b.fillerBlock();
    if (!f || !(await b.place(f, ...site.post, 0))) return "couldn't put a block beside the water to pour against";
    placedPost = true;
  }
  let why = "";
  for (let k = 0; k < want && b.has(I.LAVA_BUCKET) && !b.abort && !b.dead; k++) {
    if (b.get(x, y, z) === B.AIR) {
      b.action = "pouring lava onto water";
      if (!(await b.place(I.LAVA_BUCKET, x, y, z, 0))) {
        why = "the lava wouldn't pour there";
        break;
      }
      await b.wait(4);
    }
    if (b.get(x, y, z) !== B.OBSIDIAN) {
      why = "the lava didn't set";
      break;
    }
    b.action = "mining obsidian";
    if (!(await b.mine(x, y, z, false))) {
      why = "couldn't mine the obsidian";
      break;
    }
    // it drops onto the water beside its feet: picked up where it stands
    for (let t = 0; t < 30 && b.items.size && ![...b.items.values()].every((it) => Math.hypot(it.x - b.phys.x, it.z - b.phys.z) > 3); t++) await b.nextTick();
  }
  await b.pickUp(2, 2500);
  if (!b.dead) {
    // tidy up: the post back in the bag, the pool's water back in the bucket and the pit filled
    if (placedPost && site.post && SOLID[b.get(...site.post)]) await b.mine(...site.post, false);
    if (pool) {
      const [px, py, pz] = pool;
      if (b.get(px, py, pz) === B.WATER && b.has(I.BUCKET)) {
        await b.hold(I.BUCKET);
        await b.lookAt(px + 0.5, py + 0.5, pz + 0.5, 15);
        b.send({ t: "use", x: px, y: py, z: pz });
        await b.wait(6);
      }
      const f = b.fillerBlock();
      if (f && !SOLID[b.get(px, py, pz)]) await b.place(f, px, py, pz, 0);
    }
  }
  const got = b.count(B.OBSIDIAN) - start;
  return got ? `made ${got} obsidian (lava poured onto water, mined with the diamond pickaxe)${why ? `; then ${why}` : ""}` : `made no obsidian: ${why || "nothing happened"}`;
}

// ---------------------------------------------------------------- the enchanting table

/** Free cells of the bookshelf ring round a table (two out, on its level and one up), leaving the middle three of the
 *  side it's walked into from open, so the table can always be reached. */
function ringCells(t: [number, number, number], openSide: [number, number]): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const dy of [0, 1])
    for (let dz = -2; dz <= 2; dz++)
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== 2) continue;
        if ((openSide[0] && dx === 2 * openSide[0] && Math.abs(dz) <= 1) || (openSide[1] && dz === 2 * openSide[1] && Math.abs(dx) <= 1)) continue;
        out.push([t[0] + dx, t[1] + dy, t[2] + dz]);
      }
  return out;
}

/** The pack's enchanting table, set up: one it can see, or the one it carries put up at the base (a flat spot with
 *  room for the bookshelf ring, clear of the town's buildings), and any bookshelves it carries put in the ring. */
async function setUpTable(b: Body, base: { x: number; y: number; z: number } | null, avoid: Rect[]): Promise<[number, number, number] | string> {
  let t = tableAt(b);
  if (!t) {
    if (!b.has(B.ENCHANTING_TABLE)) return "there's no enchanting table: craft one (a book on 2 diamonds and 4 obsidian, at a crafting table)";
    const cx = base ? base.x : Math.floor(b.phys.x);
    const cz = base ? base.z : Math.floor(b.phys.z);
    const cy = base ? base.y : Math.floor(b.phys.y + 0.1);
    if (base && Math.hypot(base.x - b.phys.x, base.z - b.phys.z) > 40) return `the enchanting table goes up at the pack's base (x=${base.x} z=${base.z}): go_to_base first`;
    const site = b.siteNear(cx, cz, cy, 5, 5, avoid, 22, 4, 1);
    if (!site) return "no flat spot near the base with room for the table and its bookshelves";
    const tx = site.x0 + 2;
    const tz = site.z0 + 2;
    // on its own column's ground (the site's height is its highest ground: on a slope the middle can be a block lower)
    const g = b.naturalGround(tx, tz, site.y);
    const ty = g >= 0 ? g + 1 : site.y;
    if (!(await b.place(B.ENCHANTING_TABLE, tx, ty, tz, 30000))) return "couldn't put the enchanting table down";
    t = [tx, ty, tz];
    TECH.table = t;
    save();
  }
  // bookshelves it carries go into the ring (open on the side facing the base, so it's always walked into)
  if (b.has(B.BOOKSHELF)) {
    // (no base yet: open toward where it stands)
    const toX = base ? base.x : b.phys.x;
    const toZ = base ? base.z : b.phys.z;
    const ox = Math.abs(toX - t[0]) >= Math.abs(toZ - t[2]) ? Math.sign(toX - t[0]) || 1 : 0;
    const oz = ox ? 0 : Math.sign(toZ - t[2]) || 1;
    for (const [x, y, z] of ringCells(t, [ox, oz])) {
      if (!b.has(B.BOOKSHELF) || b.abort || b.dead) break;
      if (b.get(x, y, z) !== B.AIR || (y === t[1] + 1 && !SOLID[b.get(x, y - 1, z)])) continue;
      if (y === t[1] && !SOLID[b.get(x, y - 1, z)]) continue;
      await b.place(B.BOOKSHELF, x, y, z, 15000);
    }
  }
  return t;
}

/** Enchant its gear at the pack's table: `what` (an item it carries or wears), else the best thing to make better
 *  first (the weapon, then the armour from the chest down, then the pickaxe), at the highest level the bookshelves
 *  allow and its rubies pay for. Sets the table up first if it carries one and none stands. */
export async function enchant(b: Body, what: string, level: number, base: { x: number; y: number; z: number } | null, avoid: Rect[]): Promise<string> {
  const t = await setUpTable(b, base, avoid);
  if (typeof t === "string") return t;
  const rubies = b.count(I.RUBY);
  const top = levelForShelves(shelvesAround(b.get, ...t));
  // the choices: what it carries (by name, or the best things first) and the armour it wears
  type Pick = { id: number; slot: number }; // slot: the armour slot it's worn in, or -1 (carried)
  const picks: Pick[] = [];
  const want = what.toLowerCase().replace(/\s+/g, "_");
  for (const s of b.inv) if (s && enchKindOf(plainOf(s.id))) picks.push({ id: s.id, slot: -1 });
  b.armor.forEach((s, k) => {
    if (s && enchKindOf(plainOf(s.id))) picks.push({ id: s.id, slot: k });
  });
  const order = (p: Pick) => {
    const d = plain(p.id);
    if (d?.tool && (d.tool.kind === "sword" || d.tool.kind === "axe")) return p.id === b.bestWeapon() ? 0 : 6;
    if (d?.armor) return [3, 1, 2, 4][d.armor.slot] - (p.slot >= 0 ? 0.5 : 0);
    return d?.tool?.kind === "pickaxe" ? 5 : 7;
  };
  const named = want ? picks.filter((p) => itemDef(p.id)?.key === want || plain(p.id)?.key === want || plain(p.id)?.key.includes(want)) : picks;
  if (want && !named.length) return `you have no ${what} to enchant (swords, axes, pickaxes, shovels and armour can be)`;
  const choice = named
    .map((p) => ({ p, plan: planEnchant(p.id, rubies, shelvesAround(b.get, ...t), level || 0) }))
    .sort((a, c) => (a.plan.id ? 0 : 1) - (c.plan.id ? 0 : 1) || order(a.p) - order(c.p))[0];
  if (!choice) return "you have nothing that can be enchanted (swords, axes, pickaxes, shovels and armour can be)";
  if (!choice.plan.id) return `can't enchant your ${plain(choice.p.id)?.key ?? what}: ${choice.plan.why} (the table here gives level ${top}${top < ENCH_MAX ? `; ${ENCH_SHELVES[top + 1]} bookshelves round it make level ${top + 1}` : ""})`;
  // to the table, and the thing in hand (armour is enchanted where it's worn)
  if (b.reachTo(...t) > 3.8) {
    const spot = b.standFor(...t);
    await b.goto(spot ? spot[0] + 0.5 : t[0] + 0.5, spot ? spot[1] : t[1], spot ? spot[2] + 0.5 : t[2] + 0.5, 1.2, { maxMs: 40000, done: () => b.reachTo(...t) <= 3.8 });
    if (b.reachTo(...t) > 4.3) return "couldn't get to the enchanting table";
  }
  if (choice.p.slot < 0 && !(await b.hold(choice.p.id))) return `couldn't take the ${plain(choice.p.id)?.key} in hand`;
  await b.lookAt(t[0] + 0.5, t[1] + 1, t[2] + 0.5, 15);
  b.action = "enchanting at the table";
  const r = await b.enchantHeld(level || 0, choice.p.slot);
  if (!r.id) return `the table didn't enchant it: ${r.why ?? "no answer"}`;
  if (choice.p.slot >= 0) b.wearBest();
  return `enchanted: ${itemDef(r.id)?.key} for ${r.cost} rubies (${b.count(I.RUBY)} left)`;
}

/** The block names an agent may ask to collect that this module handles. */
export const isObsidian = (name: string) => /^obsidian$/.test(name.toLowerCase().trim()) || BLOCKS[B.OBSIDIAN].key === name;
