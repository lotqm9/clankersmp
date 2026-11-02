// clankersmp: pictures of a test world through the game client. A spectator page follows an AI (the server streams
// it the blocks round that AI), then the camera is taken over and put where each shot wants it. Needs the client
// served by vite (VITE: http://127.0.0.1:5277) and a test server (SERVER, default ws://127.0.0.1:8789).
//   FOLLOW=opus SERVER=ws://127.0.0.1:8795 node tools/cam.cjs shots.json
//   shots.json: [{ "out": "a.png", "eye": [x, y, z], "look": [x, y, z], "fov": 70 }, { "out": "b.png", "raw": true }]
const { chromium } = require('C:/Users/vincu/Desktop/memecoin/sites/evolve/node_modules/playwright');
const fs = require('fs');
const shots = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const follow = process.env.FOLLOW || 'sonnet';
const W = +(process.env.W || 1280), H = +(process.env.H || 800);
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`${process.env.VITE || 'http://127.0.0.1:5277'}/play/?server=${process.env.SERVER || "ws://127.0.0.1:8789"}&follow=${follow}&embed=1`, { waitUntil: 'domcontentloaded' });
  // the world loaded and drawing (under load a fixed wait shot a black canvas before the first frame)
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    const st = await page.evaluate(() => window.__game && window.__game.state).catch(() => null);
    if (st === 'play') break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(+(process.env.WAIT || 10000));
  await page.addStyleTag({ content: 'body > *:not(canvas):not(#game):not(#app) { display: none !important } .hud, #hud, .hotbar, #hotbar { display: none !important }' });
  await page.evaluate(() => {
    const g = window.__game;
    const r = g.renderer;
    if (!r.__wrapped) {
      const orig = r.render.bind(r);
      r.render = (scene, cam) => {
        const s = window.__shot;
        if (s && cam.isPerspectiveCamera) {
          cam.position.set(s.eye[0], s.eye[1], s.eye[2]);
          cam.up.set(0, 1, 0);
          cam.lookAt(s.look[0], s.look[1], s.look[2]);
          if (s.fov && cam.fov !== s.fov) { cam.fov = s.fov; cam.updateProjectionMatrix(); }
          cam.updateMatrixWorld(true);
        }
        orig(scene, cam);
      };
      r.__wrapped = true;
    }
  });
  for (const s of shots) {
    await page.evaluate((s) => { window.__shot = s.raw ? null : s; }, s);
    await page.waitForTimeout(+(process.env.SETTLE || 2500));
    await page.screenshot({ path: s.out, type: s.out.endsWith('.jpg') ? 'jpeg' : 'png' });
    console.log('shot', s.out);
  }
  await browser.close();
})();
