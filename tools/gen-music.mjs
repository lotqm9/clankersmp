// Generates the game's background music: original calm solo-piano pieces made with ElevenLabs Music
// (POST /v1/music, force_instrumental). No game or composer is named in any prompt. Then encodes them for the web.
//   node tools/gen-music.mjs [rawDir]     (needs ELEVENLABS_API_KEY in C:/Users/vincu/wcm-config/.env; never printed)
// Raw MP3s -> rawDir (default .local/music-raw); finished files -> web/public/play/music/<name>.mp3 (+ tracks.json).
// Licence notes: LICENSES/elevenlabs-music.md.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = resolve(process.argv[2] ?? join(ROOT, ".local", "music-raw"));
const OUT = join(ROOT, "web", "public", "play", "music");
mkdirSync(RAW, { recursive: true });
mkdirSync(OUT, { recursive: true });

const env = readFileSync("C:/Users/vincu/wcm-config/.env", "utf8");
const KEY = (env.match(/^ELEVENLABS_API_KEY=(.+)$/m) ?? [])[1]?.trim().replace(/^["']|["']$/g, "");
if (!KEY) throw new Error("ELEVENLABS_API_KEY not found in wcm-config/.env");

const COMMON = "solo felt piano only, instrumental, no drums, no percussion, no vocals, no strings, soft and intimate, gentle sustain pedal, natural room reverb, calm and unhurried";
export const TRACKS = [
  ["meadow", "Meadow Morning", `Slow, gentle piano piece for a peaceful sunny morning in a wide green meadow. Warm, hopeful, sparse melody with long pauses between phrases. ${COMMON}`, 150000],
  ["lakeside", "Lakeside", `Dreamy, reflective piano piece for a quiet evening by a still lake. Slow arpeggios in a major key, a simple tender melody that drifts and rests. ${COMMON}`, 150000],
  ["island", "Little Island", `Curious and warm piano piece for exploring a small island, very slow tempo, open fifths in the left hand, a playful little melody that comes and goes. ${COMMON}`, 140000],
  ["starlight", "Starlight", `Night-time piano piece, slow and spacious, soft low notes with high twinkling notes far apart, calm and a little wistful, under a starry sky. ${COMMON}`, 150000],
];

async function generate(name, prompt, ms) {
  const raw = join(RAW, `${name}.mp3`);
  if (existsSync(raw)) return raw;
  const r = await fetch("https://api.elevenlabs.io/v1/music?output_format=mp3_44100_192", {
    method: "POST",
    headers: { "content-type": "application/json", "xi-api-key": KEY },
    body: JSON.stringify({ prompt, music_length_ms: ms, force_instrumental: true }),
  });
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  writeFileSync(raw, Buffer.from(await r.arrayBuffer()));
  console.log("generated", name, r.headers.get("song-id") ?? "");
  return raw;
}

const list = [];
for (const [name, title, prompt, ms] of TRACKS) {
  const raw = await generate(name, prompt, ms);
  const out = join(OUT, `${name}.mp3`);
  // Loudness -20 LUFS (quiet background), 2 s fade in, 4 s fade out, 128 kbps stereo MP3 (plays everywhere).
  const dur = Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", raw], { encoding: "utf8" }).stdout.trim());
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-i", raw,
    "-af", `loudnorm=I=-20:TP=-2:LRA=11,afade=t=in:st=0:d=2,afade=t=out:st=${Math.max(0, dur - 4).toFixed(2)}:d=4`,
    "-ar", "44100", "-ac", "2", "-c:a", "libmp3lame", "-b:a", "128k", out,
  ]);
  list.push({ file: `${name}.mp3`, title, seconds: Math.round(dur) });
  console.log("encoded", name, Math.round(dur), "s");
}
writeFileSync(join(OUT, "tracks.json"), JSON.stringify(list, null, 1) + "\n");
console.log("wrote tracks.json");
