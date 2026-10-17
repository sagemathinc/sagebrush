# CPython 3.14's Lib/zoneinfo/_tzpath.py, changed (PSF License, clause 3; see
# cdn/LICENSE-CPython.txt), each change marked "Sagebrush:": the compiled-in
# TZPATH is CPython's on the reference Linux host under Node, and empty in a
# browser (which has no zone files: the pinned tzdata is its tzdata package,
# zoneinfo/_common.py); os.walk is _walk here; the pinned tzdata lists its
# zones as the tzdata package's zones file does.
import os

# Sagebrush: no sysconfig; what the zone files are read through
import _time

# Sagebrush: sysconfig.get_config_var("TZPATH") of CPython 3.14 on Linux
_CONFIG_TZPATH = "/usr/share/zoneinfo:/usr/lib/zoneinfo:/usr/share/lib/zoneinfo:/etc/zoneinfo"


def _reset_tzpath(to=None, stacklevel=4):
    global TZPATH

    tzpaths = to
    if tzpaths is not None:
        if isinstance(tzpaths, (str, bytes)):
            raise TypeError(
                f"tzpaths must be a list or tuple, "
                + f"not {type(tzpaths)}: {tzpaths!r}"
            )

        tzpaths = [os.fspath(p) for p in tzpaths]
        if not all(isinstance(p, str) for p in tzpaths):
            raise TypeError(
                "All elements of a tzpath sequence must be strings or "
                "os.PathLike objects which convert to strings."
            )

        if not all(map(os.path.isabs, tzpaths)):
            raise ValueError(_get_invalid_paths_message(tzpaths))
        base_tzpath = tzpaths
    else:
        env_var = os.environ.get("PYTHONTZPATH", None)
        if env_var is None:
            # Sagebrush: none in a browser
            env_var = _CONFIG_TZPATH if _time._zone()[2] else ""
        base_tzpath = _parse_python_tzpath(env_var, stacklevel)

    TZPATH = tuple(base_tzpath)


def reset_tzpath(to=None):
    """Reset global TZPATH."""
    # We need `_reset_tzpath` helper function because it produces a warning,
    # it is used as both a module-level call and a public API.
    # This is how we equalize the stacklevel for both calls.
    _reset_tzpath(to)


def _parse_python_tzpath(env_var, stacklevel):
    if not env_var:
        return ()

    raw_tzpath = env_var.split(os.pathsep)
    new_tzpath = tuple(filter(os.path.isabs, raw_tzpath))

    # If anything has been filtered out, we will warn about it
    if len(new_tzpath) != len(raw_tzpath):
        import warnings

        msg = _get_invalid_paths_message(raw_tzpath)

        warnings.warn(
            "Invalid paths specified in PYTHONTZPATH environment variable. "
            + msg,
            InvalidTZPathWarning,
            stacklevel=stacklevel,
        )

    return new_tzpath


def _get_invalid_paths_message(tzpaths):
    invalid_paths = (path for path in tzpaths if not os.path.isabs(path))

    prefix = "\n    "
    indented_str = prefix + prefix.join(invalid_paths)

    return (
        "Paths should be absolute but found the following relative paths:"
        + indented_str
    )


def find_tzfile(key):
    """Retrieve the path to a TZif file from a key."""
    _validate_tzfile_path(key)
    for search_path in TZPATH:
        filepath = os.path.join(search_path, key)
        if os.path.isfile(filepath):
            return filepath

    return None


_TEST_PATH = os.path.normpath(os.path.join("_", "_"))[:-1]


def _validate_tzfile_path(path, _base=_TEST_PATH):
    if os.path.isabs(path):
        raise ValueError(
            f"ZoneInfo keys may not be absolute paths, got: {path}"
        )

    # We only care about the kinds of path normalizations that would change the
    # length of the key - e.g. a/../b -> a/b, or a/b/ -> a/b. On Windows,
    # normpath will also change from a/b to a\b, but that would still preserve
    # the length.
    new_path = os.path.normpath(path)
    if len(new_path) != len(path):
        raise ValueError(
            f"ZoneInfo keys must be normalized relative paths, got: {path}"
        )

    resolved = os.path.normpath(os.path.join(_base, new_path))
    if not resolved.startswith(_base):
        raise ValueError(
            f"ZoneInfo keys must refer to subdirectories of TZPATH, got: {path}"
        )


del _TEST_PATH


def available_timezones():
    """Returns a set containing all available time zones.

    .. caution::

        This may attempt to open a large number of files, since the best way to
        determine if a given file on the time zone search path is to open it
        and check for the "magic string" at the beginning.
    """
    valid_zones = set()

    # Start with loading from the tzdata package if it exists: this has a
    # pre-assembled list of zones that only requires opening one file.
    # (Sagebrush: the pinned tzdata's, in a browser)
    if not _time._zone()[2]:
        valid_zones.update(_time._pinned_zones())

    def valid_key(fpath):
        # (Sagebrush: open() reads a whole file: the first 4 bytes only,
        # never blocking on a FIFO)
        try:
            return _time._tzfile(fpath, 4) == b"TZif"
        except Exception:  # pragma: nocover
            return False

    # Sagebrush: the walk has a budget of names and one of characters, across
    # all of TZPATH and the keys it keeps
    budget = [_MAX_ENTRIES, _MAX_CHARS]
    for tz_root in TZPATH:
        # (Sagebrush: each root spends a name and its characters before it
        # is looked at, so that a TZPATH of many empty or missing roots is
        # bounded too: daybreak2's HARD-TZB-2)
        _spend_names(budget, 1)
        _spend(budget, len(tz_root))
        if not os.path.exists(tz_root):
            continue

        for root, dirnames, files in _walk(tz_root, budget):
            if root == tz_root:
                # right/ and posix/ are special directories and shouldn't be
                # included in the output of available zones
                if "right" in dirnames:
                    dirnames.remove("right")
                if "posix" in dirnames:
                    dirnames.remove("posix")

            for file in files:
                fpath = os.path.join(root, file)

                key = os.path.relpath(fpath, start=tz_root)
                if os.sep != "/":  # pragma: nocover
                    key = key.replace(os.sep, "/")

                if not key or key in valid_zones:
                    continue

                if valid_key(fpath):
                    # (Sagebrush: each key kept spends its characters)
                    _spend(budget, len(key))
                    valid_zones.add(key)

    if "posixrules" in valid_zones:
        # posixrules is a special symlink-only time zone where it exists, it
        # should not be included in the output
        valid_zones.remove("posixrules")

    return valid_zones


# Sagebrush: the most names available_timezones walks through on TZPATH, a
# path a user may choose; past them it refuses, rather than read a tree of
# any size (the host's /usr/share/zoneinfo has about 2000)
_MAX_ENTRIES = 1 << 16
# (and the most characters the walk keeps: the names it lists, the paths of
# the directories it has yet to walk and the keys it returns; daybreak2's
# HARD-TZB-1: 65536 keys near PATH_MAX each are a quarter of a billion)
_MAX_CHARS = 1 << 21


def _spend_names(budget, n):
    if n > budget[0]:
        raise NotImplementedError(
            f"zoneinfo: available_timezones() past Sagebrush's bound of "
            f"{_MAX_ENTRIES} names on TZPATH"
        )
    budget[0] -= n


def _spend(budget, chars):
    if chars > budget[1]:
        raise NotImplementedError(
            f"zoneinfo: available_timezones() past Sagebrush's bound of "
            f"{_MAX_CHARS} characters of names on TZPATH"
        )
    budget[1] -= chars


def _walk(top, budget):
    # Sagebrush: os has no walk. os.walk(top)'s top-down walk: directories
    # (symbolic links to them included) apart from the other names, those
    # the caller leaves in dirnames walked into unless they are symbolic
    # links, a directory that cannot be listed skipped. Each directory is
    # listed at most budget[0] + 1 names at a time, and each name spends one
    # of budget[0]: past it, the walk is refused.
    stack = [top]
    while stack:
        root = stack.pop()
        try:
            names = _time._zonedir(root, budget[0] + 1, budget[1])
        except OSError:
            continue
        if names is None:
            # (the names would cross the characters left)
            _spend(budget, budget[1] + 1)
        _spend(budget, sum(map(len, names)))
        _spend_names(budget, len(names))
        dirnames, files = [], []
        for name in names:
            (dirnames if os.path.isdir(os.path.join(root, name)) else files).append(name)
        yield root, dirnames, files
        for name in reversed(dirnames):
            path = os.path.join(root, name)
            if not os.path.islink(path):
                # (a directory yet to walk keeps its whole path)
                _spend(budget, len(path))
                stack.append(path)


class InvalidTZPathWarning(RuntimeWarning):
    """Warning raised if an invalid path is specified in PYTHONTZPATH."""


TZPATH = ()
_reset_tzpath(stacklevel=5)
