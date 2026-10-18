# Number-field readability pilot

The refactor preserved every output in the 801-request corpus and produced a
modest improvement in the cold Haiku comprehension test. Frozen-rubric coverage
rose from **53/90 (58.9%) to 62/90 (68.9%)**. Fully covered answers rose from
**6/30 to 9/30**. The result does not establish a general reduction in reading
cost: median time improved slightly, median processed input increased, and tool
calls were essentially unchanged. Two questions regressed by one point each.

Branch: `agent-readable-number-fields`. Baseline code:
`accfd3d73961fd477c6b107a45add9bd62634e56`. Measured refactor:
`5cee68f1676d0168ad13a6da538b409be74a8020`.
The question/key/harness commit `44c4413c` preceded all implementation changes.
The code was not changed until the baseline runs had completed.

## What changed

The general BNF entry point now takes explicit `BnfConfig` values. Ordinary
`bnfinit`/`bnfinit_with` callers use its default. The old general-BNF environment
choices are available only through an explicitly called, debug-only adapter.
Field setup, relation gathering, unit-lattice helpers and tests have named
modules. The orchestration names the field/order, embeddings, generating
columns and class-number/regulator estimate. A glossary and named constants
explain the mathematical representations, empirical budgets and precision.

`bnf.rs` went from 1,373 to 883 lines at the measured revision. Its 203-line
`bnfinit_with` became a three-line compatibility wrapper around a 73-line
orchestrator; `try_units` went from 183 to 138 lines. Extraction adds module
boundaries and documentation rather than reducing total source volume.
The Rust API centralizes public result conversion, retaining the fixed-point
regulator string. Python separates the unconditional-certificate cache from
the independent quadratic cross-checks. Both maintained package copies agree.

Search order, arithmetic, bounds, retries and result representations are
unchanged under the ordinary defaults. The intentional configuration change
is limited to settings migrated from the general BNF body. Quadratic
`QCL_DEBUG`/`QCL_NOCERT` and embedding `QCL_LLLITER` remain follow-up work;
the whole engine does not yet ignore environment settings.

## Comprehension measurement

The pinned model was `claude-haiku-4-5-20251001`. Each of ten questions ran
three times per revision, in independent processes with a fresh read-only
source projection. The agents saw the question and source files, including
dependencies needed to trace the certificate. They did not see the answer key,
git history, reviews, memory notes or benchmark documents. All 60 runs completed
on the requested model without timeouts, errors, retries or fallback models.
The frozen key hash is
`cd77f64e2ec2f9894f88bc63f2bdabbb7845ad943f20695dc8c284e81bc7e4d6`.

Each question has three compound criteria. A criterion receives one point only
when all its claims are correct and covered; an omission or contradiction
receives zero. This is deliberately stricter than getting the main point right.
It is a coverage measure, not a claim that 68.9% of answers are entirely correct.
The same author graded both conditions with the frozen key, so this is not a
blinded independent grading study. Three repetitions show variability but do
not support a statistical claim about a small difference.

| Measure | Before | After |
| --- | ---: | ---: |
| Covered criteria | 53/90 | 62/90 |
| Fully covered answers | 6/30 | 9/30 |
| Median wall time per answer | 46.4 seconds | 43.9 seconds |
| Sum of per-answer wall times | 1,457.6 seconds | 1,394.1 seconds |
| Median tool calls | 13 | 14 |
| Total tool calls | 439 | 443 |
| Median processed input tokens | 326,714.5 | 342,186 |
| Total processed input tokens | 13,266,039 | 12,063,592 |
| Total output tokens | 125,013 | 119,796 |

Input tokens include uncached input, cache creation and cache reads over all
model calls; they are not unique source tokens. Time includes CLI startup,
tools and service latency. Three processes ran concurrently, so sums are not
elapsed experiment duration. [Per-question medians and ranges](results/metrics.md)
and [machine-readable summaries](results/summary.json) retain the detail.
[Before answers](results/before.json) and [after answers](results/after.json)
include every answer, raw usage, score and grading note.

The clearest gain is Q05, relation-gathering order: **1/9 to 6/9**. Before,
two runs answered for the quadratic sieve instead of the general number-field
collector, and the third mixed the paths. After, all three located the general
collector. Q02, changing the factor-base bound, rose from 8/9 to 9/9 and its
median time fell from 50.4 to 34.6 seconds. Naming the config and collection
stages appears useful, although this pilot cannot isolate names from splitting
or additional comments.

The failures remain instructive. Q04 failure routing fell from 6/9 to 5/9:
after run 2 incorrectly associated `proof=True` with the ordinary estimate
refusal. Q06 regulator conversion fell from 5/9 to 4/9: after run 2 confused
the determinant's intermediate scale with the returned fixed-point regulator.
Q09 still scored 5/9; one after answer put extra-prime generating columns in
the wrong factor-base pass. Several other lost points are omissions, such as
sorting/deduplication, cached refusal messages and the small-value notation
threshold. These are retained in the grading notes, not hidden by the total.

### Follow-up on the two regressions

All six regulator runs reached the formatter. The incorrect after run read
both the stored fields and the determinant conversion, so the move did not
make the relevant source inaccessible. The field's pre-existing terse comment
left the representation implicit. Failure-routing after run 2 used broad
Python reads and grep results, without reading the general BNF body; the other
two after runs traced the separate unconditional path correctly. Every before
and after answer omitted the complete two-retry rule. That omission is not a
new regression caused by the extraction.

One-point differences with three runs are consistent with sampling noise; the
traces do not establish causation. They do justify clearer local explanations.
Comment-only follow-up `45645849` states that the returned regulator is
`reg_fixed / 2^prec` after the determinant's scaling has been removed, identifies
the separate `proof=True` route, states the precision-retry cap and points from
the conversion wrapper to the notation threshold. It changes no executable
logic. The original before/after result above remains pinned to `5cee68f1`.
Six further cold runs, using the same two questions and rubric, completed on
the comment-only revision. Q04 scored **6/9** and Q06 **8/9**, compared with
5/9 and 4/9 at the measured refactor. All three now described the separate
unconditional route and the correct returned fixed-point scale; omissions
still lost points. These selected follow-up questions were chosen after
inspecting the primary answers, so this is exploratory evidence, not a new
independent before/after result. [The six answers and grades](results/comment-followup.json)
remain separate from the original 60 runs.

## Behavior evidence

The fixed corpus has 398 polynomial inputs: all 300 existing proof-fixture
fields, 24 seeded monic inputs of each degree 3 through 6, the README's named
cubic $x^3-11$, and a linear case. Both `bnf` and `bnf_certify` run on each,
plus five explicit admission/refusal cases, for 801 requests. Seed `20261018`
and the generator are committed. Reducible random inputs remain in the corpus
to check refusals. The original README table's 30 random fields were not saved;
this is a documented replacement rather than a claimed replay of those fields.

The standalone Rust driver calls the real JSON dispatcher, preserving the
class group, discriminant, regulator string, roots of unity, certification,
factor-base/relation counts, assumptions and unconditional-certificate metadata.
This includes more public evidence than the timing-oriented example driver.
All child processes have `QCL_*` removed to compare ordinary defaults.

**All 801 responses were identical**, with no timeouts or missing cases.
Raw stdout, stderr and exit codes also matched. Regulator strings matched in
full, exceeding the requested 12-digit comparison. An unchanged second
baseline run also matched all 801 outputs. There were 778 successful responses
and 23 identical error responses, including reducibility and certificate limits.
This establishes equality on the corpus, not a proof for all number fields.

The complete expected responses are committed in
[corpus-baseline.json](results/corpus-baseline.json). The corpus checksum is
`6306a02d5e395ac52ff3d42e884c1b9658d260b0a10d8bc049fa48157d2d5e9f`.
The source projections and hashes are recorded in
[before-sources.json](results/before-sources.json) and
[after-sources.json](results/after-sources.json).

Validation on `sagebrush-2` at `5cee68f1`:

- Classgroup tests: 63 passed, two existing ignored tests.
- Python proof-routing tests: six passed.
- New-comment lint tests: six passed; the branch's new comments pass the lint.
- Full `sbremote` CI: **all passed** on the measured `5cee68f1` code. The isolated
  npm test rerun passed 915 tests, and all 83 browser commands passed. Two
  timing-sensitive npm tests and four browser commands initially failed under
  concurrent load and passed the runner's automatic isolated retries.
- Behavior review and numerical-limits/certificate review: code clear on
  `5cee68f1`; the numerical review also confirmed its clear carries over the
  comment-only `45645849` follow-up.

The exact full-CI result is:

```text
RESULT 5cee68f16: all passed (any crowd failures passed alone)
```

[The complete stage log](results/full-ci.txt) and
[validation metadata](results/validation.json) record the tested revision.
The later production-source delta is only full comment lines and one blank
line; removing those lines gives identical source in every changed Rust/Python
file. The final evidence commit adds benchmark results, reporting utilities and
documentation, with no further production-source edits. Full CI was not rerun
for those documentation changes.

Full run evidence is retained in `/scratch/sagebrush-reviews/readability/` and
the CI log at `/scratch/sagebrush-reviews/readability-full-ci.log` in the shared
project. The committed results retain the portable answers, usage, expected
outputs and source hashes. No numerical changes followed the measured refactor.

## Next three modules

The ranking uses source-path mentions in read-like Codex tool calls from
2026-10-17 00:00 UTC to 2026-10-18 02:00 UTC, scoped to sessions opened in this
project and excluding this pilot's commands. It matched 1,218 calls. Mixed
commands and broad searches make this a proxy for demand, not exact file-open
telemetry. It omits other agent runtimes. Sizes are at `5cee68f1`; only aggregate
paths, counts and sizes are retained in [read-traffic.json](results/read-traffic.json).

| Rank | Module | Read-like calls | Sessions | Lines | First bounded pilot |
| --- | --- | ---: | ---: | ---: | --- |
| 1 | `lib/_magma.py` | 137 | 3 | 8,979 | Sequence/set universe inference and coercion; glossary and explicit empty-container rules. |
| 2 | `src/runtime/types.ts` | 129 | 4 | 3,873 | Type construction and descriptor registration; explain admission, binding and initialization order. |
| 3 | `lib/_matlab.py` | 122 | 3 | 12,241 | Array representation and numeric conversion; document transposed storage and precision boundaries. |

Start with these bounded paths, not whole-file rewrites. Agree the exact frozen
revision and ownership with each module owner before branching so current fixes
can land first. For MATLAB, retain startup/parse-memory measurements as well as
behavior checks; moving Python code between eagerly loaded modules can change
cost without changing mathematical answers. Repeat the fixed-question and
identical-output method, with narrower compound criteria to separate factual
correctness from completeness. The pilot supports another measured trial, not
a blanket claim that splitting every large module will help.

The accompanying [code guide](../../docs/agent-readable-code.md) and
[new-comment lint](../../scripts/check-review-comments.py) make the conventions
reviewable without embedding review history in implementation comments.
