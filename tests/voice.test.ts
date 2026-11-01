// Proximity voice (protocol v11, update 13): the wire format, the fallback codec, and the server's relay: only
// listeners in range get a voice, at most the 8 closest, never a muted one or one they can't decode; nothing when the
// speaker's voice is off or an admin muted it, or the server's kill switch is on; frames past the rate or size caps
// are dropped; who is talking goes to everyone; a slow client skips voice rather than queue it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADPCM_RATE, OP_VOICE, VOICE_CODEC, VOICE_MAX_PAYLOAD, VOICE_MAX_STREAMS, VOICE_RANGE, VOICE_RATE, adpcmDecode, adpcmEncode, adpcmSamples, decodeVoice,
  decodeVoiceUp, downsample, encodeVoice, encodeVoiceUp, upsample,
} from "../shared/voice.ts";
import { VoiceRelay, newVoiceState, type VoicePeer } from "../server/src/voice.ts";

test("the wire: a speaker's frame up, a listener's batch down", () => {
  const up = new Uint8Array(encodeVoiceUp(VOICE_CODEC.OPUS, 65537, new Uint8Array([1, 2, 3, 250])));
  assert.deepEqual(decodeVoiceUp(up), { codec: 1, seq: 1, data: new Uint8Array([1, 2, 3, 250]) });
  assert.equal(decodeVoiceUp(new Uint8Array([31, 9, 0, 0, 1])), null, "an unknown codec");
  assert.equal(decodeVoiceUp(new Uint8Array([31, 1, 0, 0])), null, "no payload");
  const down = encodeVoice([
    { speaker: 7, codec: 1, seq: 3, data: new Uint8Array([9, 9]) },
    { speaker: 300, codec: 2, seq: 65535, data: new Uint8Array(120).fill(5) },
  ]);
  assert.equal(down[0], OP_VOICE);
  assert.equal(down.length, 2 + 7 + 2 + 7 + 120, "7 bytes of header a frame");
  const back = decodeVoice(new DataView(down.buffer));
  assert.equal(back.length, 2);
  assert.deepEqual([back[0].speaker, back[0].codec, back[0].seq, [...back[0].data]], [7, 1, 3, [9, 9]]);
  assert.deepEqual([back[1].speaker, back[1].codec, back[1].seq, back[1].data.length], [300, 2, 65535, 120]);
  assert.equal(decodeVoice(new DataView(down.buffer, 0, down.length - 1)).length, 1, "a cut message: the whole frames only");
});

test("the fallback codec: 40 ms of speech-band audio in 123 bytes (24 kbps), clearly the same sound back", () => {
  const rate = 48000;
  const input = new Float32Array(1920); // 40 ms
  for (let i = 0; i < input.length; i++) input[i] = 0.4 * Math.sin((2 * Math.PI * 300 * i) / rate) + 0.2 * Math.sin((2 * Math.PI * 900 * i) / rate);
  const low = downsample(input, rate);
  assert.equal(low.length, 240, "6 kHz");
  const packed = adpcmEncode(low);
  assert.equal(packed.length, 123);
  assert.ok((packed.length * 8) / 0.04 <= 24600, `${(packed.length * 8) / 40} kbps`);
  const back = adpcmDecode(packed, adpcmSamples(packed));
  assert.equal(back.length, 240);
  let sig = 0;
  let err = 0;
  for (let i = 0; i < low.length; i++) {
    sig += low[i] ** 2;
    err += (low[i] - back[i]) ** 2;
  }
  const snr = 10 * Math.log10(sig / err);
  assert.ok(snr > 18, `SNR ${snr.toFixed(1)} dB`);
  const up = upsample(back, rate);
  assert.equal(up.length, 1920, "back to 48 kHz for playback");
  assert.ok(Math.abs(Math.max(...up) - Math.max(...input)) < 0.05, `the same loudness (${Math.max(...up).toFixed(3)} for ${Math.max(...input).toFixed(3)})`);
  assert.equal(ADPCM_RATE, 6000);
});

test("the fallback codec carries its step size from frame to frame (in each header): loud speech holds up past a frame's start", () => {
  const st = { index: 20 };
  let sig = 0;
  let err = 0;
  for (let fr = 0; fr < 6; fr++) {
    const input = new Float32Array(1920);
    for (let i = 0; i < input.length; i++) input[i] = 0.9 * Math.sin((2 * Math.PI * 440 * (i + fr * 1920)) / 48000);
    const low = downsample(input, 48000);
    const packed = adpcmEncode(low, st);
    const back = adpcmDecode(packed, adpcmSamples(packed)); // each frame decodes on its own
    if (fr === 0) continue;
    for (let i = 0; i < low.length; i++) {
      sig += low[i] ** 2;
      err += (low[i] - back[i]) ** 2;
    }
  }
  const snr = 10 * Math.log10(sig / err);
  assert.ok(snr > 24, `SNR ${snr.toFixed(1)} dB`);
  assert.ok(st.index > 40, "the step grew with the loudness");
});

// ---- the relay, with players stood about
function peer(id: number, x: number, z: number, y = 50): VoicePeer {
  return { id, key: `key-${id}`, name: `P${id}`, x, y, z, voice: newVoiceState() };
}
function relay(off = false): { r: VoiceRelay; got: Map<number, Uint8Array[]>; json: { to: number | null; msg: Record<string, unknown> }[]; slow: Set<number>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "steve-craft-voice-"));
  const got = new Map<number, Uint8Array[]>();
  const json: { to: number | null; msg: Record<string, unknown> }[] = [];
  const slow = new Set<number>();
  const r = new VoiceRelay(
    dir,
    {
      sendBin: (p, d) => got.set(p.id, [...(got.get(p.id) ?? []), d]),
      backlogged: (p) => slow.has(p.id),
      send: (p, msg) => json.push({ to: p.id, msg }),
      broadcast: (msg) => json.push({ to: null, msg }),
    },
    off,
  );
  return { r, got, json, slow, dir };
}
const frame = (n = 100, codec: number = VOICE_CODEC.OPUS, seq = 0) => new Uint8Array(encodeVoiceUp(codec, seq, new Uint8Array(n).fill(7)));
const heardFrom = (got: Map<number, Uint8Array[]>, listener: number) => (got.get(listener) ?? []).flatMap((m) => decodeVoice(new DataView(m.buffer, m.byteOffset, m.byteLength)).map((f) => f.speaker));

test("a voice reaches only the listeners in range who want it, never its speaker, once a tick", () => {
  const { r, got, dir } = relay();
  const A = peer(1, 100, 100);
  const B = peer(2, 110, 100); // 10 away
  const C = peer(3, 100 + VOICE_RANGE + 2, 100); // out of range
  const D = peer(4, 100, 120); // in range, but doesn't want voice
  const E = peer(5, 100, 105, 50 + 40); // in range across the ground, 40 up: out of range
  const all = [A, B, C, D, E];
  A.voice.mic = true;
  r.onState(D, { hear: false });
  for (let k = 0; k < 3; k++) r.onFrame(A, frame(100, 1, k), all, 1000 + k * 40);
  assert.equal(got.size, 0, "nothing until the tick");
  r.tick(all, 1, 1100);
  assert.deepEqual(heardFrom(got, 2), [1, 1, 1], "B: all three frames, in one message");
  assert.equal(got.get(2)!.length, 1);
  for (const id of [1, 3, 4, 5]) assert.equal(heardFrom(got, id).length, 0, `player ${id} hears nothing`);
  rmSync(dir, { recursive: true, force: true });
});

test("a listener gets the 8 closest voices at most; a muted voice never; Opus never to one who can't play it", () => {
  const { r, got, dir } = relay();
  const L = peer(100, 200, 200);
  const speakers = Array.from({ length: 11 }, (_, k) => peer(k + 1, 200 + 2 + k * 2, 200)); // 2, 4, ... 22 away
  const all = [L, ...speakers];
  for (const s of speakers) s.voice.mic = true;
  r.onMutes(L, [2]); // L muted the second closest
  // a first round: frames in any order (the farthest first), then a tick re-picks the closest
  for (const s of [...speakers].reverse()) r.onFrame(s, frame(), all, 1000);
  r.tick(all, 1, 1010);
  got.clear();
  for (const s of [...speakers].reverse()) r.onFrame(s, frame(), all, 1040);
  r.tick(all, 2, 1050);
  const ids = [...new Set(heardFrom(got, 100))].sort((a, b) => a - b);
  assert.equal(ids.length, VOICE_MAX_STREAMS);
  assert.deepEqual(ids, [1, 3, 4, 5, 6, 7, 8, 9], "the 8 closest, less the muted one");
  // a listener without Opus gets only fallback frames
  const N = peer(200, 300, 300);
  const S = peer(201, 305, 300);
  S.voice.mic = true;
  r.onState(N, { opus: false });
  got.clear();
  r.onFrame(S, frame(100, VOICE_CODEC.OPUS), [N, S], 2000);
  r.onFrame(S, frame(123, VOICE_CODEC.ADPCM), [N, S], 2040);
  r.tick([N, S], 3, 2050);
  const toN = (got.get(200) ?? []).flatMap((m) => decodeVoice(new DataView(m.buffer, m.byteOffset, m.byteLength)));
  assert.deepEqual(toN.map((f) => f.codec), [VOICE_CODEC.ADPCM]);
  rmSync(dir, { recursive: true, force: true });
});

test("no voice from a player whose voice is off, an admin-muted player (kept), on a server with voice off, or past the caps", () => {
  const { r, got, json, dir } = relay();
  const A = peer(1, 100, 100);
  const B = peer(2, 104, 100);
  r.onFrame(A, frame(), [A, B], 1000);
  r.tick([A, B], 1, 1010);
  assert.equal(heardFrom(got, 2).length, 0, "voice off: dropped");
  A.voice.mic = true;
  r.setAdminMute(A, true);
  assert.deepEqual(json.at(-1), { to: 1, msg: { t: "vstate", adminMuted: true } });
  r.onFrame(A, frame(), [A, B], 1100);
  r.tick([A, B], 2, 1110);
  assert.equal(heardFrom(got, 2).length, 0, "admin-muted: dropped");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "voice-mutes.json"), "utf8")), ["key-1"], "kept by key");
  const again = relay();
  const r2 = new VoiceRelay(dir, { sendBin: () => {}, backlogged: () => false, send: () => {}, broadcast: () => {} });
  assert.ok(r2.isAdminMuted(A), "still muted after a restart");
  r.setAdminMute(A, false);
  // the caps: a frame too big; a flood
  r.onFrame(A, frame(VOICE_MAX_PAYLOAD + 1), [A, B], 2000);
  for (let k = 0; k < 100; k++) r.onFrame(A, frame(60, 1, k), [A, B], 2000);
  r.tick([A, B], 3, 2010);
  const n = heardFrom(got, 2).length;
  assert.ok(n >= VOICE_RATE - 1 && n <= VOICE_RATE, `a burst capped at about a second's worth (${n})`);
  assert.ok(A.voice.dropped >= 60);
  // the server's kill switch
  const off = relay(true);
  A.voice = newVoiceState();
  off.r.onState(A, { mic: true });
  assert.equal(A.voice.mic, false, "voice can't be turned on");
  off.r.onFrame(A, frame(), [A, B], 3000);
  off.r.tick([A, B], 4, 3010);
  assert.equal(off.got.size, 0);
  for (const d of [dir, again.dir, off.dir]) rmSync(d, { recursive: true, force: true });
});

test("everyone learns who is talking (and when they stop); a speaker is told to use the fallback while someone near can only play that; a slow client skips voice", () => {
  const { r, got, json, slow, dir } = relay();
  const A = peer(1, 100, 100);
  const B = peer(2, 104, 100);
  const all = [A, B];
  A.voice.mic = true;
  r.onFrame(A, frame(), all, 1000);
  r.tick(all, 5, 1010);
  assert.deepEqual(json.filter((j) => j.to === null).map((j) => j.msg), [{ t: "talking", ids: [1] }]);
  r.tick(all, 10, 1500); // 500 ms later: stopped
  assert.deepEqual(json.filter((j) => j.to === null).at(-1)!.msg, { t: "talking", ids: [] });
  r.onState(B, { opus: false });
  r.tick(all, 27, 1600);
  assert.deepEqual(json.at(-1), { to: 1, msg: { t: "vcodec", adpcm: true } });
  r.onState(B, { opus: true });
  r.tick(all, 47, 2600);
  assert.deepEqual(json.at(-1), { to: 1, msg: { t: "vcodec", adpcm: false } });
  slow.add(2);
  got.clear();
  r.onFrame(A, frame(), all, 3000);
  r.tick(all, 50, 3010);
  assert.equal(got.size, 0, "a backlogged client gets no stale voice");
  assert.equal(B.voice.out.length, 0, "and nothing piles up");
  rmSync(dir, { recursive: true, force: true });
});
