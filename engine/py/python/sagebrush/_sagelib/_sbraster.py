"""_sbraster under CPython: Sagebrush's PNG module (engine/raster), with the
browser runtime's interface (src/runtime/raster.ts), which lib/_png.py uses.

Each call runs in the PNG engine's own process (_raster_child: PNG plan r8
section 2.3), with memory admitted by the ledger (lib/_memledger.py, r8
section 2.1): one call at a time, under the call lock, which is held from
before the first reservation until the call's end:

1. the lock taken; the memory observed (the re-base);
2. the call's sizes computed from its inputs, without materialising them;
   the minimum need checked (the host's buffers, the engine's least, and a
   new engine process's pre-limit footprint);
3. the host's buffers reserved exactly (r8 section 2.5), then all that
   remains granted to the engine; only then the request encoded;
4. the exchange; the reply validated and the outputs built, still under the
   reservation;
5. the end, in one ledger step (end_call): the grant replaced by the engine's
   standing charge, the outputs made resident records, the rest refunded;
   then the lock released.

SAGEBRUSH_RASTER_ISOLATION=in-process runs the engine inside Python instead,
admitted the same way (no protection against crashes or memory exhaustion:
admission only, r8 section 2.6)."""

import re
import struct
import sys

import _memledger
import _raster_child as rc

_child = None
_last_grant = 0
# (CPython object headers, measured once: a bytes object's, a bytearray's, a
# memoryview's; an ndarray's, at the first decode)
_H_BYTES = sys.getsizeof(b"")
_H_BYTEARRAY = sys.getsizeof(bytearray())
_H_VIEW = sys.getsizeof(memoryview(b""))
_H_ND = None
# (the characters encoded at a time to measure a str's UTF-8 length without
# encoding it whole: a constant transient, not a limit)
_CHUNK = 4096
# (the call's own bookkeeping, measured: its small objects (frame headers,
# memoryviews, the ledger's records, the /proc reads' few hundred bytes):
# a fixed allowance in every host reservation, not proportional to anything)
BOOKKEEPING = 16 << 10
# (a test's pause point: called under the call lock and the reservation,
# with the reply read and nothing built from it yet)
_after_reply = None


class _Buf(bytearray):
    """A bytearray that CPython can reference weakly: the buffer a decode's
    values are read into, whose record is released by its own finalizer,
    when the last array or view of it is gone."""

    __slots__ = ("__weakref__",)


class _Str(str):
    """A str that CPython can reference weakly: the characters a render's
    font lacked, released by its finalizer."""


class UntrackedOutput(RuntimeError):
    """The PNG a render returns couldn't be accounted for here: Sagebrush
    sees no memory figure for this process (it runs on SAGEBRUSH_MEMORY_BYTES
    alone), and a PNG's bytes, once returned, give no sign of when they are
    freed.  Not a memory shortage."""


UNTRACKED = ("Sagebrush can't write this PNG here. It runs on SAGEBRUSH_MEMORY_BYTES because it can't see this "
             "process's memory, and a PNG's bytes, once returned, can't be tracked until they are freed, so they "
             "can't be kept within that figure. Reading PNG files (imread) works here. Save the figure as SVG "
             "(a .svg file name), or run where Sagebrush can see the memory (a cgroup limit or /proc/meminfo).")


def loaded():
    return True


def _in_process():
    from sagebrush._native import raster
    if "in-process" not in rc._warned:
        rc._warned.add("in-process")
        sys.stderr.write("Sagebrush runs its PNG engine inside Python here (SAGEBRUSH_RASTER_ISOLATION=in-process): "
                         "without protection against crashes and memory exhaustion.\n")
    return raster


def _utf8_len(s):
    """The bytes of s in UTF-8, without encoding it whole: an ASCII str's
    length, else its encoding measured a chunk at a time (a lone surrogate
    raises UnicodeEncodeError, as encoding it would)."""
    if s.isascii():
        return len(s)
    n = 0
    for i in range(0, len(s), _CHUNK):
        n += len(s[i:i + _CHUNK].encode("utf-8"))
    return n


def _encode_into(buf, at, s):
    """s's UTF-8 written into buf at `at`, a chunk at a time; the next offset."""
    for i in range(0, len(s), _CHUNK):
        c = s[i:i + _CHUNK].encode("utf-8")
        buf[at:at + len(c)] = c
        at += len(c)
    return at


def _text_len(text):
    """The text chunks' wire form's length: each key and value, UTF-8, after
    its length (u32, little-endian)."""
    return sum(8 + _utf8_len(k) + _utf8_len(v) for k, v in text)


def _text_bytes(text, total):
    """The text chunks in their wire form, in one bytearray of `total`
    bytes (r8 section 2.5, R1)."""
    buf = bytearray(total)
    at = 0
    for k, v in text:
        for x in (k, v):
            n = _utf8_len(x)
            struct.pack_into("<I", buf, at, n)
            at = _encode_into(buf, at + 4, x)
    return buf


_NUM = re.compile(r"^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(?:px)?\s*$")
_ROOT = re.compile(r"<svg\b[^>]*>")
_SIZE_ATTR = re.compile(r"""\b(width|height|viewBox)\s*=\s*["']([^"']*)["']""")


def _drawing_size(svg, scale):
    """The picture's size for a 0 x 0 request (the drawing's own, rounded),
    as engine/raster/src/svg.rs::render takes it: the root's width and
    height, else its viewBox's.  Only those three attributes are read out of
    the root tag (the SVG itself is not copied)."""
    m = _ROOT.search(svg)
    if not m:
        raise ValueError("no <svg> element")
    attrs = {}
    for a in _SIZE_ATTR.finditer(svg, m.start() + 4, m.end() - 1):
        attrs.setdefault(a.group(1), a.group(2))
    vb = [float(x) for x in re.split(r"[\s,]+", attrs.get("viewBox", "").strip()) if x] if "viewBox" in attrs else []

    def num(k, i):
        if k in attrs:
            n = _NUM.match(attrs[k])
            if not n:
                raise ValueError("the number %r" % attrs[k])
            return float(n.group(1))
        return vb[i] if len(vb) == 4 else 0.0
    w, h = num("width", 2), num("height", 3)
    if not (w > 0 and h > 0 and scale > 0):
        raise ValueError("a drawing with no size")
    return int(round(w * scale)), int(round(h * scale))


def png_bound(w, h, text_len, pairs):
    """The most bytes the engine's PNG of w x h pixels can be (it is RGBA,
    8 bits, with pHYs and the text chunks): the rows' bytes plus deflate's
    worst case for them (its stored blocks, generously), plus every chunk's
    framing."""
    raw = h * (1 + 4 * w)
    z = raw + raw // 4 + 4096
    return 8 + 25 + 21 + 12 + text_len + 18 * pairs + z + 12 * (-(-z // 1024))


def _acquire(lock):
    # (a wait that Ctrl-C ends, holding nothing)
    while not lock.acquire(True, rc._WAKE):
        pass


def _reap():
    global _child
    c, _child = _child, None
    if c is not None:
        c.kill()
    # (its charge drops only now, after waitpid)
    _memledger.ledger().set_standing(None)


def _handshake(c, grant):
    """READY read from a new child, which is returned; or the startup's
    outcome raised, the child reaped (FootprintRefused for the launcher's
    footprint check)."""
    frames = []
    try:
        while True:
            k, n = rc.read_frame(c, {rc.READY: 8, rc.ERR_START: 16, rc.ERR_INPUT: 4096, rc.ERR_BACKEND: 4096})
            payload = bytearray(n)
            rc.read_into(c, payload)
            if k == rc.READY:
                return c
            frames.append((k, bytes(payload)))
    except (rc._Exited, rc.ProtocolError) as e:
        status = c.reap()
        err = rc.classify(c, status, frames, grant, False, None, True)
        if isinstance(e, rc.ProtocolError) and not frames and not isinstance(err, rc.FootprintRefused):
            raise rc.SagebrushEngineError("the PNG engine sent an invalid reply at its start (%s), a Sagebrush bug" % e) from None
        raise err from None
    except BaseException:
        c.kill()
        raise


def _start(grant, want, plan):
    """A child started under the grant, by the plan rc.launch_plan made; its
    READY read (for a replacement too), or the startup's outcome raised."""
    c = rc.spawn(grant, plan)
    try:
        return _handshake(c, grant)
    except rc.FootprintRefused as err:
        if want == "enforced":
            raise rc.SagebrushEngineError("SAGEBRUSH_RASTER_ISOLATION=enforced: the PNG engine's launcher used %d bytes "
                                          "before its limit, more than this host's bound" % err.observed) from None
        rc._warn("its launcher's footprint, %d bytes, is past the bound computed for this host" % err.observed)
        # (the same startup, handshake included, for the replacement)
        return _handshake(rc.spawn(grant, rc.contained(plan)), grant)


class _Call:
    """The admitted call: its records, its grant, and what its end does."""

    __slots__ = ("led", "host", "engine", "grant", "standing", "outputs")


def _admit(host_need, observed=(), engine=True):
    """Steps 1 to 3: the call lock taken (and kept, until _finish), the
    re-base, then host_need() -> (host bytes, the engine's least need,
    anything the caller keeps), computed only now; the minimum need checked; the host reserved, the rest
    granted.  observed: the domains the outputs live in, each of which this
    observation must cover (UntrackedOutput before anything is computed, if
    not).  engine: whether a child process is used (not in-process).
    Returns (the call, what host_need kept)."""
    global _child, _last_grant
    led = _memledger.ledger()
    _acquire(led.call_lock)
    try:
        want = rc.mode()
        for attempt in (0, 1):
            child = _child if engine else None
            try:
                room = led.rebase(child=(lambda: (child.charge(), child.rss())) if child is not None else None)
            except _memledger.NeedReap:
                _reap()
                continue
            seen = set((led.last or {}).get("domains") or ())
            for d in observed:
                if d not in seen:
                    raise UntrackedOutput(UNTRACKED)
            host, need, kept = host_need()
            # (a new engine process's footprint before its limit, r8 section
            # 2.3: charged in its startup grant, so in the minimum need)
            plan = rc.launch_plan(want) if engine and _child is None else None
            pre = plan.bound if plan is not None else 0
            if room < host + need + pre and engine and _child is not None and attempt == 0:
                # (a warm engine whose memory the call needs: ended, and the
                # memory observed again, once)
                _reap()
                continue
            break
        if room < host + need + pre:
            import _memguard
            raise _memguard.memory_guard("This PNG", host + need + pre, room, "PNG work")
        c = _Call()
        c.led, c.standing, c.outputs = led, _memledger.Ledger.KEEP, ()
        c.host = led.reserve("host", "cpython-heap", host)
        try:
            c.engine = led.grant("child" if engine else "cpython-heap")
        except BaseException:
            led.end_call(c.host, None)
            raise
        c.grant = c.engine.bytes
        _last_grant = c.grant
        return c, (kept, plan, want)
    except BaseException:
        led.call_lock.release()
        raise


def _finish(c):
    """Step 5: the end, in one ledger step, then the call lock released."""
    try:
        c.led.end_call(c.host, c.engine, c.standing, c.outputs)
    finally:
        c.led.call_lock.release()


def _exchange(c, kind, parts, bounds, plan, want):
    """The request sent to the child (started now if there is none) and its
    reply's (kind, payload) read; c.standing set from the child as it is
    after (None: ended)."""
    global _child
    child = _child
    if child is None:
        child = _child = _start(c.grant, want, plan)
        rss0 = 0
    else:
        rss0 = c.led.child_rss
        if child.enforced:
            # (the idle limit is its VmSize after the last call, and the idle
            # loop allocates nothing: the base of this call's)
            child.set_limit(child.limit + c.grant)
    oom0 = rc._oom_kills()
    total = sum(len(memoryview(p).cast("B")) for p in parts)
    try:
        rc.write_all(child, [struct.pack("<IIQ", rc.MAGIC, kind, total)] + list(parts))
        k, n = rc.read_frame(child, bounds)
        payload = _Buf(n)
        rc.read_into(child, payload)
    except rc.ProtocolError as e:
        _reap()
        c.standing = None
        raise rc.SagebrushEngineError("the PNG engine sent an invalid reply (%s), a Sagebrush bug" % e) from None
    except rc._Exited:
        status = child.reap()
        _child = None
        c.standing = None
        raise rc.classify(child, status, [], c.grant, False, oom0, False) from None
    except BaseException:
        # (Ctrl-C, or anything else, during the exchange: the child ended at
        # once, its memory with it)
        _reap()
        c.standing = None
        raise
    if child.enforced:
        child.set_limit(child.vmsize() or child.limit)
    # (its new standing charge: its limit (or, contained, what is resident)
    # less what the re-base already observed resident)
    c.standing = max(0, child.charge() - rss0)
    if _after_reply is not None:
        _after_reply()
    return k, payload


def _outcome(k, payload):
    """ERR_* replies raised (the child alive): the input refused a
    ValueError, a memory refusal the memory error, the engine failing
    SagebrushEngineError."""
    if k == rc.ERR_INPUT:
        raise ValueError(payload.decode("utf-8", "replace"))
    if k == rc.ERR_BACKEND:
        raise rc.SagebrushEngineError("Sagebrush's PNG module: " + payload.decode("utf-8", "replace"))
    if k == rc.ERR_MEMORY:
        n, = struct.unpack_from("<Q", payload)
        what = payload[8:].decode("utf-8", "replace")
        raise rc._memory("ran out of the %d bytes Sagebrush could give it (%s needed %d bytes)" % (_last_grant, what, n), _last_grant)


def _missing(raw):
    """The characters the font lacked, as a _Str (decoded from raw, then
    copied into the subclass: two copies, both in H_host)."""
    return str.__new__(_Str, raw, "utf-8")


def render_host(b, t, g, pmax):
    """H_host of a render (r8 section 2.5), for an SVG of b UTF-8 bytes, text
    chunks of t, a background of g and a PNG of at most pmax: R1 (the SVG's
    bytes, the text's one bytearray, the background's bytes, the frame
    header and the memoryviews aliasing them into the request), plus R3 (the
    reply's bytearray, the PNG copied out of it, the missing characters'
    bytes, their str and its _Str copy), summed."""
    r1 = b + _H_BYTES + t + _H_BYTEARRAY + g + _H_BYTES + 40 + 16 + _H_BYTES + 8 * _H_VIEW
    missing = b + _H_BYTES + 2 * (4 * b + 80 + sys.getsizeof(_Str()))
    r3 = 16 + pmax + b + sys.getsizeof(_Buf()) + 16 + pmax + _H_BYTES + 3 * _H_VIEW + missing
    return r1 + r3 + BOOKKEEPING


def render(svg, scale, width, height, background, dpi, text):
    """(PNG bytes, the characters the font lacked): svg drawn at scale pixels
    per SVG unit on width x height pixels (0 x 0: the drawing's size), on
    background (a CSS color; None or "" for transparent)."""
    svg, scale, dpi = str(svg), float(scale), float(dpi)
    bg = "" if background is None else str(background)
    text = [(str(k), str(v)) for k, v in text]
    w, h = int(width), int(height)
    inproc = rc.mode() == "in-process"

    def sizes():
        # (lengths only: nothing of the request is made before admission)
        pw, ph = (w, h) if (w or h) else _drawing_size(svg, scale)
        b, t, g = _utf8_len(svg), _text_len(text), _utf8_len(bg)
        pmax = png_bound(pw, ph, t, len(text))
        # (the engine's least: the picture's pixels)
        return render_host(b, t, g, pmax), 4 * pw * ph, (pw, ph, b, t, pmax)

    # (the returned PNG is a plain bytes, which nothing can follow to its
    # release: only an observation that covers CPython's heap accounts for it,
    # so without one this refuses, before anything is computed)
    c, ((pw, ph, b, t, pmax), plan, want) = _admit(sizes, observed=("cpython-heap",), engine=not inproc)
    try:
        if inproc:
            png, missing = _in_process().raster_render(svg, scale, w, h, bg, dpi, text)
            missing = _missing(missing.encode("utf-8")) if missing else _Str()
        else:
            s = svg.encode("utf-8")
            tb = _text_bytes(text, t)
            g = bg.encode("utf-8")
            head = struct.pack("<fIIfQQQ", scale, w, h, dpi, len(s), len(tb), len(g))
            msg = len(s) + len(tb) + len(g) + 256
            k, payload = _exchange(c, rc.RENDER, [head, s, tb, g], {rc.OK_RENDER: 16 + pmax + len(s), rc.ERR_INPUT: msg,
                                                                     rc.ERR_BACKEND: msg, rc.ERR_MEMORY: 8 + 256}, plan, want)
            del s, tb, g
            if k != rc.OK_RENDER:
                _outcome(k, payload)
            n, m = struct.unpack_from("<QQ", payload)
            if 16 + n + m != len(payload):
                raise rc.SagebrushEngineError("the PNG engine sent an invalid reply (its parts don't add up), a Sagebrush bug")
            png = bytes(memoryview(payload)[16:16 + n])
            missing = _missing(memoryview(payload)[16 + n:].tobytes())
            del payload
        # (the outputs, at their actual sizes, carved out of the host
        # reservation by _finish: the PNG absorbed by the next observation,
        # the str released by its finalizer)
        c.outputs = [(sys.getsizeof(png), "cpython-heap", None), (sys.getsizeof(missing), "cpython-heap", missing)]
        return png, missing
    finally:
        _finish(c)


_CHANNELS = {0: 1, 2: 3, 3: 4, 4: 4, 6: 4}   # (color type -> the values a pixel, as imread returns them)


def _ihdr(png):
    """(width, height, the values a pixel) from the file's IHDR, or None."""
    if len(png) >= 33 and bytes(png[12:16]) == b"IHDR":
        w, h = struct.unpack_from(">II", png, 16)
        ct = png[25]
        if ct in _CHANNELS:
            return w, h, _CHANNELS[ct]
    return None


def decode_host(n, values):
    """H_host of a decode (r8 section 2.5): the file (aliased: its memoryviews
    and the frame header) and the reply's _Buf of 16 + values bytes, with the
    ndarray header over it; in-process, the engine's bytes of values too."""
    return n + 2 * _H_VIEW + 16 + _H_BYTES + sys.getsizeof(_Buf()) + 16 + values + _H_VIEW + _H_ND + BOOKKEEPING


def decode(png):
    """(width, height, channels, the float32 values: a NumPy array, read
    into directly).  bytes are passed as they are."""
    global _H_ND
    import numpy as np
    if _H_ND is None:
        _H_ND = sys.getsizeof(np.frombuffer(_Buf(4), dtype=np.float32))
    inproc = rc.mode() == "in-process"
    view = memoryview(png).cast("B")

    def sizes():
        size = _ihdr(view)
        values = 4 * size[0] * size[1] * size[2] if size else 0
        host = decode_host(len(view), values)
        if inproc:
            # (the engine's values as bytes, copied into the buffer; and the
            # file as bytes, if it isn't one)
            host += values + _H_BYTES + (0 if isinstance(png, bytes) else len(view) + _H_BYTES)
        return host, values, values

    # (the values' buffer, released by its own finalizer: any observation)
    c, (values, plan, want) = _admit(sizes, engine=not inproc)
    try:
        if inproc:
            w, h, ch, raw = _in_process().raster_decode(view.tobytes() if not isinstance(png, bytes) else png)
            payload = _Buf(16 + len(raw))
            payload[16:] = raw
            del raw
        else:
            msg = 4096
            k, payload = _exchange(c, rc.DECODE, [view], {rc.OK_DECODE: 16 + values, rc.ERR_INPUT: msg, rc.ERR_BACKEND: msg,
                                                          rc.ERR_MEMORY: 8 + 256}, plan, want)
            if k != rc.OK_DECODE:
                _outcome(k, payload)
            w, h, ch, _ = struct.unpack_from("<IIII", payload)
        arr = np.frombuffer(payload, dtype=np.float32, offset=16)
        if arr.size * 4 + 16 != len(payload) or arr.size != w * h * (4 if ch == 4 else ch):
            raise rc.SagebrushEngineError("the PNG engine sent an invalid reply (its values don't match its size), a Sagebrush bug")
        # (the array is a view of the reply's buffer: no copy.  The buffer's
        # record is released by the buffer's own finalizer, when the last
        # array or view of it (a reshape, a memoryview) is gone; the array's
        # header by the array's, and the memoryview NumPy holds the buffer
        # through, if any, by its own)
        c.outputs = [(sys.getsizeof(payload), "cpython-heap", payload), (sys.getsizeof(arr), "cpython-heap", arr)]
        if isinstance(arr.base, memoryview):
            c.outputs.append((sys.getsizeof(arr.base), "cpython-heap", arr.base))
        del payload
        return w, h, ch, arr
    finally:
        _finish(c)

