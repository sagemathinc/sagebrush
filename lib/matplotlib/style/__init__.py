"""matplotlib.style for sagebrush: use, context, available, library.

    import matplotlib.pyplot as plt
    plt.style.use('default')
    with plt.style.context({'axes.grid': True}):
        plt.plot([1, 2, 3])

A style is a name in the library, 'default', a dict of rc settings, or a
list of these, applied in order, as matplotlib 3.11's.  The settings
Sagebrush draws are the colors, grid and line widths listed in
matplotlib._VALIDATE, the font sizes, and the figure's size, dpi and color;
a style that sets others has them kept, and says so in one warning."""

import os as _os

import matplotlib as _mpl

# the rc keys a style does not set (matplotlib 3.11.1's STYLE_BLACKLIST)
STYLE_BLACKLIST = frozenset({
    "backend", "backend_fallback", "date.epoch", "docstring.hardcopy", "figure.max_open_warning",
    "figure.raise_window", "interactive", "savefig.directory", "timezone", "tk.window_focus", "toolbar",
    "webagg.address", "webagg.open_in_browser", "webagg.port", "webagg.port_retries",
})

# name -> rc settings of each style Sagebrush has (none yet: they come with
# their data, matplotlib's .mplstyle files)
library = {}
available = []


def reload_library():
    """the library as it ships"""
    available[:] = sorted(k for k in library if not k.startswith("_"))


reload_library()


def _not_found(name):
    return OSError("%r is not a valid package style, path of style file, URL of style file, or library style name"
                   " (library styles are listed in `style.available`)" % (name,))


def _resolve(name):
    """the rc settings of a style name"""
    if name == "default":
        return {k: v for k, v in _mpl.rcParamsDefault.items() if k not in STYLE_BLACKLIST}
    if name in library:
        return library[name]
    if (_os.sep in name or name.endswith(".mplstyle")) and _os.path.exists(name):
        raise NotImplementedError("style.use(%r): Sagebrush reads no style files yet" % (name,))
    raise _not_found(name)


def use(style):
    """Use matplotlib style settings from a style specification: a style
    name, 'default', a dict of rc settings, or a list of these."""
    if isinstance(style, str) or hasattr(style, "keys"):
        styles = [style]
    else:
        styles = style
    undrawn = []
    for st in styles:
        settings = _resolve(st) if isinstance(st, str) else st
        for key, value in settings.items():
            if key in STYLE_BLACKLIST:
                _warn("Style includes a parameter, %r, that is not related to style.  Ignoring this parameter."
                      % (key,), UserWarning, stacklevel=3)
                continue
            _mpl.rcParams[key] = value
            if key not in _mpl._DRAWN and value != _mpl._defaults()[key] and key not in undrawn:
                undrawn.append(key)
    if undrawn:
        _warn("Sagebrush does not draw %d of this style's settings yet (they are kept in rcParams): %s"
              % (len(undrawn), ", ".join(sorted(undrawn))), UserWarning, stacklevel=3)


def _warn(*args, **kw):
    # (warnings and contextlib are imported when first used, not with
    # matplotlib: they would otherwise join every scientific start's code;
    # stacklevel counts this frame)
    import warnings
    warnings.warn(*args, **kw)


def context(style, after_reset=False):
    """A with-block in which a style applies; rcParams are restored after it
    exactly as they were, even after an exception."""
    import contextlib
    return contextlib.contextmanager(_context)(style, after_reset)


def _context(style, after_reset):
    orig = dict(_mpl.rcParams)
    try:
        if after_reset:
            _mpl.rcdefaults()
        use(style)
        yield
    finally:
        dict.clear(_mpl.rcParams)
        dict.update(_mpl.rcParams, orig)
