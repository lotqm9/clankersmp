// clankersmp: the town's pooled supplies on a throwaway test server (DEV_COMMANDS=1): a chest put down, stacks put in
// (all the cobblestone, half the logs), read back, taken out again, the way a player's client does it (right click,
// shift-click, close).
//   AGENT_SECRET=... node agents/chest-test.ts [ws://127.0.0.1:8813]
import { Body } from "./body.ts";
import { B, BLOCKS } from "../shared/blocks.ts";
import { itemDef } from "../shared/items.ts";

const b = new Body(process.env.BODY || "haiku");
await b.connect(process.argv[2] || "ws://127.0.0.1:8813", process.env.AGENT_SECRET ?? "");
await b.wait(10);
const [ax, az] = (process.env.AT || "300,300").split(",").map(Number);
let gy = 120;
while (gy > 2 && !BLOCKS[b.get(ax, gy, az)]?.solid) gy--;
b.send({ t: "chat", text: `/tp ${ax + 0.5} ${gy + 1} ${az + 0.5}` });
b.send({ t: "chat", text: "/gamemode survival" });
await b.wait(30);
for (let k = 0; k < 36; k++) {
  const st = b.inv[k];
  if (!st || !(await b.hold(st.id))) continue;
  b.send({ t: "drop", all: true });
  await b.wait(2);
}
b.send({ t: "chat", text: `/tp ${ax + 0.5} ${gy + 1} ${az + 6.5}` });
await b.wait(20);
for (const g of ["/give chest 1", "/give cobblestone 100", "/give oak_log 40", "/give torch 5"]) b.send({ t: "chat", text: g });
await b.wait(20);
const name = (m: Map<number, number> | null) => (m ? [...m].map(([id, n]) => `${itemDef(id)?.key ?? id} ${n}`).join(", ") || "nothing" : "couldn't open");
const spot = b.spotNearby();
if (!spot || !(await b.place(B.CHEST, ...spot))) {
  console.log("FAIL: couldn't put the chest down");
  process.exit(1);
}
const [cx, cy, cz] = spot;
console.log("chest at", cx, cy, cz, "carrying cobblestone", b.count(B.COBBLESTONE), "logs", b.count(B.OAK_LOG));
const put = await b.chestPut(cx, cy, cz, (id, have) => (id === B.COBBLESTONE ? have : id === B.OAK_LOG ? Math.floor(have / 2) : 0));
console.log("put:", name(put?.put ?? null), "| now carrying cobblestone", b.count(B.COBBLESTONE), "logs", b.count(B.OAK_LOG), "torches", b.count(B.TORCH));
const inside = await b.chestContents(cx, cy, cz);
console.log("in the chest:", name(inside));
const took = await b.chestTake(cx, cy, cz, new Map([[B.COBBLESTONE, 40]]));
console.log("took:", name(took?.got ?? null), "| now carrying cobblestone", b.count(B.COBBLESTONE));
const after = await b.chestContents(cx, cy, cz);
console.log("left in the chest:", name(after));
const ok = (put?.put.get(B.COBBLESTONE) ?? 0) === 100 && b.count(B.TORCH) === 5 && (took?.got.get(B.COBBLESTONE) ?? 0) >= 40 && (took?.inside.get(B.COBBLESTONE) ?? -1) === (after?.get(B.COBBLESTONE) ?? -2) && (after?.get(B.COBBLESTONE) ?? 0) + b.count(B.COBBLESTONE) === 100;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
