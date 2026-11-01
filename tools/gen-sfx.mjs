// Generates the animal, survival, (v6) night-mob and combat, (v7) farming, bucket and drink, (v8) chime, oar, boat,
// (update 10.1) damage and (update 11) villager and trading sounds with ElevenLabs Sound Effects (original audio, our
// paid plan: royalty free, commercial use allowed, no attribution required), then trims, normalises and encodes them
// to OGG for the game.
//   node tools/gen-sfx.mjs [rawDir]      (needs ELEVENLABS_API_KEY in C:/Users/vincu/wcm-config/.env; never printed)
// Raw MP3s go to rawDir (default: .local/sfx-raw); finished files to web/public/play/sounds/<name>.ogg.
// A sound with `takes` is generated several times (rawDir/takes/<name>_tN.mp3, with an OGG preview beside each);
// the take named in PICKS becomes the sound. Until a pick is set, only the takes are made.
// Prompts and settings are recorded in LICENSES/elevenlabs-sounds.md.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = resolve(process.argv[2] ?? join(ROOT, ".local", "sfx-raw"));
const OUT = join(ROOT, "web", "public", "play", "sounds");
mkdirSync(RAW, { recursive: true });

const env = readFileSync("C:/Users/vincu/wcm-config/.env", "utf8");
const KEY = (env.match(/^ELEVENLABS_API_KEY=(.+)$/m) ?? [])[1]?.trim().replace(/^["']|["']$/g, "");
if (!KEY) throw new Error("ELEVENLABS_API_KEY not found in wcm-config/.env");

const DRY = "close up, dry, isolated, no background noise, no music, no reverb";
/** Update 10.1: the chosen take for each damage sound (see LOG.md for how they were picked). */
const PICKS = { hurt_0: 0, hit_0: 0, attack_crit_0: 2, pig_hurt_0: 2, cow_hurt_0: 1, sheep_hurt_0: 1, chicken_hurt_0: 0, shambler_hurt_0: 1, rattler_hurt_0: 1, skitter_hurt_0: 3 };
/** A damage sound: `per` takes of each prompt (0.5 s, the shortest ElevenLabs makes); the picked one is kept. */
function damage(name, max, prompts, per = 2) {
  const takes = prompts.flatMap((text) => Array.from({ length: per }, () => text));
  return [name, takes[PICKS[name] ?? 0], 0.5, { takes, pick: PICKS[name], max }];
}
export const SOUNDS = [
  ["pig_say_0", `A single short pig grunt, a soft low oink, ${DRY}`, 0.8],
  ["pig_say_1", `A pig snorting twice, short and friendly, ${DRY}`, 0.9],
  ["pig_say_2", `One quick curious pig oink, ${DRY}`, 0.7],
  ["cow_say_0", `A single calm cow moo, ${DRY}`, 1.6],
  ["cow_say_1", `A cow mooing once, low and gentle, ${DRY}`, 1.8],
  ["cow_say_2", `A short cow moo, ${DRY}`, 1.2],
  ["sheep_say_0", `A single sheep bleat, baa, ${DRY}`, 1.0],
  ["sheep_say_1", `A lamb bleating once, soft, ${DRY}`, 0.9],
  ["sheep_say_2", `One sheep baa, slightly wobbly, ${DRY}`, 1.1],
  ["chicken_say_0", `A hen clucking softly, three short clucks, ${DRY}`, 1.0],
  ["chicken_say_1", `A chicken making a quiet bawk, ${DRY}`, 0.8],
  ["chicken_say_2", `Two soft hen clucks, ${DRY}`, 0.7],
  // survival (v5)
  ["pickup_0", `A tiny soft pop, like a small cork, very short and light, ${DRY}`, 0.5],
  ["pickup_1", `A tiny bright pop, very short, ${DRY}`, 0.5],
  ["pickup_2", `A soft little pluck sound, very short, ${DRY}`, 0.5],
  ["eat_0", `One crunchy bite of a fresh apple, ${DRY}`, 0.5],
  ["eat_1", `A person chewing once, crunchy, ${DRY}`, 0.5],
  ["eat_2", `A quick bite into crisp food, ${DRY}`, 0.5],
  ["burp_0", `A small polite burp, short and funny, ${DRY}`, 0.6],
  ["tool_break_0", `A small wooden tool handle snapping with a light metal clink, ${DRY}`, 0.6],
  ["chest_open_0", `An old wooden chest lid creaking open, short, ${DRY}`, 0.8],
  ["chest_close_0", `A wooden chest lid closing with a soft thud, ${DRY}`, 0.6],
  // night mobs and combat (v6): a weary groaning walker, a rattling bone archer, a chittering crawler
  ["shambler_say_0", `A low raspy groan of a weary creature, slow and hollow, ${DRY}`, 1.4],
  ["shambler_say_1", `A tired wheezing moan, low and breathy, ${DRY}`, 1.5],
  ["shambler_say_2", `A short low gurgling groan, ${DRY}`, 1.1],
  ["shambler_death_0", `A long fading raspy groan ending in a soft thud on the ground, ${DRY}`, 1.4],
  ["rattler_say_0", `Dry bones rattling lightly, a short clatter of small hollow sticks, ${DRY}`, 0.8],
  ["rattler_say_1", `A brief dry wooden clacking, like hollow bones tapping, ${DRY}`, 0.7],
  ["rattler_say_2", `A soft rattle of dry bones shifting, ${DRY}`, 0.9],
  ["rattler_death_0", `A heap of dry bones clattering down onto the ground, ${DRY}`, 1.1],
  ["skitter_say_0", `A soft rapid clicking chitter of a large insect, ${DRY}`, 0.9],
  ["skitter_say_1", `A low insect hiss with tiny clicks, ${DRY}`, 0.9],
  ["skitter_say_2", `Quick skittering clicks of many small legs, ${DRY}`, 0.8],
  ["skitter_death_0", `A fading insect hiss and a few slowing clicks, then silence, ${DRY}`, 1.0],
  ["bow_shoot_0", `A wooden bow releasing an arrow: a taut string twang and a quick whoosh, ${DRY}`, 0.7],
  ["bow_shoot_1", `A short bowstring snap with a fast arrow swish, ${DRY}`, 0.6],
  ["arrow_hit_0", `An arrow striking wood with a short solid thunk, ${DRY}`, 0.5],
  ["arrow_hit_1", `An arrow thudding into packed earth, short, ${DRY}`, 0.5],
  ["armor_equip_0", `Metal armor plates clinking as someone straps on a breastplate, ${DRY}`, 0.8],
  ["armor_equip_1", `Leather and chain armor shifting into place with a soft jingle, ${DRY}`, 0.8],
  // farming, buckets and drinks (v7)
  ["till_0", `A garden hoe scraping and turning loose soil once, a short crumbly scrape, ${DRY}`, 0.6],
  ["till_1", `A quick hoe stroke into soft dirt, earthy and brief, ${DRY}`, 0.6],
  ["bucket_fill_0", `A metal pail scooping up water, a short slosh and splash, ${DRY}`, 0.8],
  ["bucket_fill_1", `Water pouring into a tin bucket for a moment, ${DRY}`, 0.8],
  ["bucket_empty_0", `Water tipped out of a metal bucket onto the ground, a short splash, ${DRY}`, 0.8],
  ["bucket_empty_1", `A quick pour of water from a pail with a splash, ${DRY}`, 0.8],
  ["drink_0", `A person taking two quick gulps of a drink, ${DRY}`, 0.6],
  ["drink_1", `A single swallow of a cold drink, ${DRY}`, 0.5],
  // world update (v8): the village chime, boats and oars
  ["chime_0", `Three small brass tube wind chimes struck once by a wooden clapper, bright warm ringing that fades out, no wind, ${DRY}`, 2.5],
  ["chime_1", `A short cluster of tuned brass tube chimes ringing together once, gentle and clear, fading, ${DRY}`, 2.5],
  ["paddle_0", `One wooden oar stroke pulling through calm water, a soft swish and drip, ${DRY}`, 0.8],
  ["paddle_1", `A single paddle dipping into a lake and pulling back, gentle water swirl, ${DRY}`, 0.8],
  ["paddle_2", `A rowing oar sweep through water, one quiet stroke, ${DRY}`, 0.8],
  ["splash_0", `A small wooden rowboat set down on water, a light splash and a hollow wooden knock, ${DRY}`, 0.9],
  ["boat_break_0", `A small wooden boat breaking apart, thin planks cracking and clattering down, short, ${DRY}`, 0.9],
  // villages (update 11): villagers whistle (not speech, not another game's villager sounds), and rubies clink
  ["villager_say_0", `A person whistling a short cheerful three-note tune, soft and friendly, ${DRY}`, 1.2],
  ["villager_say_1", `A short happy two-note whistle, like greeting a neighbour, ${DRY}`, 0.9],
  ["villager_say_2", `A soft absent-minded little whistle that rises and falls, ${DRY}`, 1.2],
  ["villager_yes_0", `A bright rising two-note whistle of approval, short and cheerful, ${DRY}`, 0.7],
  ["villager_no_0", `A short falling two-note whistle of disappointment, soft, ${DRY}`, 0.7],
  ["villager_hurt_0", `A short startled breathy gasp of a surprised person, no words, ${DRY}`, 0.5],
  ["villager_hurt_1", `A quick surprised little "oh" exhale, no words, ${DRY}`, 0.5],
  ["trade_0", `A few small gemstones clinking together in a palm, a short bright sparkle of clinks, ${DRY}`, 0.8],
  // damage (update 10.1, Laith: punchier hurts and hits). Each is the best of several takes (two prompts, two or
  // three takes each), cut to `max` seconds with a short fade; the game plays them at a random pitch of 0.8-1.2.
  damage("hurt_0", 0.26, [
    `A short punchy comic "oof" grunt from a man being bumped in the belly, one low quick syllable, ${DRY}`,
    `A quick low cartoonish "uh" grunt of a man taking a hit, punchy and very short, ${DRY}`,
  ], 3),
  damage("hit_0", 0.25, [
    `A crisp punchy hit thud, a fist striking a firm leather punching bag, tight and short, no swoosh, ${DRY}`,
    `A short solid smack of a blow landing on a body, crisp, ${DRY}`,
  ]),
  damage("attack_crit_0", 0.32, [
    `A sharp hard critical hit, a crisp snapping smack with a bright cracking edge, very short, ${DRY}`,
    `A sharp crisp whip crack layered on a solid punch impact, very short, ${DRY}`,
  ]),
  damage("pig_hurt_0", 0.45, [
    `A soft short startled pig squeal, gentle, not loud, ${DRY}`,
    `A small hurt pig grunt with a little squeak, soft and short, ${DRY}`,
  ]),
  damage("cow_hurt_0", 0.5, [
    `A soft short hurt cow grunt, a low brief moo of surprise, gentle, ${DRY}`,
    `A short gentle startled cow moo-grunt, low and soft, ${DRY}`,
  ]),
  damage("sheep_hurt_0", 0.45, [
    `A soft short startled sheep bleat, gentle and quick, ${DRY}`,
    `A small hurt lamb bleat, soft and brief, ${DRY}`,
  ]),
  damage("chicken_hurt_0", 0.4, [
    `A soft short startled hen squawk, one quick note, ${DRY}`,
    `A small surprised chicken squawk, gentle and brief, ${DRY}`,
  ]),
  damage("shambler_hurt_0", 0.5, [
    `A short hoarse hollow grunt of pain from a weary groaning creature, ${DRY}`,
    `A quick raspy choked grunt of a tired creature being hit, ${DRY}`,
  ]),
  damage("rattler_hurt_0", 0.4, [
    `A quick dry clack of hollow bones knocking together from a hit, ${DRY}`,
    `A short sharp rattle and crack of dry bones jolted by a blow, ${DRY}`,
  ]),
  damage("skitter_hurt_0", 0.45, [
    `A short sharp angry insect hiss with a squeak, ${DRY}`,
    `A quick shrill chittering squeal of a big insect being hit, ${DRY}`,
  ]),
];

async function generate(raw, name, text, seconds) {
  if (existsSync(raw)) return raw;
  const r = await fetch("https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128", {
    method: "POST",
    headers: { "content-type": "application/json", "xi-api-key": KEY },
    body: JSON.stringify({ text, duration_seconds: seconds, prompt_influence: 0.55, model_id: "eleven_text_to_sound_v2" }),
  });
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  writeFileSync(raw, Buffer.from(await r.arrayBuffer()));
  console.log("generated", name);
  return raw;
}

// Trim leading/trailing silence, cut to `max` seconds with a 40 ms fade (damage sounds), mono 44.1 kHz,
// peak-normalise to -6 dBFS (lossy overshoot stays under 0 dBFS), OGG Vorbis.
function encode(raw, out, max) {
  const trim = "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.02,areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.06,areverse";
  const cut = max ? `,asetpts=N/SR/TB,atrim=end=${max},afade=t=out:st=${(max - 0.04).toFixed(3)}:d=0.04` : "";
  const det = spawnSync("ffmpeg", ["-hide_banner", "-i", raw, "-af", `${trim}${cut},volumedetect`, "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const peak = Number((det.match(/max_volume: (-?[\d.]+) dB/) ?? [])[1] ?? 0);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-af", `${trim}${cut},volume=${(-6 - peak).toFixed(1)}dB`, "-ac", "1", "-ar", "44100", "-c:a", "libvorbis", "-q:a", "4", out]);
}

const TAKES = join(RAW, "takes");
for (const [name, text, seconds, opt] of SOUNDS) {
  const raw = join(RAW, `${name}.mp3`);
  if (opt?.takes) {
    mkdirSync(TAKES, { recursive: true });
    for (let i = 0; i < opt.takes.length; i++) {
      const t = await generate(join(TAKES, `${name}_t${i}.mp3`), `${name} take ${i}`, opt.takes[i], seconds);
      const preview = join(TAKES, `${name}_t${i}.ogg`);
      if (!existsSync(preview)) encode(t, preview, opt.max);
    }
    if (opt.pick === undefined) {
      console.log("takes ready (no pick yet):", name);
      continue;
    }
    copyFileSync(join(TAKES, `${name}_t${opt.pick}.mp3`), raw);
  } else await generate(raw, name, text, seconds);
  const out = join(OUT, `${name}.ogg`);
  // only when the raw file is newer (an OGG encode differs byte for byte each time: its stream serial is random);
  // delete an .ogg to encode it again
  if (existsSync(out) && statSync(out).mtimeMs >= statSync(raw).mtimeMs) continue;
  encode(raw, out, opt?.max);
  console.log("encoded", out.replace(ROOT, "."));
}
