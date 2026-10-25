// [prototype, do not merge] Kedlaya WebKit follow-up A, prototype 2
// (plan-kedlaya-webkit-ci r3, cleared by both for this prototype): the
// accounting of r3 section 2 and the r3 reviews' probes, run on the pinned
// Playwright's WebKit through the Sagebrush worker's inspector target.
// Records everything (web/proto2/kd-heap-experiments.mjs), the checkpoint
// pause protocol (sequence token, paused-stack proof, handshake, late-pause
// negative control, resume in finally), and daybreak2's measurements:
// every snapshot's phase, bytes and capture/parse/graph time, the whole
// process tree's peak memory (sampled every 250 ms), the test process's
// memory after each phase, and the total duration.
//   node --expose-gc web/test-webkit-heap-prototype2.mjs PLAYWRIGHT_DIR OUT.json [full]
import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { experiments } from "./proto2/kd-heap-experiments.mjs";
import { parse, findRoot, measure } from "./proto2/kd-heap-accounting.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const [pwDir, outPath, scale] = process.argv.slice(2);
const full = scale === "full";
const T0 = Date.now();
const report = { pinned: null, full, phases: [], memory: { samples: 0, peakTreeKiB: 0, peakByPhase: {} }, checkpoints: null, lateControl: null };

// the whole process tree's resident memory (this process and every
// descendant: Playwright's server and WebKit's processes)
let phase = "setup";
const treeKiB = () => {
  const kids = new Map();
  const rss = new Map();
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = readFileSync(`/proc/${d}/stat`, "utf8");
      const ppid = Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[1]);
      (kids.get(ppid) ?? kids.set(ppid, []).get(ppid)).push(Number(d));
      const m = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${d}/status`, "utf8"));
      rss.set(Number(d), m ? Number(m[1]) : 0);
    } catch {}
  }
  let sum = 0;
  const stack = [process.pid];
  while (stack.length) {
    const p = stack.pop();
    sum += rss.get(p) ?? 0;
    for (const c of kids.get(p) ?? []) stack.push(c);
  }
  return sum;
};
const sampler = setInterval(() => {
  const k = treeKiB();
  report.memory.samples++;
  report.memory.peakTreeKiB = Math.max(report.memory.peakTreeKiB, k);
  report.memory.peakByPhase[phase] = Math.max(report.memory.peakByPhase[phase] ?? 0, k);
}, 250);
const setPhase = (p) => {
  globalThis.gc?.();
  report.phases.push({ phase: p, atMs: Date.now() - T0, testProcessRssKiB: Math.round(process.memoryUsage().rss / 1024), testHeapUsedKiB: Math.round(process.memoryUsage().heapUsed / 1024) });
  phase = p;
};

const req = createRequire(join(pwDir, "node_modules", "x.js"));
const coreDir = dirname(req.resolve("playwright-core/package.json"));
report.pinned = JSON.parse(readFileSync(join(coreDir, "package.json"), "utf8")).version;
const { WKWorkers } = req(join(coreDir, "lib/server/webkit/wkWorkers.js"));
const workersObjects = [];
const realSet = WKWorkers.prototype.setSession;
WKWorkers.prototype.setSession = function (session) {
  if (!workersObjects.includes(this)) workersObjects.push(this);
  return realSet.call(this, session);
};
const { webkit } = req("playwright");

const types = { ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".html": "text/html" };
const iso = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
const server = createServer((r, res) => {
  const url = new URL(r.url, "http://x");
  if (url.pathname === "/test.html") return res.writeHead(200, { "Content-Type": "text/html", ...iso }).end("<!doctype html><title>proto2</title>");
  let p = normalize(join(dist, url.pathname));
  if (p.startsWith(dist) && existsSync(p) && statSync(p).isDirectory()) p = join(p, "index.html");
  if (!p.startsWith(dist) || !existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": types[extname(p)] ?? "application/octet-stream", ...iso }).end(readFileSync(p));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await webkit.launch();
const transcript = [];
try {
  report.browserVersion = browser.version();
  const page = await browser.newPage();
  let onCheckpoint = null;
  await page.exposeBinding("kdCheckpoint", (_src, token, point) => onCheckpoint && onCheckpoint(token, point));
  await page.goto(base + "test.html");
  report.userAgent = await page.evaluate(() => navigator.userAgent);
  await page.evaluate(() => new Promise((resolve) => {
    const w = new Worker("/sagebrush-worker.js", { type: "module" });
    let id = 10;
    const pending = new Map();
    w.onmessage = (e) => {
      const m = e.data;
      if (m.ready) resolve();
      const p = pending.get(m.id);
      if (p && m.stream) {
        p.out += m.text;
        for (const line of m.text.split("\n")) {
          const k = /^KD-CK (\d+) (\S+)/.exec(line);
          if (k) window.kdCheckpoint(Number(k[1]), k[2]);
        }
      }
      if (p && m.done) (pending.delete(m.id), p.resolve({ out: p.out, error: !!m.error }));
    };
    window.run = (code) => new Promise((res) => { const i = ++id; pending.set(i, { out: "", resolve: res }); w.postMessage({ id: i, code }); });
    w.postMessage({ init: { limits: null } });
  }));
  const sessions = workersObjects.flatMap((w) => [...w._workerSessions.values()]);
  if (sessions.length !== 1) throw new Error(`${sessions.length} worker sessions`);
  const ws = sessions[0];
  const send = async (method, params) => {
    const t = Date.now();
    try {
      const r = await ws.send(method, params);
      transcript.push({ method, params: params ?? null, ms: Date.now() - t, reply: method === "Heap.snapshot" ? { snapshotDataBytes: r.snapshotData.length } : r });
      return r;
    } catch (e) {
      transcript.push({ method, params: params ?? null, ms: Date.now() - t, error: String(e?.message ?? e) });
      throw e;
    }
  };
  await send("Heap.enable");
  const run = async (code) => {
    const r = await page.evaluate((c) => run(c), code);
    if (r.error) throw new Error("python: " + r.out.trim().split("\n").slice(-2).join(" | "));
    return r.out;
  };
  const snapshot = async () => {
    await send("Heap.gc");
    return (await send("Heap.snapshot")).snapshotData;
  };

  // 1. the experiments of r3 section 2 and the probes
  setPhase("experiments");
  report.experiments = await experiments({ run, snapshot, phase: setPhase }, { top: full ? 14 : 8, intTop: full ? 32 : 4 });

  // 2. the checkpoint pause protocol, on PR 147's Kedlaya code (vendored)
  setPhase("checkpoints");
  const src = readFileSync(join(here, "proto2", "kd147_sage_padic_lseries.py"), "utf8");
  await run(`import os, sys\nos.makedirs('/tmp/kd147', exist_ok=True)\nopen('/tmp/kd147/kd147.py', 'w').write(${JSON.stringify(src)})\nsys.path.insert(0, '/tmp/kd147')\nimport kd147\nprint('ok')`);
  const ledger = JSON.parse(await run([
    "import json, kd147 as L",
    "from fractions import Fraction as F",
    "p, N = 101, 3",
    "K, W = L._kd_plan_fast(p, N)",
    "Qc = [F(-23, 4), F(3), F(3), F(1)]",
    "ph = L._kd_phases(p, K, W, p, max(max(abs(c.numerator).bit_length(), c.denominator.bit_length()) for c in Qc), L._KdJSC)",
    "print(json.dumps({'K': K, 'W': W, 'terms': {k: dict(v) for k, v in ph.items()}, 'M': L._kd_frobenius_matrix(Qc, p, N)}))",
  ].join("\n")));
  report.ledger = ledger;
  const cks = [];
  await send("Debugger.enable");
  const pausedEvents = [];
  ws.on("Debugger.paused", (ev) => pausedEvents.push(ev));
  const waitPaused = (ms) => new Promise((res) => {
    const t = Date.now();
    const poll = () => (pausedEvents.length ? res(pausedEvents.shift()) : Date.now() - t > ms ? res(null) : setTimeout(poll, 5));
    poll();
  });
  await run("import sys\nfor k in [k for k in vars(sys) if k.startswith('_kd_') and k != '_kd_ck']:\n    setattr(sys, k, None)\nprint('cleared')");
  const s0 = parse(await snapshot());
  onCheckpoint = async (token, point) => {
    const rec = { token, point, paused: false, hookFrame: null, tokenSeen: null, released: false, measured: null, error: null };
    cks.push(rec);
    try {
      await send("Debugger.pause");
      const ev = await waitPaused(10000);
      rec.paused = !!ev;
      if (!ev) return;
      rec.frames = ev.callFrames.slice(0, 8).map((f) => f.functionName);
      const frame = ev.callFrames.find((f) => /hook/.test(f.functionName));
      rec.hookFrame = frame ? frame.functionName : null;
      if (!frame) return;
      const tk = await send("Debugger.evaluateOnCallFrame", { callFrameId: frame.callFrameId, expression: "token", returnByValue: true });
      rec.tokenSeen = tk?.result?.value ?? null;
      if (rec.tokenSeen !== token) return;
      const t = Date.now();
      const g = parse((await send("Heap.snapshot")).snapshotData);
      rec.snapshotMs = Date.now() - t;
      rec.measured = {};
      for (const [name, len] of Object.entries({ digits: 9001, B: 9007, cur: 9011, nxt: 9013, forms: 9029, G: 9041, rel: 9043 })) {
        try {
          rec.measured[name] = measure(g, s0, findRoot(g, s0, len)).bytes;
        } catch {}
      }
      const rel = await send("Debugger.evaluateOnCallFrame", { callFrameId: frame.callFrameId, expression: `released = ${token}`, returnByValue: true });
      rec.released = rel?.result?.value === token;
    } catch (e) {
      rec.error = String(e?.message ?? e);
    } finally {
      try {
        await send("Debugger.resume");
      } catch (e) {
        rec.resumeError = String(e?.message ?? e);
      }
    }
  };
  const res = await run([
    "import sys, time, json, kd147 as L",
    "from fractions import Fraction as F",
    "want = ['digits', 'series', 'forms', 'exact']",
    "seq = [0]",
    "results = []",
    "pads = {'digits': 9001, 'B': 9007, 'cur': 9011, 'nxt': 9013, 'forms': 9029, 'G': 9041, 'rel': 9043}",
    "def kd_checkpoint_hook(point, v):",
    "    if point not in want:",
    "        return",
    "    want.remove(point)",
    "    seq[0] += 1",
    "    token = seq[0]",
    "    released = 0",
    "    sys._kd_ck = [[v[k]] + [None] * (pads[k] - 1) for k in pads if k in v]",
    "    print('KD-CK %d %s' % (token, point), flush=True)",
    "    t0 = time.time()",
    "    while released != token and time.time() - t0 < 30:",
    "        time.sleep(0.001)",
    "    results.append([token, point, released == token, round(time.time() - t0, 3)])",
    "    sys._kd_ck = None",
    "L._kd_hook = kd_checkpoint_hook",
    "try:",
    "    M = L._kd_frobenius_matrix([F(-23, 4), F(3), F(3), F(1)], 101, 3)",
    "finally:",
    "    L._kd_hook = None",
    "print('KD-RESULT ' + json.dumps({'results': results, 'M': M}))",
  ].join("\n"));
  const m = /KD-RESULT (.*)/.exec(res);
  report.checkpoints = { records: cks, python: m ? JSON.parse(m[1]) : null, sameMatrix: m ? JSON.stringify(JSON.parse(m[1]).M) === JSON.stringify(ledger.M) : false };
  // the late-pause negative control: with the call over (the worker idle),
  // a pause finds no hook frame (or no pause at all)
  onCheckpoint = null;
  try {
    await send("Debugger.pause");
    const ev = await waitPaused(3000);
    report.lateControl = { paused: !!ev, frames: ev ? ev.callFrames.slice(0, 8).map((f) => f.functionName) : [], hookFrame: ev ? ev.callFrames.some((f) => /hook/.test(f.functionName)) : false };
  } finally {
    try { await send("Debugger.resume"); } catch {}
  }
  setPhase("done");
} catch (e) {
  report.error = String(e?.stack ?? e).slice(0, 3000);
} finally {
  clearInterval(sampler);
  report.totalMs = Date.now() - T0;
  report.transcript = transcript.length > 400 ? [...transcript.slice(0, 200), { elided: transcript.length - 400 }, ...transcript.slice(-200)] : transcript;
  report.transcriptCounts = transcript.reduce((a, t) => ((a[t.method] = (a[t.method] ?? 0) + 1), a), {});
  await browser.close();
  server.close();
  writeFileSync(outPath, JSON.stringify(report, null, 1));
  const e = report.experiments;
  console.log(JSON.stringify({ error: report.error ?? null, failed: e ? e.conditions.filter((c) => !c.ok).map((c) => c.name) : null, snapshots: e?.snapshots.length, checkpoints: report.checkpoints?.records?.map((r) => [r.token, r.point, r.paused, r.hookFrame, r.tokenSeen, r.released]), late: report.lateControl, totalMs: report.totalMs, peakTreeKiB: report.memory.peakTreeKiB }));
}
