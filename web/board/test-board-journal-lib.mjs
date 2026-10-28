// What test-board-journal-page.mjs, -cutover.mjs and -timing.mjs share: the site (built web/dist, or several builds
// under prefixes) and a helper page (/__bj/, the workspace's module, to activate the journal and write as another
// writer would) served from ONE origin, so they share this browser's IndexedDB, localStorage and locks; headless
// Chromium with tabs driven over its DevTools protocol.  Bun only (Bun.build, Bun.serve).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html", ".json": "application/json", ".css": "text/css", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json", ".txt": "text/plain", ".zip": "application/zip", ".gz": "application/gzip" };
const typeOf = (p) => TYPES[Object.keys(TYPES).find((x) => p.endsWith(x)) ?? ""] ?? "application/octet-stream";

/** The helper page's bundle (the workspace's module, this source's) and the server: `roots`, {prefix: dist dir}
 * ("" the site's root).  Resolves {origin, stop}. */
export async function serve(roots) {
  const site = mkdtempSync(join(tmpdir(), "sb-bjp-site-")), src = mkdtempSync(join(here, ".test-board-journal-page-"));
  writeFileSync(join(src, "entry.js"), `export * as W from ${JSON.stringify(join(here, "../workspace/index.ts"))};\nexport * as A from ${JSON.stringify(join(here, "../workspace/api.ts"))};\n`);
  const b = await Bun.build({ entrypoints: [join(src, "entry.js")], outdir: site, naming: "all.js", target: "browser", format: "esm" });
  rmSync(src, { recursive: true, force: true });
  if (!b.success) { rmSync(site, { recursive: true, force: true }); throw new Error(b.logs.join("\n")); }
  writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>board journal helper</title><script type="module">import * as M from "./all.js"; window.M = M; window.ready = true;</script>`);
  for (const d of Object.values(roots)) if (!existsSync(join(d, "board", "index.html"))) throw new Error(`no built site at ${d} (web/dist: bun web/build.ts)`);
  const prefixes = Object.keys(roots).sort((a, b) => b.length - a.length);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
    let p = decodeURIComponent(new URL(req.url).pathname);
    if (p.includes("..")) return new Response("no", { status: 400 });
    let file = null;
    if (p.startsWith("/__bj/")) file = join(site, p === "/__bj/" ? "index.html" : p.slice(6));
    else {
      const pre = prefixes.find((x) => x === "" || p === x || p.startsWith(x + "/"));
      if (pre === undefined) return new Response("not found", { status: 404 });
      file = join(roots[pre], p.slice(pre.length) || "/");
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    }
    if (!file || !existsSync(file)) return new Response("not found", { status: 404 });
    return new Response(Bun.file(file), { headers: { "content-type": typeOf(file), "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "same-origin" } });
  } });
  return { origin: `http://127.0.0.1:${server.port}`, stop: () => { server.stop(true); rmSync(site, { recursive: true, force: true }); } };
}

/** Headless Chromium in a profile of its own, its own process group: {tab(), close()}. */
export async function browser() {
  let port = Number(process.env.CDP_PORT) || 0;
  const profile = mkdtempSync(join(tmpdir(), "sb-bjp-"));
  const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", detached: true });
  if (!port) port = await devtoolsPort(profile);
  for (let i = 0; i < 300; i++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await sleep(100); } }
  const errors = [];
  /** A new tab: {ev, send, go(url), until(expr), close()}. */
  async function tab() {
    const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let n = 0;
    const waiting = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
      if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
    };
    const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800)); return r?.result?.value; };
    const until = async (expr, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(50); } return false; };
    for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
    const go = async (url) => { await send("Page.navigate", { url }); await sleep(100); };
    const close = async () => { try { ws.close(); } catch {} await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`).catch(() => {}); await sleep(150); };
    return { ev, send, go, until, close };
  }
  const close = async () => { try { process.kill(-chrome.pid, "SIGKILL"); } catch {} await sleep(200); rmSync(profile, { recursive: true, force: true }); };
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
