import test from "node:test";
import assert from "node:assert/strict";
import { renameInCell, renameRedefinitions } from "../src/rename";
import { startInterpreter, runCells } from "../src/reactive-session";

// Page-order scoping for MATLAB cells (design/reactive-notebook.md; src/rename-matlab.ts): a name several cells define
// is read from the nearest definition above, as in Python and Sage notebooks, instead of the error "x is defined by
// cell 1, cell 3 and cell 4, so this cell cannot tell which one it reads".
const CLI = __dirname + "/../src/cli.js";
// (the interpreter's worker runs the CLI's own entry, require.main's file: pointed at the CLI, as in reactive-session.test.ts)
require.main!.filename = CLI;
const S = "ʹ";
const ren = (src: string, name: string, o: { from?: "all" | "definition"; before?: string } = {}) => renameInCell(src, name, name + S + "2", { mode: "matlab", ...o });

test("MATLAB page-order scoping: a redefinition and its reads (src/rename-matlab.ts)", () => {
  // (the statement that first stores it reads the previous value; what follows reads the new one)
  assert.equal(ren("x = x + 1;\ndisp(x)", "x", { from: "definition" }), `x${S}2 = x + 1;\ndisp(x${S}2)`);
  assert.equal(ren("disp(x)\nx = 3; y = x", "x", { from: "definition" }), `disp(x)\nx${S}2 = 3; y = x${S}2`);
  assert.equal(ren("[a, x] = size(x);", "x", { from: "definition" }), `[a, x${S}2] = size(x);`);
  // (a right-hand side over several lines is still the statement that binds: its reads are of the previous x, in
  // [ ] and { } (whose newlines separate rows), ( ) and after a continuation; the REACT review of 14073a7a)
  assert.equal(ren("x = [\n x\n]; disp(x)", "x", { from: "definition" }), `x${S}2 = [\n x\n]; disp(x${S}2)`);
  assert.equal(ren("x = {1\n x\n 3};\ndisp(x)", "x", { from: "definition" }), `x${S}2 = {1\n x\n 3};\ndisp(x${S}2)`);
  // (a ; and then a newline inside the brackets)
  assert.equal(ren("x = [1;\n x]", "x", { from: "definition" }), `x${S}2 = [1;\n x]`);
  assert.equal(ren("x = {1;\n x}", "x", { from: "definition" }), `x${S}2 = {1;\n x}`);
  assert.equal(ren("x = max(1, ...\n  x);\ny = x", "x", { from: "definition" }), `x${S}2 = max(1, ...\n  x);\ny = x${S}2`);
  assert.equal(ren("x = sum(\n  x);\ny = x", "x", { from: "definition" }), `x${S}2 = sum(\n  x);\ny = x${S}2`);
  assert.equal(ren("x = x + ...\n  x; z = x", "x", { from: "definition" }), `x${S}2 = x + ...\n  x; z = x${S}2`);
  // (and a row of a matrix that starts a line is not a statement: [a\n x] reads x, it does not store it)
  assert.equal(ren("m = [1\n x];\nx = 2;\nk = x", "x", { from: "definition" }), `m = [1\n x];\nx${S}2 = 2;\nk = x${S}2`);
  // (a reader: every occurrence, but fields, strings, comments and command words)
  assert.equal(ren("s.x = x; disp('x') % x\nhold on\nplot(x(end))", "x"), `s.x = x${S}2; disp('x') % x\nhold on\nplot(x${S}2(end))`);
  // (the cell's functions have their own workspace)
  assert.equal(ren("y = x;\nfunction z = g(x)\n  z = x;\nend", "x"), `y = x${S}2;\nfunction z = g(x)\n  z = x;\nend`);
});

test("MATLAB page-order scoping: a store that reads the previous value or may not run starts from it", () => {
  // (William's split Mandelbrot cell: M(r, c) = iter fills the M an earlier cell made)
  assert.equal(ren("for r = 1:3\n  M(r) = r;\nend", "M", { from: "definition" }), `if exist('M', 'var'), M${S}2 = M; end; for r = 1:3\n  M${S}2(r) = r;\nend`);
  assert.equal(ren("M(2) = 5;", "M", { from: "definition", before: "M" + S + "3" }), `if exist('M${S}3', 'var'), M${S}2 = M${S}3; end; M${S}2(2) = 5;`);
  assert.equal(ren("if c\n  x = 1;\nend\ndisp(x)", "x", { from: "definition" }), `if exist('x', 'var'), x${S}2 = x; end; if c\n  x${S}2 = 1;\nend\ndisp(x${S}2)`);
  assert.equal(ren("s.a = 1;", "s", { from: "definition" }), `if exist('s', 'var'), s${S}2 = s; end; s${S}2.a = 1;`);
});

test("MATLAB page-order scoping: refused where the workspace is reached by name, or the name isn't the notebook's", () => {
  for (const [src, name] of [
    ["eval('x = 2')", "x"], ["y = 1; clear x", "x"], ["exist('x', 'var')", "x"], ["save f.mat x", "x"],
    ["f = @(x) x + 1", "x"], ["global x\nx = 1", "x"], ["x on", "x"],
    // (a block comment must begin its line: no initialization can go before it)
    ["%{\nnote\n%}\nx(1) = 2", "x"],
  ] as const) assert.equal(ren(src, name, { from: "definition" }), null, src);
  // (eval of an unrelated string is not refused)
  assert.equal(ren("eval('y = 2'); z = x", "x"), `eval('y = 2'); z = x${S}2`);
  // (the cells' renames together, in page order, as the notebook asks for them)
  const cells = [
    { id: "a", code: "x = 1;", defines: true, reads: false },
    { id: "b", code: "x = 2;", defines: true, reads: false },
    { id: "c", code: "disp(x)", defines: false, reads: true },
  ];
  assert.deepEqual([...renameRedefinitions(cells, "x", new Set(["x"]), "matlab", S)!], [["b", `x${S}2 = 2;`], ["c", `disp(x${S}2)`]]);
});

test("MATLAB page-order scoping: William's notebook, its Mandelbrot cell split, runs as a page read from the top", async () => {
  // (several examples in one notebook, each with its own x, y, nx, ny, max_iter; the Mandelbrot cell split in two, so
  // the loop reads the setup cell's names and fills its M: this was the error "x is defined by cell 1, cell 3 and
  // cell 4, so this cell cannot tell which one it reads", for x, y, nx, ny, max_iter, and M's)
  const cells = [
    "x = [12.5, 18.2, 14.1];\ndisp(median(x))\ny = [10, NaN, 20];\ndisp(median(y, 'omitnan'))",
    "nx = 8; ny = 6;\nx = linspace(-1.5, 1.5, nx);\ny = linspace(-1.2, 1.2, ny);\nJ = zeros(ny, nx);\nmax_iter = 30;\nfor r = 1:ny\n  for c = 1:nx\n    J(r, c) = x(c) + y(r);\n  end\nend\ndisp(size(J))",
    "% Mandelbrot Escape-Time Fractal\nnx = 30; ny = 20;\nx = linspace(-2.1, 0.6, nx);\ny = linspace(-1.2, 1.2, ny);\nM = zeros(ny, nx);\nmax_iter = 50;",
    "for r = 1:ny\n    ci = y(r);\n    for c = 1:nx\n        cr = x(c);\n        zr = 0.0; zi = 0.0; iter = 0;\n        while (zr^2 + zi^2) <= 4.0 && iter < max_iter\n            zr_new = zr^2 - zi^2 + cr;\n            zi = 2.0 * zr * zi + ci;\n            zr = zr_new;\n            iter = iter + 1;\n        end\n        M(r, c) = iter;\n    end\nend\ndisp([size(M), max(M(:)), M(10, 1), M(10, 25)])\nx1 = x(1)\nM(1, 1:3)",
  ];
  const interp = await startInterpreter({ mode: "matlab" });
  try {
    const out = new Map<string, string>(), err = new Map<string, string>();
    const r = await runCells(interp, cells.map((code, i) => ({ key: "c" + i, code })), {
      mode: "matlab", seedOf: () => "0".repeat(64), timeoutMs: 60_000,
      onMessage: (k, m) => { if (m.stream === "stdout") out.set(k, (out.get(k) ?? "") + String(m.text ?? "")); if (m.stream === "stderr") err.set(k, (err.get(k) ?? "") + String(m.text ?? "")); },
    });
    assert.deepEqual([[...r.failed], [...r.cancelled]], [[], []], [...err.values()].join("\n"));
    assert.deepEqual(r.errors, new Map());
    assert.equal(out.get("c0"), "   14.1000\n    15\n");
    assert.equal(out.get("c1"), "     6     8\n");
    // (the loop read the Mandelbrot cell's 30 x 20 grid from -2.1, not the Julia cell's 8 x 6 from -1.5; M is shown
    // under its written name; M(10, 1) escapes at once, M(10, 25), c near 0.24 + 0.06i, never)
    assert.equal(out.get("c3"), "    20    30    50     1    50\n\nx1 =\n\n   -2.1000\n\n\nans =\n\n     1     1     1\n\n");
  } finally { await interp.close(); }
});
