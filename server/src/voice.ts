// Proximity voice for one shard (protocol v11, update 13): the server relays every frame; players never connect to
// each other (no addresses leak). A speaker's frame goes only to listeners within VOICE_RANGE who want voice, haven't
// muted that speaker and have room for it among the closest VOICE_MAX_STREAMS voices; each listener gets one message
// a tick with the frames gathered for it (or none). The audio itself is never decoded, inspected or kept: no filter
// (Laith's call). Kill switch: VOICE_OFF=1. An admin can mute one player's voice (kept by browser key).

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VOICE_ACTIVE_MS, VOICE_BYTES, VOICE_CODEC, VOICE_MAX_PAYLOAD, VOICE_MAX_STREAMS, VOICE_RANGE, VOICE_RATE, decodeVoiceUp, encodeVoice, type VoiceFrame } from "../../shared/voice.ts";

/** What the relay needs of a player. */
export interface VoicePeer {
  id: number;
  key: string;
  name: string;
  x: number;
  y: number;
  z: number;
  voice: VoiceState;
}

export interface VoiceState {
  mic: boolean; // they turned voice on (and may send)
  hear: boolean; // they want to hear voice chat
  opus: boolean; // they can decode Opus
  muted: Set<number>; // speakers they muted (ids)
  lastFrameAt: number; // ms: their last frame (talking while recent)
  allowed: Set<number>; // speakers whose frames they receive now (the closest, at most VOICE_MAX_STREAMS)
  out: VoiceFrame[]; // frames for them this tick
  tokens: number; // rate limit: frames
  bytes: number; // rate limit: bytes
  refillAt: number;
  adpcmHint: boolean; // told to send the fallback codec (someone near can only decode that)
  framesIn: number;
  dropped: number;
}

export function newVoiceState(): VoiceState {
  return { mic: false, hear: true, opus: true, muted: new Set(), lastFrameAt: 0, allowed: new Set(), out: [], tokens: VOICE_RATE, bytes: VOICE_BYTES, refillAt: 0, adpcmHint: false, framesIn: 0, dropped: 0 };
}

export interface VoiceHooks {
  sendBin(p: VoicePeer, data: Uint8Array): void;
  /** Slow client: skip this tick's voice rather than queue stale audio. */
  backlogged(p: VoicePeer): boolean;
  send(p: VoicePeer, msg: Record<string, unknown>): void;
  broadcast(msg: Record<string, unknown>): void;
}

export class VoiceRelay {
  readonly off: boolean;
  private path: string;
  private adminMuted = new Set<string>(); // player keys
  private talking: number[] = [];
  private talkingSentAt = 0;
  /** Counters for /status and the load test. */
  stats = { framesIn: 0, framesOut: 0, bytesOut: 0, dropped: 0 };

  private hooks: VoiceHooks;

  constructor(dir: string, hooks: VoiceHooks, off = process.env.VOICE_OFF === "1") {
    this.hooks = hooks;
    this.off = off;
    this.path = join(dir, "voice-mutes.json");
    try {
      if (existsSync(this.path)) for (const k of JSON.parse(readFileSync(this.path, "utf8")) as unknown[]) if (typeof k === "string") this.adminMuted.add(k);
    } catch {
      /* none */
    }
  }

  isAdminMuted(p: VoicePeer): boolean {
    return this.adminMuted.has(p.key);
  }

  /** An admin's mute (or unmute) of one player's voice, kept across restarts. */
  setAdminMute(p: VoicePeer, on: boolean): void {
    if (on) this.adminMuted.add(p.key);
    else this.adminMuted.delete(p.key);
    try {
      writeFileSync(this.path + ".tmp", JSON.stringify([...this.adminMuted]));
      renameSync(this.path + ".tmp", this.path);
    } catch {
      /* kept in memory */
    }
    this.hooks.send(p, { t: "vstate", adminMuted: on });
  }

  /** The player's voice settings (C2S voice). */
  onState(p: VoicePeer, m: { mic?: unknown; hear?: unknown; opus?: unknown }): void {
    if (typeof m.mic === "boolean") p.voice.mic = m.mic && !this.off;
    if (typeof m.hear === "boolean") p.voice.hear = m.hear;
    if (typeof m.opus === "boolean") p.voice.opus = m.opus;
    if (!p.voice.hear) p.voice.out.length = 0;
  }

  /** The speakers this listener muted (C2S vmute: ids of players online now). */
  onMutes(p: VoicePeer, ids: unknown): void {
    if (!Array.isArray(ids)) return;
    p.voice.muted = new Set(ids.filter((k) => Number.isInteger(k) && k > 0 && k < 65536).slice(0, 256) as number[]);
    for (const id of p.voice.muted) p.voice.allowed.delete(id);
  }

  /** A frame from a speaker: checked (size, rate, codec), then queued for every listener who gets it. */
  onFrame(p: VoicePeer, bytes: Uint8Array, listeners: Iterable<VoicePeer>, now = Date.now()): void {
    const v = p.voice;
    const f = decodeVoiceUp(bytes);
    if (!f || this.off || !v.mic || this.adminMuted.has(p.key) || f.data.length > VOICE_MAX_PAYLOAD) {
      v.dropped++;
      this.stats.dropped++;
      return;
    }
    // rate: frames and bytes a second
    const dt = (now - v.refillAt) / 1000;
    v.refillAt = now;
    v.tokens = Math.min(VOICE_RATE, v.tokens + dt * VOICE_RATE);
    v.bytes = Math.min(VOICE_BYTES, v.bytes + dt * VOICE_BYTES);
    if (v.tokens < 1 || v.bytes < bytes.length) {
      v.dropped++;
      this.stats.dropped++;
      return;
    }
    v.tokens -= 1;
    v.bytes -= bytes.length;
    v.lastFrameAt = now;
    v.framesIn++;
    this.stats.framesIn++;
    const frame: VoiceFrame = { speaker: p.id, codec: f.codec, seq: f.seq, data: new Uint8Array(f.data) };
    const r2 = VOICE_RANGE * VOICE_RANGE;
    for (const q of listeners) {
      if (q === p) continue;
      const w = q.voice;
      if (!w.hear || w.muted.has(p.id)) continue;
      if ((q.x - p.x) ** 2 + (q.y - p.y) ** 2 + (q.z - p.z) ** 2 > r2) continue;
      if (f.codec === VOICE_CODEC.OPUS && !w.opus) continue; // it can't play this one (its speaker is told to switch)
      if (!w.allowed.has(p.id)) {
        if (w.allowed.size >= VOICE_MAX_STREAMS) continue; // the closest voices fill its slots (re-sorted each tick)
        w.allowed.add(p.id);
      }
      if (w.out.length < 64) w.out.push(frame);
    }
  }

  /** Each tick: re-pick every listener's closest voices, send what was gathered, now and then who is talking and
   *  which codec each speaker should use. */
  tick(players: VoicePeer[], tick: number, now = Date.now()): void {
    const active = players.filter((p) => now - p.voice.lastFrameAt < VOICE_ACTIVE_MS);
    const r2 = VOICE_RANGE * VOICE_RANGE;
    for (const q of players) {
      const w = q.voice;
      if (w.out.length) {
        if (this.hooks.backlogged(q)) this.stats.dropped += w.out.length;
        else {
          const msg = encodeVoice(w.out.slice(0, 255));
          this.hooks.sendBin(q, msg);
          this.stats.framesOut += w.out.length;
          this.stats.bytesOut += msg.length;
        }
        w.out.length = 0;
      }
      // the closest talking speakers in range, not muted
      w.allowed.clear();
      if (!w.hear || !active.length) continue;
      const near: [number, number][] = [];
      for (const p of active) {
        if (p === q || w.muted.has(p.id)) continue;
        const d2 = (q.x - p.x) ** 2 + (q.y - p.y) ** 2 + (q.z - p.z) ** 2;
        if (d2 <= r2) near.push([d2, p.id]);
      }
      near.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      for (let k = 0; k < near.length && k < VOICE_MAX_STREAMS; k++) w.allowed.add(near[k][1]);
    }
    // who is talking (the speaking icons over heads and in the player list): on a change, at most 4 times a second
    if (tick % 5 === 0) {
      const ids = active.map((p) => p.id).sort((a, b) => a - b);
      if (ids.join() !== this.talking.join() && now - this.talkingSentAt >= 200) {
        this.talking = ids;
        this.talkingSentAt = now;
        this.hooks.broadcast({ t: "talking", ids });
      }
    }
    // the codec: a speaker uses the fallback while anyone in range who wants voice can only decode that
    if (tick % 20 === 7) {
      for (const p of players) {
        if (!p.voice.mic) continue;
        let adpcm = false;
        for (const q of players) {
          if (q === p || !q.voice.hear || q.voice.opus) continue;
          if ((q.x - p.x) ** 2 + (q.y - p.y) ** 2 + (q.z - p.z) ** 2 <= r2) {
            adpcm = true;
            break;
          }
        }
        if (adpcm !== p.voice.adpcmHint) {
          p.voice.adpcmHint = adpcm;
          this.hooks.send(p, { t: "vcodec", adpcm });
        }
      }
    }
  }

  /** Talking now (ids). */
  get talkingNow(): number[] {
    return this.talking;
  }
}
