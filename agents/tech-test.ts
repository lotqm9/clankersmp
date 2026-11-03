// clankersmp: the way to enchanting, end to end, with the agents' own skills (agents/tech.ts) on a test server
// (CLANKER=1 DEV_COMMANDS=1 MOBS=0 SAFE_ZONE=0, never HARDCORE). Obsidian from lava poured onto water and mined with a
// diamond pickaxe; a book; the enchanting table crafted, put up with its bookshelf ring; a sword and a worn
// chestplate enchanted; the smith's lava bucket for sale; and the enchantments doing what they say.
//   AGENT_SECRET=... node agents/tech-test.ts ws://127.0.0.1:8798
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Body } from "./body.ts";
import { collectObsidian, enchant, techText } from "./tech.ts";
import { B } from "../shared/blocks.ts";
import { I, armorId, enchantedId, itemDef, toolId } from "../shared/items.ts";
import { VILLAGE_SITES } from "../shared/villages.ts";

process.env.AGENT_STATE_DIR ||= mkdtempSync(join(tmpdir(), "tech-"));
const URL = process.argv[2] || "ws://127.0.0.1:8798";
const SECRET = process.env.AGENT_SECRET ?? "";
let fails = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) fails++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fresh(name: string): Promise<Body> {
  let b = new Body(name);
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
  b = new Body(name);
  await b.connect(URL, SECRET);
  await b.wait(5);
  return b;
}
const b = await fresh("f8");
const cmd = async (t: string, n = 2) => {
  b.send({ t: "chat", text: t });
  await b.wait(n);
};
await cmd("/time 6000");
await cmd("/mobs clear");
// beside a pond: find water near an arena
await cmd("/tp 243.5 47 381.5", 20);
const pond = b.findBlocks([B.WATER], 40, 1)[0];
console.log("water near:", pond ? pond.join(" ") : "none");
for (const g of ["diamond_pickaxe 1", "lava_bucket 1", "lava_bucket 1", "lava_bucket 1", "lava_bucket 1", "water_bucket 1", "paper 3", "leather 1", "diamond 2", "crafting_table 1", "ruby 30", "iron_sword 1", "iron_chestplate 1", "bookshelf 10", "dirt 16", "oak_planks 8"])
  await cmd(`/give ${g}`, 2);
await b.wait(10);
b.wearBest();
await b.wait(10);
console.log(techText(b));

// obsidian: with no water in reach it makes its own pool from the water bucket
const r1 = await collectObsidian(b, 4);
console.log(" ->", r1);
check(b.count(B.OBSIDIAN) === 4, `4 obsidian from 4 lava buckets (${b.count(B.OBSIDIAN)})`);
check(b.count(I.LAVA_BUCKET) === 0 && b.count(I.BUCKET) >= 4, `the lava buckets came back empty (${b.count(I.BUCKET)} buckets)`);

// the book and the table
const r2 = await b.craft("book", 1);
check(r2.made === 1 && b.has(I.BOOK), `a book from 3 paper and a leather (${r2.why ?? "made"})`);
const r3 = await b.craft("enchanting_table", 1);
check(r3.made === 1 && b.has(B.ENCHANTING_TABLE), `the enchanting table crafted (${r3.why ?? "made"})`);

// enchant: puts the table up, the shelves round it, and enchants the sword at level 3 (10 shelves)
const r4 = await enchant(b, "iron_sword", 0, null, []);
console.log(" ->", r4);
const sword3 = enchantedId(toolId(2, 3), 3);
check(b.has(sword3), `the iron sword is ${itemDef(sword3)?.name}`);
check(b.count(I.RUBY) === 30 - 7, `level 3 cost 7 rubies (${30 - b.count(I.RUBY)})`);
const r5 = await enchant(b, "iron_chestplate", 2, null, []);
console.log(" ->", r5);
const chest2 = enchantedId(armorId(1, 1), 2);
check(b.armor[1]?.id === chest2, `the worn chestplate is ${itemDef(chest2)?.name} (${itemDef(b.armor[1]?.id ?? 0)?.name})`);
console.log(techText(b));

// Sharpness hits harder: a struck message for the first hit on a shambler
await cmd("/time 18000");
await b.hold(sword3);
b.wantYaw = b.yaw = 180;
await b.wait(5);
await cmd("/summon shambler 1 3", 20);
const m = b.hostiles(8)[0];
let dmg = 0;
b.onStruck.add((s) => {
  if (!dmg) dmg = s.dmg;
});
if (m) {
  for (let k = 0; k < 40 && !dmg; k++) {
    const q = b.mobs.get(m.id);
    if (q) b.look(q.x, q.y + 1.2, q.z);
    if (k === 25) {
      b.send({ t: "hit", id: m.id, mob: true });
      b.swing();
    }
    await b.nextTick();
  }
}
check(dmg > 7.5, `a charged hit with Sharpness III does ${dmg} (a plain iron sword: 5.9)`);
await cmd("/mobs clear", 4);

// the smith sells lava: teleport into a village and ask the nearest smith
let smith = false;
for (const k of b.world?.villages ?? []) {
  const v = VILLAGE_SITES[k];
  await cmd(`/tp ${v.x + 0.5} 60 ${v.z + 0.5}`, 30);
  const offers = await b.trade(undefined, 1, 1); // the smith
  if (/lava_bucket/.test(offers)) {
    smith = true;
    console.log(" ->", offers.slice(0, 300));
    break;
  }
}
check(smith, "a smith sells a lava bucket");
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
