# Animal and survival sounds (original, generated for our games)

`site/play/sounds/{pig,cow,sheep,chicken}_{say,hurt}_N.ogg` (20 files) are original audio generated for our games
on 2026-10-14 with ElevenLabs Sound Effects (`POST /v1/sound-generation`, model `eleven_text_to_sound_v2`,
prompt_influence 0.55) on our paid ElevenLabs plan. ElevenLabs states that sound effects made on a paid plan are
royalty free, can be used in commercial projects and need no attribution
(https://elevenlabs.io/sound-effects/commercial, checked 2026-10-14). They are not taken from any game.

Processing: trimmed leading/trailing silence, mono 44.1 kHz, peak-normalised to -6 dBFS, OGG Vorbis q4
(`tools/gen-sfx.mjs`, which also lists the exact prompt for every file). The raw MP3s are kept out of the build.

Survival (update 7, same model, settings and terms): `site/play/sounds/pickup_{0,1,2}.ogg`, `hurt_{0,1,2}.ogg`,
`eat_{0,1,2}.ogg`, `burp_0.ogg`, `tool_break_0.ogg`, `chest_open_0.ogg`, `chest_close_0.ogg` (13 files, prompts in
`tools/gen-sfx.mjs`). None imitates another game's sounds: the prompts describe a pop, a grunt, a bite, a burp, a
snapping handle and a creaking wooden lid.

Night mobs and combat (update 8, protocol v6, same model, settings and terms, generated 2026-10-14):
`site/play/sounds/{shambler,rattler,skitter}_{say_0..2,hurt_0..1,death_0}.ogg` (18 files),
`bow_shoot_{0,1}.ogg`, `arrow_hit_{0,1}.ogg`, `attack_strong_{0,1}.ogg`, `attack_weak_{0,1}.ogg`,
`attack_crit_0.ogg` and `armor_equip_{0,1}.ogg` (11 files): 29 in all, prompts in `tools/gen-sfx.mjs`. None
imitates another game's sounds: the prompts describe a raspy groaning creature, dry rattling bones, a chittering
insect, a bowstring and arrows, punches and taps, and armour plates clinking.

Farming and depth (update 9, protocol v7, same model, settings and terms, generated 2026-10-15):
`site/play/sounds/till_{0,1}.ogg`, `bucket_fill_{0,1}.ogg`, `bucket_empty_{0,1}.ogg` and `drink_{0,1}.ogg`
(8 files, prompts in `tools/gen-sfx.mjs`). None imitates another game's sounds: the prompts describe a hoe scraping
soil, water sloshing into and pouring out of a metal pail, and gulps.

World update (update 10, protocol v8, same model, settings and terms, generated 2026-10-16):
`site/play/sounds/chime_{0,1}.ogg`, `paddle_{0,1,2}.ogg`, `splash_0.ogg` and `boat_break_0.ogg` (7 files, prompts in
`tools/gen-sfx.mjs`). None imitates another game's sounds: the prompts describe small brass tube chimes struck by a
wooden clapper, an oar pulling through water, a rowboat set down on water and thin planks cracking apart.

Damage sounds (update 10.1, same model, settings and terms, generated 2026-10-16): `site/play/sounds/hurt_0.ogg`
(your hurt), `hit_0.ogg` (your hit landing), `attack_crit_0.ogg` (a critical hit),
`{pig,cow,sheep,chicken}_hurt_0.ogg` and `{shambler,rattler,skitter}_hurt_0.ogg` (10 files). They replace the 22
earlier hurt and hit clips (`hurt_0..2`, `attack_strong_*`, `attack_weak_*`, `attack_crit_0` and the `*_hurt_0..1` of
the animals and night mobs). Laith asked for hurts and hits with the feel of the classic block game's; they are
made from our own text prompts (a short comic "oof" grunt, a punch on a leather bag, a sharp smack, startled animal
calls, a raspy creature, dry bones, an insect hiss) and are not taken from, sampled from or matched against
Mojang's sound files or any other game's. Each is the picked one of 4 to 6 takes (two prompts, 0.5 s each), trimmed,
cut to 0.25-0.5 s with a 40 ms fade, peak-normalised to -6 dBFS; the game plays them at a random pitch of 0.8-1.2.
The unpicked takes and the replaced clips are kept out of the build (`.local/sfx-raw/takes`, `.local/sfx-raw/v9-replaced`).

Villages (update 11, protocol v9, same model, settings and terms, generated 2026-10-16):
`site/play/sounds/villager_say_{0,1,2}.ogg`, `villager_yes_0.ogg`, `villager_no_0.ogg`, `villager_hurt_{0,1}.ogg` and
`trade_0.ogg` (8 files, prompts in `tools/gen-sfx.mjs`). None imitates another game's sounds: our villagers whistle
(short cheerful tunes, a rising "yes" and a falling "no"), gasp a wordless "oh" when poked, and a trade is a few
small gemstones clinking; nothing like the murmuring villagers of other games.
