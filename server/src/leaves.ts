// Leaves decay, the way they do in the real game: a tree's leaves need a log near them, at most 6 steps away going
// through leaves. When a log goes (a tree cut down), the leaves of its canopy are looked at one by one over the next
// seconds to a minute, and each one with no log left in reach withers away, dropping what a leaf broken by hand
// drops (a sapling 1 in 20, a stick 1 in 50, an apple from an oak 1 in 200: shared/mining.ts). A leaf that goes, or
// is broken, has the tree's leaves round it looked at again, so a canopy goes all the way whatever order its logs
// and leaves come down in. Only a tree's own leaves: the leaves a player put down never decay, and leaves that were
// never joined to a cut log through leaves (the hub's hedges, the green on a ruin's walls) are never looked at.
// What it remembers (the leaves put down, the trees' leaves, the ones still to look at) is kept in leaves.json.
// Every change here is the world's own: saved like any other, kept out of the edit log.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { B } from "../../shared/blocks.ts";
import { WORLD_HEIGHT, WORLD_SIZE, cellX, cellY, cellZ, idx } from "../../shared/constants.ts";
import type { Stack } from "../../shared/items.ts";
import { blockDrops } from "../../shared/mining.ts";

type GetBlock = (x: number, y: number, z: number) => number;

/** A leaf stays while a log is at most this many steps from it through leaves (the real game's 6). */
export const LEAF_REACH = 6;
/** A woken leaf is looked at between DECAY_MIN and DECAY_MIN + the spread ms later (LEAF_DECAY_MS sets the spread:
 *  the tests make it short); the leaves round one that went, within a quarter of that. */
export const DECAY_MIN = 1500;
export const DECAY_SPREAD = Number(process.env.LEAF_DECAY_MS) > 0 ? Number(process.env.LEAF_DECAY_MS) : 40000;

export const isLeaves = (id: number): boolean => id === B.OAK_LEAVES || id === B.BIRCH_LEAVES || id === B.PALM_LEAVES;
export const isLog = (id: number): boolean => id === B.OAK_LOG || id === B.BIRCH_LOG || id === B.PALM_LOG;

const N6: readonly (readonly [number, number, number])[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const inside = (x: number, y: number, z: number): boolean => x >= 0 && z >= 0 && x < WORLD_SIZE && z < WORLD_SIZE && y >= 0 && y < WORLD_HEIGHT;

export interface LeafHooks {
  /** Change a cell as the world (no edit log). */
  set(i: number, id: number): void;
  /** Leave items on the ground. */
  drop(st: Stack, x: number, y: number, z: number): void;
}

export class LeafDecay {
  /** Leaves a player put down: they never decay. */
  readonly placed = new Set<number>();
  /** A cut tree's leaves (joined through leaves to a log that went): the only ones that are ever looked at. */
  readonly tree = new Set<number>();
  /** Leaves to look at, and when (ms since the epoch). */
  readonly due = new Map<number, number>();
  rand: () => number = Math.random;
  stats = { woken: 0, kept: 0, decayed: 0 };
  private get: GetBlock;
  private hooks: LeafHooks;
  private path: string | null;
  private dirty = false;
  /** A leaf going in tick(): it wakes the leaves round it itself (with its own clock). */
  private decaying = false;

  constructor(get: GetBlock, hooks: LeafHooks, dir: string | null) {
    this.get = get;
    this.hooks = hooks;
    this.path = dir ? join(dir, "leaves.json") : null;
  }

  /** A cell changed: a leaf a player put down is kept for good; a log that's gone wakes its canopy (those leaves are
   *  a tree's from now on); a leaf that's gone wakes the tree's leaves round it. */
  changed(i: number, old: number, id: number, byPlayer: boolean, now = Date.now()): void {
    if (isLeaves(id) && byPlayer) {
      this.placed.add(i);
      this.tree.delete(i);
      this.dirty = true;
    } else if (this.placed.delete(i)) this.dirty = true;
    if (isLog(old) && !isLog(id)) this.reach(cellX(i), cellY(i), cellZ(i), now, true, DECAY_SPREAD);
    else if (isLeaves(old) && !isLeaves(id)) {
      if (this.tree.delete(i)) this.dirty = true;
      if (!this.decaying) this.reach(cellX(i), cellY(i), cellZ(i), now, false, DECAY_SPREAD / 4);
    }
  }

  /** The leaves joined through leaves to (x, y, z), out to the reach, get a look at a random time within `spread`
   *  ms: all of them when a log stood there (they are a tree's: `mark`), else only a tree's. How many were woken. */
  reach(x: number, y: number, z: number, now: number, mark: boolean, spread: number): number {
    const seen = new Set<number>();
    let front: [number, number, number][] = [[x, y, z]];
    for (let d = 1; d <= LEAF_REACH && front.length; d++) {
      const next: [number, number, number][] = [];
      for (const [cx, cy, cz] of front)
        for (const [dx, dy, dz] of N6) {
          const nx = cx + dx;
          const ny = cy + dy;
          const nz = cz + dz;
          if (!inside(nx, ny, nz) || !isLeaves(this.get(nx, ny, nz))) continue;
          const c = idx(nx, ny, nz);
          if (seen.has(c)) continue;
          seen.add(c);
          next.push([nx, ny, nz]);
        }
      front = next;
    }
    let n = 0;
    for (const c of seen) {
      if (this.placed.has(c)) continue;
      if (mark && !this.tree.has(c)) {
        this.tree.add(c);
        this.dirty = true;
      }
      if (this.tree.has(c) && this.schedule(c, now, spread)) n++;
    }
    this.stats.woken += n;
    return n;
  }

  /** A leaf to look at within `spread` ms (unless it's due already). */
  private schedule(c: number, now: number, spread: number): boolean {
    if (this.due.has(c)) return false;
    this.due.set(c, now + DECAY_MIN + this.rand() * spread);
    this.dirty = true;
    return true;
  }

  /** Is a log at most LEAF_REACH steps from this leaf, going through leaves? */
  supported(x: number, y: number, z: number): boolean {
    const seen = new Set<number>([idx(x, y, z)]);
    let front: [number, number, number][] = [[x, y, z]];
    for (let d = 1; d <= LEAF_REACH && front.length; d++) {
      const next: [number, number, number][] = [];
      for (const [cx, cy, cz] of front)
        for (const [dx, dy, dz] of N6) {
          const nx = cx + dx;
          const ny = cy + dy;
          const nz = cz + dz;
          if (!inside(nx, ny, nz)) continue;
          const id = this.get(nx, ny, nz);
          if (isLog(id)) return true;
          if (!isLeaves(id)) continue;
          const c = idx(nx, ny, nz);
          if (seen.has(c)) continue;
          seen.add(c);
          next.push([nx, ny, nz]);
        }
      front = next;
    }
    return false;
  }

  /** Look at the leaves that are due (once a second is plenty): each with no log in reach withers away (the leaves
   *  touching it become the tree's too, so a canopy longer than the reach goes all the way). How many went. */
  tick(now = Date.now(), max = 400): number {
    let n = 0;
    for (const [c, t] of this.due) {
      if (t > now) continue;
      this.due.delete(c);
      this.dirty = true;
      const x = cellX(c);
      const y = cellY(c);
      const z = cellZ(c);
      const id = this.get(x, y, z);
      if (!isLeaves(id) || this.placed.has(c) || !this.tree.has(c)) continue;
      if (this.supported(x, y, z)) {
        this.stats.kept++;
        continue;
      }
      for (const [dx, dy, dz] of N6) {
        const nx = x + dx;
        const ny = y + dy;
        const nz = z + dz;
        if (!inside(nx, ny, nz) || !isLeaves(this.get(nx, ny, nz))) continue;
        const nc = idx(nx, ny, nz);
        if (!this.placed.has(nc)) this.tree.add(nc);
      }
      this.decaying = true;
      try {
        this.hooks.set(c, B.AIR);
      } finally {
        this.decaying = false;
      }
      if (this.tree.delete(c)) this.dirty = true;
      for (const st of blockDrops(id, 0, this.rand)) this.hooks.drop(st, x, y, z);
      this.stats.decayed++;
      // the tree's leaves round it, soon
      this.reach(x, y, z, now, false, DECAY_SPREAD / 4);
      if (++n >= max) break;
    }
    return n;
  }

  /** A world from before leaf decay (no leaves.json yet), from its edit log: the leaves players put down (the last
   *  edit of each cell decides, and only cells that still hold leaves count), and the canopies of the trees cut
   *  before, woken now so the ones left hanging go over the next minute. */
  seed(entries: Iterable<{ i: number; o?: number; n: number; k: string }>, world: Uint8Array, now = Date.now()): number {
    const cut = new Set<number>();
    for (const e of entries) {
      if (isLeaves(e.n) && e.k !== "admin") this.placed.add(e.i);
      else this.placed.delete(e.i);
      if (e.o !== undefined && isLog(e.o) && !isLog(e.n)) cut.add(e.i);
    }
    for (const c of [...this.placed]) if (!isLeaves(world[c])) this.placed.delete(c);
    this.dirty = true;
    let n = 0;
    for (const c of cut) if (!isLog(world[c])) n += this.reach(cellX(c), cellY(c), cellZ(c), now, true, DECAY_SPREAD);
    return n;
  }

  save(now = Date.now()): void {
    if (!this.path || !this.dirty) return;
    try {
      // (the trees' leaves that are gone are dropped as it goes; the ones left are the canopies still standing by a
      // cut tree)
      const due = [...this.due].map(([c, t]) => [c, Math.max(0, Math.round(t - now))]);
      writeFileSync(this.path + ".tmp", JSON.stringify({ placed: [...this.placed], tree: [...this.tree], due }));
      renameSync(this.path + ".tmp", this.path);
      this.dirty = false;
    } catch {
      /* disk issues should not stop the game */
    }
  }

  /** Back from leaves.json; false when there is none yet. */
  load(now = Date.now()): boolean {
    if (!this.path || !existsSync(this.path)) return false;
    try {
      const d = JSON.parse(readFileSync(this.path, "utf8")) as { placed?: number[]; tree?: number[]; due?: [number, number][] };
      for (const c of d.placed ?? []) if (Number.isInteger(c) && c >= 0) this.placed.add(c);
      for (const c of d.tree ?? []) if (Number.isInteger(c) && c >= 0) this.tree.add(c);
      for (const [c, ms] of d.due ?? []) if (Number.isInteger(c) && c >= 0) this.due.set(c, now + Math.max(0, Number(ms) || 0));
    } catch {
      /* a broken file: start without it */
    }
    return true;
  }
}
