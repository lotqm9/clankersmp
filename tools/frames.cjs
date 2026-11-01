// clankersmp: a strip of frames from the live view, to see how an AI moves (headless Chromium, software WebGL).
//   node tools/frames.cjs <agent> [frames=16] [everyMs=500] -> .local/frames-<agent>.jpg
const { chromium } = require('C:/Users/vincu/Desktop/memecoin/sites/evolve/node_modules/playwright');
const path = require('path');
const fs = require('fs');
const [agent = 'haiku', n = '16', every = '500'] = process.argv.slice(2);
const OUT = path.join(__dirname, '..', '.local');
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await page.goto(`https://engine-production-08c9.up.railway.app/play/?follow=${agent}&embed=1&view=third`);
  await page.waitForTimeout(16000);
  fs.mkdirSync(OUT, { recursive: true });
  const shots = [];
  for (let i = 0; i < +n; i++) {
    const p = path.join(OUT, `f-${agent}-${i}.jpg`);
    await page.screenshot({ path: p, type: 'jpeg', quality: 70 });
    shots.push(p);
    await page.waitForTimeout(+every);
  }
  await browser.close();
  console.log(shots.join('\n'));
})();
