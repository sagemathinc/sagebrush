// show() in Sage mode publishes ONE rich display, typeset with KaTeX: its
// text/latex (the object's LaTeX, as real Sage's latex() writes it) with
// the typeset marker and a text/plain fallback, and no printed text
// (William's report, Oct 23: show(EllipticCurve(...)) printed its repr
// twice).  The board's live code runs in the same session, so it renders
// the same.  The LaTeX strings are Sage 10.10's (black-box oracle).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const katex = require("katex");

async function session() {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  let id = 0;
  return async (code: string, mode: { sage?: boolean; magma?: boolean } = { sage: true }) => {
    const n = ++id;
    await s.handle({ id: n, code, ...mode });
    const mine = msgs.filter((m) => m.id === n);
    return {
      out: mine.filter((m) => m.stream === "stdout").map((m) => m.text).join(""),
      err: mine.filter((m) => m.stream === "stderr").map((m) => m.text).join(""),
      displays: mine.filter((m) => m.display).map((m) => m.display),
    };
  };
}

// (code, its one display's LaTeX between $$, its text/plain)
const CASES: [string, string, string][] = [
  ["E = EllipticCurve([1, -1, 0, -79, 289])\nshow(E)", "y^2 + x y = x^{3} - x^{2} - 79 x + 289 ",
   "Elliptic Curve defined by y^2 + x*y = x^3 - x^2 - 79*x + 289 over Rational Field"],
  ["show(EllipticCurve([3, -2, -1, -5, -8]))", "y^2 + 3 x y - y = x^{3} - 2 x^{2} - 5 x - 8 ",
   "Elliptic Curve defined by y^2 + 3*x*y - y = x^3 - 2*x^2 - 5*x - 8 over Rational Field"],
  ["R.<x> = QQ[]\nshow(x^2 - 3/4*x + 1)", "x^{2} - \\frac{3}{4} x + 1", "x^2 - 3/4*x + 1"],
  ["show(matrix(QQ, [[1, 2], [3, 4/5]]))", "\\left(\\begin{array}{rr}\n1 & 2 \\\\\n3 & \\frac{4}{5}\n\\end{array}\\right)", "[  1   2]\n[  3 4/5]"],
  ["K.<a> = NumberField(x^2 + 1)\nshow(a + 3/2)", "a + \\frac{3}{2}", "a + 3/2"],
  // (William's report, Oct 25: over GF(7) the exponents were unbraced, x^10, typeset x^1 0)
  ["k.<x> = GF(7)[]\nshow(x^10)", "x^{10}", "x^10"],
  ["show(matrix(GF(7), 15, 15, lambda i, j: (i*j + i + 1) % 7).charpoly())", "x^{15} + 6 x^{14}", "x^15 + 6*x^14"],
  ["class Foo:\n    def __repr__(self): return 'Foo<1>'\nshow(Foo())", "\\text{\\texttt{Foo<1>}}", "Foo<1>"],
  ["show({1: 2/3, 'k': 7})", "\\left\\{1 : \\frac{2}{3}, \\text{\\texttt{k}} : 7\\right\\}", "{1: 2/3, 'k': 7}"],
  ["show(None)", "\\mathrm{None}", "None"],
  ["show('hi there')", "\\text{\\texttt{hi{ }there}}", "'hi there'"],
  // show(a, b): one display of both, separated by a space (Sage's text form: "1 2/3")
  ["show(1, 2/3)", "1 \\ \\frac{2}{3}", "1 2/3"],
  ["show(EllipticCurve([1, -1, 0, -79, 289]), 2/3)", "y^2 + x y = x^{3} - x^{2} - 79 x + 289  \\ \\frac{2}{3}",
   "Elliptic Curve defined by y^2 + x*y = x^3 - x^2 - 79*x + 289 over Rational Field 2/3"],
];

test("show() publishes one typeset display (text/latex, marker, text/plain) and prints nothing", async () => {
  const run = await session();
  for (const [code, tex, plain] of CASES) {
    const r = await run(code);
    assert.equal(r.err, "", code);
    assert.equal(r.out, "", `${code}: printed ${JSON.stringify(r.out)}`);
    assert.equal(r.displays.length, 1, `${code}: ${r.displays.length} displays`);
    const d = r.displays[0];
    assert.equal(d["text/latex"], "$$" + tex + "$$", code);
    assert.equal(d["application/vnd.sagebrush.typeset"], "1", code);
    assert.equal(d["text/plain"], plain, code);
    // KaTeX (the notebook's renderer) typesets it without an error
    assert.doesNotThrow(() => katex.renderToString(tex, { displayMode: true, throwOnError: true }), code);
  }
});

test("show() of a picture keeps its own display; a value without show() is not typeset", async () => {
  const run = await session();
  const p = await run("show(plot(x, (x, 0, 1)))");
  assert.equal(p.displays.length, 1);
  assert.ok(p.displays[0]["image/svg+xml"], "a plot shows its SVG");
  const v = await run("EllipticCurve([0, 0, 1, -1, 0])");
  assert.equal(v.displays.filter((d) => d["application/vnd.sagebrush.typeset"]).length, 0, "a cell's value prints as text, as in Sage");
});

test("Python and Magma modes are unchanged: display() and Magma output", async () => {
  const run = await session();
  const py = await run("from IPython.display import display, Math\ndisplay(Math('x^2'))\nprint('ok')", {});
  assert.equal(py.err, "");
  assert.equal(py.out, "ok\n");
  assert.equal(py.displays.length, 1);
  const mg = await run("E := EllipticCurve([1, -1, 0, -79, 289]); E;", { magma: true });
  assert.equal(mg.err, "");
  assert.match(mg.out, /^Elliptic Curve defined by y\^2 \+ x\*y = x\^3 - x\^2 - 79\*x \+ 289 over Rational Field\n$/);
});

test("on the command line show() prints the text form once", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-show-"));
  const f = join(dir, "s.sage");
  writeFileSync(f, "show(EllipticCurve([1, -1, 0, -79, 289]))\nshow(1, 2/3)\nshow('hi')\n");
  const out = execFileSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--sage", f], { encoding: "utf8" });
  assert.equal(out, "Elliptic Curve defined by y^2 + x*y = x^3 - x^2 - 79*x + 289 over Rational Field\n1 2/3\n'hi'\n");
});
