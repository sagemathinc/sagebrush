// ci: web-browser/latex order=51 chrome
// The LaTeX editor's File ▸ Share… (boot.ts: the page's Share dialog for a .tex, latexBoot's `share`), in headless
// Chrome against a test build of the site, the page's Share replaced by the test's spy before the page's script runs:
//   - given a Share: the item is enabled; a click calls it once with this .tex's id and its workspace path as it is now,
//     its text read when the dialog publishes (an edit after the click is in it), and a save() that writes the editor's
//     text now, or rejects when it can't be written;
//   - none at all (null: a page without sharing, the CLI's, where a build turns the editor on there): disabled, saying
//     why (board's words);
//   - not given (a page that hasn't said): disabled, with no title, as before.
//   SAGEBRUSH_LATEX_PREVIEW=test bun web/build.ts && python3 web/serve.py 8765 &  CHROME=google-chrome node web/latex/test-latex-share-menu.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const WHY = "Sharing isn't available here: upload this file, and the files it uses, to sagebrush.space and share it there";
const site = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-tex-sharemenu-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", "--window-size=1200,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const fails = [];
let checks = 0;
const check = (ok, what, detail) => { checks++; if (!ok) fails.push(what); console.log((ok ? "ok   " : "FAIL ") + what + (ok || detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 400))); };

let code = 1, ws;
try {
  const port = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
  ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0; const waiting = new Map(), errors = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text); };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
  const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(50); } return false; };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: site });
  check(await until(`!!window.sagebrush?.workspace`, 60000), "(the workspace)");
  const fid = await ev(`window.sagebrush.workspace.create("/talks/share-me.tex", { content: new TextEncoder().encode("\\\\documentclass{article}\\n\\\\begin{document}\\nHello\\n\\\\end{document}\\n") }).then((e) => e.fid)`);
  // (the page's Share, for the next load: a spy, null, or not given)
  let script = null;
  const give = async (src) => { if (script) await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: script }); script = src ? (await send("Page.addScriptToEvaluateOnNewDocument", { source: src })).identifier : null; };
  let fid2 = null;
  const open = async () => { await send("Page.navigate", { url: site + "?tex=" + encodeURIComponent(fid2 ?? fid) }); return until(`!!document.querySelector(".tex-page .tex-filebtn") && !!document.querySelector(".tex-src") && document.querySelector(".tex-src").value.includes("Hello")`, 60000); };
  const item = () => ev(`(() => { const b = document.querySelector('.tex-filemenu [data-item="share"]'); return b ? { text: b.textContent, disabled: b.disabled, title: b.title } : null; })()`);

  // ---- given a Share: enabled; a click calls it with this .tex, its text read when published
  await give(`window.__sbTexShare = (d) => { (window.__shared ??= []).push(d); };`);
  check(await open(), "(the editor open, with a Share given)");
  const a = await item();
  check(a && a.text === "Share…" && a.disabled === false && a.title === "", "given a Share: File ▸ Share… is enabled, with no title", a);
  await ev(`document.querySelector(".tex-filebtn").click(), document.querySelector('.tex-filemenu [data-item="share"]').click(), true`);
  check(await until(`(window.__shared ?? []).length === 1`, 10000), "given a Share: a click calls it once", await ev(`(window.__shared ?? []).length`));
  const got = await ev(`(() => { const d = window.__shared[0]; return { fid: d.fid, path: d.path, data: typeof d.data }; })()`);
  check(got.fid === fid && got.path === "/talks/share-me.tex" && got.data === "function", "given a Share: with this .tex's id and its workspace path", { got, fid });
  // (an edit after the click: in the text the dialog publishes)
  await ev(`(() => { const s = document.querySelector(".tex-src"); s.value = s.value.replace("Hello", "Hello again"); s.dispatchEvent(new Event("input")); return true; })()`);
  const text = await ev(`new TextDecoder().decode(window.__shared[0].data())`);
  check(/Hello again/.test(text), "given a Share: its text is read when the dialog publishes (an edit after the click is in it)", text);
  // (save: the editor's text written now, so the dialog reads it from the workspace; refused when it isn't written)
  const saved = await ev(`window.__shared[0].save().then(() => window.sagebrush.workspace.read("/talks/share-me.tex").then((r) => (typeof r.content === "string" ? r.content : new TextDecoder().decode(r.content))), (e) => "rejected: " + e.message)`);
  check(/Hello again/.test(saved), "given a Share: save() writes the editor's text now, the edit in the saved file", saved);
  await ev(`(() => { globalThis.__sbTexSaveWrite = async () => { throw new Error("the test's failed write"); }; const s = document.querySelector(".tex-src"); s.value = s.value.replace("Hello again", "Hello thrice"); s.dispatchEvent(new Event("input")); return true; })()`);
  const refused = await ev(`window.__shared[0].save().then(() => "resolved", (e) => "rejected")`);
  const onDisk = await ev(`window.sagebrush.workspace.read("/talks/share-me.tex").then((r) => (typeof r.content === "string" ? r.content : new TextDecoder().decode(r.content)))`);
  check(refused === "rejected" && !/Hello thrice/.test(onDisk), "given a Share: save() rejects when the text can't be written (nothing claimed saved)", { refused, onDisk });
  await ev(`(delete globalThis.__sbTexSaveWrite, true)`);
  // (the .tex gone between opening the editor and the click: the menu says so, and the dialog isn't opened)
  await ev(`(window.__alerts = [], window.alert = (m) => window.__alerts.push(String(m)), true)`);
  await ev(`window.sagebrush.workspace.remove("/talks/share-me.tex").then(() => true)`);
  await ev(`document.querySelector(".tex-filebtn").click(), document.querySelector('.tex-filemenu [data-item="share"]').click(), true`);
  check(await until(`window.__alerts.length === 1`, 10000) && await ev(`window.__alerts[0] === "This file isn't here any more." && window.__shared.length === 1`), "given a Share: a .tex no longer there says so, and the dialog isn't opened", await ev(`({ alerts: window.__alerts, calls: window.__shared.length })`));

  fid2 = await ev(`window.sagebrush.workspace.create("/talks/share-me.tex", { content: new TextEncoder().encode("\\\\documentclass{article}\\n\\\\begin{document}\\nHello\\n\\\\end{document}\\n") }).then((e) => e.fid)`);
  // ---- none at all (null): disabled, saying why
  await give(`window.__sbTexShare = null;`);
  check(await open(), "(the editor open, with sharing off)");
  const b = await item();
  check(b && b.text === "Share…" && b.disabled === true && b.title === WHY, "no sharing on this page: File ▸ Share… is disabled, saying why", b);

  // ---- not given: disabled, no title, as before
  await give(null);
  check(await open(), "(the editor open, Share not given)");
  const c = await item();
  check(c && c.disabled === true && c.title === "", "Share not given: File ▸ Share… is disabled, with no title, as before", c);

  check(errors.length === 0, "no uncaught errors", errors);
  code = fails.length ? 1 : 0;
} catch (e) {
  console.log("FAIL threw", e?.stack ?? e);
  fails.push("threw");
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  await sleep(200);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
console.log(fails.length ? `FAIL: ${fails.length} of ${checks}` : `ok: the LaTeX editor's File ▸ Share…, ${checks} checks`);
process.exit(fails.length ? 1 : code);
