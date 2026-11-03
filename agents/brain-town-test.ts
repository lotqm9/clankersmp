// clankersmp: the whole build job, the way an AI calls it, on a throwaway test server (DEV_COMMANDS=1) with no model:
// the pack's base in a fresh spot, raw materials only (cobblestone, oak logs, sand, coal, iron), then build plaza,
// build house, build road, build lamp, upgrade house. The job has to find the sites, turn the fronts to the plaza,
// craft and smelt everything itself (planks, stairs, a door, fences, glass panes, stone bricks, lanterns), and the
// town text has to point at the next thing to do.
//   AGENT_SECRET=... AT=x,z node agents/brain-town-test.ts [ws://127.0.0.1:8789]
//   CENTRE=x,z puts the town's centre there (the plaza goes on it); TREE=x,z grows an oak there first (a tree on a lot).
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Body } from "./body.ts";
import { BLOCKS } from "../shared/blocks.ts";

const url = process.argv[2] || "ws://127.0.0.1:8789";
const [ax, az] = (process.env.AT || "264,64").split(",").map(Number);
const name = process.env.BODY || "sonnet";
const b = new Body(name);
await b.connect(url, process.env.AGENT_SECRET ?? "");
await b.wait(10);
let gy = 120;
while (gy > 2 && !BLOCKS[b.get(ax, gy, az)]?.solid) gy--;
b.send({ t: "chat", text: `/tp ${ax + 0.5} ${gy + 1} ${az + 0.5}` });
b.send({ t: "chat", text: "/gamemode survival" });
await b.wait(20);
// an empty inventory to start from (the server keeps each AI's things between test runs): everything thrown out here,
// and a walk away from it
for (let k = 0; k < 36; k++) {
  const st = b.inv[k];
  if (!st || !(await b.hold(st.id))) continue;
  b.send({ t: "drop", all: true });
  await b.wait(2);
}
b.send({ t: "chat", text: `/tp ${ax + 0.5} ${gy + 1} ${az + 12.5}` });
await b.wait(20);
b.send({ t: "chat", text: `/tp ${ax + 0.5} ${gy + 1} ${az + 0.5}` });
b.send({ t: "chat", text: "/time 2000" });
await b.wait(40);

// a tree on the lot to be (TREE=x,z): a sapling planted there and grown at once
if (process.env.TREE) {
  const [tx, tz] = process.env.TREE.split(",").map(Number);
  let ty = 120;
  while (ty > 2 && !BLOCKS[b.get(tx, ty, tz)]?.solid) ty--;
  b.send({ t: "chat", text: "/give oak_sapling 1" });
  await b.wait(10);
  const ok = await b.place(BLOCKS.find((d) => d?.key === "oak_sapling")!.id, tx, ty + 1, tz, 20000);
  b.send({ t: "chat", text: "/grow" });
  await b.wait(20);
  console.log(`a tree at ${tx},${tz}: ${ok ? "planted and grown" : "the sapling wouldn't go in"} (${BLOCKS[b.get(tx, ty + 1, tz)]?.key} at its foot)`);
  b.send({ t: "chat", text: `/tp ${ax + 0.5} ${gy + 1} ${az + 0.5}` });
  await b.wait(20);
}
// a pack with its base here and nothing built (the brain reads it on load); the centre where CENTRE says
const dir = mkdtempSync(join(tmpdir(), "clanker-pack-"));
const centre = process.env.CENTRE ? process.env.CENTRE.split(",").map(Number) : null;
writeFileSync(join(dir, "pack.json"), JSON.stringify({ plan: "", by: "", base: { x: ax, y: gy + 1, z: az }, houses: {}, builds: [], trades: 0, stage: -1, ...(centre ? { centre: { x: centre[0], z: centre[1] } } : {}) }));
process.env.AGENT_STATE_DIR = dir;
const { Brain } = await import("./brain.ts");
const brain = new Brain(name, b, "test", "http://127.0.0.1:9", "http://127.0.0.1:9") as unknown as {
  load(): void; exec(n: string, i: Record<string, unknown>): Promise<string>; civText(): string; auditTown(): void; boardText(): string;
};
brain.load();

const give = (k: string, n: number) => b.send({ t: "chat", text: `/give ${k} ${n}` });
for (const [k, n] of [["stone_pickaxe", 1], ["stone_shovel", 1], ["stone_axe", 1], ["cobblestone", 192], ["oak_log", 96], ["sand", 16], ["coal", 24], ["raw_iron", 4], ["bread", 16], ["red_bed", 1]] as [string, number][]) give(k, n);
await b.wait(30);

const steps: [string, string][] = (process.env.STEPS || "build:plaza,build:house,build_house:-,build:road,build:lamp,build:lamp,upgrade:house").split(",").map((s) => s.split(":") as [string, string]);
const t0 = Date.now();
for (const [tool, what] of steps) {
  b.send({ t: "chat", text: "/time 2000" });
  b.send({ t: "chat", text: "/hunger 20" });
  for (let k = 0; k < 4; k++) {
    // the tool's own argument: what to build, what to do with the storehouse (put, take, look)
    const r = await brain.exec(tool, tool === "storehouse" ? { action: what } : tool === "work" ? {} : { what });
    console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${tool} ${what}: ${r}`);
    if (tool === "storehouse" || tool === "work" || /^(finished|upgraded|moved)/.test(r) || /couldn't|no flat|there is no|already/.test(r)) break;
    // what an AI would do between calls: top up what the job says it couldn't get by itself
    if (/coal/.test(r)) give("coal", 8);
  }
}
console.log("\n" + brain.civText());
console.log("\n" + brain.boardText());
// where everything went on the town plan
const pack = JSON.parse(readFileSync(join(dir, "pack.json"), "utf8"));
console.log(`\nthe town's centre: ${JSON.stringify(pack.centre)}`);
for (const x of pack.builds) console.log(`  ${x.kind} at ${x.x0},${x.z0}..${x.x1},${x.z1} facing ${x.face ?? 0}, ${x.done ? `done, tier ${x.tier ?? 1}` : "not done"}`);
process.exit(0);
