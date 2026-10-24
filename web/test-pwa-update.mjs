// A deploy while a notebook is open (HARD-813-1): a page opened before it
// keeps running its worker, whose library chunks (web/lib-chunks.mts) are
// named by that build, and the deploy replaced lib/ and the service worker
// (which then deletes the old caches).  A chunk that page first imports
// after the deploy must still come: from the site's Worker, which serves
// chunks from R2's lib/<name> (web/engines.ts handleLibChunk; put there by
// scripts/publish-engine.mjs) when the site's files no longer have them.
//
// web/dist is served by web/serve.py behind a front that, once "deployed",
// no longer serves lib/ itself and serves a new sw.js (another VERSION, so
// another cache, and the old chunks not in it), and sends a missing chunk to
// handleLibChunk in Miniflare with a simulated R2 bucket.  The bucket has
// every chunk but MATLAB's, to check that a chunk found nowhere is an error
// that says so.
//
//   bun web/build.ts && node web/test-pwa-update.mjs      (CHROME=... for the browser)
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "./test-port.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const here = new URL(".", import.meta.url).pathname;
let failures = 0;
const ok = (cond, name) => { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) failures++; };

// ---- failure diagnostics: bounded in time and bytes, and never able to turn a failure into a pass
const NOTE_MAX = 40, NOTE_CHARS = 300, ID_CHARS = 64, URL_MAX = 2000, DIAG_MS = 5000;
const clip = (x, n = NOTE_CHARS) => String(x).slice(0, n);
const note = (list, line) => { list.push(clip(line)); if (list.length > NOTE_MAX) list.shift(); };
/** A CDP session: send() with an optional deadline, after which it answers {timedOut} and forgets the
 * request, so a reply after it (or to an id never sent) is inert (PWA-DIAG-1). */
function cdpSession(post) {
  let n = 0;
  const waiting = new Map();
  const send = (method, params = {}, ms = Infinity) => new Promise((resolve) => {
    const id = ++n;
    const timer = Number.isFinite(ms) ? setTimeout(() => { waiting.delete(id); resolve({ timedOut: true }); }, ms) : null;
    waiting.set(id, (v) => { if (timer) clearTimeout(timer); waiting.delete(id); resolve(v); });
    post(JSON.stringify({ id, method, params }));
  });
  const reply = (m) => { const w = waiting.get(m.id); if (!w) return false; w(m.result ?? m.error); return true; };
  return { send, reply, pending: () => waiting.size };
}
/** p's result, or `late` once ms have passed (one hard wall around a best-effort pass). */
const within = (ms, p, late) => { let t; return Promise.race([p, new Promise((r) => (t = setTimeout(() => r(late), ms)))]).finally(() => clearTimeout(t)); };
/** A CDP event kept for the diagnostics, each value cut before it is joined or stored (PWA-DIAG-2). */
function recordEvent(m, notes, urls) {
  const p = m.params ?? {};
  if (m.method === "Runtime.consoleAPICalled" && (p.type === "error" || p.type === "warning")) note(notes.console, `${p.type}: ${(p.args ?? []).slice(0, 8).map((a) => clip(a.value ?? a.description ?? a.type, 120)).join(" ")}`);
  else if (m.method === "Runtime.exceptionThrown") note(notes.console, `exception: ${clip(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text)}`);
  else if (m.method === "Log.entryAdded" && p.entry?.level === "error") note(notes.console, `log: ${clip(p.entry.text, 200)} ${clip(p.entry.url ?? "", 100)}`);
  else if (m.method === "Network.requestWillBeSent") { urls.set(clip(p.requestId, ID_CHARS), clip(p.request?.url)); if (urls.size > URL_MAX) urls.delete(urls.keys().next().value); }
  else if (m.method === "Network.loadingFailed") note(notes.network, `failed: ${urls.get(clip(p.requestId, ID_CHARS)) ?? clip(p.requestId, ID_CHARS)} ${clip(p.errorText ?? "", 100)} ${clip(p.blockedReason ?? "", 60)}`);
  else if (m.method === "Network.responseReceived" && p.response?.status >= 400) note(notes.network, `${p.response.status}: ${clip(p.response.url)}`);
}
/** The diagnostics' pass: the page's and its service worker's state, then the notes, all within one hard
 * wall of ms; an unanswered page shows as a diagnostic timeout (PWA-DIAG-1). */
function makeDiagnose({ send, notes, log, ms = DIAG_MS }) {
  const expression = `(async () => {
    const reg = await navigator.serviceWorker?.getRegistration?.().catch((e) => String(e));
    const sw = (w) => w ? w.state + " " + w.scriptURL : null;
    return JSON.stringify({
      href: location.href, readyState: document.readyState, isolated: globalThis.crossOriginIsolated,
      status: document.querySelector('#status')?.textContent ?? null,
      controller: sw(navigator.serviceWorker?.controller),
      registration: reg && typeof reg === "object" ? { installing: sw(reg.installing), waiting: sw(reg.waiting), active: sw(reg.active) } : reg ?? null,
      caches: await caches.keys().catch((e) => String(e)),
    });
  })()`;
  return async (why) => {
    const r = await within(ms, send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, ms), { timedOut: true });
    // (on a page that threw, as Chrome's own error page does, returnByValue gives the error as {}: say the exception)
    const state = r?.timedOut ? "unavailable (diagnostic timeout)"
      : r?.exceptionDetails ? "unavailable: " + clip(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
      : typeof r?.result?.value === "string" ? r.result.value : "unavailable: " + clip(JSON.stringify(r));
    log(`  diagnostics (${why}):`);
    log("    page: " + String(state).slice(0, 2000));
    for (const [k, list] of Object.entries(notes)) for (const line of list) log(`    ${k}: ${line}`);
    if (!Object.values(notes).some((l) => l.length)) log("    (no failed requests, console errors or failed loads recorded)");
  };
}
/** What a cell that didn't finish by its deadline returns: no check accepts it. */
const TIMED_OUT = "(timed out: the cell didn't finish, so its output isn't read)";
/** A cell's run. If it doesn't finish by its deadline, the failure is recorded at once, before the
 * diagnostics (which take time, while the cell may still finish), and its output is never read, so a
 * late finish can't pass (CORR-PWA98-1). */
function cellRunner({ start, finished, output, diagnose, fail }) {
  return async (code) => {
    await start(code);
    if (!(await finished())) {
      fail("a cell didn't finish in 90 s: " + clip(JSON.stringify(code), 80));
      await diagnose("a cell didn't finish in 90 s");
      return TIMED_OUT;
    }
    // (always a string, so a check of it fails in words, never with a TypeError)
    return (await output()) ?? "(no output: the cell didn't run)";
  };
}

// ---- self-checks of the diagnostics, without a browser (they run first, and count like any check)
{
  // CORR-PWA98-1: a cell that finishes only during the diagnostics still fails, once, before them
  const order = [];
  let out = "";
  const run = cellRunner({
    start: async () => {}, finished: async () => false, output: async () => out,
    diagnose: async () => { order.push("diagnose"); out = "42 [1, 2] 274177 * 67280421310721"; },
    fail: (why) => order.push("fail: " + why),
  });
  const got = await run("print(6 * 7)");
  ok(got === TIMED_OUT && !got.includes("42") && order.length === 2 && order[0].startsWith("fail: ") && order[1] === "diagnose",
    "(self-check) a cell past its deadline fails before the diagnostics, and output that appears during them isn't accepted: " + JSON.stringify({ got, order }));
  const fine = cellRunner({ start: async () => {}, finished: async () => true, output: async () => "42", diagnose: async () => order.push("x"), fail: () => order.push("y") });
  ok((await fine("print(6 * 7)")) === "42" && order.length === 2, "(self-check) a cell that finishes in time returns its output, with no failure or diagnostics");
  // PWA-DIAG-1: an unanswered request ends at its deadline, forgotten; a late reply is inert; the pass is walled
  const posted = [];
  const cdp = cdpSession((m) => posted.push(JSON.parse(m)));
  let t0 = Date.now();
  const r = await cdp.send("Runtime.evaluate", {}, 200);
  const took = Date.now() - t0;
  ok(r?.timedOut === true && took >= 150 && took < 1500 && cdp.pending() === 0, `(self-check) an unanswered request ends at its 200 ms deadline (${took} ms), forgotten`);
  ok(cdp.reply({ id: posted[0].id, result: { result: { value: "late" } } }) === false && cdp.reply({ id: 999, result: {} }) === false && cdp.pending() === 0, "(self-check) a reply after the deadline, or to an id never sent, is inert");
  const lines = [];
  const quiet = { front: [], console: [], network: [] };
  const diag = makeDiagnose({ send: (method, params, ms) => cdpSession(() => {}).send(method, params, Infinity), notes: quiet, log: (l) => lines.push(l), ms: 300 });
  t0 = Date.now();
  await diag("a wedged page");
  const took2 = Date.now() - t0;
  ok(took2 < 1500 && lines.some((l) => l.includes("unavailable (diagnostic timeout)")), `(self-check) the diagnostics end within their hard wall even if the page never answers (${took2} ms): ` + JSON.stringify(lines.slice(0, 2)));
  // PWA-DIAG-2: what is kept is bounded in characters as well as entries
  const ns = { front: [], console: [], network: [] }, us = new Map();
  const big = "x".repeat(1 << 20);
  for (let i = 0; i < URL_MAX + 500; i++) recordEvent({ method: "Network.requestWillBeSent", params: { requestId: i + big.slice(0, 10_000), request: { url: "https://h/" + big } } }, ns, us);
  recordEvent({ method: "Runtime.consoleAPICalled", params: { type: "error", args: Array.from({ length: 50 }, () => ({ description: big })) } }, ns, us);
  recordEvent({ method: "Network.loadingFailed", params: { requestId: "r" + big, errorText: big, blockedReason: big } }, ns, us);
  ok(us.size === URL_MAX && [...us.keys()].every((k) => k.length <= ID_CHARS) && [...us.values()].every((v) => v.length <= NOTE_CHARS), "(self-check) request URLs and ids are kept cut, at most " + URL_MAX);
  ok([...ns.console, ...ns.network].every((l) => l.length <= NOTE_CHARS) && ns.console.length === 1 && ns.network.length === 1, "(self-check) console and network notes are cut to " + NOTE_CHARS + " characters");
}

// the site's Worker's chunk route, in Miniflare, with the chunks in R2
const require = createRequire(join(here, "test-workers/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const entryFile = join(mkdtempSync(join(tmpdir(), "sb-update-")), "entry.ts");
writeFileSync(entryFile, `import { handleLibChunk } from ${JSON.stringify(join(here, "engines.ts"))};
export default { async fetch(req, env, ctx) { return (await handleLibChunk(req, env, ctx)) ?? new Response("not mine", { status: 418 }); } };`);
const script = execFileSync("bun", ["build", entryFile, "--format", "esm", "--target", "browser"], { encoding: "utf8" });
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: "site", modules: true, script, compatibilityDate: "2026-10-01", r2Buckets: ["ENGINES"] }] }));
const bucket = await mf.getR2Bucket("ENGINES");
// (with the pinned zone data's files, in lib/tzdata/)
const chunks = readdirSync(join(here, "dist", "lib"), { recursive: true }).filter((f) => statSync(join(here, "dist", "lib", f)).isFile());
for (const f of chunks) if (!f.startsWith("matlab")) await bucket.put("lib/" + f, readFileSync(join(here, "dist", "lib", f)));

// (serve.py picks its own free port and says it once it is listening: no port chosen here that something else can
// take before serve.py binds it, and no fixed wait for it to start; a CI flake was the front's 502, ECONNREFUSED,
// for the first page load, run 40090051590)
const server = spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] });
let serverErr = "";
server.stderr.on("data", (d) => { serverErr = (serverErr + d).slice(-2000); });
const upstream = await new Promise((resolve, reject) => {
  let out = "";
  const timer = setTimeout(() => reject(new Error("serve.py didn't say its port within 30 s: " + serverErr)), 30_000);
  server.stdout.on("data", (d) => {
    out += d;
    const m = /^(\d+)\n/.exec(out);
    if (m) { clearTimeout(timer); resolve(Number(m[1])); }
  });
  server.on("exit", (code, signal) => { clearTimeout(timer); reject(new Error(`serve.py exited before listening (${code ?? signal}): ${serverErr}`)); });
});
let deployed = false;
const seen = { site: [], r2: [] };
// (what the diagnostics print if the page doesn't load: the front's failed requests, the page's console, its failed loads)
const notes = { front: [], console: [], network: [] };
const sw = readFileSync(join(here, "dist", "sw.js"), "utf8");
const front = createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (deployed && path === "/sw.js") {
    // (the next build's service worker: another version, whose lists name its own chunks, not these)
    const next = sw.replace(/const VERSION = "([0-9a-f]+)"/, (_, v) => `const VERSION = "${v}next"`).replaceAll('"lib/', '"lib-of-the-next-build/');
    res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-cache" });
    return res.end(next);
  }
  if (path.startsWith("/lib/")) {
    if (deployed) {
      const r = await mf.dispatchFetch("https://sagebrush.test" + path, { method: req.method });
      seen.r2.push(path + " " + r.status);
      const body = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, { ...Object.fromEntries(r.headers), "cross-origin-resource-policy": "cross-origin" });
      return res.end(body);
    }
    seen.site.push(path);
  }
  const up = request({ host: "127.0.0.1", port: upstream, path: req.url, method: req.method, headers: req.headers }, (r) => {
    if (r.statusCode >= 400) note(notes.front, `${req.method} ${path} ${r.statusCode}`);
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on("error", (e) => { note(notes.front, `${req.method} ${path} 502 (upstream: ${e?.code ?? e})`); res.writeHead(502); res.end(); });
  req.pipe(up);
});
await new Promise((r) => front.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${front.address().port}/`;
// (the root page answers before Chrome is sent to it)
ok((await fetch(url)).status === 200, "the site answers before the page is opened");

const profile = mkdtempSync(join(tmpdir(), "sb-update-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const cleanup = async () => { chrome.kill("SIGKILL"); server.kill(); front.close(); await mf.dispose(); await sleep(300); rmSync(profile, { recursive: true, force: true }); };
try {
  const cdpPort = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const cdp = cdpSession((m) => ws.send(m));
  const urls = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id !== undefined) { cdp.reply(m); return; }
    recordEvent(m, notes, urls); // (events, kept for the diagnostics)
  };
  const send = cdp.send;
  const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
  const until = async (expr, ms = 30000) => { for (let i = 0; i < ms / 100; i++) { if (await ev(expr)) return true; await sleep(100); } return false; };
  const diagnose = makeDiagnose({ send, notes, log: (l) => console.log(l) });
  const last = "[...document.querySelectorAll('.cell')].filter(c => c.querySelector('textarea').value.trim()).at(-1)";
  const runCode = cellRunner({
    start: (code) => ev(`(() => { const cs = [...document.querySelectorAll('.cell')]; let c = cs.at(-1); if (c.querySelector('textarea').value.trim()) { document.querySelector('#add').click(); c = [...document.querySelectorAll('.cell')].at(-1); } const ta = c.querySelector('textarea'); ta.value = ${JSON.stringify(code)}; ta.dispatchEvent(new Event('input', {bubbles: true})); c.querySelector('[data-a=run]').click(); })()`),
    finished: () => until(`(() => /\\[\\d+\\]/.test(${last}.querySelector('.n').textContent))()`, 90000),
    output: () => ev(`${last}.querySelector('.out').textContent`),
    diagnose,
    fail: (why) => ok(false, why),
  });
  const versions = () => ev(`caches.keys().then((ks) => ks.filter((k) => k.startsWith("sagebrush-")))`);
  // (the events the diagnostics keep; bounded like them, so a wedged session can't hang the start)
  for (const domain of ["Runtime", "Log", "Network"]) await send(domain + ".enable", {}, DIAG_MS);

  await send("Page.navigate", { url });
  const loaded = await until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000);
  ok(loaded, "the notebook loads");
  const controlled = await until("!!navigator.serviceWorker.controller", 30000);
  ok(controlled, "the service worker controls the page");
  // (nothing after this can pass without both: say why once, and stop, rather than failing on a missing output)
  if (!loaded || !controlled) {
    await diagnose(!loaded ? "the notebook didn't load" : "no service worker controls the page");
    throw new Error("stopped: the page isn't ready, so the deploy steps can't run (see the diagnostics above)");
  }
  let out = await runCode("print(6 * 7)");
  ok(out.includes("42") && !seen.site.some((p) => /\/lib\/(sage|mod-heapq)\./.test(p)), "Python runs, with none of Sage's chunks nor heapq's fetched: " + JSON.stringify(out));
  const before = await versions();

  // the deploy, and the new service worker taking over (it deletes the old cache)
  deployed = true;
  await ev(`navigator.serviceWorker.getRegistration().then((r) => r.update()).then(() => 1, () => 0)`);
  ok(await until(`caches.keys().then((ks) => ks.some((k) => k.startsWith("sagebrush-") && k.endsWith("next")) && !ks.includes(${JSON.stringify(before[0])}))`, 30000), `the next build's service worker is active and the old cache gone: ${JSON.stringify(before)} -> ${JSON.stringify(await versions())}`);

  // the old page, its old worker, its first imports after the deploy
  out = await runCode("import heapq\nprint(heapq.nsmallest(2, [3, 1, 2]))");
  ok(out.includes("[1, 2]") && seen.r2.some((s) => /\/lib\/mod-heapq\.src\.[0-9a-f]+\.json 200$/.test(s)), "after the deploy, the old page imports heapq: its chunk from R2's lib/: " + JSON.stringify(out));
  out = await runCode("from sage_all import factor\nprint(factor(2**64 + 1))");
  ok(out.includes("274177 * 67280421310721") && seen.r2.some((s) => /\/lib\/sage\.src\..* 200$/.test(s)), "...and Sage's library, first used now: " + JSON.stringify(out));
  out = await runCode("import _matlab_sparse");
  ok(/ImportError: could not load the Python library's matlab modules/.test(out) && !/internal error/.test(out) && seen.r2.some((s) => /\/lib\/matlab\.src\..* 404$/.test(s)), "a chunk found nowhere (not in R2 either) is an ImportError that says which part: " + JSON.stringify(out.slice(-200)));
  ws.close();
} catch (e) {
  failures++;
  console.log("FAIL " + (e?.stack ?? e));
} finally {
  await cleanup();
}
console.log(failures ? `${failures} failures` : "all passed");
process.exit(failures ? 1 : 0);
