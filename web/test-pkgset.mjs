// Optional package sets in the browser's worker (web/pkgset-browser.ts;
// plan-modular-packages-r4 §4.3), in headless Chromium: the worker admits a
// set the page names ({pkgset: S}) and imports from it, by the asynchronous
// prefetch before a run and by the synchronous fallback (an import the scan
// can't see, which asks for exactly the pinned size); a chunk that isn't the
// pinned one is refused and nothing of it runs; a pin that isn't a set id is
// refused.  Builds optional/hello's set first (scripts/optional-packages.mjs,
// which needs dist/), and serves web/dist and the set itself.
//   bun web/build.ts && node web/test-pkgset.mjs
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "./test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dist = join(here, "dist");
const setDir = mkdtempSync(join(tmpdir(), "sb-pkgset-web-"));
const S = execFileSync("node", [join(root, "scripts", "optional-packages.mjs"), "build", "--out", setDir, "hello"], { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, msg) => {
  console.log((c ? "ok   " : "FAIL ") + msg);
  if (!c) process.exitCode = 1;
};

let poison = false;
const types = { ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".html": "text/html" };
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/test.html") return res.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html><title>pkgset</title>");
  const m = /^\/(pkgset|pkg)\/([0-9a-f]{64})\.json$/.exec(url.pathname);
  if (m) {
    const f = join(setDir, m[1], m[2] + ".json");
    if (!existsSync(f)) return res.writeHead(404).end();
    let b = readFileSync(f);
    if (poison && m[1] === "pkg") b = Buffer.from(b.toString("utf8").replace("hello, ", "HACKED "));
    const r = /^bytes=0-(\d+)$/.exec(req.headers.range ?? "");
    if (r && Number(r[1]) + 1 < b.length) return res.writeHead(206, { "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Range": `bytes 0-${r[1]}/${b.length}` }).end(b.subarray(0, Number(r[1]) + 1));
    return res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(b);
  }
  let p = normalize(join(dist, url.pathname));
  if (p.startsWith(dist) && existsSync(p) && statSync(p).isDirectory()) p = join(p, "index.html");
  if (!p.startsWith(dist) || !existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": types[extname(p)] ?? "application/octet-stream" }).end(readFileSync(p));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const profile = mkdtempSync(join(tmpdir(), "sb-pkgset-chrome-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, base + "test.html"], { stdio: "ignore" });
try {
  const port = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      if (targets.some((t) => t.type === "page" && t.url.startsWith(base))) break;
    } catch {}
    await sleep(100);
  }
  const ws = new WebSocket((targets.find((t) => t.type === "page" && t.url.startsWith(base)) ?? targets.find((t) => t.type === "page")).webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) (waiting.get(m.id)(m.result ?? m.error), waiting.delete(m.id));
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  // (the page: navigated to here, whatever tab Chrome opened first)
  const navigate = async () => {
    await send("Page.enable");
    await send("Page.navigate", { url: base + "test.html" });
    for (let i = 0; i < 100; i++) {
      const r = await send("Runtime.evaluate", { expression: "location.href", returnByValue: true });
      if (r.result?.value === base + "test.html") return;
      await sleep(100);
    }
    throw new Error("the test page did not load");
  };
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
    return r.result.value;
  };
  await navigate();
  // run `code` in a fresh worker with set `set`: its stdout, and whether it raised
  const run = (set, code) => ev(`new Promise((resolve) => {
    const w = new Worker("sagebrush-worker.js", { type: "module" });
    w.postMessage({ init: { limits: null } }); // (the worker's first message: web/worker.ts)
    let out = "", note = "";
    w.onmessage = (e) => {
      const m = e.data;
      if (m.ready) { w.postMessage({ pkgset: ${JSON.stringify(set)} }); w.postMessage({ id: 1, code: ${JSON.stringify(code)} }); }
      if (m.pkgsetError) note = m.pkgsetError;
      if (m.id === 1 && m.stream) out += m.text;
      if (m.id === 1 && m.done) { w.terminate(); resolve({ out, error: !!m.error, note }); }
    };
    setTimeout(() => resolve({ out, timeout: true, note }), 60000);
  })`);
  const a = await run(S, "import hello\nprint(hello.greet('browser'), hello.total([1, 2]))");
  ok(a.out === "hello, browser 3.0\n" && !a.error, `an import from the set, prefetched before the run (${JSON.stringify(a)})`);
  const b = await run(S, "exec('import hello')\nprint(hello.greet())");
  ok(b.out === "hello, world\n" && !b.error, `an import the scan can't see: the synchronous fallback (${JSON.stringify(b)})`);
  poison = true;
  const c = await run(S, "try:\n    import hello\n    print('RAN', hello.greet())\nexcept ImportError as e:\n    print('refused:', 'not the one the index pins' in str(e))");
  ok(c.out === "refused: True\n", `a chunk that isn't the pinned one is refused, nothing of it runs (${JSON.stringify(c)})`);
  poison = false;
  const d = await run("not-a-set", "print(1)");
  ok(d.out === "1\n" && /64 lowercase hex/.test(d.note), `a pin that isn't a set id is refused; the interpreter still runs (${JSON.stringify(d)})`);

  // the service worker (web/sw.js, SEC-PKG-1): the set's files are kept in
  // its own cache, by content; a kept copy is served only if its bytes still
  // have the hash in its path, as a response made there
  await ev(`navigator.serviceWorker.register("sw.js").then(() => navigator.serviceWorker.ready).then(() => true)`);
  await send("Page.reload");
  await sleep(500);
  for (let i = 0; i < 100 && !(await ev("!!navigator.serviceWorker.controller").catch(() => false)); i++) await sleep(100);
  ok(await ev("!!navigator.serviceWorker.controller"), "the page is controlled by the service worker");
  const e = await run(S, "import hello\nprint(hello.greet())");
  await sleep(500);
  const kept = await ev(`caches.open("sb-pkg-v1").then((c) => c.keys()).then((ks) => ks.map((k) => new URL(k.url).pathname).sort())`);
  ok(e.out === "hello, world\n" && kept.includes(`/pkgset/${S}.json`) && kept.some((p) => p.startsWith("/pkg/")), `through the service worker; kept in sb-pkg-v1 (${JSON.stringify(kept)})`);
  const builds = await ev(`caches.keys()`);
  ok(builds.includes("sb-pkg-v1") && builds.every((k) => k === "sb-pkg-v1" || !k.startsWith("sb-pkg")), `its own cache, apart from the build's (${JSON.stringify(builds)})`);
  // the server now lies: the kept copy, still verified, is used
  poison = true;
  const f = await run(S, "import hello\nprint(hello.greet())");
  ok(f.out === "hello, world\n", `a verified kept copy is used when the network lies (${JSON.stringify(f)})`);
  // a kept copy rewritten by a script of the origin is dropped, never served
  await ev(`caches.open("sb-pkg-v1").then(async (c) => { for (const k of await c.keys()) if (k.url.includes("/pkg/")) await c.put(k, new Response("{\\"evil\\":1}")); return true; })`);
  const g = await run(S, "try:\n    import hello\n    print('RAN')\nexcept ImportError as e:\n    print('refused')");
  ok(g.out === "refused\n", `a rewritten kept copy is dropped, and the lying network refused (${JSON.stringify(g)})`);
  poison = false;

  // LIMIT-PR68-3: many first opens at once, and a service worker stopped in
  // the middle: the physical cache stays within its caps, and every entry in
  // it has its ledger row (web/sw.js's queue and reconciliation)
  const blob = (i) => {
    const b = Buffer.from(JSON.stringify({ filler: i, pad: "x".repeat(64) }));
    const h = createHash("sha256").update(b).digest("hex");
    writeFileSync(join(setDir, "pkg", h + ".json"), b);
    return h;
  };
  // (one snapshot: the ledger read before and after the cache, and kept only if the two agree.  web/sw.js's
  // queue writes an entry's row before the entry and drops it after, so a single read of each can straddle one
  // keep; at the cap every admission evicts one and adds one, so that torn read is the same every time
  // ({physical 63, rows 64, pending 0}), and two in a row passed for settled while the queue still ran: #164's
  // run 40244216984.  Rows unchanged around the read, nothing pending: no keep or eviction was in between)
  const state = () => ev(`(async () => {
    const ledger = () => new Promise((resolve) => { const r = indexedDB.open("sb-pkg-ledger"); r.onsuccess = () => { const t = r.result.transaction("e").objectStore("e").getAll(); t.onsuccess = () => { resolve(t.result); r.result.close(); }; }; });
    const sig = (rows) => JSON.stringify(rows.map((x) => [x.digest, x.state]).sort());
    const before = await ledger();
    const keys = (await (await caches.open("sb-pkg-v1")).keys()).map((k) => /([0-9a-f]{64})\\.json$/.exec(k.url)[1]);
    const rows = await ledger();
    const kept = new Set(rows.filter((x) => x.state === "kept").map((x) => x.digest));
    return { physical: keys.length, rows: rows.length, orphans: keys.filter((k) => !kept.has(k)).length, pending: rows.filter((x) => x.state !== "kept").length, torn: sig(before) !== sig(rows) };
  })()`);
  const fetchAll = (hs) => ev(`Promise.all(${JSON.stringify(hs)}.map((h) => fetch("pkg/" + h + ".json").then((r) => r.status))).then((s) => s.filter((x) => x === 200).length)`);
  // (the queue drains one keep at a time: settled once nothing is pending, the
  // snapshot isn't torn, and a second look agrees; a queue that stalls fails after 30 s)
  const settle = async () => {
    let last = "";
    for (let i = 0; i < 150; i++) {
      await sleep(200);
      const s = await state();
      if (s.pending === 0 && !s.torn && JSON.stringify(s) === last) return s;
      last = s.pending === 0 && !s.torn ? JSON.stringify(s) : "";
    }
    return state();
  };
  const first = Array.from({ length: 140 }, (_, i) => blob(i));
  const served = await fetchAll(first);
  const s1 = await settle();
  ok(served === 140 && s1.physical <= 64 && s1.orphans === 0 && s1.pending === 0 && !s1.torn && s1.rows === s1.physical, `140 concurrent first opens: all served; the cache holds ${s1.physical} <= 64, every entry ledgered (${JSON.stringify(s1)})`);
  await send("ServiceWorker.enable");
  const second = Array.from({ length: 60 }, (_, i) => blob(1000 + i));
  const flight = fetchAll(second).catch(() => 0);
  await sleep(40);
  await send("ServiceWorker.stopAllWorkers");
  await flight;
  await fetchAll([blob(5000)]); // (the next admission reconciles first)
  const s2 = await settle();
  ok(s2.physical <= 64 && s2.orphans === 0 && s2.pending === 0 && !s2.torn && s2.rows === s2.physical, `a service worker stopped mid-keep: after the next admission, ${s2.physical} <= 64 entries, every one ledgered (${JSON.stringify(s2)})`);
} finally {
  chrome.kill();
  server.close();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(setDir, { recursive: true, force: true });
}
