import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// time (lib/time.py over the _time builtin), compared with CPython 3.14 on
// glibc (S2 of the stdlib the curated PyPI packages need). Each case file runs under the same TZ on both sides; on a
// zone other than UTC or GMT, what is not known here is refused, checked
// apart from CPython.
const TEST = __dirname + "/../../test/";
const run = (cmd: string, args: string[], tz: string) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TZ: tz }, maxBuffer: 64 << 20 }).split("\n");
const sagebrush = (file: string, tz: string) => run(process.execPath, [__dirname + "/../src/cli.js", TEST + file], tz);
const cpython = (file: string, tz: string) => run("python3", [TEST + file], tz);
function same(file: string, tz: string) {
  const want = cpython(file, tz), got = sagebrush(file, tz);
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${file} under TZ=${tz}, line ${i + 1}`);
}

for (const file of ["time_cases.py", "strftime_cases.py"])
  test(`${file}: CPython's output under TZ=UTC`, () => same(file, "UTC"));
