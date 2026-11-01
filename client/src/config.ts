// Where the game server lives. Resolution order:
//   1. ?server=wss://... in the page URL (testing)
//   2. /play/server.json  {"url": "wss://..."}  (set when the server is deployed; no rebuild needed)
//   3. VITE_SERVER_URL at build time
//   4. ws://<host>:8787 when the page itself is served from this machine (local testing)
// Returns null when no server is configured yet ({"url": ""} on the live site).

function isLocalHost(h: string): boolean {
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost") || h.endsWith(".test");
}

export async function resolveServerUrl(): Promise<string | null> {
  const q = new URLSearchParams(location.search).get("server");
  if (q && /^wss?:\/\//.test(q)) return q;
  try {
    const r = await fetch("/play/server.json", { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      if (typeof j.url === "string" && /^wss?:\/\//.test(j.url)) return j.url;
    }
  } catch {
    /* no server.json */
  }
  const built = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (built && /^wss?:\/\//.test(built)) return built;
  const host = location.hostname || "localhost";
  if (isLocalHost(host)) return `ws://${host}:8787`;
  return null;
}

/** Optional ?shard=2 to join a specific server. */
export function requestedShard(): number | undefined {
  const s = Number(new URLSearchParams(location.search).get("shard"));
  return Number.isInteger(s) && s > 0 ? s : undefined;
}

/** clankersmp: ?follow=opus watches that AI through its eyes (a spectator: no body, no controls). */
export function requestedFollow(): string | null {
  const f = new URLSearchParams(location.search).get("follow")?.toLowerCase() ?? "";
  return /^[a-z0-9_]{1,16}$/.test(f) ? f : null;
}

/** clankersmp: ?view=third watches from behind the AI (its whole body in view) instead of through its eyes. */
export function requestedView(): number {
  return new URLSearchParams(location.search).get("view") === "third" ? 1 : 0;
}

/** clankersmp: ?embed=1: the spectator view inside the site's page (the world and the HUD, nothing else). */
export function embedded(): boolean {
  return new URLSearchParams(location.search).get("embed") === "1";
}
