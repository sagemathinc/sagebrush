// ci: web-runner order=188 runner=bun chrome
// An agent's run_notebook of the notebook open on its page, in headless Chromium against web/dist: run there (the
// outputs shown and saved with the notebook, the same per-cell result back), and today's run for a notebook not shown
// or a narrower grant; ended by Stop, the grant narrowed or another notebook shown, with nothing of it returned.
//   bun web/build.ts && CHROME=google-chrome bun web/workspace/test-run-in-page-page.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, startServe } from "../test-port.mjs";

const here = join(import.meta.dir, "..");
if (!existsSync(join(here, "dist", "sagebrush-agent-run.js"))) throw new Error("build web/dist first (bun web/build.ts)");
let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); console.log(`${ok ? "ok" : "FAIL"} ${what}`); };
let server = null, chrome = null;
const profile = mkdtempSync(join(tmpdir(), "sb-test-inpage-"));
try {
  const port = await startServe(() => (server = spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] }))).port;
  const url = `http://127.0.0.1:${port}/`;
  chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", "--window-size=1100,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", detached: true });
  const dport = await devtoolsPort(profile);
  const target = (await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json()).find((t) => t.type === "page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) (waiting.get(m.id)(m), waiting.delete(m.id)); };
  const send = (method, params = {}) => new Promise((r, j) => {
    const id = ++seq;
    const t = setTimeout(() => (waiting.delete(id), j(new Error(`DevTools ${method} gave no answer in 120 s`))), 120000);
    waiting.set(id, (m) => (clearTimeout(t), r(m)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text };
    return r.result?.result?.value;
  };
  const until = async (expr, ms = 60000) => {
    const t = Date.now();
    for (;;) { const v = await evaluate(expr); if (v && !v.error) return v; if (Date.now() - t > ms) return null; await new Promise((r) => setTimeout(r, 100)); }
  };
  await send("Page.navigate", { url });
  check(!!(await until(`typeof window.__agentRunsFor === "function"`)), "the page offers the runs' test handle on a local host");
  check(await evaluate(`(async () => {
    const R = await window.__agentRunsFor(); window.__R = R; window.__M = await R.load(); window.__ws = R.host().ws;
    window.__grant = { id: "a".repeat(32), agent: "Test agent", client: "test", folders: ["/"], write: true, run: true, expires: null, created: 0, lastUsed: 0 };
    window.__lines = []; window.__holder = { current: null, show(a, v, stop) { window.__lines.push(a + " is running " + v); window.__stop = stop; }, hide() { window.__lines.push("hidden"); } };
    window.__ctx = (g = window.__grant) => ({ agent: "Test agent", actor: "agent:Test-agent", grant: g, live: () => window.__live !== false, why: () => "the grant was revoked", grantNow: () => window.__grantNow ?? g, onChange: (cb) => { window.__chg = cb; return () => { window.__chg = null; }; } });
    window.__run = (method, params, g) => window.__M.run(method, params, window.__ctx(g), window.__R.host(), window.__holder).then((r) => r, (e) => ({ threw: e.code, message: e.message }));
    window.__go = (params, g) => { window.__res = undefined; window.__run("workspace.run_notebook", params, g).then((r) => (window.__res = r)); return 1; };
    const mk = async (p, cells) => { await window.__ws.create(p, { content: { mode: "python", cells } }); return (await window.__ws.stat(p)).ref; };
    await window.__ws.mkdir("/ip").catch(() => {});
    window.__refs = {
      a: await mk("/ip/a.ipynb", [{ id: "a1", code: "print(6*7)" }, { id: "am", type: "markdown", code: "text" }, { id: "a2", code: "y = 21\\ny * 2" }]),
      b: await mk("/ip/b.ipynb", [{ id: "b1", code: "print('b')" }]),
      once: await mk("/ip/once.ipynb", [{ id: "o1", code: "n = 1" }, { id: "o2", code: "import builtins\\nbuiltins.k = getattr(builtins, 'k', 0) + 1\\nprint(n, builtins.k)" }]),
      slow: await mk("/ip/slow.ipynb", [{ id: "s1", code: "import time\\nprint('started', flush=True)\\ntime.sleep(20)" }, { id: "s2", code: "print('late')" }]),
    };
    return !!window.__M.run && window.__R.host().sandbox; })()`) === "ok", "the run module loads, the sandbox is here, three notebooks made");
  const open = (k) => evaluate(`window.sagebrush.open(window.__refs.${k}).then(() => window.sagebrush.notebook.cells().length)`);
  const shown = (i) => evaluate(`window.sagebrush.notebook.cells()[${i}].out.textContent`);
  const stored = (p) => evaluate(`window.__ws.read(${JSON.stringify(p)}).then((x) => x.content.cells.map((c) => (c.outputs ?? []).map((o) => o.text ?? o.data?.["text/plain"] ?? "").join("")))`);

  // ---- the notebook shown: run in it, outputs shown and saved, the result as today's
  check((await open("a")) === 3, "a.ipynb shown");
  let r = await evaluate(`window.__run("workspace.run_notebook", { path: "/ip/a.ipynb" })`);
  check(r?.ok === true && r.ended === "done" && r.saved === "saved" && JSON.stringify(r.cells?.map((c) => [c.index, c.status, c.out])) === JSON.stringify([[0, "ok", "42\n"], [2, "ok", "42\n"]]) && /^[0-9a-f]{64}$/.test(r.inputHash ?? ""),
    `shown: run here, saved, each cell's output back: ${JSON.stringify(r)}`);
  check((await shown(0)).includes("42") && (await shown(2)).includes("42"), "the outputs shown on the page");
  const sa = await stored("/ip/a.ipynb");
  check(sa?.[0]?.includes("42") && sa[2]?.includes("42"), `the outputs saved with the notebook: ${JSON.stringify(sa)}`);
  check(JSON.stringify(await evaluate(`window.__lines`)) === JSON.stringify(["Test agent is running /ip/a.ipynb", "hidden"]), "the run's line while it ran, gone at its end");
  // (the person's Run all after it: the same outputs)
  await evaluate(`window.sagebrush.notebook.runAllGesture().then(() => 1)`);
  check((await shown(0)).includes("42") && (await shown(2)).includes("42"), "the person's Run all after it: the same outputs");

  // (an agent's write, the run asked at once after it: the run is of the notebook as written, on the page)
  r = await evaluate(`(async () => {
    const x = await window.__ws.read("/ip/a.ipynb");
    const cells = x.content.cells.map((c) => (c.id === "a2" ? { ...c, code: "y = 22\\ny * 2" } : c));
    await window.__ws.write("/ip/a.ipynb", { ...x.content, cells }, x.rev);
    return window.__run("workspace.run_notebook", { path: "/ip/a.ipynb" }); })()`);
  check(r?.ok === true && r.saved === "saved" && r.cells?.[1]?.out === "44\n" && (await shown(2)).includes("44") && (await evaluate(`window.sagebrush.notebook.cells()[2].ta.value`)) === "y = 22\ny * 2",
    `an agent's write, then its run at once: the run is of what it wrote, shown here: ${JSON.stringify(r)}`);
  // (the person's edit not yet saved, the run asked at once: what is shown runs, and is kept)
  r = await evaluate(`(async () => {
    const ta = window.sagebrush.notebook.cells()[0].ta; ta.value = "print(6*8)"; ta.dispatchEvent(new Event("input", { bubbles: true }));
    return window.__run("workspace.run_notebook", { path: "/ip/a.ipynb" }); })()`);
  const kept = await evaluate(`window.__ws.read("/ip/a.ipynb").then((x) => x.content.cells[0].code)`);
  check(r?.ok === true && r.cells?.[0]?.out === "48\n" && kept === "print(6*8)", `the person's unsaved edit: run as shown, and saved: ${JSON.stringify({ r, kept })}`);

  // (the reactive notebook, as the page has it by default: each cell run once, in order, none again as a descendant)
  check((await open("once")) === 2, "once.ipynb shown");
  r = await evaluate(`window.__run("workspace.run_notebook", { path: "/ip/once.ipynb" })`);
  check(r?.ok === true && r.cells?.[1]?.out === "1 1\n" && (await shown(1)) === "1 1\n", `reactive: each cell run once: ${JSON.stringify(r?.cells)}`);

  // ---- not shown, or a narrower grant: today's run (nothing saved on main)
  r = await evaluate(`window.__run("workspace.run_notebook", { path: "/ip/b.ipynb" })`);
  check(r?.ok === true && r.saved === "not saved: main" && r.cells?.[0]?.out === "b\n", `not shown: today's run: ${JSON.stringify(r)}`);
  r = await evaluate(`window.__run("workspace.run_notebook", { path: "/ip/a.ipynb" }, { ...window.__grant, folders: ["/ip"] })`);
  check(r?.ok === true && r.saved === "not saved: main", `shown, a grant of /ip only: today's run: ${JSON.stringify(r)}`);

  // ---- ended while a cell runs: nothing of it returned, the cell after it never run
  const during = async (what, act, want) => {
    check((await open("slow")) === 2, `(slow.ipynb shown: ${what})`);
    // (the last row's outputs cleared and saved, so "started" is this run's)
    await evaluate(`(window.__grantNow = undefined, window.sagebrush.notebook.clearOutputs(), window.sagebrush.notebook.saved().then(() => 1))`);
    await evaluate(`window.__go({ path: "/ip/slow.ipynb" })`);
    check(!!(await until(`window.sagebrush.notebook.cells()[0]?.out.textContent.includes("started")`)), `${what}: the first cell running on the page`);
    const t0 = Date.now();
    await evaluate(act);
    const res = await until(`window.__res`, 30000);
    const late = await evaluate(`window.__ws.read("/ip/slow.ipynb").then((x) => JSON.stringify(x.content.cells[1].outputs ?? []).includes("late"))`);
    check(res?.ok === false && res.ended === want && Date.now() - t0 < 10000 && !("cells" in res) && !JSON.stringify(res).includes("started") && late === false, `${what}: ended ${want}, nothing returned, the next cell never run: ${JSON.stringify({ res, late })}`);
  };
  await during("Stop", `(window.__stop(), 1)`, "stopped");
  await during("the grant's write narrowed", `(window.__grantNow = { ...window.__grant, write: false }, window.__chg(), 1)`, "revoked");
  await during("another notebook shown", `window.sagebrush.open(window.__refs.b).then(() => 1)`, "stopped");
  await evaluate(`(window.__grantNow = undefined, 1)`);
  check((await evaluate(`window.__holder.current === null`)) === true, "the page's run let go after each");
} catch (e) {
  fails.push(String(e?.stack ?? e));
} finally {
  try { process.kill(-chrome.pid); } catch {}
  try { server?.kill(); } catch {}
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch {}
}
if (fails.length) { console.error(`FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  ")); process.exit(1); }
console.log(`ok: an agent's run of the notebook shown, ${checks} checks`);
