// clankersmp: the body on its own (no Claude): join, find a tree, chop it, pick up the logs, craft planks and sticks,
// put down a crafting table, make a wooden pickaxe, dig in. Prints each step.
//   AGENT_SECRET=... node agents/smoke.ts [ws://127.0.0.1:8787] [name]

import { Body } from "./body.ts";
import { B } from "../shared/blocks.ts";

const url = process.argv[2] || "ws://127.0.0.1:8787";
const b = new Body(process.argv[3] || "haiku");
const t0 = Date.now();
const say = (s: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);

await b.connect(url, process.env.AGENT_SECRET ?? "");
say(`joined at ${b.phys.x.toFixed(1)} ${b.phys.y.toFixed(1)} ${b.phys.z.toFixed(1)}, inventory ${b.inv.filter(Boolean).map((s) => `${s!.id}x${s!.n}`).join(" ")}`);
await b.wait(20);
say(`settled at y ${b.phys.y.toFixed(2)} onGround ${b.phys.onGround}`);
const logs = b.findBlocks([B.OAK_LOG, B.BIRCH_LOG, B.PALM_LOG], 40, 5);
say(`logs nearby: ${JSON.stringify(logs.slice(0, 3))}`);
let got = 0;
for (const [x, y, z] of logs) {
  const ok = await b.mine(x, y, z);
  say(`mine ${x} ${y} ${z}: ${ok}, now at ${b.phys.x.toFixed(1)} ${b.phys.y.toFixed(1)} ${b.phys.z.toFixed(1)}`);
  if (ok) { got++; say(`  pickup: ${await b.pickUp(6)}, logs ${b.count(B.OAK_LOG) + b.count(B.BIRCH_LOG) + b.count(B.PALM_LOG)}`); }
  if (got >= 3) break;
}
say(`picked up ${await b.pickUp(6)}; logs in inventory: ${b.count(B.OAK_LOG) + b.count(B.BIRCH_LOG) + b.count(B.PALM_LOG)}`);
for (const [r, n] of [["oak_planks", 2], ["birch_planks", 2], ["oak_planks_from_palm", 2], ["sticks", 1], ["crafting_table", 1], ["wooden_pickaxe", 1]] as [string, number][]) {
  const res = await b.craft(r, n);
  say(`craft ${r}: ${JSON.stringify(res)}`);
}
say(`inventory: ${b.inv.filter(Boolean).map((s) => `${s!.id}x${s!.n}`).join(" ")}`);
say(`dig in: ${await b.digIn()} (sealed ${b.sealed()})`);
say(`dig out: ${await b.digOut()}`);
b.close();
process.exit(0);
