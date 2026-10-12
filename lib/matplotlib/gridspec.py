"""matplotlib.gridspec: GridSpec and SubplotSpec, positioned as matplotlib does
(subplot parameters left/right/bottom/top, wspace/hspace, width and height
ratios).  fig.add_subplot(gs[i, j]) places axes exactly there."""


class GridSpec:
    def __init__(self, nrows, ncols, figure=None, left=None, bottom=None, right=None, top=None,
                 wspace=None, hspace=None, width_ratios=None, height_ratios=None):
        self.nrows, self.ncols, self.figure = int(nrows), int(ncols), figure
        self.left = 0.125 if left is None else float(left)
        self.right = 0.9 if right is None else float(right)
        self.bottom = 0.11 if bottom is None else float(bottom)
        self.top = 0.88 if top is None else float(top)
        self.wspace = 0.2 if wspace is None else float(wspace)
        self.hspace = 0.2 if hspace is None else float(hspace)
        self.width_ratios = [float(r) for r in width_ratios] if width_ratios is not None else [1.0] * self.ncols
        self.height_ratios = [float(r) for r in height_ratios] if height_ratios is not None else [1.0] * self.nrows

    def get_geometry(self):
        return self.nrows, self.ncols

    def update(self, **kw):
        for k, v in kw.items():
            if v is not None:
                setattr(self, k, float(v))

    def get_grid_positions(self, fig=None):
        """(bottoms, tops, lefts, rights) of the cells, in figure fractions (matplotlib's formulas)."""
        def cells(lo, hi, n, space, ratios, reverse):
            tot = hi - lo
            cell = tot / (n + space * (n - 1))
            sep = space * cell
            norm = cell * n / sum(ratios)
            sizes = [r * norm for r in ratios]
            starts, ends, at = [], [], 0.0
            for i in range(n):
                if i:
                    at += sep
                starts.append(at)
                at += sizes[i]
                ends.append(at)
            if reverse:  # rows: from the top down
                return [hi - e for e in ends], [hi - s for s in starts]
            return [lo + s for s in starts], [lo + e for e in ends]
        bottoms, tops = cells(self.bottom, self.top, self.nrows, self.hspace, self.height_ratios, True)
        lefts, rights = cells(self.left, self.right, self.ncols, self.wspace, self.width_ratios, False)
        return bottoms, tops, lefts, rights

    def _span(self, key, n):
        if isinstance(key, slice):
            idx = list(range(n))[key]
            return idx[0], idx[-1]
        k = int(key)
        if k < 0:
            k += n
        if not 0 <= k < n:
            raise IndexError("index %d is out of range for a grid of %d" % (key, n))
        return k, k

    def __getitem__(self, key):
        if isinstance(key, tuple):
            r, c = key
            r0, r1 = self._span(r, self.nrows)
            c0, c1 = self._span(c, self.ncols)
        else:  # a flat index, row by row
            i0, i1 = self._span(key, self.nrows * self.ncols)
            r0, c0 = divmod(i0, self.ncols)
            r1, c1 = divmod(i1, self.ncols)
        return SubplotSpec(self, r0, r1, c0, c1)

    def subplots(self, **kw):
        fig = self.figure
        return [[fig.add_subplot(self[r, c]) for c in range(self.ncols)] for r in range(self.nrows)]


class SubplotSpec:
    def __init__(self, gs, r0, r1, c0, c1):
        self._gs, self.rowspan, self.colspan = gs, range(r0, r1 + 1), range(c0, c1 + 1)

    def get_gridspec(self):
        return self._gs

    def get_position(self, fig=None):
        """(left, top-from-the-top, width, height) in figure fractions."""
        bottoms, tops, lefts, rights = self._gs.get_grid_positions(fig)
        r0, r1, c0, c1 = self.rowspan[0], self.rowspan[-1], self.colspan[0], self.colspan[-1]
        left, right, bottom, top = lefts[c0], rights[c1], bottoms[r1], tops[r0]
        return (left, 1 - top, right - left, top - bottom)


class GridSpecFromSubplotSpec(GridSpec):
    def __init__(self, nrows, ncols, subplot_spec, wspace=None, hspace=None, width_ratios=None, height_ratios=None):
        l, t, w, h = subplot_spec.get_position()
        super().__init__(nrows, ncols, left=l, right=l + w, bottom=1 - t - h, top=1 - t, wspace=wspace, hspace=hspace,
                         width_ratios=width_ratios, height_ratios=height_ratios)
