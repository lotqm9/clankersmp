// The town plan: where things go. The town is laid out round a fixed centre: the plaza square in the middle (9 by 9),
// four main streets (3 wide) running out of its sides, north, east, south and west, and a ring road further out that
// crosses them, the buildings on lots along the streets, fronts to the street a step back from it, like a real town's
// frontage. Each kind has its district: the hall, the market, the tavern, the chapel and the library round the square,
// the smithy and the bakery down the market street (east and west), houses up and down the streets and round the
// ring, the watchtowers, the barn and the keep further out, the cathedral or the keep at the head of a street facing
// back down it to the plaza. The wall goes round the old town with its four gates where the main streets go through.
// What can't go on a lot (the ground is steep, wet or wooded there, the streets are full) falls back to the nearest
// open ground, so the town never stops growing.
//
// Harmony: each main street and the sides of the rings it crosses are one district in one style (the north avenue
// stone, the market streets timber-framed, the south street oak, birch for the district on the side of the town the
// birch woods are: the brain chooses), so every building on a street is of a piece; the houses step down from tall
// two-storey townhouses round the middle through cottages and lodges inside the wall to longhouses, farmhouses and
// huts at the edge; the designs go in a rhythm along a street, the same on both sides (a lot across the street from
// a building of its kind is taken first), so the streets come in pairs. The catalog's street furniture (benches,
// flower beds) goes in the row beside the streets, a gatehouse over a gate of the wall, an arch across an avenue.
//
// Pure geometry: the brain (agents/brain.ts) gives it the ground (fits) and what's built.

import { DESIGNS, KINDS, ONCE, doorStep, sizeFacing, type Building, type Kind, type Plain } from "./civ.ts";
import { KIND_INFO, type District } from "./catalog.ts";
import type { PlanCell, Rect } from "./body.ts";

/** The plaza: PLAZA_HALF each way from the centre. */
export const PLAZA_HALF = 4;
/** The streets: STREET_HALF each side of their middle line (3 wide). */
export const STREET_HALF = 1;
/** How far out the main streets go at most. */
export const REACH = 100;
/** The landmarks at the heads of main streets, their lots kept for them from the start: the cathedral at the head of
 *  the north street (the avenue up to it), the keep at the head of the west street, just outside the outer ring. */
export const HEADS: Partial<Record<Kind, { arm: number; t: number }>> = { cathedral: { arm: 0, t: 76 }, keep: { arm: 3, t: 76 } };
/** The ring roads: squares this far out from the centre, the inner one just inside the wall, the outer one round the
 *  new town outside it. */
export const RINGS = [24, 48, 72];
/** The wall: a square just outside the inner ring road, its gates where the main streets go through. */
export const WALL = RINGS[0] + STREET_HALF + 2;
/** The four main streets, as steps out of the plaza: north, east, south, west. */
export const ARMS: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const DIRS = ["north", "east", "south", "west"];

export interface Point {
  x: number;
  z: number;
}

/** A street: a line from `o` along `d`, from t0 to t1 out along it, joined to the rest at `join` (the plaza's edge for a
 *  main street, the crossing with a main street for a side of the ring). */
export interface Street {
  o: Point;
  d: [number, number];
  t0: number;
  t1: number;
  join: number;
  name: string;
  /** The main street it is (0-3), or -1 for a side of a ring. */
  arm: number;
  /** A side of a ring: how far out that ring is. */
  ring?: number;
}

/** The town's streets round a centre: the four main streets, then the sides of the rings (worked out once per centre). */
const streetCache = new Map<string, Street[]>();
export function streetsOf(c: Point): Street[] {
  const key = `${c.x},${c.z}`;
  const hit = streetCache.get(key);
  if (hit) return hit;
  const made = makeStreets(c);
  streetCache.set(key, made);
  return made;
}
function makeStreets(c: Point): Street[] {
  const out: Street[] = ARMS.map((d, arm) => ({ o: c, d, t0: PLAZA_HALF + 1, t1: REACH, join: PLAZA_HALF + 1, name: `the ${DIRS[arm]} street`, arm }));
  // each ring's sides, run clockwise from a corner, crossed by a main street in the middle
  RINGS.forEach((R, ri) => {
    const corners: Point[] = [{ x: c.x - R, z: c.z - R }, { x: c.x + R, z: c.z - R }, { x: c.x + R, z: c.z + R }, { x: c.x - R, z: c.z + R }];
    for (let k = 0; k < 4; k++) out.push({ o: corners[k], d: ARMS[(k + 1) % 4], t0: 0, t1: 2 * R, join: R, name: `the ${["inner", "outer", "far"][ri]} ring road (${DIRS[k]} side)`, arm: -1, ring: R });
  });
  return out;
}

/** A lot for a building: its rectangle, the way its front faces, and where it is in the plan. */
export interface Lot extends Rect {
  face: number;
  /** The street it fronts (an index into streetsOf), which side of it (0: across its head), how far along it it
   *  starts, how far it is from the centre. */
  street: number;
  side: number;
  t: number;
  out: number;
  /** In words, for the AIs: "on the east street". */
  where: string;
  /** Set back this much further from the street than the one cell for the door step. */
  back?: number;
  /** The design that goes on it (the street's style, the size for how far out it is). */
  design?: string;
}

/** Where each kind belongs: how far out from the plaza (near to far), which main streets it likes best (none: any),
 *  whether it can stand at the head of a street, and the district's name. */
type Dist = { near: number; far: number; arms?: number[]; head?: boolean; name: string };
const DISTRICT: Record<string, Dist> = {
  well: { near: 6, far: 12, name: "by the plaza" },
  hall: { near: 6, far: 14, name: "on the square" },
  market: { near: 6, far: 18, arms: [1, 3], name: "on the square" },
  tavern: { near: 6, far: 22, arms: [1, 3], name: "on the square" },
  chapel: { near: 6, far: 24, arms: [0, 2], name: "on the square" },
  library: { near: 6, far: 24, arms: [0, 2], name: "on the square" },
  storehouse: { near: 6, far: 18, name: "by the plaza" },
  fountain: { near: 6, far: 20, name: "by the plaza" },
  monument: { near: 8, far: 44, name: "along the streets" },
  smithy: { near: 10, far: 36, arms: [1, 3], name: "on the market street" },
  bakery: { near: 8, far: 32, arms: [1, 3], name: "on the market street" },
  house: { near: 14, far: 70, arms: [0, 2], name: "among the houses" },
  tower: { near: 26, far: 72, name: "at the edge of the town" },
  barn: { near: 30, far: 74, name: "out by the fields" },
  keep: { near: 30, far: 72, head: true, name: "at the castle end" },
  cathedral: { near: 24, far: 72, head: true, name: "in the cathedral close" },
};
/** The catalog's kinds go by their district (agents/catalog.ts). */
const BY_DISTRICT: Partial<Record<District, Dist>> = {
  square: { near: 6, far: 26, name: "on the square" },
  civic: { near: 8, far: 34, arms: [0, 2], name: "on the civic streets" },
  market: { near: 8, far: 38, arms: [1, 3], name: "on the market street" },
  homes: { near: 14, far: 70, arms: [0, 2], name: "among the houses" },
  park: { near: 10, far: 50, name: "in the park quarter" },
  edge: { near: 26, far: 74, name: "at the edge of the town" },
  fields: { near: 30, far: 76, name: "out by the fields" },
  gate: { near: 0, far: 99, name: "over a gate of the wall" },
  span: { near: 0, far: 99, name: "across an avenue" },
  street: { near: 0, far: 99, name: "beside a street" },
  shore: { near: 0, far: 99, name: "by the water" },
};
const distOf = (kind: Kind): Dist => DISTRICT[kind] ?? BY_DISTRICT[KIND_INFO[kind]?.district ?? "homes"] ?? BY_DISTRICT.homes!;
/** The kinds the street runs through (an arch, a gatehouse): they never cut a street short. */
export const PASSAGE: ReadonlySet<Kind> = new Set<Kind>(["gatehouse", "arch"]);

// ---------------------------------------------------------------- the districts' styles and each lot's design

/** The style of each main street's district, north, east, south, west (the sides of the rings take the style of the
 *  main street that crosses them): the avenue up to the cathedral in stone, the market streets timber-framed, the
 *  south street oak. The brain keeps the town's own (with birch where the birch grows). */
export const STREET_STYLES = ["stone", "timber", "oak", "timber"];
/** A street's style (styles: the town's, north, east, south, west). */
export function styleOf(si: number, styles: string[] = STREET_STYLES): string {
  return styles[si < 4 ? si : (si - 4) % 4] ?? "oak";
}
/** The homes' sizes, from the middle of the town out: tall townhouses round the square (manors on a stone avenue),
 *  cottages and lodges inside the wall, longhouses and farmhouses out past it, farmhouses and huts at the edge. Two
 *  in turn along a street. */
const HOME_BANDS: { to: number; sizes: string[]; stone?: string[] }[] = [
  { to: 16, sizes: ["townhouse", "rowhouse"], stone: ["townhouse", "manor"] },
  { to: 30, sizes: ["cottage", "lodge"] },
  { to: 50, sizes: ["longhouse", "farmhouse"] },
  { to: 999, sizes: ["farmhouse", "hut"] },
];
/** The design for a building of a kind on a street, `t` out along it: the street's style; for a house, the size for
 *  how far out it is and the roof in a rhythm along the street (a gable, then one across the front; flat roofs on
 *  the stone avenue's townhouses); the same both sides, so the street comes in pairs. Any other kind: its design in
 *  the street's style if it has one, else its own. */
export function designFor(kind: Kind, c: Point, si: number, t: number, styles?: string[]): string {
  const s = streetsOf(c)[si];
  const style = styleOf(si, styles);
  const out = s && s.arm >= 0 ? t : s?.ring ?? t;
  const slot = Math.floor(t / 7);
  if (kind === "house") {
    const band = HOME_BANDS.find((b) => out < b.to)!;
    const sizes = style === "stone" && band.stone ? band.stone : band.sizes;
    const size = sizes[slot % sizes.length];
    const roof = style === "stone" && out < 30 && DESIGNS[`house/stone-${size}-flat`] ? "flat" : slot % 2 && DESIGNS[`house/${style}-${size}-cross`] ? "cross" : "gable";
    const id = `house/${style}-${size}-${roof}`;
    return DESIGNS[id] ? id : DESIGNS[`house/${style}-${size}-gable`] ? `house/${style}-${size}-gable` : "house";
  }
  const all = KINDS[kind]?.designs ?? [];
  if (!all.length) return kind;
  const mine = all.filter((id) => DESIGNS[id]?.style === style);
  const free = all.filter((id) => !DESIGNS[id]?.style);
  const pool = mine.length ? mine : free.length ? free : all.includes(kind) ? [kind] : all;
  return pool[(slot + si) % pool.length];
}
/** A rectangle mirrored across a street's middle line. */
function mirror(s: Street, r: Rect): Rect {
  if (s.d[0] === 0) {
    const x = s.o.x;
    return { x0: 2 * x - r.x1, x1: 2 * x - r.x0, z0: r.z0, z1: r.z1 };
  }
  const z = s.o.z;
  return { x0: r.x0, x1: r.x1, z0: 2 * z - r.z1, z1: 2 * z - r.z0 };
}

/** The side a vector points to: 0 north, 1 east, 2 south, 3 west. */
const faceOf = (dx: number, dz: number) => (dz < 0 ? 0 : dx > 0 ? 1 : dz > 0 ? 2 : 3);
const box = (pts: [number, number][]): Rect => ({
  x0: Math.min(...pts.map((p) => p[0])),
  z0: Math.min(...pts.map((p) => p[1])),
  x1: Math.max(...pts.map((p) => p[0])),
  z1: Math.max(...pts.map((p) => p[1])),
});
const overlaps = (a: Rect, b: Rect, gap = 1) => a.x0 <= b.x1 + gap && a.x1 >= b.x0 - gap && a.z0 <= b.z1 + gap && a.z1 >= b.z0 - gap;
/** Along a street (how far out) and across it (how far to its right) for a cell. */
const along = (s: Street, x: number, z: number) => s.d[0] * (x - s.o.x) + s.d[1] * (z - s.o.z);
const across = (s: Street, x: number, z: number) => -s.d[1] * (x - s.o.x) + s.d[0] * (z - s.o.z);
const corners = (b: Rect): [number, number][] => [[b.x0, b.z0], [b.x1, b.z0], [b.x0, b.z1], [b.x1, b.z1]];
const onLots = (b: Building) => b.kind !== "road" && b.kind !== "wall" && b.kind !== "farm" && b.kind !== "lamp" && b.kind !== "plaza" && !PASSAGE.has(b.kind);
/** How far a rectangle is from the centre at its nearest (along the axes: the plaza's square rings). */
const outOf = (c: Point, r: Rect) => Math.max(Math.max(0, r.x0 - c.x, c.x - r.x1), Math.max(0, r.z0 - c.z, c.z - r.z1));

/** The plaza square round the centre. */
export function plazaRect(c: Point): Rect {
  return { x0: c.x - PLAZA_HALF, z0: c.z - PLAZA_HALF, x1: c.x + PLAZA_HALF, z1: c.z + PLAZA_HALF };
}

/** The cells on or beside a street (margin 1), worked out once per centre: what no lot may take. */
const besideCache = new Map<string, Set<string>>();
function besideStreets(c: Point): Set<string> {
  const key = `${c.x},${c.z}`;
  const hit = besideCache.get(key);
  if (hit) return hit;
  const set = new Set<string>();
  for (let x = c.x - PLAZA_HALF - 1; x <= c.x + PLAZA_HALF + 1; x++) for (let z = c.z - PLAZA_HALF - 1; z <= c.z + PLAZA_HALF + 1; z++) set.add(`${x},${z}`);
  for (const s of streetsOf(c)) {
    const [px, pz] = [-s.d[1], s.d[0]];
    for (let t = s.t0 - 1; t <= s.t1 + 1; t++) for (let a = -STREET_HALF - 1; a <= STREET_HALF + 1; a++) set.add(`${s.o.x + s.d[0] * t + px * a},${s.o.z + s.d[1] * t + pz * a}`);
  }
  besideCache.set(key, set);
  return set;
}

/** Is (x, z) on a street (or the plaza), or (`margin` 1) the cell beside one, where door paths and lamp posts go? */
export function onStreet(c: Point, x: number, z: number, margin = 0): boolean {
  if (margin === 1) return besideStreets(c).has(`${x},${z}`);
  if (Math.abs(x - c.x) <= PLAZA_HALF + margin && Math.abs(z - c.z) <= PLAZA_HALF + margin) return true;
  return streetsOf(c).some((s) => {
    const t = along(s, x, z);
    return t >= s.t0 - margin && t <= s.t1 + margin && Math.abs(across(s, x, z)) <= STREET_HALF + margin;
  });
}

/** Every lot along the streets a building of this kind could take (chooseLot scores them). The front faces the street
 *  with one cell between them (the step and the path to the door); a cathedral or a keep can also stand across the head
 *  of a main street, out past its last building, facing back down it to the plaza. */
export function lotsFor(kind: Exclude<Plain, "plaza" | "lamp">, c: Point, lengths: number[] = [0, 0, 0, 0], styles?: string[], only?: string): Lot[] {
  const out: Lot[] = [];
  const dist = distOf(kind);
  const where = KIND_INFO[kind]?.district;
  const pick = (si: number, t: number) => (only && DESIGNS[only] ? only : KINDS[kind]?.designs.length ? designFor(kind, c, si, t, styles) : kind);
  if (where === "gate" || where === "span") {
    // over a gate of the wall (the middle of its front on the street's line, where the wall crosses it), or across
    // an avenue between the plaza and the rings: the street runs through it
    streetsOf(c).forEach((s, si) => {
      if (s.arm < 0) return;
      const [dx, dz] = s.d;
      const [px, pz] = [-dz, dx];
      const face = faceOf(-dx, -dz);
      const design = pick(si, 0);
      const [sx, sz] = sizeFacing(design, face);
      const wide = dx !== 0 ? sz : sx;
      const deep = dx !== 0 ? sx : sz;
      const half = Math.floor(wide / 2);
      for (const mid of where === "gate" ? [WALL] : [12, 17, 33, 39]) {
        const t = mid - Math.floor(deep / 2);
        const pts: [number, number][] = [];
        for (const a of [t, t + deep - 1]) for (const k of [-half, wide - 1 - half]) pts.push([s.o.x + dx * a + px * k, s.o.z + dz * a + pz * k]);
        const r = box(pts);
        out.push({ ...r, face, street: si, side: where === "gate" ? 3 : 4, t, out: outOf(c, r), where: where === "gate" ? `over the ${DIRS[s.arm]} gate` : `across ${s.name}`, design });
      }
    });
    return out;
  }
  streetsOf(c).forEach((s, si) => {
    const [dx, dz] = s.d;
    const [px, pz] = [-dz, dx]; // across the street, to its right
    for (const side of [1, -1]) {
      const face = faceOf(-side * px, -side * pz);
      // a step back from the street (the door step and the path), or set back a little further where the ground
      // right by the street won't take it (the path to the door runs straight out to the street all the same)
      for (const back of [0, 2, 4])
        for (let t = s.t0 + (s.arm >= 0 ? 1 : 0); t <= s.t1; t++) {
          const design = pick(si, t);
          const [sx, sz] = sizeFacing(design, face);
          const al = dx !== 0 ? sx : sz;
          const deep = dx !== 0 ? sz : sx;
          if (t + al - 1 > s.t1) continue;
          const c0 = STREET_HALF + 2 + back;
          const c1 = STREET_HALF + 1 + deep + back;
          const pts: [number, number][] = [];
          for (const a of [t, t + al - 1]) for (const k of [c0, c1]) pts.push([s.o.x + dx * a + px * side * k, s.o.z + dz * a + pz * side * k]);
          const r = box(pts);
          out.push({ ...r, face, street: si, side, t, out: outOf(c, r) + back, where: `on ${s.name}`, back, design });
        }
    }
    const kept = HEADS[kind];
    if (dist.head && s.arm >= 0 && (!kept || kept.arm === s.arm)) {
      // across the head of a main street, past its last building: the middle of its front on the street's line
      const face = faceOf(-dx, -dz);
      const [sx, sz] = sizeFacing(kind, face);
      const wide = dx !== 0 ? sz : sx;
      const deep = dx !== 0 ? sx : sz;
      const half = Math.floor(wide / 2);
      for (let t = kept ? kept.t : Math.max(dist.near, lengths[s.arm] + 2); t + deep - 1 <= REACH && (!kept || t === kept.t); t++) {
        const pts: [number, number][] = [];
        for (const a of [t, t + deep - 1]) for (const k of [-half, wide - 1 - half]) pts.push([s.o.x + dx * a + px * k, s.o.z + dz * a + pz * k]);
        const r = box(pts);
        out.push({ ...r, face, street: si, side: 0, t, out: outOf(c, r), where: `at the head of ${s.name}, facing down it to the plaza`, design: kind });
      }
    }
  });
  if (kind === "tower") {
    // the corners of the town: just outside the wall's corners, and inside the outer ring's, the door to the north or
    // south side (the ring road's side for the outer ones)
    const [w, d] = sizeFacing("tower", 0);
    for (const [lo, name] of [[WALL + 2, "outside a corner of the wall"], [RINGS[1] - STREET_HALF - 2 - w, "at a corner of the outer ring road"]] as [number, string][])
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const x0 = sx > 0 ? c.x + lo : c.x - lo - w + 1;
        const z0 = sz > 0 ? c.z + lo : c.z - lo - d + 1;
        const r = { x0, z0, x1: x0 + w - 1, z1: z0 + d - 1 };
        const outward = lo > WALL;
        out.push({ ...r, face: (sz < 0) === outward ? 0 : 2, street: -1, side: 2, t: 0, out: outOf(c, r), where: name, design: "tower" });
      }
  }
  return out;
}

/** The lots kept for the landmarks not built yet (nothing else goes there). */
export function keptLots(c: Point, builds: Building[]): Rect[] {
  const out: Rect[] = [];
  for (const [k, h] of Object.entries(HEADS) as [Plain, { arm: number; t: number }][]) {
    if (builds.some((b) => b.kind === k)) continue;
    const lot = lotsFor(k as Exclude<Plain, "plaza" | "lamp">, c).find((l) => l.side === 0 && l.street === h.arm);
    if (lot) out.push(lot);
  }
  // the gates of the wall, kept for their gatehouses from the start (the street runs through them anyway)
  for (const g of gateLots(c)) if (!builds.some((b) => b.kind === "gatehouse" && overlaps(b, g, 0))) out.push(g);
  return out;
}
const gateCache = new Map<string, Lot[]>();
function gateLots(c: Point): Lot[] {
  const key = `${c.x},${c.z}`;
  if (!gateCache.has(key)) gateCache.set(key, KINDS.gatehouse ? lotsFor("gatehouse", c) : []);
  return gateCache.get(key)!;
}

/** The best lot for a building: in its district (how far out, which streets), clear of everything in `avoid` and of
 *  the streets and the plaza, on ground that `fits` (flat enough, dry, no trees), nearest the plaza of its district.
 *  `fits` gives the floor height for a rectangle, or -1. `wall`: the wall's distance out once it is planned (nothing
 *  goes across its line). Null when no lot along the streets will do. */
export function chooseLot(kind: Exclude<Plain, "plaza" | "lamp">, c: Point, builds: Building[], avoid: Rect[], fits: (r: Rect) => number, wall = WALL, why?: Record<string, number>, styles?: string[], only?: string): (Lot & { y: number }) | null {
  const no = (k: string) => {
    if (why) why[k] = (why[k] ?? 0) + 1;
  };
  const dist = distOf(kind);
  const streets = streetsOf(c);
  const caps = armCaps(c, builds);
  const lengths = armLengths(c, builds);
  const lots = lotsFor(kind, c, lengths, styles, only);
  // the buildings of this kind already standing, mirrored across their street: a lot there makes a pair
  const pairs: Rect[] = [];
  for (const b of builds) {
    if (b.kind !== kind) continue;
    const at = streetOf(c, b);
    if (at) pairs.push(mirror(streets[at[0]], b));
  }
  const paired = (l: Lot) => pairs.some((p) => Math.abs(p.x0 - l.x0) + Math.abs(p.z0 - l.z0) + Math.abs(p.x1 - l.x1) + Math.abs(p.z1 - l.z1) <= 2);
  const civic = !DISTRICT[kind] && (KIND_INFO[kind]?.district === "square" || KIND_INFO[kind]?.district === "civic");
  const score = (l: Lot) => {
    if (l.side === 2) return -20 + l.out * 0.1; // a tower at a corner of the town before anywhere else
    if (l.side >= 3) return l.out; // a gatehouse or an arch: the nearest first
    const s = streets[l.street];
    let v = Math.max(0, dist.near - l.out) * 4 + Math.max(0, l.out - dist.far) * 1.5 + l.out * 0.25;
    if (dist.arms && s.arm >= 0 && l.side !== 0 && !dist.arms.includes(s.arm)) v += 6;
    // the rings after the main streets at the same distance; the inner ring is the civic ring, kept for the town's
    // public buildings (the houses go elsewhere first)
    if (s.ring) v += s.ring === RINGS[0] ? (civic ? -4 : kind === "house" ? 10 : 3) : 3;
    if (l.side === 0) v -= HEADS[kind] ? 40 : 6; // the head of a street, when it's open, is the place for it
    if (paired(l)) v -= 4; // across the street from one of its kind: the street comes in pairs
    return v;
  };
  lots.sort((a, b) => score(a) - score(b));
  const plaza = plazaRect(c);
  const all = [...builds.filter((b) => b.kind !== "road" && b.kind !== "wall").map((b) => b as Rect), ...avoid, ...keptLots(c, builds).filter((r) => !lots.some((l) => (l.side === 0 || l.side === 3) && l.x0 === r.x0 && l.z0 === r.z0))];
  for (const l of lots) {
    if (l.side >= 3) {
      // over a gate or across an avenue: nothing else there (a building may stand right beside it), never on the
      // plaza, ground that takes it
      if (all.some((r) => overlaps(l, r, 0)) || overlaps(l, plaza, 1)) {
        no("taken");
        continue;
      }
      const y = fits(l);
      if (y >= 0) return { ...l, y };
      no("ground");
      continue;
    }
    if (l.side === 2) {
      if (all.some((r) => overlaps(l, r, 1))) {
        no("taken");
        continue;
      }
      const y = fits(l);
      if (y >= 0) return { ...l, y };
      no("ground");
      continue;
    }
    const s = streets[l.street];
    if (overlaps(l, plaza, 1)) {
      no("plaza");
      continue;
    }
    // a main street ends where something stands across it: no lots out past that
    if ((s.arm >= 0 && l.side !== 0 && l.t + Math.max(l.x1 - l.x0, l.z1 - l.z0) > caps[s.arm]) || (s.arm >= 0 && l.side === 0 && l.t > caps[s.arm] + 1)) {
      no("past the street's end");
      continue;
    }
    // a side of a ring is reached from the main street that crosses it: not if that street ends short of the ring
    if (s.ring && caps[(l.street - 4) % 4] < s.ring + STREET_HALF) {
      no("ring cut off");
      continue;
    }
    if (all.some((r) => overlaps(l, r, 1))) {
      no("taken");
      continue;
    }
    // never across the wall's line, never on a street or the cell beside one (its paths and lamp posts)
    let clash = false;
    for (let x = l.x0; x <= l.x1 && !clash; x++)
      for (let z = l.z0; z <= l.z1 && !clash; z++) {
        const ring = Math.max(Math.abs(x - c.x), Math.abs(z - c.z));
        if ((wall && ring >= wall - 1 && ring <= wall + 1) || (l.side !== 0 && onStreet(c, x, z, 1))) clash = true;
        else if (l.side === 0) {
          // across a street's head: only its own street may run up to it, no other
          const other = streets.some((q, qi) => qi !== l.street && along(q, x, z) >= q.t0 && along(q, x, z) <= q.t1 && Math.abs(across(q, x, z)) <= STREET_HALF + 1);
          if (other) clash = true;
        }
      }
    if (clash) {
      no("street or wall");
      continue;
    }
    const y = fits(l);
    if (y < 0) {
      no("ground");
      continue;
    }
    return { ...l, y };
  }
  return null;
}

/** Which street a building's door opens onto (its door step within a few cells of the street's line, within its
 *  length), and how far along it: [street index, t], or null for a building off the streets. */
export function streetOf(c: Point, b: Building): [number, number] | null {
  const d = doorStep(b);
  if (!d) return null;
  const streets = streetsOf(c);
  for (let si = 0; si < streets.length; si++) {
    const s = streets[si];
    const t = along(s, d[0], d[1]);
    // (within reach of a lot set back from the street too)
    if (t >= s.t0 && t <= s.t1 && Math.abs(across(s, d[0], d[1])) <= STREET_HALF + 6) return [si, t];
  }
  return null;
}

/** Where each main street runs into something standing across it (a building on its line, a cathedral at its head):
 *  the street can't go further out than this. */
export function armCaps(c: Point, builds: Building[]): number[] {
  const streets = streetsOf(c);
  const cap = [REACH, REACH, REACH, REACH];
  for (const h of Object.values(HEADS)) if (h) cap[h.arm] = Math.min(cap[h.arm], h.t - 1);
  for (const b of builds.filter(onLots))
    for (let arm = 0; arm < 4; arm++) {
      const s = streets[arm];
      const al = corners(b).map(([x, z]) => along(s, x, z));
      const ac = corners(b).map(([x, z]) => across(s, x, z));
      const lo = Math.min(...al);
      if (lo <= PLAZA_HALF || Math.min(...ac) > STREET_HALF || Math.max(...ac) < -STREET_HALF) continue;
      cap[arm] = Math.min(cap[arm], lo - 1);
    }
  return cap;
}

/** How far out each main street runs: to the far end of the last lot on it, or up to what stands at its head (0: no
 *  street there yet). */
export function armLengths(c: Point, builds: Building[]): number[] {
  return streetSpans(c, builds).slice(0, 4).map(([, hi]) => hi);
}

/** The stretch of each street that is in use: [from, to] along it ([0, 0]: none). A main street runs from the plaza
 *  out to its last lot; a side of the ring from its crossing with a main street out to its lots either way. */
export function streetSpans(c: Point, builds: Building[]): [number, number][] {
  const streets = streetsOf(c);
  const caps = armCaps(c, builds);
  const spans: [number, number][] = streets.map(() => [0, 0]);
  for (const b of builds.filter(onLots)) {
    const at = streetOf(c, b);
    if (!at) continue;
    const s = streets[at[0]];
    const al = corners(b).map(([x, z]) => along(s, x, z));
    const lo = Math.max(s.t0, Math.min(...al));
    const hi = Math.min(s.arm >= 0 ? caps[s.arm] : s.t1, Math.max(...al));
    const [a, z] = spans[at[0]];
    spans[at[0]] = a || z ? [Math.min(a, lo, s.join), Math.max(z, hi, s.join)] : [Math.min(lo, s.join), Math.max(hi, s.join)];
  }
  // a side of a ring is only reached from the main street that crosses it: that main street runs out to the ring
  streets.forEach((s, si) => {
    if (!s.ring || !(spans[si][0] || spans[si][1])) return;
    const crossing = (si - 4) % 4; // a ring's north side is crossed by the north street in its middle, and so on
    spans[crossing] = [streets[crossing].t0, Math.max(spans[crossing][1], Math.min(caps[crossing], s.ring + STREET_HALF))];
  });
  return spans;
}

/** The streets and paths, cell by cell, in the order to make them: each street's stretch in use (3 wide), then a path
 *  from every door to the nearest street (straight out, then along x and z toward the plaza: a building off the
 *  streets gets the old way round). Dirt paths dug with a shovel at tier 1, paved in cobblestone at tier 2. `of` says
 *  which building each cell serves (a building is joined when its own cells are done: its path and its stretch of
 *  street), so the roads can count the buildings they join. */
export function streetPlan(c: Point, builds: Building[], ground: (x: number, z: number) => number, tier = 1): { cells: PlanCell[]; of: number[] } {
  const cells: PlanCell[] = [];
  const of: number[] = [];
  const seen = new Set<string>();
  const k = tier >= 2 ? "4" : "p";
  // (an arch or a gatehouse the street runs through doesn't block it)
  const lots = builds.filter((b) => b.kind !== "road" && b.kind !== "wall" && b.kind !== "farm" && b.kind !== "plaza");
  const blocked = (x: number, z: number) => lots.some((b) => x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && !(PASSAGE.has(b.kind) && onStreet(c, x, z)));
  const plaza = plazaRect(c);
  const inPlaza = (x: number, z: number) => x >= plaza.x0 && x <= plaza.x1 && z >= plaza.z0 && z <= plaza.z1;
  const add = (x: number, z: number, i: number) => {
    const key = `${x},${z}`;
    if (seen.has(key) || blocked(x, z) || inPlaza(x, z)) return;
    const g = ground(x, z);
    if (g < 0) return;
    seen.add(key);
    cells.push([x, g, z, k]);
    of.push(i);
  };
  const streets = streetsOf(c);
  const spans = streetSpans(c, builds);
  const fronting = builds.map((b, i) => ({ i, at: b.kind === "lamp" ? null : streetOf(c, b) })).filter((e): e is { i: number; at: [number, number] } => !!e.at);
  streets.forEach((s, si) => {
    const [lo, hi] = spans[si];
    if (!lo && !hi) return;
    const [dx, dz] = s.d;
    const [px, pz] = [-dz, dx];
    const mine = fronting.filter((e) => e.at[0] === si);
    // out from where it joins the rest, both ways: each stretch serves the first building beyond it
    const walk = (from: number, to: number) => {
      const step = Math.sign(to - from) || 1;
      const ahead = mine.filter((e) => (e.at[1] - from) * step >= 0).sort((p, q) => Math.abs(p.at[1] - from) - Math.abs(q.at[1] - from));
      for (let t = from; (t - to) * step <= 0; t += step) {
        const who = (ahead.find((e) => (e.at[1] - t) * step >= 0) ?? ahead[ahead.length - 1])?.i ?? -1;
        for (let a = -STREET_HALF; a <= STREET_HALF; a++) add(s.o.x + dx * t + px * a, s.o.z + dz * t + pz * a, who);
      }
    };
    walk(Math.max(lo, s.join), hi);
    if (lo < s.join) walk(s.join - 1, lo);
  });
  const street = (x: number, z: number) => seen.has(`${x},${z}`) || inPlaza(x, z);
  builds.forEach((b, i) => {
    if (b.kind === "road" || b.kind === "wall" || b.kind === "farm" || b.kind === "lamp" || b.kind === "plaza") return;
    const door = doorStep(b);
    if (!door) return;
    // only the town's own buildings: a house sonnet once built 250 blocks out put road cells out of reach
    if (Math.hypot(door[0] - c.x, door[1] - c.z) > REACH + 10) return;
    let [x, z] = door;
    const step = (nx: number, nz: number) => {
      x = nx;
      z = nz;
      add(x, z, i);
    };
    if (street(x, z)) return;
    add(x, z, i);
    const [fx, fz] = [[0, -1], [1, 0], [0, 1], [-1, 0]][b.face ?? 0];
    // straight out from the door until it meets a street (most lots are a step from one)
    for (let n = 0; n < 6 && !street(x + fx, z + fz); n++) step(x + fx, z + fz);
    if (street(x + fx, z + fz)) return;
    // off the streets: along x to the plaza's line, then along z (the old way), stopping at the first street
    for (let n = 0; n < 400 && x !== c.x && !street(x + Math.sign(c.x - x), z); n++) step(x + Math.sign(c.x - x), z);
    for (let n = 0; n < 400 && z !== c.z && !street(x, z + Math.sign(c.z - z)); n++) step(x, z + Math.sign(c.z - z));
  });
  return { cells, of };
}

/** The wall's square round the centre: just outside the inner ring road (the old town's lots stop short of it), its
 *  gates the middle of each side, where the main streets go through. */
export function wallRadius(): number {
  return WALL;
}

/** How far out from the plaza a kind belongs at most (its district's far edge). */
export function districtFar(kind: Kind): number {
  return DISTRICT[kind] || KIND_INFO[kind] ? distOf(kind).far : 24;
}

/** Spots for street furniture (a bench, a flower bed) of this design: in the row beside a street that is in use, along
 *  it, its front to the street, out of the plaza, clear of the buildings and of `taken` cells (the paths to the doors,
 *  the lamp posts; "furniture:x,z" for the other pieces, kept `gap` away). Nearest the plaza first. */
export function streetSpots(c: Point, builds: Building[], design: string, taken: Set<string>, gap = 3): Lot[] {
  const out: Lot[] = [];
  const spans = streetSpans(c, builds);
  const plaza = plazaRect(c);
  const lots = builds.filter((b) => b.kind !== "road" && b.kind !== "wall" && b.kind !== "plaza");
  const inLot = (x: number, z: number) => lots.some((b) => x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1);
  streetsOf(c).forEach((s, si) => {
    const [lo, hi] = spans[si];
    if (!lo && !hi) return;
    const [dx, dz] = s.d;
    const [px, pz] = [-dz, dx];
    for (const side of [1, -1]) {
      const face = faceOf(-side * px, -side * pz);
      const [sx, sz] = sizeFacing(design, face);
      const al = dx !== 0 ? sx : sz;
      const deep = dx !== 0 ? sz : sx;
      for (let t = Math.max(lo, s.t0 + 1); t + al - 1 <= hi; t++) {
        const pts: [number, number][] = [];
        for (const a of [t, t + al - 1]) for (const k of [STREET_HALF + 1, STREET_HALF + deep]) pts.push([s.o.x + dx * a + px * side * k, s.o.z + dz * a + pz * side * k]);
        const r = box(pts);
        let ok = !overlaps(r, plaza, 0);
        for (let x = r.x0 - gap; x <= r.x1 + gap && ok; x++)
          for (let z = r.z0 - gap; z <= r.z1 + gap && ok; z++) {
            const inside = x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;
            if (inside && (taken.has(`${x},${z}`) || inLot(x, z))) ok = false;
            else if (taken.has(`furniture:${x},${z}`)) ok = false;
          }
        if (ok) out.push({ ...r, face, street: si, side, t, out: outOf(c, r), where: `beside ${s.name}`, design });
      }
    }
  });
  return out.sort((a, b) => a.out - b.out);
}

/** How many lots near a centre (out to `out`) the ground would take, up to `cap`: how good a spot it is for a town. */
export function lotRoom(c: Point, fits: (r: Rect) => number, out = 24, cap = 30): number {
  let n = 0;
  const taken: Rect[] = [];
  for (const l of lotsFor("house", c)) {
    if (l.side !== 1 && l.side !== -1) continue;
    if (l.out > out || l.back || taken.some((r) => overlaps(l, r, 1))) continue;
    if (fits(l) < 0) continue;
    taken.push(l);
    if (++n >= cap) break;
  }
  return n;
}

/** The street a cell is on or beside (within `margin` of its edge): its index in streetsOf, or -1. */
export function streetAt(c: Point, x: number, z: number, margin = 2): number {
  return streetsOf(c).findIndex((s) => {
    const t = along(s, x, z);
    return t >= s.t0 && t <= s.t1 && Math.abs(across(s, x, z)) <= STREET_HALF + margin;
  });
}

/** The district of a kind, in words. */
export function districtOf(kind: Kind): string {
  return kind === "plaza" ? "in the middle of the town" : kind === "lamp" ? "along the streets" : DISTRICT[kind] || KIND_INFO[kind] ? distOf(kind).name : "";
}

/** Is a kind one the town has only one of? */
export const isOnce = (k: Kind) => ONCE.has(k);
/** A kind's footprint, its front along the first number. */
export const footprint = (k: Exclude<Plain, "lamp">) => KINDS[k].size;
