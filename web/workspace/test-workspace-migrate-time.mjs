// The migrator moving the largest file a page can have kept the old way
// (200 MB: maxFileBytes) without freezing the page (design/capabilities.md
// §2b; daybreak2's requirement): a workspace as version 1 made it, with one
// such file, opened by this version and migrated, while the page measures
// its longest task (PerformanceObserver "longtask") and how late a 10 ms
// timer fires.  Both must stay under MAX_MS.  The figures are printed.
//   CHROME=google-chrome bun web/workspace/test-workspace-migrate-time.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const MAX_MS = Number(process.env.MAX_MS) || 1000;
const here = new URL(".", import.meta.url).pathname;
const site = mkdtempSync(join(tmpdir(), "sb-ws-time-site-"));
const built = await Bun.build({ entrypoints: [join(here, "index.ts")], outdir: site, naming: "ws.js", target: "browser", format: "esm" });
if (!built.success) {
  console.error(built.logs.join("\n"));
  process.exit(1);
}
const SIZE = 200 * 2 ** 20;
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>migration time</title><script type="module">
import * as W from "./ws.js";
const NAME = "ws-time", MAIN = "main-time";
const raw = (db, store, op, ...a) => new Promise((ok, no) => { const tx = db.transaction(store, op === "put" ? "readwrite" : "readonly"); const r = tx.objectStore(store)[op](...a); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
window.setup = async () => {
  await new Promise((ok, no) => {
    const r = indexedDB.open(NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result, e = db.createObjectStore("entries", { keyPath: "path" });
      e.createIndex("byRef", ["kind", "ref"]);
      db.createObjectStore("boards", { keyPath: "id" });
      db.createObjectStore("trash");
      db.createObjectStore("ops", { keyPath: "seq", autoIncrement: true });
      const v = db.createObjectStore("versions", { keyPath: "id", autoIncrement: true });
      v.createIndex("byFile", ["fid", "t"]);
      v.createIndex("byTime", "t");
      db.createObjectStore("versionBytes");
      db.createObjectStore("meta");
    };
    r.onsuccess = () => { const db = r.result, tx = db.transaction("entries", "readwrite"); tx.objectStore("entries").put({ path: "/big.bin", kind: "file", ref: "/big.bin", size: ${SIZE}, rev: 0, fid: "b000000000000000", created: 1, updated: 1 }); tx.oncomplete = () => { db.close(); ok(); }; tx.onerror = () => no(tx.error); };
    r.onerror = () => no(r.error);
  });
  const w = await W.Workspace.open({ name: NAME, mainName: MAIN });
  const b = new Uint8Array(${SIZE});
  for (let j = 0; j < b.length; j += 4096) b[j] = j & 255;
  await raw(w.main, "files", "put", b, "/big.bin");
  w.close();
  return true;
};
window.measure = async () => {
  const w = await W.Workspace.open({ name: NAME, mainName: MAIN });
  let longest = 0, late = 0, tasks = 0;
  const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) { tasks++; longest = Math.max(longest, e.duration); } });
  try { po.observe({ type: "longtask", buffered: false }); } catch {}
  let last = performance.now();
  const iv = setInterval(() => { const now = performance.now(); late = Math.max(late, now - last - 10); last = now; }, 10);
  const t0 = performance.now();
  await W.startMigrator(w);
  const ms = performance.now() - t0;
  await new Promise((r) => setTimeout(r, 100));
  clearInterval(iv);
  po.disconnect();
  const e = await w.stat("/big.bin"), st = await W.migrationState(w);
  w.close();
  return { longest: Math.round(longest), late: Math.round(late), tasks, ms: Math.round(ms), migrated: !!e.migrated, done: !!st.done };
};
window.ready = true;
</script>`);
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
  const p = new URL(req.url).pathname;
  if (!["/", "/ws.js"].includes(p)) return new Response("not found", { status: 404 });
  return new Response(Bun.file(join(site, p === "/" ? "index.html" : "ws.js")), { headers: { "content-type": p.endsWith(".js") ? "text/javascript" : "text/html" } });
} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-ws-time-"));
let port = Number(process.env.CDP_PORT) || 0;
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const fails = [];
try {
  if (!port) port = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.some((t) => t.type === "page")) break; } catch {} await sleep(100); }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0; const waiting = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800)); return r.result?.value; };
  await send("Runtime.enable");
  await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
  for (let i = 0; i < 200 && !(await ev("window.ready === true").catch(() => false)); i++) await sleep(50);
  await ev("window.setup()");
  const r = await ev("window.measure()");
  console.log(`200 MB file migrated in ${r.ms} ms: longest task ${r.longest} ms (${r.tasks} long tasks), a 10 ms timer at most ${r.late} ms late`);
  if (!r.migrated || !r.done) fails.push("not migrated: " + JSON.stringify(r));
  if (r.longest > MAX_MS) fails.push(`the longest task, ${r.longest} ms, is over ${MAX_MS} ms`);
  if (r.late > MAX_MS) fails.push(`a timer ran ${r.late} ms late, over ${MAX_MS} ms`);
  ws.close();
} catch (e) {
  fails.push("threw: " + (e?.stack ?? e));
} finally {
  chrome.kill();
  server.stop(true);
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
  rmSync(site, { recursive: true, force: true });
}
if (fails.length) {
  console.error("FAIL: " + fails.join("; "));
  process.exit(1);
}
console.log("ok: the migrator keeps the page responsive");
process.exit(0);
