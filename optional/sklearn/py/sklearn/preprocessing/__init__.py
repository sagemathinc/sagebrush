"""Preprocessing (scikit-learn 1.9.1's sklearn.preprocessing): StandardScaler. Other names of sklearn.preprocessing
raise NotImplementedError: they are not in Sagebrush's sklearn 0.x subset."""

from .._sk_missing import missing as _sk_missing
from ._sk_data import StandardScaler


def __getattr__(name):
    return _sk_missing("sklearn.preprocessing", name)
