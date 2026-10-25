// latex() of polynomial-like values writes every exponent braced, as Sage does: x^{10}, never x^10,
// which KaTeX typesets as x^1 followed by 0 (William's report, Oct 25: show(x^10) over GF(7), and a
// GF(7) charpoly, rendered x^1 0).  Each case is a value and Sage's own latex() of it (Sage 10.10,
// a black-box oracle; nothing of Sage's source is used), over the types that write polynomials:
// GF(p)[x], GF(q)[x], GF(q) elements, Zmod(n)[x], NF[x], QQ[x], ZZ[x], multivariate polynomials,
// power series, fraction fields, factorizations (polynomial and integer) and charpoly/minpoly,
// with exponents 10, 15 and 123.
import test from "node:test";
import assert from "node:assert/strict";

const katex = require("katex");

async function session() {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  let id = 0;
  return async (code: string) => {
    const n = ++id;
    await s.handle({ id: n, code, sage: true });
    const mine = msgs.filter((m) => m.id === n);
    return {
      out: mine.filter((m) => m.stream === "stdout").map((m) => m.text).join(""),
      err: mine.filter((m) => m.stream === "stderr").map((m) => m.text).join(""),
    };
  };
}

// (setup, "; "-separated statements; the expression; Sage's latex() of it)
const CASES: [string, string, string][] = [
  ["R.<x> = GF(7)[]", "x^10", "x^{10}"],
  ["R.<x> = GF(7)[]", "x^15 + 3*x^10 + 1", "x^{15} + 3 x^{10} + 1"],
  ["R.<x> = GF(7)[]", "x^123 - x", "x^{123} + 6 x"],
  ["R.<x> = GF(7)[]", "2*x^10", "2 x^{10}"],
  ["R.<x> = GF(32003)[]", "x^15 + 3*x^10 + 1", "x^{15} + 3 x^{10} + 1"],
  ["R.<x> = GF(32003)[]", "x^123 - x", "x^{123} + 32002 x"],
  ["F.<a> = GF(7^2); R.<x> = F[]", "a*x^10 + x^15", "x^{15} + a x^{10}"],
  ["F.<a> = GF(7^2); R.<x> = F[]", "x^123", "x^{123}"],
  ["F.<a> = GF(7^2); R.<x> = F[]", "(a + 1)*x^10", "\\left(a + 1\\right) x^{10}"],
  ["F.<a> = GF(49); S.<y> = F[]", "3*a*y^2 + (a + 1)*y + a", "3 a y^{2} + \\left(a + 1\\right) y + a"],
  ["F.<b> = GF(2^12)", "b^10", "b^{10}"],
  ["F.<b> = GF(2^12)", "b^11 + b^10", "b^{11} + b^{10}"],
  ["F.<a> = GF(49)", "3*a + 2", "3 a + 2"],
  ["K.<b> = GF(2^4)", "b^3 + b", "b^{3} + b"],
  ["R.<x> = Zmod(10)[]", "x^10 + 3*x^15", "3 x^{15} + x^{10}"],
  ["R.<x> = Zmod(10)[]", "x^123", "x^{123}"],
  ["Z.<w> = Zmod(10)[]", "9*w + 9", "9 w + 9"],
  ["z = polygen(QQ, 'z'); K.<i> = NumberField(z^2 + 1); R.<x> = K[]", "x^10 + i*x^15", "i x^{15} + x^{10}"],
  ["z = polygen(QQ, 'z'); K.<i> = NumberField(z^2 + 1); R.<x> = K[]", "x^123", "x^{123}"],
  ["z = polygen(QQ, 'z'); K.<c> = NumberField(z^12 + 2)", "c^11 + c^10", "c^{11} + c^{10}"],
  ["R.<x> = QQ[]", "x^123 + x^15", "x^{123} + x^{15}"],
  ["R.<x> = ZZ[]", "2*x^10 - x^15", "-x^{15} + 2x^{10}"],
  ["R.<x,y> = QQ[]", "x^10*y^15", "x^{10} y^{15}"],
  ["R.<x,y> = GF(7)[]", "x^10*y^15 + x", "x^{10} y^{15} + x"],
  ["P.<t> = PowerSeriesRing(QQ)", "t^10 + O(t^15)", "t^{10} + O(t^{15})"],
  ["P.<t> = PowerSeriesRing(GF(7))", "t^10 + O(t^15)", "t^{10} + O(t^{15})"],
  ["R.<x> = QQ[]", "(x^10 + 1)/x^15", "\\frac{x^{10} + 1}{x^{15}}"],
  ["R.<x> = GF(7)[]", "(x^10 + 1)/x^15", "\\frac{x^{10} + 1}{x^{15}}"],
  ["R.<x,y> = QQ[]", "x^10/y^15", "\\frac{x^{10}}{y^{15}}"],
  ["M.<u,v> = QQ[]", "(u + 1)/(u*v^10)", "\\frac{u + 1}{u v^{10}}"],
  ["M.<u,v> = QQ[]", "-u/v", "\\frac{-u}{v}"],
  ["F.<a> = GF(49); A.<x> = F[]", "x^10/(x + a)", "\\frac{x^{10}}{x + a}"],
  ["R.<x> = GF(7)[]", "factor(x^10*(x + 1)^15)", "x^{10} \\cdot (x + 1)^{15}"],
  ["R.<x> = GF(7)[]", "factor(-x^2)", "\\left(6\\right) \\cdot x^{2}"],
  ["R.<x> = GF(7)[]", "factor(3*(x + 1)^2*x)", "\\left(3\\right) \\cdot x \\cdot (x + 1)^{2}"],
  ["R.<x> = GF(7)[]", "factor(x + 1)", "(x + 1)"],
  ["R.<x> = GF(7)[]", "factor(R(5))", "5"],
  ["F.<a> = GF(49); S.<y> = F[]", "factor((y + a)^10*(y^2 + a))", "(y + a)^{10} \\cdot (y^{2} + a)"],
  ["F.<a> = GF(49); S.<y> = F[]", "factor(a*y^10)", "\\left(a\\right) \\cdot y^{10}"],
  ["R.<x> = QQ[]", "factor(x^10*(x + 1)^15)", "x^{10} \\cdot (x + 1)^{15}"],
  ["Q.<t> = QQ[]", "factor(-(t + 1))", "\\left(-1\\right) \\cdot (t + 1)"],
  ["Q.<t> = QQ[]", "factor(2*t^10)", "\\left(2\\right) \\cdot t^{10}"],
  ["Z.<s> = ZZ[]", "factor(2*s^2 - 2)", "2 \\cdot (s - 1) \\cdot (s + 1)"],
  ["Z.<s> = ZZ[]", "factor(-s)", "\\left(-1\\right) \\cdot s"],
  ["Z.<s> = ZZ[]", "factor(s + 1)", "(s + 1)"],
  ["", "factor(2^10*3^15)", "2^{10} \\cdot 3^{15}"],
  ["", "factor(-12)", "-1 \\cdot 2^{2} \\cdot 3"],
  ["", "factor(-1)", "-1"],
  ["R.<x,y> = GF(7)[]", "factor(x^10*y^15)", "x^{10} \\cdot y^{15}"],
  ["M.<u,v> = GF(7)[]", "factor(3*(u + v)^2*u)", "\\left(3\\right) \\cdot u \\cdot (u + v)^{2}"],
  ["z = polygen(QQ, 'z'); K.<i> = NumberField(z^2 + 1); P.<y> = K[]", "factor((y + i)^10)", "(y + i)^{10}"],
  ["", "matrix(GF(7), 15, 15, lambda i, j: (i*j + i + 1) % 7).charpoly()", "x^{15} + 6 x^{14}"],
  ["", "matrix(GF(7), 15, 15, lambda i, j: (i*j + i + 1) % 7).minpoly()", "x^{3} + 6 x^{2}"],
  ["", "matrix(QQ, 15, 15, lambda i, j: (i*j + i + 1) % 7).charpoly()", "x^{15} - 29 x^{14} - 294 x^{13} - 1876 x^{12} - 13720 x^{11} - 186592 x^{10} - 230496 x^{9}"],
  ["", "matrix(GF(32003), 12, 12, lambda i, j: (i*i + 2*j + 1) % 11).charpoly()", "x^{12} + 31958 x^{11} + 31134 x^{10} + 31156 x^{9} + 26679 x^{8} + 8812 x^{7}"],
];

// an exponent of two or more characters after ^ without braces (x^10, x^-1): KaTeX would
// typeset only its first character as the exponent
const BARE = /\^(?:-?\d{2,}|-\d)/;

test("latex() of polynomial-like values is Sage's: every exponent braced", async () => {
  const run = await session();
  const failures: string[] = [];
  for (const [setup, expr, tex] of CASES) {
    const code = (setup ? setup.split("; ").join("\n") + "\n" : "") + `print(latex(${expr}))`;
    const r = await run(code);
    assert.equal(r.err, "", code);
    const got = r.out.replace(/\n$/, "");
    if (got !== tex) failures.push(`${expr} (${setup}): ${JSON.stringify(got)}, Sage ${JSON.stringify(tex)}`);
    assert.doesNotMatch(got, BARE, `${expr}: a bare exponent`);
    assert.doesNotThrow(() => katex.renderToString(got, { displayMode: true, throwOnError: true }), expr);
  }
  assert.deepEqual(failures, []);
});

test("latex() of a value with no _latex_ writes its text, so a ^ in it is never an exponent", async () => {
  const run = await session();
  const r = await run("class Foo:\n    def __repr__(self): return 'x^10 + y^123'\nprint(latex(Foo()))");
  assert.equal(r.err, "");
  assert.equal(r.out, "\\text{\\texttt{x{\\char`\\^}10{ }+{ }y{\\char`\\^}123}}\n");
});
