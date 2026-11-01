// Night mobs (protocol v6) on synthetic worlds with the real AI, physics and darkness index: where they may appear
// (dark spots at night, deep caves by day, never in light, near the hub or within 24 blocks of anyone), Shamblers
// walking up and hitting once a second, Rattlers keeping their distance and shooting arrows (which stick in walls),
// Skitters climbing a wall to reach you, the sun burning the undead (not in shade or water), hits with knockback and
// half a second of invulnerability, deaths and drops, the safe zone (no targets in it, a mob inside vanishes), and
// despawning far from everyone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { B, EMIT } from "../shared/blocks.ts";
import { SPAWN_X, SPAWN_Z, VOLUME, WORLD_HEIGHT, WORLD_SIZE, idx } from "../shared/constants.ts";
import { SAFE_RADIUS } from "../shared/hub.ts";
import { I } from "../shared/items.ts";
import { MF, MOB, MOB_SPECS } from "../shared/mobs.ts";
import { LightIndex } from "../server/src/light.ts";
import { MobManager, STUCK_MAX, mobDrops, outsideHub, type Arrow, type Mob, type MobTarget } from "../server/src/mobs.ts";

const NIGHT = 18000;
const DAY = 6000;
const GROUND = 40; // top solid block

const world = new Uint8Array(VOLUME);
const get = (x: number, y: number, z: number) => (x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE || y < 0 || y >= WORLD_HEIGHT ? B.AIR : world[idx(x, y, z)]);

/** A flat world: stone up to GROUND - 1, grass on top, air above. */
function flat(): void {
  world.fill(0);
  for (let y = 0; y <= GROUND; y++) {
    const id = y === GROUND ? B.GRASS : y === 0 ? B.BEDROCK : B.STONE;
    world.fill(id, idx(0, y, 0), idx(0, y + 1, 0));
  }
}

function setup(): { mm: MobManager; light: LightIndex; hurts: { id: number; dmg: number; cause: string; dx: number; dz: number }[]; arrows: { a: Arrow; stuck: boolean }[]; died: Mob[] } {
  const light = new LightIndex(world);
  const mm = new MobManager(get, light);
  const hurts: { id: number; dmg: number; cause: string; dx: number; dz: number }[] = [];
  const arrows: { a: Arrow; stuck: boolean }[] = [];
  const died: Mob[] = [];
  mm.hooks.hurtPlayer = (id, dmg, cause, _fx, _fz, dx, dz) => hurts.push({ id, dmg, cause, dx, dz });
  mm.hooks.arrowEnded = (a, stuck) => arrows.push({ a: { ...a }, stuck });
  mm.hooks.died = (m) => died.push(m);
  return { mm, light, hurts, arrows, died };
}

const player = (x: number, z: number, y = GROUND + 1, valid = true): MobTarget => ({ id: 7, x, y, z, h: 1.8, eye: 1.62, valid });
const put = (light: LightIndex, x: number, y: number, z: number, id: number) => {
  const i = idx(x, y, z);
  const old = world[i];
  world[i] = id;
  light.changed(i, old, id);
};

// out in the "wild", well away from the hub at the centre of the world
const WX = 90;
const WZ = 90;

test("darkness index: torches light their surroundings, the sky map follows roofs (and both follow changes)", () => {
  flat();
  const { light } = setup();
  assert.equal(light.blockLight(WX, GROUND + 1, WZ), 0);
  put(light, WX, GROUND + 1, WZ, B.TORCH);
  assert.ok(EMIT[B.TORCH] >= 13, "a torch gives light");
  assert.equal(light.blockLight(WX + 5, GROUND + 1, WZ), EMIT[B.TORCH] - 5);
  assert.equal(light.blockLight(WX + 7, GROUND + 1, WZ + 7), 0, "Manhattan 14 from a torch is dark");
  put(light, WX, GROUND + 1, WZ, B.AIR);
  assert.equal(light.blockLight(WX + 5, GROUND + 1, WZ), 0, "the light goes with the torch");
  assert.ok(light.sky(WX, GROUND + 1, WZ));
  put(light, WX, GROUND + 6, WZ, B.STONE);
  assert.ok(!light.sky(WX, GROUND + 1, WZ) && light.sky(WX, GROUND + 7, WZ), "a roof shades what is under it");
  put(light, WX, GROUND + 6, WZ, B.AIR);
  assert.ok(light.sky(WX, GROUND + 1, WZ), "and the sky is back when it goes");
});

test("spawning: dark spots at night, 24-48 blocks from players, never in light or near the hub; nothing by day on an open surface", () => {
  flat();
  const { mm, light } = setup();
  // a ring of torches lights the ground east of the player
  for (let x = WX + 20; x <= WX + 60; x += 8) for (let z = WZ - 40; z <= WZ + 40; z += 8) put(light, x, GROUND + 1, z, B.TORCH);
  const p = player(WX + 0.5, WZ + 0.5);
  const seen: Mob[] = [];
  for (let k = 0; k < 400; k++) {
    mm.spawnTick([p], NIGHT);
    // look at each one, then clear them so the local cap (8 near a player) never stops the spawning
    for (const m of [...mm.mobs.values()]) {
      seen.push({ ...m });
      mm.remove(m.id);
    }
  }
  assert.ok(seen.length >= 30, `mobs appear at night (${seen.length})`);
  for (const m of seen) {
    const d = Math.hypot(m.x - p.x, m.z - p.z);
    assert.ok(d >= 23.5 && d <= 50, `24-48 blocks away (${d.toFixed(1)})`);
    assert.equal(light.blockLight(Math.floor(m.x), Math.floor(m.y), Math.floor(m.z)), 0, "never in light");
    assert.ok(outsideHub(m.x, m.z, 15.5), "never near the hub");
  }
  // by day the open surface stays empty
  const day = setup();
  for (let k = 0; k < 300; k++) day.mm.spawnTick([p], DAY);
  assert.equal(day.mm.stats.spawned, 0, "no surface spawns by day");
  // and nothing spawns near the hub even at night
  const hub = setup();
  const nearHub = player(SPAWN_X + SAFE_RADIUS + 2, SPAWN_Z + 0.5);
  for (let k = 0; k < 300; k++) hub.mm.spawnTick([nearHub], NIGHT);
  for (const m of hub.mm.mobs.values()) assert.ok(outsideHub(m.x, m.z, 15.5), "nothing within 16 blocks of the safe zone");
  // not around creative players or players in the safe zone
  const off = setup();
  for (let k = 0; k < 200; k++) off.mm.spawnTick([player(WX, WZ, GROUND + 1, false)], NIGHT);
  assert.equal(off.mm.stats.spawned, 0, "only around players out in the wild");
});

test("spawning by day: only on deep, roofed cave floors", () => {
  flat();
  const { mm, light } = setup();
  // a big roofed hall under the ground east of the player: floor y 20, hollow 20-23, rock above to the surface
  for (let x = WX + 15; x < WX + 60; x++)
    for (let z = WZ - 25; z < WZ + 25; z++)
      for (let y = 20; y < 24; y++) put(light, x, y, z, B.AIR);
  const p = player(WX + 0.5, WZ + 0.5, 21);
  for (let k = 0; k < 600; k++) mm.spawnTick([p], DAY);
  assert.ok(mm.mobs.size > 0, `the dark hall gets mobs by day (${mm.mobs.size})`);
  for (const m of mm.mobs.values()) {
    assert.ok(m.y >= 20 && m.y < 22, `only in the hall (y ${m.y})`);
    assert.ok(!light.sky(Math.floor(m.x), Math.floor(m.y), Math.floor(m.z)), "under a roof");
  }
});

test("a Shambler walks up to a player and hits once a second (1.5 hearts, pushed away from it)", () => {
  flat();
  const { mm, hurts } = setup();
  const m = mm.summon(MOB.SHAMBLER, WX + 8.5, GROUND + 1, WZ + 0.5)!;
  const p = player(WX + 0.5, WZ + 0.5);
  const at: number[] = [];
  for (let t = 0; t < 200; t++) {
    const n = hurts.length;
    mm.tick([p], NIGHT);
    if (hurts.length > n) at.push(t);
  }
  assert.ok(m.flags & MF.AGGRO, "it has a target");
  assert.ok(hurts.length >= 4, `it hits (${hurts.length} times)`);
  assert.ok(hurts.every((h) => h.dmg === MOB_SPECS[MOB.SHAMBLER].damage && h.cause === "mob:shambler"));
  for (let k = 1; k < at.length; k++) assert.ok(at[k] - at[k - 1] >= 20, "at most once a second");
  assert.ok(hurts[0].dx < -0.5, "the knockback points away from it (it came from +x)");
});

test("nobody in the safe zone (or in creative) is hunted; a mob that ends up in the zone vanishes", () => {
  flat();
  const { mm, hurts } = setup();
  const edge = SPAWN_X + SAFE_RADIUS + 3;
  mm.summon(MOB.SHAMBLER, edge + 0.5, GROUND + 1, SPAWN_Z + 0.5);
  const inside = player(SPAWN_X + SAFE_RADIUS - 2, SPAWN_Z + 0.5, GROUND + 1, false);
  for (let t = 0; t < 200; t++) mm.tick([inside], NIGHT);
  assert.equal(hurts.length, 0, "no hits on a player in the safe zone");
  const m = [...mm.mobs.values()][0];
  assert.ok(m && outsideHub(m.x, m.z, 0), "it stays outside");
  m.x = SPAWN_X + 10;
  m.z = SPAWN_Z;
  mm.tick([inside], NIGHT);
  assert.equal(mm.mobs.size, 0, "a mob inside the zone is gone");
});

test("a Rattler keeps its distance and shoots: arrows hit a player in the open and stick in a wall", () => {
  flat();
  const { mm, hurts, arrows } = setup();
  const r = mm.summon(MOB.RATTLER, WX + 12.5, GROUND + 1, WZ + 0.5)!;
  const p = player(WX + 0.5, WZ + 0.5);
  let closest = Infinity;
  for (let t = 0; t < 300; t++) {
    mm.tick([p], NIGHT);
    closest = Math.min(closest, Math.hypot(r.x - p.x, r.z - p.z));
  }
  assert.ok(mm.stats.shots >= 4, `it shoots (${mm.stats.shots} arrows)`);
  assert.ok(hurts.some((h) => h.cause === "mob:rattler" && h.dmg >= 2), "arrows hurt (2+ damage)");
  assert.ok(closest > 3, `it keeps some distance (${closest.toFixed(1)})`);
  assert.ok(arrows.length > 0, "the arrows land somewhere");
  // a wall between them: a shot sticks in it, nobody is hit
  const { mm: mm2, hurts: h2, arrows: a2 } = setup();
  for (let y = GROUND + 1; y < GROUND + 6; y++) for (let z = WZ - 3; z <= WZ + 3; z++) world[idx(WX + 5, y, z)] = B.STONE;
  const r2 = mm2.summon(MOB.RATTLER, WX + 12.5, GROUND + 1, WZ + 0.5)!;
  (mm2 as unknown as { shoot: (m: Mob, t: MobTarget) => void }).shoot(r2, p);
  for (let t = 0; t < 40; t++) mm2.tick([player(WX + 0.5, WZ + 40.5)], NIGHT);
  assert.equal(h2.length, 0, "no hits through the wall");
  assert.ok(a2.length === 1 && a2[0].stuck, "the arrow sticks in the wall");
  assert.ok(Math.abs(a2[0].a.x - (WX + 6)) < 0.3, `on the wall's face (x ${a2[0].a.x.toFixed(2)})`);
});

test("a Skitter climbs a wall to reach a player on top of it", () => {
  flat();
  const { mm, hurts } = setup();
  // a 6-high tower the player stands on (3 x 3), the Skitter below: no jump gets up there
  for (let x = WX - 1; x <= WX + 1; x++) for (let z = WZ - 1; z <= WZ + 1; z++) for (let y = GROUND + 1; y <= GROUND + 6; y++) world[idx(x, y, z)] = B.STONE;
  const p = player(WX + 0.5, WZ + 0.5, GROUND + 7);
  const s = mm.summon(MOB.SKITTER, WX + 6.5, GROUND + 1, WZ + 0.5)!;
  let top = s.y;
  let climbed = false;
  for (let t = 0; t < 400 && !hurts.length; t++) {
    mm.tick([p], NIGHT);
    top = Math.max(top, s.y);
    if (s.flags & MF.CLIMB) climbed = true;
  }
  assert.ok(climbed, "it climbs (the CLIMB flag)");
  assert.ok(top >= GROUND + 4.5, `it gets up the wall (${top.toFixed(2)})`);
  assert.ok(hurts.length > 0 && hurts[0].cause === "mob:skitter", "and bites");
});

test("the sun burns Shamblers and Rattlers in the open; shade saves them; Skitters don't burn", () => {
  flat();
  const { mm, died } = setup();
  const sh = mm.summon(MOB.SHAMBLER, WX + 0.5, GROUND + 1, WZ + 0.5)!;
  const ra = mm.summon(MOB.RATTLER, WX + 4.5, GROUND + 1, WZ + 0.5)!;
  const sk = mm.summon(MOB.SKITTER, WX + 8.5, GROUND + 1, WZ + 4.5)!;
  // a roof over a fourth one
  for (let x = WX - 2; x <= WX + 2; x++) for (let z = WZ + 8; z <= WZ + 12; z++) world[idx(x, GROUND + 4, z)] = B.STONE;
  const { mm: m2, light: l2 } = setup();
  void l2;
  const shaded = m2.summon(MOB.SHAMBLER, WX + 0.5, GROUND + 1, WZ + 10.5)!;
  const far = player(WX + 20, WZ + 20);
  let burning = false;
  for (let t = 0; t < 520; t++) {
    mm.tick([far], DAY);
    m2.tick([far], DAY);
    if (sh.flags & MF.BURN) burning = true;
    shaded.x = WX + 0.5; // keep it under the roof
    shaded.z = WZ + 10.5;
  }
  assert.ok(burning, "it catches fire (the BURN flag)");
  assert.ok(died.includes(sh) && died.includes(ra), "both undead burn to death within ~25 s");
  assert.ok(!died.includes(sk) && sk.hp === MOB_SPECS[MOB.SKITTER].hp, "the Skitter is fine");
  assert.equal(shaded.hp, MOB_SPECS[MOB.SHAMBLER].hp, "shade saves it");
});

test("hits: knockback, half a second where only a harder hit gets through, death and drops", () => {
  flat();
  const { mm, died } = setup();
  const m = mm.summon(MOB.SHAMBLER, WX + 0.5, GROUND + 1, WZ + 0.5)!;
  for (let t = 0; t < 5; t++) mm.tick([player(WX + 30, WZ)], NIGHT);
  const hp0 = m.hp;
  const r1 = mm.damage(m, 6, { x: WX - 2, z: WZ + 0.5, kb: 0.4, player: 7 });
  assert.ok(r1.dealt > 0 && r1.dealt < 6, "its natural armour (2) softens the blow a little");
  assert.ok(m.vx > 0.3, "knocked back away from the attacker");
  assert.equal(m.target, 7, "and it turns on the attacker");
  assert.equal(mm.damage(m, 4, { x: WX - 2, z: WZ, kb: 0.4, player: 7 }).dealt, 0, "a weaker hit right after does nothing");
  const r3 = mm.damage(m, 9, { x: WX - 2, z: WZ, kb: 0.4, player: 7 });
  assert.ok(r3.dealt > 0 && r3.dealt <= 3, `a harder one gets through for the difference (${r3.dealt.toFixed(2)})`);
  assert.ok(Math.abs(m.hp - (hp0 - r1.dealt - r3.dealt)) < 1e-9);
  for (let k = 0; k < 12; k++) mm.tick([player(WX + 30, WZ)], NIGHT);
  const r4 = mm.damage(m, 100, { x: WX - 2, z: WZ, kb: 0.4, player: 7 });
  assert.ok(r4.killed && died.length === 1 && m.dying > 0, "it dies (a short tip-over)");
  assert.equal(mm.damage(m, 5, null).dealt, 0, "nothing more while dying");
  for (let k = 0; k < 25; k++) mm.tick([player(WX + 30, WZ)], NIGHT);
  assert.ok(!mm.mobs.has(m.id), "then it's gone");
  // drops
  const seq = [0.99, 0.0];
  let k = 0;
  const r = () => seq[k++ % seq.length];
  assert.deepEqual(mobDrops(MOB.SHAMBLER, true, r).map((s) => s.id), [I.SPOILED_FLESH, I.IRON_INGOT]);
  assert.deepEqual(mobDrops(MOB.RATTLER, false, () => 0.99).map((s) => [s.id, s.n]), [[I.BONE, 2], [I.ARROW, 2]]); // v7: arrows too
  assert.deepEqual(mobDrops(MOB.SKITTER, false, () => 0.99).map((s) => [s.id, s.n]), [[I.STRING, 2]]);
});

test("they go away far from everyone: at once beyond 96 blocks", () => {
  flat();
  const { mm } = setup();
  mm.summon(MOB.SHAMBLER, WX + 0.5, GROUND + 1, WZ + 0.5);
  mm.tick([player(WX + 50, WZ)], NIGHT);
  assert.equal(mm.mobs.size, 1, "still here with someone 50 blocks away");
  mm.tick([player(WX + 120, WZ)], NIGHT);
  assert.equal(mm.mobs.size, 0, "gone with nobody within 96");
});

test("v7: players' arrows stuck in the ground are capped per shard: past the cap the oldest goes first", () => {
  flat();
  const { mm } = setup();
  const gone: number[] = [];
  mm.hooks.arrowGone = (st, by) => {
    if (by === 0) gone.push(st.id);
  };
  const ids: number[] = [];
  for (let k = 0; k < STUCK_MAX + 5; k++) {
    const x = WX + 0.5 + (k % 20) * 0.4;
    const z = WZ + 0.5 + Math.floor(k / 20) * 0.4;
    ids.push(mm.shootPlayerArrow(1, x, GROUND + 3, z, 0, -1.5, 0, false, true).id);
  }
  for (let t = 0; t < 10; t++) mm.tick([], DAY);
  assert.equal(mm.stuck.size, STUCK_MAX, `at most ${STUCK_MAX} stuck (${mm.stuck.size})`);
  assert.deepEqual(gone, ids.slice(0, 5), "the five oldest went");
  assert.ok(ids.slice(5).every((id) => mm.stuck.has(id)), "the newest stay");
});
