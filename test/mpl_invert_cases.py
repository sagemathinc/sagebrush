# matplotlib's axis inversion: invert_xaxis, invert_yaxis, xaxis_inverted,
# yaxis_inverted, with limits that were set or autoscaled, with data added
# after, with set_xlim/set_ylim after, and imshow and bar.  CPython with
# matplotlib prints what test/mpl_oracle_gen.py records; Sagebrush must
# print the same (test/mpl-legend-ticks.test.ts).
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


def lims(tag, ax):
    print(tag, [round(float(v), 6) for v in ax.get_xlim()], [round(float(v), 6) for v in ax.get_ylim()],
          ax.xaxis_inverted(), ax.yaxis_inverted(), type(ax.yaxis_inverted()).__name__)


fig, ax = plt.subplots()
lims("empty", ax)
print("returns", ax.invert_yaxis(), ax.invert_xaxis())
lims("empty inverted", ax)
ax.invert_xaxis()
lims("x back", ax)

fig, ax = plt.subplots()
ax.set_ylim(0, 10)
ax.invert_yaxis()
lims("set then inverted", ax)
ax.invert_yaxis()
lims("set, inverted twice", ax)
ax.invert_yaxis()
ax.set_ylim(top=5)
lims("inverted, then top", ax)
ax.set_ylim(2, 8)
lims("then both", ax)

fig, ax = plt.subplots()
ax.invert_yaxis()
ax.plot([1, 2], [3, 7])
lims("inverted before data", ax)
ax.plot([1, 2], [0, 20])
lims("more data", ax)
ax.set_ylim(bottom=1)
lims("bottom given", ax)

fig, ax = plt.subplots()
ax.plot([1, 2, 3], [4, 5, 9])
ax.invert_xaxis()
lims("plot then x inverted", ax)
ax.set_xlim(0, 5)
lims("x set again", ax)
ax.set_xlim(5, 0)
lims("x set high to low", ax)
ax.invert_xaxis()
lims("and inverted", ax)

fig, ax = plt.subplots()
ax.invert_yaxis()
ax.imshow(np.zeros((3, 4)))
lims("inverted, then imshow", ax)
ax.invert_yaxis()
lims("imshow, inverted", ax)

fig, ax = plt.subplots()
ax.bar([1, 2, 3], [2, 5, 3])
ax.invert_yaxis()
lims("bar inverted", ax)

fig, ax = plt.subplots()
ax.scatter([0, 10], [0, 100])
ax.set_xlim(left=-5)
ax.invert_xaxis()
lims("one limit set, inverted", ax)

fig, (a1, a2) = plt.subplots(1, 2)
a1.plot([0, 1], [0, 1])
a2.plot([0, 1], [0, 1])
a2.invert_yaxis()
lims("left", a1)
lims("right", a2)
plt.ylim(3, 1)
lims("plt.ylim on the current axes", a2)

# axis(): the limits, whatever it is given
fig, ax = plt.subplots()
ax.plot([0, 2], [1, 5])
for a in ((), ("off",), ([0, 3, 0, 6],), ("on",), ("auto",)):
    print("axis", a, [round(float(v), 6) for v in ax.axis(*a)])
print("axis kw", [round(float(v), 6) for v in ax.axis(xmin=-1, ymax=7)])
ax.set_ylim(6, 0)
print("axis auto, inverted", [round(float(v), 6) for v in ax.axis("auto")], ax.yaxis_inverted())
print("axis tight", [round(float(v), 6) for v in ax.axis("tight")])
ax.plot([0, 10], [0, 50])
lims("tight keeps its limits", ax)
fig, ax = plt.subplots()
ax.plot([0, 2], [1, 5])
print("axis image", [round(float(v), 6) for v in ax.axis("image")])
print("plt.axis", [round(float(v), 6) for v in plt.axis()])
for args, kw in ((("bogus",), {}), (([0, 1, 2],), {}), ((5,), {}), (([0, 1, 2, 3],), {"xmin": 1}), ((), {"foo": 1})):
    try:
        ax.axis(*args, **kw)
    except Exception as e:
        print("axis error", type(e).__name__, e)
