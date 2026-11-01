// The server runs the water. Any block change next to water schedules the cells around it; every tick the cells
// that are due are re-evaluated with shared/water.ts and changed cells schedule their own neighbours 5 ticks later
// (the classic water speed). A budget per tick keeps a big flood from slowing the server; leftovers wait a tick.
// Pending updates are saved with the world, so water that was still running keeps running after a restart.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IS_WATER } from "../../shared/blocks.ts";
import { WORLD_HEIGHT, WORLD_SIZE, cellX, cellY, cellZ, idx } from "../../shared/constants.ts";
import { FLOW_TICKS, bounded, nextWater, type Get } from "../../shared/water.ts";

const BUCKETS = 16;
export const BUDGET = 2500; // cell evaluations per tick
export const TIME_BUDGET_MS = 6; // and at most this long per tick (a tick is 50 ms)

export class WaterSim {
  private buckets: Set<number>[] = Array.from({ length: BUCKETS }, () => new Set());
  private get: Get;
  private set: (i: number, id: number) => void;
  private path: string;
  /** Total cells changed by water since start (for /status-style diagnostics and tests). */
  changed = 0;
  evaluated = 0;

  constructor(get: Get, set: (i: number, id: number) => void, dir: string) {
    this.get = bounded(get);
    this.set = set;
    this.path = join(dir, "water.json");
  }

  get pending(): number {
    let n = 0;
    for (const b of this.buckets) n += b.size;
    return n;
  }

  /** Schedule one cell `delay` ticks from `tick`. */
  schedule(i: number, tick: number, delay = FLOW_TICKS): void {
    this.buckets[(tick + delay) % BUCKETS].add(i);
  }

  /** A block changed at cell i (by a player, an admin, or the water itself): wake the water around it. */
  touched(i: number, tick: number, delay = FLOW_TICKS): void {
    const x = cellX(i);
    const y = cellY(i);
    const z = cellZ(i);
    let near = IS_WATER[this.get(x, y, z)] === 1;
    const around: number[] = [];
    for (const [dx, dy, dz] of N6) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= WORLD_SIZE || nz >= WORLD_SIZE || ny < 0 || ny >= WORLD_HEIGHT) continue;
      if (IS_WATER[this.get(nx, ny, nz)]) near = true;
      around.push(idx(nx, ny, nz));
    }
    if (!near) return;
    this.schedule(i, tick, delay);
    for (const n of around) this.schedule(n, tick, delay);
  }

  /** Run the cells due this tick. */
  tick(tick: number): void {
    const bucket = this.buckets[tick % BUCKETS];
    if (!bucket.size) return;
    // Spread preferences are cached for the tick; a change made this tick re-schedules its neighbours anyway, so a
    // slightly stale preference is corrected 5 ticks later.
    const cache = new Map<number, number>();
    let budget = BUDGET;
    const t0 = performance.now();
    const carry: number[] = [];
    for (const i of bucket) {
      if (budget-- <= 0 || ((budget & 63) === 0 && performance.now() - t0 > TIME_BUDGET_MS)) {
        budget = 0;
        carry.push(i);
        continue;
      }
      this.evaluated++;
      const next = nextWater(this.get, cellX(i), cellY(i), cellZ(i), cache);
      if (next < 0) continue;
      this.set(i, next);
      this.changed++;
      this.touched(i, tick);
    }
    bucket.clear();
    for (const i of carry) this.schedule(i, tick, 1);
  }

  save(): void {
    const all: number[] = [];
    for (const b of this.buckets) for (const i of b) all.push(i);
    try {
      writeFileSync(this.path + ".tmp", JSON.stringify(all));
      renameSync(this.path + ".tmp", this.path);
    } catch {
      /* disk issues should not stop the game */
    }
  }

  load(tick: number): void {
    if (!existsSync(this.path)) return;
    try {
      const all = JSON.parse(readFileSync(this.path, "utf8")) as number[];
      for (const i of all) if (Number.isInteger(i) && i >= 0) this.schedule(i, tick, 1 + (i % FLOW_TICKS));
    } catch {
      /* ignore a broken file */
    }
  }

  clear(): void {
    for (const b of this.buckets) b.clear();
  }
}

const N6: [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
