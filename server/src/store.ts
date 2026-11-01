// Disk persistence for one shard. Everything lives under WORLD_DIR/shard-N/ so a single volume mount
// (e.g. Railway volume at /data with WORLD_DIR=/data) keeps every world across restarts and deploys.
//
//   meta.json     seed + format version
//   edits.bin     "GPX1" | u32 count | count * (u32 cell index, u8 block id)  - the world's diff vs. the seed
//   log.ndjson    append-only edit log used by the admin rollbacks
//   players.json  last position per player key, so returning players resume where they were

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface EditEntry {
  t: number; // ms epoch
  i: number; // cell index
  o: number; // old id
  n: number; // new id
  k: string; // player key (hashed token) or "admin"
  p: string; // player name
  ip: string; // hashed ip
}

export interface SavedPos {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  t: number;
}

const MAGIC = 0x31585047; // "GPX1" little-endian

export class ShardStore {
  readonly dir: string;
  private pendingLog: string[] = [];

  constructor(worldDir: string, shard: number) {
    this.dir = join(worldDir, `shard-${shard}`);
    mkdirSync(this.dir, { recursive: true });
  }

  private path(name: string): string {
    return join(this.dir, name);
  }

  private atomicWrite(name: string, data: Buffer | string): void {
    const tmp = this.path(name + ".tmp");
    writeFileSync(tmp, data);
    renameSync(tmp, this.path(name));
  }

  /** Returns false if the stored world was made with a different seed or terrain version (and moves it aside). */
  checkSeed(seed: number, gen: number): boolean {
    const p = this.path("meta.json");
    if (!existsSync(p)) {
      this.atomicWrite("meta.json", JSON.stringify({ seed, gen, format: 1, created: new Date().toISOString() }));
      return true;
    }
    try {
      const meta = JSON.parse(readFileSync(p, "utf8"));
      if (meta.seed === seed && (meta.gen ?? 1) === gen) return true;
    } catch {
      /* fall through */
    }
    const stamp = Date.now();
    for (const f of ["edits.bin", "log.ndjson", "players.json", "meta.json", "animals.json", "water.json", "items.json", "containers.json", "time.json"]) {
      if (existsSync(this.path(f))) renameSync(this.path(f), this.path(`${f}.seedchange-${stamp}`));
    }
    this.atomicWrite("meta.json", JSON.stringify({ seed, gen, format: 1, created: new Date().toISOString() }));
    return false;
  }

  loadEdits(): Map<number, number> {
    const out = new Map<number, number>();
    const p = this.path("edits.bin");
    if (!existsSync(p)) return out;
    const buf = readFileSync(p);
    if (buf.length < 8 || buf.readUInt32LE(0) !== MAGIC) throw new Error(`bad edits file ${p}`);
    const n = buf.readUInt32LE(4);
    let o = 8;
    for (let k = 0; k < n && o + 5 <= buf.length; k++, o += 5) out.set(buf.readUInt32LE(o), buf[o + 4]);
    return out;
  }

  saveEdits(edits: Map<number, number>): void {
    const buf = Buffer.alloc(8 + edits.size * 5);
    buf.writeUInt32LE(MAGIC, 0);
    buf.writeUInt32LE(edits.size, 4);
    let o = 8;
    const keys = [...edits.keys()].sort((a, b) => a - b);
    for (const i of keys) {
      buf.writeUInt32LE(i, o);
      buf[o + 4] = edits.get(i)!;
      o += 5;
    }
    this.atomicWrite("edits.bin", buf);
  }

  queueLog(e: EditEntry): void {
    this.pendingLog.push(JSON.stringify(e));
  }

  flushLog(): void {
    if (this.pendingLog.length === 0) return;
    appendFileSync(this.path("log.ndjson"), this.pendingLog.join("\n") + "\n");
    this.pendingLog = [];
  }

  /** Loads the edit log (newest last), keeping at most `max` entries; compacts the file when it grows. */
  loadLog(max = 1_000_000): EditEntry[] {
    const p = this.path("log.ndjson");
    if (!existsSync(p)) return [];
    const lines = readFileSync(p, "utf8").split("\n");
    const out: EditEntry[] = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip a torn line from a crash */
      }
    }
    if (out.length > max) {
      const keep = out.slice(out.length - max);
      this.atomicWrite("log.ndjson", keep.map((e) => JSON.stringify(e)).join("\n") + "\n");
      return keep;
    }
    return out;
  }

  rewriteLog(entries: EditEntry[]): void {
    this.atomicWrite("log.ndjson", entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }

  logBytes(): number {
    const p = this.path("log.ndjson");
    return existsSync(p) ? statSync(p).size : 0;
  }

  loadPlayers(): Map<string, SavedPos> {
    const p = this.path("players.json");
    if (!existsSync(p)) return new Map();
    try {
      return new Map(Object.entries(JSON.parse(readFileSync(p, "utf8"))));
    } catch {
      return new Map();
    }
  }

  savePlayers(players: Map<string, SavedPos>): void {
    // Keep the 5000 most recent.
    const list = [...players.entries()].sort((a, b) => b[1].t - a[1].t).slice(0, 5000);
    this.atomicWrite("players.json", JSON.stringify(Object.fromEntries(list)));
  }

  resetWorld(): void {
    const stamp = Date.now();
    for (const f of ["edits.bin", "players.json", "items.json", "containers.json", "time.json"]) {
      if (existsSync(this.path(f))) renameSync(this.path(f), this.path(`${f}.reset-${stamp}`));
    }
  }
}
