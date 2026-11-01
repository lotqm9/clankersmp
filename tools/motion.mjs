// clankersmp: how the bodies actually move, measured. Samples every AI's position 4x a second for N seconds and reports,
// per AI: jumps, time standing still, back-and-forth turns, how far it really got vs how far it walked, and what it was
// doing meanwhile. "Aimless" shows up as lots of walking, little net progress, many reversals and jumps.
//   node tools/motion.mjs [seconds=60]
const RELAY = process.env.RELAY || 'https://engine-production-08c9.up.railway.app';
const secs = Number(process.argv[2] || 60);
const tracks = {};
const actions = {};
const t0 = Date.now();
while (Date.now() - t0 < secs * 1000) {
  try {
    const [c, s] = await Promise.all([
      fetch(RELAY + '/clanker', { signal: AbortSignal.timeout(2000) }).then((r) => r.json()),
      fetch(RELAY + '/state', { signal: AbortSignal.timeout(2000) }).then((r) => r.json()),
    ]);
    for (const a of c.agents) {
      if (a.dead || a.x === undefined) continue;
      (tracks[a.name] ||= []).push({ t: Date.now(), x: a.x, y: a.y, z: a.z });
      const act = s.state?.agents?.[a.name]?.status?.action || '?';
      (actions[a.name] ||= {})[act] = ((actions[a.name] ||= {})[act] || 0) + 1;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 250));
}
for (const [name, tr] of Object.entries(tracks)) {
  let walked = 0, jumps = 0, still = 0, reversals = 0, lastDir = null, rising = false;
  for (let i = 1; i < tr.length; i++) {
    const a = tr[i - 1], b = tr[i];
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    walked += d;
    if (d < 0.05) still++;
    if (b.y - a.y > 0.3 && !rising) { jumps++; rising = true; }
    if (b.y <= a.y) rising = false;
    if (d > 0.15) {
      const dir = Math.atan2(b.z - a.z, b.x - a.x);
      if (lastDir !== null) {
        let diff = Math.abs(dir - lastDir);
        if (diff > Math.PI) diff = 2 * Math.PI - diff;
        if (diff > 2.2) reversals++;
      }
      lastDir = dir;
    }
  }
  const net = Math.hypot(tr.at(-1).x - tr[0].x, tr.at(-1).z - tr[0].z);
  const top = Object.entries(actions[name]).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} ${Math.round((n / tr.length) * 100)}%`).join(', ');
  console.log(`${name}: ${tr.length} samples, walked ${walked.toFixed(1)} blocks, got ${net.toFixed(1)} from start (${walked ? Math.round((net / walked) * 100) : 0}% straight), ${jumps} jumps, still ${Math.round((still / tr.length) * 100)}% of the time, ${reversals} sharp turns back`);
  console.log(`  doing: ${top}`);
}
