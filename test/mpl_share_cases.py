"""Shared axes in matplotlib: subplots(sharex=, sharey=), add_subplot and
subplot with sharex=/sharey=, and Axes.sharex/sharey.  Each case prints every
Axes' limits (rounded); which Axes show their tick labels is checked in
test/mpl-share.test.ts, on the SVG.  Run with CPython and matplotlib
(test/mpl_oracle_gen.py records the output in test/mpl-oracle.json) and with
Sagebrush (test/mpl-share.test.ts compares)."""
import matplotlib.pyplot as plt


def r(v):
    return round(float(v), 6)


def show(name, fig):
    axs = fig.axes
    print(name)
    for i, ax in enumerate(axs):
        x0, x1 = ax.get_xlim()
        y0, y1 = ax.get_ylim()
        print("  %d x (%s, %s) y (%s, %s)" % (i, r(x0), r(x1), r(y0), r(y1)))
    plt.close(fig)


def data(fig, axs):
    # (each panel its own range, so that sharing shows)
    for k, ax in enumerate(axs):
        ax.plot([k, k + 1 + k * k], [-k, 2 * k + 0.5])


for sx, sy in ((True, False), (False, True), (True, True), ("all", "none"), ("row", "col"), ("col", "row"), ("none", "all")):
    fig, axs = plt.subplots(2, 3, sharex=sx, sharey=sy)
    data(fig, list(axs.flat))
    show("subplots(2, 3, sharex=%r, sharey=%r)" % (sx, sy), fig)

fig, axs = plt.subplots(3, 1, sharex=True)
data(fig, list(axs))
show("subplots(3, 1, sharex=True)", fig)

fig, axs = plt.subplots(1, 3, sharey=True)
data(fig, list(axs))
show("subplots(1, 3, sharey=True)", fig)

# set_xlim on one shared Axes sets them all; autoscale stops for all
fig, axs = plt.subplots(2, 2, sharex=True)
data(fig, list(axs.flat))
axs[1][1].set_xlim(-2, 20)
show("set_xlim on one of four sharing x", fig)

# limits set before the data: the data added later does not move them
fig, axs = plt.subplots(1, 2, sharey=True)
axs[0].set_ylim(0, 1)
data(fig, list(axs))
show("set_ylim first, then data", fig)

# a log axis is shared with its scale
fig, axs = plt.subplots(1, 2, sharex=True)
axs[0].set_xscale("log")
axs[0].plot([1, 10], [0, 1])
axs[1].plot([5, 1000], [1, 2])
show("log scale shared", fig)
print("  scales", [ax.get_xscale() for ax in fig.axes])

# an inverted shared axis is inverted for all
fig, axs = plt.subplots(1, 2, sharey=True)
data(fig, list(axs))
axs[1].invert_yaxis()
show("invert_yaxis on one of two sharing y", fig)

# bars keep their sticky zero in the union
fig, axs = plt.subplots(1, 2, sharey=True)
axs[0].bar([1, 2], [3, 5])
axs[1].plot([0, 1], [1, 2])
show("bars and a line sharing y", fig)

# add_subplot and subplot with sharex=/sharey=
fig = plt.figure()
a = fig.add_subplot(2, 1, 1)
b = fig.add_subplot(2, 1, 2, sharex=a)
a.plot([0, 10], [0, 1])
b.plot([-5, 3], [2, 3])
show("add_subplot(sharex=a)", fig)

fig = plt.figure()
a = plt.subplot(1, 2, 1)
b = plt.subplot(1, 2, 2, sharey=a)
a.plot([0, 1], [0, 10])
b.plot([0, 1], [-4, 2])
show("plt.subplot(sharey=a)", fig)

# Axes.sharex: the axes takes the other's limits and scale
fig, axs = plt.subplots(1, 2)
axs[0].plot([0, 4], [0, 1])
axs[1].plot([10, 30], [0, 1])
axs[1].sharex(axs[0])
show("Axes.sharex(other)", fig)

# a bad value
for bad in ("rows",):
    try:
        plt.subplots(1, 2, sharex=bad)
        print("subplots(sharex=%r): no error" % (bad,))
    except Exception as e:
        print("subplots(sharex=%r): %s: %s" % (bad, type(e).__name__, e))
    plt.close("all")

# sharing twice
fig, axs = plt.subplots(1, 3)
axs[1].sharex(axs[0])
try:
    axs[1].sharex(axs[2])
    print("sharex twice: no error")
except Exception as e:
    print("sharex twice: %s: %s" % (type(e).__name__, e))
plt.close(fig)


# one limit given: the other is the shared view's at that moment, for both,
# and stays as more data comes (matplotlib stops autoscaling the axis)
def lims(tag, axs):
    print(tag, [[tuple(r(v) for v in a.get_xlim()), tuple(r(v) for v in a.get_ylim())] for a in axs])


fig, axs = plt.subplots(1, 2, sharex=True, sharey=True)
axs[0].plot([0, 1], [0, 1])
axs[1].plot([10, 20], [20, 40])
axs[0].set_xlim(left=-2)
axs[1].set_ylim(top=50)
lims("one-sided set_xlim and set_ylim on a shared pair", axs)
plt.close(fig)

fig, axs = plt.subplots(1, 2, sharex=True)
axs[0].plot([0, 1], [0, 1])
axs[1].set_xlim(right=5)
axs[1].plot([10, 20], [0, 1])
lims("set_xlim(right=) on a shared pair, then more data", axs)
plt.close(fig)

fig, ax = plt.subplots()
ax.plot([0, 1], [0, 1])
ax.set_xlim(left=-2)
ax.plot([5, 6], [0, 1])
lims("set_xlim(left=) on one Axes, then more data", [ax])
plt.close(fig)

fig, ax = plt.subplots()
ax.set_xlim(left=-2)
lims("set_xlim(left=) on empty Axes", [ax])
plt.close(fig)

# cla: the Axes the others joined puts the shared view back to (0, 1), until
# new data autoscales them all; an Axes that joined another takes its view
fig, axs = plt.subplots(1, 2, sharex=True)
axs[0].plot([0, 1], [0, 1])
axs[1].plot([10, 20], [0, 1])
axs[1].set_xlim(3, 30)
axs[0].cla()
lims("cla of the Axes the other joined", axs)
axs[0].plot([-10, -5], [0, 1])
lims("then new data", axs)
plt.close(fig)

fig, axs = plt.subplots(1, 2, sharex=True)
axs[0].plot([0, 1], [0, 1])
axs[1].plot([10, 20], [0, 1])
axs[1].set_xlim(3, 30)
axs[1].cla()
lims("cla of the Axes that joined", axs)
axs[1].plot([-10, -5], [0, 1])
lims("then new data", axs)
plt.close(fig)

# groups joined: one view for all four
fig, axs = plt.subplots(1, 4)
axs[1].sharex(axs[0])
axs[3].sharex(axs[2])
axs[0].sharex(axs[2])
for k in range(4):
    axs[k].plot([k, k + 1], [k, k + 1])
lims("two shared pairs joined", axs)
axs[3].set_xlim(-1, 8)
lims("then set_xlim on one", axs)
plt.close(fig)
