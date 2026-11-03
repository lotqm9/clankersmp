// clankersmp (v14): a mining trip for the better ores (Laith: "I want them to aim for better resources, diamonds etc").
// Diamonds lie at y 4 to 16 and rubies at 4 to 22 (shared/caves.ts ORES): below the y 30 that the everyday staircase
// never passes, because the deep caves at night killed them. So the deep trip is its own thing, by day and gear-gated:
//   - only in the morning, with the day ahead of it, armoured, a real weapon, an iron pickaxe (diamonds need one),
//     torches, food and spare blocks;
//   - down a lit staircase to the diamond layer, turning toward the diamonds it knows of as it goes, through the rock
//     only: a cave it breaks into gets its openings blocked up, and the stair goes on;
//   - a two-high tunnel at that depth to the nearest diamonds (the body knows the world's blocks, as collect does),
//     mining every ore its walls show, veins and all; a torch every few blocks, caves blocked off, water steered round;
//   - back up the way it came by its deadline (or a full bag, few torches, few blocks, hurt), out under the sky.
// Fights on the way are the reflexes' (brain.ts combat). A trip cut short by one carries on when it's called again, and
// one left below by the afternoon gets walked back up (climbOut).

import type { Body } from "./body.ts";
import { NIGHT_END } from "./body.ts";
import { B, BLOCKS, IS_WATER, SOLID } from "../shared/blocks.ts";
import { I, itemDef } from "../shared/items.ts";
import { canHarvest } from "../shared/mining.ts";

const ORES = [B.COAL_ORE, B.IRON_ORE, B.GOLD_ORE, B.RUBY_ORE, B.DIAMOND_ORE] as number[];
const isOre = (id: number) => ORES.includes(id);
/** The depth it tunnels at: the middle of the diamond layer. */
export const DIAMOND_Y = 11;
/** Time of day it stops mining and heads back up (dusk is 11600-12500; up, the haul in and home before then: a day
 *  is 20 minutes, so this is 7 minutes after dawn and 3 before dusk). */
export const HEAD_BACK = 8000;
/** Latest time a trip may start: it needs a few minutes down there. */
export const LAST_START = 5000;

/** The time of day counted from dawn: the small hours after NIGHT_END come before 0. */
export function dayClock(b: Body): number {
  const t = b.timeOfDay();
  return t > NIGHT_END ? t - 24000 : t;
}

type Cell = [number, number, number];
const key = (c: Cell) => `${c[0]},${c[1]},${c[2]}`;
const SIDES: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const NEAR6 = (c: Cell): Cell[] => [[c[0] + 1, c[1], c[2]], [c[0] - 1, c[1], c[2]], [c[0], c[1] + 1, c[2]], [c[0], c[1] - 1, c[2]], [c[0], c[1], c[2] + 1], [c[0], c[1], c[2] - 1]];

/** A trip under way, per body: the cells it walked (the way back), what it dug, where it started. */
interface TripState {
  path: Cell[];
  dug: Set<string>;
  top: Cell;
  at: number;
  t0: number;
  firstDiamond: number; // ms from the trip's start to its first diamond (0: none yet)
  noPlug: Set<string>; // cave openings a block wouldn't go into (nothing beside them to hold it): not tried again
}
const TRIPS = new Map<string, TripState>();

/** Down a mine on a trip that isn't finished (it was cut short): its state. */
export function pendingTrip(b: Body): TripState | undefined {
  const t = TRIPS.get(b.name);
  if (t && Date.now() - t.at > 30 * 60000) TRIPS.delete(b.name);
  return TRIPS.get(b.name);
}

/** Armour points it has on, or carries to put on (the guard wears the best of each slot within seconds). */
const armourOf = (b: Body) => {
  const best = [0, 0, 0, 0];
  for (const s of [...b.armor, ...b.inv]) {
    const a = s ? itemDef(s.id)?.armor : undefined;
    if (a) best[a.slot] = Math.max(best[a.slot], a.points);
  }
  return best.reduce((n, p) => n + p, 0);
};
const ironPick = (b: Body) => b.inv.find((s) => s && itemDef(s.id)?.tool?.kind === "pickaxe" && (itemDef(s.id)?.tool?.tier ?? 0) >= 3)?.id ?? 0;
/** Blocks left in its best iron (or better) pickaxe before it breaks. */
const pickLife = (b: Body) => b.inv.reduce((n, s) => {
  const t = s ? itemDef(s.id)?.tool : undefined;
  return t && t.kind === "pickaxe" && t.tier >= 3 ? Math.max(n, t.durability - s!.d) : n;
}, 0);
/** A pickaxe besides the iron one, for the stone (the iron one lasts for the ores then). */
const otherPick = (b: Body) => b.inv.some((s) => s && itemDef(s.id)?.tool?.kind === "pickaxe" && (itemDef(s.id)?.tool?.tier ?? 0) < 3);
const goodFood = (b: Body) => b.inv.reduce((n, s) => n + (s && itemDef(s.id)?.food && !itemDef(s.id)?.food?.queasy ? s.n : 0), 0);

/** What it still needs for a deep trip (empty when it's ready to go). */
export function tripNeeds(b: Body): string[] {
  const missing: string[] = [];
  const weapon = itemDef(b.bestWeapon())?.tool;
  if (armourOf(b) < 6) missing.push("armour (an iron chestplate, or a full set of leather)");
  if (!weapon || !(weapon.kind === "axe" || (weapon.kind === "sword" && weapon.material >= 1))) missing.push("a real weapon (a stone sword or better, or an axe)");
  if (!ironPick(b)) missing.push("an iron_pickaxe (diamonds need one)");
  else if (pickLife(b) < 60) missing.push(`an iron_pickaxe with some life left in it (yours has ${pickLife(b)} blocks left)`);
  if (b.count(B.TORCH) < 8) missing.push(`8 torches (you have ${b.count(B.TORCH)})`);
  if (goodFood(b) < 4) missing.push("4 food");
  if (b.fillerCount() < 16) missing.push("16 spare blocks (cobblestone or dirt) to block off caves");
  return missing;
}

/** Why it can't set off on a deep trip now ("" if it can). */
export function tripCheck(b: Body): string {
  if (b.isNight() || dayClock(b) > LAST_START) return `can't start a deep trip now: it's a morning thing (back up before dusk, and the deep is no place at night): go between dawn and time ${LAST_START}`;
  const missing = tripNeeds(b);
  if (b.stats.hp < 14) missing.push("health (heal up first: eat)");
  return missing.length ? `can't go deep yet: a trip needs ${missing.join(", ")}` : "";
}

/** The ore it would most like to get to from here: diamonds first, then rubies (the money for enchanting), iron; gold
 *  only close by (nothing in the tech tree needs it); coal comes out only where the walls show it. */
function bestOre(b: Body, cx: number, cy: number, cz: number, skip: Set<string>): Cell | null {
  let best: Cell | null = null;
  let bs = Infinity;
  const r = 40;
  for (let y = Math.max(3, Math.min(cy, DIAMOND_Y) - 8); y <= Math.min(40, cy + 8); y++)
    for (let z = cz - r; z <= cz + r; z++)
      for (let x = cx - r; x <= cx + r; x++) {
        const id = b.get(x, y, z);
        if (id === B.AIR || id === B.STONE || id === B.COAL_ORE || !isOre(id) || skip.has(`${x},${y},${z}`)) continue;
        // (rubies are five times as common as diamonds: at 1.6 to 1 a trip spent itself on rubies a few blocks off)
        const w = id === B.DIAMOND_ORE ? 1 : id === B.RUBY_ORE ? 3 : id === B.IRON_ORE ? 4.5 : 8;
        const s = (Math.abs(x - cx) + Math.abs(z - cz) + Math.abs(y - cy) * 2) * w;
        if (s < bs) [bs, best] = [s, [x, y, z]];
      }
  return best;
}

const wet = (b: Body, c: Cell) => IS_WATER[b.get(...c)] === 1 || NEAR6(c).some((n) => IS_WATER[b.get(...n)] === 1);
/** Air that isn't its own digging and isn't open to the sky: a cave. */
const cave = (b: Body, c: Cell, dug: Set<string>) => !dug.has(key(c)) && !SOLID[b.get(...c)] && !IS_WATER[b.get(...c)] && !b.underSky(...c);

/** A cave's openings beside the cells it just dug, blocked up with spare blocks (monsters wait in the dark of a cave,
 *  even by day). Only where a block can go: something solid beside it to hold it, and not where its own body is (the
 *  server turns both down, and each refusal cost it two seconds); a few seconds at most. */
async function blockOff(b: Body, cells: Cell[], st: TripState): Promise<number> {
  let n = 0;
  const t0 = Date.now();
  const mine = (o: Cell) => b.phys.x + 0.35 > o[0] && b.phys.x - 0.35 < o[0] + 1 && b.phys.z + 0.35 > o[2] && b.phys.z - 0.35 < o[2] + 1 && b.phys.y + 1.85 > o[1] && b.phys.y < o[1] + 1;
  const todo: Cell[] = [];
  for (const c of cells) for (const o of NEAR6(c)) if (cave(b, o, st.dug) && b.get(...o) === B.AIR && !st.noPlug.has(key(o)) && !todo.some((q) => key(q) === key(o))) todo.push(o);
  // two rounds: a block that goes in gives the next one something to stand against
  for (let round = 0; round < 2 && todo.length; round++)
    for (const o of [...todo]) {
      if (b.abort || b.dead || Date.now() - t0 > 6000) break;
      if (b.get(...o) !== B.AIR || mine(o) || !NEAR6(o).some((q) => SOLID[b.get(...q)])) continue;
      const f = b.fillerBlock();
      if (!f) break;
      todo.splice(todo.indexOf(o), 1);
      if (await b.place(f, o[0], o[1], o[2], 1500)) n++;
      else st.noPlug.add(key(o));
    }
  if (n || todo.length) dbg(b, `blocked off ${n} cave openings${todo.length ? ` (${todo.length} left open)` : ""}`);
  return n;
}

/** Dig a set of cells (head first, then feet), the cave openings round them blocked up. False if one wouldn't go. */
async function dig(b: Body, cells: Cell[], st: TripState): Promise<boolean> {
  for (const c of cells) {
    if (b.abort || b.dead) return false;
    if (SOLID[b.get(...c)] && !(await b.mine(c[0], c[1], c[2], false))) return false;
    st.dug.add(key(c));
  }
  await blockOff(b, cells, st);
  return true;
}

/** An ore that came out of the floor of its tunnel leaves a hole the way back up walks into (four of a round's
 *  climbs dropped into one and lost the way): a block goes back in. */
async function refill(b: Body, holes: Cell[], st: TripState): Promise<void> {
  for (const o of holes) {
    if (b.abort || b.dead || b.get(...o) !== B.AIR) continue;
    const f = b.fillerBlock();
    if (!f) return;
    if (await b.place(f, o[0], o[1], o[2], 1500)) st.dug.delete(key(o));
  }
}
/** Under a cell of its own tunnel: the tunnel's floor. */
const floorOf = (st: TripState, o: Cell) => st.dug.has(key([o[0], o[1] + 1, o[2]]));

/** Ores showing round the cells it stands in come out, and the rest of each vein (up to a dozen blocks). */
async function mineWalls(b: Body, at: Cell, st: TripState): Promise<number> {
  let got = 0;
  const todo: Cell[] = [];
  const body: Cell[] = [at, [at[0], at[1] + 1, at[2]]];
  // never the block it stands on (that one comes out from the next cell along)
  const underfoot = key([at[0], at[1] - 1, at[2]]);
  for (const c of body) for (const n of NEAR6(c)) if (isOre(b.get(...n)) && key(n) !== underfoot) todo.push(n);
  const seen = new Set<string>();
  const holes: Cell[] = [];
  while (todo.length && got < 12 && !b.abort && !b.dead) {
    const o = todo.shift()!;
    if (seen.has(key(o))) continue;
    seen.add(key(o));
    const id = b.get(...o);
    if (key(o) === underfoot || !isOre(id) || wet(b, o) || !canHarvest(id, b.bestToolFor(id)) || b.reachTo(...o) > 4.3) continue;
    if (await b.mine(o[0], o[1], o[2], false)) {
      got++;
      if (floorOf(st, o)) holes.push(o);
      st.dug.add(key(o));
      if (id === B.DIAMOND_ORE && !st.firstDiamond) st.firstDiamond = Date.now() - st.t0;
      for (const n of NEAR6(o)) if (b.get(...n) === id) todo.push(n);
    }
  }
  if (got) {
    dbg(b, `mined ${got} ore from the walls${holes.length ? ` (${holes.length} out of the floor, filled back in)` : ""}`);
    // the floor back first (a drop in the hole comes up out of the block put back)
    await refill(b, holes, st);
    await collectDrops(b);
    // back to its place in the tunnel (the drops may have taken it a step or two along)
    if (!b.abort && !b.dead) await toCell(b, at, 3000);
    await blockOff(b, body, st);
  }
  return got;
}

/** The drops of what it just mined: those beside it fly in by themselves once they can be picked up (half a second);
 *  a short walk for the rest, and never long after one it can't get at (in a hole in the wall). */
async function collectDrops(b: Body): Promise<void> {
  await b.wait(12);
  for (let n = 0; n < 4 && !b.abort && !b.dead; n++) {
    let best: { id: number; x: number; y: number; z: number } | null = null;
    let bd = 3.2;
    for (const it of b.items.values()) {
      const d = b.distTo(it.x, it.y, it.z);
      if (d < bd && Math.abs(it.y - b.phys.y) < 3) [bd, best] = [d, it];
    }
    if (!best) return;
    const id = best.id;
    await b.goto(best.x, best.y, best.z, 0.6, { maxMs: 1500, done: () => !b.items.has(id) });
    b.items.delete(id);
  }
}

/** Torches running low and coal mined on the way: more (a coal on a stick makes four), sticks from planks if need be. */
async function moreTorches(b: Body): Promise<void> {
  const coal = b.count(I.COAL) + b.count(I.CHARCOAL);
  if (b.count(B.TORCH) >= 4 || !coal) return;
  if (!b.has(I.STICK) && (b.has(B.OAK_PLANKS) || b.has(B.BIRCH_PLANKS))) await b.craft("sticks", 1);
  if (b.has(I.STICK)) await b.craft("torch", Math.min(coal, b.count(I.STICK), 3));
}

/** A torch on the floor of a cell it has dug (they need solid ground under them): one every seven blocks or so keeps
 *  a tunnel lit enough that nothing spawns in it. */
async function light(b: Body, c: Cell): Promise<void> {
  await moreTorches(b);
  if (!b.has(B.TORCH) || b.get(...c) !== B.AIR || !SOLID[b.get(c[0], c[1] - 1, c[2])]) return;
  dbg(b, `torch: ${await b.place(B.TORCH, c[0], c[1], c[2], 1500)}`);
}

/** Standing in a cell (anywhere in it). */
const inCell = (b: Body, c: Cell) => Math.floor(b.phys.x) === c[0] && Math.floor(b.phys.z) === c[2] && Math.abs(b.phys.y - c[1]) < 0.6;

/** To a cell of its tunnel, and to the middle of it (a walk that has to end within a third of a block of a point
 *  goes round and round in a tunnel: the path is done at half a block). */
async function toCell(b: Body, c: Cell, maxMs = 3500): Promise<boolean> {
  if (!inCell(b, c)) await b.goto(c[0] + 0.5, c[1], c[2] + 0.5, 0.5, { maxMs, done: () => inCell(b, c) });
  if (inCell(b, c)) await b.center(c[0], c[2], 8);
  return inCell(b, c);
}

/** Back to a cell of its tunnel; dropped into a hole below it (an ore that came out of the floor), a block or two
 *  put under its feet first, the way a player gets out of a pit. */
async function regain(b: Body, c: Cell, maxMs = 3000): Promise<boolean> {
  if (await toCell(b, c, maxMs)) return true;
  const rise = c[1] - b.phys.y;
  if (rise >= 0.9 && rise < 4 && Math.abs(b.phys.x - c[0] - 0.5) + Math.abs(b.phys.z - c[2] - 0.5) <= 2.2 && !b.abort && !b.dead) {
    dbg(b, `fell ${rise.toFixed(1)} below its tunnel: pillaring back up`);
    await b.pillarUp(Math.ceil(rise));
    return toCell(b, c, maxMs);
  }
  return false;
}

/** Into a cell it has opened beside it: a step, a step down or a step up. True if it's standing in it. */
async function stepInto(b: Body, n: Cell, from: Cell): Promise<boolean> {
  if (n[1] < from[1]) await b.dropInto(n[0], n[1], n[2]);
  else await toCell(b, n);
  return inCell(b, n);
}

/** Where it is, as a cell. */
const here = (b: Body): Cell => [Math.floor(b.phys.x), Math.floor(b.phys.y + 0.1), Math.floor(b.phys.z)];
/** MINE_DEBUG=1: any part of a step that took more than 2 s. */
const slow = async <T>(b: Body, what: string, p: Promise<T>): Promise<T> => {
  const t = Date.now();
  const r = await p;
  if (Date.now() - t > 2000) dbg(b, `slow: ${what} took ${((Date.now() - t) / 1000).toFixed(1)}s`);
  return r;
};
/** MINE_DEBUG=1: what the trip is doing, step by step. */
const dbg = (b: Body, text: string) => {
  if (process.env.MINE_DEBUG) console.log(`[${b.name} ${new Date().toISOString().slice(11, 19)} y${Math.floor(b.phys.y)}] ${text}`);
};

/** How the trip went, for the brain. */
export interface Trip {
  text: string;
  haul: Map<number, number>;
  back: boolean; // up at the surface again
  firstDiamond: number; // ms into the trip (0: none)
}

/** Water anywhere over a cell (a lake, the sea): under it is not out, and a staircase up through it floods. */
const waterAbove = (b: Body, c: Cell, up = 48) => {
  for (let y = c[1] + 1; y < Math.min(128, c[1] + up); y++) if (IS_WATER[b.get(c[0], y, c[2])]) return true;
  return false;
};
/** Out: under the open sky, and not under water. */
const outside = (b: Body) => b.underSky(...here(b)) && !waterAbove(b, here(b));

/** Back up the way it came (the recorded path, in reverse), out under the sky. Moved off it by a fight, back onto it
 *  through the tunnel first; a staircase dug straight up only as the last resort, and never up through water. */
export async function climbOut(b: Body): Promise<boolean> {
  const st = TRIPS.get(b.name);
  if (!st) {
    if (!outside(b) && !waterAbove(b, here(b))) await b.digOut();
    return outside(b);
  }
  b.action = "climbing back up out of the mine";
  const nearest = (): [number, number] => {
    const at = here(b);
    let k = 0;
    let kd = Infinity;
    st.path.forEach((c, j) => {
      const d = Math.abs(c[0] - at[0]) + Math.abs(c[2] - at[2]) + Math.abs(c[1] - at[1]) * 2;
      if (d < kd || (d === kd && j < k)) [kd, k] = [d, j];
    });
    return [k, kd];
  };
  const on = (c: Cell, slack = 1.2) => Math.abs(b.phys.x - c[0] - 0.5) + Math.abs(b.phys.z - c[2] - 0.5) <= slack && Math.abs(b.phys.y - c[1]) <= 1.2;
  const top = st.top;
  const atTop = () => Math.abs(b.phys.y - top[1]) <= 1.5 && Math.hypot(b.phys.x - top[0] - 0.5, b.phys.z - top[2] - 0.5) < 3;
  for (let tries = 0; tries < 4 && !b.abort && !b.dead && !outside(b) && !atTop() && nearest()[1] <= 12; tries++) {
    let [k, kd] = nearest();
    if (kd > 1) {
      // off its path (a fight moved it, a cave it fell into): back onto it through the tunnel
      dbg(b, `climb: off the path by ${kd}, back to cell ${k}`);
      await b.goto(st.path[k][0] + 0.5, st.path[k][1], st.path[k][2] + 0.5, 0.7, { maxMs: 15000 });
      [k, kd] = nearest();
      if (kd > 2) continue;
    }
    // up the stair three cells at a go (the path along a tunnel is the tunnel); where that doesn't get there, a cell at
    // a time, out of any hole on the way
    const t1 = Date.now();
    let lost = false;
    for (let j = k; j > 0 && !b.abort && !b.dead && !lost; ) {
      const next = Math.max(0, j - 3);
      const c = st.path[next];
      await b.goto(c[0] + 0.5, c[1], c[2] + 0.5, 0.8, { maxMs: 6000, done: () => on(c, 0.9) });
      for (let q = j - 1; q >= next && !on(c, 2) && !b.abort && !b.dead; q--) {
        const cq = st.path[q];
        await b.goto(cq[0] + 0.5, cq[1], cq[2] + 0.5, 0.8, { maxMs: 3000, done: () => on(cq, 0.9) });
        if (!on(cq, 2) && !(await regain(b, cq, 3000)) && !on(cq, 2.5)) {
          dbg(b, `climb: couldn't get to cell ${q} (${cq.join(" ")}), at ${b.phys.x.toFixed(1)} ${b.phys.y.toFixed(1)} ${b.phys.z.toFixed(1)}`);
          lost = true;
          break;
        }
      }
      if (!lost && !on(c, 2.5)) lost = true;
      // three minutes and not up: the long way round, or a staircase of its own
      if (Date.now() - t1 > 180000) lost = true;
      j = next;
      if (j % 15 < 3) dbg(b, `climb: at cell ${j} of ${k} after ${((Date.now() - t1) / 1000).toFixed(0)}s`);
    }
  }
  if (b.abort || b.dead) return false;
  let out = outside(b) || atTop();
  if (!out && !b.abort && !b.dead) {
    // off its stair for good: the pathfinder's own way to the top, through whatever it dug
    dbg(b, "climb: walking to the top of the stair the long way");
    await b.goto(top[0] + 0.5, top[1], top[2] + 0.5, 1.2, { maxMs: 40000 });
    out = outside(b) || atTop();
  }
  if (!out && !waterAbove(b, here(b)) && !b.abort && !b.dead) {
    // the way back is lost for good: a staircase straight up to the sky, and the old stair forgotten
    dbg(b, "climb: lost the way, digging up");
    TRIPS.delete(b.name);
    b.action = "digging a staircase back up out of the mine";
    await b.digOut();
    out = outside(b);
  }
  if (out) TRIPS.delete(b.name);
  return out;
}

/** A deep mining trip from where it stands (see the top of this file). */
export async function miningTrip(b: Body, maxMs = Number(process.env.MINE_MAX_MS) || 10 * 60000): Promise<Trip> {
  try {
    return await runTrip(b, maxMs);
  } finally {
    b.spareTool = 0;
  }
}

async function runTrip(b: Body, maxMs: number): Promise<Trip> {
  const t0 = Date.now();
  const tracked = [I.COAL, I.RAW_IRON, I.RAW_GOLD, I.RUBY, I.DIAMOND];
  const before = new Map<number, number>(tracked.map((id) => [id, b.count(id)]));
  const haul = () => {
    const m = new Map<number, number>();
    for (const [id, n] of before) if (b.count(id) > n) m.set(id, b.count(id) - n);
    return m;
  };
  let st = pendingTrip(b);
  const at = here(b);
  if (st && !st.path.some((c) => Math.abs(c[0] - at[0]) + Math.abs(c[2] - at[2]) <= 6 && Math.abs(c[1] - at[1]) <= 3)) {
    // a trip left below, and it's somewhere else now: that one's over
    if (b.phys.y < st.top[1] - 4 && !b.underSky(...at)) await climbOut(b);
    TRIPS.delete(b.name);
    st = undefined;
  }
  if (st && (b.isNight() || dayClock(b) >= HEAD_BACK)) {
    // left below and it's late: straight back up
    const back = await climbOut(b);
    return { text: back ? "climbed back up out of the mine (it was getting late for a trip)" : `is still down the mine at y ${Math.floor(b.phys.y)}: dig_out`, haul: haul(), back, firstDiamond: st.firstDiamond };
  }
  if (!st) {
    const why = tripCheck(b);
    if (why) return { text: why, haul: new Map(), back: true, firstDiamond: 0 };
    if (!b.underSky(at[0], at[1] + 1, at[2])) return { text: "a trip starts from open ground (outside, under the sky): go out first", haul: new Map(), back: true, firstDiamond: 0 };
    st = { path: [at], dug: new Set([key(at), key([at[0], at[1] + 1, at[2]])]), top: at, at: Date.now(), t0: Date.now(), firstDiamond: 0, noPlug: new Set() };
    TRIPS.set(b.name, st);
  }
  const trip = st;
  const path = trip.path;
  // resuming: back to the end of the way it had dug (through its own tunnel)
  {
    const end = path[path.length - 1];
    await toCell(b, end, 20000);
  }
  let note = "";
  const timeUp = () => {
    if (b.isNight() || dayClock(b) >= HEAD_BACK) return "it was time to head back up before dusk";
    if (Date.now() - t0 > maxMs) return "the trip had run its time";
    if (b.inv.filter(Boolean).length >= 32) return "the bag was full";
    if (b.count(B.TORCH) < 2 && !(b.count(I.COAL) + b.count(I.CHARCOAL) && (b.has(I.STICK) || b.has(B.OAK_PLANKS) || b.has(B.BIRCH_PLANKS)))) return "the torches were nearly gone";
    if (b.stats.hp < 10) return "it was hurt";
    if (b.fillerCount() < 4) return "it was out of blocks to block caves off with";
    if (goodFood(b) < 1 && b.stats.food < 10) return "it was out of food";
    if (pickLife(b) < 12) return "the iron pickaxe was nearly worn out";
    return "";
  };
  const pick = ironPick(b);
  // a stone pickaxe digs the stair and the tunnel; the iron one is kept for what only it can mine
  b.spareTool = otherPick(b) ? pick : 0;
  if (pick && !b.spareTool) await b.hold(pick);
  let [x, y, z] = here(b);
  let steps = 0;
  const startY = trip.top[1];

  // ---- down: a staircase to the diamond layer, aimed at the best ore it knows of (re-aimed every few steps). Each
  // step goes on, or turns a quarter; never back the way it came (that would undercut its own stair). Blocked every
  // way down (water overhead, a cave, the bedrock): a level step along, then down again
  if (y > DIAMOND_Y) {
    b.action = "mining a staircase down to the diamond layer";
    // the way it last went (carrying on after a fight: never back under its own stair)
    let dir = 0;
    if (path.length >= 2) {
      const [p, q] = [path[path.length - 2], path[path.length - 1]];
      const k = SIDES.findIndex(([dx, dz]) => q[0] - p[0] === dx && q[2] - p[2] === dz);
      if (k >= 0) dir = k;
    }
    const aim = () => {
      const t = bestOre(b, x, DIAMOND_Y, z, new Set());
      if (!t) return;
      const ways = path.length > 1 ? [dir, (dir + 1) % 4, (dir + 3) % 4] : [0, 1, 2, 3];
      const dist = (d: number) => Math.abs(t[0] - (x + SIDES[d][0])) + Math.abs(t[2] - (z + SIDES[d][1]));
      dir = ways.sort((p, q) => dist(p) - dist(q))[0];
    };
    aim();
    // (a cave in the way is no reason to stop: the stair goes on through it, the cave's openings round the stair
    // blocked up as it goes; two of eight trips gave up at y 40 among the caves before)
    const blocked = (cells: Cell[], floor: Cell) =>
      cells.some((c) => wet(b, c) || b.get(...c) === B.BEDROCK) || b.get(...floor) === B.BEDROCK || IS_WATER[b.get(...floor)] === 1 || waterAbove(b, cells[0], 16);
    /** A step one way: down a stair (drop 1) or along (drop 0). */
    const move = async (d: number, drop: number): Promise<boolean> => {
      const [dx, dz] = SIDES[d];
      const n: Cell = [x + dx, y - drop, z + dz];
      const cells: Cell[] = drop ? [[n[0], y + 1, n[2]], [n[0], y, n[2]], n] : [[n[0], y + 1, n[2]], n];
      const floor: Cell = [n[0], n[1] - 1, n[2]];
      if (blocked(cells, floor)) return false;
      if (!(await slow(b, "digging", dig(b, cells, trip)))) return false;
      if (!SOLID[b.get(...floor)]) {
        const f = b.fillerBlock();
        if (!f || !(await b.place(f, ...floor, 1500))) return false;
      }
      if (!(await slow(b, "the step", stepInto(b, n, [x, y, z])))) {
        // didn't get there: back where it was
        await regain(b, [x, y, z], 3000);
        return false;
      }
      [x, y, z] = n;
      dir = d;
      path.push(n);
      trip.at = Date.now();
      await slow(b, "the walls", mineWalls(b, n, trip));
      return true;
    };
    let level = 0;
    for (let k = 0; y > DIAMOND_Y && !b.abort && !b.dead && !(note = timeUp()) && k < 220; k++) {
      if (steps % 4 === 0) aim();
      const ways = [dir, (dir + 1) % 4, (dir + 3) % 4];
      let moved = false;
      for (const d of ways) if (!moved && (await move(d, 1))) moved = true;
      if (moved) {
        steps++;
        level = 0;
        dbg(b, `stair step ${steps}`);
        if (steps % 7 === 0) await light(b, path[path.length - 2]);
        continue;
      }
      if (b.abort || b.dead) break;
      // no way down from here: a level step along, then try down again
      for (const d of ways) if (!moved && (await move(d, 0))) moved = true;
      if (!moved || ++level > 10) {
        dbg(b, "stair: blocked all round");
        if (y > 26) note = "the way down was blocked all round (water or caves)";
        break;
      }
      dbg(b, `stair: a level step (${level})`);
    }
  }

  // ---- along: a tunnel through the rock to the ores it knows of, the walls mined as it goes
  const skip = new Set<string>();
  let tunnel = 0;
  // the ore it's tunnelling to, kept until it's out or given up on (re-choosing every step had it zigzag between two
  // diamonds the same distance off); what the walls show on the way comes out as it goes
  let goal: Cell | null = null;
  if (!note && y <= 26) b.action = y <= DIAMOND_Y + 3 ? "branch-mining at the diamond layer" : "branch-mining down toward the diamond layer";
  for (let k = 0; !note && y <= 26 && !b.abort && !b.dead && !(note = timeUp()) && k < 600; k++) {
    if (goal && (skip.has(key(goal)) || !isOre(b.get(...goal)))) goal = null;
    const t = (goal ??= bestOre(b, x, y, z, skip));
    if (!t) {
      dbg(b, "no ore left within reach");
      note = "there was no more ore within reach of the tunnel";
      break;
    }
    const tk = key(t);
    const id = b.get(...t);
    if (t[0] === x && t[2] === z && t[1] < y) {
      // under its feet: from the cell behind it (never the block it stands on)
      const prev = path.length >= 2 ? path[path.length - 2] : null;
      if (prev && t[1] === y - 1 && (await stepInto(b, prev, [x, y, z]))) {
        [x, y, z] = prev;
        path.push(prev);
      } else skip.add(tk);
      continue;
    }
    // in the open beside its tunnel and in reach: out it comes, with its vein
    if (NEAR6(t).some((c) => trip.dug.has(key(c))) && b.reachTo(...t) <= 4.3) {
      if (!wet(b, t) && canHarvest(id, b.bestToolFor(id)) && (await b.mine(t[0], t[1], t[2], false))) {
        const hole = floorOf(trip, t);
        trip.dug.add(tk);
        dbg(b, `mined the ${BLOCKS[id]?.key} it was after`);
        if (id === B.DIAMOND_ORE && !trip.firstDiamond) trip.firstDiamond = Date.now() - trip.t0;
        await mineWalls(b, [x, y, z], trip);
        if (hole) await refill(b, [t], trip);
        await collectDrops(b);
        if (!b.abort && !b.dead) await toCell(b, [x, y, z], 3000);
        if (pick) await b.hold(pick);
      }
      skip.add(tk);
      continue;
    }
    const hd = Math.abs(t[0] - x) + Math.abs(t[2] - z);
    const dy = t[1] - y;
    if (hd <= 1) {
      // beside its column, or in it: open the one cell between them (it's in reach then); further up or down than
      // that is another ore's turn
      const between: Cell | null = hd === 1 ? (dy === -1 ? [t[0], y, t[2]] : dy === 2 ? [t[0], y + 1, t[2]] : null) : dy >= 2 && dy <= 3 ? [x, y + 2, z] : null;
      if (!between || wet(b, between) || cave(b, between, trip.dug) || !(await dig(b, [between], trip))) {
        skip.add(tk);
        dbg(b, `skip ${BLOCKS[id]?.key} beside its column (dy ${dy}): no way to open it up`);
      } else dbg(b, `opened the way to the ${BLOCKS[id]?.key} beside it`);
      continue;
    }
    // a step toward it: along x first, then z; a step up or down on the way while it's above or below
    const sx = t[0] !== x && (Math.abs(t[0] - x) >= Math.abs(t[2] - z) || t[2] === z) ? Math.sign(t[0] - x) : 0;
    const sz = sx ? 0 : Math.sign(t[2] - z);
    const sy = dy > 1 && y < DIAMOND_Y + 6 ? 1 : dy < -1 && y > 5 ? -1 : 0;
    const n: Cell = [x + sx, y + sy, z + sz];
    const cells: Cell[] = sy > 0 ? [[x, y + 2, z], [n[0], n[1] + 1, n[2]], n] : sy < 0 ? [[n[0], y + 1, n[2]], [n[0], y, n[2]], n] : [[n[0], y + 1, n[2]], n];
    const floor: Cell = [n[0], n[1] - 1, n[2]];
    if (cells.some((c) => wet(b, c) || b.get(...c) === B.BEDROCK || cave(b, c, trip.dug)) || IS_WATER[b.get(...floor)] === 1) {
      skip.add(tk); // behind water or across a cave: another one
      dbg(b, `skip ${BLOCKS[id]?.key} ${hd} away: water, bedrock or a cave in the way`);
      continue;
    }
    if (!(await slow(b, "digging", dig(b, cells, trip)))) {
      skip.add(tk);
      dbg(b, `skip ${BLOCKS[id]?.key} ${hd} away: couldn't dig toward it`);
      continue;
    }
    if (!SOLID[b.get(...floor)]) {
      const f = b.fillerBlock();
      if (!f || !(await b.place(f, ...floor, 1500))) {
        skip.add(tk);
        continue;
      }
    }
    if (!(await slow(b, "the step", stepInto(b, n, [x, y, z])))) {
      skip.add(tk);
      dbg(b, `skip ${BLOCKS[id]?.key} ${hd} away: couldn't step toward it`);
      if (!(await regain(b, [x, y, z], 3000))) {
        note = "it lost its footing in the tunnel";
        break;
      }
      continue;
    }
    [x, y, z] = n;
    path.push(n);
    tunnel++;
    dbg(b, `tunnel ${tunnel} toward ${BLOCKS[id]?.key} ${hd} away (dy ${dy})`);
    trip.at = Date.now();
    await slow(b, "the walls", mineWalls(b, n, trip));
    if (tunnel % 7 === 0) await light(b, path[path.length - 2]);
  }
  if (!b.abort && !b.dead) await b.pickUp(5, 3000);

  // ---- back up: the trip's over (cut short by a fight, it stays below and carries on when it's called again)
  let back = false;
  if (!b.dead && !b.abort) back = await climbOut(b);
  const got = haul();
  const words = [...got].map(([id, n]) => `${n} ${itemDef(id)?.key ?? BLOCKS[id]?.key ?? id}`);
  const deepest = Math.min(...path.map((c) => c[1]));
  const how = `down to y ${deepest} (from y ${startY}), ${tunnel} blocks of tunnel, ${words.length ? `found ${words.join(", ")}` : "found no ore worth having"}${note ? `; came back because ${note}` : ""}`;
  const text = b.dead
    ? `died on the mining trip (${how})`
    : back
      ? `went on a deep mining trip and came back up: ${how}`
      : `is still down the mine at y ${Math.floor(b.phys.y)} (the trip was cut short: mine_trip again carries on, or climbs out if it's late): ${how}`;
  return { text, haul: got, back, firstDiamond: trip.firstDiamond };
}

/** Late, with a trip left below (cut short by a fight and not taken up again): time to climb out. */
export function oughtToClimbOut(b: Body): boolean {
  const st = pendingTrip(b);
  return !!st && (b.isNight() || dayClock(b) >= HEAD_BACK) && b.phys.y < st.top[1] - 3 && !b.underSky(...here(b));
}
