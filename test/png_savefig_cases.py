# savefig's PNG files against matplotlib's: their size, color type, bit
# depth, resolution (pHYs), text keys, and what imread reads back from them
# (shape, dtype, corner pixel), for figure sizes and dpis whose pixel sizes
# round, backgrounds and metadata.  The drawing itself differs (tiny-skia is
# not Agg), so pixels are compared only where nothing is drawn.  CPython with
# matplotlib prints what test/png_oracle_gen.py records; Sagebrush must print
# the same (test/png.test.ts).
import io
import os
import struct
import tempfile
import matplotlib.pyplot as plt


def chunks(data):
    i, out = 8, []
    while i + 8 <= len(data):
        n = struct.unpack(">I", data[i:i + 4])[0]
        out.append((data[i + 4:i + 8].decode("latin-1"), data[i + 8:i + 8 + n]))
        i += 12 + n
    return out


def describe(label, data):
    cs = chunks(data)
    w, h, depth, color = struct.unpack(">IIBB", cs[0][1][:10])
    phys = [struct.unpack(">IIB", d) for k, d in cs if k == "pHYs"]
    keys = sorted(d.split(b"\0", 1)[0].decode("latin-1") for k, d in cs if k in ("tEXt", "iTXt", "zTXt"))
    a = plt.imread(io.BytesIO(data))
    corner = [round(float(v), 4) for v in a[0, 0]]
    print(label, (w, h), "depth", depth, "color", color, "pHYs", phys, "text", keys, a.shape, a.dtype, "corner", corner)


def save(label, fig, **kw):
    b = io.BytesIO()
    fig.savefig(b, format="png", **kw)
    describe(label, b.getvalue())
    plt.close(fig)


def figure(**kw):
    fig = plt.figure(**kw)
    ax = fig.add_subplot()
    ax.plot([0, 1, 2], [0, 1, 0.5], label="a line")
    ax.set_title("title")
    return fig


for figsize, dpi in [((6.4, 4.8), None), ((6.4, 4.8), 72), ((5.55, 3), 100), ((3.33, 2.17), 150), ((1.005, 1.005), 100),
                     ((2.675, 1), 200), ((4, 3), 50.5), ((2, 2), 300)]:
    save("figsize %s dpi %s" % (figsize, dpi), figure(figsize=figsize), **({} if dpi is None else {"dpi": dpi}))
save("figure dpi 110", figure(figsize=(3, 2), dpi=110))
save("figure dpi 110, savefig dpi 'figure'", figure(figsize=(3, 2), dpi=110), dpi="figure")
save("transparent", figure(figsize=(3, 2)), transparent=True)
save("facecolor red", figure(figsize=(3, 2)), facecolor="red")
save("facecolor tuple", figure(figsize=(3, 2)), facecolor=(0.2, 0.4, 0.6))
save("facecolor with alpha", figure(figsize=(3, 2)), facecolor=(0.2, 0.4, 0.6, 0.5))
save("figure facecolor", figure(figsize=(3, 2), facecolor="yellow"))
save("metadata added", figure(figsize=(3, 2)), metadata={"Title": "a title", "Author": "me"})
save("metadata Software removed", figure(figsize=(3, 2)), metadata={"Software": None})

# pyplot's savefig, file names, the default format
d = tempfile.mkdtemp()
plt.figure(figsize=(2, 1.5))
plt.plot([1, 2, 3])
for name in ["a.png", "b", "c.", "D.PNG"]:
    plt.savefig(os.path.join(d, name))
print(sorted(os.listdir(d)))
for name in sorted(os.listdir(d)):
    with open(os.path.join(d, name), "rb") as f:
        describe(name, f.read())
plt.savefig(os.path.join(d, "e.svg"))
with open(os.path.join(d, "e.svg"), "rb") as f:
    print("svg", b"<svg" in f.read())
plt.savefig(os.path.join(d, "f.svg"), format="png")
with open(os.path.join(d, "f.svg"), "rb") as f:
    print("format beats the name", f.read(8) == b"\x89PNG\r\n\x1a\n")
b = io.BytesIO()
plt.savefig(b)
print("a file object gets PNG", b.getvalue()[:8] == b"\x89PNG\r\n\x1a\n")
a = plt.imread(os.path.join(d, "a.png"))
print("imread of savefig", a.shape, a.dtype, float(a.min()) >= 0, float(a.max()) <= 1, bool((a[..., 3] == 1).all()))
for bad in ["x.xyz"]:
    try:
        plt.savefig(os.path.join(d, bad))
    except ValueError as e:
        print("ValueError", e)
