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

export type Kind = "house" | "farm" | "well" | "lamp" | "storehouse" | "hall" | "tower" | "market" | "wall" | "plaza" | "keep" | "road";
/** The kinds that are one building on one rectangle, planned by planFor. */
export type Plain = Exclude<Kind, "farm" | "wall" | "road">;

export interface Building extends Rect {
  kind: Kind;
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
}

/** How many tiers each kind has (roads and farms too). */
export const maxTier = (k: Kind): number => (k === "road" ? 2 : k === "farm" ? 3 : KINDS[k].tiers);
/** What an upgrade of a farm or the roads adds. */
export const UP_EXTRA: Record<"farm" | "road", string[]> = {
  farm: ["", "the field by the water", "a fence round the field with a gate", "lanterns on the fence corners"],
  road: ["", "dirt paths from every door to the plaza", "the paths paved in cobblestone"],
};

/** A need: [what, how many, of at least this tier]. "road" counts buildings joined to the plaza (or the base) by a
 *  path, "trade" trades made with villagers. Houses of tier 0 are anyone's shelter (build_house homes count). */
export type Need = [Kind | "trade", number, number?];
/** The stages, each on top of the one before. A city takes many hours of three players' work. */
export const STAGES: { name: string; needs: Need[] }[] = [
  { name: "a camp", needs: [["house", 1, 0]] },
  { name: "a homestead", needs: [["house", 2], ["farm", 1], ["well", 1]] },
  { name: "a hamlet", needs: [["house", 4], ["farm", 2], ["lamp", 4], ["storehouse", 1], ["road", 4]] },
  { name: "a village", needs: [["house", 6], ["house", 2, 2], ["farm", 3], ["lamp", 8], ["plaza", 1], ["market", 1], ["wall", 1], ["road", 8]] },
  { name: "a market town", needs: [["house", 8], ["house", 3, 2], ["hall", 1], ["market", 1, 2], ["tower", 1], ["lamp", 12], ["trade", 5], ["road", 12]] },
  { name: "a town", needs: [["house", 10], ["house", 5, 2], ["house", 1, 3], ["farm", 4], ["hall", 1, 2], ["wall", 1, 2], ["tower", 2], ["plaza", 1, 2], ["storehouse", 1, 2], ["lamp", 16], ["lamp", 4, 2], ["trade", 10], ["road", 15]] },
  { name: "a city", needs: [["house", 14], ["house", 8, 2], ["house", 3, 3], ["keep", 1], ["tower", 3], ["tower", 1, 2], ["hall", 1, 3], ["market", 1, 3], ["wall", 1, 3], ["farm", 6], ["farm", 2, 2], ["lamp", 24], ["lamp", 8, 2], ["trade", 20], ["road", 20]] },
  { name: "a capital", needs: [["house", 20], ["house", 12, 2], ["house", 6, 3], ["keep", 1, 3], ["tower", 4], ["tower", 2, 3], ["plaza", 1, 3], ["well", 1, 3], ["storehouse", 1, 3], ["farm", 8], ["farm", 4, 3], ["lamp", 32], ["lamp", 16, 2], ["trade", 30], ["road", 28, 2]] },
];

const LABEL: Record<Kind | "trade", [string, string]> = {
  house: ["a house", "houses"], farm: ["a farm", "farms"], well: ["a well", "wells"], lamp: ["a lamp post", "lamp posts"],
  storehouse: ["a storehouse", "storehouses"], hall: ["a town hall", "town halls"], tower: ["a watchtower", "watchtowers"],
  market: ["a market", "markets"], wall: ["the wall round the base", "walls"], trade: ["a trade with a villager", "trades with villagers"],
  plaza: ["the plaza", "plazas"], keep: ["the keep", "keeps"], road: ["a building joined by a path", "buildings joined by paths"],
};
export const label = (k: Kind | "trade", n = 1) => (n === 1 ? LABEL[k][0] : LABEL[k][1]);
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
const exact = (id: number) => String(id);
const optional = (id: number) => `?${id}`;

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
}

/** The side of a rectangle that faces a point (the town's middle): 0 north, 1 east, 2 south, 3 west. */
export function faceToward(r: Rect, cx: number, cz: number): number {
  const dx = cx - (r.x0 + r.x1) / 2;
  const dz = cz - (r.z0 + r.z1) / 2;
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 1 : 3;
  return dz > 0 ? 2 : 0;
}
/** The rectangle a kind takes with its front facing `face` (a 9 by 11 building turned east is 11 by 9). */
export function sizeFacing(kind: Exclude<Kind, "farm" | "road">, face: number): [number, number] {
  const [w, d] = KINDS[kind].size;
  return face % 2 ? [d, w] : [w, d];
}

// ---------------------------------------------------------------- the blueprints

/** A material per tier: [tier 1, tier 2, tier 3]. Every cell of a part is that one block (0: the part is left open). */
type Mat = [number, number, number];
const all3 = (id: number): Mat => [id, id, id];
/** A position along a building's front (u, from its left wall) or into it (v, from its front wall): a number counts
 *  from that wall (a negative one from the far wall: -1 is the far wall itself, -2 the cell inside it), "mid" is the
 *  middle ("mid-1", "mid+1" beside it), and "out" (v only) is the step outside the front wall. */
type Pos = number | string;

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
type Part =
  | "footing" | "floor" | "base" | "wall" | "post" | "plate" | "gable" | "roof" | "ridge" | "window" | "chimney" | "light"
  | "rim" | "parapet" | "basin" | "corner" | "battlement" | "paving" | "border" | "counter" | "board" | "divider";

/** A building's design as data: its footprint, its rooms, the material of every part at every tier, its windows,
 *  doors and furniture. The shape (how the parts go together: a gabled cottage, market stalls, a tower...) is drawn
 *  by one function per shape below; everything that's a choice is here, to read and to tweak. */
export interface Blueprint {
  /** What it is, for the AIs and the site. */
  what: string;
  shape: "cottage" | "stalls" | "well" | "lamp" | "tower" | "keep" | "plaza";
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
  /** What each tier adds, in words (index 1 to 3). */
  tiers: string[];
}

const COB = B.COBBLESTONE;
const SBR = B.STONE_BRICKS;
const PL = B.OAK_PLANKS;
const LOG = B.OAK_LOG;
const FEN = B.OAK_FENCE;
const PANE = B.GLASS_PANE;
/** A row of the same furniture along v (a long table, benches). */
const along = (u: Pos, dy: number, v0: number, v1: number, f: Omit<Furniture, "at">): Furniture[] => {
  const out: Furniture[] = [];
  for (let v = v0; v <= v1; v++) out.push({ ...f, at: [u, dy, v] });
  return out;
};

export const BLUEPRINTS: Record<Plain, Blueprint> = {
  house: {
    what: "a cottage like the villages' houses: one room 5 by 6 and 3 high inside, open up to the roof, with a door, windows on every side, a plank floor, a crafting table, a chest and a furnace (a bed from tier 2)",
    shape: "cottage", core: [7, 8], eaves: 1, walls: 3, baseCourses: 1,
    rooms: "one room, 5 by 6 inside, 3 high and open up to the roof",
    parts: {
      // a cobblestone stair roof at tier 1, oak from tier 2: the 80 oak stairs of the roof were half the wood of a
      // cottage (about 30 of its 60 logs), and with the oak near the town cut down, season 10's second cottage took
      // the two of them over an hour; cobblestone comes out of every staircase they dig
      gable: all3(PL), roof: [B.COBBLE_STAIRS, B.OAK_STAIRS, B.OAK_STAIRS], ridge: all3(PL), window: [FEN, PANE, PANE], chimney: all3(COB), light: all3(B.TORCH),
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
      { block: B.LANTERN + 1, at: ["mid", 0, 3], hang: true, tier: 3 },
      { block: FEN, at: ["mid-1", 0, "out"], tier: 3 },
      { block: B.LANTERN, at: ["mid-1", 1, "out"], tier: 3 },
      { block: FEN, at: ["mid+1", 0, "out"], tier: 3 },
      { block: B.LANTERN, at: ["mid+1", 1, "out"], tier: 3 },
      { block: B.BOOKSHELF, at: [1, 0, 3], tier: 3, optional: true },
    ],
    tiers: ["", "the cottage: fence bars in the windows, a crafting table, a chest and a furnace inside", "stone brick base course, an oak roof, glass windows, a chimney, a bed, a second chest and a barrel", "a lantern hanging from the roof, lanterns on posts by the door"],
  },
  storehouse: {
    what: "a stone storehouse with double doors: one long room 6 by 7 inside with chests along the walls for the pack's shared supplies",
    shape: "cottage", core: [8, 9], eaves: 1, walls: 3, baseCourses: 1,
    rooms: "one long room, 6 by 7 inside, 3 high",
    parts: {
      footing: all3(COB), floor: all3(PL), base: [COB, SBR, SBR], wall: all3(COB), post: all3(LOG), plate: all3(LOG),
      gable: all3(PL), roof: all3(B.OAK_STAIRS), ridge: all3(PL), window: [FEN, PANE, PANE], light: all3(B.TORCH),
    },
    windows: [[0, 1, 2], [0, 1, 4], [0, 1, -3], [-1, 1, 2], [-1, 1, 4], [-1, 1, -3]],
    doors: ["mid", "mid+1"],
    furniture: [
      { block: B.TORCH, at: [1, 0, 1], tier: 1 },
      { block: B.TORCH, at: [-2, 0, 1], tier: 1 },
      { block: B.CHEST, at: [1, 0, -2], facing: "right", tier: 1 },
      { block: B.CHEST, at: [-2, 0, -2], facing: "left", tier: 1 },
      { block: B.CHEST, at: [1, 0, -3], facing: "right", tier: 2 },
      { block: B.CHEST, at: [-2, 0, -3], facing: "left", tier: 2 },
      { block: B.BARREL, at: [2, 0, -2], tier: 2 },
      { block: B.BARREL, at: [3, 0, -2], tier: 2 },
      { block: B.BARREL, at: [-4, 0, -2], tier: 2 },
      { block: B.BARREL, at: [-3, 0, -2], tier: 2 },
      { block: B.LANTERN + 1, at: ["mid", 0, 2], hang: true, tier: 3 },
      { block: B.LANTERN + 1, at: ["mid", 0, -3], hang: true, tier: 3 },
      { block: B.HAY_BALE, at: [1, 0, -4], tier: 3, optional: true },
      { block: B.HAY_BALE, at: [-2, 0, -4], tier: 3, optional: true },
    ],
    tiers: ["", "cobblestone walls, a plank roof, two chests", "stone brick base course, glass windows, two more chests and barrels", "lanterns hanging from the roof, hay bales"],
  },
  hall: {
    what: "the town hall: the biggest building, one open hall 7 by 9 and 4 high inside, a two-course stone base, log posts, tall windows, a high roof, a long table with benches",
    shape: "cottage", core: [9, 11], eaves: 1, walls: 4, baseCourses: 2,
    rooms: "one open hall, 7 by 9 inside, 4 high and open up to the roof",
    parts: {
      footing: all3(COB), floor: all3(PL), base: [COB, SBR, SBR], wall: all3(PL), post: all3(LOG), plate: all3(LOG),
      gable: all3(PL), roof: all3(B.OAK_STAIRS), ridge: all3(PL), window: [FEN, PANE, PANE], light: all3(B.TORCH),
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
      ...along("mid", 0, 3, 7, { block: B.OAK_SLAB + 1, tier: 2 }),
      ...along("mid-1", 0, 3, 7, { block: B.OAK_STAIRS, facing: "left", tier: 2 }),
      ...along("mid+1", 0, 3, 7, { block: B.OAK_STAIRS, facing: "right", tier: 2 }),
      { block: B.LANTERN + 1, at: ["mid", 0, 3], hang: true, tier: 3 },
      { block: B.LANTERN + 1, at: ["mid", 0, -4], hang: true, tier: 3 },
      { block: FEN, at: ["mid-1", 0, "out"], tier: 3 },
      { block: B.LANTERN, at: ["mid-1", 1, "out"], tier: 3 },
      { block: FEN, at: ["mid+1", 0, "out"], tier: 3 },
      { block: B.LANTERN, at: ["mid+1", 1, "out"], tier: 3 },
      { block: B.BOOKSHELF, at: [1, 0, -3], tier: 3, optional: true },
      { block: B.BOOKSHELF, at: [-2, 0, -3], tier: 3, optional: true },
    ],
    tiers: ["", "the hall (fence bars in the tall windows)", "stone brick base, glass windows, a long table and benches", "lanterns hanging from the roof and by the door, bookshelves"],
  },
  market: {
    what: "a market: two stalls under one gable roof, oak counters at the front, room behind them for the traders' chests",
    shape: "stalls", core: [9, 5], eaves: 1, walls: 3,
    rooms: "two stalls, 3 by 3 behind their counters",
    parts: {
      floor: [COB, COB, COB], border: [COB, SBR, SBR], post: all3(LOG), plate: all3(LOG), counter: all3(B.OAK_SLAB + 1), board: all3(PL),
      divider: all3(FEN), roof: all3(B.OAK_STAIRS), ridge: all3(PL), gable: all3(PL), light: all3(B.TORCH),
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
    ],
    tiers: ["", "the stalls, counters and roof on a cobblestone floor", "a stone brick border, chests and barrels behind the counters", "lanterns hanging over the stalls, a crafting table, hay"],
  },
  well: {
    what: "a stone well: a cobblestone rim and parapet, fence posts and a little gable roof, the middle of the town",
    shape: "well", core: [5, 5], eaves: 0, walls: 3,
    rooms: "a basin 3 by 3, one deep",
    parts: { rim: [COB, SBR, SBR], parapet: [B.COBBLE_WALL, B.STONE_BRICK_WALL, B.STONE_BRICK_WALL], post: all3(FEN), roof: all3(B.OAK_STAIRS), ridge: all3(PL), gable: all3(PL), basin: all3(COB) },
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
    furniture: [{ block: B.TORCH, at: [1, 0, 1], tier: 1 }],
    tiers: ["", "the tower", "stone brick corners and battlements, glass in the slits", "lanterns on the battlements"],
  },
  keep: {
    what: "the keep: a stone castle tower, walls six high round a hall 7 by 7, a ladder to a roof with battlements and corner turrets",
    shape: "keep", core: [9, 9], eaves: 0, walls: 6, baseCourses: 2,
    rooms: "one hall, 7 by 7 inside, 6 high, a ladder to the roof",
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
      { block: B.LANTERN + 1, at: ["mid", 0, "mid"], hang: true, tier: 3 },
    ],
    tiers: ["", "the keep in cobblestone", "stone brick base course and corners, glass in the slits, a plank floor, a chest and a crafting table", "lanterns on the turrets and hanging inside"],
  },
  plaza: {
    what: "the town plaza: a paved square with lamp posts at its corners, where the town meets",
    shape: "plaza", core: [9, 9], eaves: 0, walls: 0,
    rooms: "an open square 9 by 9",
    parts: { paving: all3(COB), border: [COB, SBR, SBR], footing: [LOG, SBR, SBR], post: [LOG, FEN, FEN], light: [B.TORCH, B.LANTERN, B.LANTERN] },
    furniture: [
      ...[-1, 0, 1].flatMap((k): Furniture[] => [
        { block: B.OAK_STAIRS, at: [`mid${k ? (k > 0 ? "+1" : "-1") : ""}`, 0, 0], facing: "out", tier: 2 },
        { block: B.OAK_STAIRS, at: [`mid${k ? (k > 0 ? "+1" : "-1") : ""}`, 0, -1], facing: "in", tier: 2 },
        { block: B.OAK_STAIRS, at: [0, 0, `mid${k ? (k > 0 ? "+1" : "-1") : ""}`], facing: "left", tier: 2 },
        { block: B.OAK_STAIRS, at: [-1, 0, `mid${k ? (k > 0 ? "+1" : "-1") : ""}`], facing: "right", tier: 2 },
      ]),
      ...[[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]].map(([du, dv]): Furniture => ({ block: B.STONE_BRICK_SLAB, at: [`mid${du ? (du > 0 ? "+1" : "-1") : ""}`, 0, `mid${dv ? (dv > 0 ? "+1" : "-1") : ""}`], tier: 3 })),
      { block: SBR, at: ["mid", 0, "mid"], tier: 3 },
      { block: B.STONE_BRICK_WALL, at: ["mid", 1, "mid"], tier: 3 },
      { block: B.STONE_BRICK_WALL, at: ["mid", 2, "mid"], tier: 3 },
      { block: B.LANTERN, at: ["mid", 3, "mid"], tier: 3 },
    ],
    tiers: ["", "cobblestone paving and corner torch posts", "a stone brick border, benches facing the middle, lantern posts", "a stone brick monument with a lantern in the middle"],
  },
};

/** What each kind is for the AIs and the site, from its blueprint (the wall round the base is a line, not a lot).
 *  size: the rectangle a new one takes, its front along the first number; blocks: how many each tier takes. */
export const KINDS: Record<Exclude<Kind, "farm" | "road">, { size: [number, number]; tiers: number; what: string; up: string[]; blocks: number[] }> = {
  ...(Object.fromEntries(
    (Object.keys(BLUEPRINTS) as Plain[]).map((k) => {
      const bp = BLUEPRINTS[k];
      return [k, { size: [bp.core[0] + 2 * bp.eaves, bp.core[1] + 2 * bp.eaves], tiers: bp.tiers.length - 1, what: bp.what, up: bp.tiers, blocks: [] as number[] }];
    }),
  ) as Record<Plain, { size: [number, number]; tiers: number; what: string; up: string[]; blocks: number[] }>),
  wall: {
    size: [27, 27], tiers: 3, blocks: [],
    what: "a wall all the way round the base with four gates (built a stretch at a time)",
    up: ["", "a cobblestone wall two high, log gateposts with torches", "a third course of battlements and fence gates in the gateways", "stone brick gate pillars with lanterns"],
  },
};

type Cell = { k: string; late: boolean };
/** Building a plan in a building's own frame: u along its front (left to right seen from the street), v from the
 *  front wall in, dy up from the floor (dy -1 is the ground course: the footing and the floor). */
class Draft {
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
function furnish(d: Draft): void {
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
  const roofDy = (u: number) => (u < 0 || u >= W ? H : H + 1 + Math.min(u, W - 1 - u));
  d.ceiling = (u) => roofDy(u);
  const posts = (bp.posts ?? []).map(([u, v]) => [d.u(u), d.v(v)]);
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++) {
      d.foot(u, v);
      const edge = d.edge(u, v);
      d.put(u, -1, v, edge ? d.mat("footing") : d.mat("floor"));
      for (let dy = 0; dy < H; dy++) {
        if (!edge) d.put(u, dy, v, "a");
        else if (d.corner(u, v) || posts.some(([pu, pv]) => pu === u && pv === v)) d.put(u, dy, v, d.mat("post"));
        else d.put(u, dy, v, dy < (bp.baseCourses ?? 0) ? d.mat("base") : d.mat("wall"));
      }
    }
  // the plate: a log beam along the top of the two eaves walls, which the roof's first row rests on
  for (let v = 0; v < D; v++) for (const u of [0, W - 1]) d.put(u, H, v, d.mat("plate"));
  // the gables, up to the roof
  for (const v of [0, D - 1]) for (let u = 1; u < W - 1; u++) for (let dy = H; dy < roofDy(u); dy++) d.put(u, dy, v, d.mat("gable"));
  // the roof, eaves and all (an even width: a ridge two blocks wide)
  const two = W % 2 === 0;
  for (let v = -d.m; v < D + d.m; v++)
    for (let u = -d.m; u < W + d.m; u++) {
      const top = two ? u === W / 2 - 1 || u === W / 2 : u === mid;
      d.put(u, roofDy(u), v, top ? d.mat("ridge") : d.mat("roof") + (u < W / 2 ? d.RIGHT : d.LEFT));
    }
  if (bp.chimney && t >= bp.chimney.tier) {
    const cu = d.u(bp.chimney.u);
    for (let dy = H; dy <= roofDy(cu) + 2; dy++) d.put(cu, dy, D - 1, d.mat("chimney"));
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
function battlements(d: Draft, dy: number, block: number): void {
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

const SHAPES: Record<Blueprint["shape"], (d: Draft) => void> = { cottage, stalls, well, lamp, tower, keep, plaza };

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
  const bp = BLUEPRINTS[s.kind as Plain];
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
  const bp = BLUEPRINTS[b.kind as Plain];
  if (!bp || bp.shape !== "cottage") return null;
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
  const bp = BLUEPRINTS[b.kind as Plain];
  if (!bp || b.kind === "lamp" || b.kind === "well" || b.kind === "plaza") return null;
  const d = new Draft(b, 1, bp);
  return d.at(d.mid, -1);
}

// ---------------------------------------------------------------- blueprints and bills of materials (for planning)

/** A building's blueprint at a tier: on flat ground, its front to the north, every cell relative to the north-west
 *  corner of its rectangle (dx, dy up from the floor, dz) with what goes there (a cell kind, see cellTarget). What a
 *  town planner lays out and costs; the same plan planFor turns to face the town and fits to the ground. */
export function blueprint(kind: Plain, tier: number): { size: [number, number]; cells: PlanCell[] } {
  const [w, d] = KINDS[kind].size;
  const s: Site = { kind, x0: 0, z0: 0, x1: w - 1, z1: d - 1, y: 0, face: 0 };
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
export function materialsFor(kind: Plain | "wall", tier: number, from = 0): Map<number, number> {
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

// how many blocks each tier takes (for the AIs: what a build or an upgrade costs), on flat ground
for (const k of Object.keys(BLUEPRINTS) as Plain[]) {
  const [w, dd] = KINDS[k].size;
  const s: Site = { kind: k, x0: 100, z0: 100, x1: 100 + w - 1, z1: 100 + dd - 1, y: 60 };
  KINDS[k].blocks = [0];
  for (let t = 1; t <= KINDS[k].tiers; t++) KINDS[k].blocks.push(planFor(s, t, () => 59).filter((c) => cellTarget(c[3])).length);
}
{
  const flat = () => 59;
  KINDS.wall.blocks = [0, 1, 2, 3].map((t) => (t ? wallPlan(200, 200, 13, flat, t).length : 0));
}
