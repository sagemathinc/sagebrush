// A child run the parent alone bounds (#974, ENGINE r1: spawnSync's timeout only signals the child and then waits for
// it, so a child stuck in a synchronous call of its own, or ignoring SIGTERM, held the export-controls job until it was
// cancelled). The child gets a process group of its own (detached); past `ms`, that exact group gets SIGTERM, then
// SIGKILL `graceMs` later; when the child has exited, whatever is left in its group (a browser it started) gets SIGKILL
// too. Never a kill by name, never another group.  Used by test-export-controls.mjs; pinned by test-bounded-run.mjs.
import { spawn } from "node:child_process";

const gone = (pgid) => { try { process.kill(-pgid, 0); return false; } catch (e) { return e.code === "ESRCH"; } };
const signal = (pgid, sig) => { try { process.kill(-pgid, sig); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let current = null;
// (the parent stopped itself, e.g. by the job's own timeout: the group it is running goes with it)
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { if (current) signal(current, "SIGKILL"); process.exit(sig === "SIGINT" ? 130 : 143); });

/** Why a bounded run is that control's named FAIL (the words the harness prints), or null if it ended by itself and
 *  left nothing: stopped at its bound, ended by a signal, or its group outliving the final SIGKILL. */
export function stopped(r, ms, what) {
  const why = r.timedOut ? `${what} didn't finish in ${ms / 1000} s (stopped)` : r.signal ? `${what} ended by ${r.signal}` : null;
  return r.survivors ? `${why ?? `${what} ended`}, and its process group outlived the kill` : why;
}

/** Runs cmd in its own process group, bounded by `ms` (then SIGTERM, then SIGKILL after `graceMs`), its output kept.
 *  Resolves { status, signal, stdout, stderr, timedOut, survivors }: survivors is true if the group still had a
 *  process `sweepMs` after the final SIGKILL (never expected). */
export function runBounded(cmd, args, { ms, graceMs = 10_000, sweepMs = 5_000, maxBuffer = 1 << 26, ...opts }) {
  return new Promise((done) => {
    const c = spawn(cmd, args, { ...opts, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const pgid = c.pid;
    current = pgid;
    let stdout = "", stderr = "", timedOut = false, exited = null;
    const keep = (s, d) => (s.length < maxBuffer ? s + d : s);
    c.stdout.setEncoding("utf8").on("data", (d) => { stdout = keep(stdout, d); });
    c.stderr.setEncoding("utf8").on("data", (d) => { stderr = keep(stderr, d); });
    let kill;
    const term = setTimeout(() => {
      timedOut = true;
      signal(pgid, "SIGTERM");
      kill = setTimeout(() => signal(pgid, "SIGKILL"), graceMs);
    }, ms);
    let finished = false;
    const finish = async () => {
      if (finished) return;
      finished = true;
      clearTimeout(term); clearTimeout(kill);
      // (the child is gone: anything still in its group is swept, and the group must then be empty)
      signal(pgid, "SIGKILL");
      let left = !gone(pgid);
      for (const t0 = Date.now(); left && Date.now() - t0 < sweepMs; left = !gone(pgid)) await sleep(50);
      current = null;
      done({ status: exited?.[0] ?? null, signal: exited?.[1] ?? null, stdout, stderr, timedOut, survivors: left });
    };
    c.on("error", (e) => { stderr += String(e); exited ??= [null, null]; void finish(); });
    // ('exit', not 'close': a process left in the group may hold the pipes open; it is swept, then the output is read)
    c.on("exit", (status, sig) => { exited = [status, sig]; signal(pgid, "SIGKILL"); });
    c.on("close", () => { void finish(); });
  });
}
