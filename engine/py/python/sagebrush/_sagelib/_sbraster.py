"""_sbraster under CPython: Sagebrush's PNG module (engine/raster), with the
browser runtime's interface (src/runtime/raster.ts), which lib/_png.py uses.

Each call runs in the PNG engine's own process (_raster_child: PNG plan r8
section 2.3), with memory admitted by the ledger (lib/_memledger.py, r8
section 2.1): one call at a time, under the call lock; the host's buffers
reserved exactly (r8 section 2.5), then all that remains granted to the
engine, whose process is limited to it where the limit can be enforced.
SAGEBRUSH_RASTER_ISOLATION=in-process runs the engine inside Python instead
(no protection against crashes or memory exhaustion)."""

import re
import struct
import sys

import _memledger
import _raster_child as rc

_child = None
_last_grant = 0
# (CPython object headers: a bytes object's, a bytearray's, a memoryview's,
# measured once)
_H_BYTES = sys.getsizeof(b"")
_H_BYTEARRAY = sys.getsizeof(bytearray())
_H_VIEW = sys.getsizeof(memoryview(b""))


def loaded():
    return True


def _in_process():
    from sagebrush._native import raster
    if "in-process" not in rc._warned:
        rc._warned.add("in-process")
        sys.stderr.write("Sagebrush runs its PNG engine inside Python here (SAGEBRUSH_RASTER_ISOLATION=in-process): "
                         "without protection against crashes and memory exhaustion.\n")
    return raster


def _text_bytes(text):
    """The PNG text chunks in their wire form: each key and value, UTF-8,
    after its length (u32, little-endian)."""
    parts = []
    for k, v in text:
        for x in (k, v):
            b = str(x).encode("utf-8")
            parts.append(struct.pack("<I", len(b)))
            parts.append(b)
    return b"".join(parts)


_NUM = re.compile(r"^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(?:px)?\s*$")


def _drawing_size(svg, scale):
    """The picture's size for a 0 x 0 request (the drawing's own, rounded),
    as engine/raster/src/svg.rs::render takes it: the root's width and
    height, else its viewBox's."""
    m = re.search(r"<svg\b([^>]*)>", svg)
    if not m:
        raise ValueError("no <svg> element")
    attrs = dict(re.findall(r"""([\w:-]+)\s*=\s*["']([^"']*)["']""", m.group(1)))
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
    _memledger.ledger().set_standing(None)


def _start(grant, want):
    """A child started under the grant; READY read, or the startup's
    outcome raised.  Returns it."""
    c = rc.spawn(grant, want)
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
        if isinstance(err, rc.FootprintRefused):
            if want == "enforced":
                raise rc.SagebrushEngineError("SAGEBRUSH_RASTER_ISOLATION=enforced: the PNG engine's launcher used %d bytes "
                                              "before its limit, more than this host's bound" % err.observed) from None
            rc._warn("its launcher's footprint, %d bytes, is past the bound computed for this host" % err.observed)
            return rc.spawn_contained([sys.executable, "-I", "-S", "-c", rc.PRELUDE, rc._ext_path()], {"LC_ALL": "C"},
                                      __import__("tempfile").TemporaryFile())
        if isinstance(e, rc.ProtocolError) and not frames:
            raise rc.SagebrushEngineError("the PNG engine sent an invalid reply at its start (%s), a Sagebrush bug" % e) from None
        raise err from None
    except BaseException:
        c.kill()
        raise


def _call(kind, parts, bounds, host, need):
    """One request: admitted, sent, and its reply's (kind, payload); the
    caller's outputs are made resident by it (resident(...))."""
    global _child
    want = rc.mode()
    led = _memledger.ledger()
    _acquire(led.call_lock)
    try:
        for attempt in (0, 1):
            child = _child
            try:
                room = led.rebase(child=(lambda: (child.charge(), child.rss())) if child is not None else None)
            except _memledger.NeedReap:
                _reap()
                continue
            if room < host + need and _child is not None and attempt == 0:
                # (a warm engine whose memory the call needs: ended, and the
                # memory observed again, once)
                _reap()
                continue
            break
        if room < host + need:
            import _memguard
            raise _memguard.memory_guard("This PNG", host + need, room, "PNG work")
        hrec = led.reserve("host", "cpython-heap", host)
        erec = led.grant("child")
        grant = erec.bytes
        global _last_grant
        _last_grant = grant
        child = _child
        killed = False
        try:
            if child is None:
                child = _child = _start(grant, want)
            elif child.enforced:
                # (the idle limit is its VmSize after the last call, and the
                # idle loop allocates nothing: the base of this call's)
                child.set_limit(child.limit + grant)
            oom0 = rc._oom_kills()
            total = sum(len(memoryview(p).cast("B")) for p in parts)
            try:
                rc.write_all(child, [struct.pack("<IIQ", rc.MAGIC, kind, total)] + list(parts))
                k, n = rc.read_frame(child, bounds)
                payload = bytearray(n)
                rc.read_into(child, payload)
            except rc.ProtocolError as e:
                killed = True
                _reap()
                raise rc.SagebrushEngineError("the PNG engine sent an invalid reply (%s), a Sagebrush bug" % e) from None
            except rc._Exited:
                status = child.reap()
                _child = None
                led.set_standing(None)
                raise rc.classify(child, status, [], grant, False, oom0, False) from None
            except BaseException:
                # (Ctrl-C, or anything else, during the exchange: the child
                # ended at once, its memory with it)
                killed = True
                _reap()
                raise
            return k, payload
        finally:
            if _child is not None and not killed:
                if _child.enforced:
                    _child.set_limit(_child.vmsize() or _child.limit)
                led.set_standing(_child.charge())
            led.release(erec)
            led.release(hrec)
    finally:
        led.call_lock.release()


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


def render(svg, scale, width, height, background, dpi, text):
    """(PNG bytes, the characters the font lacked): svg drawn at scale pixels
    per SVG unit on width x height pixels (0 x 0: the drawing's size), on
    background (a CSS color; None or "" for transparent)."""
    svg, scale, dpi = str(svg), float(scale), float(dpi)
    bg = "" if background is None else str(background)
    text = [(str(k), str(v)) for k, v in text]
    if rc.mode() == "in-process":
        return _in_process().raster_render(svg, scale, int(width), int(height), bg, dpi, text)
    w, h = int(width), int(height)
    pw, ph = (w, h) if (w or h) else _drawing_size(svg, scale)
    s, t, b = svg.encode("utf-8"), _text_bytes(text), bg.encode("utf-8")
    head = struct.pack("<fIIfQQQ", scale, w, h, dpi, len(s), len(t), len(b))
    pmax = png_bound(pw, ph, len(t), len(text))
    msg = len(s) + len(t) + len(b) + 256
    # (r8 section 2.5: the request's buffers, aliased into its frames; then
    # the reply, read into one bytearray, the PNG copied out of it once,
    # and the missing characters' str: summed, not maxed)
    host = (len(s) + _H_BYTES + len(t) + _H_BYTES + len(b) + _H_BYTES + 40 + 16 + 4 * _H_VIEW
            + 16 + pmax + len(s) + _H_BYTEARRAY + pmax + _H_BYTES + 4 * len(s) + 80)
    k, payload = _call(rc.RENDER, [head, s, t, b], {rc.OK_RENDER: 16 + pmax + len(s), rc.ERR_INPUT: msg,
                                                       rc.ERR_BACKEND: msg, rc.ERR_MEMORY: 8 + 256}, host, 4 * pw * ph)
    if k != rc.OK_RENDER:
        _outcome(k, payload)
    n, m = struct.unpack_from("<QQ", payload)
    if 16 + n + m != len(payload):
        raise rc.SagebrushEngineError("the PNG engine sent an invalid reply (its parts don't add up), a Sagebrush bug")
    png = bytes(memoryview(payload)[16:16 + n])
    missing = memoryview(payload)[16 + n:].tobytes().decode("utf-8")
    del payload
    _memledger.ledger().resident(len(png) + _H_BYTES, "cpython-heap")
    return png, missing


_CHANNELS = {0: 1, 2: 3, 3: 4, 4: 4, 6: 4}   # (color type -> the values a pixel, as imread returns them)


def _ihdr(png):
    """(width, height, the values a pixel) from the file's IHDR, or None."""
    if len(png) >= 33 and bytes(png[12:16]) == b"IHDR":
        w, h = struct.unpack_from(">II", png, 16)
        ct = png[25]
        if ct in _CHANNELS:
            return w, h, _CHANNELS[ct]
    return None


def decode(png):
    """(width, height, channels, the float32 values: a NumPy array, read
    into directly).  bytes are passed as they are."""
    if rc.mode() == "in-process":
        if not isinstance(png, bytes):
            png = bytes(png)
        return _in_process().raster_decode(png)
    import numpy as np
    view = memoryview(png).cast("B")
    size = _ihdr(view)
    values = 4 * size[0] * size[1] * size[2] if size else 0
    msg = 4096
    # (the file as it is, aliased; the values read straight into the array)
    host = len(view) + _H_VIEW + 16 + _H_BYTEARRAY + values + 112
    k, payload = _call(rc.DECODE, [view], {rc.OK_DECODE: 16 + values, rc.ERR_INPUT: msg, rc.ERR_BACKEND: msg,
                                            rc.ERR_MEMORY: 8 + 256}, host, values)
    if k != rc.OK_DECODE:
        _outcome(k, payload)
    w, h, ch, _ = struct.unpack_from("<IIII", payload)
    arr = np.frombuffer(payload, dtype=np.float32, offset=16)
    if arr.size * 4 + 16 != len(payload) or arr.size != w * h * (4 if ch == 4 else ch):
        raise rc.SagebrushEngineError("the PNG engine sent an invalid reply (its values don't match its size), a Sagebrush bug")
    # (the array is a view of the reply's buffer: no copy; the buffer goes
    # when the array does, which releases its charge)
    _memledger.ledger().resident(len(payload) + _H_BYTEARRAY, "cpython-heap", owner=arr)
    return w, h, ch, arr
