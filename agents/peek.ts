// prints the blocks around a point in the live cloud world, as a spectator sees them (generated world + edits)
import WebSocket from "ws";
import { inflateRawSync } from "node:zlib";
import { generateWorld } from "../shared/worldgen.ts";
import { IS_WATER, SOLID } from "../shared/blocks.ts";
import { idx } from "../shared/constants.ts";
import { readBlockEntries } from "../shared/protocol.ts";
const [cx, cy, cz] = process.argv.slice(2).map(Number);
const ws = new WebSocket("wss://engine-production-08c9.up.railway.app/ws");
let blocks: Uint8Array | null = null;
ws.on("open", () => ws.send(JSON.stringify({ t: "hello", g: "stevecraft", v: 12, follow: "opus" })));
ws.on("message", (d: Buffer, bin: boolean) => {
  if (!bin) { const m = JSON.parse(d.toString()); if (m.t === "welcome") blocks = generateWorld(m.seed, undefined, { villages: m.villages ?? [], hub: m.hub }).blocks; return; }
  if (d[0] === 16 && blocks) {
    const flat = readBlockEntries(new Uint8Array(inflateRawSync(d.subarray(5))));
    for (let o = 0; o + 3 < flat.length; o += 4) blocks[idx(flat[o], flat[o + 1], flat[o + 2])] = flat[o + 3];
    for (let y = cy + 3; y >= cy - 3; y--) {
      let s = `y${y} `;
      for (let z = cz - 4; z <= cz + 4; z++) {
        let row = "";
        for (let x = cx - 6; x <= cx + 6; x++) { const id = blocks[idx(x, y, z)]; row += x === cx && z === cz ? "@" : IS_WATER[id] ? "~" : SOLID[id] ? "#" : id ? "," : "."; }
        s += row + " ";
      }
      console.log(s);
    }
    process.exit(0);
  }
});
