"""Sagebrush's sklearn 0.x: a subset of scikit-learn 1.9.1's API, in Python over Sagebrush's numpy, as an optional
package. Each submodule is loaded the first time it is used, as scikit-learn's are; a public name outside the subset
raises NotImplementedError naming it (_sk_names lists scikit-learn's)."""

from ._sk_config import config_context, get_config, set_config
from ._sk_missing import missing as _sk_missing
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
    # (a submodule, loaded at its first use)
    if name == 'base':
        from . import base
        return base
    if name == 'calibration':
        from . import calibration
        return calibration
    if name == 'callback':
        from . import callback
        return callback
    if name == 'cluster':
        from . import cluster
        return cluster
    if name == 'compose':
        from . import compose
        return compose
    if name == 'covariance':
        from . import covariance
        return covariance
    if name == 'cross_decomposition':
        from . import cross_decomposition
        return cross_decomposition
    if name == 'datasets':
        from . import datasets
        return datasets
    if name == 'decomposition':
        from . import decomposition
        return decomposition
    if name == 'discriminant_analysis':
        from . import discriminant_analysis
        return discriminant_analysis
    if name == 'dummy':
        from . import dummy
        return dummy
    if name == 'ensemble':
        from . import ensemble
        return ensemble
    if name == 'exceptions':
        from . import exceptions
        return exceptions
    if name == 'feature_extraction':
        from . import feature_extraction
        return feature_extraction
    if name == 'feature_selection':
        from . import feature_selection
        return feature_selection
    if name == 'frozen':
        from . import frozen
        return frozen
    if name == 'gaussian_process':
        from . import gaussian_process
        return gaussian_process
    if name == 'impute':
        from . import impute
        return impute
    if name == 'inspection':
        from . import inspection
        return inspection
    if name == 'isotonic':
        from . import isotonic
        return isotonic
    if name == 'kernel_approximation':
        from . import kernel_approximation
        return kernel_approximation
    if name == 'kernel_ridge':
        from . import kernel_ridge
        return kernel_ridge
    if name == 'linear_model':
        from . import linear_model
        return linear_model
    if name == 'manifold':
        from . import manifold
        return manifold
    if name == 'metrics':
        from . import metrics
        return metrics
    if name == 'mixture':
        from . import mixture
        return mixture
    if name == 'model_selection':
        from . import model_selection
        return model_selection
    if name == 'multiclass':
        from . import multiclass
        return multiclass
    if name == 'multioutput':
        from . import multioutput
        return multioutput
    if name == 'naive_bayes':
        from . import naive_bayes
        return naive_bayes
    if name == 'neighbors':
        from . import neighbors
        return neighbors
    if name == 'neural_network':
        from . import neural_network
        return neural_network
    if name == 'pipeline':
        from . import pipeline
        return pipeline
    if name == 'preprocessing':
        from . import preprocessing
        return preprocessing
    if name == 'random_projection':
        from . import random_projection
        return random_projection
    if name == 'semi_supervised':
        from . import semi_supervised
        return semi_supervised
    if name == 'svm':
        from . import svm
        return svm
    if name == 'tree':
        from . import tree
        return tree
    if name == 'utils':
        from . import utils
        return utils
    return _sk_missing("sklearn", name)


def __dir__():
    return __all__
