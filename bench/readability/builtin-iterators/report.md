# Builtin iterator readability slice

Status: final implementation `2fb25571` has completed the comprehension
measurement, exact 304-case corpus comparison and five focused tests. Both
code reviews are clear; full VM CI remains pending.

## Scope and preservation

The Python owner reserved `src/runtime/types.ts` from `iteratorType` through
`ReversedIter` and its registration. This slice leaves the shared operations,
object model, generator section and integer byte conversions untouched.
The branch rebased onto `23526b2c` after the Magma maps slice merged.

The implementation adds a short vocabulary for the internal `$next`/`DONE`
protocol and the Python `__next__` boundary, names the existing enumerate
increment cutoff, and shares the zip/map strict-keyword parser. Its original
order remains count, names, truth conversion, map positional arity, then source
iterator acquisition. Most local variables have descriptive names; stored
fields and signatures retain their existing names. Comments expose exhaustion
payloads, left-to-right consumption and reverse-getter index timing. Review
history moved out of the edited comments and into the commit message.

Two reverse-hook locals retain their old names, `r` and `gi`. Additional probes
found that the existing native SystemError causes for non-callable hooks include
those identifiers. Restoring them preserves the cause text; the accompanying
comment explains their meaning. Native implementation stack locations still
reflect source locations, as they do after other source edits. Exact invariance
of every internal diagnostic stack is not claimed.

## Frozen measurement

Ten fixed questions, three criteria each, three fresh Haiku runs per question.
The key was committed before production changes; all 30 baseline runs finished
before any runtime edit. The model is `claude-haiku-4-5-20251001`, with only the
read-only `types.ts` source at the exact selected commit available. No answer
key, history, memory or review files are supplied. Tools are Read, Glob and Grep.

Baseline source is `0f9d473635875c280cd5018bed179d0a555c2114`, unchanged by the
subsequent rebase. Coverage is 72/90 and 16/30 answers cover every criterion.
All three baseline answers put the reversed iterator's index decrement after
the getter call; JavaScript evaluates the decrement before calling the getter.

Final after coverage is 79/90, with 21/30 complete answers. Median wall time is
31.229 seconds before and 26.866 after. Total tool calls are 324 versus 301;
processed input tokens (including repeated cache context) total 8,591,725 versus
7,489,102. Per-question scores, ranges and token counts are in
`results/summary.md`. These are observed improvements in this small experiment,
not an established general performance or accuracy guarantee.

An initial after measurement used `10ca2d8b`. Two local names were then restored
to preserve native diagnostics, so the entire 30-run after phase is repeated at
`2fb25571`, with the same frozen key. Superseded transcripts remain under
`/scratch/sagebrush-reviews/readability-builtin-iterators/after`; they are not
selectively substituted into the final measurement. Final transcripts use
`after-final`, and baseline transcripts use `before` in that same parent.

Grading is manual by the implementing agent, neither blind nor independent.
This measures full coverage of the frozen claims, not correctness of every
statement. Omissions and contradictions score zero; relevant quotations count.
The rubric remains sensitive to compound details: for example, I01 asks about
the adapter but its first criterion also requires normal-value return, and I07
requires the internal exhaustion route as well as the mapping-call condition.
These criteria are unchanged between phases. Three runs per question provide
an observed range, not statistical certainty.

## Behavior evidence

The fixed corpus has 304 cases covering values, error types/messages/payloads,
iterator and callback order, strict admission, enumerate counters, filter and
reverse iteration. A typo in the generator's initial zero-input zip expression
was corrected before recording the baseline; the superseded output is excluded.

Baseline build is `b1edde78a91d04b4fcfbfe23eda87c841d08eeae`, whose production
source equals the baseline above. Host `sagebrush-3` uses Node v26.12.0 and Python
3.12.3 for the driver. Five focused tests use the VM's CPython 3.14 environment.

The first comparison in separate directories differed only in absolute paths
inside an existing SystemError when a reversed list is cleared. After was then
rebuilt and run in the original baseline directory, yielding 304/304 exact
matches at `10ca2d8b`: source, decoded stdout/stderr, exit status and timeout
flags, excluding only elapsed seconds. No path normalization or result exemption
was used. The cleared-list bug was reported to the Python owner for a separate
fix after this slice merges.

The final revision repeats that comparison in the same directory: 304/304
identical, zero timeouts. Five focused tests pass, and both restored native
diagnostic cause strings match. The comparison record and additional probes
are retained under `results/`.

Behavior and limits/refusals reviews are CLEAR on `2fb25571`, pending full CI
evidence. The behavior reviewer independently ran five focused tests and 17
callback cases; all passed, with the latter byte-identical before and after.
Seven additional malformed-hook probes preserve exception class and native
cause text, while internal stack locations reflect the edited source. Full CI
remains pending.

## Remaining comprehension errors

The explicit reverse-index comment helps one of the three final runs; the other
two still put the decrement after the getter, despite quoting the correct
comment. One also conflates a hook set to None with a hook returning None. This
semantic misconception remains unresolved by the comment.

The strict-exhaustion answers sometimes describe returning or raising
StopIteration inside `strictEnd`, where the actual internal return is DONE and
the Python adapter raises later. The map-call answers cover the no-callback-on-
exhaustion condition but omit the internal DONE/strictEnd route required by the
frozen criterion. No primary answers were replaced or regraded selectively.
A transcript audit covers all 90 primary and superseded runs: only the allowed
source projection and Read/Glob/Grep tools were used, with the specified model.
