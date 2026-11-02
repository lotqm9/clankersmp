// clankersmp: an old town house (the 5 by 5 cobblestone box the old plans built) under the new rules, on a throwaway
// test server (DEV_COMMANDS=1): the audit has to measure it honestly (tier 0: it stands, but doesn't count as a house
// until it's rebuilt), the town text has to say so, and build house has to rebuild it in place to the cottage design.
//   AGENT_SECRET=... AT=x,z node agents/legacy-test.ts [ws://127.0.0.1:8796]
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Body, type PlanCell } from "./body.ts";
import { B, BLOCKS } from "../shared/blocks.ts";

const url = process.argv[2] || "ws://127.0.0.1:8796";
const [ax, az] = (process.env.AT || "340,150").split(",").map(Number);
const name = process.env.BODY || "sonnet";
const b = new Body(name);
await b.connect(url, process.env.AGENT_SECRET ?? "");
await b.wait(10);
let gy = 120;
while (gy > 2 && !BLOCKS[b.get(ax, gy, az)]?.solid) gy--;
b.send({ t: "chat", text: `/tp ${ax + 0.5} ${gy + 1} ${az + 0.5}` });
b.send({ t: "chat", text: "/gamemode survival" });
b.send({ t: "chat", text: "/time 2000" });
for (const [k, n] of [["stone_pickaxe", 1], ["stone_axe", 1], ["stone_shovel", 1], ["cobblestone", 128], ["oak_planks", 64], ["oak_log", 96], ["coal", 16], ["bread", 16]] as [string, number][]) b.send({ t: "chat", text: `/give ${k} ${n}` });
await b.wait(40);

// the old house, as the old plans built it: stone walls, plank corners and top band, a ring roof of planks
const s = b.siteNear(ax, az, gy + 1, 9, 9, [], 30, 3, 1)!;
const { x0: sx, z0: sz, y } = s;
const x0 = sx + 2;
const z0 = sz + 2; // the old 5 by 5 in the middle of a clear 9 by 9
const old: PlanCell[] = [];
for (let dy = 0; dy < 3; dy++)
  for (let dz = 0; dz < 5; dz++)
    for (let dx = 0; dx < 5; dx++) {
      if (dx > 0 && dx < 4 && dz > 0 && dz < 4) continue;
      const corner = (dx === 0 || dx === 4) && (dz === 0 || dz === 4);
      if (dx === 2 && dz === 0 && dy < 2) continue; // the doorway
      if ((dx === 0 || dx === 4) && dz === 2 && dy === 1) continue; // windows
      old.push([x0 + dx, y + dy, z0 + dz, String(corner || dy === 2 ? B.OAK_PLANKS : B.COBBLESTONE)]);
    }
for (let dz = 0; dz < 5; dz++) for (let dx = 0; dx < 5; dx++) old.push([x0 + dx, y + 3, z0 + dz, String(B.OAK_PLANKS)]);
for (let k = 0; k < 4 && old.some((c) => b.needsWork(c)); k++) await b.buildCells(old, 200, "building the old house");
console.log(`old house at ${x0},${y},${z0}: ${old.filter((c) => b.needsWork(c)).length} cells missing`);

const dir = mkdtempSync(join(tmpdir(), "clanker-pack-"));
writeFileSync(join(dir, "pack.json"), JSON.stringify({
  plan: "", by: "", base: { x: x0 + 2, y, z: z0 + 2 }, houses: {}, trades: 0, stage: 1,
  builds: [{ kind: "house", x0, z0, x1: x0 + 4, z1: z0 + 4, y, by: ["opus"], done: true, at: Date.now() - 86400000 }],
}));
process.env.AGENT_STATE_DIR = dir;
const { Brain } = await import("./brain.ts");
const brain = new Brain(name, b, "test", "http://127.0.0.1:9", "http://127.0.0.1:9") as unknown as {
  load(): void; exec(n: string, i: Record<string, unknown>): Promise<string>; civText(): string; auditTown(): void;
};
brain.load();
console.log("\nbefore the audit:\n" + brain.civText().split("\n")[0]);
brain.auditTown();
console.log("\nafter the audit:\n" + brain.civText().split("\n")[0]);
if (process.env.PAUSE) await b.wait(Number(process.env.PAUSE) * 20);
for (let k = 0; k < 4; k++) {
  b.send({ t: "chat", text: "/time 2000" });
  const r = await brain.exec("build", { what: "house" });
  console.log(`\nbuild house: ${r}`);
  if (/^finished/.test(r) || /couldn't|no flat/.test(r)) break;
}
console.log("\nafterwards:\n" + brain.civText().split("\n")[0]);
console.log(`site ${x0},${y},${z0}`);
if (process.env.HOLD) await b.wait(Number(process.env.HOLD) * 20);
process.exit(0);
