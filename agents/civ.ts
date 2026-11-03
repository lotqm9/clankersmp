// The pack's civilization: the buildings it can put up around its base, the plan (block by block) of each at each of
// its tiers, and the stages it climbs from a camp to a capital. All three AIs build from the same list (agents/brain.ts
// keeps it in pack.json), so any of them can pick up a building another one started.
//
// The designs follow the world's own village houses (shared/villages.ts), the best looking buildings on the island:
// a cobblestone footing, a stone base course, oak log corner posts and a log plate under the roof, plank walls, a
// gable roof of stairs with eaves all round, a door, windows, a plank floor and a light inside. Every part is one
// material all the way along (the old plans let each block be whatever the builder had: walls came out a patchwork of
// cobblestone and planks, "slop with cobblestone and wood"). Tier 1 is what three players can gather and craft in a
// day (cobblestone, oak logs, planks, stairs, a door, fences for window bars); tier 2 swaps in better materials and
// adds details (stone bricks, glass, a chimney, furniture); tier 3 is the finishing touches (lanterns, which take
// iron, and the rest). An upgrade mines out the lower-grade blocks and puts the planned ones in.

import { B, BLOCKS, IS_WATER, isChest, isFurnace, isGate, isLantern, isPot, isStorage, isTrapdoor } from "../shared/blocks.ts";
import { I } from "../shared/items.ts";
import { doorId, isDoor, isLadder, slabBase, stairBase } from "../shared/shapes.ts";
import type { PlanCell, Rect } from "./body.ts";

/** A kind of thing the town builds: a category (house, smithy, barn...) that the stages count. The catalog
 *  (agents/catalog.ts) has many designs for most kinds; "farm", "wall" and "road" are planned on their own. */
export type Kind = string;
/** The kinds that are one building on one rectangle, planned by planFor. */
export type Plain = string;
/** Kinds the town has only one of (building it again carries on with that one). */
export const ONCE: ReadonlySet<Kind> = new Set<Kind>(["wall", "road", "plaza", "keep", "cathedral"]);

export interface Building extends Rect {
  kind: Kind;
  /** Which design of the catalog it is built to (none: the kind's first design, the one older towns were built to). */
  design?: string;
  y: number;
  by: string[];
  done: boolean;
  at: number;
  /** Turns in a row nobody could place a block on it: a bad spot, given up on after a few. */
  stuck?: number;
  /** Finished, but it has since lost a good part of itself (or an upgrade's worth): it needs fixing back up. */
  fix?: boolean;
  /** Who is building it right now, and since when: one builder at a time, so two don't circle the same well. */
  busy?: { by: string; at: number };
  /** The tier it is built to, as last measured against the plans: 0 is an old building that doesn't meet the tier 1
   *  design (it stands, but has to be rebuilt to count); an old record without one is taken as tier 1 until an AI
   *  near it measures it. */
  tier?: number;
  /** The best tier it has reached: when the measured tier falls below it, it needs fixing. */
  best?: number;
  /** The tier it is being upgraded to right now (it keeps counting at its old tier until that's done). */
  up?: number;
  /** The side its front (its door) faces, toward the middle of the town: 0 north, 1 east, 2 south, 3 west. Old
   *  records face north, the way the old plans built them. */
  face?: number;
  /** The roads: how many buildings their paths join to the plaza, [any path, paved]. */
  joined?: [number, number];
  /** A cottage someone has moved into: whose home it is. */
  owner?: string;
  /** Its lot is dug into a slope: the ground over its floor across the whole rectangle is cut away (a terrace). */
  cut?: boolean;
}

/** How many tiers each kind has (roads and farms too). */
export const maxTier = (k: Kind, design?: string): number => (k === "road" ? 2 : k === "farm" ? 3 : (DESIGNS[design ?? k] ?? KINDS[k])?.tiers ?? 1);
/** What an upgrade of a farm or the roads adds. */
export const UP_EXTRA: Record<"farm" | "road", string[]> = {
  farm: ["", "the field by the water", "a fence round the field with a gate", "lanterns on the fence corners"],
  road: ["", "dirt paths from every door to the plaza", "the paths paved in cobblestone"],
};

/** A need: [what, how many, of at least this tier]. "road" counts buildings joined to the plaza (or the base) by a
 *  path, "trade" trades made with villagers. Houses of tier 0 are anyone's shelter (build_house homes count). */
export type Need = [Kind | "trade", number, number?];
/** The stages, each on top of the one before. A city takes many hours of three players' work; past the capital the
 *  town keeps going (a kingdom, then an empire) with the grand buildings: the cathedral, monuments, fountains. Each
 *  stage's needs are listed in the order the town board takes them on (what the rest is built round comes first). */
export const STAGES: { name: string; needs: Need[] }[] = [
  { name: "a camp", needs: [["house", 1, 0]] },
  { name: "a homestead", needs: [["house", 2], ["farm", 1], ["well", 1]] },
  { name: "a hamlet", needs: [["storehouse", 1], ["house", 4], ["farm", 2], ["lamp", 4], ["road", 4]] },
  { name: "a village", needs: [["plaza", 1], ["house", 6], ["house", 2, 2], ["market", 1], ["farm", 3], ["lamp", 8], ["wall", 1], ["road", 8]] },
  { name: "a market town", needs: [["hall", 1], ["smithy", 1], ["tavern", 1], ["house", 8], ["house", 3, 2], ["market", 1, 2], ["tower", 1], ["lamp", 12], ["trade", 5], ["road", 12]] },
  { name: "a town", needs: [["bakery", 1], ["library", 1], ["chapel", 1], ["house", 10], ["house", 5, 2], ["house", 1, 3], ["farm", 4], ["hall", 1, 2], ["wall", 1, 2], ["tower", 2], ["plaza", 1, 2], ["storehouse", 1, 2], ["lamp", 16], ["lamp", 4, 2], ["trade", 10], ["road", 15]] },
  { name: "a city", needs: [["keep", 1], ["barn", 1], ["fountain", 1], ["monument", 1], ["house", 14], ["house", 8, 2], ["house", 3, 3], ["tower", 3], ["tower", 1, 2], ["hall", 1, 3], ["market", 1, 3], ["wall", 1, 3], ["smithy", 1, 2], ["tavern", 1, 2], ["farm", 6], ["farm", 2, 2], ["lamp", 24], ["lamp", 8, 2], ["trade", 20], ["road", 20]] },
  { name: "a capital", needs: [["cathedral", 1], ["monument", 2], ["house", 20], ["house", 12, 2], ["house", 6, 3], ["keep", 1, 3], ["tower", 4], ["tower", 2, 3], ["plaza", 1, 3], ["well", 1, 3], ["storehouse", 1, 3], ["library", 1, 2], ["chapel", 1, 2], ["bakery", 1, 2], ["farm", 8], ["farm", 4, 3], ["lamp", 32], ["lamp", 16, 2], ["trade", 30], ["road", 28, 2]] },
  { name: "a kingdom", needs: [["cathedral", 1, 2], ["fountain", 2], ["monument", 3], ["barn", 2], ["house", 26], ["house", 16, 2], ["house", 10, 3], ["library", 1, 3], ["tavern", 1, 3], ["smithy", 1, 3], ["bakery", 1, 3], ["fountain", 1, 2], ["tower", 6], ["farm", 10], ["farm", 6, 3], ["lamp", 40], ["lamp", 24, 2], ["trade", 40], ["road", 34, 2]] },
  { name: "an empire", needs: [["cathedral", 1, 3], ["chapel", 2], ["monument", 4], ["house", 32], ["house", 24, 2], ["house", 16, 3], ["chapel", 1, 3], ["monument", 2, 3], ["fountain", 2, 3], ["market", 2], ["barn", 2, 2], ["tower", 8], ["tower", 4, 3], ["farm", 12], ["lamp", 48], ["lamp", 32, 2], ["trade", 50], ["road", 40, 2]] },
];

const LABEL: Record<string, [string, string]> = {
  house: ["a house", "houses"], farm: ["a farm", "farms"], well: ["a well", "wells"], lamp: ["a lamp post", "lamp posts"],
  storehouse: ["a storehouse", "storehouses"], hall: ["a town hall", "town halls"], tower: ["a watchtower", "watchtowers"],
  market: ["a market", "markets"], wall: ["the wall round the town", "walls"], trade: ["a trade with a villager", "trades with villagers"],
  plaza: ["the plaza", "plazas"], keep: ["the keep", "keeps"], road: ["a building joined by a path", "buildings joined by paths"],
  smithy: ["a smithy", "smithies"], bakery: ["a bakery", "bakeries"], tavern: ["a tavern", "taverns"], library: ["a library", "libraries"],
  chapel: ["a chapel", "chapels"], barn: ["a barn", "barns"], fountain: ["a fountain", "fountains"], monument: ["a monument", "monuments"],
  cathedral: ["the cathedral", "cathedrals"],
};
export const label = (k: Kind | "trade", n = 1) => {
  const l = LABEL[k] ?? [`a ${k.replace(/_/g, " ")}`, `${k.replace(/_/g, " ")}s`];
  return n === 1 ? l[0] : l[1];
};
/** A kind's words, [one, many] (the catalog's new kinds register theirs). */
export function setLabel(k: Kind, one: string, many: string): void {
  LABEL[k] = [one, many];
}
/** A need in words: "6 houses", "2 houses at tier 2". */
export const needText = ([k, n, t]: Need, have?: number) =>
  `${n === 1 ? label(k) : `${n} ${label(k, n)}`}${k === "road" && t && t > 1 ? ", paved" : t === 0 ? " (any shelter)" : t && t > 1 ? ` at tier ${t}` : ""}${have !== undefined ? ` ${Math.min(have, n)}/${n}` : ""}`;

/** How far the pack has got: the stage reached (-1: none yet), and what the next one still needs. count(k, tier):
 *  how many of a kind the pack has at that tier or better. */
export function progress(count: (k: Kind | "trade", tier: number) => number): { stage: number; name: string; next: { name: string; needs: { need: Need; have: number }[] } | null } {
  let stage = -1;
  const met = ([k, n, t]: Need) => count(k, t ?? 1) >= n;
  for (let i = 0; i < STAGES.length; i++) {
    if (STAGES[i].needs.every(met)) stage = i;
    else break;
  }
  const n = STAGES[stage + 1];
  return {
    stage,
    name: stage >= 0 ? STAGES[stage].name : "nothing yet",
    next: n ? { name: n.name, needs: n.needs.map((need) => ({ need, have: Math.min(need[1], count(need[0], need[2] ?? 1)) })) } : null,
  };
}

// ---------------------------------------------------------------- what goes in a cell, and what counts as done

/** A plan cell's kind: "d" foundation (dirt is fine), "a" keep clear (inside a building: dirt, leaves, stray blocks
 *  out; furniture stays), "o" open (a doorway or the step in front of one: nothing solid but a door), "p" a path
 *  (dug with a shovel), or a block state: "123" required, "?123" a detail it skips when it can't get the material. */
export function cellTarget(k: string): { id: number; optional: boolean } | null {
  const bar = k.indexOf("|"); // "|" adds what a later tier puts there (that does as well)
  const k0 = bar < 0 ? k : k.slice(0, bar);
  const opt = k0.charCodeAt(0) === 63; // "?"
  const s = opt ? k0.slice(1) : k0;
  const c = s.charCodeAt(0);
  if (c < 48 || c > 57) return null;
  return { id: Number(s), optional: opt };
}
export const exact = (id: number) => String(id);
export const optional = (id: number) => `?${id}`;

/** The material families and their grades: a better grade counts for a plan that asks for a lower one (a tier 1 plan
 *  is met by a tier 2 building), never the other way round. Oak and birch count alike (whatever is already there
 *  stays), but the town only ever puts oak in, so a part never comes out half and half. */
const FAMILY = new Map<number, [string, number]>([
  [B.COBBLESTONE, ["stone", 1]], [B.MOSSY_COBBLE, ["stone", 1]], [B.STONE_BRICKS, ["stone", 2]], [B.MOSSY_STONE_BRICKS, ["stone", 2]],
  [B.OAK_PLANKS, ["planks", 1]], [B.BIRCH_PLANKS, ["planks", 1]],
  [B.OAK_LOG, ["log", 1]], [B.BIRCH_LOG, ["log", 1]], [B.PALM_LOG, ["log", 1]],
  [B.COBBLE_STAIRS, ["stone stairs", 1]], [B.STONE_BRICK_STAIRS, ["stone stairs", 2]],
  [B.OAK_STAIRS, ["wood stairs", 1]], [B.BIRCH_STAIRS, ["wood stairs", 1]],
  [B.COBBLE_SLAB, ["stone slab", 1]], [B.STONE_BRICK_SLAB, ["stone slab", 2]], [B.STONE_SLAB, ["stone slab", 2]],
  [B.OAK_SLAB, ["wood slab", 1]], [B.BIRCH_SLAB, ["wood slab", 1]],
  [B.COBBLE_WALL, ["stone wall", 1]], [B.STONE_BRICK_WALL, ["stone wall", 2]],
  [B.OAK_FENCE, ["fence", 1]], [B.BIRCH_FENCE, ["fence", 1]],
  [B.GLASS_PANE, ["glass", 1]], [B.GLASS, ["glass", 1]],
]);
const baseOf = (id: number) => {
  const s = stairBase(id);
  if (s >= 0) return s;
  const l = slabBase(id);
  return l >= 0 ? l : id;
};

/** Does the block `cur` already do for a cell that wants `target`? */
export function accepts(target: number, cur: number): boolean {
  if (cur === target) return true;
  if (isDoor(target)) return isDoor(cur);
  if (isChest(target) || target === B.BARREL) return isStorage(cur);
  if (isTrapdoor(target)) return isTrapdoor(cur);
  if (isGate(target)) return isGate(cur);
  if (isPot(target)) return isPot(cur);
  if (isLadder(target)) return isLadder(cur);
  if (isFurnace(target)) return isFurnace(cur);
  if (isLantern(target)) return isLantern(cur);
  if (target === B.TORCH) return isLantern(cur); // a lantern where a torch was planned is better
  if (target === B.WATER) return IS_WATER[cur] === 1;
  // soil: grass is soil too; a sapling has done its job once it has grown into its tree
  if (target === B.DIRT) return cur === B.GRASS;
  if (target === B.OAK_SAPLING) return cur === B.OAK_LOG;
  if (target === B.BIRCH_SAPLING) return cur === B.BIRCH_LOG;
  const tb = baseOf(target);
  const cb = baseOf(cur);
  if (target - tb !== cur - cb) return false; // stairs facing another way, a slab in the other half
  const tf = FAMILY.get(tb);
  const cf = FAMILY.get(cb);
  return !!tf && !!cf && tf[0] === cf[0] && cf[1] >= tf[1];
}

/** The item that places a block state (a water source comes out of a water bucket). */
export function itemOf(state: number): number {
  if (state === B.WATER) return I.WATER_BUCKET;
  return BLOCKS[state]?.item || state;
}

/** Placed last, once the building is up: they stand on, hang from or lean on the blocks round them. */
const late = (id: number) =>
  id === B.TORCH || isLantern(id) || isDoor(id) || isLadder(id) || isPot(id) || isChest(id) || isFurnace(id) || isTrapdoor(id) || isGate(id) ||
  id === B.BARREL || id === B.CRAFTING_TABLE || id === B.WATER || id === B.HAY_BALE || id === B.BOOKSHELF;

// ---------------------------------------------------------------- the plans

export interface Site extends Rect {
  kind: Kind;
  y: number;
  face?: number;
  design?: string;
  cut?: boolean;
}

/** The side of a rectangle that faces a point (the town's middle): 0 north, 1 east, 2 south, 3 west. */
export function faceToward(r: Rect, cx: number, cz: number): number {
  const dx = cx - (r.x0 + r.x1) / 2;
  const dz = cz - (r.z0 + r.z1) / 2;
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 1 : 3;
  return dz > 0 ? 2 : 0;
}
/** The rectangle a kind takes with its front facing `face` (a 9 by 11 building turned east is 11 by 9). */
export function sizeFacing(kindOrDesign: string, face: number): [number, number] {
  const [w, d] = (DESIGNS[kindOrDesign] ?? KINDS[kindOrDesign]).size;
  return face % 2 ? [d, w] : [w, d];
}
/** The blueprint a building (or a site) is built to: its design, else its kind's first one. */
export function designOf(b: { kind: Kind; design?: string }): Blueprint | undefined {
  return BLUEPRINTS[b.design ?? ""] ?? BLUEPRINTS[b.kind];
}

// ---------------------------------------------------------------- the blueprints

/** A material per tier: [tier 1, tier 2, tier 3]. Every cell of a part is that one block (0: the part is left open). */
export type Mat = [number, number, number];
export const all3 = (id: number): Mat => [id, id, id];
/** A position along a building's front (u, from its left wall) or into it (v, from its front wall): a number counts
 *  from that wall (a negative one from the far wall: -1 is the far wall itself, -2 the cell inside it), "mid" is the
 *  middle ("mid-1", "mid+1" beside it), and "out" (v only) is the step outside the front wall. */
export type Pos = number | string;

/** A piece of furniture (or a light, or a detail) in a blueprint. */
export interface Furniture {
  /** The block: a chest, the foot of a bed, a crafting table, a furnace, a lantern, a slab for a table... */
  block: number;
  /** [u, dy, v]: dy up from the floor; with `hang` it hangs from the roof over that spot instead. */
  at: [Pos, number, Pos];
  /** The way it faces in the building: "in" (to the back), "out" (to the door), "left", "right". A bed's head lies
   *  that way from its foot; stairs (a bench) have their back that way. */
  facing?: "in" | "out" | "left" | "right";
  /** Hangs from the roof (a lantern). */
  hang?: boolean;
  /** The first tier it's in. */
  tier: number;
  /** A detail it leaves out when the material can't be had (it doesn't hold the building back). */
  optional?: boolean;
}

/** The parts a building is made of; a blueprint says which block each one is at each tier. */
/** The parts a building is made of (footing, floor, base, wall, post, plate, gable, roof, ridge, window, chimney,
 *  light, and whatever a shape names); a blueprint says which block each one is at each tier. */
export type Part = string;

/** A building's design as data: its footprint, its rooms, the material of every part at every tier, its windows,
 *  doors and furniture. The shape (how the parts go together: a gabled cottage, market stalls, a tower...) is drawn
 *  by one function per shape below; everything that's a choice is here, to read and to tweak. */
export interface Blueprint {
  /** What it is, for the AIs and the site. */
  what: string;
  /** How the parts go together: a shape in SHAPES (cottage, church, tower, silo, pier, garden...). */
  shape: string;
  /** The kind (category) it is a design of; a blueprint registered under a kind's own name is that kind's first. */
  kind?: Kind;
  /** A cottage's roof: the ridge along the depth (v, the default), across the front (u), or a flat roof with a
   *  parapet; upper floors at these heights over the floor (a ladder up in the back corner). */
  ridge?: "u" | "v" | "flat";
  floors?: number[];
  /** The walls' footprint: [along the front, front to back]. */
  core: [number, number];
  /** The overhang round it for the eaves: the rectangle it takes is the core and this much all round. */
  eaves: number;
  /** How high the walls are (the room inside is that high, then open up into the roof). */
  walls: number;
  /** The rooms, in words. */
  rooms: string;
  /** How many courses at the foot of the walls are the `base` material (the rest are `wall`). */
  baseCourses?: number;
  parts: Partial<Record<Part, Mat>>;
  /** Windows in the walls: [u, dy, v]. */
  windows?: [Pos, number, Pos][];
  /** Posts in the walls besides the corners: [u, v]. */
  posts?: [Pos, Pos][];
  /** Doors in the front wall: u. */
  doors?: Pos[];
  furniture: Furniture[];
  /** A chimney up the back wall from this tier, at this u. */
  chimney?: { tier: number; u: Pos };
  /** A church's tower at the front (w along the front, d deep, walls h high): one in the middle with a pyramid cap and
   *  an open belfry, or (twin) one at each front corner with a lookout and battlements. */
  tower?: { w: number; d: number; h: number; twin?: boolean };
  /** A roof that rises this many steps and then runs flat (a big stone hall stays in reach of the scaffolding). */
  roofCap?: number;
  /** Buttresses down the long sides, every this many blocks. */
  buttress?: number;
  /** What each tier adds, in words (index 1 to 3). */
  tiers: string[];
  /** A shape's own settings (a yard's grid of saplings, its paths, a pond...). */
  opts?: Record<string, number>;
}

export const COB = B.COBBLESTONE;
export const SBR = B.STONE_BRICKS;
export const PL = B.OAK_PLANKS;
export const LOG = B.OAK_LOG;
export const FEN = B.OAK_FENCE;
export const PANE = B.GLASS_PANE;
export const CST = B.COBBLE_STAIRS;
export const OST = B.OAK_STAIRS;
export const SST = B.STONE_BRICK_STAIRS;
/** A table: an oak slab in the top half of its cell (a chair is a stair beside it, its back away from the table). */
export const TABLE = B.OAK_SLAB + 1;
/** A rug: white wool (the island's sheep are white) laid into the floor. */
export const RUG = B.WOOL_WHITE;
/** A row of the same furniture along v (a long table, benches). */
export const along = (u: Pos, dy: number, v0: number, v1: number, f: Omit<Furniture, "at">): Furniture[] => {
  const out: Furniture[] = [];
  for (let v = v0; v <= v1; v++) out.push({ ...f, at: [u, dy, v] });
  return out;
};
/** A row of the same furniture along u. */
export const across = (u0: number, u1: number, dy: number, v: Pos, f: Omit<Furniture, "at">): Furniture[] => {
  const out: Furniture[] = [];
  for (let u = u0; u <= u1; u++) out.push({ ...f, at: [u, dy, v] });
  return out;
};
/** A rug laid into the floor along v (a detail: only with wool to hand). */
export const rug = (u: Pos, v0: number, v1: number, tier: number): Furniture[] => along(u, -1, v0, v1, { block: RUG, tier, optional: true });
/** Lanterns on fence posts either side of the door (the finishing touch on a front). */
export const doorLamps = (tier: number): Furniture[] => [
  { block: FEN, at: ["mid-1", 0, "out"], tier },
  { block: B.LANTERN, at: ["mid-1", 1, "out"], tier },
  { block: FEN, at: ["mid+1", 0, "out"], tier },
  { block: B.LANTERN, at: ["mid+1", 1, "out"], tier },
];

export const BLUEPRINTS: Record<string, Blueprint> = {
  house: {
    what: "a cottage like the villages' houses: one room 5 by 6 and 3 high inside, open up to the roof, with a door, windows on every side, a plank floor, a kitchen along the back wall (a crafting table, a chest and a furnace); a bed, a table and chairs from tier 2",
    shape: "cottage", core: [7, 8], eaves: 1, walls: 3, baseCourses: 1,
    rooms: "one room, 5 by 6 inside, 3 high and open up to the roof: the kitchen along the back wall, the bed by the right wall, a table with two chairs by the left",
    parts: {
      // a cobblestone stair roof at tier 1, oak from tier 2: the 80 oak stairs of the roof were half the wood of a
      // cottage (about 30 of its 60 logs), and with the oak near the town cut down, season 10's second cottage took
      // the two of them over an hour; cobblestone comes out of every staircase they dig
      footing: all3(COB), floor: all3(PL), base: [COB, SBR, SBR], wall: all3(PL), post: all3(LOG), plate: all3(LOG),
      gable: all3(PL), roof: [CST, OST, OST], ridge: all3(PL), window: [FEN, PANE, PANE], chimney: all3(COB), light: all3(B.TORCH),
    },
    windows: [[1, 1, 0], [-2, 1, 0], [0, 1, 2], [0, 1, -3], [-1, 1, 2], [-1, 1, -3], ["mid", 1, -1], ["mid", 4, 0]],
    doors: ["mid"],
    chimney: { tier: 2, u: -2 },
    furniture: [
      { block: B.TORCH, at: [1, 0, 1], tier: 1 },
      { block: B.TORCH, at: [-2, 0, 1], tier: 1 },
      { block: B.CRAFTING_TABLE, at: [1, 0, -2], tier: 1 },
      { block: B.CHEST, at: [2, 0, -2], facing: "out", tier: 1 },
      { block: B.FURNACE, at: [-2, 0, -2], facing: "out", tier: 1 },
      { block: B.RED_BED, at: [-2, 0, 2], facing: "in", tier: 2 },
      { block: B.CHEST, at: [3, 0, -2], facing: "out", tier: 2 },
      { block: B.BARREL, at: [1, 0, -3], tier: 2 },
      { block: TABLE, at: [2, 0, 3], tier: 2 },
      { block: OST, at: [1, 0, 3], facing: "left", tier: 2 },
      { block: OST, at: [2, 0, 4], facing: "in", tier: 2 },
      { block: B.LANTERN + 1, at: ["mid", 0, 3], hang: true, tier: 3 },
      ...doorLamps(3),
      { block: B.BOOKSHELF, at: [-3, 0, -2], tier: 3, optional: true },
      { block: B.FLOWER_POT, at: [2, 1, 3], tier: 3, optional: true },
      ...rug("mid", 4, 5, 3),
    ],
    tiers: ["", "the cottage: fence bars in the windows, a kitchen of a crafting table, a chest and a furnace", "stone brick base course, an oak roof, glass windows, a chimney, a bed, a table with two chairs, a second chest and a barrel", "a lantern hanging from the roof, lanterns on posts by the door, a bookshelf and a rug when there's paper and wool"],
  },
  storehouse: {
    what: "a stone storehouse with double doors: one long room 6 by 7 inside with chests along the walls: the pack's shared supplies (deposit what the town needs, take what a build needs)",
    shape: "cottage", core: [8, 9], eaves: 1, walls: 3, baseCourses: 1,
    rooms: "one long room, 6 by 7 inside, 3 high, chests down both sides",
    parts: {
      footing: all3(COB), floor: all3(PL), base: [COB, SBR, SBR], wall: all3(COB), post: all3(LOG), plate: all3(LOG),
      gable: all3(PL), roof: all3(OST), ridge: all3(PL), window: [FEN, PANE, PANE], light: all3(B.TORCH),
    },
    windows: [[0, 1, 2], [0, 1, 4], [0, 1, -3], [-1, 1, 2], [-1, 1, 4], [-1, 1, -3]],
    doors: ["mid", "mid+1"],
    furniture: [
      { block: B.TORCH, at: [1, 0, 1], tier: 1 },
      { block: B.TORCH, at: [-2, 0, 1], tier: 1 },
      { block: B.CHEST, at: [1, 0, -2], facing: "right", tier: 1 },
      { block: B.CHEST, at: [-2, 0, -2], facing: "left", tier: 1 },
      { block: B.CHEST, at: [1, 0, -3], facing: "right", tier: 1 },
      { block: B.CHEST, at: [-2, 0, -3], facing: "left", tier: 1 },
      { block: B.CHEST, at: [1, 0, -4], facing: "right", tier: 2 },
      { block: B.CHEST, at: [-2, 0, -4], facing: "left", tier: 2 },
      { block: B.BARREL, at: [2, 0, -2], tier: 2 },
      { block: B.BARREL, at: [3, 0, -2], tier: 2 },
      { block: B.BARREL, at: [-4, 0, -2], tier: 2 },
      { block: B.BARREL, at: [-3, 0, -2], tier: 2 },
      { block: B.CRAFTING_TABLE, at: [1, 0, 2], tier: 2 },
      { block: B.LANTERN + 1, at: ["mid", 0, 2], hang: true, tier: 3 },
      { block: B.LANTERN + 1, at: ["mid", 0, -3], hang: true, tier: 3 },
      { block: B.BARREL, at: [2, 1, -2], tier: 3 },
      { block: B.BARREL, at: [-3, 1, -2], tier: 3 },
      { block: B.HAY_BALE, at: [-2, 0, 2], tier: 3, optional: true },
      { block: B.HAY_BALE, at: [-2, 1, 2], tier: 3, optional: true },
    ],
    tiers: ["", "cobblestone walls, a plank roof, four chests for the pack's supplies", "stone brick base course, glass windows, two more chests, barrels and a crafting table", "lanterns hanging from the roof, barrels stacked on barrels, hay"],
  },
  hall: {
    what: "the town hall: the biggest building, one open hall 7 by 9 and 4 high inside, a two-course stone base, log posts, tall windows, a high roof, the town's chest; a long council table with benches and a seat at its head from tier 2",
    shape: "cottage", core: [9, 11], eaves: 1, walls: 4, baseCourses: 2,
    rooms: "one open hall, 7 by 9 inside, 4 high and open up to the roof: the council table down the middle, the seat of the town at the back",
    parts: {
      footing: all3(COB), floor: all3(PL), base: [COB, SBR, SBR], wall: all3(PL), post: all3(LOG), plate: all3(LOG),
      gable: all3(PL), roof: all3(OST), ridge: all3(PL), window: [FEN, PANE, PANE], light: all3(B.TORCH),
    },
    posts: [[0, "mid"], [-1, "mid"]],
    windows: [
      [0, 1, 2], [0, 2, 2], [0, 1, 3], [0, 2, 3], [0, 1, -4], [0, 2, -4], [0, 1, -3], [0, 2, -3],
      [-1, 1, 2], [-1, 2, 2], [-1, 1, 3], [-1, 2, 3], [-1, 1, -4], [-1, 2, -4], [-1, 1, -3], [-1, 2, -3],
      [2, 1, 0], [2, 2, 0], [-3, 1, 0], [-3, 2, 0], [2, 1, -1], [2, 2, -1], [-3, 1, -1], [-3, 2, -1], ["mid", 1, -1], ["mid", 2, -1], ["mid", 5, 0],
    ],
    doors: ["mid"],
    furniture: [
      { block: B.TORCH, at: [1, 0, 1], tier: 1 },
      { block: B.TORCH, at: [-2, 0, 1], tier: 1 },
      { block: B.TORCH, at: [1, 0, -2], tier: 1 },
      { block: B.TORCH, at: [-2, 0, -2], tier: 1 },
      { block: B.CHEST, at: [2, 0, -2], facing: "out", tier: 1 },
      { block: B.CRAFTING_TABLE, at: [-3, 0, -2], tier: 1 },
      ...along("mid", 0, 3, 7, { block: TABLE, tier: 2 }),
      ...along("mid-1", 0, 3, 7, { block: OST, facing: "left", tier: 2 }),
      ...along("mid+1", 0, 3, 7, { block: OST, facing: "right", tier: 2 }),
      { block: SST, at: ["mid", 0, -2], facing: "in", tier: 2 },
      { block: B.LANTERN + 1, at: ["mid", 0, 3], hang: true, tier: 3 },
      { block: B.LANTERN + 1, at: ["mid", 0, -4], hang: true, tier: 3 },
      ...doorLamps(3),
      { block: B.LANTERN, at: ["mid", 1, 3], tier: 3, optional: true },
      { block: B.LANTERN, at: ["mid", 1, 7], tier: 3, optional: true },
      { block: B.BOOKSHELF, at: [1, 0, -3], tier: 3, optional: true },
      { block: B.BOOKSHELF, at: [-2, 0, -3], tier: 3, optional: true },
      ...rug("mid", 1, 2, 3),
    ],
    tiers: ["", "the hall (fence bars in the tall windows), the town's chest and crafting table", "stone brick base, glass windows, a long council table with benches, a stone seat at its head", "lanterns hanging from the roof, on the table and by the door, bookshelves, a rug"],
  },
  market: {
    what: "a market: two stalls under one gable roof, oak counters at the front, room behind them for the traders' chests",
    shape: "stalls", core: [9, 5], eaves: 1, walls: 3,
    rooms: "two stalls, 3 by 3 behind their counters",
    parts: {
      floor: [COB, COB, COB], border: [COB, SBR, SBR], post: all3(LOG), plate: all3(LOG), counter: all3(TABLE), board: all3(PL),
      divider: all3(FEN), roof: all3(OST), ridge: all3(PL), gable: all3(PL), light: all3(B.TORCH),
    },
    furniture: [
      { block: B.CHEST, at: [1, 0, -2], facing: "out", tier: 2 },
      { block: B.BARREL, at: [2, 0, -2], tier: 2 },
      { block: B.CHEST, at: [5, 0, -2], facing: "out", tier: 2 },
      { block: B.BARREL, at: [6, 0, -2], tier: 2 },
      { block: B.LANTERN + 1, at: [2, 0, "mid"], hang: true, tier: 3 },
      { block: B.LANTERN + 1, at: [6, 0, "mid"], hang: true, tier: 3 },
      { block: B.HAY_BALE, at: [3, 0, -2], tier: 3, optional: true },
      { block: B.CRAFTING_TABLE, at: [7, 0, -2], tier: 3 },
      { block: B.FLOWER_POT, at: [2, 1, 0], tier: 3, optional: true },
      { block: B.FLOWER_POT, at: [6, 1, 0], tier: 3, optional: true },
    ],
    tiers: ["", "the stalls, counters and roof on a cobblestone floor", "a stone brick border, chests and barrels behind the counters", "lanterns hanging over the stalls, a crafting table, hay"],
  },
  well: {
    what: "a stone well: a cobblestone rim and parapet, fence posts and a little gable roof, the middle of the town",
    shape: "well", core: [5, 5], eaves: 0, walls: 3,
    rooms: "a basin 3 by 3, one deep",
    parts: { rim: [COB, SBR, SBR], parapet: [B.COBBLE_WALL, B.STONE_BRICK_WALL, B.STONE_BRICK_WALL], post: all3(FEN), roof: all3(OST), ridge: all3(PL), gable: all3(PL), basin: all3(COB) },
    furniture: [
      { block: B.WATER, at: ["mid", -1, "mid"], tier: 2 },
      { block: B.LANTERN + 1, at: ["mid", 0, "mid"], hang: true, tier: 3 },
    ],
    tiers: ["", "the well, its basin dug but dry", "stone brick rim and parapet, water in the basin (a water_bucket)", "a lantern hanging under the roof"],
  },
  lamp: {
    what: "a lamp post (monsters don't spawn in the light)",
    shape: "lamp", core: [1, 1], eaves: 0, walls: 3,
    rooms: "",
    parts: { footing: [COB, SBR, SBR], post: [LOG, FEN, FEN], light: [B.TORCH, B.LANTERN, B.LANTERN] },
    furniture: [],
    tiers: ["", "a log post with a torch on top", "a village lamp: stone brick foot, fence post and a lantern"],
  },
  tower: {
    what: "a stone watchtower: a door, a ladder up inside, a lookout floor with battlements and torches, seen from far away",
    shape: "tower", core: [5, 5], eaves: 0, walls: 7, doors: ["mid"],
    rooms: "a stair well 3 by 3 with a ladder, a lookout on top",
    parts: { footing: all3(COB), wall: all3(COB), corner: [COB, SBR, SBR], floor: all3(COB), battlement: [COB, SBR, SBR], window: [0, PANE, PANE], light: [B.TORCH, B.TORCH, B.LANTERN] },
    furniture: [
      { block: B.TORCH, at: [1, 0, 1], tier: 1 },
      { block: B.CHEST, at: [-2, 0, 1], facing: "left", tier: 2 },
      { block: B.BARREL, at: [1, 0, -2], tier: 3 },
    ],
    tiers: ["", "the tower", "stone brick corners and battlements, glass in the slits, a chest for the watch", "lanterns on the battlements, a barrel of supplies"],
  },
  keep: {
    what: "the keep: a stone castle tower, walls six high round a hall 7 by 7, a ladder to a roof with battlements and corner turrets; a barracks inside from tier 2",
    shape: "keep", core: [9, 9], eaves: 0, walls: 6, baseCourses: 2,
    rooms: "one hall, 7 by 7 inside, 6 high, a ladder to the roof: two bunks, a table, the armoury chest",
    parts: { footing: all3(COB), floor: [COB, PL, PL], base: [COB, SBR, SBR], wall: all3(COB), corner: [COB, SBR, SBR], roof: all3(COB), battlement: [COB, SBR, SBR], window: [0, PANE, PANE], light: [B.TORCH, B.TORCH, B.LANTERN] },
    windows: [[2, 2, 0], [2, 3, 0], [-3, 2, 0], [-3, 3, 0], [0, 2, 2], [0, 3, 2], [0, 2, -3], [0, 3, -3], [-1, 2, 2], [-1, 3, 2], [-1, 2, -3], [-1, 3, -3], [2, 2, -1], [2, 3, -1], [-3, 2, -1], [-3, 3, -1]],
    doors: ["mid"],
    furniture: [
      { block: B.TORCH, at: [1, 0, 1], tier: 1 },
      { block: B.TORCH, at: [-2, 0, 1], tier: 1 },
      { block: B.TORCH, at: [1, 0, -2], tier: 1 },
      { block: B.TORCH, at: [-2, 0, -2], tier: 1 },
      { block: B.CHEST, at: [2, 0, -2], facing: "out", tier: 2 },
      { block: B.CRAFTING_TABLE, at: [-3, 0, -2], tier: 2 },
      { block: B.RED_BED, at: [1, 0, 3], facing: "in", tier: 2 },
      { block: B.RED_BED, at: [-2, 0, 3], facing: "in", tier: 2 },
      { block: TABLE, at: ["mid", 0, "mid"], tier: 2 },
      { block: OST, at: ["mid-1", 0, "mid"], facing: "left", tier: 2 },
      { block: OST, at: ["mid+1", 0, "mid"], facing: "right", tier: 2 },
      { block: B.LANTERN + 1, at: ["mid", 0, 2], hang: true, tier: 3 },
      { block: B.BARREL, at: [1, 0, -3], tier: 3 },
      { block: B.BARREL, at: [-2, 0, -3], tier: 3 },
      { block: B.LANTERN, at: ["mid", 1, "mid"], tier: 3, optional: true },
    ],
    tiers: ["", "the keep in cobblestone", "stone brick base course and corners, glass in the slits, a plank floor, a barracks: two bunks, a table and benches, the armoury chest and a crafting table", "lanterns on the turrets and hanging inside, barrels of supplies"],
  },
  plaza: {
    what: "the town plaza: a paved square with lamp posts at its corners, where the town meets and the main streets start",
    shape: "plaza", core: [9, 9], eaves: 0, walls: 0,
    rooms: "an open square 9 by 9",
    parts: { paving: all3(COB), border: [COB, SBR, SBR], footing: [LOG, SBR, SBR], post: [LOG, FEN, FEN], light: [B.TORCH, B.LANTERN, B.LANTERN] },
    furniture: [
      ...[-1, 0, 1].flatMap((k): Furniture[] => [
        { block: OST, at: [`mid${k ? (k > 0 ? "+1" : "-1") : ""}`, 0, 0], facing: "out", tier: 2 },
        { block: OST, at: [`mid${k ? (k > 0 ? "+1" : "-1") : ""}`, 0, -1], facing: "in", tier: 2 },
        { block: OST, at: [0, 0, `mid${k ? (k > 0 ? "+1" : "-1") : ""}`], facing: "left", tier: 2 },
        { block: OST, at: [-1, 0, `mid${k ? (k > 0 ? "+1" : "-1") : ""}`], facing: "right", tier: 2 },
      ]),
      ...[[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]].map(([du, dv]): Furniture => ({ block: B.STONE_BRICK_SLAB, at: [`mid${du ? (du > 0 ? "+1" : "-1") : ""}`, 0, `mid${dv ? (dv > 0 ? "+1" : "-1") : ""}`], tier: 3 })),
      { block: SBR, at: ["mid", 0, "mid"], tier: 3 },
      { block: B.STONE_BRICK_WALL, at: ["mid", 1, "mid"], tier: 3 },
      { block: B.STONE_BRICK_WALL, at: ["mid", 2, "mid"], tier: 3 },
      { block: B.LANTERN, at: ["mid", 3, "mid"], tier: 3 },
    ],
    tiers: ["", "cobblestone paving and corner torch posts", "a stone brick border, benches facing the middle, lantern posts", "a stone brick monument with a lantern in the middle"],
  },
  smithy: {
    what: "a stone smithy: the forge (furnaces under a chimney) at the back, a crafting table and the tool chest, a work bench; where the town's iron and tools are made",
    shape: "cottage", core: [9, 7], eaves: 1, walls: 3, baseCourses: 1,
    rooms: "one workshop, 7 by 5 inside, 3 high: the forge along the back wall, a work bench by the right wall",
    parts: {
      footing: all3(COB), floor: [COB, SBR, SBR], base: [COB, SBR, SBR], wall: [COB, COB, SBR], post: all3(LOG), plate: all3(LOG),
      gable: [COB, COB, SBR], roof: [CST, CST, SST], ridge: [COB, COB, SBR], window: [FEN, PANE, PANE], chimney: [COB, SBR, SBR], light: all3(B.TORCH),
    },
    windows: [[2, 1, 0], [-3, 1, 0], [0, 1, 2], [-1, 1, 2], [-4, 1, -1]],
    doors: ["mid"],
    chimney: { tier: 1, u: 1 },
    furniture: [
      { block: B.TORCH, at: [1, 0, 1], tier: 1 },
      { block: B.TORCH, at: [-2, 0, 1], tier: 1 },
      { block: B.FURNACE, at: [1, 0, -2], facing: "out", tier: 1 },
      { block: B.FURNACE, at: [2, 0, -2], facing: "out", tier: 1 },
      { block: B.CHEST, at: [-3, 0, -2], facing: "out", tier: 1 },
      { block: B.CRAFTING_TABLE, at: [-2, 0, -2], tier: 1 },
      { block: B.FURNACE, at: [3, 0, -2], facing: "out", tier: 2 },
      { block: B.CHEST, at: [-4, 0, -2], facing: "out", tier: 2 },
      { block: TABLE, at: [-2, 0, 2], tier: 2 },
      { block: TABLE, at: [-2, 0, 3], tier: 2 },
      { block: B.BARREL, at: [1, 0, 2], tier: 2 },
      { block: B.LANTERN + 1, at: [2, 0, 2], hang: true, tier: 3 },
      { block: B.LANTERN + 1, at: [-3, 0, 2], hang: true, tier: 3 },
      { block: B.LANTERN, at: [-2, 1, 3], tier: 3, optional: true },
      ...doorLamps(3),
    ],
    tiers: ["", "the smithy in cobblestone: a forge of two furnaces under its chimney, the tool chest and a crafting table", "a stone brick floor and base, glass windows, a third furnace, a work bench, a second chest and a barrel", "stone brick walls and a stone brick roof, lanterns hanging over the forge and by the door"],
  },
  bakery: {
    what: "a bakery: ovens (furnaces) under a chimney at the back, a counter across the shop, barrels and sacks of flour: bread for the town",
    shape: "cottage", core: [7, 9], eaves: 1, walls: 3, baseCourses: 1,
    rooms: "a shop at the front and the bakehouse behind the counter, 5 by 7 inside",
    parts: {
      footing: all3(COB), floor: all3(PL), base: [COB, SBR, SBR], wall: all3(PL), post: all3(LOG), plate: all3(LOG),
      gable: all3(PL), roof: [CST, OST, OST], ridge: all3(PL), window: [FEN, PANE, PANE], chimney: all3(COB), light: all3(B.TORCH),
    },
    windows: [[1, 1, 0], [-2, 1, 0], [0, 1, 2], [-1, 1, 2], [0, 1, -3], [-1, 1, -3], ["mid", 4, 0]],
    doors: ["mid"],
    chimney: { tier: 1, u: -2 },
    furniture: [
      { block: B.TORCH, at: [1, 0, 1], tier: 1 },
      { block: B.TORCH, at: [-2, 0, 1], tier: 1 },
      ...across(1, 2, 0, 3, { block: TABLE, tier: 1 }),
      { block: TABLE, at: [-3, 0, 3], tier: 1 },
      { block: TABLE, at: [-2, 0, 3], tier: 1 },
      { block: B.FURNACE, at: [-2, 0, -2], facing: "out", tier: 1 },
      { block: B.FURNACE, at: [-3, 0, -2], facing: "out", tier: 1 },
      { block: B.CRAFTING_TABLE, at: [1, 0, -2], tier: 1 },
      { block: B.CHEST, at: [2, 0, -2], facing: "out", tier: 1 },
      { block: B.BARREL, at: [1, 0, -3], tier: 2 },
      { block: B.BARREL, at: [1, 0, -4], tier: 2 },
      { block: B.FURNACE, at: ["mid", 0, -2], facing: "out", tier: 2 },
      { block: OST, at: [2, 0, 1], facing: "out", tier: 2 },
      { block: B.HAY_BALE, at: [-2, 0, -4], tier: 2, optional: true },
      { block: B.HAY_BALE, at: [-2, 1, -4], tier: 2, optional: true },
      { block: B.LANTERN + 1, at: ["mid", 0, 2], hang: true, tier: 3 },
      { block: B.LANTERN + 1, at: ["mid", 0, -3], hang: true, tier: 3 },
      { block: B.FLOWER_POT, at: [1, 1, 3], tier: 3, optional: true },
      { block: B.FLOWER_POT, at: [-2, 1, 3], tier: 3, optional: true },
      ...doorLamps(3),
    ],
    tiers: ["", "the bakery: two ovens under the chimney, a counter, a crafting table and the flour chest", "stone brick base course, an oak roof, glass windows, a third oven, barrels and sacks, a bench for customers", "lanterns hanging over the counter and the ovens, and by the door"],
  },
  tavern: {
    what: "a tavern: a big timber-framed hall with the bar at the back (barrels behind it, a kitchen hearth under the chimney), tables and chairs in front, lanterns: where the town eats and drinks",
    shape: "cottage", core: [9, 11], eaves: 1, walls: 4, baseCourses: 1,
    rooms: "one big room, 7 by 9 inside, 4 high: tables in front, the bar at the back, the kitchen behind it",
    parts: {
      footing: all3(COB), floor: all3(PL), base: [COB, SBR, SBR], wall: all3(PL), post: all3(LOG), plate: all3(LOG),
      gable: all3(PL), roof: [CST, OST, OST], ridge: all3(PL), window: [FEN, PANE, PANE], chimney: all3(COB), light: all3(B.TORCH),
    },
    // the timber frame: log posts in the side walls and either side of the front and the back
    posts: [[0, 3], [0, 7], [-1, 3], [-1, 7], [2, 0], [-3, 0], [2, -1], [-3, -1]],
    windows: [[1, 1, 0], [-2, 1, 0], [3, 1, 0], [3, 2, 0], [-4, 1, 0], [-4, 2, 0], [0, 1, 5], [0, 2, 5], [-1, 1, 5], [-1, 2, 5], [0, 1, 1], [-1, 1, 1], [0, 1, -2], [-1, 1, -2], ["mid", 1, -1], ["mid", 5, 0], ["mid", 6, 0]],
    doors: ["mid"],
    chimney: { tier: 1, u: 1 },
    furniture: [
      { block: B.TORCH, at: [1, 0, 1], tier: 1 },
      { block: B.TORCH, at: [-2, 0, 1], tier: 1 },
      { block: B.TORCH, at: [-2, 0, -2], tier: 1 },
      // the bar across the back, a gap at the right end to get behind it
      ...across(1, 5, 0, -4, { block: TABLE, tier: 1 }),
      { block: TABLE, at: [-2, 0, -4], tier: 1 },
      { block: B.FURNACE, at: [1, 0, -2], facing: "out", tier: 1 },
      { block: B.BARREL, at: [2, 0, -2], tier: 1 },
      { block: B.BARREL, at: [3, 0, -2], tier: 1 },
      { block: B.CHEST, at: [4, 0, -2], facing: "out", tier: 1 },
      { block: B.CRAFTING_TABLE, at: [5, 0, -2], tier: 1 },
      // tables and chairs in front, the way to the bar kept clear up the middle
      { block: TABLE, at: [2, 0, 3], tier: 1 },
      { block: OST, at: [1, 0, 3], facing: "left", tier: 1 },
      { block: OST, at: [3, 0, 3], facing: "right", tier: 1 },
      { block: TABLE, at: [-3, 0, 3], tier: 1 },
      { block: OST, at: [-4, 0, 3], facing: "left", tier: 1 },
      { block: OST, at: [-2, 0, 3], facing: "right", tier: 1 },
      { block: TABLE, at: [2, 0, 5], tier: 2 },
      { block: OST, at: [1, 0, 5], facing: "left", tier: 2 },
      { block: OST, at: [3, 0, 5], facing: "right", tier: 2 },
      { block: TABLE, at: [-3, 0, 5], tier: 2 },
      { block: OST, at: [-4, 0, 5], facing: "left", tier: 2 },
      { block: OST, at: [-2, 0, 5], facing: "right", tier: 2 },
      // stools at the bar
      ...across(1, 3, 0, -5, { block: OST, facing: "out", tier: 2 }),
      { block: B.BARREL, at: [2, 1, -2], tier: 2 },
      { block: B.BARREL, at: [3, 1, -2], tier: 2 },
      { block: B.LANTERN + 1, at: [2, 0, 4], hang: true, tier: 3 },
      { block: B.LANTERN + 1, at: [-3, 0, 4], hang: true, tier: 3 },
      { block: B.LANTERN + 1, at: ["mid", 0, -4], hang: true, tier: 3 },
      { block: B.LANTERN, at: [2, 1, 3], tier: 3, optional: true },
      { block: B.LANTERN, at: [-3, 1, 3], tier: 3, optional: true },
      ...doorLamps(3),
      ...rug("mid", 1, 5, 3),
    ],
    tiers: ["", "the tavern: a timber frame round plank walls, the bar with a kitchen hearth and barrels behind it, two tables with chairs", "stone brick base course, an oak roof, glass windows, two more tables, stools at the bar, barrels stacked", "lanterns hanging over the tables and the bar, on the tables and by the door, a rug to the bar"],
  },
  library: {
    what: "a library: a reading room on a two-course stone base, lined with bookshelves (paper from sugar cane), reading tables with chairs, the archive chest, tall windows above the shelves",
    shape: "cottage", core: [9, 9], eaves: 1, walls: 4, baseCourses: 2,
    rooms: "one reading room, 7 by 7 inside, 4 high: shelves round the walls, two reading tables either side of the aisle",
    parts: {
      footing: all3(COB), floor: all3(PL), base: [COB, SBR, SBR], wall: all3(PL), post: all3(LOG), plate: all3(LOG),
      gable: all3(PL), roof: [CST, OST, OST], ridge: all3(PL), window: [FEN, PANE, PANE], light: all3(B.TORCH),
    },
    windows: [[2, 1, 0], [2, 2, 0], [-3, 1, 0], [-3, 2, 0], [0, 2, 2], [0, 3, 2], [0, 2, -3], [0, 3, -3], [-1, 2, 2], [-1, 3, 2], [-1, 2, -3], [-1, 3, -3], ["mid", 2, -1], ["mid", 3, -1], ["mid", 5, 0]],
    doors: ["mid"],
    furniture: [
      { block: B.TORCH, at: [1, 0, 1], tier: 1 },
      { block: B.TORCH, at: [-2, 0, 1], tier: 1 },
      ...along("mid-1", 0, 3, 5, { block: TABLE, tier: 1 }),
      ...along("mid+1", 0, 3, 5, { block: TABLE, tier: 1 }),
      { block: OST, at: ["mid-2", 0, 4], facing: "left", tier: 1 },
      { block: OST, at: ["mid+2", 0, 4], facing: "right", tier: 1 },
      { block: B.CHEST, at: ["mid", 0, -2], facing: "out", tier: 1 },
      ...along(1, 0, 2, 6, { block: B.BOOKSHELF, tier: 1, optional: true }),
      ...along(-2, 0, 2, 6, { block: B.BOOKSHELF, tier: 1, optional: true }),
      ...along(1, 1, 2, 6, { block: B.BOOKSHELF, tier: 2, optional: true }),
      ...along(-2, 1, 2, 6, { block: B.BOOKSHELF, tier: 2, optional: true }),
      { block: OST, at: ["mid-2", 0, 2], facing: "left", tier: 2 },
      { block: OST, at: ["mid+2", 0, 2], facing: "right", tier: 2 },
      { block: B.CRAFTING_TABLE, at: ["mid-1", 0, -2], tier: 2 },
      { block: B.BARREL, at: ["mid+1", 0, -2], tier: 2 },
      ...[1, 2, -3, -2].flatMap((u): Furniture[] => [{ block: B.BOOKSHELF, at: [u, 0, -2], tier: 3, optional: true }, { block: B.BOOKSHELF, at: [u, 1, -2], tier: 3, optional: true }]),
      { block: B.LANTERN, at: ["mid-1", 1, 4], tier: 3 },
      { block: B.LANTERN, at: ["mid+1", 1, 4], tier: 3 },
      { block: B.LANTERN + 1, at: ["mid", 0, 3], hang: true, tier: 3 },
      ...doorLamps(3),
      ...rug("mid", 1, 6, 3),
    ],
    tiers: ["", "the reading room: two reading tables with chairs, the archive chest, bookshelves along the walls when there's paper", "stone brick base, an oak roof, glass windows, the shelves two high, more chairs, a crafting table and a barrel", "lanterns on the reading tables and hanging, shelves along the back wall, lanterns by the door, a rug down the aisle"],
  },
  chapel: {
    what: "a chapel: a nave with tall windows, pews either side of the aisle and an altar at the far end, a stone bell tower over the door with an open belfry and a pointed cap",
    shape: "church", core: [7, 15], eaves: 1, walls: 4, baseCourses: 1,
    tower: { w: 5, d: 5, h: 9 },
    rooms: "the nave, 5 by 10 inside, 4 high and open up to the roof: pews either side of the aisle, the altar at the end; the bell tower, 3 by 3, over the door",
    parts: {
      footing: all3(COB), floor: all3(PL), base: [COB, SBR, SBR], wall: [COB, COB, SBR], post: [LOG, SBR, SBR], plate: all3(LOG),
      gable: [COB, COB, SBR], roof: [CST, OST, OST], ridge: all3(PL), window: [FEN, PANE, PANE], corner: [COB, SBR, SBR],
      cap: [CST, SST, SST], column: [COB, SBR, SBR], light: [B.TORCH, B.TORCH, B.LANTERN],
    },
    windows: [[0, 1, 6], [0, 2, 6], [0, 1, 9], [0, 2, 9], [0, 1, 12], [0, 2, 12], [-1, 1, 6], [-1, 2, 6], [-1, 1, 9], [-1, 2, 9], [-1, 1, 12], [-1, 2, 12], ["mid", 5, -1], ["mid", 6, -1]],
    doors: ["mid"],
    furniture: [
      { block: B.TORCH, at: [1, 0, 5], tier: 1 },
      { block: B.TORCH, at: [-2, 0, 5], tier: 1 },
      // the altar at the end of the nave, and the pews facing it
      ...across(2, 4, 0, -3, { block: SBR, tier: 1 }),
      ...[6, 8, 10].flatMap((v): Furniture[] => [{ block: OST, at: [1, 0, v], facing: "out", tier: 1 }, { block: OST, at: [2, 0, v], facing: "out", tier: 1 }, { block: OST, at: [-3, 0, v], facing: "out", tier: 1 }, { block: OST, at: [-2, 0, v], facing: "out", tier: 1 }]),
      ...[7, 9, 11].flatMap((v): Furniture[] => [{ block: OST, at: [1, 0, v], facing: "out", tier: 2 }, { block: OST, at: [2, 0, v], facing: "out", tier: 2 }, { block: OST, at: [-3, 0, v], facing: "out", tier: 2 }, { block: OST, at: [-2, 0, v], facing: "out", tier: 2 }]),
      { block: B.CHEST, at: [1, 0, -2], facing: "right", tier: 2 },
      { block: B.LANTERN, at: [2, 1, -3], tier: 3 },
      { block: B.LANTERN, at: [4, 1, -3], tier: 3 },
      { block: B.LANTERN + 1, at: ["mid", 0, 7], hang: true, tier: 3 },
      { block: B.LANTERN + 1, at: ["mid", 0, 11], hang: true, tier: 3 },
      { block: B.FLOWER_POT, at: [3, 1, -3], tier: 3, optional: true },
      ...rug("mid", 5, 11, 3),
    ],
    tiers: ["", "the chapel in cobblestone: the nave with its pews and a stone altar, the bell tower with a cobblestone cap", "a stone brick base and corners, an oak roof, glass windows, a stone brick cap on the tower, more pews, the chapel chest", "stone brick walls, lanterns on the altar, hanging over the aisle and on the tower, a rug down the aisle"],
  },
  barn: {
    what: "a barn by the fields: a big timber-framed shed with wide double doors, stalls down both sides, feed and the seed chest, hay",
    shape: "cottage", core: [10, 11], eaves: 1, walls: 4, baseCourses: 1,
    rooms: "one big shed, 8 by 9 inside, 4 high: fenced stalls down both sides, the way through the middle",
    parts: {
      footing: all3(COB), floor: all3(COB), base: [COB, SBR, SBR], wall: all3(PL), post: all3(LOG), plate: all3(LOG),
      gable: all3(PL), roof: [CST, OST, OST], ridge: all3(PL), window: [FEN, FEN, PANE], light: all3(B.TORCH),
    },
    posts: [[0, "mid"], [-1, "mid"]],
    windows: [[0, 2, 2], [0, 2, -3], [-1, 2, 2], [-1, 2, -3], ["mid", 6, 0], ["mid+1", 6, 0]],
    doors: ["mid", "mid+1"],
    furniture: [
      { block: B.TORCH, at: [1, 0, 1], tier: 1 },
      { block: B.TORCH, at: [-2, 0, 1], tier: 1 },
      ...across(1, 2, 0, 4, { block: FEN, tier: 1 }),
      ...across(1, 2, 0, 7, { block: FEN, tier: 1 }),
      ...across(-3, -2, 0, 4, { block: FEN, tier: 1 }),
      ...across(-3, -2, 0, 7, { block: FEN, tier: 1 }),
      { block: B.CHEST, at: ["mid", 0, -2], facing: "out", tier: 1 },
      { block: B.CRAFTING_TABLE, at: ["mid+1", 0, -2], tier: 1 },
      { block: B.BARREL, at: [1, 0, -2], tier: 2 },
      { block: B.BARREL, at: [-2, 0, -2], tier: 2 },
      { block: B.BARREL, at: [1, 1, -2], tier: 2 },
      ...[2, 5, 8].flatMap((v): Furniture[] => [{ block: B.HAY_BALE, at: [1, 0, v], tier: 2, optional: true }, { block: B.HAY_BALE, at: [-2, 0, v], tier: 2, optional: true }]),
      { block: B.LANTERN + 1, at: [2, 0, "mid"], hang: true, tier: 3 },
      { block: B.LANTERN + 1, at: [-3, 0, "mid"], hang: true, tier: 3 },
      { block: FEN, at: ["mid-1", 0, "out"], tier: 3 },
      { block: B.LANTERN, at: ["mid-1", 1, "out"], tier: 3 },
      { block: FEN, at: ["mid+2", 0, "out"], tier: 3 },
      { block: B.LANTERN, at: ["mid+2", 1, "out"], tier: 3 },
    ],
    tiers: ["", "the barn: a timber frame, wide double doors, fenced stalls, the seed chest", "stone brick base course, an oak roof, barrels of feed, hay in the stalls", "glass in the windows, lanterns inside and by the doors"],
  },
  fountain: {
    what: "a fountain: a stone basin with a column in the middle and water falling from its top (a water_bucket), torches then lanterns on the rim",
    shape: "fountain", core: [7, 7], eaves: 0, walls: 3,
    rooms: "a basin 5 by 5",
    parts: { rim: [COB, SBR, SBR], parapet: [B.COBBLE_WALL, B.STONE_BRICK_WALL, B.STONE_BRICK_WALL], basin: [COB, SBR, SBR], column: [COB, SBR, SBR], light: [B.TORCH, B.TORCH, B.LANTERN] },
    furniture: [{ block: B.WATER, at: ["mid", 3, "mid"], tier: 2 }],
    tiers: ["", "the basin and its column, dry, torches on the rim", "stone bricks, water falling from the column (a water_bucket)", "lanterns on the corners of the rim"],
  },
  monument: {
    what: "a monument: a stone obelisk on a stepped plinth with a light at its tip, seen from across the town",
    shape: "monument", core: [5, 5], eaves: 0, walls: 7,
    rooms: "",
    parts: { footing: [COB, SBR, SBR], base: [COB, SBR, SBR], column: [COB, SBR, SBR], step: [0, SST, SST], light: [B.TORCH, B.LANTERN, B.LANTERN] },
    furniture: [
      { block: B.LANTERN, at: [0, 0, 0], tier: 3 },
      { block: B.LANTERN, at: [-1, 0, 0], tier: 3 },
      { block: B.LANTERN, at: [0, 0, -1], tier: 3 },
      { block: B.LANTERN, at: [-1, 0, -1], tier: 3 },
    ],
    tiers: ["", "a cobblestone obelisk on its plinth, a torch at the tip", "stone bricks, steps round the plinth, a lantern at the tip", "lanterns on the corners of the plinth"],
  },
  cathedral: {
    what: "the cathedral: a great stone church, twin towers either side of the door with a lookout and battlements, a long nave with tall windows and buttresses, pews either side of the aisle, the altar at the far end",
    shape: "church", core: [13, 21], eaves: 1, walls: 6, baseCourses: 2,
    tower: { w: 5, d: 5, h: 11, twin: true },
    roofCap: 3,
    buttress: 4,
    rooms: "the nave, 11 by 15 inside, 6 high under the roof: rows of pews, a wide aisle, the altar and its lanterns; two towers by the door, a hall between them",
    parts: {
      footing: all3(COB), floor: [COB, SBR, SBR], base: [COB, SBR, SBR], wall: [COB, COB, SBR], post: [COB, SBR, SBR], plate: [COB, SBR, SBR],
      gable: [COB, COB, SBR], roof: [CST, SST, SST], ridge: [COB, SBR, SBR], window: [FEN, PANE, PANE], corner: [COB, SBR, SBR],
      battlement: [COB, SBR, SBR], buttress: [COB, SBR, SBR], column: [COB, SBR, SBR], light: [B.TORCH, B.TORCH, B.LANTERN],
    },
    windows: [
      ...[6, 10, 14, 18].flatMap((v): [Pos, number, Pos][] => [[0, 1, v], [0, 2, v], [0, 3, v], [-1, 1, v], [-1, 2, v], [-1, 3, v]]),
      ["mid", 2, -1], ["mid", 3, -1], ["mid", 4, -1], ["mid-1", 3, -1], ["mid+1", 3, -1],
      ["mid", 7, 0], ["mid", 8, 0], ["mid-1", 7, 0], ["mid+1", 7, 0],
    ],
    doors: ["mid"],
    furniture: [
      { block: B.TORCH, at: [1, 0, 5], tier: 1 },
      { block: B.TORCH, at: [-2, 0, 5], tier: 1 },
      { block: B.TORCH, at: [1, 0, -2], tier: 1 },
      { block: B.TORCH, at: [-2, 0, -2], tier: 1 },
      ...across(4, 8, 0, -3, { block: SBR, tier: 1 }),
      ...[7, 9, 11, 13, 15].flatMap((v): Furniture[] => [1, 2, 3, 4, -5, -4, -3, -2].map((u): Furniture => ({ block: OST, at: [u, 0, v], facing: "out", tier: 1 }))),
      ...[8, 10, 12, 14, 16].flatMap((v): Furniture[] => [1, 2, 3, 4, -5, -4, -3, -2].map((u): Furniture => ({ block: OST, at: [u, 0, v], facing: "out", tier: 2 }))),
      { block: B.CHEST, at: [1, 0, -3], facing: "right", tier: 2 },
      { block: B.LANTERN, at: [4, 1, -3], tier: 3 },
      { block: B.LANTERN, at: [-5, 1, -3], tier: 3 },
      { block: B.LANTERN + 1, at: ["mid", 0, 8], hang: true, tier: 3 },
      { block: B.LANTERN + 1, at: ["mid", 0, 12], hang: true, tier: 3 },
      { block: B.LANTERN + 1, at: ["mid", 0, 16], hang: true, tier: 3 },
      { block: B.FLOWER_POT, at: ["mid", 1, -3], tier: 3, optional: true },
      ...rug("mid", 1, 17, 3),
    ],
    tiers: ["", "the cathedral in cobblestone: the nave with its pews and a stone altar, the twin towers with battlements", "stone brick floor, base and buttresses, a stone brick roof, glass in every window, more pews, the cathedral chest", "stone brick walls, lanterns on the altar, down the nave and on the towers, a rug down the aisle"],
  },
};

/** What a design is, for the AIs, the board and the site: its kind, its name, the rectangle it takes (its front along
 *  the first number), how many tiers, what each tier adds, how many blocks each tier takes, and how big a job it is. */
export interface DesignInfo {
  id: string;
  kind: Kind;
  name: string;
  size: [number, number];
  tiers: number;
  what: string;
  up: string[];
  blocks: number[];
  /** small: a quick win (under ~150 blocks); medium; large; huge: a long project (over ~900). */
  scale: "small" | "medium" | "large" | "huge";
  /** The district style it belongs to, if it has one (oak, birch, stone, timber). */
  style?: string;
}
/** Every design in the catalog, by id. */
export const DESIGNS: Record<string, DesignInfo> = {};
/** What each kind is: its first design (the one a kind's own name means) and every design of it. size: the rectangle
 *  its first design takes; blocks: how many each tier of that one takes. */
export const KINDS: Record<string, { size: [number, number]; tiers: number; what: string; up: string[]; blocks: number[]; designs: string[] }> = {
  wall: {
    size: [27, 27], tiers: 3, blocks: [], designs: [],
    what: "a wall all the way round the base with four gates (built a stretch at a time)",
    up: ["", "a cobblestone wall two high, log gateposts with torches", "a third course of battlements and fence gates in the gateways", "stone brick gate pillars with lanterns"],
  },
};
const scaleOf = (n: number): DesignInfo["scale"] => (n < 150 ? "small" : n < 450 ? "medium" : n < 900 ? "large" : "huge");

/** Put a design in the catalog: its blueprint under its id, its kind's list, what it takes at each tier. A design
 *  registered under its kind's own name is that kind's first. */
export function register(id: string, bp: Blueprint, opts: { name?: string; style?: string } = {}): DesignInfo {
  const kind = bp.kind ?? id;
  BLUEPRINTS[id] = bp;
  const size: [number, number] = [bp.core[0] + 2 * bp.eaves, bp.core[1] + 2 * bp.eaves];
  const info: DesignInfo = { id, kind, name: opts.name ?? id, size, tiers: bp.tiers.length - 1, what: bp.what, up: bp.tiers, blocks: [0], scale: "small", style: opts.style };
  DESIGNS[id] = info;
  const s: Site = { kind, design: id, x0: 100, z0: 100, x1: 100 + size[0] - 1, z1: 100 + size[1] - 1, y: 60 };
  for (let t = 1; t <= info.tiers; t++) info.blocks.push(planFor(s, t, () => 59).filter((c) => cellTarget(c[3])).length);
  info.scale = scaleOf(info.blocks[1] ?? 0);
  const k = KINDS[kind];
  if (!k || id === kind) KINDS[kind] = { size, tiers: info.tiers, what: bp.what, up: bp.tiers, blocks: info.blocks, designs: [...(k?.designs ?? []), ...(k?.designs.includes(id) ? [] : [id])] };
  else if (!k.designs.includes(id)) k.designs.push(id);
  return info;
}

type Cell = { k: string; late: boolean };
/** Building a plan in a building's own frame: u along its front (left to right seen from the street), v from the
 *  front wall in, dy up from the floor (dy -1 is the ground course: the footing and the floor). */
export class Draft {
  readonly cells = new Map<string, Cell & { x: number; y: number; z: number }>();
  readonly found = new Set<string>();
  W: number;
  D: number;
  m: number;
  IN: number;
  OUT: number;
  RIGHT: number;
  LEFT: number;
  /** The roof over a spot in the room (what a lantern hangs from): dy of its underside's first solid block. */
  ceiling: (u: number, v: number) => number = () => 99;
  private FW: number;
  private FD: number;
  readonly s: Site;
  readonly t: number;
  readonly bp: Blueprint;
  constructor(s: Site, t: number, bp: Blueprint) {
    this.s = s;
    this.t = t;
    this.bp = bp;
    const face = s.face ?? 0;
    const rw = s.x1 - s.x0 + 1;
    const rd = s.z1 - s.z0 + 1;
    this.FW = face % 2 ? rd : rw;
    this.FD = face % 2 ? rw : rd;
    // a rectangle of the size this design takes: the design with its eaves; anything else is an old building's
    // rectangle (the old plans were smaller): the same design fitted inside it, walls on its edge, no eaves
    const [cw, cd] = bp.core;
    if (this.FW === cw + 2 * bp.eaves && this.FD === cd + 2 * bp.eaves) {
      this.W = cw;
      this.D = cd;
      this.m = bp.eaves;
    } else {
      this.W = this.FW;
      this.D = this.FD;
      this.m = 0;
    }
    this.OUT = face;
    this.IN = (face + 2) % 4;
    this.RIGHT = (face + 1) % 4;
    this.LEFT = (face + 3) % 4;
  }
  get mid() {
    return Math.floor((this.W - 1) / 2);
  }
  /** A blueprint position along the front (u) or into the building (v), as a number in the frame. */
  u(p: Pos): number {
    return typeof p === "number" ? (p < 0 ? this.W + p : p) : this.mid + Number(p.slice(3) || 0);
  }
  v(p: Pos): number {
    if (p === "out") return -1;
    return typeof p === "number" ? (p < 0 ? this.D + p : p) : Math.floor((this.D - 1) / 2) + Number(p.slice(3) || 0);
  }
  /** The block of a part at this tier (0: the part is left open). */
  mat(p: Part): number {
    const m = this.bp.parts[p];
    return m ? m[Math.min(3, this.t) - 1] : 0;
  }
  /** A facing in the building's terms, in the world's. */
  dir(f: "in" | "out" | "left" | "right"): number {
    return f === "in" ? this.IN : f === "out" ? this.OUT : f === "left" ? this.LEFT : this.RIGHT;
  }
  /** World x, z of a cell in the frame. */
  at(u: number, v: number): [number, number] {
    const a = u + this.m;
    const b = v + this.m;
    const s = this.s;
    switch (this.s.face ?? 0) {
      case 1:
        return [s.x1 - b, s.z0 + a];
      case 2:
        return [s.x1 - a, s.z1 - b];
      case 3:
        return [s.x0 + b, s.z1 - a];
      default:
        return [s.x0 + a, s.z0 + b];
    }
  }
  inside(u: number, v: number) {
    return u >= -this.m && v >= -this.m && u < this.W + this.m && v < this.D + this.m;
  }
  /** Put a block (or a cell kind: "a" keep clear, "o" open, "?p" a path) in a cell; 0 keeps it clear. */
  put(u: number, dy: number, v: number, k: string | number): void {
    if (!this.inside(u, v)) return;
    const [x, z] = this.at(u, v);
    const kk = typeof k === "number" ? (k ? exact(k) : "a") : k;
    const t = cellTarget(kk);
    this.cells.set(`${x},${this.s.y + dy},${z}`, { x, y: this.s.y + dy, z, k: kk, late: !!t && late(t.id) });
  }
  opt(u: number, dy: number, v: number, id: number): void {
    this.put(u, dy, v, optional(id));
  }
  /** A column the foundation fills up to the floor (low ground under the building). */
  foot(u: number, v: number): void {
    if (!this.inside(u, v)) return;
    const [x, z] = this.at(u, v);
    this.found.add(`${x},${z}`);
  }
  edge(u: number, v: number) {
    return u === 0 || v === 0 || u === this.W - 1 || v === this.D - 1;
  }
  corner(u: number, v: number) {
    return (u === 0 || u === this.W - 1) && (v === 0 || v === this.D - 1);
  }
}

/** The windows, doors and furniture of a blueprint, at this tier (after the shape, so they take the cells they need). */
export function furnish(d: Draft): void {
  const bp = d.bp;
  for (const [u, dy, v] of bp.windows ?? []) d.put(d.u(u), dy, d.v(v), d.mat("window"));
  for (const u of bp.doors ?? []) {
    const du = d.u(u);
    d.put(du, 0, 0, doorId(d.IN, false, false));
    d.put(du, 1, 0, "o");
    // the step in front kept open, a path dug to it
    d.put(du, 0, -1, "o");
    d.put(du, 1, -1, "o");
    d.put(du, -1, -1, "?p");
    d.foot(du, -1);
  }
  // (in an old building's smaller room two pieces can land on one spot: the first keeps it)
  const taken = new Set<string>();
  for (const f of bp.furniture) {
    if (f.tier > d.t) continue;
    const u = d.u(f.at[0]);
    const v = d.v(f.at[2]);
    const dy = f.hang ? d.ceiling(u, v) - 1 : f.at[1];
    // the bed's head lies the way it faces: that cell is kept clear for it
    const head = f.block === B.RED_BED ? (f.facing === "in" ? [u, v + 1] : f.facing === "out" ? [u, v - 1] : f.facing === "left" ? [u - 1, v] : [u + 1, v]) : null;
    const spots = [[u, v], ...(head ? [head] : [])].map(([a, c]) => `${a},${dy},${c}`);
    if (spots.some((k) => taken.has(k))) continue;
    for (const k of spots) taken.add(k);
    let id = f.block;
    if (f.facing && (isChest(id) || isFurnace(id) || id === B.RED_BED || stairBase(id) >= 0 || isLadder(id))) id += d.dir(f.facing);
    if (f.optional) d.opt(u, dy, v, id);
    else d.put(u, dy, v, id);
    if (head) d.put(head[0], dy, head[1], "a");
  }
}

/** A gabled building in the village style (shared/villages.ts buildHouse): walls `walls` high on a cobblestone
 *  footing, the lowest courses the `base` material and the rest `wall`, log posts at the corners (and the blueprint's
 *  posts) with a log plate on top of the eaves walls, a gable roof of stairs with a ridge, eaves all round, plank
 *  gables, a floor, the room kept clear. The ridge runs front to back; a chimney up the back wall from its tier. */
function cottage(d: Draft): void {
  const { W, D, t, bp } = d;
  const H = bp.walls;
  const mid = d.mid;
  const ridge = bp.ridge ?? "v";
  // the roof's height over a spot: rising from the eaves walls to the ridge (along v: the side walls are the eaves
  // walls; across, along u: the front and back are), or flat on top of the walls
  const roofAt = (u: number, v: number) =>
    ridge === "flat" ? H : ridge === "u" ? (v < 0 || v >= D ? H : H + 1 + Math.min(v, D - 1 - v)) : u < 0 || u >= W ? H : H + 1 + Math.min(u, W - 1 - u);
  d.ceiling = (u, v) => roofAt(u, v);
  const posts = (bp.posts ?? []).map(([u, v]) => [d.u(u), d.v(v)]);
  const floors = bp.floors ?? [];
  // an upper floor's way up: a ladder against the back wall in the left corner, a hole in the floor over it
  const ladderU = 1;
  const ladderV = D - 2;
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++) {
      d.foot(u, v);
      const edge = d.edge(u, v);
      d.put(u, -1, v, edge ? d.mat("footing") : d.mat("floor"));
      for (let dy = 0; dy < H; dy++) {
        if (!edge) d.put(u, dy, v, floors.includes(dy) && !(u === ladderU && v === ladderV) ? d.mat("loft") || d.mat("floor") : "a");
        else if (d.corner(u, v) || posts.some(([pu, pv]) => pu === u && pv === v)) d.put(u, dy, v, d.mat("post"));
        else d.put(u, dy, v, dy < (bp.baseCourses ?? 0) ? d.mat("base") : floors.includes(dy) && d.mat("band") ? d.mat("band") : d.mat("wall"));
      }
    }
  for (const f of floors) for (let dy = 0; dy <= f; dy++) d.put(ladderU, dy, ladderV, B.LADDER + d.OUT);
  if (ridge === "flat") {
    // a flat roof of the ridge material, a parapet round it
    for (let v = 0; v < D; v++) for (let u = 0; u < W; u++) d.put(u, H, v, d.edge(u, v) ? d.mat("plate") : d.mat("ridge"));
    for (let v = 0; v < D; v++) for (let u = 0; u < W; u++) if (d.edge(u, v)) d.put(u, H + 1, v, d.corner(u, v) ? d.mat("post") : d.mat("parapet") || d.mat("plate"));
  } else if (ridge === "u") {
    // the ridge across the front: the plate along the front and back walls, gables up the side walls
    for (let u = 0; u < W; u++) for (const v of [0, D - 1]) d.put(u, H, v, d.mat("plate"));
    for (const u of [0, W - 1]) for (let v = 1; v < D - 1; v++) for (let dy = H; dy < roofAt(u, v); dy++) d.put(u, dy, v, d.mat("gable"));
    const two = D % 2 === 0;
    const mv = Math.floor((D - 1) / 2);
    for (let v = -d.m; v < D + d.m; v++)
      for (let u = -d.m; u < W + d.m; u++) {
        const top = two ? v === D / 2 - 1 || v === D / 2 : v === mv;
        d.put(u, roofAt(u, v), v, top ? d.mat("ridge") : d.mat("roof") + (v < D / 2 ? d.IN : d.OUT));
      }
  } else {
    // the plate: a log beam along the top of the two eaves walls, which the roof's first row rests on
    for (let v = 0; v < D; v++) for (const u of [0, W - 1]) d.put(u, H, v, d.mat("plate"));
    // the gables, up to the roof
    for (const v of [0, D - 1]) for (let u = 1; u < W - 1; u++) for (let dy = H; dy < roofAt(u, v); dy++) d.put(u, dy, v, d.mat("gable"));
    // the roof, eaves and all (an even width: a ridge two blocks wide)
    const two = W % 2 === 0;
    for (let v = -d.m; v < D + d.m; v++)
      for (let u = -d.m; u < W + d.m; u++) {
        const top = two ? u === W / 2 - 1 || u === W / 2 : u === mid;
        d.put(u, roofAt(u, v), v, top ? d.mat("ridge") : d.mat("roof") + (u < W / 2 ? d.RIGHT : d.LEFT));
      }
  }
  if (bp.chimney && t >= bp.chimney.tier) {
    const cu = d.u(bp.chimney.u);
    for (let dy = H; dy <= roofAt(cu, D - 1) + 2; dy++) d.put(cu, dy, D - 1, d.mat("chimney"));
  }
  furnish(d);
}

/** Market stalls side by side under one gable roof whose ridge runs along the front: log posts every four blocks, a
 *  counter between the front posts, plank boards at the back, fences between the stalls, a paved floor. */
function stalls(d: Draft): void {
  const { W, D } = d;
  const posts: number[] = [0];
  for (let u = 4; u < W; u += 4) posts.push(u);
  if (posts[posts.length - 1] !== W - 1) posts.push(W - 1);
  const back = D - 1;
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++) {
      d.foot(u, v);
      d.put(u, -1, v, d.edge(u, v) ? d.mat("border") : d.mat("floor"));
      for (let dy = 0; dy < 3; dy++) d.put(u, dy, v, "a");
    }
  for (const u of posts) for (const v of [0, back]) for (let dy = 0; dy < 3; dy++) d.put(u, dy, v, d.mat("post"));
  for (let u = 0; u < W; u++) {
    if (posts.includes(u)) continue;
    d.put(u, 0, 0, d.mat("counter"));
    d.put(u, 0, back, d.mat("board"));
    d.put(u, 1, back, d.mat("board"));
  }
  for (const u of posts) if (u !== 0 && u !== W - 1) for (let v = 1; v < back; v++) d.put(u, 0, v, d.mat("divider"));
  for (const u of [0, W - 1]) for (let v = 1; v < back; v++) d.put(u, 0, v, d.mat("divider"));
  const mv = Math.floor(back / 2);
  const roofDy = (v: number) => 3 + Math.min(v + d.m, back + d.m - v);
  d.ceiling = (_u, v) => roofDy(v);
  for (let v = -d.m; v <= back + d.m; v++)
    for (let u = -d.m; u < W + d.m; u++) d.put(u, roofDy(v), v, v === mv && back % 2 === 0 ? d.mat("ridge") : d.mat("roof") + (v <= mv - (back % 2 === 0 ? 1 : 0) ? d.IN : d.OUT));
  for (const u of [0, W - 1]) for (let v = 0; v <= back; v++) for (let dy = 3; dy < roofDy(v); dy++) d.put(u, dy, v, d.mat("gable"));
  for (let u = 1; u < W - 1; u++) for (const v of [0, back]) if (roofDy(v) > 3) d.put(u, 3, v, d.mat("plate"));
  for (const u of posts) d.put(u, 0, 1, d.mat("light"));
  furnish(d);
}

function well(d: Draft): void {
  const { W, D } = d;
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++) {
      d.foot(u, v);
      // the front middle of the parapet stays open: from the basin floor a rim block is one step up, but a wall on
      // top of it made two and a half, and whoever fell in was stuck there (Laith: "people get stuck in the well way
      // too often"). Through the gap it's one hop up onto the rim and out
      const gap = v === 0 && u === Math.floor(W / 2);
      if (d.edge(u, v)) {
        d.put(u, -1, v, d.mat("rim"));
        d.put(u, 0, v, gap ? "a" : d.corner(u, v) ? d.mat("rim") : d.mat("parapet"));
      } else {
        // the basin: one deep (and the gap in the parapet is the way out)
        d.put(u, -2, v, d.mat("basin"));
        d.put(u, -1, v, "a");
        d.put(u, 0, v, "a");
      }
    }
  for (const [u, v] of [[0, 0], [W - 1, 0], [0, D - 1], [W - 1, D - 1]]) for (const dy of [1, 2]) d.put(u, dy, v, d.mat("post"));
  // a little gable roof, its ridge along u
  const mv = Math.floor((D - 1) / 2);
  const roofDy = (v: number) => 3 + Math.min(v, D - 1 - v);
  d.ceiling = (_u, v) => roofDy(v);
  for (let v = 0; v < D; v++) for (let u = 0; u < W; u++) d.put(u, roofDy(v), v, v === mv ? d.mat("ridge") : d.mat("roof") + (v < mv ? d.IN : d.OUT));
  // the gable ends under it: without them the upper rows had nothing to be placed against (a block only goes in
  // against another, and the row below is a step out)
  for (const u of [0, W - 1]) for (let v = 1; v < D - 1; v++) for (let dy = 3; dy < roofDy(v); dy++) d.put(u, dy, v, d.mat("gable"));
  furnish(d);
}

function lamp(d: Draft): void {
  d.foot(0, 0);
  d.put(0, 0, 0, d.mat("footing"));
  d.put(0, 1, 0, d.mat("post"));
  d.put(0, 2, 0, d.mat("post"));
  // a torch needs a solid block under it (a log, never a fence); a lantern stands on a fence
  d.put(0, 3, 0, d.mat("light"));
  furnish(d);
}

/** Battlements on a ring at height dy: merlons on the corners and every other block, gaps between. */
export function battlements(d: Draft, dy: number, block: number): void {
  const { W, D } = d;
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++) {
      if (!d.edge(u, v)) continue;
      const k = u === 0 || u === W - 1 ? v : u;
      if (d.corner(u, v) || k % 2 === 0) d.put(u, dy, v, block);
    }
}

/** A stone tower: walls `walls` high round a stair well, a door, a ladder up the back wall to a hatch in the lookout
 *  floor, battlements round it with lights on the corners, slits up the sides and over the door. */
function tower(d: Draft): void {
  const { W, D } = d;
  const mid = d.mid;
  const H = d.bp.walls;
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++) {
      d.foot(u, v);
      const edge = d.edge(u, v);
      d.put(u, -1, v, d.mat("footing"));
      for (let dy = 0; dy < H; dy++) d.put(u, dy, v, edge ? (d.corner(u, v) ? d.mat("corner") : d.mat("wall")) : "a");
      d.put(u, H, v, d.corner(u, v) ? d.mat("corner") : d.mat("floor"));
    }
  d.ceiling = () => H;
  // slits (none in the back wall: the ladder leans on it)
  for (const [u, v] of [[0, Math.floor(D / 2)], [W - 1, Math.floor(D / 2)], [mid, 0]]) for (const dy of [3, 4]) d.put(u, dy, v, d.mat("window"));
  const lv = D > 3 ? D - 2 : 1;
  for (let dy = 0; dy <= H; dy++) d.put(mid, dy, lv, B.LADDER + d.OUT);
  d.put(mid, H + 1, lv, "o");
  battlements(d, H + 1, d.mat("battlement"));
  for (const [u, v] of [[0, 0], [W - 1, 0], [0, D - 1], [W - 1, D - 1]]) d.put(u, H + 2, v, d.mat("light"));
  furnish(d);
}

/** The keep: stone walls round one tall hall, the lowest courses and the corners in the `base`/`corner` stone, a
 *  stone roof with a ladder up to it, battlements and corner turrets. */
function keep(d: Draft): void {
  const { W, D } = d;
  const mid = d.mid;
  const H = d.bp.walls;
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++) {
      d.foot(u, v);
      const edge = d.edge(u, v);
      d.put(u, -1, v, edge ? d.mat("footing") : d.mat("floor"));
      for (let dy = 0; dy < H; dy++) d.put(u, dy, v, edge ? (d.corner(u, v) ? d.mat("corner") : dy < (d.bp.baseCourses ?? 0) ? d.mat("base") : d.mat("wall")) : "a");
      d.put(u, H, v, d.mat("roof"));
    }
  d.ceiling = () => H;
  for (let dy = 0; dy <= H; dy++) d.put(mid, dy, D - 2, B.LADDER + d.OUT);
  d.put(mid, H + 1, D - 2, "o");
  battlements(d, H + 1, d.mat("battlement"));
  for (const [u, v] of [[0, 0], [W - 1, 0], [0, D - 1], [W - 1, D - 1]]) {
    d.put(u, H + 2, v, d.mat("battlement"));
    d.put(u, H + 3, v, d.mat("light"));
  }
  furnish(d);
}

/** The plaza: paving over the square (a border of its own stone), kept clear above, lamp posts a step in from the
 *  corners; benches and the monument are its furniture. */
function plaza(d: Draft): void {
  const { W, D } = d;
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++) {
      d.foot(u, v);
      d.put(u, -1, v, d.edge(u, v) ? d.mat("border") : d.mat("paving"));
      d.put(u, 0, v, "a");
      d.put(u, 1, v, "a");
    }
  for (const [u, v] of [[1, 1], [W - 2, 1], [1, D - 2], [W - 2, D - 2]]) {
    d.put(u, 0, v, d.mat("footing"));
    d.put(u, 1, v, d.mat("post"));
    d.put(u, 2, v, d.mat("light"));
  }
  furnish(d);
}

/** A ring of stairs round a rectangle at height dy, each one's high side toward the middle (a stepped pyramid roof). */
export function stairRing(d: Draft, u0: number, u1: number, v0: number, v1: number, dy: number, stair: number): void {
  for (let v = v0; v <= v1; v++)
    for (let u = u0; u <= u1; u++) {
      if (u !== u0 && u !== u1 && v !== v0 && v !== v1) continue;
      const f = v === v0 ? d.IN : v === v1 ? d.OUT : u === u0 ? d.RIGHT : d.LEFT;
      d.put(u, dy, v, stair + f);
    }
}

/** A church: the nave (walls `walls` high round the long room, a gable roof along it with eaves, the altar at the far
 *  end, the lowest courses the `base` stone) and a tower at the front: one over the door in the middle with an open
 *  belfry and a stepped stone cap with a light on its spire, or (twin) one at each front corner with a lookout floor,
 *  battlements and lights, the door between them under the great window. A roof with `roofCap` rises that many steps
 *  and then runs flat (the cathedral's stays in reach of the scaffolding); `buttress` adds buttresses down the sides. */
function church(d: Draft): void {
  const { W, D, bp } = d;
  const H = bp.walls;
  const T = bp.tower ?? { w: 5, d: 5, h: H + 4 };
  const cap = bp.roofCap ?? 99;
  const mid = d.mid;
  const roofDy = (u: number) => (u < 0 || u >= W ? H : H + 1 + Math.min(u, W - 1 - u, cap));
  const towers: [number, number][] = T.twin ? [[0, T.w - 1], [W - T.w, W - 1]] : [[Math.floor((W - T.w) / 2), Math.floor((W - T.w) / 2) + T.w - 1]];
  const inTower = (u: number, v: number) => v >= 0 && v < T.d && towers.some(([a, b]) => u >= a && u <= b);
  // the nave runs from the tower's back wall (a single tower stands in front of it) or from the front (twin towers stand
  // in its front corners)
  const nv0 = T.twin ? 0 : T.d - 1;
  d.ceiling = (u, v) => (inTower(u, v) ? T.h : roofDy(u));
  for (let v = nv0; v < D; v++)
    for (let u = 0; u < W; u++) {
      d.foot(u, v);
      const edge = u === 0 || u === W - 1 || v === nv0 || v === D - 1;
      d.put(u, -1, v, edge ? d.mat("footing") : d.mat("floor"));
      for (let dy = 0; dy < H; dy++) {
        if (!edge) d.put(u, dy, v, "a");
        else if ((u === 0 || u === W - 1) && (v === nv0 || v === D - 1)) d.put(u, dy, v, d.mat("post"));
        else d.put(u, dy, v, dy < (bp.baseCourses ?? 0) ? d.mat("base") : d.mat("wall"));
      }
    }
  for (let v = nv0; v < D; v++) for (const u of [0, W - 1]) d.put(u, H, v, d.mat("plate"));
  for (const v of [nv0, D - 1]) for (let u = 1; u < W - 1; u++) for (let dy = H; dy < roofDy(u); dy++) d.put(u, dy, v, d.mat("gable"));
  // the roof, eaves and all, except where a tower stands (and, beside twin towers, their eave columns)
  const two = W % 2 === 0;
  const skip = (u: number, v: number) =>
    T.twin ? v < T.d && ((u >= -1 && u <= T.w - 1) || (u >= W - T.w && u <= W)) : inTower(u, v) || (v === nv0 - 1 && towers.some(([a, b]) => u >= a && u <= b));
  for (let v = nv0 - d.m; v < D + d.m; v++)
    for (let u = -d.m; u < W + d.m; u++) {
      if (skip(u, v)) continue;
      const top = (two ? u === W / 2 - 1 || u === W / 2 : u === mid) || (u >= cap && u <= W - 1 - cap);
      d.put(u, roofDy(u), v, top ? d.mat("ridge") : d.mat("roof") + (u < W / 2 ? d.RIGHT : d.LEFT));
    }
  // buttresses down the long sides, between the windows: stone columns against the wall with a stair on top
  if (bp.buttress)
    for (let v = nv0 + bp.buttress; v < D - 1; v += bp.buttress) {
      if (inTower(0, v) || inTower(W - 1, v)) continue;
      for (const [u, f] of [[-1, d.RIGHT], [W, d.LEFT]] as [number, number][]) {
        d.foot(u, v);
        d.put(u, -1, v, d.mat("footing"));
        for (let dy = 0; dy < H - 2; dy++) d.put(u, dy, v, d.mat("buttress"));
        d.put(u, H - 2, v, d.mat("roof") + f);
      }
    }
  for (const [a, b] of towers) {
    const mu = Math.floor((a + b) / 2);
    const mv = Math.floor((T.d - 1) / 2);
    for (let v = 0; v < T.d; v++)
      for (let u = a; u <= b; u++) {
        d.foot(u, v);
        const e = u === a || u === b || v === 0 || v === T.d - 1;
        const c = (u === a || u === b) && (v === 0 || v === T.d - 1);
        d.put(u, -1, v, e ? d.mat("footing") : d.mat("floor"));
        for (let dy = 0; dy < T.h; dy++) d.put(u, dy, v, e ? (c ? d.mat("corner") : d.mat("wall")) : "a");
      }
    if (T.twin) {
      // the watchtower's top: a lookout floor, battlements round it, lights on the corners; slits up the outer faces,
      // and an arch from the hall between the towers into each one
      for (let v = 0; v < T.d; v++) for (let u = a; u <= b; u++) d.put(u, T.h, v, (u === a || u === b) && (v === 0 || v === T.d - 1) ? d.mat("corner") : d.mat("floor"));
      for (let v = 0; v < T.d; v++)
        for (let u = a; u <= b; u++) {
          if (u !== a && u !== b && v !== 0 && v !== T.d - 1) continue;
          const k = u === a || u === b ? v : u - a;
          if (((u === a || u === b) && (v === 0 || v === T.d - 1)) || k % 2 === 0) d.put(u, T.h + 1, v, d.mat("battlement"));
        }
      for (const [u, v] of [[a, 0], [b, 0], [a, T.d - 1], [b, T.d - 1]]) d.put(u, T.h + 2, v, d.mat("light"));
      const outer = a === 0 ? a : b;
      for (const dy of [3, 4, T.h - 3, T.h - 2]) {
        d.put(mu, dy, 0, d.mat("window"));
        d.put(outer, dy, mv, d.mat("window"));
      }
      const inner = a === 0 ? b : a;
      for (const dy of [0, 1]) d.put(inner, dy, mv, "a");
    } else {
      // the belfry: open arches near the top of the front and the sides; an arch through into the nave
      for (const dy of [T.h - 3, T.h - 2]) {
        d.put(mu, dy, 0, "a");
        d.put(a, dy, mv, "a");
        d.put(b, dy, mv, "a");
      }
      for (let u = a + 1; u < b; u++) for (const dy of [0, 1]) d.put(u, dy, T.d - 1, "a");
      // the cap: a stepped pyramid of stairs over a stone floor, a stone spire, a light on its tip
      const stair = d.mat("cap");
      stairRing(d, a, b, 0, T.d - 1, T.h, stair);
      for (let v = 1; v < T.d - 1; v++) for (let u = a + 1; u < b; u++) d.put(u, T.h, v, d.mat("column"));
      if (b - a >= 4) {
        stairRing(d, a + 1, b - 1, 1, T.d - 2, T.h + 1, stair);
        for (let v = 2; v < T.d - 2; v++) for (let u = a + 2; u < b - 1; u++) d.put(u, T.h + 1, v, d.mat("column"));
      }
      const top = T.h + (b - a >= 4 ? 2 : 1);
      d.put(mu, top, mv, d.mat("column"));
      d.put(mu, top + 1, mv, d.mat("light"));
    }
  }
  furnish(d);
}

/** A fountain: a stone basin at ground level with a low parapet round it, a column in the middle (its water falls
 *  from the top), lights on the corners of the rim. */
function fountain(d: Draft): void {
  const { W, D } = d;
  const mu = d.mid;
  const mv = Math.floor((D - 1) / 2);
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++) {
      d.foot(u, v);
      if (d.edge(u, v)) {
        d.put(u, -1, v, d.mat("rim"));
        d.put(u, 0, v, d.corner(u, v) ? d.mat("rim") : d.mat("parapet"));
      } else {
        d.put(u, -1, v, d.mat("basin"));
        for (const dy of [0, 1, 2, 3]) d.put(u, dy, v, "a");
      }
    }
  for (const dy of [0, 1, 2]) d.put(mu, dy, mv, d.mat("column"));
  for (const [u, v] of [[0, 0], [W - 1, 0], [0, D - 1], [W - 1, D - 1]]) d.put(u, 1, v, d.mat("light"));
  furnish(d);
}

/** A monument: an obelisk on a stepped plinth, a light at its tip; steps round the plinth from tier 2. */
function monument(d: Draft): void {
  const { W, D, bp } = d;
  const mu = d.mid;
  const mv = Math.floor((D - 1) / 2);
  const top = bp.walls;
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++) {
      d.foot(u, v);
      d.put(u, -1, v, d.mat("footing"));
      if (!d.edge(u, v)) {
        d.put(u, 0, v, d.mat("base"));
        d.put(u, 1, v, d.mat("base"));
      } else if (!d.corner(u, v)) {
        // a step up toward the plinth: its high side toward the middle
        const f = v === 0 ? d.IN : v === D - 1 ? d.OUT : u === 0 ? d.RIGHT : d.LEFT;
        const step = d.mat("step");
        d.put(u, 0, v, step ? step + f : "a");
      }
    }
  for (let dy = 2; dy < top; dy++) d.put(mu, dy, mv, d.mat("column"));
  d.put(mu, top, mv, d.mat("light"));
  furnish(d);
}

/** How each shape is drawn; the catalog (agents/catalog.ts) adds its own. */
export const SHAPES: Record<string, (d: Draft) => void> = { cottage, stalls, well, lamp, tower, keep, plaza, church, fountain, monument };

/** The order a person builds in: the foundation, then a layer at a time from the bottom, each layer walked round
 *  from the blocks already standing (a wall's top before the roof that rests on it, the inner roof row before the
 *  eave that hangs off it: a block can only go in against another), then doors, lights and furniture last. */
function order(cells: (Cell & { x: number; y: number; z: number })[], r: Rect, floor: number): PlanCell[] {
  const cx = (r.x0 + r.x1) / 2;
  const cz = (r.z0 + r.z1) / 2;
  const edge = (c: { x: number; z: number }) => Math.min(c.x - r.x0, r.x1 - c.x, c.z - r.z0, r.z1 - c.z);
  const angle = (c: { x: number; z: number }) => (Math.atan2(c.z - cz, c.x - cx) + Math.PI * 2) % (Math.PI * 2);
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const solid = (k: string) => !!cellTarget(k);
  const placed = new Set<string>();
  const out: PlanCell[] = [];
  const sorted = (cs: typeof cells) => cs.sort((a, b) => a.y - b.y || edge(a) - edge(b) || angle(a) - angle(b));
  const found = sorted(cells.filter((c) => c.k === "d"));
  for (const c of found) {
    out.push([c.x, c.y, c.z, c.k]);
    placed.add(key(c.x, c.y, c.z));
  }
  const rest = cells.filter((c) => c.k !== "d");
  const supported = (c: { x: number; y: number; z: number }) =>
    c.y <= floor || [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([a, b, d]) => placed.has(key(c.x + a, c.y + b, c.z + d)));
  for (const group of [rest.filter((c) => !c.late), rest.filter((c) => c.late)]) {
    const byY = new Map<number, typeof cells>();
    for (const c of group) {
      if (!byY.has(c.y)) byY.set(c.y, []);
      byY.get(c.y)!.push(c);
    }
    for (const y of [...byY.keys()].sort((a, b) => a - b)) {
      let left = sorted(byY.get(y)!);
      while (left.length) {
        const next: typeof cells = [];
        let took = 0;
        for (const c of left) {
          if (!solid(c.k) || c.late || supported(c)) {
            out.push([c.x, c.y, c.z, c.k]);
            if (solid(c.k)) placed.add(key(c.x, c.y, c.z));
            took++;
          } else next.push(c);
        }
        if (!took) {
          for (const c of next) out.push([c.x, c.y, c.z, c.k]);
          break;
        }
        left = next;
      }
    }
  }
  return out;
}

/** The plan of a building at a tier: its cells in build order. `ground` gives the ground under a column, so low spots
 *  get a foundation first. */
export function planFor(s: Site, tier: number, ground: (x: number, z: number) => number): PlanCell[] {
  const bp = designOf(s);
  if (!bp) return [];
  const top = bp.tiers.length - 1;
  const t = Math.max(1, Math.min(tier, top));
  const d = new Draft(s, t, bp);
  SHAPES[bp.shape](d);
  // what the later tiers put in the same cells does for this one too (glass where this tier has fence bars, a chest
  // where it keeps the floor clear): an upgraded building still meets every tier under it
  for (let up = t + 1; up <= top; up++) {
    const u = new Draft(s, up, bp);
    SHAPES[bp.shape](u);
    for (const [key, c] of d.cells) {
      const later = u.cells.get(key);
      const lt = later && cellTarget(later.k);
      if (!lt || later.k === c.k || c.k.split("|").includes(String(lt.id))) continue;
      const own = cellTarget(c.k);
      if (own && accepts(own.id, lt.id)) continue;
      c.k += `|${lt.id}`;
    }
  }
  // the foundation: low ground under the building filled up to its floor, at most three deep; cobblestone round the
  // outside where it shows (a stone plinth, not dirt, planks and stone as they came), anything inside
  for (const col of d.found) {
    const [x, z] = col.split(",").map(Number);
    const g = ground(x, z);
    if (g < 0) continue;
    const outer = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => !d.found.has(`${x + dx},${z + dz}`));
    for (let yy = Math.max(g + 1, s.y - 3); yy < s.y; yy++) if (!d.cells.has(`${x},${yy},${z}`)) d.cells.set(`${x},${yy},${z}`, { x, y: yy, z, k: outer ? exact(B.COBBLESTONE) : "d", late: false });
  }
  // the cut: a lot dug into a slope has the ground over its floor taken away across the whole rectangle (the building
  // and its eaves), a terrace, so the walls stand clear and the windows look out
  if (s.cut)
    for (let x = s.x0; x <= s.x1; x++)
      for (let z = s.z0; z <= s.z1; z++) {
        const g = ground(x, z);
        for (let yy = s.y; yy <= Math.min(g, s.y + 3); yy++) if (!d.cells.has(`${x},${yy},${z}`)) d.cells.set(`${x},${yy},${z}`, { x, y: yy, z, k: "a", late: false });
      }
  // steps down from each door when the ground falls away in front of it: the step outside a cottage on a slope stood
  // two blocks over the grass, and nobody could get in (sonnet walked round its own house for minutes)
  for (const du of bp.doors ?? []) {
    const u = d.u(du);
    for (let k = 1; k <= 3; k++) {
      const [x, z] = d.at(u, -1 - k);
      const g = ground(x, z);
      const lvl = s.y - 1 - k;
      if (g < 0 || g >= lvl) break;
      d.cells.set(`${x},${lvl},${z}`, { x, y: lvl, z, k: exact(B.COBBLE_STAIRS + d.IN), late: false });
      for (let yy = Math.max(g + 1, lvl - 3); yy < lvl; yy++) d.cells.set(`${x},${yy},${z}`, { x, y: yy, z, k: exact(B.COBBLESTONE), late: false });
    }
  }
  return order([...d.cells.values()], s, s.y - 1);
}

/** The wall round the base: a square `r` blocks out each way on the ground it crosses, a gate three wide in the middle
 *  of each side with log gateposts. Tier 2 adds a course of battlements and fence gates, tier 3 stone brick gate
 *  pillars with lanterns. Water, trees and `skip` (the town's buildings, its roads: a gap where a road goes through)
 *  are left as they are. */
export function wallPlan(cx: number, cz: number, r: number, ground: (x: number, z: number) => number, tier = 1, skip: (x: number, z: number) => boolean = () => false): PlanCell[] {
  const cells: PlanCell[] = [];
  const seen = new Set<string>();
  const put = (x: number, y: number, z: number, k: string | number) => {
    const key = `${x},${y},${z}`;
    if (seen.has(key)) return;
    seen.add(key);
    cells.push([x, y, z, typeof k === "number" ? exact(k) : k]);
  };
  const gateSides: { posts: [number, number][]; gap: [number, number][]; facing: number }[] = [
    { posts: [[cx - 2, cz - r], [cx + 2, cz - r]], gap: [[cx - 1, cz - r], [cx, cz - r], [cx + 1, cz - r]], facing: 0 },
    { posts: [[cx - 2, cz + r], [cx + 2, cz + r]], gap: [[cx - 1, cz + r], [cx, cz + r], [cx + 1, cz + r]], facing: 2 },
    { posts: [[cx - r, cz - 2], [cx - r, cz + 2]], gap: [[cx - r, cz - 1], [cx - r, cz], [cx - r, cz + 1]], facing: 3 },
    { posts: [[cx + r, cz - 2], [cx + r, cz + 2]], gap: [[cx + r, cz - 1], [cx + r, cz], [cx + r, cz + 1]], facing: 1 },
  ];
  const isPost = (x: number, z: number) => gateSides.some((g) => g.posts.some(([a, b]) => a === x && b === z));
  const isGap = (x: number, z: number) => gateSides.some((g) => g.gap.some(([a, b]) => a === x && b === z));
  // the posts first (the gates hang on them), then round the square in one direction, a course at a time
  for (const g of gateSides)
    for (const [x, z] of g.posts) {
      const gy = ground(x, z);
      if (gy < 0 || skip(x, z)) continue;
      const tall = tier >= 3 ? 4 : 3;
      for (let k = 1; k <= tall; k++) put(x, gy + k, z, tier >= 3 ? B.STONE_BRICKS : B.OAK_LOG);
      put(x, gy + tall + 1, z, tier >= 3 ? B.LANTERN : B.TORCH);
    }
  const along: [number, number][] = [];
  for (let k = -r; k <= r; k++) along.push([cx + k, cz - r], [cx + k, cz + r], [cx - r, cz + k], [cx + r, cz + k]);
  const a = ([x, z]: [number, number]) => (Math.atan2(z - cz, x - cx) + Math.PI * 2) % (Math.PI * 2);
  along.sort((p, q) => a(p) - a(q));
  const rows: PlanCell[][] = [[], [], []];
  const done = new Set<string>();
  for (const [x, z] of along) {
    if (done.has(`${x},${z}`) || isPost(x, z) || skip(x, z)) continue;
    done.add(`${x},${z}`);
    const g = ground(x, z);
    if (g < 0) continue;
    if (isGap(x, z)) continue;
    rows[0].push([x, g + 1, z, exact(B.COBBLESTONE)]);
    rows[1].push([x, g + 2, z, exact(B.COBBLESTONE)]);
    // battlements: every other block along the top
    if (tier >= 2 && (x + z) % 2 === 0) rows[2].push([x, g + 3, z, exact(B.COBBLESTONE)]);
  }
  for (const row of rows) for (const c of row) put(c[0], c[1], c[2], c[3]);
  if (tier >= 2)
    for (const g of gateSides)
      for (const [x, z] of g.gap) {
        const gy = ground(x, z);
        if (gy >= 0 && !skip(x, z)) put(x, gy + 1, z, B.OAK_GATE + g.facing);
      }
  return cells;
}

/** A farm's tiers on top of the field itself: a fence round it, a step out from the planted ground, with a gate on the
 *  side toward the base; lanterns on the corner posts. */
export function farmPlan(r: Rect, tier: number, toward: { x: number; z: number }, ground: (x: number, z: number) => number): PlanCell[] {
  if (tier < 2) return [];
  const cells: PlanCell[] = [];
  const x0 = r.x0 - 2, x1 = r.x1 + 2, z0 = r.z0 - 2, z1 = r.z1 + 2;
  const face = faceToward({ x0, z0, x1, z1 }, toward.x, toward.z);
  const gate: [number, number] = face === 0 ? [(x0 + x1) >> 1, z0] : face === 2 ? [(x0 + x1) >> 1, z1] : face === 1 ? [x1, (z0 + z1) >> 1] : [x0, (z0 + z1) >> 1];
  for (let x = x0; x <= x1; x++)
    for (let z = z0; z <= z1; z++) {
      if (x !== x0 && x !== x1 && z !== z0 && z !== z1) continue;
      const g = ground(x, z);
      if (g < 0) continue;
      const corner = (x === x0 || x === x1) && (z === z0 || z === z1);
      cells.push([x, g + 1, z, exact(x === gate[0] && z === gate[1] ? B.OAK_GATE + (face % 2 ? 1 : 0) : B.OAK_FENCE)]);
      if (corner && tier >= 3) cells.push([x, g + 2, z, exact(B.LANTERN)]);
    }
  return cells;
}

/** The roads: a path from the step in front of every building's door to the plaza (or the base), straight out from
 *  the door first, then along x and along z, round nothing: cells inside any building are left out. Dirt paths dug
 *  with a shovel; tier 2 paves them in cobblestone. Which building each cell serves comes back too, so the roads can
 *  count the buildings they join. */
export function roadPlan(hub: { x: number; z: number }, builds: Building[], ground: (x: number, z: number) => number, tier = 1): { cells: PlanCell[]; of: number[] } {
  const cells: PlanCell[] = [];
  const of: number[] = [];
  const seen = new Set<string>();
  const blocked = (x: number, z: number) => builds.some((b) => b.kind !== "road" && b.kind !== "wall" && b.kind !== "farm" && b.kind !== "plaza" && x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1);
  const k = tier >= 2 ? exact(B.COBBLESTONE) : "p";
  builds.forEach((b, i) => {
    if (b.kind === "road" || b.kind === "wall" || b.kind === "farm" || b.kind === "lamp" || b.kind === "plaza") return;
    const door = doorStep(b);
    if (!door) return;
    // only the town's own buildings: a house sonnet once built 250 blocks out put road cells at x=300-370, out of
    // reach from the town, and the road job stood still trying them
    if (Math.hypot(door[0] - hub.x, door[1] - hub.z) > 64) return;
    let [x, z] = door;
    const step = (nx: number, nz: number) => {
      x = nx;
      z = nz;
      if (blocked(x, z)) return;
      const key = `${x},${z}`;
      const g = ground(x, z);
      if (g < 0 || seen.has(key)) return;
      seen.add(key);
      cells.push([x, g, z, k]);
      of.push(i);
    };
    step(x, z);
    // two steps straight out from the door, then along x to the hub and along z
    const [dx, dz] = [[0, -1], [1, 0], [0, 1], [-1, 0]][b.face ?? 0];
    for (let n = 0; n < 2; n++) step(x + dx, z + dz);
    for (let n = 0; n < 400 && x !== hub.x; n++) step(x + Math.sign(hub.x - x), z);
    for (let n = 0; n < 400 && z !== hub.z; n++) step(x, z + Math.sign(hub.z - z));
  });
  return { cells, of };
}

/** A cottage as a home: the room inside, its door (the lower cell) and where its bed goes (and the bed's state). */
export function homeOf(b: Building): { room: Rect; door: [number, number, number]; bed: [number, number, number, number] | null } | null {
  const bp = designOf(b);
  if (!bp || bp.shape !== "cottage" || b.kind !== "house") return null;
  const d = new Draft(b, 1, bp);
  const [ax, az] = d.at(1, 1);
  const [bx, bz] = d.at(d.W - 2, d.D - 2);
  const [dx, dz] = d.at(d.u(bp.doors?.[0] ?? "mid"), 0);
  const f = bp.furniture.find((x) => x.block === B.RED_BED);
  let bed: [number, number, number, number] | null = null;
  if (f) {
    const [fx, fz] = d.at(d.u(f.at[0]), d.v(f.at[2]));
    bed = [fx, b.y + f.at[1], fz, B.RED_BED + d.dir(f.facing ?? "in")];
  }
  return { room: { x0: Math.min(ax, bx), z0: Math.min(az, bz), x1: Math.max(ax, bx), z1: Math.max(az, bz) }, door: [dx, b.y, dz], bed };
}

/** The cell in front of a building's door (outside it), or null for something without a door. */
export function doorStep(b: Building): [number, number] | null {
  const bp = designOf(b);
  if (!bp || b.kind === "lamp" || b.kind === "well" || b.kind === "plaza") return null;
  const d = new Draft(b, 1, bp);
  return d.at(d.mid, -1);
}

// ---------------------------------------------------------------- blueprints and bills of materials (for planning)

/** A building's blueprint at a tier: on flat ground, its front to the north, every cell relative to the north-west
 *  corner of its rectangle (dx, dy up from the floor, dz) with what goes there (a cell kind, see cellTarget). What a
 *  town planner lays out and costs; the same plan planFor turns to face the town and fits to the ground. */
export function blueprint(id: string, tier: number): { size: [number, number]; cells: PlanCell[] } {
  const [w, d] = (DESIGNS[id] ?? KINDS[id]).size;
  const s: Site = { kind: DESIGNS[id]?.kind ?? id, design: id, x0: 0, z0: 0, x1: w - 1, z1: d - 1, y: 0, face: 0 };
  return { size: [w, d], cells: planFor(s, tier, () => -1) };
}

/** The items a set of plan cells takes: item id -> how many (stairs, a door, glass panes, lanterns...), the optional
 *  details left out. */
export function billOfCells(cells: PlanCell[]): Map<number, number> {
  const bill = new Map<number, number>();
  for (const c of cells) {
    const t = cellTarget(c[3]);
    if (!t || t.optional) continue;
    const item = itemOf(t.id);
    bill.set(item, (bill.get(item) ?? 0) + 1);
  }
  return bill;
}

/** What a building takes at a tier built from nothing (no foundation: that's the ground's), or with `from`, what the
 *  upgrade from that tier takes: only the cells whose block changes or is new. */
export function materialsFor(kind: string, tier: number, from = 0): Map<number, number> {
  const plan = (t: number) => (kind === "wall" ? wallPlan(0, 0, 13, () => 0, t) : blueprint(kind, t).cells);
  const want = plan(tier);
  if (!from) return billOfCells(want);
  const had = new Map(plan(from).map((c) => [`${c[0]},${c[1]},${c[2]}`, cellTarget(c[3])?.id ?? -1]));
  return billOfCells(want.filter((c) => {
    const t = cellTarget(c[3]);
    const h = had.get(`${c[0]},${c[1]},${c[2]}`);
    return !!t && (h === undefined || h < 0 || !accepts(t.id, h));
  }));
}

// the town's first designs, one per kind (the catalog adds the rest)
for (const id of Object.keys(BLUEPRINTS)) register(id, BLUEPRINTS[id], { name: id });
{
  const flat = () => 59;
  KINDS.wall.blocks = [0, 1, 2, 3].map((t) => (t ? wallPlan(200, 200, 13, flat, t).length : 0));
}
