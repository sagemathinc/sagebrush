// ci: web-runner order=162 runner=bun chrome
// Where you were in a document (view-state.ts) in Chrome, on a stand-in editor (a scrolled list, two documents as
// ?doc=a and ?doc=b): the shared rows (view-state-check.mjs) every adopting editor runs, and the person winning over
// a restore that comes late (?hold: laid out only when the test says).
//   CHROME=google-chrome bun web/workspace/test-view-state-page.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";
import { checkViewKept } from "./view-state-check.mjs";

const here = new URL(".", import.meta.url).pathname;
const site = mkdtempSync(join(tmpdir(), "sb-view-state-site-"));
writeFileSync(join(site, "entry.ts"), `
import { keepView, viewToRestore } from ${JSON.stringify(join(here, "view-state.ts"))};
const q = new URLSearchParams(location.search), key = { kind: "notebook" as const, id: q.get("doc") ?? "a" };
const box = document.getElementById("box")!;
const get = viewToRestore(key, box, location.hash !== "");
const k = keepView(key, () => ({ top: box.scrollTop }));
box.addEventListener("scroll", () => k.changed());
// (laid out a little later, as an editor's content is; with ?hold, only when the test says (window.__layout))
const layout = () => {
  box.innerHTML = Array.from({ length: 400 }, (_, i) => "<div>line " + i + "</div>").join("");
  const v = get();
  if (v) box.scrollTop = Number(v.top);
  else if (location.hash) box.scrollTop = Number(location.hash.slice(1));
  (window as any).ready = true;
};
if (q.has("hold")) (window as any).__layout = layout;
else setTimeout(layout, 30);
`);
const built = await Bun.build({ entrypoints: [join(site, "entry.ts")], outdir: site, naming: "vs.js", target: "browser", format: "esm" });
if (!built.success) {
  console.error(built.logs.join("\n"));
  process.exit(1);
}
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>view state test</title><div id="box" style="height:200px;overflow:auto;font:16px/20px monospace"></div><script type="module" src="/vs.js"></script>`);
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
  const p = new URL(req.url).pathname;
  if (p === "/vs.js") return new Response(Bun.file(join(site, "vs.js")), { headers: { "content-type": "text/javascript" } });
  if (p === "/") return new Response(Bun.file(join(site, "index.html")), { headers: { "content-type": "text/html" } });
  return new Response("not found", { status: 404 });
} });
const base = `http://127.0.0.1:${server.port}/`;

let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-view-state-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); if (process.env.SHOW) console.log((ok ? "  ok   " : "  FAIL ") + what); };

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
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 2000)); return r.result?.value; };
  await send("Runtime.enable");
  // (the old document marked, so the new one is known by its absence)
  const goto = async (u) => {
    await ev("window.__old = true").catch(() => {});
    await send("Page.navigate", { url: u });
    for (let i = 0; i < 400; i++) { if (await ev("!window.__old && document.readyState !== 'loading'").catch(() => false)) return; await sleep(25); }
    throw new Error("never loaded: " + u);
  };
  for (let i = 0; i < 200 && !(await ev("document.readyState === 'complete'").catch(() => false)); i++) await sleep(25);
  const close = async () => { try { ws.close(); } catch {} await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`); await sleep(200); };
  return { ev, goto, close };
}

let code = 1;
try {
  if (!port) port = await devtoolsPort(profile);
  for (let i = 0; i < 300; i++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch {} await sleep(100); }
  const ready = "window.ready === true", read = "({ top: document.getElementById('box').scrollTop })";
  // (the person scrolls: a scroll event, as theirs is)
  const set = "(async () => { const b = document.getElementById('box'); b.scrollTop = 1234; await new Promise((r) => setTimeout(r, 50)); return { top: b.scrollTop }; })()";
  await checkViewKept(check, { name: "stand-in", open, urlOf: (d) => `${base}?doc=${d}`, docs: ["a", "b"], ready, set, read, target: { url: `${base}?doc=a&from=link#400`, view: { top: 400 } } });

  // (the person wins: their wheel before a late restore leaves the page where it is, and what they then do is kept)
  // (the page's layout held until the wheel has happened, so the order is the test's, not a timer's: a first CI run
  //  at 09:44Z failed this row on a 1.5 s timer; and the tab opened plainly, then sent to the held page)
  let t = await open(`${base}?doc=z`);
  await t.goto(`${base}?doc=a&hold=1`);
  for (let i = 0; i < 400 && !(await t.ev("typeof window.__layout === 'function'").catch(() => false)); i++) await sleep(25);
  const before = await t.ev("({ held: typeof window.__layout === 'function', ready: window.ready === true, doc: new URLSearchParams(location.search).get('doc') })");
  await t.ev("document.getElementById('box').dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 10 })), true");
  await t.ev("(window.__layout(), true)");
  for (let i = 0; i < 200 && !(await t.ev(ready).catch(() => false)); i++) await sleep(25);
  const after = await t.ev(read);
  check(before.held && !before.ready && before.doc === "a" && after.top === 0, `the person's wheel before a late restore: the page doesn't jump (top 0): ${JSON.stringify({ before, after })}`);
  await t.ev("(async () => { document.getElementById('box').scrollTop = 600; await new Promise((r) => setTimeout(r, 50)); })()");
  await t.close();
  t = await open(`${base}?doc=a`);
  for (let i = 0; i < 200 && !(await t.ev(ready).catch(() => false)); i++) await sleep(25);
  check((await t.ev(read)).top === 600, `and where they went then is kept (${(await t.ev(read)).top})`);
  // (kept in localStorage: ids and numbers only)
  const raw = await t.ev("localStorage.getItem('sagebrush-view-state')");
  const kept = JSON.parse(raw);
  check(Object.entries(kept).every(([k, e]) => /^notebook:[abz]$/.test(k) && Object.keys(e).join() === "t,v" && Number.isFinite(e.t) && Object.keys(e.v).join() === "top" && Number.isFinite(e.v.top)) && kept["notebook:a"]?.v.top === 600,
    `kept: ids and numbers only (${raw})`);
  await t.close();

  if (fails.length) console.error(`FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  "));
  else { console.log(`ok: where you were in a document, in Chrome, ${checks} checks`); code = 0; }
} finally {
  chrome.kill();
  server.stop(true);
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
  rmSync(site, { recursive: true, force: true });
}
process.exit(code);
