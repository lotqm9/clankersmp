// clankersmp: wood for a young town on an oak-poor start, on a throwaway test server (DEV_COMMANDS=1) with no model.
// The agents start in the wild (season 16: around 108,108 on seed 1014, six oaks within 32 blocks). Checked:
//   - at camp stage the woodcutter's first job is the tree farm;
//   - collecting oak twice there: the second time the oaks round it are gone, so it goes out for more (and comes
//     back with logs, on the ground: never stranded up on a canopy, never "no town_log within 32");
//   - where no oak grows near and birch does (AT2), the woodcutter's wood job brings birch rather than nothing;
//   - a house not begun yet goes up in birch there (its oak design swapped for the birch one), and stays oak where
//     oak is near.
//   AGENT_SECRET=... AT2=416,72 node agents/earlywood-test.ts [ws://127.0.0.1:8818]
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Body } from "./body.ts";
import { B, BLOCKS } from "../shared/blocks.ts";

const url = process.argv[2] || "ws://127.0.0.1:8818";
const [bx, bz] = (process.env.AT2 || "416,72").split(",").map(Number);
const names = ["opus", "haiku"];
const bodies = names.map((n) => new Body(n));
await Promise.all(bodies.map((b) => b.connect(url, process.env.AGENT_SECRET ?? "")));
const [opus, haiku] = bodies;
await haiku.wait(20);
const cmd = (b: Body, t: string) => b.send({ t: "chat", text: t });
for (const b of bodies) {
  cmd(b, "/gamemode survival");
  cmd(b, "/time 1000");
  cmd(b, "/give stone_axe 1");
  cmd(b, "/give bread 8");
}
await haiku.wait(30);
const [ax, ay, az] = [Math.floor(haiku.phys.x), Math.floor(haiku.phys.y), Math.floor(haiku.phys.z)];
console.log(`the start: ${ax},${ay},${az}`);
const dir = mkdtempSync(join(tmpdir(), "clanker-earlywood-"));
const board = { day: 1, at: Date.now(), roles: { opus: "builder", haiku: "woodcutter" }, project: null, short: {} };
writeFileSync(join(dir, "pack.json"), JSON.stringify({ plan: "", by: "", base: { x: ax, y: ay, z: az }, houses: {}, builds: [], trades: 0, stage: -1, board }));
process.env.AGENT_STATE_DIR = dir;
const { Brain } = await import("./brain.ts");
type T = { load(): void; beat(): void; exec(n: string, i: Record<string, unknown>): Promise<string>; updateBoard(): void; takeJob(r: string): { text: string; k?: string } | null; stockJob(j: Record<string, unknown>): Promise<string>; woodFor(s: Record<string, unknown>): void };
const brains = names.map((n, i) => new Brain(n, bodies[i], "test", "http://127.0.0.1:9", "http://127.0.0.1:9") as unknown as T);
for (const br of brains) br.load();
const [ob, hb] = brains;
const beat = setInterval(() => brains.forEach((br) => br.beat()), 1000);
const results: string[] = [];
const check = (what: string, ok: boolean) => {
  results.push(`${ok ? "PASS" : "FAIL"} ${what}`);
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
};
const logs = (b: Body) => b.count(B.OAK_LOG) + b.count(B.BIRCH_LOG) + b.count(B.PALM_LOG);
const ground = (b: Body) => {
  const x = Math.floor(b.phys.x);
  const z = Math.floor(b.phys.z);
  let y = Math.floor(b.phys.y + 0.1) - 1;
  while (y > 2 && !BLOCKS[b.get(x, y, z)]?.solid) y--;
  return Math.floor(b.phys.y + 0.1) - (y + 1);
};

// the camp's job list: the woodcutter's first job is the tree farm
hb.updateBoard();
const j = hb.takeJob("woodcutter");
console.log(`the woodcutter takes: ${j?.text}`);
check("at camp stage the woodcutter's first job is the tree farm", j?.k === "treefarm");

// oak, twice: the second time the oaks round the start are gone
for (let k = 1; k <= 2; k++) {
  const had = logs(haiku);
  const t0 = Date.now();
  const r = await hb.exec("collect", { item: "town_log", count: 24 });
  console.log(`[${Math.round((Date.now() - t0) / 1000)}s] collect town_log 24 (#${k}): ${r.slice(0, 240)}`);
  check(`collect #${k} brings oak (${logs(haiku) - had} logs)`, logs(haiku) - had >= 12 && !/no town_log within 32/.test(r));
  check(`and it ends on the ground (${ground(haiku)} above it)`, ground(haiku) <= 1);
}

// no oak near, birch there: the wood job brings birch, and a house not begun goes up in birch
cmd(haiku, `/tp ${bx + 0.5} 100 ${bz + 0.5}`);
cmd(opus, `/tp ${bx + 2.5} 100 ${bz + 0.5}`);
await haiku.wait(60);
const had = haiku.count(B.BIRCH_LOG);
const r = await hb.stockJob({ id: "stock:wood", kind: "stock", k: "wood", n: 16, text: "stock the storehouse with 16 oak logs", role: "woodcutter", pri: 56 });
console.log(`stock wood at ${bx},${bz}: ${r.slice(0, 260)}`);
check(`with no oak near and birch there, the wood job brings birch (${haiku.count(B.BIRCH_LOG) - had} birch logs)`, haiku.count(B.BIRCH_LOG) - had >= 8);
cmd(opus, "/give birch_log 64");
await opus.wait(30);
const site = (x: number, z: number) => ({ kind: "house", design: "house/oak-hut-gable", x0: x, z0: z, x1: x + 6, z1: z + 7, y: 60, face: 0, by: [], done: false, at: Date.now() });
const here = site(Math.floor(opus.phys.x) + 4, Math.floor(opus.phys.z) + 4);
ob.woodFor(here);
check(`a house not begun, no oak near and birch on hand: it goes up in birch (${here.design})`, here.design === "house/birch-hut-gable");
// with the oak for it on hand (the woodcutter's haul), it stays oak
cmd(opus, `/tp ${ax + 0.5} ${ay + 1} ${az + 0.5}`);
cmd(opus, "/give oak_log 64");
await opus.wait(60);
const there = site(ax + 4, az + 4);
ob.woodFor(there);
check(`with the oak for it to hand it stays oak (${there.design})`, there.design === "house/oak-hut-gable");
clearInterval(beat);
console.log(`\n${results.join("\n")}`);
process.exit(results.every((x) => x.startsWith("PASS")) ? 0 : 1);
