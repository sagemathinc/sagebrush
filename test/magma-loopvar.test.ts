// A Magma for loop's variable is the loop's own (src/magma.ts forStmt): an
// outer i is untouched, a new one stays unassigned after the loop, however
// the loop is left, and in the loop's own range i is that unassigned
// variable.  test/magma-loopvar.m against Magma 2.18's own output
// (test/magma-loopvar.out: magma -b < test/magma-loopvar.m), run as one
// session and as notebook cells (a statement each); and the notebook's
// analysis, which sees no definition or read of a loop's variable.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { magmaToPython } from "../src/magma";
import { analyzeCell } from "../src/dataflow";

const dir = join(__dirname, "..", "..", "test");
const program = readFileSync(join(dir, "magma-loopvar.m"), "utf8");
const want = readFileSync(join(dir, "magma-loopvar.out"), "utf8");
const cli = join(__dirname, "..", "src", "cli.js");

function runPython(py: string): string {
  const f = join(mkdtempSync(join(tmpdir(), "magma-loopvar-")), "run.py");
  writeFileSync(f, py);
  const r = spawnSync(process.execPath, [cli, f], { encoding: "utf8", maxBuffer: 1 << 26 });
  return r.stdout + r.stderr;
}

test("Magma's loop variables: as one session, Magma's output exactly", () => {
  const out = runPython(magmaToPython(program, "<session>", { recover: "session" }));
  assert.equal(out, want);
  assert.ok(!out.includes("ʹ"), "a private name shown");
});

test("Magma's loop variables: as notebook cells (a statement each), the same values", () => {
  // (each line its own translation, as cells are; errors are compared by their message line)
  const lines = program.split("\n").filter((l) => l.trim() && !l.startsWith("//"));
  const py = lines.map((l, k) => magmaToPython(l + "\n", `<cell ${k}>`, { recover: "session" })).join("\n");
  const keep = (s: string) => s.split("\n").filter((l) => l && !l.startsWith(">>") && !/^\s*\^$/.test(l));
  assert.deepEqual(keep(runPython(py)), keep(want));
});

test("the notebook's analysis: a loop's variable is no cell's definition or read", () => {
  const a = analyzeCell("for i in [1..3] do s := i; end for;", "c", { mode: "magma" });
  assert.deepEqual([...a.defs].sort(), ["s"]);
  assert.ok(![...a.refs].some((n) => n.startsWith("i")), [...a.refs].join(" "));
  // (its own range reads it unassigned: not the outer i)
  const b = analyzeCell("for i in [1..i] do print i; end for;", "c", { mode: "magma" });
  assert.ok(!b.refs.has("i") && !b.defs.has("i"), JSON.stringify([...b.refs]));
  // (another name in the range is read)
  assert.ok(analyzeCell("for i in [1..n] do print i; end for;", "c", { mode: "magma" }).refs.has("n"));
  // (two cells each with a for i: neither defines i)
  for (const src of ["for i in [1..2] do x := i; end for;", "for i in [1..5] do y := i; end for;"])
    assert.ok(!analyzeCell(src, "c", { mode: "magma" }).defs.has("i"), src);
});
