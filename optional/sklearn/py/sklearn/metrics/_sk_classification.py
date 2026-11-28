"""Classification metrics, from scikit-learn 1.9.1's sklearn/metrics/_classification.py: accuracy_score,
confusion_matrix, multilabel_confusion_matrix, precision_recall_fscore_support, precision_score, recall_score,
f1_score, fbeta_score and classification_report, for binary and multiclass targets. Multilabel indicator targets are
not supported yet."""

import numbers
import warnings

import numpy as np

from ..exceptions import UndefinedMetricWarning
from ..utils._sk_param import (ARRAY_LIKE, BOOLEAN, NAN, NONE, SPARSE, instance_of, real_interval, real_options,
                               str_options, validate)
from ..utils.multiclass import _sk_label_values, type_of_target, unique_labels
from ..utils.validation import _check_sample_weight, _num_samples, check_array, check_consistent_length, column_or_1d
from ._sk_regression import _sk_average, _sk_floating_dtype

_SK_Y = [ARRAY_LIKE, SPARSE]
_SK_AVERAGE = [str_options({"micro", "macro", "samples", "weighted", "binary"}), NONE]
_SK_ZERO_DIVISION = [real_options({0.0, 1.0}), NAN, str_options({"warn"})]
_SK_POS_LABEL = [instance_of(numbers.Real, str), BOOLEAN, NONE]


def _sk_validate_targets(func, y_true, y_pred, sample_weight, y=None):
    validate(func, "y_true", y_true, y if y is not None else _SK_Y)
    validate(func, "y_pred", y_pred, y if y is not None else _SK_Y)
    validate(func, "sample_weight", sample_weight, [ARRAY_LIKE, NONE])


def _check_zero_division(zero_division):
    if isinstance(zero_division, str) and zero_division == "warn":
        return np.float64(0.0)
    elif isinstance(zero_division, (int, float)) and zero_division in [0, 1]:
        return np.float64(zero_division)
    else:
        return np.nan


def _check_targets(y_true, y_pred, sample_weight=None):
    """Check that y_true and y_pred belong to the same classification task."""
    y_true = _sk_label_values(y_true)
    y_pred = _sk_label_values(y_pred)
    check_consistent_length(y_true, y_pred, sample_weight)
    type_true = type_of_target(y_true, input_name="y_true")
    type_pred = type_of_target(y_pred, input_name="y_pred")
    for array in [y_true, y_pred]:
        if _num_samples(array) < 1:
            raise ValueError(
                "Found empty input array (e.g., `y_true` or `y_pred`) while a minimum "
                "of 1 sample is required."
            )
    if sample_weight is not None:
        sample_weight = _check_sample_weight(sample_weight, y_true, force_float_dtype=False)

    y_type = {type_true, type_pred}
    if y_type == {"binary", "multiclass"}:
        y_type = {"multiclass"}

    if len(y_type) > 1:
        raise ValueError(
            "Classification metrics can't handle a mix of {0} and {1} targets".format(type_true, type_pred)
        )

    y_type = y_type.pop()

    if y_type not in ["binary", "multiclass", "multilabel-indicator"]:
        raise ValueError("{0} is not supported".format(y_type))

    if y_type == "multilabel-indicator":
        # (multilabel indicator targets: not supported yet)
        raise NotImplementedError(
            "sklearn.metrics with multilabel-indicator targets is not in Sagebrush's sklearn 0.x subset")

    y_true = column_or_1d(y_true, input_name="y_true")
    y_pred = column_or_1d(y_pred, input_name="y_pred")

    unique_labels_ = unique_labels(y_true, y_pred, ys_types={y_type})
    if y_type == "binary":
        if unique_labels_.shape[0] > 2:
            y_type = "multiclass"

    return y_type, unique_labels_, y_true, y_pred, sample_weight


def accuracy_score(y_true, y_pred, *, normalize=True, sample_weight=None):
    """Accuracy classification score."""
    _sk_validate_targets("accuracy_score", y_true, y_pred, sample_weight)
    validate("accuracy_score", "normalize", normalize, [BOOLEAN])
    y_type, _, y_true, y_pred, sample_weight = _check_targets(y_true, y_pred, sample_weight)

    score = y_true == y_pred

    # (sklearn.utils._array_api._average with normalize)
    if normalize:
        return float(_sk_average(score, weights=sample_weight))
    if sample_weight is not None:
        return float(np.dot(score, sample_weight))
    return float(np.sum(score.astype(_sk_floating_dtype(score, sample_weight))))


def confusion_matrix(y_true, y_pred, *, labels=None, sample_weight=None, normalize=None):
    """Compute confusion matrix to evaluate the accuracy of a classification."""
    _sk_validate_targets("confusion_matrix", y_true, y_pred, sample_weight, y=[ARRAY_LIKE])
    validate("confusion_matrix", "labels", labels, [ARRAY_LIKE, NONE])
    validate("confusion_matrix", "normalize", normalize, [str_options({"true", "pred", "all"}), NONE])
    y_true = check_array(_sk_label_values(y_true), dtype=None, ensure_2d=False, ensure_all_finite=False,
                         ensure_min_samples=0)
    y_pred = check_array(_sk_label_values(y_pred), dtype=None, ensure_2d=False, ensure_all_finite=False,
                         ensure_min_samples=0)
    if sample_weight is None:
        sample_weight = np.ones(y_true.shape[0], dtype=np.int64)
    else:
        sample_weight = np.asarray(sample_weight)

    if len(sample_weight) > 0:
        y_type, unique_labels_, y_true, y_pred, sample_weight = _check_targets(y_true, y_pred, sample_weight)
    else:
        y_type, unique_labels_, y_true, y_pred, _ = _check_targets(y_true, y_pred)

    if y_type not in ("binary", "multiclass"):
        raise ValueError("%s is not supported" % y_type)

    if labels is None:
        labels = unique_labels_
    else:
        labels = np.asarray(_sk_label_values(labels))
        n_labels = labels.size
        if n_labels == 0:
            raise ValueError("'labels' should contain at least one label.")
        elif y_true.size == 0:
            return np.zeros((n_labels, n_labels), dtype=int)
        elif not np.any(np.isin(y_true, labels)):  # (no label in common: np.intersect1d is empty)
            raise ValueError("At least one label specified must be in y_true")

    n_labels = labels.size
    need_index_conversion = not (
        labels.dtype.kind in {"i", "u", "b"}
        and np.all(labels == np.arange(n_labels))
        and y_true.min() >= 0
        and y_pred.min() >= 0
    )
    if need_index_conversion:
        label_to_ind = {label: index for index, label in enumerate(labels.tolist())}
        y_pred = np.array([label_to_ind.get(label, n_labels + 1) for label in y_pred.tolist()], dtype=np.int64)
        y_true = np.array([label_to_ind.get(label, n_labels + 1) for label in y_true.tolist()], dtype=np.int64)

    ind = np.logical_and(y_pred < n_labels, y_true < n_labels)
    if not np.all(ind):
        y_pred = y_pred[ind]
        y_true = y_true[ind]
        sample_weight = sample_weight[ind]

    if sample_weight.dtype.kind in {"i", "u", "b"}:
        dtype = np.int64
    else:
        dtype = np.float64

    # (scipy's coo_array((w, (i, j))).toarray(): each entry added in order, duplicates summed; integer weights in
    # an int64 accumulator, as scikit-learn's, never through float64, so a cell is exact (or, past what Sagebrush's
    # int64 holds, refused), float weights by bincount)
    flat_index = y_true.astype(np.int64) * n_labels + y_pred.astype(np.int64)
    if dtype == np.int64 and bool(np.all(sample_weight == 1)):
        flat = np.bincount(flat_index, minlength=n_labels * n_labels)
    elif dtype == np.int64:
        # (each cell's integer sum: the weights grouped by cell (a stable sort, in their order within it) and each
        # group summed in int64 on its own, so no cell's sum depends on another's)
        order = np.argsort(flat_index, kind="stable")
        ws = sample_weight.astype(np.int64)[order]
        bounds = np.searchsorted(flat_index[order], np.arange(n_labels * n_labels + 1), side="left").tolist()
        flat = np.array([ws[bounds[k]:bounds[k + 1]].sum() for k in range(n_labels * n_labels)], dtype=np.int64)
    else:
        flat = np.bincount(flat_index, weights=sample_weight.astype(np.float64), minlength=n_labels * n_labels)
    cm = flat.astype(dtype).reshape(n_labels, n_labels)

    with np.errstate(all="ignore"):
        if normalize == "true":
            cm = cm / cm.sum(axis=1, keepdims=True)
        elif normalize == "pred":
            cm = cm / cm.sum(axis=0, keepdims=True)
        elif normalize == "all":
            cm = cm / cm.sum()
        cm = np.nan_to_num(cm)

    if cm.shape == (1, 1):
        warnings.warn(
            (
                "A single label was found in 'y_true' and 'y_pred'. For the confusion "
                "matrix to have the correct shape, use the 'labels' parameter to pass "
                "all known labels."
            ),
            UserWarning,
        )

    return cm


def multilabel_confusion_matrix(y_true, y_pred, *, sample_weight=None, labels=None, samplewise=False):
    """Compute a confusion matrix for each class or sample."""
    _sk_validate_targets("multilabel_confusion_matrix", y_true, y_pred, sample_weight)
    validate("multilabel_confusion_matrix", "labels", labels, [ARRAY_LIKE, NONE])
    validate("multilabel_confusion_matrix", "samplewise", samplewise, [BOOLEAN])
    y_type, present_labels, y_true, y_pred, sample_weight = _check_targets(y_true, y_pred, sample_weight)

    if y_type not in ("binary", "multiclass", "multilabel-indicator"):
        raise ValueError("%s is not supported" % y_type)

    if labels is None:
        labels = present_labels
        n_labels = None
    else:
        labels = np.asarray(_sk_label_values(labels))
        n_labels = labels.shape[0]
        labels = np.concatenate([labels, np.setdiff1d(present_labels, labels, assume_unique=True)], axis=-1)

    if samplewise:
        raise ValueError("Samplewise metrics are not available outside of multilabel classification.")

    # (LabelEncoder().fit(labels).transform(y): the index of each value among the sorted labels)
    sorted_labels = np.unique(labels)
    y_true = np.searchsorted(sorted_labels, y_true)
    y_pred = np.searchsorted(sorted_labels, y_pred)

    tp = y_true == y_pred
    tp_bins = y_true[tp]
    if sample_weight is not None:
        tp_bins_weights = sample_weight[tp]
    else:
        tp_bins_weights = None

    if tp_bins.shape[0]:
        tp_sum = np.bincount(tp_bins, weights=tp_bins_weights, minlength=labels.shape[0])
    else:
        true_sum = pred_sum = tp_sum = np.zeros(labels.shape[0])
    if y_pred.shape[0]:
        pred_sum = np.bincount(y_pred, weights=sample_weight, minlength=labels.shape[0])
    if y_true.shape[0]:
        true_sum = np.bincount(y_true, weights=sample_weight, minlength=labels.shape[0])

    indices = np.searchsorted(sorted_labels, labels[:n_labels])
    tp_sum = np.take(tp_sum, indices, axis=0)
    true_sum = np.take(true_sum, indices, axis=0)
    pred_sum = np.take(pred_sum, indices, axis=0)

    fp = pred_sum - tp_sum
    fn = true_sum - tp_sum
    tp = tp_sum

    if sample_weight is not None:
        tn = np.sum(sample_weight) - tp - fp - fn
    else:
        tn = y_true.shape[0] - tp - fp - fn

    return np.reshape(np.stack([tn, fp, fn, tp]).T, (-1, 2, 2))


def _prf_divide(numerator, denominator, metric, modifier, average, warn_for, zero_division="warn"):
    dtype_float = _sk_floating_dtype(numerator, denominator)
    mask = denominator == 0
    denominator = np.array(denominator, copy=True, dtype=dtype_float)
    denominator[mask] = 1
    result = np.asarray(numerator, dtype=dtype_float) / denominator

    if not np.any(mask):
        return result

    zero_division_value = _check_zero_division(zero_division)
    result[mask] = zero_division_value

    if zero_division != "warn" or metric not in warn_for:
        return result

    if metric in warn_for:
        _warn_prf(average, modifier, f"{metric.capitalize()} is", result.shape[0])

    return result


def _warn_prf(average, modifier, msg_start, result_size):
    axis0, axis1 = "sample", "label"
    if average == "samples":
        axis0, axis1 = axis1, axis0
    msg = (
        "{0} ill-defined and being set to 0.0 {{0}} "
        "no {1} {2}s. Use `zero_division` parameter to control"
        " this behavior.".format(msg_start, modifier, axis0)
    )
    if result_size == 1:
        msg = msg.format("due to")
    else:
        msg = msg.format("in {0}s with".format(axis1))
    warnings.warn(msg, UndefinedMetricWarning, stacklevel=2)


def _sk_label_in(label, labels):
    # (`label in labels` over a NumPy array: whether any element equals it; a string never equals a number)
    for v in labels.tolist():
        if isinstance(v, str) == isinstance(label, str) and v == label:
            return True
    return False


def _check_set_wise_labels(y_true, y_pred, average, labels, pos_label):
    average_options = (None, "micro", "macro", "weighted", "samples")
    if average not in average_options and average != "binary":
        raise ValueError("average has to be one of " + str(average_options))

    y_type, present_labels, y_true, y_pred, _ = _check_targets(y_true, y_pred)
    if average == "binary":
        if y_type == "binary":
            if not _sk_label_in(pos_label, present_labels):
                if len(present_labels) >= 2:
                    raise ValueError(
                        f"pos_label={pos_label} is not a valid label. It "
                        f"should be one of {present_labels}"
                    )
            labels = [pos_label]
        else:
            average_options = list(average_options)
            if y_type == "multiclass":
                average_options.remove("samples")
            raise ValueError(
                "Target is %s but average='binary'. Please "
                "choose another average setting, one of %r." % (y_type, average_options)
            )
    elif pos_label not in (None, 1):
        warnings.warn(
            "Note that pos_label (set to %r) is ignored when "
            "average != 'binary' (got %r). You may use "
            "labels=[pos_label] to specify a single positive class." % (pos_label, average),
            UserWarning,
        )
    return labels


def _sk_nanaverage(a, weights=None):
    # (sklearn.utils.extmath._nanaverage)
    if a.shape[0] == 0:
        return np.nan

    mask = np.isnan(a)
    if np.all(mask):
        return np.nan

    if weights is None:
        return np.asarray(np.nanmean(a))

    weights = np.asarray(weights)
    a, weights = a[~mask], weights[~mask]
    try:
        return _sk_average(a, weights=weights)
    except ZeroDivisionError:
        return _sk_average(a)


def _sk_validate_prf(func, y_true, y_pred, labels, pos_label, average, sample_weight, zero_division):
    _sk_validate_targets(func, y_true, y_pred, sample_weight)
    validate(func, "labels", labels, [ARRAY_LIKE, NONE])
    validate(func, "pos_label", pos_label, _SK_POS_LABEL)
    validate(func, "average", average, _SK_AVERAGE)
    validate(func, "zero_division", zero_division, _SK_ZERO_DIVISION)


def _sk_prfs(y_true, y_pred, *, beta=1.0, labels=None, pos_label=1, average=None,
             warn_for=("precision", "recall", "f-score"), sample_weight=None, zero_division="warn"):
    _check_zero_division(zero_division)
    labels = _check_set_wise_labels(y_true, y_pred, average, labels, pos_label)

    MCM = multilabel_confusion_matrix(y_true, y_pred, sample_weight=sample_weight, labels=labels,
                                      samplewise=average == "samples")
    tp_sum = MCM[:, 1, 1]
    pred_sum = tp_sum + MCM[:, 0, 1]
    true_sum = tp_sum + MCM[:, 1, 0]

    if average == "micro":
        tp_sum = np.reshape(np.sum(tp_sum), (1,))
        pred_sum = np.reshape(np.sum(pred_sum), (1,))
        true_sum = np.reshape(np.sum(true_sum), (1,))

    beta2 = beta**2

    precision = _prf_divide(tp_sum, pred_sum, "precision", "predicted", average, warn_for, zero_division)
    recall = _prf_divide(tp_sum, true_sum, "recall", "true", average, warn_for, zero_division)

    if np.isposinf(beta):
        f_score = recall
    elif beta == 0:
        f_score = precision
    else:
        denom = beta2 * true_sum.astype(np.float64) + pred_sum.astype(np.float64)
        f_score = _prf_divide(
            (1 + beta2) * tp_sum.astype(np.float64),
            denom,
            "f-score",
            "true nor predicted",
            average,
            warn_for,
            zero_division,
        )

    if average == "weighted":
        weights = true_sum
    elif average == "samples":
        weights = sample_weight
    else:
        weights = None

    if average is not None:
        precision = float(_sk_nanaverage(precision, weights=weights))
        recall = float(_sk_nanaverage(recall, weights=weights))
        f_score = float(_sk_nanaverage(f_score, weights=weights))
        true_sum = None

    return precision, recall, f_score, true_sum


def precision_recall_fscore_support(y_true, y_pred, *, beta=1.0, labels=None, pos_label=1, average=None,
                                    warn_for=("precision", "recall", "f-score"), sample_weight=None,
                                    zero_division="warn"):
    """Compute precision, recall, F-measure and support for each class."""
    func = "precision_recall_fscore_support"
    _sk_validate_targets(func, y_true, y_pred, sample_weight)
    validate(func, "beta", beta, [real_interval(0.0, None, "both")])
    validate(func, "labels", labels, [ARRAY_LIKE, NONE])
    validate(func, "pos_label", pos_label, _SK_POS_LABEL)
    validate(func, "average", average, _SK_AVERAGE)
    validate(func, "warn_for", warn_for, [instance_of(list, tuple, set)])
    validate(func, "zero_division", zero_division, _SK_ZERO_DIVISION)
    return _sk_prfs(y_true, y_pred, beta=beta, labels=labels, pos_label=pos_label, average=average,
                    warn_for=warn_for, sample_weight=sample_weight, zero_division=zero_division)


def precision_score(y_true, y_pred, *, labels=None, pos_label=1, average="binary", sample_weight=None,
                    zero_division="warn"):
    """Compute the precision."""
    _sk_validate_prf("precision_score", y_true, y_pred, labels, pos_label, average, sample_weight, zero_division)
    p, _, _, _ = _sk_prfs(y_true, y_pred, labels=labels, pos_label=pos_label, average=average,
                          warn_for=("precision",), sample_weight=sample_weight, zero_division=zero_division)
    return p


def recall_score(y_true, y_pred, *, labels=None, pos_label=1, average="binary", sample_weight=None,
                 zero_division="warn"):
    """Compute the recall."""
    _sk_validate_prf("recall_score", y_true, y_pred, labels, pos_label, average, sample_weight, zero_division)
    _, r, _, _ = _sk_prfs(y_true, y_pred, labels=labels, pos_label=pos_label, average=average,
                          warn_for=("recall",), sample_weight=sample_weight, zero_division=zero_division)
    return r


def fbeta_score(y_true, y_pred, *, beta, labels=None, pos_label=1, average="binary", sample_weight=None,
                zero_division="warn"):
    """Compute the F-beta score."""
    _sk_validate_prf("fbeta_score", y_true, y_pred, labels, pos_label, average, sample_weight, zero_division)
    validate("fbeta_score", "beta", beta, [real_interval(0.0, None, "both")])
    _, _, f, _ = _sk_prfs(y_true, y_pred, beta=beta, labels=labels, pos_label=pos_label, average=average,
                          warn_for=("f-score",), sample_weight=sample_weight, zero_division=zero_division)
    return f


def f1_score(y_true, y_pred, *, labels=None, pos_label=1, average="binary", sample_weight=None,
             zero_division="warn"):
    """Compute the F1 score, also known as balanced F-score or F-measure."""
    _sk_validate_prf("f1_score", y_true, y_pred, labels, pos_label, average, sample_weight, zero_division)
    _, _, f, _ = _sk_prfs(y_true, y_pred, beta=1, labels=labels, pos_label=pos_label, average=average,
                          warn_for=("f-score",), sample_weight=sample_weight, zero_division=zero_division)
    return f


def classification_report(y_true, y_pred, *, labels=None, target_names=None, sample_weight=None, digits=2,
                          output_dict=False, zero_division="warn"):
    """Build a text report showing the main classification metrics."""
    func = "classification_report"
    _sk_validate_targets(func, y_true, y_pred, sample_weight)
    validate(func, "labels", labels, [ARRAY_LIKE, NONE])
    validate(func, "target_names", target_names, [ARRAY_LIKE, NONE])
    validate(func, "digits", digits,
             [(lambda v: isinstance(v, numbers.Integral) and v >= 0, "an int in the range [0, inf)")])
    validate(func, "output_dict", output_dict, [BOOLEAN])
    validate(func, "zero_division", zero_division, _SK_ZERO_DIVISION)

    y_type, unique_labels_, y_true, y_pred, sample_weight = _check_targets(y_true, y_pred, sample_weight)

    if labels is None:
        labels = unique_labels_
        labels_given = False
    else:
        labels = np.asarray(_sk_label_values(labels))
        labels_given = True

    micro_is_accuracy = (y_type == "multiclass" or y_type == "binary") and (
        not labels_given or (set(labels.tolist()) >= set(unique_labels(y_true, y_pred).tolist()))
    )

    if target_names is not None and len(labels) != len(target_names):
        if labels_given:
            warnings.warn(
                "labels size, {0}, does not match size of target_names, {1}".format(len(labels), len(target_names))
            )
        else:
            raise ValueError(
                "Number of classes, {0}, does not match size of "
                "target_names, {1}. Try specifying the labels "
                "parameter".format(len(labels), len(target_names))
            )
    if target_names is None:
        target_names = ["%s" % l for l in labels.tolist()]

    headers = ["precision", "recall", "f1-score", "support"]
    p, r, f1, s = _sk_prfs(y_true, y_pred, labels=labels, average=None, sample_weight=sample_weight,
                           zero_division=zero_division)
    rows = zip(target_names, p.tolist(), r.tolist(), f1.tolist(), s.tolist())

    average_options = ("micro", "macro", "weighted")

    if output_dict:
        report_dict = {label[0]: label[1:] for label in rows}
        for label, scores in report_dict.items():
            report_dict[label] = dict(zip(headers, [float(i) for i in scores]))
    else:
        longest_last_line_heading = "weighted avg"
        name_width = max(len(cn) for cn in target_names)
        width = max(name_width, len(longest_last_line_heading), digits)
        head_fmt = "{:>{width}s} " + " {:>9}" * len(headers)
        report = head_fmt.format("", *headers, width=width)
        report += "\n\n"
        row_fmt = "{:>{width}s} " + " {:>9.{digits}f}" * 3 + " {:>9}\n"
        for row in rows:
            report += row_fmt.format(*row, width=width, digits=digits)
        report += "\n"

    for average in average_options:
        if average.startswith("micro") and micro_is_accuracy:
            line_heading = "accuracy"
        else:
            line_heading = average + " avg"

        avg_p, avg_r, avg_f1, _ = _sk_prfs(y_true, y_pred, labels=labels, average=average,
                                           sample_weight=sample_weight, zero_division=zero_division)
        avg = [avg_p, avg_r, avg_f1, np.sum(s).item()]

        if output_dict:
            report_dict[line_heading] = dict(zip(headers, [float(i) for i in avg]))
        else:
            if line_heading == "accuracy":
                row_fmt_accuracy = "{:>{width}s} " + " {:>9.{digits}}" * 2 + " {:>9.{digits}f}" + " {:>9}\n"
                report += row_fmt_accuracy.format(line_heading, "", "", *avg[2:], width=width, digits=digits)
            else:
                report += row_fmt.format(line_heading, *avg, width=width, digits=digits)

    if output_dict:
        if "accuracy" in report_dict.keys():
            report_dict["accuracy"] = report_dict["accuracy"]["precision"]
        return report_dict
    else:
        return report
