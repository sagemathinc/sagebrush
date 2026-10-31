// First-party active-user counting, signed-out browsers (active-users plan r2 §1.2, r3 §B-§D, r4 §B', r4b; reviewed by
// astra, the grader and daybreak2).  Once per server day at most, after the page's first idle callback, a browser sends
// {"v":1,"day":1,"week":W,"month":M,"client":"web"} to /api/active, through consent.ts's measure().  It keeps no
// identifier: only the instants at which the server's next UTC day, ISO week and month begin (from the server's own
// answer), and which population its last count was in.
//
// Two keys, each with its own writers (r4 §B'), every write inside the one Web Lock "sb-active":
//   sb-active-b  {bd, bw, bm}  the browser's periods: written only when a signed-out ("b") answer is persisted
//   sb-active    {p, ad}       the population, and the account's next day: written by persisted answers and signedOut()
// Nothing here runs before the first idle callback; nothing runs at all off MEASURE_ORIGINS (the desktop app and the
// CLI carry the same bundle and send nothing: William, Oct 31, "Not for now").

import { afterNoteWrite, mayMeasure, measure } from "./consent.ts";

/** the desktop app and the CLI are not counted for now (William, Oct 31): no origin of theirs is listed */
export const COUNT_DESKTOP = false;
export const COUNT_CLI = false;
/** the only origins that count */
export const MEASURE_ORIGINS = ["https://sagebrush.space", "https://dev.sagebrush.space"];
/** a note not used for this long is dropped when the page next runs (13 months: William, Oct 31) */
export const NOTE_TTL_MS = 395 * 86_400_000;
const LOCK = "sb-active", KEY_A = "sb-active", KEY_B = "sb-active-b";
const FETCH_MS = 10_000, SIGNOUT_LOCK_MS = 12_000;
const MAX = { nd: 86_400, nw: 7 * 86_400, nm: 31 * 86_400 };

type B = { bd: number; bw: number; bm: number };
type A = { p: "a" | "b"; ad: number };
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
function readJson(k: string): Record<string, unknown> | null {
  const s = localStorage.getItem(k);
  if (s === null) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
const readA = (): A => { const v = readJson(KEY_A); return { p: v?.p === "a" ? "a" : "b", ad: num(v?.ad) }; };
const readB = (): B => { const v = readJson(KEY_B); return { bd: num(v?.bd), bw: num(v?.bw), bm: num(v?.bm) }; };
const due = (a: A, b: B | null, t: number) => (a.p === "a" ? t >= a.ad : t >= (b?.bd ?? 0));

/** The server's answer, accepted only in its exact shape. */
function answerOf(v: unknown): { as: "a" | "b"; nd: number; nw: number; nm: number } | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.as !== "a" && o.as !== "b") return null;
  for (const k of ["nd", "nw", "nm"] as const) if (!Number.isInteger(o[k]) || (o[k] as number) <= 0 || (o[k] as number) > MAX[k]) return null;
  return o as { as: "a" | "b"; nd: number; nw: number; nm: number };
}

async function run(): Promise<void> {
  if (!MEASURE_ORIGINS.includes(globalThis.location?.origin ?? "")) return;
  await measure("/api/active", async (send) => {
    // (pre-lock: the counted path, which takes no lock)
    const t0 = Date.now();
    let a = readA();
    const b = a.p === "a" ? null : readB();
    if (!due(a, b, t0)) return;
    const locks = (globalThis.navigator as Navigator | undefined)?.locks;
    if (!locks) return; // (no Web Locks: not counted, never twice)
    await locks.request(LOCK, async () => {
      if (!mayMeasure()) return;
      const t = Date.now();
      a = readA();
      let bb = readB();
      // (a note unused for NOTE_TTL_MS goes, inside the lock as every write: the browser counts as new)
      if (bb.bd > 0 && t - bb.bd > NOTE_TTL_MS) {
        localStorage.removeItem(KEY_B);
        bb = { bd: 0, bw: 0, bm: 0 };
      }
      if (!due(a, bb, t)) return; // (another tab counted while this one waited)
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
      // (persist, in one synchronous step: consent again, then the writes, then the cross-tab withdrawal check)
      if (!mayMeasure()) return;
      const at = Date.now();
      if (ans.as === "b") {
        localStorage.setItem(KEY_B, JSON.stringify({ bd: at + ans.nd * 1000, bw: at + ans.nw * 1000, bm: at + ans.nm * 1000 }));
        localStorage.setItem(KEY_A, JSON.stringify({ p: "b", ad: a.ad }));
      } else {
        localStorage.setItem(KEY_A, JSON.stringify({ p: "a", ad: at + ans.nd * 1000 }));
      }
      afterNoteWrite();
    });
  });
}

/** For the page's sign-out (none on this page yet): the population becomes "b", inside the lock, so a held account
 * answer can't overwrite it.  On a lock timeout, an error or no Web Locks it writes nothing (r4b §1). */
export async function signedOut(): Promise<void> {
  try {
    const locks = (globalThis.navigator as Navigator | undefined)?.locks;
    if (!locks) return;
    await locks.request(LOCK, { signal: AbortSignal.timeout(SIGNOUT_LOCK_MS) }, async () => {
      const a = readA();
      localStorage.setItem(KEY_A, JSON.stringify({ p: "b", ad: a.ad }));
      afterNoteWrite();
    });
  } catch {
    // (settled, nothing written)
  }
}

// (top level: only the idle scheduling; nothing reads storage, takes the lock or fetches before it fires)
const start = () => { void run().catch(() => {}); };
if (typeof globalThis.requestIdleCallback === "function") globalThis.requestIdleCallback(start);
else globalThis.setTimeout?.(start, FETCH_MS);
