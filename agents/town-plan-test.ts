// clankersmp: the town plan without a server. A whole empire's worth of buildings is placed on flat open ground in the
// order the stages ask for them, each on the lot chooseLot picks (the same call the brain makes), then the streets
// and the wall are planned round them, and the town is drawn as a map: every lot taken, nothing overlapping, nothing
// on a street, every door joined to a street.
// Then the catalog's own kinds go in (agents/catalog.ts: workshops, farm buildings, civic buildings, gardens, tree
// farms, gatehouses over the gates...), each with the design its street gives it, and the street furniture (benches,
// flower beds) in the rows beside the streets; it says what style each street came out in, how many buildings stand
// across the street from a twin, and how the houses step down from the middle out.
//   node agents/town-plan-test.ts        (MAP=0 to skip the drawing; ROUGH=1 for a patch of ground that's no good)
import { DESIGNS, KINDS, ONCE, STAGES, doorStep, type Building, type Plain } from "./civ.ts";
import { KIND_INFO } from "./catalog.ts";
import { chooseLot, plazaRect, streetOf, streetPlan, streetSpots, streetsOf, styleOf, wallRadius, STREET_STYLES, type Point } from "./town.ts";
import { wallPlan } from "./civ.ts";
import type { Rect } from "./body.ts";

const c: Point = { x: 256, z: 256 };
const builds: Building[] = [];
// rough ground: a lake east of the plaza and a hill to the south-west, where nothing fits
const rough = process.env.ROUGH === "1";
const bad = (x: number, z: number) => rough && (Math.hypot(x - 290, z - 250) < 9 || (x < 236 && z > 270 && z < 290));
const fits = (r: Rect) => {
  for (let x = r.x0; x <= r.x1; x++) for (let z = r.z0; z <= r.z1; z++) if (bad(x, z)) return -1;
  return 60;
};
const want: Plain[] = [];
const have = new Map<string, number>();
for (const st of STAGES)
  for (const [k, n] of st.needs) {
    if (k === "trade" || k === "road" || k === "farm" || k === "wall") continue;
    const got = have.get(k) ?? 0;
    for (let i = got; i < n; i++) want.push(k as Plain);
    have.set(k, Math.max(got, n));
  }
let failed = 0;
let wallAt = 0;
for (const kind of want) {
  // the wall is planned with the village (after its plaza and houses): from then on nothing goes across its line
  if (!wallAt && builds.filter((b) => b.kind === "house").length >= 6 && builds.some((b) => b.kind === "plaza")) wallAt = wallRadius();
  if (ONCE.has(kind) && builds.some((b) => b.kind === kind)) continue;
  let site: (Rect & { face: number; y: number }) | null = null;
  if (kind === "plaza") site = { ...plazaRect(c), face: 0, y: 60 };
  else if (kind === "lamp") continue;
  else site = chooseLot(kind, c, builds, [], fits, wallAt);
  if (!site) {
    failed++;
    console.log(`no lot for ${kind}`);
    continue;
  }
  builds.push({ kind, design: "design" in site ? (site.design as string | undefined) : undefined, x0: site.x0, z0: site.z0, x1: site.x1, z1: site.z1, y: 60, face: site.face, by: [], done: true, at: 0 });
}
// the catalog's kinds, by the stage they come in at: up to two of each (four gatehouses, one over each gate)
const extra = Object.entries(KIND_INFO).filter(([k, i]) => !have.has(k) && i.district !== "street" && i.district !== "shore" && i.district !== "plaza").sort((a, b) => a[1].from - b[1].from);
for (const [kind, info] of extra)
  for (let n = 0; n < (info.district === "gate" ? 4 : Math.min(2, info.most)); n++) {
    const site = chooseLot(kind, c, builds, [], fits, wallAt || wallRadius());
    if (!site) {
      failed++;
      console.log(`no lot for ${kind}`);
      break;
    }
    builds.push({ kind, design: site.design, x0: site.x0, z0: site.z0, x1: site.x1, z1: site.z1, y: 60, face: site.face, by: [], done: true, at: 0 });
  }
// street furniture in the rows beside the streets, kept off the paths to the doors and apart from each other
{
  const paths = streetPlan(c, builds, () => 59, 1);
  const taken = new Set(paths.cells.map(([x, , z]) => `${x},${z}`));
  for (const [kind, design, n] of [["bench", "bench", 10], ["flowerbed", "flowerbed", 10]] as [string, string, number][])
    for (let i = 0; i < n; i++) {
      const spot = streetSpots(c, builds, design, taken, 3)[0];
      if (!spot) break;
      builds.push({ kind, design, x0: spot.x0, z0: spot.z0, x1: spot.x1, z1: spot.z1, y: 60, face: spot.face, by: [], done: true, at: 0 });
      for (let x = spot.x0; x <= spot.x1; x++) for (let z = spot.z0; z <= spot.z1; z++) taken.add(`furniture:${x},${z}`);
    }
}
const roads = streetPlan(c, builds, () => 59, 1);
const r = wallAt || wallRadius();
const wall = wallPlan(c.x, c.z, r, () => 59, 1, (x, z) => builds.some((b) => x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) || roads.cells.some(([rx, , rz]) => rx === x && rz === z));
// checks: nothing overlaps, every door reaches a street
let problems = 0;
for (let i = 0; i < builds.length; i++)
  for (let j = i + 1; j < builds.length; j++) {
    const a = builds[i];
    const b = builds[j];
    if (a.x0 <= b.x1 && a.x1 >= b.x0 && a.z0 <= b.z1 && a.z1 >= b.z0) {
      problems++;
      console.log(`OVERLAP ${a.kind} and ${b.kind}`);
    }
  }
const roadSet = new Set(roads.cells.map(([x, , z]) => `${x},${z}`));
const plaza = plazaRect(c);
builds.forEach((b) => {
  const d = doorStep(b);
  if (!d || b.kind === "plaza" || b.kind === "well") return;
  // the step in front of the door (inside the eaves on most buildings) or the cell out from it is on a path
  const [fx, fz] = [[0, -1], [1, 0], [0, 1], [-1, 0]][b.face ?? 0];
  const reached = [[d[0], d[1]], [d[0] + fx, d[1] + fz]].some(([x, z]) => roadSet.has(`${x},${z}`) || (x >= plaza.x0 && x <= plaza.x1 && z >= plaza.z0 && z <= plaza.z1));
  if (!reached) {
    problems++;
    console.log(`NO PATH to the ${b.kind}'s door at ${d}`);
  }
});
// every building is the design its street gives it: the style of the street, a design of its own kind
const streets = streetsOf(c);
const byStreet = new Map<number, Map<string, number>>();
let offStyle = 0;
for (const b of builds) {
  if (!b.design || !DESIGNS[b.design]) continue;
  if (DESIGNS[b.design].kind !== b.kind) {
    problems++;
    console.log(`WRONG DESIGN ${b.design} for a ${b.kind}`);
  }
  const at = streetOf(c, b);
  if (!at) continue;
  const m = byStreet.get(at[0]) ?? new Map<string, number>();
  m.set(b.design, (m.get(b.design) ?? 0) + 1);
  byStreet.set(at[0], m);
  const st = DESIGNS[b.design].style;
  const own = KINDS[b.kind].designs.some((id) => DESIGNS[id].style === styleOf(at[0]));
  if (st && own && st !== styleOf(at[0])) offStyle++;
}
for (const [si, m] of [...byStreet].sort((a, b) => a[0] - b[0])) console.log(`  ${streets[si].name} (${styleOf(si)}): ${[...m].map(([d, n]) => `${d} ${n}`).join(", ")}`);
// twins across the street: a building with one of its own design mirrored across its street
let twins = 0;
for (const b of builds) {
  const at = streetOf(c, b);
  if (!at || !b.design) continue;
  const s = streets[at[0]];
  const m = s.d[0] === 0 ? { x0: 2 * s.o.x - b.x1, x1: 2 * s.o.x - b.x0, z0: b.z0, z1: b.z1 } : { x0: b.x0, x1: b.x1, z0: 2 * s.o.z - b.z1, z1: 2 * s.o.z - b.z0 };
  if (builds.some((q) => q !== b && q.design === b.design && Math.abs(q.x0 - m.x0) + Math.abs(q.z0 - m.z0) <= 1)) twins++;
}
// the houses' heights from the middle out
const rings = [16, 30, 50, 999].map((to, i, a) => ({ from: i ? a[i - 1] : 0, to, sizes: new Map<string, number>() }));
for (const b of builds) {
  if (b.kind !== "house" || !b.design) continue;
  const out = Math.max(Math.abs((b.x0 + b.x1) / 2 - c.x), Math.abs((b.z0 + b.z1) / 2 - c.z));
  const ring = rings.find((q) => out < q.to)!;
  const size = b.design.split("-")[1] ?? b.design;
  ring.sizes.set(size, (ring.sizes.get(size) ?? 0) + 1);
}
console.log(`  houses from the middle out: ${rings.map((q) => `${q.from}-${q.to === 999 ? "edge" : q.to}: ${[...q.sizes].map(([s, n]) => `${s} ${n}`).join(" ") || "none"}`).join("; ")}`);
console.log(`  ${twins} buildings with a twin across the street, ${offStyle} off their street's style (styles ${STREET_STYLES.join(", ")})`);
const count = new Map<string, number>();
for (const b of builds) count.set(b.kind, (count.get(b.kind) ?? 0) + 1);
console.log(`${builds.length} buildings on lots (${[...count].map(([k, n]) => `${k} ${n}`).join(", ")}), ${roads.cells.length} street and path cells, the wall ${r} out (${wall.length} blocks); ${failed} with no lot, ${problems} problems`);
if (process.env.MAP !== "0") {
  const L: Record<string, string> = { house: "h", storehouse: "S", hall: "H", market: "M", well: "W", tower: "T", keep: "K", plaza: "P", smithy: "F", bakery: "B", tavern: "V", library: "L", chapel: "C", barn: "N", fountain: "O", monument: "M", cathedral: "X", bench: "=", flowerbed: "*", gatehouse: "G", arch: "A", treefarm: "t", quarry: "q", garden: "g", park: "p" };
  const xs = builds.flatMap((b) => [b.x0, b.x1]).concat(c.x - r - 2, c.x + r + 2);
  const zs = builds.flatMap((b) => [b.z0, b.z1]).concat(c.z - r - 2, c.z + r + 2);
  const wallSet = new Set(wall.map(([x, , z]) => `${x},${z}`));
  for (let z = Math.min(...zs); z <= Math.max(...zs); z++) {
    let row = "";
    for (let x = Math.min(...xs); x <= Math.max(...xs); x++) {
      const b = builds.find((q) => x >= q.x0 && x <= q.x1 && z >= q.z0 && z <= q.z1);
      const d = b && doorStep(b);
      row += b ? (d && d[0] === x && d[1] === z ? "d" : L[b.kind] ?? "?") : roadSet.has(`${x},${z}`) ? "." : wallSet.has(`${x},${z}`) ? "#" : bad(x, z) ? "~" : " ";
    }
    console.log(row.replace(/\s+$/, ""));
  }
}
void KINDS;
process.exit(failed || problems ? 1 : 0);
