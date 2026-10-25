// The sync ledger's storage at the global cap (#128, daybreak3's storage decision r2): a measurement, not a test of
// behaviour, run only by hand (on a VM).  Each trial is a fresh Chrome process and profile, a fresh origin (its own
// server port) and a fresh database; it writes the actual global cap, three legal maximum-width namespaces of 70,000
// maximum-width, high-entropy rows each (210,000), each namespace's id constant across its rows, in committed
// transactions of 10,000 rows, and samples navigator.storage.estimate().usage at baseline and immediately after every
// commit (no sleep, no close before a sample).  The peak is the largest delta in those samples.  Then every connection
// is closed, Chrome exits, a new Chrome process on the same profile opens a new page of the same origin, reopens the
// database, waits a fixed settling interval, and samples once more: the steady delta, a diagnostic only.
// Every raw sample is printed, one JSON line a trial, and a summary: P, the largest peak bytes a row, and
// A = max(960, 64 ceil(1.25 P / 64)), compared with the committed allowance (ALLOWANCE, default 960).
//   CHROME=google-chrome TRIALS=5 node web/workspace/measure-sync-ledger-storage.mjs
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "../test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// (the cap's figures; smaller only for a smoke run of the harness itself, never for the measurement)
const TRIALS = Number(process.env.TRIALS ?? 5), NAMESPACES = Number(process.env.NAMESPACES ?? 3), ROWS = Number(process.env.ROWS ?? 70_000), STEP = Number(process.env.STEP ?? 10_000);
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 30_000), ALLOWANCE = Number(process.env.ALLOWANCE ?? 960);
const TRIAL_LIMIT_MS = Number(process.env.TRIAL_LIMIT_S ?? 600) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const site = mkdtempSync(join(tmpdir(), "sb-ledger-size-site-"));
execFileSync("bun", ["build", join(here, "index.ts"), "--outdir", site, "--entry-naming", "ws.js", "--target", "browser", "--format", "esm"], { stdio: "inherit" });
// (the page's side: open the workspace (the real schema, its indexes), write, sample; reopen and sample)
writeFileSync(join(site, "measure.js"), `
import * as W from "./ws.js";
const est = async () => (await navigator.storage.estimate()).usage ?? 0;
const MAX = Number.MAX_SAFE_INTEGER;
const rnd = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
const hexr = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n / 2)), (b) => b.toString(16).padStart(2, "0")).join("");
const digits = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => String(b % 10)).join("");
const alnum = "abcdefghijklmnopqrstuvwxyz0123456789_";
const coder = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => alnum[b % alnum.length]).join("");
const tx = (db, f) => new Promise((ok, no) => { const t = db.transaction(["syncLedger"], "readwrite"); f(t.objectStore("syncLedger")); t.oncomplete = ok; t.onerror = () => no(t.error); t.onabort = () => no(t.error ?? new Error("aborted")); });
const count = (db) => new Promise((ok, no) => { const r = db.transaction("syncLedger").objectStore("syncLedger").count(); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
let w = null;
window.write = async (name, namespaces, rows, step) => {
  w = await W.Workspace.open({ name, mainName: name + "-main" });
  const samples = [{ rows: 0, usage: await est() }];
  const nss = [];
  for (let k = 0; k < namespaces; k++) {
    // (a legal namespace of the widest shape: 64 hex, a 15-digit generation, this device; constant across its rows)
    const ns = hexr(64) + ":" + digits(15) + ":" + w.device;
    if (ns.length !== 97) throw new Error("namespace width " + ns.length);
    nss.push(ns);
    for (let i0 = 0; i0 < rows; i0 += step) {
      // (the widest row (a refusal, its code at CODE.max), every per-row field random; lseq distinct within ns, 16 digits)
      await tx(w.ws, (st) => { for (let i = i0; i < i0 + step; i++) st.put({ ns, lseq: MAX - i * 2 ** 20 - rnd(2 ** 20), s: "refused", d: 1, dseq: MAX - rnd(2 ** 30) * 2 ** 10 - rnd(2 ** 10), code: coder(W.CODE.max) }); });
      samples.push({ rows: k * rows + i0 + step, usage: await est() });
    }
  }
  const n = await count(w.ws);
  const width = JSON.stringify({ ns: nss[0], lseq: MAX, s: "refused", d: 1, dseq: MAX, code: "z".repeat(W.CODE.max) }).length;
  w.close();
  return { samples, rows: n, rowJsonCharsMax: width };
};
window.steady = async (name, settleMs) => {
  const db = await new Promise((ok, no) => { const r = indexedDB.open(name); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  const n = await count(db);
  await new Promise((r) => setTimeout(r, settleMs));
  const usage = await est();
  db.close();
  return { rows: n, usage };
};
window.ready = true;
`);
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>ledger storage</title><script type="module" src="./measure.js"></script>`);

const types = { ".js": "text/javascript", ".html": "text/html" };
async function chromeOn(phase, profile, origin, f) {
  // (a reused profile keeps the last Chrome's port file: removed, so the port read is this process's)
  rmSync(join(profile, "DevToolsActivePort"), { force: true });
  const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  try {
    const port = await devtoolsPort(profile);
    let targets;
    for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.some((t) => t.type === "page")) break; } catch {} await sleep(100); }
    const page = targets?.find((t) => t.type === "page");
    if (!page) throw new Error(`${phase}: Chrome showed no page on its DevTools port ${port}: ${JSON.stringify(targets)?.slice(0, 300)}`);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let n = 0;
    const waiting = new Map();
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
    const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 2000)); return r.result.value; };
    await send("Page.navigate", { url: `${origin}/` });
    for (let i = 0; i < 200 && !(await ev("window.ready === true").catch(() => false)); i++) await sleep(50);
    const out = await f(ev);
    // (a clean exit: Chrome closes its connections and flushes before the process ends)
    const exited = new Promise((ok) => chrome.once("exit", ok));
    await send("Browser.close").catch(() => {});
    await Promise.race([exited, sleep(15_000)]);
    ws.close();
    return out;
  } finally {
    if (chrome.exitCode === null && chrome.signalCode === null) { const exited = new Promise((ok) => chrome.once("exit", ok)); chrome.kill(); await Promise.race([exited, sleep(5000)]); }
  }
}

const trials = [];
let code = 0;
try {
  for (let t = 1; t <= TRIALS; t++) {
    const server = createServer((req, res) => {
      const p = new URL(req.url, "http://x").pathname, f = p === "/" ? "index.html" : p.slice(1);
      let body;
      try { body = readFileSync(join(site, f)); } catch { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": types[extname(f)] ?? "application/octet-stream" });
      res.end(body);
    });
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const profile = mkdtempSync(join(tmpdir(), "sb-ledger-size-"));
    const name = `ledger-size-${t}-${Math.random().toString(36).slice(2, 8)}`;
    const t0 = Date.now();
    try {
      const run = (async () => {
        const wrote = await chromeOn("write", profile, origin, (ev) => ev(`window.write(${JSON.stringify(name)}, ${NAMESPACES}, ${ROWS}, ${STEP})`));
        const still = await chromeOn("reopen", profile, origin, (ev) => ev(`window.steady(${JSON.stringify(name)}, ${SETTLE_MS})`));
        return { wrote, still };
      })();
      const { wrote, still } = await Promise.race([run, sleep(TRIAL_LIMIT_MS).then(() => { throw new Error(`trial ${t} over ${TRIAL_LIMIT_MS / 1000} s`); })]);
      const base = wrote.samples[0].usage, rows = NAMESPACES * ROWS;
      const peak = Math.max(...wrote.samples.map((s) => s.usage - base)), steady = still.usage - base;
      const r = { trial: t, origin, seconds: Math.round((Date.now() - t0) / 1000), rowsWritten: wrote.rows, rowsAfterReopen: still.rows, rowJsonCharsMax: wrote.rowJsonCharsMax, baseline: base, samples: wrote.samples, peakDelta: peak, peakBytesPerRow: +(peak / rows).toFixed(1), steadyUsage: still.usage, steadyDelta: steady, steadyBytesPerRow: +(steady / rows).toFixed(1), settleMs: SETTLE_MS };
      if (wrote.rows !== rows || still.rows !== rows) { r.error = `row count ${wrote.rows} / ${still.rows}, not ${rows}`; code = 1; }
      trials.push(r);
      console.log("trial " + JSON.stringify(r));
    } catch (e) {
      code = 1;
      trials.push({ trial: t, error: String(e?.message ?? e) });
      console.log("trial " + JSON.stringify(trials.at(-1)));
    } finally {
      server.close();
      await sleep(200);
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
  const ok = trials.filter((r) => !r.error);
  const P = Math.max(...ok.map((r) => r.peakDelta / (NAMESPACES * ROWS)));
  // (daybreak3's ruling r3: the floor of 960 applies)
  const A = Math.max(960, Math.ceil((1.25 * P) / 64) * 64);
  const summary = { trials: TRIALS, namespaces: NAMESPACES, rowsPerNamespace: ROWS, rowsPerCommit: STEP, completed: ok.length, rowsPerTrial: NAMESPACES * ROWS, peakBytesPerRow: ok.map((r) => r.peakBytesPerRow), steadyBytesPerRow: ok.map((r) => r.steadyBytesPerRow), P: +P.toFixed(1), A, perNamespaceMiB: +((A * ROWS) / 2 ** 20).toFixed(1), globalMiB: +((A * NAMESPACES * ROWS) / 2 ** 20).toFixed(1), candidate: ALLOWANCE, peaksExceedingCandidate: ok.filter((r) => r.peakDelta / (NAMESPACES * ROWS) > ALLOWANCE).map((r) => r.trial) };
  console.log("summary " + JSON.stringify(summary));
  if (ok.length !== TRIALS) code = 1;
} finally {
  rmSync(site, { recursive: true, force: true });
}
process.exit(code);
