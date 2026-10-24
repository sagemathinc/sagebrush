// `sagebrush board open --edit`'s caps (plan-board-open-edit r7 §8.1): 26
// values, each with a unit, a default, an inclusive range that can't be
// changed, and the place it is enforced.  Each can be set with
// `--limit NAME=VALUE` or `SAGEBRUSH_BOARD_OPEN_<NAME>` (the flag wins).  All
// are parsed first, then validated as one set before the server listens:
// refused, with the reason, for an unknown name, a name given twice in the
// same source, a value that isn't an integer, one out of its range, or a
// cross-field check failing (BODY_MAX <= EDIT_MAX <= FILE_MAX;
// SAVE_QUIET_MS <= SAVE_MAX_DELAY_MS; MEMORY_MAX >= 8 x EDIT_MAX;
// MERGE_WORK >= 8 x EDIT_MAX, so that a submission's per-byte phases fit (daybreak3, Oct 24: with MERGE_WORK's
// default 2.5e8 and MERGE_MS's 10 s; MERGE_WORK's range [8 x 64 KiB, 8 x 128 MiB], so that both its
// range and EDIT_MAX's stay reachable); MEMORY_MAX >= 36 x BODY_MAX, so that a body of BODY_MAX bytes is never too
// large for the ledger as such, addendum 2; QUEUE_BYTES <= MEMORY_MAX / 2).
// MEMORY_MAX's default is 1 GiB (addendum 2: 512 MiB in r7's table).

const KiB = 1024, MiB = 1024 * KiB, GiB = 1024 * MiB;

/** A cap: its unit, default and range (a bound may name another cap, checked once all are known). */
export interface Cap { name: string; unit: string; def: number; min: number | string; max: number | string; at: string }

export const CAPS: readonly Cap[] = [
  { name: "FILE_MAX", unit: "bytes", def: 128 * MiB, min: KiB, max: 128 * MiB, at: "reading FILE" },
  { name: "EDIT_MAX", unit: "bytes", def: 16 * MiB, min: KiB, max: "FILE_MAX", at: "Edit offered; each outside version; each head" },
  { name: "RECORDS_MAX", unit: "records", def: 50_000, min: 100, max: 500_000, at: "as EDIT_MAX" },
  { name: "BODY_MAX", unit: "bytes", def: 16 * MiB, min: 64 * KiB, max: "EDIT_MAX", at: "/edit, streamed" },
  { name: "MEMORY_MAX", unit: "bytes", def: GiB, min: 64 * MiB, max: 8 * GiB, at: "the ledger, before every admission" },
  { name: "HISTORY_PATCHES", unit: "patches", def: 2_000, min: 100, max: 100_000, at: "the hub's history window; compaction" },
  { name: "MERGE_MS", unit: "ms", def: 10_000, min: 100, max: 60_000, at: "one merge, all its phases" },
  { name: "MERGE_WORK", unit: "work units", def: 250_000_000, min: 524_288, max: 1_073_741_824, at: "the cumulative ledger of one merge" },
  { name: "QUEUE_MAX", unit: "requests", def: 64, min: 1, max: 1_024, at: "the merge queue" },
  { name: "QUEUE_BYTES", unit: "bytes", def: 64 * MiB, min: MiB, max: "MEMORY_MAX/2", at: "the merge queue's bodies" },
  { name: "SAVE_QUIET_MS", unit: "ms", def: 1_000, min: 100, max: 60_000, at: "the page's autosave; the server's coalescing" },
  { name: "SAVE_MAX_DELAY_MS", unit: "ms", def: 5_000, min: "SAVE_QUIET_MS", max: 300_000, at: "as SAVE_QUIET_MS" },
  { name: "WRITE_MIN_MS", unit: "ms", def: 500, min: 50, max: 60_000, at: "the write queue" },
  { name: "WRITE_RETRY_MS", unit: "ms", def: 10_000, min: 0, max: 60_000, at: "a failing rename or link" },
  { name: "INVALID_HOLD_MS", unit: "ms", def: 30_000, min: 1_000, max: 3_600_000, at: "an invalid FILE, before it may be saved over" },
  { name: "EXIT_FLUSH_MS", unit: "ms", def: 3_000, min: 0, max: 60_000, at: "the exit flush" },
  { name: "MAX_CLIENTS", unit: "tabs", def: 16, min: 1, max: 256, at: "/events" },
  { name: "PENDING_MAX", unit: "bytes", def: 64 * KiB, min: 4 * KiB, max: 16 * MiB, at: "each tab's event backlog" },
  { name: "TAB_RATE", unit: "requests/s", def: 20, min: 1, max: 1_000, at: "per tab, a token bucket" },
  { name: "GLOBAL_RATE", unit: "requests/s", def: 200, min: 1, max: 10_000, at: "all /edit and /board requests, a token bucket" },
  { name: "RESP_CONCURRENCY", unit: "responses", def: 4, min: 1, max: 64, at: "concurrent /board?at= bodies" },
  { name: "BACKUPS_MAX", unit: "files", def: 8, min: 1, max: 64, at: "prev, .bak and leftover files beside FILE" },
  { name: "CONFLICTS_MAX", unit: "alternatives", def: 200, min: 10, max: 10_000, at: "per tab, and per report batch" },
  { name: "ACKS_KEPT", unit: "ops per tab", def: 64, min: 8, max: 1_024, at: "the accepted-op records" },
  { name: "SAVES_KEPT", unit: "saves", def: 16, min: 1, max: 256, at: "the retained saves" },
  { name: "TAB_TOMBSTONES", unit: "tombstones", def: 1_024, min: 16, max: 65_536, at: "released tabs' watermarks" },
];

export type Limits = Record<string, number>;
export const ENV_PREFIX = "SAGEBRUSH_BOARD_OPEN_";

/** The defaults. */
export const defaultLimits = (): Limits => Object.fromEntries(CAPS.map((c) => [c.name, c.def]));

/** Parse `--limit NAME=VALUE` arguments and the environment, then validate the whole set: the limits, or why not. */
export function resolveLimits(flags: string[], env: Record<string, string | undefined>): { limits: Limits } | { error: string } {
  const byName = new Map(CAPS.map((c) => [c.name, c]));
  const parse = (source: string, entries: [string, string][]): Map<string, number> | string => {
    const out = new Map<string, number>();
    for (const [name, text] of entries) {
      if (!byName.has(name)) return `${source}: unknown limit ${name} (known: ${CAPS.map((c) => c.name).join(", ")})`;
      if (out.has(name)) return `${source}: ${name} given twice`;
      if (!/^(0|[1-9][0-9]*)$/.test(text.trim())) return `${source}: ${name}=${text} is not a whole number`;
      const v = Number(text.trim());
      if (!Number.isSafeInteger(v)) return `${source}: ${name}=${text} is too large`;
      out.set(name, v);
    }
    return out;
  };
  const flagEntries: [string, string][] = [];
  for (const f of flags) {
    const m = /^([A-Z_]+)=(.*)$/.exec(f);
    if (!m) return { error: `--limit ${f}: expected NAME=VALUE` };
    flagEntries.push([m[1], m[2]]);
  }
  const envEntries: [string, string][] = Object.entries(env).filter(([k, v]) => k.startsWith(ENV_PREFIX) && v !== undefined).map(([k, v]) => [k.slice(ENV_PREFIX.length), v as string]);
  const fromFlags = parse("--limit", flagEntries);
  if (typeof fromFlags === "string") return { error: fromFlags };
  const fromEnv = parse("the environment", envEntries);
  if (typeof fromEnv === "string") return { error: fromEnv };
  const limits = defaultLimits();
  for (const [k, v] of fromEnv) limits[k] = v;
  for (const [k, v] of fromFlags) limits[k] = v; // (the flag wins)
  const bound = (b: number | string) => (typeof b === "number" ? b : b.endsWith("/2") ? Math.floor(limits[b.slice(0, -2)] / 2) : limits[b]);
  for (const c of CAPS) {
    const v = limits[c.name], lo = bound(c.min), hi = bound(c.max);
    if (v < lo || v > hi) return { error: `${c.name}=${v} is out of its range [${typeof c.min === "string" ? c.min + " = " + lo : lo}, ${typeof c.max === "string" ? c.max + " = " + hi : hi}] (${c.unit})` };
  }
  if (limits.MEMORY_MAX < 8 * limits.EDIT_MAX) return { error: `MEMORY_MAX=${limits.MEMORY_MAX} must be at least 8 x EDIT_MAX (${8 * limits.EDIT_MAX})` };
  if (limits.MERGE_WORK < 8 * limits.EDIT_MAX) return { error: `MERGE_WORK=${limits.MERGE_WORK} must be at least 8 x EDIT_MAX (${8 * limits.EDIT_MAX}), so that an edit of a board EDIT_MAX allows fits its work` };
  if (limits.MEMORY_MAX < 36 * limits.BODY_MAX) return { error: `MEMORY_MAX=${limits.MEMORY_MAX} must be at least 36 x BODY_MAX (${36 * limits.BODY_MAX})` };
  return { limits };
}

/** The caps as `board open --help` lists them. */
export function limitsHelp(): string {
  const show = (b: number | string) => (typeof b === "string" ? b : b >= MiB && b % MiB === 0 ? `${b / MiB} MiB` : b >= KiB && b % KiB === 0 ? `${b / KiB} KiB` : String(b));
  return CAPS.map((c) => `    ${c.name.padEnd(18)} ${show(c.def).padStart(9)}  [${show(c.min)}, ${show(c.max)}] ${c.unit}`).join("\n");
}
