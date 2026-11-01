// Browser check of the damage sounds (update 10.1) in real headless Chrome against a local server with DEV_COMMANDS=1:
// the game's own loader decodes every new clip (the "oof" under 0.3 s), the replaced ones are gone; a fall plays
// your hurt; hitting a pig, a cow, a sheep and a chicken plays the hit thud and that animal's soft hurt; hitting a
// Shambler, a Rattler and a Skitter plays the thud and that mob's hurt, and a hit while falling plays the critical
// hit; every one at a random pitch of 0.8-1.2; no page errors.
// Usage: node tools/sound-check.cjs <site-url> <server-ws>      (PASS/FAIL lines; exit code 1 on any failure)
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
const DAMAGE = { hurt_0: 0.3, hit_0: 0.25, attack_crit_0: 0.32, pig_hurt_0: 0.45, cow_hurt_0: 0.5, sheep_hurt_0: 0.45, chicken_hurt_0: 0.4, shambler_hurt_0: 0.5, rattler_hurt_0: 0.4, skitter_hurt_0: 0.45 };
const inRange = (p) => p >= 0.8 && p <= 1.2;

(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });
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
  check((await g(() => window.__game.state)) === "play" && (await g(() => window.__game.gm)) === "survival", "joined in survival mode");
  await chat("/mobs off");
  await chat("/mobs clear");

  // ---- the files: the game's own loader decodes them all; the replaced clips are gone
  await g(() => {
    const s = window.__game.sound;
    window.__plays = [];
    const f = s.play.bind(s);
    s.play = (name, vol, pitch, at, range) => {
      window.__plays.push({ name, vol, pitch, t: performance.now() });
      return f(name, vol, pitch, at, range);
    };
    s.unlock();
  });
  let lens = null;
  for (let k = 0; k < 40 && !lens; k++) {
    await sleep(250);
    lens = await g((names) => {
      const b = window.__game.sound.buffers;
      if (!names.every((n) => b.has(n))) return null;
      return Object.fromEntries(names.map((n) => [n, b.get(n).duration]));
    }, Object.keys(DAMAGE));
  }
  check(!!lens, "the game loads and decodes all ten damage sounds");
  if (lens) {
    check(Object.entries(DAMAGE).every(([n, max]) => lens[n] > 0.05 && lens[n] <= max + 0.03), `each is short (${Object.entries(lens).map(([n, d]) => `${n.replace(/_0$/, "")} ${d.toFixed(2)}`).join(", ")})`);
    check(lens.hurt_0 < 0.3, `your "oof" is under 0.3 s (${lens.hurt_0.toFixed(3)} s)`);
  }
  const gone = await g(async () => Promise.all(["hurt_1", "hurt_2", "attack_strong_0", "attack_weak_0", "pig_hurt_1", "skitter_hurt_1"].map(async (n) => (await fetch(`/play/sounds/${n}.ogg`)).status)));
  check(gone.every((s) => s === 404), `the replaced clips are not shipped (${gone.join(" ")})`);

  // ---- out in the wild (the hub is a safe zone): a flat patch of grass
  const spot = await g(() => {
    const at = (x, y, z) => window.__game.blocks[(y << 18) | (z << 9) | x];
    const top = (x, z) => { for (let y = 127; y > 0; y--) { const id = at(x, y, z); if (id !== 0 && id !== 25 && id !== 26 && id !== 27) return y; } return 0; };
    for (let r = 80; r < 170; r += 4) for (let a = 0; a < 64; a++) {
      const x0 = Math.round(256 + Math.cos(a / 10) * r), z0 = Math.round(256 + Math.sin(a / 10) * r);
      const y = top(x0, z0);
      let ok = y > 41 && at(x0, y, z0) === 1;
      for (let x = x0 - 4; ok && x <= x0 + 4; x++) for (let z = z0 - 4; ok && z <= z0 + 4; z++) { if (top(x, z) !== y || at(x, y, z) !== 1) ok = false; for (let yy = y + 1; ok && yy < y + 5; yy++) { const id = at(x, yy, z); if (id !== 0 && id !== 25 && id !== 26 && id !== 27) ok = false; } }
      for (let yy = y + 1; ok && yy < y + 14; yy++) if (at(x0, yy, z0) !== 0) ok = false;
      if (ok) return { x: x0, y, z: z0 };
    }
    return null;
  });
  check(!!spot, "found a flat field");
  if (!spot) throw new Error("no field");
  const plays = (name, since) => g(([name, since]) => window.__plays.filter((p) => p.name === name && p.t >= since), [name, since]);
  const now = () => g(() => performance.now());

  // ---- a fall: your hurt
  await chat(`/tp ${spot.x + 0.5} ${spot.y + 1} ${spot.z + 0.5}`);
  await sleep(1200);
  let t0 = await now();
  const hp0 = await g(() => window.__game.stats.hp);
  // (12.1.2: falls are free to 6 blocks and cost half, and full-bar healing is quick: a 20-block drop shows for sure)
  await chat(`/tp ${spot.x + 0.5} ${spot.y + 21} ${spot.z + 0.5}`);
  await sleep(2600);
  const hp1 = await g(() => window.__game.stats.hp);
  const hurt = await plays("hurt", t0);
  check(hp1 < hp0 && hurt.length === 1 && inRange(hurt[0].pitch), `a fall hurts (${hp0} -> ${hp1}) and plays your "oof" once (pitch ${hurt[0] ? hurt[0].pitch.toFixed(2) : "-"})`);

  // ---- hitting things: the hit thud, and their hurt
  await chat("/give iron_sword 1");
  await sleep(500);
  const held = await g(() => { const w = window.__game; let s = w.inv.inv.findIndex((x, k) => k < 9 && x && x.id === 311); if (s < 0) { const k = w.inv.inv.findIndex((x) => x && x.id === 311); if (k < 0) return false; w.swapToHotbar(k, 8); s = 8; } w.selectSlot(s); return true; }); // iron sword
  check(held, "holding an iron sword");
  /** Aims at the nearest animal or mob of `key` and swings once it is targeted (charged); returns what happened. */
  const strike = (key, mob, jump) => g(async ([key, mob, jump]) => {
    const w = window.__game;
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    const near = () => { let best = null, bd = 1e9; for (const a of (mob ? w.mobs : w.animals).values()) { if (a.spec.key !== key) continue; const d = Math.hypot(a.x - w.phys.x, a.z - w.phys.z); if (d < bd) { bd = d; best = a; } } return best; };
    const aim = (a) => { const dx = a.x - w.phys.x, dy = a.y + a.spec.h * 0.55 - (w.phys.y + w.eye), dz = a.z - w.phys.z; w.yaw = (Math.atan2(-dx, dz) * 180) / Math.PI; w.pitch = (-Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI; };
    for (let k = 0; k < 60; k++) {
      const a = near();
      if (!a) { await nap(100); continue; }
      const d = Math.hypot(a.x - w.phys.x, a.z - w.phys.z);
      if (d > 2.6) { w.net.send({ t: "chat", text: `/tp ${a.x + 1.8} ${a.y + 0.1} ${a.z + 0.4}` }); await nap(700); continue; }
      aim(a);
      await nap(60);
      if ((mob ? w.targetMob : w.targetAnimal) !== a) { await nap(80); continue; }
      await nap(800); // a full charge
      if (jump) {
        w.keys.add("Space");
        await nap(90);
        w.keys.delete("Space");
        for (let j = 0; j < 30 && !(w.phys.vy < -0.1 && !w.phys.onGround); j++) await nap(20);
        aim(a);
      }
      const t = performance.now();
      w.mouse = 1;
      await nap(110);
      w.mouse = 0;
      await nap(500);
      return { t, ok: true };
    }
    const a = near();
    return { t: performance.now(), ok: false, why: a ? `d ${Math.hypot(a.x - w.phys.x, a.z - w.phys.z).toFixed(1)}, targeted ${(mob ? w.targetMob : w.targetAnimal) === a}` : `no ${key}` };
  }, [key, mob, jump]);

  for (const a of ["pig", "cow", "sheep", "chicken"]) {
    await chat(`/tp ${spot.x + 0.5} ${spot.y + 1} ${spot.z + 0.5}`);
    await sleep(600);
    await chat(`/summon ${a} 1`);
    await sleep(800);
    const r = await strike(a, false, false);
    const hit = await plays("hit", r.t - 50);
    const ow = await plays(`${a}_hurt`, r.t - 50);
    check(r.ok && hit.length >= 1 && ow.length >= 1 && [...hit, ...ow].every((p) => inRange(p.pitch)), `hitting a ${a}: the thud and its soft hurt (pitch ${[...hit, ...ow].map((p) => p.pitch.toFixed(2)).join(", ")})${r.why ? ` [${r.why}]` : ""}`);
  }

  await chat("/time 18000");
  await chat("/mobs freeze"); // frozen: they stand still and never fight back
  for (const m of ["shambler", "rattler", "skitter"]) {
    await chat("/mobs clear");
    await chat(`/tp ${spot.x + 0.5} ${spot.y + 1} ${spot.z + 0.5}`);
    await sleep(600);
    await g(() => { window.__game.yaw = 0; window.__game.pitch = 0; });
    await chat(`/summon ${m} 1 3`);
    await sleep(900);
    const r = await strike(m, true, false);
    const hit = await plays("hit", r.t - 50);
    const ow = await plays(`${m}_hurt`, r.t - 50);
    check(r.ok && hit.length >= 1 && ow.length >= 1 && [...hit, ...ow].every((p) => inRange(p.pitch)), `hitting a ${m}: the thud and its hurt (pitch ${[...hit, ...ow].map((p) => p.pitch.toFixed(2)).join(", ")})${r.why ? ` [${r.why}]` : ""}`);
    if (m === "shambler") {
      await g(() => { window.__crits = []; const w = window.__game; const o = w.net.onJson; w.net.onJson = (msg) => { if (msg.t === "struck") window.__crits.push(msg.crit); return o(msg); }; });
      const c = await strike(m, true, true);
      const crit = await plays("attack_crit", c.t - 50);
      const crits = await g(() => window.__crits);
      check(c.ok && crits.includes(true) && crit.length >= 1 && inRange(crit[0].pitch), `a hit while falling is a critical and plays the sharper crit hit (pitch ${crit[0] ? crit[0].pitch.toFixed(2) : "-"})`);
    }
  }
  await chat("/mobs clear");
  await chat("/mobs freeze");

  // ---- the pitch spread over many plays (the classic 0.8-1.2)
  const spread = await g(() => {
    const s = window.__game.sound;
    const before = window.__plays.length;
    for (let k = 0; k < 300; k++) { s.hurt(); s.attack("strong"); s.mob("rattler", "hurt", { x: 0, y: 0, z: 0 }); }
    const ps = window.__plays.slice(before).map((p) => p.pitch);
    return [Math.min(...ps), Math.max(...ps)];
  });
  check(spread[0] >= 0.8 && spread[1] <= 1.2 && spread[0] < 0.83 && spread[1] > 1.17, `damage sounds spread over pitch 0.8-1.2 (${spread.map((p) => p.toFixed(3)).join("-")})`);
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(" | ")}` : ""}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
