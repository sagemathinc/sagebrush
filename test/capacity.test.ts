import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The memory collector and the guards' figure (lib/_capacity.py, item D0,
// plan-d0-capacity-r2): capacity() is the memory observed free, which
// decides nothing; heap_figure() is the total the guards take their share
// of, pyjs's own figure unchanged; poly_share() is the one route that follows
// free memory, the default budget of a polynomial factorization.
const TEST = __dirname + "/../../test/";
const CLI = __dirname + "/../src/cli.js";

// (made-up /proc and /sys: cgroup v1 and v2, resource limits, Windows, the
// reserve, the snapshots: the same text from python3 and from Sagebrush,
// and the one recorded)
test("the collector on made-up systems: the same from python3 and from Sagebrush, as recorded", () => {
  const want = readFileSync(TEST + "capacity_cases.expected", "utf8");
  for (const [who, cmd, args] of [["python3", "python3", ["-I"]], ["sagebrush", process.execPath, [CLI]]] as [string, string, string[]][]) {
    const dir = mkdtempSync(join(tmpdir(), "sb-capacity-"));
    try {
      const got = execFileSync(cmd, [...args, TEST + "capacity_cases.py", dir], { encoding: "utf8" });
      const w = want.split("\n"), g = got.split("\n");
      for (let i = 0; i < Math.max(w.length, g.length); i++) assert.equal(g[i], w[i], `${who} line ${i + 1}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

const sage = (code: string, heap = 256) =>
  execFileSync(process.execPath, [`--max-old-space-size=${heap}`, CLI, "--sage", "-c", code], { encoding: "utf8", timeout: 120000 });

// pyjs's guards keep their figure exactly (a mutant feeding capacity() into
// heap_figure fails here); each guard's predicate at its exact boundary; and
// where the enforced cap and the observed headroom cross, the refusal is the
// cap's (limit_bytes), with the headroom only recorded (D0-SEM-R1-1)
test("the guards: pyjs's figure unchanged, each predicate at need = cap and cap + 1, the cap enforced where it and the headroom cross", () => {
  const code = String.raw`
import sys, math, _capacity as C, _sage_ffmat as M, sage_all as S
MiB = 1 << 20
print(C.heap_figure() == sys._sagebrush_heap_limit == M._heap_limit(), S._prime_cells() == sys._sagebrush_heap_limit // 16)
real = C.heap_figure
def with_total(t, f):
    C.heap_figure = lambda: t
    try:
        return f()
    except (NotImplementedError, MemoryError) as e:
        return ("refused", e.need_bytes, e.limit_bytes, e.capacity["bytes"])
    finally:
        C.heap_figure = real
F = GF(7)
need = 10 * 10 * M._entry_cost(F)
print(with_total(4 * need, lambda: M._admit_size(F, 10, 10)), with_total(4 * need - 1, lambda: M._admit_size(F, 10, 10))[:3])
vneed = 100 * M._entry_cost(F)
print(with_total(4 * vneed, lambda: M._admit_vector(F, 100)), with_total(4 * vneed - 1, lambda: M._admit_vector(F, 100))[:3])
sneed = 1000 + math.isqrt(999)
print(with_total(16 * sneed, lambda: S._admit_prime_sieve(0, 1000, "primes")), with_total(16 * sneed - 1, lambda: S._admit_prime_sieve(0, 1000, "primes"))[:3])
# cap 256 MiB, need about 303 MiB, headroom 700 MiB: refused at the cap
C._set_sources(root="/nonexistent", rlimits={}, runtime=lambda: [("wasm engine", 700 * MiB, 0)])
print(with_total(1 << 30, lambda: M._admit_size(F, 1450, 1450)))
# need about 800 MiB, above both: refused at the cap
print(with_total(1 << 30, lambda: M._admit_size(F, 2350, 2350))[2:])
# the reverse: cap 1 GiB, headroom 200 MiB, need about 303 MiB: admitted, as
# the guard's predicate says; the headroom is what capacity() reports
C._set_sources(root="/nonexistent", rlimits={}, runtime=lambda: [("wasm engine", 200 * MiB, 0)])
print(with_total(4 << 30, lambda: M._admit_size(F, 1450, 1450)), C.capacity()["bytes"] // MiB)
# capacity unknown: the cap still enforced, the record says so
C._set_sources(root="/nonexistent", rlimits={}, runtime=lambda: [])
print(with_total(1 << 30, lambda: M._admit_size(F, 1450, 1450)))
C._set_sources()
`;
  assert.equal(sage(code), [
    "True True",
    "(10, 10) ('refused', 15100, 15099)",
    "100 ('refused', 15100, 15099)",
    "None ('refused', 1031, 1030)",
    "('refused', 317477500, 268435456, 734003200)",
    "(268435456, 734003200)",
    "(1450, 1450) 200",
    "('refused', 317477500, 268435456, None)",
    "",
  ].join("\n"));
});

// The share reaches the wasm engine before a dispatch, at most 100 ms old:
// applied exactly and said so; a long call (or calls within 100 ms) keeps it;
// none, -1 and anything out of range give the default 512 MiB
test("the poly share: pushed before a dispatch, applied exactly, kept for 100 ms; none or out of range is the default", () => {
  const code = String.raw`
import json, time, _sbengine, _capacity as C
real_share = C.poly_share
c = (1 << 2000) + 7
req = json.dumps({"fn": "factor", "f": [str(-c * c), "0", "1"]})
def factor():
    r = json.loads(_sbengine.call(req))
    return len(r["ok"]["factors"]) if "ok" in r else r["error"]
print(factor())
time.sleep(0.11)
C.poly_share = lambda: 1024
print(factor())
C.poly_share = lambda: None
print(factor())
time.sleep(0.11)
print(factor())
for bad in (-5, 2 ** 40, 1.5, "x"):
    time.sleep(0.11)
    C.poly_share = lambda bad=bad: 1024 if bad is None else bad
    print(repr(bad), factor())
# the real share, under a small observed headroom (400000 bytes free:
# share_of gives 100000): x^2 - 1 still factors
C.poly_share = real_share
C._set_sources(root="/nonexistent", rlimits={}, runtime=lambda: [("wasm engine", 400000, 0)])
time.sleep(0.11)
print(C.poly_share(), json.loads(_sbengine.call(json.dumps({"fn": "factor", "f": ["-1", "0", "1"]})))["ok"]["factors"])
C._set_sources()
# a Ctrl-C the collector's Python code sees is the program's, not lost
time.sleep(0.11)
def ctrl_c():
    raise KeyboardInterrupt
C.poly_share = ctrl_c
try:
    factor()
    for i in range(10 ** 6):
        pass
    print("not interrupted")
except KeyboardInterrupt:
    print("KeyboardInterrupt")
`;
  const out = sage(code).split("\n");
  assert.equal(out[0], "2");
  assert.match(out[1], /resource limit exceeded \(memory in .*; the limit, 1024 bytes, is this factorization's share of the memory observed free\); not factored/);
  // (within 100 ms of the push: the share is still the one pushed)
  assert.match(out[2], /the limit, 1024 bytes/);
  assert.equal(out[3], "2");
  assert.deepEqual(out.slice(4, 8), ["-5 2", "1099511627776 2", "1.5 2", "'x' 2"]);
  assert.equal(out[8], "100000 [[['-1', '1'], 1], [['1', '1'], 1]]");
  assert.equal(out[9], "KeyboardInterrupt");
});

// The push is optional both ways: an engine without the export (one built
// before D0, or another module) is left alone; a share is pushed once per
// 100 ms per instance, and at once to a new instance
test("pushShare: an engine without sb_set_memory_share is left alone; once per 100 ms, at once to a new instance", () => {
  const E = require("../src/runtime/engine");
  const old: any = { memory: null };
  E.pushShare(old);
  const pushed: number[] = [];
  const a: any = { sb_set_memory_share: (v: number) => pushed.push(v) };
  const b: any = { sb_set_memory_share: (v: number) => pushed.push(-v - 10) };
  E.pushShare(a);
  E.pushShare(a);
  E.pushShare(b);
  assert.equal(pushed.length, 2);
  assert.ok(Number.isInteger(pushed[0]) && pushed[0] >= -1 && pushed[0] <= 2 ** 32, String(pushed[0]));
});
