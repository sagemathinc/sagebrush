// [prototype, do not merge] Kedlaya WebKit follow-up A (plan-kedlaya-webkit-
// ci r2 section 1, the fail-closed feasibility check): can the pinned
// Playwright's WebKit give heap snapshots of the Sagebrush worker's VM?  Any
// step that doesn't hold makes FEASIBLE false, with the reason.
//   node web/test-webkit-heap-prototype.mjs PLAYWRIGHT_DIR [OUT.json]
// PLAYWRIGHT_DIR: where `npm i playwright@<pinned>` put node_modules.  The
// server modules are reached by absolute path (the package's exports don't
// list them): test-only instrumentation of the pinned version.
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const pwDir = process.argv[2];
const out = process.argv[3] ?? "webkit-heap-prototype.json";
const report = { pinned: null, steps: [], feasible: false };
const step = (name, ok, detail) => {
  report.steps.push({ name, ok, detail });
  console.log((ok ? "ok   " : "FAIL ") + name + (detail !== undefined ? ": " + JSON.stringify(detail).slice(0, 400) : ""));
  return ok;
};
const req = createRequire(join(pwDir, "node_modules", "x.js"));
const coreDir = dirname(req.resolve("playwright-core/package.json"));
report.pinned = JSON.parse(readFileSync(join(coreDir, "package.json"), "utf8")).version;
// the worker sessions: WKWorkers keeps one WKSession per worker
const { WKWorkers } = req(join(coreDir, "lib/server/webkit/wkWorkers.js"));
const workersObjects = [];
const realSet = WKWorkers.prototype.setSession;
WKWorkers.prototype.setSession = function (session) {
  if (!workersObjects.includes(this)) workersObjects.push(this);
  this.__pageSession = session;
  return realSet.call(this, session);
};
const { webkit } = req("playwright");

const types = { ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".html": "text/html" };
const iso = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
const server = createServer((r, res) => {
  const url = new URL(r.url, "http://x");
  if (url.pathname === "/test.html") return res.writeHead(200, { "Content-Type": "text/html", ...iso }).end("<!doctype html><title>proto</title>");
  let p = normalize(join(dist, url.pathname));
  if (p.startsWith(dist) && existsSync(p) && statSync(p).isDirectory()) p = join(p, "index.html");
  if (!p.startsWith(dist) || !existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": types[extname(p)] ?? "application/octet-stream", ...iso }).end(readFileSync(p));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;
const t0 = Date.now();
const browser = await webkit.launch();
try {
  report.browserVersion = browser.version();
  const page = await browser.newPage();
  await page.goto(base + "test.html");
  report.userAgent = await page.evaluate(() => navigator.userAgent);
  step("page cross-origin isolated", await page.evaluate(() => crossOriginIsolated));
  // the Sagebrush worker, kept by the page; runs go through window.run
  await page.evaluate(() => new Promise((resolve) => {
    const w = new Worker("/sagebrush-worker.js", { type: "module" });
    let id = 10;
    const pending = new Map();
    w.onmessage = (e) => {
      const m = e.data;
      if (m.ready) resolve();
      const p = pending.get(m.id);
      if (p && m.stream) p.out += m.text;
      if (p && m.done) (pending.delete(m.id), p.resolve(p.out));
    };
    window.run = (code) => new Promise((res) => { const i = ++id; pending.set(i, { out: "", resolve: res }); w.postMessage({ id: i, sage: true, code }); });
    w.postMessage({ init: { limits: null } });
  }));
  step("the worker runs", (await page.evaluate(() => run("print(2 + 2)"))).trim() === "4");
  const sessions = workersObjects.flatMap((w) => [...w._workerSessions.values()]);
  if (!step("exactly one worker session", sessions.length === 1, sessions.length)) throw new Error("no unique worker session");
  const ws = sessions[0];
  // a marker in the worker's VM, absent from the page's
  await page.evaluate(() => run("import sys\nclass KdMarkPrototype:\n    pass\nsys._kd_mark = [KdMarkPrototype() for i in range(7)]\nprint('marked')"));
  let snap;
  try {
    await ws.send("Heap.enable");
    await ws.send("Heap.gc");
    const ts = Date.now();
    const r = await ws.send("Heap.snapshot");
    report.snapshotMs = Date.now() - ts;
    snap = r.snapshotData;
    report.snapshotBytes = snap?.length;
  } catch (e) {
    step("Heap.enable, Heap.gc and Heap.snapshot to the worker's target", false, String(e?.message ?? e));
    throw e;
  }
  step("Heap.enable, Heap.gc and Heap.snapshot to the worker's target", typeof snap === "string" && snap.length > 0, { bytes: snap?.length, ms: report.snapshotMs });
  const g = JSON.parse(snap);
  report.snapshotFormat = { version: g.version, type: g.type, keys: Object.keys(g), nodeFields: g.nodeFields ?? null, edgeFields: g.edgeFields ?? null, classNames: (g.nodeClassNames ?? []).length, nodes: Array.isArray(g.nodes) ? g.nodes.length : null };
  step("the snapshot parses (JSC heap-snapshot JSON)", Array.isArray(g.nodes) && Array.isArray(g.edges), report.snapshotFormat);
  step("the worker's marker is in the worker's snapshot", snap.includes("KdMarkPrototype"));
  let pageSnap = null;
  try {
    const pageSession = workersObjects[0].__pageSession;
    await pageSession.send("Heap.enable");
    pageSnap = (await pageSession.send("Heap.snapshot")).snapshotData;
  } catch (e) {
    report.pageSnapshotError = String(e?.message ?? e);
  }
  step("the page's snapshot lacks the worker's marker", pageSnap !== null && !pageSnap.includes("KdMarkPrototype"), pageSnap === null ? report.pageSnapshotError ?? "no page snapshot" : { bytes: pageSnap.length });
  report.feasible = report.steps.every((s) => s.ok);
} catch (e) {
  report.error = String(e?.stack ?? e).slice(0, 2000);
} finally {
  report.totalMs = Date.now() - t0;
  await browser.close();
  server.close();
  writeFileSync(out, JSON.stringify(report, null, 1));
  console.log("FEASIBLE " + report.feasible);
}
