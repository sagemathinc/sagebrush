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
- **PASS** means stdout's last line == `expect` exactly, the exit status 0 and no signal (the test's `checkRun` asserts both: grader's runRow ruling on 5da953fe), and the spy shows 0 network records.

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
| H6 | F1's program printing F1's exact line, then `sys.exit(1)` (H6a) or a `raise` (H6b) | the row check (`checkRun`) FAILS on the exit status for both |

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

## The review fixes on 5da953fe (family R, 51 rows)

The reviews: astra RP-SEC-1/2, astra3 RP-CODE-1/2/3, daybreak3 LIMIT-M1-1, and the grader's row rulings. With them, the counts are A 35, B 61, C 16, D 14, E 22, F 14 and R 51, for **213 CLI rows**. The H tests are seven: H1, H2, H2b, H3, H4, H5 and H6. That makes **220 tests**, and the DEV TAP's `# tests` line must show exactly that.

- **R1–R5:** `_fs.lstat_kind` is `none` only for ENOENT. Any other error is `error`.
  - R1 is EACCES: a directory with no search permission. It holds only for a non-root user. As root, the row FAILS; it never skips.
  - R2 is ELOOP: a symlink loop as an intermediate component.
  - R3 is ENOTDIR: a path through a regular file.
  - R4 is the ENOENT control.
  - R5 is the ancestor control. The nearest marker's inspection errors (via the real helper, on an ELOOP path) while a valid snapshot sits above it, and the result is `invalid-snapshot`, never the ancestor's bytes.
- **R6–R15:** numbers and ports accept ASCII digits only.
  - R6–R11: the manifest's version, revision and size each written as ONE non-ASCII digit, an Arabic-Indic `٣` or a superscript `²`. The value starts with it, so these reach the number-start check.
  - R12–R15: `٣`, `²`, a fullwidth `１` and `٣٣` in a port. The ASCII gate refuses these first, so the port's ASCII-digit check is defense in depth.
- **R16–R31:** `_fs.read_nofollow`'s `max` must be an integer in 0..50,000,000, checked natively before any open.
  - The boundary rows: 0, a file of exactly max bytes vs one of max+1, and 50,000,000 vs 50,000,001.
  - The invalid values: -1, 1.5, `10**30`, `'x'`, True, None, nan, inf and -inf.
  - R30 is the no-open witness: a missing path with an over-ceiling max gives `bad-max` (without the check, it would give `unreadable`). R31 is the missing-path control.
- **R42, R47–R51** (grader P2, after astra3's correction): mixed manifest numbers, an ASCII first digit and then a non-ASCII one, so the number LOOP meets it. `1٣` in version (R42), revision (R49) and size (R51); `1²` in version (R48), revision (R50) and size (R47). **R43–R46**: direct calls past the ASCII gate: `_authority('http', 'h:٣' / 'h:²' / 'h:１')` (R43–R45) and `_host('a.٣')` (R46). Each DIGITS line, by trace:
  - the port line is killed by R43–R45;
  - the number-loop line alone is killed by R42, R49 and R51 under both isdigit and isdecimal (13 gives a wrong value or `OK 1`), and by R47, R48 and R50 under isdigit only (int raises: a crash, which fails under rc). R6–R11 never reach the loop: the start check refuses them first;
  - the number-start line alone is EQUIVALENT: with it mutated alone, `number()` scans zero ASCII digits and refuses as not-json, the same result. Under the full mutant, it and the loop together kill R6–R11;
  - the IP last-label line alone is EQUIVALENT: `_LABEL` (`[a-z0-9]`, ASCII only) refuses a non-ASCII label first, which R46 pins.
- **R32–R41:** an escaped lone or reversed surrogate in a url, an entry key or a meta field is `REFUSED surrogate` by the parser, never an uncaught `UnicodeEncodeError`.
  - R40 is the valid-pair control: the pair in a meta field gives `OK 1`.
  - R41 is a valid pair in a url, which is refused cleanly as `bad-value:url`.

New mutants:
- `M-lstat-enoent-dropped`;
- `M-isdigit-restored` and `M-isdecimal`;
- `M-read-max-unchecked`;
- `M-surrogate-check-removed`;
- `M-rc-unchecked`, which fails H6.

Re-anchored: `M-ip-literal`, `M-port-range` and `M-cap-file-bytes` (whose read is now `ENTRY_CAP`, inside the native ceiling). The sets in mutants.json are traced by reading only: no DEV cross-check has run on this head yet. All 66 sets and the fail-first are to be re-derived with the exit status in force, and any set change will be reported with its trace before the freeze.
