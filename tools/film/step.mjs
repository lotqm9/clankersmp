// Lockstep: one video frame of the whole world. The server's clock moves 1/60 s (its 20 Hz ticks fire every third
// frame), a film_sync marker follows everything it sent, the page waits for it, then the page's clock moves the same
// 1/60 s and runs one animation frame (the game's ticks and its render); then the mesher catches up.
import { sleep } from "./director.mjs";

export function stepper(P, clock, fps = 60) {
  let n = 0;
  const dt = 1000 / fps;
  const api = {
    frame: 0,
    async start() {
      await clock.stop();
      await P.g(() => window.__film.stop());
    },
    async stop() {
      await clock.live();
      await P.g(() => window.__film.go());
    },
    /** One frame. `before` runs after the server has moved and its messages are in, before the page's frame. */
    async step(before) {
      await clock.advance(dt);
      n++;
      await clock.sync(n);
      for (let i = 0; i < 2000; i++) {
        if ((await P.g(() => window.__film.sync)) >= n) break;
        await sleep(1);
      }
      if (before) await before(api.frame);
      await P.g((ms) => window.__film.step(ms), dt);
      await P.meshed(8000);
      api.frame++;
    },
    /** Run k frames without capturing (letting things settle). */
    async run(k, before) {
      for (let i = 0; i < k; i++) await api.step(before);
    },
  };
  return api;
}
