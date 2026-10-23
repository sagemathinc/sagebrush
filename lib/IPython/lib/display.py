"""IPython.lib.display: a page or a video player shown in an <iframe>, as
IPython's: YouTubeVideo, VimeoVideo and IFrame. Their Jupyter text/html is
IPython's iframe; their text/plain is the object's (<IPython.lib.display.
YouTubeVideo at 0x...>). No YouTube thumbnail (IPython's image/jpeg) is
fetched. Sagebrush's notebook shows code's HTML without frames
(web/safe-html.ts).

    >>> v = YouTubeVideo("dQw4w9WgXcQ", start=30)  # sagebrush only
    >>> v.src, v.params
    ('https://www.youtube.com/embed/dQw4w9WgXcQ', {'start': 30})
"""
from html import escape

__all__ = ["IFrame", "YouTubeVideo", "VimeoVideo"]

_SAFE = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-~")


def _quote_plus(s):
    # (as urllib.parse.quote_plus: letters, digits and _.-~ as they are, a
    # space as +, every other byte as %XX: a str's bytes are its UTF-8, a
    # bytes value's its own)
    data = s if isinstance(s, bytes) else s.encode("utf-8")
    out = []
    for b in data:
        ch = chr(b)
        if ch in _SAFE:
            out.append(ch)
        elif b == 0x20:
            out.append("+")
        else:
            out.append("%%%02X" % b)
    return "".join(out)


def _urlencode(params):
    # (as urllib.parse.urlencode of a dict: key=value, each quoted, joined
    # by &; a bytes key or value as its bytes, anything else as its str())
    q = lambda x: _quote_plus(x if isinstance(x, bytes) else str(x))
    return "&".join(q(k) + "=" + q(v) for k, v in params.items())


class IFrame:
    """Show the page at src in an <iframe> width by height; extras are more
    of the iframe's attributes; keyword arguments go in src's query."""

    iframe = """
        <iframe
            width="{width}"
            height="{height}"
            src="{src}{params}"
            frameborder="0"
            allowfullscreen
            {extras}
        ></iframe>
        """

    def __init__(self, src, width, height, extras=None, **kwargs):
        if extras is None:
            extras = []
        self.src = src
        self.width = width
        self.height = height
        self.extras = extras
        self.params = kwargs

    def _repr_html_(self):
        params = "?" + _urlencode(self.params) if self.params else ""
        return self.iframe.format(src=escape(self.src), width=self.width, height=self.height, params=params, extras=" ".join(self.extras))


class YouTubeVideo(IFrame):
    """The YouTube video id in its player; keyword arguments are the
    player's parameters (start=30, end=60, ...). allow_autoplay=True lets it
    play at once (autoplay=1)."""

    def __init__(self, id, width=400, height=300, allow_autoplay=False, **kwargs):
        self.id = id
        src = "https://www.youtube.com/embed/{0}".format(id)
        if allow_autoplay:
            extras = list(kwargs.get("extras", [])) + ['allow="autoplay"']
            kwargs.update(autoplay=1, extras=extras)
        super().__init__(src, width, height, **kwargs)


class VimeoVideo(IFrame):
    """The Vimeo video id in its player."""

    def __init__(self, id, width=400, height=300, **kwargs):
        src = "https://player.vimeo.com/video/{0}".format(id)
        super().__init__(src, width, height, **kwargs)
