// astra's probes on sync-ops ac1c27eb (CORR-AC1-1: old copies' marks reached past any that keep failing; CORR-AC1-2: an older tab's write too large to move, kept, never deleted), with their cases in astra-ac1-cases.js:
//   CHROME=google-chrome bun web/workspace/test-workspace-sync-ops-ac1.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const site = mkdtempSync(join(tmpdir(), "sb-ws-ac1-site-"));
const built = await Bun.build({ entrypoints: [join(here, "index.ts")], outdir: site, naming: "ws.js", target: "browser", format: "esm" });
if (!built.success) {
  console.error(built.logs.join("\n"));
  process.exit(1);
}
copyFileSync(join(here, "astra-ac1-cases.js"), join(site, "cases.js"));
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>sync ops test</title><script type="module">import { run } from "./cases.js"; window.run = run; window.ready = true;</script>`);
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
  const p = new URL(req.url).pathname;
  if (!["/", "/ws.js", "/cases.js"].includes(p)) return new Response("not found", { status: 404 });
  return new Response(Bun.file(join(site, p === "/" ? "index.html" : p.slice(1))), { headers: { "content-type": p.endsWith(".js") ? "text/javascript" : "text/html" } });
} });

let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-ws-ac1-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
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
  const results = await ev("window.run()");
  const fails = results.filter(([ok]) => !ok).map(([, what]) => what);
  for (const e of errors) fails.push("page error: " + e);
  if (fails.length) console.error(`FAIL: ${fails.length} of ${results.length} checks\n  ` + fails.join("\n  "));
  else {
    console.log(`ok: astra's ac1c27eb probes (ac1), ${results.length} checks`);
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
