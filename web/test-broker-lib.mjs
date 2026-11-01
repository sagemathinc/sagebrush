// G-10's browser harness, shared by web/test-runner-broker.mjs (the notebook page) and web/share/test-share-broker.mjs
// (the share client): a Chromium of its own, the page's sessions (each frame in a process of its own and each worker,
// by CDP auto-attach), the recorder the page gets before it starts, the runner's worker found by the frame it belongs
// to, and requests forged from that worker as a compromised interpreter would send them.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "./test-port.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// (a promise given a deadline: past it, an error naming what was awaited; nothing here waits unbounded, astra r1)
export function within(ms, what, p) {
  let t;
  return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(new Error(`${what}: no answer within ${ms / 1000} s`)), ms)))]).finally(() => clearTimeout(t));
}
export const CDP_MS = 30000;

// The cases a file reports, by id (the text of a line before its first colon), and the roster of each page or world:
// a case a page didn't reach is NOT RUN, printed by name and counted as a failure (grader A2/A3)
export function tally() {
  const seen = new Set();
  const t = {
    failures: 0,
    ok(c, msg) { seen.add(String(msg).split(":")[0]); console.log((c ? "ok   " : "FAIL ") + msg); if (!c) t.failures++; },
    // (a page or world: its cases, run by f; a throw is a FAIL line by the page's name, and its cases not reported are
    // NOT RUN; the next page still runs)
    async page(name, ids, f) {
      try { await f(); } catch (e) { t.failures++; console.log(`FAIL ${name} didn't finish: ${e?.message ?? e}`); }
      const miss = ids.filter((i) => !seen.has(i));
      t.failures += miss.length;
      console.log(`${name}: NOT RUN: ${miss.length ? miss.join(", ") : "none"}`);
      return miss;
    },
    summary(file, all) {
      const miss = all.filter((i) => !seen.has(i));
      console.log(`${file}: ${all.length} cases, ${all.length - miss.length} run; NOT RUN: ${miss.length ? miss.join(", ") : "none"}`);
      console.log(t.failures ? `${t.failures} failed` : "all passed");
    },
  };
  return t;
}
export async function until(fn, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(50);
  }
}

// The recorder: in the page only (not the frames), before anything of the page runs. MessagePort keeps its semantics:
// the handler the page sets is the one it reads back, and every message is passed on unchanged; the recorder only
// reads them (an answer's byte length is read before its buffer is transferred). It logs each request the frame
// relays ({runnerFetch} arriving at the page), each answer the page sends ({runnerFetched}), and each {mount} either
// way. `__g14Barrier` (r2.3.1) is this page's only: resolved at once, or, for G14, once a zone's answer has been sent.
export const recorder = (g14 = false) => `(() => {
  if (window.top !== window) return;
  const log = [];
  Object.defineProperty(window, "__sbBrokerLog", { value: log });
  let open;
  Object.defineProperty(globalThis, "__g14Barrier", { value: new Promise((r) => (open = r)) });
  const G14 = ${g14 ? "true" : "false"};
  if (!G14) open();
  const ZONE = /\\/lib\\/tzdata\\/[0-9a-f]{64}\\.tzif$/;
  const P = MessagePort.prototype, post = P.postMessage;
  P.postMessage = function (m, ...rest) {
    let zoneAnswer = false;
    try {
      if (m && typeof m === "object" && typeof m.runnerFetched === "number") {
        log.push({ kind: "answer", id: m.runnerFetched, url: String(m.url), bytes: m.bytes instanceof ArrayBuffer ? m.bytes.byteLength : null, t: performance.now() });
        zoneAnswer = ZONE.test(String(m.url));
      }
      if (m && typeof m === "object" && Array.isArray(m.mount)) log.push({ kind: "mount-out", urls: m.mount.map((x) => x && x[1] && x[1].url), t: performance.now() });
    } catch {}
    const r = post.call(this, m, ...rest);
    if (G14 && zoneAnswer) open(); // (after the answer has been posted: the zone request has been answered)
    return r;
  };
  const d = Object.getOwnPropertyDescriptor(P, "onmessage");
  const orig = new WeakMap();
  Object.defineProperty(P, "onmessage", {
    configurable: true, enumerable: d.enumerable,
    get() { const g = d.get.call(this); return g && orig.has(g) ? orig.get(g) : g; },
    set(f) {
      if (typeof f !== "function") return d.set.call(this, f);
      const g = function (e) {
        try {
          const x = e.data;
          if (x && typeof x === "object" && typeof x.runnerFetch === "number") log.push({ kind: "request", id: x.runnerFetch, url: String(x.url), t: performance.now() });
          if (x && typeof x === "object" && Array.isArray(x.mount)) log.push({ kind: "mount-in", urls: x.mount.map((y) => y && y[1] && y[1].url), t: performance.now() });
        } catch {}
        return f.call(this, e);
      };
      orig.set(g, f);
      d.set.call(this, g);
    },
  });
})();`;

// A Chromium with a profile of its own, and its page: every session's Network requests, every attached target
export async function browser() {
  const profile = mkdtempSync(join(tmpdir(), "sb-broker-chrome-"));
  let cdpPort = Number(process.env.CDP_PORT) || 0;
  const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  if (!cdpPort) cdpPort = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`, { signal: AbortSignal.timeout(2000) })).json(); break; } catch { await sleep(100); } }
  if (!targets) throw new Error("Chrome's DevTools never listed its targets (30 s)");
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await within(10000, "the DevTools WebSocket", new Promise((r, rej) => { ws.onopen = r; ws.onerror = () => rej(new Error("the DevTools WebSocket failed")); }));
  let n = 0;
  const waiting = new Map();
  const attached = new Map(); // sessionId -> {type, targetId, parentFrameId, parentSession, detached}
  const requests = []; // every Network.requestWillBeSent, in every session: {sessionId, url}
  const listeners = []; // (method, params, sessionId) => void
  // (every call bounded: one with no answer is an error naming its method, and its slot is let go)
  const send = (method, params = {}, sessionId) => { const id = ++n; return within(CDP_MS, `CDP ${method}`, new Promise((r) => { waiting.set(id, r); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); })).finally(() => waiting.delete(id)); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? { error: m.error }); waiting.delete(m.id); }
    if (m.method === "Network.requestWillBeSent") requests.push({ sessionId: m.sessionId, url: m.params.request.url });
    if (m.method === "Target.attachedToTarget") {
      const sid = m.params.sessionId, ti = m.params.targetInfo;
      attached.set(sid, { sessionId: sid, type: ti.type, targetId: ti.targetId, url: ti.url, parentFrameId: ti.parentFrameId, parentSession: m.sessionId, detached: false });
      for (const [method, params] of [["Runtime.enable", {}], ["Network.enable", {}], ["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }], ["Runtime.runIfWaitingForDebugger", {}]]) ws.send(JSON.stringify({ id: ++n, method, params, sessionId: sid }));
    }
    if (m.method === "Target.detachedFromTarget") { const t = attached.get(m.params.sessionId); if (t) t.detached = true; }
    if (m.method) for (const f of listeners) f(m.method, m.params, m.sessionId);
  };
  async function ev(expression, sessionId) {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.error || r.exceptionDetails) throw new Error(JSON.stringify(r.error ?? r.exceptionDetails).slice(0, 300));
    return r.result?.value;
  }
  for (const m of ["Page.enable", "Runtime.enable", "DOM.enable", "Network.enable"]) await send(m);
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  let scriptId = null;
  return {
    send, ev, attached, requests, listeners,
    // (the recorder for every page from now on: replaces the one before)
    async record(g14 = false) {
      if (scriptId) await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId });
      scriptId = (await send("Page.addScriptToEvaluateOnNewDocument", { source: recorder(g14) })).identifier;
    },
    log: () => ev("window.__sbBrokerLog.slice()"),
    async close() {
      chrome.kill();
      await sleep(300);
      rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

// The runner's worker: the one worker whose parentFrameId is the page's one sandboxed frame's, and which carries
// the frame's prefix (__SB_BROKERED__)
export async function runnerWorker(b, label) {
  const fid = await until(async () => {
    const el = await b.send("Runtime.evaluate", { expression: "(() => { const fs = document.querySelectorAll('iframe[sandbox]'); return fs.length === 1 ? fs[0] : null; })()" });
    if (!el.result?.objectId) return null;
    const dn = await b.send("DOM.describeNode", { objectId: el.result.objectId });
    return dn.node?.frameId ?? null;
  }, 30000);
  if (!fid) throw new Error(`${label}: no runner frame`);
  const wk = await until(async () => {
    const ws = [...b.attached.values()].filter((t) => t.type === "worker" && !t.detached && t.parentFrameId === fid);
    return ws.length === 1 ? ws[0].sessionId : null;
  }, 30000);
  if (!wk) throw new Error(`${label}: no single worker of the runner frame`);
  if (!(await b.ev("self.__SB_BROKERED__ === true", wk))) throw new Error(`${label}: the bound worker isn't the runner's (no __SB_BROKERED__)`);
  return wk;
}

// A forged request from the runner's worker: the frame's relayed request (witnessed in the page), the page's answer
// to it (the same id and URL; none within 5 s is a failure), and every request any session (and, by `seen`, the
// server) saw meanwhile
export async function forge(b, wk, url, seen = () => []) {
  const mark = { log: (await b.log()).length, net: b.requests.length, srv: seen().length };
  await b.ev(`(postMessage({ brokerFetch: ${JSON.stringify(url)}, offset: 0 }), true)`, wk);
  const got = await until(async () => {
    const l = (await b.log()).slice(mark.log);
    const req = l.find((x) => x.kind === "request" && x.url === url);
    const ans = req && l.find((x) => x.kind === "answer" && x.id === req.id && x.url === url);
    return ans ? { req, ans } : null;
  }, 5000);
  await sleep(300); // (anything the answer set off has time to reach the server)
  return { ...(got ?? {}), net: b.requests.slice(mark.net).map((r) => r.url), srv: seen().slice(mark.srv) };
}

// refused: relayed, answered null, and nothing reached anywhere (but what `quiet` says is unrelated to the case)
export function refused(ok, name, what, r, quiet = () => false) {
  const net = r.net.filter((u) => !quiet(u)), srv = r.srv.filter((p) => !quiet(p));
  ok(!!r.req && !!r.ans && r.ans.bytes === null && net.length === 0 && srv.length === 0,
    `${name}: ${what}: relayed (${r.req ? "id " + r.req.id : "NOT SEEN"}), answered ${r.ans ? (r.ans.bytes === null ? "null" : r.ans.bytes + " bytes") : "NEVER"}, ${net.length} request(s) seen by CDP, ${srv.length} by the server${net.length + srv.length ? ": " + JSON.stringify([...net, ...srv]).slice(0, 300) : ""}`);
}
