# Graphics.save: a PNG for a .png name (the signature and a picture wider
# than tall, and twice the pixels at twice the dpi, up to cropping), and
# Sage's error for an extension it does not write.  (Sizes themselves
# differ: Sage crops its PNG to the drawing.)
import os, tempfile, struct
d = tempfile.mkdtemp()
G = plot(prime_pi, 1, 100, axes_labels=['$x$', '$\\pi(x)$'])
def size(name):
    G.save(os.path.join(d, name), **({'dpi': 200} if '200' in name else {}))
    b = open(os.path.join(d, name), 'rb').read()
    return b[:8], struct.unpack('>II', b[16:24])
sig, (w, h) = size('a.png')
_, (w2, h2) = size('a200.png')
print(sig == b'\x89PNG\r\n\x1a\n', w > h, abs(w2 - 2*w) <= 30 and abs(h2 - 2*h) <= 30)
G.save(os.path.join(d, 'a.svg')); print(open(os.path.join(d, 'a.svg')).read().lstrip()[:4] in ('<svg', '<?xm'))
try:
    G.save(os.path.join(d, 'a.jpg'))
except ValueError as e:
    print(e)
