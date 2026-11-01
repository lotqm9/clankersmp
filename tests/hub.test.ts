// The spawn hub (shared/hub12.ts over the old hub, shared/hub.ts): flat out to r 64 with nothing carved under it, the
// plaza and the "punch a tree" landmark (shared/landmark.ts), the spawn in the arrival courtyard facing it, the
// Beacon (climbable, the highest thing around), avenues, the ring road and a signposted gate per road, the boards and
// the halls, the Workshop's stations, settled water, lanterns for the night. Plus a planted sapling's tree shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { B, EMIT, SOLID, isFurnace } from "../shared/blocks.ts";
import { DEFAULT_SEED, SPAWN_X, SPAWN_Z, WORLD_HEIGHT, WORLD_SIZE, idx } from "../shared/constants.ts";
import { OLD_SAFE_RADIUS, SAFE_RADIUS } from "../shared/hub.ts";
import { CHEST_ROWS, FACE_ROWS } from "../shared/landmark.ts";
import { HUB_R } from "../shared/hub12.ts";
import { generateWorld, hashBlocks } from "../shared/worldgen.ts";
import { nextWater } from "../shared/water.ts";
import { treeChanges } from "../shared/trees.ts";

const { blocks, info } = generateWorld(DEFAULT_SEED);
const at = (x: number, y: number, z: number) => (x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE || y < 0 || y >= WORLD_HEIGHT ? B.STONE : blocks[idx(x, y, z)]);
const sh = info.spawnHeight;
const CX = SPAWN_X;
const CZ = SPAWN_Z;
const top = (x: number, z: number) => {
  for (let y = WORLD_HEIGHT - 1; y > 0; y--) if (SOLID[at(x, y, z)]) return y;
  return 0;
};

test("the old hub is built first, always the same (the terrain under any tiles kept for players)", () => {
  assert.equal(hashBlocks(generateWorld(DEFAULT_SEED, undefined, { villages: [3], hub: false }).blocks).toString(16), "e19fa12e", "with one village");
  assert.equal(hashBlocks(generateWorld(DEFAULT_SEED, undefined, { hub: false }).blocks).toString(16), "7bdac830", "a fresh world's terrain");
  assert.equal(SAFE_RADIUS, 68);
  assert.equal(OLD_SAFE_RADIUS, 46);
  assert.equal(info.hub.safeRadius, 68);
});

test("the hub is flat ground at the plaza height out to r 64, with nothing carved under it", () => {
  let checked = 0;
  for (let dz = -HUB_R; dz <= HUB_R; dz += 3)
    for (let dx = -HUB_R; dx <= HUB_R; dx += 3) {
      if (dx * dx + dz * dz > (HUB_R - 1) ** 2) continue;
      const x = CX + dx;
      const z = CZ + dz;
      assert.ok(SOLID[at(x, sh, z)] || at(x, sh, z) === B.WATER, `floor at ${dx},${dz}`);
      for (let y = sh - 6; y < sh; y++) assert.notEqual(at(x, y, z), B.AIR, `no cave under the hub at ${dx},${y - sh},${dz}`);
      checked++;
    }
  assert.ok(checked > 1300, `${checked}`);
});

test("the landmark: a blocky guy in a teal shirt and blue trousers punching a tree; the plaque; the spawn faces it", () => {
  const lm = info.hub.landmark!;
  assert.ok(lm, "the landmark stands");
  const { x: sx, z: sz, y0 } = lm.figure;
  assert.equal(y0, sh + 2, "standing on the dais's lawn");
  assert.equal(at(sx, sh + 1, sz), B.GRASS);
  assert.equal(lm.figure.top, y0 + 31, "32 blocks tall");
  // trousers and shoes, the shirt with the gold "$" on the chest, the face looking east at the tree
  assert.equal(at(sx, y0 + 6, sz), B.SMOOTH_BLUE, "blue trousers");
  assert.equal(at(sx, y0, sz), B.WOOL_GREY, "shoes");
  assert.equal(at(sx - 2, y0 + 16, sz), B.SMOOTH_TEAL, "a teal shirt");
  let gold = 0;
  CHEST_ROWS.forEach((row, r) => [...row].forEach((ch, c) => {
    const id = at(sx + 1, y0 + 23 - r, sz + 3 - c);
    if (ch === "G") {
      gold++;
      assert.equal(id, B.GOLD_BLOCK, `the $ at ${c},${r}`);
    }
  }));
  assert.equal(gold, 9, "the $ sign");
  assert.equal(FACE_ROWS.length, 8);
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (FACE_ROWS[r][c] === "W") assert.equal(at(sx + 3, y0 + 31 - r, sz + 3 - c), B.WOOL_WHITE, "an eye");
  assert.equal(at(sx - 1, y0 + 31, sz), B.WOOL_BROWN, "hair on top");
  // the right arm straight out at shoulder height, the fist meeting the trunk
  for (let x = sx + 2; x <= sx + 9; x++) assert.equal(at(x, y0 + 21, sz + 5), B.SMOOTH_TAN, `the arm at ${x - sx}`);
  assert.equal(at(sx + 10, y0 + 21, sz + 5), B.OAK_LOG, "the fist meets the trunk");
  assert.equal(at(sx + 4, y0 + 15, sz + 5), B.AIR, "nothing under the arm");
  assert.equal(lm.tree.x, sx + 10);
  assert.ok(lm.tree.top > lm.figure.top && lm.tree.top < sh + 45, `the crown over him (${lm.tree.top - sh})`);
  let leaves = 0;
  for (let y = y0 + 20; y <= lm.tree.top; y++) for (let z = sz - 6; z <= sz + 20; z++) for (let x = sx; x <= sx + 22; x++) if (at(x, y, z) === B.OAK_LEAVES) leaves++;
  assert.ok(leaves > 400, `a big crown (${leaves} leaves)`);
  for (let x = sx - 4; x <= sx + 3; x++) for (let z = sz - 4; z <= sz + 3; z++) assert.notEqual(at(x, y0 + 32, z), B.OAK_LEAVES, "no leaves on his head");
  // the plaque on the dais's south rim, facing the arrival
  assert.deepEqual(info.board, { x0: CX - 4, x1: CX + 4, y0: sh + 2, y1: sh + 3, z: CZ + 7 });
  for (let x = CX - 4; x <= CX + 4; x++) for (let y = sh + 2; y <= sh + 3; y++) assert.equal(at(x, y, CZ + 7), B.STONE_BRICKS, "the plaque's wall");
  // the spawn: in the courtyard south of the plaza, on solid ground with room to stand
  assert.deepEqual(info.spawn, { x: CX + 0.5, y: sh + 1, z: CZ + 44.5 });
  assert.ok(SOLID[at(CX, sh, CZ + 44)] && at(CX, sh + 1, CZ + 44) === B.AIR && at(CX, sh + 2, CZ + 44) === B.AIR);
  // facing north from there, nothing solid between the eye and the landmark's head, or the Beacon's lantern room
  // behind it (through the welcome arch, over the punching arm)
  const eye = [CX + 0.5, sh + 2.62, CZ + 44.5];
  for (const [aim, stop] of [[[sx - 0.5, y0 + 29, sz - 0.5], sz + 4], [[CX + 0.5, sh + 49, CZ - 35.5], CZ - 31]] as [number[], number][])
    for (let k = 1; k < 400; k++) {
      const t = k / 400;
      const x = Math.floor(eye[0] + (aim[0] - eye[0]) * t);
      const y = Math.floor(eye[1] + (aim[1] - eye[1]) * t);
      const z = Math.floor(eye[2] + (aim[2] - eye[2]) * t);
      if (z <= stop) break;
      assert.ok(!SOLID[at(x, y, z)] || at(x, y, z) === B.GLASS_PANE, `the view at ${x - CX},${y - sh},${z - CZ}: ${at(x, y, z)}`);
    }
  const arrival = info.hub.panels.filter((p) => p.kind === "arrival");
  assert.ok(arrival.some((p) => p.text === "Welcome to $STEVE Craft" && p.nz === 1 && p.z > CZ + 38 && p.z < info.spawn.z), "the welcome arch faces you");
});

test("the Beacon: a tower 58 blocks tall north of the plaza, the highest thing for 150 blocks, with a ladder to its gallery", () => {
  const b = info.hub.beacon!;
  assert.deepEqual(b, { x: CX, z: CZ - 36, top: sh + 58 });
  assert.equal(at(b.x, b.top, b.z), B.DIAMOND_BLOCK, "a diamond on its tip");
  for (let dz = -150; dz <= 150; dz += 2)
    for (let dx = -150; dx <= 150; dx += 2) {
      if (Math.abs(dx) <= 6 && Math.abs(dz + 36) <= 6) continue;
      assert.ok(top(CX + dx, CZ + dz) < b.top, `taller ground at ${dx},${dz}`);
    }
  // the climb: through the door, a ladder from the floor to the lantern room, out onto the gallery
  for (let dx = -1; dx <= 1; dx++) for (let dy = 1; dy <= 4; dy++) assert.equal(at(CX + dx, sh + dy, CZ - 32), B.AIR, "the door");
  for (let dy = 1; dy <= 46; dy++) {
    assert.equal(at(CX, sh + dy, CZ - 38), B.LADDER + 2, `ladder at ${dy}`);
    assert.ok(SOLID[at(CX, sh + dy, CZ - 39)], `the wall behind it at ${dy}`);
  }
  for (let dx = -5; dx <= 5; dx++) assert.ok(SOLID[at(CX + dx, sh + 45, CZ - 36 + 5)], "the gallery floor");
  assert.equal(at(CX, sh + 46, CZ - 36 + 3), B.AIR, "a door out to it");
  assert.equal(at(CX, sh + 47, CZ - 36 + 3), B.AIR);
  assert.ok(info.hub.panels.some((p) => p.kind === "beacon"));
});

test("avenues from the plaza to the ring road, and a signposted gate for every road out", () => {
  for (const [ax, az] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
    for (let a = 23; a <= 56; a++) {
      const id = at(CX + ax * a, sh, CZ + az * a);
      assert.ok(SOLID[id] || id === B.WATER, `avenue at ${a} (${ax},${az}): ${id}`);
      assert.notEqual(id, B.GRASS, `paved at ${a} (${ax},${az})`);
    }
  }
  let ring = 0;
  for (let k = 0; k < 64; k++) {
    const x = Math.round(CX + 57 * Math.cos((k * Math.PI) / 32));
    const z = Math.round(CZ + 57 * Math.sin((k * Math.PI) / 32));
    if (at(x, sh, z) !== B.GRASS) ring++;
  }
  assert.equal(ring, 64, "the ring road all the way round");
  const h = info.hub;
  assert.deepEqual(h.destinations!.map((d) => d.name).sort(), [...info.villages.list.map((v) => v.name), "Harbour"].sort(), "a road to every village and the harbour");
  for (const g of h.gates!) {
    // pillars with a teal band and a lantern, the way through clear
    let pillars = 0;
    for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) if (at(g.x + dx, sh + 3, g.z + dz) === B.SMOOTH_TEAL && at(g.x + dx, sh + 5, g.z + dz) === B.LANTERN) pillars++;
    assert.equal(pillars, 2, `gate ${g.names}`);
    assert.equal(at(g.x, sh + 1, g.z), B.AIR);
    assert.equal(at(g.x, sh + 2, g.z), B.AIR);
    // its signpost names where it goes (facing in) and says the way back (facing out)
    const signs = h.panels.filter((p) => p.kind === "gate" && Math.hypot(p.x - g.x, p.z - g.z) < 8);
    assert.equal(signs.length, 2);
    for (const n of g.names) assert.ok(signs.some((p) => p.text!.includes(n)), `the sign names ${n}`);
  }
  for (const r of h.roads!) assert.ok(r.reached && r.cells > 10, `the road to ${r.to}`);
});

test("the boards: welcome and rules on the avenue, tips and directions at the arrival, charity and updates in their halls", () => {
  const p = info.hub.panels;
  for (const k of ["welcome", "rules", "tips", "directions", "charity", "updates", "hall", "news", "starter", "beacon"]) assert.equal(p.filter((q) => q.kind === k).length, 1, k);
  assert.equal(p.filter((q) => q.kind === "spawn" || q.kind === "wild").length, 0, "the old gates' beams are gone");
  const dir = p.find((q) => q.kind === "directions")!;
  for (const d of info.hub.destinations!) assert.ok(dir.lines!.some((l) => l.startsWith(`${d.name}: `)), `directions to ${d.name}`);
  // the halls: the board inside on the back wall, under a roof, the name over the door
  for (const kind of ["charity", "updates"] as const) {
    const b = p.find((q) => q.kind === kind)!;
    assert.equal(b.nz, -1);
    const x = Math.floor(b.x);
    assert.ok(SOLID[at(x, sh + 2, CZ + 13)], `${kind}: the wall behind the board`);
    assert.ok(SOLID[at(x, sh + 7, CZ + 9)], `${kind}: a roof`);
  }
});

test("the Workshop has crafting tables and furnaces anyone can use", () => {
  const st = info.hub.stations;
  assert.equal(st.filter((s) => s.id === B.CRAFTING_TABLE).length, 4);
  assert.equal(st.filter((s) => isFurnace(s.id)).length, 4);
  for (const s of st) assert.equal(at(s.x, s.y, s.z), s.id);
});

test("the pool and the fountain are already settled water (the server never has to run them)", () => {
  let water = 0;
  for (const [z0, z1] of [[CZ - 31, CZ - 21], [CZ + 46, CZ + 56]])
    for (let y = sh - 1; y <= sh + 4; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = CX - 6; x <= CX + 6; x++) {
          const id = at(x, y, z);
          if (id === B.WATER || (id >= B.WATER_FLOW && id <= B.WATER_FALL)) water++;
          const n = nextWater(at, x, y, z);
          assert.ok(n < 0 || n === id, `water at ${x - CX},${y - sh},${z - CZ} would change (${id} -> ${n})`);
        }
  assert.ok(water > 40, `${water} water cells`);
});

test("lit at night: lanterns and lamps across the hub; no wild trees inside it", () => {
  let lights = 0;
  let wildLogs = 0;
  for (let dz = -HUB_R; dz <= HUB_R; dz++)
    for (let dx = -HUB_R; dx <= HUB_R; dx++) {
      if (dx * dx + dz * dz > HUB_R * HUB_R) continue;
      for (let y = sh + 1; y <= sh + 14; y++) {
        const id = at(CX + dx, y, CZ + dz);
        if (EMIT[id] >= 14) lights++;
        if (id === B.BIRCH_LOG) wildLogs++;
      }
    }
  assert.ok(lights >= 60, `${lights} lights`);
  assert.equal(wildLogs, 0, "no birch trees from the wild in the hub");
  assert.equal(top(CX + 40, CZ - 10), sh, "flat lawn");
});

test("a sapling grows into a tree only where there is room", () => {
  const flat = (x: number, y: number, _z: number) => (y < 40 ? B.STONE : y === 40 ? B.GRASS : y === 41 && x === 10 ? B.OAK_SAPLING : B.AIR);
  const ch = treeChanges(flat, 10, 41, 10, false, () => 0.5)!;
  assert.ok(ch.some(([x, y, z, id]) => x === 10 && y === 41 && z === 10 && id === B.OAK_LOG), "the trunk replaces the sapling");
  assert.ok(ch.filter(([, , , id]) => id === B.OAK_LEAVES).length > 20);
  const roofed = (x: number, y: number, z: number) => (y === 44 ? B.STONE : flat(x, y, z));
  assert.equal(treeChanges(roofed, 10, 41, 10, false, () => 0.5), null, "no room under a roof");
});
