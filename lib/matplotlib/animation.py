"""matplotlib.animation for sagebrush: FuncAnimation and ArtistAnimation,
rendered as an animated SVG (it plays by itself in a browser; the notebook
adds a player).

    fig, ax = plt.subplots()
    line, = ax.plot([], [])
    ax.set_xlim(0, 2 * math.pi); ax.set_ylim(-1, 1)
    def update(k):
        line.set_data(xs, [math.sin(x + k / 10) for x in xs])
        return line,
    ani = FuncAnimation(fig, update, frames=60, interval=50)
    ani            # or plt.show(), or HTML(ani.to_jshtml()); ani.save('wave.svg')
"""

from _graphics import render_animation, describe_svg, save_svg, show as _show


class Animation:
    def __init__(self, fig, interval=200, repeat=True, repeat_delay=0, **kw):
        self._fig = fig
        self._interval = float(interval)
        self._repeat = repeat
        self._svg_cache = None
        self._displayed = False
        fig._animation = self

    def _frames(self):  # [(body, description), ...]
        raise NotImplementedError

    def _repr_svg_(self):
        self._displayed = True
        if self._svg_cache is None:
            f = self._fig
            self._svg_cache = render_animation(self._frames(), f._size[0] * 100, f._size[1] * 100,
                                               self._interval, 0 if self._repeat else 1)
        return self._svg_cache

    def __repr__(self):
        return "<matplotlib.animation.%s object at 0x%x>" % (type(self).__name__, id(self) & 0xffffffffffff)

    def description(self):
        return describe_svg(self._repr_svg_())

    def save(self, filename, writer=None, fps=None, dpi=None, **kw):
        """Save as an animated .svg, or an .html page that plays it."""
        if fps:
            self._interval = 1000.0 / fps
            self._svg_cache = None
        name = str(filename)
        low = name.lower()
        if low.endswith(".html") or low.endswith(".htm"):
            with open(name, "w") as f:
                f.write("<!doctype html><meta charset=utf-8><title>Animation</title>" + self._repr_svg_())
            return
        if not low.endswith(".svg"):
            raise ValueError("animations save as .svg (an animated SVG that plays in a web browser) or .html; GIF and video writers are not available")
        save_svg(self._repr_svg_(), name)

    def to_jshtml(self, fps=None, embed_frames=True, default_mode=None):
        """For HTML(ani.to_jshtml()) in a notebook: displays the animation."""
        return _AnimationHTML(self)

    to_html5_video = to_jshtml

    def pause(self):
        pass

    def resume(self):
        pass


class _AnimationHTML(str):
    def __new__(cls, anim):
        s = str.__new__(cls, anim._repr_svg_())
        s._sagebrush_svg = anim._repr_svg_()
        return s


def _freeze_limits(fig):
    """Fix each axes' limits as they are now (matplotlib does not rescale
    the axes while it animates); returns what to restore."""
    saved = []
    for ax in fig.axes:
        old = {k: ax._opts.get(k) for k in ("xmin", "xmax", "ymin", "ymax")}
        saved.append((ax, old))
        if None in old.values():
            (x0, x1), (y0, y1) = ax.get_xlim(), ax.get_ylim()
            for k, v in (("xmin", x0), ("xmax", x1), ("ymin", y0), ("ymax", y1)):
                if ax._opts.get(k) is None:
                    ax._opts[k] = v
    return saved


class FuncAnimation(Animation):
    def __init__(self, fig, func, frames=None, init_func=None, fargs=None, save_count=None,
                 interval=200, repeat=True, blit=False, cache_frame_data=True, **kw):
        super().__init__(fig, interval, repeat)
        self._func, self._init = func, init_func
        self._fargs = tuple(fargs or ())
        if frames is None:
            frames = range(save_count or 100)
        elif isinstance(frames, int):
            frames = range(frames)
        self._frame_seq = frames

    def _frames(self):
        if self._init is not None:
            self._init()
        seq = self._frame_seq() if callable(self._frame_seq) else self._frame_seq
        out = []
        saved = None
        for k, frame in enumerate(seq):
            if k >= 1000:
                break
            self._func(frame, *self._fargs)
            if saved is None:
                saved = _freeze_limits(self._fig)
            out.append(self._fig._frame())
        for ax, old in saved or []:
            for key, v in old.items():
                if v is None:
                    ax._opts.pop(key, None)
        return out


class ArtistAnimation(Animation):
    """Each frame shows its own artists (and every artist not in any frame)."""

    def __init__(self, fig, artists, interval=200, repeat_delay=0, repeat=True, blit=False, **kw):
        super().__init__(fig, interval, repeat)
        self._artists = [list(a) if isinstance(a, (list, tuple)) else [a] for a in artists]

    def _frames(self):
        groups = [[getattr(a, "_prim", None) for a in frame] for frame in self._artists]
        animated = {id(p) for g in groups for p in g if p is not None}
        prims = [p for ax in self._fig.axes for p in ax._prims if id(p) in animated]
        before = {id(p): p.options.get("hidden") for p in prims}
        out = []
        saved = None
        for g in groups:
            shown = {id(p) for p in g if p is not None}
            for p in prims:
                p.options["hidden"] = id(p) not in shown
            if saved is None:  # limits that fit every frame
                for p in prims:
                    p.options["hidden"] = False
                saved = _freeze_limits(self._fig)
                for p in prims:
                    p.options["hidden"] = id(p) not in shown
            out.append(self._fig._frame())
        for p in prims:
            p.options["hidden"] = before[id(p)]
        for ax, old in saved or []:
            for key, v in old.items():
                if v is None:
                    ax._opts.pop(key, None)
        return out


class PillowWriter:
    def __init__(self, *a, **k):
        raise ValueError("GIF writers are not available: save animations as .svg")


FFMpegWriter = ImageMagickWriter = PillowWriter
