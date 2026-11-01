# $STEVE Craft survival: build log

Append-only. Newest entries at the bottom.

## 2026-10-30: the switch (builder -> survival)

Brief: sites/steve-game/SURVIVAL-SWITCH-BRIEF.md. The survival engine (update 13 of our other browser game, protocol 11:
survival, crafting, tools, health and hunger, night mobs, combat and armour, farming, animals, caves and ores,
flowing water, villages and ruby trading, boats and islands, the big spawn hub, proximity voice, music) copied into
this folder and rebranded to $STEVE Craft. sites/steve-game (the builder, protocol 4) is untouched: it is the rollback.

- Name and links: "$STEVE Craft", @SteveOnPF, www.stevepumpfun.com; "Back to Title Screen" goes to `/`.
- Protocol `stevecraft` v12 (shared/constants.ts). The old builder page sends a hello with no protocol name: the
  server answers "The game was updated. Please refresh the page." with server 12, which that page reads as an update
  (it reloads once, then says to refresh). A new page meeting the old server waits on "Server starting soon ...
  updating" and retries. WORLDGEN_VERSION 4.
- The world: a fresh survival world (seed 1014) in SURVIVAL_WORLD_DIR=/data/survival (Dockerfile); the builder's
  world on the same volume (/data/shard-1, salt, bans, stats) is never touched.
- Server: ADMIN_SECRET (the name the steve-game service already has); COIN_CA or STEVE_CA; CHARITY_NAME "Gamers
  Outreach" and CHARITY_X "GamersOutreach" by default (Dockerfile), so the meter reads "starts at launch".
- Spawn hub: hub12's layout kept; the centrepiece is now shared/landmark.ts: a blocky guy in a teal shirt (with the
  gold "$") and blue trousers, 32 blocks tall, one fist out punching a 4 x 4 oak, on a grassy dais 3 north of the
  plaza's centre; the plaque "$STEVE Craft / Charity coin partnered with @GamersOutreach" faces the arrival.
  Teal accents (bands, compass, gates, hall trim) and diamonds (Beacon faces and tip, a bluebell garden) replace the
  old brand's red pixels and hearts. New smooth blocks 105-107 (teal, blue, tan) in place of the old brand blocks.
- Boards: welcome, rules, tips, directions; the charity board ("Charity coin", "Starts at launch", partnered with
  @GamersOutreach, "Updates on X: @SteveOnPF"); the updates board ("Updates on X: @SteveOnPF · stevepumpfun.com").
  All signs in KenneyMini on oak or dark stone plates.
- UI: the builder's classic look (KenneyMini, grey bevelled buttons, dirt screens, yellow highlights) for the title
  card, pause, options (classic sliders and ON/OFF buttons, the voice section), messages, loading, death, sleep,
  toasts, Tab and chat; the native in-game GUI kept (minus the red pixel on the hotbar's selection box). Players
  wear $STEVE Craft's own skins (the gold "$"); name tags in KenneyMini; the boat's stripe is teal.
- localStorage: steve_name (shared with the title screen), steve_craft_settings, steve_craft_token,
  steve_craft_recipes, steve_craft_seen_update; sessionStorage steve_craft_update_reload. Voice worklet
  "steve-craft-voice-capture".
- Client: Vite builds web/play/index.html into ../steve/play (base /play/), fonts/sounds/music from
  web/public/play; play/server.json kept. updates/0001-survival.json is the "what's new" toast.
- Tests: npm test 300 (299 pass + 1 skipped without SITE_DIR); typecheck clean. Hub tests rewritten for the landmark;
  terrain hashes re-pinned; plaza test spots moved off the dais. Browser checks on the built client + bundle (fresh
  worlds): hub 24/24, village 22/22, world 27/27, survival 103/103, sound 18/18, music 13/13, voice 29/29, and
  tools/mp-check.cjs 17/17 (two players see each other, chat both ways, place and break, Tab and the charity board
  prelaunch, the old builder page reloads once then says the game was updated). Load test, 50 bots for 40 s on the
  bundle: 16% of a core, 258 MB, 5.4 KB/s per client, 0 corrections, 0 kicks.
- Film tooling (tools/film, never shipped): the server on a virtual clock (clock.mjs), the page on one
  (page-clock.js), lockstep stepping (step.mjs): the whole world moves one 1/60 s frame at a time, so the montage
  is smooth however long a frame takes to capture. scenes.mjs / film.mjs / cut.py (montage), stills.mjs, card.py.
- Ship: ship.mjs (Railway steve-game, then Vercel stevepumpfun, then waits for /status stevecraft 12); --rollback.
  Not deployed from here.
- Final checks: npm test 300 (299 pass, 1 skipped), typecheck clean, SITE_DIR=../steve sounds 5/5; built client
  play/assets/index-fSpBrvp5.js, play/server.json kept (wss://steve-game-production.up.railway.app); no "givepixel"
  in sites/steve/play or server/dist/server.mjs. The title screen's Multiplayer button opens /play/ (checked locally).
- Assets (Desktop/steve kit/survival-switch): 7 stills at 2400x1350 (01 hero, 02 cave, 03 night, 04 trade, 05 boats,
  06 crafting table, 07 before/after), steve-craft-survival.mp4 (25.9 s, 1080p60, "Little Island" at -16 LUFS),
  -nomusic.mp4, -x.mp4 (18.2 MB, H.264 yuv420p + AAC), contact.jpg. All written without metadata.
