// Film mode for the game server (never in production): a virtual clock, so the film can step the whole world one
// video frame at a time and every frame is smooth however long it takes to capture. Load it before the server:
//   FILM_CLOCK_PORT=8899 node --import ./tools/film/clock.mjs server/src/main.ts
// Date.now, performance.now, setTimeout and setInterval run on the virtual clock. Control (HTTP on 127.0.0.1):
//   POST /live            the clock follows real time (setting a scene up)
//   POST /stop            the clock stands still until advanced
//   POST /advance?ms=N    move the clock N ms, firing every timer due, in order (the 20 Hz ticks among them)
//   POST /sync?n=K        send {"t":"film_sync","n":K} on every open game socket (after everything sent before it)
//   GET  /now             { now, live }
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const realDateNow = Date.now.bind(Date);
const realPerfNow = performance.now.bind(performance);
const realSetInterval = globalThis.setInterval;

let live = true;
let perfOff = 0; // live: virtual perf = real perf + perfOff
let vperf = realPerfNow(); // stopped: the virtual perf time
const epochOff = realDateNow() - realPerfNow(); // Date.now = epochOff + perf
const perfNow = () => (live ? realPerfNow() + perfOff : vperf);
Date.now = () => Math.floor(epochOff + perfNow());
performance.now = perfNow;

// ---- virtual timers
let seq = 1;
const timers = new Map(); // id -> { at, fn, args, every }
class VTimer {
  constructor(id) {
    this.id = id;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
  hasRef() {
    return true;
  }
  refresh() {
    const t = timers.get(this.id);
    if (t) t.at = perfNow() + (t.every ?? t.ms);
    return this;
  }
  [Symbol.toPrimitive]() {
    return this.id;
  }
}
const add = (fn, ms, args, every) => {
  const id = seq++;
  const d = Math.max(1, Number(ms) || 0);
  timers.set(id, { at: perfNow() + d, fn, args, every: every ? d : undefined, ms: d });
  return new VTimer(id);
};
const clear = (t) => {
  if (t == null) return;
  timers.delete(typeof t === "object" ? t.id : Number(t));
};
globalThis.setTimeout = (fn, ms, ...args) => add(fn, ms, args, false);
globalThis.setInterval = (fn, ms, ...args) => add(fn, ms, args, true);
globalThis.clearTimeout = clear;
globalThis.clearInterval = clear;

/** Fire every timer due up to `to` (virtual perf ms), earliest first, with the clock at each timer's own time. */
function runTo(to) {
  for (let guard = 0; guard < 100000; guard++) {
    let next = null;
    let nextId = 0;
    for (const [id, t] of timers) if (t.at <= to && (!next || t.at < next.at || (t.at === next.at && id < nextId))) [next, nextId] = [t, id];
    if (!next) break;
    if (!live) vperf = Math.max(vperf, next.at);
    if (next.every) next.at += next.every;
    else timers.delete(nextId);
    try {
      next.fn(...next.args);
    } catch (e) {
      console.error("[film clock] timer threw", e);
    }
  }
  if (!live) vperf = Math.max(vperf, to);
}
// live mode: a real pump fires the virtual timers on time
realSetInterval(() => {
  if (live) runTo(perfNow());
}, 4);

// ---- the game sockets (for /sync)
const sockets = new Set();
const handleUpgrade = WebSocketServer.prototype.handleUpgrade;
WebSocketServer.prototype.handleUpgrade = function (req, socket, head, cb) {
  return handleUpgrade.call(this, req, socket, head, (ws, ...rest) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    cb(ws, ...rest);
  });
};

// ---- control
const PORT = Number(process.env.FILM_CLOCK_PORT || 8899);
createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const done = (o) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(o));
  };
  if (url.pathname === "/live") {
    if (!live) {
      perfOff = vperf - realPerfNow();
      live = true;
    }
    return done({ now: perfNow(), live });
  }
  if (url.pathname === "/stop") {
    if (live) {
      vperf = perfNow();
      live = false;
    }
    return done({ now: perfNow(), live });
  }
  if (url.pathname === "/advance") {
    const ms = Number(url.searchParams.get("ms") || 0);
    if (!live) runTo(vperf + ms);
    return done({ now: perfNow(), live });
  }
  if (url.pathname === "/sync") {
    const msg = JSON.stringify({ t: "film_sync", n: Number(url.searchParams.get("n") || 0) });
    let n = 0;
    for (const ws of sockets)
      if (ws.readyState === 1) {
        ws.send(msg);
        n++;
      }
    return done({ sent: n });
  }
  if (url.pathname === "/now") return done({ now: perfNow(), live });
  res.writeHead(404);
  res.end();
}).listen(PORT, "127.0.0.1", () => console.log(`[film clock] control on 127.0.0.1:${PORT}`));
