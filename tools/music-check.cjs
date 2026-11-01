// Browser check of the background music in a real headless Chrome: tracks.json loads, a piece plays and fades in to
// the right level, the "now playing" line shows, the Music slider exists in Options, and setting it to 0 stops it.
// Usage: node tools/music-check.cjs <site-url> [server-ws]       (prints PASS/FAIL lines; exit code 1 on failure)
const PW = process.env.PLAYWRIGHT || "C:/Users/vincu/Desktop/memecoin/sites/evolve/node_modules/playwright";
const { chromium } = require(PW);
const site = (process.argv[2] || "http://127.0.0.1:8765").replace(/\/$/, "");
const server = process.argv[3] || "ws://127.0.0.1:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failed++;
};

(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--use-angle=d3d11", "--enable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${site}/play/?server=${encodeURIComponent(server)}`);
  for (let i = 0; i < 120; i++) {
    if ((await page.evaluate(() => window.__game && window.__game.state).catch(() => "")) === "play") break;
    await sleep(250);
  }
  const tracks = await page.evaluate(async () => (await fetch("/play/music/tracks.json")).json());
  check(Array.isArray(tracks) && tracks.length >= 3, `tracks.json lists ${tracks.length} pieces`);
  for (const t of tracks) {
    const r = await page.evaluate(async (f) => { const r = await fetch(`/play/music/${f}`, { method: "HEAD" }); return [r.status, r.headers.get("content-type")]; }, t.file);
    check(r[0] === 200, `${t.file} served (${r[1]})`);
  }
  await page.evaluate(async () => { const m = window.__game.music; await m.start(999999); m.playNow(0); });
  await sleep(4500);
  const st = await page.evaluate(() => { const m = window.__game.music; return { playing: m.playing, t: m.el ? m.el.currentTime : -1, vol: m.el ? m.el.volume : -1, paused: m.el ? m.el.paused : true }; });
  check(st.playing === tracks[0].title, `playing "${st.playing}"`);
  check(st.t > 2, `audio is advancing (${st.t.toFixed(2)} s)`);
  check(Math.abs(st.vol - 0.425) < 0.02, `faded in to 0.425 at the default 50% (got ${st.vol.toFixed(3)})`);
  check(await page.evaluate(() => !!document.querySelector(".nowplaying")), "the 'now playing' line is shown");
  await page.evaluate(() => { const g = window.__game; g.state = "paused"; g.ui.showSettings(g.settings, g.serverLine()); });
  await sleep(300);
  check(await page.evaluate(() => [...document.querySelectorAll(".slider .label")].some((e) => /^Music: /.test(e.textContent))), "Options has a Music slider");
  await page.screenshot({ path: process.env.SHOT || "music-options.png" });
  await page.evaluate(() => { const g = window.__game; g.settings.music = 0; g.applySettings(g.settings); g.ui.closeScreen(); g.state = "play"; });
  await sleep(300);
  check(await page.evaluate(() => window.__game.music.playing === null), "Music at 0 stops it");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("steve_craft_settings") || "{}").music);
  check(saved === 0, "the Music setting is saved");
  check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join("; ") : ""}`);
  await browser.close();
  console.log(failed ? `${failed} FAILED` : "ALL PASS");
  process.exit(failed ? 1 : 0);
})();
