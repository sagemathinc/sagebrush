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
