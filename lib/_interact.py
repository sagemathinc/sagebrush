"""Sage's @interact: controls for a function's arguments, re-running it
on every change.

    @interact
    def f(n=slider(1, 20, 1, 5), color=selector(['red', 'blue']), grid=True):
        show(plot(sin(n*x), (x, 0, 2*pi), color=color, gridlines=grid))

Controls are inferred from defaults as in Sage: a bool is a checkbox, (a, b)
or (a, b, step) a slider, a list a selector, a range a slider over its
values, anything else an input box.  A host that can show controls (the
browser notebook) implements __pyjs_host__("interact", spec): it draws them,
and sends each change back through _update().  Without such a host the
function simply runs once with the defaults, as in Sage's text mode.
"""

import builtins
import json

_interacts = {}
_next = [0]


class Control:
    kind = "input"

    def __init__(self, default=None, label=None):
        self.default, self.label = default, label

    def spec(self):
        return {"kind": self.kind, "value": self.default}

    def convert(self, v):
        return v


class slider(Control):
    """slider(vmin, vmax, step_size=None, default=None, label=None) or slider(list_of_values)."""
    kind = "slider"

    def __init__(self, vmin, vmax=None, step_size=None, default=None, label=None, display_value=True):
        super().__init__(default, label)
        if vmax is None:  # a list of values
            self.values = list(vmin)
            self.default = self.values.index(default) if default in self.values else 0
            return
        self.values = None
        self.vmin, self.vmax = vmin, vmax
        ints = all(isinstance(v, int) for v in (vmin, vmax)) and (step_size is None or isinstance(step_size, int))
        self.step = step_size if step_size is not None else (1 if ints else (float(vmax) - float(vmin)) / 100)
        self.ints = ints
        self.default = vmin if default is None else default

    def spec(self):
        if self.values is not None:
            return {"kind": "slider", "min": 0, "max": len(self.values) - 1, "step": 1, "value": self.default,
                    "labels": [_label(v) for v in self.values]}
        return {"kind": "slider", "min": float(self.vmin), "max": float(self.vmax), "step": float(self.step),
                "value": float(self.default), "ints": self.ints}

    def convert(self, v):
        if self.values is not None:
            return self.values[int(v)]
        if self.ints:
            return int(round(float(v)))
        return float(v)


class range_slider(slider):
    """range_slider(vmin, vmax, step_size, default=(a, b)): two values."""
    kind = "range"

    def __init__(self, vmin, vmax, step_size=None, default=None, label=None):
        super().__init__(vmin, vmax, step_size, None, label)
        self.default = tuple(default) if default is not None else (vmin, vmax)

    def spec(self):
        s = super().spec()
        s["kind"] = "range"
        s["value"] = [float(v) for v in self.default]
        return s

    def convert(self, v):
        conv = (lambda t: int(round(float(t)))) if self.ints else float
        return (conv(v[0]), conv(v[1]))


class selector(Control):
    """selector(values, label=None, default=None, buttons=False)"""
    kind = "selector"

    def __init__(self, values, label=None, default=None, buttons=False, nrows=None, ncols=None, width=None):
        self.values = list(values)
        super().__init__(self.values.index(default) if default in self.values else 0, label)
        self.buttons = buttons

    def spec(self):
        labels = getattr(self, "spec_labels", None) or [_label(v) for v in self.values]
        return {"kind": "selector", "options": labels, "value": self.default,
                "buttons": bool(self.buttons) if self.buttons is not None else len(self.values) <= 4}

    def convert(self, v):
        return self.values[int(v)]


class checkbox(Control):
    kind = "checkbox"

    def __init__(self, default=True, label=None):
        super().__init__(bool(default), label)

    def convert(self, v):
        return bool(v)


class input_box(Control):
    """input_box(default, label=None, type=None): the text is converted to
    `type`, or to the default's type (numbers are evaluated as Python)."""
    kind = "input"

    def __init__(self, default=None, label=None, type=None, width=None, height=1):
        super().__init__(default, label)
        self.type = type

    def spec(self):
        return {"kind": "input", "value": "" if self.default is None else str(self.default)}

    def convert(self, v):
        if self.type is not None:
            return self.type(v)
        if isinstance(self.default, str):
            return v
        if v.strip() == "":
            return None
        import sys
        main = sys.modules.get("__main__")
        return eval(v, dict(main.__dict__) if main is not None and hasattr(main, "__dict__") else {})


class color_selector(Control):
    kind = "color"

    def __init__(self, default="#1f77b4", label=None, widget=None, hide_box=False):
        from _graphics import to_color
        c = to_color(default)
        super().__init__(c if c.startswith("#") and len(c) == 7 else "#1f77b4", label)


class text_control(Control):
    """Static text among the controls."""
    kind = "text"

    def __init__(self, value=""):
        super().__init__(str(value), None)


def _label(v):
    return v if isinstance(v, str) else repr(v)


def _control(name, default, initial=None):
    """Sage's abbreviations; `initial` is the parameter's own default when a
    control was given separately (interact(f, n=(0, 10)) with def f(n=3))."""
    c = _abbreviate(default)
    if initial is not None and isinstance(c, slider) and c.values is None:
        c.default = initial
    elif initial is not None and isinstance(c, selector) and initial in c.values:
        c.default = c.values.index(initial)
    return c


def _abbreviate(default):
    if isinstance(default, (Control, fixed)):
        return default
    if isinstance(default, bool):
        return checkbox(default)
    if isinstance(default, tuple) and len(default) in (2, 3) and all(isinstance(v, (int, float)) for v in default):
        a, b = default[0], default[1]
        step = default[2] if len(default) == 3 else None
        ints = all(isinstance(v, int) for v in default)
        mid = (a + b) // 2 if ints else (a + b) / 2
        if step is not None and not ints:
            mid = a + round((mid - a) / step) * step
        return slider(a, b, step, mid)
    if isinstance(default, range):
        vals = list(default)
        return slider(vals, default=vals[len(vals) // 2] if vals else None)
    if isinstance(default, list):
        return selector(default, buttons=None)  # buttons when there are few options
    return input_box(default)


def _signature_defaults(f):
    code = getattr(f, "__code__", None)
    defaults = getattr(f, "__defaults__", None) or ()
    names = list(code.co_varnames[:code.co_argcount]) if code is not None else []
    out = {}
    for name, d in zip(names[len(names) - len(defaults):], defaults):
        out[name] = d
    kw = getattr(f, "__kwdefaults__", None) or {}
    out.update(kw)
    return names, out


class _Interact:
    def __init__(self, f, controls):
        self.f, self.controls = f, controls

    def run(self, values):
        kwargs = {name: c.convert(values[name]) if name in values else c.convert(c.spec()["value"])
                  for name, c in self.controls.items() if c.kind != "text" or isinstance(c, fixed)}
        try:
            result = self.f(**kwargs)
            if result is not None:  # as ipywidgets' interact: show what it returns
                builtins.__pyjs_display__(result)
            import sys
            pyplot = sys.modules.get("matplotlib.pyplot")
            if pyplot is not None:
                pyplot._flush_figures()
        except Exception as err:
            import traceback
            traceback.print_exception(err)


class fixed:
    """A value passed to the function as is, without a control."""
    kind = "fixed"

    def __init__(self, value):
        self.value = value

    def spec(self):
        return {"kind": "text", "value": ""}

    def convert(self, v):
        return self.value


def interact(f=None, layout=None, _abbrev=None, **controls):
    """Decorator: @interact or @interact(n=(0, 10)) or interact(f, n=(0, 10))."""
    if f is None:
        return lambda g: interact(g, layout=layout, _abbrev=_abbrev, **controls)
    make = _abbrev or _control
    names, defaults = _signature_defaults(f)
    ctrls = {}
    for name in names:
        if name in controls:
            ctrls[name] = make(name, controls[name], defaults.get(name))
        elif name in defaults:
            ctrls[name] = make(name, defaults[name], None)
    for name, d in list(defaults.items()) + list(controls.items()):
        if name not in ctrls:
            ctrls[name] = make(name, d, None)
    _next[0] += 1
    iid = _next[0]
    it = _Interact(f, ctrls)
    _interacts[iid] = it
    spec = {"id": iid, "name": getattr(f, "__name__", "f"), "controls": []}
    for name, c in ctrls.items():
        if isinstance(c, fixed):
            continue
        s = c.spec()
        s["name"] = name
        s["label"] = c.label if c.label is not None else name
        spec["controls"].append(s)
    if builtins.__pyjs_host__("interact", json.dumps(spec)):
        builtins.__pyjs_host__("target", iid)
        try:
            it.run({})
        finally:
            builtins.__pyjs_host__("target", None)
    else:
        it.run({})
    return f


def _update(iid, values_json):
    """Called by the host when a control changes."""
    it = _interacts.get(iid)
    if it is None:
        print("This interact is gone (the interpreter restarted): run its cell again.")
        return
    builtins.__pyjs_host__("target", iid)
    try:
        it.run(json.loads(values_json))
    finally:
        builtins.__pyjs_host__("target", None)
