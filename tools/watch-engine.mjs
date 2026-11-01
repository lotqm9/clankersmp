// clankersmp watcher (own engine): one line per thing worth knowing, from the relay's event stream, and a summary
// every 5 minutes (who is alive, how they're doing, what Claude cost).
//   RELAY=https://engine-production-08c9.up.railway.app node tools/watch-engine.mjs
const RELAY = process.env.RELAY || 'http://127.0.0.1:8090';
const hhmm = () => new Date().toTimeString().slice(0, 8);
const say = (s) => console.log(`${hhmm()} ${s}`);
const lastAct = {};

async function stream() {
    for (;;) {
        try {
            const res = await fetch(`${RELAY}/events`);
            const reader = res.body.getReader();
            const dec = new TextDecoder();
            let buf = '';
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                let i;
                while ((i = buf.indexOf('\n\n')) >= 0) {
                    const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
                    buf = buf.slice(i + 2);
                    if (line) onEvent(JSON.parse(line.slice(6)));
                }
            }
        } catch {
            say('RELAY unreachable, retrying');
        }
        await new Promise((r) => setTimeout(r, 5000));
    }
}

function onEvent(ev) {
    if (ev.type === 'snapshot' || ev.type === 'status' || ev.type === 'thought' || ev.type === 'focus') return;
    if (ev.type === 'command' || ev.type === 'result') { lastAct[ev.agent] = Date.now(); return; }
    if (ev.type === 'death') say(`DEATH ${ev.message}`);
    else if (ev.type === 'chat') say(`CHAT ${ev.agent}: ${ev.text}`);
    else if (ev.type === 'reflex') say(`REFLEX ${ev.agent}: ${ev.text}`);
    else if (ev.type === 'refusal') say(`REFUSAL ${ev.agent} (${ev.category})`);
    else if (ev.type === 'spawn') say(`JOIN ${ev.agent}`);
}

async function summary() {
    try {
        const [c, u] = await Promise.all([fetch(`${RELAY}/clanker`).then((r) => r.json()), fetch(`${RELAY}/usage?minutes=5`).then((r) => r.json())]);
        const who = c.agents.map((a) => (a.dead ? `${a.name} dead` : a.online ? `${a.name} hp ${Math.round(a.hp)} food ${a.food}${Date.now() - (lastAct[a.name] || 0) > 120000 ? ' (no decision for 2 min)' : ''}` : `${a.name} offline`));
        say(`SUMMARY day ${c.day} time ${c.time}, ${who.join(', ')}, watching ${c.watching}, Claude ~$${u.perHour.toFixed(2)}/hr`);
    } catch {
        say('SUMMARY unavailable');
    }
}
setInterval(summary, 300000);
setTimeout(summary, 5000);
process.on('unhandledRejection', () => {});
stream();
