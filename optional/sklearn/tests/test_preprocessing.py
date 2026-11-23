# StandardScaler: the fitted statistics and transforms to the bit, with
# weights, NaNs, constant columns, partial_fit, float32 and frames.
import numpy as np
import pandas as pd
from sklearn.datasets import load_wine
from sklearn.preprocessing import StandardScaler
from _cases import case, digest, sorted_sets


def hx(a):
    a = np.asarray(a)
    return (str(a.dtype), a.shape, [float(x).hex() for x in a.ravel().tolist()][:8])


def stats(s):
    return {"mean_": None if s.mean_ is None else hx(s.mean_), "var_": None if s.var_ is None else hx(s.var_),
            "scale_": None if s.scale_ is None else hx(s.scale_), "n_samples_seen_": repr(s.n_samples_seen_),
            "n_features_in_": s.n_features_in_}


X, y = load_wine(return_X_y=True)
A = np.array([[1.0, -2.0, 3.0], [4.0, 5.0, 3.0], [7.0, 0.5, 3.0], [-1.5, 2.0, 3.0]])
w = np.array([0.5, 2.0, 1.0, 3.0])

case("fit", lambda: stats(StandardScaler().fit(A)))
case("transform", lambda: hx(StandardScaler().fit(A).transform(A)))
case("fit_transform", lambda: hx(StandardScaler().fit_transform(A)))
case("wine", lambda: (stats(StandardScaler().fit(X)), digest(StandardScaler().fit_transform(X))))
case("wine-inverse", lambda: digest(StandardScaler().fit(X).inverse_transform(StandardScaler().fit_transform(X))))
case("weighted", lambda: stats(StandardScaler().fit(A, sample_weight=w)))
case("weighted-transform", lambda: hx(StandardScaler().fit(A, sample_weight=w).transform(A)))
case("no-mean", lambda: (stats(StandardScaler(with_mean=False).fit(A)), hx(StandardScaler(with_mean=False).fit_transform(A))))
case("no-std", lambda: (stats(StandardScaler(with_std=False).fit(A)), hx(StandardScaler(with_std=False).fit_transform(A))))
case("neither", lambda: (stats(StandardScaler(with_mean=False, with_std=False).fit(A)), hx(StandardScaler(with_mean=False, with_std=False).fit_transform(A))))
case("constant-column", lambda: hx(StandardScaler().fit(A).scale_))
case("near-constant", lambda: stats(StandardScaler().fit(np.array([[1.0], [1.0 + 1e-15], [1.0]]))))
N = A.copy()
N[1, 0] = np.nan
N[2, 1] = np.nan
case("nan", lambda: stats(StandardScaler().fit(N)))
case("nan-transform", lambda: hx(StandardScaler().fit(N).transform(N)))
case("nan-weighted", lambda: stats(StandardScaler().fit(N, sample_weight=w)))


def partial():
    s = StandardScaler()
    s.partial_fit(A[:2])
    s.partial_fit(A[2:])
    return stats(s)


def partial_nan():
    s = StandardScaler()
    s.partial_fit(N[:2])
    s.partial_fit(N[2:])
    s.partial_fit(A)
    return stats(s)


def partial_weighted():
    s = StandardScaler()
    s.partial_fit(A[:3], sample_weight=w[:3])
    s.partial_fit(A[3:], sample_weight=w[3:])
    return stats(s)


case("partial", partial)
case("partial-nan", partial_nan)
case("partial-weighted", partial_weighted)
case("partial-wine", lambda: (lambda s: (s.partial_fit(X[:100]), s.partial_fit(X[100:]), stats(s))[2])(StandardScaler()))
F = A.astype(np.float32)
case("float32", lambda: (stats(StandardScaler().fit(F)), hx(StandardScaler().fit_transform(F))))
case("ints", lambda: hx(StandardScaler().fit_transform([[1, 2], [3, 5], [4, 4]])))
case("copy-false", lambda: (lambda B: (StandardScaler(copy=False).fit_transform(B) is B, hx(B)))(A.copy()))
case("copy-default", lambda: (lambda B: (StandardScaler().fit_transform(B) is B, hx(B)))(A.copy()))
case("transform-copy-false", lambda: (lambda B: (StandardScaler().fit(A).transform(B, copy=False) is B))(A.copy()))
df = pd.DataFrame({"a": [1.0, 2.0, 4.0], "b": [3.0, 1.0, 2.0]})
case("frame", lambda: hx(StandardScaler().fit_transform(df)))
case("frame-names", lambda: StandardScaler().fit(df).feature_names_in_.tolist())
case("names-out", lambda: StandardScaler().fit(df).get_feature_names_out().tolist())
case("names-out-generated", lambda: StandardScaler().fit(A).get_feature_names_out().tolist())
case("names-out-given", lambda: StandardScaler().fit(A).get_feature_names_out(["p", "q", "r"]).tolist())
case("names-out-wrong", lambda: StandardScaler().fit(df).get_feature_names_out(["x", "y"]))
case("names-out-length", lambda: StandardScaler().fit(A).get_feature_names_out(["p"]))
case("names-out-unfitted", lambda: StandardScaler().get_feature_names_out())
case("transform-wrong-features", lambda: StandardScaler().fit(A).transform(A[:, :2]))
case("transform-unfitted", lambda: StandardScaler().transform(A))
case("one-sample", lambda: stats(StandardScaler().fit(A[:1])))
case("1d", lambda: StandardScaler().fit(np.arange(3.0)))
case("inf", lambda: StandardScaler().fit([[np.inf, 1.0]]))
case("repr", lambda: repr(StandardScaler(with_mean=False)))
case("set_output-default", lambda: repr(StandardScaler().set_output(transform="default")))
case("param.copy", sorted_sets(lambda: StandardScaler(copy="yes").fit(A)))
case("param.with_mean", sorted_sets(lambda: StandardScaler(with_mean=1).fit(A)))
