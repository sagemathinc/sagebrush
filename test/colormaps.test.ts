// matplotlib's colormaps by name: matplotlib.colormaps (its registry), cm's
// colormaps, plt.get_cmap and plt.colormaps, and the cmap= of ScalarMappable,
// imshow, scatter and contourf, with matplotlib's errors for a name it lacks
// (no other colormap in its place).  Expected lines are matplotlib 3.11.1's,
// run on the same program.  Colors themselves are not compared here.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const run = (program: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", program], { encoding: "utf8" });

test("colormaps: matplotlib 3.11.1's names, registry and errors", () => {
  const out = run(`
import matplotlib as mpl
import matplotlib.pyplot as plt
from matplotlib import colormaps, cm
from matplotlib.colors import Colormap
import numpy as np
def t(label, f):
    try:
        print(label, repr(f()))
    except Exception as e:
        print(label, type(e).__name__, str(e))
t("len", lambda: (len(colormaps), len(plt.colormaps()), plt.colormaps() == list(colormaps), plt.colormaps is colormaps))
t("first", lambda: list(colormaps)[:12])
t("last", lambda: list(colormaps)[-4:])
t("in", lambda: ("viridis" in colormaps, "magma_r" in colormaps, "foo" in colormaps, 3 in colormaps))
t("names", lambda: sorted(n for n in colormaps if not n.endswith("_r")))
t("reversed", lambda: all(n + "_r" in colormaps for n in colormaps if not n.endswith("_r")))
t("same mpl", lambda: mpl.colormaps is colormaps)
t("type", lambda: (type(colormaps).__name__, isinstance(colormaps["viridis"], Colormap), colormaps["viridis"].name, colormaps["gray_r"].name))
t("copy", lambda: colormaps["viridis"] is colormaps["viridis"])
t("str", lambda: str(colormaps)[:120])
for name in ["foo", "magama", "xyzzy", "Viridis", "jett", "jet_R", "Blue", "rd", "set1", "b", "BuRd", "", "coolwarm_", "virdis"]:
    t("[%s]" % name, lambda: colormaps[name])
t("[3]", lambda: colormaps[3])
t("[2.5]", lambda: colormaps[2.5])
t(".get", lambda: colormaps.get("foo"))
t(".get_cmap None", lambda: colormaps.get_cmap(None).name)
t(".get_cmap obj", lambda: colormaps.get_cmap(colormaps["gray"]).name)
t(".get_cmap foo", lambda: colormaps.get_cmap("foo"))
t(".get_cmap xyzzy", lambda: colormaps.get_cmap("xyzzy"))
t(".get_cmap 3", lambda: colormaps.get_cmap(3))
t(".get_cmap bytes", lambda: colormaps.get_cmap(b"viridis"))
t("plt.get_cmap", lambda: (plt.get_cmap().name, plt.get_cmap("jet").name, plt.get_cmap(colormaps["hot"]).name))
t("plt.get_cmap foo", lambda: plt.get_cmap("foo"))
t("plt.get_cmap Magma", lambda: plt.get_cmap("Magma"))
t("plt.get_cmap 3", lambda: plt.get_cmap(3))
t("cm.foo", lambda: cm.foo)
t("cm.viridis", lambda: (cm.viridis.name, cm.gray_r.name, cm.coolwarm.name))
t("SM", lambda: cm.ScalarMappable(cmap="jet").get_cmap().name)
t("SM None", lambda: cm.ScalarMappable().get_cmap().name)
t("SM foo", lambda: cm.ScalarMappable(cmap="foo"))
t("SM xyzzy", lambda: cm.ScalarMappable(cmap="xyzzy"))
t("SM 3", lambda: cm.ScalarMappable(cmap=3))
t("SM set_cmap", lambda: cm.ScalarMappable().set_cmap("cooll"))
t("imshow", lambda: plt.imshow(np.zeros((2, 2)), cmap="jet") is not None)
t("imshow foo", lambda: plt.imshow(np.zeros((2, 2)), cmap="foo"))
t("imshow rgb foo", lambda: plt.imshow(np.zeros((2, 2, 3)), cmap="foo"))
t("scatter c foo", lambda: plt.scatter([1, 2], [1, 2], c=[1.0, 2.0], cmap="foo"))
t("contourf foo", lambda: plt.contourf(np.arange(9.0).reshape(3, 3), cmap="foo"))
t("contourf both", lambda: plt.contourf(np.arange(9.0).reshape(3, 3), colors=["r", "g"], cmap="jet"))
t("contourf ok", lambda: plt.contourf(np.arange(9.0).reshape(3, 3), cmap="Spectral_r") is not None)
`);
  assert.deepEqual(out.trim().split("\n"), [
    "len (182, 182, True, True)",
    "first ['magma', 'inferno', 'plasma', 'viridis', 'cividis', 'twilight', 'twilight_shifted', 'turbo', 'berlin', 'managua', 'vanimo', 'Blues']",
    "last ['grey_r', 'gist_grey_r', 'gist_yerg_r', 'Grays_r']",
    "in (True, True, False, False)",
    "names ['Accent', 'Blues', 'BrBG', 'BuGn', 'BuPu', 'CMRmap', 'Dark2', 'GnBu', 'Grays', 'Greens', 'Greys', 'OrRd', 'Oranges', 'PRGn', 'Paired', 'Pastel1', 'Pastel2', 'PiYG', 'PuBu', 'PuBuGn', 'PuOr', 'PuRd', 'Purples', 'RdBu', 'RdGy', 'RdPu', 'RdYlBu', 'RdYlGn', 'Reds', 'Set1', 'Set2', 'Set3', 'Spectral', 'Wistia', 'YlGn', 'YlGnBu', 'YlOrBr', 'YlOrRd', 'afmhot', 'autumn', 'berlin', 'binary', 'bone', 'brg', 'bwr', 'cividis', 'cool', 'coolwarm', 'copper', 'cubehelix', 'flag', 'gist_earth', 'gist_gray', 'gist_grey', 'gist_heat', 'gist_ncar', 'gist_rainbow', 'gist_stern', 'gist_yarg', 'gist_yerg', 'gnuplot', 'gnuplot2', 'gray', 'grey', 'hot', 'hsv', 'inferno', 'jet', 'magma', 'managua', 'nipy_spectral', 'ocean', 'okabe_ito', 'pink', 'plasma', 'prism', 'rainbow', 'seismic', 'spring', 'summer', 'tab10', 'tab20', 'tab20b', 'tab20c', 'terrain', 'turbo', 'twilight', 'twilight_shifted', 'vanimo', 'viridis', 'winter']",
    "reversed True",
    "same mpl True",
    "type ('ColormapRegistry', True, 'viridis', 'gray_r')",
    "copy False",
    "str \"ColormapRegistry; available colormaps:\\n'magma', 'inferno', 'plasma', 'viridis', 'cividis', 'twilight', 'twilight_shifted\"",
    "[foo] KeyError \"'foo' is not a valid value for colormap. Did you mean: 'cool'?\"",
    "[magama] KeyError \"'magama' is not a valid value for colormap. Did you mean one of: 'magma', 'magma_r', 'managua'?\"",
    "[xyzzy] KeyError \"'xyzzy' is not a valid value for colormap.\"",
    "[Viridis] KeyError \"'Viridis' is not a valid value for colormap. Did you mean one of: 'viridis', 'viridis_r', 'cividis'?\"",
    "[jett] KeyError \"'jett' is not a valid value for colormap. Did you mean one of: 'jet', 'jet_r', 'Set3'?\"",
    "[jet_R] KeyError \"'jet_R' is not a valid value for colormap. Did you mean one of: 'jet_r', 'jet', 'Set3_r'?\"",
    "[Blue] KeyError \"'Blue' is not a valid value for colormap. Did you mean one of: 'Blues', 'Blues_r', 'RdBu'?\"",
    "[rd] KeyError \"'rd' is not a valid value for colormap. Did you mean one of: 'OrRd', 'YlOrRd', 'Paired'?\"",
    "[set1] KeyError \"'set1' is not a valid value for colormap. Did you mean one of: 'Set1', 'Set1_r', 'jet'?\"",
    "[b] KeyError \"'b' is not a valid value for colormap. Did you mean one of: 'bwr', 'brg'?\"",
    "[BuRd] KeyError \"'BuRd' is not a valid value for colormap. Did you mean one of: 'PuRd', 'PuRd_r', 'Reds'?\"",
    "[] KeyError \"'' is not a valid value for colormap.\"",
    "[coolwarm_] KeyError \"'coolwarm_' is not a valid value for colormap. Did you mean one of: 'coolwarm_r', 'coolwarm', 'cool_r'?\"",
    "[virdis] KeyError \"'virdis' is not a valid value for colormap. Did you mean one of: 'viridis', 'viridis_r', 'cividis'?\"",
    "[3] KeyError \"3 is not a valid value for colormap. Supported values are 'magma', 'inferno', 'plasma', 'viridis', 'cividis', 'twilight', 'twilight_shifted', 'turbo', 'berlin', 'managua', 'vanimo', 'Blues', 'BrBG', 'BuGn', 'BuPu', 'CMRmap', 'GnBu', 'Greens', 'Greys', 'OrRd', 'Oranges', 'PRGn', 'PiYG', 'PuBu', 'PuBuGn', 'PuOr', 'PuRd', 'Purples', 'RdBu', 'RdGy', 'RdPu', 'RdYlBu', 'RdYlGn', 'Reds', 'Spectral', 'Wistia', 'YlGn', 'YlGnBu', 'YlOrBr', 'YlOrRd', 'afmhot', 'autumn', 'binary', 'bone', 'brg', 'bwr', 'cool', 'coolwarm', 'copper', 'cubehelix', 'flag', 'gist_earth', 'gist_gray', 'gist_heat', 'gist_ncar', 'gist_rainbow', 'gist_stern', 'gist_yarg', 'gnuplot', 'gnuplot2', 'gray', 'hot', 'hsv', 'jet', 'nipy_spectral', 'ocean', 'pink', 'prism', 'rainbow', 'seismic', 'spring', 'summer', 'terrain', 'winter', 'Accent', 'okabe_ito', 'Dark2', 'Paired', 'Pastel1', 'Pastel2', 'Set1', 'Set2', 'Set3', 'tab10', 'tab20', 'tab20b', 'tab20c', 'grey', 'gist_grey', 'gist_yerg', 'Grays', 'magma_r', 'inferno_r', 'plasma_r', 'viridis_r', 'cividis_r', 'twilight_r', 'twilight_shifted_r', 'turbo_r', 'berlin_r', 'managua_r', 'vanimo_r', 'Blues_r', 'BrBG_r', 'BuGn_r', 'BuPu_r', 'CMRmap_r', 'GnBu_r', 'Greens_r', 'Greys_r', 'OrRd_r', 'Oranges_r', 'PRGn_r', 'PiYG_r', 'PuBu_r', 'PuBuGn_r', 'PuOr_r', 'PuRd_r', 'Purples_r', 'RdBu_r', 'RdGy_r', 'RdPu_r', 'RdYlBu_r', 'RdYlGn_r', 'Reds_r', 'Spectral_r', 'Wistia_r', 'YlGn_r', 'YlGnBu_r', 'YlOrBr_r', 'YlOrRd_r', 'afmhot_r', 'autumn_r', 'binary_r', 'bone_r', 'brg_r', 'bwr_r', 'cool_r', 'coolwarm_r', 'copper_r', 'cubehelix_r', 'flag_r', 'gist_earth_r', 'gist_gray_r', 'gist_heat_r', 'gist_ncar_r', 'gist_rainbow_r', 'gist_stern_r', 'gist_yarg_r', 'gnuplot_r', 'gnuplot2_r', 'gray_r', 'hot_r', 'hsv_r', 'jet_r', 'nipy_spectral_r', 'ocean_r', 'pink_r', 'prism_r', 'rainbow_r', 'seismic_r', 'spring_r', 'summer_r', 'terrain_r', 'winter_r', 'Accent_r', 'okabe_ito_r', 'Dark2_r', 'Paired_r', 'Pastel1_r', 'Pastel2_r', 'Set1_r', 'Set2_r', 'Set3_r', 'tab10_r', 'tab20_r', 'tab20b_r', 'tab20c_r', 'grey_r', 'gist_grey_r', 'gist_yerg_r', 'Grays_r'\"",
    "[2.5] KeyError \"2.5 is not a valid value for colormap. Supported values are 'magma', 'inferno', 'plasma', 'viridis', 'cividis', 'twilight', 'twilight_shifted', 'turbo', 'berlin', 'managua', 'vanimo', 'Blues', 'BrBG', 'BuGn', 'BuPu', 'CMRmap', 'GnBu', 'Greens', 'Greys', 'OrRd', 'Oranges', 'PRGn', 'PiYG', 'PuBu', 'PuBuGn', 'PuOr', 'PuRd', 'Purples', 'RdBu', 'RdGy', 'RdPu', 'RdYlBu', 'RdYlGn', 'Reds', 'Spectral', 'Wistia', 'YlGn', 'YlGnBu', 'YlOrBr', 'YlOrRd', 'afmhot', 'autumn', 'binary', 'bone', 'brg', 'bwr', 'cool', 'coolwarm', 'copper', 'cubehelix', 'flag', 'gist_earth', 'gist_gray', 'gist_heat', 'gist_ncar', 'gist_rainbow', 'gist_stern', 'gist_yarg', 'gnuplot', 'gnuplot2', 'gray', 'hot', 'hsv', 'jet', 'nipy_spectral', 'ocean', 'pink', 'prism', 'rainbow', 'seismic', 'spring', 'summer', 'terrain', 'winter', 'Accent', 'okabe_ito', 'Dark2', 'Paired', 'Pastel1', 'Pastel2', 'Set1', 'Set2', 'Set3', 'tab10', 'tab20', 'tab20b', 'tab20c', 'grey', 'gist_grey', 'gist_yerg', 'Grays', 'magma_r', 'inferno_r', 'plasma_r', 'viridis_r', 'cividis_r', 'twilight_r', 'twilight_shifted_r', 'turbo_r', 'berlin_r', 'managua_r', 'vanimo_r', 'Blues_r', 'BrBG_r', 'BuGn_r', 'BuPu_r', 'CMRmap_r', 'GnBu_r', 'Greens_r', 'Greys_r', 'OrRd_r', 'Oranges_r', 'PRGn_r', 'PiYG_r', 'PuBu_r', 'PuBuGn_r', 'PuOr_r', 'PuRd_r', 'Purples_r', 'RdBu_r', 'RdGy_r', 'RdPu_r', 'RdYlBu_r', 'RdYlGn_r', 'Reds_r', 'Spectral_r', 'Wistia_r', 'YlGn_r', 'YlGnBu_r', 'YlOrBr_r', 'YlOrRd_r', 'afmhot_r', 'autumn_r', 'binary_r', 'bone_r', 'brg_r', 'bwr_r', 'cool_r', 'coolwarm_r', 'copper_r', 'cubehelix_r', 'flag_r', 'gist_earth_r', 'gist_gray_r', 'gist_heat_r', 'gist_ncar_r', 'gist_rainbow_r', 'gist_stern_r', 'gist_yarg_r', 'gnuplot_r', 'gnuplot2_r', 'gray_r', 'hot_r', 'hsv_r', 'jet_r', 'nipy_spectral_r', 'ocean_r', 'pink_r', 'prism_r', 'rainbow_r', 'seismic_r', 'spring_r', 'summer_r', 'terrain_r', 'winter_r', 'Accent_r', 'okabe_ito_r', 'Dark2_r', 'Paired_r', 'Pastel1_r', 'Pastel2_r', 'Set1_r', 'Set2_r', 'Set3_r', 'tab10_r', 'tab20_r', 'tab20b_r', 'tab20c_r', 'grey_r', 'gist_grey_r', 'gist_yerg_r', 'Grays_r'\"",
    ".get None",
    ".get_cmap None 'viridis'",
    ".get_cmap obj 'gray'",
    ".get_cmap foo ValueError 'foo' is not a valid value for cmap. Did you mean: 'cool'?",
    ".get_cmap xyzzy ValueError 'xyzzy' is not a valid value for cmap.",
    ".get_cmap 3 TypeError get_cmap expects None or an instance of a str or Colormap . you passed 3 of type <class 'int'>",
    ".get_cmap bytes TypeError get_cmap expects None or an instance of a str or Colormap . you passed b'viridis' of type <class 'bytes'>",
    "plt.get_cmap ('viridis', 'jet', 'hot')",
    "plt.get_cmap foo ValueError 'foo' is not a valid value for name. Did you mean: 'cool'?",
    "plt.get_cmap Magma ValueError 'Magma' is not a valid value for name. Did you mean one of: 'magma', 'magma_r', 'plasma'?",
    "plt.get_cmap 3 ValueError 3 is not a valid value for name. Supported values are 'Accent', 'Accent_r', 'Blues', 'Blues_r', 'BrBG', 'BrBG_r', 'BuGn', 'BuGn_r', 'BuPu', 'BuPu_r', 'CMRmap', 'CMRmap_r', 'Dark2', 'Dark2_r', 'GnBu', 'GnBu_r', 'Grays', 'Grays_r', 'Greens', 'Greens_r', 'Greys', 'Greys_r', 'OrRd', 'OrRd_r', 'Oranges', 'Oranges_r', 'PRGn', 'PRGn_r', 'Paired', 'Paired_r', 'Pastel1', 'Pastel1_r', 'Pastel2', 'Pastel2_r', 'PiYG', 'PiYG_r', 'PuBu', 'PuBuGn', 'PuBuGn_r', 'PuBu_r', 'PuOr', 'PuOr_r', 'PuRd', 'PuRd_r', 'Purples', 'Purples_r', 'RdBu', 'RdBu_r', 'RdGy', 'RdGy_r', 'RdPu', 'RdPu_r', 'RdYlBu', 'RdYlBu_r', 'RdYlGn', 'RdYlGn_r', 'Reds', 'Reds_r', 'Set1', 'Set1_r', 'Set2', 'Set2_r', 'Set3', 'Set3_r', 'Spectral', 'Spectral_r', 'Wistia', 'Wistia_r', 'YlGn', 'YlGnBu', 'YlGnBu_r', 'YlGn_r', 'YlOrBr', 'YlOrBr_r', 'YlOrRd', 'YlOrRd_r', 'afmhot', 'afmhot_r', 'autumn', 'autumn_r', 'berlin', 'berlin_r', 'binary', 'binary_r', 'bone', 'bone_r', 'brg', 'brg_r', 'bwr', 'bwr_r', 'cividis', 'cividis_r', 'cool', 'cool_r', 'coolwarm', 'coolwarm_r', 'copper', 'copper_r', 'cubehelix', 'cubehelix_r', 'flag', 'flag_r', 'gist_earth', 'gist_earth_r', 'gist_gray', 'gist_gray_r', 'gist_grey', 'gist_grey_r', 'gist_heat', 'gist_heat_r', 'gist_ncar', 'gist_ncar_r', 'gist_rainbow', 'gist_rainbow_r', 'gist_stern', 'gist_stern_r', 'gist_yarg', 'gist_yarg_r', 'gist_yerg', 'gist_yerg_r', 'gnuplot', 'gnuplot2', 'gnuplot2_r', 'gnuplot_r', 'gray', 'gray_r', 'grey', 'grey_r', 'hot', 'hot_r', 'hsv', 'hsv_r', 'inferno', 'inferno_r', 'jet', 'jet_r', 'magma', 'magma_r', 'managua', 'managua_r', 'nipy_spectral', 'nipy_spectral_r', 'ocean', 'ocean_r', 'okabe_ito', 'okabe_ito_r', 'pink', 'pink_r', 'plasma', 'plasma_r', 'prism', 'prism_r', 'rainbow', 'rainbow_r', 'seismic', 'seismic_r', 'spring', 'spring_r', 'summer', 'summer_r', 'tab10', 'tab10_r', 'tab20', 'tab20_r', 'tab20b', 'tab20b_r', 'tab20c', 'tab20c_r', 'terrain', 'terrain_r', 'turbo', 'turbo_r', 'twilight', 'twilight_r', 'twilight_shifted', 'twilight_shifted_r', 'vanimo', 'vanimo_r', 'viridis', 'viridis_r', 'winter', 'winter_r'",
    "cm.foo AttributeError module 'matplotlib.cm' has no attribute 'foo'",
    "cm.viridis ('viridis', 'gray_r', 'coolwarm')",
    "SM 'jet'",
    "SM None 'viridis'",
    "SM foo ValueError 'foo' is not a valid value for cmap. Did you mean: 'cool'?",
    "See `matplotlib.bivar_colormaps()` and `matplotlib.multivar_colormaps()` for bivariate and multivariate colormaps",
    "SM xyzzy ValueError 'xyzzy' is not a valid value for cmap.",
    "See `matplotlib.bivar_colormaps()` and `matplotlib.multivar_colormaps()` for bivariate and multivariate colormaps",
    "SM 3 ValueError 3 is not a valid value for cmap. Supported values are 'magma', 'inferno', 'plasma', 'viridis', 'cividis', 'twilight', 'twilight_shifted', 'turbo', 'berlin', 'managua', 'vanimo', 'Blues', 'BrBG', 'BuGn', 'BuPu', 'CMRmap', 'GnBu', 'Greens', 'Greys', 'OrRd', 'Oranges', 'PRGn', 'PiYG', 'PuBu', 'PuBuGn', 'PuOr', 'PuRd', 'Purples', 'RdBu', 'RdGy', 'RdPu', 'RdYlBu', 'RdYlGn', 'Reds', 'Spectral', 'Wistia', 'YlGn', 'YlGnBu', 'YlOrBr', 'YlOrRd', 'afmhot', 'autumn', 'binary', 'bone', 'brg', 'bwr', 'cool', 'coolwarm', 'copper', 'cubehelix', 'flag', 'gist_earth', 'gist_gray', 'gist_heat', 'gist_ncar', 'gist_rainbow', 'gist_stern', 'gist_yarg', 'gnuplot', 'gnuplot2', 'gray', 'hot', 'hsv', 'jet', 'nipy_spectral', 'ocean', 'pink', 'prism', 'rainbow', 'seismic', 'spring', 'summer', 'terrain', 'winter', 'Accent', 'okabe_ito', 'Dark2', 'Paired', 'Pastel1', 'Pastel2', 'Set1', 'Set2', 'Set3', 'tab10', 'tab20', 'tab20b', 'tab20c', 'grey', 'gist_grey', 'gist_yerg', 'Grays', 'magma_r', 'inferno_r', 'plasma_r', 'viridis_r', 'cividis_r', 'twilight_r', 'twilight_shifted_r', 'turbo_r', 'berlin_r', 'managua_r', 'vanimo_r', 'Blues_r', 'BrBG_r', 'BuGn_r', 'BuPu_r', 'CMRmap_r', 'GnBu_r', 'Greens_r', 'Greys_r', 'OrRd_r', 'Oranges_r', 'PRGn_r', 'PiYG_r', 'PuBu_r', 'PuBuGn_r', 'PuOr_r', 'PuRd_r', 'Purples_r', 'RdBu_r', 'RdGy_r', 'RdPu_r', 'RdYlBu_r', 'RdYlGn_r', 'Reds_r', 'Spectral_r', 'Wistia_r', 'YlGn_r', 'YlGnBu_r', 'YlOrBr_r', 'YlOrRd_r', 'afmhot_r', 'autumn_r', 'binary_r', 'bone_r', 'brg_r', 'bwr_r', 'cool_r', 'coolwarm_r', 'copper_r', 'cubehelix_r', 'flag_r', 'gist_earth_r', 'gist_gray_r', 'gist_heat_r', 'gist_ncar_r', 'gist_rainbow_r', 'gist_stern_r', 'gist_yarg_r', 'gnuplot_r', 'gnuplot2_r', 'gray_r', 'hot_r', 'hsv_r', 'jet_r', 'nipy_spectral_r', 'ocean_r', 'pink_r', 'prism_r', 'rainbow_r', 'seismic_r', 'spring_r', 'summer_r', 'terrain_r', 'winter_r', 'Accent_r', 'okabe_ito_r', 'Dark2_r', 'Paired_r', 'Pastel1_r', 'Pastel2_r', 'Set1_r', 'Set2_r', 'Set3_r', 'tab10_r', 'tab20_r', 'tab20b_r', 'tab20c_r', 'grey_r', 'gist_grey_r', 'gist_yerg_r', 'Grays_r'",
    "See `matplotlib.bivar_colormaps()` and `matplotlib.multivar_colormaps()` for bivariate and multivariate colormaps",
    "SM set_cmap ValueError 'cooll' is not a valid value for cmap. Did you mean one of: 'cool', 'cool_r', 'coolwarm'?",
    "See `matplotlib.bivar_colormaps()` and `matplotlib.multivar_colormaps()` for bivariate and multivariate colormaps",
    "imshow True",
    "imshow foo ValueError 'foo' is not a valid value for cmap. Did you mean: 'cool'?",
    "See `matplotlib.bivar_colormaps()` and `matplotlib.multivar_colormaps()` for bivariate and multivariate colormaps",
    "imshow rgb foo ValueError 'foo' is not a valid value for cmap. Did you mean: 'cool'?",
    "See `matplotlib.bivar_colormaps()` and `matplotlib.multivar_colormaps()` for bivariate and multivariate colormaps",
    "scatter c foo ValueError 'foo' is not a valid value for cmap. Did you mean: 'cool'?",
    "See `matplotlib.bivar_colormaps()` and `matplotlib.multivar_colormaps()` for bivariate and multivariate colormaps",
    "contourf foo ValueError 'foo' is not a valid value for cmap. Did you mean: 'cool'?",
    "See `matplotlib.bivar_colormaps()` and `matplotlib.multivar_colormaps()` for bivariate and multivariate colormaps",
    "contourf both ValueError Either colors or cmap must be None",
    "contourf ok True",
  ]);
});

test("colormaps: matplotlib 3.11.1's lookup, exactly: indices, floats, the ends, NaN, alpha, bytes", () => {
  const out = run(`
import numpy as np
from matplotlib import colormaps
m=colormaps['viridis']
for x in [0, 1, 3, 255, 256, -1, 0.0, 1.0, 0.5, 0.999, 1.5, -0.2, float('nan'), True, np.int64(7), np.float32(0.5), [0.0, 0.5], np.array([0, 300]), 0.00390625, 255/256]:
    print(repr(x), '->', repr(m(x))[:150])
print(repr(m(0.5, alpha=0.3)), repr(m(0.5, bytes=True)), repr(m([0.2,0.7], bytes=True)), repr(m(0.5, alpha=0.3, bytes=True)))
print(repr(m(np.nan, alpha=0.5)), repr(m(np.nan, alpha=0.5, bytes=True)))
t=colormaps['twilight']; print(t.N, repr(t(0.5)))
print(repr(colormaps['magma_r'](0.25)), repr(colormaps['cubehelix'](0.3)), repr(colormaps['tab10'](3)))
`);
  assert.deepEqual(out.trim().split("\n"), [
    "0 -> (np.float64(0.267004), np.float64(0.004874), np.float64(0.329415), np.float64(1.0))",
    "1 -> (np.float64(0.26851), np.float64(0.009605), np.float64(0.335427), np.float64(1.0))",
    "3 -> (np.float64(0.271305), np.float64(0.019942), np.float64(0.347269), np.float64(1.0))",
    "255 -> (np.float64(0.993248), np.float64(0.906157), np.float64(0.143936), np.float64(1.0))",
    "256 -> (np.float64(0.993248), np.float64(0.906157), np.float64(0.143936), np.float64(1.0))",
    "-1 -> (np.float64(0.267004), np.float64(0.004874), np.float64(0.329415), np.float64(1.0))",
    "0.0 -> (np.float64(0.267004), np.float64(0.004874), np.float64(0.329415), np.float64(1.0))",
    "1.0 -> (np.float64(0.993248), np.float64(0.906157), np.float64(0.143936), np.float64(1.0))",
    "0.5 -> (np.float64(0.127568), np.float64(0.566949), np.float64(0.550556), np.float64(1.0))",
    "0.999 -> (np.float64(0.993248), np.float64(0.906157), np.float64(0.143936), np.float64(1.0))",
    "1.5 -> (np.float64(0.993248), np.float64(0.906157), np.float64(0.143936), np.float64(1.0))",
    "-0.2 -> (np.float64(0.267004), np.float64(0.004874), np.float64(0.329415), np.float64(1.0))",
    "nan -> (np.float64(0.0), np.float64(0.0), np.float64(0.0), np.float64(0.0))",
    "True -> (np.float64(0.26851), np.float64(0.009605), np.float64(0.335427), np.float64(1.0))",
    "np.int64(7) -> (np.float64(0.276022), np.float64(0.044167), np.float64(0.370164), np.float64(1.0))",
    "np.float32(0.5) -> (np.float64(0.127568), np.float64(0.566949), np.float64(0.550556), np.float64(1.0))",
    "[0.0, 0.5] -> array([[0.267004, 0.004874, 0.329415, 1.      ],",
    "       [0.127568, 0.566949, 0.550556, 1.      ]])",
    "array([  0, 300]) -> array([[0.267004, 0.004874, 0.329415, 1.      ],",
    "       [0.993248, 0.906157, 0.143936, 1.      ]])",
    "0.00390625 -> (np.float64(0.26851), np.float64(0.009605), np.float64(0.335427), np.float64(1.0))",
    "0.99609375 -> (np.float64(0.993248), np.float64(0.906157), np.float64(0.143936), np.float64(1.0))",
    "(np.float64(0.127568), np.float64(0.566949), np.float64(0.550556), np.float64(0.3)) (np.uint8(32), np.uint8(144), np.uint8(140), np.uint8(255)) array([[ 64,  67, 135, 255],",
    "       [ 68, 190, 112, 255]], dtype=uint8) (np.uint8(32), np.uint8(144), np.uint8(140), np.uint8(76))",
    "(np.float64(0.0), np.float64(0.0), np.float64(0.0), np.float64(0.0)) (np.uint8(0), np.uint8(0), np.uint8(0), np.uint8(0))",
    "510 (np.float64(0.18488035509396164), np.float64(0.07942573027972388), np.float64(0.21307651648984993), np.float64(1.0))",
    "(np.float64(0.985693), np.float64(0.528148), np.float64(0.379371), np.float64(1.0)) (np.float64(0.11789134778719829), np.float64(0.39694259707734425), np.float64(0.2588678372388254), np.float64(1.0)) (np.float64(0.8392156862745098), np.float64(0.15294117647058825), np.float64(0.1568627450980392), np.float64(1.0))",
  ]);
});

test("colormaps: every one of matplotlib 3.11.1's 182 tables, exactly (a CRC of its N colors and 11 lookups)", () => {
  const out = run(`
import zlib
import numpy as np
from matplotlib import colormaps
ts = [0.0, 0.1, 0.2, 0.25, 0.3, 0.5, 0.7, 0.75, 0.9, 0.999, 1.0]
for name in colormaps:
    m = colormaps[name]
    h = "%08x" % zlib.crc32((repr(m(np.arange(m.N)).tolist()) + repr(m(ts).tolist())).encode())
    print(name, m.N, h)
`);
  assert.deepEqual(out.trim().split("\n"), [
    "magma 256 f85a3c85",
    "inferno 256 7f7c13ed",
    "plasma 256 5cc14219",
    "viridis 256 688eb018",
    "cividis 256 72a4601c",
    "twilight 510 8ac093e8",
    "twilight_shifted 510 fb0af335",
    "turbo 256 c4dc2961",
    "berlin 256 cbe80a41",
    "managua 256 bfa42d63",
    "vanimo 256 ceeaa37c",
    "Blues 256 3a1d1bcb",
    "BrBG 256 4980c4e7",
    "BuGn 256 9d10328b",
    "BuPu 256 0f3fe876",
    "CMRmap 256 d6f9428d",
    "GnBu 256 9e3f413a",
    "Greens 256 1a06a0d5",
    "Greys 256 ea9416ce",
    "OrRd 256 fbb55c31",
    "Oranges 256 19061056",
    "PRGn 256 176b6b80",
    "PiYG 256 e39a1f10",
    "PuBu 256 63a64265",
    "PuBuGn 256 20353cc4",
    "PuOr 256 8283057f",
    "PuRd 256 07a0edfe",
    "Purples 256 a213ded4",
    "RdBu 256 201770f3",
    "RdGy 256 273d6d4c",
    "RdPu 256 4573a6b6",
    "RdYlBu 256 ef5b472b",
    "RdYlGn 256 aafe97f1",
    "Reds 256 b2345c44",
    "Spectral 256 2e8c00a9",
    "Wistia 256 d88735dd",
    "YlGn 256 481f0f19",
    "YlGnBu 256 0ab8c66a",
    "YlOrBr 256 6a8dda6c",
    "YlOrRd 256 a98a08e1",
    "afmhot 256 e9dd1224",
    "autumn 256 fbb4f61e",
    "binary 256 849a2081",
    "bone 256 88fb6482",
    "brg 256 1ba27f1f",
    "bwr 256 61908ce1",
    "cool 256 77323125",
    "coolwarm 256 7dbcbc76",
    "copper 256 81cad051",
    "cubehelix 256 e95f0bd0",
    "flag 256 e8ac85c2",
    "gist_earth 256 309aeabf",
    "gist_gray 256 b6a568c1",
    "gist_heat 256 7db4b1d8",
    "gist_ncar 256 9e1200f8",
    "gist_rainbow 256 a0c9cfb0",
    "gist_stern 256 0456796f",
    "gist_yarg 256 849a2081",
    "gnuplot 256 905d4c41",
    "gnuplot2 256 33668ce0",
    "gray 256 b6a568c1",
    "hot 256 f82366ac",
    "hsv 256 70df6b1c",
    "jet 256 2886aadd",
    "nipy_spectral 256 0ebda9dd",
    "ocean 256 2080e8e3",
    "pink 256 8c1a0049",
    "prism 256 9f191e9d",
    "rainbow 256 f6886931",
    "seismic 256 24016b67",
    "spring 256 12b17dae",
    "summer 256 773708f4",
    "terrain 256 603cba52",
    "winter 256 5c812df9",
    "Accent 8 ab8bfb63",
    "okabe_ito 8 c5d4211a",
    "Dark2 8 0f7fdb9e",
    "Paired 12 85b377b9",
    "Pastel1 9 a72f66d0",
    "Pastel2 8 29944cd4",
    "Set1 9 2ccb5d91",
    "Set2 8 295dfb97",
    "Set3 12 cadaa294",
    "tab10 10 440d7165",
    "tab20 20 d61091f5",
    "tab20b 20 902614d1",
    "tab20c 20 5a8e657d",
    "grey 256 b6a568c1",
    "gist_grey 256 b6a568c1",
    "gist_yerg 256 849a2081",
    "Grays 256 ea9416ce",
    "magma_r 256 60d77b2c",
    "inferno_r 256 ded30cf6",
    "plasma_r 256 26bf1c16",
    "viridis_r 256 8365475c",
    "cividis_r 256 f2072045",
    "twilight_r 510 a3a4e782",
    "twilight_shifted_r 510 b55b829b",
    "turbo_r 256 069c17bd",
    "berlin_r 256 31cf1726",
    "managua_r 256 fdd09866",
    "vanimo_r 256 24fc07a1",
    "Blues_r 256 04cd85c0",
    "BrBG_r 256 f5462abe",
    "BuGn_r 256 a272e144",
    "BuPu_r 256 cec44948",
    "CMRmap_r 256 a80a189a",
    "GnBu_r 256 4c4331f5",
    "Greens_r 256 1d9e7ab6",
    "Greys_r 256 782b7062",
    "OrRd_r 256 c1fe279f",
    "Oranges_r 256 dc54c19b",
    "PRGn_r 256 6917524c",
    "PiYG_r 256 7b509fc0",
    "PuBu_r 256 29a6b7dd",
    "PuBuGn_r 256 ca323229",
    "PuOr_r 256 beff925e",
    "PuRd_r 256 2bc8500a",
    "Purples_r 256 96ab7cfc",
    "RdBu_r 256 e971cf33",
    "RdGy_r 256 83408672",
    "RdPu_r 256 7ad923dd",
    "RdYlBu_r 256 823ac71c",
    "RdYlGn_r 256 198caba5",
    "Reds_r 256 90e67f7e",
    "Spectral_r 256 18078984",
    "Wistia_r 256 e8b04679",
    "YlGn_r 256 dda8da2a",
    "YlGnBu_r 256 3d76116f",
    "YlOrBr_r 256 102f4e9b",
    "YlOrRd_r 256 c69d14ae",
    "afmhot_r 256 5c53aa38",
    "autumn_r 256 dd90e47c",
    "binary_r 256 b6a568c1",
    "bone_r 256 ae7b94e2",
    "brg_r 256 0f1c22e6",
    "bwr_r 256 b3d2d1cb",
    "cool_r 256 ef497bfa",
    "coolwarm_r 256 6ce15809",
    "copper_r 256 71880a05",
    "cubehelix_r 256 6d1d5514",
    "flag_r 256 27d359de",
    "gist_earth_r 256 64dda6a2",
    "gist_gray_r 256 849a2081",
    "gist_heat_r 256 8b5538ca",
    "gist_ncar_r 256 e942b549",
    "gist_rainbow_r 256 03656509",
    "gist_stern_r 256 508ce963",
    "gist_yarg_r 256 b62f3cfb",
    "gnuplot_r 256 d054e3cf",
    "gnuplot2_r 256 4d6972fd",
    "gray_r 256 849a2081",
    "hot_r 256 fa2d0ed3",
    "hsv_r 256 1a02405f",
    "jet_r 256 177ec2a2",
    "nipy_spectral_r 256 2cc9a73a",
    "ocean_r 256 52a5d38b",
    "pink_r 256 13c74db9",
    "prism_r 256 5803f298",
    "rainbow_r 256 ccbf4208",
    "seismic_r 256 d6c7bfe4",
    "spring_r 256 d5100656",
    "summer_r 256 e5746a6b",
    "terrain_r 256 2cf4e1d8",
    "winter_r 256 1412c271",
    "Accent_r 8 c29d236f",
    "okabe_ito_r 8 092ac19c",
    "Dark2_r 8 63d09e38",
    "Paired_r 12 437076eb",
    "Pastel1_r 9 ac07409a",
    "Pastel2_r 8 c0ae792f",
    "Set1_r 9 5d4e4555",
    "Set2_r 8 739dd088",
    "Set3_r 12 921787d1",
    "tab10_r 10 9594ea9c",
    "tab20_r 20 07c82722",
    "tab20b_r 20 4385f4a0",
    "tab20c_r 20 9eac02c9",
    "grey_r 256 849a2081",
    "gist_grey_r 256 849a2081",
    "gist_yerg_r 256 b62f3cfb",
    "Grays_r 256 782b7062",
  ]);
});

test("colormaps: the tables (_cmap_data) are imported by the first colormapped drawing, not at start", () => {
  const py = run(`
import io, sys
import matplotlib.pyplot as plt
print("start", "_cmap_data" in sys.modules)
plt.plot([1, 2], [3, 4])
plt.savefig(io.BytesIO(), format="svg")
print("line plot", "_cmap_data" in sys.modules)
plt.figure()
plt.imshow([[1, 2], [3, 4]])
plt.savefig(io.BytesIO(), format="svg")
print("imshow", "_cmap_data" in sys.modules)
`);
  assert.deepEqual(py.trim().split("\n"), ["start False", "line plot False", "imshow True"]);
  const sage = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--sage", "-c", `
import os, sys, tempfile
d = tempfile.mkdtemp()
print("start", "_cmap_data" in sys.modules)
var('x y')
plot(x^2, (x, 0, 1)).save(os.path.join(d, 'p.svg'))
print("plot", "_cmap_data" in sys.modules)
density_plot(x*y, (x, -1, 1), (y, -1, 1), cmap='gray_r').save(os.path.join(d, 'd.svg'))
print("density_plot", "_cmap_data" in sys.modules)
`], { encoding: "utf8" });
  assert.deepEqual(sage.trim().split("\n"), ["start False", "plot False", "density_plot True"]);
});
