"""A light ipywidgets for sagebrush: interact and the common controls,
drawn natively by the notebook (sagebrush.space).

    from ipywidgets import interact
    @interact(n=(1, 10), kind=['sin', 'cos'])
    def f(n=3, kind='sin'): ...

Abbreviations follow ipywidgets: (a, b) or (a, b, step) is a slider (an
IntSlider when all are ints), a number v is a slider over [-v, 3v], a list a
dropdown, a bool a checkbox, a str a text box.  This is not the full widget
protocol (no Output, Layout, observe or jslink); that is a separate,
heavier layer.
"""

import _interact
from _interact import fixed

__version__ = "8.1.0+sagebrush"


def _abbrev(name, default, initial=None):
    if isinstance(default, _Widget):
        return default._control()
    if isinstance(default, (_interact.Control, fixed)):
        return default
    if isinstance(default, bool):
        return _interact.checkbox(default)
    if isinstance(default, (int, float)):
        v = default
        if isinstance(v, int):
            lo, hi = (-v, 3 * v) if v > 0 else (3 * v, -v) if v < 0 else (0, 10)
            return _interact.slider(lo, hi, 1, v)
        lo, hi = (-v, 3 * v) if v > 0 else (3 * v, -v) if v < 0 else (0.0, 1.0)
        return _interact.slider(lo, hi, (hi - lo) / 100, v)
    if isinstance(default, dict):
        default = list(default.keys())
    c = _interact._control(name, default, initial)
    if isinstance(c, _interact.selector):
        c.buttons = False  # ipywidgets: a list is a Dropdown
    return c


def interact(f=None, **controls):
    return _interact.interact(f, _abbrev=_abbrev, **controls)


interact_manual = interactive = interact


class _Widget:
    def __init__(self, value=None, description="", **kw):
        self.value, self.description, self.kw = value, description, kw

    def __repr__(self):
        return "%s(value=%r, description=%r)" % (type(self).__name__, self.value, self.description)


class IntSlider(_Widget):
    def __init__(self, value=0, min=0, max=100, step=1, description="", **kw):
        super().__init__(value, description)
        self.min, self.max, self.step = min, max, step

    def _control(self):
        return _interact.slider(int(self.min), int(self.max), int(self.step), int(self.value), label=self.description or None)


class FloatSlider(IntSlider):
    def __init__(self, value=0.0, min=0.0, max=10.0, step=0.1, description="", **kw):
        super().__init__(value, min, max, step, description)

    def _control(self):
        return _interact.slider(float(self.min), float(self.max), float(self.step), float(self.value), label=self.description or None)


class IntRangeSlider(IntSlider):
    def __init__(self, value=(25, 75), min=0, max=100, step=1, description="", **kw):
        _Widget.__init__(self, tuple(value), description)
        self.min, self.max, self.step = min, max, step

    def _control(self):
        return _interact.range_slider(self.min, self.max, self.step, self.value, label=self.description or None)


FloatRangeSlider = IntRangeSlider


class Dropdown(_Widget):
    _buttons = False

    def __init__(self, options=(), value=None, description="", **kw):
        opts = list(options.items()) if isinstance(options, dict) else list(options)
        self.labels = [o[0] if isinstance(o, tuple) else str(o) for o in opts]
        self.values = [o[1] if isinstance(o, tuple) else o for o in opts]
        super().__init__(value if value is not None else (self.values[0] if self.values else None), description)

    def _control(self):
        c = _interact.selector(self.values, label=self.description or None, default=self.value, buttons=self._buttons)
        c.spec_labels = self.labels
        return c


class RadioButtons(Dropdown):
    _buttons = True


ToggleButtons = Select = RadioButtons


class Checkbox(_Widget):
    def __init__(self, value=False, description="", **kw):
        super().__init__(bool(value), description)

    def _control(self):
        return _interact.checkbox(self.value, label=self.description or None)


ToggleButton = Checkbox


class Text(_Widget):
    _type = str

    def __init__(self, value="", description="", **kw):
        super().__init__(value, description)

    def _control(self):
        return _interact.input_box(self.value, label=self.description or None, type=self._type)


class IntText(Text):
    _type = int


class FloatText(Text):
    _type = float


class ColorPicker(_Widget):
    def __init__(self, value="#1f77b4", description="", **kw):
        super().__init__(value, description)

    def _control(self):
        return _interact.color_selector(self.value, label=self.description or None)


class Label(_Widget):
    def _control(self):
        return _interact.text_control(self.value)


HTML = Label
