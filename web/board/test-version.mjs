// Which Sagebrush runs a board's code (page.ts, mount.ts; round 0's 17): the
// ⋯ menu's foot says the site's version, build and engine from
// /version.json (as `sagebrush --version` says them), and
// window.sagebrush.board.engine() returns them; a field not of its form is
// left out (it is data: text, never markup); without the file, the engine
// the page was built with.  Serve web/dist first (python3 web/serve.py
// 8765) from the repository's root, then
//   node web/board/test-version.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const file = join("web", "dist", "version.json"), kept = existsSync(file) ? readFileSync(file) : null;
const profile = mkdtempSync(join(tmpdir(), "sb-version-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1200,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!port) port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
const until = async (expr, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(50); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
// (the page afresh, its ⋯ menu opened: what its foot says, and the agent's answer)
const look = async () => {
  await send("Page.navigate", { url: "about:blank" });
  await send("Page.navigate", { url: `${base}board/?runner=0` });
  if (!(await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000))) throw new Error("the board did not open");
  await ev("document.querySelector('[data-sbb=menubtn]').click(), 1");
  await until("!document.querySelector('[data-sbb=ver]').hidden", 3000);
  return ev("window.sagebrush.board.engine().then((v) => ({ v, says: document.querySelector('[data-sbb=ver]').textContent, hidden: document.querySelector('[data-sbb=ver]').hidden, html: document.querySelector('[data-sbb=ver]').innerHTML }))");
};

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  writeFileSync(file, JSON.stringify({ version: "0.4.1", build: "abcdef123456", engine: "667ac74324d2059a4c86" }));
  let r = await look();
  check(r.says === "Sagebrush 0.4.1 · build abcdef123456 · engine 667ac74324d2" && !r.hidden, "the ⋯ menu's foot: version, build and engine: " + r.says);
  check(r.v?.version === "0.4.1" && r.v?.build === "abcdef123456" && r.v?.engine === "667ac74324d2059a4c86", "engine(): the same, whole: " + JSON.stringify(r.v));
  // (fields not of their form: left out, the engine the page's own)
  writeFileSync(file, JSON.stringify({ version: "<img src=x onerror=alert(1)>", build: "not hex!", engine: 7 }));
  r = await look();
  const own = await ev("import(new URL('board.js', location.href).href).then(() => 1)").then(() => r.v?.engine);
  check(!r.v?.version && !r.v?.build && !/img|onerror/.test(r.html) && (!r.says || /^engine [0-9a-f]+$/.test(r.says)), "a version.json with markup and wrong forms: those fields left out, nothing as markup: " + JSON.stringify(r));
  // (no file: the engine the page was built with, if any)
  rmSync(file, { force: true });
  r = await look();
  check(r.v === null ? r.hidden : /^engine [0-9a-f]{12}$/.test(r.says) && r.v.engine && !r.v.version && !r.v.build, "no version.json: the page's own engine only (or nothing): " + JSON.stringify(r));
  check(own === undefined || own === r.v?.engine, "...the same engine as when its fields were left out");
  check(!errors.length, "no errors: " + errors.join(" | "));
} catch (e) {
  fails.push(String(e?.stack ?? e));
} finally {
  if (kept) writeFileSync(file, kept); else rmSync(file, { force: true });
  chrome.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
