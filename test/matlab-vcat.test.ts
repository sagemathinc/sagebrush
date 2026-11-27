import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// [a; b] of doubles: a column made directly, as [a b]'s row is, without the general concatenation; other columns
// unchanged.

const cli = join(__dirname, "..", "src", "cli.js");

function run(file: string, text: string) {
  const dir = mkdtempSync(join(tmpdir(), "sb-vcat-"));
  writeFileSync(join(dir, file), text);
  const args = file.endsWith(".m") ? ["--matlab", file] : [file];
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8", timeout: 120000 });
  return { out: r.stdout, err: r.stderr };
}

test("columns of scalars: values, size and class, and the columns that aren't all doubles", () => {
  const r = run("main.m", [
    "a = 1; b = -2.5; show = @(n, v) fprintf('%s|%s|%s|%s\\n', n, class(v), mat2str(size(v)), mat2str(v));",
    "show('two', [a; b]); show('three', [a; b; NaN]); show('inf', [Inf; -Inf]);",
    "show('complex', [a; 2i]); show('logical', [true; 2]); show('int', [int8(1); 2.7]); show('single', [single(1); 2]);",
    "show('empty', [a; []]); show('char', [65; 'B']); show('rows', [1 2; 3 4]); show('mixed', [a; [3 4]']);",
    "x = [a; b]; x(1) = 7; show('own', a);",
  ].join("\n") + "\n");
  assert.equal(r.err, "");
  assert.equal(r.out, [
    "two|double|[2 1]|[1;-2.5]", "three|double|[3 1]|[1;-2.5;NaN]", "inf|double|[2 1]|[Inf;-Inf]",
    "complex|double|[2 1]|[1+0i;0+2i]", "logical|double|[2 1]|[1;2]", "int|int8|[2 1]|[1;3]", "single|single|[2 1]|[1;2]",
    "empty|double|[1 1]|1", "char|char|[2 1]|['A';'B']", "rows|double|[2 2]|[1 2;3 4]", "mixed|double|[3 1]|[1;3;4]",
    "own|double|[1 1]|1", "",
  ].join("\n"));
});

test("a column of doubles doesn't take the general concatenation; others do", () => {
  const r = run("count.py", [
    "import _matlab as _m",
    "calls = []",
    "orig = _m._cat",
    "_m._cat = lambda *a, **k: (calls.append(1), orig(*a, **k))[1]",
    "r = _m.vcat([1.0, 2.0, 3.0])",
    "print('doubles', len(calls), r.shape)",
    "_m.vcat([1.0, 2j]); _m.vcat([True, 2.0])",
    "print('others', len(calls))",
  ].join("\n") + "\n");
  assert.equal(r.err, "");
  assert.equal(r.out, "doubles 0 (1, 3)\nothers 2\n");
});
