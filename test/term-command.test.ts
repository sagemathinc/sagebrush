import test from "node:test";
import assert from "node:assert/strict";
import { readCommand, PYTHON_VERSION, type Plan } from "../src/term-command";

// The Terminal's command lines, read (src/term-command.ts, plan-term-3a r1.7 §1).  The python rows' words and statuses
// are CPython 3.14.10's own, as `exec -a python3 python3.14 ARGS </dev/null` prints them (checked by hand against the
// local oracle build; part (b2)'s generator records them with provenance).  Nothing runs here: these are the plans.

const W = "/w/sub";
const py = (args: string[], piped = false, name: "python" | "python3" = "python3") => readCommand(name, args, W, piped);
const said = (p: Plan) => (p.run ? null : { code: p.code, stdout: p.stdout, stderr: p.stderr });
const usage = (n: string) => `usage: ${n} [option] ... [-c cmd | -m mod | file | -] [arg] ...\nTry \`python -h' for more information.\n`;

test("python FILE, -c, -, a pipe: the plan's source, sys.argv and sys.path[0], as CPython's", () => {
  assert.deepEqual(py(["a.py", "x y", "-c"]), { run: true, mode: "python", argv0: "python3", source: { kind: "file", path: "/w/sub/a.py", shown: "/w/sub/a.py", typed: "a.py" }, argv: ["a.py", "x y", "-c"], path0: "/w/sub" });
  assert.deepEqual(py(["../t/b.py"]), { run: true, mode: "python", argv0: "python3", source: { kind: "file", path: "/w/t/b.py", shown: "/w/t/b.py", typed: "../t/b.py" }, argv: ["../t/b.py"], path0: "/w/t" });
  assert.deepEqual(py(["-c", "print(1)", "--", "-x"]), { run: true, mode: "python", argv0: "python3", source: { kind: "code", code: "print(1)" }, argv: ["-c", "--", "-x"], path0: "" });
  assert.deepEqual(py(["-", "a"]), { run: true, mode: "python", argv0: "python3", source: { kind: "stdin" }, argv: ["-", "a"], path0: "" });
  assert.deepEqual(py([], true), { run: true, mode: "python", argv0: "python3", source: { kind: "stdin" }, argv: [""], path0: "" });
  // (`--` ends the options: a file named -c)
  assert.deepEqual(py(["--", "-c"]), { run: true, mode: "python", argv0: "python3", source: { kind: "file", path: "/w/sub/-c", shown: "/w/sub/-c", typed: "-c" }, argv: ["-c"], path0: "/w/sub" });
});

test("python's clustered flags, read left to right as CPython does: -c takes the rest of the word", () => {
  assert.deepEqual(py(["-cprint(5)"]), { run: true, mode: "python", argv0: "python3", source: { kind: "code", code: "print(5)" }, argv: ["-c"], path0: "" });
  assert.deepEqual(py(["-uBc", "print(6)", "z"]), { run: true, mode: "python", argv0: "python3", source: { kind: "code", code: "print(6)" }, argv: ["-c", "z"], path0: "", noBytecode: true });
  // (CPython: -cu 'print(7)' runs the code "u")
  assert.deepEqual(py(["-cu", "print(7)"]), { run: true, mode: "python", argv0: "python3", source: { kind: "code", code: "u" }, argv: ["-c", "print(7)"], path0: "" });
  assert.deepEqual(py(["-u", "-B", "f.py"]), { run: true, mode: "python", argv0: "python3", source: { kind: "file", path: "/w/sub/f.py", shown: "/w/sub/f.py", typed: "f.py" }, argv: ["f.py"], path0: "/w/sub", noBytecode: true });
});

test("python's answers at once: version, help, usage errors, refusals, the alone-line", () => {
  assert.deepEqual(said(py(["-V"])), { code: 0, stdout: PYTHON_VERSION + "\n", stderr: "" });
  assert.deepEqual(said(py(["--version"])), { code: 0, stdout: "Python 3.14.10\n", stderr: "" });
  assert.deepEqual(said(py(["-c"])), { code: 2, stdout: "", stderr: "Argument expected for the -c option\n" + usage("python3") });
  assert.deepEqual(said(py(["-Q"])), { code: 2, stdout: "", stderr: "Unknown option: -Q\n" + usage("python3") });
  assert.deepEqual(said(py(["-uQ"])), { code: 2, stdout: "", stderr: "Unknown option: -Q\n" + usage("python3") });
  assert.deepEqual(said(py(["--bogus"])), { code: 2, stdout: "", stderr: "Unknown option: --bogus\n" + usage("python3") });
  // (the usage line's argv0 as typed; the Try line says `python` under both names, as CPython's does)
  assert.deepEqual(said(py(["-Q"], false, "python")), { code: 2, stdout: "", stderr: "Unknown option: -Q\n" + usage("python") });
  for (const a of ["-m", "-mfoo", "-i", "-O", "-OO", "-E", "-I", "-P", "-s", "-S", "-v", "-W", "-Wx", "-X", "-Xdev", "-b", "-bb", "-d", "-x", "-R", "-q", "-uq", "--check-hash-based-pycs", "--help-env", "--help-xoptions", "--help-all", "-VV"])
    assert.deepEqual(said(py([a, "-c", "1"])), { code: 2, stdout: "", stderr: `python3: ${a} isn't available in the Terminal\n` }, a);
  assert.deepEqual(said(py(["-X" + "y".repeat(60)])), { code: 2, stdout: "", stderr: `python3: -X${"y".repeat(38)} isn't available in the Terminal\n` }, "clipped to 40 characters");
  for (const h of ["-h", "-?", "--help"]) {
    const p = said(py([h], false, "python"))!;
    assert.equal(p.code, 0);
    assert.equal(p.stdout, "usage: python [-c cmd | file | -] [arg] ...\nIn Sagebrush's Terminal, python runs a file, -c code, or code from stdin (- or a pipe).\nOptions -u and -B are accepted; other options aren't available here.\n");
  }
  assert.deepEqual(said(py([])), { code: 2, stdout: "", stderr: "python3: the interactive prompt isn't available in the Terminal yet. Run python3 FILE, python3 -c CODE, or pipe code in.\n" });
  // (stdin redirected, even empty: it runs; -u and -B before it too)
  assert.equal(py(["-u"], true).run, true);
});

test("sage: FILE, -c (the words after CODE join it), a pipe; refusals and the alone-line", () => {
  assert.deepEqual(readCommand("sage", ["a.sage", "1"], W, false), { run: true, mode: "sage", argv0: "sage", source: { kind: "file", path: "/w/sub/a.sage", shown: "/w/sub/a.sage", typed: "a.sage" }, argv: ["a.sage", "1"], path0: "/w/sub" });
  assert.deepEqual(readCommand("sage", ["-c", "print(2^3)", "x"], W, false), { run: true, mode: "sage", argv0: "sage", source: { kind: "code", code: "print(2^3) x" }, argv: ["-c"], path0: "" });
  assert.deepEqual(readCommand("sage", [], W, true), { run: true, mode: "sage", argv0: "sage", source: { kind: "stdin" }, argv: [""], path0: "" });
  assert.deepEqual(said(readCommand("sage", ["-c"], W, false)), { code: 0, stdout: "", stderr: "" });
  assert.deepEqual(said(readCommand("sage", ["-n"], W, false)), { code: 2, stdout: "", stderr: "sage: -n isn't available in the Terminal\n" });
  assert.equal(said(readCommand("sage", ["--bogus"], W, false))!.code, 1);
  assert.deepEqual(said(readCommand("sage", [], W, false)), { code: 2, stdout: "", stderr: "sage: the interactive prompt isn't available in the Terminal yet. Run sage FILE, sage -c CODE, or pipe code in.\n" });
});

test("matlab: -batch, FILE.m, -sd, the no-ops; refusals and the alone-line", () => {
  assert.deepEqual(readCommand("matlab", ["-nodesktop", "-batch", "disp(1)"], W, false), { run: true, mode: "matlab", argv0: "matlab", source: { kind: "code", code: "disp(1)" }, argv: [], path0: "" });
  assert.deepEqual(readCommand("matlab", ["-sd", "../t", "s.m"], W, false), { run: true, mode: "matlab", argv0: "matlab", source: { kind: "file", path: "/w/t/s.m", shown: "/w/t/s.m", typed: "s.m" }, argv: ["s.m"], path0: "/w/t", startIn: "/w/t" });
  assert.deepEqual(said(readCommand("matlab", ["-batch", "x", "-r", "y"], W, false)), { code: 2, stdout: "", stderr: "matlab: -batch and -r can't be used together\n" });
  assert.deepEqual(said(readCommand("matlab", ["-batch"], W, false)), { code: 2, stdout: "", stderr: 'matlab: -batch needs code or a script name, as in matlab -batch "disp(1)"\n' });
  assert.deepEqual(said(readCommand("matlab", ["-r", "x"], W, false)), { code: 2, stdout: "", stderr: "matlab: -r isn't available in the Terminal\n" });
  assert.deepEqual(said(readCommand("matlab", ["s.m", "extra"], W, false)), { code: 2, stdout: "", stderr: "matlab: words after a script name aren't available in the Terminal\n" });
  assert.deepEqual(said(readCommand("matlab", [], W, false)), { code: 2, stdout: "", stderr: "matlab: the interactive prompt isn't available in the Terminal yet. Run matlab -batch CODE, matlab FILE.m, or pipe code in.\n" });
  assert.equal(readCommand("matlab", [], W, true).run, true);
});

test("magma: files in order, name:=value, -b and -n accepted; refusals and the alone-line", () => {
  assert.deepEqual(readCommand("magma", ["-b", "a.m", "n:=5", "b.m"], W, false), {
    run: true, mode: "magma", argv0: "magma", source: { kind: "file", path: "/w/sub/a.m", shown: "/w/sub/a.m", typed: "a.m" }, argv: ["-b", "a.m", "n:=5", "b.m"], path0: W,
    more: [{ kind: "file", path: "/w/sub/b.m", shown: "/w/sub/b.m", typed: "b.m" }], vars: [["n", "5"]],
  });
  assert.deepEqual(said(readCommand("magma", ["-d"], W, false)), { code: 2, stdout: "", stderr: "magma: -d isn't available in the Terminal\n" });
  assert.equal(said(readCommand("magma", ["--bogus"], W, false))!.code, 1);
  // (an option Magma doesn't have: Magma 2.18-5's usage line, on stderr, status 1, nothing run; @sagebrush-magma's record,
  // with `magma` for the internal magma.exe)
  const usage = "Usage: magma [-d] [-l limit] [-b] [-n] [-s startfile] [-S seed] [-r workspace] [-c package] [-q directory machine] [filelist]\n";
  for (const argv of [["-Z", "file.m"], ["-Z"], ["--foo"], ["--foo", "file.m"]]) assert.deepEqual(said(readCommand("magma", argv, W, false)), { code: 1, stdout: "", stderr: usage }, argv.join(" "));
  assert.deepEqual(said(readCommand("magma", [], W, false)), { code: 2, stdout: "", stderr: "magma: the interactive prompt isn't available in the Terminal yet. Run magma FILE, or pipe code in.\n" });
  assert.deepEqual(readCommand("magma", ["x:=1"], W, true), { run: true, mode: "magma", argv0: "magma", source: { kind: "stdin" }, argv: [""], path0: W, vars: [["x", "1"]] });
});

test("a bare python, sage, matlab or magma at the person's own Terminal line (interactive) is a prompt plan; every other form keeps its answer", () => {
  const prompt = (name: "python" | "python3" | "sage" | "matlab" | "magma", args: string[] = []) => readCommand(name, args, W, false, true);
  assert.deepEqual(prompt("python3"), { run: true, mode: "python", argv0: "python3", source: { kind: "prompt" }, argv: [""], path0: "" });
  assert.deepEqual(prompt("python"), { run: true, mode: "python", argv0: "python", source: { kind: "prompt" }, argv: [""], path0: "" });
  // (the options a prompt accepts are the line's: -B and -u, as CPython's interactive python)
  assert.deepEqual(prompt("python3", ["-B"]), { run: true, mode: "python", argv0: "python3", source: { kind: "prompt" }, argv: [""], path0: "", noBytecode: true });
  assert.deepEqual(prompt("sage"), { run: true, mode: "sage", argv0: "sage", source: { kind: "prompt" }, argv: [""], path0: "" });
  assert.deepEqual(prompt("matlab", ["-nodesktop", "-sd", "../t"]), { run: true, mode: "matlab", argv0: "matlab", source: { kind: "prompt" }, argv: [""], path0: "", startIn: "/w/t" });
  assert.deepEqual(prompt("magma", ["n:=3"]), { run: true, mode: "magma", argv0: "magma", source: { kind: "prompt" }, argv: [""], path0: W, vars: [["n", "3"]] });
  // (interactive changes only the bare form: a file, -c, -batch, a pipe and every refusal read as before)
  assert.equal((prompt("python3", ["a.py"]) as any).source.kind, "file");
  assert.equal((prompt("sage", ["-c", "1"]) as any).source.kind, "code");
  assert.equal((prompt("matlab", ["-batch", "disp(1)"]) as any).source.kind, "code");
  assert.deepEqual(said(prompt("sage", ["-n"])), { code: 2, stdout: "", stderr: "sage: -n isn't available in the Terminal\n" });
  assert.deepEqual(readCommand("python3", [], W, true, true), { run: true, mode: "python", argv0: "python3", source: { kind: "stdin" }, argv: [""], path0: "" });
  // (not interactive, which is the default: the alone-line refusal, byte for byte as before)
  for (const n of ["python3", "sage", "matlab", "magma"] as const) {
    const was = readCommand(n, [], W, false);
    assert.equal(was.run, false, n);
    assert.deepEqual(readCommand(n, [], W, false, false), was, n);
    assert.match((was as any).stderr, /the interactive prompt isn't available in the Terminal yet/, n);
  }
});
