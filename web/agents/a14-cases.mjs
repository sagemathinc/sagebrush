// A14 (plan r3.1 + r3.2, CODE-CONDITIONS): reconnect after a reload; a lost connection is never silent; a chat Claude
// was in never falls back to the scripted demo. The page cases, run by test-agents-artifacts.mjs (its plain build).
// Each case has its own Chrome (a fresh profile), its own stand-in for sagebrush-agent and its own try, so one case's
// throw doesn't end the others. Every wait is bounded (10-20 s) and a timeout says the page's state (its address,
// load state, the bar's text, whether the record is there, the Connect control); the record's secret is never printed.
// The expiry cases run on a fixed clock: the page's Date.now reads localStorage "__sbclock", and timers over 60 s fire
// only when the test advances it (window.__sbAdvance), so no case depends on the wall clock.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const KEY = "sb-agent-reload-v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const canon = (g) => JSON.stringify({ folders: g?.folders, write: g?.write, run: g?.run, expires: g?.expires });

// The copies (page.ts CONN; board's FINAL merged copy, c388b836), compared by full-string equality.
export const COPY = {
  lost: "Claude disconnected. Your chats are kept; Claude keeps their context while sagebrush-agent runs.",
  restoring: "Reconnecting to Claude…",
  merged: "Couldn't connect to sagebrush-agent on this computer. It may have stopped, this browser may need permission to reach it, or another page may be connected to it.",
  refused: "sagebrush-agent didn't accept this page's last connection, so it needs a new code. If sagebrush-agent was restarted, Claude's earlier context for these chats is gone; your chats are still here.",
  expired: "Claude's access expired.",
  discarded: "Claude's earlier connection was for another page or workspace, so it needs a new code.",
  unusable: "This page's earlier connection to Claude couldn't be used, so it needs a new code.",
  kept: "Claude was connected to this page earlier.",
  hint: "Not connected: Connect Claude to send",
};

// ---- the stand-in for sagebrush-agent (0.3.0, lib/server.mjs at cc11a8a): one paired page at a time (a second upgrade
// gets 409 before the upgrade while a page is paired, :136); the session secret from a code hello, a session hello
// checked against it; a refused hello answered, then the socket closed (:192-193); chats by conversation. Unlike it,
// the code here stays valid (it's single use there, :188): the cases that pair again use the same one.
export function fakeAgent({ name = "Claude", client = "claude-agent-sdk" } = {}) {
  const A = { secret: randomBytes(32).toString("base64url"), live: new Set(), rejected: 0, upgrades: 0, hellos: 0, notes: [], resume: new Map(), silent: false, port: 0, server: null, pending: new Map(), n: 0, page: null, delay: 0 };
  const start = (port) => {
    A.server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        if (new URL(req.url).pathname !== "/sagebrush") return new Response("not here", { status: 404 });
        // (as sagebrush-agent 0.3.0's verifyClient, lib/server.mjs:136 at cc11a8a: 409 while a page is PAIRED)
        if (A.page) { A.rejected++; return new Response("already paired", { status: 409 }); }
        return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
      },
      websocket: {
        open(ws) { A.upgrades++; A.live.add(ws); },
        message(ws, data) {
          const m = JSON.parse(String(data));
          if (m.method === "hello") {
            A.hellos++;
            if (A.silent) return; // (the 10 s bound: an agent that never answers)
            const p = m.params ?? {};
            const good = typeof p.code === "string" ? p.code === "123456" : p.session === A.secret;
            if (!good) {
              // (and the socket closed, as sagebrush-agent does after a refused hello: a new code can then connect)
              ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32001, message: "refused", data: { code: "refused", message: "unknown session: a new code is needed" } } }));
              return void ws.close(1008, "refused");
            }
            A.page = ws;
            const answer = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocol: 1, agent: { name, client, version: "0.3.0" }, wants: { folders: ["/"], write: true, run: false }, ...(typeof p.code === "string" ? { session: A.secret } : {}) } }));
            // (an answer held for A.delay ms: the attempt lasts past a rendering update, so focus effects are seen)
            if (A.delay > 0) setTimeout(answer, A.delay); else answer();
          } else if (m.id && A.pending.has(m.id)) {
            A.pending.get(m.id)(m);
            A.pending.delete(m.id);
          } else if (m.method) {
            A.notes.push(m);
            if (m.method === "chat.message") {
              const c = m.params.conversation;
              if (!A.resume.has(c)) A.resume.set(c, "resume-" + randomBytes(4).toString("hex"));
              const turn_id = "t-" + randomBytes(4).toString("hex");
              for (const event of [{ type: "turn_started" }, { type: "text", text: "ok" }, { type: "turn_finished", outcome: "completed" }]) ws.send(JSON.stringify({ jsonrpc: "2.0", method: "turn.event", params: { conversation: c, turn_id, event } }));
            }
          }
        },
        close(ws) { A.live.delete(ws); if (A.page === ws) A.page = null; },
      },
    });
    A.port = A.server.port;
  };
  start(0);
  A.grants = () => A.notes.filter((m) => m.method === "grant.changed" && Object.keys(m.params ?? {}).length > 0).map((m) => m.params);
  /** The grant after the n-th, once the stand-in has it (bounded): the page shows "Connected" when its allow() is done,
   * which can be before the stand-in has read that allow()'s grant.changed; null if none came. */
  A.newGrant = async (n, ms = 10000) => {
    const t = Date.now(), at0 = A.grants().length;
    while (A.grants().length <= n && Date.now() - t < ms) await sleep(25);
    console.log(`wait ${curCase} new-grant ${Date.now() - t} (had ${at0 - n} new at Connected)`);
    return A.grants().length > n ? A.grants().at(-1) : null;
  };
  A.messages = () => A.notes.filter((m) => m.method === "chat.message").map((m) => m.params);
  /** A round trip on the paired page's socket (a verb the page answers). */
  A.call = (method, params, ms = 5000) => new Promise((resolve) => {
    if (!A.page) return resolve({ none: true });
    const id = "s" + ++A.n;
    A.pending.set(id, resolve);
    A.page.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    setTimeout(() => { if (A.pending.has(id)) { A.pending.delete(id); resolve({ timeout: true }); } }, ms);
  });
  A.stop = () => { A.server.stop(true); A.live.clear(); A.page = null; };
  /** sagebrush-agent forgot this page's session (as after a restart): a new secret, the chats' context gone. */
  A.forget = () => { A.secret = randomBytes(32).toString("base64url"); A.resume.clear(); };
  /** The page's socket closed by the agent's side (an involuntary loss for the page). */
  A.kick = async () => { for (const ws of [...A.live]) ws.close(1011, "gone"); for (let t = Date.now(); A.live.size && Date.now() - t < 5000; ) await sleep(20); };
  /** Is anything listening on the port? (a closed port, confirmed before an attempt) */
  A.listening = () => fetch(`http://127.0.0.1:${A.port}/`).then(() => true, () => false);
  A.quiet = async (ms = 3000) => { const h = A.hellos, u = A.upgrades, r = A.rejected; await sleep(ms); return A.hellos === h && A.upgrades === u && A.rejected === r; };
  return A;
}

// ---- the page's fixed clock and the witness of what the record was at the page's start (facts only, never the secret)
const CLOCK = `(() => {
  const K = "__sbclock", N = "__sbclockNext";
  try { const nx = localStorage.getItem(N); if (nx !== null) { localStorage.setItem(K, nx); localStorage.removeItem(N); } } catch {}
  const real = Date.now.bind(Date);
  Date.now = () => { const v = localStorage.getItem(K); return v === null ? real() : Number(v); };
  const st = window.setTimeout.bind(window), ct = window.clearTimeout.bind(window), long = new Map();
  let next = 1e9;
  window.setTimeout = (f, ms, ...a) => { if (typeof ms === "number" && ms > 60000) { const id = next++; long.set(id, { due: Date.now() + ms, f, a }); return id; } return st(f, ms, ...a); };
  window.clearTimeout = (id) => { if (long.has(id)) long.delete(id); else ct(id); };
  window.__sbAdvance = (t) => { localStorage.setItem(K, String(t)); for (const [id, x] of [...long]) if (x.due <= t) { long.delete(id); try { if (typeof x.f === "function") x.f(...x.a); } catch (e) { console.error(e); } } return long.size; };
})()`;
const WITNESS = `(() => {
  let raw = null;
  try { raw = sessionStorage.getItem(${JSON.stringify(KEY)}); } catch {}
  let r = null;
  try { r = raw === null ? null : JSON.parse(raw); } catch {}
  const keys = r && typeof r === "object" ? Object.keys(r).sort().join() : null;
  window.__a14seen = { present: raw !== null, keys, leftAt: r?.leftAt ?? null, expires: r?.grant?.expires, workspace: r?.workspace ?? null, page: r?.page ?? null, now: Date.now() };
})()`;
// (the case running now, for the timing lines below)
let curCase = "";
/** A dialog wait's time, printed on every call (not a check: "wait <case> <what> <ms>"), so its bound is measured. */
const timed = async (what, p) => { const ms = await p; console.log(`wait ${curCase} ${what} ${ms}`); return ms; };
// (test-only: the browser calls Workspace.open goes through, logged with their times since the page's start, so a
// timeout says which stage the open reached: a Web Lock requested and granted, an IndexedDB open and its outcome, the
// OPFS directory; read by P.state. No product code involved)
const STAGES = `(() => {
  const log = (window.__a14stages = []), t = () => Math.round(performance.now()), add = (s) => { if (log.length < 200) log.push(t() + " " + s); };
  const L = navigator.locks;
  if (L && L.request) {
    const req = L.request.bind(L);
    L.request = (name, ...a) => {
      const cb = a.length > 1 ? a[1] : a[0], opts = a.length > 1 ? a[0] : {};
      add("lock requested " + name + (opts && opts.ifAvailable ? " (ifAvailable)" : ""));
      const wrapped = async (lock) => { add("lock " + (lock ? "granted " : "unavailable ") + name); try { return await cb(lock); } finally { add("lock released " + name); } };
      return a.length > 1 ? req(name, opts, wrapped) : req(name, wrapped);
    };
  }
  const open = indexedDB.open.bind(indexedDB);
  indexedDB.open = (name, ...a) => {
    const r = open(name, ...a);
    if (!String(name).startsWith("__a14probe")) {
      add("idb open " + name);
      r.addEventListener("success", () => add("idb success " + name));
      r.addEventListener("error", () => add("idb error " + name + " " + (r.error && r.error.name)));
      r.addEventListener("blocked", () => add("idb blocked " + name));
      r.addEventListener("upgradeneeded", () => add("idb upgradeneeded " + name));
    }
    return r;
  };
  const st = navigator.storage;
  if (st && st.getDirectory) { const gd = st.getDirectory.bind(st); st.getDirectory = () => { add("opfs getDirectory"); return gd().then((d) => (add("opfs directory"), d), (e) => { add("opfs error " + (e && e.name)); throw e; }); }; }
})()`;
// (test-only: the page's FIRST `n` opens of the workspace store each answered `ms` later: the real open is made then
// and its events passed on; the forced form of a slow first open, A14-22..24. window.__slowWs counts the delayed opens
// made, answered (success or error) and settled (an error, or its database closed), so a test waits for a late open
// to be over instead of assuming it is: the grader's 0bc37cc7, K14-e's A14-24 on a loaded host)
const SLOW_WS_OPEN = (ms, n = 1) => `(() => {
  const open = indexedDB.open.bind(indexedDB);
  const st = (window.__slowWs = { made: 0, answered: 0, settled: 0 });
  let left = ${n};
  indexedDB.open = (name, ...a) => {
    if (left <= 0 || name !== "sagebrush-workspace") return open(name, ...a);
    left--;
    st.made++;
    const fake = new EventTarget(), EV = ["success", "error", "upgradeneeded", "blocked"];
    let real = null;
    for (const k of ["result", "transaction", "error", "readyState", "source"]) Object.defineProperty(fake, k, { get: () => (real ? real[k] : undefined) });
    for (const ev of EV) { let h = null; Object.defineProperty(fake, "on" + ev, { get: () => h, set: (f) => { h = f; } }); }
    setTimeout(() => {
      real = open(name, ...a);
      real.addEventListener("error", () => { st.answered++; st.settled++; });
      real.addEventListener("success", () => {
        st.answered++;
        const db = real.result, close = db.close.bind(db);
        db.close = () => { st.settled++; db.close = close; close(); };
      });
      for (const ev of EV) real.addEventListener(ev, (e) => { const h = fake["on" + ev]; if (h) h.call(fake, e); });
    }, ${ms});
    return fake;
  };
})()`;
const RECORD_KEYS = "agent,grant,leftAt,page,pairingId,port,session,v,workspace";

// ---- a browser: one Chrome, its CDP over the browser socket, pages attached in flat sessions
async function browser() {
  const profile = mkdtempSync(join(tmpdir(), "sb-a14-"));
  const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--password-store=basic", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1280,900", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const port = await devtoolsPort(profile, undefined, { child: chrome });
  let ver;
  for (let i = 0; i < 200 && !ver; i++) ver = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json(), () => null) ?? (await sleep(100), null);
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const waiting = new Map(), handlers = new Set();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    else for (const h of handlers) h(m);
  };
  const B = { inputs: 0, handlers };
  B.send = (method, params = {}, sessionId) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  B.attach = (targetId, o) => attach(B, targetId, o);
  /** A new tab (about:blank), attached, with its scripts, ready to navigate. */
  B.tab = async (o = {}) => B.attach((await B.send("Target.createTarget", { url: "about:blank" })).targetId, o);
  B.close = async () => { try { ws.close(); } catch {} chrome.kill("SIGKILL"); await sleep(200); rmSync(profile, { recursive: true, force: true }); };
  return B;
}

async function attach(B, targetId, { clock = false } = {}) {
  const { sessionId } = await B.send("Target.attachToTarget", { targetId, flatten: true });
  const P = { B, targetId, sessionId, loads: 0, console: [], errors: [] };
  B.handlers.add((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === "Page.loadEventFired") P.loads++;
    else if (m.method === "Runtime.consoleAPICalled") P.console.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    else if (m.method === "Runtime.exceptionThrown") P.errors.push((m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 300));
  });
  P.send = (method, params = {}) => { if (/^Input\./.test(method)) B.inputs++; return B.send(method, params, sessionId); };
  await P.send("Page.enable");
  await P.send("Runtime.enable");
  await P.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  if (clock) await P.send("Page.addScriptToEvaluateOnNewDocument", { source: CLOCK });
  await P.send("Page.addScriptToEvaluateOnNewDocument", { source: WITNESS });
  // (the stage log only on request (A14_STAGES=1): it wraps the very calls it watches, so the default runs are unwrapped)
  if (process.env.A14_STAGES === "1") await P.send("Page.addScriptToEvaluateOnNewDocument", { source: STAGES });
  P.ev = async (expression, o = {}) => {
    const r = await P.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, ...o });
    if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r?.result?.value;
  };
  P.state = () => P.ev(`(async () => ({ href: location.href, readyState: document.readyState, bar: [document.querySelector('#conn-alert')?.textContent, document.querySelector('#conn-status')?.textContent, document.querySelector('#conn-act')?.hidden ? '' : document.querySelector('#conn-act')?.textContent].join(' | '), record: (() => { try { return sessionStorage.getItem(${JSON.stringify(KEY)}) !== null; } catch { return 'unreadable'; } })(), connect: document.querySelector('#connect')?.textContent ?? null, connectHidden: document.querySelector('#connect')?.hidden ?? null, wsError: document.querySelector('#ws-error')?.hidden === false ? document.querySelector('#ws-error-text')?.textContent : null, dialogs: [...document.querySelectorAll('.sbag-dlg h2')].map((h) => h.textContent), sinceLoad: Math.round(performance.now()), locks: await navigator.locks?.query?.().then((q) => ({ held: (q.held ?? []).map((l) => l.name + ':' + l.mode), pending: (q.pending ?? []).map((l) => l.name + ':' + l.mode) })).catch((e) => String(e)), dbs: await indexedDB.databases?.().then((d) => d.map((x) => x.name)).catch((e) => String(e)), stages: (window.__a14stages || []).slice(-40), idbProbe: await Promise.race([new Promise((res) => { try { const r = indexedDB.open('__a14probe_' + Date.now()); r.onsuccess = () => { r.result.close(); res('ok'); }; r.onerror = () => res('error: ' + (r.error?.name ?? '') + ' ' + (r.error?.message ?? '')); r.onblocked = () => res('blocked'); } catch (e) { res('threw: ' + e); } }), new Promise((res) => setTimeout(() => res('no answer in 5 s'), 5000))]), errors: undefined }))()`).then((s) => ({ ...s, errors: P.errors.slice(-3) }), (e) => ({ unreadable: String(e).slice(0, 200) }));
  P.until = async (expr, ms = 15000) => {
    const t = Date.now();
    while (Date.now() - t < ms) { if (await P.ev(expr).catch(() => false)) return Date.now() - t; await sleep(50); }
    throw new Error(`timeout (${ms / 1000} s): ${expr.slice(0, 160)}\n  the page then: ${JSON.stringify(await P.state())}`);
  };
  P.load = async (go) => {
    const before = P.loads;
    await go();
    const t = Date.now();
    while (P.loads === before && Date.now() - t < 20000) await sleep(50);
    if (P.loads === before) throw new Error("timeout (20 s): the load event\n  the page then: " + JSON.stringify(await P.state()));
    await P.until(`document.readyState === 'complete' && !!document.querySelector('#editor .mb')`, 20000);
  };
  P.navigate = (url) => P.load(() => P.send("Page.navigate", { url }));
  P.reload = () => P.load(() => P.send("Page.reload", {}));
  P.key = async (key, extra = {}) => {
    const vk = { Enter: 13, Escape: 27, Tab: 9 }[key] ?? 0;
    await P.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: vk, ...(key === "Enter" ? { text: "\r" } : {}), ...extra });
    await P.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: vk, ...extra });
  };
  /** Text in the composer, typed (the editor's textarea comes on a click into its block). */
  P.draft = async (text) => {
    if (!(await P.ev(`!!document.querySelector('#editor textarea')`))) {
      const [x, y] = await P.ev(`(() => { const r = document.querySelector('#editor .mb-block').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
      for (const type of ["mousePressed", "mouseReleased"]) await P.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    }
    await P.until(`!!document.querySelector('#editor textarea')`);
    await P.ev(`document.querySelector('#editor textarea').focus()`);
    await P.send("Input.insertText", { text });
  };
  P.composer = () => P.ev(`(document.querySelector('#editor textarea')?.value ?? document.querySelector('#editor').textContent).trim()`);
  /** The fixed clock set to t before the page's first load: on a plain document of the site (not the app), so the app
   * loads once, on that clock. */
  P.clock = async (site, t) => {
    const before = P.loads;
    await P.send("Page.navigate", { url: `${site}/__a14-clock` });
    for (const t0 = Date.now(); P.loads === before && Date.now() - t0 < 10000; ) await sleep(50);
    await P.ev(`(localStorage.setItem('__sbclock', ${JSON.stringify(String(t))}), true)`);
  };
  P.sendState = () => P.ev(`(() => { const s = document.querySelector('#send'), h = document.querySelector('#send-hint'); return { ariaDisabled: s.getAttribute('aria-disabled'), disabled: s.disabled, describedby: s.getAttribute('aria-describedby'), hint: h.hidden ? null : document.querySelector('#send-hint-text').textContent, hintAct: h.hidden ? null : document.querySelector('#send-hint-act').textContent, active: document.activeElement === s ? 'send' : document.activeElement === document.body ? 'body' : document.activeElement?.closest('#editor') ? 'editor' : document.activeElement?.closest('#conn-bar') ? document.activeElement.id : (document.activeElement?.tagName ?? null) }; })()`);
  P.bar = () => P.ev(`(() => { const b = document.querySelector('#conn-bar'), a = document.querySelector('#conn-act'); return { on: b.classList.contains('on'), alert: document.querySelector('#conn-alert').textContent, status: document.querySelector('#conn-status').textContent, act: a.hidden ? null : a.textContent, actDisabled: a.disabled, actAriaDisabled: a.getAttribute('aria-disabled'), actBusy: a.getAttribute('aria-busy'), x: !document.querySelector('#conn-x').hidden }; })()`);
  P.users = () => P.ev(`document.querySelectorAll('.user').length`);
  P.turns = () => P.ev(`document.querySelectorAll('.turn').length`);
  P.seen = () => P.ev(`window.__a14seen`);
  P.nav = () => P.ev(`performance.getEntriesByType('navigation')[0]?.type ?? null`);
  P.connected = () => P.ev(`document.querySelector('#connect').textContent === 'Connected'`);
  return P;
}

/** Open the page with a pairing link, connect, and allow everything for `how` (chosen explicitly, never by default:
 * "page", "3600000" or "86400000"); `remember` ticks "Remember this agent"; `write` false grants read only. */
async function pair(P, A, site, how = "page", remember = false, write = true) {
  await P.navigate(`${site}/agents/?pair=123-456&port=${A.port}`);
  // (30 s: under a full counted run's load the page's first load and its dialog can take longer than 15 s)
  await timed("pair-dialog", P.until(`[...document.querySelectorAll('.sbag-dlg button')].some((b) => b.textContent === 'Connect')`, 30000));
  if (process.env.A14_STAGES === "1") {
    // (the first workspace-store open, requested to success, from the stage log: the margin under its 15 s deadline)
    const d = await P.ev(`(() => { const L = window.__a14stages || [], at = (s) => { const x = L.find((l) => l.endsWith(s)); return x ? Number(x.split(" ")[0]) : null; }; const a = at("idb open sagebrush-workspace"), b = at("idb success sagebrush-workspace"); return a === null || b === null ? null : b - a; })()`);
    console.log(`wait ${curCase} ws-open ${d}`);
  }
  await P.ev(`[...document.querySelectorAll('.sbag-dlg button')].find((b) => b.textContent === 'Connect').click()`);
  return allowDialog(P, how, remember, write);
}
/** Connect from the header's Connect Claude (the person's own dialog: the code and the port typed in), then allow. */
async function connectDialog(P, A, how = "page", remember = false, write = true) {
  await P.ev(`document.querySelector('#connect').click()`);
  await timed("connect-dialog", P.until(`[...document.querySelectorAll('.sbag-dlg h2')].some((h) => h.textContent === 'Connect an agent')`, 30000));
  await P.ev(`(() => { const d = [...document.querySelectorAll('.sbag-dlg')].at(-1), [c, pt] = d.querySelectorAll('input'); c.value = '123-456'; pt.value = '${A.port}'; [...d.querySelectorAll('button')].find((b) => b.textContent === 'Connect').click(); return true; })()`);
  return allowDialog(P, how, remember, write);
}
async function allowDialog(P, how, remember, write) {
  await timed("allow-dialog", P.until(`[...document.querySelectorAll('.sbag-dlg button')].some((b) => b.textContent === 'Allow')`, 30000));
  const set = await P.ev(`(() => {
    const d = [...document.querySelectorAll('.sbag-dlg')].at(-1);
    const all = [...d.querySelectorAll('label')].find((l) => l.textContent.startsWith('Everything')).querySelector('input');
    all.checked = true; all.dispatchEvent(new Event('change'));
    const sel = d.querySelector('select'); sel.value = ${JSON.stringify(how)}; sel.dispatchEvent(new Event('change'));
    const rem = [...d.querySelectorAll('label')].find((l) => l.textContent.startsWith('Remember')).querySelector('input');
    if (${remember}) { rem.checked = true; rem.dispatchEvent(new Event('change')); }
    const w = [...d.querySelectorAll('label')].find((l) => l.textContent.startsWith('may change files')).querySelector('input');
    w.checked = ${write};
    const label = sel.selectedOptions[0].textContent;
    [...d.querySelectorAll('button')].find((b) => b.textContent === 'Allow').click();
    return label;
  })()`);
  await P.until(`document.querySelector('#connect').textContent === 'Connected'`);
  return set;
}
/** A chat with a real agent turn in it (the no-demo marker set): a new chat, its first message, the agent's turn. */
async function chat(P, A) {
  const m0 = A.messages().length;
  await P.ev(`document.querySelector('#new').click()`);
  await P.until(`!!document.querySelector('[data-try]')?.offsetParent`);
  await P.ev(`document.querySelector('[data-try]').click()`);
  const t = Date.now();
  while (A.messages().length === m0 && Date.now() - t < 10000) await sleep(50);
  const conv = A.messages().at(-1)?.conversation;
  if (A.messages().length === m0 || !conv) throw new Error("no chat.message reached the agent\n  the page then: " + JSON.stringify(await P.state()));
  await P.until(`document.querySelectorAll('.turn').length > 0 && document.querySelector('#stop').hidden`);
  await sleep(500); // (the chats are saved 300 ms after a change)
  return conv;
}
/** The record, as this page holds it now: its facts (never the secret). */
const recordFacts = (P) => P.ev(`(() => { const raw = sessionStorage.getItem(${JSON.stringify(KEY)}); if (raw === null) return null; const r = JSON.parse(raw); return { keys: Object.keys(r).sort().join(), leftAt: r.leftAt ?? null, expires: r.grant?.expires, folders: r.grant?.folders, write: r.grant?.write, workspace: r.workspace, page: r.page, agent: r.agent }; })()`);

export async function runA14({ site, ok, want = () => true }) {
  const only = process.env.A14 ? new Set(process.env.A14.split(",")) : null;
  const run = async (id, body) => {
    if (only && !only.has(id)) return;
    curCase = id;
    let B = null, A = null;
    try {
      A = fakeAgent();
      B = await browser();
      await body(B, A);
    } catch (e) {
      ok(false, `${id}: the case ran to its end: ${String(e?.stack ?? e).slice(0, 900)}`);
    } finally {
      try { A?.stop(); } catch {}
      await B?.close().catch(() => {});
    }
  };
  if (!want("reconnect")) return;

  // A14-1 (+ A14-10): a reload reconnects silently with the same grant and the same conversation; no secret leaks
  await run("A14-1", async (B, A) => {
    const P = await B.tab();
    // (read only, though the agent asks to write: a restore that widened the grant would show, K14-e)
    const label = await pair(P, A, site, "page", false, false);
    const conv = await chat(P, A);
    const g1 = A.grants().at(-1);
    const pre = await recordFacts(P);
    ok(label === "while this page is open (a reload keeps it)" && g1?.write === false && pre && pre.write === false && pre.keys === RECORD_KEYS.replace("leftAt,", "") && pre.leftAt === null, "A14-1 precondition: the grant chosen explicitly ('while this page is open (a reload keeps it)'); the record is written, exactly its keys, no leftAt while the page lives", { label, pre });
    const inputs = B.inputs, grants = A.grants().length, resume = A.resume.get(conv);
    const seen = { demo: false, other: [], status: new Set() };
    const t0 = Date.now();
    await P.send("Page.reload", {});
    let connectedAt = null;
    while (Date.now() - t0 < 10000) {
      const s = await P.ev(`(() => ({ who: document.querySelector('#who')?.textContent ?? '', banner: document.querySelector('#banner')?.textContent ?? '', alert: document.querySelector('#conn-alert')?.textContent ?? '', status: document.querySelector('#conn-status')?.textContent ?? '', connected: document.querySelector('#connect')?.textContent === 'Connected', ready: document.readyState === 'complete' && !!window.__a14seen }))()`).catch(() => null);
      if (s?.ready) {
        if (/scripted/.test(s.who + s.banner)) seen.demo = true;
        if (s.alert) seen.other.push(s.alert);
        if (s.status) seen.status.add(s.status);
        if (s.connected && A.grants().length > grants) { connectedAt = Date.now() - t0; break; }
      }
      await sleep(25);
    }
    const nav = await P.nav();
    ok(connectedAt !== null && nav === "reload" && B.inputs === inputs, "A14-1: after the reload, 'Connected' within 10 s with no input event sent between the reload and it", { connectedAt, nav, inputs: B.inputs - inputs });
    ok(!seen.demo && seen.other.length === 0 && [...seen.status].every((t) => t === COPY.restoring), "A14-1: no bar ever shown (only the 'Reconnecting to Claude…' line, if any), and the scripted demo never shown", { demo: seen.demo, alerts: seen.other, status: [...seen.status] });
    const g2 = A.grants().at(-1);
    ok(g1 && g2 && canon(g1) === canon(g2) && A.grants().length === grants + 1, "A14-1: the full grant (folders, write, run, expires) is equal before and after", { g1, g2 });
    // the same chat's next message: Send, focused, Enter (the composer's own path), reaches the same conversation
    await P.draft("after the reload");
    await P.ev(`document.querySelector('#send').focus()`);
    const m0 = A.messages().length;
    await P.key("Enter");
    const t1 = Date.now();
    while (A.messages().length === m0 && Date.now() - t1 < 10000) await sleep(50);
    const m = A.messages().at(-1);
    ok(A.messages().length === m0 + 1 && m.conversation === conv && m.text === "after the reload" && A.resume.get(conv) === resume && A.resume.size === 1, "A14-1: a message in the same chat reaches the same conversation (the stand-in's resume id unchanged)", { conv: m?.conversation === conv, text: m?.text, sameResume: A.resume.get(conv) === resume });
    // A14-10: the secret is nowhere but the one record
    await P.until(`document.querySelectorAll('.turn').length >= 2 && document.querySelector('#stop').hidden`);
    await sleep(500);
    const sec = JSON.stringify(A.secret);
    const where = await P.ev(`(() => {
      const s = ${sec}, has = (t) => typeof t === 'string' && t.includes(s);
      const ls = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls.push(k + '=' + localStorage.getItem(k)); }
      const ss = []; for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); if (has(sessionStorage.getItem(k))) ss.push(k); }
      return { dom: has(document.documentElement.outerHTML), url: has(location.href) || performance.getEntriesByType('navigation').some((e) => has(e.name)) || has(JSON.stringify(history.state)), localStorage: has(ls.join('\\n')), sessionKeys: ss };
    })()`);
    const consoleHas = P.console.some((t) => t.includes(A.secret)) || P.errors.some((t) => t.includes(A.secret));
    // (an export of the chat: the page has none today; the chats' only form outside the page is localStorage, checked)
    ok(!where.dom && !where.url && !where.localStorage && !consoleHas && where.sessionKeys.length === 1 && where.sessionKeys[0] === KEY, "A14-10: the session secret is in none of the serialized DOM (attributes too), the console and the page's exceptions, the URL and history, localStorage (the chats); only in the one sessionStorage record", { ...where, console: consoleHas });
  });

  // A14-2: the daemon stops: the disconnected bar (alert); the draft and the focus stay; Send inert, described by the bar
  await run("A14-2", async (B, A) => {
    const P = await B.tab();
    await pair(P, A, site, "page");
    await chat(P, A);
    await P.draft("a draft kept");
    A.stop();
    await P.until(`document.querySelector('#conn-alert').textContent !== ''`);
    const bar = await P.bar(), st = await P.sendState(), draft = await P.composer();
    ok(bar.on && bar.alert === COPY.lost && bar.act === "Reconnect", "A14-2: the disconnected bar, role=alert, says the loss and offers [Reconnect]", bar);
    ok(draft === "a draft kept" && st.active === "editor", "A14-2: the draft is unchanged and the focus is still in the composer (the bar took none)", { draft, active: st.active });
    ok(st.ariaDisabled === "true" && st.disabled === false && st.describedby === "conn-alert", "A14-2: Send is aria-disabled (never disabled) and described by the bar", st);
  });

  // A14-3: the same browser: (a) a new tab has no record; (b) a copied window makes no silent attempt; (c) its
  // [Reconnect] gets 409 (the merged copy) and the first tab stays connected
  await run("A14-3a", async (B, A) => {
    const P = await B.tab();
    await pair(P, A, site, "page");
    await chat(P, A);
    await B.send("Target.closeTarget", { targetId: P.targetId });
    await A.quiet(500);
    const Q = await B.tab();
    const h0 = A.hellos;
    await Q.navigate(`${site}/agents/`);
    const quiet = await A.quiet(3000), seen = await Q.seen(), bar = await Q.bar();
    ok(!seen.present && quiet && A.hellos === h0 && !(await Q.connected()) && !bar.on, "A14-3a: a closed tab, then a NEW tab: no record, nothing reconnects, no bar", { seen, quiet, bar });
  });
  await run("A14-3bc", async (B, A) => {
    const P = await B.tab();
    await pair(P, A, site, "page");
    await chat(P, A);
    const pre = await recordFacts(P);
    const before = new Set((await B.send("Target.getTargets")).targetInfos.map((t) => t.targetId));
    const h0 = A.hellos, u0 = A.upgrades;
    // (a user gesture, as a person's click: headless Chrome blocks a popup without one)
    await P.ev(`(window.open(location.href), true)`, { userGesture: true });
    let info = null;
    for (let t = Date.now(); !info && Date.now() - t < 10000; await sleep(100)) info = (await B.send("Target.getTargets")).targetInfos.find((t) => t.type === "page" && !before.has(t.targetId)) ?? null;
    if (!info) throw new Error("the copied window never appeared");
    const Q = await B.attach(info.targetId);
    await Q.until(`document.readyState === 'complete' && !!document.querySelector('#editor .mb')`, 20000);
    // (precondition: the opener held an exact record with no leftAt when it was copied; the copy's navigation)
    const nav = await Q.nav();
    await Q.until(`document.querySelector('#conn-status').textContent !== ''`);
    const quiet = await A.quiet(3000), bar = await Q.bar();
    ok(pre && pre.keys === RECORD_KEYS.replace("leftAt,", "") && pre.leftAt === null && nav === "navigate", "A14-3b precondition: the opener's record is exact with no leftAt, and the copy's navigation is 'navigate'", { pre: !!pre, leftAt: pre?.leftAt, nav });
    ok(quiet && A.hellos === h0 && A.upgrades === u0 && bar.status === COPY.kept && bar.act === "Reconnect" && (await P.connected()), "A14-3b: the copy makes no silent attempt (no upgrade, no hello); it offers [Reconnect]; the first tab stays connected", { quiet, bar });
    const r0 = A.rejected;
    await Q.ev(`document.querySelector('#conn-act').click()`);
    await Q.until(`document.querySelector('#conn-status').textContent === ${JSON.stringify(COPY.merged)}`);
    const bar2 = await Q.bar();
    const rt = await A.call("workspace.list", { folder: "/" });
    ok(A.rejected === r0 + 1 && bar2.status === COPY.merged && bar2.alert === "", "A14-3c: the copy's [Reconnect] is refused once with 409 (counted by the stand-in) and shows the merged copy", { rejected: A.rejected - r0, bar2 });
    ok(A.live.size === 1 && !!rt.result && (await P.connected()), "A14-3c: the first tab stays connected: a round trip on its socket after the failure", { live: A.live.size, rt: rt.result ? "answered" : rt });
  });

  // A14-4: Revoke, then reload: no bar, nothing reconnects, no record
  await run("A14-4", async (B, A) => {
    const P = await B.tab();
    await pair(P, A, site, "page");
    await chat(P, A);
    await P.ev(`[...document.querySelectorAll('.sbag-bar button')].find((b) => b.textContent === 'Revoke').click()`);
    await P.until(`document.querySelector('#connect').textContent !== 'Connected'`);
    const after = await recordFacts(P);
    await P.reload();
    const quiet = await A.quiet(3000), seen = await P.seen(), bar = await P.bar(), st = await P.sendState();
    ok(after === null && !seen.present && quiet && !bar.on && !(await P.connected()), "A14-4: after Revoke and a reload: no record, nothing reconnects, no bar", { after: !!after, seen: seen.present, quiet, bar });
    ok(st.ariaDisabled === "true" && st.hint === COPY.hint && st.describedby === "send-hint-text", "A14-4: the chat Claude was in doesn't go to the demo: Send inert with the hint", st);
  });

  // A14-5: a remembered timed grant still reconnects after a tab close (unchanged path), announced once in the header
  await run("A14-5", async (B, A) => {
    const T = 1_900_000_000_000;
    const P = await B.tab({ clock: true });
    await P.clock(site, T);
    await pair(P, A, site, "3600000", true);
    await B.send("Target.closeTarget", { targetId: P.targetId });
    await A.quiet(500);
    const Q = await B.tab({ clock: true });
    await Q.navigate(`${site}/agents/`);
    await Q.until(`document.querySelector('#connect').textContent === 'Connected'`);
    const text = await Q.ev(`document.querySelector('#who-status').textContent`);
    await Q.ev(`document.querySelector('#new').click()`);
    await sleep(300);
    const again = await Q.ev(`[document.querySelectorAll('#who-status').length, document.querySelector('#who-status').getAttribute('role'), document.querySelector('#who-status').textContent]`);
    ok(text.startsWith("connected with remembered access: read and write everywhere, until ") && again[0] === 1 && again[1] === "status" && again[2] === text, "A14-5: the remembered grant reconnects after a tab close; the header says it once (one role=status, unchanged by a re-render)", { text, again });
  });

  // A14-6: sagebrush-agent forgot the session while the page was away (a restart), then a reload: B-refused; the
  // record gone; no demo; a second reload makes no attempt (R1-c)
  await run("A14-6", async (B, A) => {
    const P = await B.tab();
    await pair(P, A, site, "page");
    await chat(P, A);
    A.forget();
    await P.reload();
    // (the outcome, not the attempt: "Reconnecting to Claude…" is shown first while the restore runs)
    await P.until(`!['', ${JSON.stringify(COPY.restoring)}].includes(document.querySelector('#conn-status').textContent)`);
    const seen = await P.seen(), bar = await P.bar(), rec = await recordFacts(P), st = await P.sendState(), who = await P.ev(`document.querySelector('#who').textContent`);
    ok(seen.present && seen.keys === RECORD_KEYS && bar.status === COPY.refused && bar.alert === "" && bar.act === "Connect", "A14-6: the B-refused copy, role=status, offering [Connect]", { seen: seen.keys, bar });
    ok(rec === null && !/scripted/.test(who) && st.ariaDisabled === "true", "A14-6: the record is gone; no demo (the header doesn't say it; Send is inert)", { rec: !!rec, who, st });
    const h0 = A.hellos;
    await P.reload();
    const quiet = await A.quiet(3000), seen2 = await P.seen();
    ok(!seen2.present && quiet && A.hellos === h0, "A14-6 (R1-c): a second reload has no record and makes no attempt", { seen2: seen2.present, quiet });
  });

  // A14-7: the copies, each from its own cause, proven from the stand-in's side; one attempt; Reconnecting… aria-busy
  const lostThenReconnect = async (P) => {
    await P.until(`document.querySelector('#conn-alert').textContent === ${JSON.stringify(COPY.lost)}`);
    await P.ev(`document.querySelector('#conn-act').click()`);
  };
  await run("A14-7.closed", async (B, A) => {
    const P = await B.tab();
    await pair(P, A, site, "page");
    await chat(P, A);
    A.stop();
    const listening = await A.listening();
    await P.until(`document.querySelector('#conn-alert').textContent === ${JSON.stringify(COPY.lost)}`);
    // (the button's state read in the same evaluation as the click, so it is the attempt's, whatever its length)
    const during = await P.ev(`(() => { const a = document.querySelector('#conn-act'); a.click(); return { act: a.textContent, actDisabled: a.disabled, actAriaDisabled: a.getAttribute('aria-disabled'), actBusy: a.getAttribute('aria-busy') }; })()`);
    await P.until(`document.querySelector('#conn-status').textContent !== ''`);
    const bar = await P.bar();
    ok(!listening && during.act === "Reconnecting…" && during.actAriaDisabled === "true" && during.actBusy === "true" && during.actDisabled === false, "A14-7.closed: nothing listens (confirmed before the attempt); during it the button reads 'Reconnecting…', aria-disabled and aria-busy, never disabled", { listening, during });
    ok(bar.status === COPY.merged && bar.alert === "" && bar.act === "Reconnect", "A14-7.closed: the merged copy, by full-string equality, with [Reconnect]", bar);
  });
  await run("A14-7.409", async (B, A) => {
    const P = await B.tab();
    await pair(P, A, site, "page");
    await chat(P, A);
    await A.kick();
    // (another page takes sagebrush-agent: an open socket that stays)
    const other = new WebSocket(`ws://127.0.0.1:${A.port}/sagebrush`);
    await new Promise((r, j) => { other.onopen = r; other.onerror = j; });
    other.send(JSON.stringify({ jsonrpc: "2.0", id: "p1", method: "hello", params: { protocol: 1, code: "123456", page: { origin: "http://127.0.0.1", path: "/other/" } } }));
    for (const t = Date.now(); !A.page && Date.now() - t < 5000; ) await sleep(20);
    const r0 = A.rejected;
    await lostThenReconnect(P);
    await P.until(`document.querySelector('#conn-status').textContent !== ''`);
    const bar = await P.bar();
    ok(A.rejected === r0 + 1 && other.readyState === 1 && A.live.size === 1 && A.page !== null, "A14-7.409: the stand-in counts exactly one rejected upgrade (409), and the other page, paired, still has its socket open", { rejected: A.rejected - r0, other: other.readyState });
    ok(bar.status === COPY.merged && bar.alert === "", "A14-7.409: the merged copy, by full-string equality", bar);
    other.close();
  });
  await run("A14-7.refused", async (B, A) => {
    const P = await B.tab();
    await pair(P, A, site, "page");
    await chat(P, A);
    A.forget();
    const h0 = A.hellos;
    await A.kick();
    await lostThenReconnect(P);
    await P.until(`document.querySelector('#conn-status').textContent !== ''`);
    const bar = await P.bar();
    const text = await P.ev(`document.body.innerText`);
    ok(A.hellos === h0 + 1 && bar.status === COPY.refused && bar.act === "Connect" && !text.includes("Couldn't connect to sagebrush-agent"), "A14-7.refused (B-refused, G-e): the socket opens and the hello is refused: the B-refused copy, one hello, and the merged copy absent", { hellos: A.hellos - h0, bar });
  });
  await run("A14-7.timeout", async (B, A) => {
    const P = await B.tab();
    await pair(P, A, site, "page");
    await chat(P, A);
    A.silent = true;
    await A.kick();
    await P.until(`document.querySelector('#conn-alert').textContent === ${JSON.stringify(COPY.lost)}`);
    const t = Date.now();
    await P.ev(`document.querySelector('#conn-act').click()`);
    await P.until(`document.querySelector('#conn-status').textContent !== ''`, 20000);
    const ms = Date.now() - t, bar = await P.bar();
    ok(bar.status === COPY.merged && ms >= 9500 && ms < 15000 && A.hellos >= 2, "A14-7.timeout: an agent that never answers the hello: after the 10 s bound, the merged copy", { ms, bar });
  });

  // A14-8: focus after a successful Reconnect goes to the composer; a Connect dialog closed without connecting gives
  // it back to the bar's button
  await run("A14-8", async (B, A) => {
    const P = await B.tab();
    await pair(P, A, site, "page");
    await chat(P, A);
    await A.kick();
    await P.until(`document.querySelector('#conn-alert').textContent === ${JSON.stringify(COPY.lost)}`);
    await P.ev(`document.querySelector('#conn-act').focus()`);
    A.delay = 600; // (the attempt lasts past a rendering update: a focus lost meanwhile would show)
    await P.key("Enter");
    await P.until(`document.querySelector('#connect').textContent === 'Connected'`);
    A.delay = 0;
    await sleep(200);
    const st = await P.sendState();
    ok(st.active === "editor", "A14-8: after a successful Reconnect from the bar, focus is in the composer (never body)", st);
    A.forget();
    await A.kick();
    await lostThenReconnect(P);
    await P.until(`document.querySelector('#conn-act').textContent === 'Connect'`);
    await P.ev(`document.querySelector('#conn-act').focus()`);
    await P.key("Enter");
    await P.until(`document.activeElement?.closest('.sbag-dlg') !== null && document.activeElement?.tagName === 'INPUT'`);
    await P.key("Escape");
    await sleep(200);
    const back = await P.ev(`[document.querySelectorAll('.sbag-dlg').length, document.activeElement?.id]`);
    ok(back[0] === 0 && back[1] === "conn-act", "A14-8: the Connect dialog, closed without connecting, returns focus to the bar's button", back);
    // (board's B-A14-1/-2, by keyboard: [Connect] from the bar, a new code, Connect, then Allow: the grant dialog takes
    //  focus when it opens, and on success focus goes to the composer)
    await P.key("Enter");
    await P.until(`document.activeElement?.closest('.sbag-dlg') !== null && document.activeElement?.tagName === 'INPUT'`);
    await P.send("Input.insertText", { text: "123-456" });
    await P.key("Tab");
    await P.send("Input.insertText", { text: String(A.port) });
    await P.ev(`[...document.querySelectorAll('.sbag-dlg button')].find((b) => b.textContent === 'Connect').focus()`);
    await P.key("Enter");
    await P.until(`[...document.querySelectorAll('.sbag-dlg button')].some((b) => b.textContent === 'Allow')`);
    await sleep(200);
    const inGrant = await P.ev(`(() => { const a = document.activeElement; return { inDialog: !!a?.closest('.sbag-dlg') && !!a.closest('.sbag-dlg').querySelector('h2')?.textContent.startsWith('Allow'), tag: a?.tagName ?? null }; })()`);
    ok(inGrant.inDialog, "A14-8.allow-focus: the grant dialog (Allow this agent?) has focus when it opens", inGrant);
    // (Space on the focused first control, "Everything": the stand-in asks for "/", which no top folder's box is)
    for (const type of ["keyDown", "keyUp"]) await P.send("Input.dispatchKeyEvent", { type, key: " ", code: "Space", windowsVirtualKeyCode: 32, ...(type === "keyDown" ? { text: " " } : {}) });
    await P.ev(`[...document.querySelectorAll('.sbag-dlg button')].find((b) => b.textContent === 'Allow').focus()`);
    await P.key("Enter");
    await P.until(`document.querySelector('#connect').textContent === 'Connected'`);
    await sleep(200);
    const st3 = await P.sendState();
    ok(st3.active === "editor", "A14-8.connect-focus: after [Connect] from the bar succeeds (a new code, Allow), focus is in the composer (never body)", st3);
  });

  // A14-9: the record's leftAt more than 30 s old (fixed clock), then a reload: no silent attempt; [Reconnect]
  await run("A14-9", async (B, A) => {
    const T = 1_900_000_000_000;
    const P = await B.tab({ clock: true });
    await P.clock(site, T);
    await pair(P, A, site, "page");
    await chat(P, A);
    await P.ev(`(localStorage.setItem('__sbclockNext', '${T + 30001}'), true)`);
    const h0 = A.hellos;
    await P.reload();
    const seen = await P.seen(), nav = await P.nav();
    ok(seen.present && seen.keys === RECORD_KEYS && seen.leftAt === T && seen.now - seen.leftAt === 30001 && nav === "reload" && seen.workspace?.startsWith("sagebrush-workspace/") && seen.page === new URL(site).origin + "/agents/", "A14-9 precondition: the record present and exact, a reload, the same scope, and leftAt deliberately 30 001 ms old", { keys: seen.keys, age: seen.now - seen.leftAt, nav, page: seen.page });
    await P.until(`document.querySelector('#conn-status').textContent !== ''`);
    const quiet = await A.quiet(3000), bar = await P.bar();
    ok(quiet && A.hellos === h0 && bar.status === COPY.kept && bar.act === "Reconnect", "A14-9: no silent attempt; the not-restored bar offers [Reconnect]", { quiet, bar });
  });

  // A14-11: the navigation gate alone: an exact, fresh record that isn't a reload; one click reconnects, same grant
  await run("A14-11", async (B, A) => {
    const P = await B.tab();
    await pair(P, A, site, "page");
    await chat(P, A);
    const g1 = A.grants().at(-1);
    await P.send("Page.navigate", { url: "about:blank" });
    await sleep(500);
    const h0 = A.hellos;
    await P.navigate(`${site}/agents/`);
    const seen = await P.seen(), nav = await P.nav();
    ok(seen.present && seen.keys === RECORD_KEYS && seen.now - seen.leftAt >= 0 && seen.now - seen.leftAt <= 30000 && nav === "navigate" && seen.page === new URL(site).origin + "/agents/", "A14-11 precondition: the record present, exact, fresh (leftAt within 30 s), the same scope; the navigation is 'navigate' (only R1-a stands)", { keys: seen.keys, age: seen.now - seen.leftAt, nav });
    await P.until(`document.querySelector('#conn-status').textContent !== ''`);
    const quiet = await A.quiet(3000), bar = await P.bar();
    ok(quiet && A.hellos === h0 && bar.status === COPY.kept && bar.act === "Reconnect", "A14-11: no silent attempt; the not-restored bar offers [Reconnect]", { quiet, bar });
    const n11 = A.grants().length;
    await P.ev(`document.querySelector('#conn-act').click()`);
    await P.until(`document.querySelector('#connect').textContent === 'Connected'`);
    const g2 = await A.newGrant(n11);
    ok(g2 !== null && canon(g1) === canon(g2) && A.hellos === h0 + 1, "A14-11: one click reconnects with the same grant", { g1, g2 });
  });

  // A14-12: the no-demo marker: a failed restore, then a second reload: Send inert with the hint; nothing reaches the demo
  await run("A14-12", async (B, A) => {
    const P = await B.tab();
    await pair(P, A, site, "page");
    await chat(P, A);
    A.forget();
    await P.reload();
    await P.until(`document.querySelector('#conn-status').textContent === ${JSON.stringify(COPY.refused)}`);
    await P.reload();
    await sleep(1000);
    const st = await P.sendState(), u0 = await P.users(), t0 = await P.turns();
    await P.draft("to the demo?");
    for (const type of ["keyDown", "keyUp"]) await P.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", modifiers: 8, windowsVirtualKeyCode: 13 });
    await sleep(1500);
    const u1 = await P.users(), t1 = await P.turns(), draft = await P.composer();
    ok(st.ariaDisabled === "true" && st.hint === COPY.hint && st.describedby === "send-hint-text", "A14-12: in a chat Claude was in, after a failed restore and a second reload: Send aria-disabled, with the hint", st);
    ok(u1 === u0 && t1 === t0 && draft === "to the demo?", "A14-12: Shift+Enter there sends nothing: no message, no demo turn, the draft kept", { u0, u1, t0, t1, draft });
  });

  // A14-13 (board C1): Send focused, then the daemon stops: focus stays on Send, aria-disabled, and Enter does nothing
  await run("A14-13", async (B, A) => {
    const P = await B.tab();
    await pair(P, A, site, "page");
    await chat(P, A);
    await P.draft("kept here");
    await P.ev(`document.querySelector('#send').focus()`);
    A.stop();
    await P.until(`document.querySelector('#conn-alert').textContent !== ''`);
    const st = await P.sendState(), u0 = await P.users();
    await P.key("Enter");
    await sleep(800);
    const st2 = await P.sendState(), u1 = await P.users(), draft = await P.composer();
    ok(st.active === "send" && st.ariaDisabled === "true" && st.disabled === false, "A14-13: activeElement stays Send, aria-disabled (never disabled)", st);
    ok(st2.active === "send" && u1 === u0 && draft === "kept here", "A14-13: Enter on it does nothing (no message; the draft kept; focus still on Send)", { st2, u0, u1, draft });
  });

  // A14-14 (board C2): after ×, the hint is by Send and is its description; focus to the composer
  await run("A14-14", async (B, A) => {
    const P = await B.tab();
    await pair(P, A, site, "page");
    await chat(P, A);
    A.stop();
    await P.until(`document.querySelector('#conn-alert').textContent !== ''`);
    await P.ev(`document.querySelector('#conn-x').focus()`);
    await P.key("Enter");
    await sleep(200);
    const bar = await P.bar(), st = await P.sendState();
    const shown = await P.ev(`(() => { const h = document.querySelector('#send-hint'); const r = h.getBoundingClientRect(); return !h.hidden && r.width > 0 && r.height > 0; })()`);
    ok(!bar.on && bar.alert === "" && shown && st.hint === COPY.hint && st.describedby === "send-hint-text" && st.active === "editor", "A14-14: after ×, the bar is gone, the hint is visible by Send and is Send's description; focus in the composer", { bar, st, shown });
    // (board's B-A14-3: the hint carries the bar's action as a real button, with the same handler and C3 states)
    const during = await P.ev(`(() => { const a = document.querySelector('#send-hint-act'), t0 = a.textContent, v = a.checkVisibility(); a.focus(); a.click(); return { visible: v, before: t0, act: a.textContent, disabled: a.disabled, busy: a.getAttribute('aria-busy'), ariaDisabled: a.getAttribute('aria-disabled') }; })()`);
    await P.until(`document.querySelector('#conn-status').textContent !== ''`);
    await sleep(200);
    const after = await P.bar(), active = await P.ev(`document.activeElement === document.body ? 'body' : document.activeElement?.id`);
    ok(during.visible && during.before === "Reconnect" && during.act === "Reconnecting…" && during.busy === "true" && during.ariaDisabled === "true" && !during.disabled && after.status === COPY.merged && active === "conn-act", "A14-14.hint-act: after ×, the hint's own [Reconnect] runs the bar's action (Reconnecting…, aria-busy, never disabled); its outcome brings the bar back with focus on the bar's button", { during, after, active });
  });

  // A14-15 (R1-d): a valid, fresh, reload-type record for another workspace (or page): no attempt, gone, [Connect]
  for (const [id, field, value] of [["A14-15.workspace", "workspace", "sagebrush-workspace/ffffffffffffffff"], ["A14-15.page", "page", new URL(site).origin + "/other/"]]) {
    await run(id, async (B, A) => {
      const P = await B.tab();
      await pair(P, A, site, "page");
      await chat(P, A);
      await P.ev(`(() => { const r = JSON.parse(sessionStorage.getItem(${JSON.stringify(KEY)})); r.${field} = ${JSON.stringify(value)}; sessionStorage.setItem(${JSON.stringify(KEY)}, JSON.stringify(r)); return true; })()`);
      const h0 = A.hellos;
      await P.reload();
      const seen = await P.seen(), nav = await P.nav();
      ok(seen.present && seen.keys === RECORD_KEYS && seen.now - seen.leftAt >= 0 && seen.now - seen.leftAt <= 30000 && nav === "reload" && seen[field] === value, `${id} precondition: the record present, exact, fresh, a reload; only its ${field} differs (only R1-d stands)`, { keys: seen.keys, age: seen.now - seen.leftAt, nav });
      await P.until(`document.querySelector('#conn-status').textContent !== ''`);
      const quiet = await A.quiet(3000), bar = await P.bar(), rec = await recordFacts(P);
      await P.ev(`document.querySelector('#conn-act').click()`);
      await sleep(300);
      const dialog = await P.ev(`[...document.querySelectorAll('.sbag-dlg h2')].map((h) => h.textContent).join()`);
      const quiet2 = await A.quiet(1000);
      ok(quiet && A.hellos === h0 && rec === null && bar.status === COPY.discarded && bar.act === "Connect" && dialog === "Connect an agent" && quiet2, `${id}: no attempt; the record gone; nothing kept for a click: the bar offers [Connect], which opens the Connect dialog and tries nothing`, { quiet, bar, rec: !!rec, dialog });
    });
  }

  // A14-16 (r3.2): a timed restore on the fixed clock; the original expiry stands and its timer fires at it
  await run("A14-16", async (B, A) => {
    const T = 1_900_000_000_000, E = T + 3_600_000;
    const P = await B.tab({ clock: true });
    await P.clock(site, T);
    const label = await pair(P, A, site, "3600000");
    await chat(P, A);
    const g1 = A.grants().at(-1), grants = A.grants().length;
    // (the clock 1 s on before the reload, set without advancing it: a restore that recomputed the expiry from now
    // would differ from the original, K14-s; the record stays fresh)
    await P.ev(`(localStorage.setItem('__sbclock', '${T + 1000}'), true)`);
    await P.reload();
    await P.until(`document.querySelector('#connect').textContent === 'Connected'`, 10000);
    const g2 = await A.newGrant(grants);
    ok(label === "for 1 hour" && g1.expires === E && g2 !== null && A.grants().length === grants + 1 && canon(g1) === canon(g2), "A14-16: 'for 1 hour' chosen explicitly; after the reload, 'Connected' with no click and the full grant equal, expires to the ms", { label, g1, g2 });
    await P.ev(`window.__sbAdvance(${E - 1})`);
    await sleep(300);
    const still = await P.connected();
    await P.ev(`window.__sbAdvance(${E})`);
    await P.until(`document.querySelector('#conn-alert').textContent !== ''`, 10000);
    const bar = await P.bar();
    ok(still && bar.alert === COPY.expired && bar.act === "Connect", "A14-16: still connected at expires - 1; at expires the expiry row: \"Claude's access expired. [Connect]\" (role=alert)", { still, bar });
  });

  // A14-17 (r3.2, R1-e): a timed record, then a reload at now = expires (and expires + 1): no attempt; [Connect]
  for (const [id, d] of [["A14-17.at", 0], ["A14-17.after", 1]]) {
    await run(id, async (B, A) => {
      const T = 1_900_000_000_000, E = T + 3_600_000;
      const P = await B.tab({ clock: true });
      await P.clock(site, T);
      await pair(P, A, site, "3600000");
      await chat(P, A);
      // (the clock set without advancing it, so the page's own expiry timer doesn't fire first: the record stays)
      await P.ev(`(localStorage.setItem('__sbclock', '${E + d}'), true)`);
      const h0 = A.hellos, u0 = A.upgrades;
      await P.reload();
      const seen = await P.seen(), nav = await P.nav();
      ok(seen.present && seen.keys === RECORD_KEYS && seen.expires === E && seen.now - seen.leftAt === 0 && nav === "reload" && seen.page === new URL(site).origin + "/agents/", `${id} precondition: the record present, exact, fresh (leftAt now), a reload, the same scope; now = expires${d ? " + 1" : ""}`, { keys: seen.keys, expires: seen.expires === E, age: seen.now - seen.leftAt, nav });
      await P.until(`document.querySelector('#conn-status').textContent !== ''`);
      const quiet = await A.quiet(3000), bar = await P.bar(), rec = await recordFacts(P);
      ok(quiet && A.hellos === h0 && A.upgrades === u0 && rec === null && bar.status === COPY.expired && bar.act === "Connect", `${id}: no attempt (no WebSocket opened); the record gone; nothing kept for a click: "Claude's access expired. [Connect]"`, { quiet, rec: !!rec, bar });
    });
  }

  // A14-19 (astra S1): a record the page may not use (malformed; or exact but not removable) beside a remembered grant:
  // no silent attempt with either; "unusable", [Connect], and the remembered grant only offered, used on its click
  for (const [id, kind] of [["A14-19.malformed", "malformed"], ["A14-19.remove", "remove"]]) {
    await run(id, async (B, A) => {
      const P = await B.tab();
      let facts = null;
      if (kind === "remove") {
        // (an exact record's scope, from a page grant; then Revoke, and a remembered grant from the Connect dialog)
        await pair(P, A, site, "page");
        facts = await recordFacts(P);
        await P.ev(`[...document.querySelectorAll('.sbag-bar button')].find((b) => b.textContent === 'Revoke').click()`);
        await P.until(`document.querySelector('#connect').textContent !== 'Connected'`);
        await connectDialog(P, A, "3600000", true);
      } else {
        await pair(P, A, site, "3600000", true);
      }
      await chat(P, A);
      if (kind === "malformed") await P.ev(`(sessionStorage.setItem(${JSON.stringify(KEY)}, '{bad'), true)`);
      else {
        // (exact, with the live session: if it were used despite its failed removal, it would reconnect silently)
        const rec = { v: 1, pairingId: "0123456789abcdef01234567", session: A.secret, port: A.port, agent: { name: "Claude", client: "claude-agent-sdk" }, grant: { folders: ["/"], write: true, expires: null }, workspace: facts.workspace, page: facts.page };
        await P.ev(`(sessionStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(JSON.stringify(rec))}), true)`);
        await P.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { const rm = Storage.prototype.removeItem; Storage.prototype.removeItem = function (k) { if (k === ${JSON.stringify(KEY)}) throw new Error("denied"); return rm.call(this, k); }; })()` });
      }
      const h0 = A.hellos;
      await P.reload();
      const seen = await P.seen(), nav = await P.nav();
      ok(seen.present && (kind === "malformed" ? seen.keys === null : seen.keys === RECORD_KEYS && seen.now - seen.leftAt >= 0 && seen.now - seen.leftAt <= 30000 && seen.page === facts.page) && nav === "reload", `${id} precondition: a remembered grant is kept, and the record is there at load (${kind === "malformed" ? "not JSON" : "exact, fresh, the same scope, a reload; its removal throws"})`, { present: seen.present, keys: seen.keys, nav });
      await P.until(`document.querySelector('#conn-status').textContent !== ''`);
      await P.until(`!document.querySelector('#conn-bar .remembered').hidden`, 10000).catch(() => {});
      const quiet = await A.quiet(3000), bar = await P.bar();
      const rem = await P.ev(`(() => { const r = document.querySelector('#conn-bar .remembered'); return { shown: !r.hidden, scope: document.querySelector('#conn-scope').textContent }; })()`);
      ok(quiet && A.hellos === h0 && !(await P.connected()) && bar.status === COPY.unusable && bar.act === "Connect" && rem.shown && /^read and write everywhere, until /.test(rem.scope), `${id}: no attempt with the record or the remembered grant; "unusable" with [Connect], and "Use remembered access" offered with its scope`, { quiet, bar, rem });
      await P.ev(`document.querySelector('#conn-remembered').click()`);
      await P.until(`document.querySelector('#connect').textContent === 'Connected'`);
      ok(A.hellos === h0 + 1, `${id}: the remembered grant is used on its own click, once`, { hellos: A.hellos - h0 });
    });
  }

  // A14-20 (astra S2): A lost (its record kept for [Reconnect]), then B connected with a remembered grant, then B lost:
  // the bar offers [Connect], never A's [Reconnect]; A is never contacted again
  await run("A14-20", async (B, A) => {
    const A2 = fakeAgent();
    try {
      const P = await B.tab();
      await pair(P, A, site, "page");
      await chat(P, A);
      await A.kick();
      await P.until(`document.querySelector('#conn-alert').textContent === ${JSON.stringify(COPY.lost)}`);
      const before = await P.bar();
      await connectDialog(P, A2, "3600000", true);
      const hA = A.hellos;
      await A2.kick();
      await P.until(`document.querySelector('#conn-alert').textContent === ${JSON.stringify(COPY.lost)}`);
      const bar = await P.bar();
      await P.ev(`document.querySelector('#conn-act').click()`);
      await sleep(300);
      const dialog = await P.ev(`[...document.querySelectorAll('.sbag-dlg h2')].map((h) => h.textContent).join()`);
      const quiet = await A.quiet(2000);
      ok(before.act === "Reconnect" && bar.act === "Connect" && dialog === "Connect an agent" && quiet && A.hellos === hA, "A14-20: after B (remembered) replaced A and was lost, the bar offers [Connect], which opens the dialog; A's session is never tried", { before: before.act, after: bar.act, dialog, aHellos: A.hellos - hA });
    } finally {
      A2.stop();
    }
  });

  // A14-21 (astra S2, revoke): A lost; B connected (this page only), then B revoked: no bar, no [Reconnect]; A untouched
  await run("A14-21", async (B, A) => {
    const A2 = fakeAgent();
    try {
      const P = await B.tab();
      await pair(P, A, site, "page");
      await chat(P, A);
      await A.kick();
      await P.until(`document.querySelector('#conn-alert').textContent === ${JSON.stringify(COPY.lost)}`);
      await connectDialog(P, A2, "page");
      const hA = A.hellos;
      await P.ev(`[...document.querySelectorAll('.sbag-bar button')].find((b) => b.textContent === 'Revoke').click()`);
      await P.until(`document.querySelector('#connect').textContent !== 'Connected'`);
      await sleep(500);
      const bar = await P.bar(), st = await P.sendState(), quiet = await A.quiet(2000);
      ok(!bar.on && bar.act === null && st.hint === COPY.hint && quiet && A.hellos === hA, "A14-21: after B's Revoke, no bar and no [Reconnect] (the hint by Send); A's session is never tried", { bar, hint: st.hint, aHellos: A.hellos - hA });
    } finally {
      A2.stop();
    }
  });

  // A14-22 (the hang's cause, forced): the page's first workspace-store open answers after 4 s (over the old 3 s
  // deadline, well under the store's 15 s): the pairing link's dialog comes, and no storage message is shown
  await run("A14-22", async (B, A) => {
    const P = await B.tab();
    await P.send("Page.addScriptToEvaluateOnNewDocument", { source: SLOW_WS_OPEN(4000) });
    const t = Date.now();
    await pair(P, A, site, "page");
    const st = await P.ev(`({ err: !document.querySelector('#ws-error').hidden, connectHidden: document.querySelector('#connect').hidden })`);
    ok(Date.now() - t >= 4000 && !st.err && !st.connectHidden, "A14-22: a first workspace open slower than 3 s (4 s, forced) still opens: the pairing dialog comes, no storage message", { ms: Date.now() - t, ...st });
  });

  // A14-23 (@sagebrush's ruling; board's r2.2 R-2, R-3): a workspace that can't be opened is said in words, with
  // [Retry], never a silent demo. The first three opens answer after 16 s (past the 15 s deadline): the message; a
  // [Retry] by keyboard that fails again says so anew (the prefix: the text changes, so role=alert re-announces; focus
  // stays on [Retry]); a second failed [Retry] (the same prefixed text: cleared, then set again) re-announces too; a
  // third [Retry] opens it, the pairing link's dialog comes and has focus (over the move to Connect Claude)
  const WS_MSG = "This browser's storage couldn't be opened, so Claude can't connect on this page. If Sagebrush is open in another tab, close it, then try again.";
  const wsShown = `(() => { const e = document.querySelector('#ws-error'), r = document.querySelector('#ws-retry'); return { role: e.getAttribute('role'), text: document.querySelector('#ws-error-text').textContent, why: document.querySelector('#ws-error-why').textContent, retry: r.textContent, busy: r.getAttribute('aria-busy'), retryVisible: r.checkVisibility(), active: document.activeElement?.id || document.activeElement?.tagName, connectHidden: document.querySelector('#connect').hidden, dialogs: document.querySelectorAll('.sbag-dlg').length, changes: window.__a14wsChanges ?? null }; })()`;
  await run("A14-23", async (B, A) => {
    const P = await B.tab();
    await P.send("Page.addScriptToEvaluateOnNewDocument", { source: SLOW_WS_OPEN(16000, 3) });
    await P.navigate(`${site}/agents/?pair=123-456&port=${A.port}`);
    await P.until(`!document.querySelector('#ws-error').hidden`, 30000);
    const shown = await P.ev(wsShown);
    ok(shown.role === "alert" && shown.text === WS_MSG && shown.why === "(IndexedDB sagebrush-workspace did not open in 15 s)" && shown.retry === "Retry" && shown.retryVisible && shown.connectHidden && shown.dialogs === 0, "A14-23: past the 15 s deadline the page says so in words (role=alert; board's copy, the error's own words in the details) with [Retry]; no pairing, no silent demo", shown);
    await P.until(`((s) => !!s && s.made > 0 && s.settled === s.made)(window.__slowWs)`, 30000); // (waited for, not assumed: the late first open is answered and closed)
    await P.ev(`(() => { window.__a14wsChanges = 0; new MutationObserver((m) => { window.__a14wsChanges += m.length; }).observe(document.querySelector('#ws-error-text'), { childList: true, characterData: true, subtree: true }); document.querySelector('#ws-retry').focus(); return true; })()`);
    await P.key("Enter");
    await P.until(`document.querySelector('#ws-retry').getAttribute('aria-busy') === null && document.querySelector('#ws-retry').textContent === 'Retry'`, 30000);
    const again = await P.ev(wsShown);
    ok(again.text === "Still couldn't open the storage. " + WS_MSG && again.changes > 0 && again.why === shown.why && again.active === "ws-retry" && again.retryVisible && again.connectHidden && again.dialogs === 0, "A14-23.again: a [Retry] that fails again says so anew (the text changes, so the alert re-announces); focus stays on [Retry]", again);
    await P.until(`((s) => !!s && s.made > 0 && s.settled === s.made)(window.__slowWs)`, 30000); // (waited for, not assumed: the second late open is answered and closed)
    await P.ev(`(() => { window.__a14wsChanges = 0; return true; })()`);
    await P.key("Enter");
    await P.until(`document.querySelector('#ws-retry').getAttribute('aria-busy') === null && document.querySelector('#ws-retry').textContent === 'Retry'`, 30000);
    const again2 = await P.ev(wsShown);
    ok(again2.text === "Still couldn't open the storage. " + WS_MSG && again2.changes > 0 && again2.why === shown.why && again2.active === "ws-retry" && again2.retryVisible && again2.connectHidden && again2.dialogs === 0, "A14-23.again2: a second failed [Retry] (the same prefixed text) re-announces too: the text is cleared, then set again; focus stays on [Retry]", again2);
    await P.until(`((s) => !!s && s.made > 0 && s.settled === s.made)(window.__slowWs)`, 30000); // (waited for, not assumed: the third late open is answered and closed)
    await P.key("Enter");
    await P.until(`[...document.querySelectorAll('.sbag-dlg button')].some((b) => b.textContent === 'Connect')`, 20000);
    // (the dialog takes its focus when it opens: up to 3 s for it, then the check)
    await P.until(`!!document.activeElement?.closest('.sbag-dlg')`, 3000).catch(() => null);
    const after = await P.ev(`({ err: !document.querySelector('#ws-error').hidden, connectHidden: document.querySelector('#connect').hidden, active: document.activeElement?.id || document.activeElement?.tagName, inDialog: !!document.activeElement?.closest('.sbag-dlg') })`);
    ok(!after.err && !after.connectHidden && after.inDialog, "A14-23.retry: [Retry] opens the workspace and the pairing link's dialog comes and has focus (over the move to Connect Claude); the message goes", after);
  });

  // A14-24 (board's r2.2 R-1): the same on a page WITHOUT a pairing link: a [Retry] by keyboard that opens the
  // workspace hides the message it was in, and focus goes to Connect Claude (the next step), never to the body
  await run("A14-24", async (B, A) => {
    const P = await B.tab();
    await P.send("Page.addScriptToEvaluateOnNewDocument", { source: SLOW_WS_OPEN(16000) });
    await P.navigate(`${site}/agents/`);
    await P.until(`!document.querySelector('#ws-error').hidden`, 30000);
    await P.until(`((s) => !!s && s.made > 0 && s.settled === s.made)(window.__slowWs)`, 30000); // (waited for, not assumed: the late first open is answered and closed)
    await P.ev(`(() => { document.querySelector('#ws-retry').focus(); return true; })()`);
    await P.key("Enter");
    await P.until(`document.querySelector('#ws-error').hidden`, 20000);
    const st = await P.ev(`({ active: document.activeElement?.id || document.activeElement?.tagName, connect: document.querySelector('#connect').textContent, connectVisible: document.querySelector('#connect').checkVisibility(), dialogs: document.querySelectorAll('.sbag-dlg').length })`);
    ok(st.active === "connect" && st.connectVisible && st.dialogs === 0, "A14-24: on a page without a pairing link, a [Retry] that opens the workspace moves focus to Connect Claude, never to the body", st);
  });

  // A14-24.body: the same, with the [Retry] clicked without taking focus (as Safari's mouse click leaves it: focus on
  // the body throughout): focus still goes to Connect Claude
  await run("A14-24.body", async (B, A) => {
    const P = await B.tab();
    await P.send("Page.addScriptToEvaluateOnNewDocument", { source: SLOW_WS_OPEN(16000) });
    await P.navigate(`${site}/agents/`);
    await P.until(`!document.querySelector('#ws-error').hidden`, 30000);
    await P.until(`((s) => !!s && s.made > 0 && s.settled === s.made)(window.__slowWs)`, 30000); // (waited for, not assumed: the late first open is answered and closed)
    const before = await P.ev(`(() => { document.activeElement?.blur?.(); document.querySelector('#ws-retry').click(); return document.activeElement?.id || document.activeElement?.tagName; })()`);
    await P.until(`document.querySelector('#ws-error').hidden`, 20000);
    const st = await P.ev(`({ active: document.activeElement?.id || document.activeElement?.tagName, connectVisible: document.querySelector('#connect').checkVisibility(), dialogs: document.querySelectorAll('.sbag-dlg').length })`);
    ok(before === "BODY" && st.active === "connect" && st.connectVisible && st.dialogs === 0, "A14-24.body: a [Retry] clicked without taking focus (focus on the body): focus still goes to Connect Claude", { before, ...st });
  });

  // A14-18 (board C3): Enter on [Reconnect] with the daemon down: activeElement is never body; it stays on the button.
  // Two rows: the daemon stopped (a closed port), and one that never answers (the attempt's full 10 s)
  for (const [id, down] of [["A14-18", "stopped"], ["A14-18.slow", "silent"]]) {
    await run(id, async (B, A) => {
      const P = await B.tab();
      await pair(P, A, site, "page");
      await chat(P, A);
      if (down === "stopped") A.stop();
      else { A.silent = true; await A.kick(); }
      await P.until(`document.querySelector('#conn-alert').textContent === ${JSON.stringify(COPY.lost)}`);
      await P.ev(`document.querySelector('#conn-act').focus()`);
      await P.key("Enter");
      const seen = new Set();
      for (let t = Date.now(); Date.now() - t < 15000; await sleep(30)) {
        const a = await P.ev(`document.activeElement === document.body ? 'body' : document.activeElement?.id || document.activeElement?.tagName`);
        seen.add(a);
        if (await P.ev(`document.querySelector('#conn-status').textContent !== ''`)) break;
      }
      await sleep(300);
      const end = await P.ev(`document.activeElement?.id`), bar = await P.bar();
      ok(!seen.has("body") && [...seen].every((a) => a === "conn-act") && end === "conn-act" && bar.status === COPY.merged, `${id}: from Enter on [Reconnect] through its failure (${down === "stopped" ? "a closed port" : "an agent that never answers, 10 s"}), focus never falls to body; it stays on the button`, { seen: [...seen], end, bar });
    });
  }
}
