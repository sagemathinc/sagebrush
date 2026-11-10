// ci: web-browser/notebook order=105
// The notebook's adoption of workspace/view-state.ts: the top cell and its
// offset, plus the selected cell, come back after another notebook and after
// a reload; a scroll is kept while the page is still open.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "./test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const profile = mkdtempSync(join(tmpdir(), "sb-nb-view-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let port = Number(process.env.CDP_PORT) || 0;
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1200,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!port) port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const waiting = new Map(), errors = [], fails = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result?.value; };
const until = async (expr, ms = 30000) => { const at = Date.now(); while (Date.now() - at < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(50); } return false; };
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };
const ready = () => until("window.sagebrush?.notebook?.cells().length && document.querySelector('#status')?.textContent.startsWith('ready')", 60000);
const go = async (url) => { await ev("window.__old = true").catch(() => {}); await send("Page.navigate", { url }); return until("!window.__old && window.sagebrush?.notebook?.cells().length", 60000); };
const kept = (id) => `JSON.parse(localStorage.getItem("sagebrush-view-state") ?? "{}")["notebook:" + ${JSON.stringify(id)}]?.v`;
const view = `(() => {
  const cs = window.sagebrush.notebook.cells(), a = window.sagebrush.notebook.active;
  const top = cs.find((c) => c.el.getBoundingClientRect().bottom > 0) ?? cs.at(-1);
  return { cell: top.id, dy: Math.round(-top.el.getBoundingClientRect().top), selected: a?.id ?? null };
})()`;

try {
  await send("Runtime.enable");
  await go(base);
  await ready();
  await ev("document.querySelector('[data-f=new]').click()");
  await until("document.querySelector('#nbname')?.value === 'Untitled'");
  const id = await ev("localStorage.getItem('sagebrush-current')");
  // Twelve tall cells make a real scroll range.  Their ids stay with the
  // document, so both the scroll anchor and selection can be checked.
  await ev(`(async () => {
    const nb = window.sagebrush.notebook, first = nb.cells()[0];
    nb.setInput(first, Array(12).fill("first").join("\\n"));
    await nb.applyEdits({ insert: Array.from({ length: 11 }, (_, i) => ({ code: Array(12).fill("cell " + (i + 2)).join("\\n") })) });
    await nb.saved();
    return 1;
  })()`);
  // A scroll on its own must save.  In particular, the active-cell event is
  // not allowed to cover for a missing scroll listener.
  const scrolled = await ev(`(() => {
    const nb = window.sagebrush.notebook, cs = nb.cells(), top = cs[6];
    scrollTo(0, scrollY + top.el.getBoundingClientRect().top + 37);
    return { cell: top.id, selected: nb.active?.id ?? null };
  })()`);
  await sleep(800);
  let live = await ev(kept(id));
  check(live?.cell === scrolled.cell && (live?.selected ?? null) === scrolled.selected && Math.abs(live.dy - 37) <= 2, "a scroll alone is kept while the notebook stays open: " + JSON.stringify(live));

  // Likewise, an active-cell change on its own must save without borrowing a
  // scroll event.  A pointerdown is the notebook's direct active-cell path;
  // unlike select(), it does not call scrollIntoView.
  await ev("window.sagebrush.notebook.cells()[7].el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))");
  await sleep(800);
  const wanted = await ev(`(() => {
    const nb = window.sagebrush.notebook, selected = nb.cells()[8], y = scrollY;
    selected.el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    const top = nb.cells().find((c) => c.el.getBoundingClientRect().bottom > 0) ?? nb.cells().at(-1);
    return { cell: top.id, dy: -top.el.getBoundingClientRect().top, selected: selected.id, y };
  })()`);
  await sleep(800);
  live = await ev(kept(id));
  const afterSelectionY = await ev("scrollY");
  check(live?.cell === wanted.cell && live?.selected === wanted.selected && Math.abs(live.dy - wanted.dy) <= 2 && Math.abs(afterSelectionY - wanted.y) <= 1, "a selection alone is kept without moving the view: " + JSON.stringify({ kept: live, wanted, afterSelectionY }));

  await ev("document.querySelector('[data-f=new]').click()");
  await until(`localStorage.getItem('sagebrush-current') !== ${JSON.stringify(id)}`);
  const other = await ev("localStorage.getItem('sagebrush-current')");
  const firstBefore = JSON.stringify(await ev(kept(id)));
  await go(base + "?nb=" + encodeURIComponent(other));
  await ready();
  const firstAfter = JSON.stringify(await ev(kept(id)));
  check(firstAfter === firstBefore, "reloading notebook B does not let its view overwrite notebook A: " + firstAfter);
  await ev(`window.sagebrush.open(${JSON.stringify(id)})`);
  check(await until(`localStorage.getItem('sagebrush-current') === ${JSON.stringify(id)} && window.sagebrush.notebook.active?.id === ${JSON.stringify(wanted.selected)}`), "the first notebook opens again with its selected cell");
  let got = await ev(view);
  check(got.cell === wanted.cell && Math.abs(got.dy - wanted.dy) <= 2, "the top cell and its offset come back after another notebook: " + JSON.stringify(got));

  await go(base + "?nb=" + encodeURIComponent(id));
  await ready();
  check(await until(`window.sagebrush.notebook.active?.id === ${JSON.stringify(wanted.selected)}`), "a reload restores the selected cell");
  got = await ev(view);
  check(got.cell === wanted.cell && Math.abs(got.dy - wanted.dy) <= 2, "a reload restores the top cell and offset: " + JSON.stringify(got));

  // If another writer removed the anchor cell, the saved fraction is the
  // fallback.  It is bounded before it is turned back into a scroll offset.
  await ev(`(async () => { const nb = window.sagebrush.notebook; await nb.applyEdits({ remove: [${JSON.stringify(wanted.cell)}] }); await nb.saved(); return 1; })()`);
  const selected = await ev("window.sagebrush.notebook.active?.id");
  const seed = (frac) => ev(`(() => {
    const all = JSON.parse(localStorage.getItem("sagebrush-view-state") ?? "{}");
    all["notebook:" + ${JSON.stringify(id)}] = { t: Date.now(), v: { cell: ${JSON.stringify(wanted.cell)}, dy: 37, frac: ${frac}, selected: ${JSON.stringify(selected)} } };
    localStorage.setItem("sagebrush-view-state", JSON.stringify(all));
    return 1;
  })()`);
  await ev(`window.sagebrush.open(${JSON.stringify(other)})`);
  await until(`localStorage.getItem('sagebrush-current') === ${JSON.stringify(other)}`);
  await seed("0.4");
  await ev(`window.sagebrush.open(${JSON.stringify(id)})`);
  await until(`localStorage.getItem('sagebrush-current') === ${JSON.stringify(id)}`);
  let fraction = await ev("scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight)");
  check(Math.abs(fraction - 0.4) <= 0.02, "a deleted top cell falls back to the kept scroll fraction: " + fraction);
  await ev(`window.sagebrush.open(${JSON.stringify(other)})`);
  await until(`localStorage.getItem('sagebrush-current') === ${JSON.stringify(other)}`);
  await seed("2");
  await ev(`window.sagebrush.open(${JSON.stringify(id)})`);
  await until(`localStorage.getItem('sagebrush-current') === ${JSON.stringify(id)}`);
  const bottom = await ev("({ y: scrollY, max: Math.max(0, document.documentElement.scrollHeight - innerHeight) })");
  check(Math.abs(bottom.y - bottom.max) <= 2, "an out-of-range kept fraction is clamped to the bottom: " + JSON.stringify(bottom));

  // Store ids have a wider domain than view-state keys.  A browser notebook
  // whose id exceeds the view-state bound may open, but it must not persist
  // its position under an attacker-sized localStorage key.
  const longId = "v".repeat(65);
  await ev(`import("/sagebrush-notebook.js").then(async (m) => {
    const db = await m.openDb(), cells = Array.from({ length: 12 }, (_, i) => ({ id: "long-cell-" + i, code: Array(12).fill("long " + i).join("\\n") }));
    await new m.IdbStore(db, ${JSON.stringify(longId)}, { name: "Long id", mode: "python", cells }).load();
    return 1;
  })`);
  await ev(`window.sagebrush.open(${JSON.stringify(longId)})`);
  await until(`localStorage.getItem('sagebrush-current') === ${JSON.stringify(longId)}`);
  await ev("scrollTo(0, document.documentElement.scrollHeight)");
  await ev("window.sagebrush.notebook.cells().at(-1).el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))");
  await sleep(800);
  const longKept = await ev(`JSON.parse(localStorage.getItem("sagebrush-view-state") ?? "{}")["notebook:" + ${JSON.stringify(longId)}]`);
  check(longKept === undefined, "a browser notebook id over 64 characters keeps no view state");

  // A local-file notebook has no workspace id, so it must never get a
  // notebook view-state key.  This also pins the browser-kind half of the
  // key admission rule independently of the id syntax.
  const localDoc = JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: Array.from({ length: 12 }, (_, i) => ({ cell_type: "code", source: Array(12).fill("local " + i).join("\n"), metadata: {}, outputs: [], execution_count: null })) });
  const localScript = await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__SAGEBRUSH_LOCAL__ = { path: "view-state.ipynb", name: "view-state.ipynb" };` });
  await send("Fetch.enable", { patterns: [{ urlPattern: "*api/file*", requestStage: "Request" }] });
  const onPaused = (m) => {
    if (m.method !== "Fetch.requestPaused") return;
    const get = m.params.request.method === "GET";
    void send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: get ? "application/json" : "text/plain" }], body: Buffer.from(get ? localDoc : "").toString("base64") });
  };
  const oldMessage = ws.onmessage;
  ws.onmessage = (e) => { oldMessage(e); onPaused(JSON.parse(e.data)); };
  await go(base);
  await ready();
  await ev("scrollTo(0, document.documentElement.scrollHeight)");
  await ev("window.sagebrush.notebook.select(window.sagebrush.notebook.cells().at(-1))");
  await sleep(800);
  const localKeys = await ev(`Object.keys(JSON.parse(localStorage.getItem("sagebrush-view-state") ?? "{}")).filter((k) => k.startsWith("notebook:") && k.includes("view-state.ipynb"))`);
  check(localKeys.length === 0, "a local-file notebook keeps no workspace view state: " + JSON.stringify(localKeys));
  await send("Fetch.disable");
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: localScript.identifier });
  check(!errors.length, "no page errors: " + errors.join(" | "));
} catch (e) {
  fails.push(String(e?.stack ?? e));
} finally {
  chrome.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
