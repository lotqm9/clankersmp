// Tiny static file server that mimics the Vercel setup for local checks of the built site.
// Usage: node tools/static.mjs <root> <port>
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = process.argv[2];
const port = Number(process.argv[3] || 8765);
const types = { ".woff2": "font/woff2", ".webp": "image/webp", ".mp3": "audio/mpeg", ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".ogg": "audio/ogg", ".ttf": "font/ttf", ".svg": "image/svg+xml" };
const rewrites = { "/play": "/play/index.html", "/updates": "/updates/index.html" }; // like Vercel cleanUrls

createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (rewrites[p]) p = rewrites[p];
  let file = normalize(join(root, p));
  if (!file.startsWith(normalize(root))) return res.writeHead(403).end();
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`static ${root} on :${port}`));
