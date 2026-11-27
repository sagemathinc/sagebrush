import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Arrays of classdef objects (_m.ObjArr): made by concatenation, growth, repmat, repelem, reshape and Name.empty;
// indexed, assigned and deleted as struct arrays are; their properties as comma-separated lists; display, as MATLAB
// R2026b's rows show it (MATLAB Online, 2026-11-26).

const cli = join(__dirname, "..", "src", "cli.js");

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "sb-objarr-"));
  for (const [rel, text] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, text);
  }
  return dir;
}

function run(dir: string, src: string) {
  writeFileSync(join(dir, "main.m"), src);
  const r = spawnSync(process.execPath, [cli, "--matlab", "main.m"], { cwd: dir, encoding: "utf8", timeout: 120000 });
  return { out: r.stdout, err: r.stderr, status: r.status };
}

const lines = (...ls: string[]) => ls.join("\n") + "\n";

const FILES: Record<string, string> = {
  "Rect.m": lines("classdef Rect", "  properties", "    Width = 5", "    Height", "  end", "  methods",
    "    function obj = Rect(w, h)", "      if nargin >= 1, obj.Width = w; end", "      if nargin >= 2, obj.Height = h; end", "    end",
    "    function a = total(objs)", "      a = sum([objs.Width]);", "    end", "  end", "end"),
  // (a constructor that counts its calls: a grown array's gap is made by it, once an element)
  "Cnt.m": lines("classdef Cnt", "  properties", "    n", "    s = struct('a', 1)", "  end", "  methods",
    "    function obj = Cnt(v)", "      persistent made", "      if isempty(made), made = 0; end", "      made = made + 1;",
    "      if nargin, obj.n = v; else, obj.n = -made; end", "    end", "  end", "end"),
  "Other.m": lines("classdef Other", "  properties", "    q = 1", "  end", "end"),
  "bumpall.m": lines("function a = bumpall(a)", "  a(1).Width = 1000;", "end"),
};

test("display of arrays of objects, as MATLAB's rows", () => {
  const dir = tree(FILES);
  const r = run(dir, lines("disp('#row'); ra = [Rect(1,2) Rect(3,4)]", "disp('#col'); rc = [Rect(1,2); Rect(3,4)]",
    "disp('#empty'); re = Rect.empty", "format compact", "disp('#row_compact'); ra = [Rect(1,2) Rect(3,4)]",
    "disp('#empty_compact'); re = Rect.empty", "format loose", "disp('#elem'); ra(2)", "disp('#end')"));
  assert.equal(r.err, "");
  const sec = new Map<string, string>();
  const parts = r.out.split(/^#(\w+)\n/m);
  for (let k = 1; k < parts.length; k += 2) sec.set(parts[k], parts[k + 1]);
  const want: Record<string, string> = {
    row: "\nra = \n\n  1×2 Rect array with properties:\n\n    Width\n    Height\n\n",
    col: "\nrc = \n\n  2×1 Rect array with properties:\n\n    Width\n    Height\n\n",
    empty: "\nre = \n\n  0×0 Rect array with properties:\n\n    Width\n    Height\n\n",
    row_compact: "ra = \n  1×2 Rect array with properties:\n\n    Width\n    Height\n\n",
    empty_compact: "re = \n  0×0 Rect array with properties:\n\n    Width\n    Height\n\n",
    elem: "\nans = \n\n  Rect with properties:\n\n     Width: 3\n    Height: 4\n\n",
  };
  for (const [name, w] of Object.entries(want)) assert.equal(sec.get(name), w, name);
});

test("making, indexing, growing, copying, deleting and listing arrays of objects", () => {
  const dir = tree(FILES);
  const r = run(dir, lines(
    // (contents in column-major order, by each element's own property: a control on the contents, not only the size)
    "r = reshape([Rect(1) Rect(2) Rect(3) Rect(4) Rect(5) Rect(6)], 2, 3);",
    "fprintf('order|%s|%s|%s|%s\\n', class(r), mat2str(size(r)), mat2str([r.Width]), mat2str([r(2, :).Width]));",
    "t = r.'; fprintf('transpose|%s|%s\\n', mat2str(size(t)), mat2str([t(1, :).Width]));",
    "e = Rect.empty(0, 3); fprintf('empty|%s|%s|%d|%d\\n', class(e), mat2str(size(e)), isempty(e), numel(Rect.empty));",
    "c = [Rect(1) [Rect(2); ] Rect(3)]; v = [Rect(1); Rect(2)]; z = [Rect.empty Rect(9) []];",
    "fprintf('cat|%s|%s|%s|%s\\n', mat2str(size(c)), mat2str(size(v)), class(z), mat2str(size(z)));",
    // (growth: the gap filled with copies of one object the constructor makes with no arguments, each its own)
    "g = Cnt(7); g(4) = Cnt(9); fprintf('grow|%s|%s\\n', mat2str([g.n]), mat2str(size(g)));",
    "g(2).s.a = 50; fprintf('gap|%g %g\\n', g(2).s.a, g(3).s.a);",
    // (copies: by assignment, by index, by a nested path, in a cell and as a function's argument)
    "a = [Rect(1) Rect(2) Rect(3)]; b = a; b(1).Width = 99; s.arr = a; u = s; u.arr(3).Width = -1; q = {a}; q2 = q; q2{1}(2).Width = 50;",
    "sub = a(2:3); sub(1).Width = 20; w = bumpall(a);",
    "fprintf('copies|%s|%s|%g %g|%g %g|%g|%g %g\\n', mat2str([a.Width]), mat2str([b.Width]), s.arr(3).Width, u.arr(3).Width, q{1}(2).Width, q2{1}(2).Width, sub(1).Width, a(1).Width, w(1).Width);",
    // (comma-separated lists, end, logical and repeated indexes, deletion)
    "x = [Rect(10) Rect(20) Rect(30) Rect(40)];",
    "fprintf('cs|%s|%g|%s|%s|%s\\n', mat2str([x.Width]), x(end).Width, mat2str([x(end-1:end).Width]), mat2str([x(logical([1 0 1 0])).Width]), mat2str(size(Rect(5)([1 1 1]))));",
    "x(2) = []; fprintf('delete|%s\\n', mat2str([x.Width]));",
    "fprintf('rep|%s|%s|%s\\n', mat2str(size(repmat(Rect(1), 2, 3))), mat2str([repelem([Rect(1) Rect(2)], 2).Width]), mat2str(size(num2cell(x))));",
    "fprintf('fns|%d|%d|%s|%d %d|%g|%d\\n', isa(x, 'Rect'), isobject(x), mat2str(isprop(x, 'Width')), isequal(x, x), isequal(x, x(1:2)), total(x), numel(arrayfun(@(o) o.Width, x)));",
    // (another class's value is converted by the leftmost object's class's constructor, as MATLAB R2026b's rows show:
    // Other has none, so [Other Rect(1)] is refused; Rect's takes one argument, so [Rect(1) Other] and [Rect(1) 7] are
    // Rects)
    "try, m = [Other Rect(1)]; catch err, fprintf('mix|%s|%s\\n', err.identifier, strrep(err.message, newline, '/')), end",
    "m = [Rect(1) Rect(2)]; fprintf('twin|made %s\\n', class(m));",
    "m = [Rect(1) Other]; fprintf('convobj|%s %s %s\\n', class(m), mat2str(size(m)), class(m(2).Width));",
    "m = [Rect(1) 7]; fprintf('convnum|%s\\n', mat2str([m.Width]));",
    "try, y = x(9); catch err, fprintf('past|%s\\n', err.message), end",
    "try, y = Rect.empty(2, 3); catch err, fprintf('emptysize|%s\\n', err.identifier), end",
    "fprintf('dotmethod|%g\\n', x.total());",
    "try, x(1) = 3; catch err, fprintf('conv|%s|%s\\n', err.identifier, err.message), end",
    "try, x.Width = 3; catch err, fprintf('dotasg|%s|%s\\n', err.identifier, err.message), end"));
  assert.equal(r.err, "");
  const got = new Map(r.out.split("\n").filter((l) => l.includes("|")).map((l) => [l.split("|")[0], l.slice(l.indexOf("|") + 1)] as [string, string]));
  assert.equal(got.get("order"), "Rect|[2 3]|[1 2 3 4 5 6]|[2 4 6]");
  assert.equal(got.get("transpose"), "[3 2]|[1 2]");
  assert.equal(got.get("empty"), "Rect|[0 3]|1|0");
  assert.equal(got.get("cat"), "[1 3]|[2 1]|Rect|[1 1]");
  // (Cnt(7), then Cnt(9), the value, the second construction; then the gap's one default object, the third, copied
  // into both elements of the gap)
  assert.equal(got.get("grow"), "[7 -3 -3 9]|[1 4]");
  assert.equal(got.get("gap"), "50 1");
  assert.equal(got.get("copies"), "[1 2 3]|[99 2 3]|3 -1|2 50|20|1 1000");
  assert.equal(got.get("cs"), "[10 20 30 40]|40|[30 40]|[10 30]|[1 3]");
  assert.equal(got.get("delete"), "[10 30 40]");
  assert.equal(got.get("rep"), "[2 3]|[1 1 2 2]|[1 3]");
  assert.equal(got.get("fns"), "1|1|[true true true]|1 0|80|3");
  assert.equal(got.get("mix"), "MATLAB:UnableToConvert|The following error occurred converting from Rect to Other:/Too many input arguments.");
  assert.equal(got.get("twin"), "made Rect");
  assert.equal(got.get("convobj"), "Rect [1 2] Other");
  assert.equal(got.get("convnum"), "[1 7]");
  assert.equal(got.get("past"), "Index exceeds the number of array elements. Index must not exceed 3.");
  assert.equal(got.get("emptysize"), "MATLAB:class:emptyMustBeZero");
  assert.equal(got.get("dotmethod"), "80");
  assert.equal(got.get("conv"), "MATLAB:UnableToConvert|Unable to perform assignment because value of type 'double' is not convertible to 'Rect'.");
  assert.equal(got.get("dotasg"), "MATLAB:index:expected_one_output_for_assignment|Assigning to 3 elements using a simple assignment statement is not supported. Consider using comma-separated list assignment.");
});

test("MATLAB R2026b's rows for arrays of objects (MATLAB Online, Nov 27 2026), exactly", () => {
  const dir = tree({
    "Cnt.m": lines("classdef Cnt", "  properties", "    n", "  end", "  methods", "    function obj = Cnt(v)",
      "      persistent made", "      if isempty(made), made = 0; end", "      made = made + 1;",
      "      if nargin, obj.n = v; else, obj.n = -made; end", "    end", "  end", "end"),
    "Rc.m": lines("classdef Rc", "  properties", "    W = 5", "  end", "  methods", "    function r = tot(objs)",
      "      r = sum([objs.W]);", "    end", "  end", "end"),
    "Oc.m": lines("classdef Oc", "  properties", "    q = 1", "  end", "end"),
  });
  const r = run(dir, lines(
    "R = @(name, f) p14_row(name, f);",
    "R('grow_gap', @() mat2str(p14_grow()));",
    "R('grow_2d', @() mat2str(p14_grow2()));",
    "R('prop_one_output', @() mat2str(p14_one()));",
    "R('method_on_arr', @() sprintf('%g', tot([Rc Rc Rc])));",
    "R('dot_method_on_arr', @() sprintf('%g', p14_dot()));",
    "R('empty_sizes', @() sprintf('%s %s %s', mat2str(size(Rc.empty)), mat2str(size(Rc.empty(0, 3))), mat2str(size(Rc.empty(2, 0, 4)))));",
    "R('empty_nonzero', @() mat2str(size(Rc.empty(2, 3))));",
    "R('cat_mixed', @() class([Rc Oc]));",
    "R('cat_with_empty_double', @() class([Rc [] Rc]));",
    "R('assign_number', @() p14_asgnum());",
    "R('arr_dot_assign', @() p14_dotasg());",
    "disp('#disp'); disp([Rc Rc]); disp('#end')",
    "function n = p14_grow()", "  clear Cnt", "  g = Cnt(7); g(4) = Cnt(9); n = [g.n];", "end",
    "function n = p14_grow2()", "  g = Cnt(1); g(2, 2) = Cnt(2); n = reshape([g.n], 1, []);", "end",
    "function v = p14_one()", "  a = [Rc Rc]; a(2).W = 8; v = a.W;", "end",
    "function v = p14_dot()", "  a = [Rc Rc]; v = a.tot();", "end",
    "function r = p14_asgnum()", "  a = [Rc Rc]; a(2) = 3; r = class(a(2));", "end",
    "function r = p14_dotasg()", "  a = [Rc Rc]; a.W = 3; r = mat2str([a.W]);", "end",
    "function p14_row(name, f)", "  try", "    v = f();", "    v = strrep(char(v), newline, '\\n');", "    fprintf('%s|%s\\n', name, v);",
    "  catch e", "    fprintf('%s|ERROR|%s|%s\\n', name, e.identifier, strrep(e.message, newline, '\\n'));", "  end", "end"));
  assert.equal(r.err, "");
  // (MATLAB's rows, verbatim; disp_arr's text through evalc there, disp here)
  const rows = [
    "grow_gap|[7 -3 -3 9]",
    "grow_2d|[1 -6 -6 2]",
    "prop_one_output|5",
    "method_on_arr|15",
    "dot_method_on_arr|10",
    "empty_sizes|[0 0] [0 3] [2 0 4]",
    "empty_nonzero|ERROR|MATLAB:class:emptyMustBeZero|At least one dimension must be zero.",
    "cat_mixed|ERROR|MATLAB:UnableToConvert|The following error occurred converting from Oc to Rc:\\nToo many input arguments.",
    "cat_with_empty_double|Rc",
    "assign_number|ERROR|MATLAB:UnableToConvert|Unable to perform assignment because value of type 'double' is not convertible to 'Rc'.",
    "arr_dot_assign|ERROR|MATLAB:index:expected_one_output_for_assignment|Assigning to 2 elements using a simple assignment statement is not supported. Consider using comma-separated list assignment.",
  ];
  assert.equal(r.out, rows.join("\n") + "\n#disp\n  1×2 Rc array with properties:\n\n    W\n\n#end\n");
});
