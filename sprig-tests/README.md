# sprig-tests: recorded Mathics3 outputs for Sprig

Sprig is Sagebrush's bracket-notation symbolic mode (the design: `design/sprig-mvp.md`). This directory holds the cases Sprig is compared against, and what the oracle, Mathics3, printed for each one.

- **Case files.** `<area>/test_<n>.sprig` hold cases separated by lines `(*-- <id> *)`. Each case runs on its own, in a fresh session; a case may hold several statements, and its result is the last one's.
- **Recorded outputs.** `<area>/test_<n>.out.json` holds each case's result (`InputForm` text), its `FullForm`, everything it printed (`Print` output and messages, in order), and its messages. These files are written **only** by `python3 sprig-tests/run.py --regen`, which runs each case in a fresh Mathics3 process (`oracle.py`), by hand and never in CI. Any nonzero exit of the oracle, for a case, `--version` or the limits probe, is refused, and then nothing is recorded.
- **Provenance.** `PROVENANCE.json` records the oracle's environment as the oracle printed it (its version and its dependencies', its `Orderless` heads, its limits), its program path and exact arguments, the sha256 of `oracle.py` and `run.py` (a changed driver or recorder means re-recording everything), and the sha256 of every case file and output.
- **Held-out files.** `heldout/<slice>/` holds a slice's held-out file, written and recorded before the slice's code and frozen by its `SHA256SUMS`. A held-out case is never edited; a needed fix becomes a new visible case.
- **Known differences.** `KNOWN.json` lists Sprig's differences from the oracle, by class (design §7.3). Every class but `not-implemented` and `oracle-host-limit` is checked as a value by `checkers.py`.
- **Checkers.** `checkers.py` holds the value checkers (`term-order`, `equivalent-form`, the witness classes, `oracle-host-limit`) and the one normalization of the oracle's text: its `⇾`, `⧴` and `⩵` written as `->`, `:>` and `==`, and its spaced ` ∧ `, ` ∨ `, ` ≠ ` and ` ❘ ` as ` && `, ` || `, ` != ` and ` | `, outside string literals only. They share no code with `lib/_sprig/`. `checker-controls.json` holds their negative controls: cases that must pass and planted wrong answers that must fail, each with the reason it must give.
- **Checks.** `test/sprig-provenance.test.ts` and `run.py --verify` check that every output comes from the oracle and that the held-out files are unchanged. `test/sprig-checkers.test.ts` runs the controls.
- **The replay.** `SCOPE.json` lists the case files Sprig must match, whole files only and never a held-out one; the scope only grows. `test/sprig-corpus-{1..4}.test.ts` run them through Sprig, each case in a fresh session: every case must match the oracle exactly after the normalization, or be listed in `KNOWN.json` and still differ in the same way. A census fails on any non-ASCII character the normalization leaves outside a string, unless its case is listed. `test/sprig-corpus-controls.test.ts` holds the replay's own negative controls.

**Oracle bumps.** A new Mathics3 version re-records everything (`run.py --regen --all`), in one PR that shows the diff.

**Clean room.** Mathics3 is used only as a program: text in, printed output out. No Mathics3 source or documentation is read.

**Plots** aren't in the corpus yet: their results are large sampled `Graphics` expressions, and plotting comes in S6.
