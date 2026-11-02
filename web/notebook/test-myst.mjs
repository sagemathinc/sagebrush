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
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? "");
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 1500)); return r.result?.value; };
  const until = async (expr, ms = 30000) => { for (let i = 0; i < ms / 100; i++) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
  await send("Runtime.enable");
  return { send, ev, until, errors, done: () => { try { ws.close(); } catch {} chrome.kill(); setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500).unref(); } };
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
console.log(failures ? `${failures} failures` : "all passed");
process.exit(failures ? 1 : 0);
