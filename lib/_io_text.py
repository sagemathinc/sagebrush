# Sagebrush: io.TextIOWrapper, io.BufferedWriter and io.IncrementalNewlineDecoder, loaded by io's module
# __getattr__ on first use (a program that never wraps a binary stream never loads this file).
#
# The classes are CPython 3.14.10's pure-Python ones, from Lib/_pyio.py, unchanged but for the lines marked
# "(Sagebrush)": they subclass Sagebrush's io base classes, and their codecs are the incremental codecs below.
# Those are CPython 3.14.10's own (Lib/codecs.py and the encodings package: utf_8_sig, utf_16, utf_32) over
# the C primitives they call (codecs.utf_8_decode, utf_16_ex_decode, ...), which Sagebrush's small codecs
# module lacks: written here over bytes.decode, a call holding back exactly the trailing bytes CPython's
# decoder would (an incomplete but valid UTF-8 prefix, an odd byte or a pending high surrogate in UTF-16).
#
# Portions copyright (c) 2001-2026 Python Software Foundation; PSF License (see cdn/LICENSE-CPython.txt).

import io
from io import (BufferedIOBase, TextIOBase, UnsupportedOperation, SEEK_SET, SEEK_CUR, SEEK_END,
                DEFAULT_BUFFER_SIZE, text_encoding)

valid_seek_flags = {0, 1, 2}  # (Sagebrush: _pyio's, for BufferedWriter.seek)
_MISSING = object()
from io import _bytes_like  # (a bytes-like object's bytes, or C's TypeError)


from operator import index as _index  # (PyNumber_Index: __index__ called once, its result checked)


def _c_int_arg(v):
    # (an argument C converts to a C int, Argument Clinic's: __index__ once, then its range)
    n = _index(v)
    if not -(1 << 31) <= n < (1 << 31):
        raise OverflowError("Python int too large to convert to C int")
    return n


_U64 = (1 << 64) - 1


def _c_long_arg(v):
    # (an argument C converts to a C long: __index__ once, then its range)
    n = _index(v)
    if not -(1 << 63) <= n < (1 << 63):
        raise OverflowError("Python int too large to convert to C long")
    return n


def _raw_pos(v):
    # (a raw stream's position, as C's buffered I/O converts it: an offset, never negative)
    n = _index(v)
    if not -(1 << 63) <= n < (1 << 63):
        raise ValueError("cannot fit 'int' into an offset-sized integer")
    if n < 0:
        raise OSError("Raw stream returned invalid position %d" % n)
    return int(n)


def _c_off_arg(v):
    # (a position C converts to Py_off_t, PyNumber_AsOff_t with ValueError)
    n = _index(v)
    if not -(1 << 63) <= n < (1 << 63):
        raise ValueError("cannot fit 'int' into an offset-sized integer")
    return int(n)


def _c_args(name, names, required, args, kwargs):
    # (a C constructor's argument parsing, Argument Clinic's, and its messages: the positional count, then each
    # parameter in order (given twice, or required and missing), then an unexpected keyword)
    if len(args) > len(names):
        raise TypeError("%s() takes at most %d argument%s (%d given)" % (name, len(names), "" if len(names) == 1 else "s", len(args)))
    bound = {}
    for i, nm in enumerate(names):
        if i < len(args):
            if nm in kwargs:
                raise TypeError("argument for %s() given by name ('%s') and position (%d)" % (name, nm, i + 1))
            bound[nm] = args[i]
        elif nm in kwargs:
            bound[nm] = kwargs[nm]
        elif i < required:
            raise TypeError("%s() missing required argument '%s' (pos %d)" % (name, nm, i + 1))
    for k in kwargs:
        if k not in names:
            raise TypeError("%s() got an unexpected keyword argument '%s'" % (name, k))
    return bound


def _ssize_arg(v):
    # (an argument C converts to Py_ssize_t, with its messages)
    n = _index(v)
    if not -(1 << 63) <= n < (1 << 63):
        raise OverflowError("Python int too large to convert to C ssize_t")
    return n


class _NoLock:
    # (Sagebrush: _pyio's _thread lock; a program's Python runs on one thread)
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _check_readable(self):
    if not self.readable():
        raise UnsupportedOperation("File or stream is not readable.")


def _check_writable(self):
    if not self.writable():
        raise UnsupportedOperation("File or stream is not writable.")


# -- incremental codecs (CPython's Lib/codecs.py base classes and encodings modules, over the primitives below)

class IncrementalEncoder(object):
    def __init__(self, errors='strict'):
        self.errors = errors
        self.buffer = ""

    def encode(self, input, final=False):
        raise NotImplementedError

    def reset(self):
        pass

    def getstate(self):
        return 0

    def setstate(self, state):
        pass


class IncrementalDecoder(object):
    def __init__(self, errors='strict'):
        self.errors = errors

    def decode(self, input, final=False):
        raise NotImplementedError

    def reset(self):
        pass

    def getstate(self):
        return (b"", 0)

    def setstate(self, state):
        pass


class BufferedIncrementalDecoder(IncrementalDecoder):
    def __init__(self, errors='strict'):
        IncrementalDecoder.__init__(self, errors)
        # undecoded input that is kept between calls to decode()
        self.buffer = b""

    def _buffer_decode(self, input, errors, final):
        raise NotImplementedError

    def decode(self, input, final=False):
        # decode input (taking the buffer into account)
        data = self.buffer + input
        (result, consumed) = self._buffer_decode(data, self.errors, final)
        # keep undecoded input until the next call
        self.buffer = data[consumed:]
        return result

    def reset(self):
        IncrementalDecoder.reset(self)
        self.buffer = b""

    def getstate(self):
        # additional state info is always 0
        return (self.buffer, 0)

    def setstate(self, state):
        # ignore additional state info
        self.buffer = state[0]


# The C primitives' contract: decode the longest prefix CPython's decoder would, and say how many bytes that
# took; with final, everything (an incomplete tail is then the codec's error, as bytes.decode reports it).

def _utf8_held(b):
    """How many trailing bytes of b a non-final UTF-8 decode keeps back: a valid but incomplete sequence
    (Unicode's Table 3-7 well-formed prefixes), else 0, so an invalid tail is decoded, and reported, now."""
    n = len(b)
    for k in (1, 2, 3):
        if k > n:
            return 0
        lead = b[n - k]
        if 0x80 <= lead <= 0xBF:
            continue
        if 0xC2 <= lead <= 0xDF:
            need = 2
        elif 0xE0 <= lead <= 0xEF:
            need = 3
        elif 0xF0 <= lead <= 0xF4:
            need = 4
        else:
            return 0
        if need <= k:
            return 0
        tail = b[n - k + 1:]
        if tail:
            lo, hi = 0x80, 0xBF
            if lead == 0xE0:
                lo = 0xA0
            elif lead == 0xED:
                hi = 0x9F
            elif lead == 0xF0:
                lo = 0x90
            elif lead == 0xF4:
                hi = 0x8F
            if not (lo <= tail[0] <= hi):
                return 0
            for c in tail[1:]:
                if not (0x80 <= c <= 0xBF):
                    return 0
        return k
    return 0


def _utf16_held(b, little):
    n = len(b)
    held = n % 2
    if n - held >= 2:
        hi, lo = (b[n - held - 1], b[n - held - 2]) if little else (b[n - held - 2], b[n - held - 1])
        if 0xD8 <= hi <= 0xDB:
            held += 2
    return held


def _prefix_decode(data, encoding, errors, held):
    end = len(data) - held
    return (bytes(data[:end]).decode(encoding, errors), end)


def utf_8_decode(data, errors="strict", final=False):
    return _prefix_decode(data, "utf-8", errors, 0 if final else _utf8_held(data))


def utf_16_le_decode(data, errors="strict", final=False):
    return _prefix_decode(data, "utf-16-le", errors, 0 if final else _utf16_held(data, True))


def utf_16_be_decode(data, errors="strict", final=False):
    return _prefix_decode(data, "utf-16-be", errors, 0 if final else _utf16_held(data, False))


def utf_32_le_decode(data, errors="strict", final=False):
    return _prefix_decode(data, "utf-32-le", errors, 0 if final else len(data) % 4)


def utf_32_be_decode(data, errors="strict", final=False):
    return _prefix_decode(data, "utf-32-be", errors, 0 if final else len(data) % 4)


def _ex_decode(data, errors, final, width, bom_le, bom_be, le, be):
    # (byteorder 0: a BOM picks the order and is consumed; none, the platform's, little, as CPython's)
    if data[:width] == bom_le:
        out, used = le(data[width:], errors, final)
        return (out, used + width, -1)
    if data[:width] == bom_be:
        out, used = be(data[width:], errors, final)
        return (out, used + width, 1)
    if len(data) < width and not final and (bom_le.startswith(data) or bom_be.startswith(data)):
        return ("", 0, 0)
    out, used = le(data, errors, final)
    return (out, used, 0)


def utf_16_ex_decode(data, errors="strict", byteorder=0, final=False):
    return _ex_decode(data, errors, final, 2, b"\xff\xfe", b"\xfe\xff", utf_16_le_decode, utf_16_be_decode)


def utf_32_ex_decode(data, errors="strict", byteorder=0, final=False):
    return _ex_decode(data, errors, final, 4, b"\xff\xfe\x00\x00", b"\x00\x00\xfe\xff", utf_32_le_decode, utf_32_be_decode)


def _encoder(name):
    return lambda s, errors="strict": (s.encode(name, errors), len(s))


utf_8_encode = _encoder("utf-8")
utf_16_encode = _encoder("utf-16")
utf_16_le_encode = _encoder("utf-16-le")
utf_16_be_encode = _encoder("utf-16-be")
utf_32_encode = _encoder("utf-32")
utf_32_le_encode = _encoder("utf-32-le")
utf_32_be_encode = _encoder("utf-32-be")
BOM_UTF8 = b"\xef\xbb\xbf"


class _StatelessEncoder(IncrementalEncoder):
    # (an encoding with no state between calls: str.encode on each piece)
    name = None

    def encode(self, input, final=False):
        return input.encode(self.name, self.errors)


class _StatelessDecoder(IncrementalDecoder):
    # (a single-byte encoding: each piece decodes whole)
    name = None

    def decode(self, input, final=False):
        return bytes(input).decode(self.name, self.errors)


class _Utf8Decoder(BufferedIncrementalDecoder):
    def _buffer_decode(self, input, errors, final):
        return utf_8_decode(input, errors, final)


class _Utf8SigEncoder(IncrementalEncoder):
    def __init__(self, errors='strict'):
        IncrementalEncoder.__init__(self, errors)
        self.first = 1

    def encode(self, input, final=False):
        if self.first:
            self.first = 0
            return BOM_UTF8 + \
                   utf_8_encode(input, self.errors)[0]
        else:
            return utf_8_encode(input, self.errors)[0]

    def reset(self):
        IncrementalEncoder.reset(self)
        self.first = 1

    def getstate(self):
        return self.first

    def setstate(self, state):
        self.first = state


class _Utf8SigDecoder(BufferedIncrementalDecoder):
    def __init__(self, errors='strict'):
        BufferedIncrementalDecoder.__init__(self, errors)
        self.first = 1

    def _buffer_decode(self, input, errors, final):
        if self.first:
            if len(input) < 3:
                if BOM_UTF8.startswith(input):
                    # not enough data to decide if this really is a BOM
                    # => try again on the next call
                    return ("", 0)
                else:
                    self.first = 0
            else:
                self.first = 0
                if input[:3] == BOM_UTF8:
                    (output, consumed) = \
                       utf_8_decode(input[3:], errors, final)
                    return (output, consumed+3)
        return utf_8_decode(input, errors, final)

    def reset(self):
        BufferedIncrementalDecoder.reset(self)
        self.first = 1

    def getstate(self):
        state = BufferedIncrementalDecoder.getstate(self)
        # state[1] must be 0 here, as it isn't passed along to the caller
        return (state[0], self.first)

    def setstate(self, state):
        # state[1] will be ignored by BufferedIncrementalDecoder.setstate()
        BufferedIncrementalDecoder.setstate(self, state)
        self.first = state[1]


def _bom_codec(name, width, encode_bom, encode_le, encode_be, ex_decode, decode_le, decode_be):
    # CPython's encodings.utf_16 and utf_32 IncrementalEncoder and IncrementalDecoder (sys.byteorder: little,
    # as every host Sagebrush runs on)
    class Encoder(IncrementalEncoder):
        def __init__(self, errors='strict'):
            IncrementalEncoder.__init__(self, errors)
            self.encoder = None

        def encode(self, input, final=False):
            if self.encoder is None:
                result = encode_bom(input, self.errors)[0]
                self.encoder = encode_le
                return result
            return self.encoder(input, self.errors)[0]

        def reset(self):
            IncrementalEncoder.reset(self)
            self.encoder = None

        def getstate(self):
            # state info we return to the caller:
            # 0: stream is in natural order for this platform
            # 2: endianness hasn't been determined yet
            # (we're never writing in unnatural order)
            return (2 if self.encoder is None else 0)

        def setstate(self, state):
            if state:
                self.encoder = None
            else:
                self.encoder = encode_le

    class Decoder(BufferedIncrementalDecoder):
        def __init__(self, errors='strict'):
            BufferedIncrementalDecoder.__init__(self, errors)
            self.decoder = None

        def _buffer_decode(self, input, errors, final):
            if self.decoder is None:
                (output, consumed, byteorder) = \
                    ex_decode(input, errors, 0, final)
                if byteorder == -1:
                    self.decoder = decode_le
                elif byteorder == 1:
                    self.decoder = decode_be
                elif consumed >= width:
                    raise UnicodeDecodeError(name, input, 0, width, "Stream does not start with BOM")
                return (output, consumed)
            return self.decoder(input, self.errors, final)

        def reset(self):
            BufferedIncrementalDecoder.reset(self)
            self.decoder = None

        def getstate(self):
            # additional state info from the base class must be None here,
            # as it isn't passed along to the caller
            state = BufferedIncrementalDecoder.getstate(self)[0]
            # additional state info we pass to the caller:
            # 0: stream is in natural order for this platform
            # 1: stream is in unnatural order
            # 2: endianness hasn't been determined yet
            if self.decoder is None:
                return (state, 2)
            addstate = int(self.decoder is decode_be)
            return (state, addstate)

        def setstate(self, state):
            # state[1] will be ignored by BufferedIncrementalDecoder.setstate()
            BufferedIncrementalDecoder.setstate(self, state)
            state = state[1]
            if state == 0:
                self.decoder = decode_le
            elif state == 1:
                self.decoder = decode_be
            else:
                self.decoder = None

    return Encoder, Decoder


_Utf16Encoder, _Utf16Decoder = _bom_codec("utf-16", 2, utf_16_encode, utf_16_le_encode, utf_16_be_encode, utf_16_ex_decode, utf_16_le_decode, utf_16_be_decode)
_Utf32Encoder, _Utf32Decoder = _bom_codec("utf-32", 4, utf_32_encode, utf_32_le_encode, utf_32_be_encode, utf_32_ex_decode, utf_32_le_decode, utf_32_be_decode)


def _held_decoder(primitive):
    class Decoder(BufferedIncrementalDecoder):
        def _buffer_decode(self, input, errors, final):
            return primitive(input, errors, final)
    return Decoder


# (the normalized names of the stateful codecs; CPython's encodings.aliases for them)
_FAMILIES = {}
for _names, _pair in (
        (("utf-8", "utf8", "u8", "utf", "cp65001", "utf8-ucs2", "utf8-ucs4"), (None, _Utf8Decoder)),
        (("utf-8-sig", "utf8-sig"), (_Utf8SigEncoder, _Utf8SigDecoder)),
        (("utf-16", "utf16", "u16"), (_Utf16Encoder, _Utf16Decoder)),
        (("utf-16-le", "utf-16le", "utf16le", "unicodelittleunmarked"), (None, _held_decoder(utf_16_le_decode))),
        (("utf-16-be", "utf-16be", "utf16be", "unicodebigunmarked"), (None, _held_decoder(utf_16_be_decode))),
        (("utf-32", "utf32", "u32"), (_Utf32Encoder, _Utf32Decoder)),
        (("utf-32-le", "utf-32le", "utf32le"), (None, _held_decoder(utf_32_le_decode))),
        (("utf-32-be", "utf-32be", "utf32be"), (None, _held_decoder(utf_32_be_decode)))):
    for _n in _names:
        _FAMILIES[_n] = _pair


def _family(encoding):
    return _FAMILIES.get(encoding.lower().replace("_", "-").replace(" ", "-"))


def _check_text_encoding(encoding):
    # (codecs.lookup(encoding): an unknown name is CPython's LookupError)
    "".encode(encoding)


def _incremental_encoder(encoding):
    pair = _family(encoding)
    if pair is not None and pair[0] is not None:
        return pair[0]
    "".encode(encoding)
    return type("IncrementalEncoder", (_StatelessEncoder,), {"name": encoding})


def _incremental_decoder(encoding):
    pair = _family(encoding)
    if pair is not None:
        return pair[1]
    "".encode(encoding)
    return type("IncrementalDecoder", (_StatelessDecoder,), {"name": encoding})


# -- CPython 3.14.10's _pyio.py: _BufferedIOMixin and BufferedWriter (lines 765-875, 1219-1322)

class _BufferedIOMixin(BufferedIOBase):  # (Sagebrush: io's BufferedIOBase)

    """A mixin implementation of BufferedIOBase with an underlying raw stream.

    This passes most requests on to the underlying raw stream.  It
    does *not* provide implementations of read(), readinto() or
    write().
    """

    def __init__(self, raw):
        self._raw = raw

    _checkReadable = _check_readable  # (Sagebrush: _pyio's IOBase methods)
    _checkWritable = _check_writable

    ### Positioning ###

    def seek(self, pos, whence=0):
        return _raw_pos(self.raw.seek(pos, whence))  # (Sagebrush: C's conversion of the raw result)

    def tell(self):
        return _raw_pos(self.raw.tell())  # (Sagebrush: C's conversion of the raw result)

    def truncate(self, pos=None):
        self._checkClosed()
        self._checkWritable()

        # Flush the stream.  We're mixing buffered I/O with lower-level I/O,
        # and a flush may be necessary to synch both views of the current
        # file state.
        self.flush()

        if pos is None:
            pos = self.tell()
        # XXX: Should seek() be used, instead of passing the position
        # XXX  directly to truncate?
        return self.raw.truncate(pos)

    ### Flush and close ###

    def flush(self):
        self._checkAttachedRaw()
        if self.closed:
            raise ValueError("flush of closed file")  # (Sagebrush: C's message)
        self.raw.flush()

    def close(self):
        if self.raw is not None and not self.closed:
            try:
                # may raise BlockingIOError or BrokenPipeError etc
                self.flush()
            finally:
                self.raw.close()

    def detach(self):
        if self.raw is None:
            raise ValueError("raw stream has been detached")  # (Sagebrush: C's message)
        self.flush()
        raw = self._raw
        self._raw = None
        return raw

    ### Inquiries ###

    def seekable(self):
        self._checkAttachedRaw()
        return self.raw.seekable()

    @property
    def raw(self):
        return self._raw

    def _checkAttachedRaw(self):  # (Sagebrush: C's CHECK_INITIALIZED)
        if self._raw is None:
            raise ValueError("raw stream has been detached")

    @property
    def closed(self):
        self._checkAttachedRaw()
        return self.raw.closed

    @property
    def name(self):
        self._checkAttachedRaw()
        return self.raw.name

    @property
    def mode(self):
        self._checkAttachedRaw()
        return self.raw.mode

    def __getstate__(self):
        raise TypeError(f"cannot pickle {self.__class__.__name__!r} object")

    def __repr__(self):
        modname = self.__class__.__module__
        clsname = self.__class__.__qualname__
        try:
            name = self.name
        except (AttributeError, ValueError):  # (Sagebrush: C's, detached too)
            return "<{}.{}>".format(modname, clsname)
        else:
            return "<{}.{} name={!r}>".format(modname, clsname, name)

    def _dealloc_warn(self, source):
        if dealloc_warn := getattr(self.raw, "_dealloc_warn", None):
            dealloc_warn(source)

    ### Lower-level APIs ###

    def fileno(self):
        self._checkAttachedRaw()
        return self.raw.fileno()

    def isatty(self):
        self._checkAttachedRaw()
        return self.raw.isatty()



class BufferedWriter(_BufferedIOMixin):

    """A buffer for a writeable sequential RawIO object.

    The constructor creates a BufferedWriter for the given writeable raw
    stream. If the buffer_size is not given, it defaults to
    DEFAULT_BUFFER_SIZE.
    """

    # (Sagebrush: the methods below are _pyio's but for C's behaviour, as CPython 3.14.10 shows it, the raw calls
    # included (test/io_text_cases.py records them): a write is buffered while it fits; else the buffer is flushed
    # whole, then the data goes straight to the raw stream while at least buffer_size bytes of it remain, and the
    # rest is buffered; data of buffer_size bytes or more is never buffered first. C's argument checks and
    # messages too.)

    def __init__(self, *args, **kwargs):  # (C's argument parsing and messages)
        self._init(**_c_args("BufferedWriter", ("raw", "buffer_size"), 1, args, kwargs))

    def _init(self, raw, buffer_size=DEFAULT_BUFFER_SIZE):
        buffer_size = _ssize_arg(buffer_size)
        if not raw.writable():
            raise UnsupportedOperation("File or stream is not writable.")

        _BufferedIOMixin.__init__(self, raw)
        if buffer_size <= 0:
            raise ValueError("buffer size must be strictly positive")
        self.buffer_size = buffer_size
        self._write_buf = bytearray()
        self._write_lock = _NoLock()
        # (C's _buffered_init asks the raw stream for its position once, ignoring any error)
        try:
            _raw_pos(raw.tell())
        except Exception:
            pass

    def writable(self):
        self._checkAttachedRaw()
        return self.raw.writable()

    def write(self, b):
        self._checkAttachedRaw()
        data = _bytes_like(b)
        with self._write_lock:
            if self.closed:
                raise ValueError("write to closed file")
            n = len(data)
            if n <= self.buffer_size - len(self._write_buf) and n < self.buffer_size:
                self._write_buf.extend(data)
                return n
            self._flush_unlocked()
            written = 0
            while n - written >= self.buffer_size:
                k = self._raw_write(data[written:])
                if k is None:
                    raise BlockingIOError(
                        11,  # (errno.EAGAIN)
                        "write could not complete without blocking", written)
                written += k
            self._write_buf.extend(data[written:])
            return n

    def _raw_write(self, data):
        try:
            n = self.raw.write(data)
        except BlockingIOError:
            raise RuntimeError("self.raw should implement RawIOBase: it "
                               "should not raise BlockingIOError")
        if n is None:
            return None
        # (C's PyNumber_AsSsize_t: a result that isn't an integer, or overflows, is -1, then reported as invalid)
        try:
            n = _index(n)
        except TypeError:
            n = -1
        if not -(1 << 63) <= n < (1 << 63):
            n = -1
        if n > len(data) or n < 0:
            raise OSError("raw write() returned invalid length %d (should have been between 0 and %d)" % (n, len(data)))
        return int(n)

    def truncate(self, pos=None):
        self._checkAttachedRaw()
        with self._write_lock:
            self._flush_unlocked()
            return self.raw.truncate(pos)

    def flush(self):
        self._checkAttachedRaw()
        with self._write_lock:
            self._flush_unlocked()

    def _flush_unlocked(self):
        if self.closed:
            raise ValueError("flush of closed file")
        while self._write_buf:
            n = self._raw_write(self._write_buf)
            if n is None:
                raise BlockingIOError(
                    11,  # (errno.EAGAIN)
                    "write could not complete without blocking", 0)
            del self._write_buf[:n]

    def tell(self):
        self._checkAttachedRaw()
        return _BufferedIOMixin.tell(self) + len(self._write_buf)

    def seek(self, pos, whence=0):
        # (C's order: whence converted as a C int, checked; closed; then pos converted, as an offset)
        whence = _c_int_arg(whence)
        self._checkAttachedRaw()
        if whence not in valid_seek_flags:
            raise ValueError("whence value %d unsupported" % whence)
        if self.closed:
            raise ValueError("seek of closed file")
        pos = _c_off_arg(pos)
        with self._write_lock:
            self._flush_unlocked()
            return _BufferedIOMixin.seek(self, pos, whence)

    def close(self):
        self._checkAttachedRaw()
        with self._write_lock:
            if self.raw is None or self.closed:
                return
        # We have to release the lock and call self.flush() (which will
        # probably just re-take the lock) in case flush has been overridden in
        # a subclass or the user set self.flush to something. This is the same
        # behavior as the C implementation.
        try:
            # may raise BlockingIOError or BrokenPipeError etc
            self.flush()
        finally:
            with self._write_lock:
                self.raw.close()


# -- CPython 3.14.10's _pyio.py: IncrementalNewlineDecoder and TextIOWrapper (lines 1948-2714)

class IncrementalNewlineDecoder(IncrementalDecoder):  # (Sagebrush: the codecs base above)
    r"""Codec used when reading a file in universal newlines mode.  It wraps
    another incremental decoder, translating \r\n and \r into \n.  It also
    records the types of newlines encountered.  When used with
    translate=False, it ensures that the newline sequence is returned in
    one piece.
    """
    def __init__(self, *args, **kwargs):  # (Sagebrush: C's argument parsing and messages)
        self._init(**_c_args("IncrementalNewlineDecoder", ("decoder", "translate", "errors"), 2, args, kwargs))

    def _init(self, decoder, translate, errors='strict'):
        IncrementalDecoder.__init__(self, errors=errors)
        self.translate = bool(translate)  # (Sagebrush: C's, truth-tested once)
        self.decoder = decoder
        self.seennl = 0
        self.pendingcr = False

    def decode(self, input, final=False):
        # decode input (with the eventual \r from a previous pass)
        if self.decoder is None:
            output = input
        else:
            output = self.decoder.decode(input, final=final)
            if not isinstance(output, str):  # (Sagebrush: C's check)
                raise TypeError("decoder should return a string result, not '%s'" % type(output).__name__)
        if self.pendingcr and (output or final):
            output = "\r" + output
            self.pendingcr = False

        # retain last \r even when not translating data:
        # then readline() is sure to get \r\n in one pass
        if output.endswith("\r") and not final:
            output = output[:-1]
            self.pendingcr = True

        # Record which newlines are read
        crlf = output.count('\r\n')
        cr = output.count('\r') - crlf
        lf = output.count('\n') - crlf
        self.seennl |= (lf and self._LF) | (cr and self._CR) \
                    | (crlf and self._CRLF)

        if self.translate:
            if crlf:
                output = output.replace("\r\n", "\n")
            if cr:
                output = output.replace("\r", "\n")

        return output

    def getstate(self):
        if self.decoder is None:
            buf = b""
            flag = 0
        else:
            # (Sagebrush: C's, a 2-tuple whose flag is an unsigned 64-bit integer, masked)
            state = self.decoder.getstate()
            if not isinstance(state, tuple) or len(state) != 2:
                raise TypeError("illegal decoder state")
            buf, flag = state
            try:
                flag = _index(flag) & _U64
            except TypeError:
                raise TypeError("illegal decoder state") from None
        flag = (flag << 1) & _U64
        if self.pendingcr:
            flag |= 1
        return buf, flag

    def setstate(self, state):
        # (Sagebrush: C's, a 2-tuple, the flag masked to 64 bits)
        if not isinstance(state, tuple):
            raise TypeError("state argument must be a tuple")
        if len(state) != 2:
            raise TypeError("setstate(): illegal state argument")
        buf, flag = state
        try:
            flag = _index(flag) & _U64
        except TypeError:
            raise TypeError("setstate(): illegal state argument") from None
        self.pendingcr = bool(flag & 1)
        if self.decoder is not None:
            self.decoder.setstate((buf, flag >> 1))

    def reset(self):
        self.seennl = 0
        self.pendingcr = False
        if self.decoder is not None:
            self.decoder.reset()

    _LF = 1
    _CR = 2
    _CRLF = 4

    @property
    def newlines(self):
        return (None,
                "\n",
                "\r",
                ("\r", "\n"),
                "\r\n",
                ("\n", "\r\n"),
                ("\r", "\r\n"),
                ("\r", "\n", "\r\n")
               )[self.seennl]


class TextIOWrapper(TextIOBase):  # (Sagebrush: io's TextIOBase)

    r"""Character and line based layer over a BufferedIOBase object, buffer.

    encoding gives the name of the encoding that the stream will be
    decoded or encoded with. It defaults to locale.getencoding().

    errors determines the strictness of encoding and decoding (see the
    codecs.register) and defaults to "strict".

    newline can be None, '', '\n', '\r', or '\r\n'.  It controls the
    handling of line endings. If it is None, universal newlines is
    enabled.  With this enabled, on input, the lines endings '\n', '\r',
    or '\r\n' are translated to '\n' before being returned to the
    caller. Conversely, on output, '\n' is translated to the system
    default line separator, os.linesep. If newline is any other of its
    legal values, that newline becomes the newline when the file is read
    and it is returned untranslated. On output, '\n' is converted to the
    newline.

    If line_buffering is True, a call to flush is implied when a call to
    write contains a newline character.
    """

    _CHUNK_SIZE = 2048

    def _checkReadable(self):  # (Sagebrush: C's message)
        if not self.readable():
            raise UnsupportedOperation("not readable")

    _checkWritable = _check_writable

    def _checkAttached(self):  # (Sagebrush: C's CHECK_ATTACHED)
        if self._buffer is None:
            raise ValueError("underlying buffer has been detached")

    # Initialize _buffer as soon as possible since it's used by __del__()
    # which calls close()
    _buffer = None

    # The write_through argument has no effect here since this
    # implementation always writes through.  The argument is present only
    # so that the signature can match the signature of the C version.
    def __init__(self, *args, **kwargs):  # (Sagebrush: C's argument parsing and messages)
        self._init(**_c_args("TextIOWrapper", ("buffer", "encoding", "errors", "newline", "line_buffering", "write_through"), 1, args, kwargs))

    def _init(self, buffer, encoding=None, errors=None, newline=None,
              line_buffering=False, write_through=False):
        # (Sagebrush: C's, each truth-tested once, stored as a bool)
        line_buffering = bool(line_buffering)
        write_through = bool(write_through)
        self._check_newline(newline)
        encoding = text_encoding(encoding)

        if encoding == "locale":
            encoding = self._get_locale_encoding()

        if not isinstance(encoding, str):
            raise TypeError("TextIOWrapper() argument 'encoding' must be str or None, not %s" % type(encoding).__name__)  # (Sagebrush: C's message)

        _check_text_encoding(encoding)  # (Sagebrush: codecs.lookup(encoding)._is_text_encoding)

        if errors is None:
            errors = "strict"
        else:
            if not isinstance(errors, str):
                raise TypeError("TextIOWrapper() argument 'errors' must be str or None, not %s" % type(errors).__name__)  # (Sagebrush: C's message)

        self._buffer = buffer
        self._decoded_chars = ''  # buffer for text returned from decoder
        self._decoded_chars_used = 0  # offset into _decoded_chars for read()
        self._snapshot = None  # info for reconstructing decoder state
        self._seekable = self._telling = self.buffer.seekable()
        self._has_read1 = hasattr(self.buffer, 'read1')
        self._configure(encoding, errors, newline,
                        line_buffering, write_through)

    def _check_newline(self, newline):
        if newline is not None and not isinstance(newline, str):
            raise TypeError("TextIOWrapper() argument 'newline' must be str or None, not %s" % type(newline).__name__)  # (Sagebrush: C's message)
        if newline not in (None, "", "\n", "\r", "\r\n"):
            raise ValueError("illegal newline value: %s" % (newline,))  # (Sagebrush: C's message)

    def _configure(self, encoding=None, errors=None, newline=None,
                   line_buffering=False, write_through=False):
        self._encoding = encoding
        self._errors = errors
        self._encoder = None
        self._decoder = None
        self._b2cratio = 0.0

        self._readuniversal = not newline
        self._readtranslate = newline is None
        self._readnl = newline
        self._writetranslate = newline != ''
        self._writenl = newline or "\n"  # (Sagebrush: os.linesep)

        self._line_buffering = line_buffering
        self._write_through = write_through

        # don't write a BOM in the middle of a file
        if self._seekable and self.writable():
            position = self.buffer.tell()
            if position != 0:
                try:
                    self._get_encoder().setstate(0)
                except LookupError:
                    # Sometimes the encoder doesn't exist
                    pass

    # self._snapshot is either None, or a tuple (dec_flags, next_input)
    # where dec_flags is the second (integer) item of the decoder state
    # and next_input is the chunk of input bytes that comes next after the
    # snapshot point.  We use this to reconstruct decoder states in tell().

    # Naming convention:
    #   - "bytes_..." for integer variables that count input bytes
    #   - "chars_..." for integer variables that count decoded characters

    def __repr__(self):
        result = "<{}.{}".format(self.__class__.__module__,
                                 self.__class__.__qualname__)
        try:
            name = self.name
        except AttributeError:
            pass
        else:
            result += " name={0!r}".format(name)
        try:
            mode = self.mode
        except AttributeError:
            pass
        else:
            result += " mode={0!r}".format(mode)
        return result + " encoding={0!r}>".format(self.encoding)

    @property
    def encoding(self):
        return self._encoding

    @property
    def errors(self):
        return self._errors

    @property
    def line_buffering(self):
        return self._line_buffering

    @property
    def write_through(self):
        return self._write_through

    @property
    def buffer(self):
        return self._buffer

    def reconfigure(self, *,
                    encoding=None, errors=None, newline=Ellipsis,
                    line_buffering=None, write_through=None):
        """Reconfigure the text stream with new parameters.

        This also flushes the stream.
        """
        self._checkAttached()  # (Sagebrush: C's)
        # (Sagebrush: C's order, the arguments' types checked first, with its messages)
        if errors is not None and not isinstance(errors, str):
            raise TypeError("reconfigure() argument 'errors' must be str or None, not %s" % type(errors).__name__)
        if encoding is not None and not isinstance(encoding, str):
            raise TypeError("reconfigure() argument 'encoding' must be str or None, not %s" % type(encoding).__name__)
        if (self._decoder is not None
                and (encoding is not None or errors is not None
                     or newline is not Ellipsis)):
            raise UnsupportedOperation(
                "It is not possible to set the encoding or newline of stream "
                "after the first read")

        if errors is None:
            if encoding is None:
                errors = self._errors
            else:
                errors = 'strict'

        if encoding is None:
            encoding = self._encoding
        else:
            if encoding == "locale":
                encoding = self._get_locale_encoding()

        if newline is Ellipsis:
            newline = self._readnl
        self._check_newline(newline)

        # (Sagebrush: C's convert_optional_bool, a C long; then the encoding looked up before anything changes)
        line_buffering = self.line_buffering if line_buffering is None else bool(_c_long_arg(line_buffering))
        write_through = self.write_through if write_through is None else bool(_c_long_arg(write_through))

        self.flush()
        _check_text_encoding(encoding)
        self._configure(encoding, errors, newline,
                        line_buffering, write_through)

    def seekable(self):
        self._checkAttached()  # (Sagebrush: C's)
        if self.closed:
            raise ValueError("I/O operation on closed file.")
        return self._seekable

    def readable(self):
        self._checkAttached()  # (Sagebrush: C's)
        return self.buffer.readable()

    def writable(self):
        self._checkAttached()  # (Sagebrush: C's)
        return self.buffer.writable()

    def flush(self):
        self._checkAttached()  # (Sagebrush: C's)
        self.buffer.flush()
        self._telling = self._seekable

    def close(self):
        self._checkAttached()  # (Sagebrush: C's)
        if self.buffer is not None and not self.closed:
            try:
                self.flush()
            finally:
                self.buffer.close()

    @property
    def closed(self):
        self._checkAttached()  # (Sagebrush: C's)
        return self.buffer.closed

    @property
    def name(self):
        self._checkAttached()  # (Sagebrush: C's)
        return self.buffer.name

    def fileno(self):
        self._checkAttached()  # (Sagebrush: C's)
        return self.buffer.fileno()

    def isatty(self):
        self._checkAttached()  # (Sagebrush: C's)
        return self.buffer.isatty()

    def write(self, s):
        'Write data, where s is a str'
        self._checkAttached()  # (Sagebrush: C's)
        if self.closed:
            raise ValueError("I/O operation on closed file.")  # (Sagebrush: C's messages and its writable check)
        if not isinstance(s, str):
            raise TypeError("write() argument must be str, not %s" % s.__class__.__name__)
        if not self.writable():
            raise UnsupportedOperation("not writable")
        length = len(s)
        haslf = (self._writetranslate or self._line_buffering) and "\n" in s
        if haslf and self._writetranslate and self._writenl != "\n":
            s = s.replace("\n", self._writenl)
        encoder = self._encoder or self._get_encoder()
        # XXX What if we were just reading?
        b = encoder.encode(s)
        self.buffer.write(b)
        if self._line_buffering and (haslf or "\r" in s):
            self.flush()
        if self._snapshot is not None:
            self._set_decoded_chars('')
            self._snapshot = None
        if self._decoder:
            self._decoder.reset()
        return length

    def _get_encoder(self):
        make_encoder = _incremental_encoder(self._encoding)  # (Sagebrush: codecs.getincrementalencoder)
        self._encoder = make_encoder(self._errors)
        return self._encoder

    def _get_decoder(self):
        make_decoder = _incremental_decoder(self._encoding)  # (Sagebrush: codecs.getincrementaldecoder)
        decoder = make_decoder(self._errors)
        if self._readuniversal:
            decoder = IncrementalNewlineDecoder(decoder, self._readtranslate)
        self._decoder = decoder
        return decoder

    # The following three methods implement an ADT for _decoded_chars.
    # Text returned from the decoder is buffered here until the client
    # requests it by calling our read() or readline() method.
    def _set_decoded_chars(self, chars):
        """Set the _decoded_chars buffer."""
        self._decoded_chars = chars
        self._decoded_chars_used = 0

    def _get_decoded_chars(self, n=None):
        """Advance into the _decoded_chars buffer."""
        offset = self._decoded_chars_used
        if n is None:
            chars = self._decoded_chars[offset:]
        else:
            chars = self._decoded_chars[offset:offset + n]
        self._decoded_chars_used += len(chars)
        return chars

    def _get_locale_encoding(self):
        try:
            import locale
        except ImportError:
            # Importing locale may fail if Python is being built
            return "utf-8"
        else:
            return locale.getencoding()

    def _rewind_decoded_chars(self, n):
        """Rewind the _decoded_chars buffer."""
        if self._decoded_chars_used < n:
            raise AssertionError("rewind decoded_chars out of bounds")
        self._decoded_chars_used -= n

    def _read_chunk(self):
        """
        Read and decode the next chunk of data from the BufferedReader.
        """

        # The return value is True unless EOF was reached.  The decoded
        # string is placed in self._decoded_chars (replacing its previous
        # value).  The entire input chunk is sent to the decoder, though
        # some of it may remain buffered in the decoder, yet to be
        # converted.

        if self._decoder is None:
            raise ValueError("no decoder")

        if self._telling:
            # To prepare for tell(), we need to snapshot a point in the
            # file where the decoder's input buffer is empty.

            dec_buffer, dec_flags = self._decoder.getstate()
            # Given this, we know there was a valid snapshot point
            # len(dec_buffer) bytes ago with decoder state (b'', dec_flags).

        # Read a chunk, decode it, and put the result in self._decoded_chars.
        if self._has_read1:
            input_chunk = self.buffer.read1(self._CHUNK_SIZE)
        else:
            input_chunk = self.buffer.read(self._CHUNK_SIZE)
        eof = not input_chunk
        decoded_chars = self._decoder.decode(input_chunk, eof)
        self._set_decoded_chars(decoded_chars)
        if decoded_chars:
            self._b2cratio = len(input_chunk) / len(self._decoded_chars)
        else:
            self._b2cratio = 0.0

        if self._telling:
            # At the snapshot point, len(dec_buffer) bytes before the read,
            # the next input to be decoded is dec_buffer + input_chunk.
            self._snapshot = (dec_flags, dec_buffer + input_chunk)

        return not eof

    def _pack_cookie(self, position, dec_flags=0,
                           bytes_to_feed=0, need_eof=False, chars_to_skip=0):
        # The meaning of a tell() cookie is: seek to position, set the
        # decoder flags to dec_flags, read bytes_to_feed bytes, feed them
        # into the decoder with need_eof as the EOF flag, then skip
        # chars_to_skip characters of the decoded result.  For most simple
        # decoders, tell() will often just give a byte offset in the file.
        return (position | (dec_flags<<64) | (bytes_to_feed<<128) |
               (chars_to_skip<<192) | bool(need_eof)<<256)

    def _unpack_cookie(self, bigint):
        rest, position = divmod(bigint, 1<<64)
        rest, dec_flags = divmod(rest, 1<<64)
        rest, bytes_to_feed = divmod(rest, 1<<64)
        need_eof, chars_to_skip = divmod(rest, 1<<64)
        return position, dec_flags, bytes_to_feed, bool(need_eof), chars_to_skip

    def tell(self):
        self._checkAttached()  # (Sagebrush: C's)
        if not self._seekable:
            raise UnsupportedOperation("underlying stream is not seekable")
        if not self._telling:
            raise OSError("telling position disabled by next() call")
        self.flush()
        position = self.buffer.tell()
        decoder = self._decoder
        if decoder is None or self._snapshot is None:
            if self._decoded_chars:
                # This should never happen.
                raise AssertionError("pending decoded text")
            return position

        # Skip backward to the snapshot point (see _read_chunk).
        dec_flags, next_input = self._snapshot
        position -= len(next_input)

        # How many decoded characters have been used up since the snapshot?
        chars_to_skip = self._decoded_chars_used
        if chars_to_skip == 0:
            # We haven't moved from the snapshot point.
            return self._pack_cookie(position, dec_flags)

        # Starting from the snapshot position, we will walk the decoder
        # forward until it gives us enough decoded characters.
        saved_state = decoder.getstate()
        try:
            # Fast search for an acceptable start point, close to our
            # current pos.
            # Rationale: calling decoder.decode() has a large overhead
            # regardless of chunk size; we want the number of such calls to
            # be O(1) in most situations (common decoders, sensible input).
            # Actually, it will be exactly 1 for fixed-size codecs (all
            # 8-bit codecs, also UTF-16 and UTF-32).
            skip_bytes = int(self._b2cratio * chars_to_skip)
            skip_back = 1
            assert skip_bytes <= len(next_input)
            while skip_bytes > 0:
                decoder.setstate((b'', dec_flags))
                # Decode up to temptative start point
                n = len(decoder.decode(next_input[:skip_bytes]))
                if n <= chars_to_skip:
                    b, d = decoder.getstate()
                    if not b:
                        # Before pos and no bytes buffered in decoder => OK
                        dec_flags = d
                        chars_to_skip -= n
                        break
                    # Skip back by buffered amount and reset heuristic
                    skip_bytes -= len(b)
                    skip_back = 1
                else:
                    # We're too far ahead, skip back a bit
                    skip_bytes -= skip_back
                    skip_back = skip_back * 2
            else:
                skip_bytes = 0
                decoder.setstate((b'', dec_flags))

            # Note our initial start point.
            start_pos = position + skip_bytes
            start_flags = dec_flags
            if chars_to_skip == 0:
                # We haven't moved from the start point.
                return self._pack_cookie(start_pos, start_flags)

            # Feed the decoder one byte at a time.  As we go, note the
            # nearest "safe start point" before the current location
            # (a point where the decoder has nothing buffered, so seek()
            # can safely start from there and advance to this location).
            bytes_fed = 0
            need_eof = False
            # Chars decoded since `start_pos`
            chars_decoded = 0
            for i in range(skip_bytes, len(next_input)):
                bytes_fed += 1
                chars_decoded += len(decoder.decode(next_input[i:i+1]))
                dec_buffer, dec_flags = decoder.getstate()
                if not dec_buffer and chars_decoded <= chars_to_skip:
                    # Decoder buffer is empty, so this is a safe start point.
                    start_pos += bytes_fed
                    chars_to_skip -= chars_decoded
                    start_flags, bytes_fed, chars_decoded = dec_flags, 0, 0
                if chars_decoded >= chars_to_skip:
                    break
            else:
                # We didn't get enough decoded data; signal EOF to get more.
                chars_decoded += len(decoder.decode(b'', final=True))
                need_eof = True
                if chars_decoded < chars_to_skip:
                    raise OSError("can't reconstruct logical file position")

            # The returned cookie corresponds to the last safe start point.
            return self._pack_cookie(
                start_pos, start_flags, bytes_fed, need_eof, chars_to_skip)
        finally:
            decoder.setstate(saved_state)

    def truncate(self, pos=None):
        self._checkAttached()  # (Sagebrush: C's)
        self.flush()
        # (Sagebrush: C's, pos to the buffer as it is, None too)
        return self.buffer.truncate(pos)

    def detach(self):
        self._checkAttached()  # (Sagebrush: C's)
        if self.buffer is None:
            raise ValueError("buffer is already detached")
        self.flush()
        buffer = self._buffer
        self._buffer = None
        return buffer

    def seek(self, cookie, whence=0):
        whence = _c_int_arg(whence)  # (Sagebrush: C's argument conversion, first)
        self._checkAttached()  # (Sagebrush: C's)
        def _reset_encoder(position):
            """Reset the encoder (merely useful for proper BOM handling)"""
            try:
                encoder = self._encoder or self._get_encoder()
            except LookupError:
                # Sometimes the encoder doesn't exist
                pass
            else:
                if position != 0:
                    encoder.setstate(0)
                else:
                    encoder.reset()

        if self.closed:
            raise ValueError("I/O operation on closed file.")  # (Sagebrush: C's message)
        if not self._seekable:
            raise UnsupportedOperation("underlying stream is not seekable")
        if whence == SEEK_CUR:
            if cookie != 0:
                raise UnsupportedOperation("can't do nonzero cur-relative seeks")
            # Seeking to the current position should attempt to
            # sync the underlying buffer with the current position.
            whence = 0
            cookie = self.tell()
        elif whence == SEEK_END:
            if cookie != 0:
                raise UnsupportedOperation("can't do nonzero end-relative seeks")
            self.flush()
            position = self.buffer.seek(0, whence)
            self._set_decoded_chars('')
            self._snapshot = None
            if self._decoder:
                self._decoder.reset()
            _reset_encoder(position)
            return position
        if whence != 0:
            raise ValueError("invalid whence (%r, should be 0, 1 or 2)" % (whence,))  # (Sagebrush: C's message)
        if cookie < 0:
            raise ValueError("negative seek position %r" % (cookie,))
        self.flush()

        # The strategy of seek() is to go back to the safe start point
        # and replay the effect of read(chars_to_skip) from there.
        start_pos, dec_flags, bytes_to_feed, need_eof, chars_to_skip = \
            self._unpack_cookie(cookie)

        # Seek back to the safe start point.
        self.buffer.seek(start_pos)
        self._set_decoded_chars('')
        self._snapshot = None

        # Restore the decoder to its state from the safe start point.
        if cookie == 0 and self._decoder:
            self._decoder.reset()
        elif self._decoder or dec_flags or chars_to_skip:
            self._decoder = self._decoder or self._get_decoder()
            self._decoder.setstate((b'', dec_flags))
            self._snapshot = (dec_flags, b'')

        if chars_to_skip:
            # Just like _read_chunk, feed the decoder and save a snapshot.
            input_chunk = self.buffer.read(bytes_to_feed)
            self._set_decoded_chars(
                self._decoder.decode(input_chunk, need_eof))
            self._snapshot = (dec_flags, input_chunk)

            # Skip chars_to_skip of the decoded characters.
            if len(self._decoded_chars) < chars_to_skip:
                raise OSError("can't restore logical file position")
            self._decoded_chars_used = chars_to_skip

        _reset_encoder(cookie)
        return cookie

    def read(self, size=None):
        self._checkAttached()  # (Sagebrush: C's)
        self._checkReadable()
        if size is None:
            size = -1
        else:
            try:
                size_index = size.__index__
            except AttributeError:
                # (Sagebrush: C's message)
                raise TypeError("argument should be integer or None, not '%s'" % type(size).__name__)
            else:
                size = _index(size)  # (Sagebrush: its __index__ once, the result checked; C's Py_ssize_t)
                if not -(1 << 63) <= size < (1 << 63):
                    raise OverflowError("cannot fit 'int' into an index-sized integer")
        decoder = self._decoder or self._get_decoder()
        if size < 0:
            chunk = self.buffer.read()
            if chunk is None:
                raise BlockingIOError("Read returned None.")
            # Read everything.
            result = (self._get_decoded_chars() +
                      decoder.decode(chunk, final=True))
            if self._snapshot is not None:
                self._set_decoded_chars('')
                self._snapshot = None
            return result
        else:
            # Keep reading chunks until we have size characters to return.
            eof = False
            result = self._get_decoded_chars(size)
            while len(result) < size and not eof:
                eof = not self._read_chunk()
                result += self._get_decoded_chars(size - len(result))
            return result

    def __next__(self):
        self._checkAttached()  # (Sagebrush: C's)
        self._telling = False
        line = self.readline()
        if not line:
            self._snapshot = None
            self._telling = self._seekable
            raise StopIteration
        return line

    def readline(self, size=-1):  # (Sagebrush: C's default)
        self._checkAttached()  # (Sagebrush: C's)
        if self.closed:
            raise ValueError("read from closed file")
        # (Sagebrush: C's readline takes an integer, None included in the refusal; __index__ once, checked)
        size = _index(size)
        if not -(1 << 63) <= size < (1 << 63):
            raise OverflowError("Python int too large to convert to C ssize_t")

        # Grab all the decoded text (we will rewind any extra bits later).
        line = self._get_decoded_chars()

        start = 0
        # Make the decoder if it doesn't already exist.
        if not self._decoder:
            self._get_decoder()

        pos = endpos = None
        while True:
            if self._readtranslate:
                # Newlines are already translated, only search for \n
                pos = line.find('\n', start)
                if pos >= 0:
                    endpos = pos + 1
                    break
                else:
                    start = len(line)

            elif self._readuniversal:
                # Universal newline search. Find any of \r, \r\n, \n
                # The decoder ensures that \r\n are not split in two pieces

                # In C we'd look for these in parallel of course.
                nlpos = line.find("\n", start)
                crpos = line.find("\r", start)
                if crpos == -1:
                    if nlpos == -1:
                        # Nothing found
                        start = len(line)
                    else:
                        # Found \n
                        endpos = nlpos + 1
                        break
                elif nlpos == -1:
                    # Found lone \r
                    endpos = crpos + 1
                    break
                elif nlpos < crpos:
                    # Found \n
                    endpos = nlpos + 1
                    break
                elif nlpos == crpos + 1:
                    # Found \r\n
                    endpos = crpos + 2
                    break
                else:
                    # Found \r
                    endpos = crpos + 1
                    break
            else:
                # non-universal
                pos = line.find(self._readnl)
                if pos >= 0:
                    endpos = pos + len(self._readnl)
                    break

            if size >= 0 and len(line) >= size:
                endpos = size  # reached length size
                break

            # No line ending seen yet - get more data'
            while self._read_chunk():
                if self._decoded_chars:
                    break
            if self._decoded_chars:
                line += self._get_decoded_chars()
            else:
                # end of file
                self._set_decoded_chars('')
                self._snapshot = None
                return line

        if size >= 0 and endpos > size:
            endpos = size  # don't exceed size

        # Rewind _decoded_chars to just after the line ending we found.
        self._rewind_decoded_chars(len(line) - endpos)
        return line[:endpos]

    @property
    def newlines(self):
        # (Sagebrush: C's, None for a decoder without newlines, as with newline='\n')
        return getattr(self._decoder, 'newlines', None) if self._decoder else None

    def _dealloc_warn(self, source):
        if dealloc_warn := getattr(self.buffer, "_dealloc_warn", None):
            dealloc_warn(source)


# (Sagebrush: the C classes' module, as their repr shows it)
BufferedWriter.__module__ = "_io"
IncrementalNewlineDecoder.__module__ = "_io"
TextIOWrapper.__module__ = "_io"
