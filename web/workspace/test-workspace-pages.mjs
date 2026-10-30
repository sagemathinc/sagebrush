// Both pages wired to the workspace (web/workspace/, design/workspace-files.md
// step 1b), in headless Chromium against the built site:
// - the board page: a board kept before in localStorage is brought in, under
//   its id; an edit is written to the workspace, the old localStorage copy
//   left as it was and the pending copy dropped once written; a reload shows
//   the workspace's copy; a pending copy left by a page closed mid-write is
//   taken at the next load and written; ?new= makes a board of the
//   workspace; window.sagebrush.workspace is the agent's view (no
//   dropVersions, no forget), its changes credited to agent:page;
// - the notebook page: the open notebook is listed, renamed with its name,
//   and dropped from the list when deleted; uploads go through the
//   workspace, an overwrite keeping a version, and so do Python's writes;
//   the Files panel's ✕ puts a file in Trash.
// Serve web/dist first (python3 web/serve.py 8765), then
//   node web/workspace/test-workspace-pages.mjs
// Every DevTools call is bounded (PAGES_CALL_MS, default 30 s): a page promise that never settles, or a browser that
// stops answering, fails that call, naming the method and the expression, instead of hanging the run; so is every
// startup wait.  A watchdog (PAGES_RUN_S, default 300 s), armed before anything starts, ends an overrunning run, naming
// the last check and the call it was waiting on.  However the run ends (its end, a failure anywhere, the watchdog or
// SIGTERM), one cleanup runs, once: the DevTools sockets closed, Chrome stopped (TERM, then KILL) until it is seen to
// exit, the control children ended with their process groups, and the temporary directories removed (any it couldn't,
// said).  A call that times out is abandoned, not cancelled: its waiter is dropped, so a late answer is ignored, and
// its page-side evaluation runs on until the page navigates or its tab or Chrome is closed.  Two controls run this file
// again as children, each in its own process group, alongside the run, so they add no wall time:
// PAGES_WATCHDOG_CONTROL=hang hangs on purpose under a 20 s watchdog; PAGES_WATCHDOG_CONTROL=hang-late does the same
// with a helper of its own that writes into Chrome's profile only after Chrome's observed exit (as a Chrome helper that
// outlives it can), which the cleanup must wait for; PAGES_WATCHDOG_CONTROL=startup fails at its first startup wait.  Neither starts a child of its own.  Their results are checked at the end.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONTROL = process.env.PAGES_WATCHDOG_CONTROL ?? "";
const CALL_MS = Number(process.env.PAGES_CALL_MS) || 30_000;
const RUN_S = Number(process.env.PAGES_RUN_S) || 300;
let lastCheck = "(none yet)", waitingOn = "(nothing)";
const describe = (method, params) => method + (params?.expression ? ": " + String(params.expression).replace(/\s+/g, " ").slice(0, 160) : "");
/** `p`, or a rejection naming `what` once `ms` pass without an answer. */
const bounded = (p, what, ms = CALL_MS) => { let t; return Promise.race([p, new Promise((_, no) => { t = setTimeout(() => no(new Error(`no answer within ${ms} ms: ${what}`)), ms); })]).finally(() => clearTimeout(t)); };
/** True once `f()` is, polled for up to `ms`. */
const within = async (f, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await sleep(50); } return !!f(); };
/** Whether `pid` (negative: its process group) is gone.  Only ESRCH says so; any other error is said, never taken for gone. */
const goneOf = (pid) => { try { process.kill(pid, 0); return "alive"; } catch (e) { return e?.code === "ESRCH" ? "gone" : `unknown (${e?.code ?? e})`; } };
/** The process group `pid` is in now (Linux: /proc/<pid>/stat, field 5), or null if it can't be read. */
const pgidOf = (pid) => { try { const s = readFileSync(`/proc/${pid}/stat`, "utf8"); return Number(s.slice(s.lastIndexOf(")") + 2).split(" ")[2]); } catch { return null; } };
/** goneOf, for a process this run started: a group (negative pid) as it is; a bare pid is still ours only while it is in
 * `group` (in another group it was reused: ours is gone). */
/** A process's start time (Linux: /proc/<pid>/stat, field 22), or null if it can't be read: with its pid, it names
 * that one process and never a later one given the same pid */
const startOf = (pid) => { try { const s = readFileSync(`/proc/${pid}/stat`, "utf8"); return s.slice(s.lastIndexOf(")") + 2).split(" ")[19]; } catch { return null; } };
/** Chrome's whole tree now: `root` and every descendant (/proc's parent links), each with its start time.  Taken before
 * Chrome is stopped: its helpers are re-parented once it exits, and can outlive its observed exit */
const treeOf = (root) => {
  const children = new Map();
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try { const s = readFileSync(`/proc/${d}/stat`, "utf8"); const pp = +s.slice(s.lastIndexOf(")") + 2).split(" ")[1]; if (!children.has(pp)) children.set(pp, []); children.get(pp).push(+d); } catch {}
  }
  const out = [], queue = [root];
  while (queue.length) { const pid = queue.shift(); const start = startOf(pid); if (start !== null) out.push({ pid, start }); queue.push(...(children.get(pid) ?? [])); }
  return out;
};
/** Whether that process (its pid and start time) is gone: its pid unused, or used by a later process */
const procGone = (p) => startOf(p.pid) !== p.start;
const ownGoneOf = (pid, group) => {
  const s = goneOf(pid);
  if (s !== "alive" || pid < 0) return s;
  const g = pgidOf(pid);
  return g === group ? "alive" : g !== null ? "gone" : goneOf(pid) === "gone" ? "gone" : "unknown (its group can't be read)";
};
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; lastCheck = what; if (!ok) fails.push(what); };
const sockets = [];
/** The control children this run started: each leads its own process group, its Chrome in it (and nothing else). */
const kids = [];
/** A control child: this file run again as `mode`, with a `runS` watchdog, in its own process group; all it writes is
 * kept until it ends ("close": it has exited and its output has ended).  A backstop ends it at 120 s. */
const spawnKid = (mode, runS) => {
  const env = { ...process.env, PAGES_WATCHDOG_CONTROL: mode, PAGES_RUN_S: String(runS) };
  delete env.CDP_PORT;
  const k = { mode, out: "", err: "", ended: false, code: null, signal: null };
  k.c = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  k.c.stdout.on("data", (d) => (k.out += d));
  k.c.stderr.on("data", (d) => (k.err += d));
  k.done = new Promise((ok) => {
    k.c.once("close", (code, signal) => { Object.assign(k, { ended: true, code, signal }); ok(); });
    k.c.once("error", (e) => { k.err += `spawn error: ${e?.code ?? e}\n`; if (!k.c.pid) { k.ended = true; ok(); } });
  });
  kids.push(k);
  setTimeout(() => endKid(k), 120_000).unref();
  return k;
};
/** A control child ended, with all it started: its group TERMed (a child cleans up on TERM), up to 5 s for its observed
 * end, then the group KILLed and up to 5 s more.  Then its group and the Chrome it reported get up to 5 s to end by
 * themselves (Chrome's helpers can outlive its observed exit by moments); only what is still there after that, and still
 * ours, is KILLed here, and said (a failure).  Once per child; says what was seen. */
const endKid = (k) => (k.ending ??= (async () => {
  if (!k.c.pid) return "never started: " + k.err.trim();
  const g = -k.c.pid;
  let how = k.ended ? "had ended" : null;
  if (!how) {
    try { process.kill(g, "SIGTERM"); } catch {}
    if (await within(() => k.ended, 5000)) how = "ended on TERM";
  }
  if (!how) {
    try { process.kill(g, "SIGKILL"); } catch {}
    how = (await within(() => k.ended, 5000)) ? "ended on KILL" : "NOT seen to end";
  }
  const seen = [how];
  const c = /CONTROL \S+ (\d+)/.exec(k.out);
  for (const [what, pid] of [["its group", g], ["its Chrome", c ? +c[1] : 0]]) {
    if (!pid) continue;
    await within(() => ownGoneOf(pid, k.c.pid) === "gone", 5000);
    let s = ownGoneOf(pid, k.c.pid);
    if (s === "alive") { try { process.kill(pid, "SIGKILL"); } catch {} await within(() => ownGoneOf(pid, k.c.pid) === "gone", 5000); s += `, KILLed here: ${ownGoneOf(pid, k.c.pid)}`; }
    seen.push(`${what} ${s}`);
  }
  return seen.join("; ");
})());
let profile = null, files = null;
let chrome = null, chromeError = null, chromeExited = Promise.resolve();
/** Chrome's tree when it was stopped (treeOf), and processes the run counts as Chrome's helpers (the hang-late control's) */
let chromeTree = null;
const extraTree = [];
/** Chrome stopped and seen to exit: TERM, up to 5 s for its exit, then KILL and up to 5 s more; says which. */
const stopChrome = async () => {
  if (!chrome?.pid) return chromeError ? `never started (${chromeError?.code ?? chromeError})` : "never started";
  if (chrome.exitCode !== null || chrome.signalCode !== null) return "had exited";
  chromeTree = [...treeOf(chrome.pid), ...extraTree];
  chrome.kill("SIGTERM");
  if (await Promise.race([chromeExited.then(() => true), sleep(5000).then(() => false)])) return "exited on TERM";
  chrome.kill("SIGKILL");
  return (await Promise.race([chromeExited.then(() => true), sleep(5000).then(() => false)])) ? "exited on KILL" : "NOT seen to exit";
};
/** Chrome's tree (taken when it was stopped) gone: up to 5 s for it to end by itself, then what is still the same
 * process KILLed and up to 2 s more; says how many were seen gone, or which are not. */
const treeGone = async () => {
  if (!chromeTree) return "none";
  if (!(await within(() => chromeTree.every(procGone), 5000))) {
    for (const p of chromeTree) if (!procGone(p)) try { process.kill(p.pid, "SIGKILL"); } catch {}
    await within(() => chromeTree.every(procGone), 2000);
  }
  const left = chromeTree.filter((p) => !procGone(p)).map((p) => p.pid);
  return left.length ? `NOT gone: ${left.join(", ")}` : `${chromeTree.length} gone`;
};
/** The temporary directories removed; each one that couldn't be, with why. */
const removeDirs = () => { const left = []; for (const d of [profile, files]) if (d) try { rmSync(d, { recursive: true, force: true }); } catch (e) { left.push(`${d}: ${e?.code ?? e}`); } return left; };
/** The temporary directories stayed gone for 1 s after their removal: each one that came back (removed again), said */
const stayedGone = async () => {
  const back = new Set();
  for (const t = Date.now(); Date.now() - t < 1000; await sleep(100)) for (const d of [profile, files]) if (d && existsSync(d)) { back.add(d); try { rmSync(d, { recursive: true, force: true }); } catch {} }
  return [...back];
};
let cleaned = null;
/** Everything this run started, ended, and everything it made, removed: once, however the run ends (its end, a failure,
 * the watchdog or SIGTERM).  Says what was seen, and whether all of it was done. */
const cleanup = () => (cleaned ??= (async () => {
  for (const s of sockets) try { s.close(); } catch {}
  const how = await stopChrome();
  // (Chrome's whole tree gone before its directories are removed: a helper that outlives Chrome's observed exit could
  // write into its profile after the removal, and bring it back)
  const tree = await treeGone();
  const kidsSeen = [];
  for (const k of kids) kidsSeen.push(`${k.mode} ${await endKid(k)}`);
  const left = removeDirs();
  const back = left.length ? [] : await stayedGone();
  const dirs = left.length ? "temporary directories NOT removed: " + left.join(", ") : back.length ? "temporary directories recreated after removal: " + back.join(", ") : "temporary directories removed";
  const line = `cleanup: Chrome ${how}; ${dirs}; Chrome's tree: ${tree}${kids.length ? "; control children: " + kidsSeen.join(" | ") : ""}`;
  return { line, ok: how !== "NOT seen to exit" && !tree.startsWith("NOT") && !left.length && !back.length && kidsSeen.every((s) => !/alive|unknown|NOT|never started/.test(s)) };
})());
/** The run ended from outside its flow (the watchdog, SIGTERM): said, cleaned up, exit 1. */
const endNow = async (why) => {
  console.error(`FAIL: ${why}; the last check was "${lastCheck}"; waiting on: ${waitingOn}`);
  console.error("  " + (await cleanup()).line);
  process.exit(1);
};
// (the watchdog, armed before anything starts)
setTimeout(() => endNow(`the run didn't end within ${RUN_S} s`), RUN_S * 1000).unref();
process.once("SIGTERM", () => endNow("ended by SIGTERM"));

try {
  // (the temporary directories, made inside the try: if the second can't be, the cleanup removes the first)
  profile = mkdtempSync(join(tmpdir(), "sb-ws-pages-"));
  files = mkdtempSync(join(tmpdir(), "sb-ws-up-"));
  // (the forced-watchdog control's child, started first, so it costs no wall time)
  if (!CONTROL) { spawnKid("hang", 20); spawnKid("hang-late", 20); }
  chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  chromeExited = new Promise((r) => { chrome.once("exit", r); chrome.once("error", (e) => { chromeError = e; r(); }); });
  if (CONTROL && chrome.pid) console.log(`CONTROL ${profile} ${chrome.pid}`);
  // (the hang-late control's helper: once Chrome is seen gone, it waits 300 ms and writes into the profile; it counts as
  // part of Chrome's tree, as a real helper of Chrome's would)
  if (CONTROL === "hang-late" && chrome.pid) {
    const code = `const fs = require("fs"); const t = setInterval(() => { try { process.kill(${chrome.pid}, 0); } catch (e) { if (e.code === "ESRCH") { clearInterval(t); setTimeout(() => { fs.mkdirSync(${JSON.stringify(profile)}, { recursive: true }); fs.writeFileSync(${JSON.stringify(join(profile, "late-helper"))}, "x"); process.exit(0); }, 300); } } }, 20);`;
    const lw = spawn(process.execPath, ["-e", code], { stdio: "ignore" });
    if (lw.pid) extraTree.push({ pid: lw.pid, start: startOf(lw.pid) });
  }
  waitingOn = "Chrome's DevTools port";
  const portUp = CONTROL === "startup" ? new Promise(() => {}) : Promise.race([devtoolsPort(profile), chromeExited.then(() => { throw new Error(`Chrome ended before its DevTools port: ${chromeError?.code ?? chromeError ?? "exit " + (chrome.exitCode ?? chrome.signalCode)}`); })]);
  if (!port) port = await bounded(portUp, waitingOn, CONTROL === "startup" ? 1 : 60_000);
  let targets;
  waitingOn = "the page list (/json)";
  for (let i = 0; i < 300; i++) { try { targets = await bounded(fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()), waitingOn, 5000); if (targets.some((x) => x.type === "page")) break; } catch {} await sleep(100); }
  const pageTarget = Array.isArray(targets) ? targets.find((x) => x.type === "page") : undefined;
  if (!pageTarget) throw new Error("no page target in /json after 300 tries");
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  sockets.push(ws);
  await bounded(new Promise((r) => (ws.onopen = r)), (waitingOn = "the page's DevTools socket to open"), 10_000);
  // (the forced-watchdog control's own run: hang here on purpose, for its watchdog to end)
  if (CONTROL === "hang" || CONTROL === "hang-late") { waitingOn = "the control's deliberate hang"; await new Promise(() => {}); }
  // (the startup-failure control's child, started once this run is up)
  if (!CONTROL) spawnKid("startup", 60);
  /** A page promise that never settles, kept reachable from the page's global: an unreachable one can be collected,
   * and Chrome then answers the call waiting on it with an error ("Promise was collected"), which is an answer */
  const NEVER = "globalThis.__neverSettles ??= new Promise(() => {})";
  /** What a control's call came back with, if it came back at all (an error answer is an answer too: say which) */
  const answered = (v) => "answered: " + String(JSON.stringify(v)).slice(0, 300);
  /** A new tab's page loaded at its own URL (its first navigation, from the blank page it opens with, done): a call made
   * before that waits in a context the navigation destroys, and Chrome answers it with an error */
  const loaded = async (call, label, path) => {
    waitingOn = label + "its page to finish loading " + path;
    // (60 s in all, on the monotonic clock: each call and each pause gets at most what is left, and a yes counts only
    // within it)
    const end = performance.now() + 60_000;
    for (let left = end - performance.now(); left > 0; left = end - performance.now()) {
      const r = await call("Runtime.evaluate", { expression: `document.readyState === "complete" && location.pathname.endsWith(${JSON.stringify(path)})`, returnByValue: true }, Math.min(5000, left)).catch(() => null);
      if (r?.result?.value === true && performance.now() <= end) return;
      await sleep(Math.min(100, Math.max(0, end - performance.now())));
    }
    throw new Error(label + "its page didn't finish loading " + path + " within 60 s");
  };
  /** Another DevTools connection (another tab): its calls bounded and named, like the main tab's. */
  const tab = (sock, label) => {
    let k = 0; const w = new Map();
    sock.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && w.has(m.id)) { w.get(m.id)(m.result ?? m.error); w.delete(m.id); } });
    return (method, params = {}, ms = CALL_MS) => { const id = ++k, what = label + describe(method, params); waitingOn = what; return bounded(new Promise((r) => { w.set(id, r); sock.send(JSON.stringify({ id, method, params })); }), what, ms).finally(() => w.delete(id)); };
  };
  let n = 0; const waiting = new Map(); const errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
    // (Delete's confirm: yes)
    if (m.method === "Page.javascriptDialogOpening") send("Page.handleJavaScriptDialog", { accept: true, ...(m.params.type === "prompt" ? { promptText: m.params.defaultPrompt ?? "" } : {}) }).catch(() => {});
  };
  const send = (method, params = {}, ms = CALL_MS) => { const id = ++n, what = describe(method, params); waitingOn = what; return bounded(new Promise((r) => { waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); }), what, ms).finally(() => waiting.delete(id)); };
  const ev = async (expression, ms) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, ms); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 1500)); return r.result?.value; };
  const until = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr, Math.max(1000, Math.min(CALL_MS, ms - (Date.now() - t)))).catch(() => false)) return true; await sleep(100); } return false; };
  const go = async (url) => { await send("Page.navigate", { url }); await sleep(300); };
  const W = "window.sagebrush?.workspace";
  const B = "window.sagebrush?.board";

  for (const m of ["Page.enable", "Runtime.enable", "DOM.enable"]) await send(m);
  // (control: a page promise that never settles fails its call within its deadline, named, instead of hanging the run)
  const t0 = Date.now(), hung = await send("Runtime.evaluate", { expression: NEVER, awaitPromise: true, returnByValue: true }, 2000).then(answered, (e) => String(e?.message));
  check(hung === "no answer within 2000 ms: Runtime.evaluate: " + NEVER && Date.now() - t0 < 10_000, "(a page promise that never settles fails its call within its deadline, naming it): " + hung);
  // (control: the same bound on a wait that isn't a DevTools call, as the startup waits are)
  const hungWait = await bounded(new Promise(() => {}), "a wait that never ends", 200).then(() => "ended", (e) => String(e?.message));
  check(hungWait === "no answer within 200 ms: a wait that never ends", "(a wait that never ends fails within its deadline, naming it): " + hungWait);
  // ---------------------------------------------------------------- the board page
  await go(base + "board/");
  await until(`${B}?.snapshot()`, 60000);
  const id = "abcdefabcdef", key = "sagebrush-board:local:" + id;
  const old = JSON.stringify({ title: "Old board", nodes: [{ id: "n", title: "a note" }] });
  await ev(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(old)}); localStorage.setItem("sagebrush-boards", JSON.stringify([{ id: ${JSON.stringify(id)}, title: "Old board", mode: "python", at: 1000 }])); true`);
  await go(base + "board/?doc=local:" + id);
  check(await until(`${B}?.snapshot()?.doc?.title === "Old board"`, 60000), "a board kept in localStorage opens");
  check(await until(`${W}?.list("/").then((l) => l.some((e) => e.path === "/Old board.board.json" && e.ref === ${JSON.stringify(id)}))`), "…and is in the workspace, under its id");
  check(await ev(`typeof ${W}.dropVersions === "undefined" && typeof ${W}.forget === "undefined" && typeof ${W}.rename === "function"`), "window.sagebrush.workspace is the agent's view: no dropVersions, no forget");
  await ev(`${B}.edit((d) => { d.title = "Changed"; }).then(() => 1)`);
  check(await until(`${W}.read("/Old board.board.json").then((r) => r.content.title === "Changed")`), "an edit is written to the workspace");
  check(await until(`localStorage.getItem("sagebrush-workspace-pending:${id}") === null`), "…the pending copy dropped once written");
  check(await ev(`localStorage.getItem(${JSON.stringify(key)}) === ${JSON.stringify(old)}`), "…the old localStorage copy left as it was");
  await go(base + "board/?doc=local:" + id);
  check(await until(`${B}?.snapshot()?.doc?.title === "Changed"`, 60000), "a reload shows the workspace's copy");
  check(await ev(`${W}.list("/").then((l) => l.filter((e) => e.kind === "board").length)`) === 1, "…and brings nothing in twice");
  // a page closed mid-write: its pending copy is taken at the next load
  const revNow = await ev(`${W}.read("/Old board.board.json").then((r) => r.rev)`);
  await ev(`localStorage.setItem("sagebrush-workspace-pending:${id}", "abababababababab:1:" + ${revNow} + "\\n" + JSON.stringify({ title: "Pending", nodes: [] })); true`);
  await go(base + "board/?doc=local:" + id);
  check(await until(`${B}?.snapshot()?.doc?.title === "Pending"`, 60000), "a pending copy left by a closed page is shown");
  check(await until(`${W}.read("/Old board.board.json").then((r) => r.content.title === "Pending")`), "…and written to the workspace");
  check(await until(`localStorage.getItem("sagebrush-workspace-pending:${id}") === null`), "…then dropped");
  // ?new=: a board of the workspace
  await go(base + "board/?new=python");
  check(await until(`/[?&]doc=local:[0-9a-f]{12}/.test(location.search) && !!${B}?.snapshot()`, 60000), "?new= opens a new board");
  const newId = await ev(`location.search.match(/local:([0-9a-f]{12})/)[1]`);
  check(await until(`${W}?.list("/").then((l) => l.some((e) => e.path === "/Untitled board.board.json" && e.ref === ${JSON.stringify(newId)}))`), "…listed as /Untitled board.board.json");
  check(await ev(`localStorage.getItem("sagebrush-board:local:${newId}") === null`), "…and not written to localStorage");
  // ?recent=MODE, New board and Duplicate, in the workspace (what web/board/test-local.mjs checks for the fallback)
  await go(base + "board/?new=sage");
  await until(`/[?&]doc=local:[0-9a-f]{12}/.test(location.search) && !!${B}?.snapshot()`, 60000);
  const sageId = await ev(`location.search.match(/local:([0-9a-f]{12})/)[1]`);
  check(await until(`${W}.list("/").then((l) => l.some((e) => e.ref === ${JSON.stringify(sageId)} && e.mode === "sage"))`), "?new=sage: a Sage board of the workspace");
  await go(base + "board/?recent=sage");
  check(await until(`location.search.includes(${JSON.stringify("local:" + sageId)}) && !!${B}?.snapshot()`, 60000), "?recent=sage opens the latest Sage board of the workspace");
  const countBoards = () => ev(`${W}.list("/", { recursive: true }).then((l) => l.filter((e) => e.kind === "board").length)`);
  const before = await countBoards();
  await ev(`(() => { document.querySelector('[data-sbb="newboard"]').click(); return 1; })()`);
  check(await until(`!location.search.includes(${JSON.stringify("local:" + sageId)}) && /doc=local:[0-9a-f]{12}/.test(location.search) && !!${B}?.snapshot()`, 60000), "File > New board opens a new board");
  check((await countBoards()) === before + 1 && (await ev(`localStorage.getItem("sagebrush-board:local:" + location.search.match(/local:([0-9a-f]{12})/)[1]) === null`)), "…a board of the workspace, not of localStorage");
  check(await ev(`localStorage.getItem("sagebrush-board:local:" + location.search.match(/local:([0-9a-f]{12})/)[1] + "#here") === "1"`), "…marked as written here (its remote pictures show at once)");
  // provenance (design/capabilities.md §6): the person's own New is theirs; a board brought in from before is unknown
  const madeOfRef = (ref) => ev(`${W}.list("/", { recursive: true }).then((l) => l.find((e) => e.ref === ${ref})?.made ?? "unknown")`);
  check((await madeOfRef(`location.search.match(/local:([0-9a-f]{12})/)[1]`)) === "person", "File > New board: made by the person (provenance)");
  check((await madeOfRef(JSON.stringify(id))) === "unknown", "…a board brought in from before the workspace: unknown");
  await ev(`${B}.edit((d) => { d.title = "To copy"; }).then(() => 1)`);
  await sleep(300);
  // (Duplicate saves, then opens the copy: what follows waits for the copy's page,
  // never acting on the page that is going, or on the copy's before its workspace is
  // there, where ${W}'s optional chain would quietly give undefined)
  const toCopy = await ev(`location.search`);
  await ev(`(() => { document.querySelector('[data-sbb="duplicate"]').click(); return 1; })()`);
  check(await until(`location.search !== ${JSON.stringify(toCopy)} && !!window.sagebrush?.workspace && !!${B}?.snapshot()`, 60000), "Duplicate opens the copy");
  check(await until(`${W}.list("/").then((l) => l.some((e) => e.path === "/To copy (copy).board.json"))`, 30000), "Duplicate makes a board of the workspace: To copy (copy)");
  const markOf = (path) => ev(`${W}.stat(${JSON.stringify(path)}).then((e) => localStorage.getItem("sagebrush-board:local:" + e.ref + "#here"))`);
  check((await markOf("/To copy (copy).board.json")) === "1", "…a copy of a board written here, marked as one");
  check((await ev(`${W}.stat("/To copy (copy).board.json").then((e) => e.made)`)) === "person", "…its provenance the source's: the person's");
  // a copy is never trusted more than what it copies (CORR-30D-1): a board
  // an agent wrote, with a remote picture, isn't marked; a closed page's
  // changes to it, recovered as a board of their own, aren't either, and
  // their picture waits for a click; of a board written here, they are
  const remotePics = () => ev(`[...document.querySelectorAll("img")].filter((i) => (i.getAttribute("src") ?? "").includes("example.invalid")).length`);
  for (const [name, trusted] of [["Foreign source", false], ["Own source", true]]) {
    const ref = await ev(`(async () => {
      const original = { title: ${JSON.stringify(name)}, nodes: [{ id: "remote", text: "![remote](https://example.invalid/probe.png)" }] };
      const e = await ${W}.create(${JSON.stringify("/" + name + ".board.json")}, { content: original });
      if (${trusted}) localStorage.setItem("sagebrush-board:local:" + e.ref + "#here", "1");
      const r = await ${W}.read(e.path);
      await ${W}.write(e.path, { ...original, title: "Changed elsewhere" }, { base: r.rev });
      localStorage.setItem("sagebrush-workspace-pending:" + e.ref, "0123456789abcdef:1:1" + String.fromCharCode(10) + JSON.stringify(original));
      return e.ref;
    })()`);
    await go(base + "board/?doc=local:" + ref);
    const copy = "/" + name + " (unsaved changes from a closed page).board.json";
    check(await until(`${W}?.stat(${JSON.stringify(copy)}).then((e) => !!e)`, 60000), `${name}: a closed page's changes, recovered as a board of their own`);
    check((await markOf(copy)) === (trusted ? "1" : null), `…${trusted ? "marked, as the board written here is" : "not marked as written here: the agent's board isn't"}`);
    await go(base + "board/?doc=local:" + (await ev(`${W}.stat(${JSON.stringify(copy)}).then((e) => e.ref)`)));
    await until(`!!${B}?.snapshot()`, 60000);
    await sleep(1500);
    check((await remotePics()) === (trusted ? 1 : 0), `…opened, its remote picture ${trusted ? "shown at once" : "waits for a click"}`);
    if (!trusted) {
      // Duplicate of a board not written here: not marked either
      const from = await ev(`location.search`);
      await ev(`(() => { document.querySelector('[data-sbb="duplicate"]').click(); return 1; })()`);
      check(await until(`location.search !== ${JSON.stringify(from)} && !!window.sagebrush?.workspace && !!${B}?.snapshot()`, 60000), "…Duplicate opens the copy");
      const dup = "/" + name + " (unsaved changes from a closed page) (copy).board.json";
      check(await until(`${W}.list("/").then((l) => l.some((e) => e.path === ${JSON.stringify(dup)}))`, 30000) && (await markOf(dup)) === null, "…and its Duplicate isn't marked");
    }
  }
  // an agent's change through window.sagebrush.workspace is credited to it
  await ev(`${W}.mkdir("/From the agent").then(() => 1)`);
  check(await ev(`${W}.ops().then((o) => o.at(-1).op === "mkdir" && o.at(-1).by === "agent:page")`), "an agent's change is credited to agent:page");


  // two savers: a commit never drops a newer save's pending copy (CORR-12C-1)
  const hold = (tag) => ev(`(() => { navigator.locks.request("sagebrush-workspace", () => new Promise((r) => (window.__release${tag} = r))); return 1; })()`);
  const release = (tag) => ev(`(() => { window.__release${tag}?.(); return 1; })()`);
  await go(base + "board/?doc=local:" + id);
  await until(`${B}?.snapshot()?.doc?.title === "Pending"`, 60000);
  await hold("A");
  await ev(`${B}.edit((d) => { d.title = "Mine"; }).then(() => 1)`);
  check(await until(`(localStorage.getItem("sagebrush-workspace-pending:${id}") ?? "").includes('"Mine"')`), "(this page's save is pending)");
  const other = "ffffffffffffffff:1:0\n" + JSON.stringify({ title: "Other tab's", nodes: [] });
  await ev(`localStorage.setItem("sagebrush-workspace-pending:${id}", ${JSON.stringify(other)}); 1`);
  await release("A");
  check(await until(`${W}.read("/Old board.board.json").then((r) => r.content.title === "Mine")`), "(this page's save is written)");
  await sleep(300);
  check(await ev(`localStorage.getItem("sagebrush-workspace-pending:${id}") === ${JSON.stringify(other)}`), "another tab's newer pending copy isn't dropped by this page's commit");
  await ev(`localStorage.removeItem("sagebrush-workspace-pending:${id}"); 1`);
  // a pending copy the record has moved past (another writer since): kept as a board of its own, the record shown (CORR-12C-2)
  const rev0 = await ev(`${W}.read("/Old board.board.json").then((r) => r.rev)`);
  const stale = `eeeeeeeeeeeeeeee:3:${rev0}\n` + JSON.stringify({ title: "Left by a closed page", nodes: [] });
  await ev(`localStorage.setItem("sagebrush-workspace-pending:${id}", ${JSON.stringify(stale)}); 1`);
  await ev(`${W}.read("/Old board.board.json").then((r) => ${W}.write("/Old board.board.json", { title: "The agent's", nodes: [] }, { base: r.rev })).then(() => 1)`);
  await go(base + "board/?doc=local:" + id);
  check(await until(`${B}?.snapshot()?.doc?.title === "The agent's"`, 60000), "the record another writer moved on is shown, not the stale pending copy");
  check(await until(`${W}.list("/").then((l) => l.some((e) => e.path === "/Left by a closed page (unsaved changes from a closed page).board.json"))`), "…the pending copy kept as a board of its own");
  check(await until(`localStorage.getItem("sagebrush-workspace-pending:${id}") === null`), "…and then dropped");

  // recovery removes only the pending copy it read (CORR-2D1-1): a newer save written while it worked stays
  const S = "9999999999999999";
  const revA = await ev(`${W}.read("/Old board.board.json").then((r) => r.rev)`);
  const staleS1 = `${S}:1:${revA - 1}\n` + JSON.stringify({ title: "Stale S1", nodes: [] });
  const liveS2 = `${S}:2:${revA}\n` + JSON.stringify({ title: "Live S2", nodes: [] });
  await ev(`localStorage.setItem("sagebrush-workspace-pending:${id}", ${JSON.stringify(staleS1)}); 1`);
  await hold("R");
  await ev(`(() => { window.__loadP = import("/board/board.js").then((m) => m.host.store.load()); return 1; })()`);
  await sleep(500);
  await ev(`localStorage.setItem("sagebrush-workspace-pending:${id}", ${JSON.stringify(liveS2)}); 1`);
  await release("R");
  await ev(`window.__loadP.then(() => 1)`);
  check(await ev(`localStorage.getItem("sagebrush-workspace-pending:${id}") === ${JSON.stringify(liveS2)}`), "a recovery drops only the pending copy it read, not a newer one written meanwhile");
  await ev(`localStorage.removeItem("sagebrush-workspace-pending:${id}"); 1`);
  // a session's later committed save beats its own earlier pending copy (CORR-2D1-2)
  await ev(`new Promise((ok) => { const r = indexedDB.open("sagebrush-workspace"); r.onsuccess = () => { const tx = r.result.transaction("boards", "readwrite"), st = tx.objectStore("boards"); const g = st.get(${JSON.stringify(id)}); g.onsuccess = () => { const rec = g.result; st.put({ ...rec, doc: { title: "B committed", nodes: [] }, rev: rec.rev + 1, tag: "${S}:2:0" }); }; tx.oncomplete = () => { r.result.close(); ok(1); }; }; })`);
  const revB = await ev(`${W}.read("/Old board.board.json").then((r) => r.rev)`);
  const staleA = `${S}:1:${revB - 2}\n` + JSON.stringify({ title: "A pending", nodes: [] });
  await ev(`localStorage.setItem("sagebrush-workspace-pending:${id}", ${JSON.stringify(staleA)}); 1`);
  await go(base + "board/?doc=local:" + id);
  check(await until(`${B}?.snapshot()?.doc?.title === "B committed"`, 60000), "a session's later committed save is shown over its own earlier pending copy");
  check(await until(`localStorage.getItem("sagebrush-workspace-pending:${id}") === null`), "…and the earlier pending copy is dropped");
  check(await ev(`${W}.list("/").then((l) => !l.some((e) => e.path.startsWith("/A pending")))`), "…with no conflict copy made of it");
  // an agent can't claim a page session's tag
  await ev(`${W}.read("/Old board.board.json").then((r) => ${W}.write("/Old board.board.json", r.content, { base: r.rev, tag: "${S}:99:0" })).then(() => 1)`);
  check(await ev(`new Promise((ok) => { const r = indexedDB.open("sagebrush-workspace"); r.onsuccess = () => { const g = r.result.transaction("boards").objectStore("boards").get(${JSON.stringify(id)}); g.onsuccess = () => { const t = g.result.tag; r.result.close(); ok(t === undefined); }; }; })`), "an agent's write carries no session tag, whatever it asks");

  // a recovery's write meets a change made since load read the board: both kept (CORR-AA2-1)
  const R = await ev(`${W}.read("/Old board.board.json").then((r) => r.rev)`);
  const pendA = `8888888888888888:1:${R}\n` + JSON.stringify({ title: "A recovered", nodes: [] });
  await ev(`localStorage.setItem("sagebrush-workspace-pending:${id}", ${JSON.stringify(pendA)}); 1`);
  await hold("C");
  await ev(`(() => { window.__agentP = ${W}.write("/Old board.board.json", { title: "B by agent", nodes: [] }, { base: ${R} }); return 1; })()`);
  await ev(`(() => { window.__loadP2 = import("/board/board.js").then((m) => m.host.store.load()); return 1; })()`);
  await sleep(500);
  await release("C");
  await ev(`Promise.all([window.__agentP, window.__loadP2]).then(() => 1)`);
  check(await until(`${W}.read("/Old board.board.json").then((r) => r.content.title === "B by agent")`), "the change made in between isn't written over");
  check(await until(`${W}.list("/").then((l) => l.some((e) => e.path === "/A recovered (your changes, made while it changed elsewhere).board.json"))`), "…the recovered version is kept as a board of its own");
  check(await until(`localStorage.getItem("sagebrush-workspace-pending:${id}") === null`), "…and only then its pending copy dropped");
  check(await until(`${B}?.snapshot()?.doc?.title === "B by agent" && /changed elsewhere while you edited/.test(document.body.innerText)`), "…the board shows the other version, and says so");

  // a save typed on the old view while a conflict is handled goes to the conflict's copy, never over the other version (CORR-0FC-1)
  await go(base + "board/?doc=local:" + id);
  await until(`${B}?.snapshot()?.doc?.title === "B by agent"`, 60000);
  const R2 = await ev(`${W}.read("/Old board.board.json").then((r) => r.rev)`);
  const pendA2 = `7777777777777777:1:${R2}\n` + JSON.stringify({ title: "A2 recovered", nodes: [] });
  await ev(`localStorage.setItem("sagebrush-workspace-pending:${id}", ${JSON.stringify(pendA2)}); 1`);
  // (the order on the workspace's lock: the agent's write B, the recovery's write A (which conflicts), then a hold
  // that lets the edit C be typed while the conflict waits on the lock to make its copy: astra's sequence exactly)
  await hold("D");
  await ev(`(() => { window.__agentP2 = ${W}.write("/Old board.board.json", { title: "B2 by agent", nodes: [] }, { base: ${R2} }); return 1; })()`);
  await ev(`(() => { window.__loadP3 = import("/board/board.js").then((m) => m.host.store.load()); return 1; })()`);
  await sleep(400);
  await ev(`(() => { navigator.locks.request("sagebrush-workspace", () => new Promise((r) => { window.__heldE = true; window.__releaseE = r; })); return 1; })()`);
  await release("D");
  check(await until(`window.__heldE === true`), "(the conflict waits on the lock to make its copy)");
  await ev(`${B}.edit((d) => { d.title = "C typed"; }).then(() => 1)`);
  await sleep(200);
  await release("E");
  await ev(`Promise.all([window.__agentP2, window.__loadP3]).then(() => 1)`);
  await sleep(1500); // (every queued save has had its turn)
  check(await ev(`${W}.read("/Old board.board.json").then((r) => r.content.title === "B2 by agent")`), "a save typed on the old view during a conflict doesn't write over the other version");
  const copyOk = await until(`${W}.read("/A2 recovered (your changes, made while it changed elsewhere).board.json").then((r) => r.content.title === "C typed").catch(() => false)`);
  const boardsNow = copyOk ? "" : await ev(`${W}.list("/").then((l) => Promise.all(l.filter((e) => e.kind === "board").map((e) => ${W}.read(e.path).then((r) => e.path + " => " + r.content.title)))).then((x) => JSON.stringify(x))`);
  check(copyOk, "…it goes into the conflict's copy " + boardsNow + " shown: " + (await ev(`${B}?.snapshot()?.doc?.title`)));
  // the conflict's copy is a board like any other: an agent's write to it is never written over (CORR-105-1)
  await go(base + "board/?doc=local:" + id);
  await until(`!!${B}?.snapshot()`, 60000);
  const R3 = await ev(`${W}.read("/Old board.board.json").then((r) => r.rev)`);
  const pendA3 = `6666666666666666:1:${R3}\n` + JSON.stringify({ title: "A3 recovered", nodes: [] });
  await ev(`localStorage.setItem("sagebrush-workspace-pending:${id}", ${JSON.stringify(pendA3)}); 1`);
  const copy3 = "/A3 recovered (your changes, made while it changed elsewhere).board.json";
  await hold("F");
  await ev(`(() => { window.__agentP3 = ${W}.write("/Old board.board.json", { title: "B3 by agent", nodes: [] }, { base: ${R3} }); return 1; })()`);
  await ev(`(() => { window.__loadP4 = import("/board/board.js").then((m) => m.host.store.load()); return 1; })()`);
  await sleep(400);
  await ev(`(() => { navigator.locks.request("sagebrush-workspace", () => new Promise((r) => { window.__heldG = true; window.__releaseG = r; })); return 1; })()`);
  await release("F");
  await until(`window.__heldG === true`);
  await ev(`${B}.edit((d) => { d.title = "C3 typed"; }).then(() => 1)`);
  await sleep(300);
  await ev(`(() => { window.__agentZ = ${W}.write(${JSON.stringify(copy3)}, { title: "Z on the copy", nodes: [] }, { base: 1 }).then(() => "ok", (e) => String(e)); return 1; })()`);
  await release("G");
  await ev(`Promise.all([window.__agentP3, window.__loadP4]).then(() => 1)`);
  await sleep(1500);
  check((await ev(`window.__agentZ`)) === "ok" && (await ev(`${W}.read(${JSON.stringify(copy3)}).then((r) => r.content.title)`)) === "Z on the copy", "an agent's write to the conflict's copy stays: " + (await ev(`window.__agentZ`)));
  check(await ev(`${W}.list("/").then((l) => Promise.all(l.filter((e) => e.kind === "board").map((e) => ${W}.read(e.path).then((r) => r.content.title)))).then((t) => t.includes("C3 typed (your changes, made while it changed elsewhere)"))`), "…and the page's later save goes to a new copy");
  // random interleavings of the page's saves and an agent's writes (30 fixed seeds and one random, CORR-105-2): nothing either
  // wrote last is lost, unless the other wrote after it, which CAS lets only a writer that read it do
  const rngOf = (seed) => { let r = seed; return () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648); };
  const seeds = process.env.WS_SEED ? [Number(process.env.WS_SEED)] : [...Array(30).keys()].map((k) => k + 1).concat([1000 + Math.floor(Math.random() * 100000)]);
  const lost = [];
  await go(base + "board/?doc=local:" + id);
  await until(`!!${B}?.snapshot()`, 60000);
  for (const seed of seeds) {
    const rand = rngOf(seed);
    let lastPage = null, lastAgent = null, lastAgentK = -1, lastPageK = -1;
    for (let k = 0; k < 12; k++) {
      const r = rand();
      if (r < 0.4) {
        lastPage = `s${seed} page ${k}`;
        lastPageK = k;
        await ev(`${B}.edit((d) => { d.title = ${JSON.stringify(lastPage)}; }).then(() => 1)`);
      } else if (r < 0.8) {
        const t = `s${seed} agent ${k}`;
        const ok = await ev(`${W}.read("/Old board.board.json").then((x) => ${W}.write("/Old board.board.json", { title: ${JSON.stringify(t)}, nodes: [] }, { base: x.rev })).then(() => true, () => false)`);
        if (ok) { lastAgent = t; lastAgentK = k; }
      } else {
        await hold("Z");
        await sleep(Math.floor(rand() * 200));
        await release("Z");
      }
      await sleep(Math.floor(rand() * 120));
    }
    await sleep(1200);
    const titles = await ev(`${W}.list("/").then((l) => Promise.all(l.filter((e) => e.kind === "board").map((e) => ${W}.read(e.path).then((r) => r.content.title))))`);
    const kept = (t) => titles.some((x) => x === t || x === t + " (your changes, made while it changed elsewhere)");
    // (a writer's last write may be gone only if the other wrote after it, with CAS: it read that write, or it couldn't have written)
    if (lastPage && !kept(lastPage) && !(lastAgentK > lastPageK)) lost.push(`seed ${seed}: the page's last save "${lastPage}" is in no board; log ${JSON.stringify((await ev(`window.sagebrush.saveLog?.()`)).slice(-30))}`);
    if (lastAgent && !kept(lastAgent) && !(lastPageK > lastAgentK)) lost.push(`seed ${seed}: the agent's last write "${lastAgent}" is gone`);
  }
  check(lost.length === 0, `random interleavings, seeds ${seeds.join(",")}: nothing lost` + (lost.length ? "\n    " + lost.join("\n    ") : ""));
  // a board only a pending copy holds: brought in (CORR-12C-3)
  const lone = "fedcba987654", loneText = "dddddddddddddddd:1:0\n" + JSON.stringify({ title: "Only pending", nodes: [] });
  await ev(`localStorage.setItem("sagebrush-workspace-pending:${lone}", ${JSON.stringify(loneText)}); 1`);
  await go(base + "board/?doc=local:" + lone);
  check(await until(`${B}?.snapshot()?.doc?.title === "Only pending"`, 60000), "a board only a pending copy holds is shown");
  check(await until(`${W}.list("/").then((l) => l.some((e) => e.ref === ${JSON.stringify(lone)} && e.path === "/Only pending.board.json"))`), "…and brought into the workspace under its id");
  // a pending copy that can't be read: set aside, said, never parsed again (LIMIT-12C-4)
  await ev(`localStorage.setItem("sagebrush-workspace-pending:${lone}", "not a pending copy"); 1`);
  await go(base + "board/?doc=local:" + lone);
  check(await until(`${B}?.snapshot()?.doc?.title === "Only pending" && /couldn't be read/.test(document.body.innerText)`, 60000), "an unreadable pending copy is said, the board as kept shown");
  check(await ev(`localStorage.getItem("sagebrush-workspace-pending-unread:${lone}") === "not a pending copy" && localStorage.getItem("sagebrush-workspace-pending:${lone}") === null`), "…set aside, not dropped");
  // a workspace that opens after the page gave up on it: closed, the page keeps boards as before (LIMIT-12C-3)
  const legacy = "cccccccccccc";
  await ev(`localStorage.setItem("sagebrush-board:local:${legacy}", JSON.stringify({ title: "Legacy", nodes: [] })); 1`);
  // (the second tab: a board page with no workspace, the benchmark's, holding the workspace's lock)
  const t2 = await bounded(fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(base + "board/?items=10&strokes=0")}`, { method: "PUT" }).then((r) => r.json()), (waitingOn = "a second tab (/json/new)"));
  const ws2 = new WebSocket(t2.webSocketDebuggerUrl);
  sockets.push(ws2);
  await bounded(new Promise((r) => (ws2.onopen = r)), (waitingOn = "the second tab's DevTools socket to open"), 10_000);
  const call2 = tab(ws2, "the lock tab: ");
  const ev2 = (expression, ms) => call2("Runtime.evaluate", { expression, returnByValue: true }, ms);
  // (control: the lock tab's calls are bounded too; made once its page has loaded, so no navigation ends the wait)
  await loaded(call2, "the lock tab: ", "/board/");
  const hung2 = await call2("Runtime.evaluate", { expression: NEVER, awaitPromise: true }, 2000).then(answered, (e) => String(e?.message));
  check(hung2 === "no answer within 2000 ms: the lock tab: Runtime.evaluate: " + NEVER, "(the lock tab: a call that gets no answer fails within its deadline, naming it): " + hung2);
  await sleep(1500);
  await ev2(`navigator.locks.request("sagebrush-workspace", () => new Promise((r) => (window.__held = r))); 1`);
  await go(base + "board/?doc=local:" + legacy);
  check(await until(`${B}?.snapshot()?.doc?.title === "Legacy"`, 60000), "with the workspace held up, the board opens as before");
  check(await ev(`!${W}`), "…without a workspace for this visit");
  await ev(`${B}.edit((d) => { d.title = "Legacy edited"; }).then(() => 1)`);
  check(await until(`JSON.parse(localStorage.getItem("sagebrush-board:local:${legacy}")).title === "Legacy edited"`), "…kept in localStorage, as before");
  await ev2(`window.__held(); 1`);
  ws2.close();
  await sleep(1500);
  const migratedLate = await ev(`new Promise((ok) => { const r = indexedDB.open("sagebrush-workspace"); r.onsuccess = () => { const q = r.result.transaction("entries").objectStore("entries").getAll(); q.onsuccess = () => { const hit = q.result.some((e) => e.ref === "${legacy}"); r.result.close(); ok(hit); }; }; })`);
  check(migratedLate === false, "…and the workspace that opened late, once the page gave up on it, brought nothing in");

  // ---------------------------------------------------------------- the notebook page
  await go(base);
  check(await until(`!!window.sagebrush?.notebook && !!${W}`, 60000), "the notebook page opens its workspace");
  const nbId = await ev(`localStorage.getItem("sagebrush-current")`);
  check(await until(`${W}.list("/").then((l) => l.some((e) => e.kind === "notebook" && e.ref === ${JSON.stringify(nbId)}))`), "the open notebook is listed");
  // provenance: the Welcome notebook isn't the person's; File > New is; Save a copy keeps it
  check((await ev(`${W}.list("/").then((l) => l.find((e) => e.ref === ${JSON.stringify(nbId)})?.made ?? "unknown")`)) !== "person", "the Welcome notebook a first visit makes: not made by the person");
  await ev(`(() => { document.querySelector('[data-f="new"]').click(); return 1; })()`);
  check(await until(`localStorage.getItem("sagebrush-current") !== ${JSON.stringify(nbId)}`, 15000), "(File > New notebook)");
  const newNb = await ev(`localStorage.getItem("sagebrush-current")`);
  check(await until(`${W}.list("/").then((l) => l.find((e) => e.ref === ${JSON.stringify(newNb)})?.made === "person")`), "File > New notebook: made by the person");
  await ev(`(() => { document.querySelector('[data-f="duplicate"]').click(); return 1; })()`);
  check(await until(`localStorage.getItem("sagebrush-current") !== ${JSON.stringify(newNb)}`, 15000), "(Save a copy)");
  const copyNb = await ev(`localStorage.getItem("sagebrush-current")`);
  check(await until(`${W}.list("/").then((l) => l.find((e) => e.ref === ${JSON.stringify(copyNb)})?.made === "person")`), "…Save a copy: the source's provenance");
  await ev(`(async () => { await sagebrush.notebook.saved?.(); return 1; })()`).catch(() => {});
  await go(base + "?nb=" + encodeURIComponent(nbId));
  check(await until(`!!window.sagebrush?.notebook && !!${W} && localStorage.getItem("sagebrush-current") === ${JSON.stringify(nbId)}`, 60000), "(back on the notebook the rest of this test uses)");
  await ev(`(() => { const i = document.querySelector("#nbname"); i.value = "Renamed nb"; i.dispatchEvent(new Event("input")); return 1; })()`);
  check(await until(`${W}.list("/").then((l) => l.some((e) => e.path === "/Renamed nb.ipynb" && e.ref === ${JSON.stringify(nbId)}))`, 8000), "renaming the notebook renames its file");
  // uploads through the workspace: an overwrite keeps a version
  const up = async (content) => {
    const f = join(files, "data.txt");
    writeFileSync(f, content);
    const doc = await send("DOM.getDocument", {});
    const q = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#uploadinput" });
    await send("DOM.setFileInputFiles", { nodeId: q.nodeId, files: [f] });
  };
  await up("first");
  check(await until(`${W}.read("/data.txt").then((r) => new TextDecoder().decode(r.content) === "first")`), "an upload goes into the workspace");
  await up("second");
  check(await until(`${W}.read("/data.txt").then((r) => new TextDecoder().decode(r.content) === "second")`), "…an upload over it writes it");
  check(await until(`${W}.history("/data.txt").then((h) => h.length === 1)`), "…keeping the old bytes as a version");
  check(await ev(`${W}.version("/data.txt", 0).then((b) => new TextDecoder().decode(b))`) === "first", "…which are the first upload's");
  // Python's writes go through the workspace: a second write keeps the first as a version
  // (the first code cell: the Welcome notebook starts with Markdown)
  const runPy = (code) => ev(`(async () => { const nb = sagebrush.notebook, c = nb.cells().find((x) => x.type === "code"); c.ta.value = ${JSON.stringify(code)}; c.ta.dispatchEvent(new Event("input", { bubbles: true })); await nb.run(c); return true; })()`);
  await runPy('with open("/py.txt", "w") as f:\n    f.write("one")\nprint("wrote one")');
  const pyOk = await until(`${W}.read("/py.txt").then((r) => new TextDecoder().decode(r.content) === "one")`, 60000);
  const diag = pyOk ? "" : await ev(`(async () => { const keys = await new Promise((ok) => { const r = indexedDB.open("sagebrush"); r.onsuccess = () => { const q = r.result.transaction("files").objectStore("files").getAllKeys(); q.onsuccess = () => ok(q.result); }; }); const c = sagebrush.notebook.cells().find((x) => x.type === "code"); return JSON.stringify({ keys, stat: await ${W}.stat("/py.txt").catch((e) => String(e)), input: c?.ta?.value, out: c?.el?.innerText?.slice(0, 300) ?? Object.keys(c ?? {}).join(",") }); })()`).catch((e) => String(e));
  check(pyOk, "a file Python writes is in the workspace " + diag);
  await runPy('with open("/py.txt", "w") as f:\n    f.write("two")\nprint("wrote two")');
  check(await until(`${W}.read("/py.txt").then((r) => new TextDecoder().decode(r.content) === "two")`, 30000), "…written again by Python");
  check(await until(`${W}.history("/py.txt").then((h) => h.length === 1)`) && (await ev(`${W}.version("/py.txt", 0).then((b) => new TextDecoder().decode(b))`)) === "one", "…keeping Python's first write as a version: " + (await ev(`${W}.history("/py.txt").then((h) => h.length)`)));

  // an upload over the limit is refused by its size, never read, never given to Python (LIMIT-12C-1)
  await ev(`window.sagebrush.files.add([{ name: "huge.bin", size: 300 * 2 ** 20, arrayBuffer() { window.__readHuge = true; return Promise.resolve(new ArrayBuffer(0)); } }]).then(() => 1)`);
  check(await ev(`window.__readHuge === undefined`), "an upload over the limit isn't read");
  check(await ev(`${W}.stat("/huge.bin").then((e) => e === undefined)`) && /Not added: huge\.bin/.test(await ev(`document.querySelector("#status").textContent`)), "…isn't kept, and says so");
  // Python's write storm: the queue keeps each path's latest only (LIMIT-12C-2)
  await hold("Q");
  await runPy('for i in range(30):\n    with open("/storm.txt", "w") as f:\n        f.write("x" * 1000 + str(i))\nprint("stormed")');
  const q = await ev(`window.sagebrush.files.queue()`);
  check(q.paths <= 1 && q.bytes <= 1100, "a storm of writes to one file waits as one: " + JSON.stringify(q));
  await ev(`window.sagebrush.files.setQueueMax(1500); 1`);
  await runPy('with open("/other.txt", "w") as f:\n    f.write("y" * 1000)\nprint("other")');
  check((await ev(`window.sagebrush.files.queue()`)).refused > 0 && /too much is waiting/.test(await ev(`document.querySelector("#status").textContent`)), "past the queue's bound, a write isn't queued, and says so");
  await ev(`window.sagebrush.files.setQueueMax(256 * 2 ** 20); 1`);
  await release("Q");
  check(await until(`${W}.read("/storm.txt").then((r) => new TextDecoder().decode(r.content).endsWith("29"))`, 30000), "…and the file ends as Python left it");
  check(await until(`window.sagebrush.files.queue().paths === 0`), "…the queue empties");

  // the Files panel's ✕: to Trash
  await ev(`(() => { document.querySelector("#filesbtn").click(); return 1; })()`);
  check(await until(`!!document.querySelector('#filelist button[aria-label="Delete /data.txt"]')`), "the Files panel lists the file");
  await ev(`(() => { document.querySelector('#filelist button[aria-label="Delete /data.txt"]').click(); return 1; })()`);
  check(await until(`${W}.list("/Trash").then((l) => l.some((e) => e.path === "/Trash/data.txt"))`), "the Files panel's ✕ puts the file in Trash");
  check(await ev(`${W}.stat("/data.txt").then((e) => e === undefined)`), "…out of the folder");
  // after a reload, the interpreter is given the files kept beside the index (capabilities §2b: the
  // notebook page reads them through the workspace, wherever each is kept)
  await go(base);
  check(await until(`!!window.sagebrush?.notebook && !!${W} && /^ready/.test(document.querySelector("#status")?.textContent ?? "")`, 60000), "(the notebook page reloaded, its interpreter ready)");
  check(await ev(`${W}.stat("/py.txt").then((e) => e?.migrated === true)`), "(Python's file is kept beside the index)");
  await runPy('print("READ:" + open("/py.txt").read())');
  const readOk = await until(`sagebrush.notebook.cells().some((c) => c.type === "code" && /READ:two/.test(c.el?.innerText ?? ""))`, 30000);
  const readDiag = readOk ? "" : await ev(`(async () => JSON.stringify({ out: sagebrush.notebook.cells().filter((c) => c.type === "code").map((c) => (c.el?.innerText ?? "").slice(0, 300)), status: document.querySelector("#status")?.textContent, errs: ${JSON.stringify(errors.slice(-3))}, stat: await ${W}.stat("/py.txt") }))()`).catch((e) => String(e));
  check(readOk, "a new interpreter reads it: its bytes given from the workspace " + readDiag);

  // deleting the notebook drops it from the list
  await ev(`(() => { document.querySelector('[data-f="delete"]').click(); return 1; })()`);
  check(await until(`${W}.list("/").then((l) => !l.some((e) => e.ref === ${JSON.stringify(nbId)}))`), "a deleted notebook is dropped from the workspace");
  // a newer Sagebrush page upgrading the workspace's database: this page and a board page in another
  // tab both lose it, and both say so, with Reload (capabilities step 1; last: nothing opens it after)
  const tU = await bounded(fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(base + "board/")}`, { method: "PUT" }).then((r) => r.json()), (waitingOn = "the other tab (/json/new)"));
  const wsU = new WebSocket(tU.webSocketDebuggerUrl);
  sockets.push(wsU);
  await bounded(new Promise((r) => (wsU.onopen = r)), (waitingOn = "the other tab's DevTools socket to open"), 10_000);
  const callU = tab(wsU, "the other tab: ");
  const evU = async (expression, ms) => (await callU("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, ms))?.result?.value;
  // (control: the other tab's calls are bounded too; made once its page has loaded, so no navigation ends the wait)
  await loaded(callU, "the other tab: ", "/board/");
  const hungU = await callU("Runtime.evaluate", { expression: NEVER, awaitPromise: true }, 2000).then(answered, (e) => String(e?.message));
  check(hungU === "no answer within 2000 ms: the other tab: Runtime.evaluate: " + NEVER, "(the other tab: a call that gets no answer fails within its deadline, naming it): " + hungU);
  for (let i = 0; i < 600 && !(await evU(`!!window.sagebrush?.workspace`).catch(() => false)); i++) await sleep(100);
  check(await evU(`!!window.sagebrush?.workspace`), "(a board page open in another tab, with the workspace)");
  await ev(`new Promise((ok, no) => { const r = indexedDB.open("sagebrush-workspace", 99); r.onsuccess = () => { r.result.close(); ok(1); }; r.onerror = () => no(r.error); r.onblocked = () => no(new Error("blocked")); })`);
  const notice = `(() => { const b = document.getElementById("sagebrush-reload-notice"); return !!b && /updated in another tab/.test(b.textContent) && [...b.querySelectorAll("button")].some((x) => x.textContent === "Reload"); })()`;
  check(await until(notice, 10000), "the workspace upgraded by a newer page: the notebook page says so, with Reload");
  let boardSays = false;
  for (let i = 0; i < 100 && !(boardSays = await evU(notice).catch(() => false)); i++) await sleep(100);
  check(boardSays, "…and so does the board page in the other tab");
  check(/reload/.test(await ev(`${W}.read("/py.txt").then(() => "", (e) => String(e.message))`)), "…reading the files then says to reload");
  wsU.close();
  await send("Target.closeTarget", { targetId: tU.id });

  // ---------------------------------------------------------------- the controls' children (started at the beginning)
  waitingOn = "the control children to end";
  await bounded(Promise.all(kids.map((k) => k.done)), waitingOn, 90_000).catch(() => {});
  const sk = kids.find((k) => k.mode === "startup");
  // (the forced-watchdog controls: each child hung on purpose; its watchdog must have ended it, naming the wait, with its
  // Chrome seen to exit and gone, Chrome's tree gone, its directories removed (and still gone now) and exit code 1;
  // hang-late's own helper wrote into the profile only after Chrome's exit)
  for (const [mode, label] of [["hang", "the forced-watchdog control: a hung run is ended by its watchdog"], ["hang-late", "the forced-watchdog control with a helper that writes into the profile after Chrome's exit: the cleanup waits for it"]]) {
    const hk = kids.find((k) => k.mode === mode);
    const [, hProfile, hChrome] = /CONTROL (\S+) (\d+)/.exec(hk.out) ?? [];
    const hGoneNow = () => (hChrome ? ownGoneOf(+hChrome, hk.c.pid) : "not reported");
    await within(() => hGoneNow() === "gone", 5000);
    const hGone = hGoneNow(), profileExists = hProfile ? existsSync(hProfile) : null;
    check(hk.code === 1 && hk.err.includes('FAIL: the run didn\'t end within 20 s; the last check was "(none yet)"; waiting on: the control\'s deliberate hang') && /cleanup: Chrome exited on (TERM|KILL); temporary directories removed; Chrome's tree: \d+ gone/.test(hk.err) && !!hProfile && profileExists === false && hGone === "gone",
      `(${label}, naming the wait, its Chrome seen to exit and gone, its tree gone, its directories removed, exit code 1): ` + JSON.stringify({ code: hk.code, signal: hk.signal, err: hk.err.slice(0, 500), profile: hProfile ?? null, profileExists, chrome: hGone }));
  }
  // (the startup-failure control: its run failed at its first startup wait; its cleanup must have stopped its Chrome
  // (seen to exit, then gone) and removed its directories, with exit code 1)
  const [, sProfile, sChrome] = /CONTROL (\S+) (\d+)/.exec(sk.out) ?? [];
  const sGoneNow = () => ({ chrome: sChrome ? ownGoneOf(+sChrome, sk.c.pid) : "not reported", group: sk.c.pid ? goneOf(-sk.c.pid) : "not started" });
  await within(() => Object.values(sGoneNow()).every((s) => s === "gone"), 5000);
  const sGone = sGoneNow();
  check(sk.code === 1 && sk.err.includes("threw: Error: no answer within 1 ms: Chrome's DevTools port") && /^  cleanup: Chrome exited on (TERM|KILL); temporary directories removed; Chrome's tree: \d+ gone$/m.test(sk.out) && !!sProfile && !existsSync(sProfile) && Object.values(sGone).every((s) => s === "gone"),
    "(the startup-failure control: a run failing at its first startup wait still stops its Chrome and removes its directories, exit code 1): " + JSON.stringify({ code: sk.code, signal: sk.signal, out: sk.out.slice(-400), err: sk.err.slice(0, 400), profile: sProfile ?? null, profileExists: sProfile ? existsSync(sProfile) : null, ...sGone }));
  for (const e of errors) fails.push("page error: " + e);
} catch (e) {
  fails.push(`threw: ${e?.stack ?? e} (waiting on: ${waitingOn})`);
} finally {
  const c = await cleanup();
  console.log("  " + c.line);
  if (!c.ok) fails.push("not everything was cleaned up: " + c.line);
}
if (fails.length) {
  console.error(`FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`ok: both pages in the workspace, ${checks} checks`);
process.exit(0);
