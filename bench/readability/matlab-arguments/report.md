# MATLAB argument-validation readability slice

Status: implementation `0f17e46d` has 748/748 exact corpus matches, two passing
focused tests, and the complete cold before/after measurement. Limits/refusal
review is clear on the code and focused evidence; behavior review and full CI
remain pending.

## Scope

The owner reserved the arguments-block helpers and validators in `lib/_matlab.py`,
from `split_nv` through `mustBeFolder_`. The base is `5f82f17a`. Adjacent special
functions, linear algebra, interpolation and file operations remain outside this
slice. The change separates class conversion from shape conversion, names intermediate
values and documents admission/short-circuit rules. Public helper signatures,
validator registrations, conversion order and errors remain unchanged. Three
private helpers expose class admission, shape adjustment and vector eligibility.
No algorithm or correctness fix is part of this slice.

## Frozen baseline

The key was committed at `62814546`, before production edits. The corpus was
committed at `1b618797`; its six-case smoke run checked direct runtime calls and
translated MATLAB function calls before the full baseline run. All 748 baseline
cases completed with no process failures or timeouts, and their exact outputs
were committed at `503fad88` before the production edit.

The cold source projection contains only `lib/_matlab.py` at
`5f82f17add9fb8c041f94b5cb265719e5fc2be99`, with no history, key, reviews or memory.
The shared harness runs `claude-haiku-4-5-20251001` with Read, Glob and Grep in a
fresh read-only source directory for every question and repetition. Ten fixed
questions, three criteria each, three runs each. Raw transcripts and records:
`/scratch/sagebrush-reviews/readability-matlab-arguments/before/`.

Baseline coverage is **66/90**, with **15/30** complete answers. Grading is manual
by the implementing agent, neither blind nor independent. This is coverage of
compound frozen criteria, not the probability that an answer is correct. Some
criteria include implementation details that the question does not name directly:
for example, the input-length stopping bound, unchanged-class bypass and `_using`
error route. Omissions score zero even when the main explanation is correct;
this remains the same rule in the after phase. The original answers and grading
notes are retained so readers can distinguish omissions from incorrect claims.

Three baseline runs incorrectly admit string inputs to numeric declarations by
following the general `_convert` function and overlooking the narrower
`arg_check` admission rule. One answer claims matching dimensions can trigger
reshaping. Another rejects complex values from numeric validators although
numeric classes include complex entries. Some answers omit that `mustBeReal`
also accepts logical values; that distinction is not separately scored by the
frozen key, and is recorded as an additional error.

## After measurement

The complete 30-run after phase uses `0f17e46d` and the same frozen questions.
Coverage rises from **66/90 to 73/90**, and complete answers from **15/30 to
16/30**. Median wall time is **26.493 seconds before, 23.861 after**. Total tool
calls fall from 345 to 274, processed input tokens (including repeated cache
context) from 3,066,025 to 2,328,047, and output tokens from 85,818 to 67,419.
Per-question ranges and raw graded answers are in `results/`. These are observed
results for three runs per question, not a general accuracy or speed guarantee.

All three after answers respect the numeric declaration's admission rule, and
all three correctly keep matching dimensions unchanged. Some answers still omit
the `_using` route, error identifiers or option normalization. The name-value
error question falls from 6/9 to 5/9 through identifier omissions; the range
question falls from 8/9 to 7/9 through default/normalization omissions. The
underlying rules remain visible in their original branches. No additional
measurement or code tuning was selected to replace those results.

Additional errors outside the frozen rubric remain visible in the grading notes.
For example, one after answer calls recursive Cell/Struct copying shallow, and
some compare the real/numeric validators as if their accepted sets were nested.
Thus the coverage score should not be read as an exact factual accuracy rate.
Both phases passed the source/model/tool record audit, with no failed runs or
unexpected tool paths. The implementing agent manually graded both phases.

## Behavior evidence and review

On `sagebrush-3`, the exact final source produced **748/748 identical cases**, no
timeouts, process failures or nonempty stderr. Before and after used the same
checkout path, `/home/user/wt/run-1b618797f`; only elapsed seconds are excluded
from comparison. Source, decoded stdout/stderr, exit status and timeout flags
are compared without normalization. This establishes corpus identity to our
baseline, not agreement of every inherited behavior with external MATLAB.

The two existing focused translation tests for name=value arguments and arguments
blocks pass. Full sbremote CI is running on `sagebrush` at `0f17e46d`.

The limits/refusal reviewer checked the class-before-size order, unchanged
conversion/error boundaries, mismatch-only size work, scalar-before-vector
adjustment, pair scanning/materialization and validator short-circuit behavior.
Code and exact corpus evidence are clear, with full CI still pending. Behavior
review is also pending. No executable edits follow `0f17e46d`.
