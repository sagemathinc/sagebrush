# MATLAB argument validation readability slice

The frozen key has ten questions with three criteria each. Each question is
asked in a separate fresh Haiku process three times before and after the edit.
Only the read-only `lib/_matlab.py` at the requested revision is visible; no
answer key, Git history, review files or previous sessions are supplied.

The reserved production region begins at `split_nv` and ends at
`mustBeFolder_`. It covers argument-block binding, class and size checks,
validation-error wrapping, and the `mustBe*` validators. This is a readability
refactor with before/after behavior identity as its goal. Existing semantics,
including permissive or incomplete behavior, are not corrected in this slice.

The key is frozen at baseline `5f82f17add9fb8c041f94b5cb265719e5fc2be99` before
any production edit. Baseline source is unchanged while measurements run.

Run the cold comprehension phase in a project terminal, using the shared
harness committed by the number-field pilot:

```sh
python3 bench/readability/run.py --repo "$PWD" \
  --sha 5f82f17add9fb8c041f94b5cb265719e5fc2be99 \
  --key bench/readability/matlab-arguments/questions.json \
  --out /scratch/sagebrush-reviews/readability-matlab-arguments/before \
  --work /scratch/sagebrush-reviews/readability-matlab-arguments/cold --jobs 3
```

Each primary run is retained, including any errors; do not substitute a better
answer. Score all three explicit criteria against the committed key, with
omissions and contradictions scoring zero. Report grader identity and the
limits of three runs. Corpus execution, builds and tests belong on a VM.
