# MATLAB

*October 13, 2026.* Sagebrush runs MATLAB programs: `sagebrush --matlab
file.m`. Cambridge University Press, whose journals publish code with
papers, asked for MATLAB language support. As with Magma (src/magma.ts),
the MATLAB source is translated to Python, which the usual pipeline compiles
and runs on a runtime library with MATLAB's semantics:

- **src/matlab.ts** parses MATLAB into a syntax tree and emits Python.
- **lib/_matlab.py** holds MATLAB's values, operators, indexing, display and
  built-in functions, over Sagebrush's numpy.
- **lib/_matlab_files.py** loads function files (`name.m` in the program's
  folder).
- More built-ins, registered in the same table:
  - **lib/_matlab_numeric.py**: special matrices, matrix functions,
    polynomials and interpolation, numgrid and delsq (numgrid's 'S' and
    'L' only: the other regions are described only in words, which do not
    fix their shapes on the grid, so they are refused);
  - **lib/_matlab_data.py**: data analysis and signals (filter, conv2,
    gradient, del2, detrend, cov, corrcoef, prctile, quantile and the
    moving statistics);
  - **lib/_matlab_eigs.py**: eigs, a direct (thick) Ritz-vector
    restarted Arnoldi method, the Lanczos form for a Hermitian operator,
    with the interface of its documentation page. The Arnoldi extension and
    the Ritz estimate follow Lehoucq and Sorensen (Rice CAAM TR94-13,
    sections 2-3); the restart is Sagebrush's own, which retains, under the
    stated hypotheses, the wanted range their exact-shift restart retains
    (no locking or deflation is claimed). Also Sagebrush's own: the
    convergence test (each wanted Ritz estimate, and its actual residual,
    at most Tolerance times max(|theta|, eps ||H||), or at rounding level),
    the start vector from a fixed stream of its own, a dense solution when
    the subspace would be the whole space (Cholesky-reduced for a symmetric
    A with a symmetric positive definite B), single precision computed in
    double, the order for a numeric sigma (nearest first), which the page
    leaves open, IsSymmetricDefinite required for a sparse B of more than
    2000 rows, and the messages;
  - lib/_matlab_sparse.py, lib/_matlab_mat.py and lib/_matlab_plot.py
    (below).

## The translator

**Lexing.** MATLAB's syntax depends on context, and the lexer handles these
cases:

- A quote is a transpose right after a value (`a'`, `x(1)'`). Otherwise it
  starts a character vector. Inside brackets, a quote after a space starts
  one (`[a 'b']`).
- Inside `[ ]` and `{ }`, whitespace separates elements. `[1 -2]` is two
  elements and `[1 - 2]` is one, as are `[a' b']` and `[f (1)]` versus
  `[f(1)]`. A newline there separates rows.
- `...` continues a line. `%` starts a comment. `%{ ... %}` on lines of
  their own is a block comment, and block comments nest.
- **Command syntax:** `format long`, `hold on` and `disp hello` are calls
  with character-vector arguments. A statement is a command when its first
  word is followed by a space and a letter, digit or quote: a variable could
  never be followed by those. A `-` counts too for a few command names
  (`save f -ascii`).
- Octave's `endif`, `endfor`, `!=` and `#` comments are accepted.

**Name resolution** is static where MATLAB's is.

- **In a function,** a name assigned earlier in the text, or anywhere in an
  enclosing loop, is a variable. Any other name is a function, found when
  the call runs: in the workspace, then among the built-ins, then as
  `name.m` on the path.
- **At the top level** (a script or a notebook cell), the workspace may
  already hold a variable the code never assigns. Such a name is looked up
  when it runs: `(x if "x" in globals() else _m.fn("x"))`.
- **A function named without arguments is called,** as MATLAB does
  (`rand`, `pi`). A handle is a value.
- **A global variable** is one value shared by every workspace that
  declares it (`_m.global_get`, `_m.global_set`). Each use reads it from
  that registry at that point, since any call, even earlier in the same
  expression, may have changed it; an anonymous function keeps the value
  it had when the function was made. An indexed, field or cell assignment
  evaluates its index and value first, then starts from the registry's
  value at that point; each assignment writes it back.

**Calls** pass `nargout`, as MATLAB does: the number of outputs the caller
wants. It is 0 for a statement, 1 in an expression, and n in
`[a, b] = f(...)`. An expression statement assigns `ans` when a value comes
back. `c{:}` and `s.f` in an argument or element list expand into their
values (comma-separated lists).

**Assignment** through a path (`s.a(2).b{3} = v`) rebuilds the path from
the outside in (`_m.assign`), growing arrays as MATLAB does. `x(i) = v` and
`x(i, j) = v` have direct fast paths (`_m.set1`, `_m.set2`). `end` in a
subscript is the size of what that subscript indexes: the part of the path
built so far.

**Functions** become `def f(_nargout, *_a)`:

- every local starts as an `Undef` that knows its name, so a missing output
  is reported by name;
- `varargin` and `varargout` are cells, and `nargin` and `nargout` are
  numbers;
- local functions anywhere in the file are defined before the script's
  statements run.

**Anonymous functions** capture copies of the variables they use when they
are made (`@(x) x + a`), as MATLAB does. They print as MATLAB writes them
back (`@(x)x+a`).

**Newer syntax:**
- `f(x, Name=value)` (R2021a) is `f(x, "Name", value)`.
- `0x87u32` and `0b1011` (R2019b) are integers. Without a suffix, a literal
  is the smallest unsigned type that holds it.
- **`arguments` blocks** declare a function's arguments, and their checks
  run in order when it is called:
  - a default makes an argument optional, and is used when it is missing;
  - the declared class and size convert the value where they can (a char
    vector to a string, a column to a `(1,:)` row, a scalar expanded),
    and are an error otherwise;
  - the validation functions (`mustBeNumeric` and friends, with MATLAB's
    messages) run left to right;
  - name-value arguments (`opts.Name`) become a struct of the trailing
    name/value pairs, names matched case-insensitively;
  - `Output` blocks are ignored, and `Repeating` blocks are not supported.

**Errors** stop the program (unlike Magma, MATLAB does not go on to the next
statement). They are reported on stderr as MATLAB reports them: the message,
then `Error in name (line n)` for each function and for the script. The
emitted code keeps the current line in a local `_L`, since pyjs's tracebacks
carry no line numbers. `try`/`catch err` catches MATLAB errors and Python
ones, but not `KeyboardInterrupt` (Ctrl-C) or `SystemExit`.

## Values

- **Scalars:** a real double scalar is a Python `float`, a logical scalar a
  `bool`, and a complex scalar a `complex`. Loops over scalars then run at
  Python speed: each operator checks for two floats first.
- **Arrays:** every other numeric or logical array is a numpy ndarray stored
  with its axes reversed. MATLAB's m-by-n array has shape (n, m).
  - Numpy's C order is then MATLAB's column-major order, so linear indexing
    and `reshape` need no permutation.
  - Numpy's broadcasting, which aligns trailing axes, becomes MATLAB's
    implicit expansion, which aligns leading dimensions.
  - Arrays always have at least two axes, and no leading axis of length 1
    beyond those two, since MATLAB drops trailing singleton dimensions.
- **The transpose is taken at every boundary** where an array leaves MATLAB's
  semantics, and tests pin each one:
  - **display:** test_matlab_display (non-symmetric matrices), and
    `num2str`, `mat2str` and `sprintf` of a matrix in test_strings;
  - **linear algebra** (`_mat`/`_unmat`): `\`, `/`, `inv`, `eig`, `lu`,
    `qr` and `chol` on non-symmetric input, in test_linalg;
  - **later** `.mat` files and plotting, which are not done yet.
- **Sparse matrices** (lib/_matlab_sparse.py) are stored as MATLAB stores
  them, in compressed sparse column form: m-by-n, column starts, row indices
  and the nonzeros (double, single or logical, real or complex). They are
  immutable, so never copied.
  - Construction, queries, display, indexing, assignment, concatenation,
    arithmetic, comparisons, the zero-preserving elementwise functions, the
    common reductions and shape functions, and every matrix product work on
    that storage. So large matrices are never expanded.
  - `S\b` with a large square matrix (n > 4000) is solved without the
    full matrix:
    - a diagonal one row by row;
    - one of small bandwidth by a banded LU, in LAPACK's band storage;
    - any other by a sparse LU (left-looking, partial pivoting that
      prefers the diagonal).

    There is no fill-reducing column ordering, as UMFPACK has. So a matrix
    whose factors fill in too far is refused with `MATLAB:nomem`, rather
    than run for minutes. `condest` of a large sparse matrix uses the same
    LU.
  - Every other function sees the full matrix a sparse one stands for. The
    first sparse matrix a program makes wraps the built-ins for this, so
    programs without one pay nothing. Those MATLAB keeps sparse convert
    their results back.
  - Which results are sparse follows MATLAB:
    - `+` and `-` when both operands are sparse;
    - `.*` when either is;
    - `./` and `.^` when the numerator or base is;
    - `*` for sparse times sparse or a scalar;
    - comparisons always;
    - most elementwise functions, reductions and shape functions.
- **Other classes:** `Char` stores its character codes the same way.
  `Cell`, `Struct` (one dict per element, fields in order) and `StrArr` keep
  their elements in column-major order. Function handles are `Anon`,
  `Handle`, `Function` and `Builtin`.
- **Value semantics without copy-on-write:** a value is never shared by two
  variables.
  - Assignment copies (`_m.cp`) a value read from a variable or a container,
    and so do putting a value into a container and an anonymous function's
    captures.
  - A function copies the arguments it assigns into (found statically).
  - No built-in returns an argument's own array.
  - So `x(i) = v` can change the array in place.
- **Growing a vector one element at a time** (`x(end+1) = v`) makes the
  vector a view of a buffer with room to spare, doubled when full. 10,000
  appends take 0.1 s instead of 1.4 s. Only buffers the runtime made are
  grown into, and values are never shared, so the room belongs to no other
  value.
- **Class rules:**
  - an integer combined with a double is the integer class, with values
    rounded half away from zero and saturated;
  - single with double is single;
  - assigning into an array keeps the array's class, except an empty `[]`,
    which takes the class of the value;
  - concatenation takes the leftmost integer class, then char, then single;
  - `sum` and `prod` of integers are double unless `'native'` is given (as
    MATLAB's documentation says).
- **`colon`** computes `a:d:b` with the second half of the elements
  counted back from the end point, consistent with MATLAB's observed
  output (`0:0.1:0.5` holds exactly 0.3); its tolerance and middle element
  are Sagebrush's and need not be MATLAB's. **`linspace`** follows its
  documentation: the spacing (x2 - x1)/(n - 1), both ends included.
  **`rand`** gives MATLAB's numbers: the Mersenne twister seeded
  with 5489, as `rng default` does, and so do `randi` and `randperm(n)`.
  (`sprand` and `sprandn` draw their places with replacement and keep each
  place once, so a matrix has somewhat fewer nonzeros than the density
  asks, as MATLAB documents; Octave's sample without replacement. Their
  exact places and values are not claimed to be MATLAB's.) **`randn`** is MATLAB's
  ziggurat on the same stream:
  - 256 layers (Marsaglia and Tsang's), each draw two 32-bit words a and b;
  - the layer is 255 - (b >> 24);
  - u = 2w/2^53 - 1, with w the 53 bits of a >> 3 and b's low 24 bits;
  - mostly u x[layer]; else the wedge test with one more uniform, or the
    tail beyond r;
  - the layers' edges are a table of 15-digit constants.
  So `rand`, `randn` and `randi` interleave on one stream as MATLAB's do.

- **Solving** `A\b` follows MATLAB's choices:
  - a square A by LU with partial pivoting. A nearly singular one gives
    MATLAB's warning ("close to singular ... RCOND = ...", for up to 500
    rows) and the LU's result. An exactly singular one gives "singular to
    working precision" and the result of going on past the zero pivot,
    with its Inf and NaN, as LAPACK does. (Octave gives a least-squares
    solution instead.)
  - a rectangular A by QR with column pivoting: the basic solution, its
    free variables 0, with "Rank deficient, rank = r, tol = ..." when the
    rank is short (Octave: the minimum-norm solution). Its norms are
    scaled, as LAPACK's are, so entries near 1e154 or 1e-308 neither
    overflow nor underflow. A NaN or Inf in A gives NaN throughout.
  - the warnings are the same whether A, b or both are complex.
  - `inv` of a singular matrix is Inf throughout, with the warning.

## Display

The Command Window's format short with loose spacing, which is MATLAB's
default. These rules were measured on published MATLAB output: 1,071 HTML
files that MATLAB's `publish` wrote, found on GitHub (`pre.codeoutput`),
from versions 7.0 to 26.1.

- `x = 5` prints `\nx =\n\n     5\n\n`.
- **Doubles with integer values** are 6 wide below 1000 and 12 wide from
  1000 up to 9 digits.
- **Other doubles** are fixed with 4 decimals, 10 wide, for magnitudes in
  [0.001, 1000). Otherwise a matrix gets a common scale factor
  (`   1.0e+03 *`) and a scalar e-notation (`   1.0000e-05`).
- **Format long** is 15 decimals, 20 wide.
- **Columns:** a matrix wider than 79 characters is split into
  `  Columns 1 through 13` groups.
- **Logical arrays** are 4 wide, under a `  1×3 logical array` header.
  Integer classes are as wide as the longest number plus 3, under a header
  like `  2×2 uint8 matrix`.
- **Complex numbers:** the real part right-aligned in 9, then ` + `, then
  the imaginary part.
- **Character vectors** print in quotes. Cells print elements as `{[3]}`,
  `{'abc'}` and `{3×3 double}`.
- **Structs** print `x = ` (with a space, as MATLAB writes objects), then
  `  struct with fields:` and the names right-aligned.
- **Formats:** `short`, `long` and `compact` work, and so do:
  - `shortG` and `longG`: `%.5g` in 13 columns, `%.15g` in 26;
  - `shortE` and `longE`: `%.4e` in 13, `%.15e` in 26;
  - `bank`: two decimals in 14, a complex number's real part alone;
  - `hex`: the value's bits, and an integer class's bytes;
  - `rat`: each element's continued fraction to within 1e-6 of itself,
    with the numerator right-aligned in 8 and the denominator left-aligned
    in 7.
  Integer-valued arrays keep format short's layout under G and E. A
  single shows 7 decimals under the long formats. `disp` prints the same
  body without the name.

## .mat files

`load` and `save` read and write Level 5 MAT-files, which is what MATLAB
writes up to `-v7`, in lib/_matlab_mat.py, following MathWorks' "MAT-File
Format":
- numeric, logical, char, cell and struct arrays, including N-D, complex and
  every integer class;
- sparse matrices, kept sparse with their nzmax (and a logical one also in
  the form Octave writes);
- compressed (`-v7`, the default) or not (`-v6`);
- `S = load(f)`, `load(f, 'x', 'y')`, `save(f, 'x', '-append')` and
  `save(f, '-struct', 's')`;
- `-ascii` files both ways.

MAT-files store arrays column-major, which is the C order of Sagebrush's
reversed-axes arrays, so this boundary needs no transpose. Tests pin it in
both directions:
- **test_matfile** loads a file Octave wrote (matlab-tests/data/octave.mat,
  from make_octave_mat.m);
- **test_matfile_sagebrush** reads data/sagebrush.mat, which Sagebrush writes
  during `--regen`, and its expected output is Octave's reading of the same
  file.

Not supported: MATLAB 7.3 (HDF5) files and objects (strings are saved as
char arrays, with a warning). Single sparse matrices are saved as double.

## Graphics

lib/_matlab_plot.py keeps MATLAB's graphics objects and draws them with
Sagebrush's matplotlib (lib/matplotlib, SVG):
- **The objects** are the root, figures, axes, and the plots in them (Line,
  Bar, Histogram, Image, Surface, Legend, Text and the rest). They are
  handles (`HandleObj` in lib/_matlab.py), with MATLAB's property names, so
  `h.LineWidth = 2`, `set(h, 'Color', 'r')`, `get(gca, 'XLim')`,
  `isgraphics` and handle arrays all work.
- **When figures are drawn:** a figure is drawn when the program ends (or,
  in a notebook, the cell), if anything in it changed since it was last
  shown. `figure(n)`, `gcf`, `gca`, `clf`, `close`, `subplot`, `hold` and
  `tiledlayout`/`nexttile` keep MATLAB's current-figure and current-axes
  rules.
- **What is kept from MATLAB:**
  - hold is off by default, so a plotting function replaces the axes'
    contents, title, labels, limits and color order (MATLAB's `newplot`);
  - the color order (`lines`, `ColorOrder`) is the seven-color palette of
    MATLAB releases before R2025a, from [0 0.4470 0.7410]. Current MATLAB's
    default is the changed "gem" palette of R2025a (its colororder page
    gives the new triplets); Sagebrush deliberately keeps the older one;
  - LineSpec strings (`'r--o'`) work, and so do name-value properties;
  - `plot(Y)` draws a line per column, and `imagesc(C)` shows C's first row
    at the top, with `YDir` reversed;
  - colormaps: `jet`, `hot`, `gray`, `bone`, `pink`, `copper`, `hsv`,
    `cool`, `spring`, `summer`, `autumn` and `winter` give the same values
    as Octave's (checked for every size up to 40, and 63 to 65, 100, 255
    and 256); `turbo` is Google's published Turbo table, interpolated
    linearly for other sizes, as Octave's is;
    `parula` is approximated by interpolating eight colors.
- **Automatic limits** are computed by the axes, and every axes is drawn
  with its own limits (not the shim's padded ones), so the picture agrees
  with `get(gca, 'XLim')`:
  - The tick step is a fifth of the span, rounded to 1, 2, 5 or 10 times a
    power of 10 at the geometric means (√2, √10, √50). The limits are the
    multiples of that step around the data. This is Sagebrush's rule; it
    agrees with Octave's limits for most spans, not all (Octave gives
    [−10 10] for data from −6.55 to 8.08, Sagebrush [−8 10]).
  - A 3-D axes' z axis uses a third of the span, which gives `surf(peaks)`
    MATLAB's [−10 10].
  - Images, contours, bars along their axis, and surfaces seen from above
    are tight to the data.
  - test_plot_limits pins the cases where they agree against Octave.
- **3-D** (`surf`, `mesh`, `plot3`, `scatter3`, `stem3`, `sphere`): an
  orthographic projection with MATLAB's view matrix for (az, el) (default
  (−37.5, 30)):
  - the box is a cube, or has the data's proportions with `axis equal`;
  - the back planes carry grid lines, and tick labels go on the front
    edges;
  - surfaces are depth-sorted quadrilaterals (the painter's algorithm), one
    SVG path each, colored by FaceColor/EdgeColor (`'flat'` takes the first
    corner's CData, `'interp'` averages the four);
  - `mesh` has white faces and height-colored edges;
  - `shading` sets both colors.
  - Seen from above (`view(2)`, `pcolor`), a surface is the same faces in
    data coordinates.
  - Hold off resets the view to 2-D (`newplot`); `surf` and `plot3` then
    turn it to 3-D.
- **Contours:** contour lines come from marching squares (saddle cells are
  split by the centre's value), oriented with the higher values on the left
  as Octave's are, and they give `contourc` and `[C,h] = contour(...)`
  MATLAB's contour matrix. Closed lines repeat their first point, exactly
  as Octave's do.
  - The automatic levels, whose rule MATLAB does not document, are
    Sagebrush's: multiples of a round step (1, 2 or 5 times a power of 10)
    near a seventh of the data's span, within its range, and for `contourf`
    the data's minimum too. They give the published fcontour example's
    0.2:0.2:1.4. `contour(Z, n)` has n levels evenly spaced inside the range.
  - Line colors are the level's colormap color; `clabel` writes the
    levels.
  - `contourf` draws flat bands as one pixelated PNG (Z interpolated
    bilinearly, as the lines are), with black lines.
- **Histograms:**
  - with a bin count, the width is the round step that fits and the left
    edge is a multiple of it (`histcounts([2 3 5 7 11 13 17 19 23 29], 6)`
    has edges `0:4.9:29.4`, as the documentation shows);
  - otherwise Scott's rule, rounded to 1, 2, 3, 5 or 10 times a power of
    10;
  - `histcounts` and `discretize` share this binning (test_hist,
    `.matlab.out`, from the documentation's outputs).
- **Bars:**
  - grouped bars sit side by side, a group of n taking 0.8 of the spacing
    in n equal slots, each bar `BarWidth` of its slot (so at width 1 they
    touch, as documented). This is Sagebrush's rule: MATLAB documents
    `GroupWidth`, but not how its default auto mode chooses the value;
    Sagebrush always uses 0.8, and MATLAB's groups are narrower (three
    series at ±0.222 of the spacing, not ±0.267);
  - stacked bars sit on the series before them;
  - `XEndPoints`/`YEndPoints` give the bar tips;
  - a string array of names places the bars in that order.
- **quiver** scales its arrows by Sagebrush's rule: the longest arrow as
  long as the grid's spacing (the data's range over the square root of the
  number of arrows), times the scale given to `quiver` (0.9 by default;
  Sagebrush's quiver object has no `AutoScaleFactor` property). MATLAB
  documents only that the arrows are scaled so as not to overlap, with
  `AutoScaleFactor` 0.9 by default; its scaling and Octave's both differ
  from Sagebrush's (`quiver([0 1], [0 1], [1 1], [1 -1])` leaves the x
  limits at [0 1.6] here).
- **spy** draws a blue `.` marker of size 6 at each nonzero by default:
  Sagebrush's choice, since MATLAB's documentation does not state the
  default marker (Octave's is `*` for fewer than 1000 nonzeros and `.`
  otherwise). Its limits, 0 to n + 1 and 0 to m + 1 with the rows downward,
  are Octave's, and its label `nz = nnz(S)` is documented.
- **How arrays reach matplotlib:** they cross through `_m._mat`, in MATLAB
  orientation. This is the one place the reversed axes are turned back.
- **Workarounds for the shim:**
  - images are drawn as PNGs, with `pixelated` so cells stay sharp, because
    the shim's `imshow` flips the image and mislabels its ticks;
  - `contourf` is drawn the same way, because the shim's samples Z only at
    the grid points (the browser then blurs the bands);
  - error bars are drawn as lines, because the shim's `errorbar` takes only
    symmetric errors;
  - a colorbar is the shim's contourf colorbar, given the colormap as
    bands;
  - a reversed y axis is drawn by negating y and relabeling the ticks.
- `sphere`'s columns run from θ = 0 to 2π, as Octave's do (MATLAB documents
  only the size), and `pie` labels each slice with its rounded percentage at
  1.2 times the radius, as Octave does ("0%" for a sliver).
- **Not yet:**
  - lighting (`camlight`, `lighting` and `material` do nothing);
  - polar axes, `annotation`, `uifigure` and apps, `animatedline`;
  - raster output: `print`, `saveas` and `exportgraphics` write SVG.

Tests:
- **test_plot** compares objects' properties after plotting (limits, data,
  colors, counts) with Octave's. Octave has no `h.Prop` syntax, so it uses
  `get`. Where the two differ, it compares only what they share: Octave's
  `scatter` stores XData as a column and MATLAB keeps the row given, so the
  test checks its `numel`.
- **test_plot_limits** (Octave) covers automatic limits in 2-D and 3-D,
  the view, and contour matrices.
- **test_plot_handles** (`.matlab.out`, by hand) covers dot syntax.
- **test_hist** (`.matlab.out`) has the documentation's binning examples.
- The pictures themselves were checked by eye: rendered SVG, screenshotted
  in Chromium.

## Notebooks and Jupyter

A notebook cell, or a Jupyter cell, is translated in cell mode
(`matlabToPython(code, "<cell>", {cell: true})`):
- variables and functions stay in the session's globals for the next cells,
  and so do `format`, the random state and the figures, as in a MATLAB
  session;
- a cell's figures are shown when it ends.
- An error is MATLAB's message, on stderr in the Sagebrush notebook
  (src/notebook-session.ts), or as Jupyter's error with the message as its
  traceback (src/kernel.ts, `--mode matlab`). It fails that cell only:
  lib/_matlab.py's `report_cell` records it, and `cell_failed()` and
  `cell_error()` tell the host.
- Function files (`name.m`) load through the same host operation as in the
  CLI, where there is a file system.
- The search box finds MATLAB's built-ins (lib/_matlab_docsearch.py,
  docs-index-matlab.json), with a short example for the most used ones
  (lib/_matlab_examples.py): one to three lines written for Sagebrush,
  shown after MATLAB's prompt `>>` with the output Sagebrush prints, and
  insertable into a new cell. test/matlab-doc-examples.test.ts runs every
  example and compares its output exactly; matlab-tests/test_doc_examples.m
  (made by matlab-tests/doc_examples.py --octave) compares the values they
  make with Octave's, except where Octave lacks the function or knowingly
  differs (doc_examples.py's OCTAVE_SKIP, with the reason).
  `doc_examples.py --update` rewrites the outputs after a display change.

## Published examples as a test

A corpus of published MATLAB examples, each with the output MATLAB printed,
is kept outside this repository.

- `python3 matlab-tests/docs.py [-j N] [function ...]` runs each example
  under `SAGEBRUSH_MATLAB_DISPLAY=doc` (`x = 1×3` and the values, the
  layout such examples use).
- It compares every step's output token by token, since the corpus's
  whitespace is not MATLAB's. `10^3 ×` is compared as `1.0e+03 *`, and
  `1×3 string` as `string array`.
- It reports pass, diff, missing (a function Sagebrush lacks), error and
  skipped (examples with figures).

The examples settled several display rules:
- a matrix's scale factor below 1 is $10^{\lceil \log_{10} m \rceil}$, so
  the largest element shows as 0.xxxx;
- a complex number's imaginary part has a field at least 7 wide
  (`-5.3000 +10.9000i`), and $-0$ prints with `+`;
- cells pad inside their braces (`{1×2 cell }`) and show short double rows
  inline (`{[2.6000 4.7000 3.9000]}`);
- N-D arrays print page by page (`A(:,:,1) =`).

They also settled several function rules:
- set functions return the first occurrence's index (as since R2013a, and
  the last with `'legacy'`), with C oriented as each function's page says;
- `func2str(@cos)` is `'cos'`;
- a real times a complex number keeps a zero part zero (`NaN*1i` is
  $0 + \mathrm{NaN}\,i$).

`gamma`, `gammaln`, `erf` and `erfc` use Python's `math` (src/runtime:
fdlibm's erf and lgamma, musl's tgamma). `gamma` is exact at the integers,
as MATLAB's is, and Inf at the poles. They agree with Octave to 12 or more
digits (test_builtins).

Still to match: `randn` (MATLAB's ziggurat on the twister is not numpy's),
eigenvector signs (LAPACK's), and `uint64` beyond $2^{53}$.

## Testing

- **matlab-tests/** (`python3 matlab-tests/run.py [-v] [name]`): each
  `test_*.m` runs under `sagebrush --matlab`, and its output must equal the
  committed expected output.
  - **`test_*.out` comes from GNU Octave.** Display differs between MATLAB
    and Octave (Octave prints `x = 5`), so these tests print values with
    `show.m`: class, size and `mat2str(x, 17)`, in which the two agree. The
    comparison is then exact to the bit, not to 4 displayed digits.
    Results that depend on LAPACK's order of operations are rounded.
  - **`test_*.matlab.out` is MATLAB's own output,** written by hand from the
    published output above and MATLAB's documentation. These cover the
    display, and the places where Octave differs from MATLAB. `--regen`
    never touches them.
  - `python3 matlab-tests/run.py --regen` rewrites the `.out` files with
    Octave. MATLAB wants a script's functions at its end, while Octave needs
    them defined before they are called, so run.py gives Octave a copy with
    the functions moved to the top.
- **test/matlab.test.ts:** the lexer's and parser's hard cases, the `.m`
  file guess in both directions (through the CLI too), and handles' text.

**Installing Octave** (GNU Octave 11.1, the oracle). The `octave` RootFS
recipe and `apt-get install octave` both failed in the Sagebrush CoCalc
project: dpkg could not create subdirectories in some directories of the
image's lower layer (mkdir gave "No such file or directory"). Extracting
the packages works:

```sh
apt-get download octave octave-common      # into /scratch/octave-debs
for f in *.deb; do dpkg -x "$f" /scratch/octave-root; done
# (its shared libraries, lapack and the rest, came with the failed install;
#  elsewhere: apt-get install liboctave-dev's dependencies, or the whole package)
cat > /scratch/octave-root/octave-cli <<'EOF'
#!/bin/sh
export OCTAVE_HOME=/scratch/octave-root/usr
export LD_LIBRARY_PATH=/scratch/octave-root/usr/lib/x86_64-linux-gnu:/scratch/octave-root/usr/lib/x86_64-linux-gnu/octave/11.1.0${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
exec /scratch/octave-root/usr/bin/octave-cli "$@"
EOF
```

On a normal machine, `apt-get install octave` is enough. run.py uses
`$OCTAVE`, by default /scratch/octave-root/octave-cli. CI needs no Octave,
since it compares against the committed outputs.

## Where MATLAB and Octave differ (Sagebrush follows MATLAB)

- **`sprintf('%d', pi)`:** MATLAB switches to `%e` and prints
  `3.141593e+00`. Octave prints `3.14159`.
- **`nthroot(-27, 3)`** is exactly -3 in MATLAB. Octave gives
  -3.0000000000000004.
- **`mat2str` of a char array** works in MATLAB (`'it''s'`). Octave rejects
  it.
- **`mat2str(zeros(1,0))`** is `zeros(1,0)` in MATLAB and `[]` in Octave.
- **`contains`** is not in Octave 11.
- **Local functions:** MATLAB puts a script's local functions at its end.
  Octave needs them before they are called.
- **Display:** Octave prints `x = 5` on one line, and its matrix columns are
  narrower.
- **Random numbers:** Octave's `randn` is not MATLAB's ziggurat; Sagebrush's
  `rand`, `randn` and `randi` give MATLAB's numbers.
- **Sparse matrices:**
  - `max(S, F)`, `dot`, `unique`, and `lu`'s permutation are sparse in
    MATLAB and full in Octave;
  - `S - F` is MATLAB's `-F` with S's nonzeros added (so `-0` where S is
    zero);
  - `spy`'s label is `nz = 5` (Octave: `nnz = 5`);
  - single sparse matrices are MATLAB's alone.

Where MATLAB's behaviour is not documented and no published output shows
it, Sagebrush follows Octave, which aims at MATLAB compatibility. For
example, `num2str` of an integer matrix with negative numbers: its columns
are the largest number's digits plus 2 wide, with no extra column for a
minus sign.

## Security

The translated program is Python. Text from the program reaches the
emitted code only as Python string literals (JSON) and as identifiers
checked to be MATLAB names (a Python keyword becomes `_k_name`). So MATLAB
code can do nothing Python code cannot (design/security.md, rule 6). The
one host operation, `matlab_function_file`, takes text and returns text
(the Python of a function file). There is no `eval` of MATLAB text at run
time, and `str2func` of an anonymous function's text is not supported.

## Not yet

What is not implemented is refused with an error, never answered with
something plausible. Examples:
- `linsolve` options other than TRANSA, LT, UT and RECT, and UHESS, SYM or
  POSDEF for a matrix without that property;
- `funm` of a defective matrix except by exp, cos, sin, cosh, sinh, log and
  sqrt;
- `interp2`'s 'cubic' on a non-uniform grid, and 'makima' and 'pchip'.

The rest:
- polar axes, lighting and apps (see Graphics);
- MATLAB in the notebook's and the board's language menus (the session and the Jupyter kernel run it);
- `eval`;
- `classdef` and nested functions;
- string arrays beyond the basics;
- `containers.Map`, file I/O beyond `fprintf`, `input`;
- `randperm(n, k)` with k < n giving MATLAB's numbers (`randperm(n)`
  does);
- `int64` and `uint64` beyond 2^53: Sagebrush's numpy stores them in
  doubles, so `intmax('int64')` shows 9223372036854775808 and
  `intmax('uint64')` 18446744073709551616;
- `svds` and iterative solvers (`pcg`, `gmres`); `eigs` of complex
  matrices, with complex shifts or start vectors, or with an Afun whose
  results are complex (Sagebrush's numpy has no complex eigenvalue or QR
  routines yet, which `eig` of a complex matrix lacks too);
- `eig` of complex matrices (Sagebrush's numpy has no complex eigenvalue
  routines yet), and `eig(A, B)` where it needs the QZ algorithm: "qz", a
  singular B (the pencil may have infinite eigenvalues), or a badly
  conditioned one (Sagebrush's rule: cond(B)*eps > 1e-8). A symmetric A
  with a symmetric positive definite B is the page's "chol" algorithm;
  another pair is solved as B \ A, with V's and W's columns of 2-norm 1
  (Sagebrush's choice; the page leaves their norms open);
- `psi`, `beta` and `betaln` of negative arguments (their pages ask for
  real nonnegative ones; Octave answers), and `psi(k, X)` for k > 100. Where
  the pages say nothing, `psi(k, 0)` is the limit from the right (-Inf for
  even k, Inf for odd k) and `psi(Inf)` is Inf; Octave gives NaN and
  -0.5772. These functions, `erfcx`, `erfinv`, `erfcinv`, `expint`,
  `ellipke`, `ellipj` and `legendre` are thin wrappers
  (lib/_matlab_special.py) over the shared numerics in lib/_special.py
  (design/special.md). `ellipke` and `ellipj` refuse M outside [0, 1], as
  their pages require (Octave answers), and accept `tol` but always
  compute to full accuracy; `ellipj` also refuses an infinite U, where
  Octave gives NaN;
- the random sparse matrices' exact places and values: `sprand`'s and
  `sprandn`'s follow MATLAB's documented behaviour, and `sprandsym`'s
  construction is Sagebrush's own (exactly the requested number of
  nonzeros);
- automatic histogram edges: MATLAB documents what its bins do but not how
  it picks "nice" edges, so Sagebrush's rules are its own (Scott's width
  rounded to Heckbert's nice numbers, 1, 2, 5 or 10 times a power of 10)
  and its edges can differ from MATLAB's;
- `normest`'s estimates on the way and its count: it is Higham's power
  method (the estimate ||S x|| for a unit x) with MATLAB's documented
  stopping rule, and MATLAB documents neither its own estimate formula
  nor its starting vector, so the iterations, and an estimate stopped
  early by a loose tolerance, can differ from MATLAB's.
