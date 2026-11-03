// The day plan and the town board: what a day looks like for the three, and how the town's work is shared out, so they
// work as a team instead of three players each deciding everything from scratch.
//
// A day (20 minutes, time 0 to 24000): dawn, wake up, eat, take food and what the job needs from the storehouse, check
// the board; morning and midday, gather and build by role; afternoon, farm, smelt, craft parts, upgrade; dusk, put the
// day's haul in the storehouse and go home before dark; night, sleep (with no bed, dig in and mine underground).
//
// The board (kept in pack.json) gives each living AI a role for the day: the builder builds the town's project, the
// mason gets stone and ore (and smelts in the afternoon), the woodcutter gets oak and sand (and makes the streets and
// lamp posts in the afternoon), the farmer keeps the town fed. Roles go to what the project is short of (after what is
// in the storehouse and the builder's bag) and to whoever is best placed for each (the one on the building site
// builds, the best pickaxe mines, the axe chops, the hoe farms). Nobody does what another is doing.
//
// The job queue: the board always holds a long list of concrete jobs, most urgent first: repairs and half-built
// buildings, the next stage's needs (build this, upgrade that), the tree farm and its harvest, what the jobs at the
// top are short of (stock the storehouse with it), the streets and their lamps, upgrades for the stages after, the
// fields' fences, benches and flower beds along the streets, the catalog's buildings for this stage and the next,
// more houses. Each takes the next job for its role when it finishes one (its own role's first, then anything open),
// and nobody takes a job another has.

import { B } from "../shared/blocks.ts";
import { I } from "../shared/items.ts";

export type Slot = "dawn" | "morning" | "midday" | "afternoon" | "dusk" | "night";
/** The parts of a day by time of day (night 12542 to 23459, as the server has it). */
export const SLOTS: { slot: Slot; from: number; to: number; what: string }[] = [
  { slot: "dawn", from: 23460, to: 1200, what: "wake up, eat, take food and what your job needs from the storehouse, and check the board" },
  { slot: "morning", from: 1200, to: 6000, what: "gather and build by your role" },
  { slot: "midday", from: 6000, to: 8400, what: "gather and build by your role: the builder on the project, the others bringing what it is short of" },
  { slot: "afternoon", from: 8400, to: 10800, what: "farm, smelt, craft parts, upgrade, make the streets and lamp posts" },
  { slot: "dusk", from: 10800, to: 12542, what: "put the day's haul in the storehouse, then home before dark" },
  { slot: "night", from: 12542, to: 23460, what: "sleep in your bed (with no bed: dig in and mine underground till morning)" },
];

export function slotOf(t: number): Slot {
  const tt = ((t % 24000) + 24000) % 24000;
  for (const s of SLOTS) if (s.from < s.to ? tt >= s.from && tt < s.to : tt >= s.from || tt < s.to) return s.slot;
  return "morning";
}
export const slotText = (s: Slot) => SLOTS.find((x) => x.slot === s)!.what;

export type Role = "builder" | "mason" | "woodcutter" | "farmer";
export const ROLES: Record<Role, string> = {
  builder: "builds the town's project (takes what it needs from the storehouse first)",
  mason: "stone and ore: cobblestone, coal and iron for the project; smelts stone bricks, glass and iron in the afternoon",
  woodcutter: "oak logs and sand for the project; makes the streets and lamp posts in the afternoon",
  farmer: "keeps the town fed: fields, wheat and bread, meat; puts the food in the storehouse",
};

/** Raw materials, the way the gatherers bring them in (birch for the birch district, apart from the oak). */
export type Raw = "stone" | "wood" | "birch" | "sand" | "coal" | "iron" | "food";
/** The raw materials an item takes (per one of it), roughly, the way the build job makes it: planks from logs (4 a
 *  log), stairs, slabs, doors, fences and chests from planks, stone bricks from smelted cobblestone, glass from sand,
 *  lanterns from iron and glass, torches from coal. */
const RAW_OF = new Map<number, Partial<Record<Raw, number>>>([
  [B.COBBLESTONE, { stone: 1 }], [B.STONE, { stone: 1 }], [B.STONE_BRICKS, { stone: 1 }], [B.COBBLE_STAIRS, { stone: 1.5 }], [B.STONE_BRICK_STAIRS, { stone: 1.5 }],
  [B.COBBLE_SLAB, { stone: 0.5 }], [B.STONE_BRICK_SLAB, { stone: 0.5 }], [B.COBBLE_WALL, { stone: 1 }], [B.STONE_BRICK_WALL, { stone: 1 }], [B.FURNACE, { stone: 8 }],
  [B.OAK_LOG, { wood: 1 }], [B.OAK_PLANKS, { wood: 0.25 }], [B.OAK_STAIRS, { wood: 0.375 }], [B.OAK_SLAB, { wood: 0.125 }], [B.OAK_FENCE, { wood: 0.4 }],
  [B.OAK_DOOR, { wood: 0.5 }], [B.CHEST, { wood: 2 }], [B.BARREL, { wood: 1.6 }], [B.CRAFTING_TABLE, { wood: 1 }], [B.LADDER, { wood: 0.3 }], [B.OAK_GATE, { wood: 0.75 }],
  [B.GLASS_PANE, { sand: 0.4 }], [B.GLASS, { sand: 1 }], [B.TORCH, { coal: 0.25, wood: 0.05 }], [B.LANTERN, { iron: 1, sand: 0.4, coal: 0.2 }],
  [B.RED_BED, { wood: 0.75 }], [B.BOOKSHELF, { wood: 1.5 }], [I.WATER_BUCKET, { iron: 3 }], [I.BUCKET, { iron: 3 }],
  [B.BIRCH_LOG, { birch: 1 }], [B.BIRCH_PLANKS, { birch: 0.25 }], [B.BIRCH_STAIRS, { birch: 0.375 }], [B.BIRCH_SLAB, { birch: 0.125 }], [B.BIRCH_FENCE, { birch: 0.4 }],
  [B.LAMP, { sand: 8, coal: 0.25 }], [B.STONE_BRICK_WALL, { stone: 1 }], [B.COBBLE_WALL, { stone: 1 }], [B.STONE_BRICK_SLAB, { stone: 0.5 }],
]);
/** Which items count as each raw material in a bag or the storehouse. */
export const RAW_ITEMS: Record<Raw, number[]> = {
  stone: [B.COBBLESTONE, B.STONE, B.STONE_BRICKS],
  wood: [B.OAK_LOG, B.PALM_LOG, B.OAK_PLANKS],
  birch: [B.BIRCH_LOG, B.BIRCH_PLANKS],
  sand: [B.SAND, B.GLASS, B.GLASS_PANE],
  coal: [I.COAL, I.CHARCOAL],
  iron: [I.RAW_IRON, I.IRON_INGOT],
  food: [I.BREAD, I.WHEAT, I.COOKED_PORKCHOP, I.STEAK, I.COOKED_MUTTON, I.COOKED_CHICKEN, I.PORKCHOP, I.BEEF, I.MUTTON, I.CHICKEN, I.APPLE],
};
/** How much one of an item counts for, as the raw material (planks are a quarter of a log). */
export const rawWorth = (raw: Raw, id: number) => ((raw === "wood" && id === B.OAK_PLANKS) || (raw === "birch" && id === B.BIRCH_PLANKS) ? 0.25 : raw === "sand" && id === B.GLASS_PANE ? 0.4 : 1);

/** A bill of items (what a building still needs) in raw materials, rounded up. */
export function rawOf(bill: Map<number, number>): Map<Raw, number> {
  const out = new Map<Raw, number>();
  for (const [id, n] of bill) {
    const r = RAW_OF.get(id);
    if (!r) continue;
    for (const [k, per] of Object.entries(r) as [Raw, number][]) out.set(k, (out.get(k) ?? 0) + per * n);
  }
  for (const [k, n] of out) out.set(k, Math.ceil(n));
  return out;
}

/** How much of a raw material a bag (item -> count) holds. */
export function rawIn(have: Map<number, number>, raw: Raw): number {
  let n = 0;
  for (const id of RAW_ITEMS[raw]) n += (have.get(id) ?? 0) * rawWorth(raw, id);
  return Math.floor(n);
}

/** What each AI has to offer a role: [best pickaxe tier, has an axe, has a hoe or seeds, how far from the project]. */
export interface Hand {
  name: string;
  pick: number;
  axe: boolean;
  farm: boolean;
  far: number;
  /** It is on the project's site right now (building it). */
  onSite: boolean;
  /** Its role yesterday (roles stick unless the need changes). */
  was?: Role;
}

/** Hand out the roles: a builder whenever there is a project, then what the project is short of most (stone, wood),
 *  the farmer when the town is short of food or its next stage needs fields. Each role to whoever is best placed. */
export function assignRoles(hands: Hand[], short: Map<Raw, number>, needFood: boolean): Record<string, Role> {
  const roles: Record<string, Role> = {};
  if (!hands.length) return roles;
  const left = [...hands];
  const take = (score: (h: Hand) => number): Hand => {
    left.sort((a, b) => score(b) - score(a));
    return left.shift()!;
  };
  const builder = take((h) => (h.onSite ? 100 : 0) + (h.was === "builder" ? 20 : 0) - h.far / 4);
  roles[builder.name] = "builder";
  const wants: Role[] = [];
  const stone = (short.get("stone") ?? 0) + (short.get("coal") ?? 0) * 2 + (short.get("iron") ?? 0) * 4;
  const wood = ((short.get("wood") ?? 0) + (short.get("birch") ?? 0)) * 2 + (short.get("sand") ?? 0);
  const order: [Role, number][] = [["mason", stone + 1], ["woodcutter", wood + 0.5], ["farmer", needFood ? 60 : 0]];
  order.sort((a, b) => b[1] - a[1]);
  for (const [r] of order) wants.push(r);
  for (const r of wants) {
    if (!left.length) break;
    const h = take((x) => (x.was === r ? 15 : 0) + (r === "mason" ? x.pick * 10 : r === "woodcutter" ? (x.axe ? 20 : 0) : x.farm ? 20 : 0));
    roles[h.name] = r;
  }
  return roles;
}

/** A role's job for this part of the day, in a few words, for the board and the site. */
export function jobText(role: Role, slot: Slot, project: string, short: Map<Raw, number>): string {
  if (slot === "night") return "sleeping (or mining underground with no bed)";
  if (slot === "dusk") return "putting the day's haul in the storehouse, then home";
  const stone = short.get("stone") ?? 0;
  const wood = short.get("wood") ?? 0;
  switch (role) {
    case "builder":
      return slot === "afternoon" ? `building ${project}, or upgrading` : `building ${project}`;
    case "mason":
      if (slot === "afternoon") return "smelting stone bricks, glass and iron for the upgrades";
      if (stone > 0) return `getting cobblestone for ${project} (${stone} short)`;
      if ((short.get("coal") ?? 0) > 0) return `getting coal for ${project}`;
      if ((short.get("iron") ?? 0) > 0) return `getting iron for ${project}`;
      return "getting cobblestone for the next build";
    case "woodcutter":
      if (slot === "afternoon") return "making the streets and lamp posts";
      if (wood > 0) return `getting oak for ${project} (${wood} logs short)`;
      if ((short.get("birch") ?? 0) > 0) return `getting birch for ${project} (${short.get("birch")} logs short)`;
      if ((short.get("sand") ?? 0) > 0) return `getting sand for ${project}'s glass`;
      return "getting oak for the next build";
    case "farmer":
      return "farming: fields, wheat and bread, food for the town";
  }
}

// ---------------------------------------------------------------- the job queue

export type JobKind = "repair" | "finish" | "build" | "upgrade" | "furnish" | "streets" | "pave" | "light" | "decorate" | "fence" | "plant" | "harvest" | "stock" | "farm" | "smelt";
/** One job on the board: what to do, for whom, how soon. */
export interface Job {
  /** Stable while the job stands, so a claim on it carries over when the queue is made again. */
  id: string;
  kind: JobKind;
  /** The kind it builds or works on ("road", "lamp", "farm" too); for a stock job, the raw material. */
  k: string;
  design?: string;
  /** The building it works on (its middle). */
  at?: [number, number];
  tier?: number;
  /** How many (lamp posts, logs to bring in). */
  n?: number;
  text: string;
  /** The role it suits best. */
  role: Role;
  /** Lower comes first. */
  pri: number;
  by?: string;
  since?: number;
  /** The lot picked for a new building: its rectangle, floor, front and where it is. */
  lot?: { x0: number; z0: number; x1: number; z1: number; y: number; face: number; where: string; design?: string };
}
/** A claim lapses after this long without its holder coming back to it. */
export const CLAIM_MS = 12 * 60000;

/** What the board knows about the town when it draws up the queue (the brain fills it in). */
export interface TownState {
  /** The stage reached (an index into STAGES, -1 none). */
  stage: number;
  /** The next stage's needs in order, and how many the town has of each. */
  needs: { k: string; n: number; tier: number; have: number }[];
  /** The needs of the stages after the next (what the town will want later), for upgrades ahead. */
  later: { k: string; n: number; tier: number }[];
  /** Every building: its kind and design, its name in words, where, its tier and top tier, and its state. */
  buildings: { kind: string; design?: string; name: string; at: [number, number]; tier: number; max: number; done: boolean; fix: boolean; up?: number; next?: string }[];
  /** What the next jobs are short of after the storehouse, in raw materials. */
  short: Partial<Record<Raw, number>>;
  /** What the storehouse holds, in raw materials. */
  stock: Partial<Record<Raw, number>>;
  /** The roads: buildings with doors, how many are joined to the streets, how many by paved ones. */
  roads: { doors: number; joined: number; paved: number };
  lamps: { have: number; want: number };
  /** Street furniture: benches and flower beds, and how many the streets in use take. */
  furniture: { bench: number; flowerbed: number; want: number };
  /** The tree farms: how many, the trees grown in them (ready to cut). */
  trees: { farms: number; grown: number; at?: [number, number] };
  /** The fields: unfenced ones. */
  fields: { at: [number, number] }[];
  /** Food: in the pack's bags and the pool, how much it wants, whether the next stage wants fields. */
  food: { have: number; want: number; fields: boolean };
  /** The catalog's kinds: the stage the board offers each from, the most the town wants, how many it has, its words. */
  kinds: { k: string; one: string; from: number; most: number; have: number; small: boolean; district: string }[];
  /** Upgrades ahead need the furnace's work (stone bricks, glass). */
  smelt: boolean;
  /** The town has a birch district. */
  birch: boolean;
}

const ROLE_OF: Partial<Record<Raw, Role>> = { stone: "mason", coal: "mason", iron: "mason", wood: "woodcutter", birch: "woodcutter", sand: "woodcutter", food: "farmer" };
/** The town's own kinds in words, where the catalog has none. */
const WORDS: Record<string, string> = { wall: "the wall round the town", road: "the roads", lamp: "a lamp post", house: "a house", plaza: "the plaza", farm: "a field" };
const RAW_WORDS: Record<Raw, string> = { stone: "cobblestone", wood: "oak logs", birch: "birch logs", sand: "sand", coal: "coal", iron: "iron", food: "food" };

/** The queue: every job the town has, most urgent first (see the top of this file). */
export function planJobs(s: TownState): Job[] {
  const out: Job[] = [];
  const add = (j: Job) => {
    if (!out.some((o) => o.id === j.id)) out.push(j);
  };
  const where = (at: [number, number]) => `at x=${at[0]} z=${at[1]}`;
  const lowest = (k: string, below: number, n: number) =>
    s.buildings.filter((b) => b.kind === k && b.done && !b.fix && b.tier >= 1 && b.tier < below && b.tier < b.max).sort((a, b) => a.tier - b.tier).slice(0, n);
  const upJob = (b: TownState["buildings"][number], pri: number, why = ""): Job => {
    const t = b.up ?? b.tier + 1;
    const furnish = t === b.max && t >= 3;
    return { id: `up:${b.at}:${t}`, kind: furnish ? "furnish" : "upgrade", k: b.kind, design: b.design, at: b.at, tier: t, text: `${furnish ? "finish and furnish" : "upgrade"} ${b.name} ${where(b.at)} to tier ${t}${b.next ? ` (${b.next})` : ""}${why}`, role: "builder", pri };
  };
  // repairs and what is half done come first: a building that stands half built is in everyone's way
  for (const b of s.buildings) {
    if (b.fix) add({ id: `repair:${b.at}`, kind: b.kind === "treefarm" ? "plant" : "repair", k: b.kind, design: b.design, at: b.at, text: b.kind === "treefarm" ? `replant the tree farm ${where(b.at)} (saplings where the trees were cut)` : `repair ${b.name} ${where(b.at)}`, role: b.kind === "treefarm" ? "woodcutter" : "builder", pri: 10 });
    else if (!b.done) add({ id: `finish:${b.at}`, kind: "finish", k: b.kind, design: b.design, at: b.at, text: `finish ${b.name} ${where(b.at)}`, role: "builder", pri: 12 });
    else if (b.up) add(upJob(b, 14));
  }
  // the next stage, need by need, in the order the stage lists them
  const one = (k: string) => s.kinds.find((x) => x.k === k)?.one ?? WORDS[k] ?? k;
  s.needs.forEach((nd, i) => {
    if (nd.have >= nd.n) return;
    const pri = 20 + i * 0.25;
    let left = nd.n - nd.have;
    if (nd.k === "trade" || (nd.k === "house" && nd.tier === 0)) return;
    if (nd.k === "farm") {
      add({ id: "farm", kind: "farm", k: "farm", text: `make ${left} more field${left > 1 ? "s" : ""} and keep the town fed`, role: "farmer", pri });
      return;
    }
    if (nd.k === "road") {
      add({ id: nd.tier > 1 ? "pave" : "streets", kind: nd.tier > 1 ? "pave" : "streets", k: "road", n: left, text: nd.tier > 1 ? `pave the streets in cobblestone (${left} more buildings on paved streets)` : `extend the streets to the doors (${left} more buildings joined)`, role: "woodcutter", pri });
      return;
    }
    if (nd.k === "lamp") {
      // (the lamp posts aren't each on the list: one job for the lot of them)
      if (nd.tier <= 1) add({ id: "light", kind: "light", k: "lamp", n: left, text: `light the streets: ${left} more lamp post${left > 1 ? "s" : ""}`, role: "woodcutter", pri });
      else add({ id: `up:lamp:${nd.tier}`, kind: "upgrade", k: "lamp", tier: nd.tier, n: left, text: `put lanterns on ${left} more lamp post${left > 1 ? "s" : ""} (tier ${nd.tier})`, role: "woodcutter", pri });
      return;
    }
    const built = s.buildings.filter((b) => b.kind === nd.k && b.done && b.tier >= 1).length;
    if (nd.tier > 1 && built >= nd.n) {
      for (const b of lowest(nd.k, nd.tier, left)) add(upJob(b, pri, ", for the next stage"));
      return;
    }
    // (what is already going up counts: its "finish" job is on the list)
    const started = s.buildings.filter((b) => b.kind === nd.k && !b.done).length;
    left = Math.min(left, nd.n - built) - started;
    const kind = s.kinds.find((x) => x.k === nd.k);
    for (let c = 0; c < Math.min(left, 3); c++) {
      const nth = built + started + c + 1;
      add({ id: `build:${nd.k}:${nth}`, kind: "build", k: nd.k, text: `build ${one(nd.k)}${nd.n > 1 ? ` (${nth} of ${nd.n})` : ""}${kind?.district ? `, ${kind.district}` : ""}`, role: "builder", pri: pri + c * 0.5 });
    }
  });
  // the wood economy: a tree farm near the town before the oak runs out, then its trees cut and the saplings planted again
  if (s.stage >= 0 && !s.trees.farms) add({ id: "build:treefarm:1", kind: "build", k: "treefarm", text: "build a tree farm near the town (oak saplings that grow back: wood without the long trips)", role: "woodcutter", pri: 22 });
  if (s.trees.grown >= 2 && s.trees.at) add({ id: `harvest:${s.trees.at}`, kind: "harvest", k: "treefarm", at: s.trees.at, n: s.trees.grown, text: `cut the ${s.trees.grown} grown trees in the tree farm ${where(s.trees.at)} and plant the saplings again`, role: "woodcutter", pri: 26 });
  // what the jobs at the top are short of, into the storehouse
  for (const [raw, n] of Object.entries(s.short) as [Raw, number][])
    if (n > 0) add({ id: `stock:${raw}`, kind: "stock", k: raw, n: Math.min(64, Math.max(16, n)), text: `stock the storehouse with ${Math.min(64, Math.max(16, n))} ${RAW_WORDS[raw]} (the next builds are short of ${n})`, role: ROLE_OF[raw] ?? "mason", pri: 30 });
  // food when the pack runs low
  if (s.food.have < s.food.want || s.food.fields) add({ id: "farm", kind: "farm", k: "farm", text: `keep the town fed: harvest, bake, hunt (${s.food.have} food in the pack)`, role: "farmer", pri: 32 });
  // the streets out to every door, lamp posts along them
  if (s.roads.doors > s.roads.joined) add({ id: "streets", kind: "streets", k: "road", n: s.roads.doors - s.roads.joined, text: `extend the streets to ${s.roads.doors - s.roads.joined} new door${s.roads.doors - s.roads.joined > 1 ? "s" : ""}`, role: "woodcutter", pri: 34 });
  if (s.lamps.have < s.lamps.want) add({ id: "light", kind: "light", k: "lamp", n: s.lamps.want - s.lamps.have, text: `light the streets: ${s.lamps.want - s.lamps.have} more lamp posts (one every seven blocks)`, role: "woodcutter", pri: 38 });
  // upgrades the stages after this one will ask for
  for (const nd of s.later) if (nd.tier > 1) for (const b of lowest(nd.k, nd.tier, nd.n)) add(upJob(b, 40 + nd.tier, ", for a later stage"));
  if (s.smelt) add({ id: "smelt", kind: "smelt", k: "smelt", text: "smelt stone bricks and glass for the upgrades (cobblestone and sand from the storehouse)", role: "mason", pri: 44 });
  for (const f of s.fields) add({ id: `fence:${f.at}`, kind: "fence", k: "farm", at: f.at, text: `fence the field ${where(f.at)} (a gate toward the town)`, role: "farmer", pri: 46 });
  // street furniture: benches and flower beds along the streets in use
  if (s.stage >= 1) {
    if (s.furniture.bench < s.furniture.want) add({ id: "decorate:bench", kind: "decorate", k: "bench", n: s.furniture.want - s.furniture.bench, text: `put a bench beside the streets (${s.furniture.bench} of ${s.furniture.want})`, role: "builder", pri: 50 });
    if (s.furniture.flowerbed < s.furniture.want) add({ id: "decorate:flowerbed", kind: "decorate", k: "flowerbed", n: s.furniture.want - s.furniture.flowerbed, text: `plant a flower bed beside the streets (${s.furniture.flowerbed} of ${s.furniture.want})`, role: "farmer", pri: 51 });
  }
  // every building up to its top tier, the lowest first; the last tier is the finishing and the furniture
  for (const b of s.buildings) if (b.done && !b.fix && !b.up && b.tier >= 1 && b.tier < b.max) add(upJob(b, 54 + b.tier * 3));
  if (s.stage >= 3 && s.roads.paved < s.roads.joined) add({ id: "pave", kind: "pave", k: "road", text: `pave the streets in cobblestone (${s.roads.joined - s.roads.paved} buildings on dirt paths)`, role: "woodcutter", pri: 58 });
  // the catalog: what this stage and the next can have, the small quick ones first; the stages after, later on
  const wanted = new Set(s.needs.map((n) => n.k));
  for (const k of s.kinds) {
    if (wanted.has(k.k) || k.have >= k.most || k.district === "beside a street" || k.from > s.stage + 3) continue;
    if (s.buildings.some((b) => b.kind === k.k && !b.done)) continue; // one going up already: its finish job is there
    const pri = (k.from <= s.stage + 1 ? 60 : 72) + Math.max(0, k.from - s.stage) * 2 + (k.small ? 0 : 3);
    add({ id: `build:${k.k}:${k.have + 1}`, kind: "build", k: k.k, text: `build ${k.one}${k.district ? `, ${k.district}` : ""}`, role: k.k === "quarry" ? "mason" : k.k === "treefarm" || k.k === "lumberyard" ? "woodcutter" : ["garden", "orchard", "pen", "coop", "granary"].includes(k.k) ? "farmer" : "builder", pri });
  }
  // the pool kept stocked for whatever comes next
  const keep: [Raw, number][] = [["stone", 64], ["wood", 32], ["sand", 16], ["coal", 8], ...(s.birch ? ([["birch", 24]] as [Raw, number][]) : [])];
  for (const [raw, n] of keep) if ((s.stock[raw] ?? 0) < n) add({ id: `stock:${raw}`, kind: "stock", k: raw, n: n - (s.stock[raw] ?? 0), text: `stock the storehouse with ${n - (s.stock[raw] ?? 0)} ${RAW_WORDS[raw]} (it keeps ${n} for the next builds)`, role: ROLE_OF[raw] ?? "mason", pri: 56 });
  // and the town keeps growing
  const houses = s.buildings.filter((b) => b.kind === "house").length;
  add({ id: `build:house:${houses + 1}`, kind: "build", k: "house", text: "build another house on the next lot", role: "builder", pri: 76 });
  return out.sort((a, b) => a.pri - b.pri);
}

/** The job for one of them: the one it holds (unless the claim lapsed), else the most urgent open job, its own role's
 *  jobs well ahead of the rest (a mason keeps the stone coming before it lays any; with nothing of its own, it helps
 *  build). `can` leaves out what it can't do right now (the afternoon's work, a job someone just gave up on). */
export function pickJob(queue: Job[], role: Role, name: string, now: number, can: (j: Job) => boolean = () => true): Job | null {
  const mine = queue.find((j) => j.by === name && now - (j.since ?? 0) < CLAIM_MS && can(j));
  if (mine) return mine;
  const open = queue.filter((j) => (!j.by || j.by === name || now - (j.since ?? 0) >= CLAIM_MS) && can(j));
  if (!open.length) return null;
  // (another role's job well behind its own: a mason with no hoe doesn't go farming while there is stone to bring in)
  const score = (j: Job) => j.pri + (j.role === role ? -40 : 10);
  return open.reduce((best, j) => (score(j) < score(best) ? j : best));
}
