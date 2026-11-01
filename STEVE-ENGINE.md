# $STEVE Craft: survival

The full survival game at www.stevepumpfun.com/play: punch a tree, craft (2x2 and 3x3, a recipe book), tools from wood
to diamond, health and hunger, night mobs (Shambler, Rattler, Skitter), combat and armour, farming, animals, caves and
ores (ruby and diamond glow), flowing water, villages with ruby trading, boats and six islands, the big spawn hub with
its "punch a tree" landmark, proximity voice chat (push to talk on V) and four original piano pieces. One shared
world, 100 players a server. Charity coin partnered with @GamersOutreach (the meter reads "starts at launch" until
the coin is live). Updates on X: @SteveOnPF.

It replaces the $STEVE Craft builder (`sites/steve-game`, protocol 4), which is left as it is: it is the rollback.

- `shared/`: code used by both sides: blocks, seeded terrain (512 x 512 island, seed 1014, caves and ores), the spawn
  hub (`hub.ts`, `hub12.ts`, and the landmark in `landmark.ts`: a blocky guy in a teal shirt and blue trousers, one
  fist out, punching an oak, built one block per pixel of our own player art), Java Edition movement physics, block
  shapes, survival (items, mining, recipes, inventories, health and hunger), mobs and combat, farming, islands,
  boats, villages, villagers and trades, proximity voice, the wire protocol (`stevecraft` v12), names.
- `client/`: the game (Vite + TypeScript + three.js) in $STEVE Craft's look: the KenneyMini pixel font, grey bevelled
  buttons, dirt screens, yellow highlights, our own player skins with the gold "$"; the native in-game GUI
  (inventory, crafting, furnace, chest, trading, hotbar, hearts) drawn in code.
- `web/play/index.html` + `web/public/play/` (fonts, sounds, music): the page. `updates/`: the "what's new" entries.
- `server/`: Node + ws, authoritative. See `server/README.md` (env, the volume, admin API, /status).
- `tests/`: unit and multi-bot server tests; `tests/loadtest.ts` (50 survival bots at night) and
  `tests/voice-stress.ts`.
- `tools/`: server bundler, Vite plugins, browser checks (`survival-check.cjs`, `world-check.cjs`, `hub-check.cjs`,
  `village-check.cjs`, `voice-check.cjs`, `sound-check.cjs`, `music-check.cjs`), previews, the contact sheet.
- `LICENSES/`: every third-party file and every generated asset, with its terms. No Mojang files.
- `ship.mjs`: ships the server (Railway `steve-game`) and the site (Vercel `stevepumpfun`); `--rollback` goes back
  to the builder.

## Run locally

```
npm ci
DEV_COMMANDS=1 ADMIN_SECRET=local-dev-secret-0123456789 PORT=8811 node server/src/main.ts   # ws://localhost:8811
VITE_PORT=5233 npm run dev:client                                                         # http://127.0.0.1:5233/play/?server=ws://127.0.0.1:8811
```

The game finds its server in this order: `?server=wss://...`, then `/play/server.json` (`{"url": "wss://..."}`),
then `ws://<this host>:8787` when the page is local. With no server it shows "Server starting soon" and re-checks.

## Build and test

```
npm test                    # serially (node --test --test-concurrency=1)
npm run typecheck
npm run build:server        # server/dist/server.mjs
npm run build:client        # ../steve/play/ (keeps play/server.json as it is)
npm run loadtest            # 50 bots for 40 s (SERVER_ENTRY=server/dist/server.mjs to load-test the bundle)
```

Anything in `shared/` changes both sides: rebuild the server AND the client, and bump `WORLDGEN_VERSION` in
`shared/constants.ts` if terrain generation changes (a live world is stored as its difference from the terrain).

## Controls

WASD move, Space jump, Shift sneak, Ctrl or double-tap W sprint, mouse look, hold left click to break, left click to
hit, right click to place, open, eat or drink (hold) or sleep; hold right click to draw a bow; middle click to pick a
block, 1-9 or wheel for the hotbar, E inventory, Q drop, T chat (/ for commands), Tab players and the charity meter,
V push to talk (voice on in Options), F3 debug, F5 third person, F1 hide HUD, Esc menu. Right click a villager to
trade. In a boat: W/S row, A/D steer, Shift gets out.
