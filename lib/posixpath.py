# CPython 3.14's Lib/posixpath.py and Lib/genericpath.py, a subset of them,
# changed (PSF License, clause 3; see cdn/LICENSE-CPython.txt), each change
# marked "Sagebrush:": the file system is asked through _fs (os has no lstat
# and no stat module here), and os.getcwdb, os.fsencode and os.fsdecode are
# this module's own. Each function takes str, bytes or an os.PathLike as
# CPython's does, os.fspath's errors for anything else, and refuses str and
# bytes together.
"""os.path for POSIX paths (a subset of CPython's posixpath)."""

import os
import _fs

# Strings representing various path-related bits and pieces.
# These are primarily for export; internally, they are hardcoded.
# Should be set before imports for resolving cyclic dependency.
curdir = '.'
pardir = '..'
extsep = '.'
sep = '/'
pathsep = ':'
defpath = '/bin:/usr/bin'
altsep = None
devnull = '/dev/null'


# Sagebrush: os.fsencode, os.fsdecode and os.getcwdb, as CPython's on Linux
# (UTF-8, surrogateescape)
def _fsencode(filename):
    filename = os.fspath(filename)
    if isinstance(filename, str):
        return filename.encode("utf-8", "surrogateescape")
    return filename


def _fsdecode(filename):
    filename = os.fspath(filename)
    if isinstance(filename, bytes):
        return filename.decode("utf-8", "surrogateescape")
    return filename


def _getcwdb():
    return _fsencode(os.getcwd())


def _check_arg_types(funcname, *args):
    hasstr = hasbytes = False
    for s in args:
        if isinstance(s, str):
            hasstr = True
        elif isinstance(s, bytes):
            hasbytes = True
        else:
            raise TypeError(f'{funcname}() argument must be str, bytes, or '
                            f'os.PathLike object, not {s.__class__.__name__!r}') from None
    if hasstr and hasbytes:
        raise TypeError("Can't mix strings and bytes in path components") from None


# Sagebrush: posix._path_normpath and posix._path_splitroot_ex, which
# CPython's normpath and splitroot are, convert their argument as C path
# arguments are converted (_fs.path: a str or bytes subclass's payload as it
# is, no method of it called; __fspath__ bound as a special method), with
# their own message
def _cpath(fname, p):
    return _fs.path(p, fname, False, False)


def _get_sep(path):
    if isinstance(path, bytes):
        return b'/'
    else:
        return '/'

# Normalize the case of a pathname.  Trivial in Posix, string.lower on Mac.
# On MS-DOS this may also turn slashes into backslashes; however, other
# normalizations (such as optimizing '../' away) are not allowed
# (another function should be defined to do that).

def normcase(s):
    """Normalize case of pathname.  Has no effect under Posix"""
    return os.fspath(s)


# Return whether a path is absolute.
# Trivial in Posix, harder on the Mac or MS-DOS.

def isabs(s):
    """Test whether a path is absolute"""
    s = os.fspath(s)
    sep = _get_sep(s)
    return s.startswith(sep)


# Join pathnames.
# Ignore the previous parts if a part is absolute.
# Insert a '/' unless the first part is empty or already ends in '/'.

def join(a, *p):
    """Join two or more pathname components, inserting '/' as needed.
    If any component is an absolute path, all previous path components
    will be discarded.  An empty last part will result in a path that
    ends with a separator."""
    a = os.fspath(a)
    sep = _get_sep(a)
    path = a
    try:
        for b in p:
            b = os.fspath(b)
            if b.startswith(sep) or not path:
                path = b
            elif path.endswith(sep):
                path += b
            else:
                path += sep + b
    except (TypeError, AttributeError, BytesWarning):
        _check_arg_types('join', a, *p)
        raise
    return path


# Split a path in head (everything up to the last '/') and tail (the
# rest).  If the path ends in '/', tail will be empty.  If there is no
# '/' in the path, head  will be empty.
# Trailing '/'es are stripped from head unless it is the root.

def split(p):
    """Split a pathname.  Returns tuple "(head, tail)" where "tail" is
    everything after the final slash.  Either part may be empty."""
    p = os.fspath(p)
    sep = _get_sep(p)
    i = p.rfind(sep) + 1
    head, tail = p[:i], p[i:]
    if head and head != sep*len(head):
        head = head.rstrip(sep)
    return head, tail


# Split a path in root and extension.
# The extension is everything starting at the last dot in the last
# pathname component; the root is everything before that.
# It is always true that root + ext == p.

def _splitext(p, sep, altsep, extsep):
    """Split the extension from a pathname.

    Extension is everything from the last dot to the end, ignoring
    leading dots.  Returns "(root, ext)"; ext may be empty."""
    # NOTE: This code must work for text and bytes strings.

    sepIndex = p.rfind(sep)
    if altsep:
        altsepIndex = p.rfind(altsep)
        sepIndex = max(sepIndex, altsepIndex)

    dotIndex = p.rfind(extsep)
    if dotIndex > sepIndex:
        # skip all leading dots
        filenameIndex = sepIndex + 1
        while filenameIndex < dotIndex:
            if p[filenameIndex:filenameIndex+1] != extsep:
                return p[:dotIndex], p[dotIndex:]
            filenameIndex += 1

    return p, p[:0]


def splitext(p):
    p = os.fspath(p)
    if isinstance(p, bytes):
        sep = b'/'
        extsep = b'.'
    else:
        sep = '/'
        extsep = '.'
    return _splitext(p, sep, None, extsep)
splitext.__doc__ = _splitext.__doc__

# Split a pathname into a drive specification and the rest of the
# path.  Useful on DOS/Windows/NT; on Unix, the drive is always empty.

def splitdrive(p):
    """Split a pathname into drive and path. On Posix, drive is always
    empty."""
    p = os.fspath(p)
    return p[:0], p


def splitroot(p):
    """Split a pathname into drive, root and tail.

    The tail contains anything after the root."""
    p = _cpath("_path_splitroot_ex", p)
    if isinstance(p, bytes):
        sep = b'/'
        empty = b''
    else:
        sep = '/'
        empty = ''
    if p[:1] != sep:
        # Relative path, e.g.: 'foo'
        return empty, empty, p
    elif p[1:2] != sep or p[2:3] == sep:
        # Absolute path, e.g.: '/foo', '///foo', '////foo', etc.
        return empty, sep, p[1:]
    else:
        # Precisely two leading slashes, e.g.: '//foo'. Implementation defined per POSIX, see
        # https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/V1_chap04.html#tag_04_13
        return empty, p[:2], p[2:]


# Return the tail (basename) part of a path, same as split(path)[1].

def basename(p):
    """Returns the final component of a pathname"""
    p = os.fspath(p)
    sep = _get_sep(p)
    i = p.rfind(sep) + 1
    return p[i:]


# Return the head (dirname) part of a path, same as split(path)[0].

def dirname(p):
    """Returns the directory component of a pathname"""
    p = os.fspath(p)
    sep = _get_sep(p)
    i = p.rfind(sep) + 1
    head = p[:i]
    if head and head != sep*len(head):
        head = head.rstrip(sep)
    return head


# Expand paths beginning with '~' or '~user'.
# '~' means $HOME; '~user' means that user's home directory.
# If the path doesn't begin with '~', or if the user or $HOME is unknown,
# the path is returned unchanged (leaving error reporting to whatever
# function is called with the expanded path as argument).

def expanduser(path):
    """Expand ~ and ~user constructions.  If user or $HOME is unknown,
    do nothing."""
    path = os.fspath(path)
    if isinstance(path, bytes):
        tilde = b'~'
    else:
        tilde = '~'
    if not path.startswith(tilde):
        return path
    sep = _get_sep(path)
    i = path.find(sep, 1)
    if i < 0:
        i = len(path)
    if i == 1:
        if 'HOME' not in os.environ:
            # Sagebrush: no pwd module, as where CPython has none
            return path
        else:
            userhome = os.environ['HOME']
    else:
        # Sagebrush: no pwd module, as where CPython has none
        return path
    if isinstance(path, bytes):
        userhome = _fsencode(userhome)
    userhome = userhome.rstrip(sep)
    return (userhome + path[i:]) or sep


# Normalize a path, e.g. A//B, A/./B and A/foo/../B all become A/B.
# It should be understood that this may change the meaning of the path
# if it contains symbolic links!

def normpath(path):
    """Normalize path, eliminating double slashes, etc."""
    path = _cpath("_path_normpath", path)
    if isinstance(path, bytes):
        sep = b'/'
        dot = b'.'
        dotdot = b'..'
    else:
        sep = '/'
        dot = '.'
        dotdot = '..'
    if not path:
        return dot
    _, initial_slashes, path = splitroot(path)
    comps = path.split(sep)
    new_comps = []
    for comp in comps:
        if not comp or comp == dot:
            continue
        if (comp != dotdot or (not initial_slashes and not new_comps) or
             (new_comps and new_comps[-1] == dotdot)):
            new_comps.append(comp)
        elif new_comps:
            new_comps.pop()
    comps = new_comps
    path = initial_slashes + sep.join(comps)
    return path or dot


def abspath(path):
    """Return an absolute path."""
    path = os.fspath(path)
    if isinstance(path, bytes):
        if not path.startswith(b'/'):
            path = join(_getcwdb(), path)
    else:
        if not path.startswith('/'):
            path = join(os.getcwd(), path)
    return normpath(path)


# Sagebrush: symbolic links are not resolved (os has no readlink here): the
# absolute path, normalized
def realpath(filename, *, strict=False):
    """Return the canonical path of the specified filename, eliminating any
symbolic links encountered in the path."""
    if strict:
        # (strict's checks of each component are not made here: astra's CORR-9C4-5)
        raise NotImplementedError("os.path.realpath(strict=...) is not supported in Sagebrush")
    return abspath(filename)


def relpath(path, start=None):
    """Return a relative version of a path"""

    path = os.fspath(path)
    if not path:
        raise ValueError("no path specified")

    if isinstance(path, bytes):
        curdir = b'.'
        sep = b'/'
        pardir = b'..'
    else:
        curdir = '.'
        sep = '/'
        pardir = '..'

    if start is None:
        start = curdir
    else:
        start = os.fspath(start)

    try:
        start_tail = abspath(start).lstrip(sep)
        path_tail = abspath(path).lstrip(sep)
        start_list = start_tail.split(sep) if start_tail else []
        path_list = path_tail.split(sep) if path_tail else []
        # Work out how much of the filepath is shared by start and path.
        i = len(commonprefix([start_list, path_list]))

        rel_list = [pardir] * (len(start_list)-i) + path_list[i:]
        if not rel_list:
            return curdir
        return sep.join(rel_list)
    except (TypeError, AttributeError, BytesWarning, DeprecationWarning):
        _check_arg_types('relpath', path, start)
        raise


# Return the longest common sub-path of the sequence of paths given as input.
# The paths are not normalized before comparing them (this is the
# responsibility of the caller). Any trailing separator is stripped from the
# returned path.

def commonpath(paths):
    """Given a sequence of path names, returns the longest common sub-path."""

    paths = tuple(map(os.fspath, paths))

    if not paths:
        raise ValueError('commonpath() arg is an empty sequence')

    if isinstance(paths[0], bytes):
        sep = b'/'
        curdir = b'.'
    else:
        sep = '/'
        curdir = '.'

    try:
        split_paths = [path.split(sep) for path in paths]

        try:
            isabs, = {p.startswith(sep) for p in paths}
        except ValueError:
            raise ValueError("Can't mix absolute and relative paths") from None

        split_paths = [[c for c in s if c and c != curdir] for s in split_paths]
        s1 = min(split_paths)
        s2 = max(split_paths)
        common = s1
        for i, c in enumerate(s1):
            if c != s2[i]:
                common = s1[:i]
                break

        prefix = sep if isabs else sep[:0]
        return prefix + sep.join(common)
    except (TypeError, AttributeError):
        _check_arg_types('commonpath', *paths)
        raise


# Return the longest prefix of all list elements.
def commonprefix(m):
    "Given a list of pathnames, returns the longest common leading component"
    if not m: return ''
    # Some people pass in a list of pathname parts to operate in an OS-agnostic
    # fashion; don't try to translate in that case as that's an abuse of the
    # API and they are already doing what they need to be OS-agnostic and so
    # they most likely won't be using an os.PathLike object in the sublists.
    if not isinstance(m[0], (list, tuple)):
        m = tuple(map(os.fspath, m))
    s1 = min(m)
    s2 = max(m)
    for i, c in enumerate(s1):
        if c != s2[i]:
            return s1[:i]
    return s1


# The file system's answers (genericpath's, through os.stat and os.lstat in
# CPython: a path that cannot be asked about, an embedded NUL included, is
# not there). Sagebrush: through _fs, with the path as str.

def _ask(f, path, call):
    # (call: "stat", which takes a file descriptor too, or "lstat". The path
    # converted as theirs (_fs.path), inside genericpath's boundary: OSError
    # and ValueError mean False, as from stat itself)
    try:
        path = _fs.path(path, call, call == "stat", True)
    except (OSError, ValueError):
        return False
    if isinstance(path, int):
        if path < 0:
            # (stat of a negative descriptor: EBADF, an OSError)
            return False
        raise NotImplementedError("os.path functions of a file descriptor are not supported in Sagebrush")
    path = _fsdecode(path)
    for c in path:
        if "\udc80" <= c <= "\udcff":
            # (a byte of a name that is not UTF-8: _fs takes paths as text)
            raise NotImplementedError("os.path functions of a file name that is not UTF-8 are not supported in Sagebrush")
    return f(path)


def exists(path):
    """Test whether a path exists.  Returns False for broken symbolic links"""
    return _ask(_fs.exists, path, "stat")


def lexists(path):
    """Test whether a path exists.  Returns True for broken symbolic links"""
    return _ask(_fs.lexists, path, "lstat")


def isfile(path):
    """Test whether a path is a regular file"""
    return _ask(_fs.isfile, path, "stat")


def isdir(s):
    """Return true if the pathname refers to an existing directory."""
    return _ask(_fs.isdir, s, "stat")


def islink(path):
    """Test whether a path is a symbolic link"""
    return _ask(_fs.islink, path, "lstat")


def getsize(filename):
    """Return the size of a file, reported by os.stat()."""
    return os.stat(filename).st_size
