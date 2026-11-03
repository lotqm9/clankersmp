// clankersmp: a town on the town plan, built through the real build job, on a throwaway test server (DEV_COMMANDS=1)
// with no model. Three brains share one pack; each takes the next building off the list and calls build, the way an
// AI does, with what the plan still needs handed over by /give before each call (so it builds rather than spends an
// hour mining). The sites come from the plan (the plaza on its square, every other building on a lot facing its
// street), then the roads and the lamp posts, then a picture from above (SHOTS=1, tools/cam.cjs).
//   AGENT_SECRET=... AT=x,z KINDS=plaza,well,house,... SHOTS=1 node agents/plan-shot-test.ts [ws://127.0.0.1:8814]
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Body } from "./body.ts";
import { BLOCKS } from "../shared/blocks.ts";
import { itemDef } from "../shared/items.ts";

const url = process.argv[2] || "ws://127.0.0.1:8814";
const [ax, az] = (process.env.AT || "128,228").split(",").map(Number);
const queue = (process.env.KINDS || "plaza,well,storehouse,house,hall,market,house,tavern,smithy,bakery,house,library,house").split(",");
const lamps = Number(process.env.LAMPS ?? 4);
const names = (process.env.BODIES || "opus,sonnet,haiku").split(",");
const OUT = process.env.OUT || fileURLToPath(new URL("../.local/shots/planner", import.meta.url));
const bodies = names.map((n) => new Body(n));
await Promise.all(bodies.map((b) => b.connect(url, process.env.AGENT_SECRET ?? "")));
const b0 = bodies[0];
await b0.wait(10);
let gy = 120;
while (gy > 2 && !BLOCKS[b0.get(ax, gy, az)]?.solid) gy--;
const cmd = (b: Body, t: string) => b.send({ t: "chat", text: t });
for (const [i, b] of bodies.entries()) {
  cmd(b, "/gamemode survival");
  cmd(b, `/tp ${ax + 0.5 + i * 2} ${gy + 1} ${az + 0.5}`);
  for (const t of ["diamond_pickaxe", "diamond_axe", "diamond_shovel"]) cmd(b, `/give ${t} 1`);
}
cmd(b0, "/time 2000");
await b0.wait(40);
const dir = mkdtempSync(join(tmpdir(), "clanker-plan-"));
writeFileSync(join(dir, "pack.json"), JSON.stringify({ plan: "", by: "", base: { x: ax, y: gy + 1, z: az }, houses: {}, builds: [], trades: 0, stage: -1 }));
process.env.AGENT_STATE_DIR = dir;
const { Brain } = await import("./brain.ts");
type T = { load(): void; exec(n: string, i: Record<string, unknown>): Promise<string>; beat(): void; projectBill(p: { kind: string; up: boolean }): Map<number, number> };
const brains = names.map((n, i) => new Brain(n, bodies[i], "test", "http://127.0.0.1:9", "http://127.0.0.1:9") as unknown as T);
for (const br of brains) br.load();
const t0 = Date.now();
const results: string[] = [];

// what the plan still needs, handed over (and some dirt for the scaffolding); a bag kept from overflowing
async function topUp(b: Body, br: T, kind: string): Promise<void> {
  const bill = br.projectBill({ kind, up: false });
  for (let k = 0; k < 36 && b.inv.filter((s) => !s).length < 8; k++) {
    const st = b.inv[k];
    if (!st || bill.has(st.id) || itemDef(st.id)?.tool || st.id === 2 /* dirt */) continue;
    if (!(await b.hold(st.id))) continue;
    b.send({ t: "drop", all: true });
    await b.wait(2);
  }
  for (const [id, n] of bill) {
    const want = n + 2 - b.count(id);
    const k = itemDef(id)?.key;
    if (want > 0 && k && k !== "water_bucket") cmd(b, `/give ${k} ${want}`);
  }
  if (b.count(2) < 24) cmd(b, `/give dirt ${32 - b.count(2)}`);
  if (kind === "lamp") cmd(b, "/give torch 4");
  await b.wait(20);
}

let next = 0;
await Promise.all(brains.map(async (br, i) => {
  const b = bodies[i];
  while (next < queue.length) {
    const kind = queue[next++];
    let last = "";
    for (let k = 0; k < 6; k++) {
      cmd(b, "/time 2000");
      cmd(b, "/hunger 20");
      await topUp(b, br, kind);
      last = await br.exec("build", { what: kind });
      console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${names[i]} build ${kind}: ${last}`);
      if (/^finished|^there is no|no flat|already|all the|is working on/.test(last)) break;
    }
    // another one is on a building of this kind right now: it goes back on the list for later
    if (/is working on/.test(last)) {
      queue.push(kind);
      await b.wait(100);
      continue;
    }
    results.push(`${names[i]} ${kind}: ${/^finished/.test(last) ? "PASS" : `FAIL ${last.slice(0, 120)}`}`);
  }
}));
// the streets and the paths to every door
for (let k = 0; k < 6; k++) {
  cmd(b0, "/time 2000");
  cmd(b0, "/give dirt 64");
  const r = await brains[0].exec("build", { what: "road" });
  console.log(`[${Math.round((Date.now() - t0) / 1000)}s] opus build road: ${r}`);
  if (/^finished|no paths/.test(r)) {
    results.push(`opus road: ${/^finished/.test(r) ? "PASS" : `FAIL ${r.slice(0, 120)}`}`);
    break;
  }
}
// lamp posts along the streets
for (let k = 0; k < lamps; k++) {
  cmd(b0, "/time 2000");
  cmd(b0, "/give torch 4");
  cmd(b0, "/give cobblestone 4");
  cmd(b0, "/give oak_log 4");
  await b0.wait(10);
  const r = await brains[0].exec("build", { what: "lamp" });
  console.log(`[${Math.round((Date.now() - t0) / 1000)}s] opus build lamp: ${r}`);
  results.push(`opus lamp: ${/^finished/.test(r) ? "PASS" : `FAIL ${r.slice(0, 120)}`}`);
}
const pack = JSON.parse(readFileSync(join(dir, "pack.json"), "utf8"));
console.log(`\nthe centre: ${JSON.stringify(pack.centre)}`);
for (const x of pack.builds) console.log(`  ${x.kind} at ${x.x0},${x.z0}..${x.x1},${x.z1} facing ${x.face ?? 0}, ${x.done ? "done" : "not done"}`);
if (process.env.SHOTS === "1" && pack.centre) {
  // the town from above, the plaza in the middle; the body that follows stands on the plaza
  const c = pack.centre;
  cmd(b0, `/tp ${c.x + 0.5} ${gy + 2} ${c.z + 0.5}`);
  await b0.wait(40);
  const y = gy + 1;
  const spec = join(OUT, "town-plan.json");
  writeFileSync(spec, JSON.stringify([
    { out: join(OUT, "town-plan-above.png"), eye: [c.x + 0.5, y + 70, c.z + 24], look: [c.x + 0.5, y, c.z + 2], fov: 70 },
    { out: join(OUT, "town-plan.png"), eye: [c.x - 34, y + 30, c.z + 38], look: [c.x + 2, y + 2, c.z - 2], fov: 70 },
    { out: join(OUT, "town-plan-street.png"), eye: [c.x + 0.5, y + 4, c.z + 30], look: [c.x + 0.5, y + 2, c.z - 10], fov: 75 },
  ]));
  await new Promise<void>((res) => execFile("node", [fileURLToPath(new URL("../tools/cam.cjs", import.meta.url)), spec], { env: { ...process.env, FOLLOW: names[0], SERVER: url }, timeout: 240000 }, (e, out) => {
    console.log(e ? `shot failed: ${e.message}` : out.trim());
    res();
  }));
}
console.log(`\n${results.join("\n")}\n(${Math.round((Date.now() - t0) / 1000)}s)`);
process.exit(results.every((r) => r.includes("PASS")) ? 0 : 1);
