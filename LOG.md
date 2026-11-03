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

## 2026-11-01: clankersmp's own spawn

The hub was still $STEVE Craft's. Now it is clankersmp's (no world reset: the server builds the base world from the
shared code at every start and keeps only the edits; the live world had no edits within 70 blocks of spawn).

- shared/landmark.ts: the monument. opus, sonnet and haiku as block statues, a block per pixel of their skins
  (client/src/render/textures.ts AGENT_LOOKS / agentSkin): heads 8 x 8 x 8 (the faces pixel for pixel), bodies at
  three quarters (torso 6 x 10, arms and legs 3 x 10, 4 deep), 28 tall. sonnet in front, opus (west) and haiku (east)
  four blocks behind, shoulder to shoulder, on a two-block stone base on a rounded dais (35 x 21). Coats: red wool,
  smooth blue, yellow wool; the rest the nearest existing blocks (terracottas, wools, clay). The plaque is the base's
  front under sonnet (10 x 2): "clankersmp" with the three dots, the names under it in their colours.
- shared/hub12.ts: the arch reads "Welcome to clankersmp"; the Charity Hall is the experiment hall ("experiment"
  board: three claude models, one life each, the goal is a civilization from camp to city, no prompting during
  play); the updates house; the gate signposts say "Spawn". The plaza's posts and benches stay clear of the dais.
- Boards (client/src/render/scenery.ts), lowercase and plain: welcome, rules (ais play, humans watch), tips
  (watching), directions, updates (@clankersmp, clankersmp.fun). No charity anywhere in the client (the server's
  meter message is ignored). updates/0001-spawn replaces the $STEVE entry.
- UI: the logo word is "clankersmp" with the dots; loading and error lines, the phone screen, the X links
  (x.com/clankersmp) and the server's own lines say clankersmp.
- Kept on purpose: the protocol name "stevecraft" and the localStorage keys (wire and saved settings).
- Screenshots: sites/clankersmp/posts/spawn/.

## 2026-11-03: enchanting, and fighting that keeps them alive (protocol 13)

Laith: "build towards stuff like enchantment table, and way better fighting". Branch `tech`.

Engine (protocol 13: new blocks and items; server, client and agents ship together, an older page reloads):
- Obsidian (block 223, hardness 50: only a diamond pickaxe gets it out, 9 s). The Minecraft way, lava meeting water,
  without touching worldgen (the live world is a diff against the generated terrain): the smith sells a Lava Bucket
  for 2 rubies and your empty bucket, and it can only be poured where water is beside it, where it sets at once into
  obsidian (a hiss of steam). The bucket comes back. There is no lava block anywhere.
- Book (3 paper and a leather; the librarian also binds one for a ruby and 3 paper), the enchanting table (block 224,
  light 7: a book on 2 diamonds and 4 obsidian).
- Enchanting for rubies (no XP in this world; rubies are its money): level I 2 rubies, II 4 (5 bookshelves round the
  table, Java's ring), III 7 (10 shelves). Sharpness (swords, axes: +0.5 x level + 0.5), Efficiency (pickaxes,
  shovels: +level^2 + 1), Protection (armour: 4% a level over all pieces, at most 80%, falls too). Enchanted gear is
  its own item (ids 400+), so stacks, saves and the stack wire format don't change. Players right-click the table
  with the item; agents send { t: "enchant" } (worn armour by slot). A violet glint on enchanted icons, glyph
  particles and a chime at the table.
- Knockback now carries a mob (Java: about 2 blocks a hit, 6 sprinting). Before, its AI set its speed back toward the
  player the very next tick: a hit moved it half a block, a sprinting hit no further.

Agents:
- Fighting (agents/body.ts fight, duel, pillarFight, coverFrom; brain.ts combat()): charged swings only; a walker
  is met standing with a jump timed so the swing lands on the way down (a critical); while the weapon recharges it
  steps back out of reach, facing it (never off a ledge, into water or another monster); something that backs off
  is chased with a sprint-jump that lets go of the sprint on the way down (a critical with an ordinary knockback).
  Rattlers: the bow (a full draw, aimed with the arrow's drop and a lead); no bow: charge only when close or
  armoured, else a two-high wall between (it has to come round into reach), home if it's near, a run out of its
  range if no wall goes up, a hole last. Two or
  more walkers, or hurt: two blocks up a pillar where a walker can't reach, fight from there, eat, dig it away after.
  Never digs in with a walker within 5 (or starts a night hole with one within 12). Calls for help in chat when
  outnumbered; the others within 28 blocks come and fight the same monster. The hunt reflex stays, refined (not at
  night without armour with company about).
- The tech tree (agents/tech.ts): every turn a line with the next step (iron armour first, then diamonds, obsidian,
  a book, the table, enchanting); collect obsidian (pours lava onto water near it or into a pool from a water
  bucket, mines it, tidies up); enchant (puts the table up at the base with its bookshelf ring, enchants the best
  thing first); trade with: smith (the nearest villager of a trade).

Fight tests (agents/fight-test.ts; the agents' own reflexes, no Claude calls; 8 trials a scenario on a test server,
flat open arenas at night, a fresh body and kit each trial; "damage" is all damage taken, they heal as they go):
    scenario   | before: lived  dmg taken  lowest hp  kills | after: lived  dmg taken  lowest hp  kills
    sh1        |          8/8        6.3       15.4   100% |          8/8        0.0       20.0   100%
    sh1low     |          8/8        5.5        8.9   100% |          8/8        0.4        9.0   100%
    sh2        |          8/8       12.9       12.4   100% |          8/8        6.8       17.4   100%
    sh2low     |          8/8       12.4        8.3   100% |          8/8        5.3       10.9    88%
    sh3        |          8/8       16.4       11.9    88% |          8/8        7.9       17.1    88%
    sh3iron    |          8/8        7.9       18.4   100% |          8/8        3.5       18.7   100%
    sk1        |          8/8        3.8       18.0   100% |          8/8        2.3       18.8   100%
    ra1        |          7/8       21.8       12.6    13% |          8/8       11.5       15.8    75%
    ra1low     |          8/8       19.9        9.0    13% |          8/8        4.8       10.6    75%
    ra1nobow   |          7/8       17.6       13.0    13% |          8/8       10.8       14.1    50%
    ra2iron    |          7/8       24.8       15.4    88% |          8/8        9.5       18.1    88%
    mix        |          8/8       17.1       14.8    38% |          8/8       20.5       14.8    94%
    mixiron    |          8/8       13.8       18.1    97% |          8/8       24.4       17.6    59%
    tunnel     |          5/8        9.1        4.9    50% |          8/8        1.4        8.0   100%
    tunnelra   |          8/8        6.8       11.8    88% |          8/8        5.3       13.8    75%
    team3      |        16/16       10.4       14.1   100% |        16/16        0.8       19.3    88%
    help2      |        16/16        7.4       12.4   100% |        16/16        1.8       15.2    75%
    total      | before: 6 deaths in 152 | after: 0 deaths in 152
    (sh = shamblers, ra = rattlers, sk = a skitter; low = 7 to 10 health at the start; iron = full iron and an iron sword;
    tunnel = coming at it down a mine; team3 = two of the pack against three; help2 = one attacked, another 14 blocks off:
    it came and joined the fight in 7 of 8. The mixed packs take more hits in all (small ones, never lower health) and
    the armoured one kills fewer: the next thing to tune.)
Tech test (agents/tech-test.ts): 4 lava buckets -> 4 obsidian (buckets back), a book, the table crafted and put up
with 10 bookshelves, a sword to Sharpness III (7 rubies) and a worn chestplate to Protection II, the enchanted sword's
charged hit 7.9, 11.8 as a critical (a plain iron sword 5.9), a smith selling lava. Unit tests: tests/enchanting.test.ts.
