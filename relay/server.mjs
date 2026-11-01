// clankersmp relay (own engine): the one public door of the container.
//   agents -> POST /ingest              what each AI thinks, says and does (agents/brain.ts)
//   site   <- GET  /events              server-sent events: a snapshot, then everything live, plus the director's cuts
//             GET  /state, /usage       the same as JSON; Claude spend over the last N minutes
//             GET  /clanker             the game server's own view of the AIs (alive, health, where)
//             GET  /play/...            the game client; ?follow=opus&embed=1 is an AI's first-person view
//             WS   /ws                  the game server's WebSocket (spectators join it from /play)
// The auto-director scores what each AI is going through and picks whose view is on the main stage.
//   PORT=8090 GAME_PORT=8787 PLAY_DIR=../dist-play node relay/server.mjs
import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8090);
const GAME_PORT = Number(process.env.GAME_PORT || 8787);
const PLAY_DIR = resolve(process.env.PLAY_DIR || join(HERE, '..', 'dist-play'));
const WWW_DIR = resolve(process.env.WWW_DIR || join(HERE, '..', 'www'));
const AGENTS = ['opus', 'sonnet', 'haiku'];
const MIN_DWELL_MS = 9000; // the director holds a shot at least this long
const PRICE = { 'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5] };
const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm',
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.webp': 'image/webp', '.ico': 'image/x-icon',
};

const state = { started: Date.now(), worldStart: null, agents: {} };
const blank = (name) => ({ name, alive: true, online: false, lastSeen: 0, status: null, thought: null, chat: null, action: null, death: null, deathAt: null });
for (const a of AGENTS) state.agents[a] = blank(a);

const events = [];
const usage = []; // { t, model, in, out, cache_read, cache_write }
const sse = new Set();
const interest = Object.fromEntries(AGENTS.map((a) => [a, 0]));
let focus = { agent: AGENTS[0], since: Date.now(), reason: 'start' };

const agentOf = (name) => state.agents[name] || (state.agents[name] = blank(name));
const bump = (name, n) => { interest[name] = (interest[name] || 0) + n; };

function send(res, ev) {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
}
function broadcast(ev) {
    for (const res of sse) send(res, ev);
}

function ingest(ev) {
    if (!ev || !ev.agent || !ev.type) return;
    if (ev.type === 'usage') {
        usage.push({ t: ev.t || Date.now(), model: ev.model, in: ev.in || 0, out: ev.out || 0, cache_read: ev.cache_read || 0, cache_write: ev.cache_write || 0 });
        while (usage.length && usage[0].t < Date.now() - 86400000) usage.shift();
        return;
    }
    const a = agentOf(ev.agent);
    a.online = true;
    a.lastSeen = ev.t || Date.now();
    switch (ev.type) {
        case 'spawn':
            if (ev.dead) { a.alive = false; a.death = a.death || 'died earlier'; break; }
            a.alive = true; a.death = null; a.deathAt = null;
            if (!state.worldStart) state.worldStart = ev.t;
            break;
        case 'status': {
            const prev = a.status;
            a.status = ev;
            if (prev && ev.health < prev.health) bump(ev.agent, (prev.health - ev.health) * 4); // getting hurt is the story
            break;
        }
        case 'thought': a.thought = { text: ev.text, t: ev.t }; bump(ev.agent, 2); break;
        case 'chat': a.chat = { text: ev.text, t: ev.t }; bump(ev.agent, 4); break;
        case 'command': a.action = { text: ev.text, t: ev.t }; bump(ev.agent, 1); break;
        case 'goal': a.goal = ev.text; bump(ev.agent, 3); break;
        case 'reflex': bump(ev.agent, /fought|ran|dug in|starving/i.test(ev.text) ? 6 : 1); break;
        case 'death': a.alive = false; a.death = ev.message; a.deathAt = ev.t; bump(ev.agent, 60); break;
        case 'civ': state.civ = { stage: ev.stage, name: ev.name, stages: ev.stages, next: ev.next, built: ev.built, trades: ev.trades, open: ev.open, last: ev.text || state.civ?.last || '', t: ev.t }; if (ev.text) bump(ev.agent, 8); break;
    }
    if (ev.type !== 'status') {
        events.push(ev);
        if (events.length > 500) events.shift();
    }
    broadcast(ev);
}

// auto-director: decay interest every second, cut to the most interesting living AI after the minimum hold
setInterval(() => {
    for (const a of Object.keys(interest)) interest[a] *= 0.88;
    const now = Date.now();
    const live = Object.values(state.agents).filter((a) => a.online);
    if (!live.length) return;
    const cur = state.agents[focus.agent];
    const ranked = live
        // someone in a tunnel or a hole shows the inside of the rock: anyone out in the open is better to watch
        .map((a) => ({ name: a.name, score: (interest[a.name] || 0) + (a.alive ? 0 : -1000) + (a.deathAt && now - a.deathAt < 15000 ? 2000 : 0) + (a.status?.under ? -25 : 0) }))
        .sort((x, y) => y.score - x.score);
    const best = ranked[0];
    const held = now - focus.since;
    const curScore = ranked.find((r) => r.name === focus.agent)?.score ?? -Infinity;
    const mustLeave = !cur || !cur.online || (!cur.alive && now - (cur.deathAt || 0) > 15000);
    // nobody wants to watch an AI sit in a hole: cut to one that's doing something
    const idle = (a) => !a.status || /stay|asleep|idle|^$/.test(a.status.action || '');
    // following one through a tunnel while another is out in the open: cut to the open one after a short hold
    const open = live.filter((a) => a.alive && !a.status?.under && !idle(a)).sort((x, y) => (interest[y.name] || 0) - (interest[x.name] || 0))[0];
    if (cur && cur.alive && cur.status?.under && open && open.name !== focus.agent && held > 8000) {
        focus = { agent: open.name, since: now, reason: 'out of the tunnel' };
        broadcast({ type: 'focus', t: now, ...focus });
        return;
    }
    const busy = live.filter((a) => a.alive && !idle(a)).sort((x, y) => (interest[y.name] || 0) - (interest[x.name] || 0))[0];
    if (cur && cur.alive && idle(cur) && busy && busy.name !== focus.agent && held > 12000) {
        focus = { agent: busy.name, since: now, reason: 'the other one is just waiting' };
        broadcast({ type: 'focus', t: now, ...focus });
    } else if (best.name !== focus.agent && (mustLeave || (held > MIN_DWELL_MS && best.score > curScore * 1.4 + 3))) {
        focus = { agent: best.name, since: now, reason: mustLeave ? 'previous feed ended' : 'more happening' };
        broadcast({ type: 'focus', t: now, ...focus });
    } else if (held > 45000 && best.score < 3) {
        // a slow rotation when nothing is happening, so every AI gets screen time
        const alive = live.filter((a) => a.alive).map((a) => a.name);
        const next = alive[(alive.indexOf(focus.agent) + 1) % alive.length];
        if (next && next !== focus.agent) {
            focus = { agent: next, since: now, reason: 'rotation' };
            broadcast({ type: 'focus', t: now, ...focus });
        }
    }
}, 1000).unref();

// an AI that stopped reporting is offline (its process is down)
setInterval(() => {
    for (const a of Object.values(state.agents)) if (a.online && Date.now() - a.lastSeen > 20000) a.online = false;
}, 5000).unref();

// keep event-stream connections alive through proxies
setInterval(() => { for (const res of sse) res.write(': ping\n\n'); }, 15000).unref();

function readBody(req, limit = 2 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function proxyHttp(req, res, port) {
    const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode, { ...r.headers, 'access-control-allow-origin': '*' });
        r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
}

/** The game client from the build. Hashed assets cache for a year; the pages never. */
async function servePlay(req, res, path) {
    if (path === '/play' || path === '/play/') path = '/play/index.html';
    if (path === '/play/server.json') {
        // where the game server is: this same host, /ws (wss behind Railway's https)
        const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ? 'wss' : 'ws';
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ url: `${proto}://${req.headers.host}/ws` }));
    }
    const file = normalize(join(PLAY_DIR, path.slice('/play/'.length)));
    if (!file.startsWith(PLAY_DIR)) { res.writeHead(403); return res.end(); }
    const data = await readFile(file);
    const ext = extname(file);
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-store' : /\/assets\//.test(file.replace(/\\/g, '/')) ? 'public, max-age=31536000, immutable' : 'public, max-age=300' });
    return res.end(data);
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    if (path.startsWith('/play')) {
        try { return await servePlay(req, res, path); } catch (err) {
            if (!res.headersSent) res.writeHead(err.code === 'ENOENT' ? 404 : 500);
            return res.end();
        }
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    try {
        if (req.method === 'POST' && path === '/ingest') {
            // only from inside the container (the agents): the public can't write events
            const ip = req.socket.remoteAddress || '';
            if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(ip) || req.headers['x-forwarded-for']) { res.writeHead(403); return res.end(); }
            const body = JSON.parse((await readBody(req)).toString('utf8') || '[]');
            for (const ev of Array.isArray(body) ? body : [body]) ingest(ev);
            res.writeHead(204); return res.end();
        }
        if (path === '/events') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
            sse.add(res);
            send(res, { type: 'snapshot', t: Date.now(), state, focus, events: events.slice(-120) });
            req.on('close', () => sse.delete(res));
            return;
        }
        if (path === '/usage') {
            const mins = Number(url.searchParams.get('minutes') || 10);
            const since = Date.now() - mins * 60000;
            const by = {};
            for (const r of usage) {
                if (r.t < since) continue;
                const [pi, po] = PRICE[r.model] || [0, 0];
                const b = (by[r.model] ||= { calls: 0, cost: 0 });
                b.calls++;
                b.cost += (r.in * pi + r.out * po + r.cache_read * pi * 0.1 + r.cache_write * pi * 1.25) / 1e6;
            }
            const total = Object.values(by).reduce((a, b) => a + b.cost, 0);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ minutes: mins, total, perHour: (total / mins) * 60, by }));
        }
        if (path === '/state') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ state, focus, interest, viewers: sse.size }));
        }
        if (path === '/clanker' || path === '/status' || path === '/health') return proxyHttp(req, res, GAME_PORT);
        // the site itself (www/: the page, its config and pictures)
        const file = normalize(join(WWW_DIR, path === '/' ? 'index.html' : decodeURIComponent(path)));
        if (!file.startsWith(WWW_DIR)) { res.writeHead(403); return res.end(); }
        const data = await readFile(file);
        const ext = extname(file);
        res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' || ext === '.js' ? 'no-cache' : 'public, max-age=3600' });
        return res.end(data);
    } catch (err) {
        if (!res.headersSent) res.writeHead(err.code === 'ENOENT' ? 404 : 500);
        res.end();
    }
});

// the game server's WebSocket: spectators (the /play client) come in through here
server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/ws')) return socket.destroy();
    const up = net.connect(GAME_PORT, '127.0.0.1', () => {
        const lines = [`${req.method} / HTTP/${req.httpVersion}`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        up.write(lines.join('\r\n') + '\r\n\r\n');
        if (head?.length) up.write(head);
        up.pipe(socket);
        socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
});

server.listen(PORT, () => console.log(`clankersmp relay on :${PORT} (game :${GAME_PORT}, client ${PLAY_DIR})`));
