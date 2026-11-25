import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// __pyjs_compile_magma__ (src/magma-builtin.ts): Magma source as a code object, run by one Python driver in a dict
// kept for Magma, as Magma runs a file (Magma 2.18-5; magma-tests/test_error_file, test_error_syntax and
// test_compile_error_file pin the same rules for `sagebrush --magma`). A caller reads how each run ended from its
// exceptions: SystemExit(1) where Magma stops, SystemExit(0) for quit;, none where Magma reports and goes on.
const ROOT = join(__dirname, "../..");
const CLI = join(__dirname, "../src/cli.js");

const DRIVER = String.raw`
import io, json, sys
ns = {}
def run(src, label="item"):
    out, old = io.StringIO(), sys.stdout
    sys.stdout = out
    end = "ok"
    try:
        exec(__pyjs_compile_magma__(src, label, "exec"), ns)
    except SystemExit as e:
        end = "exit %d" % e.code
    finally:
        sys.stdout = old
    return [end, out.getvalue()]
items = json.loads(sys.stdin.read())
res = [run(src) for src in items]
for bad in ("mode", "type"):
    try:
        __pyjs_compile_magma__("1;", "item", "eval") if bad == "mode" else __pyjs_compile_magma__(5, "item", "exec")
        res.append(["no error", ""])
    except (ValueError, TypeError) as e:
        res.append([type(e).__name__, str(e)])
print(json.dumps(res))
`;

function runItems(items: string[], cwd: string) {
  const r = spawnSync(process.execPath, [CLI, "-c", DRIVER], { cwd, input: JSON.stringify(items), encoding: "utf8", timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  return { res: JSON.parse(r.stdout.trim().split("\n").pop()!) as [string, string][], stderr: r.stderr };
}

test("__pyjs_compile_magma__: state carries across items, and each ends as Magma ends a file", () => {
  const dir = mkdtempSync(join(tmpdir(), "magma-builtin-"));
  try {
    const items = [
      "x := 3;",
      "print x + 1;",
      // (reported, and the item goes on: not a failure)
      "y := Foo(2);\nprint 5;",
      "F := recformat< a, b, a >; 1;\nprint 2;",
      // (Magma stops: SystemExit(1), after its text)
      'print 1;\nerror "boom";\nprint 3;',
      "print 1;\nx := ;\nprint 3;",
      // (quit;: the item ends, not a failure)
      "print 1;\nquit;\nprint 2;",
      // (no file or process route: an intrinsic Sagebrush lacks is reported and goes on; load stops)
      'System("touch made-by-magma");\nprint 7;',
      'print Read("x.txt");\nprint 7;',
      'load "x.m";\nprint 7;',
    ];
    const { res, stderr } = runItems(items, dir);
    const at = (line: number, col: number, text: string) => `\nIn file "item", line ${line}, column ${col}:\n>> ${text}\n${" ".repeat(col + 2)}^\n`;
    assert.deepEqual(res, [
      ["ok", ""],
      ["ok", "4\n"],
      ["ok", `${at(1, 6, "y := Foo(2);")}User error: Identifier 'Foo' has not been declared or assigned\n5\n`],
      ["ok", `${at(1, 23, "F := recformat< a, b, a >; 1;")}User error: Field 'a' is repeated\n1\n2\n`],
      ["exit 1", "1\nRuntime error: boom\n"],
      ["exit 1", `1\n${at(2, 6, "x := ;")}User error: bad syntax\n`],
      ["exit 0", "1\n"],
      ["ok", `${at(1, 1, 'System("touch made-by-magma");')}User error: 'System' is a Magma intrinsic not implemented in Sagebrush\n7\n`],
      ["ok", `${at(1, 7, 'print Read("x.txt");')}User error: 'Read' is a Magma intrinsic not implemented in Sagebrush\n7\n`],
      ["exit 1", `${at(1, 1, 'load "x.m";')}User error: load (Magma's library files) is not supported yet\n`],
      ["ValueError", "__pyjs_compile_magma__() mode must be 'exec'"],
      ["TypeError", "__pyjs_compile_magma__() arg 1 must be a string"],
    ]);
    // (the parser's reason goes to stderr, as for sagebrush --magma: a caller shows stdout)
    assert.match(stderr, /sagebrush: bad syntax: unexpected ';' \(item, line 2\)/);
    assert.deepEqual(readdirSync(dir), [], "no file made");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("__pyjs_compile_magma__ is installed where the translator already ships: the worker's session and the CLI", () => {
  for (const f of ["src/notebook-session.ts", "src/cli.ts"]) {
    const src = readFileSync(join(ROOT, f), "utf8");
    assert.match(src, /^import \{ installMagmaCompile \} from "\.\/magma-builtin";$/m, f);
    assert.match(src, /^installMagmaCompile\(R\);$/m, f);
  }
  // (not in the runtime itself, which every bundle carries, translator or not)
  assert.doesNotMatch(readFileSync(join(ROOT, "src/runtime/index.ts"), "utf8"), /magma-builtin|__pyjs_compile_magma__/);
});
