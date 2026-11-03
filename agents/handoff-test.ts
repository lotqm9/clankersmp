// clankersmp: a gatherer and a builder it can't reach, on a throwaway test server (DEV_COMMANDS=1) with no model.
// Before there is a storehouse a gatherer brings the builder its haul; with the builder down in the rock (a cave
// under the town, the way opus mined at y=25 on season 14 while sonnet walked at it over and over, "couldn't get to
// opus") it must not walk there at all: it keeps the haul (and says why), give says why at once, with the builder
// back up beside it the haul is handed over as before, and when it carries enough for the storehouse it builds that
// instead and puts the haul in it.
//   AGENT_SECRET=... AT=x,z node agents/handoff-test.ts [ws://127.0.0.1:8819]
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Body } from "./body.ts";
import { materialsFor } from "./civ.ts";
import { rawOf } from "./board.ts";
import { B, BLOCKS, SOLID } from "../shared/blocks.ts";

const url = process.argv[2] || "ws://127.0.0.1:8819";
const [ax, az] = (process.env.AT || "380,120").split(",").map(Number);
const names = ["opus", "sonnet"];
const bodies = names.map((n) => new Body(n));
await Promise.all(bodies.map((b) => b.connect(url, process.env.AGENT_SECRET ?? "")));
const [opus, sonnet] = bodies;
const cmd = (b: Body, t: string) => b.send({ t: "chat", text: t });
// (up high to look the ground over: in creative, so the fall down doesn't kill)
for (const b of bodies) {
  cmd(b, "/gamemode creative");
  cmd(b, `/tp ${ax + 0.5} 100 ${az + 0.5}`);
}
await sonnet.wait(80);
const top = (x: number, z: number) => {
  let y = 120;
  while (y > 2 && (!SOLID[sonnet.get(x, y, z)] || /leaves|log/.test(BLOCKS[sonnet.get(x, y, z)]?.key ?? ""))) y--;
  return y;
};
const gy = top(ax, az);
const ROCK = new Set<number>([B.STONE, B.DIRT, B.GRASS, B.GRAVEL]);
// a cave under the ground near the spot: two cells of air on a floor, rock over them all the way up
let cave: [number, number, number] | null = null;
for (let r = 0; r <= 40 && !cave; r += 2)
  for (let dx = -r; dx <= r && !cave; dx += 2)
    for (let dz = -r; dz <= r && !cave; dz += 2) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      const x = ax + dx;
      const z = az + dz;
      const s = top(x, z);
      for (let y = s - 6; y > 12; y--) {
        if (sonnet.get(x, y, z) !== B.AIR || sonnet.get(x, y + 1, z) !== B.AIR || !SOLID[sonnet.get(x, y - 1, z)]) continue;
        let rock = 0;
        for (let yy = y + 2; yy <= s; yy++) if (ROCK.has(sonnet.get(x, yy, z))) rock++;
        if (rock >= 4) cave = [x, y, z];
        break;
      }
    }
if (!cave) throw new Error("no cave near the spot");
console.log(`the builder goes down a cave at ${cave.join(",")} (the ground at y=${top(cave[0], cave[2])}); the gatherer stands at ${ax},${gy + 1},${az}`);
for (const b of bodies) cmd(b, "/gamemode survival");
cmd(opus, `/tp ${cave[0] + 0.5} ${cave[1]} ${cave[2] + 0.5}`);
cmd(sonnet, `/tp ${ax + 0.5} ${gy + 1} ${az + 0.5}`);
cmd(sonnet, "/time 2000");
await sonnet.wait(40);

const dir = mkdtempSync(join(tmpdir(), "clanker-handoff-"));
const board = { day: 1, at: Date.now(), roles: { opus: "builder", sonnet: "mason" }, project: null, short: {} };
writeFileSync(join(dir, "pack.json"), JSON.stringify({ plan: "", by: "", base: { x: ax, y: gy + 1, z: az }, houses: {}, builds: [], trades: 0, stage: -1, board }));
process.env.AGENT_STATE_DIR = dir;
const { Brain } = await import("./brain.ts");
type T = { load(): void; exec(n: string, i: Record<string, unknown>): Promise<string>; toBuilder(): Promise<string> };
const brains = names.map((n, i) => new Brain(n, bodies[i], "test", "http://127.0.0.1:9", "http://127.0.0.1:9") as unknown as T);
for (const br of brains) br.load();
const sb = brains[1];
const results: string[] = [];
const check = (what: string, ok: boolean) => {
  results.push(`${ok ? "PASS" : "FAIL"} ${what}`);
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
};
const at = () => [sonnet.phys.x, sonnet.phys.z] as const;
const moved = (p: readonly [number, number]) => Math.hypot(sonnet.phys.x - p[0], sonnet.phys.z - p[1]);

// a small haul: not enough for a storehouse
cmd(sonnet, "/give cobblestone 20");
cmd(sonnet, "/give oak_log 6");
await sonnet.wait(30);
let p = at();
let t0 = Date.now();
let r = await sb.toBuilder();
let secs = (Date.now() - t0) / 1000;
console.log(`toBuilder (builder in the cave): ${r}`);
check(`with the builder down in the rock it doesn't walk there (${secs.toFixed(1)} s, moved ${moved(p).toFixed(1)})`, secs < 5 && moved(p) < 3);
check("it keeps the haul and says why", /down in the rock/.test(r) && /kept/.test(r) && sonnet.count(B.COBBLESTONE) >= 20);
t0 = Date.now();
r = await sb.exec("give", { player: "opus", item: "cobblestone", count: 5 });
console.log(`give opus 5 cobblestone: ${r}`);
check(`give says why at once (${((Date.now() - t0) / 1000).toFixed(1)} s)`, Date.now() - t0 < 5000 && /down in the rock/.test(r));

// the builder back up beside it: the haul goes over as before
cmd(opus, `/tp ${ax + 2.5} ${gy + 1} ${az + 0.5}`);
await sonnet.wait(40);
const had = opus.count(B.COBBLESTONE);
r = await sb.toBuilder();
await opus.wait(40);
await opus.pickUp(4, 3000);
console.log(`toBuilder (builder beside it): ${r}`);
check(`with the builder up beside it the haul goes over (opus has ${opus.count(B.COBBLESTONE) - had} more cobblestone)`, /threw/.test(r) && opus.count(B.COBBLESTONE) > had);

// enough on it for a storehouse, the builder down the cave again: the storehouse goes up instead
cmd(opus, `/tp ${cave[0] + 0.5} ${cave[1]} ${cave[2] + 0.5}`);
const raw = rawOf(materialsFor("storehouse", 1));
console.log(`a storehouse takes ${[...raw].map(([k, n]) => `${k} ${n}`).join(", ")}`);
for (const [k, n] of raw) {
  const give = k === "stone" ? "cobblestone" : k === "wood" ? "oak_log" : k === "sand" ? "sand" : k === "coal" ? "coal" : k === "iron" ? "iron_ingot" : "";
  if (give) cmd(sonnet, `/give ${give} ${Math.min(64, n + 4)}`);
  if (give && n + 4 > 64) cmd(sonnet, `/give ${give} ${Math.min(64, n + 4 - 64)}`);
}
cmd(sonnet, "/give stone_pickaxe 1");
cmd(sonnet, "/give stone_axe 1");
await sonnet.wait(40);
p = at();
t0 = Date.now();
r = await sb.toBuilder();
console.log(`[${Math.round((Date.now() - t0) / 1000)}s] toBuilder (enough for a storehouse): ${r.slice(0, 400)}`);
const pack = JSON.parse(readFileSync(join(dir, "pack.json"), "utf8"));
const store = (pack.builds ?? []).find((x: { kind: string }) => x.kind === "storehouse");
check(`it built the storehouse instead (${store ? `at ${store.x0},${store.z0}, ${store.done ? "done" : "not done"}` : "none"})`, !!store?.done && /built the storehouse/.test(r));
check("and the haul went in it", /storehouse holds|put /.test(r));
console.log(`\n${results.join("\n")}`);
process.exit(results.every((x) => x.startsWith("PASS")) ? 0 : 1);
