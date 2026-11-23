"""Tools for model selection (scikit-learn 1.9.1's sklearn.model_selection): the splitters KFold, StratifiedKFold,
ShuffleSplit, StratifiedShuffleSplit and LeaveOneOut, check_cv and train_test_split. Other names of
sklearn.model_selection raise NotImplementedError: they are not in Sagebrush's sklearn 0.x subset."""

from .._sk_missing import missing as _sk_missing
from ._sk_split import (
    BaseCrossValidator,
    BaseShuffleSplit,
    KFold,
    LeaveOneOut,
    ShuffleSplit,
    StratifiedKFold,
    StratifiedShuffleSplit,
    check_cv,
    train_test_split,
)


def __getattr__(name):
    return _sk_missing("sklearn.model_selection", name)
