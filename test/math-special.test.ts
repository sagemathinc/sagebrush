import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// math.erf, erfc, gamma, lgamma, exp2, nextafter and ulp against CPython's
// values (test/math-special-cpython.json, from test/math_special_gen.py:
// CPython 3.14 on glibc 2.43).  Sagebrush's are fdlibm's erf, erfc and
// lgamma, musl's tgamma and glibc's exp2 (src/runtime/fdlibm.ts, libm.ts):
// - exp2 is glibc's algorithm: the same bits;
// - erf and erfc: glibc 2.43's are correctly rounded, fdlibm's within 1 and 3 ulp;
// - gamma: both are Lanczos approximations with the same g, within 12 ulp;
// - lgamma: CPython's own is the less accurate near its zeros (an error of
//   thousands of ulp next to 1 and 2), so the tolerance is in ulp of max(1, |value|).
// nextafter and ulp are exact, and the errors (ValueError, OverflowError) the same.
const want = JSON.parse(readFileSync(__dirname + "/../../test/math-special-cpython.json", "utf8"));

const fromHex = (h: string): number => {
  // float.hex(): [-]0x1.<hex>p<exp>, [-]0x0.0p+0, inf, nan
  if (h === "inf") return Infinity;
  if (h === "-inf") return -Infinity;
  if (h === "nan") return NaN;
  const m = /^(-?)0x([01])\.([0-9a-f]*)p([+-]\d+)$/.exec(h);
  if (!m) throw new Error("bad hex float " + h);
  let mant = BigInt(m[2]);
  for (const d of m[3]) mant = mant * 16n + BigInt(parseInt(d, 16));
  const v = Number(mant) * 2 ** (Number(m[4]) - 4 * m[3].length);
  return m[1] ? -v : v;
};
// (values cross as Python's repr, which float() reads back exactly: Sagebrush's float has no hex())
const fromRepr = (r: string): number => (r === "inf" ? Infinity : r === "-inf" ? -Infinity : r === "nan" ? NaN : Number(r));
const toRepr = (v: number): string => (v === Infinity ? "inf" : v === -Infinity ? "-inf" : v !== v ? "nan" : Object.is(v, -0) ? "-0.0" : String(v));

const FUNCS = ["erf", "erfc", "gamma", "lgamma", "exp2"];
const input: any = {};
for (const n of FUNCS) input[n] = want[n].map((r: string[]) => toRepr(fromHex(r[0])));
input.nextafter = want.nextafter.map((r: string[]) => [toRepr(fromHex(r[0])), toRepr(fromHex(r[1]))]);
input.nextafter_steps = want.nextafter_steps.map((r: any[]) => [toRepr(fromHex(r[0])), toRepr(fromHex(r[1])), r[2]]);
input.ulp = want.ulp.map((r: string[]) => toRepr(fromHex(r[0])));

const program = `
import math, json, sys
data = json.loads(sys.stdin.read())
out = {}
for name in ${JSON.stringify(FUNCS)}:
    f = getattr(math, name)
    rows = []
    for x in data[name]:
        try:
            rows.append(repr(f(float(x))))
        except (ValueError, OverflowError) as e:
            rows.append("!" + type(e).__name__)
    out[name] = rows
out["nextafter"] = [repr(math.nextafter(float(a), float(b))) for a, b in data["nextafter"]]
out["nextafter_steps"] = [repr(math.nextafter(float(a), float(b), steps=n)) for a, b, n in data["nextafter_steps"]]
out["ulp"] = [repr(math.ulp(float(x))) for x in data["ulp"]]
try:
    math.nextafter(1.0, 2.0, steps=-1)
except ValueError as e:
    out["steps_error"] = str(e)
try:
    math.gamma(-2.0)
except ValueError as e:
    out["gamma_error"] = str(e)
print(json.dumps(out))
`;

const got = JSON.parse(
  execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", program], {
    input: JSON.stringify(input),
    encoding: "utf8",
    maxBuffer: 1 << 26,
  }),
);

const f64 = new Float64Array(1), u64 = new BigUint64Array(f64.buffer);
const ulpOf = (v: number): number => {
  f64[0] = Math.abs(v);
  u64[0] += 1n;
  return f64[0] - Math.abs(v);
};

/** the largest difference (in ulp of max(scale, |CPython's value|)), after checking that both raise alike */
function worst(name: string, scale = 0): number {
  let w = 0;
  want[name].forEach(([xh, w0]: [string, string], i: number) => {
    const g = got[name][i];
    if (w0.startsWith("!") || g.startsWith("!")) {
      assert.equal(g, w0, `${name}(${xh})`);
      return;
    }
    const a = fromRepr(g), b = fromHex(w0);
    if (!Number.isFinite(b)) {
      assert.ok(Object.is(a, b) || (a !== a && b !== b), `${name}(${xh}) = ${g}, CPython ${w0}`);
      return;
    }
    if (a === b) return;
    w = Math.max(w, Math.abs(a - b) / ulpOf(Math.max(scale, Math.abs(b))));
  });
  return w;
}

test("math.exp2 is glibc's, bit for bit", () => {
  assert.equal(worst("exp2"), 0);
});

test("math.erf and erfc within 1 and 3 ulp of CPython's (correctly rounded) values", () => {
  assert.ok(worst("erf") <= 1, "erf: " + worst("erf"));
  assert.ok(worst("erfc") <= 3, "erfc: " + worst("erfc"));
});

test("math.gamma and lgamma agree with CPython's", () => {
  assert.ok(worst("gamma") <= 12, "gamma: " + worst("gamma"));
  assert.ok(worst("lgamma", 1) <= 8, "lgamma: " + worst("lgamma", 1));
});

test("math.nextafter (with steps) and ulp are CPython's exactly", () => {
  const same = (g: string[], w: string[]) => g.forEach((v, i) => assert.ok(Object.is(fromRepr(v), fromHex(w[i])), `${v} != ${w[i]}`));
  same(got.nextafter, want.nextafter.map((r: string[]) => r[2]));
  same(got.nextafter_steps, want.nextafter_steps.map((r: any[]) => r[3]));
  same(got.ulp, want.ulp.map((r: string[]) => r[1]));
  assert.equal(got.steps_error, "steps must be a non-negative integer");
  assert.equal(got.gamma_error, "expected a noninteger or positive integer, got -2.0");
});
