"""Live data for Sagebrush's library modules (design-data-access r3.1 §1):
the one closed operation by which Python asks the page for data fetched live,
a FRED series with the reader's own key.  It never takes a URL, a header or a
key: the page holds the key and attaches it after admission, so it never
reaches Python.  This module checks the parameters' form only; the page
checks everything again.  With no page to ask (the command line, a page
without shared memory, a board), every call is `unavailable`.

FRED data never goes through urllib or _sbdata (the replay layer): it is
never recorded, cached or replayed."""

import json

ERRORS = ("no_key", "not_in_catalog", "rate_limited", "unavailable", "timeout", "interrupted")


class LiveDataError(Exception):
    """The page's answer was one of ERRORS (never upstream text)."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def fred_series_observations(params):
    """{"dates": [...], "values": [...]} for {"series_id", "observation_start"?,
    "observation_end"?}, from the page; LiveDataError otherwise, and
    KeyboardInterrupt for a Stop while it waited."""
    if type(params) is not dict:
        raise TypeError("fred_series_observations: the parameters must be a dict")
    answer = __pyjs_host__("live_data", "fred.series_observations", json.dumps(params, sort_keys=True))
    if answer is None:
        raise LiveDataError("unavailable")
    a = json.loads(answer)
    if "error" in a:
        if a["error"] == "interrupted":
            raise KeyboardInterrupt
        raise LiveDataError(a["error"] if a["error"] in ERRORS else "unavailable")
    return a["ok"]
