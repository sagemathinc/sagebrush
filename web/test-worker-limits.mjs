// The browser worker's init gate (web/worker.ts; plan-ff-limits r3, section
// 4), in headless Chromium: the worker runs nothing before its init message
// gives it its limits (the deployment's or course's JSON text, or null for
// the defaults); runs sent earlier wait and then see those limits; invalid
// limits are final (initFailed), and every run, queued or later, is answered
// with the reason and never runs; a second init is refused; a worker never
// given an init runs nothing; WorkerKernel gives every worker it starts,
// after a restart too, the same text.  And the plan's measurement: the
// largest call admitted at ff.work = 10^8 (MinimalPolynomial in GF(2^79)),
// timed in this worker.
//   bun web/build.ts && node web/test-worker-limits.mjs
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
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/test.html") return res.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html><title>limits</title>");
  let p = normalize(join(dist, url.pathname));
  if (p.startsWith(dist) && existsSync(p) && statSync(p).isDirectory()) p = join(p, "index.html");
  if (!p.startsWith(dist) || !existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": types[extname(p)] ?? "application/octet-stream" }).end(readFileSync(p));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const profile = mkdtempSync(join(tmpdir(), "sb-limits-chrome-"));
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
    const r = await send("Runtime.evaluate", { expression: "location.href", returnByValue: true });
    if (r.result?.value === base + "test.html") break;
    await sleep(100);
  }
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
    return r.result.value;
  };
  // a fresh worker sent `msgs` in order; its output for run 2 and what it said, until run 2 is done (or `wait` ms)
  await ev(`window.sbw = (msgs, wait = 120000) => new Promise((resolve) => {
    const w = new Worker("/sagebrush-worker.js", { type: "module" });
    const said = []; let out = "", t0 = performance.now();
    const end = (r) => { w.terminate(); resolve({ out, said, ms: Math.round(performance.now() - t0), ...r }); };
    w.onmessage = (e) => {
      const m = e.data;
      if (m.ready) said.push("ready");
      if (m.initFailed !== undefined) said.push("initFailed: " + m.initFailed);
      if (m.initRefused !== undefined) said.push("initRefused: " + m.initRefused);
      if (m.id === 2 && m.stream) out += m.text;
      if (m.id === 2 && m.done) end({ error: !!m.error });
    };
    for (const m of msgs) w.postMessage(m);
    setTimeout(() => end({ timeout: true }), wait);
  })`);
  const WORK = { id: 2, code: "import _sage_ffsub\nprint(_sage_ffsub.WORK)" };
  const MARK = { id: 2, code: "print('MARKER')" };
  const init = (limits) => ({ init: { limits } });
  const sbw = (msgs, wait) => ev(`sbw(${JSON.stringify(msgs)}${wait ? ", " + wait : ""})`);

  let r = await sbw([init(null), WORK]);
  ok(r.out === "10000000\n" && r.said.includes("ready"), `init null: the defaults (${JSON.stringify(r)})`);
  r = await sbw([init('{"ff.work": 123456}'), WORK]);
  ok(r.out === "123456\n", `init with limits: the session's (${JSON.stringify(r)})`);
  r = await sbw([WORK, init('{"ff.work": 123456}')]);
  ok(r.out === "123456\n", `a run sent before init waits for it, and sees its limits (${JSON.stringify(r)})`);
  const bad = "This engine's settings are invalid: limits: ff.work = 1 is outside the range this engine allows, [100000, 100000000]; ask the site's administrator.\n";
  r = await sbw([init('{"ff.work": 1}'), MARK]);
  ok(r.out === bad && r.error && !r.said.includes("ready") && r.said.some((s) => s.startsWith("initFailed: limits: ff.work = 1")), `invalid limits: failed for good, the run refused with the reason, never run (${JSON.stringify(r)})`);
  r = await sbw([MARK, init('{"ff.work": 1}')]);
  ok(r.out === bad && r.error && !r.out.includes("MARKER"), `a run queued before an invalid init is refused too (${JSON.stringify(r)})`);
  r = await sbw([init(null), init('{"ff.work": 123456}'), WORK]);
  ok(r.out === "10000000\n" && r.said.includes("initRefused: this engine's limits are set already"), `a second init is refused; the first stands (${JSON.stringify(r)})`);
  r = await sbw([init('{"ff.work": 100000' + " ".repeat(5000) + "}"), MARK]);
  ok(r.said.includes("initFailed: limits: the limits are larger than 4096 bytes") && !r.out.includes("MARKER"), `more than 4096 bytes: refused before parsing (${JSON.stringify(r).slice(0, 300)})`);
  r = await sbw([init("{" + '"ff.work": "' + "é".repeat(2049) + '"}'), MARK]);
  ok(r.said.includes("initFailed: limits: the limits are larger than 4096 bytes"), `counted in UTF-8 bytes, not characters (${JSON.stringify(r).slice(0, 200)})`);
  r = await sbw([{ init: { limits: 5 } }, MARK]);
  ok(r.said.includes("initFailed: limits: the limits must be a JSON text") && !r.out.includes("MARKER"), `limits that aren't text: refused (${JSON.stringify(r)})`);
  r = await sbw([init('{"ff.wrok": 5}'), MARK]);
  ok(r.said.some((s) => s.startsWith("initFailed: limits: ff.wrok is not a limit of this engine")) && !r.out.includes("MARKER"), `the validator's refusal, in its words (${JSON.stringify(r)})`);
  // envelopes that aren't {limits: text | null}, and limits that aren't text:
  // supplied wrongly, so refused, never the defaults (astra CORR-FF93-1)
  for (const [msg, want] of [
    [{ init: {} }, "limits: the init message has no limits (a JSON text, or null for the defaults)"],
    [{ init: 42 }, "limits: the init message must be {limits: a JSON text or null}, not a number"],
    [{ init: false }, "limits: the init message must be {limits: a JSON text or null}, not a boolean"],
    [{ init: null }, "limits: the init message must be {limits: a JSON text or null}, not null"],
    [{ init: [] }, "limits: the init message must be {limits: a JSON text or null}, not an array"],
    [{ init: { limits: { "ff.work": 100000 } } }, "limits: the limits must be a JSON text, not an object"],
    [{ init: { limits: 42 } }, "limits: the limits must be a JSON text, not a number"],
    [{ init: { limits: false } }, "limits: the limits must be a JSON text, not a boolean"],
    [{ init: { limits: [1] } }, "limits: the limits must be a JSON text, not an array"],
  ]) {
    r = await sbw([msg, MARK]);
    ok(r.said.includes("initFailed: " + want) && !r.out.includes("MARKER") && r.out.includes(want) && r.error, `${JSON.stringify(msg)}: refused, nothing runs (${JSON.stringify(r)})`);
  }
  r = await sbw([MARK], 8000);
  ok(r.timeout && r.out === "" && !r.said.includes("ready"), `no init: nothing runs, nothing is ready (${JSON.stringify(r)})`);

  // WorkerKernel: every worker it starts, and restarts, gets the same limits first
  const k = await ev(`(async () => {
    const { WorkerKernel } = await import("/sagebrush-notebook.js");
    const k = new WorkerKernel({ createWorker: () => new Worker("/sagebrush-worker.js", { type: "module" }), limits: '{"ff.work": 123456}' });
    k.start();
    const run = (code) => new Promise((res) => {
      let out = "";
      k.execute(code, { mode: "python" }, { start() {}, out(t) { out += t; }, display() {}, interact() {}, clear() {}, done() { res(out); }, stopped(m) { res("stopped: " + m); }, skipped() { res("skipped"); } });
    });
    const a = await run("import _sage_ffsub\\nprint(_sage_ffsub.WORK)");
    k.restart();
    const b = await run("import _sage_ffsub\\nprint(_sage_ffsub.WORK)");
    k.close();
    return [a, b];
  })()`);
  ok(JSON.stringify(k) === JSON.stringify(["123456\n", "123456\n"]), `WorkerKernel: its limits, and the same after a restart (${JSON.stringify(k)})`);

  // WorkerKernel given settings that aren't text: the worker refuses them,
  // every run says why and none runs; omitted, the defaults (astra CORR-FF93-1)
  const kr = await ev(`(async () => {
    const { WorkerKernel } = await import("/sagebrush-notebook.js");
    const out = [];
    for (const [label, limits] of [["omitted", undefined], ["object", { "ff.work": 100000 }], ["42", 42], ["false", false], ["array", [1]], ["function", () => 1], ["empty text", ""]]) {
      const o = { createWorker: () => new Worker("/sagebrush-worker.js", { type: "module" }) };
      if (label !== "omitted") o.limits = limits;
      const k = new WorkerKernel(o);
      let status = "";
      k.on("status", (s) => (status = s));
      k.start();
      const got = await new Promise((res) => {
        let text = "";
        k.execute("import _sage_ffsub\\nprint('MARKER', _sage_ffsub.WORK)", { mode: "python" }, { start() {}, out(t) { text += t; }, display() {}, interact() {}, clear() {}, done() { res(text); }, stopped(m) { res("stopped: " + m); }, skipped() { res("skipped"); } });
      });
      k.close();
      out.push([label, got, status]);
    }
    return out;
  })()`);
  for (const [label, got, status] of kr) {
    if (label === "omitted") ok(got === "MARKER 10000000\n", `WorkerKernel, limits omitted: the defaults (${got})`);
    else ok(!got.includes("MARKER") && got.includes("This engine's settings are invalid: limits: ") && status.startsWith("error: This engine's settings are invalid"), `WorkerKernel, limits ${label}: refused, nothing runs (${JSON.stringify([got, status])})`);
  }

  // the measurement: the largest call admitted at the ceiling, in this worker
  const big = { id: 2, sage: true, code: 'import time\nR.<x> = GF(2)[]\nK = GF(2^79, "a", modulus=x^79 + x^9 + 1)\nt = time.time()\nf = (K.gen()^3 + K.gen()).minpoly()\nprint(f.degree(), round(time.time() - t, 2))' };
  r = await sbw([init('{"ff.work": 100000000}'), big], 180000);
  const [deg, secs] = r.out.trim().split(" ");
  ok(deg === "79", `ff.work = 10^8 in a Chromium worker: MinimalPolynomial in GF(2^79), 79373117 cops (${JSON.stringify(r)})`);
  console.log(`measurement: Chromium worker, MinimalPolynomial in GF(2^79) at ff.work = 10^8: ${secs} s (the run with Sage's start: ${r.ms} ms)`);
  ok(Number(secs) < 15, `under 15 s (${secs} s)`);
  r = await sbw([init(null), big], 180000);
  ok(r.out.includes("is not supported yet (work)"), `and refused at the default (${r.out.slice(-200)})`);
} finally {
  chrome.kill();
  server.close();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
