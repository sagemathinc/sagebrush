// ci: web-runner order=483 chrome
// ci: web-browser/latex order=45 chrome env=EXPECT_LATEX=1
// Resizable panels (web/workspace/resize.ts; William, Nov 8: "make every single panel resizable. Right now even the
// file panel on the left is not resizable."), in headless Chromium against the built site, by real mouse drags:
//  - the files (#wssidebar), on the notebook page, a code file and a board: dragging their right edge sets their
//    width and the view beside them starts where they end; the width is remembered across a reload; the arrow keys
//    step it; a double-click puts 272 px back and forgets it; it stays within 200 px and the window less 320 px; on a
//    phone width there is no edge (the files cover the window, as before);
//  - in a build with the LaTeX editor (CI's web-browser/latex, EXPECT_LATEX=1: there the block must run), its source
//    and preview: dragging the edge between them sets the source's share within 20-80%, remembered across a reload, a
//    double-click puts the halves back; another file opened in place leaves nothing of the old split working (no
//    listener, observer or queued frame).
//  - the keys: Arrow 16 px, Shift+Arrow 64, Home/End the bounds, kept across a reload; aria-valuenow the drawn width;
//    a right-button drag does nothing.
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
  // (the size observers that watch a LaTeX editor's .tex-main, still connected: one per live editor)
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { const RO = window.ResizeObserver; const live = new Set(); window.__texRO = () => [...live].length;
    window.ResizeObserver = class extends RO { observe(t, ...a) { if (t?.classList?.contains("tex-main")) live.add(this); return super.observe(t, ...a); } disconnect() { live.delete(this); return super.disconnect(); } };
    // (animation frames, held while window.__holdRaf is set, run by window.__releaseRaf(): cancelled ones never run)
    const raf = window.requestAnimationFrame.bind(window), caf = window.cancelAnimationFrame.bind(window), held = new Map(); let n = 1e9;
    window.requestAnimationFrame = (f) => { if (!window.__holdRaf) return raf(f); const id = ++n; held.set(id, f); return id; };
    window.cancelAnimationFrame = (id) => { if (held.delete(id)) return; caf(id); };
    window.__releaseRaf = () => { window.__holdRaf = false; const fs = [...held.values()]; held.clear(); for (const f of fs) f(performance.now()); return fs.length; }; })()` });
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await go(base);
  await until(`!!window.sagebrush?.workspace`, 60000);
  await ev(`(localStorage.removeItem("sagebrush-files-width"), localStorage.removeItem("sagebrush-tex-split"), 1)`);
  const fids = await ev(`(async () => { const w = window.sagebrush.workspace;
    const py = await w.create("/t/resize.py", { content: "print(1)\\n" });
    const tex = await w.create("/t/resize.tex", { content: "\\\\documentclass{article}\\n\\\\begin{document}\\nHi\\n\\\\end{document}\\n" });
    for (const x of ["b", "c"]) await w.create("/t/resize-" + x + ".tex", { content: "\\\\documentclass{article}\\n\\\\begin{document}\\nFile " + x + "\\n\\\\end{document}\\n" });
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
  // (the keys and the pointer: Shift+Arrow by 64, Home/End the bounds, a key's width kept; aria-valuenow the drawn
  // width; a right-button drag does nothing)
  const key = async (k, code, vk, modifiers = 0) => { await ev(`document.querySelector(${JSON.stringify(EDGE)}).focus()`); await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers }); await sleep(200); };
  await key("ArrowRight", "ArrowRight", 39, 8);
  check((await sideW()) === 272 + 64, "notebook page: Shift+ArrowRight widens them by 64 px", await sideW());
  await key("Home", "Home", 36);
  check((await sideW()) === 200, "notebook page: Home gives the narrowest, 200 px", await sideW());
  await key("End", "End", 35);
  check((await sideW()) === 640, "notebook page: End gives the widest, 640 px", await sideW());
  await key("ArrowLeft", "ArrowLeft", 37);
  await go(base);
  await until(`!!window.sagebrush?.notebook`, 60000);
  await until(`!${S}.hidden && !!document.querySelector(${JSON.stringify(EDGE)})`);
  check((await sideW()) === 640 - 16, "notebook page: a width set by a key is kept across a reload", await sideW());
  await drag(EDGE, 333);
  check(Number(await ev(`document.querySelector(${JSON.stringify(EDGE)}).getAttribute("aria-valuenow")`)) === (await sideW()) && Math.abs((await sideW()) - 333) <= 3, "notebook page: aria-valuenow is the drawn width after a drag", { now: await ev(`document.querySelector(${JSON.stringify(EDGE)}).getAttribute("aria-valuenow")`), w: await sideW() });
  const wR = await sideW();
  {
    const r = await ev(`(() => { const b = document.querySelector(${JSON.stringify(EDGE)}).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "right", buttons: 2, clickCount: 1 });
    for (let i = 1; i <= 4; i++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x + 30 * i, y: r.y, button: "right", buttons: 2 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x + 120, y: r.y, button: "right", buttons: 0, clickCount: 1 });
    await sleep(250);
  }
  check((await sideW()) === wR, "notebook page: a right-button drag doesn't resize them", { before: wR, after: await sideW() });
  await dbl(EDGE);
  // (the chosen width is kept apart from what a narrower window draws: daybreak3's E2)
  await drag(EDGE, 600);
  const chosen = await sideW();
  await send("Emulation.setDeviceMetricsOverride", { width: 800, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  check((await sideW()) === 800 - 320, "notebook page: a window 800 px wide draws them 480 px (the page keeps 320)", await sideW());
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  check((await sideW()) === chosen && Number(await ev(`localStorage.getItem("sagebrush-files-width")`)) === chosen, "notebook page: wide again, the chosen width is back (and still the one kept)", { w: await sideW(), chosen });
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(400);
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  check((await sideW()) === chosen, "notebook page: after a phone width, the chosen width is back", { w: await sideW(), chosen });
  await dbl(EDGE);

  // ---- a code file: the code page starts where the files end
  await drag(EDGE, 380);
  await go(base + "?code=" + fids.py);
  await until(`!!window.sagebrush?.code`, 60000);
  await showFiles();
  await until(`!${S}.hidden`);
  check(Math.abs((await sideW()) - 380) <= 3 && Math.abs((await viewLeft(".code-page")) - (await sideW())) <= 1, "code file: the remembered width, the code page beside it", { w: await sideW(), left: await viewLeft(".code-page") });

  // ---- the LaTeX editor, where the build has it: beside the files, and its own split
  await go(base + "?tex=" + fids.tex + "&latex=1");
  const texOn = await until(`!!document.querySelector(".tex-page .tex-src")`, 30000);
  if (process.env.EXPECT_LATEX === "1") check(texOn, "LaTeX build: the LaTeX editor opens, so its checks below run (none skipped)");
  if (texOn) {
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
    await drag(SPLIT, m.x + m.w * 0.97);
    const hi = await share();
    await drag(SPLIT, m.x + m.w * 0.03);
    const lo = await share();
    check(Math.abs(hi - 80) <= 1 && Math.abs(lo - 20) <= 1, "LaTeX editor: the split stays within 20% and 80%", { hi, lo });
    await drag(SPLIT, m.x + m.w * 0.3);
    const edgeAt = await ev(`(() => { const e = document.querySelector(${JSON.stringify(SPLIT)}).getBoundingClientRect(), l = document.querySelector(".tex-left").getBoundingClientRect(); return JSON.stringify({ d: Math.round(e.x + e.width / 2 - l.right), e: [e.x, e.width, e.height], l: [l.x, l.right] }); })()`).then(JSON.parse);
    check(Math.abs(edgeAt.d) <= 2 && edgeAt.e[2] > 100, "LaTeX editor: the edge follows the source's right side, its full height", edgeAt);
    await go(base + "?tex=" + fids.tex + "&latex=1");
    await until(`!!document.querySelector(".tex-page .tex-src")`, 30000);
    await sleep(300);
    check(Math.abs((await share()) - 30) <= 2, "LaTeX editor: the same split after a reload", await share());
    await dbl(SPLIT);
    check(Math.abs((await share()) - 50) <= 1 && (await ev(`localStorage.getItem("sagebrush-tex-split")`)) === null, "LaTeX editor: a double-click puts the halves back", await share());
    // (another file opened in place mounts the editor again: the old editor's edge stops listening (its window
    // listener, its size observer, its queued frame), checked on the old elements kept aside: daybreak3's E1, astra's R1)
    await showFiles();
    const row = (p) => JSON.stringify(`.frow[data-path="${p}"]`);
    await until(`!!document.querySelector(${row("/t/resize-b.tex")}) || (document.querySelector('.frow[data-path="/t"]')?.click(), false)`, 20000);
    check((await ev(`window.__texRO()`)) === 1, "LaTeX editor: one size observer on the split", await ev(`window.__texRO()`));
    for (const x of ["b", "c", ""]) {
      await ev(`(() => { window.__old = window.__old ?? []; window.__old.push({ main: document.querySelector(".tex-main"), edge: document.querySelector(${JSON.stringify(SPLIT)}) }); return 1; })()`);
      const p = `/t/resize${x ? "-" + x : ""}.tex`;
      await ev(`(document.querySelector(${row(p)}).click(), 1)`);
      await until(`document.querySelector(".tex-main") !== window.__old.at(-1).main && !!document.querySelector(".tex-page .tex-src")`, 20000);
      await sleep(300);
    }
    await ev(`(() => { for (const o of window.__old) { o.main.style.setProperty("--tex-split", "1%"); o.edge.style.left = "-999px"; } dispatchEvent(new Event("resize")); return 1; })()`);
    await sleep(300);
    const stale = await ev(`window.__old.filter((o) => o.main.style.getPropertyValue("--tex-split") !== "1%" || o.edge.style.left !== "-999px").length`);
    check(stale === 0 && (await ev(`window.__texRO()`)) === 1, "LaTeX editor: after three files opened in place, no old editor's edge reacts to a resize, and one size observer is left", { stale, observers: await ev(`window.__texRO()`) });
    // (no frame of an old split runs once its editor is gone: one queued just before the switch is cancelled, and none
    // is queued after it, even by a key on the old edge (frames held, then released, around the switch))
    await ev(`(() => { window.__old2 = { edge: document.querySelector(${JSON.stringify(SPLIT)}), main: document.querySelector(".tex-main") }; window.__holdRaf = true; dispatchEvent(new Event("resize")); window.__old2.edge.style.left = "-777px"; document.querySelector(${row("/t/resize-c.tex")}).click(); return 1; })()`);
    await until(`document.querySelector(".tex-main") !== window.__old2.main && document.querySelector(".tex-preview")?.textContent.includes("File c")`, 20000);
    await ev(`(window.__old2.edge.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })), window.__old2.edge.style.left = "-777px", 1)`);
    await ev(`window.__releaseRaf()`);
    await sleep(200);
    check((await ev(`window.__old2.edge.style.left`)) === "-777px", "LaTeX editor: no frame of the old split runs after the switch (the queued one cancelled, none queued after)", await ev(`window.__old2.edge.style.left`));
    // (a drag under way when the editor goes: no page-wide drag state left)
    const e2 = await ev(`(() => { const b = document.querySelector(${JSON.stringify(SPLIT)}).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    await mouse("mouseMoved", e2.x, e2.y, { buttons: 0 });
    await mouse("mousePressed", e2.x, e2.y);
    await mouse("mouseMoved", e2.x - 40, e2.y);
    const during = await ev(`document.body.classList.contains("sb-resizing")`);
    await ev(`(document.querySelector(${row("/t/resize-b.tex")}).click(), 1)`);
    await until(`document.querySelector(".tex-preview")?.textContent.includes("File b")`, 20000);
    const after = await ev(`document.body.classList.contains("sb-resizing")`);
    await mouse("mouseReleased", e2.x - 40, e2.y);
    check(during && !after, "LaTeX editor: a drag under way when another file opens leaves no drag state on the page", { during, after });
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
