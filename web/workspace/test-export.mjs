// "Export all current files (.zip)" (export plan E1 r2c, web/workspace/export) in headless Chromium against the
// built site: the Storage panel's button and status line; the archive checked outside the browser by Python's
// zipfile and by unzip -t (every member's bytes, the manifest's sizes and SHA-256, the manifest the last member and
// its central record the last one, folders as directory members); the documents' bytes equal to what Download
// writes; saves before and after a member's capture; a structural change during the export; files that aren't on
// this device; the caps on growth after preflight; cancel; the spool without OPFS.
// Serve web/dist first (python3 web/serve.py 8765), then
//   node web/workspace/test-export.mjs
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
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
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
  if (m.method === "Page.javascriptDialogOpening") send("Page.handleJavaScriptDialog", { accept: true });
  if (m.method === "Runtime.consoleAPICalled") consoleLines.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
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

/** The last export prepared (the workspace's meta "export:last"), read from IndexedDB itself. */
const LAST = `new Promise((ok, no) => { const r = indexedDB.open("sagebrush-workspace"); r.onsuccess = () => { const db = r.result, q = db.transaction("meta").objectStore("meta").get("export:last"); q.onsuccess = () => { db.close(); ok(q.result ?? null); }; q.onerror = () => no(q.error); }; r.onerror = () => no(r.error); })`;
const openFiles = async () => {
  await until(`!!document.querySelector("#wsfilesbtn") && !document.querySelector("#wsfilesbtn").hidden`, 60000);
  if (await ev(`${S}.hidden`)) await ev(`(() => { document.querySelector("#wsfilesbtn").click(); return 1; })()`);
  await until(`!${S}.hidden`);
  await until(`!!document.querySelector("#wssidebar .fmeter")`, 60000);
};
/** The test hooks for this page (run.ts's TestHooks), with the handed-over archive kept in window.__exp. */
const hooks = (extra = "") => ev(`(() => { window.__exp = null; window.__SB_EXPORT_TEST__ = { noPicker: true, onHand: (blob, name) => { window.__exp = { blob, name }; }, stats: {}, ${extra} }; return 1; })()`);
/** Open the Storage panel and run one export to its end; the archive's bytes saved to `file`, its summary returned. */
async function exportOnce(file, { expectStop = false, partial = false, refuseAtReady = false, picked = false } = {}) {
  if (!(await ev(`!!${P}`))) await ev(`(() => { document.querySelector("#wssidebar .fmeter").click(); return 1; })()`);
  // (an earlier run's archive forgotten, so this run's end can't be taken from it)
  await ev(`(() => { window.__exp = null; window.__picked = null; return 1; })()`);
  // (an earlier run's ended flow closed first, so its buttons can't be taken for this run's)
  await ev(`(() => { [...(${P}?.querySelectorAll("button") ?? [])].filter((b) => b.textContent === "Close").forEach((b) => b.click()); return 1; })()`);
  await until(`!!${P} && [...${P}.querySelectorAll("button")].some((b) => /^Export all current files/.test(b.textContent))`);
  await panelButton(/^Export all current files/);
  const readyOrStop = await until(`[...(${P}?.querySelectorAll("button") ?? [])].some((b) => /^(Save…|Export the rest|Export again)$/.test(b.textContent))`, 120000);
  if (!readyOrStop) {
    // (diagnosis: the Web Locks held and waited for, and the page's last console lines; the flow then cancelled)
    const locks = await ev(`navigator.locks.query().then((q) => JSON.stringify({ held: q.held.map((l) => l.name), pending: q.pending.map((l) => l.name) }))`).catch((e) => String(e));
    const t = (await panelText()).slice(-300);
    await ev(`(() => { [...(${P}?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Cancel")?.click(); return 1; })()`);
    await until(`[...(${P}?.querySelectorAll("button") ?? [])].some((b) => b.textContent === "Close")`, 10000);
    await ev(`(() => { [...(${P}?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Close")?.click(); return 1; })()`);
    return { stopped: "no ready state: " + t + " | locks " + locks + " | console " + consoleLines.slice(-8).join(" / ") };
  }
  if (await ev(`[...${P}.querySelectorAll("button")].some((b) => b.textContent === "Export again")`)) {
    const t = (await panelText()).slice(-400);
    await ev(`(() => { [...(${P}?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Close")?.click(); return 1; })()`);
    return { stopped: t };
  }
  if (refuseAtReady) {
    const readyText = await panelText();
    await panelButton(/^Cancel$/);
    return { readyText };
  }
  if (partial) await panelButton(/^Export the rest$/);
  else await panelButton(/^Save…$/);
  const ended = await until(`!!window.__exp || ${picked ? "!!window.__picked || " : ""}[...(${P}?.querySelectorAll("button") ?? [])].some((b) => b.textContent === "Export again")`, 300000);
  const text = await panelText();
  if (picked) {
    if (await ev(`!!window.__picked`)) { await ev(`(() => { window.__exp = { blob: window.__picked, name: "picked.zip" }; return 1; })()`); }
    else { await ev(`(() => { [...(${P}?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Close")?.click(); return 1; })()`); return { stopped: text.slice(-400) }; }
  }
  if (!ended || !(await ev(`!!window.__exp`))) { await ev(`(() => { [...(${P}?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Close")?.click(); return 1; })()`); return { stopped: text.slice(-400) }; }
  const b64 = await ev(`(async () => { const b = new Uint8Array(await window.__exp.blob.arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); })()`);
  writeFileSync(file, Buffer.from(b64, "base64"));
  await until(`/^Exported /.test([...(${P}?.querySelectorAll("p") ?? [])].map((p) => p.textContent).join("\\n"))`);
  const summary = await panelText();
  await ev(`(() => { [...(${P}?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Close")?.click(); return 1; })()`);
  return { name: await ev(`window.__exp.name`), summary, stats: await ev(`window.__SB_EXPORT_TEST__.stats`), expectStop };
}

/** The archive, checked outside the browser: Python's zipfile and unzip -t. */
function inspect(file) {
  const py = String.raw`
import json, sys, zipfile, hashlib, struct
f = sys.argv[1]
z = zipfile.ZipFile(f)
bad = z.testzip()
infos = z.infolist()
names = [i.filename for i in infos]
m = json.loads(z.read("manifest.json"))
data = open(f, "rb").read()
# the last local header's name, and the central directory's last record's
locs = []
at = 0
while True:
    at = data.find(b"PK\x03\x04", at)
    if at < 0: break
    nl, xl = struct.unpack("<HH", data[at+26:at+30])
    locs.append(data[at+30:at+30+nl].decode("utf-8", "replace"))
    at += 30
entries = {e["path"]: e for e in m["entries"]}
mismatch = []
for e in m["entries"]:
    n = "files/" + e["path"][1:] + ("/" if e["kind"] == "folder" else "")
    if n not in names: mismatch.append("missing member " + n); continue
    if e["kind"] == "folder":
        if "sha256" in e or "size" in e: mismatch.append("a folder with a hash or size " + n)
        continue
    b = z.read(n)
    if hashlib.sha256(b).hexdigest() != e["sha256"] or len(b) != e["size"]: mismatch.append("hash/size " + n)
print(json.dumps({"bad": bad, "names": names, "last_local": locs[-1] if locs else None, "last_central": names[-1], "count": len(names),
  "manifest": {k: m[k] for k in m if k != "entries"}, "entries": m["entries"], "mismatch": mismatch,
  "methods": {i.filename: i.compress_type for i in infos}}))
`;
  const r = spawnSync("python3", ["-I", "-c", py, file], { encoding: "utf8" });
  if (r.status !== 0) return { error: r.stderr.slice(0, 600) };
  const u = spawnSync("unzip", ["-tq", file], { encoding: "utf8" });
  return { ...JSON.parse(r.stdout), unzip: u.status, unzipOut: (u.stdout + u.stderr).slice(0, 300) };
}

const nb = (marker) => JSON.stringify({ cells: [{ id: "a1", code: `print(${JSON.stringify(marker)})`, outputs: [{ output_type: "stream", name: "stdout", text: marker + "\n" }], n: "1" }, { id: "a2", type: "markdown", code: "# Ünïcode **bold**" }], mode: "python" });

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await go(base);
  await until(`!!${W}`, 60000);
  // the workspace: a notebook, a board, text and binary data files, an unknown extension, nested empty folders,
  // non-ASCII names
  await ev(`(async () => {
    const w = ${W};
    await w.create("/Algebra.ipynb", { content: ${nb("first")} });
    await w.create("/Plan.board.json");
    await w.create("/data/primes.csv", { content: "n,p\\n1,2\\n2,3\\n3,5\\n".repeat(200) });
    await w.create("/data/pic.png", { content: new Uint8Array(4096).map((_, i) => (i * 7919) & 255) });
    await w.create("/data/blob.xyz", { content: new Uint8Array(100000).fill(65) });
    await w.mkdir("/empty/inner");
    await w.create("/Ünïcode/naïve résumé.txt", { content: "accents" });
    return 1;
  })()`);
  await go(base);
  await openFiles();

  // ---- 0. the panel: the button, its line, the status before any export
  await ev(`(() => { document.querySelector("#wssidebar .fmeter").click(); return 1; })()`);
  check(await until(`/Export all current files \\(\\.zip\\)/.test(${P}?.textContent ?? "")`), "the Storage panel offers Export all current files (.zip)");
  check(/TimeTravel, old file versions, Trash, and this device's settings are not included/.test(await panelText()), "…with what isn't included, in one line");
  check(/No export prepared on this device yet/.test(await panelText()), "…and no export prepared yet");
  check(!(await ev(`[...performance.getEntriesByType("resource")].some((r) => /sagebrush-export/.test(r.name))`)), "the export's chunk isn't loaded before the click");

  // ---- 1-3. an export through OPFS (the sink headless Chromium has): the archive, outside the browser
  await hooks();
  const a = await exportOnce(join(out, "a.zip"));
  check(!a.stopped, "an export ends with an archive: " + (a.stopped ?? a.name));
  if (!a.stopped) {
    const z = inspect(join(out, "a.zip"));
    check(!z.error && z.bad === null, "Python's zipfile reads every member, CRCs right: " + (z.error ?? z.bad));
    check(z.unzip === 0, "unzip -t accepts it: " + z.unzipOut);
    check(/^sagebrush-\d{4}-\d\d-\d\d\.zip$/.test(a.name), "named sagebrush-YYYY-MM-DD.zip: " + a.name);
    check(z.mismatch?.length === 0, "every manifest entry's member is there, with its size and SHA-256: " + JSON.stringify(z.mismatch));
    check(z.last_local === "manifest.json" && z.last_central === "manifest.json", "manifest.json is the last local member and its central record the last one: " + z.last_local + " / " + z.last_central);
    check(z.names.includes("files/empty/inner/") && z.names.includes("files/empty/") && z.entries.some((e) => e.path === "/empty/inner" && e.kind === "folder"), "empty folders are directory members, and folder entries in the manifest");
    check(z.names.includes("files/Ünïcode/naïve résumé.txt"), "a non-ASCII name keeps its exact characters");
    check(z.methods["files/data/pic.png"] === 0 && z.methods["files/data/primes.csv"] === 8 && z.methods["files/Algebra.ipynb"] === 8, "png STOREd, csv and ipynb DEFLATEd: " + JSON.stringify(z.methods));
    check(z.manifest.format === "sagebrush-workspace-bundle" && z.manifest.version === 1 && z.manifest.mode === "files" && z.manifest.omitted.length === 0, "the manifest's head: " + JSON.stringify(z.manifest).slice(0, 200));
    check(z.entries.every((e) => typeof e.captured === "number"), "every entry records when it was captured");
    check(/Each file is in the export as it was saved when it was read/.test(a.summary), "the summary says what the export holds, and nothing more");
    check(/Last export prepared on this device: just now/.test(await panelText()), "the status line, after the export: " + (await panelText()).match(/Last export[^.]*|No export[^.]*/)?.[0]);
  }

  // ---- the spool without OPFS (Blob parts) and the Blob sink
  await hooks("noOpfs: true");
  const b = await exportOnce(join(out, "b.zip"));
  check(!b.stopped, "without OPFS: an archive through Blob parts and the Blob sink: " + (b.stopped ?? b.name));
  if (!b.stopped) { const z = inspect(join(out, "b.zip")); check(!z.error && z.bad === null && z.mismatch.length === 0, "…valid, every hash right"); }

  // ---- 4. saves before and after a member's capture
  await hooks(`beforeCapture: async (p) => { if (p === "/data/primes.csv") await window.sagebrush.workspace.write(p, "before\\n"); }, afterCapture: async (p) => { if (p === "/data/primes.csv") await window.sagebrush.workspace.write("/data/pic.png", new Uint8Array([9, 9, 9])); if (p === "/data/pic.png") await window.sagebrush.workspace.write(p, new Uint8Array([1, 2])); }`);
  const c = await exportOnce(join(out, "c.zip"));
  check(!c.stopped, "content saves during an export don't stop it: " + (c.stopped ?? c.name));
  if (!c.stopped) {
    const z = inspect(join(out, "c.zip"));
    const csv = z.entries.find((e) => e.path === "/data/primes.csv"), png = z.entries.find((e) => e.path === "/data/pic.png");
    check(csv?.size === 7, "a save before a member's capture is in the archive (its manifest size " + csv?.size + ")");
    // (pic.png comes before primes.csv in path order: both its writes land after its capture)
    check(png?.size === 4096 && z.mismatch.length === 0, "a save after a member's capture is not (pic.png has the bytes it had when read: size " + png?.size + ", and they match its manifest)");
  }

  // ---- 12, 13: the order of times; the spool's chunks (not one object per record)
  if (!c.stopped) {
    const z = inspect(join(out, "c.zip"));
    const last = await ev(LAST);
    check(Date.parse(z.manifest.created) <= last.at, "manifest.created is taken before the file is closed, \"Last export prepared\" after: " + z.manifest.created + " / " + new Date(last.at).toISOString());
    check(typeof c.stats?.spoolChunks === "number" && c.stats.spoolChunks <= 4, "the spool holds a few 1 MiB chunks, not one object per record: " + c.stats?.spoolChunks);
  }

  // ---- 1. the documents' bytes are Download's: the editor's Download right after a save, the same bytes
  {
    const nbRef = await ev(`${W}.stat("/Algebra.ipynb").then((e) => e.ref)`), bdRef = await ev(`${W}.stat("/Plan.board.json").then((e) => e.ref)`);
    const grab = `(() => { window.__dl = []; const o = URL.createObjectURL; URL.createObjectURL = (b) => { window.__dl.push(b); return o.call(URL, b); }; return 1; })()`;
    const dlText = () => ev(`window.__dl[window.__dl.length - 1].text()`);
    await go(base + "?nb=" + encodeURIComponent(nbRef));
    await until(`!!${W} && !!document.querySelector("#cells textarea")`, 60000);
    await sleep(2500);
    await ev(grab);
    await ev(`(() => { const b = [...document.querySelectorAll("#filemenu button")].find((x) => x.textContent.startsWith(".ipynb")); if (!b) throw new Error("no .ipynb item"); b.click(); return 1; })()`);
    check(await until(`window.__dl.length > 0`), "the notebook page's Download .ipynb runs");
    const dNb = await dlText();
    await go(base + "board/?doc=local:" + encodeURIComponent(bdRef));
    check(await until(`!!window.sagebrush?.board?.snapshot() && !!document.querySelector('[data-sbb="download"]')`, 60000), "the board page opens the board");
    await sleep(2500);
    await ev(grab);
    await ev(`(() => { document.querySelector('[data-sbb="download"]').click(); return 1; })()`);
    check(await until(`window.__dl.length > 0`), "the board's Download JSON runs");
    const dBd = await dlText();
    await go(base);
    await openFiles();
    await hooks();
    const e = await exportOnce(join(out, "e.zip"));
    check(!e.stopped, "an export after the editors' saves: " + (e.stopped ?? e.name));
    if (!e.stopped) {
      writeFileSync(join(out, "nb.dl"), dNb);
      writeFileSync(join(out, "bd.dl"), dBd);
      const same = (member, file) => spawnSync("python3", ["-I", "-c", "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); print(z.read(sys.argv[2]) == open(sys.argv[3], 'rb').read())", join(out, "e.zip"), member, file], { encoding: "utf8" }).stdout.trim();
      check(same("files/Algebra.ipynb", join(out, "nb.dl")) === "True", "the notebook's member is byte for byte what Download .ipynb wrote");
      check(same("files/Plan.board.json", join(out, "bd.dl")) === "True", "the board's member is byte for byte what Download JSON wrote");
    }
  }

  // ---- 5. files not on this device: listed, refused; "Export the rest" makes a -partial archive
  await ev(`new Promise((ok, no) => { const r = indexedDB.open("sagebrush-workspace"); r.onsuccess = () => { const db = r.result, tx = db.transaction("entries", "readwrite"); const t = Date.now(); tx.objectStore("entries").put({ path: "/cloud.csv", kind: "file", ref: "/cloud.csv", size: 10, created: t, updated: t, fid: "cloudfid", ident: "cloudfid", sha256: "0".repeat(64), remote: true, fetch: "0".repeat(64) }); tx.oncomplete = () => { db.close(); ok(1); }; tx.onerror = () => no(tx.error); }; r.onerror = () => no(r.error); })`);
  await hooks();
  const f0 = await exportOnce(join(out, "f0.zip"), { refuseAtReady: true });
  check(/cloud\.csv \(in the cloud only\)/.test(f0.readyText ?? "") && /isn't on this device/.test(f0.readyText ?? ""), "a file that's in the cloud only is listed, and the export doesn't start by itself: " + (f0.readyText ?? JSON.stringify(f0)).slice(-200));
  await hooks();
  const f1 = await exportOnce(join(out, "f1.zip"), { partial: true });
  check(!f1.stopped && /-partial\.zip$/.test(f1.name ?? ""), "Export the rest: a partial archive, named so: " + (f1.stopped ?? f1.name));
  if (!f1.stopped) {
    const z = inspect(join(out, "f1.zip"));
    check(z.manifest.omitted?.length === 1 && z.manifest.omitted[0].path === "/cloud.csv" && z.manifest.omitted[0].why === "remote" && !z.names.includes("files/cloud.csv"), "…its manifest lists the omitted file and why, and the archive hasn't it: " + JSON.stringify(z.manifest.omitted));
    check(/1 files were not on this device/.test(f1.summary), "…and the summary says so");
    check(/\(partial\)/.test(await panelText()), "…and the status line says partial");
  }
  await ev(`new Promise((ok, no) => { const r = indexedDB.open("sagebrush-workspace"); r.onsuccess = () => { const db = r.result, tx = db.transaction("entries", "readwrite"); tx.objectStore("entries").delete("/cloud.csv"); tx.oncomplete = () => { db.close(); ok(1); }; tx.onerror = () => no(tx.error); }; })`);

  // ---- 6. the picker's sink: committed only by close(); aborted on a stop
  await ev(`(() => { window.__picked = null; window.__aborted = 0; window.showSaveFilePicker = async () => ({ createWritable: async () => { const parts = []; return { write: async (c) => { parts.push(new Uint8Array(c)); }, close: async () => { window.__picked = new Blob(parts); }, abort: async () => { window.__aborted++; } }; } }); return 1; })()`);
  await ev(`(() => { window.__exp = null; window.__SB_EXPORT_TEST__ = { stats: {} }; return 1; })()`);
  const pk = await exportOnce(join(out, "pk.zip"), { picked: true });
  check(!pk.stopped && (await ev(`!!window.__picked && window.__aborted === 0`)), "the picker's file gets the archive, committed by close(): " + (pk.stopped ?? "ok"));
  await ev(`(() => { window.__picked = null; window.__SB_EXPORT_TEST__ = { afterCapture: async (p) => { if (p === "/data/pic.png") await window.sagebrush.workspace.mkdir("/new folder"); } }; return 1; })()`);
  const pk2 = await exportOnce(join(out, "pk2.zip"), { picked: true });
  check(!!pk2.stopped && (await ev(`window.__picked === null && window.__aborted === 1`)), "a stopped export aborts the picker's file, nothing committed: " + (pk2.stopped ?? "not stopped").slice(-120));
  await ev(`(() => { delete window.showSaveFilePicker; return 1; })()`);

  // ---- 6. Cancel inside a large member, within the bound; nothing left in OPFS; the status line unchanged
  await ev(`${W}.create("/big.bin", { content: new Uint8Array(150 * 2 ** 20).map((_, i) => i & 7) }).then(() => 1)`);
  // (a test-only pause after each 1 MiB slice, so the member is still being written when Cancel is clicked: 150 slices,
  // about 3 s; this content deflates to almost nothing, so without it the member is written in about a second)
  await hooks("slicePause: 20");
  const before = await ev(`${LAST}.then((l) => l.at)`);
  if (!(await ev(`!!${P}`))) await ev(`(() => { document.querySelector("#wssidebar .fmeter").click(); return 1; })()`);
  await ev(`(() => { [...(${P}?.querySelectorAll("button") ?? [])].filter((b) => b.textContent === "Close").forEach((b) => b.click()); return 1; })()`);
  await until(`[...(${P}?.querySelectorAll("button") ?? [])].some((b) => /^Export all current files/.test(b.textContent))`);
  await panelButton(/^Export all current files/);
  await until(`[...(${P}?.querySelectorAll("button") ?? [])].some((b) => b.textContent === "Save…")`, 120000);
  await panelButton(/^Save…$/);
  // (inside big.bin: progress past its first slices, before its end)
  // (progress counts bytes processed, and everything before big.bin comes to about 200 KB: MB means inside big.bin)
  const inside = await until(`/ of [0-9,]+ files and folders · [0-9.]+ MB written/.test(${P}?.textContent ?? "")`, 60000);
  const t0 = Date.now();
  const hasCancel = await ev(`[...(${P}?.querySelectorAll("button") ?? [])].some((b) => b.textContent === "Cancel")`);
  if (!hasCancel) console.log("(cancel test: no Cancel button; inside " + inside + "; the panel: " + (await panelText()).slice(-300) + ")");
  else await panelButton(/^Cancel$/);
  const stopped = await until(`/The export was cancelled/.test(${P}?.textContent ?? "")`, 10000);
  const took = Date.now() - t0;
  check(inside && stopped && took < 2000, "Cancel during a 150 MB member stops it (" + took + " ms, the bound being 250 ms plus this test's polling)");
  check(!(await ev(`!!window.__exp`)), "…nothing handed to a download");
  check(await until(`navigator.storage.getDirectory().then((r) => r.getDirectoryHandle("sagebrush-export", { create: true })).then(async (d) => { let n = 0; for await (const _ of d.keys()) n++; return n === 0; })`, 5000), "…and no scratch file left in OPFS");
  check((await ev(`${LAST}.then((l) => l.at)`)) === before, "…the status line unchanged");

  // ---- 7. the Blob path: refused before anything is read when the bound passes its cap
  await hooks("noOpfs: true, caps: { blob: 4096 }");
  const bl = await exportOnce(join(out, "bl.zip"));
  check(!!bl.stopped && /can't save a file that large here/.test(bl.stopped), "without OPFS or a picker, an export over the Blob path's cap is refused: " + (bl.stopped ?? "not stopped").slice(-160));
  await ev(`${W}.remove("/big.bin").then(() => 1)`);

  // ---- rule 1: a structural change during the export stops it, with nothing handed over
  await hooks(`afterCapture: async (p) => { if (p === "/Algebra.ipynb") await window.sagebrush.workspace.rename("/data/blob.xyz", "/data/moved.xyz"); }`);
  const d = await exportOnce(join(out, "d.zip"));
  check(!!d.stopped && /\/data\/blob\.xyz (was moved, renamed or deleted while exporting|\(to \/data\/moved\.xyz\): "rename")/.test(d.stopped), "a rename during the export stops it, naming it: " + (d.stopped ?? "not stopped").slice(-200));
  check(!(await ev(`!!window.__exp`)), "…and nothing is handed to a download");
  check(/Last export prepared on this device: just now/.test(await panelText()), "…the status line is the earlier export's");

  // ---- 11. the caps on growth after preflight
  await hooks(`caps: { doc: 2000 }, beforeCapture: async (p) => { if (p === "/Algebra.ipynb") { const r = await window.sagebrush.workspace.read(p); await window.sagebrush.workspace.write(p, { ...r.content, cells: [...r.content.cells, { id: "big", code: "x".repeat(5000) }] }); } }`);
  const g1 = await exportOnce(join(out, "g1.zip"));
  check(!!g1.stopped && /larger than/.test(g1.stopped), "a document grown past its cap after preflight stops the export: " + (g1.stopped ?? "not stopped").slice(-160));
  await hooks(`caps: { manifest: 1200 }`);
  const g2 = await exportOnce(join(out, "g2.zip"));
  check(!!g2.stopped && /manifest/.test(g2.stopped), "a manifest past its cap is refused: " + (g2.stopped ?? "not stopped").slice(-160));

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
console.log(`${checks - fails.length}/${checks} passed`);
for (const f of fails) console.log("FAIL " + f);
process.exit(fails.length ? 1 : 0);
