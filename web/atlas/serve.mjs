// A local server for the atlas, like the site's Worker: static files from
// web/dist, atlas pages from web/atlas/server.ts.
//   node web/atlas/serve.mjs [PORT]      (after bun web/build.ts)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { handleAtlas } from "./server.ts";

const dist = join(import.meta.dirname, "..", "dist");
const port = +(process.argv[2] ?? 8766);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8", ".css": "text/css", ".woff2": "font/woff2" };
async function asset(path) {
  let p = normalize(decodeURIComponent(path.split("?")[0]));
  if (p.endsWith("/")) p += "index.html";
  try {
    return new Response(await readFile(join(dist, p)), { headers: { "content-type": TYPES[extname(p)] ?? "application/octet-stream" } });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const request = new Request(url, { headers: req.headers });
  let r = await asset(url.pathname);
  if (r.status === 404) r = (await handleAtlas(request, asset)) ?? r;
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, () => console.log(`http://localhost:${port}/atlas/`));
