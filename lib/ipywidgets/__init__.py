"""A light ipywidgets for sagebrush: interact and the common controls,
drawn natively by the notebook (sagebrush.space).

    from ipywidgets import interact
    @interact(n=(1, 10), kind=['sin', 'cos'])
    def f(n=3, kind='sin'): ...

Abbreviations follow ipywidgets: (a, b) or (a, b, step) is a slider (an
IntSlider when all are ints), a number v is a slider over [-v, 3v], a list a
dropdown, a bool a checkbox, a str a text box.

Widgets also work on their own: a widget (or a VBox/HBox of them) that is
displayed, as a cell's value or with display(), is drawn as controls; moving
one sets its .value, calls the handlers given to .observe() (Button: to
.on_click()) and reruns the functions of interactive_output(), whose output
appears under the controls.

    from ipywidgets import IntSlider, Button, VBox, interactive_output
    n = IntSlider(5, 1, 10, description="n")
    def f(n): print(n * n)
    out = interactive_output(f, {"n": n})
    VBox([n])

This is not the full widget protocol: setting .value from Python does not
move a control already drawn, and there is no jslink or Layout.
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


interact_manual = interact


class interactive:
    """interactive(f, **controls): the controls and f's output, as a widget
    to display (interact(f, ...) shows them at once)."""

    def __init__(self, f, **controls):
        self.f, self.kwargs = f, controls

    def _ipython_display_(self):
        interact(self.f, **self.kwargs)

    def __repr__(self):
        return "interactive(%s)" % getattr(self.f, "__name__", "f")


class _Widget:
    def __init__(self, value=None, description="", **kw):
        self._value, self.description, self.kw = value, description, kw
        self._observers = []
        self._linked = []  # interactive_output()s using this widget

    @property
    def value(self):
        return self._value

    @value.setter
    def value(self, v):
        old = self._value
        self._value = v
        if old != v:
            change = {"name": "value", "old": old, "new": v, "owner": self, "type": "change"}
            for handler, names in list(self._observers):
                if names is None or "value" in names:
                    handler(change)

    def observe(self, handler, names=None, type="change"):
        """Call handler(change) when the value changes; change is a dict
        with "name", "old", "new", "owner" and "type", as in ipywidgets."""
        self._observers.append((handler, [names] if isinstance(names, str) else names))

    def unobserve(self, handler, names=None, type="change"):
        self._observers = [(h, n) for h, n in self._observers if h is not handler]

    def _ipython_display_(self):
        _show([self])

    def __repr__(self):
        return "%s(value=%r, description=%r)" % (type(self).__name__, self.value, self.description)


def _leaves(widgets):
    out = []
    for w in widgets:
        if isinstance(w, Box):
            out += _leaves(w.children)
        elif isinstance(w, _Widget) and not isinstance(w, Output):
            out.append(w)
    return out


def _show(widgets):
    """Draw these widgets as one group of controls (an interact whose
    function sets their values)."""
    widgets = list(dict.fromkeys(_leaves(widgets)))
    names, controls = [], {}
    for i, w in enumerate(widgets):
        c = w._control()
        if c.label is None:
            c.label = w.description or ""
        names.append(("_w%d" % i, w, c))
        controls["_w%d" % i] = c
    linked = []
    for w in widgets:
        for o in w._linked:
            if o not in linked:
                linked.append(o)
    first = [True]

    def widgets_changed(**values):
        for name, w, c in names:
            if name not in values:
                continue
            if isinstance(w, Button):
                if values[name] > w._value:
                    w._value = values[name]
                    for handler in list(w._clicks):
                        handler(w)
            else:
                w.value = values[name]
        if first[0]:
            first[0] = False
            for o in linked:
                o._run()

    _interact.interact(widgets_changed, **controls)


class IntSlider(_Widget):
    def __init__(self, value=0, min=0, max=100, step=1, description="", **kw):
        # (as ipywidgets: max is at least min, and the value is clipped to them)
        max = max if max >= min else min
        super().__init__(value if min <= value <= max else min if value < min else max, description)
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


HTML = HTMLMath = Label
Textarea = Text
BoundedIntText = IntText
BoundedFloatText = FloatText


class Button(_Widget):
    """A button: on_click(f) calls f(button) on each click."""

    def __init__(self, description="", **kw):
        super().__init__(0, description, **kw)
        self._clicks = []

    def on_click(self, f, remove=False):
        if remove:
            self._clicks = [g for g in self._clicks if g is not f]
        else:
            self._clicks.append(f)

    def _control(self):
        return _interact.button(self.description or "Button")

    def __repr__(self):
        return "Button(description=%r)" % self.description


class Box(_Widget):
    """VBox, HBox: widgets drawn together (one group of controls)."""

    def __init__(self, children=(), **kw):
        super().__init__(None, "", **kw)
        self.children = tuple(children)

    def __repr__(self):
        return "%s(children=%r)" % (type(self).__name__, self.children)


VBox = HBox = GridBox = Box


class Output(_Widget):
    """Where interactive_output's function prints: under the controls of its
    widgets, when they are displayed (`with out:` and display(out) are
    accepted and change nothing)."""

    def __init__(self, **kw):
        super().__init__(None, "", **kw)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def clear_output(self, wait=False):
        import builtins
        builtins.__pyjs_host__("clear_output")

    def _ipython_display_(self):
        pass

    def __repr__(self):
        return "Output()"


class _Linked:
    def __init__(self, f, controls):
        self.f, self.controls = f, controls

    def _run(self):
        try:
            self.f(**{name: w.value for name, w in self.controls.items()})
        except Exception as err:
            import traceback
            traceback.print_exception(err)


def interactive_output(f, controls):
    """Rerun f(**{name: widget.value}) when one of the widgets changes; its
    output appears under the widgets' controls (and once when they are
    displayed)."""
    link = _Linked(f, dict(controls))
    for w in controls.values():
        w._linked.append(link)
        w.observe(lambda change: link._run(), "value")
    return Output()


class Layout:
    def __init__(self, **kw):
        self.__dict__.update(kw)
