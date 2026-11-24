import test from "node:test";
import assert from "node:assert/strict";

// The decision-tree kernel's datasets (src/runtime/skltree.ts, the builtin `_skltree` behind sagebrush.skltree;
// the design note sklearn-trees r3 §3 and §6), in process: the module is made only at the first dataset; X, y
// and the mask are copied in and checked there; a release, a second release and a released token's use; the
// admission against B (refused before anything is made, explained, and charged page-rounded, the heap bound to
// exactly that); a memory far above a new need replaced by a fresh instance; and Stop, both between the copy's
// chunks and inside the module's own scan (a trap): the instance retired, its datasets stale, its memory charged
// as debt until collected, and the next dataset made in a fresh instance.
const DIST = __dirname + "/..";
const c = require(DIST + "/src/compile.js");
const O = require(DIST + "/src/runtime/ops.js");
const { requestCtrlC } = require(DIST + "/src/runtime/interrupt.js");
c.R.importModule("sys").path.push(c.libDir());

const SETUP = [
  "import numpy as np",
  "import _skltree",
  "from sagebrush import skltree",
  "def st():",
  "    g, mem, n, live, debt, retired, b = _skltree._state()",
  "    return dict(gen=g, mem=mem, n=n, live=live, debt=debt, retired=retired, b=b)",
  "def raises(cls, f):",
  "    try:",
  "        f()",
  "    except cls as e:",
  "        return str(e)",
  "    raise AssertionError('no ' + cls.__name__)",
].join("\n");

function run(code: string) {
  try {
    c.execModule(SETUP + "\n" + code, "<skltree>", "__main__");
  } catch (e) {
    throw new Error(c.R.formatException(e));
  }
}

test("importing sagebrush.skltree makes nothing; a dataset is copied, checked, released once, and stale after", () => {
  run(`
s0 = st()
# (this file's first test: the import made no instance and compiled nothing)
assert s0["gen"] == 0 and s0["mem"] == 0, s0
X = np.arange(12, dtype=np.float32).reshape(4, 3)
y = np.array([[0.0], [1.0], [0.0], [1.0]])
ds = skltree.dataset(X, y)
s1 = st()
assert (ds.n_samples, ds.n_features, ds.n_outputs) == (4, 3, 1) and ds.usable
assert s1["n"] == s0["n"] + 1 and s1["live"] >= 4 * 12 + 8 * 4
ds.release()
ds.release()
assert not ds.usable and st()["n"] == s0["n"]
# (a released token, or anything that isn't a token, releases silently)
_skltree.release(object())
_skltree.release(None)
# the checks: types, shapes, NaN and infinity, the mask
assert "float32" in raises(TypeError, lambda: skltree.dataset(X.astype(np.float64), y))
assert "C-contiguous" in raises(TypeError, lambda: skltree.dataset(np.asfortranarray(X), y))
assert "rows" in raises(ValueError, lambda: skltree.dataset(X, y[:3]))
Xn = X.copy(); Xn[2, 1] = np.nan
assert "row 2, column 1" in raises(ValueError, lambda: skltree.dataset(Xn, y))
assert "row 2, column 1" in raises(ValueError, lambda: skltree.dataset(Xn, y, np.array([True, False, True])))
ok = skltree.dataset(Xn, y, np.array([False, True, False]))
assert ok.usable
Xi = X.copy(); Xi[3, 0] = -np.inf
assert "infinity in row 3, column 0" in raises(ValueError, lambda: skltree.dataset(Xi, y, np.ones(3, dtype=bool)))
yn = y.copy(); yn[1, 0] = np.nan
assert "row 1, output 0" in raises(ValueError, lambda: skltree.dataset(X, yn))
assert "only 0 and 1" in raises(ValueError, lambda: skltree.dataset(X, y, np.array([0, 2, 0], dtype=np.uint8)))
# (a refused dataset leaves nothing behind)
assert st()["n"] == s0["n"] + 1
ok.release()
`);
});

test("admission: refused before anything is made, explained; the growth charged page-rounded and bounded at its source", () => {
  run(`
X = np.zeros((1000, 50), dtype=np.float32)
y = np.zeros((1000, 1))
a = skltree.dataset(X, y)
s = st()
# B lowered to just above what is committed: a dataset needing more is a MemoryError naming it, nothing made
_skltree._test_bound(s["mem"] + s["debt"] + 3 * 65536)
msg = raises(MemoryError, lambda: skltree.dataset(X, y))
assert "1000 samples by 50 features" in msg, msg
assert st()["n"] == s["n"] and st()["mem"] == s["mem"]
_skltree._test_bound(None)
# the growth of one dataset never exceeds the pages charged for it: its bytes rounded up, plus 4
need = 4 * 1000 * 50 + 8 * 1000
before = st()["mem"]
b = skltree.dataset(X, y)
assert st()["mem"] - before <= (-(-need // 65536) + 4) * 65536
a.release(); b.release()
`);
});

test("a memory far above a new dataset's need, with nothing live, is replaced by a fresh instance (its old memory charged as debt)", () => {
  run(`
big = skltree.dataset(np.zeros((40000, 50), dtype=np.float32), np.zeros((40000, 1)))
g, mem = st()["gen"], st()["mem"]
big.release()
small = skltree.dataset(np.zeros((4, 2), dtype=np.float32), np.zeros((4, 1)))
s = st()
assert s["gen"] == g + 1 and s["mem"] < mem, s
# (finalizers run only between tasks: within this run the old memory is still charged)
assert s["debt"] >= mem and s["retired"] >= 1, s
small.release()
# (a small memory with nothing live is kept: no churn)
again = skltree.dataset(np.zeros((4, 2), dtype=np.float32), np.zeros((4, 1)))
assert st()["gen"] == s["gen"]
again.release()
`);
});

// (the copy's polls, counted from the module's copyIn: a Stop requested at a chosen one; `pending` leaves it
// unconsumed, so that the next poll of Stop, the module's own scan, sees it instead)
function armCopyPoll(at: number, pending: boolean): () => void {
  const poll = O.pollInterrupt;
  let n = 0;
  O.pollInterrupt = () => {
    const caller = String(new Error().stack).split("\n")[2] ?? "";
    const mine = caller.includes("skltree.js") && caller.includes("copyIn");
    if (mine) n++;
    if (mine && !pending && n === at) requestCtrlC();
    const r = poll();
    if (mine && pending && n === at) requestCtrlC();
    return r;
  };
  return () => (O.pollInterrupt = poll);
}

test("Stop between the copy's chunks: a KeyboardInterrupt, the open dataset gone, the instance kept", () => {
  // (X: 80000 elements, 20 chunks; Stop at the 5th)
  const restore = armCopyPoll(5, false);
  try {
    run(`
X = np.zeros((20000, 4), dtype=np.float32)
y = np.zeros((20000, 1))
s = st()
raises(KeyboardInterrupt, lambda: skltree.dataset(X, y))
t = st()
assert t["gen"] == s["gen"] and t["n"] == s["n"], (s, t)
`);
  } finally {
    restore();
  }
  run(`
d = skltree.dataset(np.zeros((20000, 4), dtype=np.float32), np.zeros((20000, 1)))
assert d.usable
d.release()
`);
});

test("Stop inside the module's own scan: the instance retired (its datasets stale, its memory charged), the next dataset fresh", () => {
  // (keep: X and y one chunk each, 2 polls; then X: 400000 elements, 98 chunks, and y: 50000, 13 chunks: Stop
  // requested after the copy's last poll, the 113th, and left for the seal scan)
  const restore = armCopyPoll(2 + 98 + 13, true);
  try {
    run(`
keep = skltree.dataset(np.ones((10, 2), dtype=np.float32), np.ones((10, 1)))
s = st()
raises(KeyboardInterrupt, lambda: skltree.dataset(np.zeros((50000, 8), dtype=np.float32), np.zeros((50000, 1))))
t = st()
assert t["mem"] == 0 and t["n"] == 0, t
assert t["debt"] >= s["mem"] and t["retired"] >= 1, (s, t)
# the earlier dataset is stale: not usable, and releasing it is silently nothing
assert not keep.usable
keep.release()
fresh = skltree.dataset(np.ones((10, 2), dtype=np.float32), np.ones((10, 1)))
assert fresh.usable and st()["gen"] > s["gen"]
fresh.release()
`);
  } finally {
    restore();
  }
});
