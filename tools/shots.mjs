// clankersmp: stills for posts, from the live run. A headless browser watches each AI through the real game client
// (follow mode, embed) at 2400x1350 and saves a frame every few seconds, so the good moments can be picked after.
//   node tools/shots.mjs <outdir> [minutes=10] [every=20]   (AIs: opus,sonnet,haiku; SITE=1 also shoots the site)
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || "C:/Users/vincu/Desktop/memecoin/sites/evolve/node_modules/playwright");
const RELAY = process.env.RELAY || "https://engine-production-08c9.up.railway.app";
const out = process.argv[2];
const minutes = Number(process.argv[3] || 10);
const every = Number(process.argv[4] || 20);
const agents = (process.env.AGENTS || "opus,sonnet,haiku").split(",");
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toTimeString().slice(0, 8).replace(/:/g, "");

const browser = await chromium.launch({ headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const pages = [];
for (const a of agents) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.5 });
  const page = await ctx.newPage();
  await page.goto(`${RELAY}/play/?follow=${a}&embed=1`);
  pages.push({ a, page });
}
if (process.env.SITE) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.5 });
  const page = await ctx.newPage();
  await page.goto(`${process.env.SITE}?relay=${encodeURIComponent(RELAY)}`);
  pages.push({ a: "site", page });
}
await sleep(20000); // the world builds itself in each page
const end = Date.now() + minutes * 60000;
while (Date.now() < end) {
  for (const { a, page } of pages) {
    const file = join(out, `${a}-${stamp()}.jpg`);
    await page.screenshot({ path: file, type: "jpeg", quality: 90 }).catch((e) => console.log(a, "shot failed", e.message));
  }
  console.log("shots at", stamp());
  await sleep(every * 1000);
}
await browser.close();
