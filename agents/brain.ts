// clankersmp: an AI's mind. Claude (opus, sonnet or haiku) decides what its body does next, one skill at a time, from
// what it can see, carry and hear. Every decision is one fresh request: the stable instructions and tools first
// (cached), then this moment (its state, what just happened, the chat). Its summarized thinking becomes its private
// thoughts on the site; what it says in chat is public. Reflexes (guard) step in between decisions: a monster in its
// face, hunger, a night out in the open.

import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Body, NIGHT_END, NIGHT_START, inHub, type PlanCell, type Rect, type Seen, type Target } from "./body.ts";
import { SPAWN_X, SPAWN_Z } from "../shared/constants.ts";
import { HUB_R } from "../shared/hub12.ts";
import { DESIGNS, KINDS, ONCE, STAGES, UP_EXTRA, cellTarget, designOf, doorStep, faceToward, farmPlan, homeOf, itemOf, label as civLabel, materialsFor, maxTier, needText, planFor, progress, sizeFacing, wallPlan, type Building, type Kind, type Plain } from "./civ.ts";
import { KIND_INFO, catalogSize } from "./catalog.ts";
import { HEADS, STREET_STYLES, chooseLot, designFor, districtFar, districtOf, keptLots, lotRoom, plazaRect, streetAt, streetPlan, streetSpots, streetsOf, styleOf, wallRadius, STREET_HALF, WALL, type Point } from "./town.ts";
import { CLAIM_MS, ROLES, assignRoles, jobText, pickJob, planJobs, rawIn, rawOf, slotOf, slotText, type Job, type Raw, type Role, type Slot, type TownState } from "./board.ts";
import { VILLAGE_SITES } from "../shared/villages.ts";
import { JOBS } from "../shared/villagers.ts";
import { B, BLOCKS, IS_WATER, SOLID, isStorage } from "../shared/blocks.ts";
import { I, ITEMS, itemDef, type Stack } from "../shared/items.ts";
import { MF, MOB_SPECS } from "../shared/mobs.ts";
import { armorValue } from "../shared/combat.ts";
import { collectObsidian, deepGoal, enchant as enchantGear, isObsidian, tableAt, techText } from "./tech.ts";
import { HEAD_BACK, LAST_START, climbOut, dayClock, miningTrip, oughtToClimbOut, pendingTrip, tripCheck, tripNeeds } from "./mine.ts";
import { messiness, organize } from "./inventory.ts";
import { SPECS as ANIMAL_SPECS } from "../shared/animals.ts";
import { canHarvest } from "../shared/mining.ts";
import { FLAG } from "../shared/protocol.ts";

/** What each AI is working toward and doing right now, as the others can see it (they all run in this process), and
 *  what it has to offer the board's roles (its best pickaxe, an axe, a hoe or seeds, its food, where it is). */
const BOARD = new Map<string, { goal: string; doing: string; pick?: number; axe?: boolean; farm?: boolean; food?: number; x?: number; z?: number; at?: number }>();
/** v13: the monster each of them is fighting right now (the others come and help when they are near). */
const FIGHTS = new Map<string, { id: number; key: string; x: number; z: number; at: number; call: boolean }>();

/** The town board: the roles for the day, the project the builder is on, what it is short of, and what the storehouse
 *  holds (as last counted, chest by chest). Kept in pack.json. */
interface TownBoard {
  day: number;
  at: number;
  roles: Record<string, Role>;
  project: { kind: Kind; up: boolean } | null;
  short: Partial<Record<Raw, number>>;
  /** Kinds that found no spot, and when: the board takes the next need for a while. */
  skip?: Record<string, number>;
  /** The job queue (agents/board.ts): every job the town has, the most urgent first, who is on each; and when it was
   *  drawn up. */
  queue?: Job[];
  qat?: number;
}

/** The pack's shared plan and base: one list all three work from, one place they build up together. */
const PACK: {
  plan: string;
  by: string;
  base: { x: number; y: number; z: number } | null;
  houses: Record<string, Rect & { y: number }>;
  builds: Building[];
  trades: number;
  stage: number;
  /** The middle of the town plan: the plaza's square, the main streets out of it (agents/town.ts). */
  centre?: Point;
  board?: TownBoard;
  /** What is in each of the storehouse's chests, by "x,y,z": item id -> count. */
  chests?: Record<string, Record<number, number>>;
  /** Each main street's district style (north, east, south, west), chosen once: birch where the birch grows. */
  styles?: string[];
} = { plan: "", by: "", base: null, houses: {}, builds: [], trades: 0, stage: -1 };
/** Everything in the storehouse's chests, as last counted. */
function stock(): Map<number, number> {
  const m = new Map<number, number>();
  for (const c of Object.values(PACK.chests ?? {})) for (const [id, n] of Object.entries(c)) m.set(Number(id), (m.get(Number(id)) ?? 0) + n);
  return m;
}

/** Every house built at the base: the ones in the builds list, and each player's newest (an older save kept only
 *  that, so a second house used to drop its first one out of the count and off the map of what's built). */
function houseRects(): (Rect & { y: number; done: boolean })[] {
  const out: (Rect & { y: number; done: boolean })[] = PACK.builds.filter((b) => b.kind === "house");
  for (const h of Object.values(PACK.houses)) if (!out.some((o) => o.x0 === h.x0 && o.z0 === h.z0)) out.push({ ...h, done: true });
  return out;
}
/** A player's own home (build_house: a 4 by 4 shelter round its bed), not a town cottage: a shelter for the camp, never
 *  measured against the cottage design or rebuilt (someone sleeps in it). */
function isHome(b: Rect & { kind?: Kind }): boolean {
  return (b.kind === undefined || b.kind === "house") && (b.x1 - b.x0 === 3 || Object.values(PACK.houses).some((h) => h.x0 === b.x0 && h.z0 === b.z0));
}
/** A building's tier: what it was last measured at (an old record nobody has measured yet: 1). */
const tierOf = (b: Building) => (isHome(b) ? 0 : b.tier ?? 1);
/** Trees: a lot's trees come down before it is built, the canopy and all. */
const TREE_IDS = new Set<number>([B.OAK_LOG, B.BIRCH_LOG, B.PALM_LOG, B.OAK_LEAVES, B.BIRCH_LEAVES, B.PALM_LEAVES]);
const LOG_IDS = new Set<number>([B.OAK_LOG, B.BIRCH_LOG, B.PALM_LOG]);
/** A crafted block: one against a log means the log is somebody's build (a cabin's corner, a fence post), not a tree. */
const BUILT = /plank|glass|cobble|brick|fence|door|slab|stair|torch|lantern|chest|table|furnace|bed|ladder|wall|carpet|wool|barrel|bookshelf|gate|pane|lamp|sign|bars|hay|rail/;
/** The tree a log belongs to: every log joined to it (corners too, for a palm's lean), close round it; its foot (the
 *  lowest log). Null when they look like somebody's build (a crafted block against one) or there are too many. */
export function treeOf(get: (x: number, y: number, z: number) => number, x: number, y: number, z: number): { logs: [number, number, number][]; foot: [number, number, number] } | null {
  if (!LOG_IDS.has(get(x, y, z))) return null;
  const seen = new Set<string>([`${x},${y},${z}`]);
  const logs: [number, number, number][] = [];
  const todo: [number, number, number][] = [[x, y, z]];
  while (todo.length) {
    const c = todo.pop()!;
    logs.push(c);
    if (logs.length > 40) return null;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const n: [number, number, number] = [c[0] + dx, c[1] + dy, c[2] + dz];
          if (Math.abs(n[0] - x) > 4 || Math.abs(n[2] - z) > 4 || n[1] < y - 12 || n[1] > y + 16) continue;
          const k = `${n[0]},${n[1]},${n[2]}`;
          if (seen.has(k) || !LOG_IDS.has(get(...n))) continue;
          seen.add(k);
          todo.push(n);
        }
  }
  for (const [cx, cy, cz] of logs)
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]])
      if (BUILT.test(BLOCKS[get(cx + dx, cy + dy, cz + dz)]?.key ?? "")) return null;
  const foot = logs.reduce((a, c) => (c[1] < a[1] ? c : a));
  return { logs, foot };
}
/** Buildings with a spot of their own in the town plan (the plaza in the middle, the landmarks at the heads of the
 *  avenues): never given up as "a bad spot" (the same spot comes round again), what's in the way gets said instead. */
const FIXED: ReadonlySet<Kind> = new Set<Kind>(["plaza", ...(Object.keys(HEADS) as Kind[])]);
/** The spawn hub as rectangles (strips of its circle), for site searches that take rectangles to keep off. */
const HUB_RECTS: Rect[] = (() => {
  const R = HUB_R + 4;
  const out: Rect[] = [];
  for (let z = -R; z <= R; z += 4) {
    const zz = z <= 0 && z + 3 >= 0 ? 0 : Math.min(Math.abs(z), Math.abs(z + 3));
    const half = Math.ceil(Math.sqrt(Math.max(0, R * R - zz * zz)));
    out.push({ x0: SPAWN_X - half, x1: SPAWN_X + half, z0: SPAWN_Z + z, z1: SPAWN_Z + z + 3 });
  }
  return out;
})();
/** A plan without its cells inside the spawn hub: nothing is ever dug there (body.mine), so a building or a street
 *  whose corner runs into the hub is done without that corner (the hub is levelled already). */
function noHub<T extends { cells: PlanCell[]; of?: number[] }>(p: T): T {
  const keep = p.cells.map((c) => !inHub(c[0], c[2]));
  if (keep.every(Boolean)) return p;
  return { ...p, cells: p.cells.filter((_, i) => keep[i]), of: p.of?.filter((_, i) => keep[i]) };
}
/** A kind as the thing being built (the roads are one network: "the roads", not "a building joined by a path"). */
const nameOf = (k: Kind) => (k === "road" ? "the roads" : civLabel(k));
/** A building's top tier, by its own design. */
const topOf = (b: { kind: Kind; design?: string }) => maxTier(b.kind, b.design);
/** What a tier adds to a building, by its own design. */
const upOf = (b: { kind: Kind; design?: string }, t: number) => (b.kind === "farm" || b.kind === "road" ? UP_EXTRA[b.kind][t] : (DESIGNS[b.design ?? ""] ?? DESIGNS[b.kind])?.up[t] ?? KINDS[b.kind]?.up[t]) ?? "";
/** A building in words, by its design: "an oak cottage (gable)", else its kind's word. */
const designName = (b: { kind: Kind; design?: string }) => {
  const d = b.design && b.design !== b.kind ? DESIGNS[b.design] : undefined;
  return d ? `${/^[aeiou]/i.test(d.name) ? "an" : "a"} ${d.name}` : nameOf(b.kind);
};
/** The natural ground under a lot's trees. */
const GROUND_IDS = new Set<number>([B.GRASS, B.DIRT, B.SAND, B.GRAVEL, B.CLAY, B.STONE]);
const FLOWER_IDS = new Set<number>([B.POPPY, B.DANDELION, B.BLUEBELL]);
/** How many of a kind the pack has finished, at a tier or better. Houses at tier 0 are any shelter (the homes too);
 *  "road" counts the buildings the paths join to the plaza (paved ones at tier 2). */
function civCount(k: Kind | "trade", tier = 1): number {
  if (k === "trade") return PACK.trades;
  if (k === "road") return PACK.builds.find((b) => b.kind === "road")?.joined?.[tier >= 2 ? 1 : 0] ?? 0;
  if (k === "house" && tier <= 0) return houseRects().filter((h) => h.done).length;
  return PACK.builds.filter((b) => b.kind === k && b.done && tierOf(b) >= tier).length;
}
/** Everything built or being built: where new buildings must not go (the wall and the roads are lines, not lots). */
let lastAudit = 0;
/** Where each agent is mining right now, so two don't work the same tree or the same spot. */
const MINING = new Map<string, { x: number; z: number; at: number }>();
/** Groves a logging trip came back from empty-handed (trees up a cliff or across water): left out for 10 minutes, so
 *  the next trip picks another (sonnet walked 125 blocks out to oaks on a cliff and circled them for minutes). */
const BAD_GROVES: { x: number; z: number; until: number }[] = [];
const badGrove = (x: number, z: number) => BAD_GROVES.some((g) => g.until > Date.now() && Math.hypot(g.x - x, g.z - z) < 14);
const takenByOther = (me: string, x: number, z: number) => [...MINING].some(([n, m]) => n !== me && Date.now() - m.at < 20000 && Math.hypot(m.x - x, m.z - z) < 5);
function footprints(): Rect[] {
  return [...houseRects(), ...PACK.builds.filter((b) => b.kind !== "house" && b.kind !== "road").map((b) => (b.kind === "wall" ? { x0: b.x0 + 1, z0: b.z0 + 1, x1: b.x0 + 1, z1: b.z0 + 1 } : b))];
}
let packFile = "";
function loadPack(): void {
  if (packFile) return;
  packFile = join(process.env.AGENT_STATE_DIR || join(process.cwd(), "agent-state"), "pack.json");
  try {
    const j = JSON.parse(readFileSync(packFile, "utf8"));
    PACK.plan = typeof j.plan === "string" ? j.plan : "";
    PACK.by = typeof j.by === "string" ? j.by : "";
    if (j.base && typeof j.base.x === "number") PACK.base = j.base;
    if (j.houses && typeof j.houses === "object") PACK.houses = j.houses;
    if (Array.isArray(j.builds)) PACK.builds = j.builds;
    // farms once counted again for every planting by the same pond: one farm per field
    const fields: Building[] = [];
    PACK.builds = PACK.builds.filter((b) => {
      if (b.kind !== "farm") return true;
      if (fields.some((f) => b.x0 <= f.x1 && b.x1 >= f.x0 && b.z0 <= f.z1 && b.z1 >= f.z0)) return false;
      fields.push(b);
      return true;
    });
    if (typeof j.trades === "number") PACK.trades = j.trades;
    if (typeof j.stage === "number") PACK.stage = j.stage;
    if (j.centre && typeof j.centre.x === "number" && typeof j.centre.z === "number") PACK.centre = { x: j.centre.x, z: j.centre.z };
    if (j.board && typeof j.board === "object" && j.board.roles) PACK.board = j.board;
    if (j.chests && typeof j.chests === "object") PACK.chests = j.chests;
    if (Array.isArray(j.styles) && j.styles.length === 4) PACK.styles = j.styles;
  } catch {
    // no pack yet
  }
}
function savePack(): void {
  try {
    mkdirSync(dirname(packFile), { recursive: true });
    writeFileSync(packFile, JSON.stringify(PACK));
  } catch (e) {
    console.error("couldn't save the pack's plan", (e as Error).message);
  }
}

export const MODELS: Record<string, string> = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" };
/** Dollars an hour each may spend before it slows down (normal play is well under). */
const HOURLY_BUDGET: Record<string, number> = { "claude-opus-5-5": 4, "claude-sonnet-5-5": 2, "claude-haiku-5-5": 0.5 };
const PRICE: Record<string, [number, number]> = { "claude-opus-5-5": [4, 20], "claude-sonnet-5-5": [2, 10], "claude-haiku-5-5": [0.1, 0.5] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const key = (id: number) => itemDef(id)?.key ?? BLOCKS[id]?.key ?? String(id);
const dirWord = (dx: number, dz: number) => {
  const a = (Math.atan2(dx, -dz) * 180) / Math.PI; // 0 = north (-z), 90 = east (+x)
  return ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round(((a + 360) % 360) / 45) % 8].replace("-", " ");
};

const SURVIVAL_RECIPES = [
  "oak_planks", "birch_planks", "oak_planks_from_palm", "sticks", "crafting_table", "torch", "furnace", "chest", "bed", "bowl",
  "wooden_pickaxe", "wooden_axe", "wooden_shovel", "wooden_sword", "stone_pickaxe", "stone_axe", "stone_shovel", "stone_sword",
  "iron_pickaxe", "iron_axe", "iron_sword", "diamond_pickaxe", "diamond_sword", "leather_helmet", "leather_chestplate", "leather_leggings",
  "leather_boots", "iron_helmet", "iron_chestplate", "iron_leggings", "iron_boots", "bucket", "bread", "bow", "arrow", "door", "ladder", "fence",
  "fence_gate", "oak_stairs", "oak_slab", "cobblestone_stairs", "cobblestone_slab", "cobblestone_wall", "stone_bricks", "stone_brick_stairs",
  "stone_brick_slab", "stone_brick_wall", "glass_pane", "lantern", "barrel", "trapdoor", "birch_stairs", "birch_slab", "birch_fence", "lamp", "hay_bale",
  // v13: the way to enchanting, and the rest of the diamond kit
  "iron_shovel", "diamond_axe", "diamond_shovel", "diamond_helmet", "diamond_chestplate", "diamond_leggings", "diamond_boots", "paper", "book", "bookshelf", "enchanting_table",
];

/** Everything the build tool can put up (the wall and the roads besides the buildings on lots): the town's first
 *  kinds and the whole catalog (agents/catalog.ts). */
const BUILD_KINDS = [...(Object.keys(KINDS) as Kind[]).filter((k) => k !== "wall"), "wall", "road"] as Kind[];
/** The kinds for the build tool, in words: the town's own with what they are, the catalog's by name. */
const buildList = () => {
  const first = ["house", "storehouse", "well", "lamp", "market", "plaza", "hall", "smithy", "bakery", "tavern", "tower", "library", "chapel", "barn", "keep", "fountain", "monument", "cathedral"];
  const own = first.filter((k) => KINDS[k]).map((k) => `${k} (${KINDS[k].what}; ${KINDS[k].blocks[1]} blocks)`);
  const more = Object.keys(KINDS).filter((k) => !first.includes(k) && k !== "wall" && KINDS[k].designs.length).map((k) => `${k} (${civLabel(k)}, ${KINDS[k].blocks[1]} blocks)`);
  return `${own.join("; ")}; and from the catalog, ${more.join(", ")}`;
};

const SYSTEM = (name: string) => `You are ${name}, a Claude model with a body in a hardcore survival game that plays like Minecraft. You act through the tools. Three players share this world: opus, sonnet and haiku. All three of you are Claude models.
Hardcore means one life. If you die you are out of this world for good, and the others carry on without you.
What this world is about: you three build a civilization together, from nothing. Start with a camp and grow it, stage by stage, into a capital, and see how far you can take it before the world takes you. A real town takes many hours of work: count and quality both matter, and every building can be upgraded to better tiers. The stages, each on top of the one before, are tracked for you every turn:
${STAGES.map((st) => `- ${st.name}: ${st.needs.map((n) => needText(n)).join(", ")}`).join("\n")}
Everything is built at the pack's base (the first house anyone builds becomes it), on a town plan: the plaza in the middle, main streets out of it north, east, south and west, ring roads further out, every building on a lot facing its street in its own district (the hall, the market, the tavern and the chapel on the square, the smithy and the bakery on the market street, houses along the streets, watchtowers at the town's corners, the cathedral at the head of the north avenue, the keep at the head of the west street), the wall round the old town with gates where the main streets go through. Each main street is one district in one style (the north avenue stone, the market streets timber-framed, the south street oak, birch where the birch woods are), so a street is of a piece: tall two-storey houses round the middle, cottages and lodges inside the wall, longhouses and farmhouses further out; across the street from a building stands its twin. The town has a catalog of ${catalogSize().designs} designs in ${catalogSize().kinds} kinds (homes in every style and size, workshops, farm buildings, silos and windmills, quarries, piers and a lighthouse, gatehouses and bastions, a school, an inn, a temple, clock towers, statues, gardens, a park, tree farms, benches and flower beds): the board lists what to build next and where. Build things with build (${BUILD_KINDS.join(", ")}), farms with farm, and make any of them better with upgrade. Houses count both ways: your own home with build_house (small, it holds your bed), or a cottage with build house that anyone can build or carry on. A building takes many blocks and can be built in turns: anyone can carry on with a building another one started. Every death makes the pack weaker. You still have full control: how you treat the other two is your call.

You work as a team, on a day plan and a town board:
- The day: dawn (wake, eat, take food and what your job needs from the storehouse, check the board), morning and midday (gather and build by your role), afternoon (farm, smelt, craft parts, upgrade, the streets and lamp posts), dusk (put the day's haul in the storehouse, then home before dark), night (sleep in your bed; with no bed, dig in and mine underground till morning).
- The board gives each of you a role for the day by what the town needs and who is best placed: the builder builds the town's project, the mason gets stone and ore (and smelts in the afternoon), the woodcutter gets oak, birch and sand, keeps the tree farm cut and planted (and makes the streets and lamp posts in the afternoon), the farmer keeps the town fed. Nobody does what another is already doing.
- The board also keeps the job list: a long list of concrete jobs, the most urgent first (repairs, the next stage's buildings on their lots, the tree farm, stocking the storehouse with what the next builds are short of, streets and lamp posts, upgrades, benches and flower beds, the catalog's buildings, more houses). work takes the next job for your role when you finish one; with none of your own, you help with the next open one.
- The storehouse is the pack's pool: whatever you gather for the town goes in its chests (storehouse put), and the builder takes what a build needs from it (build does that by itself). Before there is a storehouse, bring the builder what it is short of (give).
- work does your job on the board for this part of the day, start to finish (gathering what the project is short of and putting it in the storehouse, building, farming, the dusk round). It is the usual thing to do. Do something else when you have a reason to (a fight, a trade, a friend in trouble, a better idea for the town: then say so, and pack_plan it).
- When you hand something over or finish something, one short line in chat is enough; the board tells the others the rest.

The world: an island about 500 blocks across, surrounded by ocean. You are not alone on it: there are villages of villagers (each with houses, a well, wheat farms, a smithy with furnaces), and villagers trade with rubies, the island's money (try trade next to one to see what they buy and sell). The farmer's and the smith's houses in each village have a chest with loot (food, seeds, iron, coal, rubies): loot_chest takes it. Small islands off the coast hide treasure chests with iron, gold, diamonds and rubies. Ruby ore is in the rock too. A day is 20 minutes. Night runs from time 12500 to about 23500. In the dark, monsters come out: Shamblers (slow, hit hard up close), Rattlers (archers, they shoot from range) and Skitters (fast, they climb walls). Shamblers and Rattlers burn in daylight. Pigs, cows, sheep and chickens are food. Raw meat works, cooked meat feeds you more. Hunger drops as you act. You heal only while hunger is high, so eat before it gets low.

How to play well:
- Every turn, call one to three action tools, in the order you want them done. They run one after another, so plan a few steps ahead and you're never standing around (for example collect, then craft, then build_house). If one fails or something attacks you, the rest are skipped. In the same turn you may also call say, when you have something to tell the others.
- Play like a good, fast player: keep busy in daylight and always be working toward the next thing you need. There is always work for the town: the next stage, an upgrade, roads, lamp posts. Never wait for dusk with nothing to do.
- First day, in this order: oak_log, then oak_planks, sticks, a crafting_table and a wooden_pickaxe. Then cobblestone for a stone_pickaxe and a stone_sword (collect cobblestone digs a staircase down into the rock and walks back up it).
- For building, get stone the way a player does: one collect cobblestone digs a staircase into the rock and brings back a stack, and wood (oak_log, crafted into planks) comes from trees. A town of cobblestone and planks looks like a town. Dirt only tops you up when you're a few blocks short: don't go digging holes for it. Then kill 3 sheep for wool and craft a bed (3 wool and 3 planks). Then coal_ore for torches. Get food from animals as you go.
- A house keeps you safe at night. Your real home is one of the town's cottages: once one is finished and nobody lives in it, build_house moves you in (your bed goes in its place). Before there is one, build_house puts up a small shelter (about 38 cobblestone, planks or dirt: walls, a roof, your bed and a torch). Beds only go in houses. From then on go_home every evening before dark.
- Food for a growing town comes from farms: a hoe (wooden_hoe or stone_hoe) and wheat_seeds (from breaking tall grass, or a village farm), then farm beside water. Harvest the wheat when it is ripe (harvest) and craft bread.
- Set yourself a goal (set_goal) and keep notes (note): you only see your last few actions, so write down what matters (where your house is, where the iron was, what the others said or did).
- You can stay with another player for a while (follow_player), hand them things (give), or talk to them (say).
- Nights: sleep in your bed (sleep). The night is skipped once half of the living players are asleep at the same time, so it is over in seconds. Only without a bed: when night falls (time 12500), dig_in, and use the night to mine around you underground (collect cobblestone, coal_ore, iron_ore) with your roof kept closed. At night you stay shut in: exploring, long walks, hunting, dig_out and gathering in the open all wait for dawn, and collect mines a staircase down from inside your sealed hole and shuts it again after.
- In the morning, or any time you are in a hole by day, dig_out right away. Never wait around in the daytime.
- If something failed, don't do the same thing again: change what you ask for, move somewhere else, or do something else first.
- With a weapon, kill what attacks you, Rattlers too (charge them: they are weak up close). Back off only when you are badly hurt. Without a weapon, keep away from monsters at night.
- Stone only drops cobblestone if you mine it with a pickaxe.
- Deep caves (below about y 30) are dark and full of Rattlers: everyday mining (collect) stays near the surface. The deep, where the diamonds, rubies and most iron are, is for a mine_trip: in the morning (dawn to time ${LAST_START}), armoured, with an iron pickaxe, a real weapon, torches, food and spare blocks. It digs a lit staircase down to the diamond layer, tunnels to the diamonds it knows of mining every ore on the way, blocks off the caves it opens, comes back up before dusk and puts the haul in the storehouse. Never deep at night. If you end up underground, dig_out digs a staircase back up to the open sky from anywhere.
- Armor goes on by itself as soon as you have it.
- Chat is public. Everyone in the world sees it. Only say something when you have something to say to the others, like a question, an offer, a warning or a request. Do not narrate your own actions or plans.
- Names of blocks and items are lowercase with underscores, like oak_log, cobblestone, wooden_pickaxe, porkchop.
- Recipes you can craft: ${SURVIVAL_RECIPES.join(", ")}. Iron: mine iron_ore with a stone pickaxe, then smelt the raw_iron in a furnace (8 cobblestone) with coal, charcoal, planks or logs as fuel. Smelting raw meat cooks it, which feeds you more.
- Gear decides fights. After stone tools, iron armour comes first (24 iron for all four pieces: it takes more than half off every hit), with an iron sword and pickaxe. A bow (3 string from skitters, 3 sticks) and arrows (flint from gravel, a stick, a feather from chickens) let you shoot rattlers from range instead of charging them. Your reflexes fight well on their own: they shoot back with a bow, charge archers, take a pillar two blocks up out of shamblers' reach, step back out of reach while the weapon recharges, and go to help each other.
- Then the way to enchanted gear, the strongest kit there is (the turn shows your next step): diamonds (deep, y 4 to 16): 3 for a diamond_pickaxe and 2 for the table. Obsidian x4: a smith in a village sells a lava_bucket for 2 rubies and an empty bucket; collect obsidian pours it onto water, where it sets, and mines it (only a diamond pickaxe can). A book: 3 paper (sugar_cane) and 1 leather (cows). The enchanting_table: the book on 2 diamonds and 4 obsidian. enchant puts the table up at the base and enchants your gear for rubies (the island's money: ruby_ore deep down, or trade): Sharpness for swords and axes, Protection for armour, Efficiency for pickaxes and shovels; level 1 costs 2 rubies, level 2 needs 5 bookshelves round the table (4 rubies), level 3 needs 10 (7 rubies). One table for the whole pack: share it.`;

const TOOLS: Anthropic.Tool[] = [
  { name: "collect", description: "Find, mine and pick up blocks of one kind nearby. Logs: oak_log. Stone: cobblestone (needs a pickaxe). Also dirt, sand, coal_ore and other ores. Obsidian: pours your lava_buckets onto water nearby (or into a pool from your water_bucket) and mines it with a diamond pickaxe.", input_schema: { type: "object", properties: { item: { type: "string" }, count: { type: "integer", minimum: 1, maximum: 32 } }, required: ["item", "count"] } },
  { name: "craft", description: "Craft from your inventory, by recipe name. Several in one go, in order, saves time: recipe \"oak_planks x4, sticks, crafting_table, wooden_pickaxe\". Recipes bigger than 2x2 use a crafting table: a nearby one, or one you carry gets placed.", input_schema: { type: "object", properties: { recipe: { type: "string" }, count: { type: "integer", minimum: 1, maximum: 16 } }, required: ["recipe"] } },
  { name: "eat", description: "Eat the best food you carry.", input_schema: { type: "object", properties: {} } },
  { name: "attack", description: "Fight a creature or a player until it is dead or gone. target: shambler, rattler, skitter, pig, cow, sheep, chicken, or a player's name. You use your best weapon.", input_schema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] } },
  { name: "dig_in", description: "Dig straight down three blocks and close the hole over your head: safe from monsters. Use it before night.", input_schema: { type: "object", properties: {} } },
  { name: "dig_out", description: "Climb back up to the surface from anywhere underground: out of your hole, then a staircase dug up through the rock until you see the sky.", input_schema: { type: "object", properties: {} } },
  { name: "mine_trip", description: "A deep mining trip for diamonds, rubies and iron, by day: from open ground outside the town, a lit staircase down to the diamond layer (y 11), a tunnel to the nearest diamonds it knows of, every ore its walls show mined (whole veins), caves it breaks into blocked off, then back up the same way before dusk and the haul into the storehouse (it keeps what its own next gear needs). Mornings only, and only armoured with an iron pickaxe, a real weapon, 8+ torches, food and 16 spare blocks; a stone_pickaxe as well digs the stone and saves the iron one for the ores. Cut short by a fight, call it again to carry on.", input_schema: { type: "object", properties: {} } },
  { name: "dig_down", description: "Dig straight down a few blocks, to reach stone and ores.", input_schema: { type: "object", properties: { blocks: { type: "integer", minimum: 1, maximum: 8 } }, required: ["blocks"] } },
  { name: "go_to_player", description: "Walk over to another player.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "go_to", description: "Walk to coordinates.", input_schema: { type: "object", properties: { x: { type: "number" }, z: { type: "number" } }, required: ["x", "z"] } },
  { name: "explore", description: "Walk about 40 blocks in a direction to find new things.", input_schema: { type: "object", properties: { direction: { type: "string", enum: ["north", "south", "east", "west"] } }, required: ["direction"] } },
  { name: "give", description: "Walk to a player and throw them items from your inventory.", input_schema: { type: "object", properties: { player: { type: "string" }, item: { type: "string" }, count: { type: "integer", minimum: 1, maximum: 64 } }, required: ["player", "item", "count"] } },
  { name: "place", description: "Place a block from your inventory next to you (a crafting_table, a furnace, a chest, dirt...).", input_schema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] } },
  { name: "smelt", description: "Smelt or cook in a furnace: raw_iron to iron_ingot, raw_gold, sand to glass, logs to charcoal, raw meat to cooked. Uses a furnace nearby or places the one you carry, and your own fuel. Takes 10 seconds per item.", input_schema: { type: "object", properties: { item: { type: "string" }, count: { type: "integer", minimum: 1, maximum: 16 } }, required: ["item"] } },
  { name: "sleep", description: "Sleep in a bed at night: a bed nearby, or the one you carry gets placed. The night is skipped once half of the living players are asleep.", input_schema: { type: "object", properties: {} } },
  { name: "pick_up", description: "Pick up the dropped items lying near you.", input_schema: { type: "object", properties: {} } },
  { name: "flee", description: "Run away from the nearest danger.", input_schema: { type: "object", properties: {} } },
  { name: "wait", description: "Stay where you are for a while (like sealed in at night). Not in daylight: there is always work for the town.", input_schema: { type: "object", properties: { seconds: { type: "integer", minimum: 2, maximum: 30 } }, required: ["seconds"] } },
  { name: "build", description: `Build one of the town's buildings at the pack's base, or carry on with one that is half built, needs fixing, or is an old design to rebuild: ${buildList()}; road (the streets out of the plaza and a path from every door to them, dug with a shovel; build it again to reach new doors). It is one whole job: it takes what the plan needs from the storehouse, fetches the rest by itself (mines cobblestone, chops oak, crafts planks, stairs, slabs, doors and fences) and comes back to carry on, so just call build. Torches need coal. Each part is one material, the way the villages are built. A new building goes on a lot of the town plan, its front to the street. You need to be near the base.`, input_schema: { type: "object", properties: { what: { type: "string", enum: BUILD_KINDS } }, required: ["what"] } },
  { name: "upgrade", description: "Upgrade one of the town's buildings to its next tier (the lowest of that kind first, or carry on with one already under way): it mines out the lower-grade blocks and puts the better ones in, and adds the new details and furniture. Tier 2 is better materials and details (stone bricks: cobblestone smelted to stone and crafted; glass panes: sand smelted to glass; a chimney, tables, chairs, beds), tier 3 the finishing touches (lanterns: 2 iron_ingot, 2 glass_pane and a torch make 2). It smelts and crafts what it can by itself from what you carry, gather and find in the storehouse; iron you bring. The town's later stages ask for buildings at tier 2 and 3. Farms (a fence, then lanterns) and roads (paved in cobblestone) upgrade too.", input_schema: { type: "object", properties: { what: { type: "string", enum: [...BUILD_KINDS, "farm"] } }, required: ["what"] } },
  { name: "work", description: "Do your next job from the town board's job list, one whole step of it: your role's jobs first (the builder builds and upgrades; the mason stocks the storehouse with stone, coal and iron and smelts; the woodcutter cuts and replants the tree farm, brings oak, birch and sand, makes the streets and lamp posts; the farmer keeps the town fed, fences the fields, plants flower beds), then any open job. Whoever gathered puts it in the storehouse (or brings it to the builder before there is one). At dawn it gets you up and fed, at dusk it puts the day's haul away and takes you home, at night it puts you to bed.", input_schema: { type: "object", properties: {} } },
  { name: "storehouse", description: "The pack's pool in the storehouse's chests. put: put what you carry for the town in (with no item, everything a builder can use beyond what you need yourself: stone, wood, sand, glass, coal, iron, crafted parts, spare food). take: take an item out (count). look: what is in there.", input_schema: { type: "object", properties: { action: { type: "string", enum: ["put", "take", "look"] }, item: { type: "string" }, count: { type: "integer", minimum: 1, maximum: 256 } }, required: ["action"] } },
  { name: "farm", description: "Till a field beside water near the base with your hoe and plant your wheat_seeds in it: by a pond within 30 blocks of the base, or, with an empty bucket, it fills the bucket at any water and makes the field at the base. Wheat ripens in about a day.", input_schema: { type: "object", properties: {} } },
  { name: "harvest", description: "Cut the ripe wheat near you and plant the seeds straight back. 3 wheat make bread.", input_schema: { type: "object", properties: {} } },
  { name: "loot_chest", description: "Walk to the nearest chest you haven't emptied (within 48 blocks: the villages' houses, treasure on the islands) and take everything in it.", input_schema: { type: "object", properties: {} } },
  { name: "trade", description: "Trade with the nearest villager (within 24 blocks; they live in the villages), or with the nearest one of a trade (with: smith, farmer, librarian, fisher or mason, anywhere in the village). Without an offer number it walks over and tells you what they trade; with one, it makes that trade (times: how many). The smith sells lava_bucket (for obsidian), the librarian bookshelves and books.", input_schema: { type: "object", properties: { with: { type: "string", enum: ["smith", "farmer", "librarian", "fisher", "mason"] }, offer: { type: "integer", minimum: 0, maximum: 8 }, times: { type: "integer", minimum: 1, maximum: 16 } } } },
  { name: "build_house", description: "Make yourself a home: move into a finished town cottage nobody lives in (your bed goes in), or, with none free, put up a small shelter right here (about 38 cobblestone, planks or dirt: walls, a roof, a door if you have one, your bed and a torch). It becomes your home.", input_schema: { type: "object", properties: {} } },
  { name: "go_home", description: "Go back into your house and shut the door behind you (and sleep, if it's night and your bed is there).", input_schema: { type: "object", properties: {} } },
  { name: "pack_plan", description: "Write down the pack's shared plan: what the three of you are building and who does what. All three see it every turn; anyone can rewrite it as things change.", input_schema: { type: "object", properties: { plan: { type: "string" } }, required: ["plan"] } },
  { name: "go_to_base", description: "Walk back to the pack's base (the first house built becomes it).", input_schema: { type: "object", properties: {} } },
  { name: "set_goal", description: "Write down what you're working toward. It stays in front of you until you change it, and the other players can see it.", input_schema: { type: "object", properties: { goal: { type: "string" } }, required: ["goal"] } },
  { name: "note", description: "Write down something worth remembering (where things are, what someone said or did). You keep your last 10 notes.", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "follow_player", description: "Stay close to another player for a while (up to 60 seconds): to travel, work or fight alongside them.", input_schema: { type: "object", properties: { name: { type: "string" }, seconds: { type: "integer", minimum: 5, maximum: 60 } }, required: ["name"] } },
  { name: "enchant", description: "Enchant your gear at the pack's enchanting table, for rubies: an item you carry or wear (item), or the best thing to make better first (your weapon, then your armour, then your pickaxe), at the highest level the table's bookshelves allow (or level). Puts the table up at the base first if you carry one and none stands, and puts any bookshelves you carry round it.", input_schema: { type: "object", properties: { item: { type: "string" }, level: { type: "integer", minimum: 1, maximum: 3 } } } },
  { name: "say", description: "Say something in the public chat. Everyone in the world reads it.", input_schema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
];
TOOLS[TOOLS.length - 1].cache_control = { type: "ephemeral" };

/** Which blocks to mine for a requested item, and which items count as getting it. */
function miningPlan(name: string): { blocks: number[]; gets: number[] } | null {
  const n = name.toLowerCase().replace(/\s+/g, "_").replace(/s$/, "");
  const id = (k: string) => ITEMS.find((d) => d?.key === k)?.id ?? -1;
  const logs = [B.OAK_LOG, B.BIRCH_LOG, B.PALM_LOG];
  const table: Record<string, [number[], number[]]> = {
    oak_log: [logs, logs], log: [logs, logs], wood: [logs, logs], birch_log: [[B.BIRCH_LOG], [B.BIRCH_LOG]], palm_log: [[B.PALM_LOG], [B.PALM_LOG]],
    // the town's timber: oak (palm makes oak planks too), never birch, so a building's wood is one colour (the birch
    // district's birch comes in as birch_log)
    town_log: [[B.OAK_LOG, B.PALM_LOG], [B.OAK_LOG, B.PALM_LOG]],
    // saplings come from leaves (one in twenty)
    sapling: [[B.OAK_LEAVES, B.BIRCH_LEAVES], [B.OAK_SAPLING, B.BIRCH_SAPLING]], oak_sapling: [[B.OAK_LEAVES], [B.OAK_SAPLING]], birch_sapling: [[B.BIRCH_LEAVES], [B.BIRCH_SAPLING]],
    cobblestone: [[B.STONE, B.COBBLESTONE], [B.COBBLESTONE]], stone: [[B.STONE, B.COBBLESTONE], [B.COBBLESTONE]], cobble: [[B.STONE, B.COBBLESTONE], [B.COBBLESTONE]],
    dirt: [[B.DIRT, B.GRASS], [B.DIRT]], grass: [[B.GRASS, B.DIRT], [B.DIRT]], sand: [[B.SAND], [B.SAND]], gravel: [[B.GRAVEL], [B.GRAVEL, id("flint")]],
    coal: [[B.COAL_ORE], [id("coal")]], coal_ore: [[B.COAL_ORE], [id("coal")]], iron_ore: [[B.IRON_ORE], [id("raw_iron")]], raw_iron: [[B.IRON_ORE], [id("raw_iron")]],
    iron: [[B.IRON_ORE], [id("raw_iron")]], gold_ore: [[B.GOLD_ORE], [id("raw_gold")]], diamond: [[B.DIAMOND_ORE], [id("diamond")]], diamond_ore: [[B.DIAMOND_ORE], [id("diamond")]],
    ruby: [[B.RUBY_ORE], [id("ruby")]], ruby_ore: [[B.RUBY_ORE], [id("ruby")]], clay: [[B.CLAY], [id("clay_ball"), B.CLAY]], sugar_cane: [[B.SUGAR_CANE], [B.SUGAR_CANE]],
    apple: [[B.OAK_LEAVES], [id("apple")]], wheat_seed: [[B.TALL_GRASS], [id("wheat_seeds")]], seed: [[B.TALL_GRASS], [id("wheat_seeds")]],
  };
  const hit = table[n] ?? table[name.toLowerCase()];
  if (hit) return { blocks: hit[0], gets: hit[1] };
  const b = BLOCKS.find((d) => d?.key === name.toLowerCase());
  return b ? { blocks: [b.id], gets: [b.item || b.id] } : null;
}

function itemByName(name: string): number {
  const n = name.toLowerCase().replace(/\s+/g, "_");
  const aliases: Record<string, string> = { stick: "stick", sticks: "stick", planks: "oak_planks", log: "oak_log", logs: "oak_log", wood: "oak_log", cobble: "cobblestone", table: "crafting_table", pork: "porkchop" };
  const k = aliases[n] ?? n;
  return ITEMS.find((d) => d?.key === k)?.id ?? ITEMS.find((d) => d?.key === k.replace(/s$/, ""))?.id ?? 0;
}

/** Oak or palm logs (both make oak planks), and coal or charcoal: what a recipe asks for as one. */
const LOGS = -1;
const FUEL = -2;
// what is made from what: [recipe, how many one craft makes, ingredients]; smelted: [from]
const MAKE = new Map<number, { rid: string; out: number; ings: [number, number][] } | { from: number }>([
  [B.LAMP, { rid: "lamp", out: 1, ings: [[B.GLASS, 8], [B.TORCH, 1]] }],
  [B.LANTERN, { rid: "lantern", out: 2, ings: [[I.IRON_INGOT, 2], [B.GLASS_PANE, 2], [B.TORCH, 1]] }],
  [B.BIRCH_STAIRS, { rid: "birch_stairs", out: 4, ings: [[B.BIRCH_PLANKS, 6]] }],
  [B.BIRCH_SLAB, { rid: "birch_slab", out: 6, ings: [[B.BIRCH_PLANKS, 3]] }],
  [B.BIRCH_FENCE, { rid: "birch_fence", out: 3, ings: [[B.BIRCH_PLANKS, 4], [I.STICK, 2]] }],
  [B.BARREL, { rid: "barrel", out: 1, ings: [[B.OAK_PLANKS, 6], [B.OAK_SLAB, 2]] }],
  [B.OAK_STAIRS, { rid: "oak_stairs", out: 4, ings: [[B.OAK_PLANKS, 6]] }],
  [B.OAK_SLAB, { rid: "oak_slab", out: 6, ings: [[B.OAK_PLANKS, 3]] }],
  [B.OAK_FENCE, { rid: "fence", out: 3, ings: [[B.OAK_PLANKS, 4], [I.STICK, 2]] }],
  [B.OAK_GATE, { rid: "fence_gate", out: 1, ings: [[B.OAK_PLANKS, 2], [I.STICK, 4]] }],
  [B.OAK_DOOR, { rid: "door", out: 3, ings: [[B.OAK_PLANKS, 6]] }],
  [B.CHEST, { rid: "chest", out: 1, ings: [[B.OAK_PLANKS, 8]] }],
  [B.CRAFTING_TABLE, { rid: "crafting_table", out: 1, ings: [[B.OAK_PLANKS, 4]] }],
  [B.LADDER, { rid: "ladder", out: 3, ings: [[I.STICK, 7]] }],
  [I.BUCKET, { rid: "bucket", out: 1, ings: [[I.IRON_INGOT, 3]] }],
  [B.TORCH, { rid: "torch", out: 4, ings: [[FUEL, 1], [I.STICK, 1]] }],
  [B.GLASS_PANE, { rid: "glass_pane", out: 16, ings: [[B.GLASS, 6]] }],
  [B.STONE_BRICK_STAIRS, { rid: "stone_brick_stairs", out: 4, ings: [[B.STONE_BRICKS, 6]] }],
  [B.STONE_BRICK_SLAB, { rid: "stone_brick_slab", out: 6, ings: [[B.STONE_BRICKS, 3]] }],
  [B.STONE_BRICK_WALL, { rid: "stone_brick_wall", out: 6, ings: [[B.STONE_BRICKS, 6]] }],
  [B.STONE_BRICKS, { rid: "stone_bricks", out: 4, ings: [[B.STONE, 4]] }],
  [B.COBBLE_STAIRS, { rid: "cobblestone_stairs", out: 4, ings: [[B.COBBLESTONE, 6]] }],
  [B.COBBLE_SLAB, { rid: "cobblestone_slab", out: 6, ings: [[B.COBBLESTONE, 3]] }],
  [B.COBBLE_WALL, { rid: "cobblestone_wall", out: 6, ings: [[B.COBBLESTONE, 6]] }],
  [B.FURNACE, { rid: "furnace", out: 1, ings: [[B.COBBLESTONE, 8]] }],
  [B.STONE, { from: B.COBBLESTONE }],
  [B.GLASS, { from: B.SAND }],
  [I.IRON_INGOT, { from: I.RAW_IRON }],
  [I.STICK, { rid: "sticks", out: 4, ings: [[B.OAK_PLANKS, 2]] }],
  [B.OAK_PLANKS, { rid: "oak_planks", out: 4, ings: [[LOGS, 1]] }],
  [B.BIRCH_PLANKS, { rid: "birch_planks", out: 4, ings: [[B.BIRCH_LOG, 1]] }],
]);
const ORDER = [...MAKE.keys()];
const RAW = [B.COBBLESTONE, LOGS, B.OAK_LOG, B.BIRCH_LOG, B.SAND, I.RAW_IRON, FUEL, B.DIRT, B.OAK_SAPLING, B.BIRCH_SAPLING, B.POPPY, B.DANDELION, B.BLUEBELL];

export class Brain {
  readonly name: string;
  readonly body: Body;
  readonly model: string;
  private client: Anthropic;
  private relay: string;
  private log: string[] = []; // what it did and how that went, newest last
  private heard: string[] = []; // chat and world events, newest last
  private reflexing = false;
  private reflexCount = 0;
  private lastHouseTry = 0;
  private thinking = false;
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private nightOutSince = 0;
  /** Monsters it fought without getting anywhere (behind a wall, across a gap): left alone for a minute. */
  private leftAlone = new Map<number, number>();
  /** Animals it couldn't get to (across water, up a drop), and till when it leaves them be. */
  private unreachable = new Map<number, number>();
  /** Players it couldn't get to just now, and why: not walked to again till then (a gatherer walked to the builder
   *  over and over while it mined at y=25: "couldn't get to opus", six of its last eight actions, season 14). */
  private outOfReach = new Map<string, { until: number; why: string }>();
  private lastTidy = 0;
  private lastHunt = 0;
  private lastHelpCall = 0;
  private lastSort = 0;
  /** Fights it has gone to help with (the monster, till when it won't answer for it again), the last time it helped,
   *  and the last time it said it was coming. */
  private answered = new Map<number, number>();
  private lastHelp = 0;
  private lastHelpReply = 0;
  /** Mining a staircase out of its hole at night (the wait tool): the hole isn't sealed while it does. */
  private holeMining = false;
  private lastClimb = 0;
  /** What the running reflex is, so being shot can cut a walk short. */
  private reflexLabel = "";
  private lastEat = 0;
  private lastPlayerHit = 0;
  private lastFail = "";
  private inWaterSince = 0;
  private lastWear = 0;
  private lastHomeTrip = 0;
  private lastStoreTrip = 0;
  private queue: Record<string, unknown>[] = [];
  private failing = new Map<string, { n: number; why: string; at: number }>(); // what keeps failing, by action
  private skill = ""; // the tool it is carrying out right now
  private flushing = false;
  cost = 0;
  private spend: [number, number][] = []; // [when, dollars] per decision, the last hour
  private day = 0;
  private game: string;

  constructor(name: string, body: Body, apiKey: string, relay: string, gameHttp: string) {
    this.name = name;
    this.body = body;
    this.model = MODELS[name] ?? "claude-haiku-5-5";
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
    this.relay = relay;
    this.game = gameHttp;
    body.onEvent = (type, data) => {
      if (type === "death") {
        this.emit("death", { message: String(data?.message ?? "") });
        this.stopped = true;
      } else if (type === "hurt") {
        const cause = String(data?.cause ?? "");
        if (cause.startsWith("player:")) {
          // another AI hit it: that's its call to answer, now (the running skill stops so it can decide)
          this.heard.push(`${cause.slice(7)} hit you!`);
          if (Date.now() - this.lastPlayerHit > 4000 && !this.reflexing) body.abort = true;
          this.lastPlayerHit = Date.now();
        } else this.heard.push(`You were hurt (${cause.replace("mob:", "by a ")}).`);
      }
    };
  }

  // ---------------------------------------------------------------- telemetry for the site (relay/server.mjs)

  emit(type: string, data: Record<string, unknown> = {}): void {
    this.queue.push({ agent: this.name, type, t: Date.now(), ...data });
    if (this.queue.length > 500) this.queue = this.queue.slice(-500);
    if (!this.flushing) void this.flush();
  }

  private async flush(): Promise<void> {
    this.flushing = true;
    while (this.queue.length) {
      const batch = this.queue.splice(0, 50);
      try {
        await fetch(this.relay + "/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batch), signal: AbortSignal.timeout(3000) });
      } catch {
        // relay down: drop it
      }
    }
    this.flushing = false;
  }

  private status(): void {
    const b = this.body;
    const armor = b.armor.filter((s): s is Stack => !!s).map((s) => key(s.id));
    // in a tunnel or a hole (a roof over it, walls round its head): the camera behind it would be inside the rock,
    // so the director looks for someone out in the open instead
    const fx = Math.floor(b.phys.x);
    const fy = Math.floor(b.phys.y + 0.1);
    const fz = Math.floor(b.phys.z);
    const walls = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) => SOLID[b.get(fx + dx, fy + 1, fz + dz)]).length;
    const under = b.covered() && walls >= 3;
    // (slot, role and job are the day plan and the town board: added fields, the site reads what it knows)
    const slot = slotOf(b.timeOfDay());
    const role = PACK.board?.roles[this.name] ?? null;
    this.emit("status", {
      under,
      health: Math.round(b.stats.hp * 10) / 10, food: b.stats.food, pos: [Math.round(b.phys.x), Math.round(b.phys.y), Math.round(b.phys.z)],
      time: b.timeOfDay(), day: (this.day || 1) - 1, held: b.heldId() ? key(b.heldId()) : null, armor, items: b.inv.filter(Boolean).length, action: b.action, dimension: "overworld",
      slot, role, job: role ? this.jobNow(role, slot) : "",
    });
  }

  /** Every second: its status for the site, and what it is doing and has to offer the board, for the others. */
  beat(): void {
    this.status();
    BOARD.set(this.name, { goal: this.goal, doing: this.body.action, ...this.kit(), x: this.body.phys.x, z: this.body.phys.z, at: Date.now() });
  }

  /** What it has to offer the board's roles, for the others to see (they all run in this process). */
  private kit(): { pick: number; axe: boolean; farm: boolean; food: number } {
    const b = this.body;
    let pick = 0;
    for (const s of b.inv) {
      const t = s ? itemDef(s.id)?.tool : undefined;
      if (t?.kind === "pickaxe") pick = Math.max(pick, 1 + ["wooden", "stone", "iron", "golden", "diamond"].findIndex((m) => key(s!.id).startsWith(m)));
    }
    return {
      pick,
      axe: b.inv.some((s) => s && itemDef(s.id)?.tool?.kind === "axe"),
      farm: b.inv.some((s) => s && (key(s.id).endsWith("_hoe") || s.id === I.WHEAT_SEEDS)),
      food: b.inv.reduce((n, s) => n + (s && itemDef(s.id)?.food ? s.n : 0), 0),
    };
  }

  /** Its job on the board right now, in a few words. */
  private jobNow(role: Role, slot: Slot): string {
    const held = slot !== "night" && slot !== "dusk" ? PACK.board?.queue?.find((j) => j.by === this.name) : undefined;
    if (held) return held.text;
    const p = PACK.board?.project;
    const what = p ? `${p.up ? "the upgrade of " : ""}${nameOf(p.kind)}` : "the next building";
    return jobText(role, slot, what, new Map(Object.entries(PACK.board?.short ?? {}) as [Raw, number][]));
  }

  // ---------------------------------------------------------------- the loop

  private goal = "";
  private notes: string[] = [];
  private stateFile = "";

  /** Its goal, its notes and its home, kept on disk with the world (a restart doesn't make it forget). */
  private load(): void {
    loadPack();
    this.stateFile = join(process.env.AGENT_STATE_DIR || join(process.cwd(), "agent-state"), `${this.name}.json`);
    try {
      const j = JSON.parse(readFileSync(this.stateFile, "utf8"));
      this.goal = typeof j.goal === "string" ? j.goal : "";
      this.notes = Array.isArray(j.notes) ? j.notes.filter((n: unknown) => typeof n === "string").slice(-10) : [];
      if (j.home && typeof j.home.x0 === "number") this.body.home = j.home;
    } catch {
      // nothing saved yet
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      writeFileSync(this.stateFile, JSON.stringify({ goal: this.goal, notes: this.notes, home: this.body.home }));
    } catch (e) {
      console.error(`[${this.name}] couldn't save its notes`, (e as Error).message);
    }
  }

  /** Stay near another player for a while: close in when they move off, watch them when near. */
  private async followPlayer(name: string, seconds: number): Promise<string> {
    const b = this.body;
    const o = [...b.others.values()].find((p) => p.name === name.toLowerCase());
    if (!o) return `${name} isn't in the world`;
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end && !b.abort && !b.dead) {
      const q = b.others.get(o.id);
      if (!q || q.flags & FLAG.DEAD) return `${name} is gone`;
      if (Math.hypot(q.x - b.phys.x, q.z - b.phys.z) > 3.5) await b.goto(q.x, q.y, q.z, 2.5, { maxMs: 4000 });
      else {
        b.halt();
        b.look(q.x, q.y + 1.5, q.z);
        await b.wait(10);
      }
    }
    return `stayed with ${name}`;
  }

  async run(): Promise<void> {
    this.load();
    if (this.goal) this.emit("goal", { text: this.goal });
    this.emit("spawn", { dead: false });
    // a house it built before the town was kept in the pack counts too
    if (this.body.home && !this.body.home.room && !PACK.houses[this.name]) {
      const h = this.body.home;
      PACK.houses[this.name] = { x0: h.x0, z0: h.z0, x1: h.x0 + 3, z1: h.z0 + 3, y: h.y };
      savePack();
    }
    this.emitCiv();
    const fetchDay = () =>
      fetch(this.game + "/clanker", { signal: AbortSignal.timeout(3000) })
        .then((r) => r.json())
        .then((j: { day?: number }) => (this.day = Number(j.day) || this.day))
        .catch(() => {});
    void fetchDay();
    const dayTimer = setInterval(fetchDay, 30000);
    const statusTimer = setInterval(() => this.beat(), 1000);
    const guardTimer = setInterval(() => void this.guard(), 250);
    this.heard.push("You just woke up in this hardcore world with the other two. You have one life. Your three are here to build a civilization together, from a camp to a city. Talk to the others, agree on what the pack does first, and get started.");
    let quiet = 0;
    // the next plan, worked out while the last step of this one is still running, so one move flows into the next
    // instead of standing still to think between them
    let ahead: ReturnType<Brain["decide"]> | null = null;
    while (!this.stopped && !this.body.dead && !this.body.closed) {
      while (this.reflexing) await sleep(100);
      const t0 = Date.now();
      let d: Awaited<ReturnType<Brain["decide"]>>;
      if (ahead) {
        d = await ahead;
        ahead = null;
      } else {
        this.thinking = true;
        const idle = this.whileThinking();
        d = await this.decide();
        this.thinking = false;
        await idle;
      }
      if (!d) {
        await sleep(4000);
        continue;
      }
      for (const text of d.says) {
        this.body.send({ t: "chat", text: text.slice(0, 200) });
        this.emit("chat", { text: text.slice(0, 200) });
        this.log.push(`You said: "${text.slice(0, 200)}"`);
      }
      if (!d.actions.length) {
        if (++quiet > 1) await sleep(3000);
        continue;
      }
      quiet = 0;
      // the queue runs back to back; a failure, a reflex (a monster, the dark) or death cuts it short
      for (const [k, a] of d.actions.entries()) {
        if (this.stopped || this.body.dead || this.reflexing) break;
        const reflexes = this.reflexCount;
        this.emit("command", { text: a.label });
        this.body.action = a.label;
        this.skill = a.name;
        // the plan's last step: once it has run a moment, start thinking about what comes after it
        const early = k === d.actions.length - 1 ? setTimeout(() => {
          this.heard.push(`(You are still busy with ${a.desc}. Plan what you'll do the moment it's done.)`);
          ahead = this.decide();
        }, 1500) : null;
        const res = await this.exclusive(() => this.exec(a.name, a.input));
        if (early) clearTimeout(early);
        this.skill = "";
        this.body.action = "idle";
        this.emit("result", { text: res.slice(0, 300) });
        this.log.push(`${a.desc}: ${res}`);
        // the same move failing twice in a row: say so plainly, so it tries something else instead of a third time
        const failed = /couldn|can.t|^no |nothing|still|failed|got 0 |missing|isn.t|don.t|there is no/i.test(res);
        if (failed && this.lastFail === a.desc) this.heard.push(`${a.desc} has now failed twice in a row (${res}). Do something different.`);
        this.lastFail = failed ? a.desc : "";
        // and over a longer stretch (a walk in between doesn't wipe it): what keeps not working, until it works
        const fk = a.name === "go_to" ? "go_to" : a.desc;
        if (failed) this.failing.set(fk, { n: (this.failing.get(fk)?.n ?? 0) + 1, why: res.slice(0, 180), at: Date.now() });
        else this.failing.delete(fk);
        if (failed && k < d.actions.length - 1) this.heard.push(`The rest of your plan was skipped because ${a.desc} didn't work.`);
        // a plan made before this failed (or before a reflex cut in) is stale: drop it and think again
        if (failed || this.reflexCount !== reflexes) {
          ahead = null;
          break;
        }
      }
      if (this.log.length > 14) this.log.splice(0, this.log.length - 14);
      const spent = Date.now() - t0;
      if (spent < 300) await sleep(300 - spent);
      // a spending guard: past its hourly budget (a loop of instant failures, say) it slows right down
      this.spend = this.spend.filter(([t]) => Date.now() - t < 3600000);
      const lastHour = this.spend.reduce((a, [, d]) => a + d, 0);
      if (lastHour > (HOURLY_BUDGET[this.model] ?? 1)) {
        console.log(`[${this.name}] over its hourly budget (${lastHour.toFixed(2)}), slowing down`);
        await sleep(30000);
      }
    }
    clearInterval(statusTimer);
    clearInterval(guardTimer);
    clearInterval(dayTimer);
    this.status();
  }

  stop(): void {
    this.stopped = true;
    this.body.abort = true;
  }

  /** One skill at a time: reflexes queue behind (after stopping) whatever runs. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(() => {
      this.body.abort = false;
      return fn();
    });
    this.chain = p.catch(() => {});
    return p;
  }

  // ---------------------------------------------------------------- deciding

  private moment(): string {
    const b = this.body;
    const t = b.timeOfDay();
    const night = t >= NIGHT_START || t < 0 || t > NIGHT_END ? "it is night" : t >= 11000 ? `night falls in about ${Math.max(1, Math.round((NIGHT_START - t) / 1200))} minutes` : "it is day";
    const fx = Math.floor(b.phys.x);
    const fy = Math.floor(b.phys.y + 0.1);
    const fz = Math.floor(b.phys.z);
    const under = BLOCKS[b.get(fx, fy - 1, fz)]?.key ?? "air";
    const lines: string[] = [];
    lines.push(`Day ${this.day || 1}, time ${t} (${night}).`);
    const day = !b.isNight();
    const where = b.inHole() || b.sealed()
      ? (day ? "in a hole in broad daylight (dig_out to get out and get on with the day)" : "in a hole, sealed in" + (b.sealed() ? "" : " (the roof is open)"))
      : pendingTrip(b) && b.covered() ? "down your mine on a deep trip (mine_trip carries on; it climbs back out the way it came)"
      : b.covered() ? (fy < 44 ? "underground in the dark, where monsters spawn even by day (dig_out climbs up)" : "under cover") : "under open sky";
    lines.push(`You: health ${b.stats.hp.toFixed(0)}/20, hunger ${b.stats.food}/20${b.stats.air < 300 ? `, air ${b.stats.air}/300` : ""}. At x=${fx} y=${fy} z=${fz}, standing on ${under}, ${where}${b.phys.inWater ? ", in water" : ""}.`);
    const invMap = new Map<number, number>();
    for (const st of b.inv) if (st) invMap.set(st.id, (invMap.get(st.id) ?? 0) + st.n);
    lines.push(`In hand: ${b.heldId() ? key(b.heldId()) : "nothing"}. Inventory: ${invMap.size ? [...invMap].map(([id, n]) => `${key(id)} x${n}`).join(", ") : "empty"}.`);
    const worn = b.armor.filter((s): s is Stack => !!s).map((s) => key(s.id));
    if (worn.length) lines.push(`Wearing: ${worn.join(", ")}.`);
    // what a good player would have by now and it doesn't (its kit, not advice about the others)
    const has = (k: string) => b.inv.some((s) => s && key(s.id).includes(k));
    const missing: string[] = [];
    if (!has("pickaxe")) missing.push("a pickaxe");
    else if (!has("stone_pickaxe") && !has("iron_pickaxe") && !has("diamond_pickaxe")) missing.push("a stone_pickaxe");
    if (!has("sword")) missing.push("a sword");
    if (!has("bed") && !b.findBlocks([0, 1, 2, 3, 4, 5, 6, 7].map((k) => B.RED_BED + k), 24, 1).length) missing.push("a bed (3 wool, 3 planks)");
    if (!has("torch")) missing.push("torches (coal and sticks)");
    const food = b.inv.reduce((n, s) => n + (s && itemDef(s.id)?.food ? s.n : 0), 0);
    if (food < 4) missing.push(`food (only ${food})`);
    if (!worn.length && has("iron_ingot")) missing.push("armor (you have iron)");
    if (missing.length) lines.push(`Still missing: ${missing.join(", ")}.`);
    lines.push(techText(b));
    // v14: the morning is for a deep trip when the next gear is down there and it has the kit
    const deep = deepGoal(b);
    const trip = pendingTrip(b);
    if (trip && b.covered()) lines.push(`You're on a deep mining trip that a fight or a meal cut short (you're at y ${fy}): mine_trip carries on${dayClock(b) >= HEAD_BACK ? " (it's late: it climbs out)" : ""}.`);
    else if (deep && !b.isNight() && dayClock(b) <= LAST_START) {
      const needs = tripNeeds(b);
      lines.push(needs.length ? `What your next gear needs (${deep}) is deep down: a mine_trip there needs ${needs.join(", ")} first.` : `This morning is the time for a mine_trip: what your next gear needs (${deep}) is deep down, and you have the kit for it.`);
    }
    lines.push(PACK.plan ? `The pack's plan (written by ${PACK.by}; anyone can rewrite it with pack_plan):
${PACK.plan}` : "The pack has no plan written down yet (pack_plan).");
    if (PACK.base) lines.push(`The pack's base: x=${PACK.base.x} z=${PACK.base.z}, ${Math.round(Math.hypot(PACK.base.x - b.phys.x, PACK.base.z - b.phys.z))} blocks ${dirWord(PACK.base.x - b.phys.x, PACK.base.z - b.phys.z)}.`);
    lines.push(this.civText());
    lines.push(this.boardText());
    lines.push(this.goal ? `Your goal: ${this.goal}` : "You have no goal written down (set_goal).");
    if (b.home) {
      const [hx, hz] = b.homeMiddle();
      lines.push(`Your home: ${b.home.room ? "a cottage" : "a shelter"} at x=${Math.floor(hx)} z=${Math.floor(hz)}, ${Math.round(Math.hypot(hx - b.phys.x, hz - b.phys.z))} blocks ${dirWord(hx - b.phys.x, hz - b.phys.z)}${b.atHome() ? " (you're in it)" : ""}.`);
    }
    if (this.notes.length) lines.push(`Your notes:\n${this.notes.map((n) => `- ${n}`).join("\n")}`);
    // what's around: useful blocks, creatures, players
    const seen: string[] = [];
    for (const [label, ids] of [
      ["logs", [B.OAK_LOG, B.BIRCH_LOG, B.PALM_LOG]], ["stone", [B.STONE]], ["coal_ore", [B.COAL_ORE]], ["iron_ore", [B.IRON_ORE]],
      ["crafting_table", [B.CRAFTING_TABLE]], ["water", [B.WATER]], ["sand", [B.SAND]],
    ] as [string, number[]][]) {
      const f = b.findBlocks(ids, 24, 1)[0];
      if (f) seen.push(`${label} ${Math.round(b.distTo(f[0], f[1], f[2]))} blocks ${dirWord(f[0] - b.phys.x, f[2] - b.phys.z)}`);
    }
    lines.push(`Blocks near you: ${seen.length ? seen.join("; ") : "nothing useful within 24 blocks"}.`);
    const creatures: string[] = [];
    for (const m of b.hostiles(24).slice(0, 5)) creatures.push(`${m.key} ${m.d.toFixed(0)} blocks ${dirWord(m.x - b.phys.x, m.z - b.phys.z)}${m.flags & MF.AGGRO ? " (coming for you)" : ""}`);
    const animals = [...b.animals.values()].map((a) => ({ a, d: b.distTo(a.x, a.y, a.z) })).filter((e) => e.d < 32).sort((x, y) => x.d - y.d).slice(0, 4);
    for (const { a, d } of animals) creatures.push(`${ANIMAL_SPECS[a.kind]?.key ?? "animal"} ${d.toFixed(0)} blocks ${dirWord(a.x - b.phys.x, a.z - b.phys.z)}`);
    lines.push(`Creatures: ${creatures.length ? creatures.join("; ") : "none in sight"}.`);
    const people: string[] = [];
    for (const o of b.others.values()) {
      if (o.flags & FLAG.DEAD) continue;
      const d = b.distTo(o.x, o.y, o.z);
      const seen = BOARD.get(o.name);
      people.push(`${o.name} ${d.toFixed(0)} blocks ${dirWord(o.x - b.phys.x, o.z - b.phys.z)}${o.held ? `, holding ${key(o.held)}` : ""}${seen?.doing && seen.doing !== "idle" ? `, ${seen.doing}` : ""}${seen?.goal ? ` (their goal: ${seen.goal})` : ""}`);
    }
    lines.push(`Players: ${people.length ? people.join("; ") : "nobody else is in the world right now"}.`);
    const fresh = [...this.heard, ...b.events.splice(0)];
    this.heard = [];
    if (this.log.length) lines.push(`\nWhat you did recently (oldest first):\n${this.log.map((l) => `- ${l}`).join("\n")}`);
    const bad = [...this.failing].filter(([, f]) => f.n >= 2 && Date.now() - f.at < 600000);
    if (bad.length) lines.push(`Not working lately (the same try won't go differently: fix the cause, or do something else): ${bad.map(([k, f]) => `${k} failed ${f.n} times (last: ${f.why})`).join("; ")}.`);
    if (fresh.length) lines.push(`\nSince your last decision:\n${fresh.slice(-12).map((l) => `- ${l}`).join("\n")}`);
    lines.push("\nWhat do you do now?");
    return lines.join("\n");
  }

  private async decide(): Promise<{ says: string[]; actions: { name: string; input: Record<string, unknown>; label: string; desc: string }[] } | null> {
    this.auditTown();
    this.updateBoard();
    const prompt = this.moment();
    const t0 = Date.now();
    let resp: Anthropic.Message;
    try {
      resp = await this.client.messages.create({
        model: this.model,
        max_tokens: 1500,
        system: [{ type: "text", text: SYSTEM(this.name), cache_control: { type: "ephemeral" } }],
        tools: TOOLS,
        messages: [{ role: "user", content: prompt }],
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "low" },
      } as unknown as Anthropic.MessageCreateParamsNonStreaming);
    } catch (e) {
      console.error(`[${this.name}] claude error`, (e as Error).message);
      return null;
    }
    const ms = Date.now() - t0;
    const u = resp.usage;
    const [pi, po] = PRICE[this.model] ?? [0, 0];
    const dollars = ((u.input_tokens ?? 0) * pi + (u.output_tokens ?? 0) * po + (u.cache_read_input_tokens ?? 0) * pi * 0.1 + (u.cache_creation_input_tokens ?? 0) * pi * 1.25) / 1e6;
    this.cost += dollars;
    this.spend.push([Date.now(), dollars]);
    this.emit("usage", { model: this.model, ms, in: u.input_tokens, out: u.output_tokens, cache_read: u.cache_read_input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0 });
    if (resp.stop_reason === "refusal") {
      this.emit("refusal", { category: (resp as unknown as { stop_details?: { category?: string } }).stop_details?.category ?? null });
      return null;
    }
    const thought = resp.content.filter((c): c is Anthropic.ThinkingBlock => c.type === "thinking" && !!(c as Anthropic.ThinkingBlock).thinking).map((c) => c.thinking).join(" ").trim();
    if (thought) this.emit("thought", { text: thought.slice(0, 600), ms });
    const says: string[] = [];
    const actions: { name: string; input: Record<string, unknown>; label: string; desc: string }[] = [];
    for (const c of resp.content) {
      if (c.type !== "tool_use") continue;
      const input = (c.input ?? {}) as Record<string, unknown>;
      if (c.name === "say") {
        const m = String(input.message ?? "").trim();
        if (m && !/[<>]/.test(m)) says.push(m);
      } else if (actions.length < 3) actions.push({ name: c.name, input, label: this.label(c.name, input), desc: this.describe(c.name, input) });
    }
    return { says, actions };
  }

  /** The command line the site turns into words (site/index.html plain()). */
  private label(name: string, i: Record<string, unknown>): string {
    const q = (v: unknown) => JSON.stringify(String(v ?? ""));
    switch (name) {
      case "collect": return `!collectBlocks(${q(i.item)}, ${Number(i.count) || 1})`;
      case "craft": return `!craftRecipe(${q(i.recipe)}, ${Number(i.count) || 1})`;
      case "eat": return "!consume()";
      case "attack": return ["opus", "sonnet", "haiku"].includes(String(i.target).toLowerCase()) ? `!attackPlayer(${q(i.target)})` : `!attack(${q(i.target)})`;
      case "dig_in": return "!shelter";
      case "dig_out": return "!goToSurface";
      case "dig_down": return `!digDown(${Number(i.blocks) || 3})`;
      case "mine_trip": return "!mineTrip";
      case "go_to_player": return `!goToPlayer(${q(i.name)})`;
      case "go_to": return `!goToCoordinates(${Number(i.x)}, ${Number(i.z)})`;
      case "explore": return `!explore(${q(i.direction)})`;
      case "give": return `!givePlayer(${q(i.player)}, ${q(i.item)}, ${Number(i.count) || 1})`;
      case "place": return `!placeHere(${q(i.item)})`;
      case "pick_up": return "!pickUp";
      case "sleep": return "!goToBed";
      case "build_house": return "!buildHouse";
      case "build": return `!build(${q(i.what)})`;
      case "upgrade": return `!upgrade(${q(i.what)})`;
      case "farm": return "!farm";
      case "harvest": return "!harvest";
      case "loot_chest": return "!lootChest";
      case "trade": return i.offer === undefined ? "!talkToVillager" : `!trade(${Number(i.offer)}, ${Number(i.times) || 1})`;
      case "go_home": return "!goHome";
      case "work": return "!work";
      case "storehouse": return `!storehouse(${q(i.action)}${i.item ? `, ${q(i.item)}` : ""})`;
      case "set_goal": return `!setGoal(${q(i.goal)})`;
      case "pack_plan": return "!packPlan";
      case "go_to_base": return "!goToBase";
      case "note": return "!note";
      case "follow_player": return `!followPlayer(${q(i.name)})`;
      case "smelt": return `!smeltItem(${q(i.item)}, ${Number(i.count) || 1})`;
      case "enchant": return `!enchantItem(${q(i.item ?? "gear")})`;
      case "flee": return "!moveAway";
      case "wait": return "!stay";
      default: return `!${name}`;
    }
  }

  private describe(name: string, i: Record<string, unknown>): string {
    const args = Object.values(i).map((v) => String(v)).join(", ");
    return `${name}(${args})`;
  }

  // ---------------------------------------------------------------- skills

  /** At night, mining from inside its sealed hole: a staircase down from it (the roof stays shut, and a cave it breaks
   *  into gets closed), then the hole sealed again at the top. The first step opens the hole, and an open hole at night
   *  with a house set the home reflex off: it cut the staircase short and opus paced its hole for a minute trying to
   *  walk home through the rock (season 12's first night). Sealed again, the next one digs a new staircase another way. */
  private async nightMine(gets: number[], count: number): Promise<string> {
    const b = this.body;
    this.holeMining = true;
    try {
      const r = await b.stairMine(gets, count);
      if (!b.sealed() && !b.dead) await b.sealIn();
      return r;
    } finally {
      this.holeMining = false;
    }
  }

  /** v14: a deep mining trip (agents/mine.ts): out of the town to open ground first, the haul into the storehouse
   *  after. What its own next gear needs stays with it (iron for the armour and tools it lacks, diamonds for the
   *  pickaxe and the table); rubies pay for enchanting and trades, so they stay too. */
  private async mineTrip(): Promise<string> {
    const b = this.body;
    if (!pendingTrip(b)) {
      const why = tripCheck(b);
      if (why) return why;
      const out = await this.walkOutToDig();
      if (out) return out;
    }
    let r = await miningTrip(b);
    // the stair met water (or the bedrock) on the way down near the top: start again somewhere drier, twice at most
    for (let k = 0; k < 2 && r.back && !b.dead && !b.abort && /blocked all round/.test(r.text) && !r.haul.has(I.DIAMOND) && !tripCheck(b); k++) {
      const first = r.text;
      if (await this.walkOutToDig(20 + 10 * k)) break;
      r = await miningTrip(b);
      r.text = `${first}; so it started again ${Math.round(20 + 10 * k)} blocks off: ${r.text}`;
    }
    if (!r.back || b.dead || !r.haul.size) return r.text;
    // the haul: in the storehouse, if there is one within a walk
    const s = this.storehouse();
    if (!s) return `${r.text}. (No storehouse yet: keep it, or give it to whoever needs it.)`;
    const far = Math.hypot((s.x0 + s.x1) / 2 - b.phys.x, (s.z0 + s.z1) / 2 - b.phys.z);
    if (far > 160) return `${r.text}. (The storehouse is ${Math.round(far)} blocks away: take the haul in when you're back at the base.)`;
    const only = new Map<number, number>();
    const spare = (id: number, keep: number) => {
      const n = b.count(id) - keep;
      if (n > 0) only.set(id, n);
    };
    spare(I.RAW_IRON, this.ironNeed());
    spare(I.COAL, 8);
    spare(I.RAW_GOLD, 0);
    spare(I.DIAMOND, this.diamondNeed());
    spare(B.COBBLESTONE, 32);
    if (!only.size) return `${r.text}. You kept it all: your own next gear needs it.`;
    if (far > 30) {
      b.action = "taking the haul back to the storehouse";
      await b.goto((s.x0 + s.x1) / 2 + 0.5, PACK.base?.y ?? b.phys.y, (s.z0 + s.z1) / 2 + 0.5, 5, { maxMs: 60000 });
    }
    const put = await this.toStore(only);
    return `${r.text}. ${put || "Couldn't get the haul into the storehouse."}`;
  }

  /** Iron its own next gear still needs (an iron pickaxe and sword, and iron armour in every slot), less what it has. */
  private ironNeed(): number {
    const b = this.body;
    const all = [...b.inv, ...b.armor].filter((s): s is Stack => !!s);
    const has = (kind: string) => all.some((s) => itemDef(s.id)?.tool?.kind === kind && (itemDef(s.id)?.tool?.tier ?? 0) >= 3);
    let n = (has("pickaxe") ? 0 : 3) + (has("sword") || has("axe") ? 0 : 2);
    const cost = [5, 8, 7, 4];
    for (let slot = 0; slot < 4; slot++) if (!all.some((s) => itemDef(s.id)?.armor?.slot === slot && (itemDef(s.id)?.armor?.material ?? 0) >= 1)) n += cost[slot];
    return Math.max(0, n - b.count(I.IRON_INGOT));
  }

  /** Diamonds its next gear still needs: 3 for a diamond pickaxe, 2 for the pack's enchanting table while there's none. */
  private diamondNeed(): number {
    const b = this.body;
    const pick = b.inv.some((s) => s && canHarvest(B.OBSIDIAN, s.id));
    return (pick ? 0 : 3) + (tableAt(b) || b.has(B.ENCHANTING_TABLE) ? 0 : 2);
  }

  /** Out to open ground away from the town, the spawn hub and the villages (a mine's stair never goes down under
   *  them): "" once it's there. */
  private async walkOutToDig(away = 0): Promise<string> {
    const b = this.body;
    const from = { x: b.phys.x, z: b.phys.z };
    const villages = (b.world?.villages ?? []).map((k) => VILLAGE_SITES[k]).filter(Boolean);
    const taken = (x: number, z: number) => inHub(x, z) || (!!PACK.base && Math.hypot(x - PACK.base.x, z - PACK.base.z) < 26)
      || villages.some((v) => Math.hypot(x - v.x, z - v.z) < 30) || footprints().some((r) => x >= r.x0 - 3 && x <= r.x1 + 3 && z >= r.z0 - 3 && z <= r.z1 + 3);
    // (away: somewhere else, that far at least from where it stands: the last stair from here met water)
    const open = () => !taken(b.phys.x, b.phys.z) && !b.phys.inWater && b.underSky(Math.floor(b.phys.x), Math.floor(b.phys.y + 0.1) + 1, Math.floor(b.phys.z)) && Math.hypot(b.phys.x - from.x, b.phys.z - from.z) >= away - 3;
    if (open()) return "";
    if (b.covered() && !footprints().some((r) => b.phys.x >= r.x0 && b.phys.x <= r.x1 + 1 && b.phys.z >= r.z0 && b.phys.z <= r.z1 + 1)) {
      b.action = "climbing up out of the ground";
      await b.digOut();
      if (open()) return "";
    }
    const c = taken(b.phys.x, b.phys.z) && PACK.base ? PACK.base : { x: b.phys.x, z: b.phys.z, y: b.phys.y };
    const spots: { x: number; z: number; g: number; d: number }[] = [];
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      for (let r = Math.max(8, away); r <= 90; r += 6) {
        const tx = Math.floor(c.x + Math.cos(a) * r);
        const tz = Math.floor(c.z + Math.sin(a) * r);
        if (taken(tx, tz) || (away && [[0, 0], [6, 0], [-6, 0], [0, 6], [0, -6]].some(([dx, dz]) => b.groundAt(tx + dx, tz + dz, Math.floor(c.y)) === -1))) continue;
        const g = b.groundAt(tx, tz, Math.floor(c.y));
        if (g >= 0) spots.push({ x: tx, z: tz, g, d: Math.hypot(tx - b.phys.x, tz - b.phys.z) });
        break;
      }
    }
    spots.sort((p, q) => p.d - q.d);
    for (const sp of spots.slice(0, 3)) {
      if (open() || b.abort || b.dead) break;
      b.action = "walking out to open ground to start a mine";
      await b.goto(sp.x + 0.5, sp.g + 1, sp.z + 0.5, 2, { maxMs: 40000 });
    }
    return open() ? "" : "couldn't find open ground outside the town to start a mine from: walk out a little (explore), then mine_trip";
  }

  /** Why a tool would take it out across open ground at night, or "" if it's fine. Archers come out in the dark and
   *  shoot from range, and the shamblers come in numbers: sonnet left its hole on season 12's first night to look
   *  for sheep, walked a ravine in the dark and was shot. Nights are for the house or the hole. */
  private outInTheDark(name: string, i: Record<string, unknown>): string {
    const b = this.body;
    const why = "it's night: archers come out in the dark and shoot from range. Stay in till dawn: sleep, wait (sealed in a hole it mines round you), craft or smelt";
    const far = (x: number, z: number) => Math.hypot(x - b.phys.x, z - b.phys.z) > 16;
    switch (name) {
      case "explore": return `${why}; explore by day`;
      case "dig_out": return `${why}; dig_out at dawn`;
      case "mine_trip": return pendingTrip(b) ? "" : `${why}; the deep is a morning trip (mine_trip at dawn)`;
      case "go_to_base": return PACK.base && far(PACK.base.x, PACK.base.z) ? `${why}; go to the base by day` : "";
      case "go_home": {
        // home through the rock in the dark, from a hole it's safe in: no (out in the open, home is the place to go)
        if (!b.home || !b.covered()) return "";
        const [mx, mz] = b.homeMiddle();
        return far(mx, mz) ? `${why}; you're under cover: stay there and go home by day` : "";
      }
      case "go_to": return Number.isFinite(Number(i.x)) && Number.isFinite(Number(i.z)) && far(Number(i.x), Number(i.z)) ? `${why}; go there by day` : "";
      case "go_to_player":
      case "follow_player":
      case "give": {
        const o = [...b.others.values()].find((p) => p.name === String(i.name ?? i.player ?? "").toLowerCase());
        return o && far(o.x, o.z) ? `${why}; meet up by day` : "";
      }
      case "attack": return ANIMAL_SPECS.some((a) => a.key === String(i.target ?? "").toLowerCase()) ? `${why}; hunt by day` : "";
      case "collect": {
        const plan = miningPlan(String(i.item ?? ""));
        if (!plan) return "";
        // stone and ore come out of the rock from under cover; trees, sand, dirt and the rest are out in the open
        const rock = plan.blocks.includes(B.STONE) || plan.blocks.every((id) => BLOCKS[id]?.key?.endsWith("_ore"));
        return rock && b.covered() ? "" : `${why}; ${rock ? "mine from under cover" : "trees and open ground by day"}`;
      }
    }
    return "";
  }

  private async exec(name: string, i: Record<string, unknown>): Promise<string> {
    const b = this.body;
    try {
      const dark = b.isNight() ? this.outInTheDark(name, i) : "";
      if (dark) return dark;
      switch (name) {
        case "collect": return await this.collect(String(i.item ?? ""), Math.max(1, Math.min(32, Number(i.count) || 1)));
        case "craft": {
          // one recipe, or a chain in order: "oak_planks x4, sticks, crafting_table, wooden_pickaxe"
          const steps = String(i.recipe ?? "").toLowerCase().split(/[,;]/).map((t) => t.trim()).filter(Boolean);
          const done: string[] = [];
          for (const step of steps) {
            const m = step.match(/^([a-z_]+)(?:\s*[x*]\s*(\d+))?$/);
            if (!m) return [...done, `"${step}" isn't a recipe name`].join("; ");
            const n = steps.length === 1 ? Math.max(1, Math.min(16, Number(i.count) || Number(m[2]) || 1)) : Math.max(1, Math.min(16, Number(m[2]) || 1));
            const r = await b.craft(m[1], n);
            if (!r.made) return [...done, `couldn't craft ${m[1]}: ${r.why}`].join("; ");
            done.push(`crafted ${r.made}x ${m[1]}`);
          }
          return done.join("; ") || "nothing to craft";
        }
        case "eat": return await b.eat();
        case "attack": return await this.attack(String(i.target ?? ""));
        case "dig_in": {
          // not with a monster on it: digging in is seconds of standing still, and it hits (or shoots) you out of the
          // hole halfway through. It deals with the monster first, armed it fights, unarmed it runs, and digs in once
          // it's clear (only refusing, sonnet asked to dig in again and again with a shambler 5 blocks off)
          const m = b.hostiles(8)[0];
          if (m) {
            const weapon = b.bestWeapon();
            const armed = !!weapon && (itemDef(weapon)?.tool?.damage ?? 0) >= 4 && b.stats.hp >= 8;
            const res = armed ? await b.fight({ kind: "mob", id: m.id }, 15000, 6) : (await b.flee(m.x, m.z, 100), "ran from it");
            const still = b.hostiles(8)[0];
            if (still) return `a ${m.key} was ${Math.round(m.d)} blocks away, so before digging in you ${armed ? `fought it (${res})` : "ran from it"}; a ${still.key} is still ${Math.round(still.d)} blocks off: ${armed ? "finish it (attack)" : "keep away (flee)"}, then dig_in`;
            return `a ${m.key} was on you, so you ${armed ? `fought it first (${res})` : "ran from it first"}, then dug in: ${await b.digIn()}`;
          }
          return await b.digIn();
        }
        case "dig_out": return await b.digOut();
        case "mine_trip": return await this.mineTrip();
        case "dig_down": return await this.digDown(Math.max(1, Math.min(8, Number(i.blocks) || 3)));
        case "go_to_player": {
          const o = [...b.others.values()].find((p) => p.name === String(i.name ?? "").toLowerCase());
          if (!o) return `${i.name} isn't in the world`;
          const ok = await b.goto(o.x, o.y, o.z, 2.5, { maxMs: 60000, done: () => { const q = b.others.get(o.id); return !!q && Math.hypot(q.x - b.phys.x, q.z - b.phys.z) < 3; } });
          return ok ? `reached ${o.name}` : `couldn't get to ${o.name}`;
        }
        case "go_to": {
          const x = Number(i.x);
          const z = Number(i.z);
          if (!Number.isFinite(x) || !Number.isFinite(z)) return "bad coordinates";
          // to the ground there, not to its own height: from a tunnel it aimed under the destination and went round in
          // circles (opus, "go to 173 300" from 13 blocks down)
          const top = b.surfaceAt(Math.floor(x), Math.floor(z));
          const ok = await b.goto(x, top >= 0 ? top + 1 : NaN, z, 2, { maxMs: 90000, done: () => Math.hypot(x - b.phys.x, z - b.phys.z) < 2.5 });
          return ok ? "arrived" : `stopped at x=${Math.round(b.phys.x)} z=${Math.round(b.phys.z)}, couldn't get further`;
        }
        case "explore": {
          const d = String(i.direction ?? "north");
          const [dx, dz] = d === "east" ? [1, 0] : d === "west" ? [-1, 0] : d === "south" ? [0, 1] : [0, -1];
          const x = Math.max(8, Math.min(504, b.phys.x + dx * 40));
          const z = Math.max(8, Math.min(504, b.phys.z + dz * 40));
          const top = b.surfaceAt(Math.floor(x), Math.floor(z));
          await b.goto(x, top >= 0 ? top + 1 : NaN, z, 3, { maxMs: 45000, done: () => Math.hypot(x - b.phys.x, z - b.phys.z) < 3 });
          return `walked ${d} to x=${Math.round(b.phys.x)} z=${Math.round(b.phys.z)}`;
        }
        case "give": return await this.give(String(i.player ?? ""), String(i.item ?? ""), Math.max(1, Math.min(64, Number(i.count) || 1)));
        case "place": {
          const id = itemByName(String(i.item ?? ""));
          if (!id || !b.has(id)) return `you don't have ${i.item}`;
          if (id === B.TORCH && b.findBlocks([B.TORCH], 4, 1).length) return "there is already a torch right here";
          const spot = b.spotNearby();
          if (!spot) return "no room to place it here";
          return (await b.place(id, ...spot)) ? `placed ${i.item}` : `couldn't place ${i.item}`;
        }
        case "smelt": {
          const id = itemByName(String(i.item ?? ""));
          if (!id || !b.has(id)) return `you don't have ${i.item}`;
          return await b.smelt(id, Math.max(1, Math.min(16, Number(i.count) || 1)));
        }
        case "sleep": return await b.sleep();
        case "enchant": return await enchantGear(b, String(i.item ?? ""), Math.max(0, Math.min(3, Number(i.level) || 0)), PACK.base, footprints());
        case "build": return await this.buildTown(String(i.what ?? "") as Kind);
        case "upgrade": return await this.buildTown(String(i.what ?? "") as Kind, true);
        case "farm": {
          if (!PACK.base) return "the pack has no base yet: build_house first (the first house becomes the base), then farm next to it";
          const d = Math.hypot(PACK.base.x - b.phys.x, PACK.base.z - b.phys.z);
          if (d > 30) return `you're ${Math.round(d)} blocks from the base: go_to_base first, the farm goes next to it`;
          // not in a village's own fields either
          const villageLand: Rect[] = (b.world?.villages ?? []).map((k) => VILLAGE_SITES[k]).filter(Boolean).map((v) => ({ x0: v.x - 27, z0: v.z - 27, x1: v.x + 27, z1: v.z + 27 }));
          const r = await b.makeFarm(PACK.base.x, PACK.base.z, PACK.base.y, [...footprints(), ...villageLand, ...this.planRects()]);
          // a new field is a new farm; more wheat by the same pond is the same farm (it used to count again each time)
          const same = r.rect && PACK.builds.find((f) => f.kind === "farm" && r.rect!.x0 <= f.x1 && r.rect!.x1 >= f.x0 && r.rect!.z0 <= f.z1 && r.rect!.z1 >= f.z0);
          if (r.rect && same) {
            if (!same.by.includes(this.name)) same.by.push(this.name);
            savePack();
          } else if (r.rect) {
            PACK.builds.push({ kind: "farm", ...r.rect, y: PACK.base.y, by: [this.name], done: true, at: Date.now() });
            this.civUpdate(`${this.name} planted a farm`);
          }
          return r.text;
        }
        case "harvest": return await b.harvest();
        case "loot_chest": return await b.lootChest();
        case "trade": {
          const o = i.offer === undefined || i.offer === null ? undefined : Number(i.offer);
          const job = JOBS.findIndex((j) => j.key === String(i.with ?? "").toLowerCase());
          const r = await b.trade(o, Math.max(1, Math.min(16, Number(i.times) || 1)), job);
          const m = /^traded with .*? (\d+) times?/.exec(r);
          if (m) {
            PACK.trades += Number(m[1]);
            this.civUpdate(`${this.name} traded with a villager`);
          }
          return r;
        }
        case "build_house": {
          // a finished cottage nobody lives in: move in (a real room, its own door, the bed in its place) rather than
          // put up another two by two shelter
          const cot = PACK.base && PACK.builds.find((x) => x.kind === "house" && !isHome(x) && x.done && tierOf(x) >= 1 && !x.owner && Math.hypot((x.x0 + x.x1) / 2 - b.phys.x, (x.z0 + x.z1) / 2 - b.phys.z) < 60);
          const mine = PACK.builds.find((x) => x.owner === this.name);
          if (cot && !mine) {
            const h = homeOf(cot);
            if (h) {
              cot.owner = this.name;
              b.home = { x0: cot.x0, z0: cot.z0, y: cot.y, door: h.door, room: h.room };
              this.save();
              savePack();
              let bed = "";
              const bedItem = BLOCKS[B.RED_BED].item || B.RED_BED;
              if (h.bed && b.has(bedItem)) {
                const [x, y, z, state] = h.bed;
                if (await b.place(bedItem, x, y, z, 30000, state)) bed = ", your bed is in";
              }
              this.civUpdate(`${this.name} moved into the cottage at x=${Math.round((cot.x0 + cot.x1) / 2)} z=${Math.round((cot.z0 + cot.z1) / 2)}`);
              return `moved into the cottage at x=${Math.round((cot.x0 + cot.x1) / 2)} z=${Math.round((cot.z0 + cot.z1) / 2)}: it's your home now${bed} (go_home every evening)`;
            }
          }
          if (b.home?.room) return "you already live in a cottage: go_home";
          if (PACK.base && !b.home) {
            const d = Math.hypot(PACK.base.x - b.phys.x, PACK.base.z - b.phys.z);
            if (d > 14) return `the pack's base is at x=${PACK.base.x} z=${PACK.base.z}, ${Math.round(d)} blocks ${dirWord(PACK.base.x - b.phys.x, PACK.base.z - b.phys.z)}: go_to_base first and build next to the others`;
          }
          const before = b.home;
          const r = await b.buildHouse();
          if (b.home && b.home !== before) {
            this.save();
            const h = { x0: b.home.x0, z0: b.home.z0, x1: b.home.x0 + 3, z1: b.home.z0 + 3, y: b.home.y };
            PACK.houses[this.name] = h;
            PACK.builds.push({ kind: "house", ...h, by: [this.name], done: true, at: Date.now() });
            this.civUpdate(`${this.name} built a house`);
            if (!PACK.base) {
              PACK.base = { x: b.home.x0 + 2, y: b.home.y, z: b.home.z0 + 2 };
              savePack();
              this.emit("plan", { text: `${this.name} built the first house: the pack's base is at x=${PACK.base.x} z=${PACK.base.z}` });
            }
          }
          return r;
        }
        case "pack_plan": {
          const t = String(i.plan ?? "").trim().slice(0, 600);
          if (!t) return "the plan is empty";
          PACK.plan = t;
          PACK.by = this.name;
          savePack();
          this.emit("plan", { text: t });
          return "the pack's plan is written down; the others see it on their next turn";
        }
        case "go_to_base": {
          if (!PACK.base) return "the pack has no base yet: the first house anyone builds becomes it";
          // within 7 counts: the base is the first house, and its middle is inside that house, so from outside the walls
          // "within 4" was never reached and they circled the house at dusk (sonnet and haiku, season 11)
          const base = PACK.base;
          const ok = await b.goto(base.x + 0.5, base.y, base.z + 0.5, 7, { maxMs: 90000, done: () => Math.hypot(base.x + 0.5 - b.phys.x, base.z + 0.5 - b.phys.z) <= 7 });
          return ok ? "you're at the pack's base" : `you couldn't get all the way to the base (${Math.round(Math.hypot(PACK.base.x - b.phys.x, PACK.base.z - b.phys.z))} blocks left)`;
        }
        case "go_home": return await b.goHome();
        case "work": return await this.work();
        case "storehouse": {
          const act = String(i.action ?? "look");
          if (act === "put") {
            const id = i.item ? itemByName(String(i.item)) : 0;
            if (i.item && (!id || !b.has(id))) return `you don't have ${i.item}`;
            return (await this.toStore(id ? new Map([[id, Math.max(1, Math.min(256, Number(i.count) || b.count(id)))]]) : null)) || "nothing to put in the storehouse (what you carry you need, or there is no storehouse yet: build storehouse)";
          }
          if (act === "take") {
            const id = itemByName(String(i.item ?? ""));
            if (!id) return `there is no item called ${i.item}`;
            return (await this.fromStore(new Map([[id, Math.max(1, Math.min(256, Number(i.count) || 16))]]), true)) || `the storehouse has no ${i.item} (as far as anyone counted)`;
          }
          return await this.lookInStore();
        }
        case "set_goal": {
          this.goal = String(i.goal ?? "").trim().slice(0, 160);
          this.save();
          this.emit("goal", { text: this.goal });
          return "goal set";
        }
        case "note": {
          const t = String(i.text ?? "").trim().slice(0, 200);
          if (t) this.notes = [...this.notes, t].slice(-10);
          this.save();
          return "noted";
        }
        case "follow_player": return await this.followPlayer(String(i.name ?? ""), Math.max(5, Math.min(60, Number(i.seconds) || 30)));
        case "pick_up": return `picked up ${await b.pickUp(8)} items`;
        case "flee": {
          const h = b.hostiles(20)[0];
          if (!h) return "nothing to run from";
          await b.flee(h.x, h.z, 100);
          return `ran from the ${h.key}`;
        }
        case "wait": {
          b.halt();
          // out at night and not shut in anywhere: shut in first. Standing there "waiting" is how opus died on season
          // 12's third night (a rattler shot it from across a ravine while it waited near the top)
          if (b.isNight() && !b.sealed() && !b.atHome() && !b.hostiles(8).length) {
            const d = await b.digIn();
            if (!b.sealed()) return `it's night and you weren't shut in anywhere, so you tried to dig in: ${d}`;
          }
          // a night without a bed, sealed in underground: mine round it instead of standing in the hole for nine
          // minutes (the prompt says so, but on season 9's first night haiku and opus just waited: "hiding"). A
          // staircase down from the hole, so the roof stays shut; not when hurt, and not under the town's buildings
          const tool = b.bestToolFor(B.STONE);
          if (b.isNight() && b.sealed() && b.covered() && b.stats.hp >= 12 && tool && canHarvest(B.STONE, tool) && !(PACK.base && b.phys.y > PACK.base.y - 3)) {
            const plan = miningPlan("cobblestone")!;
            const before = plan.gets.reduce((n, id) => n + b.count(id), 0);
            b.action = "mining round its hole for the night";
            const r = await this.nightMine(plan.gets, 12);
            const got = plan.gets.reduce((n, id) => n + b.count(id), 0) - before;
            if (got) return `it's night and you're sealed in underground, so instead of waiting you mined round you: got ${got} cobblestone`;
            // nothing to mine from here: wait for real rather than come straight back (an instant answer every time had
            // sonnet asking to wait every two seconds all night, every ask a model call)
            for (let k = 0; k < Math.max(2, Math.min(30, Number(i.seconds) || 5)) * 20 && !b.abort && !b.dead; k++) await b.nextTick();
            return `it's night and you're sealed in underground; there was nothing to mine round you (${r}), so you waited`;
          }
          const s = Math.max(2, Math.min(30, Number(i.seconds) || 5));
          // look around the way a person does: a glance one way or the other and back, or at someone nearby. It used
          // to turn another 40 to 100 degrees every 3 s, always the same way, so a long wait was opus spinning in circles
          const ahead = b.yaw;
          for (let k = 0; k < s * 20 && !b.abort && !b.dead; k++) {
            if (k % 100 === 50) {
              const o = [...b.others.values()].find((p) => Math.hypot(p.x - b.phys.x, p.z - b.phys.z) < 16);
              if (o && Math.random() < 0.5) b.wantYaw = ((Math.atan2(-(o.x - b.phys.x), o.z - b.phys.z) * 180) / Math.PI + 360) % 360;
              else b.wantYaw = (ahead + (Math.random() < 0.5 ? -1 : 1) * (20 + Math.random() * 40) + 360) % 360;
            } else if (k % 100 === 0 && k) b.wantYaw = ahead;
            await b.nextTick();
          }
          return "waited";
        }
        default: return `there is no ${name} action`;
      }
    } catch (e) {
      console.error(`[${this.name}] skill ${name} failed`, e);
      return `failed (${(e as Error).message})`;
    } finally {
      b.halt();
    }
  }

  /** An axe in the bag: a stone one (3 cobblestone, 2 sticks), else a wooden one (3 planks, 2 sticks), making the
   *  planks and sticks from a log if it has to. Quiet: if it can't, it chops as before. */
  private async ensureAxe(): Promise<void> {
    const b = this.body;
    const axe = () => b.inv.some((st) => st && itemDef(st.id)?.tool?.kind === "axe");
    if (axe()) return;
    const planks = () => b.count(B.OAK_PLANKS) + b.count(B.BIRCH_PLANKS);
    const logs = () => b.count(B.OAK_LOG) + b.count(B.BIRCH_LOG) + b.count(B.PALM_LOG);
    const stone = b.count(B.COBBLESTONE) >= 3;
    if (!b.has(I.STICK, 2) && planks() < 2 + (stone ? 0 : 3) && logs()) {
      for (const p of ["oak_planks", "birch_planks"]) if (planks() < 5 && logs()) await b.craft(p, 2);
    }
    if (!b.has(I.STICK, 2) && planks() >= 2) await b.craft("sticks", 1);
    if (!b.has(I.STICK, 2)) return;
    if (stone && (await b.craft("stone_axe", 1)).made) return;
    if (planks() >= 3) await b.craft("wooden_axe", 1);
  }

  private async collect(item: string, count: number): Promise<string> {
    const b = this.body;
    // v13: obsidian isn't dug out of the rock here: it's the smith's lava set by water (agents/tech.ts)
    if (isObsidian(item)) return await collectObsidian(b, Math.min(count, 8));
    const plan = miningPlan(item);
    if (!plan) return `don't know how to collect ${item}`;
    const have = () => plan.gets.reduce((n, id) => n + b.count(id), 0);
    const start = have();
    let t0 = Date.now();
    const skip = new Set<number>();
    let tried = 0;
    // soft ground (dirt, sand, gravel) comes out of one shallow pit, a layer at a time, well away from the town and
    // the villages: a player digs a quarry, not a hole here and a hole there all over the base
    const soft = !plan.blocks.includes(B.STONE) && plan.blocks.some((id) => id === B.DIRT || id === B.GRASS || id === B.SAND || id === B.GRAVEL);
    const villages = (b.world?.villages ?? []).map((k) => VILLAGE_SITES[k]).filter(Boolean);
    const theirs = (x: number, z: number) => inHub(x, z) || villages.some((v) => Math.hypot(x - v.x, z - v.z) < 27) || footprints().some((r) => x >= r.x0 - 2 && x <= r.x1 + 2 && z >= r.z0 - 2 && z <= r.z1 + 2);
    const offLimits = (x: number, z: number) => (PACK.base && Math.hypot(x - PACK.base.x, z - PACK.base.z) < 16) || theirs(x, z);
    let pit: [number, number, number] | null = null;
    let trips = 0;
    let trip: { x: number; z: number; had: number } | null = null;
    const trees = plan.blocks.some((id) => BLOCKS[id]?.key?.endsWith("_log"));
    // saplings come one in twenty leaves: many more tries than blocks
    const leafy = plan.gets.some((g) => g === B.OAK_SAPLING || g === B.BIRCH_SAPLING);
    // the trunks it cuts at their foot: a sapling goes back in each after (the woods round the town grow back)
    const stumps: [number, number, number, boolean][] = [];
    // wood comes faster with an axe (Laith: "no one uses axes"; they chopped every tree by hand or with a pickaxe, and
    // wood is what the town runs short of): a stone one if there's cobblestone, else a wooden one
    if (trees) await this.ensureAxe();
    // at night rock comes out from inside its sealed hole only, down a staircase it shuts behind it: walking to ore it
    // could see across a cave or a ravine is how opus died on season 12's third night (shot near the top by a rattler)
    const rock = plan.blocks.includes(B.STONE) || plan.blocks.every((id) => BLOCKS[id]?.key?.endsWith("_ore"));
    if (b.isNight() && rock) {
      if (!b.sealed()) return `it's night: dig_in first (shut yourself in), then collect ${item} from inside the hole`;
      if (PACK.base && b.phys.y > PACK.base.y - 3) return "it's night and you're shut in right under the town: wait or craft till dawn (no mining under the buildings)";
      if (!b.bestToolFor(B.STONE) || !canHarvest(B.STONE, b.bestToolFor(B.STONE))) return "stone needs a pickaxe: craft a wooden_pickaxe first";
      b.action = `mining down from its hole for ${item}`;
      const r = await this.nightMine(plan.gets, count);
      return have() > start ? `got ${have() - start} ${item} down a staircase from your hole (sealed in again after)` : r;
    }
    // stone comes out of the ground away from the town: never the town's own walls (the nearest "cobblestone" was
    // the town hall's, so they took its lower walls apart for a house), and never a village's houses
    const stone = plan.blocks.includes(B.STONE);
    // out of the spawn hub, or out of the town, before mining stone
    const away = inHub(b.phys.x, b.phys.z) || !PACK.base
      ? { x: SPAWN_X, z: SPAWN_Z, r: HUB_R + 14, y: b.world?.info.spawnHeight ?? Math.floor(b.phys.y), what: "the spawn hub" }
      : { x: PACK.base.x, z: PACK.base.z, r: 20, y: PACK.base.y, what: "the town" };
    // already well down in the rock under the town (sealed in for the night): the rock down here is nobody's walls,
    // mine it where it is rather than walk out through the town in the dark (sonnet, season 10, night 7)
    const deepUnder = b.covered() && b.phys.y < away.y - 4;
    if (stone && offLimits(b.phys.x, b.phys.z) && !deepUnder) {
      // out on the ground, not through the rock: in a tunnel under the town it stood still for 3 minutes aiming at a
      // spot 20 blocks out at its own depth (opus)
      if (b.phys.y < away.y - 3) {
        b.action = `climbing up out of the tunnel`;
        await b.digOut();
      }
      // out along its own direction until the ground is free: 20 blocks out from the base was the storehouse opus was
      // building, still "the town", so it never left
      // the nearest free ground round the town, in twelve directions: season 10's town sits on the edge of a village
      // with the spawn hub on the other side, and walking straight out its own way (then the other three) kept
      // ending in a village or water ("couldn't get out of the town to mine", over and over)
      const spots: { x: number; z: number; g: number; d: number }[] = [];
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        for (let r = away.r; r <= away.r + 60; r += 6) {
          const tx = Math.floor(away.x + Math.cos(a) * r);
          const tz = Math.floor(away.z + Math.sin(a) * r);
          if (offLimits(tx, tz)) continue;
          const g = b.groundAt(tx, tz, away.y);
          if (g >= 0) spots.push({ x: tx, z: tz, g, d: Math.hypot(tx - b.phys.x, tz - b.phys.z) });
          break;
        }
      }
      spots.sort((p, q) => p.d - q.d);
      for (const sp of spots.slice(0, 3)) {
        if (!offLimits(b.phys.x, b.phys.z) || b.abort || b.dead) break;
        b.action = `walking out of ${away.what} to mine`;
        await b.goto(sp.x + 0.5, sp.g + 1, sp.z + 0.5, 3, { maxMs: 30000 });
      }
      if (offLimits(b.phys.x, b.phys.z)) return `couldn't get out of ${away.what} to mine stone (stone never comes out of ${away.what}'s ground): walk out a little further (explore), then collect`;
    }
    while (!b.abort && !b.dead && have() - start < count && Date.now() - t0 < 90000) {
      // nothing deep: the deep caves are where Rattlers wait in the dark
      const floor = Math.max(30, Math.floor(b.phys.y) - 8);
      // and nothing touching water: breaking it lets the water flood in on top of you
      const wet = (x: number, y: number, z: number) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => IS_WATER[b.get(x + dx, y + dy, z + dz)] === 1);
      let found = b.findBlocks(plan.blocks, 32, soft ? 4000 : stone ? 400 : 16).filter(([x, y, z]) => y >= floor && !wet(x, y, z) && !skip.has(x + z * 512 + y * 262144));
      if (stone) found = found.filter(([x, y, z]) => !offLimits(x, z) || (deepUnder && y < away.y - 4)).slice(0, 16);
      else if (!soft) found = found.filter(([x, , z]) => !theirs(x, z));
      // not where another agent is already working (all three went for the same oak at the start of season 7)
      const free = found.filter(([x, , z]) => !takenByOther(this.name, x, z));
      if (free.length) found = free;
      if (soft) {
        found = found.filter(([x, , z]) => !offLimits(x, z));
        if (pit) {
          const [px, py, pz] = pit;
          const inPit = found.filter(([x, y, z]) => Math.abs(x - px) <= 2 && Math.abs(z - pz) <= 2 && y >= py - 1 && y <= py);
          // the top layer first, row by row from where it stands, so it never digs itself into a hole
          if (inPit.length) found = inPit.sort((p, q) => q[1] - p[1] || Math.hypot(p[0] - b.phys.x, p[2] - b.phys.z) - Math.hypot(q[0] - b.phys.x, q[2] - b.phys.z));
          else pit = null;
        }
        if (!pit && found.length) {
          // a new pit: the nearest open patch of ground of the right kind, at the surface
          const top = found.filter(([x, y, z]) => !SOLID[b.get(x, y + 1, z)]);
          pit = (top[0] ?? found[0]) as [number, number, number];
        }
        // none in 32 blocks (sand is by the water, not in town): out to the nearest open patch within 64, then 160, the
        // way a logging trip goes (sonnet asked for sand three times and crafted glass panes it had no glass for)
        if (!found.length && trips < 2) {
          trips++;
          const far = b.findBlocks(plan.blocks, trips === 1 ? 64 : 160, 400).filter(([fx, fy, fz]) => !offLimits(fx, fz) && !SOLID[b.get(fx, fy + 1, fz)]);
          if (far.length) {
            b.action = `walking out for ${item}, ${Math.round(Math.hypot(far[0][0] - b.phys.x, far[0][2] - b.phys.z))} blocks out`;
            await b.goto(far[0][0] + 0.5, far[0][1] + 1, far[0][2] + 0.5, 3, { maxMs: trips === 1 ? 40000 : 120000 });
            pit = null;
            t0 = Date.now();
            continue;
          }
        }
        if (!found.length) return have() - start > 0 ? `got ${have() - start} of ${count} ${item} (no more open ground away from the town nearby: explore a little and collect again)` : `no ${item} away from the town and the villages within 160 blocks`;
      }
      // stone that isn't lying open at its feet: mine down a staircase like a player, not a shaft. Ore too, when none
      // is in reach: the staircase heads the way with the most ore and takes what's in its walls (opus asked for coal
      // over and over and got "0 of 8": the coal was deeper in the rock than it could walk to)
      const ore = !plan.blocks.includes(B.STONE) && plan.blocks.every((id) => BLOCKS[id]?.key?.endsWith("_ore"));
      if (ore && (!found.length || found[0][1] < b.phys.y - 2 || skip.size >= 1) && b.bestToolFor(B.STONE) && canHarvest(B.STONE, b.bestToolFor(B.STONE)) && !offLimits(b.phys.x, b.phys.z)) {
        const had = have();
        const r = await b.stairMine(plan.gets, count - (have() - start));
        tried++;
        if (have() - start >= count) return r;
        // nothing came of it: another staircase from the same spot goes the same way and gets nothing again
        if (have() <= had) return r;
        skip.add(-2);
        if (skip.size > 3) return r;
        continue;
      }
      if (plan.blocks.includes(B.STONE) && (!found.length || found[0][1] < b.phys.y - 2 || skip.size >= 2)) {
        if (!b.bestToolFor(B.STONE) || !canHarvest(B.STONE, b.bestToolFor(B.STONE))) return "stone needs a pickaxe: craft a wooden_pickaxe first";
        const had = have();
        const r = await b.stairMine(plan.gets, count - (have() - start));
        tried++;
        if (have() - start >= count || /water/.test(r) || have() <= had) return r;
        skip.add(-1);
        if (skip.size > 3) return r;
        continue;
      }
      // nothing in 32 blocks, and it's wood: every oak round the town was cut down (the town is built of oak, so a
      // house wants 20+ logs), so go on a logging trip to the nearest grove, out to 64 blocks and then to 160, and cut
      // there with the time starting again. Trees only: an ore 50 blocks off is inside the rock, and walking at one
      // left sonnet standing still for 3 minutes "walking out to find coal_ore"
      if (!found.length && trees && trips < 2) {
        // never in the dark (a build's materials come through here, past the tools' night rules)
        if (b.isNight()) return have() > start ? `got ${have() - start} of ${count} ${item}; the trip for the rest waits for dawn` : `it's night: the trip out for ${item} waits for dawn`;
        trips++;
        const grove = b.findGrove(plan.blocks, trips === 1 ? 64 : 160, (gx, gz) => theirs(gx, gz) || badGrove(gx, gz));
        if (grove) {
          // out of the ground first: from a tunnel the path search finds no way up to the grove, and haiku walked its
          // tunnel under the town back and forth instead ("ended 0.0 from where it started", season 13 day 8)
          const top = b.surfaceAt(Math.floor(b.phys.x), Math.floor(b.phys.z));
          const indoors = footprints().some((r) => b.phys.x >= r.x0 && b.phys.x <= r.x1 + 1 && b.phys.z >= r.z0 && b.phys.z <= r.z1 + 1);
          if (b.covered() && !indoors && top >= 0 && b.phys.y < top - 1 && !b.outInTheOpen()) {
            b.action = "climbing out of the ground to go logging";
            await b.digOut();
          }
          trip = { x: grove[0], z: grove[2], had: have() };
          const far = Math.round(Math.hypot(grove[0] - b.phys.x, grove[2] - b.phys.z));
          b.action = `going on a logging trip for ${item}, ${far} blocks out`;
          // to the foot of that tree, not the log itself: the grove search can pick a log five up the trunk, and a goal
          // up in the canopy had sonnet walking back and forth below it ("ended 0.2 from where it started")
          let foot = grove[1];
          while (foot > 2 && ([B.OAK_LOG, B.BIRCH_LOG, B.PALM_LOG] as number[]).includes(b.get(grove[0], foot - 1, grove[2]))) foot--;
          const near = () => Math.hypot(grove[0] + 0.5 - b.phys.x, grove[2] + 0.5 - b.phys.z) <= 5;
          await b.goto(grove[0] + 0.5, foot, grove[2] + 0.5, 4, { maxMs: trips === 1 ? 40000 : 120000, done: near });
          // never got there (a cliff, water, no path): that grove is off for 10 minutes, so the next trip, now or on
          // the next collect, picks another (sonnet walked back and forth for minutes 118 blocks out)
          if (Math.hypot(b.phys.x - grove[0], b.phys.z - grove[2]) > 6) BAD_GROVES.push({ x: grove[0], z: grove[2], until: Date.now() + 600000 });
          t0 = Date.now();
          continue;
        }
      }
      if (!found.length) break;
      const [x, y, z] = found[0];
      const id = b.get(x, y, z);
      const tool = b.bestToolFor(id);
      if (!canHarvest(id, tool)) return `${BLOCKS[id]?.key ?? item} drops nothing without the right tool (craft a pickaxe first)`;
      tried++;
      MINING.set(this.name, { x, z, at: Date.now() });
      // a tree comes down whole: every log of it, the high ones from a pillar up its trunk, even past the count (a
      // trunk left hanging in the air, or a top it couldn't reach, is what Laith saw: "they also do not finish
      // mining it entirely when they cut down the tree")
      if (trees && LOG_IDS.has(id)) {
        const fell = await this.fell(x, y, z, theirs);
        if (fell) {
          if (fell.stump) stumps.push(fell.stump);
          for (const [lx, ly, lz] of fell.left) skip.add(lx + lz * 512 + ly * 262144);
          if (!fell.got) skip.add(x + z * 512 + y * 262144);
          if (tried > count * (leafy ? 30 : 3) + 6) break;
          continue;
        }
      }
      const under = b.get(x, y - 1, z);
      if (trees && (under === B.GRASS || under === B.DIRT) && !theirs(x, z)) stumps.push([x, y, z, id === B.BIRCH_LOG]);
      const ok = await b.mine(x, y, z);
      if (!ok) skip.add(x + z * 512 + y * 262144);
      else await b.pickUp(5, 5000);
      if (tried > count * (leafy ? 30 : 3) + 6) break;
    }
    const got = have() - start;
    if (trip && have() <= trip.had) BAD_GROVES.push({ x: trip.x, z: trip.z, until: Date.now() + 600000 });
    if (stumps.length && !b.isNight() && !b.abort && !b.dead) {
      const n = await this.replant(stumps);
      if (n) this.log.push(`planted ${n} sapling${n > 1 ? "s" : ""} where the trees were cut`);
    }
    if (got >= count) return `got ${got} ${item}`;
    if (!tried) return `no ${item} within 32 blocks${plan.blocks.includes(B.STONE) ? " (dig_down to reach stone)" : " (explore to find some)"}`;
    return `got ${got} of ${count} ${item}`;
  }

  // ---------------------------------------------------------------- the civilization

  /** The middle of the town plan, where the plaza goes and the main streets start (agents/town.ts), kept in the pack
   *  once chosen: an old town's plaza, else its well; a new town's is open level ground near the base with room for
   *  the plaza's square round it. */
  private hub(): Point {
    if (PACK.centre) return PACK.centre;
    const base = PACK.base!;
    const p = PACK.builds.find((x) => x.kind === "plaza") ?? PACK.builds.find((x) => x.kind === "well");
    let c: Point = { x: base.x, z: base.z };
    if (p) c = { x: Math.floor((p.x0 + p.x1) / 2), z: Math.floor((p.z0 + p.z1) / 2) };
    else {
      // a new town: of the spots near the base where the plaza's square fits, the one with the most room for lots
      // along its streets (a plaza in a valley under a cliff has nowhere to put the houses)
      const avoid = [...footprints(), ...this.villageRects()];
      const fits = this.groundFits();
      let best = -1;
      for (let dz = -24; dz <= 24; dz += 4)
        for (let dx = -24; dx <= 24; dx += 4) {
          if (Math.hypot(dx, dz) > 24) continue;
          const cc = { x: base.x + dx, z: base.z + dz };
          const r = plazaRect(cc);
          if (inHub(cc.x, cc.z) || avoid.some((f) => r.x0 <= f.x1 + 1 && r.x1 >= f.x0 - 1 && r.z0 <= f.z1 + 1 && r.z1 >= f.z0 - 1) || fits(r) < 0) continue;
          const score = lotRoom(cc, fits) * 4 - Math.hypot(dx, dz) / 4;
          if (score > best) [best, c] = [score, cc];
        }
      if (best < 0) {
        const spot = this.body.siteNear(base.x, base.z, base.y, 11, 11, avoid, 32, 0, 3);
        // (the whole plaza square clear of the spawn hub, not just its middle: season 13's plaza had a third of its
        // square in the hub, where nothing is dug, and was given up as a bad spot)
        if (spot) {
          const cc = { x: spot.x0 + 5, z: spot.z0 + 5 };
          const r = plazaRect(cc);
          let clear = true;
          for (let x = r.x0; x <= r.x1 && clear; x++) for (let z = r.z0; z <= r.z1 && clear; z++) if (inHub(x, z)) clear = false;
          if (clear) c = cc;
        }
      }
    }
    PACK.centre = c;
    savePack();
    return c;
  }

  /** The villages' land (25 blocks round each square): never built on, never farmed. */
  private villageRects(r = 25): Rect[] {
    return (this.body.world?.villages ?? []).map((k) => VILLAGE_SITES[k]).filter(Boolean).map((v) => ({ x0: v.x - r, z0: v.z - r, x1: v.x + r, z1: v.z + r }));
  }

  /** The town plan's streets and the plaza, as rectangles nothing else (a farm, a building off the plan) should take. */
  private planRects(): Rect[] {
    const c = this.hub();
    const out: Rect[] = [plazaRect(c), ...keptLots(c, PACK.builds)];
    for (const st of streetsOf(c)) {
      const a = [st.o.x + st.d[0] * st.t0, st.o.z + st.d[1] * st.t0];
      const z = [st.o.x + st.d[0] * st.t1, st.o.z + st.d[1] * st.t1];
      const w = STREET_HALF + 1;
      out.push({ x0: Math.min(a[0], z[0]) - (st.d[0] ? 0 : w), z0: Math.min(a[1], z[1]) - (st.d[1] ? 0 : w), x1: Math.max(a[0], z[0]) + (st.d[0] ? 0 : w), z1: Math.max(a[1], z[1]) + (st.d[1] ? 0 : w) });
    }
    return out;
  }

  /** A building's plan at a tier, whatever its kind (the wall, the roads and the farms have their own). */
  private planOf(site: Building, tier: number, building = false): { cells: PlanCell[]; of?: number[] } {
    const b = this.body;
    const base = PACK.base!;
    if (site.kind === "wall") {
      // never through a building, and a gap where a road crosses it
      const lots = PACK.builds.filter((x) => x.kind !== "wall" && x.kind !== "road" && x.kind !== "farm");
      const road = PACK.builds.find((x) => x.kind === "road");
      const paths = new Set(road ? this.planOf(road, 1).cells.map(([x, , z]) => `${x},${z}`) : []);
      const skip = (x: number, z: number) => paths.has(`${x},${z}`) || lots.some((r) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1);
      return noHub({ cells: wallPlan(Math.floor((site.x0 + site.x1) / 2), Math.floor((site.z0 + site.z1) / 2), Math.floor((site.x1 - site.x0) / 2), (x, z) => b.landAt(x, z, base.y), tier, skip) });
    }
    if (site.kind === "road") return noHub(streetPlan(this.hub(), PACK.builds.filter((x) => x.done || x === site), (x, z) => b.pathAt(x, z, base.y), tier));
    if (site.kind === "farm") return noHub({ cells: farmPlan(site, tier, this.hub(), (x, z) => b.landAt(x, z, base.y)) });
    const cells = planFor(site, tier, (x, z) => b.naturalGround(x, z, base.y));
    if (!building || site.done) return noHub({ cells });
    // building it: the trees on its lot come down first, the canopy and all (a trunk left standing on the plaza, or
    // leaves hanging over a lot, are in the way of the blocks there; their saplings go in again in the tree farm)
    const have = new Set(cells.map(([x, y, z]) => `${x},${y},${z}`));
    const trees: PlanCell[] = [];
    for (let x = site.x0; x <= site.x1; x++) for (let z = site.z0; z <= site.z1; z++) for (let y = site.y; y <= site.y + 14; y++) if (TREE_IDS.has(b.get(x, y, z)) && !have.has(`${x},${y},${z}`)) trees.push([x, y, z, "a"]);
    return noHub({ cells: trees.length ? [...trees.sort((p, q) => q[1] - p[1]), ...cells] : cells });
  }

  /** Why nothing would go in, when the build couldn't say: what is in the first cells still to do (inside the spawn
   *  hub, a tree, water, out of reach, someone's things). */
  private whyStuck(cells: PlanCell[]): string {
    const b = this.body;
    const left = cells.filter((c) => !cellTarget(c[3])?.optional && b.needsWork(c));
    if (!left.length) return "";
    const say: string[] = [];
    for (const [x, y, z, k] of left.slice(0, 60)) {
      const id = b.get(x, y, z);
      const what = BLOCKS[id]?.name ?? "something";
      const want = cellTarget(k.split("|")[0]);
      const at = `x=${x} y=${y} z=${z}`;
      const why = inHub(x, z) ? `${at} is inside the spawn hub, where nothing is dug`
        : TREE_IDS.has(id) ? `a tree in the way (${what} at ${at}${b.reachTo(x, y, z) > 4.3 ? ", out of reach" : ""})`
        : IS_WATER[id] ? `water at ${at}`
        : isStorage(id) ? `somebody's ${what} at ${at}`
        : b.reachTo(x, y, z) > 4.3 ? `${want ? (BLOCKS[want.id]?.name ?? "the block") : what} at ${at} is out of reach from where it stood`
        : `${what} at ${at}${want ? ` where ${BLOCKS[want.id]?.name ?? "a block"} goes` : ""}`;
      if (!say.includes(why)) say.push(why);
      if (say.length >= 3) break;
    }
    return `${left.length} cells won't take: ${say.join("; ")}`;
  }

  /** How far a building is built up: the highest tier whose plan it meets (a few blocks short is fine: a torch
   *  knocked off, one cell nobody can reach), 0 for an old building that doesn't meet tier 1. */
  private measure(site: Building): number {
    const b = this.body;
    if (site.kind === "road") {
      const [, paved, all] = this.roadCount(site);
      return all > 0 && paved >= all ? 2 : 1;
    }
    for (let t = topOf(site); t >= 1; t--) {
      if (site.kind === "farm" && t === 1) return 1; // a farm is a farm once its field is planted
      const req = this.planOf(site, t).cells.filter(([, , , k]) => !cellTarget(k)?.optional && k !== "?p");
      const bad = req.filter((c) => b.needsWork(c)).length;
      // the same allowance as finishing a build: a few trim blocks no pillar reaches don't make it a ruin (the audit
      // had marked sonnet's just-finished cottage "down to tier 0" nine seconds after it counted it done)
      if (bad <= Math.floor(req.length * (site.kind === "wall" ? 0.06 : 0.035)) || (bad <= 6 && req.length >= 120 && site.kind !== "wall")) return t;
    }
    return 0;
  }

  /** How many buildings the roads join to the middle of the town: [any path, paved, buildings with a door]. */
  private roadCount(road: Building): [number, number, number] {
    const b = this.body;
    const builds = PACK.builds.filter((x) => x.done || x === road);
    // (never the cells in the spawn hub: nothing is dug there, and a path through it would never count)
    const p1 = noHub(streetPlan(this.hub(), builds, (x, z) => b.pathAt(x, z, PACK.base!.y), 1));
    const p2 = noHub(streetPlan(this.hub(), builds, (x, z) => b.pathAt(x, z, PACK.base!.y), 2));
    const doors = builds.map((x, i) => (doorStep(x) && x.kind !== "lamp" ? i : -1)).filter((i) => i >= 0);
    const joined = (p: { cells: PlanCell[]; of: number[] }) => doors.filter((i) => p.cells.every((c, k) => p.of[k] !== i || !b.needsWork(c))).length;
    return [joined(p1), joined(p2), doors.length];
  }

  /** One of the town's buildings at the base: a new one, the next blocks of one that's half built or needs fixing,
   *  or (upgrade) the next tier of one that stands. One whole job: it fetches and makes what the plan needs. */
  private async buildTown(kind: Kind, upgrade = false, job?: Job): Promise<string> {
    const b = this.body;
    const all: Kind[] = [...BUILD_KINDS, "farm"];
    if (!all.includes(kind)) return `there is no "${kind}" to build: ${all.join(", ")}`;
    if (!PACK.base) return "the pack has no base yet: the first house anyone builds becomes it (build_house)";
    if (kind === "farm" && !upgrade) return "farms are made with farm (a hoe and wheat_seeds, beside water); upgrade farm puts a fence round one";
    const base = PACK.base;
    // (the town plan's lots run a long way out along the streets: near the town is near enough, the job walks to the
    // building itself)
    const far = Math.hypot(base.x - b.phys.x, base.z - b.phys.z);
    if (far > 110) return `you're ${Math.round(far)} blocks from the base: go_to_base first`;
    this.auditTown();
    const where = (s: Rect) => `x=${Math.round((s.x0 + s.x1) / 2)} z=${Math.round((s.z0 + s.z1) / 2)}`;
    const others = (s: Building) => !!s.busy && s.busy.by !== this.name && Date.now() - s.busy.at < 45000 && !!BOARD.get(s.busy.by);
    let site: Building | undefined;
    let tier = 1;
    // the building a job names (by its middle)
    const mid = (x: Rect) => [Math.round((x.x0 + x.x1) / 2), Math.round((x.z0 + x.z1) / 2)];
    const named = job?.at ? PACK.builds.find((x) => x.kind === kind && !isHome(x) && mid(x)[0] === job.at![0] && mid(x)[1] === job.at![1]) : undefined;
    if (upgrade) {
      // the one the job names, else the lowest of that kind first (one already being upgraded before any other), the
      // nearest of those
      const can = named && named.done && tierOf(named) >= 1 && tierOf(named) < topOf(named) && !others(named) ? [named] : PACK.builds.filter((x) => x.kind === kind && x.done && !isHome(x) && tierOf(x) >= 1 && tierOf(x) < topOf(x) && !others(x));
      can.sort((p, q) => (q.up ? 1 : 0) - (p.up ? 1 : 0) || tierOf(p) - tierOf(q) || Math.hypot((p.x0 + p.x1) / 2 - b.phys.x, (p.z0 + p.z1) / 2 - b.phys.z) - Math.hypot((q.x0 + q.x1) / 2 - b.phys.x, (q.z0 + q.z1) / 2 - b.phys.z));
      site = can[0];
      if (!site) {
        const some = PACK.builds.filter((x) => x.kind === kind && !isHome(x));
        if (!some.length) return `there is no ${nameOf(kind)} to upgrade yet: build one first`;
        if (some.every((x) => tierOf(x) >= topOf(x))) return `every ${nameOf(kind).replace(/^an? |^the /, "")} is at its top tier: ${this.nextWork()}`;
        if (some.some((x) => !x.done || tierOf(x) < 1)) return `the ${civLabel(kind, 2)} there are aren't finished (or are old ones that don't meet the tier 1 design): build ${kind} first, then upgrade`;
        return `someone else is working on the ${civLabel(kind, 2)} right now: ${this.nextWork()}`;
      }
      tier = site.up ?? tierOf(site) + 1;
      site.up = tier;
    } else {
      // the one the job names (to finish, fix or plant again); else one of that kind half built that nobody else is
      // on, needing fixing, or an old design to rebuild (the roads are one network: building them again carries them
      // on to every new door); else a new one, on the job's lot when it has one
      const again = named && (!named.done || named.fix || tierOf(named) < 1 || job?.kind === "plant" || job?.kind === "repair");
      site = again ? named : PACK.builds.find((x) => x.kind === kind && !isHome(x) && (!x.done || x.fix || tierOf(x) < 1 || kind === "road") && (!others(x) || kind === "road"));
      if (!site) {
        const most = Math.max(0, KIND_INFO[kind]?.most ?? 0, ...STAGES.flatMap((st) => st.needs.filter(([k]) => k === kind).map(([, n]) => n)));
        const final = progress(civCount).next === null;
        const once = ONCE.has(kind);
        if (once && PACK.builds.some((x) => x.kind === kind)) return `${nameOf(kind)} is already built: upgrade ${kind} to make it better, or ${this.nextWork()}`;
        if (!final && most && civCount(kind, 1) >= most) return `the town already has all the ${civLabel(kind, 2)} it needs (${civCount(kind, 1)}): ${this.nextWork()}`;
        const hub = this.hub();
        // the wall round the old town, its gates where the main streets go through
        const r = wallRadius();
        if (kind === "wall") site = { kind, x0: hub.x - r, z0: hub.z - r, x1: hub.x + r, z1: hub.z + r, y: base.y, by: [], done: false, at: Date.now(), face: 0 };
        else if (kind === "road") site = { kind, x0: hub.x, z0: hub.z, x1: hub.x, z1: hub.z, y: base.y, by: [], done: false, at: Date.now() };
        else {
          // the lot the board picked for the job (if it is still free and the ground still takes it), else the best now
          const kept = job?.lot && this.lotFree(job.lot);
          const spot = kept ? { ...job!.lot!, y: kept } : this.townSite(kind as Exclude<Kind, "farm" | "road" | "wall">);
          if (typeof spot === "string") return spot;
          site = { kind, x0: spot.x0, z0: spot.z0, x1: spot.x1, z1: spot.z1, y: spot.y, face: spot.face, by: [], done: false, at: Date.now() };
          if (spot.design && spot.design !== kind && DESIGNS[spot.design]?.kind === kind) site.design = spot.design;
          if (this.needsCut(site, site.y)) site.cut = true;
        }
        PACK.builds.push(site);
        savePack();
      }
      // a fix (or planting a tree farm again) goes back to the best tier it had; a new one, or an old design rebuilt,
      // to tier 1
      tier = site.fix || (again && site.done) ? Math.max(1, site.best ?? tierOf(site) ?? 1) : site.done && tierOf(site) >= 1 ? tierOf(site) : 1;
    }
    const s = site;
    if (others(s)) return `${s.busy!.by} is working on ${nameOf(kind)} right now: help another way (bring them blocks with give, build something else, or gather what the next stage needs)`;
    s.busy = { by: this.name, at: Date.now() };
    if (!s.by.includes(this.name)) s.by.push(this.name);
    const what = `${designName(s)}${tier > 1 ? ` (tier ${tier})` : ""}`;
    const cells = this.planOf(s, tier, true).cells;
    // a pier goes out from the shore: its cells nearest the land first, so the builder walks out along the deck as it
    // grows (over the water there is nowhere else to stand)
    if (kind === "pier") {
      const ds = doorStep(s);
      if (ds) cells.sort((p, q) => Math.hypot(p[0] - ds[0], p[2] - ds[1]) - Math.hypot(q[0] - ds[0], q[2] - ds[1]));
    }
    if (kind === "road" && !cells.length) {
      s.busy = undefined;
      if (!s.done) PACK.builds = PACK.builds.filter((x) => x !== s);
      savePack();
      return "no paths to make yet: the roads join buildings with doors to the plaza (build houses, the plaza, a storehouse first)";
    }
    // stand in the middle and build round itself, the way a player does: everything in a small building is in reach
    // from there, so it doesn't circle the building for every block (not the tower: in its hollow it can't reach out)
    const toMiddle = async () => {
      const sx = Math.floor((s.x0 + s.x1) / 2);
      const sz = Math.floor((s.z0 + s.z1) / 2);
      // a long way off (a lot far out along a street, back from a logging trip): over to it first
      if (kind !== "road" && kind !== "wall" && Math.hypot(sx + 0.5 - b.phys.x, sz + 0.5 - b.phys.z) > 20) {
        b.action = `walking over to ${nameOf(kind)}`;
        await b.goto(sx + 0.5, s.y, sz + 0.5, 6, { maxMs: 90000, done: () => Math.hypot(sx + 0.5 - b.phys.x, sz + 0.5 - b.phys.z) < 8 });
      }
      if (kind === "wall" || kind === "lamp" || kind === "tower" || kind === "road" || kind === "farm") return;
      if (Math.hypot(sx + 0.5 - b.phys.x, sz + 0.5 - b.phys.z) > 1.2) await b.goto(sx + 0.5, s.y, sz + 0.5, 0.8, { maxMs: 30000 });
    };
    const req = cells.filter(([, , , k]) => !cellTarget(k)?.optional && k !== "?p");
    // paths are dug with a shovel: make one if it has none (a stone one from a cobblestone and two sticks)
    // (with no planks for the sticks, any log will do: sonnet had no wood at all, made no shovel, and every road cell
    // failed "in the way, or out of reach")
    const shovel = () => b.inv.some((st) => st && itemDef(st.id)?.tool?.kind === "shovel");
    if (cells.some(([, , , k]) => k === "p" || k === "?p") && !shovel()) {
      for (let tries = 0; tries < 2 && !shovel() && !b.abort && !b.dead; tries++) {
        if (!b.has(I.STICK, 2) && !b.has(B.OAK_PLANKS, 2) && !b.has(B.BIRCH_PLANKS, 2)) for (const p of ["oak_planks", "birch_planks"]) if (!b.has(B.OAK_PLANKS, 2) && !b.has(B.BIRCH_PLANKS, 2)) await b.craft(p, 1);
        if (!b.has(I.STICK, 2)) await b.craft("sticks", 1);
        if (!(b.has(B.COBBLESTONE) && (await b.craft("stone_shovel", 1)).made)) await b.craft("wooden_shovel", 1);
        if (!shovel() && tries === 0) {
          b.action = "getting wood for a shovel";
          await this.collect("log", 3);
        }
      }
    }
    const left = () => req.filter((c) => b.needsWork(c)).length;
    // a floor above (a townhouse's, an inn's) and the room on it go in only once the rest is up, roof and all: till
    // then the room is open to the roof, and the pillar a builder climbs to reach the roof's middle stands on the floor
    // below (the agents climb no ladders); with nothing more going in without it, the floor goes in all the same
    const bpx = designOf(s);
    const upper = bpx?.floors?.length ? Math.min(...bpx.floors) : -1;
    const em = bpx?.eaves ?? 0;
    const held = new Set(upper < 0 || !bpx ? [] : cells.filter(([x, y, z]) => y >= s.y + upper && y < s.y + bpx.walls && x > s.x0 + em && x < s.x1 - em && z > s.z0 + em && z < s.z1 - em));
    let withhold = held.size > 0 && req.some((c) => !held.has(c) && b.needsWork(c));
    // one job, start to finish: short of something, it goes and gets it (mines stone, chops oak, smelts, crafts the
    // stairs and the door), comes back to the middle and carries on; it only hands back when the building is up, the
    // time is up, or something it can't get by itself is missing
    const deadline = Date.now() + 6 * 60000;
    let r: Awaited<ReturnType<typeof b.buildCells>> = { placed: 0, left: left(), outOf: false, why: "", short: new Map() };
    let placed = 0;
    const lacking = new Set<string>();
    let first = true;
    let dirtTried = false;
    let tried = false; // the blocks went to the site at least once without being cut short
    for (let round = 0; round < 8 && !b.abort && !b.dead && Date.now() < deadline && left() > 0; round++) {
      s.busy = { by: this.name, at: Date.now() };
      const need = this.billOf(cells);
      if (need.size) {
        const before = placed;
        // the pack's pool first: what the storehouse has of it (and of what it is made from)
        if (round <= 1) {
          const took = await this.fromStore(need);
          if (took) this.log.push(took);
        }
        const got = await this.supply(this.billOf(cells), kind, first);
        first = false;
        for (const g of got.missing) lacking.add(g);
        if (!got.any && !r.placed && round > 0 && before === placed) break; // nothing more to be had: the brain decides
      }
      // back up to the town first: from a tunnel under the site the path planner stops right below the cells, so it
      // shuffled about 15 blocks under the watchtower "building" it (opus, after mining stone down there)
      if (b.phys.y < s.y - 3) {
        b.action = `climbing back up to ${nameOf(kind)}`;
        await b.digOut();
      }
      await toMiddle();
      r = await b.buildCells(withhold ? cells.filter((c) => !held.has(c)) : cells, kind === "wall" || kind === "road" ? 64 : 120, `${upgrade ? "upgrading" : "building"} ${what}`, s.y);
      placed += r.placed;
      if (!b.abort && !b.dead) tried = true;
      // (the rest is up, or nothing more goes in without the floor: the floor next, straight away)
      if (withhold && (!r.placed || !req.some((c) => !held.has(c) && b.needsWork(c)))) {
        withhold = false;
        if (!b.abort && !b.dead) continue;
      }
      // out of reach for want of a few spare blocks to stand on (the pillar it climbs is built of them): dig some dirt
      // and go again (sonnet tried a cottage's last six roof blocks turn after turn with none)
      if (!r.placed && !r.outOf && b.scaffoldNeed > 0 && !dirtTried) {
        dirtTried = true;
        b.action = `getting dirt to climb up to ${nameOf(kind)}`;
        await this.collect("dirt", Math.min(32, b.scaffoldNeed + 10));
        continue;
      }
      if (!r.placed && !r.outOf) break; // in the way or out of reach: more blocks won't help
      if (!r.placed && r.outOf && !this.billOf(cells).size) break;
    }
    s.busy = undefined;
    const missing = left();
    const short = [...this.billOf(cells)].map(([id, n]) => `${n} ${key(id)}`);
    // done when all but a few trim blocks are in: a cottage's last eave blocks over a slope can be out of reach from
    // every pillar spot, and sonnet's third cottage sat at "6 blocks to go" (of about 190) for an hour
    if (missing <= Math.floor(req.length * (kind === "wall" ? 0.06 : 0.035)) || (missing <= 6 && r.why.includes("out of reach") && !r.outOf && req.length >= 120)) {
      const fixed = s.fix;
      const wasDone = s.done;
      s.done = true;
      s.fix = false;
      s.tier = tier;
      s.best = Math.max(s.best ?? 0, tier);
      s.up = undefined;
      s.stuck = 0;
      if (kind === "road") s.joined = this.roadCount(s).slice(0, 2) as [number, number];
      const news = upgrade ? `${this.name} upgraded ${nameOf(kind)} at ${where(s)} to tier ${tier}` : fixed ? `${this.name} fixed up ${nameOf(kind)}` : wasDone ? `${this.name} rebuilt ${nameOf(kind)} to the town's design` : `${s.by.join(" and ")} finished ${nameOf(kind)}`;
      this.civUpdate(news);
      // a short line for the others (the board moves on to the next project)
      if (kind !== "road" && kind !== "lamp") this.teamSay(upgrade ? `${nameOf(kind)} is up to tier ${tier}.` : `${nameOf(kind).replace(/^./, (ch) => ch.toUpperCase())} is done${s.by.length > 1 ? `, thanks ${s.by.filter((n) => n !== this.name).join(" and ")}` : ""}.`);
      if (PACK.board?.project?.kind === kind) PACK.board.at = 0;
      if (PACK.board) PACK.board.qat = 0;
      return `${upgrade ? `upgraded ${designName(s)} at ${where(s)} to tier ${tier}` : `finished ${what} at ${where(s)}`} (${placed} blocks placed). ${tier < topOf(s) ? `It can go to tier ${tier + 1}: ${upOf(s, tier + 1)} (upgrade ${kind}).` : ""}`;
    }
    // a spot where nothing will go in, turn after turn (on a roof, walled off, out of reach): give up on it, so the
    // next build picks a better one instead of everyone trying the same blocks forever
    // (only a real try counts: a build cut short by a reflex isn't the spot's fault. Season 12's first cottage was
    // given up as "a bad spot" after dusk sent opus home three times on its way back with the oak, and the same
    // ground was picked again straight after)
    s.stuck = placed ? 0 : tried ? (s.stuck ?? 0) + 1 : s.stuck ?? 0;
    // (what is in the way, when the build couldn't say)
    const why = r.why || (!placed && tried ? this.whyStuck(cells) : "");
    // (a building with a spot of its own is never given up: the same spot would come round again)
    if (!upgrade && s.stuck >= 3 && !r.outOf && !s.done && kind !== "wall" && kind !== "road" && !FIXED.has(kind)) {
      PACK.builds = PACK.builds.filter((x) => x !== s);
      savePack();
      return `gave up on ${nameOf(kind)} at ${where(s)}: nothing would go in there three times (${why || "a bad spot"}). build it again and a better spot gets picked`;
    }
    savePack();
    const still = short.length ? ` Still needed: ${short.join(", ")}${lacking.size ? ` (${[...lacking].join("; ")})` : ""}.` : "";
    if (!placed && !tried) return `stopped work on ${what} at ${where(s)} before a block went in (${b.dead ? "you died" : "something else came up"}); ${missing} blocks to go.${still}`;
    if (!placed) return `couldn't ${upgrade ? "upgrade" : "build"} ${what} at ${where(s)}: ${r.outOf ? "out of materials" : why || "in the way, or out of reach"}; ${missing} blocks to go.${still}${FIXED.has(kind) && (s.stuck ?? 0) >= 3 ? ` (it has a spot of its own in the town plan: clear what is in the way there, or build something else meanwhile)` : ""}`;
    return `placed ${placed} blocks on ${what} at ${where(s)}: ${missing} to go.${still}`;
  }

  /** A spot for a new building near the base: flat open ground clear of the rest of the town and the villages, its
   *  front turned to the middle of the town. A lamp post goes beside a road when there are roads to light. */
  private townSite(kind: Exclude<Kind, "farm" | "road" | "wall">, avoid: Rect[] = []): { x0: number; z0: number; x1: number; z1: number; y: number; face: number; design?: string; where?: string } | string {
    const b = this.body;
    const base = PACK.base!;
    const hub = this.hub();
    const villages: Rect[] = (b.world?.villages ?? []).map((k) => VILLAGE_SITES[k]).filter(Boolean).map((v) => ({ x0: v.x - 25, z0: v.z - 25, x1: v.x + 25, z1: v.z + 25 }));
    if (kind === "lamp") {
      // lit streets: a step off a path, at least 7 blocks from any other lamp, nearest the middle first
      const road = PACK.builds.find((x) => x.kind === "road");
      const lamps = PACK.builds.filter((x) => x.kind === "lamp");
      if (road) {
        const fp = footprints();
        const { cells } = this.planOf(road, 1);
        const onRoad = new Set(cells.map(([x, , z]) => `${x},${z}`));
        const spots: [number, number, number][] = [];
        for (const [x, , z] of cells)
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const px = x + dx;
            const pz = z + dz;
            // (the row beside a street, between it and the fronts, is where lamp posts go: not in a building, never on
            // a path or a street)
            if (onRoad.has(`${px},${pz}`) || fp.some((r) => px >= r.x0 && px <= r.x1 && pz >= r.z0 && pz <= r.z1)) continue;
            if (lamps.some((l) => Math.hypot(l.x0 - px, l.z0 - pz) < 7)) continue;
            const g = b.naturalGround(px, pz, base.y);
            if (g < 0 || SOLID[b.get(px, g + 1, pz)] || SOLID[b.get(px, g + 2, pz)]) continue;
            spots.push([px, g + 1, pz]);
          }
        spots.sort((p, q) => Math.hypot(p[0] - hub.x, p[2] - hub.z) - Math.hypot(q[0] - hub.x, q[2] - hub.z));
        // its post in the style of the street it lights (stone on the stone avenue, birch in the birch district)
        if (spots.length) {
          const si = streetAt(hub, spots[0][0], spots[0][2], 3);
          const st = si >= 0 ? styleOf(si, this.townStyles()) : "oak";
          return { x0: spots[0][0], z0: spots[0][2], x1: spots[0][0], z1: spots[0][2], y: spots[0][1], face: 0, design: st === "stone" ? "lamp/stone" : st === "birch" ? "lamp/birch" : "lamp" };
        }
      }
      // (off the roads too: never two side by side, a lamp every seven blocks or so)
      const apart = lamps.map((l) => ({ x0: l.x0 - 5, z0: l.z0 - 5, x1: l.x1 + 5, z1: l.z1 + 5 }));
      const spot = b.siteNear(base.x, base.z, base.y, 1, 1, [...footprints(), ...apart], 24, 2, 2);
      return spot ? { x0: spot.x0, z0: spot.z0, x1: spot.x0, z1: spot.z0, y: spot.y, face: 0 } : "no open spot near the base for a lamp post: clear some trees near the base";
    }
    const [w, d] = KINDS[kind].size;
    const big = w * d >= 80;
    // the town plan first: the plaza on its square in the middle, everything else on a lot along a street in its
    // district (agents/town.ts); open ground round the base when the plan has no lot that will do, or when its lot is
    // well out past the district and open ground is much nearer the plaza (on rough ground a compact town beats a
    // straight one: the builders walk less)
    const plan = this.planSite(kind, avoid);
    // street furniture, a pier, a gatehouse or an arch only go where the plan has a place for them
    if (!plan && ["shore", "street", "gate", "span"].includes(KIND_INFO[kind]?.district ?? "")) return `no spot for ${nameOf(kind)} ${districtOf(kind)} yet: ${this.nextWork()}`;
    if (plan) {
      const c = this.hub();
      const out = (r: Rect) => Math.max(Math.max(0, r.x0 - c.x, c.x - r.x1), Math.max(0, r.z0 - c.z, c.z - r.z1));
      const far = districtFar(kind);
      if (out(plan) <= far + 8 || kind === "plaza") return plan;
      const [w0, d0] = KINDS[kind].size;
      const near = b.siteNear(c.x, c.z, base.y, w0, d0, [...footprints(), ...villages, ...this.planRects()], far + 6, 4, 3);
      if (!near || out({ x0: near.x0, z0: near.z0, x1: near.x0 + w0 - 1, z1: near.z0 + d0 - 1 }) + 10 > out(plan)) return plan;
    }
    // the plaza goes right by the middle; the rest anywhere round it, the big ones further out on a little slope, and
    // further out still, step by step, when the town is crowded (sonnet walked round and round a full base looking
    // for flat ground for a watchtower)
    const near = kind === "plaza" ? 0 : 4;
    // (the plaza too, when the middle is built up: season 8's hamlet had no 9 by 9 left within 24 blocks of the base)
    const steps: [number, number][] = kind === "plaza" ? [[16, 2], [24, 3], [34, 3], [44, 3]] : big ? [[40, 3], [52, 3]] : [[30, 2], [40, 3], [52, 3]];
    for (const [far, slope] of steps)
      for (const [sw, sd] of w === d ? [[w, d]] : [[w, d], [d, w]]) {
        const spot = b.siteNear(base.x, base.z, base.y, sw, sd, [...footprints(), ...villages, ...this.planRects(), ...HUB_RECTS], far, near, slope);
        if (!spot) continue;
        const rect = { x0: spot.x0, z0: spot.z0, x1: spot.x0 + sw - 1, z1: spot.z0 + sd - 1 };
        let face = kind === "plaza" || kind === "well" ? 0 : faceToward(rect, hub.x, hub.z);
        const fits = (f: number) => sizeFacing(kind, f)[0] === sw;
        if (!fits(face)) {
          // turned the other way it would need the other rectangle: the side facing the middle best of the two that fit
          const opts = [0, 1, 2, 3].filter(fits);
          const toward = (f: number) => {
            const [dx, dz] = [[0, -1], [1, 0], [0, 1], [-1, 0]][f];
            return dx * (hub.x - (rect.x0 + rect.x1) / 2) + dz * (hub.z - (rect.z0 + rect.z1) / 2);
          };
          face = opts.sort((p, q) => toward(q) - toward(p))[0];
          if (w !== d && sw === w && opts.length && toward(face) < 0) continue; // try it turned the other way first
        }
        return { ...rect, y: spot.y, face };
      }
    return `no flat open spot near the base for ${nameOf(kind)} (${w} by ${d}): clear some trees or level some ground near the base`;
  }

  /** The ground check for a lot: the floor height for a rectangle, or -1 when the ground won't take it. A lot is
   *  levelled rather than passed over: up to three of slope is filled under the floor (as deep as the foundation
   *  goes); more, up to six, and the floor goes in lower, the low side filled three deep and the high side cut away
   *  (a terrace: the plan digs the ground over the floor out across the lot); trees on it come down first (their
   *  saplings go in again in the tree farm). Never water, anything built, the spawn hub (hubOk: the plaza on its spot
   *  takes a corner in the hub, built without it), or far above or below the base. */
  private groundFits(hubOk = false): (r: Rect) => number {
    const b = this.body;
    const base = PACK.base!;
    return (r: Rect): number => {
      let lo = 999;
      let hi = -1;
      for (let x = r.x0; x <= r.x1; x++)
        for (let z = r.z0; z <= r.z1; z++) {
          // (the plaza takes a corner in the spawn hub: it is built without it)
          if (inHub(x, z)) {
            if (hubOk) continue;
            return -1;
          }
          const g = this.soil(x, z, base.y);
          if (g < 0) return -1;
          lo = Math.min(lo, g);
          hi = Math.max(hi, g);
          if (hi - lo > 6 || Math.abs(g - base.y) > 12) return -1;
        }
      if (hi < 0) return -1;
      const y = hi - lo <= 3 ? hi + 1 : lo + 4;
      // nothing built standing over it (the ground it cuts away and the trees it fells are fine)
      for (let x = r.x0; x <= r.x1; x++)
        for (let z = r.z0; z <= r.z1; z++)
          for (let yy = y; yy <= y + 4; yy++) {
            if (hubOk && inHub(x, z)) break;
            const id = b.get(x, yy, z);
            if (SOLID[id] && !TREE_IDS.has(id) && !GROUND_IDS.has(id)) return -1;
          }
      return y;
    };
  }

  /** The natural ground under a column, looking through trees (a lot's trees get cut): its top, -1 over water or where
   *  nothing is loaded, -3 where something is built there. */
  private soil(x: number, z: number, near: number): number {
    const b = this.body;
    for (let y = Math.min(126, near + 14); y >= Math.max(2, near - 14); y--) {
      const id = b.get(x, y, z);
      if (IS_WATER[id]) return -1;
      if (!SOLID[id] || TREE_IDS.has(id)) continue;
      return GROUND_IDS.has(id) ? y : -3;
    }
    return -1;
  }

  /** Does a lot with its floor at y need the ground over the floor cut away (a terrace)? */
  private needsCut(r: Rect, y: number): boolean {
    if (!PACK.base) return false;
    for (let x = r.x0; x <= r.x1; x++) for (let z = r.z0; z <= r.z1; z++) if (this.soil(x, z, PACK.base.y) >= y) return true;
    return false;
  }

  /** A lot the board picked for a job, if it is still free and the ground still takes it: its floor, else 0. */
  private lotFree(l: Rect): number {
    if (PACK.builds.some((x) => x.kind !== "road" && x.kind !== "wall" && x.x0 <= l.x1 + 1 && x.x1 >= l.x0 - 1 && x.z0 <= l.z1 + 1 && x.z1 >= l.z0 - 1)) return 0;
    const y = this.groundFits()(l);
    return y > 0 ? y : 0;
  }

  /** The style of each main street's district (north, east, south, west), worked out once for the town: the plan's
   *  (stone up the avenue, timber-framed market streets, oak to the south), with birch for the district on the side of
   *  the town the most birch grows (its wood is near); with no birch near, the timber-framed streets go oak (their
   *  walls are birch planks). */
  private townStyles(): string[] {
    if (PACK.styles) return PACK.styles;
    if (!PACK.base) return STREET_STYLES;
    const c = this.hub();
    const by = [0, 0, 0, 0];
    for (const [x, , z] of this.body.findBlocks([B.BIRCH_LOG], 80, 600)) {
      const dx = x - c.x;
      const dz = z - c.z;
      by[Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 1 : 3) : dz > 0 ? 2 : 0]++;
    }
    const styles = [...STREET_STYLES];
    const most = by.indexOf(Math.max(...by));
    if (by[most] >= 6) styles[most] = "birch";
    else for (let i = 0; i < 4; i++) if (styles[i] === "timber") styles[i] = "oak";
    PACK.styles = styles;
    savePack();
    this.emit("plan", { text: `the town's districts: ${["north", "east", "south", "west"].map((d, i) => `the ${d} street ${styles[i]}`).join(", ")}` });
    return styles;
  }

  /** A spot beside a street for a bench or a flower bed: in the row by the street, off the paths to the doors, clear
   *  of the lamp posts and a few blocks from the other pieces, on ground that takes it; its design in the street's
   *  style. */
  private streetSpot(kind: Kind, avoid: Rect[]): { x0: number; z0: number; x1: number; z1: number; y: number; face: number; design?: string; where?: string } | null {
    const road = PACK.builds.find((x) => x.kind === "road");
    if (!road || !PACK.base) return null;
    const c = this.hub();
    const taken = new Set<string>(this.planOf(road, 1).cells.map(([x, , z]) => `${x},${z}`));
    for (const l of PACK.builds) {
      if (l.kind === "lamp") for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) taken.add(`${l.x0 + dx},${l.z0 + dz}`);
      if (l.kind === "bench" || l.kind === "flowerbed") for (let x = l.x0; x <= l.x1; x++) for (let z = l.z0; z <= l.z1; z++) taken.add(`furniture:${x},${z}`);
    }
    for (const r of avoid) for (let x = r.x0; x <= r.x1; x++) for (let z = r.z0; z <= r.z1; z++) taken.add(`${x},${z}`);
    const fits = this.groundFits();
    for (const spot of streetSpots(c, PACK.builds, KINDS[kind]?.designs[0] ?? kind, taken, 3).slice(0, 120)) {
      const y = fits(spot);
      if (y < 0) continue;
      return { x0: spot.x0, z0: spot.z0, x1: spot.x1, z1: spot.z1, y, face: spot.face, design: designFor(kind, c, spot.street, spot.t, this.townStyles()), where: spot.where };
    }
    return null;
  }

  /** A spot by the water near the town for a pier, a dock or a lighthouse: a pier's front on the shore and its deck
   *  out over the water; a lighthouse on the shore itself, the water right in front. Nearest the town first. */
  private shoreSite(kind: Kind, avoid: Rect[]): { x0: number; z0: number; x1: number; z1: number; y: number; face: number; design?: string; where?: string } | null {
    if (!PACK.base) return null;
    const b = this.body;
    const c = this.hub();
    const base = PACK.base;
    const design = KINDS[kind]?.designs[0] ?? kind;
    const W = DESIGNS[design]?.size[0] ?? 3;
    const out = (face: number) => [[0, 1], [-1, 0], [0, -1], [1, 0]][face];
    const taken = [...footprints(), ...this.villageRects(), ...this.planRects(), ...avoid];
    const wet = (x: number, z: number, g: number) => {
      for (let y = g + 1; y >= g - 3; y--) {
        const id = b.get(x, y, z);
        if (IS_WATER[id]) return true;
        if (SOLID[id]) return false;
      }
      return false;
    };
    const pier = DESIGNS[design]?.kind === "pier";
    for (let r = 14; r <= 96; r += 2)
      for (let k = 0; k < 64; k++) {
        const a = (k / 64) * Math.PI * 2;
        const px = Math.round(c.x + Math.cos(a) * r);
        const pz = Math.round(c.z + Math.sin(a) * r);
        const g = this.soil(px, pz, base.y);
        if (g < 0 || Math.abs(g - base.y) > 8 || inHub(px, pz)) continue;
        for (let face = 0; face < 4; face++) {
          const [ox, oz] = out(face);
          const [sw, sd] = sizeFacing(design, face);
          // the water: a pier's deck runs out over it from two blocks out; a lighthouse has it right past its far side
          const deep = (face % 2 ? sw : sd) + 1;
          if (pier ? !wet(px + ox * 2, pz + oz * 2, g) : !wet(px + ox * deep, pz + oz * deep, g) && !wet(px + ox * (deep + 1), pz + oz * (deep + 1), g)) continue;
          const h = Math.floor(W / 2);
          const x0 = face === 1 ? px - sw + 1 : face === 3 ? px : px - h;
          const z0 = face === 0 ? pz : face === 2 ? pz - sd + 1 : pz - h;
          const rect = { x0, z0, x1: x0 + sw - 1, z1: z0 + sd - 1 };
          if (taken.some((t) => rect.x0 <= t.x1 + 1 && rect.x1 >= t.x0 - 1 && rect.z0 <= t.z1 + 1 && rect.z1 >= t.z0 - 1)) continue;
          let ok = true;
          for (let x = rect.x0; x <= rect.x1 && ok; x++)
            for (let z = rect.z0; z <= rect.z1 && ok; z++) {
              const v = (x - px) * ox + (z - pz) * oz; // how far out from the shore
              const land = this.soil(x, z, base.y);
              if (pier) ok = v <= 1 ? land >= 0 && Math.abs(land - g) <= 1 : wet(x, z, g);
              else ok = land >= 0 && Math.abs(land - g) <= 2;
            }
          if (!ok) continue;
          return { ...rect, y: g + 1, face, design, where: `on the shore ${Math.round(r)} blocks ${dirWord(px - c.x, pz - c.z)} of the plaza` };
        }
      }
    return null;
  }

  /** A site on the town plan: the plaza's square at the centre, or the best lot along the streets for the kind, on
   *  ground that will take it (level within 2, or 3 for a big one, dry, nothing growing or standing over it, not the
   *  spawn hub or a village). Null when the plan has nothing that fits. */
  private planSite(kind: Exclude<Kind, "farm" | "road" | "wall" | "lamp">, avoid: Rect[] = []): { x0: number; z0: number; x1: number; z1: number; y: number; face: number; design?: string; where?: string } | null {
    const c = this.hub();
    const [w, d] = KINDS[kind].size;
    // street furniture beside the streets; piers and the lighthouse by the water
    const district = KIND_INFO[kind]?.district;
    if (district === "street") return this.streetSpot(kind, avoid);
    if (district === "shore") return this.shoreSite(kind, avoid);
    const fits = this.groundFits();
    const homes = houseRects().filter((h) => isHome(h));
    if (kind === "plaza") {
      const r = plazaRect(c);
      if (footprints().some((f) => r.x0 <= f.x1 && r.x1 >= f.x0 && r.z0 <= f.z1 && r.z1 >= f.z0)) return null;
      // on its own spot in the middle of the town plan, even when a corner of the square runs into the spawn hub
      const y = this.groundFits(true)(r);
      return y < 0 ? null : { ...r, y, face: 0 };
    }
    // the wall: where it stands (an old town's wall may not be where the plan has it), else where it will go
    const wall = PACK.builds.find((x) => x.kind === "wall");
    const wallSides: Rect[] = wall ? [{ ...wall, z1: wall.z0 + 1 }, { ...wall, z0: wall.z1 - 1 }, { ...wall, x1: wall.x0 + 1 }, { ...wall, x0: wall.x1 - 1 }].map((r) => ({ x0: r.x0 - 1, z0: r.z0 - 1, x1: r.x1 + 1, z1: r.z1 + 1 })) : [];
    const why: Record<string, number> = {};
    // the town's first tree farm is the small one: four saplings, planted in a few minutes
    const only = kind === "treefarm" && !PACK.builds.some((x) => x.kind === "treefarm") ? "treefarm/small" : undefined;
    const lot = chooseLot(kind as Exclude<Plain, "plaza" | "lamp">, c, PACK.builds, [...homes, ...this.villageRects(), ...wallSides, ...avoid], fits, wall ? 0 : WALL, why, this.townStyles(), only);
    if (process.env.PLAN_DEBUG) console.log(`[${this.name}] lot for ${kind}: ${lot ? `${lot.where} (${lot.design}), ${lot.out} out` : "none"} (passed over: ${Object.entries(why).map(([k, n]) => `${k} ${n}`).join(", ")})`);
    if (!lot || w <= 0 || d <= 0) return null;
    return { x0: lot.x0, z0: lot.z0, x1: lot.x1, z1: lot.z1, y: lot.y, face: lot.face, design: lot.design, where: lot.where };
  }

  /** The items a plan still needs, for the cells that still need work (what it carries already taken off). */
  private billOf(cells: PlanCell[]): Map<number, number> {
    const b = this.body;
    const need = new Map<number, number>();
    for (const c of cells) {
      const t = cellTarget(c[3]);
      if (!t || t.optional || !b.needsWork(c)) continue;
      const item = itemOf(t.id);
      need.set(item, (need.get(item) ?? 0) + 1);
    }
    for (const [id, n] of need) {
      const have = b.count(id);
      if (have >= n) need.delete(id);
      else need.set(id, n - have);
    }
    return need;
  }

  /** Get what a building needs: the raw stuff first (cobblestone from a staircase mine, oak logs, sand), then the
   *  furnace (stone for stone bricks, glass), then the crafting table (planks, sticks, stairs, slabs, fences, doors,
   *  chests, panes, lanterns). What it can't get by itself (iron, coal) comes back in `missing`, in words. */
  private async supply(need: Map<number, number>, kind: Kind, first: boolean): Promise<{ any: boolean; missing: string[] }> {
    const b = this.body;
    const missing: string[] = [];
    // (the oak logs the posts take aren't there for planks)
    const count = (id: number) => (id === LOGS ? Math.max(0, b.count(B.OAK_LOG) - (need.get(B.OAK_LOG) ?? 0)) + b.count(B.PALM_LOG) : id === FUEL ? b.count(I.COAL) + b.count(I.CHARCOAL) : b.count(id));
    const demand = new Map(need);
    // a water bucket: an empty bucket filled at the nearest water
    if (demand.has(I.WATER_BUCKET)) {
      demand.delete(I.WATER_BUCKET);
      if (!b.has(I.BUCKET)) demand.set(I.BUCKET, 1);
    }
    const crafts: [number, number][] = [];
    const smelts: [number, number][] = [];
    const add = (id: number, n: number) => demand.set(id, (demand.get(id) ?? 0) + n);
    for (const id of ORDER) {
      const d = demand.get(id) ?? 0;
      const short = d - count(id);
      if (short <= 0) continue;
      const m = MAKE.get(id)!;
      if ("from" in m) {
        smelts.push([id, short]);
        add(m.from, short);
      } else {
        const n = Math.ceil(short / m.out);
        crafts.push([id, n]);
        for (const [ing, k] of m.ings) add(ing, k * n);
      }
    }
    if (smelts.length && !b.has(B.FURNACE) && !b.findBlocks([0, 1, 2, 3, 4, 5, 6, 7].map((k) => B.FURNACE + k), 20, 1).length) {
      crafts.push([B.FURNACE, 1]);
      add(B.COBBLESTONE, 8);
    }
    let any = false;
    // the raw stuff, a batch at a time
    const pick = () => { const t = b.bestToolFor(B.STONE); return !!t && canHarvest(B.STONE, t); };
    for (const id of RAW) {
      const short = (demand.get(id) ?? 0) - count(id);
      if (short <= 0 || b.abort || b.dead) continue;
      const before = count(id);
      if (id === B.COBBLESTONE) {
        // the pickaxe broke mid-job (sonnet, 47 blocks short of the town hall): make another from what it carries
        for (const rid of ["oak_planks", "oak_planks_from_palm", "birch_planks", "sticks", "crafting_table", "stone_pickaxe", "wooden_pickaxe"]) {
          if (pick() || b.abort) break;
          if (rid === "crafting_table" && (b.has(B.CRAFTING_TABLE) || b.findBlocks([B.CRAFTING_TABLE], 20, 1).length)) continue;
          await b.craft(rid, 1);
        }
        b.action = `getting stone for ${nameOf(kind)}`;
        if (pick()) await this.collect("cobblestone", Math.min(64, short + 4));
        else missing.push("a pickaxe for the stone");
      } else if (id === LOGS || id === B.OAK_LOG) {
        b.action = `getting oak for ${nameOf(kind)}`;
        await this.collect("town_log", Math.min(24, short + 2));
        if (count(id) <= before) missing.push("oak logs (no oak trees near: the town is built of oak)");
      } else if (id === B.BIRCH_LOG) {
        b.action = `getting birch for ${nameOf(kind)}`;
        await this.collect("birch_log", Math.min(24, short + 2));
        if (count(id) <= before) missing.push("birch logs (no birch trees near: the birch district is built of birch)");
      } else if (id === B.DIRT) {
        await this.collect("dirt", Math.min(32, short + 2));
      } else if (id === B.OAK_SAPLING || id === B.BIRCH_SAPLING) {
        b.action = `gathering saplings for ${nameOf(kind)}`;
        await this.collect(id === B.OAK_SAPLING ? "oak_sapling" : "birch_sapling", Math.min(9, short));
        if (count(id) <= before) missing.push(`${key(id)}s (one leaf in twenty drops one: break the leaves of a ${id === B.OAK_SAPLING ? "oak" : "birch"} tree)`);
      } else if (FLOWER_IDS.has(id)) {
        b.action = `picking ${key(id)}s for ${nameOf(kind)}`;
        await this.collect(key(id), Math.min(16, short));
        if (count(id) <= before) missing.push(`${key(id)}s (they grow on the grass)`);
      } else if (id === B.SAND && first) {
        b.action = `getting sand for glass`;
        await this.collect("sand", Math.min(24, short));
      } else if (id === I.RAW_IRON) missing.push(`${short} iron (mine iron_ore with a stone pickaxe, it gets smelted)`);
      else if (id === FUEL) {
        // charcoal from a log when there's no coal: one log for four torches
        if (b.count(B.OAK_LOG) > 0 && (b.has(B.FURNACE) || b.findBlocks([0, 1, 2, 3, 4, 5, 6, 7].map((k) => B.FURNACE + k), 20, 1).length)) await b.smelt(B.OAK_LOG, short);
        if (count(FUEL) <= before) missing.push("coal for torches (coal_ore)");
      }
      if (count(id) > before) any = true;
    }
    // the furnace: a batch of up to 16 at a time (10 seconds each)
    for (const [id, n] of smelts) {
      if (b.abort || b.dead) break;
      const from = (MAKE.get(id) as { from: number }).from;
      if (!b.has(from)) continue;
      if (crafts.some(([c]) => c === B.FURNACE) && !b.has(B.FURNACE)) await b.craft("furnace", 1);
      b.action = `smelting for ${nameOf(kind)}`;
      const before = b.count(id);
      await b.smelt(from, Math.min(16, n, b.count(from)));
      if (b.count(id) > before) any = true;
    }
    // and the crafting, what goes into the rest first; a crafting table to hand before anything that needs one
    crafts.reverse();
    const bench = crafts.findIndex(([c]) => c === B.CRAFTING_TABLE);
    if (bench < 0 && crafts.some(([c]) => c !== B.OAK_PLANKS && c !== I.STICK && c !== B.STONE_BRICKS && c !== B.CRAFTING_TABLE) && !b.has(B.CRAFTING_TABLE) && !b.findBlocks([B.CRAFTING_TABLE], 20, 1).length) {
      if (b.count(B.OAK_PLANKS) < 4 && count(LOGS) > 0) await b.craft(b.count(B.OAK_LOG) ? "oak_planks" : "oak_planks_from_palm", 1);
      await b.craft("crafting_table", 1);
    }
    for (const [id, n] of crafts) {
      if (b.abort || b.dead) continue;
      if (id === B.OAK_PLANKS) {
        // palm first, then the oak the posts don't need
        const palm = Math.min(n, b.count(B.PALM_LOG));
        if (palm && (await b.craft("oak_planks_from_palm", palm)).made) any = true;
        const oak = Math.min(n - palm, Math.max(0, b.count(B.OAK_LOG) - (need.get(B.OAK_LOG) ?? 0)));
        if (oak && (await b.craft("oak_planks", oak)).made) any = true;
        continue;
      }
      // (a furnace for the smelting was made and put down already; this is one the plan itself wants)
      const k = id === B.FURNACE ? (need.get(B.FURNACE) ?? 0) - b.count(B.FURNACE) : n;
      if (k <= 0) continue;
      const r = await b.craft((MAKE.get(id) as { rid: string }).rid, Math.min(k, 64));
      if (r.made) any = true;
    }
    if (need.has(I.WATER_BUCKET) && b.has(I.BUCKET) && !b.has(I.WATER_BUCKET) && (await b.fillBucket())) any = true;
    if ((need.get(B.LANTERN) ?? 0) > b.count(B.LANTERN) && !missing.length) missing.push("lanterns (2 iron_ingot, 2 glass_pane and a torch make 2)");
    return { any, missing };
  }

  /** The next concrete thing worth doing for the town, in a few words (it is never "nothing"). */
  private nextWork(): string {
    const pr = progress(civCount);
    if (pr.next) {
      const n = pr.next.needs.find((x) => x.have < x.need[1]);
      if (n) {
        const [k, , t] = n.need;
        if (k === "trade") return `the next stage needs trades with villagers (trade)`;
        if (k === "house" && t === 0) return "the camp needs a shelter: build_house (a cottage, build house, takes longer)";
        if (k === "farm" && (t ?? 1) <= 1) return `the next stage needs ${needText(n.need, n.have)}: farm`;
        if ((t ?? 1) > 1) return `the next stage needs ${needText(n.need, n.have)}: upgrade ${k}`;
        return `the next stage needs ${needText(n.need, n.have)}: build ${k}`;
      }
    }
    const up = this.upgrades()[0];
    return up ? `upgrade ${up.kind} (${up.text})` : "build more houses and lamp posts: a capital keeps growing";
  }

  /** Buildings that can go up a tier, the lowest first: [kind, where, from, what the next tier adds]. */
  private upgrades(): { kind: Kind; text: string }[] {
    const out: { kind: Kind; text: string; t: number }[] = [];
    const seen = new Set<Kind>();
    const list = PACK.builds.filter((x) => x.done && !isHome(x) && x.kind !== "lamp" && tierOf(x) >= 1 && tierOf(x) < topOf(x)).sort((p, q) => tierOf(p) - tierOf(q));
    for (const x of list) {
      if (seen.has(x.kind)) continue;
      seen.add(x.kind);
      const t = tierOf(x);
      out.push({ kind: x.kind, t, text: `${designName(x)} at x=${Math.round((x.x0 + x.x1) / 2)} z=${Math.round((x.z0 + x.z1) / 2)}, tier ${t} to ${t + 1}: ${upOf(x, t + 1)}` });
    }
    return out.sort((p, q) => p.t - q.t);
  }

  /** Where the pack's civilization stands, what it has built, what the next stage needs, and always something to do. */
  private civText(): string {
    const pr = progress(civCount);
    const kinds: Kind[] = [...BUILD_KINDS.filter((k) => k !== "road"), "farm"];
    const built = kinds.map((k) => {
      const n = civCount(k, 1);
      if (!n) return "";
      const t2 = civCount(k, 2);
      const t3 = maxTier(k) >= 3 ? civCount(k, 3) : 0;
      return `${n === 1 ? civLabel(k) : `${n} ${civLabel(k, 2)}`}${t2 ? ` (${t2} at tier 2${t3 ? `, ${t3} at tier 3` : ""})` : ""}`;
    }).filter(Boolean);
    const road = PACK.builds.find((x) => x.kind === "road");
    if (road) built.push(`roads joining ${civCount("road", 1)} building${civCount("road", 1) === 1 ? "" : "s"}`);
    let t = `Your civilization: ${pr.name}${pr.stage >= 0 ? ` (stage ${pr.stage + 1} of ${STAGES.length})` : ""}. Built so far: ${built.length ? built.join(", ") : "nothing"}${PACK.trades ? `, ${PACK.trades} trades with villagers` : ""}.`;
    if (pr.next) {
      const want = pr.next.needs.filter((n) => n.have < n.need[1]).map((n) => needText(n.need, n.have));
      t += ` Next, ${pr.next.name}, still needs: ${want.join(", ")}.`;
    } else t += " You have built a capital: keep it growing (every building to its top tier, more houses, roads and lamps).";
    const at = (x: Rect) => `x=${Math.round((x.x0 + x.x1) / 2)} z=${Math.round((x.z0 + x.z1) / 2)}`;
    const open = PACK.builds.filter((x) => !x.done).map((x) => `${nameOf(x.kind)} at ${at(x)} (started by ${x.by.join(" and ") || "someone"})`);
    if (open.length) t += ` Half built, anyone can carry on with build: ${open.join("; ")}.`;
    const ups = PACK.builds.filter((x) => x.done && x.up).map((x) => `${nameOf(x.kind)} at ${at(x)} to tier ${x.up}`);
    if (ups.length) t += ` Upgrades under way (upgrade that kind to carry on): ${ups.join("; ")}.`;
    const fix = PACK.builds.filter((x) => x.done && x.fix && tierOf(x) >= 0 && !isHome(x)).map((x) => `${nameOf(x.kind)} at ${at(x)}`);
    if (fix.length) t += ` Needs fixing (blocks missing): ${fix.join("; ")}: build that kind to fix it.`;
    const old = PACK.builds.filter((x) => x.done && !isHome(x) && tierOf(x) < 1 && x.tier !== undefined).map((x) => `${nameOf(x.kind)} at ${at(x)}`);
    if (old.length) t += ` Old buildings that don't meet the town's designs (they don't count until rebuilt: build that kind and it is rebuilt in place): ${old.join("; ")}.`;
    const up = this.upgrades();
    if (up.length) t += ` Upgrades you can do (upgrade <kind>): ${up.slice(0, 4).map((u) => u.text).join("; ")}.`;
    t += ` Something to do right now: ${this.nextWork()}. There is always work for the town: never wait around in daylight.`;
    const b = this.body;
    const w = b.world;
    if (w) {
      const vs = w.villages.map((k) => VILLAGE_SITES[k]).filter(Boolean).map((v) => ({ v, d: Math.hypot(v.x - b.phys.x, v.z - b.phys.z) })).sort((a, c) => a.d - c.d);
      if (vs.length) t += `\nVillages: ${vs.map(({ v, d }) => `${v.name} ${Math.round(d)} blocks ${dirWord(v.x - b.phys.x, v.z - b.phys.z)} (x=${v.x} z=${v.z})`).join("; ")}.`;
      const gold = w.info.islands.chests.map((c) => ({ c, d: Math.hypot(c.x - b.phys.x, c.z - b.phys.z) })).sort((a, c) => a.d - c.d)[0];
      if (gold) t += ` The nearest island treasure chest: x=${gold.c.x} z=${gold.c.z}, ${Math.round(gold.d)} blocks ${dirWord(gold.c.x - b.phys.x, gold.c.z - b.phys.z)}, across the water.`;
    }
    return t;
  }

  /** Each building near it measured against the plans, once a minute: its tier is what actually stands (an old
   *  building that doesn't meet the tier 1 design is tier 0 and doesn't count until it's rebuilt; one that has lost
   *  blocks drops and is marked for fixing), and the roads count the buildings they join. */
  private auditTown(): void {
    if (Date.now() - lastAudit < 60000 || !PACK.base) return;
    lastAudit = Date.now();
    const b = this.body;
    const changed: string[] = [];
    for (const site of PACK.builds) {
      if (!site.done || isHome(site)) continue;
      if (site.busy && Date.now() - site.busy.at < 45000) continue; // someone is on it right now
      // only what it can see from here: a chunk it hasn't loaded reads as air
      const reach = site.kind === "road" || site.kind === "wall" ? 24 : 40;
      if (Math.hypot((site.x0 + site.x1) / 2 - b.phys.x, (site.z0 + site.z1) / 2 - b.phys.z) > reach) continue;
      if (site.kind === "road") {
        const [j1, j2] = this.roadCount(site);
        site.joined = [j1, j2];
        site.tier = this.measure(site);
        continue;
      }
      const was = site.tier;
      const t = this.measure(site);
      site.tier = t;
      if (was === undefined) site.best = t; // an old record: what stands is its best, nothing to fix back to
      site.best = Math.max(site.best ?? 0, t);
      const fix = t < (site.best ?? 0);
      if (fix && !site.fix) changed.push(`${nameOf(site.kind)} at x=${Math.round((site.x0 + site.x1) / 2)} z=${Math.round((site.z0 + site.z1) / 2)} needs fixing: it's down to tier ${t}`);
      else if (was !== undefined && t !== was) changed.push(`${nameOf(site.kind)} at x=${Math.round((site.x0 + site.x1) / 2)} z=${Math.round((site.z0 + site.z1) / 2)} is tier ${t}`);
      else if (was === undefined && t === 0) changed.push(`${nameOf(site.kind)} at x=${Math.round((site.x0 + site.x1) / 2)} z=${Math.round((site.z0 + site.z1) / 2)} is an old design: rebuild it`);
      site.fix = fix;
    }
    if (changed.length) this.civUpdate(changed.slice(0, 3).join("; "));
  }

  /** Something got built: save the pack, tell the site, and mark a new stage (or a stage lost: the stage is what the
   *  town actually is). */
  private civUpdate(what: string): void {
    const pr = progress(civCount);
    const up = pr.stage > PACK.stage;
    PACK.stage = pr.stage;
    savePack();
    this.emitCiv(what);
    if (up) this.emit("plan", { text: `the pack is now ${pr.name}` });
  }

  emitCiv(what = ""): void {
    const pr = progress(civCount);
    const kinds: Kind[] = [...BUILD_KINDS, "farm"];
    const bd = PACK.board;
    this.emit("civ", {
      text: what,
      stage: pr.stage,
      name: pr.name,
      stages: STAGES.map((st) => st.name),
      // (k, have, need as before; tier and label for the needs that ask for a tier)
      next: pr.next ? { name: pr.next.name, needs: pr.next.needs.map((n) => ({ k: n.need[0], have: n.have, need: n.need[1], tier: n.need[2] ?? 1, label: needText(n.need) })) } : null,
      built: Object.fromEntries(kinds.map((k) => [k, civCount(k, 1)])),
      tiers: Object.fromEntries(kinds.map((k) => [k, [1, 2, 3].map((t) => civCount(k, t))])),
      trades: PACK.trades,
      open: PACK.builds.filter((x) => !x.done || x.fix || x.up).map((x) => ({ kind: x.kind, by: x.by, fix: !!x.fix, tier: tierOf(x), up: x.up ?? null })),
      buildings: PACK.builds.filter((x) => x.kind !== "road").map((x) => ({ kind: x.kind, x: Math.round((x.x0 + x.x1) / 2), z: Math.round((x.z0 + x.z1) / 2), tier: tierOf(x), done: x.done })),
      // (added for the planner: the town board, the plan's centre and the pool; the site reads what it knows)
      board: bd ? { day: bd.day, roles: bd.roles, project: bd.project ? { kind: bd.project.kind, up: bd.project.up, label: nameOf(bd.project.kind) } : null, short: bd.short } : null,
      centre: PACK.centre ?? null,
      stock: Object.fromEntries([...stock()].filter(([, n]) => n > 0).map(([id, n]) => [key(id), n])),
      // (added for the catalog: the job queue's top and how long it is, the catalog's size, the districts' styles)
      queue: (bd?.queue ?? []).slice(0, 12).map((j) => ({ text: j.text, kind: j.kind, k: j.k, role: j.role, by: j.by ?? null })),
      jobs: bd?.queue?.length ?? 0,
      catalog: catalogSize(),
      styles: PACK.styles ?? null,
    });
  }

  private async digDown(n: number): Promise<string> {
    const b = this.body;
    let dug = 0;
    for (let k = 0; k < n && !b.abort && !b.dead; k++) {
      const x = Math.floor(b.phys.x);
      const z = Math.floor(b.phys.z);
      const y = Math.floor(b.phys.y + 0.1) - 1;
      const id = b.get(x, y, z);
      if (id === B.WATER || id === B.BEDROCK) break;
      if (b.get(x, y - 1, z) === B.AIR && b.get(x, y - 2, z) === B.AIR) return `stopped after ${dug}: there is a drop below (a cave)`;
      if (!(await b.mine(x, y, z, false))) break;
      dug++;
      await b.dropInto(x, y, z);
    }
    await b.pickUp(3, 3000);
    return `dug down ${dug} blocks, now at y=${Math.floor(b.phys.y)}, standing on ${BLOCKS[b.get(Math.floor(b.phys.x), Math.floor(b.phys.y + 0.1) - 1, Math.floor(b.phys.z))]?.key ?? "?"}`;
  }

  private findTarget(name: string): Target | null {
    const b = this.body;
    const n = name.toLowerCase().trim();
    const p = [...b.others.values()].find((o) => o.name === n && !(o.flags & FLAG.DEAD));
    if (p) return { kind: "player", id: p.id };
    let best: Target | null = null;
    let bd = 32;
    for (const m of b.mobs.values()) {
      if (MOB_SPECS[m.kind]?.key !== n || m.flags & MF.DEAD) continue;
      const d = b.distTo(m.x, m.y, m.z);
      if (d < bd) [bd, best] = [d, { kind: "mob", id: m.id }];
    }
    for (const a of b.animals.values()) {
      if (ANIMAL_SPECS[a.kind]?.key !== n || (this.unreachable.get(a.id) ?? 0) > Date.now()) continue;
      const d = b.distTo(a.x, a.y, a.z);
      if (d < bd) [bd, best] = [d, { kind: "animal", id: a.id }];
    }
    return best;
  }

  private async attack(name: string): Promise<string> {
    const b = this.body;
    const t = this.findTarget(name);
    if (!t) return `no ${name} nearby`;
    // one too far off to fight from here: walk over to it first (the fight gives up on anything past 24 blocks with
    // "it got away" before taking a step: haiku asked for a sheep 24 blocks off seven times in 16 seconds)
    const p = b.targetPos(t);
    if (p && Math.hypot(p.x - b.phys.x, p.z - b.phys.z) > 16) {
      b.action = `walking over to the ${name}`;
      await b.goto(p.x, p.y, p.z, 6, { maxMs: 30000, done: () => { const q = b.targetPos(t); return !q || Math.hypot(q.x - b.phys.x, q.z - b.phys.z) < 10; } });
    }
    const res = await b.fight(t, 30000);
    // one it couldn't get to is left be for two minutes, so the next attack picks another (haiku asked for the same
    // cow and chicken across the water four times running: "couldn't get to it")
    if (t.kind === "animal" && /couldn't get to it|got away|out of reach/.test(res)) this.unreachable.set(t.id, Date.now() + 120000);
    await this.body.pickUp(5, 4000);
    return `${name}: ${res}`;
  }

  private async give(player: string, item: string, count: number): Promise<string> {
    const b = this.body;
    const id = itemByName(item);
    if (!id || !b.has(id)) return `you don't have ${item}`;
    const o = [...b.others.values()].find((p) => p.name === player.toLowerCase());
    if (!o) return `${player} isn't in the world`;
    const why = this.cantReach(o);
    if (why) return `${why}: give it once ${o.name} is back up (or put it in the storehouse), rather than walk there`;
    await b.goto(o.x, o.y, o.z, 2.5, { maxMs: 45000, done: () => { const q = b.others.get(o.id); return !!q && Math.hypot(q.x - b.phys.x, q.z - b.phys.z) < 3; } });
    const q = b.others.get(o.id);
    if (!q || Math.hypot(q.x - b.phys.x, q.z - b.phys.z) > 4) {
      this.outOfReach.set(o.name, { until: Date.now() + 180000, why: `${o.name} couldn't be reached a moment ago` });
      return `couldn't get to ${player}`;
    }
    await b.lookAt(q.x, q.y + 1.2, q.z, 12);
    if (!(await b.hold(id))) return `couldn't take ${item} in hand`;
    let thrown = 0;
    while (thrown < count && b.heldId() === id) {
      b.send({ t: "drop", all: false });
      thrown++;
      await b.wait(2);
    }
    return `threw ${thrown} ${item} to ${player}`;
  }

  // ---------------------------------------------------------------- the day plan and the town board

  /** What the town builds next: a building half built, needing fixing or part upgraded first; then the next stage's
   *  needs in order (what a builder does: not the fields, the trades, the shelters); then, with the stage done or only
   *  those left, the streets and lamp posts it is short of, the lowest upgrade, more houses. */
  private nextProject(): { kind: Kind; up: boolean } | null {
    const open = PACK.builds.find((x) => !isHome(x) && x.kind !== "road" && x.kind !== "farm" && x.kind !== "lamp" && (!x.done || x.fix || x.up));
    if (open) return { kind: open.kind, up: !!open.up && open.done && !open.fix };
    const pr = progress(civCount);
    const later: { kind: Kind; up: boolean }[] = [];
    // (a kind that found no spot a short while ago waits: the board takes the next need meanwhile)
    const skipped = (k: string) => (PACK.board?.skip?.[k] ?? 0) > Date.now() - 600000;
    for (const n of pr.next?.needs ?? []) {
      if (n.have >= n.need[1]) continue;
      const [k, cnt, t] = n.need;
      if (k === "trade" || k === "farm" || (k === "house" && t === 0) || skipped(k)) continue;
      const kind = k as Kind;
      const up = (t ?? 1) > 1 && civCount(kind, 1) >= cnt;
      if (kind === "road" || kind === "lamp") later.push({ kind, up });
      else return { kind, up };
    }
    if (later.length) return later[0];
    // the camp's shelter: a cottage counts for it (and for the homestead after it)
    if ((pr.next?.needs ?? []).some((n) => n.have < n.need[1] && n.need[0] === "house")) return { kind: "house", up: false };
    const up = this.upgrades()[0];
    if (up) return { kind: up.kind, up: true };
    return pr.next ? null : { kind: "house", up: false };
  }

  /** What the project still needs, item by item: its plan's missing cells, or (not started) the whole of its tier. */
  private projectBill(p: { kind: Kind; up: boolean }): Map<number, number> {
    const site = PACK.builds.find((x) => x.kind === p.kind && !isHome(x) && (p.up ? x.done && (x.up || tierOf(x) < topOf(x)) : !x.done || x.fix));
    const b = this.body;
    if (site && PACK.base && Math.hypot((site.x0 + site.x1) / 2 - b.phys.x, (site.z0 + site.z1) / 2 - b.phys.z) < 80) {
      const tier = p.up ? site.up ?? tierOf(site) + 1 : Math.max(1, site.best ?? 1);
      const need = new Map<number, number>();
      for (const c of this.planOf(site, tier).cells) {
        const t = cellTarget(c[3]);
        if (!t || t.optional || !b.needsWork(c)) continue;
        need.set(itemOf(t.id), (need.get(itemOf(t.id)) ?? 0) + 1);
      }
      return need;
    }
    if (p.kind === "road" || p.kind === "farm") return new Map();
    const tier = p.up ? Math.min(maxTier(p.kind), (PACK.builds.filter((x) => x.kind === p.kind && x.done).map(tierOf).sort((a, c) => a - c)[0] ?? 0) + 1) : 1;
    return materialsFor(p.kind as Plain | "wall", tier, p.up ? tier - 1 : 0);
  }

  /** The board, brought up to date: a new day, a new project, someone gone or a new hand, or ten minutes on: the roles
   *  are given out again (by what the project is short of after the storehouse, and who is best placed for what), and
   *  the one that worked it out posts the day's board in a line. */
  private updateBoard(): void {
    if (!PACK.base) return;
    const now = Date.now();
    const bd: TownBoard = PACK.board ?? { day: -1, at: 0, roles: {}, project: null, short: {} };
    PACK.board = bd;
    this.refreshQueue();
    const project = this.nextProject();
    const alive = [...BOARD.entries()].filter(([n, e]) => n === this.name || ((e.at ?? 0) > now - 30000 && [...this.body.others.values()].some((o) => o.name === n && !(o.flags & FLAG.DEAD)))).map(([n]) => n);
    if (!alive.includes(this.name)) alive.push(this.name);
    const same = (p: TownBoard["project"], q: TownBoard["project"]) => (!p && !q) || (!!p && !!q && p.kind === q.kind && p.up === q.up);
    const fresh = bd.day === this.day && same(bd.project, project) && now - bd.at < 600000 && alive.every((n) => bd.roles[n]) && Object.keys(bd.roles).every((n) => alive.includes(n));
    if (fresh) return;
    // what the project is short of, in raw materials, after what the storehouse holds and the builder carries
    const bill = project ? this.projectBill(project) : new Map<number, number>();
    const raw = rawOf(bill);
    const have = stock();
    const builderWas = Object.entries(bd.roles).find(([, r]) => r === "builder")?.[0];
    if (builderWas === this.name) for (const st of this.body.inv) if (st) have.set(st.id, (have.get(st.id) ?? 0) + st.n);
    const short = new Map<Raw, number>();
    for (const [k, n] of raw) {
      const left = n - rawIn(have, k);
      if (left > 0) short.set(k, left);
    }
    // food: the pack's (each one's bag and the storehouse) against three mouths, and the next stage's fields
    const food = [...BOARD.values()].reduce((n, e) => n + (e.food ?? 0), 0) + rawIn(have, "food");
    const pr = progress(civCount);
    const fieldsWanted = (pr.next?.needs ?? []).some((n) => n.need[0] === "farm" && n.have < n.need[1]);
    const site = project && PACK.builds.find((x) => x.kind === project.kind && !isHome(x) && (!x.done || x.fix || x.up));
    const hands = alive.map((n) => {
      const e = BOARD.get(n);
      const far = site && e?.x !== undefined ? Math.hypot((site.x0 + site.x1) / 2 - e.x, (site.z0 + site.z1) / 2 - (e.z ?? 0)) : 50;
      return { name: n, pick: e?.pick ?? 0, axe: !!e?.axe, farm: !!e?.farm, far, onSite: !!site?.busy && site.busy.by === n && now - site.busy.at < 45000, was: bd.roles[n] };
    });
    const before = JSON.stringify(bd.roles);
    bd.roles = assignRoles(hands, short, food < 10 * alive.length || fieldsWanted);
    bd.project = project;
    bd.short = Object.fromEntries(short);
    bd.day = this.day;
    bd.at = now;
    savePack();
    this.emitCiv();
    if (JSON.stringify(bd.roles) !== before && alive.length > 1) {
      const what = project ? `${project.up ? "upgrading " : ""}${nameOf(project.kind)}` : "the town";
      const list = Object.entries(bd.roles).map(([n, r]) => (r === "builder" ? `${n} builds ${what}` : r === "mason" ? `${n} gets stone` : r === "woodcutter" ? `${n} gets wood` : `${n} farms`));
      this.teamSay(`board for day ${this.day || 1}: ${list.join(", ")}.`);
    }
  }

  /** The schedule and the board, for the prompt. */
  private boardText(): string {
    const b = this.body;
    const slot = slotOf(b.timeOfDay());
    const bd = PACK.board;
    const lines = [`Your day: it is ${slot}: ${slotText(slot)}.`];
    if (!PACK.base || !bd) return lines.join(" ");
    const p = bd.project;
    const short = Object.entries(bd.short).filter(([, n]) => n && n > 0).map(([k, n]) => `${n} ${k === "wood" ? "oak logs" : k === "stone" ? "cobblestone" : k}`);
    lines.push(`The town board (day ${bd.day || 1}): ${Object.entries(bd.roles).map(([n, r]) => `${n === this.name ? "you" : n}: ${r}`).join(", ")}. The project: ${p ? `${p.up ? "upgrade" : "build"} ${nameOf(p.kind)}${p.up ? "" : ` (${districtOf(p.kind)})`}${short.length ? `, still short of ${short.join(", ")}` : ""}` : progress(civCount).next ? `nothing for the builder right now: ${this.nextWork()}` : "none: every stage is built, keep upgrading and growing"}.`);
    const s = this.storehouse();
    const st = this.stockText(8);
    lines.push(s ? `The storehouse (the pack's pool) holds ${st || "nothing yet"}: put what you gather for the town in it (storehouse put), take what you need (storehouse take).` : "There is no storehouse yet: whoever gathers brings the builder what it is short of (give); building the storehouse makes it the pack's pool.");
    const role = bd.roles[this.name];
    if (role) lines.push(`Your job: ${role} (${ROLES[role]}). Right now: ${this.jobNow(role, slot)}. work does it.`);
    const q = bd.queue ?? [];
    if (q.length) lines.push(`The job list (${q.length} jobs, the most urgent first): ${q.slice(0, 8).map((j, i) => `${i + 1}. ${j.text}${j.by ? ` [${j.by === this.name ? "you" : j.by}]` : ""}`).join("; ")}. work takes the next one for you when you finish yours.`);
    return lines.join("\n");
  }

  // ---------------------------------------------------------------- the job queue

  /** The job queue drawn up again (every three minutes, or as soon as a job is done): every job the town has from
   *  where it stands now (agents/board.ts), the claims carried over, and a lot picked for each of the first new
   *  buildings, so the list says where each goes and no two get the same lot. */
  private refreshQueue(): void {
    const bd = PACK.board;
    if (!bd || !PACK.base) return;
    const now = Date.now();
    if (bd.queue && now - (bd.qat ?? 0) < 180000) return;
    const old = new Map((bd.queue ?? []).map((j) => [j.id, j]));
    let jobs: Job[];
    try {
      jobs = planJobs(this.townState());
    } catch (e) {
      console.error(`[${this.name}] the job queue: ${(e as Error).message}`);
      return;
    }
    for (const j of jobs) {
      const o = old.get(j.id);
      if (o?.by && now - (o.since ?? 0) < CLAIM_MS) {
        j.by = o.by;
        j.since = o.since;
      }
      if (o?.lot) {
        j.lot = o.lot;
        j.design = o.design;
      }
    }
    const avoid: Rect[] = [];
    let n = 0;
    for (const j of jobs) {
      if (j.kind !== "build" || j.k === "wall" || j.k === "road" || n >= 5) continue;
      n++;
      if (j.lot && this.lotFree(j.lot)) {
        avoid.push(j.lot);
        j.text += ` (${j.design && DESIGNS[j.design] && j.design !== j.k ? `${DESIGNS[j.design].name}, ` : ""}${j.lot.where})`;
        continue;
      }
      j.lot = undefined;
      let spot: ReturnType<Brain["townSite"]>;
      try {
        spot = this.townSite(j.k as Exclude<Kind, "farm" | "road" | "wall">, avoid);
      } catch (e) {
        console.error(`[${this.name}] a lot for ${j.k}: ${(e as Error).message}`);
        continue;
      }
      if (typeof spot === "string") continue;
      j.lot = { x0: spot.x0, z0: spot.z0, x1: spot.x1, z1: spot.z1, y: spot.y, face: spot.face, where: spot.where ?? districtOf(j.k), design: spot.design };
      j.design = spot.design;
      j.text += ` (${spot.design && DESIGNS[spot.design] && spot.design !== j.k ? `${DESIGNS[spot.design].name}, ` : ""}${j.lot.where})`;
      avoid.push(spot);
    }
    bd.queue = jobs;
    bd.qat = now;
    // (saved straight away: the relay and the watcher read the queue from the civ event, the next run from the pack)
    savePack();
  }

  /** Where the town stands, for the queue: the stage and its needs, every building, the pool, the roads and lamps,
   *  the street furniture, the tree farm, the fields, the food, the catalog's kinds. */
  private townState(): TownState {
    const b = this.body;
    const pr = progress(civCount);
    const mid = (x: Rect): [number, number] => [Math.round((x.x0 + x.x1) / 2), Math.round((x.z0 + x.z1) / 2)];
    const st = stock();
    const raws: Raw[] = ["stone", "wood", "birch", "sand", "coal", "iron", "food"];
    const road = PACK.builds.find((x) => x.kind === "road");
    const rc = road ? this.roadCount(road) : [0, 0, PACK.builds.filter((x) => !!doorStep(x)).length];
    const streetCells = road ? this.planOf(road, 1).cells.length : 0;
    const count = (k: Kind) => PACK.builds.filter((x) => x.kind === k).length;
    let grown = 0;
    let farmAt: [number, number] | undefined;
    for (const f of PACK.builds.filter((x) => x.kind === "treefarm" && x.done)) {
      if (Math.hypot((f.x0 + f.x1) / 2 - b.phys.x, (f.z0 + f.z1) / 2 - b.phys.z) > 96) continue;
      let g = 0;
      for (const [x, y, z, k] of this.planOf(f, 1).cells) {
        const t = cellTarget(k.split("|")[0]);
        if (t && (t.id === B.OAK_SAPLING || t.id === B.BIRCH_SAPLING) && (b.get(x, y, z) === B.OAK_LOG || b.get(x, y, z) === B.BIRCH_LOG)) g++;
      }
      if (g > grown) {
        grown = g;
        farmAt = mid(f);
      }
    }
    const alive = Math.max(1, BOARD.size);
    const food = [...BOARD.values()].reduce((n, e) => n + (e.food ?? 0), 0) + rawIn(st, "food");
    const fieldsWanted = (pr.next?.needs ?? []).some((n) => n.need[0] === "farm" && n.have < n.need[1]);
    return {
      stage: pr.stage,
      needs: (pr.next?.needs ?? []).map((n) => ({ k: n.need[0], n: n.need[1], tier: n.need[2] ?? 1, have: n.have })),
      later: STAGES.slice(pr.stage + 2).flatMap((s) => s.needs.map(([k, n, t]) => ({ k, n, tier: t ?? 1 }))),
      buildings: PACK.builds.filter((x) => !isHome(x) && x.kind !== "road" && x.kind !== "farm" && x.kind !== "lamp").map((x) => ({ kind: x.kind, design: x.design, name: designName(x), at: mid(x), tier: tierOf(x), max: topOf(x), done: x.done, fix: !!x.fix, up: x.up, next: upOf(x, (x.up ?? tierOf(x)) + 1) || undefined })),
      short: PACK.board?.short ?? {},
      stock: Object.fromEntries(raws.map((r) => [r, rawIn(st, r)])),
      roads: { doors: rc[2] ?? 0, joined: rc[0] ?? 0, paved: rc[1] ?? 0 },
      lamps: { have: count("lamp"), want: Math.min(64, Math.floor(streetCells / 21)) },
      furniture: { bench: count("bench"), flowerbed: count("flowerbed"), want: Math.min(24, Math.floor(streetCells / 60)) },
      trees: { farms: count("treefarm"), grown, at: farmAt },
      fields: PACK.builds.filter((x) => x.kind === "farm" && x.done && tierOf(x) < 2).map((x) => ({ at: mid(x) })),
      food: { have: food, want: 10 * alive, fields: fieldsWanted },
      kinds: Object.entries(KIND_INFO).filter(([k]) => !["house", "lamp", "plaza", "wall", "road", "farm"].includes(k) && KINDS[k]).map(([k, i]) => ({ k, one: i.one, from: i.from, most: ONCE.has(k) ? 1 : i.most, have: count(k), small: DESIGNS[KINDS[k].designs[0] ?? k]?.scale === "small", district: districtOf(k) })),
      smelt: (rawIn(st, "stone") >= 16 || rawIn(st, "sand") >= 8) && PACK.builds.some((x) => x.done && tierOf(x) === 1 && topOf(x) >= 2 && x.kind !== "lamp"),
      birch: this.townStyles().some((s) => s === "birch" || s === "timber"),
    };
  }

  /** Jobs it gave up on a short while ago (no spot, nothing to be had): left to someone else for ten minutes. */
  private skipJobs = new Map<string, number>();

  /** Its next job from the queue (the one it holds, else the most urgent open one, its own role's first), claimed. */
  private takeJob(role: Role): Job | null {
    const bd = PACK.board;
    if (!bd?.queue?.length) return null;
    const now = Date.now();
    const j = pickJob(bd.queue, role, this.name, now, (x) => (this.skipJobs.get(x.id) ?? 0) < now);
    if (!j) return null;
    for (const o of bd.queue)
      if (o !== j && o.by === this.name) {
        o.by = undefined;
        o.since = undefined;
      }
    j.by = this.name;
    j.since = now;
    savePack();
    this.emitCiv();
    return j;
  }

  /** One step of a job: building, upgrading, fixing and planting through build; the streets, lamp posts and street
   *  furniture; cutting the tree farm; stocking the storehouse; farming; smelting. A job that is done comes off the
   *  queue (it is drawn up again); one that can't go on is left to the others for a while. */
  private async runJob(job: Job, role: Role, slot: Slot): Promise<string> {
    let r: string;
    switch (job.kind) {
      case "build":
      case "finish":
      case "repair":
      case "plant":
      case "decorate":
        r = await this.buildTown(job.k as Kind, false, job);
        break;
      case "upgrade":
      case "furnish":
        r = await this.buildTown(job.k as Kind, true, job);
        break;
      case "fence":
        r = await this.buildTown("farm", true, job);
        break;
      case "streets":
        r = await this.buildTown("road");
        break;
      case "pave":
        r = await this.buildTown("road", true);
        break;
      case "light":
        r = await this.buildTown("lamp");
        break;
      case "harvest":
        r = await this.harvestTreeFarm(job);
        break;
      case "stock":
        r = await this.stockJob(job);
        break;
      case "farm":
        r = await this.farmJob();
        break;
      case "smelt":
        r = (await this.smeltForTown()) || "nothing to smelt for the upgrades right now";
        break;
      default:
        r = role === "builder" ? await this.buildJob() : await this.masonJob(slot);
    }
    const bd = PACK.board;
    if (!bd?.queue) return r;
    const building = ["build", "finish", "repair", "plant", "upgrade", "furnish", "fence", "decorate"].includes(job.kind);
    const failed = /^(couldn't|no flat open spot|no open spot|no spot|gave up on|there is no|every |the town already|.* is already built|you're \d+ blocks|someone else|\w+ is working on|the .* there are aren't|farms are made|nothing has grown|nothing to smelt|no paths to make)/.test(r);
    const done = !failed && (!building || /^(finished|upgraded)/.test(r));
    if (failed) {
      this.skipJobs.set(job.id, Date.now() + 10 * 60000);
      job.by = undefined;
      job.since = undefined;
    } else if (done) {
      bd.queue = bd.queue.filter((x) => x !== job);
      bd.qat = 0;
    } else job.since = Date.now();
    savePack();
    return r;
  }

  /** A stock job: the raw material gathered (a staircase mine for stone, coal and iron; a logging trip for oak or
   *  birch; sand by the water) and put in the storehouse. */
  private async stockJob(job: Job): Promise<string> {
    const raw = job.k as Raw;
    if (raw === "food") return await this.farmJob();
    const what = raw === "stone" ? "cobblestone" : raw === "wood" ? "town_log" : raw === "birch" ? "birch_log" : raw === "sand" ? "sand" : raw === "coal" ? "coal_ore" : raw === "iron" ? "iron_ore" : "";
    if (!what) return "nothing to stock";
    this.body.action = job.text;
    const got = await this.collect(what, Math.max(8, Math.min(32, job.n ?? 24)));
    if (this.body.dead || this.body.abort) return got;
    return [got, await this.deliver()].filter(Boolean).join("; ");
  }

  /** The tree farm's grown trees cut down (every log and leaf over the field and hanging out over its fence, the way a
   *  lot is cleared), the saplings picked up and planted again in their places, the logs into the storehouse. */
  private async harvestTreeFarm(job: Job): Promise<string> {
    const b = this.body;
    const mid = (x: Rect) => [Math.round((x.x0 + x.x1) / 2), Math.round((x.z0 + x.z1) / 2)];
    const farm = PACK.builds.find((x) => x.kind === "treefarm" && !!job.at && mid(x)[0] === job.at[0] && mid(x)[1] === job.at[1]) ?? PACK.builds.find((x) => x.kind === "treefarm" && x.done);
    if (!farm) return "there is no tree farm yet: build treefarm";
    const [mx, mz] = mid(farm);
    if (Math.hypot(mx + 0.5 - b.phys.x, mz + 0.5 - b.phys.z) > 10) {
      b.action = "walking over to the tree farm";
      await b.goto(mx + 0.5, farm.y, mz + 0.5, 5, { maxMs: 90000, done: () => Math.hypot(mx + 0.5 - b.phys.x, mz + 0.5 - b.phys.z) < 8 });
    }
    const cells: PlanCell[] = [];
    for (let x = farm.x0 - 2; x <= farm.x1 + 2; x++) for (let z = farm.z0 - 2; z <= farm.z1 + 2; z++) for (let y = farm.y; y <= farm.y + 11; y++) if (TREE_IDS.has(b.get(x, y, z))) cells.push([x, y, z, "a"]);
    if (!cells.length) return "nothing has grown in the tree farm yet";
    await this.ensureAxe();
    const logs = () => b.count(B.OAK_LOG) + b.count(B.BIRCH_LOG);
    const before = logs();
    farm.busy = { by: this.name, at: Date.now() };
    b.action = "cutting the tree farm's trees";
    const r = await b.buildCells(cells, 400, "cutting the tree farm's trees", farm.y);
    farm.busy = undefined;
    await b.pickUp(9, 8000);
    const got = logs() - before;
    if (b.dead || b.abort) return `cut ${got} logs in the tree farm before stopping`;
    // the saplings back in their places: the tree farm's own plan, at its best tier
    const again = await this.buildTown("treefarm", false, { ...job, kind: "plant", at: [mx, mz] });
    const dl = this.storehouse() ? await this.toStore() : "";
    return `cut the tree farm's trees: ${got} logs${r.left ? ` (${r.left} blocks of them out of reach)` : ""}; ${again}${dl ? `; ${dl}` : ""}`;
  }

  /** A tree cut down whole from the log it found: every log of it, lowest first from the ground, then the ones out
   *  of reach from a pillar it builds up the trunk's own column (each step digs the log over its head, and it cuts
   *  whatever else is in reach), and back down its pillar, the blocks taken back; the logs picked up. Its stump (for
   *  a sapling) when it stood on the ground. Null when the log isn't a tree's (somebody's build). */
  private async fell(x: number, y: number, z: number, theirs: (x: number, z: number) => boolean): Promise<{ got: number; left: [number, number, number][]; stump: [number, number, number, boolean] | null } | null> {
    const b = this.body;
    const tree = treeOf((tx, ty, tz) => b.get(tx, ty, tz), x, y, z);
    if (!tree || tree.logs.some(([lx, , lz]) => theirs(lx, lz))) return null;
    const { logs, foot } = tree;
    const held = () => b.count(B.OAK_LOG) + b.count(B.BIRCH_LOG) + b.count(B.PALM_LOG);
    const had = held();
    const kind = b.get(...foot);
    const under = b.get(foot[0], foot[1] - 1, foot[2]);
    const stump: [number, number, number, boolean] | null = (under === B.GRASS || under === B.DIRT) && !theirs(foot[0], foot[2]) ? [foot[0], foot[1], foot[2], kind === B.BIRCH_LOG] : null;
    const left = () => logs.filter((c) => LOG_IDS.has(b.get(...c)));
    b.action = `cutting down a tree at x=${foot[0]} z=${foot[2]} (${logs.length} logs)`;
    // from the ground: the logs it can walk up to, lowest first
    for (const c of [...logs].sort((p, q) => p[1] - q[1])) {
      if (b.abort || b.dead) break;
      if (!LOG_IDS.has(b.get(...c))) continue;
      const far = b.reachTo(...c) > 4.3;
      if (far && c[1] > b.phys.y + 2) continue;
      await b.mine(c[0], c[1], c[2], far);
    }
    // the rest from a pillar up the trunk's own column, where its lowest log left was standing (the foot's column for
    // a straight trunk)
    const rest = left();
    if (rest.length && !b.abort && !b.dead) {
      const low = rest.reduce((a, c) => (c[1] < a[1] ? c : a));
      let [cx, cy, cz] = [low[0], low[1], low[2]];
      while (cy > foot[1] - 1 && !SOLID[b.get(cx, cy - 1, cz)]) cy--;
      b.action = `climbing up the trunk at x=${cx} z=${cz} for the logs out of reach`;
      await b.goto(cx + 0.5, cy, cz + 0.5, 0.35, { maxMs: 12000 });
      const there = Math.hypot(b.phys.x - cx - 0.5, b.phys.z - cz - 0.5) < 0.7;
      // a pillar wants blocks to stand on: planks from a log it just cut, when it carries nothing else
      if (there && !b.fillerBlock() && held() > 0) {
        const planks = b.count(B.BIRCH_LOG) ? "birch_planks" : b.count(B.OAK_LOG) ? "oak_planks" : "palm_planks";
        await b.craft(planks, 1);
      }
      if (there && b.fillerBlock()) {
        const pillar: [number, number, number][] = [];
        const top = Math.max(...logs.map((c) => c[1]));
        for (let k = 0; k < 14 && left().length && !b.abort && !b.dead; k++) {
          for (const c of left()) if (b.reachTo(...c) <= 4.3) await b.mine(c[0], c[1], c[2], false);
          if (!left().length) break;
          const px = Math.floor(b.phys.x);
          const py = Math.floor(b.phys.y + 0.1);
          const pz = Math.floor(b.phys.z);
          if (py > top || !b.fillerBlock()) break;
          if ((await b.pillarUp(1)) < 1) break;
          pillar.push([px, py, pz]);
        }
        // back down its own pillar, taking its blocks back
        for (let k = pillar.length - 1; k >= 0 && !b.dead; k--) {
          const [px, py, pz] = pillar[k];
          if (!SOLID[b.get(px, py, pz)] || !(await b.mine(px, py, pz, false))) break;
          await b.dropInto(px, py, pz);
        }
      }
    }
    await b.pickUp(6, 6000);
    return { got: held() - had, left: left(), stump };
  }

  /** Saplings back in where it cut trees down: the leaves hanging over each stump broken (one in twenty drops a
   *  sapling, and it tidies the canopy away), a sapling planted on the stump. How many went in. */
  private async replant(stumps: [number, number, number, boolean][]): Promise<number> {
    const b = this.body;
    let planted = 0;
    for (const [x, y, z, birch] of stumps.slice(0, 6)) {
      if (b.abort || b.dead || b.isNight()) break;
      const below = b.get(x, y - 1, z);
      if (b.get(x, y, z) !== B.AIR || (below !== B.GRASS && below !== B.DIRT) || SOLID[b.get(x, y + 1, z)]) continue;
      const sap = birch ? B.BIRCH_SAPLING : B.OAK_SAPLING;
      if (!b.has(sap)) {
        const leaves = b.findBlocks([B.OAK_LEAVES, B.BIRCH_LEAVES], 7, 40).filter(([lx, ly, lz]) => Math.abs(lx - x) <= 3 && Math.abs(lz - z) <= 3 && ly >= y && b.reachTo(lx, ly, lz) <= 4.3);
        for (const [lx, ly, lz] of leaves.slice(0, 16)) {
          if (b.abort || b.dead || b.has(sap)) break;
          await b.mine(lx, ly, lz, false);
        }
        await b.pickUp(5, 3000);
      }
      if (!b.has(sap)) continue;
      if (await b.place(sap, x, y, z, 8000)) planted++;
    }
    return planted;
  }

  /** Do its job on the board for this part of the day, one whole step of it. */
  private async work(): Promise<string> {
    const b = this.body;
    if (!PACK.base) return "the pack has no base yet: build_house first (the first house anyone builds becomes the base), then work";
    this.updateBoard();
    const slot = slotOf(b.timeOfDay());
    const role: Role = PACK.board?.roles[this.name] ?? "builder";
    b.action = this.jobNow(role, slot);
    if (slot === "night") return await this.nightRound();
    if (slot === "dusk") return await this.duskRound(role);
    const pre = slot === "dawn" ? await this.dawnRound() : "";
    if (b.dead || b.abort) return pre || "stopped";
    // the next job off the board's queue: its own role's first, then any open one
    const job = this.takeJob(role);
    if (job) b.action = job.text;
    // a long way from the town: back to it first (the jobs are all round the town; gathering goes out from there)
    const far = Math.hypot(PACK.base.x - b.phys.x, PACK.base.z - b.phys.z);
    if (far > 40 && (role === "builder" || (job && job.kind !== "stock" && job.kind !== "farm"))) {
      b.action = `heading back to the town: ${job ? job.text : "to build"}`;
      const base = PACK.base;
      await b.goto(base.x + 0.5, base.y, base.z + 0.5, 7, { maxMs: 90000, done: () => Math.hypot(base.x + 0.5 - b.phys.x, base.z + 0.5 - b.phys.z) <= 7 });
    }
    const r = job ? await this.runJob(job, role, slot) : role === "builder" ? await this.buildJob() : role === "mason" ? await this.masonJob(slot) : role === "woodcutter" ? await this.woodJob(slot) : await this.farmJob();
    return [pre, r].filter(Boolean).join("; ");
  }

  /** Night: to bed in its house when it's there or out in the open near it; under cover elsewhere it stays put (no
   *  walk home through the dark: wait shuts it in and mines from inside the sealed hole till dawn). */
  private async nightRound(): Promise<string> {
    const b = this.body;
    if (b.home && (b.atHome() || !b.covered())) {
      const [mx, mz] = b.homeMiddle();
      if (b.atHome() || Math.hypot(mx - b.phys.x, mz - b.phys.z) < 40) return await b.goHome();
    }
    return await this.exec("wait", { seconds: 30 });
  }

  /** Dawn: out of the house, fed, food from the pool when it carries little. */
  private async dawnRound(): Promise<string> {
    const b = this.body;
    const out: string[] = [];
    if (b.atHome()) await b.leaveHome();
    if (b.stats.food < 16 && b.inv.some((s) => s && itemDef(s.id)?.food && !itemDef(s.id)?.food?.queasy)) out.push(await b.eat());
    if (this.kit().food < 4 && this.storehouse()) {
      const have = stock();
      const want = new Map<number, number>();
      let n = 8;
      for (const id of [I.BREAD, I.COOKED_PORKCHOP, I.STEAK, I.COOKED_MUTTON, I.COOKED_CHICKEN, I.APPLE]) {
        const k = Math.min(n, have.get(id) ?? 0);
        if (k > 0) {
          want.set(id, k);
          n -= k;
        }
      }
      if (want.size) {
        const t = await this.fromStore(want, true);
        if (t) out.push(t);
      }
    }
    return out.join("; ");
  }

  /** Dusk: the day's haul into the storehouse (the builder keeps its building materials), then home before dark. */
  private async duskRound(role: Role): Promise<string> {
    const b = this.body;
    const out: string[] = [];
    if (role !== "builder") {
      const put = this.storehouse() ? await this.toStore() : await this.toBuilder();
      if (put) out.push(put);
    }
    if (b.home) out.push(await b.goHome());
    else out.push("you have no home yet: build_house before dark (or dig_in)");
    return out.join("; ");
  }

  /** The builder: the board's project, start to finish (build takes what it needs from the storehouse first). */
  private async buildJob(): Promise<string> {
    const p = PACK.board?.project;
    if (!p) return `nothing left on the board to build: ${this.nextWork()}`;
    const r = await this.buildTown(p.kind, p.up);
    if (/^(finished|upgraded)/.test(r)) {
      PACK.board!.at = 0;
      this.updateBoard();
    } else if (/^no flat open spot|^gave up on|^there is no .* to upgrade/.test(r)) {
      // nowhere to put it (or nothing to upgrade): the board moves on to the next need for a while
      (PACK.board!.skip ??= {})[p.kind] = Date.now();
      PACK.board!.at = 0;
    }
    return r;
  }

  /** What the project is short of now, in raw materials, less what it carries itself. */
  private shortNow(): Map<Raw, number> {
    const short = new Map(Object.entries(PACK.board?.short ?? {}) as [Raw, number][]);
    const mine = new Map<number, number>();
    for (const st of this.body.inv) if (st) mine.set(st.id, (mine.get(st.id) ?? 0) + st.n);
    for (const [k, n] of short) short.set(k, Math.max(0, n - rawIn(mine, k)));
    return short;
  }

  /** The mason: the stone (else the coal, the iron) the project is short of, into the pool; in the afternoon the
   *  furnace work first (stone bricks, glass, iron for the upgrades). */
  private async masonJob(slot: Slot): Promise<string> {
    if (slot === "afternoon") {
      const s = await this.smeltForTown();
      if (s) return s;
    }
    const short = this.shortNow();
    const coal = (short.get("coal") ?? 0) > 0 && this.body.count(I.COAL) < 8;
    const iron = (short.get("iron") ?? 0) > 0 && this.body.count(I.RAW_IRON) + this.body.count(I.IRON_INGOT) < (short.get("iron") ?? 0);
    const [what, n] = (short.get("stone") ?? 0) > 0 || (!coal && !iron) ? ["cobblestone", 32] : coal ? ["coal_ore", 8] : ["iron_ore", Math.min(8, short.get("iron") ?? 4)];
    this.body.action = `getting ${what.replace("_ore", "")} for the town`;
    const got = await this.collect(what as string, n as number);
    if (this.body.dead || this.body.abort) return got;
    return [got, await this.deliver()].filter(Boolean).join("; ");
  }

  /** The woodcutter: the oak (else the sand) the project is short of, into the pool; in the afternoon the streets and
   *  the lamp posts the town is short of. */
  private async woodJob(slot: Slot): Promise<string> {
    if (slot === "afternoon") {
      const roads = PACK.builds.find((x) => x.kind === "road");
      const roadLeft = roads ? this.roadCount(roads) : [0, 0, 0];
      const pr = progress(civCount);
      const wants = (k: Kind) => (pr.next?.needs ?? []).some((n) => n.need[0] === k && n.have < n.need[1]);
      if (wants("road") || (roads && roadLeft[0] < roadLeft[2])) {
        const r = await this.buildTown("road");
        if (!/no paths to make yet|couldn't/.test(r)) return r;
      }
      if (wants("lamp") && (this.body.has(B.TORCH, 1) || this.body.count(I.COAL) + this.body.count(I.CHARCOAL) > 0)) {
        const r = await this.buildTown("lamp");
        if (!/couldn't|no open spot/.test(r)) return r;
      }
    }
    const short = this.shortNow();
    const sand = (short.get("sand") ?? 0) > 0 && (short.get("wood") ?? 0) <= 0;
    this.body.action = sand ? "getting sand for the town's glass" : "getting oak for the town";
    const got = sand ? await this.collect("sand", 16) : await this.collect("town_log", 24);
    if (this.body.dead || this.body.abort) return got;
    return [got, await this.deliver()].filter(Boolean).join("; ");
  }

  /** The farmer: ripe wheat cut and baked into bread, the fields the town needs, meat when the pack runs low, all of
   *  it into the pool; with nothing to farm, wood for the builder. */
  private async farmJob(): Promise<string> {
    const b = this.body;
    const out: string[] = [];
    if (b.findBlocks([B.WHEAT + 7], 40, 1).length) {
      out.push(await b.harvest(40));
      const loaves = Math.floor(b.count(I.WHEAT) / 3);
      if (loaves) out.push(`baked: ${(await this.exec("craft", { recipe: "bread", count: Math.min(16, loaves) }))}`);
      out.push(await this.deliver());
      return out.filter(Boolean).join("; ");
    }
    const pr = progress(civCount);
    const fields = (pr.next?.needs ?? []).some((n) => n.need[0] === "farm" && n.have < n.need[1]) || civCount("farm") < 1;
    if (fields) {
      // a hoe and seeds first (a hoe takes a crafting table: one near, or one made from a log)
      if (!b.inv.some((s) => s && key(s.id).endsWith("_hoe"))) {
        const logs = () => b.count(B.OAK_LOG) + b.count(B.BIRCH_LOG) + b.count(B.PALM_LOG);
        const planks = () => b.count(B.OAK_PLANKS) + b.count(B.BIRCH_PLANKS);
        const table = b.has(B.CRAFTING_TABLE) || b.tableInReach() || b.findBlocks([B.CRAFTING_TABLE], 20, 1).length > 0;
        if (logs() + planks() / 4 < (table ? 1 : 2)) await this.collect("log", 3);
        for (const p of ["oak_planks", "oak_planks_from_palm", "birch_planks"]) if (planks() < (table ? 4 : 8) && logs()) await b.craft(p, 2);
        if (!table) await b.craft("crafting_table", 1);
        if (!b.has(I.STICK, 2)) await b.craft("sticks", 1);
        const hoe = b.has(B.COBBLESTONE, 2) ? await b.craft("stone_hoe", 1) : await b.craft("wooden_hoe", 1);
        if (!hoe.made) out.push(`couldn't make a hoe (${hoe.why})`);
      }
      if (!b.has(I.WHEAT_SEEDS, 4)) out.push(await this.collect("wheat_seed", 8));
      if (b.inv.some((s) => s && key(s.id).endsWith("_hoe")) && b.has(I.WHEAT_SEEDS)) {
        if (PACK.base && Math.hypot(PACK.base.x - b.phys.x, PACK.base.z - b.phys.z) > 30) {
          const base = PACK.base;
          await b.goto(base.x + 0.5, base.y, base.z + 0.5, 7, { maxMs: 90000, done: () => Math.hypot(base.x + 0.5 - b.phys.x, base.z + 0.5 - b.phys.z) <= 7 });
        }
        out.push(await this.exec("farm", {}));
        return out.filter(Boolean).join("; ");
      }
    }
    // meat for the pack when it is running low: the nearest animal, cooked if there's a furnace and fuel
    const food = [...BOARD.values()].reduce((n, e) => n + (e.food ?? 0), 0) + rawIn(stock(), "food");
    const prey = [...b.animals.values()].map((a) => ({ a, d: b.distTo(a.x, a.y, a.z), k: ANIMAL_SPECS[a.kind]?.key ?? "" })).filter((e) => e.d < 40 && ["cow", "pig", "sheep", "chicken"].includes(e.k)).sort((p, q) => p.d - q.d)[0];
    if (food < 24 && prey && b.bestWeapon()) {
      out.push(await this.attack(prey.k));
      for (const raw of [I.BEEF, I.PORKCHOP, I.MUTTON, I.CHICKEN]) if (b.has(raw) && (b.count(I.COAL) + b.count(I.CHARCOAL) > 0 || b.count(B.OAK_LOG) > 0)) out.push(await b.smelt(raw, Math.min(8, b.count(raw))));
      out.push(await this.deliver());
      return out.filter(Boolean).join("; ");
    }
    // nothing to farm: the builder always wants wood
    out.push(await this.collect("town_log", 16));
    out.push(await this.deliver());
    return out.filter(Boolean).join("; ");
  }

  /** The afternoon furnace work: cobblestone smelted to stone and crafted into stone bricks, sand to glass, raw iron
   *  to ingots, for what the upgrades ahead need, out of the pool and back into it. Empty when there is nothing to do. */
  private async smeltForTown(): Promise<string> {
    const b = this.body;
    const p = PACK.board?.project;
    const bill = p ? this.projectBill(p) : new Map<number, number>();
    const have = stock();
    const want = (id: number) => Math.max(0, (bill.get(id) ?? 0) - (have.get(id) ?? 0) - b.count(id));
    const jobs: [number, number, number][] = []; // [what it makes, from, how many]
    const bricks = want(B.STONE_BRICKS) + want(B.STONE_BRICK_STAIRS) * 2 + want(B.STONE_BRICK_SLAB) + want(B.STONE_BRICK_WALL);
    if (bricks > 0) jobs.push([B.STONE_BRICKS, B.COBBLESTONE, Math.min(16, bricks)]);
    const glass = want(B.GLASS_PANE) ? Math.ceil(want(B.GLASS_PANE) / 2.6) : 0;
    if (glass > 0) jobs.push([B.GLASS, B.SAND, Math.min(16, glass)]);
    if (want(B.LANTERN) > 0) jobs.push([I.IRON_INGOT, I.RAW_IRON, Math.min(8, want(B.LANTERN))]);
    if (!jobs.length) return "";
    const out: string[] = [];
    for (const [make, from, n] of jobs) {
      if (b.dead || b.abort) break;
      if (b.count(from) < n) await this.fromStore(new Map([[from, n - b.count(from)]]), true);
      if (!b.has(from)) continue;
      if (b.count(I.COAL) + b.count(I.CHARCOAL) < 2 && b.count(B.OAK_LOG) + b.count(B.OAK_PLANKS) < 2) await this.fromStore(new Map([[I.COAL, 8]]), true);
      b.action = `smelting ${key(make).replace(/_/g, " ")} for the town`;
      if (make === B.STONE_BRICKS) {
        out.push(await b.smelt(B.COBBLESTONE, Math.min(16, n, b.count(B.COBBLESTONE))));
        const k = Math.floor(b.count(B.STONE) / 4);
        if (k) {
          const r = await b.craft("stone_bricks", k);
          if (r.made) out.push(`crafted ${r.made * 4} stone bricks`);
        }
      } else if (make === B.GLASS) {
        out.push(await b.smelt(B.SAND, Math.min(16, n, b.count(B.SAND))));
        const k = Math.floor(b.count(B.GLASS) / 6);
        if (k) {
          const r = await b.craft("glass_pane", k);
          if (r.made) out.push(`crafted ${r.made * 16} glass panes`);
        }
      } else out.push(await b.smelt(from, Math.min(8, n, b.count(from))));
    }
    if (!out.length) return "";
    out.push(await this.deliver());
    return out.filter(Boolean).join("; ");
  }

  /** What it gathered, to where the town can use it: the storehouse, else (none yet) the builder if it is near. */
  private async deliver(): Promise<string> {
    if (this.storehouse()) return await this.toStore();
    return await this.toBuilder();
  }

  /** How many of an item it keeps for itself when it puts its haul away: its tools and armour, a little food, torches
   *  and coal, a few logs, planks and cobblestone for its own needs (a crafting table, a shelter, sealing in), its
   *  bed and seeds. The rest of what a town is built of goes in. */
  private keepOf(id: number): number {
    const d = itemDef(id);
    if (!d || d.tool || d.armor || d.durability) return Infinity;
    if (d.food) return id === I.WHEAT ? 0 : 6;
    const keep: Record<number, number> = {
      [B.COBBLESTONE]: 16, [B.DIRT]: Infinity, [B.TORCH]: 16, [I.COAL]: 6, [I.CHARCOAL]: 6, [B.OAK_LOG]: 4, [B.PALM_LOG]: 4, [B.BIRCH_LOG]: 4,
      [B.OAK_PLANKS]: 8, [B.BIRCH_PLANKS]: 8, [I.STICK]: 8, [B.CRAFTING_TABLE]: 1, [B.FURNACE]: 1, [B.WOOL_WHITE]: 3,
    };
    if (id in keep) return keep[id];
    const town = new Set<number>([
      B.STONE, B.STONE_BRICKS, B.MOSSY_COBBLE, B.MOSSY_STONE_BRICKS, B.SAND, B.GRAVEL, B.GLASS, B.GLASS_PANE, B.OAK_STAIRS, B.COBBLE_STAIRS, B.STONE_BRICK_STAIRS,
      B.OAK_SLAB, B.COBBLE_SLAB, B.STONE_BRICK_SLAB, B.STONE_SLAB, B.COBBLE_WALL, B.STONE_BRICK_WALL, B.OAK_FENCE, B.OAK_GATE, B.OAK_DOOR, B.LADDER, B.TRAPDOOR,
      B.CHEST, B.BARREL, B.LANTERN, B.BOOKSHELF, B.HAY_BALE, B.FLOWER_POT, B.SUGAR_CANE, I.PAPER, I.RAW_IRON, I.IRON_INGOT, I.WHEAT, I.FLINT, I.CLAY_BALL, I.BRICK,
      B.BIRCH_STAIRS, B.BIRCH_SLAB, B.BIRCH_FENCE, B.LAMP, B.POPPY, B.DANDELION, B.BLUEBELL,
    ]);
    // saplings: a few for planting on the way, the rest for the tree farm
    if (id === B.OAK_SAPLING || id === B.BIRCH_SAPLING) return 4;
    return town.has(id) ? 0 : Infinity;
  }

  /** The storehouse the pack pools its supplies in: a finished one, the nearest to the plaza. */
  private storehouse(): Building | undefined {
    if (!PACK.base) return undefined;
    const c = this.hub();
    return PACK.builds.filter((x) => x.kind === "storehouse" && x.done && tierOf(x) >= 1).sort((p, q) => Math.hypot((p.x0 + p.x1) / 2 - c.x, (p.z0 + p.z1) / 2 - c.z) - Math.hypot((q.x0 + q.x1) / 2 - c.x, (q.z0 + q.z1) / 2 - c.z))[0];
  }

  /** The storehouse's chests and barrels that are really there (the plan's at its top tier), the nearest first. */
  private storeChests(): [number, number, number][] {
    const s = this.storehouse();
    if (!s) return [];
    const b = this.body;
    const out: [number, number, number][] = [];
    for (const [x, y, z, k] of this.planOf(s, topOf(s)).cells) {
      const t = cellTarget(k.split("|")[0]);
      if (t && isStorage(t.id) && isStorage(b.get(x, y, z))) out.push([x, y, z]);
    }
    return out.sort((p, q) => b.distTo(p[0], p[1], p[2]) - b.distTo(q[0], q[1], q[2]));
  }

  /** What the storehouse holds, as last counted, the most first, in words. */
  private stockText(n: number): string {
    return [...stock()].filter(([, k]) => k > 0).sort((p, q) => q[1] - p[1]).slice(0, n).map(([id, k]) => `${k} ${key(id)}`).join(", ");
  }

  /** Put its haul in the storehouse: `only` those items (item -> count), or everything for the town beyond what it
   *  keeps for itself. Empty when there was nothing to put in or no storehouse. */
  private async toStore(only: Map<number, number> | null = null): Promise<string> {
    const b = this.body;
    const chests = this.storeChests();
    if (!chests.length) return "";
    const going = new Map<number, number>();
    for (const st of b.inv) {
      if (!st || going.has(st.id)) continue;
      const n = only ? Math.min(b.count(st.id), only.get(st.id) ?? 0) : Math.max(0, b.count(st.id) - this.keepOf(st.id));
      if (n > 0) going.set(st.id, n);
    }
    if (!going.size) return "";
    b.action = "putting the haul in the storehouse";
    const put = new Map<number, number>();
    for (const [x, y, z] of chests) {
      if ([...going].every(([id, n]) => (put.get(id) ?? 0) >= n) || b.dead || b.abort) break;
      const r = await b.chestPut(x, y, z, (id, have) => Math.min(have, Math.max(0, (going.get(id) ?? 0) - (put.get(id) ?? 0))));
      if (!r) continue;
      for (const [id, n] of r.put) put.set(id, (put.get(id) ?? 0) + n);
      (PACK.chests ??= {})[`${x},${y},${z}`] = Object.fromEntries(r.inside);
    }
    savePack();
    if (!put.size) return "couldn't put anything in the storehouse (its chests are full or out of reach: upgrade storehouse adds more)";
    const text = [...put].map(([id, n]) => `${n} ${key(id)}`).join(", ");
    const p = PACK.board?.project;
    this.teamSay(`left ${text} in the storehouse${p && !p.up ? ` for ${nameOf(p.kind)}` : ""}.`);
    return `put ${text} in the storehouse (it holds ${this.stockText(6)})`;
  }

  /** What to take from the pool for a bill: the items themselves first (stone bricks, planks, panes, lanterns), then,
   *  for what it can't find made, what they are made of (cobblestone, logs, sand, iron, coal), as the build job would
   *  make them. */
  private storeWants(need: Map<number, number>, have: Map<number, number>): Map<number, number> {
    const b = this.body;
    const want = new Map<number, number>();
    const demand = new Map(need);
    const add = (id: number, n: number) => demand.set(id, (demand.get(id) ?? 0) + n);
    const carried = (id: number) => (id === LOGS ? b.count(B.OAK_LOG) + b.count(B.PALM_LOG) : id === FUEL ? b.count(I.COAL) + b.count(I.CHARCOAL) : b.count(id));
    const takeOf = (id: number, n: number): number => {
      let got = 0;
      for (const x of id === LOGS ? [B.OAK_LOG, B.PALM_LOG] : id === FUEL ? [I.COAL, I.CHARCOAL] : [id]) {
        const k = Math.min(n - got, (have.get(x) ?? 0) - (want.get(x) ?? 0));
        if (k > 0) {
          want.set(x, (want.get(x) ?? 0) + k);
          got += k;
        }
      }
      return got;
    };
    for (const id of [...ORDER, ...RAW]) {
      let short = (demand.get(id) ?? 0) - carried(id);
      if (short <= 0) continue;
      short -= takeOf(id, short);
      if (short <= 0) continue;
      const m = MAKE.get(id);
      if (!m) continue;
      if ("from" in m) add(m.from, short);
      else {
        const n = Math.ceil(short / m.out);
        for (const [ing, k] of m.ings) add(ing, k * n);
      }
    }
    return want;
  }

  /** Take from the storehouse what a build needs (or, exact, just those items). Empty when there's nothing in it for
   *  that, no storehouse, or it is a long way off. */
  private async fromStore(need: Map<number, number>, exact = false): Promise<string> {
    const b = this.body;
    const s = this.storehouse();
    const chests = this.storeChests();
    if (!s || !chests.length || Math.hypot((s.x0 + s.x1) / 2 - b.phys.x, (s.z0 + s.z1) / 2 - b.phys.z) > 72) return "";
    const have = stock();
    const want = exact ? new Map(need) : this.storeWants(need, have);
    // (a chest nobody has looked in yet may have it too)
    const unseen = chests.some(([x, y, z]) => !PACK.chests?.[`${x},${y},${z}`]);
    for (const [id] of want) if ((have.get(id) ?? 0) <= 0 && !unseen) want.delete(id);
    if (!want.size) return "";
    b.action = "taking what the build needs from the storehouse";
    const got = new Map<number, number>();
    for (const [x, y, z] of chests) {
      const left = new Map([...want].map(([id, n]) => [id, n - (got.get(id) ?? 0)] as [number, number]).filter(([, n]) => n > 0));
      if (!left.size || b.dead || b.abort) break;
      const inside = PACK.chests?.[`${x},${y},${z}`];
      if (inside && ![...left.keys()].some((id) => (inside[id] ?? 0) > 0)) continue;
      const r = await b.chestTake(x, y, z, left);
      if (!r) continue;
      for (const [id, n] of r.got) got.set(id, (got.get(id) ?? 0) + n);
      (PACK.chests ??= {})[`${x},${y},${z}`] = Object.fromEntries(r.inside);
    }
    savePack();
    return got.size ? `took ${[...got].map(([id, n]) => `${n} ${key(id)}`).join(", ")} from the storehouse` : "";
  }

  /** Look in every chest of the storehouse and count what the pack has. */
  private async lookInStore(): Promise<string> {
    const b = this.body;
    const chests = this.storeChests();
    if (!chests.length) return "there is no storehouse with chests yet (build storehouse: it becomes the pack's pool)";
    for (const [x, y, z] of chests) {
      if (b.dead || b.abort) break;
      const m = await b.chestContents(x, y, z);
      if (m) (PACK.chests ??= {})[`${x},${y},${z}`] = Object.fromEntries(m);
    }
    savePack();
    return `the storehouse holds ${this.stockText(20) || "nothing"}`;
  }

  /** No storehouse yet: bring the builder what the project is short of (raw materials it carries beyond its own
   *  needs), when the builder is somebody else and not far. */
  private async toBuilder(): Promise<string> {
    const builder = Object.entries(PACK.board?.roles ?? {}).find(([, r]) => r === "builder")?.[0];
    if (!builder || builder === this.name) return "";
    const b = this.body;
    const o = [...b.others.values()].find((p) => p.name === builder && !(p.flags & FLAG.DEAD));
    if (!o || Math.hypot(o.x - b.phys.x, o.z - b.phys.z) > 64) return "";
    const give: [number, number][] = [];
    for (const id of [B.COBBLESTONE, B.OAK_LOG, B.PALM_LOG, B.OAK_PLANKS, B.SAND, B.GLASS, I.COAL, I.RAW_IRON, I.IRON_INGOT, B.STONE_BRICKS]) {
      const n = b.count(id) - (this.keepOf(id) === Infinity ? b.count(id) : this.keepOf(id));
      if (n > 0) give.push([id, n]);
    }
    if (!give.length) return "";
    const why = this.cantReach(o);
    if (why) return await this.cantHand(builder, why, give);
    b.action = `bringing ${builder} what the build is short of`;
    const out: string[] = [];
    for (const [id, n] of give) {
      if (b.dead || b.abort) break;
      out.push(await this.give(builder, key(id), n));
    }
    const text = give.map(([id, n]) => `${n} ${key(id)}`).join(", ");
    if (out.some((t) => t.startsWith("threw"))) this.teamSay(`${builder}, brought you ${text} for the build.`);
    return out.join("; ");
  }

  /** Why a player can't be walked to now, or "": down in the rock (the ground's own blocks over its head: a staircase
   *  mine, a cave), or tried a moment ago and not got to. */
  private cantReach(o: { name: string; x: number; y: number; z: number }): string {
    const was = this.outOfReach.get(o.name);
    if (was && was.until > Date.now()) return was.why;
    const b = this.body;
    const x = Math.floor(o.x);
    const z = Math.floor(o.z);
    const y0 = Math.floor(o.y + 0.1);
    for (let y = y0 + 2; y < Math.min(127, y0 + 80); y++) {
      const id = b.get(x, y, z);
      if (id === B.STONE || id === B.DIRT || id === B.GRASS || id === B.GRAVEL || id === B.CLAY || (BLOCKS[id]?.key ?? "").endsWith("_ore")) return `${o.name} is down in the rock (at y=${y0})`;
    }
    return "";
  }

  /** The builder can't be reached: no walk that can't end. With no storehouse yet and enough on it for one, it builds
   *  the storehouse first (the pack's pool from then on) and puts the haul in it; else it keeps the haul and hands it
   *  over once the builder is back up. */
  private async cantHand(builder: string, why: string, give: [number, number][]): Promise<string> {
    const b = this.body;
    if (!this.storehouse() && PACK.base && !b.isNight()) {
      const mine = new Map<number, number>();
      for (const st of b.inv) if (st) mine.set(st.id, (mine.get(st.id) ?? 0) + st.n);
      if ([...rawOf(materialsFor("storehouse", 1))].every(([k, n]) => rawIn(mine, k) >= n)) {
        b.action = `building the storehouse (${builder} can't be reached)`;
        const r = await this.buildTown("storehouse");
        if (this.storehouse()) return `${why}, so you built the storehouse instead (the pack's pool from now on): ${r.slice(0, 160)}; ${await this.toStore()}`;
        return `${why}: you kept the haul (the storehouse didn't go up: ${r.slice(0, 160)})`;
      }
    }
    return `${why}: you kept ${give.map(([id, n]) => `${n} ${key(id)}`).join(", ")} to hand over when ${builder} is back up (or put in the storehouse once there is one), rather than walk there`;
  }

  /** A short line in chat when it hands something over or finishes something (not more than once in 40 seconds). */
  private lastTeamSay = 0;
  private teamSay(text: string): void {
    if (Date.now() - this.lastTeamSay < 40000 || this.body.dead) return;
    this.lastTeamSay = Date.now();
    const t = text.slice(0, 200);
    this.body.send({ t: "chat", text: t });
    this.emit("chat", { text: t });
    this.log.push(`You said: "${t}"`);
  }

  // ---------------------------------------------------------------- reflexes

  private async guard(): Promise<void> {
    const b = this.body;
    // shot at in the middle of a walk (home, or out to build before dark): drop the walk so the archer gets dealt
    // with. A reflex used to run to its end first, and sonnet and haiku were both shot dead walking home at dusk
    // (not a fight already: v13's pillar, the hunt, helping another)
    if (this.reflexing && !/rattler|fight|running|getting away|dig|wall|hurt|water|pillar|going after|helping/.test(this.reflexLabel) && Date.now() - b.lastHurt.at < 1500 && b.hostiles(16).some((m) => m.key === "rattler")) b.abort = true;
    if (this.reflexing || this.stopped || b.dead || b.closed) return;
    // armour it carries goes on (the server swaps each better piece in), checked every few seconds
    if (Date.now() - this.lastWear > 4000) {
      this.lastWear = Date.now();
      const better = b.inv.some((s) => {
        const a = s ? itemDef(s.id)?.armor : undefined;
        const cur = a ? b.armor[a.slot] : null;
        return !!a && (!cur || armorValue(cur.id) < armorValue(s!.id)); // v13: Protection counts too
      });
      if (better) b.wearBest();
    }
    // stuck swimming (a flooded hole, a pond with steep banks): out of the water before anything else
    if (b.phys.inWater && !b.sealed()) {
      if (!this.inWaterSince) this.inWaterSince = Date.now();
      else if (Date.now() - this.inWaterSince > 3000) {
        this.inWaterSince = 0;
        await this.reflex("getting out of the water", async () => `You were stuck in the water, so you got out: ${(await b.escapeWater()) ? "you are on dry land now" : "you are still in the water"}.`);
        return;
      }
    } else this.inWaterSince = 0;
    // monsters: shoot back, charge, take cover, pillar up, fight with technique, help the others, hunt (v13: combat())
    if (await this.combat()) return;
    // a full bag loses whatever it crafts or mines next: make room (at most once a minute, never mid-fight)
    if (b.inv.filter(Boolean).length >= 33 && Date.now() - this.lastTidy > 60000 && !b.hostiles(10).length) {
      this.lastTidy = Date.now();
      await this.reflex("making room in its inventory", async () => {
        const t = await b.tidyInventory();
        return t ? `Your inventory was full, so you threw out ${t}.` : "Your inventory is full of things you need: use some, or put them in a chest at the storehouse.";
      });
      return;
    }
    // hungry with food on it: eat (not more than every 10 s)
    // or hurt and not quite full: a full bar heals half a heart every half second, 18 or 19 only every 4 s (haiku sat
    // at 6 health with hunger 18 after a rattler, healing at a crawl)
    // (not in an archer's sight unless starving: a meal is a second and a half standing still, and an iron-clad trial
    // dropped to 1 health eating between two rattlers)
    const inSights = b.hostiles(20).some((m) => m.key === "rattler" && b.seenBy(m));
    const hurtHealing = b.stats.hp <= 12 && b.stats.food < 20 && !b.hostiles(8).length && !inSights;
    if ((b.stats.food <= 8 || hurtHealing) && Date.now() - this.lastEat > 10000 && b.inv.some((s) => s && itemDef(s.id)?.food && !itemDef(s.id)?.food?.queasy)) {
      this.lastEat = Date.now();
      await this.reflex("eating", async () => (b.stats.food <= 8 ? `You were starving, so you ate: ${await b.eat()}.` : `You were hurt, and a full stomach heals fast, so you ate: ${await b.eat()}.`));
      return;
    }
    // a deep trip left below (a fight cut it short and nothing took it up again), late in the day: back up the way it
    // went down, before the dark (the night rules: nobody is deep after dusk)
    if (oughtToClimbOut(b) && !b.hostiles(10).length && this.skill !== "mine_trip" && Date.now() - this.lastClimb > 60000) {
      this.lastClimb = Date.now();
      await this.reflex("climbing out of the mine before dusk", async () => `It was getting late and you were still down the mine, so you climbed back out: ${(await climbOut(b)) ? "you're up in the open again" : "you're still underground (dig_out)"}.`);
      return;
    }
    // dusk with a house: home before dark (and to bed). Not out of a sealed hole (safe there till morning), not
    // in the middle of digging in or out (it cut dig_out short every minute and left haiku in the rock all night),
    // and not a long walk through the dark once night has fallen
    const tod = b.timeOfDay();
    const homeFar = b.home ? Math.hypot(b.homeMiddle()[0] - b.phys.x, b.homeMiddle()[1] - b.phys.z) : 0;
    // dusk near the storehouse with a bag of things for the town: put them in before going home (the day plan's dusk
    // round; work does it, this catches whoever is busy with something else). Not the builder (its bag is the build)
    if (tod >= 10800 && tod < 11500 && Date.now() - this.lastStoreTrip > 300000 && !["build", "upgrade", "work", "collect", "storehouse", "dig_out", "dig_in", "go_home", "sleep", "smelt", "mine_trip"].includes(this.skill)
      && !/home|bed|asleep|storehouse/.test(b.action) && !b.sealed() && PACK.board?.roles[this.name] !== "builder") {
      const s = this.storehouse();
      if (s && Math.hypot((s.x0 + s.x1) / 2 - b.phys.x, (s.z0 + s.z1) / 2 - b.phys.z) < 40) {
        const ids = new Set(b.inv.filter((st): st is Stack => !!st).map((st) => st.id));
        let haul = 0;
        for (const id of ids) haul += Math.max(0, b.count(id) - this.keepOf(id));
        if (haul >= 24) {
          this.lastStoreTrip = Date.now();
          await this.reflex("taking the day's haul to the storehouse", async () => `It was dusk and you were near the storehouse with things for the town, so you put them in: ${(await this.toStore()) || "nothing went in"}.`);
          return;
        }
      }
    }
    // a long way out in the late afternoon: start back now, while there's daylight for the walk (opus went 190 blocks
    // after sheep and was still out there at dusk, in a marsh where it couldn't dig in)
    if (b.home && homeFar > 45 && tod >= 9000 && tod < 11600 && Date.now() - this.lastHomeTrip > 60000 && !/home|bed|asleep/.test(b.action)
      && !b.sealed() && !["dig_out", "dig_in", "go_home", "sleep", "build_house", "mine_trip"].includes(this.skill) && !pendingTrip(b)) {
      this.lastHomeTrip = Date.now();
      await this.reflex("heading home before dark, it's a long walk", async () => `You were ${Math.round(homeFar)} blocks from home late in the afternoon, so you started back before dark: ${await b.goHome()}.`);
      return;
    }
    if (b.home && !b.atHome() && tod >= 11600 && tod < 23000 && Date.now() - this.lastHomeTrip > 60000 && !/home|bed|asleep/.test(b.action) && this.skill !== "mine_trip" && !pendingTrip(b)
      && !b.sealed() && !this.holeMining && !["dig_out", "dig_in", "go_home", "sleep", "build_house"].includes(this.skill) && (!b.isNight() || homeFar < 40)
      // once it's dark, only from out in the open: under cover it stays and works (underground at night, opus set off
      // for a house 19 blocks away through the rock and paced its tunnel for a minute and a half, twice)
      && !(b.isNight() && b.covered())
      && Date.now() - b.homeFailAt > 5 * 60000) {
      this.lastHomeTrip = Date.now();
      await this.reflex("heading home for the night", async () => `It was getting dark, so you went home: ${await b.goHome()}.`);
      return;
    }
    // late afternoon with no house but the blocks for one: build it now at the base, so night finds it indoors with
    // its bed (beds go in houses, not holes)
    // (not from down a mine: the trip climbs out first; all four test trips were pulled off their climb to go and build)
    if (!b.home && tod >= 10200 && tod < 11900 && b.buildingBlocks().n >= 38 && Date.now() - this.lastHouseTry > 120000 && !/build|house/.test(b.action) && this.skill !== "mine_trip" && !pendingTrip(b)) {
      this.lastHouseTry = Date.now();
      const far = PACK.base ? Math.hypot(PACK.base.x - b.phys.x, PACK.base.z - b.phys.z) : 0;
      if (!PACK.base || far < 60) {
        await this.reflex("building a house before dark", async () => {
          if (PACK.base && far > 12) await b.goto(PACK.base.x + 0.5, PACK.base.y, PACK.base.z + 0.5, 6, { maxMs: 40000 });
          return `Evening was coming and you had no house, so you built one: ${await this.exec("build_house", {})}.`;
        });
        return;
      }
    }
    // dusk or night in the open with no house: take cover before the archers come out (they spawn at dark and
    // shoot from range, so waiting until it's night already is too late)
    const dusk = tod >= 11900 && tod < 23000;
    if ((dusk || b.isNight()) && !b.covered() && !b.phys.inWater && !(b.home && !b.atHome() && /home/.test(b.action) && Date.now() - b.homeFailAt > 5 * 60000)) {
      if (!this.nightOutSince) this.nightOutSince = Date.now();
      else if (Date.now() - this.nightOutSince > (b.isNight() ? 4000 : 12000) && !/shelter|bed|sleep|home/.test(b.action)) {
        this.nightOutSince = Date.now();
        // a bed already standing nearby (its own, in a house) is fine; a bed in its pocket is not put down in a hole
        const bed = b.findBlocks([0, 1, 2, 3, 4, 5, 6, 7].map((k) => B.RED_BED + k), 16, 1).length > 0;
        if (bed) await this.reflex("going to bed", async () => `Night caught you in the open, so you went to bed: ${await b.sleep()}.`);
        // never with a walker or a crawler on its way: it gets there mid-dig and follows it down (the fight comes first)
        else if (!b.hostiles(12).length) await this.reflex("digging in for the night", async () => `Night caught you in the open, so you dug in: ${await b.digIn()}.`);
      }
    } else this.nightOutSince = 0;
  }

  // ---------------------------------------------------------------- fighting (v14)

  /** Monsters near it, the way a fighter handles them (Laith: "if they have a sword and armor, like they can fight,
   *  like they should fight"). Ready to fight (a real weapon: a stone sword or better, or an axe; not badly hurt; not
   *  clearly outnumbered) it takes on what's on it and finishes it: walkers and crawlers with technique (charged and
   *  critical hits, stepping back on the recharge, circling), archers with the bow from range or a charge (armour takes
   *  most of the sting out of arrows), then picks up the drops. No cover, no running and no walls just because a
   *  monster showed up. It gives ground only unarmed, badly hurt or clearly outnumbered: up a pillar out of walkers'
   *  reach, home if it's near and it's out in the open, else a sprint to a spot out of their reach and sight; never a
   *  hole with a monster about. Outnumbered or hurt it calls the others, and one that's free comes and fights beside
   *  it: once a fight, while that fight lasts. Then, armed and fit with one about in the open, the hunt. */
  private async combat(): Promise<boolean> {
    const b = this.body;
    if (b.sealed()) return false;
    const now = Date.now();
    const hurtRecently = now - b.lastHurt.at < 2000;
    const shot = hurtRecently && b.lastHurt.cause === "mob:rattler";
    const left = (m: { id: number }) => (this.leftAlone.get(m.id) ?? 0) > now;
    const hostile = b.hostiles(20);
    const melee = hostile.filter((m) => m.key !== "rattler");
    const archers = hostile.filter((m) => m.key === "rattler");
    const weapon = b.bestWeapon();
    const tool = itemDef(weapon)?.tool;
    // a real weapon: a stone sword or better, or an axe (a wooden sword or a pickaxe is not a fighting weapon)
    const real = !!tool && (tool.kind === "axe" || (tool.kind === "sword" && tool.material >= 1));
    const armour = b.armor.reduce((n, s) => n + ((s && itemDef(s.id)?.armor?.points) || 0), 0);
    const armoured = armour >= 6;
    const hp = b.stats.hp;
    const bow = b.has(I.BOW) && b.has(I.ARROW);
    // underground: under a roof that isn't one of the town's buildings (inside a cottage the roof counts as "covered",
    // and haiku fought a shambler to the end in the house it had just moved into, 11/2)
    const indoors = footprints().some((r) => b.phys.x >= r.x0 && b.phys.x <= r.x1 + 1 && b.phys.z >= r.z0 && b.phys.z <= r.z1 + 1);
    const below = b.covered() && !indoors;
    const sheltered = indoors || b.asleep || (!!b.home && b.atHome());
    const [ex, ey, ez] = b.eye();
    // indoors, only what it can actually get at: one outside a window sees in through the glass, but nobody gets
    // through it (haiku went for one through its window over and over, and every time it called sonnet over)
    const reachable = (m: Seen) => !sheltered || hurtRecently || b.clearShot(ex, ey, ez, m.x, m.y + 1.2, m.z);
    // what is on it: walkers and crawlers at arm's length (or that just hit it, or are coming on), and an archer that
    // has it in its sights
    const onIt = melee.filter((m) => (m.d < 3.6 || (hurtRecently && m.d < 6) || ((m.flags & MF.AGGRO) !== 0 && m.d < 5)) && (!left(m) || hurtRecently) && reachable(m));
    const r = archers.find((m) => m.d < 20 && (shot || (!sheltered && (m.flags & MF.AGGRO) !== 0 && m.d < 14 && b.seenBy(m))) && !(left(m) && !shot));
    const threats = hostile.filter((m) => m.d < 12 && reachable(m)).length;
    const badlyHurt = hp < (armoured ? 6 : 8);
    // clearly outnumbered: more than its kit can take on at once (three unarmoured, four in light armour, five in iron,
    // six in iron with an iron sword)
    const outnumbered = threats >= (armour >= 12 ? (b.strong() ? 6 : 5) : armoured ? 4 : 3);
    const ready = real && !badlyHurt && !outnumbered;

    if (onIt.length || r) {
      if (shot) b.lastHurt.at = 0;
      const h = onIt[0];
      if (!ready) {
        // ---- giving ground: unarmed, badly hurt or clearly outnumbered
        // badly hurt in a tunnel with one walker, a block or two closing it: wall it off to heal (nowhere to run)
        if (h && badlyHurt && below && hostile.filter((m) => m.d < 10).length <= 1 && b.canWallOff()) {
          await this.reflex(`badly hurt underground, walling itself in`, async () => `A ${h.key} had you badly hurt underground, so you walled it off to heal: ${await b.wallOff()}.`);
          return true;
        }
        // walkers only: two blocks up a pillar, out of their reach, and fight (or eat) from there
        if (h && this.canPillarFight(melee, archers)) {
          await this.reflex(`pillaring up out of the ${h.key}s' reach`, async () => {
            this.fighting(h);
            this.callForHelp(outnumbered ? `${threats} monsters` : `a ${h.key}, and I'm ${real ? "hurt" : "unarmed"}`, h);
            return `${outnumbered ? `${threats} monsters were on you` : `A ${h.key} came at you while you were ${real ? "badly hurt" : "unarmed"}`}, so you went two blocks up a pillar where walkers can't reach and fought from there: ${await b.pillarFight()}.`;
          });
          FIGHTS.delete(this.name);
          return true;
        }
        // just an archer, and a bow: shoot it from where it stands (a fight at range, not a retreat)
        if (!h && r && bow && hp >= 6 && r.d >= 4) {
          await this.reflex("shooting back at a rattler", async () => {
            this.fighting(r);
            return `A rattler had you in its sights, so you shot back with your bow (${await b.duel({ kind: "mob", id: r.id }, 25000, 5)}).`;
          });
          FIGHTS.delete(this.name);
          return true;
        }
        // just an archer, no bow: running is running in its sights (haiku died that way in iron, season 13 day 11:
        // 11.6 health in 15 s, shot in the back). Armoured and not badly hurt: close in and kill it with whatever it
        // has. Otherwise break its line of sight with blocks
        if (!h && r && !outnumbered) {
          if (armoured && !badlyHurt && !b.acrossWater(r.x, r.z, r.y)) {
            await this.reflex("charging the rattler", async () => {
              this.fighting(r);
              const res = await b.fight({ kind: "mob", id: r.id }, 25000, 5, 24);
              if (/dead or gone/.test(res) && !b.hostiles(8).length) await b.pickUp(5, 3000);
              return `A rattler had you in its sights; you had no real weapon but you were armoured, so you went at it with what you had (${res}).`;
            });
            FIGHTS.delete(this.name);
            return true;
          }
          await this.reflex("breaking the rattler's line of sight", async () => `A rattler had you in its sights and you were ${!real ? "unarmed" : "badly hurt"}, so you got out of its sight: ${await this.blockSight(r)}.`);
          return true;
        }
        const from = hostile.filter((m) => m.d < 14);
        this.callForHelp(outnumbered ? `${threats} monsters` : `a ${(h ?? r)!.key}, and I'm ${real ? "hurt" : "unarmed"}`, h ?? r);
        await this.reflex(`getting away, ${!real ? "unarmed" : badlyHurt ? "badly hurt" : "outnumbered"}`, async () => this.escape(from, `${outnumbered ? `${threats} monsters were on you` : `A ${(h ?? r)!.key} was on you`} and you were ${!real ? "unarmed" : badlyHurt ? "badly hurt" : "outnumbered"}`));
        return true;
      }

      // ---- ready: take on what's on it and finish it. A walker in reach first (it's hitting), then the archer
      const target = h ?? r!;
      const archer = target.key === "rattler";
      const crowd = hostile.filter((m) => m.d < 9).length;
      if (crowd >= 2 || hp < 12) this.callForHelp(crowd >= 2 ? `${crowd} monsters` : `a ${target.key}, and I'm hurt`, target);
      let res = "";
      // an archer at range without armour, and a bow: shoot it; otherwise at it (armoured, arrows do half or less). One
      // across water is never charged (a swimmer is a sitting target): the bow, or out of its sight
      const wet = archer && b.acrossWater(target.x, target.z, target.y);
      if (wet && !bow) {
        await this.reflex("breaking the rattler's line of sight", async () => `A rattler had you in its sights from across the water, so you got out of its sight rather than swim at it: ${await this.blockSight(target)}.`);
        return true;
      }
      const shoot = archer && bow && (!armoured || wet) && target.d >= (wet ? 4 : 6);
      const label = archer ? (shoot ? "shooting back at a rattler" : "charging the rattler") : `fighting a ${target.key}`;
      await this.reflex(label, async () => {
        this.fighting(target);
        // (with two archers on it, it breaks off earlier: the escape needs health to spare under their arrows)
        const bail = armoured ? (archers.filter((m) => m.d < 18).length >= 2 ? 7 : 5) : 7;
        res = shoot ? await b.duel({ kind: "mob", id: target.id }, 25000, bail) : await b.fight({ kind: "mob", id: target.id }, 25000, bail, archer ? 24 : 20);
        if (/dead or gone/.test(res) && !b.hostiles(8).length) await b.pickUp(5, 3000); // the drops
        return archer ? `A rattler had you in its sights and you ${shoot ? "shot it down with your bow" : "went at it"} (${res}).` : `A ${target.key} came at you and you fought it (${res}).`;
      });
      FIGHTS.delete(this.name);
      if (/ran out of time|couldn't get to it|out of reach|let it go|lost sight|got away/.test(res)) this.leftAlone.set(target.id, Date.now() + 30000);
      if (/backed off/.test(res) && !b.dead && !b.sealed()) {
        // badly hurt mid-fight: give ground the way it does when it starts badly hurt
        const homeNear = b.home && !b.atHome() && !b.covered() && Math.hypot(b.homeMiddle()[0] - b.phys.x, b.homeMiddle()[1] - b.phys.z) < 40;
        if (below && !homeNear && b.canWallOff() && hostile.filter((m) => m.d < 10).length <= 1) {
          await this.reflex(`badly hurt underground, walling itself in`, async () => `You were badly hurt fighting a ${target.key} underground, so you walled it off to heal: ${await b.wallOff()}.`);
        } else if (!homeNear && !archer && this.canPillarFight(melee, archers)) {
          await this.reflex(`badly hurt, pillaring up out of reach`, async () => `You were badly hurt fighting a ${target.key}, so you went up a pillar out of its reach: ${await b.pillarFight()}.`);
        } else if (archer && !b.hostiles(8).some((m) => m.key !== "rattler")) {
          // an archer: out of its sight with blocks, not a run in its sights
          await this.reflex("breaking the rattler's line of sight", async () => `You were badly hurt fighting a rattler, so you got out of its sight: ${await this.blockSight(target)}.`);
        } else {
          const from = b.hostiles(16);
          await this.reflex(`getting away, badly hurt`, async () => this.escape(from, `You were badly hurt fighting a ${target.key}`));
        }
      }
      return true;
    }

    // ---- another of the pack is fighting: go and fight beside it. Once a fight, and only while it lasts (sonnet was
    // pulled off its building 15 times in 20 minutes on season 13, by one fight after another that was already over or
    // that it had answered): a monster it has helped against is never answered again, the caller must still be at it,
    // and without a call only when it's close by
    if (ready && hp >= 12 && !below && !b.phys.inWater && !["dig_in", "sleep", "go_home"].includes(this.skill)) {
      for (const [who, f] of FIGHTS) {
        if (who === this.name || now - f.at > 30000 || (this.answered.get(f.id) ?? 0) > now) continue;
        if (!/fight|charg|pillar|shoot|helping|going after|getting away/.test(BOARD.get(who)?.doing ?? "")) continue;
        const m = b.mobs.get(f.id);
        if (!m || m.flags & MF.DEAD) continue;
        const d = Math.hypot(m.x - b.phys.x, m.z - b.phys.z);
        if (d > (f.call ? 40 : 16) || (!f.call && now - this.lastHelp < 60000)) continue;
        if (f.key === "rattler" && !armoured && !bow) continue;
        this.answered.set(f.id, now + 300000);
        this.lastHelp = now;
        if (f.call && now - this.lastHelpReply > 60000) {
          this.lastHelpReply = now;
          const text = `coming, ${who}`;
          b.send({ t: "chat", text });
          this.emit("chat", { text });
        }
        let res = "";
        await this.reflex(`helping ${who} with a ${f.key}`, async () => {
          res = bow && f.key === "rattler" && !armoured ? await b.duel({ kind: "mob", id: f.id }, 25000, 7) : await b.fight({ kind: "mob", id: f.id }, 25000, armoured ? 5 : 8, 44);
          if (/dead or gone/.test(res) && !b.hostiles(8).length) await b.pickUp(5, 3000);
          return `${who} was fighting a ${f.key}${f.call ? " and called for help" : " near you"}, so you went and fought it beside them (${res}).`;
        });
        return true;
      }
    }

    // ---- the hunt: armed with a real weapon and fit, a walker or a crawler near it out in the open: go and kill it
    // (Laith: "they make swords but do not fight mobs"). Armoured, an archer too. Not underground, not into a crowd,
    // and never chased far from where it was
    const prey = [...melee, ...(armoured ? archers.filter((m) => !b.acrossWater(m.x, m.z, m.y)) : [])].filter((m) => m.d < 14 && !left(m) && reachable(m)).sort((p, q) => p.d - q.d)[0];
    if (prey && ready && hp >= (armoured ? 12 : 16) && !b.covered() && !b.phys.inWater && hostile.filter((m) => m.d < 16).length <= (armoured ? 3 : 2) && now - this.lastHunt > 15000) {
      this.lastHunt = now;
      let res = "";
      await this.reflex(`going after a ${prey.key}`, async () => {
        this.fighting(prey);
        res = await b.fight({ kind: "mob", id: prey.id }, 20000, armoured ? 6 : 9, 18);
        if (/dead or gone/.test(res) && !b.hostiles(8).length) await b.pickUp(5, 3000);
        return `A ${prey.key} was ${Math.round(prey.d)} blocks away and you were armed${armoured ? " and armoured" : ""}, so you went after it (${res}).`;
      });
      FIGHTS.delete(this.name);
      if (/ran out of time|couldn't get to it|out of reach|let it go/.test(res)) this.leftAlone.set(prey.id, Date.now() + 60000);
      return true;
    }
    return false;
  }

  /** Up a pillar is right here: blocks to spare, room overhead, dry, no crawler about (it climbs) and no archer that can
   *  see it (it would be a target up there). */
  private canPillarFight(melee: { key: string; d: number }[], archers: (Seen & { d: number })[]): boolean {
    const b = this.body;
    if (b.fillerCount() < 2 || b.phys.inWater || !b.phys.onGround) return false;
    if (melee.some((m) => m.key === "skitter" && m.d < 12)) return false;
    if (archers.some((m) => m.d < 20 && b.seenBy(m))) return false;
    const x = Math.floor(b.phys.x);
    const y = Math.floor(b.phys.y + 0.1);
    const z = Math.floor(b.phys.z);
    return !SOLID[b.get(x, y + 2, z)] && !SOLID[b.get(x, y + 3, z)] && !SOLID[b.get(x, y + 4, z)];
  }

  /** Out of a fight it can't take: home if it's near and it's out in the open (a door between them), else a sprint to
   *  a spot away from them and out of the archers' sight (body.runAway). Never a hole with monsters about. */
  /** Out of an archer's sight: home if it's near in the open; else a two-high wall toward it (it has to come round, into
   *  reach), walled in all round when badly hurt or with another archer about; no blocks: a run across its line of
   *  fire (body.runAway). Never a hole. */
  private async blockSight(r: Seen): Promise<string> {
    const b = this.body;
    if (b.home && !b.atHome() && !b.covered() && Math.hypot(b.homeMiddle()[0] - b.phys.x, b.homeMiddle()[1] - b.phys.z) < 25) return `ran home: ${await b.goHome()}`;
    const archers = b.hostiles(20).filter((m) => m.key === "rattler");
    if (b.fillerCount() >= 2 && (await b.coverFrom(r.x, r.z))) {
      if ((b.stats.hp < 8 || archers.length >= 2) && b.fillerCount() >= b.openGaps()) return `walled itself in: ${await b.wallOff()}`;
      return "put a wall up between you and it (it has to come round it, into reach)";
    }
    return await b.runAway(b.hostiles(16));
  }

  private async escape(from: (Seen & { d: number })[], why: string): Promise<string> {
    const b = this.body;
    if (b.home && !b.atHome() && !b.covered() && Math.hypot(b.homeMiddle()[0] - b.phys.x, b.homeMiddle()[1] - b.phys.z) < 40) return `${why}, so you ran home: ${await b.goHome()}.`;
    return `${why}, so you got away from them: ${await b.runAway(from)}.`;
  }

  /** Telling the pack which monster it's fighting (a fight the others can join), and whether it called for help. */
  private fighting(m: Seen & { key: string }): void {
    const was = FIGHTS.get(this.name);
    FIGHTS.set(this.name, { id: m.id, key: m.key, x: m.x, z: m.z, at: Date.now(), call: !!was?.call && was.id === m.id });
  }

  /** A shout for help when it's outnumbered or hurt, with another of the pack near enough to come (at most once a
   *  minute and a half): the fight it's in is marked as a call, which the others answer from further off. */
  private callForHelp(what: string, m?: Seen & { key: string }): void {
    const b = this.body;
    if (m) FIGHTS.set(this.name, { id: m.id, key: m.key, x: m.x, z: m.z, at: Date.now(), call: true });
    if (Date.now() - this.lastHelpCall < 90000) return;
    const near = [...b.others.values()].some((o) => !(o.flags & FLAG.DEAD) && Math.hypot(o.x - b.phys.x, o.z - b.phys.z) < 48);
    if (!near) return;
    this.lastHelpCall = Date.now();
    const text = `${what} on me at ${Math.round(b.phys.x)} ${Math.round(b.phys.z)}, help!`;
    b.send({ t: "chat", text });
    this.emit("chat", { text });
    this.log.push(`You called for help: "${text}"`);
  }

  /** While the next decision is being made: no standing frozen, and no looking wildly about either (a new random
   *  direction every 0.7 s was the spinning in circles): a glance now and then, or at whoever is near. */
  private async whileThinking(): Promise<void> {
    const b = this.body;
    b.halt();
    // v14: a moment to put its inventory in order (a player sorts while thinking): hotbar out of place and nothing about
    if (Date.now() - this.lastSort > 60000 && !b.hostiles(16).length && !b.phys.inWater && messiness(b) >= 2) {
      this.lastSort = Date.now();
      const r = await this.exclusive(() => organize(b));
      this.log.push(r);
    }
    const ahead = b.yaw;
    let k = 0;
    while (this.thinking && !this.reflexing && !b.dead && !b.closed) {
      b.idleLook(k++, ahead);
      await b.nextTick();
    }
  }

  /** A reflex cuts the running skill short; the site hears what it is doing now, the brain how it went. */
  private async reflex(label: string, fn: () => Promise<string>): Promise<void> {
    this.reflexing = true;
    this.reflexLabel = label;
    this.reflexCount++;
    this.body.abort = true;
    this.emit("reflex", { text: label });
    try {
      const what = await this.exclusive(async () => {
        this.body.action = label;
        return fn();
      });
      this.heard.push(what);
    } finally {
      this.body.action = "idle";
      this.reflexing = false;
    }
  }
}
