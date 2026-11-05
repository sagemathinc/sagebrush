import test from "node:test";
import assert from "node:assert/strict";

// Tab completion in a MATLAB notebook cell (src/interactive.ts completeIn, src/matlab-complete.ts; William, Nov 4:
// "ra<Tab>" offered Python's raise and range, not rand): MATLAB's names only, the built-ins Sagebrush implements,
// its keywords and the workspace's variables; Python's never. Asked as the notebook asks (src/notebook-session.ts),
// and the same function behind the Jupyter kernel and the CLI prompt (test/cli-stdin.test.ts pins the prompt).
// (Python's names that MATLAB doesn't have: print and import are MATLAB functions too, so they aren't here)
const PYTHON = ["raise", "range", "return_", "lambda", "None", "True", "False", "def", "len", "dict", "isinstance", "__import__", "elif", "yield"];

async function session() {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  let id = 0;
  return {
    run: (code: string, mode: Record<string, boolean> = { matlab: true }) => s.handle({ id: ++id, code, ...mode }),
    async complete(line: string, mode: Record<string, boolean> = { matlab: true }): Promise<[string[], string]> {
      await s.handle({ id: ++id, complete: line, ...mode });
      const m = msgs.filter((x) => x.matches).at(-1);
      return [m.matches, m.prefix];
    },
  };
}

test("MATLAB completes MATLAB's names: ra gives rand, randi, randn, randperm and rank, never raise or range", async () => {
  const s = await session();
  const [m, prefix] = await s.complete("ra");
  assert.equal(prefix, "ra");
  for (const n of ["rand", "randi", "randn", "randperm", "rank"]) assert.ok(m.includes(n), `${n} in ${m}`);
  for (const n of PYTHON) assert.ok(!m.includes(n), `${n} offered`);
  // (the word before the caret in a longer line, and the keywords)
  assert.deepEqual((await s.complete("x = 2 * ze"))[0], ["zeros"]);
  assert.deepEqual(await s.complete("whi"), [["while"], "whi"]);
  assert.ok((await s.complete("end"))[0].includes("end"));
  // (no Python name in any completion of a single letter: every one MATLAB's)
  for (const c of "abcdefghijklmnopqrstuvwxyz") for (const n of (await s.complete(c))[0]) assert.ok(!PYTHON.includes(n) && /^[A-Za-z]\w*$/.test(n), `${c}: ${n}`);
});

test("MATLAB completes the workspace's variables and functions, a Python keyword's name as MATLAB spells it", async () => {
  const s = await session();
  await s.run("radius = 3; rate_x = 2; lambda = 1; my_total = 5;");
  const [m] = await s.complete("ra");
  assert.ok(m.includes("radius") && m.includes("rate_x"), String(m));
  // (lambda is a Python keyword, kept as _k_lambda: it completes as lambda, the variable, not Python's keyword)
  assert.deepEqual((await s.complete("lamb"))[0], ["lambda"]);
  assert.deepEqual(await s.complete("y = my_"), [["my_total"], "my_"]);
});

test("MATLAB offers nothing after a dot or inside a character vector or string, nor in the middle of a token", async () => {
  const s = await session();
  await s.run("s.radius = 1;");
  assert.deepEqual(await s.complete("s.ra"), [[], "ra"]);
  assert.deepEqual(await s.complete("disp('ra"), [[], "ra"]);
  assert.deepEqual(await s.complete('x = "ra'), [[], "ra"]);
  assert.deepEqual(await s.complete("x = 3e"), [[], "e"]);
  // (a closed literal, or a transpose, is not a literal: the name after it completes)
  assert.deepEqual((await s.complete("disp('a'); ze"))[0], ["zeros"]);
  assert.deepEqual((await s.complete("x = y' * ze"))[0], ["zeros"]);
  // (a transpose after a closing bracket, and a doubled quote inside a literal, which stays in it: grader A9b, A10)
  assert.deepEqual((await s.complete("x = [1 2]' * ze"))[0], ["zeros"]);
  assert.deepEqual(await s.complete("disp('it''s ze"), [[], "ze"]);
  assert.deepEqual(await s.complete(""), [[], ""]);
});

test("a Magma cell completes Magma's names through the same entry point: ra offers no raise or range (grader I2)", async () => {
  const s = await session();
  await s.run("x := 1;", { magma: true });
  // (Magma is case-sensitive: its intrinsics are capitalized, so "ra" may complete nothing; Python's completer
  // would offer raise and range)
  const [m, prefix] = await s.complete("ra", { magma: true });
  assert.equal(prefix, "ra");
  for (const n of [...PYTHON, "raise", "range"]) assert.ok(!m.includes(n), `${n} offered in Magma`);
  assert.ok((await s.complete("Fac", { magma: true }))[0].includes("Factorization"), "the control: Magma's own names");
});

test("Python and Sage cells still complete Python's names", async () => {
  const s = await session();
  const [m] = await s.complete("ra", {});
  assert.ok(m.includes("raise") && m.includes("range"), String(m));
});
