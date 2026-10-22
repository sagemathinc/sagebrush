import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A SyntaxError shows where it was found, as CPython 3.14 does: the file and
// line, the line, and carets under it (traceback's _format_syntax_error), in
// traceback.format_exception_only, in a program's uncaught error and in a
// notebook cell's.  Each compared with what CPython prints.
const TEST = __dirname + "/../../test/";
const cli = __dirname + "/../src/cli.js";

test("traceback.format_exception_only of a SyntaxError gives its location lines, as CPython's", () => {
  const name = "syntax_error_location_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" });
  const got = execFileSync(process.execPath, [cli, TEST + name], { encoding: "utf8" });
  const w = want.split("\n"), g = got.split("\n");
  for (let i = 0; i < Math.max(w.length, g.length); i++) assert.equal(g[i], w[i], `${name} line ${i + 1}`);
});

test("a program with a syntax error: its location on stderr, as CPython's, and exit status 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-synloc-"));
  try {
    for (const [i, src] of ["def f(x):\n    y =  # fill in\n    return y\n", "if x:\n    pass\n  else:\n    pass\n", "total = sum(\n"].entries()) {
      const file = join(dir, `prog${i}.py`);
      writeFileSync(file, src);
      const want = spawnSync("python3", [file], { encoding: "utf8" });
      const got = spawnSync(process.execPath, [cli, file], { encoding: "utf8" });
      assert.deepEqual([got.status, got.stdout, got.stderr], [want.status, want.stdout, want.stderr], src);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a notebook cell with a syntax error shows its location", async () => {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  const src = "def f(x):\n    y =  # fill in\n    return y\n";
  await s.handle({ id: 1, code: src });
  const err = msgs.filter((m) => m.id === 1 && m.stream === "stderr").map((m) => m.text).join("");
  const want = execFileSync("python3", ["-c", "import sys, traceback\ntry:\n    compile(sys.argv[1], '<cell>', 'exec')\nexcept SyntaxError as e:\n    print(''.join(traceback.format_exception_only(e)), end='')", src], { encoding: "utf8" });
  assert.equal(err, want);
  assert.ok(msgs.find((m) => m.id === 1 && m.done)?.error);
});
