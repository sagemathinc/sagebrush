// The board journal (2c-1b-i: web/board/journal.ts, Workspace.journalWrite; design-2c1b-i r3) in headless Chromium,
// with real IndexedDB and Web Locks: a board's T1 then T2, its load's recovery (an old row stamped), the row's
// envelope all or none whatever writes it, markOnly's races, the record/document boundary, the kind's law and merge,
// and a board's deletion.  The cases are in test-board-journal.page.js.  The page's own wiring (page.ts) is
// test-board-journal-page.mjs's.
//   CHROME=google-chrome bun web/board/test-board-journal.mjs
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const J = JSON.stringify;
const statics = [];
{
  // (§2.1's census of the raw paths that change a board's row (api.ts): each ordinary one drops the envelope; the only
  // transaction over boards and meta is the journal's T2.  A new raw path makes this fail, to be looked at)
  const api = readFileSync(join(here, "../workspace/api.ts"), "utf8");
  const plain = (api.match(/"boards", "readwrite"/g) ?? []).length, journal = (api.match(/\["boards", "meta"\], "readwrite"/g) ?? []).length;
  statics.push([plain === 5 && journal === 1, `the boards store is written in 5 ordinary transactions and 1 journal one (census): ${J({ plain, journal })}`]);
  statics.push([/const \{ tag: _t, \.\.\.rest \} = plainRow\(cur\);/.test(api) && /st\.put\(\{ \.\.\.plainRow\(rec\), doc: \{ \.\.\.rec\.doc, title: newName \}/.test(api), "write and retitle drop the row's envelope (plainRow)"]);
  statics.push([/await dropRows\(st, pre\)/.test(api), "a board's deletion drops its journal's rows"]);
  // (the field guard (test 7): no board the site ships has a field of the journal's own, or an id, at its top)
  const ex = join(here, "examples"), bad = [];
  for (const f of readdirSync(ex).filter((f) => f.endsWith(".json") && f !== "index.json")) {
    const d = JSON.parse(readFileSync(join(ex, f), "utf8"));
    for (const k of ["rev", "j", "hash", "unjournaled", "baseRev", "id"]) if (d && typeof d === "object" && k in d) bad.push(`${f}: ${k}`);
  }
  statics.push([bad.length === 0, "no example board has a top-level rev, j, hash, unjournaled, baseRev or id: " + J(bad)]);
}
const site = mkdtempSync(join(tmpdir(), "sb-bj-site-")), src = mkdtempSync(join(here, ".test-board-journal-"));
let code = 1;
// (one bundle, so the workspace, the journal's store and the board's journal share one copy of the stores)
writeFileSync(join(src, "entry.js"), [
  `export * as W from ${J(join(here, "../workspace/index.ts"))};`,
  `export * as A from ${J(join(here, "../workspace/api.ts"))};`,
  `export * as BJ from ${J(join(here, "journal.ts"))};`,
  `export * as BH from ${J(join(here, "history.ts"))};`,
  `export * as H from ${J(join(here, "../notebook/history.js"))};`,
  `export * as R from ${J(join(here, "../journal/rows.js"))};`,
  `export * as S from ${J(join(here, "../notebook/stores.js"))};`,
].join("\n"));
const b = await Bun.build({ entrypoints: [join(src, "entry.js")], outdir: site, naming: "all.js", target: "browser", format: "esm" });
rmSync(src, { recursive: true, force: true });
if (!b.success) {
  console.error(b.logs.join("\n"));
  rmSync(site, { recursive: true, force: true });
  process.exit(1);
}
copyFileSync(join(here, "test-board-journal.page.js"), join(site, "cases.js"));
// (the merge vectors' board section, for the kind's apply (test 8): gen-merge3-board-vectors.mjs's)
copyFileSync(join(here, "../notebook/merge3-vectors.json"), join(site, "vectors.json"));
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>board journal test</title><script type="module">import { run } from "./cases.js"; window.run = run; window.ready = true;</script>`);
const FILES = ["/all.js", "/cases.js", "/vectors.json"];
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
  const p = new URL(req.url).pathname;
  if (p !== "/" && !FILES.includes(p)) return new Response("not found", { status: 404 });
  const f = Bun.file(join(site, p === "/" ? "index.html" : p.slice(1)));
  return new Response(f, { headers: { "content-type": p.endsWith(".js") ? "text/javascript" : p.endsWith(".json") ? "application/json" : "text/html" } });
} });

let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-bj-"));
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
    console.log(`ok: the board journal, ${results.length} checks`);
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
