"""scikit-learn's global configuration: get_config, set_config and config_context, with sklearn 1.9.1's keys and
defaults (sklearn/_config.py). Sagebrush's sklearn reads print_changed_only (reprs) and assume_finite (input checks);
the other keys are kept and returned as sklearn keeps them."""

import threading
from contextlib import contextmanager

_global_config = {
    "assume_finite": False,
    "working_memory": 1024,
    "print_changed_only": True,
    "display": "diagram",
    "pairwise_dist_chunk_size": 256,
    "enable_cython_pairwise_dist": True,
    "array_api_dispatch": False,
    "transform_output": "default",
    "enable_metadata_routing": False,
    "skip_parameter_validation": False,
    "sparse_interface": "spmatrix",
}
_threadlocal = threading.local()


def _sk_local():
    # (each thread its own copy of the global configuration, as sklearn's)
    try:
        return _threadlocal._sk_config
    except AttributeError:
        _threadlocal._sk_config = _global_config.copy()
        return _threadlocal._sk_config


def get_config():
    """Retrieve the current values of the configuration set by set_config."""
    return _sk_local().copy()


def set_config(assume_finite=None, working_memory=None, print_changed_only=None, display=None, pairwise_dist_chunk_size=None,
               enable_cython_pairwise_dist=None, array_api_dispatch=None, transform_output=None, enable_metadata_routing=None,
               skip_parameter_validation=None, sparse_interface=None):
    """Set global scikit-learn configuration; a None leaves that key as it is."""
    local = _sk_local()
    for key, value in (("assume_finite", assume_finite), ("working_memory", working_memory), ("print_changed_only", print_changed_only),
                       ("display", display), ("pairwise_dist_chunk_size", pairwise_dist_chunk_size),
                       ("enable_cython_pairwise_dist", enable_cython_pairwise_dist), ("array_api_dispatch", array_api_dispatch),
                       ("transform_output", transform_output), ("enable_metadata_routing", enable_metadata_routing),
                       ("skip_parameter_validation", skip_parameter_validation), ("sparse_interface", sparse_interface)):
        if value is not None:
            if key == "array_api_dispatch" and value:
                raise NotImplementedError("sklearn's array_api_dispatch is not in Sagebrush's sklearn 0.x subset")
            local[key] = value


@contextmanager
def config_context(*, assume_finite=None, working_memory=None, print_changed_only=None, display=None, pairwise_dist_chunk_size=None,
                   enable_cython_pairwise_dist=None, array_api_dispatch=None, transform_output=None, enable_metadata_routing=None,
                   skip_parameter_validation=None, sparse_interface=None):
    """Temporarily change the global configuration; the previous values come back at the block's end."""
    old = get_config()
    set_config(assume_finite=assume_finite, working_memory=working_memory, print_changed_only=print_changed_only, display=display,
               pairwise_dist_chunk_size=pairwise_dist_chunk_size, enable_cython_pairwise_dist=enable_cython_pairwise_dist,
               array_api_dispatch=array_api_dispatch, transform_output=transform_output, enable_metadata_routing=enable_metadata_routing,
               skip_parameter_validation=skip_parameter_validation, sparse_interface=sparse_interface)
    try:
        yield
    finally:
        set_config(**old)
