# Replay layer tests: the harness (freeze packet, with make.py and mutants.json)

*Rules: replay-layer r2 PROPOSAL 3973f5ae (grader TESTS CLEAR 52ed9a4a; astra PLAN SECURITY CLEAR 754ff92e and X3 ruling 937c14f9; daybreak2 SIZE CLEAR aa2abd81 → d1ebd732), plus X1–X6.*

## Rows

`python3 -I test/sbdata/make.py DIR` writes, per row, a tree `DIR/<row>/` and `DIR/expected.json`. Each row has:
- `family`;
- `root` and `cwd`, relative to `DIR/<row>/`;
- `program`: the probe prelude plus the row's code;
- `expect`: the exact output line.

**Counts:** A 35, B 61, C 16, D 13, E 22, F 14, for 161 CLI rows, plus H 5, for **166 rows**. G's 7 rows are frozen as deferred for the export lane.

Changes from r2's 158, as the reviews ruled:
- B10 became B10a–e: the GET and HEAD url pairs, plus the derived-key-bound row (X6);
- B28 is new: a manifest url carrying a credential-named parameter is invalid. With it, an HTTPError's `.url` is always credential-free, and E19 checks that it equals the requested clean url;
- C10 became C10a (a FIFO with no writer) and C10b (a FIFO whose writer sends the pinned bytes) (X2);
- C14a/b are new (X3: an outside-root hard link, identical → served, changed → MISS);
- H5 is new (X5).

**The output grammar,** exactly one line per program:
- `KEY <key>`
- `REFUSED <code>`
- `OK <n>`
- `SERVED <sha256> <extra>`
- `URLERROR <code> canary=<0|1>`
- `HTTPERROR <code> <ctype> <sha256> canary=<0|1>`
- or the row's own exact line (E11, E19, E20, F2–F4, F12).

**`URLError.reason`** is `"<code>: <text>"`, with `<code>` one of: `not-pinned`, `no-snapshot`, `outside-root`, `invalid-snapshot`, `invalid-blob`, `url-refused`, `fred`, `header`, `method`.
- The text after `: ` is human-readable and carries only the redacted url.
- `canary` is 1 if `SBCANARY0123456789abcdef` appears in `str(e)`, `repr(e)`, `.reason`, `.url`, `.filename` or `repr(.args)`.
- M1 writes no log lines.

**Running a row:**
```
node --import test/sbdata/spy.mjs dist/src/cli.js --data-root DIR/<row>/<root> -c "<program>"
```
- It runs with cwd = `DIR/<row>/<cwd>`, a fresh process per row, under ptest.
- The row's FIFO writer (C10b) is started by the test before the run and killed after it.
- **PASS** means stdout's last line == `expect` exactly, rc 0, and the spy shows 0 network records.

## The time bound (X2)

Each row has a **5 s** wall-clock deadline in the test, using setsid and a SIGKILL of the group, as in the scipy.special controls. A row that hits the deadline is a FAIL, with the elapsed time recorded.
- **C10a**, a FIFO with no writer, can only fail by the deadline. That is how `M-nonblock-dropped` fails, since a blocking open of a FIFO hangs.
- **C10b**, a FIFO with a writer, fails by value under `M-regular-file`: it is SERVED, where the expected outcome is MISS.

## The spy (§4 of r2; astra; grader R7/H3)

`test/sbdata/spy.mjs`, loaded with `--import`. Node passes execArgv to Worker threads, so it installs in the main realm and in the worker that runs Python. In each realm it:
- records `threadId`;
- replaces `globalThis.fetch`, `globalThis.XMLHttpRequest` and `globalThis.__SAGEBRUSH_FETCH_SYNC__` with throwing recorders;
- wraps `process.getBuiltinModule` so that `http`, `https`, `http2`, `net`, `tls`, `dgram`, `dns` and `undici` (with or without `node:`) throw and record;
- appends its records to `$SB_SPY_DIR/<pid>-<threadId>.jsonl`.

**Positive control:** at install, each realm calls `fetch('http://spy.invalid/')` itself and records it as `positive`.

This spy does not make the runtime a general network sandbox (astra).

## The H rows

| id | check | expected |
|---|---|---|
| H1 | the import allowlist of `lib/_sbdata.py`, `lib/urllib/request.py` and `lib/urllib/error.py`, parsed with CPython `ast` in the test runner | every import ∈ {`_fs`, `os`, `io`, `re`, `hashlib`, `urllib.parse`, `urllib.error`, `_sbdata`} |
| H2 | the spy records of every row | a realm with threadId 0 AND a realm with threadId ≥ 1 per run |
| H3 | the positive records | exactly 1 `positive` per realm per run |
| H4 | network records beyond H3's | 0 for every row |
| H5 | `_test_after_verify` in the production sources (CPython `ast` over lib/_sbdata.py and lib/urllib/*.py) | appears only as the one module-level assignment `_test_after_verify = None` in _sbdata.py; no Call node references it |

## Mutants (X1, X4)

`mutants.json` holds each mutant's exact FAIL set. Every unlisted row must PASS.

**Anchors:** `mutations.tsv` is written against the code once it exists, and comes to the grader before the counted run. Each anchor occurs exactly once.

**The load check (X4):** for each mutant, before its rows,
```
node dist/src/cli.js -c "import _sbdata, urllib.request, urllib.error, urllib.parse"
```
must exit 0. A failure voids the mutant and is a **STOP**.

## Fail-first

At base a931ee43, every A–F row fails at import (`ModuleNotFoundError: No module named 'urllib'` or `'_sbdata'`). H1 and H5 fail (no files). H2–H4 pass, since the spy is independent of the change. `--data-root` is unknown to the base CLI, which exits with its usage error: the rows still fail.

## Pins

- `make.py`, `mutants.json` and `HARNESS.md` are listed by sha256 in the packet's SHA256SUMS.
- `fixtures-manifest.txt` lists every file the generator writes (path, type, size and sha256; symlink targets; FIFOs by type), with its sha256 in SHA256SUMS. A fixture change shows up as a different manifest.
