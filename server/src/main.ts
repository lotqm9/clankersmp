// clankersmp game server (the survival engine it forked from $STEVE Craft): HTTP (health, status, admin) + WebSocket
// game protocol on one port.
//
// Env:
//   PORT                    listen port (default 8787)
//   SURVIVAL_WORLD_DIR      where the survival worlds are saved; the Dockerfile sets /data/survival, so the old
//                           builder world on the same volume (/data/shard-1 and the rest) is never touched
//   WORLD_DIR               used when SURVIVAL_WORLD_DIR is not set (tests, local runs); default ./data
//   ADMIN_SECRET            enables /admin/* (Bearer token); at least 16 characters
//   WORLD_SEED              terrain seed (default 1014)
//   COIN_CA                 the coin's mint address (STEVE_CA is read too); empty = the meter "starts at launch"
//   CHARITY_NAME            the charity's name (empty until it is chosen)
//   CHARITY_X               the charity's X handle, without @ (optional)
//   SOLANA_RPC_URL          default https://api.mainnet-beta.solana.com (public)
//   TRUST_PROXY             "1" to read the client IP from X-Forwarded-For (auto-on when on Railway)
//   MAX_CONNECTIONS_PER_IP  default 12
//   ALLOWED_ORIGINS         optional comma list of allowed browser origins for the WebSocket
//   MAX_SHARDS              default 8
//   MAX_PLAYERS_PER_SHARD   default 100 (shared/constants.ts)

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { DEFAULT_SEED, PROTOCOL_NAME, PROTOCOL_VERSION, TICK_MS, WORLDGEN_VERSION } from "../../shared/constants.ts";
import { randomName } from "../../shared/names.ts";
import type { CharityInfo, ShardInfo } from "../../shared/protocol.ts";
import { CharityMeter } from "./charity.ts";
import { acceptableName } from "./filter.ts";
import { PLAYER_CAP, Shard, type Player, type ShardHooks } from "./shard.ts";
import { PlayerStats } from "./stats.ts";
import { log, normOrigin, safeEqual, sha } from "./util.ts";

const env = process.env;
const PORT = Number(env.PORT ?? 8787);
const WORLD_DIR = env.SURVIVAL_WORLD_DIR || env.WORLD_DIR || join(process.cwd(), "data");
const ADMIN_SECRET = (env.ADMIN_SECRET ?? "").trim();
const SEED = Number(env.WORLD_SEED ?? DEFAULT_SEED);
const ON_RAILWAY = Boolean(env.RAILWAY_ENVIRONMENT || env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_PROJECT_ID);
const TRUST_PROXY = env.TRUST_PROXY ? env.TRUST_PROXY === "1" || env.TRUST_PROXY === "true" : ON_RAILWAY;
const MAX_PER_IP = Number(env.MAX_CONNECTIONS_PER_IP ?? 12);
const ALLOWED_ORIGINS = (env.ALLOWED_ORIGINS ?? "").split(",").map(normOrigin).filter(Boolean);
const refusedOrigins = new Map<string, number>(); // origin -> last logged (ms)
const MAX_SHARDS = Number(env.MAX_SHARDS ?? 8);
const STARTED = Date.now();
// Charity meter: the coin's mint address. Empty until launch, which shows "starts at launch".
const COIN_CA = (env.COIN_CA || env.STEVE_CA || "").trim();
// The charity is not chosen yet: while both are empty the game just says "charity".
const CHARITY_NAME = (env.CHARITY_NAME ?? "").trim().slice(0, 60);
const CHARITY_X = (env.CHARITY_X ?? "").trim().replace(/^@/, "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 15);
const SOLANA_RPC_URL = (env.SOLANA_RPC_URL ?? "").trim() || "https://api.mainnet-beta.solana.com";
// clankersmp: only the AIs play (each signs in with AGENT_SECRET); every other connection is a spectator that
// watches one of them. HARDCORE=1: a dead AI never comes back (hardcore.json).
const CLANKER = env.CLANKER === "1";
const AGENTS = (env.AGENTS ?? "opus,sonnet,haiku").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const AGENT_SECRET = (env.AGENT_SECRET ?? "").trim();
const MAX_SPECTATORS = Number(env.MAX_SPECTATORS ?? 400);

mkdirSync(WORLD_DIR, { recursive: true });
// Refuse to run if the world can't be saved (e.g. a volume mounted read-only or owned by another user):
// failing the deploy is better than silently losing every build.
try {
  writeFileSync(join(WORLD_DIR, ".write-test"), String(Date.now()));
} catch (e) {
  console.error(`FATAL: cannot write to WORLD_DIR=${WORLD_DIR}: ${(e as Error).message}`);
  process.exit(1);
}
const saltPath = join(WORLD_DIR, "salt.txt");
if (!existsSync(saltPath)) writeFileSync(saltPath, randomBytes(16).toString("hex"));
const SALT = readFileSync(saltPath, "utf8").trim();
const bansPath = join(WORLD_DIR, "bans.json");
const bans = new Map<string, number>(existsSync(bansPath) ? Object.entries(JSON.parse(readFileSync(bansPath, "utf8"))) : []);
const saveBans = () => writeFileSync(bansPath, JSON.stringify(Object.fromEntries(bans)));
const stats = new PlayerStats(WORLD_DIR);
const hardcorePath = join(WORLD_DIR, "hardcore.json");
const hardcore = new Map<string, { msg: string; t: number }>(existsSync(hardcorePath) ? Object.entries(JSON.parse(readFileSync(hardcorePath, "utf8"))) : []);
// when the first AI joined (sunrise of day 1): days are counted from it, 20 minutes each
const clankerStartPath = join(WORLD_DIR, "clanker-start.json");
let clankerStart = existsSync(clankerStartPath) ? Number(JSON.parse(readFileSync(clankerStartPath, "utf8")).t) || 0 : 0;

interface Conn {
  ip: string;
  ipHash: string;
  player?: Player;
  spec?: Player; // clankersmp: a spectator
  shard?: Shard;
  alive: boolean;
}

class Manager implements ShardHooks {
  shards = new Map<number, Shard>();
  conns = new Map<WebSocket, Conn>();
  perIp = new Map<string, number>();
  private nextId = 1;
  private countsDirty = false;
  private ticks = 0;

  shard(n: number): Shard {
    let s = this.shards.get(n);
    if (!s) {
      s = new Shard(n, SEED, WORLD_DIR, this);
      this.shards.set(n, s);
    }
    return s;
  }

  /** Open shards: Server 1 always, plus any shard with players in it. */
  open(): Shard[] {
    return [...this.shards.values()].filter((s) => s.n === 1 || s.count > 0).sort((a, b) => a.n - b.n);
  }

  /** Least-full open shard with room; a new shard opens only when every open one is full. */
  pick(requested?: number): Shard | null {
    if (requested && Number.isInteger(requested) && requested >= 1 && requested <= MAX_SHARDS) {
      const s = this.shard(requested);
      if (!s.full) return s;
    }
    const candidates = this.open().filter((s) => !s.full);
    if (candidates.length) return candidates.sort((a, b) => a.count - b.count || a.n - b.n)[0];
    for (let n = 1; n <= MAX_SHARDS; n++) {
      const s = this.shard(n);
      if (!s.full) return s;
    }
    return null;
  }

  counts(): ShardInfo[] {
    return this.open().map((s) => s.info_());
  }

  charity(): CharityInfo {
    const r = meter.current;
    const who = { ...(CHARITY_NAME ? { name: CHARITY_NAME } : {}), ...(CHARITY_X ? { x: CHARITY_X } : {}) };
    if (r.state !== "live") return { state: r.state, ...who };
    return { state: "live", ...who, totalSol: r.totalSol, donatedSol: r.donatedSol, pendingSol: r.pendingSol, updatedAt: r.updatedAt };
  }

  broadcastCharity(): void {
    const msg = JSON.stringify({ t: "charity", c: this.charity() });
    for (const s of this.shards.values()) for (const p of s.players.values()) if (p.ws.readyState === 1) p.ws.send(msg);
  }

  onCountChange(): void {
    this.countsDirty = true;
  }

  kick(p: Player, reason: string): void {
    try {
      if (p.ws.readyState === 1) p.ws.send(JSON.stringify({ t: "kick", reason }));
      p.ws.close(4000, reason.slice(0, 100));
    } catch {
      p.ws.terminate();
    }
  }

  died(p: Player, msg: string): void {
    if (!p.agent || process.env.HARDCORE !== "1") return;
    hardcore.set(p.name, { msg, t: Date.now() });
    writeFileSync(hardcorePath, JSON.stringify(Object.fromEntries(hardcore)));
    log(`[hardcore] ${msg}`);
  }

  deathOf(name: string): string | null {
    return hardcore.get(name)?.msg ?? null;
  }

  allocId(): number {
    const used = new Set<number>();
    for (const s of this.shards.values()) for (const id of [...s.players.keys(), ...s.specs.keys()]) used.add(id);
    for (let k = 0; k < 65535; k++) {
      const id = this.nextId;
      this.nextId = (this.nextId % 65534) + 1;
      if (!used.has(id)) return id;
    }
    return 1;
  }

  tick(): void {
    this.ticks++;
    if (this.ticks % 100 === 0) {
      let online = 0;
      for (const s of this.shards.values()) {
        online += s.count;
        for (const p of s.players.values()) stats.seen(p.key);
      }
      stats.online(online);
      if (this.ticks % 1200 === 0) stats.save();
    }
    for (const s of this.shards.values()) {
      try {
        s.tick();
      } catch (e) {
        log(`tick error on shard ${s.n}`, e);
      }
    }
    if (this.countsDirty) {
      this.countsDirty = false;
      const shards = this.counts();
      for (const s of this.shards.values()) {
        const msg = JSON.stringify({ t: "count", shard: s.info_(), shards });
        for (const p of s.players.values()) if (p.ws.readyState === 1) p.ws.send(msg);
      }
    }
  }

  saveAll(): void {
    for (const s of this.shards.values()) s.save(true);
    stats.save();
  }

  findOnline(name: string): { shard: Shard; player: Player } | null {
    for (const s of this.shards.values()) {
      const p = s.findPlayer(name);
      if (p) return { shard: s, player: p };
    }
    return null;
  }
}

const meter = new CharityMeter(COIN_CA, SOLANA_RPC_URL);
const manager = new Manager();
manager.shard(1);
// Re-open shards that have saved worlds so their builds are ready.
for (let n = 2; n <= MAX_SHARDS; n++) if (existsSync(join(WORLD_DIR, `shard-${n}`, "edits.bin"))) manager.shard(n);

function clientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    const xf = req.headers["x-forwarded-for"];
    const first = (Array.isArray(xf) ? xf[0] : xf)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

// ------------------------------------------------------------------ HTTP

function json(res: ServerResponse, status: number, body: unknown, cors = false): void {
  const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
  if (cors) headers["access-control-allow-origin"] = "*";
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 16384) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

function adminAuthorized(req: IncomingMessage): boolean {
  if (ADMIN_SECRET.length < 16) return false;
  const h = req.headers.authorization ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : String(req.headers["x-admin-secret"] ?? "");
  return safeEqual(token, ADMIN_SECRET);
}

async function handleAdmin(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (ADMIN_SECRET.length < 16) return json(res, 503, { error: "admin disabled: set ADMIN_SECRET (16+ chars)" });
  if (!adminAuthorized(req)) return json(res, 401, { error: "unauthorized" });
  const route = url.pathname.replace(/^\/admin\/?/, "");
  const body = req.method === "POST" ? await readBody(req) : {};
  const shardN = Number(body.shard ?? url.searchParams.get("shard") ?? 1);
  const shard = manager.shards.get(shardN);
  log(`admin ${req.method} /${route} shard=${shardN}`);
  switch (route) {
    case "players": {
      const hours = Number(url.searchParams.get("hours") ?? 24);
      const out = [...manager.shards.values()].map((s) => ({
        shard: s.n,
        online: [...s.players.values()].map((p) => ({ name: p.name, key: p.key, ip: p.ip, x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) })),
        editors: s.editors(Date.now() - hours * 3600_000).slice(0, 200),
        edits: s.edits.size,
      }));
      return json(res, 200, { shards: out, bans: Object.fromEntries(bans) });
    }
    case "rollback": {
      if (!shard) return json(res, 404, { error: "no such shard" });
      const minutes = Number(body.minutes ?? 60);
      const area = body.area as { x1: number; z1: number; x2: number; z2: number; y1?: number; y2?: number } | undefined;
      const player = typeof body.player === "string" ? body.player : undefined;
      const key = typeof body.key === "string" ? body.key : undefined;
      const ip = typeof body.ip === "string" ? body.ip : undefined;
      if (!player && !key && !ip && !area) return json(res, 400, { error: "give player, key, ip or area" });
      if (area && ![area.x1, area.z1, area.x2, area.z2].every(Number.isFinite)) return json(res, 400, { error: "area needs x1,z1,x2,z2" });
      const reverted = shard.rollback({ name: player, key, ip, area, sinceMs: Date.now() - minutes * 60_000 });
      if (reverted) shard.system(`An admin rolled back ${reverted} block${reverted === 1 ? "" : "s"}.`);
      return json(res, 200, { reverted });
    }
    case "reset": {
      if (!shard) return json(res, 404, { error: "no such shard" });
      if (body.confirm !== "RESET") return json(res, 400, { error: 'send {"confirm":"RESET"} to wipe this world' });
      shard.resetWorld();
      return json(res, 200, { ok: true });
    }
    case "gamemode": {
      // Creative is for admins only: building in the safe zone, the block picker, no damage.
      const f = typeof body.player === "string" ? manager.findOnline(body.player) : null;
      if (!f) return json(res, 404, { error: "player not online" });
      const mode = body.mode === "creative" ? "creative" : body.mode === "survival" ? "survival" : null;
      if (!mode) return json(res, 400, { error: 'mode must be "survival" or "creative"' });
      f.shard.survival.setGameMode(f.player, mode);
      return json(res, 200, { ok: true, player: f.player.name, mode });
    }
    case "voice-mute": {
      // v11: turn one player's voice chat off (or on again: {"mute": false}); kept by browser key across restarts
      const who = typeof body.name === "string" ? body.name : typeof body.player === "string" ? body.player : "";
      const f = who ? manager.findOnline(who) : null;
      if (!f) return json(res, 404, { error: "player not online" });
      const mute = body.mute !== false;
      f.shard.voice.setAdminMute(f.player, mute);
      f.shard.notice(f.player, mute ? "An admin turned your voice chat off." : "An admin turned your voice chat back on.");
      return json(res, 200, { ok: true, player: f.player.name, muted: mute });
    }
    case "kick": {
      const f = typeof body.player === "string" ? manager.findOnline(body.player) : null;
      if (!f) return json(res, 404, { error: "player not online" });
      manager.kick(f.player, String(body.reason ?? "Kicked by an admin"));
      return json(res, 200, { ok: true });
    }
    case "ban": {
      let ipHash = typeof body.ip === "string" ? body.ip : "";
      if (!ipHash && typeof body.player === "string") {
        const f = manager.findOnline(body.player);
        if (f) ipHash = f.player.ip;
        else {
          for (const s of manager.shards.values()) {
            const e = [...s.log].reverse().find((x) => x.p.toLowerCase() === String(body.player).toLowerCase());
            if (e) {
              ipHash = e.ip;
              break;
            }
          }
        }
      }
      if (!ipHash) return json(res, 404, { error: "unknown player/ip" });
      const minutes = Number(body.minutes ?? 24 * 60);
      bans.set(ipHash, Date.now() + minutes * 60_000);
      saveBans();
      for (const s of manager.shards.values()) for (const p of s.players.values()) if (p.ip === ipHash) manager.kick(p, "Banned");
      return json(res, 200, { banned: ipHash, until: bans.get(ipHash) });
    }
    case "unban": {
      bans.delete(String(body.ip ?? ""));
      saveBans();
      return json(res, 200, { ok: true });
    }
    case "chat": {
      if (!shard) return json(res, 404, { error: "no such shard" });
      const lines = Math.max(1, Math.min(500, Number(url.searchParams.get("lines") ?? 200)));
      return json(res, 200, { shard: shard.n, lines: shard.recentChat.slice(-lines) });
    }
    case "say": {
      const text = String(body.text ?? "").slice(0, 200);
      if (!text) return json(res, 400, { error: "text required" });
      for (const s of manager.shards.values()) if (!body.shard || s.n === shardN) s.system(`[Admin] ${text}`);
      return json(res, 200, { ok: true });
    }
    case "save": {
      manager.saveAll();
      return json(res, 200, { ok: true });
    }
    default:
      return json(res, 404, { error: "unknown admin route" });
  }
}

function hubStatus(): { roads: string[]; kept: number; boats: number } | null {
  const s = manager.shards.get(1);
  if (!s) return null;
  const h = s.info.hub;
  const slots = h.harbour?.slots ?? [];
  return {
    roads: (h.roads ?? []).filter((r) => r.reached).map((r) => r.to),
    kept: s.hubPlan.keep.length,
    boats: slots.filter((q) => s.boats.near(q.x, q.z, 2.5) > 0).length,
  };
}

/** Public numbers for the site and the daily update card (CORS open, no secrets). */
function status(): Record<string, unknown> {
  const shards = manager.counts();
  const c = manager.charity();
  return {
    ok: true,
    game: PROTOCOL_NAME,
    protocol: PROTOCOL_VERSION,
    worldgen: WORLDGEN_VERSION,
    // v9: the villages Server 1 has (decided once per world: only where there were no edits)
    villages: manager.shards.get(1)?.info.villages.list.map((v) => v.name) ?? [],
    // v10: the bigger hub on Server 1: where its signposted roads go, and how many tiles it left alone for builds
    hub: hubStatus(),
    // v11: proximity voice on (VOICE_OFF=1 turns it off), and how many are talking on Server 1 right now
    voice: { on: !(manager.shards.get(1)?.voice.off ?? process.env.VOICE_OFF === "1"), talking: manager.shards.get(1)?.voice.talkingNow.length ?? 0 },
    uptime: Math.round((Date.now() - STARTED) / 1000),
    players: shards.reduce((a, s) => a + s.players, 0),
    shards,
    week: { players: stats.week(), today: stats.today() },
    peak: stats.peak,
    charity: { ...c, mint: COIN_CA || null, ...(meter.current.note ? { note: meter.current.note } : {}) },
  };
}

/** clankersmp: the AIs for the site (who is alive, where, how they are doing), the world clock and the audience. */
function clankerStatus() {
  const s = manager.shards.get(1);
  const time = s?.worldTime() ?? 0;
  return {
    ok: true,
    time: time % 24000,
    day: clankerStart ? Math.floor((Date.now() - clankerStart) / 1_200_000) + 1 : 0,
    started: clankerStart || null,
    watching: s?.specs.size ?? 0,
    agents: AGENTS.map((name) => {
      const p = s?.agentByName(name);
      const death = hardcore.get(name);
      const base = { name, online: !!p, dead: !!death || !!p?.sv.dead, death: death?.msg ?? null, diedAt: death?.t ?? null };
      if (!p || !s) return base;
      const st = s.survival.stats(p);
      return { ...base, hp: st.hp, food: st.food, x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1), held: p.held };
    }),
  };
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" });
    return res.end();
  }
  if (url.pathname === "/health" || url.pathname === "/status") return json(res, 200, status(), true);
  if (url.pathname === "/clanker" && CLANKER) return json(res, 200, clankerStatus(), true);
  if (url.pathname.startsWith("/admin")) {
    handleAdmin(req, res, url).catch((e) => json(res, 400, { error: String(e.message ?? e) }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("clankersmp game server (WebSocket). Watch at https://clankersmp.fun\n");
});

// ------------------------------------------------------------------ WebSocket

const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });

server.on("upgrade", (req, socket, head) => {
  const origin = req.headers.origin ?? "";
  if (ALLOWED_ORIGINS.length && origin && !ALLOWED_ORIGINS.includes(normOrigin(origin))) {
    // Logged (at most once a minute per origin) so a missing origin can be added to the list.
    const now = Date.now();
    if ((refusedOrigins.get(origin) ?? 0) < now - 60_000 && refusedOrigins.size < 500) {
      refusedOrigins.set(origin, now);
      log(`[origin] refused ${origin.slice(0, 120).replace(/[^ -~]/g, "?")}`);
    }
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  const ip = clientIp(req);
  const ipHash = sha(ip + SALT);
  const until = bans.get(ipHash);
  if (until && until > Date.now()) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  if ((manager.perIp.get(ipHash) ?? 0) >= MAX_PER_IP) {
    socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => accept(ws, ip, ipHash));
});

function accept(ws: WebSocket, ip: string, ipHash: string): void {
  const conn: Conn = { ip, ipHash, alive: true };
  manager.conns.set(ws, conn);
  manager.perIp.set(ipHash, (manager.perIp.get(ipHash) ?? 0) + 1);
  ws.on("pong", () => (conn.alive = true));
  const helloTimer = setTimeout(() => ws.close(4001, "no hello"), 10_000);

  ws.on("message", (data: RawData, isBinary: boolean) => {
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    try {
      if (conn.player && conn.shard) {
        conn.shard.onMessage(conn.player, buf, isBinary);
        return;
      }
      if (conn.spec && conn.shard) {
        conn.shard.onSpectatorMessage(conn.spec, buf, isBinary);
        return;
      }
      if (isBinary) return;
      const msg = JSON.parse(buf.toString("utf8"));
      if (msg?.t !== "hello") return;
      clearTimeout(helloTimer);
      // The old $STEVE Craft builder page (protocol 1-4, maybe still open in a tab, or cached) sends no protocol name.
      // Answer it the way that page reads as "the game was updated": this kick, with a server version above its own,
      // makes it reload itself once into the new game (and after that it says "Please refresh the page").
      if (msg.g === undefined || msg.g === null) {
        ws.send(JSON.stringify({ t: "kick", reason: "The game was updated. Please refresh the page.", server: PROTOCOL_VERSION, g: PROTOCOL_NAME }));
        ws.close(4002, "version");
        return;
      }
      // Another game's client speaks a different protocol.
      if (msg.g !== PROTOCOL_NAME) {
        ws.send(JSON.stringify({ t: "kick", reason: "This is the clankersmp server.", g: PROTOCOL_NAME }));
        ws.close(4004, "game");
        return;
      }
      if (msg.v !== PROTOCOL_VERSION) {
        ws.send(JSON.stringify({ t: "kick", reason: "The game was updated. Please refresh the page.", server: PROTOCOL_VERSION, g: PROTOCOL_NAME }));
        ws.close(4002, "version");
        return;
      }
      if (CLANKER) {
        const shard = manager.shard(1);
        const nm = typeof msg.name === "string" ? msg.name.toLowerCase() : "";
        const isAgent = AGENTS.includes(nm) && AGENT_SECRET.length >= 16 && typeof msg.agent === "string" && safeEqual(msg.agent, AGENT_SECRET);
        if (!isAgent) {
          if (shard.specs.size >= MAX_SPECTATORS) {
            ws.send(JSON.stringify({ t: "kick", reason: "Too many people are watching right now. Try again in a minute." }));
            ws.close(4003, "full");
            return;
          }
          conn.shard = shard;
          conn.spec = shard.joinSpectator(ws, manager.allocId(), typeof msg.follow === "string" ? msg.follow.toLowerCase().slice(0, 16) : "", ipHash);
          return;
        }
        const death = hardcore.get(nm);
        if (death && process.env.HARDCORE === "1") {
          ws.send(JSON.stringify({ t: "kick", reason: `dead: ${death.msg}` }));
          ws.close(4005, "dead");
          return;
        }
        // the AI's process restarted: the new connection replaces the old body
        for (const p of shard.players.values()) if (p.name === nm) {
          manager.kick(p, "Replaced by a new connection.");
          shard.leave(p);
        }
        if (!clankerStart) {
          // the experiment begins: the first AI ever to join wakes up at sunrise on day 1
          shard.skipToMorning();
          clankerStart = Date.now();
          writeFileSync(clankerStartPath, JSON.stringify({ t: clankerStart }));
        }
        conn.shard = shard;
        conn.player = shard.join(ws, manager.allocId(), nm, sha("agent:" + nm), ipHash, true);
        log(`agent ${nm} joined`);
        return;
      }
      const shard = manager.pick(Number(msg.shard) || undefined);
      if (!shard) {
        ws.send(JSON.stringify({ t: "kick", reason: "All servers are full. Try again in a minute!" }));
        ws.close(4003, "full");
        return;
      }
      const token = typeof msg.token === "string" && /^[A-Za-z0-9-]{16,64}$/.test(msg.token) ? msg.token : randomBytes(16).toString("hex");
      const key = sha("k:" + token);
      let name = acceptableName(msg.name) ? msg.name : randomName();
      // Same browser joining again (refresh, second tab): the newest connection wins.
      for (const s of manager.shards.values())
        for (const p of s.players.values()) if (p.key === key) manager.kick(p, "You joined from another tab.");
      const taken = (n: string) => [...manager.shards.values()].some((s) => [...s.players.values()].some((p) => p.key !== key && p.name.toLowerCase() === n.toLowerCase()));
      for (let k = 0; taken(name) && k < 20; k++) name = randomName();
      const id = manager.allocId();
      conn.shard = shard;
      conn.player = shard.join(ws, id, name, key, ipHash);
      stats.seen(key);
      log(`join ${name} -> ${shard.name} (${shard.count}/${PLAYER_CAP})`);
    } catch (e) {
      log("message error", e);
    }
  });

  ws.on("close", () => {
    clearTimeout(helloTimer);
    manager.conns.delete(ws);
    const n = (manager.perIp.get(ipHash) ?? 1) - 1;
    if (n <= 0) manager.perIp.delete(ipHash);
    else manager.perIp.set(ipHash, n);
    if (conn.player && conn.shard) {
      conn.shard.leave(conn.player);
      log(`leave ${conn.player.name} <- ${conn.shard.name}`);
    }
    if (conn.spec && conn.shard) conn.shard.leaveSpectator(conn.spec);
  });
  ws.on("error", () => ws.terminate());
}

// Heartbeat: drop dead sockets (and keep proxies from idling us out).
setInterval(() => {
  for (const [ws, c] of manager.conns) {
    if (!c.alive) {
      ws.terminate();
      continue;
    }
    c.alive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
}, 25_000);

// The game clock: 20 ticks a second on average. Timers can fire late (Windows rounds them up to ~16 ms steps, and a
// busy event loop delays them), so each wake-up runs as many ticks as real time asks for (at most 5 at once, and
// after a long stall the clock just carries on rather than racing to catch up).
let nextTick = performance.now();
let tickMs = 0;
let tickN = 0;
let cpu0 = process.cpuUsage();
if (process.env.TICK_STATS)
  setInterval(() => {
    const c = process.cpuUsage(cpu0);
    cpu0 = process.cpuUsage();
    const mem = process.memoryUsage();
    log(`cpu ${((c.user + c.system) / 1000 / 10000 * 100).toFixed(1)}% of a core over 10 s | heap ${(mem.heapUsed / 1048576).toFixed(0)} of ${(mem.heapTotal / 1048576).toFixed(0)} MB, rss ${(mem.rss / 1048576).toFixed(0)} MB`);
    const parts: string[] = [];
    for (const sh of manager.shards.values()) for (const [k, v] of sh.prof) parts.push(`${k} ${(v / Math.max(1, tickN)).toFixed(2)}`);
    for (const sh of manager.shards.values()) sh.prof.clear();
    log(`tick avg ${(tickMs / Math.max(1, tickN)).toFixed(2)} ms over ${tickN} ticks | ${parts.join(", ")}`);
    tickMs = 0;
    tickN = 0;
  }, 10_000);
setInterval(() => {
  const now = performance.now();
  if (now - nextTick > 1000) nextTick = now;
  for (let n = 0; n < 5 && nextTick <= now; n++) {
    const t0 = performance.now();
    manager.tick();
    tickMs += performance.now() - t0;
    tickN++;
    nextTick += TICK_MS;
  }
}, 10);

meter.onChange = (r) => {
  log(`charity: ${r.state}${r.state === "live" ? ` ${r.totalSol?.toFixed(3)} SOL (donated ${r.donatedSol?.toFixed(3)}, on its way ${r.pendingSol?.toFixed(3)})` : r.note ? ` (${r.note})` : ""}`);
  manager.broadcastCharity();
};
meter.start();

server.listen(PORT, "0.0.0.0", () => {
  log(
    `clankersmp game server on :${PORT} | ${PROTOCOL_NAME} protocol v${PROTOCOL_VERSION} | world dir ${WORLD_DIR} | seed ${SEED} | ` +
      `admin ${ADMIN_SECRET.length >= 16 ? "on" : "off"} | proxy ip ${TRUST_PROXY ? "on" : "off"} | charity ${COIN_CA ? "coin set" : "starts at launch"}`,
  );
});

let shuttingDown = false;
function shutdown(sig: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${sig}: saving worlds`);
  manager.saveAll();
  for (const ws of manager.conns.keys()) {
    try {
      ws.send(JSON.stringify({ t: "kick", reason: "Server restarting. Rejoining in a moment..." }));
      ws.close(1012, "restart");
    } catch {
      /* ignore */
    }
  }
  server.close();
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (e) => log("uncaught", e));
process.on("unhandledRejection", (e) => log("unhandled", e));
