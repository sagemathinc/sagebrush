// The session's heap, for memory guards that must scale with it.
import { raise, T } from "./object";
import { fullGc } from "./gc";

// The old generation this process can grow to, in bytes: what long-lived
// values (a matrix, its operands) must fit in.  --max-old-space-size (on
// the command line or in NODE_OPTIONS) says it exactly.  Otherwise V8's
// heap_size_limit, which adds a young generation whose size varies by
// version: for --max-old-space-size=96, Node 22 reports 144 MiB, Node 26
// 192 and Node 24 288, and a budget taken from it admitted on GitHub's
// Node 24 what the VMs refused.  Without the flag, a limit of at most 1 GiB
// is taken as a third old space, a larger one less 256 MiB; Chrome's
// jsHeapSizeLimit likewise; a nominal 1 GiB when the host cannot say.
function oldSpaceFlag(): number | null {
  const g: any = globalThis;
  const args = [...(g.process?.execArgv ?? []), ...String(g.process?.env?.NODE_OPTIONS ?? "").split(/\s+/)];
  let mib: number | null = null;
  for (let i = 0; i < args.length; i++) {
    const m = /^--max[-_]old[-_]space[-_]size(?:=(\d+))?$/.exec(String(args[i]));
    if (m) {
      const v = Number(m[1] ?? args[i + 1]);
      if (Number.isFinite(v) && v > 0) mib = v;
    }
  }
  return mib === null ? null : mib * 2 ** 20;
}

// (read once: the figure is fixed for the isolate, and Bun's
// getHeapStatistics takes about 12 ms a call, so reading it at every
// conversion of a big int made micropython's int_big_div time out there)
let cached = 0;
export function heapLimit(): number {
  return (cached ||= readHeapLimit());
}
function readHeapLimit(): number {
  const g: any = globalThis;
  const flag = oldSpaceFlag();
  if (flag !== null) return flag;
  let n: any = null;
  try {
    n = g.process?.getBuiltinModule?.("node:v8")?.getHeapStatistics?.().heap_size_limit;
  } catch {
    // (no v8 module: not Node)
  }
  if (!(typeof n === "number" && n > 0)) n = g.performance?.memory?.jsHeapSizeLimit;
  if (!(typeof n === "number" && n > 0)) return 2 ** 30;
  return n <= 2 ** 30 ? Math.floor(n / 3) : n - 2 ** 28;
}

// The heap in use now, in bytes, where the host says: Node's used_heap_size
// (not Bun's or Deno's, which report another engine's), a browser's
// usedJSHeapSize (coarse: Chromium buckets it unless started with precise
// memory info); null where it cannot say.
function readUsedHeap(): number | null {
  const g: any = globalThis;
  try {
    const p = g.process;
    if (p?.versions?.v8 && !p.versions.bun && !p.versions.deno) {
      const n = p.getBuiltinModule?.("node:v8")?.getHeapStatistics?.().used_heap_size;
      return typeof n === "number" && n >= 0 ? n : null;
    }
    const n = g.performance?.memory?.usedJSHeapSize;
    return typeof n === "number" && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/** What admitHeap reads, replaceable by tests (test/admit-heap.test.ts): the heap in use, and one full collection. */
export const heapProbe = { used: readUsedHeap, collect: fullGc };

// A large request is at least this part of the limit: only those read the
// host's figures (Bun's statistics cost about 12 ms a call), and where the
// host gives none, one may take at most a quarter of the limit.
export const LARGE_PART = 64;
export const UNKNOWN_PART = 4;

/** Admit an allocation of about `need` bytes at its peak, before it starts
 * (#956), or raise MemoryError, so that as far as the host's figures show, a
 * large request doesn't run the heap out:
 * - `need` against the whole limit first, as every guard did;
 * - a large `need` (limit/64 or more) against the heap free now: the host's
 *   figure for the heap in use, and if that leaves too little, one full
 *   collection (Node) and the figure again; where the host gives no figure,
 *   at most a quarter of the limit.
 * The free heap is a best reading, not a proof: a browser's figure is coarse,
 * and other live values may grow after. `what` names the work in the
 * message, as "converting an int of about 1234 digits". */
export function admitHeap(need: number, what: string): void {
  const limit = heapLimit();
  const mb = (n: number) => Math.ceil(n / 2 ** 20);
  if (need > limit) raise(T.MemoryError, `${what} needs about ${mb(need)} MiB, more than this session's ${mb(limit)} MiB`);
  if (need < limit / LARGE_PART) return;
  let used = heapProbe.used();
  if (used === null) {
    if (need > limit / UNKNOWN_PART)
      raise(T.MemoryError, `${what} needs about ${mb(need)} MiB, more than a quarter of this session's ${mb(limit)} MiB (this host doesn't say how much of it is free)`);
    return;
  }
  if (used + need <= limit) return;
  if (heapProbe.collect()) {
    const after = heapProbe.used();
    if (after !== null) used = after;
    if (used + need <= limit) return;
  }
  // (the free figure rounded down, so it always reads below the need it was compared with)
  raise(T.MemoryError, `${what} needs about ${mb(need)} MiB, but this session's heap has only about ${Math.floor(Math.max(0, limit - used) / 2 ** 20)} MiB free (of ${mb(limit)} MiB)`);
}
