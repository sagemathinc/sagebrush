import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matlabSyntaxMessage, matlabToPython, MatlabSyntaxError } from "../src/matlab";

// MATLAB in a LaTeX document (lib/_matlab.py's latex_run and latex_inline): items run as the kernel runs a MATLAB
// cell (src/kernel.ts: translated in cell mode, executed in one namespace, the error read back with cell_error()),
// after latex_run() has started the run.  Each refusal's text is board's (Nov 11), pinned exactly.

const CLI = join(__dirname, "..", "src", "cli.js");

type Item = { name: string; code?: string; inline?: string };
type Out = { name: string; output: string; error: string | null; inline?: string; inlineError?: string };

/** The items run in order in one LaTeX run (or, with latex false, in an ordinary session), in cwd. */
function run(items: Item[], cwd: string, latex = true): Out[] {
  const prepared = items.map((it) => {
    const code = it.inline !== undefined ? `sbtx_inline__ = (${it.inline});` : it.code!;
    try {
      return { name: it.name, inline: it.inline !== undefined, py: matlabToPython(code, it.name, { cell: true }), syntax: null as string | null };
    } catch (e) {
      if (!(e instanceof MatlabSyntaxError)) throw e;
      return { name: it.name, inline: it.inline !== undefined, py: null, syntax: matlabSyntaxMessage(e, code, it.name) };
    }
  });
  const driver = `
import io, json, sys
import _matlab
${latex ? "_matlab.latex_run()" : "_matlab.host_shows_errors()"}
ITEMS = json.loads(${JSON.stringify(JSON.stringify(prepared))})
ns = {}
res = []
real = sys.stdout
for it in ITEMS:
    r = {"name": it["name"], "output": "", "error": it["syntax"]}
    if it["py"] is not None:
        buf = io.StringIO()
        sys.stdout = buf
        try:
            exec(it["py"], ns)
        finally:
            sys.stdout = real
        r["output"] = buf.getvalue()
        r["error"] = _matlab.cell_error()
        if it["inline"] and r["error"] is None:
            try:
                r["inline"] = _matlab.latex_inline(ns)
            except ValueError as e:
                r["inlineError"] = str(e)
    res.append(r)
r = {"left": [k for k in ns if k == _matlab.LATEX_INLINE_VAR]}
print(json.dumps({"items": res, "extra": r}))
`;
  const p = spawnSync(process.execPath, [CLI, "-c", driver], { cwd, encoding: "utf8", timeout: 300000, maxBuffer: 1 << 26 });
  assert.equal(p.status, 0, p.stderr);
  const got = JSON.parse(p.stdout.trim().split("\n").pop()!);
  assert.deepEqual(got.extra.left, [], "the inline variable never stays");
  return got.items;
}

function scratch() {
  const d = mkdtempSync(join(tmpdir(), "matlab-latex-"));
  writeFileSync(join(d, "data.txt"), "1 2 3\n");
  return d;
}

const WRITERS: [string, string][] = [
  ["save('out.mat')", "save writes a file, and code in a LaTeX document can't write files. It works in a .m file."],
  ["x = 1; save out.mat x", "save writes a file, and code in a LaTeX document can't write files. It works in a .m file."],
  ["mkdir('newdir')", "mkdir makes a folder, and code in a LaTeX document can't change files or folders. It works in a .m file."],
  ["rmdir('sub')", "rmdir removes a folder, and code in a LaTeX document can't change files or folders. It works in a .m file."],
  ["delete('data.txt')", "delete removes a file, and code in a LaTeX document can't change files or folders. It works in a .m file."],
  ["diary on", "diary writes a log file, and code in a LaTeX document can't write files. It works in a .m file."],
  ["diary('log.txt')", "diary writes a log file, and code in a LaTeX document can't write files. It works in a .m file."],
  ["cd('sub')", "cd changes the current folder, and code in a LaTeX document always runs in the document's folder: use paths relative to it."],
];
const FOPEN = (m: string) => `fopen with '${m}' opens a file for writing, and code in a LaTeX document can't write files. fopen with 'r' still reads.`;

test("a LaTeX run refuses each writer with its line, naming fopen's mode, and changes nothing on disk", () => {
  const d = scratch();
  try {
    mkdirSync(join(d, "sub"));
    const modes = ["w", "a", "r+", "w+", "a+", "W", "A", "wt", "ab"];
    const items: Item[] = [
      ...WRITERS.map(([code], i) => ({ name: `matlabblock ${i + 1}`, code })),
      ...modes.map((m, i) => ({ name: `matlabblock ${WRITERS.length + i + 1}`, code: `f = fopen('new.txt', '${m}');` })),
    ];
    const out = run(items, d);
    WRITERS.forEach(([, line], i) => assert.equal(out[i].error!.split("\n")[0], line, WRITERS[i][0]));
    modes.forEach((m, i) => assert.equal(out[WRITERS.length + i].error!.split("\n")[0], FOPEN(m), m));
    assert.deepEqual(readdirSync(d).sort(), ["data.txt", "sub"], "no file made, removed or changed");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("a LaTeX run still reads: fopen for reading, load, fileread and exist, relative to the folder it runs in; cd alone names it", () => {
  const d = scratch();
  try {
    const out = run([
      { name: "matlabblock 1", code: "f = fopen('data.txt'); s = fgetl(f); fclose(f); disp(s)" },
      { name: "matlabblock 2", code: "g = fopen('data.txt', 'rt'); disp(g > 2); fclose(g);" },
      { name: "matlabblock 3", code: "disp(fileread('data.txt'))" },
      { name: "matlabblock 4", code: "disp(exist('data.txt', 'file'))" },
      { name: "matlabblock 5", code: "x = load('data.txt'); disp(sum(x))" },
      { name: "matlabblock 6", code: "w = cd; disp(strcmp(w, pwd))" },
    ], d);
    assert.deepEqual(out.map((o) => o.error), [null, null, null, null, null, null], JSON.stringify(out.map((o) => o.error)));
    assert.deepEqual(out.map((o) => o.output.trim()), ["1 2 3", "1", "1 2 3", "2", "6", "1"]);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("outside a LaTeX run the writers work as before (a notebook cell's path), and the .m program's too", () => {
  const d = scratch();
  try {
    const out = run([
      { name: "<cell>", code: "x = 1; save('out.mat', 'x');" },
      { name: "<cell>", code: "mkdir('made');" },
      { name: "<cell>", code: "f = fopen('w.txt', 'w'); fprintf(f, 'hi'); fclose(f);" },
      { name: "<cell>", code: "delete('data.txt');" },
      { name: "<cell>", code: "diary on" },
    ], d, false);
    assert.deepEqual(out.map((o) => o.error), [null, null, null, null, null]);
    assert.deepEqual(readdirSync(d).sort(), ["made", "out.mat", "w.txt"]);
    // (a .m program run by the CLI)
    writeFileSync(join(d, "prog.m"), "y = 2; save('prog.mat', 'y'); mkdir('m2'); cd('m2'); disp(pwd)\n");
    const p = spawnSync(process.execPath, [CLI, "prog.m"], { cwd: d, encoding: "utf8", timeout: 300000 });
    assert.equal(p.status, 0, p.stderr);
    assert.ok(existsSync(join(d, "prog.mat")) && existsSync(join(d, "m2")));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("an item's error names the item and its line, and shows the line", () => {
  const d = scratch();
  try {
    const out = run([
      { name: "matlabblock 2", code: "a = 1;\nb = nosuchthing + 1;\nc = 3;" },
      { name: "\\matlab 5", code: "error('Mine:id', 'stopped here')" },
      { name: "matlabblock 3", code: "x = [1 2" },
    ], d);
    assert.equal(out[0].error, "Unrecognized function or variable 'nosuchthing'.\n\nError in matlabblock 2 (line 2)\nb = nosuchthing + 1;\n");
    assert.equal(out[1].error, "stopped here\n\nError in \\matlab 5 (line 1)\nerror('Mine:id', 'stopped here')\n");
    assert.match(out[2].error!, /matlabblock 3/, "a syntax error is the item's error too");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("a figure an item would show is one line instead, with no host lines; a bare figure says nothing", () => {
  const d = scratch();
  try {
    const out = run([
      { name: "matlabblock 1", code: "plot(1:3)" },
      { name: "matlabblock 2", code: "figure" },
      { name: "matlabblock 3", code: "figure; plot([1 2], [3 4]); figure; bar([1 2 3])" },
      { name: "matlabblock 4", code: "x = 1;" },
    ], d);
    const LINE = "Figures aren't shown in LaTeX yet: this plot isn't drawn.\n";
    assert.equal(out[0].output, LINE);
    assert.equal(out[1].output, "");
    assert.equal(out[2].output, LINE + LINE);
    assert.equal(out[3].output, "", "a figure shown once isn't shown again");
    assert.deepEqual(readdirSync(d).sort(), ["data.txt"], "no picture written");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("latex_run starts a new session: the generator, globals, format, files and warnings as a session begins", () => {
  const d = scratch();
  try {
    const first = run([{ name: "matlabblock 1", inline: "rand" }], d);
    const again = run([
      { name: "matlabblock 1", code: "global G; G = 5; format long; rand(3); warning('off', 'all');" },
    ], d);
    assert.equal(again[0].error, null);
    // (in one process: a second latex_run resets what the first left)
    const p = spawnSync(process.execPath, [CLI, "-c", `
import json, _matlab
_matlab.latex_run()
ns = {}
exec(${JSON.stringify(matlabToPython("global G; G = 5; format long; r = rand; warning('off', 'all'); f = fopen('data.txt');", "b", { cell: true }))}, ns)
_matlab.latex_run()
ns = {}
exec(${JSON.stringify(matlabToPython("global G; sbtx_inline__ = (rand);", "b", { cell: true }))}, ns)
print(json.dumps({"rand": _matlab.latex_inline(ns), "G": _matlab._globals.get("G") is None or _matlab._numel(_matlab._globals["G"]) == 0,
                  "format": _matlab._format["num"], "files": len(_matlab._files), "warn": _matlab._warn_all[0]}))
`], { cwd: d, encoding: "utf8", timeout: 300000 });
    assert.equal(p.status, 0, p.stderr);
    const r = JSON.parse(p.stdout.trim().split("\n").pop()!);
    assert.deepEqual(r, { rand: first[0].inline, G: true, format: "short", files: 0, warn: "on" });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("latex_inline: a number, a logical value or text, without disp's padding; everything else refused with its line", () => {
  const d = scratch();
  try {
    const exprs: [string, string | null, string | null][] = [
      ["pi", "3.1416", null],
      ["true", "1", null],
      ["int8(-5)", "-5", null],
      ["1 + 2i", "1.0000 + 2.0000i", null],
      ["'abc'", "abc", null],
      ["''", "", null],
      ['"a string"', "a string", null],
      ["1e10", "1.0000e+10", null],
      ["{1}", null, "\\matlab{…} can't show a cell array: it shows a number, a logical value or text."],
      ["struct('a', 1)", null, "\\matlab{…} can't show a struct: it shows a number, a logical value or text."],
      ["@sin", null, "\\matlab{…} can't show an object: it shows a number, a logical value or text."],
      ["['ab'; 'cd']", null, "\\matlab{…} can't show a char matrix with more than one row: it shows one line of text."],
      ["[]", null, "\\matlab{…} can't show an empty value: it shows a number, a logical value or text."],
      ["zeros(0, 3)", null, "\\matlab{…} can't show an empty value: it shows a number, a logical value or text."],
      ["[1 2]", null, "\\matlab{…} can't show an array of more than one element: it shows a number, a logical value or text."],
    ];
    const out = run(exprs.map(([e], i) => ({ name: `\\matlab ${i + 1}`, inline: e })), d);
    exprs.forEach(([e, text, err], i) => {
      assert.equal(out[i].error, null, e);
      if (text !== null) assert.equal(out[i].inline, text, e);
      else assert.equal(out[i].inlineError, err, e);
    });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("a statement given inline: its own line, naming the statement and its variable", () => {
  const p = spawnSync(process.execPath, [CLI, "-c", `
import json, _matlab
print(json.dumps([_matlab.latex_statement_message(s) for s in ("x = 3", "total = a + b;", "a, b")]))
`], { encoding: "utf8", timeout: 300000 });
  assert.equal(p.status, 0, p.stderr);
  assert.deepEqual(JSON.parse(p.stdout.trim().split("\n").pop()!), [
    "\\matlab{…} shows the value of an expression, not a statement: put x = 3 in a block before it, and write \\matlab{x}.",
    "\\matlab{…} shows the value of an expression, not a statement: put total = a + b in a block before it, and write \\matlab{total}.",
    "\\matlab{…} shows the value of an expression, not a statement: put the statement in a block before it.",
  ]);
  // (and such an item does fail to translate as an expression: the adapter's cue)
  assert.throws(() => matlabToPython("sbtx_inline__ = (x = 3);", "\\matlab 1", { cell: true }), MatlabSyntaxError);
});

test("keyboard, in every run: it isn't in Sagebrush, and the error says to remove it", () => {
  const d = scratch();
  try {
    const out = run([{ name: "<cell>", code: "keyboard" }], d, false);
    assert.equal(out[0].error, "Unrecognized function or variable 'keyboard'. keyboard is not in Sagebrush; instead: remove it (there is no debugger)\n");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
