// Kedlaya's Frobenius matrix in the browser worker, in headless Chromium
// (plan-kedlaya-optin r6 section 6): the worker's JavaScript engine is V8
// on a browser host, the ledger's V8 table; and Stop during four stages,
// sent by the page through the shared interrupt flag once the shared
// progress slots show that stage with done > 0, raises KeyboardInterrupt
// within 1 s, releases the slot, and leaves the worker computing rightly.
// The page is cross-origin isolated (COOP and COEP), as Stop needs.
//   bun web/build.ts && node web/test-kedlaya-worker.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "./test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
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

const profile = mkdtempSync(join(tmpdir(), "sb-kedlaya-chrome-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, base + "test.html"], { stdio: "ignore" });
try {
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
    const r = await send("Runtime.evaluate", { expression: "location.href + ' ' + crossOriginIsolated", returnByValue: true });
    if (r.result?.value === base + "test.html true") break;
    await sleep(100);
  }
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
    return r.result.value;
  };
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

  // a fresh worker: run `code` (Sage) as run 2; if `stage` is set, Stop once
  // a consistent copy of a progress slot shows that call in that stage with
  // done > 0 (seen: the copy Stop was sent on)
  await ev(`window.kd = (code, stage, wait = 600000) => new Promise((resolve) => {
    const w = new Worker("/sagebrush-worker.js", { type: "module" });
    let out = "", sent = 0, seen = "", timer;
    const end = (r) => { clearInterval(timer); w.terminate(); resolve({ out, sent, seen, ...r }); };
    w.onmessage = (e) => {
      const m = e.data;
      if (m.ready) {
        if (stage !== null) {
          if (!m.interrupt || !m.progress) return end({ error: "no shared interrupt flag or progress slots" });
          const intr = new Int32Array(m.interrupt), slots = new Int32Array(m.progress);
          timer = setInterval(() => {
            for (let i = 0; i < 32 && !sent; i++) {
              const s = kdSlot((k) => Atomics.load(slots, k), i);
              if (!s || !s.inUse) continue;
              if (s.stage === stage && s.done > 0) {
                seen = s;
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

  let r = await kd("import _sbengine, _sage_padic_lseries as L\nprint(_sbengine.js_engine(), _sbengine.js_host(), L._kd_engine())\nprint(EllipticCurve('14a1').padic_lseries(5).frobenius(5).det())");
  ok(r.out === "v8 browser v8\n5^-1 + O(5^4)\n", `Chromium's worker: V8 on a browser host, the V8 table, and a value (${JSON.stringify(r)})`);

  // (stages 4 and 6 at p = 2003: at p = 1013 either can end, on a fast
  // runner, before progress's next 250 ms write shows done > 0; stage 6 did
  // in CI web-browser (notebook), job 121261851557)
  for (const [what, p, prec, stage] of [["setup: Q^p", 4001, 2, 1], ["series", 5, 400, 3], ["reduce dx/y", 2003, 1, 4], ["check: setup Q^p", 2003, 1, 6]]) {
    const code = [
      "import time",
      "from sagebrush import progress",
      `L = EllipticCurve('27a1').padic_lseries(${p})`,
      "try:",
      `    L.frobenius(${prec})`,
      "    print('finished')",
      "except KeyboardInterrupt:",
      "    t = time.time() * 1000",
      "    print('interrupted', t, len(progress.snapshot()), EllipticCurve('14a1').padic_lseries(5).frobenius(5).det())",
    ].join("\n");
    r = await kd(code, stage);
    const m = /^interrupted (\S+) (\d+) (.*)$/m.exec(r.out);
    const ms = m ? Number(m[1]) - r.sent : NaN;
    console.log(`Stop in stage ${stage} (${what}) at p = ${p}, prec ${prec}, in Chromium's worker: KeyboardInterrupt ${ms.toFixed(0)} ms after Stop`);
    ok(!!m && r.seen.inUse && r.seen.callId > 0 && r.seen.stage === stage && r.seen.done > 0 && ms < 1000 && m[2] === "0" && m[3] === "5^-1 + O(5^4)",
       `Stop in stage ${stage}: sent on a consistent copy of the call's slot in that stage with done > 0; within 1 s, the slot released, a later call right (${JSON.stringify(r)})`);
  }
} finally {
  chrome.kill();
  server.close();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
