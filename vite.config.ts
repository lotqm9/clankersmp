// The $STEVE Craft game client, built straight into the $STEVE site: sites/steve/play/ (served at
// https://www.stevepumpfun.com/play/, Vercel project stevepumpfun). The title screen (sites/steve/index.html) is not
// touched; its Multiplayer button opens /play/.
//   web/play/index.html  the page (-> client/src/main.ts)
//   web/public/play/     fonts, sounds and music, copied to play/ as they are
//   updates/             the "what's new" entries (tools/site-plugins.ts), images to play/updates/img/
// play/server.json (the live game server's URL) is owned by whoever deploys the server: the build keeps it as it was.

import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keepServerJson, updatesPlugin } from "./tools/site-plugins.ts";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
// PLAY_OUT_DIR (optional): build somewhere else, e.g. a scratch folder for a test build
const outDir = process.env.PLAY_OUT_DIR ? resolve(process.env.PLAY_OUT_DIR) : r("../steve/play");

export default defineConfig({
  root: r("web/play"),
  base: "/play/",
  publicDir: r("web/public/play"),
  plugins: [updatesPlugin(r("updates")), keepServerJson(outDir)],
  build: {
    outDir,
    emptyOutDir: true,
    target: "es2022",
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1500,
  },
  worker: { format: "es" },
  server: { port: Number(process.env.VITE_PORT ?? 5199), strictPort: true, fs: { allow: [r(".")] } },
  preview: { port: Number(process.env.VITE_PORT ?? 5199) },
});
