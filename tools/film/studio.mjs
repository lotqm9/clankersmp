// The brand studio (asset making only, never shipped): one film server and one camera page that stay up, driven by
// snippets of JS posted to a local port, so a shot can be set up, looked at and changed without restarting anything.
//   node tools/film/studio.mjs            then  curl -s --data-binary @snippet.js http://127.0.0.1:8852/run
// A snippet is the body of an async function of `c`: c.P (the camera page), c.S (the server), c.bots, and helpers
// (c.cast, c.look, c.shot, c.settle, c.top, c.time). It returns anything JSON-able.
// Env: SITE (default http://127.0.0.1:5240), PORT (8851), CLOCK (8899), CTL (8852), OUT (the shots folder).
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bot, holdKey, launch, openPage, outfit, sleep, startServer } from "./director.mjs";

const SITE = process.env.SITE || "http://127.0.0.1:5240";
const OUT = process.env.OUT || join(tmpdir(), "clanker-studio");
mkdirSync(OUT, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "clanker-studio-world-"));
const S = await startServer({ port: Number(process.env.PORT || 8851), clockPort: Number(process.env.CLOCK || 8899), dir, env: { MOBS: "0" } });
console.log("server up", S.url);
const browser = await launch();
const P = await openPage(browser, { site: SITE, server: S.url, w: 2400, h: 1350, pixelRatio: 2, renderDist: 16, name: "camera" });
const yawTo = (fx, fz, tx, tz) => (Math.atan2(-(tx - fx), tz - fz) * 180) / Math.PI;
const pitchTo = (fx, fy, fz, tx, ty, tz) => (-Math.atan2(ty - fy, Math.hypot(tx - fx, tz - fz)) * 180) / Math.PI;

const c = {
  P,
  S,
  OUT,
  bots: {},
  sleep,
  outfit,
  holdKey,
  yawTo,
  pitchTo,
  top: (x, z) => P.g(([x, z]) => window.__c.top(x, z), [x, z]),
  look: (e, t) => P.g(([e, t]) => window.__c.look(e[0], e[1], e[2], t[0], t[1], t[2]), [e, t]),
  time: (t) => P.cmd(`/time ${t}`, 400),
  async settle(ms = 2000) {
    await P.meshed();
    await sleep(ms);
    await P.meshed();
  },
  async shot(name, clip) {
    await sleep(150);
    await P.png(join(OUT, name), clip);
    return join(OUT, name);
  },
  /** A bot by name (made once), stood at x z on the ground (or at y), facing a point, holding an item key. */
  async cast(name, { x, z, y = null, face = null, hold = null, armour = null, give = [] }) {
    let b = c.bots[name];
    if (!b) {
      b = c.bots[name] = await bot(S.url, name);
      await sleep(300);
    }
    const gy = y ?? (await c.top(Math.floor(x), Math.floor(z))) + 1;
    b.chat(`/tp ${x} ${gy} ${z}`);
    await sleep(350);
    if (armour !== null || hold || give.length) await outfit(b, { armour, give: [...give, ...(hold ? [`${hold} 1`] : [])] });
    if (hold) await holdKey(b, hold);
    else b.select(7);
    const [fx, fy, fz] = face ?? [x, gy + 1.6, z + 1];
    b.move(x, gy, z, yawTo(x, z, fx, fz), pitchTo(x, gy + 1.62, z, fx, fy, fz), 4);
    return { name, y: gy };
  },
  drop(name) {
    const b = c.bots[name];
    if (b) b.close();
    delete c.bots[name];
  },
};
await P.cmd("/mobs off");
await P.cmd("/mobs clear");
await P.cmd("/gamemode creative");
await P.g(() => {
  window.__c.clean("none");
  window.__c.noMove = true;
});

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", async () => {
    try {
      const r = await new AsyncFunction("c", body)(c);
      res.end(JSON.stringify(r ?? null) + "\n");
    } catch (e) {
      res.end("ERR " + (e && e.stack ? e.stack : String(e)) + "\n");
    }
  });
}).listen(Number(process.env.CTL || 8852), "127.0.0.1", () => console.log("studio ready on", process.env.CTL || 8852, "shots in", OUT));
