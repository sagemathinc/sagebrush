// ci: none (imported by other suites, not one itself: web/agents/a14-cases.mjs, web/agents/test-agents-artifacts.mjs)
// @ts-check
// Ports for the browser tests, so that any number of test runs can share a
// machine (the shared test VM runs several CI runs at once): a test's
// Chrome is started with --remote-debugging-port=0, or CDP_PORT when it is
// set, and devtoolsPort() reads the port Chrome chose from its profile's
// DevToolsActivePort file; a server a test starts listens where freePort()
// says (port 0: the system's choice), or on port 0 itself; web/serve.py, on
// port 0, says the port it took once it is listening, and startServe() waits
// for that (no port chosen here that something else can take first).
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

/** How much of a Chrome's stderr devtoolsPort keeps (its last bytes), and how many profile entries a timeout names. */
export const CHROME_STDERR_TAIL = 2048, PROFILE_LIST_MAX = 12;

/** The DevTools port of a Chrome started with --remote-debugging-port=0 and
 * --user-data-dir=profile, once it is listening (within `ms`).  A timeout lists
 * the profile: none or an empty one is a Chrome that never started, a populated
 * one a Chrome slow to say its port (the Chrome-start reds of Nov 3).  Given its
 * process, { child } (spawned with stderr piped), a Chrome that exits or can't
 * start fails at once instead of after `ms`, and either failure carries the last
 * CHROME_STDERR_TAIL bytes of its stderr.
 * @param {string} profile
 * @param {number} [ms]
 * @param {{ child?: import("node:child_process").ChildProcess }} [options] */
export async function devtoolsPort(profile, ms = 60_000, { child } = {}) {
  const watch = child ? watchChrome(child) : null;
  const t = Date.now();
  for (;;) {
    try {
      const port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
      if (port > 0) return port;
    } catch {}
    if (watch?.error) throw new Error(`Chrome couldn't start (${watch.error.code ?? watch.error.message}) (${profile})${stderrText(watch)}`);
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      // (its last stderr can arrive after the exit: wait for the pipe to close, a second at most)
      await Promise.race([watch.closed, new Promise((r) => setTimeout(r, 1000))]);
      throw new Error(`Chrome exited (${child.exitCode ?? child.signalCode}) before saying its DevTools port (${profile})${stderrText(watch)}`);
    }
    if (Date.now() - t > ms) throw new Error(`Chrome did not say its DevTools port within ${ms / 1000} s (${profile}: ${listProfile(profile)})${stderrText(watch)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// (one watcher a process, kept for its life: its stderr is drained into the tail, so a chatty Chrome never blocks on
// a full pipe, and a spawn error is held rather than thrown unhandled)
/** @typedef {{ tail: Buffer, error: (NodeJS.ErrnoException | null), closed: Promise<unknown> }} ChromeWatch */
/** @type {WeakMap<import("node:child_process").ChildProcess, ChromeWatch>} */
const watched = new WeakMap();
/** @param {import("node:child_process").ChildProcess} child
 * @returns {ChromeWatch} */
function watchChrome(child) {
  const w = watched.get(child);
  if (w) return w;
  /** @type {ChromeWatch} */
  const keep = { tail: Buffer.alloc(0), error: null, closed: Promise.resolve() };
  const stderr = child.stderr;
  if (stderr) keep.closed = new Promise((r) => stderr.once("close", r));
  stderr?.on("data", (d) => {
    const all = Buffer.concat([keep.tail, Buffer.isBuffer(d) ? d : Buffer.from(String(d))]);
    keep.tail = all.subarray(Math.max(0, all.length - CHROME_STDERR_TAIL));
  });
  child.on("error", (e) => { keep.error = e; });
  watched.set(child, keep);
  return keep;
}

/** @param {ChromeWatch | null} watch */
function stderrText(watch) {
  if (!watch) return "";
  const text = watch.tail.toString("utf8").trim();
  return text ? `; its stderr ends: ${text}` : "; its stderr is empty";
}

/** @param {string} profile */
function listProfile(profile) {
  let names;
  try {
    names = readdirSync(profile).sort();
  } catch (e) {
    return `no profile directory (${/** @type {NodeJS.ErrnoException} */ (e).code ?? e})`;
  }
  if (names.length === 0) return "the profile is empty";
  const shown = names.slice(0, PROFILE_LIST_MAX).join(", ");
  return `${names.length} profile entries: ${shown}${names.length > PROFILE_LIST_MAX ? ", ..." : ""}`;
}

/** A port free now (the system's choice), for a server that must be told one. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    // (listening on a TCP host, address() is an AddressInfo, never the pipe name string)
    s.listen(0, "127.0.0.1", () => { const { port } = /** @type {import("node:net").AddressInfo} */ (s.address()); s.close(() => resolve(port)); });
  });
}

/** How long startServe waits for the port line, and the most it reads before it. */
export const SERVE_MS = 30_000, SERVE_OUT_MAX = 4096;
/** Start serve.py (spawnChild() spawns it with port 0) and learn its port: the one line it prints once it is
 * listening. Fails in words if it exits, can't start, says anything else, writes more than SERVE_OUT_MAX bytes
 * before that line (counted in bytes, before anything is kept), or is silent for `ms`; on every failure the child
 * is killed. Its listeners go once settled, and the rest
 * of its stdout is drained; stderr keeps only a 2,000-character tail (PR #103 review: LIMIT-PWA103-1/LIFE-PWA103-2). */
export function startServe(spawnChild, ms = SERVE_MS) {
  const child = spawnChild();
  let err = "";
  child.stderr?.on("data", (d) => { err = (err + d).slice(-2000); });
  const port = new Promise((resolve, reject) => {
    const kept = [];
    let bytes = 0;
    const settle = (f, v) => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      child.stdout?.resume();
      f(v);
    };
    const fail = (why) => { try { child.kill("SIGKILL"); } catch {} settle(reject, new Error(why + (err ? " (stderr: " + err.slice(-500) + ")" : ""))); };
    // (the cap is in bytes and comes first: a chunk that would take what is kept past SERVE_OUT_MAX is refused before
    // it is kept or parsed, whether or not it holds a newline; PR #103 review, LIMIT-PWA103-1)
    const onData = (d) => {
      const chunk = Buffer.isBuffer(d) ? d : Buffer.from(String(d));
      if (bytes + chunk.length > SERVE_OUT_MAX) return fail(`serve.py wrote more than ${SERVE_OUT_MAX} bytes before its port line`);
      bytes += chunk.length;
      kept.push(chunk);
      const out = Buffer.concat(kept);
      const nl = out.indexOf(0x0a);
      if (nl < 0) return;
      const line = out.subarray(0, nl).toString("utf8").trim();
      if (/^\d{1,5}$/.test(line) && +line > 0 && +line < 65536) settle(resolve, Number(line));
      else fail("serve.py said something other than its port: " + JSON.stringify(line.slice(0, 80)));
    };
    const onExit = (code, signal) => fail(`serve.py exited before listening (${code ?? signal})`);
    const onError = (e) => fail(`serve.py couldn't start (${e?.code ?? e})`);
    const timer = setTimeout(() => fail(`serve.py didn't say its port within ${ms / 1000} s`), ms);
    child.stdout.on("data", onData);
    child.on("exit", onExit);
    child.on("error", onError);
  });
  return { child, port };
}
