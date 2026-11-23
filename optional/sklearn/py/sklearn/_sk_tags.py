"""scikit-learn 1.9.1's estimator tags (sklearn/utils/_tags.py): InputTags, TargetTags, TransformerTags,
ClassifierTags, RegressorTags and Tags, with their fields and defaults, and get_tags. sklearn's are dataclasses; these
are plain classes with the same fields, reprs and equality."""


class _SkTagsBase:
    _sk_fields = ()

    def _sk_values(self):
        return tuple(self._sk_get(name) for name in self._sk_fields)

    def __repr__(self):
        return "%s(%s)" % (type(self).__name__, ", ".join("%s=%r" % (n, v) for n, v in zip(self._sk_fields, self._sk_values())))

    def __eq__(self, other):
        if type(other) is not type(self):
            return NotImplemented
        return self._sk_values() == other._sk_values()


class InputTags(_SkTagsBase):
    """The kinds of input an estimator accepts."""

    _sk_fields = ("one_d_array", "two_d_array", "three_d_array", "sparse", "categorical", "string", "dict", "positive_only",
                  "allow_nan", "pairwise")

    def __init__(self, one_d_array=False, two_d_array=True, three_d_array=False, sparse=False, categorical=False, string=False,
                 dict=False, positive_only=False, allow_nan=False, pairwise=False):
        self.one_d_array = one_d_array
        self.two_d_array = two_d_array
        self.three_d_array = three_d_array
        self.sparse = sparse
        self.categorical = categorical
        self.string = string
        self.dict = dict
        self.positive_only = positive_only
        self.allow_nan = allow_nan
        self.pairwise = pairwise

    def _sk_get(self, name):
        return {"one_d_array": self.one_d_array, "two_d_array": self.two_d_array, "three_d_array": self.three_d_array,
                "sparse": self.sparse, "categorical": self.categorical, "string": self.string, "dict": self.dict,
                "positive_only": self.positive_only, "allow_nan": self.allow_nan, "pairwise": self.pairwise}[name]


class TargetTags(_SkTagsBase):
    """The kinds of target an estimator accepts."""

    _sk_fields = ("required", "one_d_labels", "two_d_labels", "positive_only", "multi_output", "single_output")

    def __init__(self, required, one_d_labels=False, two_d_labels=False, positive_only=False, multi_output=False, single_output=True):
        self.required = required
        self.one_d_labels = one_d_labels
        self.two_d_labels = two_d_labels
        self.positive_only = positive_only
        self.multi_output = multi_output
        self.single_output = single_output

    def _sk_get(self, name):
        return {"required": self.required, "one_d_labels": self.one_d_labels, "two_d_labels": self.two_d_labels,
                "positive_only": self.positive_only, "multi_output": self.multi_output, "single_output": self.single_output}[name]


class TransformerTags(_SkTagsBase):
    """A transformer's tags."""

    _sk_fields = ("preserves_dtype",)

    def __init__(self, preserves_dtype=None):
        self.preserves_dtype = ["float64"] if preserves_dtype is None else preserves_dtype

    def _sk_get(self, name):
        return self.preserves_dtype


class ClassifierTags(_SkTagsBase):
    """A classifier's tags."""

    _sk_fields = ("poor_score", "multi_class", "multi_label")

    def __init__(self, poor_score=False, multi_class=True, multi_label=False):
        self.poor_score = poor_score
        self.multi_class = multi_class
        self.multi_label = multi_label

    def _sk_get(self, name):
        return {"poor_score": self.poor_score, "multi_class": self.multi_class, "multi_label": self.multi_label}[name]


class RegressorTags(_SkTagsBase):
    """A regressor's tags."""

    _sk_fields = ("poor_score",)

    def __init__(self, poor_score=False):
        self.poor_score = poor_score

    def _sk_get(self, name):
        return self.poor_score


class Tags(_SkTagsBase):
    """An estimator's tags."""

    _sk_fields = ("estimator_type", "target_tags", "transformer_tags", "classifier_tags", "regressor_tags", "array_api_support",
                  "no_validation", "non_deterministic", "requires_fit", "_skip_test", "input_tags")

    def __init__(self, estimator_type, target_tags, transformer_tags=None, classifier_tags=None, regressor_tags=None,
                 array_api_support=False, no_validation=False, non_deterministic=False, requires_fit=True, _skip_test=False,
                 input_tags=None):
        self.estimator_type = estimator_type
        self.target_tags = target_tags
        self.transformer_tags = transformer_tags
        self.classifier_tags = classifier_tags
        self.regressor_tags = regressor_tags
        self.array_api_support = array_api_support
        self.no_validation = no_validation
        self.non_deterministic = non_deterministic
        self.requires_fit = requires_fit
        self._skip_test = _skip_test
        self.input_tags = InputTags() if input_tags is None else input_tags

    def _sk_get(self, name):
        return {"estimator_type": self.estimator_type, "target_tags": self.target_tags, "transformer_tags": self.transformer_tags,
                "classifier_tags": self.classifier_tags, "regressor_tags": self.regressor_tags,
                "array_api_support": self.array_api_support, "no_validation": self.no_validation,
                "non_deterministic": self.non_deterministic, "requires_fit": self.requires_fit, "_skip_test": self._skip_test,
                "input_tags": self.input_tags}[name]


def get_tags(estimator):
    """The estimator's tags: its __sklearn_tags__(), as sklearn.utils.get_tags."""
    try:
        return estimator.__sklearn_tags__()
    except AttributeError as exc:
        if "object has no attribute '__sklearn_tags__'" in str(exc):
            raise AttributeError(
                f"The following error was raised: {exc}. It seems that "
                "there are no classes that implement `__sklearn_tags__` "
                "in the MRO and/or all classes in the MRO call "
                "`super().__sklearn_tags__()`. Make sure to inherit from "
                "`BaseEstimator` which implements `__sklearn_tags__` (or "
                "alternatively define `__sklearn_tags__` but we don't recommend "
                "this approach). Note that `BaseEstimator` needs to be on the "
                "right side of other Mixins in the inheritance order."
            )
        raise
