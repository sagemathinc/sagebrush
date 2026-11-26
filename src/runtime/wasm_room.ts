// Room in a WebAssembly kernel's memory for one call (kernels.ts's modules, engine/nd's in nd.ts), under the project's
// rule: which code runs comes only from the input and fixed limits; the memory the computer can give decides only run
// or refuse, and nothing falls back on its own (William, Nov 25 2026). So a call whose workspace (the input's arrays
// and the layout's fixed overhead, counted exactly) is past the memory's FIXED maximum (wasm32's 65536 pages, or the
// module's declared maximum if lower) is refused before any grow, and so is a grow below it that the computer refuses:
// a MemoryError for that call, naming the workspace and the bytes, never the JavaScript path. Nothing is kept: the
// next call grows again. (A lower-memory route an agent or person asks for explicitly is a later, separate flag.)

export const WASM32_MAX_BYTES = 65536 * 65536;

const ADVICE = "use the native app on a computer with more memory";

/** Whether a failure setting up or growing a WebAssembly module's memory is memory the computer couldn't give (a
 *  RangeError, or an engine's own words: a thrown "out of memory", a CompileError for executable memory): never an
 *  answer about the engine's features. */
export function memoryFailure(e: unknown): boolean {
  return e instanceof RangeError || /out of (executable )?memory/i.test(String((e as any)?.message ?? e));
}

/** The refusal for a module whose setup the computer had no memory for (object.ts makes it a MemoryError). */
export const setupRefusal = (what: string) =>
  new RangeError(`WebAssembly kernel workspace: ${what} could not be set up (more than the computer could give); ${ADVICE}`);

// The fixed maximum for a memory declared up to `declared` bytes. (The tests stub a smaller one, as a fixed limit,
// with globalThis.__SAGEBRUSH_KERNEL_MAX_BYTES__)
function fixedMax(declared: number): number {
  const stub = (globalThis as any).__SAGEBRUSH_KERNEL_MAX_BYTES__;
  return typeof stub === "number" && stub < declared ? stub : declared;
}

/** Make `mem` at least `bytes` long, or throw a RangeError naming the workspace (object.ts makes it a MemoryError):
 *  past the memory's fixed maximum (`declared` bytes, or a stubbed smaller one) before any grow, or when the computer
 *  refuses the grow. */
export function growTo(mem: WebAssembly.Memory, bytes: number, declared = WASM32_MAX_BYTES): void {
  const max = fixedMax(declared);
  // (a size past 2**53 is no exact count: past every maximum)
  if (!Number.isSafeInteger(bytes) || bytes > max) {
    const need = Number.isSafeInteger(bytes) ? `${bytes} bytes` : "more than 2**53 bytes";
    throw new RangeError(`WebAssembly kernel workspace: needs ${need}, past its memory's maximum of ${max} bytes; ${ADVICE}`);
  }
  const have = mem.buffer.byteLength;
  if (have >= bytes) return;
  const pages = Math.ceil((bytes - have) / 65536);
  try {
    mem.grow(pages);
  } catch (e) {
    if (e instanceof RangeError) {
      throw new RangeError(`WebAssembly kernel workspace: could not grow by ${pages * 65536} bytes (more than the computer could give); ${ADVICE}`);
    }
    throw e;
  }
}
