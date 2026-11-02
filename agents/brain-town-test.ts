// clankersmp: the whole build job, the way an AI calls it, on a throwaway test server (DEV_COMMANDS=1) with no model:
// the pack's base in a fresh spot, raw materials only (cobblestone, oak logs, sand, coal, iron), then build plaza,
// build house, build road, build lamp, upgrade house. The job has to find the sites, turn the fronts to the plaza,
// craft and smelt everything itself (planks, stairs, a door, fences, glass panes, stone bricks, lanterns), and the
// town text has to point at the next thing to do.
//   AGENT_SECRET=... AT=x,z node agents/brain-town-test.ts [ws://127.0.0.1:8789]
import { mkdtempSync, writeFileSync } from "node:fs";
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
b.send({ t: "chat", text: "/time 2000" });
await b.wait(40);

// a pack with its base here and nothing built (the brain reads it on load)
const dir = mkdtempSync(join(tmpdir(), "clanker-pack-"));
writeFileSync(join(dir, "pack.json"), JSON.stringify({ plan: "", by: "", base: { x: ax, y: gy + 1, z: az }, houses: {}, builds: [], trades: 0, stage: -1 }));
process.env.AGENT_STATE_DIR = dir;
const { Brain } = await import("./brain.ts");
const brain = new Brain(name, b, "test", "http://127.0.0.1:9", "http://127.0.0.1:9") as unknown as {
  load(): void; exec(n: string, i: Record<string, unknown>): Promise<string>; civText(): string; auditTown(): void;
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
    const r = await brain.exec(tool, { what });
    console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${tool} ${what}: ${r}`);
    if (/^(finished|upgraded|moved)/.test(r) || /couldn't|no flat|there is no|already/.test(r)) break;
    // what an AI would do between calls: top up what the job says it couldn't get by itself
    if (/coal/.test(r)) give("coal", 8);
  }
}
console.log("\n" + brain.civText());
process.exit(0);
