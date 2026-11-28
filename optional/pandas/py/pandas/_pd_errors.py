"""The error a name outside the subset raises: a NotImplementedError (the
subset's refusal) that is also an AttributeError, so that hasattr() gives
False and getattr() with a default gives the default, as for a name pandas
lacks. It keeps the builtin's name, so the message reads the same."""

_Builtin = NotImplementedError


class NotImplementedError(_Builtin, AttributeError):
    pass


NotImplementedError.__module__ = "pandas"
UnsupportedName = NotImplementedError


def unsupported_name(what):
    return UnsupportedName("pandas.%s is not in Sagebrush's pandas 0.x subset" % what)
