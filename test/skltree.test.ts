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

test("addresses at or above 2 GiB: the module's signed i32 results are read unsigned (views and the refusal)", () => {
  const S = require(DIST + "/src/runtime/skltree.js");
  // (2**31 + 64 as wasm32 returns it to JS: an i32, so negative)
  const ADDR = 2 ** 31 + 64, SIGNED = ADDR | 0;
  assert.equal(SIGNED, -2147483584);
  assert.equal(S.at(SIGNED), 2147483712);
  // (a memory just past 2 GiB: an ArrayBuffer the system commits only where it is written)
  const buffer = new ArrayBuffer(2 ** 31 + 4096);
  new Uint32Array(buffer, ADDR, 1)[0] = 7;
  const stub = {
    memory: { buffer },
    skt_dataset_x: () => SIGNED,
    skt_dataset_y: () => SIGNED + 64,
    skt_dataset_mask: () => SIGNED + 256,
    skt_last_refusal: () => SIGNED,
  };
  const v = S.datasetViews(stub, 1, 2, 3, 1, true);
  assert.equal(v.x.byteOffset, 2147483712);
  assert.equal(v.y.byteOffset, 2147483712 + 64);
  assert.equal(v.mask.byteOffset, 2147483712 + 256);
  assert.deepEqual([v.x.length, v.y.length, v.mask.length], [6, 2, 3]);
  // the refused pages are read where the module put them, not lost to a RangeError
  assert.equal(S.refusedPages(stub), 7);
  // (the signed offset itself is what threw before the fix)
  assert.throws(() => new Float32Array(buffer, SIGNED, 6), RangeError);
});

test("fit: refusals of what Python passes (labels, weights, parameters, a stale dataset, a malformed tree)", () => {
  run(`
X = np.arange(12, dtype=np.float32).reshape(6, 2)
y = np.array([[0.0], [1.0], [1.0], [2.0], [0.0], [1.0]])
ds = skltree.dataset(X, y)
kw = dict(criterion="gini", max_features=2, seed=1)
assert "row 3, output 0" in raises(ValueError, lambda: skltree.fit(ds, n_classes=[2], **kw))
assert "n_classes" in raises(ValueError, lambda: skltree.fit(ds, n_classes=[3, 3], **kw))
assert "finite" in raises(ValueError, lambda: skltree.fit(ds, np.array([1.0, np.nan, 1, 1, 1, 1]), n_classes=[3], **kw))
assert "finite" in raises(ValueError, lambda: skltree.fit(ds, np.zeros(6), n_classes=[3], **kw))
assert "6 expected" in raises(ValueError, lambda: skltree.fit(ds, np.ones(5), n_classes=[3], **kw))
assert "out of range" in raises(ValueError, lambda: skltree.fit(ds, n_classes=[3], criterion="gini", max_features=3, seed=1))
assert "criterion" in raises(ValueError, lambda: skltree.fit(ds, n_classes=[3], criterion="poisson", max_features=2, seed=1))
t = skltree.fit(ds, n_classes=[3], **kw)
assert t["node_count"] >= 3 and t["value"].shape == (t["node_count"], 1, 3)
assert list(skltree.apply(t, X)) == list(skltree.apply(t, X))
# a tree whose arrays don't form a tree is refused, not walked out of bounds
bad = dict(t)
bad["children_left"] = t["children_left"].copy()
bad["children_left"][0] = 0
assert "form a tree" in raises(ValueError, lambda: skltree.apply(bad, X))
bad["feature"] = t["feature"].copy()
bad["children_left"] = t["children_left"]
bad["feature"][0] = 9
assert "form a tree" in raises(ValueError, lambda: skltree.apply(bad, X))
ds.release()
assert "released" in raises(ValueError, lambda: skltree.fit(ds, n_classes=[3], **kw))
`);
});

test("fit: admitted before anything is made (refused with the memory unchanged), and growing within what it was charged", () => {
  run(`
X = np.zeros((2000, 8), dtype=np.float32)
X[:, 0] = np.arange(2000)
y = (np.arange(2000) % 4).astype(np.float64)[:, None]
ds = skltree.dataset(X, y)
s = st()
_skltree._test_bound(s["mem"] + s["debt"] + 2 * 65536)
msg = raises(MemoryError, lambda: skltree.fit(ds, n_classes=[4], criterion="gini", max_features=8, seed=3))
assert "Fitting a tree on 2000 samples by 8 features" in msg, msg
assert st()["mem"] == s["mem"] and st()["n"] == s["n"]
_skltree._test_bound(None)
before = st()["mem"]
t = skltree.fit(ds, n_classes=[4], criterion="entropy", max_features=8, seed=3)
# (charged: the fit's bound, page-rounded, plus a page an allocation)
assert st()["mem"] - before <= (-(-(2000 * 32 + 8 * 16 + 4 * 24 + 2002 * 64 + 3999 * (57 + 32) + 64 + 8 * 2005) // 65536) + 24) * 65536
assert t["node_count"] > 1
# and the tree in the module is released after its copy out: the live bytes are the dataset's
assert st()["live"] == 2000 * 8 * 4 + 2000 * 8
ds.release()
`);
});

test("Stop between a fit's buffer copies: a KeyboardInterrupt, and no buffer left behind", () => {
  // (Ctrl-C at the weights' 5th copy poll: X and y are 13 chunks each first)
  const restore = armCopyPoll(13 + 13 + 5, false);
  try {
    run(`
n = 50000
X = np.zeros((n, 1), dtype=np.float32)
y = (np.arange(n) % 3).astype(np.float64)[:, None]
ds = skltree.dataset(X, y)
s = st()
raises(KeyboardInterrupt, lambda: skltree.fit(ds, np.ones(n), n_classes=[3], criterion="gini", max_features=1, seed=1))
t = st()
assert t["live"] == s["live"] and t["gen"] == s["gen"] and ds.usable, (s, t)
ds.release()
`);
  } finally {
    restore();
  }
});

test("Stop inside the kernel's fit: a KeyboardInterrupt, the instance retired, the next fit in a fresh one", () => {
  // (Ctrl-C requested at the class counts' copy poll, the last before the kernel's fit, and left pending, so the
  // fit is what sees it and traps: X and y are 50000 elements each, 13 chunks of 4096, the weights 13 more, the
  // counts 1: the 40th poll)
  const restore = armCopyPoll(13 + 13 + 13 + 1, true);
  try {
    run(`
n = 50000
X = np.zeros((n, 1), dtype=np.float32)
X[:, 0] = np.arange(n) % 997
y = (np.arange(n) % 3).astype(np.float64)[:, None]
ds = skltree.dataset(X, y)
s = st()
raises(KeyboardInterrupt, lambda: skltree.fit(ds, np.ones(n), n_classes=[3], criterion="gini", max_features=1, seed=1))
t = st()
assert t["mem"] == 0 and t["n"] == 0 and t["debt"] >= s["mem"], (s, t)
assert not ds.usable
d2 = skltree.dataset(X[:100].copy(), y[:100].copy())
assert skltree.fit(d2, n_classes=[3], criterion="gini", max_features=1, seed=1)["node_count"] > 1
`);
  } finally {
    restore();
  }
});
