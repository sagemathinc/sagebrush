# imread of every kind of PNG file, against matplotlib's: the files are
# written here, byte for byte (every color type and bit depth, palettes with
# and without tRNS, gray and RGB with tRNS, Adam7 interlacing, odd sizes),
# then read with matplotlib.pyplot.imread, which prints the same under
# CPython with matplotlib (test/png_oracle_gen.py records that) and under
# Sagebrush (test/png.test.ts compares).
import struct
import zlib
import io
import matplotlib.pyplot as plt


def chunk(t, d):
    return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)


CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}
ADAM7 = [(0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)]


def pack_row(samples, depth):
    """One scanline's bytes (with filter type 0) from its samples."""
    if depth == 16:
        return b"\x00" + b"".join(struct.pack(">H", v) for v in samples)
    if depth == 8:
        return b"\x00" + bytes(samples)
    out, acc, bits = [], 0, 0
    for v in samples:
        acc = (acc << depth) | v
        bits += depth
        if bits == 8:
            out.append(acc)
            acc, bits = 0, 0
    if bits:
        out.append(acc << (8 - bits))
    return b"\x00" + bytes(out)


def png(w, h, color, depth, pixel, interlace=False, palette=None, trns=None, extra=b""):
    """A PNG file of w x h pixels; pixel(x, y) gives a pixel's samples."""
    ch = CHANNELS[color]
    rows = []
    if interlace:
        for x0, y0, dx, dy in ADAM7:
            xs = list(range(x0, w, dx))
            if not xs:
                continue
            for y in range(y0, h, dy):
                rows.append(pack_row([s for x in xs for s in pixel(x, y)], depth))
    else:
        for y in range(h):
            rows.append(pack_row([s for x in range(w) for s in pixel(x, y)], depth))
    assert all(len(pixel(0, 0)) == ch for _ in [0])
    out = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, depth, color, 0, 0, 1 if interlace else 0))
    if palette is not None:
        out += chunk(b"PLTE", bytes(v for c in palette for v in c))
    if trns is not None:
        out += chunk(b"tRNS", trns)
    out += extra
    return out + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")


def digest(b):
    h = 0
    for i in range(0, len(b), 4):
        h = (h * 1000003 + int.from_bytes(b[i:i + 4], "little")) % (2 ** 61 - 1)
    return h


def show(name, data):
    try:
        a = plt.imread(io.BytesIO(data))
        flat = a.reshape(-1)
        line = [name, a.shape, a.dtype, digest(a.tobytes()), [round(float(v), 6) for v in flat[:6]]]
        a[(0,) * a.ndim] = 0.5  # writable, as matplotlib's
        print(*line)
    except Exception as e:
        print(name, type(e).__name__)


def val(x, y, k, top):
    return (x * 7 + y * 13 + k * 5) % (top + 1)


cases = []
for depth in (1, 2, 4, 8, 16):
    top = (1 << depth) - 1
    cases.append(("gray%d" % depth, 0, depth, lambda x, y, top=top: (val(x, y, 0, top),), {}))
    cases.append(("gray%d-trns" % depth, 0, depth, lambda x, y, top=top: (val(x, y, 0, top),), {"trns": struct.pack(">H", top // 2)}))
for depth in (8, 16):
    top = (1 << depth) - 1
    cases.append(("rgb%d" % depth, 2, depth, lambda x, y, top=top: tuple(val(x * 31, y * 17, k, top) for k in range(3)), {}))
    cases.append(("rgb%d-trns" % depth, 2, depth, lambda x, y, top=top: tuple(val(x * 31, y * 17, k, top) for k in range(3)), {"trns": struct.pack(">HHH", 1, 2, 3)}))
    cases.append(("graya%d" % depth, 4, depth, lambda x, y, top=top: (val(x * 19, y, 0, top), val(x, y * 23, 1, top)), {}))
    cases.append(("rgba%d" % depth, 6, depth, lambda x, y, top=top: tuple(val(x * 29, y * 11, k, top) for k in range(4)), {}))
for depth in (1, 2, 4, 8):
    n = 1 << depth
    pal = [((i * 37) % 256, (i * 91) % 256, (i * 53) % 256) for i in range(n)]
    cases.append(("pal%d" % depth, 3, depth, lambda x, y, n=n: ((x * 3 + y * 5) % n,), {"palette": pal}))
    cases.append(("pal%d-trns" % depth, 3, depth, lambda x, y, n=n: ((x * 3 + y * 5) % n,), {"palette": pal, "trns": bytes((i * 61) % 256 for i in range(max(1, n // 2)))}))

for w, h in [(1, 1), (5, 3), (9, 7), (17, 2)]:
    for name, color, depth, pixel, kw in cases:
        for interlace in (False, True):
            show("%s %dx%d%s" % (name, w, h, " adam7" if interlace else ""), png(w, h, color, depth, pixel, interlace, **kw))

# chunks matplotlib ignores, and files that are not PNGs or are broken
text = chunk(b"tEXt", b"Comment\x00hello") + chunk(b"zTXt", b"Z\x00\x00" + zlib.compress(b"x" * 1000)) + chunk(b"gAMA", struct.pack(">I", 45455))
show("with text chunks", png(5, 3, 6, 8, lambda x, y: (x, y, 3, 200), extra=text))
good = png(4, 4, 2, 8, lambda x, y: (x * 60, y * 60, 9))
split = good[:good.index(b"IDAT") - 4]
body = zlib.compress(b"".join(b"\x00" + bytes(v for x in range(4) for v in (x * 60, y * 60, 9)) for y in range(4)), 9)
for i in range(0, len(body), 5):
    split += chunk(b"IDAT", body[i:i + 5])
show("IDAT in pieces", split + chunk(b"IEND", b""))
show("truncated", good[:len(good) - 20])
show("bad crc", good[:30] + bytes([good[30] ^ 1]) + good[31:])
show("not a png", b"GIF89a" + b"\x00" * 40)
i = good.index(b"IDAT")
n = struct.unpack(">I", good[i - 4:i])[0]
show("idat crc", good[:i + 4 + n] + bytes([good[i + 4 + n] ^ 1]) + good[i + 5 + n:])
show("idat data", good[:i + 6] + bytes([good[i + 6] ^ 0xff]) + good[i + 7:])
show("no idat", good[:i - 4] + chunk(b"IEND", b""))
show("bad depth", b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 4, 3, 2, 0, 0, 0)) + good[i - 4:])
show("zero width", b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 0, 4, 8, 2, 0, 0, 0)) + good[i - 4:])
show("short idat", good[:i + 4] + good[i + 4:i + 4 + n - 10])
show("only the signature", b"\x89PNG\r\n\x1a\n")
show("text crc", good[:33] + chunk(b"tEXt", b"a\x00b")[:-1] + b"\x00" + good[33:])
show("palette missing", b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 3, 0, 0, 0))
     + chunk(b"IDAT", zlib.compress(b"\x00\x00\x01\x00\x01\x00")) + chunk(b"IEND", b""))
show("palette index past its end", b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 3, 0, 0, 0))
     + chunk(b"PLTE", b"\x10\x20\x30") + chunk(b"IDAT", zlib.compress(b"\x00\x00\x05\x00\x01\x00")) + chunk(b"IEND", b""))
show("empty", b"")
