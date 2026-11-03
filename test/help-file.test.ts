// obj? names a library function's file as lib/<module>.py wherever the
// library is read from: the bundle's /$pyjs/lib/, or a checkout's or an
// install's lib/ on disk (the computer's path never shows, so outputs are the
// same in CI, in a checkout and in the page).  A file that isn't the
// library's keeps its own path.  (`obj?` is lowered to __pyjs_help__(obj, 1,
// "obj") by src/help-syntax.ts; the call is made directly here, as a file
// run has no `?` lines.)
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(__dirname, "../..");
const run = (file: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", file], { encoding: "utf8", cwd: tmpdir() });
const fileLine = (out: string) => /^File: +(.*)$/m.exec(out)?.[1];

test("obj? names a library file as lib/..., never the checkout's path", () => {
  const dir = mkdtempSync(join(tmpdir(), "help-file-"));
  writeFileSync(join(dir, "a.sage"), 'E = EllipticCurve("389a1")\n__pyjs_help__(E.analytic_rank, 1, "E.analytic_rank")\n');
  const out = run(join(dir, "a.sage"));
  assert.equal(fileLine(out), "lib/_sage_modular.py", out);
  assert.ok(!out.includes(root), `the output holds the checkout's path ${root}:\n${out}`);
});

test("obj? keeps the path of a file that isn't the library's", () => {
  const dir = mkdtempSync(join(tmpdir(), "help-file-"));
  writeFileSync(join(dir, "mymod.py"), "def f(x):\n    'my function'\n    return x\n");
  writeFileSync(join(dir, "main.py"), "import sys\nsys.path.insert(0, " + JSON.stringify(dir) + ")\nimport mymod\n__pyjs_help__(mymod.f, 1, 'mymod.f')\n");
  const out = run(join(dir, "main.py"));
  assert.equal(fileLine(out), join(dir, "mymod.py"), out);
});
