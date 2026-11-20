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
  const ws2 = new WebSocket(`ws://127.0.0.1:${srv.port}/`);
  await new Promise((r) => ws2.addEventListener("open", r));
  const c2 = cdpClient(ws2);
  const p3 = c2.send("Runtime.evaluate", {}, 60000).then(() => "answered", (e) => e.message);
  c2.cancel("the case was cancelled");
  const r3 = await p3, r4 = await c2.send("Page.navigate", {}, 60000).then(() => "sent", (e) => e.message);
  c2.resume();
  const p5 = c2.send("Runtime.evaluate", {}, 200).then(() => "answered", (e) => e.message);
  ok(/cancelled/.test(r3) && /Page\.navigate: the case was cancelled/.test(r4) && /no answer in 200 ms/.test(await p5),
    "a cancel rejects what's pending and refuses every new command until resume()", { r3, r4 });
  ws2.close();
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

  // ...and a case's own steps stop too: a connect or a tool that settles after the case's time sends nothing more (no
  // given file, no agent call, no turn, no expect) after its surface and tabs are closed
  const late = async (slow) => {
    const events = [];
    const wait = (name) => new Promise((r) => setTimeout(r, slow === name ? 120 : 0));
    const page = { errors: [], fresh: async () => {}, cancel: () => events.push("cancel"), closeTabs: async () => { events.push("tabs closed"); } };
    const surface = {
      name: "chat",
      connect: async () => { await wait("connect"); events.push("connect settled"); },
      tool: async (name, a) => { events.push("tool " + name + " " + (a.path ?? "")); await wait("tool"); return {}; },
      beginTurn: async () => { events.push("turn"); },
      endTurn: () => events.push("turn ended"),
      close: async () => { events.push("surface closed"); return []; },
    };
    const kase = { id: "late-" + slow, prompt: "p", ms: 40, given: { "/x": "x" }, agent: [{ tool: "workspace_write", args: { path: "/y" } }], expect: async () => { events.push("expect"); } };
    const fails = await check("late", () => runCase(kase, "stub", { site: { origin: "http://x" }, page, surfaces: { stub: async () => surface }, shotDir: null }));
    await new Promise((r) => setTimeout(r, 200));
    const afterClose = events.slice(events.indexOf("surface closed") + 1).filter((e) => !/^(tabs closed|connect settled)$/.test(e));
    return { fails, events, afterClose };
  };
  const lc = await late("connect");
  ok(lc.fails.some((f) => /over 0\.04 s/.test(f)) && lc.events.includes("connect settled") && lc.afterClose.length === 0 && !lc.events.some((e) => /^tool|^turn|^expect/.test(e)),
    "...a connect that settles after the case's time: no given file, agent call, turn or expect follows", lc);
  const lt = await late("tool");
  ok(lt.fails.some((f) => /over 0\.04 s/.test(f)) && lt.afterClose.length === 0 && lt.events.filter((e) => /^tool/.test(e)).length === 1 && !lt.events.some((e) => /^turn|^expect/.test(e)),
    "...a tool that settles after the case's time: no later tool, turn or expect follows", lt);
}

// (5a) the mcp surface's close answers the call still in flight at once, refuses every later one, and kills the server:
//      nothing reaches it after the close
{
  const { lineCalls } = await import("./harness.mjs");
  const { spawn } = await import("node:child_process");
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(tmpdir() + "/sb-flows-line-"), got = dir + "/got";
  // (a server that takes every call and never answers, writing down what it got)
  const proc = spawn(process.execPath, ["-e", `const fs = require("node:fs"); process.stdin.on("data", (d) => fs.appendFileSync(${JSON.stringify(got)}, d)); setInterval(() => {}, 1e9);`], { stdio: ["pipe", "pipe", "ignore"] });
  const calls = lineCalls(proc);
  const first = calls.tool("workspace_write", { path: "/a" });
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  await calls.close();
  const r1 = await Promise.race([first, new Promise((r) => setTimeout(() => r("still in flight"), 1000))]);
  const r2 = await Promise.race([calls.tool("workspace_write", { path: "/b" }), new Promise((r) => setTimeout(() => r({ text: "never answered" }), 1000))]);
  await new Promise((r) => setTimeout(r, 200));
  const seen = (() => { try { return readFileSync(got, "utf8"); } catch { return ""; } })();
  const gone = proc.exitCode !== null || proc.signalCode !== null;
  ok(/closed/.test(r1?.text ?? "") && r1.isError && /closed/.test(r2.text) && gone && /"\/a"/.test(seen) && !/"\/b"/.test(seen) && Date.now() - t0 < 2000,
    "the mcp surface's close answers the call in flight, refuses later ones and kills its server", { r1, r2, gone, seen });
  if (!gone) proc.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}

// (5b) a cancelled case that doesn't settle within CLEANUP_MS stops the suite: no next case starts, the page isn't given
//      back (no resume, no tab closed through it)
{
  const { runCases, CLEANUP_MS } = await import("./harness.mjs");
  let made = 0, resumed = 0, tabsClosed = 0;
  const page = { errors: [], fresh: async () => {}, cancel: () => {}, resume: () => { resumed++; }, closeTabs: async () => { tabsClosed++; } };
  const surfaces = { stub: async () => { made++; return { name: "stub", connect: async () => {}, tool: async () => ({}), close: async () => [] }; } };
  const stuck = { id: "stuck", prompt: "p", surfaces: ["stub"], ms: 40, expect: () => new Promise(() => {}) };
  const next = { id: "next", prompt: "p", surfaces: ["stub"], expect: async () => {} };
  const t0 = Date.now();
  const r = await check("stuck", () => runCases([stuck, next], { site: { origin: "http://x" }, page, surfaces, log: () => {} }));
  const took = Date.now() - t0;
  ok(r.results.length === 1 && r.results[0].failures.unsettled && /stuck on stub .*didn't settle/.test(r.stopped ?? "") && made === 1 && resumed === 0 && tabsClosed === 0 && took < 40 + 2 * CLEANUP_MS,
    "a cancelled case that doesn't settle stops the suite: no next case, the page not given back", { stopped: r.stopped, runs: r.results.length, made, resumed, tabsClosed, took });
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
