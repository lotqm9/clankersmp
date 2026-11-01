// clankersmp: drop a body into a deep cave on a throwaway test server (DEV_COMMANDS=1) and see if dig_out gets it to
// the sky. Prints its height as it climbs.
//   AGENT_SECRET=... BODY_DEBUG=1 node agents/climb-test.ts ws://127.0.0.1:8789
import { Body } from "./body.ts";
import { SOLID } from "../shared/blocks.ts";

const b = new Body("opus");
await b.connect(process.argv[2] || "ws://127.0.0.1:8789", process.env.AGENT_SECRET ?? "");
await b.wait(10);
// a cave floor deep down, near where it stands: floor below, two cells of air, rock somewhere above
let spot: [number, number, number] | null = null;
const cx = Math.floor(b.phys.x);
const cz = Math.floor(b.phys.z);
search: for (let r = 0; r < 60; r += 2)
  for (let dz = -r; dz <= r; dz += 2)
    for (let dx = -r; dx <= r; dx += 2)
      for (let y = 4; y < 12; y++) {
        const x = cx + dx;
        const z = cz + dz;
        if (SOLID[b.get(x, y - 1, z)] && !SOLID[b.get(x, y, z)] && !SOLID[b.get(x, y + 1, z)] && b.get(x, y, z) === 0 && SOLID[b.get(x, y + 3, z)]) {
          spot = [x, y, z];
          break search;
        }
      }
if (!spot) {
  console.log("no cave found");
  process.exit(1);
}
console.log("teleporting to cave at", spot.join(" "));
b.send({ t: "chat", text: "/give stone_pickaxe" });
b.send({ t: "chat", text: "/give cobblestone 16" });
b.send({ t: "chat", text: `/tp ${spot[0] + 0.5} ${spot[1]} ${spot[2] + 0.5}` });
await b.wait(30);
console.log("at", b.phys.x.toFixed(1), b.phys.y.toFixed(1), b.phys.z.toFixed(1), "surfaced", b.surfaced());
const timer = setInterval(() => console.log("  y", b.phys.y.toFixed(1)), 5000);
const t0 = Date.now();
console.log("dig_out:", await b.digOut(), `(${Math.round((Date.now() - t0) / 1000)}s)`);
clearInterval(timer);
console.log("final y", b.phys.y.toFixed(1), "surfaced", b.surfaced());
process.exit(0);
