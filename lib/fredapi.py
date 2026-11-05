"""fredapi for Sagebrush: Fred(api_key=...).get_series(series_id,
observation_start=None, observation_end=None), as the fredapi package has
them, with the data fetched live with the reader's own FRED key
(design-data-access r3.1 §1).

The api_key given in code is never used, sent, printed, kept or compared: a
book's code carries its author's key, and each reader uses their own, which
the page keeps (Settings > Data) and Python never sees.  The data is always
current, and nothing is recorded or cached.  Only the series on Sagebrush's
reviewed list can be fetched.  This product uses the FRED API but is not
endorsed or certified by the Federal Reserve Bank of St. Louis."""

import re
from datetime import datetime
import pandas as pd
import _sbdata_live

__all__ = ["Fred"]

_SERIES_ID = re.compile(r"[A-Za-z0-9_]{1,64}")
_noted = []
_KEY_HELP = ("FRED needs your own free FRED API key: add it in Settings > Data (it stays in this page only). "
             "Get one at https://fred.stlouisfed.org/docs/api/api_key.html; FRED's terms of use: "
             "https://fred.stlouisfed.org/docs/api/terms_of_use.html")


class Fred:
    """FRED's API with the reader's own key (the api_key given is not used)."""

    def __init__(self, api_key=None, api_key_file=None, proxies=None):
        # (nothing of the arguments is kept: the key in a book's code is its author's)
        pass

    def __repr__(self):
        return "<fredapi.Fred: the reader's own key>"

    def get_series(self, series_id, observation_start=None, observation_end=None, **kwargs):
        """The series' observations as a Series indexed by date, NaN where FRED
        has no value.  Arguments fredapi passes on to FRED (units, frequency,
        realtime_start, ...) aren't supported: the data is current, as FRED has it."""
        if kwargs:
            raise TypeError("get_series: %s= is not supported by Sagebrush's fredapi" % sorted(kwargs)[0])
        series_id = str(series_id)
        if not _SERIES_ID.fullmatch(series_id):
            raise ValueError("FRED series ids are 1 to 64 letters, digits or underscores, not %r" % series_id[:80])
        params = {"series_id": series_id}
        for name, v in (("observation_start", observation_start), ("observation_end", observation_end)):
            if v is not None:
                params[name] = _date(v)
        if not _noted:
            _noted.append(True)
            print("FRED: using your own key (Settings); the api_key in this code is not used.")
        try:
            ok = _sbdata_live.fred_series_observations(params)
        except _sbdata_live.LiveDataError as e:
            raise _error(e.code, series_id) from None
        if not _has_dates():
            raise NotImplementedError("fredapi: a FRED series is a pandas Series indexed by date (a DatetimeIndex), "
                                      "which Sagebrush's pandas doesn't have yet")
        # (as fredapi: each date a datetime, "." -- here null -- NaN, then a Series of the dict)
        data = {}
        for d, v in zip(ok["dates"], ok["values"]):
            data[datetime(int(d[:4]), int(d[5:7]), int(d[8:10]))] = float("nan") if v is None else float(v)
        return pd.Series(data)


def _has_dates():
    # (pandas' datetime64 index, which fredapi's Series has: never a Series of another index in its place)
    try:
        return pd.DatetimeIndex is not None and pd.to_datetime is not None
    except (AttributeError, NotImplementedError):
        return False


def _date(v):
    # (fredapi's pd.to_datetime(v).strftime('%Y-%m-%d'): a date or datetime, or text pandas reads as one)
    if hasattr(v, "strftime"):
        return v.strftime("%Y-%m-%d")
    s = str(v)
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        datetime(int(s[:4]), int(s[5:7]), int(s[8:10]))
        return s
    return pd.to_datetime(s).strftime("%Y-%m-%d")


def _error(code, series_id):
    if code == "no_key":
        return RuntimeError(_KEY_HELP)
    if code == "not_in_catalog":
        return ValueError("This FRED series isn't in Sagebrush's reviewed list yet: %s" % series_id)
    if code == "rate_limited":
        return RuntimeError("FRED is rate-limiting; try again in a minute")
    if code == "timeout":
        return TimeoutError("FRED didn't answer in time; try again")
    return RuntimeError("FRED live data needs the Sagebrush web app (with your own FRED key, in Settings > Data)")
