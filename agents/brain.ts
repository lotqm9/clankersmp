// clankersmp: an AI's mind. Claude (opus, sonnet or haiku) decides what its body does next, one skill at a time, from
// what it can see, carry and hear. Every decision is one fresh request: the stable instructions and tools first
// (cached), then this moment (its state, what just happened, the chat). Its summarized thinking becomes its private
// thoughts on the site; what it says in chat is public. Reflexes (guard) step in between decisions: a monster in its
// face, hunger, a night out in the open.

import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Body, NIGHT_END, NIGHT_START, type Rect, type Target } from "./body.ts";
import { KINDS, STAGES, label as civLabel, planFor, progress, wallPlan, type Building, type Kind } from "./civ.ts";
import { VILLAGE_SITES } from "../shared/villages.ts";
import { B, BLOCKS, IS_WATER, SOLID } from "../shared/blocks.ts";
import { ITEMS, itemDef, type Stack } from "../shared/items.ts";
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
/** How many of a kind the pack has finished (the wall: 1 once it's done). */
function civCount(k: Kind | "trade"): number {
  if (k === "trade") return PACK.trades;
  if (k === "house") return houseRects().filter((h) => h.done).length; // homes (build_house) and finished cottages (build)
  return PACK.builds.filter((b) => b.kind === k && b.done).length;
}
/** Everything built or being built: where new buildings must not go. */
let lastAudit = 0;
function footprints(): Rect[] {
  return [...houseRects(), ...PACK.builds.filter((b) => b.kind !== "house").map((b) => (b.kind === "wall" ? { x0: b.x0 + 1, z0: b.z0 + 1, x1: b.x0 + 1, z1: b.z0 + 1 } : b))];
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
];

const SYSTEM = (name: string) => `You are ${name}, a Claude model with a body in a hardcore survival game that plays like Minecraft. You act through the tools. Three players share this world: opus, sonnet and haiku. All three of you are Claude models.
Hardcore means one life. If you die you are out of this world for good, and the others carry on without you.
What this world is about: you three build a civilization together, from nothing. Start with a camp, grow it into a settlement, a village, a town and finally a city, and see how far you can take it before the world takes you. The stages are tracked for you every turn:
- a camp: a house at the pack's base
- a settlement: 3 houses, a farm, a well
- a village: 6 lamp posts, a storehouse, 2 farms, a wall round the base
- a town: a town hall, a market, a watchtower, 5 trades with the villagers
- a city: 6 houses, 4 farms, 16 lamp posts, 2 watchtowers
Everything is built at the pack's base (the first house anyone builds becomes it). Build things with build (house, well, lamp, storehouse, market, hall, tower, wall), farms with farm. Houses count both ways: your own home with build_house (small, it holds your bed), or a cottage with build house that anyone can build or carry on. A building takes many blocks and can be built in turns: anyone can carry on with a building another one started, so split the work. Talk it through in chat, write the pack's plan down with pack_plan, split the jobs (one gathers stone, one farms, one builds), hand each other what's needed (give) and look after each other. Every death makes the pack weaker. You still have full control: how you treat the other two is your call.

The world: an island about 500 blocks across, surrounded by ocean. You are not alone on it: there are villages of villagers (each with houses, a well, wheat farms, a smithy with furnaces), and villagers trade with rubies, the island's money (try trade next to one to see what they buy and sell). The farmer's and the smith's houses in each village have a chest with loot (food, seeds, iron, coal, rubies): loot_chest takes it. Small islands off the coast hide treasure chests with iron, gold, diamonds and rubies. Ruby ore is in the rock too. A day is 20 minutes. Night runs from time 12500 to about 23500. In the dark, monsters come out: Shamblers (slow, hit hard up close), Rattlers (archers, they shoot from range) and Skitters (fast, they climb walls). Shamblers and Rattlers burn in daylight. Pigs, cows, sheep and chickens are food. Raw meat works, cooked meat feeds you more. Hunger drops as you act. You heal only while hunger is high, so eat before it gets low.

How to play well:
- Every turn, call one to three action tools, in the order you want them done. They run one after another, so plan a few steps ahead and you're never standing around (for example collect, then craft, then build_house). If one fails or something attacks you, the rest are skipped. In the same turn you may also call say, when you have something to tell the others.
- Play like a good, fast player: keep busy in daylight and always be working toward the next thing you need.
- First day, in this order: oak_log, then oak_planks, sticks, a crafting_table and a wooden_pickaxe. Then cobblestone for a stone_pickaxe and a stone_sword (collect cobblestone digs a staircase down into the rock and walks back up it).
- For building, get stone the way a player does: one collect cobblestone digs a staircase into the rock and brings back a stack, and wood (oak_log, crafted into planks) comes from trees. A town of cobblestone and planks looks like a town. Dirt only tops you up when you're a few blocks short: don't go digging holes for it. Then kill 3 sheep for wool and craft a bed (3 wool and 3 planks). Then coal_ore for torches. Get food from animals as you go.
- A house keeps you safe at night: build_house once you have about 38 cobblestone, planks or dirt (walls, a roof, your bed and a torch go in). Beds only go in houses. From then on go_home every evening before dark.
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
  { name: "wait", description: "Stay where you are for a while (like sealed in at night).", input_schema: { type: "object", properties: { seconds: { type: "integer", minimum: 2, maximum: 30 } }, required: ["seconds"] } },
  { name: "build", description: "Build one of the town's buildings at the pack's base, or carry on with one that is half built: house (a cottage, 75 blocks; it counts as one of the pack's houses), well (26 blocks), lamp (a lamp post: 3 blocks and a torch), storehouse (72, with your chests inside), market (40), hall (the town hall, 140), tower (a watchtower, 70), wall (round the whole base, 190, a stretch each time). It is one whole job: if you run short of blocks it goes and mines stone by itself and comes back to carry on, so just call build (no need to collect first). Town buildings are stone walls with plank corners, trim and roofs; dirt only goes into foundations, and any dirt or leaves in the way get dug out and replaced. Fences, glass, torches and chests go in where you have them. You need to be near the base.", input_schema: { type: "object", properties: { what: { type: "string", enum: ["house", "well", "lamp", "storehouse", "market", "hall", "tower", "wall"] } }, required: ["what"] } },
  { name: "farm", description: "Till a field beside water near the base with your hoe and plant your wheat_seeds in it: by a pond within 30 blocks of the base, or, with an empty bucket, it fills the bucket at any water and makes the field at the base. Wheat ripens in about a day.", input_schema: { type: "object", properties: {} } },
  { name: "harvest", description: "Cut the ripe wheat near you and plant the seeds straight back. 3 wheat make bread.", input_schema: { type: "object", properties: {} } },
  { name: "loot_chest", description: "Walk to the nearest chest you haven't emptied (within 48 blocks: the villages' houses, treasure on the islands) and take everything in it.", input_schema: { type: "object", properties: {} } },
  { name: "trade", description: "Trade with the nearest villager (within 24 blocks; they live in the villages). Without an offer number it walks over and tells you what they trade; with one, it makes that trade (times: how many).", input_schema: { type: "object", properties: { offer: { type: "integer", minimum: 0, maximum: 8 }, times: { type: "integer", minimum: 1, maximum: 16 } } } },
  { name: "build_house", description: "Build a small house right here (about 38 cobblestone, planks or dirt): walls, a roof, a door if you have one, and your bed and a torch inside. It becomes your home.", input_schema: { type: "object", properties: {} } },
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
    if (this.body.home && !PACK.houses[this.name]) {
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
    if (b.home) lines.push(`Your home: a house at x=${b.home.x0 + 1} z=${b.home.z0 + 1}, ${Math.round(Math.hypot(b.home.x0 + 2 - b.phys.x, b.home.z0 + 2 - b.phys.z))} blocks ${dirWord(b.home.x0 + 2 - b.phys.x, b.home.z0 + 2 - b.phys.z)}${b.atHome() ? " (you're in it)" : ""}.`);
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
          const ok = await b.goto(x, b.phys.y, z, 2, { maxMs: 90000, done: () => Math.hypot(x - b.phys.x, z - b.phys.z) < 2.5 });
          return ok ? "arrived" : `stopped at x=${Math.round(b.phys.x)} z=${Math.round(b.phys.z)}, couldn't get further`;
        }
        case "explore": {
          const d = String(i.direction ?? "north");
          const [dx, dz] = d === "east" ? [1, 0] : d === "west" ? [-1, 0] : d === "south" ? [0, 1] : [0, -1];
          const x = Math.max(8, Math.min(504, b.phys.x + dx * 40));
          const z = Math.max(8, Math.min(504, b.phys.z + dz * 40));
          await b.goto(x, b.phys.y, z, 3, { maxMs: 45000 });
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
        case "build": return await this.buildTown(String(i.what ?? "") as Exclude<Kind, "farm">);
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
          for (let k = 0; k < s * 20 && !b.abort && !b.dead; k++) {
            if (k % 60 === 0) b.wantYaw = (b.yaw + 40 + Math.random() * 60) % 360; // look around now and then
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
    const t0 = Date.now();
    const skip = new Set<number>();
    let tried = 0;
    // soft ground (dirt, sand, gravel) comes out of one shallow pit, a layer at a time, well away from the town and
    // the villages: a player digs a quarry, not a hole here and a hole there all over the base
    const soft = !plan.blocks.includes(B.STONE) && plan.blocks.some((id) => id === B.DIRT || id === B.GRASS || id === B.SAND || id === B.GRAVEL);
    const villages = (b.world?.villages ?? []).map((k) => VILLAGE_SITES[k]).filter(Boolean);
    const theirs = (x: number, z: number) => villages.some((v) => Math.hypot(x - v.x, z - v.z) < 27) || footprints().some((r) => x >= r.x0 - 2 && x <= r.x1 + 2 && z >= r.z0 - 2 && z <= r.z1 + 2);
    const offLimits = (x: number, z: number) => (PACK.base && Math.hypot(x - PACK.base.x, z - PACK.base.z) < 16) || theirs(x, z);
    let pit: [number, number, number] | null = null;
    // stone comes out of the ground away from the town: never the town's own walls (the nearest "cobblestone" was
    // the town hall's, so they took its lower walls apart for a house), and never a village's houses
    const stone = plan.blocks.includes(B.STONE);
    if (stone && offLimits(b.phys.x, b.phys.z) && PACK.base) {
      const a = Math.atan2(b.phys.z - PACK.base.z, b.phys.x - PACK.base.x);
      b.action = `walking out of the town to mine`;
      await b.goto(PACK.base.x + Math.cos(a) * 20 + 0.5, b.phys.y, PACK.base.z + Math.sin(a) * 20 + 0.5, 3, { maxMs: 20000 });
    }
    while (!b.abort && !b.dead && have() - start < count && Date.now() - t0 < 90000) {
      // nothing deep: the deep caves are where Rattlers wait in the dark
      const floor = Math.max(30, Math.floor(b.phys.y) - 8);
      // and nothing touching water: breaking it lets the water flood in on top of you
      const wet = (x: number, y: number, z: number) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => IS_WATER[b.get(x + dx, y + dy, z + dz)] === 1);
      let found = b.findBlocks(plan.blocks, 32, soft ? 4000 : stone ? 400 : 16).filter(([x, y, z]) => y >= floor && !wet(x, y, z) && !skip.has(x + z * 512 + y * 262144));
      if (stone) found = found.filter(([x, , z]) => !offLimits(x, z)).slice(0, 16);
      else if (!soft) found = found.filter(([x, , z]) => !theirs(x, z));
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
      if (!found.length) break;
      const [x, y, z] = found[0];
      const id = b.get(x, y, z);
      const tool = b.bestToolFor(id);
      if (!canHarvest(id, tool)) return `${BLOCKS[id]?.key ?? item} drops nothing without the right tool (craft a pickaxe first)`;
      tried++;
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

  /** One of the town's buildings at the base: a new one, or the next blocks of one that's half built. */
  private async buildTown(kind: Exclude<Kind, "farm">): Promise<string> {
    const b = this.body;
    if (!KINDS[kind]) return `there is no "${kind}" to build: house, well, lamp, storehouse, market, hall, tower or wall`;
    if (!PACK.base) return "the pack has no base yet: the first house anyone builds becomes it (build_house)";
    const base = PACK.base;
    const far = Math.hypot(base.x - b.phys.x, base.z - b.phys.z);
    if (far > 40) return `you're ${Math.round(far)} blocks from the base: go_to_base first`;
    // the town already has as many of these as any stage asks for: point at what the next stage still needs instead
    // (they put up a third well and a second storehouse while the town hall waited)
    const most = Math.max(0, ...STAGES.flatMap((st) => st.needs.filter(([k]) => k === kind).map(([, n]) => n)));
    this.auditTown();
    if (most && civCount(kind) >= most && !PACK.builds.some((x) => x.kind === kind && (!x.done || x.fix))) {
      const pr = progress(civCount);
      const want = pr.next ? pr.next.needs.filter((n) => n.have < n.need).map((n) => `${civLabel(n.k, n.need - n.have)}${n.need - n.have > 1 ? ` (${n.need - n.have} more)` : ""}`) : [];
      return `the town already has all the ${civLabel(kind, 2)} it needs (${civCount(kind)}). to become ${pr.next ? pr.next.name : "more"} it still needs: ${want.join(", ") || "nothing more"}`;
    }
    const ground = (x: number, z: number) => b.naturalGround(x, z, base.y);
    // never on the villages' land: their houses, roads and farms are theirs (and roofs aren't ground)
    const villages: Rect[] = (b.world?.villages ?? []).map((k) => VILLAGE_SITES[k]).filter(Boolean).map((v) => ({ x0: v.x - 25, z0: v.z - 25, x1: v.x + 25, z1: v.z + 25 }));
    let site = PACK.builds.find((x) => x.kind === kind && (!x.done || x.fix));
    if (!site) {
      if (kind === "wall") {
        if (PACK.builds.some((x) => x.kind === "wall")) return "the wall round the base is already finished";
        site = { kind, x0: base.x - 13, z0: base.z - 13, x1: base.x + 13, z1: base.z + 13, y: base.y, by: [], done: false, at: Date.now() };
      } else {
        const [w, d] = KINDS[kind].size;
        // a lamp post is one block wide: it can stand anywhere round the town, the village's edge included
        // the big ones (a 7 by 7 hall) rarely find dead flat ground by a crowded base: they look further and take a
        // three block slope, which the plan's foundation fills (haiku walked out 41 blocks and back, again and again)
        const big = w * d >= 25;
        const spot = b.siteNear(base.x, base.z, base.y, w, d, kind === "lamp" ? footprints() : [...footprints(), ...villages], kind === "lamp" ? 24 : big ? 34 : 22, kind === "lamp" ? 2 : 3, big ? 3 : 2);
        if (!spot) return `no flat open spot near the base for ${civLabel(kind)} (${w} by ${d}): clear some trees or level some ground near the base`;
        site = { kind, x0: spot.x0, z0: spot.z0, x1: spot.x0 + w - 1, z1: spot.z0 + d - 1, y: spot.y, by: [], done: false, at: Date.now() };
      }
      PACK.builds.push(site);
      savePack();
    }
    const cells = kind === "wall" ? wallPlan(base.x, base.z, 13, ground) : planFor(kind, site.x0, site.z0, site.y, ground);
    // one builder at a time: two on the same small building just walk into each other round it
    if (site.busy && site.busy.by !== this.name && Date.now() - site.busy.at < 45000 && BOARD.get(site.busy.by)) {
      return `${site.busy.by} is building ${civLabel(kind)} right now: help another way (bring them blocks with give, build something else, or gather what the next stage needs)`;
    }
    site.busy = { by: this.name, at: Date.now() };
    if (!site.by.includes(this.name)) site.by.push(this.name);
    // stand in the middle and build round itself, the way a player does: everything in a small building is in reach
    // from there, so it doesn't circle the building for every block
    const toMiddle = async () => {
      // (a watchtower is the exception: inside its hollow it can't climb out to reach the top)
      if (kind === "wall" || kind === "lamp" || kind === "tower") return;
      const sx = Math.floor((site.x0 + site.x1) / 2);
      const sz = Math.floor((site.z0 + site.z1) / 2);
      if (Math.hypot(sx + 0.5 - b.phys.x, sz + 0.5 - b.phys.z) > 1.2) await b.goto(sx + 0.5, site.y, sz + 0.5, 0.8, { maxMs: 30000 });
    };
    const solid = cells.filter(([, , , k]) => k !== "t" && k !== "c" && k !== "g");
    const left = () => solid.filter((c) => b.needsWork(c)).length;
    // one job, start to finish: short of blocks, it goes and mines stone (a staircase), comes back to the middle and
    // carries on, without stopping to think in between; it only hands back when the building is up, the time is up,
    // or something it can't fix by itself gets in the way
    const deadline = Date.now() + 5 * 60000;
    let r: Awaited<ReturnType<typeof b.buildCells>> = { placed: 0, left: left(), outOf: false, why: "" };
    let placed = 0;
    let fetched = 0;
    for (let round = 0; round < 6 && !b.abort && !b.dead && Date.now() < deadline && left() > 0; round++) {
      site.busy = { by: this.name, at: Date.now() };
      if (b.townBlocks() < Math.min(left(), 10)) {
        const before = b.townBlocks();
        // the pickaxe broke mid-job (sonnet, 47 blocks short of the town hall): make another from what it carries;
        // with no wood for one either, it fetches logs (planks for the roof, and a pickaxe next round)
        const pick = () => { const t = b.bestToolFor(B.STONE); return !!t && canHarvest(B.STONE, t); };
        for (const rid of ["oak_planks", "birch_planks", "oak_planks_from_palm", "sticks", "stone_pickaxe", "wooden_pickaxe"]) {
          if (pick() || b.abort) break;
          await b.craft(rid, 1);
        }
        this.body.action = `getting ${pick() ? "stone" : "wood"} for ${civLabel(kind)}`;
        if (pick()) await this.collect("cobblestone", Math.min(48, left() - before + 4));
        else {
          await this.collect("oak_log", 6);
          for (const rid of ["oak_planks", "birch_planks", "oak_planks_from_palm"]) await b.craft(rid, 6);
        }
        fetched += b.townBlocks() - before;
        if (b.townBlocks() <= before) break; // nothing to be had here: the brain has to decide what next
      }
      // back up to the town first: from a tunnel under the site the path planner stops right below the cells, so it
      // shuffled about 15 blocks under the watchtower "building" it (opus, after mining stone down there)
      if (b.phys.y < site.y - 3) {
        this.body.action = `climbing back up to ${civLabel(kind)}`;
        await b.digOut();
      }
      await toMiddle();
      r = await b.buildCells(cells, kind === "wall" ? 48 : 90, `building ${civLabel(kind)}`);
      placed += r.placed;
      if (!r.placed && !r.outOf) break; // in the way or out of reach: more blocks won't help
    }
    r = { ...r, placed };
    site.busy = undefined;
    const missing = left();
    const where = `x=${Math.round((site.x0 + site.x1) / 2)} z=${Math.round((site.z0 + site.z1) / 2)}`;
    if (missing <= Math.floor(solid.length * (kind === "wall" ? 0.05 : 0.02))) {
      const fixed = site.fix;
      site.done = true;
      site.fix = false;
      this.civUpdate(fixed ? `${this.name} fixed up ${civLabel(kind)}` : `${site.by.join(" and ")} finished ${civLabel(kind)}`);
      return `finished ${civLabel(kind)} at ${where} (${r.placed} blocks placed${fetched ? `, ${fetched} stone mined for it on the way` : ""})`;
    }
    // a spot where nothing will go in, turn after turn (on a roof, walled off, out of reach): give up on it, so the next
    // build picks a better one instead of everyone trying the same blocks forever
    site.stuck = r.placed ? 0 : (site.stuck ?? 0) + 1;
    if (site.stuck >= 3 && !r.outOf && kind !== "wall") {
      PACK.builds = PACK.builds.filter((x) => x !== site);
      savePack();
      return `gave up on ${civLabel(kind)} at ${where}: nothing would go in there three times (${r.why || "a bad spot"}). build it again and a better spot gets picked`;
    }
    savePack();
    if (!r.placed) return r.outOf || b.townBlocks() < 4 ? `out of building blocks and couldn't mine more stone here: ${missing} still to go on ${civLabel(kind)} at ${where} (get logs for planks, or stone from somewhere else)` : `couldn't place blocks on ${civLabel(kind)} at ${where}: ${r.why || "in the way, or out of reach"}; ${missing} to go`;
    return `placed ${r.placed} blocks on ${civLabel(kind)} at ${where}: ${missing} to go${r.outOf ? " (you ran out of building blocks)" : ""}`;
  }

  /** Where the pack's civilization stands, what it has built and what the next stage needs. */
  private civText(): string {
    const pr = progress(civCount);
    const kinds: Kind[] = ["house", "farm", "well", "lamp", "storehouse", "market", "hall", "tower", "wall"];
    const built = kinds.map((k) => [k, civCount(k)] as const).filter(([, n]) => n > 0).map(([k, n]) => (n === 1 ? civLabel(k) : `${n} ${civLabel(k, 2)}`));
    let t = `Your civilization: ${pr.name}${pr.stage >= 0 ? ` (stage ${pr.stage + 1} of ${STAGES.length})` : ""}. Built so far: ${built.length ? built.join(", ") : "nothing"}${PACK.trades ? `, ${PACK.trades} trades with villagers` : ""}.`;
    t += pr.next ? ` Next, ${pr.next.name}: ${pr.next.needs.map((n) => `${civLabel(n.k, n.need)} ${n.have}/${n.need}`).join(", ")}.` : " You have built a city.";
    const open = PACK.builds.filter((x) => !x.done).map((x) => `${civLabel(x.kind)} at x=${Math.round((x.x0 + x.x1) / 2)} z=${Math.round((x.z0 + x.z1) / 2)} (started by ${x.by.join(" and ") || "someone"})`);
    if (open.length) t += ` Half built, anyone can carry on with build: ${open.join("; ")}.`;
    const fix = PACK.builds.filter((x) => x.done && x.fix).map((x) => `${civLabel(x.kind)} at x=${Math.round((x.x0 + x.x1) / 2)} z=${Math.round((x.z0 + x.z1) / 2)}`);
    if (fix.length) t += ` Needs fixing (walls missing, or still dirt and leaves): ${fix.join("; ")}. build that kind to fix it up in stone and planks.`;
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

  /** A finished building that has lost a good part of itself, or is still dirt and leaves from before town buildings
   *  were stone and wood, is marked as needing a fix: it still counts, and the next builder of that kind fixes it up. */
  private auditTown(): void {
    if (Date.now() - lastAudit < 60000 || !PACK.base) return;
    lastAudit = Date.now();
    const b = this.body;
    const base = PACK.base;
    const ground = (x: number, z: number) => b.naturalGround(x, z, base.y);
    for (const site of PACK.builds) {
      if (!site.done || site.fix || site.kind === "wall" || site.kind === "farm") continue;
      // only what it can see from here: a chunk it hasn't loaded reads as air
      if (Math.hypot((site.x0 + site.x1) / 2 - b.phys.x, (site.z0 + site.z1) / 2 - b.phys.z) > 40) continue;
      const solid = planFor(site.kind, site.x0, site.z0, site.y, ground).filter(([, , , k]) => k !== "t" && k !== "c" && k !== "g");
      const bad = solid.filter((c) => b.needsWork(c)).length;
      if (bad <= Math.max(4, solid.length * 0.1)) continue;
      site.fix = true;
      this.civUpdate(`${civLabel(site.kind)} at x=${Math.round((site.x0 + site.x1) / 2)} z=${Math.round((site.z0 + site.z1) / 2)} needs fixing: ${bad} blocks missing or dirt`);
    }
  }

  /** Something got built: save the pack, tell the site, and mark a new stage. */
  private civUpdate(what: string): void {
    const pr = progress(civCount);
    const up = pr.stage > PACK.stage;
    PACK.stage = Math.max(PACK.stage, pr.stage);
    savePack();
    this.emitCiv(what);
    if (up) this.emit("plan", { text: `the pack is now ${pr.name}` });
  }

  emitCiv(what = ""): void {
    const pr = progress(civCount);
    const kinds: Kind[] = ["house", "farm", "well", "lamp", "storehouse", "market", "hall", "tower", "wall"];
    this.emit("civ", {
      text: what,
      stage: pr.stage,
      name: pr.name,
      stages: STAGES.map((st) => st.name),
      next: pr.next,
      built: Object.fromEntries(kinds.map((k) => [k, civCount(k)])),
      trades: PACK.trades,
      open: PACK.builds.filter((x) => !x.done || x.fix).map((x) => ({ kind: x.kind, by: x.by, fix: !!x.fix })),
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
      if (r && r.d < (night ? 7 : 14) && b.bestWeapon() && b.stats.hp >= (night ? 12 : 8) && others <= (night ? 0 : 1)) {
        let res = "";
        await this.reflex("going after a rattler", async () => {
          res = await b.fight({ kind: "mob", id: r.id }, 20000, 6, night ? 8 : 14);
          return `A rattler was shooting at you and you went for it (${res}).`;
        });
        if (/backed off/.test(res) && !b.dead && !b.sealed()) await this.reflex("hurt, digging in away from the rattler", async () => `You were badly hurt fighting a rattler, so you dug in: ${await b.digIn()}.`);
      } else await this.reflex("digging in, a rattler is shooting", async () => `A rattler was shooting at you${b.bestWeapon() ? " and you were too hurt to fight it" : " and you had no weapon"}, so you dug in: ${await b.digIn()}.`);
      return;
    }
    // a monster in its face: fight it (with a weapon or health to spare), else run; badly hurt in a tunnel there is
    // nowhere to run (sonnet died fighting and fleeing in turns down a one-wide staircase): wall itself in instead
    if (h && (h.d < 3.2 || (hurtRecently && h.d < 6)) && !b.sealed()) {
      const armed = !!b.bestWeapon();
      if (b.stats.hp < 8 && b.covered()) {
        await this.reflex(`badly hurt underground, walling itself in`, async () => `A ${h.key} had you badly hurt underground, so you walled yourself in to heal: ${await b.digIn()}.`);
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
        let res = "";
        await this.reflex(`fighting a ${h.key}`, async () => {
          res = await b.fight({ kind: "mob", id: h.id }, 15000, 7);
          return `A ${h.key} attacked you and you fought it (${res}).`;
        });
        if (/backed off/.test(res) && !b.dead && b.covered()) {
          await this.reflex(`badly hurt underground, walling itself in`, async () => `You were badly hurt fighting a ${h.key} underground, so you walled yourself in to heal: ${await b.digIn()}.`);
        } else if (/backed off/.test(res) && !b.dead) {
          await this.reflex(`running from a ${h.key}, badly hurt`, async () => {
            await b.flee(h.x, h.z, 140);
            return `You were badly hurt fighting a ${h.key}, so you broke off and ran.`;
          });
        }
      }
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
    const homeFar = b.home ? Math.hypot(b.home.x0 + 2 - b.phys.x, b.home.z0 + 2 - b.phys.z) : 0;
    if (b.home && !b.atHome() && tod >= 11600 && tod < 23000 && Date.now() - this.lastHomeTrip > 60000 && !/home|bed|asleep/.test(b.action)
      && !b.sealed() && !["dig_out", "dig_in", "go_home", "sleep", "build_house"].includes(this.skill) && (!b.isNight() || homeFar < 40)) {
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
    if ((dusk || b.isNight()) && !b.covered() && !b.phys.inWater && !(b.home && !b.atHome() && /home/.test(b.action))) {
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
