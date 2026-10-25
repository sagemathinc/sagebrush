// The bundle's own workers, started through the launcher (the npm package's
// command): board check's interpreter, the notebook's sessions and the
// Jupyter kernel each start require.main's file, which is the launcher, in a
// worker thread, and must get the bundle there, not a program of their own.
// So: `board check` runs a board's code item (through the launcher, as `npx
// sagebrush board check` does), under Node and, when they are here, Deno and
// Bun (whose Worker has no stdout or stderr of its own); a worker the
// launcher starts as the notebook's session or as the kernel says it is ready;
// and `sagebrush notebook` runs a cell, under each of those runtimes.
//
// Everything this test starts (workers, processes, requests, its directory)
// is kept in a registry and ended on every path, a failure or a throw
// included: requests destroyed, workers terminated, processes stopped and
// waited for (SIGKILL after a short grace), the directory removed; and what
// it keeps of a child's output is bounded.  The harness checks that of
// itself first (a server that never answers and ignores SIGTERM; a throw).
//   node web/test-cli-workers.mjs [launcher]
//   (default packages/sagebrush/bin/sagebrush.cjs, with the bundle node
//   scripts/build-cli.mjs puts beside it in dist/)
import { spawn, spawnSync } from "node:child_process";
import { request } from "node:http";
import { connect, createServer } from "node:net";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { freePort } from "./test-port.mjs";

const launcher = process.argv[2] ?? new URL("../packages/sagebrush/bin/sagebrush.cjs", import.meta.url).pathname;
/** What is kept of a child's output, or of a stream of events (the tail; the marker looked for as it comes). */
const KEEP = 64 * 1024;
/** How long a process asked to stop has before SIGKILL, and a worker or a killed process to end. */
const GRACE_MS = 3000, END_MS = 5000;
let failed = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "ok" : "FAIL"} ${what}${ok || !detail ? "" : `: ${detail}`}`);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keep = (buf, more) => (buf.length + more.length > KEEP ? (buf + more).slice(-KEEP) : buf + more);

// ---- the registry: everything started, ended on every path
const exited = (p) => p.exitCode !== null || p.signalCode !== null;
async function stopProcess(p) {
  if (exited(p)) return;
  const gone = new Promise((r) => p.once("exit", r));
  p.kill("SIGTERM");
  if (await Promise.race([gone.then(() => true), sleep(GRACE_MS).then(() => false)])) return;
  p.kill("SIGKILL");
  await Promise.race([gone, sleep(END_MS)]);
}
function registry() {
  const r = { requests: new Set(), workers: new Set(), procs: new Set(), dirs: new Set() };
  r.dir = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); r.dirs.add(d); return d; };
  r.spawn = (cmd, args, opts) => { const p = spawn(cmd, args, opts); r.procs.add(p); return p; };
  r.worker = (file, opts) => { const w = new Worker(file, opts); r.workers.add(w); return w; };
  r.request = (...a) => { const q = request(...a); r.requests.add(q); return q; };
  r.close = async () => {
    for (const q of r.requests) q.destroy();
    await Promise.all([...r.workers].map((w) => Promise.race([w.terminate(), sleep(END_MS)])));
    await Promise.all([...r.procs].map(stopProcess));
    for (const d of r.dirs) rmSync(d, { recursive: true, force: true });
  };
  return r;
}
/** fn with a registry of its own, closed whatever happens; fn's error is returned, not thrown. */
async function scoped(fn) {
  const r = registry();
  try {
    return { value: await fn(r), registry: r };
  } catch (error) {
    return { error, registry: r };
  } finally {
    await r.close();
  }
}
const portFree = (port) => new Promise((resolve) => {
  const s = createServer();
  s.once("error", () => resolve(false));
  s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
});

// whether something accepts connections on the port, within ms
async function listening(port, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    const ok = await new Promise((resolve) => {
      const c = connect(port, "127.0.0.1");
      c.once("connect", () => { c.destroy(); resolve(true); });
      c.once("error", () => resolve(false));
    });
    if (ok) return true;
  }
  return false;
}
// a stand-in for `sagebrush notebook` (node FILE PORT MODE): it says its URL as the real one does, takes the token,
// and its session's events are, by MODE, `spam` (the stdout "5\n" again and again, never done) or `long` (one
// complete event longer than KEEP characters)
const FAKE_NOTEBOOK = `const [port, mode, keep] = process.argv.slice(2);
require("http").createServer((q, s) => {
  if (q.url.startsWith("/?token=")) return s.writeHead(302, { "Set-Cookie": "sagebrush_token=t; Path=/", Location: "/" }).end();
  if (!q.url.endsWith("/events")) return s.writeHead(200).end("ok");
  s.writeHead(200, { "Content-Type": "text/event-stream" });
  const event = (text) => "data: " + JSON.stringify({ id: 1, stream: "stdout", text }) + "\\n\\n";
  if (mode === "long") return void s.write(event("y".repeat(2 * Number(keep))));
  const t = setInterval(() => s.write(event("5\\n").repeat(100)), 1);
  q.on("close", () => clearInterval(t));
}).listen(Number(port), "127.0.0.1", () => console.log("http://127.0.0.1:" + port + "/?token=" + "ab".repeat(24)));
`;

// ---- `sagebrush notebook` through the launcher, end to end as its page does it: a session's
// events, then a Sage cell `2+3` sent to it; its output is the stream "5\n", and it is done without an error
function notebookRuns(r, cmd, args, port, dir, ms = 90_000, stats = {}) {
  return new Promise((resolve) => {
    const p = r.spawn(cmd, [...args, "notebook", dir, "--port", String(port), "--no-browser"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", started = false, settled = false;
    const said = () => `${out}${err}`.slice(-300);
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve(v);
    };
    const t = setTimeout(() => done(`no result in ${ms / 1000} s; the server said: ${said()}`), ms);
    p.stderr.on("data", (b) => { err = keep(err, String(b)); stats.kept = Math.max(stats.kept ?? 0, out.length + err.length); });
    p.on("exit", (code) => done(`the server exited (${code}): ${said()}`));
    p.stdout.on("data", async (b) => {
      out = keep(out, String(b));
      stats.kept = Math.max(stats.kept ?? 0, out.length + err.length);
      const m = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([0-9a-f]+)/.exec(out);
      if (!m || started) return;
      started = true;
      const [, at, token] = m;
      try {
        // the token for the cookie, as the browser trades it
        const first = await fetch(`http://127.0.0.1:${at}/?token=${token}`, { redirect: "manual" });
        const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
        const base = `http://127.0.0.1:${at}/nb/t.ipynb/api/session/s1`;
        // the events, read line by line: only a line not yet ended is kept, and it is bounded
        let line = "", output = null;
        const events = r.request(`${base}/events`, { headers: { cookie } }, (res) => {
          res.setEncoding("utf8");
          res.on("data", (d) => {
            if (settled) return; // (decided: nothing more is kept)
            const lines = (line + d).split("\n");
            line = lines.pop();
            if (line.length > KEEP) return done(`an event longer than ${KEEP} characters`);
            for (const l of lines) {
              if (l.length > KEEP) return done(`an event longer than ${KEEP} characters`);
              if (!l.startsWith("data: ")) continue;
              let msg;
              try { msg = JSON.parse(l.slice(6)); } catch { return done(`an event that isn't JSON: ${l.slice(0, 200)}`); }
              if (msg.id !== 1) continue;
              // (the output kept is only ever a prefix of the one expected: at most its 2 characters)
              if (msg.stream === "stdout") {
                output = (output ?? "") + msg.text;
                stats.events = Math.max(stats.events ?? 0, output.length, line.length);
                if (!"5\n".startsWith(output)) return done(`the cell's output was ${JSON.stringify(output.slice(0, 40))}${output.length > 40 ? "…" : ""}, not "5\\n"`);
              }
              if (msg.done) done(msg.error ? `the cell failed: ${JSON.stringify(msg).slice(0, 300)}` : output === "5\n" ? true : `the cell's output was ${JSON.stringify(output)}, not "5\\n"`);
            }
          });
        });
        events.on("error", (e) => done(`the events: ${e.message}`));
        events.end();
        await fetch(`${base}/send`, { method: "POST", headers: { cookie }, body: JSON.stringify({ id: 1, code: "2+3", sage: true }) });
      } catch (e) {
        done(String(e?.message ?? e));
      }
    });
  });
}

// ---- `sagebrush notebook`'s Stop wakes a time.sleep at once (src/notebook.ts:
// requestCtrlC, bit 0 set and the word notified, as Ctrl-C does): a cell
// sleeping 30 s, Stop sent 2 s in, its KeyboardInterrupt within 5 s of it
function notebookStopsSleep(r, cmd, args, port, dir, ms = 90_000) {
  return new Promise((resolve) => {
    const p = r.spawn(cmd, [...args, "notebook", dir, "--port", String(port), "--no-browser"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", started = false, settled = false, stopAt = 0;
    const said = () => `${out}${err}`.slice(-300);
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve(v);
    };
    const t = setTimeout(() => done(`no result in ${ms / 1000} s; the server said: ${said()}`), ms);
    p.stderr.on("data", (b) => { err = keep(err, String(b)); });
    p.on("exit", (code) => done(`the server exited (${code}): ${said()}`));
    p.stdout.on("data", async (b) => {
      out = keep(out, String(b));
      const m = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([0-9a-f]+)/.exec(out);
      if (!m || started) return;
      started = true;
      const [, at, token] = m;
      try {
        const first = await fetch(`http://127.0.0.1:${at}/?token=${token}`, { redirect: "manual" });
        const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
        const base = `http://127.0.0.1:${at}/nb/t.ipynb/api/session/s2`;
        let line = "", text = "";
        const events = r.request(`${base}/events`, { headers: { cookie } }, (res) => {
          res.setEncoding("utf8");
          res.on("data", (d) => {
            if (settled) return;
            const lines = (line + d).split("\n");
            line = lines.pop();
            if (line.length > KEEP) return done(`an event longer than ${KEEP} characters`);
            for (const l of lines) {
              if (!l.startsWith("data: ")) continue;
              let msg;
              try { msg = JSON.parse(l.slice(6)); } catch { return done(`an event that isn't JSON: ${l.slice(0, 200)}`); }
              if (msg.id !== 1) continue;
              if (msg.stream === "stdout") text = keep(text, msg.text);
              if (msg.done) {
                const after = stopAt ? Date.now() - stopAt : -1;
                done(text === "KI\n" && after >= 0 && after < 5000 ? true : `the cell printed ${JSON.stringify(text.slice(0, 60))}, ${after} ms after Stop`);
              }
            }
          });
        });
        events.on("error", (e) => done(`the events: ${e.message}`));
        events.end();
        await fetch(`${base}/send`, { method: "POST", headers: { cookie }, body: JSON.stringify({ id: 1, code: "import time\ntry:\n    time.sleep(30)\nexcept KeyboardInterrupt:\n    print('KI')" }) });
        await sleep(2000);
        stopAt = Date.now();
        await fetch(`${base}/interrupt`, { method: "POST", headers: { cookie }, body: JSON.stringify({ upTo: 1 }) });
      } catch (e) {
        done(String(e?.message ?? e));
      }
    });
  });
}

// a worker on the launcher, as the notebook's session and as the kernel: ready
const ready = (r, workerData) => new Promise((resolve) => {
  const w = r.worker(launcher, { workerData, stdout: true, stderr: true });
  w.stdout?.resume();
  w.stderr?.resume();
  const done = (v) => { clearTimeout(t); resolve(v); };
  const t = setTimeout(() => done("no message in 60 s"), 60_000);
  w.on("message", (m) => { if (m?.ready) done(true); });
  w.on("error", (e) => done(String(e?.message ?? e)));
  w.on("exit", (code) => done(`exited (${code})`));
});

// ---- the harness itself: everything it started is ended, on a timeout and on a throw
{
  // a "server" that never says its URL, writes without end, and ignores SIGTERM: the notebook's check times
  // out, keeps at most KEEP of what it wrote, and the process is gone (SIGKILL), its port free again
  const port = await freePort();
  const spew = `require("net").createServer().listen(${port}, "127.0.0.1"); process.on("SIGTERM", () => {}); setInterval(() => process.stdout.write("x".repeat(65536)), 1);`;
  let child = null, dir = null, kept = 0, up = false;
  const { value } = await scoped(async (r) => {
    dir = r.dir("sb-workers-self-");
    const real = r.spawn;
    r.spawn = (cmd, args, opts) => (child = real(process.execPath, ["-e", spew], opts));
    const stats = {};
    const run = notebookRuns(r, "unused", [], port, dir, 2000, stats);
    up = await listening(port);
    const out = await run;
    kept = stats.kept ?? 0;
    return out;
  });
  check(up, "the harness: a server that never answers is up (its port takes a connection)");
  check(typeof value === "string" && /^no result in 2 s/.test(value), "...and the check times out", String(value));
  check(kept > 0 && kept <= 2 * KEEP, `...what is kept of its output is bounded (at most ${kept} characters at once)`);
  check(child?.signalCode === "SIGKILL", "...and it is stopped by SIGKILL, since it ignores SIGTERM", child ? `exit ${child.exitCode}, signal ${child.signalCode}` : "never started");
  check(await portFree(port), "...its port is free again");
  check(!!dir && !existsSync(dir), "...and the directory is removed");
}
for (const [mode, what, expect] of [
  ["spam", "a session whose stdout goes on and on, never done", /not "5\\n"/],
  ["long", "a session whose event is longer than KEEP", /an event longer than/],
]) {
  // the events of a session gone wrong: decided at once, with no more than the expected output kept
  const port = await freePort();
  let child = null, stats = {}, ms = 0;
  const { value } = await scoped(async (r) => {
    const dir = r.dir("sb-workers-self-");
    const fake = join(dir, "fake-notebook.cjs");
    writeFileSync(fake, FAKE_NOTEBOOK);
    const real = r.spawn;
    r.spawn = (cmd, args, opts) => (child = real(process.execPath, [fake, String(port), mode, String(KEEP)], opts));
    const t0 = Date.now();
    const out = await notebookRuns(r, "unused", [], port, dir, 30_000, stats);
    ms = Date.now() - t0;
    return out;
  });
  check(typeof value === "string" && expect.test(value) && ms < 10_000, `the harness: ${what} fails at once (${ms} ms)`, String(value).slice(0, 200));
  check((stats.events ?? 0) <= KEEP, `...and what is kept of its events is bounded (${stats.events ?? 0} characters)`);
  check(!!child && exited(child) && (await portFree(port)), "...and the stand-in is stopped, its port free");
}
{
  // a throw, with a process and a directory live: both ended all the same
  const port = await freePort();
  let child = null, dir = null;
  const { error } = await scoped(async (r) => {
    dir = r.dir("sb-workers-self-");
    child = r.spawn(process.execPath, ["-e", `require("net").createServer().listen(${port}, "127.0.0.1")`], { stdio: "ignore" });
    await sleep(300);
    throw new Error("thrown on purpose");
  });
  check(error?.message === "thrown on purpose", "the harness: a throw is caught", String(error));
  check(!!child && exited(child), "...the process it left is stopped");
  check(await portFree(port), "...its port is free again");
  check(!!dir && !existsSync(dir), "...and the directory is removed");
}

// ---- the launcher
const { error } = await scoped(async (r) => {
  const dir = r.dir("sb-workers-");
  // board check: its code item run, and right
  const board = join(dir, "t.board.json");
  writeFileSync(board, JSON.stringify({
    format: "sagebrush-board", version: 1, title: "workers", layout: "graph",
    nodes: [{ id: "a", text: "Is $2^{32}+1$ prime?" }, { id: "b", code: "2**32+1" }],
    edges: [{ from: "a", to: "b" }],
  }));
  const has = (cmd) => spawnSync(cmd, ["--version"], { stdio: "ignore", timeout: 30_000 }).status === 0;
  const runtimes = [["node", [process.execPath, launcher]]];
  if (has("deno")) runtimes.push(["deno", ["deno", "run", "-A", launcher]]);
  if (has("bun")) runtimes.push(["bun", ["bun", launcher]]);
  for (const [name, [cmd, ...args]] of runtimes) {
    // (spawnSync: waited for, killed at its timeout, its output bounded by maxBuffer)
    const c = spawnSync(cmd, [...args, "board", "check", board, "--json"], { encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL", maxBuffer: 4 * 2 ** 20 });
    let report = null;
    try { report = JSON.parse(c.stdout); } catch {}
    const item = report?.code?.items?.[0];
    check(c.status === 0 && report?.ok === true, `${name}: board check through the launcher passes`, `status ${c.status}, ${String(c.error ?? "")} ${(c.stdout + c.stderr).slice(0, 300)}`);
    check(item?.status === "ok", `${name}: board check runs the code item`, JSON.stringify(item ?? null).slice(0, 300));
  }
  const nb = await ready(r, { sagebrushNotebook: { dir } });
  check(nb === true, "a notebook session on the launcher starts", String(nb));
  const kernel = await ready(r, { sagebrushKernel: "python" });
  check(kernel === true, "the kernel on the launcher starts", String(kernel));
  for (const [name, [cmd, ...args]] of runtimes) {
    // (each runtime's server in a registry of its own: stopped, and waited for, before the next one starts)
    const port = await freePort();
    const { value, error } = await scoped((r2) => notebookRuns(r2, cmd, args, port, dir));
    check(value === true, `${name}: a notebook cell through the launcher runs (2+3 prints 5)`, String(error ?? value));
    const port2 = await freePort();
    const stop = await scoped((r2) => notebookStopsSleep(r2, cmd, args, port2, dir));
    check(stop.value === true, `${name}: the notebook's Stop interrupts a time.sleep at once`, String(stop.error ?? stop.value));
  }
});
check(!error, "no unexpected error", String(error?.stack ?? error));

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
