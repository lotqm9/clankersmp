// clankersmp: badly hurt (7 health, no armour) with a shambler at arm's length: wall it off.
// Test server without HARDCORE, DEV_COMMANDS=1, MOBS=0.
// node agents/walloff-test.ts [ws] [dig|fight] [tunnel]   (dig: the old way, digIn; fight: stand and fight; tunnel: in a dug corridor)
import { Body } from "./body.ts";
const b = new Body(process.env.WHO || "sonnet");
await b.connect(process.argv[2] || "ws://127.0.0.1:8789", process.env.AGENT_SECRET ?? "");
await b.wait(10);
if (b.dead) { b.send({ t: "respawn" }); await b.wait(20); }
if (b.covered()) await b.digOut();
for (const g of ["/give stone_pickaxe 1", "/give stone_sword 1", "/give dirt 32", "/give torch 4", "/time 18000", "/mobs clear"]) b.send({ t: "chat", text: g });
await b.wait(20);
await b.goto(b.phys.x - 20 - Math.random() * 30, b.phys.y, b.phys.z + 14 + Math.random() * 30, 2, { maxMs: 15000 });
if (process.argv.includes("tunnel")) {
  // a one-wide corridor four blocks down, five long, roofed: a mine
  const x = Math.floor(b.phys.x), z = Math.floor(b.phys.z), y = Math.floor(b.phys.y + 0.1);
  for (let k = 1; k <= 4; k++) { await b.mine(x, y - k, z, false); await b.wait(8); }
  const yy = Math.floor(b.phys.y + 0.1);
  for (let dz = 1; dz <= 5; dz++) for (const dy of [0, 1]) await b.mine(x, yy + dy, z + dz, false);
  await b.wait(10);
  b.look(x + 0.5, yy + 1, z + 5.5);
  await b.wait(5);
}
b.send({ t: "chat", text: "/mobs freeze" });
b.send({ t: "chat", text: "/summon shambler 1 2" });
await b.wait(10);
b.send({ t: "chat", text: `/hurt ${Math.round(b.stats.hp - Number(process.env.HP || 7))}` });
if (process.env.FOOD) b.send({ t: "chat", text: `/hunger ${process.env.FOOD}` });
await b.wait(6);
b.send({ t: "chat", text: "/mobs freeze" });
console.log("shambler at", b.hostiles(8)[0]?.d.toFixed(1), "hp", b.stats.hp, "gaps", b.openGaps());
const t1 = Date.now();
const T = () => ((Date.now() - t1) / 1000).toFixed(1);
for (const f of ["flee", "sealIn", "digIn", "lightUp", "place"] as const) {
  const o = (b as any)[f].bind(b);
  (b as any)[f] = async (...a: any[]) => { const m = b.hostiles(8)[0]; console.log(` ${T()} ${f}(${a.slice(0, 4).join(",")}) hp ${b.stats.hp} mob ${m ? m.d.toFixed(1) : "-"} gaps ${b.openGaps()}`); const r = await o(...a); if (f !== "place" || !r) console.log(` ${T()}   ${f} -> ${r}`); return r; };
}
const hps: string[] = [];
const iv = setInterval(() => hps.push(`${((Date.now() - t1) / 1000).toFixed(1)}:${b.stats.hp}`), 500);
const res = process.argv.includes("dig") ? await b.digIn() : process.argv.includes("fight") ? await b.fight({ kind: "mob", id: b.hostiles(8)[0].id }, 15000) : await b.wallOff();
console.log(res, `(${((Date.now() - t1) / 1000).toFixed(1)}s)`, "sealed", b.sealed(), "hp", b.stats.hp, "dead", b.dead);
await b.wait(100);
clearInterval(iv);
console.log("5 s later: hp", b.stats.hp, "dead", b.dead, "sealed", b.sealed(), "| hp over time", hps.join(" "));
b.send({ t: "chat", text: "/mobs clear" });
await b.wait(5);
process.exit(0);
