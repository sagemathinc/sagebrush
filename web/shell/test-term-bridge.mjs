// ci: web-browser/terminal.4 order=20 runner=bun chrome
// The Terminal commands' page side (design-term-3b2 r1): web/shell/term-bridge.ts with the real shell module (its
// set built by the publisher, host level 4), ShellHost over a real Workspace, and the built notebook worker
// (web/dist/sagebrush-worker.js), in headless Chromium.  The cases are term-bridge-cases.js: the handler's operations
// against a real run, its schemas, the read slot, the write's preflight and queued commit (D8), the command loop
// with a scripted worker (queue, reservation, generations, the accepted messages, the end only when quiet, output,
// Stop and its grace), and commands end to end (python, sage, matlab, magma; files live; pipelines; Stop).
//   bun web/build.ts && bun web/shell/test-term-bridge.mjs        (ONLY=group,group to run some; SHOW=1 lists each)
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const root = join(here, "..", "..");
const dist = join(root, "web", "dist");
let chrome = null;
const limitS = Number(process.env.TERM_TEST_TIMEOUT_S) || 900;
setTimeout(() => {
  console.log(`FAIL the test did not end within ${limitS} s`);
  chrome?.kill();
  process.exit(1);
}, limitS * 1000).unref();
if (!existsSync(join(dist, "sagebrush-worker.js"))) {
  console.log("FAIL web/dist/sagebrush-worker.js is missing: run bun web/build.ts first");
  process.exit(1);
}
const { shellWorkerPolicy, pagePolicy } = await import(join(here, "..", "csp-policy.mts"));

// the shell's set (host level 4), built by the publisher
const dir = mkdtempSync(join(tmpdir(), "sb-test-term-bridge-"));
const S = execFileSync("node", [join(root, "scripts", "optional-packages.mjs"), "build", "--out", dir, "bash"], { encoding: "utf8" }).trim().split("\n").at(-1);
const req = Object.values(JSON.parse(readFileSync(join(dir, "pkgset", S + ".json"), "utf8")).packages)[0].js.host_req;
if (req < 4) throw new Error(`the shell's host_req is ${req}: the Terminal commands need 4`);

// the page's modules, bundled for this test only
const entry = join(dir, "entry.ts");
await Bun.write(
  entry,
  `export { startShell } from ${JSON.stringify(join(here, "loader.ts"))};
export { ShellHost, STOP_GRACE_MS } from ${JSON.stringify(join(here, "host.ts"))};
export * as TB from ${JSON.stringify(join(here, "term-bridge.ts"))};
export * as TS from ${JSON.stringify(join(root, "web", "term-sync.ts"))};
export * as W from ${JSON.stringify(join(root, "web", "workspace", "index.ts"))};
`,
);
execFileSync("bun", ["build", entry, "--target=browser", "--format=esm", `--outfile=${join(dir, "host-bundle.js")}`], { stdio: ["ignore", "ignore", "inherit"] });

// CPython 3.14.10's answers (test/gen_term_cmd_cases.py): the record must be the one the committed generator and cases make
const sha = (f) => new Bun.CryptoHasher("sha256").update(readFileSync(f)).digest("hex");
const oracle = JSON.parse(readFileSync(join(root, "test", "term-cmd-oracle.json"), "utf8"));
const cases = JSON.parse(readFileSync(join(root, "test", "term-cmd-cases.json"), "utf8")).cases;
if (oracle.provenance.generator_sha256 !== sha(join(root, "test", "gen_term_cmd_cases.py")) || oracle.provenance.cases_sha256 !== sha(join(root, "test", "term-cmd-cases.json")) || !oracle.provenance.python.startsWith("3.14.10 "))
  throw new Error("test/term-cmd-oracle.json isn't what test/gen_term_cmd_cases.py makes of test/term-cmd-cases.json with CPython 3.14.10: run it again");

const page = `<!doctype html><meta charset="utf-8"><script type="module" src="/page.js"></script>`;
// (the page counts its live workers: every path must end with none of a command's left)
// (only the commands' workers, the notebook's build: the shell's own worker is the host's)
const pageJs = `window.workers = { made: 0, live: 0 };
const Real = Worker;
window.Worker = class extends Real {
  constructor(...a) { super(...a); this.cmd = /sagebrush-worker\\.js$/.test(String(a[0])); if (this.cmd) { workers.made++; workers.live++; } }
  terminate() { if (this.cmd && !this.ended) { this.ended = true; workers.live--; } super.terminate(); }
};
const { run } = await import("/term-bridge-cases.js"); window.run = run; window.ready = true;`;
const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".html": "text/html", ".css": "text/css", ".gz": "application/gzip" };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const iso = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
  const send = (type, body, extra = {}) => res.writeHead(200, { "Content-Type": type, ...iso, ...extra }).end(body);
  if (path === "/") return send("text/html", page, { "Content-Security-Policy": pagePolicy() });
  if (path === "/page.js") return send("text/javascript", pageJs);
  if (path === "/term-bridge-cases.js") return send("text/javascript", readFileSync(join(here, "term-bridge-cases.js")));
  if (path === "/host-bundle.js") return send("text/javascript", readFileSync(join(dir, "host-bundle.js")));
  if (path === "/data.json") return send("application/json", JSON.stringify({ S, oracle: { cases, records: oracle.records } }));
  if (path === "/shell/worker-boot.js") return send("text/javascript", readFileSync(join(here, "worker-boot.js")), { "Content-Security-Policy": shellWorkerPolicy() });
  const m = /^\/(pkgset|pkg)\/([0-9a-f]{64})\.json$/.exec(path);
  if (m && existsSync(join(dir, m[1], m[2] + ".json"))) return send("application/json", readFileSync(join(dir, m[1], m[2] + ".json")));
  // (everything else the notebook's worker fetches: web/dist, as the site serves it)
  const f = normalize(join(dist, path));
  if (f.startsWith(dist + "/") && existsSync(f) && !f.endsWith("/")) {
    try {
      return send(TYPES[extname(f)] ?? "application/octet-stream", readFileSync(f));
    } catch {}
  }
  res.writeHead(404, iso).end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));

const profile = mkdtempSync(join(tmpdir(), "sb-test-term-bridge-chrome-"));
chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let code = 1, ws = null;
try {
  const port = await devtoolsPort(profile);
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let seq = 0;
  const waiting = new Map(), errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) (waiting.get(m.id)(m), waiting.delete(m.id));
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails).slice(0, 500));
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++seq; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  await send("Runtime.enable");
  await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
  for (let i = 0; i < 200 && (await evaluate("window.ready === true").catch(() => false)) !== true; i++) await new Promise((r) => setTimeout(r, 50));
  if ((await evaluate("self.crossOriginIsolated")) !== true) throw new Error("the page isn't cross-origin isolated");
  const only = process.env.ONLY ? JSON.stringify(process.env.ONLY) : "undefined";
  const results = await evaluate(`window.run(${only})`);
  const fails = results.filter(([ok]) => !ok).map(([, what]) => what);
  for (const e of errors) fails.push("page error: " + e);
  if (process.env.SHOW) for (const [ok, what] of results) console.log((ok ? "ok   " : "FAIL ") + what);
  if (fails.length) console.error(`FAIL: ${fails.length} of ${results.length} checks\n  ` + fails.join("\n  "));
  else {
    console.log(`ok: the Terminal commands' page side, ${results.length} checks`);
    code = 0;
  }
} finally {
  ws?.close();
  chrome.kill();
  server.close();
  await new Promise((r) => setTimeout(r, 200));
  rmSync(profile, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
