// Room in a WebAssembly kernel's memory for one call (kernels.ts's modules, engine/nd's in nd.ts), under the project's
// rule: which code runs comes only from the input and fixed limits; the memory the computer can give decides only run
// or refuse, and nothing falls back on its own (William, Nov 25 2026). So a call whose workspace (the input's arrays
// and the layout's fixed overhead, counted exactly) is past the memory's FIXED maximum (wasm32's 65536 pages, or the
// module's declared maximum if lower) is refused before any grow, and so is a grow below it that the computer refuses:
// a MemoryError for that call, naming the workspace and the bytes, never the JavaScript path. Nothing is kept: the
// next call grows again.
//
// The one explicit exception is the low-memory flag (SAGEBRUSH_LOW_MEMORY=1, read once per session: lowMemory()),
// which an agent or a person sets before starting a session. It enables only reviewed lower-memory routes, each
// chosen up front from the input, fixed limits and the flag, never by catching a failure: engine/nd is not used (the
// TypeScript code, nd.ts), and a kernel whose workspace is past its memory's fixed maximum takes its JavaScript path
// (kernels.ts). Results may differ slightly from upstream's (last bits). A refusal names the flag only where it would
// have given the call such a route.

export const WASM32_MAX_BYTES = 65536 * 65536;

const ADVICE = "use the native app on a computer with more memory";
const FLAG_ADVICE =
  "to try reviewed lower-memory routes (results may differ slightly from upstream), start a new session with SAGEBRUSH_LOW_MEMORY=1; or " + ADVICE;

let latched: boolean | null = null;
/** Whether the low-memory flag is set for this session: SAGEBRUSH_LOW_MEMORY=1 in the environment (the CLI, the native
 *  app) or globalThis.__SAGEBRUSH_LOW_MEMORY__ (a host's session setting), read at the first use and kept: a later
 *  change takes effect only in a new session. */
export function lowMemory(): boolean {
  if (latched === null) {
    const g = globalThis as any;
    latched = g.__SAGEBRUSH_LOW_MEMORY__ === true || g.process?.env?.SAGEBRUSH_LOW_MEMORY === "1";
  }
  return latched;
}

// The advice a refusal ends with: the flag where it would give the call a lower-memory route and isn't set already.
const advice = (flagHelps: boolean) => (flagHelps && !lowMemory() ? FLAG_ADVICE : ADVICE);

/** Whether a failure setting up or growing a WebAssembly module's memory is memory the computer couldn't give (a
 *  RangeError, or an engine's own words: a thrown "out of memory", a CompileError for executable memory): never an
 *  answer about the engine's features. */
export function memoryFailure(e: unknown): boolean {
  return e instanceof RangeError || /out of (executable )?memory/i.test(String((e as any)?.message ?? e));
}

/** The refusal for a module whose setup the computer had no memory for (object.ts makes it a MemoryError);
 *  `flagHelps`: the low-memory flag would avoid the module (engine/nd). */
export const setupRefusal = (what: string, flagHelps = false) =>
  new RangeError(`WebAssembly kernel workspace: ${what} could not be set up (more than the computer could give); ${advice(flagHelps)}`);

// The fixed maximum for a memory declared up to `declared` bytes. (The tests stub a smaller one, as a fixed limit,
// with globalThis.__SAGEBRUSH_KERNEL_MAX_BYTES__)
function fixedMax(declared: number): number {
  const stub = (globalThis as any).__SAGEBRUSH_KERNEL_MAX_BYTES__;
  return typeof stub === "number" && stub < declared ? stub : declared;
}

/** The low-memory flag's route for a kernel whose workspace is past its memory's fixed maximum: thrown by growTo
 *  before any grow, and answered by the kernel's caller with its JavaScript path (kernels.ts jsAbove). */
export const USE_JS = Symbol("the low-memory flag's JavaScript route");

/** How the low-memory flag bears on a memory's grows: "past-max", a kernel with a JavaScript path past its fixed
 *  maximum (kernels.ts); "always", a module the flag avoids altogether (engine/nd); "none", no lower-memory route
 *  (argsort, whose JavaScript path keeps its indices in a JavaScript array). */
export type FlagRoute = "past-max" | "always" | "none";

/** Make `mem` at least `bytes` long, or throw a RangeError naming the workspace (object.ts makes it a MemoryError):
 *  past the memory's fixed maximum (`declared` bytes, or a stubbed smaller one) before any grow, or when the computer
 *  refuses the grow. With the low-memory flag, past the maximum a "past-max" kernel throws USE_JS instead. */
export function growTo(mem: WebAssembly.Memory, bytes: number, declared = WASM32_MAX_BYTES, route: FlagRoute = "past-max"): void {
  const max = fixedMax(declared);
  // (a size past 2**53 is no exact count: past every maximum)
  if (!Number.isSafeInteger(bytes) || bytes > max) {
    if (route === "past-max" && lowMemory()) throw USE_JS;
    const need = Number.isSafeInteger(bytes) ? `${bytes} bytes` : "more than 2**53 bytes";
    throw new RangeError(`WebAssembly kernel workspace: needs ${need}, past its memory's maximum of ${max} bytes; ${advice(route !== "none")}`);
  }
  const have = mem.buffer.byteLength;
  if (have >= bytes) return;
  const pages = Math.ceil((bytes - have) / 65536);
  try {
    mem.grow(pages);
  } catch (e) {
    if (e instanceof RangeError) {
      throw new RangeError(
        `WebAssembly kernel workspace: could not grow by ${pages * 65536} bytes (more than the computer could give); ${advice(route === "always")}`);
    }
    throw e;
  }
}
