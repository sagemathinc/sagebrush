# Third-party notices: @sagebrush/sklearn

## scikit-learn 1.9.1 (BSD 3-Clause)

Parts of this package are ported from scikit-learn 1.9.1 (https://github.com/scikit-learn/scikit-learn). Its license is shipped with the package as `py/sklearn/_sk_license.py`, whose docstring holds scikit-learn's license verbatim. The ported parts are:

- **`py/sklearn/base.py`:** from `sklearn/base.py`: clone, BaseEstimator, the mixins (OneToOneFeatureMixin among them), `_fit_context`, is_classifier and is_regressor.
- **`py/sklearn/_sk_pprint.py`:** the estimator repr, from `sklearn/utils/_pprint.py`, `_EstimatorPrettyPrinter`, `_changed_params` and `_safe_repr` (see the Python Software Foundation License below).
- **`py/sklearn/_sk_config.py`:** from `sklearn/_config.py`.
- **`py/sklearn/_sk_tags.py`:** from `sklearn/utils/_tags.py`.
- **`py/sklearn/exceptions.py`:** from `sklearn/exceptions.py`.
- **`py/sklearn/utils/__init__.py`:** Bunch, from `sklearn/utils/_bunch.py`; gen_batches and gen_even_slices, from `sklearn/utils/_chunking.py`.
- **`py/sklearn/utils/_sk_param.py`:** the constraints and messages of `sklearn/utils/_param_validation.py`.
- **`py/sklearn/utils/validation.py`:** from `sklearn/utils/validation.py`.
- **`py/sklearn/utils/_sk_indexing.py`:** from `sklearn/utils/_indexing.py`: `_safe_indexing`, `resample` (stratified too) and `shuffle`.
- **`py/sklearn/metrics/_sk_regression.py`:** from `sklearn/metrics/_regression.py`: the four regression metrics and `_check_reg_targets`.
- **`py/sklearn/metrics/_sk_classification.py`:** from `sklearn/metrics/_classification.py`: `_check_targets`, the classification metrics and `classification_report`; `_nanaverage` from `sklearn/utils/extmath.py`.
- **`py/sklearn/model_selection/_sk_split.py`:** from `sklearn/model_selection/_split.py`: the splitters, `_validate_shuffle_split`, `check_cv`, `train_test_split` and the splitters' repr (`_pprint`, `_build_repr`).
- **`py/sklearn/utils/_sk_extmath.py`:** `_approximate_mode`, `_incremental_mean_and_var` and `_safe_accumulator_op`, from `sklearn/utils/extmath.py`.
- **`py/sklearn/pipeline.py`:** from `sklearn/pipeline.py`: Pipeline, make_pipeline and their helpers, and `_BaseComposition` from `sklearn/utils/metaestimators.py`.
- **`py/sklearn/preprocessing/_sk_data.py`:** StandardScaler, `_handle_zeros_in_scale` and `_is_constant_feature`, from `sklearn/preprocessing/_data.py`.
- **`py/sklearn/dummy.py`:** from `sklearn/dummy.py`.
- **`py/sklearn/utils/_sk_available_if.py`:** from `sklearn/utils/_available_if.py`.
- **`py/sklearn/utils/_sk_stats.py`:** `_weighted_percentile`, from `sklearn/utils/stats.py`.
- **`py/sklearn/utils/multiclass.py`:** from `sklearn/utils/multiclass.py`.
- **`py/sklearn/datasets/__init__.py`:** the loaders, from `sklearn/datasets/_base.py`.
- **`py/sklearn/tree.py`:** DecisionTreeClassifier, DecisionTreeRegressor and `BaseDecisionTree`, from `sklearn/tree/_classes.py`; the `Tree` class's attributes, `apply`'s and `predict`'s checks and `compute_feature_importances`'s normalization, from `sklearn/tree/_tree.pyx`. The trees themselves are grown by Sagebrush's decision-tree kernel, whose scikit-learn notice is in Sagebrush's own NOTICE.md.
- **`py/sklearn/utils/class_weight.py`:** from `sklearn/utils/class_weight.py`.
- **`py/sklearn/datasets/_sk_data_*.py`:** scikit-learn's bundled data files and their descriptions (`sklearn/datasets/data/`, `sklearn/datasets/descr/`), embedded by `tests/gen-data.py`. Each file's docstring gives the sha256 of the data file it embeds.

**Names:** `py/sklearn/_sk_names.py` lists scikit-learn 1.9.1's public names, taken from the oracle's modules by `tests/gen-names.py`, so that a name outside the subset raises NotImplementedError.

## CPython 3.14's pprint (Python Software Foundation License)

`py/sklearn/_sk_pprint.py` also ports the parts of CPython 3.14's `Lib/pprint.py` that scikit-learn's printer relies on: `PrettyPrinter._format`, its dict, list, tuple, set and str printers, and `_safe_key`. scikit-learn's `sklearn/utils/_pprint.py` is itself derived from `pprint` under the same license. The Python Software Foundation License Version 2 is shipped in `py/sklearn/_sk_license.py`.

## The datasets (CC BY 4.0)

The data of the four bundled datasets is from the UCI Machine Learning Repository, under the Creative Commons Attribution 4.0 International license (https://creativecommons.org/licenses/by/4.0/). It is shipped as scikit-learn ships it, unmodified (re-encoded as Python string literals):

- **Iris:** R. A. Fisher (1936). Iris. UCI Machine Learning Repository. https://doi.org/10.24432/C56C76. Used by `load_iris`.
- **Wine:** Stefan Aeberhard and M. Forina (1992). Wine. UCI Machine Learning Repository. https://doi.org/10.24432/C5PC7J. Used by `load_wine`.
- **Breast Cancer Wisconsin (Diagnostic):** William Wolberg, Olvi Mangasarian, Nick Street and W. Street (1993). UCI Machine Learning Repository. https://doi.org/10.24432/C5DW2B. Used by `load_breast_cancer`.
- **Optical Recognition of Handwritten Digits:** E. Alpaydin and C. Kaynak (1998). UCI Machine Learning Repository. https://doi.org/10.24432/C50P49. Used by `load_digits` (scikit-learn's copy: the test set's 1797 samples).
