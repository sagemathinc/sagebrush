// ci: web-browser/notebook order=195
// pandas on demand (QRPM 1b): the site's notebooks' package set, built by
// web/build.ts and named in pkgset/latest.json, in headless Chromium against
// web/dist as built (web/serve.py behind a proxy that records each path and
// the bytes served under pkg/):
// - latest.json names a set with pandas, source only (no precompiled chunk,
//   so its id doesn't move with the core's build);
// - a notebook that never imports pandas fetches none of its chunks;
// - `import pandas` in a cell fetches its source chunk, once, and runs
//   (a DataFrame, a read_csv of a file the notebook wrote), with the plain
//   worker and with the runner;
// - nothing else under pkg/ is fetched for it.
//   bun web/build.ts && node web/test-pandas-on-demand.mjs      (CHROME=... for the browser)
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, freePort } from "./test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const dist = join(here, "dist");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, name) => { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) failures++; };
setTimeout(() => { console.log("FAIL the test did not end within 400 s"); process.exit(1); }, 400_000).unref();

// the set the build published
const S = JSON.parse(readFileSync(join(dist, "pkgset", "latest.json"), "utf8")).id;
const index = JSON.parse(readFileSync(join(dist, "pkgset", S + ".json"), "utf8"));
const ids = Object.keys(index.packages);
const pandas = index.packages[ids.find((id) => id.startsWith("@sagebrush/pandas@"))];
ok(/^[0-9a-f]{64}$/.test(S) && !!pandas, `latest.json names a set with pandas (${ids.join(", ")})`);
ok(pandas && Object.keys(pandas.pre).length === 0, "source only: no precompiled chunk");
const SRC = `/pkg/${pandas?.src.sha256}.json`;

// web/dist behind a recording proxy
async function site() {
  const upstream = await freePort();
  const server = spawn("python3", [join(here, "serve.py"), String(upstream)], { stdio: "ignore" });
  const asked = [];
  const bytes = new Map(); // a pkg/ path -> bytes served
  const front = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    asked.push(path);
    const up = request({ host: "127.0.0.1", port: upstream, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      if (path.startsWith("/pkg/")) r.on("data", (d) => bytes.set(path, (bytes.get(path) ?? 0) + d.length));
      r.pipe(res);
    });
    up.on("error", () => { res.destroy(); });
    req.pipe(up);
  });
  await new Promise((r) => front.listen(0, "127.0.0.1", r));
  for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${upstream}/`); break; } catch { await sleep(100); } }
  const stop = () => new Promise((r) => { server.kill(); front.closeAllConnections?.(); front.close(() => r()); });
  return { url: `http://127.0.0.1:${front.address().port}/`, asked, bytes, stop };
}

// a Chrome with a fresh profile, one tab
async function chromium() {
  const profile = mkdtempSync(join(tmpdir(), "sb-pandas-demand-chrome-"));
  const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const port = await devtoolsPort(profile, undefined, { child: chrome });
  const cdp = `http://127.0.0.1:${port}`;
  let target;
  for (let i = 0; i < 300 && !target; i++) { try { target = (await (await fetch(cdp + "/json")).json()).find((t) => t.type === "page"); } catch { await sleep(100); } }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const waiting = new Map(), errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
  const until = async (expr, ms = 30000) => { for (let i = 0; i < ms / 100; i++) { if (await ev(expr)) return true; await sleep(100); } return false; };
  await send("Page.enable");
  await send("Runtime.enable");
  const cell = (k) => `document.querySelectorAll('.cell')[${k}]`;
  const t = {
    errors, ev, until,
    open: async (url) => { await send("Page.navigate", { url }); return until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000); },
    // a run in a new last cell, waited for: its output
    run: async (code, ms = 120000) => {
      const k = await ev(`(() => { const cs = [...document.querySelectorAll('.cell')]; if (cs.at(-1).querySelector('textarea').value.trim()) document.querySelector('#add').click(); return document.querySelectorAll('.cell').length - 1; })()`);
      await ev(`(() => { const c = ${cell(k)}; const ta = c.querySelector('textarea'); ta.value = ${JSON.stringify(code)}; ta.dispatchEvent(new Event('input', {bubbles: true})); c.querySelector('[data-a=run]').click(); })()`);
      await until(`/\\[\\d+\\]/.test(${cell(k)}?.querySelector('.n')?.textContent ?? '')`, ms);
      return String(await ev(`${cell(k)}?.querySelector('.out')?.textContent ?? ''`));
    },
  };
  const close = async () => {
    ws.close();
    chrome.kill("SIGKILL");
    await sleep(300);
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  return { t, close };
}

const PANDAS = [
  "import pandas as pd",
  "df = pd.DataFrame({'a': [1, 2, 3], 'b': [0.5, 1.5, 2.5]})",
  "print(df.shape, df['a'].sum(), list(df.columns))",
  "open('pts.csv', 'w').write('x,y\\n1,2\\n3,4\\n')",
  "print(pd.read_csv('pts.csv')['y'].mean())",
].join("\n");

for (const runner of ["0", "1"]) {
  const s = await site(), c = await chromium();
  const what = runner === "1" ? "the runner" : "the plain worker";
  try {
    const { t } = c;
    ok(await t.open(s.url + "?runner=" + runner), `${what}: the notebook page is ready`);
    const plain = await t.run("print(sum(range(10)))");
    ok(plain.includes("45"), `${what}: a cell without pandas runs (${JSON.stringify(plain)})`);
    await sleep(1000);
    ok(!s.asked.some((p) => p.startsWith("/pkg/")), `${what}: no package chunk fetched before an import asks for one (${s.asked.filter((p) => p.startsWith("/pkg/")).join(", ")})`);
    const out = await t.run(PANDAS);
    ok(out.includes("(3, 2) 6 ['a', 'b']") && out.includes("3.0"), `${what}: import pandas runs (${JSON.stringify(out)})`);
    const pkg = s.asked.filter((p) => p.startsWith("/pkg/"));
    ok(pkg.length === 1 && pkg[0] === SRC, `${what}: exactly pandas' source chunk fetched, once (${pkg.join(", ")})`);
    console.log(`     (${what}: ${s.bytes.get(SRC) ?? 0} bytes served for the chunk; the set's index ${s.asked.includes(`/pkgset/${S}.json`) ? "fetched" : "NOT fetched"})`);
    const again = await t.run("import pandas\nprint(pandas.Series([1, 2]).sum())");
    ok(again.includes("3") && s.asked.filter((p) => p.startsWith("/pkg/")).length === 1, `${what}: a second import fetches nothing more (${JSON.stringify(again)})`);
    ok(!t.errors.length, `${what}: no exceptions on the page: ` + JSON.stringify(t.errors));
  } finally { await c.close(); await s.stop(); }
}

console.log(failures ? `${failures} failures` : "all passed");
process.exit(failures ? 1 : 0);
