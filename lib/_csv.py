# Ported from CPython 3.14 Modules/_csv.c, the C module _csv (PSF License; see cdn/LICENSE-CPython.txt).
"""CSV parsing and writing.
"""

# (each function names the C function it ports; a character is a str of
# length 1, _NOT_SET is None, and _EOL, the end of an input line, is "")
_NOT_SET = None
_EOL = ""

QUOTE_MINIMAL, QUOTE_ALL, QUOTE_NONNUMERIC, QUOTE_NONE, QUOTE_STRINGS, QUOTE_NOTNULL = range(6)

(_START_RECORD, _START_FIELD, _ESCAPED_CHAR, _IN_FIELD, _IN_QUOTED_FIELD,
 _ESCAPE_IN_QUOTED_FIELD, _QUOTE_IN_QUOTED_FIELD, _EAT_CRNL, _AFTER_ESCAPED_CRNL) = range(9)

_INT_MAX = 2**31 - 1
_SSIZE_MAX = 2**63 - 1


class Error(Exception):
    __module__ = "_csv"


_dialects = {}
_field_limit = 128 * 1024


def _tname(o):
    # (%T: the type's fully qualified name, without builtins or __main__)
    t = type(o)
    m = t.__module__
    return t.__qualname__ if m in ("builtins", "__main__") else m + "." + t.__qualname__


def _plain(s):
    # (a str subclass's characters, as C reads them: not its methods)
    return s if type(s) is str else str.__str__(s)


def _get_dialect_from_registry(name):
    try:
        return _dialects[name]
    except KeyError:
        raise Error("unknown dialect") from None


def _set_bool(name, src, dflt):
    return dflt if src is _NULL else bool(src)


def _set_int(name, src, dflt):
    if src is _NULL:
        return dflt
    if type(src) is not int:
        raise TypeError(f'"{name}" must be an integer, not {_tname(src)}')
    if not -_INT_MAX - 1 <= src <= _INT_MAX:
        raise OverflowError("Python int too large to convert to C int")
    return src


def _set_char_or_none(name, src, dflt):
    if src is _NULL:
        return dflt
    if src is None:
        return _NOT_SET
    if not isinstance(src, str):
        raise TypeError(f'"{name}" must be a unicode character or None, not {_tname(src)}')
    src = _plain(src)
    if len(src) != 1:
        raise TypeError(f'"{name}" must be a unicode character or None, not a string of length {len(src)}')
    return src


def _set_char(name, src, dflt):
    if src is _NULL:
        return dflt
    if not isinstance(src, str):
        raise TypeError(f'"{name}" must be a unicode character, not {_tname(src)}')
    src = _plain(src)
    if len(src) != 1:
        raise TypeError(f'"{name}" must be a unicode character, not a string of length {len(src)}')
    return src


def _set_str(name, src, dflt):
    if src is _NULL:
        return dflt
    if not isinstance(src, str):
        raise TypeError(f'"{name}" must be a string, not {_tname(src)}')
    return src


def _dialect_check_char(name, c, lineterminator, allowspace):
    if c == "\r" or c == "\n" or (c == " " and not allowspace):
        raise ValueError(f"bad {name} value")
    if c is not _NOT_SET and c in _plain(lineterminator):
        raise ValueError(f"bad {name} or lineterminator value")


def _dialect_check_chars(name1, name2, c1, c2):
    if c1 == c2 and c1 is not _NOT_SET:
        raise ValueError(f"bad {name1} or {name2} value")


class _Null:
    __slots__ = ()


_NULL = _Null()  # (an argument not given: C's NULL)

_DIALECT_KWS = ("dialect", "delimiter", "doublequote", "escapechar", "lineterminator",
                "quotechar", "quoting", "skipinitialspace", "strict")


def _parse_dialect_args(args, kwargs):
    # (PyArg_ParseTupleAndKeywords(args, kwargs, "|OOOOOOOOO", dialect_kws))
    if len(args) > 9:
        raise TypeError(f"function takes at most 9 arguments ({len(args) + len(kwargs)} given)")
    vals = list(args) + [_NULL] * (9 - len(args))
    for k, v in kwargs.items():
        try:
            i = _DIALECT_KWS.index(k)
        except ValueError:
            raise TypeError(f"this function got an unexpected keyword argument '{k}'") from None
        if i < len(args):
            raise TypeError(f"argument for function given by name ('{k}') and position ({i + 1})")
        vals[i] = v
    return vals


class Dialect:
    """CSV dialect

The Dialect type records CSV parsing and generation options.
"""
    __module__ = "_csv"
    __slots__ = ("_doublequote", "_skipinitialspace", "_strict", "_quoting",
                 "_delimiter", "_quotechar", "_escapechar", "_lineterminator")

    def __new__(cls, *args, **kwargs):
        # (dialect_new)
        (dialect, delimiter, doublequote, escapechar, lineterminator, quotechar,
         quoting, skipinitialspace, strict) = _parse_dialect_args(args, kwargs)
        if dialect is not _NULL:
            if isinstance(dialect, str):
                dialect = _get_dialect_from_registry(dialect)
            # (can we reuse this instance?)
            if (isinstance(dialect, Dialect) and delimiter is _NULL and doublequote is _NULL
                    and escapechar is _NULL and lineterminator is _NULL and quotechar is _NULL
                    and quoting is _NULL and skipinitialspace is _NULL and strict is _NULL):
                return dialect
        self = object.__new__(cls)
        if dialect is not _NULL:
            def getattr_(v, n):
                if v is not _NULL:
                    return v
                try:
                    return getattr(dialect, n)
                except Exception:
                    return _NULL
            delimiter = getattr_(delimiter, "delimiter")
            doublequote = getattr_(doublequote, "doublequote")
            escapechar = getattr_(escapechar, "escapechar")
            lineterminator = getattr_(lineterminator, "lineterminator")
            quotechar = getattr_(quotechar, "quotechar")
            quoting = getattr_(quoting, "quoting")
            skipinitialspace = getattr_(skipinitialspace, "skipinitialspace")
            strict = getattr_(strict, "strict")
        # (check types and convert to C values)
        d_delimiter = _set_char("delimiter", delimiter, ",")
        d_doublequote = _set_bool("doublequote", doublequote, True)
        d_escapechar = _set_char_or_none("escapechar", escapechar, _NOT_SET)
        d_lineterminator = _set_str("lineterminator", lineterminator, "\r\n")
        d_quotechar = _set_char_or_none("quotechar", quotechar, '"')
        d_quoting = _set_int("quoting", quoting, QUOTE_MINIMAL)
        d_skipinitialspace = _set_bool("skipinitialspace", skipinitialspace, False)
        d_strict = _set_bool("strict", strict, False)
        # (validate options)
        if not 0 <= d_quoting <= QUOTE_NOTNULL:
            raise TypeError('bad "quoting" value')
        if quotechar is None and quoting is _NULL:
            d_quoting = QUOTE_NONE
        if d_quoting != QUOTE_NONE and d_quotechar is _NOT_SET:
            raise TypeError("quotechar must be set if quoting enabled")
        _dialect_check_char("delimiter", d_delimiter, d_lineterminator, True)
        _dialect_check_char("escapechar", d_escapechar, d_lineterminator, not d_skipinitialspace)
        _dialect_check_char("quotechar", d_quotechar, d_lineterminator, not d_skipinitialspace)
        _dialect_check_chars("delimiter", "escapechar", d_delimiter, d_escapechar)
        _dialect_check_chars("delimiter", "quotechar", d_delimiter, d_quotechar)
        _dialect_check_chars("escapechar", "quotechar", d_escapechar, d_quotechar)
        set_ = object.__setattr__
        set_(self, "_delimiter", d_delimiter)
        set_(self, "_doublequote", d_doublequote)
        set_(self, "_escapechar", d_escapechar)
        set_(self, "_lineterminator", d_lineterminator)
        set_(self, "_quotechar", d_quotechar)
        set_(self, "_quoting", d_quoting)
        set_(self, "_skipinitialspace", d_skipinitialspace)
        set_(self, "_strict", d_strict)
        return self

    delimiter = property(lambda self: self._delimiter)
    escapechar = property(lambda self: self._escapechar)
    lineterminator = property(lambda self: self._lineterminator)
    quotechar = property(lambda self: self._quotechar)
    quoting = property(lambda self: self._quoting)
    skipinitialspace = property(lambda self: self._skipinitialspace)
    doublequote = property(lambda self: self._doublequote)
    strict = property(lambda self: self._strict)

    def __setattr__(self, name, value):
        if name in ("skipinitialspace", "doublequote", "strict"):
            raise AttributeError("readonly attribute")
        if name in ("delimiter", "escapechar", "lineterminator", "quotechar", "quoting"):
            raise AttributeError(f"attribute '{name}' of '_csv.Dialect' objects is not writable")
        object.__setattr__(self, name, value)

    def __reduce__(self, *args):
        raise TypeError(f"cannot pickle '{type(self).__name__}' instances")

    __reduce_ex__ = __reduce__


def _call_dialect(dialect_inst, kwargs):
    if dialect_inst is not _NULL:
        return Dialect(dialect_inst, **kwargs)
    return Dialect(**kwargs)


def _unpack(name, args, lo, hi):
    # (PyArg_UnpackTuple)
    n = len(args)
    if n < lo:
        raise TypeError(f"{name} expected at least {lo} argument{'s' if lo != 1 else ''}, got {n}")
    if n > hi:
        raise TypeError(f"{name} expected at most {hi} argument{'s' if hi != 1 else ''}, got {n}")
    return list(args) + [_NULL] * (hi - n)


def _readonly(name):
    def set_(self, value=None):
        raise AttributeError("readonly attribute")
    return property(lambda self: getattr(self, name), set_, set_)


class reader:
    """CSV reader

Reader objects are responsible for reading and parsing tabular data
in CSV format.
"""
    __module__ = "_csv"

    def __new__(cls, *args, **kwargs):
        raise TypeError("cannot create '_csv.reader' instances")

    dialect = _readonly("_dialect")
    line_num = _readonly("_line_num")

    def _reset(self):
        # (parse_reset)
        self._fields = []
        self._field = []
        self._state = _START_RECORD
        self._unquoted_field = False

    def _save_field(self):
        # (parse_save_field)
        quoting = self._dialect._quoting
        if self._unquoted_field and not self._field and (quoting == QUOTE_NOTNULL or quoting == QUOTE_STRINGS):
            field = None
        else:
            field = "".join(self._field)
            if self._unquoted_field and self._field and (quoting == QUOTE_NONNUMERIC or quoting == QUOTE_STRINGS):
                field = float(field)
            self._field = []
        self._fields.append(field)

    def _add_char(self, c):
        # (parse_add_char)
        if len(self._field) >= _field_limit:
            raise Error(f"field larger than field limit ({_field_limit})")
        self._field.append(c)

    def _process_char(self, c):
        # (parse_process_char)
        d = self._dialect
        state = self._state
        if state == _START_RECORD:
            # (start of record)
            if c == _EOL:
                # (empty line: return [])
                return
            elif c == "\n" or c == "\r":
                self._state = _EAT_CRNL
                return
            # (normal character: handle as _START_FIELD)
            self._state = state = _START_FIELD
        if state == _START_FIELD:
            # (expecting field)
            self._unquoted_field = True
            if c == "\n" or c == "\r" or c == _EOL:
                # (save empty field: return [fields])
                self._save_field()
                self._state = _START_RECORD if c == _EOL else _EAT_CRNL
            elif c == d._quotechar and d._quoting != QUOTE_NONE:
                # (start quoted field)
                self._unquoted_field = False
                self._state = _IN_QUOTED_FIELD
            elif c == d._escapechar:
                # (possible escaped character)
                self._state = _ESCAPED_CHAR
            elif c == " " and d._skipinitialspace:
                # (ignore spaces at start of field)
                pass
            elif c == d._delimiter:
                # (save empty field)
                self._save_field()
            else:
                # (begin new unquoted field)
                self._add_char(c)
                self._state = _IN_FIELD
        elif state == _ESCAPED_CHAR:
            if c == "\n" or c == "\r":
                self._add_char(c)
                self._state = _AFTER_ESCAPED_CRNL
                return
            if c == _EOL:
                c = "\n"
            self._add_char(c)
            self._state = _IN_FIELD
        elif state == _IN_FIELD or state == _AFTER_ESCAPED_CRNL:
            if state == _AFTER_ESCAPED_CRNL and c == _EOL:
                return
            # (in unquoted field)
            if c == "\n" or c == "\r" or c == _EOL:
                # (end of line: return [fields])
                self._save_field()
                self._state = _START_RECORD if c == _EOL else _EAT_CRNL
            elif c == d._escapechar:
                # (possible escaped character)
                self._state = _ESCAPED_CHAR
            elif c == d._delimiter:
                # (save field: wait for new field)
                self._save_field()
                self._state = _START_FIELD
            else:
                # (normal character: save in field)
                self._add_char(c)
        elif state == _IN_QUOTED_FIELD:
            # (in quoted field)
            if c == _EOL:
                pass
            elif c == d._escapechar:
                # (possible escape character)
                self._state = _ESCAPE_IN_QUOTED_FIELD
            elif c == d._quotechar and d._quoting != QUOTE_NONE:
                if d._doublequote:
                    # (doublequote; " represented by "")
                    self._state = _QUOTE_IN_QUOTED_FIELD
                else:
                    # (end of quote part of field)
                    self._state = _IN_FIELD
            else:
                # (normal character: save in field)
                self._add_char(c)
        elif state == _ESCAPE_IN_QUOTED_FIELD:
            if c == _EOL:
                c = "\n"
            self._add_char(c)
            self._state = _IN_QUOTED_FIELD
        elif state == _QUOTE_IN_QUOTED_FIELD:
            # (doublequote: seen a quote in a quoted field)
            if d._quoting != QUOTE_NONE and c == d._quotechar:
                # (save "" as ")
                self._add_char(c)
                self._state = _IN_QUOTED_FIELD
            elif c == d._delimiter:
                # (save field: wait for new field)
                self._save_field()
                self._state = _START_FIELD
            elif c == "\n" or c == "\r" or c == _EOL:
                # (end of line: return [fields])
                self._save_field()
                self._state = _START_RECORD if c == _EOL else _EAT_CRNL
            elif not d._strict:
                self._add_char(c)
                self._state = _IN_FIELD
            else:
                # (illegal)
                raise Error(f"'{d._delimiter}' expected after '{d._quotechar}'")
        elif state == _EAT_CRNL:
            if c == "\n" or c == "\r":
                pass
            elif c == _EOL:
                self._state = _START_RECORD
            else:
                raise Error("new-line character seen in unquoted field - "
                            "do you need to open the file with newline=''?")

    def __iter__(self):
        return self

    def __next__(self):
        # (Reader_iternext)
        self._reset()
        while True:
            try:
                line = next(self._input_iter)
            except StopIteration:
                # (end of input)
                if self._field or self._state == _IN_QUOTED_FIELD:
                    if self._dialect._strict:
                        raise Error("unexpected end of data") from None
                    self._save_field()
                    break
                raise
            if not isinstance(line, str):
                raise Error(f"iterator should return strings, not {type(line).__name__[:200]} "
                            "(the file should be opened in text mode)")
            if self._fields is None:
                raise Error("iterator has already advanced the reader")
            self._line_num += 1
            for c in _plain(line):
                self._process_char(c)
            self._process_char(_EOL)
            if self._state == _START_RECORD:
                break
        fields = self._fields
        self._fields = None
        return fields


Reader = reader


class writer:
    """CSV writer

Writer objects are responsible for generating tabular data
in CSV format from sequence input.
"""
    __module__ = "_csv"

    def __new__(cls, *args, **kwargs):
        raise TypeError("cannot create '_csv.writer' instances")

    dialect = _readonly("_dialect")

    def _append(self, rec, field, quoted):
        # (join_append and join_append_data: the field, its delimiter, its
        # quotes and escapes, appended to rec)
        d = self._dialect
        if not field and d._delimiter == " " and d._skipinitialspace:
            if d._quoting == QUOTE_NONE or (field is None and (d._quoting == QUOTE_STRINGS or d._quoting == QUOTE_NOTNULL)):
                raise Error("empty field must be quoted if delimiter is a space "
                            "and skipinitialspace is true")
            quoted = 1
        out = field or ""
        special = (d._delimiter, d._escapechar, d._quotechar, "\n", "\r")
        lt = _plain(d._lineterminator)
        if out and any((c is not None and c in out) for c in special) or any(c in out for c in lt):
            chars = []
            for c in out:
                want_escape = False
                if c == d._delimiter or c == d._escapechar or c == d._quotechar or c == "\n" or c == "\r" or c in lt:
                    if d._quoting == QUOTE_NONE:
                        want_escape = True
                    else:
                        if c == d._quotechar:
                            if d._doublequote:
                                chars.append(d._quotechar)
                            else:
                                want_escape = True
                        elif c == d._escapechar:
                            want_escape = True
                        if not want_escape:
                            quoted = 1
                    if want_escape:
                        if d._escapechar is _NOT_SET:
                            raise Error("need to escape, but no escapechar set")
                        chars.append(d._escapechar)
                chars.append(c)
            out = "".join(chars)
        if rec:
            rec.append(d._delimiter)
        if quoted:
            out = d._quotechar + out + d._quotechar
        rec.append(out)

    def writerow(self, row, /):
        """Construct and write a CSV record from an iterable of fields.

Non-string elements will be converted to string."""
        # (csv_writerow)
        d = self._dialect
        try:
            it = iter(row)
            failed = False
        except TypeError:
            failed = True
        if failed:
            raise Error(f"iterable expected, not {type(row).__name__[:200]}")
        rec = []
        null_field = False
        quoting = d._quoting
        for field in it:
            if quoting == QUOTE_NONNUMERIC:
                t = type(field)
                quoted = not (hasattr(t, "__index__") or hasattr(t, "__int__") or hasattr(t, "__float__")
                              or isinstance(field, complex))
            elif quoting == QUOTE_ALL:
                quoted = 1
            elif quoting == QUOTE_STRINGS:
                quoted = isinstance(field, str)
            elif quoting == QUOTE_NOTNULL:
                quoted = field is not None
            else:
                quoted = 0
            null_field = field is None
            if isinstance(field, str):
                self._append(rec, _plain(field), quoted)
            elif null_field:
                self._append(rec, None, quoted)
            else:
                self._append(rec, str(field), quoted)
        if len(rec) == 1 and not rec[0]:
            if quoting == QUOTE_NONE or (null_field and (quoting == QUOTE_STRINGS or quoting == QUOTE_NOTNULL)):
                raise Error("single empty field record must be quoted")
            rec = []
            self._append(rec, None, 1)
        rec.append(d._lineterminator)
        return self._write("".join(rec))

    def writerows(self, rows, /):
        """Construct and write a series of iterables to a csv file.

Non-string elements will be converted to string."""
        for row in rows:
            self.writerow(row)


Writer = writer


def reader(*args, **kwargs):
    """Return a reader object that will process lines from the given iterable.

The "iterable" argument can be any object that returns a line
of input for each iteration, such as a file object or a list.  The
optional "dialect" argument defines a CSV dialect.  The function
also accepts optional keyword arguments which override settings
provided by the dialect.

The returned object is an iterator.  Each iteration returns a row
of the CSV file (which can span multiple input lines).
"""
    # (csv_reader)
    iterable, dialect = _unpack("reader", args, 1, 2)
    self = object.__new__(Reader)
    self._line_num = 0
    self._reset()
    self._input_iter = iter(iterable)
    self._dialect = _call_dialect(dialect, kwargs)
    return self


def writer(*args, **kwargs):
    """Return a writer object that will write user data on the given file object.

The "fileobj" argument can be any object that supports the file API.
The optional "dialect" argument defines a CSV dialect.  The function
also accepts optional keyword arguments which override settings
provided by the dialect.
"""
    # (csv_writer)
    output_file, dialect = _unpack("writer", args, 1, 2)
    self = object.__new__(Writer)
    try:
        write = output_file.write
    except AttributeError:
        write = None
    if write is None or not callable(write):
        raise TypeError('argument 1 must have a "write" method')
    self._write = write
    self._dialect = _call_dialect(dialect, kwargs)
    return self


def list_dialects(*args):
    """Return a list of all known dialect names."""
    if args:
        raise TypeError(f"_csv.list_dialects() takes no arguments ({len(args)} given)")
    return list(_dialects)


def register_dialect(*args, **kwargs):
    """Create a mapping from a string name to a CVS dialect.

The optional "dialect" argument specifies the base dialect instance
or the name of the registered dialect.  The function also accepts
optional keyword arguments which override settings provided by the
dialect.
"""
    name, dialect = _unpack("register_dialect", args, 1, 2)
    if not isinstance(name, str):
        raise TypeError("dialect name must be a string")
    _dialects[name] = _call_dialect(dialect, kwargs)


def _name_arg(fname, args, kwargs):
    # (Argument Clinic's "name: object")
    if len(args) + len(kwargs) > 1:
        raise TypeError(f"{fname}() takes at most 1 argument ({len(args) + len(kwargs)} given)")
    if not args and "name" not in kwargs:
        raise TypeError(f"{fname}() missing required argument 'name' (pos 1)")
    return args[0] if args else kwargs["name"]


def unregister_dialect(*args, **kwargs):
    """Delete the name/dialect mapping associated with a string name."""
    name = _name_arg("unregister_dialect", args, kwargs)
    if name not in _dialects:
        raise Error("unknown dialect")
    del _dialects[name]


def get_dialect(*args, **kwargs):
    """Return the dialect instance associated with name."""
    name = _name_arg("get_dialect", args, kwargs)
    return _get_dialect_from_registry(name)


def field_size_limit(*args, **kwargs):
    """Sets an upper limit on parsed fields.

Returns old limit. If limit is not given, no new limit is set and
the old limit is returned"""
    global _field_limit
    if len(args) + len(kwargs) > 1:
        raise TypeError(f"field_size_limit() takes at most 1 argument ({len(args) + len(kwargs)} given)")
    for k in kwargs:
        if k != "new_limit":
            raise TypeError(f"field_size_limit() got an unexpected keyword argument '{k}'")
    new_limit = args[0] if args else kwargs.get("new_limit", _NULL)
    old_limit = _field_limit
    if new_limit is not _NULL:
        if type(new_limit) is not int:
            raise TypeError("limit must be an integer")
        if not -_SSIZE_MAX - 1 <= new_limit <= _SSIZE_MAX:
            raise OverflowError("Python int too large to convert to C ssize_t")
        _field_limit = new_limit
    return old_limit
