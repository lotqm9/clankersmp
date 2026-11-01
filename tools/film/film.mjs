// The "$STEVE Craft is now survival" montage, filmed in the real game: the built client in headless Chrome against a
// local server, protocol bots as the other players, the whole world stepped one frame at a time on a virtual clock
// (smooth at 60 fps however long a frame takes to capture). Each scene renders to its own clip (scenes.mjs); cut.mjs
// joins them with the music. Usage (the built site served at SITE, e.g. `node tools/static.mjs ../steve 5240`):
//   node tools/film/film.mjs <outdir> [scene ...]       scenes: tree craft mine night village trade boat hub
// Env: SITE (default http://127.0.0.1:5240), PORT (8831), CLOCK (8899), STILL=1 also saves a PNG every 30 frames.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, openPage, sleep, startServer } from "./director.mjs";
import { makeScenes } from "./scenes.mjs";
import { stepper } from "./step.mjs";

const out = process.argv[2];
const ORDER = ["tree", "craft", "mine", "night", "village", "trade", "boat", "hub"];
const only = process.argv.slice(3).length ? process.argv.slice(3) : ORDER;
const SITE = process.env.SITE || "http://127.0.0.1:5240";
const W = Number(process.env.W || 1920);
const H = Number(process.env.H || 1080);
const FPS = 60;
mkdirSync(out, { recursive: true });

const dir = mkdtempSync(join(tmpdir(), "steve-film-"));
const S = await startServer({ port: Number(process.env.PORT || 8831), clockPort: Number(process.env.CLOCK || 8899), dir });
console.log("server up", S.url, "pid", S.proc.pid);
const browser = await launch();
let code = 0;
try {
  const P = await openPage(browser, { site: SITE, server: S.url, w: W, h: H, pixelRatio: 2, renderDist: 12, name: "SteveFan_2014" });
  const st = stepper(P, S.clock, FPS);
  const info = await P.g(() => {
    const i = window.__game.info;
    return { sh: i.spawnHeight, spawn: i.spawn, villages: i.villages.list.map((v) => ({ name: v.name, x: v.x, y: v.y, z: v.z })), landmark: i.hub.landmark };
  });
  console.log("joined; sh", info.sh);
  await P.cmd("/mobs off");
  await P.cmd("/mobs clear");
  const scenes = makeScenes(P, S, info);

  for (const name of ORDER.filter((n) => only.includes(n))) {
    const sc = scenes[name];
    console.log(`-- ${name}: setup`);
    await sc.setup();
    await P.meshed();
    await sleep(1500);
    await st.start();
    await st.run(6, () => sc.drive(0)); // settle on the first frame
    const file = join(out, `${name}.mp4`);
    const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "png", "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "12", "-pix_fmt", "yuv420p", "-r", String(FPS), file], { stdio: ["pipe", "inherit", "inherit"] });
    const done = new Promise((res, rej) => ff.on("exit", (c) => (c === 0 ? res() : rej(new Error("ffmpeg " + c)))));
    const t0 = Date.now();
    for (let f = 0; f < sc.frames; f++) {
      await st.step(() => sc.drive(f));
      const png = await P.png();
      if (process.env.STILL && f % 30 === 0) writeFileSync(join(out, `${name}-${String(f).padStart(4, "0")}.png`), png);
      if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once("drain", r));
    }
    ff.stdin.end();
    await done;
    console.log(`${name}: ${sc.frames} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${file}`);
    await st.stop();
    if (sc.after) await sc.after();
    scenes.clearBots();
    await P.g(() => window.__c.free());
    await sleep(500);
  }
  console.log("page errors:", JSON.stringify(P.errors.slice(0, 5)));
} catch (e) {
  console.error(e);
  console.error(S.log().slice(-1500));
  code = 1;
} finally {
  await browser.close();
  S.proc.kill();
}
process.exit(code);
