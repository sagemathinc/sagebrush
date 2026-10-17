# Ported from CPython 3.14 Objects/stringlib/unicode_format.h, the C module _string (PSF License; see cdn/LICENSE-CPython.txt).
"""CPython's _string module (a C module there), in Python: the parsers that
string.Formatter is built on (lib/string/__init__.py, CPython 3.14's own).

    formatter_parser(s)            (literal_text, field_name, format_spec, conversion) per piece
    formatter_field_name_split(f)  (first, iterator of (is_attribute, key))

They follow CPython's state machines step for step (Objects/stringlib/
unicode_format.h: MarkupIterator_next, parse_field, field_name_split,
FieldNameIterator_next), so their results, and which error comes first, are
CPython's: checked against CPython 3.14's _string on every string of a
small alphabet up to length 5 and 200,000 longer ones; CI compares a
digest of every string up to length 4 and 3,000 longer ones
(test/_string_cases.py).
"""

_MAXSIZE = 9223372036854775807


def _digit(ch):
    # (a decimal digit's value: Unicode's decimal digits come in runs of ten,
    # 0 to 9, so it is its place in its run; not int(ch), which takes only
    # ASCII digits here)
    k = ord(ch)
    start = k
    while start > 0 and chr(start - 1).isdecimal():
        start -= 1
    return (k - start) % 10


def _get_integer(s):
    # (a decimal number, any Unicode digits: an int; else -1; past
    # Py_ssize_t, a ValueError, as get_integer)
    if not s:
        return -1
    acc = 0
    for ch in s:
        if not ch.isdecimal():
            return -1
        d = _digit(ch)
        if acc > (_MAXSIZE - d) // 10:
            raise ValueError("Too many decimal digits in format string")
        acc = acc * 10 + d
    return acc


def formatter_parser(format_string, /):
    if not isinstance(format_string, str):
        raise TypeError("expected str, got %s" % type(format_string).__name__)
    # (the string's own characters, as the C code reads the payload: a str
    # subclass's __len__, __getitem__, __iter__ or __str__ is not read,
    # astra's CORR-484-1; str.join copies them, exactly a str)
    return _markup("".join((format_string,)))


def _markup(s):
    end = len(s)
    pos = 0
    while pos < end:
        start = pos
        c = ""
        markup = False
        while pos < end:
            c = s[pos]
            pos += 1
            if c == "{" or c == "}":
                markup = True
                break
        at_end = pos >= end
        length = pos - start
        if c == "}" and markup and (at_end or s[pos] != c):
            raise ValueError("Single '}' encountered in format string")
        if at_end and markup and c == "{":
            raise ValueError("Single '{' encountered in format string")
        if not at_end and markup:
            if s[pos] == c:
                # (an escaped brace: no field follows this literal text)
                pos += 1
                markup = False
            else:
                length -= 1
        literal = s[start:start + length]
        if not markup:
            yield (literal, None, None, None)
            continue
        name, spec, conv, pos = _parse_field(s, pos, end)
        yield (literal, name, spec, conv)


def _parse_field(s, pos, end):
    c = ""
    name_start = pos
    while pos < end:
        c = s[pos]
        pos += 1
        if c == "{":
            raise ValueError("unexpected '{' in field name")
        if c == "[":
            while pos < end and s[pos] != "]":
                pos += 1
            continue
        if c in "}:!":
            break
    name = s[name_start:pos - 1]
    conv = None
    if c == "!" or c == ":":
        if c == "!":
            if pos >= end:
                raise ValueError("end of string while looking for conversion specifier")
            conv = s[pos]
            pos += 1
            if pos < end:
                c = s[pos]
                pos += 1
                if c == "}":
                    return name, "", conv, pos
                if c != ":":
                    raise ValueError("expected ':' after conversion specifier")
        spec_start = pos
        count = 1
        while pos < end:
            c = s[pos]
            pos += 1
            if c == "{":
                count += 1
            elif c == "}":
                count -= 1
                if count == 0:
                    return name, s[spec_start:pos - 1], conv, pos
        raise ValueError("unmatched '{' in format spec")
    if c != "}":
        raise ValueError("expected '}' before end of string")
    return name, "", conv, pos


def formatter_field_name_split(field_name, /):
    if not isinstance(field_name, str):
        raise TypeError("expected str, got %s" % type(field_name).__name__)
    field_name = "".join((field_name,))
    end = len(field_name)
    i = 0
    while i < end and field_name[i] not in ".[":
        i += 1
    first = field_name[:i]
    idx = _get_integer(first)
    return (idx if idx != -1 else first), _rest(field_name, i, end)


def _rest(s, pos, end):
    while pos < end:
        c = s[pos]
        pos += 1
        if c == ".":
            start = pos
            while pos < end and s[pos] not in ".[":
                pos += 1
            name = s[start:pos]
            is_attr = True
            key = name
        elif c == "[":
            start = pos
            seen = False
            while pos < end:
                ch = s[pos]
                pos += 1
                if ch == "]":
                    seen = True
                    break
            if not seen:
                raise ValueError("Missing ']' in format string")
            name = s[start:pos - 1]
            is_attr = False
            idx = _get_integer(name)
            key = idx if idx != -1 else name
        else:
            raise ValueError("Only '.' or '[' may follow ']' in format field specifier")
        if name == "":
            raise ValueError("Empty attribute in format string")
        yield (is_attr, key)
