# Curated PyPI packages

Sagebrush carries a short, curated list of pure-Python packages from PyPI
(William, Oct 16: "a curated PyPI allowlist, which users can easily search").
Each one is a Sagebrush package, `packages/pypi-<name>/`, imported on first use
in Python and Sage mode, like any other package (packages/registry.json,
src/compile.ts).

## What a curated package is

- **One pinned wheel.** The package's `sagebrush.json` records the wheel's URL
  on files.pythonhosted.org and its SHA-256 (`source.pypi`).
  - `scripts/pypi-import.mjs PROJECT VERSION` downloads it, checks the hash
    and every file against the wheel's RECORD, and writes the package. Only a
    pure-Python wheel (`*-none-any`) with Python sources is accepted.
  - The sources are committed, unchanged, so a reviewer reads exactly the
    bytes a build loads, and builds stay offline.
  - `node scripts/pypi-import.mjs --check` (CI) re-derives every committed
    package from its pinned wheel and fails on any difference. It also checks
    the license notices and that web/llms.txt names the package.
- **Permissive licenses only**: MIT, BSD, Apache-2.0, ISC or PSF. The license
  goes into NOTICE.md (generated) and the third-party notices of every
  distribution that carries the library.
- **No C extensions and no third-party JavaScript.** Where a project has C
  speedups whose pure-Python path differs, it is left out.

## Tested before it is listed

`pypi-tests/<name>/` holds the project's own test suite, copied unchanged from
its source at the release (SOURCE.json pins the archive's URL and SHA-256, and
each file's). `python3 pypi-tests/run.py` runs it under CPython 3.14 and under
Sagebrush with pypi-tests/harness.py, one line per test:

- CPython must print the committed `expected.out`;
- Sagebrush must print exactly the same, but for its known differences;
- each must exit 0 with nothing on stderr (the harness writes only its
  records, to stdout), `--refresh` included: a crash or fatal error after
  the expected records fails the run;
- traceback presentation is not compared: a package file's path (the
  repository's, or the CLI bundle's), and CPython's caret lines.

**A package whose tests do not all agree is not listed.** Unimplemented means
an error, never a wrong answer.

## Known differences

Sometimes a test cannot pass anywhere but CPython, whatever Sagebrush does.
`test_ref_counts` lists CPython's heap with `gc.get_objects()`, which a
JavaScript engine cannot provide. Such a test may be listed in
`packages/pypi-<name>/known.json`:

```json
{"tests": [{"test": "module.test_function", "error": "AttributeError", "message": "module 'gc' has no attribute 'get_objects'", "reason": "in plain words"}]}
```

The coordinator's conditions (Oct 17):
- **Exactly that failure.** The runner requires Sagebrush's result for each
  listed test to be exactly that failure, where CPython passes: its line
  `module.test_function: FAIL <error>: <message>`, the exception type and
  its message's first line as the harness prints them. A failure of the
  same type with another message fails the run. It is an error, never a
  wrong answer.
- **Nothing else.** Any other difference fails the run. So does a known test
  that starts passing, so that its entry gets removed.
- **Visible.** The package's search entry shows each known difference in
  plain words (`sagebrush --search <name>`, lib/_python_docsearch.py).
- **Reviewed.** Reviewers check every known.json entry.

## Adding a package

1. `node scripts/pypi-import.mjs PROJECT VERSION [SPDX]` (SPDX when PyPI's
   license metadata is not one of the plain names), then `node scripts/packages.mjs`.
2. Copy its upstream tests into `pypi-tests/<name>/upstream/` with SOURCE.json,
   and its LICENSE. Write expected.out with `python3 pypi-tests/run.py --refresh <name>`.
3. `python3 pypi-tests/run.py <name>` must agree. Fix Sagebrush, or list a
   known difference only when no Sagebrush could pass it.
4. Name it in web/llms.txt with its version, and send it for review:
   correctness (fidelity), and provenance, licenses and the supply chain.
