# Magma maps readability slice

Status: primary measurement and exact corpus comparison complete. Full VM CI
and final behavior review are pending. This is not a merge-ready report yet.

The slice is confined to the maps section of `lib/_magma.py`. The Magma owner
reserved this region while collection, arithmetic and vector work continued
elsewhere. No external Magma or other prohibited source was read.

## Frozen experiment

Ten questions, three criteria each, three fresh Haiku processes per question.
The key was committed before implementation edits, and all 30 baseline answers
completed before the edit. The model is `claude-haiku-4-5-20251001`. The shared
harness supplies only a read-only projection of `lib/_magma.py` at the selected
commit, with Read/Glob/Grep tools and no repository history, answer key, review
files or memory. Raw transcripts are retained under
`/scratch/sagebrush-reviews/readability-magma-maps/{before,after}`; committed
results retain answers, source hashes, tools, tokens, elapsed time and grading.

Baseline source: `b1859ef4ffb55b5110ab14d9bf01544f81aae36f`.
Measured refactor: `359723b5546005d909fb54e8f8e238abac567c41`, rebased onto
`0f9d4736` before measurement. The intervening master change concerns the engine
web size argument; `lib/_magma.py` is unchanged between the two baseline trees.

Primary rubric coverage is 53/90 before and 57/90 after; fully covered answers
increase from 2/30 to 7/30. Median wall time is 28.122 versus 27.546 seconds.
Total tool calls are 374 versus 370; total processed input tokens are 3,610,821
versus 3,678,927 (including repeated cache context). This is a modest observed
coverage gain with similar cost, not evidence of a broad speed or token saving.
Per-question scores, times and token counts are in `results/summary.md`.

This is coverage of the frozen required claims, not the accuracy of every statement the model made. Compound criteria
need all their claims; omissions and contradictions receive zero, and relevant
code quotations count. The implementing agent grades the answers manually,
so the grading is not blind or independent. Three repetitions give an observed
range, not a statistically established general improvement. Some compound
criteria require details the question does not emphasize (for example dom/cod
in M01 and inverse-composition construction in M03). This makes the score
sensitive to answer completeness as well as comprehension. Future slices
should ask explicitly for every scored claim; this frozen key is unchanged.

## Implementation

- A glossary explains the stored map forms and universe terminology.
- `_map_set_image` separates set lifting from scalar dispatch, preserving all
  recursive applications before universe selection and payload conversion.
- `_normalize_map_graph` and `_validate_map_graph` expose normalization,
  duplicate-source checks, pair admission and total coverage in their original
  order. Partial maps skip only coverage.
- Local names describe source/target pairs, inferred universes and composition
  parts. Constructor signatures and stored attributes retain their names.
- Comments explain empty set images, delayed inverse-rule errors and the
  difference between `Image(f)` and `f(S)`. Review history moved into the commit.

`MMap.__call__` goes from 39 to 22 lines and `_map` from 32 to 14, including
comments/docstrings. Three extracted helpers have 21, 10 and 20 lines. The
section grows overall because it gains explanations; this is not a code-size
reduction or a claim that every short function needs extraction.

## Behavior evidence

The frozen corpus contains 174 cases: an existing comprehensive stdin fixture,
rule and composition variants, graph order/admission/coverage errors, partial
maps, inverses, set-image universes and coercions, and callback/error-position
traces. All 174 before/after cases are identical with no timeouts. Three focused
map tests also pass. Expected failures remain part of the comparison. The runner compares the case list, source, decoded stdout/stderr,
exit codes and timeout flags exactly, excluding only elapsed time. It is an
identity test, not a new oracle-correctness claim.

Operational-limits/refusals code review is CLEAR at `359723b5`; the reviewer
accepted the exact corpus evidence. Behavior review and full CI are pending.

## Remaining confusion and comment follow-up

M08 loses one rubric point (4/9 to 3/9). All three primary-after answers
incorrectly allow inference after an existing unsupported declared universe.
The code returns None immediately in that case. A two-line comment at this
branch now states that declared universes are authoritative and inference
requires absence. Three additional cold M08 runs on `e19ba2a4` score 5/9,
separately from the primary 3/9. Only one of the three correctly states that an unsupported
declared universe refuses immediately; the other two retain the mistaken
fallback. The comment helps one observed answer but does not reliably solve
this comprehension error. No further tuning or selective replacement of
primary runs was performed.

M02 and M10 each lose one point through omitted error/coercion details; their
validation paths did not move to an extracted helper. These three-run samples
do not establish that navigation got worse. M03 still sometimes produces an
inverse-composition formula contradicting its own correct verbal order. These
limitations remain visible in the retained answers and grading notes.
