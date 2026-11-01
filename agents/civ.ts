// The pack's civilization: the buildings it can put up around its base, the plan (block by block) of each, and the
// stages it climbs from a camp to a city. All three AIs build from the same list (agents/brain.ts keeps it in
// pack.json), so any of them can pick up a building another one started.

import type { PlanCell, Rect } from "./body.ts";

export type Kind = "house" | "farm" | "well" | "lamp" | "storehouse" | "hall" | "tower" | "market" | "wall";

export interface Building extends Rect {
  kind: Kind;
  y: number;
  by: string[];
  done: boolean;
  at: number;
}

/** What each kind is, for the AIs (and the site). A "house" here is a cottage anyone builds with build: it counts
 *  toward the houses as much as a player's own home (build_house). */
export const KINDS: Record<Exclude<Kind, "farm">, { size: [number, number]; blocks: number; what: string }> = {
  house: { size: [5, 5], blocks: 75, what: "a cottage: walls 3 high round a 3 by 3 room, a doorway, two windows and a roof" },
  well: { size: [3, 3], blocks: 26, what: "a stone well with a roof: the middle of the town" },
  lamp: { size: [1, 1], blocks: 3, what: "a lamp post with a torch on top (monsters don't spawn in the light)" },
  storehouse: { size: [5, 5], blocks: 72, what: "a storehouse with chests inside for the pack's shared supplies" },
  market: { size: [5, 5], blocks: 40, what: "an open market stall with a roof, for trading and meeting" },
  hall: { size: [7, 7], blocks: 140, what: "the town hall: a big building with windows, the heart of a town" },
  tower: { size: [3, 3], blocks: 70, what: "a watchtower with torches on top, seen from far away" },
  wall: { size: [27, 27], blocks: 190, what: "a wall all the way round the base, with four gates (built a stretch at a time)" },
};

/** The stages, each on top of the one before. "trade" counts trades made with villagers. */
export const STAGES: { name: string; needs: [Kind | "trade", number][] }[] = [
  { name: "a camp", needs: [["house", 1]] },
  { name: "a settlement", needs: [["house", 3], ["farm", 1], ["well", 1]] },
  { name: "a village", needs: [["lamp", 6], ["storehouse", 1], ["farm", 2], ["wall", 1]] },
  { name: "a town", needs: [["hall", 1], ["market", 1], ["tower", 1], ["trade", 5]] },
  { name: "a city", needs: [["house", 6], ["farm", 4], ["lamp", 16], ["tower", 2]] },
];

const LABEL: Record<Kind | "trade", [string, string]> = {
  house: ["a house", "houses"], farm: ["a farm", "farms"], well: ["a well", "wells"], lamp: ["a lamp post", "lamp posts"],
  storehouse: ["a storehouse", "storehouses"], hall: ["a town hall", "town halls"], tower: ["a watchtower", "watchtowers"],
  market: ["a market", "markets"], wall: ["the wall round the base", "walls"], trade: ["a trade with a villager", "trades with villagers"],
};
export const label = (k: Kind | "trade", n = 1) => (n === 1 ? LABEL[k][0] : LABEL[k][1]);

/** How far the pack has got: the stage reached (-1: none yet), and what the next one still needs. */
export function progress(count: (k: Kind | "trade") => number): { stage: number; name: string; next: { name: string; needs: { k: Kind | "trade"; have: number; need: number }[] } | null } {
  let stage = -1;
  for (let i = 0; i < STAGES.length; i++) {
    if (STAGES[i].needs.every(([k, n]) => count(k) >= n)) stage = i;
    else break;
  }
  const n = STAGES[stage + 1];
  return {
    stage,
    name: stage >= 0 ? STAGES[stage].name : "nothing yet",
    next: n ? { name: n.name, needs: n.needs.map(([k, need]) => ({ k, have: Math.min(need, count(k)), need })) } : null,
  };
}

/** Cells of a ring round a w by d footprint, outside in (so a roof grows from the walls to the middle). */
function rings(x0: number, z0: number, w: number, d: number, y: number, kind = "b"): PlanCell[] {
  const out: PlanCell[] = [];
  for (let dz = 0; dz < d; dz++) for (let dx = 0; dx < w; dx++) out.push([x0 + dx, y, z0 + dz, kind]);
  const edge = ([x, , z]: PlanCell) => Math.min(x - x0, x0 + w - 1 - x, z - z0, z0 + d - 1 - z);
  return out.sort((a, b) => edge(a) - edge(b));
}

/** The plan of a building with its north-west corner at (x0, z0) and its floor at y. `ground` gives the ground under a
 *  column, so low spots get a foundation first. */
export function planFor(kind: Exclude<Kind, "farm" | "wall">, x0: number, z0: number, y: number, ground: (x: number, z: number) => number): PlanCell[] {
  const [w, d] = KINDS[kind].size;
  const cells: PlanCell[] = [];
  for (let dz = 0; dz < d; dz++)
    for (let dx = 0; dx < w; dx++) {
      const g = ground(x0 + dx, z0 + dz);
      for (let yy = Math.max(g + 1, y - 3); yy < y; yy++) if (g >= 0) cells.push([x0 + dx, yy, z0 + dz, "b"]);
    }
  const wallRing = (h: number, door: [number, number] | null, windows: [number, number][] = [], kindAt?: (x: number, yy: number, z: number) => string) => {
    for (let yy = y; yy < y + h; yy++)
      for (let dz = 0; dz < d; dz++)
        for (let dx = 0; dx < w; dx++) {
          if (dx > 0 && dx < w - 1 && dz > 0 && dz < d - 1) continue;
          const x = x0 + dx;
          const z = z0 + dz;
          if (door && x === door[0] && z === door[1] && yy < y + 2) continue;
          const win = windows.some(([wx, wz]) => wx === x && wz === z) && yy > y && yy < y + h - 1;
          cells.push([x, yy, z, kindAt ? kindAt(x, yy, z) : win ? "g" : "b"]);
        }
  };
  if (kind === "house") {
    wallRing(3, [x0 + 2, z0], [[x0, z0 + 2], [x0 + 4, z0 + 2]]);
    cells.push(...rings(x0, z0, 5, 5, y + 3), [x0 + 1, y, z0 + 3, "t"]);
  } else if (kind === "lamp") {
    cells.push([x0, y, z0, "b"], [x0, y + 1, z0, "f"], [x0, y + 2, z0, "f"], [x0, y + 3, z0, "t"]);
  } else if (kind === "well") {
    for (let dz = 0; dz < 3; dz++) for (let dx = 0; dx < 3; dx++) if (dx !== 1 || dz !== 1) cells.push([x0 + dx, y, z0 + dz, "b"]);
    for (const [dx, dz] of [[0, 0], [2, 0], [0, 2], [2, 2]]) cells.push([x0 + dx, y + 1, z0 + dz, "f"], [x0 + dx, y + 2, z0 + dz, "f"]);
    cells.push(...rings(x0, z0, 3, 3, y + 3), [x0 + 1, y + 4, z0 + 1, "t"]);
  } else if (kind === "storehouse") {
    wallRing(3, [x0 + 2, z0]);
    cells.push(...rings(x0, z0, 5, 5, y + 3), [x0 + 1, y, z0 + 3, "c"], [x0 + 3, y, z0 + 3, "c"], [x0 + 1, y, z0 + 1, "t"]);
  } else if (kind === "market") {
    for (const [dx, dz] of [[0, 0], [4, 0], [0, 4], [4, 4]]) for (let yy = y; yy < y + 3; yy++) cells.push([x0 + dx, yy, z0 + dz, "f"]);
    cells.push(...rings(x0, z0, 5, 5, y + 3), [x0 + 2, y + 4, z0 + 2, "t"], [x0 + 2, y, z0 + 2, "c"]);
  } else if (kind === "hall") {
    wallRing(4, [x0 + 3, z0], [[x0 + 1, z0], [x0 + 5, z0], [x0, z0 + 3], [x0 + 6, z0 + 3], [x0 + 3, z0 + 6], [x0 + 1, z0 + 6], [x0 + 5, z0 + 6]]);
    cells.push(...rings(x0, z0, 7, 7, y + 4));
    for (const [dx, dz] of [[1, 1], [5, 1], [1, 5], [5, 5]]) cells.push([x0 + dx, y, z0 + dz, "t"]);
    cells.push([x0 + 3, y + 5, z0 + 3, "t"]);
  } else if (kind === "tower") {
    wallRing(7, [x0 + 1, z0]);
    cells.push(...rings(x0, z0, 3, 3, y + 7));
    for (const [dx, dz] of [[0, 0], [2, 0], [0, 2], [2, 2]]) cells.push([x0 + dx, y + 8, z0 + dz, "t"]);
  }
  return cells;
}

/** The wall round the base: a square `r` blocks out each way, two high on the ground it crosses, a gate three wide
 *  in the middle of each side. Water and anything already built are left as they are. */
export function wallPlan(cx: number, cz: number, r: number, ground: (x: number, z: number) => number): PlanCell[] {
  const cells: PlanCell[] = [];
  for (let k = -r; k <= r; k++)
    for (const [x, z] of [[cx + k, cz - r], [cx + k, cz + r], [cx - r, cz + k], [cx + r, cz + k]] as [number, number][]) {
      if (Math.abs(k) <= 1 && (Math.abs(x - cx) === r ? Math.abs(z - cz) <= 1 : Math.abs(x - cx) <= 1)) continue; // the gates
      const g = ground(x, z);
      if (g < 0) continue;
      cells.push([x, g + 1, z, "b"], [x, g + 2, z, "b"]);
    }
  const seen = new Set<string>();
  // round the square in one direction, the lower block of each column before the upper one
  const along = ([x, , z]: PlanCell) => (Math.atan2(z - cz, x - cx) + Math.PI * 2) % (Math.PI * 2);
  return cells.filter(([x, y, z]) => (seen.has(`${x},${y},${z}`) ? false : (seen.add(`${x},${y},${z}`), true))).sort((a, b) => along(a) - along(b) || a[1] - b[1]);
}
