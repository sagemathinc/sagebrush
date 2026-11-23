"""Custom warnings and errors used across scikit-learn (sklearn 1.9.1's sklearn/exceptions.py)."""

__all__ = [
    "ConvergenceWarning",
    "DataConversionWarning",
    "DataDimensionalityWarning",
    "EfficiencyWarning",
    "EstimatorCheckFailedWarning",
    "FitFailedWarning",
    "NotFittedError",
    "PositiveSpectrumWarning",
    "SkipTestWarning",
    "UndefinedMetricWarning",
    "UnsetMetadataPassedError",
]


class UnsetMetadataPassedError(ValueError):
    """Exception class to raise if a metadata is passed which is not explicitly requested."""

    def __init__(self, *, message, unrequested_params, routed_params):
        super().__init__(message)
        self.unrequested_params = unrequested_params
        self.routed_params = routed_params


class NotFittedError(ValueError, AttributeError):
    """Exception class to raise if estimator is used before fitting."""


class ConvergenceWarning(UserWarning):
    """Custom warning to capture convergence problems."""


class DataConversionWarning(UserWarning):
    """Warning used to notify implicit data conversions happening in the code."""


class DataDimensionalityWarning(UserWarning):
    """Custom warning to notify potential issues with data dimensionality."""


class EfficiencyWarning(UserWarning):
    """Warning used to notify the user of inefficient computation."""


class FitFailedWarning(RuntimeWarning):
    """Warning class used if there is an error while fitting the estimator."""


class SkipTestWarning(UserWarning):
    """Warning class used to notify the user of a test that was skipped."""


class UndefinedMetricWarning(UserWarning):
    """Warning used when the metric is invalid."""


class PositiveSpectrumWarning(UserWarning):
    """Warning raised when the eigenvalues of a PSD matrix have issues."""


class InconsistentVersionWarning(UserWarning):
    """Warning raised when an estimator is unpickled with an inconsistent version."""

    def __init__(self, *, estimator_name, current_sklearn_version, original_sklearn_version):
        self.estimator_name = estimator_name
        self.current_sklearn_version = current_sklearn_version
        self.original_sklearn_version = original_sklearn_version

    def __str__(self):
        return (
            f"Trying to unpickle estimator {self.estimator_name} from version"
            f" {self.original_sklearn_version} when "
            f"using version {self.current_sklearn_version}. This might lead to breaking"
            " code or "
            "invalid results. Use at your own risk. "
            "For more info please refer to:\n"
            "https://scikit-learn.org/stable/model_persistence.html"
            "#security-maintainability-limitations"
        )


class EstimatorCheckFailedWarning(UserWarning):
    """Warning raised when an estimator check from the common tests fails."""

    def __init__(self, *, estimator, check_name, exception, status, expected_to_fail, expected_to_fail_reason):
        self.estimator = estimator
        self.check_name = check_name
        self.exception = exception
        self.status = status
        self.expected_to_fail = expected_to_fail
        self.expected_to_fail_reason = expected_to_fail_reason

    def __repr__(self):
        expected_to_fail_str = (
            f"Expected to fail: {self.expected_to_fail_reason}"
            if self.expected_to_fail
            else "Not expected to fail"
        )
        return (
            f"Test {self.check_name} failed for estimator {self.estimator!r}.\n"
            f"Expected to fail reason: {expected_to_fail_str}\n"
            f"Exception: {self.exception}"
        )

    def __str__(self):
        return self.__repr__()
