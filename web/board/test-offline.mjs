// A board with code downloaded as HTML (export.ts, engine.ts): its code runs
// in the file.  With "Include Python" the file carries the engine and runs
// with the network off; without, it fetches the engine it was made with from
// the site, by its id, and says so when the site can't be reached.  An engine
// whose bytes are not its own (an edited file, a changed server) is refused.
// Set to the latest, the file takes the site's latest engine when its api is
// the file's, else its own.  Download as HTML asks for both choices when the
// board has code.  The site here is this test's own server (web/dist, as
// sagebrush.space serves /engine/: readable from any page), so it can serve
// changed bytes and another engine.  Build web/dist first, then
//   node web/board/test-offline.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
// the site: web/dist, and what a check puts in its place (path: bytes)
const overrides = new Map();
const server = createServer((req, res) => {
  const path = decodeURIComponent(req.url.split("?")[0]);
  let body = overrides.get(path);
  if (!body) {
    const f = normalize(join(dist, path.endsWith("/") ? path + "index.html" : path));
    if (!f.startsWith(dist)) { res.writeHead(403); return res.end(); }
    try { body = readFileSync(f); } catch { res.writeHead(404); return res.end(); }
  }
  res.writeHead(200, { "content-type": TYPES[extname(path)] ?? (path.endsWith("/") ? "text/html" : "application/octet-stream"), ...(path.startsWith("/engine/") ? { "access-control-allow-origin": "*" } : {}) });
  res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const site = `http://127.0.0.1:${server.address().port}/`;
const own = JSON.parse(readFileSync(join(dist, "engine", "latest.json"), "utf8"));
const ownDir = join(dist, "engine", own.id);

const port = Number(process.env.CDP_PORT ?? 9465);
const dir = mkdtempSync(join(tmpdir(), "sb-offline-")), profile = mkdtempSync(join(tmpdir(), "sb-offline-prof-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); let errors = [], requests = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
  if (m.method === "Network.requestWillBeSent" && !/^(data|blob|file|about):/.test(m.params.request.url)) requests.push(m.params.request.url);
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const online = (on) => send("Network.emulateNetworkConditions", { offline: !on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
// a file, opened afresh (through a blank page: nothing of the last page's is counted)
const open = async (file) => {
  await send("Page.navigate", { url: "about:blank" });
  await until("location.href === 'about:blank'", 5000);
  await sleep(200);
  requests = []; errors = [];
  await send("Page.navigate", { url: "file://" + file });
  await until("window.sagebrush?.board?.snapshot().items.length > 0", 30000);
};
// live.json's code, run: its last items' outputs
const ran = (ms = 90000) => until("window.sagebrush.board.outputs().then((os) => os.length === 5 && os.every((o) => o.state === '') && /^111 steps/.test(os.find((o) => o.id === 'path').output))", ms);
const caption = () => ev("document.querySelector('[data-sbb=say]').textContent");
// (the engine's parts a file carries; board.js, in it too, has the tag's template)
const parts = (html) => [...html.matchAll(/<script type="application\/octet-stream" data-sb-engine="(sagebrush-[^"]+)">/g)].map((m) => m[1]);

try {
  for (const m of ["Page.enable", "Runtime.enable", "Network.enable"]) await send(m);
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  await online(true);
  await send("Page.navigate", { url: `${site}board/?runner=0&doc=${encodeURIComponent("examples/live.json")}` });
  await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000);
  await ev("localStorage.clear(), 1");
  // Download as HTML, for a board with code: the two choices first
  await ev("document.querySelector('[data-sbb=html]').click(), 1");
  check(await until("document.querySelector('[data-sbb=htmldlg]').open", 3000), "a board with code: Download as HTML asks first");
  check(await ev("!document.querySelector('[data-sbb=html-py-set]').hidden && !document.querySelector('[data-sbb=html-py]').checked && /MB/.test(document.querySelector('[data-sbb=html-size]').textContent)"), "...whether to include Python (off), and how much more that is");
  check(await ev("document.querySelector('[data-sbb=htmlform] input[name=engine]:checked').value === 'pinned'"), "...and the version its code runs with: the one it was saved with, by default");
  await ev("document.querySelector('[data-sbb=htmldlg]').close(), 1");

  // the two files: with Python, and without
  const withPy = await ev("window.sagebrush.board.exportHtml({ python: true })"), withoutPy = await ev("window.sagebrush.board.exportHtml()");
  const fa = join(dir, "with-python.html"), fb = join(dir, "without-python.html");
  writeFileSync(fa, withPy); writeFileSync(fb, withoutPy);
  check(parts(withPy).sort().join() === ["sagebrush-analyze.js", "sagebrush-engine.wasm", "sagebrush-notebook.js", "sagebrush-viewer3d.js", "sagebrush-worker.js"].join(), "the file with Python carries the engine's parts (not the Sage library, for a Python board): " + parts(withPy).join());
  check(!parts(withoutPy).length && withoutPy.includes(`"id":"${own.id}"`) && withoutPy.includes(JSON.stringify(site)), "the file without carries none, only where its engine is: the site and the engine's id");
  console.log(`with Python ${(withPy.length / 1e6).toFixed(1)} MB, without ${(withoutPy.length / 1e3).toFixed(0)} KB`);

  // with Python, the network off: its code runs, and nothing is fetched
  await online(false);
  await open(fa);
  check(await ran(), "the file with Python runs its code with the network off: " + await caption());
  check(!requests.length, "...asking the network for nothing: " + requests.slice(0, 3).join(", "));
  check(!errors.length, "...without errors: " + errors.slice(0, 3).join(" | "));
  check(await ev("(() => { const f = [...document.querySelectorAll('iframe')]; return f.length === 1 && f[0].getAttribute('sandbox') === 'allow-scripts' && f[0].hasAttribute('srcdoc'); })()"), "...Python running in the runner's sandboxed frame (allow-scripts only), not in the file's page");
  // exported again from that file, with Python: the same file
  check((await ev("window.sagebrush.board.exportHtml({ python: true })")) === withPy, "exported again from the file with Python: the same file");

  // without Python: its engine from the site, by its id
  await online(true);
  await open(fb);
  check(await ran(), "the file without Python runs its code, with its engine from the site: " + await caption());
  check(requests.length > 0 && requests.every((u) => u.startsWith(`${site}engine/${own.id}/`)), "...only the engine it was made with: " + requests.slice(0, 4).join(", "));
  // ...and with the network off, it says why it can't
  await online(false);
  await open(fb);
  check(await until("/can't run here/.test(document.querySelector('[data-sbb=say]').textContent) && /can't be reached/.test(document.querySelector('[data-sbb=say]').textContent)", 30000), "offline, the file without Python says its code can't run, and why: " + await caption());
  await online(true);

  // a Sage board with Python: the Sage library in the file too; Sage runs
  // offline, and 3D, its viewer from the file
  await send("Page.navigate", { url: `${site}board/?runner=0&doc=${encodeURIComponent("examples/polynomials.json")}` });
  await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000);
  const sageHtml = await ev("window.sagebrush.board.exportHtml({ python: true })");
  check(parts(sageHtml).includes("sagebrush-precompiled.json"), "a Sage board's file with Python carries the Sage library: " + parts(sageHtml).join());
  const fs = join(dir, "sage.html");
  writeFileSync(fs, sageHtml);
  console.log(`a Sage board with Python ${(sageHtml.length / 1e6).toFixed(1)} MB`);
  await online(false);
  await open(fs);
  check(await until("window.sagebrush.board.outputs().then((os) => os.length > 0 && os.every((o) => o.state === '') && /\\(x - 3\\)/.test(os.find((o) => o.id === 'roots').output))", 120000), "a Sage board with Python runs offline: " + await caption() + " " + JSON.stringify(await ev("window.sagebrush.board.outputs()")).slice(0, 300));
  await ev("window.sagebrush.board.edit((d) => { const walk = (ns) => { for (const x of ns) { if (x.id === 'roots') x.code = 'icosahedron()'; if (x.children) walk(x.children); } }; walk(d.nodes ?? []); for (const p of d.pages ?? []) walk(p.nodes ?? []); }).then(() => 1)");
  check(await until("!!window.SagebrushViewer3d && !!document.querySelector('figure.plot3d svg')", 90000), "3D in the file, offline: its viewer, from the file");
  check(!requests.length, "...asking the network for nothing: " + requests.slice(0, 3).join(", "));
  await online(true);

  // an edited file: refused
  const fake = Buffer.from(gzipSync(Buffer.from("export const createNotebook = () => { throw new Error('not the engine'); };"))).toString("base64");
  const edited = withPy.replace(/(<script type="application\/octet-stream" data-sb-engine="sagebrush-notebook\.js">)[^<]*/, (_, open) => open + fake);
  check(edited !== withPy, "(the edit was made)");
  const fe = join(dir, "edited.html");
  writeFileSync(fe, edited);
  await open(fe);
  check(await until("/refused/.test(document.querySelector('[data-sbb=say]').textContent)", 30000), "an edited engine in the file is refused, and the caption says so: " + await caption());
  // a server serving changed bytes: refused
  overrides.set(`/engine/${own.id}/sagebrush-analyze.js`, Buffer.from("self.onmessage = () => {};"));
  await open(fb);
  check(await until("/refused/.test(document.querySelector('[data-sbb=say]').textContent)", 30000), "an engine part the server changed is refused: " + await caption());
  overrides.clear();

  // the latest: another engine, if its api is the file's; else its own
  await send("Page.navigate", { url: `${site}board/?runner=0&doc=${encodeURIComponent("examples/live.json")}` });
  await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000);
  await ev("document.querySelector('[data-sbb=html]').click(), 1");
  await until("document.querySelector('[data-sbb=htmldlg]').open", 3000);
  await ev("document.querySelector('[data-sbb=htmlform] input[name=engine][value=latest]').click(), document.querySelector('[data-sbb=html-go]').click(), 1");
  check(await until("window.sagebrush.board.snapshot().doc.engine === 'latest'", 3000), "choosing the latest keeps it in the board");
  const latestHtml = await ev("window.sagebrush.board.exportHtml()");
  const fl = join(dir, "latest.html");
  writeFileSync(fl, latestHtml);
  const other = "0123456789abcdef0123", manifest = JSON.parse(readFileSync(join(ownDir, "manifest.json"), "utf8"));
  for (const f of Object.keys(manifest.files)) overrides.set(`/engine/${other}/${f}`, readFileSync(join(ownDir, f)));
  overrides.set(`/engine/${other}/manifest.json`, Buffer.from(JSON.stringify({ ...manifest, id: other })));
  overrides.set("/engine/latest.json", Buffer.from(JSON.stringify({ id: other, api: own.api })));
  await open(fl);
  check(await ran(), "set to the latest, the file runs its code: " + await caption());
  check(requests.some((u) => u.startsWith(`${site}engine/${other}/`)) && !requests.some((u) => u.startsWith(`${site}engine/${own.id}/`)), "...with the site's latest engine: " + requests.slice(0, 4).join(", "));
  overrides.set("/engine/latest.json", Buffer.from(JSON.stringify({ id: other, api: own.api + 1 })));
  await open(fl);
  check(await ran(), "the latest with another api: the file runs its code: " + await caption());
  check(!requests.some((u) => u.startsWith(`${site}engine/${other}/`)) && requests.some((u) => u.startsWith(`${site}engine/${own.id}/`)), "...with its own engine: " + requests.slice(0, 4).join(", "));
  overrides.clear();
} catch (e) {
  fails.push(String(e?.stack ?? e));
} finally {
  ws.close();
  chrome.kill();
  server.close();
  await sleep(200);
  try { rmSync(profile, { recursive: true, force: true }); if (!process.env.KEEP) rmSync(dir, { recursive: true, force: true }); else console.log("files in", dir); } catch {}
}
console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
