// ci: web-runner order=260 runner=bun chrome
// A confirmed large move's publication tokens (Stage A layer 1; design stage-a-l1 r2.2 addenda A1 + A1.1; the
// grader's rows A1-T1..T13) in headless Chromium, with real IndexedDB: this build's workspace and its mutants, each made
// here by exact patches of a copy of web/, each of which must FAIL the rows that guard against it:
//   noA1        no publication tokens (L1 without A1)                       -> T1, T2
//   sepTx       the publication's tokens in a later, separate transaction   -> T2 (closed connection tolerated: the mutant's own noise isn't a page error)
//   nullChain   a mismatched or missing destination given null              -> T4
//   swallow     a failed token write caught, the save committed             -> T11 (i)
//   dedupIdent  the sweep-2 token dropped as a duplicate of an ident        -> T10
//   oldRev      the publication's rev from the plan's record (A1's rec.rev + 1), not the generation -> T12b
//   republish   the publication's tokens written again at sweep 1          -> T13
// The cases are in test-history-d11.page.js.
//   CHROME=google-chrome bun web/history/test-history-d11.mjs
import { spawn } from "node:child_process";
import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname, root = join(here, "../..");
const site = mkdtempSync(join(tmpdir(), "sb-hd11-site-")), copies = [];
const die = (m) => { console.error("FAIL: " + m); process.exit(1); };
const build = async (entry, naming) => {
  const b = await Bun.build({ entrypoints: [entry], outdir: site, naming, target: "browser", format: "esm" });
  if (!b.success) die(b.logs.join("\n"));
};
// (each mutant: exact patches of one or more files of a copy of web/, each applying exactly once, else the run fails)
const PUB = "      if (await historyActive(tx0)) {\n";
const MUTANTS = {
  noA1: [["workspace/sync-replay.ts", PUB, "      if (false && (await historyActive(tx0))) {\n"]],
  sepTx: [["workspace/sync-replay.ts", PUB, "      if (await historyActive(tx0)) setTimeout(() => { try { const t2 = w.ws.transaction([\"entries\", \"htokens\", \"hmeta\", \"ops\", \"meta\"], \"readwrite\"); void (async () => { for (const x of maps) if (x.top) await noteToken(t2, { ident: x.top, rev: 0, kind: \"folder\", chain: null }); })().catch(() => {}); } catch {} }, 300);\n      if (false) {\n"]],
  nullChain: [["workspace/sync-replay.ts", ', (p) => pub.get(p), parentOf) : "broken",', ", (p) => pub.get(p), parentOf) : null,"]],
  swallow: [["history/tokens.ts", '  tx.objectStore("htokens").add({ ...row, sz } satisfies Token);', '  try { tx.objectStore("htokens").add({ ...row, sz } satisfies Token); } catch {}']],
  dedupIdent: [["history/tokens.ts", '  // (add, not put: a duplicate seq', '  if (((await req(tx.objectStore("htokens").getAll())) as Token[]).some((r) => r.ident === t.ident)) return;\n  // (add, not put: a duplicate seq']],
  oldRev: [["workspace/sync-replay.ts", "            ident: x.top, rev: gen, kind,", "            ident: x.top, rev: rec.rev + 1, kind,"]],
  republish: [["workspace/sync-replay.ts", '          REPLAY.cut?.("sweep1", m);\n', '          REPLAY.cut?.("sweep1", m);\n          if (!(globalThis as any).__republished) { (globalThis as any).__republished = true; for (const y of maps) if (y.top) await noteToken(tx, { ident: y.top, rev: 0, kind: "folder", chain: null }); }\n']],
};
for (const [name, patches] of Object.entries(MUTANTS)) {
  const dir = mkdtempSync(join(tmpdir(), `sb-hd11-${name}-`));
  copies.push(dir);
  cpSync(join(root, "web"), join(dir, "web"), { recursive: true, filter: (p) => !/node_modules/.test(p) });
  cpSync(join(root, "src"), join(dir, "src"), { recursive: true });
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
  for (const [file, a, b] of patches) {
    const p = join(dir, "web", file), s = readFileSync(p, "utf8");
    if (s.split(a).length !== 2) die(`mutant ${name}'s patch of ${file} doesn't apply exactly once`);
    writeFileSync(p, s.replace(a, b));
  }
  await build(join(dir, "web/workspace/index.ts"), `ws-${name}.js`);
}
await build(join(root, "web/workspace/index.ts"), "ws-head.js");
copyFileSync(join(here, "test-history-d11.page.js"), join(site, "cases.js"));
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>history d11 test</title><script type="module">import { run } from "./cases.js"; window.run = run; window.ready = true;</script>`);
const FILES = ["/cases.js", "/ws-head.js", ...Object.keys(MUTANTS).map((m) => `/ws-${m}.js`)];
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
  const p = new URL(req.url).pathname;
  if (p !== "/" && !FILES.includes(p)) return new Response("not found", { status: 404 });
  return new Response(Bun.file(join(site, p === "/" ? "index.html" : p.slice(1))), { headers: { "content-type": p.endsWith(".js") ? "text/javascript" : "text/html" } });
} });

let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-hd11-"));
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
  // (a mutant's page errors are expected (a broken build may throw); this build's are not: the cases catch per run)
  for (const e of errors) fails.push("page error: " + e);
  if (fails.length) console.error(`FAIL: ${fails.length} of ${results.length} checks\n  ` + fails.join("\n  "));
  else {
    console.log(`ok: a confirmed large move's publication tokens (A1, A1.1), ${results.length} checks`);
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
  for (const d of [profile, site, ...copies]) rmSync(d, { recursive: true, force: true });
}
process.exit(code);
