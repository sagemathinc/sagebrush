// ci: web-runner order=483 chrome
// Resizable panels (web/workspace/resize.ts; William, Nov 8: "make every single panel resizable. Right now even the
// file panel on the left is not resizable."), in headless Chromium against the built site, by real mouse drags:
//  - the files (#wssidebar), on the notebook page, a code file and a board: dragging their right edge sets their
//    width and the view beside them starts where they end; the width is remembered across a reload; the arrow keys
//    step it; a double-click puts 272 px back and forgets it; it stays within 200 px and the window less 320 px; on a
//    phone width there is no edge (the files cover the window, as before);
//  - in a build with the LaTeX editor, its source and preview: dragging the edge between them sets the source's share,
//    remembered across a reload, and a double-click puts the halves back.
// Serve web/dist first (python3 web/serve.py 8765), then
//   node web/workspace/test-panel-resize.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-resize-"));
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
const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra });
// (a drag of the edge `sel` from its middle to x, in steps, as a hand does)
const drag = async (sel, x) => {
  const r = await ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  await mouse("mouseMoved", r.x, r.y, { buttons: 0 });
  await mouse("mousePressed", r.x, r.y);
  for (let i = 1; i <= 8; i++) await mouse("mouseMoved", r.x + ((x - r.x) * i) / 8, r.y);
  await mouse("mouseReleased", x, r.y);
  await sleep(250);
};
const dbl = async (sel) => {
  const r = await ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  for (const c of [1, 2]) { await mouse("mousePressed", r.x, r.y, { clickCount: c }); await mouse("mouseReleased", r.x, r.y, { clickCount: c }); }
  await sleep(250);
};
const EDGE = "#wssidebar > .sb-edge", S = `document.getElementById("wssidebar")`;
const sideW = () => ev(`Math.round(${S}.getBoundingClientRect().width)`);
const viewLeft = (sel) => ev(`Math.round(document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect().left)`);
const showFiles = () => ev(`(() => { if (${S}.hidden) document.querySelector(".sb-files-toggle").click(); return 1; })()`);

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await go(base);
  await until(`!!window.sagebrush?.workspace`, 60000);
  await ev(`(localStorage.removeItem("sagebrush-files-width"), localStorage.removeItem("sagebrush-tex-split"), 1)`);
  const fids = await ev(`(async () => { const w = window.sagebrush.workspace;
    const py = await w.create("/t/resize.py", { content: "print(1)\\n" });
    const tex = await w.create("/t/resize.tex", { content: "\\\\documentclass{article}\\n\\\\begin{document}\\nHi\\n\\\\end{document}\\n" });
    return { py: py.fid, tex: tex.fid }; })()`);

  // ---- the files, on the notebook page (the page beside them is the body's padding)
  await go(base);
  await until(`!!window.sagebrush?.notebook && !!document.querySelector(".sb-files-toggle:not([hidden])")`, 60000);
  await showFiles();
  check(await until(`!${S}.hidden && !!document.querySelector(${JSON.stringify(EDGE)})`), "notebook page: the files have an edge to drag");
  check((await sideW()) === 272, "notebook page: 272 px to begin with", await sideW());
  await drag(EDGE, 420);
  const w1 = await sideW(), pad1 = await ev(`parseFloat(getComputedStyle(document.body).paddingLeft)`);
  check(Math.abs(w1 - 420) <= 3 && Math.abs(pad1 - w1) <= 1, "notebook page: dragged to 420 px, the page starts where the files end", { w1, pad1 });
  check(Math.abs(Number(await ev(`localStorage.getItem("sagebrush-files-width")`)) - w1) <= 1, "notebook page: the width is kept on this device");
  await go(base);
  await until(`!!window.sagebrush?.notebook`, 60000);
  await until(`!${S}.hidden`);
  check(Math.abs((await sideW()) - w1) <= 1, "notebook page: the same width after a reload", await sideW());
  await ev(`document.querySelector(${JSON.stringify(EDGE)}).focus()`);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
  await sleep(200);
  check(Math.abs((await sideW()) - (w1 + 16)) <= 1, "notebook page: ArrowRight widens them by 16 px", await sideW());
  await drag(EDGE, 60);
  check((await sideW()) === 200, "notebook page: never narrower than 200 px", await sideW());
  await drag(EDGE, 1270);
  check((await sideW()) === 640, "notebook page: never wider than 640 px (nor the window less 320 px)", await sideW());
  await dbl(EDGE);
  check((await sideW()) === 272 && (await ev(`localStorage.getItem("sagebrush-files-width")`)) === null, "notebook page: a double-click puts 272 px back and forgets the width", await sideW());

  // ---- a code file: the code page starts where the files end
  await drag(EDGE, 380);
  await go(base + "?code=" + fids.py);
  await until(`!!window.sagebrush?.code`, 60000);
  await showFiles();
  await until(`!${S}.hidden`);
  check(Math.abs((await sideW()) - 380) <= 3 && Math.abs((await viewLeft(".code-page")) - (await sideW())) <= 1, "code file: the remembered width, the code page beside it", { w: await sideW(), left: await viewLeft(".code-page") });

  // ---- the LaTeX editor, where the build has it: beside the files, and its own split
  await go(base + "?tex=" + fids.tex + "&latex=1");
  if (await until(`!!document.querySelector(".tex-page .tex-src")`, 30000)) {
    await showFiles();
    await until(`!${S}.hidden`);
    check(Math.abs((await viewLeft(".tex-page")) - (await sideW())) <= 1, "LaTeX editor: the page starts where the files end", { w: await sideW(), left: await viewLeft(".tex-page") });
    const SPLIT = ".tex-main > .sb-edge";
    check(await ev(`!!document.querySelector(${JSON.stringify(SPLIT)})`), "LaTeX editor: an edge between the source and the preview");
    const share = () => ev(`(() => { const m = document.querySelector(".tex-main").getBoundingClientRect(), l = document.querySelector(".tex-left").getBoundingClientRect(); return Math.round(l.width / m.width * 100); })()`);
    check(Math.abs((await share()) - 50) <= 1, "LaTeX editor: halves to begin with", await share());
    const m = await ev(`(() => { const r = document.querySelector(".tex-main").getBoundingClientRect(); return { x: r.x, w: r.width }; })()`);
    await drag(SPLIT, m.x + m.w * 0.3);
    check(Math.abs((await share()) - 30) <= 2, "LaTeX editor: dragged to 30%", await share());
    const edgeAt = await ev(`(() => { const e = document.querySelector(${JSON.stringify(SPLIT)}).getBoundingClientRect(), l = document.querySelector(".tex-left").getBoundingClientRect(); return JSON.stringify({ d: Math.round(e.x + e.width / 2 - l.right), e: [e.x, e.width, e.height], l: [l.x, l.right] }); })()`).then(JSON.parse);
    check(Math.abs(edgeAt.d) <= 2 && edgeAt.e[2] > 100, "LaTeX editor: the edge follows the source's right side, its full height", edgeAt);
    await go(base + "?tex=" + fids.tex + "&latex=1");
    await until(`!!document.querySelector(".tex-page .tex-src")`, 30000);
    await sleep(300);
    check(Math.abs((await share()) - 30) <= 2, "LaTeX editor: the same split after a reload", await share());
    await dbl(SPLIT);
    check(Math.abs((await share()) - 50) <= 1 && (await ev(`localStorage.getItem("sagebrush-tex-split")`)) === null, "LaTeX editor: a double-click puts the halves back", await share());
  } else console.log("(no LaTeX editor in this build: its split isn't checked)");

  // ---- a board: the board starts where the files end, and follows a drag
  await go(base + "board/");
  await until(`!!window.sagebrush?.board && !!document.querySelector(".sb-files-toggle:not([hidden])")`, 60000);
  await showFiles();
  await until(`!${S}.hidden && !!document.querySelector(${JSON.stringify(EDGE)})`);
  check(Math.abs((await viewLeft("#board")) - (await sideW())) <= 1, "board: the board starts where the files end", { w: await sideW(), left: await viewLeft("#board") });
  await drag(EDGE, 460);
  check(Math.abs((await sideW()) - 460) <= 3 && Math.abs((await viewLeft("#board")) - (await sideW())) <= 1, "board: dragged, and the board follows", { w: await sideW(), left: await viewLeft("#board") });
  await dbl(EDGE);

  // ---- a phone width: no edge (the files cover the window)
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await go(base);
  await until(`!!window.sagebrush?.notebook`, 60000);
  await showFiles();
  await until(`!${S}.hidden`);
  check((await ev(`getComputedStyle(document.querySelector(${JSON.stringify(EDGE)})).display`)) === "none" && (await sideW()) === 390, "phone: the files cover the window, no edge", await sideW());
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
