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
}

/** What each kind is, for the AIs and the site. size: the rectangle a new one takes (its front along the first number),
 *  eaves and all; tiers: how far it can be upgraded; up[t]: what tier t adds. */
export const KINDS: Record<Exclude<Kind, "farm" | "road">, { size: [number, number]; tiers: number; what: string; up: string[]; blocks: number[] }> = {
  house: {
    size: [9, 9], tiers: 3, blocks: [],
    what: "a cottage like the villages' houses: a stone footing and base course, oak log corners, plank walls, a gable roof of oak stairs with eaves, a door, windows, a plank floor and torches inside (room for a bed and chests)",
    up: ["", "the cottage itself (fence bars in the windows)", "stone brick base course, glass windows, a chimney, a chest and a crafting table inside", "a fireplace furnace, a lantern under the roof and lanterns on posts by the door"],
  },
  well: {
    size: [5, 5], tiers: 3, blocks: [],
    what: "a stone well: a cobblestone rim, fence posts and a little gable roof, the middle of the town",
    up: ["", "the well, its basin dug but dry", "stone brick rim and water in the basin (a water_bucket)", "a lantern hanging under the roof"],
  },
  lamp: {
    size: [1, 1], tiers: 2, blocks: [],
    what: "a lamp post (monsters don't spawn in the light)",
    up: ["", "a log post with a torch on top", "a village lamp: stone brick foot, fence post and a lantern"],
  },
  storehouse: {
    size: [10, 11], tiers: 3, blocks: [],
    what: "a stone storehouse with double doors and chests along the walls for the pack's shared supplies",
    up: ["", "cobblestone walls, a plank roof, two chests", "stone brick base course, glass windows, two more chests and barrels", "lanterns and hay bales"],
  },
  market: {
    size: [11, 7], tiers: 3, blocks: [],
    what: "a market: two stalls under one roof, counters at the front, for trading and meeting",
    up: ["", "the stalls, counters and roof", "a stone paved floor, chests and barrels behind the counters", "lanterns, hay bales and a crafting table"],
  },
  hall: {
    size: [11, 13], tiers: 3, blocks: [],
    what: "the town hall: the biggest building, a two-course stone base, log posts, tall windows, a high roof, a long table inside",
    up: ["", "the hall (fence bars in the windows)", "stone brick base, glass windows, a long table and benches", "lanterns hanging from the roof and lanterns by the door"],
  },
  tower: {
    size: [5, 5], tiers: 3, blocks: [],
    what: "a stone watchtower: a door, a ladder up inside, a lookout floor with battlements and torches, seen from far away",
    up: ["", "the tower", "stone brick corners and battlements, glass in the slits", "lanterns on the battlements"],
  },
  wall: {
    size: [27, 27], tiers: 3, blocks: [],
    what: "a wall all the way round the base with four gates (built a stretch at a time)",
    up: ["", "a cobblestone wall two high, log gateposts", "a third course of battlements and fence gates in the gateways", "stone brick gate pillars with lanterns"],
  },
  plaza: {
    size: [9, 9], tiers: 3, blocks: [],
    what: "the town plaza: a paved square with torch posts at its corners, where the town meets",
    up: ["", "cobblestone paving and corner torch posts", "a stone brick border, benches, lantern posts", "a stone brick monument with a lantern in the middle"],
  },
  keep: {
    size: [9, 9], tiers: 3, blocks: [],
    what: "the keep: a stone castle tower, walls six high, a ladder to a roof with battlements and corner turrets",
    up: ["", "the keep in cobblestone", "stone brick base course and corners, glass in the slits, a plank floor", "lanterns on the turrets and inside"],
  },
};
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
  private FW: number;
  private FD: number;
  readonly s: Site;
  readonly t: number;
  constructor(s: Site, t: number, core: [number, number], margin: number) {
    this.s = s;
    this.t = t;
    const face = s.face ?? 0;
    const rw = s.x1 - s.x0 + 1;
    const rd = s.z1 - s.z0 + 1;
    this.FW = face % 2 ? rd : rw;
    this.FD = face % 2 ? rw : rd;
    // a rectangle of the size this design takes: the design with its eaves; anything else is an old building's
    // rectangle (the old plans were smaller): the same design fitted inside it, walls on its edge, no eaves
    if (this.FW === core[0] + 2 * margin && this.FD === core[1] + 2 * margin) {
      this.W = core[0];
      this.D = core[1];
      this.m = margin;
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
  put(u: number, dy: number, v: number, k: string | number): void {
    if (!this.inside(u, v)) return;
    const [x, z] = this.at(u, v);
    const kk = typeof k === "number" ? exact(k) : k;
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
  get(u: number, dy: number, v: number): string | undefined {
    const [x, z] = this.at(u, v);
    return this.cells.get(`${x},${this.s.y + dy},${z}`)?.k;
  }
  /** Stone of this tier: cobblestone, stone bricks from tier 2. */
  stone(from = 2) {
    return this.t >= from ? B.STONE_BRICKS : B.COBBLESTONE;
  }
  edge(u: number, v: number) {
    return u === 0 || v === 0 || u === this.W - 1 || v === this.D - 1;
  }
  corner(u: number, v: number) {
    return (u === 0 || u === this.W - 1) && (v === 0 || v === this.D - 1);
  }
}

/** A gabled building in the village style (shared/villages.ts buildHouse): walls `H` high on a cobblestone footing,
 *  the lowest `base` courses in stone, the rest `wall`, oak log posts at the corners (and at `posts` along the
 *  walls) with a log plate on top of the eaves walls, a gable roof of `roof` stairs with a `ridge`, eaves all round,
 *  plank gables. Windows (fence bars, glass from tier 2) at `wins`, a door in the middle of the front (two with
 *  `double`), a plank floor and the inside kept clear. The ridge runs front to back. */
function gabled(d: Draft, o: { H: number; base: number; wall: number; roof: number; ridge: number; wins: [number, number, number][]; posts?: [number, number][]; double?: boolean; gableWin?: number }): { roofDy: (u: number) => number } {
  const { W, D, t } = d;
  const mid = d.mid;
  const glaze = t >= 2 ? B.GLASS_PANE : B.OAK_FENCE;
  const roofDy = (u: number) => (u < 0 || u >= W ? o.H : o.H + 1 + Math.min(u, W - 1 - u));
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++) {
      d.foot(u, v);
      const edge = d.edge(u, v);
      d.put(u, -1, v, edge ? B.COBBLESTONE : B.OAK_PLANKS);
      for (let dy = 0; dy < o.H; dy++) {
        if (!edge) d.put(u, dy, v, "a");
        else if (d.corner(u, v) || o.posts?.some(([pu, pv]) => pu === u && pv === v)) d.put(u, dy, v, B.OAK_LOG);
        else d.put(u, dy, v, dy < o.base ? d.stone() : o.wall);
      }
    }
  // the plate: a log beam along the top of the two eaves walls, which the roof's first row rests on
  for (let v = 0; v < D; v++) for (const u of [0, W - 1]) d.put(u, o.H, v, B.OAK_LOG);
  // the gables, plank, up to the roof
  for (const v of [0, D - 1]) for (let u = 1; u < W - 1; u++) for (let dy = o.H; dy < roofDy(u); dy++) d.put(u, dy, v, B.OAK_PLANKS);
  // the roof, eaves and all
  const two = W % 2 === 0; // an even width: a ridge two blocks wide
  for (let v = -d.m; v < D + d.m; v++)
    for (let u = -d.m; u < W + d.m; u++) {
      const top = two ? u === W / 2 - 1 || u === W / 2 : u === mid;
      d.put(u, roofDy(u), v, top ? o.ridge : o.roof + (u < W / 2 ? d.RIGHT : d.LEFT));
    }
  // windows
  for (const [u, dy, v] of o.wins) d.put(u, dy, v, glaze);
  if (o.gableWin !== undefined) {
    d.put(mid, o.gableWin, 0, glaze);
    if (two) d.put(mid + 1, o.gableWin, 0, glaze);
  }
  // the door (or two), the doorway over it, the step in front kept open and a path dug to it
  for (const u of o.double ? [mid, mid + 1] : [mid]) {
    d.put(u, 0, 0, doorId(d.IN, false, false));
    d.put(u, 1, 0, "o");
    d.put(u, 0, -1, "o");
    d.put(u, 1, -1, "o");
    d.put(u, -1, -1, "?p");
    d.foot(u, -1);
  }
  return { roofDy };
}

function house(d: Draft): void {
  const { W, D, t } = d;
  const mid = d.mid;
  const wins: [number, number, number][] = [[1, 1, 0], [W - 2, 1, 0], [mid, 1, D - 1]];
  for (let v = 2; v < D - 1; v += 2) wins.push([0, 1, v], [W - 1, 1, v]);
  const { roofDy } = gabled(d, { H: 3, base: 1, wall: B.OAK_PLANKS, roof: B.OAK_STAIRS, ridge: B.OAK_PLANKS, wins, gableWin: 4 });
  // light: torches in the front corners inside
  d.put(1, 0, 1, B.TORCH);
  d.put(W - 2, 0, 1, B.TORCH);
  const big = W >= 7;
  if (t >= 2) {
    // a cobblestone chimney up the back wall and through the roof; a chest and a crafting table at the back
    const cu = W - 2;
    for (let dy = 3; dy <= roofDy(cu) + 2; dy++) d.put(cu, dy, D - 1, B.COBBLESTONE);
    d.put(1, 0, D - 2, B.CHEST + d.OUT);
    if (big) d.put(2, 0, D - 2, B.CRAFTING_TABLE);
  }
  if (t >= 3) {
    if (big) d.put(W - 2, 0, D - 2, B.FURNACE + d.OUT); // the fireplace, under the chimney
    d.put(mid, roofDy(mid) - 1, Math.floor(D / 2), B.LANTERN + 1);
    if (d.m) for (const u of [mid - 1, mid + 1]) {
      d.put(u, 0, -1, B.OAK_FENCE);
      d.put(u, 1, -1, B.LANTERN);
    }
  }
}

function storehouse(d: Draft): void {
  const { W, D, t } = d;
  const wins: [number, number, number][] = [];
  for (let v = 2; v < D - 1; v += 2) wins.push([0, 1, v], [W - 1, 1, v]);
  // stone walls with a stone brick plinth from tier 2, a plank roof: the village smithy's weight with a barn's roof
  const { roofDy } = gabled(d, { H: 3, base: 1, wall: B.COBBLESTONE, roof: B.OAK_STAIRS, ridge: B.OAK_PLANKS, wins, double: W % 2 === 0 && W >= 6 });
  d.put(1, 0, 1, B.TORCH);
  d.put(W - 2, 0, 1, B.TORCH);
  // chests along the side walls, at the back
  const rows = t >= 2 ? [D - 2, D - 3] : [D - 2];
  for (const v of rows) {
    d.put(1, 0, v, B.CHEST + d.RIGHT);
    d.put(W - 2, 0, v, B.CHEST + d.LEFT);
  }
  if (t >= 2 && W >= 6) for (let u = 2; u < W - 2; u++) d.put(u, 0, D - 2, B.BARREL);
  if (t >= 3) {
    for (const v of [2, D - 4]) d.put(Math.floor(W / 2), roofDy(Math.floor(W / 2)) - 1, v, B.LANTERN + 1);
    if (D >= 7) {
      d.opt(1, 0, D - 4, B.HAY_BALE);
      d.opt(W - 2, 0, D - 4, B.HAY_BALE);
    }
  }
}

function hall(d: Draft): void {
  const { W, D, t } = d;
  const mid = d.mid;
  const H = 4;
  // posts along the long walls every few blocks, framing pairs of tall windows: the timber frame of a great hall
  const posts: [number, number][] = [];
  const pv = D >= 9 ? [Math.floor(D / 2)] : [];
  for (const v of pv) posts.push([0, v], [W - 1, v]);
  const wins: [number, number, number][] = [];
  for (let v = 2; v < D - 2; v++) if (!pv.includes(v) && !pv.includes(v - 1) && !pv.includes(v + 1)) for (const dy of [1, 2]) wins.push([0, dy, v], [W - 1, dy, v]);
  for (const u of [2, W - 3]) if (u !== mid) for (const dy of [1, 2]) wins.push([u, dy, 0], [u, dy, D - 1]);
  for (const dy of [1, 2]) wins.push([mid, dy, D - 1]);
  const { roofDy } = gabled(d, { H, base: 2, wall: B.OAK_PLANKS, roof: B.OAK_STAIRS, ridge: B.OAK_PLANKS, wins, posts, gableWin: H + 1 });
  for (const [u, v] of [[1, 1], [W - 2, 1], [1, D - 2], [W - 2, D - 2]]) d.put(u, 0, v, B.TORCH);
  if (t >= 2 && W >= 7 && D >= 7) {
    // a long table down the middle (oak slabs, top half), benches of stairs either side facing it
    for (let v = 3; v <= D - 4; v++) {
      d.put(mid, 0, v, B.OAK_SLAB + 1);
      d.put(mid - 1, 0, v, B.OAK_STAIRS + d.LEFT);
      d.put(mid + 1, 0, v, B.OAK_STAIRS + d.RIGHT);
    }
  }
  if (t >= 3) {
    for (const v of [Math.floor(D / 3), D - 1 - Math.floor(D / 3)]) d.put(mid, roofDy(mid) - 1, v, B.LANTERN + 1);
    if (d.m) for (const u of [mid - 1, mid + 1]) {
      d.put(u, 0, -1, B.OAK_FENCE);
      d.put(u, 1, -1, B.LANTERN);
    }
  }
}

function market(d: Draft): void {
  const { W, D, t } = d;
  // two (or more) stalls side by side under one gable roof whose ridge runs along the front: log posts, counters of
  // oak slabs at the front, plank boards at the back, fences between the stalls
  const stalls: number[] = [0];
  for (let u = 4; u < W; u += 4) stalls.push(u);
  if (stalls[stalls.length - 1] !== W - 1) stalls.push(W - 1);
  const back = D - 1;
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++) {
      d.foot(u, v);
      d.put(u, -1, v, t >= 2 ? (v === 0 || v === back || u === 0 || u === W - 1 ? B.STONE_BRICKS : B.COBBLESTONE) : B.COBBLESTONE);
      for (let dy = 0; dy < 3; dy++) d.put(u, dy, v, "a");
    }
  for (const u of stalls)
    for (const v of [0, back]) for (let dy = 0; dy < 3; dy++) d.put(u, dy, v, B.OAK_LOG);
  for (let u = 0; u < W; u++) {
    if (stalls.includes(u)) continue;
    d.put(u, 0, 0, B.OAK_SLAB + 1); // the counter
    d.put(u, 0, back, B.OAK_PLANKS);
    d.put(u, 1, back, B.OAK_PLANKS);
  }
  for (const u of stalls.slice(1, -1)) for (let v = 1; v < back; v++) d.put(u, 0, v, B.OAK_FENCE);
  for (const u of [0, W - 1]) for (let v = 1; v < back; v++) d.put(u, 0, v, B.OAK_FENCE);
  // the roof: a gable along the front, eaves over the counters and the back
  const mv = Math.floor(back / 2);
  const roofDy = (v: number) => 3 + Math.min(v + d.m, back + d.m - v);
  for (let v = -d.m; v <= back + d.m; v++)
    for (let u = -d.m; u < W + d.m; u++) d.put(u, roofDy(v), v, v === mv && back % 2 === 0 ? B.OAK_PLANKS : B.OAK_STAIRS + (v <= mv - (back % 2 === 0 ? 1 : 0) ? d.IN : d.OUT));
  // plank gables at the two ends
  for (const u of [0, W - 1]) for (let v = 0; v <= back; v++) for (let dy = 3; dy < roofDy(v); dy++) d.put(u, dy, v, B.OAK_PLANKS);
  // a beam along the top of the posts, front and back, under the roof's first row
  for (let u = 1; u < W - 1; u++) for (const v of [0, back]) if (roofDy(v) > 3) d.put(u, 3, v, B.OAK_LOG);
  for (const u of stalls) d.put(u, 0, 1, B.TORCH);
  if (t >= 2)
    for (let k = 0; k + 1 < stalls.length; k++) {
      const u = stalls[k] + 1;
      d.put(u, 0, back - 1, B.CHEST + d.OUT);
      d.put(u + 1, 0, back - 1, B.BARREL);
    }
  if (t >= 3) {
    for (let k = 0; k + 1 < stalls.length; k++) {
      const c = Math.floor((stalls[k] + stalls[k + 1]) / 2);
      d.put(c, roofDy(mv) - 1, mv, B.LANTERN + 1);
      d.opt(stalls[k + 1] - 1, 0, back - 1, B.HAY_BALE);
    }
    d.put(W - 2, 0, 1, B.CRAFTING_TABLE);
  }
}

function well(d: Draft): void {
  const { W, D, t } = d;
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++) {
      d.foot(u, v);
      const edge = d.edge(u, v);
      if (edge) {
        d.put(u, -1, v, d.stone());
        d.put(u, 0, v, d.corner(u, v) ? d.stone() : t >= 2 ? B.STONE_BRICK_WALL : B.COBBLE_WALL);
      } else {
        // the basin: one deep (anyone can step back out), a cobblestone bottom, water from tier 2
        d.put(u, -2, v, B.COBBLESTONE);
        d.put(u, -1, v, "a");
        d.put(u, 0, v, "a");
      }
    }
  if (t >= 2) d.put(Math.floor(W / 2), -1, Math.floor(D / 2), B.WATER);
  for (const [u, v] of [[0, 0], [W - 1, 0], [0, D - 1], [W - 1, D - 1]]) for (const dy of [1, 2]) d.put(u, dy, v, B.OAK_FENCE);
  // a little gable roof of oak stairs, its ridge along u
  const mv = Math.floor((D - 1) / 2);
  const roofDy = (v: number) => 3 + Math.min(v, D - 1 - v);
  for (let v = 0; v < D; v++) for (let u = 0; u < W; u++) d.put(u, roofDy(v), v, v === mv ? B.OAK_PLANKS : B.OAK_STAIRS + (v < mv ? d.IN : d.OUT));
  if (t >= 3) d.put(Math.floor(W / 2), roofDy(mv) - 1, mv, B.LANTERN + 1);
}

function lamp(d: Draft): void {
  d.foot(0, 0);
  if (d.t >= 2) {
    d.put(0, 0, 0, B.STONE_BRICKS);
    d.put(0, 1, 0, B.OAK_FENCE);
    d.put(0, 2, 0, B.OAK_FENCE);
    d.put(0, 3, 0, B.LANTERN);
  } else {
    d.put(0, 0, 0, B.COBBLESTONE);
    d.put(0, 1, 0, B.OAK_LOG);
    d.put(0, 2, 0, B.OAK_LOG);
    d.put(0, 3, 0, B.TORCH); // a torch needs a solid block under it: on a log, never on a fence
  }
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

function tower(d: Draft): void {
  const { W, D, t } = d;
  const mid = d.mid;
  const H = 7;
  // corners in stone bricks from tier 2 (quoins), the rest cobblestone
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++) {
      d.foot(u, v);
      const edge = d.edge(u, v);
      d.put(u, -1, v, B.COBBLESTONE);
      for (let dy = 0; dy < H; dy++) d.put(u, dy, v, edge ? (d.corner(u, v) ? d.stone() : B.COBBLESTONE) : "a");
      d.put(u, H, v, d.corner(u, v) ? d.stone() : B.COBBLESTONE); // the lookout floor
    }
  // slits up the sides and over the door, glass from tier 2 (none in the back wall: the ladder leans on it)
  for (const [u, v] of [[0, Math.floor(D / 2)], [W - 1, Math.floor(D / 2)]]) for (const dy of [3, 4]) d.put(u, dy, v, t >= 2 ? B.GLASS_PANE : "a");
  for (const dy of [3, 4]) d.put(mid, dy, 0, t >= 2 ? B.GLASS_PANE : "a");
  // the door, and the ladder up the back wall to a hatch in the lookout floor
  d.put(mid, 0, 0, doorId(d.IN, false, false));
  d.put(mid, 1, 0, "o");
  d.put(mid, 0, -1, "o");
  d.put(mid, 1, -1, "o");
  const lv = D > 3 ? D - 2 : 1;
  for (let dy = 0; dy <= H; dy++) d.put(mid, dy, lv, B.LADDER + d.OUT);
  d.put(mid, H + 1, lv, "o");
  battlements(d, H + 1, t >= 2 ? B.STONE_BRICKS : B.COBBLESTONE);
  for (const [u, v] of [[0, 0], [W - 1, 0], [0, D - 1], [W - 1, D - 1]]) d.put(u, H + 2, v, t >= 3 ? B.LANTERN : B.TORCH);
  if (D > 3) d.put(1, 0, 1, B.TORCH);
}

function keep(d: Draft): void {
  const { W, D, t } = d;
  const mid = d.mid;
  const H = 6;
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++) {
      d.foot(u, v);
      const edge = d.edge(u, v);
      d.put(u, -1, v, edge ? B.COBBLESTONE : t >= 2 ? B.OAK_PLANKS : B.COBBLESTONE);
      for (let dy = 0; dy < H; dy++) d.put(u, dy, v, edge ? (d.corner(u, v) || dy < 2 ? d.stone() : B.COBBLESTONE) : "a");
      d.put(u, H, v, B.COBBLESTONE); // the roof
    }
  for (const [u, v] of [[2, 0], [W - 3, 0], [0, 2], [0, D - 3], [W - 1, 2], [W - 1, D - 3], [2, D - 1], [W - 3, D - 1]])
    for (const dy of [2, 3]) d.put(u, dy, v, t >= 2 ? B.GLASS_PANE : "a");
  d.put(mid, 0, 0, doorId(d.IN, false, false));
  d.put(mid, 1, 0, "o");
  d.put(mid, 0, -1, "o");
  d.put(mid, 1, -1, "o");
  for (let dy = 0; dy <= H; dy++) d.put(mid, dy, D - 2, B.LADDER + d.OUT);
  d.put(mid, H + 1, D - 2, "o");
  battlements(d, H + 1, d.stone());
  // corner turrets: two more blocks on each corner
  for (const [u, v] of [[0, 0], [W - 1, 0], [0, D - 1], [W - 1, D - 1]]) {
    d.put(u, H + 2, v, d.stone());
    d.put(u, H + 3, v, t >= 3 ? B.LANTERN : B.TORCH);
  }
  for (const [u, v] of [[1, 1], [W - 2, 1], [1, D - 2], [W - 2, D - 3]]) d.put(u, 0, v, B.TORCH);
  if (t >= 3) d.put(mid, H - 1, Math.floor(D / 2), B.LANTERN + 1);
}

function plaza(d: Draft): void {
  const { W, D, t } = d;
  const cu = Math.floor(W / 2);
  const cv = Math.floor(D / 2);
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++) {
      d.foot(u, v);
      d.put(u, -1, v, t >= 2 && d.edge(u, v) ? B.STONE_BRICKS : B.COBBLESTONE);
      d.put(u, 0, v, "a");
      d.put(u, 1, v, "a");
    }
  // torch posts at the corners (lantern posts from tier 2), a step in from the edge
  for (const [u, v] of [[1, 1], [W - 2, 1], [1, D - 2], [W - 2, D - 2]]) {
    if (t >= 2) {
      d.put(u, 0, v, B.STONE_BRICKS);
      d.put(u, 1, v, B.OAK_FENCE);
      d.put(u, 2, v, B.LANTERN);
    } else {
      d.put(u, 0, v, B.OAK_LOG);
      d.put(u, 1, v, B.OAK_LOG);
      d.put(u, 2, v, B.TORCH);
    }
  }
  if (t >= 2) {
    // benches facing the middle along each side
    for (const du of [-1, 0, 1]) {
      d.put(cu + du, 0, 0, B.OAK_STAIRS + d.OUT);
      d.put(cu + du, 0, D - 1, B.OAK_STAIRS + d.IN);
      d.put(0, 0, cv + du, B.OAK_STAIRS + d.LEFT);
      d.put(W - 1, 0, cv + du, B.OAK_STAIRS + d.RIGHT);
    }
  }
  if (t >= 3) {
    // a monument in the middle: a stone brick plinth in a ring of slabs, a pillar and a lantern on top (water would
    // run all over the paving, so no fountain)
    for (let dv = -1; dv <= 1; dv++) for (let du = -1; du <= 1; du++) if (du || dv) d.put(cu + du, 0, cv + dv, B.STONE_BRICK_SLAB);
    d.put(cu, 0, cv, B.STONE_BRICKS);
    d.put(cu, 1, cv, B.STONE_BRICK_WALL);
    d.put(cu, 2, cv, B.STONE_BRICK_WALL);
    d.put(cu, 3, cv, B.LANTERN);
  }
}

const DESIGNS: Record<Plain, { core: [number, number]; m: number; draw: (d: Draft) => void }> = {
  house: { core: [7, 7], m: 1, draw: house },
  storehouse: { core: [8, 9], m: 1, draw: storehouse },
  hall: { core: [9, 11], m: 1, draw: hall },
  market: { core: [9, 5], m: 1, draw: market },
  well: { core: [5, 5], m: 0, draw: well },
  lamp: { core: [1, 1], m: 0, draw: lamp },
  tower: { core: [5, 5], m: 0, draw: tower },
  keep: { core: [9, 9], m: 0, draw: keep },
  plaza: { core: [9, 9], m: 0, draw: plaza },
};

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
  const ds = DESIGNS[s.kind as Plain];
  if (!ds) return [];
  const top = KINDS[s.kind as Plain].tiers;
  const t = Math.max(1, Math.min(tier, top));
  const d = new Draft(s, t, ds.core, ds.m);
  ds.draw(d);
  // what the later tiers put in the same cells does for this one too (glass where this tier has fence bars, a chest
  // where it keeps the floor clear): an upgraded building still meets every tier under it
  for (let up = t + 1; up <= top; up++) {
    const u = new Draft(s, up, ds.core, ds.m);
    ds.draw(u);
    for (const [key, c] of d.cells) {
      const later = u.cells.get(key);
      const lt = later && cellTarget(later.k);
      if (!lt || later.k === c.k || c.k.split("|").includes(String(lt.id))) continue;
      const own = cellTarget(c.k);
      if (own && accepts(own.id, lt.id)) continue;
      c.k += `|${lt.id}`;
    }
  }
  // the foundation: low ground under the building filled up to its floor, at most three deep
  for (const col of d.found) {
    const [x, z] = col.split(",").map(Number);
    const g = ground(x, z);
    if (g < 0) continue;
    for (let yy = Math.max(g + 1, s.y - 3); yy < s.y; yy++) if (!d.cells.has(`${x},${yy},${z}`)) d.cells.set(`${x},${yy},${z}`, { x, y: yy, z, k: "d", late: false });
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

/** The cell in front of a building's door (outside it), or null for something without a door. */
export function doorStep(b: Building): [number, number] | null {
  const ds = DESIGNS[b.kind as Plain];
  if (!ds || b.kind === "lamp" || b.kind === "well" || b.kind === "plaza") return null;
  const d = new Draft(b, 1, ds.core, ds.m);
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
for (const k of Object.keys(DESIGNS) as Plain[]) {
  const [w, dd] = KINDS[k].size;
  const s: Site = { kind: k, x0: 100, z0: 100, x1: 100 + w - 1, z1: 100 + dd - 1, y: 60 };
  KINDS[k].blocks = [0];
  for (let t = 1; t <= KINDS[k].tiers; t++) KINDS[k].blocks.push(planFor(s, t, () => 59).filter((c) => cellTarget(c[3])).length);
}
{
  const flat = () => 59;
  KINDS.wall.blocks = [0, 1, 2, 3].map((t) => (t ? wallPlan(200, 200, 13, flat, t).length : 0));
}
