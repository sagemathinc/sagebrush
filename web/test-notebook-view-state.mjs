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
  const wanted = await ev(`(() => {
    const nb = window.sagebrush.notebook, cs = nb.cells(), top = cs[6], selected = cs[9];
    nb.select(selected);
    scrollTo(0, scrollY + top.el.getBoundingClientRect().top + 37);
    return { cell: top.id, selected: selected.id };
  })()`);
  await sleep(800);
  const live = await ev(`JSON.parse(localStorage.getItem("sagebrush-view-state") ?? "{}")[${JSON.stringify("notebook:")} + ${JSON.stringify(id)}]?.v`);
  check(live?.cell === wanted.cell && live?.selected === wanted.selected && Math.abs(live.dy - 37) <= 2, "a scroll and selection are kept while the notebook stays open: " + JSON.stringify(live));

  await ev("document.querySelector('[data-f=new]').click()");
  await until(`localStorage.getItem('sagebrush-current') !== ${JSON.stringify(id)}`);
  await ev(`window.sagebrush.open(${JSON.stringify(id)})`);
  check(await until(`localStorage.getItem('sagebrush-current') === ${JSON.stringify(id)} && window.sagebrush.notebook.active?.id === ${JSON.stringify(wanted.selected)}`), "the first notebook opens again with its selected cell");
  let got = await ev(view);
  check(got.cell === wanted.cell && Math.abs(got.dy - 37) <= 2, "the top cell and its offset come back after another notebook: " + JSON.stringify(got));

  await go(base + "?nb=" + encodeURIComponent(id));
  await ready();
  check(await until(`window.sagebrush.notebook.active?.id === ${JSON.stringify(wanted.selected)}`), "a reload restores the selected cell");
  got = await ev(view);
  check(got.cell === wanted.cell && Math.abs(got.dy - 37) <= 2, "a reload restores the top cell and offset: " + JSON.stringify(got));
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
