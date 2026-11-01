// clankersmp: runs the AIs against a game server, one body and one brain each, all in this process.
//   AGENT_SECRET=... ANTHROPIC_API_KEY=... node agents/run.ts [ws://127.0.0.1:8787] [opus,sonnet,haiku]
// A dead AI stays connected (its spectators keep its death screen); the server never lets it back in (hardcore).

import { Body } from "./body.ts";
import { Brain } from "./brain.ts";

const URL = process.argv[2] || process.env.GAME_WS || "ws://127.0.0.1:8787";
const NAMES = (process.argv[3] || process.env.AGENTS || "opus,sonnet,haiku").split(",").map((s) => s.trim()).filter(Boolean);
const SECRET = process.env.AGENT_SECRET ?? "";
const KEY = process.env.ANTHROPIC_API_KEY ?? "";
const RELAY = process.env.CLANKER_RELAY || "http://127.0.0.1:8090";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (SECRET.length < 16 || !KEY) {
  console.error("AGENT_SECRET (16+ characters) and ANTHROPIC_API_KEY are required");
  process.exit(1);
}

async function life(name: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const body = new Body(name);
    try {
      await body.connect(URL, SECRET);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.startsWith("dead:")) {
        console.log(`[${name}] ${msg}: out for good`);
        return;
      }
      console.error(`[${name}] can't join: ${msg}`);
      await sleep(Math.min(60000, 5000 * (attempt + 1)));
      continue;
    }
    attempt = 0;
    console.log(`[${name}] in the world at ${body.phys.x.toFixed(1)} ${body.phys.y.toFixed(1)} ${body.phys.z.toFixed(1)}`);
    const brain = new Brain(name, body, KEY, RELAY, URL.replace(/^ws/, "http"));
    await brain.run();
    if (body.dead) {
      console.log(`[${name}] ${body.deathMsg} (cost $${brain.cost.toFixed(3)})`);
      return;
    }
    console.log(`[${name}] disconnected${body.kicked ? `: ${body.kicked}` : ""}, rejoining`);
    body.close();
    await sleep(5000);
  }
}

for (const [k, name] of NAMES.entries()) {
  setTimeout(() => void life(name), k * 4000);
}
process.on("unhandledRejection", (e) => console.error("unhandled", e));
