// A data file's preview, its versions, and the Storage panel
// (web/workspace/preview.ts, design/workspace-files.md §4, §2.5, §6.3), in
// headless Chromium against the built site: a table's first rows, a
// picture, a text, a binary file not shown; a file's earlier versions,
// restored (what was there kept as a version too) and deleted by the
// person after confirming; "Delete older versions in this folder"; the
// Storage panel's numbers, "Free N MB of old versions", Trash, and asking
// the browser to keep the storage; the meter at the foot; and the same
// preview on the board page.  SHOT_DIR=dir saves screenshots there.
// Serve web/dist first (python3 web/serve.py 8765), then
//   node web/workspace/test-workspace-preview.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const shots = process.env.SHOT_DIR;
let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-ws-preview-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!port) port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = []; const dialogs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
  // (a confirmation: what it says kept, then accepted, or with `refuse` set, refused)
  if (m.method === "Page.javascriptDialogOpening") { dialogs.push(m.params.message); send("Page.handleJavaScriptDialog", { accept: !refuse }); }
};
let refuse = false;
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 1500)); return r.result?.value; };
const until = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
const go = async (url) => { await send("Page.navigate", { url }); await sleep(300); };
const shot = async (name) => {
  if (!shots) return;
  await sleep(400);
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(shots, name + ".png"), Buffer.from(r.data, "base64"));
};
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const W = "window.sagebrush?.workspace";
const S = "document.querySelector('#wssidebar')";
const P = "document.querySelector('.sbfprev')";
const rowSel = (p) => `#wssidebar .frow[data-path=${JSON.stringify(p)}]`;
const click = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error("no " + ${JSON.stringify(sel)}); e.click(); return 1; })()`);
const menu = (label) => ev(`(() => { const b = [...document.querySelectorAll(".sbfmenu button")].find((x) => x.textContent === ${JSON.stringify(label)}); if (!b) throw new Error("no menu item " + ${JSON.stringify(label)}); b.click(); return 1; })()`);
const panelButton = (re) => ev(`(() => { const b = [...document.querySelectorAll(".sbfprev button")].find((x) => ${re}.test(x.textContent)); if (!b) throw new Error("no button " + ${JSON.stringify(String(re))}); b.click(); return 1; })()`);
const closePanel = () => ev(`(() => { document.querySelector(".sbfprev .ph .x")?.click(); return 1; })()`);
const history = (p) => ev(`${W}.history(${JSON.stringify(p)}).then((h) => h.length)`);
const text = (p) => ev(`${W}.read(${JSON.stringify(p)}).then((r) => new TextDecoder().decode(r.content))`);
const openRow = async (p) => { await until(`!!document.querySelector(${JSON.stringify(rowSel(p))})`); await click(rowSel(p)); };

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await go(base);
  await until(`!!${W}`, 60000);
  // files to preview; primes.csv written over once (a version, by the page's agent)
  const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#4a6b49"/><script>window.__svgRan = 1</script></svg>`;
  await ev(`(async () => {
    const w = ${W};
    await w.create("/data/primes.csv", { content: "n,p\\n1,2\\n2,3\\n3,5\\n" });
    await w.write("/data/primes.csv", "n,p\\n1,2\\n2,3\\n3,5\\n4,7\\n");
    await w.create("/data/notes.txt", { content: "Primes below ten: 2, 3, 5, 7." });
    await w.create("/pic.svg", { content: ${JSON.stringify(SVG)} });
    await w.create("/blob.bin", { content: new Uint8Array([0, 1, 2, 0, 255]) });
    await w.create("/raw.txt", { content: new Uint8Array([104, 105, 0, 1, 2]) });
    await w.create("/Algebra.ipynb");
    return 1;
  })()`);
  await go(base);
  await until(`!!document.querySelector("#wsfilesbtn") && !document.querySelector("#wsfilesbtn").hidden`, 60000);
  if (await ev(`${S}.hidden`)) await click("#wsfilesbtn");
  await until(`!${S}.hidden`);
  await openRow("/data");
  // a table: its first rows
  await openRow("/data/primes.csv");
  check(await until(`!!${P}?.querySelector("table")`), "clicking a CSV file opens its preview, a table");
  const table = await ev(`({ head: [...${P}.querySelectorAll("th")].map((x) => x.textContent), rows: [...${P}.querySelectorAll("tbody tr")].map((r) => [...r.cells].map((c) => c.textContent)) })`);
  check(JSON.stringify(table.head) === '["n","p"]' && table.rows.length === 4 && table.rows[3].join() === "4,7", "…its header and rows: " + JSON.stringify(table));
  check(await until(`/Earlier versions \\(1\\)/.test(${P}.textContent) && / · an agent in this page · /.test(${P}.querySelector(".vr").textContent)`), "…and its earlier version, by whom, in plain words (the page's agent)");
  await shot("preview-table");
  // restoring the earlier version: what was there kept as a version too
  await ev(`(() => { [...${P}.querySelectorAll(".vr button")].find((b) => b.textContent === "Restore").click(); return 1; })()`);
  check(await until(`${W}.read("/data/primes.csv").then((r) => !new TextDecoder().decode(r.content).includes("4,7"))`), "Restore puts the earlier version back");
  check((await history("/data/primes.csv")) === 2 && !(await ev(`!!${P}`)), "…keeping what was there as a version too; the preview closes");
  // deleting older versions: confirmed, said, and only then
  await openRow("/data/primes.csv");
  await until(`/Earlier versions \\(2\\)/.test(${P}?.textContent ?? "")`);
  await shot("preview-versions");
  refuse = true;
  await panelButton(/^Delete older versions/);
  await sleep(500);
  check((await history("/data/primes.csv")) === 2 && /Delete the 2 earlier versions of "primes\.csv"/.test(dialogs.at(-1) ?? ""), "Delete older versions asks first, saying what it deletes; refused, nothing goes: " + dialogs.at(-1));
  refuse = false;
  await panelButton(/^Delete older versions/);
  check(await until(`${W}.history("/data/primes.csv").then((h) => h.length === 0)`), "…confirmed, they go");
  check(await until(`/None yet/.test(${P}.textContent) && /old versions of "primes\\.csv" deleted/.test(document.querySelector("#wssidebar .ftoast")?.textContent ?? "")`), "…the preview and the file browser say so");
  check((await text("/data/primes.csv")).includes("3,5") && !(await text("/data/primes.csv")).includes("4,7"), "…the file as it is stays");
  await ev(`(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return 1; })()`);
  check(await until(`!${P}`), "Esc closes the preview");
  // a text; a binary file isn't shown as one; a picture, in an <img> (an SVG's script doesn't run)
  await openRow("/data/notes.txt");
  check(await until(`${P}?.querySelector("pre")?.textContent === "Primes below ten: 2, 3, 5, 7."`), "a text file's preview: its text");
  await closePanel();
  await openRow("/raw.txt");
  check(await until(`/isn't text/.test(${P}?.textContent ?? "") && !${P}.querySelector("pre")`), "a binary file isn't shown as text, whatever its name");
  await closePanel();
  await openRow("/blob.bin");
  check(await until(`/No preview for this kind of file/.test(${P}?.textContent ?? "") && /Download/.test(${P}.textContent)`), "a kind of file with no preview says so, and offers Download");
  await closePanel();
  await openRow("/pic.svg");
  check(await until(`${P}?.querySelector("img")?.complete && ${P}.querySelector("img").naturalWidth === 80`), "a picture's preview: the picture");
  check(await ev(`window.__svgRan === undefined && ${P}.querySelector("img").src.startsWith("blob:")`), "…as an image, so an SVG's script doesn't run");
  await shot("preview-image");
  await closePanel();
  // a folder's older versions, from its ⋯
  await ev(`(async () => { const w = ${W}; await w.write("/data/notes.txt", "v2"); await w.write("/data/notes.txt", "v3"); await w.write("/data/primes.csv", "n,p\\n"); return 1; })()`);
  await click(rowSel("/data") + " .more");
  await menu("Delete older versions in this folder…");
  check(await until(`${W}.history("/data/notes.txt").then(async (a) => a.length === 0 && (await ${W}.history("/data/primes.csv")).length === 0)`), "Delete older versions in this folder: its files' versions go");
  check(/Delete the 3 earlier versions of the files in \/data/.test(dialogs.at(-1) ?? ""), "…after saying how many, and asking: " + dialogs.at(-1));
  check((await text("/data/notes.txt")) === "v3", "…the files as they are stay");
  // the Storage panel: what is here; freeing old versions; Trash; keeping the storage
  await ev(`(async () => { const w = ${W}; await w.write("/data/notes.txt", "v4"); await w.write("/data/notes.txt", "v5"); await w.remove("/blob.bin"); return 1; })()`);
  check(await until(`/ of /.test(document.querySelector("#wssidebar .fmeter")?.textContent ?? "")`), "the file browser's foot shows the storage meter: " + (await ev(`document.querySelector("#wssidebar .fmeter")?.textContent`)));
  await click("#wssidebar .fmeter");
  check(await until(`/Storage in this browser/.test(${P}?.textContent ?? "") && /used of/.test(${P}.textContent)`), "the meter opens the Storage panel, with the browser's estimate");
  const st = await ev(`Object.fromEntries([...${P}.querySelectorAll("dt")].map((d) => [d.textContent, d.nextElementSibling.textContent]))`);
  const docs = await ev(`${W}.list("/", { recursive: true }).then((l) => l.filter((e) => (e.kind === "notebook" || e.kind === "board") && !e.path.startsWith("/Trash")).length)`);
  check(st["Notebooks and boards"] === String(docs) && docs >= 2 && /^4 · /.test(st["Data files"]) && /^2 · 4 B/.test(st["Earlier versions of files"]) && /^1 item · 5 B of files/.test(st["Trash"]), "…what this browser holds: " + JSON.stringify(st));
  check(await ev(`!!${P}.querySelector(".keep")`), "…and whether the browser may clear it");
  await shot("storage");
  // (a version kept after the panel showed them: not among those freed, CORR-AC5-1)
  await ev(`${W}.write("/data/notes.txt", "v6").then(() => 1)`);
  await panelButton(/^Free 4 B of old versions/);
  check(await until(`${W}.history("/data/notes.txt").then((h) => h.length === 1)`), "Free N of old versions: those shown go, after asking; one kept since stays");
  check(await ev(`${W}.version("/data/notes.txt", 0).then((b) => new TextDecoder().decode(b) === "v5")`), "…the one kept since: v5");
  check(/Delete all 2 earlier versions of data files/.test(dialogs.at(-1) ?? ""), "…saying how many: " + dialogs.at(-1));
  check(await until(`/^1 · /.test([...${P}.querySelectorAll("dt")].find((d) => d.textContent === "Earlier versions of files")?.nextElementSibling.textContent ?? "")`), "…and the panel shows what is left");
  await ev(`(() => { Object.defineProperty(navigator.storage, "persisted", { value: async () => window.__kept === true, configurable: true }); Object.defineProperty(navigator.storage, "persist", { value: async () => (window.__kept = true), configurable: true }); return 1; })()`);
  await closePanel();
  await click("#wssidebar .fmeter");
  await until(`/may clear it/.test(${P}?.querySelector(".keep")?.textContent ?? "")`);
  await panelButton(/^Ask the browser to keep it/);
  check(await until(`/^Kept/.test(${P}?.querySelector(".keep")?.textContent ?? "")`), "Ask the browser to keep it: kept, said");
  await panelButton(/^Show$/);
  check(await until(`!${P} && !!document.querySelector(${JSON.stringify(rowSel("/Trash/blob.bin"))})`), "the panel's Trash Show opens Trash");
  await click("#wssidebar .ffoot button");
  // the person's first own edit of a notebook asks the browser to keep the
  // storage (counted from before the page's own scripts run)
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__asked = 0; Object.defineProperty(navigator.storage, "persist", { value: async () => { window.__asked++; return true; }, configurable: true });` });
  await go(base);
  await until(`!!${W} && !!document.querySelector("#cells textarea")`, 60000);
  const asked = await ev(`(async () => { await new Promise((r) => setTimeout(r, 1500)); const before = window.__asked; const ta = document.querySelector("#cells textarea"); ta.value += " "; ta.dispatchEvent(new Event("input", { bubbles: true })); ta.value += " "; ta.dispatchEvent(new Event("input", { bubbles: true })); return [before, window.__asked]; })()`);
  check(asked[0] === 0 && asked[1] === 1, "a page opened asks nothing; the first edit asks the browser to keep the storage, once: " + JSON.stringify(asked));
  // what a preview reads (LIMIT-F85-1): a file too large to preview, or a
  // kind with none, isn't read at all; Download reads it
  await ev(`(() => { window.__reads = []; const g = IDBObjectStore.prototype.get; IDBObjectStore.prototype.get = function (k) { if (this.name === "files" || this.name === "fileBytes") __reads.push(String(k)); return g.apply(this, arguments); }; return 1; })()`);
  // (a data file's bytes are read by its path where kept the old way, by its fid beside the index: capabilities §2a)
  const readOf = (p) => `${W}.stat(${JSON.stringify(p)}).then((e) => __reads.includes(${JSON.stringify(p)}) || (!!e?.fid && __reads.includes(e.fid)))`;
  await ev(`(async () => { const b = new Uint8Array(5 * 2 ** 20).fill(44); await ${W}.create("/huge.csv", { content: b }); await ${W}.create("/other.bin", { content: new Uint8Array([1, 2, 3]) }); return 1; })()`);
  await openRow("/huge.csv");
  check(await until(`/too large to preview here \\(5\\.0 MB\\)/.test(${P}?.textContent ?? "")`) && !(await ev(readOf("/huge.csv"))), "a 5 MB table isn't read to be previewed: too large, said: " + JSON.stringify(await ev(`__reads`)));
  await panelButton(/^Download$/);
  check(await until(readOf("/huge.csv")), "…Download reads it");
  await closePanel();
  await openRow("/other.bin");
  check(await until(`/No preview/.test(${P}?.textContent ?? "")`) && !(await ev(readOf("/other.bin"))), "a kind with no preview isn't read");
  await closePanel();
  // a stale preview's actions never touch another file put at its path (CORR-F85-1, -2)
  await ev(`(async () => { const w = ${W}; await w.create("/victim.txt", { content: "original" }); await w.write("/victim.txt", "original current"); await w.create("/v2.txt", { content: "old" }); await w.write("/v2.txt", "current"); return 1; })()`);
  await openRow("/victim.txt");
  await until(`/Earlier versions \\(1\\)/.test(${P}?.textContent ?? "")`);
  await ev(`(async () => { const w = ${W}; await w.rename("/victim.txt", "/moved.txt"); await w.create("/victim.txt", { content: "replacement" }); await w.write("/victim.txt", "replacement 2"); return 1; })()`);
  await panelButton(/^Delete older versions/);
  await sleep(600);
  const hv = [await history("/moved.txt"), await history("/victim.txt")];
  check(hv[0] === 1 && hv[1] === 1 && /changed since it was shown/.test(await ev(`document.querySelector("#wssidebar .ftoast")?.textContent ?? ""`)), "Delete older versions in a preview of a file renamed, another put at its path: neither's versions go, and it says so: " + JSON.stringify(hv));
  await openRow("/v2.txt");
  await until(`/Earlier versions \\(1\\)/.test(${P}?.textContent ?? "")`);
  await ev(`(async () => { let entered; const ready = new Promise((r) => (entered = r)); const gate = new Promise((r) => (window.__releaseLock = r)); window.__held = navigator.locks.request("sagebrush-workspace", async () => { entered(); await gate; }); await ready; const w = ${W}; window.__moving = w.rename("/v2.txt", "/moved2.txt"); window.__replacing = w.create("/v2.txt", { content: "replacement" }); return 1; })()`);
  await until(`navigator.locks.query().then((q) => q.pending.filter((x) => x.name === "sagebrush-workspace").length >= 2)`);
  await ev(`(() => { [...document.querySelectorAll(".sbfprev .vr button")].find((b) => b.textContent === "Restore").click(); return 1; })()`);
  check(await until(`navigator.locks.query().then((q) => q.pending.filter((x) => x.name === "sagebrush-workspace").length >= 3)`), "(Restore's write waiting third for the lock, after the rename and the replacement)");
  await ev(`(async () => { __releaseLock(); await __held; await __moving; await __replacing; await new Promise((r) => setTimeout(r, 800)); return 1; })()`);
  const after = [await text("/v2.txt"), await text("/moved2.txt")];
  check(after[0] === "replacement" && after[1] === "current" && /changed since it was shown/.test(await ev(`document.querySelector("#wssidebar .ftoast")?.textContent ?? ""`)), "Restore in a preview, the file renamed and another put at its path first: nothing written, said: " + JSON.stringify(after));
  // the board page: the same preview
  await go(base + "board/?new=python");
  await until(`!!window.sagebrush?.board?.snapshot() && !!document.querySelector('[data-sbb="files"]')`, 60000);
  if (await ev(`${S}?.hidden !== false`)) await click('[data-sbb="files"]');
  // (the folder open as it was left, remembered; else opened)
  await until(`!!document.querySelector(${JSON.stringify(rowSel("/data"))})`);
  if (await ev(`document.querySelector(${JSON.stringify(rowSel("/data"))}).getAttribute("aria-expanded") !== "true"`)) await click(rowSel("/data"));
  await openRow("/data/notes.txt");
  check(await until(`${P}?.querySelector("pre")?.textContent === "v6"`), "the board page's file browser previews a file the same way");
  await shot("board-preview");
  for (const e of errors) fails.push("page error: " + e);
} catch (e) {
  fails.push("threw: " + (e?.stack ?? e));
} finally {
  chrome.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
if (fails.length) {
  console.error(`FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`ok: previews, versions and storage, ${checks} checks`);
process.exit(0);
