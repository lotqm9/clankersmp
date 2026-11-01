// Boat physics (protocol v8, shared by the driver's client and the server) on small synthetic worlds: it floats
// at its waterline (the floor dry above it), rows up to ~8 blocks a second and turns like the classic boat, drifts
// with flowing water, can't climb out of the water or pass a wall, barely scrapes along on land, drops into water
// and settles, never leaves the world; the wire format and the seats.
import { test } from "node:test";
import assert from "node:assert/strict";
import { B } from "../shared/blocks.ts";
import { WORLD_SIZE, idx } from "../shared/constants.ts";
import { BF, BOAT_H, BS, FLOOR_Y, MAX_RIDERS, RIDER_Y, boatWater, decodeBoats, encodeBoats, newBoat, paddles, seatPos, tickBoat } from "../shared/boats.ts";
import { waterSurface } from "../shared/physics.ts";

/** A sea: bedrock at y 0, stone up to y 4, still water y 5..9 (surface at 9 + 8/9); extra blocks from `put`. */
function sea(put: (set: (x: number, y: number, z: number, id: number) => void) => void = () => {}): (x: number, y: number, z: number) => number {
  const extra = new Map<number, number>();
  put((x, y, z, id) => extra.set(idx(x, y, z), id));
  return (x, y, z) => {
    const e = extra.get(idx(x, y, z));
    if (e !== undefined) return e;
    if (y <= 4) return B.STONE;
    if (y <= 9) return B.WATER;
    return B.AIR;
  };
}
const NONE = { forward: false, back: false, left: false, right: false };
const FWD = { ...NONE, forward: true };

test("a boat floats at its waterline (its floor just above the water) and stays put in still water", () => {
  const get = sea();
  const b = newBoat(100.5, 11, 100.5, 0);
  for (let t = 0; t < 120; t++) tickBoat(b, null, get);
  const surface = waterSurface(get, 100, 9, 100);
  assert.equal(b.status, BS.WATER);
  const depth = surface - b.y;
  assert.ok(depth > 0.2 && depth < 0.25, `floats ${depth.toFixed(3)} deep`);
  assert.ok(b.y + FLOOR_Y > surface, "the floor is above the water (no water drawn inside)");
  assert.ok(Math.abs(b.x - 100.5) < 1e-6 && Math.abs(b.z - 100.5) < 1e-6, "no drift in still water");
  const y0 = b.y;
  for (let t = 0; t < 40; t++) tickBoat(b, null, get);
  assert.ok(Math.abs(b.y - y0) < 0.002, "settled");
});

test("rowing: W builds to ~0.4 blocks a tick (8 a second), S backs slowly, A/D turn (and turning alone creeps)", () => {
  const get = sea();
  const b = newBoat(100.5, 9.66, 100.5, 0);
  for (let t = 0; t < 100; t++) tickBoat(b, FWD, get);
  const v = Math.hypot(b.vx, b.vz);
  assert.ok(v > 0.38 && v < 0.42, `top speed ${v.toFixed(3)}`);
  assert.ok(b.z > 130 && Math.abs(b.x - 100.5) < 0.01, "yaw 0 rows toward +z (south)");
  for (let t = 0; t < 60; t++) tickBoat(b, NONE, get);
  assert.ok(Math.hypot(b.vx, b.vz) < 0.01, "it glides to a stop");
  const z0 = b.z;
  for (let t = 0; t < 60; t++) tickBoat(b, { ...NONE, back: true }, get);
  assert.ok(b.z < z0 && z0 - b.z < 4, `backs a little (${(z0 - b.z).toFixed(2)})`);
  const yaw0 = b.yaw;
  for (let t = 0; t < 9; t++) tickBoat(b, { ...NONE, right: true }, get);
  assert.ok(b.yaw > yaw0 + 25, `turns right (${yaw0.toFixed(1)} -> ${b.yaw.toFixed(1)})`);
  const p0 = { x: b.x, z: b.z };
  for (let t = 0; t < 30; t++) tickBoat(b, { ...NONE, left: true }, get);
  assert.ok(Math.hypot(b.x - p0.x, b.z - p0.z) > 0.1, "turning alone creeps forward");
  assert.deepEqual(paddles(FWD), { left: true, right: true });
  assert.deepEqual(paddles({ ...NONE, right: true }), { left: true, right: false });
  assert.deepEqual(paddles({ ...NONE, left: true }), { left: false, right: true });
});

test("flowing water carries a boat nobody rows downstream", () => {
  // a channel along +x at the water level y 9: a source at x 90, flowing levels 1..7 after it, walls either side
  const get = sea((set) => {
    for (let x = 80; x < 120; x++) {
      for (const z of [98, 102]) for (let y = 9; y <= 11; y++) set(x, y, z, B.STONE);
      for (let z = 99; z <= 101; z++) {
        set(x, 9, z, x < 90 ? B.STONE : x === 90 ? B.WATER : x - 90 <= 7 ? B.WATER_FLOW + (x - 90) - 1 : B.AIR);
        for (let y = 5; y < 9; y++) set(x, y, z, B.STONE);
      }
    }
  });
  const b = newBoat(92.5, 9.6, 100.5, 0);
  for (let t = 0; t < 30; t++) tickBoat(b, null, get);
  assert.ok(b.x > 93.5, `pushed along the flow (${b.x.toFixed(2)})`);
});

test("a boat can't climb out of the water or pass a wall; on land it barely moves even rowing", () => {
  const wall = sea((set) => {
    for (let z = 90; z < 110; z++) for (let y = 5; y <= 11; y++) set(110, y, z, B.STONE);
  });
  const b = newBoat(100.5, 9.66, 100.5, -90); // yaw -90: bow toward +x
  for (let t = 0; t < 100; t++) tickBoat(b, FWD, wall);
  assert.ok(b.x < 110 - 0.68, `stopped at the wall (${b.x.toFixed(2)})`);
  // a beach one block above the water: the boat doesn't step up onto it
  const beach = sea((set) => {
    for (let x = 105; x < 130; x++) for (let z = 90; z < 110; z++) for (let y = 5; y <= 10; y++) set(x, y, z, B.SAND);
  });
  const c = newBoat(100.5, 9.66, 100.5, -90);
  for (let t = 0; t < 100; t++) tickBoat(c, FWD, beach);
  assert.ok(c.x < 105 - 0.68 + 1e-6, "it can't run up the beach");
  // on land: put it on the sand and row
  const d = newBoat(115.5, 11, 100.5, -90);
  for (let t = 0; t < 10; t++) tickBoat(d, null, beach);
  assert.equal(d.status, BS.LAND);
  const x0 = d.x;
  for (let t = 0; t < 40; t++) tickBoat(d, FWD, beach);
  const moved = d.x - x0;
  assert.ok(moved > 0 && moved < 2.5, `scrapes along on land (${moved.toFixed(2)} in 2 s)`);
});

test("dropped onto water from the air it settles on top (it doesn't sink); never out of the world", () => {
  const get = sea();
  const b = newBoat(100.5, 16, 100.5, 0);
  let lowest = 99;
  for (let t = 0; t < 120; t++) {
    tickBoat(b, null, get);
    lowest = Math.min(lowest, b.y);
  }
  assert.equal(b.status, BS.WATER);
  assert.ok(lowest > 9 - BOAT_H, `never under the surface (lowest ${lowest.toFixed(2)})`);
  assert.ok(!boatWater(get, b).under);
  const e = newBoat(1.2, 9.66, 100.5, 90); // bow toward -x, at the edge
  for (let t = 0; t < 60; t++) tickBoat(e, FWD, get);
  assert.ok(e.x >= 0.69 && e.x < 1.3, `stops at the edge of the world (${e.x.toFixed(3)})`);
  assert.ok(WORLD_SIZE > 0);
});

test("seats: one rider sits in the middle, two fore and aft; the wire: 11 bytes a boat", () => {
  const b = { x: 10, y: 5, z: 10, yaw: 0 };
  assert.deepEqual(seatPos(b, 0, 1), { x: 10, y: 5 + RIDER_Y, z: 10 });
  const fore = seatPos(b, 0, 2);
  const aft = seatPos(b, 1, 2);
  assert.ok(fore.z > aft.z && Math.abs(fore.z - aft.z - 0.8) < 1e-9, "fore and aft along the bow (yaw 0 = +z)");
  assert.equal(MAX_RIDERS, 2);
  const bytes = encodeBoats(77, [{ id: 3, x: 100.25, y: 39.66, z: 200.5, yaw: -135.5, flags: BF.ROW_L | BF.DRIVEN }]);
  assert.equal(bytes.length, 7 + 11);
  const back = decodeBoats(new DataView(bytes.buffer)).list[0];
  assert.equal(back.id, 3);
  assert.ok(Math.abs(back.x - 100.25) < 0.01 && Math.abs(back.y - 39.66) < 0.005 && Math.abs(back.z - 200.5) < 0.01);
  assert.ok(Math.abs(((back.yaw + 360) % 360) - ((-135.5 + 360) % 360)) < 0.01);
  assert.equal(back.flags, BF.ROW_L | BF.DRIVEN);
});
