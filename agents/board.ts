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

/** Raw materials, the way the gatherers bring them in. */
export type Raw = "stone" | "wood" | "sand" | "coal" | "iron" | "food";
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
]);
/** Which items count as each raw material in a bag or the storehouse. */
export const RAW_ITEMS: Record<Raw, number[]> = {
  stone: [B.COBBLESTONE, B.STONE, B.STONE_BRICKS],
  wood: [B.OAK_LOG, B.PALM_LOG, B.OAK_PLANKS],
  sand: [B.SAND, B.GLASS, B.GLASS_PANE],
  coal: [I.COAL, I.CHARCOAL],
  iron: [I.RAW_IRON, I.IRON_INGOT],
  food: [I.BREAD, I.WHEAT, I.COOKED_PORKCHOP, I.STEAK, I.COOKED_MUTTON, I.COOKED_CHICKEN, I.PORKCHOP, I.BEEF, I.MUTTON, I.CHICKEN, I.APPLE],
};
/** How much one of an item counts for, as the raw material (planks are a quarter of a log). */
export const rawWorth = (raw: Raw, id: number) => (raw === "wood" && id === B.OAK_PLANKS ? 0.25 : raw === "sand" && id === B.GLASS_PANE ? 0.4 : 1);

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
  const wood = (short.get("wood") ?? 0) * 2 + (short.get("sand") ?? 0);
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
      if ((short.get("sand") ?? 0) > 0) return `getting sand for ${project}'s glass`;
      return "getting oak for the next build";
    case "farmer":
      return "farming: fields, wheat and bread, food for the town";
  }
}
