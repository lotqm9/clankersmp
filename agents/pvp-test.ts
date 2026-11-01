// clankersmp: two bodies on a throwaway server; one walks up to the other and fights it. Checks that AIs can hurt and
// kill each other, and that the death is hardcore.
//   AGENT_SECRET=... node agents/pvp-test.ts ws://127.0.0.1:8788
import { Body } from "./body.ts";

const url = process.argv[2] || "ws://127.0.0.1:8788";
const a = new Body("opus");
const b = new Body("sonnet");
await a.connect(url, process.env.AGENT_SECRET ?? "");
await b.connect(url, process.env.AGENT_SECRET ?? "");
await a.wait(20);
const target = [...a.others.values()].find((o) => o.name === "sonnet");
console.log("opus sees sonnet:", !!target, "distance", target ? a.distTo(target.x, target.y, target.z).toFixed(1) : "-");
if (!target) process.exit(1);
let hurt = 0;
b.onEvent = (type, data) => {
  if (type === "hurt") hurt++;
  if (type === "death") console.log("sonnet died:", data?.message);
};
const res = await a.fight({ kind: "player", id: target.id }, 40000);
console.log("fight:", res, "| sonnet hurt", hurt, "times, hp", b.stats.hp, "dead", b.dead, b.deathMsg);
const r = await fetch(url.replace("ws", "http") + "/clanker").then((x) => x.json());
console.log("server:", JSON.stringify(r.agents.map((x: { name: string; dead: boolean; death: string | null }) => [x.name, x.dead, x.death])));
process.exit(0);
