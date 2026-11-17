// ci: web-runner order=506 chrome
// The notebook page (index.html, notebook.js) reloaded the moment after typing, before its save's half second: what
// was typed is still there after the reload, saved (there after a second reload too), and the page's rescue of it is
// gone; nothing kept when nothing was waiting.  In headless Chromium against the built site:
// Serve web/dist first (python3 web/serve.py 8765), then
//   node web/notebook/test-keep-on-reload.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const profile = mkdtempSync(join(tmpdir(), "sb-keep-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? J(m.params.exceptionDetails));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(J({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(J(r.exceptionDetails).slice(0, 1500)); return r.result?.value; };
const until = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what, detail) => { checks++; if (!ok) fails.push(what + (detail === undefined ? "" : " " + J(detail).slice(0, 400))); };
const W = "window.sagebrush?.workspace";
// (the page left and loaded again: marked first, so what's waited for is the new document's)
const reload = async () => { await ev("(window.__old = 1, 1)").catch(() => {}); await send("Page.reload"); await sleep(200); await until("!window.__old && document.readyState !== 'loading'", 30000); };
const opened = (ref) => until(`!!window.sagebrush?.notebook && window.sagebrush.notebook.store?.id === ${J(ref)} && !!document.querySelector("#cells textarea") && !document.querySelector("#cells textarea[readonly]")`, 30000);
const codes = () => ev(`[...document.querySelectorAll("#cells textarea")].map((t) => t.value)`);
// (typed as a person types: the cell's text, then its input event; no wait for the save)
const type = (i, text) => ev(`(() => { const ta = document.querySelectorAll("#cells textarea")[${i}]; ta.focus(); ta.value = ${J(text)}; ta.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "x" })); return 1; })()`);
const rescued = (ref) => ev(`localStorage.getItem("sagebrush-nb-rescue:" + ${J(ref)})`);

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: base });
  await until(`!!${W} && !!window.sagebrush?.notebook`, 60000);
  const ref = await ev(`${W}.create("/keep.ipynb", { content: { cells: [{ id: "a", code: "a0" }, { id: "b", code: "b0" }] } }).then((e) => e.ref)`);
  await send("Page.navigate", { url: base + "?nb=" + encodeURIComponent(ref) });
  check(await opened(ref), "the notebook opens, writable");

  // 1. typed, reloaded at once: kept, and saved
  await type(0, "a1 typed then reloaded");
  await reload();
  check(await opened(ref), "1: the notebook opens again after the reload");
  check(await until(`document.querySelectorAll("#cells textarea")[0]?.value === "a1 typed then reloaded"`, 10000), "1: what was typed just before the reload is there after it", await codes());
  check((await codes())[1] === "b0", "1: the other cell as it was", await codes());
  check(await until(`localStorage.getItem("sagebrush-nb-rescue:" + ${J(ref)}) === null`, 5000), "1: the rescue is gone once put back");
  await sleep(1500);
  await reload();
  check(await opened(ref), "1: opens after a second reload");
  check((await codes())[0] === "a1 typed then reloaded", "1: …and it was saved: there after a second reload, with no rescue", { codes: await codes(), rescue: await rescued(ref) });

  // 2. another cell typed, reloaded at once: kept too, and the first cell as it was saved
  await type(1, "b1 typed then reloaded");
  await reload();
  check(await opened(ref), "2: opens again");
  check(await until(`document.querySelectorAll("#cells textarea")[1]?.value === "b1 typed then reloaded"`, 10000), "2: the second cell's typing kept too", await codes());
  check((await codes())[0] === "a1 typed then reloaded", "2: the first cell as saved", await codes());

  // 3. nothing typed since the last save: a reload keeps nothing in localStorage
  await sleep(1500);
  await reload();
  check(await opened(ref), "3: opens");
  check((await rescued(ref)) === null, "3: no rescue when nothing was waiting to be saved");
  check(errors.length === 0, "no page errors: " + errors.join(" | ").slice(0, 400));
} catch (e) {
  fails.push("threw: " + (e?.stack ?? e));
} finally {
  chrome.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
if (fails.length) {
  console.error(`FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`ok: a notebook reloaded the moment after typing keeps what was typed, ${checks} checks`);
process.exit(0);
