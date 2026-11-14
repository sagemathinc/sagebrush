import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A program piped on stdin runs in the mode its flag names, in each of the four
// modes (src/cli.ts): Python, --sage, --magma and --matlab, `-` naming stdin too.
const cli = __dirname + "/../src/cli.js";
const run = (args: string[], input: string) => spawnSync(process.execPath, [cli, ...args], { input, encoding: "utf8" });

test("a program on stdin runs in each mode: Python, Sage, Magma and MATLAB", () => {
  const cases: [string[], string, string][] = [
    [[], "print(2**10)\n", "1024\n"],
    [["-"], "print(2**10)\n", "1024\n"],
    [["--sage"], "print(2^10)\n", "1024\n"],
    [["--magma"], "print 2^10;\n", "1024\n"],
    [["--matlab"], "x = [1 2 3];\ndisp(sum(x))\n", "     6\n"],
    [["--matlab", "-"], "x = [1 2 3];\ndisp(sum(x))\n", "     6\n"],
    [["--matlab"], "y = 2 * 3\n", "\ny =\n\n     6\n\n"],
  ];
  for (const [args, input, out] of cases) {
    const r = run(args, input);
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, out, ""], `${args.join(" ") || "(no flag)"}: ${JSON.stringify(input)}`);
  }
});

test("MATLAB on stdin stops at its first error with exit status 1, and reports a syntax error with its line", () => {
  const r = run(["--matlab"], "disp(1)\nerror('boom')\ndisp(2)\n");
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "     1\n");
  assert.match(r.stderr, /boom/);
  const s = run(["--matlab"], "disp(1)\nx = (1 +\n");
  assert.equal(s.status, 1);
  assert.equal(s.stdout, "");
  assert.match(s.stderr, /^line \d+\nunexpected end of input\n/);
  // (a local function after the script's statements, as a script file may have)
  const f = run(["--matlab"], "disp(twice(4))\nfunction y = twice(x)\n  y = 2 * x;\nend\n");
  assert.deepEqual([f.status, f.stdout], [0, "     8\n"]);
});

test("--matlab FILE.m and a .m file still run as MATLAB; a syntax error in a file or -c code gives exit status 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-stdin-"));
  try {
    const file = join(dir, "prog.m");
    writeFileSync(file, "x = [1 2 3];\ndisp(sum(x))\n");
    for (const args of [["--matlab", file], [file]]) {
      const r = run(args, "");
      assert.deepEqual([r.status, r.stdout, r.stderr], [0, "     6\n", ""], args.join(" "));
    }
    // (a syntax error, in a file or in -c code: reported, with exit status 1)
    const bad = join(dir, "bad.m");
    writeFileSync(bad, "disp(1)\nx = (1 +\n");
    const b = run(["--matlab", bad], "");
    assert.deepEqual([b.status, b.stdout], [1, ""]);
    assert.match(b.stderr, /bad\.m/);
    const c = run(["--matlab", "-c", "x = = 1"], "");
    assert.equal(c.status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a function file run as the program calls its function with no arguments, as matlab -batch NAME does", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-ffile-"));
  try {
    const put = (name: string, text: string) => (writeFileSync(join(dir, name), text), join(dir, name));
    const ok = (args: string[], out: string, input = "") => {
      const r = run(args, input);
      assert.deepEqual([r.status, r.stdout, r.stderr], [0, out, ""], args.join(" "));
    };
    // (before: the file only defined ff, printed nothing and exited 0)
    const ff = put("ff.m", "function ff()\ndisp('ran')\nend\n");
    ok(["--matlab", ff], "ran\n");
    ok([ff], "ran\n");
    // (a comment first, and a local function the main one calls)
    const m2 = put("m2.m", "% the file's help\nfunction m2()\ndisp(helper(3))\nend\nfunction y = helper(x)\ny = x * 2;\nend\n");
    ok([m2], "     6\n");
    // (an output, unassigned: shown as ans, as the bare call `g2` shows it)
    const g2 = put("g2.m", "function y = g2()\ny = 5;\nend\n");
    ok([g2], "\nans =\n\n     5\n\n");
    // (an error inside: exit status 1, and the report has the function's frame only, none for the call)
    const e = run([put("bad1.m", "function bad1()\ndisp(1)\nerror('boom')\nend\n")], "");
    assert.deepEqual([e.status, e.stdout], [1, "     1\n"]);
    assert.match(e.stderr, /boom/);
    assert.match(e.stderr, /Error in bad1 \(line 3\)/);
    assert.equal(e.stderr.match(/Error in /g)?.length, 1, e.stderr);
    // (a script, and a script with local functions at its end, run as before)
    const sc = put("sc.m", "disp(twice(4))\nfunction y = twice(x)\n  y = 2 * x;\nend\n");
    ok([sc], "     8\n");
    // (no function, nothing to call: an empty file and a comment-only one run as empty programs)
    ok([put("empty.m", "")], "");
    ok([put("comments.m", "% only a comment\n%{\nand a block one\n%}\n")], "");
    // (--emit shows the call; MATLAB on stdin is a program, not a file, so only functions there still run nothing)
    assert.match(run(["--emit", ff], "").stdout, /_m\.call\(ff, \[\], 0\)/);
    ok(["--matlab"], "", "function f()\ndisp(1)\nend\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a program on stdin past 8 MiB is refused before it is kept, in each mode, under a 96 MiB heap", () => {
  // (9 MiB of statements: the reader stops at the chunk that crosses 8 MiB, so the rest of
  // the input may be left unread, and writing it can fail with EPIPE)
  const big = "x = 1;\n".repeat(Math.ceil((9 << 20) / 7));
  for (const args of [["--matlab"], ["--matlab", "-"], ["--magma"], ["--sage"], []]) {
    const r = spawnSync(process.execPath, ["--max-old-space-size=96", cli, ...args], { input: big, encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, 1, `${args.join(" ") || "(no flag)"}: ${r.stderr}`);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /the program on stdin is more than 8 MiB: not supported/);
  }
  // (one under the limit still runs: a Python program under the same heap, about 19 MB
  // live at its peak on Node 24; and a MATLAB one under 192 MiB, since MATLAB's runtime
  // alone holds 75 to 94 MB live while it starts on Node 24, whatever the program, and
  // fails under 88 MiB: under 96 its margin was a few MB, and GitHub's runner ran out
  // of it on 26817895)
  const p = spawnSync(process.execPath, ["--max-old-space-size=96", cli], { input: "x = 1\n".repeat(2000) + "print(x)\n", encoding: "utf8", timeout: 60000 });
  assert.deepEqual([p.status, p.stdout], [0, "1\n"], `signal ${p.signal}; ${p.stderr.slice(0, 300)}`);
  const r = spawnSync(process.execPath, ["--max-old-space-size=192", cli, "--matlab"], { input: "x = 1;\n".repeat(2000) + "disp(x)\n", encoding: "utf8", timeout: 60000 });
  assert.deepEqual([r.status, r.stdout], [0, "     1\n"], `signal ${r.signal}; ${r.stderr.slice(0, 300)}`);
});

// An interactive terminal (#648): `sagebrush --magma` and `sagebrush --matlab` at a prompt speak Magma and MATLAB,
// as the kernel's cells do, and an error is reported while the session goes on.  Run under a pseudo-terminal with
// util-linux script(1), so stdin is a TTY; the typed lines are echoed, and the output is read without the
// terminal's control sequences.
const tty = (args: string[], input: string) => {
  const cmd = [process.execPath, cli, ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const r = spawnSync("script", ["-qec", cmd, "/dev/null"], { input, encoding: "utf8", timeout: 60000 });
  return { status: r.status, out: (r.stdout ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, ""), err: r.error };
};
// tty's, with the input typed in steps, each sent only once the session is ready for it (no fixed sleeps: a
// key typed before readline's raw mode is on, or in the same chunk as other text, reaches the program literally):
// the first step after the prompt, a line's next step after the next prompt, a Tab after the text before it
// has been echoed, and the step after a Tab once readline has answered it (its completion, its list, or nothing
// for a Tab that has neither, so then only a short pause). A stalled step gives up after 15 s, and the
// assertions then see the transcript.
const ttySteps = (args: string[], steps: string[], prompt: string): Promise<{ status: number | null; out: string; err?: Error }> => {
  const cmd = [process.execPath, cli, ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  // (TERM set: readline doesn't complete on a dumb terminal, and a CI runner's TERM may be dumb or unset)
  const child = spawn("script", ["-qec", cmd, "/dev/null"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, TERM: "xterm" } });
  const clean = (t: string) => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
  let raw = "";
  let wake: (() => void) | null = null;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d: string) => {
    raw += d;
    wake?.();
  });
  const closed = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  // until(done, ms): true once done(the output since `from`) holds, false after ms without it
  const until = (from: number, done: (since: string) => boolean, ms: number) =>
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false), ms);
      function finish(ok: boolean) {
        clearTimeout(timer);
        wake = null;
        resolve(ok);
      }
      wake = () => done(clean(raw.slice(from))) && finish(true);
      wake();
    });
  const atPrompt = (since: string) => since.endsWith(prompt);
  // (a wait that runs out means the steps would go on out of step with the session: a step typed before its
  // prompt lands with the next in one chunk, where readline doesn't complete a Tab. That is the Magma Tab flake
  // seen on CI, a first prompt slower than the wait. So it ends the session and says which step, rather than
  // typing on; the first prompt, the session's start, may take a slow runner up to a minute)
  const lost = (what: string) => {
    child.kill();
    return closed.then(() => ({ status: null, out: clean(raw), err: new Error(`${what}: not seen in time`) }));
  };
  return (async () => {
    if (!(await until(0, atPrompt, 60000))) return lost("the first prompt");
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i], from = raw.length;
      child.stdin.write(step);
      if (i === steps.length - 1) break;
      // (the first of two Tabs shows nothing, by design: its wait runs out, briefly, and that's fine)
      if (step === "\t" && steps[i + 1] === "\t") await until(from, (since) => since.length > 0, 1000);
      else if (!(await until(from, step.endsWith("\n") ? atPrompt : step === "\t" ? (since) => since.length > 0 : (since) => since.includes(step), 15000)))
        return lost(`step ${i} (${JSON.stringify(step)}): its ${step.endsWith("\n") ? "prompt" : step === "\t" ? "completion" : "echo"}`);
    }
    child.stdin.end();
    // (a session that doesn't end within 30 s is killed; the timer is cleared once it ends, so it holds nothing open)
    const kill = setTimeout(() => child.kill(), 30000);
    const status = await closed;
    clearTimeout(kill);
    return { status, out: clean(raw) };
  })();
};
const hasScript = process.platform === "linux" && spawnSync("script", ["--version"], { encoding: "utf8" }).status === 0;

test("an interactive --magma session: Magma at a > prompt, statements wait for their ;, an error and the session goes on", { skip: !hasScript && "needs util-linux script(1)" }, () => {
  const r = tty(["--magma"], "Factorization(2026);\nx := Foo(3);\ny := 2\n+ 3;\ny;\nfor i in [1..2] do\n  print i;\nend for;\nquit;\n");
  assert.equal(r.status, 0, `${r.err ?? ""}\n${r.out}`);
  assert.match(r.out, /\(Magma\)\n/);
  assert.match(r.out, /> Factorization\(2026\);\n\[ <2, 1>, <1013, 1> \]\n/);
  // (an undeclared identifier, reported as Magma reports it; the next input runs)
  assert.match(r.out, /User error: Identifier 'Foo' has not been declared or assigned\n> y := 2\n/);
  // (a statement without its ; waits for the next line: y is 2 + 3)
  assert.match(r.out, /> y;\n5\n/);
  assert.match(r.out, /end for;\n1\n2\n> quit;/);
  assert.doesNotMatch(r.out, /NameError|Traceback/);
  // (no continuation prompt: the continued line follows bare, as at Magma's prompt; readline's empty prompt may leave a space)
  assert.match(r.out, /> y := 2\n ?\+ 3;\n/);
  // (a syntax error inside a statement is reported at once, not waited on; a comment-only line runs nothing;
  // the session goes on)
  const s = tty(["--magma"], "x := ;\n// note\nprint 5;\nquit;\n");
  assert.equal(s.status, 0, s.out);
  assert.match(s.out, /> x := ;\n[\s\S]*User error: bad syntax[\s\S]*\n> \/\/ note\n> print 5;\n5\n> quit;/);
});

test("an interactive --matlab session: MATLAB at a >> prompt, ... continues a line, an error and the session goes on, exit(n)", { skip: !hasScript && "needs util-linux script(1)" }, () => {
  const r = tty(["--matlab"], "x = rand(2);\nsize(x)\nundefined_thing + 1\ny = [1 2 ...\n3]\nexit(3)\n");
  assert.equal(r.status, 3, `${r.err ?? ""}\n${r.out}`);
  assert.match(r.out, /\(MATLAB\)\n/);
  assert.match(r.out, />> size\(x\)\n\nans =\n\n     2     2\n\n/);
  assert.match(r.out, /Unrecognized function or variable 'undefined_thing'\.\n>> y = \[1 2 \.\.\.\n/);
  assert.match(r.out, /\ny =\n\n     1     2     3\n\n>> exit\(3\)/);
  assert.doesNotMatch(r.out, /NameError|Traceback/);
  // (no continuation prompt: the continued line follows bare, as in MATLAB's command window; readline's empty prompt may leave a space)
  assert.match(r.out, /\.\.\.\n ?3\]\n\ny =/);
  // (a syntax error at the prompt, one with a single reading (an unclosed [ may continue), is reported with its caret
  // and the session goes on)
  const e = tty(["--matlab"], "x = )\ndisp(5)\nexit\n");
  assert.equal(e.status, 0, e.out);
  assert.match(e.out, />> x = \)\nline 1\nunexpected '\)'\n\nx = \)\n    \^\n>> disp\(5\)\n     5\n/);
  // (exit and quit, with or without a status, a semicolon or a comment, end it)
  for (const q of ["exit", "quit;", "quit(0)", "exit % bye"]) assert.equal(tty(["--matlab"], `disp(1)\n${q}\n`).status, 0, q);
  // (a function definition at the prompt is refused with MATLAB's command-window error, and the session goes on)
  const f = tty(["--matlab"], "function y = f(x)\ndisp(7)\nexit\n");
  assert.equal(f.status, 0, f.out);
  assert.match(f.out, /Function definitions are not supported in this context\. Functions can only be created as local or nested functions in code files\.\n>> disp\(7\)\n     7\n/);
});

test("an interactive Python prompt: any SystemExit leaves it with its status, as CPython's; an error keeps it", { skip: !hasScript && "needs util-linux script(1)" }, () => {
  const one = tty([], "x = 1\nexit(1)\nprint('after')\n");
  assert.equal(one.status, 1, one.out);
  assert.ok(!one.out.includes("\nafter"), one.out);
  const bye = tty([], "exit('bye')\nprint('after')\n");
  assert.equal(bye.status, 1, bye.out);
  assert.ok(bye.out.includes("bye\n") && !bye.out.includes("\nafter"), bye.out);
  const zero = tty([], "import sys\nsys.exit(0)\nprint('after')\n");
  assert.equal(zero.status, 0, zero.out);
  assert.ok(!zero.out.includes("\nafter"), zero.out);
  const err = tty([], "raise ValueError('v')\nprint('still')\nexit()\n");
  assert.equal(err.status, 0, err.out);
  assert.ok(err.out.includes("ValueError: v") && err.out.includes("\nstill"), err.out);
});

test("Tab completes MATLAB's names at a --matlab prompt: a variable, and rand's family, never Python's", { skip: !hasScript && "needs util-linux script(1)" }, async () => {
  // (one Tab completes a single match; two list several: readline's. Typed a step at a time: readline doesn't
  // complete a Tab that comes in the same chunk as pasted text)
  const r = await ttySteps(["--matlab"], ["radius = 7;\n", "radi", "\t", "\n", "ran", "\t", "\t", "\n", "exit\n"], ">> ");
  assert.equal(r.status, 0, `${r.err ?? ""}\n${r.out}`);
  assert.match(r.out, />> radius\n\nradius =\n\n     7\n/);
  assert.match(r.out, /rand\s+randi\s+randn\s+randperm/);
  assert.doesNotMatch(r.out, /\braise\b|\brange\b/);
});

test("Tab completes Magma's names at a --magma prompt: a variable, an intrinsic, a list of intrinsics, never Python's", { skip: !hasScript && "needs util-linux script(1)" }, async () => {
  // (typed a step at a time, as for MATLAB above: one Tab completes a single match, two list several)
  const r = await ttySteps(["--magma"], ["my_total := 5;\n", "my_t", "\t", ";\n", "Factoriz", "\t", "(2026);\n", "Prim", "\t", "\t", ";\n", "quit;\n"], "> ");
  assert.equal(r.status, 0, `${r.err ?? ""}\n${r.out}`);
  assert.match(r.out, /> my_total;\n5\n/);
  assert.match(r.out, /> Factorization\(2026\);\n\[ <2, 1>, <1013, 1> \]\n/);
  assert.match(r.out, /PrimeDivisors\s+PrimeField\s+PrimesInInterval\s+PrimesUpTo\s+PrimitiveElement/);
  assert.doesNotMatch(r.out, /\braise\b|\brange\b|MagmaError|NameError|Traceback/);
});
