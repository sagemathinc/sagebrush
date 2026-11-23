// ci: web-runner order=481 runner=bun chrome
// The file sidebar (web/workspace/browser.ts) never draws an older list over a newer one. Its refresh reads the
// workspace's list and draws it; two refreshes at once (a change while one reads) could answer out of order, and the
// older list, answered last, was drawn: a file just made missing from the sidebar until the next change (CI's
// test-workspace-browser "the default sidebar (272 px)…: null", twice in a day). Here the sidebar itself, mounted
// on a workspace whose list() answers only when this test says: the newest answered first, then the older.
//   CHROME=google-chrome bun web/workspace/test-browser-refresh-order.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the page: the sidebar, on a workspace whose list() reads the files at once and answers when told
const out = mkdtempSync(join(tmpdir(), "sb-refresh-order-"));
const built = await Bun.build({ entrypoints: [join(here, "browser.ts")], outdir: out, naming: "browser.js", target: "browser", format: "esm" });
if (!built.success) {
  console.error(built.logs.join("\n"));
  process.exit(1);
}
writeFileSync(join(out, "index.html"), `<!doctype html><meta charset="utf-8"><title>sidebar refresh order test</title><div id="box" style="width:272px;height:600px"></div>
<script type="module">
import { mountBrowser } from "/browser.js";
const files = [], now = Date.now(), calls = [];
let watcher = null;
const entry = (p) => ({ path: p, kind: "notebook", ref: "id" + p, mode: "python", created: now, updated: now, made: "person" });
window.hold = false;
const ws = new Proxy({
  list: () => { const read = files.map(entry), c = { read: read.map((e) => e.path) }; calls.push(c);
    return window.hold ? new Promise((r) => { c.answer = () => { c.answered = true; r(read); }; }) : Promise.resolve(read); },
  watch: (f) => { watcher = f; return () => {}; },
  contentIds: async () => ({ notebook: new Set(), board: new Set() }),
  pathOf: () => null,
}, { get: (t, k) => (k in t ? t[k] : async () => null) });
window.calls = calls;
window.add = (p, told = true) => { files.push(p); if (told) watcher?.({ path: p }); };
window.rows = () => [...document.querySelectorAll(".frow[data-sel]")].map((r) => r.dataset.path);
window.b = mountBrowser(document.getElementById("box"), { ws, current: () => undefined, open: () => {} });
window.ready = true;
</script>`);
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
  const p = new URL(req.url).pathname;
  if (p === "/") return new Response(readFileSync(join(out, "index.html")), { headers: { "content-type": "text/html" } });
  if (p === "/browser.js") return new Response(readFileSync(join(out, "browser.js")), { headers: { "content-type": "text/javascript" } });
  return new Response("not found", { status: 404 });
} });

let port = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-refresh-order-chrome-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
try {
  if (!port) port = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.some((x) => x.type === "page")) break; } catch {} await sleep(100); }
  const ws = new WebSocket(targets.find((x) => x.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const waiting = new Map(), errors = [];
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
  };
  await send("Runtime.enable");
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r?.result?.value; };
  const until = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await sleep(100); } return false; };
  // (answer every waiting list call, the newest first, until none waits: an older one answered after a newer one)
  const answerAll = async () => {
    for (let quiet = 0; quiet < 3; ) {
      const open = await ev("calls.flatMap((c, i) => (c.answer && !c.answered ? [i] : []))");
      if (!open.length) { quiet++; await sleep(200); continue; }
      quiet = 0;
      for (const i of open.reverse()) { await ev(`(calls[${i}].answer(), 1)`); await sleep(150); }
    }
  };
  await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
  await until(() => ev("window.ready === true").catch(() => false), 30000);
  await sleep(300);

  // two files made while a refresh reads: the sidebar ends with both, whatever order the lists answer in
  const from = await ev("calls.length");
  await ev("(hold = true, add('/x.ipynb'), 1)");
  await until(() => ev(`calls.length > ${from}`));
  await ev("(add('/y.ipynb'), 1)");
  await sleep(400); // (the watch's 150 ms, and a refresh asked for)
  await answerAll();
  const read = (await ev("calls.map((c) => c.read)")).slice(from);
  check(read.some((r) => r.length === 1) && read.some((r) => r.length === 2), "the control: one list read before y was made, one after: " + JSON.stringify(read));
  check(JSON.stringify(await ev("rows()")) === JSON.stringify(["/x.ipynb", "/y.ipynb"]), "after every list answered, the newest last or not, the sidebar shows both files: " + JSON.stringify({ rows: await ev("rows()"), read }));

  // a caller's refresh while another runs: its promise ends with what was there at its call drawn
  await ev("(window.p1 = b.refresh(), 1)");
  await ev("(add('/z.ipynb', false), window.p2 = b.refresh().then(() => rows()), 1)");
  const answering = answerAll();
  const atP2 = await ev("p2");
  await answering;
  check(atP2.includes("/z.ipynb"), "a refresh asked for while another reads: when it ends, the file made before it is shown: " + JSON.stringify(atP2));
  check(JSON.stringify(await ev("rows()")) === JSON.stringify(["/x.ipynb", "/y.ipynb", "/z.ipynb"]), "…and stays shown: " + JSON.stringify(await ev("rows()")));
  for (const e of errors) fails.push("page error: " + e);
  ws.close();
} catch (e) {
  fails.push("threw: " + (e?.stack ?? e));
} finally {
  chrome.kill();
  server.stop(true);
  await sleep(200);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(out, { recursive: true, force: true });
}
if (fails.length) {
  console.error(`FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`ok: the sidebar never draws an older list over a newer one, ${checks} checks`);
process.exit(0);
