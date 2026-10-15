"""matplotlib.image in Sagebrush: imread, for PNG files (lib/_png.py)."""


def imread(fname, format=None):
    """matplotlib's imread for PNG files: float32 values in [0, 1], (h, w)
    for grayscale, (h, w, 3) for RGB and (h, w, 4) for RGBA (a palette or
    grayscale with alpha comes back as RGBA).  Other formats raise
    NotImplementedError."""
    import _png
    return _png.read(fname, format)
