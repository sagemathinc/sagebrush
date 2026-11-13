// ci: none (not run by CI before test discovery, Nov 2 2026: a wiring candidate)
// The terminal panel's main-thread gates (plan-bash-shell r8c E5.5, kept unchanged for the Terminal on xterm: plan-term-
// xterm r2.7, daybreak4 P1), in headless Chromium against web/dist: from "the command finished" (its outcome in) to the
// first and the last paint (the animation frame after the first 8 KiB drawn, and after all of it), over 20 runs of each
// control, with no Long Task over 50 ms and every write (one 64 KiB piece, to xterm's callback) <= 50 ms.
//   C1: 1 MiB of alternating recognised SGR styles
//   C2: 1 MiB of dense controls and escapes, as ONE line (no line end)
//   C3: 1 MiB of plain text in 5 000+ lines (past the 6 000-row scrollback with the rows before it)
//   C4: a small command (the common case)
//   C5: C2 again with the window resized during the run (xterm reflows its rows); C6: C3 run twice back to back (repeated output)
// The controls are written into the workspace once, through the shell (untimed); each timed run is `cat` of one, with
// `clear` between runs.  The writes (sb-term:write) and the paint path (first-paint, last-paint) are reported
// separately: web/shell/panel.ts's and term-writer.ts's performance measures.  screenReaderMode on is the shipping
// configuration and the binding arm; SRM=0 runs the paired diagnostic arm with it off.
//   bun web/build.ts && bun web/shell/test-panel-gates.mjs [--runs N] [--only C2]
//   GATES=enforce: exit 1 on a gate miss (the granted timing box, recorded hardware); otherwise a report only.
// CI does not run this script (N-326-1): shared runners' timings decide nothing, and E5.5's gates are judged on the
// timing box.  CI runs the panel's behaviour (test-panel-page.mjs, test-panel-pages-copy.mjs and the unit tests).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { cpus, totalmem, tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, startServe } from "../test-port.mjs";

const here = join(import.meta.dir, "..");
if (!existsSync(join(here, "dist", "shell", "preview-set.json"))) throw new Error("build web/dist first (bun web/build.ts)");
const RUNS = Number(process.argv[process.argv.indexOf("--runs") + 1]) || 20;
// (--only C2: one control, for a diagnostic run)
const ONLY = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const ENFORCE = process.env.GATES === "enforce";
// (a hard bound on the whole run, so a stuck page can't hold a test slot: what was measured is still reported)
const DEADLINE = Date.now() + (Number(process.env.GATES_MS) || 20 * 60 * 1000);
// E5.5's gates (ms): p50, p95, max
const GATES = { first: [16, 33, 50], last: [400, 800, 1500], slice: 50, longtask: 50 };

let server = null, chrome = null;
const profile = mkdtempSync(join(tmpdir(), "sb-test-gates-"));
const fails = [];
const rows = [];
let browser = "";
// (the whole run, startup, every CDP call and every wait included, races the deadline: past it, the finally below
// kills the browser and the server and the report says what was measured; DB2-TERM-326-R2-1)
let deadlineTimer;
const deadline = new Promise((_, reject) => (deadlineTimer = setTimeout(() => reject(new Error("STUCK: the run's deadline passed (GATES_MS)")), Math.max(0, DEADLINE - Date.now()))));
const t0Run = Date.now();
try {
  await Promise.race([deadline, (async () => {
  const port = await startServe(() => (server = spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] }))).port;
  chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", "--window-size=1100,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", detached: true });
  const dport = await devtoolsPort(profile);
  const target = (await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json()).find((t) => t.type === "page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) (waiting.get(m.id)(m), waiting.delete(m.id));
  };
  const send = (method, params = {}) => new Promise((r) => {
    const id = ++seq;
    waiting.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  const until = async (expr, ms = 60000) => {
    const t = Date.now();
    for (;;) {
      if (await evaluate(expr)) return true;
      if (Date.now() - t > ms) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  browser = (await send("Browser.getVersion")).result?.product;
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  // (the handler too: the button is in the HTML before the page's script binds it, and a click then is lost)
  if (!(await until(`(() => { const b = document.querySelector("#termbtn"); return !!b && !b.hidden && typeof b.onclick === "function"; })()`))) throw new Error("no ⋯ ▸ Terminal");
  await evaluate(`document.querySelector("#termbtn").click()`);
  if (!(await until(`!!document.querySelector(".sb-term") && document.querySelector(".sb-term").dataset.startMs !== undefined`))) throw new Error("the shell didn't start");
  if (process.env.SRM === "0") await evaluate(`window.__sbTerm.term.options.screenReaderMode = false`);
  // one command: the line, Enter (the panel's own key path), then wait until it is done and its last paint is measured
  const run = (cmd) => evaluate(`(async () => {
    const t = window.__sbTerm;
    document.querySelector(".sb-term-status").textContent = "";
    const n0 = performance.getEntriesByName("sb-term:last-paint").length;
    t.editor.reset(${JSON.stringify(cmd)});
    t.onKey({ key: "Enter" }, null);
    for (let i = 0; i < 1200 && !(document.querySelector(".sb-term-status").textContent && performance.getEntriesByName("sb-term:last-paint").length > n0); i++) await new Promise((r) => setTimeout(r, 50));
    // (then the writer's own barrier: the prompt and any redraw queued after the output drawn too, so a run's
    // measures and Long Tasks are collected only once all its work is on the screen; daybreak4)
    await Promise.race([t.writer.idle(), new Promise((r) => setTimeout(r, 60000))]);
    if (t.writer.writing) return "timeout (the writer didn't drain in 60 s)";
    return performance.getEntriesByName("sb-term:last-paint").length > n0 ? document.querySelector(".sb-term-status").textContent : "timeout (no last paint in 60 s)";
  })()`);
  // (clear, and wait until it has: no command shown and none running, so a timed run never collides with it)
  const clear = async () => {
    await evaluate(`(() => { const t = window.__sbTerm; t.editor.reset("clear"); t.onKey({ key: "Enter" }, null); })()`);
    if (!(await until(`!window.__sbTerm.writer.writing && !document.querySelector(".sb-term").classList.contains("running")`, 10000))) throw new Error("clear didn't clear");
  };
  // the controls, written once (untimed)
  const MiB = 1048576;
  const controls = {
    C1: `printf '\\033[31ma\\033[32mb%.0s' $(seq 1 ${Math.floor(MiB / 12)}) > /gate/c1.txt`,
    C2: `printf '\\033[2J\\001\\033]0;t\\007%.0s' $(seq 1 ${Math.floor(MiB / 11)}) > /gate/c2.txt`,
    C3: `printf '%0199d\\n' $(seq 1 ${Math.ceil(MiB / 200)}) > /gate/c3.txt`,
  };
  // (the directory for every control, so --only C2 or C3 works alone)
  await run("mkdir -p /gate");
  for (const [c, cmd] of Object.entries(controls).filter(([c]) => !ONLY || c === ONLY)) {
    const st = await run(cmd);
    const size = await run(`wc -c < /gate/${c.toLowerCase()}.txt`).then(() => evaluate(`window.__sbTerm.screenText.split("\\n").at(-2).trim()`));
    console.log(`control ${c}: written (${st}), ${size} bytes`);
    if (!(Number(size) >= MiB * 0.95)) fails.push(`control ${c} is ${size} bytes, not about 1 MiB`);
  }
  await evaluate(`window.__long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push([e.startTime, e.duration]); }).observe({ type: "longtask", buffered: false })`);
  const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
  const resize = async (w) => send("Emulation.setDeviceMetricsOverride", { width: w, height: 800, deviceScaleFactor: 1, mobile: false });
  for (const [c, cmd] of [["C1", "cat /gate/c1.txt"], ["C2", "cat /gate/c2.txt"], ["C3", "cat /gate/c3.txt"], ["C4", "echo hi"], ["C5", "cat /gate/c2.txt"], ["C6", "cat /gate/c3.txt; cat /gate/c3.txt"]].filter(([c]) => !ONLY || c === ONLY)) {
    const first = [], last = [], parse = [], patch = [], longs = [];
    for (let i = 0; i < RUNS; i++) {
      if (Date.now() > DEADLINE) {
        fails.push(`${c}: the run's deadline passed after ${i} runs`);
        break;
      }
      await clear();
      await evaluate(`performance.clearMeasures(); window.__long = []; window.__t0 = performance.now()`);
      const p = run(cmd);
      // (C5: the window narrowed during the run, then back: xterm reflows its rows meanwhile)
      if (c === "C5") await new Promise((r) => setTimeout(r, 30)).then(() => resize(700)).then(() => new Promise((r) => setTimeout(r, 100))).then(() => resize(1100));
      const st = await p;
      if (st !== "done") {
        fails.push(`${c} run ${i}: status ${st}`);
        continue;
      }
      const m = await evaluate(`(() => { const g = (n) => performance.getEntriesByName(n).map((e) => e.duration);
        return { first: g("sb-term:first-paint"), last: g("sb-term:last-paint"), parse: g("sb-term:write"), patch: [],
                 longs: window.__long.filter(([t]) => t >= window.__t0).map(([, d]) => d) }; })()`);
      first.push(m.first.at(-1));
      last.push(m.last.at(-1));
      parse.push(...m.parse);
      patch.push(...m.patch);
      longs.push(...m.longs);
    }
    console.log(`  ${c}: ${first.length} runs measured`);
    if (!first.length) continue;
    const row = {
      control: c,
      first: [pct(first, 50), pct(first, 95), Math.max(...first)],
      last: [pct(last, 50), pct(last, 95), Math.max(...last)],
      parseMax: Math.max(...parse), patchMax: Math.max(...patch), sliceMax: Math.max(...parse.map((p, i) => p + (patch[i] ?? 0))),
      slicesPerRun: parse.length / RUNS, longtasks: longs.length, longMax: longs.length ? Math.max(...longs) : 0,
    };
    rows.push(row);
    const f1 = row.first.map((v, k) => v <= GATES.first[k]);
    const f2 = c === "C4" || row.last.map((v, k) => v <= GATES.last[k]).every(Boolean);
    if (!f1.every(Boolean)) fails.push(`${c}: to the first slice's paint p50/p95/max ${row.first.map((v) => v.toFixed(1)).join("/")} ms, gate ${GATES.first.join("/")}`);
    if (!f2) fails.push(`${c}: to the last slice's paint p50/p95/max ${row.last.map((v) => v.toFixed(1)).join("/")} ms, gate ${GATES.last.join("/")}`);
    if (row.sliceMax > GATES.slice) fails.push(`${c}: a slice took ${row.sliceMax.toFixed(1)} ms (> ${GATES.slice})`);
    if (row.longMax > GATES.longtask) fails.push(`${c}: a Long Task of ${row.longMax.toFixed(1)} ms during the run`);
  }
  ws.close();
  })()]);
} catch (e) {
  fails.push(String(e?.message ?? e));
} finally {
  clearTimeout(deadlineTimer);
  // (its whole process group: the renderer and GPU processes too, not only the main one)
  try { if (chrome?.pid) process.kill(-chrome.pid, "SIGKILL"); } catch {}
  server?.kill("SIGKILL");
  rmSync(profile, { recursive: true, force: true });
}
{
  console.log(`\nE5.5 gates, ${RUNS} runs per control; screenReaderMode ${process.env.SRM === "0" ? "off (the diagnostic arm)" : "on (the binding arm)"}; ${browser}; ${cpus().length} x ${cpus()[0]?.model}, ${(totalmem() / 2 ** 30).toFixed(0)} GiB`);
  console.log("control | first paint p50/p95/max ms | last paint p50/p95/max ms | writes/run | write max | - | slice max | long tasks (max ms)");
  for (const r of rows) {
    const f = (a) => a.map((v) => v.toFixed(1)).join(" / ");
    console.log(`${r.control} | ${f(r.first)} | ${f(r.last)} | ${r.slicesPerRun.toFixed(1)} | ${r.parseMax.toFixed(1)} | ${r.patchMax.toFixed(1)} | ${r.sliceMax.toFixed(1)} | ${r.longtasks} (${r.longMax.toFixed(1)})`);
  }
  console.log(`(${((Date.now() - t0Run) / 1000).toFixed(1)} s)`);
}
if (fails.length) {
  console.log(`\ntest-panel-gates: ${fails.length} gate miss${fails.length === 1 ? "" : "es"}${ENFORCE ? "" : " (report only: GATES=enforce fails on them)"}:\n  ` + fails.join("\n  "));
  if (ENFORCE) process.exit(1);
} else console.log("\ntest-panel-gates: every gate met");
// (a stuck run is a failed measurement, not a gate result: exit 2 either way; nothing left to keep the process up)
process.exit(fails.some((f) => f.startsWith("STUCK")) ? 2 : 0);
