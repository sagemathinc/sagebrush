"""sklearn.neural_network: not in Sagebrush's sklearn 0.x subset yet; each of its public names raises NotImplementedError."""

from ._sk_missing import missing as _sk_missing


def __getattr__(name):
    return _sk_missing('sklearn.neural_network', name)
