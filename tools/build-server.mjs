// Bundles the server (TS + shared code + ws + obscenity) into one dependency-free file: server/dist/server.mjs
import { build } from "esbuild";

await build({
  entryPoints: ["server/src/main.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "server/dist/server.mjs",
  external: ["bufferutil", "utf-8-validate"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: "eof",
  logLevel: "info",
});
