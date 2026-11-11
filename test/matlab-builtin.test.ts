import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// __pyjs_compile_matlab__ (src/matlab-builtin.ts): MATLAB source as a code object, run by one Python driver in a dict
// kept for MATLAB, as the kernel runs a MATLAB cell (src/kernel.ts). Variables and functions carry from item to item;
// an error MATLAB stops at is kept for _matlab.cell_error() (after _matlab.host_shows_errors()), never an exception;
// a syntax error is Python's SyntaxError whose message is the kernel's text for it, naming the item.
const ROOT = join(__dirname, "../..");
const CLI = join(__dirname, "../src/cli.js");

const DRIVER = String.raw`
import io, json, sys
import _matlab as _m
_m.host_shows_errors()
ns = {}
def run(src, label="matlabblock 1"):
    out, old = io.StringIO(), sys.stdout
    sys.stdout = out
    end = "ok"
    try:
        exec(__pyjs_compile_matlab__(src, label, "exec"), ns)
        err = _m.cell_error()
        if err is not None:
            end = "error: " + err
    except SyntaxError as e:
        end = "syntax: " + e.msg
    finally:
        sys.stdout = old
    return [end, out.getvalue()]
items = json.loads(sys.stdin.read())
res = [run(src) for src in items]
for bad in ("mode", "type"):
    try:
        __pyjs_compile_matlab__("1;", "item", "eval") if bad == "mode" else __pyjs_compile_matlab__(5, "item", "exec")
        res.append(["no error", ""])
    except (ValueError, TypeError) as e:
        res.append([type(e).__name__, str(e)])
print(json.dumps(res))
`;

function runItems(items: string[], cwd: string) {
  const r = spawnSync(process.execPath, [CLI, "-c", DRIVER], { cwd, input: JSON.stringify(items), encoding: "utf8", timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as [string, string][];
}

test("__pyjs_compile_matlab__: state carries across items, an error is the cell's, a syntax error is Python's SyntaxError", () => {
  const dir = mkdtempSync(join(tmpdir(), "matlab-builtin-"));
  try {
    const res = runItems([
      "x = 3;",
      // (the command window's text for a line without a semicolon, as `sagebrush --matlab` prints it)
      "y = x + 1",
      "error('boom')",
      "z = [1 2\n",
      // (the session goes on after a failed item: y is still there)
      "disp(y)",
      // (a function defined in one item is called in the next)
      "function r = f(a)\nr = a*2;\nend\nf(4)",
      "f(5)",
    ], dir);
    assert.deepEqual(res, [
      ["ok", ""],
      ["ok", "\ny =\n\n     4\n\n"],
      ["error: boom\n", ""],
      ["syntax: File: matlabblock 1 Line: 2 Column: 1\nexpected ']'\n\n\n^", ""],
      ["ok", "     4\n"],
      ["ok", "\nans =\n\n     8\n\n"],
      ["ok", "\nans =\n\n    10\n\n"],
      ["ValueError", "__pyjs_compile_matlab__() mode must be 'exec'"],
      ["TypeError", "__pyjs_compile_matlab__() arg 1 must be a string"],
    ]);
    assert.deepEqual(readdirSync(dir), [], "no file made");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("__pyjs_compile_matlab__ is installed where the translator already ships: the worker's session and the CLI", () => {
  for (const f of ["src/notebook-session.ts", "src/cli.ts"]) {
    const src = readFileSync(join(ROOT, f), "utf8");
    assert.match(src, /^import \{ installMatlabCompile \} from "\.\/matlab-builtin";$/m, f);
    assert.match(src, /^installMatlabCompile\(R\);$/m, f);
  }
  // (not in the runtime itself, which every bundle carries, translator or not)
  assert.doesNotMatch(readFileSync(join(ROOT, "src/runtime/index.ts"), "utf8"), /matlab-builtin|__pyjs_compile_matlab__/);
});
