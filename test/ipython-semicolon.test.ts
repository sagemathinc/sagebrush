import test from "node:test";
import assert from "node:assert/strict";

// A notebook cell that ends with ; shows no value, as in IPython: its last
// token, past comments and blank lines, is ;. A ; in a string or a comment,
// or between statements, is not that. The expected outputs are IPython
// 9.17.1's (run_cell on CPython 3.14.8): "" where it shows no value.
const CASES: [string, string][] = [
  ["1;", ""],
  ["1", "1"],
  ["1 ;", ""],
  ["1;  ", ""],
  ["1; # c", ""],
  ["1  # c;", "1"],
  ["x = 2\nx;", ""],
  ["x;\n", ""],
  ["x;\n# trailing comment", ""],
  ["x;\n\n", ""],
  ["'a;'", "'a;'"],
  ["'a;' ;", ""],
  ["(1,\n 2);", ""],
  ["x\\\n;", ""],
  ["1; 2", "2"],
  ["1; 2;", ""],
  ["if True:\n    3;", ""],
  ["f'{1};'", "'1;'"],
  ['"""a\nb;"""', "'a\\nb;'"],
  ["x # ;", "2"],
  ["[1,\n2]  ;  # c", ""],
  ["1;\n  ", ""],
  ["x;\n    ", ""],
  ["print('shown');", "shown"],
];

async function session() {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  let id = 0;
  return async (code: string, extra: object = {}) => {
    const n = ++id;
    await s.handle({ id: n, code, ...extra });
    const of = (stream: string) => msgs.filter((m) => m.id === n && m.stream === stream).map((m) => m.text).join("");
    return { out: of("stdout"), err: of("stderr") };
  };
}

test("a cell ending with ; shows no value, as IPython's", async () => {
  const run = await session();
  for (const [code, want] of CASES) {
    const { out, err } = await run(code);
    assert.equal(err, "", code);
    assert.equal(out, want === "" ? "" : want + "\n", code);
  }
});

test("a value not shown is not kept as _, as IPython's", async () => {
  const run = await session();
  await run("5");
  await run("6;");
  assert.equal((await run("_")).out, "5\n");
});

// (SageMath's notebook is IPython's, with its rule; not checked against
// SageMath here)
test("a Sage cell ending with ; shows no value too", async () => {
  const run = await session();
  assert.equal((await run("2^3;", { sage: true })).out, "");
  assert.equal((await run("2^3", { sage: true })).out, "8\n");
});

// %time's code ending with ; shows no value either, as IPython's %time 7;
// (CORR-PR60-1, astra3): the ; is in the magic's code, which the cell's own
// check doesn't see. %timeit -o's result is shown, ; or not, as IPython's
// (there the ; is the timed statement's). Expected: IPython 9.17.1 on CPython
// 3.14.8, its timing lines aside.
const TIMING = /^(CPU times|Wall time|[0-9.]+ [nmuµ]?s ± ).*\n/gm;
const MAGICS: [string, string][] = [
  ["5", "5"],
  ["%time 7;", ""],
  ["_", "5"],
  ["%time 7", "7"],
  ["_", "7"],
  ["%time 8 ;", ""],
  ["%time 9;  # c", ""],
  ["%time 10  # c;", "10"],
  ["%time '11;'", "'11;'"],
  ["_", "'11;'"],
  ["%time x = 12;", ""],
  ["18\n%time 19;", ""],
  ["%time 20;\n", ""],
  ["%time 21;\n# trailing", ""],
  ["if True:\n    %time 22;", ""],
  ["%time 25; 26;", ""],
  ["_", "'11;'"],
  ["%timeit -n1 -r1 15;", ""],
  ["_", "'11;'"],
  ["%timeit -o -n1 -r1 16;", "<TimeitResult : >"],
  ["type(_).__name__", "'TimeitResult'"],
];

test("a line magic's code ending with ; shows no value, as IPython's %time 7;", async () => {
  const run = await session();
  for (const [code, want] of MAGICS) {
    const { out, err } = await run(code);
    assert.equal(err, "", code);
    const shown = out.replace(/<TimeitResult : .*>/, "<TimeitResult : >").replace(TIMING, "");
    assert.equal(shown, want === "" ? "" : want + "\n", code);
  }
});

test("a Sage cell's %time ending with ; shows no value too", async () => {
  const run = await session();
  const shown = async (code: string) => (await run(code, { sage: true })).out.replace(TIMING, "");
  assert.equal(await shown("%time 2^3;"), "");
  assert.equal(await shown("%time 2^3"), "8\n");
  assert.equal(await shown("_"), "8\n");
  assert.equal(await shown("%time 3^2;"), "");
  assert.equal(await shown("_"), "8\n");
});

// %time's code of several statements shows its last one's value, when that
// is an expression and the code doesn't end with ;, as IPython's %time 23; 24
// shows 24. Expected: IPython 9.17.1 on CPython 3.14.8, its timing lines aside.
const SEVERAL: [string, string][] = [
  ["5", "5"],
  ["%time 23; 24", "24"],
  ["_", "24"],
  ["%time x = 1; x", "1"],
  ["_", "1"],
  ["%time 1; 2;", ""],
  ["_", "1"],
  ["%time y = 3; y + 1  # c", "4"],
  ["%time z = [1]; z.append(2); z", "[1, 2]"],
  ["_", "[1, 2]"],
  ["%time a = 1; b = 2", ""],
  ["_", "[1, 2]"],
  ["%time 6; print('p')", "p"],
  ["_", "[1, 2]"],
  ["%time 7; 8 ;", ""],
  ["%time w = 9; w; ", ""],
  ["_", "[1, 2]"],
  ["%time import math; math.pi", "3.141592653589793"],
  ["%time 'a;'; 'b'", "'b'"],
  ["_", "'b'"],
  ["def f():\n    %time 1; 2\nf()", ""],
  ["if True:\n    %time 3; 4", ""],
  ["_", "'b'"],
];

test("%time's code of several statements shows the last one's value, as IPython's %time 23; 24", async () => {
  const run = await session();
  for (const [code, want] of SEVERAL) {
    const { out, err } = await run(code);
    assert.equal(err, "", code);
    assert.equal(out.replace(TIMING, ""), want === "" ? "" : want + "\n", code);
  }
  // (and in a Sage cell)
  assert.equal((await run("%time a = 2; a^3", { sage: true })).out.replace(TIMING, ""), "8\n");
});
