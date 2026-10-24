// The bash shell's loader and its worker (plan-bash-shell r3 §1.3–§1.6, §6;
// r4 addendum A1), in headless Chromium, against a server of its own: a set
// built from optional/bash by the publisher, web/shell/worker-boot.js with the
// policy web/csp.ts writes for it, and a page that runs web/shell/loader.ts.
//   bun web/test-shell.mjs        (CHROME=... for the browser)
// Checks:
// - the shell starts from the set's pinned bytes, and every registered
//   command (§8) runs under the worker's own policy: no eval needed (N3);
//   commands it doesn't register (curl, python3, js-exec, sqlite3, tee) are
//   not there;
// - the worker's policy is the boundary: from inside it, fetch, XHR,
//   WebSocket, EventSource, a module from another URL, importScripts, eval and
//   new Function all fail (§6), whatever the module is;
// - the page's realm never evaluates the module: it makes no blob: script;
// - refusals before anything starts: a set without the shell (N5), a shell
//   built for a newer host level (A1.4), a chunk that isn't its pin;
// - _headers gives /shell/worker-boot.js exactly that policy (web/csp.ts);
// - the per-realm resident estimate (N1): the page's and the worker's heaps
//   while the module is held, against A1.2's 4b per realm.
import { spawn, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "./test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const root = join(here, "..");
let failures = 0;
const ok = (cond, name) => {
  console.log((cond ? "ok   " : "FAIL ") + name);
  if (!cond) failures++;
};
setTimeout(() => {
  console.log("FAIL the test did not end within 240 s");
  process.exit(1);
}, 240_000).unref();
const { shellWorkerPolicy, pagePolicy } = await import(join(here, "csp-policy.mts"));

// the sets: the shell's, a copy whose shell needs a newer host level, one without the shell
const dir = mkdtempSync(join(tmpdir(), "sb-test-shell-"));
const build = (name) => execFileSync("node", [join(root, "scripts", "optional-packages.mjs"), "build", "--out", dir, name], { encoding: "utf8" }).trim().split("\n").at(-1);
const S = build("bash");
const NO_SHELL = build("hello");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const index = JSON.parse(readFileSync(join(dir, "pkgset", S + ".json"), "utf8"));
index.packages["@sagebrush/bash@0.1.0"].js.host_req = 99;
const canon = (await import(join(root, "scripts", "optional-packages.mjs"))).canonical;
const newer = Buffer.from(canon(index));
const NEWER = sha(newer);
writeFileSync(join(dir, "pkgset", NEWER + ".json"), newer);
const chunkSha = index.packages["@sagebrush/bash@0.1.0"].js.sha256;
let tamper = false; // serve the shell's chunk with one byte changed

// the page: web/shell/loader.ts, bundled for this test only
execFileSync("bun", ["build", join(here, "shell", "loader.ts"), "--target=browser", "--format=esm", `--outfile=${join(dir, "loader.js")}`], { stdio: ["ignore", "ignore", "inherit"] });
const page = `<!doctype html><meta charset="utf-8"><script type="module" src="/test-shell-page.js"></script>`;
const pageJs = `import { startShell } from "/loader.js";
const made = [];
const create = URL.createObjectURL;
URL.createObjectURL = (b) => (made.push(b && b.type), create(b));
window.startShell = startShell;
window.blobScripts = () => made.filter((t) => /javascript/.test(String(t))).length;
window.ready = true;`;
mkdirSync(join(dir, "shell"), { recursive: true });
cpSync(join(here, "shell", "worker-boot.js"), join(dir, "shell", "worker-boot.js"));
writeFileSync(join(dir, "index.html"), page);
// (the policy web/csp.ts writes for the boot script, read back from its _headers)
const { headersFor } = await import(join(here, "csp.ts"));
const headers = headersFor(dir);
const rule = headers.split("\n/").find((b) => b.startsWith("shell/worker-boot.js\n"));
ok(rule && rule.includes(`Content-Security-Policy: ${shellWorkerPolicy()}`) && rule.split("Content-Security-Policy").length === 2, "_headers: /shell/worker-boot.js has exactly the shell worker's policy");

const server = createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const iso = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
  const send = (type, body, extra = {}) => res.writeHead(200, { "Content-Type": type, ...iso, ...extra }).end(body);
  if (path === "/") return send("text/html", page, { "Content-Security-Policy": pagePolicy() });
  if (path === "/test-shell-page.js") return send("text/javascript", pageJs);
  if (path === "/loader.js") return send("text/javascript", readFileSync(join(dir, "loader.js")));
  if (path === "/shell/worker-boot.js") return send("text/javascript", readFileSync(join(dir, "shell", "worker-boot.js")), { "Content-Security-Policy": shellWorkerPolicy() });
  if (path === "/probe.txt") return send("text/plain", "reachable");
  const m = /^\/(pkgset|pkg)\/([0-9a-f]{64})\.json$/.exec(path);
  if (m && existsSync(join(dir, m[1], m[2] + ".json"))) {
    const b = readFileSync(join(dir, m[1], m[2] + ".json"));
    if (tamper && m[2] === chunkSha) b[b.length - 10] ^= 1;
    return send("application/json", b);
  }
  res.writeHead(404, iso).end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

// Chromium, one page, and a CDP evaluate()
const profile = mkdtempSync(join(tmpdir(), "sb-test-shell-chrome-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", "--js-flags=--expose-gc", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let ws;
try {
  const port = await devtoolsPort(profile);
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) (waiting.get(m.id)(m), waiting.delete(m.id));
  };
  const send = (method, params = {}) => new Promise((r) => {
    const id = ++seq;
    waiting.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text };
    return r.result?.result?.value;
  };
  await send("Page.navigate", { url });
  for (let i = 0; i < 100 && (await evaluate("window.ready === true")) !== true; i++) await new Promise((r) => setTimeout(r, 100));

  // the shell, and every registered command under the worker's policy (N3)
  const run = await evaluate(`(async () => {
    const sh = await startShell(${JSON.stringify(S)}, "/");
    const out = {};
    const cmds = {
      ls: "mkdir -p d && touch d/x && ls d", cat: "echo a > f && cat f", head: "seq 5 | head -2", tail: "seq 5 | tail -1", wc: "printf 'a b\\\\n' | wc -w",
      mkdir: "mkdir -p m/n && echo ok", mv: "echo x > a1 && mv a1 b1 && cat b1", cp: "echo y > c1 && cp c1 c2 && cat c2", rm: "touch r1 && rm r1 && echo gone",
      touch: "touch t1 && ls t1", stat: "touch s1 && stat -c %n s1", tree: "mkdir -p tr/a && tree tr", find: "mkdir -p fd && touch fd/z && find fd -name z",
      grep: "printf 'a\\\\nb\\\\n' | grep b", sort: "printf 'b\\\\na\\\\n' | sort", uniq: "printf 'a\\\\na\\\\n' | uniq", cut: "echo a:b | cut -d: -f2", tr: "echo ab | tr a-z A-Z",
      sed: "echo hello | sed s/l/L/g", awk: "echo 1 2 | awk '{print $1+$2}'", diff: "echo a > d1 && echo b > d2; diff d1 d2; echo rc=$?",
      echo: "echo hi", printf: "printf '%05d\\\\n' 42", pwd: "pwd", basename: "basename /a/b.txt", dirname: "dirname /a/b.txt", env: "env | grep -c PATH",
      true: "true && echo t", false: "false || echo f", seq: "seq 3", jq: "echo '{\\"a\\":[1,2]}' | jq '.a[1]'",
      cd: "mkdir -p cdd && cd cdd && pwd", export: "export X=5 && env | grep X=5", test: "test 1 -lt 2 && echo lt",
    };
    for (const [name, script] of Object.entries(cmds)) out[name] = await sh.exec(script);
    const absent = {};
    for (const name of ["curl", "python3", "js-exec", "sqlite3", "tee", "node"]) absent[name] = await sh.exec(name + " --version");
    return { S: sh.S, version: sh.version, out, absent, blobScripts: blobScripts() };
  })()`);
  ok(run && !run.error && run.S === S && run.version === "0.1.0", `the shell starts from set ${S.slice(0, 12)} (${run?.error ?? run?.version})`);
  const failed = Object.entries(run?.out ?? {}).filter(([, r]) => r.exitCode !== 0 || /Content Security Policy|EvalError|unsafe-eval/.test(r.stderr));
  ok(run?.out && Object.keys(run.out).length === 34 && !failed.length, `every registered command runs under the worker's policy (N3)${failed.length ? ": " + JSON.stringify(failed).slice(0, 600) : ""}`);
  ok(run?.out?.jq?.stdout === "2\n" && run?.out?.awk?.stdout === "3\n" && run?.out?.printf?.stdout === "00042\n" && run?.out?.diff?.stdout?.includes("rc=1"), "and they compute what they should (jq, awk, printf, diff)");
  // (python3 and sqlite3: the browser bundle answers "not available in browser environments", 127, for them)
  const present = Object.entries(run?.absent ?? {}).filter(([, r]) => r.exitCode !== 127 || !/command not found|not available in browser environments/.test(r.stderr));
  ok(run?.absent && !present.length, `commands outside §8 aren't registered (curl, python3, js-exec, sqlite3, tee, node)${present.length ? ": " + JSON.stringify(present).slice(0, 300) : ""}`);
  ok(run?.blobScripts === 0, "the page's realm never makes a script of the module (no blob: script in the page)");

  // the worker's policy is the boundary: a module that tries everything, through the same bootstrap
  const probe = await evaluate(`(async () => {
    const text = \`export function start(port) {
      const tries = {
        fetch: () => fetch("/probe.txt").then((r) => r.text()),
        xhr: () => new Promise((ok, no) => { const x = new XMLHttpRequest(); x.open("GET", "/probe.txt"); x.onload = () => ok(x.responseText); x.onerror = () => no(new Error("xhr error")); x.send(); }),
        websocket: () => new Promise((ok, no) => { const w = new WebSocket("ws://127.0.0.1:9/"); w.onopen = () => ok("open"); w.onerror = () => no(new Error("ws error")); }),
        eventsource: () => new Promise((ok, no) => { const s = new EventSource("/probe.txt"); s.onopen = () => ok("open"); s.onerror = () => no(new Error("es error")); }),
        foreignImport: () => import("https://example.com/x.js"),
        sameSiteImport: () => import("/loader.js"),
        importScripts: () => importScripts("/loader.js"),
        eval: () => eval("1 + 1"),
        newFunction: () => new Function("return 2")(),
      };
      (async () => {
        const result = {};
        for (const [k, f] of Object.entries(tries)) {
          try { await Promise.race([Promise.resolve().then(f), new Promise((_, no) => setTimeout(() => no(new Error("timeout")), 3000))]); result[k] = "ALLOWED"; }
          catch (e) { result[k] = "refused: " + String(e && e.message).slice(0, 80); }
        }
        port.postMessage({ name: "probe", payload: result });
      })();
    }\`;
    const w = new Worker("/shell/worker-boot.js", { type: "module" });
    const { port1, port2 } = new MessageChannel();
    const got = new Promise((r) => (port1.onmessage = (e) => r(e.data)));
    w.postMessage({ text, port: port2 }, [port2]);
    const m = await got;
    w.terminate();
    return m;
  })()`);
  const allowed = Object.entries(probe?.payload ?? {}).filter(([k, v]) => v === "ALLOWED" && k !== "sameSiteImport");
  ok(probe?.name === "probe" && !allowed.length, `inside the shell worker, fetch, XHR, WebSocket, EventSource, a foreign module, importScripts, eval and new Function all fail${allowed.length ? ": ALLOWED " + allowed.map(([k]) => k).join(", ") : ""} (${JSON.stringify(probe?.payload ?? probe).slice(0, 300)})`);

  // refusals, before any worker starts
  const refusal = async (s) => evaluate(`startShell(${JSON.stringify(s)}, "/").then(() => "started", (e) => String(e.message))`);
  ok(/has no shell; update the set/.test(await refusal(NO_SHELL)), "a set without the shell is refused, and no other set is used instead (N5)");
  ok(/needs a newer Sagebrush/.test(await refusal(NEWER)), "a shell built for a newer host level is refused before it starts (A1.4)");
  tamper = true;
  ok(/not the one the index pins/.test(await refusal(S)), "a chunk that isn't the pinned bytes is refused");
  tamper = false;

  // N1, per realm (A1.2): what the page keeps once the module is posted, and
  // the shell worker's heap while it holds the module (its structured-clone
  // copy, the Blob, the module's source and the shell), both after a GC
  const workers = new Map(); // sessionId -> url
  const onAttach = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "worker") workers.set(m.params.sessionId, m.params.targetInfo.url);
  };
  ws.addEventListener("message", onAttach);
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const used = () => evaluate("(gc(), performance.memory.usedJSHeapSize)");
  const before = await used();
  await evaluate(`(async () => { window.sh2 = await startShell(${JSON.stringify(S)}, "/"); return (await sh2.exec("echo ok")).stdout; })()`);
  const pageAfter = await used();
  await new Promise((r) => setTimeout(r, 300));
  const sid = [...workers].find(([, u]) => /worker-boot\.js$/.test(u))?.[0];
  const sendTo = (method, params = {}) => new Promise((r) => {
    const id = ++seq;
    waiting.set(id, r);
    ws.send(JSON.stringify({ id, method, params, sessionId: sid }));
  });
  if (sid) await sendTo("HeapProfiler.collectGarbage");
  const wheap = sid ? (await sendTo("Runtime.getHeapUsage")).result : null;
  const moduleBytes = Buffer.byteLength(JSON.parse(readFileSync(join(dir, "pkg", chunkSha + ".json"), "utf8")).modules["shell.js"]);
  console.log(`info N1: module b = ${moduleBytes} bytes, 4b = ${4 * moduleBytes}; page keeps ${pageAfter - before} bytes after a GC; the shell worker's heap ${wheap?.usedSize} bytes (of ${wheap?.totalSize})`);
  ok(pageAfter - before <= moduleBytes, "the page keeps less than b once the module is posted: its copies are released (N1, page realm)");
  ok(wheap && wheap.usedSize > 0 && wheap.usedSize <= 4 * moduleBytes + 16 * 2 ** 20, "the shell worker's heap is within 4b plus the shell's live set (16 MiB measured allowance) (N1, worker realm)");
  await evaluate("sh2.terminate()");
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  server.close();
  rmSync(profile, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
