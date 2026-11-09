# Graphics.xmin/xmax/ymin/ymax, as Sage: with no argument the range set for that axis (set_axes_range), else the
# extent of the primitives (a degenerate extent widened by 1 each way; an empty Graphics is -1..1); with a value,
# set it, converted by float(); get_minmax_data is the primitives' extent alone, and a sum does not carry a range set.
def show(label, f):
    try:
        print(label, "->", repr(f()), flush=True)
    except Exception as e:
        print(label, "->", "%s: %s" % (type(e).__name__, e), flush=True)
g = plot(sin(x), (x, 0, 3))
show("plot: xmin,xmax,ymin,ymax", lambda: (g.xmin(), g.xmax(), round(g.ymin(), 6), round(g.ymax(), 6)))
show("get_minmax_data", lambda: {k: round(v, 6) for k, v in g.get_minmax_data().items()})
show("set xmin(-1)", lambda: (g.xmin(-1), g.xmin(), g.get_minmax_data()['xmin']))
show("set ymax(2)", lambda: (g.ymax(2), g.ymax()))
show("set_axes_range", lambda: (g.set_axes_range(xmin=-2, ymax=5), g.xmin(), g.ymax(), g.get_axes_range()))
show("axes_range", lambda: g.get_axes_range())
e = Graphics()
show("empty bounds", lambda: (e.xmin(), e.xmax(), e.ymin(), e.ymax()))
show("empty get_minmax_data", lambda: e.get_minmax_data())
l = line([(1, 2), (3, -4)])
show("line bounds", lambda: (l.xmin(), l.xmax(), l.ymin(), l.ymax()))
p = point((5, 5))
show("point bounds", lambda: (p.xmin(), p.xmax(), p.ymin(), p.ymax()))
s = l + p
show("sum bounds", lambda: (s.xmin(), s.xmax(), s.ymin(), s.ymax()))
show("sum after set", lambda: (s.xmax(10), (s + e).xmax(), s.xmax()))
t = text("hi", (2, 3))
show("text bounds", lambda: (t.xmin(), t.xmax(), t.ymin(), t.ymax()))
show("xmin('a')", lambda: l.xmin('a'))
show("xmin(1/2)", lambda: (l.xmin(1/2), l.xmin()))
show("xmin(None)", lambda: (l.xmin(None), l.xmin()))
show("ymin(RR(0.25))", lambda: (l.ymin(RR(0.25)), l.ymin()))
show("set_axes_range bad", lambda: l.set_axes_range(xmin='a'))
c = circle((0, 0), 1)
show("circle bounds", lambda: (c.xmin(), c.xmax(), c.ymin(), c.ymax()))
