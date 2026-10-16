// The cold load of the notebook page, measured in headless Chrome: for each
// mode (Python, Sage, MATLAB, Magma), a fresh browser profile opens the
// page, picks the mode, runs one small cell and waits for the network to
// settle.  A Chrome trace of the whole browser (every process and thread:
// the page, its workers, the service worker) gives
//   - per request: bytes on the wire and decoded, and who fetched it;
//   - CPU time per thread kind (main thread, dedicated workers, service
//     worker): the sum of its top-level tasks;
// by the cell's first result (only what was done by then: requests finished,
// those still loading counted apart, CPU time up to it) and once settled
// (nothing in flight and no network event for 3 s, seen live through the
// Network domain of the page, its frames, its workers and the service
// worker, and checked against the trace: what the service worker precaches
// included).
//
// By default the page is web/dist, served by web/serve.py behind a proxy
// that compresses as a CDN does (brotli quality 5 for the types Cloudflare
// compresses), so the wire bytes are a first visit's.  --url measures a
// deployed site instead (--url https://sagebrush.space/).
//
//   bun web/build.ts && node web/measure-load.mjs [--url URL] [--mode python,sage] [--repeat] [--json out.json]
//   (--repeat: then a second visit with the same profile, its caches kept)
//   (CHROME=... for the browser; --self-test checks the trace analysis)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { devtoolsPort, freePort } from "./test-port.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const CELLS = { python: "print(1 + 1)", sage: "factor(2^32 + 1)", matlab: "disp(1 + 1)", magma: "print 1 + 1;" };
const WANT = { python: "2", sage: "641 * 6700417", matlab: "2", magma: "2" };
const modes = (opt("--mode") ?? "python,sage,matlab,magma").split(",");
const REPEAT = args.includes("--repeat");
const here = new URL(".", import.meta.url).pathname;
const COMPRESSIBLE = /^(text\/|application\/(javascript|json|wasm|manifest\+json)|image\/svg)/;

// web/dist through a compressing proxy (as a CDN serves it)
function proxy(upstream) {
  const packed = new Map();
  return createServer((req, res) => {
    const up = request({ host: "127.0.0.1", port: upstream, path: req.url, method: req.method, headers: { ...req.headers, "accept-encoding": "identity" } }, (r) => {
      const parts = [];
      r.on("data", (c) => parts.push(c));
      r.on("end", () => {
        const body = Buffer.concat(parts);
        const headers = { ...r.headers };
        const accept = String(req.headers["accept-encoding"] ?? "");
        let out = body;
        const enc = r.statusCode === 200 && body.length > 1024 && COMPRESSIBLE.test(String(headers["content-type"] ?? "")) ? (/\bbr\b/.test(accept) ? "br" : /\bgzip\b/.test(accept) ? "gzip" : null) : null;
        if (enc) {
          const key = req.url.split("?")[0] + "|" + enc;
          if (!packed.has(key)) packed.set(key, enc === "br" ? brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }) : gzipSync(body, { level: 6 }));
          out = packed.get(key);
          headers["content-encoding"] = enc;
          headers["content-length"] = String(out.length);
        }
        res.writeHead(r.statusCode, headers);
        res.end(out);
      });
    });
    up.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
}

async function measure(mode, url) {
  let server = null, front = null;
  if (!url) {
    const upstream = await freePort();
    server = spawn("python3", [join(here, "serve.py"), String(upstream)], { stdio: "ignore" });
    front = proxy(upstream);
    await new Promise((r) => front.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${front.address().port}/`;
    for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${upstream}/`); break; } catch { await sleep(100); } }
  }
  const profile = mkdtempSync(join(tmpdir(), "sb-load-"));
  const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--disable-background-networking", "about:blank"], { stdio: "ignore" });
  try {
    const cdp = await devtoolsPort(profile);
    let version;
    for (let i = 0; i < 300; i++) { try { version = await (await fetch(`http://127.0.0.1:${cdp}/json/version`)).json(); break; } catch { await sleep(100); } }
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let n = 0, lastNet = Date.now();
    const waiting = new Map();
    const events = [];
    let traceDone = null;
    // Live network activity, for settling: the trace's events arrive only
    // when it ends (ReportEvents), so they can't say whether the page is
    // still fetching.  The Network domain of the page, its workers and the
    // service worker (each attached as it appears) does: requests in flight,
    // and the time of the last event.
    // (by request id alone: a worker's script is requested by the page and
    // finished in the worker's session)
    const inflight = new Map(); // request id -> [session, url]
    const watch = async (sessionId) => {
      await send("Network.enable", {}, sessionId);
      // (a page's dedicated workers; started without waiting: a worker's first
      // requests before this may be missed here, never in the trace)
      await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); return; }
      if (m.method === "Tracing.dataCollected") for (const x of m.params.value) events.push(x);
      if (m.method === "Target.attachedToTarget" && /worker|iframe/.test(m.params.targetInfo.type)) watch(m.params.sessionId);
      if (m.method === "Target.targetCreated" && m.params.targetInfo.type === "service_worker") send("Target.attachToTarget", { targetId: m.params.targetInfo.targetId, flatten: true });
      // (a worker gone: its requests with it)
      if (m.method === "Target.detachedFromTarget") for (const [k, [s]] of inflight) if (s === m.params.sessionId) inflight.delete(k);
      if (/^Network\./.test(m.method ?? "")) {
        lastNet = Date.now();
        const key = m.params?.requestId;
        // (the page's own requests, as counted below: not data: or blob:)
        if (m.method === "Network.requestWillBeSent" && /^https?:/.test(m.params.request.url)) inflight.set(key, [m.sessionId, m.params.request.url]);
        if (m.method === "Network.loadingFinished" || m.method === "Network.loadingFailed") inflight.delete(key);
      }
      if (m.method === "Tracing.tracingComplete") traceDone?.();
      // (the new notebook has a cell, so changing its language asks first: yes)
      if (m.method === "Page.javascriptDialogOpening") send("Page.handleJavaScriptDialog", { accept: true }, m.sessionId);
    };
    const send = (method, params = {}, sessionId) => new Promise((resolve) => {
      const id = ++n;
      const t = setTimeout(() => { waiting.delete(id); resolve({ error: "timeout " + method }); }, 60000);
      waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    // (the whole browser: every renderer, worker and service worker thread)
    const startTrace = () => send("Tracing.start", { traceConfig: { includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "toplevel", "loading", "__metadata"], recordMode: "recordContinuously" }, transferMode: "ReportEvents", bufferUsageReportingInterval: 1000 });
    await startTrace();
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId: page } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.enable", {}, page);
    await watch(page);
    await send("Target.setDiscoverTargets", { discover: true });
    const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, page))?.result?.value;
    const until = async (expr, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(50); } return false; };
    const visit = async (first) => {
    const t0 = Date.now();
    inflight.clear();
    await send("Page.navigate", { url }, page);
    const ready = await until("document.querySelector('#status')?.textContent.startsWith('ready')", 120000);
    const tReady = Date.now() - t0;
    if (mode !== "python" && first) await ev(`(() => { const m = document.querySelector('#mode'); m.value = ${JSON.stringify(mode)}; m.dispatchEvent(new Event('change')); })()`);
    // (in a new cell when the last has code: a repeat visit reopens the notebook with its result)
    const n0 = await ev(`(() => { const cs = [...document.querySelectorAll('.cell')]; let c = cs.at(-1); if (c.querySelector('textarea').value.trim()) { document.querySelector('#add').click(); } return document.querySelectorAll('.cell').length; })()`);
    await ev(`(() => { const c = document.querySelectorAll('.cell')[${n0 - 1}]; const ta = c.querySelector('textarea'); ta.value = ${JSON.stringify(CELLS[mode])}; ta.dispatchEvent(new Event('input', {bubbles: true})); c.querySelector('[data-a=run]').click(); })()`);
    const cell = `document.querySelectorAll('.cell')[${n0 - 1}]`;
    const done = await until(`/\\[\\d+\\]/.test(${cell}.querySelector('.n').textContent)`, 180000);
    const tResult = Date.now() - t0;
    const out = (await ev(`${cell}.querySelector('.out').textContent`)) ?? "";
    // (the trace's clock: a mark at the result, as a console.timeStamp)
    await ev(`console.timeStamp('sb-first-result')`);
    // settled: nothing in flight and no network event for 3 s (at most 2 min)
    const tSettle = Date.now();
    lastNet = Date.now();
    // (a request whose end the live events missed, a worker's script or a
    // frame's page reported to a target attached a moment too late, would
    // keep it waiting: after 15 s with no network event at all it stops,
    // and the trace, complete, says whether every request had finished: by
    // request, not by URL, so a second fetch of a URL that never ends is
    // not hidden by the first, the review's CORR-FF8-2)
    while ((inflight.size > 0 ? Date.now() - lastNet < 15000 : Date.now() - lastNet < 3000) && Date.now() - tSettle < 120000) await sleep(200);
    const timedOut = Date.now() - tSettle >= 120000;
    await new Promise((r) => { traceDone = r; send("Tracing.end"); });
    const stats = analyse(events);
    const stuck = stats.settled.inFlight.urls;
    const settledCleanly = stats.settled.inFlight.requests === 0 && !timedOut;
    events.length = 0;
    return { ready, ok: done && out.includes(WANT[mode]), out: out.slice(0, 200), ms: { ready: tReady, firstResult: tResult, settle: Date.now() - tSettle }, settledCleanly, ...(settledCleanly ? {} : { stuck }), ...stats };
    };
    const cold = await visit(true);
    // --repeat: the same profile visits again (its HTTP cache and service
    // worker kept; the notebook reopens in the mode it was left in)
    let repeat = null;
    if (REPEAT) {
      await startTrace();
      repeat = await visit(false);
    }
    ws.close();
    return { mode, url, ...cold, ...(repeat ? { repeat } : {}) };
  } finally {
    chrome.kill("SIGKILL");
    server?.kill();
    front?.close();
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  }
}

// The trace: requests (wire and decoded bytes, by thread) and CPU per
// thread kind, at the first-result mark and in all
function analyse(events) {
  const threadName = new Map();
  for (const e of events) if (e.ph === "M" && e.name === "thread_name") threadName.set(e.pid + ":" + e.tid, e.args.name);
  const kind = (e) => {
    const name = threadName.get(e.pid + ":" + e.tid) ?? "";
    return /CrRendererMain/.test(name) ? "main" : /DedicatedWorker/.test(name) ? "worker" : /ServiceWorker/.test(name) ? "service worker" : /CrBrowserMain/.test(name) ? "browser" : name || "other";
  };
  const mark = events.find((e) => e.name === "TimeStamp" && e.args?.data?.message === "sb-first-result")?.ts ?? Infinity;
  const reqs = new Map();
  for (const e of events) {
    const d = e.args?.data;
    if (!d?.requestId) continue;
    if (e.name === "ResourceSendRequest") reqs.set(d.requestId, { url: d.url, by: kind(e), ts: e.ts, wire: 0, decoded: 0, done: false, cached: false });
    const r = reqs.get(d.requestId);
    if (!r) continue;
    if (e.name === "ResourceReceiveResponse") {
      if (d.fromCache || d.fromServiceWorker) r.cached = true;
      r.status = d.statusCode;
    }
    // (the bytes received so far, for one still loading at the mark)
    if (e.name === "ResourceReceivedData") r.chunks = [...(r.chunks ?? []), [e.ts, d.encodedDataLength ?? 0]];
    if (e.name === "ResourceFinish") { r.wire = d.encodedDataLength ?? 0; r.decoded = d.decodedBodyLength ?? 0; r.done = true; r.end = e.ts; }
  }
  // Up to `until` only: a task running across it counts the part before it
  // (its CPU time in proportion), a request only once finished by then
  // (those still loading are counted apart, with the wire bytes they had
  // received by then): the review's CORR-FF8-1
  const cpu = (until) => {
    // (the page's threads; the browser process's and Chrome's own others
    // summed as "other")
    const out = { main: 0, worker: 0, "service worker": 0, other: 0 };
    for (const e of events) {
      if (e.ph !== "X" || e.name !== "RunTask" || !e.dur || e.ts > until) continue;
      const k = kind(e);
      out[k in out ? k : "other"] += ((e.tdur ?? e.dur) * Math.min(1, (until - e.ts) / e.dur)) / 1000;
    }
    for (const k in out) out[k] = Math.round(out[k]);
    return out;
  };
  const page = (r) => !r.cached && /^https?:/.test(r.url);
  const net = (until) => {
    const files = new Map();
    let wire = 0, decoded = 0, count = 0;
    // (started by then and not finished: how many, and their wire bytes so far)
    const loading = [...reqs.values()].filter((r) => page(r) && r.ts <= until && !(r.done && r.end <= until));
    const inFlight = { requests: loading.length, wireSoFar: loading.reduce((s, r) => s + (r.chunks ?? []).filter(([t]) => t <= until).reduce((a, [, n]) => a + n, 0), 0), urls: loading.slice(0, 10).map((r) => r.url) };
    for (const r of reqs.values()) {
      // (the page's own requests: not data:, blob: or the browser's chrome:// pages)
      if (!r.done || r.end > until || !page(r)) continue;
      count++;
      wire += r.wire;
      decoded += r.decoded;
      const f = r.url.replace(/^https?:\/\/[^/]+/, "").split("?")[0] || "/";
      const x = files.get(f) ?? { file: f, by: new Set(), requests: 0, wire: 0, decoded: 0 };
      x.requests++;
      x.wire += r.wire;
      x.decoded += r.decoded;
      x.by.add(r.by);
      files.set(f, x);
    }
    const revalidated = [...reqs.values()].filter((r) => r.done && r.end <= until && page(r) && r.status === 304).length;
    return { requests: count, revalidated, wire, decoded, inFlight, files: [...files.values()].map((x) => ({ ...x, by: [...x.by].join(",") })).sort((a, b) => b.wire - a.wire) };
  };
  return { atResult: { ...net(mark), cpuMs: cpu(mark) }, settled: { ...net(Infinity), cpuMs: cpu(Infinity) } };
}

// --self-test: analyse() on a made-up trace (the review's): a request sent at
// 1 ms, its response from 11 ms, finished at 20 ms (1 MB wire, 4 MB decoded);
// a task from 8 to 18 ms; the mark at 10 ms
if (args.includes("--self-test")) {
  const meta = { ph: "M", name: "thread_name", pid: 1, tid: 1, args: { name: "CrRendererMain" } };
  const at = (ms, name, data, more = {}) => ({ ph: "I", pid: 1, tid: 1, ts: ms * 1000, name, args: { data }, ...more });
  const trace = [meta, at(1, "ResourceSendRequest", { requestId: "a", url: "https://x/big" }), at(2, "ResourceSendRequest", { requestId: "b", url: "https://x/small" }),
    at(3, "ResourceReceiveResponse", { requestId: "b", statusCode: 200 }), at(4, "ResourceFinish", { requestId: "b", encodedDataLength: 100, decodedBodyLength: 300 }),
    { ph: "X", pid: 1, tid: 1, ts: 8000, dur: 10000, tdur: 10000, name: "RunTask" }, at(10, "TimeStamp", { message: "sb-first-result" }),
    at(11, "ResourceReceiveResponse", { requestId: "a", statusCode: 200 }), at(12, "ResourceReceivedData", { requestId: "a", encodedDataLength: 500000 }),
    at(20, "ResourceFinish", { requestId: "a", encodedDataLength: 1e6, decodedBodyLength: 4e6 })];
  const s = analyse(trace);
  const want = { at: [1, 100, 300, 1, 0, 2], settled: [2, 1e6 + 100, 4e6 + 300, 0, 0, 10] };
  const got = { at: [s.atResult.requests, s.atResult.wire, s.atResult.decoded, s.atResult.inFlight.requests, s.atResult.inFlight.wireSoFar, s.atResult.cpuMs.main],
    settled: [s.settled.requests, s.settled.wire, s.settled.decoded, s.settled.inFlight.requests, s.settled.inFlight.wireSoFar, s.settled.cpuMs.main] };
  // (and the same URL fetched twice, once to the end and once never: one
  // request still in flight, though the URL finished once)
  const twice = analyse([...trace, at(21, "ResourceSendRequest", { requestId: "c", url: "https://x/small" })]);
  const ok = JSON.stringify(got) === JSON.stringify(want) && twice.settled.inFlight.requests === 1 && twice.settled.inFlight.urls[0] === "https://x/small";
  console.log(ok ? "self-test ok" : "self-test FAILED: " + JSON.stringify(got) + " != " + JSON.stringify(want));
  process.exit(ok ? 0 : 1);
}

const mb = (x) => (x / 1e6).toFixed(2) + " MB";
const results = [];
for (const mode of modes) {
  const r = await measure(mode, opt("--url"));
  results.push(r);
  console.log(`${mode}: ${r.ok ? "ok" : "FAILED (" + JSON.stringify(r.out) + ")"}, ready ${r.ms.ready} ms, first result ${r.ms.firstResult} ms${r.settledCleanly ? "" : " (NOT SETTLED: still in flight " + JSON.stringify(r.stuck) + ")"}`);
  for (const [when, s] of [["by first result", r.atResult], ["settled", r.settled]])
    console.log(`  ${when}: ${s.requests} requests finished, ${mb(s.wire)} wire, ${mb(s.decoded)} decoded` + (s.inFlight.requests ? `; ${s.inFlight.requests} still loading (${mb(s.inFlight.wireSoFar)} received)` : "") + `; CPU ms ${JSON.stringify(s.cpuMs)}`);
  if (r.repeat) {
    const p = r.repeat;
    console.log(`  repeat visit: ${p.ok ? "ok" : "FAILED"}, ready ${p.ms.ready} ms, first result ${p.ms.firstResult} ms; ${p.settled.requests} requests to the network (${p.settled.revalidated} revalidated, 304), ${mb(p.settled.wire)} wire, ${mb(p.settled.decoded)} decoded; CPU ms ${JSON.stringify(p.settled.cpuMs)}`);
  }
  for (const f of r.settled.files.slice(0, 10)) console.log(`    ${mb(f.wire).padStart(9)} wire ${mb(f.decoded).padStart(9)} decoded${f.requests > 1 ? " x" + f.requests : ""}  ${f.file}  (${f.by})`);
}
if (opt("--json")) writeFileSync(opt("--json"), JSON.stringify({ when: new Date().toISOString(), results }, null, 1) + "\n");
process.exit(results.every((r) => r.ok && (!r.repeat || r.repeat.ok)) ? 0 : 1);
