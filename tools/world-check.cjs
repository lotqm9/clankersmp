// Browser check of the world update (protocol v8, update 10) in real headless Chrome, two players (A and B) against a
// local server with DEV_COMMANDS=1: the islands are in the world every client builds; the new blocks render and
// reach the other player; a fence gate and a trapdoor open with a right click (with their sound); a flower goes into
// a pot; the village chime rings for the other player; a boat goes onto the water with a right click, A gets in by
// right-clicking it, rows with W and steers with A/D, B sees the boat move with A sitting in it, F5 shows A seated,
// Shift gets A out, and left clicks break it into a boat item; no page errors.
// Usage: node tools/world-check.cjs <site-url> <server-ws>      (PASS/FAIL lines; exit code 1 on any failure)
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

const HELPERS = `
window.__c = {
  at(x, y, z) { return window.__game.blocks[(y << 18) | (z << 9) | x]; },
  chat(t) { window.__game.net.send({ t: "chat", text: t }); },
  face(x, y, z) { const g = window.__game; const ex = g.phys.x, ey = g.phys.y + g.eye, ez = g.phys.z; const dx = x - ex, dy = y - ey, dz = z - ez; g.yaw = Math.atan2(-dx, dz) * 180 / Math.PI; g.pitch = -Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI; },
  hold(id) { const g = window.__game; let s = g.inv.inv.findIndex((x, k) => k < 9 && x && x.id === id); if (s < 0) { const k = g.inv.inv.findIndex((x) => x && x.id === id); if (k < 0) return -1; g.swapToHotbar(k, 8); s = 8; } g.selectSlot(s); return s; },
  spy(name) { const s = window.__game.sound; const f = s[name].bind(s); window.__spy = window.__spy || {}; window.__spy[name] = 0; s[name] = (...a) => { window.__spy[name]++; return f(...a); }; },
};`;

async function join(browser, label) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${site}/play/?server=${encodeURIComponent(server)}`);
  for (let i = 0; i < 200; i++) {
    if ((await page.evaluate(() => window.__game && window.__game.state).catch(() => "")) === "play") break;
    await sleep(250);
  }
  await page.evaluate(HELPERS);
  const g = (fn, arg) => page.evaluate(fn, arg);
  const chat = async (t) => {
    await g((t) => __c.chat(t), t);
    await sleep(300);
  };
  return { ctx, page, errors, g, chat, label };
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
  const A = await join(browser, "A");
  const Bp = await join(browser, "B");
  check((await A.g(() => window.__game.state)) === "play" && (await Bp.g(() => window.__game.state)) === "play", "both players joined (protocol 8)");
  const info = await A.g(() => ({ chests: window.__game.info.islands.chests, n: window.__game.info.islands.list.length }));
  check(info.n === 6 && info.chests.length === 1, "the client's world has the six islands and Old Keep's chest");
  const c = info.chests[0];
  check(await A.g(([x, y, z]) => { const id = __c.at(x, y, z); return id >= 130 && id < 134; }, [c.x, c.y, c.z]), "the treasure chest stands in the keep");
  check(await A.g(() => { let n = 0; for (let x = 30; x < 75; x++) for (let z = 30; z < 75; z++) for (let y = 40; y < 52; y++) if (__c.at(x, y, z) === 221) n++; return n > 20; }), "palm trunks on Palm Cay");

  // ---- a patch in the wild: the new blocks
  const spot = await A.g(() => {
    const top = (x, z) => { for (let y = 127; y > 0; y--) { const id = __c.at(x, y, z); if (id !== 0 && id !== 25 && id !== 26 && id !== 27) return y; } return 0; };
    for (let r = 80; r < 160; r += 4) for (let a = 0; a < 64; a++) {
      const x0 = Math.round(256 + Math.cos(a / 10) * r), z0 = Math.round(256 + Math.sin(a / 10) * r);
      const y = top(x0, z0);
      let ok = y > 41 && __c.at(x0, y, z0) === 1;
      for (let x = x0 - 5; ok && x <= x0 + 5; x++) for (let z = z0 - 5; ok && z <= z0 + 5; z++) { if (top(x, z) !== y || __c.at(x, y, z) !== 1) ok = false; for (let yy = y + 1; ok && yy < y + 6; yy++) { const id = __c.at(x, yy, z); if (id !== 0 && id !== 25 && id !== 26 && id !== 27) ok = false; } }
      if (ok) return { x: x0, y, z: z0 };
    }
    return null;
  });
  const { x, y, z } = spot;
  await A.chat(`/tp ${x + 0.5} ${y + 1} ${z - 2.5}`);
  await Bp.chat(`/tp ${x + 3.5} ${y + 1} ${z - 3.5}`);
  await A.chat("/gamemode creative");
  await sleep(800);
  const send = (P, m) => P.g((m) => window.__game.net.send(m), m);
  const place = async (px, py, pz, id) => {
    await send(A, { t: "cset", s: 0, id });
    await sleep(40);
    await send(A, { t: "place", x: px, y: py, z: pz, id });
    await sleep(180);
  };
  // clear the grass where the blocks go
  for (let dx = -2; dx <= 2; dx++) for (let dz = 0; dz <= 2; dz++) if (await A.g(([a, b, cc]) => __c.at(a, b, cc), [x + dx, y + 1, z + dz])) {
    await send(A, { t: "dig", a: "finish", x: x + dx, y: y + 1, z: z + dz });
    await sleep(120);
  }
  await place(x - 2, y + 1, z, 159); // cobblestone wall
  await place(x - 1, y + 1, z, 185); // fence gate facing north (runs along x)
  await place(x, y + 1, z, 160); // stone brick wall
  await place(x + 1, y + 1, z, 193); // trapdoor (bottom, closed)
  await place(x + 2, y + 1, z, 180); // flower pot
  await place(x - 2, y + 1, z + 2, 184); // village chime
  await place(x, y + 1, z + 2, 175); // lantern
  await place(x + 2, y + 1, z + 2, 177); // barrel
  await sleep(500);
  const want = [[x - 2, y + 1, z, 159], [x - 1, y + 1, z, 185], [x, y + 1, z, 160], [x + 1, y + 1, z, 193], [x + 2, y + 1, z, 180], [x - 2, y + 1, z + 2, 184], [x, y + 1, z + 2, 175], [x + 2, y + 1, z + 2, 177]];
  check(await Bp.g((w) => w.every(([a, b, cc, id]) => __c.at(a, b, cc) === id), want), "walls, a gate, a trapdoor, a pot, the chime, a lantern and a barrel reach B");
  await A.chat("/gamemode survival");
  await sleep(400);
  // ---- the gate and the trapdoor with a right click (their sounds too)
  await A.g(() => { __c.spy("gate"); });
  await A.g(([a, b, cc]) => __c.face(a + 0.5, b + 0.6, cc + 0.5), [x - 1, y + 1, z]);
  await sleep(250);
  check(await A.g(() => window.__game.target && window.__game.target.id === 185), "the cross-hair finds the gate");
  await A.g(() => window.__game.rightClick());
  await sleep(600);
  check(await Bp.g(([a, b, cc]) => { const id = __c.at(a, b, cc); return id >= 185 && id < 193 && ((id - 185) & 4) !== 0; }, [x - 1, y + 1, z]), "a right click opens the gate (B sees it open)");
  await A.g(([a, b, cc]) => __c.face(a + 0.5, b + 0.1, cc + 0.5), [x + 1, y + 1, z]);
  await sleep(250);
  await A.g(() => window.__game.rightClick());
  await sleep(600);
  check(await Bp.g(([a, b, cc]) => __c.at(a, b, cc) === 193 + 4, [x + 1, y + 1, z]), "and the trapdoor flips open");
  check((await A.g(() => window.__spy.gate)) >= 2, "with the gate sound");
  // ---- a poppy into the pot
  await A.chat("/give poppy 1");
  await sleep(400);
  await A.g(() => __c.hold(27));
  await A.g(([a, b, cc]) => __c.face(a + 0.5, b + 0.2, cc + 0.5), [x + 2, y + 1, z]);
  await sleep(250);
  await A.g(() => window.__game.rightClick());
  await sleep(600);
  check(await Bp.g(([a, b, cc]) => __c.at(a, b, cc) === 181, [x + 2, y + 1, z]), "a right click with a poppy pots it");
  // ---- the chime rings for B (A steps up to it: the cross-hair reaches 4.5 blocks)
  await A.chat(`/tp ${x - 1.5} ${y + 1} ${z + 0.5}`);
  await sleep(500);
  await Bp.g(() => { __c.spy("chime"); });
  await A.g(([a, b, cc]) => __c.face(a + 0.5, b + 0.5, cc + 0.5), [x - 2, y + 1, z + 2]);
  await sleep(250);
  await A.g(() => window.__game.selectSlot(7));
  await A.g(() => window.__game.rightClick());
  await sleep(700);
  check((await Bp.g(() => window.__spy.chime)) >= 1, "the village chime rings, and B hears it");

  // ---- boats: out to the sea off the west coast
  const sea = await A.g(() => {
    const W = (x, z) => __c.at(x, 39, z) === 11 && __c.at(x, 40, z) === 0;
    for (let z = 150; z < 360; z += 3) for (let x = 14; x < 60; x++) {
      let ok = true;
      for (let dx = -6; ok && dx <= 6; dx++) for (let dz = -6; ok && dz <= 6; dz++) if (!W(x + dx, z + dz)) ok = false;
      if (ok) return { x, z };
    }
    return null;
  });
  await A.chat(`/tp ${sea.x + 0.5} 39.3 ${sea.z + 0.5}`);
  await Bp.chat(`/tp ${sea.x + 4.5} 39.3 ${sea.z + 8.5}`);
  await A.chat("/give boat 1");
  await sleep(1500);
  await A.g(() => __c.hold(293));
  // look at the water two blocks ahead
  await A.g(([a, cc]) => __c.face(a + 0.5, 39.89, cc + 3.5), [sea.x, sea.z]);
  await sleep(300);
  const before = await A.g(() => [...window.__game.boats.keys()]); // (v10: the harbour's boats may be about too)
  await A.g(() => window.__game.rightClick());
  await sleep(1200);
  const boat = await A.g((old) => { const b = [...window.__game.boats.values()].find((q) => !old.includes(q.id)); return b ? { id: b.id, x: b.x, y: b.y, z: b.z } : null; }, before);
  const me = await A.g(() => ({ x: window.__game.phys.x, z: window.__game.phys.z }));
  check(!!boat && Math.hypot(boat.x - me.x, boat.z - me.z) < 4.6 && boat.y > 39 && boat.y < 39.9, "a right click with a boat puts it on the water ahead");
  check((await A.g(() => window.__game.inv.inv.some((s) => s && s.id === 293))) === false, "the boat is used up");
  check((await Bp.g((id) => window.__game.boats.has(id), boat.id)) === true, "B sees the boat");
  // get in: swim up to it, look at it and right-click
  await A.chat(`/tp ${boat.x - 2} 39.3 ${boat.z}`);
  await A.g(() => window.__game.keys.add("Space")); // tread water (hold jump) so we stay at the surface
  await sleep(1200);
  await A.g(([a, b, cc]) => __c.face(a, b + 0.3, cc), [boat.x, boat.y, boat.z]);
  await sleep(300);
  check(await A.g(() => !!window.__game.targetBoat), "the cross-hair finds the boat");
  await A.g(() => window.__game.rightClick());
  await A.g(() => window.__game.keys.delete("Space"));
  await sleep(800);
  check(await A.g(() => !!window.__game.ride && window.__game.ride.seat === 0 && !!window.__game.myBoat), "a right click on it: A sits in the front and rows");
  check(await Bp.g((id) => { const g = window.__game; const r = g.rides.get(id); return !!r; }, await A.g(() => window.__game.myId)), "B knows A is in the boat");
  // row: W for two seconds, then a little D
  const start = await A.g(() => ({ x: window.__game.myBoat.x, z: window.__game.myBoat.z, yaw: window.__game.myBoat.yaw }));
  await A.page.keyboard.down("KeyW");
  await sleep(2000);
  await A.page.keyboard.down("KeyD");
  await sleep(500);
  await A.page.keyboard.up("KeyD");
  await A.page.keyboard.up("KeyW");
  await sleep(900);
  const end = await A.g(() => ({ x: window.__game.myBoat.x, z: window.__game.myBoat.z, yaw: window.__game.myBoat.yaw }));
  const moved = Math.hypot(end.x - start.x, end.z - start.z);
  check(moved > 8, `W rows the boat (${moved.toFixed(1)} blocks in 2.5 s)`);
  check(Math.abs(((end.yaw - start.yaw + 540) % 360) - 180) > 20, "D steers it");
  const seen = await Bp.g((id) => { const b = window.__game.boats.get(id); return b ? { x: b.x, z: b.z } : null; }, boat.id);
  check(!!seen && Math.hypot(seen.x - end.x, seen.z - end.z) < 1.5, "B sees the boat where A rowed it");
  const aId = await A.g(() => window.__game.myId);
  const rider = await Bp.g(([id, bid]) => { const o = window.__game.others.get(id); const b = window.__game.boats.get(bid); return o && b ? Math.hypot(o.x - b.x, o.z - b.z) : 99; }, [aId, boat.id]);
  check(rider < 0.8, "and A sitting in it");
  // F5: A sees themself seated
  await A.g(() => { window.__game.view = 1; });
  await sleep(400);
  check(await A.g(() => window.__game.self.root.visible && Math.abs(window.__game.self.legR.rotation.x + 1.45) < 0.01), "F5: your avatar sits in the boat, legs out");
  await A.g(() => { window.__game.view = 0; });
  // Shift: out
  await A.page.keyboard.down("ShiftLeft");
  await sleep(150);
  await A.page.keyboard.up("ShiftLeft");
  await sleep(1000);
  check(await A.g(() => window.__game.ride === null), "Shift gets A out");
  check(await Bp.g((id) => !window.__game.rides.has(id), aId), "B sees A out of the boat");
  // break it: left clicks on it
  const b2 = await A.g((id) => { const b = window.__game.boats.get(id); return { x: b.x, y: b.y, z: b.z }; }, boat.id);
  await A.chat(`/tp ${b2.x + 1.8} 39.3 ${b2.z}`);
  await A.g(() => window.__game.keys.add("Space")); // tread water
  await sleep(1200);
  await A.g(([a, b, cc]) => __c.face(a, b + 0.3, cc), [b2.x, b2.y, b2.z]);
  await sleep(300);
  for (let k = 0; k < 20; k++) {
    if (!(await A.g((id) => window.__game.boats.has(id), boat.id))) break;
    await A.g(([a, b, cc]) => __c.face(a, b + 0.3, cc), [b2.x, b2.y, b2.z]);
    await A.g(() => { window.__game.mouse |= 1; });
    await sleep(110);
    await A.g(() => { window.__game.mouse &= ~1; });
    await sleep(110);
  }
  await A.g(() => window.__game.keys.delete("Space"));
  await sleep(600);
  check(await Bp.g((id) => !window.__game.boats.has(id), boat.id), "left clicks break the boat");
  check(await A.g(() => [...window.__game.drops.values()].some((d) => d.item === 293)), "into a boat item");
  check(A.errors.length === 0 && Bp.errors.length === 0, `no page errors${A.errors.length + Bp.errors.length ? ": " + [...A.errors, ...Bp.errors].join(" | ") : ""}`);
  await browser.close();
  console.log(failed ? `${failed} FAILED of ${passed + failed}` : `ALL PASS (${passed})`);
  process.exit(failed ? 1 : 0);
})();
