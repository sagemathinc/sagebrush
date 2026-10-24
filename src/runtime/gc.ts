// A full V8 collection, where the host allows one: Node only (Bun and Deno
// answer node:v8 with other engines' numbers; a browser worker has no such
// call).  Returns whether it collected.
//
// gc comes from a fresh context: a host started with --expose-gc already has
// it there, and its setting is left alone; otherwise the flag is set for that
// one context and cleared again, whatever happens, so no context made later
// gets gc (astra CORR-341-1).
export function fullGc(): boolean {
  try {
    const p = (globalThis as any).process;
    if (!p?.versions?.v8 || p.versions.bun || p.versions.deno) return false;
    const v8 = p.getBuiltinModule?.("node:v8");
    const vm = p.getBuiltinModule?.("node:vm");
    if (!v8 || !vm) return false;
    let gc = (globalThis as any).gc;
    if (typeof gc !== "function") gc = vm.runInNewContext("typeof gc === 'function' ? gc : undefined");
    if (typeof gc !== "function") {
      v8.setFlagsFromString("--expose-gc");
      try {
        gc = vm.runInNewContext("gc");
      } finally {
        v8.setFlagsFromString("--no-expose-gc");
      }
    }
    gc();
    return true;
  } catch {
    return false;
  }
}
