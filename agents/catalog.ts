// The catalog: every structure the town can build, as data. The kinds the stages count (house, smithy, barn...) each
// have one or more designs here; a building records which design it is. Homes come from a generator: a district
// style (oak, birch, stone, timber-framed) times a size (a hut to a two-storey manor) times a roof (a gable along the
// house, a gable across it, a flat roof behind a parapet), each furnished per tier. The town's first buildings come in
// every district's style too. The workshops, the farm buildings, the civic buildings, the defences, the water, the
// gardens and the landmarks are designed one by one, on shapes of their own (a silo, a windmill, a quarry pit, a pier,
// a lighthouse, a gatehouse, an arch, statues, pavilions, yards, a bell tower, a temple...). Every part is one
// material; every design is checked by agents/plan-check.ts (built in order, everything placed against something,
// in reach of the scaffolding).
//
// Importing this module fills the registry in agents/civ.ts (BLUEPRINTS, DESIGNS, KINDS) and the words for each kind.

import { B } from "../shared/blocks.ts";
import { doorId } from "../shared/shapes.ts";
import {
  BLUEPRINTS, COB, CST, DESIGNS, Draft, FEN, KINDS, LOG, OST, PANE, PL, SBR, SHAPES, SST, TABLE, all3, along, across, battlements, doorLamps, furnish,
  register, rug, setLabel, stairRing, type Blueprint, type Furniture, type Kind, type Mat, type Pos,
} from "./civ.ts";

const BPL = B.BIRCH_PLANKS;
const BLOG = B.BIRCH_LOG;
const BFEN = B.BIRCH_FENCE;
const BST = B.BIRCH_STAIRS;
const BTABLE = B.BIRCH_SLAB + 1;
const CWALL = B.COBBLE_WALL;
const SWALL = B.STONE_BRICK_WALL;
const SSLAB = B.STONE_BRICK_SLAB;
const CSLAB = B.COBBLE_SLAB;
const GLASS = B.GLASS;
const TORCH = B.TORCH;
const LANTERN = B.LANTERN;
const HANG = B.LANTERN + 1;
const SOIL = B.DIRT;

// ---------------------------------------------------------------- what each kind is, for the board and the plan

/** Where a kind goes in the town: round the square, on the civic streets near it, down the market streets, among
 *  the homes, at the edge, out by the fields, in a park, by the water, beside a street (street furniture), at a gate
 *  of the wall, across a main street (an arch), or on the plaza. */
export type District = "square" | "civic" | "market" | "homes" | "edge" | "fields" | "park" | "shore" | "street" | "gate" | "span" | "plaza";
/** A kind of the catalog: its words, the first stage (an index into STAGES; -1 from the start) at which the board
 *  offers it, its district, and how many the town wants at most (the board stops offering more). */
export interface KindInfo {
  one: string;
  many: string;
  from: number;
  district: District;
  most: number;
}
export const KIND_INFO: Record<Kind, KindInfo> = {};
function kind(k: Kind, one: string, many: string, from: number, district: District, most: number): void {
  KIND_INFO[k] = { one, many, from, district, most };
  setLabel(k, one, many);
}

// ---------------------------------------------------------------- district styles

/** A district's style: the material of every part at each tier. Each district of the town is built in one style
 *  (agents/town.ts gives each street its own), so a street reads as one place. */
export interface Style {
  name: string;
  parts: Record<string, Mat>;
  /** Furniture of this wood: stairs for chairs, a slab for a table, fences for posts. */
  fence: number;
  stair: number;
  table: number;
  /** Timber posts in the walls every few blocks (the timber-framed look). */
  framed?: boolean;
}
export const STYLES: Record<string, Style> = {
  oak: {
    name: "oak", fence: FEN, stair: OST, table: TABLE,
    parts: {
      footing: all3(COB), floor: all3(PL), loft: all3(PL), base: [COB, SBR, SBR], wall: all3(PL), post: all3(LOG), plate: all3(LOG), band: all3(LOG),
      gable: all3(PL), roof: [CST, OST, OST], ridge: all3(PL), window: [FEN, PANE, PANE], chimney: all3(COB), light: all3(TORCH), parapet: [CWALL, SWALL, SWALL],
    },
  },
  birch: {
    name: "birch", fence: BFEN, stair: BST, table: BTABLE,
    parts: {
      footing: all3(COB), floor: all3(BPL), loft: all3(BPL), base: [COB, SBR, SBR], wall: all3(BPL), post: all3(BLOG), plate: all3(BLOG), band: all3(BLOG),
      gable: all3(BPL), roof: [CST, BST, BST], ridge: all3(BPL), window: [BFEN, PANE, PANE], chimney: all3(COB), light: all3(TORCH), parapet: [CWALL, SWALL, SWALL],
    },
  },
  stone: {
    name: "stone", fence: FEN, stair: OST, table: TABLE,
    parts: {
      footing: all3(COB), floor: all3(PL), loft: all3(PL), base: [COB, SBR, SBR], wall: [COB, COB, SBR], post: [LOG, LOG, SBR], plate: [LOG, LOG, SBR], band: [COB, SBR, SBR],
      gable: [COB, COB, SBR], roof: [CST, CST, SST], ridge: [COB, COB, SBR], window: [FEN, PANE, PANE], chimney: all3(COB), light: all3(TORCH), parapet: [CWALL, SWALL, SWALL],
    },
  },
  timber: {
    name: "timber-framed", fence: FEN, stair: OST, table: TABLE, framed: true,
    parts: {
      footing: all3(COB), floor: all3(PL), loft: all3(PL), base: [COB, SBR, SBR], wall: all3(BPL), post: all3(LOG), plate: all3(LOG), band: all3(LOG),
      gable: all3(BPL), roof: [CST, OST, OST], ridge: all3(PL), window: [FEN, PANE, PANE], chimney: all3(COB), light: all3(TORCH), parapet: [CWALL, SWALL, SWALL],
    },
  },
};
const parts = (style: string, over: Record<string, Mat> = {}): Record<string, Mat> => ({ ...STYLES[style].parts, ...over });

// ---------------------------------------------------------------- homes: style x size x roof

interface HomeSize {
  core: [number, number];
  walls: number;
  floors?: number[];
  name: string;
  what: string;
  roofs: string[];
  /** Furniture by tier, given the style's chair, table and fence. Two-storey homes keep the ladder's corner (1, -2)
   *  and the cell in front of it clear. */
  furniture: (st: Style) => Furniture[];
}
const torchesAt = (...at: [Pos, number, Pos][]): Furniture[] => at.map((a) => ({ block: TORCH, at: a, tier: 1 }));
/** The kitchen along the back wall: a crafting table, a chest, a furnace (cells given). */
const kitchen = (table: [Pos, Pos], chest: [Pos, Pos], furnace: [Pos, Pos], furnaceFacing: Furniture["facing"] = "out"): Furniture[] => [
  { block: B.CRAFTING_TABLE, at: [table[0], 0, table[1]], tier: 1 },
  { block: B.CHEST, at: [chest[0], 0, chest[1]], facing: "out", tier: 1 },
  { block: B.FURNACE, at: [furnace[0], 0, furnace[1]], facing: furnaceFacing, tier: 1 },
];
const bed = (u: Pos, dy: number, v: Pos, tier: number): Furniture => ({ block: B.RED_BED, at: [u, dy, v], facing: "in", tier });
const hangMid = (v: Pos = "mid"): Furniture => ({ block: HANG, at: ["mid", 0, v], hang: true, tier: 3 });

const SIZES: Record<string, HomeSize> = {
  hut: {
    core: [5, 6], walls: 3, name: "hut", what: "one small room 3 by 4", roofs: ["gable"],
    furniture: () => [...torchesAt([1, 0, 1], [-2, 0, 1]), ...kitchen([1, -2], [2, -2], [-2, -2]), bed(-2, 0, 2, 2), hangMid(), ...doorLamps(3)],
  },
  cottage: {
    core: [7, 8], walls: 3, name: "cottage", what: "one room 5 by 6, open to the roof", roofs: ["gable", "cross", "flat"],
    furniture: (st) => [
      ...torchesAt([1, 0, 1], [-2, 0, 1]), ...kitchen([1, -2], [2, -2], [-2, -2]),
      bed(-2, 0, 2, 2), { block: B.BARREL, at: [1, 0, -3], tier: 2 }, { block: st.table, at: [2, 0, 4], tier: 2 }, { block: st.stair, at: [1, 0, 4], facing: "left", tier: 2 }, { block: st.stair, at: [2, 0, 5], facing: "in", tier: 2 },
      hangMid(3), { block: B.BOOKSHELF, at: [3, 0, -2], tier: 3, optional: true }, { block: B.FLOWER_POT, at: [2, 1, 4], tier: 3, optional: true }, ...rug("mid", 1, 3, 3), ...doorLamps(3),
    ],
  },
  longhouse: {
    core: [7, 11], walls: 3, name: "longhouse", what: "a long room 5 by 9: the kitchen at the back, two beds down one side, the table by the other", roofs: ["gable"],
    furniture: (st) => [
      ...torchesAt([1, 0, 1], [-2, 0, 1], [1, 0, -2]), ...kitchen([2, -2], [3, -2], [-2, -2]),
      bed(-2, 0, 2, 2), bed(-2, 0, 5, 2), { block: B.BARREL, at: [1, 0, -3], tier: 2 }, { block: st.table, at: [2, 0, 4], tier: 2 }, { block: st.table, at: [2, 0, 5], tier: 2 },
      { block: st.stair, at: [1, 0, 4], facing: "left", tier: 2 }, { block: st.stair, at: [1, 0, 5], facing: "left", tier: 2 },
      hangMid(3), hangMid(-4), { block: B.BOOKSHELF, at: [-3, 0, -2], tier: 3, optional: true }, ...rug("mid", 1, 7, 3), ...doorLamps(3),
    ],
  },
  farmhouse: {
    core: [9, 7], walls: 3, name: "farmhouse", what: "a wide room 7 by 5: the hearth and the kitchen at the back, beds by the right wall", roofs: ["gable", "cross", "flat"],
    furniture: (st) => [
      ...torchesAt([1, 0, 1], [-2, 0, 1]), ...kitchen([1, -2], [2, -2], [-2, -2]),
      bed(-2, 0, 2, 2), bed(-3, 0, 2, 3), { block: B.BARREL, at: [3, 0, -2], tier: 2 }, { block: st.table, at: [2, 0, 3], tier: 2 }, { block: st.stair, at: [1, 0, 3], facing: "left", tier: 2 }, { block: st.stair, at: [3, 0, 3], facing: "right", tier: 2 },
      hangMid(), { block: B.BOOKSHELF, at: [4, 0, -2], tier: 3, optional: true }, { block: B.HAY_BALE, at: [-4, 0, -2], tier: 3, optional: true }, ...rug("mid", 1, 3, 3), ...doorLamps(3),
    ],
  },
  lodge: {
    core: [9, 9], walls: 4, name: "lodge", what: "a tall room 7 by 7: the kitchen and the hearth at the back, beds down the right, a table for six", roofs: ["gable", "cross", "flat"],
    furniture: (st) => [
      ...torchesAt([1, 0, 1], [-2, 0, 1], [1, 0, -3]), ...kitchen([2, -2], [3, -2], [-2, -2]),
      bed(-2, 0, 2, 2), bed(-2, 0, 5, 3), { block: B.BARREL, at: [4, 0, -2], tier: 2 },
      ...along(3, 0, 3, 5, { block: st.table, tier: 2 }), ...along(2, 0, 3, 5, { block: st.stair, facing: "left", tier: 2 }), ...along(4, 0, 3, 5, { block: st.stair, facing: "right", tier: 3 }),
      hangMid(), { block: B.BOOKSHELF, at: [-3, 0, -2], tier: 3, optional: true }, ...rug("mid", 1, 2, 3), ...doorLamps(3),
    ],
  },
  rowhouse: {
    core: [5, 9], walls: 6, floors: [3], name: "row house", what: "two storeys on a narrow front: the kitchen and a bed below, two beds up the ladder", roofs: ["gable"],
    furniture: (st) => [
      ...torchesAt([1, 0, 1], [1, 4, 2]), { block: B.CRAFTING_TABLE, at: [2, 0, -2], tier: 1 }, { block: B.CHEST, at: [3, 0, -2], facing: "out", tier: 1 }, { block: B.FURNACE, at: [3, 0, -3], facing: "left", tier: 1 },
      bed(3, 0, 1, 2), { block: st.table, at: [1, 0, 4], tier: 2 }, { block: st.stair, at: [2, 0, 4], facing: "right", tier: 2 },
      bed(1, 4, 3, 2), bed(3, 4, 3, 3), { block: B.CHEST, at: [3, 4, -2], facing: "out", tier: 2 }, { block: LANTERN, at: [1, 1, 4], tier: 3, optional: true }, ...doorLamps(3),
    ],
  },
  townhouse: {
    core: [7, 7], walls: 6, floors: [3], name: "townhouse", what: "two storeys: the kitchen, the table and a bed below, the bedroom above up a ladder", roofs: ["gable", "cross", "flat"],
    furniture: (st) => [
      ...torchesAt([1, 0, 1], [1, 4, 2]), { block: B.CRAFTING_TABLE, at: [2, 0, -2], tier: 1 }, { block: B.CHEST, at: [3, 0, -2], facing: "out", tier: 1 }, { block: B.FURNACE, at: [-2, 0, -2], facing: "out", tier: 1 },
      bed(-2, 0, 1, 2), { block: B.BARREL, at: [4, 0, -2], tier: 2 }, { block: st.table, at: [3, 0, 3], tier: 2 }, { block: st.stair, at: [2, 0, 3], facing: "left", tier: 2 }, { block: st.stair, at: [4, 0, 3], facing: "right", tier: 2 },
      bed(3, 4, 1, 2), bed(5, 4, 1, 3), { block: B.CHEST, at: [-2, 4, -2], facing: "out", tier: 2 }, { block: LANTERN, at: [3, 1, 3], tier: 3, optional: true }, hangMid(), ...doorLamps(3),
    ],
  },
  manor: {
    core: [11, 9], walls: 6, floors: [3], name: "manor", what: "two storeys: a hall with a long table and the kitchen below, four beds above", roofs: ["gable", "cross", "flat"],
    furniture: (st) => [
      ...torchesAt([1, 0, 1], [8, 0, 1], [1, 4, 2], [-2, 4, 4]), { block: B.CRAFTING_TABLE, at: [2, 0, -2], tier: 1 }, { block: B.CHEST, at: [3, 0, -2], facing: "out", tier: 1 }, { block: B.FURNACE, at: [-2, 0, -2], facing: "out", tier: 1 },
      bed(-2, 0, 1, 2), { block: B.FURNACE, at: [-3, 0, -2], facing: "out", tier: 2 }, { block: B.BARREL, at: [-4, 0, -2], tier: 2 },
      ...along("mid", 0, 3, 5, { block: st.table, tier: 2 }), ...along("mid-1", 0, 3, 5, { block: st.stair, facing: "left", tier: 2 }), ...along("mid+1", 0, 3, 5, { block: st.stair, facing: "right", tier: 3 }),
      bed(3, 4, 1, 2), bed(5, 4, 1, 2), bed(7, 4, 1, 3), bed(9, 4, 1, 3), { block: B.CHEST, at: [-2, 4, -2], facing: "out", tier: 2 },
      { block: B.BOOKSHELF, at: [4, 0, -2], tier: 3, optional: true }, { block: B.BOOKSHELF, at: [5, 0, -2], tier: 3, optional: true }, { block: LANTERN, at: ["mid", 1, 4], tier: 3, optional: true },
      hangMid(), ...rug("mid", 1, 2, 3), ...doorLamps(3),
    ],
  },
};
const ROOFS: Record<string, { ridge: "u" | "v" | "flat"; name: string }> = {
  gable: { ridge: "v", name: "a gable roof" },
  cross: { ridge: "u", name: "a roof across its front" },
  flat: { ridge: "flat", name: "a flat roof behind a parapet" },
};

/** The windows of a home: either side of the door, down both sides and the back, on each floor; never on a post. */
function homeWindows(z: HomeSize, posts: [number, number][]): [Pos, number, Pos][] {
  const [W, D] = z.core;
  const levels = [1, ...(z.floors ?? []).map((f) => f + 2)];
  const out: [Pos, number, Pos][] = [];
  const isPost = (u: number, v: number) => posts.some(([pu, pv]) => pu === u && pv === v);
  for (const dy of levels) {
    for (const u of [1, W - 2]) if (!isPost(u, 0)) out.push([u, dy, 0]);
    for (const v of D >= 9 ? [2, Math.floor(D / 2), D - 3] : [2, D - 3]) for (const u of [0, W - 1]) if (!isPost(u, v)) out.push([u, dy, v]);
    if (!isPost(Math.floor((W - 1) / 2), D - 1)) out.push(["mid", dy, -1]);
  }
  return out;
}

/** A home of a style, a size and a roof. */
function home(style: string, size: string, roof: string): Blueprint {
  const z = SIZES[size];
  const st = STYLES[style];
  const [W, D] = z.core;
  const mid = Math.floor((W - 1) / 2);
  // the timber frame: posts every three blocks along every wall (never in the doorway)
  const posts: [number, number][] = [];
  if (st.framed) {
    for (let u = 2; u < W - 2; u += 3) posts.push([u, 0], [u, D - 1]);
    for (let v = 3; v < D - 2; v += 3) posts.push([0, v], [W - 1, v]);
  }
  const framed = posts.filter(([u, v]) => !(v === 0 && u === mid));
  const flat = roof === "flat";
  return {
    kind: "house",
    what: `a ${st.name} ${z.name} with ${ROOFS[roof].name}: ${z.what}, furnished (a kitchen, a table and chairs, beds)`,
    shape: "cottage", core: z.core, eaves: 1, walls: z.walls, baseCourses: 1, ridge: ROOFS[roof].ridge, floors: z.floors,
    rooms: z.what,
    parts: parts(style),
    posts: framed,
    windows: homeWindows(z, framed),
    doors: ["mid"],
    chimney: flat ? undefined : { tier: 2, u: -2 },
    furniture: z.furniture(st),
    tiers: ["", `the ${z.name}: ${st.name} walls, fence bars in the windows, the kitchen${z.floors ? ", the ladder up to the floor above" : ""}`, "stone brick base course, glass windows, a chimney, a table and chairs, the beds, a barrel", "lanterns, a bookshelf, a flower pot and a rug, lanterns by the door"],
  };
}

/** The homes' sizes from small to big, for the town plan (the big ones near the middle). */
export const HOME_SIZES = Object.keys(SIZES);
for (const style of Object.keys(STYLES))
  for (const [size, z] of Object.entries(SIZES))
    for (const roof of z.roofs) {
      if (roof === "flat" && style !== "stone") continue; // a flat roof behind a parapet is the stone districts' look
      const roofName = roof === "gable" ? "gable" : roof === "cross" ? "cross gable" : "flat roof";
      register(`house/${style}-${size}-${roof}`, home(style, size, roof), { name: `${STYLES[style].name} ${z.name} (${roofName})`, style });
    }

// ---------------------------------------------------------------- the town's first buildings in every style

/** One of the town's first designs in another district's materials: walls, posts, the roof and the gables (the floor,
 *  the footing, the windows and the furniture stay the building's own). */
function restyle(id: string, style: string): Blueprint {
  const bp = BLUEPRINTS[id];
  const st = STYLES[style].parts;
  const p: Record<string, Mat> = { ...(bp.parts as Record<string, Mat>) };
  for (const k of ["wall", "post", "plate", "gable", "roof", "ridge"]) if (p[k] && st[k]) p[k] = st[k];
  return { ...bp, kind: bp.kind ?? id, parts: p, what: `${bp.what} (in ${STYLES[style].name})` };
}
const FIRST_STYLE: Record<string, string> = { storehouse: "stone", hall: "oak", smithy: "stone", bakery: "oak", tavern: "oak", library: "stone", barn: "oak" };
for (const [id, own] of Object.entries(FIRST_STYLE)) {
  DESIGNS[id].style = own;
  for (const style of Object.keys(STYLES)) if (style !== own) register(`${id}/${style}`, restyle(id, style), { name: `${id} (${STYLES[style].name})`, style });
}
for (const id of ["house", "well", "lamp", "tower", "keep", "plaza", "fountain", "monument", "chapel", "cathedral", "market"]) DESIGNS[id].style ??= ["house", "market", "lamp"].includes(id) ? "oak" : "stone";

// ---------------------------------------------------------------- shapes of the catalog's own

/** A hipped roof over the rectangle and its eaves (m out all round): a ring of stairs at height H, the next ring in a
 *  step up, each ring resting on a ring of the `plate` part one in under it (the top beams), the top filled with the
 *  `ridge` part; a `finial` on the very top when the design has one. Sets the roof's underside for hanging lights. */
function hipRoof(d: Draft, H: number, m = d.m): number {
  const { W, D } = d;
  const stair = d.mat("roof");
  const fill = d.mat("plate") || d.mat("ridge");
  let k = 0;
  for (;; k++) {
    const u0 = -m + k, u1 = W - 1 + m - k, v0 = -m + k, v1 = D - 1 + m - k;
    if (u0 > u1 || v0 > v1) break;
    if (u1 - u0 < 2 || v1 - v0 < 2) {
      for (let v = v0; v <= v1; v++) for (let u = u0; u <= u1; u++) d.put(u, H + k, v, d.mat("ridge") || fill);
      k++;
      break;
    }
    stairRing(d, u0, u1, v0, v1, H + k, stair);
    for (let v = v0 + 1; v <= v1 - 1; v++) for (let u = u0 + 1; u <= u1 - 1; u++) if (u === u0 + 1 || u === u1 - 1 || v === v0 + 1 || v === v1 - 1) d.put(u, H + k, v, fill);
  }
  const top = H + k;
  // the underside over a cell: the beam ring it is on, one ring in from the stairs at that height
  d.ceiling = (u, v) => H + Math.max(0, Math.min(u + m, v + m, W - 1 + m - u, D - 1 + m - v) - 1);
  const fin = d.mat("finial");
  if (fin) d.put(d.mid, top, Math.floor((D - 1) / 2), fin);
  return top;
}

/** A round silo: a square with its corners cut, walls `walls` high with a band of the trim every fourth course, a
 *  domed cap (a hipped roof over the eaves), a door; the grain inside. */
function silo(d: Draft): void {
  const { W, D, bp } = d;
  const H = bp.walls;
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++) {
      if (d.corner(u, v)) continue;
      d.foot(u, v);
      const edge = d.edge(u, v);
      d.put(u, -1, v, edge ? d.mat("footing") : d.mat("floor"));
      for (let dy = 0; dy < H; dy++) d.put(u, dy, v, edge ? (dy % 4 === 3 && d.mat("band") ? d.mat("band") : dy < (bp.baseCourses ?? 0) ? d.mat("base") : d.mat("wall")) : "a");
    }
  hipRoof(d, H);
  furnish(d);
}

/** A windmill: a building (the cottage shape) with four sails on its front turning on a hub near the top of the wall:
 *  a spar out each way and the sail beside it, round like a pinwheel. */
function windmill(d: Draft): void {
  SHAPES.cottage(d);
  const hub = d.bp.walls - 1;
  const mu = d.mid;
  const spar = d.mat("spar");
  const sail = d.mat("sail");
  d.put(mu, hub, -1, d.mat("hub"));
  for (let k = 1; k <= 3; k++) {
    d.put(mu, hub + k, -1, spar);
    d.put(mu, hub - k, -1, spar);
    d.put(mu - k, hub, -1, spar);
    d.put(mu + k, hub, -1, spar);
    if (k < 2) continue;
    d.put(mu + 1, hub + k, -1, sail);
    d.put(mu - 1, hub - k, -1, sail);
    d.put(mu + k, hub - 1, -1, sail);
    d.put(mu - k, hub + 1, -1, sail);
  }
}

/** A quarry: a pit dug in terraces a block high (each ring a step down from the one outside it, so it walks in and
 *  out), deeper at every tier; a paved rim with a rail round it, open at the front, posts with lights at the corners,
 *  a paved apron in front. Digging it is the job: the stone comes out for the town. */
function quarry(d: Draft): void {
  const { W, D, bp, t } = d;
  const deep = bp.walls + (t - 1) * 2;
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++) {
      const k = Math.min(u, v, W - 1 - u, D - 1 - v);
      if (k === 0) {
        d.foot(u, v);
        d.put(u, -1, v, d.mat("rim"));
        if (d.corner(u, v)) {
          d.put(u, 0, v, d.mat("post"));
          d.put(u, 1, v, d.mat("light"));
        } else d.put(u, 0, v, v === 0 && u === d.mid ? "a" : d.mat("rail"));
      } else for (let dy = 1; dy >= -Math.min(deep, k); dy--) d.put(u, dy, v, "a");
    }
  for (let u = 0; u < W; u++) {
    d.foot(u, -1);
    d.put(u, -1, -1, d.mat("rim"));
  }
  furnish(d);
}

/** A pier: a plank deck out over the water from the shore, posts under its sides, rails down both sides (open at the
 *  land end), lights on posts at the far end. */
function pier(d: Draft): void {
  const { W, D } = d;
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++) {
      d.foot(u, v);
      d.put(u, -1, v, d.mat("deck"));
      d.put(u, 0, v, "a");
      d.put(u, 1, v, "a");
      if ((u === 0 || u === W - 1) && v % 3 === 2) d.opt(u, -2, v, d.mat("piling"));
    }
  for (let v = 1; v < D - 1; v++) for (const u of [0, W - 1]) d.put(u, 0, v, d.mat("rail"));
  for (const u of [0, W - 1]) {
    d.put(u, 0, D - 1, d.mat("post"));
    d.put(u, 1, D - 1, d.mat("light"));
  }
  furnish(d);
}

/** A lighthouse: a round tower (corners cut) in bands, a ladder up the inside through a gallery that runs round the top
 *  with a rail, the lamp room on it (glass round the beacon, a way out to the gallery), a hipped cap with a light. */
function lighthouse(d: Draft): void {
  const { W, D, bp } = d;
  const H = bp.walls;
  const mu = d.mid;
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++) {
      if (d.corner(u, v)) continue;
      d.foot(u, v);
      const edge = d.edge(u, v);
      d.put(u, -1, v, edge ? d.mat("footing") : d.mat("floor"));
      for (let dy = 0; dy < H; dy++) d.put(u, dy, v, edge ? (Math.floor(dy / 2) % 2 ? d.mat("band") : d.mat("wall")) : "a");
    }
  for (let v = -1; v <= D; v++)
    for (let u = -1; u <= W; u++) {
      d.put(u, H, v, d.mat("gallery"));
      if (u === -1 || v === -1 || u === W || v === D) d.put(u, H + 1, v, d.mat("rail"));
    }
  for (let dy = 0; dy <= H; dy++) d.put(1, dy, D - 2, B.LADDER + d.OUT);
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++) {
      const edge = d.edge(u, v);
      for (const dy of [H + 1, H + 2]) d.put(u, dy, v, !edge ? "a" : d.corner(u, v) ? d.mat("post") : u === mu && v === 0 ? "a" : d.mat("glass"));
    }
  d.put(mu, H + 1, Math.floor((D - 1) / 2), d.mat("beacon"));
  hipRoof(d, H + 3, 0);
  furnish(d);
}

/** A gatehouse over a gate of the wall: two towers either side of an arch the street runs through, a walkway over the
 *  top behind battlements, ladders up inside the towers, slits in their faces, lights on the corners. */
function gatehouse(d: Draft): void {
  const { W, D, bp } = d;
  const H = bp.walls;
  const mu = d.mid;
  const arch = (u: number) => Math.abs(u - mu) <= 1;
  const archH = Math.min(4, H - 2);
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++) {
      d.foot(u, v);
      d.put(u, -1, v, arch(u) ? d.mat("paving") : d.mat("footing"));
      const wall = d.edge(u, v) || Math.abs(u - mu) === 2;
      const corner = (u === 0 || u === W - 1 || Math.abs(u - mu) === 2) && (v === 0 || v === D - 1);
      for (let dy = 0; dy < H; dy++) {
        if (arch(u)) d.put(u, dy, v, dy < archH ? "a" : d.mat("wall"));
        else d.put(u, dy, v, wall ? (corner ? d.mat("corner") : d.mat("wall")) : "a");
      }
      d.put(u, H, v, d.mat("floor"));
    }
  d.ceiling = (u) => (arch(u) ? archH : H);
  for (const u of [mu - 2, mu + 2]) for (const dy of [0, 1]) d.put(u, dy, Math.floor((D - 1) / 2), "a");
  for (const u of [1, W - 2]) {
    for (let dy = 0; dy <= H; dy++) d.put(u, dy, D - 2, B.LADDER + d.OUT);
    d.put(u, H + 1, D - 2, "a");
  }
  for (const u of [2, W - 3]) for (const v of [0, D - 1]) for (const dy of [2, 3]) d.put(u, dy, v, d.mat("window"));
  battlements(d, H + 1, d.mat("battlement"));
  for (const [u, v] of [[0, 0], [W - 1, 0], [0, D - 1], [W - 1, D - 1]]) d.put(u, H + 2, v, d.mat("light"));
  furnish(d);
}

/** An arch across a street: two piers, the lintel over the way (three wide, four high), a cornice along the top, a
 *  light over the middle. */
function archway(d: Draft): void {
  const { W, D, bp } = d;
  const H = bp.walls;
  const mu = d.mid;
  const mv = Math.floor((D - 1) / 2);
  const open = (u: number) => Math.abs(u - mu) <= 1;
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++) {
      d.foot(u, v);
      d.put(u, -1, v, open(u) ? d.mat("paving") : d.mat("footing"));
      for (let dy = 0; dy < H; dy++) d.put(u, dy, v, open(u) && dy < H - 2 ? "a" : dy === H - 1 || (open(u) && dy === H - 2) ? d.mat("band") : d.mat("wall"));
      d.put(u, H, v, u === mu && v === mv ? d.mat("wall") : d.mat("cornice"));
    }
  d.ceiling = (u) => (open(u) ? H - 2 : H);
  d.put(mu, H + 1, mv, d.mat("light"));
  furnish(d);
}

/** A statue: a figure on a plinth (`walls` high over the middle columns, a step either side), the figure's legs,
 *  body, arms and head each a part, something held up in its right hand; lights on the plinth's front. */
function statue(d: Draft): void {
  const { W, D, bp } = d;
  const P = bp.walls;
  const mv = Math.floor((D - 1) / 2);
  const mu = d.mid;
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++) {
      d.foot(u, v);
      d.put(u, -1, v, d.mat("footing"));
      if (u >= 1 && u <= W - 2) for (let dy = 0; dy < P; dy++) d.put(u, dy, v, d.mat("plinth"));
      else d.put(u, 0, v, d.mat("step") ? d.mat("step") + (u === 0 ? d.RIGHT : d.LEFT) : "a");
    }
  for (const u of [mu - 1, mu + 1]) for (const dy of [P, P + 1]) d.put(u, dy, mv, d.mat("legs"));
  for (let u = mu - 1; u <= mu + 1; u++) for (const dy of [P + 2, P + 3]) d.put(u, dy, mv, d.mat("body"));
  for (const u of [mu - 2, mu + 2]) for (const dy of [P + 2, P + 3]) d.put(u, dy, mv, d.mat("arms"));
  d.put(mu, P + 4, mv, d.mat("head"));
  if (d.mat("hat")) d.put(mu, P + 5, mv, d.mat("hat"));
  if (d.mat("tool")) d.put(mu + 2, P + 4, mv, d.mat("tool"));
  furnish(d);
}

/** A bench by a street: a seat of stairs (its back away from the street), a post at each end, a pad under it. */
function bench(d: Draft): void {
  const { W, D } = d;
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++) {
      d.foot(u, v);
      d.put(u, -1, v, d.mat("pad"));
      const end = u === 0 || u === W - 1;
      d.put(u, 0, v, end ? d.mat("post") : d.mat("seat") + d.IN);
      d.put(u, 1, v, end && d.mat("light") ? d.mat("light") : "a");
    }
  furnish(d);
}

/** A flower bed: a kerb round it (a bed one deep, along a street: a kerb at each end), soil inside, flowers in it
 *  (the flower parts in turn). */
function flowerbed(d: Draft): void {
  const { W, D } = d;
  const kinds = ["flower", "flower2", "flower3"].map((p) => d.mat(p)).filter(Boolean);
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++) {
      d.foot(u, v);
      if (D === 1 ? u === 0 || u === W - 1 : d.edge(u, v)) {
        d.put(u, -1, v, d.mat("footing"));
        d.put(u, 0, v, d.mat("kerb"));
      } else {
        d.put(u, -1, v, SOIL);
        d.put(u, 0, v, kinds[(u + v) % kinds.length]);
      }
    }
  furnish(d);
}

/** An open pavilion (a shrine, a gazebo, a market hall): a paved floor, posts at the corners and the blueprint's
 *  posts, a low rail between them (open at the front), a hipped roof over it all with eaves. */
function pavilion(d: Draft): void {
  const { W, D, bp } = d;
  const H = bp.walls;
  const posts = (bp.posts ?? []).map(([u, v]) => [d.u(u), d.v(v)]);
  const isPost = (u: number, v: number) => d.corner(u, v) || posts.some(([pu, pv]) => pu === u && pv === v);
  const gap = W > 5 ? 1 : 0;
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++) {
      d.foot(u, v);
      d.put(u, -1, v, d.edge(u, v) ? d.mat("border") || d.mat("floor") : d.mat("floor"));
      for (let dy = 0; dy < H; dy++) {
        if (isPost(u, v)) d.put(u, dy, v, d.mat("post"));
        else if (dy === 0 && d.edge(u, v) && d.mat("rail") && !(v === 0 && Math.abs(u - d.mid) <= gap)) d.put(u, dy, v, d.mat("rail"));
        else d.put(u, dy, v, "a");
      }
    }
  hipRoof(d, H);
  furnish(d);
}

/** A yard: a fence round it with a gate in the front (or an opening) and posts with lights at the corners (and every
 *  `posts` blocks); inside, what the blueprint lays out: a pond in the middle (water from tier 2) with a kerb, paths
 *  (dug at tier 1, paved from tier 2), a grid of saplings on soil, rows of flowers; the rest is its furniture. */
function yard(d: Draft): void {
  const { W, D, bp } = d;
  const o = bp.opts ?? {};
  const mu = d.mid;
  const mv = Math.floor((D - 1) / 2);
  const from = o.from ?? 2;
  const gu = o.grid ?? 0;
  const gv = o.gridV ?? gu;
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++) {
      if (d.edge(u, v)) {
        d.foot(u, v);
        const along = v === 0 || v === D - 1 ? u : v;
        if (d.corner(u, v) || (o.posts && along % o.posts === 0 && !(v === 0 && Math.abs(u - mu) <= 1))) {
          d.put(u, 0, v, d.mat("post"));
          d.put(u, 1, v, d.mat("light") || "a");
        } else if (v === 0 && u === mu) d.put(u, 0, v, o.open ? "a" : B.OAK_GATE + d.OUT);
        else d.put(u, 0, v, d.mat("fence"));
        continue;
      }
      // (the whole yard on a level pad: low ground under it filled up to its floor, so a sapling or a flower bed
      // never floats over a dip)
      d.foot(u, v);
      const du = Math.abs(u - mu);
      const dv = Math.abs(v - mv);
      if (o.pond && du <= o.pond && dv <= o.pond) {
        d.put(u, -1, v, d.t >= 2 ? B.WATER : "a");
        continue;
      }
      if (o.pond && du <= o.pond + 1 && dv <= o.pond + 1) {
        d.foot(u, v);
        d.put(u, -1, v, d.mat("kerb"));
        continue;
      }
      if ((o.pathU && u === mu) || (o.pathV && v === mv)) {
        d.put(u, -1, v, d.t >= 2 && d.mat("path") ? d.mat("path") : "?p");
        if (o.clear) d.put(u, 0, v, "a");
        continue;
      }
      if (gu && u >= from && v >= from && u <= W - 1 - from && v <= D - 1 - from && (u - from) % gu === 0 && (v - from) % gv === 0) {
        d.put(u, -1, v, SOIL);
        d.put(u, 0, v, d.mat("sapling"));
        continue;
      }
      if (o.flowers && v % 2 === 0 && v >= 2 && v <= D - 3 && u >= 2 && u <= W - 3) {
        const fl = [d.mat("flower"), d.mat("flower2"), d.mat("flower3")].filter(Boolean);
        d.put(u, -1, v, SOIL);
        d.put(u, 0, v, fl[(u + v / 2) % fl.length]);
        continue;
      }
      if (o.clear) d.put(u, 0, v, "a");
    }
  furnish(d);
}

/** A bell tower (a clock tower with a face): a square tower `walls` high, a loft under the belfry up a ladder, open
 *  arches near the top of each side, the clock's face on the front under them, a hipped cap with a light on top. */
function belltower(d: Draft): void {
  const { W, D, bp } = d;
  const H = bp.walls;
  const mu = d.mid;
  const mv = Math.floor((D - 1) / 2);
  const loft = H - 4;
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++) {
      d.foot(u, v);
      const edge = d.edge(u, v);
      d.put(u, -1, v, edge ? d.mat("footing") : d.mat("floor"));
      for (let dy = 0; dy < H; dy++) d.put(u, dy, v, edge ? (d.corner(u, v) ? d.mat("post") : dy < (bp.baseCourses ?? 0) ? d.mat("base") : d.mat("wall")) : dy === loft ? d.mat("loft") : "a");
    }
  for (let dy = 0; dy <= loft; dy++) d.put(1, dy, D - 2, B.LADDER + d.OUT);
  for (const dy of [H - 3, H - 2]) {
    d.put(mu, dy, 0, "a");
    d.put(mu, dy, D - 1, "a");
    d.put(0, dy, mv, "a");
    d.put(W - 1, dy, mv, "a");
  }
  if (d.mat("face")) for (let du = -1; du <= 1; du++) for (let k = 0; k < 3; k++) d.put(mu + du, loft - 3 + k, 0, du === 0 && k === 1 ? d.mat("hands") : d.mat("face"));
  hipRoof(d, H);
  furnish(d);
}

/** A temple: a colonnade across the front (columns either side of a wide middle way) under the front of the roof,
 *  the hall behind its own front wall with the door in the middle; a gable roof along it all, with eaves. */
function temple(d: Draft): void {
  const { W, D, bp } = d;
  const H = bp.walls;
  const P = 3;
  const mid = d.mid;
  const roofAt = (u: number) => (u < 0 || u >= W ? H : H + 1 + Math.min(u, W - 1 - u));
  d.ceiling = (u) => roofAt(u);
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++) {
      d.foot(u, v);
      d.put(u, -1, v, d.edge(u, v) ? d.mat("footing") : d.mat("floor"));
      const hall = v >= P && (u === 0 || u === W - 1 || v === P || v === D - 1);
      const column = v === 0 && u % 2 === 0 && Math.abs(u - mid) >= 2;
      const corner = (u === 0 || u === W - 1) && (v === P || v === D - 1);
      for (let dy = 0; dy < H; dy++) {
        if (column) d.put(u, dy, v, d.mat("column"));
        else if (hall) d.put(u, dy, v, corner ? d.mat("post") : dy < (bp.baseCourses ?? 0) ? d.mat("base") : d.mat("wall"));
        else d.put(u, dy, v, "a");
      }
    }
  for (let u = 0; u < W; u++) d.put(u, H, 0, d.mat("plate"));
  for (let v = 0; v < D; v++) for (const u of [0, W - 1]) d.put(u, H, v, d.mat("plate"));
  for (let u = 1; u < W - 1; u++) {
    for (let dy = H + 1; dy < roofAt(u); dy++) d.put(u, dy, 0, d.mat("gable"));
    for (let dy = H; dy < roofAt(u); dy++) d.put(u, dy, D - 1, d.mat("gable"));
  }
  const two = W % 2 === 0;
  for (let v = -d.m; v < D + d.m; v++)
    for (let u = -d.m; u < W + d.m; u++) {
      const top = two ? u === W / 2 - 1 || u === W / 2 : u === mid;
      d.put(u, roofAt(u), v, top ? d.mat("ridge") : d.mat("roof") + (u < W / 2 ? d.RIGHT : d.LEFT));
    }
  d.put(mid, 0, P, doorId(d.IN, false, false));
  d.put(mid, 1, P, "o");
  furnish(d);
}

Object.assign(SHAPES, { silo, windmill, quarry, pier, lighthouse, gatehouse, archway, statue, bench, flowerbed, pavilion, yard, belltower, temple });

// ---------------------------------------------------------------- the designs

/** A building on the cottage shape: a kind, a style, a size, a roof, its furniture and what each tier adds. */
function building(k: Kind, o: {
  style: string; core: [number, number]; walls?: number; floors?: number[]; ridge?: "u" | "v" | "flat"; what: string; rooms: string; furniture: Furniture[]; tiers: string[];
  doors?: Pos[]; chimney?: { tier: number; u: Pos }; posts?: [Pos, Pos][]; windows?: [Pos, number, Pos][]; over?: Record<string, Mat>; baseCourses?: number; shape?: string;
}): Blueprint {
  const D = o.core[1];
  return {
    kind: k, what: o.what, shape: o.shape ?? "cottage", core: o.core, eaves: 1, walls: o.walls ?? 3, baseCourses: o.baseCourses ?? 1, ridge: o.ridge ?? "v", floors: o.floors,
    rooms: o.rooms, parts: parts(o.style, o.over), posts: o.posts, doors: o.doors ?? ["mid"], chimney: o.chimney,
    windows: o.windows ?? [[1, 1, 0], [-2, 1, 0], [0, 1, 2], [-1, 1, 2], [0, 1, D > 6 ? -3 : 2], [-1, 1, D > 6 ? -3 : 2], ["mid", 1, -1]],
    furniture: o.furniture, tiers: o.tiers,
  };
}
const t3 = (extra: Furniture[] = []): Furniture[] => [hangMid(), ...doorLamps(3), ...extra];
const torches: Furniture[] = [{ block: TORCH, at: [1, 0, 1], tier: 1 }, { block: TORCH, at: [-2, 0, 1], tier: 1 }];
const reg = (id: string, bp: Blueprint, name: string, style?: string) => register(id, bp, { name, style });

// ---- workshops and shops
kind("carpenter", "a carpenter's workshop", "carpenter's workshops", 4, "market", 2);
reg("carpenter", building("carpenter", {
  style: "oak", core: [9, 7], what: "a carpenter's workshop: the saw table, two work benches, a log pile, stacks of planks and the tool chest",
  rooms: "one workshop 7 by 5", chimney: { tier: 2, u: 1 },
  furniture: [...torches, { block: B.CRAFTING_TABLE, at: [1, 0, -2], tier: 1 }, { block: TABLE, at: [2, 0, -2], tier: 1 }, { block: TABLE, at: [3, 0, -2], tier: 1 }, { block: B.CHEST, at: [-2, 0, -2], facing: "out", tier: 1 },
    { block: LOG, at: [-2, 0, 2], tier: 2 }, { block: LOG, at: [-2, 1, 2], tier: 2 }, { block: LOG, at: [-3, 0, 2], tier: 2 }, { block: PL, at: [1, 0, 2], tier: 2 }, { block: PL, at: [1, 1, 2], tier: 2 }, { block: B.BARREL, at: [-3, 0, -2], tier: 2 },
    ...t3([{ block: B.CRAFTING_TABLE, at: [4, 0, -2], tier: 3 }])],
  tiers: ["", "the workshop: a saw table, two benches and the tool chest", "stone brick base, glass windows, a chimney, a log pile and a stack of planks, a barrel", "a second saw table, lanterns"],
}), "carpenter's workshop", "oak");
kind("stoneworks", "a mason's yard", "mason's yards", 4, "market", 2);
reg("stoneworks", building("stoneworks", {
  style: "stone", core: [9, 7], what: "a mason's yard: the cutting table, a furnace, the chisel chest, blocks of stone ready to set, a step and a slab cut",
  rooms: "one workshop 7 by 5", chimney: { tier: 1, u: 1 },
  furniture: [...torches, { block: B.CRAFTING_TABLE, at: [2, 0, -2], tier: 1 }, { block: B.CHEST, at: [-2, 0, -2], facing: "out", tier: 1 }, { block: B.FURNACE, at: [3, 0, -2], facing: "out", tier: 1 },
    { block: COB, at: [-2, 0, 2], tier: 2 }, { block: COB, at: [-2, 1, 2], tier: 2 }, { block: SBR, at: [-3, 0, 2], tier: 2 }, { block: SST, at: [1, 0, 2], facing: "right", tier: 2 }, { block: SSLAB, at: [2, 0, 2], tier: 2 },
    ...t3([{ block: SBR, at: [-3, 1, 2], tier: 3 }])],
  tiers: ["", "the yard in cobblestone: the cutting table, a furnace, the chisel chest", "stone blocks ready to set, a step and a slab cut", "stone brick walls and roof, lanterns"],
}), "mason's yard", "stone");
kind("tannery", "a tannery", "tanneries", 5, "edge", 1);
reg("tannery", building("tannery", {
  style: "timber", core: [9, 7], what: "a tannery: the vats (barrels), drying racks (fences), a crafting table, the hide chest",
  rooms: "one workshop 7 by 5",
  furniture: [...torches, { block: B.BARREL, at: [1, 0, -2], tier: 1 }, { block: B.BARREL, at: [2, 0, -2], tier: 1 }, { block: B.CHEST, at: [-2, 0, -2], facing: "out", tier: 1 },
    ...across(2, 3, 0, 3, { block: FEN, tier: 2 }), { block: B.BARREL, at: [3, 0, -2], tier: 2 }, { block: B.CRAFTING_TABLE, at: [-3, 0, -2], tier: 2 }, ...t3()],
  tiers: ["", "the vats and the hide chest", "drying racks, a third vat, a crafting table", "lanterns"],
}), "tannery", "timber");
kind("pottery", "a pottery", "potteries", 5, "market", 1);
reg("pottery", building("pottery", {
  style: "stone", core: [7, 7], what: "a pottery: two kilns (furnaces) under a chimney, the wheel bench, the clay chest, pots on display",
  rooms: "one workshop 5 by 5", chimney: { tier: 1, u: -2 },
  furniture: [...torches, { block: B.FURNACE, at: [-2, 0, -2], facing: "out", tier: 1 }, { block: B.FURNACE, at: [-3, 0, -2], facing: "out", tier: 1 }, { block: B.CHEST, at: [1, 0, -2], facing: "out", tier: 1 },
    { block: TABLE, at: [1, 0, 3], tier: 2 }, { block: OST, at: [2, 0, 3], facing: "right", tier: 2 }, { block: B.FLOWER_POT, at: [1, 1, 3], tier: 2, optional: true }, { block: B.FLOWER_POT, at: [1, 1, -2], tier: 3, optional: true }, ...t3()],
  tiers: ["", "two kilns under the chimney, the clay chest", "the wheel bench and a pot on it", "stone brick walls, lanterns, pots on display"],
}), "pottery", "stone");
kind("butcher", "a butcher's shop", "butcher's shops", 5, "market", 1);
reg("butcher", building("butcher", {
  style: "oak", core: [7, 8], what: "a butcher's shop: the counter, the smoker (a furnace), the meat chest, barrels of salt meat",
  rooms: "the shop in front of the counter, the cutting room behind",
  furniture: [...torches, ...across(1, 2, 0, 3, { block: TABLE, tier: 1 }), { block: TABLE, at: [-2, 0, 3], tier: 1 }, { block: B.FURNACE, at: [-2, 0, -2], facing: "out", tier: 1 }, { block: B.CHEST, at: [1, 0, -2], facing: "out", tier: 1 },
    { block: B.BARREL, at: [2, 0, -2], tier: 2 }, { block: B.BARREL, at: [1, 0, -3], tier: 2 }, { block: B.HAY_BALE, at: [-2, 0, -3], tier: 2, optional: true }, ...t3()],
  tiers: ["", "the counter, the smoker and the meat chest", "barrels of salt meat, hay", "lanterns"],
}), "butcher's shop", "oak");
kind("weaver", "a weaver's house", "weaver's houses", 5, "market", 1);
reg("weaver", building("weaver", {
  style: "birch", core: [7, 8], what: "a weaver's house: the loom (a crafting table and a fence), bales of wool, a cutting table and a stool, the cloth chest",
  rooms: "one workroom 5 by 6",
  furniture: [...torches, { block: B.CRAFTING_TABLE, at: [1, 0, -2], tier: 1 }, { block: BFEN, at: [2, 0, -2], tier: 1 }, { block: B.CHEST, at: [-2, 0, -2], facing: "out", tier: 1 },
    { block: B.WOOL_WHITE, at: [-2, 0, 2], tier: 2, optional: true }, { block: B.WOOL_WHITE, at: [-2, 1, 2], tier: 2, optional: true }, { block: BTABLE, at: [1, 0, 3], tier: 2 }, { block: BST, at: [2, 0, 3], facing: "right", tier: 2 }, ...t3()],
  tiers: ["", "the loom and the cloth chest", "bales of wool, a cutting table and a stool", "lanterns"],
}), "weaver's house", "birch");
kind("store", "a general store", "general stores", 4, "square", 2);
reg("store", building("store", {
  style: "timber", core: [9, 8], what: "a general store: a long counter, chests and barrels of goods, a crafting table, a pot on the counter",
  rooms: "the shop and a store room behind the counter",
  furniture: [...torches, ...across(1, 2, 0, 3, { block: TABLE, tier: 1 }), ...across(6, 7, 0, 3, { block: TABLE, tier: 1 }), { block: B.CHEST, at: [1, 0, -2], facing: "out", tier: 1 }, { block: B.CHEST, at: [2, 0, -2], facing: "out", tier: 1 },
    { block: B.BARREL, at: [-2, 0, -2], tier: 2 }, { block: B.BARREL, at: [-3, 0, -2], tier: 2 }, { block: B.BARREL, at: [-2, 1, -2], tier: 2 }, { block: B.CRAFTING_TABLE, at: [3, 0, -2], tier: 2 },
    { block: B.FLOWER_POT, at: [1, 1, 3], tier: 3, optional: true }, ...t3()],
  tiers: ["", "the counter and two chests of goods", "barrels stacked on barrels, a crafting table", "lanterns, a pot on the counter"],
}), "general store", "timber");

// ---- farm buildings
kind("stable", "a stable", "stables", 5, "fields", 2);
reg("stable", building("stable", {
  style: "oak", core: [9, 11], walls: 4, what: "a stable: stalls down both sides behind fence rails, hay in the stalls, a barrel of feed, the tack chest",
  rooms: "a long stable, stalls down both sides", posts: [[0, "mid"], [-1, "mid"]],
  windows: [[0, 2, 2], [0, 2, -3], [-1, 2, 2], [-1, 2, -3], [1, 2, 0], [-2, 2, 0]],
  furniture: [...torches, ...[3, 6].flatMap((v): Furniture[] => [...across(1, 2, 0, v, { block: FEN, tier: 1 }), ...across(6, 7, 0, v, { block: FEN, tier: 1 })]),
    { block: B.CHEST, at: ["mid", 0, -2], facing: "out", tier: 1 }, ...[2, 5, 8].flatMap((v): Furniture[] => [{ block: B.HAY_BALE, at: [1, 0, v], tier: 2, optional: true }, { block: B.HAY_BALE, at: [-2, 0, v], tier: 2, optional: true }]),
    { block: B.BARREL, at: [1, 0, -2], tier: 2 }, ...t3()],
  tiers: ["", "the stable: stalls down both sides, the tack chest", "hay in the stalls, a barrel of feed", "lanterns"],
}), "stable", "oak");
kind("coop", "a chicken coop", "chicken coops", 3, "fields", 2);
reg("coop", building("coop", {
  style: "birch", core: [5, 5], what: "a chicken coop: nest boxes (hay), a perch (a fence), the egg chest",
  rooms: "one small room 3 by 3", windows: [[0, 1, 2], [-1, 1, 2]],
  furniture: [{ block: TORCH, at: [1, 0, 1], tier: 1 }, { block: B.HAY_BALE, at: [1, 0, -2], tier: 1, optional: true }, { block: B.CHEST, at: [-2, 0, -2], facing: "out", tier: 1 }, { block: BFEN, at: [-2, 0, 1], tier: 2 }, hangMid()],
  tiers: ["", "the coop and the egg chest", "a perch", "a lantern"],
}), "chicken coop", "birch");
kind("granary", "a granary", "granaries", 4, "fields", 2);
reg("granary", building("granary", {
  style: "timber", core: [7, 9], walls: 4, what: "a granary: bins of grain (barrels) down one wall, sacks of wheat (hay) down the other, the seed chest",
  rooms: "one store room 5 by 7, 4 high", windows: [[0, 3, 2], [-1, 3, 2], [0, 3, -3], [-1, 3, -3]],
  furniture: [...torches, ...along(1, 0, 2, 6, { block: B.BARREL, tier: 1 }), { block: B.CHEST, at: [-2, 0, -2], facing: "out", tier: 1 },
    ...along(-2, 0, 2, 5, { block: B.HAY_BALE, tier: 2, optional: true }), ...along(1, 1, 2, 6, { block: B.BARREL, tier: 3 }), ...t3()],
  tiers: ["", "bins of grain down one wall, the seed chest", "sacks of wheat", "a second row of bins, lanterns"],
}), "granary", "timber");
kind("mill", "a mill", "mills", 5, "fields", 1);
reg("mill", building("mill", {
  style: "stone", core: [9, 9], walls: 4, what: "a mill: the millstone (a ring of slabs round a stone block), the hopper (hay), sacks of flour (barrels), the flour chest",
  rooms: "the mill room 7 by 7", chimney: { tier: 2, u: 1 },
  furniture: [...torches, { block: SBR, at: ["mid", 0, "mid"], tier: 1 }, ...([["mid-1", "mid"], ["mid+1", "mid"], ["mid", "mid-1"], ["mid", "mid+1"]] as [Pos, Pos][]).map(([u, v]): Furniture => ({ block: SSLAB, at: [u, 0, v], tier: 1 })),
    { block: B.CHEST, at: [1, 0, -2], facing: "out", tier: 1 }, { block: B.HAY_BALE, at: ["mid", 1, "mid"], tier: 2, optional: true }, { block: B.BARREL, at: [-2, 0, -2], tier: 2 }, { block: B.BARREL, at: [-3, 0, -2], tier: 2 }, ...t3()],
  tiers: ["", "the millstone and the flour chest", "the hopper, sacks of flour", "lanterns"],
}), "mill", "stone");
kind("greenhouse", "a greenhouse", "greenhouses", 6, "fields", 1);
reg("greenhouse", {
  kind: "greenhouse", what: "a greenhouse: glass walls and a glass roof on a log frame, beds of saplings and flowers inside",
  shape: "cottage", core: [9, 9], eaves: 1, walls: 4, baseCourses: 1, ridge: "flat",
  rooms: "one glass room 7 by 7",
  parts: { footing: all3(COB), floor: all3(SOIL), base: all3(COB), wall: all3(GLASS), post: all3(LOG), plate: all3(LOG), ridge: all3(GLASS), parapet: all3(FEN), light: all3(TORCH) },
  doors: ["mid"],
  furniture: [...[2, 4, 6].flatMap((v): Furniture[] => [{ block: B.OAK_SAPLING, at: [2, 0, v], tier: 1, optional: true }, { block: B.BIRCH_SAPLING, at: [-3, 0, v], tier: 1, optional: true }]),
    ...[3, 5].flatMap((v): Furniture[] => [{ block: B.POPPY, at: [1, 0, v], tier: 2, optional: true }, { block: B.DANDELION, at: [-2, 0, v], tier: 2, optional: true }]), { block: TORCH, at: [1, 0, 1], tier: 1 }, hangMid()],
  tiers: ["", "the glass house on its frame, saplings in the beds", "flowers along the walls", "a lantern"],
}, "greenhouse");
kind("silo", "a silo", "silos", 5, "fields", 3);
const SILO: Blueprint = {
  kind: "silo", what: "a round stone silo: a domed cap, a band of logs every fourth course, the grain inside (hay and barrels)",
  shape: "silo", core: [5, 5], eaves: 1, walls: 8, baseCourses: 1, rooms: "one round room 3 by 3, 8 high",
  parts: { footing: all3(COB), floor: all3(COB), base: [COB, SBR, SBR], wall: [COB, COB, SBR], band: all3(LOG), roof: [CST, SST, SST], plate: [COB, SBR, SBR], ridge: [COB, SBR, SBR], finial: [TORCH, TORCH, LANTERN] },
  doors: ["mid"], windows: [[0, 5, "mid"], [-1, 5, "mid"]],
  furniture: [{ block: TORCH, at: [1, 0, 1], tier: 1 }, { block: B.CHEST, at: [-2, 0, -2], facing: "out", tier: 1 }, { block: B.HAY_BALE, at: [1, 0, -2], tier: 2, optional: true }, { block: B.HAY_BALE, at: [1, 1, -2], tier: 2, optional: true }, { block: B.BARREL, at: [-2, 0, 2], tier: 2 }],
  tiers: ["", "the silo in cobblestone, its dome, the grain chest", "stone brick base and dome, a barrel of grain, hay", "stone brick walls, a lantern on the top"],
};
reg("silo", SILO, "stone silo", "stone");
reg("silo/timber", {
  ...SILO, what: "a round wooden silo: birch walls with log bands, a domed oak roof, the grain inside",
  parts: { footing: all3(COB), floor: all3(PL), base: all3(COB), wall: all3(BPL), band: all3(LOG), roof: [CST, OST, OST], plate: all3(PL), ridge: all3(PL), finial: [TORCH, TORCH, LANTERN] },
}, "wooden silo", "birch");
kind("windmill", "a windmill", "windmills", 5, "fields", 2);
const WINDMILL = building("windmill", {
  style: "stone", shape: "windmill", core: [7, 7], walls: 8, what: "a windmill: a tall stone mill with four sails turning on the front, the millstone and the flour sacks inside",
  rooms: "the mill room 5 by 5, 8 high", windows: [[0, 2, 2], [-1, 2, 2], [0, 5, -3], [-1, 5, -3], ["mid", 2, -1]],
  over: { spar: all3(LOG), sail: all3(BPL), hub: all3(LOG) },
  furniture: [...torches, { block: SBR, at: ["mid", 0, "mid"], tier: 1 }, { block: SSLAB, at: ["mid-1", 0, "mid"], tier: 1 }, { block: SSLAB, at: ["mid+1", 0, "mid"], tier: 1 }, { block: B.CHEST, at: [1, 0, -2], facing: "out", tier: 1 },
    { block: B.BARREL, at: [-2, 0, -2], tier: 2 }, { block: B.HAY_BALE, at: [-3, 0, -2], tier: 2, optional: true }, ...t3()],
  tiers: ["", "the mill tower, its sails and the millstone", "stone brick base, glass windows, sacks of flour", "stone brick walls, lanterns"],
});
reg("windmill", WINDMILL, "stone windmill", "stone");
reg("windmill/timber", { ...WINDMILL, parts: parts("timber", { spar: all3(LOG), sail: all3(BPL), hub: all3(LOG) }), what: "a timber-framed windmill: four sails on the front, the millstone inside" }, "timber windmill", "timber");

// ---- quarries
kind("quarry", "a quarry", "quarries", 2, "edge", 2);
const QUARRY: Blueprint = {
  kind: "quarry", what: "a quarry: a pit dug in terraces a block high (3 deep, then 5, then 7), a paved rim with a rail round it, lights on the corner posts; digging it brings in the town's stone",
  shape: "quarry", core: [9, 9], eaves: 0, walls: 3, rooms: "a pit 7 by 7 in terraces",
  parts: { rim: [COB, COB, SBR], rail: [FEN, CWALL, SWALL], post: all3(LOG), light: [TORCH, TORCH, LANTERN] },
  furniture: [{ block: B.CHEST, at: [1, 0, "out"], facing: "out", tier: 1 }, { block: B.CRAFTING_TABLE, at: [2, 0, "out"], tier: 2 }, { block: B.FURNACE, at: [-2, 0, "out"], facing: "out", tier: 2 }],
  tiers: ["", "the pit three terraces deep, the rim and its rail, the chest", "two more terraces down, a cobblestone wall for the rail, the cutting table and a furnace", "the deepest terraces, a stone brick rim, lanterns"],
};
reg("quarry", QUARRY, "quarry");
reg("quarry/large", { ...QUARRY, core: [13, 13], what: "a big quarry: a pit 11 by 11 dug in terraces (3 deep, 5, then 7), a paved rim with a rail round it, lights on the corners; a lot of stone for the town" }, "big quarry");

// ---- the water
kind("pier", "a pier", "piers", 4, "shore", 2);
reg("pier", {
  kind: "pier", what: "a pier: a plank deck out over the water, rails down its sides, lights on posts at the end, posts under it",
  shape: "pier", core: [3, 12], eaves: 0, walls: 0, rooms: "a deck 3 by 12 over the water",
  parts: { deck: [PL, PL, BPL], rail: all3(FEN), post: all3(LOG), light: [TORCH, LANTERN, LANTERN], piling: all3(LOG) },
  furniture: [{ block: OST, at: [1, 0, -2], facing: "in", tier: 2 }],
  tiers: ["", "the deck and its rails, torches at the end", "lanterns at the end, a bench looking out over the water", "a birch deck"],
}, "pier");
reg("pier/dock", {
  kind: "pier", what: "a dock: a wide plank deck out over the water, rails down its sides, crates (barrels and a chest) for the boats, lights at the end",
  shape: "pier", core: [7, 10], eaves: 0, walls: 0, rooms: "a deck 7 by 10 over the water",
  parts: { deck: all3(PL), rail: all3(FEN), post: all3(LOG), light: [TORCH, LANTERN, LANTERN], piling: all3(LOG) },
  furniture: [{ block: B.BARREL, at: [1, 0, 2], tier: 1 }, { block: B.BARREL, at: [1, 1, 2], tier: 2 }, { block: B.CHEST, at: [-2, 0, 2], facing: "left", tier: 1 }, { block: B.BARREL, at: [-2, 0, 3], tier: 2 }, { block: B.HAY_BALE, at: [1, 0, 3], tier: 3, optional: true }],
  tiers: ["", "the deck and its rails, crates for the boats", "more crates, lanterns at the end", "hay"],
}, "dock");
kind("lighthouse", "a lighthouse", "lighthouses", 6, "shore", 1);
reg("lighthouse", {
  kind: "lighthouse", what: "a lighthouse: a round striped tower, a ladder up the inside to a gallery with a rail, the lamp room in glass round the beacon, a cap with a light on its tip",
  shape: "lighthouse", core: [5, 5], eaves: 1, walls: 8, rooms: "a round tower 3 by 3, a lamp room on top",
  parts: { footing: all3(COB), floor: all3(COB), wall: [COB, SBR, SBR], band: all3(BPL), gallery: [COB, SBR, SBR], rail: [FEN, CWALL, SWALL], glass: [PANE, PANE, PANE], post: [LOG, SBR, SBR], beacon: [TORCH, B.LAMP, B.LAMP], roof: [CST, SST, SST], plate: [COB, SBR, SBR], ridge: [COB, SBR, SBR], finial: [TORCH, LANTERN, LANTERN] },
  doors: ["mid"], windows: [[0, 3, "mid"], [-1, 3, "mid"], [0, 6, "mid"], [-1, 6, "mid"]],
  furniture: [{ block: TORCH, at: [3, 0, 1], tier: 1 }, { block: B.CHEST, at: [3, 0, -2], facing: "left", tier: 2 }],
  tiers: ["", "the striped tower, the gallery, the lamp room with a torch for the beacon", "stone brick, a lamp (8 glass round a torch) for the beacon", "a stone brick rail and lanterns"],
}, "lighthouse", "stone");

// ---- defences
kind("guardhouse", "a guardhouse", "guardhouses", 5, "edge", 4);
reg("guardhouse", building("guardhouse", {
  style: "stone", core: [5, 7], walls: 4, ridge: "flat", what: "a guardhouse: a bunk, the watch's chest, a weapon rack (a fence), a crafting table, a lookout on the flat roof",
  rooms: "one guard room 3 by 5", windows: [[0, 2, 2], [-1, 2, 2], [0, 2, -3], [-1, 2, -3]],
  furniture: [{ block: TORCH, at: [1, 0, 1], tier: 1 }, bed(1, 0, 2, 2), { block: B.CHEST, at: [-2, 0, -2], facing: "out", tier: 1 }, { block: FEN, at: [-2, 0, 2], tier: 2 }, { block: B.CRAFTING_TABLE, at: [1, 0, -2], tier: 2 }, hangMid()],
  tiers: ["", "the guard room and the watch's chest", "a bunk, a weapon rack and a crafting table", "stone brick walls, a lantern"],
}), "guardhouse", "stone");
kind("barracks", "a barracks", "barracks", 7, "edge", 1);
reg("barracks", building("barracks", {
  style: "stone", core: [9, 13], walls: 4, what: "a barracks: rows of bunks down both walls, the armoury chests, the mess table down the middle",
  rooms: "one long dormitory 7 by 11", posts: [[0, "mid"], [-1, "mid"]],
  windows: [[0, 2, 3], [0, 2, 9], [-1, 2, 3], [-1, 2, 9], ["mid", 2, -1]],
  furniture: [...torches, ...[2, 5, 8].flatMap((v): Furniture[] => [bed(1, 0, v, v === 2 ? 2 : 3), bed(-2, 0, v, v === 2 ? 2 : 3)]),
    { block: B.CHEST, at: [1, 0, -2], facing: "out", tier: 1 }, { block: B.CHEST, at: [-2, 0, -2], facing: "out", tier: 2 }, ...along("mid", 0, 3, 8, { block: TABLE, tier: 3 }), ...t3()],
  tiers: ["", "the dormitory and the armoury chest", "two bunks (beds take wool) and a second chest", "four more bunks, the mess table, stone brick walls, lanterns"],
}), "barracks", "stone");
kind("armory", "an armoury", "armouries", 7, "edge", 1);
reg("armory", building("armory", {
  style: "stone", core: [7, 7], what: "an armoury: chests of arms and armour, weapon racks (fences) down both walls, the smith's bench",
  rooms: "one store room 5 by 5", chimney: { tier: 2, u: -2 },
  furniture: [...torches, ...across(1, 3, 0, -2, { block: B.CHEST, facing: "out", tier: 1 }), ...along(1, 0, 2, 3, { block: FEN, tier: 2 }), ...along(-2, 0, 2, 3, { block: FEN, tier: 2 }), { block: B.CRAFTING_TABLE, at: [-2, 0, -2], tier: 2 }, ...t3()],
  tiers: ["", "chests of arms and armour", "weapon racks down both walls, the bench", "stone brick walls, lanterns"],
}), "armoury", "stone");
kind("gatehouse", "a gatehouse", "gatehouses", 6, "gate", 4);
reg("gatehouse", {
  kind: "gatehouse", what: "a gatehouse over a gate of the wall: two towers either side of an arch the street runs through, a walkway over the top behind battlements, ladders up inside, slits in the faces",
  shape: "gatehouse", core: [11, 3], eaves: 0, walls: 6, rooms: "two tower rooms 2 by 1, the arch 3 wide and 4 high",
  parts: { footing: all3(COB), paving: [COB, SBR, SBR], wall: [COB, COB, SBR], corner: [COB, SBR, SBR], floor: [COB, SBR, SBR], battlement: [COB, SBR, SBR], window: [FEN, PANE, PANE], light: [TORCH, TORCH, LANTERN] },
  furniture: [{ block: HANG, at: ["mid", 0, "mid"], hang: true, tier: 2 }, { block: TORCH, at: [2, 0, 1], tier: 1 }, { block: TORCH, at: [-3, 0, 1], tier: 1 }],
  tiers: ["", "the gatehouse in cobblestone: the towers, the arch, the walkway and its battlements", "stone brick paving, corners and battlements, glass in the slits, a lantern under the arch", "stone brick walls, lanterns on the corners"],
}, "gatehouse", "stone");
kind("bastion", "a bastion", "bastions", 6, "edge", 4);
reg("bastion", {
  ...BLUEPRINTS.tower, kind: "bastion", core: [7, 7], walls: 6,
  what: "a bastion: a squat stone tower 7 by 7 with a lookout behind battlements, slits, a ladder up the back wall",
  tiers: ["", "the bastion in cobblestone, its battlements and torches", "stone brick corners and battlements, glass in the slits, a chest for the watch", "lanterns on the corners, a barrel of supplies"],
}, "bastion", "stone");
reg("tower/timber", {
  ...BLUEPRINTS.tower, kind: "tower", parts: { footing: all3(COB), wall: all3(PL), corner: all3(LOG), floor: all3(PL), battlement: all3(LOG), window: [0, PANE, PANE], light: [TORCH, TORCH, LANTERN] },
  what: "a wooden watchtower: plank walls on log corners, a lookout behind log battlements, a ladder up the back",
}, "wooden watchtower", "oak");

// ---- civic
kind("school", "a school", "schools", 6, "civic", 1);
reg("school", building("school", {
  style: "timber", core: [9, 9], walls: 4, what: "a school: desks (slabs) and stools in rows, the teacher's table and chair, a bookshelf, the slate chest",
  rooms: "one schoolroom 7 by 7",
  furniture: [...torches, ...[3, 5].flatMap((v): Furniture[] => [{ block: TABLE, at: [2, 0, v], tier: 1 }, { block: OST, at: [2, 0, v - 1], facing: "out", tier: 1 }, { block: TABLE, at: [-3, 0, v], tier: 1 }, { block: OST, at: [-3, 0, v - 1], facing: "out", tier: 1 }]),
    { block: TABLE, at: ["mid", 0, -3], tier: 1 }, { block: OST, at: ["mid", 0, -2], facing: "in", tier: 2 }, { block: B.BOOKSHELF, at: [1, 0, -2], tier: 2, optional: true }, { block: B.CHEST, at: [-2, 0, -2], facing: "out", tier: 2 }, ...t3()],
  tiers: ["", "desks and stools in rows, the teacher's table", "the teacher's chair, a bookshelf, the slate chest", "lanterns"],
}), "school", "timber");
kind("inn", "an inn", "inns", 5, "civic", 1);
reg("inn", building("inn", {
  style: "timber", core: [9, 11], walls: 7, floors: [3], what: "an inn: the taproom below (the bar, tables, the hearth), guest rooms above up a ladder",
  rooms: "the taproom 7 by 9 below, guest rooms above", chimney: { tier: 1, u: -2 }, posts: [[0, 4], [0, 8], [-1, 4], [-1, 8]],
  windows: [[2, 1, 0], [-3, 1, 0], [2, 5, 0], [-3, 5, 0], [0, 1, 2], [0, 5, 2], [0, 1, 6], [0, 5, 6], [-1, 1, 2], [-1, 5, 2], [-1, 1, 6], [-1, 5, 6]],
  furniture: [...torches, ...across(3, 6, 0, -4, { block: TABLE, tier: 1 }), { block: B.FURNACE, at: [-2, 0, -2], facing: "out", tier: 1 }, { block: B.BARREL, at: [3, 0, -2], tier: 1 }, { block: B.CHEST, at: [4, 0, -2], facing: "out", tier: 1 },
    { block: TABLE, at: [2, 0, 3], tier: 1 }, { block: OST, at: [1, 0, 3], facing: "left", tier: 1 }, { block: OST, at: [3, 0, 3], facing: "right", tier: 1 },
    bed(3, 4, 1, 2), bed(5, 4, 1, 2), bed(7, 4, 1, 2), bed(-2, 4, 5, 3), { block: B.CHEST, at: [3, 4, -2], facing: "out", tier: 2 },
    { block: TABLE, at: [-3, 0, 3], tier: 2 }, { block: OST, at: [-4, 0, 3], facing: "left", tier: 2 }, { block: OST, at: [-2, 0, 3], facing: "right", tier: 2 }, ...t3()],
  tiers: ["", "the taproom with its bar and hearth, the guest rooms upstairs", "three guest beds, a second table, the linen chest", "a fourth bed, lanterns"],
}), "inn", "timber");
kind("courthouse", "a courthouse", "courthouses", 7, "square", 1);
reg("courthouse", building("courthouse", {
  style: "stone", core: [11, 13], walls: 5, baseCourses: 2, what: "a courthouse: the judge's bench raised at the back, benches for the town, the clerk's table, the records chest",
  rooms: "one court 9 by 11, 5 high", posts: [[0, 4], [0, 8], [-1, 4], [-1, 8]],
  windows: [[0, 2, 2], [0, 3, 2], [0, 2, 6], [0, 3, 6], [0, 2, 10], [0, 3, 10], [-1, 2, 2], [-1, 3, 2], [-1, 2, 6], [-1, 3, 6], [-1, 2, 10], [-1, 3, 10], [2, 2, 0], [-3, 2, 0]],
  furniture: [...torches, ...across(3, 7, 0, -3, { block: SSLAB + 1, tier: 1 }), { block: SST, at: ["mid", 0, -2], facing: "in", tier: 1 },
    ...[3, 5, 7].flatMap((v): Furniture[] => [...across(1, 3, 0, v, { block: OST, facing: "out", tier: v === 3 ? 1 : 2 }), ...across(7, 9, 0, v, { block: OST, facing: "out", tier: v === 3 ? 1 : 2 })]),
    { block: B.CHEST, at: [1, 0, -2], facing: "out", tier: 2 }, { block: TABLE, at: [2, 0, -5], tier: 2 }, { block: B.BOOKSHELF, at: [-2, 0, -2], tier: 3, optional: true }, ...rug("mid", 1, 8, 3), ...t3()],
  tiers: ["", "the judge's bench and seat, the first benches", "more benches, the clerk's table and the records chest", "stone brick walls, a bookshelf, a rug up the aisle, lanterns"],
}), "courthouse", "stone");
kind("bathhouse", "a bathhouse", "bathhouses", 7, "square", 1);
reg("bathhouse", {
  kind: "bathhouse", what: "a bathhouse: a pool of water in the middle (a water_bucket), stone benches down the walls, lanterns",
  shape: "cottage", core: [9, 9], eaves: 1, walls: 4, baseCourses: 1, ridge: "v",
  rooms: "one hall 7 by 7 round a pool",
  parts: parts("stone", { floor: all3(SBR) }), doors: ["mid"],
  windows: [[0, 2, 2], [0, 2, -3], [-1, 2, 2], [-1, 2, -3]],
  furniture: [...torches, ...([["mid-1", "mid"], ["mid", "mid"], ["mid+1", "mid"]] as [Pos, Pos][]).map(([u, v]): Furniture => ({ block: B.WATER, at: [u, -1, v], tier: 2 })),
    ...along(1, 0, 2, 6, { block: SSLAB, tier: 1 }), ...along(-2, 0, 2, 6, { block: SSLAB, tier: 1 }), ...t3()],
  tiers: ["", "the bath hall, stone benches along the walls", "water in the pool (a water_bucket)", "lanterns"],
}, "bathhouse", "stone");
kind("guildhall", "a guildhall", "guildhalls", 7, "square", 1);
reg("guildhall", building("guildhall", {
  style: "timber", core: [11, 11], walls: 7, floors: [3], what: "a guildhall: the meeting hall below (a long table, the guild chest), the masters' rooms above",
  rooms: "a hall 9 by 9 below, rooms above", chimney: { tier: 2, u: 2 }, posts: [[0, 5], [-1, 5]],
  windows: [[2, 1, 0], [-3, 1, 0], [2, 5, 0], [-3, 5, 0], [0, 1, 3], [0, 5, 3], [0, 1, 7], [0, 5, 7], [-1, 1, 3], [-1, 5, 3], [-1, 1, 7], [-1, 5, 7]],
  furniture: [...torches, ...along("mid", 0, 3, 7, { block: TABLE, tier: 1 }), ...along("mid-1", 0, 3, 7, { block: OST, facing: "left", tier: 2 }), ...along("mid+1", 0, 3, 7, { block: OST, facing: "right", tier: 2 }),
    { block: B.CHEST, at: [3, 0, -2], facing: "out", tier: 1 }, { block: B.CRAFTING_TABLE, at: [4, 0, -2], tier: 1 }, bed(3, 4, 1, 2), bed(-2, 4, 1, 3), { block: B.BOOKSHELF, at: [-2, 0, -2], tier: 3, optional: true }, ...t3()],
  tiers: ["", "the meeting hall with its long table, the guild chest", "benches down the table, a master's room above", "a second room above, lanterns, a bookshelf"],
}), "guildhall", "timber");

// ---- faith and time
kind("temple", "a temple", "temples", 7, "square", 1);
reg("temple", {
  kind: "temple", what: "a temple: a colonnade of stone columns across the front under the roof, the hall behind with its altar and benches",
  shape: "temple", core: [9, 13], eaves: 1, walls: 5, baseCourses: 1, rooms: "a portico 9 by 3, the hall 7 by 8",
  parts: { footing: all3(COB), floor: [COB, SBR, SBR], base: [COB, SBR, SBR], wall: [COB, COB, SBR], post: [COB, SBR, SBR], column: [CWALL, SWALL, SWALL], plate: [COB, SBR, SBR], gable: [COB, COB, SBR], roof: [CST, SST, SST], ridge: [COB, SBR, SBR], window: [FEN, PANE, PANE], light: all3(TORCH) },
  windows: [[0, 2, 6], [0, 2, 9], [-1, 2, 6], [-1, 2, 9]],
  furniture: [{ block: TORCH, at: [1, 0, 4], tier: 1 }, { block: TORCH, at: [-2, 0, 4], tier: 1 }, ...across(3, 5, 0, -2, { block: SSLAB + 1, tier: 1 }), { block: LANTERN, at: [3, 1, -2], tier: 3 }, { block: LANTERN, at: [5, 1, -2], tier: 3 },
    ...[6, 8].flatMap((v): Furniture[] => [...across(1, 3, 0, v, { block: SST, facing: "out", tier: 2 }), ...across(5, 7, 0, v, { block: SST, facing: "out", tier: 2 })]),
    hangMid(1), ...rug("mid", 4, 10, 3)],
  tiers: ["", "the temple in cobblestone: the colonnade, the hall, the altar", "a stone brick floor, base and roof, stone benches, glass", "stone brick walls, lanterns on the altar and in the colonnade, a rug"],
}, "temple", "stone");
kind("shrine", "a shrine", "shrines", 3, "park", 3);
kind("gazebo", "a gazebo", "gazebos", 4, "park", 3);
kind("pavilion", "a market pavilion", "market pavilions", 5, "market", 2);
const pav = (k: Kind, what: string, core: [number, number], walls: number, style: string, extra: Partial<Blueprint>, furniture: Furniture[], tiers: string[]): Blueprint => ({
  kind: k, what, shape: "pavilion", core, eaves: 1, walls, rooms: what, parts: parts(style, { border: [COB, SBR, SBR], rail: all3(STYLES[style].fence), finial: [TORCH, LANTERN, LANTERN] }), furniture, tiers, ...extra,
});
reg("shrine", pav("shrine", "a shrine: an open roofed shrine on four posts, a stone altar with a light, a bench before it", [5, 5], 3, "stone", { parts: parts("stone", { floor: [COB, SBR, SBR], border: [COB, SBR, SBR], post: [LOG, SBR, SBR], rail: all3(FEN), finial: [TORCH, LANTERN, LANTERN] }) },
  [{ block: SSLAB + 1, at: ["mid", 0, -2], tier: 1 }, { block: TORCH, at: ["mid-1", 0, -2], tier: 1 }, { block: B.FLOWER_POT, at: ["mid", 1, -2], tier: 2, optional: true }, { block: OST, at: ["mid", 0, 1], facing: "out", tier: 2 }, hangMid()],
  ["", "the shrine on its posts, the altar and a torch", "a stone floor, a bench before the altar, a pot of flowers", "a lantern hanging over the altar"]), "shrine", "stone");
const GAZEBO = pav("gazebo", "a gazebo: an open birch pavilion with a hipped roof, benches round the inside, a lantern hanging in the middle", [7, 7], 3, "birch", {},
  [...along(1, 0, 2, 4, { block: BST, facing: "left", tier: 1 }), ...along(-2, 0, 2, 4, { block: BST, facing: "right", tier: 1 }), ...across(2, 4, 0, -2, { block: BST, facing: "in", tier: 2 }), hangMid()],
  ["", "the gazebo: posts, a rail, the roof, benches down the sides", "a bench across the back", "a lantern hanging in the middle"]);
reg("gazebo", GAZEBO, "gazebo", "birch");
reg("gazebo/oak", {
  ...GAZEBO, parts: parts("oak", { border: [COB, SBR, SBR], rail: all3(FEN), finial: [TORCH, LANTERN, LANTERN] }),
  furniture: [...along(1, 0, 2, 4, { block: OST, facing: "left", tier: 1 }), ...along(-2, 0, 2, 4, { block: OST, facing: "right", tier: 1 }), ...across(2, 4, 0, -2, { block: OST, facing: "in", tier: 2 }), hangMid()],
  what: "a bandstand: an open oak pavilion with a hipped roof, benches round the inside, a lantern in the middle",
}, "bandstand", "oak");
reg("pavilion", pav("pavilion", "a market pavilion: an open hall on posts under a hipped roof, counters (slabs) for the traders, barrels and chests of goods", [9, 7], 4, "timber", { posts: [[4, 0], [4, -1]] },
  [...across(1, 3, 0, 2, { block: TABLE, tier: 1 }), ...across(5, 7, 0, 2, { block: TABLE, tier: 1 }), { block: B.CHEST, at: [1, 0, -2], facing: "out", tier: 1 }, { block: B.BARREL, at: [2, 0, -2], tier: 2 }, { block: B.BARREL, at: [-2, 0, -2], tier: 2 }, { block: B.CHEST, at: [-3, 0, -2], facing: "out", tier: 2 },
    { block: HANG, at: [2, 0, "mid"], hang: true, tier: 3 }, { block: HANG, at: [-3, 0, "mid"], hang: true, tier: 3 }],
  ["", "the pavilion on its posts, two counters, a chest of goods", "barrels and a second chest", "lanterns hanging over the counters"]), "market pavilion", "timber");
kind("belltower", "a bell tower", "bell towers", 6, "square", 1);
kind("clocktower", "a clock tower", "clock towers", 7, "square", 1);
const towerParts = (style: string): Record<string, Mat> => parts(style, { loft: all3(PL), roof: [CST, SST, SST], plate: [COB, SBR, SBR], ridge: [COB, SBR, SBR], finial: [TORCH, LANTERN, LANTERN], base: [COB, SBR, SBR], post: [LOG, SBR, SBR] });
const BELLTOWER: Blueprint = {
  kind: "belltower", what: "a bell tower: a square stone tower 10 high, open arches round the belfry, a loft up a ladder, a hipped stone cap with a light on its tip",
  shape: "belltower", core: [5, 5], eaves: 0, walls: 10, baseCourses: 2, rooms: "a tower room 3 by 3, the belfry over it", parts: towerParts("stone"), doors: ["mid"],
  furniture: [{ block: TORCH, at: [-2, 0, 1], tier: 1 }, { block: LANTERN, at: ["mid", 7, "mid"], tier: 2 }, { block: B.CHEST, at: [-2, 0, -2], facing: "out", tier: 2 }],
  tiers: ["", "the tower, its belfry and cap", "the bell in the belfry (a lantern), the tower's chest", "stone brick walls, a lantern on the tip"],
};
reg("belltower", BELLTOWER, "bell tower", "stone");
reg("clocktower", {
  ...BELLTOWER, kind: "clocktower", what: "a clock tower: a square tower 10 high with the clock's face on the front (birch, its hands of logs), open arches round the belfry, a hipped cap with a light",
  parts: { ...towerParts("stone"), face: all3(BPL), hands: all3(LOG) },
}, "clock tower", "stone");
reg("clocktower/timber", {
  ...BELLTOWER, kind: "clocktower", what: "a timber-framed clock tower: the clock's face on the front, the belfry, an oak cap",
  parts: { ...towerParts("timber"), face: all3(BPL), hands: all3(LOG), roof: [CST, OST, OST], plate: all3(PL), ridge: all3(PL) },
}, "timber clock tower", "timber");

// ---- landmarks
kind("statue", "a statue", "statues", 5, "square", 6);
const figure = (o: Record<string, Mat>): Record<string, Mat> => ({ footing: all3(COB), step: [CST, SST, SST], plinth: [COB, SBR, SBR], ...o });
const STATUE: Blueprint = {
  kind: "statue", what: "a statue of a knight on a stone plinth: stone legs, body and arms, a sword raised, lights on the plinth",
  shape: "statue", core: [5, 3], eaves: 0, walls: 2, rooms: "a figure on a plinth",
  parts: figure({ legs: all3(COB), body: all3(SBR), arms: all3(SBR), head: all3(SBR), hat: all3(SSLAB), tool: all3(FEN) }),
  furniture: [{ block: TORCH, at: [1, 2, 0], tier: 1 }, { block: TORCH, at: [-2, 2, 0], tier: 1 }],
  tiers: ["", "the knight on its plinth, its sword raised, torches", "stone brick steps and plinth"],
};
reg("statue", STATUE, "statue of a knight", "stone");
reg("statue/farmer", {
  ...STATUE, what: "a statue of a farmer on a plinth: log legs, a birch body, plank arms, a pitchfork raised (a fence), a straw hat (a slab)",
  parts: figure({ legs: all3(LOG), body: all3(BPL), arms: all3(PL), head: all3(BPL), hat: all3(B.OAK_SLAB), tool: all3(FEN) }),
}, "statue of a farmer", "oak");
reg("statue/founder", {
  ...STATUE, walls: 3, what: "the founders' statue: a figure on a tall plinth of stone bricks, a light held up in its hand, torches at its feet",
  parts: figure({ legs: all3(SBR), body: all3(SBR), arms: all3(SBR), head: all3(SBR), hat: all3(SSLAB), tool: [LANTERN, LANTERN, LANTERN] }),
  furniture: [{ block: TORCH, at: [1, 3, 0], tier: 1 }, { block: TORCH, at: [-2, 3, 0], tier: 1 }],
}, "founders' statue", "stone");
kind("arch", "an arch over the avenue", "arches", 6, "span", 2);
reg("arch", {
  kind: "arch", what: "an arch across the avenue: two piers, the lintel over a way three wide and four high, a cornice along the top, a light over the middle",
  shape: "archway", core: [7, 3], eaves: 0, walls: 6, rooms: "a way through 3 wide and 4 high",
  parts: { footing: all3(COB), paving: [COB, SBR, SBR], wall: [COB, SBR, SBR], band: [SBR, SBR, B.MOSSY_STONE_BRICKS], cornice: [CSLAB, SSLAB, SSLAB], light: [TORCH, LANTERN, LANTERN] },
  furniture: [{ block: HANG, at: ["mid", 0, "mid"], hang: true, tier: 2 }],
  tiers: ["", "the arch in cobblestone, a torch on top", "stone brick, a lantern under the arch and on top", "a mossy stone band (old stone)"],
}, "arch", "stone");
reg("fountain/small", { ...BLUEPRINTS.fountain, kind: "fountain", core: [5, 5], what: "a small fountain: a stone basin 3 by 3, a column with water falling from its top, lights on the corners" }, "small fountain", "stone");
reg("fountain/grand", { ...BLUEPRINTS.fountain, kind: "fountain", core: [9, 9], what: "a grand fountain: a stone basin 7 by 7 with a low wall round it, a column in the middle with water falling from it, lights on the corners" }, "grand fountain", "stone");
reg("well/covered", {
  ...BLUEPRINTS.well, kind: "well", parts: { rim: [COB, SBR, SBR], parapet: [CWALL, SWALL, SWALL], post: all3(LOG), roof: [CST, SST, SST], ridge: [COB, SBR, SBR], gable: [COB, SBR, SBR], basin: all3(COB) },
  what: "a covered stone well: a stone roof on log posts over a stone basin",
}, "covered well", "stone");
reg("lamp/stone", { ...BLUEPRINTS.lamp, kind: "lamp", parts: { footing: [COB, SBR, SBR], post: [COB, SWALL, SWALL], light: [TORCH, LANTERN, LANTERN] }, what: "a stone lamp post: a stone post (a stone brick wall from tier 2) with a light on top" }, "stone lamp post", "stone");
reg("lamp/birch", { ...BLUEPRINTS.lamp, kind: "lamp", parts: { footing: [COB, SBR, SBR], post: [BLOG, BFEN, BFEN], light: [TORCH, LANTERN, LANTERN] }, what: "a birch lamp post: a birch post with a light on top" }, "birch lamp post", "birch");

// ---- street furniture
kind("bench", "a bench", "benches", 2, "street", 24);
const BENCH: Blueprint = {
  kind: "bench", what: "a bench by the street: a seat of oak stairs between two fence posts, a cobblestone pad under it; lanterns on the posts at tier 2",
  shape: "bench", core: [5, 1], eaves: 0, walls: 1, rooms: "a seat for three",
  parts: { pad: [COB, SBR, SBR], seat: all3(OST), post: all3(FEN), light: [0, LANTERN, LANTERN] },
  furniture: [], tiers: ["", "the bench on its pad", "a stone brick pad, lanterns on the posts"],
};
reg("bench", BENCH, "bench", "oak");
reg("bench/stone", { ...BENCH, parts: { pad: [COB, SBR, SBR], seat: all3(SST), post: [CWALL, SWALL, SWALL], light: [0, LANTERN, LANTERN] }, what: "a stone bench by the street: a seat of stone brick stairs between two stone posts" }, "stone bench", "stone");
reg("bench/birch", { ...BENCH, parts: { pad: [COB, SBR, SBR], seat: all3(BST), post: all3(BFEN), light: [0, LANTERN, LANTERN] }, what: "a birch bench by the street: a seat of birch stairs between two birch posts" }, "birch bench", "birch");
kind("flowerbed", "a flower bed", "flower beds", 2, "street", 24);
const bedOf = (what: string, flowers: number[], kerb: Mat): Blueprint => ({
  kind: "flowerbed", what, shape: "flowerbed", core: [6, 1], eaves: 0, walls: 1, rooms: "four flowers in a row",
  parts: { footing: all3(COB), kerb, flower: all3(flowers[0]), ...(flowers[1] ? { flower2: all3(flowers[1]) } : {}), ...(flowers[2] ? { flower3: all3(flowers[2]) } : {}) },
  furniture: [], tiers: ["", "the bed: a kerb, soil, the flowers", "a stone brick kerb"],
});
reg("flowerbed", bedOf("a bed of poppies by the street: red flowers in a kerb of stone", [B.POPPY], [CSLAB, SSLAB, SSLAB]), "bed of poppies");
reg("flowerbed/yellow", bedOf("a bed of dandelions by the street: yellow flowers in a kerb of stone", [B.DANDELION], [CSLAB, SSLAB, SSLAB]), "bed of dandelions");
reg("flowerbed/mixed", bedOf("a bed of mixed flowers: poppies, dandelions and bluebells in turn, in a kerb of stone", [B.POPPY, B.DANDELION, B.BLUEBELL], [CSLAB, SSLAB, SSLAB]), "mixed flower bed");
reg("flowerbed/planter", bedOf("a wooden planter of bluebells and poppies in a box of oak slabs", [B.BLUEBELL, B.POPPY], all3(B.OAK_SLAB)), "planter", "oak");

// ---- trees, gardens, parks, yards
kind("treefarm", "a tree farm", "tree farms", 1, "edge", 4);
const yardParts = (fence: number, o: Record<string, Mat> = {}): Record<string, Mat> => ({ fence: all3(fence), post: all3(LOG), light: [TORCH, TORCH, LANTERN], path: [COB, COB, SBR], kerb: [COB, SBR, SBR], ...o });
const TREEFARM: Blueprint = {
  kind: "treefarm", what: "a tree farm: a fenced field of nine oak saplings four apart (they grow into trees in a few minutes), a gate, lights on the corners; cut the trees, plant the saplings again",
  shape: "yard", core: [13, 13], eaves: 0, walls: 0, rooms: "a field of nine oaks", opts: { grid: 4, from: 2 },
  parts: yardParts(FEN, { sapling: all3(B.OAK_SAPLING) }),
  furniture: [{ block: B.CHEST, at: [1, 0, 1], facing: "in", tier: 2 }],
  tiers: ["", "the fence and the oak saplings", "a chest for the saplings and the axe", "lanterns on the corners"],
};
reg("treefarm", TREEFARM, "oak tree farm", "oak");
reg("treefarm/birch", { ...TREEFARM, what: "a birch tree farm: a fenced field of nine birch saplings four apart (birch for the birch district), a gate, lights on the corners", parts: yardParts(BFEN, { sapling: all3(B.BIRCH_SAPLING), post: all3(BLOG) }) }, "birch tree farm", "birch");
reg("treefarm/small", { ...TREEFARM, core: [9, 9], what: "a small tree farm: four oak saplings in a fenced square, a gate, lights on the corners" }, "small tree farm", "oak");
kind("orchard", "an orchard", "orchards", 4, "fields", 2);
reg("orchard", {
  kind: "orchard", what: "an orchard: two rows of oaks either side of a path, benches along it, a fence and a gate, lights on the posts (oaks drop apples)",
  shape: "yard", core: [11, 15], eaves: 0, walls: 0, rooms: "two rows of oaks along a path", opts: { grid: 6, gridV: 4, from: 2, pathU: 1, posts: 5 },
  parts: yardParts(FEN, { sapling: all3(B.OAK_SAPLING) }),
  furniture: [{ block: OST, at: ["mid-1", 0, 4], facing: "left", tier: 2 }, { block: OST, at: ["mid+1", 0, 8], facing: "right", tier: 2 }],
  tiers: ["", "the fence, the path and the oak saplings", "benches along the path, a cobblestone path", "lanterns on the posts"],
}, "orchard", "oak");
kind("garden", "a garden", "gardens", 3, "park", 4);
const GARDEN: Blueprint = {
  kind: "garden", what: "a flower garden: rows of poppies, dandelions and bluebells, a path down the middle, a bench at its end, a low fence with a gate, lights on the corners",
  shape: "yard", core: [9, 9], eaves: 0, walls: 0, rooms: "flower rows round a path", opts: { flowers: 1, pathU: 1, clear: 1 },
  parts: yardParts(FEN, { flower: all3(B.POPPY), flower2: all3(B.DANDELION), flower3: all3(B.BLUEBELL) }),
  furniture: [{ block: OST, at: ["mid", 0, -2], facing: "in", tier: 2 }],
  tiers: ["", "the fence, the path and the flower rows", "a cobblestone path, a bench at the end", "lanterns on the corners"],
};
reg("garden", GARDEN, "flower garden", "oak");
reg("garden/walled", { ...GARDEN, what: "a walled garden: a cobblestone wall round rows of flowers, a stone path, a bench, lanterns", parts: yardParts(CWALL, { flower: all3(B.POPPY), flower2: all3(B.BLUEBELL), post: [COB, SBR, SBR], fence: [CWALL, SWALL, SWALL] }) }, "walled garden", "stone");
kind("park", "a park", "parks", 5, "park", 2);
reg("park", {
  kind: "park", what: "a park: a fenced green with oaks in the corners, a pond in the middle (water from tier 2) with a stone kerb, paths across, benches by the pond, lights on posts",
  shape: "yard", core: [15, 15], eaves: 0, walls: 0, rooms: "a green 13 by 13 round a pond", opts: { grid: 10, from: 2, pond: 1, pathU: 1, pathV: 1, posts: 7, clear: 1 },
  parts: yardParts(FEN, { sapling: all3(B.OAK_SAPLING) }),
  furniture: [{ block: OST, at: [3, 0, "mid-1"], facing: "left", tier: 2 }, { block: OST, at: [-4, 0, "mid-1"], facing: "right", tier: 2 }, { block: OST, at: ["mid-1", 0, -4], facing: "in", tier: 3 }],
  tiers: ["", "the fence, the paths, the oaks, the pond dug", "water in the pond, benches, cobblestone paths", "a third bench, lanterns"],
}, "park", "oak");
kind("yard", "a training yard", "training yards", 6, "edge", 1);
reg("yard", {
  kind: "yard", what: "a training yard: a fenced ground with straw dummies (hay on fence posts), a target at the back, the weapon chest, lights on the corners",
  shape: "yard", core: [11, 9], eaves: 0, walls: 0, rooms: "a yard 9 by 7", opts: { clear: 1 },
  parts: yardParts(FEN),
  furniture: [...[2, 5, 8].flatMap((u): Furniture[] => [{ block: FEN, at: [u, 0, 4], tier: 1 }, { block: B.HAY_BALE, at: [u, 1, 4], tier: 1, optional: true }]), { block: B.CHEST, at: [1, 0, 1], facing: "in", tier: 1 }, { block: B.HAY_BALE, at: ["mid", 0, -2], tier: 2, optional: true }, { block: B.HAY_BALE, at: ["mid", 1, -2], tier: 2, optional: true }],
  tiers: ["", "the fence and the dummies, the weapon chest", "a target at the back", "lanterns on the corners"],
}, "training yard", "oak");
kind("pen", "an animal pen", "animal pens", 3, "fields", 3);
reg("pen", {
  kind: "pen", what: "an animal pen: a fenced pen with a gate, hay to eat, a water trough (from tier 2), lights on the corners",
  shape: "yard", core: [9, 9], eaves: 0, walls: 0, rooms: "a pen 7 by 7",
  parts: yardParts(FEN),
  furniture: [{ block: B.HAY_BALE, at: [1, 0, -2], tier: 1, optional: true }, { block: B.HAY_BALE, at: [2, 0, -2], tier: 1, optional: true }, { block: B.WATER, at: [-2, -1, -2], tier: 2 }, { block: B.WATER, at: [-3, -1, -2], tier: 2 }],
  tiers: ["", "the fence, the gate and hay", "a water trough", "lanterns on the corners"],
}, "animal pen", "oak");
kind("lumberyard", "a lumber yard", "lumber yards", 3, "edge", 1);
reg("lumberyard", {
  kind: "lumberyard", what: "a lumber yard: a fenced yard with log piles, a sawing table, the axe chest, a gate, lights on the corners",
  shape: "yard", core: [9, 7], eaves: 0, walls: 0, rooms: "a yard 7 by 5", opts: { clear: 1 },
  parts: yardParts(FEN),
  furniture: [{ block: LOG, at: [1, 0, -2], tier: 1 }, { block: LOG, at: [2, 0, -2], tier: 1 }, { block: LOG, at: [1, 1, -2], tier: 2 }, { block: B.CRAFTING_TABLE, at: [-2, 0, -2], tier: 1 }, { block: B.CHEST, at: [-3, 0, -2], facing: "out", tier: 1 }, { block: BLOG, at: [3, 0, -2], tier: 2 }, { block: BLOG, at: [3, 1, -2], tier: 3 }],
  tiers: ["", "the fence, a log pile, the sawing table and the axe chest", "a bigger pile, birch logs too", "lanterns on the corners"],
}, "lumber yard", "oak");

// ---------------------------------------------------------------- the words for the town's first kinds

for (const [k, one, many, from, district, most] of [
  ["house", "a house", "houses", -1, "homes", 99], ["storehouse", "a storehouse", "storehouses", 1, "square", 2], ["hall", "a town hall", "town halls", 3, "square", 1],
  ["market", "a market", "markets", 2, "square", 2], ["well", "a well", "wells", 0, "square", 3], ["lamp", "a lamp post", "lamp posts", 1, "street", 99],
  ["tower", "a watchtower", "watchtowers", 3, "edge", 8], ["keep", "the keep", "keeps", 5, "edge", 1], ["plaza", "the plaza", "plazas", 2, "plaza", 1],
  ["smithy", "a smithy", "smithies", 3, "market", 2], ["bakery", "a bakery", "bakeries", 3, "market", 2], ["tavern", "a tavern", "taverns", 3, "square", 2],
  ["library", "a library", "libraries", 4, "square", 1], ["chapel", "a chapel", "chapels", 4, "square", 2], ["barn", "a barn", "barns", 4, "fields", 3],
  ["fountain", "a fountain", "fountains", 5, "square", 3], ["monument", "a monument", "monuments", 5, "square", 6], ["cathedral", "the cathedral", "cathedrals", 6, "square", 1],
] as [Kind, string, string, number, District, number][]) if (!KIND_INFO[k]) kind(k, one, many, from, district, most);

/** How big the catalog is: designs, and kinds with at least one design. */
export const catalogSize = () => ({ designs: Object.keys(DESIGNS).length, kinds: Object.keys(KINDS).filter((k) => KINDS[k].designs.length).length });
