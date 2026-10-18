# Number-field readability pilot

The frozen `questions.json` contains ten questions and three binary rubric
criteria per question. Commit the key and this harness before editing the
implementation. Run each question three times, before and after, using
`claude-haiku-4-5-20251001` through the existing subscription CLI login.

```
python3 bench/readability/run.py --sha COMMIT \
  --out /scratch/readability-results/before \
  --work /scratch/readability-sessions --jobs 3
```

Run the harness in a project terminal. It follows the existing L1 evaluation
driver's fresh-process, transcript and wall-time pattern. It exports only the
listed source paths at the exact commit, read-only, into a new directory for
each question. It includes dependencies needed to trace certification, but no
git metadata, answers, benchmark files, documentation, review files or memory.
The same source-path selection applies before and after; newly extracted source
files are included in the recorded per-commit manifest. Safe mode disables CLI
customizations; only Read, Glob and Grep tools are exposed. No fallback model,
resume, or retry is used. A timeout/error is recorded as such, never replaced by
a more favorable answer. Source hashes and the frozen key hash are recorded.

Grade final answers against each committed criterion: 1 for correct and
sufficient, 0 for missing, wrong or contradicted. Save the three scores and a
short justification per answer. Report both total criterion accuracy (out of
90) and fully covered answers (out of 30). Cite identifiers of factual errors;
do not grade style or require the original function names after refactoring.
Report medians and ranges per question for wall time, tool calls, output tokens,
and input tokens including cache reads/writes. Keep raw usage fields so cached
tokens are not mistaken for reduced reading. Three repetitions reveal some
noise but are not a statistically conclusive model-performance study.

The model sees only the question, not its criteria. The human-readable answer
key stays fixed even if a baseline answer exposes a misleading existing comment.
Do not modify the tested implementation until all baseline runs have finished.
Corpus/build/CI work runs on the test VMs, not in the shared project.

The completed pilot is described in [report.md](report.md). The graded answers,
raw token-usage fields and source manifests are in [results/](results/).
Recompute the measurement tables without model calls:

```sh
python3 bench/readability/summarize.py --out bench/readability/results/summary.json \
  --markdown bench/readability/results/metrics.md
```

`make_corpus.py` fixes seed `20261018`, takes the 300 existing proof-fixture
fields, adds 24 monic inputs of each degree 3 through 6, the README's named
cubic, and a linear case. Both BNF operations plus five admission checks produce
801 requests. Random reducible polynomials are retained to compare refusals.
The original 30 random README benchmark fields were never saved; this corpus
is a reproducible replacement, not a reconstruction of those missing inputs.

On a VM, build the small JSON dispatcher driver and run each revision into a
separate output directory. It preserves `assumes` and unconditional-certificate
metadata in addition to the fields printed by `examples/bnf.rs`.

```sh
cargo build --release --locked --manifest-path bench/readability/corpus/Cargo.toml
python3 bench/readability/corpus.py --sha COMMIT \
  --binary bench/readability/corpus/target/release/readability-corpus \
  --out /home/user/readability-before
python3 bench/readability/corpus.py --compare \
  /home/user/readability-before /home/user/readability-after
```

The driver removes `QCL_*` settings from each child process so the comparison
tests ordinary defaults. Set `--sha` to the revision actually built; it is
provenance supplied by the runner, not binary introspection. The complete
baseline responses are committed in `results/corpus-baseline.json`.

`read_traffic.py` counts source-path mentions in read-like tool calls from local
Codex transcripts. This is a ranking proxy, not exact file-open telemetry. It
emits only tracked paths, aggregate counts and file sizes, not transcript text.
The pilot's fixed window ends before its implementation work began:

```sh
python3 bench/readability/read_traffic.py --sessions /path/to/codex/sessions \
  --session-cwd /path/to/project \
  --repo . --since 2026-10-17T00:00:00 --until 2026-10-18T02:00:00 \
  --out bench/readability/results/read-traffic.json
```
