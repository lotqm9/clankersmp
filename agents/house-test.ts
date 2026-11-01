// clankersmp: build a house on a throwaway test server (DEV_COMMANDS=1), then go home and shut the door.
//   AGENT_SECRET=... BODY_DEBUG=1 node agents/house-test.ts ws://127.0.0.1:8789 [hold-seconds]
import { Body } from "./body.ts";

const b = new Body("opus");
await b.connect(process.argv[2] || "ws://127.0.0.1:8789", process.env.AGENT_SECRET ?? "");
await b.wait(10);
for (const g of ["/give cobblestone 64", "/give red_bed 1", "/give torch 4", "/give oak_door 1"]) b.send({ t: "chat", text: g });
await b.wait(20);
console.log("blocks", b.buildingBlocks().n, "at", b.phys.x.toFixed(1), b.phys.y.toFixed(1), b.phys.z.toFixed(1));
const t0 = Date.now();
console.log("build:", await b.buildHouse(), `(${Math.round((Date.now() - t0) / 1000)}s)`);
console.log("home:", JSON.stringify(b.home), "atHome", b.atHome());
await b.goto(b.phys.x + 6, b.phys.y, b.phys.z + 6, 1.5, { maxMs: 8000 });
console.log("walked off, atHome", b.atHome());
console.log("go home:", await b.goHome(), "atHome", b.atHome());
const hold = Number(process.argv[3] || 0);
if (hold) await b.wait(hold * 20); // stay so the house can be looked at
process.exit(0);
