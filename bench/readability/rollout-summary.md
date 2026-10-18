# Agent readability pilot and three-module rollout

Four bounded slices now have frozen before/after comprehension measurements and
exact behavior comparisons. The number-field pilot and Magma maps are merged.
Builtin iterators are merged as `886e34f5`. MATLAB
argument validation has passed its fixed corpus, focused tests and full CI; both
code reviews are clear and the final evidence is ready for integration.

## Measurements

Each row uses its own ten fixed questions and answer key, three fresh Haiku
runs per question per phase. Every criterion is binary; compound criteria need
all their claims. These are coverage counts, not calibrated factual-accuracy
probabilities, and scores from different rows do not rank the modules.

| Slice | Covered criteria, before → after | Complete answers, before → after | Median seconds, before → after | Exact behavior corpus |
| --- | ---: | ---: | ---: | ---: |
| Number-field class groups | 53/90 → 62/90 | 6/30 → 9/30 | 46.41 → 43.85 | 801/801 |
| Magma maps | 53/90 → 57/90 | 2/30 → 7/30 | 28.12 → 27.55 | 174/174 |
| Python builtin iterators | 72/90 → 79/90 | 16/30 → 21/30 | 31.23 → 26.87 | 304/304 |
| MATLAB arguments and validators | 66/90 → 73/90 | 15/30 → 16/30 | 26.49 → 23.86 | 748/748 |

The model was `claude-haiku-4-5-20251001`, using read-only source projections
without the answer key, Git history, review files or previous sessions. Time is
per CLI process with three concurrent runs, not isolated inference latency.
Token and tool counts, individual answers and grading notes are in each slice's
results directory. The implementing agent manually graded both phases; grading
was neither blind nor independent. Three samples give an observed range, not
statistical certainty. Superseded and comment-followup measurements are labelled
separately in the detailed reports, never substituted into the primary score.

## What changed

- Number fields: explicit general-BNF configuration, separate setup/relation/unit
  stages, mathematical vocabulary and named existing budgets. Numerical
  algorithms, retry caps and certificate policy were preserved.
- Magma maps: separate graph normalization/validation and set-image construction,
  with descriptive names and explicit evaluation order.
- Builtin iterators: internal exhaustion vocabulary, named enumerate cutoff,
  shared strict-keyword parsing with the original validation order, and clearer
  callback/consumption timing. Two native diagnostic local names were retained.
- MATLAB arguments: separate declared-class admission and shape conversion,
  vector-reshape eligibility, and comments for representation/empty-value rules.
  Existing permissive or incomplete behavior was kept outside the refactor.

The most useful explanations expose an operation boundary: class admission
before a general converter, conversion before dimensions, or internal exhaustion
before Python exception translation. The MATLAB string-admission error occurred
in all three baseline answers and none of the three after answers. Matching-size
reshaping and empty-input evaluation became clearer in the after answers.

Comments do not ensure comprehension. Two final iterator answers still put a
post-decrement after the getter call despite quoting a comment that says it
happens before. Several answers in both phases omit small error-routing details;
those omissions can change a compound criterion's score without a new semantic
mistake. Raw answers retain additional errors outside the frozen criteria.

## Evidence and integration

| Slice | Validated executable revision | Full CI |
| --- | --- | --- |
| Number fields | `5cee68f16` | All passed; final comments/evidence merged as `b1859ef4` |
| Magma maps | `359723b55` | All passed; final comments/evidence merged as `23526b2c` |
| Builtin iterators | `2fb25571e` | All passed; final evidence merged as `886e34f5` |
| MATLAB arguments | `0f17e46d` | All passed; final evidence ready for integration |

Behavior and limits/refusal reviews are clear for all four executable slices.
MATLAB exact-head corpus evidence is accepted and its full CI has passed. Existing CI retries resolved concurrent-run
failures; the detailed reports preserve their logs and exact RESULT lines.

No all-program invariance claim is made for native internal stack locations:
line/column references move with source edits. The recorded corpora compare
input source, decoded outputs, status and timeout flags exactly (excluding only
elapsed seconds). The iterator probes additionally retain the existing native
cause strings. Existing correctness issues discovered along the way were sent
to the relevant owner as separate work.

Detailed reports: [number fields](report.md), [Magma maps](magma-maps/report.md),
[builtin iterators](builtin-iterators/report.md), and
[MATLAB arguments](matlab-arguments/report.md). The coding guide is
[docs/agent-readable-code.md](../../docs/agent-readable-code.md).
