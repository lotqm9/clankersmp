// Unique players per UTC day (hashed browser keys only), kept for 14 days. Feeds "players this week" on /status
// and on the daily X update card, plus the all-time peak of players online at once.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Saved {
  days: Record<string, string[]>;
  peak: { players: number; at: number };
}

const KEEP_DAYS = 14;

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export class PlayerStats {
  private path: string;
  private days = new Map<string, Set<string>>();
  peak = { players: 0, at: 0 };
  private dirty = false;

  constructor(worldDir: string) {
    this.path = join(worldDir, "stats.json");
    if (!existsSync(this.path)) return;
    try {
      const s = JSON.parse(readFileSync(this.path, "utf8")) as Saved;
      for (const [d, keys] of Object.entries(s.days ?? {})) this.days.set(d, new Set(keys));
      if (s.peak && Number.isFinite(s.peak.players)) this.peak = s.peak;
    } catch {
      /* a broken stats file only loses the counters */
    }
  }

  /** A player (hashed key) was online now. */
  seen(key: string, now = Date.now()): void {
    const d = utcDay(now);
    let set = this.days.get(d);
    if (!set) {
      set = new Set();
      this.days.set(d, set);
      for (const old of [...this.days.keys()]) if (old < utcDay(now - KEEP_DAYS * 86400_000)) this.days.delete(old);
    }
    if (!set.has(key)) {
      set.add(key);
      this.dirty = true;
    }
  }

  online(n: number, now = Date.now()): void {
    if (n > this.peak.players) {
      this.peak = { players: n, at: now };
      this.dirty = true;
    }
  }

  /** Unique players over the last 7 UTC days (today and the 6 before it). */
  week(now = Date.now()): number {
    const all = new Set<string>();
    for (let k = 0; k < 7; k++) for (const key of this.days.get(utcDay(now - k * 86400_000)) ?? []) all.add(key);
    return all.size;
  }

  today(now = Date.now()): number {
    return this.days.get(utcDay(now))?.size ?? 0;
  }

  save(): void {
    if (!this.dirty) return;
    const out: Saved = { days: {}, peak: this.peak };
    for (const [d, keys] of this.days) out.days[d] = [...keys];
    try {
      writeFileSync(this.path + ".tmp", JSON.stringify(out));
      renameSync(this.path + ".tmp", this.path);
      this.dirty = false;
    } catch {
      /* disk issues should not stop the game */
    }
  }
}
