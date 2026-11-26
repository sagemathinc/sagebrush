import test from "node:test";
import assert from "node:assert/strict";

// One engine session runs Sage, Python and MATLAB cells in one namespace (src/notebook-session.ts). A name another
// language left there that isn't a MATLAB value (a Python or Sage function, class or module) must not hide MATLAB's
// function of that name: after Sage, MATLAB's norm(A*x - b) gave "Unable to index a value of type function"
// (src/matlab.ts inWorkspace, lib/_matlab.py foreign). A plain value another language left stays a variable.

async function session() {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  let id = 0;
  return {
    async run(code: string, mode: Record<string, boolean>) {
      const n = ++id;
      await s.handle({ id: n, code, ...mode });
      const mine = msgs.filter((m) => m.id === n);
      return { out: mine.filter((m) => m.stream === "stdout").map((m) => m.text).join(""),
               err: mine.filter((m) => m.stream === "stderr").map((m) => m.text).join("") };
    },
  };
}

// [the language that ran first, its code, MATLAB's code after it, MATLAB's output]
const ROWS: [Record<string, boolean>, string, string, string][] = [
  [{ sage: true }, "x = 1", "A = [2 1; 1 3]; b = [1; 2]; x = A\\b; disp(norm(A*x - b) < 1e-12)", "   1\n"],
  [{}, "from numpy.linalg import norm", "disp(norm([3 4]))", "     5\n"],
  [{}, "import math\nfrom math import floor", "disp(floor(2.5))", "     2\n"],
  [{}, "def max(*a):\n    return 'python'", "disp(max([1 5 2]))", "     5\n"],
  [{}, "from numpy.linalg import norm", "f = @(v) norm(v); disp(f([6 8]))", "    10\n"],
  [{}, "n = 7", "disp(n + 1)", "     8\n"],
];

test("a MATLAB built-in shadowed by a Sage or Python global in the shared session is still MATLAB's", async () => {
  for (const [mode, first, matlab, want] of ROWS) {
    const s = await session();
    const a = await s.run(first, mode);
    assert.equal(a.err, "", first);
    const r = await s.run(matlab, { matlab: true });
    assert.equal(r.err, "", `${first} | ${matlab}`);
    assert.equal(r.out, want, `${first} | ${matlab}`);
  }
});

test("who lists MATLAB's variables, not the functions and modules another language left", async () => {
  const s = await session();
  await s.run("import math\nfrom numpy.linalg import norm\nn = 7", {});
  const r = await s.run("k = 1; disp(strjoin(who', ' '))", { matlab: true });
  assert.equal(r.err, "");
  assert.equal(r.out, "k n\n");
});
