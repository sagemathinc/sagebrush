// TimeTravel's Resume from here (design/timetravel-replay.md), on the full
// page in headless Chromium: runs are journaled in the history; resuming a
// version in a new tab replays them and recreates the session exactly
// (random numbers, the clock, os.urandom, numpy, a file read), with the code
// as it ran, not as it was edited afterwards.  Serve web/dist first:
//   bun web/build.ts && (cd web/dist && python3 ../serve.py 8765) &
//   node web/test-replay.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "./test-port.mjs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { bundleHashes } from "./notebook/bundle-blobs.mjs";
const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
// (the run journal and its replay: the notebook as it was before the reactive
// model, still there with ?reactive=0; the reactive notebook resumes a version
// by computing it again: web/test-reactive.mjs)
const start = new URL("?reactive=0", base).href;
let port = Number(process.env.CDP_PORT) || 0; // (else Chrome's choice: several runs do not collide, test-port.mjs)
const profile = mkdtempSync(join(tmpdir(), "sb-replay-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, "--window-size=1000,700", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!port) port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) process.exitCode = 1; };
// ---- which files' bytes a bundle carries (notebook/bundle-blobs.mjs), on records: only those a run of the same
// session read (William's B-feedback, Nov 1: a bundle had every file in the browser)
{
  const J = JSON.stringify;
  const S = [{ id: "s1", files: [["data.txt", "h1"], ["secret.txt", "h2"]] }, { id: "s2", files: [["data.txt", "h1b"]] }];
  const F = [{ sid: "s1", path: "late.txt", hash: "h3" }, { sid: "s1", path: "unread.txt", hash: "h4" }, { sid: "s2", path: "late.txt", hash: "h5" }, { sid: "s1", path: "late.txt", hash: null }];
  const got = (runs) => J([...bundleHashes(S, runs, F)].sort());
  ok(got([{ sid: "s1", reads: ["/data.txt", "late.txt"] }, { sid: "s2", reads: [] }, { sid: "s3", reads: ["data.txt"] }]) === J(["h1", "h3"]), "bundle files: a session's file and a file put while it ran, each read by one of its runs; never one unread, nor one another session read: " + got([{ sid: "s1", reads: ["/data.txt", "late.txt"] }, { sid: "s2", reads: [] }, { sid: "s3", reads: ["data.txt"] }]));
  ok(got([{ sid: "s2", foreign: true, at: null, reads: ["data.txt"] }]) === J(["h1b"]), "…a foreign run's reads count (a resume reruns it)");
  ok(got([{ sid: "s1" }, { sid: "s2", code: "x" }]) === "[]", "…a journal from before reads were kept: no files at all");
}
async function tab(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0; const waiting = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result?.value; };
  const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(100); } throw new Error("timeout: " + expr); };
  return { ws, send, ev, until };
}
const ready = "window.sagebrush && document.querySelectorAll('#cells .cell').length > 0 && document.querySelector('#status').textContent.startsWith('ready')";
const outs = "sagebrush.notebook.cells().map((c) => c.out.textContent)";
// run every cell and wait until none is queued or running
const runAll = "(async () => { await sagebrush.notebook.runAll(); return true; })()";

const CELLS = [
  "import random, time, os\nr = random.random(); t = time.time(); u = os.urandom(4).hex()\nprint(r, u)",
  "a = 10\nprint(a)",
  "import numpy as np\ng = np.random.default_rng().integers(0, 1000, 3)\nprint(g)",
  "data = open('data.txt').read()\nprint(data)",
  "from ipywidgets import interact\n@interact(n=(1, 10))\ndef f(n=3):\n    global last\n    last = n * a\n    print('last =', last)",
];
const PROBE = "print(r, t, u, list(g), a, data, last, b)";

try {
  const a = await tab(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await a.send("Page.navigate", { url: start });
  await a.until(ready);
  // a new notebook with these cells, and a file in the browser's files
  await a.ev(`(() => { sagebrush.notebook.replace({ mode: "python", cells: ${JSON.stringify(CELLS.map((code, i) => ({ id: "c" + i, code })))} }); return true; })()`);
  await a.ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File(["hello, file"], "data.txt")); dispatchEvent(new DragEvent("drop", { dataTransfer: dt, cancelable: true })); return true; })()`);
  await sleep(800);
  await a.ev(runAll);
  const original = await a.ev(outs);
  ok(original[3].trim() === "hello, file" && /^0\.\d+ [0-9a-f]{8}/.test(original[0]), "the cells ran: " + JSON.stringify(original.map((s) => s.trim())));
  // an @interact moved (its function sets a variable), and the console's code (not in the notebook)
  const moved = await a.ev("(async () => { const nb = sagebrush.notebook; const box = await nb.setInteract([...nb.interacts.keys()][0], { n: 7 }); return box.textContent; })()");
  ok(/last = 70/.test(moved), "the @interact reran with n = 7: " + moved.trim());
  // (and again: the journal once froze the notebook's values, so a second change was lost)
  const moved2 = await a.ev("(async () => { const nb = sagebrush.notebook; const k = [...nb.interacts.keys()][0]; await nb.setInteract(k, { n: 4 }); const box = await nb.setInteract(k, { n: 7 }); return box.textContent; })()");
  ok(/last = 70/.test(moved2) && (await a.ev("sagebrush.history.records('run').filter((r) => r.kind === 'interact').map((r) => r.values.n).join(',')")) === "7,4,7", "an @interact keeps responding, and each journaled change has its own values: " + moved2.trim());
  const interactOut = (await a.ev(outs))[4];
  await a.ev("new Promise((res) => sagebrush.kernel.execute('b = last + 1', { mode: 'python', repl: true }, { start() {}, out() {}, display() {}, interact() {}, clear() {}, done: res, stopped: res, skipped: res }))");
  // edit a cell without running it, then add a probe and run it
  await sleep(700);
  await a.ev(`(() => { const nb = sagebrush.notebook; nb.setInput(nb.cells()[1], "a = 20\\nprint(a)"); return true; })()`);
  await sleep(900);
  await a.ev("(() => { sagebrush.notebook.flush(); return true; })()");
  const head = await a.ev("sagebrush.history.head()");
  await a.ev(`(() => { const nb = sagebrush.notebook; nb.addCell(${JSON.stringify(PROBE)}); return true; })()`);
  await sleep(900);
  await a.ev("(async () => { const nb = sagebrush.notebook; await nb.run(nb.cells().at(-1)); return true; })()");
  const probe = (await a.ev(outs)).at(-1).trim();
  ok(/ 10 hello, file 70 71$/.test(probe), "the probe sees a = 10 (the edit was not run), the interact's and the console's variables: " + probe);

  // ---- the journal
  await sleep(500);
  const runs = await a.ev("sagebrush.history.records('run').length");
  const sessions = await a.ev("sagebrush.history.records('session')");
  ok(runs === 10 && sessions.length === 1 && /^[0-9a-f]{64}$/.test(sessions[0].seed ?? ""), `journaled: ${runs} runs, ${sessions.length} session with a seed`);
  ok(sessions[0].files?.length === 0 && (await a.ev("sagebrush.history.records('file').length")) === 1, "the file (dropped after the interpreter started) is a file event, with its hash only");
  const plan = await a.ev(`(() => { const p = sagebrush.history.replayPlan(${JSON.stringify(head)}); return { runs: p.runs, ms: p.ms, blocking: p.blocking, warnings: p.warnings, files: p.events.filter((e) => e.file).length }; })()`);
  ok(plan.runs === 9 && plan.files === 1 && plan.blocking.length === 0 && plan.warnings.length === 0, "the plan at the edited version: the 9 runs before it (cells, interact, console) and the file: " + JSON.stringify(plan));
  const consoleRun = await a.ev("sagebrush.history.records('run').find((r) => r.code === 'b = last + 1') ?? null");
  ok(consoleRun && consoleRun.repl && !consoleRun.cell, "the console's run keeps its code in the journal (it is not in the notebook)");
  // ---- the panel: a mark, the estimate
  await a.ev("document.querySelector('#ttbtn').click()");
  await a.until("document.querySelectorAll('#ttmarks i').length > 0", 5000);
  await a.ev(`(() => { const vs = sagebrush.history.versions(); const s = document.querySelector('#ttslider'); s.value = vs.findIndex((v) => v.time === ${JSON.stringify(head)}); s.dispatchEvent(new Event('input')); return true; })()`);
  // ---- resume, in a new tab (the address the former Resume from here button opened)
  const resumeUrl = (at) => a.ev(`location.pathname + "?resume=" + encodeURIComponent(localStorage.getItem("sagebrush-current")) + "&at=" + encodeURIComponent(${JSON.stringify(at)})`);
  const url = await resumeUrl(head);
  ok(/\?resume=.+&at=/.test(url ?? ""), "Resume from here opens " + url);
  const t2 = await (await fetch(`http://127.0.0.1:${port}/json/new?` + encodeURIComponent(new URL(url, base).href), { method: "PUT" })).json();
  const b = await tab(t2.webSocketDebuggerUrl);
  await b.send("Page.bringToFront");
  await b.until("window.sagebrush?.replayReport !== undefined", 60000);
  const report = await b.ev("sagebrush.replayReport");
  const status = await b.ev("document.querySelector('#status').textContent");
  ok(report.runs === 9 && report.diverged.length === 0, "replayed 9 runs, identical: " + status);
  const resumed = await b.ev(outs);
  ok(JSON.stringify(resumed.slice(0, 4)) === JSON.stringify(original.slice(0, 4)), "the replayed outputs are the original ones");
  ok(resumed[4] === interactOut && (await b.ev("[...sagebrush.notebook.interacts.values()][0]?.values.n")) === 7, "the @interact shows its last output and its control at n = 7: " + resumed[4].trim());
  ok((await b.ev("sagebrush.notebook.cells()[1].ta.value")) === "a = 20\nprint(a)", "the cells are as at that version (the edit)...");
  await b.ev(`(() => { sagebrush.notebook.addCell(${JSON.stringify(PROBE)}); return true; })()`);
  await b.ev("(async () => { const nb = sagebrush.notebook; await nb.run(nb.cells().at(-1)); return true; })()");
  const probe2 = (await b.ev(outs)).at(-1).trim();
  ok(probe2 === probe, "...and the session is the original's: " + probe2);
  ok(/\(at version \d+\)$/.test(await b.ev("document.querySelector('#nbname').value")), "the new notebook's name says which version: " + (await b.ev("document.querySelector('#nbname').value")));
  ok((await b.ev("location.search")) === "", "the address no longer resumes (a reload does not fork again)");
  // the resumed notebook's own history: the versions up to that one, and its journal continues
  const bRuns = await b.ev("sagebrush.history ? sagebrush.history.records('run').length : -1");
  ok(bRuns === 10, "its history has the original's journal and its new run: " + bRuns);
  const bplan = await b.ev("(() => { const h = sagebrush.history; const p = h.replayPlan(h.head()); return { runs: p.runs, blocking: p.blocking }; })()");
  ok(bplan.runs === 10 && bplan.blocking.length === 0, "...so it can be resumed in turn: " + JSON.stringify(bplan));
  b.ws.close();
  await fetch(`http://127.0.0.1:${port}/json/close/` + t2.id);

  // ---- the portable bundle, opened in another browser (a fresh profile: no notebooks, no files)
  const bundle64 = await a.ev("sagebrush.bundle().then((u) => { let s = ''; for (const x of u) s += String.fromCharCode(x); return btoa(s); })");
  ok(bundle64.length > 100, `File > Download with history: a ${Math.round((bundle64.length * 3) / 4)}-byte .sbreplay`);
  // (the second browser: always Chrome's choice of port, not one beside the first's)
  const profile2 = mkdtempSync(join(tmpdir(), "sb-replay2-"));
  const chrome2 = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", "--window-size=1000,700", `--user-data-dir=${profile2}`, "about:blank"], { stdio: "ignore" });
  try {
    const port2 = await devtoolsPort(profile2);
    let tg2;
    for (let i = 0; i < 100; i++) { try { tg2 = await (await fetch(`http://127.0.0.1:${port2}/json`)).json(); break; } catch { await sleep(100); } }
    const d = await tab(tg2.find((t) => t.type === "page").webSocketDebuggerUrl);
    await d.send("Page.navigate", { url: start });
    await d.until(ready);
    ok((await d.ev("indexedDB.databases().then((l) => l.length)")) >= 1 && (await d.ev("sagebrush.history ? sagebrush.history.records('run').length : 0")) === 0, "another browser: nothing journaled there");
    const nid = await d.ev(`sagebrush.openBundle(Uint8Array.from(atob(${JSON.stringify(bundle64)}), (c) => c.charCodeAt(0)))`);
    await d.until("sagebrush.history !== null && sagebrush.history.records('run').length > 0", 10000);
    const dplan = await d.ev(`(() => { const p = sagebrush.history.replayPlan(${JSON.stringify(head)}); return { runs: p.runs, blocking: p.blocking }; })()`);
    ok(dplan.runs === 9 && dplan.blocking.length === 0, "...opens the bundle with its history and journal: " + JSON.stringify(dplan));
    await d.send("Page.navigate", { url: new URL(`?resume=${encodeURIComponent(nid)}&at=${encodeURIComponent(head)}`, base).href });
    await d.until("window.sagebrush?.replayReport !== undefined", 60000);
    const dr = await d.ev("sagebrush.replayReport");
    ok(dr.runs === 9 && dr.diverged.length === 0, "...and resumes the version there, identical (the file's bytes came in the bundle): " + (await d.ev("document.querySelector('#status').textContent")));
    await d.ev(`(() => { sagebrush.notebook.addCell(${JSON.stringify(PROBE)}); return true; })()`);
    await d.ev("(async () => { const nb = sagebrush.notebook; await nb.run(nb.cells().at(-1)); return true; })()");
    ok((await d.ev(outs)).at(-1).trim() === probe, "...with the same session as the original browser's");
    d.ws.close();
  } finally {
    chrome2.kill();
    try { rmSync(profile2, { recursive: true, force: true }); } catch {}
  }
  await a.send("Page.bringToFront");

  // ---- reproducible randomness off: a warning; an interrupted run: not resumable
  await a.send("Page.bringToFront");
  await a.ev("document.querySelector('#ttrepro').click(); true");
  ok((await a.ev("sagebrush.notebook.meta.reproducible")) === false, "the switch turns reproducible randomness off for this notebook");
  await a.ev("sagebrush.kernel.restart(); true");
  await a.until("document.querySelector('#status').textContent.startsWith('ready')");
  await a.ev("(async () => { const nb = sagebrush.notebook; await nb.run(nb.cells()[1]); return true; })()");
  await sleep(500);
  const p3 = await a.ev("(() => { const h = sagebrush.history; const p = h.replayPlan(h.head()); return { runs: p.runs, warnings: p.warnings, seeds: h.records('session').map((s) => !!s.seed) }; })()");
  ok(p3.runs === 1 && p3.warnings.includes("reproducible randomness was off") && p3.seeds.includes(false), "with it off, the new session has no seed and resuming warns: " + JSON.stringify(p3));
  await a.ev("document.querySelector('#ttrepro').click(); true");
  // (a replay whose output differs said where: tested while Resume from here
  // was a button; the journal's replay is the pre-reactive notebook's, kept
  // behind ?reactive=0 for now)
  // ---- reload: the journal is in IndexedDB
  await a.send("Page.reload");
  await a.until(ready);
  await a.until("sagebrush.history !== null", 10000);
  const after = await a.ev(`(() => { const p = sagebrush.history.replayPlan(${JSON.stringify(head)}); return p.runs; })()`);
  ok(after === 9, "after a reload, the same version still resumes with its 9 runs");

  // ---- each notebook has its own interpreter: a new notebook in the same
  // tab does not see the first one's variables, and resuming it replays only
  // its own runs
  await a.ev("(async () => { const nb = sagebrush.notebook; await nb.run(nb.cells()[0]); return true; })()");
  const kA = await a.ev("sagebrush.kernel.uid");
  await a.ev(`document.querySelector('#filebtn').click(); document.querySelector('[data-f="new"]').click(); true`);
  await a.until(`sagebrush.notebook.cells().length === 1 && sagebrush.kernel.uid !== ${kA}`, 5000);
  await a.until("sagebrush.kernel.ready", 15000);
  await sleep(500);
  await a.ev(`(() => { const nb = sagebrush.notebook; nb.setInput(nb.cells()[0], ${JSON.stringify("print('r' in globals())\nc = 3")}); return true; })()`);
  await sleep(700);
  await a.ev("(async () => { const nb = sagebrush.notebook; await nb.run(nb.cells()[0]); return true; })()");
  ok((await a.ev(outs))[0].trim() === "False", "a new notebook has its own interpreter: the first notebook's r is not defined there");
  await a.until("sagebrush.history !== null && sagebrush.history.records('run').length >= 1", 10000);
  const bp = await a.ev("(() => { const h = sagebrush.history; const p = h.replayPlan(h.head()); return { runs: p.runs, blocking: p.blocking, foreign: p.events.filter((e) => e.run?.foreign).length }; })()");
  ok(bp.runs === 1 && bp.foreign === 0 && bp.blocking.length === 0, "...and its plan has only its own run: " + JSON.stringify(bp));

  // ---- a bundle carries the bytes of only the files its sessions read (William's B-feedback, Nov 1: one carried every
  // file in the browser): a new interpreter is given every file; its code reads one renamed first and data.txt, writes
  // over another and reads that, and never reads the third
  const FILES = { "keep.txt": "read after a rename", "secret.txt": "not for the bundle", "over.txt": "overwritten first" };
  for (const [name, text] of Object.entries(FILES)) await a.ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(text)}], ${JSON.stringify(name)})); dispatchEvent(new DragEvent("drop", { dataTransfer: dt, cancelable: true })); return true; })()`);
  await sleep(800);
  await a.ev("sagebrush.kernel.restart(); true");
  await a.until("sagebrush.kernel.ready && document.querySelector('#status').textContent.startsWith('ready')", 15000);
  await a.ev(`(() => { const nb = sagebrush.notebook; nb.setInput(nb.cells()[0], ${JSON.stringify("import os\nos.rename('keep.txt', 'moved.txt')\nprint(open('moved.txt').read())\nopen('over.txt', 'w').write('mine')\nprint(open('over.txt').read())\nprint(open('data.txt').read())")}); return true; })()`);
  await sleep(700);
  await a.ev("(async () => { const nb = sagebrush.notebook; await nb.run(nb.cells()[0]); return true; })()");
  ok((await a.ev(outs))[0].trim() === "read after a rename\nmine\nhello, file", "the new session read the renamed file, its own write and data.txt: " + JSON.stringify((await a.ev(outs))[0]));
  await sleep(500);
  const last = await a.ev("(() => { const s = sagebrush.history.records('session'); return { files: s.at(-1)?.files?.map(([p]) => p).sort() ?? [], reads: sagebrush.history.records('run').at(-1)?.reads ?? null }; })()");
  ok(["data.txt", "keep.txt", "over.txt", "secret.txt"].every((p) => last.files.some((f) => f.replace(/^\//, "") === p)) && JSON.stringify((last.reads ?? []).map((p) => p.replace(/^\//, "")).sort()) === JSON.stringify(["data.txt", "keep.txt"]), "…given every file; its run's reads: the renamed one by its first name, and data.txt, not the one it wrote over: " + JSON.stringify(last));
  const raw = await a.ev("sagebrush.bundle().then((u) => { let s = ''; for (const x of u) s += String.fromCharCode(x); return btoa(s); })");
  const bundled = JSON.parse(gunzipSync(Buffer.from(raw, "base64")).toString("utf8"));
  const sha = (t) => createHash("sha256").update(t).digest("hex");
  const has = (t) => Object.prototype.hasOwnProperty.call(bundled.blobs, sha(t));
  ok(has("read after a rename") && has("hello, file") && !has("not for the bundle") && !has("overwritten first") && Object.keys(bundled.blobs).length === 2, "the bundle carries the two files read, not the unread one nor the one written over before it was read: " + JSON.stringify({ blobs: Object.keys(bundled.blobs).length, secret: has("not for the bundle"), over: has("overwritten first") }));
} catch (e) {
  ok(false, String(e?.stack ?? e));
} finally {
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
}
