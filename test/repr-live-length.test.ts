import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// repr of a list follows the list's length at each step, as CPython's does,
// so a __repr__ that clears, grows or shrinks the list it is in is seen
// (Sagebrush took the length once and showed [Q, ] for a cleared list).
// Each case is compared with what CPython prints. A list or dict that a
// __repr__ makes grow forever is refused past a limit (REPR_GROWTH, the
// items reached past the length it had, and their characters), as a
// notebook's display refuses it, where CPython never ends.
const TEST = __dirname + "/../../test/";
const cli = __dirname + "/../src/cli.js";

test("repr of a list that a __repr__ changes: as CPython's", () => {
  const name = "repr_live_length_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" });
  const got = execFileSync(process.execPath, [cli, TEST + name], { encoding: "utf8" });
  const w = want.split("\n"), g = got.split("\n");
  for (let i = 0; i < Math.max(w.length, g.length); i++) assert.equal(g[i], w[i], `${name} line ${i + 1}`);
});

test("a list or dict that a __repr__ makes grow forever: MemoryError past the limit", async () => {
  const { notebookSession } = require("../src/notebook-session");
  const F = require("../src/runtime/format");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  let id = 0;
  const run = async (code: string) => {
    const n = ++id;
    await s.handle({ id: n, code });
    const of = (stream: string) => msgs.filter((m) => m.id === n && m.stream === stream).map((m) => m.text).join("");
    return { out: of("stdout"), err: of("stderr") };
  };
  const saved = { ...F.REPR_GROWTH };
  F.REPR_GROWTH.steps = 20000;
  F.REPR_GROWTH.chars = 1 << 20;
  try {
    const CASES: [string, string, string][] = [
      ["class G:\n    def __repr__(self):\n        V.append(G())\n        return 'G'\nV = [G()]", "repr(V)", "len(V) <= 20003"],
      ["class B:\n    def __repr__(self):\n        W.append(B())\n        return 'b' * 10000\nW = [B()]", "repr(W)", "100 < len(W) <= 108"],
      ["class K:\n    n = 0\n    def __repr__(self):\n        K.n += 1\n        D[K.n] = K()\n        return 'K'\nD = {0: K()}", "repr(D)", "len(D) <= 20003"],
      ["class C:\n    n = 0\n    def __repr__(self):\n        C.n += 1\n        E.pop(C.n - 1)\n        E[C.n] = C()\n        return 'C'\nE = {0: C()}", "repr(E)", "len(E) == 1"],
      // (a nested repr counts with the outer one: it can't start the count again)
      ["class N:\n    def __repr__(self):\n        repr([1, 2])\n        X.append(N())\n        return 'n'\nX = [N()]", "repr(X)", "len(X) <= 20003"],
      ["class P:\n    def __repr__(self):\n        Y.append(P())\n        return 'p'\nY = [P()]", "str([Y])", "len(Y) <= 20003"],
    ];
    for (const [setup, expr, bound] of CASES) {
      assert.equal((await run(setup)).err, "", setup);
      const { out, err } = await run(expr);
      assert.equal(out, "", expr);
      assert.match(err, /MemoryError: displaying this value takes more than Sagebrush's limit of 20000 steps or 1048576 characters/, setup);
      assert.equal((await run(bound)).out, "True\n", `${setup}: ${bound}`);
      // (and the session goes on; its next repr is counted afresh)
      assert.equal((await run("repr([1, [2, 3], {4: 5}])")).out, "'[1, [2, 3], {4: 5}]'\n");
    }
    // (a list that nothing changes is not refused, however long)
    assert.equal((await run("len(repr(list(range(100000))))")).out, "688890\n");
  } finally {
    Object.assign(F.REPR_GROWTH, saved);
  }
});
