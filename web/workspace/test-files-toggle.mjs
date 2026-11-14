// ci: web-runner order=482 chrome
// The Files button in the top-left corner (web/workspace/files-toggle.ts; William, Nov 8: "PUT A BUTTON IN THE UPPER
// LEFT TO SHOW THE SIDEBAR"), in headless Chromium against the built site, at a desktop width and a phone width, on
// the notebook page, a code file (/?code=), a board (/board/) and, in a build with the LaTeX editor, a .tex file:
//  - the button is there without opening any menu, in the window's top-left corner, on top (nothing covers it), and
//    nothing of the page is under it, whether the files are hidden or shown;
//  - one click shows the files and another hides them; Ctrl+B does the same; aria-pressed says which;
//  - the choice is remembered across a reload;
//  - the icon is drawn, the views' own Files buttons stay hidden, and on a phone each top bar starts just right of it;
//  - Ctrl+B only: not a plain b, not with Shift or Alt; Cmd+B too; not in a rich-text field, nor once another handler
//    took the key; the browser's own Ctrl+B prevented; the focus back on the button when the files hide.
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
// (B with modifiers: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift; 0 types a "b")
const keyB = async (modifiers = 2) => {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "b", code: "KeyB", windowsVirtualKeyCode: 66, modifiers, ...(modifiers ? {} : { text: "b" }) });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "b", code: "KeyB", windowsVirtualKeyCode: 66, modifiers });
  await sleep(400);
};
const ctrlB = () => keyB(2);
// (the top bar of each view, and how far its first visible thing starts right of the button: files hidden)
const TOP = { notebook: "body > header", "code file": ".code-page .code-head", board: '[data-sbb="top"]', "LaTeX file": ".tex-page .tex-head" };
const firstGap = (sel) => ev(`(() => { const t = document.querySelector(${JSON.stringify(sel)}); if (!t || !t.offsetParent) return null; const b = ${B}.getBoundingClientRect();
  const xs = [...t.querySelectorAll("*")].filter((e) => !e.children.length && e.offsetParent && getComputedStyle(e).visibility !== "hidden" && e.getBoundingClientRect().width > 0).map((e) => e.getBoundingClientRect().left);
  return xs.length ? Math.round(Math.min(...xs) - b.right) : null; })()`);

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
      // (the icon is drawn: an SVG in its namespace, with a box; at a phone width it is all the button shows)
      const ic = await ev(`(() => { const s = ${B}.querySelector("svg"); if (!s) return null; const r = s.getBoundingClientRect(); return { ns: s.namespaceURI, w: Math.round(r.width), h: Math.round(r.height), bbox: Math.round(s.getBBox().width) }; })()`);
      check(!!ic && ic.ns === "http://www.w3.org/2000/svg" && ic.w >= 12 && ic.h >= 12 && ic.bbox > 0, `${at}: the icon is drawn`, ic);
      // (the views' own Files buttons stay hidden while the corner one is there)
      check((await ev(`[...document.querySelectorAll(".code-files, .tex-back")].filter((e) => e.offsetParent).length`)) === 0, `${at}: no second Files button in the view's header`);
      if (mobile && TOP[name]) {
        const gap = await firstGap(TOP[name]);
        if (gap !== null) check(gap >= 0 && gap <= 16, `${at}: the top bar starts just right of the button (no more room than the button needs)`, gap);
      }
      await ev(`(${B}.click(), 1)`);
      await sleep(500);
      const g2 = await geometry();
      check((await shown()) && g2?.pressed === "true" && g2.onTop, `${at}: a click shows the files (aria-pressed true), the button still on top`, g2);
      check(!!g2 && g2.under.length === 0, `${at}: nothing of the files' header under the button`, g2?.under);
      if (name === "board" && !mobile) {
        const pad = await ev(`parseFloat(getComputedStyle(document.querySelector('[data-sbb="top"]')).paddingLeft)`);
        check(pad < 40, `${at}: with the files shown, the board's top bar keeps no room for the button (the files' header has it)`, pad);
      }
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
  // ---- the shortcut's near misses, on the notebook page at a desktop width (the files hidden to begin with)
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await ev(`(localStorage.setItem("sagebrush-files-sidebar", "0"), 1)`);
  await go(base);
  await until(`!!window.sagebrush?.notebook && !!${B} && !${B}.hidden && !!document.querySelector(".cell textarea")`, 60000);
  // (a code cell's editor, visible: the caret at its end)
  const ta = `[...document.querySelectorAll(".cell textarea")].find((t) => t.offsetParent)`;
  const v0 = await ev(`(() => { const t = ${ta}; t.focus(); t.setSelectionRange(t.value.length, t.value.length); return t.value; })()`);
  await keyB(0);
  const typed = await ev(`({ v: ${ta}.value, active: document.activeElement === ${ta} })`);
  check(!(await shown()) && typed.v === v0 + "b", "a plain b typed in a cell is a b: the files don't move", { shown: await shown(), tail: typed.v.slice(-12), active: typed.active, v0tail: v0.slice(-12) });
  await keyB(2 | 8);
  check(!(await shown()), "Ctrl+Shift+B does nothing to the files");
  await keyB(2 | 1);
  check(!(await shown()), "Ctrl+Alt+B does nothing to the files");
  await keyB(4);
  check(await shown(), "Cmd+B (Meta) shows them");
  await keyB(4);
  check(!(await shown()), "Cmd+B hides them");
  await ev(`(() => { const d = document.createElement("div"); d.id = "t-rich"; d.contentEditable = "true"; d.textContent = "rich"; document.body.append(d); d.focus(); return 1; })()`);
  await ctrlB();
  check(!(await shown()), "Ctrl+B in a rich-text field (contenteditable) is bold's: the files don't move");
  await ev(`(document.getElementById("t-rich").remove(), document.activeElement.blur(), 1)`);
  await ev(`(addEventListener("keydown", (e) => e.preventDefault(), { capture: true, once: true }), 1)`);
  await ctrlB();
  check(!(await shown()), "Ctrl+B another handler already took (defaultPrevented) does nothing");
  await ev(`(window.__tPrevented = null, addEventListener("keydown", (e) => { if (e.key === "b") window.__tPrevented = e.defaultPrevented; }, { once: true }), 1)`);
  await ctrlB();
  check((await shown()) && (await ev(`window.__tPrevented`)) === true, "Ctrl+B shows them, and the browser's own Ctrl+B is prevented");
  // (the focus in the files as they hide: it goes to the button, not left in the hidden files)
  check(await ev(`(() => { const f = ${S}.querySelector("button, [tabindex], a[href], input"); if (!f) return false; f.focus(); return document.activeElement === f; })()`), "a control in the files has the focus");
  await ctrlB();
  check(!(await shown()) && (await ev(`document.activeElement === ${B}`)), "Ctrl+B hides them, and the focus goes to the button (not left in the hidden files)");
  // (the focus in the document as they hide: it stays there, never moved to the button)
  await ctrlB();
  const cell = await ev(`(() => { const t = ${ta}; t.focus(); return document.activeElement === t; })()`);
  await ctrlB();
  check(cell && !(await shown()) && (await ev(`document.activeElement === ${ta}`)), "Ctrl+B from a cell hides them and leaves the focus in the cell");
  await ev(`(${B}.hidden = true, 1)`);
  const hid = await ev(`getComputedStyle(${B}).display`);
  await ctrlB();
  check(hid === "none" && !(await shown()), "a hidden button (before the workspace is open) isn't shown, and Ctrl+B does nothing", hid);
  await ev(`(${B}.hidden = false, 1)`);
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
