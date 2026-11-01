// The switch's multiplayer check in real headless Chrome against a local server (DEV_COMMANDS=1): two players join
// and see each other, chat both ways, place and break blocks that the other sees, the Tab list and the hub's charity
// board read prelaunch ("Starts at launch", Gamers Outreach); and, if OLD_SITE is given, the old $STEVE Craft builder
// page (protocol 4) meeting this server reloads once and then says the game was updated (no crash, no hang).
// Usage: node tools/mp-check.cjs <site-url> <server-ws> [old-site-url]     (PASS/FAIL lines; exit 1 on any failure)
const PW = process.env.PLAYWRIGHT || "C:/Users/vincu/Desktop/memecoin/sites/evolve/node_modules/playwright";
const { chromium } = require(PW);
const site = (process.argv[2] || "http://127.0.0.1:5240").replace(/\/$/, "");
const server = process.argv[3] || "ws://127.0.0.1:8811";
const oldSite = process.argv[4] ? process.argv[4].replace(/\/$/, "") : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failed++;
};

async function player(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript((n) => localStorage.setItem("steve_name", n), name);
  await page.goto(`${site}/play/?server=${encodeURIComponent(server)}`);
  for (let i = 0; i < 240; i++) {
    if ((await page.evaluate(() => window.__game && window.__game.state).catch(() => "")) === "play") break;
    await sleep(250);
  }
  const g = (fn, a) => page.evaluate(fn, a);
  return { page, ctx, errors, g, chat: (t) => g((t) => window.__game.net.send({ t: "chat", text: t }), t) };
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
  const A = await player(browser, "DiamondMiner_1111");
  const B = await player(browser, "LuckySteve_2222");
  check((await A.g(() => window.__game.state)) === "play" && (await B.g(() => window.__game.state)) === "play", "two players joined");
  check((await A.g(() => document.title)).includes("$STEVE Craft"), `the page is $STEVE Craft (${await A.g(() => document.title)})`);
  const names = await A.g(() => [window.__game.myName, ...[...window.__game.others.values()].map((o) => o.name)]);
  check(names.includes("LuckySteve_2222"), `A sees B (${names.join(", ")})`);
  check((await B.g(() => [...window.__game.others.values()].map((o) => o.name))).includes("DiamondMiner_1111"), "B sees A");
  // walk B next to A and check A draws B's avatar there
  const sh = await A.g(() => window.__game.info.spawnHeight);
  // out in the wild (past the safe zone), on flat ground east of the ring
  const spot = await A.g(() => {
    const g = window.__game;
    const at = (x, y, z) => g.blocks[(y << 18) | (z << 9) | x];
    for (let r = 80; r < 130; r++)
      for (const [x, z] of [[256 + r, 256], [256, 256 - r], [256 - r, 256], [256 + r, 256 + 20]]) {
        let y = 100;
        while (y > 30 && at(x, y, z) === 0) y--;
        const top = at(x, y, z);
        if (top !== 1 && top !== 2) continue;
        let ok = true;
        for (let dx = -2; dx <= 4 && ok; dx++) for (let dz = -2; dz <= 2 && ok; dz++) if (at(x + dx, y, z + dz) !== 1 && at(x + dx, y, z + dz) !== 2) ok = false; else if (at(x + dx, y + 1, z + dz) !== 0 || at(x + dx, y + 2, z + dz) !== 0) ok = false;
        if (ok) return { x, y, z };
      }
    return null;
  });
  check(!!spot, `a flat spot in the wild (${spot && `${spot.x},${spot.y},${spot.z}`})`);
  await A.chat("/gamemode creative");
  await B.chat("/gamemode creative");
  await A.chat(`/tp ${spot.x + 0.5} ${spot.y + 1} ${spot.z + 0.5}`);
  await B.chat(`/tp ${spot.x + 3.5} ${spot.y + 1} ${spot.z + 0.5}`);
  await sleep(2500);
  const seen = await A.g(() => {
    const o = [...window.__game.others.values()].find((p) => p.name === "LuckySteve_2222");
    return o ? { x: o.root.position.x, z: o.root.position.z, vis: o.root.visible } : null;
  });
  check(!!seen && Math.abs(seen.x - (spot.x + 3.5)) < 0.6 && Math.abs(seen.z - (spot.z + 0.5)) < 0.6 && seen.vis, `A draws B where B stands (${seen && `${seen.x.toFixed(1)}, ${seen.z.toFixed(1)}`})`);
  // chat both ways
  await A.chat("hello from A, punch a tree!");
  await B.chat("hi A, see you at the village");
  await sleep(1200);
  const chatB = await B.g(() => [...document.querySelectorAll(".chat .line")].map((e) => e.textContent).join(" | "));
  const chatA = await A.g(() => [...document.querySelectorAll(".chat .line")].map((e) => e.textContent).join(" | "));
  check(chatB.includes("hello from A, punch a tree!"), "B reads A's chat");
  check(chatA.includes("hi A, see you at the village"), "A reads B's chat");
  // place a block (A) and see it on B; break it (B) and see it gone on A
  const px = spot.x + 1;
  const py = spot.y + 1;
  const pz = spot.z + 2;
  await A.g(([x, y, z]) => {
    const g = window.__game;
    g.setLocal(x, y, z, 6);
    g.net.send({ t: "place", x, y, z, id: 6 });
  }, [px, py, pz]);
  let onB = 0;
  for (let i = 0; i < 30 && onB !== 6; i++) {
    await sleep(150);
    onB = await B.g(([x, y, z]) => window.__game.blocks[(y << 18) | (z << 9) | x], [px, py, pz]);
  }
  check(onB === 6, "A places oak planks; B sees them");
  await B.g(([x, y, z]) => {
    const g = window.__game;
    g.net.send({ t: "dig", a: "start", x, y, z });
    g.net.send({ t: "dig", a: "finish", x, y, z });
  }, [px, py, pz]);
  let onA = 6;
  for (let i = 0; i < 30 && onA !== 0; i++) {
    await sleep(150);
    onA = await A.g(([x, y, z]) => window.__game.blocks[(y << 18) | (z << 9) | x], [px, py, pz]);
  }
  check(onA === 0, "B breaks them; A sees them gone");
  // the charity: Tab and the board in the Charity Hall
  const ch = await A.g(() => window.__game.charity);
  check(!!ch && ch.state === "prelaunch" && ch.name === "Gamers Outreach" && ch.x === "GamersOutreach", `the charity is Gamers Outreach, prelaunch (${JSON.stringify(ch)})`);
  await A.g(() => window.__game.keys && document.dispatchEvent(new KeyboardEvent("keydown", { code: "Tab", key: "Tab" })));
  await A.g(() => (window.__game.tabHeld = true));
  await sleep(400);
  const tab = await A.g(() => (document.querySelector(".tablist:not(.hidden)") || {}).textContent || "");
  check(/Raised for @GamersOutreach/.test(tab) && /Starts at launch/.test(tab), `Tab: "${tab.replace(/\s+/g, " ").slice(-80)}"`);
  await A.g(() => (window.__game.tabHeld = false));
  const board = await A.g(() => {
    const sc = window.__game.scenery;
    const e = sc.panels.find((x) => x.p.kind === "charity");
    return e ? { charity: sc.charity, w: e.canvas.width } : null;
  });
  check(!!board && board.charity && board.charity.state === "prelaunch", "the Charity Hall's board is painted with the prelaunch state");
  check(A.errors.length === 0 && B.errors.length === 0, `no page errors ${JSON.stringify([...A.errors, ...B.errors].slice(0, 3))}`);
  await A.ctx.close();
  await B.ctx.close();

  // ---- the old builder page (protocol 4) against this server
  if (oldSite) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let loads = 0;
    page.on("load", () => loads++);
    await page.goto(`${oldSite}/play/?server=${encodeURIComponent(server)}`);
    await sleep(9000);
    const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").trim());
    check(loads === 2, `the old page reloaded itself once to pick up the update (${loads} loads)`);
    check(/updated/i.test(text) && /refresh/i.test(text), `then it says the game was updated: "${text.slice(0, 120)}"`);
    check(errors.length === 0, `the old page threw nothing ${JSON.stringify(errors.slice(0, 2))}`);
    await ctx.close();
  }
  await browser.close();
  console.log(failed ? `${failed} FAILED` : "ALL PASS");
  process.exit(failed ? 1 : 0);
})();
