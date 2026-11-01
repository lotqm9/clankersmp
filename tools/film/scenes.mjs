// The scenes of the switch's montage and stills, shared by film.mjs (1920x1080 at 60 fps) and stills.mjs (2400x1350).
// Each scene: setup() (live clock: teleports, items, bots), then frames of drive(f) on the stepped clock.
import { boatBot, bot, holdKey, outfit, sleep } from "./director.mjs";

export const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
export const lerp = (a, b, t) => a + (b - a) * t;
const L3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** Ids we need (blocks; items are by key with /give). */
export const ID = { AIR: 0, OAK_LOG: 5, TORCH: 23, CRAFTING_TABLE: 121, DIAMOND_ORE: 111, RUBY_ORE: 112, WATER: 11 };

export function makeScenes(P, S, info) {
  const sh = info.sh;
  const look = (e, t) => P.g(([e, t]) => window.__c.look(e[0], e[1], e[2], t[0], t[1], t[2]), [e, t]);
  const setMouse = (m) => P.g((m) => (window.__game.mouse = m), m);
  const at = (x, y, z) => P.g(([x, y, z]) => window.__c.at(x, y, z), [x, y, z]);
  const top = (x, z) => P.g(([x, z]) => window.__c.top(x, z), [x, z]);
  const give = async (list) => {
    for (const g of list) await P.cmd(`/give ${g}`, 120);
    await sleep(500);
  };
  /** Put an item (by key) in hand: from the hotbar, or swapped onto hotbar slot `slot`. */
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
  const bots = [];
  const mkBot = async (name) => {
    const b = await bot(S.url, name);
    bots.push(b);
    return b;
  };
  const yawTo = (fx, fz, tx, tz) => (Math.atan2(-(tx - fx), tz - fz) * 180) / Math.PI;
  const guiScale = (v) => P.g((v) => document.documentElement.style.setProperty("--s", `${v}px`), v);
  /** Bots are moved by the director each frame: pose = { x, y, z, yaw, pitch, flags }. */
  const pose = (b, p) => b.move(p.x, p.y, p.z, p.yaw ?? 0, p.pitch ?? 0, p.flags ?? 4);
  const clearBots = () => {
    for (const b of bots.splice(0)) b.close();
  };

  return {
    bots,
    clearBots,
    // ---------------------------------------------------------------- A. punch a tree
    tree: {
      frames: 250,
      T: { x: 240, y: 51, z: 342 },
      async setup() {
        const T = this.T;
        this.eye = [T.x + 0.5 + 0.7, T.y + 1.62, T.z + 0.5 + 2.75];
        await P.cmd(`/tp ${this.eye[0]} ${T.y} ${this.eye[2]}`, 600);
        await P.cmd("/gamemode survival");
        await P.cmd("/time 1500");
        await P.g(() => window.__game.selectSlot(1)); // an empty hand: the fist
        await P.g(() => window.__c.clean("hand"));
        await look(this.eye, [T.x + 0.5, T.y + 1.5, T.z + 0.5]);
        this.broke = -1;
      },
      async drive(f) {
        const T = this.T;
        const t = f / this.frames;
        const e = [this.eye[0] - 0.25 * ease(t), this.eye[1], this.eye[2] - 0.45 * ease(Math.min(1, f / 170))];
        const aimY = this.broke < 0 ? T.y + 1.5 : lerp(T.y + 1.5, T.y + 0.6, ease((f - this.broke) / 45));
        await look(e, [T.x + 0.5, aimY, T.z + 0.6]);
        if (f === 8) await setMouse(1);
        if (this.broke < 0 && f > 20 && (await at(T.x, T.y + 1, T.z)) === ID.AIR) {
          this.broke = f;
          await setMouse(0);
        }
      },
    },
    // ---------------------------------------------------------------- B. craft
    craft: {
      frames: 200,
      async setup() {
        // on the meadow a little south-west of the tree: the table on the ground, you 2.6 blocks south of it
        const tx = 237;
        const tz = 347;
        const T = { x: tx, y: (await top(tx, tz)) + 1, z: tz };
        this.T = T;
        const gy = (await top(tx, tz + 3)) + 1;
        this.eye = [T.x + 0.5, gy + 1.62, T.z + 2.6];
        await P.cmd(`/tp ${this.eye[0]} ${gy} ${this.eye[2]}`, 500);
        await give(["crafting_table 1", "oak_planks 12", "stick 6", "oak_log 3"]);
        await P.g(([x, y, z]) => {
          const g = window.__game;
          window.__c.hold(121);
          g.setLocal(x, y, z, 121);
          g.net.send({ t: "place", x, y, z, id: 121 });
          g.selectSlot(1);
        }, [T.x, T.y, T.z]);
        await sleep(600);
        await look(this.eye, [T.x + 0.5, T.y + 0.5, T.z + 0.5]);
        await P.g(() => window.__c.clean("hand"));
      },
      async drive(f) {
        const T = this.T;
        await look([this.eye[0], this.eye[1], this.eye[2] - 0.3 * ease(f / 30)], [T.x + 0.5, T.y + 0.5, T.z + 0.5]);
        if (f === 24) await P.g(([x, y, z]) => { window.__game.hand.startSwing(); window.__game.net.send({ t: "use", x, y, z }); }, [T.x, T.y, T.z]);
        if (f === 34) {
          await P.g(() => window.__c.clean("gui"));
          await guiScale(6);
        }
        if (f === 70) await P.g(() => window.__game.windowClick({ m: "fill", r: "wooden_pickaxe", all: false }));
        if (f === 135) await P.g(() => window.__game.windowClick({ m: "shift", s: 0 }));
      },
      async after() {
        await P.g(() => window.__game.closeInventory());
        await P.g(() => window.__game.ui.setGuiScale());
      },
    },
    // ---------------------------------------------------------------- C. mine (a cave with ruby and diamond)
    mine: {
      frames: 230,
      C: { x: 116, y: 12, z: 426 },
      async setup() {
        const C = this.C;
        await P.cmd(`/tp ${C.x + 0.5} ${C.y} ${C.z + 0.5}`, 800);
        await P.cmd("/time 6000");
        await give(["iron_pickaxe 1", "torch 16"]);
        await P.meshed();
        await sleep(800);
        // the ores in reach with a clear line from the eye, nearest first; and torch spots on the floor near them
        const r = await P.g(([cx, cy, cz]) => {
          const c = window.__c;
          const ex = cx + 0.5, ey = cy + 1.62, ez = cz + 0.5;
          const ores = [];
          for (let dy = -3; dy <= 5; dy++)
            for (let dz = -6; dz <= 6; dz++)
              for (let dx = -6; dx <= 6; dx++) {
                const x = cx + dx, y = cy + dy, z = cz + dz;
                const id = c.at(x, y, z);
                if (id !== 111 && id !== 112) continue;
                const d = Math.hypot(x + 0.5 - ex, y + 0.5 - ey, z + 0.5 - ez);
                const n = Math.ceil(d * 4);
                let clear = true;
                for (let k = 1; k < n - 2; k++) {
                  const f = k / n;
                  const b = c.at(Math.floor(ex + (x + 0.5 - ex) * f), Math.floor(ey + (y + 0.5 - ey) * f), Math.floor(ez + (z + 0.5 - ez) * f));
                  if (b !== 0 && b !== 23) { clear = false; break; }
                }
                if (clear) ores.push({ x, y, z, id, d });
              }
          ores.sort((a, b) => a.d - b.d);
          return ores;
        }, [C.x, C.y, C.z]);
        this.dia = r.find((o) => o.id === ID.DIAMOND_ORE && o.d < 4.3);
        this.ruby = r.find((o) => o.id === ID.RUBY_ORE && o.d < 4.3);
        console.log("cave ores in reach:", JSON.stringify(r.slice(0, 8)), "dia", JSON.stringify(this.dia), "ruby", JSON.stringify(this.ruby));
        // torches on the floor around (air with solid ground below), a few blocks out
        const spots = await P.g(([cx, cy, cz]) => {
          const c = window.__c;
          const out = [];
          for (const [dx, dz] of [[2, -2], [-2, 2], [3, 1], [-3, -1], [1, 3], [-1, -3], [4, -1], [-4, 1], [2, 3], [-2, -3]]) {
            for (let dy = -2; dy <= 2; dy++) {
              const x = cx + dx, y = cy + dy, z = cz + dz;
              const below = c.at(x, y - 1, z);
              if (c.at(x, y, z) === 0 && below !== 0 && below !== 11 && below !== 23 && !(below >= 111 && below <= 112)) { out.push([x, y, z]); break; }
            }
          }
          return out;
        }, [C.x, C.y, C.z]);
        for (const [x, y, z] of spots.slice(0, 4))
          await P.g(([x, y, z]) => {
            const g = window.__game;
            window.__c.hold(23);
            g.setLocal(x, y, z, 23);
            g.net.send({ t: "place", x, y, z, id: 23 });
          }, [x, y, z]);
        await sleep(500);
        await hold("iron_pickaxe", 2);
        await P.g(() => {
          const g = window.__game;
          g.settings.brightness = 1;
          g.applySettings(g.settings);
        });
        await P.g(() => window.__c.clean("hand"));
        await P.meshed();
        this.eye = [C.x + 0.5, C.y + 1.62, C.z + 0.5];
        const first = this.ruby ?? this.dia;
        await look(this.eye, [first.x + 0.5, first.y + 0.5, first.z + 0.5]);
        this.phase = 0;
        this.brokeAt = -1;
      },
      async drive(f) {
        const a = this.ruby;
        const b = this.dia;
        const ta = a ? [a.x + 0.5, a.y + 0.5, a.z + 0.5] : null;
        const tb = b ? [b.x + 0.5, b.y + 0.5, b.z + 0.5] : null;
        // look at the ruby, then turn to the diamond and mine it; then the ruby
        let aim;
        if (f < 40) aim = ta ?? tb;
        else if (f < 75) aim = ta && tb ? L3(ta, tb, ease((f - 40) / 35)) : tb ?? ta;
        else if (this.phase < 2) aim = tb ?? ta;
        else aim = ta && tb ? L3(tb, ta, ease((f - this.brokeAt - 20) / 30)) : ta ?? tb;
        await look(this.eye, aim);
        if (f === 76 && b) await setMouse(1);
        if (this.phase === 0 && b && f > 76 && (await at(b.x, b.y, b.z)) === ID.AIR) {
          this.phase = 2;
          this.brokeAt = f;
          await setMouse(0);
        }
        if (this.phase === 2 && a && f === this.brokeAt + 55) await setMouse(1);
        if (this.phase === 2 && a && f > this.brokeAt + 55 && (await at(a.x, a.y, a.z)) === ID.AIR) {
          this.phase = 3;
          await setMouse(0);
        }
      },
    },
    // ---------------------------------------------------------------- D. night: a Shambler on the lantern-lit road
    night: {
      frames: 230,
      async setup() {
        // out east along the road to Larkholm, past the ring, at night; a friend in iron armour beside you
        const s = await P.g(() => {
          const g = window.__game;
          const c = window.__c;
          const h = g.info.hub;
          // a lantern post on the road east: a lantern over two fences
          for (let x = 340; x < 410; x++)
            for (let z = 270; z < 340; z++) {
              const t = c.top(x, z);
              if (c.at(x, t, z) === 175 && c.at(x, t - 1, z) === 91 && c.at(x, t - 2, z) === 91) return { x, y: t - 2, z };
            }
          void h;
          return null;
        });
        console.log("night lantern post", JSON.stringify(s));
        this.L = s;
        // stand 3 blocks from the post, on the road
        const ground = async (x, z) => (await top(x, z)) + 1;
        this.me = [s.x + 2.5, await ground(s.x + 2, s.z + 2), s.z + 2.5];
        await P.cmd(`/tp ${this.me[0]} ${this.me[1]} ${this.me[2]}`, 600);
        await P.cmd("/time 18000");
        await P.cmd("/mobs off");
        await P.cmd("/mobs clear");
        await give(["diamond_sword 1", "iron_helmet 1"]);
        await hold("diamond_sword", 3);
        await P.g(() => {
          const g = window.__game;
          g.settings.brightness = 0.85;
          g.applySettings(g.settings);
        });
        const friend = await mkBot("IronSword_2497");
        await outfit(friend, { armour: 1, give: ["iron_sword 1"] });
        friend.chat(`/tp ${s.x + 0.5} ${this.me[1]} ${s.z + 3.5}`);
        await holdKey(friend, "iron_sword");
        this.friend = friend;
        this.fpos = { x: s.x + 0.5, y: this.me[1], z: s.z + 3.5 };
        await P.g(() => window.__c.clean("hand"));
        await sleep(800);
        // the Shambler comes up the road from the east; a Skitter further back
        this.eye = [this.me[0], this.me[1] + 1.62, this.me[2]];
        await look(this.eye, [this.me[0] + 6, this.me[1] + 1.2, this.me[2] + 1]);
        await P.cmd("/summon shambler 1 9");
        await P.cmd("/summon skitter 1 11");
        this.hits = 0;
      },
      async drive(f) {
        const g = await P.g(() => {
          const g = window.__game;
          const ms = [...g.mobs.values()].map((m) => ({ x: m.x, y: m.y, z: m.z, kind: m.kind, dead: !!(m.flags & 64) }));
          return ms;
        });
        const sham = g.find((m) => m.kind === 0 && !m.dead) ?? g[0];
        // a steady look down the road, drawn a little towards the Shambler; you give ground as it comes
        const base = [this.me[0] + 6, this.me[1] + 1.0, this.me[2] + 1.5];
        const mt = sham ? [sham.x, sham.y + 1.1, sham.z] : base;
        const tgt = L3(base, mt, 0.85);
        this.eye = [this.me[0] - 0.02 * f, this.me[1] + 1.62, this.me[2] + 0.006 * f];
        await look(this.eye, tgt);
        pose(this.friend, { ...this.fpos, yaw: yawTo(this.fpos.x, this.fpos.z, tgt[0], tgt[2]), pitch: 5 });
        const d = sham ? Math.hypot(sham.x - this.eye[0], sham.z - this.eye[2]) : 99;
        // swing when it's in reach, with the cooldown charged (every 14 frames is plenty for a diamond sword: 0.625 s)
        // in reach with the swing charged (0.625 s for a diamond sword): hit it (the server judges reach and damage)
        if (sham && d < 3.0 && f - (this.lastHit ?? -99) > 38) {
          await P.g(() => {
            const g = window.__game;
            const m = [...g.mobs.values()].find((q) => q.kind === 0 && !(q.flags & 64));
            if (m) g.hitMob(m);
          });
          this.lastHit = f;
        }
        if (f % 9 === 0 && d < 6) this.friend.swing();
      },
      async after() {
        await setMouse(0);
      },
    },
    // ---------------------------------------------------------------- E. village: a glide down Larkholm's street
    village: {
      frames: 170,
      async setup() {
        const v = info.villages.find((q) => q.name === "Larkholm") ?? info.villages[0];
        this.v = v;
        await P.cmd(`/tp ${v.x + 0.5} ${v.y + 1} ${v.z + 0.5}`, 800);
        await P.cmd("/time 2500");
        await P.g(() => window.__c.clean("none"));
        await P.g(() => (window.__c.noMove = true));
        await P.meshed();
        await sleep(1500);
        const vs = await P.g(() => [...window.__game.villagers.values()].map((q) => ({ x: q.x, y: q.y, z: q.z })));
        console.log("villagers near", vs.length);
        this.path = [[v.x - 13, v.y + 5.5, v.z + 13], [v.x - 6, v.y + 4.2, v.z + 7]];
        this.aim = [[v.x + 1, v.y + 1, v.z - 1], [v.x + 6, v.y + 1.5, v.z - 6]];
      },
      async drive(f) {
        const t = ease(f / this.frames);
        await look(L3(this.path[0], this.path[1], t), L3(this.aim[0], this.aim[1], t));
      },
      async after() {
        await P.g(() => (window.__c.noMove = false));
      },
    },
    // ---------------------------------------------------------------- F. trade: rubies for an iron sword at the smith
    trade: {
      frames: 150,
      async setup() {
        const v = info.villages.find((q) => q.name === "Larkholm") ?? info.villages[0];
        await give(["ruby 24", "wheat 12"]);
        // the nearest villager to the plaza; stand 2.6 blocks from it, facing it
        const q = await P.g(([vx, vz]) => {
          const list = [...window.__game.villagers.values()].map((q) => ({ id: q.id, x: q.x, y: q.y, z: q.z, job: q.job ?? q.kind }));
          list.sort((a, b) => Math.hypot(a.x - vx, a.z - vz) - Math.hypot(b.x - vx, b.z - vz));
          return list[0];
        }, [v.x, v.z]);
        console.log("trader", JSON.stringify(q));
        this.q = q;
        const me = [q.x + 2.2, q.y, q.z + 1.2];
        await P.cmd(`/tp ${me[0]} ${me[1]} ${me[2]}`, 600);
        this.eye = [me[0], me[1] + 1.62, me[2]];
        await look(this.eye, [q.x, q.y + 1.5, q.z]);
        await hold("ruby", 6);
        await P.g(() => window.__c.clean("hand"));
      },
      async drive(f) {
        const q = await P.g((id) => {
          const v = window.__game.villagers.get(id);
          return v ? { x: v.x, y: v.y, z: v.z } : null;
        }, this.q.id);
        // look past the villager's shoulder so it stands beside the window
        if (q) {
          const side = [q.x - (this.eye[2] - q.z) * 0.55, q.y + 1.4, q.z + (this.eye[0] - q.x) * 0.55];
          await look(this.eye, L3([q.x, q.y + 1.5, q.z], side, ease((f - 10) / 25)));
        }
        if (f === 18) await P.g((id) => { const g = window.__game; const v = g.villagers.get(id); if (v) g.talkTo(v); }, this.q.id);
        if (f === 26) {
          await P.g(() => window.__c.clean("gui"));
          await guiScale(5);
        }
        if (f === 80)
          this.traded = await P.g(() => {
            const g = window.__game;
            // a ruby trade we can afford (rubies for goods), else anything we can afford
            const offers = g.invUI.offers || [];
            const have = (id) => g.inv.inv.reduce((n, s) => n + (s && s.id === id ? s.n : 0), 0);
            const ok = (o) => o.n > 0 && have(o.a[0]) >= o.a[1] && (!o.b || have(o.b[0]) >= o.b[1]);
            let k = offers.findIndex((o) => ok(o) && o.a[0] === window.__itemIds.ruby);
            if (k < 0) k = offers.findIndex(ok);
            if (g.win && g.win.kind === "trade" && k >= 0) g.net.send({ t: "trade", w: g.win.w, o: k, all: false });
            return { k, offers: offers.length };
          });
      },
      async after() {
        await P.g(() => window.__game.closeInventory());
        await P.g(() => window.__game.ui.setGuiScale());
      },
    },
    // ---------------------------------------------------------------- G. boats at sunset, between the islands
    boat: {
      frames: 220,
      async setup() {
        // open water between Bluebell Isle (south) and Gull Rock (north-east), heading north-west into the sunset
        this.A = { x: 470.5, z: 432.5 };
        this.B = { x: 474.5, z: 436.5 };
        this.yaw = 140;
        await P.cmd(`/tp ${this.A.x + 6} 41 ${this.A.z + 8}`, 600);
        await P.cmd("/time 12700");
        await P.g(() => window.__c.clean("none"));
        await P.g(() => (window.__c.noMove = true));
        this.r1 = await boatBot(S.url, "SailorSteve_1803", this.A.x, this.A.z);
        this.r2 = await boatBot(S.url, "LuckyOtter_6620", this.B.x, this.B.z);
        bots.push(this.r1.b, this.r2.b);
        await sleep(800);
      },
      async drive(f) {
        const sp = 3.6 / 60; // blocks a frame
        const fx = -Math.sin((this.yaw * Math.PI) / 180);
        const fz = Math.cos((this.yaw * Math.PI) / 180);
        const a = [this.A.x + fx * sp * f, this.A.z + fz * sp * f];
        const b = [this.B.x + fx * sp * f * 0.97, this.B.z + fz * sp * f * 0.97];
        if (f % 3 === 0) {
          this.r1.row(a[0], a[1], this.yaw);
          this.r2.row(b[0], b[1], this.yaw + 3 * Math.sin(f / 40));
        }
        // the camera low over the water, beside and a little behind them, drifting forward with them
        const t = ease(f / this.frames);
        const e = [a[0] + 7.5 - 2 * t, 41.4 + 0.6 * t, a[1] + 4.5 + 1.5 * t];
        await look(e, [a[0] - 3 + fx * 2, 40.6, a[1] + fz * 2]);
      },
      async after() {
        await P.g(() => (window.__c.noMove = false));
      },
    },
    // ---------------------------------------------------------------- H. the spawn hub at sunset: players at the landmark
    hub: {
      frames: 270,
      async setup() {
        await P.cmd(`/tp 285.5 ${sh + 1} 246.5`, 600);
        await P.cmd("/time 12650");
        await P.g(() => window.__c.clean("none"));
        await P.g(() => (window.__c.noMove = true));
        this.crew = [];
        const crew = [
          { n: "DiamondMiner_7168", x: 277.5, z: 244.5, look: [254, sh + 26, 250], give: "iron_pickaxe", swing: true },
          { n: "LuckySteve_4410", x: 274.5, z: 247.5, look: [255, sh + 24, 251] },
          { n: "BlockyBuilder_2203", x: 272.5, z: 242.5, look: [253, sh + 22, 251], armour: 2, give: "diamond_sword" },
          { n: "EpicCrafter_9051", x: 270.5, z: 249.5, look: [258, sh + 20, 254] },
          { n: "PixelQueen_3317", x: 281.5, z: 251.5, look: [262, sh + 12, 256], armour: 1, walk: [281.5, 251.5, 276.5, 251.5] },
        ];
        for (const c of crew) {
          const b = await mkBot(c.n);
          c.b = b;
          c.y = (await top(Math.floor(c.x), Math.floor(c.z))) + 1;
          b.chat(`/tp ${c.x} ${c.y} ${c.z}`);
          if (c.armour !== undefined || c.give) await outfit(b, { armour: c.armour ?? null, give: c.give ? [`${c.give} 1`] : [] });
          this.crew.push(c);
        }
        await sleep(900);
        for (const c of this.crew) {
          if (c.give) await holdKey(c.b, c.give);
          else c.b.select(5); // an empty hand
        }
      },
      async drive(f) {
        const t = ease(f / this.frames);
        // a crane: low behind the players, rising and pushing in towards the figure, the sunset behind it
        const e = L3([293, sh + 3.2, 244], [288, sh + 13, 241], t);
        const a = L3([254, sh + 15, 255], [252, sh + 21, 255], t);
        await look(e, a);
        for (const c of this.crew) {
          let x = c.x;
          let z = c.z;
          if (c.walk) {
            const u = Math.min(1, f / 220);
            x = lerp(c.walk[0], c.walk[2], u);
            z = lerp(c.walk[1], c.walk[3], u);
          }
          const yaw = yawTo(x, z, c.look[0], c.look[2]);
          const pitch = -Math.atan2(c.look[1] - (c.y + 1.62), Math.hypot(c.look[0] - x, c.look[2] - z)) * 57.3;
          if (f % 2 === 0) pose(c.b, { x, y: c.y, z, yaw, pitch, flags: 4 });
          if (c.swing && f % 36 === 0) c.b.swing();
        }
      },
      async after() {
        await P.g(() => (window.__c.noMove = false));
      },
    },
  };
}
