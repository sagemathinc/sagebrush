// ci: web-browser/notebook order=62
// A module uploaded beside a notebook imports, in headless Chromium against web/dist: a notebook not saved to a folder
// yet works at the workspace's top, which is its interpreter's working folder and sys.path[0], as a saved notebook's
// folder is; so a module uploaded there while its interpreter runs imports without a restart.
//   bun web/build.ts && node web/test-upload-import.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, startServe } from "./test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("FAIL the test did not end within 300 s"); process.exit(1); }, 300_000).unref();
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) process.exitCode = 1; };

let server = null;
const serve = startServe(() => (server = spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] })));
const base = process.env.SB_URL ?? `http://127.0.0.1:${await serve.port}/`;
const profile = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "sb-upload-import-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
try {
  const port = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0; const waiting = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
  const until = async (expr, ms = 60000) => { for (let i = 0; i < ms / 200; i++) { if (await ev(expr)) return true; await sleep(200); } return false; };
  await send("Page.navigate", { url: base + "?reactive=0" });
  ok(await until("window.sagebrush && document.querySelectorAll('#cells .cell').length > 0 && sagebrush.kernel?.ready", 120000), "the page and its interpreter are up");
  const run = async (code) => {
    await ev(`(() => { sagebrush.notebook.replace({ mode: "python", cells: [{ code: ${JSON.stringify(code)} }] }); return true; })()`);
    await until("sagebrush.kernel?.ready", 60000);
    return ev(`(async () => { const nb = sagebrush.notebook; const c = nb.cells()[0]; await nb.run(c);
      for (let q = 0; q < 300 && (c.el.classList.contains('running') || c.el.classList.contains('queued')); q++) await new Promise(r => setTimeout(r, 100));
      return c.out.textContent; })()`);
  };
  let out = await run("import sys, os\nprint(sys.path[0], os.getcwd())");
  ok(out.trim() === "/ /", `a notebook not saved yet: its working folder, the workspace's top, is sys.path[0] (${JSON.stringify(out)})`);
  // (uploaded through the Files panel while the interpreter runs)
  await ev(`(() => { document.querySelector('#filesbtn')?.click(); const dt = new DataTransfer(); dt.items.add(new File(['VALUE = 6 * 7\\n'], 'beside.py'));
    const i = document.querySelector('#uploadinput'); i.files = dt.files; i.dispatchEvent(new Event('change')); return true; })()`);
  ok(await until("document.querySelector('#filelist')?.textContent.includes('beside.py')", 20000), "the module is uploaded");
  out = await run("import beside\nprint(beside.VALUE)");
  ok(out.trim() === "42", `...and imports in the running interpreter, with no restart (${JSON.stringify(out.slice(-200))})`);
} finally {
  chrome.kill("SIGKILL");
  server?.kill("SIGKILL");
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
