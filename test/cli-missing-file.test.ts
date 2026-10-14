import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A file the CLI can't read: CPython's message and exit status 2, not a
// Node stack trace.
const cli = (args: string[]) => spawnSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });

test("a missing script: can't open file, [Errno 2], exit 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-missing-"));
  try {
    const f = join(dir, "nosuchfile.py");
    for (const args of [[f], ["--emit", f], ["--matlab", f]]) {
      const r = cli(args);
      assert.equal(r.status, 2, args.join(" ") + ": " + r.stderr);
      assert.equal(r.stderr, `sagebrush: can't open file '${f}': [Errno 2] No such file or directory\n`);
      assert.ok(!/\bat \w|node:fs/.test(r.stderr), "no stack trace");
    }
    const d = cli([dir]);
    assert.equal(d.status, 2);
    assert.match(d.stderr, /\[Errno 21\] Is a directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
