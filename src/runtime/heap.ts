// The session's heap, for memory guards that must scale with it.

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
