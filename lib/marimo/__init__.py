"""A small part of marimo's API (marimo.io), so that marimo notebooks opened
in Sagebrush's notebook (File > Open, a marimo .py file) run here: mo.md,
the common mo.ui controls, hstack and vstack, stop, and state.

The controls are Sagebrush's ipywidgets: in the reactive notebook, moving
one reruns the cells that read it, as in marimo.  This is our own small
implementation of those names, not marimo.

EXAMPLES::

    >>> import marimo as mo
    >>> mo.md("# Title\\n\\nText")._repr_markdown_()
    '# Title\\n\\nText'
    >>> s = mo.ui.slider(1, 10, value=3, label="n")
    >>> s.value, type(s).__name__
    (3, 'IntSlider')
    >>> mo.ui.slider(0, 1, step=0.1).value
    0.0
    >>> d = mo.ui.dropdown({"one": 1, "two": 2}, value="two")
    >>> d.value
    2
"""

import ipywidgets as _w

__version__ = "0.0 (Sagebrush's subset)"


class Html:
    """Markdown output (what mo.md returns)."""

    def __init__(self, text):
        self.text = text

    def _repr_markdown_(self):
        return self.text

    def __repr__(self):
        return self.text


def _dedent(text):
    lines = text.split("\n")
    ind = min((len(l) - len(l.lstrip()) for l in lines if l.strip()), default=0)
    return "\n".join(l[ind:] if l.strip() else "" for l in lines)


def md(text):
    """Markdown, shown rendered (with LaTeX math)."""
    return Html(_dedent(str(text)).strip())


class _Ui:
    """mo.ui: controls whose .value the cells read."""

    @staticmethod
    def slider(start=0, stop=100, step=None, value=None, label="", **kw):
        if all(isinstance(x, int) for x in (start, stop, step if step is not None else 1)):
            return _w.IntSlider(value if value is not None else start, start, stop, step or 1, description=label)
        step = step if step is not None else (stop - start) / 100
        return _w.FloatSlider(float(value if value is not None else start), float(start), float(stop), float(step), description=label)

    @staticmethod
    def number(start=None, stop=None, step=None, value=None, label="", **kw):
        v = value if value is not None else (start if start is not None else 0)
        ints = all(isinstance(x, int) for x in (v, step if step is not None else 1))
        return (_w.IntText if ints else _w.FloatText)(v, description=label)

    @staticmethod
    def dropdown(options, value=None, label="", **kw):
        if isinstance(options, dict):
            # (marimo's value is the option's value; its `value=` names the option)
            return _w.Dropdown(list(options.items()), options[value] if value is not None else None, description=label)
        return _w.Dropdown(list(options), value, description=label)

    radio = dropdown

    @staticmethod
    def checkbox(value=False, label="", **kw):
        return _w.Checkbox(value, description=label)

    switch = checkbox

    @staticmethod
    def text(value="", label="", **kw):
        return _w.Text(value, description=label)

    text_area = text

    @staticmethod
    def button(label="click", on_click=None, value=None, **kw):
        b = _w.Button(description=label)
        if on_click is not None:
            b.on_click(lambda _b: on_click(value))
        return b


ui = _Ui()


class _Stack:
    def __init__(self, items, horizontal):
        self.items, self.horizontal = list(items), horizontal

    def _ipython_display_(self):
        from IPython.display import display
        widgets = [x for x in self.items if isinstance(x, _w._Widget)]
        if len(widgets) == len(self.items):
            display((_w.HBox if self.horizontal else _w.VBox)(self.items))
        else:
            for x in self.items:
                display(x)


def hstack(items, **kw):
    """Items side by side (here: controls in a row; other outputs in turn)."""
    return _Stack(items, True)


def vstack(items, **kw):
    """Items one above the other."""
    return _Stack(items, False)


class MarimoStopError(SystemExit):
    """mo.stop: ends the cell quietly."""


def stop(predicate, output=None):
    """End the cell here if `predicate` is true, showing `output` if given."""
    if predicate:
        if output is not None:
            from IPython.display import display
            display(output)
        raise MarimoStopError()


def state(value):
    """A value and its setter: (get, set).  (Here setting it does not rerun the cells reading it.)"""
    box = [value]

    def get():
        return box[0]

    def set_(v):
        box[0] = v(box[0]) if callable(v) else v

    return get, set_


class App:
    """marimo.App, for running a marimo file as a script here (the cells are not run)."""

    def __init__(self, **kw):
        self.kw = kw

    def cell(self, f=None, **kw):
        return f if f is not None else (lambda g: g)

    function = class_definition = cell

    def run(self):
        pass
