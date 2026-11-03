// clankersmp: the three as a team, on a throwaway test server (DEV_COMMANDS=1) with no model. Three brains share one
// pack (one base, one board, one storehouse), the way they run in one process live. The storehouse goes up first;
// then the board hands out the roles; the mason's work (morning) fetches stone and puts it in the storehouse with a
// line in chat; the builder's build takes from the storehouse before it gathers anything itself; the woodcutter's work
// at dusk puts its logs away and goes home; at dawn work gets them up and fed from the pool; at night with no bed it
// digs in. The status the site reads carries each one's slot, role and job.
//   AGENT_SECRET=... AT=x,z node agents/team-test.ts [ws://127.0.0.1:8814]
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Body } from "./body.ts";
import { slotOf } from "./board.ts";
import { B, BLOCKS } from "../shared/blocks.ts";
import { I, itemDef } from "../shared/items.ts";

const url = process.argv[2] || "ws://127.0.0.1:8814";
const [ax, az] = (process.env.AT || "192,472").split(",").map(Number);
const names = ["opus", "sonnet", "haiku"];
const bodies = names.map((n) => new Body(n));
await Promise.all(bodies.map((b) => b.connect(url, process.env.AGENT_SECRET ?? "")));
const b0 = bodies[0];
await b0.wait(10);
let gy = 120;
while (gy > 2 && !BLOCKS[b0.get(ax, gy, az)]?.solid) gy--;
const cmd = (b: Body, t: string) => b.send({ t: "chat", text: t });
for (const [i, b] of bodies.entries()) {
  cmd(b, "/gamemode survival");
  cmd(b, `/tp ${ax + 0.5 + i * 2} ${gy + 1} ${az + 0.5}`);
}
await b0.wait(30);
// empty bags (the server keeps each AI's things between runs): thrown out, then a walk away from the pile
await Promise.all(bodies.map(async (b) => {
  for (let k = 0; k < 36; k++) {
    const st = b.inv[k];
    if (!st || !(await b.hold(st.id))) continue;
    b.send({ t: "drop", all: true });
    await b.wait(2);
  }
}));
for (const [i, b] of bodies.entries()) cmd(b, `/tp ${ax + 0.5 + i * 2} ${gy + 1} ${az + 14.5}`);
await b0.wait(20);
for (const [i, b] of bodies.entries()) cmd(b, `/tp ${ax + 0.5 + i * 2} ${gy + 1} ${az + 0.5}`);
cmd(b0, "/time 2000");
await b0.wait(30);

const dir = mkdtempSync(join(tmpdir(), "clanker-team-"));
writeFileSync(join(dir, "pack.json"), JSON.stringify({ plan: "", by: "", base: { x: ax, y: gy + 1, z: az }, houses: {}, builds: [], trades: 0, stage: -1 }));
process.env.AGENT_STATE_DIR = dir;
const { Brain } = await import("./brain.ts");
type T = { load(): void; exec(n: string, i: Record<string, unknown>): Promise<string>; beat(): void; boardText(): string; updateBoard(): void; log: string[] };
const brains = names.map((n, i) => new Brain(n, bodies[i], "test", "http://127.0.0.1:9", "http://127.0.0.1:9") as unknown as T);
for (const br of brains) br.load();
const beat = () => brains.forEach((br) => br.beat());
const beater = setInterval(beat, 1000);
const [opus, sonnet, haiku] = brains;
const give = (b: Body, k: string, n: number) => cmd(b, `/give ${k} ${n}`);
for (const b of bodies) for (const [k, n] of [["stone_pickaxe", 1], ["stone_axe", 1], ["stone_shovel", 1], ["stone_sword", 1], ["bread", 4]] as [string, number][]) give(b, k, n);
await b0.wait(20);
const t0 = Date.now();
const say = (who: string, what: string, r: string) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${who} ${what}: ${r}`);
const checks: [string, boolean][] = [];
const check = (what: string, ok: boolean) => {
  checks.push([what, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
};
const pack = () => JSON.parse(readFileSync(join(dir, "pack.json"), "utf8"));
/** Set the time and wait for the bodies to hear it (the server's time messages come every few seconds). */
const setTime = async (t: number) => {
  cmd(b0, `/time ${t}`);
  for (let k = 0; k < 120 && bodies.some((b) => Math.abs(((b.timeOfDay() - t + 36000) % 24000) - 12000) < 11500); k++) await b0.wait(2);
};

// 1. the storehouse, built by sonnet from what it is given (the pool everything else goes through)
// (enough oak for it: this test is about the team, not about how far the oak is)
for (const [k, n] of [["cobblestone", 128], ["oak_log", 128], ["coal", 8]] as [string, number][]) give(bodies[1], k, n);
await b0.wait(20);
for (let k = 0; k < 4; k++) {
  await setTime(2000);
  const r = await sonnet.exec("build", { what: "storehouse" });
  say("sonnet", "build storehouse", r);
  if (/^finished/.test(r)) break;
}
check("the storehouse stands", pack().builds.some((x: { kind: string; done: boolean }) => x.kind === "storehouse" && x.done));

// 2. the board: three roles, a project, what it's short of
beat();
opus.updateBoard();
const bd = pack().board;
console.log("\n" + opus.boardText() + "\n");
check("the board gives all three a role, one builder", Object.keys(bd?.roles ?? {}).length === 3 && Object.values(bd.roles).filter((r) => r === "builder").length === 1);
check("the board has a project", !!bd?.project);
const roleOf = (n: string) => pack().board.roles[n] as string;
const by = (r: string) => brains[names.findIndex((n) => roleOf(n) === r)] ?? null;
const nameBy = (r: string) => names.find((n) => roleOf(n) === r) ?? "";

// 3. a gatherer's morning work: its role's raw material into the storehouse, with a line in chat
const gatherer = by("mason") ?? by("woodcutter") ?? by("farmer");
const gName = names[brains.indexOf(gatherer!)];
await setTime(2000);
const before = Object.values(pack().chests ?? {}).reduce((n: number, c) => n + Object.values(c as Record<string, number>).reduce((a, v) => a + v, 0), 0);
const w1 = await gatherer!.exec("work", {});
say(gName, `work (${roleOf(gName)}, morning)`, w1);
const after = Object.values(pack().chests ?? {}).reduce((n: number, c) => n + Object.values(c as Record<string, number>).reduce((a, v) => a + v, 0), 0);
check(`${gName}'s morning work put its haul in the storehouse`, after > before && /in the storehouse/.test(w1));
check(`${gName} said so in chat`, gatherer!.log.some((l) => /You said: ".*storehouse/.test(l)));

// 4. the builder takes from the pool before gathering: a well, with nothing in its bag but tools
const builder = by("builder")!;
const bName = nameBy("builder");
const bb = bodies[names.indexOf(bName)];
for (let k = 0; k < 36; k++) {
  const st = bb.inv[k];
  if (!st || itemDef(st.id)?.tool || !(await bb.hold(st.id))) continue;
  bb.send({ t: "drop", all: true });
  await bb.wait(2);
}
give(bodies[names.indexOf(gName)], "cobblestone", 64);
await b0.wait(10);
say(gName, "storehouse put", await gatherer!.exec("storehouse", { action: "put" }));
await setTime(2000);
const w2 = await builder.exec("build", { what: "well" });
say(bName, "build well", w2);
check(`${bName}'s build took from the storehouse first`, builder.log.some((l) => /from the storehouse/.test(l)));

// 5. dusk: the woodcutter (or whoever isn't the builder) puts its logs away and heads home (it has none: says so)
const dusk = brains.find((br) => br !== builder)!;
const dName = names[brains.indexOf(dusk)];
give(bodies[names.indexOf(dName)], "oak_log", 40);
await b0.wait(10);
await setTime(11000);
check("time 11000 is dusk", slotOf(bodies[0].timeOfDay()) === "dusk");
const w3 = await dusk.exec("work", {});
say(dName, "work (dusk)", w3);
check(`${dName}'s dusk round put its logs in the storehouse`, /put .*oak_log.* in the storehouse/.test(w3) && bodies[names.indexOf(dName)].count(B.OAK_LOG) <= 4);

// 6. dawn: out of bed and fed, food from the pool when it carries little
give(bodies[1], "bread", 16);
await b0.wait(10);
say("sonnet", "storehouse put bread", await sonnet.exec("storehouse", { action: "put", item: "bread", count: 16 }));
const hungry = brains.find((br) => br !== sonnet)!;
const hName = names[brains.indexOf(hungry)];
const hb = bodies[names.indexOf(hName)];
for (let k = 0; k < 36; k++) {
  const st = hb.inv[k];
  if (!st || st.id !== I.BREAD || !(await hb.hold(st.id))) continue;
  hb.send({ t: "drop", all: true });
  await hb.wait(2);
}
cmd(hb, "/hunger 10");
await setTime(23800);
check("time 23800 is dawn", slotOf(bodies[0].timeOfDay()) === "dawn");
const w4 = await hungry.exec("work", {});
say(hName, "work (dawn)", w4);
check(`${hName}'s dawn took food from the pool`, /bread/.test(w4) && hb.count(I.BREAD) > 0);

// 7. night with no bed: dig in
await setTime(15000);
const w5 = await haiku.exec("work", {});
say("haiku", "work (night, no bed)", w5);
check("night with no bed digs in", /dug|sealed|hole|mined|night/.test(w5));

// 8. the status the site reads: slot, role, job
const seen: Record<string, unknown>[] = [];
(haiku as unknown as { emit: (t: string, d: Record<string, unknown>) => void }).emit = (t, d) => {
  if (t === "status") seen.push(d);
};
haiku.beat();
check("the status carries slot, role and job", !!seen[0] && "slot" in seen[0] && "role" in seen[0] && "job" in seen[0]);
console.log("haiku's status:", JSON.stringify({ slot: seen[0]?.slot, role: seen[0]?.role, job: seen[0]?.job, action: seen[0]?.action }));

clearInterval(beater);
console.log(`\n${checks.filter(([, ok]) => ok).length}/${checks.length} checks passed in ${Math.round((Date.now() - t0) / 1000)}s`);
console.log(opus.boardText());
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
