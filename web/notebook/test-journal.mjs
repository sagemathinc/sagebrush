// The notebook journal's core (web/notebook/journal.js; plan-sync-slice2-client r4 §2.1, r9 §3.1a) in headless
// Chromium, with real IndexedDB and Web Locks: T1 then T2 on every save, the journal's rows and their charges, the
// pending value while TimeTravel is paused (F4), and recovery on load, each row of its table hit by a case.
// The cases are in test-journal.page.js.
//   CHROME=google-chrome bun web/notebook/test-journal.mjs
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
// (the producers' invariant, over the sources (design r4 §6, daybreak3): only the journal's rows (web/journal/rows.js)
// write a save's intent (a "p" row), only the journal asks for one, and every other writer of the notebooks' history
// (Resume's copy in index.html, an import's keepBundle) writes rows of {nb, time, env} alone)
const J = JSON.stringify;
const statics = [];
{
  const { readdirSync, readFileSync } = await import("node:fs");
  const files = [...readdirSync(here).filter((f) => /\.(js|ts)$/.test(f) && !f.startsWith("test-")).map((f) => join(here, f)), join(here, "../index.html"), ...readdirSync(join(here, "../workspace")).filter((f) => /\.ts$/.test(f) && !f.startsWith("test-")).map((f) => join(here, "../workspace", f)), ...readdirSync(join(here, "../journal")).filter((f) => /\.(js|ts)$/.test(f) && !f.startsWith("test-")).map((f) => join(here, "../journal", f))];
  const src = Object.fromEntries(files.map((f) => [f.slice(here.length - "notebook/".length), readFileSync(f, "utf8")]));
  const writes = Object.keys(src).filter((f) => /seqKey\([^)]*"p"/.test(src[f]));
  statics.push([J(writes) === J(["journal/rows.js"]), "only journal/rows.js writes an intent row: " + J(writes)]);
  const asks = Object.keys(src).filter((f) => /t1Write\(/.test(src[f]));
  statics.push([J(asks.sort()) === J(["journal/core.js", "journal/rows.js", "journal/store.js"]), "only the journal asks for a T1 with an intent: " + J(asks)]);
  const copy = /st\.put\(\{ nb: id, time: row\.time, env: row\.env \}\)/.test(src["index.html"] ?? ""), imp = /st\.put\(\{ nb: id, time: env\.time, env \}\)/.test(src["notebook/bundle.js"] ?? "");
  statics.push([copy && imp, "Resume's copy and an import write {nb, time, env} rows alone"]);
}
const site = mkdtempSync(join(tmpdir(), "sb-nbj-site-")), src = mkdtempSync(join(here, ".test-journal-"));
let code = 1;
// (one bundle, so the page, the workspace and the journal share one copy of the notebook's stores)
writeFileSync(join(src, "entry.js"), [
  `export * as W from ${JSON.stringify(join(here, "../workspace/index.ts"))};`,
  `export * as N from ${JSON.stringify(join(here, "journal.js"))};`,
  `export * as H from ${JSON.stringify(join(here, "history.js"))};`,
  `export * as R from ${JSON.stringify(join(here, "sync-rows.js"))};`,
  `export * as B from ${JSON.stringify(join(here, "bundle.js"))};`,
  `export * as S from ${JSON.stringify(join(here, "stores.js"))};`,
  `export * as P from ${JSON.stringify(join(here, "../sync-protocol/protocol.ts"))};`,
].join("\n"));
// (two builds of the same modules: all.js with exact merges compiled in (the cases' own), off.js without (a production
// build's define): the fail-closed case loads with off.js what all.js recorded (the grader's G-P2b-5))
const b = await Bun.build({ entrypoints: [join(src, "entry.js")], outdir: site, naming: "all.js", target: "browser", format: "esm", define: { __SB_EXACT_MERGE__: "true" } });
const b2 = await Bun.build({ entrypoints: [join(src, "entry.js")], outdir: site, naming: "off.js", target: "browser", format: "esm", define: { __SB_EXACT_MERGE__: "false" } });
rmSync(src, { recursive: true, force: true });
if (!b.success || !b2.success) {
  console.error([...b.logs, ...b2.logs].join("\n"));
  process.exit(1);
}
copyFileSync(join(here, "test-journal.page.js"), join(site, "cases.js"));
// (the notebook page's source, for its journal functions, run as they are (the cases extract them))
copyFileSync(join(here, "../index.html"), join(site, "page-src.html"));
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>notebook journal test</title><script type="module">import { run } from "./cases.js"; window.run = run; window.ready = true;</script>`);
const FILES = ["/all.js", "/off.js", "/cases.js", "/page-src.html"];
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
  const p = new URL(req.url).pathname;
  if (p !== "/" && !FILES.includes(p)) return new Response("not found", { status: 404 });
  const f = Bun.file(join(site, p === "/" ? "index.html" : p.slice(1)));
  return new Response(f, { headers: { "content-type": p.endsWith(".js") ? "text/javascript" : "text/html" } });
} });

let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-nbj-"));
// (its own process group, killed whole at the end: the browser's helpers with it)
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", detached: true });
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
    if (process.env.PROGRESS && m.method === "Runtime.consoleAPICalled" && m.params.args?.[0]?.value?.startsWith?.("test: ")) console.log(m.params.args[0].value);
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800)); return r.result?.value; };
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
  for (let i = 0; i < 200 && !(await ev("window.ready === true").catch(() => false)); i++) await sleep(50);
  const results = [...statics, ...(await ev("window.run()"))];
  const fails = results.filter(([ok]) => !ok).map(([, what]) => what);
  for (const e of errors) fails.push("page error: " + e);
  if (fails.length) {
    console.error(`FAIL: ${fails.length} of ${results.length} checks\n  ` + fails.join("\n  "));
  } else {
    console.log(`ok: the notebook journal, ${results.length} checks`);
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
  for (const d of [profile, site]) rmSync(d, { recursive: true, force: true });
}
process.exit(code);
