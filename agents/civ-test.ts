// clankersmp: the town skills on a throwaway test server (DEV_COMMANDS=1): a staircase mine, a well, a lamp post,
// a farm, an empty chest.
//   AGENT_SECRET=... node agents/civ-test.ts ws://127.0.0.1:8789
import { Body } from "./body.ts";
import { planFor } from "./civ.ts";
import { B } from "../shared/blocks.ts";

const b = new Body("opus");
await b.connect(process.argv[2] || "ws://127.0.0.1:8789", process.env.AGENT_SECRET ?? "");
await b.wait(10);
for (const g of ["/give cobblestone 64", "/give dirt 64", "/give stone_pickaxe 1", "/give torch 8", "/give oak_fence 8", "/give stone_hoe 1", "/give wheat_seeds 12", "/give water_bucket 1", "/give chest 1"])
  b.send({ t: "chat", text: g });
await b.wait(30);
const at = () => `${b.phys.x.toFixed(1)} ${b.phys.y.toFixed(1)} ${b.phys.z.toFixed(1)}`;
console.log("start at", at(), "blocks", b.buildingBlocks().n);
const cx = Math.floor(b.phys.x);
const cz = Math.floor(b.phys.z);
const cy = Math.floor(b.phys.y + 0.01);
let t0 = Date.now();
console.log("stairs:", await b.stairMine([B.COBBLESTONE], 12), `(${Math.round((Date.now() - t0) / 1000)}s) now at`, at());
const ground = (x: number, z: number) => b.groundAt(x, z, cy);
for (const kind of ["well", "lamp"] as const) {
  const [w, d] = kind === "well" ? [5, 5] : [1, 1];
  const s = b.siteNear(cx, cz, cy, w, d, [], 12, 3);
  if (!s) {
    console.log(kind, "no site");
    continue;
  }
  t0 = Date.now();
  const cells = planFor({ kind, x0: s.x0, z0: s.z0, x1: s.x0 + w - 1, z1: s.z0 + d - 1, y: s.y }, 1, ground);
  const r = await b.buildCells(cells, 90, `building ${kind}`);
  console.log(kind, "at", s.x0, s.y, s.z0, JSON.stringify(r), `(${Math.round((Date.now() - t0) / 1000)}s)`);
}
t0 = Date.now();
console.log("farm:", JSON.stringify(await b.makeFarm(cx, cz, cy, [])), `(${Math.round((Date.now() - t0) / 1000)}s)`);
const spot = b.spotNearby();
if (spot) {
  await b.place(B.CHEST, ...spot);
  console.log("loot:", await b.lootChest(8));
}
console.log("trade:", await b.trade(undefined, 1));
process.exit(0);
