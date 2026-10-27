// End to end in headless Chromium: share a notebook and a data file from the
// notebook page (File > Share…), open the link, and run it, against the
// share API in Miniflare (web/share/serve-dev.mjs) and web/dist.
//   bun web/build.ts && node web/share/test-share-ui.mjs
// or against a deployment with the dev sign-in (the tampering check needs
// the local database, so it is skipped):
//   SHARE_URL=https://dev.sagebrush.space DEV_AUTH_TOKEN=... node web/share/test-share-ui.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDev } from "./serve-dev.mjs";
import { devtoolsPort } from "../test-port.mjs";

const A = "11111111-1111-4111-8111-111111111111";
const REMOTE = process.env.SHARE_URL;
const dev = REMOTE
  ? { site: REMOTE.replace(/\/$/, ""), log: { files: [] }, close: async () => {} }
  : await startDev({ sitePort: 18790, filesPort: 18791, limits: { [A]: { tier: "dev", storage_bytes: 1e8, max_file_bytes: 1e7, private_links: false } } });
const TOKEN = REMOTE ? process.env.DEV_AUTH_TOKEN : "dev-token";
const profile = mkdtempSync(join(tmpdir(), "sb-share-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cdpPort = Number(process.env.CDP_PORT) || 0;
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!cdpPort) cdpPort = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const waiting = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } throw new Error("timeout: " + expr); };
let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
// (set the first cell's code and run it; its output once done)
async function runFirst(code) {
  await ev(`(() => { const c = document.querySelector('.cell'); const ta = c.querySelector('textarea'); ta.value = ${JSON.stringify(code)}; ta.dispatchEvent(new Event('input', {bubbles: true})); ta.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', shiftKey: true, bubbles: true})); })()`);
  await sleep(200);
  await until("(() => { const c = document.querySelector('.cell'); return !c.classList.contains('running') && !c.classList.contains('queued') && /\\[\\d+\\]/.test(c.querySelector('.n').textContent); })()");
  return ev("document.querySelector('.cell .out').textContent");
}

try {
  await send("Page.navigate", { url: dev.site + "/" });
  await until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000);
  await ev("document.querySelector('#filemenu [data-f=new]').click()");
  await until("document.querySelectorAll('.cell').length === 1 && !document.querySelector('.cell textarea').value");
  await runFirst("import os\nos.makedirs('data', exist_ok=True)\nopen('data/points.csv', 'w').write('x,y\\n1,2\\n3,4\\n')");
  const out = await runFirst("print(open('data/points.csv').read().strip().replace('\\n', ';'))");
  ok(out.includes("x,y;1,2;3,4"), "the notebook reads its data file: " + out.trim());
  ok((await ev("document.querySelector('#sharemenu').textContent")) === "Share…", "with sharing on, File has Share…");

  // signed out: the dialog offers sign-in, returning to this page with ?share
  await ev("document.querySelector('#sharemenu').click()");
  // (the dialog opens at once, saying it's checking the sign-in: what it offers comes after the check)
  await until("document.querySelector('#sharedlg').open && document.querySelector('#sharechecking').hidden");
  ok(await ev("!document.querySelector('#sharesignin').hidden && document.querySelector('#shareform').hidden"), "signed out: Sign in with CoCalc");
  ok((await ev("document.querySelector('#signin').getAttribute('href')")).startsWith("/auth/login?return=%2F%3Fshare"), "sign-in returns to the page with ?share");
  await ev("document.querySelector('#sharedlg').close()");
  const signed = await ev(`fetch('/auth/dev', { method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({ token: ${JSON.stringify(TOKEN)}, account_id: '${A}' }) }).then((r) => r.status)`);
  ok(signed === 200, "dev sign-in");

  await ev("document.querySelector('#sharemenu').click()");
  await until("!document.querySelector('#shareform').hidden");
  // (the rows, from metadata; the file the code opens is pre-checked once the analysis says so: share-ux-plan r2)
  await until("/^Checked /.test(document.querySelector('#sharestatus').textContent)");
  const listed = await ev("[...document.querySelectorAll('#sharelist .sharerow')].sort((a, b) => a.dataset.i - b.dataset.i).map((r) => [r.querySelector('.name').title, r.querySelector('input').checked, r.querySelector('.why').textContent])");
  ok(listed.length === 2 && listed[1][0] === "data/points.csv" && listed[1][1] === true && /cell/.test(listed[1][2]), "the dialog lists the notebook and the browser's files, the one the code opens pre-checked with why: " + JSON.stringify(listed));
  await ev("document.querySelector('#sharetitlein').value = 'Points'; document.querySelector('#shareupload').click()");
  await until("document.querySelector('#shareresult a')");
  const link = await ev("document.querySelector('#shareresult a').href");
  ok(/\/s\/[a-z2-7]{12}$/.test(link), "uploaded: " + link);
  ok(!!(await ev("(async () => (await fetch('/api/share/mine')).json())()")).collections?.length, "the collection is listed as mine");

  // the shared page: the notebook opens with its outputs; nothing runs, nothing else is fetched
  dev.log.files.length = 0;
  await send("Page.navigate", { url: link });
  await until("document.querySelector('#title').textContent === 'Points'");
  await until("document.querySelectorAll('#nb .cell').length >= 1");
  ok((await ev("[...document.querySelectorAll('#files li')].map((l) => l.firstChild.textContent).join(',')")) === "Untitled.ipynb,data/points.csv" || (await ev("document.querySelectorAll('#files li').length")) === 2, "the page lists the files");
  ok((await ev("document.querySelector('#nb .cell .out').textContent")).includes("x,y;1,2;3,4"), "the shared outputs are shown");
  ok(await ev("!!document.querySelector('#nb .cell .stale, #nb .cell.stale')"), "marked stale: computed elsewhere");
  ok(/Nothing has run yet/.test(await ev("document.querySelector('#status').textContent")), "the page says nothing has run");
  await sleep(1500);
  if (!REMOTE) ok(dev.log.files.length === 1, "only the notebook was fetched from the files domain: " + JSON.stringify(dev.log.files));

  // Run all: the data file is fetched when the code reads it
  await ev("document.querySelector('#runall').click()");
  await until("(() => { const c = document.querySelector('#nb .cell'); return /\\[\\d+\\]/.test(c.querySelector('.n').textContent) && !c.classList.contains('running') && !c.classList.contains('queued') && !document.querySelector('#nb .cell .stale, #nb .cell.stale'); })()", 60000);
  const ran = await ev("document.querySelector('#nb .cell .out').textContent");
  ok(await ev("(() => { const f = document.querySelector('iframe[sandbox]'); return !!f && f.getAttribute('sandbox') === 'allow-scripts' && /\\/runner\\/$/.test(f.src); })()"), "shared code runs in the runner (an opaque-origin sandboxed frame), never a same-origin worker");
  ok(ran.includes("x,y;1,2;3,4"), "Run all runs it here, reading the mounted file: " + ran.trim());
  if (!REMOTE) ok(dev.log.files.length === 2, "the data file was fetched when read: " + JSON.stringify(dev.log.files));

  if (!REMOTE) {
    // a file whose bytes don't match its hash is refused
    const sha = await ev("window.shared.c.manifest.files.find((f) => f.path === 'data/points.csv').sha256");
    const { key } = await dev.db.prepare("SELECT key FROM holdings WHERE sha256 = ?1").bind(sha).first();
    await dev.bucket.put(key, "x,y\n6,6\n6,6\n");
    // (bypassing this browser's cache, which keeps the good copy: the names are hashes)
    await send("Network.enable");
    await send("Network.clearBrowserCache");
    await send("Page.navigate", { url: link });
    await until("document.querySelectorAll('#nb .cell').length >= 1");
    await ev("document.querySelector('#runall').click()");
    await until("(() => { const c = document.querySelector('#nb .cell'); return !c.classList.contains('running') && !c.classList.contains('queued') && !document.querySelector('#nb .cell .stale, #nb .cell.stale'); })()", 60000);
    const bad = await ev("document.querySelector('#nb .cell .out').textContent");
    ok(/EIO/.test(bad) && /SHA-256/.test(bad) && !bad.includes("6,6"), "a file that is not the one shared is refused: " + bad.trim().split("\n").at(-1));
  }

  // deleted by its owner: gone
  const id = link.split("/s/")[1];
  const del = await ev(`fetch('/api/share/collections/${id}', { method: 'DELETE' }).then((r) => r.status)`);
  ok(del === 200, "the owner deletes it");
  await send("Page.navigate", { url: link });
  await until("document.querySelector('#title').textContent === 'Not found'");
  ok(/deleted/.test(await ev("document.querySelector('#status').textContent")), "its link says so");
} catch (e) {
  failures++;
  console.log("FAIL", e.message);
  console.log("  page:", await ev("location.href + ' | ' + (document.querySelector('#status')?.textContent ?? '') + ' | ' + document.querySelector('#nb')?.innerHTML.slice(0, 300)").catch((x) => x.message));
} finally {
  chrome.kill();
  await dev.close();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
