# @sagebrush/sklearn

Sagebrush's sklearn 0.x: a subset of scikit-learn 1.9.1's API, in Python over Sagebrush's numpy and pandas, as an optional package. `import sklearn` works in a notebook with the package set; `sklearn.__version__` and `importlib.metadata.version("scikit-learn")` both give the package's own version, 0.1.0.

## The subset, so far

- **Estimators:** `BaseEstimator` with get_params, set_params and scikit-learn's text repr; `clone`; `ClassifierMixin`, `RegressorMixin`, `TransformerMixin` and `MetaEstimatorMixin`; `is_classifier`, `is_regressor`; the estimator tags.
- **Configuration:** `get_config`, `set_config` and `config_context`, with scikit-learn's keys.
- **Input checks (`sklearn.utils.validation`):** `check_array` and `check_X_y` for numpy arrays, lists and pandas DataFrames and Series of numbers and booleans, `validate_data` with `n_features_in_` and `feature_names_in_`, `check_is_fitted`, `check_random_state`, `check_scalar`, `column_or_1d` and the other checks, with scikit-learn's messages.
- **Utilities (`sklearn.utils`):** `Bunch`, `resample`, `shuffle`, `gen_batches`, `gen_even_slices` and `_safe_indexing`.
- **Metrics (`sklearn.metrics`):** `r2_score`, `mean_squared_error`, `root_mean_squared_error` and `mean_absolute_error` (with sample weights and multioutput), and, for binary and multiclass targets, `accuracy_score`, `confusion_matrix`, `multilabel_confusion_matrix`, `precision_recall_fscore_support`, `precision_score`, `recall_score`, `f1_score`, `fbeta_score` and `classification_report`. The values are scikit-learn's to the bit. Multilabel indicator targets (sparse in scikit-learn) are refused.
- **Targets (`sklearn.utils.multiclass`):** `type_of_target`, `unique_labels`, `is_multilabel` and `check_classification_targets`. A pandas Series of strings works as labels: its values are a str array inside, where scikit-learn makes an object array.
- **Datasets:** `load_wine`, `load_iris`, `load_breast_cancer` and `load_digits`, with `return_X_y` and `as_frame`. The data is bundled, so nothing is fetched.

Every other scikit-learn name raises `NotImplementedError("... is not in Sagebrush's sklearn 0.x subset")`; a name scikit-learn doesn't have raises `AttributeError`, as there. Sagebrush's numpy has no object dtype, so text data (which scikit-learn turns into object arrays) is refused, and `feature_names_in_` is a str array. `tests/test_unsupported.py` lists each such divergence, and `known.json` gives the reason for each one.

## Tests

`tests/test_*.py` run under the built CLI with the package set (`node scripts/optional-packages.mjs test --pkgset ...`). Each is compared with its `.out`:

- **scikit-learn's own output** (`tests/oracle/`, recorded by `tests/gen-oracle.sh` in the environment `tests/oracle-env.txt`; `tests/ORACLE.md`) for every other test;
- **Sagebrush's output** for the tests listed in `tests/sagebrush-only.txt`, where the oracle can't speak: `test_unsupported`, `test_version` and `test_known` (which checks `known.json`, and that every test is either in that list or has an oracle output, never both).

After changing a file under `py/`, run `python3 -I tests/gen-manifest.py optional/sklearn` to update `sagebrush.json`.

## Notices

See `NOTICE.md`. The licenses ship as `py/sklearn/_sk_license.py`.
