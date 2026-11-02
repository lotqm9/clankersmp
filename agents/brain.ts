// clankersmp: an AI's mind. Claude (opus, sonnet or haiku) decides what its body does next, one skill at a time, from
// what it can see, carry and hear. Every decision is one fresh request: the stable instructions and tools first
// (cached), then this moment (its state, what just happened, the chat). Its summarized thinking becomes its private
// thoughts on the site; what it says in chat is public. Reflexes (guard) step in between decisions: a monster in its
// face, hunger, a night out in the open.

import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Body, NIGHT_END, NIGHT_START, inHub, type PlanCell, type Rect, type Target } from "./body.ts";
import { SPAWN_X, SPAWN_Z } from "../shared/constants.ts";
import { HUB_R } from "../shared/hub12.ts";
import { KINDS, STAGES, UP_EXTRA, cellTarget, doorStep, faceToward, farmPlan, homeOf, itemOf, label as civLabel, maxTier, needText, planFor, progress, roadPlan, sizeFacing, wallPlan, type Building, type Kind } from "./civ.ts";
import { VILLAGE_SITES } from "../shared/villages.ts";
import { B, BLOCKS, IS_WATER, SOLID } from "../shared/blocks.ts";
import { I, ITEMS, itemDef, type Stack } from "../shared/items.ts";
import { MF, MOB_SPECS } from "../shared/mobs.ts";
import { SPECS as ANIMAL_SPECS } from "../shared/animals.ts";
import { canHarvest } from "../shared/mining.ts";
import { FLAG } from "../shared/protocol.ts";

/** What each AI is working toward and doing right now, as the others can see it (they all run in this process). */
const BOARD = new Map<string, { goal: string; doing: string }>();

/** The pack's shared plan and base: one list all three work from, one place they build up together. */
const PACK: {
  plan: string;
  by: string;
  base: { x: number; y: number; z: number } | null;
  houses: Record<string, Rect & { y: number }>;
  builds: Building[];
  trades: number;
  stage: number;
} = { plan: "", by: "", base: null, houses: {}, builds: [], trades: 0, stage: -1 };

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
/** A kind as the thing being built (the roads are one network: "the roads", not "a building joined by a path"). */
const nameOf = (k: Kind) => (k === "road" ? "the roads" : civLabel(k));
/** What a tier adds, in words. */
const upText = (k: Kind, t: number) => (k === "farm" || k === "road" ? UP_EXTRA[k][t] : KINDS[k].up[t]) ?? "";
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
  "stone_brick_slab", "stone_brick_wall", "glass_pane", "lantern", "barrel", "trapdoor",
];

const SYSTEM = (name: string) => `You are ${name}, a Claude model with a body in a hardcore survival game that plays like Minecraft. You act through the tools. Three players share this world: opus, sonnet and haiku. All three of you are Claude models.
Hardcore means one life. If you die you are out of this world for good, and the others carry on without you.
What this world is about: you three build a civilization together, from nothing. Start with a camp and grow it, stage by stage, into a capital, and see how far you can take it before the world takes you. A real town takes many hours of work: count and quality both matter, and every building can be upgraded to better tiers. The stages, each on top of the one before, are tracked for you every turn:
${STAGES.map((st) => `- ${st.name}: ${st.needs.map((n) => needText(n)).join(", ")}`).join("\n")}
Everything is built at the pack's base (the first house anyone builds becomes it). Build things with build (house, well, lamp, storehouse, market, hall, tower, wall, plaza, keep, road), farms with farm, and make any of them better with upgrade. Houses count both ways: your own home with build_house (small, it holds your bed), or a cottage with build house that anyone can build or carry on. A building takes many blocks and can be built in turns: anyone can carry on with a building another one started, so split the work. Talk it through in chat, write the pack's plan down with pack_plan, split the jobs (one gathers stone, one farms, one builds), hand each other what's needed (give) and look after each other. Every death makes the pack weaker. You still have full control: how you treat the other two is your call.

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
- Nights: sleep in your bed (sleep). The night is skipped once half of the living players are asleep at the same time, so it is over in seconds. Only without a bed: when night falls (time 12500), dig_in, and use the night to mine around you underground (collect cobblestone, coal_ore, iron_ore) with your roof kept closed.
- In the morning, or any time you are in a hole by day, dig_out right away. Never wait around in the daytime.
- If something failed, don't do the same thing again: change what you ask for, move somewhere else, or do something else first.
- With a weapon, kill what attacks you, Rattlers too (charge them: they are weak up close). Back off only when you are badly hurt. Without a weapon, keep away from monsters at night.
- Stone only drops cobblestone if you mine it with a pickaxe.
- Deep caves (below about y 30) are dark and full of Rattlers. Mine near the surface; don't go deep. If you end up underground, dig_out digs a staircase back up to the open sky from anywhere.
- Armor goes on by itself as soon as you have it.
- Chat is public. Everyone in the world sees it. Only say something when you have something to say to the others, like a question, an offer, a warning or a request. Do not narrate your own actions or plans.
- Names of blocks and items are lowercase with underscores, like oak_log, cobblestone, wooden_pickaxe, porkchop.
- Recipes you can craft: ${SURVIVAL_RECIPES.join(", ")}. Iron: mine iron_ore with a stone pickaxe, then smelt the raw_iron in a furnace (8 cobblestone) with coal, charcoal, planks or logs as fuel. Smelting raw meat cooks it, which feeds you more.`;

const TOOLS: Anthropic.Tool[] = [
  { name: "collect", description: "Find, mine and pick up blocks of one kind nearby. Logs: oak_log. Stone: cobblestone (needs a pickaxe). Also dirt, sand, coal_ore and other ores.", input_schema: { type: "object", properties: { item: { type: "string" }, count: { type: "integer", minimum: 1, maximum: 32 } }, required: ["item", "count"] } },
  { name: "craft", description: "Craft from your inventory, by recipe name. Several in one go, in order, saves time: recipe \"oak_planks x4, sticks, crafting_table, wooden_pickaxe\". Recipes bigger than 2x2 use a crafting table: a nearby one, or one you carry gets placed.", input_schema: { type: "object", properties: { recipe: { type: "string" }, count: { type: "integer", minimum: 1, maximum: 16 } }, required: ["recipe"] } },
  { name: "eat", description: "Eat the best food you carry.", input_schema: { type: "object", properties: {} } },
  { name: "attack", description: "Fight a creature or a player until it is dead or gone. target: shambler, rattler, skitter, pig, cow, sheep, chicken, or a player's name. You use your best weapon.", input_schema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] } },
  { name: "dig_in", description: "Dig straight down three blocks and close the hole over your head: safe from monsters. Use it before night.", input_schema: { type: "object", properties: {} } },
  { name: "dig_out", description: "Climb back up to the surface from anywhere underground: out of your hole, then a staircase dug up through the rock until you see the sky.", input_schema: { type: "object", properties: {} } },
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
  { name: "build", description: `Build one of the town's buildings at the pack's base, or carry on with one that is half built, needs fixing, or is an old design to rebuild: ${(Object.keys(KINDS) as (keyof typeof KINDS)[]).map((k) => `${k} (${KINDS[k].what}; ${KINDS[k].blocks[1]} blocks)`).join("; ")}; road (paths from every building's door to the plaza, dug with a shovel; build it again to reach new doors). It is one whole job: it fetches what the plan needs by itself (mines cobblestone, chops oak, crafts planks, stairs, slabs, doors and fences) and comes back to carry on, so just call build. Torches need coal. Each part is one material, the way the villages are built. A new building's front faces the middle of the town. You need to be near the base.`, input_schema: { type: "object", properties: { what: { type: "string", enum: ["house", "well", "lamp", "storehouse", "market", "hall", "tower", "wall", "plaza", "keep", "road"] } }, required: ["what"] } },
  { name: "upgrade", description: "Upgrade one of the town's buildings to its next tier (the lowest of that kind first, or carry on with one already under way): it mines out the lower-grade blocks and puts the better ones in, and adds the new details. Tier 2 is better materials and details (stone bricks: cobblestone smelted to stone and crafted; glass panes: sand smelted to glass; a chimney, furniture), tier 3 the finishing touches (lanterns: 2 iron_ingot, 2 glass_pane and a torch make 2). It smelts and crafts what it can by itself from what you carry and gather; iron you bring. The town's later stages ask for buildings at tier 2 and 3. Farms (a fence, then lanterns) and roads (paved in cobblestone) upgrade too.", input_schema: { type: "object", properties: { what: { type: "string", enum: ["house", "well", "lamp", "storehouse", "market", "hall", "tower", "wall", "plaza", "keep", "road", "farm"] } }, required: ["what"] } },
  { name: "farm", description: "Till a field beside water near the base with your hoe and plant your wheat_seeds in it: by a pond within 30 blocks of the base, or, with an empty bucket, it fills the bucket at any water and makes the field at the base. Wheat ripens in about a day.", input_schema: { type: "object", properties: {} } },
  { name: "harvest", description: "Cut the ripe wheat near you and plant the seeds straight back. 3 wheat make bread.", input_schema: { type: "object", properties: {} } },
  { name: "loot_chest", description: "Walk to the nearest chest you haven't emptied (within 48 blocks: the villages' houses, treasure on the islands) and take everything in it.", input_schema: { type: "object", properties: {} } },
  { name: "trade", description: "Trade with the nearest villager (within 24 blocks; they live in the villages). Without an offer number it walks over and tells you what they trade; with one, it makes that trade (times: how many).", input_schema: { type: "object", properties: { offer: { type: "integer", minimum: 0, maximum: 8 }, times: { type: "integer", minimum: 1, maximum: 16 } } } },
  { name: "build_house", description: "Make yourself a home: move into a finished town cottage nobody lives in (your bed goes in), or, with none free, put up a small shelter right here (about 38 cobblestone, planks or dirt: walls, a roof, a door if you have one, your bed and a torch). It becomes your home.", input_schema: { type: "object", properties: {} } },
  { name: "go_home", description: "Go back into your house and shut the door behind you (and sleep, if it's night and your bed is there).", input_schema: { type: "object", properties: {} } },
  { name: "pack_plan", description: "Write down the pack's shared plan: what the three of you are building and who does what. All three see it every turn; anyone can rewrite it as things change.", input_schema: { type: "object", properties: { plan: { type: "string" } }, required: ["plan"] } },
  { name: "go_to_base", description: "Walk back to the pack's base (the first house built becomes it).", input_schema: { type: "object", properties: {} } },
  { name: "set_goal", description: "Write down what you're working toward. It stays in front of you until you change it, and the other players can see it.", input_schema: { type: "object", properties: { goal: { type: "string" } }, required: ["goal"] } },
  { name: "note", description: "Write down something worth remembering (where things are, what someone said or did). You keep your last 10 notes.", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "follow_player", description: "Stay close to another player for a while (up to 60 seconds): to travel, work or fight alongside them.", input_schema: { type: "object", properties: { name: { type: "string" }, seconds: { type: "integer", minimum: 5, maximum: 60 } }, required: ["name"] } },
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
    // the town's timber: oak (palm makes oak planks too), never birch, so a building's wood is one colour
    town_log: [[B.OAK_LOG, B.PALM_LOG], [B.OAK_LOG, B.PALM_LOG]],
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
  private lastTidy = 0;
  /** What the running reflex is, so being shot can cut a walk short. */
  private reflexLabel = "";
  private lastEat = 0;
  private lastPlayerHit = 0;
  private lastFail = "";
  private inWaterSince = 0;
  private lastWear = 0;
  private lastHomeTrip = 0;
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
    this.emit("status", {
      under,
      health: Math.round(b.stats.hp * 10) / 10, food: b.stats.food, pos: [Math.round(b.phys.x), Math.round(b.phys.y), Math.round(b.phys.z)],
      time: b.timeOfDay(), day: (this.day || 1) - 1, held: b.heldId() ? key(b.heldId()) : null, armor, items: b.inv.filter(Boolean).length, action: b.action, dimension: "overworld",
    });
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
    const statusTimer = setInterval(() => {
      this.status();
      BOARD.set(this.name, { goal: this.goal, doing: this.body.action });
    }, 1000);
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
    lines.push(PACK.plan ? `The pack's plan (written by ${PACK.by}; anyone can rewrite it with pack_plan):
${PACK.plan}` : "The pack has no plan written down yet (pack_plan).");
    if (PACK.base) lines.push(`The pack's base: x=${PACK.base.x} z=${PACK.base.z}, ${Math.round(Math.hypot(PACK.base.x - b.phys.x, PACK.base.z - b.phys.z))} blocks ${dirWord(PACK.base.x - b.phys.x, PACK.base.z - b.phys.z)}.`);
    lines.push(this.civText());
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
      case "set_goal": return `!setGoal(${q(i.goal)})`;
      case "pack_plan": return "!packPlan";
      case "go_to_base": return "!goToBase";
      case "note": return "!note";
      case "follow_player": return `!followPlayer(${q(i.name)})`;
      case "smelt": return `!smeltItem(${q(i.item)}, ${Number(i.count) || 1})`;
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

  private async exec(name: string, i: Record<string, unknown>): Promise<string> {
    const b = this.body;
    try {
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
        case "dig_in": return await b.digIn();
        case "dig_out": return await b.digOut();
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
        case "build": return await this.buildTown(String(i.what ?? "") as Kind);
        case "upgrade": return await this.buildTown(String(i.what ?? "") as Kind, true);
        case "farm": {
          if (!PACK.base) return "the pack has no base yet: build_house first (the first house becomes the base), then farm next to it";
          const d = Math.hypot(PACK.base.x - b.phys.x, PACK.base.z - b.phys.z);
          if (d > 30) return `you're ${Math.round(d)} blocks from the base: go_to_base first, the farm goes next to it`;
          // not in a village's own fields either
          const villageLand: Rect[] = (b.world?.villages ?? []).map((k) => VILLAGE_SITES[k]).filter(Boolean).map((v) => ({ x0: v.x - 27, z0: v.z - 27, x1: v.x + 27, z1: v.z + 27 }));
          const r = await b.makeFarm(PACK.base.x, PACK.base.z, PACK.base.y, [...footprints(), ...villageLand]);
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
          const r = await b.trade(o, Math.max(1, Math.min(16, Number(i.times) || 1)));
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
          const ok = await b.goto(PACK.base.x + 0.5, PACK.base.y, PACK.base.z + 0.5, 4, { maxMs: 90000 });
          return ok ? "you're at the pack's base" : `you couldn't get all the way to the base (${Math.round(Math.hypot(PACK.base.x - b.phys.x, PACK.base.z - b.phys.z))} blocks left)`;
        }
        case "go_home": return await b.goHome();
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

  private async collect(item: string, count: number): Promise<string> {
    const b = this.body;
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
    const trees = plan.blocks.some((id) => BLOCKS[id]?.key?.endsWith("_log"));
    // stone comes out of the ground away from the town: never the town's own walls (the nearest "cobblestone" was
    // the town hall's, so they took its lower walls apart for a house), and never a village's houses
    const stone = plan.blocks.includes(B.STONE);
    // out of the spawn hub, or out of the town, before mining stone
    const away = inHub(b.phys.x, b.phys.z) || !PACK.base
      ? { x: SPAWN_X, z: SPAWN_Z, r: HUB_R + 14, y: b.world?.info.spawnHeight ?? Math.floor(b.phys.y), what: "the spawn hub" }
      : { x: PACK.base.x, z: PACK.base.z, r: 20, y: PACK.base.y, what: "the town" };
    if (stone && offLimits(b.phys.x, b.phys.z)) {
      // out on the ground, not through the rock: in a tunnel under the town it stood still for 3 minutes aiming at a
      // spot 20 blocks out at its own depth (opus)
      if (b.phys.y < away.y - 3) {
        b.action = `climbing up out of the tunnel`;
        await b.digOut();
      }
      // out along its own direction until the ground is free: 20 blocks out from the base was the storehouse opus was
      // building, still "the town", so it never left
      const a = Math.atan2(b.phys.z - away.z, b.phys.x - away.x);
      let r = Math.max(away.r, Math.hypot(b.phys.x - away.x, b.phys.z - away.z) + 6);
      while (r < away.r + 48 && offLimits(away.x + Math.cos(a) * r, away.z + Math.sin(a) * r)) r += 6;
      const tx = Math.floor(away.x + Math.cos(a) * r);
      const tz = Math.floor(away.z + Math.sin(a) * r);
      const g = b.groundAt(tx, tz, away.y);
      b.action = `walking out of ${away.what} to mine`;
      await b.goto(tx + 0.5, g >= 0 ? g + 1 : away.y, tz + 0.5, 3, { maxMs: 30000 });
      if (offLimits(b.phys.x, b.phys.z)) return `couldn't get out of ${away.what} to mine stone (stone never comes out of ${away.what}'s ground): walk out a little further (explore), then collect`;
    }
    while (!b.abort && !b.dead && have() - start < count && Date.now() - t0 < 90000) {
      // nothing deep: the deep caves are where Rattlers wait in the dark
      const floor = Math.max(30, Math.floor(b.phys.y) - 8);
      // and nothing touching water: breaking it lets the water flood in on top of you
      const wet = (x: number, y: number, z: number) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => IS_WATER[b.get(x + dx, y + dy, z + dz)] === 1);
      let found = b.findBlocks(plan.blocks, 32, soft ? 4000 : stone ? 400 : 16).filter(([x, y, z]) => y >= floor && !wet(x, y, z) && !skip.has(x + z * 512 + y * 262144));
      if (stone) found = found.filter(([x, , z]) => !offLimits(x, z)).slice(0, 16);
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
        if (!found.length) return have() - start > 0 ? `got ${have() - start} of ${count} ${item} (no more open ground away from the town nearby: explore a little and collect again)` : `no ${item} away from the town and the villages within 32 blocks: walk out a bit (explore) and collect there`;
      }
      // stone that isn't lying open at its feet: mine down a staircase like a player, not a shaft
      if (plan.blocks.includes(B.STONE) && (!found.length || found[0][1] < b.phys.y - 2 || skip.size >= 2)) {
        if (!b.bestToolFor(B.STONE) || !canHarvest(B.STONE, b.bestToolFor(B.STONE))) return "stone needs a pickaxe: craft a wooden_pickaxe first";
        const r = await b.stairMine(plan.gets, count - (have() - start));
        tried++;
        if (have() - start >= count || /water/.test(r)) return r;
        skip.add(-1);
        if (skip.size > 3) return r;
        continue;
      }
      // nothing in 32 blocks, and it's wood: every oak round the town was cut down (the town is built of oak, so a
      // house wants 20+ logs), so go on a logging trip to the nearest grove, out to 64 blocks and then to 160, and cut
      // there with the time starting again. Trees only: an ore 50 blocks off is inside the rock, and walking at one
      // left sonnet standing still for 3 minutes "walking out to find coal_ore"
      if (!found.length && trees && trips < 2) {
        trips++;
        const grove = b.findGrove(plan.blocks, trips === 1 ? 64 : 160, (gx, gz) => theirs(gx, gz));
        if (grove) {
          const far = Math.round(Math.hypot(grove[0] - b.phys.x, grove[2] - b.phys.z));
          b.action = `going on a logging trip for ${item}, ${far} blocks out`;
          await b.goto(grove[0] + 0.5, grove[1], grove[2] + 0.5, 4, { maxMs: trips === 1 ? 40000 : 120000 });
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
      const ok = await b.mine(x, y, z);
      if (!ok) skip.add(x + z * 512 + y * 262144);
      else await b.pickUp(5, 5000);
      if (tried > count * 3 + 6) break;
    }
    const got = have() - start;
    if (got >= count) return `got ${got} ${item}`;
    if (!tried) return `no ${item} within 32 blocks${plan.blocks.includes(B.STONE) ? " (dig_down to reach stone)" : " (explore to find some)"}`;
    return `got ${got} of ${count} ${item}`;
  }

  // ---------------------------------------------------------------- the civilization

  /** The middle of the town, where the roads lead and the buildings face: the plaza, else the well, else the base. */
  private hub(): { x: number; z: number } {
    const base = PACK.base!;
    const p = PACK.builds.find((x) => x.kind === "plaza") ?? PACK.builds.find((x) => x.kind === "well");
    return p ? { x: Math.floor((p.x0 + p.x1) / 2), z: Math.floor((p.z0 + p.z1) / 2) } : { x: base.x, z: base.z };
  }

  /** A building's plan at a tier, whatever its kind (the wall, the roads and the farms have their own). */
  private planOf(site: Building, tier: number): { cells: PlanCell[]; of?: number[] } {
    const b = this.body;
    const base = PACK.base!;
    if (site.kind === "wall") {
      // never through a building, and a gap where a road crosses it
      const lots = PACK.builds.filter((x) => x.kind !== "wall" && x.kind !== "road" && x.kind !== "farm");
      const road = PACK.builds.find((x) => x.kind === "road");
      const paths = new Set(road ? this.planOf(road, 1).cells.map(([x, , z]) => `${x},${z}`) : []);
      const skip = (x: number, z: number) => paths.has(`${x},${z}`) || lots.some((r) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1);
      return { cells: wallPlan(Math.floor((site.x0 + site.x1) / 2), Math.floor((site.z0 + site.z1) / 2), Math.floor((site.x1 - site.x0) / 2), (x, z) => b.landAt(x, z, base.y), tier, skip) };
    }
    if (site.kind === "road") return roadPlan(this.hub(), PACK.builds.filter((x) => x.done || x === site), (x, z) => b.pathAt(x, z, base.y), tier);
    if (site.kind === "farm") return { cells: farmPlan(site, tier, this.hub(), (x, z) => b.landAt(x, z, base.y)) };
    return { cells: planFor(site, tier, (x, z) => b.naturalGround(x, z, base.y)) };
  }

  /** How far a building is built up: the highest tier whose plan it meets (a few blocks short is fine: a torch
   *  knocked off, one cell nobody can reach), 0 for an old building that doesn't meet tier 1. */
  private measure(site: Building): number {
    const b = this.body;
    if (site.kind === "road") {
      const [, paved, all] = this.roadCount(site);
      return all > 0 && paved >= all ? 2 : 1;
    }
    for (let t = maxTier(site.kind); t >= 1; t--) {
      if (site.kind === "farm" && t === 1) return 1; // a farm is a farm once its field is planted
      const req = this.planOf(site, t).cells.filter(([, , , k]) => !cellTarget(k)?.optional && k !== "?p");
      const bad = req.filter((c) => b.needsWork(c)).length;
      if (bad <= Math.floor(req.length * (site.kind === "wall" ? 0.06 : 0.03))) return t;
    }
    return 0;
  }

  /** How many buildings the roads join to the middle of the town: [any path, paved, buildings with a door]. */
  private roadCount(road: Building): [number, number, number] {
    const b = this.body;
    const builds = PACK.builds.filter((x) => x.done || x === road);
    const p1 = roadPlan(this.hub(), builds, (x, z) => b.pathAt(x, z, PACK.base!.y), 1);
    const p2 = roadPlan(this.hub(), builds, (x, z) => b.pathAt(x, z, PACK.base!.y), 2);
    const doors = builds.map((x, i) => (doorStep(x) && x.kind !== "lamp" ? i : -1)).filter((i) => i >= 0);
    const joined = (p: { cells: PlanCell[]; of: number[] }) => doors.filter((i) => p.cells.every((c, k) => p.of[k] !== i || !b.needsWork(c))).length;
    return [joined(p1), joined(p2), doors.length];
  }

  /** One of the town's buildings at the base: a new one, the next blocks of one that's half built or needs fixing,
   *  or (upgrade) the next tier of one that stands. One whole job: it fetches and makes what the plan needs. */
  private async buildTown(kind: Kind, upgrade = false): Promise<string> {
    const b = this.body;
    const all: Kind[] = ["house", "well", "lamp", "storehouse", "market", "hall", "tower", "wall", "plaza", "keep", "road", "farm"];
    if (!all.includes(kind)) return `there is no "${kind}" to build: ${all.join(", ")}`;
    if (!PACK.base) return "the pack has no base yet: the first house anyone builds becomes it (build_house)";
    if (kind === "farm" && !upgrade) return "farms are made with farm (a hoe and wheat_seeds, beside water); upgrade farm puts a fence round one";
    const base = PACK.base;
    const far = Math.hypot(base.x - b.phys.x, base.z - b.phys.z);
    if (far > 40) return `you're ${Math.round(far)} blocks from the base: go_to_base first`;
    this.auditTown();
    const where = (s: Rect) => `x=${Math.round((s.x0 + s.x1) / 2)} z=${Math.round((s.z0 + s.z1) / 2)}`;
    const others = (s: Building) => !!s.busy && s.busy.by !== this.name && Date.now() - s.busy.at < 45000 && !!BOARD.get(s.busy.by);
    let site: Building | undefined;
    let tier = 1;
    if (upgrade) {
      // the lowest of that kind first (one already being upgraded before any other), the nearest of those
      const can = PACK.builds.filter((x) => x.kind === kind && x.done && !isHome(x) && tierOf(x) >= 1 && tierOf(x) < maxTier(kind) && !others(x));
      can.sort((p, q) => (q.up ? 1 : 0) - (p.up ? 1 : 0) || tierOf(p) - tierOf(q) || Math.hypot((p.x0 + p.x1) / 2 - b.phys.x, (p.z0 + p.z1) / 2 - b.phys.z) - Math.hypot((q.x0 + q.x1) / 2 - b.phys.x, (q.z0 + q.z1) / 2 - b.phys.z));
      site = can[0];
      if (!site) {
        const some = PACK.builds.filter((x) => x.kind === kind && !isHome(x));
        if (!some.length) return `there is no ${nameOf(kind)} to upgrade yet: build one first`;
        if (some.every((x) => tierOf(x) >= maxTier(kind))) return `every ${nameOf(kind).replace(/^an? |^the /, "")} is at tier ${maxTier(kind)}, the top: ${this.nextWork()}`;
        if (some.some((x) => !x.done || tierOf(x) < 1)) return `the ${civLabel(kind, 2)} there are aren't finished (or are old ones that don't meet the tier 1 design): build ${kind} first, then upgrade`;
        return `someone else is working on the ${civLabel(kind, 2)} right now: ${this.nextWork()}`;
      }
      tier = site.up ?? tierOf(site) + 1;
      site.up = tier;
    } else {
      // (the roads are one network: building them again carries them on to every new door)
      site = PACK.builds.find((x) => x.kind === kind && !isHome(x) && (!x.done || x.fix || tierOf(x) < 1 || kind === "road"));
      if (!site) {
        const most = Math.max(0, ...STAGES.flatMap((st) => st.needs.filter(([k]) => k === kind).map(([, n]) => n)));
        const final = progress(civCount).next === null;
        const once = kind === "wall" || kind === "road" || kind === "plaza" || kind === "keep";
        if (once && PACK.builds.some((x) => x.kind === kind)) return `${nameOf(kind)} is already built: upgrade ${kind} to make it better, or ${this.nextWork()}`;
        if (!final && most && civCount(kind, 1) >= most) return `the town already has all the ${civLabel(kind, 2)} it needs (${civCount(kind, 1)}): ${this.nextWork()}`;
        const hub = this.hub();
        if (kind === "wall") site = { kind, x0: base.x - 13, z0: base.z - 13, x1: base.x + 13, z1: base.z + 13, y: base.y, by: [], done: false, at: Date.now(), face: 0 };
        else if (kind === "road") site = { kind, x0: hub.x, z0: hub.z, x1: hub.x, z1: hub.z, y: base.y, by: [], done: false, at: Date.now() };
        else {
          const spot = this.townSite(kind as Exclude<Kind, "farm" | "road" | "wall">);
          if (typeof spot === "string") return spot;
          site = { kind, ...spot, by: [], done: false, at: Date.now() };
        }
        PACK.builds.push(site);
        savePack();
      }
      // a fix goes back to the best tier it had; a new one, or an old design rebuilt, to tier 1
      tier = site.fix ? Math.max(1, site.best ?? 1) : site.done && tierOf(site) >= 1 ? tierOf(site) : 1;
    }
    const s = site;
    if (others(s)) return `${s.busy!.by} is working on ${nameOf(kind)} right now: help another way (bring them blocks with give, build something else, or gather what the next stage needs)`;
    s.busy = { by: this.name, at: Date.now() };
    if (!s.by.includes(this.name)) s.by.push(this.name);
    const what = `${nameOf(kind)}${tier > 1 ? ` (tier ${tier})` : ""}`;
    const cells = this.planOf(s, tier).cells;
    if (kind === "road" && !cells.length) {
      s.busy = undefined;
      if (!s.done) PACK.builds = PACK.builds.filter((x) => x !== s);
      savePack();
      return "no paths to make yet: the roads join buildings with doors to the plaza (build houses, the plaza, a storehouse first)";
    }
    // stand in the middle and build round itself, the way a player does: everything in a small building is in reach
    // from there, so it doesn't circle the building for every block (not the tower: in its hollow it can't reach out)
    const toMiddle = async () => {
      if (kind === "wall" || kind === "lamp" || kind === "tower" || kind === "road" || kind === "farm") return;
      const sx = Math.floor((s.x0 + s.x1) / 2);
      const sz = Math.floor((s.z0 + s.z1) / 2);
      if (Math.hypot(sx + 0.5 - b.phys.x, sz + 0.5 - b.phys.z) > 1.2) await b.goto(sx + 0.5, s.y, sz + 0.5, 0.8, { maxMs: 30000 });
    };
    const req = cells.filter(([, , , k]) => !cellTarget(k)?.optional && k !== "?p");
    // paths are dug with a shovel: make one if it has none (a stone one from a cobblestone and two sticks)
    if (cells.some(([, , , k]) => k === "p" || k === "?p") && !b.inv.some((st) => st && itemDef(st.id)?.tool?.kind === "shovel")) {
      if (!b.has(I.STICK, 2)) await b.craft(b.has(B.OAK_PLANKS, 2) ? "sticks" : "oak_planks", 1);
      if (!b.has(I.STICK, 2)) await b.craft("sticks", 1);
      if (!(b.has(B.COBBLESTONE) && (await b.craft("stone_shovel", 1)).made)) await b.craft("wooden_shovel", 1);
    }
    const left = () => req.filter((c) => b.needsWork(c)).length;
    // one job, start to finish: short of something, it goes and gets it (mines stone, chops oak, smelts, crafts the
    // stairs and the door), comes back to the middle and carries on; it only hands back when the building is up, the
    // time is up, or something it can't get by itself is missing
    const deadline = Date.now() + 6 * 60000;
    let r: Awaited<ReturnType<typeof b.buildCells>> = { placed: 0, left: left(), outOf: false, why: "", short: new Map() };
    let placed = 0;
    const lacking = new Set<string>();
    let first = true;
    for (let round = 0; round < 8 && !b.abort && !b.dead && Date.now() < deadline && left() > 0; round++) {
      s.busy = { by: this.name, at: Date.now() };
      const need = this.billOf(cells);
      if (need.size) {
        const before = placed;
        const got = await this.supply(need, kind, first);
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
      r = await b.buildCells(cells, kind === "wall" || kind === "road" ? 64 : 120, `${upgrade ? "upgrading" : "building"} ${what}`, s.y);
      placed += r.placed;
      if (!r.placed && !r.outOf) break; // in the way or out of reach: more blocks won't help
      if (!r.placed && r.outOf && !this.billOf(cells).size) break;
    }
    s.busy = undefined;
    const missing = left();
    const short = [...this.billOf(cells)].map(([id, n]) => `${n} ${key(id)}`);
    if (missing <= Math.floor(req.length * (kind === "wall" ? 0.06 : 0.03))) {
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
      return `${upgrade ? `upgraded ${nameOf(kind)} at ${where(s)} to tier ${tier}` : `finished ${what} at ${where(s)}`} (${placed} blocks placed). ${tier < maxTier(kind) ? `It can go to tier ${tier + 1}: ${upText(kind, tier + 1)} (upgrade ${kind}).` : ""}`;
    }
    // a spot where nothing will go in, turn after turn (on a roof, walled off, out of reach): give up on it, so the
    // next build picks a better one instead of everyone trying the same blocks forever
    s.stuck = placed ? 0 : (s.stuck ?? 0) + 1;
    if (!upgrade && s.stuck >= 3 && !r.outOf && !s.done && kind !== "wall" && kind !== "road") {
      PACK.builds = PACK.builds.filter((x) => x !== s);
      savePack();
      return `gave up on ${nameOf(kind)} at ${where(s)}: nothing would go in there three times (${r.why || "a bad spot"}). build it again and a better spot gets picked`;
    }
    savePack();
    const still = short.length ? ` Still needed: ${short.join(", ")}${lacking.size ? ` (${[...lacking].join("; ")})` : ""}.` : "";
    if (!placed) return `couldn't ${upgrade ? "upgrade" : "build"} ${what} at ${where(s)}: ${r.outOf ? "out of materials" : r.why || "in the way, or out of reach"}; ${missing} blocks to go.${still}`;
    return `placed ${placed} blocks on ${what} at ${where(s)}: ${missing} to go.${still}`;
  }

  /** A spot for a new building near the base: flat open ground clear of the rest of the town and the villages, its
   *  front turned to the middle of the town. A lamp post goes beside a road when there are roads to light. */
  private townSite(kind: Exclude<Kind, "farm" | "road" | "wall">): { x0: number; z0: number; x1: number; z1: number; y: number; face: number } | string {
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
            if (onRoad.has(`${px},${pz}`) || fp.some((r) => px >= r.x0 - 1 && px <= r.x1 + 1 && pz >= r.z0 - 1 && pz <= r.z1 + 1)) continue;
            if (lamps.some((l) => Math.hypot(l.x0 - px, l.z0 - pz) < 7)) continue;
            const g = b.naturalGround(px, pz, base.y);
            if (g < 0 || SOLID[b.get(px, g + 1, pz)] || SOLID[b.get(px, g + 2, pz)]) continue;
            spots.push([px, g + 1, pz]);
          }
        spots.sort((p, q) => Math.hypot(p[0] - hub.x, p[2] - hub.z) - Math.hypot(q[0] - hub.x, q[2] - hub.z));
        if (spots.length) return { x0: spots[0][0], z0: spots[0][2], x1: spots[0][0], z1: spots[0][2], y: spots[0][1], face: 0 };
      }
      // (off the roads too: never two side by side, a lamp every seven blocks or so)
      const apart = lamps.map((l) => ({ x0: l.x0 - 5, z0: l.z0 - 5, x1: l.x1 + 5, z1: l.z1 + 5 }));
      const spot = b.siteNear(base.x, base.z, base.y, 1, 1, [...footprints(), ...apart], 24, 2, 2);
      return spot ? { x0: spot.x0, z0: spot.z0, x1: spot.x0, z1: spot.z0, y: spot.y, face: 0 } : "no open spot near the base for a lamp post: clear some trees near the base";
    }
    const [w, d] = KINDS[kind].size;
    const big = w * d >= 80;
    // the plaza goes right by the middle; the rest anywhere round it, the big ones further out on a little slope, and
    // further out still, step by step, when the town is crowded (sonnet walked round and round a full base looking
    // for flat ground for a watchtower)
    const near = kind === "plaza" ? 0 : 4;
    const steps: [number, number][] = kind === "plaza" ? [[16, 2], [24, 3]] : big ? [[40, 3], [52, 3]] : [[30, 2], [40, 3], [52, 3]];
    for (const [far, slope] of steps)
      for (const [sw, sd] of w === d ? [[w, d]] : [[w, d], [d, w]]) {
        const spot = b.siteNear(base.x, base.z, base.y, sw, sd, [...footprints(), ...villages], far, near, slope);
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
    const LOGS = -1; // oak or palm logs (both make oak planks)
    const FUEL = -2; // coal or charcoal
    // (the oak logs the posts take aren't there for planks)
    const count = (id: number) => (id === LOGS ? Math.max(0, b.count(B.OAK_LOG) - (need.get(B.OAK_LOG) ?? 0)) + b.count(B.PALM_LOG) : id === FUEL ? b.count(I.COAL) + b.count(I.CHARCOAL) : b.count(id));
    // what is made from what: [recipe, how many one craft makes, ingredients]; smelted: [from]
    const MAKE = new Map<number, { rid: string; out: number; ings: [number, number][] } | { from: number }>([
      [B.LANTERN, { rid: "lantern", out: 2, ings: [[I.IRON_INGOT, 2], [B.GLASS_PANE, 2], [B.TORCH, 1]] }],
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
    ]);
    const ORDER = [...MAKE.keys()];
    const RAW = [B.COBBLESTONE, LOGS, B.OAK_LOG, B.SAND, I.RAW_IRON, FUEL];
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
    const list = PACK.builds.filter((x) => x.done && !isHome(x) && tierOf(x) >= 1 && tierOf(x) < maxTier(x.kind)).sort((p, q) => tierOf(p) - tierOf(q));
    for (const x of list) {
      if (seen.has(x.kind)) continue;
      seen.add(x.kind);
      const t = tierOf(x);
      out.push({ kind: x.kind, t, text: `${nameOf(x.kind)} at x=${Math.round((x.x0 + x.x1) / 2)} z=${Math.round((x.z0 + x.z1) / 2)}, tier ${t} to ${t + 1}: ${upText(x.kind, t + 1)}` });
    }
    return out.sort((p, q) => p.t - q.t);
  }

  /** Where the pack's civilization stands, what it has built, what the next stage needs, and always something to do. */
  private civText(): string {
    const pr = progress(civCount);
    const kinds: Kind[] = ["house", "farm", "well", "lamp", "storehouse", "market", "hall", "tower", "wall", "plaza", "keep"];
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
    const kinds: Kind[] = ["house", "farm", "well", "lamp", "storehouse", "market", "hall", "tower", "wall", "plaza", "keep", "road"];
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
      if (ANIMAL_SPECS[a.kind]?.key !== n) continue;
      const d = b.distTo(a.x, a.y, a.z);
      if (d < bd) [bd, best] = [d, { kind: "animal", id: a.id }];
    }
    return best;
  }

  private async attack(name: string): Promise<string> {
    const t = this.findTarget(name);
    if (!t) return `no ${name} nearby`;
    const res = await this.body.fight(t, 30000);
    await this.body.pickUp(5, 4000);
    return `${name}: ${res}`;
  }

  private async give(player: string, item: string, count: number): Promise<string> {
    const b = this.body;
    const id = itemByName(item);
    if (!id || !b.has(id)) return `you don't have ${item}`;
    const o = [...b.others.values()].find((p) => p.name === player.toLowerCase());
    if (!o) return `${player} isn't in the world`;
    await b.goto(o.x, o.y, o.z, 2.5, { maxMs: 45000, done: () => { const q = b.others.get(o.id); return !!q && Math.hypot(q.x - b.phys.x, q.z - b.phys.z) < 3; } });
    const q = b.others.get(o.id);
    if (!q || Math.hypot(q.x - b.phys.x, q.z - b.phys.z) > 4) return `couldn't get to ${player}`;
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

  // ---------------------------------------------------------------- reflexes

  private async guard(): Promise<void> {
    const b = this.body;
    // shot at in the middle of a walk (home, or out to build before dark): drop the walk so the archer gets dealt
    // with. A reflex used to run to its end first, and sonnet and haiku were both shot dead walking home at dusk
    if (this.reflexing && !/rattler|fight|running|dig|wall|hurt|water/.test(this.reflexLabel) && Date.now() - b.lastHurt.at < 1500 && b.hostiles(16).some((m) => m.key === "rattler")) b.abort = true;
    if (this.reflexing || this.stopped || b.dead || b.closed) return;
    const h = b.hostiles(6)[0];
    const hurtRecently = Date.now() - b.lastHurt.at < 2000;
    // armour it carries goes on (the server swaps each better piece in), checked every few seconds
    if (Date.now() - this.lastWear > 4000) {
      this.lastWear = Date.now();
      const better = b.inv.some((s) => {
        const a = s ? itemDef(s.id)?.armor : undefined;
        const cur = a ? b.armor[a.slot] : null;
        return !!a && (!cur || (itemDef(cur.id)?.armor?.points ?? 0) < a.points);
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
    // an archer shooting from range: running in the open doesn't help. Go for it with a weapon and health to spare,
    // else dig in (arrows can't reach into a sealed hole).
    if (hurtRecently && b.lastHurt.cause === "mob:rattler" && !b.sealed()) {
      b.lastHurt.at = 0;
      const r = b.hostiles(20).find((m) => m.key === "rattler");
      // with a weapon and the health for it: go and kill it (archers are weak up close), backing off once badly hurt.
      // At night only a close one with nothing else around, and never a chase out into the dark (haiku left its hole
      // at night to chase one 23 blocks past two shamblers, and died)
      const night = b.isNight();
      const others = r ? b.hostiles(14).filter((m) => m.id !== r.id).length : 0;
      // in iron with an iron sword it goes after it even at night, with a monster or two about
      const strong = b.strong();
      const careful = night && !strong;
      // only armoured agents chase one: it backs off and keeps shooting, and all three of season 7 died chasing
      // rattlers (opus in the shade at midday, in nothing but an iron helmet). Without armour, hit one only if it's
      // right there; otherwise take cover
      const chase = strong ? r && r.d < 14 && b.stats.hp >= 8 && others <= 2 : r && r.d < 3.5 && b.stats.hp >= 14 && others === 0 && !careful;
      if (r && chase && b.bestWeapon()) {
        let res = "";
        await this.reflex("going after a rattler", async () => {
          res = await b.fight({ kind: "mob", id: r.id }, 20000, strong ? 5 : 6, careful ? 8 : 14);
          return `A rattler was shooting at you and you went for it (${res}).`;
        });
        if (/backed off/.test(res) && !b.dead && !b.sealed()) await this.reflex("hurt, digging in away from the rattler", async () => `You were badly hurt fighting a rattler, so you dug in: ${await b.digIn()}.`);
      } else await this.reflex("digging in, a rattler is shooting", async () => `A rattler was shooting at you${b.bestWeapon() ? " and you were too hurt to fight it" : " and you had no weapon"}, so you dug in: ${await b.digIn()}.`);
      return;
    }
    // a monster in its face: fight it (with a weapon or health to spare), else run; badly hurt in a tunnel there is
    // nowhere to run (sonnet died fighting and fleeing in turns down a one-wide staircase). Wall it off if a block or
    // two closes the tunnel; otherwise fight it out. Digging in with it at arm's length is death: it drops into the
    // hole too, and three blocks down takes seconds of its hits (opus died two seconds into it, 11/2; on the test
    // server at 7 health, a stone sword and no armour, digging in and walling off in the open died every time, and
    // standing to fight lived)
    // (not one it just fought without getting anywhere: a shambler right outside sonnet's wall was in reach but behind
    // the blocks, and it swung at the wall for 3 minutes, a 15 s fight at a time; at home it's safe, so leave it)
    if (h && (h.d < 3.2 || (hurtRecently && h.d < 6)) && !b.sealed() && !((this.leftAlone.get(h.id) ?? 0) > Date.now() && !hurtRecently)) {
      const armed = !!b.bestWeapon();
      const strong = b.strong();
      // underground: under a roof that isn't one of the town's buildings (inside a cottage the roof counts as "covered",
      // and haiku fought a shambler to the end in the house it had just moved into, 11/2). And the no-backing-off
      // fight is only for one monster: against two, keep the bail and run
      const indoors = footprints().some((r) => b.phys.x >= r.x0 && b.phys.x <= r.x1 + 1 && b.phys.z >= r.z0 && b.phys.z <= r.z1 + 1);
      const below = b.covered() && !indoors && b.hostiles(10).length <= 1;
      if (b.stats.hp < (strong ? 5 : 8) && below && b.canWallOff()) {
        await this.reflex(`badly hurt underground, walling itself in`, async () => `A ${h.key} had you badly hurt underground, so you walled it off to heal: ${await b.wallOff()}.`);
        if (!b.sealed() && !b.dead) await this.reflex(`fighting a ${h.key}, cornered`, async () => `You couldn't wall the ${h.key} off, so you fought it (${await b.fight({ kind: "mob", id: h.id }, 15000)}).`);
        return;
      }
      if ((h.key === "rattler" && !armed && h.d > 3) || (!armed && b.stats.hp < 8)) {
        await this.reflex(`running from a ${h.key}`, async () => {
          await b.flee(h.x, h.z, 90);
          return `A ${h.key} came at you${armed ? "" : " and you had no weapon"}, so you ran.`;
        });
      } else {
        // fight it, but not to the death: badly hurt, it breaks off and runs (shamblers are slow; opus fought one from
        // 20 health to 0 without stopping)
        // underground with no quick wall to put up, no backing off: there's nowhere to go
        let res = "";
        await this.reflex(`fighting a ${h.key}`, async () => {
          res = await b.fight({ kind: "mob", id: h.id }, 15000, below && !b.canWallOff() ? 0 : strong ? 5 : 7);
          return `A ${h.key} attacked you and you fought it (${res}).`;
        });
        if (/ran out of time|couldn't get to it|out of reach/.test(res)) this.leftAlone.set(h.id, Date.now() + 60000);
        if (/backed off/.test(res) && !b.dead && b.covered()) {
          await this.reflex(`badly hurt underground, walling itself in`, async () => `You were badly hurt fighting a ${h.key} underground, so you walled it off to heal: ${await b.wallOff()}.`);
          if (!b.sealed() && !b.dead) await this.reflex(`fighting a ${h.key}, cornered`, async () => `You couldn't wall the ${h.key} off, so you fought it (${await b.fight({ kind: "mob", id: h.id }, 15000)}).`);
        } else if (/backed off/.test(res) && !b.dead) {
          await this.reflex(`running from a ${h.key}, badly hurt`, async () => {
            await b.flee(h.x, h.z, 140);
            return `You were badly hurt fighting a ${h.key}, so you broke off and ran.`;
          });
        }
      }
      return;
    }
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
    if (b.stats.food <= 8 && Date.now() - this.lastEat > 10000 && b.inv.some((s) => s && itemDef(s.id)?.food && !itemDef(s.id)?.food?.queasy)) {
      this.lastEat = Date.now();
      await this.reflex("eating", async () => `You were starving, so you ate: ${await b.eat()}.`);
      return;
    }
    // dusk with a house: home before dark (and to bed). Not out of a sealed hole (safe there till morning), not
    // in the middle of digging in or out (it cut dig_out short every minute and left haiku in the rock all night),
    // and not a long walk through the dark once night has fallen
    const tod = b.timeOfDay();
    const homeFar = b.home ? Math.hypot(b.homeMiddle()[0] - b.phys.x, b.homeMiddle()[1] - b.phys.z) : 0;
    // a long way out in the late afternoon: start back now, while there's daylight for the walk (opus went 190 blocks
    // after sheep and was still out there at dusk, in a marsh where it couldn't dig in)
    if (b.home && homeFar > 45 && tod >= 9000 && tod < 11600 && Date.now() - this.lastHomeTrip > 60000 && !/home|bed|asleep/.test(b.action)
      && !b.sealed() && !["dig_out", "dig_in", "go_home", "sleep", "build_house"].includes(this.skill)) {
      this.lastHomeTrip = Date.now();
      await this.reflex("heading home before dark, it's a long walk", async () => `You were ${Math.round(homeFar)} blocks from home late in the afternoon, so you started back before dark: ${await b.goHome()}.`);
      return;
    }
    if (b.home && !b.atHome() && tod >= 11600 && tod < 23000 && Date.now() - this.lastHomeTrip > 60000 && !/home|bed|asleep/.test(b.action)
      && !b.sealed() && !["dig_out", "dig_in", "go_home", "sleep", "build_house"].includes(this.skill) && (!b.isNight() || homeFar < 40)
      && Date.now() - b.homeFailAt > 5 * 60000) {
      this.lastHomeTrip = Date.now();
      await this.reflex("heading home for the night", async () => `It was getting dark, so you went home: ${await b.goHome()}.`);
      return;
    }
    // late afternoon with no house but the blocks for one: build it now at the base, so night finds it indoors with
    // its bed (beds go in houses, not holes)
    if (!b.home && tod >= 10200 && tod < 11900 && b.buildingBlocks().n >= 38 && Date.now() - this.lastHouseTry > 120000 && !/build|house/.test(b.action)) {
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
        else await this.reflex("digging in for the night", async () => `Night caught you in the open, so you dug in: ${await b.digIn()}.`);
      }
    } else this.nightOutSince = 0;
  }

  /** While the next decision is being made: no standing frozen. It looks at whoever is near, or looks around. */
  private async whileThinking(): Promise<void> {
    const b = this.body;
    b.halt();
    let k = 0;
    while (this.thinking && !this.reflexing && !b.dead && !b.closed) {
      if (k % 14 === 0) {
        const near = [...b.others.values()].filter((o) => !(o.flags & FLAG.DEAD)).map((o) => ({ o, d: b.distTo(o.x, o.y, o.z) })).sort((p, q) => p.d - q.d)[0];
        if (near && near.d < 14) b.look(near.o.x, near.o.y + 1.5, near.o.z);
        else {
          const a = Math.random() * Math.PI * 2;
          b.look(b.phys.x + Math.sin(a) * 6, b.phys.y + 1.2, b.phys.z + Math.cos(a) * 6);
        }
      }
      k++;
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
