# Rill: an R-language mode (R0 design)

*Status: design for review (R0). Author @sagebrush-magma, Nov 7 2026. Reviewers: all five lanes. Daybreak2 reviews size (§6), daybreak3 the engine, Stop, recursion and memory (§8, §5.1, §10), astra files, network and processes (§9), grader the tests (§7), board the copy. No product code lands before DESIGN CLEAR. After that, code comes in the small phased PRs of §3, each through all five lanes.*

## In plain words

Rill runs R, the statistics language, in Sagebrush: on the command line, in notebooks and Jupyter, and in documents. The first target is the R that students and teachers write: vectors, data frames, factors, summaries, distributions, tests, linear models and plots. Then R Markdown documents (`.Rmd`), then ggplot2, then dplyr.

Rill is new code, written from R's documentation and checked against real R as a black box. It is a Python package that runs on Sagebrush's engine, as the Magma and MATLAB modes do.In the browser, other modes pay nothing: Rill is fetched only when a Rill session starts. (The CLI carries Rill's files, kept lazy and measured, §6.3.)

The feasibility spike (`/scratch/sagebrush-reviews/r-spike/REPORT.md`, branch `spike-r-mode` b7a1a1e7) matched R 4.5.3 byte for byte on 252 of 254 tuned cases, and on 95 of 110 held-out cases at the first attempt. This design turns that prototype into a product. The spike branch is not merged: its code is the starting point for the phased PRs, rewritten into the layout of §4.

## 1. William's decisions (Nov 7 2026, 11:32 AM PST, relayed by @sagebrush: "Do it.")

1. **RNG:** "yes, fitting is fine -- doesn't have to be identical". Generators may be fitted to R's outputs; no two-person clean room is needed.
2. **Goal:** "primarily teaching-grade R and presentation for now."
3. **Scope:** "ggplot2/dplyr - yes".
4. **Name and files:** Rill is the name, and Rill claims `.R` and `.Rmd`: "yes we should support Rmd (similar to sagetex and knitr)".
5. **Test data:** recorded R outputs in CI are fine: "that's a lawyer question, but I think the answer is clearly yes as R is fully GPL open source."

## 2. Clean-room rules (standing)

- **Only documentation is read.** R, its base packages, and every CRAN package Rill reimplements or uses as an oracle are GPL: knitr, rmarkdown, ggplot2, dplyr, tibble, pillar and rlang. For these we read only documentation: the R manuals, help pages (as text, `rhelp.sh`), the CRAN reference manuals, vignettes, and published books and papers. We never read their source code: no C, no Fortran, and no R-level source.
- **The oracle is a black box.** It is R 4.5.3 in VM4 `~/sbm-r` (`/scratch/sagebrush-reviews/r-spike/APPENDIX-A-oracle.md`). We call functions and record outputs. We never print a function object, and never call `body`, `deparse`, `getAnywhere`, `edit`, `fix`, `page` or `View` on one. Inspecting data is fine: `.Random.seed`, `sprintf("%.17g", x)`, `write.csv(dataset)`, `ggplot_build(p)$data`.
- **Our words, our code.** Help text is never copied into our docs, our docsearch index or our messages. Error and warning texts that R prints, and output layouts, are reproduced as observed behaviour; this is interoperability, as MATLAB mode reproduces MATLAB's.
- **No code is written by Codex sessions.**
- **Each oracle-derived algorithm records its provenance in its PR**, as the RNG section of the spike report does: what was observed, and what was fitted. For example: the RNG seeding and generators, `pretty()`, `format.pval`, and the column-header rules.
- **Dataset values come with their published sources** (§5.6).

## 3. Scope and phases

The order is least complex first, and each phase is useful on its own. A phase is several PRs of at most about 1,500 product lines each. Each PR carries its corpus cases (§7), passes all five lanes, and lands before the next one builds on it.

| Phase | What | Done when |
|---|---|---|
| **A1 Core** | The package skeleton (§4); the full R grammar; the evaluator: promises, environments, R's three-pass argument matching, closures, replacement functions, `UseMethod`/`NextMethod`/group generics, conditions (`stop`, `warning`, `tryCatch`, `withCallingHandlers`, `on.exit`); the printing core (vectors, named vectors, factors, lists, matrices, data frames, `str`); `sagebrush --rill`, `.R` files, and the REPL with continuation (`_rill.is_incomplete`). Also in A1: the final lazy-group routing and budget names (§6.1), §8's Stop, transaction, recursion and memory invariants, and §9's host permission pins and escape negative controls | The language and printing corpus is exact; §6.5's, §8's and §9's pins pass |
| **A2 In the product** | The mode registry (§5.1, its own no-behaviour-change PR first) and Rill in the notebook, the Jupyter kernel (`--mode rill`), boards, the web worker as a lazy group (§6), completion and docsearch (our own one-line summaries) | A notebook cell runs R; other modes' bundles are unchanged |
| **A3 Base and stats** | About 300 functions: vectors, strings, regex, factors, `table`, apply family, `Reduce`/`Map`, dates, data frames (`merge`, `aggregate`, `subset`, `with`, `transform`), summaries, distributions (d/p/q/r for the common families), the RNG (fitted, §5.4), `read.csv`/`write.csv` through the file gate (§9), the `datasets` values | The intro-stats corpus is exact |
| **A4 Models and tests** | `lm`/`glm` with `model.frame`, NA handling and interactions; a pivoting QR, with aliased coefficients as `NA`; `summary`, `anova`, `aov`, `TukeyHSD`, `predict` (intervals), `confint`; t/chi-squared/prop/binom/cor/wilcox/shapiro tests | The models corpus is exact |
| **A5 Base graphics** | `plot`, `hist`, `boxplot`, `barplot`, `lines`, `points`, `abline`, `legend`, `curve`, `qqnorm`/`qqline`, `par(mfrow)`, on Sagebrush's SVG renderer (§5.5) | The computed values match R; the SVG descriptions are snapshot-tested |
| **B `.Rmd` documents** | knitr-like chunks in a source-and-preview editor on the LaTeX editor's code-item model (§5.7); inline `r expr`; chunk options; render to HTML. Also `\rill{}`/`rillcode`/`rillblock` in `.tex`, the same model as `\matlab{}` | A teaching handout knits; William's "similar to sagetex and knitr" |
| **C ggplot2** | The grammar: `ggplot`, `aes`, the common geoms, stats, scales, facets, themes, `labs`; rendered on the same SVG renderer | `ggplot_build`-style data matches R (§7.3) |
| **D dplyr** | Verbs (`filter`, `select`, `mutate`, `summarise`, `group_by`, `arrange`, `join`s); the `|>` and `%>%` pipes; tidy evaluation for the verbs' data masking; tibble printing | The dplyr corpus is exact, including `# A tibble:` printing |

Performance work (§10) goes into whichever phase needs it, with measurements in that PR.

**Not in scope now:**
- arbitrary CRAN packages, `install.packages`, and compiled code (Rcpp);
- S4 and R5/R6 classes, until a teaching need appears;
- `.Rnw` (knitr's LaTeX form);
- shiny.

## 4. Where the code lives

**The interpreter.** It is a Python package in `lib/_rill/`, run by the engine. The spike was flat files; the package replaces them, and each module is imported on first use:

| Module | Contents |
|---|---|
| `_rill/__init__.py` | `run(src)`, `run_cell`, `is_incomplete`, the session |
| `_rill/lex.py`, `parse.py` | The lexer and Pratt parser (R's operator table from `?Syntax`) |
| `_rill/values.py` | Vectors, lists, attributes, NA, coercion |
| `_rill/eval.py` | The evaluator: promises, environments, matching, S3 and conditions |
| `_rill/fmt.py` | `formatReal` and the print layouts; `deparse` |
| `_rill/base/*.py` | Base builtins, by family |
| `_rill/stats/*.py` | Summaries, distributions, the RNG, tests, models |
| `_rill/graphics.py` | Base graphics on `lib/_graphics.py` |
| `_rill/datasets.py`, `_rill/data/**` | Dataset loader (`rill-more`) and the values payload (`rill-data`), loaded on first reference (§5.6) |
| `_rill/rmd.py` | Chunk parsing, chunk options, the knit driver (phase B) |
| `_rill/ggplot2/*.py` | Phase C |
| `_rill/dplyr/*.py`, `_rill/tibble.py` | Phase D |

**The TypeScript side** is thin:
- `src/rill.ts`: the file-type and REPL hooks, `is_incomplete` through the engine;
- `src/rill-complete.ts`: completion;
- the mode registry entry (§5.1);
- `web/latex/cells.ts`: Kinds `rill`, `rillcode` and `rillblock` with `LANG` "rill" (phase B);
- the `.Rmd` editor (phase B, §5.7).

**Tests:**
- `rill-tests/<area>/test_<n>.R` with recorded `.out.json` files and `PROVENANCE.json` (§7);
- `test/rill-corpus.test.ts`, which replays the corpus;
- `test/rill.test.ts`, for host behaviour: the REPL, the kernel, Stop and the gates.

## 5. Design details

### 5.1 A mode registry instead of a fifth copy

Today a mode's name is a string union repeated in 32 files: 9 under `src/` and 23 under `web/`, for example `Mode = "sage" | "python" | "magma" | "matlab"` in `src/kernel.ts`, `src/reactive-session.ts`, `web/notebook/types.ts` and `web/latex/cells.ts`. The copies are deliberately not uniform: the kernel's `Mode`, the CLI's `ReplMode`, board modes, worker modes and offline items admit different sets.

A2 first adds `src/modes.ts`, in its own PR with no behaviour change, landed before the Rill row:

- **Pure data.** It holds names, labels, extensions, kernel `language_info` and the worker flag name. It imports no mode implementation, so it adds nothing to any bundle that doesn't already need those strings.
- **Hooks by reference.** Hooks (completion, `is_incomplete`, translation) are identifiers that each host resolves itself through its own lazy dynamic import. The shared table never holds code.
- **One subset per consumer.** Each consumer derives an explicit subset (`KernelMode`, `ReplMode`, `BoardMode`, `WorkerMode`, `LatexLang` and so on) instead of using one universal union. A mode a consumer doesn't support stays out of its subset.
- **Pins:**
  - today's defaults;
  - the serialized board schema;
  - the kernel and CLI specs and their error strings (for example `--mode must be sage, python, magma, matlab or all`);
  - the lazy-import and bundle boundaries (no new eager import; size unchanged).

Rill is then one row, plus its membership in the subsets that support it.

Rill's kernel `language_info`: name `R`, file extension `.R`, mimetype `text/x-r-source`, codemirror mode `r`, pygments lexer `r`. Its label in menus is "R (Rill)".

### 5.2 Files

- `.R` and `.r` run in Rill: `sagebrush file.R` behaves like `Rscript file.R`, and the editor opens them as code.
- `.Rmd` opens in the Rmd editor (phase B).
- `sagebrush render doc.Rmd [--to html|md]` knits on the command line (phase B).
- `.RData` and `.rds` are not read at first: their format is undocumented, so supporting them would mean fitting it from outputs, which is out of scope until there's a need.

### 5.3 Printing

Printing is most of what "feels like R". The spike's algorithms are exact for the common layouts. These were measured, not guessed:
- common significant digits, fixed or scientific with `scipen`;
- the column layouts and `[k]` labels;
- `printCoefmat`, `print.htest`, `print.summaryDefault` with its `zapsmall(digits + zdigits)` step (documented in `?summary`);
- `deparse` line breaking.

The remaining tail, from the spike report's held-out misses, is scheduled in A1/A3: 2-D table headers, `str()` truncation, `summary(data.frame)` header centring, wide-frame wrapping and `options(digits)`. Each rule is pinned by recorded outputs before it is implemented, and its derivation is noted in the PR.

### 5.4 Random numbers

- `set.seed` + `runif`/`rnorm` are already bit-identical (LCG seeding fitted from `.Random.seed`; the Mersenne Twister; two-uniform inversion).
- Per William's decision 1, `sample` (rejection sampling), `rbinom`, `rpois`, `rexp`, `rgamma`, `rbeta`, `rt` and `rchisq` are fitted to R's outputs where we can. Where a generator isn't matched yet, it is a correct generator of the right distribution, and the PR says it isn't R's stream.
- Each generator lists its status in `rill-tests/RNG.md`.
- Draws are Python today, about 17 µs each; §10 moves them to a native generator.

### 5.5 Graphics

Base graphics and ggplot2 draw with `lib/_graphics.py`, Sagebrush's own SVG renderer (PLOTTING.md): deterministic, with an `aria-label` description, files without a browser, and the notebook's display protocol.

Fidelity is about **values, not pixels**. R's computed numbers are compared against the oracle: `hist(plot = FALSE)` breaks and counts, `boxplot.stats`, `density()`, `pretty()` tick positions, and `ggplot_build(p)$data` for ggplot2. Our SVG descriptions are snapshot-tested. We don't copy R's default look; we follow its layout rules where they're documented (`?par`).

### 5.6 Datasets

The values of the teaching datasets are taken through `write.csv` on the oracle: `mtcars`, `iris`, `ToothGrowth`, `PlantGrowth`, `airquality`, `faithful`, `cars`, `women`, `chickwts`, `InsectSprays`, `sleep`, `trees`, `warpbreaks`, `precip` and `Titanic`, plus more on request.

They are stored compactly (columns, factor levels, row names) in a lazy data module that is loaded on first reference to a name. Each dataset's published source is listed in `lib/_rill/DATASETS.md`, from its help page's Source section, in our words. Each new dataset is checked for its source before it is added.

### 5.7 `.Rmd` documents (phase B)

William: "similar to sagetex and knitr". An `.Rmd` is a source document whose chunks run and whose outputs are woven into the rendered result. That is the LaTeX editor's model (`web/latex/cells.ts` and friends):
- code items with stable identities across edits;
- outputs cached by (kind, code hash, ordinal);
- run, Shift+Enter, Stop;
- a live preview.

The Rmd editor reuses that machinery with Markdown in place of TeX:
- **Items:** ```` ```{r label, opt = value} ```` chunks and inline `` `r expr` ``. One Rill session per document, chunks in order, as knitr runs them.
- **Chunk options, first set:** `echo`, `eval`, `include`, `results` ("markup", "asis", "hide"), `message`, `warning`, `error`, `collapse`, `comment` (default `"##"`, as knitr prefixes output lines), `fig.width`, `fig.height`, `fig.cap`, `label`. An unknown option is kept and reported; it is never silently ignored. Options that would select another engine, a hook, a renderer or a destination are refused, and the chunk doesn't run (§9, RILL-SEC-2).
- **YAML front matter:** `title`, `author`, `date` and `output` (`html_document`, plus later `pdf_document`/`beamer_presentation` through the LaTeX pipeline, for William's "presentation"). It is read by a closed grammar, as `web/notebook/myst-head.ts` reads MyST's.
- **Preview and render:** HTML through `web/markdown.ts`, with its sanitiser and `remote: false`. Plots are inline SVG.
- **Also:** "Open as notebook", which makes a notebook copy, as MyST `.md` files have today.

knitr's exact output text (the `##` prefixes, code fences, figure markup) is recorded from the oracle once knitr is installed there as a black box (§12, question 1).

### 5.8 ggplot2 and dplyr (phases C and D)

**ggplot2** is a Python implementation of the grammar on `_graphics.py`: layers, stats, scales, coordinates, facets, themes. It is tested on built data (§7.3) and SVG descriptions. Its API surface comes from the CRAN reference manual and the ggplot2 book; we read no source.

**dplyr** needs:
- data masking for its verbs, a second evaluation mode on top of R's promises. It is scoped to the verbs' argument evaluation and is not a general rlang;
- `group_by` grouping metadata;
- tibble printing (`# A tibble: n × m`, type abbreviations, truncation), which is its own printing layer, pinned by recorded outputs.

`library(ggplot2)` and `library(dplyr)` attach our implementations. `library(other)` gives R's own error for a missing package (its exact text, quotes included, recorded from the oracle in the phase PR). `install.packages` explains that Rill provides base, stats, graphics, utils, datasets, ggplot2 and dplyr built in.

## 6. Lazy loading and size (daybreak2)

### 6.1 Final group routing, from A1's first `_rill` file

The routing lands in A1's first PR, with the first `lib/_rill/` source, so later phases never rename or remove a bundle. A later split would read to the gate as a forbidden removal. `web/lib-chunks.mts` changes:

- **The start.** `rill` joins web/build.ts's `STARTS` (`["--rill", "-c", "1"]`) and `START_ORDER`, **after** the existing modes. `groupOf`'s start loop checks it last (`sci`, `sage`, `matlab`, `magma`, then `rill`), so a file another start already uses stays in core, sci or sage: Rill never takes a shared file. `manifest.modes.rill` is built like the others.
- **Path rules**, before the generic `mod-` fallback, so no `lib/_rill/**` file ever becomes `mod-rill`:

  | Path | Group |
  |---|---|
  | in Rill's start recording | `rill` |
  | `_rill/ggplot2/**` | `rill-ggplot2` |
  | `_rill/dplyr/**`, `_rill/tibble.py` | `rill-dplyr` |
  | the dataset payload, `_rill/data/**` | `rill-data` |
  | any other `_rill/**` | `rill-more` |

- **Offline ownership.** `web/offline-inventory.mts` `MODES` gains `{ id: "rill", title: "R (Rill)", prefix: "rill", needs: ["python"] }`. Because every Rill group is named with the `rill-` prefix, the Rill item owns all five, and none falls into "Other Python modules". If a measured start closure turns out to import scientific modules, `needs` names them, and the PR says why.

### 6.2 Budget rows and markers

- **New bundles.** A genuinely new measured bundle is authorized by its new `budgets.json` row. Only rows that are actually measured are added:
  - `rill.src` and `rill.pre` (the start is precompiled);
  - `rill-more.src`, plus `.pre` only if the build makes one; it doesn't for files no start compiles;
  - later each family's `.src` (`rill-ggplot2`, `rill-dplyr`, `rill-data`).
- **Growth of existing rows** (the CLI's `lib.gen.js` and `pyjs.cjs`, the TypeScript wiring, and every later increment to a Rill row) is authorized by tight `.growth` markers. They are measured with the exact pull_request gate (Node 24.21.0, bun 1.4.4, equal-length paths) against current master.

### 6.3 The CLI pays from A1, so it is measured and kept lazy

The plain words say "in the browser, other modes pay nothing", and that limit to the browser is deliberate. The CLI embeds Rill's files from A1, so every CLI download and install carries them, and an unchanged embedding could slow a cold Python or Sage start.

- **Plan:** extend `scripts/lazy-lib.mjs` from one shared gzip blob (pathlib's, today) to **keyed family blobs**:
  - one for pathlib, as now;
  - one for Rill's start files;
  - one each for `rill-more`, `rill-ggplot2`, `rill-dplyr` and `rill-data`.
- **Effect:** each blob is decoded only by the first import of a module in it. A pathlib import then never decodes Rill, and a Python or Sage start never decodes any Rill blob; they pay only the installed bytes.
- **When:** this goes in A1, with the CLI's lazy-module guard (`web/test-cli-lazy-lib.mjs`) extended to the new families. If the measured cost of the single-blob approach is accepted instead, A1 says so with the numbers.

### 6.4 What each phase reports

Every Rill PR's SIZE packet reports, against current master:
- `lib.gen.js`, `pyjs.cjs`, and the packaged install/download (npm pack) bytes;
- cold start of Python, Sage and Rill on the CLI;
- browser stored and Brotli transfer bytes per Rill row (`rill.src`/`.pre`, `rill-more.src`, each family);
- the remaining headroom under the offline caps (`OFFLINE_CAPS` files, stored, transfer, max entry).

**No aggregate estimate stands in for these.** The spike's numbers (about 250 KB of source for its slice; an import of about 130 ms over the engine's start) are only a starting point.

**First-use target.** The target covers the full first use: download, decode, compile and import. A Rill session's first cell, measured cold in the browser (empty cache, the CI network profile) and on the CLI, must stay within 1.2× of MATLAB mode's first cell measured the same way, or the PR explains the difference. Each later family's first import is measured the same way.

### 6.5 Pins (A1, extended per phase)

- Synthetic path-to-group cases for every rule in §6.1, including a shared file that stays in core, sci or sage.
- No other mode's start or `manifest.modes` entry includes a Rill group.
- A Rill start fetches only its start group and its declared dependency groups.
- The first import of a ggplot2, dplyr or dataset module fetches only that family's group.
- The preload intent follows `modes.rill` (`web/preload.ts`).
- The offline inventory owns every group exactly once and stays under its caps.

## 7. Tests: a corpus of recorded R outputs (grader)

### 7.1 The corpus and its oracle

**Layout:**
- `rill-tests/<area>/test_<n>.R` hold cases, several per file, separated by `#-- <id>` lines.
- `rill-tests/<area>/test_<n>.out.json` holds each case's recorded stdout, stderr and exit status.
- `rill-tests/PROVENANCE.json` records the oracle.

**Recording.** `rill-tests/run.py --regen` is the **only** writer of `.out.json` files (T6). It runs on VM4 over ssh: one fresh `Rscript --vanilla -` per case, never in CI.

**The oracle's environment (T1)** is pinned and recorded from inside each run:
- the recording sets `LC_ALL=C.UTF-8`, `TZ=UTC`, and `options(width = 80, digits = 7, scipen = 0, OutDec = ".")` at the start of every case;
- a preamble prints `R.version.string`, `R.version$platform`, `Sys.getlocale()`, `Sys.timezone()`, those options, and (phases B–D) `packageVersion()` of every package used.

`PROVENANCE.json` holds that record, the oracle's path and the `run.py` revision, and, for each `.out.json`, its sha256.

**Oracle bumps.** A new R or package version re-records **everything** in one PR. The PR shows the diff of the outputs, updates `KNOWN.json` (§7.3), and states the new provenance; no partial re-recording is allowed.

**Replay pins the same environment.** Rill runs every case with the recorded options and locale, and `TZ=UTC` for dates. `test/rill-corpus.test.ts` fails if `PROVENANCE.json` is missing or incomplete, or if an `.out.json` hash doesn't match its provenance entry (T6: a hand-edited output is caught).

### 7.2 What is compared (T2)

For each case, the comparison covers three things, byte for byte:

1. **stdout.**
2. **The exit status.**
3. **The condition lines on stderr.** These are all of `Error …`, `Warning message(s):`, the numbered warning lines, `In f(…) :` lines, and `message()` output, with their text. The only normalization is dropping Rscript's final `Execution halted` line. R prints warnings on stderr, so a mutant that drops or changes a warning or a message fails a case.

### 7.3 Known differences, enforced both ways (T3)

`rill-tests/KNOWN.json` is machine-readable. Each entry holds a case id, a reason class (`layout-undocumented`, `rng-stream`, `lapack-rounding`, `not-implemented`, …), one line of reason, and the sha256 of **our** current output for that case.

A listed case still runs, and the test checks two things:

- **Our output still matches its recorded hash.** A regression inside a known difference is therefore visible, and updating the hash needs `--update` (T6).
- **It still differs from the oracle.** If it has become exact, the test fails with "remove from KNOWN.json", so a case leaves the list only by becoming exact.

### 7.4 Held-out files you can check (T4)

Each phase's held-out file is committed **with its recorded `.out.json` and sha256**, in a small PR that lands before the phase's first code PR. The phase-end score names that commit.

No held-out case is edited after code starts: a needed fix becomes a new, visible case. The scored first-attempt figure, like the spike's 86%, is reported against exactly the committed hashes.

### 7.5 Cost and CI budget (T5)

William's rule is PR CI of at most 10 minutes, with no raised timeouts.

**Per-case cost.** The spike measured about 0.6 s of engine start per CLI process, and 10–60 ms per case in-process. One process per case (364 cases now, thousands by phase D) wouldn't fit.

**Batch runner:**
- `test/rill-corpus.test.ts` starts **one CLI process per case file** and runs each case in a **fresh Rill session** inside it: a new global environment, options reset to the pinned set, the RNG unseeded, warnings cleared, connections and devices closed.
- Fresh-session equivalence is itself pinned. A fixed 5% subset of cases (chosen by id hash) also runs one process per case, and must give identical results.

**Shards:**
- The corpus is split across `test/rill-corpus-{1..4}.test.ts`, each a fixed partition of the case files by filename hash, so the existing 8 `node-tests` shards spread it.
- Budget: each partition at most 45 s of wall time on CI's runners, and at most 3 min summed. The A1 PR gives measured numbers.
- A phase that would pass the budget splits further, or asks for a dedicated path-selected `modes (rill)` group. That needs a workflow-file change, which agents never push, so it would go to @sagebrush and William.

**Path selection.** `scripts/ci-paths.mjs` maps `rill-tests/`, `lib/_rill/` and `src/rill*.ts` to the node suite. The node suite already runs on most PRs, which is why the budget above is strict.

### 7.6 Our own snapshots (T6)

SVG-description snapshots (§5.5) and `KNOWN.json`'s hashes are **ours**: they pin behaviour, they don't verify it.
- They change only through an explicit `--update` run that the PR states.
- They never change silently in the same commit as the code they pin.
- `.out.json` files come only from the oracle, through `run.py --regen` (checked by the provenance hashes in §7.1).

### 7.7 Plots, documents and generators

- **Graphics:** R's computed values (§5.5) are corpus cases; our SVG descriptions are snapshots (§7.6).
- **ggplot2:** `ggplot_build(p)$data` and `layer_scales` outputs, printed by the oracle.
- **Rmd:** knitr's markdown output for each test document.
  - Its normalization is stated before recording and recorded in the provenance (S2): version banners, figure paths, timestamps.
  - It is compared against our knit's markdown, normalized the same way.
- **Generators not on R's stream yet** (S1): each gets a deterministic distribution pin with a fixed seed and sample size. The pin checks the first four moments against the distribution's, within stated bounds, and bounds the Kolmogorov–Smirnov statistic, so "a correct generator of the right distribution" is pinned, not only listed.

### 7.8 Mutants

- Grader's mutant runs apply per PR, as for every lane.
- Each PR lists the rules it adds, so mutants map to cases.
- A mutant counts as killed only by the **visible** corpus or host tests; a held-out-only kill doesn't count (S3).

## 8. Stop, recursion and memory (daybreak3)

Rill is Python on the engine, so it inherits Sagebrush's interrupt model (design/reading-rust.md §10). Stop sets the shared flag, and compiled Python loops test it every iteration. R's `for`, `while` and `repeat`, the apply family, and every builtin's loop are such loops. Rust engine calls check through `sagebrush_interrupt::check()`.

A1 establishes the invariants below, with their pins, before A2 starts.

### 8.1 Conditions never swallow Stop

`tryCatch`, `try`, `withCallingHandlers`, `suppressWarnings` and `suppressMessages` catch only Rill's own condition classes: R errors, warnings, messages, and conditions created by `simpleCondition`/`signalCondition`. The implementation catches those Python classes by name. **No bare `except`, and no `except BaseException`/`Exception` around R code.** A census script fails the build on any.

`KeyboardInterrupt` (Stop) and `SystemExit` always propagate. R's own `interrupt` condition class is not offered to handlers, a documented difference: in R, `tryCatch(..., interrupt =)` can catch Ctrl-C.

### 8.2 `on.exit`: a stack per frame, run once, in order

- **The stack.** Each closure frame keeps a list of `on.exit` expressions; `add = TRUE` appends, and `after = FALSE` prepends, as R documents in `?on.exit`. When the frame exits (normal return, R error, or Stop), the list runs once, in order, from one `finally` in the frame's exit path. The list is taken from the frame before it runs, so no handler can run twice.
- **A handler that raises an R error** stops that frame's remaining handlers, and the error replaces the frame's outcome, as R does. Its text and order are recorded from the oracle in A1.
- **A second Stop during a handler** stops the remaining handlers, and Stop propagates. The interrupted frame's handlers are never resumed.
- **State.** Variables bound before Stop are kept, as in the other modes.

### 8.3 Replacement is transactional

A replacement (`x[i] <- v`, `names(x) <- n`, `df$col <- v`, `attr(x, "a") <- v`) runs in two parts:

1. **Prepare.** It evaluates every index, the value, each coercion and the result's shape, and builds the plan, all before any session-visible object changes.
2. **Publish.** It publishes the result in one step that no interrupt check can split.

The publish step takes one of two forms:

- **Multi-element replacements stage privately.** They build the new value in private storage, then rebind the target name, which is one environment store with no loop and so no interrupt check inside. Stop during staging leaves the old value byte for byte.
- **The in-place fast path is a single element.** `x[i] <- scalar` on an *unshared* vector (§10) stores one slot, again one store. Nothing larger is ever mutated in place, so the fast path never exposes a partial update. This is the case that matters for loops: it removes the $O(n^2)$ cost of `for (i in ...) x[i] <- ...`.

**Native kernels** (§10) write only to scratch or output storage they allocated. Rill publishes the result after the kernel returns successfully. A Stop inside a kernel unwinds through `sagebrush_interrupt` and leaves session-visible storage untouched.

**Ownership** follows R's "named" rule, in its simple sticky form:
- **Unshared:** a value is unshared only when it is fresh from a computation or a staging copy and bound to exactly one name.
- **Shared (permanently):** a value becomes shared, and stays shared until a copy is made, when it is:
  - bound to a second name;
  - passed as an argument (promise values);
  - stored in a list element, attribute, environment or data-frame column;
  - captured by a closure's environment;
  - returned from a function.
- Every transition is in one module (`values.py`), so it can be audited.

**Pins:**
- Stop midway through a multi-index replacement on a large vector;
- an aliased replacement (`y <- x; y[1:n] <- 0`);
- a replacement inside a function on an argument;
- a native-kernel operation.

Each pin checks that the original values are unchanged byte for byte and that the session still answers.

### 8.4 Recursion: the host stack must be protected by construction

A depth counter alone can't protect a recursive host evaluator: Python's recursion limit or the browser's JavaScript stack could fail first. Rill's evaluator therefore **does not recurse on the host stack for R calls**.

- **The explicit stack.** Closure application, promise forcing, and control flow (`{`, `if`, loops, `switch`, `&&`/`||`) run on an explicit continuation stack, as a trampoline. Deep R recursion grows a Python list, not the host stack.
- **Builtins that call back into R** (`sapply`, `lapply`, `Reduce`, `do.call`, `tryCatch`'s expression, `eval`, S3 dispatch from an internal generic) re-enter the trampoline. Each re-entry is a host segment, with a measured, fixed number of host frames per segment. The number of nested segments is bounded by a constant `S`, chosen in A1 from that measurement and the smallest host stack among the CLI's Node, Deno and Bun and the browsers, with margin.
- **What counts as depth.** Each closure application and each `eval`/promise-forcing level increments the R depth, compared against `getOption("expressions")`.
  - Valid values are R's documented 25–500000 (`?options`); the default is 5000.
  - Passing the R depth gives R's own message for runaway recursion.
  - Passing `S` first, possible only through deeply nested callbacks, gives R's own message for exhausted stack space, as R does when its C stack runs out.
  - Both texts are recorded from the oracle in A1. A host `RecursionError` or `RangeError` must never reach the user.
- **Pins**, in the CLI and in the browser: direct recursion (`f <- function(n) f(n + 1)`), mutual recursion, recursion through `sapply`, and `options(expressions = 100)`. Each must produce R's message, and the session must still answer afterwards.

### 8.5 Memory: reserve before allocating, in every host

Every allocation or growth site follows one discipline, a real refusal in every host, mapped to R's message afterwards:

1. **Size first.** Lengths, dimension products and byte counts are computed in Python integers, which can't overflow, before anything is allocated. A product past the host's limits (`matrix(0, 2^31, 2^31)`) is refused at that point.
2. **Charge the peak live storage** of the operation: the old value, the new or staging value, masks, index vectors, coercion temporaries and attributes. Per-element costs per storage kind (Python list of floats, NumPy array, strings) are measured per host in A1.
3. **Reserve, then release.** The charge is reserved against the session's allowance before allocating, and released in `finally` when the operation's temporaries die.
   - Where a host can't measure its memory (the browser's JavaScript heap today, as design/matlab.md records), Rill uses fixed, explicit caps instead: per object, per session and per operation's work. They are registered in the limits census and named in the refusal (`_memguard.memory_guard(..., fixed=True)` or `unmeasured=`).
   - Native and Wasm allocations go through the engine's own ledger.
4. **The message.** Refusals raise `SagebrushMemoryError` (lib/_memguard.py's one guard type). Rill maps it to R's own allocation-failure message, recorded from the oracle in A1, keeping Sagebrush's detail (need, allowance) on a following line.

**Pins:** the exact boundary, one past it, a product overflow, and Stop during an allocation, which must release its reservation.

### 8.6 Tests and integration

- `test/rill.test.ts` holds §8.1–§8.5's pins, each run in the CLI, with the Stop and recursion pins also in the browser through the web tests.
- Rill joins the `interrupt-matrix` modes list (scripts/web-tests.mjs, a test-side table, not a workflow file). Its cases cover Stop in a tight `while (TRUE)`, inside `sapply`, inside `tryCatch` (not caught), during `on.exit`, and in a long `lm`. Each is followed by a check that the session answers and keeps its variables.

## 9. Files, network and processes (astra)

Rill reaches files only through Sagebrush's Python file layer, so the existing per-document switches apply unchanged (design/capabilities.md, and William's two permissions, files and network, Nov 2):

**Files.**
- These all use Python's `open`/`os`, so the page's read gate and write gate decide. No Rill module touches the page or the workspace any other way:
  - reads: `read.csv`, `read.table`, `readLines`, `scan`, `file.exists`, `list.files`, `readRDS`;
  - writes: `write.csv`, `writeLines`, `cat(file =)`, `sink`, `saveRDS`, `file.remove`, `file.rename`, `dir.create`, `png()`/`svg()`/`pdf()` devices.
- Every notebook starts with file changes off, including the person's own (#822). Rill's first write raises the page's "wants to change your files" bar exactly as Python's does. Until the person allows changes, the R call fails with R's own write error.
- `file.rename` is a true rename through workspace ops, as Python's is.
- `setwd` is limited to the document's workspace.

**Network: off.**
- `url()`, `download.file`, `read.csv("https://…")` and `source("https://…")` fail with a Rill message saying the network is off for documents. Its exact text is quoted in the phase PR for the COPY check.
- `install.packages` explains what's built in.
- Nothing in Rill opens a network connection. When the network permission gains a first feature, these route through it.

**Processes.**
- `system()`, `system2()` and `shell()` are refused in phases A–D. Later they may use the same ShellHost as Python's `os.system` (just-bash), under the files permission, if William wants it (§12, question 2).
- `Sys.setenv` affects only the session.

**Output.**
- HTML and Markdown from Rill (Rmd preview, `knitr::kable`-like tables) go through `safeHtml`/`renderMarkdown` with `remote: false`.
- Plots are our own SVG.
- Rill must offer no API that emits script or reaches JavaScript.

**RILL-SEC-1: retained connections hold no lasting authority.**
- Opening a file connection (`file()`, `gzfile()`), starting a `sink()`, or selecting a graphics device (`png()`, `svg()`, `pdf()`) grants nothing that lasts.
- Every actual mutation goes through the existing file layer with the document's **current** permission and identity checks:
  - creating or truncating the file;
  - each buffered flush;
  - `close()`;
  - `sink()` output;
  - `dev.off()`'s final write;
  - writes done by `on.exit` cleanup.
- If changes are revoked, or the destination is moved, replaced or removed, an old connection must not be able to write with stale authority. Its next write fails with R's write error, and the file layer, not the connection, decides.
- Rill keeps no write-capable handle across calls: a connection holds its destination's identity and a buffer, not an open host file descriptor with write rights.
- Each write checks that the destination is still the **same file** (the workspace's file identity, not just its path). Reopening by a stored path is not enough: if the file was replaced, moved or removed, the write is refused.

**RILL-SEC-2: an `.Rmd` source is neither execution nor output authority.**
- Opening or previewing an `.Rmd`, reading its YAML front matter, chunk options or inline expressions **must not run code**. Execution follows the existing document Run policy: nothing runs on open, and running is the person's explicit action.
- Chunk options use a closed grammar of the supported options (§5.7). An option can't select:
  - a foreign engine (`engine = "python"`, `"bash"`, `"sql"`, …);
  - a shell or render hook;
  - a Python evaluator;
  - an external renderer;
  - a network destination.
  Such an option is reported as unsupported, and the chunk does not run.
- `results = "asis"` output, tables, chunk labels and figure captions, inline `` `r …` `` results, and SVG are all treated as document content and go through the same sanitizer and escaping (`safeHtml`/`renderMarkdown` with `remote: false`; labels escaped as text). No option turns that off.

**The R-only evaluator boundary, with negative controls.** `eval(parse(text = s))` must evaluate R inside Rill only. Rill must offer no escape to Python, and must not expose `py_run` or anything like reticulate. R values, environments, attributes and function lookup must never reach Python objects, module globals, imports, or foreign-call entry points:
- `.Call`, `.External`, `.C`, `.Internal`, `.Primitive` lookups by string;
- `get`/`mget`/`exists`, `as.environment`, `sys.function`, `environment()<-`.

Escape-shaped calls that Rill doesn't support fail before any effect. Supported R introspection returns ordinary Rill values, as R does, and never a host object: `environment(sum)` and `attr(x, "__class__")` give `NULL`, as in R. A1 ships negative-control pins:
- unsupported entry points give an R error and leave the session unchanged, for example `.Call("x")`, `.External("x")`, `.Internal(f())`, and `get("__import__")` (no such R object);
- legitimate introspection returns only R values, for example `environment(sum)`, `attr(x, "__class__")`, a crafted name in `as.name`, and `ls(environment(f))`.

**The gate inventory** (astra's audit) is generated from the code by a census script, like the arraybuffer census. It lists every Rill route to a file, a process or the host, with an explicit gated or refused decision for each. That includes indirect and deferred routes:
- `source()` and module loading;
- connections;
- sinks and devices;
- `on.exit` and finalizer cleanup;
- output and render hooks (Rmd);
- session environment access (`Sys.getenv`/`Sys.setenv`, `options`).

The census proves only that routes are listed. Behavioural pins prove the checks: the permission and refusal pins (files off and on, revocation mid-connection, network refusal, `system()` refusal, the escape negative controls) ship with the **first** host exposure of Rill (A1's CLI, then A2's notebook and worker), not later.

## 10. Performance

The spike measured, under load:
- homework programs run in about a second;
- a `for` step costs about 55 µs;
- `x[i] <- v` in a loop is $O(n^2)$, because each step copies;
- a uniform draw costs about 17 µs.

The plan, measured in each PR and always within §8's rules:

1. **Single-element in-place updates on unshared vectors** (§8.3's ownership rule). This removes the $O(n^2)$, in A1/A3. Multi-element replacements stage and publish, as §8.3 requires.
2. **Typed vector fast paths.** Long doubles and integers use NumPy arrays with NA masks for arithmetic, comparison, summaries and indexing.
   - The crossover length is chosen by measurement in each implementing PR; no number is frozen here.
   - Fast paths must keep R's coercion, NA handling and attributes exactly; the corpus runs both paths.
   - They obey §8.3 (scratch, then publish) and §8.5 (reserve the arrays and masks).
3. **Native kernels**, per William's principle that performance means Rust kernels per runtime: the Mersenne Twister, `sort`/`order`, `rowsum`/`tabulate`-class loops, and the QR.
   - Each is added only where measurements show the need.
   - Each reserves its scratch through the engine ledger, writes only to its own output, is interruptible (§8), and is published by Rill after success.

## 11. Integration checklist (each item a reviewed PR in phase A2)

- **Mode registry refactor (§5.1):** no behaviour change, its own PR.
- **The Rill row:**
  - CLI flag and extensions;
  - kernel `--mode rill`;
  - notebook and board worker flag;
  - `web/notebook/types.ts`;
  - the analyze worker (`src/dataflow.ts` gets Rill's def/use analysis, so reactive notebooks know which cells read which names);
  - `web/code/langs.ts` and `tokens.ts` highlighting;
  - the docsearch index `docs-index-rill.json`, our own one-line summaries plus examples run and compared like MATLAB's `doc_examples`;
  - completion;
  - examples.
- **A host test for each integration item:** the notebook, the Jupyter kernel, the board and the web worker each run at least one corpus case through that host, not only through the CLI.
- **Lazy groups and budgets (§6).**
- **Docs:** README's mode list, `llms.txt`, and capabilities.md's gate inventory.

## 12. Open questions

1. **Oracle packages: approved by @sagebrush (Nov 7).** When phases B–D start, `r-knitr`, `r-rmarkdown`, `r-ggplot2`, `r-dplyr` and `r-tibble` go into VM4 `~/sbm-r` only (micromamba, home only, as R itself). They stay black boxes: their source is never read or printed. Before installing, run the VM checklist (no QUARANTINE marker, `lsof -w`, `df` on the exact path). Their versions are recorded in `rill-tests/` provenance.
2. **`system()` (for William; @sagebrush has asked).** Should R's `system()` use the just-bash ShellHost, as Python's `os.system` does? Until he answers it stays refused, the least complex default.
3. **Rmd output formats (for William; @sagebrush has asked).** Beyond HTML, which comes first: PDF through the LaTeX pipeline, or slides (`beamer_presentation` or HTML slides)?
4. **Order of A2 and A3 (lanes).** A2 (in the product) comes before the bulk of builtins, so teachers can try Rill early. The conditions given in the design verdicts are folded in:
   - daybreak2: A1 already sets the final routing and budget names, and A2 keeps a minimal, measured first-cell start;
   - daybreak3: A1's corpus and §8's invariants are green, the registry lands alone first, and no eager Rill import or unmeasured core cost is added;
   - astra: the registry refactor stays a separate review, and the host permission pins ship with the first exposed host.
   - grader: each A2 integration item carries its own host test (§11).

## 13. Estimate

From the spike report, refined by this design:

| Phases | Estimate |
|---|---|
| A (MVP base R in every host) | 14–18 agent-weeks |
| B (`.Rmd` and `\rill` in LaTeX) | 2–3 agent-weeks |
| C (ggplot2) | 3–4 agent-weeks |
| D (dplyr with tibble printing) | 3–4 agent-weeks |

Each phase ends with its held-out score reported, and with no known corpus difference left unexplained in `KNOWN.json`.
