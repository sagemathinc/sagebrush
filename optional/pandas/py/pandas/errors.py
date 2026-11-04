"""pandas.errors: the exceptions Sagebrush's pandas raises (pandas 3.1.0's
names and bases)."""

__all__ = ["OptionError", "ParserError", "EmptyDataError", "IndexingError"]


class OptionError(AttributeError, KeyError):
    """An unknown or ambiguous option."""


class ParserError(ValueError):
    """An error while parsing a CSV file."""


class EmptyDataError(ValueError):
    """read_csv found no data to parse."""


class IndexingError(Exception):
    """An indexer pandas can't apply (too many axes)."""
