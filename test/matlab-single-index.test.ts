import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Indexing keeps the class: one element of a single array is a single, as MATLAB's indexing pages say (the result
// has the class of the array). A real single's element came back as a double through the one-element fast path.

const cli = join(__dirname, "..", "src", "cli.js");

function run(src: string) {
  const dir = mkdtempSync(join(tmpdir(), "sb-single-index-"));
  writeFileSync(join(dir, "main.m"), src);
  const r = spawnSync(process.execPath, [cli, "--matlab", "main.m"], { cwd: dir, encoding: "utf8" });
  return { out: r.stdout, err: r.stderr, status: r.status };
}

test("one element of a single array is a single, by linear, end and row-column subscripts, and in a loop", () => {
  const r = run([
    "v = single([0.3 0.4 0.5]); disp(class(v(1))), disp(class(v(end))), disp(class(v(2:3)))",
    "w = single(0.3); disp(class(w(1)))",
    "m = single(magic(3)); disp(class(m(2, 2))), disp(class(m(end, end))), disp(class(m(:, 1)))",
    "s = single([0.3 0.4]); for k = 1:2, t = s(k); end, disp(class(t))",
    "st.a = single([1 2]); disp(class(st.a(2)))",
  ].join("\n"));
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, "single\nsingle\nsingle\nsingle\nsingle\nsingle\nsingle\nsingle\nsingle\n");
});

test("arithmetic on a single's element stays single; doubles, integers and logicals keep their classes", () => {
  const r = run([
    "s = single([0.1 0.2]); x = s(1) * 3; disp(class(x)), fprintf('%.17g\\n', x)",
    "fprintf('%.17g\\n', s(1))",
    "d = [0.1 0.2]; disp(class(d(1))), disp(class(d(1, 2)))",
    "i8 = int8([1 2 3]); disp(class(i8(1))), u = uint16([1 2]); disp(class(u(2)))",
    "L = [true false]; disp(class(L(1))), c = single([1+2i 3]); disp(class(c(1)))",
  ].join("\n"));
  assert.equal(r.status, 0, r.err);
  // (single(0.1) * 3 rounds to single: 0.30000001192092896, not the double 0.30000000447034836)
  assert.equal(r.out, "single\n0.30000001192092896\n0.10000000149011612\ndouble\ndouble\nint8\nuint16\nlogical\nsingle\n");
});
