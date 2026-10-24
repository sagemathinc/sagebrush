// End-to-end test of `sagebrush notebook` (src/notebook.ts) in headless Chromium:
//
//   node web/test-local-notebook.mjs [bundle]     (default build/cli/pyjs.cjs; CHROME=... for the browser)
//
// It starts the server on a scratch directory with a data file in it, then
// checks: the token (no access without it), the directory listing, a new
// notebook running Sage natively, reading the directory's files, the .ipynb
// saved to disk, reopening it, Stop interrupting a loop (variables kept),
// a 3D plot, and that paths outside the directory are refused.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, freePort } from "./test-port.mjs";

const bundle = process.argv[2] ?? new URL("../build/cli/pyjs.cjs", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, name) => { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) failures++; };

const dir = mkdtempSync(join(tmpdir(), "sb-local-"));
mkdirSync(join(dir, "sub"));
writeFileSync(join(dir, "sub", "data.csv"), "x,y\n1,2\n3,4\n");
const port = await freePort();
const server = spawn(process.execPath, [bundle, "notebook", dir, "--port", String(port), "--no-browser"], { stdio: ["ignore", "pipe", "inherit"] });
let printed = "";
server.stdout.on("data", (d) => (printed += d));
for (let i = 0; i < 100 && !/token=/.test(printed); i++) await sleep(100);
const url = /http:\/\/127\.0\.0\.1:\d+\/\?token=\w+/.exec(printed)?.[0];
ok(!!url, "the server prints its URL with a token");

const base = `http://127.0.0.1:${port}`;
ok((await fetch(base + "/")).status === 403, "no access without the token");
ok((await fetch(base + "/", { headers: { Host: "evil.example" } })).status === 403, "other host names are refused (DNS rebinding)");

const profile = mkdtempSync(join(tmpdir(), "sb-local-chrome-"));
let cdpPort = Number(process.env.CDP_PORT) || 0;
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!cdpPort) cdpPort = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map();
const responses = []; // (the page's requests' responses: Network.responseReceived)
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === "Network.responseReceived") responses.push({ url: m.params.response.url, status: m.params.response.status });
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
const go = async (u) => { await send("Page.navigate", { url: u }); await sleep(1200); };
const ready = async () => { for (let i = 0; i < 200 && !(await ev("document.querySelector('#status')?.textContent.startsWith('ready')")); i++) await sleep(100); };
const until = async (expr, ms = 30000) => { for (let i = 0; i < ms / 100; i++) { if (await ev(expr)) return true; await sleep(100); } return false; };
const LAST = "[...document.querySelectorAll('.cell')].filter(c => c.querySelector('textarea').value.trim()).at(-1)";
const put = (code) => ev(`(() => { const cs = [...document.querySelectorAll('.cell')]; let c = cs.at(-1); if (c.querySelector('textarea').value.trim()) { document.querySelector('#add').click(); c = [...document.querySelectorAll('.cell')].at(-1); } const ta = c.querySelector('textarea'); ta.value = ${JSON.stringify(code)}; ta.dispatchEvent(new Event('input', {bubbles: true})); c.querySelector('[data-a=run]').click(); })()`);
// run code in a new last cell; the text of its output
async function runCode(code) {
  await put(code);
  await until(`(() => /\\[\\d+\\]/.test(${LAST}.querySelector('.n').textContent))()`);
  return ev(`${LAST}.querySelector('.out').textContent`);
}
async function runAndStop(code, ms) {
  await put(code);
  await sleep(ms);
  await ev("document.querySelector('#stop').click()");
  await until(`(() => { const c = ${LAST}; return !c.classList.contains('running') && !c.classList.contains('queued'); })()`);
  return ev(`${LAST}.querySelector('.out').textContent`);
}

const cleanup = () => { try { ws.close(); } catch {} chrome.kill(); server.kill(); };
process.on("uncaughtException", (e) => { console.log("FAIL " + (e?.stack ?? e)); cleanup(); process.exit(1); });
process.on("unhandledRejection", (e) => { console.log("FAIL " + (e?.stack ?? e)); cleanup(); process.exit(1); });
await go(url);
ok(/Sagebrush/.test(await ev("document.body.textContent")) && (await ev("location.pathname")) === "/", "the token becomes a cookie; the directory listing shows");
ok(await ev("[...document.querySelectorAll('a')].some((a) => a.textContent === 'sub/')"), "the listing shows subdirectories");
await send("Network.enable");
responses.length = 0;
await go(`${base}/nb/sub/first.ipynb`);
await ready();
ok((await ev("location.pathname")) === "/nb/sub/first.ipynb/", "a new notebook opens at /nb/<path>/");
// (its page: no request refused or not found, no share API asked, no web app manifest; a file not saved yet is no content)
const bad = responses.filter((r) => r.status >= 400 || /\/api\/share\//.test(r.url));
ok(bad.length === 0, "a new notebook's page makes no failing request: " + JSON.stringify(bad));
ok(await ev("!document.querySelector('link[rel=manifest]')"), "...and has no web app manifest");
ok((await ev(`fetch('api/file?path=' + encodeURIComponent('sub/not-yet.ipynb')).then((r) => r.status)`)) === 204, "...and a notebook not saved yet reads as no content (204)");
await send("Network.disable");
ok(/sagebrush/.test(await ev("document.querySelector('#status').textContent")), "Python is ready: " + (await ev("document.querySelector('#status').textContent")));
let out = await runCode("import os\nprint(factor(2^64 + 1), open('data.csv').read().split()[1], os.getcwd().endswith('sub'))");
ok(out.includes("274177 * 67280421310721") && out.includes("1,2") && out.includes("True"), "Sage runs natively in the notebook's directory, reading its files: " + JSON.stringify(out));
await sleep(1500);
const saved = join(dir, "sub", "first.ipynb");
ok(existsSync(saved) && JSON.parse(readFileSync(saved, "utf8")).cells.some((c) => c.source.join("").includes("factor(2^64 + 1)")), "the notebook is saved to disk as .ipynb");
// Stop: KeyboardInterrupt, keeping variables
out = await runAndStop("keep = 41\nwhile True:\n    pass", 1500);
ok(out.includes("KeyboardInterrupt"), "Stop interrupts a loop: " + JSON.stringify(out.slice(-80)));
// (the reactive notebook: a cell reading the interrupted cell's variables waits for it; the interpreter kept them)
out = await runCode("print(globals()['keep'] + 1)");
ok(out.includes("42"), "...and the variables are kept: " + JSON.stringify(out));
// a call that never checks the flag (a backtracking re match): the server's
// worker is ended and a new one started; the next cell runs
const t0 = Date.now();
out = await runAndStop("import re\nre.match('(a+)+$', 'a' * 40 + 'b')", 1500);
ok(/did not stop when interrupted/.test(out) && Date.now() - t0 - 1500 < 4000, `Stop ends a catastrophic re.match (${Date.now() - t0 - 1500} ms): ` + JSON.stringify(out.slice(-120)));
await ready();
out = await runCode("print(6 * 7)");
ok(out.includes("42"), "...and the next cell runs: " + JSON.stringify(out));
await runCode("icosahedron(color='orange', opacity=0.5).translate((0, 0, 1)) + tetrahedron()");
ok(await ev("!!document.querySelector('figure.plot3d svg')"), "3D graphics show");
await sleep(1500);
// reopen: the cells come back from the file
await go(`${base}/nb/sub/first.ipynb/`);
await ready();
ok((await ev("document.querySelectorAll('.cell').length")) >= 4 && (await ev("document.body.textContent")).includes("factor(2^64 + 1)"), "reopening shows the saved notebook");
const outside = await ev(`fetch('api/file?path=' + encodeURIComponent('../../etc/passwd')).then((r) => r.status)`);
ok(outside === 400, "files outside the directory are refused: " + outside);
const lic = await ev(`fetch('/THIRD-PARTY-NOTICES.txt').then((r) => r.text())`);
ok(/KaTeX's fonts/.test(lic ?? ""), "the page's Licenses link works here too");
// a file that is not a notebook is shown as an error and never saved over (audit F8)
const broken = join(dir, "broken.ipynb"), junk = '{"cells": [ truncated';
writeFileSync(broken, junk);
await go(`${base}/nb/broken.ipynb/`);
await ready();
ok(/could not read/.test(await ev("document.querySelector('.cell .mdout')?.textContent ?? ''")), "an unreadable .ipynb shows why");
await ev("(() => { const nb = sagebrush.notebook; nb.setInput(nb.cells()[0], 'edited'); nb.flush(); })()");
await sleep(1500);
ok(readFileSync(broken, "utf8") === junk && /not saved/.test(await ev("document.querySelector('#saved').textContent")), "...and editing it does not overwrite the file: " + (await ev("document.querySelector('#saved').textContent")));
// the reactive notebook (?reactive) with the native session: graph order, a cell's own _ names, a removed definition
await go(`${base}/nb/sub/reactive.ipynb/?reactive`);
await ready();
const r = await ev(`(async () => { try {
  const nb = sagebrush.notebook;
  const res = await nb.applyEdits({ set: [{ id: nb.cells()[0].id, code: "print('c', c)" }], insert: [{ code: "a = 2\\nz = 1\\n_t = 5" }, { code: "c = a * 10" }, { code: "print(_t)" }] }, { budget: Infinity });
  const out = () => nb.cells().map((c) => c.out.textContent.trim());
  const first = out();
  await nb.applyEdits({ set: [{ id: nb.cells()[1].id, code: "a = 3" }], insert: [{ code: "print(z)" }] }, { budget: Infinity });
  return { reactive: nb.reactiveOn, ran: res.report.ran.length, first, second: out() };
} catch (e) { return { error: String(e.stack ?? e), reactive: sagebrush.notebook.reactiveOn, href: location.href }; } })()`);
if (r?.error) console.log("reactive section:", JSON.stringify(r));
ok(r.reactive && r.first[0] === "c 20" && /NameError: name '_t' is not defined/.test(r.first[3]), "reactive with the native session: graph order, and a cell's _t is its own: " + JSON.stringify(r.first));
ok(r.second[0] === "c 30" && /NameError: name 'z' is not defined/.test(r.second[4]), "...editing a cell reruns its dependents, and a removed definition is gone: " + JSON.stringify(r.second));

// file and directory names are shown as text, never run: the listing and the notebook page embed them as
// HTML-safe JSON (a name with "</script>", "<!--", quotes, U+2028)
{
  const names = ["x</script><script>window.auditHit=1</script>", "y<!--<script>window.auditHit=2</script>", "q\"'`${1}", "l\u2028m\u2029n"];
  for (const n of names) mkdirSync(join(dir, n), { recursive: true });
  // (a notebook in each, so the notebook page embeds the name too)
  for (const n of names) writeFileSync(join(dir, n, "t.ipynb"), JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }));
  let shown = true, ran = false, opened = true;
  const misses = [];
  for (const n of names) {
    const rel = encodeURIComponent(n).replace(/%2F/g, "/");
    await go(`${base}/tree/${rel}`);
    ran ||= await ev("window.auditHit !== undefined");
    shown &&= await ev(`document.querySelector(".p")?.textContent.endsWith(${JSON.stringify(n)}) && !!document.getElementById("new")`);
    await go(`${base}/nb/${rel}/t.ipynb/`);
    ran ||= await ev("window.auditHit !== undefined");
    const got = await ev("JSON.stringify(window.__SAGEBRUSH_LOCAL__ ?? null)");
    if (JSON.parse(got ?? "null")?.path !== n + "/t.ipynb") { opened = false; misses.push([n, got]); }
  }
  ok(!ran, "a name with </script>, <!--, quotes or U+2028 runs no script, in the listing or the notebook page");
  ok(shown, "...the listing shows each such path as text, its New notebook button still there");
  ok(opened, "...and the notebook page has each path exactly" + (misses.length ? ": " + JSON.stringify(misses) : ""));
}

// another page on this computer (another port: the cookie is the host's, whatever the port) can't use the server
{
  const http = await import("node:http");
  const pwned = join(dir, "pwned.txt");
  const aport = await freePort();
  const attacker = http.createServer((q, r) => r.writeHead(200, { "Content-Type": "text/html" }).end(`<script>
    (async () => {
      const nb = ${JSON.stringify(base)};
      // (a session started with the cookie, then code sent to it: text/plain, so no preflight)
      fetch(nb + "/api/session/atk/events", { mode: "no-cors", credentials: "include" }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
      await fetch(nb + "/api/session/atk/send", { method: "POST", mode: "no-cors", credentials: "include", body: JSON.stringify({ id: 1, code: "open(" + ${JSON.stringify(JSON.stringify(pwned))} + ", 'w').write('x')" }) }).catch(() => {});
      document.title = "tried";
    })();
  </script>`));
  await new Promise((r) => attacker.listen(aport, "127.0.0.1", r));
  await send("Page.navigate", { url: `http://127.0.0.1:${aport}/` });
  ok(await until("document.title === 'tried'", 15000), "...(the other page did try)");
  await sleep(4000);
  ok(!existsSync(pwned), "a page on another port of this computer can't run code through the server");
  // (nor start a session by framing the server's API: a navigation, but in a frame, and not to a page)
  const framer = http.createServer((q, r) => r.writeHead(200, { "Content-Type": "text/html" }).end(`<iframe src="${base}/api/session/framed/events"></iframe><script>setTimeout(() => (document.title = "framed"), 2500)</script>`));
  const fport = await freePort();
  await new Promise((r) => framer.listen(fport, "127.0.0.1", r));
  await send("Page.navigate", { url: `http://127.0.0.1:${fport}/` });
  ok(await until("document.title === 'framed'", 15000), "...(the other page framed the API)");
  const tok0 = /token=(\w+)/.exec(printed)[1];
  ok((await fetch(base + "/api/session/framed/stop", { method: "POST", headers: { Cookie: `sagebrush_token=${tok0}` } })).status === 404, "...and no session was started for it");
  framer.close();
  attacker.close();
  const tok = /token=(\w+)/.exec(printed)[1], cookie = `sagebrush_token=${tok}`;
  const from = (headers) => fetch(base + "/api/session/x2/stop", { method: "POST", headers: { Cookie: cookie, ...headers } }).then((r) => r.status);
  ok((await from({ Origin: `http://127.0.0.1:${aport}` })) === 403 && (await from({ "Sec-Fetch-Site": "same-site" })) === 403, "...a request from another origin or another site is refused, by its Origin or Sec-Fetch-Site");
  ok((await fetch(base + "/api/session/x2/stop", { headers: { Cookie: cookie } })).status === 405, "...and the session's actions take POST only");
  // (by node:http: fetch() sends a Host and Sec-Fetch-Mode of its own, whatever it is given)
  const { request } = await import("node:http");
  const raw = (headers) => new Promise((r) => request({ host: "127.0.0.1", port, path: "/?token=" + tok, headers }, (res) => { res.resume(); r(res.statusCode); }).on("error", () => r(0)).end());
  const hostIs = (h) => raw({ Host: h });
  ok((await raw({ Host: `127.0.0.1:${port}`, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" })) === 302, "...while the URL with the token opens from anywhere (a link in another site's terminal)");
  ok((await raw({ Host: `127.0.0.1:${port}`, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors" })) === 403, "...but not as another site's subresource");
  ok((await raw({ Host: `127.0.0.1:${port}`, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "iframe" })) === 403, "...nor in another site's frame");
  const rawPath = (path, headers, method = "GET") => new Promise((r) => request({ host: "127.0.0.1", port, path, method, headers: { Host: `127.0.0.1:${port}`, Cookie: cookie, ...headers } }, (res) => { res.resume(); r(res.statusCode); }).on("error", () => r(0)).end());
  ok((await rawPath("/api/session/nav/events", { "Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" })) === 403, "...and a navigation from elsewhere to the API is refused, even top-level");
  ok((await rawPath("/api/session/nav/events", {}, "POST")) === 405, "...and a session's events take GET only");
  // (the same path as the routes see it: encoded letters, encoded slashes, double encoding and dot segments
  // are no way around that; none of them starts a session)
  const nav = { "Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
  const variants = [["/%61pi/session/enc1/events", "enc1"], ["/api%2Fsession/enc2/events", "enc2"], ["/api%2fsession/enc3/events", "enc3"], ["/%2561pi/session/enc4/events", "enc4"],
    ["/nb/x.ipynb/%2e%2e/api/session/enc5/events", "enc5"], ["/nb/x.ipynb/%2E/api/session/enc6/events", "enc6"], ["/%41PI/session/enc7/events", "enc7"]];
  const got = [];
  for (const [p] of variants) got.push(await rawPath(p, nav));
  const started = [];
  for (const [, id] of variants) if ((await rawPath(`/api/session/${id}/stop`, {}, "POST")) !== 404) started.push(id);
  ok(got.every((c) => c >= 400) && !started.length, `...nor does an encoded path to the API: ${JSON.stringify(got)}, sessions started: ${JSON.stringify(started)}`);
  ok((await rawPath("/tree/%E0%A4%A", {})) === 400 && (await rawPath("/tree/a%5Cb", {})) === 400, "...and a malformed escape or an encoded backslash is a bad path");
  ok((await hostIs(`127.0.0.1:${aport}`)) === 403 && (await hostIs("127.0.0.1")) === 403 && (await hostIs(`localhost:${port}`)) === 302, "...and the Host must be its own host and port (fetch() can't send another)");
}

cleanup();
console.log(failures ? `${failures} failures` : "all passed");
process.exit(failures ? 1 : 0);
