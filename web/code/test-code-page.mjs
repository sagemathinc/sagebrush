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
// (a page left: marked first, so what's waited for next is the new document's, never the old one's still showing the same
// file: #922's web-runner red at "(the page again)", the old page's handle answering before the new one put up its own)
const go = async (url) => { await ev("(window.__old = 1, 1)").catch(() => {}); await send("Page.navigate", { url }); await sleep(300); await until("!window.__old && document.readyState !== 'loading'", 30000); };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const W = "window.sagebrush?.workspace", C = "window.sagebrush?.code";
const text = (p) => `${W}.read(${JSON.stringify(p)}).then((r) => new TextDecoder().decode(r.content))`;
const PY = `def square(x):\n    return x ** 2  # a comment\n\ns = "</script><img src=x onerror=\\"window.__pwned=1\\">"\nprint(square(3), s)\n`;
const EVIL = `<img src=x onerror="window.__pwned=2"><b>bold</b>\n`;
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
    await w.create("/evil.txt", { content: ${JSON.stringify(EVIL)} });
    await w.create("/mid.json", { content: "[" + "1,".repeat(750000) + "1]" });
    await w.create("/crlf.txt", { content: "a\\r\\nb\\n" });
    await w.create("/swap.py", { content: "print('mine')\\n" });
    await w.create("/follow.py", { content: "v1\\n" });
    await w.create("/late.py", { content: "v1\\n" });
    return 1; })()`);

  // Files: a code file opens its page, not the preview
  await ev(`(() => { if (document.querySelector("#wssidebar")?.hidden !== false) document.querySelector("#wsfilesbtn").click(); return 1; })()`);
  await until(`!!document.querySelector('#wssidebar .frow[data-path="/demo.py"]')`, 20000);
  // (a middle-click: its page in a new tab, this page left as it is; in a build with the LaTeX editor too, whose
  // middle-click comes first and takes only a .tex)
  const mid = await ev(`(async () => {
    const opened = [], own = window.open, before = location.href;
    window.open = (u) => { opened.push(String(u)); return null; };
    document.querySelector('#wssidebar .frow[data-path="/demo.py"]').dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
    await new Promise((s) => setTimeout(s, 500));
    window.open = own;
    return { opened, here: location.href === before, preview: !!document.querySelector(".sbfprev") };
  })()`);
  check(mid.opened.length === 1 && /\/\?code=[\w-]+$/.test(mid.opened[0]) && mid.here && !mid.preview, "Files: a middle-click on a .py file opens its page in a new tab, this page kept: " + JSON.stringify(mid));
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
  await ev(`(() => { [...document.querySelectorAll(".code-page .code-head button")].find((b) => b.textContent === "File").click(); return 1; })()`);
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
  // (an edit made while a save is being written: the first write held 1.2 s, the second edit's 600 ms timer firing into
  //  it; the second edit must be written too, after it, and Saved said only then: daybreak3 on #773)
  const TA = `document.querySelector(".code-page .code-edit textarea")`, STATUS = `document.querySelector(".code-page .code-status").textContent`;
  // (every status said, in order, recorded as it is set: "Saved" may be said only after the last write)
  await ev(`(() => { const s = document.querySelector(".code-page .code-status"); window.__said = []; window.__saidObs?.disconnect(); window.__saidObs = new MutationObserver((rs) => { for (const r of rs) for (const n of r.addedNodes) window.__said.push(n.textContent); }); window.__saidObs.observe(s, { childList: true }); return 1; })()`);
  await ev(`(() => { window.__sbWrites = 0; let first = true; window.__sbCodeBeforeWrite = () => { window.__sbWrites++; if (first) { first = false; return new Promise((r) => setTimeout(r, 1200)); } }; return 1; })()`);
  await ev(`(() => { const t = ${TA}; t.value += "first\\n"; t.dispatchEvent(new Event("input")); void ${C}.flush(); return 1; })()`);
  await sleep(100);
  await ev(`(() => { const t = ${TA}; t.value += "second\\n"; t.dispatchEvent(new Event("input")); return 1; })()`);
  await sleep(700);
  const during = await ev(STATUS);
  check(await until(`${text("/demo.py")}.then((s) => s.endsWith("first\\nsecond\\n"))`, 10000), "an edit made while a save is being written is written too, after it: " + (await ev(text("/demo.py"))).slice(-20));
  check(await ev(`window.__sbWrites >= 2`), "…in a second write: " + (await ev(`window.__sbWrites`)));
  check(during !== "Saved" && (await until(`${STATUS} === "Saved"`, 10000)), "…Saved said only once the latest text is written (during the first write: " + JSON.stringify(during) + ")");
  const said = await ev(`window.__said`);
  check(said.lastIndexOf("Saving…") >= 0 && said.indexOf("Saved") > said.lastIndexOf("Saving…"), "…and not between the writes: " + JSON.stringify(said));
  await ev(`(() => { window.__saidObs.disconnect(); delete window.__sbCodeBeforeWrite; return 1; })()`);
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
  await sleep(300);
  check(await ev(`/weren't saved over it/.test(document.querySelector(".code-page .code-bar").textContent)`), "…the save's own refusal, said (the write refused over a revision it didn't read): " + (await ev(`document.querySelector(".code-page .code-bar").textContent`)));
  await sleep(1500);
  check(await ev(`${text("/demo.py")}`) === "theirs\n", "…their change is never written over");
  check(await ev(`[...document.querySelectorAll(".code-page .code-bar button")].map((b) => b.textContent).join("|") === "Reload (theirs)|Save mine as a copy"`), "…offering Reload (theirs) or Save mine as a copy");
  await ev(`(() => { [...document.querySelectorAll(".code-page .code-bar button")].find((b) => b.textContent === "Save mine as a copy").click(); return 1; })()`);
  check(await until(`${text("/demo (copy).py")}.then((s) => s === "mine\\n").catch(() => false)`, 10000), "…Save mine as a copy: a new file beside it, with the text from here");

  // following a change made elsewhere, in Edit with nothing unsaved: followed (the control), and an edit typed while
  // that change is read keeps the draft and stops following (astra on #773: the read's bytes were installed over it)
  check(await openCode("/demo.py"), "(the page again)");
  await ev(`${C}.setMode("edit").then(() => 1)`);
  await until(`!!document.querySelector(".code-page .code-edit textarea") && !${C}.stopped()`);
  await ev(`${W}.write("/demo.py", "external one\\n").then(() => 1)`);
  check(await until(`${TA}.value === "external one\\n" && !${C}.stopped()`, 10000), "Edit, nothing unsaved: a change made elsewhere is followed, saving still on");
  // (the read held 400 ms, the draft typed at ~150 ms: the read comes back before the draft's own save (600 ms) could
  //  stop anything, so only the recheck after the read keeps the draft)
  await ev(`(() => { let first = true; window.__sbCodeBeforeRead = () => { if (first) { first = false; return new Promise((r) => setTimeout(r, 400)); } }; return 1; })()`);
  await ev(`${W}.write("/demo.py", "external two\\n").then(() => 1)`);
  await sleep(150);
  await ev(`(() => { const t = ${TA}; t.value += "draft\\n"; t.dispatchEvent(new Event("input")); return 1; })()`);
  check(await until(`${C}.stopped() && !document.querySelector(".code-page .code-bar").hidden`, 10000), "an edit typed while a change made elsewhere is being read: following stops, the bar says so");
  await sleep(1500);
  check(await ev(`${TA}.value === "external one\\ndraft\\n"`), "…the draft kept in the editor: " + JSON.stringify(await ev(`${TA}.value`)));
  check(await ev(text("/demo.py")) === "external two\n", "…and their change kept in the file");
  await ev(`(() => { delete window.__sbCodeBeforeRead; return 1; })()`);
  // (after following a change made elsewhere, the next save is over the revision followed: not a conflict)
  check(await openCode("/follow.py"), "(a file to follow)");
  await ev(`${C}.setMode("edit").then(() => 1)`);
  await until(`!!document.querySelector(".code-page .code-edit textarea") && !${C}.stopped()`);
  await ev(`${W}.write("/follow.py", "v2 elsewhere\\n").then(() => 1)`);
  check(await until(`${TA}.value === "v2 elsewhere\\n"`, 10000), "(followed)");
  await ev(`(() => { const t = ${TA}; t.value += "mine after\\n"; t.dispatchEvent(new Event("input")); return 1; })()`);
  check(await until(`${text("/follow.py")}.then((s) => s === "v2 elsewhere\\nmine after\\n")`, 10000) && !(await ev(`${C}.stopped()`)), "after following a change made elsewhere, an edit here saves over it (not a conflict): " + JSON.stringify(await ev(text("/follow.py"))));
  // (unsaved edits here, then a change made elsewhere before they are saved: stopped, the draft kept, theirs kept)
  await ev(`(async () => { const t = ${TA}; t.value += "unsaved\\n"; t.dispatchEvent(new Event("input")); await ${W}.write("/follow.py", "v3 elsewhere\\n"); return 1; })()`);
  check(await until(`${C}.stopped() && /while you were editing it here/.test(document.querySelector(".code-page .code-bar").textContent)`, 10000), "unsaved edits, then a change made elsewhere: following stops, the bar says so");
  await sleep(1000);
  check(await ev(`${TA}.value === "v2 elsewhere\\nmine after\\nunsaved\\n"`) && (await ev(text("/follow.py"))) === "v3 elsewhere\n", "…the draft kept here, theirs in the file: " + JSON.stringify(await ev(`${TA}.value`)));
  // (renamed elsewhere: followed, its new name shown; then moved to Trash elsewhere: saving stops, said)
  check(await openCode("/follow.py"), "(the page again)");
  await ev(`${W}.rename("/follow.py", "/followed.py").then(() => 1)`);
  check(await until(`${C}.path === "/followed.py" && document.querySelector(".code-page .code-name").textContent === "followed.py"`, 10000), "renamed elsewhere: followed, the new name shown");
  await ev(`${W}.remove("/followed.py").then(() => 1)`);
  check(await until(`${C}.stopped() && /moved to Trash or deleted elsewhere/.test(document.querySelector(".code-page .code-bar").textContent)`, 10000), "moved to Trash elsewhere: saving stops, the bar says so");
  // (a change made elsewhere being read when the file is moved to Trash: the stop stands, the late read shows nothing)
  check(await openCode("/late.py"), "(a file read late)");
  await ev(`(() => { let first = true; window.__sbCodeBeforeRead = () => { if (first) { first = false; return new Promise((r) => setTimeout(r, 600)); } }; return 1; })()`);
  await ev(`${W}.write("/late.py", "v2\\n").then(() => 1)`);
  await sleep(150);
  await ev(`${W}.remove("/late.py").then(() => 1)`);
  await sleep(1500);
  check(await ev(`${C}.stopped() && /moved to Trash/.test(document.querySelector(".code-page .code-bar").textContent) && ${STATUS} === "Not saved" && document.querySelector(".code-page .code-src").textContent === "v1\\n"`), "a read that comes back after the page stopped installs nothing: " + JSON.stringify([await ev(STATUS), await ev(`document.querySelector(".code-page .code-src")?.textContent`)]));
  await ev(`(() => { delete window.__sbCodeBeforeRead; return 1; })()`);

  // a file holding markup in plain text (one plain token): text, no element
  check(await openCode("/evil.txt"), "a .txt holding markup opens");
  check(await ev(`!document.querySelector(".code-page .code-src img, .code-page .code-src b") && document.querySelector(".code-page .code-src").textContent.startsWith("<img src=x") && window.__pwned === undefined`), "…shown as text: no element made from it, nothing run");
  // read-only: over the edit limit; can't be written back exactly
  check(await openCode("/mid.json"), "a 1.5 MB file opens");
  check(await ev(`(() => { const t = document.querySelector(".code-page .code-toggle"); return t.disabled && /over 1\.0 MB/.test(t.title) && ${C}.mode() === "view" && !${C}.editable(); })()`), "…read-only: over the 1 MB edit limit, said");
  check(await openCode("/crlf.txt"), "a file mixing line endings opens");
  check(await ev(`(() => { const t = document.querySelector(".code-page .code-toggle"); return t.disabled && /mixes line endings/.test(t.title) && !${C}.editable(); })()`), "…read-only: it couldn't be written back exactly, said");

  // MATLAB: the notebook's MATLAB colors
  check(await openCode("/fn.m"), "a .m file opens");
  check(await ev(`!!document.querySelector(".code-page .code-src .hc") && !!document.querySelector(".code-page .code-src .hs") && document.querySelector(".code-page .code-lang").textContent === "MATLAB"`), "…highlighted as MATLAB (a comment, a string)");
  // (E enters Edit, but not typed into a field; Esc in the editor leaves it)
  await ev(`(() => { const i = document.createElement("input"); i.id = "probe"; document.body.append(i); i.focus(); i.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true, cancelable: true })); return 1; })()`);
  await sleep(300);
  check(await ev(`${C}.mode() === "view"`), "E typed into a field: still View");
  await ev(`(() => { document.getElementById("probe").remove(); document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true, cancelable: true })); return 1; })()`);
  check(await until(`${C}.mode() === "edit" && !!${TA}`, 5000), "E elsewhere: Edit");
  await ev(`(() => { const t = ${TA}; t.focus(); t.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); return 1; })()`);
  check(await until(`${C}.mode() === "view"`, 5000), "Esc in the editor: View");
  // (text set in the editor with no input event, so no save is timed: leaving Edit shows it and saves it)
  await ev(`${C}.setMode("edit").then(() => 1)`);
  await until(`!!${TA}`);
  await ev(`(() => { ${TA}.value += "v = 1;\\n"; document.querySelector(".code-page .code-toggle").click(); return 1; })()`);
  check(await until(`${C}.mode() === "view" && document.querySelector(".code-page .code-src").textContent.endsWith("v = 1;\\n")`, 5000), "Edit → View: the text as typed shown");
  check(await until(`${text("/fn.m")}.then((s) => s.endsWith("v = 1;\\n"))`, 5000), "…and saved, with nothing else to save it");
  // (the page hidden with unsaved text: saved)
  await ev(`${C}.setMode("edit").then(() => 1)`);
  await until(`!!${TA}`);
  await ev(`(() => { ${TA}.value += "w = 2;\\n"; dispatchEvent(new Event("pagehide")); return 1; })()`);
  check(await until(`${text("/fn.m")}.then((s) => s.endsWith("w = 2;\\n"))`, 5000), "the page hidden with unsaved text: saved");
  // (Rename… with unsaved text: saved first, so the file renamed has it)
  await ev(`(() => { ${TA}.value += "z = 3;\\n"; return 1; })()`);
  promptText = "fn2";
  await ev(`(() => { [...document.querySelectorAll(".code-page .code-head button")].find((b) => b.textContent === "File").click(); document.querySelector(".code-page .code-filemenu [data-item=rename]").click(); return 1; })()`);
  check(await until(`${C}.path === "/fn2.m"`, 10000) && (await until(`${text("/fn2.m")}.then((s) => s.endsWith("z = 3;\\n"))`, 5000)), "Rename… with unsaved text: saved, then renamed: " + JSON.stringify((await ev(text("/fn2.m")).catch(() => "")).slice(-12)));
  // (an edit over the 1 MB limit: not saved, said; "Saved" never said for it)
  await ev(`(() => { const t = ${TA}; t.value = "%" + "x".repeat(1100000) + "\\n"; t.dispatchEvent(new Event("input")); return 1; })()`);
  check(await until(`/Not saved: over 1\.0 MB/.test(${STATUS})`, 10000), "an edit over 1 MB: not saved, said");
  await sleep(1000);
  check(await ev(`/Not saved: over/.test(${STATUS})`) && (await ev(text("/fn2.m"))).endsWith("z = 3;\n"), "…still said, the file as it was: " + JSON.stringify(await ev(STATUS)));
  await go(base);
  await until(`!!${W}`, 60000);

  // Rename… from the File menu
  promptText = "notes2";
  check(await openCode("/notes.txt"), "a .txt file opens");
  await ev(`(() => { [...document.querySelectorAll(".code-page .code-head button")].find((b) => b.textContent === "File").click(); document.querySelector(".code-page .code-filemenu [data-item=rename]").click(); return 1; })()`);
  check(await until(`${C}.path === "/notes2.txt" && document.querySelector(".code-page .code-name").textContent === "notes2.txt"`, 10000), "File ▸ Rename…: the file renamed, its new name shown");

  // too large; a missing id
  check(await openCode("/big.json").then(() => until(`/too large to open here/.test(document.querySelector(".code-page .code-note")?.textContent ?? "")`, 10000)), "a file over 4 MB: said, with Download from Files");
  await go(base + "?code=nosuchfid000");
  check(await until(`/isn't here any more/.test(document.querySelector(".code-page .code-note")?.textContent ?? "")`, 30000), "an id no file has: said");

  // (a change made elsewhere that leaves the file unable to be written back exactly: the page follows it, read-only,
  // saying why: this file's why, not the one it opened with; grader's P2)
  await ev(`${W}.create("/p2.py", { content: "v1\\n" }).then(() => 1)`);
  check(await openCode("/p2.py"), "(a file to follow into read-only)");
  await ev(`${C}.setMode("edit").then(() => 1)`);
  await until(`!!${TA} && ${C}.editable()`);
  await ev(`${W}.write("/p2.py", "a\\r\\nb\\n").then(() => 1)`);
  check(await until(`${C}.mode() === "view" && !${C}.editable() && document.querySelector(".code-page .code-toggle").disabled && /mixes line endings/.test(document.querySelector(".code-page .code-toggle").title)`, 10000), "a change elsewhere it can't write back exactly: followed, read-only, saying why: " + JSON.stringify(await ev(`document.querySelector(".code-page .code-toggle")?.title`)));
  // (a page mounted over another: the other's is disposed, its watcher gone: a rename of its file elsewhere names
  // nothing, a change to it reads nothing; grader's C18. The page module itself, over an in-memory workspace of two
  // files, as boot.ts mounts it)
  await go(base);
  await until(`!!${W}`, 60000);
  // (the host page's own first document opened, its title set, before the code pages are mounted: the notebook page
  // opens it (a first visit's Welcome) after the workspace is ready and sets document.title then, so a mount before it
  // has its title overwritten: master 733522e0's red, run 42511787585.  Its <title> before then doesn't end so)
  check(await until(`/ (—|·) Sagebrush$/.test(document.title)`, 60000), "(the host page's first document open, its title set: " + JSON.stringify(await ev("document.title")) + ")");
  const c18 = await ev(`(async () => {
    const m = await import("/sagebrush-code.js");
    const files = { a: { path: "/c18a.py", text: "a\\n", rev: 1 }, b: { path: "/c18b.py", text: "b\\n", rev: 1 } };
    const subs = new Set(), reads = { a: 0, b: 0 };
    const entryOf = (fid) => ({ kind: "file", fid, path: files[fid].path, rev: files[fid].rev, size: files[fid].text.length });
    const ws = {
      pathOfFile: async (fid) => (files[fid] ? { ok: true, path: files[fid].path, entry: entryOf(fid) } : { ok: false, why: "none" }),
      readUpTo: async (path) => { const fid = Object.keys(files).find((k) => files[k].path === path); reads[fid]++; return { content: new TextEncoder().encode(files[fid].text), entry: entryOf(fid) }; },
      watch: (cb) => { subs.add(cb); return () => subs.delete(cb); },
      list: async () => [],
    };
    const host = (fid) => ({ ws, fid, open() {}, openFiles() {}, examples: async () => false, renderFileMenu() {} });
    const root = document.createElement("div"); document.body.append(root);
    await m.mount(root, host("a"));
    await m.mount(root, host("b"));
    const before = { subs: subs.size, readsA: reads.a };
    files.a.path = "/c18a-moved.py"; files.a.rev = 2; files.a.text = "a changed\\n";
    for (const cb of [...subs]) cb({ ops: [{ op: "rename", fid: "a", path: "/c18a.py", to: "/c18a-moved.py" }, { op: "write", fid: "a", path: "/c18a-moved.py" }] });
    await new Promise((r) => setTimeout(r, 800));
    const out = { subs: before.subs, readsA: reads.a - before.readsA, title: document.title, shown: window.sagebrush?.code?.path };
    window.sagebrush?.code && root.remove();
    return out;
  })()`);
  check(c18.subs === 1 && c18.readsA === 0 && c18.title.startsWith("c18b.py") && c18.shown === "/c18b.py", "a page mounted over another: the other's watcher is gone; its file renamed and changed elsewhere, the title stays the shown one's and nothing of it is read: " + JSON.stringify(c18));
  // (a middle-click on a code file in Trash opens nothing, as a click there; grader's B5c)
  await ev(`(async () => { const w = ${W}; await w.create("/trashed.py", { content: "x\\n" }); await w.remove("/trashed.py"); return 1; })()`);
  await go(base);
  await until(`!!${W} && typeof window.__sbCode === "function"`, 60000);
  await ev(`(() => { if (document.querySelector("#wssidebar")?.hidden !== false) document.querySelector("#wsfilesbtn").click(); return 1; })()`);
  await until(`[...document.querySelectorAll("#wssidebar button")].some((b) => b.textContent === "Trash")`, 20000);
  await ev(`(() => { [...document.querySelectorAll("#wssidebar button")].find((b) => b.textContent === "Trash").click(); return 1; })()`);
  check(await until(`!!document.querySelector('#wssidebar .frow[data-path="/Trash/trashed.py"]')`, 20000), "(Trash shown, the trashed .py in it)");
  const midT = await ev(`(async () => {
    const opened = [], own = window.open, before = location.href;
    window.open = (u) => { opened.push(String(u)); return null; };
    document.querySelector('#wssidebar .frow[data-path="/Trash/trashed.py"]').dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
    await new Promise((s) => setTimeout(s, 500));
    window.open = own;
    return { opened, here: location.href === before };
  })()`);
  check(midT.opened.length === 0 && midT.here, "a middle-click on a code file in Trash opens nothing: " + JSON.stringify(midT));
  await ev(`(() => { [...document.querySelectorAll("#wssidebar button")].find((b) => /All files/.test(b.textContent))?.click(); return 1; })()`);

  // an address that isn't a file's: refused, said
  await go(base + "?code=a%2Fb");
  check(await until(`[...document.querySelectorAll("body > p")].some((p) => p.textContent === "This isn't a file's address.")`, 30000) && !(await ev(`!!${C}`)), "?code= with a / in it: not a file's address, said");
  await go(base + "?code=" + "a".repeat(129));
  check(await until(`[...document.querySelectorAll("body > p")].some((p) => p.textContent === "This isn't a file's address.")`, 30000), "…nor one 129 characters long");
  // (an entry with no fid isn't the code page's: nothing opened)
  await go(base);
  await until(`!!${W} && typeof window.__sbCode === "function"`, 60000);
  check(await ev(`(() => { const opened = []; const own = window.open; window.open = (u) => { opened.push(u); return null; }; const took = window.__sbCode({ kind: "file", path: "/nofid.py" }, true); window.open = own; return took === false && opened.length === 0; })()`), "an entry with no stable id: not opened as a code file");
  // (a code file's preview: Open, to its page)
  await ev(`(() => { if (document.querySelector("#wssidebar")?.hidden !== false) document.querySelector("#wsfilesbtn").click(); return 1; })()`);
  await until(`!!document.querySelector('#wssidebar .frow[data-path="/swap.py"]')`, 20000);
  await ev(`(() => { document.querySelector('#wssidebar .frow[data-path="/swap.py"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); return 1; })()`);
  await until(`[...document.querySelectorAll(".sbfmenu button")].some((b) => b.textContent === "Preview and versions")`, 5000);
  await ev(`(() => { [...document.querySelectorAll(".sbfmenu button")].find((b) => b.textContent === "Preview and versions").click(); return 1; })()`);
  check(await until(`[...document.querySelectorAll(".sbfprev button")].some((b) => b.textContent === "Open")`, 10000), "a code file's preview: an Open button");
  await ev(`(() => { [...document.querySelectorAll(".sbfprev button")].find((b) => b.textContent === "Open").click(); return 1; })()`);
  check(await until(`/[?&]code=[\\w-]+/.test(location.search) && !!${C} && ${C}.path === "/swap.py"`, 30000), "…Open: the file's own page");
  // (another file put at the path between finding this one and reading it: not shown as this one, said)
  const seam = await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__sbCodeBeforeOpen = async (p) => { if (p !== "/swap.py" || window.__swapped) return; window.__swapped = true; const w = window.sagebrush.workspace; await w.rename("/swap.py", "/swap-moved.py"); await w.create("/swap.py", { content: "theirs\\n" }); };` });
  await go(base + "?code=" + (await ev(page("/swap.py"))));
  check(await until(`/Another file is at this path now/.test(document.querySelector(".code-page .code-note")?.textContent ?? "")`, 30000) && !(await ev(`!!${C}`)), "another file put at the path as it opens: not shown as this one, said");
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: seam.identifier });

  // the board page: Files opens a code file there too
  await go(base + "board/?new=python");
  await until(`!!window.sagebrush?.board?.snapshot() && !!${W}`, 60000);
  await ev(`(() => { const b = [...document.querySelectorAll("button")].find((x) => x.getAttribute("aria-controls") === "bdfiles" || /^Files$/.test(x.textContent?.trim() ?? "")); b?.click(); return 1; })()`);
  if (await until(`!!document.querySelector('.frow[data-path="/notes2.txt"]')`, 20000)) {
    // (the board already leaving (New board, waiting for the workspace's lock): a code file isn't opened, said, the
    // board stays: it leaves the way any open leaves it)
    const here = await ev(`location.href`), d0 = dialogs.length;
    await ev(`(() => { navigator.locks.request("sagebrush-workspace", () => new Promise((r) => (window.__release = r))); return 1; })()`);
    await sleep(300);
    await ev(`(() => { document.querySelector("[data-sbb=newboard]").click(); return 1; })()`);
    check(await until(`window.sagebrush.leaving?.() === true`, 20000), "(the board leaving for a new board, waiting for the lock)");
    await ev(`(() => { document.querySelector('.frow[data-path="/notes2.txt"]').click(); return 1; })()`);
    await sleep(800);
    check(dialogs.slice(d0).some((d) => /already going elsewhere/.test(d.message)) && (await ev(`location.href`)) === here, "a code file opened from a board already leaving: not opened, said; the board stays");
    await ev(`(() => { window.__release(); return 1; })()`);
    await sleep(3000);
    await go(base + "board/?new=python");
    await until(`!!window.sagebrush?.board?.snapshot() && !!${W}`, 60000);
    await ev(`(() => { const b = [...document.querySelectorAll("button")].find((x) => x.getAttribute("aria-controls") === "bdfiles" || /^Files$/.test(x.textContent?.trim() ?? "")); b?.click(); return 1; })()`);
    await until(`!!document.querySelector('.frow[data-path="/notes2.txt"]')`, 20000);
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
