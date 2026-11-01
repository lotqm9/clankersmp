// Vite plugins for the $STEVE Craft game client.
//
// updatesPlugin: "what's new" entries live in updates/NNNN-slug.json (+ its screenshot NNNN-slug.jpg|png):
//   { "n": 1, "date": "2026-10-30", "title": "Now survival", "line": "One sentence.", "image": "0001-survival.jpg" }
// They are validated at build time and exposed to the game as `virtual:updates` (the toast shown once on joining,
// and the Updates House board in the hub); the images ship as play/updates/img/<file>.
// keepServerJson: play/server.json (the live game server URL) is never overwritten by a build.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

export interface Update {
  n: number;
  date: string; // YYYY-MM-DD
  title: string;
  line: string;
  image: string; // file name next to the JSON
}

export function readUpdates(dir: string): Update[] {
  if (!existsSync(dir)) return [];
  const out: Update[] = [];
  for (const f of readdirSync(dir).filter((f) => /^\d{4}-[a-z0-9-]+\.json$/.test(f))) {
    const u = JSON.parse(readFileSync(join(dir, f), "utf8")) as Update;
    const where = `updates/${f}`;
    if (!Number.isInteger(u.n) || u.n < 1) throw new Error(`${where}: "n" must be a positive integer`);
    if (Number(f.slice(0, 4)) !== u.n) throw new Error(`${where}: file number and "n" differ`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(u.date ?? "")) throw new Error(`${where}: "date" must be YYYY-MM-DD`);
    if (!u.title || u.title.length > 60) throw new Error(`${where}: "title" is required (60 characters max)`);
    if (!u.line || u.line.length > 160) throw new Error(`${where}: "line" is required (160 characters max)`);
    if (!u.image || !existsSync(join(dir, u.image))) throw new Error(`${where}: screenshot "${u.image}" not found`);
    out.push({ n: u.n, date: u.date, title: u.title, line: u.line, image: u.image });
  }
  out.sort((a, b) => b.n - a.n);
  const seen = new Set<number>();
  for (const u of out) {
    if (seen.has(u.n)) throw new Error(`updates: two entries are number ${u.n}`);
    seen.add(u.n);
  }
  return out;
}

const IMG_PATH = "/play/updates/img/";

export function updatesPlugin(dir: string): Plugin {
  const VIRTUAL = "virtual:updates";
  let list: Update[] = [];
  const load = () => (list = readUpdates(dir));
  return {
    name: "steve-craft-updates",
    buildStart() {
      load();
      this.addWatchFile(dir);
    },
    resolveId(id) {
      return id === VIRTUAL ? "\0" + VIRTUAL : null;
    },
    load(id) {
      if (id !== "\0" + VIRTUAL) return null;
      load();
      const pub = list.map((u) => ({ n: u.n, date: u.date, title: u.title, line: u.line, image: IMG_PATH + u.image }));
      return `export default ${JSON.stringify(pub)};`;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];
        const m = url.match(/^\/play\/updates\/img\/([\w.-]+)$/);
        if (m && existsSync(join(dir, m[1]))) {
          res.setHeader("content-type", m[1].endsWith(".png") ? "image/png" : "image/jpeg");
          res.end(readFileSync(join(dir, m[1])));
          return;
        }
        next();
      });
    },
    generateBundle() {
      load();
      for (const u of list) this.emitFile({ type: "asset", fileName: `updates/img/${u.image}`, source: readFileSync(join(dir, u.image)) });
    },
  };
}

/** play/server.json is owned by whoever deploys the game server; the build empties play/, so put it back as it was
 *  (or {"url": ""} the first time). */
export function keepServerJson(outDir: string): Plugin {
  let saved: string | null = null;
  const p = join(outDir, "server.json");
  return {
    name: "keep-server-json",
    apply: "build",
    buildStart() {
      saved = existsSync(p) ? readFileSync(p, "utf8") : null;
    },
    closeBundle() {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(p, saved ?? '{"url": ""}\n');
    },
  };
}
