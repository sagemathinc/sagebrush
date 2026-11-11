// ci: web-sync.2 order=52 chrome
// A reader's own copy of a shared collection (book links B1), end to end in headless Chromium against the share API in
// Miniflare (web/share/serve-dev.mjs) and web/dist. A "Book" collection (two chapters, a data file) is uploaded by a
// signed-in author through the API, then read by a signed-out reader:
//   1. /s/<id>?f=<path> opens that chapter (a chapter's link); a ?f= that isn't one says so and opens the first;
//   2. reading and running copy nothing, and don't even fetch the copy's chunk;
//   3. the first edit makes the reader's own copy, in their files (/Book/ch1.ipynb, its data beside it), and says so;
//   4. later edits are saved to the copy; a reload opens the copy, as left;
//   5. "Back to the book's version" shows the original, whose edits aren't kept; "Open your copy" goes back;
//   6. "Open in my files" opens the copy in the notebook page, and it runs there in its own folder (#634), reading the
//      data copied beside it.
//   7. a deleted copy is forgotten: the next visit opens the book's version (grader's B11).
//   8. "Copy to my workspace" (no edit needed) makes the copy and opens it in the notebook page; the next visit's button
//      reads "Open my copy" and opens that same copy, never a second one.
//   Also in 1: a ?f= of a data file opens the first notebook, and says so (grader's B8).
//   bun web/build.ts && node web/share/test-share-copy.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDev } from "./serve-dev.mjs";
import { devtoolsPort } from "../test-port.mjs";

const A = "22222222-2222-4222-8222-222222222222";
// (ports 0: startDev's servers take the system's choice and hold it, web/share/serve-dev.mjs)
const dev = await startDev({ sitePort: 0, filesPort: 0, limits: { [A]: { tier: "dev", storage_bytes: 1e8, max_file_bytes: 1e7, private_links: false } } });
const profile = mkdtempSync(join(tmpdir(), "sb-copy-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const cdpPort = await devtoolsPort(profile);
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
const J = JSON.stringify;
const nbJson = (code) => J({ nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" } }, cells: [{ cell_type: "code", id: "c1", metadata: {}, execution_count: null, outputs: [], source: code }] });
const FILES = { "ch1.ipynb": nbJson("print(open('data/points.csv').read().strip().replace('\\n', ';'))"), "ch2.ipynb": nbJson("print('chapter two')"), "data/points.csv": "x,y\n1,2\n3,4\n" };
// (the reader's own files, from the page: the copy's chunk, as the page loads it)
const mine = (p) => `import(new URL("/sagebrush-share-copy.js", location.href).href).then((m) => m.openWorkspace()).then((w) => w.read(${J(p)})).then((r) => ({ cells: r.content.cells?.map((c) => c.code ?? c.source), bytes: r.content instanceof Uint8Array || r.content instanceof ArrayBuffer ? new TextDecoder().decode(r.content) : typeof r.content === "string" ? r.content : null }), () => null)`;
const edit = (text) => ev(`(() => { const ta = document.querySelector('#nb .cell textarea'); ta.value = ${J(text)}; ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const code = () => ev("document.querySelector('#nb .cell textarea').value");
const line = () => ev("document.querySelector('#copyline').hidden ? '' : document.querySelector('#copyline').textContent");
const copyFetched = () => ev("performance.getEntriesByType('resource').some((e) => /sagebrush-share-copy\\.js/.test(e.name))");

try {
  // ---- the author uploads the book (dev sign-in, the share API), then signs out
  await send("Page.navigate", { url: dev.site + "/" });
  await until("document.readyState === 'complete'");
  ok((await ev(`fetch('/auth/dev', { method: 'POST', headers: {'content-type': 'application/json'}, body: ${J(J({ token: "dev-token", account_id: A }))} }).then((r) => r.status)`)) === 200, "the author signs in (dev)");
  const link = await ev(`(async () => {
    const files = ${J(FILES)}, out = [];
    for (const [path, text] of Object.entries(files)) {
      const b = new TextEncoder().encode(text), sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
      const put = await fetch("/api/share/blob/" + sha, { method: "PUT", body: b });
      if (!put.ok) throw new Error("blob " + put.status + " " + await put.text());
      out.push({ path, sha256: sha, size: b.length });
    }
    const attempt = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, "0")).join("");
    const r = await fetch("/api/share/first-upload", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Book", license: "MIT", files: out, attempt }) });
    const j = await r.json(); if (!r.ok) throw new Error("upload " + r.status + " " + JSON.stringify(j));
    return new URL(j.url, location.href).href;
  })()`);
  ok(/\/s\/[a-z2-7]{12}$/.test(link), "the book is shared: " + link);
  await ev("fetch('/auth/logout', { method: 'POST' }).then((r) => r.status)");
  ok((await ev("fetch('/api/share/me').then((r) => r.status)")) === 401, "…and the author signs out: the reader has no account");

  // ---- 1. a chapter's link
  await send("Page.navigate", { url: link + "?f=ch2.ipynb" });
  await until("document.querySelector('#title').textContent === 'Book' && !!document.querySelector('#nb .cell')");
  ok((await ev("document.querySelector('#nbname').textContent")) === "ch2.ipynb" && /chapter two/.test(await code()), "?f=ch2.ipynb opens chapter 2");
  await send("Page.navigate", { url: link + "?f=nope.ipynb" });
  await until("!!document.querySelector('#nb .cell')");
  ok((await ev("document.querySelector('#nbname').textContent")) === "ch1.ipynb" && /no notebook "nope\.ipynb".*opened ch1\.ipynb instead/.test(await ev("document.querySelector('#status').textContent")), "a ?f= that isn't a notebook of it: said, and the first opened");
  // (B8: a ?f= of the collection's data file isn't a notebook either)
  await send("Page.navigate", { url: link + "?f=data/points.csv" });
  await until("!!document.querySelector('#nb .cell')");
  ok((await ev("document.querySelector('#nbname').textContent")) === "ch1.ipynb" && /no notebook "data\/points\.csv".*opened ch1\.ipynb instead/.test(await ev("document.querySelector('#status').textContent")), "?f= of a data file: said, and the first notebook opened");

  // ---- 2. reading and running copy nothing
  await send("Page.navigate", { url: link + "?f=ch1.ipynb" });
  await until("!!document.querySelector('#nb .cell')");
  await ev("document.querySelector('#runall').click()");
  await until("(() => { const c = document.querySelector('#nb .cell'); return /\\[\\d+\\]/.test(c.querySelector('.n').textContent) && !c.classList.contains('running') && !c.classList.contains('queued'); })()", 90000);
  ok((await ev("document.querySelector('#nb .cell .out').textContent")).includes("x,y;1,2;3,4"), "chapter 1 runs, reading its data file (mounted from the collection)");
  await sleep(1500);
  ok((await line()) === "" && !(await copyFetched()), "reading and running made no copy, and the copy's chunk wasn't fetched");
  ok((await ev("document.querySelector('#mine').textContent")) === "Copy to my workspace", "…and the button offers \"Copy to my workspace\"");

  // ---- 3. the first edit makes the reader's copy
  await edit("print(open('data/points.csv').read().strip().replace('\\n', ';'))\nprint('mine')");
  await until("/This is your copy/.test(document.querySelector('#copyline').textContent) && !document.querySelector('#copyline').hidden", 20000);
  ok(/kept in this browser at \/Book\/ch1\.ipynb/.test(await line()), "the first edit: \"This is your copy\", at /Book/ch1.ipynb: " + J(await line()));
  await until(`(${mine("/Book/ch1.ipynb")}).then((r) => !!r && r.cells.some((c) => /mine/.test(c)))`, 10000);
  ok(true, "…the copy holds the edit, in the reader's own files");
  const data = await ev(mine("/Book/data/points.csv"));
  ok(data?.bytes === FILES["data/points.csv"], "…and the data file is beside it, the same bytes: " + J(data?.bytes));
  ok((await ev(mine("/Book/ch2.ipynb"))) === null, "…the other chapter isn't copied (it gets its own copy when edited)");

  // ---- 4. later edits are saved; a reload opens the copy
  await edit("print('mine, second edit')");
  await until(`(${mine("/Book/ch1.ipynb")}).then((r) => !!r && r.cells.some((c) => /second edit/.test(c)))`, 10000);
  ok(true, "a later edit is saved to the copy");
  await send("Page.navigate", { url: link + "?f=ch1.ipynb" });
  await until("!!document.querySelector('#nb .cell')");
  await until("!document.querySelector('#copyline').hidden", 10000);
  ok(/second edit/.test(await code()) && /This is your copy/.test(await line()) && /as you left it/.test(await ev("document.querySelector('#status').textContent")), "a reload opens the copy, as left, and says so");
  ok((await ev("document.querySelector('#mine').textContent")) === "Open my copy", "…and the button reads \"Open my copy\"");

  // ---- 5. the book's version, and back
  await ev("[...document.querySelectorAll('#copyline button')].find((b) => /Back to the book's version/.test(b.textContent)).click()");
  await until("/This is the book's version/.test(document.querySelector('#copyline').textContent)");
  ok(!/mine/.test(await code()), "\"Back to the book's version\": the original, without the reader's edits");
  await edit("print('an edit to the book version')");
  await sleep(1500);
  const after = await ev(mine("/Book/ch1.ipynb"));
  ok(after && after.cells.some((c) => /second edit/.test(c)) && !after.cells.some((c) => /book version/.test(c)), "an edit to the book's version isn't kept, and the copy is untouched");
  await ev("[...document.querySelectorAll('#copyline button')].find((b) => /Open your copy/.test(b.textContent)).click()");
  await until("/This is your copy/.test(document.querySelector('#copyline').textContent)");
  ok(/second edit/.test(await code()), "\"Open your copy\": back to it");

  // ---- 6. the copy in the notebook page, running there with its data
  await until("!!document.querySelector('#copyline a')", 10000);
  const href = await ev("document.querySelector('#copyline a').href");
  ok(/\/\?nb=/.test(href), "\"Open in my files\": " + href);
  await send("Page.navigate", { url: href });
  await until("document.querySelector('#status')?.textContent.startsWith('ready')", 90000);
  await until("!!document.querySelector('.cell textarea')", 30000);
  ok(/second edit/.test(await ev("document.querySelector('.cell textarea').value")), "the notebook page opens the reader's copy, with their edit");
  // (and runs there in its own folder, /Book, as Jupyter runs a notebook (#634): its data, copied beside it, found by
  // the relative name the book uses)
  await ev(`(() => { const ta = document.querySelector('.cell textarea'); ta.value = ${J("import os\nprint(os.getcwd(), open('data/points.csv').read().strip().replace('\\n', ';'))")}; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })); return 1; })()`);
  // (the run waited for by its own line: the copy shows the output the reader's run in the book left, "x,y;…", until
  // this run clears it and prints)
  const ran = await until("(document.querySelector('.cell .out')?.textContent ?? '').trim() === '/Book x,y;1,2;3,4'", 90000).then(() => "/Book x,y;1,2;3,4", async () => (await ev("document.querySelector('.cell .out')?.textContent ?? ''")).trim());
  ok(ran === "/Book x,y;1,2;3,4", "…and runs there in its own folder, reading the data copied beside it: " + J(ran));

  // ---- 7. a deleted copy is forgotten (B11): the next visit opens the book's version, and the copy's place is cleared
  await send("Page.navigate", { url: link + "?f=ch1.ipynb" });
  await until("!document.querySelector('#copyline').hidden", 30000);
  ok((await ev(`import(new URL("/sagebrush-share-copy.js", location.href).href).then((m) => m.openWorkspace()).then((w) => w.remove("/Book/ch1.ipynb")).then(() => true)`)) === true, "the reader deletes their copy (it goes to Trash)");
  await send("Page.navigate", { url: link + "?f=ch1.ipynb" });
  await until("!!document.querySelector('#nb .cell') && /Nothing has run yet/.test(document.querySelector('#status').textContent)", 30000);
  ok(!/mine/.test(await code()) && (await line()) === "", "the next visit opens the book's version, with no \"your copy\" line: " + J(await line()));
  ok(!Object.keys(JSON.parse((await ev("localStorage.getItem('sagebrush-share-copies')")) ?? "{}")).some((k) => k.endsWith(":ch1.ipynb")), "…and the deleted copy is forgotten: its place is cleared");

  // ---- 8. "Copy to my workspace": a copy without an edit, opened in the notebook page; then "Open my copy"
  await send("Page.navigate", { url: link + "?f=ch2.ipynb" });
  await until("!!document.querySelector('#nb .cell') && document.querySelector('#nbname').textContent === 'ch2.ipynb'", 30000);
  ok((await ev("document.querySelector('#mine').textContent")) === "Copy to my workspace" && (await ev(mine("/Book/ch2.ipynb"))) === null, "chapter 2, never copied: \"Copy to my workspace\"");
  await ev("document.querySelector('#mine').click()");
  await until("location.pathname === '/' && /[?&]nb=/.test(location.search)", 30000);
  const ref = new URL(await ev("location.href")).searchParams.get("nb");
  await until("document.querySelector('#status')?.textContent.startsWith('ready')", 90000);
  await until("!!document.querySelector('.cell textarea')", 30000);
  ok(/chapter two/.test(await ev("document.querySelector('.cell textarea').value")), "\"Copy to my workspace\" opens the reader's copy in the notebook page: " + ref);
  const two = await ev(mine("/Book/ch2.ipynb"));
  ok(two && two.cells.some((c) => /chapter two/.test(c)), "…the copy is in the reader's files, at /Book/ch2.ipynb");
  await send("Page.navigate", { url: link + "?f=ch2.ipynb" });
  await until("!!document.querySelector('#nb .cell') && document.querySelector('#mine').textContent === 'Open my copy'", 30000);
  ok(/This is your copy/.test(await line()), "the next visit: \"Open my copy\", and the page shows the copy");
  await ev("document.querySelector('#mine').click()");
  await until("location.pathname === '/' && /[?&]nb=/.test(location.search)", 30000);
  ok(new URL(await ev("location.href")).searchParams.get("nb") === ref, "\"Open my copy\" opens that same copy");
  ok((await ev(mine("/Book/ch2 (2).ipynb"))) === null, "…and no second copy was made");
} catch (e) {
  failures++;
  console.log("FAIL", e.message);
  console.log("  page:", await ev("location.href + ' | ' + (document.querySelector('#status')?.textContent ?? '') + ' | ' + (document.querySelector('#copyline')?.textContent ?? '')").catch((x) => x.message));
} finally {
  chrome.kill();
  await dev.close();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
