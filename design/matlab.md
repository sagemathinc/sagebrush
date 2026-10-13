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
- **`colon`** computes `a:d:b` as MATLAB does: the second half of the
  elements is counted back from the end point. **`linspace`** uses MATLAB's
  formula. **`rand`** gives MATLAB's numbers: the Mersenne twister seeded
  with 5489, as `rng default` does. `randn` and `randi` do not, since
  MATLAB's algorithms for them differ from numpy's.

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
- `format long`, `format compact` and `format short` all work. `disp` prints
  the same body without the name.

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

- plotting (`plot` and friends, onto Sagebrush's matplotlib);
- `.mat` files (`load`/`save`, over lib/scipy/io/matlab.py);
- MATLAB as a notebook and board language (it works from the CLI only);
- `eval`;
- `classdef` and nested functions;
- string arrays beyond the basics;
- `containers.Map`, sparse matrices, file I/O beyond `fprintf`, `input`;
- `randn` and `randi` matching MATLAB's streams.
