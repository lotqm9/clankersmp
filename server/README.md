# $STEVE Craft game server

One Node process, one port: HTTP (`/health`, `/status`, `/admin/*`) and the WebSocket game protocol (`stevecraft`,
versioned by `PROTOCOL_VERSION` in `shared/constants.ts`, now 12). It hosts "Server 1" always and opens "Server 2",
"Server 3", ... only when every open server is full (100 each). New players join the least-full open server.

## Build

From `sites/steve-survival/`:

```
npm ci                      # or copy node_modules from a sibling checkout
npm run build:server        # -> server/dist/server.mjs (one file, no npm deps at runtime)
npm test                    # 300+ tests, run serially
```

## Deploy (Railway project and service `steve-game`; Laith or main runs it)

`node ship.mjs` in `sites/steve-survival` links this folder to Railway project/service `steve-game`, runs
`railway up --ci` from here, deploys the site, and waits for `/status` to say `"game": "stevecraft", "protocol": 12`.

Keep **one replica**: the world lives in this process and on its volume. On SIGTERM it saves every world first;
worlds are also saved every 5 seconds while they have unsaved edits. `railway.json` sets `requiredMountPath: /data`,
so a deploy without the volume fails instead of silently losing builds.

### The volume: the builder's world is kept

The `steve-game` service's `/data` volume holds the old $STEVE Craft builder world (`/data/shard-1/...`,
`/data/salt.txt`, `/data/bans.json`, `/data/stats.json`). The survival server never touches it: the Dockerfile sets
`SURVIVAL_WORLD_DIR=/data/survival`, so the survival world (a fresh one, seed 1014) and its own salt, bans and stats
live under `/data/survival/`. Rolling back to the builder (sites/steve-game) finds its world where it left it.

### Variables

| Name | Required | Value |
| --- | --- | --- |
| `ADMIN_SECRET` | yes | random string, 16+ characters; enables `/admin/*` (already set on the `steve-game` service) |
| `SURVIVAL_WORLD_DIR` | no | default `/data/survival` (set in the Dockerfile; wins over `WORLD_DIR`) |
| `WORLD_DIR` | no | used only when `SURVIVAL_WORLD_DIR` is unset (tests, local runs) |
| `PORT` | no | Railway sets it; default 8080 |
| `WORLD_SEED` | no | default 1014; changing it starts a fresh world (the old one is moved aside) |
| `COIN_CA` (or `STEVE_CA`) | at launch | the coin's mint address. Empty: the meter says "starts at launch" (Tab, pause menu, the hub's board) |
| `CHARITY_NAME` | no | default "Gamers Outreach" (Dockerfile) |
| `CHARITY_X` | no | default "GamersOutreach" (Dockerfile), without @ |
| `SOLANA_RPC_URL` | no | default `https://api.mainnet-beta.solana.com` (public); a private RPC is more reliable |
| `ALLOWED_ORIGINS` | recommended | `https://www.stevepumpfun.com,https://stevepumpfun.com` (case-insensitive, with or without a trailing slash). A refused origin is logged as `[origin] refused <origin>` |
| `TRUST_PROXY` | no | auto-on on Railway; reads the client IP from `X-Forwarded-For` |
| `MAX_CONNECTIONS_PER_IP` | no | default 12 |
| `MAX_SHARDS` | no | default 8 |
| `MAX_PLAYERS_PER_SHARD` | no | default 100 |
| `DEV_COMMANDS` | never in production | `1` enables test commands: `/tp x y z`, `/time t`, `/summon <animal or mob> [n] [d]`, `/mobs on\|off\|clear\|freeze`, `/give <item> [n]`, `/gamemode survival\|creative`, `/kill`, `/hunger n`, `/hurt n`, `/grow` |
| `GAMEMODE`, `ANIMALS`, `MOBS` | tests only | `creative`; `0`; `0` |
| `TICK_STATS` | no | `1` logs CPU, heap and RSS and the tick time per system every 10 s |
| `VOICE_OFF` | no | `1` turns proximity voice chat off (needs a restart) |

Changing `COIN_CA`, `CHARITY_NAME` or `CHARITY_X` needs only a restart.

### The old builder page

The builder's client (protocol 4, maybe still open in a tab or cached) sends a hello with no protocol name. The
server answers `{"t": "kick", "reason": "The game was updated. Please refresh the page.", "server": 12}`, which that
page reads as an update: it reloads itself once (into the new game, once the site is deployed), and if it is still
the old page after that it says "Can't join right now: The game was updated. Please refresh the page." A hello from
another game's protocol is refused ("This is the $STEVE Craft server.").

### Charity meter

With `COIN_CA` set, the server reads the coin's on-chain charity total about once a minute (`server/src/charity.ts`,
plain JSON-RPC, no API keys): the pump.fun charity route (fee-sharing config -> donation PDA `total_donated`, plus
what waits in the donation PDA and the charity's share of undistributed creator fees). If the coin's fees do not go
to a donation PDA it says "Total not available yet" and shows no number. No number is ever made up.

### Public status (`GET /status`, CORS open)

```json
{ "ok": true, "game": "stevecraft", "protocol": 12, "worldgen": 4, "villages": ["Larkholm", "Thistle End", "Mossford", "Pennywhistle"],
  "hub": { "roads": ["Larkholm", "Thistle End", "Mossford", "Pennywhistle", "Harbour"], "kept": 0, "boats": 6 },
  "voice": { "on": true, "talking": 0 }, "uptime": 120, "players": 12, "shards": [{ "n": 1, "players": 12, "cap": 100 }],
  "week": { "players": 340, "today": 61 }, "peak": { "players": 44, "at": 1760000000000 },
  "charity": { "state": "prelaunch", "name": "Gamers Outreach", "x": "GamersOutreach", "mint": null } }
```

## Files on the volume (under `/data/survival/`)

```
salt.txt, bans.json, stats.json      ip-hash salt, bans, unique players per day (hashed keys)
shard-1/meta.json                    seed + terrain version
shard-1/edits.bin                    the world (its difference from the seeded terrain)
shard-1/log.ndjson                   every edit (used for rollbacks)
shard-1/players.json                 per player key: position, inventory, health, food, bed, game mode
shard-1/items.json, containers.json  dropped items; furnaces and chests
shard-1/time.json, animals.json, water.json, villages.json, villagers.json, hub.json, voice-mutes.json, chat.log
```

## Admin API

All admin calls need `Authorization: Bearer $ADMIN_SECRET`. `shard` defaults to 1.

```
curl -H "Authorization: Bearer $ADMIN_SECRET" https://steve-game-production.up.railway.app/admin/players
curl -X POST ... -d '{"player":"DiamondMiner_7168","minutes":120}' .../admin/rollback
curl -X POST ... -d '{"area":{"x1":270,"z1":250,"x2":300,"z2":280},"minutes":30}' .../admin/rollback
curl ... ".../admin/chat?shard=1&lines=200"
curl -X POST ... -d '{"player":"DiamondMiner_7168"}' .../admin/kick
curl -X POST ... -d '{"player":"DiamondMiner_7168","minutes":1440}' .../admin/ban
curl -X POST ... -d '{"ip":"3f2a9c..."}' .../admin/unban
curl -X POST ... -d '{"player":"DiamondMiner_7168","mode":"creative"}' .../admin/gamemode
curl -X POST ... -d '{"name":"DiamondMiner_7168"}' .../admin/voice-mute
curl -X POST ... -d '{"text":"Server restarting in 5 minutes"}' .../admin/say
curl -X POST ... .../admin/save
curl -X POST ... -d '{"shard":1,"confirm":"RESET"}' .../admin/reset
```

## Protections

Edits: reach 5, place 6/s, break 10/s, dig time checked with the tool in hand, the spawn safe zone (radius 68: no
building, no damage), support rules, never inside a player. Items: the server owns every inventory, furnace, chest
and dropped item (a fuzz test checks no click sequence creates or loses an item). Movement: speed, teleport, inside
blocks and hover checks. Chat: 100 characters, rate limits, a profanity filter; names that impersonate staff are
refused. Connections: 12 per IP, 4 KB max message, bans by IP hash.
