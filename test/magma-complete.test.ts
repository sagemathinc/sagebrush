import test from "node:test";
import assert from "node:assert/strict";
import { R, initParser, libDir } from "../src/compile";
import { magmaToPython } from "../src/magma";
import { magmaCompletions } from "../src/magma-complete";

// Tab completion at a Magma prompt completes Magma's names only (src/magma-complete.ts): the intrinsics Sagebrush
// implements, Magma's keywords and the session's variables, never Python's builtins, keywords or modules.
test("Magma completion: intrinsics, keywords and the session's variables, never Python names", async () => {
  await initParser();
  R.importModule("sys").path.push(libDir());
  const main = R.newModule("__main__");
  main.__builtins__ = R.builtins;
  // (a session that bound two variables, one of them a Python builtin's name, which pyName stores as abs_)
  R.loader.exec(magmaToPython("my_count := 3;\nabs := 7;\n", "<cell>"), main, "exec", "<cell>");
  const names = (prefix: string) => magmaCompletions(main, prefix)[0];
  // an intrinsic Sagebrush implements, with the text it replaces
  assert.ok(names("Fac").includes("Factorization"), String(names("Fac")));
  assert.equal(magmaCompletions(main, "x := Fac")[1], "Fac");
  // the session's variables, in Magma's spelling (abs, not abs_)
  assert.deepEqual(names("my_c"), ["my_count"]);
  assert.ok(names("ab").includes("abs") && !names("ab").includes("abs_"), String(names("ab")));
  // keywords
  for (const k of ["procedure", "function", "select", "repeat"]) assert.ok(names(k.slice(0, 3)).includes(k), k);
  // never Python names: no raise, range, import, print_function, None or the runtime's _ names
  for (const p of ["ra", "ran", "im", "No", "Tr", "pri", "le"]) {
    for (const py of ["raise", "range", "import", "None", "True", "len", "print_function"]) assert.ok(!names(p).includes(py), `${p}: ${py}`);
  }
  assert.ok(!names("").some((n) => n.startsWith("_")), "no _ names");
  // the library's own classes are no Magma names: MagmaError, MSeq
  assert.ok(!names("Ma").includes("MagmaError") && names("Ma").includes("Matrix"), String(names("Ma")));
  assert.ok(!names("MS").includes("MSeq"), String(names("MS")));
  // nothing to complete after a non-identifier character
  assert.deepEqual(magmaCompletions(main, "x := 3 + "), [[], ""]);
});
