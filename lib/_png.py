"""PNG files for matplotlib: savefig's PNG (the figure's SVG drawn by
Sagebrush's PNG module, src/runtime/raster.ts) and imread of PNG files.

The module is a WebAssembly module of its own, fetched and compiled the first
time a PNG is written or read; the limits it checks (16384 pixels on a side,
2**24 in all) apply to both."""

import os

# The most a PNG file read may be, in bytes (checked before it is read).
MAX_FILE_BYTES = 256 << 20
MAX_AXIS = 16384
MAX_PIXELS = 1 << 24

_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def check_size(width_in, height_in, dpi):
    """(width, height, dpi) as floats, or ValueError: finite, positive, and
    within the pixel limits, checked before any arithmetic on them (an
    infinite or NaN dpi or size is this refusal, not an OverflowError)."""
    import math
    try:
        width_in, height_in, dpi = float(width_in), float(height_in), float(dpi)
    except (TypeError, ValueError, OverflowError):
        raise ValueError("a PNG needs a numeric size and dpi, not %r x %r at %r dpi" % (width_in, height_in, dpi)) from None
    if not all(math.isfinite(v) and v > 0 for v in (width_in, height_in, dpi)) or width_in * dpi > MAX_AXIS or height_in * dpi > MAX_AXIS:
        raise ValueError("a PNG of %r x %r inches at %r dpi: Sagebrush writes at most %d pixels on a side and %d in all"
                         % (width_in, height_in, dpi, MAX_AXIS, MAX_PIXELS))
    return width_in, height_in, dpi


def figure_png(svg, width_in, height_in, dpi, background, text):
    """The figure's SVG (100 units per inch) as PNG bytes: int(width * dpi)
    by int(height * dpi) pixels, as matplotlib's Agg canvas, on `background`
    (a CSS color, or None for transparent), with the PNG text chunks in
    `text` [(key, value)]."""
    import _sbraster
    width_in, height_in, dpi = check_size(width_in, height_in, dpi)
    w, h = int(width_in * dpi), int(height_in * dpi)
    if w < 1 or h < 1 or w > MAX_AXIS or h > MAX_AXIS or w * h > MAX_PIXELS:
        raise ValueError("a PNG of %d x %d pixels: Sagebrush writes at most %d on a side and %d in all"
                         % (w, h, MAX_AXIS, MAX_PIXELS))
    png, missing = _sbraster.render(svg, dpi / 100.0, w, h, background, float(dpi), text)
    if missing:
        chars = ", ".join("%r (U+%04X)" % (c, ord(c)) for c in missing)
        raise NotImplementedError("savefig: PNG output in Sagebrush supports Latin-1, Greek and common math symbols, "
                                  "and this figure has %s; save it as SVG (a .svg file name) to keep them" % chars)
    return png


def _url_scheme(s):
    """urllib.parse.urlparse(s).scheme"""
    i = s.find(":")
    if i > 0 and s[0].isascii() and s[0].isalpha():
        ok = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+-."
        if all(c in ok for c in s[:i]):
            return s[:i].lower()
    return ""


def _suffix(name):
    """pathlib.Path(name).suffix.lower()[1:]"""
    return os.path.splitext(os.path.basename(name))[1].lower()[1:]


def read(fname, format=None):
    """matplotlib's imread for a PNG file (a file name, path or binary file
    object): float32 values in [0, 1], (h, w) for grayscale, (h, w, 3) for
    RGB and (h, w, 4) for RGBA, a palette or grayscale with alpha.  Like
    matplotlib, it goes by the file's contents, the format (from `format`,
    else the name) only deciding the error for a file that is not a PNG."""
    import numpy as np
    import _sbraster
    if format is None:
        if isinstance(fname, str):
            ext = "png" if len(_url_scheme(fname)) > 1 else _suffix(fname)
        elif hasattr(fname, "geturl"):
            ext = "png"
        elif hasattr(fname, "name"):
            ext = _suffix(str(fname.name))
        else:
            ext = "png"
    else:
        ext = format
    if isinstance(fname, str) and len(_url_scheme(fname)) > 1:
        raise ValueError("Please open the URL for reading and pass the result to Pillow, e.g. with "
                         "``np.array(PIL.Image.open(urllib.request.urlopen(url)))``.")
    if hasattr(fname, "read"):
        data = fname.read(MAX_FILE_BYTES + 1)
        if not isinstance(data, (bytes, bytearray)):
            raise TypeError("imread: the file must be opened in binary mode")
    else:
        name = os.fspath(fname)
        if os.path.getsize(name) > MAX_FILE_BYTES:
            raise ValueError("imread: %s is larger than the %d bytes Sagebrush reads" % (name, MAX_FILE_BYTES))
        with open(name, "rb") as f:
            data = f.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES:
        raise ValueError("imread: the file is larger than the %d bytes Sagebrush reads" % MAX_FILE_BYTES)
    if bytes(data[:8]) != _SIGNATURE:
        if ext == "png":
            raise SyntaxError("not a PNG file")
        raise NotImplementedError("imread: Sagebrush reads PNG files only, and this file is not one%s"
                                  % (" (.%s)" % ext if ext else ""))
    try:
        w, h, ch, raw = _sbraster.decode(bytes(data))
    except ValueError as e:
        # (Pillow's errors, which matplotlib passes on: SyntaxError for a file
        # broken before its image data, OSError for one whose image data
        # cannot be read; a limit is a ValueError)
        if str(e).startswith("a broken PNG file"):
            raise SyntaxError("imread: " + str(e)) from None
        if str(e).startswith("a PNG file that cannot be read"):
            raise OSError("imread: " + str(e)) from None
        raise ValueError("imread: " + str(e)) from None
    if isinstance(raw, np.ndarray):
        # (the Python package's engine reads the values into an array of
        # their own: reshaped, not copied)
        return raw.reshape((h, w) if ch == 1 else (h, w, ch))
    a = np.frombuffer(raw, dtype=np.float32)
    return a.reshape((h, w) if ch == 1 else (h, w, ch)).copy()
