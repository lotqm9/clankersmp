// clankersmp: the town board's job queue, worked by the three on a throwaway test server (DEV_COMMANDS=1) with no
// model. Three brains share one pack with its base, a plaza and a storehouse to start from; each calls work in turn,
// the way an AI does when it finishes a job, and takes the next job off the queue (its own role's first); the queue
// is checked as it goes: long, in order, each one on a job of its own, the civ event carrying its top. The town gets
// a tree farm, benches and flower beds, a quarry, what the next stage asks for, its materials handed over by /give
// the way the town test does (so the jobs build rather than spend an hour mining).
//   AGENT_SECRET=... AT=x,z ROUNDS=4 node agents/queue-test.ts [ws://127.0.0.1:8814]
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Body } from "./body.ts";
import { BLOCKS } from "../shared/blocks.ts";

const url = process.argv[2] || "ws://127.0.0.1:8814";
const [ax, az] = (process.env.AT || "380,120").split(",").map(Number);
const rounds = Number(process.env.ROUNDS || 4);
const names = ["opus", "sonnet", "haiku"];
const bodies = names.map((n) => new Body(n));
await Promise.all(bodies.map((b) => b.connect(url, process.env.AGENT_SECRET ?? "")));
const b0 = bodies[0];
await b0.wait(10);
const cmd = (b: Body, t: string) => b.send({ t: "chat", text: t });
cmd(b0, `/tp ${ax + 0.5} 100 ${az + 0.5}`);
await b0.wait(30);
let gy = 120;
while (gy > 2 && !BLOCKS[b0.get(ax, gy, az)]?.solid) gy--;
for (const [i, b] of bodies.entries()) {
  cmd(b, "/gamemode survival");
  cmd(b, `/tp ${ax + 0.5 + i * 2} ${gy + 1} ${az + 0.5}`);
}
await b0.wait(30);
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

const dir = mkdtempSync(join(tmpdir(), "clanker-queue-"));
writeFileSync(join(dir, "pack.json"), JSON.stringify({ plan: "", by: "", base: { x: ax, y: gy + 1, z: az }, houses: {}, builds: [], trades: 0, stage: -1 }));
process.env.AGENT_STATE_DIR = dir;
const { Brain } = await import("./brain.ts");
type T = { load(): void; exec(n: string, i: Record<string, unknown>): Promise<string>; beat(): void; boardText(): string; updateBoard(): void; log: string[]; emitCiv(t?: string): void; emit: (t: string, d: Record<string, unknown>) => void };
const brains = names.map((n, i) => new Brain(n, bodies[i], "test", "http://127.0.0.1:9", "http://127.0.0.1:9") as unknown as T);
// what the civ event carries (the relay keeps it for the site and watch.mjs)
let civ: Record<string, unknown> | null = null;
for (const br of brains) {
  br.load();
  const emit = br.emit.bind(br);
  br.emit = (t, d) => {
    if (t === "civ") civ = d;
    emit(t, d);
  };
}
const beater = setInterval(() => brains.forEach((br) => br.beat()), 1000);
const pack = () => JSON.parse(readFileSync(join(dir, "pack.json"), "utf8"));
const t0 = Date.now();
const say = (who: string, what: string, r: string) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${who} ${what}: ${r.slice(0, 400)}`);
const results: string[] = [];
const check = (what: string, ok: boolean) => {
  results.push(`${ok ? "PASS" : "FAIL"} ${what}`);
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
};
// the tools and plenty of what a young town is built of, for each (the jobs fetch the rest themselves)
const stuff: [string, number][] = [["stone_pickaxe", 1], ["stone_axe", 1], ["stone_shovel", 1], ["stone_hoe", 1], ["wheat_seeds", 8], ["bread", 8], ["cobblestone", 128], ["oak_log", 64], ["birch_log", 32], ["oak_sapling", 8], ["poppy", 8], ["dandelion", 8], ["bluebell", 4], ["coal", 16], ["sand", 16], ["dirt", 32]];
const top = (b: Body) => {
  for (const [k, n] of stuff) {
    const id = BLOCKS.find((d) => d?.key === k)?.id;
    if (id === undefined || b.count(id) < n / 2) cmd(b, `/give ${k} ${n}`);
  }
};
for (const b of bodies) top(b);
await b0.wait(30);
// the plaza and the storehouse first (the board's pool), the way a town starts
say("opus", "build plaza", await brains[0].exec("build", { what: "plaza" }));
for (let k = 0; k < 3; k++) {
  const r = await brains[1].exec("build", { what: "storehouse" });
  say("sonnet", "build storehouse", r);
  if (/^finished/.test(r)) break;
  top(bodies[1]);
}
check("the plaza and the storehouse stand", pack().builds.some((x: { kind: string; done: boolean }) => x.kind === "storehouse" && x.done));
// what a young town is built of: anything else standing is the catalog's
const BASIC = ["plaza", "storehouse", "house", "well", "road", "lamp", "farm"];
// now the queue: each takes its next job when it finishes one
const took: Record<string, string[]> = {};
for (let r = 0; r < rounds; r++) {
  for (const [i, br] of brains.entries()) {
    cmd(bodies[i], "/time 3000");
    cmd(bodies[i], "/hunger 20");
    top(bodies[i]);
    await bodies[i].wait(10);
    const q = (pack().board?.queue ?? []) as { id: string; text: string; by?: string; pri: number }[];
    const res = await br.exec("work", {});
    const held = ((pack().board?.queue ?? []) as { by?: string; text: string }[]).find((j) => j.by === names[i]);
    (took[names[i]] ??= []).push(`${(br as unknown as { body: Body }).body.action}`);
    say(names[i], `work (round ${r + 1}, queue ${q.length})`, res);
    if (held) console.log(`    still on: ${held.text}`);
  }
  const q = (pack().board?.queue ?? []) as { id: string; pri: number; by?: string }[];
  if (r === 0) {
    check(`the queue is long (${q.length} jobs)`, q.length >= 20);
    check("the queue is in order", q.every((j, k) => !k || j.pri >= q[k - 1].pri));
    const held = q.filter((j) => j.by);
    check("nobody holds two jobs, no job held by two", new Set(held.map((j) => j.by)).size === held.length);
  }
  // once a building of the catalog's stands (past the stage's needs), the rest of the rounds can go
  const beyond = pack().builds.find((x: { kind: string; done: boolean }) => x.done && !BASIC.includes(x.kind));
  if (beyond) {
    console.log(`a ${beyond.kind} stands after round ${r + 1}`);
    break;
  }
}
clearInterval(beater);
const p = pack();
const kinds = new Map<string, number>();
for (const x of p.builds) if (x.done) kinds.set(x.kind, (kinds.get(x.kind) ?? 0) + 1);
console.log(`\nbuilt: ${[...kinds].map(([k, n]) => `${k} ${n}`).join(", ")}`);
for (const x of p.builds) console.log(`  ${x.kind}${x.design ? ` (${x.design})` : ""} at ${x.x0},${x.z0}..${x.x1},${x.z1}${x.done ? `, tier ${x.tier ?? 1}` : ", not done"}`);
check("the work went past the stage's needs onto the catalog", p.builds.some((x: { kind: string; done: boolean }) => x.done && !BASIC.includes(x.kind)));
check("the civ event carries the queue's top and the catalog", !!civ && Array.isArray((civ as { queue?: unknown }).queue) && ((civ as { queue: unknown[] }).queue.length > 0) && !!(civ as { catalog?: unknown }).catalog);
check("the districts have their styles", Array.isArray(p.styles) && p.styles.length === 4);
console.log(`\nthe queue's top now:\n${((p.board?.queue ?? []) as { text: string; by?: string }[]).slice(0, 12).map((j, k) => `  ${k + 1}. ${j.text}${j.by ? ` [${j.by}]` : ""}`).join("\n")}`);
console.log(`\n${brains[0].boardText()}`);
console.log(`\n${results.join("\n")}`);
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
