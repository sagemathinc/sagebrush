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
// a session's processes: its group and every descendant.  The prompt's launcher runs under
// `script` in a session (and group) of its own, so the group alone misses it, and killing
// `script` orphans it, still computing (VM1, Oct 24): the tree is collected before any kill.
// known: pid -> start, sampled while the session ran (a process orphaned before the kill)
export function sessionTree(root, known = new Map()) {
  const t = procTable(), pids = new Set([root]);
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
