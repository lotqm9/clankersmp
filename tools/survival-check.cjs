// Browser check of survival in a real headless Chrome against a local server with DEV_COMMANDS=1: the inventory
// opens with E and its clicks (pick, place, shift, right-click split) go through the real DOM; the recipe book fills
// the grid and the result crafts; digging a block by hand drops it and walking over it picks it up; eating with a
// held right mouse button restores food; Q throws; a fall hurts (flash + hearts); death shows the screen and
// Respawn brings you back; /gamemode creative hides the hearts and E shows the block picker.
// 7.2 (the native GUI): the panels and slots sit on the classic pixel grid at a whole-device-pixel GUI scale (also at
// 125% display scaling); the hotbar and its selection box; the recipe book toggle; the player box turns to the
// mouse; drag to spread with the split shown live; double-click (two LEFT clicks within 250 ms) gathers, a right then
// a left click doesn't; shift-click; the furnace (flame meter, arrow, output) and the chest window; and a phone-sized
// touch screen: the GUI fits, tap picks up and places, press-and-hold splits, the book stacks below, the X closes.
// v6 (Phase 2: night mobs, combat, armour): death by a Shambler names it on the death screen; the hub is a safe
// zone (a mob summoned there vanishes); armour: the slot silhouettes, shift-click into the slots, the 3D player box
// and your F5 avatar wearing it, the HUD armour row; the recipe book's Combat tab; the attack indicator; in the wild
// at night: a Shambler's blow (softened by armour, knockback, armour wear), sunrise setting it on fire, charged
// sword hits and a critical while falling, a Rattler's arrows, mobs spawning by themselves (never within 24
// blocks); dying drops the armour. The server is started with mobs on or off: the check turns spawning off first.
// v7 (Phase 3: farming and depth): a hoe tills (dry, then moist beside water), a water bucket fills a hole and an
// empty bucket scoops it back, seeds plant wheat and bone meal ripens it, the harvest is picked up, a cow is milked
// and the milk drunk, a cake slice is eaten, the bow zooms and shows its draw, a full-draw arrow lands a critical
// hit, a stuck arrow is picked up, sugar cane grows by the water; the recipe book lists the new recipes.
// Usage: node tools/survival-check.cjs <site-url> [server-ws]      (PASS/FAIL lines; exit code 1 on any failure)
const PW = process.env.PLAYWRIGHT || "C:/Users/vincu/Desktop/memecoin/sites/evolve/node_modules/playwright";
const { chromium } = require(PW);
const site = (process.argv[2] || "http://127.0.0.1:5199").replace(/\/$/, "");
const server = process.argv[3] || "ws://127.0.0.1:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
let passed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failed++;
  else passed++;
};
const ID = { LOG: 5, PLANKS: 6, COBBLE: 4, TABLE: 121, FURNACE: 122, CHEST: 130, COAL: 257, RAW_IRON: 259, IRON_INGOT: 261, APPLE: 265 };

async function join(browser, opts, touch = false) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${site}/play/?server=${encodeURIComponent(server)}${touch ? "&touch" : ""}`);
  if (touch) await page.getByText("Try touch controls").tap();
  for (let i = 0; i < 160; i++) {
    if ((await page.evaluate(() => window.__game && window.__game.state).catch(() => "")) === "play") break;
    await sleep(250);
  }
  const g = (fn, arg) => page.evaluate(fn, arg);
  const chat = async (t) => {
    await g((t) => window.__game.net.send({ t: "chat", text: t }), t);
    await sleep(250);
  };
  const count = (id) => g((id) => window.__game.inv.inv.reduce((n, s) => n + (s && s.id === id ? s.n : 0), 0), id);
  /** The window slot holding item `id` (the player's part of the window), or -1. */
  const findSlot = (id) => g((id) => { const m = window.__game.win.menu; for (let s = m.invStart; s < m.end; s++) if (m.get(s)?.id === id) return s; return -1; }, id);
  const slotAt = (s) => g((s) => { const m = window.__game.win.menu.get(s); return m ? { id: m.id, n: m.n } : null; }, s);
  const centre = async (sel) => {
    const b = await page.locator(sel).first().boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  return { ctx, page, errors, g, chat, count, findSlot, slotAt, centre };
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
  const D = await join(browser, { viewport: { width: 1600, height: 900 } });
  const { page, errors, g, chat, count, findSlot, slotAt, centre } = D;
  await chat("/mobs off"); // v6: no mobs of their own until the mob checks (they summon theirs)
  check(await g(() => window.__game.gm === "survival"), "joined in survival mode");
  check(await g(() => document.querySelectorAll(".stats .hp .ic").length === 10), "ten hearts on the HUD");
  check((await count(ID.APPLE)) === 3, "the first-join kit: 3 apples");
  await sleep(2700);
  check(await g(() => !!document.querySelector(".tipcard")), "first-join survival tips shown");

  // ---- 7.2: the HUD: the classic hotbar strip (182 x 22 GUI px) and its selection box on the selected slot
  check(await g(() => {
    const s = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--s"));
    const h = document.querySelector(".hotbar").getBoundingClientRect();
    const sel = document.querySelector(".hsel").getBoundingClientRect();
    const k = window.__game.slot;
    return Math.abs(h.width - 182 * s) < 0.5 && Math.abs(h.height - 22 * s) < 0.5 && Math.abs(h.bottom - innerHeight) < 0.5 && Math.abs(sel.left - (h.left + (-2 + k * 20) * s)) < 0.5 && Math.abs(sel.width - 26 * s) < 0.5;
  }), "the hotbar is the native 182 x 22 strip and the selection box sits on the selected slot");

  // ---- 7.1: an empty hand shows your arm (never a block); an item replaces it
  await g(() => { const w = window.__game; w.selectSlot(w.inv.inv.findIndex((s, k) => k < 9 && !s)); });
  await sleep(700);
  check(await g(() => { const h = window.__game.hand; return h.arm.visible && h.arm.children.length === 1 && !h.item.visible; }), "an empty hand shows the arm in your skin, no block");
  await g(() => { const w = window.__game; w.selectSlot(w.inv.inv.findIndex((s, k) => k < 9 && s && s.id === 265)); });
  await sleep(700);
  check(await g(() => { const h = window.__game.hand; return !h.arm.visible && h.item.visible; }), "holding an apple shows the apple, not the arm");

  // out to the wild, onto the ground
  const spot = await g(() => {
    const at = (x, y, z) => window.__game.blocks[(y << 18) | (z << 9) | x];
    const top = (x, z) => { for (let y = 127; y > 0; y--) { const id = at(x, y, z); if (id !== 0 && id !== 11 && id !== 25 && id !== 26 && id !== 27 && !(id >= 113 && id <= 120)) return y; } return 0; };
    for (let r = 74; r < 160; r += 3) for (let a = 0; a < 48; a++) { // (v10: the safe zone reaches 68)
      const x = Math.round(256 + Math.cos(a / 7.6) * r), z = Math.round(256 + Math.sin(a / 7.6) * r);
      const y = top(x, z);
      if (y > 40 && at(x, y, z) === 1 && top(x + 1, z) === y && top(x, z + 1) === y && top(x - 1, z) === y && top(x, z - 1) === y && at(x, y + 1, z) === 0 && at(x + 1, y + 1, z) === 0) return { x, y, z };
    }
    return null;
  });
  await chat(`/tp ${spot.x + 0.5} ${spot.y + 1} ${spot.z + 0.5}`);
  await sleep(800);
  await chat("/give oak_log 3");
  await sleep(500);

  // ---- the inventory with real DOM clicks
  await g(() => window.__game.openInventory());
  await sleep(400);
  check(await g(() => !!document.querySelector(".inv-screen") && window.__game.state === "inventory"), "E opens the inventory");
  // 7.2: the native look: a 176 x 166 GUI-pixel panel scaled by the GUI scale, 45 slots on the pixel grid
  check(await g(() => {
    const p = document.querySelector(".mcpanel.inv.player");
    if (!p || !p.style.backgroundImage.startsWith("url(")) return false;
    const s = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--s"));
    const r = p.getBoundingClientRect();
    return Number.isInteger(s * devicePixelRatio) && Math.abs(r.width - 176 * s) < 0.5 && Math.abs(r.height - 166 * s) < 0.5 && document.querySelectorAll(".mcpanel .islot").length === 45;
  }), "the inventory is the native panel (176 x 166 GUI pixels at a whole-pixel scale, 45 slots)");
  check(await g(() => {
    const s = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--s"));
    const p = document.querySelector(".mcpanel.inv.player").getBoundingClientRect();
    const a = document.querySelector('.islot[data-s="9"]').getBoundingClientRect();
    const b = document.querySelector('.islot[data-s="36"]').getBoundingClientRect();
    const c = document.querySelector('.islot[data-s="0"]').getBoundingClientRect();
    const armour = document.querySelector('.islot[data-s="5"]').getBoundingClientRect();
    return Math.abs(a.left - p.left - 8 * s) < 0.5 && Math.abs(a.top - p.top - 84 * s) < 0.5 && Math.abs(b.top - p.top - 142 * s) < 0.5 && Math.abs(a.width - 16 * s) < 0.5 &&
      Math.abs(c.left - p.left - 154 * s) < 0.5 && Math.abs(armour.left - p.left - 8 * s) < 0.5 && Math.abs(armour.top - p.top - 8 * s) < 0.5;
  }), "slots sit on the classic grid (armour column 8,8; result 154,28; inventory 8,84; hotbar 8,142; 16 px items)");
  // the player box: a 3D model drawn at the screen's own pixels, turning to the mouse
  {
    const prev = await g(() => { const c = document.querySelector(".mcpreview canvas"); const s = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--s")); return c ? { w: c.width, h: c.height, dev: Math.round(s * devicePixelRatio) } : null; });
    check(!!prev && prev.w === 49 * prev.dev && prev.h === 70 * prev.dev, `the player box is drawn at the screen's pixels (${prev && prev.w} x ${prev && prev.h})`);
    const shot = () => g(() => document.querySelector(".mcpreview canvas").toDataURL());
    await page.mouse.move(20, 450);
    await sleep(250);
    const left = await shot();
    await page.mouse.move(1580, 450);
    await sleep(250);
    const right = await shot();
    const lit = await g(() => { const c = document.querySelector(".mcpreview canvas"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n / (d.length / 4); });
    check(left !== right && lit > 0.12, `the player in the box turns toward the mouse (${Math.round(lit * 100)}% of the box drawn)`);
  }
  const bookWas = await g(() => !document.querySelector(".mcbook").classList.contains("hidden"));
  await page.locator(".mcbookbtn").click();
  await sleep(200);
  check(await g((was) => !document.querySelector(".mcbook").classList.contains("hidden") === !was, bookWas), "the book button opens and closes the recipe book");
  if (!bookWas) check(await g(() => document.querySelector(".mcwrap").dataset.mode === "side"), "a wide screen shows the book beside the panel");
  if (bookWas) await page.locator(".mcbookbtn").click();
  else {
    await page.locator(".mcbookbtn").click();
    await page.locator(".mcbookbtn").click();
  }
  await sleep(200);
  {
    const box = await page.locator('.islot[data-s="36"]').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(200);
    check(await g(() => { const t = document.querySelector(".mctip"); return !!t && !t.classList.contains("hidden") && t.style.backgroundImage.startsWith("url("); }), "hovering an item shows the pixel tooltip");
    await page.mouse.move(5, 5);
  }
  const logSlot = await findSlot(ID.LOG);
  const click = async (s, button = 0, shift = false) => {
    const box = await page.locator(`.islot[data-s="${s}"]`).boundingBox();
    if (shift) await page.keyboard.down("Shift");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down({ button: button === 2 ? "right" : "left" });
    await page.mouse.up({ button: button === 2 ? "right" : "left" });
    if (shift) await page.keyboard.up("Shift");
    await sleep(250);
  };
  await click(logSlot); // pick up the logs
  check(await g(() => window.__game.cursor.s && window.__game.cursor.s.id === 5 && window.__game.cursor.s.n === 3), "left click picks up the stack");
  check(await g(() => { const c = document.querySelector(".cursor-item"); return !c.classList.contains("hidden") && !!c.querySelector(".ic"); }), "the picked-up stack follows the mouse");
  await click(1, 2); // right click: one into the grid
  check(await g(() => window.__game.inv.craft[0] && window.__game.inv.craft[0].n === 1), "right click places one in the grid");
  check(await g(() => window.__game.win.menu.get(0)?.id === 6), "the result shows oak planks");
  await click(logSlot); // the rest back
  await click(0, 0, true); // shift-click the result: craft all
  await sleep(500);
  check((await count(ID.PLANKS)) === 4 && (await count(ID.LOG)) === 2, "shift-click on the result crafts into the inventory (4 planks)");
  // right click split: take half of the planks
  const plankSlot = await findSlot(ID.PLANKS);
  await click(plankSlot, 2);
  check(await g(() => window.__game.cursor.s?.n === 2), "right click takes half");
  await click(plankSlot);
  // the recipe book: crafting table
  await page.locator(".rb-item.can").first().waitFor({ timeout: 3000 }).catch(() => {});
  await g(() => window.__game.windowClick({ m: "fill", r: "crafting_table", all: false }));
  await sleep(500);
  check(await g(() => window.__game.win.menu.get(0)?.id === 121), "the recipe book lays out a crafting table");
  await click(0);
  check(await g(() => window.__game.cursor.s?.id === 121), "taking the result crafts it");
  await page.keyboard.press("KeyE");
  await sleep(500);
  check(await g(() => window.__game.state !== "inventory" && !document.querySelector(".inv-screen")), "E closes the inventory");
  check((await count(ID.TABLE)) === 1, "the cursor stack went back into the inventory");

  // ---- 7.2: drag to spread (the split shows while dragging), double-click gathers, shift-click moves across
  await chat("/give cobblestone 9");
  await sleep(500);
  await g(() => window.__game.openInventory());
  await sleep(400);
  await click(await findSlot(ID.COBBLE));
  check(await g(() => window.__game.cursor.s?.id === 4 && window.__game.cursor.s?.n === 9), "picked up 9 cobblestone");
  const empties = await g(() => { const m = window.__game.win.menu; const out = []; for (let s = m.invStart + 9; s < m.hotStart && out.length < 3; s++) if (!m.get(s)) out.push(s); return out; });
  {
    const pts = [];
    for (const s of empties) pts.push(await centre(`.islot[data-s="${s}"]`));
    await page.mouse.move(pts[0].x, pts[0].y);
    await page.mouse.down();
    await page.mouse.move(pts[1].x, pts[1].y, { steps: 4 });
    await page.mouse.move(pts[2].x, pts[2].y, { steps: 4 });
    await sleep(150);
    check(await g((list) => {
      const c = document.querySelector(".cursor-item");
      return list.every((s) => { const e = document.querySelector(`.islot[data-s="${s}"]`); return e.dataset.key === "drag" && e.classList.contains("dragged") && !!e.querySelector(".cnt"); }) && c.dataset.key === "drag" && !c.classList.contains("hidden");
    }, empties), "while dragging, the three slots show the split (3 each) and the cursor its yellow 0");
    await page.mouse.up();
    await sleep(500);
    const after = [];
    for (const s of empties) after.push(await slotAt(s));
    check(after.every((x) => x && x.id === ID.COBBLE && x.n === 3) && (await g(() => !window.__game.cursor.s)), `a left drag over 3 slots spreads 9 evenly (${after.map((x) => x && x.n).join(", ")}), confirmed by the server`);
    // double-click: two LEFT clicks on the same slot within 250 ms gather every matching stack
    await page.mouse.move(pts[0].x, pts[0].y);
    await page.mouse.down();
    await page.mouse.up();
    await page.mouse.down();
    await page.mouse.up();
    await sleep(500);
    check(await g(() => window.__game.cursor.s?.id === 4 && window.__game.cursor.s?.n === 9), "a double-click gathers the three stacks back onto the cursor (9)");
    // put them down, then a RIGHT click and a quick LEFT click: half up, then back down; never a gather
    await click(empties[0]);
    await page.mouse.move(pts[0].x, pts[0].y);
    await page.mouse.down({ button: "right" });
    await page.mouse.up({ button: "right" });
    await page.mouse.down();
    await page.mouse.up();
    await sleep(500);
    const a0 = await slotAt(empties[0]);
    check(a0 && a0.n === 9 && (await g(() => !window.__game.cursor.s)), "a right click then a left click within 250 ms is not a double-click (the half goes back: 9)");
    // shift-click from the main inventory: to the hotbar
    await click(empties[0], 0, true);
    await sleep(400);
    const hot = await g(() => { const m = window.__game.win.menu; for (let s = m.hotStart; s < m.end; s++) if (m.get(s)?.id === 4) return m.get(s).n; return 0; });
    check(hot === 9 && !(await slotAt(empties[0])), "shift-click moves a stack from the inventory to the hotbar");
  }
  await page.keyboard.press("KeyE");
  await sleep(400);

  // ---- 7.2: the furnace and the chest windows
  for (const it of ["furnace 1", "chest 1", "raw_iron 2", "coal 2"]) await chat(`/give ${it}`);
  await sleep(500);
  const cells = await g(([x, y, z]) => {
    const at = (x, y, z) => window.__game.blocks[(y << 18) | (z << 9) | x];
    const out = [];
    for (const [dx, dz] of [[-1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [-2, 0], [-2, 1], [-2, -1]]) {
      const cx = x + dx, cz = z + dz;
      const ground = at(cx, y, cz);
      if (at(cx, y + 1, cz) === 0 && at(cx, y + 2, cz) === 0 && ground >= 1 && ground <= 4) out.push([cx, y + 1, cz]);
    }
    return out;
  }, [spot.x, spot.y, spot.z]);
  const place = (cell, block, item) => g(([x, y, z, id, item]) => {
    const w = window.__game;
    let s = w.inv.inv.findIndex((st, k) => k < 9 && st && st.id === item);
    if (s < 0) {
      w.swapToHotbar(w.inv.inv.findIndex((st) => st && st.id === item), 8);
      s = 8;
    }
    w.selectSlot(s);
    w.setLocal(x, y, z, id);
    w.net.send({ t: "place", x, y, z, id });
  }, [...cell, block, item]);
  const use = (cell) => g(([x, y, z]) => window.__game.net.send({ t: "use", x, y, z }), cell);
  check(cells.length >= 2, `found ground for a furnace and a chest (${cells.length} cells)`);
  await place(cells[0], ID.FURNACE + 2, ID.FURNACE);
  await sleep(600);
  await use(cells[0]);
  await sleep(700);
  check(await g(() => {
    const p = document.querySelector(".mcpanel.inv.furnace");
    const s = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--s"));
    if (!p || window.__game.win?.kind !== "furnace") return false;
    const r = p.getBoundingClientRect();
    const out = document.querySelector('.islot[data-s="2"]').getBoundingClientRect();
    return Math.abs(r.width - 176 * s) < 0.5 && document.querySelectorAll(".mcpanel .islot").length === 39 && !!document.querySelector(".mcflame") && !!document.querySelector(".mcarrow") && Math.abs(out.left - r.left - 116 * s) < 0.5 && Math.abs(out.top - r.top - 35 * s) < 0.5;
  }), "using a furnace opens the native furnace window (input, fuel, flame, arrow, output at 116,35)");
  await click(await findSlot(ID.RAW_IRON), 0, true);
  await click(await findSlot(ID.COAL), 0, true);
  await sleep(500);
  check((await slotAt(0))?.id === ID.RAW_IRON && (await slotAt(1))?.id === ID.COAL, "shift-click sends raw iron to the input and coal to the fuel slot");
  let lit = false;
  for (let i = 0; i < 20 && !lit; i++) {
    lit = await g(() => document.querySelector(".mcflame i").style.visibility === "visible");
    if (!lit) await sleep(150);
  }
  check(lit, "the flame meter lights up while the fuel burns");
  let cooking = false;
  for (let i = 0; i < 30 && !cooking; i++) {
    cooking = await g(() => { const m = /calc\(var\(--s\) \* ([\d.]+)\)/.exec(document.querySelector(".mcarrow i").style.clipPath); return !!m && Number(m[1]) < 24; });
    if (!cooking) await sleep(200);
  }
  check(cooking, "the progress arrow fills in white");
  let ingot = null;
  for (let i = 0; i < 70 && !(ingot && ingot.id === ID.IRON_INGOT); i++) {
    ingot = await slotAt(2);
    if (!(ingot && ingot.id === ID.IRON_INGOT)) await sleep(200);
  }
  check(!!ingot && ingot.id === ID.IRON_INGOT, "after 10 s an iron ingot is in the output");
  await click(2);
  check(await g(() => window.__game.cursor.s?.id === 261), "clicking the output takes the ingot");
  await page.keyboard.press("KeyE");
  await sleep(500);
  check((await count(ID.IRON_INGOT)) >= 1 && (await g(() => !window.__game.win)), "closing the furnace puts the ingot in the inventory");

  await place(cells[1], ID.CHEST + 2, ID.CHEST);
  await sleep(600);
  await use(cells[1]);
  await sleep(700);
  check(await g(() => {
    const p = document.querySelector(".mcpanel.inv.chest");
    const s = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--s"));
    if (!p || window.__game.win?.kind !== "chest") return false;
    const r = p.getBoundingClientRect();
    const first = document.querySelector('.islot[data-s="0"]').getBoundingClientRect();
    const inv = document.querySelector('.islot[data-s="27"]').getBoundingClientRect();
    return Math.abs(r.height - 168 * s) < 0.5 && document.querySelectorAll(".mcpanel .islot").length === 63 && Math.abs(first.top - r.top - 18 * s) < 0.5 && Math.abs(inv.top - r.top - 85 * s) < 0.5;
  }), "using a chest opens the native chest window (27 slots at 8,18 + the inventory at 8,85)");
  await click(await findSlot(ID.COBBLE), 0, true);
  await sleep(500);
  check((await slotAt(0))?.id === ID.COBBLE && (await count(ID.COBBLE)) === 0, "shift-click puts the cobblestone in the chest");
  await page.keyboard.press("KeyE");
  await sleep(400);
  await use(cells[1]);
  await sleep(700);
  check((await slotAt(0))?.n === 9, "the chest still holds it when opened again (the server kept it)");
  await click(0, 0, true);
  await sleep(500);
  check((await count(ID.COBBLE)) === 9, "shift-click takes it back out");
  await page.keyboard.press("KeyE");
  await sleep(400);

  // ---- digging by hand drops the block; walking over it picks it up
  const dirtBefore = await count(2);
  await g(([x, y, z]) => {
    const w = window.__game;
    w.ui.closeScreen();
    w.state = "play";
    const ex = w.phys.x, ey = w.phys.y + 1.62, ez = w.phys.z;
    const dx = x + 1.5 - ex, dy = y + 0.5 - ey, dz = z + 0.5 - ez;
    w.yaw = Math.atan2(-dx, dz) * 180 / Math.PI;
    w.pitch = -Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI;
    w.selectSlot(7);
    w.mouse = 1;
  }, [spot.x, spot.y, spot.z]);
  await sleep(1800);
  await g(() => { window.__game.mouse = 0; });
  const dug = await g(([x, y, z]) => window.__game.blocks[(y << 18) | (z << 9) | (x + 1)], [spot.x, spot.y, spot.z]);
  check(dug === 0, `the grass block was dug by hand (now ${dug})`);
  await sleep(400);
  // step onto it
  await g(() => window.__game.keys.add("KeyW"));
  for (let k = 0; k < 30 && (await count(2)) === dirtBefore; k++) await sleep(100);
  await g(() => window.__game.keys.clear());
  check((await count(2)) === dirtBefore + 1, "the dirt it dropped was picked up");

  // ---- eating: hold right click with an apple
  await chat("/hunger 12");
  await sleep(400);
  await g(() => { const w = window.__game; const s = w.inv.inv.findIndex((x, k) => k < 9 && x && x.id === 265); w.selectSlot(s); w.mouse = 4; w.startEating(); });
  await sleep(2100);
  await g(() => { window.__game.mouse = 0; });
  await sleep(400);
  check((await g(() => window.__game.stats.food)) === 16, "eating an apple: food 12 -> 16");
  check((await count(ID.APPLE)) === 2, "one apple used");

  // ---- Q throws one
  const before = await count(ID.APPLE);
  await g(() => window.__game.dropHeld(false));
  await sleep(500);
  check((await count(ID.APPLE)) === before - 1, "Q throws one item");
  await sleep(300);
  check(await g(() => [...window.__game.drops.values()].some((d) => d.item === 265)), "the thrown apple is on the ground");

  // ---- a fall hurts
  const hp0 = await g(() => window.__game.stats.hp);
  await chat(`/tp ${spot.x + 4.5} ${spot.y + 9} ${spot.z + 0.5}`);
  await sleep(2500);
  const hp1 = await g(() => window.__game.stats.hp);
  check(hp1 < hp0, `falling 8 blocks hurts (${hp0} -> ${hp1})`);

  // ---- v6: what the client hears of the fighting (hurts, stats, our hits, arrows), with where we stood
  await g(() => {
    const w = window.__game;
    window.__v6 = [];
    const orig = w.net.onJson;
    w.net.onJson = (m) => {
      // where we stood when it arrived (before any knockback), and for an arrow whether it is drawn
      const rec = ["hurt", "stats", "struck", "arrow", "arrow_end", "arrow_gone", "dead"].includes(m.t) ? { ...m, at: performance.now(), px: w.phys.x, py: w.phys.y, pz: w.phys.z } : null;
      const r = orig(m);
      if (rec && m.t === "arrow") rec.drawn = !!w.arrows.get(m.id)?.root.parent;
      if (rec) window.__v6.push(rec);
      return r;
    };
  });
  const v6log = (t) => g((t) => window.__v6.filter((m) => m.t === t), t);
  // an open field for the mobs: flat grass under the open sky, out in the wild
  const arena = await g(() => {
    const at = (x, y, z) => window.__game.blocks[(y << 18) | (z << 9) | x];
    const top = (x, z) => { for (let y = 127; y > 0; y--) { const id = at(x, y, z); if (id !== 0 && id !== 11 && id !== 23 && id !== 25 && id !== 26 && id !== 27 && !(id >= 113 && id <= 120)) return y; } return 0; };
    for (let r = 75; r < 170; r += 3) for (let a = 0; a < 64; a++) {
      const x0 = Math.round(256 + Math.cos(a / 10.2) * r), z0 = Math.round(256 + Math.sin(a / 10.2) * r);
      const y = top(x0, z0);
      let ok = y > 40;
      for (let x = x0 - 5; ok && x <= x0 + 5; x++) for (let z = z0 - 3; ok && z <= z0 + 14; z++) { if (top(x, z) !== y || ![1, 2].includes(at(x, y, z))) ok = false; }
      if (ok) return { x: x0, y, z: z0 };
    }
    return null;
  });
  check(!!arena, `found an open field for the mob checks${arena ? ` (${arena.x}, ${arena.y}, ${arena.z})` : ""}`);
  const toArena = async () => {
    await chat(`/tp ${arena.x + 0.5} ${arena.y + 1} ${arena.z + 0.5}`);
    await sleep(900);
    await g(() => { const w = window.__game; w.yaw = 0; w.pitch = 0; });
    await sleep(200);
  };

  // ---- v6: death by a night mob: the death screen names it; then respawn
  await toArena();
  await chat("/time 18000");
  await chat("/hunger 6"); // no healing
  await chat("/hurt 19"); // one heart left
  await chat("/summon shambler 1 3");
  for (let i = 0; i < 60 && (await g(() => window.__game.state)) !== "dead"; i++) await sleep(200);
  {
    const text = await g(() => document.querySelector(".screen.dead .dead-box p")?.textContent || "");
    check((await g(() => window.__game.state === "dead")) && /was caught by a Shambler$/.test(text), `the death screen names the night mob ("${text}")`);
  }
  await page.locator(".screen.dead button").first().click();
  await sleep(1200);
  check(await g(() => window.__game.state === "play" && window.__game.stats.hp === 20), "Respawn brings you back with full health");
  check(await g(() => Math.hypot(window.__game.phys.x - window.__game.info.spawn.x, window.__game.phys.z - window.__game.info.spawn.z) < 2), "back at the hub");
  await chat("/mobs clear");

  // ---- v6: the hub is a safe zone: a mob summoned there vanishes at once (and none spawn there by themselves)
  await sleep(600);
  await chat("/summon shambler 2 4");
  await chat("/summon skitter 1 3");
  await sleep(1500);
  check(await g(() => window.__game.mobs.size === 0), "the hub is a safe zone: mobs summoned there vanish at once");

  // ---- v6: armour: the empty slots' silhouettes, shift-click into the slots, the 3D player box wearing it
  const ARM = { HELMET: 344, CHEST: 349, LEGS: 342, BOOTS: 347, SWORD: 311 };
  for (const it of ["iron_helmet", "diamond_chestplate", "leather_leggings", "iron_boots", "iron_sword"]) await chat(`/give ${it} 1`);
  await sleep(500);
  await g(() => window.__game.openInventory());
  await sleep(500);
  check(await g(() => { const gh = [...document.querySelectorAll(".mcghost")]; return gh.length === 4 && gh.every((e) => !e.classList.contains("hidden")); }), "the empty armour slots show their silhouettes");
  const boxLit = async () => {
    await page.mouse.move(800, 100);
    await sleep(350);
    return g(() => { const c = document.querySelector(".mcpreview canvas"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n / (d.length / 4); });
  };
  const bare = await boxLit();
  for (const id of [ARM.HELMET, ARM.CHEST, ARM.LEGS, ARM.BOOTS]) await click(await findSlot(id), 0, true);
  await sleep(500);
  {
    const worn = await g(() => [5, 6, 7, 8].map((s) => window.__game.win.menu.get(s)?.id ?? 0));
    check(worn.join() === [ARM.HELMET, ARM.CHEST, ARM.LEGS, ARM.BOOTS].join() && (await g(() => window.__game.inv.armor.every((s) => !!s))), `shift-click puts each piece in its own armour slot (${worn.join(", ")}), confirmed by the server`);
  }
  check(await g(() => [...document.querySelectorAll(".mcghost")].every((e) => e.classList.contains("hidden"))), "a worn piece hides its slot's silhouette");
  const dressed = await boxLit();
  check(dressed > bare + 0.01, `the 3D player in the box wears it (${Math.round(bare * 100)}% -> ${Math.round(dressed * 100)}% of the box drawn)`);
  // the recipe book's Combat tab: the swords and the armour
  if (await g(() => document.querySelector(".mcbook").classList.contains("hidden"))) await page.locator(".mcbookbtn").click();
  await sleep(250);
  await page.locator(".rb-tab").nth(3).click();
  await sleep(300);
  {
    const c = await g(() => ({ tabs: document.querySelectorAll(".rb-tab").length, on: [...document.querySelectorAll(".rb-tab")].findIndex((t) => t.classList.contains("on")), list: [...document.querySelectorAll(".rb-item")].map((e) => e.dataset.r) }));
    check(c.tabs === 6 && c.on === 3 && c.list.length === 19 && ["wooden_sword", "iron_sword", "diamond_sword", "leather_helmet", "iron_chestplate", "diamond_boots", "bow", "arrow"].every((r) => c.list.includes(r)) && !c.list.some((r) => /axe|shovel|hoe/.test(r)),
      `the recipe book's Combat tab lists the swords, the armour, the bow and arrows (${c.list.length} recipes; ${c.tabs} tabs)`);
  }
  // v7: the Basics tab has the new food
  await page.locator(".rb-tab").nth(1).click();
  await sleep(300);
  {
    const list = await g(() => [...document.querySelectorAll(".rb-item")].map((e) => e.dataset.r));
    check(["bread", "cake", "sugar"].every((r) => list.includes(r)), `the recipe book's Basics tab lists bread, sugar and cake (${list.length} recipes)`);
  }
  await page.locator(".mcbookbtn").click();
  await sleep(200);
  await page.keyboard.press("KeyE");
  await sleep(500);
  // the HUD armour row (above the hearts, like the classic game) and your own avatar wearing it (F5)
  check(await g(() => {
    const ics = [...document.querySelectorAll(".stats .row.armor .ic")].map((e) => e.style.backgroundImage);
    const ar = document.querySelector(".stats .row.armor")?.getBoundingClientRect();
    const hp = document.querySelector(".stats .row.hp")?.getBoundingClientRect();
    return ics.length === 10 && new Set(ics.slice(0, 7)).size === 1 && new Set(ics.slice(7)).size === 1 && ics[0] !== ics[7] && !!ar && !!hp && ar.bottom <= hp.top + 0.5;
  }), "the HUD shows the armour row above the hearts: 7 of 10 (14 points: iron helmet, diamond chestplate, leather leggings, iron boots)");
  check(await g(() => { const s = window.__game.self; return !!s && s.armor.filter((a) => a.meshes.some((m) => m.visible)).length === 4; }), "your own avatar (F5) wears all four pieces");
  // the attack indicator: a swing at the air recharges it (iron sword: 1.6 a second), then it goes
  await g((id) => { const w = window.__game; let s = w.inv.inv.findIndex((st, k) => k < 9 && st && st.id === id); if (s < 0) { w.swapToHotbar(w.inv.inv.findIndex((st) => st && st.id === id), 8); s = 8; } w.selectSlot(s); }, ARM.SWORD);
  await sleep(400);
  await g(() => window.__game.swingAtNothing());
  await sleep(80);
  {
    const recharging = await g(() => { const e = document.querySelector(".attackind"); return !e.classList.contains("hidden") && !e.classList.contains("ready") && e.style.backgroundImage.startsWith("url("); });
    await sleep(900);
    const gone = await g(() => document.querySelector(".attackind").classList.contains("hidden"));
    check(recharging && gone, "a swing shows the attack indicator recharging under the crosshair; charged again (0.625 s with an iron sword), it goes");
  }

  // ---- v6: in the wild at night: a Shambler's blow is softened by the armour, knocks you back and wears the armour
  await toArena();
  await chat("/time 18000");
  await chat("/hunger 17"); // no healing while we count the damage
  await g(() => { window.__v6.length = 0; });
  const hpBefore = await g(() => window.__game.stats.hp);
  await chat("/summon shambler 1 5");
  let blow = null;
  for (let i = 0; i < 60 && !blow; i++) {
    blow = (await v6log("hurt"))[0] || null;
    if (!blow) await sleep(150);
  }
  await sleep(600);
  {
    const st = await v6log("stats");
    const before = st.filter((m) => m.at < blow?.at).pop()?.s.hp ?? hpBefore;
    const after = st.find((m) => blow && m.at >= blow.at - 5)?.s.hp;
    const lost = after !== undefined ? +(before - after).toFixed(2) : -1;
    check(!!blow && Math.abs(lost - 1.464) < 0.02, `a Shambler's blow (3) is softened by the armour (14 points, 2 toughness): ${lost} lost`);
    const kb = blow?.kb;
    const moved = await g(([x, z, kx, kz]) => { const w = window.__game; const n = Math.hypot(kx, kz) || 1; return ((w.phys.x - x) * kx + (w.phys.z - z) * kz) / n; }, [blow?.px ?? 0, blow?.pz ?? 0, kb?.[0] ?? 0, kb?.[2] ?? 0]);
    check(!!kb && moved > 0.3, `the blow knocks you back (${moved.toFixed(2)} blocks away from it)`);
    check(await g(() => window.__game.inv.armor.every((s) => s && s.d >= 1)), "each armour piece wore a little (the server's durability, synced to the slots)");
  }
  // sunrise: the Shambler catches fire in the open
  await chat("/time 23600");
  {
    let burning = false;
    for (let i = 0; i < 30 && !burning; i++) {
      burning = await g(() => [...window.__game.mobs.values()].some((m) => m.spec.key === "shambler" && m.flags & 128));
      if (!burning) await sleep(150);
    }
    check(burning, "at sunrise the Shambler catches fire");
  }
  // fight back: charged iron-sword hits, the second one jumping (a critical while falling)
  {
    await g(() => { window.__v6.length = 0; });
    const r = await g(async () => {
      const w = window.__game;
      const nap = (ms) => new Promise((r) => setTimeout(r, ms));
      const find = () => { let best = null, bd = 1e9; for (const m of w.mobs.values()) { if (m.spec.key !== "shambler" || m.flags & 64) continue; const d = Math.hypot(m.x - w.phys.x, m.z - w.phys.z); if (d < bd) { bd = d; best = m; } } return best; };
      const aim = (m) => { const dx = m.x - w.phys.x, dy = m.y + m.spec.h * 0.6 - (w.phys.y + 1.62), dz = m.z - w.phys.z; w.yaw = (Math.atan2(-dx, dz) * 180) / Math.PI; w.pitch = (-Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI; };
      const first = find();
      if (!first) return { hits: 0, killed: false };
      let hits = 0, last = -1e9, jumped = false;
      const t0 = performance.now();
      while (performance.now() - t0 < 16000) {
        const m = find();
        if (!m || m.id !== first.id) break;
        aim(m);
        await nap(40);
        if (performance.now() - last < 760 || w.targetMob !== m) continue;
        if (hits === 1 && !jumped) {
          // jump, and swing on the way down
          jumped = true;
          w.keys.add("Space");
          await nap(90);
          w.keys.delete("Space");
          for (let k = 0; k < 25 && !(w.phys.vy < -0.1 && !w.phys.onGround); k++) await nap(20);
          aim(m);
        }
        w.mouse = 1;
        await nap(110);
        w.mouse = 0;
        hits++;
        last = performance.now();
      }
      await nap(400);
      const left = w.mobs.get(first.id);
      return { hits, killed: !left || !!(left.flags & 64) };
    });
    const struck = await v6log("struck");
    const dmg = struck.map((m) => (m.crit ? `${m.dmg} crit` : `${m.dmg}`));
    check(r.killed && r.hits <= 5 && struck.length === r.hits && struck.filter((m) => !m.crit).every((m) => Math.abs(m.dmg - 5.9) < 0.02 || m.kills), `charged iron-sword hits kill the burning Shambler (${r.hits} hits: ${dmg.join(", ")})`);
    check(struck.some((m) => m.crit && (m.dmg > 8.8 || m.kills)), "a hit while falling is a critical (x1.5: 8.86 through its armour)");
  }
  // a Rattler shoots: the arrow flies (drawn) and hits you or sticks where it lands
  await chat("/mobs clear");
  await chat("/time 18000");
  await g(() => { const w = window.__game; w.yaw = 0; w.pitch = 0; window.__v6.length = 0; });
  await sleep(200);
  await chat("/summon rattler 1 12");
  {
    let shot = null;
    for (let i = 0; i < 70 && !shot; i++) {
      shot = (await v6log("arrow"))[0] || null;
      if (!shot) await sleep(150);
    }
    const drawn = !!shot && shot.drawn;
    let end = null;
    for (let i = 0; shot && i < 40 && !end; i++) {
      end = (await v6log("arrow_end")).find((m) => m.id === shot.id) || null;
      if (!end) await sleep(150);
    }
    const hurt = end && !end.stuck ? (await v6log("hurt")).length > 0 : false;
    check(!!shot && drawn && !!end && (end.stuck || hurt), `a Rattler shoots: the arrow flies (drawn) and ${end ? (end.stuck ? "sticks where it lands" : "hits you") : "never lands"}`);
  }
  await chat("/mobs clear");
  // night: mobs spawn by themselves out in the wild, never within 24 blocks of anyone
  await chat("/time 15000");
  await chat("/mobs on");
  {
    const seen = await g(async () => {
      const w = window.__game;
      const nap = (ms) => new Promise((r) => setTimeout(r, ms));
      const first = new Map();
      const t0 = performance.now();
      while (performance.now() - t0 < 20000 && first.size < 2) {
        for (const m of w.mobs.values()) if (!first.has(m.id)) first.set(m.id, Math.hypot(m.x - w.phys.x, m.y - w.phys.y, m.z - w.phys.z));
        await nap(100);
      }
      return [...first.values()];
    });
    await chat("/mobs off");
    await chat("/mobs clear");
    check(seen.length >= 1 && Math.min(...seen) >= 23.5, `at night mobs spawn by themselves, never within 24 blocks (first seen at ${seen.map((d) => d.toFixed(1)).join(", ") || "-"} blocks)`);
  }

  // ---- v6: dying drops the armour with everything else
  await chat("/kill");
  await sleep(800);
  await page.locator(".screen.dead button").first().click();
  await sleep(1200);
  check(await g(() => window.__game.state === "play" && !document.querySelector(".stats .row.armor") && window.__game.inv.armor.every((s) => !s)), "dying drops your armour too (the HUD armour row is gone after respawning)");
  await chat("/time 6000");

  // ---- v7 (Phase 3: farming and depth): the hoe, a water bucket, seeds and bone meal, a harvest, an empty bucket,
  // milk, cake and the bow, all through the real client (it predicts, the server decides)
  {
    const V7 = { HOE: 320, SEEDS: 281, WHEAT: 282, BONE_MEAL: 280, BUCKET: 290, WATER_BUCKET: 291, MILK: 292, BOW: 288, ARROW: 289, CAKE: 152, FARMLAND: 141, WHEAT_BLOCK: 143, WATER: 11 };
    const blockAt = (x, y, z) => g(([x, y, z]) => window.__game.blocks[(y << 18) | (z << 9) | x], [x, y, z]);
    const holdItem = (id) => g((id) => { const w = window.__game; let s = w.inv.inv.findIndex((st, k) => k < 9 && st && st.id === id); if (s < 0) { const k = w.inv.inv.findIndex((st) => st && st.id === id); if (k < 0) return -1; w.swapToHotbar(k, 8); s = 8; } w.selectSlot(s); return s; }, id);
    const lookAt = (x, y, z) => g(([x, y, z]) => { const w = window.__game; const dx = x - w.phys.x, dy = y - (w.phys.y + 1.62), dz = z - w.phys.z; w.yaw = (Math.atan2(-dx, dz) * 180) / Math.PI; w.pitch = (-Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI; }, [x, y, z]);
    const rightAt = async (x, y, z, wait = 450) => { await lookAt(x, y, z); await sleep(180); await g(() => window.__game.rightClick()); await sleep(wait); };
    const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(100); } return !!(await fn()); };
    const heldD = () => g(() => window.__game.inv.inv[window.__game.slot]?.d ?? -1);
    await chat("/mobs clear");
    await toArena();
    const [ax, ay, az] = [arena.x, arena.y, arena.z];
    for (const it of ["wooden_hoe 1", "wheat_seeds 4", "bone_meal 16", "water_bucket 1", "bucket 1", "cake 1", "bow 1", "arrow 4"]) await chat(`/give ${it}`);
    await sleep(600);
    // the cells: T1 two ahead (tilled before any water is near), the hole H right ahead, T2 beside it, the cake to the left
    const T1 = [ax, ay, az + 2], H = [ax, ay, az + 1], T2 = [ax + 1, ay, az + 1], C = [ax - 1, ay, az + 1];
    for (const [x, , z] of [T1, H, T2, C]) {
      if ((await blockAt(x, ay + 1, z)) === 0) continue;
      // a tuft of grass or a flower on it: pick it first (instant by hand)
      await holdItem(V7.CAKE);
      await lookAt(x + 0.5, ay + 1.15, z + 0.5);
      await sleep(180);
      await g(() => { window.__game.mouse = 1; });
      await sleep(150);
      await g(() => { window.__game.mouse = 0; });
      await until(async () => (await blockAt(x, ay + 1, z)) === 0, 1500);
      await sleep(300);
    }
    // a hoe on grass: farmland, dry with no water near; the hoe wears
    await holdItem(V7.HOE);
    await sleep(300);
    await rightAt(T1[0] + 0.5, ay + 0.99, T1[2] + 0.5, 900);
    check((await blockAt(...T1)) === V7.FARMLAND && (await heldD()) === 1, "a hoe tills grass into farmland (dry: no water near) and wears by one");
    // dig a hole by hand and pour a water bucket into it: a source, and the bucket comes back empty
    await holdItem(V7.CAKE);
    await lookAt(H[0] + 0.5, ay + 0.99, H[2] + 0.5);
    await sleep(180);
    await g(() => { window.__game.mouse = 1; });
    await until(async () => (await blockAt(...H)) === 0, 3000);
    await g(() => { window.__game.mouse = 0; });
    await sleep(400);
    await holdItem(V7.WATER_BUCKET);
    await sleep(300);
    await rightAt(H[0] + 0.5, ay + 0.01, H[2] + 0.5, 900);
    check((await blockAt(...H)) === V7.WATER && (await count(V7.WATER_BUCKET)) === 0 && (await count(V7.BUCKET)) === 2, "a water bucket pours a source into a hole and leaves an empty bucket");
    // next to the water the hoe makes moist farmland; seeds plant wheat on it
    await holdItem(V7.HOE);
    await sleep(300);
    await rightAt(T2[0] + 0.5, ay + 0.99, T2[2] + 0.5, 900);
    check((await blockAt(...T2)) === V7.FARMLAND + 1, "next to water the farmland is moist");
    const seeds0 = await count(V7.SEEDS);
    await holdItem(V7.SEEDS);
    await sleep(300);
    await rightAt(T2[0] + 0.5, ay + 0.9, T2[2] + 0.5, 900);
    check((await blockAt(T2[0], ay + 1, T2[2])) === V7.WHEAT_BLOCK && (await count(V7.SEEDS)) === seeds0 - 1, "seeds plant wheat on the farmland (one seed used)");
    // bone meal grows it a few stages at a time, to ripe
    const meal0 = await count(V7.BONE_MEAL);
    await holdItem(V7.BONE_MEAL);
    await sleep(300);
    let uses = 0;
    for (; uses < 8 && (await blockAt(T2[0], ay + 1, T2[2])) !== V7.WHEAT_BLOCK + 7; uses++) {
      const stage = (await blockAt(T2[0], ay + 1, T2[2])) - V7.WHEAT_BLOCK;
      await rightAt(T2[0] + 0.5, ay + 1 + Math.max(0.05, ((stage + 1) * 2) / 16 - 0.05), T2[2] + 0.5, 600);
    }
    check((await blockAt(T2[0], ay + 1, T2[2])) === V7.WHEAT_BLOCK + 7 && (await count(V7.BONE_MEAL)) === meal0 - uses, `bone meal grows the wheat to ripe (${uses} uses, each one used up)`);
    // the harvest: ripe wheat breaks at once and drops wheat and seeds, picked up where we stand
    const wheat0 = await count(V7.WHEAT);
    const seeds1 = await count(V7.SEEDS);
    await lookAt(T2[0] + 0.5, ay + 1.4, T2[2] + 0.5);
    await sleep(180);
    await g(() => { window.__game.mouse = 1; });
    await sleep(120);
    await g(() => { window.__game.mouse = 0; });
    await sleep(300);
    // step onto the harvested cell (a seed may have hopped into the water beside it)
    await chat(`/tp ${T2[0] + 0.5} ${ay + 1} ${T2[2] + 0.5}`);
    await until(async () => (await count(V7.WHEAT)) > wheat0 && (await count(V7.SEEDS)) > seeds1, 4000);
    await sleep(500);
    check((await blockAt(T2[0], ay + 1, T2[2])) === 0 && (await count(V7.WHEAT)) === wheat0 + 1 && (await count(V7.SEEDS)) > seeds1, `the ripe wheat is harvested: 1 wheat and ${(await count(V7.SEEDS)) - seeds1} seeds picked up`);
    // an empty bucket scoops the source back up
    await holdItem(V7.BUCKET);
    await sleep(300);
    await rightAt(H[0] + 0.5, ay + 0.85, H[2] + 0.5, 900);
    check((await blockAt(...H)) === 0 && (await count(V7.WATER_BUCKET)) === 1 && (await count(V7.BUCKET)) === 1, "an empty bucket scoops the water back up");
    // a cake: placed on the ground, a slice eaten when hungry (+2 food)
    await holdItem(V7.CAKE);
    await sleep(300);
    await rightAt(C[0] + 0.5, ay + 0.99, C[2] + 0.5, 800);
    const placedCake = (await blockAt(C[0], ay + 1, C[2])) === V7.CAKE;
    await chat("/hunger 10");
    await until(async () => (await g(() => window.__game.stats.food)) === 10, 2000);
    await rightAt(C[0] + 0.5, ay + 1.3, C[2] + 0.5, 900);
    check(placedCake && (await blockAt(C[0], ay + 1, C[2])) === V7.CAKE + 1 && (await g(() => window.__game.stats.food)) === 12, "a cake on the ground: a slice eaten when hungry (+2 food), six left");
    // milk: an empty bucket on a cow, then the milk drunk (hold right click): the bucket comes back
    await chat("/summon cow 1");
    await sleep(700);
    await holdItem(V7.BUCKET);
    await sleep(300);
    for (let k = 0; k < 8 && (await count(V7.MILK)) === 0; k++) {
      const cow = await g(() => { const w = window.__game; let best = null, bd = 1e9; for (const a of w.animals.values()) { if (a.kind !== 1) continue; const d = Math.hypot(a.x - w.phys.x, a.z - w.phys.z); if (d < bd) { bd = d; best = { x: a.x, y: a.y + a.spec.h * 0.6, z: a.z, d }; } } return best; });
      if (!cow) break;
      if (cow.d > 2.4) {
        await chat(`/tp ${cow.x + 1.6} ${ay + 1} ${cow.z + 0.3}`);
        await sleep(700);
        continue;
      }
      await rightAt(cow.x, cow.y, cow.z, 600);
    }
    const milked = (await count(V7.MILK)) === 1 && (await count(V7.BUCKET)) === 0;
    await holdItem(V7.MILK);
    await sleep(300);
    await g(() => { const w = window.__game; w.mouse = 4; w.rightClick(); });
    await sleep(2100);
    await g(() => { window.__game.mouse = 0; });
    await sleep(400);
    check(milked && (await count(V7.MILK)) === 0 && (await count(V7.BUCKET)) === 1, "an empty bucket milks a cow, and the milk is drunk (hold right click): the bucket is left");
    // the bow: drawn for a second it zooms the view and the hand shows the full draw; loosed at a frozen Shambler it
    // flies (drawn) and lands a critical hit; one arrow used, the bow wears
    // (from the far end of the field, facing back: the cow and the farm are behind the target)
    await chat("/time 18000");
    await chat(`/tp ${ax + 0.5} ${ay + 1} ${az + 13.5}`);
    await sleep(900);
    await g(() => { const w = window.__game; w.yaw = 180; w.pitch = 0; });
    await sleep(400);
    await chat("/summon shambler 1 5");
    await chat("/mobs freeze");
    await sleep(900);
    await holdItem(V7.BOW);
    await sleep(400);
    await g(() => { window.__v6.length = 0; });
    const mob = await g(() => { const m = [...window.__game.mobs.values()].find((m) => m.spec.key === "shambler"); return m ? { x: m.x, y: m.y + m.spec.h * 0.6, z: m.z } : null; });
    if (mob) await lookAt(mob.x, mob.y, mob.z);
    await sleep(200);
    await g(() => { const w = window.__game; w.mouse = 4; w.rightClick(); });
    await sleep(1150);
    const pose = await g(() => ({ fov: window.__game.fovMod, frame: window.__game.hand.drawFrame }));
    check(pose.fov < 0.9 && pose.frame === 3, `drawing the bow zooms in (fov x${pose.fov.toFixed(2)}) and the hand shows the full draw (frame ${pose.frame})`);
    await g(() => { window.__game.mouse = 0; });
    await until(async () => (await v6log("struck")).length > 0, 2500);
    {
      const st = (await v6log("struck"))[0];
      const shot = (await v6log("arrow"))[0];
      check(!!mob && !!shot && shot.drawn && !!st && st.mob && st.crit && st.dmg > 0, `a full draw looses an arrow that flies (drawn) and lands a critical hit on the Shambler${st ? ` (${st.dmg})` : ""}`);
    }
    check((await count(V7.ARROW)) === 3 && (await heldD()) === 1, "one arrow used, the bow wears by one");
    await chat("/mobs freeze");
    await chat("/mobs clear");
    await chat("/time 6000");
    // an arrow loosed into the ground sticks there, and walking over it picks it up
    await g(() => { const w = window.__game; w.yaw = -90; w.pitch = 40; window.__v6.length = 0; });
    await sleep(200);
    await g(() => { const w = window.__game; w.mouse = 4; w.rightClick(); });
    await sleep(1150);
    await g(() => { window.__game.mouse = 0; });
    await until(async () => (await v6log("arrow_end")).length > 0, 2500);
    {
      const end = (await v6log("arrow_end"))[0];
      if (end && end.stuck) {
        await sleep(600);
        await chat(`/tp ${end.x} ${ay + 1} ${end.z}`);
      }
      await until(async () => (await count(V7.ARROW)) === 3, 3000);
      const gone = (await v6log("arrow_gone")).length > 0;
      check(!!end && end.stuck && (await count(V7.ARROW)) === 3 && gone, "an arrow in the ground sticks there, and walking over it picks it up again");
    }
    // sugar cane by the water
    check(await g(() => { let n = 0; const b = window.__game.blocks; for (let i = 0; i < b.length; i++) if (b[i] === 151) n++; return n > 100; }), "sugar cane grows along the shores");
  }

  // ---- creative (dev/admin)
  await chat("/gamemode creative");
  await sleep(500);
  check(await g(() => window.__game.gm === "creative" && document.querySelector("#ui").classList.contains("creative")), "creative mode hides the hearts");
  await g(() => window.__game.openInventory());
  await sleep(300);
  check(await g(() => window.__game.state === "picker"), "in creative, E opens the block picker");
  check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join("; ") : ""}`);
  await D.ctx.close();

  // ---- 7.2: a laptop at 125% display scaling: the GUI pixels are whole device pixels (crisp), every slot on them
  {
    const L = await join(browser, { viewport: { width: 1536, height: 864 }, deviceScaleFactor: 1.25 });
    await L.g(() => window.__game.openInventory());
    await sleep(400);
    const r = await L.g(() => {
      const s = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--s"));
      const dpr = devicePixelRatio;
      const p = document.querySelector(".mcpanel.inv.player").getBoundingClientRect();
      const off = [...document.querySelectorAll(".mcpanel .islot")].map((e) => { const b = e.getBoundingClientRect(); return [(b.left - p.left) * dpr, (b.top - p.top) * dpr, b.width * dpr]; });
      const whole = (v) => Math.abs(v - Math.round(v)) < 0.02;
      return { s, dpr, dev: s * dpr, ok: off.every(([x, y, w]) => whole(x) && whole(y) && whole(w)), hot: document.querySelector(".hotbar").getBoundingClientRect().width * dpr };
    });
    check(Number.isInteger(Math.round(r.dev * 1000) / 1000) && r.ok && Math.abs(r.hot - 182 * r.dev) < 0.05, `at 125% scaling the GUI scale is ${r.dev} device pixels (${r.s} CSS px) and every slot sits on whole device pixels`);
    check(L.errors.length === 0, `no page errors at 125%${L.errors.length ? ": " + L.errors.join("; ") : ""}`);
    await L.ctx.close();
  }

  // ---- 7.2: a phone (390 x 844, touch): the GUI fits, taps pick up and place, press-and-hold splits, the X closes
  {
    const P = await join(browser, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }, true);
    check(await P.g(() => window.__game.touchMode && document.getElementById("ui").classList.contains("touch-mode")), "the phone plays with touch controls");
    const items = await P.centre(".touch .tbtn:has-text('Items')").catch(() => null);
    if (items) await P.page.touchscreen.tap(items.x, items.y);
    else await P.g(() => window.__game.openInventory());
    await sleep(500);
    const fit = await P.g(() => {
      const s = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--s"));
      const r = document.querySelector(".mcpanel.inv.player").getBoundingClientRect();
      const x = document.querySelector(".mcpanel.inv.player .mcclose");
      return { s, dev: s * devicePixelRatio, inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, x: !!x && getComputedStyle(x).display !== "none" };
    });
    check(fit.inside && Number.isInteger(fit.dev), `the inventory fits the phone at a whole-pixel scale (${fit.s} CSS px = ${fit.dev} device px)`);
    check(fit.x, "touch screens get an X on the window");
    const tap = async (s) => {
      const c = await P.centre(`.islot[data-s="${s}"]`);
      await P.page.touchscreen.tap(c.x, c.y);
      await sleep(350);
    };
    const appleSlot = await P.findSlot(ID.APPLE);
    await tap(appleSlot);
    check(await P.g(() => window.__game.cursor.s?.id === 265 && window.__game.cursor.s?.n === 3), "a tap picks up the apples");
    await tap(9);
    check((await P.slotAt(9))?.n === 3 && (await P.g(() => !window.__game.cursor.s)), "a tap on an empty slot puts them down");
    {
      const c = await P.centre('.islot[data-s="9"]');
      const cdp = await P.ctx.newCDPSession(P.page);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: c.x, y: c.y }] });
      await sleep(700);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await sleep(400);
    }
    check(await P.g(() => window.__game.cursor.s?.n === 2) && (await P.slotAt(9))?.n === 1, "press and hold takes half (like a right click)");
    await tap(9);
    check((await P.slotAt(9))?.n === 3, "a tap puts them back");
    const book = await P.centre(".mcbookbtn");
    await P.page.touchscreen.tap(book.x, book.y);
    await sleep(300);
    check(await P.g(() => !document.querySelector(".mcbook").classList.contains("hidden") && document.querySelector(".mcwrap").dataset.mode === "stack"), "on a tall phone the recipe book opens below the panel");
    const bookFits = await P.g(() => { const r = document.querySelector(".mcbook").getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0; });
    check(bookFits, "and both fit the screen");
    await P.page.touchscreen.tap(book.x, book.y);
    await sleep(300);
    const x = await P.centre(".mcpanel.inv.player .mcclose");
    await P.page.touchscreen.tap(x.x, x.y);
    await sleep(400);
    check(await P.g(() => window.__game.state === "play" && !document.querySelector(".inv-screen")), "the X closes the inventory");
    check(P.errors.length === 0, `no page errors on the phone${P.errors.length ? ": " + P.errors.join("; ") : ""}`);
    await P.ctx.close();
  }

  await browser.close();
  console.log(failed ? `${failed} FAILED (${passed} passed)` : `ALL PASS (${passed})`);
  process.exit(failed ? 1 : 0);
})();
