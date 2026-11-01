// Player settings, kept in localStorage (wrapped: storage can be unavailable).

import { DEFAULT_HOTBAR } from "../../shared/blocks.ts";
import { NAME_RE, NAME_STORAGE_KEY, randomName } from "../../shared/names.ts";

export interface Settings {
  fov: number; // 30..110
  sensitivity: number; // 0..2 (1 = 100%)
  volume: number; // 0..1 (sound effects)
  music: number; // 0..1 (background music; 0 = off)
  renderDistance: number; // chunks, 2..16
  bobbing: boolean;
  brightness: number; // 0 moody .. 1 bright
  hotbar: number[];
  // v11 voice chat (the microphone itself is never turned on by a setting: each time, the player turns it on)
  voiceOpenMic: boolean; // false: push-to-talk (hold V)
  voiceHear: boolean;
  voiceVolume: number; // 0..1
  voiceMuted: string[]; // names muted
}

const KEY = "steve_craft_settings";
const DEFAULTS: Settings = {
  fov: 70,
  sensitivity: 1,
  volume: 0.7,
  music: 0.5,
  renderDistance: 8,
  bobbing: true,
  brightness: 0.5,
  hotbar: DEFAULT_HOTBAR.slice(),
  voiceOpenMic: false,
  voiceHear: true,
  voiceVolume: 0.8,
  voiceMuted: [],
};

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, v: string): void {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* ignore */
  }
}

export function loadSettings(): Settings {
  try {
    const raw = read(KEY);
    if (!raw) return { ...DEFAULTS, hotbar: DEFAULTS.hotbar.slice(), voiceMuted: [] };
    const s = { ...DEFAULTS, ...JSON.parse(raw) } as Settings;
    if (!Array.isArray(s.hotbar) || s.hotbar.length !== 9) s.hotbar = DEFAULTS.hotbar.slice();
    if (!Array.isArray(s.voiceMuted)) s.voiceMuted = [];
    s.voiceMuted = s.voiceMuted.filter((n) => typeof n === "string").slice(0, 500);
    return s;
  } catch {
    return { ...DEFAULTS, hotbar: DEFAULTS.hotbar.slice(), voiceMuted: [] };
  }
}

export function saveSettings(s: Settings): void {
  write(KEY, JSON.stringify(s));
}

/** The player's random name, kept per browser. */
export function storedName(): string {
  const n = read(NAME_STORAGE_KEY);
  if (n && NAME_RE.test(n)) return n;
  const fresh = randomName();
  write(NAME_STORAGE_KEY, fresh);
  return fresh;
}

export function rememberName(n: string): void {
  write(NAME_STORAGE_KEY, n);
}

/** Random per-browser token: lets the server remember where you were and who built what. */
export function clientToken(): string {
  let t = read("steve_craft_token");
  if (!t || !/^[A-Za-z0-9-]{16,64}$/.test(t)) {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    t = [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
    write("steve_craft_token", t);
  }
  return t;
}
