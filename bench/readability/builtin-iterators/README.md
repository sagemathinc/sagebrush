# Builtin iterator readability experiment

Scope: `src/runtime/types.ts`, from `iteratorType` through the `reversed`
registration. The Python owner reserved this region. Integer byte conversion,
generators, shared iterator machinery in `ops.ts`, and other type methods are
outside this slice.

The ten questions and answer key are frozen before production edits. Each
question explicitly asks for every scored detail. Run three independent cold
Haiku processes per question before and after, using the shared driver:

```sh
python3 bench/readability/run.py --repo . --sha REVISION \
  --key bench/readability/builtin-iterators/questions.json \
  --out /scratch/sagebrush-reviews/readability-builtin-iterators/before \
  --work /scratch/sagebrush-reviews/readability-builtin-iterators/cold --jobs 3
```

Use a fresh output directory for the after measurement. The projection contains
only `types.ts`, at the exact selected commit, read-only and without history,
keys, results, memory or review files. The shared harness now accepts TypeScript
sources as well as Rust and Python. The CLI runs in a project terminal using the
existing subscription; builds and behavior comparisons run only on test VMs.

Record each answer, source hash, input/output/cache tokens, tool calls and wall
time. Grade all three runs against the same key and retain the reasons. A
three-run comparison reports observed coverage, not statistical certainty. The
implementing agent grades manually, so the report must disclose that grading
is neither blind nor independent. Follow-up comments, if any, get separately
labelled runs rather than replacing primary answers.

The fixed behavior corpus has 304 cases. It records values, exception payloads,
iterator and callback order, admission order, exact large enumerate counters,
filter predicates, and reversed sequence/error/mutation paths. It compares all
recorded fields except elapsed time, including decoded stdout/stderr and source.

```sh
python3 bench/readability/builtin-iterators/corpus.py --repo . \
  --out /home/user/astra3-iterators-before.json
python3 bench/readability/builtin-iterators/corpus.py --repo . \
  --out /home/user/astra3-iterators-after.json \
  --baseline /home/user/astra3-iterators-before.json
```

The first generator draft emitted an invalid zero-argument `zip` expression.
This harness typo was corrected before recording the baseline below; the
superseded draft output is excluded from the experiment. All 304 corrected
programs parse, and all completed without timeouts on the VM.

Baseline production source: `0f9d473635875c280cd5018bed179d0a555c2114`.
Baseline corpus build: `b1edde78a91d04b4fcfbfe23eda87c841d08eeae` (only the
benchmark files differ). The 30 cold baseline runs completed before production
edits. Their frozen-rubric coverage is 72/90, with 16/30 complete answers. All
three reverse-index timing answers incorrectly put the decrement after the
getter call. Source files remained unchanged when the branch rebased onto
`23526b2c`, which merges the preceding Magma maps slice.
