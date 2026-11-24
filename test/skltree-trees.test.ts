import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Every scikit-learn 1.9.1 tree of engine/skltree/oracle/trees.rows grown again through the whole shipped path:
// sagebrush.skltree.dataset and fit (the built wasm module, its admission, the copy out into numpy arrays) and apply
// (TypeScript), in process.  Each fitted array, the raw importances and apply's leaves are hashed (FNV-1a of their
// little-endian bytes) as the recorder hashed scikit-learn's, so a row differs if any bit of any array does.
const DIST = __dirname + "/..";
const ROWS = join(__dirname, "..", "..", "engine", "skltree", "oracle", "trees.rows");
const c = require(DIST + "/src/compile.js");
const Obj = require(DIST + "/src/runtime/object.js");
c.R.importModule("sys").path.push(c.libDir());

const PY = `
import numpy as np, struct
from sagebrush import skltree
data, ys, sws, cases = {}, {}, {}, []
for line in open(ROWS).read().split("\\n"):
    if not line or line[0] == "#":
        continue
    f = line.split(" ")
    if f[0] == "data":
        data[f[1]] = [int(f[2]), int(f[3]), None]
    elif f[0] == "x":
        n, nf, _ = data[f[1]]
        data[f[1]][2] = np.array(struct.unpack('>%df' % (len(f) - 2), bytes.fromhex(''.join(f[2:]))), dtype=np.float32).reshape(n, nf)
    elif f[0] == "y":
        ys[(f[1], f[2])] = f[3:]
    elif f[0] == "sw":
        sws[f[1]] = np.array([float(v) for v in f[2:]])
    elif f[0] == "case":
        cases.append(f)
sets = {}
results = []
for f in cases:
    cid, name, kind = f[1], f[2], f[3]
    n, nf, X = data[name]
    group = "reg" if kind == "mse" else "clf"
    hx = ys[(name, group)]
    yb = np.array(struct.unpack('>%dd' % len(hx), bytes.fromhex(''.join(hx))))
    y = yb.reshape(n, len(yb) // n)
    mask = None if f[12] == "-" else np.array([int(ch) for ch in f[12]], dtype=np.uint8)
    key = (name, group)
    if key not in sets:
        sets[key] = skltree.dataset(X, y, mask)
    ncls = None if f[4] == "-" else [int(v) for v in f[4].split(",")]
    crit = {"gini": "gini", "entropy": "entropy", "mse": "squared_error"}[kind]
    t = skltree.fit(sets[key], sws.get(cid), n_classes=ncls, criterion=crit, max_depth=int(f[5]), min_samples_split=int(f[6]),
                    min_samples_leaf=int(f[7]), min_weight_leaf=float.fromhex(f[8]), max_features=int(f[9]),
                    min_impurity_decrease=float.fromhex(f[10]), seed=int(f[11]))
    results.append((cid, t, skltree.apply(t, X), [int(f[13]), int(f[14])] + f[15:]))
`;

function fnv(bytes: Uint8Array, h = 0xcbf29ce484222325n): bigint {
  for (const b of bytes) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return h;
}
// (Sagebrush's int64 arrays hold exact doubles: their int64 bytes, as numpy's tobytes)
const i64 = (a: any) => new Uint8Array(BigInt64Array.from(a.data.subarray(a.offset, a.offset + a.size), (v: number) => BigInt(v)).buffer);
const f64 = (a: any) => new Uint8Array(Float64Array.from(a.data.subarray(a.offset, a.offset + a.size)).buffer);
const u8 = (a: any) => new Uint8Array(a.data.subarray(a.offset, a.offset + a.size));

test("every scikit-learn tree of the oracle rows, grown again through the wasm module, its copy out and apply", () => {
  let m: any;
  try {
    m = c.execModule(`ROWS = ${JSON.stringify(ROWS)}\n` + PY, "<skltree-trees>", "__main__");
  } catch (e) {
    throw new Error(c.R.formatException(e));
  }
  const results = m.results;
  assert.equal(results.length, 273);
  const get = (d: any, k: string) => Obj.dictGet(d, k);
  const NAMES = ["children_left", "children_right", "feature", "threshold", "impurity", "n_node_samples", "weighted_n_node_samples", "missing_go_to_left", "value", "importances", "apply"];
  const bad: string[] = [];
  for (const [cid, t, leaves, want] of results) {
    const got = [
      fnv(i64(get(t, "children_left"))), fnv(i64(get(t, "children_right"))), fnv(i64(get(t, "feature"))), fnv(f64(get(t, "threshold"))),
      fnv(f64(get(t, "impurity"))), fnv(i64(get(t, "n_node_samples"))), fnv(f64(get(t, "weighted_n_node_samples"))),
      fnv(u8(get(t, "missing_go_to_left"))), fnv(f64(get(t, "value"))), fnv(f64(get(t, "importances"))), fnv(i64(leaves)),
    ];
    const diff = NAMES.filter((_, i) => got[i] !== BigInt("0x" + want[2 + i]));
    if (Number(get(t, "node_count")) !== Number(want[0])) diff.unshift("node_count");
    if (Number(get(t, "max_depth")) !== Number(want[1])) diff.push("max_depth");
    if (diff.length) bad.push(`case ${cid}: ${diff.join(", ")}`);
  }
  assert.deepEqual(bad, []);
});
