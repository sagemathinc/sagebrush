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
import { createServer } from "node:net";
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
            const lines = (line + d).split("\n");
            line = lines.pop();
            if (line.length > KEEP) return done(`an event longer than ${KEEP} characters`);
            for (const l of lines) {
              if (!l.startsWith("data: ")) continue;
              let msg;
              try { msg = JSON.parse(l.slice(6)); } catch { return done(`an event that isn't JSON: ${l.slice(0, 200)}`); }
              if (msg.id !== 1) continue;
              if (msg.stream === "stdout") output = (output ?? "") + msg.text;
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
  let child = null, dir = null, kept = 0;
  const { value } = await scoped(async (r) => {
    dir = r.dir("sb-workers-self-");
    const real = r.spawn;
    r.spawn = (cmd, args, opts) => (child = real(process.execPath, ["-e", spew], opts));
    const stats = {};
    const out = await notebookRuns(r, "unused", [], port, dir, 2000, stats);
    kept = stats.kept ?? 0;
    return out;
  });
  check(typeof value === "string" && /^no result in 2 s/.test(value), "the harness: a server that never answers times out", String(value));
  check(kept > 0 && kept <= 2 * KEEP, `...what is kept of its output is bounded (at most ${kept} characters at once)`);
  check(!!child && exited(child), "...and it is stopped, though it ignores SIGTERM", child ? `exit ${child.exitCode}, signal ${child.signalCode}` : "never started");
  check(await portFree(port), "...its port is free again");
  check(!!dir && !existsSync(dir), "...and the directory is removed");
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
  }
});
check(!error, "no unexpected error", String(error?.stack ?? error));

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
