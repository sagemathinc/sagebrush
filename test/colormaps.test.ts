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
t("cm.get_cmap", lambda: cm.get_cmap)
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
    "cm.get_cmap AttributeError module 'matplotlib.cm' has no attribute 'get_cmap'",
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

test("colormaps: one matplotlib has that Sagebrush does not draw yet is an error, not another colormap", () => {
  const out = run(`
import matplotlib.pyplot as plt
from matplotlib import colormaps
for f in [lambda: colormaps["magma"], lambda: plt.imshow([[1, 2]], cmap="inferno_r")]:
    try:
        f()
    except NotImplementedError as e:
        print(str(e).split(" (")[0])
`);
  assert.deepEqual(out.trim().split("\n"), [
    "matplotlib's colormap 'magma' is not in Sagebrush yet",
    "matplotlib's colormap 'inferno_r' is not in Sagebrush yet",
  ]);
});
