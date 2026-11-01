// Proximity voice chat (protocol v11, update 13). Audio goes through our game server, never peer to peer, so no
// player's address ever reaches another player. A speaker sends small compressed frames; the server forwards each
// one only to players in range (VOICE_RANGE), at most the closest VOICE_MAX_STREAMS voices to each listener, and
// only to listeners who want to hear and haven't muted that speaker. Nothing listens to or analyses the audio (no
// filter: Laith's call).
//
// Codecs: Opus through WebCodecs (AudioEncoder / AudioDecoder) at ~20 kbps in 40 ms frames where the browser has it;
// otherwise a light fallback in plain JS: IMA ADPCM, 4 bits a sample at 6 kHz (24 kbps). The server tells a speaker
// to use the fallback while anyone in range can only decode that.

export const OP_VOICE_UP = 31; // C2S [op u8][codec u8][seq u16][payload]
export const OP_VOICE = 32; // S2C [op u8][n u8] then n * ([speaker id u16][codec u8][seq u16][len u16][payload])

export const VOICE_CODEC = { OPUS: 1, ADPCM: 2 } as const;
export const VOICE_RANGE = 32; // blocks: the server forwards a voice no further (3D distance)
export const VOICE_REF = 3; // full loudness within this
export const VOICE_FADE = 28; // and nothing from here (a linear fade between), panned in 3D (HRTF)
export const VOICE_MAX_STREAMS = 8; // voices one listener receives at once (the closest)
export const VOICE_FRAME_MS = 40;
export const VOICE_BITRATE = 20000; // Opus target (the cap is ~24 kbps)
export const VOICE_MAX_PAYLOAD = 360; // bytes in one frame: more is dropped (Opus at 20 kbps / 40 ms is ~100)
export const VOICE_RATE = 40; // frames a second a speaker may send (40 ms frames are 25; a little slack)
export const VOICE_BYTES = 4500; // bytes a second a speaker may send (about 36 kbps, headers included)
export const VOICE_ACTIVE_MS = 400; // a speaker counts as talking this long after its last frame
export const ADPCM_RATE = 6000; // the fallback's sample rate
export const VOICE_SAMPLE_RATE = 48000;

/** One frame on its way to a listener. */
export interface VoiceFrame {
  speaker: number;
  codec: number;
  seq: number;
  data: Uint8Array;
}

export function encodeVoiceUp(codec: number, seq: number, payload: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(4 + payload.length);
  const v = new DataView(buf);
  v.setUint8(0, OP_VOICE_UP);
  v.setUint8(1, codec);
  v.setUint16(2, seq & 0xffff, true);
  new Uint8Array(buf, 4).set(payload);
  return buf;
}

/** A speaker's frame as the server reads it (null if it isn't one). */
export function decodeVoiceUp(bytes: Uint8Array): { codec: number; seq: number; data: Uint8Array } | null {
  if (bytes.length < 5 || bytes[0] !== OP_VOICE_UP) return null;
  const codec = bytes[1];
  if (codec !== VOICE_CODEC.OPUS && codec !== VOICE_CODEC.ADPCM) return null;
  const seq = bytes[2] | (bytes[3] << 8);
  return { codec, seq, data: bytes.subarray(4) };
}

/** Frames for one listener in one message (at most 255). */
export function encodeVoice(frames: VoiceFrame[]): Uint8Array {
  let n = 2;
  for (const f of frames) n += 7 + f.data.length;
  const out = new Uint8Array(n);
  const v = new DataView(out.buffer);
  out[0] = OP_VOICE;
  out[1] = frames.length;
  let o = 2;
  for (const f of frames) {
    v.setUint16(o, f.speaker, true);
    out[o + 2] = f.codec;
    v.setUint16(o + 3, f.seq & 0xffff, true);
    v.setUint16(o + 5, f.data.length, true);
    out.set(f.data, o + 7);
    o += 7 + f.data.length;
  }
  return out;
}

export function decodeVoice(v: DataView): VoiceFrame[] {
  const out: VoiceFrame[] = [];
  if (v.byteLength < 2) return out;
  const n = v.getUint8(1);
  let o = 2;
  for (let k = 0; k < n && o + 7 <= v.byteLength; k++) {
    const len = v.getUint16(o + 5, true);
    if (o + 7 + len > v.byteLength) break;
    out.push({ speaker: v.getUint16(o, true), codec: v.getUint8(o + 2), seq: v.getUint16(o + 3, true), data: new Uint8Array(v.buffer, v.byteOffset + o + 7, len) });
    o += 7 + len;
  }
  return out;
}

// ---------------------------------------------------------------- the fallback codec: IMA ADPCM, 4 bits a sample

const STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
  253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
  3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
];
const INDEX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

/** 16-bit samples to IMA ADPCM: [first sample i16][step index u8, its top bit set when the last half byte is only
 *  padding] then two 4-bit codes a byte. Each frame stands alone (a lost frame costs only itself); `state` carries the
 *  step size from one frame to the next so a frame starts at the right loudness (it is in the frame's header). */
export function adpcmEncode(pcm: Int16Array, state: { index: number } = { index: 20 }): Uint8Array {
  const out = new Uint8Array(3 + Math.ceil((pcm.length - 1) / 2));
  let pred = pcm[0] ?? 0;
  let index = Math.max(0, Math.min(88, state.index | 0));
  out[0] = pred & 0xff;
  out[1] = (pred >> 8) & 0xff;
  out[2] = index | ((pcm.length - 1) & 1 ? 0x80 : 0);
  for (let i = 1; i < pcm.length; i++) {
    const step = STEPS[index];
    let diff = pcm[i] - pred;
    let code = 0;
    if (diff < 0) {
      code = 8;
      diff = -diff;
    }
    let delta = step >> 3;
    if (diff >= step) {
      code |= 4;
      diff -= step;
      delta += step;
    }
    if (diff >= step >> 1) {
      code |= 2;
      diff -= step >> 1;
      delta += step >> 1;
    }
    if (diff >= step >> 2) {
      code |= 1;
      delta += step >> 2;
    }
    pred += code & 8 ? -delta : delta;
    pred = Math.max(-32768, Math.min(32767, pred));
    index = Math.max(0, Math.min(88, index + INDEX[code]));
    const k = i - 1;
    if (k & 1) out[3 + (k >> 1)] |= code << 4;
    else out[3 + (k >> 1)] = code;
  }
  state.index = index;
  return out;
}

export function adpcmDecode(data: Uint8Array, samples: number): Int16Array {
  const out = new Int16Array(samples);
  if (data.length < 3 || samples < 1) return out;
  let pred = (data[0] | (data[1] << 8)) << 16 >> 16;
  let index = Math.min(88, data[2] & 0x7f);
  out[0] = pred;
  for (let i = 1; i < samples; i++) {
    const k = i - 1;
    const byte = data[3 + (k >> 1)] ?? 0;
    const code = k & 1 ? byte >> 4 : byte & 15;
    const step = STEPS[index];
    let delta = step >> 3;
    if (code & 4) delta += step;
    if (code & 2) delta += step >> 1;
    if (code & 1) delta += step >> 2;
    pred += code & 8 ? -delta : delta;
    pred = Math.max(-32768, Math.min(32767, pred));
    index = Math.max(0, Math.min(88, index + INDEX[code]));
    out[i] = pred;
  }
  return out;
}

/** Samples in an ADPCM frame. */
export const adpcmSamples = (data: Uint8Array) => (data.length < 3 ? 0 : (data.length - 3) * 2 + 1 - (data[2] & 0x80 ? 1 : 0));

/** Float samples at `rate` down to 16-bit samples at ADPCM_RATE (each output the mean of its input span: a simple
 *  low-pass against aliasing). */
export function downsample(input: Float32Array, rate: number): Int16Array {
  const ratio = rate / ADPCM_RATE;
  const n = Math.floor(input.length / ratio);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.max(a + 1, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let k = a; k < b; k++) s += input[k];
    const v = s / (b - a);
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  return out;
}

/** 16-bit samples at ADPCM_RATE up to float samples at `rate` (linear between samples). */
export function upsample(input: Int16Array, rate: number): Float32Array {
  const ratio = rate / ADPCM_RATE;
  const n = Math.floor(input.length * ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / ratio;
    const a = Math.floor(t);
    const b = Math.min(input.length - 1, a + 1);
    const f = t - a;
    out[i] = ((input[a] ?? 0) * (1 - f) + (input[b] ?? 0) * f) / 32768;
  }
  return out;
}
