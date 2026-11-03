// Ground pathfinding for mobs (animals now, night mobs later), like the classic walk-node navigation: a node is a
// spot where the body can stand (a floor under its centre and room for its box above), and a move between two
// neighbouring nodes is allowed when the body fits along the way:
//   - level or a step up to 0.6 (slabs, stairs): walk
//   - a rise of up to one full block: jump (needs head room over the start for the jump)
//   - a drop of up to 3 blocks: walk off
//   - diagonals only on level-ish ground, and never across a corner
// Fences (1.5 tall) can't be jumped, so pens hold. Water nodes are avoided by calm mobs and cost extra otherwise.
// Every probe uses the real collision shapes (slabs, stairs, doors, fences, panes), so it agrees with moveBody.

import { IS_WATER, SHAPE } from "../../shared/blocks.ts";
import { WORLD_HEIGHT, WORLD_SIZE } from "../../shared/constants.ts";
import { boxHitsSolid, type GetBlock } from "../../shared/physics.ts";
import { pushCollision, type Nb } from "../../shared/shapes.ts";

export const MAX_RISE = 1.05; // a full block (the jump peaks at 1.25)
export const STEP = 0.6; // walk up without jumping
export const MAX_DROP = 3.05;

export interface PathPoint {
  x: number; // cell
  z: number;
  f: number; // feet height
  water: boolean;
}

export interface SearchOpts {
  hw: number; // half width of the body
  h: number; // height of the body
  maxNodes: number;
  radius: number; // max horizontal distance from the start (cells)
  water: boolean; // may it enter water nodes?
  /** v9: head for the goal first (A*, an octile-distance estimate that never overestimates: the same best path,
   *  far fewer nodes on open ground). Villagers use it for their long walks home. */
  aim?: boolean;
  /** The deepest drop it walks off (default MAX_DROP). The AIs take up to 5 when healthy: a fall does no harm until
   *  it is more than SAFE_FALL (6), and at 3 a steep hillside was a wall to them. */
  drop?: number;
}

interface Cand {
  f: number;
  water: boolean;
}

const boxes: number[] = [];

export class PathFinder {
  private get: GetBlock;
  private nbX = 0;
  private nbY = 0;
  private nbZ = 0;
  private nb: Nb;
  private cols = new Map<number, Cand[]>();
  private hw = 0.45;
  private h = 1;
  private lo = 0;
  private hi = 0;
  /** Search statistics (tests and the load test). */
  lastNodes = 0;

  constructor(get: GetBlock) {
    this.get = get;
    this.nb = (dx, dy, dz) => {
      const x = this.nbX + dx;
      const y = this.nbY + dy;
      const z = this.nbZ + dz;
      if (x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE || y < 0 || y >= WORLD_HEIGHT) return 0;
      return this.get(x, y, z);
    };
  }

  private block(x: number, y: number, z: number): number {
    if (x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE || y < 0 || y >= WORLD_HEIGHT) return 0;
    return this.get(x, y, z);
  }

  private fits(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
    if (x0 < 0 || z0 < 0 || x1 > WORLD_SIZE || z1 > WORLD_SIZE || y0 < 0) return false;
    return !boxHitsSolid(this.get, x0, y0, z0, x1, y1, z1);
  }

  /** Spots in a column where the body can stand, between the search's height limits (cached per search). */
  private column(x: number, z: number): Cand[] {
    const key = x | (z << 9);
    const hit = this.cols.get(key);
    if (hit) return hit;
    const out: Cand[] = [];
    if (x >= 0 && z >= 0 && x < WORLD_SIZE && z < WORLD_SIZE) {
      const cx = x + 0.5;
      const cz = z + 0.5;
      const hw = this.hw;
      for (let y = Math.min(WORLD_HEIGHT - 2, this.hi); y >= Math.max(0, this.lo); y--) {
        const id = this.block(x, y, z);
        const kind = SHAPE[id];
        if (kind === 0) continue;
        let top = -1;
        if (kind === 1) top = y + 1;
        else {
          // the highest collision box under the column's centre
          boxes.length = 0;
          this.nbX = x;
          this.nbY = y;
          this.nbZ = z;
          pushCollision(id, x, y, z, this.nb, boxes);
          for (let i = 0; i < boxes.length; i += 6) {
            if (boxes[i] < cx + 0.05 && boxes[i + 3] > cx - 0.05 && boxes[i + 2] < cz + 0.05 && boxes[i + 5] > cz - 0.05) top = Math.max(top, boxes[i + 4]);
          }
          if (top < 0) continue;
        }
        if (!this.fits(cx - hw, top + 0.01, cz - hw, cx + hw, top + this.h, cz + hw)) continue;
        // water around the lower half of the body
        let water = false;
        for (let wy = Math.floor(top); wy <= Math.floor(top + this.h * 0.5) && !water; wy++) water = IS_WATER[this.block(x, wy, z)] === 1;
        out.push({ f: top, water });
      }
    }
    this.cols.set(key, out);
    return out;
  }

  /** Can the body go from (ax, az, fa) to the neighbouring column (bx, bz) at fb? */
  private edge(ax: number, az: number, fa: number, bx: number, bz: number, fb: number): boolean {
    const hw = Math.min(this.hw, 0.45);
    const top = Math.max(fa, fb);
    const x0 = Math.min(ax, bx) + 0.5 - hw;
    const x1 = Math.max(ax, bx) + 0.5 + hw;
    const z0 = Math.min(az, bz) + 0.5 - hw;
    const z1 = Math.max(az, bz) + 0.5 + hw;
    if (!this.fits(x0, top + 0.01, z0, x1, top + this.h, z1)) return false;
    // A jump needs head room over the start for the arc.
    if (fb - fa > STEP && !this.fits(ax + 0.5 - hw, fa + 0.01, az + 0.5 - hw, ax + 0.5 + hw, fb + this.h + 0.2, az + 0.5 + hw)) return false;
    return true;
  }

  /** The node a body at (x, y, z) stands on (its centre column, else a column under its box), or null (mid-air). */
  startNode(x: number, y: number, z: number, hw: number, h: number): PathPoint | null {
    this.begin(hw, h, y);
    const tryCol = (cx: number, cz: number, tol: number): PathPoint | null => {
      let best: Cand | null = null;
      for (const c of this.column(cx, cz)) if (Math.abs(c.f - y) <= tol && (!best || Math.abs(c.f - y) < Math.abs(best.f - y))) best = c;
      return best ? { x: cx, z: cz, f: best.f, water: best.water } : null;
    };
    const fx = Math.floor(x);
    const fz = Math.floor(z);
    const s = tryCol(fx, fz, 0.65);
    if (s) return s;
    // Standing on an edge: the body's centre is over a gap, so use a column the box touches.
    for (const [ox, oz] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const cx = fx + ox;
      const cz = fz + oz;
      if (x + hw <= cx || x - hw >= cx + 1 || z + hw <= cz || z - hw >= cz + 1) continue;
      const n = tryCol(cx, cz, 0.12);
      if (n) return n;
    }
    return null;
  }

  /** A dry spot in this column a body in water at height y could climb out onto (call reset() first). */
  dryNear(x: number, z: number, y: number): PathPoint | null {
    for (const c of this.column(x, z)) if (!c.water && c.f >= y - 1 && c.f <= y + 1.6) return { x, z, f: c.f, water: false };
    return null;
  }

  /** Start a new query: body size and the height band to scan (clears the column cache). */
  reset(hw: number, h: number, y: number): void {
    this.begin(hw, h, y);
  }

  private begin(hw: number, h: number, y: number): void {
    this.cols.clear();
    this.hw = hw;
    this.h = h;
    this.lo = Math.floor(y) - 12;
    this.hi = Math.floor(y) + 8;
  }

  /**
   * Dijkstra from the start over walkable nodes, up to `maxNodes` and `radius`. Returns the explored nodes with
   * their path cost and parent, or null if the body is not standing anywhere (mid-air).
   */
  search(x: number, y: number, z: number, o: SearchOpts, goal?: { x: number; z: number; y?: number }): Search | null {
    const start = this.startNode(x, y, z, o.hw, o.h);
    if (!start) return null;
    const s = new Search(start);
    const heap = new Heap();
    const est = goal && o.aim ? (x: number, z: number) => {
      const ax = Math.abs(x - goal.x);
      const az = Math.abs(z - goal.z);
      return Math.max(ax, az) + 0.414 * Math.min(ax, az);
    } : () => 0;
    heap.push(0, 0);
    const done = new Uint8Array(o.maxNodes + 64);
    while (heap.size) {
      const i = heap.pop();
      if (done[i]) continue;
      done[i] = 1;
      const p = s.pts[i];
      // with a height, the column alone isn't the goal: a cave under a house is not the house
      if (goal && p.x === goal.x && p.z === goal.z && (goal.y === undefined || Math.abs(p.f - goal.y) <= 2.5)) {
        s.reached = i;
        break;
      }
      if (s.pts.length >= o.maxNodes) continue;
      for (let dir = 0; dir < 8; dir++) {
        const dx = DX[dir];
        const dz = DZ[dir];
        const nx = p.x + dx;
        const nz = p.z + dz;
        if (Math.abs(nx - start.x) > o.radius || Math.abs(nz - start.z) > o.radius) continue;
        const diag = dir >= 4;
        // highest reachable spot in the neighbour column first (walk on the surface, not into caves below)
        let chosen: Cand | null = null;
        for (const c of this.column(nx, nz)) {
          const d = c.f - p.f;
          if (d > MAX_RISE || d < -(o.drop ?? MAX_DROP)) continue;
          if (diag && Math.abs(d) > STEP) continue;
          if (c.water && !o.water && !p.water) continue;
          if (!this.edge(p.x, p.z, p.f, nx, nz, c.f)) continue;
          chosen = c;
          break;
        }
        if (!chosen) continue;
        const d = chosen.f - p.f;
        let cost = diag ? 1.414 : 1;
        if (d > STEP) cost += 1.2;
        if (d < -0.6) cost += -d * 0.4;
        if (d < -MAX_DROP) cost += (-d - MAX_DROP) * 2; // a drop past the usual only where there's no gentler way
        if (chosen.water) cost += 5;
        const g = s.cost[i] + cost;
        const key = nodeKey(nx, nz, chosen.f);
        const j = s.index.get(key);
        if (j === undefined) {
          if (s.pts.length >= o.maxNodes + 60) continue;
          const k = s.add({ x: nx, z: nz, f: chosen.f, water: chosen.water }, g, i);
          heap.push(k, g + est(nx, nz));
        } else if (!done[j] && g < s.cost[j]) {
          s.cost[j] = g;
          s.parent[j] = i;
          heap.push(j, g + est(nx, nz));
        }
      }
    }
    this.lastNodes = s.pts.length;
    return s;
  }
}

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DZ = [0, 0, 1, -1, 1, -1, 1, -1];
const nodeKey = (x: number, z: number, f: number) => x + z * 512 + Math.round(f * 16) * 262144;

export class Search {
  pts: PathPoint[] = [];
  cost: number[] = [];
  parent: number[] = [];
  index = new Map<number, number>();
  reached = -1;

  constructor(start: PathPoint) {
    this.add(start, 0, -1);
  }

  add(p: PathPoint, cost: number, parent: number): number {
    const i = this.pts.length;
    this.pts.push(p);
    this.cost.push(cost);
    this.parent.push(parent);
    this.index.set(nodeKey(p.x, p.z, p.f), i);
    return i;
  }

  /** The path from the start (excluded) to node i. */
  pathTo(i: number): PathPoint[] {
    const out: PathPoint[] = [];
    for (let k = i; k > 0; k = this.parent[k]) out.push(this.pts[k]);
    return out.reverse();
  }

  /** The explored node closest to (x, z), and to height y when given (a partial path when the goal can't be reached). */
  closestTo(x: number, z: number, y?: number): number {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < this.pts.length; i++) {
      const p = this.pts[i];
      const d = (p.x + 0.5 - x) ** 2 + (p.z + 0.5 - z) ** 2 + (y === undefined ? 0 : (p.f - y) ** 2) + this.cost[i] * 0.01;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }
}

/** Minimal binary heap of (node, cost). */
class Heap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size(): number {
    return this.ids.length;
  }
  push(id: number, key: number): void {
    const ids = this.ids;
    const keys = this.keys;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p];
      keys[i] = keys[p];
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }
  pop(): number {
    const ids = this.ids;
    const keys = this.keys;
    const top = ids[0];
    const lastId = ids.pop()!;
    const lastKey = keys.pop()!;
    const n = ids.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= lastKey) break;
        ids[i] = ids[c];
        keys[i] = keys[c];
        i = c;
      }
      ids[i] = lastId;
      keys[i] = lastKey;
    }
    return top;
  }
}
