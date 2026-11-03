// IPython's shell forms (!cmd, x = !cmd, !!cmd, %sx, %system): how cells
// lower them (src/magic-syntax.ts), how commands are expanded and what SList
// does (lib/_pyjs_shell.py, sagebrush.shell), each against IPython's own results frozen in
// test/shell_forms_oracle.json (scripts/shell-forms-oracle.py, IPython 9.17.1).
// The shell isn't connected to Python yet: once expanded, a command raises
// ShellUnavailableError (test/magics.test.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { magicSyntax } from "../src/magic-syntax";

const ORACLE = __dirname + "/../../test/shell_forms_oracle.json";
const oracle = JSON.parse(readFileSync(ORACLE, "utf8"));

// IPython's lowering, as (kind, command): kind system, getoutput or a magic's
// name; null when the line isn't a shell form
const ipy = (py: string): [string, string] | null => {
  const m = /get_ipython\(\)\.(system|getoutput)\('((?:[^'\\]|\\.)*)'\)/.exec(py) ?? /get_ipython\(\)\.run_line_magic\('(\w+)', '((?:[^'\\]|\\.)*)'\)/.exec(py);
  return m ? [m[1], m[2].replace(/\\(.)/g, "$1").trim()] : null;
};
const ours = (py: string): [string, string] | null => {
  const m = /__pyjs_magic__\("(\w+)", ("(?:[^"\\]|\\.)*")(, globals\(\), locals\(\))?\)/.exec(py);
  if (!m) return null;
  return [m[1], JSON.parse(m[2])];
};

test("the shell forms are lowered as IPython's", () => {
  for (const { src, py } of oracle.transform) {
    const want = ipy(py), mine = magicSyntax(src);
    assert.deepEqual(ours(mine), want, `${JSON.stringify(src)}: IPython ${JSON.stringify(py)}, Sagebrush ${JSON.stringify(mine)}`);
    if (want && ["system", "getoutput", "sx"].includes(want[0])) assert.match(mine, /, globals\(\), locals\(\)\)/, src);
    // (an assignment keeps its target, as written)
    const lhs = /^(\s*[^=]*?=)\s*get_ipython/.exec(py.split("\n").find((l) => l.includes("get_ipython")) ?? "");
    if (lhs) assert.ok(mine.split("\n").some((l) => l.startsWith(lhs[1])), `${src}: target ${lhs[1]}`);
  }
});

test("commands are expanded and SList behaves as IPython's", () => {
  const out = JSON.parse(execFileSync(process.execPath, [__dirname + "/../src/cli.js", __dirname + "/../../test/shell_forms_cases.py", ORACLE], { encoding: "utf8" }));
  for (let i = 0; i < oracle.expand.length; i++) {
    const { cmd, out: want } = oracle.expand[i];
    if (/ at 0x[0-9a-f]+>/.test(want)) continue;   // (a bound method's repr: its address)
    assert.equal(out.expand[i].out, want, cmd);
  }
  assert.equal(out.expand_locals, oracle.expand_locals);
  assert.deepEqual(out.slist, oracle.slist);
  assert.deepEqual(out.errors, [true, true, true, true, "bash.ops exceeded (5)"]);
});
