# Third-party code and assets

Everything shipped with $STEVE Craft is either our own or under MIT / CC0. No Mojang assets: every block texture,
every item sprite (tools, food, ores, ingots, gems, armour, hoes, seeds, wheat, bread, sugar, paper, egg, flint, the
bow and its draw frames, arrows, buckets, the boat, clay balls, bricks, coconuts), the crops and sugar cane,
farmland, the cake, the building blocks (walls, mossy stone, clay, terracottas, wools, the path, lanterns, the
barrel, bookshelf, hay, flower pots, the village chime, gates, trapdoors, palms, bluebells, the smooth teal, blue and
tan blocks), the boat's hull and oars, the villages (our own house designs, plaza, well and farms) and villagers (our
own design), the smoked fish, the trade window, the spawn hub (our own plaza, the "punch a tree" landmark in
`shared/landmark.ts`, the Beacon tower, halls, boards, gates, roads and harbour, built from our own blocks), the voice
chat's speaking icon and mic pill (the voices are the players' own, relayed live and never stored), the HUD hearts,
food, air and armour icons, the player skins ($STEVE Craft's own art), the animals and night mobs (Shambler,
Rattler, Skitter: our own designs), worn armour, the fire on a burning mob, sun, moon, clouds, crack stages, the
signs and the UI are made in code in this repo (`shared/textures.ts`, `shared/item-textures.ts`,
`shared/fire-texture.ts`, `client/src/render/textures.ts`, `client/src/render/sky.ts`, `client/src/render/mobs.ts`,
`client/src/render/armor.ts`, `client/src/render/scenery.ts`, `client/src/pixel-gui.ts`). Crafting recipes use the
classic shapes (game mechanics), drawn with our own art.

| What | Where it ships | License | File |
| --- | --- | --- | --- |
| three.js 0.185.1 | game bundle (`steve/play/assets/index-*.js`) | MIT | three-MIT.txt |
| ws 8.22.0 | server bundle (`server/dist/server.mjs`) | MIT | ws-MIT.txt |
| obscenity 0.4.6 (profanity filter) | server bundle | MIT | obscenity-MIT.txt |
| Kenney "Mini" pixel font (KenneyMini) | `steve/play/fonts/KenneyMini.ttf` | CC0 1.0 | kenney-fonts-CC0.txt |
| Kenney "Impact Sounds" (footsteps, digging, placing) | `steve/play/sounds/*.ogg` | CC0 1.0 | kenney-impact-sounds-CC0.txt |
| Kenney "UI Audio" (menu click) | `steve/play/sounds/click.ogg` | CC0 1.0 | kenney-ui-audio-CC0.txt |
| Kenney "RPG Audio" (door open/close) | `steve/play/sounds/door_*.ogg` | CC0 1.0 | kenney-rpg-audio-CC0.txt |
| Animal, survival, night-mob, combat, farming, boat, damage and villager sounds (73 clips), original | `steve/play/sounds/{pig,cow,sheep,chicken}_*.ogg`, `pickup_*`, `hurt_0`, `hit_0`, `eat_*`, `burp_0`, `tool_break_0`, `chest_*`, `{shambler,rattler,skitter}_*`, `bow_shoot_*`, `arrow_hit_*`, `attack_crit_0`, `armor_equip_*`, `till_*`, `bucket_fill_*`, `bucket_empty_*`, `drink_*`, `chime_*`, `paddle_*`, `splash_0`, `boat_break_0`, `villager_*`, `trade_0` | Ours (ElevenLabs Sound Effects, paid plan: royalty free, commercial, no attribution) | elevenlabs-sounds.md |
| Background music (4 piano pieces), original | `steve/play/music/*.mp3` | Ours (ElevenLabs Music, paid plan; Indie Game terms, see the file) | elevenlabs-music.md |

Build-only tools (not shipped): vite (MIT), esbuild (MIT), typescript (Apache-2.0), puppeteer-core / Chrome for the
browser checks and the film, ffmpeg for the video.
