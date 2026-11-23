import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// x.log_gamma() of a negative real, the principal branch log |Gamma(x)| +
// pi floor(x) I, in RealField(p) for several precisions and every rounding
// mode (RR and the directed 53-bit fields included).  The reference Sage
// raises an mpmath TypeError for every negative x.log_gamma() (an
// environment bug, mpmath with gmpy2), so its expected values are Sage's
// function form log_gamma(x), as printed, and mpmath's loggamma at p + 256
// bits rounded to p bits, compared exactly (sign, mantissa, exponent).
interface Row { p: number; rnd: string; q: string; sage: string; re: [number, string, number]; im: [number, string, number] }
const rows: Row[] = JSON.parse(readFileSync(__dirname + "/../../test/real-log-gamma-negative.json", "utf8")).rows;
const cli = (src: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--sage", "-c", src], { encoding: "utf8", timeout: 600000 });

test("x.log_gamma() of a negative real is Sage's log_gamma(x) and mpmath's principal branch, exactly", () => {
  const src = [
    "def parts(x):",
    "    if hasattr(x, '_m'):",
    "        m, e = x._m, x._e",
    "    else:",
    "        n, d = float(x).as_integer_ratio()",
    "        m, e = n, -(d.bit_length() - 1)",
    "    s = 1 if m < 0 else 0",
    "    m = abs(m)",
    "    while m and m % 2 == 0:",
    "        m, e = m // 2, e + 1",
    "    return '%d %d %d' % (s, m, e)",
    "for p, rnd, q in " + JSON.stringify(rows.map((r) => [r.p, r.rnd, r.q])) + ":",
    "    v = RealField(p, rnd=rnd)(QQ(q)).log_gamma()",
    "    print('%s|%s|%s' % (v, parts(v.real()), parts(v.imag())))",
  ].join("\n");
  const lines = cli(src).trimEnd().split("\n");
  assert.equal(lines.length, rows.length);
  rows.forEach((r, k) => {
    const [s, re, im] = lines[k].split("|");
    const where = `RealField(${r.p}, rnd='${r.rnd}')(${r.q}).log_gamma()`;
    assert.equal(s, r.sage, where);
    assert.equal(re, r.re.join(" "), where + ": real part");
    assert.equal(im, r.im.join(" "), where + ": imaginary part");
  });
});

test("x.log_gamma() at a negative integer is mpmath's pole error, as Sage's", () => {
  const src = [
    "for p, rnd in [(53, 'RNDN'), (53, 'RNDU'), (20, 'RNDD'), (100, 'RNDN')]:",
    "    for n in [-1, -2, -100]:",
    "        try:",
    "            RealField(p, rnd=rnd)(n).log_gamma()",
    "        except ValueError as e:",
    "            print(e)",
  ].join("\n");
  assert.equal(cli(src), "gamma function pole\n".repeat(12));
});
