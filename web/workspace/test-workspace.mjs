// The workspace (web/workspace/: design/workspace-files.md §2, §8.2) in
// headless Chromium, with real IndexedDB, localStorage, Web Locks and
// BroadcastChannel: paths; making, reading and writing notebooks, boards and
// data files (each where it is kept today, a taken path never written over);
// compare-and-swap writes; renames that carry a folder's files and their
// bytes; Trash and restore, with no verb that removes contents for good;
// duplicates; limits; the operation log and other tabs told; two tabs at
// once; and the migration of what this browser keeps today: boards out of
// localStorage (which is left as it was), edited examples, notebooks and
// data files listed, a later write by an older tab brought in as a copy
// once, reconcile's /Recovered and missing marks, a full workspace.
// The cases are in test-workspace.page.js.
//   CHROME=google-chrome bun web/workspace/test-workspace.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
// schema.json as verbs.ts writes it, and its verbs the agent facade's (no drift)
{
  const { schemaText, VERBS } = await import("./verbs.ts");
  const { readFileSync } = await import("node:fs");
  const kept = readFileSync(join(here, "schema.json"), "utf8");
  if (kept !== schemaText()) {
    console.error("FAIL: web/workspace/schema.json is stale: bun web/workspace/verbs.ts --write");
    process.exit(1);
  }
  const api = readFileSync(join(here, "api.ts"), "utf8");
  const facade = /const verbs = \[([^\]]*)\] as const/.exec(api)?.[1].match(/"(\w+)"/g)?.map((x) => x.slice(1, -1)) ?? [];
  const wire = Object.keys(VERBS);
  const missing = wire.filter((v) => !facade.includes(v)), extra = facade.filter((v) => !wire.includes(v) && v !== "watch" && v !== "ops");
  if (missing.length || extra.length || facade.includes("dropVersions") || facade.includes("forget")) {
    console.error(`FAIL: the wire verbs and the agent facade differ: missing ${missing}, extra ${extra}`);
    process.exit(1);
  }
}
const site = mkdtempSync(join(tmpdir(), "sb-ws-site-"));
const built = await Bun.build({ entrypoints: [join(here, "index.ts")], outdir: site, naming: "ws.js", target: "browser", format: "esm" });
if (!built.success) {
  console.error(built.logs.join("\n"));
  process.exit(1);
}
// (fileopen.ts on its own, as the pages load it: Recent's lookups, CORR-FD1-2)
const opened = await Bun.build({ entrypoints: [join(here, "fileopen.ts")], outdir: site, naming: "fileopen.js", target: "browser", format: "esm" });
if (!opened.success) {
  console.error(opened.logs.join("\n"));
  process.exit(1);
}
// (the notebooks' store on its own, as an editor loads it: astra's probe that it refuses to save while quarantined)
await Bun.build({ entrypoints: [join(here, "../notebook/stores.js")], outdir: site, naming: "stores.js", target: "browser", format: "esm" });
copyFileSync(join(here, "test-workspace.page.js"), join(site, "cases.js"));
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>workspace test</title><script type="module">import { run } from "./cases.js"; window.run = run; window.ready = true;</script>`);
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
  const p = new URL(req.url).pathname;
  if (!["/", "/ws.js", "/fileopen.js", "/cases.js", "/stores.js"].includes(p)) return new Response("not found", { status: 404 });
  const f = Bun.file(join(site, p === "/" ? "index.html" : p.slice(1)));
  return new Response(f, { headers: { "content-type": p.endsWith(".js") ? "text/javascript" : "text/html" } });
} });

let port = Number(process.env.CDP_PORT) || 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-ws-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let code = 1;
try {
  if (!port) port = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0; const waiting = new Map(); const errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 2000)); return r.result?.value; };
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
  for (let i = 0; i < 200 && !(await ev("window.ready === true").catch(() => false)); i++) await sleep(50);
  const results = await ev("window.run()");
  const fails = results.filter(([ok]) => !ok).map(([, what]) => what);
  for (const e of errors) fails.push("page error: " + e);
  if (fails.length) {
    console.error(`FAIL: ${fails.length} of ${results.length} checks\n  ` + fails.join("\n  "));
  } else {
    console.log(`ok: the workspace, ${results.length} checks`);
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
