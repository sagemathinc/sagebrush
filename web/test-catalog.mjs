// The function catalog's examples (catalog/SCHEMA.md) in the browser: the
// notebook page's worker runs every example of each mode that has an example
// runner (lib/_catalog.py RUNNERS), and each output must equal the entry's
// `expected`, as on Node, Deno and Bun (scripts/catalog-run.py).  Serve
// web/dist first:
//   python3 web/serve.py 8765 &  node web/test-catalog.mjs   (SB_URL=... for another)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "./test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const root = new URL("..", import.meta.url).pathname;
const profile = mkdtempSync(join(tmpdir(), "sb-catalog-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cdpPort = Number(process.env.CDP_PORT) || 0;
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };

// each mode's entries, from catalog/<mode>/*.json
const entries = {};
for (const mode of readdirSync(join(root, "catalog"))) {
  const d = join(root, "catalog", mode);
  if (!existsSync(join(d)) || mode.includes(".")) continue;
  entries[mode] = readdirSync(d).filter((f) => f.endsWith(".json")).sort().flatMap((f) => JSON.parse(readFileSync(join(d, f), "utf8")));
}

let ws;
const waiting = new Map();
let n = 0;
// (every request has a deadline, and a closed socket fails what waits on it:
// a stalled Chrome fails the test rather than hanging CI)
const send = (method, params = {}, ms = 30000) => new Promise((resolve, reject) => {
  const id = ++n;
  const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${method}: no answer within ${ms} ms`)); }, ms);
  waiting.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expression, ms = 30000) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, ms);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result?.value;
};
const evWithin = (expression, ms) => ev(expression, ms);
const until = async (expr, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (await evWithin(expr, 10000).catch(() => false)) return true; await sleep(200); } throw new Error("timeout: " + expr.slice(0, 80)); };
const LAST = "[...document.querySelectorAll('.cell')].filter(c => c.querySelector('textarea').value.trim()).at(-1)";
async function run(code, ms) {
  await evWithin(`(() => { const cs = [...document.querySelectorAll('.cell')]; let c = cs.at(-1); if (c.querySelector('textarea').value.trim()) { document.querySelector('#add').click(); c = [...document.querySelectorAll('.cell')].at(-1); } const ta = c.querySelector('textarea'); ta.value = ${JSON.stringify(code)}; ta.dispatchEvent(new Event('input', {bubbles: true})); ta.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', shiftKey: true, bubbles: true})); })()`, 10000);
  await sleep(300);
  await until(`(() => { const c = ${LAST}; return !c.classList.contains('running') && !c.classList.contains('queued') && /\\[\\d+\\]/.test(c.querySelector('.n').textContent); })()`, ms);
  return evWithin(`${LAST}.querySelector('.out').textContent`, 10000);
}

try {
  if (!cdpPort) cdpPort = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }
  if (!targets) throw new Error("Chrome's DevTools did not answer");
  ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await Promise.race([new Promise((r) => (ws.onopen = r)), sleep(30000).then(() => { throw new Error("DevTools socket: not open within 30 s"); })]);
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id).resolve(m.result ?? m.error); waiting.delete(m.id); } };
  ws.onclose = () => { for (const w of waiting.values()) w.reject(new Error("DevTools socket closed")); waiting.clear(); };
  await send("Runtime.enable");
  await send("Page.navigate", { url: new URL("./", base).href }, 60000);
  await until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000);
  for (const [mode, es] of Object.entries(entries)) {
    if (!es.length) continue;
    // (the entries as base64 JSON in one cell; the worker answers with its outputs)
    const data = Buffer.from(JSON.stringify(es)).toString("base64");
    const code = [
      "import base64, json, _catalog",
      `if ${JSON.stringify(mode)} in _catalog.RUNNERS:`,
      `    print('CATALOG' + json.dumps(_catalog.run_all(${JSON.stringify(mode)}, json.loads(base64.b64decode('${data}').decode()), 'browser')))`,
      "else:",
      "    print('CATALOG null')",
    ].join("\n");
    const out = await run(code, 600000);
    const m = /CATALOG(.*)/s.exec(out);
    if (!m || m[1].trim() === "null") {
      console.log(`     ${mode}: ${m ? "no example runner yet" : "no answer: " + out.slice(0, 300)}`);
      if (!m) failures++;
      continue;
    }
    const got = JSON.parse(m[1]);
    const want = new Map();
    for (const e of es) e.examples.forEach((x, i) => { if (!x.runtimes || x.runtimes.includes("browser")) want.set(`${e.name} ${e.signature} #${i + 1}`, [x.code, x.expected]); });
    // (exactly one result per example: a missing, extra or repeated one fails)
    let bad = 0;
    const seen = new Set();
    for (const r of got) {
      const key = `${r.name} ${r.signature} #${r.index + 1}`;
      if (seen.has(key) || !want.has(key)) {
        bad++;
        console.log(`--- ${mode} ${key}: ${seen.has(key) ? "a second result" : "a result for no such example"}`);
        continue;
      }
      seen.add(key);
      const [code, expected] = want.get(key);
      if (r.got !== expected) {
        bad++;
        console.log(`--- ${mode} ${r.name} example ${r.index + 1}\n    code:     ${code.replace(/\n/g, "; ")}\n    expected: ${JSON.stringify(expected)}\n    got:      ${JSON.stringify(r.got)}`);
      }
    }
    for (const key of want.keys()) if (!seen.has(key)) { bad++; console.log(`--- ${mode} ${key}: no result`); }
    ok(bad === 0, `${mode} in the browser: ${got.length} results for ${want.size} examples, ${bad} problems`);
  }
} catch (e) {
  failures++;
  console.log("FAIL", e.message);
} finally {
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
