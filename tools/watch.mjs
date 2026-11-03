// clankersmp watcher: the live game boiled down to one short report, for the self-editing loop (Claude reads it,
// looks at the live view, fixes what's off). What each AI is doing, what keeps failing, who died of what, where the
// civilization stands, and the engine log's trouble lines.
//   node tools/watch.mjs            (RELAY=... to watch another engine; NOLOGS=1 to skip the Railway log)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RELAY = process.env.RELAY || 'https://engine-production-08c9.up.railway.app';
const TRACK = join(ROOT, '.local', 'watch-track.json');
const now = Date.now();
const ago = (t) => {
  if (!t) return '?';
  const s = Math.round((now - t) / 1000);
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
};
const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');
const FAIL = /couldn|can.t|^no |nothing|still|failed|got 0 |missing|isn.t|don.t|there is no|out of|stopped|interrupted/i;
// progress isn't failure, even with "still needed" in it (a build goes up a few blocks a turn)
const PROGRESS = /^placed [1-9]|^finished|^upgraded|^got [1-9]|^crafted|^smelted|something else came up/i; // (and a job cut short by a reflex isn't a failure either)

const getJson = async (path) => (await fetch(RELAY + path, { signal: AbortSignal.timeout(10000) })).json();

/** The first frame of the event stream: the relay's state and its recent events. */
async function snapshot() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const r = await fetch(RELAY + '/events', { signal: ac.signal });
    const reader = r.body.getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      const i = buf.indexOf('\n\n');
      if (i >= 0) {
        ac.abort();
        return JSON.parse(buf.slice(0, i).replace(/^data: /, ''));
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') throw e;
  } finally {
    clearTimeout(timer);
  }
  return null;
}

const [clanker, snap] = await Promise.all([getJson('/clanker'), snapshot()]);
const state = snap?.state ?? {};
const events = snap?.events ?? [];
const out = [];
const alive = clanker.agents.filter((a) => !a.dead);
out.push(`WORLD day ${clanker.day}, time ${clanker.time} (${clanker.time >= 12500 && clanker.time < 23500 ? 'night' : clanker.time >= 11000 ? 'dusk' : 'day'}), world ${ago(clanker.started)} old, ${alive.length}/3 alive, ${clanker.watching} watching`);

const civ = state.civ;
if (civ) {
  const built = Object.entries(civ.built || {}).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ') || 'nothing';
  out.push(`CIV ${civ.name} (stage ${civ.stage + 1}/5). built: ${built}; trades ${civ.trades}. next ${civ.next ? `${civ.next.name}: ${civ.next.needs.map((n) => `${n.k} ${n.have}/${n.need}`).join(', ')}` : 'none (a city)'}${civ.open?.length ? `; half built: ${civ.open.map((o) => o.kind).join(', ')}` : ''}; last: ${civ.last || '-'} (${ago(civ.t)} ago)`);
}

// where each one stood on earlier runs: the same spot for a long time while "busy" = stuck
let track = {};
try {
  track = JSON.parse(readFileSync(TRACK, 'utf8'));
} catch {}
for (const a of clanker.agents) {
  const s = state.agents?.[a.name]?.status;
  const mine = events.filter((e) => e.agent === a.name);
  const results = mine.filter((e) => e.type === 'result').slice(-24);
  const fails = results.filter((e) => (FAIL.test(e.text) && !PROGRESS.test(e.text)));
  out.push('');
  if (a.dead) {
    out.push(`${a.name.toUpperCase()} DEAD ${ago(a.diedAt)} ago: ${a.death}`);
    const last = mine.filter((e) => e.type === 'command' || e.type === 'result' || e.type === 'reflex').slice(-6);
    for (const e of last) out.push(`  ${ago(e.t)} ${e.type}: ${clip(e.text, 160)}`);
    continue;
  }
  const pos = s?.pos ?? [a.x, a.y, a.z].map((v) => Math.round(v ?? 0));
  out.push(`${a.name.toUpperCase()} hp ${a.hp ?? s?.health} food ${a.food ?? s?.food} at ${pos.join(' ')} holding ${s?.held ?? '?'}${s?.armor?.length ? `, wearing ${s.armor.join(' ')}` : ''}; doing: ${s?.action ?? '?'}`);
  out.push(`  goal: ${clip(state.agents?.[a.name]?.goal, 160)}`);
  const hist = (track[a.name] ?? []).filter((p) => now - p.t < 30 * 60000);
  const still = hist.filter((p) => Math.hypot(p.pos[0] - pos[0], p.pos[2] - pos[2]) < 3 && Math.abs(p.pos[1] - pos[1]) < 3);
  if (still.length && now - Math.min(...still.map((p) => p.t)) > 4 * 60000 && !/asleep|bed|home/.test(s?.action ?? '')) out.push(`  !! in the same spot for ${ago(Math.min(...still.map((p) => p.t)))}`);
  track[a.name] = [...hist, { t: now, pos, action: s?.action ?? '' }].slice(-40);
  out.push(`  results: ${results.length} recent, ${fails.length} failed${results.length ? ` (${Math.round((fails.length / results.length) * 100)}%)` : ''}`);
  for (const e of results.slice(-7)) out.push(`  ${(FAIL.test(e.text) && !PROGRESS.test(e.text)) ? 'x' : '-'} ${ago(e.t)} ${clip(e.text, 170)}`);
  const reflexes = mine.filter((e) => e.type === 'reflex' && now - e.t < 20 * 60000);
  if (reflexes.length) {
    const by = {};
    for (const e of reflexes) by[e.text] = (by[e.text] || 0) + 1;
    out.push(`  reflexes (20m): ${Object.entries(by).map(([k, n]) => `${k} x${n}`).join('; ')}`);
  }
  const th = state.agents?.[a.name]?.thought;
  if (th) out.push(`  thought ${ago(th.t)} ago: ${clip(th.text, 220)}`);
  const ch = state.agents?.[a.name]?.chat;
  if (ch) out.push(`  said ${ago(ch.t)} ago: ${clip(ch.text, 200)}`);
}
mkdirSync(dirname(TRACK), { recursive: true });
writeFileSync(TRACK, JSON.stringify(track));

const plans = events.filter((e) => e.type === 'plan').slice(-3);
if (plans.length) {
  out.push('');
  for (const e of plans) out.push(`PLAN ${ago(e.t)} ago (${e.agent}): ${clip(e.text, 220)}`);
}

// the engine log: the lines that mean trouble, counted
if (!process.env.NOLOGS && existsSync(join(ROOT, 'railway.json')) !== null) {
  const r = spawnSync('railway', ['logs', '--lines', '800'], { cwd: ROOT, encoding: 'utf8', timeout: 45000, shell: true });
  const lines = (r.stdout || '').split('\n');
  const kinds = [
    ["can't reach", /can't reach/],
    ['dig stopped', /dig of .* stopped/],
    ['stepUp/dig_out stuck', /stepUp \d: |dig_out: no step/],
    ['skill threw', /skill .* failed/],
    ['errors', /error|exception|TypeError|ReferenceError/i],
    ['deaths', /\[hardcore\]/],
  ];
  out.push('');
  out.push(`LOG (last ${lines.length} lines): ${kinds.map(([k, re]) => `${k} ${lines.filter((l) => re.test(l)).length}`).join(', ')}`);
  const bad = lines.filter((l) => /skill .* failed|error|exception|\[hardcore\]/i.test(l)).slice(-6);
  for (const l of bad) out.push(`  ${clip(l.trim(), 220)}`);
  const per = {};
  for (const l of lines) {
    const m = /\[agents\] \[(\w+)\] can't reach (\w+)/.exec(l);
    if (m) per[`${m[1]} ${m[2]}`] = (per[`${m[1]} ${m[2]}`] || 0) + 1;
  }
  const top = Object.entries(per).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length) out.push(`  can't reach, most: ${top.map(([k, n]) => `${k} x${n}`).join(', ')}`);
}
console.log(out.join('\n'));
