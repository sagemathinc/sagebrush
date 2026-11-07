// engine/nd's pool helper (threads r2): the one script every helper thread of the pool in nd.ts runs: in Node, a
// worker_threads Worker (the CLI carries it once, scripts/build-cli.mjs); written for a browser Worker too, for the
// notebook's step to come (PR 1b). It takes exactly one bootstrap from the pool that made it, {module, memory, id,
// stackTop, ctl, desc}: the SHA-256-checked module nd.ts compiled, the pool's shared memory, its participant id,
// the top of its stack slot, and the addresses of the control words and the job descriptor. It instantiates the
// module on that stack, counts itself ready, and then runs only nd_gemm_part(desc, id), once per job.
// A second bootstrap, or any malformed message, is refused: the helper marks the pool broken (when it knows the
// control words), says so, and stops; the pool then tears down (nd.ts).
// The control words (Int32, atomics only): GEN the job generation (< 0: stop), DONE helpers finished this job,
// FAIL helpers that failed it, READY helpers started, BROKEN a helper refused a message. Between jobs the helper
// waits for GEN to change, asynchronously where it can (so its messages are still read), else blocked; a job's
// failure (a refused descriptor, a throw or a trap) is counted in FAIL, and DONE always.
export {};

const GEN = 0, DONE = 1, FAIL = 2, READY = 3, BROKEN = 4;
// (test faults, from nd.ts's test hooks only: "exit" stops during the first job without counting in; "throw"
// fails each job; "late" sleeps `lateMs` in the first job, then writes a sentinel over C and its scratch slot;
// "silent" never counts itself ready)
const FAULTS = ["exit", "throw", "late", "silent"];
// (what a "late" helper writes: a value no test product can have)
const SENTINEL = -12345.25;

const g = globalThis as any;
const wt = g.process?.getBuiltinModule?.("worker_threads");
const port = wt?.parentPort ?? null;
const post = (m: unknown) => (port ? port.postMessage(m) : g.postMessage(m));
const stop = () => (port ? g.process.exit(0) : g.close());

type Boot = { module: WebAssembly.Module; memory: WebAssembly.Memory; id: number; stackTop: number; ctl: number; desc: number; fault?: string; lateMs?: number };

let booted = false;
let ctlWords: Int32Array | null = null;

function refuse(why: string) {
  if (ctlWords) {
    Atomics.store(ctlWords, BROKEN, 1);
    Atomics.notify(ctlWords, DONE);
  }
  post({ helperError: why });
  stop();
}

const word = (x: unknown, align: number) => typeof x === "number" && Number.isInteger(x) && x > 0 && x < 2 ** 32 && x % align === 0;

function onMessage(m: any) {
  if (booted) return refuse("the pool's helper takes one bootstrap only");
  booted = true;
  const ok = m && typeof m === "object" && m.module instanceof WebAssembly.Module && typeof m.memory?.grow === "function"
    && typeof SharedArrayBuffer === "function" && m.memory.buffer instanceof SharedArrayBuffer
    && Number.isInteger(m.id) && m.id >= 1 && m.id < 16 && word(m.stackTop, 16) && word(m.ctl, 64) && word(m.desc, 4)
    && m.ctl + 64 <= m.memory.buffer.byteLength && (m.fault === undefined || FAULTS.includes(m.fault))
    && (m.lateMs === undefined || (Number.isInteger(m.lateMs) && m.lateMs >= 0));
  if (!ok) return refuse("the pool's helper was sent a malformed bootstrap");
  return start(m as Boot);
}

function start(m: Boot) {
  const c = new Int32Array(m.memory.buffer, m.ctl, 16);
  ctlWords = c;
  let ex: any;
  try {
    ex = new WebAssembly.Instance(m.module, { env: { memory: m.memory } }).exports;
    ex.__stack_pointer.value = m.stackTop;
  } catch (e) {
    return refuse(`the pool's helper could not start: ${String((e as Error)?.message ?? e)}`);
  }
  let seen = Atomics.load(c, GEN);
  if (m.fault !== "silent") {
    Atomics.add(c, READY, 1);
    Atomics.notify(c, READY);
  }
  let jobs = 0;
  const job = () => {
    seen = Atomics.load(c, GEN);
    if (seen < 0) return false;
    const first = jobs++ === 0;
    if (m.fault === "exit" && first) {
      stop();
      return false;
    }
    try {
      if (m.fault === "throw") throw new Error("injected failure");
      if (m.fault === "late" && first) late(m);
      if (!ex.nd_gemm_part(m.desc, m.id)) Atomics.add(c, FAIL, 1);
    } catch {
      Atomics.add(c, FAIL, 1);
    } finally {
      Atomics.add(c, DONE, 1);
      Atomics.notify(c, DONE);
    }
    return true;
  };
  const waitAsync = (Atomics as any).waitAsync;
  if (typeof waitAsync === "function") {
    const next = () => {
      const w = waitAsync(c, GEN, seen);
      const go = () => job() && next();
      if (w.async) w.value.then(go);
      else go();
    };
    next();
  } else {
    for (;;) {
      Atomics.wait(c, GEN, seen);
      if (!job()) break;
    }
  }
}

// (the "late" fault: asleep past the caller's stall bound, then the sentinel over all of C and this helper's
// scratch slot, as a helper that could not be stopped in time would; the descriptor's words as nd_gemm_part reads them)
function late(m: Boot) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, m.lateMs ?? 0);
  const d = new Uint32Array(m.memory.buffer, m.desc, 11);
  const f64 = new Float64Array(m.memory.buffer);
  f64.fill(SENTINEL, d[2] / 8, d[2] / 8 + d[3] * d[4]);
  f64.fill(SENTINEL, (d[7] + m.id * d[8]) / 8, (d[7] + (m.id + 1) * d[8]) / 8);
}

if (port) port.on("message", onMessage);
else g.onmessage = (ev: MessageEvent) => onMessage(ev.data);
