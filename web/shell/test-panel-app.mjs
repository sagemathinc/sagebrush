// The Terminal in the desktop and Android apps (William, Oct 30): the app's page, app/dist from
// app/build-frontend.mjs, served as the app serves it (app/serve-app.py: lib.rs's headers, the shell worker's CSP
// included), in headless Chromium with window.__TAURI__ before the page's scripts, as the app's web view has it.
// Twice: cross-origin isolated, as the desktop app, and not (--no-coi), as Android's web view, which has no
// SharedArrayBuffer.  Each time ⋯ ▸ Terminal shows, the dock opens, the bash set loads from the app's own files,
// and `echo ok` prints ok; the worker comes with its own policy (no network).
//   bun web/build.ts && node app/build-frontend.mjs && bun web/shell/test-panel-app.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, startServe } from "../test-port.mjs";

const root = join(import.meta.dir, "..", "..");
if (!existsSync(join(root, "app", "dist", "shell", "preview-set.json"))) throw new Error("build app/dist first (node app/build-frontend.mjs)");
const CSP = /const SHELL_WORKER_CSP: &str = "([^"]*)";/.exec(readFileSync(join(root, "app", "src-tauri", "src", "lib.rs"), "utf8"))?.[1];
let checks = 0;
const fails = [];
const check = (ok, what) => {
  checks++;
  if (!ok) fails.push(what);
  console.log(`${ok ? "ok" : "FAIL"} ${what}`);
};
const servers = [];
let chrome = null;
const profile = mkdtempSync(join(tmpdir(), "sb-test-panel-app-"));
try {
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
    if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text };
    return r.result?.result?.value;
  };
  const until = async (expr, ms = 30000) => {
    const t = Date.now();
    for (;;) {
      const v = await evaluate(expr);
      if (v && !v.error) return v;
      if (Date.now() - t > ms) return null;
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  // (the app's start: no files handed to it, no self-test; app/src-tauri/src/lib.rs's commands)
  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__TAURI__ = { core: { invoke: async (c) => (c === "startup_files" ? [] : null) }, event: { listen: async () => () => {} } };` });
  for (const coi of [true, false]) {
    const as = coi ? "the desktop app (isolated)" : "Android (not isolated)";
    const port = await startServe(() => {
      const s = spawn("python3", [join(root, "app", "serve-app.py"), ...(coi ? [] : ["--no-coi"]), "0"], { stdio: ["ignore", "pipe", "pipe"] });
      servers.push(s);
      return s;
    }).port;
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
    // (the app-only File items shown: the page's start ran through, in app mode)
    const started = await until(`(() => { const b = document.querySelector('[data-f="openfile"]'); return !!window.__TAURI__ && !!b && !b.hidden; })()`, 60000);
    const iso = await evaluate(`({ coi: globalThis.crossOriginIsolated === true, sab: typeof SharedArrayBuffer })`);
    check(!!started && iso?.coi === coi && (coi || iso.sab === "undefined"), `${as}: the app's page started (${JSON.stringify(iso)})`);
    check(!!(await until(`(() => { const b = document.querySelector("#termbtn"); return !!b && !b.hidden; })()`, 10000)), `${as}: ⋯ ▸ Terminal shows`);
    const wcsp = await evaluate(`fetch("shell/worker-boot.js", { cache: "no-store" }).then((r) => r.headers.get("content-security-policy"))`);
    check(!!CSP && wcsp === CSP && /connect-src 'none'/.test(wcsp), `${as}: the shell worker comes with its own policy, lib.rs's: ${JSON.stringify(wcsp)}`);
    await evaluate(`document.querySelector("#termbtn").click()`);
    const up = await until(`(() => { const t = document.querySelector(".sb-term"); return !!t && !t.hidden && t.dataset.startMs !== undefined && !document.querySelector(".sb-term-loading"); })()`, 60000);
    const saved = await evaluate(`document.querySelector("#saved")?.textContent ?? ""`);
    check(!!up, `${as}: the dock opens and the shell starts from the app's own files${up ? "" : ` (the page says: ${JSON.stringify(saved)})`}`);
    await evaluate(`(() => {
      const ta = document.querySelector(".sb-term textarea");
      document.querySelector(".sb-term-status").textContent = "";
      ta.value = "echo ok";
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    })()`);
    await until(`document.querySelectorAll(".sb-term-cmd").length >= 1 && !document.querySelector(".sb-term").classList.contains("running") && document.querySelector(".sb-term-status").textContent !== ""`, 60000);
    const r = await evaluate(`(() => { const c = [...document.querySelectorAll(".sb-term-cmd")].at(-1); return c && { out: c.querySelector(".sb-term-out")?.textContent, status: document.querySelector(".sb-term-status").textContent }; })()`);
    check(r?.out === "ok\n" && r.status === "done", `${as}: echo ok prints ok: ${JSON.stringify(r)}`);
  }
  ws.close();
} finally {
  // (its whole process group: the renderer and GPU processes too, not only the main one)
  try { if (chrome?.pid) process.kill(-chrome.pid, "SIGKILL"); } catch {}
  for (const s of servers) s.kill("SIGKILL");
  rmSync(profile, { recursive: true, force: true });
}
if (fails.length) {
  console.log(`test-panel-app: ${fails.length} of ${checks} FAILED`);
  process.exit(1);
}
console.log(`test-panel-app: all ${checks} checks pass`);
