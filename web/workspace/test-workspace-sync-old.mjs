// EXACT-ONLY's old-sync detector (sync-old.ts; plan-exact-only §5A r2, OLD1-OLD10) in headless Chromium, in a profile
// of its own (the history databases are the origin's, shared by every workspace a page opens).  The cases are in
// sync-old-cases.js; ONLY=name,name runs those alone.
//   CHROME=google-chrome bun web/workspace/test-workspace-sync-old.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const site = mkdtempSync(join(tmpdir(), "sb-ws-old-site-"));
const built = await Bun.build({ entrypoints: [join(here, "sync-old-entry.ts")], outdir: site, naming: "ws.js", target: "browser", format: "esm" });
if (!built.success) {
  console.error(built.logs.join("\n"));
  process.exit(1);
}
copyFileSync(join(here, "sync-old-cases.js"), join(site, "cases.js"));
// (OLD8: the old builds, each bundled from its own tree: OLD_TREES="tag=/path/to/tree,…")
const oldTrees = (process.env.OLD_TREES ?? "").split(",").filter(Boolean).map((x) => x.split("="));
for (const [tag, tree] of oldTrees) {
  const entry = join(site, `old-${tag}-entry.ts`);
  writeFileSync(entry, [`export * from "${tree}/web/workspace/index.ts";`, `export { t1Write, syncedKey } from "${tree}/web/journal/rows.js";`, `export { keepBundle } from "${tree}/web/notebook/bundle.js";`, `export { openHistoryDb, openBoardHistoryDb } from "${tree}/web/notebook/stores.js";`].join("\n"));
  const b = await Bun.build({ entrypoints: [entry], outdir: site, naming: `old-${tag}.js`, target: "browser", format: "esm" });
  if (!b.success) {
    console.error(`old build ${tag}: ` + b.logs.join("\n"));
    process.exit(1);
  }
}
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>old sync test</title><script>window.OLD_BUILDS = ${JSON.stringify(oldTrees.map(([t]) => t))};</script><script type="module">import { run } from "./cases.js"; window.run = run; window.ready = true;</script>`);
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
  const p = new URL(req.url).pathname;
  if (!["/", "/ws.js", "/cases.js", ...oldTrees.map(([t]) => `/old-${t}.js`)].includes(p)) return new Response("not found", { status: 404 });
  return new Response(Bun.file(join(site, p === "/" ? "index.html" : p.slice(1))), { headers: { "content-type": p.endsWith(".js") ? "text/javascript" : "text/html" } });
} });

let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-ws-old-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--js-flags=--expose-gc", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let code = 1;
try {
  if (!port) port = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.some((t) => t.type === "page")) break; } catch {} await sleep(100); }
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
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 2000)); return r.result?.value; };
  await send("Runtime.enable");
  await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
  for (let i = 0; i < 200 && !(await ev("window.ready === true").catch(() => false)); i++) await sleep(50);
  const results = await ev(`window.run(${JSON.stringify(process.env.ONLY ?? "")})`);
  const fails = results.filter(([ok]) => !ok).map(([, what]) => what);
  for (const e of errors) fails.push("page error: " + e);
  // (the long-task controls' rows, always printed, so every run's log carries their measured numbers: #219)
  for (const [ok, what] of results) if (/^(measure:|skipped:)/.test(what)) console.log(`${ok ? "ok" : "FAIL"} (row): ${what}`);
  if (fails.length) console.error(`FAIL: ${fails.length} of ${results.length} checks\n  ` + fails.join("\n  "));
  else {
    console.log(`ok: the old-sync detector, ${results.length} checks`);
    if (process.env.SHOW) for (const [, what] of results) console.log("  " + what);
    code = 0;
  }
  ws.close();
} finally {
  chrome.kill();
  server.stop(true);
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
  rmSync(site, { recursive: true, force: true });
}
process.exit(code);
