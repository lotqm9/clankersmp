// Finds showcase spots for flowing water: cliff edges for a waterfall (a drop of 6+ right next to flat ground) and
// level meadows for a spreading pool. Prints JSON for tools/shots.cjs (WATERSPOTS=...).
// Usage: node tools/find-water.ts [seed]
import { B, SOLID } from "../shared/blocks.ts";
import { DEFAULT_SEED, SPAWN_PROTECT_RADIUS, SPAWN_X, SPAWN_Z, WORLD_HEIGHT, WORLD_SIZE, idx } from "../shared/constants.ts";
import { generateWorld } from "../shared/worldgen.ts";

const seed = Number(process.argv[2] ?? DEFAULT_SEED);
const { blocks } = generateWorld(seed);
const W = WORLD_SIZE;
const at = (x: number, y: number, z: number) => blocks[idx(x, y, z)];
const top = (x: number, z: number) => {
  for (let y = WORLD_HEIGHT - 1; y > 0; y--) {
    const id = at(x, y, z);
    if (SOLID[id] && id !== B.OAK_LEAVES && id !== B.BIRCH_LEAVES && id !== B.OAK_LOG && id !== B.BIRCH_LOG) return y;
  }
  return 0;
};
const free = (x: number, y: number, z: number) => {
  const id = at(x, y, z);
  return id === B.AIR || id === B.TALL_GRASS || id === B.DANDELION || id === B.POPPY;
};

const cliffs: { x: number; y: number; z: number; out: [number, number]; drop: number; dist: number }[] = [];
for (let z = 20; z < W - 20; z++)
  for (let x = 20; x < W - 20; x++) {
    const d = Math.hypot(x - SPAWN_X, z - SPAWN_Z);
    if (d < 30 || d > 160) continue;
    const t = top(x, z);
    if (t < 44 || at(x, t, z) !== B.GRASS || !free(x, t + 1, z) || !free(x, t + 2, z)) continue;
    for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
      // flat behind (3 blocks), a sheer drop in front
      if ([1, 2, 3].some((k) => top(x - ox * k, z - oz * k) !== t)) continue;
      const below = top(x + ox, z + oz);
      const drop = t - below;
      if (drop < 6) continue;
      // the fall must be open air all the way down, and the landing flat-ish
      let open = true;
      for (let y = below + 1; y <= t + 1; y++) if (!free(x + ox, y, z + oz)) open = false;
      if (!open) continue;
      if (Math.abs(top(x + ox * 2, z + oz * 2) - below) > 1) continue;
      cliffs.push({ x, y: t + 1, z, out: [ox, oz], drop, dist: Math.round(d) });
    }
  }
cliffs.sort((a, b) => b.drop - a.drop);
const pick: typeof cliffs = [];
for (const c of cliffs) {
  if (pick.some((p) => Math.hypot(p.x - c.x, p.z - c.z) < 25)) continue;
  pick.push(c);
  if (pick.length >= 6) break;
}

// Level meadows (15 x 15) for a pool that spreads in a diamond.
const meadows: { x: number; z: number; y: number }[] = [];
for (let r = 30; r < 200 && meadows.length < 4; r += 2)
  for (let a = 0; a < 90 && meadows.length < 4; a++) {
    const x0 = Math.round(SPAWN_X + Math.cos((a / 90) * Math.PI * 2) * r);
    const z0 = Math.round(SPAWN_Z + Math.sin((a / 90) * Math.PI * 2) * r);
    if (x0 < 10 || z0 < 10 || x0 > W - 26 || z0 > W - 26) continue;
    const y = top(x0, z0);
    let ok = true;
    for (let x = x0; ok && x < x0 + 15; x++)
      for (let z = z0; ok && z < z0 + 15; z++) {
        if (Math.abs(x - SPAWN_X) <= SPAWN_PROTECT_RADIUS + 1 && Math.abs(z - SPAWN_Z) <= SPAWN_PROTECT_RADIUS + 1) ok = false;
        else if (top(x, z) !== y || at(x, y, z) !== B.GRASS || !free(x, y + 1, z) || !free(x, y + 3, z)) ok = false;
      }
    if (ok && !meadows.some((m) => Math.hypot(m.x - x0, m.z - z0) < 30)) meadows.push({ x: x0, z: z0, y });
  }
// Cascades: high ground (y 64+) on a mountain with a step down in front: water tumbles down the terraces.
const cascades: { x: number; y: number; z: number; out: [number, number]; height: number }[] = [];
for (let z = 20; z < W - 20; z++)
  for (let x = 20; x < W - 20; x++) {
    const t = top(x, z);
    if (t < 64 || !free(x, t + 1, z) || !free(x, t + 2, z)) continue;
    for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
      if (top(x - ox, z - oz) !== t || top(x - ox * 2, z - oz * 2) < t) continue;
      if (t - top(x + ox, z + oz) < 3) continue;
      // keep going down the slope for a while
      let y = t;
      let steps = 0;
      for (let k = 1; k <= 12; k++) {
        const ty = top(x + ox * k, z + oz * k);
        if (ty > y) break;
        if (ty < y) steps++;
        y = ty;
      }
      if (steps < 4) continue;
      cascades.push({ x, y: t + 1, z, out: [ox, oz], height: t - y });
    }
  }
cascades.sort((a, b) => b.height - a.height);
const casc: typeof cascades = [];
for (const c of cascades) {
  if (casc.some((p) => Math.hypot(p.x - c.x, p.z - c.z) < 40)) continue;
  casc.push(c);
  if (casc.length >= 5) break;
}
console.log(JSON.stringify({ cliffs: pick, meadows, cascades: casc }));
