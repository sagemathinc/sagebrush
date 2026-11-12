// ci: web-browser/latex order=48 chrome
// Running a talk's code while presenting it (S2), in headless Chrome against the built site:
//   - a slider over a list shows the value, drawn and as it moves;
//   - S with no Run under way does nothing;
//   - while a Run is under way the count says so ("9 / 10 · running… (S stops)"), and S stops that Run;
//   - an item the Run didn't reach keeps its value from an earlier run, marked out of date, its title saying why
//     (the run was stopped; an item before it failed); a new item with no earlier value shows its chip;
//   - after a reload, the same (the results file).
//   bun web/build.ts && python3 web/serve.py 8765 &  CHROME=google-chrome node web/latex/test-latex-present-run.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";
import { KEPT } from "./engine/sagetex.mjs";

const site = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-tex-pres-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", "--window-size=1200,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const fails = [];
let checks = 0;
const check = (ok, what, detail) => { checks++; if (!ok) fails.push(what); console.log((ok ? "ok   " : "FAIL ") + what + (ok || detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 400))); };

// the talk: a sleep whose length the test sets, a value and a slider over a list, and a value after them
const DOC = (secs, two = "\\sage{3+3}", more = "") => `\\documentclass{beamer}
\\usepackage{sagetex}
\\begin{document}
\\begin{frame}[fragile]{One}
\\begin{sagesilent}
import time
time.sleep(${secs})
\\end{sagesilent}
A: \\sage{1+1}
\\end{frame}
\\begin{frame}[fragile]{Two}
B: ${two}
\\begin{sagesilent}
@interact
def f(n=slider([10, 20, 30], default=20)):
    print('n =', n)
\\end{sagesilent}
\\end{frame}
\\begin{frame}{Three}
C: \\sage{2+2}${more}
\\end{frame}
\\end{document}
`;

let code = 1, ws;
try {
  const port = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
  ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0; const waiting = new Map(), errors = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description); };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600)); return r.result?.value; };
  const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(50); } return false; };
  const key = async (k, code, vk, mods = 0) => { for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }); };
  const shiftEnter = () => key("Enter", "Enter", 13, 8);
  const status = () => ev(`document.querySelector(".tex-status")?.textContent ?? ""`);
  const ran = (ms = 120000) => until(`/^Ran /.test(document.querySelector(".tex-status")?.textContent ?? "") && document.querySelector(".tex-run")?.textContent === "Run"`, ms);
  const count = () => ev(`document.querySelector(".tex-present .tp-count")?.textContent ?? null`);
  // (a slide of the preview by its frame's title, shown: "One", "Two", "Three"; a value as KaTeX's HTML shows it)
  const slide = (t) => `Array.from(document.querySelectorAll(".tex-preview .slide")).find((s) => s.offsetParent && s.querySelector(".slide-title")?.textContent.trim() === ${JSON.stringify(t)})`;
  const kept = (t) => ev(`(() => { const s = ${slide(t)}; return Array.from(s?.querySelectorAll(".sagestale") ?? []).map((x) => [(x.querySelector(".katex-html") ?? x).textContent.trim(), x.title]); })()`);
  // (an edit as typed: the page's own input event; then its render, which says its items are out of date)
  const setText = async (t) => { await ev(`(() => { const s = document.querySelector(".tex-src"); s.value = ${JSON.stringify(t)}; s.dispatchEvent(new Event("input")); return true; })()`); return until(`document.querySelector(".tex-src").value === ${JSON.stringify(t)} && /out of date/.test(document.querySelector(".tex-status")?.textContent ?? "")`, 15000); };

  await send("Page.enable");
  await send("Page.navigate", { url: site });
  check(await until(`!!window.sagebrush?.workspace`, 60000), "(the workspace)");
  const fid = await ev(`window.sagebrush.workspace.create("/present-run.tex", { content: new TextEncoder().encode(${JSON.stringify(DOC(0))}) }).then((e) => e.fid)`);
  const openIt = async () => { await send("Page.navigate", { url: site + "?tex=" + encodeURIComponent(fid) }); return until(`!!document.querySelector(".tex-page .tex-run") && document.querySelectorAll(".tex-preview .slide").length >= 3`, 60000); };
  check(await openIt(), "(the talk open, three slides)");
  await ev(`document.querySelector(".tex-run").click(), true`);
  check(await ran(), "(the first Run)", await status());

  // a slider over a list: the value shown, drawn and as it moves (the preview's live widget)
  check(await until(`${slide("Two")}?.querySelector(".sageinteract .si-v")?.textContent === "20"`, 20000), "a slider over a list shows its value, not its position", await ev(`${slide("Two")}?.querySelector(".si-v")?.textContent ?? null`));
  await ev(`(() => { const i = ${slide("Two")}.querySelector(".sageinteract input[type=range]"); i.value = "2"; i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
  check(await until(`${slide("Two")}.querySelector(".si-v")?.textContent === "30" && /n = 30/.test(${slide("Two")}.querySelector(".si-out")?.textContent ?? "")`, 20000), "moved, it shows the new value, and its code ran with it", await ev(`[${slide("Two")}.querySelector(".si-v")?.textContent, ${slide("Two")}.querySelector(".si-out")?.textContent]`));

  // presenting: S with no Run does nothing; Shift+Enter runs, the count says so, and S stops it
  check((await setText(DOC(30))), "(the sleep made long)");
  await ev(`document.querySelector(".tex-present-btn").click(), true`);
  check(await until(`!!document.querySelector(".tex-present .tp-stage .slide")`, 15000), "(presenting)");
  await key("3", "Digit3", 51); await key("Enter", "Enter", 13);
  check(await until(`document.querySelector(".tex-present .tp-count")?.textContent === "3 / 3"`, 5000), "(at the last slide)", await count());
  await key("s", "KeyS", 83);
  await sleep(300);
  check((await count()) === "3 / 3" && (await ev(`!!document.querySelector(".tex-present")`)) && (await ev(`document.querySelector(".tex-run").textContent`)) === "Run", "S with no Run under way does nothing", await count());
  await shiftEnter();
  check(await until(`document.querySelector(".tex-present .tp-count")?.textContent === "3 / 3 · running… (S stops)"`, 15000), "while a Run is under way, the count says so", await count());
  // (S once its code runs, in the 30 s sleep: an S while it still waits for the session stops it before anything runs,
  //  and then nothing is written, the page's "Stopped before it ran")
  check(await until(`document.querySelector(".tex-run")?.textContent === "Running…"`, 30000), "(the Run's code started)");
  await sleep(1000);
  await key("s", "KeyS", 83);
  check(await until(`document.querySelector(".tex-run")?.textContent === "Run"`, 20000) && /^Ran /.test(await status()), "S stops the Run (what ran before it is written)", await status());
  check(await until(`document.querySelector(".tex-present .tp-count")?.textContent === "3 / 3"`, 5000) && (await ev(`!!document.querySelector(".tex-present")`)), "the Run stopped: the count as before, still presenting", await count());
  const stopped = await kept("Three");
  check(JSON.stringify(stopped) === JSON.stringify([["4", KEPT.stopped]]), "stopped: the value not reached kept, marked out of date, saying the run was stopped", stopped);
  check(await ev(`(() => { const s = document.querySelector(".tex-present .tp-stage .slide"); return !!s && /C:/.test(s.textContent) && !!s.querySelector(".sagestale") && !s.querySelector(".sagechip"); })()`), "on the slide presented too, no chip", await ev(`document.querySelector(".tex-present .tp-stage .slide")?.innerHTML.slice(0, 300) ?? null`));
  await key("Escape", "Escape", 27);

  // a failed item: it shows its error; the one after it keeps its value, saying why; a new item has no value to keep
  check(await setText(DOC(0, "\\sage{undefined_name}", " D: \\sage{7+7}")), "(an item made to fail, one added after)");
  await ev(`document.querySelector(".tex-run").click(), true`);
  check(await ran(), "(the Run with a failed item)", await status());
  check(/^Ran 3 of 6 SageTeX items in [\d.]+ s; 1 failed$/.test(await status()), "the status counts only what ran", await status());
  check(await ev(`/error: NameError/.test(${slide("Two")}.querySelector(".sagechip")?.textContent ?? "")`), "the failed item shows its error");
  const failed = await kept("Three");
  check(JSON.stringify(failed) === JSON.stringify([["4", KEPT.failed]]), "after a failed item: its value kept, saying an item before it failed", failed);
  check(await ev(`/Not run: an item before this one failed/.test(${slide("Three")}.querySelector(".sagechip")?.textContent ?? "")`), "a new item with no earlier value: its chip, as before");

  // a reload: the results file shows the same
  check(await openIt(), "(reloaded)");
  check(await until(`${slide("Three")}?.querySelector(".sagestale")?.title === ${JSON.stringify(KEPT.failed)}`, 20000) && JSON.stringify(await kept("Three")) === JSON.stringify(failed), "after a reload, the same: the value kept, saying why", await kept("Three"));
  check(errors.length === 0, "no page errors", errors);
  code = fails.length ? 1 : 0;
} catch (e) {
  fails.push("threw: " + (e?.stack ?? e));
  console.log("FAIL threw", e?.stack ?? e);
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
}
console.log(fails.length ? `FAIL: ${fails.length} of ${checks}` : `ok: running code while presenting, ${checks} checks`);
process.exit(code);
