// Live data (design-data-access r3.1 §1, "The engine boundary"): the one
// operation by which Python asks the page for data fetched live, the FRED
// series of a reader's own key.  It is closed: a named operation with a
// closed, bounded parameter object, never a URL, a header, a body or a key,
// and a bounded structured answer, never raw upstream text.  The key stays in
// the page, which attaches it after admission (web/notebook/live-data.js);
// Python and the engine Worker never see it.
//
// The worker posts {id, target, liveData: {op, params, key}, buffer} and waits
// on its own SharedArrayBuffer, as input() does (src/stdin-wait.ts): Int32 [0]
// the state (0 waiting, 1 an answer), [1] the answer's length in bytes, then
// its UTF-8 JSON.  `key` (this worker's tag and a count) correlates an answer
// with its request; it authorizes nothing.  A Stop wins over an answer, and
// the wait is bounded (LIVE_DEADLINE_MS).  Both sides check everything here:
// the worker before it posts, and the page's admission again on the raw
// message, as no message is trusted.

export const LIVE_OPS = ["fred.series_observations"] as const;
export type LiveOp = (typeof LIVE_OPS)[number];
export type LiveParams = { series_id: string; observation_start?: string; observation_end?: string };
// The closed error codes; anything else an answer says is `unavailable`
export const LIVE_ERRORS = ["no_key", "not_in_catalog", "rate_limited", "unavailable", "timeout", "interrupted"] as const;
const isError = (e: unknown): e is LiveError => {
  for (const x of LIVE_ERRORS) if (x === e) return true;
  return false;
};
export type LiveError = (typeof LIVE_ERRORS)[number];
export type LiveAnswer = { ok: { dates: string[]; values: (number | null)[] } } | { error: LiveError };

export const LIVE_MAX_POINTS = 200_000;
export const LIVE_MAX_BYTES = 8 << 20;
// The relay's 30 s, and a margin for the page; scaled for slow test machines
export const LIVE_DEADLINE_MS = 35_000;

const SERIES_ID = /^[A-Za-z0-9_]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PARAM_NAMES = new Set(["series_id", "observation_start", "observation_end"]);

const plain = (o: unknown): o is Record<string, unknown> => o !== null && typeof o === "object" && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype;

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** A real calendar date, YYYY-MM-DD (the Gregorian calendar's days in each month). */
function isDate(s: unknown): s is string {
  if (typeof s !== "string" || !DATE.test(s)) return false;
  const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return m >= 1 && m <= 12 && d >= 1 && d <= DAYS[m - 1] + (m === 2 && leap ? 1 : 0);
}

/** The operation's parameters, checked and copied (own fields only), or the
 * reason they're refused. */
export function checkParams(op: unknown, params: unknown): { params: LiveParams } | { refused: string } {
  if (op !== "fred.series_observations") return { refused: "unknown operation" };
  if (!plain(params)) return { refused: "the parameters must be an object" };
  for (const k of Object.keys(params)) if (!PARAM_NAMES.has(k)) return { refused: `unknown parameter ${JSON.stringify(k.slice(0, 64))}` };
  const id = params.series_id;
  if (typeof id !== "string" || !SERIES_ID.test(id)) return { refused: "series_id must be 1 to 64 letters, digits or underscores" };
  const out: LiveParams = { series_id: id };
  for (const k of ["observation_start", "observation_end"] as const) {
    if (!Object.hasOwn(params, k)) continue;
    if (!isDate(params[k])) return { refused: `${k} must be a date, YYYY-MM-DD` };
    out[k] = params[k] as string;
  }
  return { params: out };
}

/** An answer, checked against the closed form and its bounds: anything else
 * is `unavailable` (never a partial series, never upstream text). */
export function checkAnswer(a: unknown): LiveAnswer {
  if (!plain(a)) return { error: "unavailable" };
  const keys = Object.keys(a);
  if (keys.length !== 1) return { error: "unavailable" };
  if (keys[0] === "error") return isError(a.error) ? { error: a.error as LiveError } : { error: "unavailable" };
  if (keys[0] !== "ok" || !plain(a.ok)) return { error: "unavailable" };
  const ok = a.ok;
  if (Object.keys(ok).length !== 2 || !Array.isArray(ok.dates) || !Array.isArray(ok.values)) return { error: "unavailable" };
  const { dates, values } = ok as { dates: unknown[]; values: unknown[] };
  if (dates.length !== values.length || dates.length > LIVE_MAX_POINTS) return { error: "unavailable" };
  for (let i = 0; i < dates.length; i++) {
    if (!isDate(dates[i])) return { error: "unavailable" };
    const v = values[i];
    if (v !== null && (typeof v !== "number" || !Number.isFinite(v))) return { error: "unavailable" };
  }
  return { ok: { dates: dates as string[], values: values as (number | null)[] } };
}

/** The answer's bytes in `buffer` (8 + LIVE_MAX_BYTES): written once, as
 * input()'s line is; false if the buffer was answered already. */
export function writeAnswer(buffer: SharedArrayBuffer, a: LiveAnswer): boolean {
  const ctl = new Int32Array(buffer, 0, 2);
  if (Atomics.load(ctl, 0) !== 0) return false;
  let bytes = new TextEncoder().encode(JSON.stringify(a));
  if (bytes.length > buffer.byteLength - 8) bytes = new TextEncoder().encode(JSON.stringify({ error: "unavailable" }));
  new Uint8Array(buffer, 8, bytes.length).set(bytes);
  Atomics.store(ctl, 1, bytes.length);
  Atomics.store(ctl, 0, 1);
  Atomics.notify(ctl, 0);
  return true;
}

/** Wait for the answer in `buffer`; `intr` is the shared interrupt word.  A
 * Stop wins (also over an answer landing during the same wait); past
 * `deadlineMs` it is a timeout.  The answer is checked again here. */
export function waitForAnswer(buffer: SharedArrayBuffer, intr: Int32Array, deadlineMs: number, now: () => number = () => Date.now(), sliceMs = 100): LiveAnswer {
  const ctl = new Int32Array(buffer, 0, 2);
  const stopped = () => (Atomics.load(intr, 0) & 1) !== 0;
  const end = now() + deadlineMs;
  for (;;) {
    if (stopped()) return { error: "interrupted" };
    if (Atomics.load(ctl, 0) !== 0) break;
    const left = end - now();
    if (left <= 0) return { error: "timeout" };
    Atomics.wait(ctl, 0, 0, Math.min(sliceMs, left));
  }
  if (stopped()) return { error: "interrupted" };
  const n = Atomics.load(ctl, 1);
  if (!(n > 0 && n <= buffer.byteLength - 8)) return { error: "unavailable" };
  try {
    return checkAnswer(JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, n).slice())));
  } catch {
    return { error: "unavailable" };
  }
}
