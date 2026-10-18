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
