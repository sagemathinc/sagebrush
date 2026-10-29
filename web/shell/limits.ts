// The shell's limits (plan-bash-shell r3 §4, erratum r8c E2; step 3): the `bash` config, its immutable
// ranges, its validation before the worker is ready, and what each key becomes in the pinned just-bash
// 3.6.0's executionLimits.
//
// The census is exact: 18 keys in three classes.
// - A, own computation: off (null, the default) by default, passed to just-bash as exactly +Infinity, so just-bash's own
//   defaults (1 hour, 100,000 commands, 100,000 loop iterations, 100,000,000 work units) never apply.
// - B, memory guards: on.
// - C, shared resources: on, cumulative per run.
// Who enforces each key (step 3's explicit exception, @sagebrush's amended ruling of Oct 28, astra2's wording):
// - "page" or "module": the 12 keys whose limit is a typed outcome: terminal, exit 125 and `bash: <key> exceeded
//   (<value>)`, HostOutcome row 4, non-refundable accounting and the workspace fence.
// - "upstream": the 6 keys just-bash itself enforces (commands, loop_iterations, work_units, memory_bytes,
//   call_depth, glob_paths). They keep the pinned upstream scope and command behaviour and are ORDINARY outcomes:
//   never promised to stop the whole invocation (sed and awk convert the error; shell control flow can continue,
//   even to exit 0), and no limit key is ever inferred from their text.
// output_bytes (@sagebrush's FINAL ruling, Oct 28: proposal C, with astra5's conditions; astra5 c3848925, daybreak2
// d5bcdf0b, daybreak3's binding):
// - just-bash's maxOutputSize is OUTPUT_BACKSTOP (32 MiB), a fixed constant: its output collector (which checks only
//   maxOutputSize) keeps a finite aggregate bound.  It is a RESULT cap, not a heap guarantee (neither is memory_bytes).
// - Below it, output_bytes is typed.  The module (optional/bash/src/shell.js) counts each result in exact UTF-8,
//   stdout then stderr, in the worker; keeps only the scalar-boundary prefix within the invocation's remaining
//   allowance; and sends, beside it, a structured {producedBytes, deliveredBytes, exceeded}: producedBytes the whole
//   result's size, deliveredBytes the prefix's (<= the allowance), exceeded the module's own flag.  The full result
//   never crosses to the page.  The page checks the delivered strings against deliveredBytes, charges deliveredBytes
//   (the ledger's charge), and types `exceeded` as row 4, which latches the run: every later invocation of it is
//   refused, even when the scalar boundary left part of the allowance unused.
// - A result that would pass the backstop is just-bash's own stop, an ordinary exit (126) that is never classified or
//   attributed to any key: the OUTPUT-BACKSTOP EXCEPTION, beside the six-key exception.
// - So the typed range is per invocation: output_bytes (default 64 MiB) is cumulative across a run's invocations, and
//   each invocation's output is typed only up to the backstop (one invocation of more than 32 MiB is the ordinary 126).
// - The transfer is one message of at most min(the remaining allowance, OUTPUT_BACKSTOP).  daybreak2's chunked pull/ack
//   transport (<= 64 KiB chunks) is its own later step, and daybreak2 must clear the transfer and heap gates before
//   any UI surface delivers large outputs.

export type LimitKey =
  | "script_ms" | "commands" | "loop_iterations" | "work_units" | "invocations"
  | "memory_bytes" | "output_bytes" | "call_depth" | "source_bytes" | "pipeline_width" | "glob_paths" | "list_entries" | "read_bytes" | "write_bytes"
  | "ops" | "cp_entries" | "cp_bytes" | "written_bytes";
type Range = Readonly<{ cls: "A" | "B" | "C"; def: number | null; min: number; max: number; scope: "invocation" | "run"; by: "page" | "module" | "upstream" }>;

const KiB = 1024, MiB = 2 ** 20, GiB = 2 ** 30;
/** The workspace's largest file (web/workspace/api.ts LIMITS.maxFileBytes, which a test checks this equals): read_bytes'
 * and write_bytes' upper bound.  A constant here, so this module needs nothing of the workspace. */
export const MAX_FILE_BYTES = 200 * MiB;
/** The ranges (r3 §4.2): immutable, in core.  An admin picks values only within them. */
export const BASH_RANGES: Readonly<Record<LimitKey, Range>> = Object.freeze({
  script_ms: Object.freeze({ cls: "A", def: null, min: 1000, max: 604_800_000, scope: "run", by: "page" }),
  commands: Object.freeze({ cls: "A", def: null, min: 1, max: 1e9, scope: "invocation", by: "upstream" }),
  loop_iterations: Object.freeze({ cls: "A", def: null, min: 1, max: 1e9, scope: "invocation", by: "upstream" }),
  work_units: Object.freeze({ cls: "A", def: null, min: 1, max: 1e12, scope: "invocation", by: "upstream" }),
  invocations: Object.freeze({ cls: "A", def: null, min: 1, max: 1e6, scope: "run", by: "page" }),
  memory_bytes: Object.freeze({ cls: "B", def: 256 * MiB, min: 16 * MiB, max: GiB, scope: "invocation", by: "upstream" }),
  output_bytes: Object.freeze({ cls: "B", def: 64 * MiB, min: 64 * KiB, max: 512 * MiB, scope: "run", by: "page" }),
  call_depth: Object.freeze({ cls: "B", def: 100, min: 8, max: 200, scope: "invocation", by: "upstream" }),
  source_bytes: Object.freeze({ cls: "B", def: MiB, min: KiB, max: 16 * MiB, scope: "invocation", by: "page" }),
  pipeline_width: Object.freeze({ cls: "B", def: 16, min: 2, max: 64, scope: "invocation", by: "module" }),
  glob_paths: Object.freeze({ cls: "B", def: 20_000, min: 100, max: 100_000, scope: "invocation", by: "upstream" }),
  list_entries: Object.freeze({ cls: "B", def: 10_000, min: 100, max: 100_000, scope: "invocation", by: "page" }),
  read_bytes: Object.freeze({ cls: "B", def: 64 * MiB, min: 64 * KiB, max: MAX_FILE_BYTES, scope: "invocation", by: "page" }),
  write_bytes: Object.freeze({ cls: "B", def: 64 * MiB, min: 64 * KiB, max: MAX_FILE_BYTES, scope: "invocation", by: "page" }),
  ops: Object.freeze({ cls: "C", def: 10_000, min: 1, max: 100_000, scope: "run", by: "page" }),
  cp_entries: Object.freeze({ cls: "C", def: 10_000, min: 1, max: 100_000, scope: "run", by: "page" }),
  cp_bytes: Object.freeze({ cls: "C", def: GiB, min: 0, max: 16 * GiB, scope: "run", by: "page" }),
  written_bytes: Object.freeze({ cls: "C", def: 2 * GiB, min: 0, max: 64 * GiB, scope: "run", by: "page" }),
});
export const LIMIT_KEYS = Object.freeze(Object.keys(BASH_RANGES) as LimitKey[]);
/** The config's largest serialized size (r3 §4.1). */
export const CONFIG_MAX_BYTES = 4 * KiB;
/**
 * (r3, astra5 B3R2-A5-1: declared before any module-level call uses it: MAPPED_LIMITS below calls
 * executionLimitsOf() at load, and a const read before its declaration is a TDZ ReferenceError in native ESM.)
 * The host's wrapper around every script it sends (D8 point 1: `{ SCRIPT\n}`, web/shell/host.ts wrap()): its bytes.
 * The page checks bash.source_bytes on the script itself; just-bash's maxSourceBytes, which checks the script exec()
 * is given (the wrapped script), is the key plus these bytes, so a script at the key's value runs.  It does NOT
 * bound a sourced file: the pinned just-bash checks maxSourceBytes in exec() and transform() only, and its `source`
 * and `.` parse what they read with no size check (PR 279's first CI).  A sourced file is a read, bounded by
 * bash.read_bytes, typed (@sagebrush's ruling A); source_bytes bounds only the script the page sends.
 */
export const WRAPPER_BYTES = 4;
export const wrap = (script: string) => `{ ${script}\n}`;
/** just-bash's maxOutputSize: one invocation's output bound, and its result's largest copy (proposal C). */
export const OUTPUT_BACKSTOP = 32 * MiB;

/** Every key resolved: a number, or null for an own-computation key that is off. */
export type BashLimits = Readonly<Record<LimitKey, number | null>>;

/** A config refused before the worker is ready, naming its key (or "the config" for its size or shape). */
export class BashConfigError extends Error {
  constructor(readonly key: string, message: string) {
    super(message);
    this.name = "BashConfigError";
  }
}

/**
 * The `bash` config validated against BASH_RANGES (r3 §4.1): each refusal names its key.
 * - an unknown key;
 * - a non-integer;
 * - a value outside its range;
 * - null for a key that isn't own computation (class B or C);
 * - a config over 4 KiB (serialized as JSON, UTF-8).
 * Absent keys take their defaults; undefined or null means every default.
 */
export function validateBash(cfg: unknown): BashLimits {
  const out = {} as Record<LimitKey, number | null>;
  for (const k of LIMIT_KEYS) out[k] = BASH_RANGES[k].def;
  if (cfg === undefined || cfg === null) return Object.freeze(out);
  if (typeof cfg !== "object" || Array.isArray(cfg) || Object.getPrototypeOf(cfg) !== Object.prototype) throw new BashConfigError("bash", "bash: the config is a JSON object of named keys");
  let text: string;
  try {
    text = JSON.stringify(cfg);
  } catch {
    throw new BashConfigError("bash", "bash: the config isn't JSON");
  }
  if (new TextEncoder().encode(text).length > CONFIG_MAX_BYTES) throw new BashConfigError("bash", `bash: the config is over ${CONFIG_MAX_BYTES} bytes`);
  for (const [k, v] of Object.entries(cfg as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(BASH_RANGES, k)) throw new BashConfigError(k, `bash.${k}: an unknown key`);
    const r = BASH_RANGES[k as LimitKey];
    if (v === null) {
      if (r.cls !== "A") throw new BashConfigError(k, `bash.${k}: null (off) is only for own-computation keys`);
      out[k as LimitKey] = null;
      continue;
    }
    if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new BashConfigError(k, `bash.${k}: not an integer`);
    if (v < r.min || v > r.max) throw new BashConfigError(k, `bash.${k}: ${v} is outside [${r.min}, ${r.max}]`);
    out[k as LimitKey] = v;
  }
  return Object.freeze(out);
}

const off = (v: number | null) => (v === null ? Number.POSITIVE_INFINITY : v);

/**
 * What the config becomes in just-bash's executionLimits (r3 §4.2's "enforced by" column), sent once in the
 * worker's init message.  maxExecutionTimeMs here is the key's off-or-whole value; each invocation's own (the
 * run's remaining script_ms) is sent with it (EXEC_LIMITS).  Every other just-bash limit stays at its "normal"
 * profile value (FIXED_LIMITS).
 */
export function executionLimitsOf(b: BashLimits): Readonly<Record<string, number>> {
  const mem = b.memory_bytes!, depth = b.call_depth!, glob = b.glob_paths!;
  return Object.freeze({
    maxExecutionTimeMs: off(b.script_ms),
    maxCommandCount: off(b.commands),
    maxLoopIterations: off(b.loop_iterations),
    maxAwkIterations: off(b.loop_iterations),
    maxSedIterations: off(b.loop_iterations),
    maxJqIterations: off(b.loop_iterations),
    maxWorkUnits: off(b.work_units),
    maxLiveBytes: mem,
    maxInputBytes: mem,
    maxStringLength: mem,
    maxHeredocSize: mem,
    // (proposal C: just-bash's own output bound is the fixed backstop; output_bytes is the module's and the page's)
    maxOutputSize: OUTPUT_BACKSTOP,
    maxCallDepth: depth,
    maxSourceDepth: depth,
    maxExecDepth: depth,
    maxSubstitutionDepth: Math.min(depth, 50),
    maxSourceBytes: b.source_bytes! + WRAPPER_BYTES,
    // (both from glob_paths; only the brace side has a measured boundary (host-cases.js BOUNDARIES.glob_paths), the
    // glob side's is an open measurement)
    maxGlobOperations: glob,
    maxBraceExpansionResults: glob,
  });
}
/** The executionLimits names an invocation may set for itself (the run's remaining time); the module takes no other. */
export const EXEC_LIMITS = Object.freeze(["maxExecutionTimeMs"]);
/**
 * just-bash 3.6.0's other limits, left at its "normal" profile (r3 §4.2 "Fixed, not keys"): its parser, query, CSV,
 * archive, traversal and runtime limits.  With MAPPED below, the census of the pinned package's limits is exact: the
 * module reports its resolved limits at init, and the tests compare their names against both lists.
 */
export const FIXED_LIMITS = Object.freeze([
  "maxQueryTokens", "maxQueryDepth", "maxQueryElements", "maxAwkParserTokens", "maxAwkParserDepth", "maxAwkParserOperations",
  "maxCsvRows", "maxCsvCells", "maxTraversalEntries", "maxTraversalDepth", "maxTraversalWork", "maxFileSystemBytes",
  "maxDatabaseBytes", "maxDatabaseResultBytes", "maxArchiveBytes", "maxArchiveCompressedBytes", "maxArchiveEntryBytes",
  "maxArchiveEntries", "maxWorkerMessageBytes", "maxExtensionCleanupTimeMs", "maxSqliteTimeoutMs", "maxPythonTimeoutMs",
  "maxJsTimeoutMs", "maxJsBridgeRequests", "maxArrayElements", "maxFileDescriptors",
]);
export const MAPPED_LIMITS = Object.freeze(Object.keys(executionLimitsOf(validateBash(undefined))));

/** A limit reached: the outcome row 4 (r3 §4.1), with the words the script ends with. */
export const limitWords = (key: LimitKey, value: number) => `bash: bash.${key} exceeded (${value})\n`;
/** The exit status of a typed limit (r3 §4.1). */
export const LIMIT_EXIT = 125;
