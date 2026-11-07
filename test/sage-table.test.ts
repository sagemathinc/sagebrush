import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sage's table() in Sage mode (lib/_sage_table.py; codex friction P10b: `table` was a NameError in 48 explainer
// topics). The reproduction, run as a .sage file as the explainers ran it; its output is Sage 10.10's, verbatim.
// (Every other form, text, LaTeX, HTML and Markdown, is in the module's own examples: test/doctest.test.ts, and
// against real Sage: scripts/doctest-oracle.py lib/_sage_table.py)

const cli = (...args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });

test("P10b: table() in a .sage file prints as Sage's, with a header row, and as LaTeX", () => {
  const dir = mkdtempSync(join(tmpdir(), "sage-table-"));
  try {
    const f = join(dir, "tab.sage");
    writeFileSync(f, 'print(table([[1,2],[3,4]], header_row=["a","b"]))\nt = table([[1,2],[3,4]])\nprint(latex(t))\n');
    assert.equal(cli(f), "  a   b\n├───┼───┤\n  1   2\n  3   4\n\\begin{tabular}{ll}\n$1$ & $2$ \\\\\n$3$ & $4$ \\\\\n\\end{tabular}\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("table is Sage mode's only: a Python script has no such name", () => {
  const dir = mkdtempSync(join(tmpdir(), "sage-table-"));
  try {
    const f = join(dir, "tab.py");
    writeFileSync(f, "try:\n    table\nexcept NameError:\n    print('no table')\n");
    assert.equal(cli(f), "no table\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
