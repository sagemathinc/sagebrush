// The memory of retired WebAssembly instances, still charged until it is freed (design note sklearn-trees r3 §6,
// LIMITS' L2), for the runtime's own modules other than the engine: the decision-tree kernel
// (src/runtime/skltree.ts).  The same mechanism as the engine's retired instances (src/runtime/engine.ts, R_ret:
// addPending, collected, retire), kept here as a class so that a module's debt is its own:
// - a retired instance's bytes are its memory.buffer.byteLength after the last read of it, frozen at retirement;
// - they stay pending until BOTH its WebAssembly.Memory and that last ArrayBuffer are collected (two
//   FinalizationRegistry callbacks, whose held values are the id only, never the targets);
// - a sum that would not be exact fails closed: from then on the debt is reported as unbounded (`overflow`), and
//   nothing is ever subtracted again;
// - without FinalizationRegistry nothing is removed, and the debt only grows: conservative.

const MAX_SAFE = 2 ** 53 - 1;

interface Pending {
  bytes: number;
  memoryGone: boolean;
  bufferGone: boolean;
}

/** How a target's collection is reported: register(target, id, kind) arranges collected(id, kind). */
export type Register = (target: object, id: number, kind: "memory" | "buffer") => void;

export class RetiredDebt {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  /** The pending bytes (exact while !overflow). */
  sum = 0;
  /** Sticky: a sum that would not have been exact; the debt is then unbounded. */
  overflow = false;
  private readonly register: Register | null;

  /** `register`: the finalizers (the tests pass their own; by default a FinalizationRegistry pair of this debt's). */
  constructor(register?: Register | null) {
    if (register !== undefined) this.register = register;
    else {
      const FR = (globalThis as any).FinalizationRegistry;
      if (typeof FR !== "function") this.register = null;
      else {
        const mem = new FR((id: number) => this.collected(id, "memory"));
        const buf = new FR((id: number) => this.collected(id, "buffer"));
        this.register = (target, id, kind) => (kind === "memory" ? mem : buf).register(target, id);
      }
    }
  }

  /** Charge a retired instance's memory until both it and its last buffer are collected.  The caller has
   * finished every read of the instance, and drops every reference to it after this. */
  retire(memory: WebAssembly.Memory) {
    const buffer = memory.buffer;
    const id = this.nextId++;
    const p: Pending = { bytes: buffer.byteLength, memoryGone: false, bufferGone: false };
    this.pending.set(id, p);
    if (this.sum + p.bytes > MAX_SAFE) this.overflow = true;
    else this.sum += p.bytes;
    if (this.register) {
      this.register(memory, id, "memory");
      this.register(buffer, id, "buffer");
    }
  }

  /** A finalizer fired: the entry goes once both have; repeats and unknown ids are no-ops. */
  collected(id: number, kind: "memory" | "buffer") {
    const p = this.pending.get(id);
    if (!p) return;
    if (kind === "memory") p.memoryGone = true;
    else p.bufferGone = true;
    if (!(p.memoryGone && p.bufferGone)) return;
    this.pending.delete(id);
    if (!this.overflow) this.sum -= p.bytes;
  }

  /** The debt to charge: exact, or unbounded (Infinity) once a sum has overflowed. */
  bytes(): number {
    return this.overflow ? Infinity : this.sum;
  }

  /** The retired instances still pending (for the tests). */
  get count(): number {
    return this.pending.size;
  }
}
