// ci: web-export order=20 chrome
// File > Download "with its files (.zip)" (dependencies 2b: web/share-client/download.ts, picker.ts, and the export
// chunk's web/workspace/export/selected.ts) in headless Chromium against the built site.  The .zip is caught as the
// page hands it over (__SB_EXPORT_TEST__.onHand) and read outside the browser by Python's zipfile:
//   - what is pre-checked, with why: a helper the code imports, the data file it opens, what ran; an unrelated file
//     unchecked; a name that can't be followed listed, unchecked;
//   - the .zip holds exactly the notebook and the checked files, byte for byte; an unchecked file is never read, a
//     checked one once; unchecked again, it's gone;
//   - the names: the notebook's folder is the root when every file is inside it, else the workspace paths;
//   - astra's DEP2B-ZIPNAME-1: a name with \ or a drive (..\x, C:\x) refuses the download before any file is read,
//     nothing handed over; a nested helper's name is fine;
//   - the caps: a listed size over a cap disables the button, with why; actual bytes over a cap (the file grew after
//     it was listed) stop the download, nothing handed over;
//   - a file replaced at its path while its read waits, the notebook switched, the dialog closed: each stops it,
//     nothing handed over.
// Serve web/dist first (python3 web/serve.py 8765), then
//   node web/share/test-download-deps.mjs
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-dldeps-"));
const out = mkdtempSync(join(tmpdir(), "sb-dldeps-out-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!port) port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const waiting = new Map(), errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
  if (m.method === "Page.javascriptDialogOpening") send("Page.handleJavaScriptDialog", { accept: true });
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)).slice(0, 400)); return r.result?.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
let failures = 0, count = 0;
const ok = (c, msg) => { count++; console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };

const W = "window.sagebrush.shareTest.workspace()";
const put = (p, text) => ev(`(async () => { const w = await ${W}; await w.putFile(${JSON.stringify(p)}, new TextEncoder().encode(${JSON.stringify(text)})); return 1; })()`);
const mkdir = (p) => ev(`(async () => { const w = await ${W}; if (!(await w.stat(${JSON.stringify(p)}))) await w.mkdir(${JSON.stringify(p)}); return 1; })()`);
const D = "window.sagebrush.download";
const rows = () => ev("[...document.querySelectorAll('#dldepslist .sharerow')].sort((a, b) => a.dataset.i - b.dataset.i).map((r) => ({ i: +r.dataset.i, name: r.querySelector('.name').title, checked: r.querySelector('input').checked, why: r.querySelector('.why').textContent }))");
const byName = async () => Object.fromEntries((await rows()).map((r) => [r.name, r]));
const status = () => ev("document.querySelector('#dldepsstatus').textContent");
const result = () => ev("document.querySelector('#dldepsresult').textContent");
async function openDialog() {
  await ev("document.querySelector('#dldepsdlg').open && document.querySelector('#dldepsdlg').close()");
  const g = await ev(`${D}.generation`);
  await ev("document.querySelector('#filemenu [data-f=withfiles]').click()");
  ok(await until(`${D}.generation > ${g} && !!${D}.selection && document.querySelectorAll('#dldepslist .sharerow').length > 0`), "(the dialog opened, its list drawn)");
  await until(`!${D}.analyzing && /^(Checked|Found no|Stopped|The notebook's interpreter didn't answer)/.test(document.querySelector('#dldepsstatus').textContent)`, 60000);
}
const toggle = (name) => ev(`(() => { const r = [...document.querySelectorAll('#dldepslist .sharerow')].find((r) => r.querySelector('.name').title === ${JSON.stringify(name)}); r.querySelector('input').click(); return 1; })()`);
// (the reads the dialog makes, by path; a read can be held: hold(path) makes the next read of it wait until let go)
const READS = `(() => { const t = window.sagebrush.shareTest; window.__reads = []; window.__holds = {}; t.onRead = async (p) => { window.__reads.push(p); const h = window.__holds[p]; if (h) { delete window.__holds[p]; window.__held = p; await h.p; } }; return 1; })()`;
const hold = (p) => ev(`(() => { let go; const pr = new Promise((r) => (go = r)); window.__holds[${JSON.stringify(p)}] = { p: pr, go }; window.__go = go; window.__held = null; return 1; })()`);
// (the .zip handed over, caught: its bytes as base64, and its name; a hand that comes after none was expected is caught too)
const CATCH = `(() => { window.__zip = null; window.__SB_EXPORT_TEST__ = { ...(window.__SB_EXPORT_TEST__ ?? {}), onHand: async (blob, name) => { const b = new Uint8Array(await blob.arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); window.__zip = { name, b64: btoa(s) }; } }; return 1; })()`;
/** Download as the dialog is; its outcome: the result line, and the .zip's members (name -> text) if one was handed over. */
async function download({ wait = true } = {}) {
  await ev(CATCH);
  await ev("document.querySelector('#dldepsgo').click()");
  if (!wait) return null;
  await until(`!${D}.busy && !!document.querySelector('#dldepsresult').textContent`, 60000);
  await sleep(200);
  return outcome();
}
async function outcome() {
  const z = await ev("window.__zip");
  const line = await result();
  if (!z) return { line, zip: null };
  const f = join(out, "z.zip");
  writeFileSync(f, Buffer.from(z.b64, "base64"));
  const py = spawnSync("python3", ["-I", "-c", "import json, sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); bad = z.testzip(); print(json.dumps({'bad': bad, 'members': {i.filename: z.read(i).decode('utf-8', 'replace') for i in z.infolist()}}))", f], { encoding: "utf8" });
  const r = JSON.parse(py.stdout || "{}");
  return { line, name: z.name, zip: r.members ?? null, bad: "bad" in r ? r.bad : "unreadable: " + py.stderr.slice(0, 200) };
}

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: base });
  ok(await until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000), "the page is ready");
  await ev("document.querySelector('#filemenu [data-f=new]').click()");
  await until("document.querySelectorAll('.cell').length === 1");
  ok(await ev("!!document.querySelector('#filemenu [data-f=withfiles]') && document.querySelector('#filemenu [data-f=withfiles]').textContent.includes('with its files (.zip)')"), "File > Download has \"with its files (.zip)\"");
  // the workspace: a helper the notebook imports, which opens a data file; an unrelated file
  const HELPER = "import csv\nP = open('data/points.csv').read()\n", POINTS = "x,y\n1,2\n3,4\n", OTHER = "not used\n";
  await mkdir("/_code"); await mkdir("/data");
  await put("/_code/__init__.py", "# the helpers\n");
  await put("/_code/helpers.py", HELPER);
  await put("/data/points.csv", POINTS);
  await put("/unrelated.txt", OTHER);
  // (the interpreter started, with the workspace's root on sys.path, as Share's test has it; the code then set, not run)
  const setFirst = (code) => ev(`(() => { const ta = document.querySelector('.cell textarea'); ta.value = ${JSON.stringify(code)}; ta.dispatchEvent(new Event('input', {bubbles: true})); return 1; })()`);
  await setFirst("import sys\nsys.path.insert(0, '/')\nprint('ready')");
  await ev("document.querySelector('.cell textarea').dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', shiftKey: true, bubbles: true}))");
  ok(await until("/ready/.test(document.querySelector('.cell .out')?.textContent ?? '')", 120000), "(the interpreter is running)");
  await setFirst("from _code import helpers\nname = input()\nt = open(name).read()");
  await ev(READS);

  // ---- what is pre-checked, and why; opening reads no file's bytes
  await openDialog();
  {
    const by = await byName();
    const names = Object.keys(by);
    ok(names[0] === "Untitled.ipynb" && by["Untitled.ipynb"].checked, `the notebook first, checked: ${names[0]}`);
    ok(by["_code/helpers.py"]?.checked && /imported/.test(by["_code/helpers.py"].why), `_code/helpers.py checked, imported: ${by["_code/helpers.py"]?.why}`);
    ok(by["data/points.csv"]?.checked && /helpers\.py/.test(by["data/points.csv"].why), `data/points.csv checked, opened by the helper: ${by["data/points.csv"]?.why}`);
    ok(by["unrelated.txt"] && !by["unrelated.txt"].checked, "unrelated.txt listed, unchecked");
    ok(/couldn't be followed/.test(await status()), `the name that can't be followed is said, unchecked: ${(await status()).slice(0, 160)}`);
    const read = await ev("window.__reads.filter((p) => !/\\.py$/.test(p))");
    ok(read.length === 0, `opening read no data file's bytes (the analysis reads .py only): ${JSON.stringify(read)}`);
  }

  // ---- the .zip: exactly the notebook and the checked files, byte for byte; an unchecked file never read
  {
    await ev("window.__reads = []");
    const r = await download();
    const m = r.zip ?? {};
    ok(r.bad === null && JSON.stringify(Object.keys(m).sort()) === JSON.stringify(["Untitled.ipynb", "_code/__init__.py", "_code/helpers.py", "data/points.csv"]), `the .zip holds the notebook and the 3 checked files (the package's __init__.py, imported with it), the .zip whole: ${JSON.stringify(Object.keys(m))} (${r.line}; zipfile's test: ${r.bad})`);
    ok(m["_code/helpers.py"] === HELPER && m["data/points.csv"] === POINTS, "each file byte for byte as the workspace holds it");
    let cells = null;
    try { cells = JSON.parse(m["Untitled.ipynb"]).cells; } catch {}
    ok(Array.isArray(cells) && cells.some((c) => [].concat(c.source).join("").includes("from _code import helpers")), "the notebook as Download's .ipynb, its cell's code in it");
    ok(r.name === "Untitled.zip", `named after the notebook: ${r.name}`);
    const reads = await ev("window.__reads");
    ok(JSON.stringify([...reads].sort()) === JSON.stringify(["/_code/__init__.py", "/_code/helpers.py", "/data/points.csv"]), `the checked files read once each, the unchecked one never: ${JSON.stringify(reads)}`);
    ok(/^Downloaded 4 files/.test(r.line), `said: ${r.line}`);
  }
  // ---- unchecked again, it's gone
  {
    await toggle("data/points.csv");
    const r = await download();
    ok(r.zip && !("data/points.csv" in r.zip) && "_code/helpers.py" in r.zip, `unchecked, data/points.csv isn't in the .zip: ${JSON.stringify(Object.keys(r.zip ?? {}))}`);
    await toggle("data/points.csv");
  }

  // ---- the caps: a listed size over one disables the button; actual bytes over one (grown since listed) stop it
  {
    await ev("window.sagebrush.downloadTest.caps = { files: 10000, file: 5, total: 1e9 }");
    await openDialog();
    const dis = await ev("document.querySelector('#dldepsgo').disabled"), sum = await ev("document.querySelector('#dldepssummary').textContent");
    ok(dis && /larger than one file in a download can be/.test(sum), `a file over the cap disables Download .zip, with why: ${sum}`);
    // (a cap over the notebook and every file as listed; data/points.csv then grows past it)
    await ev("window.sagebrush.downloadTest.caps = { files: 10000, file: 4000, total: 1e9 }");
    await openDialog();
    ok(!(await ev("document.querySelector('#dldepsgo').disabled")), "(under the cap as listed, Download .zip is enabled)");
    await put("/data/points.csv", POINTS + "9,9\n".repeat(2000));
    const r = await download();
    ok(!r.zip && /is over/.test(r.line) && /Nothing was downloaded/.test(r.line), `a file grown past the cap after it was listed stops the download, nothing handed over: ${r.line}`);
    await put("/data/points.csv", POINTS);
    await ev("window.sagebrush.downloadTest.caps = null");
  }

  // ---- DEP2B-ZIPNAME-1: unsafe names refuse it before any read; nothing handed over
  {
    let made = 0;
    for (const p of ["/..\\outside.txt", "/C:\\temp\\outside.txt"]) {
      try { await put(p, "x"); made++; } catch (e) { console.log(`  (the workspace refuses ${p} itself: ${String(e.message).slice(0, 120)})`); }
    }
    if (made) {
      await openDialog();
      await ev("document.querySelector('#dldepsall').click()");
      await ev("window.__reads = []");
      const r = await download();
      const reads = await ev("window.__reads");
      ok(!r.zip && /can't go safely into a \.zip/.test(r.line) && reads.length === 0, `a name with \\ or a drive refuses the download before any file is read, nothing handed over: ${r.line.slice(0, 200)} (reads ${reads.length})`);
      for (const p of ["/..\\outside.txt", "/C:\\temp\\outside.txt"]) await ev(`(async () => { const w = await ${W}; const e = await w.stat(${JSON.stringify(p)}); if (e) await w.remove(${JSON.stringify(p)}); return 1; })()`).catch(() => {});
    } else ok(true, "(the workspace refuses names with \\ itself: the refusal before any read is the unit test's, test-picks.mjs)");
  }

  // ---- a file replaced at its path while its read waits: refused, nothing handed over
  {
    await openDialog();
    await hold("/data/points.csv");
    await download({ wait: false });
    ok(await until("window.__held === '/data/points.csv'"), "(the read of data/points.csv is held)");
    await ev(`(async () => { const w = await ${W}; await w.remove('/data/points.csv'); await w.putFile('/data/points.csv', new TextEncoder().encode('replaced\\n')); return 1; })()`);
    await ev("window.__go()");
    await until(`!${D}.busy && !!document.querySelector('#dldepsresult').textContent`);
    const r = await outcome();
    ok(!r.zip && /changed/.test(r.line), `a file replaced at its path during its read stops the download, nothing handed over: ${r.line}`);
    await put("/data/points.csv", POINTS);
  }
  // ---- the dialog closed while a read waits: stopped, nothing handed over
  {
    await openDialog();
    await hold("/data/points.csv");
    await download({ wait: false });
    await until("window.__held === '/data/points.csv'");
    await ev("document.querySelector('#dldepsdlg').close()");
    await ev("window.__go()");
    await until(`!${D}.busy`);
    await sleep(300);
    ok(!(await ev("window.__zip")), `closing the dialog during the download hands nothing over: ${await result()}`);
  }

  // ---- the names: the notebook's folder is the root when every file is inside it
  {
    await mkdir("/proj"); await mkdir("/proj/_code");
    const moved = await ev(`(async () => { const w = await ${W}; const all = await w.list('/', { recursive: true }); const nbe = all.find((e) => e.kind === 'notebook' && /Untitled/.test(e.path)); if (!nbe) return null; await w.rename(nbe.path, '/proj/' + nbe.path.split('/').pop()); return '/proj/' + nbe.path.split('/').pop(); })()`).catch((e) => "error: " + e.message);
    ok(moved === "/proj/Untitled.ipynb", `(the notebook moved into /proj: ${moved})`);
    await put("/proj/_code/h.py", "H = 1\n");
    await setFirst("import sys\nsys.path.insert(0, '/proj')\nfrom _code import h");
    await openDialog();
    await ev("document.querySelector('#dldepsnone').click()");
    await toggle("proj/_code/h.py");
    let r = await download();
    ok(r.zip && JSON.stringify(Object.keys(r.zip).sort()) === JSON.stringify(["Untitled.ipynb", "_code/h.py"]), `every file inside the notebook's folder: its folder is the .zip's root: ${JSON.stringify(Object.keys(r.zip ?? {}))}`);
    await toggle("data/points.csv");
    r = await download();
    ok(r.zip && JSON.stringify(Object.keys(r.zip).sort()) === JSON.stringify(["data/points.csv", "proj/Untitled.ipynb", "proj/_code/h.py"]), `a file outside it: every file at its workspace path: ${JSON.stringify(Object.keys(r.zip ?? {}))}`);
  }

  // ---- astra's DEP2B-OPEN-ID-1: the notebook's path is looked up when the dialog opens; an answer that comes after a
  // switch of notebooks, or after a newer open, is dropped: never another notebook's path with this one's bytes
  const HOLDPATH = "(() => { let go; const p = new Promise((r) => (go = r)); window.__pathGo = go; window.__pathHeld = false; window.sagebrush.downloadTest.afterPath = async () => { window.sagebrush.downloadTest.afterPath = null; window.__pathHeld = true; await p; }; return 1; })()";
  {
    await ev("document.querySelector('#dldepsdlg').open && document.querySelector('#dldepsdlg').close()");
    await ev(HOLDPATH);
    await ev("document.querySelector('#filemenu [data-f=withfiles]').click()");
    ok(await until("window.__pathHeld === true"), "(the lookup of the notebook's path, in /proj, is held)");
    const cellsBefore = await ev("document.querySelector('.cell textarea').value");
    await ev("document.querySelector('#filemenu [data-f=new]').click()");
    ok(await until(`document.querySelectorAll('.cell').length === 1 && document.querySelector('.cell textarea').value !== ${JSON.stringify(cellsBefore)}`), "(another notebook is open meanwhile)");
    await sleep(500);
    await ev("window.__pathGo()");
    await sleep(800);
    ok(!(await ev("document.querySelector('#dldepsdlg').open")), "a path looked up for the notebook switched away from is dropped: no dialog opens with it");
    await openDialog();
    const r = await download();
    ok(r.zip && Object.keys(r.zip).length === 1 && !Object.keys(r.zip)[0].startsWith("proj/") && Object.keys(r.zip)[0].endsWith(".ipynb"), `the new notebook's own open: its own name, nothing of /proj: ${JSON.stringify(Object.keys(r.zip ?? {}))}`);
  }
  {
    await ev("document.querySelector('#dldepsdlg').close()");
    await ev(HOLDPATH);
    await ev("document.querySelector('#filemenu [data-f=withfiles]').click()");
    await until("window.__pathHeld === true");
    const g0 = await ev(`${D}.generation`);
    await ev("document.querySelector('#filemenu [data-f=withfiles]').click()");
    ok(await until(`${D}.generation > ${g0} && document.querySelector('#dldepsdlg').open`), "a second open while the first's lookup is held: the dialog opens");
    const g1 = await ev(`${D}.generation`);
    await ev("window.__pathGo()");
    await sleep(800);
    ok((await ev(`${D}.generation`)) === g1, "the first open's late answer is dropped: the dialog isn't opened again over the second");
  }

  // ---- the notebook switched while a read waits: stopped, nothing handed over
  {
    await openDialog();
    await ev("document.querySelector('#dldepsall').click()");
    await hold("/data/points.csv");
    await download({ wait: false });
    await until("window.__held === '/data/points.csv'");
    await ev("document.querySelector('#filemenu [data-f=new]').click()");
    await sleep(500);
    await ev("window.__go()");
    await until(`!${D}.busy`, 30000);
    await sleep(300);
    ok(!(await ev("window.__zip")), `the notebook switched during the download: nothing handed over: ${await result()}`);
  }
  ok(errors.length === 0, `no uncaught page errors: ${JSON.stringify(errors).slice(0, 300)}`);
} catch (e) {
  ok(false, `the run stopped: ${e?.message ?? e}`);
} finally {
  // (Chrome gone before its profile is removed: it writes there until it exits)
  const gone = new Promise((r) => chrome.once("exit", r));
  chrome.kill();
  await Promise.race([gone, sleep(5000)]);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(out, { recursive: true, force: true });
}
console.log(failures ? `${failures} of ${count} checks failed` : `ok: ${count} checks`);
process.exit(failures ? 1 : 0);
