import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// The context subset Python programs use to configure urllib before a
// request. Sagebrush's urllib is replay-only, but the configuration API has
// CPython 3.14's observable values and supports the conventional override of
// _create_default_https_context with _create_unverified_context.
const TEST = __dirname + "/../../test/ssl_cases.py";

test("ssl's replay-client context configuration, as CPython's", () => {
  const want = execFileSync("python3", [TEST], { encoding: "utf8" });
  const got = execFileSync(
    process.execPath,
    [__dirname + "/../src/cli.js", TEST],
    { encoding: "utf8" },
  );
  assert.equal(got, want);
});
