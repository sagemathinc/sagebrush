// ci: none (not run by CI before test discovery, Nov 2 2026: a wiring candidate)
// The page's WebMCP run_python and the notebook's language (sim run 2, APP-sage-switch), in headless Chromium
// against the built site: in a notebook with no code, sage=true switches it to Sage; in a Python notebook WITH code,
// the code runs in a new Sage notebook (opened, its result said), the Python one saved as it was, never switched.
//   bun web/build.ts, then node web/test-webmcp-mode.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "./test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), "sb-webmcp-mode-"));
const serve = spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise((r) => serve.stdout.once("data", (d) => r(Number(String(d).trim().split(/\s+/).pop()))));
const profile = join(tmp, "profile");
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--password-store=basic", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const cdp = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result.value; };
const until = async (expr, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(200); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };
// (the tools, as a browser with WebMCP would be given them: registerTool, caught before the page's script runs)
const run = (args) => ev(`window.__tools.run_python.execute(${JSON.stringify(args)}).then((r) => r.content.filter((c) => c.type === "text").map((c) => c.text))`);
try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `navigator.modelContext = { registerTool(t) { (window.__tools ??= {})[t.name] = t; } };` });
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  check(await until("!!window.__tools?.run_python && !!window.sagebrush?.notebook && !!document.querySelector('#cells textarea')"), "the page registers run_python");
  // a notebook with no code: sage=true switches it
  await ev(`(document.querySelector('[data-f=new]')?.click() ?? (() => { const b = document.createElement("button"); b.dataset.f = "new"; document.querySelector("#filemenu").append(b); b.click(); b.remove(); })(), 1)`);
  await until(`document.querySelectorAll("#cells .cell").length === 1 && sagebrush.notebook.cells()[0].ta.value === ""`);
  check((await ev("sagebrush.notebook.mode")) === "python", "(a new, empty Python notebook)");
  const a = await run({ code: "2^10", sage: true });
  check((await ev("sagebrush.notebook.mode")) === "sage" && a.join(" ").includes("1024") && !a.join(" ").includes("isn't changed"), "a notebook with no code: sage=true switches it to Sage and runs there: " + JSON.stringify(a));
  // a Python notebook with code: the code runs in a new Sage notebook
  await ev(`(() => { const b = document.createElement("button"); b.dataset.f = "new"; document.querySelector("#filemenu").append(b); b.click(); b.remove(); return 1; })()`);
  await until(`sagebrush.notebook.cells().length === 1 && sagebrush.notebook.cells()[0].ta.value === ""`);
  const m = await ev(`(() => { const s = document.querySelector("#mode"); s.value = "python"; s.dispatchEvent(new Event("change")); document.querySelector("#nbname").value = "Mine"; document.querySelector("#nbname").dispatchEvent(new Event("change")); return sagebrush.notebook.mode; })()`);
  const p = await run({ code: "x = 2**10\nx" });
  check(m === "python" && p.join(" ").includes("1024"), "(a Python notebook with code: " + JSON.stringify(p) + ")");
  const b = await run({ code: "factor(2^10 - 1)", sage: true });
  const after = await ev(`({ mode: sagebrush.notebook.mode, name: document.querySelector("#nbname").value })`);
  check(b[0]?.includes('"Mine" is Python and has code, so its language isn\'t changed: this ran in a new Sage notebook') && b.join(" ").includes("3 * 11 * 31"), "in a Python notebook with code, sage=true runs in a new Sage notebook, and says so: " + JSON.stringify(b));
  check(after.mode === "sage" && after.name.startsWith("Untitled (Sage)"), "…which is open now: " + JSON.stringify(after));
  const mine = await ev(`(async () => { const w = window.sagebrush.workspace; const l = await w.list("/", { recursive: true });
    for (const e of l.filter((x) => x.kind === "notebook")) { const r = await w.read(e.path).catch(() => null); const code = (r?.content?.cells ?? []).map((c) => c.code ?? c.source ?? "").join("|"); if (code.includes("x = 2**10")) return { path: e.path, mode: r.content.mode, code }; }
    return null; })()`);
  check(mine && mine.mode === "python" && mine.code.includes("x = 2**10"), "…and the Python notebook is saved as it was, still Python: " + JSON.stringify(mine));
  check(errors.length === 0, "no exceptions in the page: " + errors.slice(0, 3).join(" | "));
} catch (e) {
  check(false, "threw: " + String(e?.stack ?? e).slice(0, 800));
} finally {
  chrome.kill(); serve.kill();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`${checks - fails.length}/${checks} checks passed`);
process.exit(fails.length ? 1 : 0);
