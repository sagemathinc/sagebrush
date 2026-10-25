// Kedlaya's Frobenius matrix in the browser worker (plan-kedlaya-optin r6;
// for WebKit, plan-kedlaya-webkit-ci r4): the worker's JavaScript engine and
// host, and Stop during four stages, sent by the page through the shared
// interrupt flag once the shared progress slots show the run's own call in
// that stage with done > 0, raising KeyboardInterrupt within 1 s, releasing
// the slot, and leaving the worker computing rightly.  The page is
// cross-origin isolated (COOP and COEP), as Stop needs.
//
//   Chromium (CDP):  bun web/build.ts && node web/test-kedlaya-worker.mjs
//   WebKit:          BROWSER=webkit PLAYWRIGHT=<dir with node_modules/playwright> node web/test-kedlaya-worker.mjs
//
// Chromium: V8 on a browser host, the V8 table, frobenius() computes.
// WebKit: JavaScriptCore on a browser host, whose table is established for
// Bun only, so the production path is refused, exactly, before the working
// modulus is made; that is tested first, in a clean worker, before any
// test-only override.  The Stop cases then run under the override
// _kd_engine = "jsc" (in their own fresh workers, so it reaches nothing
// else).  This job certifies nothing about memory: certification of the JSC
// table on WebKit is unavailable (plan-kedlaya-webkit-ci r4, section 0).
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "./test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const ENGINE = process.env.BROWSER ?? "chromium";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, msg) => {
  console.log((c ? "ok   " : "FAIL ") + msg);
  if (!c) process.exitCode = 1;
};

const types = { ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".html": "text/html" };
const isolated = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/test.html") return res.writeHead(200, { "Content-Type": "text/html", ...isolated }).end("<!doctype html><title>kedlaya</title>");
  let p = normalize(join(dist, url.pathname));
  if (p.startsWith(dist) && existsSync(p) && statSync(p).isDirectory()) p = join(p, "index.html");
  if (!p.startsWith(dist) || !existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": types[extname(p)] ?? "application/octet-stream", ...isolated }).end(readFileSync(p));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

// the browser: ev(expression) evaluates in the page and returns the value
let ev, close;
const profile = mkdtempSync(join(tmpdir(), "sb-kedlaya-browser-"));
if (ENGINE === "chromium") {
  const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, base + "test.html"], { stdio: "ignore" });
  const port = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      if (targets.some((t) => t.type === "page" && t.url.startsWith(base))) break;
    } catch {}
    await sleep(100);
  }
  const ws = new WebSocket((targets.find((t) => t.type === "page" && t.url.startsWith(base)) ?? targets.find((t) => t.type === "page")).webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) (waiting.get(m.id)(m.result ?? m.error), waiting.delete(m.id));
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  await send("Page.enable");
  await send("Page.navigate", { url: base + "test.html" });
  for (let i = 0; i < 100; i++) {
    const r = await send("Runtime.evaluate", { expression: "location.href", returnByValue: true });
    if (r.result?.value === base + "test.html") break;
    await sleep(100);
  }
  ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
    return r.result.value;
  };
  close = () => chrome.kill();
} else if (ENGINE === "webkit") {
  if (!process.env.PLAYWRIGHT) throw new Error("BROWSER=webkit needs PLAYWRIGHT=<a directory with node_modules/playwright>");
  const { webkit } = createRequire(join(process.env.PLAYWRIGHT, "node_modules", "x.js"))("playwright");
  const browser = await webkit.launch();
  const page = await browser.newPage();
  await page.goto(base + "test.html");
  console.log(`WebKit ${browser.version()}`);
  ev = (expression) => page.evaluate(expression);
  close = () => browser.close();
} else throw new Error(`BROWSER=${ENGINE}: chromium or webkit`);

try {
  ok(await ev("crossOriginIsolated"), `${ENGINE}: the page is cross-origin isolated`);
  // a consistent copy of slot i (24 words), as src/runtime/progress.ts's
  // read(): an even sequence (word 0) the same before and after the words,
  // else null after 4 torn reads; `load` reads word k (Atomics.load, or a
  // test's forced torn state).  Decoded: word 1 bit 0 in use, words 2-3 the
  // call's id, word 7 the op, word 9's low 16 bits the stage index, words
  // 10-11 done.  (astra2's CORR-PR147-2: separate loads could pair a new
  // stage index with the previous stage's done)
  await ev(`window.kdSlot = (load, i) => {
    const b = i * 24;
    for (let tries = 0; tries < 4; tries++) {
      const s1 = load(b);
      if (s1 & 1) continue;
      const w = [];
      for (let k = 0; k < 24; k++) w.push(load(b + k) >>> 0);
      if (load(b) !== s1) continue;
      return { inUse: !!(w[1] & 1), callId: w[2] + w[3] * 2 ** 32, op: w[7], stage: w[9] & 0xffff, done: w[10] + w[11] * 2 ** 32 };
    }
    return null;
  }`);
  // the forced torn reads: a writer moving stage 3 (done 5) to stage 4 has
  // published its odd sequence and the new stage, not yet done = 0; and a
  // sequence that moves on (a write completed) between every two reads
  const torn = await ev(`(() => {
    const words = new Int32Array(24);
    words[0] = 7; words[1] = 1; words[2] = 9; words[9] = 4; words[10] = 5;
    const raw = (Atomics.load(words, 1) & 1) && (Atomics.load(words, 9) & 0xffff) === 4 && Atomics.load(words, 10) > 0;
    const odd = kdSlot((k) => Atomics.load(words, k), 0);
    words[0] = 8;
    let n = 0;
    const moving = kdSlot((k) => (k === 0 ? 8 + 2 * n++ : Atomics.load(words, k)), 0);
    const stable = kdSlot((k) => Atomics.load(words, k), 0);
    return { raw: !!raw, odd, moving, stable };
  })()`);
  ok(torn.raw === true && torn.odd === null && torn.moving === null && torn.stable?.stage === 4 && torn.stable.done === 5,
     `a torn progress slot is never read as a stage with done > 0, which the separate loads were (${JSON.stringify(torn)})`);

  // a fresh worker runs `code` (Sage) as run 2; with `stage` set, the page
  // reads consistent copies of the shared progress slots (kdSlot), remembers
  // the call ids in use before the run, and sends Stop only once a copy shows
  // a call id new since then in that stage with done > 0 (stopSlot: that copy)
  await ev(`window.kd = (code, stage, wait = 600000) => new Promise((resolve) => {
    const w = new Worker("/sagebrush-worker.js", { type: "module" });
    let out = "", sent = 0, seen = [], timer, before = null, callId = null, stopCall = null, stopSlot = null;
    const end = (r) => { clearInterval(timer); w.terminate(); resolve({ out, sent, seen: seen.slice(-6), callId, stopCall, stopSlot, before, ...r }); };
    w.onmessage = (e) => {
      const m = e.data;
      if (m.ready) {
        if (stage !== null) {
          if (!m.interrupt || !m.progress) return end({ error: "no shared interrupt flag or progress slots" });
          const intr = new Int32Array(m.interrupt), slots = new Int32Array(m.progress);
          const load = (k) => Atomics.load(slots, k);
          before = [];
          for (let i = 0; i < 32; i++) {
            const c = kdSlot(load, i);
            if (c === null) return end({ error: "a torn progress slot before the run" });
            if (c.inUse) before.push(c.callId);
          }
          timer = setInterval(() => {
            for (let i = 0; i < 32 && !sent; i++) {
              const c = kdSlot(load, i);
              if (!c || !c.inUse || before.includes(c.callId)) continue;
              if (callId === null) callId = c.callId;
              const s = c.callId + ":" + c.stage + ":" + c.done;
              if (seen[seen.length - 1] !== s) seen.push(s);
              if (c.stage === stage && c.done > 0) {
                stopCall = c.callId;
                stopSlot = c;
                sent = Date.now();
                Atomics.or(intr, 0, 1);
                Atomics.notify(intr, 0);
              }
            }
          }, 2);
        }
        w.postMessage({ id: 2, sage: true, code });
      }
      if (m.id === 2 && m.stream) out += m.text;
      if (m.id === 2 && m.done) end({ error: !!m.error });
    };
    w.postMessage({ init: { limits: null } });
    setTimeout(() => end({ timeout: true }), wait);
  })`);
  const kd = (code, stage = null) => ev(`kd(${JSON.stringify(code)}, ${stage})`);

  const DETECT = "import _sbengine, _sage_padic_lseries as L\nprint(_sbengine.js_engine(), _sbengine.js_host(), L._kd_engine())";
  const REFUSE = [
    "try:",
    "    EllipticCurve('14a1').padic_lseries(5).frobenius(5)",
    "    print('COMPUTED')",
    "except NotImplementedError as e:",
    "    print('REFUSED', type(e).__name__, str(e), hasattr(e, 'need_bytes'))",
  ].join("\n");
  let override = "";
  if (ENGINE === "webkit") {
    // 1. the production path, first, in a clean worker: no override anywhere yet
    let r = await kd(DETECT + "\n" + REFUSE);
    const want = "the Frobenius matrix at p = 5 to precision 5: the memory estimate for this computation isn't established for this JavaScript engine (jsc (WebKit)); the native package computes it";
    ok(r.out === `jsc browser jsc (WebKit)\nREFUSED NotImplementedError ${want} False\n`, `WebKit's worker: JavaScriptCore on a browser host, and the production refusal, exactly (${JSON.stringify(r)})`);
    // 2. ... and before the working modulus is made: in a fresh worker whose
    // _kd_modulus raises, the refusal is the same (the modulus never reached)
    r = await kd("import _sage_padic_lseries as L\ndef _sentinel(p, W):\n    raise AssertionError('MODULUS REACHED')\nL._kd_modulus = _sentinel\n" + REFUSE);
    ok(r.out.startsWith("REFUSED ") && r.out.includes("isn't established for this JavaScript engine (jsc (WebKit))") && !r.out.includes("MODULUS REACHED"), `WebKit: refused before the working modulus (${JSON.stringify(r)})`);
    // the Stop cases run the call under the test-only override, each in its own worker
    override = "import _sage_padic_lseries as _K\n_K._kd_engine = lambda: 'jsc'\n";
  } else {
    const r = await kd(DETECT + "\nprint(EllipticCurve('14a1').padic_lseries(5).frobenius(5).det())");
    ok(r.out === "v8 browser v8\n5^-1 + O(5^4)\n", `Chromium's worker: V8 on a browser host, the V8 table, and a value (${JSON.stringify(r)})`);
  }

  // (stage 4 at p = 2003: at p = 1013 the reduction can end, on a fast
  // runner, before progress's next 250 ms write shows done > 0)
  for (const [what, p, prec, stage] of [["setup: Q^p", 4001, 2, 1], ["series", 5, 400, 3], ["reduce dx/y", 2003, 1, 4], ["check: setup Q^p", 1013, 1, 6]]) {
    const code = override + [
      "import time",
      "from sagebrush import progress",
      "assert progress.snapshot() == [], progress.snapshot()",
      `L = EllipticCurve('27a1').padic_lseries(${p})`,
      "try:",
      `    L.frobenius(${prec})`,
      "    print('FINISHED')",
      "except KeyboardInterrupt:",
      "    t = time.time() * 1000",
      "    print('interrupted', t, len(progress.snapshot()), EllipticCurve('14a1').padic_lseries(5).frobenius(5).det())",
      "except Exception as e:",
      "    print('RAISED', type(e).__name__, e)",
    ].join("\n");
    const r = await kd(code, stage);
    const m = /^interrupted (\S+) (\d+) (.*)$/m.exec(r.out);
    const ms = m ? Number(m[1]) - r.sent : NaN;
    console.log(`Stop in stage ${stage} (${what}) at p = ${p}, prec ${prec}, in ${ENGINE}'s worker: KeyboardInterrupt ${ms.toFixed(0)} ms after Stop`);
    // (a pass needs: this run's own new call seen in the intended stage with
    // done > 0 when Stop went out, KeyboardInterrupt, not a finished or
    // refused call or the harness's timeout, within 1 s, the slot released,
    // and a later call right)
    const active = r.sent > 0 && r.stopCall !== null && r.stopCall === r.callId && Array.isArray(r.before) && !r.before.includes(r.stopCall) &&
      !!r.stopSlot && r.stopSlot.inUse && r.stopSlot.callId === r.stopCall && r.stopSlot.stage === stage && r.stopSlot.done > 0;
    ok(active && !r.timeout && !!m && !/FINISHED|RAISED/.test(r.out) && ms < 1000 && m[2] === "0" && m[3] === "5^-1 + O(5^4)", `Stop in stage ${stage}: this call active in that stage, KeyboardInterrupt within 1 s, the slot released, a later call right (${JSON.stringify(r)})`);
  }
} finally {
  await close();
  server.close();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
