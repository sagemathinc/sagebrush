// ci: web-runner order=506 chrome
// Where you were in a code file (design/view-state.md r3, kind code): the first line in view kept in this browser and
// put back when the file opens again (another file and back, a reload, a new tab), and in Edit the cursor too; never
// given to another file; kept by the file's id through a rename; numbers only; an entry claiming more (an "edit" field,
// a cursor while the page opens in View, a line past the end or below 0, a cursor past the text) puts back no more
// than it may; the person's own scroll while the file loads wins, and so does a target in the address.
// The shared rows are view-state-check.mjs's; this page's are the code page's own.
//   bun web/build.ts && python3 web/serve.py 8765 &  CHROME=google-chrome node web/code/test-code-view-state.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";
import { checkViewKept } from "../workspace/view-state-check.mjs";

const site = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-code-view-"));
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

// (the page drawn, its kept view put back or not: in the same task that sets window.sagebrush.code)
const ready = `!!window.sagebrush?.code && (document.querySelector(".code-body")?.children.length ?? 0) > 0`;
const read = `(() => { const c = window.sagebrush.code, edit = c.mode() === "edit", s = edit ? document.querySelector(".code-edit textarea") : document.querySelector(".code-body"), lh = parseFloat(getComputedStyle(document.querySelector(".code-body")).lineHeight) || 19.5;
  return { mode: c.mode(), line: Math.round(s.scrollTop / lh), sel: edit ? s.selectionStart : null }; })()`;
const same = (a, b) => !!a && !!b && a.mode === b.mode && a.sel === b.sel && Math.abs(a.line - b.line) <= 1;
const until = async (t, expr, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await t.ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
const PY = (k) => Array.from({ length: 400 }, (_, i) => `x${i} = ${i} * ${k}  # line ${i + 1} of file ${k}`).join("\n") + "\n";
const KEY = "sagebrush-view-state";

let code = 1;
try {
  if (!port) port = await devtoolsPort(profile);
  for (let i = 0; i < 300; i++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch {} await sleep(100); }
  // three .py files of this browser's workspace
  let t = await open(site);
  check(await until(t, "!!window.sagebrush?.workspace", 60000), "(the workspace)");
  const fids = [];
  for (const k of [1, 2, 3]) fids.push(await t.ev(`window.sagebrush.workspace.create("/view${k}.py", { content: new TextEncoder().encode(${JSON.stringify(PY(k))}) }).then((e) => e.fid)`));
  await t.close();
  check(fids.every((f) => typeof f === "string" && f), `(three .py files: ${JSON.stringify(fids)})`);
  const urlOf = (fid) => `${site}?code=${encodeURIComponent(fid)}`;
  // View: the person scrolls to line 200
  const setView = `(async () => { const b = document.querySelector(".code-body"), lh = parseFloat(getComputedStyle(b).lineHeight) || 19.5; b.scrollTop = 200 * lh; b.dispatchEvent(new Event("scroll")); await new Promise((x) => setTimeout(x, 800)); return ${read}; })()`;
  const v = await checkViewKept(check, { name: "code (View)", open, urlOf, docs: [fids[0], fids[1]], ready, set: setView, read, same });
  check(v.mode === "view" && v.line >= 195 && v.sel === null, `code: the view set is line 200, in View (${JSON.stringify(v)})`);

  // Edit: the person opens Edit, scrolls to line 120 and puts the cursor there; the page opens in Edit again (as they
  // left it), so the cursor comes back too
  const setEdit = `(async () => { await window.sagebrush.code.setMode("edit"); const a = document.querySelector(".code-edit textarea"), lh = parseFloat(getComputedStyle(document.querySelector(".code-body")).lineHeight) || 19.5;
    a.scrollTop = 120 * lh; a.dispatchEvent(new Event("scroll")); a.setSelectionRange(5000, 5000); a.dispatchEvent(new Event("keyup")); await new Promise((x) => setTimeout(x, 800)); return ${read}; })()`;
  const e = await checkViewKept(check, { name: "code (Edit)", open, urlOf, docs: [fids[2], fids[1]], ready, set: setEdit, read, same });
  check(e.mode === "edit" && e.line >= 115 && e.sel === 5000, `code: the view set in Edit is line 120 with the cursor at 5000 (${JSON.stringify(e)})`);

  // kept as numbers only, under code:<fid>: no text, no path
  t = await open(urlOf(fids[2]));
  check(await until(t, ready), "(the Edit file again)");
  const kept = await t.ev(`JSON.parse(localStorage.getItem(${JSON.stringify(KEY)}))`);
  const ke = kept?.["code:" + fids[2]]?.v;
  check(!!ke && Object.keys(ke).sort().join() === "line,sel" && Number.isInteger(ke.line) && ke.sel === 5000 && !JSON.stringify(kept).includes("line 1 of") && !JSON.stringify(kept).includes("view3.py"), `code: kept as numbers only, under code:<fid> (${JSON.stringify(ke)})`);
  // (back to View for the rows below)
  await t.ev(`window.sagebrush.code.setMode("view").then(() => 1)`);
  await sleep(800);
  await t.close();

  // a rename keeps the file's id, so its view
  t = await open(site);
  check(await until(t, "!!window.sagebrush?.workspace", 60000), "(the workspace again)");
  await t.ev(`window.sagebrush.workspace.rename("/view1.py", "/renamed1.py").then(() => 1)`);
  await t.goto(urlOf(fids[0]));
  check(await until(t, ready), "(the renamed file)");
  let r = await t.ev(read);
  check(same(r, v) && (await t.ev(`window.sagebrush.code.path`)) === "/renamed1.py", `code: renamed, the same file (its id): where you were (${JSON.stringify(r)})`);

  // an entry claiming more than it may: an "edit" field and a cursor while the page opens in View; a line past the end;
  // a line below 0; a cursor past the text in Edit. None opens Edit, places a cursor, or goes past the top
  // (written from the site's page, not the file's: leaving the file's page keeps its real view, over the entry)
  const put = async (fid, view) => { await t.goto(site); await until(t, "!!window.sagebrush?.workspace", 60000); return t.ev(`(() => { const m = JSON.parse(localStorage.getItem(${JSON.stringify(KEY)}) ?? "{}"); m[${JSON.stringify("code:")} + ${JSON.stringify(fid)}] = { t: Date.now(), v: ${JSON.stringify(view)} }; localStorage.setItem(${JSON.stringify(KEY)}, JSON.stringify(m)); return 1; })()`); };
  await put(fids[1], { line: 30, edit: 1, sel: 3 });
  await t.goto(urlOf(fids[1]));
  check(await until(t, ready), "(an injected entry)");
  r = await t.ev(read);
  check(r.mode === "view" && r.line === 30 && r.sel === null, `code: an injected "edit" and cursor don't open Edit; only the line is put back (${JSON.stringify(r)})`);
  for (const [what, view] of [["a line past the end", { line: 99999 }], ["a line below 0", { line: -40 }]]) {
    await put(fids[1], view);
    await t.goto(urlOf(fids[1]));
    check(await until(t, ready), `(${what})`);
    r = await t.ev(read);
    check(r.line === 0, `code: ${what} opens at the top (${JSON.stringify(r)})`);
  }
  await t.close();
  t = await open(urlOf(fids[2]));
  check(await until(t, ready), "(the Edit file, for an injected cursor)");
  await t.ev(`window.sagebrush.code.setMode("edit").then(() => 1)`);
  await put(fids[2], { line: 10, sel: 10 ** 9 });
  await t.goto(urlOf(fids[2]));
  check(await until(t, ready), "(a cursor past the text)");
  r = await t.ev(read);
  check(r.mode === "edit" && r.line === 10 && r.sel !== 10 ** 9 && r.sel <= (await t.ev(`window.sagebrush.code.text().length`)), `code: a cursor past the text isn't placed; the line is put back (${JSON.stringify(r)})`);
  await t.ev(`window.sagebrush.code.setMode("view").then(() => 1)`);
  await sleep(800);
  await t.close();

  // the person wins: a scroll while the file loads (the page's own seam before its read) means nothing is put back
  await (async () => {
    const t2 = await open("about:blank");
    await t2.send("Page.enable");
    await t2.send("Page.addScriptToEvaluateOnNewDocument", { source: `globalThis.__sbCodeBeforeOpen = async () => { document.querySelector(".code-page")?.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 40 })); };` });
    await t2.goto(urlOf(fids[0]));
    check(await until(t2, ready), "(the file, scrolled while loading)");
    const r2 = await t2.ev(read);
    check(r2.line === 0, `code: the person's scroll while the file loads wins: nothing is put back (${JSON.stringify(r2)})`);
    await t2.close();
  })();

  // a target in the address wins
  t = await open("about:blank");
  await t.goto(`${urlOf(fids[0])}#top`);
  check(await until(t, ready), "(the file with #top)");
  r = await t.ev(read);
  check(r.line === 0, `code: a target in the address wins over the view kept (${JSON.stringify(r)})`);
  await t.close();
  code = fails.length ? 1 : 0;
} catch (e) {
  fails.push("threw: " + (e?.stack ?? e));
} finally {
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
console.log(fails.length ? `FAIL: ${fails.length} of ${checks}:\n  ${fails.join("\n  ")}` : `ok: the code page's kept view, ${checks} checks`);
process.exit(fails.length ? 1 : code);
