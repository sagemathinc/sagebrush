<!-- description: How Sagebrush runs MATLAB: a hand-written parser and a translator to Python on numpy, MATLAB's value semantics and display reproduced, graphics as MATLAB objects, and tests against Octave, 8,252 documentation examples and MATLAB R2026b. -->
# How the MATLAB implementation works

*Code: `src/matlab.ts` (the translator), `lib/_matlab.py` (the runtime),
`lib/_matlab_plot.py` (graphics), `lib/_matlab_mat.py` (`.mat` files).
Design notes: `design/matlab.md`. About 13,700 lines in all.*

Type this into a Sagebrush notebook in MATLAB mode:

```matlab
A = [4 -2; 1 1]
x = A \ [2; 3]
```

What comes back is what MATLAB prints:

```
A =

     4    -2
     1     1


x =

    1.3333
    1.6667
```

The rest of this page describes how that is achieved, and how closely. In
short, MATLAB is translated to Python, which runs on Sagebrush's own numpy,
and a runtime library supplies MATLAB's semantics, its built-in functions,
its display and its graphics.

## 1. A translator, not an interpreter

A MATLAB program goes through a hand-written lexer and parser into a syntax
tree, and from there to Python source, which runs like any other cell.
Translating, rather than interpreting, means MATLAB gets everything Python
code in Sagebrush already has for free: the sandbox and its security
rules, interrupts, the notebook, the reactive dependency analysis, boards,
plots and the Jupyter kernel.

**The lexer** carries most of MATLAB's syntactic surprises:

- A quote is a transpose after a name, a closing bracket, a dot or another
  quote (`a'`, `x(2)'`, `a.'`), and starts a character vector anywhere else.
- Inside brackets, whitespace separates elements: `[1 -2]` has two
  elements and `[1 - 2]` has one. So does `[a' b']`, which has two
  transposes, not a string.
- A line such as `hold on` or `format long` is **command syntax**: the
  function `hold` called with the text `'on'`. Whether a line is command
  syntax depends on spacing (`a -1` versus `a - 1`) and on whether `a` is
  a variable.
- `...` continues a line, and the rest of that line is a comment. `%{`
  and `%}` on lines of their own enclose a block comment.

**Names are resolved statically where MATLAB allows it.** Inside a
function, a name is a variable if the function assigns it anywhere;
otherwise it is a function. At the top of a script or a notebook cell,
earlier cells may have defined anything, so the generated code checks the
workspace at run time.

**Every call knows its `nargout`.** In MATLAB, a function can see how many
outputs its caller wants (`[q, r] = deal(...)`, `size(x)` versus
`[m, n] = size(x)`). Each call passes that number explicitly, and
comma-separated lists (`c{:}`, `s.f` on a struct array, `varargout`) are
expanded where MATLAB expands them.

**`end` inside an index** means the last index of the dimension being
indexed, which depends on the object and on how many indices there are.
The translation keeps a stack of index frames, so `x(end, end-1)` and
`c{end}(end)` work.

## 2. Values

**A MATLAB array is a numpy array with its axes reversed.** An $m \times n$
MATLAB matrix is stored with shape $(n, m)$. MATLAB stores arrays
column-major, and with the shape reversed, numpy's ordinary row-major
layout *is* MATLAB's layout. Linear indexing `A(k)`, `reshape`, `A(:)`,
and reading and writing `.mat` files then need no reordering at all. The
cost is one flip of the axes wherever an array crosses into code that
expects numpy's orientation, such as linear algebra or matplotlib, and
each of those places is pinned by a test.

**Scalars are Python numbers.** A double scalar is a Python `float` and a
logical scalar a `bool`, because most of what MATLAB programs compute
element by element is scalars in loops. The arithmetic operators have fast
paths for them.

**Value semantics.** In MATLAB, `b = a; b(1) = 0` does not change `a`.
The translation copies at the places where two names could share an
array: assignment from a variable, function arguments that the function
modifies, and fields and cells. MATLAB uses copy-on-write and this does
not, which is correct but sometimes slower.

**Growing arrays.** `x(end+1) = v` in a loop is quadratic if done
naively. Sagebrush grows such arrays into a buffer that doubles, as a
Python list does.

**Classes.**
- Character vectors, `string` arrays, cells, structs and function handles
  (anonymous or named) are runtime classes.
- The integer classes saturate as MATLAB's do: `int8(127) + 1` is 127,
  and division rounds.
- Handles (graphics objects) have reference semantics.
- `.mat` files (Level 5, the format MATLAB writes by default) are read and
  written by Sagebrush's own code, compressed or not, with numeric,
  logical, char, cell and struct arrays.

## 3. The display

Getting MATLAB's printed output exactly right took more care than any
other single part, because programs and teaching material are full of it,
and because MATLAB's rules are mostly undocumented. Some of them:

- `format short` shows 5 significant digits. A matrix whose elements need
  a common scale gets a factor line, `1.0e+03 *`. Below 1 the factor is
  $10^{\lceil \log_{10} m \rceil}$, so that the largest element shows as
  `0.xxxx`.
- Integers print without decimals, in columns as wide as the widest. Wide
  matrices break into `Columns 1 through 8` groups that fit 80 characters.
- A complex number's imaginary part has a field at least 7 wide
  (`-5.3000 +10.9000i`), and $-0$ prints with a plus sign.
- Cells pad inside their braces (`{1×2 cell }`) and show short rows of
  doubles inline. Structs right-align their field names. N-D arrays print
  page by page (`A(:,:,2) =`).
- `format long`, `format compact`, `disp`, `num2str`, `mat2str` and
  `sprintf` (which switches `%d` to `%e` for non-integers) each have rules
  of their own.

These rules were reconstructed from a corpus of published MATLAB output
and from the output printed in MathWorks' documentation, then checked
against MATLAB itself (section 6).

## 4. Graphics

MATLAB's graphics are an object system: figures contain axes, axes contain
lines, surfaces, text and legends, each with properties you can read and
set (`h.LineWidth = 2`, `get(gca, 'XLim')`). Sagebrush keeps that object
model with MATLAB's property names, and draws each changed figure as SVG
when the program or the cell ends.

- **Plot types:**
  - lines, scatter plots, bars (grouped, stacked and named), histograms,
    stairs, stems, areas, error bars, pie charts, images, quiver plots;
  - contours, filled contours, `pcolor`, surfaces and meshes;
  - subplots, tiled layouts, legends, colorbars and colormaps.
- **MATLAB's habits are kept:**
  - hold is off by default, so each plot replaces the last;
  - the line colours are MATLAB's, and `'r--o'` LineSpecs work;
  - an image's first row is at the top.
- **Automatic axis limits** are computed by the axes, not by the drawing
  library. The tick step is a fifth of the data's span, rounded on a log
  scale to the nearest 1, 2, 5 or 10 times a power of 10, and the limits
  are the multiples of that step around the data. A 3-D plot's z-axis
  uses a third of the span, which gives `surf(peaks)` its $[-10, 10]$.
- **3-D** uses MATLAB's own viewing transformation for an azimuth and
  elevation (default $(-37.5^\circ, 30^\circ)$). Surfaces are drawn as
  quadrilaterals sorted far to near (the painter's algorithm), with grid
  lines on the back planes, as MATLAB draws them. There is no lighting
  yet.
- **Contour lines** come from marching squares and give MATLAB's contour
  matrix, `[C, h] = contour(...)`. Filled contours are drawn from Z
  interpolated bilinearly, so bands end where the data crosses a level.
- **Histogram bins.** With a given number of bins, MATLAB picks a round
  bin width and a left edge on a multiple of it. The documentation's
  example shows `histcounts([2 3 5 7 11 13 17 19 23 29], 6)` with edges
  $0, 4.9, 9.8, \ldots, 29.4$, and the rule reproduces it.

## 5. Notebooks, boards and Jupyter

In a notebook, each cell is translated in "cell mode":

- variables and functions stay for the next cells, and so do `format`,
  the random state and open figures;
- a cell's figures are shown when it ends;
- an error is MATLAB's own message, and it fails that cell only.

The reactive notebook analyses MATLAB cells too. It works out which
variables each cell defines and reads, so editing `x = 2` reruns the cells
that read `x`. `ans`, which every bare expression assigns, links no cells.

A board can have MATLAB (or Python, Sage or Magma) as its language. The
Jupyter kernel runs MATLAB with `sagebrush --install-jupyter-kernel --mode
matlab`.

**Security.** The translated program is ordinary Python and can do
nothing Python code cannot. Text from the program reaches the generated
code only as string literals, and names only after being checked as
MATLAB identifiers. MATLAB text is never evaluated at run time.

## 6. How it was tested

There were three oracles, each good for different things.

**GNU Octave** (version 11.1) for values. Octave aims at MATLAB
compatibility and was never wrong about arithmetic in these tests. But
it prints differently (`x = 5` on one line, narrower columns), so the
tests print values through a small neutral printer:

- class, size, and `mat2str(x, 17)`, exact to the last bit;
- 12 test files are compared with Octave this way, and 3 more, of
  MATLAB's own output, are checked by hand.

Where MATLAB and Octave disagree, Sagebrush follows MATLAB:
- Octave's `"abc"` is a character array, not a string;
- `sprintf('%d', pi)`;
- `nthroot(-27, 3)` is exactly $-3$ in MATLAB;
- `mat2str` of text;
- functions in scripts must come before use in Octave, and at the end in
  MATLAB;
- Octave has no dot syntax on graphics handles;
- automatic contour levels;
- several functions Octave lacks (`contains`, `histogram`, `histcounts`).

**MathWorks' documentation** for breadth. The R2026b function reference
is 21,120 pages, with 8,252 examples showing MATLAB's output. In the PDF,
code is set in black and output in gray, so a script separates them
exactly. A harness runs every example under Sagebrush and compares the
output token by token. Those examples settled many of the display rules
above.

**MATLAB itself**, at the end. One script, `sagebrush_matlab_oracle.m`,
was run once in MATLAB R2026b. It recorded about 420 facts that only
MATLAB can tell:

- long runs of its random number streams;
- about 95 kinds of value, displayed under every `format`;
- factorization sign conventions, 64-bit integers beyond $2^{53}$, and
  special functions;
- the exact parula and turbo colormaps;
- the automatic limits and ticks of 40 kinds of plot, contour levels and
  histogram bins.

It is being worked through now. The first result:
- `rand` was already bit-for-bit MATLAB's: the Mersenne Twister seeded
  with 5489, two 32-bit words per double;
- `randn` uses one 53-bit draw per value in a 256-layer ziggurat, whose
  exact bit layout is still being matched.

## 7. How close, by the numbers

Of the 8,252 documentation examples:

| | |
|---|---|
| Examples without figures whose output matches MATLAB exactly | 860 of 5,532 |
| …among those whose functions Sagebrush has | **860 of 1,866 (46%)** |
| Examples with figures that run, with matching printed output | 569 of 2,720 |
| Functions with at least one passing example | 508 of 3,073 |
| Built-in functions | about 475, and 116 for graphics |

The low overall share is mostly breadth: 5,457 examples call a function
Sagebrush does not have. The most requested are:

| Function | Examples |
|---|---|
| apps and GUIs (`uifigure`) | 294 |
| `table` and `readtable` | 241 |
| `graph` and `digraph` | 149 |
| `datetime` | 146 |
| `categorical` | 73 |
| `polarplot` | 49 |
| `ode` | 25 |

Many of the rest belong to toolboxes. Of the runnable examples that fail:
- most do not parse: `classdef`, `!` shell commands, and lines the PDF
  extraction cut short;
- 221 need sample data files that MATLAB ships (`patients.mat`);
- about 224 are genuine runtime errors.

**Not yet:**
- `classdef`, tables, `datetime` and `categorical`;
- sparse matrices (next);
- ODE solvers;
- lighting in 3-D.

Speed has not been benchmarked: vectorized code runs on Sagebrush's numpy,
while scalar loops run as translated Python, with nothing like MATLAB's
JIT compiler.

## What would have saved time

- **The documentation as a test, from day one.** Thousands of examples
  with MATLAB's real output were sitting in the PDF. Extracting them by
  font colour took an afternoon, and they found more display bugs than
  anything else.
- **Octave for values, not for display.** Comparing printed output with
  Octave's was useless: the formats differ. Comparing `mat2str(x, 17)`
  was exact, and it caught real bugs to the last bit.
- **Check the platform's corner cases early.** A numpy function that
  returned a view where a copy was expected silently lost writes such as
  `X(1:2:end) = 0` until a test caught it. Small probes of the
  assumptions underneath would have found it in minutes.
- **One run of the real thing is worth a lot.** A single script, run once
  in MATLAB, answered questions that inference from documentation could
  only approximate: what the random streams are, which sign an
  eigenvector has, how wide a column is.
