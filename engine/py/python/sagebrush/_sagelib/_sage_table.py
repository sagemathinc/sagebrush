"""Sage's table(): rows (or columns) of values shown as a text grid, a LaTeX
tabular, or an HTML table, with an optional header row and header column, a
frame and an alignment (sage.misc.table, written from what Sage 10.10 shows).

The text form is Sage's: columns padded to their widest entry, three spaces
between them, " | " (a box-drawing bar) after a header column, a rule under a
header row, and box-drawing lines all round with frame=True.  In the LaTeX and
HTML forms a string is written as it is and anything else as its LaTeX, in
math mode.  A notebook shows the HTML (Jupyter), or a Markdown table
(Sagebrush's notebook, which typesets the Markdown's math).
"""

__all__ = ["table"]

_OPTIONS = ("header_row", "header_column", "frame", "align")


def _latex(v):
    from _sage_expr import latex
    return str(latex(v))


def _cell_tex(v):
    # (a string as it is, anything else as its LaTeX in math mode: Sage's)
    return v if isinstance(v, str) else "$" + _latex(v) + "$"


def _math_html(s):
    # (a string's $...$ as \(...\), as Sage's HTML has them; the rest as it is)
    out, i = [], 0
    while True:
        a = s.find("$", i)
        b = s.find("$", a + 1) if a >= 0 else -1
        if a < 0 or b < 0:
            out.append(s[i:])
            return "".join(out)
        out.append(s[i:a] + "\\(" + s[a + 1:b] + "\\)")
        i = b + 1


def _cell_html(v):
    return _math_html(v) if isinstance(v, str) else "\\(" + _latex(v) + "\\)"


class table:
    """A table of values: ``table(rows, header_row=False, header_column=False,
    frame=False, align='left')``, or ``table(columns=...)``.

    ``header_row`` and ``header_column`` are True (the first row or column is
    the header) or a list of headers, put before the rows (or each row).
    ``align`` is ``'left'``, ``'center'`` or ``'right'``.

    EXAMPLES::

        sage: print(table([[1, 2], [3, 4]], header_row=["a", "b"]))
          a   b
        ├───┼───┤
          1   2
          3   4
        sage: table([[1, 22], [333, 4]], align='right')
            1   22
          333    4
        sage: table([['x', 1, 2], ['y', 3, 4]], header_column=True, frame=True)
        ┌───╥───┬───┐
        │ x ║ 1 │ 2 │
        ├───╫───┼───┤
        │ y ║ 3 │ 4 │
        └───╨───┴───┘
        sage: print(latex(table([[1/2, x^2], [sqrt(2), 'text']], header_row=['a', 'b'])))
        \\begin{tabular}{ll}
        a & b \\\\ \\hline
        $\\frac{1}{2}$ & $x^{2}$ \\\\
        $\\sqrt{2}$ & text \\\\
        \\end{tabular}
        sage: table(columns=[[1, 2, 3], [4, 5, 6]])
          1   4
          2   5
          3   6
        sage: t = table([[1, 2], [3, 4]]); t.options(frame=True, header_row=True); t
        ┌───┬───┐
        │ 1 │ 2 │
        ╞═══╪═══╡
        │ 3 │ 4 │
        └───┴───┘
        sage: t.options()
        {'align': 'left', 'frame': True, 'header_column': False, 'header_row': True}
        sage: table([[1]], columns=[[1]])
        Traceback (most recent call last):
        ...
        ValueError: do not set both 'rows' and 'columns' when defining a table

    Rows of different lengths are cut to the shortest in the text form, and
    an empty first row shows nothing (Sage's)::

        sage: table([[1, 2], [3]], header_column=True)
          1 │
          3 │
        sage: str(table([[], [1, 2]]))
        ''
        sage: table([[1, 2], []])._html_()
        Traceback (most recent call last):
        ...
        IndexError: list index out of range
    """

    def __init__(self, rows=None, columns=None, header_row=False, header_column=False, frame=False, align="left"):
        if rows is not None and columns is not None:
            raise ValueError("do not set both 'rows' and 'columns' when defining a table")
        if columns is not None:
            rows = [list(r) for r in zip(*columns)] or None
        # (no rows at all: a TypeError, as Sage's)
        if rows is None:
            raise TypeError("a table needs its rows, or its columns")
        rows = list(rows)
        # (a row is a list or a tuple; anything else, a range included, makes the one row it is in: Sage's; and
        # an empty table is its IndexError, as Sage's)
        if not isinstance(rows[0], (list, tuple)):
            rows = [rows]
        rows = [list(r) for r in rows]
        # (a list of headers: a row, or a column, put before the others; Sage's order: the row first)
        if header_row is not True and header_row is not False:
            rows = [list(header_row)] + rows
            header_row = True
        if header_column is not True and header_column is not False:
            rows = [[h] + r for h, r in zip(header_column, rows)]
            header_column = True
        self._rows = rows
        self._options = {"header_row": header_row, "header_column": header_column, "frame": frame, "align": align}

    def options(self, **kwds):
        """The table's options (header_row, header_column, frame, align), or
        with keywords, set them (header_row and header_column: True or False).

        EXAMPLES::

            sage: t = table([[1, 2]]); t.options(align='right'); t.options()['align']
            'right'
        """
        if not kwds:
            return dict(self._options)
        for k, v in kwds.items():
            if k not in _OPTIONS:
                raise ValueError("%s is not a table option" % k)
            if k in ("header_row", "header_column") and v is not True and v is not False:
                raise TypeError("%s should be either True or False." % k)
            self._options[k] = v

    def transpose(self):
        """The table with rows and columns exchanged (its options kept).

        EXAMPLES::

            sage: table([[1, 2, 3], [4, 5, 6]]).transpose()
              1   4
              2   5
              3   6
        """
        t = table([list(r) for r in zip(*self._rows)])
        t._options = dict(self._options)
        return t

    # ---- the text form
    def _str_rows(self):
        # (columns as Sage counts them: as many as the shortest row has)
        rows = [[str(c) for c in r] for r in self._rows]
        cols = list(zip(*rows))
        widths = [max(len(c) for c in col) for col in cols]
        return [list(r[:len(widths)]) for r in rows], widths

    def _pad(self, s, w):
        a = self._options["align"]
        return s.rjust(w) if a == "right" else s.center(w) if a == "center" else s.ljust(w)

    def __str__(self):
        # (an empty first row: nothing at all, whatever the options, as Sage's)
        if not self._rows[0]:
            return ""
        rows, widths = self._str_rows()
        o = self._options
        hcol, frame = o["header_column"], o["frame"]
        if not frame:
            def line(r):
                cells = [self._pad(c, w) for c, w in zip(r, widths)]
                # (a header column's bar even with nothing after it; with no columns at all, Sage's IndexError)
                if hcol:
                    return ("  " + cells[0] + " │ " + "   ".join(cells[1:])).rstrip()
                return ("  " + "   ".join(cells)).rstrip()
            rule = "├" + "┼".join("─" * (w + 2) for w in widths) + "┤"
            out = []
            for i, r in enumerate(rows):
                out.append(line(r))
                if i == 0 and o["header_row"]:
                    out.append(rule)
            # (the blank lines of rows left with no columns, at either end, dropped: Sage's)
            return "\n".join(out).strip("\n")

        def border(left, mid, after_head, right, fill):
            segs = [fill * (w + 2) for w in widths]
            s = left
            for j, seg in enumerate(segs):
                s += seg + (right if j == len(segs) - 1 else (after_head if hcol and j == 0 else mid))
            # (no columns: the corners alone)
            return s if segs else left + right

        def line(r):
            cells = [self._pad(c, w) for c, w in zip(r, widths)]
            s = "│"
            for j, c in enumerate(cells):
                s += " " + c + " " + ("║" if hcol and j == 0 and len(cells) > 1 else "│")
            return s
        out = [border("┌", "┬", "╥", "┐", "─")]
        for i, r in enumerate(rows):
            out.append(line(r))
            if i < len(rows) - 1:
                out.append(border("╞", "╪", "╫", "╡", "═") if i == 0 and o["header_row"] else border("├", "┼", "╫", "┤", "─"))
        out.append(border("└", "┴", "╨", "┘", "─"))
        return "\n".join(out)

    __repr__ = __str__

    # ---- LaTeX
    def _latex_(self):
        o = self._options
        n = len(self._rows[0])
        # (an empty first row: no tabular at all, as Sage's)
        if not n:
            return ""
        a = str(o["align"])[:1]
        # (a header column: a double bar after it in a frame, a single one without)
        hc = o["header_column"] and n > 0
        if o["frame"]:
            spec = "|" + (a + "||" + "|".join([a] * (n - 1)) if hc else "|".join([a] * n)) + "|"
        else:
            spec = a + "|" + a * (n - 1) if hc else a * n
        out = ["\\begin{tabular}{" + spec + "}" + (" \\hline" if o["frame"] else "")]
        for i, r in enumerate(self._rows):
            end = " \\\\"
            if i == 0 and o["header_row"]:
                end += " \\hline \\hline" if o["frame"] else " \\hline"
            elif o["frame"]:
                end += " \\hline"
            out.append(" & ".join(_cell_tex(c) for c in r) + end)
        out.append("\\end{tabular}")
        return "\n".join(out)

    # ---- HTML (Jupyter's notebooks typeset its \(...\))
    def _html_(self):
        """The table as Sage's HTML.

        EXAMPLES::

            sage: print(table([[1, 'a']], header_row=['x', 'y'])._html_())
            <div class="notruncate">
            <table  class="table_form">
            <tbody>
            <tr>
            <th style="text-align:left">x</th>
            <th style="text-align:left">y</th>
            </tr>
            <tr class ="row-a">
            <td style="text-align:left">\\(1\\)</td>
            <td style="text-align:left">a</td>
            </tr>
            </tbody>
            </table>
            </div>
        """
        o = self._options
        # (a row with no entries: Sage's IndexError)
        if any(not r for r in self._rows):
            raise IndexError("list index out of range")
        a = o["align"]
        style = ' style="text-align:%s"' % a if a in ("left", "center", "right") else ""
        out = ['<div class="notruncate">', "<table " + ('border="1"' if o["frame"] else "") + ' class="table_form">', "<tbody>"]
        rows = self._rows
        k = 0
        for i, r in enumerate(rows):
            head = i == 0 and o["header_row"]
            out.append("<tr>" if head else '<tr class ="row-%s">' % ("a" if k % 2 == 0 else "b"))
            if not head:
                k += 1
            tag = "th" if head else "td"
            for j, c in enumerate(r):
                # (a header column's cell: class "ch", and the alignment's style (Sage 10.10 writes
                # a literal "{style_attr}" there, a slip; this is what it means))
                attrs = (' class="ch"' + style) if o["header_column"] and j == 0 else style
                out.append("<%s%s>%s</%s>" % (tag, attrs, _cell_html(c), tag))
            out.append("</tr>")
        out += ["</tbody>", "</table>", "</div>"]
        return "\n".join(out)

    def _repr_html_(self):
        # (none where Sage's HTML is an error, a row with no entries: the display falls back to the text)
        try:
            return self._html_()
        except IndexError:
            return None

    # ---- Markdown (Sagebrush's notebook: its Markdown output typesets $...$)
    def _repr_markdown_(self):
        """The table as a Markdown table, its values' LaTeX in $...$ (a table
        without a header row has an empty one: Markdown's tables need it).

        EXAMPLES::

            sage: print(table([[1/2, 'a']], header_row=['x', 'y'])._repr_markdown_())  # sagebrush only
            | x | y |
            |:---|:---|
            | $\\frac{1}{2}$ | a |
        """
        o = self._options
        # (none where Sage's HTML is an error, a row with no entries: the display falls back to the text)
        if any(not r for r in self._rows):
            return None
        rows = [list(r) for r in self._rows]
        n = len(rows[0]) if rows else 0
        md = lambda v: (v if isinstance(v, str) else "$" + _latex(v) + "$").replace("|", "\\|").replace("\n", " ")
        head = rows.pop(0) if o["header_row"] and rows else [""] * n
        a = o["align"]
        rule = ":---:" if a == "center" else "---:" if a == "right" else ":---"
        out = ["| " + " | ".join(md(c) for c in head) + " |", "|" + "|".join(rule for _ in range(n)) + "|"]
        for r in rows:
            cells = [md(c) for c in r]
            if o["header_column"] and cells:
                cells[0] = "**" + cells[0] + "**" if cells[0] else cells[0]
            out.append("| " + " | ".join(cells) + " |")
        return "\n".join(out)
