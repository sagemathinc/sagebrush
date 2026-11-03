// ci: web-runner order=10 chrome
// The runner (design/runner.md) in headless Chromium: the notebook page runs
// Python in an opaque-origin sandboxed frame (?runner=0: in a plain worker,
// where NO_RUNNER=1 checks that these tests fail).  Checks that code
// runs, that Stop keeps the variables, and, from inside the frame and its
// worker (as an escape would be), that there is no storage, no page and no
// network beyond Sagebrush's own files.  Serve web/dist first:
//   python3 web/serve.py 8765 &  node web/test-runner.mjs   (SB_URL=... for another)
//
// The frame and the worker the probes run in are found by what they belong to, never by their origin, their URL or
// what a probe of them says: the one sandboxed frame's frame id (DOM.describeNode), its own default context, and the
// worker that frame created (its target's parentFrameId; without that field, the worker attached by the frame's
// own target, if the frame has one).  Controls show that a page worker attached later can't take the runner's place
// (the earlier "last worker attached" rule, kept as a mutant, must pick it), and records of each case check the
// selection's other branches.  Every call this adds has a bound and fails by name; Chrome's version and every
// target are printed; a fallback to a plain worker fails the main checks, and in the deliberately stuck runner
// below, the stuck page's own warning is required.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "./test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const profile = mkdtempSync(join(tmpdir(), "sb-runner-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cdpPort = Number(process.env.CDP_PORT) || 0;
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!cdpPort) cdpPort = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const waiting = new Map();
const contexts = [];
const workers = []; // sessionIds of attached workers
const frames = []; // and of frames in their own process
const violations = [];
let paused = null; // a request held by Fetch interception, and what to do with it
// every attached target, by its session: {sessionId, targetId, type, url, title, parentFrameId, parentSession
// (undefined: the page), order, detached, phase}
const attached = new Map();
let attachOrder = 0;
const pendingMeta = new Map(); // the bounded calls' own records, by id ({sessionId, name, finish})
const cspLog = []; // {sessionId, phase, text}
const warnings = []; // the fallback's warnings: {sessionId, executionContextId, emittedAt, receivedAt, receivedPhase}
const FALLBACK = /the runner did not start/;
const FALLBACK_TEXT = "sagebrush: the runner did not start; Python runs in a plain worker";
let phase = "main";
const stuckLog = []; // the stuck case's console: {at, session, text}
// the stuck case's library requests (lib/...), by session and request id: when sent, answered, finished or failed, and
// whether a service worker answered; every session's (the page's, its workers', the service worker's), to name the
// request a hung run waits for and the hop that holds it (grader's investigation, step 1)
const stuckNet = new Map();
let mainFrameId, stuckCtx, lastRunnerFrameId;
// (the library chunks the page fetches, web/lib-chunks.mts: lib/<group>.src.<hash>.json)
const libFetched = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Fetch.requestPaused") paused?.(m.params);
  if (m.method === "Network.requestWillBeSent") {
    const g = /\/lib\/([a-z0-9][a-z0-9-]*)\.src\.[0-9a-f]{16}\.json$/.exec(new URL(m.params.request.url, "http://x").pathname);
    if (g) libFetched.push(g[1]);
  }
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.executionContextCreated") contexts.push({ ...m.params.context, sessionId: m.sessionId });
  if (m.method === "Runtime.executionContextDestroyed") for (const c of contexts) if (c.id === m.params.executionContextId && c.sessionId === m.sessionId) c.gone = true;
  if (m.method === "Runtime.executionContextsCleared") for (const c of contexts) if (c.sessionId === m.sessionId) c.gone = true;
  if (m.method === "Target.attachedToTarget") {
    // (each frame in another process, and each worker, is a target of its own)
    const sid = m.params.sessionId;
    if (m.params.targetInfo.type === "worker") workers.push(sid);
    if (m.params.targetInfo.type === "iframe") frames.push(sid);
    const ti = m.params.targetInfo;
    attached.set(sid, { sessionId: sid, targetId: ti.targetId, type: ti.type, url: ti.url, title: ti.title, parentFrameId: ti.parentFrameId, parentSession: m.sessionId, order: ++attachOrder, detached: false, phase });
    if (phase === "stuck") ws.send(JSON.stringify({ id: ++n, method: "Network.enable", params: {}, sessionId: sid }));
    for (const [method, params] of [["Runtime.enable", {}], ["Log.enable", {}], ["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }], ["Runtime.runIfWaitingForDebugger", {}]]) ws.send(JSON.stringify({ id: ++n, method, params, sessionId: sid }));
  }
  if (m.method === "Log.entryAdded" && /Content Security Policy/.test(m.params.entry.text)) violations.push(m.params.entry.text);
  if (m.method === "Log.entryAdded" && /Content Security Policy/.test(m.params.entry.text)) cspLog.push({ sessionId: m.sessionId, phase, text: m.params.entry.text });
  if (m.method === "Target.detachedFromTarget") {
    const t = attached.get(m.params.sessionId);
    if (t) t.detached = true;
    for (const p of [...pendingMeta.values()]) if (p.sessionId === m.params.sessionId) p.finish({ detached: true });
  }
  // (the fallback's warning, whatever RUNNER_DEBUG says: by the context that emitted it, and when, apart from when it came)
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "warning" && FALLBACK.test(String(m.params.args?.[0]?.value ?? ""))) {
    const w = { sessionId: m.sessionId, executionContextId: m.params.executionContextId, emittedAt: m.params.timestamp, receivedAt: Date.now(), receivedPhase: phase };
    warnings.push(w);
    console.log(`warn [${m.sessionId ? m.sessionId.slice(0, 6) : "page"} ctx ${w.executionContextId}] ${m.params.args[0].value}`);
  }
  // (the stuck case's console, every session's (the page's, the plain worker's), for its failure report)
  if (phase === "stuck" && (m.method === "Runtime.consoleAPICalled" || m.method === "Runtime.exceptionThrown" || m.method === "Log.entryAdded") && stuckLog.length < 400)
    stuckLog.push({ at: m.params.timestamp ?? m.params.entry?.timestamp ?? Date.now(), session: m.sessionId ? m.sessionId.slice(0, 6) : "page", text: m.method === "Runtime.exceptionThrown" ? "exception: " + (m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text) : m.method === "Log.entryAdded" ? `log ${m.params.entry.level}: ${m.params.entry.text}` : `${m.params.type}: ${(m.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(" ")}` });
  if (phase === "stuck" && m.method?.startsWith("Network.")) {
    const p = m.params, key = (m.sessionId ?? "page").slice(0, 6) + ":" + p.requestId;
    if (m.method === "Network.requestWillBeSent" && /\/lib\/[^/]+\.json(\?|$)/.test(p.request.url) && stuckNet.size < 200)
      stuckNet.set(key, { session: (m.sessionId ?? "page").slice(0, 6), url: p.request.url.replace(/^.*\/lib\//, "lib/"), sent: Date.now() });
    const r = stuckNet.get(key);
    if (r && m.method === "Network.responseReceived") Object.assign(r, { answered: Date.now(), status: p.response.status, sw: !!p.response.fromServiceWorker, len: p.response.headers?.["content-length"] ?? p.response.headers?.["Content-Length"] });
    if (r && m.method === "Network.dataReceived") r.bytes = (r.bytes ?? 0) + (p.dataLength ?? 0);
    if (r && m.method === "Network.loadingFinished") r.finished = Date.now();
    if (r && m.method === "Network.loadingFailed") Object.assign(r, { failed: Date.now(), error: p.errorText });
  }
  // (a service worker, in the stuck case: attached so its own requests are seen too)
  if (phase === "stuck" && m.method === "Target.targetCreated" && m.params.targetInfo.type === "service_worker") ws.send(JSON.stringify({ id: ++n, method: "Target.attachToTarget", params: { targetId: m.params.targetInfo.targetId, flatten: true } }));
  if (process.env.RUNNER_DEBUG && (m.method === "Log.entryAdded" || m.method === "Runtime.exceptionThrown" || m.method === "Runtime.consoleAPICalled")) console.log("  [" + (m.sessionId ?? "page").slice(0, 6) + "]", JSON.stringify(m.params).slice(0, 600));
};
const send = (method, params = {}, sessionId) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
const evIn = async (expression, { contextId, sessionId } = {}) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) }, sessionId);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result?.value;
};
const ev = (x) => evIn(x);
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } throw new Error("timeout: " + expr); };
let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };

// A call that gives up (the calls this file added; send() above has no deadline): {result} | {error} | {timeout} |
// {detached}, never a throw.  Its entry in `waiting` stays a resolver, as send()'s are; its own record is in
// pendingMeta, and both go once it's settled, so a late answer finds nothing.
function sendWithin(ms, name, method, params = {}, sessionId) {
  return new Promise((resolve) => {
    const id = ++n;
    const finish = (r) => {
      if (!pendingMeta.has(id)) return;
      clearTimeout(timer);
      pendingMeta.delete(id);
      waiting.delete(id);
      resolve({ name, id, ...r });
    };
    const timer = setTimeout(() => finish({ timeout: true }), ms);
    pendingMeta.set(id, { sessionId, name, finish });
    // (an error is {code, message}; a result never has a numeric code beside a message)
    waiting.set(id, (v) => finish(v && typeof v.code === "number" && typeof v.message === "string" ? { error: v.message } : { result: v }));
    try { ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); } catch (e) { finish({ error: String(e?.message ?? e) }); }
  });
}
const what = (r) => (r.timeout ? "timeout" : r.detached ? "detached" : r.error ?? null);
// fn(msLeft) until it gives something, within ms of now (each try is given what is left)
async function untilWithin(ms, name, fn) {
  const end = performance.now() + ms;
  for (;;) {
    const left = end - performance.now();
    if (left <= 0) return { timeout: true, name };
    const v = await Promise.race([fn(left), sleep(left).then(() => null)]);
    if (v) return { value: v };
    await sleep(Math.max(0, Math.min(100, end - performance.now())));
  }
}
async function evWithin(ms, name, expression, sessionId) {
  const r = await sendWithin(ms, name, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (what(r)) return { fail: what(r), r };
  if (r.result?.exceptionDetails) return { fail: "threw: " + JSON.stringify(r.result.exceptionDetails).slice(0, 200), r };
  return { value: r.result?.result?.value, r };
}
// The page's status, as a failure reports it: bounded, never a throw (also C-status's path)
async function reportStatus({ sessionId, expression = "document.querySelector('#status')?.textContent" } = {}) {
  const t0 = performance.now();
  const r = await sendWithin(3000, "status", "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
  const text = what(r) ? `unavailable (${what(r)})` : r.result?.exceptionDetails ? "unavailable (threw)" : r.result?.result?.value;
  console.log("  status: " + text);
  return { r, ms: performance.now() - t0 };
}
async function chromeVersion() {
  try {
    const signal = AbortSignal.timeout(5000); // (the body's read too)
    const v = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal })).json();
    return `${v.Browser} (protocol ${v["Protocol-Version"]}; ${v["User-Agent"]})`;
  } catch (e) {
    return `unavailable (${e?.name ?? e})`;
  }
}

// The runner's worker, by the frame it belongs to: a pure function of the records.  P: some worker carries
// parentFrameId, so the bound ones are those whose parentFrameId is the runner frame's; a worker the frame's own
// target attached that names another frame is a contradiction.  S (no worker carries it): those the runner
// frame's one live target attached.  Never a worker another worker attached (parentFrameId names its ANCESTOR
// frame), never by URL, origin or a probe.
function selectRunner(ts, runnerFrameId) {
  const all = [...ts.values()];
  // (a candidate's direct parent must be shown to be the page or a live frame's target: not a worker, not a
  // session we have no record of, not a detached frame)
  const liveFrameSessions = new Set(all.filter((t) => t.type === "iframe" && !t.detached).map((t) => t.sessionId));
  const cands = all.filter((t) => t.type === "worker" && !t.detached && (t.parentSession === undefined || liveFrameSessions.has(t.parentSession)));
  const frameTargets = all.filter((t) => t.type === "iframe" && !t.detached && t.targetId === runnerFrameId);
  if (all.some((t) => t.type === "worker" && t.parentFrameId !== undefined)) {
    const fs = new Set(frameTargets.map((t) => t.sessionId));
    if (cands.some((t) => fs.has(t.parentSession) && t.parentFrameId !== runnerFrameId)) return { refused: "contradictory metadata", binding: "P" };
    const bound = cands.filter((t) => t.parentFrameId === runnerFrameId);
    return bound.length === 1 ? { worker: bound[0], binding: "P" } : { refused: `${bound.length} bound`, binding: "P" };
  }
  if (frameTargets.length !== 1) return { refused: `unidentifiable (no parentFrameId; ${frameTargets.length} live targets for the runner frame)`, binding: "S" };
  const bound = cands.filter((t) => t.parentSession === frameTargets[0].sessionId);
  return bound.length === 1 ? { worker: bound[0], binding: "S" } : { refused: `${bound.length} bound`, binding: "S" };
}
// the earlier rule, kept only as the controls' mutant: the last worker attached, of any kind
const selectLast = (ts) => [...ts.values()].filter((t) => t.type === "worker").sort((a, b) => a.order - b.order).at(-1);
function selectFrameContext(cs, frameId) {
  const live = cs.filter((c) => !c.gone && c.auxData?.isDefault && c.auxData?.frameId === frameId);
  return live.length === 1 ? { context: live[0] } : { refused: `${live.length} live` };
}
// a fallback warning counts for the stuck page only if that page's own context emitted it
const eligible = (w, ctx) => w.sessionId === undefined && ctx !== undefined && w.executionContextId === ctx;
const rootWarnings = () => warnings.filter((w) => w.sessionId === undefined);
const said = (ws) => JSON.stringify(ws.map((w) => ({ ctx: w.executionContextId, emittedAt: w.emittedAt, receivedAt: w.receivedAt, phase: w.receivedPhase })));

// The stuck case's diagnostics (test-only; the grader's investigation): on the page, each Worker it makes, with when
// it was made, the kinds of what it was sent and said (keys only), its first message, its ready, error and
// messageerror events; and #status as it changes. Only in the top page: the runner's frame is left alone.
const STUCK_DIAG = `(() => {
  if (window.top !== window || !window.Worker) return;
  const d = (window.__sbStuckDiag = { workers: [], status: [] });
  const kinds = (m) => (m && typeof m === "object" ? Object.keys(m).slice(0, 4).join(",") : typeof m);
  const W = window.Worker;
  window.Worker = class extends W {
    constructor(u, o) {
      super(u, o);
      // (said and sent: the last 20 of each, beside their totals; ids: every message carrying an id, each way, so a
      // run's id,code and id,start show however many startup messages came first: sync-docs' review)
      const r = { url: String(u).slice(-60), at: Date.now(), first: null, ready: null, n: 0, nSent: 0, said: [], sent: [], ids: [], errors: [], messageerrors: 0 };
      d.workers.push(r);
      const keep = (a, x) => { a.push(x); if (a.length > 20) a.shift(); };
      const id = (way, m) => { if (m && typeof m === "object" && m.id !== undefined && r.ids.length < 200) r.ids.push({ at: Date.now(), way, id: m.id, kinds: kinds(m) }); };
      this.addEventListener("message", (e) => { r.n++; r.first ??= Date.now(); if (e.data?.ready) r.ready ??= Date.now(); keep(r.said, kinds(e.data)); id("said", e.data); });
      this.addEventListener("error", (e) => { if (r.errors.length < 5) r.errors.push({ at: Date.now(), message: String(e.message || e.type).slice(0, 200) }); });
      this.addEventListener("messageerror", () => r.messageerrors++);
      const post = W.prototype.postMessage;
      this.postMessage = (m, t) => { r.nSent++; keep(r.sent, { at: Date.now(), kinds: kinds(m) }); id("sent", m); return t === undefined ? post.call(this, m) : post.call(this, m, t); };
    }
  };
  const watch = () => {
    const s = document.querySelector("#status");
    if (!s) return void setTimeout(watch, 50);
    const rec = () => d.status.length < 60 && d.status.push({ at: Date.now(), text: s.textContent.slice(0, 100) });
    rec();
    new MutationObserver(rec).observe(s, { childList: true, characterData: true, subtree: true });
  };
  watch();
})();`;
// what the stuck case's failure shows: where it stopped (times are ms after the page was opened)
async function reportStuck({ navAt, runAt }) {
  const at = (x) => (typeof x === "number" ? Math.round(x - navAt) : x);
  const fell = warnings.find((w) => eligible(w, stuckCtx));
  console.log(`  stuck: the fallback warning at ${fell ? at(fell.emittedAt) : "(none)"}, the run asked at ${at(runAt)}`);
  const r = await evWithin(5000, "the stuck page's diagnostics", `JSON.stringify({ diag: window.__sbStuckDiag ?? null, kernel: (() => { const k = window.sagebrush?.kernel; return k ? { ready: k.ready, startDone: k.startDone, startError: k.startError ? String(k.startError?.message ?? k.startError).slice(0, 200) : null, queued: k.queued, pending: [...(k.pending?.keys?.() ?? [])].slice(0, 10), runs: [...(k.runs?.keys?.() ?? [])].slice(0, 10), inner: !!k.worker?.inner, alive: k.worker?.alive ?? null, held: k.worker?.queue?.length ?? null } : null; })(), cells: [...document.querySelectorAll(".cell")].map((c) => ({ classes: c.className, n: c.querySelector(".n")?.textContent, out: c.querySelector(".out")?.textContent.slice(0, 200) })) })`);
  if (r.fail) return console.log("  stuck: diagnostics unavailable (" + r.fail + ")");
  const v = JSON.parse(r.value);
  for (const w of v.diag?.workers ?? [])
    console.log("  stuck worker: " + JSON.stringify({ ...w, at: at(w.at), first: at(w.first), ready: at(w.ready), sent: w.sent.map((x) => `${at(x.at)}:${x.kinds}`), ids: w.ids.slice(-40).map((x) => `${at(x.at)}:${x.way}:${x.id}:${x.kinds}`), errors: w.errors.map((e) => `${at(e.at)}:${e.message}`) }).slice(0, 2500));
  if (!v.diag) console.log("  stuck: no diagnostics on the page (the script didn't run)");
  console.log("  stuck #status: " + JSON.stringify((v.diag?.status ?? []).map((x) => `${at(x.at)}:${x.text}`)).slice(0, 1500));
  // (sync-docs: the run still pending in the kernel, its start barrier, the runner's own state)
  console.log("  stuck kernel: " + JSON.stringify(v.kernel).slice(0, 800));
  console.log("  stuck cells: " + JSON.stringify(v.cells).slice(0, 1500));
  // (each library request: ms after the page opened; one never finished nor failed is what a hung run waits for)
  for (const r of stuckNet.values())
    console.log(`  stuck net [${r.session}] ${r.url.slice(0, 70)} sent ${at(r.sent)} answered ${at(r.answered) ?? "-"} (${r.status ?? "-"}${r.sw ? ", service worker" : ""}, ${r.bytes ?? 0}/${r.len ?? "?"} B) ${r.finished ? "finished " + at(r.finished) : r.failed ? "FAILED " + at(r.failed) + " " + r.error : "NEVER FINISHED"}`);
  if (!stuckNet.size) console.log("  stuck net: no library requests seen");
  // (the service worker's serving budget, web/sw.js reserve(): what it holds and who waits, read in its own session)
  for (const t of [...attached.values()].filter((t) => t.type === "service_worker" && !t.detached)) {
    const b = await evWithin(3000, "the service worker's budget", `(() => { try { return JSON.stringify({ used: budgetUsed, peak: budgetPeak, waiting: waiters.map((w) => ({ n: w.n, serve: w.serve })) }); } catch (e) { return "unreadable: " + e.message; } })()`, t.sessionId);
    console.log(`  stuck sw [${t.sessionId.slice(0, 6)}] budget: ${b.fail ?? b.value}`);
  }
  for (const l of stuckLog.slice(-60)) console.log(`  stuck console [${l.session} ${at(Math.round(l.at))}] ${String(l.text).slice(0, 300)}`);
}

// the one sandboxed frame's frame id, from the element itself (in whichever process the frame is)
let domOn = false;
async function runnerFrame() {
  const el = await sendWithin(5000, "the sandboxed frame element", "Runtime.evaluate", { expression: "(() => { const fs = document.querySelectorAll('iframe[sandbox]'); return fs.length === 1 ? fs[0] : fs.length; })()" });
  if (what(el)) throw new Error("the sandboxed frame element: " + what(el));
  const r = el.result?.result;
  if (!r?.objectId) throw new Error(`sandboxed frames: ${r?.value ?? "?"}`);
  if (!domOn) {
    const d = await sendWithin(5000, "DOM.enable", "DOM.enable");
    if (what(d)) throw new Error("DOM.enable: " + what(d));
    domOn = true;
  }
  const dn = await sendWithin(5000, "DOM.describeNode", "DOM.describeNode", { objectId: r.objectId });
  if (what(dn)) throw new Error("DOM.describeNode: " + what(dn));
  const fid = dn.result?.node?.frameId;
  if (!fid) throw new Error("the sandboxed frame has no frameId");
  return fid;
}
// null while the frame, its context and its worker are the ones bound; else what changed (never a switch)
async function stillBound(label, runnerFrameId, wk, ctxId) {
  const t = attached.get(wk);
  if (!t || t.detached) return `${label}: the runner's worker detached`;
  let fid;
  try { fid = await runnerFrame(); } catch (e) { return `${label}: ${e.message}`; }
  if (fid !== runnerFrameId) return `${label}: the runner frame was replaced`;
  const c = selectFrameContext(contexts, runnerFrameId);
  if (c.context?.id !== ctxId) return `${label}: the runner frame's context was replaced (${c.refused ?? c.context?.id})`;
  const s = selectRunner(attached, runnerFrameId);
  if (s.worker?.sessionId !== wk) return `${label}: the binding changed (${s.refused ?? s.worker?.url})`;
  const gi = await sendWithin(5000, "Target.getTargetInfo", "Target.getTargetInfo", { targetId: t.targetId });
  const i = gi.result?.targetInfo;
  if (!i) console.log(`  target info: unavailable (${what(gi) ?? "none"})`);
  else if (i.type !== t.type || i.url !== t.url || (i.parentFrameId ?? null) !== (t.parentFrameId ?? null)) return `${label}: target info changed (${JSON.stringify(i).slice(0, 300)})`;
  return null;
}
const kind = (sid) => (sid === undefined ? "page" : `${attached.get(sid)?.type ?? "?"}:${sid.slice(0, 6)}`);
// from the records only (no call), so it can't hang
function printTargets(label, rf) {
  console.log(`     targets (${label}); runner frame ${rf ?? "?"}, page frame ${mainFrameId ?? "?"}:`);
  for (const t of [...attached.values()].sort((a, b) => a.order - b.order)) console.log(`       #${t.order} ${t.type} ${t.url}${t.title && t.title !== t.url ? ` "${t.title}"` : ""} parentFrame=${t.parentFrameId ?? "-"} parent=${kind(t.parentSession)}${t.detached ? " DETACHED" : ""} [${t.phase}]`);
  for (const c of contexts) if (c.auxData?.isDefault && !c.gone) console.log(`       context ${c.id} frame=${c.auxData.frameId} session=${kind(c.sessionId)} origin=${c.origin}`);
}
// CSP reports by session and phase, printed only: which realm a report is logged in is not asserted
function printCsp(runnerFrameId, wk) {
  const rf = [...attached.values()].find((t) => t.type === "iframe" && t.targetId === runnerFrameId)?.sessionId;
  const counts = new Map();
  for (const v of cspLog) {
    const k = `${v.sessionId === undefined ? "page" : v.sessionId === wk ? "runner worker" : v.sessionId === rf ? "runner frame" : kind(v.sessionId)} [${v.phase}]`;
    const e = counts.get(k) ?? { reports: 0, beacon: 0 };
    e.reports++;
    if (/example\.com\/beacon/.test(v.text)) e.beacon++;
    counts.set(k, e);
  }
  console.log("     CSP reports by session (printed, not asserted): " + JSON.stringify(Object.fromEntries(counts)));
}
// every other live worker, probed and printed, never a failure: 5 s each, 20 s in all
async function reportOthers(wk) {
  const end = performance.now() + 20000;
  for (const t of [...attached.values()].filter((t) => t.type === "worker" && !t.detached && t.sessionId !== wk).sort((a, b) => a.order - b.order)) {
    const head = `info #${t.order} ${t.url} parentFrame=${t.parentFrameId ?? "-"} parent=${kind(t.parentSession)}`;
    const left = end - performance.now();
    if (left <= 0) { console.log(`${head}: skipped (phase budget)`); continue; }
    const r = await evWithin(Math.min(5000, left), "report-only probe", PROBE, t.sessionId);
    console.log(`${head}: ${r.fail ? `unavailable (${r.fail})` : JSON.stringify(r.value)}`);
  }
}
// C-live: a page worker made now attaches after the runner's; the earlier rule must pick it, and the binding must not move
async function cLive(wk, runnerFrameId) {
  const before = attachOrder;
  const made = await evWithin(5000, "the page worker for C-live", `(() => { window.__sbCompetitor = new Worker(URL.createObjectURL(new Blob(["onmessage = () => {}"], { type: "text/javascript" }))); return true; })()`);
  ok(made.value === true, "C-live: the page made a worker of its own: " + (made.fail ?? "yes"));
  const got = await untilWithin(10000, "the page worker's attach", async () => [...attached.values()].find((t) => t.type === "worker" && t.order > before && t.parentSession === undefined && !t.detached && t.url.startsWith("blob:http")) ?? null);
  const c = got.value;
  ok(!!c, "C-live: a page worker attached after the runner's: " + (c ? `#${c.order} ${c.url}` : "it never attached"));
  if (!c) return undefined;
  const last = selectLast(attached);
  ok(!!last && last.sessionId !== wk, "C-live (separating): the earlier last-worker rule picks the page worker, not the runner's: " + (last ? `#${last.order} ${last.url}` : "none"));
  const again = selectRunner(attached, runnerFrameId);
  ok(again.worker?.sessionId === wk, "C-live: the runner's worker is still the one bound: " + (again.worker ? `#${again.worker.order} ${again.worker.url}` : again.refused));
  return c.sessionId;
}

// The selection's branches, from records (no browser).  Only F1 and F7 (and C-live, in the browser) separate the
// earlier rule from this one; every other record checks its own expected result.
function selectorFixtures() {
  let o = 0;
  const T = (sessionId, type, x = {}) => [sessionId, { sessionId, targetId: x.targetId ?? sessionId, type, url: x.url ?? `${type}:${sessionId}`, title: "", parentFrameId: x.pfi, parentSession: x.parent, order: ++o, detached: !!x.detached, phase: "fixture" }];
  const M = (...ts) => { o = 0; return new Map(ts.map((f) => f())); };
  const R = "RF", sel = (ts) => selectRunner(ts, R), id = (s) => s.worker?.sessionId ?? s.refused;
  let ts;
  ts = M(() => T("w", "worker", { pfi: R }), () => T("c", "worker", { pfi: "MAIN" }));
  ok(selectLast(ts)?.sessionId !== "w", "fixture F1 (separating): with a page worker attached after the runner's, the earlier rule picks the page worker");
  ok(id(sel(ts)) === "w", "fixture F1: the runner's worker is bound, a page worker attached after it");
  ts = M(() => T("c", "worker", { pfi: "MAIN" }), () => T("w", "worker", { pfi: R }));
  ok(id(sel(ts)) === "w", `fixture F2: the runner's worker is bound, a page worker attached before it (the earlier rule ${selectLast(ts)?.sessionId === "w" ? "agrees here: no separation" : "differs"})`);
  ts = M(() => T("w", "worker", { pfi: R, detached: true }), () => T("w2", "worker", { pfi: R }));
  ok(id(sel(ts)) === "w2", "fixture F3: a detached worker is never bound; its live successor is");
  ts = M(() => T("w", "worker", { pfi: R }), () => T("old", "worker", { pfi: "RF0" }));
  ok(id(sel(ts)) === "w", "fixture F4: a worker of an earlier frame is not bound");
  ts = M(() => T("c", "worker", { pfi: "MAIN" }));
  ok(id(sel(ts)) === "0 bound", "fixture F5: no worker of the runner frame: refused (0 bound)");
  ts = M(() => T("w", "worker", { pfi: R }), () => T("w2", "worker", { pfi: R }));
  ok(id(sel(ts)) === "2 bound", "fixture F6: two workers of the runner frame: refused (2 bound)");
  ts = M(() => T("w", "worker", { pfi: R }), () => T("nest", "worker", { pfi: R, parent: "w" }));
  ok(selectLast(ts)?.sessionId !== "w", "fixture F7 (separating): with a nested worker attached after the runner's, the earlier rule picks the nested one");
  ok(id(sel(ts)) === "w", "fixture F7: a worker another worker attached is never bound");
  ts = M(() => T("f", "iframe", { targetId: R }), () => T("w", "worker", { parent: "f" }));
  ok(id(sel(ts)) === "w" && sel(ts).binding === "S", "fixture F8: no parentFrameId anywhere: the worker the runner frame's own target attached (binding S)");
  ts = M(() => T("w", "worker", {}));
  ok(/^unidentifiable/.test(id(sel(ts))), "fixture F9: no parentFrameId and no target for the frame: refused (unidentifiable)");
  ts = M(() => T("f", "iframe", { targetId: R }), () => T("f2", "iframe", { targetId: R }), () => T("w", "worker", { parent: "f" }));
  ok(/^unidentifiable/.test(id(sel(ts))), "fixture F10: no parentFrameId and two targets for the frame: refused (unidentifiable)");
  ts = M(() => T("c", "worker", { pfi: "MAIN" }), () => T("f", "iframe", { targetId: R }), () => T("x", "worker", { pfi: "OTHER", parent: "f" }));
  ok(id(sel(ts)) === "contradictory metadata", "fixture F11: the frame's own target attached a worker naming another frame: refused (contradictory)");
  ts = M(() => T("w", "worker", { pfi: R, detached: true }), () => T("x", "worker", { pfi: "RF2" }));
  ok(id(sel(ts)) === "0 bound", "fixture F12: the bound worker gone and another frame's present: refused (never a switch)");
  ts = M(() => T("w", "worker", { pfi: R, parent: "nobody" }));
  ok(id(sel(ts)) === "0 bound", "fixture F15: a worker whose parent session was never recorded is not bound");
  ts = M(() => T("sw", "service_worker", {}), () => T("w", "worker", { pfi: R, parent: "sw" }));
  ok(id(sel(ts)) === "0 bound", "fixture F16: a worker whose parent is neither the page nor a frame is not bound");
  ts = M(() => T("f", "iframe", { targetId: R, detached: true }), () => T("w", "worker", { pfi: R, parent: "f" }));
  ok(id(sel(ts)) === "0 bound", "fixture F17: a worker whose parent frame's target has detached is not bound");
  ts = M(() => T("c", "worker", { pfi: "MAIN" }), () => T("f", "iframe", { targetId: R }), () => T("w", "worker", { pfi: R, parent: "f" }));
  ok(id(sel(ts)) === "w" && sel(ts).binding === "P", "fixture F18: a worker the runner frame's live target attached, naming that frame, is bound (binding P)");
  const C = (id, x = {}) => ({ id, auxData: { isDefault: true, frameId: x.frameId ?? R }, gone: !!x.gone });
  ok(selectFrameContext([C(1, { gone: true }), C(2)], R).context?.id === 2, "fixture F13: the frame's destroyed context is passed over for its live one");
  ok(selectFrameContext([C(1), C(2)], R).refused === "2 live", "fixture F14: two live contexts for the frame: refused (2 live)");
  const W = (ctx, x = {}) => ({ sessionId: x.session, executionContextId: ctx, emittedAt: 0, receivedAt: 0, receivedPhase: x.phase ?? "stuck" });
  ok(eligible(W(7), 7), "fixture K1: the stuck page's own warning counts");
  ok(!eligible(W(3), 7), "fixture K2: the old page's warning, received after the switch, doesn't count");
  ok(!eligible(W(2), 7), "fixture K3: a warning of a context destroyed before the navigation (a replay) doesn't count");
  ok(!eligible(W(7, { session: "w" }), 7), "fixture K4: a worker's warning with the same context number doesn't count");
  ok(eligible(W(7, { phase: "main" }), 7), "fixture K5: the stuck page's warning counts whatever phase it was received in");
}
async function run(code) {
  await ev(`(() => { const cs = [...document.querySelectorAll('.cell')]; let c = cs.at(-1); if (c.querySelector('textarea').value.trim()) { document.querySelector('#add').click(); c = [...document.querySelectorAll('.cell')].at(-1); } const ta = c.querySelector('textarea'); ta.value = ${JSON.stringify(code)}; ta.dispatchEvent(new Event('input', {bubbles: true})); ta.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', shiftKey: true, bubbles: true})); })()`);
  await sleep(150);
  await until("(() => { const c = [...document.querySelectorAll('.cell')].filter(c => c.querySelector('textarea').value.trim()).at(-1); return !c.classList.contains('running') && !c.classList.contains('queued') && /\\[\\d+\\]/.test(c.querySelector('.n').textContent); })()", 60000);
  return ev("[...document.querySelectorAll('.cell')].filter(c => c.querySelector('textarea').value.trim()).at(-1).querySelector('.out').textContent");
}
// what a script in a context can reach
const PROBE = `(async () => {
  const out = {};
  out.origin = self.origin;
  try { localStorage.length; out.localStorage = true; } catch { out.localStorage = false; }
  try { await new Promise((res, rej) => { const r = indexedDB.open("probe"); r.onsuccess = res; r.onerror = () => rej(r.error); }); out.indexedDB = true; } catch { out.indexedDB = false; }
  try { out.parentDocument = !!(self.parent && self.parent !== self && self.parent.document); } catch { out.parentDocument = false; }
  try { out.cookie = typeof document !== "undefined" ? document.cookie : null; } catch { out.cookie = "denied"; }
  out.isolated = self.crossOriginIsolated;
  out.secure = self.isSecureContext;
  out.subtle = !!(self.crypto && self.crypto.subtle);
  out.precompiled = Object.keys(self.__SAGEBRUSH_PRECOMPILED__?.modules ?? {}).length;
  const reach = async (u, credentials = "include") => { try { await fetch(u, { mode: "cors", credentials }); return true; } catch { return false; } };
  out.elsewhere = await reach("https://example.com/");
  out.sitePage = await reach(${JSON.stringify(new URL("/", base).href)} + "?probe");
  out.ownFiles = await reach(${JSON.stringify(new URL("sagebrush-worker.js", base).href)}, "omit");
  out.websocket = await new Promise((res) => { try { const w = new WebSocket("wss://example.com/"); w.onopen = () => res(true); w.onerror = () => res(false); } catch { res(false); } });
  // (a beacon is queued, then checked: the CSP reports say whether it went)
  if (typeof navigator.sendBeacon === "function") { navigator.sendBeacon("https://example.com/beacon", "x"); out.beacon = "attempted"; } else out.beacon = "unsupported";
  return out;
})()`;

try {
  console.log("     chrome: " + (await chromeVersion()));
  selectorFixtures();
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Network.enable");
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  const ft = await sendWithin(5000, "Page.getFrameTree", "Page.getFrameTree");
  mainFrameId = ft.result?.frameTree?.frame?.id;
  ok(!!mainFrameId, "the page's frame (Page.getFrameTree): " + (mainFrameId ?? what(ft) ?? "none"));
  await send("Page.navigate", { url: new URL(process.env.NO_RUNNER ? "?runner=0" : "./", base).href });
  await until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000);
  console.log("     " + (await ev("document.querySelector('#status').textContent")));
  const frame = await ev("(() => { const f = document.querySelector('iframe[sandbox]'); return f && { sandbox: f.getAttribute('sandbox'), src: f.src }; })()");
  ok(frame?.sandbox === "allow-scripts", "the interpreter runs in <iframe sandbox=\"allow-scripts\">: " + JSON.stringify(frame));
  ok((await run("sum(range(10))")).trim() === "45", "code runs in the runner");
  ok((await run("from fractions import Fraction\nprint(Fraction(1, 3) + Fraction(1, 6))")).includes("1/2"), "printing works");
  ok((await run("import numpy as np\nprint(np.arange(6).reshape(2, 3).sum(axis=0))")).includes("[3 5 7]"), "numpy works");
  // (a module of a part of the library no start loads: its chunk, like the
  // engine and Sage's part below, fetched by the page and handed through the
  // frame; web/lib-lazy.ts)
  ok((await run("import heapq\nprint(heapq.nsmallest(2, [3, 1, 2]))")).includes("[1, 2]"), "a library module imported later: its chunk through the frame");
  // (a package's submodule under a library package: scipy is lib/'s, scipy.io
  // @sagebrush/scipy-io's, found by its full name; its chunk through the frame)
  const mat = (await run("import scipy.io as sio, numpy as np\nsio.savemat('t.mat', {'A': np.arange(4.)})\nprint(sio.loadmat('t.mat')['A'].tolist(), sio.__name__)")).trim();
  ok(mat === "[[0.0, 1.0, 2.0, 3.0]] scipy.io", "a package's submodule imports (scipy.io, @sagebrush/scipy-io), savemat and loadmat: " + mat);
  // (changing the language of a notebook with code asks first: yes)
  await ev("(() => { window.confirm = () => true; const m = document.querySelector('#mode'); m.value = 'sage'; m.dispatchEvent(new Event('change', {bubbles: true})); })()");
  await sleep(500);
  const f = (await run("factor(2^64 + 1)")).trim();
  ok(f === "274177 * 67280421310721", "Sage mode and the engine work, with no network in the runner: " + f);
  // (a package's module, packages/cremona-small: its chunk through the frame,
  // checked against the registry, src/compile.ts)
  const ec = (await run("EllipticCurve('11a1').ainvs()")).trim();
  ok(ec === "(0, -1, 1, -10, -20)", "a package's module imports (Cremona's table, @sagebrush/cremona-small): " + ec);
  // (elliptic curves over GF(p), lib/_sage_ec_ff.py, are their own chunk,
  // mod-sage-ec-ff: Sage's start and another Sage extra fetch none of it (a
  // symbolic matrix's determinant, lib/_sage_matrix_sr.py in sage-more); the
  // first curve over GF(p) fetches it once and gives Sage's answer; the
  // expected lines are SageMath 10.9's output of the same statements)
  const ecFetches = () => libFetched.filter((g) => g === "mod-sage-ec-ff").length;
  const moreBefore = libFetched.filter((g) => g === "sage-more").length;
  const det = (await run("var('t'); print(matrix(SR, [[t, 1], [1, t]]).det())")).trim();
  ok(det === "t^2 - 1" && libFetched.filter((g) => g === "sage-more").length > moreBefore && ecFetches() === 0, "another Sage extra (sage-more) fetches no mod-sage-ec-ff: " + JSON.stringify([det, libFetched]));
  const ff = (await run("E = EllipticCurve([Mod(7, 11), Mod(2, 11)]); print(E.order(), E((8, 3)))")).trim();
  ok(ff === "7 (8 : 3 : 1)" && ecFetches() === 1, "an elliptic curve over GF(p) fetches mod-sage-ec-ff, once, and gives Sage's answer: " + JSON.stringify([ff, libFetched]));

  // Stop: a KeyboardInterrupt that keeps the variables (if the frame is cross-origin isolated)
  await run("kept = 42");
  await ev(`(() => { document.querySelector('#add').click(); const c = [...document.querySelectorAll('.cell')].at(-1); const ta = c.querySelector('textarea'); ta.value = 'while True:\\n    pass'; ta.dispatchEvent(new Event('input', {bubbles: true})); ta.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', shiftKey: true, bubbles: true})); })()`);
  await sleep(1500);
  await ev("document.querySelector('#stop').click()");
  await until("!document.querySelector('.cell.running')", 10000);
  const stopped = await ev("[...document.querySelectorAll('.cell')].filter(c => c.querySelector('textarea').value.trim()).at(-1).querySelector('.out').textContent");
  const kept = (await run("globals()['kept']")).trim();
  ok(/KeyboardInterrupt/.test(stopped) && kept === "42", `Stop interrupts and keeps the variables: ${JSON.stringify(stopped.trim().split("\n").at(-1))}, kept = ${kept}`);

  // from inside: the frame's own context, and the worker, each found by the frame they belong to
  const runnerFrameId = (lastRunnerFrameId = await runnerFrame());
  printTargets("before the identity checks", runnerFrameId);
  const ctxSel = selectFrameContext(contexts, runnerFrameId);
  const frameCtx = ctxSel.context;
  if (!frameCtx) console.log("     the runner frame's context: " + ctxSel.refused);
  ok(!!frameCtx, "found the frame's context");
  if (!frameCtx) throw new Error("the runner frame's context: " + ctxSel.refused);
  const inFrame = await evIn(PROBE, { contextId: frameCtx.id, sessionId: frameCtx.sessionId });
  ok(inFrame.origin === "null" && !inFrame.localStorage && !inFrame.indexedDB && !inFrame.parentDocument && inFrame.cookie !== "x", "the frame: an opaque origin, no storage, no page: " + JSON.stringify(inFrame));
  ok(!inFrame.elsewhere && !inFrame.sitePage && !inFrame.websocket && !inFrame.ownFiles, "the frame: no network at all, not even Sagebrush's own files");
  const bound = await untilWithin(10000, "the runner's worker", async () => { const s = selectRunner(attached, runnerFrameId); return s.worker ? s : null; });
  const sel = bound.value ?? selectRunner(attached, runnerFrameId);
  printTargets("the runner's worker: " + (sel.worker ? `#${sel.worker.order}, binding ${sel.binding}` : sel.refused), runnerFrameId);
  ok(!!sel.worker, `the runner's worker, by the frame it belongs to (binding ${sel.binding}): ${sel.worker ? "one" : sel.refused}`);
  const wk = sel.worker?.sessionId;
  ok(!!wk, "found the worker");
  if (!wk) throw new Error("the runner's worker: " + sel.refused);
  ok(sel.worker.url.startsWith("blob:null/"), "the runner's worker was made inside the opaque frame: " + sel.worker.url);
  const marker = await evWithin(5000, "__SB_BROKERED__", "self.__SB_BROKERED__ === true", wk);
  ok(marker.value === true, "the runner's worker carries the frame's prefix (__SB_BROKERED__): " + (marker.fail ?? marker.value));
  const competitor = await cLive(wk, runnerFrameId);
  const sb = await stillBound("before the worker probe", runnerFrameId, wk, frameCtx.id);
  ok(sb === null, "the runner's frame and worker are still the ones bound: " + (sb ?? "yes"));
  if (sb) throw new Error(sb);
  ok(rootWarnings().length === 0, "the runner started: no fallback to a plain worker " + said(rootWarnings()));
  const inWorker = await evIn(PROBE, { sessionId: wk });
  ok(inWorker.origin === "null" && !inWorker.indexedDB && !inWorker.elsewhere && !inWorker.sitePage && !inWorker.websocket && !inWorker.ownFiles, "the worker (where escaped code would run): the same, no network at all: " + JSON.stringify(inWorker));
  await sleep(500);
  ok(inWorker.precompiled > 50, "Sage's compiled modules reached the worker (checked by their SHA-256 without crypto.subtle: the runner's worker is not a secure context): " + inWorker.precompiled);
  ok(violations.length > 0 && violations.some((v) => /example\.com\/beacon/.test(v)), `the attempts were blocked by the runner's policy, the beacon too (${violations.length} CSP reports)`);
  console.log("     (that count is every session's reports: the beacon among them is the frame's, since a worker has no sendBeacon, and the worker's blocked fetch and WebSocket attempts may add their own)");
  ok(rootWarnings().length === 0, "the runner started: still no fallback to a plain worker " + said(rootWarnings()));
  if (competitor) {
    // C-hang: a call that never answers is cut at its bound, and the run goes on
    const h0 = performance.now();
    const hang = await sendWithin(2000, "C-hang", "Runtime.evaluate", { expression: "new Promise(() => {})", awaitPromise: true, returnByValue: true }, competitor);
    const hms = performance.now() - h0;
    ok(hang.timeout === true && hms <= 3000 && !waiting.has(hang.id) && !pendingMeta.has(hang.id), `C-hang: a call that never answers is cut at its bound (${what(hang) ?? "answered"}, ${Math.round(hms)} ms)`);
    // C-status: the failure report's own status query, made never to answer
    const st = await reportStatus({ sessionId: competitor, expression: "new Promise(() => {})" });
    ok(st.r.timeout === true, "C-status: timed out by name (" + (what(st.r) ?? "answered") + ")");
    ok(!waiting.has(st.r.id) && !pendingMeta.has(st.r.id), "C-status: its pending entry removed");
    ok(st.ms <= 3000 + 1000, `C-status: within its bound (${Math.round(st.ms)} ms)`);
  } else ok(false, "C-hang and C-status: no page worker to run them in");
  const sb2 = await stillBound("before the report-only probes", runnerFrameId, wk, frameCtx.id);
  ok(sb2 === null, "the runner's frame and worker are still the ones bound: " + (sb2 ?? "yes"));
  printCsp(runnerFrameId, wk);
  await reportOthers(wk);
  const end = await evWithin(5000, "end the page worker", "(window.__sbCompetitor?.terminate(), true)");
  if (end.fail) console.log("     the page worker: not ended (" + end.fail + ")");

  // A runner that answers but whose worker never starts (as in WebKit, where
  // the page doesn't use it now): the notebook page falls back to a plain
  // worker, and code runs, rather than waiting forever
  if (!process.env.NO_RUNNER) {
    const stuck = `<!doctype html><script>addEventListener("message", (e) => { if (e.data && e.data.sagebrushRunner === 1) e.ports[0].postMessage({ runnerReady: true }); });</script>`;
    paused = (p) => {
      if (!/\/runner\/(index\.html)?(\?.*)?$/.test(p.request.url)) return send("Fetch.continueRequest", { requestId: p.requestId });
      const headers = [["content-type", "text/html; charset=utf-8"], ["cross-origin-embedder-policy", "require-corp"], ["cross-origin-resource-policy", "cross-origin"]].map(([name, value]) => ({ name, value }));
      return send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200, responseHeaders: headers, body: Buffer.from(stuck).toString("base64") });
    };
    // (from here a fallback warning counts only if the stuck page's own context emitted it; first, the old page's)
    phase = "stuck";
    const oldCtx = contexts.filter((c) => c.sessionId === undefined && !c.gone && c.auxData?.isDefault && c.auxData?.frameId === mainFrameId).at(-1)?.id;
    const seen = warnings.length;
    const cw = await evWithin(5000, "C-warn-old", `(console.warn(${JSON.stringify(FALLBACK_TEXT)}), true)`);
    const oldWarn = (await untilWithin(3000, "C-warn-old's record", async () => warnings.slice(seen).find((w) => w.sessionId === undefined && w.executionContextId === oldCtx) ?? null)).value;
    ok(!!oldWarn, "C-warn-old: the detector recorded the old page's warning, after the switch: " + (oldWarn ? `ctx ${oldWarn.executionContextId}` : cw.fail ?? "not seen"));
    await send("Fetch.enable", { patterns: [{ urlPattern: "*runner*", requestStage: "Request" }] });
    // (test-only diagnostics for the grader's open investigation of this case's timeouts, #488 and #552: on the stuck
    // page, each Worker the page makes (the plain worker) with what it was sent and said, and #status as it changes)
    // (Page.enable first: without it the script is accepted, an identifier returned, and never run)
    // (STUCK_DIAG=0: without the probe, which wraps the very Worker under suspicion: the grader's observer-effect batch)
    let diag = null;
    if (process.env.STUCK_DIAG !== "0") {
      await send("Page.enable");
      diag = await send("Page.addScriptToEvaluateOnNewDocument", { source: STUCK_DIAG });
    }
    if (process.env.STUCK_DIAG !== "0") {
      await send("Target.setDiscoverTargets", { discover: true });
      // (a service worker already running: attached now)
      const sws = ((await send("Target.getTargets"))?.targetInfos ?? []).filter((t) => t.type === "service_worker" && !t.attached);
      for (const t of sws) await sendWithin(3000, "attach the service worker", "Target.attachToTarget", { targetId: t.targetId, flatten: true });
    }
    const ctxBefore = contexts.length;
    const navAt = Date.now();
    await send("Page.navigate", { url: new URL("./", base).href });
    stuckCtx = (await untilWithin(10000, "the stuck page's context", async () => contexts.slice(ctxBefore).find((c) => c.sessionId === undefined && c.auxData?.isDefault && c.auxData?.frameId === mainFrameId && c.id !== oldCtx) ?? null)).value?.id;
    ok(stuckCtx !== undefined, "the stuck page's own context: " + (stuckCtx ?? "it never appeared"));
    await sleep(500);
    const readyWait = await until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000).then(() => "ready", () => "NOT ready (timed out)");
    console.log(`     the stuck page: #status ${readyWait} ${((Date.now() - navAt) / 1000).toFixed(1)} s after it was opened`);
    const t = Date.now();
    const out = (await run("6 * 7").catch((e) => e.message)).trim();
    ok(out === "42", `a runner whose worker doesn't start: the code runs in a plain worker instead (${out}, after ${((Date.now() - t) / 1000).toFixed(1)} s)`);
    if (out !== "42") await reportStuck({ navAt, runAt: t });
    if (diag?.identifier) await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: diag.identifier });
    ok(!!oldWarn && !eligible(oldWarn, stuckCtx), "C-warn-old: a warning from the old page doesn't count for the stuck page");
    const newWarn = (await untilWithin(3000, "the stuck page's warning", async () => warnings.find((w) => eligible(w, stuckCtx)) ?? null)).value;
    ok(!!newWarn, "C-warn-new: the stuck page said it fell back: " + (newWarn ? said([newWarn]) : "no warning from its own context " + said(warnings)));
    await send("Fetch.disable");
    paused = null;
  }
} catch (e) {
  failures++;
  console.log("FAIL", e.message);
  printTargets("at the failure", lastRunnerFrameId);
  await reportStatus();
} finally {
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
