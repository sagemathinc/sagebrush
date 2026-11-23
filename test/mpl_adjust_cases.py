"""Figure.subplots_adjust and pyplot.subplots_adjust: where the grid's Axes are
(get_position, rounded to six decimal places) after the subplot parameters
change, before or after the Axes are made, one at a time or together; and
the parameters refused.  Run with CPython and matplotlib
(test/mpl_oracle_gen.py records the output in test/mpl-oracle.json) and with
Sagebrush (test/mpl-adjust.test.ts compares, and checks that each Axes is
drawn there)."""
import matplotlib.pyplot as plt


def show(name, fig):
    print(name)
    for i, ax in enumerate(fig.axes):
        print("  %d %s" % (i, tuple(round(float(v), 6) for v in ax.get_position().bounds)))
    plt.close(fig)


fig, axs = plt.subplots(2, 2)
fig.subplots_adjust(left=0.2, right=0.95, bottom=0.1, top=0.9, wspace=0.4, hspace=0.5)
show("subplots(2, 2), then all six", fig)

fig, axs = plt.subplots(3, 1)
fig.subplots_adjust(hspace=0)
show("subplots(3, 1), hspace=0", fig)

fig, axs = plt.subplots(1, 3)
plt.subplots_adjust(wspace=0.05, left=0.05, right=0.98)
show("plt.subplots_adjust on subplots(1, 3)", fig)

fig = plt.figure()
fig.subplots_adjust(left=0.3, top=0.7)
fig.add_subplot(2, 1, 1)
fig.add_subplot(2, 1, 2)
show("subplots_adjust before add_subplot", fig)

fig, axs = plt.subplots(2, 1)
fig.subplots_adjust(left=0.3)
fig.subplots_adjust(right=0.6)
show("two calls: the first's left stays", fig)

fig, ax = plt.subplots()
fig.subplots_adjust(bottom=0.25)
show("one Axes, bottom=0.25", fig)

for bad in ({"left": 0.6, "right": 0.5}, {"bottom": 0.9, "top": 0.2}, {"left": 0.5, "right": 0.5}):
    fig, ax = plt.subplots()
    try:
        fig.subplots_adjust(**bad)
        print(bad, "no error")
    except Exception as e:
        print(bad, "%s: %s" % (type(e).__name__, e))
    plt.close(fig)
