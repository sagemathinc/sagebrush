// The journal's activation (plan-sync-slice2-client r4 §1a) in headless Chromium, with real IndexedDB and Web
// Locks: the workspace's version 9 (8 meta's `journal`, 9 the board journal's barrier) and meta's `journal`; activation writing "journal" into the three fences and
// then `active`; the fences' counters and their mark kept by every later write (a reset's, a quarantine's, a
// refresh's); a stop after each fence write carried on by the next open; a fence that can't be written leaving
// it begun; and every writer from before the journal refused, this build's and the pinned pre-journal build's
// (master f8976bfe's workspace and notebook stores, built beside this one: its open of a current (version-9) workspace
// fails, and its saves and history writes are refused before they change anything).
// The cases are in test-workspace-journal.page.js.
//   CHROME=google-chrome bun web/workspace/test-workspace-journal.mjs
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname, root = join(here, "../..");
// (the build from before the journal: its web/ and src/ as master f8976bfe had them, fetched if this checkout is shallow;
// nothing here is skipped if it can't be had: the run fails)
const PINNED = "f8976bfe971eb60fac535fa73ed5d2e2fee9083e";
const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
const have = () => git("rev-parse", "--verify", "-q", `${PINNED}^{commit}`).stdout.trim();
const pinned = have() || (git("fetch", "-q", "--depth=1", "origin", PINNED), have());
if (pinned !== PINNED) {
  console.error("FAIL: the pinned pre-journal build (f8976bfe) isn't in this checkout and couldn't be fetched");
  process.exit(1);
}
const site = mkdtempSync(join(tmpdir(), "sb-wsj-site-")), old = mkdtempSync(join(tmpdir(), "sb-wsj-old-"));
{
  const tar = spawnSync("sh", ["-c", `git archive ${pinned} web src | tar -x -C '${old}'`], { cwd: root });
  if (tar.status !== 0) {
    console.error("FAIL: the pinned build couldn't be unpacked: " + tar.stderr);
    process.exit(1);
  }
  symlinkSync(join(root, "node_modules"), join(old, "node_modules"));
}
const build = async (entry, naming) => {
  const b = await Bun.build({ entrypoints: [entry], outdir: site, naming, target: "browser", format: "esm" });
  if (!b.success) {
    console.error(b.logs.join("\n"));
    process.exit(1);
  }
};
await build(join(here, "index.ts"), "ws.js");
await build(join(here, "../notebook/stores.js"), "stores.js");
await build(join(old, "web/workspace/index.ts"), "old-ws.js");
await build(join(old, "web/notebook/stores.js"), "old-stores.js");
copyFileSync(join(here, "test-workspace-journal.page.js"), join(site, "cases.js"));
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>journal activation test</title><script type="module">import { run } from "./cases.js"; window.run = run; window.ready = true;</script>`);
const FILES = ["/ws.js", "/stores.js", "/old-ws.js", "/old-stores.js", "/cases.js"];
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
  const p = new URL(req.url).pathname;
  if (p !== "/" && !FILES.includes(p)) return new Response("not found", { status: 404 });
  const f = Bun.file(join(site, p === "/" ? "index.html" : p.slice(1)));
  return new Response(f, { headers: { "content-type": p.endsWith(".js") ? "text/javascript" : "text/html" } });
} });

let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-wsj-"));
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
    if (process.env.PROGRESS && m.method === "Runtime.consoleAPICalled" && m.params.args?.[0]?.value?.startsWith?.("test: ")) console.log(m.params.args[0].value);
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800)); return r.result?.value; };
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
  for (let i = 0; i < 200 && !(await ev("window.ready === true").catch(() => false)); i++) await sleep(50);
  const results = await ev("window.run()");
  const fails = results.filter(([ok]) => !ok).map(([, what]) => what);
  for (const e of errors) fails.push("page error: " + e);
  if (fails.length) {
    console.error(`FAIL: ${fails.length} of ${results.length} checks\n  ` + fails.join("\n  "));
  } else {
    console.log(`ok: the journal's activation, ${results.length} checks`);
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
  for (const d of [profile, site, old]) rmSync(d, { recursive: true, force: true });
}
process.exit(code);
