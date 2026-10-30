// web/notebook/anchor.js in headless Chromium: restoreAnchor keeps a cell in
// its place while the page settles, and lets go when someone else scrolls.
// The module's own source runs in a page of twelve 121 px cells in an 800 px
// window (the cases of #357's review):
// - the page too short to put a late cell back yet, then it grows: the anchor
//   holds (its own clamped correction must not let go of it);
// - a script's scrollTo(0, 0) within the 2 s, then a resize: the anchor has
//   let go (a scrollbar drag is the same: none of wheel, touch, key, click);
// - a cell above grows (the browser's own scroll anchoring moves the page):
//   the anchor holds, the cell in its place;
// - the wheel, then a scrollTo and a resize: let go.
//   CHROME=google-chrome node web/notebook/test-anchor.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "../test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SEND_MS = 30_000, WATCHDOG_MS = 120_000;
let checks = 0, phase = "start";
const fails = [];
const ok = (cond, what) => { checks++; console.log((cond ? "ok   " : "FAIL ") + what); if (!cond) fails.push(what); };

// the module's source, as a function returning its exports
// ANCHOR=<file> tests another version of the module (a negative control).
const source = readFileSync(process.env.ANCHOR ?? join(here, "anchor.js"), "utf8").replace(/^export /gm, "");
const MODULE = `window.A = (() => {\n${source}\nreturn { anchorOf, restoreAnchor };\n})(); true`;
const PAGE = `(() => {
  document.documentElement.innerHTML = '<head><style>body{margin:0} .c{height:120px;border-bottom:1px solid #ccc}</style></head><body><div id="root"></div></body>';
  const root = document.getElementById("root");
  const cells = [];
  for (let i = 0; i < 12; i++) { const el = document.createElement("div"); el.className = "c"; el.textContent = "cell " + i; root.append(el); cells.push({ id: "c" + i, el }); }
  window.T = { root, cells, notebook: { cells: () => cells, root } };
  scrollTo(0, 0);
  return true;
})()`;

let cleanup = async () => {};
const watchdog = setTimeout(async () => { console.log(`FAIL the whole run took more than ${WATCHDOG_MS / 1000} s (phase: ${phase})`); await cleanup(); process.exit(1); }, WATCHDOG_MS);
const profile = mkdtempSync(join(tmpdir(), "sb-anchor-chrome-"));
let cdpPort = Number(process.env.CDP_PORT) || 0;
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--hide-scrollbars", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!cdpPort) cdpPort = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); if (targets.some((t) => t.type === "page")) break; } catch {} await sleep(100); }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; setTimeout(() => j(new Error("the DevTools socket didn't open within 30 s")), 30_000); });
let n = 0; const waiting = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise((r, j) => {
  const id = ++n;
  const t = setTimeout(() => { waiting.delete(id); j(new Error(`DevTools ${method} didn't answer within ${SEND_MS / 1000} s (phase: ${phase})`)); }, SEND_MS);
  waiting.set(id, (v) => { clearTimeout(t); r(v); });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`in the page (phase ${phase}): ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result?.value;
};
cleanup = async () => {
  try { ws.close(); } catch {}
  const gone = chrome.exitCode !== null ? Promise.resolve() : new Promise((r) => chrome.once("exit", r));
  chrome.kill();
  await Promise.race([gone, sleep(5000)]);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
};
process.on("uncaughtException", async (e) => { console.log("FAIL " + (e?.stack ?? e)); await cleanup(); process.exit(1); });

// one case: a fresh page and module, the anchor restored, then `steps` (ms -> js) run at their times
const scenario = async (name, at, steps, settle = 900) => {
  phase = name;
  ok(await ev(PAGE), `${name}: the page`);
  ok(await ev(MODULE), `${name}: the module`);
  return ev(`new Promise((done) => {
    const { root, cells, notebook } = T;
    A.restoreAnchor(notebook, ${JSON.stringify(at)});
    ${steps.map(([ms, js]) => `setTimeout(() => { ${js} }, ${ms});`).join("\n    ")}
    setTimeout(() => done({ scrollY: Math.round(scrollY), tops: cells.map((c) => Math.round(c.el.getBoundingClientRect().top)) }), ${settle});
  })`);
};

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 600, height: 800, deviceScaleFactor: 1, mobile: false });

  // the page too short to put cell 10 at 100 px yet; it grows at 300 ms
  let r = await scenario("a short page, then it grows", { id: "c10", index: 10, top: 100 },
    [[300, `const pad = document.createElement("div"); pad.style.height = "900px"; root.append(pad); cells[2].el.style.height = "300px";`]]);
  ok(Math.abs(r.tops[10] - 100) <= 1, `a short page, then it grows: the anchor held cell 10 at 100 px (it is at ${r.tops[10]})`);

  // the #352 case: a script's scrollTo(0, 0) at 200 ms, then a resize at 400 ms
  r = await scenario("a script scrolls, then a resize", { id: "c6", index: 6, top: 100 },
    [[200, `scrollTo(0, 0);`], [400, `cells[3].el.style.height = "160px";`]]);
  ok(r.scrollY === 0, `a script's scrollTo(0, 0) lets go: the page stays at the top after a resize (scrollY ${r.scrollY})`);

  // the browser's own scroll anchoring: a cell above the anchor grows
  r = await scenario("a cell above grows", { id: "c6", index: 6, top: 100 },
    [[300, `cells[2].el.style.height = "400px";`]]);
  ok(Math.abs(r.tops[6] - 100) <= 1, `a cell above grows: the anchor held cell 6 at 100 px (it is at ${r.tops[6]})`);

  // the wheel lets go
  r = await scenario("the wheel", { id: "c6", index: 6, top: 100 },
    [[200, `dispatchEvent(new WheelEvent("wheel")); scrollTo(0, 0);`], [400, `cells[3].el.style.height = "160px";`]]);
  ok(r.scrollY === 0, `the wheel lets go: the page stays at the top after a resize (scrollY ${r.scrollY})`);
} finally {
  clearTimeout(watchdog);
  await cleanup();
}
console.log(fails.length ? `${fails.length} of ${checks} failed` : `${checks}/${checks} passed`);
process.exit(fails.length ? 1 : 0);
