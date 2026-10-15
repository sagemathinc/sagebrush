// The Stop button in wasm: runs an ignored test of sagebrush-hmf built for
// wasm32-wasip1 with the host interrupt import, answers the host's polls
// with Stop after a delay, and reports how often the host was polled and
// how soon the computation trapped after Stop.
//
//     cargo test -p sagebrush-hmf --release --lib --target wasm32-wasip1 \
//         --features sagebrush-interrupt/wasm-host --no-run
//     node engine/hmf/tests/wasm-stop.mjs <the .wasm> stop_search 300
//     node engine/hmf/tests/wasm-stop.mjs <the .wasm> stop_class_set 300
//     node engine/hmf/tests/wasm-stop.mjs <the .wasm> field::tests::stop_factor 300
//     node engine/hmf/tests/wasm-stop.mjs <the .wasm> defnew::tests::stop_newspaces 300
//
// and for sagebrush-arith (cargo test -p sagebrush-arith ... with the same
// options):
//
//     node engine/hmf/tests/wasm-stop.mjs <its .wasm> nmod_mat::tests::stop_hessenberg_recurrence 300
//
// The gap after the last poll counts too (tailGapMs), and a run that goes
// on past the Stop time without polling again fails (stopObserved false):
// daybreak HARD-FE6-1.
// (a test name without a module path is one of classes::tests).
// Exit status 0 if the computation trapped within 100 ms of Stop and, after
// the first poll's start-up interval (setting up the field and the order,
// and compiling), the host was polled at least every 20 ms; 1 otherwise.
import { readFile } from 'node:fs/promises';
import { WASI } from 'node:wasi';
import { performance } from 'node:perf_hooks';

const [wasmPath, test, delayArg] = process.argv.slice(2);
const delay = Number(delayArg ?? 300);
const wasi = new WASI({ version: 'preview1', args: ['t', test, '--ignored', '--nocapture', '--test-threads=1', '--exact', test.includes('::') ? test : `classes::tests::${test}`], env: {}, preopens: {} });
const mod = await WebAssembly.compile(await readFile(wasmPath));
let t0 = null, stopAt = null, last = null, maxGap = 0, polls = 0;
const gaps = [];
const sagebrush = {
  interrupted() {
    const now = performance.now();
    if (t0 === null) t0 = now;
    if (last !== null && stopAt === null) {
      maxGap = Math.max(maxGap, now - last);
      gaps.push([+(now - last).toFixed(2), +(last - t0).toFixed(1)]);
    }
    last = now;
    polls++;
    if (now - t0 >= delay) {
      if (stopAt === null) stopAt = now;
      return 1;
    }
    return 0;
  },
};
const inst = await WebAssembly.instantiate(mod, { ...wasi.getImportObject(), sagebrush });
let trapped = false;
try {
  wasi.start(inst);
} catch (e) {
  trapped = e instanceof WebAssembly.RuntimeError;
  if (!trapped) throw e;
}
const end = performance.now();
const latency = stopAt === null ? null : end - stopAt;
// the time since the last poll (unbounded if the run never polls again)
const tail = last === null ? null : end - last;
const ranPastStop = t0 !== null && end - t0 > delay;
const stopObserved = !ranPastStop || stopAt !== null;
const startup = gaps.length ? gaps[0][0] : null;
const steady = gaps.slice(1);
maxGap = steady.reduce((m, g) => Math.max(m, g[0]), 0);
if (stopAt === null && tail !== null) maxGap = Math.max(maxGap, tail);
steady.sort((a, b) => b[0] - a[0]);
console.log(JSON.stringify({ test, polls, startupGapMs: startup, maxGapMs: +maxGap.toFixed(3), largestGapsAt: steady.slice(0, 3), stopAfterMs: delay, trapped, stopObserved, tailGapMs: tail === null ? null : +tail.toFixed(3), latencyMs: latency === null ? null : +latency.toFixed(3) }));
process.exit(stopObserved && trapped && latency !== null && latency < 100 && maxGap < 20 && (startup ?? 0) < 100 ? 0 : 1);
