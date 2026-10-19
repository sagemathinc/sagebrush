import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// The parser's memo is forgotten behind each statement it has finished, and is
// flat (pyparse/src/pegen.ts, gen/build.py).  Before, every token's memo lived
// to the end of the parse: parsing lib/_matlab.py (478 KB) needed an 84 MiB
// heap, and starting MATLAB 88-94 MiB.  Now 32 MiB and 44 MiB, on Node 24 and
// on Node 26.  The caps below are a little above those, and far below the old
// peaks.
const cli = __dirname + "/../src/cli.js";
const pyparse = __dirname + "/../pyparse/src/index.js";
const matlab = __dirname + "/../../lib/_matlab.py";

test("pyparse parses lib/_matlab.py under a 40 MiB heap", () => {
  const code = `const t = require(${JSON.stringify(pyparse)}).parse(require("fs").readFileSync(${JSON.stringify(matlab)}, "utf8")); console.log(t.body.length > 100)`;
  const r = spawnSync(process.execPath, ["--max-old-space-size=40", "-e", code], { encoding: "utf8", timeout: 120000 });
  assert.deepEqual([r.status, r.stdout], [0, "true\n"], `signal ${r.signal}; ${r.stderr.slice(0, 300)}`);
});

test("MATLAB starts and runs under a 56 MiB heap", () => {
  const r = spawnSync(process.execPath, ["--max-old-space-size=56", cli, "--matlab"], { input: "x = [1 2 3];\ndisp(sum(x))\n", encoding: "utf8", timeout: 120000 });
  assert.deepEqual([r.status, r.stdout], [0, "     6\n"], `signal ${r.signal}; ${r.stderr.slice(0, 300)}`);
});
