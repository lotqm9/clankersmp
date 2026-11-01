// Finds showcase spots in the generated world: big cave chambers with many kinds of ore on their walls, and cave
// entrances on hillsides. Prints JSON for tools/shots.cjs (CAVES=...). Usage: node tools/find-caves.ts [seed]
import { B, SOLID } from "../shared/blocks.ts";
import { DEFAULT_SEED, SPAWN_X, SPAWN_Z, WORLD_HEIGHT, WORLD_SIZE, idx } from "../shared/constants.ts";
import { generateWorld } from "../shared/worldgen.ts";

const seed = Number(process.argv[2] ?? DEFAULT_SEED);
const { blocks } = generateWorld(seed);
const W = WORLD_SIZE;
const at = (x: number, y: number, z: number) => (x < 0 || z < 0 || x >= W || z >= W || y < 0 || y >= WORLD_HEIGHT ? B.STONE : blocks[idx(x, y, z)]);
const ORES = [B.COAL_ORE, B.IRON_ORE, B.GOLD_ORE, B.DIAMOND_ORE, B.RUBY_ORE];
const top = (x: number, z: number) => {
  for (let y = WORLD_HEIGHT - 1; y > 0; y--) if (SOLID[at(x, y, z)]) return y;
  return 0;
};

// Chambers: a floor cell (air with solid below) deep underground, lots of air around, ores visible on the walls.
const chambers: { x: number; y: number; z: number; air: number; kinds: number; ores: number; score: number }[] = [];
for (let z = 8; z < W - 8; z += 3)
  for (let x = 8; x < W - 8; x += 3) {
    if (Math.hypot(x - SPAWN_X, z - SPAWN_Z) < 40) continue;
    const surf = top(x, z);
    for (let y = 8; y < surf - 6; y++) {
      if (at(x, y, z) !== B.AIR || !SOLID[at(x, y - 1, z)] || at(x, y + 1, z) !== B.AIR) continue;
      let air = 0;
      const seen = new Set<number>();
      let ores = 0;
      for (let dy = -2; dy <= 5; dy++)
        for (let dz = -6; dz <= 6; dz++)
          for (let dx = -6; dx <= 6; dx++) {
            const id = at(x + dx, y + dy, z + dz);
            if (id === B.AIR) air++;
            else if (ORES.includes(id)) {
              // only ores that touch air are visible
              const vis = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([a, b, c]) => at(x + dx + a, y + dy + b, z + dz + c) === B.AIR);
              if (vis) {
                ores++;
                seen.add(id);
              }
            }
          }
      if (air < 260) continue;
      chambers.push({ x, y, z, air, kinds: seen.size, ores, score: seen.size * 40 + Math.min(ores, 40) + air / 20 });
      y += 6;
    }
  }
chambers.sort((a, b) => b.score - a.score);
const picked: typeof chambers = [];
for (const c of chambers) {
  if (picked.some((p) => Math.hypot(p.x - c.x, p.z - c.z) < 40)) continue;
  picked.push(c);
  if (picked.length >= 5) break;
}

// Entrances: a carved surface on a slope (neighbours higher on one side), opening sideways into a tunnel.
const entrances: { x: number; y: number; z: number; out: [number, number]; drop: number }[] = [];
for (let z = 10; z < W - 10; z += 2)
  for (let x = 10; x < W - 10; x += 2) {
    if (Math.hypot(x - SPAWN_X, z - SPAWN_Z) < 45) continue;
    const t = top(x, z);
    if (t < 44) continue;
    // a hole: air at the surface level of its higher neighbours, and air going down
    for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
      const back = top(x - ox * 4, z - oz * 4);
      const front = top(x + ox * 4, z + oz * 4);
      if (back - t < 4 || front > t + 1) continue; // hillside: rises behind, open in front
      let tunnel = 0;
      for (let k = 1; k <= 5; k++) if (at(x - ox * k, t + 1, z - oz * k) === B.AIR && at(x - ox * k, t + 2, z - oz * k) === B.AIR && SOLID[at(x - ox * k, t + 4, z - oz * k)]) tunnel++;
      if (tunnel >= 3) entrances.push({ x, y: t + 1, z, out: [ox, oz], drop: back - t });
    }
  }
entrances.sort((a, b) => b.drop - a.drop);
const ent: typeof entrances = [];
for (const e of entrances) {
  if (ent.some((p) => Math.hypot(p.x - e.x, p.z - e.z) < 30)) continue;
  ent.push(e);
  if (ent.length >= 5) break;
}
console.log(JSON.stringify({ chambers: picked, entrances: ent }));
