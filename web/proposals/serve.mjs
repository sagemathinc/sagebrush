// A static server for a built web/dist (prototype review only): bun web/proposals/serve.mjs web/dist 8711
import { join, normalize } from "node:path";
import { statSync } from "node:fs";
const [dir, port] = [process.argv[2], Number(process.argv[3] || 8711)];
Bun.serve({
  port, hostname: "127.0.0.1",
  async fetch(req) {
    let p = normalize(decodeURIComponent(new URL(req.url).pathname));
    if (p.includes("..")) return new Response("no", { status: 400 });
    let f = join(dir, p);
    try { if (statSync(f).isDirectory()) f = join(f, "index.html"); } catch { return new Response("not found", { status: 404 }); }
    const file = Bun.file(f);
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file, { headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-cache" } });
  },
});
console.log(`serving ${dir} on http://127.0.0.1:${port}/`);
