# rill-tests: recorded R outputs for Rill

Rill is Sagebrush's R mode (design/rill.md). This directory holds the cases Rill is compared against, and what real R printed for each one.

- **Case files.** `<area>/test_<n>.R` hold cases separated by lines `#-- <id>`. Each case runs on its own, in a fresh R session.
- **Recorded outputs.** `<area>/test_<n>.out.json` holds each case's stdout, stderr and exit status. These files are written **only** by `python3 rill-tests/run.py --regen`, which runs the cases in R 4.5.3 on the oracle host (VM4) as a black box, with a pinned environment: `LC_ALL=C.UTF-8`, `TZ=UTC`, `width = 80`, `digits = 7`.
- **Provenance.** `PROVENANCE.json` records the oracle's environment, as printed from inside the runs, and the sha256 of every case file and output.
- **Held-out files.** `heldout/<phase>/` holds held-out files. Each is written and recorded before its phase's code, and frozen by its `SHA256SUMS`. A held-out case is never edited; a needed fix becomes a new visible case.
- **Checks.** `test/rill-provenance.test.ts` and `run.py --verify` check that every output comes from the oracle and that the held-out files are unchanged. Replaying the cases through Rill starts with phase A1.

**Oracle bumps.** A new R version re-records everything (`run.py --regen --all`), in one PR that shows the diff.

**Clean room.** R is used only by calling functions and recording what they print. No R source is read, and no function's code is printed.
