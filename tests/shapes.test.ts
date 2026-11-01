// Building blocks: collision matches the shapes (Java step height 0.6, ladders, doors, fences),
// and placement states / two-block structures / support rules behave.
import { test } from "node:test";
import assert from "node:assert/strict";
import { B, BLOCKS } from "../shared/blocks.ts";
import { newPhysState, tickPlayer, shapeIntersectsPlayer, type GetBlock, type MoveInput } from "../shared/physics.ts";
import { breakChanges, door, doorId, facingFromYaw, mergeSlab, partnerCell, placeChanges, placementCells, placementState, supported, toggleDoor, type Change } from "../shared/shapes.ts";

const idle = (yaw = 0): MoveInput => ({ forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, yaw });
const EAST = -90; // Java yaw facing +X

function world(extra: (x: number, y: number, z: number) => number | undefined): GetBlock {
  return (x, y, z) => {
    const e = extra(x, y, z);
    if (e !== undefined) return e;
    return y < 64 ? B.STONE : B.AIR;
  };
}

function settle(get: GetBlock, x: number, y: number, z: number) {
  const s = newPhysState(x, y, z);
  for (let i = 0; i < 30; i++) tickPlayer(s, idle(), get);
  return s;
}

test("walking onto a bottom slab steps up without jumping (Java step height 0.6)", () => {
  const get = world((x, y) => (x >= 103 && y === 64 ? B.OAK_SLAB : undefined));
  const s = settle(get, 100.5, 64, 50.5);
  for (let i = 0; i < 60; i++) tickPlayer(s, { ...idle(EAST), forward: 1 }, get);
  assert.ok(s.x > 105, `x ${s.x}`);
  assert.equal(s.y, 64.5);
});

test("a top slab is a full-height obstacle you must jump onto", () => {
  const get = world((x, y) => (x === 103 && y === 64 ? B.OAK_SLAB + 1 : undefined));
  const s = settle(get, 100.5, 64, 50.5);
  for (let i = 0; i < 40; i++) tickPlayer(s, { ...idle(EAST), forward: 1 }, get);
  assert.ok(s.x < 103, `blocked at x ${s.x}`);
});

test("stairs can be walked up", () => {
  // Stairs facing east (high side east) then a full block: two half-block steps.
  const get = world((x, y) => (x === 103 && y === 64 ? B.OAK_STAIRS + 1 : x >= 104 && y === 64 ? B.OAK_PLANKS : undefined));
  const s = settle(get, 100.5, 64, 50.5);
  for (let i = 0; i < 60; i++) tickPlayer(s, { ...idle(EAST), forward: 1 }, get);
  assert.ok(s.x > 105, `x ${s.x}`);
  assert.equal(s.y, 65);
});

test("ladders: walk into one to climb, sneak to hold on", () => {
  // Wall at x = 104, ladder column at x = 103 facing west (away from the wall).
  const get = world((x, y) => (x === 104 && y >= 64 && y < 72 ? B.STONE : x === 103 && y >= 64 && y < 72 ? B.LADDER + 3 : undefined));
  const s = settle(get, 101.5, 64, 50.5);
  for (let i = 0; i < 40; i++) tickPlayer(s, { ...idle(EAST), forward: 1 }, get);
  assert.ok(s.y > 67, `climbed to ${s.y}`);
  const held = s.y;
  for (let i = 0; i < 20; i++) tickPlayer(s, { ...idle(EAST), sneak: true }, get);
  assert.ok(Math.abs(s.y - held) < 0.25, `held at ${s.y} (was ${held})`);
  for (let i = 0; i < 60; i++) tickPlayer(s, idle(EAST), get);
  assert.ok(s.y < held, "slides down when letting go");
});

test("a closed door blocks the doorway; an open one lets you through", () => {
  const closed = doorId(1, false, false); // facing east: panel on the east side
  const make = (lower: number) =>
    world((x, y) => (x === 103 && y === 64 ? lower : x === 103 && y === 65 ? lower + 8 : undefined));
  const a = settle(make(closed), 100.5, 64, 50.5);
  for (let i = 0; i < 60; i++) tickPlayer(a, { ...idle(EAST), forward: 1 }, make(closed));
  assert.ok(a.x < 104, `stopped by the door at ${a.x}`);
  const open = doorId(1, true, false);
  const b = settle(make(open), 100.5, 64, 50.5);
  for (let i = 0; i < 60; i++) tickPlayer(b, { ...idle(EAST), forward: 1 }, make(open));
  assert.ok(b.x > 105, `walked through to ${b.x}`);
});

test("fences are 1.5 blocks tall: you cannot jump over them", () => {
  const get = world((x, y) => (x === 103 && y === 64 ? B.OAK_FENCE : undefined));
  const s = settle(get, 100.5, 64, 50.5);
  for (let i = 0; i < 100; i++) tickPlayer(s, { ...idle(EAST), forward: 1, jump: true }, get);
  assert.ok(s.x < 103.4, `x ${s.x}`);
});

test("placement states follow the player's facing and the clicked spot", () => {
  const hitTop = { x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, fy: 1 };
  const hitUnder = { x: 0, y: 0, z: 0, nx: 0, ny: -1, nz: 0, fy: 0 };
  const hitSideHigh = { x: 0, y: 0, z: 0, nx: 1, ny: 0, nz: 0, fy: 0.8 };
  assert.equal(facingFromYaw(180), 0); // north
  assert.equal(facingFromYaw(-90), 1); // east
  assert.equal(facingFromYaw(0), 2); // south
  assert.equal(facingFromYaw(90), 3); // west
  assert.equal(placementState(B.OAK_STAIRS, -90, hitTop), B.OAK_STAIRS + 1);
  assert.equal(placementState(B.OAK_STAIRS, -90, hitUnder), B.OAK_STAIRS + 5);
  assert.equal(placementState(B.OAK_SLAB, 0, hitTop), B.OAK_SLAB);
  assert.equal(placementState(B.OAK_SLAB, 0, hitSideHigh), B.OAK_SLAB + 1);
  assert.equal(placementState(B.LADDER, 0, hitTop), null, "ladders only go on walls");
  assert.equal(placementState(B.LADDER, 0, hitSideHigh), B.LADDER + 1, "facing away from the wall (east)");
  assert.equal(mergeSlab(B.OAK_SLAB, B.OAK_SLAB + 1), B.OAK_PLANKS);
  assert.equal(mergeSlab(B.OAK_SLAB, B.OAK_SLAB), -1);
  assert.equal(mergeSlab(B.OAK_SLAB, B.COBBLE_SLAB + 1), -1);
});

test("doors and beds are two blocks; toggling and support rules", () => {
  const d = doorId(2, false, false);
  assert.deepEqual(placementCells(d, 5, 64, 5), [[5, 64, 5, d], [5, 65, 5, d + 8]]);
  assert.deepEqual(partnerCell(d + 8, 5, 65, 5), [5, 64, 5]);
  const bedFoot = B.RED_BED + 1; // facing east
  assert.deepEqual(placementCells(bedFoot, 5, 64, 5), [[5, 64, 5, bedFoot], [6, 64, 5, bedFoot + 4]]);
  assert.deepEqual(partnerCell(bedFoot + 4, 6, 64, 5), [5, 64, 5]);
  const cells = new Map<string, number>([["5,64,5", d], ["5,65,5", d + 8]]);
  const get = (x: number, y: number, z: number) => cells.get(`${x},${y},${z}`) ?? (y < 64 ? B.STONE : B.AIR);
  const t = toggleDoor(5, 65, 5, get)!;
  assert.equal(door(t[0][3]).open, true);
  assert.equal(door(t[1][3]).upper, true);
  assert.equal(supported(d, 5, 64, 5, get), true);
  assert.equal(supported(B.LADDER + 1, 5, 64, 5, get), false, "nothing behind this ladder");
  assert.equal(BLOCKS[d + 8].clientPlace, false, "clients cannot place a lone upper half");
});

test("placement never goes inside a player, using the real shape", () => {
  const get = world(() => undefined);
  // A bottom slab under your feet cell overlaps you; a ladder on the far side of the cell does not.
  assert.equal(shapeIntersectsPlayer(B.OAK_SLAB, 10, 64, 10, 10.5, 64, 10.5, get), true);
  assert.equal(shapeIntersectsPlayer(B.LADDER + 2, 10, 64, 9, 10.5, 64, 10.5, get), false);
});

test("placing and breaking follow one shared rule set (server and client agree)", () => {
  const cells = new Map<string, number>();
  const get = (x: number, y: number, z: number) => cells.get(`${x},${y},${z}`) ?? (y < 64 ? B.STONE : B.AIR);
  const apply = (ch: Change[] | null) => {
    assert.ok(ch);
    for (const [x, y, z, id] of ch) cells.set(`${x},${y},${z}`, id);
  };
  // A slab on the matching half slab completes the block; a different material does not merge.
  apply(placeChanges(B.OAK_SLAB, 5, 64, 5, get));
  assert.deepEqual(placeChanges(B.OAK_SLAB + 1, 5, 64, 5, get), [[5, 64, 5, B.OAK_PLANKS]]);
  assert.equal(placeChanges(B.COBBLE_SLAB + 1, 5, 64, 5, get), null);
  // Doors need two free cells and a solid floor.
  const d = doorId(0, false, false);
  cells.set("8,65,8", B.STONE);
  assert.equal(placeChanges(d, 8, 64, 8, get), null, "no room for the top half");
  cells.delete("8,65,8");
  assert.equal(placeChanges(d, 8, 66, 8, get), null, "no floating doors");
  apply(placeChanges(d, 8, 64, 8, get));
  assert.equal(get(8, 65, 8), d + 8);
  // Ladders need a wall behind them.
  assert.equal(placeChanges(B.LADDER + 1, 9, 64, 9, get), null);
  cells.set("8,64,9", B.STONE);
  assert.deepEqual(placeChanges(B.LADDER + 1, 9, 64, 9, get), [[9, 64, 9, B.LADDER + 1]]);
  // Breaking the floor under a door takes the whole door; breaking its top half takes the bottom too.
  const under = breakChanges(8, 63, 8, get).map((c) => c.join(","));
  assert.deepEqual(under.sort(), ["8,63,8,0", "8,64,8,0", "8,65,8,0"].sort());
  const top = breakChanges(8, 65, 8, get).map((c) => c.join(","));
  assert.deepEqual(top.sort(), ["8,64,8,0", "8,65,8,0"].sort());
  // A torch pops off when its block goes. Breaking next to water leaves air: the server's water simulation flows
  // in a moment later (tests/water.test.ts), so client prediction and server agree on the break itself.
  cells.set("3,64,3", B.TORCH);
  assert.deepEqual(breakChanges(3, 63, 3, get).map((c) => c.join(",")).sort(), ["3,63,3,0", "3,64,3,0"].sort());
  cells.set("20,63,20", B.WATER);
  assert.deepEqual(breakChanges(21, 63, 20, get), [[21, 63, 20, B.AIR]]);
});
