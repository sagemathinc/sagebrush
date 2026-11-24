"""Sagebrush's sklearn 0.x: a subset of scikit-learn 1.9.1's API, in Python over Sagebrush's numpy, as an optional
package. Each submodule is loaded the first time it is used, as scikit-learn's are; a public name outside the subset
raises NotImplementedError naming it (_sk_names lists scikit-learn's)."""

from ._sk_config import config_context, get_config, set_config
from ._sk_missing import missing as _sk_missing
from ._sk_missing import module_names as _sk_module_names
from .base import clone

__version__ = "0.1.0"

__all__ = [
    'calibration',
    'callback',
    'clone',
    'cluster',
    'compose',
    'config_context',
    'covariance',
    'cross_decomposition',
    'datasets',
    'decomposition',
    'discriminant_analysis',
    'dummy',
    'ensemble',
    'exceptions',
    'experimental',
    'externals',
    'feature_extraction',
    'feature_selection',
    'frozen',
    'gaussian_process',
    'get_config',
    'impute',
    'inspection',
    'isotonic',
    'kernel_approximation',
    'kernel_ridge',
    'linear_model',
    'manifold',
    'metrics',
    'mixture',
    'model_selection',
    'multiclass',
    'multioutput',
    'naive_bayes',
    'neighbors',
    'neural_network',
    'pipeline',
    'preprocessing',
    'random_projection',
    'semi_supervised',
    'set_config',
    'show_versions',
    'svm',
    'tree',
]


def __getattr__(name):
    # (a submodule, loaded at its first use: imported by its full name, so the import system binds it here before it
    # is read, never through this function again)
    if name == 'base':
        import sklearn.base
        return sklearn.base
    if name == 'calibration':
        import sklearn.calibration
        return sklearn.calibration
    if name == 'callback':
        import sklearn.callback
        return sklearn.callback
    if name == 'cluster':
        import sklearn.cluster
        return sklearn.cluster
    if name == 'compose':
        import sklearn.compose
        return sklearn.compose
    if name == 'covariance':
        import sklearn.covariance
        return sklearn.covariance
    if name == 'cross_decomposition':
        import sklearn.cross_decomposition
        return sklearn.cross_decomposition
    if name == 'datasets':
        import sklearn.datasets
        return sklearn.datasets
    if name == 'decomposition':
        import sklearn.decomposition
        return sklearn.decomposition
    if name == 'discriminant_analysis':
        import sklearn.discriminant_analysis
        return sklearn.discriminant_analysis
    if name == 'dummy':
        import sklearn.dummy
        return sklearn.dummy
    if name == 'ensemble':
        import sklearn.ensemble
        return sklearn.ensemble
    if name == 'exceptions':
        import sklearn.exceptions
        return sklearn.exceptions
    if name == 'feature_extraction':
        import sklearn.feature_extraction
        return sklearn.feature_extraction
    if name == 'feature_selection':
        import sklearn.feature_selection
        return sklearn.feature_selection
    if name == 'frozen':
        import sklearn.frozen
        return sklearn.frozen
    if name == 'gaussian_process':
        import sklearn.gaussian_process
        return sklearn.gaussian_process
    if name == 'impute':
        import sklearn.impute
        return sklearn.impute
    if name == 'inspection':
        import sklearn.inspection
        return sklearn.inspection
    if name == 'isotonic':
        import sklearn.isotonic
        return sklearn.isotonic
    if name == 'kernel_approximation':
        import sklearn.kernel_approximation
        return sklearn.kernel_approximation
    if name == 'kernel_ridge':
        import sklearn.kernel_ridge
        return sklearn.kernel_ridge
    if name == 'linear_model':
        import sklearn.linear_model
        return sklearn.linear_model
    if name == 'manifold':
        import sklearn.manifold
        return sklearn.manifold
    if name == 'metrics':
        import sklearn.metrics
        return sklearn.metrics
    if name == 'mixture':
        import sklearn.mixture
        return sklearn.mixture
    if name == 'model_selection':
        import sklearn.model_selection
        return sklearn.model_selection
    if name == 'multiclass':
        import sklearn.multiclass
        return sklearn.multiclass
    if name == 'multioutput':
        import sklearn.multioutput
        return sklearn.multioutput
    if name == 'naive_bayes':
        import sklearn.naive_bayes
        return sklearn.naive_bayes
    if name == 'neighbors':
        import sklearn.neighbors
        return sklearn.neighbors
    if name == 'neural_network':
        import sklearn.neural_network
        return sklearn.neural_network
    if name == 'pipeline':
        import sklearn.pipeline
        return sklearn.pipeline
    if name == 'preprocessing':
        import sklearn.preprocessing
        return sklearn.preprocessing
    if name == 'random_projection':
        import sklearn.random_projection
        return sklearn.random_projection
    if name == 'semi_supervised':
        import sklearn.semi_supervised
        return sklearn.semi_supervised
    if name == 'svm':
        import sklearn.svm
        return sklearn.svm
    if name == 'tree':
        import sklearn.tree
        return sklearn.tree
    if name == 'utils':
        import sklearn.utils
        return sklearn.utils
    if name not in _sk_module_names("sklearn"):
        # (scikit-learn's own message for a name it doesn't have)
        raise AttributeError(f"Module 'sklearn' has no attribute '{name}'")
    return _sk_missing("sklearn", name)


def __dir__():
    return __all__
