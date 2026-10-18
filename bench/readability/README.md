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
The same path manifest applies before and after. Safe mode disables CLI
customizations; only Read, Glob and Grep tools are exposed. No fallback model,
resume, or retry is used. A timeout/error is recorded as such, never replaced by
a more favorable answer. Source hashes and the frozen key hash are recorded.

Grade final answers against each committed criterion: 1 for correct and
sufficient, 0 for missing, wrong or contradicted. Save the three scores and a
short justification per answer. Report both total criterion accuracy (out of
90) and fully correct answers (out of 30). Cite identifiers of factual errors;
do not grade style or require the original function names after refactoring.
Report medians and ranges per question for wall time, tool calls, output tokens,
and input tokens including cache reads/writes. Keep raw usage fields so cached
tokens are not mistaken for reduced reading. Three repetitions reveal some
noise but are not a statistically conclusive model-performance study.

The model sees only the question, not its criteria. The human-readable answer
key stays fixed even if a baseline answer exposes a misleading existing comment.
Do not modify the tested implementation until all baseline runs have finished.
Corpus/build/CI work runs on the test VMs, not in the shared project.
