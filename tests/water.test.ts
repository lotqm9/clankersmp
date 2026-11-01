// Flowing water rules, run through the real server scheduler (server/src/water.ts) on small synthetic terrain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { B } from "../shared/blocks.ts";
import { idx } from "../shared/constants.ts";
import { flowAt, flowId, isWater, levelOf, surfaceHeight } from "../shared/water.ts";
import { WaterSim } from "../server/src/water.ts";

const dir = mkdtempSync(join(tmpdir(), "steve-craft-water-"));
const G = 40; // ground: stone up to y = 40, air above

/** A tiny world: flat stone to y = 40 plus whatever the test sets. Runs the scheduler like a shard does. */
class World {
  cells = new Map<number, number>();
  tick = 0;
  sim: WaterSim;
  constructor() {
    this.sim = new WaterSim((x, y, z) => this.get(x, y, z), (i, id) => this.cells.set(i, id), dir);
  }
  get(x: number, y: number, z: number): number {
    return this.cells.get(idx(x, y, z)) ?? (y <= G ? B.STONE : B.AIR);
  }
  /** A player/admin change: set and wake the water around it. */
  set(x: number, y: number, z: number, id: number): void {
    this.cells.set(idx(x, y, z), id);
    this.sim.touched(idx(x, y, z), this.tick);
  }
  run(ticks: number): void {
    for (let k = 0; k < ticks; k++) this.sim.tick(++this.tick);
  }
  /** Runs until nothing is pending (or a limit). */
  settle(limit = 4000): number {
    let k = 0;
    while (this.sim.pending > 0 && k < limit) {
      this.sim.tick(++this.tick);
      k++;
    }
    return k;
  }
}

test("a source on flat ground spreads 7 blocks, one level thinner each step", () => {
  const w = new World();
  w.set(100, G + 1, 100, B.WATER);
  w.settle();
  for (let d = 1; d <= 7; d++) {
    assert.equal(w.get(100 + d, G + 1, 100), flowId(d), `east ${d}`);
    assert.equal(w.get(100, G + 1, 100 - d), flowId(d), `north ${d}`);
  }
  assert.equal(w.get(108, G + 1, 100), B.AIR, "nothing past level 7");
  assert.equal(w.get(103, G + 1, 103), flowId(6), "a diamond: 3 + 3 steps away is level 6");
  assert.equal(w.get(104, G + 1, 104), B.AIR, "8 steps away is dry");
});

test("water falls off a ledge as a falling column and spreads again at the bottom", () => {
  const w = new World();
  // a 1x1 pillar of stone 6 high with a source on top
  for (let y = G + 1; y <= G + 6; y++) w.cells.set(idx(50, y, 50), B.STONE);
  w.set(50, G + 7, 50, B.WATER);
  w.settle();
  assert.equal(w.get(51, G + 7, 50), flowId(1), "flows onto the edge");
  for (let y = G + 1; y <= G + 6; y++) assert.ok(isWater(w.get(51, y, 50)), `falls past y ${y}`);
  assert.equal(w.get(51, G + 4, 50), B.WATER_FALL);
  assert.equal(w.get(52, G + 1, 50), flowId(1), "lands and spreads from full strength");
  assert.equal(w.get(51, G + 1, 57), flowId(7));
});

test("spreading prefers the way to the nearest drop (streams pour off ledges, not diamonds)", () => {
  const w = new World();
  // a raised platform y = 41 from x 10..30, z 10..30; a hole (drop) at x = 23
  for (let x = 10; x <= 30; x++) for (let z = 10; z <= 30; z++) w.cells.set(idx(x, G + 1, z), B.STONE);
  w.cells.set(idx(23, G + 1, 20), B.AIR);
  w.set(20, G + 2, 20, B.WATER);
  w.settle();
  assert.equal(w.get(21, G + 2, 20), flowId(1), "toward the hole");
  assert.equal(w.get(22, G + 2, 20), flowId(2));
  assert.equal(w.get(19, G + 2, 20), B.AIR, "not away from it");
  assert.equal(w.get(20, G + 2, 21), B.AIR, "not sideways either");
  assert.ok(isWater(w.get(23, G + 1, 20)), "pours into the hole");
});

test("cut the source and the flow drains away", () => {
  const w = new World();
  w.set(200, G + 1, 200, B.WATER);
  w.settle();
  assert.equal(w.get(203, G + 1, 200), flowId(3));
  w.set(200, G + 1, 200, B.STONE);
  w.settle();
  for (let d = 1; d <= 7; d++) assert.equal(w.get(200 + d, G + 1, 200), B.AIR, `dry at ${d}`);
});

test("two sources side by side over solid ground make a new source (a dug pool fills for good)", () => {
  const w = new World();
  // a 3 x 1 trench in the ground at y = 40
  for (let x = 300; x <= 302; x++) w.cells.set(idx(x, G, 300), B.AIR);
  w.set(300, G, 300, B.WATER);
  w.set(302, G, 300, B.WATER);
  w.settle();
  assert.equal(w.get(301, G, 300), B.WATER, "the middle became a source");
  w.set(301, G, 300, B.AIR); // scoop out the middle: its two source neighbours refill it as a source
  w.settle();
  assert.equal(w.get(301, G, 300), B.WATER, "refilled");
  w.set(300, G, 300, B.AIR); // an end has only one source next to it: it refills as flowing water
  w.settle();
  assert.equal(w.get(300, G, 300), flowId(1));
});

test("breaking a lake's wall lets it pour out; plants and torches are washed away", () => {
  const w = new World();
  // a 5 x 5 lake of sources in a basin (y 38..40), walled; outside the wall the ground is at y = 40
  for (let x = 400; x < 405; x++) for (let z = 400; z < 405; z++) for (let y = G - 2; y <= G; y++) w.cells.set(idx(x, y, z), B.WATER);
  // a channel cut into the ground beyond the wall, with grass and a torch in it
  w.cells.set(idx(406, G, 402), B.TALL_GRASS);
  w.cells.set(idx(407, G, 402), B.TORCH);
  w.settle();
  assert.equal(w.get(405, G, 402), B.STONE, "wall still there");
  w.set(405, G, 402, B.AIR); // break the wall
  w.settle();
  assert.ok(isWater(w.get(405, G, 402)), "flows through the gap");
  assert.ok(isWater(w.get(406, G, 402)), "grass washed away");
  assert.ok(isWater(w.get(407, G, 402)), "torch washed away");
  assert.equal(w.get(406, G, 402), flowId(2));
});

test("never off the edge of the world, and a big flood stays within the per-tick budget", () => {
  const w = new World();
  w.set(0, G + 1, 0, B.WATER);
  w.settle();
  assert.equal(w.get(1, G + 1, 0), flowId(1));
  const before = w.sim.evaluated;
  // 400 sources at once
  for (let x = 0; x < 20; x++) for (let z = 0; z < 20; z++) w.set(100 + x * 9, G + 1, 300 + z * 9, B.WATER);
  w.run(1);
  assert.ok(w.sim.evaluated - before <= 2500 + 50, "budget respected in one tick");
  w.settle(10000);
  assert.equal(w.sim.pending, 0, "everything settles");
});

test("levels, surface heights and the current", () => {
  assert.equal(levelOf(B.WATER), 0);
  assert.equal(levelOf(B.WATER_FALL), 0);
  assert.equal(levelOf(flowId(5)), 5);
  assert.equal(levelOf(B.STONE), -1);
  assert.ok(surfaceHeight(flowId(1), B.AIR) > surfaceHeight(flowId(7), B.AIR));
  assert.equal(surfaceHeight(flowId(7), B.WATER), 1, "full under water");
  const w = new World();
  w.set(250, G + 1, 250, B.WATER);
  w.settle();
  const [fx, fz] = flowAt((x, y, z) => w.get(x, y, z), 253.5, G + 1.3, 250.5);
  assert.ok(fx > 0.01 && Math.abs(fz) < 0.005, `pushes away from the source (${fx.toFixed(4)}, ${fz.toFixed(4)})`);
  rmSync(dir, { recursive: true, force: true });
});
