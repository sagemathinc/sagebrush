// ci: web-browser/board-a order=65
// Download as HTML from the desktop app, and what a file says when its code can't run (export.ts, engine.ts), in
// headless Chromium.  The app serves its page from http://127.0.0.1:<a port>/, which a downloaded file can't reach once
// the app has quit, so a file made in the app names the public site's engine (https://sagebrush.space/, by its id);
// while that site doesn't have the app's engine, the file carries it (offline mode) and the page says so.  A page
// that isn't the app names its own site, as before.  A file whose engine can't be had says why: the site can't be
// reached (in any browser's words for it), or the site doesn't have it.  Editing an exported file says, the first
// time, that the changes are kept in this browser, not in the file.  (The public site is never asked here: this
// test answers for it.)  Serve web/dist first (python3 web/serve.py 8765), then
//   node web/board/test-export-app.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), "sb-export-app-")), profile = mkdtempSync(join(tmpdir(), "sb-export-app-prof-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
process.on("exit", () => { try { chrome.kill("SIGKILL"); } catch {} });
let at = "starting Chrome";
const DEADLINE = Number(process.env.SB_TEST_DEADLINE) || 300_000;
setTimeout(() => { console.log(`FAIL\n  the test did not end within ${DEADLINE / 1000} s; it was at: ${at}`); process.exit(1); }, DEADLINE).unref();
const port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2000) })).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); let errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
};
const send = (method, params = {}, ms = 60000) => new Promise((resolve, reject) => {
  const id = ++n, timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${method}: no answer within ${ms / 1000} s, at: ${at}`)); }, ms);
  waiting.set(id, (r) => { clearTimeout(timer); resolve(r); });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expression, ms = 60000) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, ms); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
const until = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr, Math.max(1000, ms - (Date.now() - t))).catch(() => false)) return true; await sleep(100); } return false; };
let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };

// (scripts run before each page's own: the app's flag, as app/src-tauri/src/lib.rs sets it, and the public site's
// answer for the app's engine: "published" or "missing" (this test answers; the network is never asked))
let added = [];
async function before(source) { added.push((await send("Page.addScriptToEvaluateOnNewDocument", { source })).identifier); }
async function clearBefore() { for (const id of added) await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: id }); added = []; }
const publicSite = (answer) => `(() => { const f = window.fetch; window.fetch = (u, o) => { const s = String(u instanceof Request ? u.url : u); if (s.startsWith("https://sagebrush.space/")) { window.__asked = (window.__asked || []).concat(s); return Promise.resolve(new Response("{}", { status: ${answer === "published" ? 200 : 404} })); } return f(u, o); }; })();`;
const DOC = { title: "App export", nodes: [{ id: "c", title: "Sum", code: "2+3" }, { id: "t", title: "A note", text: "words" }], edges: [] };
const refOf = (html) => { const m = /id="sb-engine-ref">([^<]*)</.exec(html); return m ? JSON.parse(m[1]) : null; };
const carries = (html) => /data-sb-engine="sagebrush-engine\.wasm"/.test(html);
async function page() {
  await send("Page.navigate", { url: `${base}board/?workspace=0` });
  if (!(await until("!!window.sagebrush?.board?.snapshot", 60000))) throw new Error("the board page didn't load");
  await ev(`window.sagebrush.board.load(${JSON.stringify(DOC)}).then(() => 1)`);
  await until("window.board?.item('c')", 20000);
}
const caption = () => ev("document.querySelector('[data-sbb=say]')?.textContent ?? ''");
const file = (name, html) => { const f = join(dir, name); writeFileSync(f, html); return "file://" + f; };

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);

  // ---- the web: the file names this page's own site (as before)
  at = "the web's export";
  await page();
  const webHtml = await ev("window.sagebrush.board.exportHtml()");
  const own = refOf(webHtml);
  check(own && own.site === base && /^[0-9a-f]{20}$/.test(own.id) && !carries(webHtml), "on the web, the file names this page's site for its engine, and doesn't carry it: " + JSON.stringify(own));

  // ---- the app, its engine on the public site: the file names the public site, by the same id
  at = "the app, its engine published";
  await before("window.__SB_DESKTOP_APP__ = true;");
  await before(publicSite("published"));
  await page();
  const appHtml = await ev("window.sagebrush.board.exportHtml()");
  check(JSON.stringify(refOf(appHtml)) === JSON.stringify({ site: "https://sagebrush.space/", id: own.id }) && !carries(appHtml), "in the app, the file names https://sagebrush.space/ for its engine (its id), not the app's own page: " + JSON.stringify(refOf(appHtml)));
  check((await ev("JSON.stringify(window.__asked ?? [])")) === JSON.stringify([`https://sagebrush.space/engine/${own.id}/manifest.json`]), "...having asked the public site for that engine's manifest, and nothing else: " + await ev("JSON.stringify(window.__asked ?? [])"));
  // (a board without code: nothing asked, nothing carried)
  await ev(`window.sagebrush.board.load({ title: "No code", nodes: [{ id: "t", text: "words" }], edges: [] }).then(() => 1)`);
  await until("window.board?.item('t') && !window.board.item('c')", 20000);
  await ev("window.__asked = [], 1");
  const plain = await ev("window.sagebrush.board.exportHtml()");
  check(!carries(plain) && (await ev("(window.__asked ?? []).length")) === 0, "in the app, a board without code: nothing carried, nothing asked");

  // ---- the app, its engine not on the public site: the file carries it, and Download says so
  at = "the app, its engine missing";
  await clearBefore();
  await before("window.__SB_DESKTOP_APP__ = true;");
  await before(publicSite("missing"));
  await page();
  const carried = await ev("window.sagebrush.board.exportHtml()");
  check(carries(carried) && refOf(carried)?.site === "https://sagebrush.space/", "in the app, its engine not on the public site: the file carries it (offline mode)");
  // (through the menu: Download as HTML, offline mode left off, the download caught)
  await ev("window.__got = []; HTMLAnchorElement.prototype.click = function () { if (this.download) window.__got.push(this.download); }; 1");
  await ev("document.querySelector('[data-sbb=html]').click(), 1");
  await until("document.querySelector('[data-sbb=htmldlg]').open", 5000);
  await ev("(() => { const p = document.querySelector('[data-sbb=html-py]'); p.checked = false; document.querySelector('[data-sbb=html-go]').click(); return 1; })()");
  check(await until("window.__got.length === 1", 60000), "Download as HTML downloads the file");
  check(await until("/offline mode/.test(document.querySelector('[data-sbb=say]').textContent) && /couldn't confirm that sagebrush\\.space has its version of Sagebrush/.test(document.querySelector('[data-sbb=say]').textContent)", 10000), "...and says it carries Sagebrush, in offline mode, as the app couldn't confirm sagebrush.space has its version: " + await caption());
  await clearBefore();
  // (the public site not answering at all (offline, a blocked request): the same, carried, with the same words)
  await before("window.__SB_DESKTOP_APP__ = true;");
  await before(`(() => { const f = window.fetch; window.fetch = (u, o) => String(u instanceof Request ? u.url : u).startsWith("https://sagebrush.space/") ? Promise.reject(new TypeError("Failed to fetch")) : f(u, o); })();`);
  await page();
  check(carries(await ev("window.sagebrush.board.exportHtml()")), "in the app, the public site not answering: the file carries the engine too");
  await clearBefore();

  // ---- a file whose engine can't be had says why
  at = "the file says why its code can't run";
  // (the site doesn't have it: the public site's 404, which, as web/engines.ts answers it, a file can read)
  await before(publicSite("missing"));
  await send("Page.navigate", { url: file("missing.html", carried.replace(/<script type="application\/octet-stream" data-sb-engine="[^"]*">[^<]*<\/script>\n?/g, "")) });
  await until("window.sagebrush?.board?.snapshot().items.length > 0", 30000);
  check(await until("/can't run here/.test(document.querySelector('[data-sbb=say]').textContent) && /sagebrush\\.space, where it looks for them, doesn't have them/.test(document.querySelector('[data-sbb=say]').textContent)", 30000), "a file whose site doesn't have its engine says so, naming the site: " + await caption());
  await clearBefore();
  // (the site can't be reached: nothing listens there)
  await send("Page.navigate", { url: file("unreachable.html", webHtml.replace(JSON.stringify(own), JSON.stringify({ site: "http://127.0.0.1:9/", id: own.id }))) });
  await until("window.sagebrush?.board?.snapshot().items.length > 0", 30000);
  check(await until("/can't run here/.test(document.querySelector('[data-sbb=say]').textContent) && /127\\.0\\.0\\.1:9, which can't be reached/.test(document.querySelector('[data-sbb=say]').textContent) && /offline mode/.test(document.querySelector('[data-sbb=say]').textContent)", 30000), "a file whose site can't be reached says so, naming it, and how to carry the engine: " + await caption());
  check(await ev("[...document.querySelectorAll('[data-sbb=say] button')].some(b => b.textContent === 'Use the latest engine from sagebrush.space')"), "unreachable pinned engine offers an explicit public-engine recovery action");
  // Public recovery uses this test's engine server, never the public network.
  at = "explicit public engine recovery";
  await before(`(() => { const f = window.fetch; window.__publicRecovery = []; window.fetch = (u, o) => { const s = String(u instanceof Request ? u.url : u); if (s.startsWith('https://sagebrush.space/')) { window.__publicRecovery.push(s); return f(${JSON.stringify(base)} + new URL(s).pathname.slice(1), o); } return f(u, o); }; })();`);
  await send("Page.navigate", { url: file("recover.html", webHtml.replace(JSON.stringify(own), JSON.stringify({ site: "http://127.0.0.1:9/", id: own.id }))) });
  check(await until("!!document.querySelector('[data-sbb=say] button')", 30000), "recovery button appears after pinned-engine failure");
  check(await ev("window.__publicRecovery.length") === 0, "no public engine request before the reader chooses it");
  await ev("document.querySelector('[data-sbb=say] button').click(), 1");
  check(await until("window.sagebrush.board.outputs().then(os => os.some(o => o.id === 'c' && o.output.trim() === '5'))", 60000), "explicit recovery runs the original document using the checked public engine");
  check(await ev("window.__publicRecovery.some(u => u.endsWith('/engine/latest.json')) && window.__publicRecovery.some(u => u.endsWith('/manifest.json'))"), "recovery fetches latest metadata and its manifest");
  await clearBefore();
  // (in Safari's words: a network failure there is a TypeError \"Load failed\", not \"Failed to fetch\")
  await before(`(() => { window.fetch = () => Promise.reject(new TypeError("Load failed")); })();`);
  await send("Page.navigate", { url: file("safari.html", webHtml) });
  await until("window.sagebrush?.board?.snapshot().items.length > 0", 30000);
  check(await until("/can't be reached/.test(document.querySelector('[data-sbb=say]').textContent)", 30000), "...whatever the browser calls a network failure (Safari's \"Load failed\"): " + await caption());
  await clearBefore();

  // ---- editing an exported file: said once, kept in this browser, carried by a new download
  at = "editing a file";
  const editUrl = file("edit.html", webHtml);
  await send("Page.navigate", { url: editUrl });
  await until("window.sagebrush?.board?.snapshot().items.length > 0", 30000);
  await ev("document.querySelector('[data-sbb=edit]').click(), 1");
  check(await until("/kept in this browser, not in the file/.test(document.querySelector('[data-sbb=say]').textContent)", 5000), "Edit on in an exported file: it says the changes are kept in this browser, not in the file: " + await caption());
  await ev(`window.sagebrush.board.edit((d) => { d.nodes.find((x) => x.id === "t").text = "changed here"; }).then(() => 1)`);
  await sleep(800);
  await send("Page.navigate", { url: editUrl });
  await until("window.sagebrush?.board?.snapshot().items.length > 0", 30000);
  check(await ev("window.sagebrush.board.snapshot().doc.nodes.find((x) => x.id === 't').text") === "changed here", "...reopened in this browser, the change is there");
  check(/changed here/.test(await ev("window.sagebrush.board.exportHtml()")), "...and a new download carries it");
  check(!errors.length, "no page errors: " + errors.join(" | "));
} catch (e) {
  fails.push(String(e?.stack ?? e) + " (at: " + at + ")");
} finally {
  chrome.kill("SIGKILL");
  await sleep(200);
  rmSync(dir, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL " + f);
process.exit(fails.length ? 1 : 0);
