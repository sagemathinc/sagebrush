// The interrupt matrix's browser host (used by web/test-interrupt-matrix.mjs): the notebook
// page's interpreter worker, interrupted with the page's Stop button.  Markers come from the
// cell's own output, read while the cell runs; the Stop is stamped on the harness's clock just
// before the click is dispatched.  CDP observes the worker's identity, the workers' JS heap and the
// page's total memory, and answers the page's JavaScript dialogs.
// Serve web/dist at SB_URL (default http://127.0.0.1:8765/) first, as web/test-notebook.mjs.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "./test-port.mjs";
import { againstBaseline, browserFailure, browserLeak, rowOutcome, workerRoles } from "./interrupt-classify.mjs";

const now = () => Number(process.hrtime.bigint()) / 1e6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// mode: pilot | ci | full (r5 §8.2: --full adds the phase cells and the 20-repeat series).
// remainingMs(): the time left before the run's deadline; every CDP call is clipped to it.
// onChild(pid) / onChildDone(pid): Chrome's process, so the matrix kills its tree if the harness is stopped.
export async function browserPilot({ record = (r) => console.log(JSON.stringify(r)), overBudget = () => false, remainingMs = () => Infinity, mode = "pilot", baseline = { entries: [] }, onChild = () => {}, onChildDone = () => {} } = {}) {
  const url = process.env.SB_URL ?? "http://127.0.0.1:8765/";
  const profile = mkdtempSync(join(tmpdir(), "sb-intr-browser-"));
  let cdpPort = Number(process.env.CDP_PORT) || 0;
  const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", detached: true });
  onChild(chrome.pid);
  const result = { streaming: null, rows: [], worker_ids: [], dialogs: [] };
  let ws;
  try {
    if (!cdpPort) cdpPort = await devtoolsPort(profile);
    let targets;
    for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }
    ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let n = 0;
    const waiting = new Map();
    // (a JavaScript dialog blocks the page until it is answered: the notebook's own confirm() on a
    // language change, which pilots 3-5 misread as a frozen page; each one is accepted and recorded)
    let dialogOpen = null;
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); return; }
      if (m.method === "Page.javascriptDialogOpening") {
        dialogOpen = { type: m.params.type, message: String(m.params.message).slice(0, 200) };
        result.dialogs.push({ ...dialogOpen, accepted: true });
        ws.send(JSON.stringify({ id: ++n, method: "Page.handleJavaScriptDialog", params: { accept: true } }));
      }
      if (m.method === "Page.javascriptDialogClosed") dialogOpen = null;
      // every attached target, the page's own and, through each iframe's session (auto-attached in turn),
      // the iframe's workers: the interpreter is the /runner/ iframe's worker (or a top-level
      // sagebrush-worker.js), never the top-level analyzer (workerRoles; astra CORR-168-R4-1)
      if (m.method === "Target.attachedToTarget") {
        const ti = m.params.targetInfo;
        if (!attached.has(ti.targetId)) attached.set(ti.targetId, { targetId: ti.targetId, type: ti.type, url: ti.url, sessionId: m.params.sessionId, parent: m.sessionId ?? null });
        if (ti.type === "iframe") ws.send(JSON.stringify({ id: ++n, method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId: m.params.sessionId }));
      }
      if (m.method === "Target.detachedFromTarget") for (const [t, x] of attached) if (x.sessionId === m.params.sessionId) attached.delete(t);
    };
    const attached = new Map(); // targetId -> { targetId, type, url, sessionId, parent }
    // every CDP call has a deadline (pilot 3 hung about 20 min), clipped to the run's remaining time
    // (daybreak2 LIMIT-INT168-2): past the deadline a call fails at once with "run budget spent"
    const CDP_MS = 30_000;
    const send = (method, params = {}, ms = CDP_MS, sessionId) => new Promise((r, rej) => {
      const left = remainingMs();
      if (left <= 0) return rej(new Error("run budget spent"));
      const lim = Math.min(ms, left);
      const id = ++n;
      const tm = setTimeout(() => { waiting.delete(id); rej(new Error(lim < ms ? "run budget spent" : `CDP ${method}: no answer in ${ms} ms`)); }, lim);
      waiting.set(id, (v) => { clearTimeout(tm); r(v); });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const ev = async (expression, ms) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, ms); if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); if (r?.code && r?.message) throw new Error("CDP: " + r.message); return r?.result?.value; };
    // (callMs: one evaluate's deadline; a mode switch may keep the page's main thread busy far longer than one call)
    const until = async (expr, ms = 60000, callMs) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr, callMs)) return true; await sleep(50); } throw new Error("timeout: " + expr); };
    // (the last non-empty cell: its output text and whether it still runs)
    const LAST = "[...document.querySelectorAll('.cell')].filter(c => c.querySelector('textarea').value.trim()).at(-1)";
    const state = () => ev(`(() => { const c = ${LAST}; return { out: c.querySelector('.out').textContent, running: c.classList.contains('running') || c.classList.contains('queued') }; })()`);
    const start = (code) => ev(`(() => { const cs = [...document.querySelectorAll('.cell')]; let c = cs.at(-1); if (c.querySelector('textarea').value.trim()) { document.querySelector('#add').click(); c = [...document.querySelectorAll('.cell')].at(-1); } const ta = c.querySelector('textarea'); ta.value = ${JSON.stringify(code)}; ta.dispatchEvent(new Event('input', {bubbles: true})); c.querySelector('[data-a=run]').click(); })()`);
    const workers = async () => ((await send("Target.getTargets"))?.targetInfos ?? []).filter((t) => t.type === "worker").map((t) => ({ id: t.targetId, url: t.url }));
    // the interpreter worker's JS heap: its role found from the attached targets (urls refreshed), then
    // Runtime.getHeapUsage on its own session.  No single interpreter, or no answer: unmeasured (null),
    // never another worker's heap.  The targets and their roles are recorded with every measurement.
    const workerHeap = async () => {
      const urls = new Map(((await send("Target.getTargets"))?.targetInfos ?? []).map((t) => [t.targetId, t.url]));
      for (const x of attached.values()) if (urls.has(x.targetId)) x.url = urls.get(x.targetId);
      const iframes = Object.fromEntries([...attached.values()].filter((x) => x.type === "iframe").map((x) => [x.sessionId, x.url]));
      const roles = workerRoles([...attached.values()].filter((x) => x.type === "worker").map(({ targetId, url, parent }) => ({ targetId, url, parent })), iframes);
      const targets = roles.workers.map((w) => ({ id: w.targetId, url: String(w.url).slice(0, 120), role: w.role, via: w.parent == null ? "page" : "iframe" }));
      if (!roles.interpreter) return { heap: null, targets, why: roles.why };
      const sid = attached.get(roles.interpreter.targetId)?.sessionId;
      const h = sid ? await send("Runtime.getHeapUsage", {}, CDP_MS, sid) : null;
      return { heap: Number.isFinite(h?.usedSize) ? h.usedSize : null, targets, interpreter: roles.interpreter.targetId, ...(Number.isFinite(h?.usedSize) ? {} : { why: "the interpreter worker's heap didn't answer" }) };
    };
    // the page's total, wasm and ArrayBuffer backing included; Chrome resolves the measurement at a
    // garbage collection, so one is forced
    const pageTotal = async () => {
      try {
        await ev("(window.__sbMem = performance.measureUserAgentSpecificMemory().then(m => m.bytes, () => null), 1)");
        await send("HeapProfiler.collectGarbage", {}, CDP_MS);
        return await ev("Promise.race([window.__sbMem, new Promise(r => setTimeout(() => r(null), 25000))])", 30_000);
      } catch { return null; }
    };
    await send("Page.enable");
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await send("Page.navigate", { url });
    await until("document.querySelector('#status')?.textContent.startsWith('ready')");
    result.isolated = await ev("crossOriginIsolated");
    // streaming: does a marker printed by a running cell show while it still runs?
    await start("keep = 41\nprint('EN' + 'TER 0', flush=True)\nimport time\nt = time.monotonic()\nwhile time.monotonic() - t < 4:\n    pass\nprint('RET 0')");
    let seen = null;
    for (const t = now(); now() - t < 20000; ) { const s = await state(); if (/ENTER 0/.test(s.out)) { seen = s.running; break; } await sleep(20); }
    result.streaming = seen === true ? "streams while running" : seen === false ? "only after the cell ends" : "never seen";
    await until(`!${LAST}.classList.contains('running')`);
    result.worker_ids.push(await workers());
    const cases = [
      { id: "P1", mode: "python", nonterminating: true, code: (i) => `print('EN' + 'TER ${i}', flush=True)\ntry:\n    k = 0\n    while True:\n        k += 1\nexcept KeyboardInterrupt:\n    print('K' + 'I ${i}', flush=True)\nprint('PRO' + 'BE ${i} ' + ('ok' if keep == 41 and sum(range(10)) == 45 else 'fail'))`, delay: 1000 },
      { id: "E2", mode: "sage", code: (i) => `n = next_prime(10**22) * next_prime(3 * 10**22)\nprint('EN' + 'TER ${i}', flush=True)\ntry:\n    _r = factor(n)\n    print('R' + 'ET ${i}')\nexcept KeyboardInterrupt:\n    print('K' + 'I ${i}', flush=True)\nprint('PRO' + 'BE ${i} ' + ('ok' if keep == 41 and len(factor(2**64 + 1)) == 2 else 'fail'))`, delay: 1500 },
    ];
    // (the Sage cases run in Sage mode: the page's mode selector, then ready again)
    const MODE_MS = 120_000;
    const modeSwitch = {};
    const setMode = async (mode) => {
      const t0 = now();
      let longest = 0;
      const probe = async (expr) => { const a = now(); const v = await ev(expr, MODE_MS); longest = Math.max(longest, now() - a); return v; };
      await probe(`(() => { const m = document.querySelector('#mode'); if (m.value !== ${JSON.stringify(mode)}) { m.value = ${JSON.stringify(mode)}; m.dispatchEvent(new Event('change', {bubbles: true})); } })()`);
      for (let ok = false; !ok; ) {
        if (now() - t0 > MODE_MS) throw new Error(`mode ${mode}: not ready in ${MODE_MS} ms (longest unanswered evaluate ${Math.round(longest)} ms)`);
        ok = await probe("document.querySelector('#status')?.textContent.startsWith('ready')");
        if (!ok) await sleep(50);
      }
      modeSwitch[mode] = { ready_ms: Math.round(now() - t0), longest_evaluate_ms: Math.round(longest) };
      await start("keep = 41");
      await until(`!${LAST}.classList.contains('running')`);
    };
    // one uninterrupted run (for --full's phases of a terminating case): ENTER to RET, at most 120 s
    const calibrate = async (c) => {
      await start(c.code(0));
      let enter = null;
      for (const t = now(); now() - t < 120_000; ) {
        const out = (await state()).out;
        if (enter == null && /(^|\n)ENTER 0\b/.test(out)) enter = now();
        if (/(^|\n)RET 0\b/.test(out)) return enter != null ? now() - enter : null;
        await sleep(20);
      }
      await ev("document.querySelector('#stop').click()").catch(() => {});
      await until(`!${LAST}.classList.contains('running')`, 20000).catch(() => {});
      return null;
    };
    for (const c of cases) {
      const add = (row) => { result.rows.push(row); record(row); };
      if (overBudget()) { add({ case: c.id, host: "browser", run: mode, outcome: "INVALID", why: "run budget spent" }); continue; }
      try {
        await setMode(c.mode);
      } catch (e) {
        // the mode switch failed: an open dialog or the budget is the harness's (INVALID, named); the page
        // not answering with no dialog open is the page's (FAIL, matched against the baseline)
        const f = browserFailure(e?.message ?? e, dialogOpen);
        const row = { case: c.id, host: "browser", run: mode, outcome: f.outcome, why: "mode " + c.mode + ": " + f.why, out: (await state().catch(() => ({ out: "" }))).out.slice(-600) };
        row.own_outcome = row.outcome;
        row.outcome = againstBaseline({ ...row, trials: [{ outcome: row.outcome, why: row.why }] }, baseline);
        add(row);
        continue;
      }
      // the required cells (r5 §8.2): 5 repeats at the case's delay; --full adds the phases (1/3/10 s
      // for a loop without an end, else 0.15/0.5/0.85 of the measured T) and makes the series 20
      let T = null;
      if (mode === "full" && !c.nonterminating) T = await calibrate(c).catch(() => null);
      if (mode === "full" && !c.nonterminating && T == null) {
        add({ case: c.id, host: "browser", run: mode, outcome: "INVALID", why: "uncalibrated: no uninterrupted RET in 120 s" });
        continue;
      }
      const phases = mode !== "full" ? [] : c.nonterminating ? [1000, 3000, 10000] : [0.15, 0.5, 0.85].map((f) => Math.round(f * T));
      const reps = mode === "full" ? 20 : 5;
      const d = mode === "full" && !c.nonterminating ? Math.round(0.5 * T) : c.delay;
      const plan = [...phases.map((delay) => ({ cell: "phase", delay })), ...Array.from({ length: reps }, (_, k) => ({ cell: "repeat", i: k + 1, delay: d }))];
      const trials = [];
      const samples = [];
      for (let k = 0; k < plan.length; k++) {
        const { cell, delay } = plan[k];
        const i = k + 1, rep = plan[k].i;
        // (the run budget is checked before each trial too, not only between cases)
        if (overBudget()) { trials.push({ i, cell, outcome: "INVALID", why: "run budget spent" }); break; }
        try {
          const w0 = await workers();
          await start(c.code(i));
          let enter = null;
          for (const t = now(); now() - t < 30000; ) { if (new RegExp(`(^|\\n)ENTER ${i}\\b`).test((await state()).out)) { enter = now(); break; } await sleep(20); }
          if (enter == null) {
            trials.push({ i, cell, outcome: "INVALID", why: "no ENTER seen", out: (await state()).out.slice(-600) });
            await ev("document.querySelector('#stop').click()").catch(() => {});
            await until(`!${LAST}.classList.contains('running')`, 20000).catch(() => {});
            break; // (the case never starts: its other trials would only repeat this)
          }
          await sleep(Math.max(0, delay - (now() - enter)));
          const s0 = await state();
          if (/(^|\n)RET /.test(s0.out)) { trials.push({ i, cell, delay_ms: delay, outcome: "INVALID", why: "returned before Stop" }); continue; }
          const t_send = now();
          await ev("document.querySelector('#stop').click()");
          let t_recog = null, out = "";
          for (const t = now(); now() - t < 120000; ) { out = (await state()).out; if (new RegExp(`(^|\\n)KI ${i}\\b`).test(out)) { t_recog = now(); break; } if (/did not stop when interrupted/.test(out)) break; await sleep(20); }
          await until(`!${LAST}.classList.contains('running')`, 130000).catch(() => {});
          out = (await state()).out;
          const w1 = await workers();
          const sameWorker = JSON.stringify(w0.map((w) => w.id)) === JSON.stringify(w1.map((w) => w.id));
          const probe = (out.match(new RegExp(`PROBE ${i} (\\w+)`)) ?? [])[1];
          let outcome = "FAIL", why = "";
          if (/(^|\n)RET /.test(out)) why = "did not stop (returned after the Stop)";
          else if (t_recog == null) why = /did not stop/.test(out) ? "interpreter restarted" : "no KeyboardInterrupt within the guard";
          else if (!sameWorker) why = "worker replaced";
          else if (probe !== "ok") why = "probe " + probe;
          else outcome = t_recog - t_send > 10000 ? "SLOW" : "PASS";
          // the leak metrics, on the repeat series: the workers' heap every repeat, the page's total at
          // repeat 3 and at the last (it forces a garbage collection)
          let worker_heap, page_total, heap_targets;
          if (cell === "repeat") {
            const wh = await workerHeap().catch((e) => ({ heap: null, why: String(e?.message ?? e) }));
            worker_heap = wh.heap;
            heap_targets = wh;
            if (rep === 3 || rep === reps) page_total = await pageTotal();
            samples.push({ i: rep, worker_heap, page_total, same_worker: sameWorker });
          }
          trials.push({ i, cell, delay_ms: delay, outcome, why, ...(outcome === "PASS" ? {} : { out: out.slice(-600) }), latency_ms: t_recog && Math.round(t_recog - t_send), poll_ms: 20, same_worker: sameWorker, ...(worker_heap !== undefined ? { worker_heap } : {}), ...(heap_targets ? { heap_targets } : {}), ...(page_total !== undefined ? { page_total } : {}) });
        } catch (e) {
          // a trial that threw: classified (decision 4, astra CORR-168-6), and the case's other trials skipped
          const f = browserFailure(e?.message ?? e, dialogOpen);
          trials.push({ i, cell, delay_ms: delay, ...f });
          break;
        }
      }
      // the leak criterion (r5 §6.1): worker identity, the workers' heap and the page's total, from repeat 3
      const leak = browserLeak(samples);
      const own = rowOutcome(trials, leak && leak.ok);
      const outcome = againstBaseline({ case: c.id, host: "browser", outcome: own, trials, leak }, baseline);
      result.rows.push({ case: c.id, host: "browser", run: mode, ...(modeSwitch[c.mode] ? { mode_switch: modeSwitch[c.mode] } : {}), ...(T != null ? { T_ms: Math.round(T) } : {}), outcome, ...(outcome !== own ? { own_outcome: own } : {}), trials, leak: leak ?? { ok: null, why: "a required leak metric was not measured" } });
      record(result.rows.at(-1));
    }
    result.worker_ids.push(await workers().catch(() => null));
  } finally {
    try { ws?.close(); } catch {}
    try { process.kill(-chrome.pid, "SIGKILL"); } catch {}
    onChildDone(chrome.pid);
    rmSync(profile, { recursive: true, force: true });
  }
  return result;
}
