// Sharing, locally: web/dist served as web/serve.py does (with web/dist/_headers),
// the share API in Miniflare (a local D1 and R2) on the same origin, and the
// files Worker on a second port, a different origin as the user-content
// domain is.  Sign in with POST /auth/dev {token: "dev-token", account_id}.
//
//   node web/share/serve-dev.mjs [sitePort=8790] [filesPort=8791]
import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { dispatch } from "../miniflare-dispatch.mjs";

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

// Which share server to run: this directory's test-entry.ts and migrations/, or another variant's, named by
// SHARE_DEV_ENTRY (its test entry) and SHARE_DEV_MIGRATIONS (a JSON array of its .sql paths, in the order they are
// applied), both or neither.  A variable that is set but names no readable file, or a malformed list, fails here,
// before anything starts: it never falls back to this directory's.  SHARE_DEV_EXPECT says which variant the run
// expects, "core" (the default) or "hosted"; startDev checks it on the instance it starts (checkVariant).
export function devVariant(env = process.env) {
  const expect = env.SHARE_DEV_EXPECT ?? "core";
  if (expect !== "core" && expect !== "hosted") throw new Error(`SHARE_DEV_EXPECT is "core" or "hosted", not ${JSON.stringify(expect)}`);
  const { SHARE_DEV_ENTRY: entry, SHARE_DEV_MIGRATIONS: list } = env;
  if (entry === undefined && list === undefined) {
    const migrations = readdirSync(join(here, "migrations")).filter((f) => f.endsWith(".sql")).sort().map((m) => join(here, "migrations", m));
    return { entry: join(here, "test-entry.ts"), migrations, expect };
  }
  if (!entry || !list) throw new Error("SHARE_DEV_ENTRY and SHARE_DEV_MIGRATIONS are set together, or not at all");
  const file = (f, what) => {
    if (!existsSync(f) || !statSync(f).isFile()) throw new Error(`${what}: no such file: ${f}`);
    return f;
  };
  let migrations;
  try {
    migrations = JSON.parse(list);
  } catch {
    throw new Error("SHARE_DEV_MIGRATIONS isn't a JSON array of paths");
  }
  if (!Array.isArray(migrations) || !migrations.length || !migrations.every((m) => typeof m === "string" && m.endsWith(".sql"))) throw new Error("SHARE_DEV_MIGRATIONS isn't a non-empty JSON array of .sql paths");
  return { entry: file(entry, "SHARE_DEV_ENTRY"), migrations: migrations.map((m) => file(m, "SHARE_DEV_MIGRATIONS")), expect };
}

// The variant the server is, checked on the instance itself, so a run can't pass against the other one: the hosted
// variant answers sharePreview's JSON at its test route /__preview/<id> (null for an unknown id) and has migration
// 0009's remotes table; core's has neither.  Both have 0005's upload_receipts.  The request goes to the Worker
// directly, not through the servers, so it isn't in the run's request log.  One line says what was checked.
export async function checkVariant(mf, db, { expect, migrations }) {
  const r = await dispatch(mf, "http://127.0.0.1/__preview/zzzzzzzzzzzz");
  const preview = r.status === 200 && (await r.text()).trim() === "null";
  const tables = new Set((await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).results.map((t) => t.name));
  const remotes = tables.has("remotes");
  if (!tables.has("upload_receipts")) throw new Error("share dev server: migration 0005 wasn't applied");
  if (expect === "hosted" ? !(preview && remotes) : preview || remotes) throw new Error(`share dev server: expected the ${expect} variant, found sharePreview ${preview ? "answering" : "absent"} and the remotes table ${remotes ? "present" : "absent"}`);
  console.log(`share dev server: the ${expect} variant; migrations applied: ${migrations.map((m) => basename(m)).join(",")}`);
}

// A server listening on `port` (0: the system's choice), or the listen's error: never an unhandled 'error' event.
function listen(srv, port) {
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => { srv.off("error", reject); resolve(/** @type {import("node:net").AddressInfo} */ (srv.address()).port); });
  });
}

// The two servers listen first, before anything else here starts (a port of 0, the default for tests, is the system's
// choice, taken and held from that moment: nothing else can take it while the Worker is built, unlike a port found free
// and closed beforehand, the EADDRINUSE of master 1246a589); their URLs, from the ports they hold, then go into the
// Worker's bindings.  `onBound`, tests only, is called with them once both are held and before the Worker is built.
export async function startDev({ sitePort = 8790, filesPort = 8791, limits, onBound } = {}) {
  const variant = devVariant();
  // (each server answers through its handler, set once the Worker is up; before that, nothing knows their URLs, but a
  // request that comes anyway is answered 503, never left open)
  const handlers = { site: null, files: null };
  const siteServer = createServer((req, res) => (handlers.site ? handlers.site(req, res) : res.writeHead(503).end("starting")));
  const filesServer = createServer((req, res) => (handlers.files ? handlers.files(req, res) : res.writeHead(503).end("starting")));
  let site, files;
  try {
    site = `http://127.0.0.1:${await listen(siteServer, sitePort)}`;
    files = `http://127.0.0.1:${await listen(filesServer, filesPort)}`;
    if (onBound) await onBound({ site, files });
  } catch (e) {
    siteServer.close();
    filesServer.close();
    throw e;
  }
  try {
    return await startWorker({ variant, site, files, limits, siteServer, filesServer, handlers });
  } catch (e) {
    siteServer.close();
    filesServer.close();
    throw e;
  }
}

async function startWorker({ variant, site, files, limits, siteServer, filesServer, handlers }) {
  const script = execFileSync("bun", ["build", variant.entry, "--format", "esm", "--target", "browser"], { encoding: "utf8" });
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
  for (const m of variant.migrations)
    for (const s of readFileSync(m, "utf8").replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(s).run();
  await checkVariant(mf, db, variant);
  if (limits) for (const [id, l] of Object.entries(limits)) await db.prepare("INSERT INTO limits_cache (account_id, limits, fetched) VALUES (?1, ?2, ?3)").bind(id, JSON.stringify(l), 4e9).run();
  const rules = headerRules();
  const log = { files: [], site: [] }; // (each request to the files domain, and to the site: G-10's share cases)

  async function viaWorker(req, res, url) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
    const r = await dispatch(mf, url, { method: req.method, headers, body: chunks.length && req.method !== "GET" && req.method !== "HEAD" ? Buffer.concat(chunks) : undefined, redirect: "manual" });
    const h = {};
    r.headers.forEach((v, k) => { if (k !== "set-cookie") h[k] = v; });
    const cookies = r.headers.getSetCookie();
    if (cookies.length) h["set-cookie"] = cookies;
    res.writeHead(r.status, h);
    res.end(Buffer.from(await r.arrayBuffer()));
  }

  handlers.site = async (req, res) => {
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
    // (a rule's header replaces the default, as Cloudflare's _headers does: names in lower case, so "Cache-Control"
    // isn't sent beside "cache-control: no-store", which a browser joins into one no-store header)
    for (const [pattern, hs] of rules) if (path === pattern || (pattern.endsWith("*") && path.startsWith(pattern.slice(0, -1)))) for (const [k, v] of hs) h[k.toLowerCase()] = v;
    res.writeHead(200, h);
    res.end(readFileSync(file));
  };
  handlers.files = (req, res) => {
    log.files.push(req.url);
    return viaWorker(req, res, "https://files.test" + req.url);
  };
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
