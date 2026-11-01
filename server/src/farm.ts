// v7 farming, run by the server: wheat grows a stage at a time (faster on watered farmland, only in the light),
// sugar cane grows up to 3 tall beside water and falls when it loses it, and farmland is watered (dark) within 4
// blocks of water, dries out without it and, dry and bare, turns back to dirt. Every change here is the world's own
// (not a player's): it is saved like any other but kept out of the edit log.

import { B, isFarmland, isWheat, wheatAge } from "../../shared/blocks.ts";
import { hydratedAt } from "../../shared/farming.ts";
import { VOLUME, WORLD_HEIGHT, WORLD_SIZE, cellX, cellY, cellZ, idx } from "../../shared/constants.ts";
import { blockDrops } from "../../shared/mining.ts";
import { caneSupported } from "../../shared/shapes.ts";
import type { Stack } from "../../shared/items.ts";
import type { LightIndex } from "./light.ts";

type GetBlock = (x: number, y: number, z: number) => number;

/** Chances a second: a wheat stage on watered / dry farmland, a block of cane. Wheat ripens in about 5 minutes
 *  watered (7 stages at 45 s), 10 dry; cane grows a block about every 80 s. */
export const WHEAT_GROW_WET = 1 / 45;
export const WHEAT_GROW_DRY = 1 / 90;
export const CANE_GROW = 1 / 80;
export const CANE_MAX = 3;
/** Each farmland block is looked at about every 8 s (water nearby? dried out?). */
export const FARMLAND_CHECK = 1 / 8;

/** Water within 4 blocks across, at the farmland's level or one above (shared/farming.ts). */
export const hydrated = hydratedAt;

/** Enough light to grow: open sky above, or a lamp or torch close by (block light 9+). */
export function lightToGrow(light: LightIndex, x: number, y: number, z: number): boolean {
  return light.sky(x, y, z) || light.blockLight(x, y, z) >= 9;
}

export interface FarmHooks {
  /** Change a cell as the world (no edit log, no drops of its own). */
  set(i: number, id: number): void;
  /** Leave items on the ground (a crop knocked off, cane that lost its water). */
  drop(st: Stack, x: number, y: number, z: number): void;
}

export class FarmManager {
  readonly crops = new Set<number>(); // wheat cells
  readonly cane = new Set<number>(); // every sugar cane cell
  readonly farmland = new Set<number>();
  private get: GetBlock;
  private light: LightIndex;
  private hooks: FarmHooks;
  rand: () => number = Math.random;
  stats = { grown: 0, cane: 0, dried: 0, watered: 0, reverted: 0, fell: 0 };

  constructor(get: GetBlock, light: LightIndex, hooks: FarmHooks) {
    this.get = get;
    this.light = light;
    this.hooks = hooks;
  }

  /** Find everything that grows in a world (once, at start). */
  scan(world: Uint8Array): void {
    for (let i = 0; i < VOLUME; i++) {
      const id = world[i];
      if (id < B.FARMLAND || id > B.SUGAR_CANE) continue;
      this.changed(i, 0, id);
    }
  }

  /** A cell changed (any reason): keep the sets right. */
  changed(i: number, old: number, id: number): void {
    if (isWheat(old)) this.crops.delete(i);
    else if (old === B.SUGAR_CANE) this.cane.delete(i);
    else if (isFarmland(old)) this.farmland.delete(i);
    if (isWheat(id)) this.crops.add(i);
    else if (id === B.SUGAR_CANE) this.cane.add(i);
    else if (isFarmland(id)) this.farmland.add(i);
  }

  /** Once a second. */
  tick(): void {
    const r = this.rand;
    for (const i of [...this.crops]) {
      const id = this.get(cellX(i), cellY(i), cellZ(i));
      if (!isWheat(id)) {
        this.crops.delete(i);
        continue;
      }
      if (wheatAge(id) >= 7) continue;
      const x = cellX(i);
      const y = cellY(i);
      const z = cellZ(i);
      if (!lightToGrow(this.light, x, y, z)) continue;
      const wet = this.get(x, y - 1, z) === B.FARMLAND + 1;
      if (r() < (wet ? WHEAT_GROW_WET : WHEAT_GROW_DRY)) {
        this.hooks.set(i, id + 1);
        this.stats.grown++;
      }
    }
    for (const i of [...this.cane]) {
      const x = cellX(i);
      const y = cellY(i);
      const z = cellZ(i);
      if (this.get(x, y, z) !== B.SUGAR_CANE) {
        this.cane.delete(i);
        continue;
      }
      if (this.get(x, y - 1, z) === B.SUGAR_CANE) continue; // only the bottom of a stalk does the work
      if (!caneSupported(x, y, z, this.get)) {
        this.fell(x, y, z);
        continue;
      }
      let h = 1;
      while (h < CANE_MAX + 1 && this.get(x, y + h, z) === B.SUGAR_CANE) h++;
      if (h < CANE_MAX && y + h < WORLD_HEIGHT && this.get(x, y + h, z) === B.AIR && r() < CANE_GROW) {
        this.hooks.set(idx(x, y + h, z), B.SUGAR_CANE);
        this.stats.cane++;
      }
    }
    for (const i of [...this.farmland]) {
      if (r() >= FARMLAND_CHECK) continue;
      this.checkFarmland(i);
    }
  }

  /** Water nearby or not: dark when watered, dry without; dry and bare, it goes back to dirt now and then. */
  checkFarmland(i: number): void {
    const x = cellX(i);
    const y = cellY(i);
    const z = cellZ(i);
    const id = this.get(x, y, z);
    if (!isFarmland(id)) {
      this.farmland.delete(i);
      return;
    }
    const wet = hydrated(this.get, x, y, z);
    if (wet && id === B.FARMLAND) {
      this.hooks.set(i, B.FARMLAND + 1);
      this.stats.watered++;
    } else if (!wet && id === B.FARMLAND + 1) {
      this.hooks.set(i, B.FARMLAND);
      this.stats.dried++;
    } else if (!wet && id === B.FARMLAND && !isWheat(this.get(x, y + 1, z)) && this.rand() < 0.25) {
      this.hooks.set(i, B.DIRT);
      this.stats.reverted++;
    }
  }

  /** A stalk of cane lost its water or ground: it all comes down, as items. */
  private fell(x: number, y: number, z: number): void {
    for (let k = 0; k < CANE_MAX + 2 && this.get(x, y + k, z) === B.SUGAR_CANE; k++) {
      this.hooks.set(idx(x, y + k, z), B.AIR);
      this.hooks.drop({ id: B.SUGAR_CANE, n: 1, d: 0 }, x, y + k, z);
      this.stats.fell++;
    }
  }

  /** Farmland trampled or turned back: whatever grew on it is knocked off (its drops), then it is dirt. */
  toDirt(x: number, y: number, z: number): void {
    const above = this.get(x, y + 1, z);
    if (isWheat(above)) {
      this.hooks.set(idx(x, y + 1, z), B.AIR);
      for (const st of blockDrops(above, 0, this.rand)) this.hooks.drop(st, x, y + 1, z);
    }
    this.hooks.set(idx(x, y, z), B.DIRT);
  }

  /** Dev and tests: ripen the crops and fill out the cane within `r` blocks of (x, z). */
  growAll(x: number, z: number, r: number): number {
    let n = 0;
    for (const i of [...this.crops]) {
      if (Math.abs(cellX(i) - x) > r || Math.abs(cellZ(i) - z) > r) continue;
      const id = this.get(cellX(i), cellY(i), cellZ(i));
      if (isWheat(id) && wheatAge(id) < 7) {
        this.hooks.set(i, B.WHEAT + 7);
        n++;
      }
    }
    for (const i of [...this.cane]) {
      const cx = cellX(i);
      const cy = cellY(i);
      const cz = cellZ(i);
      if (Math.abs(cx - x) > r || Math.abs(cz - z) > r || this.get(cx, cy - 1, cz) === B.SUGAR_CANE) continue;
      for (let k = 1; k < CANE_MAX; k++) {
        if (cy + k >= WORLD_HEIGHT) break;
        const id = this.get(cx, cy + k, cz);
        if (id === B.SUGAR_CANE) continue;
        if (id !== B.AIR) break;
        this.hooks.set(idx(cx, cy + k, cz), B.SUGAR_CANE);
        n++;
      }
    }
    return n;
  }
}

export const inWorldXZ = (x: number, z: number) => x >= 0 && z >= 0 && x < WORLD_SIZE && z < WORLD_SIZE;
