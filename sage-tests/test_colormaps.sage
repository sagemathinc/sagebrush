# colormaps (matplotlib's, by name) and a plot's cmap: a name matplotlib
# lacks is Sage's KeyError in colormaps, and Sage's RuntimeError when a
# density or contour plot with it is drawn (not when it is made).  Colors
# themselves are not compared here.
import os, tempfile
d = tempfile.mkdtemp()
def t(label, f):
    try:
        print(label, repr(f()))
    except Exception as e:
        print(label, type(e).__name__, str(e))
t("len", lambda: len(colormaps))
t("first", lambda: list(colormaps)[:6])
t("in", lambda: ('viridis' in colormaps, 'gray_r' in colormaps, 'foo' in colormaps))
t("name", lambda: (colormaps['viridis'].name, colormaps['jet_r'].name, colormaps.coolwarm.name))
t("same", lambda: colormaps['viridis'] is colormaps['viridis'])
t("[foo]", lambda: colormaps['foo'])
t("[Viridis]", lambda: colormaps['Viridis'])
t("[3]", lambda: colormaps[3])
t(".foo", lambda: colormaps.foo)
t(".get", lambda: colormaps.get('foo'))
var('x y')
for cm in ['viridis', 'gray', 'RdBu_r', 'foo', 'Viridis']:
    t("density_plot %s made" % cm, lambda: type(density_plot(x*y, (x, -1, 1), (y, -1, 1), cmap=cm)).__name__)
    t("density_plot %s drawn" % cm, lambda: density_plot(x*y, (x, -1, 1), (y, -1, 1), cmap=cm).save(os.path.join(d, 'd.svg')))
    t("contour_plot %s drawn" % cm, lambda: contour_plot(x*y, (x, -1, 1), (y, -1, 1), cmap=cm).save(os.path.join(d, 'c.svg')))
t("contour_plot lines foo drawn", lambda: contour_plot(x*y, (x, -1, 1), (y, -1, 1), cmap='foo', fill=False).save(os.path.join(d, 'c.svg')))
