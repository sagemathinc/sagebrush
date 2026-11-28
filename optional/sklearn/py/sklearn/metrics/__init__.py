"""Score functions and performance metrics (scikit-learn 1.9.1's sklearn.metrics): the regression metrics
mean_absolute_error, mean_squared_error, root_mean_squared_error and r2_score, and the classification metrics
accuracy_score, confusion_matrix, multilabel_confusion_matrix, precision_recall_fscore_support, precision_score,
recall_score, f1_score, fbeta_score and classification_report. Other names of sklearn.metrics raise
NotImplementedError: they are not in Sagebrush's sklearn 0.x subset."""

from .._sk_missing import missing as _sk_missing
from ._sk_classification import (
    accuracy_score,
    classification_report,
    confusion_matrix,
    f1_score,
    fbeta_score,
    multilabel_confusion_matrix,
    precision_recall_fscore_support,
    precision_score,
    recall_score,
)
from ._sk_regression import mean_absolute_error, mean_squared_error, r2_score, root_mean_squared_error


def __getattr__(name):
    return _sk_missing("sklearn.metrics", name)
