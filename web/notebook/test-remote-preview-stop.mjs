// The preview's Stop (the simulated gateway, remote-ui.js PreviewGateway): a Stop while a Run runs on the preview's
// interpreter ends that run when the interpreter says it stopped, not at the Stop, so a Run asked after it is
// delivered only then, never into the interpreter's fallback (WorkerKernel.interrupt's restart, which stops every
// run pending there).  On a stub interpreter whose stop the test releases by hand (no timers):
//   P1 a held stop: the interrupt acknowledged, Run 2 not delivered and run 1 without a terminal until the release;
//      then exactly one terminal for run 1 (KeyboardInterrupt), and Run 2 ends "second";
//   P2 the fallback instead (every pending run told stopped at once): run 1 interrupted once, Run 2 ends "second";
//   P3 a Stop on a run admitted but not yet delivered: no interrupt of the interpreter, and its one terminal.
// (waves, epoch, acknowledgement and an idle Stop: the existing cases, test-remote-kernel.mjs and the browser test)
// Run by test-remote-kernel.mjs: runPreviewStopTests(check).

import { page } from "./test-remote-gate.mjs";
import { PreviewGateway } from "./remote-ui.js";

// (an interpreter: runs one at a time, in order; "hold" runs until the test releases them; the others print their
// word and end on their own, a turn later)
function stubLocal() {
  const s = {
    pending: [], executed: [], interrupts: 0,
    start() {}, close() {}, restart() {},
    execute(code, opts, sink) { s.executed.push(code); s.pending.push({ code, sink }); s.next(); },
    next() {
      const c = s.pending[0];
      if (!c || c.started) return;
      c.started = true;
      if (/hold/.test(code(c))) return;
      queueMicrotask(() => {
        const m = /print\('(\w+)'\)/.exec(code(c));
        if (m) c.sink.out(`${m[1]}\n`);
        s.end(c, () => c.sink.done(1, {}));
      });
    },
    end(c, f) { s.pending.splice(s.pending.indexOf(c), 1); f(); s.next(); },
    interrupt() { s.interrupts++; },
    // (the held run stops, as its KeyboardInterrupt does)
    release() { const c = s.pending[0]; s.end(c, () => c.sink.stopped()); },
    // (WorkerKernel.interrupt's fallback: a restart, every run pending told stopped)
    fallback() { for (const c of s.pending.splice(0)) c.sink.stopped(); },
  };
  const code = (c) => c.code;
  return s;
}

const settle = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0)); };
// (a bounded wait: code that never ends a run fails the case instead of leaving it waiting)
const ended = (x) => Promise.race([x, (async () => { for (let i = 0; i < 20; i++) await settle(); })()]);
const runOf = (p, word) => [...p.fake.runs.values()].find((r) => r.code?.includes(word));
const terminals = (run) => (run?.events ?? []).filter((e) => e.type === "terminal");
const interruptPosts = (p) => p.fake.calls.filter(([m, path]) => m === "POST" && /\/interrupt$/.test(path)).length;

export async function runPreviewStopTests(check) {
  let n = 0;
  for (const [name, how] of [["P1", "release"], ["P2", "fallback"]]) {
    n++;
    const local = stubLocal();
    const p = await page([["a", "hold = 1"], ["b", "print('second')"]], { gateway: new PreviewGateway(local) });
    const first = p.gesture(["a"]);
    const second = p.gesture(["b"]);
    await settle();
    const delivered1 = local.executed.length === 1 && /hold/.test(local.executed[0]);
    p.kernel.interrupt();
    await settle();
    const run1 = runOf(p, "hold");
    const before = { acked: interruptPosts(p) === 1 && local.interrupts === 1, notDelivered: !local.executed.some((c) => c.includes("second")), noTerminal: !run1?.outcome };
    local[how]();
    await ended(Promise.all([first, second]));
    await settle();
    const r1 = p.results.get("a"), r2 = p.results.get("b"), run2 = runOf(p, "second");
    const one = terminals(run1).length === 1 && run1.outcome?.ename === "KeyboardInterrupt";
    check(delivered1 && before.acked && before.notDelivered && before.noTerminal,
      `${name}: a Stop while run 1 runs: acknowledged at once (${before.acked}); until the interpreter stops, Run 2 isn't delivered (${before.notDelivered}) and run 1 has no terminal (${before.noTerminal})`);
    check(one && r1?.stopped && r2?.ok && run2?.outcome?.status === "ok" && local.executed.filter((c) => c.includes("second")).length === 1,
      `${name}: then (${how}) exactly one terminal for run 1, KeyboardInterrupt (${terminals(run1).length}, ${run1?.outcome?.ename}); Run 2 ends "second" (${JSON.stringify(r2)})`);
  }
  {
    n++;
    const local = stubLocal();
    const p = await page([["a", "print('first')"]], { gateway: new PreviewGateway(local) });
    const held = p.fake.pause("after-user-alloc");
    const run = p.gesture(["a"]);
    await held.reached;
    p.kernel.interrupt();
    await settle();
    const acked = interruptPosts(p) === 1;
    held.release();
    await ended(run);
    await settle();
    const r = runOf(p, "first");
    check(acked && local.interrupts === 0 && terminals(r).length === 1, `P3: a Stop on a run admitted but not delivered: no interrupt of the interpreter (${local.interrupts}); its one terminal (${terminals(r).length}, ${JSON.stringify(r?.outcome)})`);
  }
  return n;
}
