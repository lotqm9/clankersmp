// Proximity voice chat (protocol v11, update 13). Everything goes through the game server (shared/voice.ts): no peer
// connections, so nobody learns anyone's address. The microphone stays off until the player turns voice on (that is
// when the browser asks for permission). Push-to-talk (hold V) by default, or an open mic that sends only while you
// speak. Voices come out of the speaker's head, panned in 3D (HRTF) and fading out to nothing by VOICE_FADE blocks.
// Opus through WebCodecs where the browser has it, else the light ADPCM fallback; each voice gets its own small
// jitter buffer. No filter and nothing recorded: the audio is only played.

import {
  ADPCM_RATE, VOICE_BITRATE, VOICE_CODEC, VOICE_FADE, VOICE_FRAME_MS, VOICE_REF, VOICE_SAMPLE_RATE, adpcmDecode, adpcmEncode, adpcmSamples, downsample,
  encodeVoiceUp, upsample, type VoiceFrame,
} from "../../shared/voice.ts";

const CAPTURE = `class SteveCraftVoiceCapture extends AudioWorkletProcessor {
  constructor(o) { super(); this.n = o.processorOptions.frame; this.buf = new Float32Array(this.n); this.k = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.k++] = ch[i];
      if (this.k === this.n) { this.port.postMessage(this.buf, [this.buf.buffer]); this.buf = new Float32Array(this.n); this.k = 0; }
    }
    return true;
  }
}
registerProcessor("steve-craft-voice-capture", SteveCraftVoiceCapture);`;

const JITTER = 0.12; // seconds of audio buffered before a voice starts playing
const MAX_AHEAD = 0.6; // more queued than this: drop back to the jitter delay
const TAIL_MS = 240; // push-to-talk: keep sending this long after V comes up (the end of a word)
const HANGOVER_MS = 450; // open mic: keep sending this long after the voice drops
const OPEN_MIC_LEVEL = 0.018; // RMS over which the open mic sends

export interface VoiceHooks {
  sendJson(m: Record<string, unknown>): void;
  sendBin(buf: ArrayBuffer): void;
  /** Where a player's mouth is (null: unknown). */
  positionOf(id: number): { x: number; y: number; z: number } | null;
  nameOf(id: number): string | null;
  /** Something the HUD shows changed (mic state, talking). */
  changed(): void;
  notice(text: string): void;
}

interface Stream {
  id: number;
  gain: GainNode;
  panner: PannerNode;
  dec: AudioDecoder | null;
  ts: number;
  playAt: number;
  lastSeq: number;
  lastAt: number; // performance.now() of its last frame
  frames: number;
}

export type MicState = "off" | "asking" | "on" | "denied" | "error";

export class VoiceChat {
  serverOn = true;
  adminMuted = false;
  adpcmHint = false;
  mic: MicState = "off";
  openMic = false;
  hear = true;
  volume = 0.8;
  /** Names this player muted (kept in settings). */
  muted = new Set<string>();
  /** Who the server says is talking (ids). */
  talking = new Set<number>();
  /** Push-to-talk held (V or the touch button). */
  ptt = false;
  /** Sending right now. */
  transmitting = false;
  /** The mic's loudness, 0..1. */
  level = 0;
  canEncodeOpus = false;
  canDecodeOpus = false;
  readonly streams = new Map<number, Stream>();
  stats = { framesSent: 0, framesHeard: 0, decodeErrors: 0, played: 0, peak: 0 }; // peak: the loudest sample lately (a check that sound comes out)
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private hooks: VoiceHooks;
  private media: MediaStream | null = null;
  private capture: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private sink: GainNode | null = null;
  private enc: AudioEncoder | null = null;
  private encTs = 0;
  private seq = 0;
  private sendUntil = 0;
  private detected: Promise<void>;
  private sentState = "";
  private adpcmState = { index: 20 };

  constructor(hooks: VoiceHooks) {
    this.hooks = hooks;
    this.detected = this.detect();
  }

  /** Can this browser speak and hear Opus (WebCodecs)? Else the fallback codec. */
  private async detect(): Promise<void> {
    try {
      if (typeof AudioDecoder !== "undefined") this.canDecodeOpus = !!(await AudioDecoder.isConfigSupported({ codec: "opus", sampleRate: VOICE_SAMPLE_RATE, numberOfChannels: 1 })).supported;
    } catch {
      this.canDecodeOpus = false;
    }
    try {
      if (typeof AudioEncoder !== "undefined") this.canEncodeOpus = !!(await AudioEncoder.isConfigSupported({ codec: "opus", sampleRate: VOICE_SAMPLE_RATE, numberOfChannels: 1, bitrate: VOICE_BITRATE })).supported;
    } catch {
      this.canEncodeOpus = false;
    }
    this.syncState();
  }

  /** Audio needs a user gesture to start: called on clicks and keys (with the game's sound). */
  unlock(): void {
    if (!this.ctx) {
      try {
        try {
          this.ctx = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE, latencyHint: "interactive" });
        } catch {
          this.ctx = new AudioContext();
        }
        this.master = this.ctx.createGain();
        this.master.gain.value = this.hear ? this.volume : 0;
        this.master.connect(this.ctx.destination);
      } catch {
        this.ctx = null;
        return;
      }
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  /** Tell the server what we do: voice on (may send), hear, can decode Opus. Only on a change. */
  syncState(force = false): void {
    const s = { t: "voice", mic: this.mic === "on" && !this.adminMuted, hear: this.hear, opus: this.canDecodeOpus };
    const key = JSON.stringify(s);
    if (key === this.sentState && !force) return;
    this.sentState = key;
    this.hooks.sendJson(s);
  }

  /** The ids (online now) of the muted names, for the server (it then sends us nothing from them). */
  syncMutes(online: { id: number; name: string }[]): void {
    this.hooks.sendJson({ t: "vmute", ids: online.filter((p) => this.muted.has(p.name)).map((p) => p.id) });
  }

  setHear(on: boolean): void {
    this.hear = on;
    if (this.master) this.master.gain.value = on ? this.volume : 0;
    if (!on) for (const s of this.streams.values()) s.playAt = 0;
    this.syncState();
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master) this.master.gain.value = this.hear ? v : 0;
  }

  /** Turn voice on: the browser asks for the microphone now (and only now). */
  async enableMic(): Promise<boolean> {
    if (!this.serverOn) {
      this.hooks.notice("Voice chat is off on this server.");
      return false;
    }
    if (this.mic === "on" || this.mic === "asking") return this.mic === "on";
    this.unlock();
    if (!this.ctx || !navigator.mediaDevices?.getUserMedia) {
      this.mic = "error";
      this.hooks.notice("This browser can't use a microphone here.");
      this.hooks.changed();
      return false;
    }
    this.mic = "asking";
    this.hooks.changed();
    try {
      this.media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (e) {
      this.mic = (e as Error)?.name === "NotAllowedError" ? "denied" : "error";
      this.hooks.notice(this.mic === "denied" ? "Microphone blocked. Allow it in your browser to talk." : "No microphone found.");
      this.hooks.changed();
      return false;
    }
    try {
      await this.detected;
      const ctx = this.ctx;
      const url = URL.createObjectURL(new Blob([CAPTURE], { type: "application/javascript" }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      this.source = ctx.createMediaStreamSource(this.media);
      this.capture = new AudioWorkletNode(ctx, "steve-craft-voice-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { frame: Math.round((ctx.sampleRate * VOICE_FRAME_MS) / 1000) } });
      this.sink = ctx.createGain();
      this.sink.gain.value = 0; // (keeps the capture running; nothing of your own voice is played)
      this.source.connect(this.capture);
      this.capture.connect(this.sink);
      this.sink.connect(ctx.destination);
      this.capture.port.onmessage = (e) => this.onCaptured(e.data as Float32Array);
      if (this.canEncodeOpus && ctx.sampleRate === VOICE_SAMPLE_RATE) this.startEncoder();
    } catch {
      this.stopMedia();
      this.mic = "error";
      this.hooks.notice("Voice chat couldn't start in this browser.");
      this.hooks.changed();
      return false;
    }
    this.mic = "on";
    this.syncState();
    this.hooks.changed();
    return true;
  }

  disableMic(): void {
    this.stopMedia();
    this.mic = "off";
    this.transmitting = false;
    this.level = 0;
    this.syncState();
    this.hooks.changed();
  }

  private stopMedia(): void {
    try {
      this.capture?.port.close();
      this.source?.disconnect();
      this.capture?.disconnect();
      this.sink?.disconnect();
    } catch {
      /* gone */
    }
    for (const t of this.media?.getTracks() ?? []) t.stop();
    this.media = null;
    this.capture = null;
    this.source = null;
    this.sink = null;
    try {
      if (this.enc && this.enc.state !== "closed") this.enc.close();
    } catch {
      /* closed */
    }
    this.enc = null;
  }

  private startEncoder(): void {
    try {
      this.enc = new AudioEncoder({
        output: (chunk) => {
          const b = new Uint8Array(chunk.byteLength);
          chunk.copyTo(b);
          this.send(VOICE_CODEC.OPUS, b);
        },
        error: () => {
          this.enc = null; // fall back to ADPCM
        },
      });
      const base = { codec: "opus", sampleRate: VOICE_SAMPLE_RATE, numberOfChannels: 1, bitrate: VOICE_BITRATE };
      try {
        this.enc.configure({ ...base, opus: { frameDuration: VOICE_FRAME_MS * 1000 } } as AudioEncoderConfig);
      } catch {
        this.enc.configure(base);
      }
    } catch {
      this.enc = null;
    }
  }

  private send(codec: number, payload: Uint8Array): void {
    if (payload.length === 0) return;
    this.hooks.sendBin(encodeVoiceUp(codec, this.seq++, payload));
    this.stats.framesSent++;
  }

  /** 40 ms of microphone: measured, and sent while we talk. */
  private onCaptured(pcm: Float32Array): void {
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
    const rms = Math.sqrt(sum / pcm.length);
    this.level = Math.min(1, Math.max(this.level * 0.6, rms * 6));
    const now = performance.now();
    if (this.mic !== "on" || this.adminMuted) return;
    if (this.ptt) this.sendUntil = now + TAIL_MS;
    else if (this.openMic && rms > OPEN_MIC_LEVEL) this.sendUntil = now + HANGOVER_MS;
    const was = this.transmitting;
    this.transmitting = now < this.sendUntil;
    if (was !== this.transmitting) this.hooks.changed();
    if (!this.transmitting) return;
    const rate = this.ctx!.sampleRate;
    if (this.enc && !this.adpcmHint && this.enc.state === "configured") {
      const data = new AudioData({ format: "f32-planar", sampleRate: rate, numberOfFrames: pcm.length, numberOfChannels: 1, timestamp: this.encTs, data: pcm as Float32Array<ArrayBuffer> });
      this.encTs += Math.round((pcm.length * 1e6) / rate);
      this.enc.encode(data);
      data.close();
    } else this.send(VOICE_CODEC.ADPCM, adpcmEncode(downsample(pcm, rate), this.adpcmState));
  }

  // ---------------------------------------------------------------- hearing

  /** Frames from the server (OP_VOICE). */
  onFrames(frames: VoiceFrame[]): void {
    if (!this.ctx || !this.master || !this.hear) return;
    for (const f of frames) {
      const name = this.hooks.nameOf(f.speaker);
      if (name && this.muted.has(name)) continue;
      const s = this.stream(f.speaker);
      // a frame from before the last one (or a repeat): skip; a long gap: start over
      const d = (f.seq - s.lastSeq) & 0xffff;
      if (s.frames > 0 && (d === 0 || d > 0x8000)) continue;
      s.lastSeq = f.seq;
      s.lastAt = performance.now();
      s.frames++;
      this.stats.framesHeard++;
      if (f.codec === VOICE_CODEC.OPUS) {
        if (!s.dec) s.dec = this.decoder(s);
        if (!s.dec) continue;
        try {
          s.dec.decode(new EncodedAudioChunk({ type: "key", timestamp: s.ts, data: f.data }));
          s.ts += VOICE_FRAME_MS * 1000;
        } catch {
          this.stats.decodeErrors++;
        }
      } else if (f.codec === VOICE_CODEC.ADPCM) {
        const pcm = adpcmDecode(f.data, adpcmSamples(f.data));
        this.play(s, upsample(pcm, VOICE_SAMPLE_RATE), VOICE_SAMPLE_RATE);
      }
    }
  }

  private decoder(s: Stream): AudioDecoder | null {
    if (!this.canDecodeOpus) return null;
    try {
      const dec = new AudioDecoder({
        output: (data) => {
          const n = data.numberOfFrames;
          const out = new Float32Array(n);
          data.copyTo(out, { planeIndex: 0, format: "f32-planar" });
          const rate = data.sampleRate;
          data.close();
          this.play(s, out, rate);
        },
        error: () => {
          this.stats.decodeErrors++;
          s.dec = null;
        },
      });
      dec.configure({ codec: "opus", sampleRate: VOICE_SAMPLE_RATE, numberOfChannels: 1 });
      return dec;
    } catch {
      return null;
    }
  }

  private stream(id: number): Stream {
    let s = this.streams.get(id);
    if (s) return s;
    const ctx = this.ctx!;
    const gain = ctx.createGain();
    const panner = ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "linear";
    panner.refDistance = VOICE_REF;
    panner.maxDistance = VOICE_FADE;
    panner.rolloffFactor = 1;
    gain.connect(panner);
    panner.connect(this.master!);
    s = { id, gain, panner, dec: null, ts: 0, playAt: 0, lastSeq: 0, lastAt: 0, frames: 0 };
    this.streams.set(id, s);
    return s;
  }

  /** Queue decoded audio on its voice's timeline (a little behind, to ride out the network's jitter). */
  private play(s: Stream, samples: Float32Array, rate: number): void {
    const ctx = this.ctx;
    if (!ctx || !samples.length || !this.hear) return;
    let peak = 0;
    for (let i = 0; i < samples.length; i += 4) peak = Math.max(peak, Math.abs(samples[i]));
    this.stats.peak = Math.max(peak, this.stats.peak * 0.9);
    const buf = ctx.createBuffer(1, samples.length, rate);
    buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(s.gain);
    const now = ctx.currentTime;
    if (s.playAt < now + 0.01 || s.playAt > now + MAX_AHEAD) s.playAt = now + JITTER;
    src.start(s.playAt);
    s.playAt += buf.duration;
    this.stats.played++;
  }

  /** Each frame: the listener at the camera, every voice at its speaker's head; idle voices let go. */
  update(cam: { x: number; y: number; z: number }, fwd: { x: number; y: number; z: number }): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const L = ctx.listener;
    const t = ctx.currentTime;
    if (L.positionX) {
      L.positionX.setTargetAtTime(cam.x, t, 0.02);
      L.positionY.setTargetAtTime(cam.y, t, 0.02);
      L.positionZ.setTargetAtTime(cam.z, t, 0.02);
      L.forwardX.setTargetAtTime(fwd.x, t, 0.02);
      L.forwardY.setTargetAtTime(fwd.y, t, 0.02);
      L.forwardZ.setTargetAtTime(fwd.z, t, 0.02);
      L.upX.value = 0;
      L.upY.value = 1;
      L.upZ.value = 0;
    } else {
      L.setPosition(cam.x, cam.y, cam.z);
      L.setOrientation(fwd.x, fwd.y, fwd.z, 0, 1, 0);
    }
    const now = performance.now();
    for (const s of this.streams.values()) {
      const p = this.hooks.positionOf(s.id) ?? cam;
      if (s.panner.positionX) {
        s.panner.positionX.setTargetAtTime(p.x, t, 0.03);
        s.panner.positionY.setTargetAtTime(p.y, t, 0.03);
        s.panner.positionZ.setTargetAtTime(p.z, t, 0.03);
      } else s.panner.setPosition(p.x, p.y, p.z);
      const name = this.hooks.nameOf(s.id);
      s.gain.gain.value = name && this.muted.has(name) ? 0 : 1;
      if (now - s.lastAt > 15000) this.drop(s);
    }
  }

  private drop(s: Stream): void {
    try {
      s.gain.disconnect();
      s.panner.disconnect();
      if (s.dec && s.dec.state !== "closed") s.dec.close();
    } catch {
      /* gone */
    }
    this.streams.delete(s.id);
  }

  /** Someone we can hear spoke within the last moment (the icon over their head pulses). */
  speakingNow(id: number): boolean {
    const s = this.streams.get(id);
    return !!s && performance.now() - s.lastAt < 300;
  }

  /** The fallback is how we send now (the server says someone near can only play that, or we can't encode Opus). */
  get sendsFallback(): boolean {
    return this.adpcmHint || !this.enc;
  }

  get supported(): boolean {
    return typeof AudioContext !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  }
}

/** (For the checks: the fallback's sample rate.) */
export const VOICE_FALLBACK_RATE = ADPCM_RATE;
