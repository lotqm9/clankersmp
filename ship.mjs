// Ships $STEVE Craft survival: the game server to Railway (project/service "steve-game", same URL, same volume) and
// the client to www.stevepumpfun.com/play (Vercel project "stevepumpfun"). Run by main / Laith:
//
//   node "C:/Users/vincu/Desktop/memecoin/sites/steve-survival/ship.mjs"             ship it
//   node "C:/Users/vincu/Desktop/memecoin/sites/steve-survival/ship.mjs" --rollback  back to the builder (protocol 4)
//
// Ship: 1) rebuild the server bundle and the client (into sites/steve/play, play/server.json kept) and check them,
// 2) link server/ to Railway steve-game (the same ids sites/steve-game/server is linked with) and `railway up --ci`,
// 3) `vercel deploy --prod --yes` in sites/steve, 4) wait until /status says stevecraft protocol 12, then fetch the live
// /play and check it serves this build. Nothing secret is printed: variables are checked by name only.
//
// The old builder world stays on the volume (/data/shard-1); the survival world lives in /data/survival (Dockerfile).
import { execSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITES = join(HERE, "..");
const SERVER_DIR = join(HERE, "server");
const SITE_DIR = join(SITES, "steve");
const PLAY_DIR = join(SITE_DIR, "play");
const BUILDER_SERVER_DIR = join(SITES, "steve-game", "server");
const BUILDER_PLAY_BACKUP = join(HERE, ".local", "play-builder-backup");
const STATUS = "https://steve-game-production.up.railway.app/status";
const LIVE_PLAY = "https://www.stevepumpfun.com/play/";
const PROTOCOL = 12;
const GAME = "stevecraft";

const run = (cmd, cwd, { quiet = false } = {}) => {
  console.log(`\n> ${cmd}   (in ${cwd})`);
  const out = execSync(cmd, { cwd, encoding: "utf8", stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit", shell: true });
  return out ?? "";
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error(`\nSTOPPED: ${msg}`);
  process.exit(1);
};

// steve-game on the lotqm9 Railway account; used when a `railway logout` has wiped the CLI's link map
const STEVE_GAME_IDS = {
  name: "steve-game",
  project: "12d691a7-7031-426d-9123-e7ae4ad25d4d",
  environment: "c5d0b1b8-c7f9-459b-bdb7-bbd363a17039",
  service: "865cae74-dac5-4186-8ef0-552aa6d134de",
};

/** The Railway ids sites/steve-game/server is linked with (from the CLI's own config; the token is never read out). */
function builderLink() {
  const cfg = JSON.parse(readFileSync(join(homedir(), ".railway", "config.json"), "utf8"));
  const want = BUILDER_SERVER_DIR.replace(/\//g, "\\").toLowerCase();
  const entry = Object.entries(cfg.projects ?? {}).find(([k]) => k.replace(/\//g, "\\").toLowerCase() === want)?.[1];
  if (!entry) return STEVE_GAME_IDS;
  if (!entry.project || !entry.service || !entry.environment) fail(`${BUILDER_SERVER_DIR} is not linked to Railway (run \`railway link\` there for steve-game)`);
  if (entry.name !== "steve-game") fail(`sites/steve-game/server is linked to "${entry.name}", not steve-game`);
  return entry;
}

/** Variable names on the linked service (values are never printed). */
function variableNames(cwd) {
  const out = execSync("railway variables --kv", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true });
  const names = new Map();
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) names.set(m[1], m[2]);
  }
  return names;
}

function liveScript(html) {
  return (html.match(/\/play\/assets\/index-[\w-]+\.js/) || [])[0] ?? null;
}

async function waitForStatus(want, minutes) {
  const until = Date.now() + minutes * 60_000;
  let last = "";
  while (Date.now() < until) {
    try {
      const j = await fetch(STATUS, { cache: "no-store" }).then((r) => r.json());
      last = `game ${j.game ?? "(none)"}, protocol ${j.protocol}`;
      if (want(j)) return j;
    } catch (e) {
      last = String(e.message ?? e);
    }
    process.stdout.write(`  /status: ${last}\n`);
    await sleep(10_000);
  }
  return null;
}

async function checkLivePlay(expectScript) {
  for (let i = 0; i < 18; i++) {
    try {
      const html = await fetch(LIVE_PLAY + `?v=${Date.now()}`, { cache: "no-store" }).then((r) => r.text());
      const got = liveScript(html);
      if (!expectScript || got === expectScript) {
        const sj = await fetch(LIVE_PLAY + "server.json", { cache: "no-store" }).then((r) => r.text());
        console.log(`\nlive /play serves ${got} (title: ${(html.match(/<title>([^<]*)/) || [])[1]}); server.json: ${sj.trim()}`);
        return true;
      }
      console.log(`  live /play still serves ${got}, waiting for ${expectScript}`);
    } catch (e) {
      console.log(`  live /play: ${e.message ?? e}`);
    }
    await sleep(10_000);
  }
  return false;
}

function printRollback() {
  console.log(`
ROLLBACK to the builder ($STEVE Craft protocol 4; its world on /data/shard-1 was never touched):
  node "${join(HERE, "ship.mjs").replace(/\\/g, "/")}" --rollback
or by hand:
  1. server: cd "${BUILDER_SERVER_DIR.replace(/\\/g, "/")}" && railway up --ci
     (sites/steve-game/server/dist/server.mjs, protocol 4, WORLD_DIR=/data)
  2. site:   restore the builder client into sites/steve/play from
     "${BUILDER_PLAY_BACKUP.replace(/\\/g, "/")}" (keep play/server.json), or rebuild it with
     \`node node_modules/vite/bin/vite.js build client\` in sites/steve-game, then
     cd "${SITE_DIR.replace(/\\/g, "/")}" && vercel deploy --prod --yes`);
}

// ------------------------------------------------------------------ rollback
if (process.argv.includes("--rollback")) {
  if (!existsSync(join(BUILDER_PLAY_BACKUP, "index.html"))) fail(`no builder backup at ${BUILDER_PLAY_BACKUP}`);
  // server first: the builder answers the survival page's hello with "updated", and that page waits ("starting soon")
  run("railway up --ci", BUILDER_SERVER_DIR);
  const serverJson = readFileSync(join(PLAY_DIR, "server.json"), "utf8");
  rmSync(PLAY_DIR, { recursive: true, force: true });
  cpSync(BUILDER_PLAY_BACKUP, PLAY_DIR, { recursive: true });
  writeFileSync(join(PLAY_DIR, "server.json"), serverJson); // keep whatever server.json the site has now
  run("vercel deploy --prod --yes", SITE_DIR);
  const j = await waitForStatus((s) => s.protocol === 4, 10);
  console.log(j ? `\nROLLED BACK: /status protocol ${j.protocol}.` : "\n/status did not show protocol 4 within 10 minutes: check `railway logs` in sites/steve-game/server.");
  await checkLivePlay(liveScript(readFileSync(join(BUILDER_PLAY_BACKUP, "index.html"), "utf8")));
  process.exit(0);
}

// ------------------------------------------------------------------ 1. build and check
const serverJsonBefore = existsSync(join(PLAY_DIR, "server.json")) ? readFileSync(join(PLAY_DIR, "server.json"), "utf8") : null;
run("npm run build:server", HERE);
run("npm run build:client", HERE);
const serverJsonAfter = readFileSync(join(PLAY_DIR, "server.json"), "utf8");
if (serverJsonBefore !== null && serverJsonBefore !== serverJsonAfter) fail("play/server.json changed in the build");
if (!/steve-game-production\.up\.railway\.app/.test(serverJsonAfter)) fail(`play/server.json does not point at the steve-game server: ${serverJsonAfter.trim()}`);
const bundle = readFileSync(join(SERVER_DIR, "dist", "server.mjs"), "utf8");
if (/givepixel/i.test(bundle)) fail("the server bundle mentions givepixel");
if (!bundle.includes(`"${GAME}"`)) fail("the server bundle does not speak the stevecraft protocol");
const grepDir = (dir) => {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    if (f.isDirectory()) grepDir(p);
    else if (/\.(js|css|html|json)$/.test(f.name) && /givepixel/i.test(readFileSync(p, "utf8"))) fail(`${p} mentions givepixel`);
  }
};
grepDir(PLAY_DIR);
const newScript = liveScript(readFileSync(join(PLAY_DIR, "index.html"), "utf8"));
console.log(`\nbuilt: server bundle ${Math.round(bundle.length / 1024)} KB, client ${newScript}; server.json kept; no givepixel anywhere.`);

// ------------------------------------------------------------------ 2. server -> Railway steve-game
const link = builderLink();
run(`railway link --project ${link.project} --environment ${link.environment} --service ${link.service}`, SERVER_DIR, { quiet: true });
const vars = variableNames(SERVER_DIR);
if (!vars.has("ADMIN_SECRET")) fail("the steve-game service has no ADMIN_SECRET variable");
const swd = vars.get("SURVIVAL_WORLD_DIR");
if (swd !== undefined && !swd.startsWith("/data/survival")) fail(`SURVIVAL_WORLD_DIR is set on Railway to something else; the survival world must not share the builder's dir`);
console.log(`variables (names only): ${[...vars.keys()].filter((k) => !k.startsWith("RAILWAY_")).sort().join(", ")}`);
console.log(`charity: ${vars.get("COIN_CA") || vars.get("STEVE_CA") ? "a coin CA is set (live meter)" : "no coin CA (prelaunch)"}`);
run("railway up --ci", SERVER_DIR);

// ------------------------------------------------------------------ 3. site -> Vercel stevepumpfun
run("vercel deploy --prod --yes", SITE_DIR);

// ------------------------------------------------------------------ 4. wait and check
console.log(`\nwaiting for ${STATUS} to say ${GAME} protocol ${PROTOCOL} ...`);
const st = await waitForStatus((j) => j.game === GAME && j.protocol === PROTOCOL, 10);
if (!st) {
  console.log(`\n/status did not show ${GAME} ${PROTOCOL} within 10 minutes: check \`railway logs\` in ${SERVER_DIR}.`);
  printRollback();
  process.exit(1);
}
console.log(`\nserver: ${st.game} protocol ${st.protocol}, worldgen ${st.worldgen}, villages ${JSON.stringify(st.villages)}, voice ${st.voice?.on ? "on" : "off"}, charity ${st.charity?.state}`);
const ok = await checkLivePlay(newScript);
console.log(ok ? "\nSHIPPED: www.stevepumpfun.com/play is $STEVE Craft survival." : "\nThe live /play did not show the new build within 3 minutes (CDN?). Check it by hand.");
printRollback();
