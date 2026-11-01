// The optional origin allowlist (ALLOWED_ORIGINS): case-insensitive, trailing slash ignored, no Origin header (bots,
// native clients) allowed, and every refused origin is logged once as "[origin] refused <origin>" so a missing
// legitimate origin can be added to the list.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { normOrigin } from "../server/src/util.ts";

const PORT = 21000 + Math.floor(Math.random() * 2000);
const URL = `ws://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "steve-craft-origin-"));
let server: ChildProcess;
let out = "";

before(async () => {
  server = spawn(process.execPath, [process.env.SERVER_ENTRY || "server/src/main.ts"], {
    env: { ...process.env, MOBS: "0", PORT: String(PORT), WORLD_DIR: dir, ADMIN_SECRET: "test-admin-secret-0123456789", ALLOWED_ORIGINS: "https://www.stevepumpfun.com, https://stevepumpfun.com/" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 30000);
    server.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
      if (out.includes("game server on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.stderr!.on("data", () => {});
  });
});

after(async () => {
  await new Promise<void>((resolve) => {
    server.once("exit", () => resolve());
    server.kill("SIGTERM");
    setTimeout(() => resolve(), 3000);
  });
  rmSync(dir, { recursive: true, force: true });
});

/** Opens a WebSocket with this Origin header (or none): true when the upgrade is accepted. */
function opens(origin: string | null): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL, origin === null ? {} : { origin });
    ws.on("open", () => {
      ws.close();
      resolve(true);
    });
    ws.on("error", () => resolve(false));
    ws.on("unexpected-response", () => resolve(false));
  });
}

test("normOrigin: case-insensitive, trailing slash ignored", () => {
  assert.equal(normOrigin("https://WWW.StevePumpFun.COM/"), "https://www.stevepumpfun.com");
  assert.equal(normOrigin(" https://stevepumpfun.com "), "https://stevepumpfun.com");
});

test("listed origins pass in any case and with a trailing slash; others are refused and logged once", async () => {
  assert.equal(await opens("https://www.stevepumpfun.com"), true);
  assert.equal(await opens("https://WWW.StevePumpFun.com"), true);
  assert.equal(await opens("https://stevepumpfun.com"), true, "listed with a trailing slash, sent without");
  assert.equal(await opens(null), true, "no Origin header (not a browser): allowed");
  assert.equal(await opens("https://evil.example"), false);
  assert.equal(await opens("https://evil.example"), false);
  await new Promise((r) => setTimeout(r, 200));
  const lines = out.split("\n").filter((l) => l.includes("[origin] refused"));
  assert.equal(lines.length, 1, "logged once per minute per origin");
  assert.ok(lines[0].endsWith("[origin] refused https://evil.example"), lines[0]);
});
