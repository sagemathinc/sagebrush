import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// The series and p-adic rings Sage makes multivariate (PowerSeriesRing(QQ,
// 'x,y'), (QQ, 2, 'x'), QQ[['x,y']], Qp(5)['x,y'], ...) are refused before any
// ring is built or cached, with every name checked first (lib/_sage_series.py
// _series_names, lib/_sage_padic.py; #776 RING-NAME-NORMALIZATION-2; L32, L38).
const TEST = __dirname + "/../../test/";
test("multivariate series and p-adic polynomial rings are refused before a ring is cached, and a count makes no list of names", () => {
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--sage", TEST + "series_names_cases.sage"], { encoding: "utf8", timeout: 120000 });
  const S = "NotImplementedError: multivariate power series rings are not available in sagebrush yet";
  const P = "NotImplementedError: multivariate polynomial rings over p-adic rings are not available in sagebrush yet";
  assert.deepEqual(out.trim().split("\n"), [
    S, S, S, S, S, S, S, S, P, P, S,
    // (a count of 0: Sage makes a ring that cannot print itself; refused here, L39)
    "NotImplementedError: LaurentSeriesRing with a count of 0 is not available in sagebrush yet",
    // (names by keyword, a count after a count: SERIES-NAME-WORK-4)
    S, S, S, S, S, S,
    "NotImplementedError: LaurentSeriesRing with a count of 0 is not available in sagebrush yet",
    "[]",
    // (a huge count with the name list's materializer made to fail: SERIES-NAME-WORK-3)
    "Laurent Series Ring in x0 over Rational Field",
    S,
    "ValueError: variable name 'a{b0' is not alphanumeric",
    "IndexError: the number of names must equal the number of generators",
  ]);
});
