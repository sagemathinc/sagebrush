# Conformance

This directory measures the Python front end and the pyjs runtime against CPython 3.14.

| Suite | Command | Result (2026-10-04) |
|---|---|---|
| Parser: the AST is identical to `ast.parse` on real code | `python3 pyparse/test/compare_stdlib.py DIR` | stdlib 628/628; site-packages (numpy, pandas, matplotlib, pyarrow, ...) 4327/4327; Sage library 2594/2594 |
| Parser: the SyntaxError is identical (type, message, line, offset, end) | `python3 pyparse/test/compare_errors.py` | CPython's `test_syntax.py`: 463/463 errors, and all 126/126 valid snippets are accepted |
| Runtime: the corpus ported from sagejs (below) | `python3 conformance/run.py` | **532/536**, plus 3 reviewed (see below); 1 failure |

## The runtime corpus (`upstream/`, from sagejs, licenses and provenance kept)

- **micropython**: 508 programs from MicroPython's `tests/basics`. A program passes when its stdout and exit status equal CPython 3.14's.
- **rustpython, pypy, graalpy, ironpython, cpython**: 28 self-checking programs. Each must exit 0 with empty stdout and stderr.

`run.py` takes about 6 s using every core. It writes `/tmp/conformance-results.json` and prints one line per suite. Useful options:

```
python3 conformance/run.py                    # everything (pyparse front end)
python3 conformance/run.py --only str_ --show 40
PYJS_PARSER=tree-sitter python3 conformance/run.py   # the old front end
python3 conformance/regress.py OLD.json       # gained / LOST vs. a saved run
bash conformance/diff1.sh string_split ...    # CPython vs pyjs diff per case
```

### Progress on 2026-10-04 (one overnight session)

| Commit | What | Total |
|---|---|---|
| `115ca3b` | pyparse becomes the front end (start) | 377 |
| `8a9b4d3` | str/bytes method checks, `%` formatting | 397 |
| `4c1b7ea` | `unittest`, `platform` | 403 |
| `f90ded4` | generator close/throw/PEP 479, yield-from delegation | 412 |
| `57d370b` | nonlocal in generators, class-body scoping | 416 |
| `1f68320` | `collections` | 425 |
| `b850819` | subclassing builtin types | 429 |
| `0a8e925` | metaclasses | 432 |
| `cb9fd4a` | name mangling, descriptor details | 440 |
| `f5c465b` | async/await | 451 |
| `74b53d0` | symtable SyntaxErrors, static/classmethod dunders | 455 |
| `e5a9911` | many semantics fixes, `__globals__`, `compile(single)` | 478 |
| `88c4ce7` | typed `array`, `struct`, `io.BytesIO` | 500 |
| `e5e3024` | `memoryview`, `weakref`, `gc` | 515 |
| `0152a7e` | `open()` | 525 |
| `f02defa` / `5cafec7` | `os`, `re` | 529 |
| HEAD | big ranges, raw `throw()` to delegates, `__import__`/`__build_class__` | **532** |

The tree-sitter front end scored 370 on the same corpus before these runtime changes.

### What is left

- `micropython/basics/fun_code`: this test calls `types.FunctionType(code, globals)`, which rebinds a compiled function to new globals. Compiled functions close over their module's namespace, so this is not supported. `f.__code__` exists, with the signature fields (`co_varnames`, `co_argcount`, …).
- Reviewed, and not counted as passes:
  - `sys1` checks `sys.implementation.name` against `cpython`/`micropython`; ours is `pyjs`.
  - `weakref_ref_collect` and `weakref_finalize_collect` need `gc.collect()` to free objects deterministically. Weak references are JS `WeakRef`s, so callbacks run whenever V8 collects.

### What changed in the runtime (summary)

**Language**
- `async def`/`await` run as coroutines on JS generators; `async for`/`async with` are desugared in `frontend.ts`.
- Private name mangling.
- Symtable SyntaxErrors (duplicate arguments, global/nonlocal conflicts, unbound nonlocal, walrus rebinding a comprehension variable).
- `nonlocal` inside generators.
- Class-body name resolution.
- `compile(..., "single")`.

**Object model**
- Subclassing `int`/`float`/`str`: the value is boxed, and a hidden MRO entry unboxes for the builtin methods. Equal subclass values are the same dict keys.
- Subclassing `bytes`, `bytearray`, `array`, `map`, `filter`, `zip`, `enumerate`, `reversed`, `property`, `staticmethod`, `classmethod`.
- Metaclasses: `type` subclasses, `__call__`, `__prepare__`, `__instancecheck__`/`__subclasscheck__`, metaclass `__repr__`.
- Descriptor details:
  - set-only descriptors;
  - an AttributeError in `__get__` falls back to `__getattr__`;
  - `object.__delattr__` honors descriptors;
  - staticmethod/classmethod work as special methods.
- A live instance `__dict__`.
- `__new__` is implicitly static.
- Writable `__kwdefaults__`, plus `__globals__` and `__code__`.
- Replaceable `builtins.__import__` and `__build_class__`.

**Generators**
- `close()` throws GeneratorExit.
- PEP 479 (a StopIteration escaping a generator becomes RuntimeError).
- send/throw argument checks.
- `yield from` a generator stays native `yield*`. Other iterators go through an adaptor that forwards send, throw and close.
- StopIteration values are propagated through builtin iterators.

**Builtin types**
- Many str/bytes/format/`%` details.
- Numeric dunders on `int`/`float`.
- Big (>2**53) ranges.
- `slice.indices`.
- Dict `|`.
- Set in-place operators.
- Keyword-only builtin parameters.
- `super()` checks.
- The buffer protocol (bytes, bytearray, array, memoryview).
- `bytes % args`.
- `bytes.hex(sep)`.

**Library, in JS** (`src/runtime/`)
- `array` (typed storage)
- `struct`
- `memoryview`
- `re` (JS RegExp with pattern translation)
- `os`
- `_weakref`
- `gc`
- `types`
- `_fs`
- `sys.stdin`

**Library, in Python** (`lib/`)
- `collections` (deque, namedtuple, OrderedDict, defaultdict, Counter, ChainMap)
- `unittest`
- `platform`
- `io` (IOBase hierarchy, BytesIO)
- `weakref`
- `posixpath`
- `open()` (in `_pyjs_open.py`)

### Performance

The pyperformance programs in `bench/pyperformance` were timed as whole-process runs, `115ca3b` against HEAD, each run twice. Most are unchanged within noise (about ±3%):
- `fannkuch` is about 7% faster.
- `generators` is about 9% slower. Bisecting found no single commit responsible: the slowdown is spread across the generator-semantics work.
- `float`, `nbody` and `nqueens` are 2–4% slower.
