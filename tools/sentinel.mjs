// clankersmp sentinel: watches the live game every few seconds and stays silent until something looks wrong, then
// prints one line about it (each kind of trouble once per agent per 10 minutes). Made to run under a monitor that
// wakes whoever is watching on every line.
//   node tools/sentinel.mjs
const RELAY = process.env.RELAY || 'https://engine-production-08c9.up.railway.app';
const FAIL = /couldn|can.t|^no |nothing|still|failed|got 0 |missing|isn.t|don.t|there is no|out of|stopped|interrupted|hole isn.t/i;
const IDLE = /asleep|bed|sleep|home|smelt|stay|wait|idle/i;
const seen = new Map(); // `${agent}:${kind}` -> last time it was reported
const track = {}; // agent -> [{t, x, y, z}]
const hpLog = {};
let wasDead = {};
let offlineSince = {};
let civ = { key: '', since: Date.now() };
let lastEvents = 0;
let downSince = 0; // a deploy restarts the game for a minute or so: only a longer outage is news
let events = [];

const say = (agent, kind, text) => {
  const k = `${agent}:${kind}`;
  if (Date.now() - (seen.get(k) || 0) < 10 * 60000) return;
  seen.set(k, Date.now());
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${kind.toUpperCase()} ${agent}: ${text}`);
};

async function snapshotEvents() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(RELAY + '/events', { signal: ac.signal });
    const reader = r.body.getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      const i = buf.indexOf('\n\n');
      if (i >= 0) { ac.abort(); return JSON.parse(buf.slice(0, i).replace(/^data: /, '')); }
    }
  } catch {} finally { clearTimeout(timer); }
  return null;
}

console.log(`[${new Date().toISOString().slice(11, 19)}] sentinel watching ${RELAY}`);
for (;;) {
  try {
    const [c, s] = await Promise.all([
      fetch(RELAY + '/clanker', { signal: AbortSignal.timeout(5000) }).then((r) => r.json()),
      fetch(RELAY + '/state', { signal: AbortSignal.timeout(5000) }).then((r) => r.json()),
    ]);
    const now = Date.now();
    if (now - lastEvents > 20000) {
      const snap = await snapshotEvents();
      if (snap) events = snap.events || [];
      lastEvents = now;
    }
    const alive = c.agents.filter((a) => !a.dead);
    if (!alive.length) say('world', 'all-dead', `all three are dead (day ${c.day}): time for a new world`);
    for (const a of c.agents) {
      const st = s.state?.agents?.[a.name];
      const action = st?.status?.action || '';
      if (a.dead) {
        if (wasDead[a.name] === false) say(a.name, 'death', `${a.death}`);
        wasDead[a.name] = true;
        continue;
      }
      wasDead[a.name] = false;
      // the body dropped off the server without dying: a crash, or a restart it didn't come back from
      if (!a.online) {
        offlineSince[a.name] ||= now;
        if (now - offlineSince[a.name] > 90000) say(a.name, 'offline', `offline for ${Math.round((now - offlineSince[a.name]) / 1000)}s but not dead`);
        continue;
      }
      offlineSince[a.name] = 0;
      const tr = (track[a.name] ||= []);
      tr.push({ t: now, x: a.x, y: a.y, z: a.z });
      while (tr.length && now - tr[0].t > 5 * 60000) tr.shift();
      // stuck: hardly moved in 3 minutes while supposedly busy
      const old = tr.find((p) => now - p.t >= 3 * 60000);
      if (old) {
        const moved = Math.max(...tr.filter((p) => p.t >= old.t).map((p) => Math.hypot(p.x - old.x, p.z - old.z)));
        if (moved < 2.5 && !IDLE.test(action)) say(a.name, 'stuck', `within 2.5 blocks of x=${Math.round(a.x)} y=${Math.round(a.y)} z=${Math.round(a.z)} for 3+ min while "${action}"`);
      }
      // bouncing: lots of up and down and walking, little net progress, over the last minute
      const min = tr.filter((p) => now - p.t <= 60000);
      if (min.length > 12) {
        let jumps = 0, walked = 0, rising = false;
        for (let i = 1; i < min.length; i++) {
          walked += Math.hypot(min[i].x - min[i - 1].x, min[i].z - min[i - 1].z);
          if (min[i].y - min[i - 1].y > 0.4 && !rising) { jumps++; rising = true; }
          if (min[i].y <= min[i - 1].y) rising = false;
        }
        const net = Math.hypot(min.at(-1).x - min[0].x, min.at(-1).z - min[0].z);
        if (jumps >= 10 && net < 6) say(a.name, 'bouncing', `${jumps} jumps and ${walked.toFixed(0)} blocks walked in a minute but only ${net.toFixed(1)} blocks of progress, "${action}"`);
        if (walked > 25 && net < 3) say(a.name, 'pacing', `walked ${walked.toFixed(0)} blocks in a minute and ended ${net.toFixed(1)} from where it started, "${action}"`);
      }
      // hurt fast
      const h = (hpLog[a.name] ||= []);
      h.push({ t: now, hp: a.hp });
      while (h.length && now - h[0].t > 15000) h.shift();
      const top = Math.max(...h.map((p) => p.hp));
      if (top - a.hp >= 8) say(a.name, 'hurt', `lost ${top - a.hp} health in 15s (now ${a.hp}), "${action}"`);
      // the same thing failing over and over
      const res = events.filter((e) => e.agent === a.name && e.type === 'result').slice(-8);
      const fails = res.filter((e) => FAIL.test(e.text));
      if (res.length >= 6 && fails.length >= 5) say(a.name, 'failing', `${fails.length} of its last ${res.length} actions failed; latest: ${fails.at(-1).text.slice(0, 160)}`);
      const last3 = res.slice(-3).map((e) => e.text.replace(/\d+/g, '#'));
      if (last3.length === 3 && last3.every((t) => t === last3[0]) && FAIL.test(last3[0])) say(a.name, 'repeat', `the same failure 3 times running: ${res.at(-1).text.slice(0, 160)}`);
    }
    // the town not growing for a long while (only counts when someone is alive)
    const cv = s.state?.civ;
    if (cv && alive.length) {
      const key = JSON.stringify(cv.built || {}) + cv.trades;
      if (key !== civ.key) civ = { key, since: now };
      else if (now - civ.since > 25 * 60000) say('world', 'no-progress', `the civilization hasn't changed in ${Math.round((now - civ.since) / 60000)} min (${cv.name}; next: ${cv.next ? cv.next.needs.map((n) => `${n.k} ${n.have}/${n.need}`).join(', ') : 'none'})`);
    }
    downSince = 0;
  } catch (e) {
    downSince ||= Date.now();
    if (Date.now() - downSince > 120000) say('world', 'unreachable', `can't read the live game for ${Math.round((Date.now() - downSince) / 1000)}s: ${String(e).slice(0, 120)}`);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
