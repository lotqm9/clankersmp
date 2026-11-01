// Background music, the calm way: a soft piano piece now and then, with long quiet gaps in between, never the same
// piece twice in a row. The pieces are original (made for this game with ElevenLabs Music; LICENSES/
// elevenlabs-music.md). Streamed with an <audio> element, one at a time, only after the player has clicked in.

interface Track {
  file: string;
  title: string;
  seconds: number;
}

const BASE = "/play/music/";

export class Music {
  private el: HTMLAudioElement | null = null;
  private tracks: Track[] = [];
  private last = -1;
  private timer = 0;
  private fadeTimer = 0;
  private volume = 0.5;
  private started = false;
  /** Called with the title when a piece starts (the HUD shows it for a moment). */
  onTrack: (title: string) => void = () => {};

  /** Begin the cycle: the first piece comes after a short while, like arriving somewhere quiet. */
  async start(firstDelayMs = 20000 + Math.random() * 25000): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      const r = await fetch(`${BASE}tracks.json`, { cache: "no-cache" });
      if (r.ok) this.tracks = (await r.json()) as Track[];
    } catch {
      /* no music on this build: stay silent */
    }
    if (this.tracks.length) this.schedule(firstDelayMs);
  }

  get playing(): string | null {
    return this.el && !this.el.paused ? (this.tracks[this.last]?.title ?? null) : null;
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.el) {
      if (this.volume === 0) {
        this.el.pause();
        this.el = null;
        if (this.started) this.schedule(60000);
      } else this.el.volume = this.level();
    }
  }

  /** Play a piece right away (tests, screenshots, or a "play music" control later). */
  playNow(index = -1): void {
    window.clearTimeout(this.timer);
    this.play(index);
  }

  private level(): number {
    return this.volume * 0.85;
  }

  private schedule(ms: number): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.play(), ms);
  }

  private play(index = -1): void {
    if (!this.tracks.length) return;
    if (this.volume === 0) {
      this.schedule(60000); // muted: check again in a minute
      return;
    }
    let k = index;
    if (k < 0 || k >= this.tracks.length) {
      k = Math.floor(Math.random() * this.tracks.length);
      if (this.tracks.length > 1 && k === this.last) k = (k + 1 + Math.floor(Math.random() * (this.tracks.length - 1))) % this.tracks.length;
    }
    this.last = k;
    this.el?.pause();
    const el = new Audio(BASE + this.tracks[k].file);
    el.preload = "auto";
    el.volume = 0;
    this.el = el;
    el.addEventListener("ended", () => {
      if (this.el === el) this.el = null;
      // A long, quiet gap before the next piece (2 to 5 minutes).
      this.schedule(120000 + Math.random() * 180000);
    });
    el.play().then(
      () => {
        this.onTrack(this.tracks[k].title);
        this.fadeTo(this.level(), 3000);
      },
      () => this.schedule(30000), // the browser blocked it (no click yet): try again later
    );
  }

  private fadeTo(target: number, ms: number): void {
    window.clearInterval(this.fadeTimer);
    const el = this.el;
    if (!el) return;
    const from = el.volume;
    const t0 = performance.now();
    this.fadeTimer = window.setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      el.volume = from + (target - from) * k;
      if (k >= 1) window.clearInterval(this.fadeTimer);
    }, 50);
  }
}
