# pyparse: CPython's parser, generated in TypeScript

A Python 3.14 parser for JavaScript engines, generated from **CPython's own
grammar and actions**. It produces the same AST as `ast.parse`, with every
position identical, and the same `SyntaxError`s: type, message, line,
offset and end position. It is the front end for the browser and agent-artifact
version of Sagebrush, and it replaces tree-sitter in the pyjs spike.

```ts
import { parse, PegenError } from "./src/index";
try {
  const tree = parse("x = [1, 2 3]\n");
} catch (e) {
  // e.info: { type: "SyntaxError", msg: "invalid syntax. Perhaps you forgot a comma?",
  //           lineno: 1, offset: 6, end_lineno: 1, end_offset: 11, text: ... }
}
```

## Results (2026-10-04)

| Corpus | Identical to CPython 3.14 |
|---|---|
| Standard library (`/usr/lib/python3.14`) | **628 / 628** ASTs |
| site-packages: numpy, pandas, matplotlib, pyarrow, IPython, ... | **4327 / 4327** ASTs |
| Sage library | **2594 / 2594** ASTs |
| CPython's `Lib/test/test_syntax.py` | **463 / 463** syntax errors, 126 / 126 valid snippets |

The checks are `test/compare_stdlib.py` and `test/compare_errors.py`. Both
sides dump canonical JSON with every field, every position and type-tagged
constants (floats compared bit for bit), and the hashes are compared.

| | pyparse | tree-sitter (previous front end) | CPython (C) |
|---|---|---|---|
| Size | **222 KB minified, 36 KB gzipped** (plus an optional lazily loaded 220 KB Unicode-name table, used only for `\N{...}`) | 146 KB gzipped (WASM), plus a lowering pass | — |
| Parse `_pydecimal.py` (6,400 lines), warm | 46 ms | 38 ms parse + about 20 ms lowering | 19 ms |
| Output | CPython's AST and SyntaxErrors | a concrete syntax tree with generic ERROR nodes | — |

On error messages, the spike with tree-sitter printed `SyntaxError: invalid syntax` with no location for
`x = [1, 2 3]`. It even **ran** a program missing an indented block, because
tree-sitter's error recovery silently repaired it. pyparse matches CPython
on all of `test_syntax.py`.

## How it is built

`gen/build.py` (Python, build time only) reads `vendor/cpython`, which holds
the files from CPython v3.14.4 under the PSF license:

| Input | Output | What it is |
|---|---|---|
| `Grammar/Tokens` | `src/tokens.gen.ts` | token numbers and operator tables |
| `Parser/Python.asdl` | `src/ast.gen.ts` | `_PyAST_*` node constructors; nodes are `{_type, ...fields}`, sequences never null |
| `Grammar/python.gram` | `src/parser.gen.ts` | 13k lines, 445 rule functions |

The parser generator is a TypeScript back end for pegen that mirrors its C
back end: memoization, left recursion, cut, lookahead, and `invalid_*` rules
gated on the second pass. The grammar's C actions are translated
mechanically to TypeScript:

- casts dropped;
- `e->v.Name.id` becomes `e.id`;
- `EXTRA` becomes a location tuple;
- `RAISE_*` and `CHECK*` macros become functions.

The rest is ported by hand:

| File | Ports | Lines |
|---|---|---|
| `src/lexer.ts` | `Parser/lexer/lexer.c`, byte-based so columns are CPython's UTF-8 offsets; includes f-/t-string modes and CPython's tokenizer error messages | 1051 |
| `src/pegen.ts` | `pegen.c` and `pegen_errors.c`: the two-pass `run_parser`, error locations, and the tokenizer-error priority rules | 448 |
| `src/helpers.ts` | `action_helpers.c` and `string_parser.c` | 637 |

```sh
python3 gen/build.py && python3 gen/unames.py   # regenerate
../node_modules/.bin/tsc -p .                   # compile (TypeScript 7: ~0.3 s)
python3 test/compare_stdlib.py /usr/lib/python3.14
python3 test/compare_errors.py ~/data/cpython-src/Lib/test/test_syntax.py
```

Upgrading to a new CPython release means re-vendoring four files and
regenerating; the hand-ported parts change rarely.

## Bugs the corpora found

- **Null sequences:** C's `NULL` for an empty sequence had to become `[]`.
- **`constructor`:** a Python name was taken for a keyword through `Object.prototype` (`KEYWORDS["constructor"]`).
- **The NUL byte:** CPython counts the C string's terminating NUL when an error offset points just past a line.
- **`\N{...}`:** named escapes needed a Unicode name table.

## Not yet

- Type comments (`PyCF_TYPE_COMMENTS`), interactive and eval modes, and `feature_version`.
- Warnings: invalid escape sequences and numeric literals followed by keywords.
- The `-X` byte-offset quirks of non-UTF-8 source encodings.
- Performance work. The obvious candidates are allocating fewer closures in lookahead, decoding token text lazily, and specializing `expect` for keywords.
- A Sage dialect grammar (from sagejs's tree-sitter-sage) and Magma, in the same pegen notation.
