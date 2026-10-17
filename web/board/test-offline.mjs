// A board with code downloaded as HTML (export.ts, engine.ts): its code runs
// in the file.  In offline mode the file carries the engine and runs
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
import { createHash } from "node:crypto";
import { engineIdText } from "../engine-id.mts";
import { devtoolsPort } from "../test-port.mjs";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
// the site: web/dist, and what a check puts in its place (path: bytes)
const overrides = new Map();
// (an engine not published at the site's engine/<id>/, as on a dev site)
let unpublished = false;
const server = createServer((req, res) => {
  const path = decodeURIComponent(req.url.split("?")[0]);
  if (unpublished && path.startsWith("/engine/")) { res.writeHead(404); return res.end(); }
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
// (the engine's Python library: its chunks' sources, and Sage's compiled modules: web/lib-chunks.mts)
const ownFiles = Object.keys(JSON.parse(readFileSync(join(ownDir, "manifest.json"), "utf8")).files);
const libSrc = ownFiles.filter((f) => /^lib\/.*\.src\./.test(f)).sort(), libSage = ownFiles.filter((f) => /^lib\/(core|sci|sage)\.pre\./.test(f)).sort();

let port = Number(process.env.CDP_PORT) || 0;
const dir = mkdtempSync(join(tmpdir(), "sb-offline-")), profile = mkdtempSync(join(tmpdir(), "sb-offline-prof-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!port) port = await devtoolsPort(profile);
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
// (what a check of the requests says: how many there were, and the ones it didn't expect)
const odd = (ok) => { const bad = requests.filter((u) => !ok(u)); return `${requests.length} requests, ${bad.length} unexpected${bad.length ? ": " + bad.slice(0, 6).join(", ") : ""}`; };
const caption = () => ev("document.querySelector('[data-sbb=say]').textContent");
const engineNow = () => ev("window.sagebrush.board.engine().then((v) => v?.engine ?? null)");
// (the engine's parts a file carries; board.js, in it too, has the tag's template)
const parts = (html) => [...html.matchAll(/<script type="application\/octet-stream" data-sb-engine="((?:sagebrush-|lib\/)[^"]+)">/g)].map((m) => m[1]);

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
  // (its engine not published at the site's engine/<id>/: the file with Python is made from this page's own files, the same)
  unpublished = true;
  const fromOwn = await ev("window.sagebrush.board.exportHtml({ python: true }).catch((e) => 'failed: ' + e.message)");
  unpublished = false;
  check(fromOwn === withPy, "with its engine not published (a dev site), the file with Python is made all the same: " + String(fromOwn).slice(0, 80));
  const fa = join(dir, "with-python.html"), fb = join(dir, "without-python.html");
  writeFileSync(fa, withPy); writeFileSync(fb, withoutPy);
  check(libSrc.length > 5 && libSage.length === 3 && parts(withPy).sort().join() === [...libSage, ...libSrc, "sagebrush-analyze.js", "sagebrush-engine.wasm", "sagebrush-notebook.js", "sagebrush-viewer3d.js", "sagebrush-graphview.js", "sagebrush-worker.js"].sort().join(), "the file in offline mode carries every part, the whole Python library and Sage's compiled modules too (a Python board may become a Sage one): " + parts(withPy).join());
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
  // offline, its board made a Sage board and the page reloaded: its code
  // runs, in Sage, from what the file carries (William's report); and a
  // module no mode's start loads (heapq: its chunk read when it is imported,
  // web/lib-lazy.ts)
  await ev("window.sagebrush.board.edit((d) => { d.mode = 'sage'; const walk = (ns) => { for (const x of ns) { if (x.id === 'path') x.code = 'import heapq\\npath = [1] * 111\\nprint(len(path), \"steps\", factor(2^64 + 1), heapq.nsmallest(1, [3, 2]))'; if (x.children) walk(x.children); } }; walk(d.nodes ?? []); }).then(() => 1)");
  await sleep(500);
  requests = []; errors = [];
  await send("Page.reload", {});
  await until("window.sagebrush?.board?.snapshot().items.length > 0", 30000);
  check(await until("window.sagebrush.board.outputs().then((os) => /274177 \\* 67280421310721 \\[2\\]/.test(os.find((o) => o.id === 'path')?.output ?? ''))", 120000), "offline, made a Sage board and reloaded, the file runs its code in Sage, a module imported from a part of the library loaded then too: " + await caption());
  check(!requests.length, "...asking the network for nothing: " + requests.slice(0, 3).join(", "));

  // a file made before offline mode carried every language's runtime (no
  // Sage compiled modules), made a Sage board: those from the site, by the
  // engine's id
  await online(true);
  const older = withPy.replace(/<script type="application\/octet-stream" data-sb-engine="lib\/[\w.-]+\.pre\.[0-9a-f]+\.json">[^<]*<\/script>\n?/g, "");
  check(!parts(older).some((p) => /\.pre\./.test(p)) && parts(older).length === 6 + libSrc.length, "(an older file: no Sage compiled modules)");
  const fo = join(dir, "older.html");
  writeFileSync(fo, older.replace('"nodes":[', '"mode":"sage","nodes":['));
  await open(fo);
  check(await until("window.sagebrush.board.outputs().then((os) => os.length === 5 && os.every((o) => o.state === ''))", 120000), "an older file made a Sage board runs online, the Sage library from the site: " + await caption());
  const sageLib = (u) => libSage.some((f) => u === `${site}engine/${own.id}/${f}`);
  check(requests.length > 0 && requests.every(sageLib), "...only Sage's compiled modules: " + odd(sageLib));

  // without Python: its engine from the site, by its id
  await open(fb);
  check(await ran(), "the file without Python runs its code, with its engine from the site: " + await caption());
  check(requests.length > 0 && requests.every((u) => u.startsWith(`${site}engine/${own.id}/`)), "...only the engine it was made with: " + odd((u) => u.startsWith(`${site}engine/${own.id}/`)));
  check((await engineNow()) === own.id, "...and engine() says so, as the ⋯ menu does: " + (await engineNow()));
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
  check(libSage.every((f) => parts(sageHtml).includes(f)), "a Sage board's file with Python carries Sage's compiled modules: " + parts(sageHtml).join());
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
  // (another engine: the same files, one more header, so another id, web/engine-id.mts)
  const manifest = JSON.parse(readFileSync(join(ownDir, "manifest.json"), "utf8"));
  const otherFiles = { ...manifest.files, "sagebrush-worker.js": { ...manifest.files["sagebrush-worker.js"], headers: { ...manifest.files["sagebrush-worker.js"].headers, "X-Test": "another engine" } } };
  const other = createHash("sha256").update(engineIdText(manifest.api, otherFiles)).digest("hex").slice(0, 20);
  for (const f of Object.keys(manifest.files)) overrides.set(`/engine/${other}/${f}`, readFileSync(join(ownDir, f)));
  overrides.set(`/engine/${other}/manifest.json`, Buffer.from(JSON.stringify({ ...manifest, id: other, files: otherFiles })));
  overrides.set("/engine/latest.json", Buffer.from(JSON.stringify({ id: other, api: own.api })));
  await open(fl);
  check(await ran(), "set to the latest, the file runs its code: " + await caption());
  check(requests.some((u) => u.startsWith(`${site}engine/${other}/`)) && !requests.some((u) => u.startsWith(`${site}engine/${own.id}/`)), "...with the site's latest engine: " + odd((u) => u.startsWith(`${site}engine/${other}/`) || u === `${site}engine/latest.json`));
  check((await engineNow()) === other, "...and engine() says the engine that ran it, the latest, not the one the file was made with (CORR-20A-1): " + (await engineNow()));
  // a manifest whose content doesn't give its id: not taken (HARD-CAC-4)
  const forged = "0123456789abcdef0123";
  for (const f of Object.keys(manifest.files)) overrides.set(`/engine/${forged}/${f}`, readFileSync(join(ownDir, f)));
  overrides.set(`/engine/${forged}/manifest.json`, Buffer.from(JSON.stringify({ ...manifest, id: forged })));
  overrides.set("/engine/latest.json", Buffer.from(JSON.stringify({ id: forged, api: own.api })));
  await open(fl);
  check(await ran(), "the latest with a manifest that isn't its id's: the file runs its code: " + await caption());
  check(!requests.some((u) => u.startsWith(`${site}engine/${forged}/`) && !u.endsWith("/manifest.json")) && requests.some((u) => u.startsWith(`${site}engine/${own.id}/`)), "...with its own engine: " + odd((u) => u.startsWith(`${site}engine/${own.id}/`) || u.startsWith(`${site}engine/${forged}/manifest.json`) || u === `${site}engine/latest.json`));
  check((await engineNow()) === own.id, "...and engine() says its own: " + (await engineNow()));
  overrides.set("/engine/latest.json", Buffer.from(JSON.stringify({ id: other, api: own.api + 1 })));
  await open(fl);
  check(await ran(), "the latest with another api: the file runs its code: " + await caption());
  check(!requests.some((u) => u.startsWith(`${site}engine/${other}/`)) && requests.some((u) => u.startsWith(`${site}engine/${own.id}/`)), "...with its own engine: " + odd((u) => u.startsWith(`${site}engine/${own.id}/`) || u.startsWith(`${site}engine/${other}/manifest.json`) || u === `${site}engine/latest.json`));
  check((await engineNow()) === own.id, "...and engine() says its own: " + (await engineNow()));
  overrides.clear();

  // Outputs carried (design/outputs.md, section 3): a board's slow items'
  // outputs go in the file; opened, it shows them at once, marked as the
  // file's, and runs the rest; exported again, it carries them again
  await send("Page.navigate", { url: `${site}board/?runner=0&doc=${encodeURIComponent("examples/live.json")}` });
  await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000);
  await ev("localStorage.clear(), 1");
  const slowStamp = "import time, os\nt0 = time.time()\nwhile time.time() - t0 < 2.3:\n    pass\nstamp = os.urandom(8).hex()\nprint('s ran:', stamp)";
  const slow = { title: "Carried", seed: "c".repeat(64), nodes: [{ id: "s", code: slowStamp }, { id: "d", code: "print('d sees', stamp)" }, { id: "f", code: "print('fast')" }] };
  const outs = async () => Object.fromEntries((await ev("window.sagebrush.board.outputs()")).map((o) => [o.id, o]));
  await ev(`window.sagebrush.board.load(${JSON.stringify(slow)}).then(() => 1)`);
  check(await until("window.sagebrush.board.outputs().then((os) => os.length === 3 && os.every((o) => o.state === ''))", 60000), "a board with a slow item ran");
  const before = await outs();
  await ev("document.querySelector('[data-sbb=html]').click(), 1");
  check(await until("document.querySelector('[data-sbb=htmldlg]').open && !document.querySelector('[data-sbb=html-out-set]').hidden", 5000) && (await ev("document.querySelector('[data-sbb=html-out]').checked && /kB/.test(document.querySelector('[data-sbb=html-out-size]').textContent)")), "Download as HTML offers its slow items' outputs (on), and their size");
  await ev("document.querySelector('[data-sbb=htmldlg]').close(), 1");
  const withOut = await ev("window.sagebrush.board.exportHtml({ outputs: true })"), noOut = await ev("window.sagebrush.board.exportHtml()");
  // (the tag itself: board.js, inline in the file, has its template too)
  const carriedOf = (html) => JSON.parse(/<script type="application\/json" id="sb-outputs">(\[[^<]*\])<\/script>/.exec(html)?.[1] ?? "[]");
  const carried = carriedOf(withOut);
  check(carried.length === 2 && carried.every((e) => /^[0-9a-f]{64}$/.test(e.key) && e.total > 2000) && !carriedOf(noOut).length, "the file carries s's and d's outputs (over 2 s from root), not f's; without, none: " + carried.map((e) => e.total).join());
  const fc = join(dir, "carried.html");
  writeFileSync(fc, withOut);
  await open(fc);
  check(await until("window.sagebrush.board.outputs().then((os) => os.find((o) => o.id === 'f')?.state === '' && /fast/.test(os.find((o) => o.id === 'f').output))", 90000), "opened, the file runs its fast item: " + await caption());
  const inFile = await outs();
  check(inFile.s.output === before.s.output && inFile.d.output === before.d.output && /^s ran: [0-9a-f]{16}/.test(inFile.s.output), "...and shows the slow ones' outputs it carries, not run again: " + JSON.stringify([before.s.output, inFile.s.output]));
  await ev("window.board.focus(['s'], true), window.board.render(), 1");
  check(await until("(() => { const el = document.querySelector('[data-code=s] .board-code-out > [data-cached]'); return !!el && getComputedStyle(el, '::before').content.includes('carried in this file'); })()", 5000), "...saying they were carried in the file");
  const again = carriedOf(await ev("window.sagebrush.board.exportHtml({ outputs: true })"));
  check(again.map((e) => e.key).sort().join() === carried.map((e) => e.key).sort().join(), "exported again from the file, it carries them again: " + again.length);
  // changed in the file, s runs: its own output, no longer the carried one
  await ev(`window.sagebrush.board.edit((d) => { d.nodes.find((x) => x.id === "s").code = ${JSON.stringify(slowStamp + "\n1")}; }).then(() => 1)`);
  check(await until(`window.sagebrush.board.outputs().then((os) => os.every((o) => o.state === '') && os.find((o) => o.id === 's').output !== ${JSON.stringify(before.s.output)})`, 60000), "changed in the file, s runs again, and d with it");
  // an item changed and run while what is carried is being found: its new
  // output is never carried under its old key (CORR-2D0-1; the first hash
  // held until the run is over)
  const oldKey = (await ev("window.sagebrush.board.outputKeys()")).s.key;
  await ev(`(() => { const d = crypto.subtle.digest.bind(crypto.subtle); let armed = true; window.__gate = null; crypto.subtle.digest = (a, b) => { if (!armed) return d(a, b); armed = false; return new Promise((res) => { window.__gate = () => res(d(a, b)); }); }; window.__carry = window.sagebrush.board.exportHtml({ outputs: true }); })(), 1`);
  check(await until("!!window.__gate", 10000), "(the carry is held, hashing)");
  await ev(`window.sagebrush.board.edit((d) => { d.nodes.find((x) => x.id === "s").code = ${JSON.stringify(slowStamp.replace("s ran:", "NEW s ran:"))}; }).then(() => 1)`);
  await until("window.sagebrush.board.outputs().then((os) => /NEW/.test(os.find((o) => o.id === 's').output) && os.every((o) => o.state === ''))", 60000);
  await ev("window.__gate(), 1");
  const racedHtml = await ev("window.__carry"), raced = carriedOf(racedHtml);
  // (and the file's source is the same moment's: an output of the new code only beside the new code, CORR-2BF-1)
  const racedDoc = JSON.parse(/<script type="application\/json" id="sb-doc">([^<]*)<\/script>/.exec(racedHtml)[1]);
  const newSource = /NEW/.test(racedDoc.nodes.find((x) => x.id === "s").code);
  check(raced.every((e) => !JSON.stringify(e.outputs).includes("NEW") || newSource), "...and the file's source is theirs: no output of code the file doesn't have (source " + (newSource ? "new" : "old") + ")");
  const newKey = (await ev("window.sagebrush.board.outputKeys()")).s.key;
  const bad = raced.filter((e) => (e.key === oldKey && JSON.stringify(e.outputs).includes("NEW")) || (e.key === newKey && !JSON.stringify(e.outputs).includes("NEW")));
  check(newKey !== oldKey && !bad.length, "changed and run while the outputs to carry were found: each carried output is its key's: " + raced.map((e) => (e.key === oldKey ? "old" : e.key === newKey ? "new" : "other") + ":" + /NEW/.test(JSON.stringify(e.outputs))).join());
} catch (e) {
  fails.push(String(e?.stack ?? e));
} finally {
  ws.close();
  chrome.kill();
  server.close();
  await sleep(200);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); if (!process.env.KEEP) rmSync(dir, { recursive: true, force: true }); else console.log("files in", dir); } catch {}
}
console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
