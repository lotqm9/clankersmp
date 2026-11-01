// The villages (update 11, protocol v9): up to four on the main island, well away from the spawn hub (and from the
// bigger hub of update 12, built after them: these compare the villages alone, hub: false); a world gets only the sites whose square has no edits at all, so no live build is ever
// touched (and a world with none left is exactly the terrain of update 10); everything a village changes lies in its
// own square; each one has its plaza (the well, the chime, lamp posts), roads, five houses with doors, windows, beds,
// chests, crafting tables and furnaces, two wheat farms, five villagers with five jobs who each have a home and a
// doorstep to stand on, and two loot chests; deterministic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { B, SOLID, IS_WATER } from "../shared/blocks.ts";
import { DEFAULT_SEED, SPAWN_X, SPAWN_Z, WORLD_SIZE as W, cellX, cellZ, idx } from "../shared/constants.ts";
import { SAFE_RADIUS } from "../shared/hub.ts";
import { door, isBed, isDoor, supported } from "../shared/shapes.ts";
import { DEFAULT_VILLAGES, FIRST_SITES, MAX_VILLAGES, VILLAGE_CHECK, VILLAGE_R, VILLAGE_SITES, chooseVillages, sitesOverlap, villageBox, villageDistanceToSpawn, villagerId } from "../shared/villages.ts";
import { JOBS } from "../shared/villagers.ts";
import { generateWorld, hashBlocks } from "../shared/worldgen.ts";

const none = generateWorld(DEFAULT_SEED, undefined, { villages: [], hub: false });
const all = generateWorld(DEFAULT_SEED, undefined, { villages: [0, 1, 2, 3, 4], hub: false });
const a = none.blocks;
const b = all.blocks;
const at = (x: number, y: number, z: number) => b[idx(x, y, z)];

test("with no villages the world is exactly the plain terrain (fd831ace): a world whose sites are all edited keeps its land", () => {
  assert.equal(hashBlocks(a).toString(16), "fd831ace");
});

test("the sites: far from the spawn hub (room for a bigger hub too), in the world; the first five never overlap", () => {
  for (let i = 0; i < VILLAGE_SITES.length; i++) {
    const q = villageBox(i);
    assert.ok(q.x0 >= 4 && q.z0 >= 4 && q.x1 < W - 4 && q.z1 < W - 4, `${VILLAGE_SITES[i].name} inside the world`);
    // past the safe zone, and past the bigger hub of the next update (at most 72 blocks), with room to spare
    assert.ok(villageDistanceToSpawn(i) > Math.max(SAFE_RADIUS, 72) + 5, `${VILLAGE_SITES[i].name}: ${villageDistanceToSpawn(i).toFixed(0)} blocks from spawn`);
    for (let j = 0; j < i; j++) {
      assert.notEqual(VILLAGE_SITES[i].key, VILLAGE_SITES[j].key);
      if (i < FIRST_SITES) assert.ok(!sitesOverlap(i, j), `${VILLAGE_SITES[i].name} and ${VILLAGE_SITES[j].name} apart`);
    }
  }
  assert.equal(VILLAGE_SITES.length, 29);
  assert.deepEqual(DEFAULT_VILLAGES, [0, 1, 2, 3]);
});

const edited = (...ks: number[]) => (k: number) => ks.includes(k);
/** A world where players built (a 20 x 20 base) in the middle of these sites: every site whose square that reaches. */
const builtOn = (...ks: number[]) => (k: number) =>
  ks.some((b) => {
    const s = VILLAGE_SITES[b];
    const q = villageBox(k);
    return s.x + 10 >= q.x0 && s.x - 10 <= q.x1 && s.z + 10 >= q.z0 && s.z - 10 <= q.z1;
  });
const apart = (l: number[]) => l.every((a, i) => l.every((c, j) => i === j || !sitesOverlap(a, c)));

test("a world gets only sites with no edits in their square: the first four of the first five, then more further out", () => {
  assert.deepEqual(chooseVillages(() => false), [0, 1, 2, 3], "a fresh world: the first four");
  assert.deepEqual(chooseVillages(edited(1)), [0, 2, 3, 4], "Thistle End edited: Honeybrook instead");
  const two = chooseVillages(builtOn(0, 2));
  assert.deepEqual(two.slice(0, 3), [1, 3, 4], "two of the first edited: the other three first");
  assert.equal(two.length, 4, "and one more from the 11.1 sites");
  assert.ok(two[3] >= FIRST_SITES && apart(two));
  assert.deepEqual(chooseVillages(() => true), [], "every site edited: no villages at all");
  assert.equal(MAX_VILLAGES, 4);
});

test("update 11.1: a world like the live one (Pennywhistle only, its players built on the other four first sites) gets three more, spread out", () => {
  const live = chooseVillages(builtOn(0, 1, 2, 4), [3]);
  assert.equal(live.length, 4, `four villages: ${live.map((k) => VILLAGE_SITES[k].name).join(", ")}`);
  assert.equal(live[0], 3, "Pennywhistle kept");
  assert.ok(live.slice(1).every((k) => k >= FIRST_SITES && !builtOn(0, 1, 2, 4)(k)), "only sites nobody built on");
  assert.ok(apart(live), "no two on the same ground");
  for (let i = 0; i < live.length; i++)
    for (let j = 0; j < i; j++) {
      const p = VILLAGE_SITES[live[i]];
      const q = VILLAGE_SITES[live[j]];
      assert.ok(Math.hypot(p.x - q.x, p.z - q.z) > 120, `${p.name} and ${q.name} spread out`);
    }
  // the same world asked again: the same answer; with its four, nothing more
  assert.deepEqual(chooseVillages(builtOn(0, 1, 2, 4), [3]), live);
  assert.deepEqual(chooseVillages(() => false, live), live);
  // and with edits on three of the first five (a world deciding for the first time): four as well
  const three = chooseVillages(builtOn(0, 1, 2));
  assert.deepEqual(three.slice(0, 2), [3, 4]);
  assert.equal(three.length, 4);
  assert.ok(apart(three));
  // even if players had also built on half of the new sites, nearly every such world still gets four
  let four = 0;
  for (let t = 0; t < 400; t++) {
    const extra = new Set<number>();
    for (let k = FIRST_SITES; k < VILLAGE_SITES.length; k++) if (((t * 7919 + k * 104729) % 97) / 97 < 0.5) extra.add(k);
    if (chooseVillages((k) => builtOn(0, 1, 2, 4)(k) || extra.has(k), [3]).length === 4) four++;
  }
  assert.ok(four / 400 > 0.7, `${((four / 400) * 100).toFixed(0)}% of them still four`);
});

test("update 11.1: Pennywhistle is exactly as before (e19fa12e), whatever villages join it", () => {
  const penny = generateWorld(DEFAULT_SEED, undefined, { villages: [3], hub: false });
  assert.equal(hashBlocks(penny.blocks).toString(16), "e19fa12e", "the world with Pennywhistle alone");
  assert.equal(hashBlocks(generateWorld(DEFAULT_SEED, undefined, { hub: false }).blocks).toString(16), "7bdac830", "a fresh world as before");
  const live = chooseVillages(builtOn(0, 1, 2, 4), [3]);
  const more = generateWorld(DEFAULT_SEED, undefined, { villages: live, hub: false });
  const s = VILLAGE_SITES[3];
  let diff = 0;
  for (let z = s.z - VILLAGE_CHECK; z <= s.z + VILLAGE_CHECK; z++) for (let x = s.x - VILLAGE_CHECK; x <= s.x + VILLAGE_CHECK; x++) for (let y = 0; y < 128; y++) if (penny.blocks[idx(x, y, z)] !== more.blocks[idx(x, y, z)]) diff++;
  assert.equal(diff, 0, "not one cell of Pennywhistle's square differs");
  // and nothing outside the new villages' own squares changed either
  for (let i = 0; i < penny.blocks.length; i++) {
    if (penny.blocks[i] === more.blocks[i]) continue;
    const x = cellX(i);
    const z = cellZ(i);
    assert.ok(live.slice(1).some((k) => Math.abs(x - VILLAGE_SITES[k].x) <= VILLAGE_CHECK && Math.abs(z - VILLAGE_SITES[k].z) <= VILLAGE_CHECK), `cell ${x},${z} in a new village's square`);
  }
  assert.equal(more.info.villages.list.length, 4);
});

test("update 11.1: every new site makes a whole village (houses, doors, beds, chests, the well, the chime, the farms)", () => {
  // the new sites in batches of ones that don't overlap
  const left = VILLAGE_SITES.map((_, k) => k).filter((k) => k >= FIRST_SITES);
  while (left.length) {
    const batch: number[] = [];
    for (const k of [...left]) if (batch.every((b) => !sitesOverlap(b, k))) batch.push(k);
    for (const k of batch) left.splice(left.indexOf(k), 1);
    const w = generateWorld(DEFAULT_SEED, undefined, { villages: batch, hub: false });
    const get = (x: number, y: number, z: number) => w.blocks[idx(x, y, z)];
    assert.equal(w.info.villages.list.length, batch.length);
    for (const v of w.info.villages.list) {
      assert.equal(get(v.chime[0], v.chime[1], v.chime[2]), B.VILLAGE_CHIME, `${v.name}: the chime`);
      assert.ok(IS_WATER[get(v.x, v.y, v.z)], `${v.name}: the well`);
      assert.equal(v.houses.length, 5);
      for (const h of v.houses) {
        assert.ok(isDoor(get(...h.door)) && isBed(get(...h.bed)), `${v.name}: a door and a bed`);
        assert.ok(!SOLID[get(...h.inside)] && !SOLID[get(h.inside[0], h.inside[1] + 1, h.inside[2])] && SOLID[get(h.inside[0], h.inside[1] - 1, h.inside[2])], `${v.name}: room at home`);
      }
      assert.equal(v.chests.length, 2);
      let farmland = 0;
      for (let dz = -VILLAGE_R; dz <= VILLAGE_R; dz++) for (let dx = -VILLAGE_R; dx <= VILLAGE_R; dx++) if (get(v.x + dx, v.y, v.z + dz) === B.FARMLAND + 1) farmland++;
      assert.ok(farmland >= 140, `${v.name}: ${farmland} farmland`);
    }
  }
});

test("every cell a village changes is inside its own square; generating twice gives the same world", () => {
  let changed = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    changed++;
    const x = cellX(i);
    const z = cellZ(i);
    assert.ok(
      VILLAGE_SITES.some((s) => Math.abs(x - s.x) <= VILLAGE_CHECK && Math.abs(z - s.z) <= VILLAGE_CHECK),
      `cell ${x},${z} outside every village's square`,
    );
  }
  assert.ok(changed > 50_000, `${changed} cells`);
  assert.equal(hashBlocks(generateWorld(DEFAULT_SEED, undefined, { villages: [0, 1, 2, 3, 4], hub: false }).blocks), hashBlocks(b));
  // the default world (no edits anywhere) has the first four
  assert.deepEqual(generateWorld(DEFAULT_SEED).info.villages.list.map((v) => v.site), [0, 1, 2, 3]);
});

test("each village: a level plaza with the well, the chime and lamp posts; roads; farms; no water left where it stands", () => {
  for (const v of all.info.villages.list) {
    const H = v.y;
    assert.equal(at(v.chime[0], v.chime[1], v.chime[2]), B.VILLAGE_CHIME, `${v.name}: the chime`);
    let water = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (IS_WATER[at(v.x + dx, H, v.z + dz)]) water++;
    assert.equal(water, 9, `${v.name}: the well`);
    let lanterns = 0;
    let path = 0;
    let farmland = 0;
    let wheat = 0;
    let panes = 0;
    let tables = 0;
    let furnaces = 0;
    let beds = 0;
    let doors = 0;
    let chests = 0;
    for (let dz = -VILLAGE_R; dz <= VILLAGE_R; dz++)
      for (let dx = -VILLAGE_R; dx <= VILLAGE_R; dx++)
        for (let y = H - 1; y <= H + 12; y++) {
          const id = at(v.x + dx, y, v.z + dz);
          if (id === B.LANTERN || id === B.LANTERN + 1) {
            lanterns++;
            assert.ok(supported(id, v.x + dx, y, v.z + dz, at), `${v.name}: a lantern hangs or stands on something`);
          }
          if (id === B.DIRT_PATH) path++;
          if (id === B.FARMLAND + 1) farmland++;
          if (id >= B.WHEAT && id < B.WHEAT + 8) wheat++;
          if (id === B.GLASS_PANE) panes++;
          if (id === B.CRAFTING_TABLE) tables++;
          if (id >= B.FURNACE && id < B.FURNACE + 8) furnaces++;
          if (isBed(id)) beds++;
          if (isDoor(id) && !door(id).upper) doors++;
          if (id >= B.CHEST && id < B.CHEST + 4) chests++;
        }
    assert.ok(lanterns >= 16, `${v.name}: ${lanterns} lanterns`);
    assert.ok(path > 200, `${v.name}: ${path} path blocks`);
    assert.ok(farmland >= 140 && wheat === farmland, `${v.name}: ${farmland} moist farmland, ${wheat} wheat`);
    assert.ok(panes >= 25, `${v.name}: ${panes} windows`);
    assert.ok(tables >= 4 && furnaces >= 4, `${v.name}: ${tables} crafting tables, ${furnaces} furnaces`);
    assert.equal(beds, 10, `${v.name}: five beds`);
    assert.equal(doors, 5, `${v.name}: five doors`);
    assert.equal(chests, 5, `${v.name}: five chests`);
    // the square is level: the ground round the plaza at the plaza's height
    for (const [dx, dz] of [[-8, -8], [8, 8], [-8, 8], [8, -8]]) assert.ok(SOLID[at(v.x + dx, H, v.z + dz)] || at(v.x + dx, H, v.z + dz) === B.DIRT_PATH, `${v.name}: level ground at ${dx},${dz}`);
  }
});

test("each house: a working door, a bed, a chest; each villager: a job, a home inside and a doorstep to stand on", () => {
  for (const v of all.info.villages.list) {
    assert.equal(v.houses.length, 5);
    assert.deepEqual(v.villagers.map((d) => d.job).sort(), [0, 1, 2, 3, 4], `${v.name}: one of each job`);
    assert.equal(new Set(v.villagers.map((d) => d.name)).size, 5, `${v.name}: five names`);
    v.villagers.forEach((d, k) => assert.equal(d.id, villagerId(v.site, k)));
    const stand = ([x, y, z]: [number, number, number]) => (SOLID[at(x, y - 1, z)] === 1 || at(x, y - 1, z) === B.DIRT_PATH) && !SOLID[at(x, y, z)] && !SOLID[at(x, y + 1, z)];
    for (const h of v.houses) {
      const [dx, dy, dz] = h.door;
      assert.ok(isDoor(at(dx, dy, dz)) && !door(at(dx, dy, dz)).upper && isDoor(at(dx, dy + 1, dz)) && door(at(dx, dy + 1, dz)).upper, `${v.name} ${JOBS[h.job].key}: a two-high door`);
      assert.ok(isBed(at(h.bed[0], h.bed[1], h.bed[2])), `${v.name} ${JOBS[h.job].key}: a bed`);
      assert.ok(stand(h.inside), `${v.name} ${JOBS[h.job].key}: room to stand at home`);
      assert.ok(stand(h.work), `${v.name} ${JOBS[h.job].key}: room to stand at the door`);
      assert.ok(Math.hypot(h.inside[0] - h.door[0], h.inside[2] - h.door[2]) <= 5, "home is just inside the door");
      assert.ok(Math.hypot(h.work[0] - h.door[0], h.work[2] - h.door[2]) <= 2, "the doorstep is by the door");
    }
    assert.equal(v.chests.length, 2, `${v.name}: two loot chests`);
    for (const c of v.chests) assert.ok(at(c.x, c.y, c.z) >= B.CHEST && at(c.x, c.y, c.z) < B.CHEST + 4, "a loot chest is a chest");
    assert.deepEqual(v.chests.map((c) => c.kind).sort(), ["farmer", "smith"]);
  }
  // spawn is nowhere near
  for (const v of all.info.villages.list) assert.ok(Math.hypot(v.x - SPAWN_X, v.z - SPAWN_Z) > 110);
});
