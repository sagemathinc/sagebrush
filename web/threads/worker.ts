// The threads demo's worker (numerics-core r4.2, M0): one script, two roles, on one shared memory.
// - "helper" (threads 1..T-1): waits on the control word, runs its share of the job, counts in.
// - "conductor" (thread 0): fills the inputs, checks correctness, then times the job at each thread count. It is
//   a worker because a page's main thread may not block (Atomics.wait), and the job's thread 0 must wait for the others.
// Every job returns before anyone reads C (r4.2 §6). Failures never hang (E3): a helper that throws or traps
// records it and still counts in; a helper that dies outright is caught by the conductor's bounded wait (no
// helper finishing for STALL_MS fails the job); the page tears the pool down on any failure (page.ts).

type Exports = {
  __stack_pointer: WebAssembly.Global;
  nd_gemm_part(desc: number, id: number): number;
  nd_info(what: number): number; // 0 scratch length, 1 floor, 2 and 3 the microkernel name's address and length
};

// control words (Int32): [0] job generation (−1 = stop), [1] helpers done, [2] helper failures
const GEN = 0, DONE = 1, FAIL = 2;
// (no helper finishing for this long fails the job: far above any helper's share of the largest job here)
const STALL_MS = 15000;

function instantiate(module: WebAssembly.Module, memory: WebAssembly.Memory, stackTop: number): Exports {
  const ex = new WebAssembly.Instance(module, { env: { memory } }).exports as unknown as Exports;
  ex.__stack_pointer.value = stackTop;
  return ex;
}

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  if (m.role === "helper") helper(m);
  else if (m.role === "conductor") conductor(m);
};

// (fault: a test hook from the page's ?fault= (helper 1 only): "refuse", "throw", or "exit" after its first job)
function helper(m: { module: WebAssembly.Module; memory: WebAssembly.Memory; id: number; stackTop: number; ctl: number; desc: number; fault?: string }) {
  const ex = instantiate(m.module, m.memory, m.stackTop);
  const c = new Int32Array(m.memory.buffer, m.ctl, 4);
  let seen = Atomics.load(c, GEN);
  postMessage({ ready: m.id });
  const fault = m.id === 1 ? m.fault : undefined;
  for (let jobs = 0; ; jobs++) {
    Atomics.wait(c, GEN, seen);
    seen = Atomics.load(c, GEN);
    if (seen < 0) return;
    if (fault === "exit" && jobs > 0) {
      self.close(); // (a dead worker: it never counts in)
      return;
    }
    try {
      if (fault === "throw") throw new Error("injected failure");
      if (fault === "refuse" || !ex.nd_gemm_part(m.desc, m.id)) Atomics.add(c, FAIL, 1);
    } catch (e) {
      Atomics.add(c, FAIL, 1);
      postMessage({ helperError: `helper ${m.id}: ${String((e as Error)?.message ?? e)}` });
    } finally {
      Atomics.add(c, DONE, 1);
      Atomics.notify(c, DONE);
    }
  }
}

function conductor(init: { module: WebAssembly.Module; memory: WebAssembly.Memory; stackTop: number; ctl: number; desc: number; helpers: number }) {
  const t0 = performance.now();
  const ex = instantiate(init.module, init.memory, init.stackTop);
  const instantiateMs = performance.now() - t0;
  const mem = init.memory;
  const c = new Int32Array(mem.buffer, init.ctl, 4);
  const at = ex.nd_info(2);
  const microkernel = new TextDecoder().decode(new Uint8Array(mem.buffer).slice(at, at + ex.nd_info(3)));
  postMessage({ ready: 0, microkernel, instantiateMs, scratchLen: ex.nd_info(0), floor: ex.nd_info(1) });

  // one job: C = A * B with t threads (the pool's other helpers have nothing to do)
  const run = (lay: Layout, t: number) => {
    new Uint32Array(mem.buffer).set([lay.a, lay.b, lay.c, lay.n, lay.n, lay.n, t, lay.scratch, lay.scratchStride, lay.lo, lay.hi], init.desc / 4);
    Atomics.store(c, DONE, 0);
    Atomics.store(c, FAIL, 0);
    if (init.helpers > 0) {
      Atomics.add(c, GEN, 1);
      Atomics.notify(c, GEN);
    }
    const ok = ex.nd_gemm_part(init.desc, 0);
    // (wait on the very value just checked: re-reading it for the wait would lose a notify that lands between
    // the two reads; bounded: no helper finishing for STALL_MS fails the job instead of sleeping forever)
    let last = performance.now();
    for (let d, seenDone = -1; (d = Atomics.load(c, DONE)) < init.helpers; ) {
      if (d !== seenDone) {
        seenDone = d;
        last = performance.now();
      } else if (performance.now() - last > STALL_MS) {
        throw new Error(`a helper stopped responding (${d} of ${init.helpers} finished)`);
      }
      Atomics.wait(c, DONE, d, 100);
    }
    if (!ok) throw new Error("the kernel refused the job");
    if (Atomics.load(c, FAIL)) throw new Error(`${Atomics.load(c, FAIL)} helper(s) failed the job`);
  };

  self.onmessage = (ev: MessageEvent) => {
    const job = ev.data as { cmd: string; lay: Layout; threads: number[]; reps: number };
    if (job.cmd === "stop") {
      Atomics.store(c, GEN, -1);
      Atomics.notify(c, GEN);
      return;
    }
    try {
      postMessage(gemmJob(job.lay, job.threads, job.reps));
    } catch (e) {
      postMessage({ error: String((e as Error)?.message ?? e) });
    }
  };

  function gemmJob(lay: Layout, threads: number[], reps: number) {
    const n = lay.n, f64 = new Float64Array(mem.buffer);
    // seeded inputs, entries in [-1/2, 1/2): the same matrices for every thread count
    let s = 12345 >>> 0;
    const rnd = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296 - 0.5;
    for (let i = 0; i < n * n; i++) f64[lay.a / 8 + i] = rnd();
    for (let i = 0; i < n * n; i++) f64[lay.b / 8 + i] = rnd();
    // correctness first (M0's rule: no timing is shown unless this passes)
    const firstMs: Record<number, number> = {};
    postMessage({ progress: `first run, ${threads[0]} thread` });
    let f = performance.now();
    run(lay, threads[0]);
    firstMs[threads[0]] = performance.now() - f;
    const ref = f64.slice(lay.c / 8, lay.c / 8 + n * n);
    // sampled elements against a plain scalar sum; the bound is r4.2 §7's c k u |A||B| with |entries| <= 1/2
    let maxErr = 0, samples = 0;
    const step = Math.max(1, Math.floor(n / 23));
    for (let j = 0; j < n; j += step) for (let i = (j * 7) % step; i < n; i += step) {
      let r = 0;
      for (let p = 0; p < n; p++) r += f64[lay.a / 8 + p * n + i] * f64[lay.b / 8 + j * n + p];
      maxErr = Math.max(maxErr, Math.abs(r - ref[j * n + i]));
      samples++;
    }
    const bound = 10 * n * 2.220446049250313e-16 * (n / 4);
    const identical: Record<number, boolean> = {};
    for (const t of threads.slice(1)) {
      postMessage({ progress: `first run, ${t} threads` });
      f = performance.now();
      run(lay, t);
      firstMs[t] = performance.now() - f;
      const cur = f64.subarray(lay.c / 8, lay.c / 8 + n * n);
      let same = true;
      for (let i = 0; i < n * n && same; i++) same = Object.is(cur[i], ref[i]);
      identical[t] = same;
    }
    const correct = maxErr <= bound && Object.values(identical).every(Boolean);
    if (!correct) return { n, correct, maxErr, bound, samples, identical };
    // warm steady state: reps runs per thread count, interleaved round-robin so drift hits them all alike
    const times: Record<number, number[]> = Object.fromEntries(threads.map((t) => [t, []]));
    for (let r = 0; r < reps; r++) {
      for (const t of r % 2 ? [...threads].reverse() : threads) {
        const a = performance.now();
        run(lay, t);
        times[t].push(performance.now() - a);
      }
      if (r % 2 === 1 || r === reps - 1) postMessage({ progress: `timed round ${r + 1} of ${reps}` });
    }
    return { n, correct, maxErr, bound, samples, identical, firstMs, times };
  }
}

type Layout = { n: number; a: number; b: number; c: number; scratch: number; scratchStride: number; lo: number; hi: number };
