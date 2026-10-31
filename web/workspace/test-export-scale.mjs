// "Export all current files (.zip)" at scale (export plan E1 r2d §6-§7, test 8), in headless Chromium against the built
// site.  Each context is a fresh browser profile with 100,000 entries (folders, written straight into the workspace's
// entries store in a few transactions: what is measured is the export's metadata path, the enumeration, the spool,
// the central directory and the manifest), with paths as long as the 64 MiB manifest cap admits at that count (about
// 455 characters; at the full 1024 the cap refuses at about 18,000 entries, which the main test covers).  M = 0 here
// (no member carries bytes), so §6's ceilings are 32 MiB and 256 MiB.  The passes, each in its own context(s):
//   live  (1 context)  the hard bound, §6 (1): main + worker live growth after two forced collections on each heap,
//                      over their settled baselines, at three checkpoints between members (after preflight, at half the
//                      members written, after cleanup): at most 32 MiB.  The archive checked by Python's zipfile.
//   peak  (3 contexts) the transient guard, §6 (2): main + worker usedSize over the baselines, sampled every 50 ms, no
//                      forced collection during the run: at most 256 MiB in each; every peak and the maximum reported.
//   resp  (1 context)  responsiveness, no forced collections: the longest main-thread task from the click at most 50 ms;
//                      the progress line changing at least every 250 ms while the archive is written
//                      (timed in the page).
//   cancel (1 context) an export cancelled half-way: the "cancelled" line within 250 ms of the click (timed in the page).
// Serve web/dist first (python3 web/serve.py 8765), then
//   N=100000 node web/workspace/test-export-scale.mjs
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const N = Number(process.env.N ?? 100000);
const MiB = 2 ** 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };

/** One fresh browser context: its CDP page session, and the export worker's session once it starts. */
async function open() {
  const profile = mkdtempSync(join(tmpdir(), "sb-export-scale-"));
  const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  const port = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0; const waiting = new Map(); const errors = []; let worker = null;
  const send = (method, params = {}, sessionId) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown" && !m.sessionId) errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
    // (the export's worker, by its script: its own heap, its own session)
    if (m.method === "Target.attachedToTarget" && /sagebrush-export-worker/.test(m.params.targetInfo?.url ?? "")) worker = m.params.sessionId;
    if (m.method === "Target.detachedFromTarget" && m.params.sessionId === worker) worker = null;
  };
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
  const until = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const close = async () => { ws.close(); chrome.kill(); await sleep(1000); rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); };
  return { send, ev, until, errors, worker: () => worker, close };
}

const P = "document.querySelector('.sbfprev')";
const btn = (re) => `(() => { const b = [...document.querySelectorAll(".sbfprev button")].find((x) => ${re}.test(x.textContent)); if (!b) throw new Error("no button " + ${JSON.stringify(String(re))}); b.click(); return 1; })()`;

/** The workspace with N more entries, the page reloaded, the Storage panel open, the export's button there. */
async function prepare(c) {
  await c.send("Page.navigate", { url: base });
  await c.until(`!!window.sagebrush?.workspace`, 60000);
  const made = await c.ev(`new Promise((ok, no) => {
    const r = indexedDB.open("sagebrush-workspace");
    r.onsuccess = async () => {
      const db = r.result, t = Date.now(), pad = "x".repeat(440);
      const parents = 10, per = Math.ceil((${N} - parents) / parents);
      let made = 0;
      for (let p = 0; p < parents && made < ${N}; p++) {
        const tx = db.transaction("entries", "readwrite"), st = tx.objectStore("entries");
        const top = "/scale" + p, fid = "scalefid" + p;
        // (complete rows, as the workspace writes them: with nkey (api.ts nkeyOf: the parent, NUL, the NFC name), so the
        // page's migrator has nothing to fill in, which it would do under the workspace's lock, one row at a time,
        // competing with the export's reads)
        st.put({ path: top, kind: "folder", ref: null, created: t, updated: t, fid, ident: fid, nkey: "/\u0000" + top.slice(1) });
        made++;
        for (let i = 0; i < per && made < ${N}; i++, made++) {
          const path = top + "/" + pad + String(i).padStart(6, "0"), f = "scalefid" + p + "-" + i;
          st.put({ path, kind: "folder", ref: null, created: t, updated: t, fid: f, ident: f, nkey: top + "\u0000" + path.slice(top.length + 1) });
        }
        await new Promise((d, e) => { tx.oncomplete = d; tx.onerror = () => e(tx.error); });
      }
      db.close();
      ok(made);
    };
    r.onerror = () => no(r.error);
  })`);
  await c.send("Page.navigate", { url: base });
  await c.until(`!!document.querySelector("#wsfilesbtn") && !document.querySelector("#wsfilesbtn").hidden`, 60000);
  if (await c.ev(`document.querySelector('#wssidebar').hidden`)) await c.ev(`(() => { document.querySelector("#wsfilesbtn").click(); return 1; })()`);
  await c.until(`!!document.querySelector("#wssidebar .fmeter")`, 120000);
  await c.ev(`(() => { document.querySelector("#wssidebar .fmeter").click(); return 1; })()`);
  await c.until(`[...(${P}?.querySelectorAll("button") ?? [])].some((b) => /^Export all current files/.test(b.textContent))`);
  return made;
}

/** usedSize of the page and of the worker (0 if it isn't running), optionally after two forced collections on each. */
async function heaps(c, gc) {
  const w = c.worker();
  if (gc) {
    for (let i = 0; i < 2; i++) { await c.send("HeapProfiler.collectGarbage"); if (w) await c.send("HeapProfiler.collectGarbage", {}, w); }
  }
  const main = (await c.send("Runtime.getHeapUsage")).usedSize;
  const wk = w ? (await c.send("Runtime.getHeapUsage", {}, w))?.usedSize ?? 0 : 0;
  return { main, worker: wk };
}

/** The test hooks: stops at the baseline point (worker started, preflight not begun) and, if `half`, after member `half`. */
const hooks = (half) => `(() => {
  window.__exp = null;
  window.__at = null;
  const stop = (name) => new Promise((go) => { window.__at = name; window.__go = () => { window.__at = null; go(); }; });
  window.__SB_EXPORT_TEST__ = { noPicker: true, onHand: (blob, name) => { window.__exp = { blob, name }; }, stats: {},
    beforePreflight: () => stop("baseline")${half ? `, between: (n) => (n === ${half} ? stop("half") : undefined)` : ""} };
  return 1;
})()`;
const at = (c, name, ms = 600000) => c.until(`window.__at === ${JSON.stringify(name)}`, ms);
const go = (c) => c.ev(`(() => { window.__go(); return 1; })()`);

async function readArchive(c, out) {
  const size = await c.ev(`window.__exp.blob.size`);
  const parts = [];
  for (let at = 0; at < size; at += 8 * MiB) {
    const b64 = await c.ev(`(async () => { const b = new Uint8Array(await window.__exp.blob.slice(${at}, ${at + 8 * MiB}).arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); })()`);
    parts.push(Buffer.from(b64, "base64"));
  }
  const file = join(out, "scale.zip");
  writeFileSync(file, Buffer.concat(parts));
  const r = spawnSync("python3", ["-I", "-c", "import sys, zipfile, json; z = zipfile.ZipFile(sys.argv[1]); n = z.namelist(); m = json.loads(z.read('manifest.json')); print(json.dumps({'members': len(n), 'last': n[-1], 'entries': len(m['entries'])}))", file], { encoding: "utf8" });
  return { size, ...(r.status === 0 ? JSON.parse(r.stdout) : { error: r.stderr.slice(0, 300) }) };
}

const out = mkdtempSync(join(tmpdir(), "sb-export-scale-out-"));
const PASSES = new Set((process.env.PASSES ?? "live,peak,resp,cancel").split(","));
try {
  // ---- live: the hard bound at three checkpoints
  if (PASSES.has("live")) {
    const c = await open();
    try {
      check((await prepare(c)) === N, `live: the workspace holds ${N} more entries`);
      const half = Math.floor((N + 1) / 2);
      await c.ev(hooks(half));
      await c.ev(btn("/^Export all current files/"));
      check(await at(c, "baseline", 60000) && !!c.worker(), "live: stopped at the baseline point, the worker started");
      const b = await heaps(c, true);
      await go(c);
      check(await c.until(`[...(${P}?.querySelectorAll("button") ?? [])].some((b) => b.textContent === "Save…")`, 600000), "live: preflight ends");
      const live = [];
      const point = async (name) => { const h = await heaps(c, true); const g = (h.main - b.main) + (h.worker - (c.worker() ? b.worker : 0)); live.push([name, g / MiB, (h.main - b.main) / MiB, (h.worker - b.worker) / MiB]); return g; };
      await point("after preflight");
      await c.ev(btn("/^Save…$/"));
      check(await at(c, "half"), "live: stopped half-way through the members");
      await point("half-way");
      await go(c);
      check(await c.until(`!!window.__exp || [...(${P}?.querySelectorAll("button") ?? [])].some((b) => b.textContent === "Export again")`, 1200000), "live: the export ends");
      await sleep(500);
      // (after cleanup: the flow ended, its worker terminated; the page's heap against its baseline)
      await point("after cleanup");
      console.log("(live growth after two forced GCs, MiB [checkpoint, main+worker, main, worker]: " + JSON.stringify(live.map(([n, g, m, w]) => [n, +g.toFixed(2), +m.toFixed(2), +w.toFixed(2)])) + ")");
      check(live.length === 3 && live.every(([, g]) => g <= 32), "live: main + worker live growth at most 32 MiB at every checkpoint (max " + Math.max(...live.map(([, g]) => g)).toFixed(2) + " MiB)");
      if (await c.ev(`!!window.__exp`)) {
        const z = await readArchive(c, out);
        check(!z.error && z.members === N + 2 && z.last === "manifest.json", "live: zipfile reads the archive: " + JSON.stringify(z));
        const st = await c.ev(`window.__SB_EXPORT_TEST__.stats`);
        check(st.spoolChunks > 0 && st.spoolChunks < 300, "live: the spool holds 1 MiB chunks: " + st.spoolChunks + " for " + st.members + " members");
      }
      check(c.errors.length === 0, "live: no page errors: " + c.errors.slice(0, 3).join(" | "));
    } finally { await c.close(); }
  }

  // ---- peak: the transient guard, three fresh contexts, no forced collection during the run
  const peaks = [];
  for (let k = 1; k <= (PASSES.has("peak") ? 3 : 0); k++) {
    const c = await open();
    try {
      await prepare(c);
      await c.ev(hooks(0));
      await c.ev(btn("/^Export all current files/"));
      await at(c, "baseline", 60000);
      const b = await heaps(c, true);
      let peak = 0, sampling = true;
      const sampler = (async () => {
        while (sampling) {
          const h = await heaps(c, false);
          const g = (h.main - b.main) + (c.worker() ? h.worker - b.worker : 0);
          if (g > peak) peak = g;
          await sleep(50);
        }
      })();
      await go(c);
      await c.until(`[...(${P}?.querySelectorAll("button") ?? [])].some((b) => b.textContent === "Save…")`, 600000);
      await c.ev(btn("/^Save…$/"));
      const ended = await c.until(`!!window.__exp`, 1200000);
      sampling = false;
      await sampler;
      peaks.push(peak / MiB);
      check(ended, `peak ${k}: the export ends`);
    } finally { await c.close(); }
  }
  if (PASSES.has("peak")) console.log("(transient high-water over the baselines, main + worker, MiB: " + peaks.map((p) => p.toFixed(1)).join(", ") + "; max " + Math.max(...peaks).toFixed(1) + ")");
  if (PASSES.has("peak")) check(peaks.length === 3 && peaks.every((p) => p <= 256), "peak: at most 256 MiB in each of 3 fresh contexts (max " + Math.max(...peaks).toFixed(1) + " MiB)");

  // ---- resp: responsiveness, no forced collections
  if (PASSES.has("resp")) {
    const c = await open();
    try {
      await prepare(c);
      await c.ev(hooks(0).replace(`beforePreflight: () => stop("baseline")`, `beforePreflight: undefined`));
      // (in the page: long tasks from now, and when the progress line changes while the archive is written)
      await c.ev(`(() => {
        window.__long = 0; window.__marks = []; window.__hb = []; window.__hbt = setInterval(() => window.__hb.push(performance.now()), 20);
        new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long = Math.max(window.__long, e.duration); }).observe({ type: "longtask", buffered: false });
        new MutationObserver(() => { const t = document.querySelector(".sbfprev")?.textContent ?? ""; const m = / written/.test(t); if (m) (window.__raw ??= []).push(performance.now()); if (m && t !== window.__lastText) { window.__lastText = t; window.__marks.push(performance.now()); (window.__texts ??= []).push(t.match(/[^.]*written/)?.[0] ?? ""); } if (/The export was cancelled/.test(t) && !window.__cancelledAt) window.__cancelledAt = performance.now(); }).observe(document.body, { subtree: true, childList: true, characterData: true });
        return 1;
      })()`);
      await c.ev(btn("/^Export all current files/"));
      await c.until(`[...(${P}?.querySelectorAll("button") ?? [])].some((b) => b.textContent === "Save…")`, 600000);
      await c.ev(btn("/^Save…$/"));
      check(await c.until(`!!window.__exp`, 1200000), "resp: the export ends");
      const longest = await c.ev(`window.__long`);
      check(longest <= 50, `resp: the longest main-thread task from the click ${Math.round(longest)} ms (at most 50 ms)`);
      // (the values must move at least every 250 ms once the first member is written: before it, nothing moves (the
      // first reads, the workspace's lock), and that wait is reported, not bounded; throughout, the line itself must be
      // written at least every 250 ms, its text unchanged or not, so the page never looks stopped)
      const gap = await c.ev(`(() => { const m = window.__marks, x = window.__texts; let k = x.findIndex((t) => !/^\\D*0 of /.test(t)); if (k < 0) k = m.length; let g = 0, at = k; for (let i = k + 1; i < m.length; i++) if (m[i] - m[i - 1] > g) { g = m[i] - m[i - 1]; at = i; } return [m.length, Math.round(g), x[at - 1], x[at], k > 0 && k < m.length ? Math.round(m[k] - m[0]) : -1]; })()`);
      console.log("(the longest progress gap: between " + JSON.stringify(gap[2]) + " and " + JSON.stringify(gap[3]) + ")");
      // (diagnostics, information only: the longest gap between any two writes of the progress line, the same text
      // included, and the longest gap of a 20 ms page heartbeat between the first and the last progress change)
      const diag = await c.ev(`(() => { clearInterval(window.__hbt); const gapOf = (m) => { let g = 0, at = 0; for (let i = 1; i < m.length; i++) if (m[i] - m[i - 1] > g) { g = m[i] - m[i - 1]; at = m[i - 1]; } return [Math.round(g), Math.round(at)]; }; const a = window.__marks[0], b = window.__marks[window.__marks.length - 1]; return { writes: (window.__raw ?? []).length, writeGap: gapOf(window.__raw ?? []), heartbeatGap: gapOf(window.__hb.filter((t) => t >= a && t <= b)), changes: [Math.round(a), Math.round(b)] }; })()`);
      console.log("(progress diagnostics: " + JSON.stringify(diag) + ")");
      check(gap[0] > 10 && gap[4] >= 0 && gap[1] <= 250, `resp: once the first member is written, progress moves at least every 250 ms (${gap[0]} updates, the longest gap ${gap[1]} ms; the wait before the first member ${gap[4]} ms)`);
      check(diag.writes > 10 && diag.writeGap[0] <= 250, `resp: the progress line is written at least every 250 ms throughout (${diag.writes} writes, the longest gap ${diag.writeGap[0]} ms)`);
      check(c.errors.length === 0, "resp: no page errors: " + c.errors.slice(0, 3).join(" | "));
    } finally { await c.close(); }
  }
  // ---- cancel: in a fresh context, an export cancelled when about half the members are written: the click to the
  // "cancelled" line, timed in the page
  if (PASSES.has("cancel")) {
    const c = await open();
    try {
      await prepare(c);
      await c.ev(hooks(0).replace(`beforePreflight: () => stop("baseline")`, `beforePreflight: undefined`));
      await c.ev(`(() => { window.__cancelledAt = 0; new MutationObserver(() => { const t = document.querySelector(".sbfprev")?.textContent ?? ""; if (/The export was cancelled/.test(t) && !window.__cancelledAt) window.__cancelledAt = performance.now(); }).observe(document.body, { subtree: true, childList: true, characterData: true }); return 1; })()`);
      await c.ev(btn("/^Export all current files/"));
      if (!(await c.until(`[...(${P}?.querySelectorAll("button") ?? [])].some((b) => b.textContent === "Save…")`, 600000))) throw new Error("cancel: no Save…; the panel: " + (await c.ev(`${P}?.textContent ?? ""`)).slice(-300));
      await c.ev(btn("/^Save…$/"));
      await c.until(`(() => { const m = /([0-9,]+) of ([0-9,]+) files/.exec(document.querySelector(".sbfprev")?.textContent ?? ""); return !!m && +m[1].replace(/,/g, "") > +m[2].replace(/,/g, "") / 2; })()`, 600000);
      const clicked = await c.ev(`(() => { const t = performance.now(); [...document.querySelectorAll(".sbfprev button")].find((b) => b.textContent === "Cancel").click(); return t; })()`);
      await c.until(`window.__cancelledAt > 0`, 10000);
      const took = (await c.ev(`window.__cancelledAt`)) - clicked;
      check(took > 0 && took <= 250 && !(await c.ev(`!!window.__exp`)), `cancel: Cancel half-way stops the export within 250 ms (${Math.round(took)} ms, timed in the page), nothing handed over`);
      check(c.errors.length === 0, "cancel: no page errors: " + c.errors.slice(0, 3).join(" | "));
    } finally { await c.close(); }
  }
} catch (e) {
  fails.push("threw: " + (e?.stack ?? e));
} finally {
  rmSync(out, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
console.log(`${checks - fails.length}/${checks} passed`);
for (const f of fails) console.log("FAIL " + f);
process.exit(fails.length ? 1 : 0);
