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
