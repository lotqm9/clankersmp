// clankersmp: a full inventory makes room (test server, DEV_COMMANDS=1): fill all 36 slots, then tidy.
//   AGENT_SECRET=... node agents/tidy-test.ts ws://127.0.0.1:8789
import { Body } from "./body.ts";

const b = new Body("opus");
await b.connect(process.argv[2] || "ws://127.0.0.1:8789", process.env.AGENT_SECRET ?? "");
await b.wait(10);
const kinds = ["gravel", "sand", "poppy", "wheat_seeds", "cobblestone", "dirt"];
// off somewhere clean first: the other tests left things lying about here
await b.goto(b.phys.x + 30, b.phys.y, b.phys.z + 30, 2, { maxMs: 30000 });
// exactly fill the free slots (no overflow lying at its feet to confuse the count)
const free = b.inv.filter((x) => !x).length;
console.log("free slots at the clean spot", free, "at", b.phys.x.toFixed(1), b.phys.z.toFixed(1));
for (let k = 0; k < free; k++) b.send({ t: "chat", text: `/give ${kinds[k % kinds.length]} 64` });
await b.wait(40);
const used = () => b.inv.filter(Boolean).length;
console.log("slots used before", used());
const x0 = b.phys.x, z0 = b.phys.z;
console.log("threw:", await b.tidyInventory(), "moved", Math.hypot(b.phys.x - x0, b.phys.z - z0).toFixed(1));
await b.wait(10);
await b.wait(60); // past the throw delay: nothing comes back
console.log("slots used after", used(), "dirt", b.count(2), "cobblestone", b.count(4));
process.exit(36 - used() >= 5 ? 0 : 1);
