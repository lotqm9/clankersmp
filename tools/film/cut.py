# Joins film.mjs's clips into the montage: the story in order (punch a tree, craft, mine, night, village, trade,
# boat, the spawn hub), then the end card; the game's own music under it ("Little Island", web/public/play/music).
#   python cut.py <clipdir> <outdir>
# Writes steve-craft-survival.mp4 (master, 1080p60, music), -nomusic.mp4 (picture only) and -x.mp4 (X upload:
# H.264 yuv420p + AAC, under 20 MB). Every output is written with no metadata (no C2PA, no tool tags).
import json, os, subprocess, sys
from pathlib import Path

clips, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
ROOT = Path(__file__).resolve().parents[2]
MUSIC = ROOT / "web" / "public" / "play" / "music" / "island.mp3"
FPS = 60
# (clip, first frame, last frame exclusive)
EDIT = [("tree", 60, 250), ("craft", 20, 180), ("mine", 60, 200), ("night", 30, 210), ("village", 0, 150), ("trade", 10, 140), ("boat", 30, 210), ("hub", 0, 270)]
CARD_S = 2.6
XFADE = 0.5
MUSIC_AT = 0.9  # seconds into the track


def run(args):
    print(">", " ".join(str(a) for a in args[:6]), "...")
    subprocess.run([str(a) for a in args], check=True)


# 1. the end card, from the hub's last frame
last = clips / "hub-last.png"
run(["ffmpeg", "-y", "-loglevel", "error", "-sseof", "-0.05", "-i", clips / "hub.mp4", "-frames:v", "1", "-update", "1", last])
run(["python", Path(__file__).parent / "card.py", "endcard", last, clips / "endcard.png"])

# 2. the picture: trimmed clips, cut together, a cross-fade into the card
inputs, parts = [], []
for k, (name, a, b) in enumerate(EDIT):
    inputs += ["-i", clips / f"{name}.mp4"]
    parts.append(f"[{k}:v]trim=start_frame={a}:end_frame={b},setpts=PTS-STARTPTS,fps={FPS},format=yuv420p[v{k}]")
n = len(EDIT)
inputs += ["-loop", "1", "-framerate", str(FPS), "-t", str(CARD_S + XFADE), "-i", clips / "endcard.png"]
story = sum(b - a for _, a, b in EDIT) / FPS
parts.append("".join(f"[v{k}]" for k in range(n)) + f"concat=n={n}:v=1:a=0,settb=1/{FPS},setsar=1[story]")
parts.append(f"[{n}:v]fps={FPS},format=yuv420p,settb=1/{FPS},setsar=1[card]")
parts.append(f"[story][card]xfade=transition=fade:duration={XFADE}:offset={story - XFADE:.3f}[pic]")
total = story + CARD_S
master_v = clips / "picture.mp4"
run(["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex", ";".join(parts), "-map", "[pic]", "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-pix_fmt", "yuv420p", "-r", str(FPS), "-map_metadata", "-1", master_v])

# 3. the music: Little Island from 0.9 s, faded in and out under the card, at -16 LUFS
music = clips / "music.m4a"
run(["ffmpeg", "-y", "-loglevel", "error", "-ss", str(MUSIC_AT), "-t", f"{total:.3f}", "-i", MUSIC, "-af", f"afade=t=in:d=0.4,afade=t=out:st={total - 1.8:.3f}:d=1.8,loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000", "-c:a", "aac", "-b:a", "256k", music])

base = "steve-craft-survival"
clean = ["-map_metadata", "-1", "-map_chapters", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact", "-movflags", "+faststart"]
# master: the picture as rendered + the music
run(["ffmpeg", "-y", "-loglevel", "error", "-i", master_v, "-i", music, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "copy", "-shortest", *clean, out / f"{base}.mp4"])
# no music: the picture alone
run(["ffmpeg", "-y", "-loglevel", "error", "-i", master_v, "-map", "0:v", "-c:v", "copy", *clean, out / f"{base}-nomusic.mp4"])
# X: two-pass H.264 sized under 20 MB with AAC
target_kbps = int((17.5 * 8 * 1000) / total) - 192  # 17.5 MB (decimal) of video+audio: under 20 MB with room
passlog = str(clips / "x2pass")
run(["ffmpeg", "-y", "-loglevel", "error", "-i", master_v, "-c:v", "libx264", "-preset", "slow", "-b:v", f"{target_kbps}k", "-pass", "1", "-passlogfile", passlog, "-pix_fmt", "yuv420p", "-profile:v", "high", "-an", "-f", "mp4", os.devnull])
run(["ffmpeg", "-y", "-loglevel", "error", "-i", master_v, "-i", music, "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "slow", "-b:v", f"{target_kbps}k", "-maxrate", f"{int(target_kbps * 1.6)}k", "-bufsize", f"{target_kbps * 2}k", "-pass", "2", "-passlogfile", passlog, "-pix_fmt", "yuv420p", "-profile:v", "high", "-r", str(FPS), "-c:a", "aac", "-b:a", "160k", "-shortest", *clean, out / f"{base}-x.mp4"])
# a last remux of the X copy: drops the encoder tag the second pass wrote
xtmp = out / f"{base}-x.tmp.mp4"
os.replace(out / f"{base}-x.mp4", xtmp)
run(["ffmpeg", "-y", "-loglevel", "error", "-i", xtmp, "-map", "0", "-c", "copy", *clean, out / f"{base}-x.mp4"])
os.remove(xtmp)
print(json.dumps({"story_s": round(story, 2), "total_s": round(total, 2), "x_kbps": target_kbps}))
