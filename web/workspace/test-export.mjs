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
import { join } from "node:path";
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
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
  if (m.method === "Page.javascriptDialogOpening") send("Page.handleJavaScriptDialog", { accept: true });
  if (m.method === "Runtime.consoleAPICalled") consoleLines.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200));
  // (a control's chunk, in place of the built one)
  if (m.method === "Fetch.requestPaused") {
    const isWorker = /sagebrush-export-worker\.js/.test(m.params.request.url), body = isWorker ? chunkWorker : chunk;
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
    // (the earliest failure: the spool refused before anything is written, the picker's file already open)
    await ev(`(() => { window.__picked = null; window.__SB_EXPORT_TEST__ = { noOpfs: true, caps: { spoolBlob: 64 } }; return 1; })()`);
    const pk3 = await exportOnce(join(out, "pk3.zip"), { picked: true });
    check(!!pk3.stopped && /index/.test(pk3.stopped) && (await ev(`window.__picked === null && window.__aborted === 3`)), "a failure before anything is written still aborts the picker's file (astra's E1-A3): " + (pk3.stopped ?? "not stopped").slice(-120));
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
    check(!!s1.stopped && /can't hold the export's index/.test(s1.stopped) && !(await ev(`!!window.__exp`)), "without OPFS, a spool over its cap is refused before anything is written: " + (s1.stopped ?? "not stopped").slice(-160));
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
