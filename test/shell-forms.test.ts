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
  return m ? [m[1], m[2].replace(/\\(.)/g, "$1")] : null;   // (exactly: IPython keeps the spaces after !)
};
const ours = (py: string): [string, string] | null => {
  const m = /__pyjs_magic__\("(\w+)", ("(?:[^"\\]|\\.)*")(, __pyjs_globals__\(\), __pyjs_locals__\(\))?\)/.exec(py);
  if (!m) return null;
  return [m[1], JSON.parse(m[2])];
};

test("the shell forms are lowered as IPython's", () => {
  for (const { src, py } of oracle.transform) {
    const want = ipy(py), mine = magicSyntax(src);
    assert.deepEqual(ours(mine), want, `${JSON.stringify(src)}: IPython ${JSON.stringify(py)}, Sagebrush ${JSON.stringify(mine)}`);
    if (want && ["system", "getoutput", "sx"].includes(want[0])) assert.match(mine, /, __pyjs_globals__\(\), __pyjs_locals__\(\)\)/, src);
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

// A notebook session, as test/magics.test.ts runs one
async function session() {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  let id = 1000 * Math.floor(Math.random() * 1000);
  return {
    async run(code: string) {
      const n = ++id;
      await s.handle({ id: n, code });
      const out = msgs.filter((m) => m.id === n && m.stream === "stdout").map((m) => m.text).join("");
      const err = msgs.filter((m) => m.id === n && m.stream === "stderr").map((m) => m.text).join("");
      return { out, err, failed: !!msgs.find((m) => m.id === n && m.done)?.error };
    },
  };
}
const REFUSED = /^ShellUnavailableError: shell commands aren't available in Sagebrush yet/;
// (every target an oracle case assigns, with a value to keep: x, x.y, x[0], a, b, y)
const SETUP = "class L(list): pass\nx = L(['old0'])\nx.y = 'oldy'\na = 'A'\nb = 'B'\ny = 'Y'\nX0 = x";
const KEPT = "print(x is X0, x[0], x.y, a, b, y)";

test("until the bridge, every shell form of the oracle refuses, and assigns nothing", async () => {
  const s = await session();
  for (const { src, py } of oracle.transform) {
    const form = ipy(py) !== null;
    assert.equal((await s.run(SETUP)).failed, false);
    const r = await s.run(src);
    if (form) {
      assert.ok(r.failed, src);
      assert.match(r.err, REFUSED, `${src}: ${r.err}`);
      assert.equal((await s.run(KEPT)).out, "True old0 oldy A B Y\n", `${src}: a target changed`);
    } else assert.doesNotMatch(r.err, /ShellUnavailableError/, src);
  }
});

test("the shell forms reach the caller's namespaces even where globals or locals are the code's own names", async () => {
  const s = await session();
  const cmd = (code: string) => `${code}\ntry:\n    CMD = None\n    !echo {y} $z\nexcept Exception as e:\n    CMD = (type(e).__name__, e.command)\nprint(CMD)`;
  // (at the top level, globals and locals rebound)
  for (const name of ["globals", "locals"]) {
    const r = await s.run(cmd(`${name} = 1\ny = 2\nz = 1`));
    assert.equal(r.out, "('ShellUnavailableError', 'echo 2 1')\n", `${name} = 1: ${r.err}`);
  }
  // (in a function: parameters named globals and locals; y global, z local)
  for (const name of ["globals", "locals"]) {
    const r = await s.run(`y = 2\ndef f(z, ${name}=5):\n    try:\n        !echo {y} $z\n    except Exception as e:\n        return (type(e).__name__, e.command)\nprint(f(1))`);
    assert.equal(r.out, "('ShellUnavailableError', 'echo 2 1')\n", `parameter ${name}: ${r.err}`);
  }
  // (the function's local wins over the global of the same name, as IPython's frame lookup)
  const r = await s.run(`y = 2\ndef g():\n    y = 'local'\n    try:\n        !echo {y}\n    except Exception as e:\n        return e.command\nprint(g())`);
  assert.equal(r.out, "echo local\n", r.err);
  await s.run("del globals, locals");
});
