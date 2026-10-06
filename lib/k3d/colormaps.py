"""Color maps in k3d's format: a flat list [t0, r0, g0, b0, t1, r1, ...],
t and r, g, b in [0, 1].  The three families k3d has (matplotlib,
basic and paraview), from their published control colors; names match
k3d's, in any capitalization."""


def _hexes(*hs):
    """Evenly spaced hex colors as a color map."""
    out = []
    n = len(hs) - 1
    for i, h in enumerate(hs):
        out += [i / n, int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255]
    return out


def _stops(*pts):
    """(t, r, g, b) control points as a color map."""
    out = []
    for p in pts:
        out += list(p)
    return out


def _reversed(cm):
    pts = [cm[i:i + 4] for i in range(0, len(cm), 4)]
    return _stops(*[(1 - t, r, g, b) for t, r, g, b in reversed(pts)])


class _Family:
    def __init__(self, name, maps):
        self.__name__ = name
        self._maps = maps
        self._lower = {k.lower().replace("_", ""): k for k in maps}

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        key = self._lower.get(name.lower().replace("_", ""))
        if key is None:
            raise AttributeError("%s has no color map %r (it has %s)" % (self.__name__, name, ", ".join(sorted(self._maps))))
        return list(self._maps[key])

    def __dir__(self):
        return sorted(self._maps)


_viridis = _hexes("440154", "482878", "3e4989", "31688e", "26828e", "1f9e89", "35b779", "6ece58", "b5de2b", "fde725")
_plasma = _hexes("0d0887", "46039f", "7201a8", "9c179e", "bd3786", "d8576b", "ed7953", "fb9f3a", "fdca26", "f0f921")
_inferno = _hexes("000004", "1b0c41", "4a0c6b", "781c6d", "a52c60", "cf4446", "ed6925", "fb9b06", "f7d13d", "fcffa4")
_magma = _hexes("000004", "180f3d", "440f76", "721f81", "9e2f7f", "cd4071", "f1605d", "fd9668", "feca8d", "fcfdbf")
_cividis = _hexes("00224e", "123570", "3b496c", "575d6d", "707173", "8a8678", "a59c74", "c3b369", "e1cc55", "fee838")
_seismic = _stops((0, 0, 0, 0.3), (0.25, 0, 0, 1), (0.5, 1, 1, 1), (0.75, 1, 0, 0), (1, 0.5, 0, 0))
_bwr = _stops((0, 0, 0, 1), (0.5, 1, 1, 1), (1, 1, 0, 0))
_coolwarm = _hexes("3b4cc0", "6788ee", "9abbff", "c9d7f0", "edd1c2", "f7a889", "e26952", "b40426")
_rdbu = _hexes("67001f", "b2182b", "d6604d", "f4a582", "fddbc7", "f7f7f7", "d1e5f0", "92c5de", "4393c3", "2166ac", "053061")
_jet = _stops((0, 0, 0, 0.5), (0.11, 0, 0, 1), (0.125, 0, 0, 1), (0.34, 0, 0.86, 1), (0.35, 0, 0.9, 0.97),
              (0.64, 1, 1, 0), (0.66, 1, 0.9, 0), (0.89, 1, 0, 0), (1, 0.5, 0, 0))
_hot = _stops((0, 0.0416, 0, 0), (0.365, 1, 0, 0), (0.746, 1, 1, 0), (1, 1, 1, 1))
_gray = _stops((0, 0, 0, 0), (1, 1, 1, 1))
_binary = _stops((0, 1, 1, 1), (1, 0, 0, 0))
_rainbow = _hexes("7f00ff", "3f61fa", "00b4eb", "40ecd3", "80feb3", "c0eb8d", "ffb360", "ff6130", "ff0000")
_spectral = _hexes("9e0142", "d53e4f", "f46d43", "fdae61", "fee08b", "ffffbf", "e6f598", "abdda4", "66c2a5", "3288bd", "5e4fa2")
_blues = _hexes("f7fbff", "deebf7", "c6dbef", "9ecae1", "6baed6", "4292c6", "2171b5", "08519c", "08306b")
_reds = _hexes("fff5f0", "fee0d2", "fcbba1", "fc9272", "fb6a4a", "ef3b2c", "cb181d", "a50f15", "67000d")
_greens = _hexes("f7fcf5", "e5f5e0", "c7e9c0", "a1d99b", "74c476", "41ab5d", "238b45", "006d2c", "00441b")
_oranges = _hexes("fff5eb", "fee6ce", "fdd0a2", "fdae6b", "fd8d3c", "f16913", "d94801", "a63603", "7f2704")
_purples = _hexes("fcfbfd", "efedf5", "dadaeb", "bcbddc", "9e9ac8", "807dba", "6a51a3", "54278f", "3f007d")
_piyg = _hexes("8e0152", "c51b7d", "de77ae", "f1b6da", "fde0ef", "f7f7f7", "e6f5d0", "b8e186", "7fbc41", "4d9221", "276419")
_brbg = _hexes("543005", "8c510a", "bf812d", "dfc27d", "f6e8c3", "f5f5f5", "c7eae5", "80cdc1", "35978f", "01665e", "003c30")
_turbo = _hexes("30123b", "4145ab", "4675ed", "39a2fc", "1bcfd4", "24eca6", "61fc6c", "a4fc3b", "d1e834", "f3c63a",
                "fe9b2d", "f36315", "d93806", "b11901", "7a0402")
_cool = _stops((0, 0, 1, 1), (1, 1, 0, 1))
_terrain = _hexes("333399", "0294fa", "20d482", "fefe98", "856d4f", "ffffff")
_black_body = _stops((0, 0, 0, 0), (0.39, 0.9, 0, 0), (0.58, 0.9, 0.46, 0.1), (0.84, 0.9, 0.9, 0.2), (1, 1, 1, 1))

_mpl = {
    "Viridis": _viridis, "Plasma": _plasma, "Inferno": _inferno, "Magma": _magma, "Cividis": _cividis,
    "Seismic": _seismic, "Bwr": _bwr, "Coolwarm": _coolwarm, "RdBu": _rdbu, "Jet": _jet, "Hot": _hot,
    "Gray": _gray, "Grey": _gray, "Binary": _binary, "Rainbow": _rainbow, "Spectral": _spectral,
    "Blues": _blues, "Reds": _reds, "Greens": _greens, "Oranges": _oranges, "Purples": _purples,
    "PiYG": _piyg, "BrBG": _brbg, "Turbo": _turbo, "Cool": _cool, "Terrain": _terrain,
}
# matplotlib's reversed maps: seismic_r, viridis_r, ...
_mpl.update({k + "_r": _reversed(v) for k, v in list(_mpl.items())})
matplotlib_color_maps = _Family("matplotlib_color_maps", _mpl)

basic_color_maps = _Family("basic_color_maps", {
    "Rainbow": _rainbow, "Jet": _jet, "Binary": _binary, "Grayscale": _gray, "BlackBodyRadiation": _black_body,
    "Blues": _blues, "Greens": _greens, "Reds": _reds, "CoolWarm": _coolwarm, "WarmCool": _reversed(_coolwarm),
    "Gold": _stops((0, 0.2, 0.15, 0), (0.5, 0.8, 0.6, 0.1), (1, 1, 0.95, 0.6)),
})

paraview_color_maps = _Family("paraview_color_maps", {
    "Cool_to_Warm": _coolwarm, "Coolwarm": _coolwarm, "Rainbow_Desaturated": _rainbow, "Jet": _jet,
    "Viridis_matplotlib": _viridis, "Inferno_matplotlib": _inferno, "Plasma_matplotlib": _plasma,
    "Magma_matplotlib": _magma, "Black_Body_Radiation": _black_body, "Grayscale": _gray,
    "Blue_Orange_divergent": _stops((0, 0.09, 0.29, 0.6), (0.5, 0.9, 0.9, 0.9), (1, 0.85, 0.35, 0.05)),
    "Rainbow_Uniform": _turbo, "Turbo": _turbo, "Haze": _stops((0, 1, 1, 1), (1, 0.2, 0.3, 0.6)),
})
