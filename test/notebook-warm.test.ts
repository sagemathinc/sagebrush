import test from "node:test";
import assert from "node:assert/strict";

// X1 (design r3, astra2 + daybreak2 CLEAR): the language's environment is
// loaded by Tab, check and a warm-up as it is by a run (ensureMode), each
// such request admitted by one handshake (the Stop's cutoff read, the stale
// Ctrl-C cleared, the cutoff read again) and answered by exactly one
// message.  The first test interrupts the real Sage import, so it must run
// before anything loads Sage in this process (node runs each test file in
// its own process, and these tests in order).

const { notebookSession } = require("../src/notebook-session");
const { R } = require("../src/compile");

type Hooks = { admit?: (step: 1 | 2, id: number) => void; beforeLoad?: (mode: string, id: number) => void };

function session(hooks: Hooks = {}) {
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true, hooks });
  return { s, msgs, of: (id: number) => msgs.filter((m) => m.id === id) };
}

// a Stop as the page's WorkerKernel.interrupt makes it: the cutoff, then bit 0
function stop(cutoff: number) {
  Atomics.store(R.INTR, 1, cutoff);
  Atomics.or(R.INTR, 0, 1);
}

let next = 1000;
const id = () => ++next;

test("a Stop during the Sage import interrupts it: interrupted, not recorded, and the next request loads it again", async () => {
  let armed = true;
  const { s, of } = session({ beforeLoad: (_m, i) => { if (armed) { armed = false; stop(i); } } });
  await s.ready;
  const w = id();
  await s.handle({ id: w, warm: true, sage: true });
  assert.deepEqual(of(w), [{ id: w, warmed: null, interrupted: true, mode: "sage", modeReady: false }]);
  assert.deepEqual(s.stats().loaded, []);
  // (a run whose load is interrupted: its code is not run)
  armed = true;
  const r = id();
  await s.handle({ id: r, code: "print('ran')", sage: true });
  const out = of(r).filter((m) => m.stream === "stdout").map((m) => m.text).join("");
  const done = of(r).find((m) => m.done);
  assert.equal(out, "", "the run's code ran after its load was interrupted");
  assert.equal(done.error, true);
  assert.equal(done.modeReady, false);
  // (the next request, newer than both Stops, loads it and answers)
  const c = id();
  await s.handle({ id: c, complete: "graphs.", sage: true });
  const [reply, ...more] = of(c);
  assert.equal(more.length, 0, "one message for a complete");
  assert.equal(reply.modeReady, true);
  assert.ok(reply.matches.length > 0 && reply.matches.every((x: string) => x.startsWith("graphs.")), JSON.stringify(reply).slice(0, 200));
  assert.deepEqual(s.stats().loaded, ["sage"]);
});

test("Tab before any run in Sage mode loads Sage and completes (William's graphs.[tab])", async () => {
  const { s, of } = session();
  await s.ready;
  const c = id();
  await s.handle({ id: c, complete: "graphs.Pet", sage: true });
  const msgs = of(c);
  assert.equal(msgs.length, 1);
  assert.ok(msgs[0].matches.includes("graphs.PetersenGraph"), JSON.stringify(msgs[0]).slice(0, 200));
});

test("a warm-up is answered by exactly one message, and loads once", async () => {
  const { s, of } = session();
  await s.ready;
  const a = id(), b = id();
  await s.handle({ id: a, warm: true, sage: true });
  await s.handle({ id: b, warm: true, sage: true });
  for (const w of [a, b]) {
    const msgs = of(w);
    assert.equal(msgs.length, 1, JSON.stringify(msgs));
    assert.equal(msgs[0].warmed, "sage");
    assert.equal(msgs[0].modeReady, true);
    assert.ok(!("start" in msgs[0]) && !("stream" in msgs[0]) && !("done" in msgs[0]));
  }
  assert.equal(s.stats().loads, 1);
  // (Python loads nothing, and says it is ready)
  const p = id();
  await s.handle({ id: p, warm: true });
  assert.deepEqual(of(p), [{ id: p, warmed: "python", ms: of(p)[0].ms, mode: "python", modeReady: true }]);
});

test("cancelled before admission (the prefetch's await): warm, complete, check and a run retire without Python and without clearing the Stop", async () => {
  const { s, of } = session();
  await s.ready;
  const w = id(), c = id(), k = id(), r = id();
  stop(r); // (a Stop for all four, landed while they waited: their admission comes after the await)
  await s.handle({ id: w, warm: true, magma: true });
  await s.handle({ id: c, complete: "x", magma: true });
  await s.handle({ id: k, check: "x = (", magma: true });
  await s.handle({ id: r, code: "print('ran')", magma: true });
  assert.deepEqual(of(w), [{ id: w, warmed: null, interrupted: true, mode: "magma", modeReady: false }]);
  assert.deepEqual(of(c), [{ id: c, matches: [], prefix: "", interrupted: true, mode: "magma", modeReady: false }]);
  assert.deepEqual(of(k), [{ id: k, more: false, interrupted: true, mode: "magma", modeReady: false }]);
  assert.deepEqual(of(r), [{ id: r, skipped: true }]);
  assert.equal(s.stats().loads, 0, "a load started for a cancelled request");
  assert.equal(Atomics.load(R.INTR, 0) & 1, 1, "a cancelled request cleared the Stop's bit");
  // (a later request is admitted, clears the stale bit, loads and runs)
  const n = id();
  await s.handle({ id: n, code: "1 + 1", magma: true });
  assert.equal(of(n).find((m) => m.done).modeReady, true);
  assert.deepEqual(s.stats().loaded, ["magma"]);
  assert.equal(Atomics.load(R.INTR, 0) & 1, 0);
});

test("a Stop between the admission's steps cancels the request, for every kind; one after them interrupts the load", async () => {
  for (const step of [1, 2] as const) {
    for (const kind of ["warm", "complete", "check", "code"]) {
      const { s, of } = session({ admit: (st, i) => { if (st === step) stop(i); } });
      await s.ready;
      const i = id();
      const m: any = { id: i, matlab: true };
      if (kind === "warm") m.warm = true;
      else if (kind === "complete") m.complete = "x";
      else if (kind === "check") m.check = "x = 1";
      else m.code = "disp(1)";
      await s.handle(m);
      const msgs = of(i);
      assert.equal(msgs.length, 1, `${kind} at step ${step}: ${JSON.stringify(msgs)}`);
      assert.ok(msgs[0].interrupted === true || msgs[0].skipped === true, `${kind} at step ${step}: ${JSON.stringify(msgs[0])}`);
      assert.equal(s.stats().loads, 0, `${kind} at step ${step}: Python ran`);
    }
  }
  // (after the final check: the Stop lands during the load and interrupts it;
  // the module dropped first, so that the load really runs its Python)
  const { s, of } = session({ beforeLoad: (_m, i) => { R.loader.exec("import sys\nsys.modules.pop('_matlab', None)\n", R.newModule("_t"), "exec", "<t>"); stop(i); } });
  await s.ready;
  const i = id();
  await s.handle({ id: i, warm: true, matlab: true });
  assert.equal(of(i)[0].interrupted, true);
  assert.equal(s.stats().loads, 1);
  assert.deepEqual(s.stats().loaded, []);
});

test("a load that fails is its own answer: an error, and nothing after it runs", async () => {
  // (a module that can't be imported: None in sys.modules, as Python's own way to block one)
  const { s, of } = session({ beforeLoad: () => { R.loader.exec("import sys\nsys.modules['_matlab'] = None\n", R.newModule("_t"), "exec", "<t>"); } });
  await s.ready;
  const w = id(), c = id(), r = id();
  await s.handle({ id: w, warm: true, matlab: true });
  await s.handle({ id: c, complete: "x", matlab: true });
  await s.handle({ id: r, code: "disp('ran')", matlab: true });
  assert.equal(of(w).length, 1);
  assert.match(of(w)[0].error, /the matlab environment didn't load/);
  assert.equal(of(w)[0].warmed, null);
  assert.match(of(c)[0].error, /didn't load/);
  assert.equal(of(c).length, 1);
  const done = of(r).find((m) => m.done);
  assert.equal(done.error, true);
  assert.equal(done.modeReady, false);
  assert.ok(!of(r).some((m) => m.stream === "stdout"), "the run's code ran after a failed load");
  R.loader.exec("import sys\nsys.modules.pop('_matlab', None)\n", R.newModule("_t"), "exec", "<t>");
});
