// ci: web-sync.2 order=61 chrome
// The share page's header and its start (web/share-client/view.ts), in headless Chromium against the share API in
// Miniflare (web/share/serve-dev.mjs) and web/dist:
//   1. the byline: a share's page says "by <what its publisher typed>", as text, whatever it holds
//      (markup shows as the characters typed, and adds no element); with no byline, or an empty one, it says nothing;
//   2. nothing runs until the reader runs something: opening a share asks the interpreter nothing (the notebook's
//      interpreter starts with it, one per page, as the talks' rows pin); Stop before a run raises no error; Run all
//      runs the notebook in the one runner frame.
// (the whole path, from the Publish dialog's Author(s) field, is web/share/test-s1.mjs)
//   bun web/build.ts && node web/share/test-share-byline.mjs
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDev } from "./serve-dev.mjs";
import { devtoolsPort } from "../test-port.mjs";

const A = "55555555-bbbb-4555-8555-555555555555";
const dev = await startDev({ sitePort: 0, filesPort: 0, limits: { [A]: { tier: "dev", storage_bytes: 1e8, max_file_bytes: 1e7, private_links: false } } });
const profile = mkdtempSync(join(tmpdir(), "sb-byline-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const cdpPort = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const waiting = new Map();
// (the page's uncaught errors: a Stop before any run must raise none)
const thrown = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } if (m.method === "Runtime.exceptionThrown") thrown.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? "?"); };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } throw new Error("timeout: " + expr); };
let failures = 0, count = 0;
const ok = (c, msg) => { count++; console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
const J = JSON.stringify;
const sha = (b) => createHash("sha256").update(b).digest("hex");

// (a share, published through the API as the page publishes it; `author` as the dialog sends it, or left out)
const signed = await fetch(dev.site + "/auth/dev", { method: "POST", headers: { origin: dev.site, "content-type": "application/json" }, body: J({ token: "dev-token", account_id: A }) });
const cookie = signed.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const api = (path, method, body, type = "application/json") => fetch(dev.site + path, { method, headers: { origin: dev.site, cookie, "content-type": type }, body });
const nb = Buffer.from(J({ nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" } }, cells: [{ cell_type: "code", id: "c1", metadata: {}, execution_count: null, outputs: [], source: "print(6 * 7)" }] }));
await api("/api/share/check", "POST", J({ blobs: [{ sha256: sha(nb), size: nb.length }] }));
await api(`/api/share/blob/${sha(nb)}`, "PUT", nb, "application/octet-stream");
const publish = async (title, extra) => (await (await api("/api/share/first-upload", "POST", J({ title, license: "MIT", files: [{ path: "n.ipynb", sha256: sha(nb), size: nb.length }], attempt: randomBytes(16).toString("hex"), ...extra }))).json()).collection;
const HOSTILE = `<b>Ada</b> & <img src=x onerror="window.__pwned=1"> "Alan"`;
const ids = { hostile: await publish("Hostile byline", { author: HOSTILE }), empty: await publish("Empty byline", { author: "   " }), none: await publish("No byline", {}) };

const open = async (id) => {
  await send("Page.navigate", { url: `${dev.site}/s/${id}` });
  await sleep(300);
  await until("!!window.shared && !!document.querySelector('#nb .cell')", 60000);
};
const header = () => ev("({ by: [...document.querySelectorAll('#meta .by')].map((e) => e.textContent), meta: document.querySelector('#meta').textContent, elements: document.querySelectorAll('#meta *').length, spans: document.querySelectorAll('#meta > span').length, pwned: !!window.__pwned, b: !!document.querySelector('#meta b, #meta img, header b, header img') })");
try {
  await send("Page.enable");
  await send("Runtime.enable");
  ok(signed.status === 200 && Object.values(ids).every((x) => /^[a-z2-7]{12}$/.test(x ?? "")), "(three shares published: " + J(ids) + ")");

  // ---- 1. the byline, as text
  await open(ids.hostile);
  await sleep(300);
  const h = await header();
  ok(J(h.by) === J([`by ${HOSTILE}`]), "the byline shows as the characters typed, markup and all: " + J(h.by));
  ok(!h.b && !h.pwned, "...adding no element and running nothing: " + J({ b: h.b, pwned: h.pwned }));
  ok(h.meta.startsWith(`by ${HOSTILE}`) && /Shared \d{4}-\d\d-\d\d/.test(h.meta) && /License: MIT/.test(h.meta), "...first in the header, before the date and the license: " + J(h.meta));
  for (const what of ["empty", "none"]) {
    await open(ids[what]);
    const x = await header();
    ok(x.by.length === 0 && !/\bby\b/.test(x.meta), `${what === "empty" ? "an empty byline" : "no byline"}: the header says no "by" at all: ` + J(x.meta));
  }

  // ---- 2. nothing runs until a run
  await open(ids.none);
  const at0 = await ev("({ frames: document.querySelectorAll('iframe[sandbox]').length, worker: !!window.shared.kernel.worker, asked: window.shared.kernel.nextId - 1, status: document.querySelector('#status').textContent })");
  ok(at0.frames <= 1 && at0.asked === 0, "opened: nothing asked of the interpreter, at most the one runner frame: " + J(at0));
  thrown.length = 0;
  await ev("(() => { document.querySelector('#stop').click(); return 1; })()");
  await sleep(500);
  const stopped = await ev("({ frames: document.querySelectorAll('iframe[sandbox]').length, worker: !!window.shared.kernel.worker })");
  ok(thrown.length === 0 && stopped.frames <= 1, "Stop before any run: no error, no second frame: " + J({ thrown, stopped }));
  await ev("(() => { document.querySelector('#runall').click(); return 1; })()");
  await until("(document.querySelector('#nb .cell .out')?.textContent ?? '').trim() === '42' && !document.querySelector('#nb .cell.running, #nb .cell.queued')", 90000).catch(() => {});
  const ran = await ev("({ out: (document.querySelector('#nb .cell .out')?.textContent ?? '').trim(), frames: [...document.querySelectorAll('iframe[sandbox]')].map((f) => f.getAttribute('sandbox')), inFrame: window.shared.kernel.worker?.frame === document.querySelector('iframe[sandbox]') && !window.shared.kernel.worker?.inner })");
  ok(ran.out === "42" && J(ran.frames) === J(["allow-scripts"]) && ran.inFrame, "Run all starts the interpreter, in the one runner frame, and runs the notebook: " + J(ran));
  ok(thrown.length === 0, "...with no uncaught error on the page: " + J(thrown));
} catch (e) {
  failures++;
  console.log("FAIL", e.message);
} finally {
  chrome.kill();
  await dev.close();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failures ? `${failures} of ${count} failed` : `all ${count} passed`);
process.exit(failures ? 1 : 0);
