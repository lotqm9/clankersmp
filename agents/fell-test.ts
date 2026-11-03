// clankersmp: trees come down whole, on a throwaway test server (DEV_COMMANDS=1) with no model. One AI with an axe
// and nothing else collects logs in a wood the way it does for the town (collect oak_log). Every tree it touched has
// to be gone to the last log (the high ones from a pillar up the trunk, built of planks from its own logs, and the AI
// back on the ground after), with a sapling on each stump; then, once the leaves have had their minute, no leaf of
// those trees may be left hanging in the air (the engine's leaf decay, server/src/leaves.ts).
//   AGENT_SECRET=... AT=x,z COUNT=14 [ITEM=birch_log] [TALL=1: start beside the tallest tree] SHOTS=1 \n//     node agents/fell-test.ts [ws://127.0.0.1:8818]
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Body } from "./body.ts";
import { B, BLOCKS } from "../shared/blocks.ts";

const url = process.argv[2] || "ws://127.0.0.1:8818";
const [ax, az] = (process.env.AT || "376,92").split(",").map(Number);
const count = Number(process.env.COUNT || 14);
const OUT = process.env.OUT || fileURLToPath(new URL("../.local/shots-fell", import.meta.url));
const LOGS = new Set<number>([B.OAK_LOG, B.BIRCH_LOG, B.PALM_LOG]);
const LEAVES = new Set<number>([B.OAK_LEAVES, B.BIRCH_LEAVES, B.PALM_LEAVES]);
const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
type C = [number, number, number];
const key = (c: C) => c.join(",");

const b = new Body("opus");
await b.connect(url, process.env.AGENT_SECRET ?? "");
await b.wait(10);
const cmd = (t: string) => b.send({ t: "chat", text: t });
cmd("/gamemode creative");
cmd(`/tp ${ax + 0.5} 100 ${az + 0.5}`);
await b.wait(80);
const groundAt = (x: number, z: number) => {
  let y = 120;
  while (y > 2 && (!BLOCKS[b.get(x, y, z)]?.solid || LOGS.has(b.get(x, y, z)) || LEAVES.has(b.get(x, y, z)))) y--;
  return y;
};
// the trees round the spot, each with its canopy (every leaf within 6 of its logs, through leaves)
const R = 30;
const feet: C[] = [];
for (let x = ax - R; x <= ax + R; x++)
  for (let z = az - R; z <= az + R; z++) {
    const g = groundAt(x, z);
    if (LOGS.has(b.get(x, g + 1, z))) feet.push([x, g + 1, z]);
  }
const trunk = (f: C): C[] => {
  const out: C[] = [];
  for (let y = f[1]; LOGS.has(b.get(f[0], y, f[2])); y++) out.push([f[0], y, f[2]]);
  return out;
};
const canopy = (logs: C[]): C[] => {
  const seen = new Set<string>();
  const out: C[] = [];
  let front = logs;
  for (let d = 1; d <= 6; d++) {
    const next: C[] = [];
    for (const c of front)
      for (const [dx, dy, dz] of N6) {
        const n: C = [c[0] + dx, c[1] + dy, c[2] + dz];
        if (!LEAVES.has(b.get(...n)) || seen.has(key(n))) continue;
        seen.add(key(n));
        out.push(n);
        next.push(n);
      }
    front = next;
  }
  return out;
};
/** A leaf with a log at most 6 from it through leaves (the engine's rule). */
const held = (c: C): boolean => {
  const seen = new Set<string>([key(c)]);
  let front: C[] = [c];
  for (let d = 1; d <= 6; d++) {
    const next: C[] = [];
    for (const f of front)
      for (const [dx, dy, dz] of N6) {
        const n: C = [f[0] + dx, f[1] + dy, f[2] + dz];
        const id = b.get(...n);
        if (LOGS.has(id)) return true;
        if (!LEAVES.has(id) || seen.has(key(n))) continue;
        seen.add(key(n));
        next.push(n);
      }
    front = next;
  }
  return false;
};
const trees = feet.map((f) => ({ foot: f, logs: trunk(f), leaves: [] as C[] }));
for (const t of trees) t.leaves = canopy(t.logs);
console.log(`${trees.length} trees within ${R} of ${ax},${az}: ${trees.filter((t) => b.get(...t.foot) === B.BIRCH_LOG).length} birch, tallest ${Math.max(...trees.map((t) => t.logs.length))} logs`);

// in survival with an axe and nothing to build a pillar of (it makes planks from its own logs); TALL=1: beside the
// tallest tree round the spot, so the first one it cuts needs the pillar
const tallest = [...trees].sort((p, q) => q.logs.length - p.logs.length)[0];
const [sx, sz] = process.env.TALL === "1" && tallest ? [tallest.foot[0] + 1, tallest.foot[2]] : [ax, az];
const gy = groundAt(sx, sz);
if (process.env.TALL === "1") console.log(`starting beside the tallest: ${tallest.logs.length} logs at ${tallest.foot.join(",")}`);
cmd("/gamemode survival");
cmd(`/tp ${sx + 0.5} ${gy + 1} ${sz + 0.5}`);
cmd("/time 2000");
await b.wait(40);
for (let k = 0; k < 36; k++) {
  const st = b.inv[k];
  if (!st || !(await b.hold(st.id))) continue;
  b.send({ t: "drop", all: true });
  await b.wait(2);
}
cmd(`/tp ${sx + 0.5} ${gy + 1} ${sz + 14.5}`);
await b.wait(20);
cmd(`/tp ${sx + 0.5} ${gy + 1} ${sz + 0.5}`);
cmd("/give stone_axe 1");
cmd("/give bread 4");
await b.wait(30);

const shots = async (tag: string) => {
  if (process.env.SHOTS !== "1") return;
  const spec = join(OUT, `fell-${tag}.json`);
  writeFileSync(spec, JSON.stringify([{ out: join(OUT, `fell-${tag}.png`), eye: [sx - 14, gy + 15, sz + 15], look: [sx, gy + 3, sz], fov: 70 }]));
  await new Promise<void>((res) => execFile("node", [fileURLToPath(new URL("../tools/cam.cjs", import.meta.url)), spec], { env: { ...process.env, FOLLOW: "opus", SERVER: url }, timeout: 240000 }, (e, out) => {
    console.log(e ? `shot failed: ${e.message}` : out.trim());
    res();
  }));
};
if (process.env.SHOTS === "1") (await import("node:fs")).mkdirSync(OUT, { recursive: true });
await shots("before");

const dir = mkdtempSync(join(tmpdir(), "clanker-fell-"));
writeFileSync(join(dir, "pack.json"), JSON.stringify({ plan: "", by: "", base: { x: ax + 60, y: gy + 1, z: az + 60 }, houses: {}, builds: [], trades: 0, stage: -1 }));
process.env.AGENT_STATE_DIR = dir;
const { Brain } = await import("./brain.ts");
const br = new Brain("opus", b, "test", "http://127.0.0.1:9", "http://127.0.0.1:9") as unknown as { load(): void; beat(): void; exec(n: string, i: Record<string, unknown>): Promise<string>; log: string[] };
br.load();
const beater = setInterval(() => br.beat(), 1000);
const results: string[] = [];
const check = (what: string, ok: boolean) => {
  results.push(`${ok ? "PASS" : "FAIL"} ${what}`);
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
};
const t0 = Date.now();
const item = process.env.ITEM || "oak_log";
const r = await br.exec("collect", { item, count });
const secs = Math.round((Date.now() - t0) / 1000);
console.log(`[${secs}s] collect ${item} ${count}: ${r}`);
const logs = b.count(B.OAK_LOG) + b.count(B.BIRCH_LOG) + b.count(B.PALM_LOG);
const touched = trees.filter((t) => t.logs.some((c) => !LOGS.has(b.get(...c))));
const standing = touched.flatMap((t) => t.logs.filter((c) => LOGS.has(b.get(...c))));
const tall = touched.filter((t) => t.logs.length >= 6);
console.log(`cut into ${touched.length} trees (${touched.reduce((n, t) => n + t.logs.length, 0)} logs, ${tall.length} of them 6 or more high); carrying ${logs} logs`);
for (const t of touched) console.log(`  ${b.get(...t.foot) === B.AIR || b.get(...t.foot) === B.OAK_SAPLING || b.get(...t.foot) === B.BIRCH_SAPLING ? "" : "!"}tree at ${t.foot.join(",")}: ${t.logs.length} logs, ${t.logs.filter((c) => LOGS.has(b.get(...c))).length} left; on the stump: ${BLOCKS[b.get(...t.foot)]?.key ?? "?"}`);
check(`it got its ${count} logs (${logs})`, logs >= count);
check(`every tree it cut into is down to the last log (${touched.length} trees, ${standing.length} logs left standing on them${standing.length ? `: ${standing.slice(0, 4).map((c) => c.join(",")).join(" ")}` : ""})`, touched.length > 0 && standing.length === 0);
// (TALL=1 starts it beside the tallest, so the first tree's top is out of reach from the ground)
if (process.env.TALL === "1") check(`a tall one among them (the top from a pillar: ${tall.length} of 6+ logs)`, tall.length > 0);
const fx = Math.floor(b.phys.x);
const fz = Math.floor(b.phys.z);
check(`it is back on the ground (feet at y=${b.phys.y.toFixed(1)}, ground ${groundAt(fx, fz) + 1})`, Math.abs(b.phys.y - (groundAt(fx, fz) + 1)) < 1.2);
const planted = touched.filter((t) => ([B.OAK_SAPLING, B.BIRCH_SAPLING] as number[]).includes(b.get(...t.foot))).length;
check(`saplings on the stumps (${planted} of ${touched.length})`, planted > 0);
// the leaves: the server's minute, and a bit
const window = Number(process.env.LEAF_WAIT || 75);
console.log(`waiting ${window}s for the canopies to go`);
const counts: number[] = [];
for (let s = 0; s < window; s += 5) {
  await new Promise((res) => setTimeout(res, 5000));
  counts.push(touched.reduce((n, t) => n + t.leaves.filter((c) => LEAVES.has(b.get(...c))).length, 0));
}
const hanging = touched.flatMap((t) => t.leaves.filter((c) => LEAVES.has(b.get(...c)) && !held(c)));
const kept = touched.flatMap((t) => t.leaves.filter((c) => LEAVES.has(b.get(...c)) && held(c)));
console.log(`the cut trees' leaves every 5 s: ${counts.join(" ")} (of ${touched.reduce((n, t) => n + t.leaves.length, 0)}); ${kept.length} still held by a standing tree's trunk`);
check(`no leaf of the cut trees left hanging (${hanging.length}${hanging.length ? `: ${hanging.slice(0, 4).map((c) => c.join(",")).join(" ")}` : ""})`, hanging.length === 0);
clearInterval(beater);
await shots("after");
console.log(`\n${results.join("\n")}\n(${Math.round((Date.now() - t0) / 1000)}s)`);
process.exit(results.every((x) => x.startsWith("PASS")) ? 0 : 1);
