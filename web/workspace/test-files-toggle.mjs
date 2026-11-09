// ci: web-runner order=482 chrome
// The Files button in the top-left corner (web/workspace/files-toggle.ts; William, Nov 8: "PUT A BUTTON IN THE UPPER
// LEFT TO SHOW THE SIDEBAR"), in headless Chromium against the built site, at a desktop width and a phone width, on
// the notebook page, a code file (/?code=), a board (/board/) and, in a build with the LaTeX editor, a .tex file:
//  - the button is there without opening any menu, in the window's top-left corner, on top (nothing covers it), and
//    nothing of the page is under it, whether the files are hidden or shown;
//  - one click shows the files and another hides them; Ctrl+B does the same; aria-pressed says which;
//  - the choice is remembered across a reload.
// Serve web/dist first (python3 web/serve.py 8765), then
//   node web/workspace/test-files-toggle.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-ftoggle-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", detached: true });
const port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result?.value; };
const until = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
const go = async (url) => { await send("Page.navigate", { url }); await sleep(300); };
const fails = [];
let checks = 0;
const check = (ok, what, detail) => { checks++; console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 400)}`); if (!ok) fails.push(what); };
const B = `document.querySelector(".sb-files-toggle")`, S = `document.getElementById("wssidebar")`;
const shown = () => ev(`!!${S} && !${S}.hidden`);
// (the button's box, whether it is the element at its own center, and what else of the page lies under it)
const geometry = () => ev(`(() => {
  const b = ${B}; if (!b || b.hidden) return null;
  const r = b.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  // (what the shown files cover, as on a phone where they fill the window, isn't under the button: it isn't seen)
  const side = document.getElementById("wssidebar"), sr = side && !side.hidden ? side.getBoundingClientRect() : null;
  const covered = (e, q) => !!sr && !side.contains(e) && q.left >= sr.left && q.right <= sr.right + 1;
  const under = [...document.querySelectorAll("button, a, input, select, textarea, h1, h2, b, [data-sbb=title], header .title, p")]
    .filter((e) => !b.contains(e) && e.offsetParent && getComputedStyle(e).visibility !== "hidden" && parseFloat(getComputedStyle(e).fontSize) > 0)
    .filter((e) => { const q = e.getBoundingClientRect(); return q.width > 0 && !covered(e, q) && q.left < r.right && q.right > r.left && q.top < r.bottom && q.bottom > r.top; })
    .map((e) => (e.id || e.className || e.tagName) + ":" + (e.textContent || e.value || "").trim().slice(0, 16));
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), onTop: hit === b || b.contains(hit), pressed: b.getAttribute("aria-pressed"), under };
})()`);
const ctrlB = async () => {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "b", code: "KeyB", windowsVirtualKeyCode: 66, modifiers: 2 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "b", code: "KeyB", windowsVirtualKeyCode: 66, modifiers: 2 });
  await sleep(400);
};

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await go(base);
  await until(`!!window.sagebrush?.workspace`, 60000);
  const fids = await ev(`(async () => { const w = window.sagebrush.workspace;
    const py = await w.create("/t/files-toggle.py", { content: "print(1)\\n" });
    const tex = await w.create("/t/files-toggle.tex", { content: "\\\\documentclass{article}\\n\\\\begin{document}\\nHi\\n\\\\end{document}\\n" });
    return { py: py.fid, tex: tex.fid }; })()`);
  const views = [["notebook", base, `!!window.sagebrush?.notebook`], ["code file", base + "?code=" + fids.py, `!!window.sagebrush?.code`], ["board", base + "board/", `!!window.sagebrush?.board`], ["LaTeX file", base + "?tex=" + fids.tex + "&latex=1", `!!document.querySelector(".tex-page .tex-src") || !!document.querySelector("body > p")`]];
  for (const [width, height, mobile] of [[1280, 800, false], [390, 844, true]]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
    for (const [name, url, ready] of views) {
      const at = `${name}, ${width} px`;
      await ev(`(localStorage.setItem("sagebrush-files-sidebar", "0"), 1)`);
      await go(url);
      await until(ready, 60000);
      check(await until(`!!${B} && !${B}.hidden`, 30000), `${at}: the Files button is there, no menu opened`);
      await sleep(300);
      const g1 = await geometry();
      check(!!g1 && g1.x <= 12 && g1.y <= 12 && g1.w >= 28 && g1.h >= 28 && g1.onTop && g1.pressed === "false" && !(await shown()), `${at}: in the top-left corner, on top, files hidden (aria-pressed false)`, g1);
      check(!!g1 && g1.under.length === 0, `${at}: nothing of the page under the button`, g1?.under);
      await ev(`(${B}.click(), 1)`);
      await sleep(500);
      const g2 = await geometry();
      check((await shown()) && g2?.pressed === "true" && g2.onTop, `${at}: a click shows the files (aria-pressed true), the button still on top`, g2);
      check(!!g2 && g2.under.length === 0, `${at}: nothing of the files' header under the button`, g2?.under);
      await go(url);
      await until(ready, 60000);
      check(await until(`!!${B} && !${B}.hidden && ${B}.getAttribute("aria-pressed") === "true" && !${S}.hidden`, 30000), `${at}: shown again after a reload (remembered)`);
      await ctrlB();
      check(!(await shown()) && (await ev(`${B}.getAttribute("aria-pressed")`)) === "false", `${at}: Ctrl+B hides them`);
      await ctrlB();
      check(await shown(), `${at}: Ctrl+B shows them again`);
      await ev(`(${B}.click(), 1)`);
      await sleep(300);
      check(!(await shown()), `${at}: a click hides them`);
    }
  }
  check(errors.length === 0, "no uncaught exceptions", errors.slice(0, 3));
} catch (e) {
  fails.push("threw: " + (e?.stack ?? e));
} finally {
  ws.close();
  try { process.kill(-chrome.pid, "SIGKILL"); } catch {}
  rmSync(profile, { recursive: true, force: true });
}
if (fails.length) {
  console.error(`FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`ok: ${checks} checks`);
process.exit(0);
