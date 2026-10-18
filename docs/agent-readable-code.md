# Code that a new agent can follow

Write for a reader who has the code but none of the conversations that produced
it. The number-field pilot in `bench/readability/` measures this with a fixed
question set, cold model sessions, and before/after behavior checks.

- Explain the invariant or reason in a comment. Put review IDs, reviewer names,
  discussion links and change history in the commit message. A reader should
  not need to retrieve an old review to know why a check exists.
- Make behavior choices explicit parameters or a configuration value passed
  from the entry point. Do not read environment switches in numerical helpers.
  If a diagnostic entry point accepts environment settings, list every setting
  there and keep ordinary callers independent of the process environment.
- Give policy constants names and explain their units and purpose. Distinguish
  a theorem's bound from an empirical search budget or a precision margin.
  A named constant does not turn a heuristic into a guarantee.
- Put a short glossary near mathematical code. Use standard notation in formulas
  and descriptive names for program state. Explain representations such as
  power-basis coordinates and fixed-point scaling at their boundaries.
- Keep orchestration separate from the stages it calls. Split a function when
  the reader must remember several independent stages to understand its next
  step; roughly 60 lines is a review prompt, not an automatic limit. Do not
  split a tight numerical recurrence merely to meet a line count.
- Keep assumptions and failure paths next to the returned result. State which
  results are heuristic, conditional, unconditional, or refused. Document
  cache contents, including cached failures.

A readability change must preserve operation order, precision, iteration order,
search budgets, errors and public representations. Freeze the behavior corpus
before editing. Retain raw outputs, check the relevant suites and full CI, and
ask reviewers to assess both behavior and limits. Refactor duplicate package
copies through their source of truth rather than editing them independently.

Run `python3 scripts/check-review-comments.py --base <branch-base>` before
review. It checks newly added comment lines, so existing history can be cleaned
up deliberately without making an unrelated change responsible for the whole
repository. Its vocabulary covers `CORR-`, `HARD-`, `LIMIT-`, `astra` and `HOLD`.

The number-field pilot migrates only the settings formerly read inside the
general BNF implementation. `bnfinit` and `bnfinit_with` now use explicit
`BnfConfig::default()` values; diagnostic callers must explicitly construct
`BnfConfig::from_debug_env()` in a debug build. This is not a claim that the
whole engine ignores environment variables. The quadratic routines still read
`QCL_DEBUG` and `QCL_NOCERT`, and `nf/embed.rs` still reads `QCL_LLLITER`.
Those are the next configuration-migration candidates, outside this pilot.
