import test from "node:test";
import assert from "node:assert/strict";

// R in a notebook (the worker protocol, src/notebook-session.ts): a run with the r flag runs its cell on lib/_rill
// in the session's one R session, so variables stay for the next cells; R prints its own values; an error is R's
// message on stderr and marks that cell failed, and the next cell still runs; a check asks whether R's statement goes
// on; the mode's library loads once.
const { notebookSession } = require("../src/notebook-session");

let next = 5000;
const id = () => ++next;

test("R cells: values print, variables persist, an error fails only its cell, check says whether a statement goes on", async () => {
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  const of = (i: number) => msgs.filter((m) => m.id === i);
  const text = (i: number, stream: string) => of(i).filter((m) => m.stream === stream).map((m) => m.text).join("");
  const done = (i: number) => of(i).find((m) => m.done);

  const a = id();
  await s.handle({ id: a, code: "x <- c(4, 8, 15)\nx * 2", r: true });
  assert.equal(text(a, "stdout"), "[1]  8 16 30\n");
  assert.equal(done(a).error ?? false, false);
  assert.equal(done(a).mode, "r");

  const b = id();
  await s.handle({ id: b, code: "x + 1", r: true });
  assert.equal(text(b, "stdout"), "[1]  5  9 16\n");

  const c = id();
  await s.handle({ id: c, code: "y <- 1\nnot_a_function(y)\ncat('never')", r: true });
  assert.equal(text(c, "stdout"), "");
  assert.equal(text(c, "stderr"), 'Error in not_a_function(y) : could not find function "not_a_function"\n');
  assert.equal(done(c).error, true);

  const d = id();
  await s.handle({ id: d, code: "y", r: true });
  assert.equal(text(d, "stdout"), "[1] 1\n");
  assert.equal(done(d).error ?? false, false);

  const k1 = id(), k2 = id();
  await s.handle({ id: k1, check: "f <- function(n) {", r: true });
  await s.handle({ id: k2, check: "1 + 2", r: true });
  assert.equal(of(k1)[0].more, true);
  assert.equal(of(k2)[0].more, false);
  assert.ok(s.stats().loaded.includes("r"));
});
