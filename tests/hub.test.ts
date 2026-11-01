// The spawn hub (shared/hub12.ts over the old hub, shared/hub.ts): flat out to r 64 with nothing carved under it, the
// plaza and the monument (shared/landmark.ts: clankersmp's three AIs), the spawn in the arrival courtyard facing it, the
// Beacon (climbable, the highest thing around), avenues, the ring road and a signposted gate per road, the boards and
// the halls, the Workshop's stations, settled water, lanterns for the night. Plus a planted sapling's tree shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { B, EMIT, SOLID, isFurnace } from "../shared/blocks.ts";
import { DEFAULT_SEED, SPAWN_X, SPAWN_Z, WORLD_HEIGHT, WORLD_SIZE, idx } from "../shared/constants.ts";
import { OLD_SAFE_RADIUS, SAFE_RADIUS } from "../shared/hub.ts";
import { STATUE_HEIGHT, STATUE_LOOKS } from "../shared/landmark.ts";
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

test("the monument: opus, sonnet and haiku as statues built from their skins, on their base; the plaque; the spawn faces them", () => {
  const lm = info.hub.landmark!;
  assert.ok(lm, "the monument stands");
  assert.deepEqual(lm.statues.map((s) => s.name), ["opus", "sonnet", "haiku"], "west to east as you look at them");
  const [opus, sonnet, haiku] = lm.statues;
  for (const s of lm.statues) {
    assert.equal(s.y0, sh + 4, `${s.name}: on the base`);
    assert.equal(s.top, s.y0 + STATUE_HEIGHT - 1, `${s.name}: ${STATUE_HEIGHT} tall`);
    for (let x = s.x0 + 3; x <= s.x0 + 8; x++) for (let z = s.zb; z <= s.zb + 3; z++) assert.equal(at(x, sh + 3, z), B.STONE_BRICKS, `${s.name}: the base under its feet`);
    assert.equal(at(s.x0 + 5, s.top + 1, s.zb), B.AIR, `${s.name}: nothing on its head`);
  }
  assert.ok(opus.top < sh + 32, "a little shorter than the old 32-block figure");
  // sonnet in front, opus and haiku a step behind either side, their inner arms just behind sonnet's
  assert.equal(opus.zb, sonnet.zb - 4);
  assert.equal(haiku.zb, sonnet.zb - 4);
  assert.equal(opus.x0 + 9, sonnet.x0, "opus's left arm behind sonnet's right");
  assert.equal(haiku.x0, sonnet.x0 + 9, "haiku's right arm behind sonnet's left");
  // every face and chest is the skin's, a block per pixel; the coats are their own colours
  STATUE_LOOKS.forEach((L, k) => {
    const s = lm.statues[k];
    const hx = s.x0 + 2;
    const hy = s.y0 + 20;
    const face = s.zb + 5;
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) assert.equal(at(hx + c, hy + 7 - r, face), L.pal[L.face[r][c]], `${L.name}: the face at ${c},${r}`);
    for (let r = 0; r < 10; r++) for (let c = 0; c < 6; c++) assert.equal(at(s.x0 + 3 + c, s.y0 + 19 - r, s.zb + 3), L.pal[L.chest[r][c]], `${L.name}: the chest at ${c},${r}`);
    for (let r = 0; r < 10; r++) assert.equal(at(s.x0 + 4, s.y0 + 9 - r, s.zb + 3), L.pal[L.legs[r]], `${L.name}: the leg at ${r}`);
    assert.equal(at(s.x0 + 1, s.y0 + 15, s.zb + 3), L.pal.c, `${L.name}: a sleeve`);
    assert.equal(at(s.x0 + 1, s.y0 + 10, s.zb + 3), L.pal.s, `${L.name}: a hand`);
    assert.equal(at(hx + 3, hy + 7, s.zb), L.hood ? L.pal.c : L.pal.h, `${L.name}: ${L.hood ? "the hood up" : "hair"} on top`);
  });
  assert.equal(at(opus.x0 + 4, opus.y0 + 15, opus.zb + 3), B.WOOL_RED, "opus: a red hoodie");
  assert.equal(at(sonnet.x0 + 4, sonnet.y0 + 15, sonnet.zb + 3), B.SMOOTH_BLUE, "sonnet: a blue jacket");
  assert.equal(at(haiku.x0 + 4, haiku.y0 + 15, haiku.zb + 3), B.WOOL_YELLOW, "haiku: a yellow raincoat");
  assert.equal(at(opus.x0 + 4, opus.y0 + 19, opus.zb + 3), B.WOOL_WHITE, "opus: a drawstring");
  assert.equal(at(sonnet.x0 + 6, sonnet.y0 + 15, sonnet.zb + 3), B.CLAY, "sonnet: the zip");
  // the heads stand apart: a clear column between them
  for (const x of [sonnet.x0 + 1, sonnet.x0 + 10]) for (let z = opus.zb - 2; z <= sonnet.zb + 5; z++) assert.equal(at(x, sonnet.y0 + 24, z), B.AIR, `between the heads at ${x - CX},${z - CZ}`);
  // the plaque on the base's front under sonnet, facing the arrival
  assert.deepEqual(info.board, { x0: CX - 5, x1: CX + 4, y0: sh + 2, y1: sh + 3, z: CZ + 4 });
  for (let x = CX - 5; x <= CX + 4; x++) for (let y = sh + 2; y <= sh + 3; y++) assert.equal(at(x, y, CZ + 4), B.STONE_BRICKS, "the plaque's wall");
  // the dais round it all: lawn in a rim, clear of the plaza's posts and benches
  assert.equal(at(CX - 16, sh + 1, CZ - 2), B.GRASS);
  assert.equal(at(CX + 17, sh + 1, CZ - 2), B.STONE_BRICKS);
  assert.equal(at(CX + 18, sh + 1, CZ - 2), B.STONE_BRICK_SLAB);
  for (const [dx, dz] of [[13, -13], [-13, -13], [18, -7], [-18, -7]]) assert.equal(at(CX + dx, sh + 3, CZ + dz), B.LANTERN, `the post at ${dx},${dz}`);
  for (const [dx, dz] of [[19, -3], [-19, 3]]) assert.ok(at(CX + dx, sh + 1, CZ + dz) >= B.OAK_STAIRS && at(CX + dx, sh + 1, CZ + dz) < B.OAK_STAIRS + 8, `the bench at ${dx},${dz}`);
  // the spawn: in the courtyard south of the plaza, on solid ground with room to stand
  assert.deepEqual(info.spawn, { x: CX + 0.5, y: sh + 1, z: CZ + 44.5 });
  assert.ok(SOLID[at(CX, sh, CZ + 44)] && at(CX, sh + 1, CZ + 44) === B.AIR && at(CX, sh + 2, CZ + 44) === B.AIR);
  // facing north from there, through the welcome arch, nothing solid between the eye and any of the three faces
  const eye = [CX + 0.5, sh + 2.62, CZ + 44.5];
  for (const s of lm.statues) {
    const aim = [s.x0 + 6, s.y0 + 24.5, s.zb + 6];
    for (let k = 1; k < 400; k++) {
      const t = k / 400;
      const x = Math.floor(eye[0] + (aim[0] - eye[0]) * t);
      const y = Math.floor(eye[1] + (aim[1] - eye[1]) * t);
      const z = Math.floor(eye[2] + (aim[2] - eye[2]) * t);
      if (z < s.zb + 6) break;
      assert.ok(!SOLID[at(x, y, z)], `the view of ${s.name} at ${x - CX},${y - sh},${z - CZ}: ${at(x, y, z)}`);
    }
  }
  const arrival = info.hub.panels.filter((p) => p.kind === "arrival");
  assert.ok(arrival.some((p) => p.text === "Welcome to clankersmp" && p.nz === 1 && p.z > CZ + 38 && p.z < info.spawn.z), "the welcome arch faces you");
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

test("the boards: welcome and rules on the avenue, tips and directions at the arrival, the experiment and updates in their halls", () => {
  const p = info.hub.panels;
  for (const k of ["welcome", "rules", "tips", "directions", "experiment", "updates", "hall", "news", "starter", "beacon"]) assert.equal(p.filter((q) => q.kind === k).length, 1, k);
  assert.equal(p.filter((q) => q.kind === "spawn" || q.kind === "wild").length, 0, "the old gates' beams are gone");
  const dir = p.find((q) => q.kind === "directions")!;
  for (const d of info.hub.destinations!) assert.ok(dir.lines!.some((l) => l.startsWith(`${d.name}: `)), `directions to ${d.name}`);
  // the halls: the board inside on the back wall, under a roof, the name over the door
  assert.equal(p.filter((q) => q.kind === "charity").length, 0, "no charity board");
  assert.deepEqual(p.filter((q) => q.kind === "hall" || q.kind === "news").map((q) => q.text).sort(), ["the experiment", "updates"]);
  for (const kind of ["experiment", "updates"] as const) {
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
