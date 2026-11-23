import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// input() in a CLI program whose stdin is a pipe or a file (src/runtime/index.ts's builtin, R.stdinInput, which
// src/cli.ts sets): the prompt written, one line read and not echoed, returned without its newline; at the end of
// input EOFError; sys.stdin.read() after it gets the rest. Each expected output is CPython 3.14's.

const CLI = join(__dirname, "../src/cli.js");
const run = (args: string[], input: string | Buffer) => spawnSync(process.execPath, [CLI, ...args], { input, encoding: "utf8", timeout: 120000 });
const READ = "x = input('name? '); print('got', repr(x)); import sys; print(repr(sys.stdin.read()))";

test("a piped line: the prompt, the line without its newline, and sys.stdin.read() the rest", () => {
  const r = run(["-c", READ], "ann\nrest1\nrest2\n");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "name? got 'ann'\n'rest1\\nrest2\\n'\n");
});

test("a last line with no newline is read whole; \\r is kept, as CPython's (no universal newlines on input)", () => {
  assert.equal(run(["-c", READ], "ann").stdout, "name? got 'ann'\n''\n");
  assert.equal(run(["-c", "print(repr(input()), repr(input()))"], "a\r\nb\n").stdout, "'a\\r' 'b'\n");
});

test("at the end of input: the prompt, then EOFError, exit status 1", () => {
  const r = run(["-c", READ], "");
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "name? ");
  assert.match(r.stderr, /EOFError: EOF when reading a line\n$/);
  // (a second input() after the last line: EOFError too)
  const r2 = run(["-c", "print(input())\ninput()"], "one\n");
  assert.equal(r2.stdout, "one\n");
  assert.match(r2.stderr, /EOFError: EOF when reading a line\n$/);
});

test("a program file with stdin from a file, in a loop until EOFError", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-input-"));
  try {
    const prog = join(dir, "prog.py");
    writeFileSync(prog, "total = 0\nwhile True:\n    try:\n        total += int(input())\n    except EOFError:\n        break\nprint(total)\n");
    assert.equal(run([prog], "1\n2\n3\n").stdout, "6\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("UTF-8 split across two reads of stdin is one character (input() and sys.stdin.read() alike)", () => {
  const big = Buffer.concat([Buffer.alloc(65535, "a"), Buffer.from("éz\n", "utf8")]);
  assert.equal(run(["-c", "x = input(); print(len(x), repr(x[-3:]))"], big).stdout, "65537 'aéz'\n");
  assert.equal(run(["-c", "import sys; x = sys.stdin.read(); print(len(x), repr(x[-4:]))"], big).stdout, "65538 'aéz\\n'\n");
});

test("a byte order mark is kept, as CPython's stdin keeps it: at the start, and split across two reads", () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const lead = Buffer.concat([bom, Buffer.from("abc\n")]);
  assert.equal(run(["-c", "print(repr(input()))"], lead).stdout, "'\\ufeffabc'\n");
  assert.equal(run(["-c", "import sys; print(repr(sys.stdin.read()))"], lead).stdout, "'\\ufeffabc\\n'\n");
  // (its bytes at 65535..65537: the first read ends inside it)
  const split = Buffer.concat([Buffer.alloc(65535, "a"), bom, Buffer.from("z\n")]);
  assert.equal(run(["-c", "x = input(); print(len(x), repr(x[-3:]))"], split).stdout, "65537 'a\\ufeffz'\n");
});

test("Sage mode reads it too", () => {
  assert.equal(run(["--sage", "-c", "n = Integer(input('n? ')); print(n^2)"], "12\n").stdout, "n? 144\n");
});
