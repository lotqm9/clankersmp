// Animals climbing and finding their way (the "pigs can't jump over blocks" hotfix): the jump clears a full block,
// every kind walks up a staircase of one-block steps, walks around a wall through its gap, gives up on a spot it
// can't reach instead of jumping at the wall, stays inside a fenced pen, gets out of a pond, and never gets stuck
// on rough terrain. Synthetic worlds; the real AI and physics.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { B } from "../shared/blocks.ts";
import { ANIMAL, SPECS } from "../shared/animals.ts";
import { AnimalManager, type Animal } from "../server/src/animals.ts";
import { PathFinder } from "../server/src/pathfind.ts";
import { bodyInsideSolid, type GetBlock } from "../shared/physics.ts";

const dir = mkdtempSync(join(tmpdir(), "steve-craft-climb-"));
const KINDS = [ANIMAL.PIG, ANIMAL.COW, ANIMAL.SHEEP, ANIMAL.CHICKEN];

/** A world from a height function (top solid block per column) plus extra blocks. */
function world(top: (x: number, z: number) => number, extra: (x: number, y: number, z: number) => number = () => -1): GetBlock {
  return (x, y, z) => {
    const e = extra(x, y, z);
    if (e >= 0) return e;
    const t = top(x, z);
    if (y < t) return B.STONE;
    if (y === t) return B.GRASS;
    return B.AIR;
  };
}

function manager(get: GetBlock): AnimalManager {
  const m = new AnimalManager(get, dir);
  m.animals.clear();
  return m;
}

/** Run until done() or the tick limit; counts the jumps. */
function run(m: AnimalManager, ticks: number, at: { x: number; z: number }, done: () => boolean = () => false): { ticks: number; jumps: number } {
  let jumps = 0;
  const mm = m as unknown as { jump: (a: Animal) => void };
  const orig = mm.jump.bind(m);
  mm.jump = (a: Animal) => {
    jumps++;
    orig(a);
  };
  let t = 0;
  for (; t < ticks && !done(); t++) m.tick([{ x: at.x, y: 41, z: at.z }]);
  mm.jump = orig;
  return { ticks: t, jumps };
}

const place = (m: AnimalManager, kind: number, x: number, y: number, z: number): Animal => {
  const a = m.summon(kind, x, y, z);
  assert.ok(a, "summoned");
  a!.state = "idle";
  a!.timer = 100000; // stays put unless told to walk
  return a!;
};

test("the jump clears a full block (Java order: move, then gravity), and lands back", () => {
  const m = manager(world(() => 40));
  const a = place(m, ANIMAL.PIG, 256.5, 41, 256.5);
  run(m, 5, { x: 256, z: 256 });
  (m as unknown as { jump: (a: Animal) => void }).jump(a);
  let peak = a.y;
  run(m, 30, { x: 256, z: 256 }, () => {
    peak = Math.max(peak, a.y);
    return false;
  });
  assert.ok(peak - 41 > 1.2, `peak ${(peak - 41).toFixed(3)} above the ground`);
  assert.equal(a.y, 41);
  assert.ok(a.onGround);
});

// A staircase: three one-block steps going east (feet 41 -> 42 -> 43 -> 44).
const stairs = world((x) => (x < 260 ? 40 : x < 264 ? 41 : x < 268 ? 42 : 43));

for (const kind of KINDS) {
  test(`a ${SPECS[kind].key} walks up a staircase of one-block steps`, () => {
    const m = manager(stairs);
    const a = place(m, kind, 254.5, 41, 256.5);
    assert.ok(m.walkTo(a, 272.5, 256.5), "a path exists");
    const r = run(m, 900, { x: 260, z: 256 }, () => a.state === "idle");
    assert.equal(a.y, 44, `on the top step (y ${a.y.toFixed(2)}, x ${a.x.toFixed(2)})`);
    assert.ok(Math.abs(a.x - 272.5) < 0.7 && Math.abs(a.z - 256.5) < 0.7, `arrived (${a.x.toFixed(2)}, ${a.z.toFixed(2)})`);
    assert.ok(r.jumps >= 3 && r.jumps <= 6, `${r.jumps} jumps for 3 steps`);
    assert.ok(r.ticks < 800, `took ${r.ticks} ticks`);
  });
}

test("panicking animals climb steps too (hit at the foot of the stairs, it flees up them)", () => {
  // Walls on three sides of the stairs' foot: the only way away from the player is up the steps.
  const get = world(
    (x) => (x < 260 ? 40 : x < 264 ? 41 : x < 268 ? 42 : 43),
    (x, y, z) => (y >= 41 && y <= 46 && x < 262 && (z === 252 || z === 261 || x === 250) ? B.STONE : -1),
  );
  const m = manager(get);
  const a = place(m, ANIMAL.PIG, 257.5, 41, 256.5);
  m.hit(a, 252, 256.5);
  run(m, 100, { x: 256, z: 256 });
  assert.ok(a.y >= 43, `fled up the steps (y ${a.y.toFixed(2)}, x ${a.x.toFixed(2)})`);
});

test("a wall with a gap: it walks around through the gap instead of jumping at the wall", () => {
  // A 2-high wall along x = 262, with a 1-wide gap at z = 266.
  const get = world(() => 40, (x, y, z) => (x === 262 && (y === 41 || y === 42) && z !== 266 ? B.STONE : -1));
  for (const kind of KINDS) {
    const m = manager(get);
    const a = place(m, kind, 255.5, 41, 256.5);
    assert.ok(m.walkTo(a, 268.5, 256.5));
    const r = run(m, 900, { x: 260, z: 256 }, () => a.state === "idle");
    assert.ok(Math.abs(a.x - 268.5) < 0.7 && Math.abs(a.z - 256.5) < 0.7, `${SPECS[kind].key} arrived (${a.x.toFixed(2)}, ${a.z.toFixed(2)})`);
    assert.equal(r.jumps, 0, "no jumping at the wall");
  }
});

test("a spot it can't reach: it goes as close as it can and stands, it doesn't keep jumping at the wall", () => {
  // The goal is inside a closed 2-high box.
  const box = (x: number, z: number) => x >= 264 && x <= 270 && z >= 252 && z <= 260 && (x === 264 || x === 270 || z === 252 || z === 260);
  const get = world(() => 40, (x, y, z) => (box(x, z) && (y === 41 || y === 42) ? B.STONE : -1));
  const m = manager(get);
  const a = place(m, ANIMAL.PIG, 255.5, 41, 256.5);
  m.walkTo(a, 267.5, 256.5);
  const r = run(m, 600, { x: 260, z: 256 }, () => a.state !== "goto");
  assert.ok(r.ticks < 400, `gave up the walk after ${r.ticks} ticks`);
  assert.ok(a.x < 264 && a.x > 261.5, `stopped by the wall (x ${a.x.toFixed(2)})`);
  const later = run(m, 600, { x: 260, z: 256 }); // then it just goes on wandering (flat ground: no jumps)
  assert.ok(r.jumps + later.jumps <= 1, `${r.jumps + later.jumps} jumps`);
});

test("a fenced pen holds every kind (fences are 1.5 tall: no jumping them)", () => {
  const ring = (x: number, z: number) => Math.max(Math.abs(x - 256), Math.abs(z - 256)) === 4;
  const get = world(() => 40, (x, y, z) => (y === 41 && ring(x, z) ? B.OAK_FENCE : -1));
  const m = manager(get);
  const list = KINDS.map((k, i) => place(m, k, 254.5 + i, 41, 256.5));
  for (const a of list) a.timer = 1;
  for (let t = 0; t < 3000; t++) {
    m.tick([{ x: 256, y: 41, z: 256 }]);
    if (t % 400 === 0) for (const a of list) if (a.state === "idle") a.timer = 1; // keep them busy
  }
  for (const a of list) assert.ok(Math.abs(a.x - 256) < 4 && Math.abs(a.z - 256) < 4, `${SPECS[a.kind].key} still in the pen (${a.x.toFixed(2)}, ${a.z.toFixed(2)})`);
});

test("in a pond they swim to the nearest bank and climb out", () => {
  // A pond 8 x 8, water surface level with the grass (y = 40), 2 deep.
  const pond = (x: number, z: number) => x >= 252 && x < 260 && z >= 252 && z < 260;
  const get = world((x, z) => (pond(x, z) ? 38 : 40), (x, y, z) => (pond(x, z) && y >= 39 && y <= 40 ? B.WATER : -1));
  for (const kind of KINDS) {
    const m = manager(get);
    const a = m.summon(kind, 255.5, 40.2, 255.5)!;
    a.y = 39.6;
    a.state = "idle";
    a.timer = 100000;
    run(m, 600, { x: 256, z: 256 }, () => !a.inWater && a.onGround && a.y >= 41);
    assert.ok(!a.inWater && a.y === 41, `${SPECS[kind].key} out on the grass (y ${a.y.toFixed(2)}, in water ${a.inWater})`);
  }
});

test("rough terrain: 24 animals wander for 2.5 minutes, climbing and dropping, and none gets stuck", () => {
  // Rolling hills with one-block steps (and some 2-block cliffs).
  const h = (x: number, z: number) => 40 + Math.floor(4 + 3 * Math.sin(x / 4.7) + 3 * Math.cos(z / 5.3) + 1.2 * Math.sin((x + z) / 3.1));
  const get = world(h);
  const m = manager(get);
  const list: Animal[] = [];
  for (let i = 0; i < 24; i++) {
    const x = 240 + (i % 6) * 6 + 0.5;
    const z = 240 + Math.floor(i / 6) * 6 + 0.5;
    const a = m.summon(KINDS[i % 4], x, 60, z)!;
    list.push(a);
  }
  const heights = list.map(() => new Set<number>());
  const travel = list.map(() => 0);
  const pressed = list.map(() => 0);
  let worstPress = 0;
  const last = list.map((a) => [a.x, a.z]);
  for (let t = 0; t < 3000; t++) {
    m.tick([{ x: 256, y: 41, z: 256 }]);
    list.forEach((a, i) => {
      heights[i].add(Math.round(a.y));
      travel[i] += Math.hypot(a.x - last[i][0], a.z - last[i][1]);
      last[i] = [a.x, a.z];
      // pushing against something without getting anywhere
      pressed[i] = a.collidedH && a.state !== "idle" ? pressed[i] + 1 : 0;
      worstPress = Math.max(worstPress, pressed[i]);
      assert.ok(!bodyInsideSolid(get, a, 0.1), "never inside a block");
    });
  }
  const climbers = heights.filter((s) => s.size >= 3).length;
  assert.ok(climbers >= 20, `${climbers}/24 visited 3+ heights`);
  assert.ok(travel.every((d) => d > 15), `every animal got around (min ${Math.min(...travel).toFixed(1)} blocks)`);
  assert.ok(worstPress <= 30, `longest push against a block: ${worstPress} ticks`);
});

test("pathfinder: steps up to one block, drops up to 3, no diagonal corner cutting, fences can't be climbed", () => {
  const get = world(
    (x) => (x === 258 ? 41 : x === 259 ? 42 : x === 261 ? 37 : 40),
    (x, y, z) => (x === 263 && y === 41 ? B.OAK_FENCE : -1),
  );
  const pf = new PathFinder(get);
  const s = pf.search(256.5, 41, 256.5, { hw: 0.45, h: 0.9, maxNodes: 2000, radius: 12, water: false })!;
  const at = (x: number, z: number) => s.pts.filter((p) => p.x === x && p.z === z).map((p) => p.f);
  assert.deepEqual(at(258, 256), [42], "one block up");
  assert.deepEqual(at(259, 256), [43], "another block up");
  assert.deepEqual(at(260, 256), [41], "back down two");
  assert.deepEqual(at(261, 256), [38], "down three into the dip");
  assert.deepEqual(at(263, 256), [], "not on top of the fence");
  assert.deepEqual(at(264, 256), [], "nor past it");
});
