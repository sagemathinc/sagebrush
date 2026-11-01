// "Export all current files (.zip)" (export plan E1 r2d, web/workspace/export) in headless Chromium against the
// built site.  The archive is checked outside the browser by Python's zipfile and by unzip -t: every member's bytes,
// the manifest's sizes and SHA-256 (and the data files' bytes against the workspace's own), the manifest the last
// member and its central record the last one, folders as directory members without a hash.  Then: the documents'
// bytes equal to what Download writes; saves before and after a member's capture (data file, notebook, board); every
// structural change during an export stops it; files not on this device are refused; the sinks' cleanup; the caps,
// in preflight and on growth after it; the spool; Cancel within its bound; near-cap documents written in bounded
// pieces of work; the long-task instrument's own check.
// Serve web/dist first (python3 web/serve.py 8765), then
//   node web/workspace/test-export.mjs
// ONLY=a,b runs those scenarios (the panel's setup always runs); CHUNK=file serves that file as sagebrush-export.js
// (the controls, web/workspace/test-export-controls.mjs).
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const ONLY = new Set((process.env.ONLY ?? "").split(",").filter(Boolean));
const runs = (name) => !ONLY.size || ONLY.has(name);
let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-export-"));
const out = mkdtempSync(join(tmpdir(), "sb-export-out-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!port) port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = []; const consoleLines = [];
let servedWorker = 0;
const chunk = process.env.CHUNK ? readFileSync(process.env.CHUNK) : null, chunkWorker = process.env.CHUNK_WORKER ? readFileSync(process.env.CHUNK_WORKER) : null;
// (r2c "identity", grader's P-5: the reference is b00fb43f's chunk and worker as campaign 3 shipped them (its
// SHIPPED.sha256), kept beside this test and pinned here; served in place of the built ones while `serve.ref` is set)
const REF_DIR = join(dirname(fileURLToPath(import.meta.url)), "export-ref-b00fb43f");
const REF_SHA = { chunk: "052bce74768979feaf9f95210a014bb9367036b90d5dbd5384018ca0b94fd278", worker: "bb991e310357b21d5f4b14859964887aab5433dab330b7f46e5aa5be98ea7d1d" };
const serve = { ref: false, servedChunk: 0, servedWorker: 0 };
let REF = null;
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
  if (m.method === "Page.javascriptDialogOpening") send("Page.handleJavaScriptDialog", { accept: true });
  if (m.method === "Runtime.consoleAPICalled") consoleLines.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200));
  // (a control's chunk, in place of the built one)
  if (m.method === "Fetch.requestPaused") {
    const isWorker = /sagebrush-export-worker\.js/.test(m.params.request.url), body = serve.ref ? (isWorker ? REF.worker : REF.chunk) : isWorker ? chunkWorker : chunk;
    if (serve.ref) serve[isWorker ? "servedWorker" : "servedChunk"] = (serve[isWorker ? "servedWorker" : "servedChunk"] ?? 0) + 1;
    if (isWorker && chunkWorker) servedWorker++;
    // (paused at the response: the server's own headers kept, the body replaced; a worker's script needs the page's
    // Cross-Origin-Embedder-Policy on it, or the worker isn't started)
    const headers = (m.params.responseHeaders ?? []).filter((h) => !/^(content-length|content-encoding|etag|last-modified)$/i.test(h.name));
    if (body) send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200, responseHeaders: headers.length ? headers : [{ name: "Content-Type", value: "text/javascript" }], body: body.toString("base64") });
    else send("Fetch.continueRequest", { requestId: m.params.requestId });
  }
};
const send = (method, params = {}, sessionId) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)).slice(0, 400)); return r.result?.value; };
/** A second tab of the same site (the same profile: its OPFS and its locks are shared), for the scenarios two tabs
 * need; its own ev and until. */
async function secondTab() {
  const { targetId } = await send("Target.createTarget", { url: base });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m, {}, sessionId);
  const ev2 = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)).slice(0, 400)); return r.result?.value; };
  const until2 = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev2(expr).catch(() => false)) return true; await sleep(100); } return false; };
  return { ev: ev2, until: until2, close: () => send("Target.closeTarget", { targetId }) };
}
const until = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
const go = async (url) => { await send("Page.navigate", { url }); await sleep(300); };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };

const W = "window.sagebrush?.workspace";
/** The no-OPFS refusal, word for word (r2c P-8, @sagebrush's condition). */
const NO_OPFS = "This workspace is too large to export in this browser without its file storage. Use a browser with file storage (Chrome, Edge) or the desktop app. Nothing was saved.";
const S = "document.querySelector('#wssidebar')";
const P = "document.querySelector('.sbfprev')";
const panelButton = (re) => ev(`(() => { const b = [...document.querySelectorAll(".sbfprev button")].find((x) => ${re}.test(x.textContent)); if (!b) throw new Error("no button " + ${JSON.stringify(String(re))}); b.click(); return 1; })()`);
const panelText = () => ev(`${P}?.textContent ?? ""`);
const closeFlow = () => ev(`(() => { [...(${P}?.querySelectorAll("button") ?? [])].filter((b) => b.textContent === "Close").forEach((b) => b.click()); return 1; })()`);

/** IndexedDB, raw: one request on `db`/`store` (the test's own hand on storage: missing bytes, injected ops). */
const IDB = `((db, store, f) => new Promise((ok, no) => { const r = indexedDB.open(db); r.onsuccess = () => { const d = r.result, tx = d.transaction(store, "readwrite"), q = f(tx.objectStore(store)); tx.oncomplete = () => { d.close(); ok(q?.result ?? null); }; tx.onerror = () => no(tx.error); }; r.onerror = () => no(r.error); }))`;
const idb = (db, store, f) => ev(`${IDB}(${JSON.stringify(db)}, ${JSON.stringify(store)}, ${f})`);
/** The last export prepared (the workspace's meta "export:last"). */
const LAST = `${IDB}("sagebrush-workspace", "meta", (s) => s.get("export:last"))`;
const lastAt = () => ev(`${LAST}.then((l) => l?.at ?? null)`);
const scratchCount = () => ev(`navigator.storage.getDirectory().then((r) => r.getDirectoryHandle("sagebrush-export", { create: true })).then(async (d) => { let n = 0; for await (const _ of d.keys()) n++; return n; })`);
const openFiles = async () => {
  await until(`!!document.querySelector("#wsfilesbtn") && !document.querySelector("#wsfilesbtn").hidden`, 60000);
  if (await ev(`${S}.hidden`)) await ev(`(() => { document.querySelector("#wsfilesbtn").click(); return 1; })()`);
  await until(`!${S}.hidden`);
  await until(`!!document.querySelector("#wssidebar .fmeter")`, 60000);
};
/** The test hooks for this page (run.ts's TestHooks), with the handed-over archive kept in window.__exp (and the
 * handoff's cleanup let run at once). */
const hooks = (extra = "") => ev(`(() => { window.__exp = null; window.__SB_EXPORT_TEST__ = { noPicker: true, onHand: (blob, name, then) => { window.__exp = { blob, name, then }; }, stats: {}, ${extra} }; return 1; })()`);
/** The handoff's cleanup let run (the test has read the archive), then its end awaited: no export's lock left. */
const LOCKS = `navigator.locks.query().then((q) => q.held.filter((l) => l.name.startsWith("sagebrush-export:")).length)`;
const handed = async () => {
  const n = await ev(LOCKS);
  await ev(`(() => { window.__exp?.then?.(); return 1; })()`);
  await until(`${LOCKS}.then((m) => m < ${n} || m === 0)`, 10000);
};
const startFlow = async () => {
  if (!(await ev(`!!${P}`))) await ev(`(() => { document.querySelector("#wssidebar .fmeter").click(); return 1; })()`);
  await ev(`(() => { window.__exp = null; window.__picked = null; return 1; })()`);
  await closeFlow();
  await until(`!!${P} && [...${P}.querySelectorAll("button")].some((b) => /^Export all current files/.test(b.textContent))`);
  await panelButton(/^Export all current files/);
};
/** One export to its end; the archive's bytes saved to `file`.  { stopped: text } if it stopped or was refused. */
async function exportOnce(file, { refuseAtReady = false, picked = false, keep = false } = {}) {
  await startFlow();
  const readyOrStop = await until(`[...(${P}?.querySelectorAll("button") ?? [])].some((b) => /^(Save…|Export again)$/.test(b.textContent))`, 180000);
  if (!readyOrStop) {
    const locks = await ev(`navigator.locks.query().then((q) => JSON.stringify({ held: q.held.map((l) => l.name), pending: q.pending.map((l) => l.name) }))`).catch((e) => String(e));
    const t = (await panelText()).slice(-300);
    await ev(`(() => { [...(${P}?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Cancel")?.click(); return 1; })()`);
    await until(`[...(${P}?.querySelectorAll("button") ?? [])].some((b) => b.textContent === "Close")`, 10000);
    await closeFlow();
    return { stopped: "no ready state: " + t + " | locks " + locks + " | console " + consoleLines.slice(-8).join(" / ") };
  }
  if (await ev(`[...${P}.querySelectorAll("button")].some((b) => b.textContent === "Export again")`)) {
    const t = (await panelText()).slice(-600);
    await closeFlow();
    return { stopped: t };
  }
  if (refuseAtReady) { const readyText = await panelText(); await panelButton(/^Cancel$/); return { readyText }; }
  await panelButton(/^Save…$/);
  const ended = await until(`!!window.__exp || ${picked ? "!!window.__picked || " : ""}[...(${P}?.querySelectorAll("button") ?? [])].some((b) => b.textContent === "Export again")`, 300000);
  const text = await panelText();
  if (picked) {
    if (await ev(`!!window.__picked`)) await ev(`(() => { window.__exp = { blob: window.__picked, name: "picked.zip" }; return 1; })()`);
    else { await closeFlow(); return { stopped: text.slice(-600) }; }
  }
  if (!ended || !(await ev(`!!window.__exp`))) { await closeFlow(); return { stopped: text.slice(-600) }; }
  const b64 = await ev(`(async () => { const b = new Uint8Array(await window.__exp.blob.arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); })()`);
  writeFileSync(file, Buffer.from(b64, "base64"));
  if (!keep) await handed();
  // (any paragraph starting so: the panel's status line is a paragraph before it)
  await until(`[...(${P}?.querySelectorAll("p") ?? [])].some((p) => /^Exported /.test(p.textContent))`);
  const summary = await panelText();
  await closeFlow();
  return { name: await ev(`window.__exp.name`), summary, stats: await ev(`window.__SB_EXPORT_TEST__?.stats ?? null`) };
}

/** The archive, checked outside the browser: Python's zipfile and unzip -t; `want`: data files' bytes (base64) as
 * the workspace has them, by path, compared with their members. */
function inspect(file, want = {}) {
  const py = String.raw`
import base64, json, sys, zipfile, hashlib, struct
f = sys.argv[1]
want = json.load(open(sys.argv[2]))
z = zipfile.ZipFile(f)
bad = z.testzip()
infos = z.infolist()
names = [i.filename for i in infos]
m = json.loads(z.read("manifest.json"))
data = open(f, "rb").read()
locs = []
at = 0
while True:
    at = data.find(b"PK\x03\x04", at)
    if at < 0: break
    nl, xl = struct.unpack("<HH", data[at+26:at+30])
    locs.append(data[at+30:at+30+nl].decode("utf-8", "replace"))
    at += 30
mismatch = []
folders_hashless = True
for e in m["entries"]:
    n = "files/" + e["path"][1:] + ("/" if e["kind"] == "folder" else "")
    if n not in names: mismatch.append("missing member " + n); continue
    if e["kind"] == "folder":
        if "sha256" in e or "size" in e: folders_hashless = False
        continue
    b = z.read(n)
    if hashlib.sha256(b).hexdigest() != e["sha256"] or len(b) != e["size"]: mismatch.append("hash/size " + n)
workspace = {p: z.read("files/" + p[1:]) == base64.b64decode(b) for p, b in want.items()}
print(json.dumps({"bad": bad, "names": names, "last_local": locs[-1] if locs else None, "last_central": names[-1], "count": len(names),
  "manifest": {k: m[k] for k in m if k != "entries"}, "entries": m["entries"], "mismatch": mismatch, "folders_hashless": folders_hashless,
  "workspace": workspace, "methods": {i.filename: i.compress_type for i in infos}}))
`;
  // (the workspace's bytes through a file: one argument is at most 128 KiB)
  const wantFile = file + ".want.json";
  writeFileSync(wantFile, JSON.stringify(want));
  const r = spawnSync("python3", ["-I", "-c", py, file, wantFile], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) return { error: String(r.stderr ?? r.error).slice(0, 600) };
  const u = spawnSync("unzip", ["-tq", file], { encoding: "utf8" });
  return { ...JSON.parse(r.stdout), unzip: u.status, unzipOut: (u.stdout + u.stderr).slice(0, 300) };
}
/** A member's bytes, from the archive. */
const member = (file, name) => spawnSync("python3", ["-I", "-c", "import sys, zipfile; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))", file, name], { maxBuffer: 1 << 28 }).stdout;
/** The workspace's bytes of a data file, base64. */
const wsBytes = (p) => ev(`${W}.read(${JSON.stringify(p)}).then((r) => { const b = new Uint8Array(r.content); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); })`);
/** Each document's member size in a plain export now (the caps' tests set their caps from these). */
async function docSizes() {
  await hooks();
  const r = await exportOnce(join(out, "sz.zip"));
  if (r.stopped) throw new Error("a plain export stopped: " + r.stopped);
  const z = inspect(join(out, "sz.zip"));
  return Object.fromEntries(z.entries.filter((e) => e.kind === "notebook" || e.kind === "board").map((e) => [e.path, e.size]));
}
const sha = (b) => spawnSync("python3", ["-I", "-c", "import sys, hashlib; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())"], { input: b }).stdout.toString().trim();

// (a notebook whose JSON has every kind of character and value a cut could break: surrogate pairs, lone surrogates,
// control characters, U+2028, long strings, empties, numbers)
const nasty = () => {
  const emo = "😀👩‍👩‍👧🇫🇷", lone = "\ud800x\udc00";
  return JSON.stringify({ mode: "python", cells: [
    { id: "n1", code: `s = ${JSON.stringify(emo.repeat(40))}\nprint(s)`, outputs: [{ output_type: "stream", name: "stdout", text: (emo + " \t\"\\\u0001" + lone + "\n").repeat(60) }], n: "1" },
    { id: "n2", code: "x", outputs: [{ output_type: "execute_result", execution_count: 2, metadata: {}, data: { "text/plain": ["a\n", emo.repeat(30), "b"], "application/json": { neg: -0, big: 1e21, small: 5e-7, empty: {}, arr: [], deep: [[[{}]]] } } }], n: 2 },
    { id: "n3", type: "markdown", code: ("# Ünïcode " + emo + "\n").repeat(50), attachments: { "a.png": { "image/png": "iVBORw0KGgo" + "A".repeat(3000) } } },
    { id: "n4", type: "raw", code: "" },
  ] });
};
const nb = (marker) => JSON.stringify({ cells: [{ id: "a1", code: `print(${JSON.stringify(marker)})`, outputs: [{ output_type: "stream", name: "stdout", text: marker + "\n" }], n: "1" }, { id: "a2", type: "markdown", code: "# Ünïcode **bold**" }], mode: "python" });

/** One scenario, if it runs: a throw inside it is its failure, and the next scenario still runs (its flow closed). */
async function scenario(name, f) {
  if (!runs(name)) return;
  try { await f(); } catch (e) {
    check(false, name + ": threw: " + String(e?.stack ?? e).slice(0, 600));
    await ev(`(() => { [...(document.querySelector(".sbfprev")?.querySelectorAll("button") ?? [])].filter((b) => /^(Cancel|Close)$/.test(b.textContent)).forEach((b) => b.click()); return 1; })()`).catch(() => {});
  }
}

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  if (chunk || chunkWorker) await send("Fetch.enable", { patterns: [{ urlPattern: "*sagebrush-export*.js*", requestStage: "Response" }] });
  await go(base);
  // (once more if the page's workspace didn't come up: a loaded machine)
  if (!(await until(`!!${W}`, 60000))) { await go(base); if (!(await until(`!!${W}`, 90000))) throw new Error("the page's workspace never came up"); }
  // the workspace: notebooks, a board with a picture in this browser's store, text and binary data files, an unknown
  // extension, nested empty folders, non-ASCII names and NFC/NFD siblings
  await ev(`(async () => {
    const w = ${W};
    await w.create("/Algebra.ipynb", { content: ${nasty()} });
    await w.create("/Small.ipynb", { content: ${nb("first")} });
    await w.create("/Plan.board.json");
    await w.create("/data/primes.csv", { content: "n,p\\n1,2\\n2,3\\n3,5\\n".repeat(200) });
    await w.create("/data/pic.png", { content: new Uint8Array(4096).map((_, i) => (i * 7919) & 255) });
    await w.create("/data/blob.xyz", { content: new Uint8Array(100000).fill(65) });
    await w.mkdir("/empty/inner");
    await w.create("/Ünïcode/naïve résumé.txt", { content: "accents" });
    await w.create("/names/caf\\u00e9.txt", { content: "nfc" });
    await w.create("/names2/cafe\\u0301.txt", { content: "nfd" });
    return 1;
  })()`);
  // (the board: a picture kept in this browser's picture store, named in its images, and a note showing it)
  const pic = await ev(`(async () => {
    // (noise: a picture that doesn't compress, larger as a data: URL than any other document here)
    const c = document.createElement("canvas"); c.width = 300; c.height = 200;
    const g = c.getContext("2d"), im = g.createImageData(300, 200);
    for (let i = 0; i < im.data.length; i++) im.data[i] = i % 4 === 3 ? 255 : (i * 2654435761) >>> 24;
    g.putImageData(im, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    // (the board's picture store, opened as web/board/images.ts opens it: version 1, its store made on upgrade)
    await new Promise((ok, no) => { const r = indexedDB.open("sagebrush-board-images", 1); r.onupgradeneeded = () => r.result.createObjectStore("blobs"); r.onsuccess = () => { const d = r.result, tx = d.transaction("blobs", "readwrite"); tx.objectStore("blobs").put(blob, "testpic01"); tx.oncomplete = () => { d.close(); ok(1); }; tx.onerror = () => no(tx.error); }; r.onerror = () => no(r.error); });
    const r = await ${W}.read("/Plan.board.json");
    await ${W}.write("/Plan.board.json", { ...r.content, images: { testpic01: { w: 300, h: 200 } }, nodes: [...(r.content.nodes ?? []), { id: "pn", title: "with a picture", image: "testpic01" }] }, { base: r.rev });
    return blob.size;
  })()`);
  await go(base);
  await openFiles();

  // ---- 0. the panel: the button, its line, the status before any export; the chunk not loaded before the click
  await ev(`(() => { document.querySelector("#wssidebar .fmeter").click(); return 1; })()`);
  check(await until(`/Export all current files \\(\\.zip\\)/.test(${P}?.textContent ?? "")`), "the Storage panel offers Export all current files (.zip)");
  check(/TimeTravel, old file versions, Trash, and this device's settings are not included/.test(await panelText()), "…with what isn't included, in one line");
  check(/No export prepared on this device yet/.test(await panelText()), "…and no export prepared yet");
  check(!(await ev(`[...performance.getEntriesByType("resource")].some((r) => /sagebrush-export/.test(r.name))`)), "the export's chunk isn't loaded before the click");

  // ---- N-3: without the test page's hooks, the caps in effect are the real table
  await scenario("prod", async () => {
    const c = await ev(`(async () => { delete window.__SB_EXPORT_TEST__; const m = await import(new URL("sagebrush-export.js", location.href).href); return m.capsInEffect(); })()`);
    check(c?.blob === 256 * 2 ** 20 && c?.doc === 64 * 2 ** 20 && c?.spoolBlob === 64 * 2 ** 20 && c?.total === 20 * 2 ** 30 && c?.manifest === 64 * 2 ** 20, "without the test page's hooks, the caps are the real ones: " + JSON.stringify(c));
  });

  // ---- 1-3, 9: an export through OPFS; the archive outside the browser; data files equal to the workspace's bytes
  await scenario("basic", async () => {
    await hooks();
    const a = await exportOnce(join(out, "a.zip"));
    check(!a.stopped, "an export ends with an archive: " + (a.stopped ?? a.name));
    if (!a.stopped) {
      const want = {};
      for (const p of ["/data/primes.csv", "/data/pic.png", "/data/blob.xyz", "/Ünïcode/naïve résumé.txt", "/names/café.txt", "/names2/café.txt"]) want[p] = await wsBytes(p);
      const z = inspect(join(out, "a.zip"), want);
      check(!z.error && z.bad === null, "Python's zipfile reads every member, CRCs right: " + (z.error ?? z.bad));
      check(z.unzip === 0, "unzip -t accepts it: " + z.unzipOut);
      check(/^sagebrush-\d{4}-\d\d-\d\d\.zip$/.test(a.name), "named sagebrush-YYYY-MM-DD.zip: " + a.name);
      check(z.mismatch?.length === 0, "every manifest entry's member is there, with its size and SHA-256: " + JSON.stringify(z.mismatch));
      check(Object.keys(want).every((p) => z.workspace?.[p] === true), "every data file's member is byte for byte the workspace's bytes (not only the manifest's): " + JSON.stringify(z.workspace));
      check(z.last_local === "manifest.json" && z.last_central === "manifest.json", "manifest.json is the last local member and its central record the last one: " + z.last_local + " / " + z.last_central);
      check(z.names.includes("files/empty/inner/") && z.names.includes("files/empty/") && z.entries.some((e) => e.path === "/empty/inner" && e.kind === "folder"), "empty folders are directory members, and folder entries in the manifest");
      check(z.folders_hashless === true, "folder entries carry no hash and no size (T3)");
      check(z.names.includes("files/Ünïcode/naïve résumé.txt"), "a non-ASCII name keeps its exact characters");
      check(z.names.includes("files/names/café.txt") && z.names.includes("files/names2/café.txt") && z.entries.some((e) => e.path === "/names/café.txt") && z.entries.some((e) => e.path === "/names2/café.txt"), "NFC and NFD forms of one name keep their exact characters, in zip names and manifest (T9; in two folders: the workspace refuses lookalike siblings)");
      check(z.methods["files/data/pic.png"] === 0 && z.methods["files/data/primes.csv"] === 8 && z.methods["files/Algebra.ipynb"] === 8, "png STOREd, csv and ipynb DEFLATEd: " + JSON.stringify(z.methods));
      check(z.manifest.format === "sagebrush-workspace-bundle" && z.manifest.version === 1 && z.manifest.mode === "files" && z.manifest.omitted.length === 0, "the manifest's head: " + JSON.stringify(z.manifest).slice(0, 200));
      check(z.entries.every((e) => typeof e.captured === "number"), "every entry records when it was captured");
      check(/Each file is in the export as it was saved when it was read/.test(a.summary), "the summary says what the export holds, and nothing more");
      check(/Last export prepared on this device: just now/.test(await panelText()), "the status line, after the export: " + (await panelText()).match(/Last export[^.]*|No export[^.]*/)?.[0]);
      const board = JSON.parse(member(join(out, "a.zip"), "files/Plan.board.json").toString("utf8"));
      check(/^data:image\/png;base64,/.test(board.images?.testpic01?.src ?? "") && Buffer.from(board.images.testpic01.src.split(",")[1], "base64").length === pic, "the board's picture, from this browser's store, is in its member as a data: URL of its bytes");
      check((await scratchCount()) === 0, "…and no scratch file left in OPFS after the handoff");
    }
  });

  // ---- the spool without OPFS (Blob parts) and the Blob sink, through the real hand(): its object URL revoked
  await scenario("blob", async () => {
    await ev(`(() => { window.__urls = []; window.__revoked = []; const c = URL.createObjectURL, r = URL.revokeObjectURL; URL.createObjectURL = (b) => { const u = c.call(URL, b); if (b?.type === "application/zip") { window.__urls.push(u); window.__exp = { blob: b, name: "blob.zip" }; } return u; }; URL.revokeObjectURL = (u) => { window.__revoked.push(u); return r.call(URL, u); }; return 1; })()`);
    await ev(`(() => { window.__exp = null; window.__SB_EXPORT_TEST__ = { noPicker: true, noOpfs: true, handDelay: 300, stats: {} }; return 1; })()`);
    const b = await exportOnce(join(out, "b.zip"));
    check(!b.stopped, "without OPFS: an archive through Blob parts and the Blob sink, by the real handoff: " + (b.stopped ?? b.name));
    if (!b.stopped) { const z = inspect(join(out, "b.zip")); check(!z.error && z.bad === null && z.mismatch.length === 0, "…valid, every hash right"); }
    check(await until(`window.__urls.length > 0 && window.__urls.every((u) => window.__revoked.includes(u))`, 5000), "…and the download's object URL is revoked after the handoff (T6)");
    await ev(`(() => { location.reload(); return 1; })()`).catch(() => {});
    await sleep(500);
    await until(`!!${W}`, 60000);
    await openFiles();
  });

  // ---- the real OPFS handoff: the scratch file kept, and the export's lock held, until its delayed removal
  await scenario("hand", async () => {
    await ev(`(() => { window.__exp = null; const c = URL.createObjectURL; URL.createObjectURL = (b) => { if (!(b?.type?.startsWith("image/"))) { window.__exp = { blob: b, name: "opfs.zip" }; window.__handAt = { type: b?.type, isFile: b instanceof File, size: b?.size, t: performance.now() }; navigator.locks.query().then((q) => { window.__handAt.locks = q.held.map((l) => l.name); }); } return c.call(URL, b); }; window.__SB_EXPORT_TEST__ = { noPicker: true, handDelay: 30000, stats: {} }; return 1; })()`);
    const h = await exportOnce(join(out, "h.zip"), { keep: true });
    check(!h.stopped, "an export handed off by the real hand(), from OPFS: " + (h.stopped ?? h.name));
    console.log("(hand diagnostics: " + JSON.stringify(await ev(`({ ...window.__handAt, since: Math.round(performance.now() - (window.__handAt?.t ?? 0)) })`)) + ")");
    const during = await ev(`navigator.locks.query().then((q) => q.held.filter((l) => l.name.startsWith("sagebrush-export:")).length)`);
    const kept = await scratchCount();
    check(during === 1 && kept === 1, "during the handoff the archive's scratch file stays, and its export holds its lock (" + kept + " files, " + during + " locks)");
    // (another export meanwhile: its stale-scratch sweep leaves the handing-off export's file alone)
    await hooks();
    const h2 = await exportOnce(join(out, "h2.zip"));
    const left = await scratchCount();
    check(!h2.stopped && left === 1, "a second export during the first's handoff ends, its stale-scratch sweep leaving the handing-off archive alone (" + left + " file left): " + (h2.stopped ?? h2.name));
    check(await until(`navigator.locks.query().then((q) => q.held.filter((l) => l.name.startsWith("sagebrush-export:")).length === 0)`, 40000) && (await scratchCount()) === 0, "after the delay the scratch file is removed, then the lock let go (" + (await scratchCount()) + " files)");
    await ev(`(() => { location.reload(); return 1; })()`).catch(() => {});
    await sleep(500);
    await until(`!!${W}`, 60000);
    await openFiles();
  });

  // ---- 4. saves before and after a member's capture: a data file, a notebook, a board; the manifest's rev, sha256 and
  // captured those of the bytes in the member
  await scenario("capture", async () => {
    await hooks(`beforeCapture: async (p) => {
      const w = window.sagebrush.workspace;
      if (p === "/data/primes.csv") { window.__t_csv = Date.now(); await w.write(p, "before\\n"); }
      if (p === "/Small.ipynb") { const r = await w.read(p); window.__t_nb = Date.now(); await w.write(p, { ...r.content, cells: [...r.content.cells, { id: "pre", code: "# before capture" }] }, { base: r.rev }); }
      if (p === "/Plan.board.json") { const r = await w.read(p); await w.write(p, { ...r.content, title: "Before capture" }, { base: r.rev }); }
    }, afterCapture: async (p) => {
      const w = window.sagebrush.workspace;
      if (p === "/data/pic.png") await w.write(p, new Uint8Array([1, 2]));
      if (p === "/Algebra.ipynb") { const r = await w.read(p); await w.write(p, { ...r.content, cells: [...r.content.cells, { id: "post", code: "# after capture" }] }, { base: r.rev }); }
      if (p === "/Plan.board.json") { const r = await w.read(p); await w.write(p, { ...r.content, title: "After capture" }, { base: r.rev }); }
    }`);
    const c = await exportOnce(join(out, "c.zip"));
    check(!c.stopped, "content saves during an export don't stop it: " + (c.stopped ?? c.name));
    if (!c.stopped) {
      const z = inspect(join(out, "c.zip"));
      const e = (p) => z.entries.find((x) => x.path === p);
      const csv = e("/data/primes.csv"), png = e("/data/pic.png"), sm = e("/Small.ipynb"), alg = e("/Algebra.ipynb"), bd = e("/Plan.board.json");
      const csvRev = await ev(`${W}.stat("/data/primes.csv").then((x) => x.rev ?? 0)`);
      check(csv?.size === 7 && csv.sha256 === sha(Buffer.from("before\n")) && csv.rev === csvRev && csv.captured >= (await ev("window.__t_csv")), "a data file saved before its capture: in the archive, its manifest rev, sha256 and captured those of the newer bytes");
      check(png?.size === 4096 && z.mismatch.length === 0, "a data file saved after its capture is not: the bytes it had when read (size " + png?.size + "), matching its manifest");
      const smText = member(join(out, "c.zip"), "files/Small.ipynb").toString("utf8"), smRev = await ev(`${W}.read("/Small.ipynb").then((r) => r.rev)`);
      check(/before capture/.test(smText) && sm?.rev === smRev && sm?.sha256 === sha(Buffer.from(smText)) && sm.captured >= (await ev("window.__t_nb")), "a notebook saved before its capture: the newer bytes, rev " + sm?.rev + " (now " + smRev + "), sha256 and captured matching");
      const algText = member(join(out, "c.zip"), "files/Algebra.ipynb").toString("utf8");
      check(!/after capture/.test(algText) && alg?.sha256 === sha(Buffer.from(algText)), "a notebook saved after its capture: not in it, and its manifest matches the bytes it has");
      const bdText = member(join(out, "c.zip"), "files/Plan.board.json").toString("utf8");
      check(/"Before capture"/.test(bdText) && !/"After capture"/.test(bdText) && bd?.sha256 === sha(Buffer.from(bdText)), "a board: the save before its capture in, the one after not, its manifest matching");
      // ---- 12, 13: the order of times; the spool's chunks (not one object per record)
      const last = await ev(LAST);
      check(Date.parse(z.manifest.created) <= last.at, "manifest.created is taken before the file is closed, \"Last export prepared\" after: " + z.manifest.created + " / " + new Date(last.at).toISOString());
      check(typeof c.stats?.spoolChunks === "number" && c.stats.spoolChunks <= 4, "the spool holds a few 1 MiB chunks, not one object per record: " + c.stats?.spoolChunks);
    }
  });

  // ---- 1. the documents' bytes are Download's: the editor's Download right after a save, the same bytes, the export's
  // stream cut everywhere (slices of 7 characters, strings in pieces of 5)
  await scenario("download", async () => {
    const nbRef = await ev(`${W}.stat("/Algebra.ipynb").then((e) => e.ref)`), bdRef = await ev(`${W}.stat("/Plan.board.json").then((e) => e.ref)`);
    const grab = `(() => { window.__dl = []; const o = URL.createObjectURL; URL.createObjectURL = (b) => { window.__dl.push(b); return o.call(URL, b); }; return 1; })()`;
    const dlBytes = () => ev(`window.__dl[window.__dl.length - 1].arrayBuffer().then((b) => { const u = new Uint8Array(b); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); })`);
    await go(base + "?nb=" + encodeURIComponent(nbRef));
    await until(`!!${W} && !!document.querySelector("#cells textarea")`, 60000);
    await sleep(2500);
    await ev(grab);
    await ev(`(() => { const b = [...document.querySelectorAll("#filemenu button")].find((x) => x.textContent.startsWith(".ipynb")); if (!b) throw new Error("no .ipynb item"); b.click(); return 1; })()`);
    check(await until(`window.__dl.length > 0`), "the notebook page's Download .ipynb runs");
    const dNb = Buffer.from(await dlBytes(), "base64");
    await go(base + "board/?doc=local:" + encodeURIComponent(bdRef));
    check(await until(`!!window.sagebrush?.board?.snapshot() && !!document.querySelector('[data-sbb="download"]')`, 60000), "the board page opens the board");
    await sleep(2500);
    await ev(grab);
    await ev(`(() => { document.querySelector('[data-sbb="download"]').click(); return 1; })()`);
    check(await until(`window.__dl.length > 0`), "the board's Download JSON runs");
    const dBd = Buffer.from(await dlBytes(), "base64");
    await go(base);
    await openFiles();
    for (const [label, sizes] of [["", null], [", cut everywhere (7/5)", [7, 5]]]) {
      await hooks(sizes ? `streamSizes: [${sizes}]` : "");
      const e = await exportOnce(join(out, "e.zip"));
      check(!e.stopped, "an export after the editors' saves" + label + ": " + (e.stopped ?? e.name));
      if (e.stopped) continue;
      check(member(join(out, "e.zip"), "files/Algebra.ipynb").equals(dNb), "the notebook's member is byte for byte what Download .ipynb wrote" + label);
      check(member(join(out, "e.zip"), "files/Plan.board.json").equals(dBd), "the board's member (with its picture) is byte for byte what Download JSON wrote" + label);
    }
  });

  // ---- 5. files not on this device: refused, naming them, nothing written (no partial export: the r2 simplification)
  await scenario("unavailable", async () => {
    const before = await lastAt();
    const refused = async (label, re) => {
      await hooks();
      const f = await exportOnce(join(out, "f.zip"));
      check(!!f.stopped && /aren't on this device yet|isn't on this device yet/.test(f.stopped) && re.test(f.stopped) && !(await ev(`!!window.__exp`)), label + ": refused, naming it, nothing handed over: " + (f.stopped ?? "not stopped").slice(-200));
    };
    await idb("sagebrush-workspace", "entries", `(s) => { const t = Date.now(); return s.put({ path: "/cloud.csv", kind: "file", ref: "/cloud.csv", size: 10, created: t, updated: t, fid: "cloudfid", ident: "cloudfid", sha256: "0".repeat(64), remote: true, fetch: "0".repeat(64) }); }`);
    await refused("a file in the cloud only", /cloud\.csv \(in the cloud only\)/);
    await idb("sagebrush-workspace", "entries", `(s) => s.delete("/cloud.csv")`);
    // (an unflagged data file whose bytes are gone: found by preflight's check, not halfway through)
    await ev(`${W}.create("/gone.bin", { content: new Uint8Array([1, 2, 3]) }).then(() => 1)`);
    const gfid = await ev(`${W}.stat("/gone.bin").then((e) => e.fid)`);
    await idb("sagebrush-workspace", "fileBytes", `(s) => s.delete(${JSON.stringify(gfid)})`);
    await refused("a data file whose bytes aren't here, though nothing says so", /gone\.bin \(missing\)/);
    await ev(`${W}.remove("/gone.bin").then(() => 1, () => 0)`);
    await idb("sagebrush-workspace", "entries", `(s) => s.delete("/gone.bin")`);
    // (an unflagged document whose record is gone)
    await ev(`${W}.create("/Gone.board.json").then(() => 1)`);
    const gref = await ev(`${W}.stat("/Gone.board.json").then((e) => e.ref)`);
    await idb("sagebrush-workspace", "boards", `(s) => s.delete(${JSON.stringify(gref)})`);
    await refused("a board whose record isn't here", /Gone\.board\.json \(missing\)/);
    await ev(`${W}.remove("/Gone.board.json").then(() => 1, () => 0)`);
    await idb("sagebrush-workspace", "entries", `(s) => s.delete("/Gone.board.json")`);
    // (a file whose bytes go after preflight: the export stops, and nothing is left out silently)
    await ev(`${W}.create("/late.txt", { content: "late" }).then(() => 1)`);
    await hooks(`beforeCapture: async (p) => { if (p === "/late.txt") { const fid = (await window.sagebrush.workspace.stat(p)).fid; await ${IDB}("sagebrush-workspace", "fileBytes", (s) => s.delete(fid)); } }`);
    const late = await exportOnce(join(out, "late.zip"));
    check(!!late.stopped && /late\.txt isn't on this device/.test(late.stopped) && !(await ev(`!!window.__exp`)), "a file evicted after preflight stops the export, nothing handed over: " + (late.stopped ?? "not stopped").slice(-200));
    check((await lastAt()) === before, "…and the status line is unchanged by any of them");
    await ev(`${W}.remove("/late.txt").then(() => 1, () => 0)`);
    await idb("sagebrush-workspace", "entries", `(s) => s.delete("/late.txt")`);
  });

  // ---- 6. the picker's sink: committed only by close(); aborted on every failure, the earliest too; status unchanged
  await scenario("picker", async () => {
    await ev(`(() => { window.__picked = null; window.__aborted = 0; window.showSaveFilePicker = async () => ({ createWritable: async () => { const parts = []; return { write: async (c) => { parts.push(new Uint8Array(c)); }, close: async () => { window.__picked = new Blob(parts); }, abort: async () => { window.__aborted++; } }; } }); return 1; })()`);
    await ev(`(() => { window.__exp = null; window.__SB_EXPORT_TEST__ = { stats: {} }; return 1; })()`);
    const pk = await exportOnce(join(out, "pk.zip"), { picked: true });
    check(!pk.stopped && (await ev(`!!window.__picked && window.__aborted === 0`)), "the picker's file gets the archive, committed by close(): " + (pk.stopped ?? "ok"));
    const before = await lastAt();
    await ev(`(() => { window.__picked = null; window.__SB_EXPORT_TEST__ = { afterCapture: async (p) => { if (p === "/data/pic.png") await window.sagebrush.workspace.mkdir("/new folder"); } }; return 1; })()`);
    const pk2 = await exportOnce(join(out, "pk2.zip"), { picked: true });
    check(!!pk2.stopped && (await ev(`window.__picked === null && window.__aborted === 1`)), "a stopped export aborts the picker's file, nothing committed: " + (pk2.stopped ?? "not stopped").slice(-120));
    check((await lastAt()) === before, "…and the status line is unchanged after the sink's failure");
    await ev(`${W}.remove("/new folder").then(() => 1)`);
    // (a picker whose close() fails: nothing committed, so the status line is not stamped)
    await ev(`(() => { window.__picked = null; window.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async () => {}, close: async () => { throw new Error("the disk is full (a test)"); }, abort: async () => { window.__aborted++; } }) }); window.__SB_EXPORT_TEST__ = { stats: {} }; return 1; })()`);
    const pkc = await exportOnce(join(out, "pkc.zip"), { picked: true });
    check(!!pkc.stopped && /disk is full/.test(pkc.stopped) && (await lastAt()) === before, "a picker whose close fails: the export stops, and the status line is not stamped: " + (pkc.stopped ?? "not stopped").slice(-120));
    await ev(`(() => { window.__aborted = 2; window.showSaveFilePicker = async () => ({ createWritable: async () => { const parts = []; return { write: async (c) => { parts.push(new Uint8Array(c)); }, close: async () => { window.__picked = new Blob(parts); }, abort: async () => { window.__aborted++; } }; } }); return 1; })()`);
    // (the earliest failure in writing: its first scratch spool's open, the picker's file already open.  r2c: the
    // in-memory spools' cap is checked in preflight now, the records counted, before there is a picker)
    await ev(`(() => { window.__picked = null; window.__SB_EXPORT_TEST__ = { failOpen: "spool" }; return 1; })()`);
    const pk3 = await exportOnce(join(out, "pk3.zip"), { picked: true });
    check(!!pk3.stopped && /couldn't be truncated/.test(pk3.stopped) && (await ev(`window.__picked === null && window.__aborted === 3`)), "a failure before anything is written still aborts the picker's file (astra's E1-A3): " + (pk3.stopped ?? "not stopped").slice(-120));
    await ev(`(() => { delete window.showSaveFilePicker; return 1; })()`);
  });

  // ---- E1-A6: the archive saved, but "Last export prepared" can't be written: said as it is
  await scenario("stamp", async () => {
    const before = await lastAt();
    await hooks(`failStamp: true`);
    const st = await exportOnce(join(out, "st.zip"));
    check(!st.stopped && /The archive was saved, but this device couldn't record when/.test(st.summary ?? "") && !/Nothing was saved/.test(st.summary ?? ""), "a failed status write after the archive is saved says so, not \"Nothing was saved\": " + (st.stopped ?? st.summary ?? "").slice(-200));
    check((await lastAt()) === before, "…and the status line is unchanged");
  });

  // ---- astra's E1 code review R1: one export at a time in a tab.  (a) the Storage panel closed and opened again while
  // an export is written: that export is cancelled, and a second Export meanwhile is refused in words; (b) Export
  // again's export running, the panel's own Export button is refused in words.  Every archive made is a valid one.
  // (Held between members by the test, so the second Export lands while the first owns the page's export state)
  const HOLD = `async (n) => { if (n === 2 && !window.__held) { window.__held = 1; await new Promise((r) => (window.__resume = r)); } }`;
  const toastText = () => ev(`document.querySelector(".ftoast")?.textContent ?? ""`);
  const clearToast = () => ev(`(() => { document.querySelectorAll(".ftoast").forEach((t) => t.remove()); return 1; })()`);
  const REFUSED = `/^An export is already running in this tab\\. Finish or cancel it first\\./`;
  const flowHas = (re) => `[...(${P}?.querySelectorAll("button") ?? [])].some((b) => ${re}.test(b.textContent))`;
  // (whether an export owns this page's export state: the chunk's own exportOwned(), the module the page loaded)
  const OWNED = `(() => { const e = performance.getEntriesByType("resource").find((x) => /sagebrush-export\\.js/.test(x.name)); return e ? import(e.name).then((m) => m.exportOwned()) : true; })()`;
  /** after a closed panel: no owner, no export's lock, no scratch file, within the bounds */
  const settledFree = async () => (await until(`${LOCKS}.then((m) => m === 0)`, 10000)) && (await until(`${OWNED}.then((o) => o === false)`, 5000)) && (await scratchCount()) === 0;
  /** the archive handed over (window.__exp) saved to `file` and checked: zipfile, unzip -t, every hash, manifest last */
  const savedValid = async (file) => {
    const b64 = await ev(`(async () => { const b = new Uint8Array(await window.__exp.blob.arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); })()`);
    writeFileSync(file, Buffer.from(b64, "base64"));
    const z = inspect(file);
    return !z.error && z.bad === null && z.mismatch?.length === 0 && z.unzip === 0 && z.last_local === "manifest.json" && z.last_central === "manifest.json" ? "" : JSON.stringify({ error: z.error, bad: z.bad, mismatch: z.mismatch, unzip: z.unzip, last: z.last_local }).slice(0, 300);
  };
  await scenario("own", async () => {
    const before = await lastAt();
    // (a)
    await ev(`(() => { window.__held = 0; window.__resume = null; return 1; })()`);
    await hooks(`between: ${HOLD}`);
    await startFlow();
    check(await until(flowHas(`/^Save…$/`), 120000), "own a: the first export is ready");
    await panelButton(/^Save…$/);
    check(await until(`!!window.__resume`, 60000), "own a: the first export is being written (held between members)");
    await ev(`(() => { ${P}.sbClose(); return 1; })()`);
    await clearToast();
    await startFlow();
    check(await until(`${REFUSED}.test(document.querySelector(".ftoast")?.textContent ?? "")`, 5000), "own a: the panel closed and opened again mid-export, a second Export is refused in words: " + JSON.stringify(await toastText()));
    check(!(await ev(flowHas(`/^(Cancel|Save…)$/`))), "own a: …and no second export runs beside it");
    await ev(`(() => { window.__resume(); return 1; })()`);
    check(await until(`${LOCKS}.then((m) => m === 0)`, 15000), "own a: the closed panel's export is cancelled: its lock let go");
    check(!(await ev(`!!window.__exp`)) && (await lastAt()) === before && (await scratchCount()) === 0, "own a: …nothing handed over, the status line unchanged, no scratch file left");
    await hooks();
    const a2 = await exportOnce(join(out, "own-a.zip"), { keep: true });
    const va = a2.stopped ? a2.stopped : await savedValid(join(out, "own-a.zip"));
    check(va === "", "own a: then an export ends with a valid archive: " + va);
    await handed();
    // (b)
    await ev(`(() => { window.__held = 0; window.__resume = null; return 1; })()`);
    await hooks(`failSpoolAfter: 1`);
    await startFlow();
    await until(flowHas(`/^Save…$/`), 120000);
    await panelButton(/^Save…$/);
    check(await until(flowHas(`/^Export again$/`), 60000), "own b: an export stopped (a spool's write failed), with Export again");
    await ev(`(() => { const t = window.__SB_EXPORT_TEST__; t.failSpoolAfter = 0; t.between = ${HOLD}; window.__exp = null; return 1; })()`);
    await panelButton(/^Export again$/);
    check(await until(flowHas(`/^Save…$/`), 120000), "own b: Export again's export is ready");
    await panelButton(/^Save…$/);
    check(await until(`!!window.__resume`, 60000), "own b: Export again's export is being written (held between members)");
    await clearToast();
    await panelButton(/^Export all current files/);
    check(await until(`${REFUSED}.test(document.querySelector(".ftoast")?.textContent ?? "")`, 5000), "own b: Export again's export running, the panel's own Export button is refused in words: " + JSON.stringify(await toastText()));
    await ev(`(() => { window.__resume(); return 1; })()`);
    check(await until(`!!window.__exp`, 120000), "own b: …then Export again's export ends, handed over");
    const vb = (await ev(`!!window.__exp`)) ? await savedValid(join(out, "own-b.zip")) : "nothing handed over";
    check(vb === "", "own b: …with a valid archive: " + vb);
    await handed();
    await until(`[...(${P}?.querySelectorAll("p") ?? [])].some((p) => /^Exported /.test(p.textContent))`);
    await closeFlow();
    // (c) closed at Ready; (d) closed during the startup (the stale sweep held); (e) closed after the page's own saves,
    // before preflight: each export ends, owning nothing and holding no lock, before the next one
    await hooks();
    await startFlow();
    check(await until(flowHas(`/^Save…$/`), 120000), "own c: an export is ready");
    await ev(`(() => { ${P}.sbClose(); return 1; })()`);
    check(await settledFree(), "own c: the panel closed at Ready: the export ends, no owner, no lock, no scratch file left");
    await hooks(`sweepPauseMs: 1500`);
    await startFlow();
    await sleep(300);
    await ev(`(() => { ${P}.sbClose(); return 1; })()`);
    check(await settledFree(), "own d: the panel closed during the startup: the export ends, no owner, no lock, no scratch file left");
    await hooks(`beforePreflight: () => new Promise((r) => { window.__bp = r; })`);
    await ev(`(() => { window.__bp = null; return 1; })()`);
    await startFlow();
    check(await until(`!!window.__bp`, 30000), "own e: an export is past the page's own saves, before preflight");
    await ev(`(() => { ${P}.sbClose(); window.__bp?.(); return 1; })()`);
    check(await settledFree(), "own e: the panel closed before preflight: the export ends, no owner, no lock, no scratch file left");
    await hooks();
    const e2 = await exportOnce(join(out, "own-e.zip"), { keep: true });
    const ve = e2.stopped ? e2.stopped : await savedValid(join(out, "own-e.zip"));
    check(ve === "", "own e: then an export ends with a valid archive: " + ve);
    await handed();
  });

  // ---- astra's E1 code review R2: the OPFS handoff failing before the download starts: the export stops, said as
  // such; nothing committed or stamped; its scratch removed, its lock let go; no unhandled rejection
  await scenario("handfail", async () => {
    await ev(`(() => { if (!window.__unhOn) { window.__unhOn = 1; window.__unh = []; addEventListener("unhandledrejection", (e) => window.__unh.push(String(e.reason?.message ?? e.reason).slice(0, 120))); } window.__unh.length = 0; return 1; })()`);
    const before = await lastAt();
    // (the sink witnessed by what it hands over: OPFS hands the scratch file's File, the Blob sink a Blob that isn't one)
    await hooks(`onHand: (b) => { window.__hfFile = b instanceof File; throw new Error("the download couldn't start (a test)"); }`);
    await startFlow();
    await until(flowHas(`/^Save…$/`), 120000);
    await panelButton(/^Save…$/);
    await until(`${flowHas(`/^Export again$/`)} || [...(${P}?.querySelectorAll("p") ?? [])].some((p) => /^Exported /.test(p.textContent))`, 60000);
    const text = await panelText();
    check(/The export stopped: the download couldn't start \(a test\)\. Nothing was saved\./.test(text), "handfail: a handoff that fails before the download starts stops the export, said as such: " + text.slice(-200));
    check((await lastAt()) === before, "handfail: …the status line unchanged");
    check(await until(`${LOCKS}.then((m) => m === 0)`, 10000) && (await scratchCount()) === 0, "handfail: …its lock let go and no scratch file left (" + (await scratchCount()) + ")");
    await sleep(300);
    check((await ev(`window.__unh.length`)) === 0, "handfail: …and no unhandled rejection: " + JSON.stringify(await ev(`window.__unh`)));
    check((await ev(`window.__hfFile === true`)), "handfail: …through the OPFS sink (the case's own precondition: the scratch file's File was handed over): " + (await ev(`String(window.__hfFile)`)));
    await closeFlow();
  });

  // ---- astra's E1 code review R3: (a) the worker's module doesn't load: the export stops at once, in words, and the
  // page's next export runs; (b) the worker crashes during an append: the export stops within its bound, its cleanup
  // settles and its lock is let go; what the worker couldn't remove, the next export's stale sweep does.  (A live
  // worker refusing OPFS still falls back to Blobs: "scratch", the probe's failures)
  await scenario("workerfail", async () => {
    const before = await lastAt();
    // (a)
    await hooks(`workerUrl: "/no-such-export-worker.js"`);
    await clearToast();
    await startFlow();
    check(await until(`/^The export couldn't start its worker \\(/.test(document.querySelector(".ftoast")?.textContent ?? "")`, 15000), "workerfail a: a worker that doesn't load stops the export within 15 s, said in words: " + JSON.stringify(await toastText()));
    check(await until(`${LOCKS}.then((m) => m === 0)`, 5000) && (await lastAt()) === before, "workerfail a: …its lock let go, the status line unchanged");
    await hooks();
    await startFlow();
    check(await until(flowHas(`/^Save…$/`), 120000), "workerfail a: …and the page's next export runs");
    await panelButton(/^Cancel$/);
    // (b)
    await hooks(`crashAfter: 1`);
    await clearToast();
    await startFlow();
    const readyB = await until(flowHas(`/^Save…$/`), 120000);
    check(readyB, "workerfail b: an export is ready: " + (readyB ? "" : (await panelText()).slice(-300) + " | toast " + JSON.stringify(await toastText()) + " | owned " + (await ev(OWNED)) + " | locks " + (await ev(LOCKS))));
    if (!readyB) return;
    await panelButton(/^Save…$/);
    const stoppedB = await until(flowHas(`/^Export again$/`), 20000);
    const tb = await panelText();
    check(stoppedB && /The export stopped: the export's worker failed: .*Nothing was saved\./.test(tb), "workerfail b: a worker that crashes during an append stops the export within 20 s, said in words: " + tb.slice(-200));
    check(!(await ev(`!!window.__exp`)) && (await lastAt()) === before, "workerfail b: …nothing handed over, the status line unchanged");
    check(await until(`${LOCKS}.then((m) => m === 0)`, 10000), "workerfail b: …its cleanup settled: its lock let go");
    await closeFlow();
    await hooks();
    const c = await exportOnce(join(out, "wf.zip"));
    check(!c.stopped && (await scratchCount()) === 0, "workerfail b: …and the next export ends, its stale sweep having removed what the crashed worker left: " + (c.stopped ?? (await scratchCount()) + " files left"));
  });

  // ---- 6, N-2. Cancel inside a 200 MB member, timed in the page: within 250 ms; nothing left; status unchanged
  await scenario("cancel", async () => {
    await ev(`${W}.create("/big.bin", { content: new Uint8Array(200 * 2 ** 20).map((_, i) => i & 7) }).then(() => 1)`);
    // (a pause after each 1 MiB slice, test-only, so the member is still being written when Cancel is clicked)
    await hooks(`slicePause: 20, onMember: (p) => { if (p !== "/big.bin") return; setTimeout(() => { const b = [...document.querySelectorAll(".sbfprev button")].find((x) => x.textContent === "Cancel"); window.__clickAt = performance.now(); b.click(); }, 500); }`);
    await ev(`(() => { window.__cancelledAt = 0; new MutationObserver(() => { if (!window.__cancelledAt && /The export was cancelled/.test(document.querySelector(".sbfprev")?.textContent ?? "")) window.__cancelledAt = performance.now(); }).observe(document.body, { subtree: true, childList: true, characterData: true }); return 1; })()`);
    const before = await lastAt();
    const x = await exportOnce(join(out, "x.zip"));
    const took = await ev(`window.__cancelledAt && window.__clickAt ? window.__cancelledAt - window.__clickAt : -1`);
    check(!!x.stopped && took >= 0 && took <= 250, "Cancel inside a 200 MB member stops it within 250 ms, timed in the page: " + Math.round(took) + " ms");
    check(!(await ev(`!!window.__exp`)), "…nothing handed to a download");
    check(await until(`navigator.storage.getDirectory().then((r) => r.getDirectoryHandle("sagebrush-export", { create: true })).then(async (d) => { let n = 0; for await (const _ of d.keys()) n++; return n === 0; })`, 5000), "…and no scratch file left in OPFS");
    check((await lastAt()) === before, "…the status line unchanged");
    await ev(`${W}.remove("/big.bin").then(() => 1)`);
  });

  // ---- 7. the Blob path: refused before anything is read when the bound passes its cap; stopped cleanly when the
  // output outgrows it (a file grown after preflight)
  await scenario("blobcap", async () => {
    await hooks("noOpfs: true, caps: { blob: 4096 }");
    const bl = await exportOnce(join(out, "bl.zip"));
    check(!!bl.stopped && /can't save a file that large here/.test(bl.stopped), "without OPFS or a picker, an export over the Blob path's cap is refused: " + (bl.stopped ?? "not stopped").slice(-160));
    const before = await lastAt();
    await hooks(`noOpfs: true, onPlan: (plan) => { window.__SB_EXPORT_TEST__.caps = { blob: plan.bound + 2048 }; }, beforeCapture: async (p) => { if (p === "/data/primes.csv") { const b = new Uint8Array(400000); for (let i = 0; i < b.length; i += 65536) crypto.getRandomValues(b.subarray(i, i + 65536)); await window.sagebrush.workspace.write(p, b); } }`);
    const bo = await exportOnce(join(out, "bo.zip"));
    check(!!bo.stopped && /grew past/.test(bo.stopped) && !(await ev(`!!window.__exp`)) && (await lastAt()) === before, "an export outgrowing the Blob path after preflight stops cleanly, nothing handed over, status unchanged (T7): " + (bo.stopped ?? "not stopped").slice(-160));
    await ev(`${W}.write("/data/primes.csv", "n,p\\n1,2\\n").then(() => 1)`);
  });

  // ================================================================== E1 r2a heap plan r2c (frozen e3bd7f07)
  const SLICE = 1 << 20;
  const OPFS = (body) => `navigator.storage.getDirectory().then((r) => r.getDirectoryHandle("sagebrush-export", { create: true })).then(async (d) => { ${body} })`;
  const scratchNames = () => ev(OPFS(`const n = []; for await (const k of d.keys()) n.push(k); return n;`));
  const rowsFiles = async () => (await scratchNames()).filter((n) => /-rows$/.test(n));
  let fetching = !!(chunk || chunkWorker), uncached = false;
  /** The page loaded again (a fresh module map: the chunk served anew), the file browser open. */
  const reload = async () => { await go(base); await until(`!!${W}`, 90000); await openFiles(); };
  /** The reference (b00fb43f) or this build, for the next page load. */
  const useRef = async (on) => {
    if (on && !REF) {
      REF = { chunk: readFileSync(join(REF_DIR, "sagebrush-export.js")), worker: readFileSync(join(REF_DIR, "sagebrush-export-worker.js")) };
      check(sha(REF.chunk) === REF_SHA.chunk && sha(REF.worker) === REF_SHA.worker, "identity: the reference is b00fb43f's shipped chunk and worker, their sha256 as pinned (P-5): " + sha(REF.chunk).slice(0, 16) + " / " + sha(REF.worker).slice(0, 16));
    }
    // (the browser's cache off: a chunk or worker taken from it would never reach the interception)
    if (!fetching) { await send("Fetch.enable", { patterns: [{ urlPattern: "*sagebrush-export*.js*", requestStage: "Response" }] }); fetching = true; }
    if (!uncached) { await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true }); uncached = true; }
    serve.ref = on;
    await reload();
  };
  /** Two archives compared as r2c's "identity" asks: every member's local header, data and descriptor and every
   * central record byte-identical, except the manifest's own; manifest.json identical after removing only the
   * `captured` values and the head's `created`. */
  const compare = (refFile, newFile) => {
    const py = String.raw`
import sys, struct, json, re, zipfile
def parse(f):
    d = open(f, "rb").read()
    e = len(d) - 22
    assert d[e:e+4] == b"PK\x05\x06"
    loc = e - 20
    assert d[loc:loc+4] == b"PK\x06\x07"
    z = struct.unpack("<Q", d[loc+8:loc+16])[0]
    n, size, off = struct.unpack("<QQQ", d[z+32:z+56])
    out, at = [], off
    for i in range(n):
        assert d[at:at+4] == b"PK\x01\x02"
        csize, = struct.unpack("<I", d[at+20:at+24])
        nl, xl, cl = struct.unpack("<HHH", d[at+28:at+34])
        lo, = struct.unpack("<I", d[at+42:at+46])
        rec = d[at:at+46+nl+xl+cl]
        name = d[at+46:at+46+nl].decode("utf-8", "replace")
        lnl, lxl = struct.unpack("<HH", d[lo+26:lo+30])
        fl, = struct.unpack("<H", d[lo+6:lo+8])
        local = d[lo:lo+30+lnl+lxl+csize+(16 if fl & 8 else 0)]
        out.append((name, rec, local))
        at += 46 + nl + xl + cl
    return out, zipfile.ZipFile(f).read("manifest.json").decode("utf-8")
a, am = parse(sys.argv[1]); b, bm = parse(sys.argv[2])
diffs = []
if [x[0] for x in a] != [x[0] for x in b]: diffs.append("member names differ: %d / %d" % (len(a), len(b)))
for (n, r1, l1), (_, r2, l2) in zip(a, b):
    if n == "manifest.json": continue
    if r1 != r2: diffs.append("central record " + n)
    if l1 != l2: diffs.append("local member " + n)
strip = lambda t: re.sub(r'"created":"[^"]*"', '"created":""', re.sub(r',"captured":(null|-?[0-9.eE+]+)', "", t))
print(json.dumps({"members": len(b), "diffs": diffs[:6], "ndiffs": len(diffs), "manifest": strip(am) == strip(bm), "manifestLen": [len(am), len(bm)]}))
`;
    const r = spawnSync("python3", ["-I", "-c", py, refFile, newFile], { encoding: "utf8", maxBuffer: 1 << 26 });
    return r.status === 0 ? JSON.parse(r.stdout) : { error: (r.stderr || String(r.error)).slice(0, 400) };
  };
  /** The sinks' hooks: OPFS (the default), the picker (a fake writable that copies each write only after a pause, so
   * a slice reused before its write resolved would show), the Blob sink (no OPFS). */
  const SINKS = {
    opfs: { setup: `(() => { delete window.showSaveFilePicker; return 1; })()`, hooks: "", picked: false },
    picker: { setup: `(() => { window.__picked = null; window.__aborted = 0; window.showSaveFilePicker = async () => ({ createWritable: async () => { const parts = []; return { write: async (c) => { await new Promise((r) => setTimeout(r, 2)); parts.push(new Uint8Array(c)); }, close: async () => { window.__picked = new Blob(parts); }, abort: async () => { window.__aborted++; } }; } }); return 1; })()`, hooks: null, picked: true },
    blob: { setup: `(() => { delete window.showSaveFilePicker; return 1; })()`, hooks: "noOpfs: true", picked: false },
  };
  /** Which chunk the page runs: this build's exports writerCheck, the reference's doesn't. */
  const WHICH = `import(new URL("sagebrush-export.js", location.href).href).then((m) => (typeof m.writerCheck === "function" ? "this build" : "reference"))`;
  const sinkExport = async (sink, file, extra = "") => {
    await ev(SINKS[sink].setup);
    if (SINKS[sink].hooks === null) await ev(`(() => { window.__exp = null; window.__SB_EXPORT_TEST__ = { stats: {}${extra ? ", " + extra : ""} }; return 1; })()`);
    else await hooks([SINKS[sink].hooks, extra].filter(Boolean).join(", "));
    return exportOnce(file, { picked: SINKS[sink].picked });
  };

  // ---- r2c §2, the direct writer's own test: against JSON.stringify and TextEncoder in this browser, byte for byte;
  // with grader's P-1 numbers and P-3's optional fields through the record and its lines
  await scenario("writer", async () => {
    const r = await ev(`(async () => {
      const m = await import(new URL("sagebrush-export.js", location.href).href);
      let seed = 7; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
      const pick = () => { const k = rnd(10); return k < 3 ? rnd(0x80) : k < 5 ? 0x80 + rnd(0x780) : k < 7 ? 0x800 + rnd(0xd000) : k < 8 ? 0xd800 + rnd(0x800) : k < 9 ? [0x2028, 0x2029, 0x22, 0x5c, 0x7f, 0][rnd(6)] : 0xe000 + rnd(0x2000); };
      const strings = ["", "plain", "\\"", "\\\\", "\\u0001\\b\\f\\n\\r\\t\\u001f", "\\u2028\\u2029", "\\ud800", "x\\udc00y", "\\ud83d\\ude00", "\\udbff\\udfff", "caf\\u00e9", "\\uffff"];
      for (let i = 0; i < 2000; i++) { let s = ""; const n = rnd(40); for (let j = 0; j < n; j++) { const c = pick(); if (c >= 0xd800 && c <= 0xdbff && rnd(2)) s += String.fromCharCode(c, 0xdc00 + rnd(0x400)); else s += String.fromCharCode(c); } strings.push(s); }
      const numbers = [NaN, Infinity, -Infinity, -0, 0, 1.5, 1e21, -1e-7, Number.MAX_SAFE_INTEGER + 2, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 1761900000123, 5e-324, 1.7976931348623157e308, 0.1 + 0.2, -42];
      for (let i = 0; i < 2000; i++) numbers.push(rnd(2) ? rnd(0x7fffffff) * (rnd(2) ? 1 : -1) * 4096 + rnd(4096) : (rnd(1e9) - 5e8) / (1 + rnd(1000)));
      const t = 1761900000000;
      const f = (path, extra = {}) => ({ path, kind: "folder", ref: null, created: t, updated: t + 1, fid: "fid" + path.length, ident: "fid" + path.length, ...extra });
      const entries = [f("/a"), f("/q\\"u\\\\o\\u0001te\\u2028\\u2029"), f("/lone\\ud800x"), f("/nofid", { fid: undefined, ident: undefined }), f("/mode", { mode: "python" }), f("/fidonly", { ident: undefined }),
        f("/nan", { created: NaN, updated: NaN }), f("/inf", { created: Infinity, updated: -Infinity }), f("/negz", { created: -0, updated: -0 }), f("/frac", { created: 1.5, updated: 1e21 }), f("/noc", { created: undefined }),
        { path: "/n.ipynb", kind: "notebook", ref: "nbref", created: t, updated: t, ident: "nbref", mode: "sage" }, { path: "/d.csv", kind: "file", ref: "/d.csv", created: 1.5, updated: NaN, fid: "dfid", ident: "dfid", size: 3 },
        { path: "/b.board.json", kind: "board", ref: "bref\\u2028", created: t, updated: t, ident: "bref\\u2028" }];
      for (const e of entries) for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
      return { bad: await m.writerCheck(strings, numbers, entries), n: [strings.length, numbers.length, entries.length] };
    })()`);
    check(r.bad.length === 0, `writer: the direct writer is JSON.stringify and TextEncoder byte for byte over ${r.n[0]} strings (BMP, astral, lone surrogates, controls, U+2028/9), ${r.n[1]} numbers (NaN, ±Infinity, -0, 1.5, 1e21, -1e-7, past 2^53, random) and ${r.n[2]} entries' records and lines (with and without fid and mode, NaN, ±Infinity and -0 times): ` + JSON.stringify(r.bad.slice(0, 3)));
  });

  // ---- r2c "identity" (grader's P-1, P-2, P-3, P-5; H-A2's stale tails through each sink): the same workspace
  // exported by the reference and by this build, through OPFS, the picker and the Blob sink, compared byte for byte
  await scenario("identity", async () => {
    // (P-1: times written straight into IndexedDB, as no API writes them; P-3: folders with and without fid and mode;
    // P-4/H-A2: a 3 MiB stored file, so the archive takes several recycled slices and a short last one)
    await idb("sagebrush-workspace", "entries", `(s) => { const t = Date.now(); const f = (path, extra) => s.put({ path, kind: "folder", ref: null, created: t, updated: t, nkey: path.slice(0, path.lastIndexOf("/")) + "\\u0000" + path.slice(path.lastIndexOf("/") + 1), ...extra });
      f("/p1", { fid: "p1fid", ident: "p1fid" });
      for (const [n, c, u] of [["nan", NaN, NaN], ["pinf", Infinity, Infinity], ["ninf", -Infinity, -Infinity], ["negz", -0, -0], ["frac", 1.5, 1.5], ["big", 1e21, 1e21], ["small", -1e-7, 1e21]]) f("/p1/" + n, { created: c, updated: u, fid: "p1" + n, ident: "p1" + n });
      f("/p3", { fid: "p3fid", ident: "p3fid" }); f("/p3/nofid", {}); f("/p3/withmode", { fid: "p3m", ident: "p3m", mode: "python" }); f("/p3/fidonly", { fid: "p3f" }); return null; }`);
    // (P-2: hard names through the workspace's own API: made, or refused, each)
    const names = ["q\"uote", "back\\slash", "ctl\u0001", "ls ", "ps ", "lone\ud800"];
    const made = await ev(`(async () => { const out = []; await ${W}.mkdir("/p2").catch(() => {}); for (const n of ${JSON.stringify(names)}) { try { await ${W}.mkdir("/p2/" + n); out.push([n, "made"]); } catch (e) { out.push([n, "refused: " + String(e?.message ?? e).slice(0, 80)]); } } return out; })()`);
    check(made.length === names.length && made.every(([, r]) => r === "made" || /^refused: ./.test(r)), "identity P-2: each hard folder name is made, or refused by the workspace with a reason: " + JSON.stringify(made));
    await ev(`(async () => { const b = new Uint8Array(3 * 2 ** 20 + 12345); for (let i = 0; i < b.length; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(b.length, i + 65536))); await ${W}.mkdir("/p4").catch(() => {}); await ${W}.create("/p4/big.zip", { content: b }); return 1; })()`);
    for (const sink of ["opfs", "picker", "blob"]) {
      await useRef(true);
      const c0 = serve.servedChunk, w0 = serve.servedWorker;
      const a = await sinkExport(sink, join(out, `id-ref-${sink}.zip`));
      const aIs = await ev(WHICH);
      check(!a.stopped && serve.servedChunk > c0 && serve.servedWorker > w0 && aIs === "reference", `identity (${sink}): the reference exports the workspace, its chunk and its worker both served in place of the build's (${serve.servedChunk - c0} / ${serve.servedWorker - w0}), the page running it (${aIs}): ` + (a.stopped ?? a.name));
      await useRef(false);
      const b = await sinkExport(sink, join(out, `id-new-${sink}.zip`));
      const bIs = await ev(WHICH);
      check(!b.stopped && bIs === "this build", `identity (${sink}): this build exports it, the page running it (${bIs}): ` + (b.stopped ?? b.name));
      if (a.stopped || b.stopped) continue;
      const c = compare(join(out, `id-ref-${sink}.zip`), join(out, `id-new-${sink}.zip`));
      check(!c.error && c.ndiffs === 0 && c.manifest, `identity (${sink}): every member, local header and central record byte-identical to b00fb43f's, manifest.json identical but for captured and created (${c.members} members): ` + JSON.stringify(c));
      const man = member(join(out, `id-new-${sink}.zip`), "manifest.json").toString("utf8");
      const parsed = (() => { try { return JSON.parse(man); } catch { return undefined; } })();
      check(parsed !== undefined && JSON.stringify(parsed) === man && /"path":"\/p1\/nan","kind":"folder","fid":"p1nan","created":null,"modified":null/.test(man) && /"path":"\/p1\/negz","kind":"folder","fid":"p1negz","created":0,"modified":0/.test(man) && /"created":1e\+21/.test(man), `identity (${sink}) P-1: the manifest is JSON.stringify(JSON.parse(it)) byte for byte, NaN and ±Infinity null, -0 as 0, 1e21 as 1e+21`);
      check(/"path":"\/p3\/nofid","kind":"folder","created":/.test(man) && /"path":"\/p3\/withmode","kind":"folder","fid":"p3m",[^}]*,"mode":"python"\}/.test(man) && /"path":"\/p3\/fidonly","kind":"folder","fid":"p3f","created"/.test(man), `identity (${sink}) P-3: a folder without fid has none, one with a mode has it last, and nothing absent is written as ""`);
      if (sink === "opfs") check(b.stats?.blobBytes === 0 && b.stats?.sliceBytes <= 16 * SLICE, "identity (opfs): no byte held in Blob parts, the slices " + (b.stats?.sliceBytes / SLICE) + " MiB in all");
      if (sink === "blob") console.log("(identity blob: bytes held in Blob parts " + b.stats?.blobBytes + ", read back from them " + b.stats?.blobReadBytes + ", slices " + (b.stats?.sliceBytes / SLICE) + " MiB)");
    }
    // (P-1 for the capture log: every line the lookup reads is JSON.stringify(JSON.parse(line)) byte for byte)
    await ev(SINKS.opfs.setup);
    await hooks(`afterCapture: async (p) => { if (p === "/data/primes.csv") await window.sagebrush.workspace.write(p, "n,p\\n1,2\\n"); }, captureChunk: (ch) => { (window.__cap ??= []).push(ch.slice()); }`);
    await ev(`(() => { window.__cap = []; return 1; })()`);
    const cl = await exportOnce(join(out, "id-cap.zip"));
    const lines = await ev(`(async () => { const t = await new Blob(window.__cap).text(); const l = t.split("\\n").filter(Boolean); return { n: l.length, bad: l.filter((x) => JSON.stringify(JSON.parse(x)) !== x).slice(0, 3), nan: l.some((x) => x.startsWith('["/p1/nan","folder","p1nan"]')) }; })()`);
    check(!cl.stopped && lines.n > 20 && lines.bad.length === 0 && lines.nan, "identity P-1: every capture line (" + lines.n + ") is JSON.stringify(JSON.parse(line)) byte for byte: " + JSON.stringify(lines.bad));
    // (the fixtures taken away again)
    await idb("sagebrush-workspace", "entries", `(s) => { s.delete(IDBKeyRange.bound("/p1", "/p1/\\uffff")); s.delete(IDBKeyRange.bound("/p3", "/p3/\\uffff")); return null; }`);
    await ev(`(async () => { for (const n of ${JSON.stringify(names)}) await ${W}.remove("/p2/" + n).catch(() => {}); await ${W}.remove("/p2").catch(() => {}); await ${W}.remove("/p4/big.zip").catch(() => {}); await ${W}.remove("/p4").catch(() => {}); return 1; })()`);
    await reload();
  });

  // ---- r2c at 70,000 folders (the CI scale fixture): identity against the reference; R3's aggregate (the slices at
  // most 16 MiB in all, none in Blob parts), the flushes per spool, P-6's fast paths (the archive's and the central
  // directory's bytes), R1 (the clock read at every record boundary) and the writing loop's yields (a 20 ms heartbeat)
  await scenario("identity70k", async () => {
    const N70 = 70000;
    await idb("sagebrush-workspace", "entries", `(s) => { const t = Date.now(), pad = "x".repeat(440), parents = 10, per = Math.ceil((${N70} - parents) / parents); let made = 0;
      for (let p = 0; p < parents; p++) { const top = "/s70k" + p, fid = "s70kfid" + p; s.put({ path: top, kind: "folder", ref: null, created: t, updated: t, fid, ident: fid, nkey: "/\\u0000" + top.slice(1) }); made++;
        for (let i = 0; i < per && made < ${N70}; i++, made++) { const path = top + "/" + pad + String(i).padStart(6, "0"), f = "s70kfid" + p + "-" + i; s.put({ path, kind: "folder", ref: null, created: t, updated: t, fid: f, ident: f, nkey: top + "\\u0000" + path.slice(top.length + 1) }); } }
      return null; }`);
    await useRef(true);
    const a = await sinkExport("opfs", join(out, "id70-ref.zip"));
    const aIs = await ev(WHICH);
    await useRef(false);
    await ev(`(() => { window.__hb = []; clearInterval(window.__hbt); window.__hbt = setInterval(() => window.__hb.push(performance.now()), 20); return 1; })()`);
    const b = await sinkExport("opfs", join(out, "id70-new.zip"), `onPlan: () => { window.__w0 = performance.now(); }, onHand: (blob, name, then) => { window.__w1 = performance.now(); window.__exp = { blob, name, then }; }`);
    const gap = await ev(`(() => { clearInterval(window.__hbt); const h = window.__hb.filter((t) => t >= window.__w0 && t <= window.__w1); let g = 0; for (let i = 1; i < h.length; i++) g = Math.max(g, h[i] - h[i - 1]); return [Math.round(g), h.length]; })()`);
    const bIs = await ev(WHICH);
    check(!a.stopped && !b.stopped && aIs === "reference" && bIs === "this build", `identity70k: both export the 70,000 folders, the reference (${aIs}) and this build (${bIs}): ` + (a.stopped ?? "") + (b.stopped ?? ""));
    if (!a.stopped && !b.stopped) {
      const c = compare(join(out, "id70-ref.zip"), join(out, "id70-new.zip"));
      check(!c.error && c.ndiffs === 0 && c.manifest && c.members >= N70, `identity70k: every member, local header and central record byte-identical to b00fb43f's, manifest.json identical but for captured and created (${c.members} members): ` + JSON.stringify(c));
      const st = b.stats ?? {};
      console.log("(identity70k stats: " + JSON.stringify({ ...st, rowSegs: st.rowSegs?.length, refs: undefined }) + ")");
      check(st.sliceBytes <= 16 * SLICE && st.blobBytes === 0, `identity70k (R3): the slices allocated for all spools, sinks and replays together ${st.sliceBytes / SLICE} MiB (at most 16), bytes held in Blob parts ${st.blobBytes} (0 with OPFS)`);
      const fl = st.flushes ?? {}, sz = st.sizes ?? {};
      // (a spool's last partial slice is flushed only if it is read: the capture log's isn't, without a lookup)
      const within = (k) => fl[k] >= Math.floor(sz[k] / SLICE) && fl[k] <= Math.ceil(sz[k] / (SLICE - 8192));
      check(["cd", "manifest", "capture", "rows"].every(within), "identity70k: each spool flushed once per slice it fills, no more: " + JSON.stringify({ flushes: fl, sizes: sz }));
      check(st.records === c.members - 1 && st.clockReads >= st.records, `identity70k (R1): writing read the clock at every record boundary: ${st.clockReads} reads for ${st.records} records`);
      // (500 ms: the gaps of a loop that yields include the page's own setup-debt collection (about 100-150 ms at this
      // size, lookalike plan L2's subject); a loop that never yields stops the heartbeat for seconds)
      check(gap[0] <= 500 && gap[1] > 20, `identity70k: the writing loop yields throughout: a 20 ms heartbeat's longest gap while writing ${gap[0]} ms (${gap[1]} beats; at most 500)`);
      console.log(`(identity70k elapsed: preflight ${Math.round(st.preflightMs)} ms, writing ${Math.round(st.writingMs)} ms)`);
    }
    // (capid at 70k (P-6's spool control): an accepted write after its capture, so the tree check's lookup reads the
    // whole capture log; as it read it, byte for byte the log an unbuffered writer makes from the raw rows)
    await ev(`${W}.create("/zz-capid70.csv", { content: "a\\n" }).then(() => 1)`);
    const cb = await sinkExport("opfs", join(out, "id70-cap.zip"), `afterCapture: async (p) => { if (p === "/zz-capid70.csv") await window.sagebrush.workspace.write(p, "b\\n"); }, captureChunk: (ch) => { (window.__cap ??= []).push(ch.slice()); }`);
    const cr = await ev(`(async () => {
      const hex = async (blob) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))].map((b) => b.toString(16).padStart(2, "0")).join("");
      const rows = await new Promise((ok, no) => { const q = indexedDB.open("sagebrush-workspace"); q.onsuccess = () => { const d = q.result, g = d.transaction("entries").objectStore("entries").getAll(); g.onsuccess = () => { d.close(); ok(g.result); }; g.onerror = () => no(g.error); }; q.onerror = () => no(q.error); });
      const lines = rows.filter((e) => e.path !== "/" && e.path !== "/Trash" && !e.path.startsWith("/Trash/")).map((e) => JSON.stringify([e.path, e.kind, e.ident ?? null]) + "\\n");
      const ref = new Blob(lines), got = new Blob(window.__cap ?? []);
      window.__cap = [];
      return { lines: lines.length, ref: await hex(ref), got: await hex(got), refBytes: ref.size, gotBytes: got.size };
    })()`);
    check(!cb.stopped && cr.lines >= N70 && cr.got === cr.ref && cr.gotBytes === cr.refBytes, `identity70k (capid): the capture log as the lookup read it is byte for byte the unbuffered reference (${cr.gotBytes} bytes, ${cr.lines} lines): ` + (cb.stopped ?? ""));
    await ev(`${W}.remove("/zz-capid70.csv").then(() => 1, () => 0)`);
    await idb("sagebrush-workspace", "entries", `(s) => s.delete(IDBKeyRange.bound("/s70k", "/s70k\\uffff"))`);
    await reload();
  });

  // ---- r2c P-6, each fast path's slow path: 10,000 folders exported by the reference, then by this build three times,
  // each with only one scratch file's appends held 150 ms (longer than a slice takes to fill): the archive's, the
  // central directory's, the capture log's.  So at that file's slice boundaries the other slice is still away and the
  // fast path must wait for it; one that drops its slow path's promise shows in the bytes (the archive and the
  // central directory against the reference; the capture log against the raw rows, read by a lookup)
  await scenario("fastpaths", async () => {
    const N10 = 10000;
    await idb("sagebrush-workspace", "entries", `(s) => { const t = Date.now(), pad = "w".repeat(400); s.put({ path: "/s10k", kind: "folder", ref: null, created: t, updated: t, fid: "s10kfid", ident: "s10kfid", nkey: "/\\u0000s10k" });
      for (let i = 0; i < ${N10}; i++) { const name = pad + String(i).padStart(6, "0"), path = "/s10k/" + name, f = "s10kfid-" + i; s.put({ path, kind: "folder", ref: null, created: t, updated: t, fid: f, ident: f, nkey: "/s10k\\u0000" + name }); }
      return null; }`);
    await useRef(true);
    const a = await sinkExport("opfs", join(out, "fp-ref.zip"));
    check(!a.stopped && (await ev(WHICH)) === "reference", "fastpaths: the reference exports the 10,000 folders: " + (a.stopped ?? a.name));
    await useRef(false);
    for (const [label, re] of [["the archive held", "-out.zip$"], ["the central directory held", "-cd$"]]) {
      const b = await sinkExport("opfs", join(out, "fp-new.zip"), `appendDelayMs: 150, appendDelayRe: ${JSON.stringify(re)}`);
      const c = !a.stopped && !b.stopped ? compare(join(out, "fp-ref.zip"), join(out, "fp-new.zip")) : { error: b.stopped };
      // (the hold took effect: that file's boundaries waited for its other slice, so the slow path ran)
      const key = label.includes("archive") ? "archive" : "cd";
      console.log(`(fastpaths ${label}: stats ` + JSON.stringify({ ...b.stats, rowSegs: b.stats?.rowSegs?.length }) + ")");
      check(b.stats?.waits?.[key] > 0, `fastpaths (${label}): the hold made the ${key}'s boundaries wait (${b.stats?.waits?.[key]} times; the slow path ran)`);
      check(!c.error && c.ndiffs === 0 && c.manifest, `fastpaths (${label}): every member, local header and central record byte-identical to the reference's: ` + JSON.stringify(c).slice(0, 200));
    }
    await ev(`${W}.create("/zz-fp.csv", { content: "a\\n" }).then(() => 1)`);
    await ev(`(() => { window.__cap = []; return 1; })()`);
    const cb = await sinkExport("opfs", join(out, "fp-cap.zip"), `appendDelayMs: 150, appendDelayRe: "-capture$", afterCapture: async (p) => { if (p === "/zz-fp.csv") await window.sagebrush.workspace.write(p, "b\\n"); }, captureChunk: (ch) => { (window.__cap ??= []).push(ch.slice()); }`);
    const cr = await ev(`(async () => {
      const hex = async (blob) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))].map((b) => b.toString(16).padStart(2, "0")).join("");
      const rows = await new Promise((ok, no) => { const q = indexedDB.open("sagebrush-workspace"); q.onsuccess = () => { const d = q.result, g = d.transaction("entries").objectStore("entries").getAll(); g.onsuccess = () => { d.close(); ok(g.result); }; g.onerror = () => no(g.error); }; q.onerror = () => no(q.error); });
      const lines = rows.filter((e) => e.path !== "/" && e.path !== "/Trash" && !e.path.startsWith("/Trash/")).map((e) => JSON.stringify([e.path, e.kind, e.ident ?? null]) + "\\n");
      const ref = new Blob(lines), got = new Blob(window.__cap ?? []);
      window.__cap = [];
      return { lines: lines.length, ref: await hex(ref), got: await hex(got), refBytes: ref.size, gotBytes: got.size };
    })()`);
    console.log("(fastpaths the capture log held: waits " + JSON.stringify(cb.stats?.waits) + ")");
    check(cb.stats?.waits?.capture > 0, `fastpaths (the capture log held): the hold made the capture log's flushes wait (${cb.stats?.waits?.capture} times)`);
    check(!cb.stopped && cr.lines >= N10 && cr.got === cr.ref && cr.gotBytes === cr.refBytes, `fastpaths (the capture log held): the capture log as the lookup read it is byte for byte the unbuffered reference (${cr.gotBytes} bytes, ${cr.lines} lines): ` + (cb.stopped ?? ""));
    await ev(`${W}.remove("/zz-fp.csv").then(() => 1, () => 0)`);
    await idb("sagebrush-workspace", "entries", `(s) => s.delete(IDBKeyRange.bound("/s10k", "/s10k\\uffff"))`);
    await reload();
  });

  // ---- r2c P-6 (breathe): without OPFS the spools' flushes and the Blob sink never wait on the worker, so only breathe's
  // yields let the page run while 20,000 folders are written: a 20 ms heartbeat's longest gap while writing
  await scenario("yields", async () => {
    const N20 = 20000;
    await idb("sagebrush-workspace", "entries", `(s) => { const t = Date.now(), pad = "y".repeat(200); s.put({ path: "/s20k", kind: "folder", ref: null, created: t, updated: t, fid: "s20kfid", ident: "s20kfid", nkey: "/\\u0000s20k" });
      for (let i = 0; i < ${N20}; i++) { const name = pad + String(i).padStart(6, "0"), path = "/s20k/" + name, f = "s20kfid-" + i; s.put({ path, kind: "folder", ref: null, created: t, updated: t, fid: f, ident: f, nkey: "/s20k\\u0000" + name }); }
      return null; }`);
    await ev(`(() => { window.__hb = []; clearInterval(window.__hbt); window.__hbt = setInterval(() => window.__hb.push(performance.now()), 20); return 1; })()`);
    await hooks(`noOpfs: true, onPlan: () => { window.__w0 = performance.now(); }, onHand: (blob, name, then) => { window.__w1 = performance.now(); window.__exp = { blob, name, then }; }`);
    const y = await exportOnce(join(out, "yields.zip"));
    const gap = await ev(`(() => { clearInterval(window.__hbt); const h = window.__hb.filter((t) => t >= window.__w0 && t <= window.__w1); let g = 0; for (let i = 1; i < h.length; i++) g = Math.max(g, h[i] - h[i - 1]); return [Math.round(g), h.length, Math.round(window.__w1 - window.__w0)]; })()`);
    check(!y.stopped && gap[0] <= 500 && gap[1] > 10, `yields: without OPFS, 20,000 folders written with the page kept running: a 20 ms heartbeat's longest gap ${gap[0]} ms (${gap[1]} beats over ${gap[2]} ms): ` + (y.stopped ?? y.name));
    await idb("sagebrush-workspace", "entries", `(s) => s.delete(IDBKeyRange.bound("/s20k", "/s20k\\uffff"))`);
  });

  // ---- r2c "slices": Cancel while a slice is in flight (the worker holding each append 1.5 s): the Cancel within
  // 250 ms, no slice handed over and none made after it, no error from the late replies, scratch and lock gone
  await scenario("slicecancel", async () => {
    await ev(`(async () => { const b = new Uint8Array(4 * 2 ** 20); for (let i = 0; i < b.length; i += 65536) crypto.getRandomValues(b.subarray(i, i + 65536)); await ${W}.create("/sc-big.zip", { content: b }); return 1; })()`);
    const before = await lastAt();
    await hooks(`appendDelayMs: 1500, onMember: (p) => { if (p !== "/sc-big.zip") return; setTimeout(() => { window.__clickAt = performance.now(); [...document.querySelectorAll(".sbfprev button")].find((x) => x.textContent === "Cancel")?.click(); }, 400); }`);
    await ev(`(() => { window.__cancelledAt = 0; window.__clickAt = 0; new MutationObserver(() => { if (!window.__cancelledAt && /The export was cancelled/.test(document.querySelector(".sbfprev")?.textContent ?? "")) window.__cancelledAt = performance.now(); }).observe(document.body, { subtree: true, childList: true, characterData: true }); return 1; })()`);
    const errs = errors.length;
    const x = await exportOnce(join(out, "sc.zip"));
    const took = await ev(`window.__cancelledAt && window.__clickAt ? window.__cancelledAt - window.__clickAt : -1`);
    const st = await ev(`window.__SB_EXPORT_TEST__.stats`);
    check(!!x.stopped && /cancelled/.test(x.stopped) && st?.stopMs >= 0 && st.stopMs <= 250, "slices: Cancel with a slice in the worker's hands stops the export within 250 ms, its late answer not waited for: " + Math.round(st?.stopMs ?? -1) + " ms (the cancelled line after the scratch's removal, queued behind the held appends: " + Math.round(took) + " ms)");
    check(st?.postsAfterStop === 0 && st?.slicesAfterStop === 0, "slices: after the Cancel no slice is handed over and none is made: " + JSON.stringify({ posts: st?.postsAfterStop, made: st?.slicesAfterStop }));
    check(await until(`${LOCKS}.then((m) => m === 0)`, 15000) && (await until(OPFS(`let n = 0; for await (const _ of d.keys()) n++; return n === 0;`), 10000)), "slices: …the late replies come and go: no scratch file, no lock");
    await sleep(500);
    check(errors.length === errs && (await lastAt()) === before, "slices: …no page error from a late reply, the status line unchanged: " + errors.slice(errs).join(" | ").slice(0, 200));
    await ev(`${W}.remove("/sc-big.zip").then(() => 1)`);
  });

  // ---- r2c "rows" (grader's P-7, O-2; astra's obligations): the rows spool removed on every exit, before any panel
  // is shown; kept through Ready and a closed picker; its faults leave nothing
  await scenario("rows", async () => {
    const shows = (re) => until(`[...(${P}?.querySelectorAll("button") ?? [])].some((b) => ${re}.test(b.textContent))`, 120000);
    const clickP = (re) => ev(`(() => { [...(${P}?.querySelectorAll("button") ?? [])].find((b) => ${re}.test(b.textContent))?.click(); return 1; })()`);
    const settled = async () => (await until(`${LOCKS}.then((m) => m === 0)`, 15000)) && (await rowsFiles()).length === 0;
    let before = await lastAt();
    // (1) the refusal: gone while the panel shows
    await idb("sagebrush-workspace", "entries", `(s) => { const t = Date.now(); return s.put({ path: "/rows-cloud.csv", kind: "file", ref: "/rows-cloud.csv", size: 10, created: t, updated: t, fid: "rcfid", ident: "rcfid", sha256: "0".repeat(64), remote: true, fetch: "0".repeat(64) }); }`);
    await hooks();
    await startFlow();
    const refusedShown = (await shows(/^Export again$/)) && /isn't on this device yet/.test(await panelText());
    const duringRefusal = await rowsFiles();
    await closeFlow();
    check(refusedShown && duringRefusal.length === 0 && (await settled()), "rows: refusal: the records are removed before the refusal is shown (none while it shows), and nothing is left after it: " + JSON.stringify(duringRefusal));
    await idb("sagebrush-workspace", "entries", `(s) => s.delete("/rows-cloud.csv")`);
    // (2) Cancel in preflight
    await hooks(`preflightMember: (p) => new Promise((r) => { if (window.__pm) return r(); window.__pm = 1; setTimeout(() => { [...document.querySelectorAll(".sbfprev button")].find((x) => x.textContent === "Cancel")?.click(); setTimeout(r, 300); }, 300); })`);
    await ev(`(() => { window.__pm = 0; return 1; })()`);
    await startFlow();
    const cancelShown = await shows(/^Export again$/);
    const duringCancel = await rowsFiles();
    await closeFlow();
    check(cancelShown && duringCancel.length === 0 && (await settled()), "rows: Cancel in preflight: removed before the stopped panel shows, nothing left: " + JSON.stringify(duringCancel));
    // (3) Cancel at Ready: kept while Ready shows, removed by its Cancel
    await hooks();
    await startFlow();
    await shows(/^Save…$/);
    const atReady = await rowsFiles();
    await clickP(/^Cancel$/);
    await sleep(300);
    check(atReady.length === 1 && (await settled()), "rows: Cancel at Ready: the records kept while Ready shows (" + atReady.length + "), removed by its Cancel, nothing left");
    // (4) the picker closed at Ready (r2c's "Close at ready": the ready panel's only other way back): kept, then Cancel
    await ev(`(() => { window.__pickerAsked = 0; window.showSaveFilePicker = async () => { window.__pickerAsked++; throw new DOMException("closed (a test)", "AbortError"); }; window.__SB_EXPORT_TEST__ = { stats: {} }; return 1; })()`);
    await startFlow();
    await shows(/^Save…$/);
    await clickP(/^Save…$/);
    await until(`window.__pickerAsked === 1`, 10000);
    const backAtReady = (await shows(/^Save…$/)) ? await rowsFiles() : null;
    await clickP(/^Cancel$/);
    await sleep(300);
    check(backAtReady?.length === 1 && (await settled()), "rows: the picker closed at Ready: back at Ready with the records kept (" + backAtReady?.length + "), then Cancel removes them, nothing left");
    await ev(`(() => { delete window.showSaveFilePicker; return 1; })()`);
    // (5) writing's own cleanup: a stop in writing (a structural change), and a finished export
    await hooks(`afterCapture: async (p) => { if (p === "/data/pic.png") await window.sagebrush.workspace.mkdir("/rows-new"); }`);
    await startFlow();
    await shows(/^Save…$/);
    await clickP(/^Save…$/);
    const stopShown = await shows(/^Export again$/);
    const duringStop = await rowsFiles();
    await closeFlow();
    check(stopShown && duringStop.length === 0 && (await settled()) && (await lastAt()) === before, "rows: a stop in writing: removed by writing's cleanup before the stopped panel shows, nothing left, the status line unchanged: " + JSON.stringify(duringStop));
    await ev(`${W}.remove("/rows-new").then(() => 1, () => 0)`);
    await hooks();
    const done = await exportOnce(join(out, "rows-ok.zip"));
    check(!done.stopped && (await settled()), "rows: a finished export leaves no records behind");
    before = await lastAt();
    // (6) the sweep: an abandoned rows file (its export holds no lock) removed by the next export's
    const ABANDONED = "00000000-0000-4000-8000-0000000000aa-rows";
    await ev(OPFS(`const f = await d.getFileHandle(${JSON.stringify(ABANDONED)}, { create: true }); const w = await f.createWritable(); await w.write("abandoned"); await w.close(); return 1;`));
    await hooks();
    const sw = await exportOnce(join(out, "rows-sweep.zip"));
    check(!sw.stopped && !(await scratchNames()).includes(ABANDONED), "rows: an abandoned -rows file is removed by the next export's sweep");
    // (if it wasn't, the test's own hand takes it out: the cases after this one see only their export's files)
    await ev(OPFS(`await d.removeEntry(${JSON.stringify(ABANDONED)}).catch(() => {}); return 1;`));
    before = await lastAt();
    // (O-2) the rows spool's own faults: its open failing (in the worker; and after its file was made), its append
    // failing, preflight failing after its records began: no file, no lock, the status line unchanged
    for (const [label, extra, re] of [["the rows spool's open fails", `failOpen: "rows"`, /couldn't be truncated/], ["the rows spool fails after its file is made", `failOpen: "rows-late"`, /failed after it was made/], ["a rows append fails", `failRowsAfter: 1`, /couldn't be written/], ["preflight fails after its records began", `caps: { file: 50000 }`, /can't be exported/]]) {
      await hooks(extra);
      const r = await exportOnce(join(out, "rows-f.zip"));
      check(!!r.stopped && re.test(r.stopped) && (await settled()) && (await lastAt()) === before, "rows (O-2): " + label + ": the export stops, no rows file, no lock, the status line unchanged: " + String(r.stopped ?? "not stopped").slice(-140));
    }
  });

  // ---- r2c P-9 (astra's ruling r1a) and grader's O-3: a folder's metadata and captured as preflight observed them
  await scenario("metadata", async () => {
    await ev(`${W}.mkdir("/meta").then(() => 1)`);
    const old = await ev(`${W}.stat("/meta")`);
    // (the bracket; and a permitted edit before Save: the folder's row changed in place, no op (the workspace's API
    // has no non-structural folder edit; this is what the migrator's or sync's metadata writes are), its modified
    // later and a mode: the archive carries the old values)
    await hooks(`beforePreflight: () => { window.__t0 = Date.now(); }, onPlan: async () => { window.__t1 = Date.now(); await new Promise((r) => setTimeout(r, 150)); await ${IDB}("sagebrush-workspace", "entries", (s) => { const q = s.get("/meta"); q.onsuccess = () => s.put({ ...q.result, updated: q.result.updated + 86400000 * 3, mode: "edited" }); }); }`);
    const m = await exportOnce(join(out, "meta.zip"));
    const t = await ev(`[window.__t0, window.__t1]`);
    check(!m.stopped, "metadata: an export with a folder's row edited in place before Save completes: " + (m.stopped ?? m.name));
    if (!m.stopped) {
      const z = inspect(join(out, "meta.zip"));
      const folders = z.entries.filter((e) => e.kind === "folder");
      check(folders.length > 3 && folders.every((e) => e.captured >= t[0] && e.captured <= t[1]), `metadata (P-9): every folder's captured (${folders.length}) lies inside preflight's bracket [${t[0]}, ${t[1]}], none at writing time`);
      const e = z.entries.find((x) => x.path === "/meta");
      const dos = spawnSync("python3", ["-I", "-c", "import sys, zipfile; i = zipfile.ZipFile(sys.argv[1]).getinfo('files/meta/'); print(list(i.date_time))", join(out, "meta.zip")], { encoding: "utf8" }).stdout.trim();
      const want = await ev(`(() => { const d = new Date(${old.updated}); return JSON.stringify([Math.min(2107, Math.max(1980, d.getFullYear())), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds() & ~1]).replace(/,/g, ", "); })()`);
      check(e && e.modified === old.updated && !("mode" in e) && dos === want, "metadata (P-9): an edit before Save is not exported: the folder's old modified, no mode, its old DOS time: " + JSON.stringify({ modified: e?.modified, was: old.updated, mode: e?.mode, dos, want }));
    }
    // (the structural counter-case: the folder renamed before Save stops the export, naming it)
    const before = await lastAt();
    await hooks(`onPlan: async () => { await window.sagebrush.workspace.rename("/meta", "/meta-renamed"); }`);
    const r = await exportOnce(join(out, "meta2.zip"));
    check(!!r.stopped && /\/meta/.test(r.stopped) && /while exporting/.test(r.stopped) && (await lastAt()) === before, "metadata: a rename of that folder before Save stops the export, naming it: " + String(r.stopped ?? "not stopped").slice(-140));
    await ev(`${W}.rename("/meta-renamed", "/meta").then(() => 1, () => 0)`);
    // (an edit the API doesn't support for a folder: refused)
    const refused = await ev(`${W}.write("/meta", "text").then(() => "accepted", (e) => "refused: " + String(e?.message ?? e).slice(0, 100))`);
    check(/^refused: ./.test(refused), "metadata: a content write to a folder, an edit the API doesn't support, is refused: " + refused);
    await ev(`${W}.remove("/meta").then(() => 1, () => 0)`);
  });

  // ---- r2c "rows-framing" (astra's H-A1, grader's addendum) and P-8 (the no-OPFS threshold), in a workspace of only
  // their fixtures (the others' rows kept aside and put back)
  await scenario("framing", async () => {
    const saved = await idb("sagebrush-workspace", "entries", `(s) => s.getAll()`);
    const keep = (e) => e.path === "/" || e.path === "/Trash" || e.path.startsWith("/Trash/");
    const putAll = (rows) => idb("sagebrush-workspace", "entries", `(s) => { s.clear(); for (const e of ${JSON.stringify(rows)}) s.put(e); return null; }`);
    // (after the page's reload, what it added of its own to a workspace it found nearly empty, listed and taken out
    // again (from IndexedDB, as the fixture was put in: no op), so the export sees exactly the fixture)
    const only = async (rows) => {
      const want = new Set(rows.map((e) => e.path));
      const extra = (await idb("sagebrush-workspace", "entries", `(s) => s.getAllKeys()`)).filter((k) => !want.has(k) && !keep({ path: k }));
      if (extra.length) console.log("(framing: entries the page added on its reload, taken out: " + JSON.stringify(extra).slice(0, 300) + ")");
      await idb("sagebrush-workspace", "entries", `(s) => { for (const k of ${JSON.stringify(extra)}) s.delete(k); return null; }`);
    };
    // (a folder's record: 89 + 2 L + 2 F bytes for an ASCII path of L characters, ident and fid of F, 13-digit times)
    const t = 1761900000000, F = 8;
    const rec = (L) => 89 + 2 * L + 2 * F;
    const folder = (path, i) => ({ path, kind: "folder", ref: null, created: t, updated: t, fid: "fr" + String(i).padStart(6, "0"), ident: "fr" + String(i).padStart(6, "0"), nkey: path.slice(0, path.lastIndexOf("/")) + "\u0000" + path.slice(path.lastIndexOf("/") + 1) });
    try {
      // (segments of SLICE - r bytes, r = 0..5, each ending on a record boundary; then one record alone)
      const rows = [folder("/f", 0)];
      let used = rec(2), i = 1;
      const pathOf = (L) => "/f/" + String(i).padStart(6, "0") + "y".repeat(L - 9);
      const segs = [];
      for (const r of [0, 1, 2, 3, 4, 5]) {
        let R = SLICE - r - used;
        // (m records summing to R: 105 + 2 L each, L in [9, 250] (a name at most 255); m has R's parity)
        let m = Math.ceil(R / rec(240));
        if ((R - (89 + 2 * F) * m) % 2) m++;
        let total = (R - (89 + 2 * F) * m) / 2;
        for (let k = 0; k < m; k++) { const L = Math.floor(total / (m - k)); total -= L; rows.push(folder(pathOf(L), i)); i++; }
        segs.push(SLICE - r);
        used = 0;
      }
      rows.push(folder(pathOf(40), i));
      segs.push(rec(40));
      check(rows.slice(1).every((e) => e.path.length >= 9 && e.path.length <= 1024 && e.path.length - 3 <= 255), "framing: the fixture's paths and names are within the workspace's bounds");
      await putAll([...saved.filter(keep), ...rows]);
      await reload();
      await only(rows);
      await hooks();
      const x = await exportOnce(join(out, "framing.zip"));
      const st = x.stats ?? {};
      const want = rows.reduce((n, e) => n + rec(e.path.length), 0);
      check(st.rowBytes === want && st.records === rows.length, `framing: the fixture's records are the sizes the test computed: ${st.rowBytes} bytes (computed ${want}), ${st.records} records (${rows.length})`);
      check(!x.stopped && JSON.stringify(st.rowSegs) === JSON.stringify(segs), "framing: the rows spool's segments are exactly " + JSON.stringify(segs.map((s) => s === SLICE ? "SLICE" : s >= SLICE - 5 ? "SLICE-" + (SLICE - s) : s)) + " (a record ending at the slice's end; remainders of 1-5 bytes each an early segment short by exactly that; one record alone last): " + JSON.stringify(st.rowSegs) + " " + (x.stopped ?? ""));
      check(st.rowBytes === st.rowSize && st.rowSegs?.reduce((a, b) => a + b, 0) === st.rowSize, `framing: no padding: the bytes flushed (${st.rowSegs?.reduce((a, b) => a + b, 0)}) are the records' bytes (${st.rowBytes}) and the spool's size (${st.rowSize})`);
      if (!x.stopped) { const z = inspect(join(out, "framing.zip")); check(!z.error && z.bad === null && z.entries.length === rows.length && z.entries.every((e, k) => e.path === rows[k].path), "framing: every record replayed whole, in order: " + z.entries.length + " entries"); }
      // (truncation refused: the spool cut by its last byte before writing replays it, with OPFS and without)
      for (const [label, extra] of [["OPFS", ""], ["Blob parts", "noOpfs: true"]]) {
        const before = await lastAt();
        await hooks(["cutRows: true", extra].filter(Boolean).join(", "));
        const c = await exportOnce(join(out, "cut.zip"));
        check(!!c.stopped && /scratch data was cut short/.test(c.stopped) && !(await ev(`!!window.__exp`)) && (await until(`${LOCKS}.then((m) => m === 0)`, 15000)) && (await scratchNames()).length === 0 && (await lastAt()) === before, `framing: the rows spool cut short (${label}) is refused, "cut short", nothing handed over, nothing left: ` + String(c.stopped ?? "not stopped").slice(-120));
      }
      // (P-8: without OPFS, the spools held in memory, the records counted: refused at the exact threshold, done one
      // byte below it.  The sum: each folder's central-record bound, manifest bound and comma, capture line, record)
      const P8 = [folder("/g", 0)];
      for (let k = 1; k <= 200; k++) P8.push(folder("/g/" + String(k).padStart(6, "0") + "z".repeat(20), k));
      const bytes = (s) => Buffer.byteLength(s);
      const cap13 = 1761900000000;
      const need = P8.reduce((n, e) => n + (46 + 12 + bytes(e.path) + 7) + (bytes(JSON.stringify({ path: e.path, kind: "folder", fid: e.fid, created: e.created, modified: e.updated, captured: cap13 })) + 1) + (bytes(JSON.stringify([e.path, "folder", e.ident])) + 1) + rec(e.path.length), 0);
      await putAll([...saved.filter(keep), ...P8]);
      await reload();
      await only(P8);
      // (the test's sum against the export's own accounting: its plan's three bounds and its records, with OPFS)
      await hooks(`onPlan: (plan) => { window.__plan = [plan.cdSpool, plan.manSpool, plan.capSpool]; }`);
      const pre = await exportOnce(join(out, "p8pre.zip"));
      const parts = await ev(`window.__plan`);
      const mine = [P8.reduce((n, e) => n + 46 + 12 + bytes(e.path) + 7, 0), P8.reduce((n, e) => n + bytes(JSON.stringify({ path: e.path, kind: "folder", fid: e.fid, created: e.created, modified: e.updated, captured: cap13 })) + 1, 0), P8.reduce((n, e) => n + bytes(JSON.stringify([e.path, "folder", e.ident])) + 1, 0), P8.reduce((n, e) => n + rec(e.path.length), 0)];
      check(!pre.stopped && JSON.stringify([...parts, pre.stats?.rowSize]) === JSON.stringify(mine), "P-8: the threshold the test computes is the export's own: its bounds and records " + JSON.stringify([...(parts ?? []), pre.stats?.rowSize]) + ", computed " + JSON.stringify(mine));
      for (const [label, cap, ok] of [["at the threshold", need - 1, false], ["one byte below it", need, true]]) {
        await hooks(`noOpfs: true, caps: { spoolBlob: ${cap} }`);
        const p = await exportOnce(join(out, "p8.zip"));
        if (ok) check(!p.stopped, `P-8: without OPFS, ${P8.length} folders needing ${need} bytes of in-memory spools, the records counted, with the cap at ${cap}: exported: ` + (p.stopped ?? p.name));
        else check(!!p.stopped && p.stopped.includes(NO_OPFS) && !(await ev(`!!window.__exp`)), `P-8: without OPFS, the same with the cap at ${cap} (${label}): refused in preflight, in plain words, nothing written: ` + String(p.stopped ?? "not stopped").slice(-200));
      }
    } finally {
      await putAll(saved);
      await reload();
    }
  });

  // (r2a: these three load pages (a second tab, the board page): they run before "structure", whose log-trim cases
  // leave the workspace in a state a newly loaded page quarantines)
  // ---- astra's E1-R2-A2: scratch ownership.  (1) This tab's export starts, its sweep paused before its listing (a test
  // hook); meanwhile another tab's export starts after it and reaches its OPFS handoff; then this sweep lists and
  // removes: the other export's archive survives (its lock is held), an abandoned file (no lock) is removed.  (2) The
  // probe's write or flush failing, and a scratch file's open failing, leave no file behind.
  await scenario("scratch", async () => {
    const OPFS = (body) => `navigator.storage.getDirectory().then((r) => r.getDirectoryHandle("sagebrush-export", { create: true })).then(async (d) => { ${body} })`;
    const names = () => ev(OPFS(`const n = []; for await (const k of d.keys()) n.push(k); return n;`));
    const OLD = "00000000-0000-4000-8000-000000000000-old";
    // (the other tab, made ready to export first: its own hooks keep its handoff open until told)
    const b = await secondTab();
    await b.until(`!!document.querySelector("#wsfilesbtn") && !document.querySelector("#wsfilesbtn").hidden`, 60000);
    await b.ev(`(() => { if (document.querySelector("#wssidebar").hidden) document.querySelector("#wsfilesbtn").click(); return 1; })()`);
    await b.until(`!!document.querySelector("#wssidebar .fmeter")`, 60000);
    await b.ev(`(() => { document.querySelector("#wssidebar .fmeter").click(); window.__exp = null; window.__SB_EXPORT_TEST__ = { noPicker: true, onHand: (blob, name, then) => { window.__exp = { blob, name, then }; } }; return 1; })()`);
    await b.until(`[...(document.querySelector(".sbfprev")?.querySelectorAll("button") ?? [])].some((x) => /^Export all current files/.test(x.textContent))`);
    // (this tab's export first, its sweep paused 10 s before it lists; then the other's)
    await hooks(`sweepPauseMs: 10000`);
    await startFlow();
    const t0 = Date.now();
    // (the other export started well after this one's sweep has begun: 3 s into its 10 s pause)
    await sleep(3000);
    const clickB = (re) => b.until(`(() => { const x = [...(document.querySelector(".sbfprev")?.querySelectorAll("button") ?? [])].find((y) => ${re}.test(y.textContent)); x?.click(); return !!x; })()`, 60000);
    const clickedB = await clickB(/^Export all current files/);
    const savedB = await clickB(/^Save…$/);
    const handing = await b.until(`!!window.__exp`, 60000);
    // (an abandoned file, made after the other export's own sweep: only this tab's paused sweep can remove it)
    await ev(OPFS(`const f = await d.getFileHandle(${JSON.stringify(OLD)}, { create: true }); const w = await f.createWritable(); await w.write("abandoned"); await w.close(); return 1;`));
    const other = (await names()).filter((x) => /-out\.zip$/.test(x));
    const inPause = Date.now() - t0 < 9000;
    check(clickedB && savedB && handing && other.length === 1 && inPause, "the other tab's export, started after this one, is handing off its archive from OPFS while this one's sweep waits: " + JSON.stringify(other) + " at " + (Date.now() - t0) + " ms");
    const ready = await until(`[...(${P}?.querySelectorAll("button") ?? [])].some((x) => /^(Save…|Export again)$/.test(x.textContent))`, 60000);
    const left = await names();
    check(ready && other.length === 1 && left.includes(other[0]), "a sweep begun before the other export, listing after it, leaves its handing-off archive (its lock held): " + JSON.stringify(left));
    check(ready && !left.includes(OLD), "…and removes the abandoned file, whose export holds no lock: " + JSON.stringify(left));
    await ev(`(() => { [...(${P}?.querySelectorAll("button") ?? [])].find((x) => x.textContent === "Cancel")?.click(); return 1; })()`);
    await until(`[...(${P}?.querySelectorAll("button") ?? [])].some((x) => x.textContent === "Close")`, 10000);
    await closeFlow();
    await b.ev(`(() => { window.__exp?.then?.(); return 1; })()`);
    await until(`${LOCKS}.then((m) => m === 0)`, 20000);
    await b.close();
    await ev(OPFS(`for (const k of [...(await (async () => { const n = []; for await (const k of d.keys()) n.push(k); return n; })())]) await d.removeEntry(k).catch(() => {}); return 1;`));
    // (setup faults: none may leave a file)
    for (const [label, extra, re] of [["the probe's write fails", `failProbe: "write"`, null], ["the probe's flush fails", `failProbe: "flush"`, null], ["a scratch spool's open fails", `failOpen: "spool"`, /couldn't be truncated/], ["the archive's scratch file's open fails", `failOpen: "sink"`, /couldn't be truncated/]]) {
      await hooks(extra);
      const r = await exportOnce(join(out, "sf.zip"));
      await handed().catch(() => {});
      await until(`${LOCKS}.then((m) => m === 0)`, 20000);
      const n = await names();
      check((re ? !!r.stopped && re.test(r.stopped) : !r.stopped) && n.length === 0, label + ": " + (re ? "the export stops, saying so, and " : "the export goes on (without OPFS), and ") + "no scratch file is left: " + JSON.stringify(n) + " " + String(r.stopped ?? "").slice(-160));
    }
  });

  // ---- astra's E1-R2-A3 (E1-A4): Cancel while the export waits for the workspace's lock, held by another tab, in
  // preflight and while writing: within 250 ms, timed in the page; this tab's request for the lock withdrawn at once;
  // and once the other tab lets the lock go, nothing late: no archive, no stamp, no scratch file, no lock.
  await scenario("lockwait", async () => {
    const WSL = "sagebrush-workspace";
    const pendingWs = `navigator.locks.query().then((q) => q.pending.filter((l) => l.name === ${JSON.stringify(WSL)}).length)`;
    const b = await secondTab();
    await b.until(`!!window.sagebrush?.workspace`, 60000);
    // (the other tab takes the workspace's lock when told, says so once it holds it, and lets it go when told)
    await b.ev(`(() => { const ch = new BroadcastChannel("sb-lockwait"); ch.onmessage = (m) => { if (m.data === "hold") navigator.locks.request(${JSON.stringify(WSL)}, () => new Promise((r) => { window.__release = r; ch.postMessage("held"); })); if (m.data === "release") { window.__release?.(); window.__release = null; } }; return 1; })()`);
    for (const [label, hook] of [["in preflight", "preflightMember"], ["while writing", "beforeCapture"]]) {
      // (at the first document's capture, this export asks the other tab to hold the lock, and goes on once it does)
      await hooks(`${hook}: () => { if (window.__asked) return; window.__asked = true; return new Promise((ok) => { const ch = new BroadcastChannel("sb-lockwait"); ch.onmessage = (m) => { if (m.data === "held") { ch.close(); ok(); } }; ch.postMessage("hold"); }); }`);
      await ev(`(() => { window.__asked = false; window.__clickAt = 0; window.__cancelledAt = 0; new MutationObserver(() => { if (!window.__cancelledAt && /The export was cancelled/.test(document.querySelector(".sbfprev")?.textContent ?? "")) window.__cancelledAt = performance.now(); }).observe(document.body, { subtree: true, childList: true, characterData: true }); return 1; })()`);
      const before = await lastAt();
      await startFlow();
      if (hook === "beforeCapture") { await until(`[...(${P}?.querySelectorAll("button") ?? [])].some((x) => x.textContent === "Save…")`, 60000); await panelButton(/^Save…$/); }
      const waiting = await until(`${pendingWs}.then((n) => n >= 1)`, 30000);
      await sleep(300);
      const waitingStill = (await ev(pendingWs)) >= 1;
      await ev(`(() => { const x = [...document.querySelectorAll(".sbfprev button")].find((y) => y.textContent === "Cancel"); window.__clickAt = performance.now(); x?.click(); return 1; })()`);
      const shown = await until(`!!window.__cancelledAt`, 5000);
      const took = await ev(`window.__cancelledAt && window.__clickAt ? window.__cancelledAt - window.__clickAt : -1`);
      const diag = shown ? "" : " " + JSON.stringify({ waiting, waitingStill, shown, clickAt: await ev(`window.__clickAt`), text: (await panelText()).slice(-200), locks: await ev(`navigator.locks.query().then((q) => JSON.stringify({ held: q.held.map((l) => l.name), pending: q.pending.map((l) => l.name) }))`) });
      check(waiting && waitingStill && shown && took >= 0 && took <= 250, "Cancel " + label + ", while the export waits for the workspace's lock held by another tab, stops it within 250 ms, timed in the page: " + Math.round(took) + " ms" + diag);
      await sleep(100);
      const left = await ev(pendingWs);
      check(left === 0, "…and its request for the lock is withdrawn at once, while the other tab still holds it: " + left + " waiting");
      await b.ev(`(() => { new BroadcastChannel("sb-lockwait").postMessage("release"); return 1; })()`);
      await sleep(1500);
      // (the stopped flow's panel closed: an export holds its lock, and its worker, until its panel is dismissed)
      await closeFlow();
      await sleep(300);
      const late = { exp: await ev(`!!window.__exp`), stamp: (await lastAt()) !== before, locks: await ev(LOCKS), scratch: await scratchCount(), pending: await ev(pendingWs) };
      check(!late.exp && !late.stamp && late.locks === 0 && late.scratch === 0 && late.pending === 0, "…then, the lock let go, nothing late: no archive, no stamp, no scratch file, nothing waiting, and once its panel is closed no export lock: " + JSON.stringify(late));
      await closeFlow();
    }
    await b.close();
  });

  // ---- astra's E1-A5 (r2: the evidence asked for): an export from the board page while that board's own save is
  // paused (the workspace's lock held by another tab), then let go: the export waits for it, and its member has the
  // edit; and a save refused (this origin's storage quota put below its use): the export stops, saying the board's
  // last changes aren't kept, nothing handed over, the status unchanged.  (The refusal: IndexedDB's put failing as a
  // full disk makes it fail, QuotaExceededError, injected in the page from the edit to the export's end.)
  await scenario("boardsave", async () => {
    const WSL = "sagebrush-workspace";
    const bdRef = await ev(`${W}.stat("/Plan.board.json").then((e) => e.ref)`);
    const b = await secondTab();
    await b.until(`!!window.sagebrush?.workspace`, 60000);
    await go(base + "board/?doc=local:" + encodeURIComponent(bdRef));
    check(await until(`!!window.sagebrush?.board?.snapshot() && !!document.querySelector('[data-sbb="files"]')`, 60000), "the board page opens the board, with its Files");
    await sleep(1500);
    await ev(`(() => { if (document.querySelector("#wssidebar").hidden) document.querySelector('[data-sbb="files"]').click(); return 1; })()`);
    await until(`!!document.querySelector("#wssidebar .fmeter")`, 60000);
    // (1) the save paused: the other tab holds the workspace's lock; an edit here; Export clicked; the lock let go 2 s on
    await b.ev(`(() => { navigator.locks.request(${JSON.stringify(WSL)}, () => new Promise((r) => (window.__release = r))); return 1; })()`);
    await until(`navigator.locks.query().then((q) => q.held.some((l) => l.name === ${JSON.stringify(WSL)}))`, 10000);
    await ev(`sagebrush.board.edit((d) => { (d.nodes ??= []).push({ id: "a5paused", text: "A5 the paused save" }); }).then(() => 1)`);
    await hooks();
    await startFlow();
    await sleep(2000);
    const early = await ev(`[...(${P}?.querySelectorAll("button") ?? [])].some((x) => /^(Save…|Export again)$/.test(x.textContent))`);
    await b.ev(`(() => { window.__release?.(); return 1; })()`);
    const ready = await until(`[...(${P}?.querySelectorAll("button") ?? [])].some((x) => /^(Save…|Export again)$/.test(x.textContent))`, 60000);
    let has = false, why = "";
    if (ready && (await ev(`[...${P}.querySelectorAll("button")].some((x) => x.textContent === "Save…")`))) {
      await panelButton(/^Save…$/);
      if (await until(`!!window.__exp`, 60000)) {
        const bytes = Buffer.from(await ev(`window.__exp.blob.arrayBuffer().then((a) => { let s = ""; const u = new Uint8Array(a); for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode(...u.subarray(i, i + 32768)); return btoa(s); })`), "base64");
        writeFileSync(join(out, "a5.zip"), bytes);
        has = member(join(out, "a5.zip"), "files/Plan.board.json").toString("utf8").includes("A5 the paused save");
        await handed();
      }
    } else why = (await panelText()).slice(-240);
    check(!early && ready && has, "an export while this board's save is paused waits for it, and its member has the edit made before the click: " + JSON.stringify({ early, ready, has, why }));
    await closeFlow();
    // (2) the save refused: the quota put below this origin's use, an edit, Export
    await ev(`(() => { const put = IDBObjectStore.prototype.put; window.__unrefuse = () => { IDBObjectStore.prototype.put = put; }; IDBObjectStore.prototype.put = function (...a) { throw new DOMException("the disk is full (a test)", "QuotaExceededError"); }; return 1; })()`);
    await ev(`sagebrush.board.edit((d) => { (d.nodes ??= []).push({ id: "a5refused", text: "A5 the refused save" }); }).then(() => 1, () => 1)`);
    await sleep(1500);
    const before = await lastAt();
    await hooks();
    const r = await exportOnce(join(out, "a5r.zip"));
    await ev(`(() => { window.__unrefuse(); return 1; })()`);
    check(!!r.stopped && /last changes aren't kept in your files/.test(r.stopped) && !(await ev(`!!window.__exp`)) && (await lastAt()) === before, "an export while this board's last save was refused stops, saying so, nothing handed over, the status unchanged: " + String(r.stopped ?? r.name).slice(-200));
    await b.close();
    await go(base);
    await openFiles();
  });

  // ---- rule 1 (§2, astra's E1-A1): every structural change during an export stops it, naming it
  await scenario("structure", async () => {
    const before = await lastAt();
    const stops = async (label, hook, re) => {
      await hooks(hook);
      const d = await exportOnce(join(out, "d.zip"));
      check(!!d.stopped && re.test(d.stopped) && !(await ev(`!!window.__exp`)), label + " stops the export, naming it: " + (d.stopped ?? "not stopped").slice(-200));
    };
    const after = (p, body) => `afterCapture: async (p) => { if (p === ${JSON.stringify(p)}) { const w = window.sagebrush.workspace; ${body} } }`;
    await ev(`${W}.create("/data/victim.txt", { content: "v" }).then(() => 1)`);
    await stops("a rename", after("/Algebra.ipynb", `await w.rename("/data/blob.xyz", "/data/moved.xyz");`), /blob\.xyz/);
    await ev(`${W}.rename("/data/moved.xyz", "/data/blob.xyz").then(() => 1)`);
    await stops("a move into another folder", after("/Algebra.ipynb", `await w.rename("/data/victim.txt", "/empty/victim.txt");`), /victim\.txt/);
    await ev(`${W}.rename("/empty/victim.txt", "/data/victim.txt").then(() => 1)`);
    await stops("a delete", after("/Algebra.ipynb", `await w.remove("/data/victim.txt");`), /victim\.txt/);
    await ev(`${W}.restore("/Trash/victim.txt").catch(() => ${W}.list("/Trash").then((l) => ${W}.restore(l.find((e) => /victim/.test(e.path)).path))).then(() => 1)`);
    await stops("a new file", after("/Algebra.ipynb", `await w.create("/data/new.txt", { content: "n" });`), /new\.txt/);
    await ev(`${W}.remove("/data/new.txt").then(() => 1)`);
    await ev(`${W}.remove("/data/victim.txt").then(() => 1)`);
    const trashed = await ev(`${W}.list("/Trash").then((l) => l.find((e) => /victim/.test(e.path)).path)`);
    await stops("a restore", after("/Algebra.ipynb", `await w.restore(${JSON.stringify(trashed)});`), /victim/);
    // (ops a server applied, and writes that changed an identity or a folder: put in the log as sync would)
    const inject = (op) => `afterCapture: async (p) => { if (p !== "/Algebra.ipynb") return; const seq = (await ${IDB}("sagebrush-workspace", "ops", (s) => s.count())) + 1e6; await ${IDB}("sagebrush-workspace", "ops", (s) => s.add({ ...${JSON.stringify(op)}, seq, t: Date.now(), device: "server", by: "server" })); }`;
    const csv = await ev(`${W}.stat("/data/primes.csv")`), data = await ev(`${W}.stat("/data")`);
    await stops("a server-applied rename", inject({ op: "rename", path: "/data/primes.csv", to: "/data/p2.csv", kind: "file", fid: csv.fid, origin: "server", after: { id: csv.fid, parent: data.fid, name: "p2.csv", kind: "file", trashed: false } }), /primes\.csv/);
    await stops("a write that changed the file's identity", inject({ op: "write", path: "/data/primes.csv", kind: "file", fid: "other", origin: "server", after: { id: "someone-else", parent: data.fid, name: "primes.csv", kind: "file", trashed: false } }), /primes\.csv/);
    await stops("a write that changed the file's folder", inject({ op: "write", path: "/data/primes.csv", kind: "file", fid: csv.fid, after: { id: csv.fid, parent: "another-folder", name: "primes.csv", kind: "file", trashed: false } }), /primes\.csv/);
    // (astra's E1-R2-A1: the op's own kind and its after's agree, but not with what was captured at that path and id)
    await stops("a write that changed the file's kind", inject({ op: "write", path: "/data/primes.csv", kind: "notebook", fid: csv.fid, after: { id: csv.fid, parent: data.fid, name: "primes.csv", kind: "notebook", trashed: false } }), /primes\.csv/);
    // (the log trimmed past S0: before the scan, and while the scan runs)
    const trim = `const m = await ${IDB}("sagebrush-workspace", "meta", (s) => s.get("opsFloor")); await ${IDB}("sagebrush-workspace", "meta", (s) => s.put(1e12, "opsFloor"));`;
    await stops("the log trimmed before the check", `afterCapture: async (p) => { if (p === "/Algebra.ipynb") { ${trim} } }`, /change log was trimmed/);
    await idb("sagebrush-workspace", "meta", `(s) => s.put(0, "opsFloor")`);
    await stops("the log trimmed while the check runs", `duringTreeScan: async () => { ${trim} }`, /change log was trimmed/);
    await idb("sagebrush-workspace", "meta", `(s) => s.put(0, "opsFloor")`);
    check((await lastAt()) === before, "…the status line unchanged by every stopped export");
  });

  // ---- 10. the caps, in preflight: refused before Save…, nothing written
  await scenario("capspre", async () => {
    const refusedPre = async (label, extra, re) => {
      await hooks(extra);
      const r = await exportOnce(join(out, "cp.zip"));
      check(!!r.stopped && re.test(r.stopped) && !(await ev(`!!window.__exp`)), label + ": " + (r.stopped ?? "not stopped").slice(-160));
    };
    const sz = await docSizes();
    await refusedPre("a notebook over the document cap is refused in preflight", `caps: { doc: ${sz["/Algebra.ipynb"] - 1} }`, /Algebra\.ipynb is larger than/);
    // (the board alone over the cap, and only once its picture is inlined: its stored document is far under it)
    const bdStored = await ev(`${W}.read("/Plan.board.json").then((r) => JSON.stringify(r.content).length)`);
    const others = Math.max(...Object.entries(sz).filter(([p]) => p !== "/Plan.board.json").map(([, v]) => v));
    const cut = Math.max(others, bdStored) + 1000;
    check(sz["/Plan.board.json"] > cut, "(the board's member, " + sz["/Plan.board.json"] + " bytes, is over a cap of " + cut + " only with its picture)");
    await refusedPre("a board over the cap only with its pictures inlined is refused in preflight", `caps: { doc: ${cut} }`, /Plan\.board\.json is larger than/);
    await refusedPre("a total over the cap is refused in preflight", `caps: { total: 50000 }`, /more than/);
    await refusedPre("a manifest over its cap is refused in preflight (no growth hook)", `caps: { manifest: 1200 }`, /manifest/);
  });

  // ---- 11. the caps on the actual output, after preflight: no partial output, status unchanged
  await scenario("capsgrow", async () => {
    const grows = async (label, extra, re) => {
      await hooks(extra);
      const g = await exportOnce(join(out, "g.zip"));
      check(!!g.stopped && re.test(g.stopped) && !(await ev(`!!window.__exp`)) && (await scratchCount()) === 0 && (await lastAt()) === before, label + ", nothing handed over, no scratch left, status unchanged: " + (g.stopped ?? "not stopped").slice(-160));
    };
    const sz = await docSizes(), docCap = Math.max(...Object.values(sz)) + 1000;
    const before = await lastAt();
    await grows("a document grown past its cap after preflight stops the export", `caps: { doc: ${docCap} }, beforeCapture: async (p) => { if (p === "/Small.ipynb") { const r = await window.sagebrush.workspace.read(p); await window.sagebrush.workspace.write(p, { ...r.content, cells: [...r.content.cells, { id: "big", code: "x".repeat(${docCap}) }] }, { base: r.rev }); } }`, /larger than/);
    await grows("the total grown past its cap after preflight stops the export", `onPlan: (plan) => { window.__SB_EXPORT_TEST__.caps = { total: plan.bytes + 100 }; }, beforeCapture: async (p) => { if (p === "/data/primes.csv") await window.sagebrush.workspace.write(p, "y".repeat(5000)); }`, /passed .* GiB while it was written/);
    await grows("a manifest past a cap lowered after preflight (test-only) stops at its actual size", `onPlan: (plan) => { window.__SB_EXPORT_TEST__.caps = { manifest: 600 }; }`, /manifest/);
    await ev(`${W}.write("/data/primes.csv", "n,p\\n1,2\\n").then(() => 1)`);
  });

  // ---- 13. the spool: the Blob-part spool refused over its cap before writing; an OPFS scratch failure midway
  await scenario("spool", async () => {
    const before = await lastAt();
    await hooks("noOpfs: true, caps: { spoolBlob: 64 }");
    const s1 = await exportOnce(join(out, "s1.zip"));
    check(!!s1.stopped && s1.stopped.includes(NO_OPFS) && !(await ev(`!!window.__exp`)), "without OPFS, the spools over their in-memory cap are refused in preflight, before anything is written, in plain words: " + (s1.stopped ?? "not stopped").slice(-200));
    await hooks("failSpoolAfter: 1");
    const s2 = await exportOnce(join(out, "s2.zip"));
    check(!!s2.stopped && /scratch file couldn't be written/.test(s2.stopped) && !(await ev(`!!window.__exp`)) && (await scratchCount()) === 0 && (await lastAt()) === before, "an OPFS scratch write failing midway stops visibly, nothing handed over, scratch removed, status unchanged: " + (s2.stopped ?? "not stopped").slice(-160));
  });

  // ---- §6, daybreak2's E1-D2-1: near-cap documents are written in bounded pieces of work, and Cancel stops them within
  // 250 ms while they are being serialized (in preflight, and while written).  First the instrument's own check (C8).
  await scenario("nearcap", async () => {
    const watch = `(() => { window.__long = 0; window.__tasks = []; window.__hb = []; clearInterval(window.__hbt); window.__hbt = setInterval(() => window.__hb.push(performance.now()), 10); window.__lto?.disconnect(); (window.__lto = new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__long = Math.max(window.__long, e.duration); window.__tasks.push([e.startTime, e.duration]); } })).observe({ type: "longtask", buffered: false }); return 1; })()`;
    const readWatch = `(() => { clearInterval(window.__hbt); let g = 0; for (let i = 1; i < window.__hb.length; i++) g = Math.max(g, window.__hb[i] - window.__hb[i - 1]); return { long: Math.round(window.__long), heartbeat: Math.round(g) }; })()`;
    await ev(watch);
    await hooks("busyMs: 120");
    const c8 = await exportOnce(join(out, "c8.zip"));
    const w8 = await ev(readWatch);
    check(!c8.stopped && w8.long >= 100, "C8, the instrument: a 120 ms busy loop during an export shows in the long-task observer (" + w8.long + " ms) and the heartbeat (" + w8.heartbeat + " ms)");
    // (a notebook near the cap: a 24 MB stream output of short lines, a 30 MB image; a board carrying a 40 MB picture)
    await ev(`(async () => {
      const line = "0123456789abcdefghijklmnopqrstuvwxyz0123456789ABCDEF\\n", b64 = "iVBORw0KGgo" + "QUJD".repeat(7.5e6);
      await ${W}.create("/Near.ipynb", { content: { mode: "python", cells: [{ id: "s", code: "x", outputs: [{ output_type: "stream", name: "stdout", text: line.repeat(24e6 / line.length) }], n: 1 }, { id: "i", code: "y", outputs: [{ output_type: "display_data", metadata: {}, data: { "image/png": b64 } }], n: 2 }] } });
      const r = await ${W}.read("/Plan.board.json");
      await ${W}.create("/Near.board.json", { content: { ...r.content, images: { big01: { w: 4000, h: 3000, src: "data:image/png;base64," + "QUJD".repeat(1e7) } }, nodes: [{ id: "bn", title: "big", image: "big01" }] } });
      return 1;
    })()`);
    // (evidence, information only: the longest task while the workspace merely reads each near-cap record, as the
    // export's capture does: IndexedDB hands back one value, deserialized in one piece of work)
    for (const p of ["/Near.ipynb", "/Near.board.json"]) {
      await ev(watch);
      await ev(`${W}.read(${JSON.stringify(p)}).then(() => 1)`);
      await sleep(300);
      console.log("(evidence: a plain read of " + p + ": " + JSON.stringify(await ev(readWatch)) + ")");
    }
    await ev(watch);
    await hooks(`probe: (what, edge) => { (window.__probe ??= []).push([what, edge, performance.now()]); }`);
    await ev(`(() => { window.__probe = []; return 1; })()`);
    const nc = await exportOnce(join(out, "nc.zip"));
    const wn = await ev(readWatch);
    // (each long task over 50 ms: inside a record's read (a capture, the workspace's IndexedDB read of one value), or
    // not; none may be outside one)
    const att = await ev(`(() => { const iv = [], open = {}; for (const [w, e, t] of window.__probe) { if (w !== "capture") continue; if (e === 0) open.c = t; else if (open.c !== undefined) { iv.push([open.c, t]); delete open.c; } } const out = [], inside = []; for (const [s, d] of window.__tasks) { if (d <= 50) continue; (iv.some(([a, b]) => s >= a - 1 && s + d <= b + 1) ? inside : out).push(Math.round(d)); } return { inside, outside: out }; })()`);
    console.log("(long tasks over 50 ms during the near-cap export: inside a record read " + JSON.stringify(att.inside) + ", elsewhere " + JSON.stringify(att.outside) + ")");
    check(!nc.stopped, "near-cap documents export: " + (nc.stopped ?? nc.name));
    if (!nc.stopped) { const z = inspect(join(out, "nc.zip")); check(!z.error && z.bad === null && z.mismatch.length === 0, "…valid, every hash right"); }
    check(att.outside.length === 0, "…with no main-thread task over 50 ms of the export's own: every one is a near-cap record's read from IndexedDB (" + JSON.stringify(att.inside) + " ms; the longest task " + wn.long + " ms, heartbeat " + wn.heartbeat + " ms)");
    check(att.inside.every((d) => d <= 200), "…and each record's read at most 200 ms (D-3, daybreak2's exception): " + JSON.stringify(att.inside));
    const cancelIn = async (label, hook) => {
      await hooks(`${hook}: (p) => { if (!/^\\/Near\\./.test(p) || window.__clickAt) return; setTimeout(() => { const b = [...document.querySelectorAll(".sbfprev button")].find((x) => x.textContent === "Cancel"); window.__clickAt = performance.now(); b?.click(); }, 150); }`);
      await ev(`(() => { window.__clickAt = 0; window.__cancelledAt = 0; new MutationObserver(() => { if (!window.__cancelledAt && /The export was cancelled/.test(document.querySelector(".sbfprev")?.textContent ?? "")) window.__cancelledAt = performance.now(); }).observe(document.body, { subtree: true, childList: true, characterData: true }); return 1; })()`);
      const r = await exportOnce(join(out, "ncx.zip"));
      const took = await ev(`window.__cancelledAt && window.__clickAt ? window.__cancelledAt - window.__clickAt : -1`);
      check(!!r.stopped && took >= 0 && took <= 250, "Cancel " + label + " stops within 250 ms, timed in the page: " + Math.round(took) + " ms");
    };
    await cancelIn("while preflight serializes a near-cap document", "preflightMember");
    await cancelIn("while a near-cap document is serialized and hashed into the archive", "onMember");
    await ev(`Promise.all([${W}.remove("/Near.ipynb"), ${W}.remove("/Near.board.json")]).then(() => 1)`);
  });

  // ---- daybreak2's and astra's r2 finding: near-cap documents WITHOUT pictures (a board of many notes, long text, a long
  // stroke, an extension value; a notebook of many cells and a text in many pieces) are written in bounded work too:
  // no task of the export's own over 50 ms, each record's read at most 200 ms, Cancel within 250 ms in preflight and
  // while written; and their members are byte for byte Download's (a separate run: the reference is computed there)
  await scenario("nearcap2", async () => {
    await ev(`(async () => {
      const t = "x".repeat(900) + "\\n";
      const nodes = [];
      for (let i = 0; i < 30000; i++) nodes.push({ id: "n" + i, title: "Note " + i, text: t, x: i % 200 * 10, y: Math.floor(i / 200) * 10 });
      nodes.push({ id: "big", title: "long", text: "y".repeat(5e6) });
      const pts = new Array(1.5e6); for (let i = 0; i < pts.length; i++) pts[i] = (i * 7) % 1000;
      nodes.push({ id: "ink", kind: "ink", points: pts, x: 0, y: 0 });
      await ${W}.create("/Wide.board.json", { content: { format: "sagebrush-board", version: 1, title: "Wide", nodes, extension: { blob: "z".repeat(2e6) } } });
      const cells = [];
      for (let i = 0; i < 50000; i++) cells.push({ id: "c" + i, code: "print(" + i + ")", outputs: [{ output_type: "stream", name: "stdout", text: "line " + i + "\\n" }], n: i });
      const parts = new Array(400000); for (let i = 0; i < parts.length; i++) parts[i] = "p" + i + (i % 7 ? "" : "\\n");
      cells.push({ id: "many", code: "x", outputs: [{ output_type: "stream", name: "stdout", text: parts }], n: 1 });
      await ${W}.create("/Many.ipynb", { content: { mode: "python", cells } });
      return 1;
    })()`);
    const watch = `(() => { window.__long = 0; window.__tasks = []; window.__lto?.disconnect(); (window.__lto = new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__long = Math.max(window.__long, e.duration); window.__tasks.push([e.startTime, e.duration]); } })).observe({ type: "longtask", buffered: false }); return 1; })()`;
    for (const p of ["/Wide.board.json", "/Many.ipynb"]) {
      await ev(watch);
      await ev(`${W}.read(${JSON.stringify(p)}).then(() => 1)`);
      await sleep(300);
      console.log("(evidence: a plain read of " + p + ": the longest task " + Math.round(await ev(`window.__long`)) + " ms)");
    }
    await ev(watch);
    await hooks(`probe: (what, edge) => { (window.__probe ??= []).push([what, edge, performance.now()]); }`);
    await ev(`(() => { window.__probe = []; return 1; })()`);
    const r = await exportOnce(join(out, "nc2.zip"));
    check(!r.stopped, "near-cap documents without pictures export: " + (r.stopped ?? r.name));
    if (!r.stopped) { const z = inspect(join(out, "nc2.zip")); check(!z.error && z.bad === null && z.mismatch.length === 0, "…valid, every hash right"); }
    const att = await ev(`(() => { const iv = [], open = {}; for (const [w, e, t] of window.__probe) { if (w !== "capture") continue; if (e === 0) open.c = t; else if (open.c !== undefined) { iv.push([open.c, t]); delete open.c; } } const out = [], inside = []; for (const [s, d] of window.__tasks) { if (d <= 50) continue; (iv.some(([a, b]) => s >= a - 1 && s + d <= b + 1) ? inside : out).push(Math.round(d)); } return { inside, outside: out }; })()`);
    console.log("(long tasks over 50 ms during the export: inside a record read " + JSON.stringify(att.inside) + ", elsewhere " + JSON.stringify(att.outside) + ")");
    check(att.outside.length === 0, "…no main-thread task over 50 ms of the export's own (the clone, cleanDoc, the board's text, the cells, the lines): " + JSON.stringify(att.outside));
    check(att.inside.every((d) => d <= 200), "…each record's read at most 200 ms: " + JSON.stringify(att.inside));
    const cancelIn = async (label, hook) => {
      await hooks(`${hook}: (p) => { if (!/^\\/(Wide|Many)\\./.test(p) || window.__clickAt) return; setTimeout(() => { const b = [...document.querySelectorAll(".sbfprev button")].find((x) => x.textContent === "Cancel"); window.__clickAt = performance.now(); b?.click(); }, 150); }`);
      await ev(`(() => { window.__clickAt = 0; window.__cancelledAt = 0; new MutationObserver(() => { if (!window.__cancelledAt && /The export was cancelled/.test(document.querySelector(".sbfprev")?.textContent ?? "")) window.__cancelledAt = performance.now(); }).observe(document.body, { subtree: true, childList: true, characterData: true }); return 1; })()`);
      const before = await lastAt();
      const x = await exportOnce(join(out, "nc2x.zip"));
      const took = await ev(`window.__cancelledAt && window.__clickAt ? window.__cancelledAt - window.__clickAt : -1`);
      check(!!x.stopped && took >= 0 && took <= 250 && !(await ev(`!!window.__exp`)) && (await lastAt()) === before, "Cancel " + label + " stops within 250 ms, timed in the page, nothing handed over, status unchanged: " + Math.round(took) + " ms");
    };
    await cancelIn("while preflight streams a near-cap document without pictures", "preflightMember");
    await cancelIn("while one is written", "onMember");
    // (byte equality: each member's sha256 against the page's own Download text of the captured record, in a run
    // apart from the timing checks)
    await hooks("reference: true");
    const e = await exportOnce(join(out, "nc2r.zip"));
    if (!e.stopped) {
      const z = inspect(join(out, "nc2r.zip"));
      const refs = e.stats?.refs ?? {};
      for (const p of ["/Wide.board.json", "/Many.ipynb", "/Algebra.ipynb", "/Plan.board.json"]) {
        const m = z.entries.find((x) => x.path === p);
        check(!!m && refs[p] === m.sha256, "the streamed " + p + " is byte for byte the page's Download text (sha256 " + (m?.sha256 ?? "-").slice(0, 12) + " / " + (refs[p] ?? "-").slice(0, 12) + ")");
      }
    } else check(false, "the reference export stopped: " + e.stopped);
    await ev(`Promise.all([${W}.remove("/Wide.board.json"), ${W}.remove("/Many.ipynb")]).then(() => 1)`);
  });

  // ---- E1 r2a (daybreak2's and grader's buffering controls): the capture log's lines go into its spool's 1 MiB slice
  // and are written out a slice at a time; the tree check's lookup settles the slice first.  Accepted writes whose file
  // and folder lines are still in the unflushed tail, below the first flush and after one; the log as the lookup reads
  // it, byte for byte the unbuffered reference (the order across slice boundaries); Cancel and a structural stop before
  // and after the first flush: the sink aborted, the status unchanged, the scratch removed.
  await scenario("tail", async () => {
    const SLICE = 1 << 20;
    // (the log an unbuffered writer makes, from the raw rows, in their key (path) order: its bytes, and how many bytes
    // its first n lines take, and how many its lines from `from` on take)
    const REF = `(async () => { const rows = await new Promise((ok, no) => { const q = indexedDB.open("sagebrush-workspace"); q.onsuccess = () => { const d = q.result, g = d.transaction("entries").objectStore("entries").getAll(); g.onsuccess = () => { d.close(); ok(g.result); }; g.onerror = () => no(g.error); }; }); const lines = rows.filter((e) => e.path !== "/" && e.path !== "/Trash" && !e.path.startsWith("/Trash/")).map((e) => [e.path, JSON.stringify([e.path, e.kind, e.ident ?? null]) + "\\n"]); const enc = new TextEncoder(); const len = lines.map(([, l]) => enc.encode(l).length); window.__ref = { lines, len }; return lines.length; })()`;
    const HEX = `(async (parts) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", await new Blob(parts).arrayBuffer()))].map((b) => b.toString(16).padStart(2, "0")).join(""))`;
    const firstBytes = (n) => ev(`window.__ref.len.slice(0, ${n}).reduce((a, b) => a + b, 0)`);
    const fromBytes = (path) => ev(`window.__ref.lines.reduce((a, [p], i) => a + (p >= ${JSON.stringify(path)} ? window.__ref.len[i] : 0), 0)`);
    const sameAsRef = () => ev(`Promise.all([${HEX}(window.__cap ?? []), ${HEX}(window.__ref.lines.map(([, l]) => l))]).then(([a, b]) => a === b)`);
    const LOOK = `onLookup: (x) => { window.__lookupAt = x; }, captureChunk: (ch) => { (window.__cap ??= []).push(ch.slice()); }`;
    const accepted = (path, body) => `afterCapture: async (p) => { if (p === ${JSON.stringify(path)}) await window.sagebrush.workspace.write(p, ${JSON.stringify(body)}); }`;
    const reset = () => ev(`(() => { window.__lookupAt = null; window.__cap = null; window.__clickAt = 0; return 1; })()`);
    const stopsClean = async (label, r, re, before) => {
      await closeFlow();
      const clean = await until(`${LOCKS}.then((m) => m === 0)`, 20000);
      const n = await scratchCount();
      check(!!r.stopped && re.test(r.stopped) && !(await ev(`!!window.__exp`)) && (await lastAt()) === before && clean && n === 0, label + ": stopped, saying so; nothing handed over (the sink aborted), the status unchanged, no lock and no scratch left: " + String(r.stopped ?? r.name).slice(-140));
    };
    // (t0) the small workspace: an accepted write; the lookup runs before any flush, so the needed lines are buffered
    await ev(`${W}.create("/tail-victim.txt", { content: "v" }).then(() => 1)`);
    await reset();
    await hooks(`${LOOK}, ${accepted("/data/primes.csv", "n,p\n1,2\n2,3\n")}`);
    await ev(REF);
    const r0 = await exportOnce(join(out, "t0.zip"));
    const at0 = await ev(`window.__lookupAt`);
    check(!r0.stopped && !!at0 && at0.chunks === 0 && at0.buffered > 0, "tail t0: an accepted write whose file and folder lines are in the unflushed tail, below the first flush (the lookup saw " + JSON.stringify(at0) + "): the export completes: " + String(r0.stopped ?? r0.name).slice(-100));
    await ev(`${W}.write("/data/primes.csv", "n,p\\n1,2\\n").then(() => 1)`);
    // (e0) a structural stop below the first flush
    let before = await lastAt();
    await reset();
    await hooks(`${LOOK}, afterCapture: async (p) => { if (p === "/data/primes.csv") await window.sagebrush.workspace.remove("/tail-victim.txt"); }`);
    await ev(REF);
    const below = await firstBytes(await ev(`window.__ref.lines.length`));
    const e0 = await exportOnce(join(out, "e0.zip"));
    check(below < SLICE, `tail e0: the whole log is below the first flush (${below} bytes)`);
    await stopsClean("tail e0: a delete during the export, below the first flush", e0, /tail-victim\.txt/, before);
    // (the large workspace: about 2,800 folders with long names, sorted before /zzz, then /zzz/late.csv)
    const BULK = 2800;
    await idb("sagebrush-workspace", "entries", `(s) => { const t = Date.now(), pad = "y".repeat(440); s.put({ path: "/bulk", kind: "folder", ref: null, created: t, updated: t, fid: "bulkfid", ident: "bulkfid", nkey: "/\\u0000bulk" }); for (let i = 0; i < ${BULK}; i++) { const name = pad + String(i).padStart(6, "0"), path = "/bulk/" + name, f = "bulkfid-" + i; s.put({ path, kind: "folder", ref: null, created: t, updated: t, fid: f, ident: f, nkey: "/bulk\\u0000" + name }); } return null; }`);
    await ev(`${W}.mkdir("/zzz").then(() => ${W}.create("/zzz/late.csv", { content: "a\\n" })).then(() => ${W}.create("/tail-victim.txt", { content: "v" })).then(() => 1)`);
    // (t1) an accepted write on /zzz/late.csv: the lookup runs after at least one flushed slice, with /zzz's and
    // /zzz/late.csv's lines still buffered; the log as read is byte for byte the reference
    await reset();
    await hooks(`${LOOK}, ${accepted("/zzz/late.csv", "b\n")}`);
    await ev(REF);
    const tailBytes = await fromBytes("/zzz");
    const r1 = await exportOnce(join(out, "t1.zip"));
    const at1 = await ev(`window.__lookupAt`);
    check(!r1.stopped && !!at1 && at1.chunks >= 1 && at1.buffered >= tailBytes, `tail t1: an accepted write whose file and folder lines are in the unflushed tail after ${at1?.chunks} flushed slice(s) (${at1?.buffered} bytes buffered, the needed lines ${tailBytes}): the export completes: ` + String(r1.stopped ?? r1.name).slice(-100));
    check(await sameAsRef(), "tail t1: the capture log as the lookup read it, across its slice boundary, is byte for byte the unbuffered reference");
    // (s0, s1) Cancel below and past the first flush
    for (const [label, k, below] of [["s0", 5, true], ["s1", BULK - 100, false]]) {
      before = await lastAt();
      await reset();
      await hooks(`${LOOK}, between: (n) => { if (n !== ${k} || window.__clickAt) return; window.__clickAt = performance.now(); [...document.querySelectorAll(".sbfprev button")].find((x) => x.textContent === "Cancel")?.click(); }`);
      await ev(REF);
      const bytes = await firstBytes(k);
      const r = await exportOnce(join(out, label + ".zip"));
      check(below ? bytes < SLICE : bytes > SLICE, `tail ${label}: Cancel after ${k} members, with ${bytes} bytes of log (${below ? "below" : "past"} the first flush)`);
      await stopsClean(`tail ${label}: Cancel ${below ? "below" : "past"} the first flush`, r, /cancelled/, before);
    }
    // (e1) a structural stop past the first flush
    before = await lastAt();
    await reset();
    await hooks(`${LOOK}, afterCapture: async (p) => { if (p === "/zzz/late.csv") await window.sagebrush.workspace.remove("/tail-victim.txt"); }`);
    const e1 = await exportOnce(join(out, "e1.zip"));
    await stopsClean("tail e1: a delete during the export, past the first flush", e1, /tail-victim\.txt/, before);
    // (the large workspace taken away again)
    await idb("sagebrush-workspace", "entries", `(s) => s.delete(IDBKeyRange.bound("/bulk", "/bulk/\\uffff"))`);
    await ev(`${W}.remove("/zzz/late.csv").then(() => ${W}.remove("/zzz")).then(() => 1, () => 0)`);
  });

  check(errors.length === 0, "no page errors: " + errors.slice(0, 3).join(" | "));
} catch (e) {
  fails.push("threw: " + (e?.stack ?? e));
} finally {
  ws.close();
  chrome.kill();
  await sleep(1000);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  rmSync(out, { recursive: true, force: true });
}
// (a control's worker in place of the built one: it must have been served, or the control shows nothing)
if (chunkWorker) check(servedWorker > 0, "the control's worker was served in place of the built one: " + servedWorker + " times");
console.log(`${checks - fails.length}/${checks} passed`);
for (const f of fails) console.log("FAIL " + f);
process.exit(fails.length ? 1 : 0);
