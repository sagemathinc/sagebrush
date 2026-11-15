import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// Sage's load() and attach() (lib/sage_all.py): load runs a .sage file
// preparsed, or a .py file, in the session's namespace; attach loads it again
// before the next cell whenever it has changed (sage-tests/test_load.sage
// compares load with Sage itself).

async function session() {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  let id = 1000 * Math.floor(Math.random() * 1000);
  return {
    async run(code: string) {
      const n = ++id;
      await s.handle({ id: n, code, sage: true });
      const out = msgs.filter((m) => m.id === n && m.stream === "stdout").map((m) => m.text).join("");
      const err = msgs.filter((m) => m.id === n && m.stream === "stderr").map((m) => m.text).join("");
      return { out, err };
    },
  };
}

test("attach: a changed file is loaded again before the next cell, until detach", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-attach-"));
  const file = join(dir, "params.sage");
  let mtime = 1_000_000;
  const write = (src: string) => { writeFileSync(file, src); utimesSync(file, (mtime += 1000), mtime); };
  write("k = 2^3\n");
  const s = await session();
  assert.deepEqual(await s.run(`attach(${JSON.stringify(file)})\nprint(k, [p == ${JSON.stringify(file)} for p in attached_files()])`), { out: "8 [True]\n", err: "" });
  // unchanged: nothing is loaded again
  assert.deepEqual(await s.run("k = 0\nprint(k)"), { out: "0\n", err: "" });
  assert.deepEqual(await s.run("print(k)"), { out: "0\n", err: "" });
  // changed: loaded again, preparsed, before the cell runs
  write("k = 2^4\nj = 1/2\n");
  const r = await s.run("print(k, j)");
  assert.match(r.out, /^### reloading attached file params\.sage modified at \d\d:\d\d:\d\d ###\n16 1\/2\n$/);
  // an error in the file is reported, and the cell still runs
  write("k = 1/0\n");
  const e = await s.run("print('cell ran', k)");
  assert.match(e.out, /### reloading attached file params\.sage .*###\ncell ran 16\n/);
  assert.match(e.err, /ZeroDivisionError/);
  // detach: no more reloading
  assert.deepEqual(await s.run(`detach(${JSON.stringify(file)})\nprint(attached_files())`), { out: "[]\n", err: "" });
  write("k = 99\n");
  assert.deepEqual(await s.run("print(k)"), { out: "16\n", err: "" });
});

test("load: a relative name is in the running script's folder, from any working directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-load-"));
  mkdirSync(join(dir, "work"));
  writeFileSync(join(dir, "work", "lib.sage"), "def sq(x):\n    return x^2\n");
  writeFileSync(join(dir, "work", "lib2.py"), "w = 5 ^ 1\n");
  writeFileSync(join(dir, "work", "main.sage"), 'load("lib.sage")\nload("lib2.py")\nprint(sq(3), w, sq(1/2))\n');
  const run = (cwd: string, script: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--sage", script], { cwd, encoding: "utf8" });
  assert.equal(run(dir, "work/main.sage"), "9 4 1/4\n");
  assert.equal(run(tmpdir(), join(dir, "work", "main.sage")), "9 4 1/4\n");
});
