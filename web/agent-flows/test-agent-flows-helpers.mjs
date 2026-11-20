// ci: web-runner order=187 runner=bun
// The agent-flow harness's own checks, against a stand-in page and surface (no browser): each must fail where the person
// wouldn't see what the case asks for, so a case can't pass on the saved copy alone or on a file of the same name.
//   bun web/agent-flows/test-agent-flows-helpers.mjs
import { helpers } from "./harness.mjs";

let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (c || detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 300))); if (!c) failures++; };
const PLOT = { output_type: "display_data", data: { "image/svg+xml": "<svg/>", "text/plain": "plot" } };

/** A page showing `shown`, with `live` (cells' outputs, or null: nothing rendered), and a saved copy with `saved`. */
function stand(shown, live, saved) {
  const surface = {
    name: "chat",
    shownPath: "SHOWN",
    liveCells: "LIVE",
    tool: async (name) => name === "workspace_read" ? { isError: false, structured: { result: { content: { json: { mode: "sage", cells: saved.map((o) => ({ code: "x", outputs: o })) } } } } } : { isError: false, structured: { result: {} } },
  };
  const ev = async (js) => js === "SHOWN" ? shown : js === "LIVE" ? live : (js.startsWith("Promise.resolve(SHOWN)") ? eval(js.replace("Promise.resolve(SHOWN)", "Promise.resolve(" + JSON.stringify(shown) + ")")) : null);
  const page = { ev, until: async (js, ms = 0) => !!(await ev(js)), origin: "http://x" };
  const fails = [];
  const quiet = console.log;
  return { h: helpers(page, surface, fails, null, "self-check"), fails, quiet };
}

async function check(name, f) {
  const log = console.log;
  console.log = () => {};
  try { return await f(); } finally { console.log = log; }
}

// (1) shown: the full path, exactly; a notebook of the same name in another folder is not it
{
  const a = stand("/wrong-folder/sin.ipynb", null, []);
  await check("shown", () => a.h.shown("/wanted-folder/sin.ipynb", 10));
  ok(a.fails.length === 1, "h.shown fails when the page shows another folder's notebook of the same name", a.fails);
  const b = stand("/wanted-folder/sin.ipynb", null, []);
  await check("shown", () => b.h.shown("/wanted-folder/sin.ipynb", 10));
  ok(b.fails.length === 0, "...and passes when it shows that exact path", b.fails);
}

// (2) ran: as the person sees it, not only the saved copy
{
  const a = stand("/sin.ipynb", null, [[PLOT]]);
  await check("ran", () => a.h.ran("/sin.ipynb", { images: 1, errors: 0 }, 10));
  ok(a.fails.length === 1 && /as the person sees it/.test(a.fails[0]), "h.ran fails when the saved copy has the plot but the page shows no outputs", a.fails);
  const b = stand("/other.ipynb", [[PLOT]], [[PLOT]]);
  await check("ran", () => b.h.ran("/sin.ipynb", { images: 1, errors: 0 }, 10));
  ok(b.fails.length === 1 && /as the person sees it/.test(b.fails[0]), "...and when the page shows the plot of another notebook", b.fails);
  const c = stand("/sin.ipynb", [[PLOT]], [[]]);
  await check("ran", () => c.h.ran("/sin.ipynb", { images: 1, errors: 0 }, 10));
  ok(c.fails.length === 1 && /saved/.test(c.fails[0]), "...and when the page shows it but the saved copy hasn't it", c.fails);
  const d = stand("/sin.ipynb", [[PLOT]], [[PLOT]]);
  await check("ran", () => d.h.ran("/sin.ipynb", { images: 1, errors: 0 }, 10));
  ok(d.fails.length === 0, "...and passes when both have it", d.fails);
  const e = stand("/sin.ipynb", [[PLOT, { output_type: "error", ename: "E", evalue: "x", traceback: [] }]], [[PLOT]]);
  await check("ran", () => e.h.ran("/sin.ipynb", { images: 1, errors: 0 }, 10));
  ok(e.fails.length === 1, "...and fails on an error the person sees", e.fails);
}

// (3) the chat surface reads what the Agents page's pane shows: the one pane observer, never a null that only the saved
//     copy could stand in for
{
  const { readFileSync } = await import("node:fs");
  const { PANE_CELLS } = await import("./harness.mjs");
  const here = new URL(".", import.meta.url).pathname;
  const h = readFileSync(here + "harness.mjs", "utf8");
  ok(/\.pane-body/.test(PANE_CELLS) && /\.cell/.test(PANE_CELLS), "the pane observer reads the pane's cells");
  ok(/liveCells: PANE_CELLS/.test(h) && !/liveCells: `null`/.test(h), "the chat surface reads the pane through it");
}

// (4) every DevTools command has a deadline: one never answered is rejected by it, its entry dropped; a socket that
//     closes rejects what is still pending
{
  const { cdpClient } = await import("./harness.mjs");
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req, s) { return s.upgrade(req) ? undefined : new Response("no", { status: 400 }); }, websocket: { message() {} } });
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/`);
  await new Promise((r) => ws.addEventListener("open", r));
  const c = cdpClient(ws);
  const t0 = Date.now();
  const r1 = await c.send("Runtime.evaluate", {}, 300).then(() => "answered", (e) => e.message);
  ok(/no answer in 300 ms/.test(r1) && Date.now() - t0 < 1500 && c.pending.size === 0, "a DevTools command never answered is rejected at its deadline, its entry dropped", { r1, ms: Date.now() - t0, pending: c.pending.size });
  const p2 = c.send("Page.navigate", {}, 60000).then(() => "answered", (e) => e.message);
  ws.close();
  const r2 = await Promise.race([p2, new Promise((r) => setTimeout(() => r("still pending after 2 s"), 2000))]);
  ok(/closed/.test(r2) && c.pending.size === 0, "a socket that closes rejects the command still pending", { r2, pending: c.pending.size });
  srv.stop(true);
}

// (5) a case over its time is cancelled: what it waits on is rejected, each helper it calls after throws, its surface and
//     tabs are closed, and runCase returns within its time and CLEANUP_MS, the case failed
{
  const { runCase, CLEANUP_MS } = await import("./harness.mjs");
  let cancelled = 0, closed = 0, tabsClosed = 0, after = null;
  const hung = new Set();
  const page = {
    errors: [], fresh: async () => {}, closeTabs: async () => { tabsClosed++; },
    cancel: () => { cancelled++; for (const no of hung) no(new Error("cancelled")); hung.clear(); },
    ev: () => new Promise((_, no) => hung.add(no)), until: async () => false,
  };
  const surface = { name: "chat", connect: async () => {}, tool: async () => ({}), close: async () => { closed++; return []; } };
  const kase = { id: "never-answers", prompt: "p", surfaces: ["stub"], ms: 400, expect: async (h) => {
    try { await h.ev("1"); } catch {}
    try { await h.ev("2"); after = "ran"; } catch (e) { after = e.message; }
  } };
  const t0 = Date.now();
  const fails = await check("cancel", () => runCase(kase, "stub", { site: { origin: "http://x" }, page, surfaces: { stub: async () => surface }, shotDir: null }));
  const took = Date.now() - t0;
  ok(fails.some((f) => /over 0\.4 s/.test(f)) && cancelled === 1 && closed === 1 && tabsClosed === 1 && /cancelled/.test(after ?? "") && took < 400 + CLEANUP_MS,
    "a case whose page never answers fails at its time: cancelled, its surface and tabs closed, its later calls refused, within CLEANUP_MS", { fails, cancelled, closed, tabsClosed, after, took });
}

// (6) the site: a server that fails, says something other than its port, or says nothing is refused, and its process is gone
// (7) Chrome: one that exits, or never says its DevTools port, is refused, with no process left and its profile removed
{
  const { startSite, startChrome } = await import("./harness.mjs");
  const { mkdtempSync, readFileSync, readdirSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "sb-flows-selfcheck-"));
  const gone = async (pidFile) => {
    let pid = 0;
    for (let i = 0; i < 40 && !pid; i++) { try { pid = Number(readFileSync(pidFile, "utf8")); } catch {} if (!pid) await new Promise((r) => setTimeout(r, 50)); }
    for (let i = 0; i < 40; i++) { try { process.kill(pid, 0); } catch { return pid > 0; } await new Promise((r) => setTimeout(r, 50)); }
    return false;
  };
  for (const [name, script, ms] of [["a server that exits", "echo $$ > PID; exit 3", 3000], ["a server that says something else", "echo $$ > PID; echo hello; exec sleep 30", 3000], ["a silent server", "echo $$ > PID; exec sleep 30", 500]]) {
    const pidFile = join(dir, "site-" + name.length);
    const why = await startSite({ command: ["sh", "-c", script.replace("PID", pidFile)], ms }).then((s) => { s.kill(); return "started"; }, (e) => e.message);
    ok(why !== "started" && await gone(pidFile), `startSite refuses ${name}, and its process is gone`, why);
  }
  const profiles = () => readdirSync(tmpdir()).filter((f) => f.startsWith("sb-agent-flows-")).sort();
  for (const [name, script, startMs] of [["a Chrome that exits", "echo $$ > PID; exit 1", 3000], ["a Chrome that never says its port", "echo $$ > PID; exec sleep 30", 500]]) {
    const pidFile = join(dir, "chrome-" + name.length), bin = join(dir, "chrome-" + name.length + ".sh");
    writeFileSync(bin, "#!/bin/sh\n" + script.replace("PID", pidFile) + "\n");
    chmodSync(bin, 0o755);
    const before = profiles();
    const why = await startChrome({ bin, startMs }).then(async (p) => { await p.close(); return "started"; }, (e) => e.message);
    const left = profiles().filter((f) => !before.includes(f));
    ok(why !== "started" && await gone(pidFile) && left.length === 0, `startChrome refuses ${name}: no process left, its profile removed`, { why: why.slice(0, 160), left });
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `FAIL: ${failures} of the harness's self-checks` : "ok: the harness's self-checks");
process.exit(failures ? 1 : 0);
