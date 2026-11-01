// Animal unit tests on a synthetic world: caps, falling and landing, cliffs, water, being hit, the sync messages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { B } from "../shared/blocks.ts";
import { AF, ANIMAL, OP_ANIMALS, OP_ANIMALS_GONE, decodeAnimals, decodeGone, encodeAnimals, rayHitsBox } from "../shared/animals.ts";
import { AnimalManager, REGION, REGION_CAP, SHARD_CAP } from "../server/src/animals.ts";

// Grass plateau at y = 40 (feet at 41). East of x = 300 the ground drops to y = 33 (a 7-block cliff).
// A pond: water from y = 37 to 40 for 230 <= x, z < 240.
const pond = (x: number, z: number) => x >= 230 && x < 240 && z >= 230 && z < 240;
function get(x: number, y: number, z: number): number {
  const top = x >= 300 ? 33 : pond(x, z) ? 36 : 40;
  if (y < top) return B.STONE;
  if (y === top) return pond(x, z) ? B.SAND : B.GRASS;
  if (pond(x, z) && y <= 40) return B.WATER;
  return B.AIR;
}

const dir = mkdtempSync(join(tmpdir(), "steve-craft-animals-"));
const viewer = (x: number, z: number) => [{ x, y: 41, z }];
const run = (m: AnimalManager, ticks: number, at = viewer(256, 256)) => {
  for (let t = 0; t < ticks; t++) m.tick(at);
};

test("populate fills the island in herds, within the per-area and per-shard caps", () => {
  const m = new AnimalManager(get, dir);
  m.populate(1000);
  assert.ok(m.animals.size > 40 && m.animals.size <= SHARD_CAP, `size ${m.animals.size}`);
  const per = new Map<string, number>();
  for (const a of m.animals.values()) {
    const k = `${Math.floor(a.x / REGION)},${Math.floor(a.z / REGION)}`;
    per.set(k, (per.get(k) ?? 0) + 1);
    assert.equal(a.y, a.x >= 300 ? 34 : 41, "standing on the grass of its column");
    assert.ok(!pond(Math.floor(a.x), Math.floor(a.z)), "never spawned in the pond");
  }
  for (const [k, n] of per) assert.ok(n <= REGION_CAP, `region ${k} has ${n}`);
  rmSync(join(dir, "animals.json"), { force: true });
});

test("an animal in the air falls and comes to rest on the ground", () => {
  const m = new AnimalManager(get, dir);
  const a = m.summon(ANIMAL.COW, 200.5, 50, 200.5)!;
  a.y = 50; // summon snaps to the ground; lift it to test falling
  run(m, 60, viewer(200, 200));
  assert.equal(a.y, 41);
  assert.ok(a.onGround);
  assert.ok(a.flags & AF.GROUND);
});

test("chickens fall slowly (they flap)", () => {
  const m = new AnimalManager(get, dir);
  const c = m.summon(ANIMAL.CHICKEN, 210.5, 41, 210.5)!;
  const p = m.summon(ANIMAL.PIG, 214.5, 41, 214.5)!;
  c.y = p.y = 60;
  run(m, 20, viewer(210, 210));
  assert.ok(c.y > p.y + 3, `chicken ${c.y.toFixed(2)} vs pig ${p.y.toFixed(2)}`);
});

test("calm animals do not walk off a 7-block cliff", () => {
  const m = new AnimalManager(get, dir);
  const list = [];
  for (let k = 0; k < 16; k++) list.push(m.summon(k % 4, 296.5 + (k % 3), 41, 150.5 + k * 3)!);
  run(m, 20 * 120, viewer(296, 170)); // two minutes of wandering
  const fell = list.filter((a) => a.y < 40);
  assert.equal(fell.length, 0, `${fell.length} fell: ${fell.map((a) => a.x.toFixed(1)).join(",")}`);
  const moved = list.filter((a) => Math.abs(a.x - 297) > 1.5 || Math.abs(a.z - 150) > 1.5).length;
  assert.ok(moved >= 8, `they do wander (${moved} moved)`);
});

test("an animal that falls into water floats up and swims", () => {
  const m = new AnimalManager(get, dir);
  const a = m.summon(ANIMAL.SHEEP, 235.5, 37, 235.5)!;
  a.y = 37.2;
  run(m, 80, viewer(235, 235));
  assert.ok(a.y > 38.6, `floats up (y ${a.y.toFixed(2)})`);
});

test("a hit knocks the animal back, flashes it, and it runs away from the player", () => {
  const m = new AnimalManager(get, dir);
  const a = m.summon(ANIMAL.PIG, 150.5, 41, 150.5)!;
  run(m, 5, viewer(150, 150));
  m.hit(a, 148.5, 150.5);
  run(m, 1, viewer(150, 150));
  assert.ok(a.flags & AF.HURT && a.flags & AF.PANIC);
  run(m, 50, viewer(150, 150));
  assert.ok(a.x - 148.5 > 4, `ran ${(a.x - 148.5).toFixed(1)} blocks away`);
  run(m, 200, viewer(150, 150));
  assert.ok(!(a.flags & AF.PANIC), "calms down again");
});

test("no blocks inside an animal; sleeping far from players", () => {
  const m = new AnimalManager(get, dir);
  const a = m.summon(ANIMAL.COW, 100.5, 41, 100.5)!;
  assert.ok(m.blocksCell(100, 41, 100));
  assert.ok(m.blocksCell(100, 42, 100), "a cow is 1.4 tall");
  assert.ok(!m.blocksCell(102, 41, 100));
  a.y = 60;
  run(m, 40, viewer(400, 400)); // 300+ blocks away: asleep, it does not even fall
  assert.equal(a.y, 60);
});

test("sync: changed animals in range, then 'gone' when the player leaves; the wire format round-trips", () => {
  const m = new AnimalManager(get, dir);
  const a = m.summon(ANIMAL.SHEEP, 120.5, 41, 120.5)!;
  const seen = new Map<number, number>();
  run(m, 2, viewer(120, 120));
  const first = m.messages({ x: 125, y: 41, z: 120 }, seen, 2);
  assert.equal(first.length, 1);
  assert.equal(first[0][0], OP_ANIMALS);
  const snap = decodeAnimals(new DataView(first[0].buffer)).list.find((s) => s.id === a.id)!;
  assert.ok(Math.abs(snap.x - a.x) < 0.01 && Math.abs(snap.y - a.y) < 0.01 && snap.kind === ANIMAL.SHEEP);
  assert.equal(m.messages({ x: 125, y: 41, z: 120 }, seen, 4).length, 0, "nothing changed, nothing sent");
  const gone = m.messages({ x: 125 + 200, y: 41, z: 120 }, seen, 6);
  assert.equal(gone.length, 1);
  assert.equal(gone[0][0], OP_ANIMALS_GONE);
  assert.deepEqual(decodeGone(new DataView(gone[0].buffer)), [a.id]);
  const rt = decodeAnimals(new DataView(encodeAnimals(77, [{ id: 513, kind: 3, x: 511.25, y: 100.5, z: 0.5, yaw: 270, flags: 9 }]).buffer));
  assert.deepEqual(rt, { tick: 77, list: [{ id: 513, kind: 3, x: 511.25, y: 100.5, z: 0.5, yaw: 270, flags: 9 }] });
});

test("ray against an animal box (cross-hair targeting)", () => {
  assert.ok(Math.abs(rayHitsBox(0, 1, 0, 1, 0, 0, 5, 3, 0.5, 0, 0.9, 0.9) - 2.55) < 1e-9);
  assert.equal(rayHitsBox(0, 1, 0, -1, 0, 0, 5, 3, 0.5, 0, 0.9, 0.9), -1);
  assert.equal(rayHitsBox(0, 3, 0, 1, 0, 0, 5, 3, 0.5, 0, 0.9, 0.9), -1, "over its back");
  rmSync(dir, { recursive: true, force: true });
});
