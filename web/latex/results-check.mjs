// The SageTeX results file checked against the files its Run imported from the .tex's folder (Codex W01): the page
// reads results when it opens and on focus, without Run's own code (run-core.mjs, a lazy chunk since #824), so these
// are a module of their own, in the page's bundle; run-core.mjs re-exports them.
import { depsOf, staleOf } from "./engine/sagetex.mjs";

// ---- the editor reading a results file's record of what its Run imported (Codex W01)
/** The .tex's folder's reader of recorded files, the CLI's rule (sagetex.mjs staleOf): the file's bytes, at most
 * `left`; null if it isn't there or is in the Trash; "over" if larger than `left`. */
export const wsReader = (ws, dir) => async (rel, left) => {
  const p = (dir === "/" ? "" : dir) + "/" + rel;
  try { const r = await ws.readUpTo(p, left); return r.entry?.trashed ? null : r.content; }
  catch (err) { return err?.code === "limit" ? "over" : null; }
};
/** What was seen of a results file (`e`, its entry) and of each file its Run imported: their ids, revisions and
 * sizes in one string; null if there is no results file. */
export async function seenOf(ws, e, dir, deps) {
  if (!e || e.trashed) return null;
  const base = dir === "/" ? "" : dir;
  const ds = await Promise.all(deps.map(([rel]) => ws.stat(base + "/" + rel).catch(() => undefined)));
  // (rev counts every write: `updated` is a time in ms and two writes may share it (daybreak3's ENGINE-SEEN-REV-1))
  return `${e.fid}:${e.rev}:${e.updated}:${e.size}#` + ds.map((d) => d && !d.trashed ? `${d.fid}:${d.rev}:${d.updated}:${d.size}` : "-").join("|");
}
/** A results file `j` (read from `p`, its entry `e`) checked against the files its Run imported: {saved, deps, stale,
 * seen}. `saved`: its items if they may be used, else []; `stale`: why not (sagetex.mjs staleWhy), or null. `seen`
 * is the state checked, or null if anything changed while it was checked (astra's DEP-SEEN-1, daybreak3's
 * ENGINE-SEEN-COMMIT-1): then nothing is used and nothing counts as seen, so the next read checks again. */
export async function checkedResults(ws, p, e, j, dir) {
  const deps = depsOf(j);
  if (deps === "invalid" || deps === "incomplete") return { saved: [], deps: [], stale: deps, seen: await seenOf(ws, e, dir, []) };
  if (!deps) return { saved: j.items, deps: [], stale: null, seen: await seenOf(ws, e, dir, []) };
  const before = await seenOf(ws, e, dir, deps);
  const stale = await staleOf(deps, wsReader(ws, dir));
  const after = await seenOf(ws, await ws.stat(p).catch(() => undefined), dir, deps);
  const stable = before !== null && before === after;
  return { saved: stale || !stable ? [] : j.items, deps, stale: stable ? stale : null, seen: stable ? after : null };
}
