"""Sagebrush: the encodings package, as much of CPython's as its locale.py
reads (encodings.normalize_encoding and encodings.aliases.aliases).

CPython's encodings/__init__.py also registers a codec search function that
imports encodings.<name> codec modules; Sagebrush's codecs (lib/codecs.py,
the runtime's encode and decode) don't go through it, so it isn't here and
codecs' behaviour doesn't change.  normalize_encoding is CPython 3.14's,
copied unchanged (PSF License; see cdn/LICENSE-CPython.txt); aliases.py is
CPython's file, unchanged.
"""

from . import aliases


def normalize_encoding(encoding):

    """ Normalize an encoding name.

        Normalization works as follows: all non-alphanumeric
        characters except the dot used for Python package names are
        collapsed and replaced with a single underscore, e.g. '  -;#'
        becomes '_'. Leading and trailing underscores are removed.

        Note that encoding names should be ASCII only.

    """
    if isinstance(encoding, bytes):
        encoding = str(encoding, "ascii")

    chars = []
    punct = False
    for c in encoding:
        if c.isalnum() or c == '.':
            if punct and chars:
                chars.append('_')
            if c.isascii():
                chars.append(c)
            punct = False
        else:
            punct = True
    return ''.join(chars)
