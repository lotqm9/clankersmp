// Browser check of the bigger spawn (update 12, protocol v10) in real headless Chrome against a local server with
// DEV_COMMANDS=1: the client builds the same world from the welcome's hub plan (no full download), you arrive in the
// courtyard facing north with the welcome arch, the monument (the three AIs) and the Beacon in view; the boards are
// painted (welcome, rules, tips, directions naming every road, the experiment in its hall, the latest update in its house);
// the hub is a safe zone out to r 68 (no building, no hits) and the wild starts past the ring; the Beacon's ladder
// climbs to the gallery; each gate's signpost names its road and the road reaches its village; boats wait at the
// harbour and you can row one away; no page errors.
// Usage: node tools/hub-check.cjs <site-url> <server-ws>      (PASS/FAIL lines; exit code 1 on any failure)
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

(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // record what the client sends (a "resync" would mean its terrain differed and it downloaded the whole world)
  await page.addInitScript(() => {
    window.__sent = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) {
      if (typeof d === "string") window.__sent.push(d.slice(0, 80));
      return send.call(this, d);
    };
  });
  await page.goto(`${site}/play/?server=${encodeURIComponent(server)}`);
  for (let i = 0; i < 240; i++) {
    if ((await page.evaluate(() => window.__game && window.__game.state).catch(() => "")) === "play") break;
    await sleep(250);
  }
  const g = (fn, arg) => page.evaluate(fn, arg);
  const chat = async (t) => {
    await g((t) => window.__game.net.send({ t: "chat", text: t }), t);
    await sleep(300);
  };
  const at = (x, y, z) => g(([x, y, z]) => window.__game.blocks[(y << 18) | (z << 9) | x], [x, y, z]);

  check((await g(() => window.__game.state)) === "play", "joined (protocol 10)");
  check(!(await g(() => window.__sent.some((m) => m.includes('"resync"')))), "the client built the same world from the welcome's hub plan (no full download)");
  const info = await g(() => { const i = window.__game.info; return { spawn: i.spawn, sh: i.spawnHeight, hub: i.hub, villages: i.villages.list.map((v) => ({ name: v.name, x: v.x, y: v.y, z: v.z })) }; });
  const CX = 256;
  const CZ = 256;
  const sh = info.sh;
  const h = info.hub;

  // ---- the arrival
  const me = await g(() => ({ x: window.__game.phys.x, y: window.__game.phys.y, z: window.__game.phys.z, yaw: window.__game.yaw }));
  check(Math.abs(me.x - info.spawn.x) < 1 && Math.abs(me.z - info.spawn.z) < 1 && me.z > CZ + 40, `you arrive in the courtyard south of the plaza (${me.x.toFixed(1)}, ${me.z.toFixed(1)})`);
  check(Math.abs(Math.abs(me.yaw) - 180) < 1, "facing north, to the monument and the Beacon");
  const arch = h.panels.find((p) => p.kind === "arrival" && p.nz === 1);
  check(!!arch && arch.text === "Welcome to clankersmp" && arch.z < me.z && arch.z > CZ + 30, "under the welcome arch");
  check(!!h.beacon && (await at(h.beacon.x, h.beacon.top, h.beacon.z)) === 138, "the Beacon stands north of the plaza, a diamond on the tip");
  const kinds = h.panels.map((p) => p.kind);
  check(["welcome", "rules", "tips", "directions", "experiment", "updates", "hall", "news", "starter", "beacon"].every((k) => kinds.includes(k)), "the boards: welcome, rules, tips, directions, the experiment and updates boards in their halls");
  const dir = h.panels.find((p) => p.kind === "directions");
  check(info.villages.every((v) => dir.lines.some((l) => l.startsWith(`${v.name}: `))) && dir.lines.some((l) => l.startsWith("Harbour: ")), `the directions name every road (${dir.lines.join(" | ")})`);
  // the boards are painted (a board's canvas has ink on it)
  const painted = await g(() => {
    const sc = window.__game.scenery;
    const list = sc && sc.panels ? sc.panels : [];
    return list.filter((e) => {
      const c = e.canvas.getContext("2d");
      const d = c.getImageData(0, 0, e.canvas.width, e.canvas.height).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 64) if (d[i] < 60 && d[i + 1] < 60 && d[i + 2] < 60) dark++;
      return dark > 10;
    }).length;
  });
  check(painted >= h.panels.length - 2, `the signs and boards are painted (${painted} of ${h.panels.length})`);

  // ---- the safe zone: out to r 68 (no building), the wild past it
  await chat("/give cobblestone 16");
  await sleep(500);
  const slot = await g(() => window.__game.inv.inv.findIndex((s) => s && s.id === 4));
  if (slot >= 0 && slot < 9) await g((s) => window.__game.selectSlot(s), slot);
  const tryPlace = async (x, z) => {
    const y = await g(([x, z]) => { const w = window.__game; for (let y = 120; y > 0; y--) { const id = w.blocks[(y << 18) | (z << 9) | x]; if (id !== 0 && id !== 25 && id !== 26 && id !== 27 && id !== 220) return y; } return 0; }, [x, z]);
    await chat(`/tp ${x + 0.5} ${y + 1} ${z + 2.5}`);
    await sleep(700);
    await g(([x, y, z]) => { const w = window.__game; const ex = w.phys.x, ey = w.phys.y + w.eye, ez = w.phys.z; const dx = x + 0.5 - ex, dy = y + 0.97 - ey, dz = z + 0.5 - ez; /* the ground's top face */ w.yaw = (Math.atan2(-dx, dz) * 180) / Math.PI; w.pitch = (-Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI; }, [x, y, z]);
    await sleep(200);
    const before = await at(x, y + 1, z);
    await g(() => window.__game.rightClick());
    await sleep(900);
    return { y, before, after: await at(x, y + 1, z) };
  };
  const notices0 = await g(() => document.querySelector(".notice")?.textContent || "");
  // a spot at r 58-62, inside the new zone (the old one ended at 46) and not a tile kept for a player's build
  const S = await g(() => {
    const z = window.__game.zone;
    for (let k = 0; k < 64; k++) {
      const x = Math.round(256 + Math.cos(k / 10.2) * 60), y = Math.round(256 + Math.sin(k / 10.2) * 60);
      if (z.contains(x + 0.5, y + 0.5) && z.contains(x + 0.5, y + 2.5) && Math.hypot(x - 256, y - 256) > 57 && Math.hypot(x - 256, y - 256) < 63) return [x, y];
    }
    return null;
  });
  const inHub = await tryPlace(S[0], S[1]);
  check(inHub.after === inHub.before, "no building in the hub at r 60 (the safe zone is 68 now)");
  const told = await g(() => document.querySelector(".notice")?.textContent || "");
  check(/safe zone|protected/i.test(told) && told !== notices0, `told why ("${told.trim()}")`);
  // the wild just past the hub (r 76), or a kept tile inside it if the world has one (its builders build on)
  const kept = await g(() => {
    const w = window.__game;
    const b = (x, y, z) => w.blocks[(y << 18) | (z << 9) | x];
    const top = (x, z) => { for (let y = 120; y > 0; y--) { const id = b(x, y, z); if (id !== 0 && id !== 25 && id !== 26 && id !== 27 && id !== 220) return y; } return 0; };
    for (const t of w.zone.keep) {
      const x0 = (t % 64) * 8, z0 = Math.floor(t / 64) * 8;
      if (Math.hypot(x0 + 4 - 256, z0 + 4 - 256) > 64) continue;
      // open grass with room to stand two blocks south of it
      for (let z = z0; z < z0 + 6; z++)
        for (let x = x0; x < x0 + 8; x++) {
          const y = top(x, z);
          if (b(x, y, z) === 1 && top(x, z + 2) === y && b(x, y + 1, z + 2) === 0 && b(x, y + 2, z + 2) === 0 && b(x, y + 1, z + 1) === 0 && b(x, y + 2, z + 1) === 0) return [x, z];
        }
    }
    return null;
  });
  if (kept) {
    const k = await tryPlace(kept[0], kept[1]);
    check(k.after === 4, `building works in a tile kept for a player's build inside the hub (${kept[0] - CX}, ${kept[1] - CZ})`);
  }
  const wild = await tryPlace(CX - 30, CZ - 70); // r 76: the wild
  check(wild.after === 4, "building works in the wild just past the hub (r 76)");

  // ---- the Beacon: climb the ladder to the gallery
  await chat(`/tp ${CX + 0.5} ${sh + 1} ${CZ - 36.5}`);
  await sleep(800);
  await g(() => { const w = window.__game; w.yaw = 180; w.pitch = -30; w.keys.clear(); w.keys.add("KeyW"); });
  let top = 0;
  for (let k = 0; k < 140; k++) {
    await sleep(250); // (a ladder climbs about 2.35 blocks a second: some 20 seconds to the top)
    top = await g(() => window.__game.phys.y);
    if (top >= sh + 46) break;
  }
  await g(() => window.__game.keys.clear());
  check(top >= sh + 46, `the Beacon's ladder climbs to the lantern room (feet at ${(top - sh).toFixed(1)} over the plaza)`);
  // out through a door onto the gallery
  await chat(`/tp ${CX + 0.5} ${sh + 46} ${CZ - 36 + 4.5}`);
  await sleep(600);
  const onGallery = await g(() => window.__game.phys.y);
  check(Math.abs(onGallery - (sh + 46)) < 0.6, "the gallery holds you, 46 blocks up");

  // ---- the gates and the roads
  for (const gate of h.gates) {
    const signs = h.panels.filter((p) => p.kind === "gate" && Math.hypot(p.x - gate.x, p.z - gate.z) < 8);
    check(signs.length === 2 && gate.names.every((n) => signs.some((p) => p.text.includes(n))), `the gate for ${gate.names.join(", ")}: its signpost names it`);
  }
  check(h.roads.every((r) => r.reached), `every road reaches its end (${h.roads.map((r) => `${r.to} ${r.cells}`).join(", ")})`);

  // ---- the harbour: boats waiting; take one and row out
  const hb = h.harbour;
  await chat(`/tp ${hb.x + 0.5} ${hb.y + 1} ${hb.z - 1.5}`);
  await sleep(2500);
  const boats = await g((slots) => slots.filter((s) => [...window.__game.boats.values()].some((b) => Math.hypot(b.x - s.x, b.z - s.z) < 1.5)).length, hb.slots);
  check(boats === hb.slots.length, `a boat waits at every harbour slot (${boats} of ${hb.slots.length})`);
  const s0 = hb.slots[0];
  const boat = await g((s) => { const b = [...window.__game.boats.values()].find((q) => Math.hypot(q.x - s.x, q.z - s.z) < 1.5); return b ? { id: b.id, x: b.x, z: b.z } : null; }, s0);
  if (boat) {
    await chat(`/tp ${boat.x + 0.5} ${hb.y + 1} ${hb.z + 0.5}`);
    await sleep(500);
    await g((id) => window.__game.net.send({ t: "mount", id }), boat.id);
    await sleep(800);
    const riding = await g(() => !!window.__game.ride);
    check(riding, "you can take a harbour boat");
    await g(() => { const w = window.__game; w.yaw = 0; w.keys.clear(); w.keys.add("KeyW"); });
    await sleep(4000);
    await g(() => window.__game.keys.clear());
    const after = await g((id) => { const b = window.__game.boats.get(id); return b ? { x: b.x, z: b.z } : null; }, boat.id);
    check(!!after && after.z - boat.z > 3, `and row it out to sea (${after ? (after.z - boat.z).toFixed(1) : "?"} blocks)`);
  } else check(false, "a harbour boat to take");

  check(errors.length === 0, `no page errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
  console.log(`${passed} passed, ${failed} failed`);
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
