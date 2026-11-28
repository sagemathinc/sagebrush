# The bundled datasets: keys, shapes, dtypes, names, the exact values (as a
# digest of the bytes) and the as_frame and return_X_y forms.
from sklearn.datasets import load_wine, load_iris, load_breast_cancer, load_digits
from _cases import case, digest

for load in (load_wine, load_iris, load_breast_cancer, load_digits):
    name = load.__name__
    b = load()
    case(name + ".keys", lambda: sorted(b.keys()))
    case(name + ".data", lambda: digest(b.data))
    case(name + ".target", lambda: digest(b.target))
    case(name + ".target_names", lambda: b.target_names)
    case(name + ".feature_names", lambda: list(b.feature_names))
    case(name + ".descr", lambda: (len(b.DESCR), b.DESCR.splitlines()[:3]))
    case(name + ".attr", lambda: b.data is b["data"])
    case(name + ".xy", lambda: [digest(a) for a in load(return_X_y=True)])
    f = load(as_frame=True)
    case(name + ".frame", lambda: (type(f.frame).__name__, f.frame.shape, list(f.frame.columns[-3:])))
    case(name + ".frame-dtypes", lambda: sorted(set(str(t) for t in f.frame.dtypes)))
    case(name + ".frame-data", lambda: (type(f.data).__name__, f.data.shape, digest(f.data.to_numpy())))
    case(name + ".frame-target", lambda: (type(f.target).__name__, f.target.name, str(f.target.dtype), digest(f.target.to_numpy())))
    case(name + ".frame-head", lambda: f.frame.iloc[:3, :3])
    case(name + ".frame-xy", lambda: [type(a).__name__ for a in load(return_X_y=True, as_frame=True)])

case("digits.images", lambda: digest(load_digits().images))
case("digits.n_class", lambda: [digest(a) for a in load_digits(n_class=3, return_X_y=True)])
case("digits.n_class-frame", lambda: load_digits(n_class=2, as_frame=True).frame.shape)
case("iris.filename", lambda: (load_iris().filename, load_iris().data_module))
# n_class checked as validate_params checks it: an int in [1, 10] (a bool counts), before anything is loaded
import numpy as np
for n in (0, -1, 1, 2, 10, 11, 2.5, True, np.int64(3), "3"):
    case(f"digits-n_class-check {n!r}", lambda: (lambda b: (b.data.shape, sorted(set(b.target.tolist()))))(load_digits(n_class=n)))
