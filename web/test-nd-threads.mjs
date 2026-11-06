// ci: web-browser/notebook order=132
// engine/nd's thread pool in the notebook page (headless Chrome; the test server is cross-origin isolated, as the
// site is; threads r2, PR (1), src/runtime/nd.ts): no helper exists before the first large product; that product
// starts the pool, whose min(cores - 1, 8) helpers each load the fixed same-origin script sagebrush-nd-helper.js
// once, by its content hash (the server's log counts them); a product after the pool is up gives the same bytes as
// the first, on one thread, and agrees with a product below the cutoff to rounding.
//
//   bun web/build.ts && node web/test-nd-threads.mjs      (CHROME=... for the browser)
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, freePort } from "./test-port.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, name) => { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) failures++; };
const port = await freePort();
let cdp = Number(process.env.CDP_PORT) || 0;
const here = new URL(".", import.meta.url).pathname;
const log = join(mkdtempSync(join(tmpdir(), "sb-ndt-log-")), "requests.jsonl");
const server = spawn("python3", [join(here, "serve.py"), String(port)], { stdio: "ignore", env: { ...process.env, SB_SERVE_LOG: log } });
await sleep(800);
const profile = mkdtempSync(join(tmpdir(), "sb-ndt-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${cdp}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!cdp) cdp = await devtoolsPort(profile);
const cleanup = () => { chrome.kill(); server.kill(); };
process.on("uncaughtException", (e) => { console.log("FAIL " + (e?.stack ?? e)); cleanup(); process.exit(1); });
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
const until = async (expr, ms = 60000) => { for (let i = 0; i < ms / 100; i++) { if (await ev(expr)) return true; await sleep(100); } return false; };
const ready = () => until("document.querySelector('#status')?.textContent.startsWith('ready')");
async function runCode(code) {
  await ev(`(() => { const cs = [...document.querySelectorAll('.cell')]; let c = cs.at(-1); if (c.querySelector('textarea').value.trim()) { document.querySelector('#add').click(); c = [...document.querySelectorAll('.cell')].at(-1); } const ta = c.querySelector('textarea'); ta.value = ${JSON.stringify(code)}; ta.dispatchEvent(new Event('input', {bubbles: true})); c.querySelector('[data-a=run]').click(); })()`);
  const last = "[...document.querySelectorAll('.cell')].filter(c => c.querySelector('textarea').value.trim()).at(-1)";
  await until(`(() => /\\[\\d+\\]/.test(${last}.querySelector('.n').textContent))()`);
  return ev(`${last}.querySelector('.out').textContent`);
}
const helpers = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).path) : []).filter((p) => /sagebrush-nd-helper\.js/.test(p));

await send("Network.setCacheDisabled", { cacheDisabled: true });
await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
ok(await ready(), "the notebook is ready");
const cores = await ev("navigator.hardwareConcurrency");
const want = cores <= 2 ? 0 : Math.min(cores - 1, 8);
let out = await runCode("import numpy as np\nrng = np.random.default_rng(5)\nA = rng.standard_normal((300, 257)); B = rng.standard_normal((257, 280))\nS = A[:100, :100] @ B[:100, :100]\nprint(S.shape)");
ok(out.includes("(100, 100)") && helpers().length === 0, "products below the cutoff start no helper: " + JSON.stringify([out, helpers()]));
out = await runCode("C1 = A @ B\nprint(C1.shape)");
ok(out.includes("(300, 280)"), "the first large product: " + JSON.stringify(out));
// (its helpers start in the background, after the run)
for (let i = 0; i < 100 && helpers().length < want; i++) await sleep(100);
const h = helpers();
ok(h.length === want && h.every((p) => /^\/sagebrush-nd-helper\.js\?h=[0-9a-f]{16}$/.test(p)), `${want} helpers (${cores} cores), each loading the helper script once, by its content hash: ` + JSON.stringify(h));
await sleep(500);
out = await runCode("C2 = A @ B\nC3 = A @ B\nP = A @ B[:, :100]\nprint(C1.tobytes() == C2.tobytes() == C3.tobytes(), float(np.abs(C2[:, :100] - P).max()) < 1e-12)");
ok(out.includes("True True"), "products on the pool: the first product's bytes, and a product below the cutoff to rounding: " + JSON.stringify(out));
ok(helpers().length === want, "...with no helper started again");

cleanup();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
