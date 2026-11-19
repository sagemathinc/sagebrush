// A tiny server for dist/ (no dependencies):  node serve.mjs [port]   (default 8080, or PORT)
//
// Code in the space runs on Sagebrush's own engine, in a Web Worker, which must come from the page's own origin.
// So whatever isn't in dist/ (sagebrush-notebook.js, sagebrush-worker.js, the engine's .wasm, the library's chunks)
// is fetched from Sagebrush's site (UPSTREAM, default https://sagebrush.space) and kept in .cache/, and every answer
// carries the cross-origin-isolation headers, so Stop can interrupt a run.  (Deployed under Sagebrush's own site,
// at /space/ say, none of this is needed: those files are already there.)
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "dist"), cache = join(here, ".cache");
const port = Number(process.argv[2] || process.env.PORT || 8080);
const UPSTREAM = (process.env.UPSTREAM || "https://sagebrush.space").replace(/\/$/, "");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };
const isolation = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "same-origin" };

async function upstream(path, search) {
  // (kept on disk: the engine's files are content-addressed or rarely change; a query string is part of the key)
  const key = join(cache, (path + (search ? "_" + Buffer.from(search).toString("hex") : "")).replace(/\/$/, "/index"));
  try {
    return { body: await readFile(key), type: types[extname(path)] ?? "application/octet-stream" };
  } catch {}
  const r = await fetch(UPSTREAM + path + search);
  if (!r.ok) return null;
  const body = Buffer.from(await r.arrayBuffer());
  await mkdir(dirname(key), { recursive: true });
  await writeFile(key, body);
  return { body, type: r.headers.get("content-type") ?? types[extname(path)] ?? "application/octet-stream" };
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = join(root, path.endsWith("/") ? path + "index.html" : path);
  if (!file.startsWith(root)) return void res.writeHead(403).end();
  try {
    const body = await readFile(file);
    return void res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache", ...isolation }).end(body);
  } catch {}
  try {
    const got = await upstream(path, url.search);
    if (got) return void res.writeHead(200, { "Content-Type": got.type, "Cache-Control": "no-cache", ...isolation }).end(got.body);
  } catch (e) {
    console.error("upstream:", path, e?.message ?? e);
  }
  res.writeHead(404, isolation).end("not found");
}).listen(port, "127.0.0.1", () => console.log(`the whitespace: http://127.0.0.1:${port}/   (Sagebrush's engine from ${UPSTREAM})`));
