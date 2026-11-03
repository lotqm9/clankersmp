// clankersmp: the town board's job queue without a server. A few towns (a camp, a hamlet short of oak, a town with a
// tree farm grown and a birch district, a city) are put to planJobs the way the brain puts its town to it, and the
// queue comes out: how long it is, the most urgent jobs, every kind of job there. Then each role takes its next job
// in turn (pickJob, the way work does), claims it, and the next one takes the next.
//   node agents/jobs-test.ts          (JOBS=40 to print more of each queue)
import { KINDS, STAGES } from "./civ.ts";
import { KIND_INFO } from "./catalog.ts";
import { pickJob, planJobs, type Job, type Role, type TownState } from "./board.ts";
import { districtOf } from "./town.ts";

const show = Number(process.env.JOBS || 14);
const kinds = Object.entries(KIND_INFO)
  .filter(([k]) => !["house", "lamp", "plaza", "wall", "road", "farm"].includes(k) && KINDS[k])
  .map(([k, i]) => ({ k, one: i.one, from: i.from, most: i.most, have: 0, small: false, district: districtOf(k) }));
const bld = (kind: string, at: [number, number], tier = 1, done = true, extra: Partial<TownState["buildings"][number]> = {}) => ({ kind, name: `the ${kind}`, at, tier, max: kind === "lamp" ? 3 : 3, done, fix: false, ...extra });
const needsOf = (stage: number, have: (k: string) => number) => (STAGES[stage + 1]?.needs ?? []).map(([k, n, t]) => ({ k, n, tier: t ?? 1, have: Math.min(n, have(k)) }));

const towns: { name: string; s: TownState }[] = [];
{
  const b = [bld("house", [260, 70], 0)];
  towns.push({
    name: "a camp (one shelter)",
    s: { stage: 0, needs: needsOf(0, (k) => (k === "house" ? 1 : 0)), later: STAGES.slice(2).flatMap((st) => st.needs.map(([k, n, t]) => ({ k, n, tier: t ?? 1 }))), buildings: b, short: {}, stock: {}, roads: { doors: 1, joined: 0, paved: 0 }, lamps: { have: 0, want: 0 }, furniture: { bench: 0, flowerbed: 0, want: 0 }, trees: { farms: 0, grown: 0 }, fields: [], food: { have: 20, want: 30, fields: true }, kinds, smelt: false, birch: false },
  });
}
{
  const b = [bld("house", [260, 70]), bld("house", [270, 70]), bld("well", [256, 60]), bld("storehouse", [250, 60], 1, false)];
  towns.push({
    name: "a homestead on its way to a hamlet, short of oak",
    s: { stage: 1, needs: needsOf(1, (k) => (k === "house" ? 2 : k === "farm" ? 1 : 0)), later: STAGES.slice(3).flatMap((st) => st.needs.map(([k, n, t]) => ({ k, n, tier: t ?? 1 }))), buildings: b, short: { wood: 22, stone: 10 }, stock: { stone: 12 }, roads: { doors: 3, joined: 0, paved: 0 }, lamps: { have: 0, want: 2 }, furniture: { bench: 0, flowerbed: 0, want: 1 }, trees: { farms: 0, grown: 0 }, fields: [{ at: [240, 80] }], food: { have: 12, want: 30, fields: false }, kinds, smelt: false, birch: false },
  });
}
{
  const b = [
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => bld("house", [240 + i * 10, 80], i < 5 ? 2 : 1)), bld("storehouse", [250, 60], 2), bld("plaza", [256, 56]), bld("market", [266, 56]), bld("hall", [246, 50]),
    bld("smithy", [280, 56], 1), bld("tavern", [230, 56], 1, true, { fix: true }), bld("tower", [290, 30]), bld("treefarm", [300, 90]), bld("library", [256, 40], 1, false),
  ];
  towns.push({
    name: "a market town with a grown tree farm and a birch district",
    s: { stage: 4, needs: needsOf(4, (k) => (k === "house" ? 10 : ["hall", "storehouse", "plaza"].includes(k) ? 1 : 0)), later: STAGES.slice(6).flatMap((st) => st.needs.map(([k, n, t]) => ({ k, n, tier: t ?? 1 }))), buildings: b, short: { birch: 14 }, stock: { stone: 70, wood: 12, sand: 20 }, roads: { doors: 18, joined: 14, paved: 4 }, lamps: { have: 9, want: 14 }, furniture: { bench: 2, flowerbed: 1, want: 6 }, trees: { farms: 1, grown: 4, at: [300, 90] }, fields: [{ at: [320, 80] }], food: { have: 60, want: 30, fields: false }, kinds: kinds.map((k) => (k.k === "treefarm" ? { ...k, have: 1 } : k)), smelt: true, birch: true },
  });
}
let bad = 0;
for (const { name, s } of towns) {
  const q = planJobs(s);
  const by: Record<string, number> = {};
  for (const j of q) by[j.kind] = (by[j.kind] ?? 0) + 1;
  console.log(`\n${name}: ${q.length} jobs (${Object.entries(by).map(([k, n]) => `${k} ${n}`).join(", ")})`);
  q.slice(0, show).forEach((j, i) => console.log(`  ${String(i + 1).padStart(2)}. [${j.role}] ${j.text}`));
  // sorted, unique ids, never empty
  if (!q.length) bad++;
  if (new Set(q.map((j) => j.id)).size !== q.length) {
    bad++;
    console.log("  FAIL: two jobs with the same id");
  }
  if (q.some((j, i) => i && j.pri < q[i - 1].pri)) {
    bad++;
    console.log("  FAIL: not in order");
  }
  // the three take their next jobs in turn, each claiming its own; nobody takes another's
  const roles: [string, Role][] = [["opus", "builder"], ["sonnet", "mason"], ["haiku", "woodcutter"]];
  const now = Date.now();
  const taken: Job[] = [];
  for (let round = 0; round < 2; round++)
    for (const [n, r] of roles) {
      const j = pickJob(q, r, n, now, (x) => !taken.includes(x) || x.by === n);
      if (!j) continue;
      if (j.by && j.by !== n) {
        bad++;
        console.log(`  FAIL: ${n} took ${j.id}, held by ${j.by}`);
      }
      j.by = n;
      j.since = now;
      if (!taken.includes(j)) taken.push(j);
      if (round === 0) console.log(`  ${n} (${r}) takes: ${j.text}`);
    }
}
// the stages after the capital still leave work: every catalog kind turns up on the queue at some stage
const all = new Set<string>();
for (let st = -1; st < STAGES.length; st++) for (const j of planJobs({ ...towns[0].s, stage: st, needs: needsOf(st, () => 0), buildings: [] })) all.add(j.k);
const never = kinds.filter((k) => !all.has(k.k) && k.district !== "beside a street").map((k) => k.k);
console.log(`\nkinds the queue offers over the stages: ${all.size}${never.length ? `; never offered: ${never.join(", ")}` : ""}`);
console.log(bad ? `${bad} problems` : "the queue holds up");
process.exit(bad ? 1 : 0);
