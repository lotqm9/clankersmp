// The switch's stills at 2400x1350 (X 16:9) from the real game: the built client against a local server, protocol
// bots as the other players, real light. No debug text; HUD only where the GUI is the subject; never a player count.
//   node tools/film/stills.mjs <outdir> [shot ...]     shots: hero cave night trade boat craft builder
// Env: SITE (default http://127.0.0.1:5240), PORT (8841), CLOCK (8898).
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boatBot, bot, holdKey, launch, openPage, outfit, sleep, startServer } from "./director.mjs";
import { stepper } from "./step.mjs";

const out = process.argv[2];
const ALL = ["hero", "cave", "night", "trade", "boat", "craft"];
const only = process.argv.slice(3).length ? process.argv.slice(3) : ALL;
const SITE = process.env.SITE || "http://127.0.0.1:5240";
const W = 2400;
const H = 1350;
mkdirSync(out, { recursive: true });
const want = (s) => only.includes(s);
const yawTo = (fx, fz, tx, tz) => (Math.atan2(-(tx - fx), tz - fz) * 180) / Math.PI;
const pitchTo = (fx, fy, fz, tx, ty, tz) => (-Math.atan2(ty - fy, Math.hypot(tx - fx, tz - fz)) * 180) / Math.PI;

const dir = mkdtempSync(join(tmpdir(), "steve-stills-"));
const S = await startServer({ port: Number(process.env.PORT || 8841), clockPort: Number(process.env.CLOCK || 8898), dir });
console.log("server up", S.url, "pid", S.proc.pid);
const browser = await launch();
const bots = [];
const mkBot = async (name) => {
  const b = await bot(S.url, name);
  bots.push(b);
  return b;
};
const dropBots = () => {
  for (const b of bots.splice(0)) b.close();
};
let code = 0;
try {
  const P = await openPage(browser, { site: SITE, server: S.url, w: W, h: H, pixelRatio: 2, renderDist: 12, name: "SteveFan_2014" });
  const st = stepper(P, S.clock, 60);
  const sh = await P.g(() => window.__game.info.spawnHeight);
  const lm = await P.g(() => window.__game.info.hub.landmark);
  const villages = await P.g(() => window.__game.info.villages.list.map((v) => ({ name: v.name, x: v.x, y: v.y, z: v.z })));
  const look = (e, t) => P.g(([e, t]) => window.__c.look(e[0], e[1], e[2], t[0], t[1], t[2]), [e, t]);
  const top = (x, z) => P.g(([x, z]) => window.__c.top(x, z), [x, z]);
  const give = async (list) => {
    for (const g of list) await P.cmd(`/give ${g}`, 120);
    await sleep(500);
  };
  const hold = (key, slot = 2) =>
    P.g(([k, slot]) => {
      const g = window.__game;
      const id = window.__itemIds[k];
      let s = g.inv.inv.findIndex((x, i) => i < 9 && x && x.id === id);
      if (s < 0) {
        const j = g.inv.inv.findIndex((x) => x && x.id === id);
        if (j < 0) return -1;
        g.swapToHotbar(j, slot);
        s = slot;
      }
      g.selectSlot(s);
      return s;
    }, [key, slot]);
  const guiScale = (s) => P.g((s) => document.documentElement.style.setProperty("--s", `${s}px`), s);
  const shot = async (name) => {
    await sleep(200);
    await P.png(join(out, name));
    console.log("saved", name);
  };
  const settle = async (ms = 2500) => {
    await P.meshed();
    await sleep(ms);
    await P.meshed();
  };
  await P.cmd("/mobs off");
  await P.cmd("/mobs clear");
  await P.cmd("/gamemode creative");

  // ---------------------------------------------------------------- 1. the hero: the landmark at sunset, players round it
  if (want("hero")) {
    await P.cmd(`/tp 256.5 ${sh + 1} 276.5`, 500);
    await P.cmd("/time 12650");
    await P.g(() => window.__c.clean("none"));
    await P.g(() => (window.__c.noMove = true));
    // players on the plaza between the camera and the figure, looking up at it (one swings a pickaxe, one wears diamond)
    const crew = [
      { n: "DiamondMiner_7168", x: 277.5, z: 244.5, look: [254, sh + 26, 250], hold: "iron_pickaxe", swing: true },
      { n: "LuckySteve_4410", x: 274.5, z: 247.5, look: [255, sh + 24, 251] },
      { n: "BlockyBuilder_2203", x: 272.5, z: 242.5, look: [253, sh + 22, 251], armour: 2, hold: "diamond_sword" },
      { n: "EpicCrafter_9051", x: 270.5, z: 249.5, look: [258, sh + 20, 254] },
      { n: "PixelQueen_3317", x: 279.5, z: 248.5, look: [262, sh + 12, 256], armour: 1 },
    ];
    for (const c of crew) {
      const b = await mkBot(c.n);
      c.b = b;
      c.y = (await top(Math.floor(c.x), Math.floor(c.z))) + 1;
      b.chat(`/tp ${c.x} ${c.y} ${c.z}`);
      if (c.armour !== undefined || c.hold) await outfit(b, { armour: c.armour ?? null, give: c.hold ? [`${c.hold} 1`] : [] });
    }
    await sleep(900);
    for (const c of crew) {
      if (c.hold) await holdKey(c.b, c.hold);
      else c.b.select(5); // an empty hand
      c.b.move(c.x, c.y, c.z, yawTo(c.x, c.z, c.look[0], c.look[2]), pitchTo(c.x, c.y + 1.62, c.z, ...c.look), 4);
    }
    // north-east of the figure, looking south-west: his face and the punch, the sunset behind him
    const cams = [
      [[293, sh + 3.2, 244], [254, sh + 16, 255]],
      [[291, sh + 6, 243], [253, sh + 18, 255]],
      [[290, sh + 16, 238], [250, sh + 20, 258]],
    ];
    for (const [k, [e, t]] of cams.entries()) {
      await look(e, t);
      await settle(3500);
      for (const c of crew) if (c.swing) c.b.swing();
      await sleep(120);
      await shot(`hero-${k}.png`);
    }
    dropBots();
    await P.g(() => (window.__c.noMove = false));
  }

  // ---------------------------------------------------------------- 2. the cave: ruby and diamond, torches, a pickaxe
  if (want("cave")) {
    const C = { x: 116, y: 12, z: 426 };
    await P.cmd("/gamemode survival");
    await P.cmd(`/tp ${C.x + 0.5} ${C.y} ${C.z + 0.5}`, 800);
    await P.cmd("/time 6000");
    await give(["iron_pickaxe 1", "torch 16"]);
    await settle(1500);
    await P.g(() => {
      const g = window.__game;
      g.settings.brightness = 1;
      g.applySettings(g.settings);
    });
    // torches on the floor round about (air over solid stone, a few blocks out)
    const spots = await P.g(([cx, cy, cz]) => {
      const c = window.__c;
      const out = [];
      for (const [dx, dz] of [[2, -2], [-2, 2], [3, 1], [-3, -1], [1, 3], [-1, -3], [4, -1], [-4, 1], [2, 3], [-2, -3]]) {
        for (let dy = -2; dy <= 2; dy++) {
          const x = cx + dx, y = cy + dy, z = cz + dz;
          const below = c.at(x, y - 1, z);
          if (c.at(x, y, z) === 0 && below !== 0 && below !== 11 && below !== 23 && below !== 111 && below !== 112) { out.push([x, y, z]); break; }
        }
      }
      return out;
    }, [C.x, C.y, C.z]);
    for (const [x, y, z] of spots.slice(0, 5))
      await P.g(([x, y, z]) => {
        const g = window.__game;
        window.__c.hold(23);
        g.setLocal(x, y, z, 23);
        g.net.send({ t: "place", x, y, z, id: 23 });
      }, [x, y, z]);
    await sleep(600);
    await hold("iron_pickaxe", 2);
    await P.g(() => window.__c.clean("hand"));
    const eye = [C.x + 0.5, C.y + 1.62, C.z + 0.5];
    // looking over the diamond floor to the ruby, then mid-dig on a diamond ore with its cracks
    await look(eye, [115.5, 12.2, 429.5]);
    await settle(2500);
    await shot("cave-0.png");
    await look(eye, [117.5, 11.6, 427.5]);
    await settle(800);
    await st.start();
    await st.run(4);
    await P.g(() => (window.__game.mouse = 1));
    await st.run(26);
    await shot("cave-1.png");
    await P.g(() => (window.__game.mouse = 0));
    await st.stop();
    await P.g(() => {
      const g = window.__game;
      g.settings.brightness = 0.5;
      g.applySettings(g.settings);
    });
    await P.cmd("/gamemode creative");
  }

  // ---------------------------------------------------------------- 3. night: armour, a sword swing, the mobs
  if (want("night")) {
    const L = { x: 341, y: 44, z: 296 }; // a lantern post on the road east to Larkholm
    const gy = (await top(L.x + 2, L.z + 2)) + 1;
    await P.cmd(`/tp ${L.x + 9.5} ${gy} ${L.z + 6.5}`, 600);
    await P.cmd("/time 18000");
    await P.g(() => {
      const g = window.__game;
      g.settings.brightness = 1;
      g.applySettings(g.settings);
      window.__c.clean("none");
      window.__c.noMove = true;
    });
    const hero = await mkBot("SteveFan_7777");
    const friend = await mkBot("IronSword_2497");
    await outfit(hero, { armour: 2, give: ["diamond_sword 1"] });
    await outfit(friend, { armour: 1, give: ["iron_sword 1"] });
    const hp = { x: L.x + 2.5, y: gy, z: L.z + 1.5 };
    const fp = { x: L.x + 0.5, y: (await top(L.x, L.z + 4)) + 1, z: L.z + 4.5 };
    hero.chat(`/tp ${hp.x} ${hp.y} ${hp.z}`);
    friend.chat(`/tp ${fp.x} ${fp.y} ${fp.z}`);
    await sleep(800);
    await holdKey(hero, "diamond_sword");
    await holdKey(friend, "iron_sword");
    // the mobs, summoned by the hero (in front of it) and frozen mid-stride
    hero.move(hp.x, hp.y, hp.z, -90, 0, 4); // facing east
    await sleep(300);
    hero.chat("/summon shambler 1 3");
    hero.chat("/summon skitter 1 7");
    friend.move(fp.x, fp.y, fp.z, -60, 0, 4);
    friend.chat("/summon shambler 1 4");
    await sleep(700);
    await P.cmd("/mobs freeze");
    await sleep(600);
    const mobs = await P.g(() => [...window.__game.mobs.values()].map((m) => ({ x: m.x, y: m.y, z: m.z, kind: m.kind })));
    console.log("night mobs", JSON.stringify(mobs));
    const near = (p) => mobs.reduce((a, m) => (!a || Math.hypot(m.x - p.x, m.z - p.z) < Math.hypot(a.x - p.x, a.z - p.z) ? m : a), null);
    const mh = near(hp);
    const mf = near(fp);
    hero.move(hp.x, hp.y, hp.z, yawTo(hp.x, hp.z, mh.x, mh.z), 8, 4);
    friend.move(fp.x, fp.y, fp.z, yawTo(fp.x, fp.z, mf.x, mf.z), 8, 4);
    // the camera low at the side of the fight, the lantern post in frame
    const mid = [(hp.x + mh.x) / 2, hp.y + 1.1, (hp.z + mh.z) / 2];
    // side on to the fight (south of the line from the hero to its Shambler), the lantern post behind
    const ux = (mh.x - hp.x) / Math.hypot(mh.x - hp.x, mh.z - hp.z);
    const uz = (mh.z - hp.z) / Math.hypot(mh.x - hp.x, mh.z - hp.z);
    const cams = [
      [[mid[0] - uz * 4.6 - ux * 0.8, hp.y + 1.7, mid[2] + ux * 4.6 - uz * 0.8], [mid[0], mid[1] + 0.1, mid[2]]],
      [[mid[0] - uz * 5.5 - ux * 2.5, hp.y + 2.2, mid[2] + ux * 5.5 - uz * 2.5], [mid[0] + ux, mid[1], mid[2] + uz]],
      [[mid[0] + uz * 4.6 - ux * 1.5, hp.y + 1.8, mid[2] - ux * 4.6 - uz * 1.5], [mid[0], mid[1] + 0.1, mid[2]]],
    ];
    for (const [k, [e, t]] of cams.entries()) {
      await look(e, t);
      await settle(2500);
      await st.start();
      await st.run(2);
      hero.swing();
      friend.swing();
      await st.run(5);
      await shot(`night-${k}.png`);
      await st.stop();
    }
    await P.cmd("/mobs clear");
    await P.cmd("/mobs freeze"); // (back to moving)
    dropBots();
    await P.g(() => {
      const g = window.__game;
      g.settings.brightness = 0.5;
      g.applySettings(g.settings);
      window.__c.noMove = false;
    });
  }

  // ---------------------------------------------------------------- 4. the village, a ruby trade on screen
  if (want("trade")) {
    const v = villages.find((q) => q.name === "Larkholm") ?? villages[0];
    await P.cmd("/gamemode survival");
    await P.cmd(`/tp ${v.x + 0.5} ${v.y + 1} ${v.z + 0.5}`, 800);
    await P.cmd("/time 3000");
    await give(["ruby 24", "wheat 20"]);
    await P.g(() => window.__game.selectSlot(1));
    await settle(2000);
    const q = await P.g(([vx, vz]) => {
      const list = [...window.__game.villagers.values()].map((q) => ({ id: q.id, x: q.x, y: q.y, z: q.z }));
      list.sort((a, b) => Math.hypot(a.x - vx, a.z - vz) - Math.hypot(b.x - vx, b.z - vz));
      return list[0];
    }, [v.x, v.z]);
    // stand back from the villager so it shows beside the window, the street behind
    const me = [q.x + 2.6, q.y, q.z + 1.6];
    await P.cmd(`/tp ${me[0]} ${me[1]} ${me[2]}`, 700);
    await look([me[0], me[1] + 1.62, me[2]], [q.x - 2.2, q.y + 1.3, q.z - 1.3]);
    await P.g(() => window.__c.clean("gui"));
    await guiScale(5);
    await settle(1500);
    await P.g((id) => {
      const g = window.__game;
      const v = g.villagers.get(id);
      if (v) g.talkTo(v);
    }, q.id);
    await sleep(1200);
    await P.g(() => {
      const g = window.__game;
      const offers = g.invUI.offers || [];
      const have = (id) => g.inv.inv.reduce((n, s) => n + (s && s.id === id ? s.n : 0), 0);
      const ok = (o) => o.n > 0 && have(o.a[0]) >= o.a[1] && (!o.b || have(o.b[0]) >= o.b[1]);
      let k = offers.findIndex((o) => ok(o) && o.a[0] === window.__itemIds.ruby);
      if (k < 0) k = offers.findIndex(ok);
      if (g.win && g.win.kind === "trade" && k >= 0) g.net.send({ t: "trade", w: g.win.w, o: k, all: false });
    });
    await sleep(900);
    await shot("trade-0.png");
    await P.g(() => window.__game.closeInventory());
    await guiScale(4);
    await P.cmd("/gamemode creative");
  }

  // ---------------------------------------------------------------- 5. boats between the islands at sunset
  if (want("boat")) {
    await P.g(() => window.__c.free());
    await P.cmd("/tp 476.5 41 440.5", 700);
    await P.cmd("/time 12720");
    await P.g(() => {
      window.__c.clean("none");
      window.__c.noMove = true;
    });
    const A = { x: 466.5, z: 428.5 };
    const B = { x: 470.5, z: 433.0 };
    const r1 = await boatBot(S.url, "SailorSteve_1803", A.x, A.z);
    const r2 = await boatBot(S.url, "LuckyOtter_6620", B.x, B.z);
    bots.push(r1.b, r2.b);
    const yaw = 140;
    await st.start();
    for (let f = 0; f < 45; f++) {
      const fx = -Math.sin((yaw * Math.PI) / 180) * 0.06 * f;
      const fz = Math.cos((yaw * Math.PI) / 180) * 0.06 * f;
      await st.step(async () => {
        if (f % 3 === 0) {
          r1.row(A.x + fx, A.z + fz, yaw);
          r2.row(B.x + fx * 0.97, B.z + fz * 0.97, yaw + 2);
        }
        await look([A.x + fx + 6.5, 41.3, A.z + fz + 5.2], [A.x + fx - 3, 40.5, A.z + fz - 1.5]);
      });
    }
    await shot("boat-0.png");
    await look([A.x + 4, 40.9, A.z + 6.5], [A.x - 6, 41.6, A.z - 4]);
    await st.run(3);
    await shot("boat-1.png");
    await st.stop();
    dropBots();
    await P.g(() => (window.__c.noMove = false));
  }

  // ---------------------------------------------------------------- 6. the crafting table, close up
  if (want("craft")) {
    await P.cmd("/gamemode survival");
    const tx = 237;
    const tz = 347;
    const ty = (await top(tx, tz)) + 1;
    const gy = (await top(tx, tz + 3)) + 1;
    await P.cmd(`/tp ${tx + 0.5} ${gy} ${tz + 2.6}`, 700);
    await P.cmd("/time 4000");
    await give(["crafting_table 1", "diamond 6", "stick 6", "oak_planks 20", "iron_ingot 9", "torch 12", "apple 5"]);
    await P.g(([x, y, z]) => {
      const g = window.__game;
      window.__c.hold(121);
      g.setLocal(x, y, z, 121);
      g.net.send({ t: "place", x, y, z, id: 121 });
      g.selectSlot(1);
    }, [tx, ty, tz]);
    await sleep(700);
    await look([tx + 0.5, gy + 1.62, tz + 2.6], [tx + 0.5, ty + 0.5, tz + 0.5]);
    await P.g(() => window.__c.clean("gui"));
    await guiScale(7);
    await P.g(([x, y, z]) => window.__game.net.send({ t: "use", x, y, z }), [tx, ty, tz]);
    await sleep(1200);
    await P.g(() => window.__game.windowClick({ m: "fill", r: "diamond_pickaxe", all: false }));
    await sleep(1200);
    await shot("craft-0.png");
    await P.g(() => window.__game.closeInventory());
  }

  console.log("page errors:", JSON.stringify(P.errors.slice(0, 5)));
} catch (e) {
  console.error(e);
  console.error(S.log().slice(-1500));
  code = 1;
} finally {
  dropBots();
  await browser.close();
  S.proc.kill();
}
process.exit(code);
