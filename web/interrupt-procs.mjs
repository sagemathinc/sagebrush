// Process bookkeeping for the interrupt matrix (web/test-interrupt-matrix.mjs): finding every
// process a session started, killing all of them, and checking that none survived.  Linux /proc.
import { readdirSync, readFileSync } from "node:fs";

// the live (non-zombie) processes: pid -> { ppid, pgid, start } (start: the kernel's start time,
// so a remembered pid is never confused with a reused one)
export function procTable() {
  const t = new Map();
  for (const p of readdirSync("/proc")) {
    if (!/^\d+$/.test(p)) continue;
    try {
      const f = readFileSync(`/proc/${p}/stat`, "utf8");
      const fields = f.slice(f.lastIndexOf(")") + 2).split(" ");
      if (fields[0] !== "Z") t.set(Number(p), { ppid: Number(fields[1]), pgid: Number(fields[2]), start: fields[19] });
    } catch {}
  }
  return t;
}
// The prompt host's target: `script` runs its command under `$SHELL -c`, so the launcher can be below script's
// child rather than the child itself.  On CI, master's E2/prompt leak check, looking only at script's children, fell
// back to sampling `script` itself (2.1 MB, 1 thread; ci 40623842094, 40630220192, 40654466507, 40657095581), and
// #267's first head, without that fallback, found no target at all (ci 40663773904).
// One validated snapshot for the selection: { t: pid -> { ppid, pgid, start, comm }, errors }.  A process gone
// between the listing and its read (ENOENT, ESRCH) is a race and left out; any other read failure, or a malformed
// stat line, is an error, so a node that couldn't be read is never taken for no node (daybreak2's r3 review).
// (read, list: the /proc readers, replaced in the tests)
export function procSnapshot(read = (p) => readFileSync(`/proc/${p}/stat`, "utf8"), list = () => readdirSync("/proc")) {
  const t = new Map(), errors = [];
  let names;
  try {
    names = list();
  } catch (e) {
    return { t, errors: [`/proc: ${e?.code ?? e}`] };
  }
  for (const p of names) {
    if (!/^\d+$/.test(p)) continue;
    let f;
    try {
      f = read(p);
    } catch (e) {
      if (e?.code !== "ENOENT" && e?.code !== "ESRCH") errors.push(`${p}: ${e?.code ?? e}`);
      continue;
    }
    const o = f.indexOf("("), c = f.lastIndexOf(")");
    const fields = o >= 0 && c > o ? f.slice(c + 2).trim().split(" ") : [];
    if (!/^[A-Za-z]$/.test(fields[0] ?? "") || ![1, 2, 19].every((k) => /^\d+$/.test(fields[k] ?? ""))) {
      errors.push(`${p}: a malformed stat line`);
      continue;
    }
    if (fields[0] !== "Z") t.set(Number(p), { ppid: Number(fields[1]), pgid: Number(fields[2]), start: fields[19], comm: f.slice(o + 1, c) });
  }
  return { t, errors };
}
// From that snapshot, following current parent links down from root only (a remembered orphan or a member of root's
// group that isn't below it is cleanup evidence, never a candidate): the unique nearest process named exactly
// `name`, as { pid, comm, depth, start }.  Otherwise { pid: null, why, tree }, never an arbitrary pid and never root:
// none in a whole snapshot (no target); a tie at the nearest depth (ambiguous); or a snapshot with errors
// (unreadable: a node may be among them).  tree: root's current descendants with their depth (at most 16).
export function selectTarget(root, snap = procSnapshot(), name = "node") {
  const t = snap.t;
  const depth = new Map([[root, 0]]);
  for (let level = [root], d = 1; level.length && d <= t.size; d++) {
    const next = [];
    for (const [q, x] of t) if (!depth.has(q) && level.includes(x.ppid)) { depth.set(q, d); next.push(q); }
    level = next;
  }
  const tree = [...depth].filter(([q]) => t.has(q)).map(([q, d]) => ({ pid: q, ppid: t.get(q).ppid, comm: t.get(q).comm, depth: d }))
    .sort((a, b) => a.depth - b.depth || a.pid - b.pid);
  if (snap.errors.length) return { pid: null, why: `the process table couldn't be read whole: ${snap.errors.slice(0, 4).join("; ")}`, unreadable: true, tree: tree.slice(0, 16) };
  const named = tree.filter((x) => x.pid !== root && x.comm === name);
  if (!named.length) return { pid: null, why: `no ${name} process below ${root}`, tree: tree.slice(0, 16) };
  const nearest = named.filter((x) => x.depth === named[0].depth);
  if (nearest.length > 1) return { pid: null, why: `${nearest.length} ${name} processes at depth ${nearest[0].depth}: ${nearest.map((x) => x.pid).join(", ")}`, ambiguous: true, tree: tree.slice(0, 16) };
  const { pid, comm, depth: dd } = nearest[0];
  return { pid, comm, depth: dd, start: t.get(pid).start };
}

// (a process's /proc/PID/stat as { state, flags, start } (its start time identifies the process across reads), or
// "gone" when it no longer exists (ENOENT), or an { error } for any other failure or a malformed line)
export function statOf(pid) {
  let s;
  try {
    s = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (e) {
    return e?.code === "ENOENT" || e?.code === "ESRCH" ? "gone" : { error: `stat: ${e?.code ?? e}` };
  }
  const f = s.slice(s.lastIndexOf(")") + 2).trim().split(" ");
  const flags = Number(f[6]), start = f[19];
  if (!/^[A-Za-z]$/.test(f[0] ?? "") || !Number.isFinite(flags) || !/^\d+$/.test(start ?? "")) return { error: "a malformed stat line" };
  return { state: f[0], flags, start };
}
export const exitingStat = (x) => x === "gone" || x.state === "Z" || x.state === "X" || (x.flags & 0x4) !== 0;
// (the target's rss and threads at a DONE, read between two stat reads of the same process (its start time the same
// in both): exiting if either read finds it exiting (Z, X or PF_EXITING) or gone, as a target that prints its last
// DONE and exits at once is read with its threads already going (python's report on #251's fake); and a sample
// error, invalid evidence, never "exiting", for a read that fails otherwise, a malformed stat, or a different
// process under the pid. No target (the prompt host's node gone): exiting, never the wrapper in its place.
// start: the start time the target was selected with (selectTarget): a first read with another start time is a
// different process under a reused pid, a sample error.
// leakCheck drops a final exiting sample and says so; any other exiting sample, or any sample error, is invalid)
export function procStatus(pid, start = null) {
  if (pid == null) return { exiting: true, why: "no target process" };
  const a = statOf(pid);
  if (a.error) return { sample_error: a.error };
  if (a === "gone") return { exiting: true, why: "gone" };
  if (start != null && a.start !== start) return { sample_error: "another process under the selected pid (its start time changed)" };
  let t;
  try {
    t = readFileSync(`/proc/${pid}/status`, "utf8");
  } catch (e) {
    return e?.code === "ENOENT" || e?.code === "ESRCH" ? { exiting: true, why: "gone" } : { sample_error: `status: ${e?.code ?? e}` };
  }
  const b = statOf(pid);
  if (b.error) return { sample_error: b.error };
  if (b !== "gone" && b.start !== a.start) return { sample_error: "another process under the pid" };
  const g = (k) => Number((t.match(new RegExp(`^${k}:\\s+(\\d+)`, "m")) ?? [])[1]);
  const r = { rss_kb: g("VmRSS"), threads: g("Threads") };
  return exitingStat(a) || exitingStat(b) ? { ...r, exiting: true } : r;
}

// a prompt sample (web/test-interrupt-matrix.mjs, at each DONE): its target, then what procStatus read under the
// selected start time.  No node in a whole snapshot: exiting (only a final one may be dropped); a tie, an unreadable
// table, or a selected target without a decimal start time: a sample error (invalid evidence), never the unbound path
export function promptSample(root, snap = procSnapshot()) {
  const target = selectTarget(root, snap);
  if (target.pid == null) return { target, ...(target.ambiguous || target.unreadable ? { sample_error: target.why } : procStatus(null)) };
  if (!/^\d+$/.test(target.start ?? "")) return { target, sample_error: "the selected target has no valid start time" };
  return { target, ...procStatus(target.pid, target.start) };
}

// a session's processes: its group and every descendant.  The prompt's launcher runs under
// `script` in a session (and group) of its own, so the group alone misses it, and killing
// `script` orphans it, still computing (VM1, Oct 24): the tree is collected before any kill.
// known: pid -> start, sampled while the session ran (a process orphaned before the kill);
// t: the process table to read (a caller that looks the pids up afterwards passes its own, so
// that a process started between two snapshots is never in the tree but missing from the table)
export function sessionTree(root, known = new Map(), t = procTable()) {
  const pids = new Set([root]);
  for (const [q, st] of known) if (t.get(q)?.start === st) pids.add(q);
  for (const [q, x] of t) if (x.pgid === root) pids.add(q);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [q, x] of t) if (!pids.has(q) && pids.has(x.ppid)) { pids.add(q); grew = true; }
  }
  return [...pids].filter((q) => t.has(q));
}
export function killTree(root, known) {
  const pids = sessionTree(root, known), t = procTable();
  for (const g of new Set(pids.map((q) => t.get(q)?.pgid).filter((g) => g > 1 && g !== process.pid))) try { process.kill(-g, "SIGKILL"); } catch {}
  for (const q of pids) try { process.kill(q, "SIGKILL"); } catch {}
  return pids;
}
// what survived a kill (the cleanup check)
export const survivors = (pids) => { const t = procTable(); return pids.filter((q) => t.has(q)); };

// The one lifecycle registry (astra CORR-168-1): every session the harness starts, the matrix's,
// the signal trials' (web/interrupt-signals.mjs) and the browser's Chrome, is tracked here from its
// spawn until its cleanup is verified, and killed, tree and all, if the harness itself is stopped
// (SIGTERM, SIGINT, SIGHUP) or exits.  onStop(fn): run before such an exit (the matrix writes its
// final report).
const registry = new Map(); // root pid -> known (pid -> start), the tree sampled while it ran
const stopHooks = [];
let installed = false;
export function killTracked() {
  for (const [root, known] of registry) killTree(root, known);
}
function install() {
  if (installed) return;
  installed = true;
  for (const [sig, n] of [["SIGTERM", 15], ["SIGINT", 2], ["SIGHUP", 1]]) {
    process.on(sig, () => {
      killTracked();
      for (const fn of stopHooks) try { fn(sig); } catch {}
      process.exit(128 + n);
    });
  }
  process.on("exit", killTracked);
}
export function track(root, known = new Map()) {
  install();
  registry.set(root, known);
  return known;
}
export function untrack(root) {
  registry.delete(root);
}
export function onStop(fn) {
  install();
  stopHooks.push(fn);
}
export const trackedCount = () => registry.size;
