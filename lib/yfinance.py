"""yfinance for Sagebrush: importable, so a notebook's import cell runs, but
download() and Ticker() say plainly that Yahoo Finance data isn't available:
Yahoo's terms don't allow automated access without its permission
(design-data-access r3.1 §2).  Nothing here makes a request."""

__all__ = ["download", "Ticker"]

_MESSAGE = "Yahoo Finance data isn't available in Sagebrush: automated Yahoo access is unsupported"


def download(*args, **kwargs):
    raise RuntimeError(_MESSAGE)


class Ticker:
    def __init__(self, *args, **kwargs):
        raise RuntimeError(_MESSAGE)
