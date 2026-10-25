// ShellHost, the page's mediator (plan-bash-shell r3 §2–§3, addendum D8 r3), in headless Chromium: the real
// shell module, built by the publisher into a set of its own and run in its CSP'd worker
// (web/shell/worker-boot.js), against a real Workspace (IndexedDB, Web Locks).  The cases are
// host-cases.js; the oracle is test/bash-oracle-cases.json, test/bash-oracle.json and test/bash-known.json
// (#116), and test/bash-step2-known.json for what the host itself adds.
//   CHROME=google-chrome bun web/shell/test-shell-host.mjs
import { spawn, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const root = join(here, "..", "..");
setTimeout(() => {
  console.log("FAIL the test did not end within 600 s");
  process.exit(1);
}, 600_000).unref();
const { shellWorkerPolicy, pagePolicy } = await import(join(here, "..", "csp-policy.mts"));

// the set: the shell's, built by the publisher; and sets whose module is a stand-in, for the cases that need
// a module to misbehave (provenance, forged run ids)
const dir = mkdtempSync(join(tmpdir(), "sb-test-shell-host-"));
const S = execFileSync("node", [join(root, "scripts", "optional-packages.mjs"), "build", "--out", dir, "bash"], { encoding: "utf8" }).trim().split("\n").at(-1);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const canon = (await import(join(root, "scripts", "optional-packages.mjs"))).canonical;
const index = JSON.parse(readFileSync(join(dir, "pkgset", S + ".json"), "utf8"));
const pkg = Object.keys(index.packages).find((k) => k.startsWith("@sagebrush/bash@"));
const chunk = JSON.parse(readFileSync(join(dir, "pkg", index.packages[pkg].js.sha256 + ".json"), "utf8"));
const withModule = (text) => {
  const c = Buffer.from(canon({ ...chunk, modules: { "shell.js": text } }));
  writeFileSync(join(dir, "pkg", sha(c) + ".json"), c);
  const ix = JSON.parse(JSON.stringify(index));
  Object.assign(ix.packages[pkg].js, { sha256: sha(c), size: c.length });
  const b = Buffer.from(canon(ix));
  writeFileSync(join(dir, "pkgset", sha(b) + ".json"), b);
  return sha(b);
};
// Stand-ins: each answers one exec by making file calls through the real protocol, then reporting what it is
// told to.  `steps` (JSON in the script): [{op, args}] in turn; then `report`: "exit" (the answers as stdout),
// "reject-first-refusal" (rejected, naming the first refusal it was answered with), "reject-null" (rejected,
// naming none), "reject-id:<id>" (naming that id), and "forge" sends its calls under another run's id.
const stand = `export function start(port) {
  const waits = new Map(); let req = 1;
  port.onmessage = async (e) => {
    const m = e.data;
    if (m.fs) { const w = waits.get(m.fs.req); waits.delete(m.fs.req); return w && w(m.fs); }
    if (!m.exec) return;
    const { id, run, script } = m.exec, c = JSON.parse(script.slice(2, -2));
    const answers = [];
    for (const s of c.steps) answers.push(await new Promise((r) => { const q = req++; waits.set(q, r); port.postMessage({ name: "fs.request", payload: { id, run: c.forge ? "0000000000000000" : run, req: q, op: s.op, args: s.args } }); }));
    if (c.report === "hang") return;
    const first = answers.find((a) => a.err && a.err.refusal);
    if (c.report === "exit") return port.postMessage({ name: "shell.result", payload: { id, exit: { code: 0, stdout: JSON.stringify(answers.map((a) => a.err ? a.err.code : "ok")), stderr: "" } } });
    const refusal = c.report === "reject-first-refusal" ? (first ? first.err.refusal : null) : c.report.startsWith("reject-id:") ? c.report.slice(10) : null;
    port.postMessage({ name: "shell.result", payload: { id, rejected: { message: "stand-in rejection", refusal } } });
  };
  port.postMessage({ name: "shell.ready", payload: { version: "stand-in" } });
}`;
const STAND = withModule(stand);

// the page: the loader, the host and the workspace, bundled for this test only
const entry = join(dir, "entry.ts");
writeFileSync(entry, `export { startShell } from ${JSON.stringify(join(here, "loader.ts"))};
export { ShellHost, MAX_PENDING } from ${JSON.stringify(join(here, "host.ts"))};
export * as W from ${JSON.stringify(join(here, "..", "workspace", "index.ts"))};
`);
execFileSync("bun", ["build", entry, "--target=browser", "--format=esm", `--outfile=${join(dir, "host-bundle.js")}`], { stdio: ["ignore", "ignore", "inherit"] });
const data = {
  S, STAND,
  cases: JSON.parse(readFileSync(join(root, "test", "bash-oracle-cases.json"), "utf8")),
  oracle: JSON.parse(readFileSync(join(root, "test", "bash-oracle.json"), "utf8")),
  known: JSON.parse(readFileSync(join(root, "test", "bash-known.json"), "utf8")),
  step2: JSON.parse(readFileSync(join(root, "test", "bash-step2-known.json"), "utf8")),
};
const page = `<!doctype html><meta charset="utf-8"><script type="module" src="/page.js"></script>`;
const pageJs = `import { run } from "/host-cases.js"; window.run = run; window.ready = true;`;
mkdirSync(join(dir, "shell"), { recursive: true });
cpSync(join(here, "worker-boot.js"), join(dir, "shell", "worker-boot.js"));

const server = createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const iso = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
  const send = (type, body, extra = {}) => res.writeHead(200, { "Content-Type": type, ...iso, ...extra }).end(body);
  if (path === "/") return send("text/html", page, { "Content-Security-Policy": pagePolicy() });
  if (path === "/page.js") return send("text/javascript", pageJs);
  if (path === "/host-cases.js") return send("text/javascript", readFileSync(join(here, "host-cases.js")));
  if (path === "/host-bundle.js") return send("text/javascript", readFileSync(join(dir, "host-bundle.js")));
  if (path === "/data.json") return send("application/json", JSON.stringify(data));
  if (path === "/shell/worker-boot.js") return send("text/javascript", readFileSync(join(dir, "shell", "worker-boot.js")), { "Content-Security-Policy": shellWorkerPolicy() });
  const m = /^\/(pkgset|pkg)\/([0-9a-f]{64})\.json$/.exec(path);
  if (m && existsSync(join(dir, m[1], m[2] + ".json"))) return send("application/json", readFileSync(join(dir, m[1], m[2] + ".json")));
  res.writeHead(404, iso).end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));

const profile = mkdtempSync(join(tmpdir(), "sb-test-shell-host-chrome-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
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
  const only = process.env.ONLY ? JSON.stringify(process.env.ONLY) : "undefined";
  const results = await evaluate(`window.run(${only})`);
  const fails = results.filter(([ok]) => !ok).map(([, what]) => what);
  for (const e of errors) fails.push("page error: " + e);
  if (process.env.SHOW) for (const [ok, what] of results) console.log((ok ? "ok   " : "FAIL ") + what);
  if (fails.length) console.error(`FAIL: ${fails.length} of ${results.length} checks\n  ` + fails.join("\n  "));
  else {
    console.log(`ok: ShellHost, ${results.length} checks`);
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
