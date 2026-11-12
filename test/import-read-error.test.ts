import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A module file the import system finds but can't read: the OSError open() raises on it, as CPython's loader
// raises, never an internal error (src/compile.ts's source read; a shared file not matching its SHA-256 is the
// browser's case, web/share/test-share-mount-eio.mjs). Compared with CPython line by line.
const TEST = __dirname + "/../../test/";
const root = typeof process.getuid === "function" && process.getuid() === 0;
test("as CPython's: import_read_error_cases.py (an unreadable module file)", { skip: root && "root reads a mode-000 file" }, () => {
  const d = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "import-read-"));
  try {
    writeFileSync(join(d, "locked.py"), "X = 1\n");
    chmodSync(join(d, "locked.py"), 0);
    const name = "import_read_error_cases.py";
    const want = execFileSync("python3", ["-I", TEST + name, d], { encoding: "utf8" }).split("\n");
    const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name, d], { encoding: "utf8" }).split("\n");
    for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
