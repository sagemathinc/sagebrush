# The tzdata package (PyPI tzdata 2026.5, Apache-2.0; tzdata/, NOTICE.md) as
# its __init__.py has it, where Sagebrush has the pinned tzdata as an installed
# tzdata package: in a browser, which has no zone files (zoneinfo/_common.py
# reads its zones). Under Node, as on CPython without tzdata, there is none.
import _time

if _time._zone()[2]:
    raise ModuleNotFoundError("No module named 'tzdata'", name="tzdata")
del _time

# IANA versions like 2020a are not valid PEP 440 identifiers; the recommended
# way to translate the version is to use YYYY.n where `n` is a 0-based index.
__version__ = "2026.5"

# This exposes the original IANA version number.
IANA_VERSION = "2026e"
