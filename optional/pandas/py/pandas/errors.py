"""pandas.errors: the exceptions Sagebrush's pandas raises (pandas 3.1.0's
names and bases)."""

__all__ = ["OptionError", "ParserError", "EmptyDataError", "IndexingError", "PandasChangeWarning", "PandasDeprecationWarning", "Pandas4Warning"]


class OptionError(AttributeError, KeyError):
    """An unknown or ambiguous option."""


class ParserError(ValueError):
    """An error while parsing a CSV file."""


class EmptyDataError(ValueError):
    """read_csv found no data to parse."""


class IndexingError(Exception):
    """An indexer pandas can't apply (too many axes)."""


class PandasChangeWarning(Warning):
    """A behaviour pandas will change."""


class PandasDeprecationWarning(PandasChangeWarning, DeprecationWarning):
    """Something pandas will remove."""


class Pandas4Warning(PandasDeprecationWarning):
    """Something pandas 4 removes (the inplace keyword, PDEP-8)."""


_INPLACE = object()


def inplace_given(inplace, owner):
    """Whether inplace=True was given, warning as pandas 3.1 does whenever
    the keyword is given at all; `owner` is e.g. 'Series.dropna'."""
    if inplace is _INPLACE:
        return False
    import warnings
    warnings.warn("The inplace keyword in %s is deprecated and will be removed in a future version (PDEP-8).\n"
                  "See https://pandas.pydata.org/docs/dev/whatsnew/v3.1.0.html#deprecation-inplace for more details." % owner,
                  Pandas4Warning, stacklevel=3)
    return bool(inplace)
