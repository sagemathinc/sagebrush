"""Datasets (scikit-learn 1.9.1's sklearn.datasets): the bundled toy datasets load_wine, load_iris,
load_breast_cancer and load_digits, with return_X_y and as_frame. Their data is the UCI Machine Learning Repository's
(CC BY 4.0, NOTICE.md). Other names of sklearn.datasets raise NotImplementedError: they are not in Sagebrush's
sklearn 0.x subset (load_diabetes among them, until its data's license is settled)."""

import numbers
import base64
import csv
import io
import zlib

import numpy as np

from .._sk_missing import missing as _sk_missing
from ..utils import Bunch

__all__ = ["load_breast_cancer", "load_digits", "load_iris", "load_wine"]

DATA_MODULE = "sklearn.datasets.data"


def _sk_load_csv(text):
    # (sklearn's load_csv_data: a header of n_samples, n_features and the target names, then one row per sample)
    rows = csv.reader(io.StringIO(text))
    temp = next(rows)
    n_samples = int(temp[0])
    n_features = int(temp[1])
    target_names = np.array(temp[2:])
    data = np.empty((n_samples, n_features))
    target = np.empty((n_samples,), dtype=int)
    for i, ir in enumerate(rows):
        data[i] = np.asarray(ir[:-1], dtype=np.float64)
        target[i] = np.asarray(ir[-1], dtype=int)
    return data, target, target_names


def _sk_load_gzip_csv(b64):
    # (sklearn's load_gzip_compressed_csv_data: np.loadtxt of the decompressed text, delimiter ",")
    raw = zlib.decompress(base64.b64decode("".join(b64)), 31)
    return np.loadtxt(io.StringIO(raw.decode("utf-8")), delimiter=",")


def _sk_frame(caller_name, data, target, feature_names, target_columns):
    # (sklearn's _convert_data_dataframe: one DataFrame of the features then the target; X its feature columns, y its
    # target column as a Series)
    import pandas as pd

    columns = {}
    for j, name in enumerate(feature_names):
        columns[str(name)] = data[:, j]
    columns[target_columns[0]] = target
    combined_df = pd.DataFrame(columns)
    X = combined_df[[str(n) for n in feature_names]]
    y = combined_df[target_columns[0]]
    return combined_df, X, y


def load_wine(*, return_X_y=False, as_frame=False):
    """Load and return the wine dataset (classification)."""
    from . import _sk_data_wine as d

    data, target, target_names = _sk_load_csv("".join(d.CSV))
    fdescr = d.DESCR
    feature_names = [
        "alcohol",
        "malic_acid",
        "ash",
        "alcalinity_of_ash",
        "magnesium",
        "total_phenols",
        "flavanoids",
        "nonflavanoid_phenols",
        "proanthocyanins",
        "color_intensity",
        "hue",
        "od280/od315_of_diluted_wines",
        "proline",
    ]
    frame = None
    target_columns = ["target"]
    if as_frame:
        frame, data, target = _sk_frame("load_wine", data, target, feature_names, target_columns)
    if return_X_y:
        return data, target
    return Bunch(data=data, target=target, frame=frame, target_names=target_names, DESCR=fdescr, feature_names=feature_names)


def load_iris(*, return_X_y=False, as_frame=False):
    """Load and return the iris dataset (classification)."""
    from . import _sk_data_iris as d

    data_file_name = "iris.csv"
    data, target, target_names = _sk_load_csv("".join(d.CSV))
    fdescr = d.DESCR
    feature_names = ["sepal length (cm)", "sepal width (cm)", "petal length (cm)", "petal width (cm)"]
    frame = None
    target_columns = ["target"]
    if as_frame:
        frame, data, target = _sk_frame("load_iris", data, target, feature_names, target_columns)
    if return_X_y:
        return data, target
    return Bunch(data=data, target=target, frame=frame, target_names=target_names, DESCR=fdescr, feature_names=feature_names,
                 filename=data_file_name, data_module=DATA_MODULE)


def load_breast_cancer(*, return_X_y=False, as_frame=False):
    """Load and return the breast cancer Wisconsin dataset (classification)."""
    from . import _sk_data_breast_cancer as d

    data_file_name = "breast_cancer.csv"
    data, target, target_names = _sk_load_csv("".join(d.CSV))
    fdescr = d.DESCR
    feature_names = np.array(
        [
            "mean radius", "mean texture", "mean perimeter", "mean area", "mean smoothness", "mean compactness",
            "mean concavity", "mean concave points", "mean symmetry", "mean fractal dimension", "radius error",
            "texture error", "perimeter error", "area error", "smoothness error", "compactness error", "concavity error",
            "concave points error", "symmetry error", "fractal dimension error", "worst radius", "worst texture",
            "worst perimeter", "worst area", "worst smoothness", "worst compactness", "worst concavity",
            "worst concave points", "worst symmetry", "worst fractal dimension",
        ]
    )
    frame = None
    target_columns = ["target"]
    if as_frame:
        frame, data, target = _sk_frame("load_breast_cancer", data, target, feature_names, target_columns)
    if return_X_y:
        return data, target
    return Bunch(data=data, target=target, frame=frame, target_names=target_names, DESCR=fdescr, feature_names=feature_names,
                 filename=data_file_name, data_module=DATA_MODULE)


def load_digits(*, n_class=10, return_X_y=False, as_frame=False):
    """Load and return the digits dataset (classification)."""
    # (validate_params' Interval(Integral, 1, 10, closed="both"), before anything is loaded)
    if not (isinstance(n_class, numbers.Integral) and 1 <= n_class <= 10):
        from ..utils._sk_param import InvalidParameterError
        raise InvalidParameterError(f"The 'n_class' parameter of load_digits must be an int in the range [1, 10]. Got {n_class!r} instead.")
    from . import _sk_data_digits as d

    data = _sk_load_gzip_csv(d.GZIP_BASE64)
    fdescr = d.DESCR
    target = data[:, -1].astype(int, copy=False)
    flat_data = data[:, :-1]
    images = flat_data.reshape(-1, 8, 8)
    if n_class < 10:
        idx = target < n_class
        flat_data, target = flat_data[idx], target[idx]
        images = images[idx]
    feature_names = ["pixel_{}_{}".format(row_idx, col_idx) for row_idx in range(8) for col_idx in range(8)]
    frame = None
    target_columns = ["target"]
    if as_frame:
        frame, flat_data, target = _sk_frame("load_digits", flat_data, target, feature_names, target_columns)
    if return_X_y:
        return flat_data, target
    return Bunch(data=flat_data, target=target, frame=frame, feature_names=feature_names, target_names=np.arange(10),
                 images=images, DESCR=fdescr)


def __getattr__(name):
    return _sk_missing("sklearn.datasets", name)
