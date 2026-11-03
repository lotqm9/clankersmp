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

## 2026-11-03: fights they finish, a tidy inventory, deep trips for diamonds (agents v14)

Laith: way better fighting, a tidy inventory, and "I want them to aim for better resources, diamonds etc". Branch
`tech`. No protocol bump: the new messages (agent inventory moves, the watcher's view of them) are additions to 13.

Fighting (agents/brain.ts combat(), agents/body.ts fight):
- Armed (a stone sword or better, or an axe) and armoured (6 points or more), it takes on what is on it and finishes
  it: shamblers, skitters, and rattlers too (charged). It gives ground only unarmed, badly hurt (under 6 health
  armoured, 8 without) or clearly outnumbered (3 monsters unarmoured, 4 armoured, 5 in iron, 6 in iron with an iron
  sword); then it gets away at a sprint across an archer's line of fire, home if home is near, never down a hole
  with a monster about.
- An archer is never run from in its sights (haiku, season 13 day 11, shot dead in iron while "taking cover"):
  armoured, it closes in and kills it with whatever it has; otherwise it breaks the line of sight with blocks.
  Across water it never swims at one (a swimmer is a sitting target): the bow from the bank, or out of its sight.
- Technique: eyes on the target, charged swings, jump crits, circling out of reach while the weapon recharges,
  stepping back from everything in reach, a weave on the way in at an archer, the drops picked up after.
- Help: a fight is answered once (season 13: sonnet answered one fight 15 times in 20 minutes), only while the
  caller is still at it, from 40 blocks for a call and 16 without; "coming, <name>" in chat; they fight it together.
- No meal stood still for in an archer's sight unless starving.

Inventory (agents/inventory.ts; server aswap and ainv; client):
- A fixed hotbar: 1 weapon, 2 pickaxe, 3 axe, 4 shovel, 5 food, 6 torches, 7 and 8 building blocks, 9 the bow or a
  spare. Part stacks merged. Anything else taken in hand goes to 9, so the rest stay put. Junk (spoiled flesh, flint,
  feathers, string and bones past a few) goes when the bag is full.
- It sorts with its inventory screen open, a move at a time. A spectator following an AI presses E to see its whole
  inventory (read only); the screen opens by itself while the AI sorts, and its crafts show in the grid.

The way to diamonds (agents/mine.ts, the mine_trip tool; agents/tech.ts):
- The tech line points every step at how to get it: iron near the surface or by the stack on a trip, then diamonds
  and rubies from a mine_trip, with what a trip still needs. A morning with the kit, the turn says it's time for one.
- A mine_trip: mornings only (dawn to time 5000), and only armoured, with an iron pickaxe, a real weapon, 8 torches,
  food and 16 spare blocks. From open ground outside the town (never under the streets, the hub or a village): a
  staircase down to the diamond layer (y 11), aimed at the diamonds it knows of, quarter turns only, never toward
  water overhead, on through any cave it meets with the cave's openings blocked up round it; a torch every 7 blocks
  (more crafted from the coal it mines). Then a tunnel through the rock to the nearest diamonds (rubies and iron
  after), every ore its walls show mined with its vein, floor holes filled back in. A stone pickaxe digs the stone,
  the iron one is kept for the ores. It heads back at time 8000 (or full, out of torches or blocks, hurt, the pick
  worn), up the way it came (out of a hole by pillaring, the long way round, a staircase dug up last and never
  through water), and puts the haul in the storehouse, keeping the iron and diamonds its own next gear needs and
  its rubies. Water in the way down near the top: it starts again 20 blocks off. Cut short by a fight it carries
  on when called again; left below late, a reflex climbs it out. The y 30 floor of everyday mining and every night
  rule stay as they were; the dusk reflexes (house, home, the storehouse round) leave a trip alone.

Fight tests (agents/fight-test.ts: the agents' own reflexes, no Claude calls, a fresh body and kit each trial, open
arenas at night). Before = main as it ran in season 13 (a8f879f), after = this branch merged with main (the nav
branch's walking included); each on a fresh copy of the same world, so every trial has the same arena; 8 trials a
scenario (a_help: two agents a trial):
    scenario | before: lived   dmg   low  all dead  gave ground | after: lived   dmg   low  all dead  gave ground
    a_sh2    |          8/8   12.7  16.3      8/8        5/8     |         8/8    4.4  17.7      8/8        0/8
    a_sk2    |          8/8   10.5  18.5      8/8        0/8     |         8/8    3.5  18.5      8/8        0/8
    a_ra1    |          8/8   15.0  15.3      5/8        8/8     |         8/8   16.2  14.3      8/8        0/8
    ip_ra1   |          8/8   19.4  16.7      2/8        8/8     |         8/8   20.4  16.2      6/8        4/8
    a_mix    |          8/8   12.8  16.8      1/8        7/8     |         8/8   19.8  14.2      8/8        0/8
    i_ra2    |          8/8   18.1  17.4      6/8        5/8     |         8/8   20.9  17.7      5/8        2/8
    i_mix    |          8/8   17.5  17.7      4/8        4/8     |         8/8   19.6  18.1      7/8        2/8
    a_help   |        16/16    7.9  16.9     8/16      14/16     |       16/16    8.3  17.0     16/16       0/16
    ra1nobow |          8/8    9.4  14.5      6/8        7/8     |         8/8   21.0  11.9      7/8        2/8
    sh2low   |          8/8    8.3  10.3      8/8        8/8     |         8/8    3.4  11.0      8/8        0/8
    tunnel   |          7/8    3.8   6.9      7/8        7/8     |         8/8    0.0   8.0      8/8        0/8
    In all: deaths 1 -> 0 of 96, gave ground 73 -> 10, every monster dead 63 -> 89, damage taken 11.9 -> 12.1 a
    trial (standing and fighting takes the hits running used to; the lowest health stays where it was).
    (a = a stone sword and leather, i = full iron and an iron sword, ip = haiku's kit when it died: an iron helmet,
    chestplate and boots, no sword; sh shamblers, sk skitters, ra rattlers; mix = a shambler (two in iron), a rattler
    and a skitter; a_help = one attacked by two shamblers and a rattler, another of the pack 14 blocks off; ra1nobow =
    a stone sword, nothing else; sh2low = 10 health against two; tunnel = 7 health, one coming at it down a mine.
    "Gave ground" = took cover, ran, walled or dug in, pillared up, or broke the line of sight. Most misses left are a
    rattler across water when the minute ran out.)
Help (each agent's board line posted every second, as in play): help2 (one attacked by two shamblers at 14 health,
another 14 blocks off) every monster dead 14/16 -> 16/16, gave ground 8/16 -> 0/16, 24 s -> 11 s a fight; the call
answered 12 times in 8 fights before (the same fight again and again), 7 after (once, or not at all when it was over).

Mining trips (agents/mine-test.ts: the brain's mine_trip and its reflexes, no Claude calls; a fresh test world with
monsters on and its clock running from dawn; four trips at a time at spots spread over the island, two rounds; the
least kit a trip allows: an iron chestplate, a stone sword, iron and stone pickaxes, 12 torches, 6 bread, 24
cobblestone): 8 trips, all 8 lived (no damage taken), a diamond in 7 of 8, the first after 126 to 332 s (median
243 s: about four minutes after setting off at dawn), 85 diamonds in all (1 to 24 a trip), 7 raw iron and 8 rubies a
trip, 8 minutes a trip. Back at the surface 6 of 8 (5 before dusk); the other two were still in their tunnels at
nightfall, alive, after the way back up was lost (a flooded patch, a fall). The trip without a diamond met water
at y 45 and gave up (the start-again-elsewhere came after that round).
Inventory test (agents/inventory-test.ts) all passed; unit tests (combat, survival, enchanting, trades, mobs,
world blocks, the server) 60/60; after the last merge of main, a fight smoke run (tunnel, a_ra1, a_mix, sh2low, 4
each): 16/16 lived, 0 gave ground, 14 cleared.
