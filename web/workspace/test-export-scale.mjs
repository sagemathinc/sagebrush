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
//   resp  (1 context)  responsiveness, no forced collections: first the long-task observer's own check (grader's C8: a
//                      120 ms busy loop must show in it), then the longest main-thread task from the click at most 50 ms,
//                      and the progress line rewritten at least every 250 ms, its text changed or not (@sagebrush's
//                      ruling of Oct 31); how long its numbers stand still is printed, a diagnostic.
//   cancel (1 context) an export cancelled half-way: the "cancelled" line within 250 ms of the click (timed in the page).
// Serve web/dist first (python3 web/serve.py 8765), then
//   N=100000 node web/workspace/test-export-scale.mjs
// In CI (grader's Q10): node web/workspace/test-export-scale.mjs --ci: N = 70,000 (past Zip64's 65,535 members), the live
// pass only, its archive read by zipfile AND unzip -t; the timing and peak passes stay local.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";
import { judgeRun, majorGcs, maxGap, PROGRESS_OBSERVER } from "./export-campaign-check.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const CI = process.argv.includes("--ci");
const N = Number(process.env.N ?? (CI ? 70000 : 100000));
const MiB = 2 ** 20;
// (the alloc pass: an unminified build of the chunk and the worker, served in place of the built ones, so that the
// heap profile names their functions)
const chunk = process.env.CHUNK ? readFileSync(process.env.CHUNK) : null, chunkWorker = process.env.CHUNK_WORKER ? readFileSync(process.env.CHUNK_WORKER) : null;
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
    if (/^Tracing\./.test(m.method ?? "")) self.onTrace?.(m);
    // (paused at the response, its headers kept: a worker's script needs the page's Cross-Origin-Embedder-Policy)
    if (m.method === "Fetch.requestPaused") {
      const body = /sagebrush-export-worker\.js/.test(m.params.request.url) ? chunkWorker : chunk;
      const headers = (m.params.responseHeaders ?? []).filter((h) => !/^(content-length|content-encoding|etag|last-modified)$/i.test(h.name));
      if (body) send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200, responseHeaders: headers, body: body.toString("base64") });
      else send("Fetch.continueRequest", { requestId: m.params.requestId });
    }
  };
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
  const until = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  if (chunk || chunkWorker) await send("Fetch.enable", { patterns: [{ urlPattern: "*sagebrush-export*.js*", requestStage: "Response" }] });
  const close = async () => { ws.close(); chrome.kill(); await sleep(1000); rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); };
  const self = { send, ev, until, errors, worker: () => worker, close, onTrace: null };
  return self;
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
  window.__SB_EXPORT_TEST__ = { noPicker: true, onHand: (blob, name, then) => { window.__exp = { blob, name, then }; }, stats: {},
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
  const r = spawnSync("python3", ["-I", "-c", "import sys, zipfile, json; z = zipfile.ZipFile(sys.argv[1]); bad = z.testzip(); n = z.namelist(); m = json.loads(z.read('manifest.json')); print(json.dumps({'bad': bad, 'members': len(n), 'last': n[-1], 'entries': len(m['entries'])}))", file], { encoding: "utf8" });
  const u = spawnSync("unzip", ["-tq", file], { encoding: "utf8" });
  return { size, unzip: u.status, ...(r.status === 0 ? JSON.parse(r.stdout) : { error: r.stderr.slice(0, 300) }) };
}

const out = mkdtempSync(join(tmpdir(), "sb-export-scale-out-"));
const PASSES = new Set((process.env.PASSES ?? (CI ? "live" : "live,peak,resp,cancel")).split(","));
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
        // (the handoff's cleanup let run once the archive is read)
        await c.ev(`(() => { window.__exp.then?.(); return 1; })()`);
        check(!z.error && z.bad === null && z.members === N + 2 && z.last === "manifest.json" && z.entries === N + 1, "live: zipfile reads the archive, every member, manifest last: " + JSON.stringify(z));
        check(z.unzip === 0, "live: unzip -t accepts it (" + (N + 2) + " members, past Zip64's 65,535): exit " + z.unzip);
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
        window.__tasks = [];
        new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__long = Math.max(window.__long, e.duration); window.__tasks.push([Math.round(e.startTime), Math.round(e.duration), (e.attribution ?? []).map((a) => a.containerType + ":" + (a.containerSrc || a.name)).join(",")]); } }).observe({ type: "longtask", buffered: false });
        new MutationObserver(() => { const t = document.querySelector(".sbfprev")?.textContent ?? ""; const m = / written/.test(t); if (m) (window.__raw ??= []).push(performance.now()); if (m && t !== window.__lastText) { window.__lastText = t; window.__marks.push(performance.now()); (window.__texts ??= []).push(t.match(/[^.]*written/)?.[0] ?? ""); } if (/The export was cancelled/.test(t) && !window.__cancelledAt) window.__cancelledAt = performance.now(); }).observe(document.body, { subtree: true, childList: true, characterData: true });
        return 1;
      })()`);
      // (grader's C8: the instrument's own check, in this context, before any of its figures counts; the busy loop a task
      // of the page's own (a timer): one run from DevTools' evaluate isn't a page task, and isn't reported)
      const c8 = await c.ev(`new Promise((ok) => { setTimeout(() => { const t = performance.now(); while (performance.now() - t < 120) {} }, 0); setTimeout(() => { const l = window.__long; window.__long = 0; ok(l); }, 400); })`);
      check(c8 >= 100, `resp: C8, a 120 ms busy loop shows in the long-task observer (${Math.round(c8)} ms)`);
      await c.ev(`(() => { window.__tasks = []; window.__clickT = performance.now(); return 1; })()`);
      await c.ev(btn("/^Export all current files/"));
      await c.until(`[...(${P}?.querySelectorAll("button") ?? [])].some((b) => b.textContent === "Save…")`, 600000);
      await c.ev(`(() => { window.__saveT = performance.now(); return 1; })()`);
      await c.ev(btn("/^Save…$/"));
      check(await c.until(`!!window.__exp`, 1200000), "resp: the export ends");
      await c.ev(`(() => { window.__endT = performance.now(); return 1; })()`);
      await sleep(1500);
      // (each long task: when, relative to the click, Save… and the archive handed over; diagnostics)
      console.log("(resp long tasks [start, ms, attribution] with click/save/end at " + JSON.stringify(await c.ev(`[Math.round(window.__clickT), Math.round(window.__saveT), Math.round(window.__endT)]`)) + ": " + JSON.stringify(await c.ev(`window.__tasks`)) + ")");
      const longest = await c.ev(`window.__long`);
      check(c8 >= 100 && longest <= 50, `resp: the longest main-thread task from the click ${Math.round(longest)} ms (at most 50 ms; counts only with C8 passing)`);
      // (the values must move at least every 250 ms once the first member is written: before it, nothing moves (the
      // first reads, the workspace's lock), and that wait is reported, not bounded; throughout, the line itself must be
      // written at least every 250 ms, its text unchanged or not, so the page never looks stopped)
      const gap = await c.ev(`(() => { const m = window.__marks, x = window.__texts; let k = x.findIndex((t) => !/^\\D*0 of /.test(t)); if (k < 0) k = m.length; let g = 0, at = k; for (let i = k + 1; i < m.length; i++) if (m[i] - m[i - 1] > g) { g = m[i] - m[i - 1]; at = i; } return [m.length, Math.round(g), x[at - 1], x[at], k > 0 && k < m.length ? Math.round(m[k] - m[0]) : -1]; })()`);
      console.log("(the longest progress gap: between " + JSON.stringify(gap[2]) + " and " + JSON.stringify(gap[3]) + ")");
      // (diagnostics, information only: the longest gap between any two writes of the progress line, the same text
      // included, and the longest gap of a 20 ms page heartbeat between the first and the last progress change)
      const diag = await c.ev(`(() => { clearInterval(window.__hbt); const gapOf = (m) => { let g = 0, at = 0; for (let i = 1; i < m.length; i++) if (m[i] - m[i - 1] > g) { g = m[i] - m[i - 1]; at = m[i - 1]; } return [Math.round(g), Math.round(at)]; }; const a = window.__marks[0], b = window.__marks[window.__marks.length - 1]; return { writes: (window.__raw ?? []).length, writeGap: gapOf(window.__raw ?? []), heartbeatGap: gapOf(window.__hb.filter((t) => t >= a && t <= b)), changes: [Math.round(a), Math.round(b)] }; })()`);
      console.log("(progress diagnostics: " + JSON.stringify(diag) + ")");
      // (the ruling: the line rewritten at least every 250 ms is the check; how long its numbers stood still, a diagnostic)
      console.log(`(diagnostic: the numbers' longest stand-still after the first member ${gap[1]} ms over ${gap[0]} changes; the wait before the first member ${gap[4]} ms; the heartbeat's longest gap ${diag.heartbeatGap[0]} ms)`);
      check(diag.writes > 10 && diag.writeGap[0] <= 250, `resp: the progress line is rewritten at least every 250 ms throughout (${diag.writes} writes, the longest gap ${diag.writeGap[0]} ms)`);
      check(c.errors.length === 0, "resp: no page errors: " + c.errors.slice(0, 3).join(" | "));
    } finally { await c.close(); }
  }
  // ---- observer (r2, daybreak2's R3): the frozen progress observer in a page of its own making: a progress line in a
  // .sbfprev, rewritten at 0, 100, 200, then 600 and 700 ms (a 400 ms stall), while other nodes (a sibling in the panel,
  // a span outside it, the line's own panel's other <p>) change every 30 ms throughout.  The observer must count exactly
  // the five rewrites and see the stall; the old body-wide way of counting sees none.  A second series rewrites the
  // line every 100 ms: no gap over 250 ms.  (The exact 250/251 bound is the parser's fixture.)
  if (PASSES.has("observer")) {
    const c = await open();
    try {
      // (each series its own sink: an earlier series' observer is still attached to the body)
      const run = (times, sink) => c.ev(`new Promise((ok) => {
        document.body.innerHTML = '<div class="sbfprev"><p class="note" id="line"></p><p class="note" id="other">x</p><span id="sib">0</span></div><span id="out">0</span>';
        const line = document.getElementById("line"), other = document.getElementById("other"), sib = document.getElementById("sib"), out = document.getElementById("out");
        const raw = [], body = [];
        window[${JSON.stringify(sink)}] = raw;
        ${PROGRESS_OBSERVER(`window[${JSON.stringify(sink)}]`)};
        new MutationObserver(() => { if (/ written/.test(document.querySelector(".sbfprev").textContent)) body.push(performance.now()); }).observe(document.body, { subtree: true, childList: true, characterData: true });
        let n = 0; const noise = setInterval(() => { n++; sib.textContent = String(n); out.textContent = String(n); other.textContent = "x " + n + " written"; }, 30);
        const t0 = performance.now();
        for (const [i, t] of ${JSON.stringify(times)}.entries()) setTimeout(() => { line.textContent = (i + 1) * 10 + " of 100 files and folders · " + (i + 1) + " KB written"; }, t);
        setTimeout(() => { clearInterval(noise); let g = 0, bg = 0; for (let i = 1; i < raw.length; i++) g = Math.max(g, raw[i] - raw[i - 1]); for (let i = 1; i < body.length; i++) bg = Math.max(bg, body[i] - body[i - 1]); ok({ writes: raw.length, gap: Math.round(g), noise: n, bodyGap: Math.round(bg), bodyCount: body.length }); }, ${Math.max(...times)} + 150);
      })`);
      const a = await run([0, 100, 200, 600, 700], "__obsA");
      check(a.writes === 5 && a.noise >= 20 && a.gap >= 390 && a.gap <= 420, "observer: five line rewrites among " + a.noise + " unrelated mutations each 30 ms: exactly 5 counted, the 400 ms stall seen (" + a.gap + " ms; the body-wide count saw " + a.bodyCount + " with a longest gap of " + a.bodyGap + " ms)");
      check(a.bodyGap < 100, "observer: the body-wide way of counting would have hidden the stall (" + a.bodyGap + " ms), which is why it isn't used");
      const b = await run([0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100], "__obsB");
      check(b.writes === 12 && b.gap <= 150, "observer: a line rewritten every 100 ms among unrelated mutations: " + b.writes + " counted (12 made), no gap over 250 ms (" + b.gap + " ms)");
    } finally { await c.close(); }
  }

  // ---- capid (E1 r2a, daybreak2's and grader's buffering controls): the capture log at N entries, as the tree check's
  // lookup reads it after its settle, byte for byte the log an unbuffered writer makes: a reference built in the page
  // from the raw IndexedDB rows, in their key (path) order, Trash and the root left out.  A file written after its
  // capture makes an accepted write, so the lookup runs and reads the whole log.
  if (PASSES.has("capid")) {
    const c = await open();
    try {
      await prepare(c);
      await c.ev(`window.sagebrush.workspace.create("/zz-capid.csv", { content: "a\\n" }).then(() => 1)`);
      await c.ev(hooks(0).replace(`beforePreflight: () => stop("baseline")`, `beforePreflight: undefined, afterCapture: async (p) => { if (p === "/zz-capid.csv") await window.sagebrush.workspace.write(p, "b\\n"); }, onLookup: (x) => { window.__lookupAt = x; }, captureChunk: (ch) => { (window.__cap ??= []).push(ch.slice()); }`));
      await c.ev(btn("/^Export all current files/"));
      await c.until(`[...(${P}?.querySelectorAll("button") ?? [])].some((b) => b.textContent === "Save…")`, 600000);
      await c.ev(btn("/^Save…$/"));
      const ended = await c.until(`!!window.__exp`, 1200000);
      const r = await c.ev(`(async () => {
        const hex = async (blob) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))].map((b) => b.toString(16).padStart(2, "0")).join("");
        const rows = await new Promise((ok, no) => { const q = indexedDB.open("sagebrush-workspace"); q.onsuccess = () => { const d = q.result, g = d.transaction("entries").objectStore("entries").getAll(); g.onsuccess = () => { d.close(); ok(g.result); }; g.onerror = () => no(g.error); }; q.onerror = () => no(q.error); });
        const lines = rows.filter((e) => e.path !== "/" && e.path !== "/Trash" && !e.path.startsWith("/Trash/")).map((e) => JSON.stringify([e.path, e.kind, e.ident ?? null]) + "\\n");
        const ref = new Blob(lines), got = new Blob(window.__cap ?? []);
        return { lines: lines.length, refBytes: ref.size, gotBytes: got.size, ref: await hex(ref), got: await hex(got), at: window.__lookupAt ?? null };
      })()`);
      check(ended, "capid: the export ends");
      check(r.at && r.at.chunks >= 1 && r.lines >= N, "capid: the lookup ran with the log past its first flush: " + JSON.stringify(r.at) + ", " + r.lines + " lines");
      check(r.got === r.ref && r.gotBytes === r.refBytes, `capid: the capture log as the lookup read it is byte for byte the unbuffered reference (${r.gotBytes} bytes, sha256 ${r.got.slice(0, 16)} / ${r.ref.slice(0, 16)})`);
    } finally { await c.close(); }
  }

  // ---- alloc (E1 r2a, the transient-heap follow-up: what the ~170 MiB high-water is made of; information only): V8's
  // sampling heap profiler over one export, on the page and on the worker, keeping the samples of objects that either
  // collector has freed, so the profile is what was allocated, not what is live.  Run with CHUNK and CHUNK_WORKER set to
  // unminified builds, so the export's own functions are named; the page's bundle stays minified, its allocations
  // reported by script.
  if (PASSES.has("alloc")) {
    const c = await open();
    try {
      await prepare(c);
      await c.ev(hooks(0).replace(`beforePreflight: () => stop("baseline")`, `beforePreflight: () => stop("baseline")`));
      const opts = { samplingInterval: 8192, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true };
      await c.ev(btn("/^Export all current files/"));
      await at(c, "baseline", 60000);
      const w = c.worker();
      await c.send("HeapProfiler.enable"); await c.send("HeapProfiler.startSampling", opts);
      if (w) { await c.send("HeapProfiler.enable", {}, w); await c.send("HeapProfiler.startSampling", opts, w); }
      const marks = [Date.now()];
      await go(c);
      await c.until(`[...(${P}?.querySelectorAll("button") ?? [])].some((b) => b.textContent === "Save…")`, 600000);
      marks.push(Date.now());
      await c.ev(btn("/^Save…$/"));
      const ended = await c.until(`!!window.__exp`, 1200000);
      marks.push(Date.now());
      const main = (await c.send("HeapProfiler.stopSampling")).profile;
      const wk = w ? (await c.send("HeapProfiler.stopSampling", {}, w))?.profile : null;
      check(ended, "alloc: the export ends");
      // (self sizes summed by function and script: each sample's selfSize is the bytes sampled at that frame)
      const sum = (profile, who) => {
        const by = new Map(); let total = 0;
        const walk = (n) => { const f = n.callFrame, src = (f.url || "(native)").replace(/^.*\//, ""); const key = `${who} ${f.functionName || "(anonymous)"} ${src}:${f.lineNumber + 1}`; if (n.selfSize) { by.set(key, (by.get(key) ?? 0) + n.selfSize); total += n.selfSize; } for (const k of n.children ?? []) walk(k); };
        if (profile) walk(profile.head);
        return { by, total };
      };
      const m = sum(main, "page"), k = sum(wk, "worker");
      const byScript = new Map();
      for (const [key, v] of [...m.by, ...k.by]) { const sc = key.split(" ")[0] + " " + key.replace(/:\d+$/, "").split(" ").pop(); byScript.set(sc, (byScript.get(sc) ?? 0) + v); }
      console.log(`(alloc: sampled allocations over preflight ${((marks[1] - marks[0]) / 1000).toFixed(1)} s and writing ${((marks[2] - marks[1]) / 1000).toFixed(1)} s: page ${(m.total / MiB).toFixed(1)} MiB, worker ${(k.total / MiB).toFixed(1)} MiB)`);
      console.log("(alloc by script, MiB: " + JSON.stringify([...byScript].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([s, v]) => [s, +(v / MiB).toFixed(1)])) + ")");
      console.log("(alloc by function, top 25, MiB: " + JSON.stringify([...m.by, ...k.by].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([s, v]) => [s, +(v / MiB).toFixed(1)])) + ")");
    } finally { await c.close(); }
  }

  // ---- profile (E1 r2, @sagebrush's (c); the rules fixed before the run:
  // /scratch/sagebrush-reviews/e1-r2-profile-rules/RULES.md): each stall of the progress line's numbers over 250 ms after
  // the first member, classified by the heartbeat and the writing loop's waits (run.ts's probe).  Information only.
  if (PASSES.has("profile")) {
    const c = await open();
    try {
      await prepare(c);
      await c.ev(hooks(0).replace(`beforePreflight: () => stop("baseline")`, `beforePreflight: undefined, probe: (what, edge) => window.__probe.push([what, edge, performance.now()])`));
      await c.ev(`(() => {
        window.__probe = []; window.__long = 0; window.__marks = []; window.__texts = []; window.__hb = []; window.__hbt = setInterval(() => window.__hb.push(performance.now()), 10);
        new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long = Math.max(window.__long, e.duration); }).observe({ type: "longtask", buffered: false });
        new MutationObserver(() => { const t = document.querySelector(".sbfprev")?.textContent ?? ""; if (/ written/.test(t) && t !== window.__lastText) { window.__lastText = t; window.__marks.push(performance.now()); window.__texts.push(t.match(/[^.]*written/)?.[0] ?? ""); } }).observe(document.body, { subtree: true, childList: true, characterData: true });
        return 1;
      })()`);
      const c8 = await c.ev(`new Promise((ok) => { setTimeout(() => { const t = performance.now(); while (performance.now() - t < 120) {} }, 0); setTimeout(() => { const l = window.__long; window.__long = 0; ok(l); }, 400); })`);
      console.log(`(profile: C8, the long-task observer saw the 120 ms busy loop as ${Math.round(c8)} ms${c8 >= 100 ? "" : ": the run is void (RULES.md)"})`);
      await c.ev(btn("/^Export all current files/"));
      await c.until(`[...(${P}?.querySelectorAll("button") ?? [])].some((b) => b.textContent === "Save…")`, 600000);
      await c.ev(btn("/^Save…$/"));
      const ended = await c.until(`!!window.__exp`, 1200000);
      const r = await c.ev(`(() => {
        clearInterval(window.__hbt);
        const m = window.__marks, x = window.__texts, hb = window.__hb;
        const k = x.findIndex((t) => !/^\\D*0 of /.test(t));
        // (each probe kind's pending intervals)
        const open = {}, iv = { page: [], capture: [], member: [], spool: [] };
        for (const [w, e, t] of window.__probe) { if (e === 0) open[w] = t; else if (open[w] !== undefined) { iv[w].push([open[w], t]); delete open[w]; } }
        const cover = (list, a, b) => { let n = 0; for (const [s, e] of list) n += Math.max(0, Math.min(b, e) - Math.max(a, s)); return n; };
        const union = (a, b) => { const all = Object.values(iv).flat().map(([s, e]) => [Math.max(a, s), Math.min(b, e)]).filter(([s, e]) => e > s).sort((p, q) => p[0] - q[0]); let n = 0, cs = -1, ce = -1; for (const [s, e] of all) { if (s > ce) { if (ce > cs) n += ce - cs; cs = s; ce = e; } else ce = Math.max(ce, e); } if (ce > cs) n += ce - cs; return n; };
        const stalls = [];
        for (let i = Math.max(k + 1, 1); i < m.length; i++) {
          const a = m[i - 1], b = m[i], len = b - a;
          if (len <= 250) continue;
          let gap = 0, prev = null; for (const t of hb) { if (t < a || t > b) continue; if (prev !== null) gap = Math.max(gap, t - prev); prev = t; }
          const share = Object.fromEntries(Object.entries(iv).map(([w, l]) => [w, Math.round(100 * cover(l, a, b) / len)]));
          const all = Math.round(100 * union(a, b) / len);
          const top = Object.entries(share).sort((p, q) => q[1] - p[1])[0];
          const cls = gap > 100 ? "main thread busy" : top[1] >= 80 ? "one wait: " + top[0] : all >= 80 ? "mixed" : "unattributed";
          stalls.push({ at: Math.round(a), ms: Math.round(len), cls, share, all, heartbeat: Math.round(gap), from: x[i - 1], to: x[i] });
        }
        const by = {}; for (const s of stalls) by[s.cls] = (by[s.cls] ?? 0) + 1;
        return { stalls, by, longest: Math.max(0, ...stalls.map((s) => s.ms)), export_ms: Math.round(m[m.length - 1] - m[0]) };
      })()`);
      console.log("(profile: " + JSON.stringify({ ended, by: r.by, longest: r.longest, export_ms: r.export_ms, stalls: r.stalls.length }) + ")");
      for (const st of r.stalls) console.log("(profile stall: " + JSON.stringify(st) + ")");
    } finally { await c.close(); }
  }
  // ---- trace (the corrected campaign, daybreak2's ruling of Oct 31; rules e1-r2a-campaign2-rules): in a fresh context,
  // (1) C8: a 120 ms busy loop in a page timer must show in the Long Task API as at least 100 ms, or the run is void;
  // (2) the clock: performance.mark "sb-sync-1" before Save… and "sb-sync-2" after the handoff, each in the page's
  // clock (its startTime) and in the trace's (the blink.user_timing event's ts); the offset from sb-sync-1 must
  // predict sb-sync-2 within 1 ms, or the mapping is invalid; (3) each Long Task API entry over 50 ms from the click,
  // mapped into the trace's clock and classified by a closed grammar over the main thread's events overlapping it:
  //   "gc"           collections (MajorGC, MinorGC, V8.GC*, Scavenge) cover at least half of it;
  //   "export"       script of sagebrush-export.js (its FunctionCall/EvaluateScript/v8 call frames' url) at least half;
  //   "page"         script of any other file of the site at least half;
  //   "unattributed" none of these.
  if (PASSES.has("trace")) {
    const c = await open();
    try {
      await prepare(c);
      await c.ev(hooks(0).replace(`beforePreflight: () => stop("baseline")`, `beforePreflight: undefined`).replace(`window.__exp = { blob, name, then };`, `window.__expT = performance.now(); window.__exp = { blob, name, then };`));
      const events = [];
      // (campaign 3: the progress line's rewrites and a 20 ms heartbeat, in the page, as the resp pass measures them)
      // (r2, daybreak2's R3: the frozen observer, which counts only the progress line's own rewrites)
      await c.ev(`(() => { window.__raw = []; window.__hb = []; window.__hbt = setInterval(() => window.__hb.push(performance.now()), 20); ${PROGRESS_OBSERVER("window.__raw")}; return 1; })()`);
      await c.ev(`(() => { window.__tasks = []; window.__lto = new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__tasks.push([e.startTime, e.duration]); }); window.__lto.observe({ type: "longtask", buffered: false }); return 1; })()`);
      // (C8, in this context, from a page timer)
      const c8 = await c.ev(`new Promise((ok) => { setTimeout(() => { const t = performance.now(); while (performance.now() - t < 120) {} }, 0); setTimeout(() => { const l = Math.max(0, ...window.__tasks.map((x) => x[1])); window.__tasks = []; ok(l); }, 400); })`);
      const valid = c8 >= 100;
      console.log(`(trace: C8 ${Math.round(c8)} ms: the run is ${valid ? "valid" : "VOID"})`);
      // (the trace from before the click to after the handoff: preflight and writing both in it)
      const done = new Promise((r) => { c.onTrace = (m) => { if (m.method === "Tracing.dataCollected") events.push(...m.params.value); if (m.method === "Tracing.tracingComplete") r(); }; });
      await c.send("Tracing.start", { traceConfig: { includedCategories: ["devtools.timeline", "v8", "disabled-by-default-v8.gc", "blink.user_timing", "toplevel"] }, transferMode: "ReportEvents" });
      const m1 = await c.ev(`performance.mark("sb-sync-1").startTime`);
      const clickT = await c.ev(`performance.now()`);
      await c.ev(btn("/^Export all current files/"));
      await c.until(`[...(${P}?.querySelectorAll("button") ?? [])].some((b) => b.textContent === "Save…")`, 600000);
      await c.ev(btn("/^Save…$/"));
      const ended = await c.until(`!!window.__exp`, 1200000);
      await sleep(500);
      const m2 = await c.ev(`performance.mark("sb-sync-2").startTime`);
      await sleep(200);
      const tasks = await c.ev(`window.__tasks`);
      const page = await c.ev(`(() => { clearInterval(window.__hbt); const r = window.__raw, a = r[0], b = r[r.length - 1]; return { raw: r, hb: window.__hb.filter((t) => t >= a && t <= b), endT: window.__expT ?? null }; })()`);
      await c.send("Tracing.end");
      await done;
      const mark = (name) => events.find((e) => e.name === name && /user_timing/.test(e.cat ?? ""));
      const t1 = mark("sb-sync-1"), t2 = mark("sb-sync-2");
      const offset = t1 ? t1.ts / 1000 - m1 : NaN, err = t2 ? Math.abs(t2.ts / 1000 - (m2 + offset)) : NaN;
      const mapped = Number.isFinite(err) && err <= 1;
      console.log(`(trace: the clock mapping: sb-sync-1 ${t1 ? "found" : "MISSING"}, sb-sync-2 predicted within ${Number.isFinite(err) ? err.toFixed(3) : "—"} ms: ${mapped ? "valid" : "INVALID"})`);
      const main = events.find((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain");
      const onMain = events.filter((e) => e.ph === "X" && main && e.pid === main.pid && e.tid === main.tid);
      const isGc = (e) => /^(MajorGC|MinorGC|Scavenge|V8\.GC)/.test(e.name);
      const urlOf = (e) => e.args?.data?.url ?? e.args?.data?.stackTrace?.[0]?.url ?? e.args?.beginData?.url ?? "";
      const isScript = (e) => /^(FunctionCall|EvaluateScript|v8\.callFunction|v8\.compile|TimerFire|EventDispatch|RunMicrotasks)$/.test(e.name);
      const cover = (list, a, b) => { const iv = list.map((e) => [Math.max(a, e.ts), Math.min(b, e.ts + e.dur)]).filter(([x, y]) => y > x).sort((p, q) => p[0] - q[0]); let n = 0, cs = -1, ce = -1; for (const [x, y] of iv) { if (x > ce) { if (ce > cs) n += ce - cs; cs = x; ce = y; } else ce = Math.max(ce, y); } if (ce > cs) n += ce - cs; return n; };
      const out = [];
      for (const [st, d] of tasks) {
        if (d <= 50 || st < clickT) continue;
        const a = (st + offset) * 1000, b = a + d * 1000, len = b - a;
        const over = onMain.filter((e) => e.ts < b && e.ts + e.dur > a);
        const gc = cover(over.filter(isGc), a, b) / len;
        const exp = cover(over.filter((e) => isScript(e) && /sagebrush-export(-worker)?\.js/.test(urlOf(e))), a, b) / len;
        const page = cover(over.filter((e) => isScript(e) && urlOf(e) && !/sagebrush-export(-worker)?\.js/.test(urlOf(e))), a, b) / len;
        const cls = !mapped ? "unmapped" : gc >= 0.5 ? "gc" : exp >= 0.5 ? "export" : page >= 0.5 ? "page" : "unattributed";
        out.push({ start: Math.round(st), ms: Math.round(d), class: cls, gc: +gc.toFixed(2), export: +exp.toFixed(2), page: +page.toFixed(2), top: over.sort((x, y) => y.dur - x.dur).slice(0, 6).map((e) => [e.name, Math.round(e.dur / 1000), urlOf(e).slice(-40)]) });
      }
      console.log("(trace: run result " + JSON.stringify({ valid, mapped, ended, c8: Math.round(c8), longTasks: out.map((t) => [t.ms, t.class]) }) + ")");
      for (const t of out) console.log("(trace: long task " + JSON.stringify(t) + ")");
      const gcs = onMain.filter((e) => /^MajorGC$/.test(e.name) && e.dur > 20000).map((e) => Math.round(e.dur / 1000));
      console.log("(trace: main-thread MajorGC over 20 ms during the trace: " + JSON.stringify(gcs) + ")");
      // (campaign 3, the frozen parser and gate: MajorGC on the main thread from the click to the handoff, whether or
      // not inside a task; the progress line's longest rewrite gap; the heartbeat's, reported only)
      const win = [(clickT + offset) * 1000, ((page.endT ?? m2) + offset) * 1000];
      // (r2, daybreak2's R2: a measure that couldn't be taken is null, never 0: GC needs the mapped window and a main
      // thread; a gap needs two rewrites)
      const pg = maxGap(page.raw), hg = maxGap(page.hb);
      const record = { c8: Math.round(c8), mapped, ended, errored: c.errors.length > 0, longTasks: out.map((t) => ({ ms: t.ms, class: t.class })), majorGc: mapped ? majorGcs(events, win[0], win[1]) : null, progressGap: pg === null ? null : Math.round(pg), progressWrites: page.raw.length, heartbeatGap: hg === null ? null : Math.round(hg) };
      const j = judgeRun(record);
      console.log("(campaign: run record " + JSON.stringify({ ...record, majorGcOver20: (record.majorGc ?? []).filter((g) => g > 20).map((g) => Math.round(g)), verdict: { valid: j.valid, fix: j.fix, invalid: j.invalid, longNonExport: j.longNonExport } }) + ")");
      if (process.env.TRACE_OUT) { const f = join(process.env.TRACE_OUT, `trace-${Date.now()}.json`); writeFileSync(f, JSON.stringify({ window: win, run: record, events })); console.log("(campaign: the trace saved to " + f + ")"); }
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
