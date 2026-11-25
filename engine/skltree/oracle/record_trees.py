"""Record engine/skltree's tree oracle rows from real scikit-learn (oracle/trees.rows, a text file
src/oracle_tests.rs reads): DecisionTreeClassifier and DecisionTreeRegressor fitted on synthetic float32 datasets
(generated here, stored in the rows), with what scikit-learn resolves in Python before its builder runs (the
encoded y, the sample weights, the resolved parameters, the XorShift seed `randint(0, RAND_R_MAX)` from the
estimator's RandomState, the missing-value mask), and every array of the fitted `tree_` hashed, with the raw
importances (`compute_feature_importances(normalize=False)`) and `apply` on the training X.

The datasets cover the partitioner's paths without test hooks: NaN in X during fit (both search passes, and nodes
with and without missing values in a feature), values within FEATURE_THRESHOLD of each other, constant and
near-constant features, ties, zero and fractional sample weights, multi-output y.

Run with the pinned oracle, read-only, and commit the rows; re-recording is a reviewed change:

    $VENV/bin/python -I engine/skltree/oracle/record_trees.py > engine/skltree/oracle/trees.rows

where $VENV is a venv with scikit-learn 1.9.1 (the rows' first line names the versions they were recorded with).
"""
import platform
import sys

import numpy as np
import sklearn
from sklearn.tree import DecisionTreeClassifier, DecisionTreeRegressor

M64 = (1 << 64) - 1
RAND_R_MAX = 2**31 - 1


def fnv(data):
    h = 0xCBF29CE484222325
    for b in data:
        h = ((h ^ b) * 0x100000001B3) & M64
    return h


def f32hex(a):
    return " ".join(f"{v:08x}" for v in np.ascontiguousarray(a, dtype="<f4").view("<u4").ravel())


def f64hex(a):
    return " ".join(f"{v:016x}" for v in np.ascontiguousarray(a, dtype="<f8").view("<u8").ravel())


def datasets():
    rs = np.random.RandomState(2026)
    out = {}
    # three classes, thirteen features, values k/16 with a per-class shift
    n, f = 178, 13
    c = np.arange(n) % 3
    X = (rs.randint(0, 400, (n, f)) + (c[:, None] * rs.randint(0, 120, f)[None, :])) / 16.0
    out["clf3"] = (X.astype(np.float32), c.astype(np.float64)[:, None])
    # ties: four values a feature, a constant feature, and a feature of 1.0 and the next float32 (one value within
    # FEATURE_THRESHOLD), and one of 1.0, 1 + eps and 1 + 2 eps (a chained tie)
    n = 120
    X = rs.randint(0, 4, (n, 6)).astype(np.float32)
    X[:, 4] = np.where(rs.randint(0, 2, n) == 1, np.float32(1) + np.finfo(np.float32).eps, np.float32(1))
    X[:, 5] = 7
    X = np.column_stack([X, (np.float32(1) + rs.randint(0, 3, n).astype(np.float32) * np.finfo(np.float32).eps).astype(np.float32)])
    yt = (X[:, 0] + X[:, 1] + rs.randint(0, 2, n)) % 3
    out["ties"] = (X.astype(np.float32), yt.astype(np.float64)[:, None])
    # NaN: column 0 missing in 20% of rows; column 2 missing only in class 0 (nodes of the other classes have none);
    # column 4 all missing but in ten rows
    n = 150
    c = rs.randint(0, 3, n)
    X = (rs.randint(0, 300, (n, 5)) + c[:, None] * 40).astype(np.float64) / 8.0
    X[rs.rand(n) < 0.2, 0] = np.nan
    X[(c == 0) & (rs.rand(n) < 0.5), 2] = np.nan
    keep = rs.choice(n, 10, replace=False)
    m = np.ones(n, bool)
    m[keep] = False
    X[m, 4] = np.nan
    out["nan"] = (X.astype(np.float32), c.astype(np.float64)[:, None])
    # a larger one: deeper trees, long nodes
    n, f = 600, 10
    c = rs.randint(0, 4, n)
    X = (rs.randint(0, 2000, (n, f)) + c[:, None] * rs.randint(0, 300, f)[None, :]) / 32.0
    out["big"] = (X.astype(np.float32), c.astype(np.float64)[:, None])
    # multi-output classification: 3 and 2 classes
    n = 100
    X = rs.randint(0, 50, (n, 4)) / 4.0
    Y = np.column_stack([(X[:, 0] + X[:, 1] > 12).astype(int) + (X[:, 2] > 6), (X[:, 3] > 5).astype(int)])
    out["multi"] = (X.astype(np.float32), Y.astype(np.float64))
    # regression: y integer combinations / 8
    n, f = 200, 8
    X = rs.randint(0, 100, (n, f)) / 4.0
    y = (X[:, 0] * 3 + X[:, 1] * X[:, 2] / 8 + rs.randint(0, 16, n)) / 8.0
    out["reg"] = (X.astype(np.float32), y.astype(np.float64)[:, None])
    # regression with NaN in X, and two outputs
    n = 160
    X = rs.randint(0, 80, (n, 4)).astype(np.float64) / 2.0
    X[rs.rand(n) < 0.25, 1] = np.nan
    Y = np.column_stack([np.nan_to_num(X[:, 1], nan=20.0) + X[:, 0] / 4, rs.randint(0, 9, n) / 2.0])
    out["regnan2"] = (X.astype(np.float32), Y.astype(np.float64))
    # rough values: full-mantissa float32 features (so float32 sums round), and a feature of adjacent float32 pairs
    # (a split between two neighbours, whose float64 midpoint rounds to one of them in float32)
    n = 200
    c = rs.randint(0, 3, n)
    X = (rs.rand(n, 5) * 100 + c[:, None] * 7).astype(np.float32)
    # (each base has an odd last mantissa bit, so the float64 midpoint to its neighbour rounds UP in float32, a tie
    # broken to even: compared in float32, the upper value would go left)
    base = np.nextafter(np.array([1000.0, 1001.0, 1002.0, 1003.0], np.float32), np.float32(np.inf))
    assert all(int(v) & 1 for v in base.view(np.uint32))
    pick = rs.randint(0, 4, n)
    upper = (c == 2) | (rs.rand(n) < 0.1)
    pair = np.where(upper, np.nextafter(base[pick], np.float32(np.inf)), base[pick]).astype(np.float32)
    X = np.column_stack([X, pair]).astype(np.float32)
    out["rough"] = (X, c.astype(np.float64)[:, None])
    # rough regression: non-dyadic targets (so sums round in the order they are made), with blocks of an equal
    # non-dyadic target (a pure node's MSE impurity is rounding residue: the EPSILON test)
    n = 240
    X = (rs.rand(n, 4) * 50).astype(np.float32)
    y = rs.rand(n) * 10 + 0.1
    y[X[:, 0] < 15] = 0.1
    y[(X[:, 0] >= 15) & (X[:, 1] < 10)] = 1.0 / 3.0
    out["regrough"] = (X, y[:, None])
    return out


def resolve(est, X, sample_weight):
    """What _classes.py:_fit resolves before the builder: max_features_, min_samples_* as ints, min_weight_leaf."""
    n = X.shape[0]
    msl = est.min_samples_leaf if isinstance(est.min_samples_leaf, (int, np.integer)) else int(np.ceil(est.min_samples_leaf * n))
    mss = est.min_samples_split if isinstance(est.min_samples_split, (int, np.integer)) else max(2, int(np.ceil(est.min_samples_split * n)))
    mss = max(mss, 2 * msl)
    mwl = est.min_weight_fraction_leaf * (n if sample_weight is None else np.sum(sample_weight))
    md = np.iinfo(np.int32).max if est.max_depth is None else est.max_depth
    return md, mss, msl, mwl


YS = {}


def row(case_id, name, kind, est, X, Y, sample_weight, out):
    fit_y = Y[:, 0] if Y.shape[1] == 1 else Y
    est.fit(X, fit_y, sample_weight=sample_weight)
    t = est.tree_
    seed = np.random.RandomState(est.random_state).randint(0, RAND_R_MAX)
    if kind == "mse":
        n_classes = []
        ye = Y
    else:
        ye = np.zeros_like(Y)
        n_classes = []
        for k in range(Y.shape[1]):
            cls, inv = np.unique(Y[:, k], return_inverse=True)
            ye[:, k] = inv
            n_classes.append(len(cls))
    md, mss, msl, mwl = resolve(est, X, sample_weight)
    mask = np.isnan(X).any(axis=0).astype(np.uint8) if np.isnan(X).any() else None
    imp = t.compute_feature_importances(normalize=False)
    leaves = t.apply(X)
    arrays = [
        t.children_left.astype("<i8").tobytes(), t.children_right.astype("<i8").tobytes(), t.feature.astype("<i8").tobytes(),
        t.threshold.astype("<f8").tobytes(), t.impurity.astype("<f8").tobytes(), t.n_node_samples.astype("<i8").tobytes(),
        t.weighted_n_node_samples.astype("<f8").tobytes(), t.missing_go_to_left.astype("u1").tobytes(),
        np.ascontiguousarray(t.value, dtype="<f8").tobytes(), imp.astype("<f8").tobytes(), leaves.astype("<i8").tobytes(),
    ]
    out.write(
        f"case {case_id} {name} {kind} {','.join(map(str, n_classes)) or '-'} {md} {mss} {msl} {float(mwl).hex()} {est.max_features_} "
        f"{float(est.min_impurity_decrease).hex()} {seed} {'-' if mask is None else ''.join(map(str, mask))} "
        f"{t.node_count} {t.max_depth} {' '.join(f'{fnv(a):016x}' for a in arrays)}\n"
    )
    key = (name, kind == "mse")
    if key not in YS:
        YS[key] = True
        out.write(f"y {name} {'reg' if kind == 'mse' else 'clf'} {f64hex(ye)}\n")
    if sample_weight is not None:
        # (repr round-trips every float64 exactly, and Rust's parse is correctly rounded)
        out.write(f"sw {case_id} {' '.join(repr(float(w)) for w in sample_weight)}\n")


def main():
    out = sys.stdout
    out.write("# Generated by engine/skltree/oracle/record_trees.py; do not edit.  Re-recording is a reviewed change.\n")
    out.write("# data NAME N F, then x NAME (N*F float32 bits, row-major); case ID DATA KIND N_CLASSES MAX_DEPTH MIN_SPLIT MIN_LEAF\n")
    out.write("#   MIN_WEIGHT_LEAF MAX_FEATURES MIN_IMPURITY_DECREASE SEED MASK NODE_COUNT MAX_DEPTH_SEEN, then FNV-1a of\n")
    out.write("#   children_left, children_right, feature, threshold, impurity, n_node_samples, weighted_n_node_samples,\n")
    out.write("#   missing_go_to_left, value, the raw importances and apply(X); y NAME clf|reg (the encoded y, float64 bits,\n")
    out.write("#   once a dataset and kind); sw ID (the case's sample weights, exact decimals)\n")
    out.write(f"oracle scikit-learn {sklearn.__version__}, numpy {np.__version__}, CPython {platform.python_version()} {platform.machine()}\n")
    data = datasets()
    for name, (X, Y) in data.items():
        out.write(f"data {name} {X.shape[0]} {X.shape[1]}\nx {name} {f32hex(X)}\n")
    case = 0
    rs = np.random.RandomState(7)

    def weights(n, frac):
        w = rs.randint(0, 4, n).astype(np.float64)
        return w / 4.0 + (rs.randint(0, 2, n) * 0.5 if frac else 0)

    for name in ["clf3", "ties", "nan", "big", "multi"]:
        X, Y = data[name]
        for crit in ["gini", "entropy"]:
            for seed in [0, 1, 42]:
                variants = [
                    dict(),
                    dict(max_depth=3),
                    dict(min_samples_leaf=5, max_features="sqrt"),
                    dict(min_impurity_decrease=0.01),
                    dict(max_features=2),
                    dict(_sw="int"),
                    dict(_sw="frac", min_weight_fraction_leaf=0.05),
                ]
                for v in variants:
                    sw = v.pop("_sw", None)
                    w = None if sw is None else weights(X.shape[0], sw == "frac")
                    est = DecisionTreeClassifier(criterion=crit, random_state=seed, **v)
                    row(case, name, crit, est, X, Y, w, out)
                    case += 1
    # the rough sets: non-dyadic weights (uniform in (0, 2)), so the sums' order shows in their bits
    for name in ["rough"]:
        X, Y = data[name]
        for crit in ["gini", "entropy"]:
            for seed in [0, 1, 42]:
                for v in [dict(), dict(_sw="rand"), dict(_sw="rand", max_features=3)]:
                    sw = v.pop("_sw", None)
                    w = None if sw is None else rs.rand(X.shape[0]) * 2 + 1e-3
                    row(case, name, crit, DecisionTreeClassifier(criterion=crit, random_state=seed, **v), X, Y, w, out)
                    case += 1
    for name in ["regrough"]:
        X, Y = data[name]
        for seed in [0, 1, 42]:
            for v in [dict(), dict(_sw="rand"), dict(max_depth=5, _sw="rand")]:
                sw = v.pop("_sw", None)
                w = None if sw is None else rs.rand(X.shape[0]) * 2 + 1e-3
                row(case, name, "mse", DecisionTreeRegressor(random_state=seed, **v), X, Y, w, out)
                case += 1
    for name in ["reg", "regnan2", "clf3"]:
        X, Y = data[name]
        for seed in [0, 1, 42]:
            for v in [dict(), dict(max_depth=4), dict(min_samples_leaf=3, max_features=0.5), dict(_sw="frac")]:
                sw = v.pop("_sw", None)
                w = None if sw is None else weights(X.shape[0], True)
                est = DecisionTreeRegressor(random_state=seed, **v)
                row(case, name, "mse", est, X, Y, w, out)
                case += 1


main()
