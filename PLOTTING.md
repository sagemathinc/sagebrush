# Plotting and interaction

Sagebrush draws 2D graphics with its own small renderer (`lib/_graphics.py`,
pure Python): no matplotlib, no Plotly, no browser needed to make a file.
Two APIs sit on top of it, and `@interact` makes either of them live.

## Why SVG, and why our own renderer

The design goals were set by what agents (and screen readers) need:

- **Readable as text.** Every plot is an SVG whose `aria-label`/`<title>`
  describes it in words, e.g. `Plot: "Trig"; line "sin" through 201 points,
  line "cos" through 201 points; x (t) from -0.5 to 10.5, y from -1.1 to
  1.1`. `g.description()` returns it.
- **Visible as a picture.** In the browser, the WebMCP tools return each plot
  as a PNG next to that description.
- **Deterministic.** The same code gives byte-identical SVG (sampling is not
  randomized), so plots can be diffed and tested.
- **Files without a browser.** `save('plot.svg')` works on the command line,
  in Node, Deno and Bun; `show()` there writes an SVG file and prints its path
  and description. (sagejs needed Chromium via Playwright for static images.)
- **Small and fast.** The renderer plus both APIs add about 0.1 MB to the
  browser worker, and an `@interact` update (rerun the function, resample,
  render) typically takes 10–30 ms, so dragging a slider feels immediate.
- **Theme-aware.** Axes and text use `currentColor`, so plots follow the
  page's light or dark theme; saved files render them black.

In the notebook (sagebrush.space), plots show the data coordinates under the
mouse, with a crosshair.

## Sage's API (Sage mode)

```python
plot(sin(x^2), (x, 0, 2*pi), color='red', legend_label='sin(x^2)', title='A plot')
g = plot(x^3 - 3*x, (x, -2.2, 2.2)) + point([(-1, 2), (1, -2)], size=60, color='red')
g.show(gridlines=True, figsize=(7, 3)); g.save('cubic.svg')
```

- `plot(f, (x, a, b))`: an expression in `x`, a Python callable, or a list
  of them. It uses Sage's sampling: 200 points, then recursive refinement
  where the curve bends. Options include `fill='axis'` (or a value or another
  function), `color`, `thickness`, `linestyle`, `alpha` and `legend_label`.
- `parametric_plot`, `polar_plot`, `list_plot` (`plotjoined=True`), `line`,
  `point`/`points`, `text`, `polygon`, `circle`, `disk` (sectors), `arrow`,
  `bar_chart` and `graphics_array`.
- `Graphics` objects add with `+` and keep their primitives (`g[0].xs`).
  Picture options: `title`, `axes_labels`, `xmin/xmax/ymin/ymax`,
  `aspect_ratio`, `gridlines`, `frame`, `axes`, `figsize`,
  `scale='loglog'|'semilogx'|'semilogy'`, `ticks`, `legend_loc` and
  `show_legend`.
- Expressions come from Sagebrush's own symbolic engine (Rust,
  `engine/sym`): `var('y z')`, `x`, `pi`, `e`, `sin`, `exp`, `sqrt` and the
  rest build expressions that print like Sage (`sin(x^2)/x`), simplify,
  differentiate, expand in series, and solve. For plotting, an expression
  compiles once to a fast numerical function.

### Functions of two variables (2D)

```python
contour_plot(x^2 - y^2, (x, -2, 2), (y, -2, 2))                  # filled, gray (Sage's default)
contour_plot(sin(x)*cos(y), (x, -3, 3), (y, -3, 3), cmap='coolwarm', contours=10)
density_plot(sin(x*y), (x, -3, 3), (y, -3, 3), cmap='viridis')
implicit_plot(y^2 == x^3 - x, (x, -2, 2), (y, -2, 2))
region_plot([x^2 + y^2 < 1, y > x], (x, -1.5, 1.5), (y, -1.5, 1.5))
plot_vector_field((-y, x), (x, -2, 2), (y, -2, 2))
plot_slope_field(x - y, (x, -3, 3), (y, -3, 3))                  # for y' = x - y
```

- The grid is sampled once. Contours come from linear interpolation on
  triangles (each grid cell split in two), so filled bands and their lines
  agree exactly.
- Each superlevel set $\{f \ge c\}$ is one SVG path of rings, painted in
  order. Contour plots stay at tens of kilobytes rather than one polygon
  per cell.
- Options: `plot_points`, `contours` (a count or a list of levels),
  `fill`, `cmap` (viridis, gray, coolwarm, jet, hot, rainbow, plasma, Blues,
  Spectral and RdBu, plus `_r` for reversed), `incol`/`outcol`, `color`.
- The plot area takes the shape of the ranges (`aspect_ratio=1`), framed,
  as in Sage.

## 3D graphics

```python
plot3d(sin(x*y), (x, -3, 3), (y, -3, 3))
plot3d(x^2 - y^2, (x, -2, 2), (y, -2, 2), cmap='viridis', mesh=True)
parametric_plot3d((cos(t), sin(t), t/5), (t, 0, 6*pi), color='green')           # a curve
parametric_plot3d((u*cos(v), u*sin(v), u), (u, 0, 1), (v, 0, 2*pi))              # a surface
implicit_plot3d(x^2 + y^2 + z^2 == 4, (x, -2, 2), (y, -2, 2), (z, -2, 2), color='red')
sphere((0, 0, 1), 0.5, color='orange', opacity=0.6) + point3d((1, 1, 1)) + line3d([(0, 0, 0), (1, 1, 1)])
```

Also available: `spherical_plot3d`, `cylindrical_plot3d`,
`revolution_plot3d`, `arrow3d`, `text3d`, `polygon3d` and
`plot_vector_field3d`. Graphics3d objects add with `+`.

A Graphics3d shows two ways at once:

- **Interactive view (notebook, Jupyter, saved `.html`).** Our own WebGL 1
  viewer (`web/viewer3d.js`, about 19 kB, no libraries). It uses smooth
  shading and thick curves drawn as tubes. Drag to rotate, scroll (once the
  view has focus) or pinch to zoom, use the arrow keys and +/- to turn and
  zoom, and double-click or press 0 to reset. Labels follow the page's light
  or dark theme. The notebook loads the viewer on first use. Jupyter gets
  HTML with the viewer embedded, and the SVG still inside it for when
  scripts don't run.
- **SVG (files, the command line, agents, and when WebGL is missing).**
  - It is deterministic: an orthographic view (azimuth −60°, elevation 25°,
    or `azimuth=`/`elevation=`), flat shading, and depth-sorted polygons
    (the painter's algorithm).
  - It has a text description, e.g. `3D plot: surface z = sin(x*y) of 1600
    polygons; x from -3 to 3; ...`.
  - Meshes with more than 4000 polygons are simplified by vertex clustering
    for the picture only.

`save('f.svg')` or `save('f.html')` (standalone and interactive).
Proportions are true unless an axis would be shorter than a third of the
longest (`aspect_ratio=[1, 1, 1]` forces true proportions).
`plot_points`, `color`, `opacity`, `mesh`, `cmap`, `frame` and
`axes_labels` work as in Sage.

## matplotlib.pyplot (any mode)

```python
import matplotlib.pyplot as plt
fig, (a, b) = plt.subplots(1, 2, figsize=(9, 3.5))
a.hist(data, bins=40, edgecolor='white'); b.scatter(xs, ys, c=zs, s=18)
plt.show()        # or nothing: in the notebook, a cell's figures show when it ends
```

Supported:

- `figure`, `subplots` (axes arrays index like numpy: `axs[1, 0]`),
  `subplot`.
- `plot` with format strings (`'r--o'`, `'C2'`), `scatter` (with colormaps),
  `bar`/`barh` (categorical labels), `hist` (`density`, `cumulative`,
  `histtype='step'`), `fill_between`, `errorbar`, `step`, `stem`, `pie`,
  `imshow` (viridis/gray), `axhline`/`axvline`, `text` and `annotate`.
- Titles, labels, limits, `xscale`/`yscale('log')`, ticks and tick labels,
  `grid`, `legend` (`loc`), `axis('equal'|'off')` and `suptitle`.
- `savefig('f.svg')`, and SVG only for now.

Pass numpy arrays or lists; numpy is built in (see [NUMPY.md](NUMPY.md)).

## Animation

Three ways, all cheap because each frame takes milliseconds to compute:

- **Sage `animate`.** It takes a list of Graphics, drawn on common axes:

  ```python
  a = animate([plot(sin(x - k), (x, 0, 4*pi)) for k in srange(0, 2*pi, 0.2)])
  a.show(delay=5)       # hundredths of a second per frame, as in Sage
  a.save('wave.svg')
  ```

  `a + b` combines two animations frame by frame, and `a * b` plays one
  after the other.
- **`matplotlib.animation`.** `FuncAnimation(fig, update, frames, interval)`
  works the way it does in matplotlib: `line.set_data(...)`,
  `ax.set_title(...)`, or `ax.clear()` and redraw. Limits you did not set are
  frozen from the first frame, as in matplotlib. `ArtistAnimation(fig,
  [[artists], ...])` is supported too.
  - The animation appears as the value of `ani`, or with `plt.show()`, or with
    `HTML(ani.to_jshtml())`.
  - `ani.save('a.svg')` and `ani.save('a.html')` work. GIF and video writers
    are not available.
- **`@interact`'s ▶ button.** Every slider has one: it steps the slider
  through its values and reruns the function live for each step, at up to
  30 frames a second. Nothing is precomputed, so this is the analogue of
  ipywidgets' `Play` widget linked to a slider.

The output of the first two is one **animated SVG**. It holds every frame
and plays by itself in any web browser through CSS, so a saved `.svg` file
is a portable animation and no GIF encoder is needed. In the notebook it
gets a player: play/pause, a frame slider and speed. It starts paused when
the reader prefers reduced motion. Agents get the first, middle and last
frames as PNG images.

## Display protocol

Objects show through Jupyter's protocol: `_repr_svg_`, `_repr_png_`,
`_repr_html_`, ..., `_repr_mimebundle_`. Use `IPython.display`'s `display`,
`SVG`, `Image`, `HTML`, `Markdown` and `Latex`. The notebook renders SVG
(sanitized) and PNG/JPEG, and shows the text form of the rest; the command
line saves SVG to a file.

## @interact

```python
@interact                                   # Sage mode
def rose(n=slider(1, 12, 1, 5), color=selector(['blue', 'green']), filled=False):
    show(polar_plot(cos(n*x), (x, 0, 2*pi), color=color))

from ipywidgets import interact             # Python mode
@interact(k=(0.0, 1.0), w=(1, 10))
def damped(k=0.2, w=4): ...
```

The two follow their own rules for abbreviations:

- **Sage:** a bool is a checkbox, `(a, b[, step])` a slider, a list a
  selector (buttons when short), a range a slider over its values, and
  anything else an input box. Controls: `slider` (also over a list of
  values), `range_slider`, `selector`, `checkbox`, `input_box`,
  `color_selector` and `text_control`.
- **ipywidgets:** a number `v` is a slider over `[-v, 3v]`, and a list is a
  Dropdown. Controls: `IntSlider`, `FloatSlider`, `IntRangeSlider`,
  `Dropdown`, `RadioButtons`, `ToggleButtons`, `Checkbox`, `Text`,
  `IntText`, `FloatText`, `ColorPicker` and `fixed`.

How updates work:

- A function's return value is displayed, and pyplot figures it makes are
  shown.
- Each change reruns the function. Only one update is in flight at a time,
  always with the latest values, and the new output replaces the old in one
  step.
- Without a notebook (the command line), the function runs once with its
  defaults, as in Sage's text mode.

Agents in the browser can drive interacts: `read_notebook` lists them with
their ids and values, and `set_interact` changes values and returns the new
output and pictures.

This is a native, light implementation of the controls. Full ipywidgets
(Output, layouts, `observe`, `jslink`) would run the real traitlets/ipywidgets
Python over the Jupyter comm protocol, rendered by `@cocalc/widgets`, as
sagejs does. That layer would load on demand.

## Not yet

- Zooming by resampling.
- LaTeX labels (KaTeX).
- PNG files from the command line (resvg).
- Colorbars, contour labels (`labels=True`), streamlines.
