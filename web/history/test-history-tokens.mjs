// ci: web-runner order=230 runner=bun chrome
// History's change tokens (Stage A layer 1; design stage-a-l1 r2.1 + r2.2, /scratch/sagebrush-reviews/
// stage-a-l1-design-r2.2) in headless Chromium, with real IndexedDB: web/history/tokens.ts on its own (the byte
// metric, the bounds, the overflow witness, exhaustion, failures aborting the save) and through the workspace (every
// index op's, board's and notebook's token, with its chain).  Mutants of tokens.ts, made here by exact patches, must
// each FAIL the rows that guard against them.  The cases are in test-history-tokens.page.js.
//   CHROME=google-chrome bun web/history/test-history-tokens.mjs
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const site = mkdtempSync(join(tmpdir(), "sb-htok-site-")), mut = mkdtempSync(join(tmpdir(), "sb-htok-mut-"));
const build = async (entry, naming) => {
  const b = await Bun.build({ entrypoints: [entry], outdir: site, naming, target: "browser", format: "esm" });
  if (!b.success) {
    console.error(b.logs.join("\n"));
    process.exit(1);
  }
};
// (each mutant: one exact patch of tokens.ts, which must apply exactly once, else the run fails)
const SRC = readFileSync(join(here, "tokens.ts"), "utf8");
const MUTANTS = {
  // exhaustion: an increment past the last seq, a wrap to 1, saturation (the last seq reused)
  unsafe: ["if (hseq >= TOKEN_LIMITS.maxSeq) {", "if (hseq > TOKEN_LIMITS.maxSeq) {"],
  wrap: ['    meta.put(true, "exhausted");\n    return;', '    meta.put(0, "hseq");\n    return;'],
  saturate: ['    meta.put(true, "exhausted");\n    return;', '    meta.put(TOKEN_LIMITS.maxSeq - 1, "hseq");\n    return;'],
  // the bounds: off by one on the rows, and the token's own size not counted in the bytes
  rows: ["count + 1 > TOKEN_LIMITS.rows", "count > TOKEN_LIMITS.rows"],
  size: ["bytes + sz > TOKEN_LIMITS.bytes", "bytes > TOKEN_LIMITS.bytes"],
  // the inactive return removed: a token written while history is off
  inert: ['  if ((await req(meta.get("hactive"))) !== true) return;\n', ""],
  // (A1-T12: two tokens of the same (ident, rev) are two tokens: a dedup by (ident, rev) dropping the second)
  dedupIdentRev: ['  // (add, not put: a duplicate seq', '  if (((await req(tx.objectStore("htokens").getAll())) as Token[]).some((r) => r.ident === t.ident && r.rev === t.rev)) return;\n  // (add, not put: a duplicate seq'],
};
for (const [name, [a, b]] of Object.entries(MUTANTS)) {
  if (SRC.split(a).length !== 2) {
    console.error(`FAIL: mutant ${name}'s patch doesn't apply exactly once`);
    process.exit(1);
  }
  writeFileSync(join(mut, `tokens-${name}.ts`), SRC.replace(a, b).replace('from "../workspace/db"', `from "${join(here, "../workspace/db")}"`));
  await build(join(mut, `tokens-${name}.ts`), `tokens-${name}.js`);
}
await build(join(here, "tokens.ts"), "tokens.js");
await build(join(here, "../workspace/index.ts"), "ws.js");
await build(join(here, "../notebook/stores.js"), "stores.js");
copyFileSync(join(here, "test-history-tokens.page.js"), join(site, "cases.js"));
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>history tokens test</title><script type="module">import { run } from "./cases.js"; window.run = run; window.ready = true;</script>`);
const FILES = ["/tokens.js", "/ws.js", "/stores.js", "/cases.js", ...Object.keys(MUTANTS).map((m) => `/tokens-${m}.js`)];
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
  const p = new URL(req.url).pathname;
  if (p !== "/" && !FILES.includes(p)) return new Response("not found", { status: 404 });
  const f = Bun.file(join(site, p === "/" ? "index.html" : p.slice(1)));
  return new Response(f, { headers: { "content-type": p.endsWith(".js") ? "text/javascript" : "text/html" } });
} });

let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-htok-"));
// (its own process group, killed whole at the end: the browser's helpers with it)
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", detached: true });
let code = 1;
try {
  if (!port) port = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const waiting = new Map(), errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 2000)); return r.result.value; };
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
  // (the page loaded: up to 60 s on a busy machine; not loaded, the page's own errors are the failure, not "run is not a function")
  let ready = false;
  for (let i = 0; i < 1200 && !(ready = await ev("window.ready === true").catch(() => false)); i++) await sleep(50);
  if (!ready) throw new Error("the page never got ready in 60 s; its errors: " + (errors.join(" | ") || "none reported"));
  const results = await ev("window.run()");
  const fails = results.filter(([ok]) => !ok).map(([, what]) => what);
  for (const e of errors) fails.push("page error: " + e);
  if (fails.length) {
    console.error(`FAIL: ${fails.length} of ${results.length} checks\n  ` + fails.join("\n  "));
  } else {
    console.log(`ok: history's change tokens, ${results.length} checks`);
    if (process.env.SHOW) for (const [, what] of results) console.log("  " + what);
    code = 0;
  }
  ws.close();
} catch (e) {
  console.error("FAIL: " + (e?.stack ?? e));
} finally {
  try { process.kill(-chrome.pid, "SIGKILL"); } catch {}
  server.stop(true);
  await sleep(200);
  for (const d of [profile, site, mut]) rmSync(d, { recursive: true, force: true });
}
process.exit(code);
