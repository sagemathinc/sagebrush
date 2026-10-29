// The bash shell's loader and its worker (plan-bash-shell r3 §1.3–§1.6, §6;
// r4 addendum A1), in headless Chromium, against a server of its own: a set
// built from optional/bash by the publisher, web/shell/worker-boot.js with the
// policy web/csp.ts writes for it, and a page that runs web/shell/loader.ts.
//   bun web/test-shell.mjs        (CHROME=... for the browser)
//   BROWSER=firefox|webkit PLAYWRIGHT=<playwright's index.mjs> bun web/test-shell.mjs
//                                  (the other two engines of N3, through playwright: on a VM; N1's heap
//                                  figures are Chromium's alone)
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
// - boundedFetch (in bun, not the browser): one destination, each chunk copied
//   in as it arrives and never kept (a source that reuses one buffer for every
//   one-byte chunk still arrives intact), the bounds exact, a ceiling-size
//   body's footprint (LIMIT-PR119-1);
// - the census of names that run besides §8's commands: the interpreter's
//   builtins, exactly (N-119-2);
// - the shell's lifecycle (CORR-PR119-1, LIMIT-PR119-2, GRADER-PR119-1), with
//   modules that misbehave, each pinned in a set of its own: a failed boot
//   (five times), a module that never says ready (aborted by the caller), a
//   rejection inside the real module, terminate() during an invocation and
//   exec() after it, a worker that throws after ready, an exit code out of
//   0..255.  Each settles, none hangs (a timeout on each), and no worker or
//   channel is left;
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
// (step 3: the worker's one init, as ShellHost sends it with the default config; +Infinity crosses into the page as a
// string, revived there)
const Lm = await import(join(here, "shell", "limits.ts"));
// (r3, astra5 B3R2-A5-1: limits.ts loads as a native ES module, under bun's own module semantics, not a bundle: a
// const read before its declaration by a module-level call would have thrown at the import above)
ok(Lm.MAPPED_LIMITS.includes("maxSourceBytes") && Lm.executionLimitsOf(Lm.validateBash()).maxSourceBytes === Lm.BASH_RANGES.source_bytes.def + Lm.WRAPPER_BYTES,
  `limits.ts loads as a native ES module, its module-level census computed (${Lm.MAPPED_LIMITS.length} mapped limits; maxSourceBytes = source_bytes + ${Lm.WRAPPER_BYTES})`);
const INIT_JSON = JSON.stringify({ limits: Lm.executionLimitsOf(Lm.validateBash()), pipelineWidth: Lm.validateBash().pipeline_width }, (k, v) => (v === Infinity ? "Infinity" : v));

// the sets: the shell's, a copy whose shell needs a newer host level, one without the shell
const dir = mkdtempSync(join(tmpdir(), "sb-test-shell-"));
const build = (name) => execFileSync("node", [join(root, "scripts", "optional-packages.mjs"), "build", "--out", dir, name], { encoding: "utf8" }).trim().split("\n").at(-1);
const S = build("bash");
const NO_SHELL = build("hello");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const index = JSON.parse(readFileSync(join(dir, "pkgset", S + ".json"), "utf8"));
const KEY = Object.keys(index.packages).find((k) => k.startsWith("@sagebrush/bash@"));
index.packages[KEY].js.host_req = 99;
const canon = (await import(join(root, "scripts", "optional-packages.mjs"))).canonical;
const newer = Buffer.from(canon(index));
const NEWER = sha(newer);
writeFileSync(join(dir, "pkgset", NEWER + ".json"), newer);
const chunkSha = index.packages[KEY].js.sha256;
let tamper = false; // serve the shell's chunk with one byte changed
let longer = false; // serve it with one byte more than its declared size (stage 2)
// (stage 3: a chunk within its declared size whose notices are one byte past 256 KiB)
const chunk = JSON.parse(readFileSync(join(dir, "pkg", chunkSha + ".json"), "utf8"));
const bigChunk = Buffer.from(canon({ ...chunk, notices: "x".repeat(256 * 1024 + 1) }));
writeFileSync(join(dir, "pkg", sha(bigChunk) + ".json"), bigChunk);
const bigIndex = JSON.parse(readFileSync(join(dir, "pkgset", S + ".json"), "utf8"));
bigIndex.packages[KEY].js.sha256 = sha(bigChunk);
bigIndex.packages[KEY].js.size = bigChunk.length;
const bigIx = Buffer.from(canon(bigIndex));
const BIG_NOTICES = sha(bigIx);
writeFileSync(join(dir, "pkgset", BIG_NOTICES + ".json"), bigIx);
// (a set like S whose shell module is `text`: pinned, so it passes every check and reaches the worker)
const withModule = (text) => {
  const c = Buffer.from(canon({ ...chunk, modules: { "shell.js": text } }));
  writeFileSync(join(dir, "pkg", sha(c) + ".json"), c);
  const ix = JSON.parse(readFileSync(join(dir, "pkgset", S + ".json"), "utf8"));
  Object.assign(ix.packages[KEY].js, { sha256: sha(c), size: c.length });
  const b = Buffer.from(canon(ix));
  writeFileSync(join(dir, "pkgset", sha(b) + ".json"), b);
  return sha(b);
};
const ready = `port.postMessage({ name: "shell.ready", payload: { version: "t" } });`;
// (the real module, unchanged, after a line that makes the worker's TextEncoder throw a plain Error for
// text holding "refuse-me": just-bash's in-memory file system encodes what a redirection writes, so
// `echo refuse-me > f` fails there as a refused workspace write will, and unwrapped, as step 1 runs
// scripts, just-bash's exec() rejects.  Nothing depends on how the module was minified.)
const refusing = `{ const encode = TextEncoder.prototype.encode; TextEncoder.prototype.encode = function (s) { if (String(s).includes("refuse-me")) throw new Error("refused on purpose"); return encode.call(this, s); }; }\n`;
const BAD = {
  reject: withModule(refusing + chunk.modules["shell.js"]),
  // start() takes the port, then throws: the bootstrap posts boot.failed
  boot: withModule(`export function start(port) { port.onmessage = () => {}; throw new Error("start failed on purpose"); }`),
  // never says ready
  never: withModule(`export function start(port) { port.onmessage = () => {}; }`),
  // ready, and never answers
  silent: withModule(`export function start(port) { port.onmessage = () => {}; ${ready} }`),
  // ready, then its worker throws once asked anything
  late: withModule(`export function start(port) { port.onmessage = () => setTimeout(() => { throw new Error("late failure on purpose"); }); ${ready} }`),
  // ready, and answers with an exit code no shell has
  code: withModule(`export function start(port) { port.onmessage = (e) => port.postMessage({ name: "shell.result", payload: { id: e.data.exec.id, exit: { code: -1, stdout: "", stderr: "" } } }); ${ready} }`),
};

// The census (N-119-2): every name below that isn't one of §8's commands is
// run as `{ NAME --help >/dev/null 2>&1; echo "rc=$?"; }` in the shipped
// shell; those that don't answer 127 must be exactly BUILTINS, the
// interpreter's own builtins, which run whatever `commands:` registers
// (optional/bash/README.md lists them).  The candidates: bash 5's builtins,
// just-bash 3.6.0's command registry (getCommandNames()), and the network and
// runtime names.  A just-bash that adds a builtin under any of them fails here.
const SECTION8 = ["ls", "cat", "head", "tail", "wc", "mkdir", "mv", "cp", "rm", "touch", "stat", "tree", "find", "grep", "sort", "uniq", "cut", "tr", "sed", "awk", "diff", "echo", "printf", "pwd", "basename", "dirname", "env", "true", "false", "seq", "jq"];
const BASH_BUILTINS = ". : [ alias bg bind break builtin caller cd command compgen complete compopt continue declare dirs disown echo enable eval exec exit export false fc fg getopts hash help history jobs kill let local logout mapfile popd printf pushd pwd read readarray readonly return set shift shopt source suspend test times trap true type typeset ulimit umask unalias unset wait".split(" ");
const JB_REGISTRY = ["echo", "cat", "printf", "ls", "mkdir", "mktemp", "rmdir", "touch", "rm", "cp", "mv", "ln", "chmod", "pwd", "readlink", "head", "tail", "wc", "stat", "grep", "fgrep", "egrep", "rg", "sed", "awk", "sort", "uniq", "comm", "cut", "paste", "tr", "rev", "nl", "fold", "expand", "unexpand", "strings", "split", "column", "join", "tee", "find", "basename", "dirname", "tree", "du", "env", "printenv", "alias", "unalias", "history", "xargs", "true", "false", "yes", "clear", "bash", "sh", "jq", "base64", "diff", "date", "sleep", "timeout", "time", "seq", "expr", "md5sum", "sha1sum", "sha256sum", "file", "html-to-markdown", "help", "which", "tac", "hostname", "whoami", "od", "gzip", "gunzip", "zcat", "tar", "yq", "xan", "sqlite3"];
const CENSUS_NAMES = [...new Set([...BASH_BUILTINS, ...JB_REGISTRY, "curl", "wget", "python", "python3", "node", "js-exec", "realpath"])].filter((n) => !SECTION8.includes(n));
const BUILTINS = ". : [ break builtin cd command compgen complete compopt continue declare dirs eval exec exit export getopts hash help let local mapfile popd pushd read readarray readonly return set shift shopt source test type typeset unset wait".split(" ");

// the page: web/shell/loader.ts, bundled for this test only
execFileSync("bun", ["build", join(here, "shell", "loader.ts"), "--target=browser", "--format=esm", `--outfile=${join(dir, "loader.js")}`], { stdio: ["ignore", "ignore", "inherit"] });
// (and the host with the workspace, loaded only when a run needs it: from step 2 the module reaches files only
// through ShellHost, the page's mediator.  Loaded on demand, so N1's page, freshly loaded, never holds it)
const hostEntry = join(dir, "host-entry.ts");
writeFileSync(hostEntry, `export { ShellHost } from ${JSON.stringify(join(here, "shell", "host.ts"))};\nexport { Workspace } from ${JSON.stringify(join(here, "workspace", "index.ts"))};\n`);
execFileSync("bun", ["build", hostEntry, "--target=browser", "--format=esm", `--outfile=${join(dir, "host.js")}`], { stdio: ["ignore", "ignore", "inherit"] });
const page = `<!doctype html><meta charset="utf-8"><script type="module" src="/test-shell-page.js"></script>`;
const pageJs = `import { startShell } from "/loader.js";
const made = [];
const create = URL.createObjectURL;
URL.createObjectURL = (b) => (made.push(b && b.type), create(b));
const posted = [];
let workers = 0, ended = 0, closes = 0;
const W = window.Worker;
window.Worker = class extends W { constructor(...a) { super(...a); workers++; } postMessage(m, t) { posted.push(JSON.stringify(Object.fromEntries(Object.entries(m ?? {}).filter(([, v]) => typeof v === "string"))).includes("Third-party notices for @sagebrush/bash")); return super.postMessage(m, t); } terminate() { ended++; return super.terminate(); } };
const close = MessagePort.prototype.close;
MessagePort.prototype.close = function () { closes++; return close.call(this); };
window.workersMade = () => workers;
window.workersLive = () => workers - ended;
window.portsClosed = () => closes;
// (only whether each message carried the notices: keeping the messages would keep each module's text in the page, against N1)
window.noticesPosted = () => posted.some(Boolean);
window.startShell = startShell;
window.INIT = JSON.parse(${JSON.stringify(INIT_JSON)}, (k, v) => (v === "Infinity" ? Infinity : v));
// (the module's runs here go through a real ShellHost over a real Workspace; the lifecycle checks, which run
// the module's exec() directly, give it an empty file system as its mediator: nothing exists)
window.hostOver = async (sh) => {
  const { ShellHost, Workspace } = await import("/host.js");
  localStorage.clear();
  const ws = await Workspace.open({ name: "test-shell-" + Math.random().toString(16).slice(2), mainName: "test-shell-main-" + Math.random().toString(16).slice(2) });
  const host = new ShellHost(ws, async () => sh);
  return (script) => host.exec({ kind: "person" }, script).then((r) => (r.kind === "exit" ? { exit: { code: r.code, stdout: r.stdout, stderr: r.stderr } } : { typed: r }));
};
window.EMPTY_FS = { onRequest: async (r) => (r.op === "exists" ? { ok: false } : { err: { code: "ENOENT", message: "no such file or directory" } }) };
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

// boundedFetch, in bun (LIMIT-PR119-1).  `source` is a body of `bytes` in
// chunks of `chunk` bytes, pulled one at a time, from ONE buffer it overwrites
// for each chunk: a loader that kept a chunk past its read would end with the
// filler 0xEE in its place.
{
  const { boundedFetch } = await import(join(here, "shell", "loader.ts"));
  const { PKGSET_LIMITS } = await import(join(root, "src", "pkgset.ts"));
  const source = (bytes, { chunk = 1, headers = {}, fresh = false } = {}) => {
    const buf = new Uint8Array(chunk);
    const st = { at: 0, pulls: 0, cancelled: false };
    const body = new ReadableStream({
      pull(c) {
        st.pulls++;
        if (st.at >= bytes.length) return c.close();
        const n = Math.min(chunk, bytes.length - st.at);
        const b = fresh ? new Uint8Array(n) : buf;
        b.fill(0xee);
        b.set(bytes.subarray(st.at, st.at + n));
        st.at += n;
        c.enqueue(b.subarray(0, n));
        st.onPull?.();
      },
      cancel() { st.cancelled = true; },
    }, { highWaterMark: 0 });
    return { st, res: { status: 200, headers: new Headers(headers), body } };
  };
  const realFetch = globalThis.fetch;
  const via = async (src, max, opts) => {
    globalThis.fetch = async () => src.res;
    try { return { got: await boundedFetch("http://x/b", max, opts) }; } catch (e) { return { err: String(e.message) }; } finally { globalThis.fetch = realFetch; }
  };
  const pattern = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 0x7f);
  const p = pattern(65536);
  let src = source(p);
  let r = await via(src, p.length, { exact: true });
  ok(r.got && r.got.length === p.length && Buffer.compare(Buffer.from(r.got), Buffer.from(p)) === 0 && src.st.pulls >= p.length, "boundedFetch: 65,536 one-byte chunks from one reused buffer arrive intact: each is copied in as it arrives, none kept (LIMIT-PR119-1)");
  r = await via(source(p, { chunk: 1000 }), p.length + 1, { exact: true });
  ok(/65536 bytes, not the 65537 declared/.test(r.err ?? ""), `a body one byte short of its exact size is refused (${r.err ?? "accepted"})`);
  src = source(p, { chunk: 1000 });
  r = await via(src, p.length - 1, { exact: true });
  ok(/over 65535 bytes/.test(r.err ?? "") && src.st.cancelled, `a body one byte past its exact size is refused, and its stream cancelled (${r.err ?? "accepted"})`);
  r = await via(source(p, { chunk: 1000 }), p.length, { exact: true });
  ok(r.got?.length === p.length, "and one of exactly its size is taken");
  // the index's path: no exact size, at most 256 KiB
  const I = PKGSET_LIMITS.indexBytes;
  r = await via(source(pattern(1000)), I);
  ok(r.got?.length === 1000 && r.got[999] === pattern(1000)[999], "the index's path: 1,000 one-byte chunks, no Content-Length, into one destination of at most 256 KiB");
  src = source(pattern(I + 1), { chunk: 4096 });
  r = await via(src, I);
  ok(/over 262144 bytes/.test(r.err ?? "") && src.st.cancelled, "an index one byte past 256 KiB is refused while streaming");
  src = source(pattern(100), { headers: { "content-length": String(I + 1) } });
  r = await via(src, I);
  ok(/over 262144 bytes/.test(r.err ?? "") && src.st.pulls === 0, "a Content-Length past the bound is refused before any byte is read");
  r = await via(source(pattern(99), { headers: { "content-length": "100" } }), I);
  ok(/99 bytes, not the 100 declared/.test(r.err ?? ""), "a body short of its Content-Length is refused");
  r = await via(source(pattern(300), { headers: { "content-length": "100", "content-encoding": "gzip" } }), I);
  ok(r.got?.length === 300, "with a Content-Encoding, the Content-Length (the encoded size) isn't taken as the body's");
  // a ceiling-size body (A1.2's 8 MiB chunk cap), in fresh 64 KiB chunks: what's
  // held while it streams (sampled after a GC every 16 chunks) is the one
  // destination plus a chunk or two
  const C = PKGSET_LIMITS.jsBytes;
  const big = new Uint8Array(C).fill(0x61);
  src = source(big, { chunk: 65536, fresh: true });
  Bun.gc(true);
  const base = process.memoryUsage().arrayBuffers;
  let peak = 0;
  src.st.onPull = () => { if (src.st.pulls % 16 === 0) { Bun.gc(true); peak = Math.max(peak, process.memoryUsage().arrayBuffers - base); } };
  r = await via(src, C, { exact: true });
  const held = r.got?.length;
  src = r = null;
  console.log(`info boundedFetch at the 8 MiB ceiling: ${held} bytes; at most ${peak} array-buffer bytes more than before it, while streaming (the source's own ${C} not counted)`);
  ok(held === C && peak <= C + 2 ** 20, "a ceiling-size body streams into one destination of its size, plus at most 1 MiB in flight");
}

const server = createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const iso = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
  const send = (type, body, extra = {}) => res.writeHead(200, { "Content-Type": type, ...iso, ...extra }).end(body);
  if (path === "/") return send("text/html", page, { "Content-Security-Policy": pagePolicy() });
  if (path === "/test-shell-page.js") return send("text/javascript", pageJs);
  if (path === "/loader.js") return send("text/javascript", readFileSync(join(dir, "loader.js")));
  if (path === "/host.js") return send("text/javascript", readFileSync(join(dir, "host.js")));
  if (path === "/shell/worker-boot.js") return send("text/javascript", readFileSync(join(dir, "shell", "worker-boot.js")), { "Content-Security-Policy": shellWorkerPolicy() });
  if (path === "/probe.txt") return send("text/plain", "reachable");
  const m = /^\/(pkgset|pkg)\/([0-9a-f]{64})\.json$/.exec(path);
  if (m && existsSync(join(dir, m[1], m[2] + ".json"))) {
    const b = readFileSync(join(dir, m[1], m[2] + ".json"));
    if (tamper && m[2] === chunkSha) b[b.length - 10] ^= 1;
    return send("application/json", longer && m[2] === chunkSha ? Buffer.concat([b, Buffer.from(" ")]) : b);
  }
  res.writeHead(404, iso).end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

// The browser: Chromium through CDP (CI), or BROWSER=firefox|webkit through
// playwright (PLAYWRIGHT=<its index.mjs>; the three engines of N3, run on a
// VM).  evaluate() returns the value, or {error}.
const ENGINE = process.env.BROWSER ?? "chromium";
const profile = mkdtempSync(join(tmpdir(), "sb-test-shell-chrome-"));
let chrome = null, ws = null, pwBrowser = null;
try {
  let evaluate, navigate, cdp = null;
  if (ENGINE === "chromium") {
    chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", "--js-flags=--expose-gc", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
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
    const send = (method, params = {}, sessionId) => new Promise((r) => {
      const id = ++seq;
      waiting.set(id, r);
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    evaluate = async (expression) => {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text };
      return r.result?.result?.value;
    };
    navigate = (u) => send("Page.navigate", { url: u });
    cdp = { ws, send };
  } else {
    const pw = await import(process.env.PLAYWRIGHT ?? "playwright");
    pwBrowser = await (pw[ENGINE] ?? pw.default[ENGINE]).launch();
    const page = await pwBrowser.newPage();
    evaluate = async (expression) => {
      try {
        return await page.evaluate(expression);
      } catch (e) {
        return { error: String(e?.message ?? e) };
      }
    };
    navigate = (u) => page.goto(u);
  }
  console.log(`info engine: ${ENGINE}`);
  await navigate(url);
  for (let i = 0; i < 100 && (await evaluate("window.ready === true")) !== true; i++) await new Promise((r) => setTimeout(r, 100));

  // (N1 needs Chromium's heap figures: CDP and performance.memory.  First, before any check loads the host
  // and the workspace (host.js), so what the page holds is the loader's alone)
  if (cdp) {
    // N1, per realm (A1.2): what the page keeps once the module is posted, and
    // the shell worker's heap while it holds the module (its structured-clone
    // copy, the Blob, the module's source and the shell), both after a GC
    const workers = new Map(); // sessionId -> url
    const onAttach = (e) => {
      const m = JSON.parse(e.data);
      if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "worker") workers.set(m.params.sessionId, m.params.targetInfo.url);
    };
    cdp.ws.addEventListener("message", onAttach);
    await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const used = () => evaluate("(gc(), performance.memory.usedJSHeapSize)");
    // (a warm-up shell first: from one start to the next, the page's used heap after a GC swings by a few MB
    // either way, while its heap snapshot holds no object near b (so not a copy of the module).  That aggregate
    // figure is therefore reported only, never gated: the heap snapshot below is the check.)
    const cold = await used();
    await evaluate(`(async () => { const { shell } = await startShell(${JSON.stringify(S)}, "/"); await shell.configure(INIT); await shell.exec("true", EMPTY_FS); shell.terminate(); })()`);
    const before = await used();
    console.log(`info N1: after the warm-up shell, the page's used heap moved ${before - cold} bytes`);
    await evaluate(`(async () => { window.sh2 = (await startShell(${JSON.stringify(S)}, "/")).shell; await sh2.configure(INIT); return (await sh2.exec("echo ok", { ...EMPTY_FS, allowance: 100 })).exit.stdout; })()`);
    const pageAfter = await used();
    // the page's heap snapshot, with the shell running: its largest objects (a copy of the module, its chunk's
    // JSON or bytes would be one of b or more)
    const chunks = [];
    const onChunk = (e) => { const m = JSON.parse(e.data); if (m.method === "HeapProfiler.addHeapSnapshotChunk") chunks.push(m.params.chunk); };
    cdp.ws.addEventListener("message", onChunk);
    await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
    cdp.ws.removeEventListener("message", onChunk);
    const snap = JSON.parse(chunks.join(""));
    const nf = snap.snapshot.meta.node_fields.length, iSize = snap.snapshot.meta.node_fields.indexOf("self_size");
    let largest = 0;
    for (let i = iSize; i < snap.nodes.length; i += nf) largest = Math.max(largest, snap.nodes[i]);
    await new Promise((r) => setTimeout(r, 300));
    // (the newest shell worker: sh2's; the warm-up's, attached first, has been terminated)
    const sid = [...workers].filter(([, u]) => /worker-boot\.js$/.test(u)).at(-1)?.[0];
    const sendTo = (method, params = {}) => cdp.send(method, params, sid);
    if (sid) await sendTo("HeapProfiler.collectGarbage");
    const wheap = sid ? (await sendTo("Runtime.getHeapUsage")).result : null;
    const moduleBytes = Buffer.byteLength(JSON.parse(readFileSync(join(dir, "pkg", chunkSha + ".json"), "utf8")).modules["shell.js"]);
    console.log(`info N1: module b = ${moduleBytes} bytes, 4b = ${4 * moduleBytes}; page keeps ${pageAfter - before} bytes after a GC; the shell worker's heap ${wheap?.usedSize} bytes (of ${wheap?.totalSize})`);
    console.log(`info N1: the page's largest live object, with the shell running: ${largest} bytes`);
    // (diagnostic only: one post-GC sample of the whole page heap against another swings by more than b, an object's size)
    console.log(`info N1: the page's used heap after the module is posted moved ${pageAfter - before} bytes (diagnostic only, not gated: an aggregate heap delta after one GC, not a retention proof)`);
    // (the gate is per node: it shows no single object of b/4 or more is live.  A copy split across smaller strings
    // or buffers, held through a rope or an object graph, or alive only transiently, is outside it; the controls
    // below show its sensitivity to a flat string and a flat byte array in this browser, not every representation)
    ok(largest > 0 && largest < moduleBytes / 4, "no single node in the page's heap snapshot reaches b/4 while the shell runs (a per-node check: a copy split across smaller strings or buffers, held through a rope or object graph, or alive only transiently, is outside it) (N1, page realm)");
    ok(wheap && wheap.usedSize > 0 && wheap.usedSize <= 4 * moduleBytes + 16 * 2 ** 20, "the shell worker's heap is within 4b plus the shell's live set (16 MiB measured allowance) (N1, worker realm)");
    // (fail-first controls for the per-node gate: each keeps one copy of the module in the page, from an isolated
    // scope that returns only its length; a fresh snapshot must catch it; it is deleted in a finally; then a fresh
    // snapshot must pass the gate's own predicate again, before the next control and before N3, which reuses this page)
    const largestLive = async () => {
      const parts = [];
      const onPart = (e) => {
        const m = JSON.parse(e.data);
        if (m.method === "HeapProfiler.addHeapSnapshotChunk") parts.push(m.params.chunk);
      };
      cdp.ws.addEventListener("message", onPart);
      try {
        const r = await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
        if (r.error) return -1;
        const s = JSON.parse(parts.join(""));
        const n = s.snapshot.meta.node_fields.length, k = s.snapshot.meta.node_fields.indexOf("self_size");
        if (k < 0) return -1;
        let max = 0;
        for (let i = k; i < s.nodes.length; i += n) max = Math.max(max, s.nodes[i]);
        return max;
      } catch {
        return -1;
      } finally {
        cdp.ws.removeEventListener("message", onPart);
      }
    };
    const moduleChars = JSON.parse(readFileSync(join(dir, "pkg", chunkSha + ".json"), "utf8")).modules["shell.js"].length;
    const control = async (name, global, keep, want) => {
      try {
        const got = await evaluate(`(async () => { const t = await (await fetch("/pkg/${chunkSha}.json")).text(); const s = JSON.parse(t).modules["shell.js"]; window.${global} = ${keep}; return window.${global}.length; })()`);
        ok(got === want, `control ${name}: installed in the page, length ${JSON.stringify(got)} (want ${want}) (N1)`);
        const caught = await largestLive();
        ok(caught >= moduleBytes / 4, `control ${name}: the per-node gate catches it (largest ${caught} bytes) (N1)`);
      } finally {
        const gone = await evaluate(`(delete window.${global}, gc(), typeof window.${global})`);
        ok(gone === "undefined", `control ${name}: its global is deleted (N1)`);
      }
      const after = await largestLive();
      ok(after > 0 && after < moduleBytes / 4, `after control ${name}: a fresh snapshot passes the gate's own predicate again (largest ${after} bytes) (N1)`);
    };
    await control("a retained string copy of the module", "__n1str", "s", moduleChars);
    await control("a retained byte copy of the module", "__n1bytes", "new TextEncoder().encode(s)", moduleBytes);
    await evaluate("sh2.terminate()");
  }
  // the shell, and every registered command under the worker's policy (N3)
  const run = await evaluate(`(async () => {
    const { shell: sh, notices } = await startShell(${JSON.stringify(S)}, "/");
    const out = {};
    const run = await hostOver(sh);
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
    for (const [name, script] of Object.entries(cmds)) out[name] = await run(script);
    const absent = {};
    for (const name of ["curl", "python3", "js-exec", "sqlite3", "tee", "node"]) absent[name] = await run(name + " --version");
    const runs = [];
    for (const name of ${JSON.stringify(CENSUS_NAMES)}) {
      const r = await run(\`\${name} --help >/dev/null 2>&1; echo "rc=$?"\`);
      if ((r.exit?.stdout ?? "").trim() !== "rc=127") runs.push(name);
    }
    return { S: sh.S, version: sh.version, out, absent, runs, blobScripts: blobScripts(), notices: { length: notices.length, head: notices.slice(0, 80), hasJustBash: notices.includes("just-bash 3.6.0 (Apache-2.0"), onShell: Object.values(sh).some((v) => v === notices) } };
  })()`);
  ok(run && !run.error && run.S === S && run.version === "0.3.0", `the shell starts from set ${S.slice(0, 12)} (${run?.error ?? run?.version})`);
  const failed = Object.entries(run?.out ?? {}).filter(([, r]) => r.exit?.code !== 0 || /Content Security Policy|EvalError|unsafe-eval/.test(r.exit.stderr));
  ok(run?.out && Object.keys(run.out).length === 34 && !failed.length, `every registered command runs under the worker's policy (N3)${failed.length ? ": " + JSON.stringify(failed).slice(0, 600) : ""}`);
  ok(run?.out?.jq?.exit?.stdout === "2\n" && run?.out?.awk?.exit?.stdout === "3\n" && run?.out?.printf?.exit?.stdout === "00042\n" && run?.out?.diff?.exit?.stdout?.includes("rc=1"), "and they compute what they should (jq, awk, printf, diff)");
  // (python3 and sqlite3: the browser bundle answers "not available in browser environments", 127, for them)
  const present = Object.entries(run?.absent ?? {}).filter(([, r]) => r.exit?.code !== 127 || !/command not found|not available in browser environments/.test(r.exit.stderr));
  ok(run?.absent && !present.length, `commands outside §8 aren't registered (curl, python3, js-exec, sqlite3, tee, node)${present.length ? ": " + JSON.stringify(present).slice(0, 300) : ""}`);
  const extra = (run?.runs ?? []).filter((n) => !BUILTINS.includes(n)), missing = BUILTINS.filter((n) => !(run?.runs ?? []).includes(n));
  ok(run?.runs && !extra.length && !missing.length, `the names that run besides §8's commands are exactly the interpreter's ${BUILTINS.length} builtins (N-119-2; of ${CENSUS_NAMES.length} candidates)${extra.length ? "; also: " + extra.join(" ") : ""}${missing.length ? "; not: " + missing.join(" ") : ""}`);
  ok(run?.blobScripts === 0, "the page's realm never makes a script of the module (no blob: script in the page)");
  ok((await evaluate(`noticesPosted()`)) === false, "the shell worker never receives the notices (A1 r3)");
  ok(run?.notices?.hasJustBash && run.notices.length > 1000 && !run.notices.onShell, `startShell returns the chunk's verified notices, and the shell object holds no reference to them (A1 r3; ${run?.notices?.length} chars)`);

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
  const before = await evaluate("workersMade()");
  longer = true;
  ok(/over \d+ bytes/.test(await refusal(S)), "a body longer than its declared size is refused while streaming (stage 2, A1.2 r3)");
  longer = false;
  ok(/its notices are over 262144 bytes/.test(await refusal(BIG_NOTICES)), "notices one byte past 256 KiB, in a chunk within its declared size, are refused after the bounded body (stage 3)");
  ok((await evaluate("workersMade()")) === before, "and neither refusal starts a worker");

  // step 3, the module's side (host level 3): the init, the output count, bash.pipeline_width
  const m3 = await evaluate(`(async () => {
    const out = {};
    const { shell } = await startShell(${JSON.stringify(S)}, "/");
    out.before = await shell.exec("echo hi", { ...EMPTY_FS, allowance: 100 });
    out.resolved = await shell.configure(INIT).then((v) => Object.keys(v).length, (e) => "refused: " + e.message);
    out.again = await shell.configure(INIT).then(() => "taken", (e) => e.message);
    const run = (script, allowance) => shell.exec(script, { ...EMPTY_FS, allowance });
    out.fits = await run("echo hello", 6);
    out.cut = await run("echo hello", 3);
    out.scalar = await run("printf 'a\\u00e9'", 2);
    out.order = await run("printf ab; printf cd >&2", 3);
    out.none = await run("printf x", 0);
    shell.terminate();
    const { shell: narrow } = await startShell(${JSON.stringify(S)}, "/");
    await narrow.configure({ ...INIT, pipelineWidth: 2 });
    out.two = await narrow.exec("echo a | cat", { ...EMPTY_FS, allowance: 100 });
    out.three = await narrow.exec("echo a | cat | cat", { ...EMPTY_FS, allowance: 100 });
    narrow.terminate();
    return out;
  })()`);
  const cnt = (r) => JSON.stringify(r?.output);
  ok(m3?.before?.rejected && /isn't configured/.test(m3.before.rejected.message), `an exec before the init is refused by the module (${JSON.stringify(m3?.before ?? m3).slice(0, 200)})`);
  ok(typeof m3?.resolved === "number" && m3.resolved > 30 && /already configured/.test(m3.again), `one init per worker: the first resolves just-bash's limits (${m3?.resolved} names), a second is refused (${m3?.again})`);
  ok(m3?.fits?.exit?.stdout === "hello\n" && cnt(m3.fits) === JSON.stringify({ producedBytes: 6, deliveredBytes: 6, exceeded: false, truncated: false }), `a result within the allowance is sent whole, with its count (${cnt(m3?.fits)})`);
  ok(m3?.cut?.exit?.stdout === "hel" && cnt(m3.cut) === JSON.stringify({ producedBytes: 6, deliveredBytes: 3, exceeded: true, truncated: false }), `past it, only the prefix within the allowance is sent, and the module says exceeded (${JSON.stringify(m3?.cut)})`);
  ok(m3?.scalar?.exit?.stdout === "a" && cnt(m3.scalar) === JSON.stringify({ producedBytes: 3, deliveredBytes: 1, exceeded: true, truncated: false }), `the cut is at a scalar boundary: never half of a 2-byte scalar (${JSON.stringify(m3?.scalar)})`);
  ok(m3?.order?.exit?.stdout === "ab" && m3.order.exit.stderr === "c" && cnt(m3.order) === JSON.stringify({ producedBytes: 4, deliveredBytes: 3, exceeded: true, truncated: false }), `stdout first, then stderr in what is left (${JSON.stringify(m3?.order)})`);
  ok(m3?.none?.exit?.stdout === "" && cnt(m3.none) === JSON.stringify({ producedBytes: 1, deliveredBytes: 0, exceeded: true, truncated: false }), `an allowance of 0 sends nothing (${JSON.stringify(m3?.none)})`);
  ok(m3?.two?.exit?.stdout === "a\n" && JSON.stringify(m3?.three) === JSON.stringify({ limit: { key: "pipeline_width", value: 2 } }), `bash.pipeline_width 2: a 2-stage pipeline runs, a 3-stage one is refused by the module's own parse, structured (${JSON.stringify(m3?.three)})`);

  // the lifecycle: every end settles everything, and leaves no worker or channel
  const life = await evaluate(`(async () => {
    const BAD = ${JSON.stringify(BAD)}, S = ${JSON.stringify(S)};
    const within = (p, ms = 5000) => Promise.race([
      p.then((v) => ({ v }), (e) => ({ e: { name: e?.name, message: String(e?.message ?? e) } })),
      new Promise((r) => setTimeout(() => r({ hung: true }), ms)),
    ]);
    const res = {}, live0 = workersLive(), closed0 = portsClosed();
    res.boot = [];
    for (let i = 0; i < 5; i++) res.boot.push(await within(startShell(BAD.boot, "/")));
    res.bootLive = workersLive() - live0;
    res.bootClosed = portsClosed() - closed0;
    const ac = new AbortController();
    const never = within(startShell(BAD.never, "/", { signal: ac.signal }));
    setTimeout(() => ac.abort(new Error("cancelled on purpose")), 500);
    res.never = await never;
    res.neverLive = workersLive() - live0;
    const { shell: real } = await startShell(BAD.reject, "/");
    await real.configure(INIT);
    res.rejected = await within(real.exec("echo before; echo refuse-me > f; echo after", { allowance: 1000 }));
    res.afterRejected = await within(real.exec("echo still here", { ...EMPTY_FS, allowance: 1000 }));
    real.terminate();
    const { shell: silent } = await startShell(BAD.silent, "/");
    const running = within(silent.exec("echo never answered"));
    silent.terminate();
    silent.terminate();
    res.terminated = await running;
    res.afterTerminate = await within(silent.exec("echo x"), 1000);
    res.silentState = silent.state;
    const { shell: late } = await startShell(BAD.late, "/");
    res.late = await within(Promise.all([late.exec("echo a"), late.exec("echo b")]).then(() => "resolved", (e) => Promise.reject(e)));
    res.lateState = late.state;
    res.afterLate = await within(late.exec("echo c"), 1000);
    const { shell: code } = await startShell(BAD.code, "/");
    res.code = await within(code.exec("echo x"));
    res.codeState = code.state;
    res.endLive = workersLive() - live0;
    return res;
  })()`);
  const unavailable = (r, why) => r?.e?.name === "ShellUnavailableError" && (!why || why.test(r.e.message));
  ok(life?.boot?.length === 5 && life.boot.every((r) => /the shell didn't start: start failed on purpose/.test(r.e?.message ?? "")) && life.bootLive === 0 && life.bootClosed >= 5, `a boot that fails after start() took its port, five times: each start is refused, and no worker or channel is left (CORR-PR119-1, LIMIT-PR119-2; ${JSON.stringify({ live: life?.bootLive, closed: life?.bootClosed, first: life?.boot?.[0] ?? life?.error }).slice(0, 200)})`);
  ok(life?.never?.e?.message === "cancelled on purpose" && life.neverLive === 0, `a module that never says ready runs until the caller aborts; the abort ends its worker (LIMIT-PR119-2; ${JSON.stringify(life?.never)})`);
  ok(life?.rejected?.v?.rejected && !("exit" in life.rejected.v) && life.rejected.v.rejected.refusal === null && typeof life.rejected.v.rejected.message === "string", `a rejection inside the module arrives as rejected, not as an exit status (GRADER-PR119-1; ${JSON.stringify(life?.rejected).slice(0, 160)})`);
  ok(life?.afterRejected?.v?.exit?.code === 0 && life.afterRejected.v.exit.stdout === "still here\n", "and the shell goes on: a rejection is the invocation's, not the shell's");
  ok(unavailable(life?.terminated, /terminated/), `terminate() during a running invocation settles it as a failure, ShellUnavailableError (${JSON.stringify(life?.terminated)})`);
  ok(unavailable(life?.afterTerminate, /terminated/) && life.silentState === "closed", `exec() after terminate() fails at once (${JSON.stringify(life?.afterTerminate)})`);
  ok(unavailable(life?.late, /its worker failed/) && life.lateState === "closed" && unavailable(life?.afterLate), `a worker that throws after ready settles its pending invocations, and later ones fail at once (${JSON.stringify(life?.late)})`);
  ok(unavailable(life?.code, /broke the shell protocol/) && life.codeState === "closed", `an exit code outside 0..255 is a failure, never a status (${JSON.stringify(life?.code)})`);
  ok(life?.endLive === 0, `and none of these leaves a worker running (${life?.endLive})`);

} finally {
  try { ws?.close(); } catch {}
  chrome?.kill();
  await pwBrowser?.close().catch(() => {});
  server.close();
  rmSync(profile, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
