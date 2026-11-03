import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// csv: CPython 3.14's lib/csv.py, unchanged, over lib/_csv.py, its C module
// (Modules/_csv.c) ported to Python; and io.StringIO's newline argument,
// which csv's newline="" relies on. Compared with what CPython 3.14 prints.
const TEST = __dirname + "/../../test/";

test("csv's reader, writer, dialects, DictReader, DictWriter and Sniffer, and StringIO's newline, as CPython's", () => {
  const want = execFileSync("python3", [TEST + "csv_cases.py"], { encoding: "utf8" });
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + "csv_cases.py"], { encoding: "utf8" });
  assert.equal(got, want);
});
