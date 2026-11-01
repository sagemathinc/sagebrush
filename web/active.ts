// First-party active-user counting, signed-out browsers (active-users plan r2 §1.2, r3 §B-§D, r4 §B', r4b, r4c3 and
// r4c3a; reviewed by astra, the grader and daybreak2).  Once per server day at most, after the page's first idle
// callback, a browser sends {"v":1,"day":1,"week":W,"month":M,"client":"web"} to consent.ts's ACTIVE_PATH, through
// its measure().  It keeps no identifier: only the instants at which the server's next UTC day, ISO week and month
// begin (from the server's own answer), and which population its last count was in.
//
// Two notes in one IndexedDB store (r4c3 §1), each with its own writers, every counting write inside the one Web Lock
// "sb-active", each holder's write committed before it lets the lock go, so the next holder's fresh transaction reads
// it (localStorage's per-process copy didn't: the C-3 finding):
//   "b"  {bd, bw, bm}  the browser's periods: written only when a signed-out ("b") answer is persisted
//   "a"  {p, ad}       the population, and the account's next day: written by persisted answers and signedOut()
// Nothing here runs before the first idle callback; nothing runs at all off MEASURE_ORIGINS (the desktop app and the
// CLI carry the same bundle and send nothing: William, Oct 31, "Not for now").

import { ACTIVE_PATH, dropLegacy, IDB_MS, mayMeasure, measure, notesTx, openNotes, removeNotes, wasWithdrawn } from "./consent.ts";

/** the desktop app and the CLI are not counted for now (William, Oct 31): no origin of theirs is listed */
export const COUNT_DESKTOP = false;
export const COUNT_CLI = false;
/** the only origins that count */
export const MEASURE_ORIGINS = ["https://sagebrush.space", "https://dev.sagebrush.space"];
/** a note not used for this long is dropped when the page next runs (13 months: William, Oct 31) */
export const NOTE_TTL_MS = 395 * 86_400_000;
const LOCK = "sb-active";
const FETCH_MS = 10_000, SIGNOUT_MS = 12_000;
const MAX = { nd: 86_400, nw: 7 * 86_400, nm: 31 * 86_400 };

type B = { bd: number; bw: number; bm: number };
type A = { p: "a" | "b"; ad: number };
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
// (a note of the wrong shape counts as absent: any non-number field reads 0)
type Any = { [k: string]: unknown } | null | undefined;
const readA = (x: unknown): A => { const v = x as Any; return { p: v?.p === "a" ? "a" : "b", ad: num(v?.ad) }; };
const readB = (x: unknown): B => { const v = x as Any; return { bd: num(v?.bd), bw: num(v?.bw), bm: num(v?.bm) }; };
const due = (a: A, b: B | null, t: number) => (a.p === "a" ? t >= a.ad : t >= (b?.bd ?? 0));
const stale = (b: B, t: number) => b.bd > 0 && t - b.bd > NOTE_TTL_MS;

/** The server's answer, accepted only in its exact shape. */
function answerOf(v: unknown): { as: "a" | "b"; nd: number; nw: number; nm: number } | null {
  const o = v as { [k: string]: unknown } | null | undefined;
  if (o?.as !== "a" && o?.as !== "b") return null;
  for (const k of ["nd", "nw", "nm"] as const) if (!Number.isInteger(o![k]) || (o[k] as number) <= 0 || (o[k] as number) > MAX[k]) return null;
  return o as { as: "a" | "b"; nd: number; nw: number; nm: number };
}

async function run(): Promise<void> {
  if (!MEASURE_ORIGINS.includes(location.origin)) return;
  await measure(ACTIVE_PATH, async (send) => {
    // (before the lock: no IndexedDB, or it can't be opened or read, means no count and no lock request)
    if (!self.indexedDB) return;
    const db = await openNotes(IDB_MS);
    if (!db) return;
    try {
      let pre = await notesTx(db, "readonly", IDB_MS, (s) => { const ra = s.get("a"), rb = s.get("b"); return () => [ra.result, rb.result]; });
      if (!pre) return;
      let a = readA(pre.v[0]);
      const b = a.p === "a" ? null : readB(pre.v[1]);
      if (!due(a, b, Date.now())) return; // (the counted path: no lock)
      const locks = navigator.locks;
      if (!locks) return; // (no Web Locks: not counted, never twice)
      await locks.request(LOCK, async () => {
        if (!mayMeasure()) return;
        dropLegacy();
        // (a fresh transaction after the grant: the TTL, and the probe that the store takes writes before anything is sent)
        const inl = await notesTx(db, "readwrite", IDB_MS, (s) => {
          const ra = s.get("a"), rb = s.get("b");
          rb.onsuccess = () => { if (stale(readB(rb.result), Date.now())) s.delete("b"); };
          s.put(1, "w");
          return () => [ra.result, rb.result];
        });
        if (!inl) return;
        const t = Date.now();
        a = readA(inl.v[0]);
        let bb = readB(inl.v[1]);
        if (stale(bb, t)) bb = { bd: 0, bw: 0, bm: 0 };
        if (!due(a, bb, t)) return; // (another tab counted while this one waited)
        if (!mayMeasure()) return; // (after the awaited transaction, immediately before the send)
        const body = JSON.stringify({ v: 1, day: 1, week: t >= bb.bw ? 1 : 0, month: t >= bb.bm ? 1 : 0, client: "web" });
        let ans: ReturnType<typeof answerOf> = null;
        try {
          const r = await send({ method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true, credentials: "same-origin", referrerPolicy: "no-referrer", cache: "no-store", signal: AbortSignal.timeout(FETCH_MS) });
          if (r.status !== 200) return; // (429, 503, …: nothing written; a later load tries again)
          ans = answerOf(await r.json());
        } catch {
          return;
        }
        if (!ans) return;
        if (!mayMeasure()) return;
        const at = Date.now(), as = ans.as, d = ans;
        // (both notes in one transaction, committed before the lock goes)
        const ok = await notesTx(db, "readwrite", IDB_MS, (s) => {
          if (as === "b") s.put({ bd: at + d.nd * 1000, bw: at + d.nw * 1000, bm: at + d.nm * 1000 }, "b");
          s.put(as === "b" ? { p: "b", ad: a.ad } : { p: "a", ad: at + d.nd * 1000 }, "a");
          return () => 1;
        });
        // (the fence: a withdrawal while this persisted, whichever transaction came first, leaves no note)
        if (ok && (wasWithdrawn() || !mayMeasure())) await removeNotes();
      });
    } finally {
      db.close();
    }
  });
}

/** For the page's sign-out (none on this page yet): the population becomes "b", inside the lock, so a held account
 * answer can't overwrite it.  One deadline, SIGNOUT_MS from the call, bounds the lock wait and the work inside it; on
 * a timeout, an error, no Web Locks or no IndexedDB it writes nothing (r4b §1, r4c3 §2).  Consent is checked on entry
 * (off: no lock, no IndexedDB) and again right before the put, after the waits (astra 4ce985ec). */
export async function signedOut(): Promise<void> {
  if (!mayMeasure()) return;
  const deadline = Date.now() + SIGNOUT_MS;
  const left = () => Math.max(0, Math.min(IDB_MS, deadline - Date.now()));
  try {
    const locks = navigator.locks;
    if (!locks || !self.indexedDB) return;
    await locks.request(LOCK, { signal: AbortSignal.timeout(SIGNOUT_MS) }, async () => {
      const db = await openNotes(left());
      if (!db) return;
      try {
        const ok = await notesTx(db, "readwrite", left(), (s) => {
          const ra = s.get("a");
          ra.onsuccess = () => { if (mayMeasure()) s.put({ p: "b", ad: readA(ra.result).ad }, "a"); };
          return () => 1;
        });
        if (ok && wasWithdrawn()) void removeNotes();
      } finally {
        db.close();
      }
    });
  } catch {
    // (settled, nothing written)
  }
}

// (top level: only the idle scheduling; nothing reads storage, takes the lock or fetches before it fires)
const start = () => { void run().catch(() => {}); };
if (self.requestIdleCallback) requestIdleCallback(start);
else setTimeout(start, FETCH_MS);
