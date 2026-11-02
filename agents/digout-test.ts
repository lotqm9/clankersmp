// clankersmp: seal in for the night, then climb out in the morning (test server, DEV_COMMANDS=1).
import { Body } from "./body.ts";
const b = new Body("haiku");
await b.connect(process.argv[2] || "ws://127.0.0.1:8789", process.env.AGENT_SECRET ?? "");
await b.wait(10);
for (const g of ["/give stone_pickaxe 1", "/give dirt 16"]) b.send({ t: "chat", text: g });
await b.wait(20);
await b.goto(b.phys.x + 12, b.phys.y, b.phys.z - 18, 2, { maxMs: 15000 });
const y0 = b.phys.y;
console.log("dig in:", await b.digIn(), "sealed", b.sealed(), "y", b.phys.y.toFixed(1));
await b.wait(40);
const t0 = Date.now();
console.log("dig out:", await b.digOut(), `(${Math.round((Date.now() - t0) / 1000)}s)`, "y", b.phys.y.toFixed(1), "start y", y0.toFixed(1), "open", b.outInTheOpen());
process.exit(0);
