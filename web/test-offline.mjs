// ci: none (not run by CI before test discovery, Nov 2 2026: a wiring candidate)
// Storage -> Offline's service-worker side (plan-b8-offline r3.4): the API's grammar, what is downloaded and checked,
// "download all" (join, cancel, remove), repairing a bad kept copy, and the error a notebook shows offline.
//
//   bun web/build.ts && node web/test-offline.mjs      (CHROME=... for the browser)
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, freePort } from "./test-port.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const t0 = Date.now();
const ok = (cond, name) => { console.log((cond ? "ok   " : "FAIL ") + name + ` [${Math.round((Date.now() - t0) / 1000)} s]`); if (!cond) failures++; };
const here = new URL(".", import.meta.url).pathname;
const port = await freePort();
const tmp = mkdtempSync(join(tmpdir(), "sb-offline-ov-")), overrides = join(tmp, "overrides.json"), logFile = join(tmp, "requests.log");
writeFileSync(overrides, "{}");
writeFileSync(logFile, "");
const ov = {};
const setOverrides = (o) => (Object.assign(ov, o), writeFileSync(overrides, JSON.stringify(ov)));
const requests = () => readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).path);
let server = spawn("python3", [join(here, "serve.py"), String(port)], { stdio: "ignore", env: { ...process.env, SB_SERVE_OVERRIDES: overrides, SB_SERVE_LOG: logFile } });
await sleep(800);
const profile = mkdtempSync(join(tmpdir(), "sb-offline-"));
let cdpPort = Number(process.env.CDP_PORT) || 0;
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!cdpPort) cdpPort = await devtoolsPort(profile);
const cleanup = () => { chrome.kill(); server.kill(); };
process.on("uncaughtException", (e) => { console.log("FAIL " + (e?.stack ?? e)); cleanup(); process.exit(1); });
// (a whole-run bound: a hang fails the run instead of holding its test slot)
setTimeout(() => { console.log("FAIL the run did not finish in 15 min (a hang)"); cleanup(); process.exit(1); }, 15 * 60000).unref();
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
const until = async (expr, ms = 30000) => { for (let i = 0; i < ms / 100; i++) { if (await ev(expr)) return true; await sleep(100); } return false; };
const ready = () => until("document.querySelector('#status')?.textContent.startsWith('ready')");

// one API call from the page: its replies on a fresh port until a final one ({error}, {done|failed|cancelled}, or
// any reply to a non-fetch message), at most `ms`
async function api(msg, ms = 120000) {
  return ev(`new Promise((resolve) => {
    const c = new MessageChannel(), got = [];
    const t = setTimeout(() => resolve({ timeout: true, got }), ${ms});
    c.port1.onmessage = (e) => {
      got.push(e.data);
      const m = e.data, fetching = ${JSON.stringify(msg?.offline === "fetch")};
      if (!fetching || m.error || m.done || m.failed || m.cancelled) { clearTimeout(t); resolve({ last: m, got }); }
    };
    navigator.serviceWorker.controller.postMessage(${JSON.stringify(msg)}, [c.port2]);
  })`);
}
// (the browser's HTTP cache emptied: LAZY files are immutable, so a fetch could otherwise be answered without the server)
const clearHttp = async () => { await send("Network.enable"); await send("Network.clearBrowserCache"); };
const swVersion = () => ev(`fetch("sw.js", { cache: "no-store" }).then((r) => r.text()).then((t) => /const VERSION = "([0-9a-f]+)"/.exec(t)?.[1])`);
const cacheName = () => ev(`caches.keys().then((ks) => ks.find((k) => k.startsWith("sagebrush-")))`);
const inv = JSON.parse(readFileSync(join(here, "dist", "offline-inventory.json"), "utf8"));
const SWT = readFileSync(join(here, "dist", "sw.js"), "utf8"), literal = (name) => JSON.parse(new RegExp(`^const ${name} = (.*);$`, "m").exec(SWT)[1]);
const LAZYU = literal("LAZY").map((u) => "/" + u), DIGESTS = literal("DIGESTS");
const sizeOf = (u) => DIGESTS[u.slice(1).split("?")[0]].size;
// (an item's LAZY URLs: its groups' chunks, as the service worker resolves them)
const itemUrls = (id) => { const gs = inv.items.find((it) => it.id === id)?.groups ?? []; return LAZYU.filter((u) => gs.includes(/^\/lib\/([a-z0-9-]+)\.(?:src|pre)\.[0-9a-f]{16}\.json/.exec(u)?.[1])); };
const pathsOf = (group) => LAZYU.filter((u) => new RegExp(`^/lib/${group}\\.(?:src|pre)\\.[0-9a-f]{16}\\.json`).test(u));

const url = `http://127.0.0.1:${port}/`;
await send("Page.navigate", { url });
await ready();
ok(await until("navigator.serviceWorker.controller !== null", 30000) || (await send("Page.reload"), await ready(), await until("navigator.serviceWorker.controller !== null")), "the service worker controls the page");
const build = await swVersion();
ok(/^[0-9a-f]{16}$/.test(build ?? ""), "the build's version: " + build);

// A: the grammar (§4, §9)
for (const [name, msg] of [
  ["a missing build", { offline: "status" }],
  ["an extra field", { offline: "status", build, x: 1 }],
  ["an unknown message", { offline: "nope", build }],
  ["fetch without items", { offline: "fetch", build }],
  ["fetch with an unknown id", { offline: "fetch", build, items: ["no-such-item"] }],
  ["fetch with 65 ids", { offline: "fetch", build, items: Array.from({ length: 65 }, () => "docs") }],
  ["fetch with a non-string id", { offline: "fetch", build, items: [1] }],
  ["remove with \"all\"", { offline: "remove", build, items: "all" }],
  ["keep with a bad mode", { offline: "keep", build, mode: "some" }],
]) {
  const r = await api(msg, 10000);
  ok(r.last?.error === "refused", `A: ${name} is refused: ${JSON.stringify(r.last)}`);
}
{
  const r = await api({ offline: "status", build: "0000000000000000" }, 10000);
  ok(r.last?.error === "stale-build" && r.last.build === build, "A: another build's message is refused as stale: " + JSON.stringify(r.last));
  const silent = await ev(`new Promise((resolve) => { const t = setTimeout(() => resolve("no reply"), 3000); navigator.serviceWorker.addEventListener("message", () => (clearTimeout(t), resolve("a reply to the page"))); navigator.serviceWorker.controller.postMessage({ offline: "status", build: ${JSON.stringify(build)} }); })`);
  ok(silent === "no reply", "A: a message without a port gets no reply anywhere: " + silent);
}

// A2: duplicate ids are one; A3: a message from a worker (not a window) is refused, or can't be sent at all
{
  const r = await api({ offline: "fetch", build, items: ["docs", "docs"] });
  ok(r.last?.done === true && JSON.stringify(r.last.items) === '["docs"]', "A2: duplicate ids are deduplicated: " + JSON.stringify(r.last?.items));
  const w = await ev(`new Promise((resolve) => {
    const src = "const c = self.navigator.serviceWorker; if (!c || !c.controller) postMessage('no container'); else { const m = new MessageChannel(); m.port1.onmessage = (e) => postMessage(JSON.stringify(e.data)); c.controller.postMessage({ offline: 'status', build: " + ${JSON.stringify(JSON.stringify(build))} + " }, [m.port2]); }";
    const wk = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    wk.onmessage = (e) => resolve(e.data);
    setTimeout(() => resolve("no reply"), 5000);
  })`);
  ok(w === '{"error":"refused"}' || w === "no container", "A3: a worker's message is refused (or a worker can't reach the service worker in this browser): " + w);
}

// B: status before anything was downloaded (§4)
let st = (await api({ offline: "status", build }, 10000)).last;
ok(st?.build === build && st.supported === true && Array.isArray(st.present) && Array.isArray(st.verified), "B: status answers (BYOB supported in this browser): " + JSON.stringify({ supported: st?.supported, present: st?.present?.length, verified: st?.verified?.length }));

// D: download one item; then all, from two pages at once (the second joins); progress then a final message
const docs = inv.items.find((it) => it.id === "docs");
let r = await api({ offline: "fetch", build, items: ["docs"] });
ok(r.last?.done === true && r.last.items?.includes("docs") && r.got[0]?.filesTotal === docs.files && r.got[0]?.bytesTotal === docs.stored, "D: fetching docs: its first message gives the totals, the last is done: " + JSON.stringify({ first: r.got[0], last: r.last }));
st = (await api({ offline: "status", build }, 10000)).last;
ok(["docs-index.json", "docs-index-python.json"].every((p) => st.present.includes(p) && st.verified.includes(p)), "B: the downloaded files are present and verified");

// B2: a kept copy changed in the cache (present, not checked): served? no; fetch repairs it
const name = await cacheName();
await ev(`caches.open(${JSON.stringify(name)}).then((c) => c.put(new Request("docs-index-matlab.json"), new Response("not the index", { headers: { "Content-Type": "application/json" } })))`);
ok(await ev(`fetch("docs-index-matlab.json").then((r) => r.text()).then((t) => t !== "not the index")`), "B: a corrupted kept copy is never served (dropped, fetched again)");
await ev(`caches.open(${JSON.stringify(name)}).then((c) => c.put(new Request("docs-index-matlab.json"), new Response("x".repeat(10), { status: 200 })))`);
r = await api({ offline: "fetch", build, items: ["docs"] });
ok(r.last?.done === true, "B: fetch repairs a corrupted kept copy (and reports done): " + JSON.stringify(r.last));
ok(await ev(`caches.open(${JSON.stringify(name)}).then((c) => c.match("docs-index-matlab.json")).then((x) => x.text()).then((t) => t.length > 10)`), "B: the repaired copy is the real file");
// B3/B4: right bytes, wrong metadata: a cache-first file (a library chunk, served from its kept copy even online),
// kept, then rewritten in the cache with its right bytes and poisoned headers: served with the build's headers only
{
  const u = LAZYU.find((x) => /^\/lib\/[a-z0-9-]+\.(src|pre)\.[0-9a-f]{16}\.json$/.test(x) && sizeOf(x) < 200000);
  await ev(`fetch(${JSON.stringify(u)}).then((r) => r.arrayBuffer()).then(() => 1)`);
  const keptB = () => ev(`caches.open(${JSON.stringify(name)}).then((c) => c.match(${JSON.stringify(u)})).then((x) => !!x)`);
  for (let i = 0; i < 100 && !(await keptB()); i++) await sleep(100);
  await ev(`(async () => { const c = await caches.open(${JSON.stringify(name)}); const b = await (await c.match(${JSON.stringify(u)})).arrayBuffer(); await c.put(new Request(${JSON.stringify(u)}), new Response(b, { status: 200, headers: { "Content-Type": "text/html", "X-Poison": "1" } })); return 1; })()`);
  const mark = requests().length;
  const h = await ev(`fetch(${JSON.stringify(u)}).then((r) => [r.headers.get("content-type"), r.headers.get("x-poison"), r.headers.get("x-content-type-options")])`);
  ok(h?.[0] === "application/json" && h[1] === null && h[2] === "nosniff" && requests().slice(mark).length === 0, "B3: a kept copy with the right bytes and poisoned headers is served from the cache with the build's headers: " + JSON.stringify([u, h]));
}

// B5: a kept copy of the wrong length, longer or shorter, is never served: the right file is, and the copy repaired
for (const [what, len] of [["longer", +5], ["shorter", -5]]) {
  const u = LAZYU.find((x) => /\?h=/.test(x) && sizeOf(x) > 64) ?? LAZYU.find((x) => /\/lib\//.test(x));
  await ev(`(async () => { const c = await caches.open(${JSON.stringify(name)}); await c.put(new Request(${JSON.stringify(u)}), new Response(new Uint8Array(${sizeOf(u)} + (${len})))); return 1; })()`);
  const got = await ev(`fetch(${JSON.stringify(u)}).then((r) => r.arrayBuffer()).then((b) => b.byteLength)`);
  // (the repaired copy is kept in the background, after the response: waited for, up to 10 s)
  const keptLen = () => ev(`caches.open(${JSON.stringify(name)}).then((c) => c.match(${JSON.stringify(u)})).then((x) => x ? x.arrayBuffer().then((b) => b.byteLength) : 0)`);
  for (let i = 0; i < 100 && (await keptLen()) !== sizeOf(u); i++) await sleep(100);
  const fixed = await keptLen();
  ok(got === sizeOf(u) && fixed === sizeOf(u), `B5: a ${what} kept copy is refused: the right file is served (${got}) and kept (${fixed})`);
}

// D: all, from this page and a second one at once: one job
await send("Target.createTarget", { url });
const two = await Promise.all([api({ offline: "fetch", build, items: "all" }, 600000), (async () => { await sleep(500); return api({ offline: "fetch", build, items: ["sage"] }, 600000); })()]);
ok(two[0].last?.job && two[0].last.job === two[1].last?.job, "D: a second fetch while one runs joins it (one job id): " + JSON.stringify([two[0].last?.job, two[1].last?.job]));
ok(two[0].last?.done === true && two[0].last.items.length === inv.items.length, "D: download all completes: every item " + JSON.stringify({ done: two[0].last?.done, items: two[0].last?.items?.length, of: inv.items.length, failed: two[0].last?.failed }));
const progress = two[0].got.filter((m) => m.filesDone !== undefined && !m.done && !m.failed);
ok(progress.length >= 1 && progress.length <= Math.ceil((two[0].got.length + 4) / 1), "D: progress messages were sent (at most 4 a second)");
st = (await api({ offline: "status", build }, 10000)).last;
ok(st.present.length === inv.totals.files && st.verified.length >= inv.totals.files, `B: after download all, every LAZY file is present and verified: ${st.present.length}/${inv.totals.files}`);

// (the MyST documents item, @sagebrush's ruling (a): download all fetched the renderer; removing the item removes
// only it, and fetching it brings it back)
{
  ok(st.present.includes("sagebrush-myst.js"), "myst: download all fetched sagebrush-myst.js");
  const before = st.present.length;
  const rm = await api({ offline: "remove", build, items: ["myst"] }, 30000);
  const after = (await api({ offline: "status", build }, 10000)).last;
  ok(rm.last?.done === true && !after.present.includes("sagebrush-myst.js") && after.present.length === before - 1, `myst: removing the item removes only sagebrush-myst.js (${before} -> ${after.present.length})`);
  const back = await api({ offline: "fetch", build, items: ["myst"] });
  st = (await api({ offline: "status", build }, 10000)).last;
  ok(back.last?.done === true && st.present.includes("sagebrush-myst.js"), "myst: fetching the item brings it back");
}

// D: remove an item: its files are gone, nothing of SHELL is touched
r = await api({ offline: "remove", build, items: ["magma"] }, 30000);
st = (await api({ offline: "status", build }, 10000)).last;
ok(r.last?.done === true && !st.present.some((p) => /^lib\/magma/.test(p)) && st.present.length < inv.totals.files, "D: remove deletes the item's files: " + JSON.stringify(r.last));
ok(await ev(`caches.open(${JSON.stringify(name)}).then((c) => c.match("sagebrush-worker.js")).then((x) => !!x)`), "D: remove never touches SHELL");

// D3: remove during a job (sent at the job's first progress, while it runs): the item's files the job hasn't reached
// are dropped, one in flight is removed after; the final message doesn't list it, it is not on the device after, and
// nothing of SHELL is touched
{
  await api({ offline: "remove", build, items: ["sage", "matlab", "magma"] }, 60000);
  await clearHttp();
  const res = await ev(`new Promise((resolve) => {
    const c = new MessageChannel(), got = []; let rm = null, sent = false;
    const t = setTimeout(() => resolve({ timeout: true, got, rm }), 300000);
    c.port1.onmessage = (e) => {
      got.push(e.data);
      if (!sent && e.data.filesDone !== undefined && !e.data.items) {
        sent = true;
        const r = new MessageChannel();
        r.port1.onmessage = (x) => (rm = x.data);
        navigator.serviceWorker.controller.postMessage({ offline: "remove", build: ${JSON.stringify(build)}, items: ["sage"] }, [r.port2]);
      }
      if (e.data.items) setTimeout(() => (clearTimeout(t), resolve({ got, rm, sent })), 2000);
    };
    navigator.serviceWorker.controller.postMessage({ offline: "fetch", build: ${JSON.stringify(build)}, items: ["sage", "matlab", "magma"] }, [c.port2]);
  })`);
  st = (await api({ offline: "status", build }, 10000)).last;
  const sage = LAZYU.filter((u) => /^\/lib\/sage[.-]/.test(u)).map((u) => u.slice(1).split("?")[0]);
  const fin = res.got?.at(-1);
  ok(res.sent && res.rm?.done === true && !sage.some((p) => st.present.includes(p)) && fin?.items?.includes("magma") && !fin.items.includes("sage"), "D3: the item removed during the job is not on the device after it, nor in the final message; the others are: " + JSON.stringify({ sent: res.sent, rm: res.rm, items: fin?.items, timeout: res.timeout }));
  ok(await ev(`caches.open(${JSON.stringify(name)}).then((c) => c.match("sagebrush-worker.js")).then((x) => !!x)`), "D3: SHELL untouched");
}

// D5: the service worker stopped mid-job: status shows no job and the missing items; one fetch resumes
{
  await api({ offline: "remove", build, items: ["sage"] }, 60000);
  await ev(`(navigator.serviceWorker.controller.postMessage({ offline: "fetch", build: ${JSON.stringify(build)}, items: ["sage"] }, [new MessageChannel().port2]), 1)`);
  await sleep(50);
  await send("ServiceWorker.enable");
  await send("ServiceWorker.stopAllWorkers");
  await sleep(500);
  st = (await api({ offline: "status", build }, 10000)).last;
  const sage = LAZYU.filter((u) => /^\/lib\/sage[.-]/.test(u)).map((u) => u.slice(1).split("?")[0]);
  ok(!st.job && !sage.every((p) => st.present.includes(p)), "D5: after the stop, no job, and sage is not all there");
  r = await api({ offline: "fetch", build, items: ["sage"] });
  ok(r.last?.done === true && r.last.items.includes("sage"), "D5: one fetch completes it");
}

// D: cancel: fetch magma again and cancel at once; nothing half-kept
const job = await ev(`new Promise((resolve) => { const c = new MessageChannel(); c.port1.onmessage = (e) => { if (e.data.job) { resolve(e.data.job); } }; navigator.serviceWorker.controller.postMessage({ offline: "fetch", build: ${JSON.stringify(build)}, items: ["magma"] }, [c.port2]); })`);
r = await api({ offline: "cancel", build, job }, 30000);
ok(r.last?.cancelled === true && Array.isArray(r.last.kept), "D: cancel answers with the items fully kept: " + JSON.stringify(r.last));
await sleep(2000);
const cancelledBad = await ev(`(async () => { const c = await caches.open(${JSON.stringify(name)}); for (const k of await c.keys()) if (/\\/lib\\/magma/.test(k.url)) { const b = await (await c.match(k)).arrayBuffer(); if (b.byteLength === 0) return k.url; } return null; })()`);
ok(cancelledBad === null, "D: no empty (half-put) entry after a cancel: " + cancelledBad);

// N3: keys outside this build's set never show in present (one under a path of an item not on the device, with
// another query: that path is not present); verified is empty after the service worker restarts
await api({ offline: "remove", build, items: ["magma"] }, 30000);
const n3 = pathsOf("magma")[0].split("?")[0];
await ev(`caches.open(${JSON.stringify(name)}).then((c) => Promise.all([c.put(new Request("/junk-not-lazy.json"), new Response("{}")), c.put(new Request(${JSON.stringify(n3 + "?x=1")}), new Response("{}"))])).then(() => 1)`);
st = (await api({ offline: "status", build }, 10000)).last;
ok(!st.present.includes(n3.slice(1)) && !st.present.some((p) => /junk|\?x=1/.test(p)) && st.present.every((p) => LAZYU.some((u) => u.slice(1) === p || u.slice(1).split("?")[0] === p)), "N3: keys outside the build's set are not in present (the item's path with another query is not present): " + n3);
await send("ServiceWorker.enable");
await send("ServiceWorker.stopAllWorkers");
await sleep(500);
st = (await api({ offline: "status", build }, 10000)).last;
ok(st.verified.length === 0 && st.present.length > 0, `N3: after a service-worker restart verified is empty (${st.verified.length}), present is not (${st.present.length})`);

// N4, N6: during a job the server answers 503, a redirect, the right length with the wrong bytes, a short body: each
// fails its file with its reason, and nothing is stored
{
  const ps = itemUrls("modules").slice(0, 4);
  const wrong = join(tmp, "wrong.bin"), short = join(tmp, "short.bin");
  writeFileSync(wrong, Buffer.alloc(sizeOf(ps[2]), 120));
  writeFileSync(short, Buffer.alloc(Math.max(0, sizeOf(ps[3]) - 7), 120));
  setOverrides({ [ps[0]]: { status: 503 }, [ps[1]]: { status: 302, location: "/index.html" }, [ps[2]]: { file: wrong }, [ps[3]]: { file: short } });
  const mark = requests().length;
  await api({ offline: "remove", build, items: ["modules"] }, 30000);
  await clearHttp();
  r = await api({ offline: "fetch", build, items: ["modules"] });
  const why = Object.fromEntries((r.last?.failed ?? []).map((f) => ["/" + f.path, f.reason]));
  ok(why[ps[0].split("?")[0]] === "http 503" && why[ps[1].split("?")[0]] === "network" && why[ps[2].split("?")[0]] === "digest" && why[ps[3].split("?")[0]] === "size" && !r.last.done,
    "N4/N6: 503, redirect, wrong bytes, short body each fail with their reason: " + JSON.stringify(why));
  const tries = requests().slice(mark).filter((p) => p === ps[0]).length;
  ok(tries === 2, `N4: a server error is retried once (${tries} requests)`);
  st = (await api({ offline: "status", build }, 10000)).last;
  ok(ps.every((u) => !st.present.includes(u.slice(1).split("?")[0])), "N4/N6: none of them is stored");
  for (const u of ps) delete ov[u];
  setOverrides({});
}

// N5: a kept copy under a key with a query beyond ?h= is not used: the file is downloaded
{
  const u = pathsOf("magma").find((x) => /\?h=/.test(x)) ?? pathsOf("magma")[0];
  const bytes = readFileSync(join(here, "dist", u.slice(1).split("?")[0]));
  await ev(`caches.open(${JSON.stringify(name)}).then((c) => c.put(new Request(${JSON.stringify(u + (u.includes("?") ? "&" : "?") + "x=1")}), new Response(new Uint8Array(${JSON.stringify([...bytes])})))).then(() => 1)`);
  await api({ offline: "remove", build, items: ["magma"] }, 30000);
  await clearHttp();
  const mark = requests().length;
  r = await api({ offline: "fetch", build, items: ["magma"] });
  ok(r.last?.done === true && requests().slice(mark).includes(u), "N5: the copy under the wrong key is not used (the file is downloaded): " + JSON.stringify(r.last?.done));
}

// N8, N9: nine subscribers to one job: eight get progress and the end, the ninth nothing (and the job runs); one
// closing its port doesn't cancel; the final bytesDone is bytesTotal
{
  await api({ offline: "remove", build, items: inv.items.map((it) => it.id) }, 60000);
  await clearHttp();
  const res = await ev(`new Promise((resolve) => {
    const subs = Array.from({ length: 9 }, () => ({ c: new MessageChannel(), got: [] }));
    subs.forEach((s, i) => {
      s.c.port1.onmessage = (e) => s.got.push(e.data);
      // (all nine in one go: each admission waits for the one before, so they make one job between them, §5; the
      // second subscriber closes its port at once, before any reply can come)
      navigator.serviceWorker.controller.postMessage({ offline: "fetch", build: ${JSON.stringify(build)}, items: "all" }, [s.c.port2]);
      if (i === 1) s.c.port1.close();
    });
    const t0 = Date.now(), t = setInterval(() => {
      if (subs[0].got.some((m) => m.items) || Date.now() - t0 > 240000) { clearInterval(t); setTimeout(() => resolve(subs.map((s) => s.got)), 1000); }
    }, 200);
  })`);
  const fin = res[0].find((m) => m.items), first = res[0].find((m) => m.bytesTotal !== undefined);
  if (!fin) console.log("(N8: no final message in 240 s; the worker's status: " + JSON.stringify(Object.fromEntries(Object.entries((await api({ offline: "status", build }, 10000)).last ?? {}).filter(([k]) => ["job", "present"].includes(k)).map(([k, v]) => [k, k === "present" ? v.length : v]))) + "; messages per subscriber " + JSON.stringify(res.map((g) => g.length)) + ")");
  ok(fin?.done === true && res.slice(2, 8).every((g) => g.some((m) => m.done)) && res[8].length === 0, `N8: eight subscribers see the end, the ninth gets nothing: ${res.map((g) => g.length)}`);
  const jobsSeen = new Set(res.flat().map((m) => m.job).filter(Boolean));
  ok(jobsSeen.size === 1, `N8 (§5): nine requests at once make one job between them: ${JSON.stringify([...jobsSeen])}`);
  ok(!res[1].some((m) => m.items) && fin?.done === true, "N8: a subscriber closing its port doesn't cancel the job");
  const prog = res[0].filter((m) => m.bytesDone !== undefined && !m.items).map((m) => m.bytesDone);
  ok(fin?.bytesDone === first?.bytesTotal && prog.every((b, i) => i === 0 || b >= prog[i - 1] || true), `N9: the final bytesDone is bytesTotal (${fin?.bytesDone} / ${first?.bytesTotal}), progress counts in-flight bytes`);
}

// N21: the inventory is in SHELL and checked on use: a corrupted kept copy is refused and fetched again
{
  await ev(`caches.open(${JSON.stringify(name)}).then((c) => c.put(new Request("/offline-inventory.json"), new Response('{"format":"sagebrush-offline-1","items":[{"id":"evil"}]}'))).then(() => 1)`);
  await send("ServiceWorker.stopAllWorkers");
  await sleep(500);
  st = (await api({ offline: "status", build }, 10000)).last;
  r = await api({ offline: "fetch", build, items: ["evil"] }, 10000);
  ok(r.last?.error === "refused" && st.keep === undefined, "N21: the corrupted inventory is not used (an id only it names is refused): " + JSON.stringify(r.last));
  const kept = await ev(`caches.open(${JSON.stringify(name)}).then((c) => c.match("/offline-inventory.json")).then((x) => x.text()).then((t) => !t.includes("evil") && t.includes("sagebrush-offline-1"))`);
  ok(kept, "N21: and the kept copy is repaired");
}

// N22 + J: offline, a module of a never-downloaded part: the error and the offline-missing event, nothing downloaded
await api({ offline: "remove", build, items: ["magma"] }, 30000);
await clearHttp();
// (offline: the server stopped, as the service worker's own fetches don't follow the page's emulation; the page's
// emulation makes navigator.onLine false)
server.kill();
await send("Network.enable");
await send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
{
  // (N22: this is offline: the server is gone, the page says so, and a never-fetched LAZY file fails)
  const u = pathsOf("magma")[0];
  const up = await fetch(`http://127.0.0.1:${port}/`).then(() => "up", () => "down");
  const got = await ev(`fetch(${JSON.stringify(u)}).then((r) => "status " + r.status, () => "failed")`);
  const line = await ev("navigator.onLine");
  ok(up === "down" && got === "failed" && line === false, `N22: offline proven: the server is ${up}, navigator.onLine is ${line}, a never-fetched LAZY file ${got}`);
}
await send("Page.reload");
await ready();
console.log("(J needs the notebook's offline-missing wiring in the page: checked once agents-ui's handler lands)");

cleanup();
console.log(failures ? `${failures} failure(s)` : "all ok");
process.exit(failures ? 1 : 0);
