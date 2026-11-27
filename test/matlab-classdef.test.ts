import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// classdef value classes (lib/_matlab_classdef.py, src/matlab.ts's classFile), against MATLAB R2026b's rows (MATLAB
// Online, 2026-11-26): construction, value semantics, the three call forms, dispatch and precedence, access, the
// built-ins on objects, display in each format, an @-folder's method files, packages, and what is refused.

const cli = join(__dirname, "..", "src", "cli.js");

/** a folder of MATLAB files: {relative path: text} */
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "sb-classdef-"));
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

// (the classes of MATLAB's rows, as they were written there)
const FILES: Record<string, string> = {
  "Rect.m": lines(
    "classdef Rect", "  properties", "    Width = 5", "    Height", "  end", "  methods",
    "    function obj = Rect(w, h)", "      if nargin >= 1, obj.Width = w; end", "      if nargin >= 2, obj.Height = h; end", "    end",
    "    function a = area(obj)", "      a = obj.Width * obj.Height;", "    end",
    "    function obj = scale(obj, k)", "      obj.Width = obj.Width * k; obj.Height = obj.Height * k;", "    end",
    "    function r = pfun(obj, varargin)", "      r = ['method:' class(obj) ':' num2str(numel(varargin))];", "    end",
    "    function r = lfun(obj)", "      r = 'method lfun';", "    end", "  end",
    "  methods (Static)", "    function r = unit()", "      r = Rect(1, 1);", "    end", "  end", "end"),
  "pfun.m": lines("function r = pfun(varargin)", "  r = ['path pfun:' num2str(nargin)];", "end"),
  "NoProps.m": lines("classdef NoProps", "end"),
  "NoCtor.m": lines("classdef NoCtor", "  properties", "    x = 1", "  end", "end"),
  "Mixed.m": lines("classdef Mixed", "  properties", "    a = 3", "    b = -0.5", "    c = pi", "    e = []", "    v = 1:5",
    "    m = magic(3)", "    ch = 'abc'", "    st = \"str\"", "    lg = true", "    i8 = int8(-7)", "    cx = 1+2i", "    nn = NaN",
    "    ninf = -Inf", "    big = 1e10", "    tiny = 0.1", "    s = struct('p', 1, 'q', 'z')", "    fh = @sin", "    nested",
    "    col = [1; 2; 3]", "  end", "  methods", "    function obj = Mixed()", "      obj.nested = Rect(2, 3);", "    end", "  end", "end"),
  "Acc.m": lines("classdef Acc", "  properties (SetAccess = private)", "    ro = 1", "  end", "  properties (Access = private)",
    "    hid = 2", "  end", "  properties (GetAccess = private)", "    wo = 3", "  end", "  properties", "    pub = 4", "  end",
    "  methods", "    function r = gethid(obj)", "      r = obj.hid;", "    end",
    // (a private property as an argument, in the class's own method)
    "    function r = hidplus(obj)", "      r = plus(obj.hid, 1);", "    end", "  end", "end"),
  "cntfun.m": lines("function r = cntfun()", "  persistent n", "  if isempty(n), n = 0; end", "  n = n + 1; r = n;", "end"),
  "Cnt.m": lines("classdef Cnt", "  properties", "    k = cntfun()", "  end", "end"),
  "PM.m": lines("classdef PM", "  properties", "    p = 10", "  end", "  methods", "    function r = p(obj)", "      r = 20;", "    end", "  end", "end"),
  "@PF/PF.m": lines("classdef PF", "  properties", "    p = 10", "  end", "  methods", "    r = q(obj)", "  end", "end"),
  "@PF/p.m": lines("function r = p(obj)", "  r = 20;", "end"),
  "@PF/q.m": lines("function r = q(obj)", "  r = 30;", "end"),
  "@PG/PG.m": lines("classdef PG", "  properties", "    p = 10", "  end", "  methods", "    r = p(obj)", "  end", "end"),
  "@PG/p.m": lines("function r = p(obj)", "  r = 20;", "end"),
};

/** the program printing each row as MATLAB's probe did: NAME|value, or NAME|ERROR|identifier|message */
const ROW = lines(
  "function row(name, f)",
  "  try",
  "    v = f();",
  "    if ~ischar(v) && ~isstring(v), v = sprintf('%s:%s', class(v), mat2str(v)); end",
  "    fprintf('%s|%s\\n', name, char(v));",
  "  catch e",
  "    fprintf('%s|ERROR|%s|%s\\n', name, e.identifier, e.message);",
  "  end",
  "end",
  "function lfun(varargin)",
  "  error('local lfun called');",
  "end");

test("construction, value semantics, calls, dispatch, precedence, access and the built-ins, as MATLAB's rows", () => {
  const dir = tree(FILES);
  const r = run(dir, lines(
    "r = Rect(5, 10);",
    "row('ctor_default', @() sprintf('%g %s', Rect().Width, mat2str(Rect().Height)));",
    "row('ctor_noctor_noargs', @() sprintf('%g', NoCtor().x));",
    "row('ctor_noctor_arg', @() NoCtor(5));",
    "r2 = r; r2.Width = 99; row('value_copy', @() sprintf('%g %g', r.Width, r2.Width));",
    "row('method_noreturn', @() sprintf('%g', scale(r, 2).Width));",
    "row('method_call_forms', @() sprintf('%g %g %g', area(r), r.area(), r.area));",
    "row('class_isa_isobject', @() sprintf('%s %d %d %d', class(r), isa(r, 'Rect'), isobject(r), isobject(3)));",
    "row('isprop', @() sprintf('%d %d %d', isprop(r, 'Width'), isprop(r, 'area'), isprop(r, 'nope')));",
    "row('properties', @() strjoin(properties(r)', ','));",
    "row('fieldnames', @() strjoin(fieldnames(r)', ','));",
    "row('methods', @() strjoin(sort(methods(r))', ','));",
    "row('isequal', @() sprintf('%d %d %d', isequal(r, Rect(5, 10)), isequal(r, Rect(5, 11)), isequal(r, struct('Width', 5, 'Height', 10))));",
    "row('unknown_prop_get', @() r.Depth);",
    "row('unknown_method', @() r.nomethod(1));",
    "row('static_via_instance', @() sprintf('%g', r.unit().Width));",
    "row('pfun_obj', @() pfun(r));",
    "row('pfun_num', @() pfun(3));",
    "row('pfun_num_obj', @() pfun(3, r));",
    "row('pfun_str_obj', @() pfun('x', r, 2));",
    "row('lfun_obj_local', @() lfun(r));",
    "row('prop_method_same_dot', @() sprintf('%g', PM().p));",
    "row('prop_method_same_call', @() sprintf('%g', p(PM())));",
    "pfun = 7; row('var_shadows_method', @() pfun(1)); clear pfun",
    "a = Acc;",
    "row('acc_ro_read', @() sprintf('%g', a.ro));",
    "row('acc_private_read', @() a.hid);",
    "row('acc_private_via_method', @() sprintf('%g', a.gethid()));",
    "row('acc_private_arg_in_method', @() sprintf('%g', a.hidplus()));",
    "row('isprop_private', @() sprintf('%d %d', isprop(a, 'hid'), isprop(a, 'gethid')));",
    "row('acc_wo_read', @() a.wo);",
    "c1 = Cnt; c2 = Cnt; c3 = Cnt;",
    "row('default_once', @() sprintf('%g %g %g', c1.k, c2.k, c3.k));",
    "try, rr = r; rr.Depth = 3; catch e, fprintf('unknown_prop_set|ERROR|%s|%s\\n', e.identifier, e.message), end",
    "try, a2 = a; a2.ro = 5; catch e, fprintf('acc_ro_set|ERROR|%s|%s\\n', e.identifier, e.message), end",
    "row('PF_create', @() class(PF));",
    "o = PF; row('PF_dot_p', @() o.p); row('PF_call_p', @() p(o)); row('PF_q', @() q(o));",
    "row('PF_methods', @() strjoin(methods(o)', ','));",
    "row('PG_declared_create', @() class(PG));",
  ) + ROW);
  assert.equal(r.err, "");
  const got = new Map(r.out.split("\n").filter((l) => l.includes("|")).map((l) => [l.split("|")[0], l.slice(l.indexOf("|") + 1)] as [string, string]));
  // (MATLAB's rows; PropertyInUse's message there starts with the file's place, "Error: File: PM.m Line: 6 Column: 5")
  const want: Record<string, string> = {
    ctor_default: "5 []", ctor_noctor_noargs: "1", ctor_noctor_arg: "ERROR|MATLAB:TooManyInputs|Too many input arguments.",
    value_copy: "5 99", method_noreturn: "10", method_call_forms: "50 50 50", class_isa_isobject: "Rect 1 1 0", isprop: "1 0 0",
    properties: "Width,Height", fieldnames: "Width,Height", methods: "Rect,area,lfun,pfun,scale,unit", isequal: "1 0 0",
    unknown_prop_get: "ERROR|MATLAB:noSuchMethodOrField|Unrecognized method, property, or field 'Depth' for class 'Rect'.",
    unknown_method: "ERROR|MATLAB:noSuchMethodOrField|Unrecognized method, property, or field 'nomethod' for class 'Rect'.",
    static_via_instance: "1", pfun_obj: "method:Rect:0", pfun_num: "path pfun:1", pfun_num_obj: "method:double:1",
    // (the local function, not the method: MATLAB refuses its call for an output it doesn't have before it runs,
    // MATLAB:TooManyOutputs; Sagebrush runs it, which raises its own error, a difference of output counting, not of
    // classes)
    pfun_str_obj: "method:char:2", lfun_obj_local: "ERROR||local lfun called",
    prop_method_same_dot: "ERROR|MATLAB:class:PropertyInUse|'p' is already defined as a property in the 'PM' class.",
    prop_method_same_call: "ERROR|MATLAB:class:PropertyInUse|'p' is already defined as a property in the 'PM' class.",
    var_shadows_method: "double:7", acc_ro_read: "1",
    acc_private_read: "ERROR|MATLAB:class:GetProhibited|No public property 'hid' for class 'Acc'.",
    acc_private_via_method: "2", acc_private_arg_in_method: "3", isprop_private: "1 0", acc_wo_read: "ERROR|MATLAB:class:GetProhibited|No public property 'wo' for class 'Acc'.",
    default_once: "1 1 1",
    unknown_prop_set: "ERROR|MATLAB:noPublicFieldForClass|Unrecognized property 'Depth' for class 'Rect'.",
    acc_ro_set: "ERROR|MATLAB:class:SetProhibited|Unable to set the 'ro' property of class 'Acc' because it is read-only.",
    PF_create: "PF", PF_dot_p: "double:10", PF_call_p: "double:20", PF_q: "double:30", PF_methods: "PF,p,q",
    PG_declared_create: "ERROR|MATLAB:class:PropertyInUse|'p' is already defined as a property in the 'PG' class.",
  };
  for (const [name, w] of Object.entries(want)) assert.equal(got.get(name), w, name);
});

test("display in each format, as MATLAB's rows", () => {
  const dir = tree(FILES);
  const mark = (m: string) => `disp('#${m}');`;
  const r = run(dir, lines(
    mark("noSemicolon"), "r = Rect(5, 10)",
    mark("disp"), "disp(r)",
    "format compact", mark("compact"), "r", mark("disp_compact"), "disp(r)", "format loose",
    "format long", mark("long"), "r", "format short",
    mark("noprops"), "np = NoProps", "format compact", mark("noprops_compact"), "np = NoProps", "format loose",
    mark("struct"), "so = struct('o', r)",
    "format compact", mark("cell_compact"), "co = {r, 3}", mark("acc_compact"), "a = Acc", "format loose",
    mark("classname"), "class(r)", mark("propvec"), "r.Width",
    mark("methods"), "methods(r)",
    mark("mixed"), "mx = Mixed",
    "format long", mark("mixed_long"), "mx = Mixed", "format short",
    mark("end")));
  assert.equal(r.err, "");
  const sec = new Map<string, string>();
  const parts = r.out.split(/^#(\w+)\n/m);
  for (let k = 1; k < parts.length; k += 2) sec.set(parts[k], parts[k + 1]);
  const rect = "  Rect with properties:\n\n     Width: 5\n    Height: 10\n";
  const want: Record<string, string> = {
    noSemicolon: `\nr = \n\n${rect}\n`, disp: `${rect}\n`,
    compact: `r = \n${rect}`, disp_compact: rect, long: `\nr = \n\n${rect}\n`,
    noprops: "\nnp = \n\n  NoProps with no properties.\n\n", noprops_compact: "np = \n  NoProps with no properties.\n",
    struct: "\nso = \n\n  struct with fields:\n\n    o: [1×1 Rect]\n\n",
    cell_compact: "co =\n  1×2 cell array\n    {1×1 Rect}    {[3]}\n",
    acc_compact: "a = \n  Acc with properties:\n\n     ro: 1\n    pub: 4\n",
    classname: "\nans =\n\n    'Rect'\n\n", propvec: "\nans =\n\n     5\n\n",
    methods: "\nMethods for class Rect:\n\nRect   area   lfun   pfun   scale  \n\nStatic methods:\n\nunit   \n\n",
  };
  for (const [name, w] of Object.entries(want)) assert.equal(sec.get(name), w, name);
  // (each value's format in an object's display, short and long, as MATLAB's; the nested object as [1×1 Rect])
  const mixed = (long: boolean) => ["", "mx = ", "", "  Mixed with properties:", "",
    "         a: 3", `         b: ${long ? "-0.500000000000000" : "-0.5000"}`, `         c: ${long ? "3.141592653589793" : "3.1416"}`,
    "         e: []", "         v: [1 2 3 4 5]", "         m: [3×3 double]", "        ch: 'abc'", "        st: \"str\"", "        lg: 1",
    "        i8: -7", `        cx: ${long ? "1.000000000000000 + 2.000000000000000i" : "1.0000 + 2.0000i"}`, "        nn: NaN",
    "      ninf: -Inf", `       big: ${long ? "1.000000000000000e+10" : "1.0000e+10"}`, `      tiny: ${long ? "0.100000000000000" : "0.1000"}`,
    "         s: [1×1 struct]", "        fh: @sin", "    nested: [1×1 Rect]", "       col: [3×1 double]", "", ""].join("\n");
  assert.equal(sec.get("mixed"), mixed(false));
  assert.equal(sec.get("mixed_long"), mixed(true));
});

test("files, packages, copies, a method named like a built-in, mfilename('class'), and what is refused", () => {
  const dir = tree({
    ...FILES,
    "+pk/Pt.m": lines("classdef Pt", "  properties", "    x = 1", "  end", "  methods",
      "    function obj = Pt(v)", "      if nargin, obj.x = v; end", "    end",
      // (max here is the built-in: a method's name doesn't take calls whose arguments aren't its objects)
      "    function r = m(obj)", "      r = max([obj.x 3 2]);", "    end",
      "    function r = max(obj)", "      r = -1;", "    end", "  end", "end"),
    // (mfilename in a class's method and in its @-folder's method file, as MATLAB's rows: the file, and the class)
    "@Cl/Cl.m": lines("classdef Cl", "  methods", "    function r = who(obj)", "      r = [mfilename ' ' mfilename('class')];", "    end", "  end", "end"),
    "@Cl/mm.m": lines("function r = mm(obj)", "  r = [mfilename ' ' mfilename('class')];", "end"),
    "+pk/@Pq/Pq.m": lines("classdef Pq", "  properties", "    y = 2", "  end", "end"),
    "+pk/@Pq/twice.m": lines("function r = twice(obj)", "  r = 2 * obj.y;", "end"),
    // (nested packages: a class, an @-folder class and a function, named without parentheses)
    "+aa/+bb/Nc.m": lines("classdef Nc", "  properties", "    v = 3", "  end", "  properties (Constant)", "    K = 9", "  end", "end"),
    "+aa/+bb/@Nf/Nf.m": lines("classdef Nf", "  properties", "    w = 6", "  end", "end"),
    "+aa/+bb/nfun.m": lines("function r = nfun()", "  r = 21;", "end"),
    "Bx.m": lines("classdef Bx", "  properties", "    s = struct('a', 1)", "    c = {1}", "  end", "  methods",
      "    function obj = setA(obj, v)", "      obj.s.a = v;", "    end", "  end", "end"),
    "bump.m": lines("function o = bump(o)", "  o.s.a = 99;", "end"),
    // (an @-folder method file naming itself in a handle: the handle dispatches, so a number reaches the path's myop)
    "@Fh/Fh.m": lines("classdef Fh", "  properties", "    value = 5", "  end", "end"),
    "@Fh/myop.m": lines("function r = myop(obj)", "  r = doWork(obj.value, @myop);", "end"),
    "doWork.m": lines("function r = doWork(v, f)", "  r = f(v);", "end"),
    "myop.m": lines("function r = myop(x)", "  r = 2 * x;", "end"),
    "Hd.m": lines("classdef Hd < handle", "  properties", "    v = 1", "  end", "end"),
    "Ev.m": lines("classdef Ev", "  events", "    Changed", "  end", "end"),
    "En.m": lines("classdef En", "  enumeration", "    Red, Green", "  end", "end"),
    "Va.m": lines("classdef Va", "  properties", "    x (1,1) double = 1", "  end", "end"),
    "Gs.m": lines("classdef Gs", "  properties", "    x = 1", "  end", "  methods", "    function v = get.x(obj)", "      v = 2;", "    end", "  end", "end"),
  });
  const r = run(dir, lines(
    "t = pk.Pt(4); fprintf('pkg|%s %g %g %g\\n', class(t), t.x, t.m(), max(t));",
    "c = Cl; fprintf('mf|%s|%s\\n', c.who(), mm(c));",
    "import pk.*",
    "t2 = Pt(5); fprintf('import|%g\\n', t2.x);",
    "q2 = pk.Pq; fprintf('pkgat|%s|%s\\n', class(q2), mat2str(twice(q2)));",
    "n1 = aa.bb.Nc; n2 = aa.bb.Nc(); n3 = aa.bb.Nf; y = aa.bb.nfun + 1;",
    "fprintf('nestedpkg|%s %g|%s|%s %g|%g|%g\\n', class(n1), n1.v, class(n2), class(n3), n3.w, y, aa.bb.Nc.K);",
    "try, z = aa.bb; fprintf('nsalone|made\\n'); catch e, fprintf('nsalone|%s\\n', e.message), end",
    // (a copy is its own: by assignment, in a cell, as a function's argument, from a method's result)
    "b = Bx; b2 = b; b2.s.a = 5; c = {b}; b.c{1} = 7; b3 = bump(b); b4 = b.setA(3);",
    "fprintf('copies|%g %g %g %g %g %g\\n', b.s.a, b2.s.a, c{1}.c{1}, b.c{1}, b3.s.a, b4.s.a);",
    // (one object indexed as obj(1), assigned into a new variable, and transposed: itself)
    "b5 = Bx; b5(1).s.a = 8; z(1) = b5; bt = b5.'; bc = b5';",
    "fprintf('scalar|%g %g %g %g %s\\n', b5.s.a, b5(1).s.a, z.s.a, bt.s.a, class(bc));",
    "fprintf('selfhandle|%g\\n', myop(Fh));",
    "for k = {'Hd', 'Ev', 'En', 'Va', 'Gs'}, try, feval(k{1}); fprintf('refuse|%s|made\\n', k{1}); catch e, fprintf('refuse|%s|%s\\n', k{1}, e.message), end, end",
    "try, x = [Rect(1, 2) Rect(3, 4)]; fprintf('array|made\\n'); catch e, fprintf('array|refused|%s\\n', e.message), end",
    "try, x = Rect.empty; fprintf('empty|made\\n'); catch e, fprintf('empty|refused|%s\\n', e.message), end",
    "fprintf('mfclass|[%s]\\n', mfilename('class'));",
    // (an end in a named function's arguments, which refers to the index around the call: here a global's, whose
    // index is made first; the call's frame is its lookup)
    "global gq; gq = 1:4; gq(min(end, 2)) = 9; fprintf('endchain|%s|%g\\n', mat2str(gq), gq(max(end - 1, 1)));"));
  assert.equal(r.err, "");
  const got = new Map<string, string[]>();
  for (const l of r.out.split("\n").filter((x) => x.includes("|"))) {
    const [k, ...v] = l.split("|");
    got.set(k === "refuse" ? `refuse ${v[0]}` : k, k === "refuse" ? v.slice(1) : v);
  }
  assert.deepEqual(got.get("pkg"), ["pk.Pt 4 4 -1"]);
  assert.deepEqual(got.get("mf"), ["Cl Cl", "mm Cl"]);
  assert.deepEqual(got.get("import"), ["5"]);
  assert.deepEqual(got.get("pkgat"), ["pk.Pq", "4"]);
  assert.deepEqual(got.get("nestedpkg"), ["aa.bb.Nc 3", "aa.bb.Nc", "aa.bb.Nf 6", "22", "9"]);
  assert.deepEqual(got.get("nsalone"), ["Unrecognized function or variable 'aa.bb'."]);
  assert.deepEqual(got.get("copies"), ["1 5 1 7 99 3"]);
  assert.deepEqual(got.get("scalar"), ["8 8 8 8 Bx"]);
  assert.deepEqual(got.get("selfhandle"), ["10"]);
  for (const [k, what] of [["Hd", /superclasses/], ["Ev", /events/], ["En", /enumeration/], ["Va", /property validation/], ["Gs", /property get and set methods/]] as [string, RegExp][]) {
    const g = got.get(`refuse ${k}`)!;
    assert.match(g[0], what, k);
    assert.match(g[0], /not supported in Sagebrush yet/, k);
  }
  // (arrays of objects: the next stage, refused with a message that says so)
  assert.equal(got.get("array")![0], "refused");
  assert.match(got.get("array")![1], /Arrays of objects are not supported in Sagebrush yet/);
  assert.match(got.get("empty")![1], /Arrays of objects are not supported in Sagebrush yet: Rect\.empty/);
  assert.deepEqual(got.get("mfclass"), ["[]"]);
  assert.deepEqual(got.get("endchain"), ["[1 9 3 4]", "3"]);
});

test("private methods and private Constant properties: refused outside the class, in either form; allowed in its methods", () => {
  // (MathWorks' method and property attribute pages: Access = private is the class's own methods only)
  // (the class, named by its own methods as `self`: Priv, or pk.Priv in a package)
  const priv = (self: string) => lines("classdef Priv",
      "  properties (Constant, Access = private)", "    hidden = 42", "  end",
      "  properties (Constant)", "    open = 5", "  end",
      "  methods",
      "    function r = inside(obj)", "      r = secret(obj);", "    end",
      "    function r = insideDot(obj)", "      r = obj.secret();", "    end",
      "    function r = ownconst(obj)", `      r = [obj.hidden, ${self}.hidden];`, "    end",
      "    function r = ownconst2(obj)", `      r = ${self}.hidden;`, "    end",
      "    function r = ownstatic(obj)", `      r = ${self}.staticsecret();`, "    end",
      "    function r = viaHandle(obj)", "      h = @secret;", "      r = h(obj);", "    end",
      "    function r = pub(obj)", "      r = 3;", "    end",
      "  end",
      "  methods (Access = private)", "    function r = secret(obj)", "      r = 7;", "    end", "  end",
      "  methods (Static, Access = private)", "    function r = staticsecret()", "      r = 11;", "    end", "  end",
      "end");
  const pf = lines("classdef Pf", "  properties (Access = private)", "    hid = 6", "  end",
    "  methods (Access = private)", "    function r = sec(obj)", "      r = 8;", "    end", "  end", "end");
  const peek = lines("function r = peek(obj)", "  r = [obj.hid, sec(obj), obj.sec()];", "end");
  const dir = tree({
    "Priv.m": priv("Priv"),
    // (the same classes in a package: their own access by their package-qualified names)
    "+pk/Priv.m": priv("pk.Priv"), "+pk/@Pf/Pf.m": pf, "+pk/@Pf/peek.m": peek,
    // (an @-folder's method file is one of the class's methods: the class's access)
    "@Pf/Pf.m": pf, "@Pf/peek.m": peek,
    // (a Constant read through a captured class name: no object is made, so this constructor never runs)
    "Kc.m": lines("classdef Kc", "  properties (Constant)", "    K = 4", "  end", "  methods", "    function obj = Kc()", "      error('constructed');", "    end", "  end", "end"),
  });
  const r = run(dir, lines(
    "p = Priv; q = Pf;",
    "row('inside', @() p.inside()); row('insideDot', @() p.insideDot()); row('ownconst', @() mat2str(p.ownconst()));",
    "row('ownconst2', @() p.ownconst2());",
    "row('ownstatic', @() p.ownstatic()); row('viaHandle', @() p.viaHandle()); row('folder', @() mat2str(peek(q)));",
    "row('pub_fn', @() pub(p)); row('pub_dot', @() p.pub()); row('open_inst', @() p.open); row('open_class', @() Priv.open);",
    "row('private_dot', @() p.secret()); row('private_function', @() secret(p));",
    "row('private_const_instance', @() p.hidden); row('private_const_class', @() Priv.hidden);",
    "row('private_static_instance', @() p.staticsecret()); row('private_static_class', @() Priv.staticsecret());",
    "row('folder_outside_prop', @() q.hid); row('folder_outside_method', @() sec(q));",
    "h = @secret; row('handle_outside', @() h(p));",
    "row('const_in_anon', @() Kc.K);",
    "pp = pk.Priv; pq = pk.Pf;",
    "row('pk_inside', @() pp.inside()); row('pk_insideDot', @() pp.insideDot()); row('pk_ownconst', @() mat2str(pp.ownconst()));",
    "row('pk_ownconst2', @() pp.ownconst2()); row('pk_ownstatic', @() pp.ownstatic()); row('pk_viaHandle', @() pp.viaHandle());",
    "row('pk_folder', @() mat2str(peek(pq))); row('pk_pub', @() pp.pub());",
    "row('pk_private_dot', @() pp.secret()); row('pk_private_function', @() secret(pp)); row('pk_private_const_class', @() pk.Priv.hidden);",
    "row('pk_private_static_class', @() pk.Priv.staticsecret()); row('pk_folder_outside_prop', @() pq.hid); row('pk_handle_outside', @() h(pp));",
  ) + ROW);
  assert.equal(r.err, "");
  const got = new Map(r.out.split("\n").filter((l) => l.includes("|")).map((l) => [l.split("|")[0], l.slice(l.indexOf("|") + 1)] as [string, string]));
  const allowed: Record<string, string> = { inside: "double:7", insideDot: "double:7", ownconst: "[42 42]", ownconst2: "double:42", ownstatic: "double:11",
    viaHandle: "double:7", folder: "[6 8 8]", const_in_anon: "double:4", pub_fn: "double:3", pub_dot: "double:3", open_inst: "double:5", open_class: "double:5",
    pk_inside: "double:7", pk_insideDot: "double:7", pk_ownconst: "[42 42]", pk_ownconst2: "double:42", pk_ownstatic: "double:11",
    pk_viaHandle: "double:7", pk_folder: "[6 8 8]", pk_pub: "double:3" };
  for (const [k, w] of Object.entries(allowed)) assert.equal(got.get(k), w, k);
  const method = "ERROR|MATLAB:class:MethodRestricted|Cannot access method";
  const prop = "ERROR|MATLAB:class:GetProhibited|No public property";
  for (const k of ["private_dot", "private_function", "private_static_instance", "private_static_class", "folder_outside_method", "handle_outside",
    "pk_private_dot", "pk_private_function", "pk_private_static_class", "pk_handle_outside"])
    assert.ok(got.get(k)?.startsWith(method), `${k}: ${got.get(k)}`);
  for (const k of ["private_const_instance", "private_const_class", "folder_outside_prop", "pk_private_const_class", "pk_folder_outside_prop"]) assert.ok(got.get(k)?.startsWith(prop), `${k}: ${got.get(k)}`);
});

test("a handle made before a class loads: called with its object, the method; with a number, the function it was", () => {
  // (the class registry's generation: a resolution made before the class loaded is made again)
  const dir = tree({ ...FILES, "sub/scaleit.m": lines("function r = scaleit(x)", "  r = 'path scaleit';", "end"),
    "Sc.m": lines("classdef Sc", "  properties", "    w = 2", "  end", "  methods", "    function r = scaleit(obj)", "      r = obj.w * 10;", "    end", "  end", "end") });
  const r = run(dir, lines("addpath('sub');", "h = @scaleit;", "fprintf('before|%s\\n', h(3));", "s = Sc;",
    "fprintf('after|%g\\n', h(s));", "fprintf('again|%s\\n', h(3));"));
  assert.equal(r.err, "");
  assert.equal(r.out, "before|path scaleit\nafter|20\nagain|path scaleit\n");
});
