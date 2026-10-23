import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// A dict changed while it is iterated, as CPython's: a changed size raises
// at every step after; a dict's iterator gives at most as many items as the
// dict had ("dictionary keys changed during iteration", then no more), so a
// loop that replaces each key it is given ends; after clear() it goes on in
// the new entries from the position it had reached; reversed() goes back
// from the last entry, passing over deleted ones. A set's iterator raises
// at a changed size only, with a set's words. Each case is compared with
// what CPython prints.
const TEST = __dirname + "/../../test/";
const cli = __dirname + "/../src/cli.js";

test("a dict or set changed while it is iterated: as CPython's", () => {
  const name = "dict_iter_mutation_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" });
  const got = execFileSync(process.execPath, [cli, TEST + name], { encoding: "utf8" });
  const w = want.split("\n"), g = got.split("\n");
  for (let i = 0; i < Math.max(w.length, g.length); i++) assert.equal(g[i], w[i], `${name} line ${i + 1}`);
});

// A loop that replaces each key it is given with a new one, at the same
// size, would never end with a JS Map's iterator (it goes on to the new
// keys): it ends after as many items as the dict had, with CPython's error.
// (Which keys it gives can differ from CPython's, whose dict resizes as it
// fills: test/dict_iter_mutation_cases.py keeps to the cases with no
// resize.)
test("a loop that replaces every key it is given ends", () => {
  const src = "d = {i: i for i in range(1000)}\nn = 0\ntry:\n    for k in d:\n        n += 1\n        del d[k]\n        d[k + 10000] = k\nexcept RuntimeError as e:\n    print(n, e)\n";
  const got = execFileSync(process.execPath, [cli, "-c", src], { encoding: "utf8" });
  assert.equal(got, "1000 dictionary keys changed during iteration\n");
});
