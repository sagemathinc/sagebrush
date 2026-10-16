import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  // (one under the limit still runs, under the same heap)
  const r = spawnSync(process.execPath, ["--max-old-space-size=96", cli, "--matlab"], { input: "x = 1;\n".repeat(2000) + "disp(x)\n", encoding: "utf8", timeout: 60000 });
  assert.deepEqual([r.status, r.stdout], [0, "     1\n"], `signal ${r.signal}; ${r.stderr.slice(0, 300)}`);
});
