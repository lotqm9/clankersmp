// Builds a captioned contact sheet of a folder of images, in $STEVE Craft's look (KenneyMini, dark panels, yellow).
// Usage: node tools/contact-sheet.cjs <dir> <out.png|.jpg> "<title>" ["<subtitle>"]
// Captions come from <dir>/captions.json ({"file.png": "caption"}); only the files listed there are shown, in order.
// Env COLS (default 4) and ASPECT (the image box, default 16/9; "auto" keeps each image's own shape).
const PW = process.env.PLAYWRIGHT || "C:/Users/vincu/Desktop/memecoin/sites/evolve/node_modules/playwright";
const { chromium } = require(PW);
const fs = require("fs");
const path = require("path");

(async () => {
  const [dir, out, title = "$STEVE Craft", sub = "From the real game: the built client in headless Chrome on a local server, bots as players. All art is original."] = process.argv.slice(2);
  const cols = Number(process.env.COLS || 4);
  const aspect = process.env.ASPECT || "16/9";
  const captions = JSON.parse(fs.readFileSync(path.join(dir, "captions.json"), "utf8"));
  const files = Object.keys(captions).filter((f) => fs.existsSync(path.join(dir, f)));
  const mime = (f) => (/\.jpe?g$/i.test(f) ? "image/jpeg" : "image/png");
  const cells = files
    .map((f) => {
      const b64 = fs.readFileSync(path.join(dir, f)).toString("base64");
      return `<figure><div class="img"><img src="data:${mime(f)};base64,${b64}"></div><figcaption><b>${f}</b> ${captions[f]}</figcaption></figure>`;
    })
    .join("");
  const font = "data:font/ttf;base64," + fs.readFileSync(path.join(__dirname, "..", "web", "public", "play", "fonts", "KenneyMini.ttf")).toString("base64");
  const html = `<!doctype html><html><head><style>
    @font-face{font-family:"KenneyMini";src:url(${font})}
    body{margin:0;background:#1b1b1b;color:#e0e0e0;font:16px "KenneyMini",monospace;padding:28px}
    h1{font-size:34px;font-weight:normal;margin:0 0 6px;color:#fff;text-shadow:3px 3px 0 #3f3f3f} p{margin:0 0 18px;color:#aaa}
    .grid{display:grid;grid-template-columns:repeat(${cols},1fr);gap:14px}
    figure{margin:0;background:#2b2b2b;border:3px solid #000;box-shadow:inset 2px 2px 0 #555;overflow:hidden}
    .img{aspect-ratio:${aspect};background:#000;display:flex;align-items:center;justify-content:center}
    .img img{max-width:100%;max-height:100%;object-fit:contain}
    figcaption{padding:8px 10px;line-height:1.4} b{color:#ffff55;font-weight:normal;margin-right:6px}
  </style></head><body><h1>${title}</h1>
  <p>${sub}</p>
  <div class="grid">${cells}</div></body></html>`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 2400, height: 1200 } });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const jpg = /\.jpe?g$/i.test(out);
  await page.screenshot({ path: out, fullPage: true, ...(jpg ? { type: "jpeg", quality: 90 } : {}) });
  await browser.close();
  console.log("saved", out);
})();
