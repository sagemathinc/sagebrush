// What test-board-journal-page.mjs, -cutover.mjs and -timing.mjs share: the site (built web/dist, or several builds
// under prefixes) and a helper page (/__bj/, the workspace's module, to activate the journal and write as another
// writer would) served from ONE origin, so they share this browser's IndexedDB, localStorage and locks; headless
// Chromium with tabs driven over its DevTools protocol.  Bun only (Bun.build, Bun.serve).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html", ".json": "application/json", ".css": "text/css", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json", ".txt": "text/plain", ".zip": "application/zip", ".gz": "application/gzip" };
const typeOf = (p) => TYPES[Object.keys(TYPES).find((x) => p.endsWith(x)) ?? ""] ?? "application/octet-stream";

/** A bundle's failure as one line, or null when it built: Bun.build either throws (an AggregateError, its `errors`)
 * or returns success: false (its `logs`), by Bun's version; both are said, and the caller cleans up either way. */
export async function buildFailure(build) {
  let why = null;
  try {
    const b = await build();
    if (!b?.success) why = "success false: " + (b?.logs ?? []).map(String).join(" | ");
  } catch (e) {
    why = "threw: " + String(e?.message ?? e) + (Array.isArray(e?.errors) ? " | " + e.errors.map(String).join(" | ") : "");
  }
  return why === null ? null : why.replace(/\s+/g, " ").slice(0, 4000);
}

/** The helper page's bundle (the workspace's module, this source's) and the server: `roots`, {prefix: dist dir}
 * ("" the site's root).  Resolves {origin, stop}. */
export async function serve(roots) {
  const site = mkdtempSync(join(tmpdir(), "sb-bjp-site-")), src = mkdtempSync(join(here, ".test-board-journal-page-"));
  writeFileSync(join(src, "entry.js"), `export * as W from ${JSON.stringify(join(here, "../workspace/index.ts"))};\nexport * as A from ${JSON.stringify(join(here, "../workspace/api.ts"))};\n`);
  const built = await buildFailure(() => Bun.build({ entrypoints: [join(src, "entry.js")], outdir: site, naming: "all.js", target: "browser", format: "esm" }));
  rmSync(src, { recursive: true, force: true });
  if (built !== null) { rmSync(site, { recursive: true, force: true }); throw new Error("the helper page's bundle didn't build (" + built + ")"); }
  writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>board journal helper</title><script type="module">import * as M from "./all.js"; window.M = M; window.ready = true;</script>`);
  for (const d of Object.values(roots)) if (!existsSync(join(d, "board", "index.html"))) throw new Error(`no built site at ${d} (web/dist: bun web/build.ts)`);
  const prefixes = Object.keys(roots).sort((a, b) => b.length - a.length);
  // (what the server saw, for the cutover's checks: the 404s' paths, each prefixed page's rewrite count, each
  // board.js path's sha256; and each root's own board.js sha256, said at the start)
  const stats = { missing: new Set(), rewrites: new Map(), scripts: new Map(), roots: {} };
  for (const [x, d] of Object.entries(roots)) {
    const f = join(d, "board", "board.js");
    stats.roots[x] = existsSync(f) ? createHash("sha256").update(readFileSync(f)).digest("hex") : null;
    console.log(`server root ${J(x)}: board/board.js sha256 ${stats.roots[x]}`);
  }
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
    let p = decodeURIComponent(new URL(req.url).pathname);
    if (p.includes("..")) return new Response("no", { status: 400 });
    let file = null, pre = "";
    if (p.startsWith("/__bj/")) file = join(site, p === "/__bj/" ? "index.html" : p.slice(6));
    else {
      pre = prefixes.find((x) => x === "" || p === x || p.startsWith(x + "/"));
      if (pre === undefined) file = null;
      else {
        file = join(roots[pre], p.slice(pre.length) || "/");
        if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
      }
    }
    if (!file || !existsSync(file)) {
      if (!stats.missing.has(p)) { stats.missing.add(p); console.log("server 404: " + p.slice(0, 200)); }
      return new Response("not found", { status: 404 });
    }
    const headers = { "content-type": typeOf(file), "cache-control": "no-store", "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "same-origin" };
    // (the board's script, said once per path with the sha256 of the file served: which build's board.js each page ran)
    if (p.endsWith("/board/board.js") && !stats.scripts.has(p)) {
      const sha = createHash("sha256").update(readFileSync(file)).digest("hex");
      stats.scripts.set(p, sha);
      console.log(`server board.js: ${p} sha256 ${sha} (root ${J(pre)})`);
    }
    // (fix 4: a build under the cutover's /old/ or /new/: its pages' absolute src="/…" and href="/…" attributes (its
    // board/index.html loads /board/board.js) moved under that prefix, "//" left alone; board.js's own imports are
    // relative to its URL, so they follow.  Each such page's count said, once per path)
    if ((pre === "/old" || pre === "/new") && headers["content-type"] === "text/html") {
      let count = 0;
      const html = readFileSync(file, "utf8").replace(/\b(src|href)="\/(?!\/)/g, (_, a) => { count++; return `${a}="${pre}/`; });
      if (!stats.rewrites.has(p)) { stats.rewrites.set(p, count); console.log(`server rewrite: ${p}: ${count} attribute(s) under ${pre}/`); }
      return new Response(html, { headers });
    }
    return new Response(Bun.file(file), { headers });
  } });
  return { origin: `http://127.0.0.1:${server.port}`, stats, stop: () => { server.stop(true); rmSync(site, { recursive: true, force: true }); } };
}

/** Chrome ended gracefully (@sagebrush's ruling on the r3 VM packet): asked to close over its DevTools protocol
 * (Browser.close), then its exit and its whole process group waited for, at most 10 s each; only if it is still there
 * then, its group is killed (SIGKILL), and that fallback said in one line, "CHROME FALLBACK: …", so a run's judge sees
 * it (the reaps it leaves are not benign exits). */
export async function closeChrome(chrome, port, label = "chrome", ms = 10_000) {
  const done = chrome.exitCode !== null || chrome.signalCode !== null ? Promise.resolve() : new Promise((r) => chrome.once("exit", r));
  try {
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(Math.min(3000, ms)) })).json();
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; setTimeout(no, Math.min(3000, ms)); });
    ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
  } catch {}
  const exited = await Promise.race([done.then(() => true), sleep(ms).then(() => false)]);
  const gone = () => { try { process.kill(-chrome.pid, 0); return false; } catch { return true; } };
  for (let i = 0; i < ms / 100 && !gone(); i++) await sleep(100);
  if (!exited || !gone()) {
    console.log(`CHROME FALLBACK: ${label} (pid ${chrome.pid}) didn't close within the bound (exited ${exited}): SIGKILL to its group`);
    try { process.kill(-chrome.pid, "SIGKILL"); } catch {}
    await sleep(200);
  }
}

/** Where a run is (r5: a hang or a kill names its place): the section (`section(name)`, said as it starts), the last
 * check done, and the DevTools calls in flight. */
const place = { section: "setup", checks: 0, last: "(none yet)", calls: new Map() };
// (every Chrome this process started and hasn't closed: {pid, quick}, for the kill path)
const live = new Set();
let callIds = 0;
export function section(name) { place.section = name; console.log(`  section: ${name} (${place.checks} checks so far)`); }
/** A check done, said at once on its own indented line ("  ok …" / "  FAIL …"; before the summary, so mut-6c's list
 * after it is the summary's own). */
export function checked(ok, what) {
  place.checks++; place.last = String(what).replace(/\s*\n\s*/g, " | ");
  console.log((ok ? "  ok " : "  FAIL ") + place.last);
}
export function where() {
  const now = Date.now(), calls = [...place.calls.values()].map((c) => `${c.what} (${Math.round((now - c.t0) / 1000)} s)`);
  return `section "${place.section}", after check ${place.checks} ("${place.last.slice(0, 200)}"), DevTools call(s) in flight: ${calls.length ? calls.join("; ").slice(0, 600) : "none"}`;
}
// (each DevTools call's bound: no answer within it fails the call, naming it)
const CDP_MS = 60_000;

/** The runner's own bounds (r5): `ms`, below the VM step's (its supervisor's SIGTERM, then SIGKILL 10 s later), and
 * SIGTERM/SIGINT/SIGHUP.  Either ends the run with one line, "FAIL: <label>: … during <where()>"; then every Chrome
 * this process started closed (Browser.close, then its group killed after at most 6 s, said as CHROME FALLBACK), then
 * `cleanup()` (the server stopped), then the exit a timeout or that kill would have had (124 for the bound; 128 + the
 * signal's number, 143 for SIGTERM), so fail-first and mut-6c still see a timed-out or killed run as one, never as a
 * check's failure.  At 8 s, before the supervisor's SIGKILL, any Chrome group still there is killed and the process
 * exits so regardless. */
export function bounded(label, ms, cleanup) {
  let ending = false;
  const end = async (why, rc) => {
    if (ending) return;
    ending = true;
    console.log(`FAIL: ${label}: ${why}, during ${where()}`);
    setTimeout(() => {
      for (const c of live) { console.log(`CHROME FALLBACK: ${label}'s Chrome (pid ${c.pid}) still there at the kill path's bound: SIGKILL to its group`); try { process.kill(-c.pid, "SIGKILL"); } catch {} }
      process.exit(rc);
    }, 8000).unref?.();
    try { await Promise.all([...live].map((c) => c.quick())); await cleanup(); } catch (e) { console.log(`${label}: its cleanup threw: ${String(e?.message ?? e).slice(0, 200)}`); }
    process.exit(rc);
  };
  const t = setTimeout(() => end(`its own bound (${Math.round(ms / 1000)} s) reached`, 124), ms);
  t.unref?.();
  for (const [s, n] of [["SIGTERM", 15], ["SIGINT", 2], ["SIGHUP", 1]]) process.on(s, () => end(`killed (${s})`, 128 + n));
  return () => clearTimeout(t);
}

/** Headless Chromium in a profile of its own, its own process group: {tab(), close()}. */
export async function browser() {
  let port = Number(process.env.CDP_PORT) || 0;
  const profile = mkdtempSync(join(tmpdir(), "sb-bjp-"));
  // (no session bus for Chrome: DBUS_SESSION_BUS_ADDRESS=disabled:, as the VM runner sets it for every step)
  const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", detached: true, env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: "disabled:" } });
  // (the kill path's close: short (2 s per wait), its group killed after, said as CHROME FALLBACK if it comes to that)
  const me = { pid: chrome.pid, quick: async () => { await closeChrome(chrome, port, "the killed run's Chrome", 2000); live.delete(me); rmSync(profile, { recursive: true, force: true }); } };
  live.add(me);
  if (!port) port = await devtoolsPort(profile);
  for (let i = 0; i < 300; i++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })).json(); break; } catch { await sleep(100); } }
  const errors = [];
  /** A new tab: {ev, send, go(url), until(expr), state(), close()}; each call bounded (CDP_MS, or `ms`). */
  async function tab(name = "tab") {
    const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.timeout(CDP_MS) })).json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error(`${name}: its DevTools connection didn't open`)); setTimeout(() => no(new Error(`${name}: its DevTools connection didn't open within ${CDP_MS / 1000} s`)), CDP_MS); });
    let n = 0;
    const waiting = new Map();
    ws.onclose = () => { for (const [, w] of waiting) w.no(new Error(`${name}: its DevTools connection closed during ${w.what}`)); waiting.clear(); };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && waiting.has(m.id)) { waiting.get(m.id).ok(m.result ?? m.error); waiting.delete(m.id); }
      if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
    };
    const send = (method, params = {}, ms = CDP_MS) => new Promise((ok, no) => {
      const id = ++n, c = ++callIds;
      const what = `${name} ${method}` + (params.expression ? ` ${J(params.expression.slice(0, 160))}` : params.url ? ` ${params.url}` : "");
      const timer = setTimeout(() => { waiting.delete(id); place.calls.delete(c); no(new Error(`${what}: no answer within ${Math.round(ms / 1000)} s`)); }, ms);
      const fin = (f) => (v) => { clearTimeout(timer); place.calls.delete(c); f(v); };
      place.calls.set(c, { what, t0: Date.now() });
      waiting.set(id, { ok: fin(ok), no: fin(no), what });
      try { ws.send(J({ id, method, params })); } catch (e) { waiting.get(id)?.no(e); waiting.delete(id); }
    });
    const ev = async (expression, ms = CDP_MS) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, ms); if (r?.exceptionDetails) throw new Error(J(r.exceptionDetails).slice(0, 800)); return r?.result?.value; };
    // (each poll bounded by what is left of `ms`, so until() itself keeps its bound)
    const until = async (expr, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr, Math.max(1000, ms - (Date.now() - t0))).catch(() => false)) return true; await sleep(50); } return false; };
    /** The tab as it is (for a failure's message): its URL, title, readiness, page errors and the start of its text. */
    const state = async () => {
      const s = await ev(`({ url: location.href, title: document.title, ready: document.readyState, text: (document.body?.innerText ?? "").slice(0, 300) })`, 5000).catch((e) => ({ unavailable: String(e?.message ?? e).slice(0, 200) }));
      return J({ ...s, errors: errors.slice(-3).map((x) => String(x).replace(/\s*\n\s*/g, " | ").slice(0, 300)) });
    };
    for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
    const go = async (url) => { await send("Page.navigate", { url }); await sleep(100); };
    const close = async () => { try { ws.close(); } catch {} await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`, { signal: AbortSignal.timeout(5000) }).catch(() => {}); await sleep(150); };
    return { ev, send, go, until, state, close };
  }
  // (in `live` until it is closed, so a kill during this close still reaches it)
  const close = async () => { if (!live.has(me)) return; await closeChrome(chrome, port); live.delete(me); rmSync(profile, { recursive: true, force: true }); };
  return { tab, close, errors };
}

// ---- in-page expressions (strings, evaluated in a tab)
/** The board's row in the workspace's database, read raw (no version asked: whatever it is). */
export const rowExpr = (id) => `new Promise((ok) => { const r = indexedDB.open("sagebrush-workspace"); r.onsuccess = () => { const db = r.result; const q = db.transaction("boards").objectStore("boards").get(${JSON.stringify(id)}); q.onsuccess = () => { db.close(); ok(q.result ?? null); }; q.onerror = () => { db.close(); ok(null); }; }; r.onerror = () => ok(null); })`;
/** The rows of the boards' history under `prefix` (its key and the ones after it, ":"…). */
export const historyRowsExpr = (prefix) => `new Promise((ok) => { const r = indexedDB.open("sagebrush-board-history"); r.onsuccess = () => { const db = r.result; const q = db.transaction("history").objectStore("history").getAll(IDBKeyRange.bound([${JSON.stringify(prefix)}, ""], [${JSON.stringify(prefix)} + ":\\uffff", "\\uffff"])); q.onsuccess = () => { db.close(); ok(q.result); }; }; r.onerror = () => ok(null); })`;
/** This device's journal activated, from the helper page (the workspace as the board page opens it). */
export const activateExpr = `(async () => { const w = await window.M.W.Workspace.open(); window.M.W.registerJournalWriter("notebooks"); window.M.W.registerJournalWriter("boards"); const ok = await w.activateJournal(); const on = await w.journalActive(); w.close(); return ok !== false && on; })()`;
/** The workspace's lock held from the helper page until window.__release() (resolves once it is held). */
export const holdLockExpr = `new Promise((held) => { navigator.locks.request("sagebrush-workspace", () => new Promise((r) => { window.__release = r; held(true); })); })`;
