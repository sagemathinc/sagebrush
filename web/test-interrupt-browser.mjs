// The interrupt matrix's browser host (used by web/test-interrupt-matrix.mjs): the notebook
// page's interpreter worker, interrupted with the page's Stop button.  Markers come from the
// cell's own output, read while the cell runs; the Stop is stamped on the harness's clock just
// before the click is dispatched.  CDP observes the worker's identity and the page's memory.
// Serve web/dist at SB_URL (default http://127.0.0.1:8765/) first, as web/test-notebook.mjs.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "./test-port.mjs";

const now = () => Number(process.hrtime.bigint()) / 1e6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function browserPilot() {
  const url = process.env.SB_URL ?? "http://127.0.0.1:8765/";
  const profile = mkdtempSync(join(tmpdir(), "sb-intr-browser-"));
  let cdpPort = Number(process.env.CDP_PORT) || 0;
  const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", detached: true });
  const result = { streaming: null, rows: [], worker_ids: [] };
  let ws;
  try {
    if (!cdpPort) cdpPort = await devtoolsPort(profile);
    let targets;
    for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }
    ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let n = 0;
    const waiting = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
    const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value; };
    const until = async (expr, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(50); } throw new Error("timeout: " + expr); };
    // (the last non-empty cell: its output text and whether it still runs)
    const LAST = "[...document.querySelectorAll('.cell')].filter(c => c.querySelector('textarea').value.trim()).at(-1)";
    const state = () => ev(`(() => { const c = ${LAST}; return { out: c.querySelector('.out').textContent, running: c.classList.contains('running') || c.classList.contains('queued') }; })()`);
    const start = (code) => ev(`(() => { const cs = [...document.querySelectorAll('.cell')]; let c = cs.at(-1); if (c.querySelector('textarea').value.trim()) { document.querySelector('#add').click(); c = [...document.querySelectorAll('.cell')].at(-1); } const ta = c.querySelector('textarea'); ta.value = ${JSON.stringify(code)}; ta.dispatchEvent(new Event('input', {bubbles: true})); c.querySelector('[data-a=run]').click(); })()`);
    const workers = async () => ((await send("Target.getTargets"))?.targetInfos ?? []).filter((t) => t.type === "worker").map((t) => ({ id: t.targetId, url: t.url }));
    const memory = async () => { try { return await ev("Promise.race([performance.measureUserAgentSpecificMemory().then(m => m.bytes), new Promise(r => setTimeout(() => r(null), 15000))])"); } catch { return null; } };
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
      { id: "P1", code: (i) => `print('EN' + 'TER ${i}', flush=True)\ntry:\n    k = 0\n    while True:\n        k += 1\nexcept KeyboardInterrupt:\n    print('K' + 'I ${i}', flush=True)\nprint('PRO' + 'BE ${i} ' + ('ok' if keep == 41 and sum(range(10)) == 45 else 'fail'))`, delay: 1000 },
      { id: "E2", code: (i) => `n = next_prime(10**22) * next_prime(3 * 10**22)\nprint('EN' + 'TER ${i}', flush=True)\ntry:\n    _r = factor(n)\n    print('R' + 'ET ${i}')\nexcept KeyboardInterrupt:\n    print('K' + 'I ${i}', flush=True)\nprint('PRO' + 'BE ${i} ' + ('ok' if keep == 41 and len(factor(2**64 + 1)) == 2 else 'fail'))`, delay: 1500 },
    ];
    for (const c of cases) {
      const trials = [];
      for (let i = 1; i <= 5; i++) {
        const w0 = await workers();
        await start(c.code(i));
        let enter = null;
        for (const t = now(); now() - t < 30000; ) { if (new RegExp(`(^|\\n)ENTER ${i}\\b`).test((await state()).out)) { enter = now(); break; } await sleep(20); }
        if (enter == null) { trials.push({ i, outcome: "INVALID", why: "no ENTER seen" }); await until(`!${LAST}.classList.contains('running')`, 130000).catch(() => {}); continue; }
        await sleep(Math.max(0, c.delay - (now() - enter)));
        const s0 = await state();
        if (/(^|\n)RET /.test(s0.out)) { trials.push({ i, outcome: "INVALID", why: "returned before Stop" }); continue; }
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
        if (/(^|\n)RET /.test(out)) { outcome = "INVALID"; why = "returned"; }
        else if (t_recog == null) why = /did not stop/.test(out) ? "interpreter restarted" : "no KeyboardInterrupt within the guard";
        else if (!sameWorker) why = "worker replaced";
        else if (probe !== "ok") why = "probe " + probe;
        else outcome = t_recog - t_send > 10000 ? "SLOW" : "PASS";
        trials.push({ i, outcome, why, latency_ms: t_recog && Math.round(t_recog - t_send), poll_ms: 20, same_worker: sameWorker, memory_bytes: await memory() });
      }
      result.rows.push({ case: c.id, host: "browser", trials });
      console.log(JSON.stringify(result.rows.at(-1)));
    }
    result.worker_ids.push(await workers());
  } finally {
    try { ws?.close(); } catch {}
    try { process.kill(-chrome.pid, "SIGKILL"); } catch {}
    rmSync(profile, { recursive: true, force: true });
  }
  return result;
}
