import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// hashlib's md5, sha1, sha224, sha256, sha384 and sha512, written in Python
// (lib/hashlib.py), give CPython's digests for every length around the block
// boundaries and the standards' vectors, and CPython's interface and errors.
const CASES = __dirname + "/../../test/hashlib_cases.py";
const INTERRUPT = __dirname + "/../../test/hashlib_interrupt_cases.py";
const cli = (args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });

test("hashlib's digests, interface and errors are CPython's", () => {
  const want = execFileSync("python3", [CASES], { encoding: "utf8" });
  assert.equal(cli([CASES]), want);
});

test("an interrupt inside update() leaves the hash object whole, and it goes on hashing correctly", () => {
  const names = ["md5", "sha1", "sha224", "sha256", "sha384", "sha512"];
  const want = execFileSync("python3", ["-c", `import hashlib
for n in ${JSON.stringify(names)}:
    print(n, "unchanged", True, 2)
    print(n, hashlib.new(n, b"prefix bytes, " * 3 + b"then more").hexdigest())`], { encoding: "utf8" });
  assert.equal(cli([INTERRUPT]), want);
});
