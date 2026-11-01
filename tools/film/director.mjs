// The film director's kit (asset making only, never shipped): a game server on a virtual clock (clock.mjs), the real
// built client in headless Chrome on a virtual clock (page-clock.js), protocol bots as other players (tests/bot.ts),
// and helpers to place the camera, pose the bots and step the whole world one video frame at a time.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Bot } from "../../tests/bot.ts";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || "C:/Users/vincu/Desktop/memecoin/sites/evolve/node_modules/playwright");
export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { Bot };

// ------------------------------------------------------------------ the server on the film clock
export async function startServer({ port, clockPort, dir, env = {} }) {
  mkdirSync(dir, { recursive: true });
  const proc = spawn(process.execPath, ["--import", "./tools/film/clock.mjs", "server/src/main.ts"], {
    cwd: ROOT,
    env: { ...process.env, DEV_COMMANDS: "1", ADMIN_SECRET: "film-local-secret-0123456789", PORT: String(port), WORLD_DIR: dir, FILM_CLOCK_PORT: String(clockPort), CHARITY_NAME: "Gamers Outreach", CHARITY_X: "GamersOutreach", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  proc.stdout.on("data", (d) => (out += d));
  proc.stderr.on("data", (d) => (out += d));
  for (let i = 0; i < 600 && !out.includes("game server on"); i++) await sleep(100);
  if (!out.includes("game server on")) throw new Error("server did not start:\n" + out.slice(-2000));
  const call = async (p) => (await fetch(`http://127.0.0.1:${clockPort}${p}`, { method: "POST" })).json();
  const clock = {
    live: () => call("/live"),
    stop: () => call("/stop"),
    advance: (ms) => call(`/advance?ms=${ms}`),
    sync: (n) => call(`/sync?n=${n}`),
    now: () => call("/now"),
  };
  return { proc, clock, url: `ws://127.0.0.1:${port}`, log: () => out };
}

export async function launch() {
  return chromium.launch({ headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });
}

// ------------------------------------------------------------------ the page
const HELPERS = `
window.__c = {
  g: () => window.__game,
  at(x, y, z) { return window.__game.blocks[(y << 18) | (z << 9) | x]; },
  top(x, z) { for (let y = 127; y > 0; y--) { const id = this.at(x, y, z); if (id !== 0 && id !== 11 && !(id >= 113 && id <= 120) && id !== 25 && id !== 26 && id !== 27 && id !== 220 && id !== 23) return y; } return 0; },
  chat(t) { window.__game.net.send({ t: "chat", text: t }); },
  yawPitch(fx, fy, fz, x, y, z) { const dx = x - fx, dy = y - fy, dz = z - fz; return [Math.atan2(-dx, dz) * 180 / Math.PI, -Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI]; },
  // the camera: the player's eye, set right before each render (x, y, z of the eye; yaw, pitch)
  cam: null,
  setCam(x, y, z, yaw, pitch) { this.cam = { x, y, z, yaw, pitch }; },
  look(ex, ey, ez, tx, ty, tz) { const [yaw, pitch] = this.yawPitch(ex, ey, ez, tx, ty, tz); this.cam = { x: ex, y: ey, z: ez, yaw, pitch }; },
  free() { this.cam = null; },
  noMove: false,
  slotOf(id) { return window.__game.inv.inv.findIndex((s, k) => k < 9 && s && s.id === id); },
  hold(id) {
    const g = window.__game;
    let s = this.slotOf(id);
    if (s < 0) {
      const k = g.inv.inv.findIndex((x) => x && x.id === id);
      if (k < 0) return -1;
      g.swapToHotbar(k, 8);
      s = 8;
    }
    g.selectSlot(s);
    return s;
  },
  clean(hud) {
    const g = window.__game; const u = g.ui; u.setClickToPlay(false); u.showTitle(false);
    document.querySelectorAll(".toast,.tipcard,.zonetoast,.nowplaying").forEach((e) => e.remove());
    document.querySelectorAll(".chat .line").forEach((e) => e.remove());
    const n = document.querySelector(".notice"); if (n) { n.textContent = ""; n.style.opacity = "0"; }
    g.hudHidden = hud === "none"; u.root.classList.toggle("nohud", hud === "none");
    document.documentElement.classList.toggle("film-hand", hud === "hand");
  },
};
(() => {
  const g = window.__game;
  const st = document.createElement("style");
  // "hand": the world and your hand, no HUD at all; never the server line (no player counts on anything)
  st.textContent = ".film-hand #ui .hud, .film-hand #ui .chat { display: none !important; } #ui .serverinfo, .toast, .tipcard, .zonetoast, .nowplaying, .clicktoplay { display: none !important; }";
  document.head.appendChild(st);
  g.adapt = () => {};
  const render = g.render.bind(g);
  g.render = (a, now, dt) => {
    const c = window.__c.cam;
    if (c) {
      const eye = g.eye;
      const p = g.phys;
      p.x = g.prev.x = c.x; p.y = g.prev.y = c.y - eye; p.z = g.prev.z = c.z;
      p.vx = p.vy = p.vz = 0;
      g.prevEye = eye;
      g.yaw = c.yaw; g.pitch = c.pitch;
    }
    render(a, now, dt);
  };
  const tick = g.tick.bind(g);
  g.tick = () => {
    const c = window.__c.cam;
    // (a resting player falls -0.0784 a tick into the ground: that is what keeps it "on the ground" for dig speeds)
    if (c) { const p = g.phys; p.x = c.x; p.y = c.y - g.eye; p.z = c.z; p.vx = p.vz = 0; p.vy = -0.0784; g.yaw = c.yaw; g.pitch = c.pitch; }
    tick();
  };
  const sendBin = g.net.sendBin.bind(g.net);
  g.net.sendBin = (b) => { if (window.__c.noMove && b && b[0] === 1) return; sendBin(b); };
  // meshing: count block changes sent to the mesher and the meshes that come back
  window.__mesh = { sent: 0, back: 0 };
  const setBlocks = g.chunks.setBlocks.bind(g.chunks);
  g.chunks.setBlocks = (list) => { if (list.length) window.__mesh.sent++; setBlocks(list); };
  const w = g.chunks.worker;
  w.addEventListener("message", (e) => { if (e.data && e.data.type === "meshes") window.__mesh.back++; });
})();
`;

export async function openPage(browser, { site, server, w = 1920, h = 1080, pixelRatio = 2, renderDist = 12, name, token }) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript({ path: join(HERE, "page-clock.js") });
  if (name) await page.addInitScript((n) => localStorage.setItem("steve_name", n), name);
  if (token) await page.addInitScript((t) => localStorage.setItem("steve_craft_token", t), token);
  await page.addInitScript(() => localStorage.setItem("steve_craft_seen_update", "99"));
  await page.goto(`${site}/play/?server=${encodeURIComponent(server)}`);
  for (let i = 0; i < 400; i++) {
    if ((await page.evaluate(() => window.__game && window.__game.state).catch(() => "")) === "play") break;
    await sleep(250);
  }
  await page.evaluate(HELPERS);
  const { ITEMS } = await import("../../shared/items.ts");
  const names = {};
  ITEMS.forEach((d, id) => d && d.key && (names[id] = d.key));
  await page.evaluate((names) => {
    window.__itemNames = names;
    window.__itemIds = Object.fromEntries(Object.entries(names).map(([id, k]) => [k, Number(id)]));
  }, names);
  await page.evaluate(([pr, rd]) => {
    const g = window.__game;
    g.renderer.setPixelRatio(pr);
    g.onResize();
    g.settings.renderDistance = rd;
    g.renderDist = rd;
    g.chunks.setRadius(rd + 1);
    g.settings.volume = 0;
    g.settings.music = 0;
    if (g.music && g.music.setVolume) g.music.setVolume(0);
    g.sound.setVolume(0);
  }, [pixelRatio, renderDist]);
  const cdp = await ctx.newCDPSession(page);
  const P = {
    page,
    ctx,
    cdp,
    errors,
    g: (fn, a) => page.evaluate(fn, a),
    cmd: async (t, wait = 250) => {
      await page.evaluate((x) => window.__c.chat(x), t);
      await sleep(wait);
    },
    async meshed(maxMs = 30000) {
      const t0 = Date.now();
      for (;;) {
        const s = await page.evaluate(() => ({ p: window.__game.chunks.pending, s: window.__mesh.sent, b: window.__mesh.back }));
        if (s.p === 0 && s.b >= s.s) return;
        if (Date.now() - t0 > maxMs) return;
        await sleep(60);
      }
    },
    async png(file, clip) {
      const r = await cdp.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
      const buf = Buffer.from(r.data, "base64");
      if (file) (await import("node:fs")).writeFileSync(file, buf);
      return buf;
    },
  };
  return P;
}

// ------------------------------------------------------------------ bots
export async function bot(url, name, token) {
  const b = new Bot();
  await b.connect(url, { name, token: token ?? `film-${name}-0123456789abcdef`.slice(0, 40) });
  return b;
}
/** Give items, wear armour (material 0 leather, 1 iron, 2 diamond: shift-clicks in the player window), hold a slot. */
export async function outfit(b, { armour = null, give = [], hold = null }) {
  const { armorId } = await import("../../shared/items.ts");
  if (armour !== null) for (const piece of ["helmet", "chestplate", "leggings", "boots"]) b.chat(`/give ${["leather", "iron", "diamond"][armour]}_${piece}`);
  for (const g of give) b.chat(`/give ${g}`);
  await sleep(900);
  if (armour !== null) {
    for (let k = 0; k < 4; k++) {
      const slot = b.inv.findIndex((s) => s && s.id === armorId(armour, k));
      if (slot < 0) continue;
      b.click(0, { m: "shift", s: slot < 9 ? 36 + slot : slot });
      await sleep(150);
    }
  }
  if (hold !== null) {
    const k = typeof hold === "number" ? hold : -1;
    if (k >= 0) b.select(k);
  }
}

/** The hotbar slot holding an item id (or -1). */
export const slotOf = (b, id) => b.inv.findIndex((s, k) => k < 9 && s && s.id === id);

/** A bot in a boat of its own at (x, z) on open water: it places the boat beside itself and gets in. Returns
 *  row(x, z, yaw, rowing) to move the boat (the bot drives it; the server checks the speed like any driver's). */
export async function boatBot(url, name, x, z) {
  const b = await bot(url, name);
  b.chat(`/tp ${x} 40 ${z}`);
  b.chat("/give boat 1");
  await sleep(900);
  const { I } = await import("../../shared/items.ts");
  const k = b.inv.findIndex((s, i) => i < 9 && s && s.id === I.BOAT);
  b.select(Math.max(0, k));
  b.move(x, 39.6, z, 0, 30, 8);
  await sleep(300);
  const before = new Set(b.boats.keys());
  b.send({ t: "boat_place", x: x + 1.6, y: 39.5, z });
  let id;
  for (let i = 0; i < 30 && id === undefined; i++) {
    await sleep(100);
    id = [...b.boats.keys()].find((k) => !before.has(k));
  }
  if (id === undefined) throw new Error(`${name}: no boat`);
  b.send({ t: "mount", id });
  await sleep(500);
  const y = b.boats.get(id).y;
  return {
    b,
    id,
    y,
    row(bx, bz, yaw, rowing = true) {
      b.send({ t: "boat", id, x: +bx.toFixed(3), y: +y.toFixed(3), z: +bz.toFixed(3), yaw: +yaw.toFixed(1), r: rowing ? 6 : 0 });
    },
  };
}

/** Hold the item with this key (e.g. "diamond_sword") from the hotbar; false if it is not there. */
export async function holdKey(b, key) {
  const { ITEMS } = await import("../../shared/items.ts");
  const id = ITEMS.findIndex((d) => d && d.key === key);
  const k = b.inv.findIndex((s, i) => i < 9 && s && s.id === id);
  if (k >= 0) b.select(k);
  return k >= 0;
}
