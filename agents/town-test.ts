// clankersmp: every town building at every tier, on a throwaway test server (DEV_COMMANDS=1). Each body takes some
// kinds: it finds a spot, gets the materials the plan needs with /give, builds tier 1 with buildCells, checks every
// cell, then upgrades the same building to tier 2 and tier 3 (mining out what the upgrade replaces), checking each
// time. With SHOTS=1 a picture of each building at each tier is taken through the game client (.local/cam.cjs).
//   AGENT_SECRET=... node agents/town-test.ts [ws://127.0.0.1:8789]
//   KINDS=house,well BODIES=opus AT=288,216 SHOTS=1 node agents/town-test.ts
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { Body } from "./body.ts";
import { KINDS, cellTarget, itemOf, planFor, sizeFacing, wallPlan, type Plain } from "./civ.ts";
import { B, BLOCKS } from "../shared/blocks.ts";
import { I, itemDef } from "../shared/items.ts";

const url = process.argv[2] || "ws://127.0.0.1:8789";
const kinds = (process.env.KINDS || "house,well,lamp,storehouse,market,hall,tower,plaza,keep,wall").split(",") as (Plain | "wall")[];
const names = (process.env.BODIES || "opus,sonnet,haiku").split(",");
const [ax, az] = (process.env.AT || "288,216").split(",").map(Number);
const shots = process.env.SHOTS === "1";
const OUT = process.env.OUT || "C:/Users/vincu/clankersmp-buildings/.local/shots";
mkdirSync(OUT, { recursive: true });
const used: { x0: number; z0: number; x1: number; z1: number }[] = [];
const results: string[] = [];

const tools = ["diamond_pickaxe", "diamond_axe", "diamond_shovel"];
const keepItems = new Set<number>([I.WATER_BUCKET, I.BUCKET, B.DIRT]);

async function tidy(b: Body, need: Map<number, number>): Promise<void> {
  // drop whatever the plan doesn't need (the blocks an upgrade mined out), so /give always has room
  for (let k = 0; k < 36; k++) {
    const st = b.inv[k];
    if (!st || need.has(st.id) || keepItems.has(st.id) || itemDef(st.id)?.tool) continue;
    if (!(await b.hold(st.id))) continue;
    b.send({ t: "drop", all: true });
    await b.wait(2);
  }
}

async function supply(b: Body, cells: [number, number, number, string][]): Promise<void> {
  const need = new Map<number, number>();
  for (const c of cells) {
    const t = cellTarget(c[3]);
    if (!t || !b.needsWork(c)) continue;
    const item = itemOf(t.id);
    need.set(item, (need.get(item) ?? 0) + 1);
  }
  await tidy(b, need);
  for (const [id, n] of need) {
    const want = n + 2 - b.count(id);
    const key = itemDef(id)?.key;
    if (want > 0 && key) b.send({ t: "chat", text: `/give ${key} ${want}` });
  }
  if (b.count(B.DIRT) < 24) b.send({ t: "chat", text: `/give dirt ${32 - b.count(B.DIRT)}` });
  await b.wait(20);
}

async function shot(b: Body, name: string, file: string, s: { kind: string; x0: number; z0: number; x1: number; z1: number; y: number; face?: number }, h: number): Promise<void> {
  if (!shots) return;
  const cx = (s.x0 + s.x1 + 1) / 2;
  const cz = (s.z0 + s.z1 + 1) / 2;
  const w = Math.max(s.x1 - s.x0 + 1, s.z1 - s.z0 + 1);
  const [fx, fz] = [[0, -1], [1, 0], [0, 1], [-1, 0]][s.face ?? 0];
  const dist = Math.max(7, w * 0.85 + 4);
  // three-quarter views from the front and from the back corner, a little above: the front shows the door and the
  // windows, the back the chimney and the back windows; and one in through the door
  const look = [cx, s.y + h * 0.35, cz];
  const at = (front: number, side: number, up: number) => [cx + fx * dist * front - fz * dist * side, s.y + h * 0.55 + dist * up, cz + fz * dist * front + fx * dist * side];
  // a hill or a tree between the camera and the building: up until the view is clear (inside a hill it shot black)
  const clear = (e: number[]) => {
    for (let k = 0; k <= 40; k++) {
      const f = k / 40;
      const [x, y, z] = [e[0] + (look[0] - e[0]) * f, e[1] + (look[1] - e[1]) * f, e[2] + (look[2] - e[2]) * f];
      if (Math.hypot(x - cx, z - cz) < w / 2 + 1) break; // the building itself
      if (BLOCKS[b.get(Math.floor(x), Math.floor(y), Math.floor(z))]?.solid) return false;
    }
    return true;
  };
  const view = (front: number, side: number) => {
    let e = at(front, side, 0.35);
    for (let k = 0; k < 12 && !clear(e); k++) e = [e[0], e[1] + 2, e[2]];
    return e;
  };
  const poses = [
    { out: `${OUT}/${file}.png`, eye: view(1, 0.6), look, fov: 70 },
    { out: `${OUT}/${file}-back.png`, eye: view(-1, -0.6), look, fov: 70 },
  ];
  if (["house", "hall", "storehouse", "keep", "market"].includes(s.kind)) {
    const half = Math.min(s.x1 - s.x0, s.z1 - s.z0) / 2;
    const step = s.kind === "market" ? half + 1 : half - 0.5;
    poses.push({ out: `${OUT}/${file}-inside.png`, eye: [cx + fx * step, s.y + 1.7, cz + fz * step], look: [cx - fx * half, s.y + 0.8, cz - fz * half], fov: 80 });
  }
  const spec = `${OUT}/${file}.json`;
  writeFileSync(spec, JSON.stringify(poses));
  // (not execFileSync: a blocked event loop stops the body's moves and the server drops it)
  await new Promise<void>((res) =>
    execFile("node", ["C:/Users/vincu/clankersmp-buildings/.local/cam.cjs", spec], { env: { ...process.env, FOLLOW: name }, timeout: 150000 }, (e, out) => {
      console.log(e ? `${name} shot failed: ${e.message}` : out.trim());
      res();
    }),
  );
}

function check(b: Body, cells: [number, number, number, string][]): { bad: string[]; req: number } {
  const bad: string[] = [];
  let req = 0;
  for (const c of cells) {
    const t = cellTarget(c[3]);
    if (t?.optional || c[3] === "?p") continue;
    req++;
    if (b.needsWork(c)) bad.push(`${c[0]},${c[1]},${c[2]} wants ${t ? BLOCKS[t.id]?.key + "#" + t.id : c[3]} has ${BLOCKS[b.get(c[0], c[1], c[2])]?.key}`);
  }
  return { bad, req };
}

async function run(name: string, mine: (Plain | "wall")[], cx: number, cz: number): Promise<void> {
  const b = new Body(name);
  await b.connect(url, process.env.AGENT_SECRET ?? "");
  await b.wait(10);
  b.send({ t: "chat", text: "/gamemode survival" });
  b.send({ t: "chat", text: "/time 6000" });
  for (const t of tools) if (!b.inv.some((s) => s && itemDef(s.id)?.key === t)) b.send({ t: "chat", text: `/give ${t} 1` });
  // onto the ground there (a long fall would hurt)
  let gy = 120;
  while (gy > 2 && !BLOCKS[b.get(cx, gy, cz)]?.solid) gy--;
  b.send({ t: "chat", text: `/tp ${cx + 0.5} ${gy + 1} ${cz + 0.5}` });
  await b.wait(60);
  for (const kind of mine) {
    b.send({ t: "chat", text: "/time 6000" });
    b.send({ t: "chat", text: "/hunger 20" });
    const cy = Math.floor(b.phys.y + 0.1);
    const ground = (x: number, z: number) => b.naturalGround(x, z, cy);
    let site: { kind: Plain | "wall"; x0: number; z0: number; x1: number; z1: number; y: number; face: number };
    if (kind === "wall") {
      const s = b.siteNear(cx, cz, cy, 27, 27, used, 60, 0, 8);
      if (!s) {
        results.push(`${name} ${kind}: no site`);
        console.log(`${name} ${kind}: no site`);
        continue;
      }
      site = { kind, x0: s.x0, z0: s.z0, x1: s.x0 + 26, z1: s.z0 + 26, y: s.y, face: 0 };
    } else {
      const face = (mine.indexOf(kind) + names.indexOf(name)) % 4; // turned every way, to test the frames
      const [w, d] = sizeFacing(kind, face);
      const s = b.siteNear(cx, cz, cy, w, d, used, 60, 0, w * d >= 80 ? 3 : 2);
      if (!s) {
        results.push(`${name} ${kind}: no site`);
        console.log(`${name} ${kind}: no site`);
        continue;
      }
      site = { kind, x0: s.x0, z0: s.z0, x1: s.x0 + w - 1, z1: s.z0 + d - 1, y: s.y, face };
    }
    used.push({ x0: site.x0 - 2, z0: site.z0 - 2, x1: site.x1 + 2, z1: site.z1 + 2 });
    const top = kind === "wall" ? KINDS.wall.tiers : KINDS[kind].tiers;
    for (let tier = 1; tier <= top; tier++) {
      const plan = () => (kind === "wall"
        ? wallPlan((site.x0 + site.x1) >> 1, (site.z0 + site.z1) >> 1, 13, (x, z) => b.landAt(x, z, site.y), tier)
        : planFor(site as never, tier, ground)) as [number, number, number, string][];
      let cells = plan();
      const t0 = Date.now();
      let rounds = 0;
      for (; rounds < 16; rounds++) {
        cells = plan();
        if (!check(b, cells).bad.length) break;
        await supply(b, cells);
        const mx = Math.floor((site.x0 + site.x1) / 2);
        const mz = Math.floor((site.z0 + site.z1) / 2);
        if (kind !== "wall" && kind !== "lamp" && kind !== "tower") await b.goto(mx + 0.5, site.y, mz + 0.5, 0.8, { maxMs: 20000 });
        const r = await b.buildCells(cells, 150, `building ${kind} tier ${tier}`, site.y);
        console.log(name, kind, `tier ${tier} round ${rounds}:`, JSON.stringify({ placed: r.placed, left: r.left, outOf: r.outOf, why: r.why, short: [...r.short].map(([id, n]) => `${itemDef(id)?.key} ${n}`) }));
        if (b.dead || b.closed) throw new Error(`${name} ${b.dead ? `died: ${b.deathMsg}` : `was disconnected: ${b.kicked}`}`);
      }
      const { bad, req } = check(b, plan());
      const secs = Math.round((Date.now() - t0) / 1000);
      const line = `${name} ${kind} tier ${tier} at ${site.x0},${site.y},${site.z0} face ${site.face}: ${bad.length ? `FAIL ${bad.length}/${req} cells` : `PASS ${req} cells`} in ${secs}s, ${rounds} rounds`;
      console.log(line);
      if (bad.length) console.log("  ", bad.slice(0, 12).join("\n   "));
      results.push(line);
      // stand off to the front for the picture (the camera follows this body for the blocks round it)
      const [fx, fz] = [[0, -1], [1, 0], [0, 1], [-1, 0]][site.face];
      const mx = Math.floor((site.x0 + site.x1) / 2);
      const mz = Math.floor((site.z0 + site.z1) / 2);
      const off = Math.ceil((kind === "wall" ? 14 : Math.max(site.x1 - site.x0, site.z1 - site.z0) / 2) + 3);
      await b.goto(mx + fx * off + 0.5, site.y, mz + fz * off + 0.5, 2, { maxMs: 20000 });
      await shot(b, name, `${kind}-t${tier}`, site, kind === "keep" || kind === "tower" ? 10 : kind === "hall" ? 10 : kind === "lamp" ? 4 : 7);
    }
  }
  b.close();
}

const per = names.map(() => [] as (Plain | "wall")[]);
kinds.forEach((k, i) => per[i % names.length].push(k));
// each body its own patch of ground (CENTRES=x,z;x,z;...), or a row along x from AT
const centres = process.env.CENTRES ? process.env.CENTRES.split(";").map((c) => c.split(",").map(Number)) : names.map((_, i) => [ax + (i - (names.length - 1) / 2) * 44, az]);
await Promise.all(names.map((n, i) => run(n, per[i], centres[i][0], centres[i][1])));
console.log("\n" + results.join("\n"));
process.exit(results.some((r) => r.includes("FAIL") || r.includes("no site")) ? 1 : 0);
