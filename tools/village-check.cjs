// Browser check of the villages (protocol v9, update 11) in real headless Chrome against a local server with
// DEV_COMMANDS=1 (a fresh world): the client builds the four villages the server names; the villagers come into view
// with their outfits and name tags; a right click on the farmer opens the native trade window with five offers (the
// ones you can't afford dimmed); clicking an offer trades (wheat for a ruby: the inventory changes, the stock falls,
// the trade sound), shift-click trades as many as it can; Esc closes it and the farmer goes back to its day; a poke
// makes it flinch with a startled sound and does no harm; at dusk every villager walks home through its door (which
// opens, then shuts again); the farmer's loot chest is full; no page errors.
// Usage: node tools/village-check.cjs <site-url> <server-ws>      (PASS/FAIL lines; exit code 1 on any failure)
const PW = process.env.PLAYWRIGHT || "C:/Users/vincu/Desktop/memecoin/sites/evolve/node_modules/playwright";
const { chromium } = require(PW);
const site = (process.argv[2] || "http://127.0.0.1:5300").replace(/\/$/, "");
const server = process.argv[3] || "ws://127.0.0.1:8797";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
let passed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (ok) passed++;
  else failed++;
};
const ID = { WHEAT: 282, RUBY: 264, BREAD: 283, CHIME: 184, CHEST: 130 };

(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${site}/play/?server=${encodeURIComponent(server)}`);
  for (let i = 0; i < 200; i++) {
    if ((await page.evaluate(() => window.__game && window.__game.state).catch(() => "")) === "play") break;
    await sleep(250);
  }
  const g = (fn, arg) => page.evaluate(fn, arg);
  const chat = async (t) => {
    await g((t) => window.__game.net.send({ t: "chat", text: t }), t);
    await sleep(300);
  };
  const count = (id) => g((id) => window.__game.inv.inv.reduce((n, s) => n + (s && s.id === id ? s.n : 0), 0), id);
  await g(() => {
    const s = window.__game.sound;
    window.__plays = [];
    const f = s.play.bind(s);
    s.play = (name, vol, pitch, at, range) => {
      window.__plays.push({ name, t: performance.now() });
      return f(name, vol, pitch, at, range);
    };
  });
  const played = (name) => g((name) => window.__plays.filter((p) => p.name === name).length, name);

  check((await g(() => window.__game.state)) === "play", "joined (protocol 9)");
  const vs = await g(() => window.__game.info.villages.list.map((v) => ({ name: v.name, x: v.x, y: v.y, z: v.z, chime: v.chime, villagers: v.villagers, houses: v.houses, chests: v.chests })));
  check(vs.length === 4, `the client built the four villages the server named (${vs.map((v) => v.name).join(", ")})`);
  check(await g((vs) => vs.every((v) => window.__game.blocks[(v.chime[1] << 18) | (v.chime[2] << 9) | v.chime[0]] === 184), vs), "each with its village chime in the plaza");
  const v = vs[0];
  await chat("/mobs off");
  await chat("/time 4000");
  await chat(`/tp ${v.x + 0.5} ${v.y + 1} ${v.z + 6.5}`);
  await sleep(2500);
  const seen = await g(() => [...window.__game.villagers.values()].map((q) => ({ id: q.id, job: q.job, name: q.name, tag: !!q.tag })));
  check(seen.length >= 5 && v.villagers.every((d) => seen.some((q) => q.id === d.id && q.name === d.name)), `its five villagers are here, named (${seen.map((q) => q.name).join(", ")})`);
  check(new Set(seen.filter((q) => v.villagers.some((d) => d.id === q.id)).map((q) => q.job)).size === 5, "one of each job: farmer, smith, librarian, fisher, mason");

  // ---- trading with the farmer
  const farmer = v.villagers.find((d) => d.job === 0);
  await chat("/give wheat 45");
  await sleep(500);
  const talk = async () => {
    for (let k = 0; k < 8; k++) {
      const p = await g((id) => { const q = window.__game.villagers.get(id); return q ? [q.x, q.y, q.z] : null; }, farmer.id);
      if (!p) return false;
      await chat(`/tp ${p[0] + 1.6} ${p[1] + 0.1} ${p[2] + 0.3}`);
      await sleep(700);
      await g((id) => { const w = window.__game; const q = w.villagers.get(id); const dx = q.x - w.phys.x, dy = q.y + 1.4 - (w.phys.y + w.eye), dz = q.z - w.phys.z; w.yaw = (Math.atan2(-dx, dz) * 180) / Math.PI; w.pitch = (-Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI; }, farmer.id);
      await sleep(150);
      if (!(await g((id) => window.__game.targetVillager && window.__game.targetVillager.id === id, farmer.id))) continue;
      await g(() => window.__game.rightClick());
      for (let j = 0; j < 20; j++) {
        await sleep(150);
        if (await g(() => window.__game.win && window.__game.win.kind === "trade")) return true;
      }
    }
    return false;
  };
  check(await talk(), "a right click on the farmer opens its trade window");
  check((await page.locator(".trow").count()) === 5, "five offers");
  const op = await page.locator(".trow").evaluateAll((rows) => rows.map((r) => Number(r.style.opacity || 1)));
  check(op[0] === 1 && op[1] < 1, `what you can't afford is dimmed (wheat ${op[0]}, sugar cane ${op[1]})`);
  const rubies0 = await count(ID.RUBY);
  await page.locator(".trow").first().click();
  await sleep(900);
  check((await count(ID.RUBY)) === rubies0 + 1 && (await count(ID.WHEAT)) === 25, "clicking the first offer: 20 wheat for a ruby");
  check((await page.locator(".trow").first().innerHTML()).length > 0 && (await played("trade")) >= 1, "with the trade sound (rubies clinking)");
  await page.keyboard.down("Shift");
  await page.locator(".trow").first().click();
  await page.keyboard.up("Shift");
  await sleep(900);
  check((await count(ID.RUBY)) === rubies0 + 2 && (await count(ID.WHEAT)) === 5, "shift-click: as many as you can afford (one more)");
  const left = await g(() => window.__game.invUI.offers[0].n);
  check(left === 14, `the stock fell to ${left}`);
  await page.locator(".trow").nth(2).click(); // a ruby for bread
  await sleep(900);
  check((await count(ID.BREAD)) === 6, "a ruby buys six bread");
  await page.keyboard.press("Escape");
  await sleep(800);
  check(await g(() => !window.__game.win), "Esc closes the trade window");
  await sleep(1200);
  check(await g((id) => !(window.__game.villagers.get(id).flags & 2), farmer.id), "and the farmer goes back to its day");

  // ---- a poke
  const hurt0 = await played("villager_hurt");
  const stats0 = await g(() => JSON.stringify(window.__game.stats));
  for (let k = 0; k < 6; k++) {
    const p = await g((id) => { const q = window.__game.villagers.get(id); return [q.x, q.y, q.z]; }, farmer.id);
    await chat(`/tp ${p[0] + 1.6} ${p[1] + 0.1} ${p[2] + 0.3}`);
    await sleep(600);
    await g((id) => { const w = window.__game; const q = w.villagers.get(id); const dx = q.x - w.phys.x, dy = q.y + 1.2 - (w.phys.y + w.eye), dz = q.z - w.phys.z; w.yaw = (Math.atan2(-dx, dz) * 180) / Math.PI; w.pitch = (-Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI; }, farmer.id);
    await sleep(150);
    if (!(await g((id) => window.__game.targetVillager && window.__game.targetVillager.id === id, farmer.id))) continue;
    await g(() => { window.__game.mouse = 1; });
    await sleep(120);
    await g(() => { window.__game.mouse = 0; });
    await sleep(700);
    if ((await played("villager_hurt")) > hurt0) break;
  }
  check((await played("villager_hurt")) > hurt0, "a poke: a startled sound");
  check(await g((id) => window.__game.villagers.has(id), farmer.id) && (await g(() => JSON.stringify(window.__game.stats))) === stats0, "and no harm done");

  // ---- the farmer's loot chest
  const lc = v.chests.find((c) => c.kind === "farmer");
  await chat(`/tp ${lc.x + 0.5} ${lc.y} ${lc.z + 0.5}`);
  await sleep(600);
  await g((c) => window.__game.net.send({ t: "use", x: c.x, y: c.y, z: c.z }), lc);
  await sleep(900);
  const loot = await g(() => (window.__game.win && window.__game.win.kind === "chest" ? window.__game.win.menu.contents().slice(0, 27).filter(Boolean).length : -1));
  check(loot >= 3, `the farmer's chest holds loot (${loot} stacks)`);
  await page.keyboard.press("Escape");
  await sleep(500);

  // ---- dusk: home through the doors
  await chat("/gamemode creative");
  await chat(`/tp ${v.x - 8.5} ${v.y + 9} ${v.z + 8.5}`);
  await g(() => { window.__game.phys.flying = true; });
  await sleep(1500);
  await chat("/time 12100");
  let home = 0;
  let opened = false;
  for (let k = 0; k < 40 && home < 5; k++) {
    await sleep(1000);
    home = await g((vv) => vv.villagers.filter((d) => { const q = window.__game.villagers.get(d.id); return q && Math.hypot(q.x - d.home[0] - 0.5, q.z - d.home[2] - 0.5) < 1.2; }).length, v);
    if (!opened) opened = await g((vv) => vv.houses.some((h) => { const id = window.__game.blocks[(h.door[1] << 18) | (h.door[2] << 9) | h.door[0]]; return id >= 33 && id < 49 && ((id - 33) & 4) !== 0; }), v);
  }
  check(home === 5, `at dusk every villager walks home (${home} of 5 inside)`);
  check(opened, "their doors open as they come");
  await sleep(3000);
  check(await g((vv) => vv.houses.every((h) => { const id = window.__game.blocks[(h.door[1] << 18) | (h.door[2] << 9) | h.door[0]]; return id >= 33 && id < 49 && ((id - 33) & 4) === 0; }), v), "and shut again behind them");
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(" | ")}` : ""}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
