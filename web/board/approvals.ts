// A board's code approved to run unconfined (capability.ts), by its digest: kept in the permissions record
// ("sagebrush-grants", localStorage: per device, out of every worker's reach, synced by nothing), as `approvals`, each
// "host:" and the digest, and the time it was made or used; on the desktop app also in grants.json, beside the grants
// (web/workspace/grants-file.ts merges them three ways, a removal winning). Apart from capability.ts so that merge
// needs none of the board's code.

/** The record's approvals, as this code writes them, or {}: each key "host:" and 64 hex digits, each value a safe
 * integer; anything else left out (it approves nothing); the newest APPROVALS_MAX kept. */
export function validApprovals(a: unknown): Record<string, number> {
  if (!a || typeof a !== "object" || Array.isArray(a)) return {};
  const ok = Object.entries(a as Record<string, unknown>).filter(([k, t]) => KEY.test(k) && Number.isSafeInteger(t)) as [string, number][];
  return Object.fromEntries(ok.sort((x, y) => y[1] - x[1]).slice(0, APPROVALS_MAX));
}
/** The one capability approved today: running unconfined, with the page's storage within reach.  (Kept apart from
 * the file gate's own capabilities: an approval's key is "host:" and its digest.) */
export const HOST = "host";
/** At most this many approvals are kept, the least recently made or used going first (which only brings a Run back). */
export const APPROVALS_MAX = 2000;
const GRANTS = "sagebrush-grants";
const KEY = /^host:[0-9a-f]{64}$/;
type Store = Pick<Storage, "getItem" | "setItem">;
// (this page's storage, reached only within each call's own try: in a sandboxed frame merely reading localStorage
// throws, and then nothing is approved, nothing marked, and nothing thrown)
const store = (): Store => ({ getItem: (k) => globalThis.localStorage.getItem(k), setItem: (k, v) => globalThis.localStorage.setItem(k, v) });
// (the record as it is, or a new one; null if it can't be read: then nothing is approved, and nothing is written)
function record(s: Store): any | null {
  try {
    const raw = s.getItem(GRANTS);
    if (raw === null) return { v: 1, seq: 0, docs: {} };
    const r = JSON.parse(raw);
    return r && typeof r === "object" && r.v === 1 && r.docs && typeof r.docs === "object" && !Array.isArray(r.docs) ? r : null;
  } catch { return null; }
}
/** Whether `digest` is approved for `host` on this device.  Storage that can't be read approves nothing. */
export function approved(digest: string | null, s: Store = store()): boolean {
  if (!digest) return false;
  const r = record(s);
  return !!r && Object.prototype.hasOwnProperty.call(validApprovals(r.approvals), `host:${digest}`);
}
// (the record's approvals changed, the rest as it is, and read back: false if it couldn't be kept)
function change(f: (a: Record<string, number>) => void, s: Store): boolean {
  const r = record(s);
  if (!r) return false;
  const a = validApprovals(r.approvals);
  f(a);
  const next = validApprovals(a);
  try {
    const { approvals: _, ...rest } = r;
    s.setItem(GRANTS, JSON.stringify(Object.keys(next).length ? { ...rest, approvals: next } : rest));
    return JSON.stringify(validApprovals(record(s)?.approvals)) === JSON.stringify(next);
  } catch { return false; }
}
/** The person approves `digest` for `host` (their Run, an edit of theirs to approved code, a board they made). */
export function approve(digest: string | null, s: Store = store(), now = Date.now()): boolean {
  if (!digest) return false;
  return change((a) => { a[`host:${digest}`] = now; }, s);
}
// (approved for this page only: the person's Run when the approval couldn't be kept, said so)
const once = new Set<string>();
/** The person's Run, its approval not kept: this code may run in this page, until it closes. */
export function allowOnce(digest: string | null) { if (digest) once.add(digest); }
/** Whether this code may run unconfined: approved on this device, or run by the person in this page. */
export function mayRun(digest: string | null, s: Store = store()): boolean { return !!digest && (once.has(digest) || approved(digest, s)); }
/** "Forget the approval of this board's code": `digest`'s approval removed. */
export function forget(digest: string | null, s: Store = store()): boolean {
  if (!digest) return true;
  once.delete(digest);
  return change((a) => { delete a[`host:${digest}`]; }, s);
}
/** Every approval removed (with the site's permissions). */
export function forgetAll(s: Store = store()): boolean {
  once.clear();
  return change((a) => { for (const k of Object.keys(a)) delete a[k]; }, s);
}

/** grants.json's merge of the approvals (web/workspace/grants-file.ts): three ways over the base, an approval in the
 * base staying only if neither side took it out (a removal wins), one not in it coming in from either, the later
 * time; the newest APPROVALS_MAX kept. */
export function mergeApprovals(base: unknown, file: unknown, local: unknown): Record<string, number> {
  const b = validApprovals(base), f = validApprovals(file), l = validApprovals(local), out: Record<string, number> = {};
  for (const k of new Set([...Object.keys(f), ...Object.keys(l)])) {
    if (k in b ? k in f && k in l : true) out[k] = Math.max(f[k] ?? 0, l[k] ?? 0);
  }
  return validApprovals(out);
}

