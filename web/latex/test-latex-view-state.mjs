// ci: web-browser/latex order=47 chrome
// Where you were in a .tex (design/view-state.md, the LaTeX editor's adoption, V1): the source's scroll and cursor and
// the preview's scroll kept in this browser and put back when the file opens again (another file and back, a reload,
// a new tab), never given to another file; a target in the address wins; and with the view chunk unreachable the
// editor opens as before, nothing put back and no error.
// The shared rows are view-state-check.mjs's; this page's are the LaTeX editor's own.
//   bun web/build.ts && python3 web/serve.py 8765 &  CHROME=google-chrome node web/latex/test-latex-view-state.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";
import { checkViewKept } from "../workspace/view-state-check.mjs";

const site = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-tex-view-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1200,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); console.log((ok ? "ok   " : "FAIL ") + what); };

/** A tab on `url`: evaluated in, navigated (resolved once the new document runs), closed. */
async function open(url) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const waiting = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") fails.push("page error: " + (m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails)).slice(0, 500));
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => { const r = await Promise.race([send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }), sleep(20000).then(() => ({ exceptionDetails: { text: "no answer in 20 s" } }))]); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
  await send("Runtime.enable");
  await send("Network.enable");
  const goto = async (u) => {
    await ev("window.__old = true").catch(() => {});
    await send("Page.navigate", { url: u });
    for (let i = 0; i < 600; i++) { if (await ev("!window.__old && document.readyState !== 'loading'").catch(() => false)) return; await sleep(25); }
    throw new Error("never loaded: " + u);
  };
  for (let i = 0; i < 400 && !(await ev("document.readyState === 'complete'").catch(() => false)); i++) await sleep(25);
  const close = async () => { try { ws.close(); } catch {} await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`); await sleep(300); };
  return { ev, send, goto, close };
}

// (the editor laid out and its view chunk done, the kept view put back or not: view.ts's mark)
const ready = `document.querySelector(".tex-right")?.dataset.view === "1" && document.querySelectorAll(".tex-preview .ch").length > 20`;
// (what the person sees: the source's scroll and cursor, and the preview's top group and how far into it; not the
//  preview's scrollTop, which differs for the same view as the groups out of sight are laid out or not)
const read = `(() => { const s = document.querySelector(".tex-src"), r = document.querySelector(".tex-right"), top = r.getBoundingClientRect().top;
  const gs = [...document.querySelectorAll(".tex-preview .ch:not([hidden])")], i = gs.findIndex((g) => g.getBoundingClientRect().bottom > top);
  return { src: Math.round(s.scrollTop), sel: s.selectionStart, group: i, dy: i < 0 ? 0 : Math.round(top - gs[i].getBoundingClientRect().top) }; })()`;
// (the same place, within a few pixels: a scroll put back by line and group can land a fraction of a pixel off)
const same = (a, b) => !!a && !!b && a.sel === b.sel && a.group === b.group && Math.abs(a.src - b.src) <= 4 && Math.abs(a.dy - b.dy) <= 4;
const until = async (t, expr, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await t.ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
const DOC = (k) => "\\documentclass{article}\n\\begin{document}\n" + Array.from({ length: 120 }, (_, i) => `\\section{Part ${k}.${i}}\nWords of paragraph ${i} in document ${k}, enough of them to take a line or two in the preview.\n`).join("\n") + "\\end{document}\n";

let code = 1;
try {
  if (!port) port = await devtoolsPort(profile);
  for (let i = 0; i < 300; i++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch {} await sleep(100); }
  // two .tex files of this browser's workspace
  let t = await open(site);
  check(await until(t, "!!window.sagebrush?.workspace", 60000), "(the workspace)");
  const fids = [];
  for (const k of [1, 2]) fids.push(await t.ev(`window.sagebrush.workspace.create("/view${k}.tex", { content: new TextEncoder().encode(${JSON.stringify(DOC(k))}) }).then((e) => e.fid)`));
  await t.close();
  check(fids.every((f) => typeof f === "string" && f), `(two .tex files: ${JSON.stringify(fids)})`);
  const urlOf = (fid) => `${site}?tex=${encodeURIComponent(fid)}`;
  // (the person scrolls the source down, puts the cursor there, and scrolls the preview two thirds down)
  const set = `(async () => {
    const s = document.querySelector(".tex-src"), r = document.querySelector(".tex-right");
    s.scrollTop = 1200; s.dispatchEvent(new Event("scroll")); s.setSelectionRange(2345, 2345); s.dispatchEvent(new Event("keyup"));
    r.scrollTop = (r.scrollHeight - r.clientHeight) * 2 / 3; r.dispatchEvent(new Event("scroll"));
    await new Promise((x) => setTimeout(x, 800));
    return ${read};
  })()`;
  const v = await checkViewKept(check, { name: "tex", open, urlOf, docs: fids, ready, set, read, same });
  check(v.src > 600 && v.sel === 2345 && v.group > 20, `tex: the view set is down in both panes, the cursor placed (${JSON.stringify(v)})`);

  // kept in this browser only, ids and numbers: the file's entry as the module writes it
  t = await open(urlOf(fids[0]));
  check(await until(t, ready), "(the file again)");
  const kept = await t.ev(`JSON.parse(localStorage.getItem("sagebrush-view-state"))[${JSON.stringify("tex:" + fids[0])}]?.v ?? null`);
  check(!!kept && Number.isInteger(kept.src?.line) && kept.src.sel === 2345 && Number.isInteger(kept.preview?.anchor) && Number.isFinite(kept.preview?.dy) && Number.isFinite(kept.preview?.frac) && !JSON.stringify(kept).includes("Words"), `tex: kept as numbers only, under tex:<fid> (${JSON.stringify(kept)})`);
  await t.close();

  // a target in the address wins: from a blank tab (a hash-only change of the same address loads nothing)
  t = await open("about:blank");
  await t.goto(`${urlOf(fids[0])}#top`);
  check(await until(t, ready), "(the file with #top)");
  let r = await t.ev(read);
  check(r.src === 0 && r.group === 0, `tex: a target in the address wins over the view kept (${JSON.stringify(r)})`);
  await t.close();

  // the view chunk unreachable: the editor opens and works as before, nothing put back, no error
  t = await open("about:blank");
  await t.send("Network.setBlockedURLs", { urls: ["*sagebrush-latex-view.js*"] });
  await t.goto(urlOf(fids[0]));
  const shown = await until(t, `document.querySelectorAll(".tex-preview .ch").length > 20`);
  await sleep(1500);
  r = await t.ev(read);
  const mark = await t.ev(`document.querySelector(".tex-right")?.dataset.view ?? null`);
  check(shown && mark === null && r.src === 0 && r.group === 0, `tex: without the view chunk the file opens at the top, as before (${JSON.stringify({ shown, mark, r })})`);
  await t.close();
  code = fails.length ? 1 : 0;
} catch (e) {
  fails.push("threw: " + (e?.stack ?? e));
} finally {
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
console.log(fails.length ? `FAIL: ${fails.length} of ${checks}:\n  ${fails.join("\n  ")}` : `ok: the LaTeX editor's kept view, ${checks} checks`);
process.exit(fails.length ? 1 : code);
