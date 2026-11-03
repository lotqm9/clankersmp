// clankersmp v14: an AI's inventory, end to end on a test server (CLANKER=1 DEV_COMMANDS=1, never HARDCORE): a
// scrambled inventory sorted into the fixed hotbar places a move at a time, part stacks merged, a tool taken in hand
// without moving the others; and a spectator following it gets its whole inventory, sees its inventory screen open
// while it sorts, and sees it craft.
//   AGENT_SECRET=... node agents/inventory-test.ts ws://127.0.0.1:8798
import WebSocket from "ws";
import { Body } from "./body.ts";
import { hotbarPlan, messiness, organize } from "./inventory.ts";
import { B } from "../shared/blocks.ts";
import { I, toolId } from "../shared/items.ts";
import { PROTOCOL_NAME, PROTOCOL_VERSION } from "../shared/constants.ts";

const URL = process.argv[2] || "ws://127.0.0.1:8798";
const SECRET = process.env.AGENT_SECRET ?? "";
let fails = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) fails++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let b = new Body("f7");
await b.connect(URL, SECRET);
await b.wait(5);
if (!b.dead) {
  b.send({ t: "chat", text: "/tp 6 70 6" });
  await b.wait(4);
  b.send({ t: "chat", text: "/kill" });
  await b.wait(6);
}
b.close();
await sleep(500);
b = new Body("f7");
await b.connect(URL, SECRET);
await b.wait(5);
const cmd = async (t: string, n = 2) => {
  b.send({ t: "chat", text: t });
  await b.wait(n);
};
await cmd("/tp 258.5 47 69.5", 20);
await cmd("/time 6000");
for (const g of ["dirt 20", "stone_pickaxe 1", "cooked_porkchop 5", "iron_sword 1", "torch 10", "cobblestone 30", "oak_planks 12", "stone_axe 1", "bread 3", "stone_shovel 1"]) await cmd(`/give ${g}`, 2);
await b.wait(10);
// scramble: everything off its place, and a cobblestone stack split in two
const swap = async (a: number, c: number) => {
  b.send({ t: "aswap", a, b: c });
  await b.wait(4);
};
for (const [a, c] of [[0, 20], [1, 30], [2, 7], [3, 25], [4, 12], [5, 33], [6, 0], [8, 18]] as [number, number][]) await swap(a, c);
// a part stack: move some cobblestone over by dropping one and picking it back up would be slow; give a few more
// cobblestone straight into a fresh slot instead (a give fills the first part stack, so give after the stack is full)
await cmd("/give cobblestone 40", 6);
console.log("scrambled:", b.inv.map((s, k) => (s ? `${k}:${s.id}x${s.n}` : "")).filter(Boolean).join(" "));
check(messiness(b) >= 4, `the scrambled inventory is messy (${messiness(b)} moves to tidy)`);

// a spectator following f7
const seen: { open: boolean; bag: boolean; fcraft: string[] } = { open: false, bag: false, fcraft: [] };
const ws = new WebSocket(URL);
await new Promise<void>((res) => ws.on("open", () => res()));
ws.send(JSON.stringify({ t: "hello", g: PROTOCOL_NAME, v: PROTOCOL_VERSION, name: "watcher", follow: "f7" }));
ws.on("message", (data: Buffer, bin: boolean) => {
  if (bin) return;
  const m = JSON.parse(data.toString());
  if (m.t === "fol" && m.name === "f7") {
    if (m.open) seen.open = true;
    if (Array.isArray(m.bag) && m.bag.length === 27) seen.bag = true;
  }
  if (m.t === "fcraft") seen.fcraft.push(`${m.r}x${m.n}`);
});
await sleep(1500);
check(seen.bag, "the watcher gets the AI's whole inventory (the 27 slots past the hotbar)");

const plan = hotbarPlan(b);
const r = await organize(b);
console.log(" ->", r);
await b.wait(10);
const hot = b.inv.slice(0, 9).map((s) => s?.id ?? 0);
check(plan.every((id, k) => !id || hot[k] === id), `the hotbar is in its places: ${hot.join(",")} (planned ${plan.join(",")})`);
check(hot[0] === toolId(2, 3) && hot[1] === toolId(1, 0) && hot[2] === toolId(1, 1) && hot[3] === toolId(1, 2) && hot[5] === B.TORCH, "weapon 1, pickaxe 2, axe 3, shovel 4, torches 6");
check(hot[4] === I.COOKED_PORKCHOP, "the best food in place 5");
check(b.inv.filter((s) => s?.id === B.COBBLESTONE).length === 2 && b.inv.filter((s) => s?.id === B.COBBLESTONE && s.n < 64).length <= 1, "cobblestone in full stacks (70: 64 and 6)");
check(messiness(b) === 0, "nothing left to tidy");
check(seen.open, "the watcher saw its inventory screen open while it sorted");
// something taken in hand from the bag goes to the spare place; the others stay put
await b.hold(I.BREAD);
const after = b.inv.slice(0, 8).map((s) => s?.id ?? 0);
check(b.sel === 8 && b.heldId() === I.BREAD && after.join() === hot.slice(0, 8).join(), "bread taken in hand from the bag goes to place 9, the rest stay where they were");
// a craft shows for the watcher
await b.craft("sticks", 1);
await b.wait(10);
check(seen.fcraft.some((x) => x.startsWith("sticks")), `the watcher saw it craft (${seen.fcraft.join(", ") || "nothing"})`);
ws.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
