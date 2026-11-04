// ci: web-runner order=250 runner=bun chrome
// History's dynamic census guard (web/history/guard.js; Stage A layer 1, design stage-a-l1 r2.2 §4) in headless
// Chromium, with real IndexedDB: installed before anything opens a database, it must see a workspace scenario (index
// ops, data files, Trash, boards, notebooks) as fully covered, with no violation, and catch each of its controls (two
// changes and one token, in the workspace and in the notebooks; a change with no token and no exhausted state; a
// notebooks database made by the app's own opener).  The cases are in test-history-guard.page.js.
//   CHROME=google-chrome bun web/history/test-history-guard.mjs
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const site = mkdtempSync(join(tmpdir(), "sb-hgrd-site-"));
const build = async (entry, naming) => {
  const b = await Bun.build({ entrypoints: [entry], outdir: site, naming, target: "browser", format: "esm" });
  if (!b.success) {
    console.error(b.logs.join("\n"));
    process.exit(1);
  }
};
await build(join(here, "guard.js"), "guard.js");
await build(join(here, "../workspace/index.ts"), "ws.js");
copyFileSync(join(here, "test-history-guard.page.js"), join(site, "cases.js"));
// (the guard installed by its own module, before the cases' module (and anything it opens) loads)
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>history guard test</title><script type="module">import { installGuard } from "./guard.js"; installGuard({ skipOpener: (n) => n.startsWith("noopener-"), judgeFixtures: true }); const { run } = await import("./cases.js"); window.run = run; window.ready = true;</script>`);
const FILES = ["/guard.js", "/ws.js", "/cases.js"];
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
  const p = new URL(req.url).pathname;
  if (p !== "/" && !FILES.includes(p)) return new Response("not found", { status: 404 });
  const f = Bun.file(join(site, p === "/" ? "index.html" : p.slice(1)));
  return new Response(f, { headers: { "content-type": p.endsWith(".js") ? "text/javascript" : "text/html" } });
} });

let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-hgrd-"));
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
  if (fails.length) console.error(`FAIL: ${fails.length} of ${results.length} checks\n  ` + fails.join("\n  "));
  else {
    console.log(`ok: history's census guard, ${results.length} checks`);
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
