// ci: none (not run by CI before test discovery, Nov 2 2026: a wiring candidate)
// Storage -> Offline's controls that need the service worker's test-only hook (plan-b8-offline r3.4; cases v2, rows
// marked [hook]): the test build's web/dist-test/sw.test.js is served as /sw.js, and a "deploy" is that file with
// another VERSION (and, for some rows, another catalog or inventory).  The hook gives the counters, the time scale,
// a stubbed quota estimate, the probe forced false, the order reservations are granted in, and stop points: a cache
// put or delete that waits until resumed, so the worker can be stopped (CDP) exactly there.  A deploy's settings are
// one IndexedDB record for that build, read before it installs.
//
//   SAGEBRUSH_OFFLINE_TEST=1 bun web/build.ts && node web/test-offline-hook.mjs      (CHROME=... for the browser)
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, freePort } from "./test-port.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, name) => { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) failures++; return cond; };
const here = new URL(".", import.meta.url).pathname;
const testSw = join(here, "dist-test", "sw.test.js");
if (!existsSync(testSw)) throw new Error("no web/dist-test/sw.test.js: build with SAGEBRUSH_OFFLINE_TEST=1");
const SW = readFileSync(testSw, "utf8");
const literal = (text, name) => JSON.parse(new RegExp(`^const ${name} = (.*);$`, "m").exec(text)[1]);
const A = /^const VERSION = "([0-9a-f]{16})";$/m.exec(SW)[1];
const LAZY = literal(SW, "LAZY").map((p) => "/" + p.split("?")[0]), DIGESTS = literal(SW, "DIGESTS");
// (a LAZY path's exact request URL; only those with a content hash are served cache-first, so only they hold leases)
const urlOf = new Map(literal(SW, "LAZY").map((u) => ["/" + u.split("?")[0], "/" + u]));
const cacheFirst = (p) => /\?h=/.test(urlOf.get(p)) || /\/lib\/[\w.-]+\.[0-9a-f]{16}\.json$/.test(p);
const size = (p) => DIGESTS[p.slice(1)].size;
const MiB = 1 << 20, maxEntry = Math.max(...LAZY.map(size));
const invText = readFileSync(join(here, "dist", "offline-inventory.json"), "utf8"), inv = JSON.parse(invText);

const tmp = mkdtempSync(join(tmpdir(), "sb-offline-hook-"));
const overridesFile = join(tmp, "overrides.json"), logFile = join(tmp, "requests.log");
const overrides = { "/sw.js": { file: testSw } };
const saveOverrides = () => writeFileSync(overridesFile, JSON.stringify(overrides));
saveOverrides();
writeFileSync(logFile, "");
const requests = () => readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).path);
const port = await freePort();
const server = spawn("python3", [join(here, "serve.py"), String(port)], { stdio: "ignore", env: { ...process.env, SB_SERVE_OVERRIDES: overridesFile, SB_SERVE_LOG: logFile } });
await sleep(800);
const profile = mkdtempSync(join(tmpdir(), "sb-offline-hook-p-"));
let cdpPort = Number(process.env.CDP_PORT) || 0;
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!cdpPort) cdpPort = await devtoolsPort(profile);
const cleanup = () => { chrome.kill(); server.kill(); };
process.on("uncaughtException", (e) => { console.log("FAIL " + (e?.stack ?? e)); cleanup(); process.exit(1); });
// (a whole-run bound: a hang fails the run instead of holding its test slot)
setTimeout(() => { console.log("FAIL the run did not finish in 30 min (a hang)"); cleanup(); process.exit(1); }, 30 * 60000).unref();
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
const until = async (f, ms = 30000) => { for (let i = 0; i < ms / 100; i++) { if (await f()) return true; await sleep(100); } return false; };
const J = JSON.stringify;

// the page's side: the API on a fresh port (final: done/failed/cancelled/error, or any reply to a non-fetch); the hook
async function api(msg, ms = 300000) {
  return ev(`new Promise((resolve) => {
    const c = new MessageChannel(), got = [];
    const t = setTimeout(() => resolve({ timeout: true, got }), ${ms});
    c.port1.onmessage = (e) => {
      got.push(e.data);
      const m = e.data;
      if (${J(msg?.offline !== "fetch")} || m.error || m.done || m.failed || m.cancelled) { clearTimeout(t); resolve({ last: m, got }); }
    };
    navigator.serviceWorker.controller.postMessage(${J(msg)}, [c.port2]);
  })`);
}
const hook = (t = {}) => ev(`new Promise((resolve) => {
  const c = new MessageChannel(); setTimeout(() => resolve(null), 10000);
  c.port1.onmessage = (e) => resolve(e.data);
  navigator.serviceWorker.controller.postMessage({ offlineTest: ${J(t)} }, [c.port2]);
})`);
const idb = (db, key, value) => ev(`new Promise((resolve, reject) => {
  const o = indexedDB.open(${J(db)}, 1);
  o.onupgradeneeded = () => o.result.createObjectStore("kv");
  o.onerror = () => reject(o.error);
  o.onsuccess = () => {
    const t = o.result.transaction("kv", ${J(value === undefined ? "readonly" : "readwrite")}), s = t.objectStore("kv");
    let out; ${value === undefined ? `s.get(${J(key)}).onsuccess = (e) => (out = e.target.result);` : value === null ? `s.delete(${J(key)});` : `s.put(${J(value)}, ${J(key)});`}
    t.oncomplete = () => (o.result.close(), resolve(out ?? null));
  };
})`);
const rec = (key) => idb("sb-offline", key);
const status = async () => (await api({ offline: "status", build: await version() }, 15000)).last;
const version = async () => (await hook())?.version;
const cacheOf = (v) => "sagebrush-" + v;
// each LAZY path's copies over every build cache, and their physical bytes
const copies = () => ev(`(async () => {
  const lazy = new Set(${J(LAZY)}), out = {}; let bytes = 0;
  for (const name of await caches.keys()) {
    if (!name.startsWith("sagebrush-")) continue;
    const c = await caches.open(name);
    for (const k of await c.keys()) {
      const p = new URL(k.url).pathname;
      if (!lazy.has(p)) continue;
      (out[p] ??= []).push(name);
      bytes += (await (await c.match(k)).arrayBuffer()).byteLength;
    }
  }
  return { out, bytes };
})()`);
// (the browser's HTTP cache emptied: LAZY files are immutable, so a fetch could otherwise be answered without the server)
const clearHttp = async () => { await send("Network.enable"); await send("Network.clearBrowserCache"); };
const listenStops = () => ev(`(window.__stops ??= [], window.__bc ??= Object.assign(new BroadcastChannel("sb-offline-test"), { onmessage: (e) => window.__stops.push(e.data) }), window.__stops.length)`);
const stops = () => ev("window.__stops.length");
const stopWorkers = async () => { await send("ServiceWorker.enable"); await send("ServiceWorker.stopAllWorkers"); await sleep(500); };
let deploys = 0;
// a new build: the test service worker under another VERSION (edited if asked), with its one-shot settings
async function deploy(settings = {}, edit = (t) => t) {
  const v = (++deploys).toString(16).padStart(4, "0") + A.slice(4);
  const file = join(tmp, `sw-${v}.js`);
  writeFileSync(file, edit(SW).replace(`const VERSION = "${A}";`, `const VERSION = "${v}";`));
  overrides["/sw.js"] = { file };
  saveOverrides();
  // (stops may name the new build's cache as $NEW)
  await idb("sb-offline-test", "boot", { build: v, ...JSON.parse(J(settings).replaceAll("$NEW", cacheOf(v))) });
  await clearHttp();
  // (waiting for the new controller without messaging the old one: a message would restart a stopped worker)
  const changed = await ev(`new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 60000);
    navigator.serviceWorker.addEventListener("controllerchange", () => (clearTimeout(t), resolve(true)), { once: true });
    navigator.serviceWorker.getRegistration().then((r) => r.update()).catch(() => resolve(false));
  })`);
  // (the controller changes when the new build starts activating, before its activate event runs: the rows wait for
  // that event, which the hook records, and for the build's own "active" record)
  const activated = changed && (await until(async () => ((await hook())?.saw ?? []).some((e) => e.startsWith("activate")) && (await rec("active")) === v, 30000));
  return { v, on: activated && (await version()) === v };
}
// a path of an item, and the item's paths (the inventory's rules, as the service worker applies them)
const itemPaths = (id) => {
  const it = inv.items.find((x) => x.id === id), gs = new Set(it.groups ?? []);
  return LAZY.filter((p) => it.rule === "engine" ? p === "/sagebrush-engine.wasm" : it.rule === "myst" ? p === "/sagebrush-myst.js" : it.rule === "docs" ? /^\/docs-index(-[a-z]+)?\.json$/.test(p) : it.rule === "tzdata" ? p.startsWith("/lib/tzdata/") : gs.has(/\/lib\/([a-z0-9-]+)\.(?:src|pre)\.[0-9a-f]{16}\.json$/.exec(p)?.[1]));
};
const bound = (c) => {
  // (§13 R3-2: at most one copy of a path outside... one in flight: at most one path with two copies; bytes within
  // one copy per path plus the largest entry)
  const counts = Object.values(c.out).map((l) => l.length), unique = Object.keys(c.out).reduce((t, p) => t + size(p), 0);
  return { twice: counts.filter((x) => x === 2).length, more: counts.filter((x) => x > 2).length, bytes: c.bytes, limit: unique + maxEntry, ok: counts.filter((x) => x === 2).length <= 1 && !counts.some((x) => x > 2) && c.bytes <= unique + maxEntry };
};

const url = `http://127.0.0.1:${port}/`;
await send("Page.navigate", { url });
await until(() => ev("document.querySelector('#status')?.textContent.startsWith('ready')"));
ok(await until(async () => (await version()) === A, 30000) || (await send("Page.reload"), await until(async () => (await version()) === A)), "the test build's service worker controls the page (its hook answers): " + A);
await listenStops();

// N10 [hook]: admission at the exact boundary, then the per-put check with a shrinking estimate
{
  const Q = 5 * 1024 * MiB, docs = inv.items.find((it) => it.id === "docs"), tz = inv.items.find((it) => it.id === "tzdata");
  ok(itemPaths("docs").reduce((t, p) => t + size(p), 0) === docs.stored, "(the inventory's stored total for docs is its files' sizes)");
  let need = 48 * MiB + docs.stored;
  await hook({ quota: { quota: Q, usage: Q - Q / 5 - need } });
  let r = await api({ offline: "fetch", build: A, items: ["docs"] });
  ok(r.last?.done === true, "N10: admission with free exactly the need passes: " + J(r.last));
  need = 48 * MiB + tz.stored;
  await hook({ quota: { quota: Q, usage: Q - Q / 5 - need + 1 } });
  r = await api({ offline: "fetch", build: A, items: ["tzdata"] });
  ok(r.last?.error === "quota" && r.last.need === need && r.last.free === need - 1, "N10: 1 byte short is refused with need and free: " + J(r.last));
  await hook({ quota: null });
  // (the estimate shrinks to nothing at the job's first progress: the next put's check fails it)
  r = await ev(`new Promise((resolve) => {
    const c = new MessageChannel(), got = []; let shrunk = false;
    c.port1.onmessage = (e) => {
      got.push(e.data);
      if (!shrunk && e.data.filesDone !== undefined) {
        shrunk = true;
        const h = new MessageChannel();
        navigator.serviceWorker.controller.postMessage({ offlineTest: { quota: { quota: ${Q}, usage: ${Q - Q / 5} } } }, [h.port2]);
      }
      if (e.data.error || e.data.done || e.data.failed || e.data.cancelled) resolve({ last: e.data, got });
    };
    navigator.serviceWorker.controller.postMessage({ offline: "fetch", build: ${J(A)}, items: ["docs", "modules"] }, [c.port2]);
  })`);
  ok(r.last?.error === "quota" && r.last.failed?.some((f) => f.reason === "quota") && r.last.items?.includes("docs") && !r.last.items.includes("modules"), "N10: a shrinking estimate fails the job with quota, the completed items listed: " + J({ error: r.last?.error, items: r.last?.items, failed: r.last?.failed?.length }));
  await hook({ quota: null });
}

// N11 [hook] (+ F1): download all: the in-flight expected bytes at most 24 MiB, the buffered bytes at most 64 MiB
{
  await hook({ reset: true });
  const r = await api({ offline: "fetch", build: A, items: "all" }, 600000);
  const h = await hook();
  ok(r.last?.done === true, "N11: download all completes: " + J({ done: r.last?.done, failed: r.last?.failed?.length }));
  ok(h.inflightPeak <= 24 * MiB && h.inflightPeak >= maxEntry, `N11: the in-flight peak ${h.inflightPeak} is within 24 MiB (and at least the largest file, ${maxEntry})`);
  ok(h.budgetPeak <= 64 * MiB, `F1: the buffered peak ${h.budgetPeak} is within 64 MiB`);
}

// F2 [hook]: an abandoned served body is cancelled at 120 s x timeScale, and its lease released
{
  const big = LAZY.filter(cacheFirst).reduce((a, p) => (size(p) > size(a) ? p : a));
  await hook({ scale: 0.01 });
  const before = (await hook()).budgetUsed;
  await ev(`fetch(${J(urlOf.get(big))}).then((r) => (window.__abandoned = r, 1))`);
  const held = (await hook()).budgetUsed;
  await sleep(3000);
  const after = (await hook()).budgetUsed;
  const read = await ev(`window.__abandoned.arrayBuffer().then((b) => "read " + b.byteLength, (e) => "error")`);
  ok(held - before === 2 * size(big) && after === before, `F2: the lease (${held - before} = 2 x ${size(big)}) is released when the unread body is cancelled at 1.2 s: ${before} -> ${held} -> ${after}; the page's read: ${read}`);
  await hook({ scale: 1 });
}

// N15 [hook]: the budget held by the test (63 of 64 MiB): a serving reservation is granted while the background job's
// reservations queued earlier wait; the 65th waiter is refused (and goes to the network); a job holds at most
// MAX_JOB_FILES (8) waiting places, and with the budget back it completes every file (daybreak2's and daybreak3's
// rulings on the file cap)
{
  const magma = itemPaths("magma");
  const pool = LAZY.filter((p) => cacheFirst(p) && !magma.includes(p));
  const small = [...pool].sort((a, b) => size(a) - size(b))[0];
  await api({ offline: "remove", build: A, items: ["magma"] }, 30000);
  await hook({ hold: 63 * MiB });
  ok(await until(async () => (await hook()).budgetUsed === 63 * MiB, 5000), "N15 (setup): 63 MiB of the budget held");
  await hook({ reset: true });
  await clearHttp();
  const bg = api({ offline: "fetch", build: A, items: ["magma"] }, 600000);
  ok(await until(async () => (await hook()).waiting >= 1, 15000), "N15 (setup): the background job's reservations wait");
  await sleep(500);
  const bgWaiting = (await hook()).waiting;
  const served = await ev(`fetch(${J(urlOf.get(small))}).then((r) => r.arrayBuffer()).then((b) => b.byteLength)`);
  let h = await hook();
  ok(served === size(small) && J(h.grants) === '["serve"]' && h.waiting === bgWaiting && bgWaiting <= 8, `N15: a serving reservation is granted ahead of the ${bgWaiting} background ones queued earlier: grants ${J(h.grants)}, waiting ${h.waiting}`);
  // (a refused one is answered from the network, with the server's Last-Modified; a kept copy is made from DIGESTS and
  // has none.  Counted as answered, not by server requests: the HTTP cache serializes identical requests.  Each of the
  // 70 is a different kept file: the service worker checks a key's kept copy one request at a time (a1e770d9,
  // APP-565-1), so 70 requests for one file would wait behind each other and only the first would reach the budget.
  // With the budget's last MiB held too, every one of them waits there, whatever its size)
  await hook({ hold: MiB });
  ok(await until(async () => (await hook()).budgetUsed === 64 * MiB, 5000), "N15 (setup): the whole budget held");
  const seventy = pool.filter((p) => p !== small).slice(0, 70);
  ok(seventy.length === 70, `N15 (setup): 70 different kept files (of ${pool.length})`);
  await ev(`(window.__net = 0, window.__w = ${J(seventy.map((p) => urlOf.get(p)))}.map((u) => fetch(u).then((r) => (r.headers.has("last-modified") && window.__net++, r))), 1)`);
  await sleep(3000);
  h = await hook();
  const refused = await ev("window.__net");
  ok(h.waiting === 64 && refused === 70 - (64 - bgWaiting), `N15: at most 64 wait (${h.waiting}); the 65th and later are refused and answered from the network (${refused}, ${70 - (64 - bgWaiting)} expected)`);
  await hook({ release: true });
  await ev(`Promise.all(window.__w.map((p) => p.then((r) => r.arrayBuffer()))).then(() => 1)`);
  const r = await bg;
  ok(r.last?.done === true, "N15: the background job completes once the budget is back: " + J(r.last?.done ?? r.last));
  ok(await until(async () => (await hook()).budgetUsed === 0, 10000), "N15: every lease is released after");
}
// (the file cap: 346 tzdata files, the budget held: exactly MAX_JOB_FILES wait, the ninth isn't started; released, the
// whole catalog item completes with no budget failure)
{
  const tz = itemPaths("tzdata");
  await api({ offline: "remove", build: A, items: ["tzdata"] }, 30000);
  await hook({ hold: 64 * MiB - 1024 });
  await until(async () => (await hook()).budgetUsed === 64 * MiB - 1024, 5000);
  await clearHttp();
  const job = api({ offline: "fetch", build: A, items: ["tzdata"] }, 600000);
  await until(async () => (await hook()).waiting >= 8, 15000);
  await sleep(1500);
  const w = (await hook()).waiting;
  ok(w === 8, `file cap: with the budget held, the tzdata job (${tz.length} files) has exactly 8 files waiting (${w}); the ninth isn't started`);
  await hook({ release: true });
  const r = await job;
  ok(r.last?.done === true && r.last.failed?.length === 0 && r.last.filesDone === tz.length, `file cap: released, every file completes, no budget failure: ${J({ done: r.last?.done, failed: r.last?.failed?.length, filesDone: r.last?.filesDone })}`);
}

// N7 [hook]: the 30 min deadline (time-scaled to 1 s): the job settles failed with its lists, exactly once
{
  const all = inv.items.map((it) => it.id);
  await api({ offline: "remove", build: A, items: all }, 60000);
  await clearHttp();
  // (the job held at its first put, whatever the machine's speed: the deadline fires during the hold, then it resumes)
  const s7 = await stops();
  await hook({ scale: 1 / 1800, stop: { op: "put", url: "", cache: cacheOf(A), when: "before" } });
  await ev(`(window.__finals7 = [], (() => { const c = new MessageChannel(); c.port1.onmessage = (e) => { if (e.data.items) window.__finals7.push(e.data); }; navigator.serviceWorker.controller.postMessage({ offline: "fetch", build: ${J(A)}, items: "all" }, [c.port2]); })(), 1)`);
  ok(await until(async () => (await stops()) > s7, 30000), "N7 (setup): the job is held at its first put");
  await sleep(2500);
  await hook({ resume: true });
  // (sticky, grader's T1: the job gone from status, the finals read; 5 s later read again: one final both times)
  ok(await until(async () => !(await status()).job, 60000), "N7 (sticky): the job has left the status");
  const first7 = (await ev("window.__finals7")).length;
  await sleep(5000);
  const r = await ev("window.__finals7");
  ok(first7 === 1 && r.length === 1, `N7: one final message once the job is gone, and still one 5 s later (${first7}, ${r.length})`);
  ok(r.length === 1 && !r[0].done && Array.isArray(r[0].failed) && Array.isArray(r[0].items) && (r[0].failed.length > 0 || r[0].items.length < all.length), "N7: the deadline settles the job once, not done, with its lists: " + J(r.map((m) => ({ done: m.done, failed: m.failed?.length, items: m.items?.length }))));
  await hook({ scale: 1 });
  const again = await api({ offline: "fetch", build: A, items: "all" }, 600000);
  ok(again.last?.done === true, "(everything downloaded again for the deploy rows): " + J({ done: again.last?.done, error: again.last?.error, failed: again.last?.failed?.slice(0, 3), timeout: again.timeout }));
}

// C1, C2, C4 [hook]: bodies with no Content-Length: one past its size, a 32 MiB one, one that never ends (the stall
// timer, time-scaled to 1 s, aborts and retries once): each put rejects, nothing is stored, the buffers stay bounded
{
  const mods = itemPaths("modules");
  await api({ offline: "remove", build: A, items: ["modules"] }, 30000);
  const [p0, p1, p2] = mods.filter((p) => size(p) < 8 * MiB);
  overrides[urlOf.get(p0)] = { bytes: size(p0) + MiB, hang: false };
  overrides[urlOf.get(p1)] = { bytes: Math.floor(size(p1) / 2), hang: true };
  overrides[urlOf.get(p2)] = { bytes: 32 * MiB, hang: false };
  saveOverrides();
  await hook({ scale: 1 / 60, reset: true });
  await clearHttp();
  const mark = requests().length;
  const r = await api({ offline: "fetch", build: A, items: ["modules"] }, 120000);
  const why = Object.fromEntries((r.last?.failed ?? []).map((f) => ["/" + f.path, f.reason]));
  ok(why[p0] === "size" && why[p2] === "size", "C1/C2: a body past its size and a 32 MiB body fail with size: " + J([why[p0], why[p2]]));
  ok(why[p1] === "stalled" && requests().slice(mark).filter((u) => u === urlOf.get(p1)).length === 2, "C4: a body that stops is aborted by the stall timer and retried once: " + why[p1]);
  const c = await copies(), h = await hook();
  ok(![p0, p1, p2].some((p) => c.out[p]), "C1/C2/C4: none of them is stored");
  ok(h.budgetPeak <= 64 * MiB, `C2: the buffered peak ${h.budgetPeak} stays within 64 MiB`);
  for (const p of [p0, p1, p2]) delete overrides[urlOf.get(p)];
  saveOverrides();
  await hook({ scale: 1 });
  ok((await api({ offline: "fetch", build: A, items: ["modules"] })).last?.done === true, "(the modules downloaded again)");
}

// C3 [hook]: the probe forced false: status says unsupported, fetch is refused before any request, and loading a
// library file still works
{
  await hook({ probe: false });
  await api({ offline: "remove", build: A, items: ["docs"] }, 30000);
  const mark = requests().length;
  const st = await status(), f = await api({ offline: "fetch", build: A, items: ["docs"] }, 15000);
  ok(st.supported === false && f.last?.error === "unsupported" && requests().length === mark, "C3: unsupported: status says so, fetch is refused, nothing requested: " + J(f.last));
  ok((await ev(`fetch("/docs-index.json").then((r) => r.status)`)) === 200, "C3: the app still loads a file it needs");
  await stopWorkers();
  ok((await api({ offline: "fetch", build: A, items: ["docs"] })).last?.done === true, "(after a restart the probe is real again; docs downloaded again)");
}

// N19 [hook]: pkgClear keeps an entry pinned less than 10 min ago, removes one pinned longer ago, and is serialized
// with a package install
{
  const body = (s) => J({ pkg: s, pad: "x".repeat(1000) });
  const d = (s) => createHash("sha256").update(body(s)).digest("hex");
  const now = Date.now();
  await ev(`(async () => {
    const c = await caches.open("sb-pkg-v1");
    for (const s of ["pinned", "stale"]) {
      const b = ${J({ pinned: body("pinned"), stale: body("stale") })}[s];
      await c.put(new Request(location.origin + "/pkg/" + ${J({ pinned: d("pinned"), stale: d("stale") })}[s] + ".json"), new Response(b, { headers: { "Content-Type": "application/json" } }));
    }
    await new Promise((resolve, reject) => {
      const o = indexedDB.open("sb-pkg-ledger", 2);
      o.onupgradeneeded = () => o.result.objectStoreNames.contains("e") || o.result.createObjectStore("e", { keyPath: "digest" });
      o.onsuccess = () => {
        const t = o.result.transaction("e", "readwrite"), s = t.objectStore("e");
        s.put({ digest: ${J(d("pinned"))}, bytes: ${body("pinned").length}, used: ${now}, pin: ${now + 5 * 60000}, state: "kept" });
        s.put({ digest: ${J(d("stale"))}, bytes: ${body("stale").length}, used: ${now}, pin: ${now - 60000}, state: "kept" });
        t.oncomplete = () => (o.result.close(), resolve());
      };
      o.onerror = () => reject(o.error);
    });
  })()`);
  let r = await api({ offline: "pkgClear", build: A }, 15000);
  ok(r.last?.removed?.entries === 1 && r.last.keptPinned === 1, "N19: pkgClear removes the entry pinned 11 min ago and keeps the one pinned 5 min ago: " + J(r.last));
  const left = await ev(`caches.open("sb-pkg-v1").then((c) => c.keys()).then((ks) => ks.map((k) => k.url.split("/pkg/")[1]))`);
  ok(left.length === 1 && left[0] === d("pinned") + ".json", "N19: the pinned entry is the one left: " + J(left));
  // (an install held at its put: pkgClear answers only after it is resumed)
  const file = join(tmp, "pkg-new.json");
  writeFileSync(file, body("new"));
  overrides[`/pkg/${d("new")}.json`] = { file };
  saveOverrides();
  await hook({ stop: { op: "put", cache: "sb-pkg-v1", url: d("new"), when: "before" } });
  const s0 = await stops();
  await ev(`fetch("/pkg/${d("new")}.json").then((r) => r.text()).then(() => 1)`);
  ok(await until(async () => (await stops()) > s0, 10000), "N19 (setup): the install is held at its put");
  r = await ev(`new Promise((resolve) => {
    const c = new MessageChannel(), at = Date.now(); let early = null;
    c.port1.onmessage = (e) => resolve({ reply: e.data, after: Date.now() - at, early });
    setTimeout(() => resolve({ timeout: true }), 30000);
    navigator.serviceWorker.controller.postMessage({ offline: "pkgClear", build: ${J(A)} }, [c.port2]);
    setTimeout(() => { const h = new MessageChannel(); navigator.serviceWorker.controller.postMessage({ offlineTest: { resume: true } }, [h.port2]); }, 2000);
  })`);
  ok(r.after >= 2000 && r.reply?.removed?.entries === 1, "N19: pkgClear waits for the install in the package queue, then removes it: " + J(r));
  // (I1: pkgClear stopped between marking an entry and deleting it: the next one reconciles; no row without its entry)
  await ev(`(async () => {
    await (await caches.open("sb-pkg-v1")).put(new Request(location.origin + "/pkg/${d("stale2")}.json"), new Response(${J(body("stale2"))}));
    await new Promise((resolve) => {
      const o = indexedDB.open("sb-pkg-ledger", 2);
      o.onsuccess = () => { const t = o.result.transaction("e", "readwrite"); t.objectStore("e").put({ digest: ${J(d("stale2"))}, bytes: ${body("stale2").length}, used: ${now}, pin: 0, state: "kept" }); t.oncomplete = () => (o.result.close(), resolve()); };
    });
    return 1;
  })()`);
  await hook({ stop: { op: "delete", cache: "sb-pkg-v1", url: d("stale2"), when: "before" } });
  const s1 = await stops();
  await ev(`(navigator.serviceWorker.controller.postMessage({ offline: "pkgClear", build: ${J(A)} }, [new MessageChannel().port2]), 1)`);
  ok(await until(async () => (await stops()) > s1, 10000), "I1 (setup): pkgClear stopped before its delete");
  const ledger = () => ev(`new Promise((resolve) => { const o = indexedDB.open("sb-pkg-ledger", 2); o.onsuccess = () => { const q = o.result.transaction("e").objectStore("e").getAll(); q.onsuccess = () => (o.result.close(), resolve(q.result.map((r) => r.digest.slice(0, 8) + ":" + r.state))); }; })`);
  const mid = await ledger();
  await stopWorkers();
  r = await api({ offline: "pkgClear", build: A }, 15000);
  const after = await ledger(), entries = await ev(`caches.open("sb-pkg-v1").then((c) => c.keys()).then((ks) => ks.map((k) => k.url.split("/pkg/")[1].slice(0, 8)))`);
  ok(mid.includes(d("stale2").slice(0, 8) + ":deleting") && !after.some((x) => x.startsWith(d("stale2").slice(0, 8))) && !entries.includes(d("stale2").slice(0, 8)) && after.length === entries.length, `I1: interrupted at "deleting", the next pkgClear reconciles: rows ${J(after)}, entries ${J(entries)}`);
  // (removing an item a notebook has in use still removes it: the docs index the page fetched)
  await ev(`fetch("/docs-index.json").then((r) => r.text()).then(() => 1)`);
  r = await api({ offline: "remove", build: A, items: ["docs"] }, 30000);
  const st = await status();
  ok(r.last?.done && !st.present.includes("docs-index.json"), "N19: an item in use is removed");
  await api({ offline: "fetch", build: A, items: ["docs"] });
}

// N12 + N13 [hook], deploy B: activate copies nothing (the walk paused at its first put, the new build already in
// control), a fetch during the pending walk is answered in 2 s; a poisoned source of more than 1,200 keys is looked at
// only up to 1,200, its extra entries deleted and an oversized one under a real key not carried
const X = "/docs-index.json", big0 = LAZY.filter(cacheFirst).reduce((a, p) => (size(p) > size(a) ? p : a));
{
  const magma = itemPaths("magma");
  await api({ offline: "remove", build: A, items: ["magma"] }, 30000);
  const junk = "sagebrush-00000000000000ff";
  await ev(`(async () => {
    const c = await caches.open(${J(junk)});
    await c.put(new Request(${J(magma[0])}), new Response(new Uint8Array(${17 * MiB})));
    for (let i = 0; i < 1300; i++) await c.put(new Request("/junk/" + i), new Response("j"));
    return 1;
  })()`);
  const aKeys = await ev(`caches.open(${J(cacheOf(A))}).then((c) => c.keys()).then((k) => k.length)`);
  const tDeploy = Date.now(), s12 = await stops();
  const { v: B, on } = await deploy({ stop: { op: "put", url: "", cache: "$NEW", when: "before", walk: true } });
  ok(await until(async () => (await stops()) > s12 && (await rec("moving"))?.to === cacheOf(B), 60000), "N12 (setup): the walk is paused at its first move: " + J(await rec("moving")));
  console.log("(N12: deploy at " + tDeploy + ", controlled at " + Date.now() + "; the worker: " + J(await hook()) + "; stored sources " + J(await rec("sources")) + ", active " + J(await rec("active")) + ")");
  ok(on, "N12: the new build controls the page while its walk is paused (activate doesn't wait for copying)");
  const inB = await ev(`caches.open(${J(cacheOf(B))}).then((c) => c.keys()).then((ks) => ks.filter((k) => ${J(LAZY)}.includes(new URL(k.url).pathname)).length)`);
  ok(inB === 0, "N12: activate copied nothing: " + inB + " LAZY entries in the new cache");
  await clearHttp();
  const markG7 = requests().length, t0 = Date.now(), got = await ev(`fetch(${J(urlOf.get(big0))}).then((r) => r.status)`), dt = Date.now() - t0;
  ok(got === 200 && dt < 2000, `N12: a fetch during the pending walk is answered in ${dt} ms (from the older build's copy)`);
  const g7 = requests().slice(markG7);
  const aCopy = g7.length && (await ev(`caches.open(${J(cacheOf(A))}).then((c) => c.match(${J(urlOf.get(big0))})).then((r) => r ? r.arrayBuffer().then((b) => b.byteLength) : "none")`));
  ok(!g7.some((p) => p.split("?")[0] === big0), "G7: it came from the older build's copy, not the network: requests since " + J(g7.slice(0, 8)) + (g7.length ? `; the old build's copy: ${aCopy} (expected ${size(big0)}); stored sources ${J(await rec("sources"))}, the worker: ${J(await hook())}, the last stop: ${J(await ev("window.__stops.at(-1)"))}, migration ${J(await rec("migration"))}` : ""));
  await hook({ resume: true });
  ok(await until(async () => (await rec("migration"))?.carried > 0 && !(await rec("moving")), 120000), "N12: the walk ends with sb-offline.migration: " + J(await rec("migration")));
  const h = await hook();
  ok(h.keysLooked <= aKeys + 1200 && h.keysLooked >= 1200, `N13: keys looked at: ${h.keysLooked} (the old build's ${aKeys} and at most 1,200 of the poisoned source's 1,301)`);
  const junkLeft = await ev(`caches.open(${J(junk)}).then((c) => c.keys()).then((k) => k.map((x) => new URL(x.url).pathname))`);
  const c = await copies();
  ok(!c.out[magma[0]] && junkLeft.length === 101 && !junkLeft.includes(magma[0]), `N13: the oversized entry is not carried (deleted), and only the 101 keys past the bound are left: ${junkLeft.length}`);
  ok(Object.values(c.out).every((l) => l.length === 1 && l[0] === cacheOf(B)), "G1: after the walk every kept path has one copy, in the new build's cache");
}

// N17 [hook], deploys C and D: §14 S2 (stop after the put, before the verify; corrupt; restart) and (stop after the
// commit, before the source delete; restart); the intent's fields at each stop
// G4 [hook]: a corrupt source entry is deleted and not carried; with a corrupt newest copy, the older good one is
// kept and carried
{
  const from = cacheOf(await version()), bad = LAZY.filter((p) => cacheFirst(p) && p !== X)[0], planted = "sagebrush-00000000000000ee";
  const wrong = (p) => `new Response(new Uint8Array(${size(p)}).fill(7))`;
  await ev(`(async () => {
    await (await caches.open(${J(from)})).put(new Request(${J(urlOf.get(bad))}), ${wrong(bad)});
    await (await caches.open(${J(planted)})).put(new Request(${J(urlOf.get(X))}), ${wrong(X)});
    return 1;
  })()`);
  const { v } = await deploy();
  ok(await until(async () => J(await rec("sources")) === "[]" && !(await rec("moving")), 120000), "G4: the walk ends");
  const c = await copies();
  ok(!c.out[bad] && J(c.out[X]) === J([cacheOf(v)]) && !(await ev(`caches.has(${J(planted)})`)), `G4: the corrupt entry is not carried, and the older good copy is the one kept: ${J({ bad: c.out[bad], X: c.out[X] })}`);
  ok((await api({ offline: "fetch", build: v, items: "all" }, 600000)).last?.done === true, "(the corrupt one downloaded again)");
}

let current = await version();
for (const [name, stop, corrupt] of [["after the put, before the verify", { op: "put", when: "after" }, true], ["after the commit, before the source delete", { op: "delete", when: "before" }, false]]) {
  const from = cacheOf(current);
  const s0 = await stops();
  const { v } = await deploy({ stop: { ...stop, url: X, cache: stop.op === "put" ? "$NEW" : from } });
  current = v;
  ok(await until(async () => (await stops()) > s0, 60000), `N17 (${name}): stopped there`);
  const m = await rec("moving");
  ok(m?.path === X && m.key === new URL(urlOf.get(X), url).href && m.from === from && m.to === cacheOf(v) && m.build === v && m.state === (corrupt ? "copying" : "committed"), `N17 (${name}): the intent {path, key, from, to, build, state}: ${J(m)}`);
  if (corrupt) await ev(`caches.open(${J(cacheOf(v))}).then((c) => c.put(new Request(${J(X)}), new Response("not the index"))).then(() => 1)`);
  await stopWorkers();
  await status();
  ok(await until(async () => !(await rec("moving")) && !(await ev(`caches.has(${J(from)})`)), 120000), `N17 (${name}): after the restart the walk ends, the old cache emptied`);
  const c = await copies();
  // (checked here against the build's digest: the worker's own "verified" is per lifetime, and this one restarted)
  const sha = await ev(`caches.open(${J(cacheOf(v))}).then((c) => c.match(${J(urlOf.get(X))})).then((r) => r.arrayBuffer()).then((b) => crypto.subtle.digest("SHA-256", b)).then((d) => [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join(""))`);
  ok(J(c.out[X]) === J([cacheOf(v)]) && sha === DIGESTS[X.slice(1)].sha256, `N17 (${name}): exactly one copy remains, and it is the build's file: ${J(c.out[X])}`);
}

// N16 [hook]: the same entry interrupted after the put and before the source delete on each of four deploys, the
// worker stopped there each time, then a quota pause; the bound holds at each step; after the next start, one copy
{
  // (the stopped worker is never messaged in between: that would restart it and finish its move)
  for (let i = 0; i < 4; i++) {
    const from = cacheOf(current), s0 = await stops();
    current = (await deploy({ stop: { op: "delete", when: "before", url: X, cache: from } })).v;
    const stopped = await until(async () => (await stops()) > s0, 60000);
    const b = bound(await copies());
    ok(stopped && b.ok, `N16: deploy ${i + 1}, stopped before the source delete: ${J(b)}`);
    await stopWorkers();
  }
  const Q = 5 * 1024 * MiB;
  const { v } = await deploy({ quota: { quota: Q, usage: Q - Q / 5 } });
  current = v;
  ok(await until(async () => (await rec("migration"))?.paused === "quota", 60000), "N16: the walk pauses for quota: " + J(await rec("migration")));
  const b = bound(await copies());
  ok(b.twice === 0 && b.ok, "N16: paused, no path has two copies: " + J(b));
  await stopWorkers();
  await status();
  ok(await until(async () => J(await rec("sources")) === "[]", 120000), "N16: the next start resumes the walk to the end");
  const c = await copies();
  ok(Object.values(c.out).every((l) => l.length === 1 && l[0] === cacheOf(v)), "N16: after the next start, exactly one copy of each path, in the current cache");
}

// N14 [hook]: an item removed while a background keep re-fetch is pending is never fetched or re-added
{
  const magma = itemPaths("magma");
  await api({ offline: "remove", build: await version(), items: ["magma"] }, 30000);
  await api({ offline: "keep", build: await version(), mode: "all" }, 15000);
  ok(!(await copies()).out[magma[0]], "N14 (setup): magma is not on the device, and 'keep everything' is on");
  const s0 = await stops();
  const { v } = await deploy({ stop: { op: "put", url: "", cache: "$NEW", when: "before", walk: true } });
  ok(await until(async () => (await stops()) > s0, 60000), "N14 (setup): the walk is paused");
  const mark = requests().length;
  const removed = ev(`new Promise((resolve) => { const c = new MessageChannel(); c.port1.onmessage = (e) => resolve(e.data); navigator.serviceWorker.controller.postMessage({ offline: "remove", build: ${J(v)}, items: ["magma"] }, [c.port2]); })`);
  await sleep(500);
  await hook({ resume: true });
  ok((await removed)?.done === true, "N14: the remove is answered after the walk");
  await until(async () => !(await status()).job && (await rec("keep"))?.removed?.includes("magma"), 120000);
  await sleep(2000);
  const asked = requests().slice(mark).filter((p) => magma.includes(p.split("?")[0]));
  ok(!(await copies()).out[magma[0]] && asked.length === 0, `N14: magma is neither fetched (${asked.length} requests) nor re-added`);
  await api({ offline: "keep", build: v, mode: "off" }, 15000);
}

// N18 [hook]: "keep" consents to the totals at opt-in; a later build up to 1.25x of them (stored, transfer, each) is
// kept up, 1 byte more pauses it
{
  const variant = (stored, transfer, extra) => {
    const doc = JSON.parse(invText);
    Object.assign(doc.items.find((it) => it.id === "docs"), { stored, transfer });
    if (extra) doc.items.push({ id: "pkg-new", kind: "package", title: "New", groups: ["pkg-new"], files: 1, stored: 50000, transfer: 20000 });
    const text = JSON.stringify(doc), file = join(tmp, `inv-${stored}-${transfer}.json`);
    writeFileSync(file, text);
    const d = DIGESTS["offline-inventory.json"], sha = createHash("sha256").update(text).digest("hex");
    return {
      file,
      edit: (t) => t.replace(`"offline-inventory.json":{"sha256":"${d.sha256}","size":${d.size},`, `"offline-inventory.json":{"sha256":"${sha}","size":${Buffer.byteLength(text)},`),
    };
  };
  const at = async (stored, transfer, settings = {}, extra = false) => {
    const x = variant(stored, transfer, extra);
    overrides["/offline-inventory.json"] = { file: x.file };
    saveOverrides();
    // (a sentinel the new build's keep-up overwrites: undefined fields don't survive the page's returnByValue)
    const keep = await rec("keep");
    if (keep) await idb("sb-offline", "keep", { ...keep, paused: "unset", need: undefined });
    const { v } = await deploy(settings, x.edit);
    if (keep) ok(await until(async () => (await rec("keep"))?.paused !== "unset", 60000), "(N18: the new build's keep-up ran)");
    return { v, keep: await rec("keep") };
  };
  let { v } = await at(4000, 4000);
  const r = await api({ offline: "keep", build: v, mode: "items", items: ["docs"] }, 15000);
  const k = await rec("keep");
  ok(r.last?.ok === true && J(k?.consent) === J({ build: v, stored: 4000, transfer: 4000 }), "N18: keep answers {ok} and records this build's totals: " + J(k?.consent));
  for (const [stored, transfer, paused] of [[5000, 4000, false], [5001, 4000, true], [4000, 5000, false], [4000, 5001, true]]) {
    const { keep } = await at(stored, transfer);
    if (!keep) { ok(false, `N18: stored ${stored}, transfer ${transfer}: no keep record`); continue; }
    ok(!!keep.paused === paused && (!paused || J(keep.need) === J({ stored, transfer })), `N18: stored ${stored}, transfer ${transfer} (consented 4000/4000): ${paused ? "paused, with the need" : "kept up"}: ${J({ paused: keep.paused, need: keep.need })}`);
  }
  // (H3: a new item in the next build is listed as new, never fetched)
  const { v: vn } = await at(4000, 4000, {}, true);
  const keepNew = (await api({ offline: "status", build: vn }, 15000)).last?.keep;
  ok(keepNew?.new?.includes("pkg-new") && !keepNew.paused, "H3: a new item is listed in keep.new and not fetched: " + J(keepNew?.new));
  delete overrides["/offline-inventory.json"];
  saveOverrides();
  await deploy();
  await api({ offline: "keep", build: await version(), mode: "off" }, 15000);
}

// N2 [hook]: no BYOB (the probe forced false): the carry-over is refused before any cache read (old caches deleted
// as before this plan), fetch is refused, nothing goes to the network, and serving still works
{
  const old = cacheOf(await version()), mark = requests().length;
  const { v } = await deploy({ probe: false });
  ok(await until(async () => (await rec("migration"))?.error === "unsupported", 60000), "N2: the carry-over is refused: " + J(await rec("migration")));
  const st = await status();
  const f = await api({ offline: "fetch", build: v, items: ["docs"] }, 15000);
  ok(st.supported === false && f.last?.error === "unsupported" && !(await ev(`caches.has(${J(old)})`)), "N2: status says unsupported, fetch is refused, the old build's cache is deleted: " + J(f.last));
  const lazyAsked = requests().slice(mark).filter((p) => LAZY.includes(p.split("?")[0]));
  ok(lazyAsked.length === 0, "N2: no LAZY request reached the server: " + J(lazyAsked.slice(0, 3)));
  // (serving is unchanged without the probe: a library chunk fetched once is kept, and the next fetch is its kept copy)
  const chunk = LAZY.filter((p) => cacheFirst(p) && size(p) < MiB)[0];
  await clearHttp();
  const first = await ev(`fetch(${J(urlOf.get(chunk))}).then((r) => r.arrayBuffer()).then((b) => b.byteLength)`);
  await sleep(1500);
  await clearHttp();
  const m2 = requests().length;
  const again = await ev(`fetch(${J(urlOf.get(chunk))}).then((r) => r.arrayBuffer()).then((b) => b.byteLength)`);
  ok(first === size(chunk) && again === size(chunk) && !requests().slice(m2).length, "N2: serving still keeps and serves verified copies: " + J({ chunk, first, again, requests: requests().slice(m2) }));
}

// N1 [hook]: a build whose own lists exceed a cap (one LAZY entry sized past 16 MiB) refuses fetch and the
// carry-over with catalog-cap; serving is unchanged
{
  const big = LAZY[0].slice(1), d = DIGESTS[big];
  const { v } = await deploy({}, (t) => t.replace(`${J(big)}:{"sha256":"${d.sha256}","size":${d.size},`, `${J(big)}:{"sha256":"${d.sha256}","size":${17 * MiB},`));
  ok(await until(async () => (await rec("migration"))?.error === "catalog-cap", 60000), "N1: the carry-over is refused with catalog-cap: " + J(await rec("migration")));
  const f = await api({ offline: "fetch", build: v, items: ["docs"] }, 15000);
  const st = await status();
  ok(f.last?.error === "catalog-cap" && st.error === "catalog-cap", "N1: fetch is refused with catalog-cap, and status says so: " + J(f.last));
  await send("Page.reload");
  ok(await until(() => ev("document.querySelector('#status')?.textContent.startsWith('ready')")), "N1: the app still loads (serving unchanged)");
}

cleanup();
console.log(failures ? `${failures} failure(s)` : "all ok");
process.exit(failures ? 1 : 0);
