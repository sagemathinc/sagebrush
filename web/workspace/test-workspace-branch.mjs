// ci: web-runner order=192 runner=bun chrome
// An agent's branch (chat plan PR 3), with its cases in branch-cases.js: one tab's rows, then the rows that need a
// tab closed mid-run or a second tab (8, 8b, 10, 11), in one Chrome profile.
//   CHROME=google-chrome bun web/workspace/test-workspace-branch.mjs        (ONLY=copy,ownership for some cases; SKIP=limits,bytes
//   leaves out the two at full scale, 2,000 entries and 256 MiB, which take about three minutes)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const site = mkdtempSync(join(tmpdir(), "sb-ws-branch-site-"));
writeFileSync(join(site, "entry.ts"), [
  `export * from ${JSON.stringify(join(here, "index.ts"))};`,
  `export { BRANCH_HOOK } from ${JSON.stringify(join(here, "api.ts"))};`,
  `export * from ${JSON.stringify(join(here, "git-branch.ts"))};`,
  `export * from ${JSON.stringify(join(here, "branch-rules.ts"))};`,
].join("\n"));
const built = await Bun.build({ entrypoints: [join(site, "entry.ts")], outdir: site, naming: "ws.js", target: "browser", format: "esm" });
if (!built.success) {
  console.error(built.logs.join("\n"));
  process.exit(1);
}
copyFileSync(join(here, "branch-cases.js"), join(site, "cases.js"));
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>branch test</title><script type="module">import { run, steps } from "./cases.js"; window.run = run; window.B = steps; window.ready = true;</script>`);
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
  const p = new URL(req.url).pathname;
  if (!["/", "/ws.js", "/cases.js"].includes(p)) return new Response("not found", { status: 404 });
  return new Response(Bun.file(join(site, p === "/" ? "index.html" : p.slice(1))), { headers: { "content-type": p.endsWith(".js") ? "text/javascript" : "text/html" } });
} });
const url = `http://127.0.0.1:${server.port}/`;

let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-ws-branch-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); if (process.env.SHOW) console.log((ok ? "  ok   " : "  FAIL ") + what); };

/** A tab: opened on the test page, evaluated in, closed (as the person closing it would: its renderer ends). */
async function tab() {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const waiting = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") fails.push("page error: " + (m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails)).slice(0, 500));
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 2000)); return r.result?.value; };
  await send("Runtime.enable");
  for (let i = 0; i < 200 && !(await ev("window.ready === true").catch(() => false)); i++) await sleep(50);
  const B = (f, ...args) => ev(`window.B.${f}(${args.map((a) => JSON.stringify(a)).join(",")})`);
  const close = async () => { try { ws.close(); } catch {} await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`); await sleep(300); };
  const until = async (f, what) => { for (let i = 0; i < 400; i++) { if (await B(f)) return; await sleep(25); } throw new Error("never reached: " + what); };
  return { ev, B, close, until };
}

let code = 1;
try {
  if (!port) port = await devtoolsPort(profile);
  for (let i = 0; i < 300; i++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch {} await sleep(100); }
  const T = {
    unfinished: "this branch wasn't finished, so it can't be changed: make a new one with git_branch under another name",
    taken: (n) => `the name "${n}" is taken: pick another name for git_branch`,
    closed: "the page closed during the copy",
  };
  if (!process.env.ONLY_TABS) {
    const one = await tab();
    const results = await one.ev(`window.run(${process.env.ONLY ? JSON.stringify(process.env.ONLY.split(",")) : "undefined"}, ${JSON.stringify((process.env.SKIP ?? "").split(",").filter(Boolean))})`);
    for (const [ok, what] of results) { if (/^\(\w+: \d+ ms\)$/.test(what)) { console.log("  " + what); continue; } check(ok, what); }
    await one.close();
  }
  if (!process.env.ONLY) {
    // (row 8: the tab closed mid-copy; on the next load, failed, never ready, still charged, read only, its name taken)
    let a = await tab();
    await a.B("open", "mt8"); await a.B("seed");
    await a.B("startPaused", "c8", "copied", 1);
    await a.until("reached", "row 8's pause");
    await a.close();
    let b = await tab();
    await b.B("open", "mt8");
    await b.B("reconcile");
    const r8 = await b.B("rec", "c8");
    check(r8?.status === "failed" && r8.reason === T.closed && r8.entries === 5 && r8.bytes === 8, `row 8: after the tab closed, failed with "${r8?.reason}", charged ${r8?.entries} entries, ${r8?.bytes} bytes`);
    check((await b.B("agentWrite", "g1", "/Branches/c8/n.txt")) === T.unfinished, "row 8: its maker's writes refused");
    check((await b.B("branch", "c8")) === T.taken("c8"), "row 8: its name stays taken");
    // (row 8b: the person removes it: its slot and name released, the same name made again)
    await b.B("personRemove", "/Branches/c8");
    await b.B("reconcile");
    check((await b.B("rec", "c8")) === null && (await b.B("branch", "c8")) === null && (await b.B("rec", "c8"))?.status === "ready", "row 8b: removed by the person, released; git_branch of the same name succeeds");
    await b.close();
    // (row 10: tab A paused mid-copy; tab B's reconcile waits for it, and A's run ends ready)
    a = await tab();
    await a.B("open", "mt10"); await a.B("seed");
    await a.B("startPaused", "c10", "copied", 1);
    await a.until("reached", "row 10's pause");
    b = await tab();
    await b.B("open", "mt10");
    check((await b.B("reconcileWithin", 600)) === false, "row 10: B's reconcile waits for A's run (the creation lock)");
    check((await b.B("rec", "c10"))?.status === "making", "row 10: A's record stays making, charged, meanwhile");
    await a.B("resume");
    check((await a.B("result")) === "made", "row 10: A resumes and its branch is made");
    await b.B("reconcileDone");
    check((await b.B("rec", "c10"))?.status === "ready", "row 10: ready, never failed or released by B's reconcile");
    await a.close(); await b.close();
    // (row 11, before the commit: the root's transaction never commits (the tab hangs there and is closed))
    a = await tab();
    await a.B("open", "mt11"); await a.B("seed");
    await a.B("hangInRoot", "c11a");
    await sleep(800);
    await a.close();
    b = await tab();
    await b.B("open", "mt11");
    check((await b.B("stat", "/Branches/c11a")) === null && (await b.B("rec", "c11a")) === null && (await b.B("rows")) === 0, "row 11, before the commit: no folder, no record, no charge");
    check((await b.B("branch", "c11a")) === null, "row 11, before the commit: the name is free");
    await b.close();
    // (row 11, after the commit: the root and its making record; failed and still charged on reload)
    a = await tab();
    await a.B("open", "mt11b"); await a.B("seed");
    await a.B("startPaused", "c11b", "rooted");
    await a.until("reached", "row 11's pause after the commit");
    check((await a.B("rec", "c11b"))?.status === "making" && !!(await a.B("stat", "/Branches/c11b")), "row 11, after the commit: the root and a making record, charged");
    await a.close();
    b = await tab();
    await b.B("open", "mt11b");
    await b.B("reconcile");
    const r11 = await b.B("rec", "c11b");
    check(r11?.status === "failed" && r11.reason === T.closed && r11.entries === 5 && !!(await b.B("stat", "/Branches/c11b")), `row 11, after the commit: failed on reload, still charged (${JSON.stringify(r11)})`);
    await b.close();
  }
  if (fails.length) console.error(`FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  "));
  else { console.log(`ok: an agent's branch, ${checks} checks`); code = 0; }
} finally {
  chrome.kill();
  server.stop(true);
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
  rmSync(site, { recursive: true, force: true });
}
process.exit(code);
