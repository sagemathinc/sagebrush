# Generated from ../test_plot_save.sage by Sage's preparser (run_cpython.py --regen).
_sage_const_1 = Integer(1); _sage_const_100 = Integer(100); _sage_const_200 = Integer(200); _sage_const_8 = Integer(8); _sage_const_16 = Integer(16); _sage_const_24 = Integer(24); _sage_const_2 = Integer(2); _sage_const_30 = Integer(30); _sage_const_4 = Integer(4)# Graphics.save: a PNG for a .png name (the signature and a picture wider
# than tall, and twice the pixels at twice the dpi, up to cropping), and
# Sage's error for an extension it does not write.  (Sizes themselves
# differ: Sage crops its PNG to the drawing.)
import os, tempfile, struct
d = tempfile.mkdtemp()
G = plot(prime_pi, _sage_const_1 , _sage_const_100 , axes_labels=['$x$', '$\\pi(x)$'])
def size(name):
    G.save(os.path.join(d, name), **({'dpi': _sage_const_200 } if '200' in name else {}))
    b = open(os.path.join(d, name), 'rb').read()
    return b[:_sage_const_8 ], struct.unpack('>II', b[_sage_const_16 :_sage_const_24 ])
sig, (w, h) = size('a.png')
_, (w2, h2) = size('a200.png')
print(sig == b'\x89PNG\r\n\x1a\n', w > h, abs(w2 - _sage_const_2 *w) <= _sage_const_30  and abs(h2 - _sage_const_2 *h) <= _sage_const_30 )
G.save(os.path.join(d, 'a.svg')); print(open(os.path.join(d, 'a.svg')).read().lstrip()[:_sage_const_4 ] in ('<svg', '<?xm'))
try:
    G.save(os.path.join(d, 'a.jpg'))
except ValueError as e:
    print(e)