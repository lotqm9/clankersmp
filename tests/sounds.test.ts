// The game's sounds (update 10.1): every file the client loads is there and nothing unused ships; the new damage
// sounds (your "oof", the hit thud, the critical hit, the animals' and night mobs' hurts) are short, normalised, play
// at the classic random pitch of 0.8-1.2 and are wired to the right events; each is one picked take, with its licence
// note. With SITE_DIR set (the bundle check, e.g. SITE_DIR=../steve, the built $STEVE site) the same is checked on the built site, and its
// game bundle must use the new names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DAMAGE_PITCH, Sound, soundFiles } from "../client/src/audio.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = process.env.SITE_DIR ? resolve(ROOT, process.env.SITE_DIR) : null;
const DIR = SITE ? join(SITE, "play", "sounds") : join(ROOT, "web", "public", "play", "sounds");

/** The damage sounds and the longest each may be (seconds). */
const DAMAGE: Record<string, number> = {
  hurt_0: 0.3,
  hit_0: 0.25,
  attack_crit_0: 0.32,
  pig_hurt_0: 0.45,
  cow_hurt_0: 0.5,
  sheep_hurt_0: 0.45,
  chicken_hurt_0: 0.4,
  shambler_hurt_0: 0.5,
  rattler_hurt_0: 0.4,
  skitter_hurt_0: 0.45,
};

test(`every sound the game loads is in ${SITE ? "the built site" : "web/public"}, and nothing else ships`, () => {
  const want = new Set(soundFiles());
  const have = new Set(readdirSync(DIR).filter((f) => f.endsWith(".ogg")).map((f) => f.slice(0, -4)));
  assert.deepEqual([...want].filter((n) => !have.has(n)), [], "missing");
  assert.deepEqual([...have].filter((n) => !want.has(n)), [], "shipped but never loaded");
  for (const n of Object.keys(DAMAGE)) assert.ok(want.has(n), `${n} is loaded`);
  for (const old of ["hurt_1", "hurt_2", "attack_strong_0", "attack_weak_0", "pig_hurt_1", "rattler_hurt_1"]) assert.ok(!have.has(old), `${old} (replaced in 10.1) is gone`);
});

test("the damage sounds are short, mono and peak-normalised", () => {
  for (const [name, max] of Object.entries(DAMAGE)) {
    const f = join(DIR, `${name}.ogg`);
    const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=channels,sample_rate", "-of", "json", f], { encoding: "utf8" });
    const j = JSON.parse(probe);
    const dur = Number(j.format.duration);
    assert.ok(dur > 0.05 && dur <= max + 0.005, `${name}: ${dur.toFixed(3)} s (at most ${max})`);
    assert.equal(j.streams[0].channels, 1, `${name} is mono`);
    const det = spawnSync("ffmpeg", ["-hide_banner", "-i", f, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr;
    const peak = Number((det.match(/max_volume: (-?[\d.]+) dB/) ?? [])[1]);
    assert.ok(peak > -10 && peak < -0.5, `${name} peaks at ${peak} dB (normalised, never clipping)`);
  }
  // the player's "oof" is under 0.3 s
  const oof = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", join(DIR, "hurt_0.ogg")], { encoding: "utf8" }));
  assert.ok(oof < 0.3, `hurt_0 is ${oof.toFixed(3)} s`);
});

test("damage sounds play at a random pitch of 0.8-1.2, wired to the right sound for each event", () => {
  const s = new Sound();
  const plays: { name: string; vol: number; pitch: number }[] = [];
  s.play = (name: string, vol: number, pitch: number) => {
    plays.push({ name, vol, pitch });
  };
  const at = { x: 0, y: 0, z: 0 };
  const events: [string, () => void, string][] = [
    ["you are hurt", () => s.hurt(), "hurt"],
    ["your charged hit lands", () => s.attack("strong"), "hit"],
    ["your weak hit lands", () => s.attack("weak"), "hit"],
    ["your critical hit lands", () => s.attack("crit"), "attack_crit"],
    ...["pig", "cow", "sheep", "chicken"].map((a): [string, () => void, string] => [`a ${a} is hurt`, () => s.animal(a, "hurt", at), `${a}_hurt`]),
    ...["shambler", "rattler", "skitter"].map((m): [string, () => void, string] => [`a ${m} is hurt`, () => s.mob(m, "hurt", at), `${m}_hurt`]),
  ];
  assert.deepEqual(DAMAGE_PITCH, [0.8, 1.2]);
  for (const [what, fire, name] of events) {
    plays.length = 0;
    for (let k = 0; k < 400; k++) fire();
    assert.ok(plays.every((p) => p.name === name), `${what}: plays ${name}`);
    const lo = Math.min(...plays.map((p) => p.pitch));
    const hi = Math.max(...plays.map((p) => p.pitch));
    assert.ok(lo >= 0.8 && hi <= 1.2 && lo < 0.83 && hi > 1.17, `${what}: pitch ${lo.toFixed(3)}-${hi.toFixed(3)}`);
  }
  plays.length = 0;
  s.attack("strong");
  s.attack("weak");
  assert.ok(plays[1].vol < plays[0].vol, "a weak hit is quieter");
  // the animals' and mobs' calls keep their own pitch ranges (only their hurts changed)
  plays.length = 0;
  for (let k = 0; k < 200; k++) s.animal("cow", "say", at);
  assert.ok(plays.every((p) => p.name === "cow_say" && p.pitch >= 0.9 && p.pitch <= 1.05));
});

test("each damage sound is a picked take, with its prompt and licence note", () => {
  const gen = readFileSync(join(ROOT, "tools", "gen-sfx.mjs"), "utf8");
  const picks = gen.match(/const PICKS = (\{[^}]*\});/);
  assert.ok(picks, "PICKS in tools/gen-sfx.mjs");
  const p = JSON.parse(picks[1].replace(/([a-z_0-9]+):/g, '"$1":').replace(/,\s*\}/, "}"));
  for (const n of Object.keys(DAMAGE)) {
    assert.ok(Number.isInteger(p[n]), `${n} has a picked take`);
    assert.ok(gen.includes(`damage("${n}"`), `${n} has its prompts in gen-sfx.mjs`);
  }
  const lic = readFileSync(join(ROOT, "LICENSES", "elevenlabs-sounds.md"), "utf8");
  assert.match(lic, /update 10\.1/i);
  for (const n of ["hurt_0", "hit_0", "attack_crit_0"]) assert.ok(lic.includes(n), `${n} in the licence note`);
  assert.ok(lic.includes("Mojang") || lic.includes("not taken from any game"), "says they are not another game's sounds");
});

test("the built game bundle uses the new sound names", { skip: !SITE }, () => {
  const assets = join(SITE!, "play", "assets");
  const js = readdirSync(assets).filter((f) => /^index-.*\.js$/.test(f));
  assert.ok(js.length > 0, "a play bundle");
  const code = js.map((f) => readFileSync(join(assets, f), "utf8")).join("\n");
  assert.ok(code.includes('"attack_crit"') && code.includes('"hit"'), "the bundle plays hit and attack_crit");
  assert.ok(!code.includes("attack_strong") && !code.includes("attack_weak"), "the old hit sounds are gone from the bundle");
});
