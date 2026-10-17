# CPython 3.14's Lib/zoneinfo/_common.py, changed (PSF License, clause 3; see
# cdn/LICENSE-CPython.txt), each change marked "Sagebrush:":
# - load_tzdata reads the pinned tzdata (tzdata/, web/tzdata-chunks.mts) as
#   CPython reads an installed tzdata package through importlib.resources,
#   in a browser, which has no zone files; under Node there is no tzdata
#   package, as on CPython without one.
# - load_data refuses a header whose counts are past _tzrules' bounds before
#   reading what they count; _open_tzfile reads a zone file found on TZPATH
#   (open() reads a whole file at once) at most _tzrules.MAX_FILE bytes of it.
import struct

# Sagebrush: what the bounds and the pinned data need
import io as _io
import _time
import _tzrules


def load_tzdata(key):
    # Sagebrush: no importlib.resources; _tzdata_resource is what
    # resources.files(package_name).joinpath(resource_name) opens

    components = key.split("/")
    package_name = ".".join(["tzdata.zoneinfo"] + components[:-1])
    resource_name = components[-1]

    try:
        return _io.BytesIO(_tzdata_resource(package_name, resource_name))
    except (ImportError, FileNotFoundError, UnicodeEncodeError, IsADirectoryError):
        # There are four types of exception that can be raised that all amount
        # to "we cannot find this key":
        #
        # ImportError: If package_name doesn't exist (e.g. if tzdata is not
        #   installed, or if there's an error in the folder name like
        #   Amrica/New_York)
        # FileNotFoundError: If resource_name doesn't exist in the package
        #   (e.g. Europe/Krasnoy)
        # UnicodeEncodeError: If package_name or resource_name are not UTF-8,
        #   such as keys containing a surrogate character.
        # IsADirectoryError: If package_name without a resource_name specified.
        raise ZoneInfoNotFoundError(f"No time zone found with key {key}")


def load_data(fobj):
    header = _TZifHeader.from_file(fobj)

    if header.version == 1:
        time_size = 4
        time_type = "l"
    else:
        # Version 2+ has 64-bit integer transition times
        time_size = 8
        time_type = "q"

        # Version 2+ also starts with a Version 1 header and data, which
        # we need to skip now
        skip_bytes = (
            header.timecnt * 5  # Transition times and types
            + header.typecnt * 6  # Local time type records
            + header.charcnt  # Time zone designations
            + header.leapcnt * 8  # Leap second records
            + header.isstdcnt  # Standard/wall indicators
            + header.isutcnt  # UT/local indicators
        )

        fobj.seek(skip_bytes, 1)

        # Now we need to read the second header, which is not the same
        # as the first
        header = _TZifHeader.from_file(fobj)

    typecnt = header.typecnt
    timecnt = header.timecnt
    charcnt = header.charcnt

    # Sagebrush: the bounds, before anything they count is read
    for count, bound, what in ((timecnt, _tzrules.MAX_TIMES, "transitions"),
                               (typecnt, _tzrules.MAX_TYPES, "local time types"),
                               (charcnt, _tzrules.MAX_CHARS, "bytes of abbreviations")):
        if count > bound:
            raise NotImplementedError(
                f"zoneinfo: a TZif file with {count} {what} is past Sagebrush's "
                f"bound of {bound}"
            )

    # The data portion starts with timecnt transitions and indices
    if timecnt:
        trans_list_utc = struct.unpack(
            f">{timecnt}{time_type}", fobj.read(timecnt * time_size)
        )
        trans_idx = struct.unpack(f">{timecnt}B", fobj.read(timecnt))

        if max(trans_idx) >= typecnt:
            raise ValueError("Invalid transition index found while reading TZif: "
                            f"{max(trans_idx)}")
    else:
        trans_list_utc = ()
        trans_idx = ()

    # Read the ttinfo struct, (utoff, isdst, abbrind)
    if typecnt:
        utcoff, isdst, abbrind = zip(
            *(struct.unpack(">lbb", fobj.read(6)) for i in range(typecnt))
        )
    else:
        utcoff = ()
        isdst = ()
        abbrind = ()

    # Now read the abbreviations. They are null-terminated strings, indexed
    # not by position in the array but by position in the unsplit
    # abbreviation string. I suppose this makes more sense in C, which uses
    # null to terminate the strings, but it's inconvenient here...
    abbr_vals = {}
    abbr_chars = fobj.read(charcnt)

    def get_abbr(idx):
        # Gets a string starting at idx and running until the next \x00
        #
        # We cannot pre-populate abbr_vals by splitting on \x00 because there
        # are some zones that use subsets of longer abbreviations, like so:
        #
        #  LMT\x00AHST\x00HDT\x00
        #
        # Where the idx to abbr mapping should be:
        #
        # {0: "LMT", 4: "AHST", 5: "HST", 9: "HDT"}
        if idx not in abbr_vals:
            span_end = abbr_chars.find(b"\x00", idx)
            abbr_vals[idx] = abbr_chars[idx:span_end].decode()

        return abbr_vals[idx]

    abbr = tuple(get_abbr(idx) for idx in abbrind)

    # The remainder of the file consists of leap seconds (currently unused) and
    # the standard/wall and ut/local indicators, which are metadata we don't need.
    # In version 2 files, we need to skip the unnecessary data to get at the TZ string:
    if header.version >= 2:
        # Each leap second record has size (time_size + 4)
        skip_bytes = header.isutcnt + header.isstdcnt + header.leapcnt * 12
        fobj.seek(skip_bytes, 1)

        c = fobj.read(1)  # Should be \n
        assert c == b"\n", c

        line = fobj.readline()
        if not line.endswith(b"\n"):
            raise ValueError("Invalid TZif file: unexpected end of file")
        tz_str = line.rstrip(b"\n")
    else:
        tz_str = None

    return trans_idx, trans_list_utc, utcoff, isdst, abbr, tz_str


class _TZifHeader:
    __slots__ = [
        "version",
        "isutcnt",
        "isstdcnt",
        "leapcnt",
        "timecnt",
        "typecnt",
        "charcnt",
    ]

    def __init__(self, *args):
        for attr, val in zip(self.__slots__, args, strict=True):
            setattr(self, attr, val)

    @classmethod
    def from_file(cls, stream):
        # The header starts with a 4-byte "magic" value
        if stream.read(4) != b"TZif":
            raise ValueError("Invalid TZif file: magic not found")

        _version = stream.read(1)
        if _version == b"\x00":
            version = 1
        else:
            version = int(_version)
        stream.read(15)

        args = (version,)

        # Slots are defined in the order that the bytes are arranged
        args = args + struct.unpack(">6l", stream.read(24))

        return cls(*args)


class ZoneInfoNotFoundError(KeyError):
    """Exception raised when a ZoneInfo key is not found."""


# Sagebrush: reading zone files


def _open_tzfile(path):
    # (CPython opens a file found on TZPATH with io.open(path, "rb"), with its
    # errors; this reads at most MAX_FILE bytes of it, never blocking on a
    # FIFO, and refuses a larger one)
    data = _time._tzfile(path, _tzrules.MAX_FILE + 1)
    if len(data) > _tzrules.MAX_FILE:
        raise NotImplementedError(
            f"zoneinfo: {path!r} is past Sagebrush's bound of "
            f"{_tzrules.MAX_FILE} bytes for a TZif file"
        )
    return _io.BytesIO(data)


_pinned = None

# (the files of tzdata 2026.5's tzdata/zoneinfo besides its zones and its
# packages' __init__.py: present, and not TZif files)
_PINNED_OTHER_FILES = ("iso3166.tab", "leapseconds", "tzdata.zi", "zone.tab", "zone1970.tab", "zonenow.tab")


def _pinned_tree():
    # The pinned tzdata's tzdata/zoneinfo as a tree: a directory is a dict
    # (name -> directory, None for a zone file, b"" for another file), as the
    # wheel installs it,
    # every directory a package with an empty __init__.py; None where there
    # is no pinned tzdata (Node, as CPython without the tzdata package)
    global _pinned
    if _pinned is None:
        if _time._zone()[2]:
            _pinned = False
        else:
            root = {}
            for key in _time._pinned_zones():
                d = root
                *dirs, name = key.split("/")
                for part in dirs:
                    d = d.setdefault(part, {})
                d[name] = None
            for name in _PINNED_OTHER_FILES:
                root[name] = b""
            # (each package's __pycache__, which CPython writes when it
            # imports the package to look the zone up)
            stack = [root]
            while stack:
                d = stack.pop()
                stack.extend(v for v in d.values() if isinstance(v, dict))
                d["__pycache__"] = {"__init__.cpython-314.pyc": b""}
            _pinned = root
    return _pinned or None


def _tzdata_resource(package_name, resource_name):
    # The bytes resources.files(package_name).joinpath(resource_name).open("rb")
    # reads from the pinned tzdata, or what it raises: ImportError for a
    # package that is not one (tzdata itself missing, a zone file's name, a
    # name with no directory), IsADirectoryError, FileNotFoundError
    root = _pinned_tree()
    if root is None:
        raise ModuleNotFoundError("No module named 'tzdata'", name="tzdata")
    d = root
    parts = package_name.split(".")[2:]
    for i, part in enumerate(parts):
        sub = d.get(part, None) if isinstance(d, dict) else None
        if isinstance(sub, dict):
            d = sub
        elif part == "__init__" and i == len(parts) - 1:
            # (a package's __init__ module: files() is its directory)
            pass
        else:
            raise ModuleNotFoundError(
                f"No module named {'.'.join(['tzdata', 'zoneinfo'] + parts[:i + 1])!r}"
            )
    if resource_name == "__init__.py":
        return b""
    # (the file's path in the file system: a NUL is refused by open(), after
    # is_dir() said no; a lone surrogate cannot be encoded)
    for i, c in enumerate(resource_name):
        if "\ud800" <= c <= "\udfff":
            raise UnicodeEncodeError("utf-8", resource_name, i, i + 1, "surrogates not allowed")
    if "\0" in resource_name:
        raise ValueError("embedded null byte")
    if resource_name not in d:
        raise FileNotFoundError(2, "No such file or directory", resource_name)
    if isinstance(d[resource_name], dict):
        raise IsADirectoryError(21, "Is a directory", resource_name)
    if isinstance(d[resource_name], bytes):
        # (one of the files that are not zones: what load_data reads of it,
        # its first bytes, is not "TZif")
        return d[resource_name]
    data = _time._pinned("/".join(parts + [resource_name]) if not (parts and parts[-1] == "__init__")
                         else "/".join(parts[:-1] + [resource_name]))
    if data is None:
        raise FileNotFoundError(2, "No such file or directory", resource_name)
    return data
