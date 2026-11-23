# sklearn.utils.multiclass: type_of_target, unique_labels and
# check_classification_targets over the target shapes and kinds.
import warnings

import numpy as np
import pandas as pd
from sklearn.utils.multiclass import check_classification_targets, is_multilabel, type_of_target, unique_labels
from _cases import case, sorted_sets

targets = [
    ("binary-int", [0, 1, 1]),
    ("binary-str", ["a", "b", "a"]),
    ("binary-bool", [True, False]),
    ("binary-float-integral", [1.0, 0.0, 1.0]),
    ("one-class", [3, 3, 3]),
    ("multiclass-int", [0, 1, 2]),
    ("multiclass-str", ["x", "y", "z"]),
    ("multiclass-negative", [-1, 0, 7]),
    ("continuous", [0.5, 1.0, 2.0]),
    ("continuous-negative", [-0.25, 1.0]),
    ("column", [[1], [2], [3]]),
    ("column-binary", [[0], [1]]),
    ("multioutput-multiclass", [[1, 2], [3, 1]]),
    ("multioutput-continuous", [[1.5, 2.0], [3.0, 1.0]]),
    ("multilabel", [[0, 1], [1, 1]]),
    ("multilabel-bool", np.array([[True, False], [False, True]])),
    ("empty", []),
    ("empty-2d", [[]]),
    ("three-d", [[[1]]]),
    ("array-int", np.arange(4)),
    ("array-str", np.array(["p", "q"])),
    ("series-int", pd.Series([1, 2, 1])),
    ("series-str", pd.Series(["u", "v", "w"])),
    ("series-float", pd.Series([0.1, 0.2])),
    ("frame-two", pd.DataFrame({"a": [1, 2], "b": [2, 1]})),
]
for name, y in targets:
    case("type." + name, lambda: type_of_target(y))
case("type.scalar", lambda: type_of_target(5))
case("type.str", lambda: type_of_target("abc"))
case("type.ragged-scalars", lambda: type_of_target([1, [2, 3]]))
case("type.huge-floats", lambda: type_of_target([1e20, 2.0]))
case("type.int64-edge-floats", lambda: type_of_target([-(2.0 ** 63), 2.0 ** 62]))
case("type.half", lambda: type_of_target([1.5, 2.0]))
case("type.nan", lambda: type_of_target([0.5, np.nan]))
case("type.inf-integral", lambda: type_of_target([1.0, np.inf]))
case("type.raise", lambda: type_of_target([[[1]]], raise_unknown=True))
case("type.raise-named", lambda: type_of_target([[]], input_name="y", raise_unknown=True))
case("type.bytes", lambda: type_of_target([b"a", b"b"]))
case("type.legacy", lambda: type_of_target([[1, 2], [3]]))
case("multilabel", lambda: [is_multilabel(y) for _, y in targets[:16]])

case("unique.ints", lambda: unique_labels([3, 1, 2], [5, 1]))
case("unique.strs", lambda: unique_labels(["b", "a"], np.array(["c"])))
case("unique.series", lambda: unique_labels(pd.Series(["b", "a"]), ["a"]))
case("unique.floats", lambda: unique_labels([1.0, 3.0], [2.0]))
case("unique.mixed-types", lambda: unique_labels([1, 2], ["a", "b"]))
case("unique.mixed-kinds", sorted_sets(lambda: unique_labels([1, 2], [0.5, 1.0])))
case("unique.binary-multiclass", lambda: unique_labels([0, 1], [0, 1, 2]))
case("unique.multilabel", lambda: unique_labels([[0, 1], [1, 1]], [[1, 0], [0, 0]]))
case("unique.multilabel-sizes", lambda: unique_labels([[0, 1], [1, 1]], [[1, 0, 1], [0, 0, 1]]))
case("unique.none", lambda: unique_labels())
case("unique.continuous", lambda: unique_labels([0.5, 1.5]))


def checked(y):
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        check_classification_targets(y)
    return [(x.category.__name__, str(x.message)) for x in w]


case("check.binary", lambda: checked([0, 1]))
case("check.continuous", lambda: checked([0.5, 1.5]))
case("check.multioutput-continuous", lambda: checked([[0.5, 1.5], [1.0, 2.0]]))
case("check.many-classes", lambda: checked(list(range(25))))
case("check.many-classes-under-20", lambda: checked(list(range(15))))
case("check.half", lambda: checked(list(range(13)) * 2))
