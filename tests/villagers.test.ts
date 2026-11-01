// Villagers on the server (update 11), simulated tick by tick on a generated village: by day they wander and never
// leave their village; in the evening they walk home and their doors open as they come and close behind them; in
// the morning they go out again; a customer stops one and it faces them; a poke is a flinch, nothing more; a house
// broken down or blocked still leaves them somewhere to stand; out of sight they're simply put where they belong.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { B, SOLID } from "../shared/blocks.ts";
import { DEFAULT_SEED, WORLD_HEIGHT, WORLD_SIZE, idx } from "../shared/constants.ts";
import { bodyInsideSolid } from "../shared/physics.ts";
import { door, doorId, isDoor } from "../shared/shapes.ts";
import { VF } from "../shared/villagers.ts";
import { VILLAGE_R } from "../shared/villages.ts";
import { generateWorld } from "../shared/worldgen.ts";
import { VillagerManager, isHomeTime, type Villager } from "../server/src/villagers.ts";

const DAY = 4000;
const NIGHT = 13000;

function world() {
  const { blocks, info } = generateWorld(DEFAULT_SEED, undefined, { villages: [0] });
  const base = blocks.slice();
  const get = (x: number, y: number, z: number) => (x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE || y < 0 || y >= WORLD_HEIGHT ? 0 : blocks[idx(x, y, z)]);
  const m = new VillagerManager(get, mkdtempSync(join(tmpdir(), "steve-craft-villagers-")), info.villages.list);
  let doorOps = 0;
  m.setDoor = (x, y, z, low) => {
    doorOps++;
    blocks[idx(x, y, z)] = low;
    if (isDoor(blocks[idx(x, y + 1, z)])) blocks[idx(x, y + 1, z)] = doorId(door(low).facing, door(low).open, true);
  };
  const v = info.villages.list[0];
  return { blocks, base, get, m, v, doors: () => doorOps };
}

const homeDist = (q: Villager) => Math.hypot(q.x - q.def.home[0] - 0.5, q.z - q.def.home[2] - 0.5);

test("evening: every villager walks home through its door, which opens and closes behind it; morning: out again", () => {
  const w = world();
  w.m.load(DAY);
  const viewer = [{ id: 1, x: w.v.x, y: w.v.y + 1, z: w.v.z }];
  let t = 0;
  for (; t < 300; t++) w.m.tick(viewer, DAY, t);
  for (const q of w.m.villagers.values()) assert.ok(Math.abs(q.x - w.v.x) <= VILLAGE_R + 1 && Math.abs(q.z - w.v.z) <= VILLAGE_R + 1, "in the village by day");
  // the evening
  let home = -1;
  for (; t < 300 + 20 * 60; t++) {
    w.m.tick(viewer, NIGHT, t);
    if (home < 0 && [...w.m.villagers.values()].every((q) => homeDist(q) < 0.9)) home = t;
  }
  assert.ok(home > 0 && home - 300 < 20 * 40, `all home after ${((home - 300) / 20).toFixed(1)} s`);
  for (const q of w.m.villagers.values()) assert.ok(q.flags & VF.HOME, "flagged at home");
  assert.ok(w.doors() >= 10, `doors opened and closed (${w.doors()} changes)`);
  for (const h of w.v.houses) assert.equal(w.blocks[idx(...h.door)], w.base[idx(...h.door)], "every door shut again, as it was");
  // the morning
  for (let k = 0; k < 20 * 40; k++, t++) w.m.tick(viewer, DAY, t);
  const out = [...w.m.villagers.values()].filter((q) => homeDist(q) > 2).length;
  assert.ok(out >= 4, `${out} of 5 out of the house`);
  for (const h of w.v.houses) assert.equal(w.blocks[idx(...h.door)], w.base[idx(...h.door)], "doors shut again behind them");
  assert.ok(isHomeTime(12500) && isHomeTime(18000) && !isHomeTime(23600) && !isHomeTime(6000));
});

test("a whole day: nobody leaves the village, nobody ends up inside a block", () => {
  const w = world();
  w.m.load(DAY);
  const viewer = [{ id: 1, x: w.v.x, y: w.v.y + 1, z: w.v.z }];
  for (let t = 0; t < 20 * 240; t++) {
    w.m.tick(viewer, t < 20 * 160 ? DAY : NIGHT, t);
    if (t % 20 === 0) {
      for (const q of w.m.villagers.values()) {
        assert.ok(Math.abs(q.x - w.v.x) <= VILLAGE_R + 1.5 && Math.abs(q.z - w.v.z) <= VILLAGE_R + 1.5, `${q.def.name} stays in the village`);
        assert.ok(!bodyInsideSolid(w.get, q), `${q.def.name} not inside a block`);
      }
    }
  }
});

test("a customer stops a villager, which faces them; a poke is a flinch (no damage, no health at all)", () => {
  const w = world();
  w.m.load(DAY);
  const q = w.m.villagers.get(w.v.villagers[0].id)!;
  const me = { id: 7, x: q.x + 2, y: q.y, z: q.z };
  w.m.startTalk(q, 7, me.x, me.z);
  for (let t = 0; t < 60; t++) w.m.tick([me], DAY, t);
  assert.ok(q.flags & VF.TALK, "talking");
  assert.ok(Math.hypot(q.vx, q.vz) < 0.01, "standing still");
  const face = (Math.atan2(-(me.x - q.x), me.z - q.z) * 180) / Math.PI;
  assert.ok(Math.abs(((((q.yaw - face) % 360) + 540) % 360) - 180) < 10, "facing the customer");
  w.m.endTalk(q, 7);
  w.m.poke(q, me.x, me.z);
  w.m.tick([me], DAY, 61);
  assert.ok(q.flags & VF.HURT, "it flinches");
  assert.equal((q as unknown as { hp?: number }).hp, undefined, "villagers have no health to lose");
  // someone who left: the villager stops waiting for them
  w.m.startTalk(q, 99, me.x, me.z);
  w.m.tick([me], DAY, 62);
  assert.equal(q.talkers.size, 0);
});

test("a broken house still works: walls gone, they still go home; home filled in, they wait at the door", () => {
  const w = world();
  w.m.load(DAY);
  const viewer = [{ id: 1, x: w.v.x, y: w.v.y + 1, z: w.v.z }];
  // house 0: every wall and the door broken down (a player wrecked it)
  const h0 = w.v.houses[0];
  for (let dx = -5; dx <= 5; dx++)
    for (let dz = -5; dz <= 5; dz++)
      for (let dy = 0; dy <= 3; dy++) {
        const x = h0.door[0] + dx;
        const y = h0.door[1] + dy;
        const z = h0.door[2] + dz;
        const id = w.blocks[idx(x, y, z)];
        if (isDoor(id) || id === B.TERRACOTTA + 1 || id === B.OAK_LOG || id === B.GLASS_PANE) w.blocks[idx(x, y, z)] = 0;
      }
  // house 1: someone filled the villager's home spot with stone
  const h1 = w.v.houses[1];
  w.blocks[idx(h1.inside[0], h1.inside[1], h1.inside[2])] = B.STONE;
  w.blocks[idx(h1.inside[0], h1.inside[1] + 1, h1.inside[2])] = B.STONE;
  for (let t = 0; t < 20 * 90; t++) w.m.tick(viewer, NIGHT, t);
  const q0 = w.m.villagers.get(w.v.villagers[0].id)!;
  const q1 = w.m.villagers.get(w.v.villagers[1].id)!;
  assert.ok(homeDist(q0) < 1, `the wrecked house's villager went home anyway (${homeDist(q0).toFixed(1)})`);
  const atDoor = Math.hypot(q1.x - q1.def.work[0] - 0.5, q1.z - q1.def.work[2] - 0.5);
  assert.ok(atDoor < 2.5, `the blocked one waits by its door (${atDoor.toFixed(1)} away)`);
  for (const q of w.m.villagers.values()) assert.ok(!bodyInsideSolid(w.get, q), "nobody inside a block");
  void SOLID;
});

test("out of sight, a villager in the wrong place for the time of day is put where it belongs", () => {
  const w = world();
  w.m.load(DAY);
  const far = [{ id: 1, x: 10, y: 60, z: 10 }];
  w.m.tick(far, NIGHT, 1);
  for (const q of w.m.villagers.values()) assert.ok(homeDist(q) < 1, `${q.def.name} at home for the night`);
  w.m.tick(far, DAY, 2);
  for (const q of w.m.villagers.values()) assert.ok(homeDist(q) > 1.5, `${q.def.name} out for the day`);
});
