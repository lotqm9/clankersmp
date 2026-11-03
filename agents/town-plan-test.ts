// clankersmp: the town plan without a server. A whole empire's worth of buildings is placed on flat open ground in the
// order the stages ask for them, each on the lot chooseLot picks (the same call the brain makes), then the streets
// and the wall are planned round them, and the town is drawn as a map: every lot taken, nothing overlapping, nothing
// on a street, every door joined to a street.
//   node agents/town-plan-test.ts        (MAP=0 to skip the drawing; ROUGH=1 for a patch of ground that's no good)
import { KINDS, ONCE, STAGES, doorStep, type Building, type Plain } from "./civ.ts";
import { chooseLot, plazaRect, streetPlan, wallRadius, type Point } from "./town.ts";
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
  builds.push({ kind, x0: site.x0, z0: site.z0, x1: site.x1, z1: site.z1, y: 60, face: site.face, by: [], done: true, at: 0 });
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
const count = new Map<string, number>();
for (const b of builds) count.set(b.kind, (count.get(b.kind) ?? 0) + 1);
console.log(`${builds.length} buildings on lots (${[...count].map(([k, n]) => `${k} ${n}`).join(", ")}), ${roads.cells.length} street and path cells, the wall ${r} out (${wall.length} blocks); ${failed} with no lot, ${problems} problems`);
if (process.env.MAP !== "0") {
  const L: Record<string, string> = { house: "h", storehouse: "S", hall: "H", market: "M", well: "W", tower: "T", keep: "K", plaza: "P", smithy: "F", bakery: "B", tavern: "V", library: "L", chapel: "C", barn: "N", fountain: "O", monument: "M", cathedral: "X" };
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
