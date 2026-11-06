# A Sprig session in Sagebrush: run a cell, export plots, time each input.
#   sagebrush demo.py LIBDIR OUTDIR
import sys, time
sys.path.insert(0, sys.argv[1])
out = sys.argv[2]
t0 = time.time()
import _sprig as W
print("# import _sprig: %.0f ms" % ((time.time() - t0) * 1000))

cell = '''
f[x_] := x^3 - 3 x
crit = Solve[f'[x] == 0, x]
f[x] /. crit
Integrate[f[x], {x, 0, 2}]
Series[f[x] Exp[x], {x, 0, 3}]
g = Plot[{f[x], f'[x]}, {x, -2.5, 2.5}]
Export["%s/plot2d.png", g]
Export["%s/plot3d.svg", Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}]]
ToString[TeXForm[Integrate[1/(1 + x^2), x]]]
''' % (out, out)
for line in cell.strip().split("\n"):
    t = time.time()
    shown = []
    W.run(line, show=shown.append)
    ms = (time.time() - t) * 1000
    print("In:  %s\nOut: %s    (%.0f ms)" % (line, " | ".join(shown) or "(none)", ms))
