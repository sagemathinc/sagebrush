// A board question's check (WorkerKernel.evaluate) given to an interpreter
// that never takes it up (a worker that never answers): given up within its
// bound, nothing left pending, rather than holding its Check, and the queue
// behind it, for good (daybreak2's HARD-729-1).
//   bun web/notebook/test-kernel-evaluate.mjs
import { WorkerKernel } from "./worker-kernel.js";

let fails = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails++; };
globalThis.__sbEvaluateStartMs = 300;
const silent = () => ({ postMessage() {}, terminate() {}, onmessage: null, onerror: null });
const k = new WorkerKernel({ createWorker: silent });
k.start();
const t0 = Date.now();
const r = await k.evaluate("True", 1, "python", 1000);
const took = Date.now() - t0;
check(!r.ok && /did not take it up/.test(r.error ?? ""), "a check never taken up: given up, saying so: " + JSON.stringify(r));
check(took < 2000, `within its bound (${took} ms)`);
check(k.pending.size === 0, "nothing left pending");
// (a computed hint, given the hints' shared deadline: given up by it, not
// after the 30 s wait, daybreak2's HARD-729-1 at 88302973)
globalThis.__sbEvaluateStartMs = 30_000;
const t1 = Date.now();
const h = await k.evaluate("'a hint'", 1, "python", 5000, Date.now() + 250);
const took1 = Date.now() - t1;
check(!h.ok && took1 < 1500, `a computed hint never taken up: given up by its deadline (${took1} ms): ` + JSON.stringify(h));
check(k.pending.size === 0, "nothing left pending after it either");
k.close?.();
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
