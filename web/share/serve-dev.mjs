// Sharing, locally: web/dist served as web/serve.py does (with web/dist/_headers),
// the share API in Miniflare (a local D1 and R2) on the same origin, and the
// files Worker on a second port, a different origin as the user-content
// domain is.  Sign in with POST /auth/dev {token: "dev-token", account_id}.
//
//   node web/share/serve-dev.mjs [sitePort=8790] [filesPort=8791]
import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, "..", "dist");
const require = createRequire(join(here, "../site/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2" };

function headerRules() {
  const out = [];
  let cur = null;
  const f = join(DIST, "_headers");
  for (const line of existsSync(f) ? readFileSync(f, "utf8").split("\n") : []) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) out.push((cur = [line.trim(), []]));
    else if (cur && line.includes(":")) {
      const i = line.indexOf(":");
      cur[1].push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
    }
  }
  return out;
}

export async function startDev({ sitePort = 8790, filesPort = 8791, limits } = {}) {
  const site = `http://127.0.0.1:${sitePort}`;
  const files = `http://127.0.0.1:${filesPort}`;
  const script = execFileSync("bun", ["build", join(here, "test-entry.ts"), "--format", "esm", "--target", "browser"], { encoding: "utf8" });
  const mf = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: "share",
      modules: true,
      script,
      compatibilityDate: "2026-10-01",
      d1Databases: ["SHARE_DB"],
      r2Buckets: ["SHARE_BUCKET"],
      bindings: { SESSION_KEY: "dev-session-key", PURGE_KEY: "dev-purge-key", FILES_ORIGIN: files, SHARE_DEV: "1", DEV_AUTH_TOKEN: "dev-token" },
    }],
  }));
  const db = await mf.getD1Database("SHARE_DB");
  for (const m of readdirSync(join(here, "migrations")).filter((f) => f.endsWith(".sql")).sort())
    for (const s of readFileSync(join(here, "migrations", m), "utf8").replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(s).run();
  if (limits) for (const [id, l] of Object.entries(limits)) await db.prepare("INSERT INTO limits_cache (account_id, limits, fetched) VALUES (?1, ?2, ?3)").bind(id, JSON.stringify(l), 4e9).run();
  const rules = headerRules();
  const log = { files: [], site: [] }; // (each request to the files domain, and to the site: G-10's share cases)

  async function viaWorker(req, res, url) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
    const r = await mf.dispatchFetch(url, { method: req.method, headers, body: chunks.length && req.method !== "GET" && req.method !== "HEAD" ? Buffer.concat(chunks) : undefined, redirect: "manual" });
    const h = {};
    r.headers.forEach((v, k) => { if (k !== "set-cookie") h[k] = v; });
    const cookies = r.headers.getSetCookie();
    if (cookies.length) h["set-cookie"] = cookies;
    res.writeHead(r.status, h);
    res.end(Buffer.from(await r.arrayBuffer()));
  }

  const siteServer = createServer(async (req, res) => {
    log.site.push(req.url);
    const url = new URL(req.url, site);
    if (/^\/(api|auth)\//.test(url.pathname)) return viaWorker(req, res, url.href);
    let path = url.pathname;
    if (/^\/s\/[a-z2-7]{12}(@[0-9a-f]{8,64})?\/?$/.test(path)) path = "/s/";
    let file = normalize(join(DIST, decodeURIComponent(path)));
    if (!file.startsWith(DIST)) return res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) return res.writeHead(404).end("not found");
    const h = { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" };
    for (const [pattern, hs] of rules) if (path === pattern || (pattern.endsWith("*") && path.startsWith(pattern.slice(0, -1)))) for (const [k, v] of hs) h[k] = v;
    res.writeHead(200, h);
    res.end(readFileSync(file));
  });
  const filesServer = createServer((req, res) => {
    log.files.push(req.url);
    return viaWorker(req, res, "https://files.test" + req.url);
  });
  // (for a test that finds the browser stalled: the servers' open sockets, and each request not yet answered, by
  // method, path and age; #243's CI. And the last 20 requests received, answered or not, with when each came and
  // how long its answer took, so "the browser's request never came" tells itself apart from "it was answered")
  const open = { site: new Set(), files: new Set() }, inflight = new Map(), recent = [];
  let seq = 0;
  for (const [name, srv] of [["site", siteServer], ["files", filesServer]]) {
    srv.on("connection", (s) => { open[name].add(s); s.on("close", () => open[name].delete(s)); });
    srv.on("request", (req, res) => {
      const id = ++seq, x = { server: name, method: req.method, path: String(req.url).split("?")[0].slice(0, 120), at: Date.now() };
      inflight.set(id, x);
      const r = { ...x, answeredMs: null, closedUnanswered: false };
      recent.push(r);
      if (recent.length > 20) recent.shift();
      res.on("finish", () => { r.answeredMs = Date.now() - r.at; });
      res.on("close", () => { inflight.delete(id); if (r.answeredMs === null) r.closedUnanswered = true; });
    });
  }
  await new Promise((r) => siteServer.listen(sitePort, "127.0.0.1", r));
  await new Promise((r) => filesServer.listen(filesPort, "127.0.0.1", r));
  return {
    site, files, mf, db, log,
    stats: () => ({ sockets: { site: open.site.size, files: open.files.size }, inflight: [...inflight.values()].map((x) => ({ ...x, at: undefined, ms: Date.now() - x.at })), recent: recent.map((x) => ({ ...x, at: undefined, agoMs: Date.now() - x.at })) }),
    bucket: await mf.getR2Bucket("SHARE_BUCKET"),
    async close() {
      siteServer.close();
      filesServer.close();
      await mf.dispose();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const d = await startDev({ sitePort: +(process.argv[2] ?? 8790), filesPort: +(process.argv[3] ?? 8791) });
  console.log(`site ${d.site}, files ${d.files}`);
}
