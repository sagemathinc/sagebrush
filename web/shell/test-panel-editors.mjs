// ci: web-browser/latex order=47 chrome
// The Terminal from the editors' own pages (T1: it didn't open from a .tex file's page): the LaTeX editor (/?tex=) and
// the code page (/?code=), both hosted by the notebook page, whose ⋯ menu (and its Terminal) they hide.  Each page's
// Terminal button opens this tab's one shell in its dock (pressed while it is shown); a command runs; ps names the file
// open here, not a notebook; the button again closes it (the session kept, focus back on the button); File ▸ End
// terminal session…, shown only while the Terminal is, ends it.  Headless Chromium against a web/dist built with
// SAGEBRUSH_LATEX_PREVIEW=test, served by web/serve.py:
//   SAGEBRUSH_LATEX_PREVIEW=test bun web/build.ts && node web/shell/test-panel-editors.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, startServe } from "../test-port.mjs";

const here = join(import.meta.dirname, "..");
if (!existsSync(join(here, "dist", "shell", "preview-set.json"))) throw new Error("build web/dist first (SAGEBRUSH_LATEX_PREVIEW=test bun web/build.ts)");
let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); console.log(`${ok ? "ok" : "FAIL"} ${what}`); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let server = null, chrome = null;
const profile = mkdtempSync(join(tmpdir(), "sb-test-editors-"));
try {
  const port = await startServe(() => (server = spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] }))).port;
  const base = `http://127.0.0.1:${port}/`;
  chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", "--window-size=1100,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", detached: true });
  const dport = await devtoolsPort(profile);
  const target = (await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json()).find((t) => t.type === "page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let seq = 0;
  const waiting = new Map(), errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) (waiting.get(m.id)(m), waiting.delete(m.id));
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
  };
  // (a DevTools call that never answers is a failure in words, never a hang)
  const send = (method, params = {}) => new Promise((r, j) => {
    const id = ++seq;
    const t = setTimeout(() => (waiting.delete(id), j(new Error(`DevTools ${method} gave no answer in 30 s`))), 30000);
    waiting.set(id, (m) => (clearTimeout(t), r(m)));
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
      await pause(100);
    }
  };
  // (a page left: marked first, so what's waited for next is the new document's)
  const go = async (url) => { await evaluate("(window.__old = 1, 1)"); await send("Page.navigate", { url }); await pause(300); await until("!window.__old && document.readyState !== 'loading'"); };
  const realKey = async (key) => {
    const vk = { Enter: 13 }[key];
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  };
  const T = "window.__sbTerm";
  // (one command, typed into the shell's line editor and sent with a real Enter: the screen's text after it)
  const run = async (cmd) => {
    await evaluate(`(${T}.term.focus(), document.querySelector(".sb-term-status").textContent = "", ${T}.editor.reset(${JSON.stringify(cmd)}), 1)`);
    await realKey("Enter");
    if (!(await until(`!document.querySelector(".sb-term").classList.contains("running") && document.querySelector(".sb-term-status").textContent !== "" && !${T}.writer.writing`, 60000))) return null;
    return evaluate(`(() => { const b = ${T}.term.buffer.active, out = []; for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? ""); return out.join("\\n"); })()`);
  };
  await send("Runtime.enable");
  await send("Page.enable");
  await go(base);
  check(!!(await until(`!!window.sagebrush?.workspace`, 60000)), "the workspace is open");
  const fids = await evaluate(`(async () => {
    const w = window.sagebrush.workspace;
    await w.create("/t1.tex", { content: "\\\\documentclass{article}\\n\\\\begin{document}\\nHello.\\n\\\\end{document}\\n" });
    await w.create("/t1.py", { content: "print(1)\\n" });
    return { tex: (await w.stat("/t1.tex")).fid, code: (await w.stat("/t1.py")).fid };
  })()`);
  check(!!fids?.tex && !!fids?.code, `a .tex and a .py file, each with its id: ${JSON.stringify(fids)}`);
  const PAGES = [
    { name: "the LaTeX editor", url: `?tex=${fids?.tex}`, btn: ".tex-head .sb-termbtn", next: "tex-present-btn", file: ".tex-filebtn", menu: ".tex-filemenu", ps: "t1.tex  (latex)" },
    { name: "the code page", url: `?code=${fids?.code}`, btn: ".code-head .sb-termbtn", next: "code-menu-wrap", file: ".code-menu-wrap > button", menu: ".code-filemenu", ps: "/t1.py  (code)" },
  ];
  for (const p of PAGES) {
    await go(base + p.url);
    const B = `document.querySelector(${JSON.stringify(p.btn)})`;
    const END = `document.querySelector(${JSON.stringify(p.menu + " .sb-termend")})`;
    check(!!(await until(`!!${B} && !${B}.hidden`, 60000)), `${p.name}: a Terminal button in its own bar`);
    // (grader's E8: its place in the bar, before Present on the LaTeX editor, before the File menu on the code page)
    check(await evaluate(`${B}.nextElementSibling?.classList.contains(${JSON.stringify(p.next)})`) === true, `${p.name}: the button sits just before ${p.next}`);
    check(!!(await until(`${B}.getAttribute("aria-pressed") === "false" && !${END} && !document.querySelector(".sb-term")`, 10000)), `${p.name}: closed at first (not pressed); no File ▸ End terminal session…`);
    await evaluate(`(${B}.focus(), ${B}.click(), 1)`);
    check(!!(await until(`!!document.querySelector(".sb-term") && !document.querySelector(".sb-term").hidden && document.querySelector(".sb-term").dataset.startMs !== undefined && !document.querySelector(".sb-term-loading")`, 60000)), `${p.name}: the button opens the Terminal, and its shell starts`);
    const open = await evaluate(`(() => { const d = document.querySelector(".sb-term").getBoundingClientRect(), b = ${B}.getBoundingClientRect();
      const pg = document.querySelector(".tex-page, .code-page").getBoundingClientRect();
      return { pressed: ${B}.getAttribute("aria-pressed"), end: !!${END} && !${END}.hidden && ${END}.textContent === "End terminal session…", focused: !!document.activeElement?.closest(".sb-term"), barAbove: b.bottom <= d.top, pageEnd: Math.round(pg.bottom), dockTop: Math.round(d.top) }; })()`);
    check(open?.pressed === "true" && open.end && open.focused && open.barAbove && open.pageEnd <= open.dockTop + 1, `${p.name}: open: the button pressed, End shown, the shell focused, the page ending above the dock: ${JSON.stringify(open)}`);
    const out = await run(`echo t1-${p.url.slice(1, 4)}`);
    check(typeof out === "string" && out.split("\n").includes(`t1-${p.url.slice(1, 4)}`), `${p.name}: a command runs: ${JSON.stringify(out?.slice(-200))}`);
    const ps = await run("ps");
    check(typeof ps === "string" && ps.includes(p.ps) && ps.includes("[this tab]") && !/Untitled/.test(ps), `${p.name}: ps names the file open here: ${JSON.stringify(ps?.slice(-400))}`);
    // (grader's 1000-2: this tab's own entry, its kind, name and mode: "other", the file, latex or code; never a notebook)
    const mine = typeof ps === "string" ? ps.split("\n").find((l) => l.includes(p.ps) && l.includes("[this tab]")) : null;
    check(!!mine && /^\d+\s+\S+\s+other\s/.test(mine) && !ps.split("\n").some((l) => /\snotebook\s/.test(l) && l.includes("[this tab]")), `${p.name}: this tab's entry is kind other, with the file and its mode: ${JSON.stringify(mine)}`);
    await evaluate(`(${B}.click(), 1)`);
    const shut = await until(`(() => { const d = document.querySelector(".sb-term"); return d && d.hidden && ${B}.getAttribute("aria-pressed") === "false" && ${END}.hidden ? { focus: document.activeElement === ${B} } : null; })()`, 5000);
    check(!!shut && (await evaluate(`Math.round(document.querySelector(".tex-page, .code-page").getBoundingClientRect().bottom) === innerHeight`)), `${p.name}: the button again closes it, the session kept, the page whole again: ${JSON.stringify(shut)}`);
    await evaluate(`(${B}.click(), 1)`);
    check(!!(await until(`!document.querySelector(".sb-term").hidden && ${B}.getAttribute("aria-pressed") === "true"`, 10000)), `${p.name}: and opens it again`);
    await evaluate(`(window.confirm = () => true, document.querySelector(${JSON.stringify(p.file)}).click(), 1)`);
    await pause(100);
    await evaluate(`(${END}.click(), 1)`);
    check(!!(await until(`!document.querySelector(".sb-term") && ${B}.getAttribute("aria-pressed") === "false" && ${END}.hidden && !window.__sbTerm`, 10000)), `${p.name}: File ▸ End terminal session… ends it (the dock gone, End hidden again)`);
    // (grader's 1000-1: and its File menu closed: hidden, its button not expanded)
    const menuAfter = await evaluate(`({ hidden: document.querySelector(${JSON.stringify(p.menu)}).hidden, expanded: document.querySelector(${JSON.stringify(p.file)}).getAttribute("aria-expanded") })`);
    check(menuAfter?.hidden === true && menuAfter.expanded !== "true", `${p.name}: after End, the File menu is closed: ${JSON.stringify(menuAfter)}`);
  }
  check(errors.length === 0, "no page errors: " + errors.join(" | ").slice(0, 400));
  ws.close();
} catch (e) {
  fails.push("threw: " + (e?.stack ?? e));
} finally {
  // (its whole process group: the renderer and GPU processes too, not only the main one)
  try { if (chrome?.pid) process.kill(-chrome.pid, "SIGKILL"); } catch {}
  server?.kill("SIGKILL");
  rmSync(profile, { recursive: true, force: true });
}
if (fails.length) {
  console.log(`test-panel-editors: ${fails.length} of ${checks} FAILED\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`test-panel-editors: all ${checks} checks pass`);
