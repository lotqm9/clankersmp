// Browser check of proximity voice chat (update 13, protocol v11) in real headless Chrome with a fake microphone
// (Chrome's test tone), two players against a local server with DEV_COMMANDS=1: no microphone is asked for until
// voice is turned on; then it is asked for once; holding V sends Opus frames through the server; the other player
// hears them (decoded, queued and played through an HRTF panner that fades out by 28 blocks), sees the speaking icon
// over the talker's head and in the player list, and the mic pill shows "Talking"; letting go stops it; out of range
// nothing comes; a muted player is silent (and saved by name); "hear voice chat" off stops it all; open mic sends
// while the tone plays; a listener who can only play the fallback gets ADPCM frames it plays; bandwidth per
// listener; no page errors.
// Usage: node tools/voice-check.cjs <site-url> <server-ws>      (PASS/FAIL lines; exit code 1 on any failure)
const PW = process.env.PLAYWRIGHT || "C:/Users/vincu/Desktop/memecoin/sites/evolve/node_modules/playwright";
const { chromium } = require(PW);
const site = (process.argv[2] || "http://127.0.0.1:5300").replace(/\/$/, "");
const server = process.argv[3] || "ws://127.0.0.1:8797";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
let passed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (ok) passed++;
  else failed++;
};

async function player(browser, errors) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 }, permissions: ["microphone"] });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.__mic = 0;
    const md = navigator.mediaDevices;
    if (md && md.getUserMedia) {
      const f = md.getUserMedia.bind(md);
      md.getUserMedia = (c) => {
        window.__mic++;
        return f(c);
      };
    }
  });
  await page.goto(`${site}/play/?server=${encodeURIComponent(server)}`);
  for (let i = 0; i < 240; i++) {
    if ((await page.evaluate(() => window.__game && window.__game.state).catch(() => "")) === "play") break;
    await sleep(250);
  }
  const g = (fn, arg) => page.evaluate(fn, arg);
  await g(() => {
    const w = window.__game;
    window.__codecs = [];
    const f = w.voice.onFrames.bind(w.voice);
    w.voice.onFrames = (fr) => {
      for (const x of fr) window.__codecs.push(x.codec);
      f(fr);
    };
    w.unlockAudio();
  });
  return { page, g, chat: async (t) => { await g((t) => window.__game.net.send({ t: "chat", text: t }), t); await sleep(300); } };
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  const errors = [];
  const A = await player(browser, errors);
  const B = await player(browser, errors);
  const aId = await A.g(() => window.__game.myId);
  const aName = await A.g(() => window.__game.myName);
  const sh = await A.g(() => window.__game.info.spawnHeight);
  check((await A.g(() => window.__game.state)) === "play" && (await B.g(() => window.__game.state)) === "play", "both players joined (protocol 11)");
  check((await A.g(() => window.__game.voice.serverOn)) === true, "the server allows voice chat");
  await A.chat("/gamemode creative");
  await B.chat("/gamemode creative");
  await A.chat(`/tp 256.5 ${sh + 1} 290.5`);
  await B.chat(`/tp 262.5 ${sh + 1} 290.5`);
  await sleep(1200);
  check((await A.g(() => window.__mic)) === 0 && (await A.g(() => window.__game.voice.mic)) === "off", "no microphone is asked for until voice is turned on");
  check((await A.g(() => document.querySelector(".voicepill").classList.contains("hidden"))) === true, "no mic pill while voice is off");
  // turn voice on, the way the Options screen does
  const on = await A.g(() => window.__game.ui.actions.voiceMic(true));
  check(on === true && (await A.g(() => window.__mic)) === 1, "turning voice on asks for the microphone, once");
  check((await A.g(() => window.__game.voice.canEncodeOpus && window.__game.voice.canDecodeOpus)) === true, "this browser speaks Opus (WebCodecs)");
  await sleep(400);
  check(/Hold V to talk/.test(await A.g(() => document.querySelector(".voicepill").textContent)), "the mic pill says: Hold V to talk");
  // hold V for 1.5 s
  await A.g(() => window.__game.keys.add("KeyV"));
  await sleep(700);
  check((await A.g(() => window.__game.voice.transmitting)) === true, "holding V sends");
  check(/Talking/.test(await A.g(() => document.querySelector(".voicepill").textContent)), "and the pill says Talking");
  const in0 = await B.g(() => window.__game.net.bytesIn);
  const t0 = Date.now();
  await sleep(1000);
  const in1 = await B.g(() => window.__game.net.bytesIn);
  const kbps = ((in1 - in0) / 1024 / ((Date.now() - t0) / 1000)).toFixed(1);
  const heardB = await B.g((id) => { const v = window.__game.voice; const s = v.streams.get(id); return { heard: v.stats.framesHeard, played: v.stats.played, errs: v.stats.decodeErrors, stream: !!s, model: s && s.panner.panningModel, dist: s && s.panner.distanceModel, max: s && s.panner.maxDistance, codecs: [...new Set(window.__codecs)] }; }, aId);
  check(heardB.heard >= 15 && heardB.played >= 10 && heardB.errs === 0, `the other player hears it: ${heardB.heard} frames, ${heardB.played} played, ${heardB.errs} decode errors`);
  check(heardB.codecs.length === 1 && heardB.codecs[0] === 1, "as Opus");
  const peakOpus = await B.g(() => window.__game.voice.stats.peak);
  check(peakOpus > 0.02, `and it carries the sound (the fake microphone's tone: peak ${peakOpus.toFixed(3)})`);
  check(heardB.stream && heardB.model === "HRTF" && heardB.dist === "linear" && heardB.max === 28, "from the talker's head, panned in 3D, fading out by 28 blocks");
  check(await B.g((id) => { const o = window.__game.others.get(id); return !!o && o.talking && o.talkIcon.visible; }, aId), "the speaking icon shows over the talker's head");
  await B.g(() => (window.__game.tabHeld = true));
  await sleep(300);
  check(await B.g((n) => [...document.querySelectorAll(".tablist .grid div")].some((d) => d.textContent === n && d.classList.contains("talking")), aName), "and in the player list");
  await B.g(() => (window.__game.tabHeld = false));
  console.log(`  (voice to one listener: ${kbps} KB/s with everything else)`);
  await A.g(() => window.__game.keys.delete("KeyV"));
  await sleep(1200);
  check((await A.g(() => window.__game.voice.transmitting)) === false && (await B.g((id) => !window.__game.voice.talking.has(id), aId)), "letting go of V stops it (and the icon goes)");
  // out of range: nothing
  await B.chat(`/tp 256.5 ${sh + 1} 335.5`);
  await sleep(800);
  let h0 = await B.g(() => window.__game.voice.stats.framesHeard);
  await A.g(() => window.__game.keys.add("KeyV"));
  await sleep(1000);
  await A.g(() => window.__game.keys.delete("KeyV"));
  await sleep(500);
  check((await B.g(() => window.__game.voice.stats.framesHeard)) === h0, "45 blocks away: nothing comes");
  await B.chat(`/tp 262.5 ${sh + 1} 290.5`);
  await sleep(800);
  // mute the talker (saved by name)
  await B.g((n) => window.__game.ui.actions.voiceMute(n, true), aName);
  await sleep(300);
  h0 = await B.g(() => window.__game.voice.stats.framesHeard);
  await A.g(() => window.__game.keys.add("KeyV"));
  await sleep(1000);
  check((await B.g(() => window.__game.voice.stats.framesHeard)) === h0, "a muted player is silent");
  check(await B.g((n) => JSON.parse(localStorage.getItem("steve_craft_settings")).voiceMuted.includes(n), aName), "and the mute is saved by name");
  check(await B.g((id) => !window.__game.others.get(id).talkIcon.visible, aId), "no speaking icon for a muted player");
  await B.g((n) => window.__game.ui.actions.voiceMute(n, false), aName);
  await sleep(600);
  check((await B.g(() => window.__game.voice.stats.framesHeard)) > h0, "unmuted: heard again");
  // hear voice chat: off
  await B.g(() => { const w = window.__game; w.settings.voiceHear = false; w.applySettings(w.settings); });
  await sleep(300);
  h0 = await B.g(() => window.__game.voice.stats.framesHeard);
  await sleep(800);
  check((await B.g(() => window.__game.voice.stats.framesHeard)) === h0, '"hear voice chat" off: nothing comes');
  await B.g(() => { const w = window.__game; w.settings.voiceHear = true; w.applySettings(w.settings); });
  await A.g(() => window.__game.keys.delete("KeyV"));
  await sleep(800);
  // open mic: the fake microphone's tone keeps it sending
  await A.g(() => { const w = window.__game; w.settings.voiceOpenMic = true; w.applySettings(w.settings); });
  await sleep(1000);
  check((await A.g(() => window.__game.voice.transmitting)) === true && /Open mic|Talking/.test(await A.g(() => document.querySelector(".voicepill").textContent)), "open mic sends while there is sound");
  // a listener who can only play the fallback: the talker switches to ADPCM and it plays
  await B.g(() => { const v = window.__game.voice; v.canDecodeOpus = false; v.syncState(); window.__codecs.length = 0; });
  await sleep(2500);
  const fb = await B.g(() => ({ codecs: [...new Set(window.__codecs)], played: window.__game.voice.stats.played }));
  check(fb.codecs.includes(2) && !fb.codecs.slice(-1).includes(1), `a fallback listener gets ADPCM (codecs seen: ${fb.codecs.join(",")})`);
  const p0 = fb.played;
  await sleep(600);
  check((await B.g(() => window.__game.voice.stats.played)) > p0, "and plays it");
  const peakAdpcm = await B.g(() => window.__game.voice.stats.peak);
  check(peakAdpcm > 0.02, `with the sound in it (peak ${peakAdpcm.toFixed(3)})`);
  check((await A.g(() => window.__game.voice.adpcmHint)) === true, "(the server told the talker to switch)");
  await A.g(() => { const w = window.__game; w.settings.voiceOpenMic = false; w.applySettings(w.settings); w.voice.disableMic(); });
  await sleep(600);
  check((await A.g(() => window.__game.voice.mic)) === "off" && (await A.g(() => document.querySelector(".voicepill").classList.contains("hidden"))), "voice off again: the mic is let go");
  check(errors.length === 0, `no page errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
  console.log(`${passed} passed, ${failed} failed`);
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
