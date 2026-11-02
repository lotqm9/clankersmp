// clankersmp: a town hall on a throwaway test server (DEV_COMMANDS=1), messed up first with dirt in the walls and
// leaves inside the way the live one was, then built: no dirt or leaves may be left above the foundation.
//   AGENT_SECRET=... node agents/hall-test.ts ws://127.0.0.1:8789
import { Body } from "./body.ts";
import { planFor } from "./civ.ts";
import { B, BLOCKS } from "../shared/blocks.ts";

const b = new Body("opus");
await b.connect(process.argv[2] || "ws://127.0.0.1:8789", process.env.AGENT_SECRET ?? "");
await b.wait(10);
for (const g of ["/give cobblestone 64", "/give cobblestone 64", "/give cobblestone 64", "/give oak_planks 64", "/give dirt 64", "/give oak_leaves 16", "/give stone_pickaxe 1", "/give torch 8", "/time 1000"])
  b.send({ t: "chat", text: g });
await b.wait(30);
const cx = Math.floor(b.phys.x);
const cz = Math.floor(b.phys.z);
const cy = Math.floor(b.phys.y + 0.01);
const s = b.siteNear(cx, cz, cy, 7, 7, [], 34, 3, 3);
if (!s) throw new Error("no site for a hall");
const cells = planFor("hall", s.x0, s.z0, s.y, (x, z) => b.groundAt(x, z, cy));
console.log("hall at", s.x0, s.y, s.z0, "cells", cells.length);

// the mess: dirt in the bottom of the walls, leaves inside and in a window
let messed = 0;
for (const [x, y, z, k] of cells.filter(([, y, , k]) => (k === "s" || k === "w") && y <= s.y + 1).slice(0, 10))
  if (await b.place(B.DIRT, x, y, z, 6000)) messed++;
for (const [x, y, z] of cells.filter(([, y, , k]) => k === "a" && y === s.y).slice(0, 5))
  if (await b.place(B.OAK_LEAVES, x, y, z, 6000)) messed++;
console.log("messed up", messed, "cells");

const t0 = Date.now();
for (let k = 0; k < 6 && cells.some((c) => b.needsWork(c) && c[3] !== "t"); k++) {
  const r = await b.buildCells(cells, 120, "building a town hall");
  console.log("round", k, JSON.stringify(r));
}
const byKind: Record<string, Record<string, number>> = {};
for (const [x, y, z, k] of cells) {
  const key = BLOCKS[b.get(x, y, z)]?.key ?? "?";
  (byKind[k] ??= {})[key] = (byKind[k][key] ?? 0) + 1;
}
console.log(`built in ${Math.round((Date.now() - t0) / 1000)}s`);
for (const [k, m] of Object.entries(byKind)) console.log(" ", k, JSON.stringify(m));
const bad = cells.filter((c) => c[3] !== "d" && c[3] !== "t" && b.needsWork(c));
console.log(bad.length ? `FAIL: ${bad.length} cells still need work` : "PASS: no dirt or leaves above the foundation, nothing missing");
process.exit(bad.length ? 1 : 0);
