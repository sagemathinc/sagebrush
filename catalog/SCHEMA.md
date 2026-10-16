# The function catalog: entry schema (draft 7)

Every function, class, method or constant an agent can use in a Sagebrush
mode has one **entry**. The entries are what `sb --search`, the MCP
`search_docs` tool and the site's search show. CI runs every example on every
runtime and compares the output. The same schema serves all four modes:
`python`, `sage`, `magma` and `matlab`.

Entries also describe what Sagebrush lacks. A commonly wanted upstream name
that is not implemented gets an entry with status `absent` and a nearest
alternative, so an agent learns at once to use something else.

## Files

```
catalog/<mode>/<group>.json     one JSON array of entries per group
catalog/<mode>/missing.txt      public names that have no entry yet (it may only shrink)
catalog/schema.json             this schema, as JSON Schema (draft 2020-12)
```

`<group>` is free: for example `numpy-linalg.json`, `elliptic-curves.json` or
`strings.json`. Within a mode an entry is identified by its `name` together
with its `signature`. One name may therefore have several entries, one for
each signature with its own meaning (a Magma intrinsic such as `Trace`, a
MATLAB function overloaded by class, or methods of one name on different Sage
classes). Each such entry has its own summary, examples, differs and status,
and search groups the entries of one name. Files are UTF-8 with
two-space indentation, and keys are in the order below, so diffs stay small.

## An entry

```json
{
  "name": "numpy.linalg.solve",
  "kind": "function",
  "signature": "(a, b)",
  "summary": "The solution x of the linear system a @ x = b.",
  "doc": "a must be square and nonsingular; b is a vector or a matrix whose columns are right-hand sides. Raises LinAlgError for a singular a.",
  "examples": [
    {"code": "np.linalg.solve([[3, 1], [1, 2]], [9, 8])", "expected": "array([2., 3.])\n"}
  ],
  "differs": ["Only float64 and complex128 results: float32 inputs are computed in float64."],
  "status": "full",
  "see_also": ["numpy.linalg.lstsq", "numpy.linalg.inv"]
}
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | The full public name as code in the mode spells it: `numpy.linalg.solve`, `EllipticCurve`, `ClassGroup`, `cumsum`. A method is `Receiver.method`, the receiver named as code makes it: the public constructor where there is one (`EllipticCurve.rank`, `matrix.det`, `NumberField.class_group`, not the class that happens to implement it), else the type as `type(x).__name__` prints it (`Integer.factor`, `Expression.reduce_trig`). The implementing class's name may go in `aliases` (`EllipticCurve_rational_field.rank`), and the full upstream path in `upstream`. |
| `aliases` | no | Other names of the same thing, which the entry covers whole: `["derivative"]` for `diff`, `["numpy.amax"]` for `numpy.max`, or the global form of a method (`["factor"]` for `Integer.factor`). Search finds the entry by them, and gate 2 counts them as covered. An alias is no other entry's name in the mode. |
| `kind` | yes | A parent or other value bound to a name (Sage's `QQ`, `ZZ`, `pi`) is a `constant`; a constructor (`GF`, `PolynomialRing`, `matrix`) is a `function`; a class an agent subclasses or tests with `isinstance` is a `class`. Otherwise: `function`, `procedure` (a Magma call that changes its `~x` arguments), `class`, `method`, `attribute`, `constant`, `module`, `operator` or `keyword`. |
| `signature` | yes | The call form in the mode's own syntax. Python: `(a, b, axis=None)`. Sage: `(E, p)`. MATLAB: `[y1,...] = f(x)`. Magma: `(<MtrxS> a) -> RngElt`, or `(<RngIntElt> n : Proof := true) -> BoolElt` with parameters after `:`; the argument types tell the entries of one name apart, and the return type is optional. A signature that starts with `(` is shown after the name; any other form is a whole call form, shown as written (MATLAB's `M = max(A)`). Optional parts go in `[ ]`. Several call forms of one function with one meaning go one per line (`"M = max(A)\nM = max(A, [], dim)\n[M, I] = max(___)"`); a form with a meaning of its own is an entry of its own. Use `""` for a constant, module or keyword. |
| `summary` | yes | One sentence, at most 150 characters, in our own words. This is what search results show. |
| `doc` | no | Markdown, in our own words (clean room: never copied from upstream documentation). It covers arguments, return value, errors and edge cases. Math goes between `$...$`. |
| `examples` | yes: at least one, except for `absent` | Each is `{"code", "expected"}`, run as described below. |
| `differs` | yes (may be `[]`) | One line per known difference from upstream: arguments not accepted, output format, precision, missing options, exotic semantics. An empty list claims none is known. |
| `status` | yes | `full`, `partial`, `stub-error` or `absent` (below). |
| `alternative` | for `absent` (required) and `stub-error` (recommended) | What to use instead in Sagebrush: a name (`"numpy.roots"`) or a sentence (`"compute it over QQ, then map to the extension"`). Name a cataloged entry where possible. |
| `domains` | no | Where `status` holds, in the mode's own words: Sage's base rings and fields (`"ZZ"`, `"QQ"`, `"GF(q)"`, `"Zmod(n)"`, `"number fields"`, `"AA"`, `"QQbar"`, `"RDF/CDF"`, `"RealField(p)"`), or dtypes, or argument classes. `differs` names what happens elsewhere. Search can filter on it. |
| `see_also` | no | Names of related entries in the same mode. |
| `upstream` | no | The upstream name, when it differs from `name`: for example `"sage.rings.integer.Integer.factor"`, or for a MATLAB function the toolbox it belongs to. |
| `upstream_version` | no | The upstream release `differs` and `status` were judged against: `"NumPy 2.3"`, `"SciPy 1.16"`, `"Python 3.14"`, `"Sage 10.10"`, `"Magma 2.28"`, `"MATLAB R2025b"`. |
| `tags` | no | Search areas: `["linear algebra"]`, `["number fields", "class groups"]`. |

### Status

- `full`: everything upstream documents for this name works, except what `differs` lists.
- `partial`: the common uses work, and `differs` must say what doesn't, naming each refused form (`"'omitnan' together with 'all' is refused"`), so an agent knows it gets an error, not a different answer. Something unsupported raises an error, never a wrong answer.
- `stub-error`: the name, or this signature of it, exists but always raises a clear "not implemented in Sagebrush" error. Its example shows that error.
- `absent`: Sagebrush has no such name (or, for one signature of an overloaded name, no such signature), and code that uses it raises the mode's NameError or undefined-function error. The entry exists so an agent searching for it finds the `alternative`. `examples` may be `[]`.

### Examples

An example's `code` runs in a fresh session of the entry's mode. Its
`expected` text is exactly what that mode's prompt prints, compared exactly:
blank lines at the start or the end count, nothing is stripped. It is empty
or ends with a newline. An example that prints nothing (a MATLAB statement
ending with `;`) has `""`; that is allowed, but each entry should have an
example that shows a result. What the code prints before an error comes first,
then the error:

- **python**: the output of the code, then the `repr` of the last line when that line is an expression whose value isn't None, as `>>>` shows it. The session already has `import numpy as np`, `import math, cmath, itertools, functools, collections, random, bisect, heapq` and `from fractions import Fraction` (`lib/_python_examples.py` PRELUDE).
- **sage**: as a `sage:` prompt prints, after Sage's preparser (`2^3` and `1/2` mean what they mean in Sage): the value of each top-level expression statement, as a doctest block shows it. Most examples end with one expression.
- **magma**: what Magma code prints (`print`, or a statement ending without `;` showing its value, as Magma's REPL does).
- **matlab**: what the MATLAB command window shows, `ans = ...` included, with the mode's display format.

An example that draws shows, where the graphic is displayed, one line per
figure that it made or changed, in the form `[figure N: DESCRIPTION]`. N
counts the example's figures from 1. DESCRIPTION is the text description that
`lib/_graphics.py` stores in every figure it draws (the SVG's `<title>`),
never anything taken from pixels, so it is the same on every runtime: the
parts in drawing order, with their labels, then the axes' ranges. For example:

```
[figure 1: Plot: "Two waves"; line "sin" through 5 points, line "cos" through 5 points; x (x) from -0.3142 to 6.597, y from -1.1 to 1.1]
```

A mode's runner gets these lines by setting `builtins.__sagebrush_catalog__`
to `[0]` (its figure count) while the example runs; `lib/_graphics.py` show()
then prints the line instead of displaying the figure. Python's runner also
shows the figures an example leaves open, as the notebook does after a cell,
and closes those an earlier example left. A Sage `Graphics` object that is
the value of a line prints its own repr (`Graphics object consisting of 1
graphics primitive`), as Sage does. Plotting functions need examples like any
other.

An example that raises shows the error as the mode reports it, by the mode's
rule: **python** and **sage**, only the last line of the traceback
(`"NotImplementedError: ... is not implemented in Sagebrush\n"`); **magma**,
the whole error text (the `>>` source line, the caret line, `Runtime error in
'Trace': Bad argument types` and the `Argument types given:` line);
**matlab**, the `Error using ...` text the command window shows.
Examples must be deterministic. Seed random generators, and leave out
timings and memory addresses. Keep them short: they are read by agents, and
CI runs them on every runtime. Only the first example appears in `sb --search`
output, so make it the representative one.

An example may add `"runtimes": [...]`, a subset of `node`, `deno`, `bun`,
`browser` and `package`, to restrict where it runs. The default is everywhere
the mode runs. A restriction must be explained in `differs`.

## The built index

`sagebrush -m _catalog --index --mode M` builds the mode's index from the
files above. Each element is the entry plus `mode`, and `module` (the dotted
prefix of `name`, or the group); each example has, as `setup`, the lines of
the mode's prelude it needs (`import numpy as np`), so that it runs where it is
copied to. `sb --search` (`--json` gives every entry whole, `differs` and
`alternative` included: agents read that), the MCP `search_docs` tool and the
site's search (web/index.html) read it, and show an example with its setup.

## Gates (CI)

1. Every file validates against `catalog/schema.json`, and a (name, signature) pair occurs once per mode.
2. Every public name of a mode has an entry (as its name or an alias) or is in `missing.txt`. Each mode lists its own public names, as `lib/_python_docsearch.py` does for Python; Sage's are the `sage_all` globals, and methods get entries as their owners choose. A new public name without an entry fails. A name in `missing.txt` that has gained an entry must be removed from it.
3. Every example runs on every runtime of its mode, and its output must equal `expected`. A changed output fails until the entry is updated in the same commit.
4. Coverage per mode is reported: entries, entries with examples, each status, and the `missing.txt` count.
