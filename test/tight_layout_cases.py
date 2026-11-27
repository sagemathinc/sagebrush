# tight_layout and subplots_adjust cases (test/tight-layout.test.ts): each leaves `out`, every Axes' position and
# ticks after the layout, in the same form here and in matplotlib 3.11 (test/tight_layout_oracle_gen.py writes
# test/tight-layout-oracle.json from them).
PRELUDE = """
import numpy as np
import matplotlib
import matplotlib.pyplot as plt
def layout(fig):
    out = []
    for ax in fig.axes:
        b = ax.get_position()
        # (a log axis's ticks aren't read: Sagebrush's get_xticks refuses them)
        ticks = lambda a: [float(v) for v in getattr(ax, "get_%sticks" % a)()] if getattr(ax, "get_%sscale" % a)() == "linear" else None
        out.append({"pos": [float(b.x0), float(b.y0), float(b.x1), float(b.y1)], "xticks": ticks("x"), "yticks": ticks("y")})
    plt.close(fig)
    return out
"""

CASES = [
    ("grid2x2_labels", """
fig, axs = plt.subplots(2, 2)
for ax in axs.flat:
    ax.plot([0, 1, 2], [0, 10, 5])
    ax.set_xlabel("time (s)")
    ax.set_ylabel("speed")
    ax.set_title("A title")
fig.tight_layout()
out = layout(fig)
"""),
    ("single_wide_ylabels", """
fig, ax = plt.subplots()
ax.plot([0, 50, 100], [-12000, 3500, 25000])
ax.set_title("Revenue")
ax.set_ylabel("dollars")
plt.tight_layout()
out = layout(fig)
"""),
    ("col3_negatives", """
fig, axs = plt.subplots(3, 1, figsize=(5, 8))
for k, ax in enumerate(axs):
    ax.plot([0, 1, 2, 3], [-5 - k, -2, -7, -4])
axs[0].set_title("top")
fig.tight_layout()
out = layout(fig)
"""),
    ("shared_2x3", """
fig, axs = plt.subplots(2, 3, sharex=True, sharey=True)
for k, ax in enumerate(axs.flat):
    ax.scatter([0, 1, 2, 3], [k, k + 1, 0, 2])
fig.tight_layout()
out = layout(fig)
"""),
    ("rotation_suptitle", """
fig, axs = plt.subplots(2, 2)
for ax in axs.flat:
    ax.plot([0, 1000, 2000], [0, 1, 0.5])
axs[1, 0].tick_params(axis="x", labelrotation=45)
fig.suptitle("Four plots")
fig.tight_layout()
out = layout(fig)
"""),
    ("pads", """
fig, axs = plt.subplots(2, 2)
for ax in axs.flat:
    ax.plot([0, 1], [0, 1])
fig.tight_layout(pad=0.4, w_pad=2.0, h_pad=3.0)
out = layout(fig)
"""),
    ("rect", """
fig, axs = plt.subplots(1, 2)
for ax in axs:
    ax.plot([0, 1], [3, 4])
    ax.set_xlabel("x")
fig.tight_layout(rect=(0, 0.1, 1, 0.9))
out = layout(fig)
"""),
    ("empty_ticklabels", """
fig, axs = plt.subplots(2, 2)
for ax in axs.flat:
    ax.plot([0, 1], [0, 1])
for ax in axs[0]:
    ax.set_xticklabels([])
axs[0, 0].set_xlabel("x")
fig.tight_layout()
out = layout(fig)
"""),
    ("axis_off", """
fig, axs = plt.subplots(2, 2)
for ax in axs.flat:
    ax.plot([0, 1], [0, 1])
axs[0, 1].axis("off")
fig.tight_layout()
out = layout(fig)
"""),
    ("categories", """
fig, axs = plt.subplots(1, 3, figsize=(9, 3))
for ax in axs:
    ax.bar(["apple", "banana", "cherry"], [1, 2, 3])
fig.tight_layout()
out = layout(fig)
"""),
    ("big_fonts", """
fig, axs = plt.subplots(2, 1)
for ax in axs:
    ax.plot([0, 1, 2], [0, 100, 50])
    ax.set_title("Large title", fontsize=14.4)
    ax.set_ylabel("value", fontsize=12)
    ax.tick_params(labelsize=8.33)
fig.tight_layout()
out = layout(fig)
"""),
    ("subplots_adjust", """
fig, axs = plt.subplots(2, 2)
for ax in axs.flat:
    ax.plot([0, 1, 2], [0, 10, 5])
fig.subplots_adjust(left=0.2, right=0.95, wspace=0.5, hspace=0.6)
out = layout(fig)
"""),
    ("subplots_adjust_pyplot", """
fig = plt.figure()
for k in range(3):
    plt.subplot(3, 1, k + 1)
    plt.plot([0, 1, 2], [k, 5, 2])
plt.subplots_adjust(hspace=0)
out = layout(fig)
"""),
    ("two_grids", """
fig = plt.figure()
ax1 = fig.add_subplot(2, 2, 1)
ax2 = fig.add_subplot(2, 2, 2)
ax3 = fig.add_subplot(2, 1, 2)
for ax in (ax1, ax2, ax3):
    ax.plot([0, 1], [0, 1])
    ax.set_title("t")
fig.tight_layout()
out = layout(fig)
"""),
    ("inset_axes_warns", """
fig, axs = plt.subplots(1, 2)
for ax in axs:
    ax.plot([0, 1], [0, 1])
    ax.set_ylabel("y")
fig.add_axes([0.6, 0.6, 0.2, 0.2])
fig.tight_layout()
out = layout(fig)
"""),
    ("tall_tiny", """
fig, axs = plt.subplots(6, 1, figsize=(3, 2))
for ax in axs:
    ax.plot([0, 1], [0, 1])
    ax.set_title("title")
fig.tight_layout()
out = layout(fig)
"""),
    ("log_axis", """
fig, axs = plt.subplots(1, 2)
axs[0].plot([1, 10, 100, 1000], [1, 2, 3, 4])
axs[0].set_xscale("log")
axs[1].plot([0, 1], [1e-3, 1e3])
axs[1].set_yscale("log")
fig.tight_layout()
out = layout(fig)
"""),
    ("multiline_ticklabels", """
fig, axs = plt.subplots(1, 2)
for ax, rot in zip(axs, (0, 30)):
    ax.set_yticks([0, 1], labels=["a\\nb", "c\\nd"], rotation=rot)
    ax.set_xticks([0, 1], labels=["e\\nf\\ng", "h"], rotation=rot)
    ax.set_ylim(0, 1)
    ax.set_xlim(0, 1)
fig.tight_layout()
out = layout(fig)
"""),
    ("escaped_dollar_ticklabels", """
fig, axs = plt.subplots(1, 2)
axs[0].set_yticks([0, 1], labels=[r"\\$100", r"\\$\\$\\$5"])
axs[1].set_yticks([0, 1], labels=[r"\\$1 and \\$2", "plain"])
fig.tight_layout()
out = layout(fig)
"""),
]
