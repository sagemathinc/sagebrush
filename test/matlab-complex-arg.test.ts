import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// complex(x) of a complex x is x itself, as MATLAB's page says: both parts kept (a -0 imaginary part too), complex even
// when every imaginary part is zero, double or single as given. complex(a, b) with a complex part, which MATLAB's
// page does not allow, is refused rather than its imaginary part dropped (Sagebrush's message, until MATLAB's own is
// recorded).

const cli = join(__dirname, "..", "src", "cli.js");

function run(lines: string[]): Map<string, string[]> {
  const dir = mkdtempSync(join(tmpdir(), "sb-complex-"));
  writeFileSync(join(dir, "main.m"), lines.join("\n") + "\n");
  const r = spawnSync(process.execPath, [cli, "--matlab", "main.m"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const got = new Map<string, string[]>();
  for (const line of r.stdout.split("\n")) {
    const [id, ...rest] = line.split("|");
    if (rest.length && !got.has(id)) got.set(id, rest);
  }
  return got;
}

// (each row: class, size, isreal, then the real and imaginary parts at %.17g, and 1 ./ the imaginary parts, whose
// sign shows a -0; -3i is -(0 + 3i), its real part -0)
const R = (id: string, expr: string) =>
  `z = ${expr}; fprintf('${id}|%s|%s|%d|%s|%s|%s\\n', class(z), mat2str(size(z)), isreal(z), sprintf('%.17g ', real(z)), sprintf('%.17g ', imag(z)), sprintf('%.17g ', 1 ./ imag(z)));`;

test("complex(x) of a complex x is x: parts, class, a -0 imaginary part, still complex", () => {
  const got = run([
    R("scalar", "complex(1+1i)"),
    R("vector", "complex([1+1i 2 -3i])"),
    R("single", "complex(single(1+2i))"),
    R("zeroimag", "complex(complex(1, 0))"),
    R("negzero", "complex(complex(1, -0))"),
    R("negzerov", "complex(complex([1 2], [-0 0]))"),
    R("negzeros", "complex(single(complex(1, -0)))"),
    R("twice", "complex(complex(complex(-2, 5)))"),
    R("matrix", "complex([1 2i; -3i 4])"),
    R("real", "complex(2)"),
    R("parts", "complex([1 2], [3 -0])"),
    "w = complex([1+1i 2]); v = w(1); fprintf('index|%d|%.17g|%.17g\\n', isreal(v), real(v), imag(v));",
  ]);
  assert.deepEqual(got.get("scalar"), ["double", "[1 1]", "0", "1 ", "1 ", "1 "]);
  assert.deepEqual(got.get("vector"), ["double", "[1 3]", "0", "1 2 -0 ", "1 0 -3 ", "1 Inf -0.33333333333333331 "]);
  assert.deepEqual(got.get("single"), ["single", "[1 1]", "0", "1 ", "2 ", "0.5 "]);
  assert.deepEqual(got.get("zeroimag"), ["double", "[1 1]", "0", "1 ", "0 ", "Inf "]);
  assert.deepEqual(got.get("negzero"), ["double", "[1 1]", "0", "1 ", "-0 ", "-Inf "]);
  assert.deepEqual(got.get("negzerov"), ["double", "[1 2]", "0", "1 2 ", "-0 0 ", "-Inf Inf "]);
  assert.deepEqual(got.get("negzeros"), ["single", "[1 1]", "0", "1 ", "-0 ", "-Inf "]);
  assert.deepEqual(got.get("twice"), ["double", "[1 1]", "0", "-2 ", "5 ", "0.20000000000000001 "]);
  assert.deepEqual(got.get("matrix"), ["double", "[2 2]", "0", "1 -0 0 4 ", "0 -3 2 0 ", "Inf -0.33333333333333331 0.5 Inf "]);
  assert.deepEqual(got.get("real"), ["double", "[1 1]", "0", "2 ", "0 ", "Inf "]);
  assert.deepEqual(got.get("parts"), ["double", "[1 2]", "0", "1 2 ", "3 -0 ", "0.33333333333333331 -Inf "]);
  assert.deepEqual(got.get("index"), ["0", "1", "1"]);
});

test("complex(a, b) with a complex part is refused, not its imaginary part dropped", () => {
  const got = run([
    "try, complex(1+1i, 2), catch e, fprintf('a|%s\\n', e.message), end",
    "try, complex(1, 2i), catch e, fprintf('b|%s\\n', e.message), end",
    "try, complex([1 2], [1i 0]), catch e, fprintf('c|%s\\n', e.message), end",
    "try, complex(1+1i, []), catch e, fprintf('d|%s\\n', e.message), end",
    "try, complex(int8(3)), catch e, fprintf('e|%s\\n', e.message), end",
  ]);
  for (const id of ["a", "b", "c", "d"]) assert.match(got.get(id)?.[0] ?? "", /must both be real/, id);
  assert.match(got.get("e")?.[0] ?? "", /complex integers are not represented/);
});
