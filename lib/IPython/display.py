"""IPython.display: show objects through Jupyter's display protocol.

display(obj) shows obj richly when the host can (its _repr_svg_,
_repr_png_, ... ; the sagebrush notebook renders SVG and PNG, and shows the
text form of the rest), otherwise prints its repr.
"""
import builtins


def display(*objs, **kw):
    for obj in objs:
        builtins.__pyjs_display__(obj)


def clear_output(wait=False):
    builtins.__pyjs_host__("clear_output")


class DisplayObject:
    def __init__(self, data=None, url=None, filename=None, metadata=None):
        if filename is not None:
            with open(filename, "rb" if self._binary else "r") as f:
                data = f.read()
        self.data = data

    _binary = False

    def __repr__(self):
        return "<IPython.core.display.%s object>" % type(self).__name__


class SVG(DisplayObject):
    def _repr_svg_(self):
        d = self.data
        return d.decode() if isinstance(d, bytes) else d


class HTML(DisplayObject):
    def _repr_mimebundle_(self, include=None, exclude=None):
        svg = getattr(self.data, "_sagebrush_svg", None)  # HTML(anim.to_jshtml())
        if svg is not None:
            return {"image/svg+xml": svg}
        return {"text/html": self.data}


class Markdown(DisplayObject):
    def _repr_markdown_(self):
        return self.data


class Latex(DisplayObject):
    def _repr_latex_(self):
        return self.data


class Math(DisplayObject):
    def _repr_latex_(self):
        return "$\\displaystyle %s$" % self.data


class JSON(DisplayObject):
    def _repr_json_(self):
        import json
        return json.dumps(self.data)


class Image(DisplayObject):
    _binary = True

    def __init__(self, data=None, url=None, filename=None, format=None, **kw):
        super().__init__(data, url, filename)
        self.format = format or (filename.rsplit(".", 1)[-1].lower() if filename else "png")

    def _repr_png_(self):
        return self.data if self.format == "png" else None

    def _repr_jpeg_(self):
        return self.data if self.format in ("jpg", "jpeg") else None


class Pretty(DisplayObject):
    def __repr__(self):
        return str(self.data)
