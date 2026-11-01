// Film mode for the game page (injected before the page's own scripts; never shipped): a virtual clock for
// performance.now, Date.now, requestAnimationFrame, setTimeout and setInterval. Live, it follows real time; stopped,
// it moves only on window.__film.step(ms), which fires the timers due and runs one animation frame. Paired with the
// server's clock (clock.mjs) the whole world advances one video frame at a time.
(() => {
  const rp = performance.now.bind(performance);
  const rDate = Date.now.bind(Date);
  const rST = window.setTimeout.bind(window);
  const rCT = window.clearTimeout.bind(window);
  const rSI = window.setInterval.bind(window);
  const rRAF = window.requestAnimationFrame.bind(window);
  let live = true;
  let off = 0;
  let vt = 0;
  const now = () => (live ? rp() + off : vt);
  const epoch = rDate() - rp();
  performance.now = now;
  Date.now = () => Math.floor(epoch + now());

  let seq = 1;
  const timers = new Map();
  const add = (fn, ms, args, every) => {
    const id = seq++;
    const d = Math.max(0, Number(ms) || 0);
    timers.set(id, { at: now() + d, fn, args, every: every ? Math.max(1, d) : 0 });
    return id;
  };
  window.setTimeout = (fn, ms, ...a) => add(fn, ms, a, false);
  window.setInterval = (fn, ms, ...a) => add(fn, ms, a, true);
  window.clearTimeout = (id) => timers.delete(id);
  window.clearInterval = (id) => timers.delete(id);
  const runTo = (to) => {
    for (let guard = 0; guard < 10000; guard++) {
      let best = null;
      let bestId = 0;
      for (const [id, t] of timers) if (t.at <= to && (!best || t.at < best.at)) [best, bestId] = [t, id];
      if (!best) return;
      if (!live) vt = Math.max(vt, best.at);
      if (best.every) best.at += best.every;
      else timers.delete(bestId);
      try {
        typeof best.fn === "function" ? best.fn(...best.args) : 0;
      } catch (e) {
        console.error(e);
      }
    }
  };
  rSI(() => {
    if (live) runTo(now());
  }, 4);

  let rafQ = [];
  let rafSeq = 1;
  window.requestAnimationFrame = (cb) => {
    const id = rafSeq++;
    if (live) rRAF(() => cb(now()));
    else rafQ.push([id, cb]);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    rafQ = rafQ.filter((r) => r[0] !== id);
  };

  window.__film = {
    get live() {
      return live;
    },
    now,
    /** Stop the clock (it moves only with step). */
    stop() {
      if (!live) return vt;
      vt = now();
      live = false;
      return vt;
    },
    /** Back to real time. */
    go() {
      if (live) return;
      off = vt - rp();
      live = true;
      const q = rafQ;
      rafQ = [];
      for (const [, cb] of q) rRAF(() => cb(now()));
    },
    /** Move the stopped clock `ms`: timers due fire, then one animation frame runs. */
    step(ms) {
      if (live) return;
      const to = vt + ms;
      runTo(to);
      vt = to;
      const q = rafQ;
      rafQ = [];
      for (const [, cb] of q) {
        try {
          cb(vt);
        } catch (e) {
          console.error(e);
        }
      }
    },
    sync: 0,
  };
  // the server's film_sync marker (sent after everything that came before it): the film waits for it each frame
  const WS = window.WebSocket;
  window.WebSocket = function (...a) {
    const ws = new WS(...a);
    ws.addEventListener("message", (e) => {
      if (typeof e.data === "string" && e.data.startsWith('{"t":"film_sync"')) {
        try {
          window.__film.sync = JSON.parse(e.data).n;
        } catch {}
      }
    });
    return ws;
  };
  window.WebSocket.prototype = WS.prototype;
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  void rST;
  void rCT;
})();
