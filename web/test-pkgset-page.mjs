// The notebook page's package set is a barrier before its first run
// (web/index.html notebookPkgset, web/notebook/worker-kernel.js; astra's
// CORR-PR68-3), in headless Chromium against web/dist (web/serve.py) behind a
// proxy that serves optional/hello's sets and holds pkgset/latest.json until
// told:
// - while latest is held, nothing runs; once it is answered, the pin is saved
//   before the run, so a reload right after keeps it, whatever latest says then;
// - a page closed while latest is held pinned nothing and ran nothing;
// - a notebook left while its latest is held: its run never happens, and the
//   pin goes into no other notebook;
// - two tabs of one notebook resolving different sets: the pin saved first
//   wins, and the other tab uses it, never its own.
//   bun web/build.ts && node web/test-pkgset-page.mjs      (CHROME=... for the browser)
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, freePort } from "./test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const root = join(here, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, name) => { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) failures++; };
setTimeout(() => { console.log("FAIL the test did not end within 400 s"); process.exit(1); }, 400_000).unref();

// two sets with hello: without and with its precompiled code (two set ids)
const setDir = mkdtempSync(join(tmpdir(), "sb-pkgset-page-"));
const build = (...a) => execFileSync("node", [join(root, "scripts", "optional-packages.mjs"), "build", "--out", setDir, ...a, "hello"], { encoding: "utf8" }).trim().split("\n").at(-1);
const S1 = build(), S2 = build("--pre");

// web/dist behind a proxy: pkg/ and pkgset/ from setDir, every path asked
// for recorded, and pkgset/latest.json held until answer(id) answers the oldest
function site() {
  return (async () => {
    const upstream = await freePort();
    const server = spawn("python3", [join(here, "serve.py"), String(upstream)], { stdio: "ignore" });
    const asked = [], held = [];
    let auto = null; // answer at once with this id, if set
    const front = createServer((req, res) => {
      const path = new URL(req.url, "http://x").pathname;
      asked.push(path);
      if (path === "/pkgset/latest.json") {
        const reply = (id) => { try { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify({ id })); } catch {} };
        return auto ? reply(auto) : held.push(reply);
      }
      const m = /^\/(pkgset|pkg)\/([0-9a-f]{64})\.json$/.exec(path);
      if (m) {
        const f = join(setDir, m[1], m[2] + ".json");
        if (!existsSync(f)) return res.writeHead(404).end();
        return res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(readFileSync(f));
      }
      const up = request({ host: "127.0.0.1", port: upstream, path: req.url, method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      up.on("error", () => { res.destroy(); });
      req.pipe(up);
    });
    await new Promise((r) => front.listen(0, "127.0.0.1", r));
    for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${upstream}/`); break; } catch { await sleep(100); } }
    const stop = () => new Promise((r) => { server.kill(); front.closeAllConnections?.(); front.close(() => r()); });
    return {
      url: `http://127.0.0.1:${front.address().port}/`, asked, stop,
      held: () => held.length,
      answer: (id) => held.shift()?.(id),
      setAuto: (id) => (auto = id),
    };
  })();
}

// a Chrome with one profile; tab() attaches to a page (a new one after the first)
async function chromium() {
  const profile = mkdtempSync(join(tmpdir(), "sb-pkgset-page-chrome-"));
  const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  const port = await devtoolsPort(profile);
  const cdp = `http://127.0.0.1:${port}`;
  let first = true;
  const sockets = [];
  async function tab() {
    let target;
    if (first) {
      for (let i = 0; i < 300 && !target; i++) { try { target = (await (await fetch(cdp + "/json")).json()).find((t) => t.type === "page"); } catch { await sleep(100); } }
      first = false;
    } else target = await (await fetch(cdp + "/json/new?about:blank", { method: "PUT" })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    sockets.push(ws);
    await new Promise((r) => (ws.onopen = r));
    let n = 0; const waiting = new Map(), errors = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
      if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
    };
    const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
    const until = async (expr, ms = 30000) => { for (let i = 0; i < ms / 100; i++) { if (await ev(expr)) return true; await sleep(100); } return false; };
    await send("Page.enable");
    await send("Runtime.enable");
    const cell = (k) => `document.querySelectorAll('.cell')[${k}]`;
    return {
      errors, ev, until, send,
      open: async (url) => { await send("Page.navigate", { url }); return until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000); },
      reload: () => send("Page.reload", { ignoreCache: false }),
      // a run asked for in a new last cell (not waited for): its index
      startRun: async (code) => {
        const k = await ev(`(() => { const cs = [...document.querySelectorAll('.cell')]; if (cs.at(-1).querySelector('textarea').value.trim()) document.querySelector('#add').click(); return document.querySelectorAll('.cell').length - 1; })()`);
        await ev(`(() => { const c = ${cell(k)}; const ta = c.querySelector('textarea'); ta.value = ${JSON.stringify(code)}; ta.dispatchEvent(new Event('input', {bubbles: true})); c.querySelector('[data-a=run]').click(); })()`);
        return k;
      },
      ran: (k) => ev(`/\\[\\d+\\]/.test(${cell(k)}?.querySelector('.n')?.textContent ?? '')`),
      out: async (k) => String(await ev(`${cell(k)}?.querySelector('.out')?.textContent ?? ''`)),
      done: (k, ms = 120000) => until(`/\\[\\d+\\]/.test(${cell(k)}?.querySelector('.n')?.textContent ?? '')`, ms),
    };
  }
  const close = async () => {
    for (const ws of sockets) ws.close();
    chrome.kill("SIGKILL");
    await sleep(300);
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  return { tab, close };
}
const HELLO = "import hello\nprint(hello.greet())";
const fetched = (s, S) => s.asked.includes(`/pkgset/${S}.json`);

// 1. held: nothing runs; answered: pinned and saved before the run
{
  const s = await site(), c = await chromium();
  try {
    const t = await c.tab();
    await t.open(s.url + "?runner=0");
    const k = await t.startRun(HELLO);
    for (let i = 0; i < 300 && !s.held(); i++) await sleep(100);
    ok(s.held() > 0, "the page asks for the latest set");
    await sleep(2000);
    ok(!(await t.ran(k)) && (await t.out(k)) === "" && !fetched(s, S1), "while latest is held, the run waits: nothing ran, no set fetched");
    s.answer(S1);
    ok(await t.done(k), "answered, the run happens");
    ok((await t.out(k)).includes("hello, world") && fetched(s, S1), `with the set it was told (${JSON.stringify(await t.out(k))})`);
    // (a reload at once, with latest now another set: the pin was saved before the run)
    s.setAuto(S2);
    const latestAsked = s.asked.filter((p) => p === "/pkgset/latest.json").length;
    await t.reload();
    await sleep(1500);
    await t.until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000);
    const k2 = await t.startRun(HELLO);
    ok(await t.done(k2), "after a reload right after the run, a run");
    ok((await t.out(k2)).includes("hello, world") && !fetched(s, S2) && s.asked.filter((p) => p === "/pkgset/latest.json").length === latestAsked, `uses the pinned set: latest isn't asked again, the other set never fetched (${JSON.stringify(await t.out(k2))})`);
    ok(!t.errors.length, "no exceptions on the page: " + JSON.stringify(t.errors));
  } finally { await c.close(); await s.stop(); }
}

// 2. closed while latest is held: nothing pinned, nothing ran
{
  const s = await site(), c = await chromium();
  try {
    const t = await c.tab();
    await t.open(s.url + "?runner=0");
    const k = await t.startRun(HELLO);
    for (let i = 0; i < 300 && !s.held(); i++) await sleep(100);
    await sleep(500);
    ok(!(await t.ran(k)), "a run waits on the held latest");
    // (the page goes away: once the new page asks too, the old page's held
    // request is answered with a set, which nobody receives)
    await t.reload();
    for (let i = 0; i < 300 && s.held() < 2; i++) await sleep(100);
    ok(s.held() === 2, "the reloaded page asks for latest again");
    s.answer(S1);
    await sleep(1500);
    s.setAuto(S2);
    while (s.held()) s.answer(S2);
    await t.until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000);
    const k2 = await t.startRun(HELLO);
    ok(await t.done(k2) && (await t.out(k2)).includes("hello, world"), "after the reload, a run");
    ok(fetched(s, S2) && !fetched(s, S1), "uses the set latest says now: the first was never pinned, and nothing fetched it");
  } finally { await c.close(); await s.stop(); }
}

// 3. a notebook left while its latest is held: its run never happens, its pin goes nowhere else
{
  const s = await site(), c = await chromium();
  try {
    const t = await c.tab();
    await t.open(s.url + "?runner=0");
    const k = await t.startRun("print('A ran')");
    for (let i = 0; i < 300 && !s.held(); i++) await sleep(100);
    const A = await t.ev("localStorage.getItem('sagebrush-current')");
    await t.ev("document.querySelector('#filemenu [data-f=new]').click()");
    ok(await t.until(`localStorage.getItem('sagebrush-current') !== ${JSON.stringify(A)}`, 10000), "another notebook is shown");
    s.answer(S1);
    await sleep(1500);
    // (the new notebook resolves for itself: its own run pins and uses the set)
    s.setAuto(S1);
    const kb = await t.startRun(HELLO);
    ok(await t.done(kb) && (await t.out(kb)).includes("hello, world"), "the notebook shown now runs with its own pin");
    // (back to the first: its run never happened)
    await t.open(s.url + "?runner=0&nb=" + encodeURIComponent(A));
    await t.until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000);
    ok(!(await t.out(k)).includes("A ran"), `the left notebook's run never happened (${JSON.stringify(await t.out(k))})`);
    void k;
  } finally { await c.close(); await s.stop(); }
}

// 4. two tabs of one notebook resolving different sets: the pin saved first wins
{
  const s = await site(), c = await chromium();
  try {
    const t1 = await c.tab();
    await t1.open(s.url + "?runner=0");
    await t1.until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000);
    const A = await t1.ev("localStorage.getItem('sagebrush-current')");
    const k1 = await t1.startRun(HELLO);
    for (let i = 0; i < 300 && s.held() < 1; i++) await sleep(100);
    const t2 = await c.tab();
    await t2.open(s.url + "?runner=0&nb=" + encodeURIComponent(A));
    await t2.until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000);
    const k2 = await t2.startRun(HELLO);
    for (let i = 0; i < 300 && s.held() < 2; i++) await sleep(100);
    ok(s.held() === 2, "both tabs wait on latest");
    s.answer(S1); // (the first tab's)
    ok(await t1.done(k1) && (await t1.out(k1)).includes("hello, world"), "the first tab runs with its set");
    await sleep(1500);
    s.answer(S2); // (the second tab's: another set)
    ok(await t2.done(k2) && (await t2.out(k2)).includes("hello, world"), "the second tab runs");
    ok(!fetched(s, S2), "with the first tab's pin, not the set its own latest said");
  } finally { await c.close(); await s.stop(); }
}

rmSync(setDir, { recursive: true, force: true });
console.log(failures ? `${failures} failures` : "all passed");
process.exit(failures ? 1 : 0);
