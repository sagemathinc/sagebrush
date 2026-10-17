# Sagebrush: the pickling exceptions of CPython's _pickle, its C
# accelerator, which Sagebrush does not have (pickle's Pickler and
# Unpickler are the pure-Python ones), so that they are _pickle's, as
# CPython's: pickle.PicklingError.__module__ is '_pickle', and a pickled
# one names _pickle.PicklingError.


class PickleError(Exception):
    pass


class PicklingError(PickleError):
    pass


class UnpicklingError(PickleError):
    pass
