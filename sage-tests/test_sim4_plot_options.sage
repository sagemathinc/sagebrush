# Sim run 4's Sage gaps: a polygon's facecolor (an option Polygon doesn't
# take: ignored, with Sage's warning) and GraphicsArray.save/show's figsize
# (the whole grid's; the other options are each graphics').
import os, tempfile
x = var('x')
d = tempfile.mkdtemp()
P = polygon([(0, 0), (1, 0), (0, 1)], facecolor='red')
P.save(os.path.join(d, 'p.png'))
print(open(os.path.join(d, 'p.png'), 'rb').read(4))
Q = polygon([(0, 0), (2, 0), (1, 1)], facecolor=(0, 1, 0), edgecolor='green', foo=3)
Q.save(os.path.join(d, 'q.svg'))
R = polygon([(0, 0), (1, 0), (1, 1)], color='blue', edgecolor='black', alpha=0.5, linestyle='--', zorder=2, legend_label='T')
R.save(os.path.join(d, 'r.svg'))
print(len(P), len(Q), len(R))
G = graphics_array([plot(sin, 0, 1), plot(cos, 0, 1)])
G.save(os.path.join(d, 'a.png'), figsize=[8, 3])
print(open(os.path.join(d, 'a.png'), 'rb').read(4))
G.save(os.path.join(d, 'a.svg'), figsize=4)
G.save(os.path.join(d, 'b.png'), figsize=[8, 3], axes_labels=['$x$', '$y$'], dpi=50, transparent=True)
print(open(os.path.join(d, 'b.png'), 'rb').read(4))
H = graphics_array([[plot(x, 0, 1), plot(x^2, 0, 1)], [plot(x^3, 0, 1), plot(x^4, 0, 1)]])
H.save(os.path.join(d, 'h.png'), figsize=[6, 6], ymin=0, ymax=1, frame=True)
print(H, sorted(os.listdir(d)))
