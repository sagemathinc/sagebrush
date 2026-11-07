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

// Each form's details (grader's r789 survivors T2-T34): a case's output, as real Sage 10.10 gives it (its HTML's
// one slip aside), and the Markdown form, Sagebrush's own; an error as "ERR <type>: <message>"
const CASES: [string, string, string | null][] = [
  ["T2_html_math", "table([['$x$ and $y^2$', 1]])._html_()", "<div class=\"notruncate\">\n<table  class=\"table_form\">\n<tbody>\n<tr class =\"row-a\">\n<td style=\"text-align:left\">\\(x\\) and \\(y^2\\)</td>\n<td style=\"text-align:left\">\\(1\\)</td>\n</tr>\n</tbody>\n</table>\n</div>"],
  ["T5_flat", "str(table([1, 2, 3]))", "  1   2   3"],
  ["T6_hcol_list", "str(table([[1, 2], [3, 4]], header_column=['r1', 'r2']))", "  r1 │ 1   2\n  r2 │ 3   4"],
  ["T6_both_lists", "str(table([[1, 2], [3, 4]], header_row=['a', 'b'], header_column=['', 'r1', 'r2']))", "     │ a   b\n├────┼───┼───┤\n  r1 │ 1   2\n  r2 │ 3   4"],
  ["T7_bogus", "table([[1]]).options(bogus=1)", null],
  ["T8_int", "table([[1]]).options(header_row=1)", "ERR TypeError: header_row should be either True or False."],
  ["T9_transpose", "str(table([[1, 2], [3, 4]], frame=True, align='right').transpose())", "┌───┬───┐\n│ 1 │ 3 │\n├───┼───┤\n│ 2 │ 4 │\n└───┴───┘"],
  ["T9_transpose_opts", "str(sorted(table([[1, 2], [3, 4]], frame=True, align='right').transpose().options().items()))", "[('align', 'right'), ('frame', True), ('header_column', False), ('header_row', False)]"],
  ["T10_ragged", "str(table([[1, 2, 3], [4, 5]]))", "  1   2\n  4   5"],
  ["T10_ragged_hcol", "str(table([[1, 2, 3], [4, 5]], header_column=True))", "  1 │ 2\n  4 │ 5"],
  ["T10_ragged_frame", "str(table([[1, 2, 3], [4, 5]], frame=True))", "┌───┬───┐\n│ 1 │ 2 │\n├───┼───┤\n│ 4 │ 5 │\n└───┴───┘"],
  ["T12_center", "str(table([[1, 22], [333, 4]], align='center'))", "   1    22\n  333   4"],
  ["T18_latex_frame_hcol", "str(latex(table([['x', 1, 2], ['y', 3, 4]], frame=True, header_column=True)))", "\\begin{tabular}{|l||l|l|} \\hline\nx & $1$ & $2$ \\\\ \\hline\ny & $3$ & $4$ \\\\ \\hline\n\\end{tabular}"],
  ["T19_latex_hcol", "str(latex(table([['x', 1, 2], ['y', 3, 4]], header_column=True)))", "\\begin{tabular}{l|ll}\nx & $1$ & $2$ \\\\\ny & $3$ & $4$ \\\\\n\\end{tabular}"],
  ["T20_html_rows", "table([[1], [2], [3]])._html_()", "<div class=\"notruncate\">\n<table  class=\"table_form\">\n<tbody>\n<tr class =\"row-a\">\n<td style=\"text-align:left\">\\(1\\)</td>\n</tr>\n<tr class =\"row-b\">\n<td style=\"text-align:left\">\\(2\\)</td>\n</tr>\n<tr class =\"row-a\">\n<td style=\"text-align:left\">\\(3\\)</td>\n</tr>\n</tbody>\n</table>\n</div>"],
  // (sagebrush: Sage 10.10 writes a literal {style_attr} there)
  ["T21_html_ch_frame", "table([['x', 1]], header_column=True, frame=True)._html_()", "<div class=\"notruncate\">\n<table border=\"1\" class=\"table_form\">\n<tbody>\n<tr class =\"row-a\">\n<td class=\"ch\" style=\"text-align:left\">x</td>\n<td style=\"text-align:left\">\\(1\\)</td>\n</tr>\n</tbody>\n</table>\n</div>"],
  ["T28_empty_first", "str(table([[]]))", ""],
  ["T28_empty_first_then_rows", "str(table([[], [1, 2]]))", ""],
  ["T29_empty_row", "str(table([[1, 2], []]))", ""],
  ["T29_empty_row_head", "str(table([[1, 2], []], header_row=True))", "├┤"],
  ["T29_empty_rows_mid", "str(table([[1, 2], [], [3, 4]]))", "ERR IndexError: list index out of range"],
  ["T30_frame_empty_row", "str(table([[1, 2], []], frame=True))", "┌┐\n│\n├┤\n│\n└┘"],
  ["T31_latex_empty", "str(latex(table([[]])))", ""],
  ["T29_empty_row_before_ragged", "str(table([[1, 2], [], [3]]))", "ERR IndexError: list index out of range"],
  ["T29_empty_row_one_col", "str(table([[1], [], [2]]))", "ERR IndexError: list index out of range"],
  ["T29_empty_last", "str(table([[1, 2], [3, 4], []]))", ""],
  ["T29_ragged_empty_last", "str(table([[1, 2], [3], []]))", ""],
  ["T29_empty_two_last", "str(table([[1, 2], [], []]))", ""],
  ["T29_empty_row_mid", "str(table([[1, 2], [3, 4], [], [5, 6]]))", "ERR IndexError: list index out of range"],
  ["T30_frame_empty_before", "str(table([[1, 2], [], [3, 4]], frame=True))", "ERR IndexError: list index out of range"],
  ["T29_head_empty_before", "str(table([[1, 2], [], [3, 4]], header_row=True))", "ERR IndexError: list index out of range"],
  // (the cells before an empty row made strings first, the ones after it never: Sage's order, and its errors')
  ["T29_str_before_empty", "_logged(\"table([[Loud('a')], [], [1]])\")", "a | ERR IndexError: list index out of range"],
  ["T29_no_str_after_empty", "_logged(\"table([[1], [], [Loud('c')]])\")", " | ERR IndexError: list index out of range"],
  ["T29_str_error_wins", "_logged(\"table([[Loud('a', True)], [], [1]])\")", "a | ERR RuntimeError: bad a"],
  ["T29_str_error_after_unreached", "_logged(\"table([[1], [], [Loud('c', True)]])\")", " | ERR IndexError: list index out of range"],
  ["T29_frame_str_before_only", "_logged(\"table([[Loud('a')], [], [Loud('c')]], frame=True)\")", "a | ERR IndexError: list index out of range"],
  ["T29_head_empty_last", "str(table([[1, 2], [3, 4], []], header_row=True))", "├┤"],
  ["T29_right_empty_before", "str(table([[1, 2], [], [3, 4]], align='right'))", "ERR IndexError: list index out of range"],
  ["T31_latex_empty_mid", "str(latex(table([[1, 2], [], [3, 4]])))", "\\begin{tabular}{ll}\n$1$ & $2$ \\\\\n \\\\\n$3$ & $4$ \\\\\n\\end{tabular}"],
  ["T7_bogus_not_kept", "str((lambda t: (t.options(bogus=1), sorted(t.options().items())))(table([[1]])))", "(None, [('align', 'left'), ('frame', False), ('header_column', False), ('header_row', False)])"],
  ["T7_bogus_then_str", "str((lambda t: (t.options(bogus=1), str(t)))(table([[1]])))", "(None, '  1')"],
  ["T8_frame_int", "str((lambda t: (t.options(frame=1), str(t)))(table([[1]])))", "(None, '┌───┐\\n│ 1 │\\n└───┘')"],
  ["T12_align_unknown", "str((lambda t: (t.options(align='middle'), str(t)))(table([[1, 22], [333, 4]])))", "(None, '  1     22\\n  333   4')"],
  // (sagebrush only: Sage has no Markdown form)
  ["T23_T24_md_escape", "table([['a|b', 'c\\nd']], header_row=['x', 'y'])._repr_markdown_()", "| x | y |\n|:---|:---|\n| a\\|b | c d |"],
  ["T25_md_center", "table([[1, 22]], align='center')._repr_markdown_()", "|  |  |\n|:---:|:---:|\n| $1$ | $22$ |"],
  ["T25_md_right", "table([[1, 22]], align='right')._repr_markdown_()", "|  |  |\n|---:|---:|\n| $1$ | $22$ |"],
  ["T26_md_hcol_bold", "table([['r1', 1], ['r2', 2]], header_column=True)._repr_markdown_()", "|  |  |\n|:---|:---|\n| **r1** | $1$ |\n| **r2** | $2$ |"],
  ["T34_md_empty_row", "table([[1], []])._repr_markdown_()", null],
];
test("table(): text, LaTeX, HTML and Markdown details, as Sage 10.10's (empty rows, options, transpose, headers, bars)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sage-table-"));
  try {
    writeFileSync(join(dir, "cases.json"), JSON.stringify(CASES.map((c) => c[1])));
    const f = join(dir, "cases.sage");
    writeFileSync(f, [
      "import json, os",
      // (a value that logs its str() calls, and may fail in one: when Sage makes a cell a string, and which error wins)
      "_log = []",
      "class Loud:",
      "    def __init__(self, n, bad=False): self.n, self.bad = n, bad",
      "    def __str__(self):",
      "        _log.append(self.n)",
      "        if self.bad: raise RuntimeError('bad ' + self.n)",
      "        return self.n",
      "def _logged(src):",
      "    _log.clear()",
      "    try:",
      "        r = repr(str(eval(src)))",
      "    except Exception as e:",
      "        r = 'ERR ' + type(e).__name__ + ': ' + str(e)",
      "    return ' '.join(_log) + ' | ' + r",
      "_out = []",
      "for _src in json.load(open(os.path.join(" + JSON.stringify(dir) + ", 'cases.json'))):",
      "    try:",
      "        _out.append(eval(_src))",
      "    except Exception as _e:",
      "        _out.append('ERR ' + type(_e).__name__ + ': ' + str(_e))",
      "print(json.dumps(_out))",
    ].join("\n") + "\n");
    const got = JSON.parse(cli(f));
    CASES.forEach(([id, , want], k) => assert.equal(got[k], want, id));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
