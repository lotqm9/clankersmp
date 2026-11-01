// clankersmp debug: why a dig under the feet / a place next to the body is refused.
import { Body } from "./body.ts";
import { B, BLOCKS } from "../shared/blocks.ts";

const b = new Body(process.argv[3] || "opus");
await b.connect(process.argv[2] || "ws://127.0.0.1:8787", process.env.AGENT_SECRET ?? "");
b.ws.on("message", (d: Buffer, bin: boolean) => {
  if (!bin) {
    const s = d.toString();
    if (!/"t":"(time|stats)"/.test(s)) console.log("json", s.slice(0, 160));
  } else if (d[0] === 17) console.log("blocks msg", d.length);
});
await b.wait(10);
const x = Math.floor(b.phys.x), y = Math.floor(b.phys.y + 0.01), z = Math.floor(b.phys.z);
console.log("at", b.phys.x.toFixed(2), b.phys.y.toFixed(2), b.phys.z.toFixed(2), "under", BLOCKS[b.get(x, y - 1, z)]?.key, "reach", b.reachTo(x, y - 1, z).toFixed(2), "held", b.heldId());
const ok = await b.mine(x, y - 1, z, false);
console.log("mine under:", ok, "now", BLOCKS[b.get(x, y - 1, z)]?.key, "y", b.phys.y.toFixed(2), "events", b.events);
const spot = b.spotNearby();
console.log("spot", spot, "has table", b.has(B.CRAFTING_TABLE));
b.close();
process.exit(0);
