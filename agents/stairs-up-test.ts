// clankersmp: tunnel down to a block 6 deep, then walk back up the same stairs (test server, DEV_COMMANDS=1).
import { Body } from "./body.ts";
const b = new Body("opus");
await b.connect(process.argv[2] || "ws://127.0.0.1:8789", process.env.AGENT_SECRET ?? "");
await b.wait(10);
for (const g of ["/give stone_pickaxe 1", "/give dirt 16"]) b.send({ t: "chat", text: g });
await b.wait(20);
await b.goto(b.phys.x - 20, b.phys.y, b.phys.z + 14, 2, { maxMs: 15000 });
const sx = b.phys.x, sy = b.phys.y, sz = b.phys.z;
const tx = Math.floor(sx) + 7, ty = Math.floor(sy) - 6, tz = Math.floor(sz);
console.log("start", sx.toFixed(1), sy.toFixed(1), sz.toFixed(1), "target", tx, ty, tz);
const ok = await b.tunnelTo(tx, ty, tz);
console.log("tunnel", ok, "now", b.phys.x.toFixed(1), b.phys.y.toFixed(1), b.phys.z.toFixed(1));
const back = await b.goto(sx, sy, sz, 1.2, { maxMs: 30000 });
console.log("back up", back, "now", b.phys.x.toFixed(1), b.phys.y.toFixed(1), b.phys.z.toFixed(1), "climbed", (b.phys.y - (sy - 6)).toFixed(1));
process.exit(0);
