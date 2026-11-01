# Background music (original, generated for our games)

`site/play/music/*.mp3` (4 solo-piano pieces, about 9.5 minutes in total) are original music generated for
our games on 2026-10-14 with ElevenLabs Music (`POST /v1/music`, default model, `force_instrumental: true`) on our
paid ElevenLabs plan (Creator). The prompts describe moods only (a meadow morning, a lake at evening, a small island,
a starry night); no game, composer or existing song is named. No Minecraft or C418 music is used anywhere in the game.

| File | Title | Length | ElevenLabs song id |
| --- | --- | --- | --- |
| meadow.mp3 | Meadow Morning | 2:30 | kp3w3n8hZ8RA8PfjIydO |
| lakeside.mp3 | Lakeside | 2:30 | rpinynFuqjm3qmJqQhO2 |
| island.mp3 | Little Island | 2:10 | jEbv27nsp6PPc80EtjBn |
| starlight.mp3 | Starlight | 2:30 | axJaND3YNzJqWaG4icFM |

Prompts and settings: `tools/gen-music.mjs`. Processing: loudness -20 LUFS, 2 s fade in, 4 s fade out,
128 kbps stereo MP3.

## Terms (checked 2026-10-14, https://elevenlabs.io/eleven-music-model-specific-terms and https://elevenlabs.io/music)

- Between us and ElevenLabs, we keep all rights in the output (section 2.2). No attribution is required on paid plans.
- Paid self-serve plans (Starter, Creator, Pro, Scale, Business) allow "all online and offline commercial use ...
  except film, TV, radio, and Studio Games".
- A "Studio Game" is a game made available to the public that is NOT an "Indie Game". An Indie Game is one whose
  revenue has been under $500,000 since its first commercial release AND whose developer/publisher had under
  $1,000,000 revenue in its latest financial year (section 4.8). If a game stops qualifying, there are 60 days to
  move to a plan that allows Studio Games (section 4.7), i.e. Enterprise.
- Starter, Creator and Pro are "for individual use only".

**To confirm (Laith):** the game is free to play and its coin's fees go to charity, so it should count as an Indie
Game, but that also depends on the developer's (Laith's / his company's) revenue in the latest financial year being
under $1,000,000, and on the Creator plan's individual-use condition. If either does not hold, replace these files
(any CC0 piano pieces, or new originals on an eligible plan): the player reads `tracks.json` and needs no code
change.
