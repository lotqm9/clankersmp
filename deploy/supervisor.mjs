// clankersmp engine container: the game server, the relay (the one public door) and the three AIs, each restarted
// with a backoff whenever it exits. The world lives on the /data volume; the AIs' secret is made fresh each boot
// (only these processes ever need it).
//   ANTHROPIC_API_KEY=... node deploy/supervisor.mjs          AGENTS_PAUSED=1: the world runs, nobody plays
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR || '/data';
const WORLD_DIR = join(DATA, 'engine');
const GAME_PORT = 8787;
const PUBLIC_PORT = Number(process.env.PORT || 8080);
const SECRET = process.env.AGENT_SECRET || randomBytes(24).toString('hex');
// A fresh world on demand: set RESET_WORLD to a new value and redeploy. The first boot with that value moves the old
// world aside (kept, never deleted); later restarts with the same value leave the new world alone.
const reset = (process.env.RESET_WORLD || '').replace(/[^\w-]/g, '');
if (reset && !existsSync(join(DATA, `.reset-${reset}`))) {
    if (existsSync(WORLD_DIR)) renameSync(WORLD_DIR, join(DATA, `engine-archive-${new Date().toISOString().replace(/[:.]/g, '-')}`));
    writeFileSync(join(DATA, `.reset-${reset}`), new Date().toISOString());
    process.stdout.write(`[supervisor] RESET_WORLD=${reset}: the old world was moved aside, a new one starts\n`);
}
mkdirSync(WORLD_DIR, { recursive: true });

const log = (name, line) => process.stdout.write(`[${name}] ${line}\n`);
const children = new Map(); // name -> the running process
let stopping = false;

function run(name, args, env, minUptimeMs = 30000) {
    let backoff = 2000;
    const start = () => {
        const t0 = Date.now();
        const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        children.set(name, child);
        const pipe = (s) => {
            let buf = '';
            s.on('data', (d) => {
                buf += d.toString();
                const lines = buf.split(/\r?\n/);
                buf = lines.pop();
                for (const l of lines) if (l.trim()) log(name, l);
            });
        };
        pipe(child.stdout);
        pipe(child.stderr);
        child.on('exit', (code, sig) => {
            children.delete(name);
            if (stopping) return;
            const up = Date.now() - t0;
            backoff = up > minUptimeMs ? 2000 : Math.min(60000, backoff * 2);
            log('supervisor', `${name} exited (${code ?? sig}) after ${Math.round(up / 1000)}s, restarting in ${backoff / 1000}s`);
            setTimeout(start, backoff);
        });
    };
    start();
}

async function gameUp() {
    for (;;) {
        try {
            const r = await fetch(`http://127.0.0.1:${GAME_PORT}/clanker`, { signal: AbortSignal.timeout(2000) });
            if (r.ok) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 1000));
    }
}

run('game', ['server/src/main.ts'], {
    PORT: String(GAME_PORT), CLANKER: '1', HARDCORE: '1', SAFE_ZONE: '0', VOICE_OFF: '1',
    SURVIVAL_WORLD_DIR: WORLD_DIR, AGENT_SECRET: SECRET, TRUST_PROXY: '1', MAX_SPECTATORS: process.env.MAX_SPECTATORS || '400',
});
run('relay', ['relay/server.mjs'], { PORT: String(PUBLIC_PORT), GAME_PORT: String(GAME_PORT), PLAY_DIR: join(ROOT, 'dist-play') });

if (process.env.AGENTS_PAUSED === '1') log('supervisor', 'AGENTS_PAUSED=1: the world runs without the AIs');
else if (!process.env.ANTHROPIC_API_KEY) log('supervisor', 'no ANTHROPIC_API_KEY: the AIs stay off');
else {
    await gameUp();
    run('agents', ['agents/run.ts', `ws://127.0.0.1:${GAME_PORT}`], { AGENT_SECRET: SECRET, CLANKER_RELAY: `http://127.0.0.1:${PUBLIC_PORT}`, AGENT_STATE_DIR: join(WORLD_DIR, 'agents') });
}

// A redeploy stops the container: the AIs go first (their bodies leave, and leaving saves where they are), then the
// game server saves the world and everyone's place in it, then the relay. Nothing is cut off mid-save.
async function stopAll() {
    if (stopping) return;
    stopping = true;
    for (const name of ['agents', 'game', 'relay']) {
        const c = children.get(name);
        if (!c) continue;
        log('supervisor', `stopping ${name}`);
        const gone = new Promise((r) => c.once('exit', r));
        c.kill('SIGTERM');
        await Promise.race([gone, new Promise((r) => setTimeout(r, 6000))]);
    }
    process.exit(0);
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => void stopAll());
