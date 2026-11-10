// ci: web-runner order=140 runner=bun chrome
// Jupytext MyST notebooks in headless Chromium (plan-myst-notebooks r3):
//   CHROME=google-chrome bun web/notebook/test-myst.mjs      (after bun web/build.ts)
// A. "Open as a notebook" in a workspace of its own (real IndexedDB): a MyST .md is offered as a notebook by its
//    first 4 KiB (openableAsFile), its copy is made beside it with the .md's sha256, opened again rather than made
//    again, made anew (never over the old one) when the .md changed; a taken name is never written over; any
//    other .md isn't a notebook.
// B. The built site, served by web/serve.py with every request it gets logged (so the service worker's install
//    and precache count too), in a fresh profile: an ordinary notebook, even with MyST-looking text, and a
//    non-MyST .md (its menu, its preview) make no request for sagebrush-myst.js; a MyST notebook makes exactly one, and is drawn: its boxes numbered as the
//    book's build numbers them, its math typeset, a reference followed to its target.
// C. A book (plan-myst-notebooks-p2 r2), on the built site with a workspace holding one: which notebook gets the
//    page's book capability (Z-2) and what each reads of the book's files (Z-1, counted at IndexedDB); the page's real
//    capability called directly with every name it refuses (D2, D5; read and open); a cross-chapter reference: asked
//    first, Cancel, OK (its target focused and said), Back, reused; stale work (g1, g3, g4, g5); a chapter no longer
//    MyST refused at the click; a TOC naming an outside file; N-2 on the board page.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";
import { fromMyst } from "./myst.js";

const here = new URL(".", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
const chapter = readFileSync(join(here, "../../test/myst/09-Improving_DL.md"), "utf8");

async function browser() {
  const profile = mkdtempSync(join(tmpdir(), "sb-myst-"));
  let port = Number(process.env.CDP_PORT) || 0;
  const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--window-size=1200,900", "about:blank"], { stdio: "ignore" });
  if (!port) port = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0; const waiting = new Map(); const errors = [];
  // (a dialog (confirm) answered as `dialog.accept` says, its text kept)
  const dialog = { accept: true, seen: [] };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? "");
    if (m.method === "Page.javascriptDialogOpening") { dialog.seen.push(m.params.message); send("Page.handleJavaScriptDialog", { accept: dialog.accept }); }
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 1500)); return r.result?.value; };
  const until = async (expr, ms = 30000) => { for (let i = 0; i < ms / 100; i++) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
  await send("Runtime.enable");
  return { send, ev, until, errors, dialog, done: () => { try { ws.close(); } catch {} chrome.kill(); setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500).unref(); } };
}

// ---------------------------------------------------------------- A. Open as a notebook
{
  const site = mkdtempSync(join(tmpdir(), "sb-myst-site-"));
  const built = await Bun.build({ entrypoints: [join(here, "test-myst.page.js")], outdir: site, naming: "cases.js", target: "browser", format: "esm" });
  if (!built.success) { console.error(built.logs.join("\n")); process.exit(1); }
  writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>myst test</title><script>window.CHAPTER = ${JSON.stringify(chapter).replace(/</g, "\\u003c")};</script><script type="module">import { run } from "./cases.js"; window.run = run; window.ready = true;</script>`);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
    const p = new URL(req.url).pathname;
    if (!["/", "/cases.js"].includes(p)) return new Response("not found", { status: 404 });
    return new Response(Bun.file(join(site, p === "/" ? "index.html" : p.slice(1))), { headers: { "content-type": p.endsWith(".js") ? "text/javascript" : "text/html" } });
  } });
  const b = await browser();
  try {
    await b.send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
    ok(await b.until("window.ready === true", 20000), "A: the test page is ready");
    for (const [pass, what] of await b.ev("window.run()")) ok(pass, "A: " + what);
    for (const e of b.errors) ok(false, "A: page error: " + e);
  } catch (e) { ok(false, "A: " + (e?.stack ?? e)); }
  finally { b.done(); server.stop(true); rmSync(site, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- B. the built site
{
  const log = join(mkdtempSync(join(tmpdir(), "sb-myst-log-")), "requests.jsonl");
  writeFileSync(log, "");
  const srv = spawn("python3", [join(here, "..", "serve.py"), "0"], { env: { ...process.env, SB_SERVE_LOG: log }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((r) => { let s = ""; srv.stdout.on("data", (d) => { s += d; const m = /(\d{2,5})/.exec(s); if (m) r(+m[1]); }); });
  const asked = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((x) => /(^|\/)sagebrush-myst\.js(\?|$)/.test(x.path)).length;
  const b = await browser();
  try {
    await b.send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
    ok(await b.until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000), "B: the notebook page is ready (a fresh profile)");
    // (the service worker installed, its shell precached: what it fetched is in the server's log)
    ok(await b.until("navigator.serviceWorker.ready.then((r) => !!r.active)", 30000), "B: the service worker installed and active");
    await sleep(2000);
    // an ordinary notebook, with text that looks like MyST: drawn as ordinary Markdown, nothing fetched for MyST
    await b.ev(`sagebrush.notebook.load({ mode: "python", cells: [{ id: "m1", type: "markdown", code: ":::{note}\\nnot MyST here\\n:::\\n\\n\`\`\`{prf:theorem}\\nx\\n\`\`\`" }, { id: "c1", code: "1" }] })`);
    ok(await b.until("document.querySelectorAll('.cell.rendered').length > 0"), "B: an ordinary notebook drawn");
    await sleep(1500);
    ok(!(await b.ev("!!document.querySelector('.myst-box')")), "B: ...its MyST-looking text not drawn as MyST");
    ok(asked() === 0, `B: an ordinary notebook (fresh profile, install and precache counted): ${asked()} requests for sagebrush-myst.js (want 0)`);
    // a non-MyST .md (MyST-looking text, no jupytext front matter) in the page's workspace: its row's menu offers a
    // board, not a notebook (its head read: fileHead, openableAsFile), its preview drawn; nothing fetched for MyST
    const made = await b.ev(`window.sagebrush.workspace ? window.sagebrush.workspace.create("/notes.md", { content: new TextEncoder().encode("# Notes\\n\\n:::{note}\\nlooks like MyST, isn't\\n:::\\n") }).then(() => "made", (e) => String(e)) : "no workspace"`);
    ok(made === "made", "B: a non-MyST .md put in the page's workspace: " + made);
    await b.ev(`(document.querySelector("#filesbtn").click(), true)`);
    ok(await b.until(`!!document.querySelector('.frow[data-path="/notes.md"]')`, 20000), "B: ...listed in the file browser");
    await b.ev(`(document.querySelector('.frow[data-path="/notes.md"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })), true)`);
    ok(await b.until(`[...document.querySelectorAll(".sbfmenu [role=menuitem]")].some((x) => x.textContent === "Open as a board")`, 10000), "B: ...its menu offers it as a board");
    const items = await b.ev(`[...document.querySelectorAll(".sbfmenu [role=menuitem]")].map((x) => x.textContent)`);
    ok(!items.includes("Open as a notebook"), "B: ...not as a notebook: " + JSON.stringify(items));
    await b.ev(`([...document.querySelectorAll(".sbfmenu [role=menuitem]")].find((x) => x.textContent === "Preview and versions").click(), true)`);
    ok(await b.until(`!!document.querySelector(".sbfprev") && document.querySelector(".sbfprev").textContent.includes("looks like MyST")`, 10000), "B: ...its preview drawn");
    await sleep(1500);
    ok(asked() === 0, `B: a non-MyST .md (fresh profile; its menu, its head read, its preview): ${asked()} requests for sagebrush-myst.js (want 0)`);
    await b.ev(`(document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), document.querySelector(".sbfprev")?.remove(), true)`);
    // a MyST notebook: the asset fetched once, then drawn
    let k = 0;
    const doc = fromMyst("09-Improving_DL.md", chapter, () => `x${k++}`);
    await b.ev(`sagebrush.notebook.load(${JSON.stringify(doc)})`);
    ok(await b.until("document.querySelectorAll('.myst-box').length >= 8", 20000), "B: a MyST notebook's boxes drawn");
    const titles = await b.ev(`[...document.querySelectorAll('.myst-title')].map((t) => t.textContent.replace(/\\s+/g, " ").trim()).slice(0, 4)`);
    ok(JSON.stringify(titles) === JSON.stringify(["Algorithm 9.1 (Discrete Log for Power of Prime Order)", "Proposition 9.1 (Properties of Powers)", "Homework", "Algorithm 9.2 (Pohlig-Hellman Algorithm)"]), "B: ...numbered as the book's build: " + JSON.stringify(titles));
    ok(await b.until("!!document.querySelector('.myst-eq .katex')", 20000), "B: ...a labelled equation typeset, numbered " + (await b.ev("document.querySelector('.myst-eqno')?.textContent")));
    const got = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((x) => /sagebrush-myst\.js/.test(x.path));
    ok(got.length === 1, `B: a MyST notebook: exactly one request for sagebrush-myst.js (${got.length})`);
    ok(await b.ev(`fetch("sagebrush-myst.js", { cache: "no-store" }).then((r) => r.ok)`) && true, "B: ...which the site serves");
    // a reference followed: its target found through the index, scrolled into view
    await b.ev(`scrollTo(0, 0)`);
    const followed = await b.ev(`(async () => {
      const a = [...document.querySelectorAll('a.myst-ref')].find((x) => x.textContent === "Proposition 9.1");
      if (!a) return "no reference";
      a.click();
      await new Promise((r) => setTimeout(r, 800));
      const t = [...document.querySelectorAll('[data-myst-anchor]')].find((x) => x.querySelector?.('.myst-title')?.textContent.startsWith("Proposition 9.1"));
      if (!t) return "no target";
      const r = t.getBoundingClientRect();
      return r.top >= 0 && r.top < innerHeight ? "in view" : "out of view " + r.top;
    })()`);
    ok(followed === "in view", `B: a reference followed to its target: ${followed}`);
    for (const e of b.errors) ok(false, "B: page error: " + e);
  } catch (e) { ok(false, "B: " + (e?.stack ?? e)); }
  finally { b.done(); srv.kill(); }
}
// ---------------------------------------------------------------- C. a book (plan-myst-notebooks-p2 r2)
// The built site again, its workspace holding a book (test/myst's five chapters and _toc.yml at /book), a MyST copy
// with no book (/solo), an ordinary notebook in the book's folder, a file outside it (/elsewhere/secret.md).
// Every IndexedDB read of a file's bytes (the stores fileBytes, files, trash), of the workspace's entries, and every
// write, counted in the page (Z-1: the workspace's own layer, whatever asks).
{
  const log = join(mkdtempSync(join(tmpdir(), "sb-myst-log-")), "requests.jsonl");
  writeFileSync(log, "");
  const srv = spawn("python3", [join(here, "..", "serve.py"), "0"], { env: { ...process.env, SB_SERVE_LOG: log }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((r) => { let s = ""; srv.stdout.on("data", (d) => { s += d; const m = /(\d{2,5})/.exec(s); if (m) r(+m[1]); }); });
  const base = `http://127.0.0.1:${port}/`;
  const b = await browser();
  const C = (c, m) => ok(c, "C: " + m);
  // (a wait whose result nothing else checks: if it expires, it fails here and names what never came, so a red says
  // which wait it was rather than an assertion further on; the wait itself is unchanged)
  const wait = async (expr, ms, what) => { const r = await b.until(expr, ms); if (!r) C(false, `waited ${ms} ms, never came: ${what}`); return r; };
  try {
    await b.send("Page.enable");
    await b.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
      const io = (window.__sbIO = { content: 0, entries: 0, writes: 0, keys: [], named: [] });
      const CONTENT = new Set(["fileBytes", "files", "trash"]);
      const store = (x) => (x instanceof IDBIndex ? x.objectStore.name : x.name);
      for (const P of [IDBObjectStore.prototype, IDBIndex.prototype]) for (const f of ["get", "getAll", "getAllKeys", "openCursor", "openKeyCursor", "count", "getKey"]) {
        const g = P[f]; if (!g) continue;
        P[f] = function (...a) { const st = store(this); if (CONTENT.has(st)) { io.content++; io.keys.push(String(a[0])); } if (st === "entries") { io.entries++; io.named.push(String(a[0])); } return g.apply(this, a); };
      }
      for (const f of ["put", "add", "delete", "clear"]) { const g = IDBObjectStore.prototype[f]; IDBObjectStore.prototype[f] = function (...a) { io.writes++; if (this.name === "entries") io.named.push(f + " " + String(a[0]?.path ?? a[0])); return g.apply(this, a); }; }
    })();` });
    const W = "window.sagebrush.workspace";
    const io = () => b.ev("({ ...window.__sbIO })");
    const reset = () => b.ev("(Object.assign(window.__sbIO, { content: 0, entries: 0, writes: 0, keys: [], named: [] }), true)");
    const stat = (p) => b.ev(`${W}.stat(${JSON.stringify(p)}).then((e) => e ? { fid: e.fid ?? null, ref: e.ref ?? null, kind: e.kind } : null)`);
    const names = (f) => b.ev(`${W}.list(${JSON.stringify(f)}).then((l) => l.map((e) => e.path).sort())`);
    const title = () => b.ev("document.title");
    const loaded = (name) => wait(`document.title === ${JSON.stringify(name + " — Sagebrush")} && document.querySelectorAll('.cell').length > 0`, 60000, `the notebook ${name} loaded`);
    const go = async (q) => { await b.send("Page.navigate", { url: base + q }); };
    const openNb = async (path) => go(`?nb=${encodeURIComponent((await stat(path)).ref)}`);
    // (the file browser's row for a path, clicked: opens it in this page, as a person does)
    const row = async (path) => {
      const folder = path.slice(0, path.lastIndexOf("/")) || "/";
      if (!(await b.ev("!!document.querySelector('.frow')"))) await b.ev(`(document.querySelector("#filesbtn").click(), true)`);
      if (!(await b.until(`!!document.querySelector('.frow[data-path=${JSON.stringify(path)}]')`, 3000))) {
        await b.ev(`(document.querySelector('.frow[data-path=${JSON.stringify(folder)}]')?.click(), true)`);
        await wait(`!!document.querySelector('.frow[data-path=${JSON.stringify(path)}]')`, 10000, `the file browser's row for ${path}`);
      }
      await b.ev(`(document.querySelector('.frow[data-path=${JSON.stringify(path)}]').click(), true)`);
    };
    const bookLinks = () => b.ev("document.querySelectorAll('a.myst-ref-book').length");
    // (the page quiet: no IndexedDB read of a file's bytes for 1.5 s (an interpreter started meanwhile gives Python
    // every file of the browser's, which isn't the book's doing), before a window is measured)
    const settle = async () => { let last = -1; for (let i = 0; i < 100; i++) { const n = (await io()).content; if (n === last) return; last = n; await sleep(1500); } };
    // (reads of a book's files: of the bytes of _toc.yml and of every chapter .md, by their file ids, whatever else the
    // page reads meanwhile (an interpreter's start reads its own stores))
    let BOOKFILES = [];
    const bookReads = async () => { const k = (await io()).keys; return k.filter((x) => BOOKFILES.includes(x)).length; };

    // the workspace
    await go("");
    C(await b.until("!!window.sagebrush?.workspace && !!window.__sagebrushMystBook", 60000), "the notebook page and its workspace are ready");
    const tx = (f) => readFileSync(join(here, "../../test/myst/" + f), "utf8");
    const made = await b.ev(`(async () => {
      const w = ${W}, e = (t) => new TextEncoder().encode(t);
      for (const d of ["/book", "/solo", "/elsewhere", "/book/fold.md", "/bad"]) await w.mkdir(d);
      // (a book whose TOC names a file outside its folder, which it must never read)
      await w.create("/bad/_toc.yml", { content: e("format: jb-book\\nchapters:\\n- file: 09-Improving_DL\\n- file: /elsewhere/secret\\n") });
      await w.create("/bad/09-Improving_DL.md", { content: e(${JSON.stringify(tx("09-Improving_DL.md"))}) });
      await w.create("/book/_toc.yml", { content: e(${JSON.stringify(tx("_toc.yml"))}) });
      for (const [n, t] of ${JSON.stringify(["00-Intro", "03-Number_Theory", "07-Computing_DL", "08-CRT_Bezout", "09-Improving_DL"].map((c) => [c, tx(c + ".md")]))}) await w.create("/book/" + n + ".md", { content: e(t) });
      await w.create("/solo/09-Improving_DL.md", { content: e(${JSON.stringify(tx("09-Improving_DL.md"))}) });
      await w.create("/elsewhere/secret.md", { content: e(${JSON.stringify(tx("07-Computing_DL.md"))}) });
      await w.create("/book/plain.ipynb", { content: { name: "plain", mode: "python", cells: [{ id: "p1", code: "1" }] } });
      return "made";
    })().catch((x) => String(x))`);
    C(made === "made", "a book, a lone chapter, an ordinary notebook and an outside file put in the workspace: " + made);

    // the copies, made as "Open as a notebook" makes them (?openas, the notebook page's openAs)
    for (const p of ["/book/09-Improving_DL.md", "/solo/09-Improving_DL.md", "/bad/09-Improving_DL.md"]) {
      await go(`?openas=${encodeURIComponent(p)}&fid=${encodeURIComponent((await stat(p)).fid)}`);
      const copy = p.replace(/\.md$/, ".ipynb");
      await wait(`window.sagebrush?.workspace?.stat(${JSON.stringify(copy)}).then((e) => e?.kind === "notebook")`, 30000, `the copy ${copy} made`);
      await loaded("09-Improving_DL");
    }
    C((await stat("/book/09-Improving_DL.ipynb"))?.kind === "notebook" && (await stat("/solo/09-Improving_DL.ipynb"))?.kind === "notebook", "the two copies made beside their .md");
    for (const f of ["/book/_toc.yml", ...["00-Intro", "03-Number_Theory", "07-Computing_DL", "08-CRT_Bezout", "09-Improving_DL"].map((c) => `/book/${c}.md`), "/solo/09-Improving_DL.md", "/elsewhere/secret.md"]) BOOKFILES.push((await stat(f)).fid);

    // Z-2, Z-1: which document gets the capability, and what each one reads of the book's files, counted from the
    // switch to it (in this page, a row of the file browser clicked).  Each notebook opened once before (its
    // interpreter started: it's given every file of the browser's, for Python's open(), once, which isn't the book's
    // doing), then the switches measured
    await openNb("/book/plain.ipynb");
    await loaded("plain");
    for (const p of ["/book/09-Improving_DL.ipynb", "/solo/09-Improving_DL.ipynb", "/bad/09-Improving_DL.ipynb", "/book/plain.ipynb"]) { await row(p); await loaded(p.endsWith("plain.ipynb") ? "plain" : "09-Improving_DL"); await sleep(2500); }
    await reset();
    await row("/book/09-Improving_DL.ipynb");
    await loaded("09-Improving_DL");
    C(await b.until("document.querySelectorAll('a.myst-ref-book').length >= 6", 30000), "a MyST copy in a book: its cross-chapter references linked (" + (await bookLinks()) + ")");
    await sleep(1000);
    await sleep(500);
    const inBook = await bookReads();
    C(inBook === 6 && JSON.stringify([...new Set((await io()).keys.filter((x) => BOOKFILES.includes(x)))].length) === "6", `...the book read: exactly 1 _toc.yml + 5 chapters, each once (${inBook} reads of their bytes)`);
    C((await b.ev("window.__sagebrushMystBook().then((c) => c && c.book)")) === "/book", "...its capability: the book's folder");
    await sleep(1500);
    await reset();
    await row("/book/plain.ipynb");
    await loaded("plain");
    await sleep(1500);
    const plain = { content: await bookReads() };
    C((await b.ev("window.__sagebrushMystBook().then((c) => c === null)")) === true, "an ordinary notebook beside _toc.yml: no capability");
    C(plain.content === 0, `...no file's bytes read (${plain.content})`);
    await reset();
    await row("/solo/09-Improving_DL.ipynb");
    await loaded("09-Improving_DL");
    C(await b.until("document.querySelectorAll('.myst-box').length >= 8 && !document.querySelector('a.myst-ref-book')", 20000), "a MyST copy with no _toc.yml beside it: drawn");
    await sleep(1500);
    const solo = { content: await bookReads() };
    C((await b.ev("window.__sagebrushMystBook().then((c) => c === null)")) === true && (await bookLinks()) === 0, "...no capability, no book links");
    C(solo.content === 0, `...no file's bytes read (${solo.content})`);
    const served = readFileSync(log, "utf8");
    C(!/_toc\.yml|\.md(\?|"|$)/m.test(served), "...and no request for a TOC or a chapter, ever");

    // D2, D4, D5 at the page's real capability, called directly (the asset's reader bypassed), on read and open (a
    // confirm, if one came, answered Cancel: no switch, nothing made)
    b.dialog.accept = false;
    await openNb("/book/09-Improving_DL.ipynb");
    await loaded("09-Improving_DL");
    await wait("document.querySelectorAll('a.myst-ref-book').length >= 6", 30000, "the book's cross-chapter references linked (6)");
    const direct = await b.ev(`(async () => {
      const c = await window.__sagebrushMystBook(), out = [];
      const t = async (what, f) => { const c0 = window.__sbIO.content; let r; try { r = await f(); } catch (e) { r = { threw: String(e) }; } out.push([what, r && r.bytes ? { bytes: r.bytes.length } : r, window.__sbIO.content - c0]); };
      for (const n of ["/elsewhere/secret.md", "../elsewhere/secret.md", "a/../../elsewhere/secret.md", "https://x/y.md", "//h/x.md", "file:x.md", "a\\u0000.md", "x".repeat(300) + ".md", "d/d/d/d/d/d/d/d/x.md", "fold.md", "notes.txt", "none.md"]) await t("read " + n.slice(0, 40), () => c.read(n, 1e6));
      for (const n of ["/elsewhere/secret", "../elsewhere/secret", "https://x/y", "notes.txt", "fold"]) await t("open " + n, () => c.open(n, {}));
      await t("read _toc.yml", () => c.read("_toc.yml", 65536));
      return out;
    })()`);
    const want = { "read /elsewhere/secret.md": "absolute", "read ../elsewhere/secret.md": "dot-segment", "read a/../../elsewhere/secret.md": "dot-segment", "read https://x/y.md": "scheme", "read //h/x.md": "authority", "read file:x.md": "scheme", "read a\u0000.md": "control", "read fold.md": "kind", "read notes.txt": "extension", "read none.md": "missing", "open /elsewhere/secret": "(absolute)", "open ../elsewhere/secret": "(dot-segment)", "open https://x/y": "(scheme)", "open notes.txt": "(extension)", "open fold": "(kind)" };
    for (const [what, r, reads] of direct) {
      if (what === "read _toc.yml") { C(r?.bytes === tx("_toc.yml").length && reads === 1, `the capability's own read of _toc.yml: ${JSON.stringify(r)}, ${reads} read`); continue; }
      const code = what.startsWith("read x") ? "length" : what.startsWith("read d/") ? "segments" : want[what];
      const got = typeof r?.refused === "string" ? r.refused : JSON.stringify(r);
      C((what.startsWith("open") ? got.endsWith(code) : got === code) && reads === 0, `the page's capability, ${what}: refused (${got}), ${reads} reads of a file's bytes`);
    }

    // a reference to another chapter, followed: asked first (A-1); Cancel makes nothing, focus back on the link
    const before = await names("/book");
    b.dialog.seen.length = 0;
    b.dialog.accept = false;
    await reset();
    await b.ev(`(window.__a = document.querySelector('a.myst-ref-book'), window.__a.focus(), window.__a.click(), true)`);
    C(await b.until(`false`, 1500) || b.dialog.seen.length === 1, "the first click: a confirm");
    C(/^Open chapter 7, "Computing Discrete Logs" \(07-Computing_DL\.md\), as a notebook\?\n\nA converted copy, "07-Computing_DL\.ipynb", is made beside it; "07-Computing_DL\.md" stays as it is\.$/.test(b.dialog.seen[0] ?? ""), "...its words (A-1): " + JSON.stringify(b.dialog.seen[0]));
    const cancelled = await io();
    C(JSON.stringify(await names("/book")) === JSON.stringify(before) && cancelled.writes === 0, `Cancel: no copy, ${cancelled.writes} writes`);
    C(await b.ev("document.activeElement === window.__a") && (await title()) === "09-Improving_DL — Sagebrush", "...focus back on the link, the chapter not left");
    // OK: the copy made, opened, its target focused and said, the way back shown
    b.dialog.accept = true;
    await b.ev(`(window.__a.click(), true)`);
    C(await loaded("07-Computing_DL"), "OK: chapter 7's copy opened");
    C((await stat("/book/07-Computing_DL.ipynb"))?.kind === "notebook", "...made beside its .md");
    C(await b.until("!!document.activeElement?.dataset?.mystAnchor", 10000), "...its target focused (N-1)");
    C(await b.until(`(document.querySelector('.myst-live')?.textContent ?? "").startsWith("Opened chapter 7: ")`, 5000), "...said: " + (await b.ev("document.querySelector('.myst-live')?.textContent")));
    C((await b.ev(`document.querySelector('.myst-bookline button')?.textContent`)) === "← Back to Chapter 9", "...the way back shown (A-3)");
    // Back: no confirm (the copy is there), the reference's cell focused
    const asked = b.dialog.seen.length;
    await b.ev(`(document.querySelector('.myst-bookline button').click(), true)`);
    C(await loaded("09-Improving_DL"), "Back: chapter 9 again");
    C(await b.until("document.activeElement?.classList?.contains('cell') && !!document.activeElement.querySelector('a.myst-ref-book')", 10000) && b.dialog.seen.length === asked, "...no confirm, the reference's cell focused");
    C((await b.ev("!!document.querySelector('.myst-bookline')")) === false, "...no way back shown here");

    // g1: the same notebook opened again (same workspace, notebook, folder): the old capability refuses, unread
    await wait("document.querySelectorAll('a.myst-ref-book').length >= 6", 30000, "the book's cross-chapter references linked (6)");
    await b.ev("window.__sagebrushMystBook().then((c) => { window.__old = c; })");
    await settle();
    await reset();
    await row("/book/09-Improving_DL.ipynb");
    C(await b.until("window.__sagebrushMystBook().then((c) => !!c && c !== window.__old)", 20000), "g1: the same notebook reopened: a new capability");
    C(await b.ev("window.__sagebrushMystBook().then((c) => c.book === window.__old.book && c.self === window.__old.self)"), "...for the same folder and notebook");
    await wait("document.querySelectorAll('a.myst-ref-book').length >= 6", 30000, "the book's cross-chapter references linked (6)");
    await sleep(500);
    C((await bookReads()) === 6, "...its book read again: 6 reads (" + (await bookReads()) + ")");
    await settle();
    await reset();
    const stale = await b.ev("window.__old.read('_toc.yml', 65536).then((r) => r.refused ?? 'read')");
    const named1 = (await io()).named.filter((c) => c.includes("_toc.yml"));
    C(stale === "stale" && (await bookReads()) === 0 && named1.length === 0, `...the old one: ${stale}; ${await bookReads()} reads of the book, entries read naming it: ${JSON.stringify(named1)}`);

    // the copy reused: no confirm the second time
    const asked2 = b.dialog.seen.length, names2 = await names("/book");
    await b.ev(`(document.querySelector('a.myst-ref-book').click(), true)`);
    C(await loaded("07-Computing_DL") && b.dialog.seen.length === asked2 && JSON.stringify(await names("/book")) === JSON.stringify(names2), "a chapter's copy there: opened, no confirm, none made");

    // g5: a capability kept past a switch, asked to open: nothing touched
    await b.ev("window.__sagebrushMystBook().then((c) => { window.__seven = c; })");
    await row("/book/09-Improving_DL.ipynb");
    await loaded("09-Improving_DL");
    await sleep(1500);
    await settle();
    await reset();
    const g5 = await b.ev("window.__seven.open('08-CRT_Bezout', {}).then((r) => typeof r === 'object' ? r.refused : r)");
    const named5 = (await io()).named.filter((c) => /08-CRT_Bezout/.test(c));
    C(g5 === "stale" && (await bookReads()) === 0 && named5.length === 0 && (await title()) === "09-Improving_DL — Sagebrush", `g5: chapter 7's capability, after chapter 9 opened: ${g5}; ${await bookReads()} reads of the book; entries read or written naming chapter 8: ${JSON.stringify(named5)}`);

    // g3: an open held after its save, the document switched meanwhile, then let go: no switch to it
    await wait("document.querySelectorAll('a.myst-ref-book').length >= 6", 30000, "the book's cross-chapter references linked (6)");
    await b.ev("window.__sagebrushMystBook().then((c) => { window.__nine = c; window.__sbBookHold = (p) => p === 'before-switch' ? new Promise((r) => { window.__let3 = r; window.__held3 = true; }) : undefined; window.__op3 = c.open('07-Computing_DL', {}); })");
    C(await b.until("window.__held3 === true", 10000), "g3: an open held after its save");
    await row("/book/plain.ipynb");
    await loaded("plain");
    await b.ev("(window.__let3(), true)");
    const g3 = await b.ev("window.__op3.then((r) => typeof r === 'object' ? r.refused : r)");
    await sleep(800);
    C(g3 === "stale" && (await title()) === "plain — Sagebrush", `...let go after another document opened: ${g3}, still ${await title()}`);
    await b.ev("(delete window.__sbBookHold, true)");

    // g4: a book built for chapter 9, held before it's shown, the lone chapter opened meanwhile: never shown there
    // (only the first build held: chapter 9's; the lone chapter opened for real (a new document: the page's
    // capability promise a new one) before it's let go)
    await b.ev("(window.__n4 = 0, window.__sbBookHold = (p) => p === 'before-publish' && ++window.__n4 === 1 ? new Promise((r) => { window.__let4 = r; window.__held4 = true; }) : undefined, true)");
    await row("/book/09-Improving_DL.ipynb");
    C(await b.until("window.__held4 === true", 30000), "g4: chapter 9's book built, held before it's shown");
    await b.ev("(window.__p9 = window.__sagebrushMystBook(), true)");
    await row("/solo/09-Improving_DL.ipynb");
    C(await b.until("window.__sagebrushMystBook() !== window.__p9 && document.querySelectorAll('.myst-box').length >= 8", 20000), "...the lone chapter opened meanwhile");
    await sleep(1000);
    await b.ev("(window.__let4(), true)");
    await sleep(1500);
    C((await bookLinks()) === 0 && !(await b.ev("!!document.querySelector('.myst-toc, .myst-bookline')")), "...let go: nothing of it in the lone chapter (" + (await bookLinks()) + " book links)");
    await b.ev("(delete window.__sbBookHold, true)");

    // a chapter that isn't MyST any more when followed: refused where it was clicked, not an alert, nothing made
    await row("/book/09-Improving_DL.ipynb");
    await wait("document.querySelectorAll('a.myst-ref-book').length >= 6", 30000, "the book's cross-chapter references linked (6)");
    await b.ev(`${W}.stat("/book/08-CRT_Bezout.md").then((e) => ${W}.write("/book/08-CRT_Bezout.md", new TextEncoder().encode("# Not MyST now\\n")))`);
    const asked3 = b.dialog.seen.length, names3 = await names("/book");
    await b.ev(`([...document.querySelectorAll('a.myst-ref-book')].find((a) => a.dataset.mystRef && /08|crt|bezout|chinese|euclid/i.test(a.textContent + a.dataset.mystRef)).click(), true)`);
    C(await b.until(`(document.querySelector('.myst-said')?.textContent ?? "").includes("is not a Jupytext MyST notebook")`, 10000), "a chapter no longer MyST: said at the click: " + (await b.ev("document.querySelector('.myst-said')?.textContent")));
    C(b.dialog.seen.length === asked3 && JSON.stringify(await names("/book")) === JSON.stringify(names3) && (await title()) === "09-Improving_DL — Sagebrush", "...no confirm, nothing made, not left");

    // a TOC naming a file outside its folder: that file never read, nothing of it in the book (D1, then D2-D4)
    const secret = (await stat("/elsewhere/secret.md")).fid;
    // (its interpreter started just before, so it isn't started again (the page keeps 4): that start gives Python
    // every file of the browser's, this one too, which is no book's doing)
    await row("/bad/09-Improving_DL.ipynb");
    await wait("window.__sagebrushMystBook().then((c) => c?.book === '/bad')", 20000, "the book capability for /bad");
    await sleep(2500);
    await row("/book/plain.ipynb");
    await loaded("plain");
    await sleep(1500);
    await reset();
    // (the book asked while /bad attaches, the last notebook's (plain's) metadata still there: the page raises the
    //  generation before it reads the new one. That early answer, none, must not be kept for /bad, or /bad never gets
    //  its book nor its book line (this part's red on #830, #921, #922, #984 under CI's load; here made certain))
    await b.ev(`(window.sagebrush.shareTest.beforeAttach = () => { window.sagebrush.shareTest.beforeAttach = null; window.__earlyBook = window.__sagebrushMystBook(); }, true)`);
    await row("/bad/09-Improving_DL.ipynb");
    C(await b.until("!!window.__earlyBook", 20000) && (await b.ev("window.__earlyBook.then((c) => c === null)")), "asked mid-attach, from the last notebook's metadata: no book yet");
    await wait("window.__sagebrushMystBook().then((c) => c?.book === '/bad')", 20000, "the book capability for /bad");
    await wait("!!document.querySelector('.myst-bookline')", 20000, "the book line under /bad's chapter (.myst-bookline)");
    await sleep(1500);
    const bad = await io();
    C(!bad.keys.includes(secret) && !bad.named.some((x) => x.includes("/elsewhere/")), `a TOC naming /elsewhere/secret: it is never read (${bad.keys.filter((k) => k === secret).length} reads of it), nothing outside the folder looked up`);
    C((await b.ev(`document.querySelector('.myst-bookline')?.textContent ?? ""`)) === "This book's table of contents isn't supported, so chapters open one at a time.", "...the book refused, said: " + (await b.ev(`document.querySelector('.myst-bookline')?.textContent ?? "(nothing said)"`)));

    // N-2: a MyST .md sent to the board page: not made a board; offered as a notebook, the offer focused
    const f7 = await stat("/book/07-Computing_DL.md");
    await go(`board/?openas=${encodeURIComponent("/book/07-Computing_DL.md")}&fid=${encodeURIComponent(f7.fid)}`);
    C(await b.until(`!!document.querySelector('a[href^="/?openas="]') && document.activeElement === document.querySelector('a[href^="/?openas="]')`, 30000), "N-2: the board page offers the notebook, the offer focused");
    C(!(await names("/book")).some((p) => p.endsWith(".board.json")), "...no board made");
    for (const e of b.errors) ok(false, "C: page error: " + e);
  } catch (e) { ok(false, "C: " + (e?.stack ?? e)); }
  finally { b.done(); srv.kill(); }
}
console.log(failures ? `${failures} failures` : "all passed");
process.exit(failures ? 1 : 0);
