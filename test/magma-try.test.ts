// Magma's try ... catch e ... end try (src/magma.ts tryStmt, lib/_magma.py
// _caught): runtime errors, error statements and asserts are caught, in
// functions and procedures too; e is an Err (e`Object, e`Position, e`Type,
// printed as Magma prints the error) and the catch block's own, as a loop's
// variable is its loop's; a break or continue out of a try to a loop around
// it is Magma's compile error.  test/magma-try.m against Magma 2.18's own
// output (test/magma-try.out: magma -b < test/magma-try.m), as one session.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { magmaToPython } from "../src/magma";
import { analyzeCell } from "../src/dataflow";

const dir = join(__dirname, "..", "..", "test");
const program = readFileSync(join(dir, "magma-try.m"), "utf8");
const want = readFileSync(join(dir, "magma-try.out"), "utf8");
const cli = join(__dirname, "..", "src", "cli.js");

function runPython(py: string): string {
  const f = join(mkdtempSync(join(tmpdir(), "magma-try-")), "run.py");
  writeFileSync(f, py);
  const r = spawnSync(process.execPath, [cli, f], { encoding: "utf8", maxBuffer: 1 << 26 });
  return r.stdout + r.stderr;
}

test("Magma's try ... catch: as one session, Magma's output exactly", () => {
  const out = runPython(magmaToPython(program, "<session>", { recover: "session" }));
  assert.equal(out, want);
  assert.ok(!out.includes("ʹ"), "a private name shown");
});

test("Magma's try ... catch: a notebook cell's own", () => {
  // (a cell with no recovery: what the try catches doesn't stop it)
  const out = runPython(magmaToPython("try\n  error \"boom\";\ncatch e\n  print e`Object;\nend try;\nprint 7;\n", "<cell>"));
  assert.equal(out, "boom\n7\n");
});

test("the notebook's analysis: the catch's variable is no cell's definition; what the blocks assign is", () => {
  const a = analyzeCell("try\n  x := 1;\ncatch e\n  y := e`Object;\nend try;", "c", { mode: "magma" });
  assert.deepEqual([...a.defs].sort(), ["x", "y"]);
  assert.ok(![...a.refs].some((n) => n.startsWith("e")), [...a.refs].join(" "));
});

test("Magma's try ... catch: never an undeclared name, nor a memory guard's refusal", () => {
  // (Magma rejects an undeclared identifier before running: not caught)
  const out = runPython(magmaToPython("try\n  print undefined_y;\ncatch e\n  print \"caught\";\nend try;\n", "<session>", { recover: "session" }));
  assert.ok(!out.includes("caught") && out.includes("Identifier 'undefined_y' has not been declared or assigned"), out);
});

// (and the other gaps closed with it: test/magma-gaps.m, Magma 2.18's output)
test("Magma: P(~q) with q unassigned, an intrinsic given such a q, Append onto [], an error's place in a loop", () => {
  const prog = readFileSync(join(dir, "magma-gaps.m"), "utf8");
  const out = runPython(magmaToPython(prog, "<session>", { recover: "session" }));
  assert.equal(out, readFileSync(join(dir, "magma-gaps.out"), "utf8"));
});
