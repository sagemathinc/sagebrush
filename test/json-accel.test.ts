import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// json through the _json accelerator (src/runtime/json.ts), compared with
// CPython 3.14, whose json uses its C _json: dumps with every option,
// subclasses and default, notes on errors, loads of every value and every
// error with its position (astral strings counted in code points), hooks,
// and the module's own functions (test/json_accel_cases.py).
const TEST = __dirname + "/../../test/";
test("json.dumps and json.loads give CPython's output, errors, positions and notes", () => {
  const name = "json_accel_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" });
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8", maxBuffer: 1 << 26 });
  const w = want.split("\n"), g = got.split("\n");
  for (let i = 0; i < Math.max(w.length, g.length); i++) assert.equal(g[i], w[i], `${name} line ${i + 1}`);
});

// sage2's benchmark (30000 small dicts, 2.19 M characters): dumps and loads
// each well under a second, where the pure-Python json took 0.7 and 0.55 s
// on a quiet VM; the round trip equal
test("json.dumps and json.loads of 30000 small dicts are fast", () => {
  const code = [
    "import json, time",
    "x = [{'a': i, 'b': [i, str(i), i / 2], 'c': {'d': None, 'e': True}} for i in range(30000)]",
    "for k in range(2):",
    "    t = time.perf_counter(); s = json.dumps(x); t1 = time.perf_counter(); y = json.loads(s); t2 = time.perf_counter()",
    "print(round(t1 - t, 3), round(t2 - t1, 3), y == x, len(s))",
  ].join("\n");
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" }).trim().split(" ");
  assert.equal(out[2], "True");
  assert.ok(Number(out[0]) < 0.35 && Number(out[1]) < 0.35, `dumps ${out[0]} s, loads ${out[1]} s`);
});
