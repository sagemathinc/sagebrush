# Kedlaya's Frobenius matrix in WebKit: what CI checks, and what it doesn't

Plan: plan-kedlaya-webkit-ci r4, cleared by astra2 and daybreak2 on Oct 25. Job: `webkit` in .github/workflows/ci.yml. Test: web/test-kedlaya-worker.mjs with `BROWSER=webkit`.

## What the job checks

On the pinned Playwright WebKit (1.57.0, WebKit 26.0, Linux x64), in the Sagebrush worker:

1. **Detection:** `js_engine()` is `jsc`, `js_host()` is `browser`, and the ledger's label is `jsc (WebKit)`.
2. **The production refusal, first,** in a clean worker before any test-only override: `frobenius()` raises the exact "the memory estimate for this computation isn't established for this JavaScript engine (jsc (WebKit)); the native package computes it" text. In a fresh worker whose `_kd_modulus` raises, the refusal is the same, so it comes before the working modulus is made.
3. **Stop at four stages,** under the test-only override `_kd_engine = "jsc"`, each in its own fresh worker. The page reads each progress slot as one consistent copy under its seqlock (`kdSlot`, as src/runtime/progress.ts's `read()`; a self-check feeds it forced torn states) and sends Stop only once such a copy shows this run's own call (a call id not in use before the run) in the intended stage with done > 0. A pass needs KeyboardInterrupt within 1 s, the slot released, and a later call right. A call that finished or was refused, a stale stage, or the harness's timeout fails.

Time: in the first complete runs, the build took 14-26 s, the WebKit install 28-64 s and the test 32-58 s. One install stalled on the Ubuntu apt mirror past the job's old 15-minute limit before any test ran. So the install step has 10 minutes and the test step 5, under an 18-minute job limit, and a stall names its step.

It runs on pull requests that touch its inputs (scripts/ci-paths.mjs `webkitPaths`, conservatively: src/, all of lib/, the engine artifacts, the worker and its build, the build's inputs, the test, the classifier and the workflow), on any unknown path, and always on the nightly schedule and a manual dispatch. It doesn't run on master pushes.

## What it does not check

**It certifies nothing about memory.** Certification of the JSC object table on WebKit is **unavailable** (plan r4, section 0), measured in prototype 2 (/scratch/sagebrush-reviews/webkit-prototype2/, frozen):
- WebKit's heap snapshot has no element storage: a JSArray node is 16 bytes at any length;
- so the information-content floors fail, and the list mutants go uncaught;
- a growing surviving list keeps its 16-byte cell;
- `Debugger.pause` to the worker never produced a pause.

The table is established for Bun only, so production WebKit stays refused: this job tests that refusal; it doesn't lift it.

**The r3 findings CORR-WEBKIT-R3-1, R3-2 and R3-3 are moot for this job, not fixed.** The job removes the measurement paths they concern; it doesn't show those paths sound. They stand as constraints on any later certification proposal, and neither a green run of this job nor its plan's clearance is evidence that the JSC table is valid on WebKit. (The prototype's churn control, also, can't establish whether freed ids are reused: its counts include each array's shared Structure edge. See CORRECTION-churn.md there.)

A pinned Linux WebKit says nothing about Safari on macOS or iOS, and a user agent can't identify a build (Linux WebKit's says "Macintosh").
