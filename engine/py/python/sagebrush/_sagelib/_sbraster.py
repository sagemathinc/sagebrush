"""_sbraster under CPython: Sagebrush's PNG module (engine/raster), built
into the extension (sagebrush._native.raster), with the browser runtime's
interface (src/runtime/raster.ts), which lib/_png.py uses."""

from sagebrush._native import raster as _raster


def render(svg, scale, width, height, background, dpi, text):
    """(PNG bytes, the characters the font lacked): svg drawn at scale pixels
    per SVG unit on width x height pixels (0 x 0: the drawing's size), on
    background (a CSS color; None or "" for transparent)."""
    return _raster.raster_render(str(svg), float(scale), int(width), int(height), "" if background is None else str(background),
                                 float(dpi), [(str(k), str(v)) for k, v in text])


def loaded():
    return True


MAX_FILE_BYTES = 256 << 20


def decode(png):
    """(width, height, channels, float32 values as little-endian bytes).
    bytes are passed as they are (the extension borrows them); another
    buffer is measured before it is copied: at most 256 MiB."""
    if not isinstance(png, bytes):
        n = memoryview(png).nbytes
        if n > MAX_FILE_BYTES:
            raise ValueError("a PNG of %d bytes: Sagebrush reads at most %d" % (n, MAX_FILE_BYTES))
        png = bytes(png)
    return _raster.raster_decode(png)
