// The terminal panel's main-thread gates (plan-bash-shell r8c E5.5), in headless Chromium against web/dist built with
// SAGEBRUSH_TERMINAL=1: from "the command finished" (its outcome in) to the first and the last slice's paint (the
// animation frame after it), over 20 runs of each control, with no Long Task over 50 ms and every slice <= 50 ms.
//   C1: 1 MiB of alternating recognised SGR styles (reaches the 20 000-run cap)
//   C2: 1 MiB of dense visible controls and unknown escapes
//   C3: 1 MiB of plain text in 5 000+ lines
//   C4: a small command (the common case)
// The controls are written into the workspace once, through the shell (untimed); each timed run is `cat` of one, with
// `clear` between runs.  The parser (sb-term:parse), the patcher (sb-term:patch) and the paint path (first-paint,
// last-paint) are reported separately: web/shell/panel.ts's performance measures.
//   SAGEBRUSH_TERMINAL=1 bun web/build.ts && bun web/shell/test-panel-gates.mjs [--runs N]
//   GATES=enforce: exit 1 on a gate miss (the granted timing box, recorded hardware); otherwise a report (CI).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { cpus, totalmem, tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, startServe } from "../test-port.mjs";

const here = join(import.meta.dir, "..");
if (!existsSync(join(here, "dist", "shell", "preview-set.json"))) throw new Error("build web/dist with SAGEBRUSH_TERMINAL=1 first");
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
  if (!(await until(`(() => { const b = document.querySelector("#termbtn"); return !!b && !b.hidden; })()`))) throw new Error("no ⋯ ▸ Terminal");
  await evaluate(`document.querySelector("#termbtn").click()`);
  if (!(await until(`!!document.querySelector(".sb-term") && document.querySelector(".sb-term").dataset.startMs !== undefined`))) throw new Error("the shell didn't start");
  // one command: Enter, then wait until it is done and its last paint is measured
  const run = (cmd) => evaluate(`(async () => {
    const ta = document.querySelector(".sb-term textarea");
    document.querySelector(".sb-term-status").textContent = "";
    const n0 = performance.getEntriesByName("sb-term:last-paint").length;
    ta.value = ${JSON.stringify(cmd)};
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    for (let i = 0; i < 1200 && !(document.querySelector(".sb-term-status").textContent && performance.getEntriesByName("sb-term:last-paint").length > n0); i++) await new Promise((r) => setTimeout(r, 50));
    return performance.getEntriesByName("sb-term:last-paint").length > n0 ? document.querySelector(".sb-term-status").textContent : "timeout (no last paint in 60 s)";
  })()`);
  // (clear, and wait until it has: no command shown and none running, so a timed run never collides with it)
  const clear = async () => {
    await evaluate(`(() => { const ta = document.querySelector(".sb-term textarea"); ta.value = "clear";
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); })()`);
    if (!(await until(`document.querySelectorAll(".sb-term-cmd").length === 0 && !document.querySelector(".sb-term").classList.contains("running")`, 10000))) throw new Error("clear didn't clear");
  };
  // the controls, written once (untimed)
  const MiB = 1048576;
  const controls = {
    C1: `mkdir -p /gate && printf '\\033[31ma\\033[32mb%.0s' $(seq 1 ${Math.floor(MiB / 12)}) > /gate/c1.txt`,
    C2: `printf '\\033[2J\\001\\033]0;t\\007%.0s' $(seq 1 ${Math.floor(MiB / 11)}) > /gate/c2.txt`,
    C3: `printf '%0199d\\n' $(seq 1 ${Math.ceil(MiB / 200)}) > /gate/c3.txt`,
  };
  for (const [c, cmd] of Object.entries(controls).filter(([c]) => !ONLY || c === ONLY)) {
    const st = await run(cmd);
    const size = await run(`wc -c < /gate/${c.toLowerCase()}.txt`).then(() => evaluate(`[...document.querySelectorAll(".sb-term-cmd")].at(-1).querySelector(".sb-term-out").textContent.trim()`));
    console.log(`control ${c}: written (${st}), ${size} bytes`);
    if (!(Number(size) >= MiB * 0.95)) fails.push(`control ${c} is ${size} bytes, not about 1 MiB`);
  }
  await evaluate(`window.__long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push([e.startTime, e.duration]); }).observe({ type: "longtask", buffered: false })`);
  const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
  for (const [c, cmd] of [["C1", "cat /gate/c1.txt"], ["C2", "cat /gate/c2.txt"], ["C3", "cat /gate/c3.txt"], ["C4", "echo hi"]].filter(([c]) => !ONLY || c === ONLY)) {
    const first = [], last = [], parse = [], patch = [], longs = [];
    for (let i = 0; i < RUNS; i++) {
      if (Date.now() > DEADLINE) {
        fails.push(`${c}: the run's deadline passed after ${i} runs`);
        break;
      }
      await clear();
      await evaluate(`performance.clearMeasures(); window.__long = []; window.__t0 = performance.now()`);
      const st = await run(cmd);
      if (st !== "done") {
        fails.push(`${c} run ${i}: status ${st}`);
        continue;
      }
      const m = await evaluate(`(() => { const g = (n) => performance.getEntriesByName(n).map((e) => e.duration);
        return { first: g("sb-term:first-paint"), last: g("sb-term:last-paint"), parse: g("sb-term:parse"), patch: g("sb-term:patch"),
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
  console.log(`\nE5.5 gates, ${RUNS} runs per control; ${browser}; ${cpus().length} x ${cpus()[0]?.model}, ${(totalmem() / 2 ** 30).toFixed(0)} GiB`);
  console.log("control | first paint p50/p95/max ms | last paint p50/p95/max ms | slices/run | parse max | patch max | slice max | long tasks (max ms)");
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
