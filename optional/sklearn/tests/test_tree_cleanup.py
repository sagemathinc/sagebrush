# The decision trees' copy of X, y and the mask in Sagebrush's decision-tree kernel is released after every fit:
# the kernel's live datasets and bytes are what they were before, after fits that succeed and after a fit that
# fails once the copy is made. (Sagebrush's own test: scikit-learn has no such kernel.)
import numpy as np
import _skltree
from sagebrush import skltree
from sklearn.tree import DecisionTreeClassifier, DecisionTreeRegressor
from _cases import case


def live():
    # (the kernel's live datasets and the bytes its datasets, buffers and trees hold)
    _, _, n, nbytes, _, _, _ = _skltree._state()
    return n, nbytes


X = np.array([[0.0, 1.0], [1.0, np.nan], [2.0, 0.5], [3.0, 2.0], [4.0, 1.5], [5.0, 0.0]])
y = np.array([0, 0, 1, 1, 2, 2])
w = np.array([1.0, 0.5, 2.0, 1.0, 1.5, 1.0])
before = live()


def unchanged(fit):
    fit()
    return live() == before


case("fit.classifier", lambda: unchanged(lambda: DecisionTreeClassifier(random_state=0).fit(X, y)))
case("fit.classifier-weights", lambda: unchanged(lambda: DecisionTreeClassifier(class_weight="balanced", random_state=0).fit(X, y, sample_weight=w)))
case("fit.regressor", lambda: unchanged(lambda: DecisionTreeRegressor(random_state=0).fit(X, y * 1.5)))
case("fit.two-outputs", lambda: unchanged(lambda: DecisionTreeClassifier(random_state=0).fit(X, np.column_stack([y, y % 2]))))
case("fit.many", lambda: unchanged(lambda: [DecisionTreeClassifier(random_state=k).fit(X, y) for k in range(20)]))


def failing_fit():
    # (the kernel's fit fails after the dataset was copied in)
    original = skltree.fit

    def fail(*args, **kwargs):
        raise ValueError("injected fit failure after the dataset's copy")

    skltree.fit = fail
    try:
        DecisionTreeClassifier(random_state=0).fit(X, y)
    except ValueError as e:
        return str(e), live() == before
    finally:
        skltree.fit = original
    return "no failure", live() == before


case("fit.failure", failing_fit)
case("fit.after-failure", lambda: unchanged(lambda: DecisionTreeClassifier(random_state=0).fit(X, y)))

# bagging: the members share one copy (or, on their own columns, make their own); every copy is released, also
# when a member's fit fails partway through the ensemble
from sklearn.ensemble import BaggingClassifier, BaggingRegressor

case("bagging.shared", lambda: unchanged(lambda: BaggingClassifier(n_estimators=6, random_state=0).fit(X, y)))
case("bagging.own-columns", lambda: unchanged(lambda: BaggingClassifier(n_estimators=6, max_features=1, random_state=0).fit(X, y)))
case("bagging.regressor-oob", lambda: unchanged(lambda: BaggingRegressor(n_estimators=6, oob_score=True, random_state=0).fit(X, y * 1.5)))


def failing_member(**kw):
    # (the third member's fit fails)
    original = skltree.fit
    calls = []

    def fail_third(*args, **kwargs):
        calls.append(1)
        if len(calls) == 3:
            raise ValueError("injected failure in the third member")
        return original(*args, **kwargs)

    skltree.fit = fail_third
    try:
        BaggingClassifier(n_estimators=6, random_state=0, **kw).fit(X, y)
    except ValueError as e:
        return str(e), len(calls), live() == before
    finally:
        skltree.fit = original
    return "no failure", len(calls), live() == before


case("bagging.failure-shared", failing_member)
case("bagging.failure-own-columns", lambda: failing_member(max_features=1))
