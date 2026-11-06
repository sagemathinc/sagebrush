// ci: web-runner order=505 chrome
// The code page (1a, web/code/page.ts): a .py, .sage, .m, .mag, .js, .json or .txt file at /?code=<fid>, in headless
// Chromium against the built site:
//  - Files opens a code file there (the notebook page and the board page), not in the data-file preview;
//  - View: highlighted (the notebook's colors), line numbers, read-only; a file's text is only ever text (no element,
//    no script, from what it holds);
//  - ✎ Edit: saved as you type, over the revision read (the bytes, and a version of the old ones), Edit remembered;
//  - a change made elsewhere: followed with nothing unsaved here; with unsaved edits, saving stops and the bar says so,
//    and the other change is never written over;
//  - the one File menu (Share… disabled, saying why; Download ▸ the file; Rename…); a file too large, a missing id.
// Serve web/dist first (python3 web/serve.py 8765), then
//   node web/code/test-code-page.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-code-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!port) port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = []; const dialogs = [];
let promptText = "";
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
  if (m.method === "Page.javascriptDialogOpening") { dialogs.push(m.params); send("Page.handleJavaScriptDialog", { accept: true, ...(m.params.type === "prompt" ? { promptText } : {}) }); }
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 1500)); return r.result?.value; };
const until = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
const go = async (url) => { await send("Page.navigate", { url }); await sleep(300); };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const W = "window.sagebrush?.workspace", C = "window.sagebrush?.code";
const text = (p) => `${W}.read(${JSON.stringify(p)}).then((r) => new TextDecoder().decode(r.content))`;
const PY = `def square(x):\n    return x ** 2  # a comment\n\ns = "</script><img src=x onerror=\\"window.__pwned=1\\">"\nprint(square(3), s)\n`;
const page = (p) => `${W}.stat(${JSON.stringify(p)}).then((e) => e.fid)`;
const openCode = async (p) => { const fid = await ev(page(p)); await go(base + "?code=" + fid); return until(`!!${C} && ${C}.path === ${JSON.stringify(p)}`, 30000); };

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await go(base);
  await until(`!!${W} && !!window.sagebrush?.notebook`, 60000);
  await ev(`(async () => {
    const w = ${W};
    await w.create("/demo.py", { content: ${JSON.stringify(PY)} });
    await w.create("/notes.txt", { content: "one\\ntwo\\n" });
    await w.create("/fn.m", { content: "% a comment\\nx = 'it''s';\\n" });
    await w.create("/big.json", { content: "[" + "1,".repeat(2200000) + "1]" });
    return 1; })()`);

  // Files: a code file opens its page, not the preview
  await ev(`(() => { if (document.querySelector("#wssidebar")?.hidden !== false) document.querySelector("#wsfilesbtn").click(); return 1; })()`);
  await until(`!!document.querySelector('#wssidebar .frow[data-path="/demo.py"]')`, 20000);
  await ev(`(() => { document.querySelector('#wssidebar .frow[data-path="/demo.py"]').click(); return 1; })()`);
  check(await until(`/[?&]code=[\\w-]+/.test(location.search) && !!${C} && ${C}.path === "/demo.py"`, 30000), "Files: a .py file opens its own page (/?code=<fid>), not the preview");
  check(!(await ev(`!!document.querySelector(".sbfprev")`)), "…no data-file preview over it");

  // View: highlighted, line numbers, read-only, the text only ever text
  check(await until(`${C}.mode() === "view" && !!document.querySelector(".code-page .code-src")`), "View: the file opens in View (William's Nov 4 rule)");
  check(await ev(`[...document.querySelectorAll(".code-page .code-src .hk")].some((s) => s.textContent === "def") && [...document.querySelectorAll(".code-page .code-src .hf")].some((s) => s.textContent === "square") && !!document.querySelector(".code-page .code-src .hc")`), "…highlighted as the notebook highlights Python: def a keyword, square being defined, # a comment");
  check(await ev(`document.querySelector(".code-page .code-src").textContent === ${JSON.stringify(PY)}`), "…the file's text exactly");
  check(await ev(`document.querySelector(".code-page .code-ln").textContent.split("\\n").length === ${PY.split("\n").length}`), "…a line number for each line");
  check(await ev(`!document.querySelector(".code-page textarea") && !document.querySelector(".code-page [contenteditable]")`), "…read-only: nothing to type into");
  check(await ev(`!document.querySelector(".code-page img") && !document.querySelector(".code-page script") && window.__pwned === undefined`), "…a file holding </script><img onerror> is shown as text: no element made, nothing run");
  check(await ev(`document.querySelector(".code-page .code-lang").textContent === "Python" && document.title.startsWith("demo.py")`), "…its language and name shown");

  // the File menu: the one menu, Share… disabled saying why, Download ▸ the file
  await ev(`(() => { [...document.querySelectorAll(".code-page .code-head button")].find((b) => b.textContent === "File ▾").click(); return 1; })()`);
  check(await ev(`(() => { const m = document.querySelector(".code-page .code-filemenu"); const s = m.querySelector("[data-item=share]"); return !m.hidden && !!m.querySelector("[data-item=examples]") && !!m.querySelector("[data-item=open]") && s.disabled && /shared with its notebook or folder/.test(s.title); })()`), "File ▾: the one File menu (Examples…, Open…); Share… disabled, saying why");
  check(await ev(`[...document.querySelectorAll(".code-page .code-filemenu [data-group=download] + .fmgroup button")].map((b) => b.textContent).join() === "demo.py"`), "…Download ▸ the file itself");
  await ev(`(() => { document.body.click(); return 1; })()`);

  // ✎ Edit: saved as you type, a version kept, Edit remembered
  const versions0 = await ev(`${W}.history("/demo.py").then((h) => h.length)`);
  await ev(`(() => { document.querySelector(".code-page .code-toggle").click(); return 1; })()`);
  check(await until(`${C}.mode() === "edit" && !!document.querySelector(".code-page .code-edit textarea")`), "✎ Edit: a textarea, the highlighting behind it");
  check(await ev(`[...document.querySelectorAll(".code-page .code-edit pre .hk")].some((s) => s.textContent === "def")`), "…still highlighted while editing");
  await ev(`(() => { const t = document.querySelector(".code-page .code-edit textarea"); t.value += "y = 7\\n"; t.dispatchEvent(new Event("input")); return 1; })()`);
  check(await until(`${text("/demo.py")}.then((s) => s.endsWith("y = 7\\n"))`, 10000), "…saved as you type: the file has the edit");
  check(await until(`${W}.history("/demo.py").then((h) => h.length > ${versions0})`, 10000), "…and the bytes it replaced kept as a version");
  check(await until(`/Saved/.test(document.querySelector(".code-page .code-status").textContent)`), "…said: Saved");
  await go(base + "?code=" + (await ev(page("/demo.py"))));
  check(await until(`!!${C} && ${C}.mode() === "edit"`, 30000), "…Edit remembered: the file opens in Edit again here");
  await ev(`${C}.setMode("view").then(() => 1)`);
  await go(base + "?code=" + (await ev(page("/demo.py"))));
  check(await until(`!!${C} && ${C}.mode() === "view"`, 30000), "…and View once left in View");

  // a change elsewhere, nothing unsaved here: followed
  await ev(`${W}.write("/demo.py", "print('changed elsewhere')\\n").then(() => 1)`);
  check(await until(`document.querySelector(".code-page .code-src")?.textContent === "print('changed elsewhere')\\n"`, 10000), "a change made elsewhere, nothing unsaved here: the page shows it");

  // a change elsewhere while editing with unsaved edits: saving stops, theirs kept
  await ev(`${C}.setMode("edit").then(() => 1)`);
  await until(`!!document.querySelector(".code-page .code-edit textarea")`);
  await ev(`(() => { const t = document.querySelector(".code-page .code-edit textarea"); t.value = "mine\\n"; t.dispatchEvent(new Event("input")); return 1; })()`);
  // (their write, then this page's save at once, before the page has heard of theirs: the save itself must refuse to
  //  write over a revision it didn't read)
  await ev(`${W}.write("/demo.py", "theirs\\n").then(() => ${C}.flush()).then(() => 1)`);
  check(await until(`${C}.stopped() && !document.querySelector(".code-page .code-bar").hidden && /changed elsewhere/.test(document.querySelector(".code-page .code-bar").textContent)`, 10000), "a change made elsewhere while editing: saving stops and the bar says so");
  await sleep(1500);
  check(await ev(`${text("/demo.py")}`) === "theirs\n", "…their change is never written over");
  check(await ev(`[...document.querySelectorAll(".code-page .code-bar button")].map((b) => b.textContent).join("|") === "Reload (theirs)|Save mine as a copy"`), "…offering Reload (theirs) or Save mine as a copy");
  await ev(`(() => { [...document.querySelectorAll(".code-page .code-bar button")].find((b) => b.textContent === "Save mine as a copy").click(); return 1; })()`);
  check(await until(`${text("/demo (copy).py")}.then((s) => s === "mine\\n").catch(() => false)`, 10000), "…Save mine as a copy: a new file beside it, with the text from here");

  // MATLAB: the notebook's MATLAB colors
  check(await openCode("/fn.m"), "a .m file opens");
  check(await ev(`!!document.querySelector(".code-page .code-src .hc") && !!document.querySelector(".code-page .code-src .hs") && document.querySelector(".code-page .code-lang").textContent === "MATLAB"`), "…highlighted as MATLAB (a comment, a string)");

  // Rename… from the File menu
  promptText = "notes2";
  check(await openCode("/notes.txt"), "a .txt file opens");
  await ev(`(() => { [...document.querySelectorAll(".code-page .code-head button")].find((b) => b.textContent === "File ▾").click(); document.querySelector(".code-page .code-filemenu [data-item=rename]").click(); return 1; })()`);
  check(await until(`${C}.path === "/notes2.txt" && document.querySelector(".code-page .code-name").textContent === "notes2.txt"`, 10000), "File ▸ Rename…: the file renamed, its new name shown");

  // too large; a missing id
  check(await openCode("/big.json").then(() => until(`/too large to open here/.test(document.querySelector(".code-page .code-note")?.textContent ?? "")`, 10000)), "a file over 4 MB: said, with Download from Files");
  await go(base + "?code=nosuchfid000");
  check(await until(`/isn't here any more/.test(document.querySelector(".code-page .code-note")?.textContent ?? "")`, 30000), "an id no file has: said");

  // the board page: Files opens a code file there too
  await go(base + "board/?new=python");
  await until(`!!window.sagebrush?.board?.snapshot() && !!${W}`, 60000);
  await ev(`(() => { const b = [...document.querySelectorAll("button")].find((x) => x.getAttribute("aria-controls") === "bdfiles" || /^Files$/.test(x.textContent?.trim() ?? "")); b?.click(); return 1; })()`);
  if (await until(`!!document.querySelector('.frow[data-path="/notes2.txt"]')`, 20000)) {
    await ev(`(() => { document.querySelector('.frow[data-path="/notes2.txt"]').click(); return 1; })()`);
    check(await until(`/[?&]code=[\\w-]+/.test(location.search) && !!${C} && ${C}.path === "/notes2.txt"`, 30000), "the board page's Files: a code file opens its own page too");
  } else check(false, "the board page's Files: the file list shows");
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
console.log(`ok: the code page, ${checks} checks`);
process.exit(0);
