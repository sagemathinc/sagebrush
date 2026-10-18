# MATLAB argument-validation readability slice

Status: questions, corpus and all 30 cold baseline runs are frozen before any
production edit. The 748-case baseline corpus is running on `sagebrush-3`.

## Scope

The owner reserved the arguments-block helpers and validators in `lib/_matlab.py`,
from `split_nv` through `mustBeFolder_`. The base is `5f82f17a`. Adjacent special
functions, linear algebra, interpolation and file operations remain outside this
slice. The intended change is to separate class conversion from shape conversion,
name intermediate values and document admission/short-circuit rules. Public
helper signatures, validator registrations, conversion order and errors must
stay unchanged. No algorithm or correctness fix is part of this slice.

## Frozen baseline

The key was committed at `62814546`, before production edits. The corpus was
committed at `1b618797`; its six-case smoke run checked direct runtime calls and
translated MATLAB function calls before the full baseline run.

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

## Validation still required

Record the complete baseline corpus before editing the implementation; then
repeat it at the final executable revision in the same directory, comparing
source, decoded stdout/stderr, exit status and timeout flags with only elapsed
seconds excluded. Run focused tests, full sbremote CI, independent behavior and
limits/refusal reviews, and the complete 30-run after comprehension phase.
