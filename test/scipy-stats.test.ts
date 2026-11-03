import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// scipy.stats' distributions where SciPy 1.18's value is wrong, so that
// scipy-tests/test_stats.py (against SciPy) skips them: Sagebrush's against
// mpmath's at 50 digits (test/scipy-stats-mpmath.json, from the comparison's
// differences, each case's truth computed by mpmath: the incomplete beta
// function by 2F1, the quantiles by bisection).  A case with no finite truth
// is a quantile whose root is at least 1e119: its value here was checked by
// mpmath's tail at it (the tail equals the target to 12 digits), or is inf
// where the root is beyond the doubles (about 1e600).
const cases: [string, string | null, number | null][] = JSON.parse(readFileSync(__dirname + "/../../test/scipy-stats-mpmath.json", "utf8"));
const py = (code: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8", maxBuffer: 1 << 24 });

// (the bounds: a log value to 4e-15 absolute of max(1, |log|), where the value itself is near 1 and its log near 0;
// a quantile to 4e-15 relative of max(1, |log q|), the inverse's convergence, a few ulps of the tail's log
// (lib/_special_ibeta.py's _tail_root); any other value to 4e-15 relative)
const qOf = (lab: string) => Number(/\(([^,]+),/.exec(lab)![1]);
const bound = (lab: string, t: number) =>
  /\.log\w+\(/.test(lab) ? 4e-15 * Math.max(1, Math.abs(t))
    : /\.(ppf|isf)\(/.test(lab) ? 4e-15 * Math.max(1, Math.abs(Math.log(qOf(lab)))) * Math.abs(t)
      : 4e-15 * Math.abs(t);

test("scipy.stats where SciPy's value is wrong: Sagebrush's within its bound of mpmath's (or the checked root)", () => {
  const got: (number | string)[] = JSON.parse(py(`
import json, math, sys
import scipy.stats as st
cases = ${JSON.stringify(cases.map((c) => c[0]))}
out = []
for lab in cases:
    name, rest = lab.split("(", 1)
    d, m = name.split(".")
    args = eval("(" + rest)
    if not isinstance(args, tuple):
        args = (args,)
    flat = []
    for a in args:
        flat.extend(a if isinstance(a, tuple) else (a,))
    v = float(getattr(getattr(st, d), m)(*flat))
    out.append(v if math.isfinite(v) else repr(v))
print(json.dumps(out))
`));
  const bad: string[] = [];
  cases.forEach(([lab, truth, root], i) => {
    const v = got[i];
    if (truth !== null) {
      const t = Number(truth);
      const err = Math.abs((v as number) - t);
      if (!(err <= bound(lab, t))) bad.push(`${lab}: ${v} vs mpmath ${truth} (${err} > ${bound(lab, t)})`);
    } else if (root !== null) {
      if (!(Math.abs((v as number) - root) <= 1e-12 * Math.abs(root))) bad.push(`${lab}: ${v} vs the checked root ${root}`);
    } else if (!(v === "inf" || v === "-inf")) bad.push(`${lab}: ${v}, not an infinite root`);
  });
  assert.deepEqual(bad, []);
  assert.equal(cases.length, 48);
});

test("scipy.stats: what Sagebrush doesn't compute raises NotImplementedError, never a guess", () => {
  const out = py(`
import scipy.stats as st
for f in (lambda: st.levy_stable.pdf(1.0, 1.5, 0), lambda: st.levy_stable.cdf(1.0, 1.5, 0), lambda: st.genextreme.fit([1.0, 2.0]),
          lambda: st.genpareto.fit([1.0, 2.0]), lambda: st.norm.fit([1.0, 2.0])):
    try:
        f()
        print("no error")
    except NotImplementedError as e:
        print("NotImplementedError", str(e).split(" is not")[0])
`);
  assert.equal(out, ["levy_stable.pdf", "levy_stable.cdf", "genextreme.fit", "genpareto.fit", "norm.fit"].map((n) => "NotImplementedError scipy.stats." + n + "\n").join(""));
});

test("scipy.stats: the samplers whose numpy.random method Sagebrush lacks raise NotImplementedError, after rvs's own checks (daybreak3's B1)", () => {
  const out = py(`
import scipy.stats as st
for name, args in (("t", (3,)), ("f", (2, 5)), ("chi2", (4,)), ("cauchy", ()), ("binom", (10, 0.3))):
    try:
        # (the default random_state: NumPy's global stream, daybreak3's R1)
        getattr(st, name).rvs(*args, size=2)
        print(name, "no error")
    except NotImplementedError as e:
        print(name, "NotImplementedError", str(e).split(":")[0])
try:
    st.t.rvs(-1, size=2, random_state=0)
except ValueError as e:
    print("t invalid df: ValueError", str(e).split(".")[0])
`);
  assert.equal(out, [
    "t NotImplementedError scipy.stats.t.rvs is not in Sagebrush yet",
    "f NotImplementedError scipy.stats.f.rvs is not in Sagebrush yet",
    "chi2 NotImplementedError scipy.stats.chi2.rvs is not in Sagebrush yet",
    "cauchy NotImplementedError scipy.stats.cauchy.rvs is not in Sagebrush yet",
    "binom NotImplementedError scipy.stats.binom.rvs is not in Sagebrush yet",
    "t invalid df: ValueError Domain error in arguments",
    "",
  ].join("\n"));
});

