// One reactive wave's in-run decisions, as one small pure policy (the waves
// design r3, §4): the reactive scheduler's per-cell loop (notebook-reactive.ts
// execute) makes, for each cell in turn, decisions that depend on what the
// cells before it did (the time budget from their actual times, a failure
// cancelling what depends on it, a Stop, an ancestor left stale).  A wave
// sends every cell of the action at once, so the gateway makes those
// decisions as it runs the entries, with this function, and the page replays
// it on the results the gateway returns: any difference is a protocol error.
//
// It is a transcription of the loop's checks, in the loop's order:
//   1. after a stop: stale, "interrupted";
//   2. an automatic entry over the budget (and no stale parent): stale, "budget";
//   3. the parents, in the graph's order: one that failed, was cancelled, or
//      blocks it from outside the wave (an error, an exception, a stop or a
//      cancellation found before the wave): cancelled; one that is stale:
//      stale, "ancestor";
//   4. a placeholder (a cell that is never sent: gone meanwhile, or not
//      approved for this action): nothing, or stale, "approval";
//   5. otherwise it runs; after it, its time counts (automatic ones), a stop
//      stops the rest, and a failure cancels its descendants.
// Everything the loop knows before the wave (a parent's state outside it,
// the descendants a failure cancels) is decided by the page and sent with
// each entry; nothing here reads anything else.

/** Why a cancelled cell didn't run (the scheduler's reasons). */
export type CancelWhy = "exception" | "error" | "interrupted";

/**
 * One of an entry's parents, in the graph's order, as the loop sees it: in
 * the wave (its index), or outside it: blocking it (a cell id and why), or
 * stale (held: a manual cell or one below it).  A parent outside the wave
 * that neither blocks nor is stale is not listed.
 */
export type WaveParent = { in: number } | { block: { by: string; why: CancelWhy } } | { stale: true };

/** What the policy reads of one entry. */
export interface WaveEntryPolicy {
  /** automatic (subject to the budget) or required */
  auto: boolean;
  /** its last time, ms (0 if never run): what the budget reads */
  est: number;
  /** its parents, in the graph's order (see WaveParent) */
  parents: readonly WaveParent[];
  /** the entries a failure or cancellation of it cancels (its descendants in the wave), each after it */
  desc: readonly number[];
  /**
   * a placeholder, never sent: "gone" (removed meanwhile: nothing happens), "approval" (not approved for this
   * action: stale, with `note`), or "never" (an ancestor outside the wave keeps it from running, so a decision
   * before step 4 always applies; if one ever didn't, it is stale, "ancestor", never run)
   */
  place?: "gone" | "approval" | "never";
  note?: string;
}

/** The wave's policy: the scheduler's budget (ms; 0 or less: none run automatically; null: no limit) and Run all's flag. */
export interface WavePolicy {
  budget: number | null;
  all: boolean;
}

/** An entry's decision, before it would run. */
export type WaveDecision =
  | { kind: "run" }
  | { kind: "gone" }
  | { kind: "stale"; why: "interrupted" | "budget" | "ancestor" | "approval"; note?: string }
  | { kind: "cancelled"; by: number | string; why: CancelWhy };

/** What a run that ran returns (the scheduler's ExecResult, as far as the policy reads it). */
export interface WaveRunResult {
  ok: boolean;
  ms: number;
  stopped?: boolean;
  interrupted?: boolean;
}

/** The decisions so far. */
export interface WaveState {
  stopped: boolean;
  autoMs: number;
  stale: Set<number>;
  blockedBy: Map<number, { by: number | string; why: CancelWhy }>;
}

export function newWaveState(): WaveState {
  return { stopped: false, autoMs: 0, stale: new Set(), blockedBy: new Map() };
}

const staleParent = (st: WaveState, p: WaveParent): boolean => ("in" in p ? st.stale.has(p.in) : "stale" in p);

/** Entry `k`'s decision, given every decision before it. */
export function waveDecide(policy: WavePolicy, st: WaveState, k: number, e: WaveEntryPolicy): WaveDecision {
  if (st.stopped) return { kind: "stale", why: "interrupted" };
  if (e.auto && !policy.all && policy.budget !== null && (policy.budget <= 0 || st.autoMs + e.est > policy.budget) && !e.parents.some((p) => staleParent(st, p))) {
    return { kind: "stale", why: "budget" };
  }
  let block = st.blockedBy.get(k);
  if (!block) {
    for (const p of e.parents) {
      if ("block" in p) {
        block = p.block;
        break;
      }
      if (staleParent(st, p)) return { kind: "stale", why: "ancestor" };
    }
  }
  if (block) return { kind: "cancelled", by: block.by, why: block.why };
  if (e.place === "gone") return { kind: "gone" };
  if (e.place === "approval") return { kind: "stale", why: "approval", ...(e.note ? { note: e.note } : {}) };
  if (e.place === "never") return { kind: "stale", why: "ancestor" };
  return { kind: "run" };
}

/**
 * A Stop the gateway latched while no entry was running (before the first, between two, during its preparation or
 * initial forget): every entry not yet decided is stale, "interrupted", as after a run that was stopped.  The
 * gateway sends it as a `stop` event naming the next entry (`before`), and the page replays it there.
 */
export function waveStop(st: WaveState): void {
  st.stopped = true;
}

/** Record entry `k`'s decision (and, for a run, its result): what the entries after it see. */
export function waveRecord(st: WaveState, k: number, e: WaveEntryPolicy, d: WaveDecision, result?: WaveRunResult): void {
  const cancel = (block: { by: number | string; why: CancelWhy }) => {
    for (const x of e.desc) if (!st.blockedBy.has(x)) st.blockedBy.set(x, block);
  };
  if (d.kind === "stale") st.stale.add(k);
  else if (d.kind === "cancelled") cancel({ by: d.by, why: d.why });
  else if (d.kind === "run") {
    const r = result ?? { ok: false, ms: 0 };
    if (e.auto) st.autoMs += r.ms;
    if (r.stopped) {
      st.stopped = true;
      if (!r.interrupted) st.stale.add(k);
    } else if (!r.ok) cancel({ by: k, why: "exception" });
  }
}

/**
 * A run entry's terminal outcome (the gateway's, as remote-kernel.js finish() reads it) as the scheduler's result:
 * ok; an error (KeyboardInterrupt: stopped, interrupted); anything else: stopped.
 */
export function waveRunResult(o: { status?: unknown; ms?: unknown; ename?: unknown } | null | undefined): WaveRunResult {
  const ms = typeof o?.ms === "number" && Number.isFinite(o.ms) ? o.ms : 0;
  if (o?.status === "ok") return { ok: true, ms };
  if (o?.status === "error") return o.ename === "KeyboardInterrupt" ? { ok: false, ms, stopped: true, interrupted: true } : { ok: false, ms };
  return { ok: false, ms: 0, stopped: true };
}

/** The same decision (the page's replay of the gateway's). */
export function sameDecision(a: WaveDecision, b: WaveDecision): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "stale" && b.kind === "stale") return a.why === b.why;
  if (a.kind === "cancelled" && b.kind === "cancelled") return a.by === b.by && a.why === b.why;
  return true;
}

/** The caps of one wave: over either, the page runs the action cell by cell instead (decided before anything is built). */
export const WAVE_CAPS = Object.freeze({ entries: 256 });

/**
 * A wave's entries, validated before anything runs (the gateway, and the page before it sends): each parent index
 * earlier than its entry, each descendant later, every index in range, every cell once, a placeholder with no code
 * and every other entry with its code, and at most WAVE_CAPS.entries.  null if valid, else why not.
 */
export function waveInvalid(entries: readonly (WaveEntryPolicy & { cell?: unknown; code?: unknown })[]): string | null {
  const n = entries.length;
  if (n > WAVE_CAPS.entries) return "too many entries";
  const cells = new Set<unknown>();
  for (let k = 0; k < n; k++) {
    const e = entries[k];
    if (!e || typeof e.cell !== "string" || cells.has(e.cell)) return "a cell missing or twice";
    cells.add(e.cell);
    if (typeof e.auto !== "boolean" || !Number.isFinite(e.est) || e.est < 0) return "an entry's policy";
    if (e.place !== undefined ? !["gone", "approval", "never"].includes(e.place) : typeof e.code !== "string") return "an entry's code";
    if (e.place !== undefined && e.code !== undefined) return "a placeholder with code";
    if (!Array.isArray(e.parents) || !Array.isArray(e.desc)) return "an entry's edges";
    for (const p of e.parents) {
      if (!p || typeof p !== "object") return "a parent";
      if ("in" in p) {
        if (!Number.isInteger(p.in) || p.in < 0 || p.in >= k) return "a parent not before its entry";
      } else if ("block" in p) {
        if (!p.block || typeof p.block.by !== "string" || !["exception", "error", "interrupted"].includes(p.block.why)) return "a parent's block";
      } else if (!("stale" in p) || p.stale !== true) return "a parent";
    }
    for (const d of e.desc) if (!Number.isInteger(d) || d <= k || d >= n) return "a descendant not after its entry";
  }
  return null;
}

const isNames = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * A whole wave as it is sent (the payload of a `kind: "wave"` submit), validated before anything is admitted, forgotten
 * or run: on the page before it sends, and by the gateway before any effect.  Every field the policy or the run reads
 * has its exact type (nothing is coerced into another scheduling decision): the policy's budget null or a finite
 * number and `all` a boolean; the initial forget and each entry's defs and forget arrays of names; a placeholder's note
 * a string; a run entry's mode, cell and code strings, its seed a string, its mangle a string or true, its scoped a
 * map of names; and the entries as waveInvalid.  null if valid, else why not.
 */
export function waveEnvelopeInvalid(w: unknown): string | null {
  if (!isPlain(w)) return "the wave's shape";
  if (typeof w.mode !== "string") return "the wave's mode";
  const p = w.policy;
  if (!isPlain(p) || typeof p.all !== "boolean" || !(p.budget === null || (typeof p.budget === "number" && Number.isFinite(p.budget)))) return "the wave's policy";
  if (!isNames(w.forget)) return "the wave's forget";
  if (!Array.isArray(w.entries)) return "the wave's entries";
  for (const e of w.entries as unknown[]) {
    if (!isPlain(e)) return "an entry's shape";
    if (!isNames(e.defs)) return "an entry's defs";
    if (e.note !== undefined && typeof e.note !== "string") return "an entry's note";
    if (e.place !== undefined) continue;
    if (typeof e.mode !== "string") return "an entry's mode";
    if (e.forget !== undefined && !isNames(e.forget)) return "an entry's forget";
    if (e.seed !== undefined && typeof e.seed !== "string") return "an entry's seed";
    if (e.mangle !== undefined && e.mangle !== true && typeof e.mangle !== "string") return "an entry's mangle";
    if (e.scoped !== undefined && !(isPlain(e.scoped) && Object.values(e.scoped).every((x) => typeof x === "string"))) return "an entry's scoped";
  }
  return waveInvalid(w.entries as (WaveEntryPolicy & { cell?: unknown; code?: unknown })[]);
}

/**
 * The exact size in UTF-8 bytes of JSON.stringify(v), counted without building it (no allocation, nothing charged):
 * the page's preflight of a wave's whole request against the client's body limit, before anything is frozen.  For
 * the JSON values a wave holds (objects, arrays, strings, finite numbers, booleans, null; undefined members skipped).
 */
export function jsonUtf8Bytes(v: unknown): number {
  if (v === null) return 4;
  if (typeof v === "boolean") return v ? 4 : 5;
  if (typeof v === "number") return Number.isFinite(v) ? String(v).length : 4;
  if (typeof v === "string") {
    let n = 2;
    for (let i = 0; i < v.length; i++) {
      const c = v.charCodeAt(i);
      if (c === 0x22 || c === 0x5c || c === 0x08 || c === 0x0c || c === 0x0a || c === 0x0d || c === 0x09) n += 2;
      else if (c < 0x20) n += 6;
      else if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff) {
        const d = i + 1 < v.length ? v.charCodeAt(i + 1) : 0;
        if (d >= 0xdc00 && d <= 0xdfff) { n += 4; i++; } else n += 6; // (a lone surrogate: JSON.stringify escapes it)
      } else if (c >= 0xdc00 && c <= 0xdfff) n += 6;
      else n += 3;
    }
    return n;
  }
  if (Array.isArray(v)) {
    let n = 2 + Math.max(0, v.length - 1);
    for (const x of v) n += x === undefined || typeof x === "function" ? 4 : jsonUtf8Bytes(x);
    return n;
  }
  if (typeof v === "object") {
    let n = 2, k = 0;
    for (const [key, x] of Object.entries(v as Record<string, unknown>)) {
      if (x === undefined || typeof x === "function") continue;
      n += (k++ ? 1 : 0) + jsonUtf8Bytes(key) + 1 + jsonUtf8Bytes(x);
    }
    return n;
  }
  return 0;
}
