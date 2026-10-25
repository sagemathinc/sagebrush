import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";

// int() from text in a small heap (plan-int-digit-oom r4, after master's
// int-digit-limits OOM, Oct 25): memory admission comes before any copy of
// the text, so a literal too large for the session is a MemoryError, never
// V8's fatal out-of-memory; the invalid-literal error is cut at 200 code
// points without the whole repr.  Each case runs in its own fresh child, in
// a heap calibrated on VM1 (the input fits with headroom; the code before
// this fix, which copied the text first, died of OOM or gave a wrong result
// there).
const DIST = __dirname + "/..";
const CLI = DIST + "/src/cli.js";
const TEST = __dirname + "/../../test/";

test("int() from text: the grammar, the bases, the inputs and the error's operand, as CPython 3.14's", () => {
  const name = "int_parse_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" }).split("\n");
  const got = execFileSync(process.execPath, [CLI, TEST + name], { encoding: "utf8" }).split("\n");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
});

// (each: the heap in MiB, the input, the operation, its exact outcome)
const MSG = (digits: number, mib: number, heap: number) => `MemoryError converting an int of about ${digits} digits needs about ${mib} MiB, more than this session's ${heap} MiB`;
const cases: [string, number, string, string, string][] = [
  ["ASCII decimal", 64, "s = '1' * 40_000_000", "int(s)", MSG(40000000, 140, 64)],
  // (the small piece first: a big str + a small one, then used, is two flat copies in pyjs)
  ["underscores", 64, "s = '1' + '_1' * 20_000_000", "int(s)", MSG(20000001, 70, 64)],
  ["whitespace", 64, "s = ' ' + '1' * 40_000_000", "int(s)", MSG(40000000, 140, 64)],
  ["non-ASCII digits", 64, "s = '\\u0661' * 20_000_000", "int(s)", MSG(20000000, 70, 64)],
  ["bytes", 48, "s = b'1' * 40_000_000", "int(s)", MSG(40000000, 140, 48)],
  ["bytearray", 48, "s = bytearray(b'1' * 40_000_000)", "int(s)", MSG(40000000, 140, 48)],
  ["invalid", 64, "s = 'x' + '1' * 40_000_000", "int(s)", "ValueError invalid literal for int() with base 10: 'x" + "1".repeat(198)],
  ["invalid bytes", 48, "s = b'1' * 40_000_000 + b'x'", "int(s)", "ValueError invalid literal for int() with base 10: b'" + "1".repeat(198)],
  ["a power-of-two base", 80, "s = '1' * 22_000_000", "int(s, 16)", MSG(22000000, 84, 80)],
  ["a negative int's decimal digits", 32, "s = -(1 << 100_000_000)", "str(s)", MSG(30103000, 106, 32)],
];
for (const [label, heap, input, op, want] of cases) {
  test(`in a ${heap} MiB heap, ${label}: ${want.split(" ")[0]}, never V8's out-of-memory`, () => {
    const code = `${input}\ntry:\n    r = ${op}\n    print('converted')\nexcept Exception as e:\n    print(type(e).__name__, str(e))\n`;
    const r = spawnSync(process.execPath, [`--max-old-space-size=${heap}`, CLI, "-c", code], { encoding: "utf8", timeout: 120000 });
    assert.equal(r.status, 0, `status ${r.status} ${r.signal ?? ""}\nstdout: ${r.stdout.slice(0, 400)}\nstderr: ${r.stderr.slice(-800)}`);
    assert.equal(r.stdout.trim(), want);
  });
}

// (the scan's own poll: a request already there when int() starts; the
// literal is invalid, so nothing after the scan polls, and only the scan's
// poll can raise)
test("Stop during int()'s scan of a long literal: KeyboardInterrupt from the scan", async () => {
  const w = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const c = require(workerData.dist + "/src/compile.js");
    Promise.resolve(c.initParser && c.initParser()).then(() => {
      c.execModule("import builtins\\nbuiltins._sb_s = '1' * 1_000_000 + 'x'", "<setup>", "__main__");
      Atomics.store(c.R.INTR, 0, 1);
      let done;
      try {
        c.execModule("int(_sb_s)", "<test>", "__main__");
        done = "finished";
      } catch (e) {
        done = c.R.formatException(e).trim().split("\\n").pop().slice(0, 60);
      }
      parentPort.postMessage(done);
    });
    `,
    { eval: true, workerData: { dist: DIST } },
  );
  const done = await new Promise((resolve, reject) => (w.on("message", resolve), w.on("error", reject)));
  await w.terminate();
  assert.equal(done, "KeyboardInterrupt");
});
