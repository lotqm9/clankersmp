// Sound effects (Kenney CC0 packs and our own ElevenLabs originals) through WebAudio, with Java-style volume/pitch per action and
// simple distance falloff + stereo panning for sounds made by other players.

import type { SoundGroup } from "../../shared/blocks.ts";

const BASE = "/play/sounds/";

const STEP: Record<SoundGroup, string> = {
  none: "",
  grass: "step_grass",
  gravel: "step_gravel",
  stone: "step_stone",
  wood: "step_wood",
  sand: "step_gravel",
  glass: "step_stone",
  cloth: "step_cloth",
};
const BREAK: Record<SoundGroup, string> = {
  none: "",
  grass: "step_grass",
  gravel: "step_gravel",
  stone: "dig_stone",
  wood: "dig_wood",
  sand: "step_gravel",
  glass: "break_glass",
  cloth: "dig_cloth",
};
const PLACE: Record<SoundGroup, string> = {
  none: "",
  grass: "step_grass",
  gravel: "step_gravel",
  stone: "dig_stone",
  wood: "place_wood",
  sand: "step_gravel",
  glass: "place_glass",
  cloth: "step_cloth",
};
const PITCH: Record<SoundGroup, number> = { none: 1, grass: 1, gravel: 1, stone: 1, wood: 1, sand: 1.25, glass: 1, cloth: 1 };

const ANIMALS = ["pig", "cow", "sheep", "chicken"];
const MOBS = ["shambler", "rattler", "skitter"];
const SETS = [
  "step_grass", "step_stone", "step_wood", "step_gravel", "step_cloth", "dig_stone", "dig_wood", "place_wood", "break_glass", "dig_cloth",
  "place_glass", "door_open", "door_close", ...ANIMALS.flatMap((a) => [`${a}_say`, `${a}_hurt`]),
  // survival (v5, ElevenLabs originals)
  "pickup", "hurt", "eat", "burp", "tool_break", "chest_open", "chest_close",
  // night mobs and combat (v6, ElevenLabs originals; update 10.1: new hurts and hits)
  ...MOBS.flatMap((m) => [`${m}_say`, `${m}_hurt`, `${m}_death`]),
  "bow_shoot", "arrow_hit", "hit", "attack_crit", "armor_equip",
  // farming, buckets and drinks (v7, ElevenLabs originals)
  "till", "bucket_fill", "bucket_empty", "drink",
  // the village chime, oars and boats (v8, ElevenLabs originals)
  "chime", "paddle", "splash", "boat_break",
  // villagers and trading (v9, ElevenLabs originals): whistles, a startled "oh", rubies changing hands
  "villager_say", "villager_yes", "villager_no", "villager_hurt", "trade",
];
const VARIANTS: Record<string, number> = { door_open: 2, door_close: 4, pickup: 3, hurt: 1, eat: 3, burp: 1, tool_break: 1, chest_open: 1, chest_close: 1 }; // others have 5
for (const a of ANIMALS) {
  VARIANTS[`${a}_say`] = 3;
  VARIANTS[`${a}_hurt`] = 1;
}
for (const m of MOBS) {
  VARIANTS[`${m}_say`] = 3;
  VARIANTS[`${m}_hurt`] = 1;
  VARIANTS[`${m}_death`] = 1;
}
Object.assign(VARIANTS, { bow_shoot: 2, arrow_hit: 2, hit: 1, attack_crit: 1, armor_equip: 2 });
Object.assign(VARIANTS, { till: 2, bucket_fill: 2, bucket_empty: 2, drink: 2 });
Object.assign(VARIANTS, { chime: 2, paddle: 3, splash: 1, boat_break: 1 });
Object.assign(VARIANTS, { villager_say: 3, villager_yes: 1, villager_no: 1, villager_hurt: 2, trade: 1 });
/** Every sound file the game loads (name without .ogg). */
export function soundFiles(): string[] {
  const names = ["click"];
  for (const s of SETS) for (let i = 0; i < (VARIANTS[s] ?? 5); i++) names.push(`${s}_${i}`);
  return names;
}
/** Update 10.1: damage sounds (yours, your hits, an animal's or a mob's hurt) play at a random pitch of 0.8-1.2, the
 *  classic game's spread: one good take sounds different every time. */
export const DAMAGE_PITCH: readonly [number, number] = [0.8, 1.2];
const damagePitch = () => DAMAGE_PITCH[0] + Math.random() * (DAMAGE_PITCH[1] - DAMAGE_PITCH[0]);
/** Loudness and pitch range per night mob. */
const MOB_VOICE: Record<string, [number, number, number]> = { shambler: [0.6, 0.85, 1.0], rattler: [0.55, 0.9, 1.1], skitter: [0.5, 0.95, 1.15] };
/** Loudness and pitch range per animal (chickens are small and light, cows big and low). */
const ANIMAL_VOICE: Record<string, [number, number, number]> = { pig: [0.55, 0.92, 1.1], cow: [0.5, 0.9, 1.05], sheep: [0.5, 0.92, 1.1], chicken: [0.45, 0.95, 1.12] };

export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private loading = false;
  volume = 0.7;
  listener = { x: 0, y: 0, z: 0, yaw: 0 };

  /** Must be called from a user gesture (click/key). */
  unlock(): void {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.volume;
        this.master.connect(this.ctx.destination);
      } catch {
        return;
      }
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    if (!this.loading) {
      this.loading = true;
      void this.loadAll();
    }
  }

  private async loadAll(): Promise<void> {
    const names = soundFiles();
    await Promise.all(
      names.map(async (n) => {
        try {
          const r = await fetch(`${BASE}${n}.ogg`);
          const buf = await r.arrayBuffer();
          this.buffers.set(n, await this.ctx!.decodeAudioData(buf));
        } catch {
          /* missing or undecodable: stay silent */
        }
      }),
    );
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  play(name: string, vol: number, pitch: number, at?: { x: number; y: number; z: number }, range = 24): void {
    if (!this.ctx || !this.master || this.ctx.state !== "running") return;
    const variants = this.buffers.has(name) ? [name] : [0, 1, 2, 3, 4].map((i) => `${name}_${i}`).filter((n) => this.buffers.has(n));
    if (!variants.length) return;
    const buf = this.buffers.get(variants[Math.floor(Math.random() * variants.length)])!;
    let gain = vol;
    let pan = 0;
    if (at) {
      const dx = at.x - this.listener.x;
      const dy = at.y - this.listener.y;
      const dz = at.z - this.listener.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      gain *= Math.max(0, 1 - d / range);
      if (gain <= 0.01) return;
      // Pan by the angle between the listener's facing and the source.
      const yaw = (this.listener.yaw * Math.PI) / 180;
      const rightX = -Math.cos(yaw);
      const rightZ = -Math.sin(yaw);
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      pan = Math.max(-1, Math.min(1, (dx * rightX + dz * rightZ) / len)) * 0.7;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = pitch;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    let node: AudioNode = g;
    if (pan !== 0 && this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p);
      node = p;
    }
    node.connect(this.master);
    src.connect(g);
    src.start();
  }

  step(group: SoundGroup, at?: { x: number; y: number; z: number }): void {
    if (STEP[group]) this.play(STEP[group], 0.32, PITCH[group] * (0.95 + Math.random() * 0.1), at);
  }
  hit(group: SoundGroup): void {
    if (STEP[group]) this.play(STEP[group], 0.22, PITCH[group] * 0.6);
  }
  breakBlock(group: SoundGroup, at?: { x: number; y: number; z: number }): void {
    if (BREAK[group]) this.play(BREAK[group], 0.75, PITCH[group] * 0.85 * (0.95 + Math.random() * 0.1), at);
  }
  place(group: SoundGroup, at?: { x: number; y: number; z: number }): void {
    if (PLACE[group]) this.play(PLACE[group], 0.75, PITCH[group] * 0.8 * (0.95 + Math.random() * 0.1), at);
  }
  door(open: boolean, at?: { x: number; y: number; z: number }): void {
    this.play(open ? "door_open" : "door_close", 0.6, 0.9 + Math.random() * 0.1, at);
  }
  /** An animal's voice (original ElevenLabs sounds), positioned in the world like other sounds. Its hurt (10.1) is a
   *  soft one, at the animal's own loudness and the damage pitch spread. */
  animal(key: string, what: "say" | "hurt", at: { x: number; y: number; z: number }): void {
    const [vol, lo, hi] = ANIMAL_VOICE[key] ?? [0.5, 0.95, 1.05];
    if (what === "hurt") this.play(`${key}_hurt`, vol, damagePitch(), at);
    else this.play(`${key}_say`, vol, lo + Math.random() * (hi - lo), at);
  }
  click(): void {
    this.play("click", 0.5, 1);
  }
  /** v6: a night mob's groan, rattle or chitter; its hurt cry; its last sound. */
  mob(key: string, what: "say" | "hurt" | "death", at: { x: number; y: number; z: number }): void {
    const [vol, lo, hi] = MOB_VOICE[key] ?? [0.55, 0.95, 1.05];
    this.play(`${key}_${what}`, what === "say" ? vol : vol * 1.15, what === "hurt" ? damagePitch() : lo + Math.random() * (hi - lo), at);
  }
  bow(at?: { x: number; y: number; z: number }): void {
    this.play("bow_shoot", 0.55, 0.9 + Math.random() * 0.25, at);
  }
  arrowHit(at?: { x: number; y: number; z: number }): void {
    this.play("arrow_hit", 0.5, 0.9 + Math.random() * 0.25, at);
  }
  /** Your hit landed (10.1): a crisp thud, quieter for a weak (uncharged) hit; a critical hit is sharper. */
  attack(kind: "strong" | "weak" | "crit"): void {
    if (kind === "crit") this.play("attack_crit", 0.65, damagePitch());
    else this.play("hit", kind === "weak" ? 0.38 : 0.62, damagePitch());
  }
  equip(at?: { x: number; y: number; z: number }): void {
    this.play("armor_equip", 0.5, 0.9 + Math.random() * 0.2, at);
  }
  /** An item flew into your inventory (Java: a quiet pop, random pitch). */
  pickup(): void {
    this.play("pickup", 0.28, 1.2 + Math.random() * 0.6);
  }
  /** You took damage (10.1): a short low "oof". */
  hurt(at?: { x: number; y: number; z: number }): void {
    this.play("hurt", 0.75, damagePitch(), at);
  }
  eat(at?: { x: number; y: number; z: number }): void {
    this.play("eat", 0.45, 0.85 + Math.random() * 0.3, at);
  }
  burp(at?: { x: number; y: number; z: number }): void {
    this.play("burp", 0.5, 0.9 + Math.random() * 0.1, at);
  }
  toolBreak(at?: { x: number; y: number; z: number }): void {
    this.play("tool_break", 0.8, 0.9 + Math.random() * 0.2, at);
  }
  chest(open: boolean, at?: { x: number; y: number; z: number }): void {
    this.play(open ? "chest_open" : "chest_close", 0.5, 0.95 + Math.random() * 0.1, at);
  }
  // v7
  /** A hoe turning the soil. */
  till(at?: { x: number; y: number; z: number }): void {
    this.play("till", 0.6, 0.9 + Math.random() * 0.2, at);
  }
  /** A bucket filling (water, milk) or being poured out. */
  bucket(fill: boolean, at?: { x: number; y: number; z: number }): void {
    this.play(fill ? "bucket_fill" : "bucket_empty", 0.55, 0.9 + Math.random() * 0.2, at);
  }
  drink(at?: { x: number; y: number; z: number }): void {
    this.play("drink", 0.45, 0.9 + Math.random() * 0.2, at);
  }
  // v8
  /** The village chime: heard further than most sounds (a village centre). */
  chime(at?: { x: number; y: number; z: number }): void {
    this.play("chime", 0.7, 0.97 + Math.random() * 0.06, at, 48);
  }
  /** One oar stroke. */
  paddle(at?: { x: number; y: number; z: number }): void {
    this.play("paddle", 0.32, 0.9 + Math.random() * 0.2, at);
  }
  boatPlace(at?: { x: number; y: number; z: number }): void {
    this.play("splash", 0.6, 0.9 + Math.random() * 0.15, at);
  }
  boatBreak(at?: { x: number; y: number; z: number }): void {
    this.play("boat_break", 0.7, 0.9 + Math.random() * 0.15, at);
  }
  // v9
  /** A villager: a whistled tune now and then, a startled "oh" when poked. */
  villager(what: "say" | "hurt", at?: { x: number; y: number; z: number }): void {
    this.play(`villager_${what}`, what === "say" ? 0.45 : 0.55, 0.92 + Math.random() * 0.16, at, 20);
  }
  /** A trade: rubies changing hands and a happy whistle, or a "no" whistle (can't afford it, sold out, no room). */
  trade(ok: boolean, at?: { x: number; y: number; z: number }): void {
    if (ok) {
      this.play("trade", 0.55, 0.95 + Math.random() * 0.1, at, 16);
      this.play("villager_yes", 0.45, 0.95 + Math.random() * 0.1, at, 16);
    } else this.play("villager_no", 0.5, 0.95 + Math.random() * 0.1, at, 16);
  }
  /** Fence gates and trapdoors use the door sounds, a little lighter. */
  gate(open: boolean, trap: boolean, at?: { x: number; y: number; z: number }): void {
    this.play(open ? "door_open" : "door_close", 0.5, (trap ? 1.2 : 1.08) + Math.random() * 0.08, at);
  }
}
