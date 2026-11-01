// Flowing water, the classic way. A source (WATER) never runs dry; water it feeds spreads level 1, 2 ... 7 across the
// ground (each step one level thinner), always falls when it can (falling water has water right above it), and only
// spreads sideways where it cannot fall. When water spreads it prefers the directions that lead to the nearest drop
// within 4 blocks, so streams pour off ledges instead of flooding in diamonds. Two sources side by side over solid
// ground (or over a source) make a new source, so a dug pool fills up for good. Cut the source and the flow drains.
//
// This file is pure rules: `nextWater` says what one cell should become. The server schedules cells (every 5 ticks,
// like the classic water speed) and applies the result; clients only draw the levels and feel the current.

import { B, IS_WATER } from "./blocks.ts";
import { WORLD_HEIGHT, WORLD_SIZE } from "./constants.ts";

export type Get = (x: number, y: number, z: number) => number;

export const FLOW_TICKS = 5;
export const MAX_LEVEL = 7;
export const isWater = (id: number) => IS_WATER[id] === 1;
export const isSource = (id: number) => id === B.WATER;
export const isFall = (id: number) => id === B.WATER_FALL;
export const flowId = (level: number) => B.WATER_FLOW + level - 1;

/** 0 for a source or falling water (full strength), 1..7 for flowing water, -1 for anything else. */
export function levelOf(id: number): number {
  if (id === B.WATER || id === B.WATER_FALL) return 0;
  if (id >= B.WATER_FLOW && id < B.WATER_FLOW + MAX_LEVEL) return id - B.WATER_FLOW + 1;
  return -1;
}

/** Surface height inside the cell (0..1) for drawing and swimming. Water with water above it is full. */
export function surfaceHeight(id: number, above: number): number {
  if (isWater(above)) return 1;
  if (id === B.WATER || id === B.WATER_FALL) return 14 / 16;
  const l = levelOf(id);
  return l < 0 ? 0 : (8 - l) / 9; // level 1: 0.78 ... level 7: 0.11
}

/** Things flowing water washes away or runs into: air, plants, torches, crops (v7: wheat; it drops its seeds),
 *  and other non-source water. */
export function passable(id: number): boolean {
  return id === B.AIR || id === B.TALL_GRASS || id === B.DANDELION || id === B.POPPY || id === B.BLUEBELL || id === B.TORCH || (id >= B.WHEAT && id < B.WHEAT + 8) || (isWater(id) && id !== B.WATER);
}

const DIRS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const inW = (x: number, y: number, z: number) => x >= 0 && z >= 0 && x < WORLD_SIZE && z < WORLD_SIZE && y >= 0 && y < WORLD_HEIGHT;

/** Wraps a getter so outside the world reads as solid stone (water never leaks off the map). */
export function bounded(get: Get): Get {
  return (x, y, z) => (inW(x, y, z) ? get(x, y, z) : B.STONE);
}

/** Can water at (x, y, z) fall into the cell below? */
export function canFall(get: Get, x: number, y: number, z: number): boolean {
  return y > 0 && passable(get(x, y - 1, z));
}

/** Bit mask of the sideways directions (DIRS order) water at (x, y, z) spreads to: the ones leading to the nearest
 *  drop within 4 blocks, or every open direction when there is no drop nearby. */
export function spreadMask(get: Get, x: number, y: number, z: number, cache?: Map<number, number>): number {
  const key = ((y * WORLD_SIZE + z) * WORLD_SIZE + x) | 0;
  const hit = cache?.get(key);
  if (hit !== undefined) return hit;
  let best = 99;
  let mask = 0;
  let open = 0;
  for (let d = 0; d < 4; d++) {
    const nx = x + DIRS[d][0];
    const nz = z + DIRS[d][1];
    const id = get(nx, y, nz);
    if (!passable(id) || isFall(id)) continue;
    open |= 1 << d;
    const dist = dropDistance(get, nx, y, nz, x, z);
    if (dist < best) {
      best = dist;
      mask = 1 << d;
    } else if (dist === best) mask |= 1 << d;
  }
  const out = best === 99 ? open : mask;
  cache?.set(key, out);
  return out;
}

// Scratch space for the drop search: a 11 x 11 window around the start, reused (no allocation per call).
const SEEN = new Uint32Array(121);
let seenStamp = 0;
const QX = new Int32Array(128);
const QZ = new Int32Array(128);
const QD = new Uint8Array(128);

/** Steps from (x, y, z) to the nearest cell water could fall from, over open floor, up to 4; 99 when none. */
function dropDistance(get: Get, x: number, y: number, z: number, fromX: number, fromZ: number): number {
  if (canFall(get, x, y, z)) return 0;
  // Small breadth-first search on this level, not going back through the cell the water comes from.
  seenStamp++;
  if (seenStamp >= 0xffffffff) {
    SEEN.fill(0);
    seenStamp = 1;
  }
  const mark = (cx: number, cz: number) => {
    const lx = cx - x + 5;
    const lz = cz - z + 5;
    if (lx < 0 || lz < 0 || lx > 10 || lz > 10) return false;
    const k = lz * 11 + lx;
    if (SEEN[k] === seenStamp) return false;
    SEEN[k] = seenStamp;
    return true;
  };
  mark(fromX, fromZ);
  mark(x, z);
  let head = 0;
  let tail = 0;
  QX[tail] = x;
  QZ[tail] = z;
  QD[tail++] = 0;
  while (head < tail) {
    const cx = QX[head];
    const cz = QZ[head];
    const d = QD[head++];
    if (d >= 4) continue;
    for (let k = 0; k < 4; k++) {
      const nx = cx + DIRS[k][0];
      const nz = cz + DIRS[k][1];
      if (!mark(nx, nz)) continue;
      const id = get(nx, y, nz);
      if (!passable(id) || isFall(id)) continue;
      if (canFall(get, nx, y, nz)) return d + 1;
      if (tail < 128) {
        QX[tail] = nx;
        QZ[tail] = nz;
        QD[tail++] = d + 1;
      }
    }
  }
  return 99;
}

/**
 * What the cell at (x, y, z) should hold now, given its neighbours. Returns the new block id, or -1 to leave it.
 * Only water and things water can replace are ever changed; sources stay sources.
 */
export function nextWater(get: Get, x: number, y: number, z: number, cache?: Map<number, number>): number {
  const cur = get(x, y, z);
  if (cur === B.WATER || !passable(cur)) return -1;
  const above = y + 1 < WORLD_HEIGHT ? get(x, y + 1, z) : B.AIR;
  let next: number;
  if (isWater(above)) {
    next = B.WATER_FALL;
  } else {
    let best = 99;
    let sources = 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DIRS[d][0];
      const nz = z + DIRS[d][1];
      const id = get(nx, y, nz);
      if (!isWater(id)) continue;
      if (id === B.WATER) sources++;
      const lvl = levelOf(id);
      if (lvl >= MAX_LEVEL) continue;
      // The neighbour only spreads sideways if it cannot fall, and only in its preferred directions.
      if (canFall(get, nx, y, nz)) continue;
      const back = d ^ 1; // from the neighbour toward us
      if (!(spreadMask(get, nx, y, nz, cache) & (1 << back))) continue;
      if (lvl + 1 < best) best = lvl + 1;
    }
    const below = y > 0 ? get(x, y - 1, z) : B.STONE;
    if (sources >= 2 && (below === B.WATER || !passable(below))) next = B.WATER;
    else if (best <= MAX_LEVEL) next = flowId(best);
    else next = isWater(cur) ? B.AIR : cur;
  }
  return next === cur ? -1 : next;
}

/** The current at a point: which way (and how hard) flowing water pushes, in blocks per tick (x, z). */
export function flowAt(get: Get, x: number, y: number, z: number): [number, number] {
  const bx = Math.floor(x);
  const by = Math.floor(y);
  const bz = Math.floor(z);
  const id = get(bx, by, bz);
  const me = levelOf(id);
  if (me < 0) return [0, 0];
  let fx = 0;
  let fz = 0;
  for (const [dx, dz] of DIRS) {
    const n = get(bx + dx, by, bz + dz);
    const ln = levelOf(n);
    if (ln >= 0) {
      fx += dx * (ln - me);
      fz += dz * (ln - me);
    } else if (passable(n)) {
      // open edge: water pours that way
      fx += dx * (8 - me) * 0.5;
      fz += dz * (8 - me) * 0.5;
    }
  }
  const len = Math.hypot(fx, fz);
  if (len < 1e-6 || id === B.WATER) return [0, 0];
  return [(fx / len) * 0.014, (fz / len) * 0.014];
}
