# Rill: an R-language mode (R0 design)

*Status: design for review (R0). Author @sagebrush-magma, Nov 7 2026. Reviewers: all five lanes. Daybreak2 reviews size (§6), daybreak3 the engine and Stop (§8), astra sandboxing (§9), grader the tests (§7), board the copy. No product code lands before DESIGN CLEAR. After that, code comes in the small phased PRs of §3, each through all five lanes.*

## In plain words

Rill runs R, the statistics language, in Sagebrush: on the command line, in notebooks and Jupyter, and in documents. The first target is the R that students and teachers write: vectors, data frames, factors, summaries, distributions, tests, linear models and plots. Then R Markdown documents (`.Rmd`), then ggplot2, then dplyr.

Rill is new code, written from R's documentation and checked against real R as a black box. It is a Python package that runs on Sagebrush's engine, as the Magma and MATLAB modes do. So it works the same in the CLI, the kernel and the browser, needs no install, and costs other modes nothing: the browser fetches it only when a Rill session starts.

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
- **No Codex.**
- **Each oracle-derived algorithm records its provenance in its PR**, as the RNG section of the spike report does: what was observed, and what was fitted. For example: the RNG seeding and generators, `pretty()`, `format.pval`, and the column-header rules.
- **Dataset values come with their published sources** (§5.6).

## 3. Scope and phases

The order is least complex first, and each phase is useful on its own. A phase is several PRs of at most about 1,500 product lines each. Each PR carries its corpus cases (§7), passes all five lanes, and lands before the next one builds on it.

| Phase | What | Done when |
|---|---|---|
| **A1 Core** | The package skeleton (§4); the full R grammar; the evaluator: promises, environments, R's three-pass argument matching, closures, replacement functions, `UseMethod`/`NextMethod`/group generics, conditions (`stop`, `warning`, `tryCatch`, `withCallingHandlers`, `on.exit`); the printing core (vectors, named vectors, factors, lists, matrices, data frames, `str`); `sagebrush --rill`, `.R` files, and the REPL with continuation (`_rill.is_incomplete`) | The language and printing corpus is exact |
| **A2 In the product** | The mode registry (§5.1) and Rill in the notebook, the Jupyter kernel (`--mode rill`), boards, the web worker as a lazy group (§6), completion and docsearch (our own one-line summaries) | A notebook cell runs R; other modes' bundles are unchanged |
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
| `_rill/datasets.py` | Dataset values, loaded on first reference (§5.6) |
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
- `rill-tests/test_*.R` with recorded `.out` files (§7);
- `test/rill-corpus.test.ts`, which replays the corpus;
- `test/rill.test.ts`, for host behaviour: the REPL, the kernel, Stop and the gates.

## 5. Design details

### 5.1 A mode registry instead of a fifth copy

Today a mode's name is a string union repeated in 32 files: 9 under `src/` and 23 under `web/`, for example `Mode = "sage" | "python" | "magma" | "matlab"` in `src/kernel.ts`, `src/reactive-session.ts`, `web/notebook/types.ts` and `web/latex/cells.ts`. Adding "rill" to each copy invites drift.

A2 first adds `src/modes.ts`. It holds one table: each mode's name, its label, its file extensions, its kernel `language_info`, the worker message flag, its library start and its completion hook. The existing unions derive from it with no behaviour change, and that refactor is reviewed as its own PR. Rill is then one row.

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
- **Chunk options, first set:** `echo`, `eval`, `include`, `results` ("markup", "asis", "hide"), `message`, `warning`, `error`, `collapse`, `comment` (default `"##"`, as knitr prefixes output lines), `fig.width`, `fig.height`, `fig.cap`, `label`. An unknown option is kept and reported; it is never silently ignored.
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

`library(ggplot2)` and `library(dplyr)` attach our implementations. `library(other)` gives R's "there is no package called 'other'". `install.packages` explains that Rill provides base, stats, graphics, utils, datasets, ggplot2 and dplyr built in.

## 6. Lazy loading and size (daybreak2)

- **Other modes pay nothing.** Rill is not in the core:
  - `web/lib-chunks.mts` gets a `rill` start (`["--rill", "-c", "1"]` in web/build.ts's `STARTS`) and `"rill"` in `START_ORDER`. The modules Rill's start imports form the `rill` group (src + pre chunks), fetched when a Rill session starts (`modes.rill`).
  - Files no start imports form `rill-more` and lazy families: `mod-rill-ggplot2`, `mod-rill-dplyr` and `rill-data`, each fetched on first import.
  - The preload table (`web/preload.ts`) and the offline inventory follow from the manifest, as for Magma and MATLAB.
- **The CLI** embeds Rill's files like the other modes' (`lib.gen.js`). If CLI growth matters, Rill's later families can be embedded lazily as `scripts/lazy-lib.mjs` does for pathlib.
- **Budgets:**
  - Each new group gets its own `budgets.json` rows (new rows, ceiling `floor(1.1 × size)`), not core growth.
  - The core rows grow only by the TypeScript wiring and the CLI's embedded sources. Each PR carries a tight growth marker, measured with the exact pull_request gate (Node 24.21.0, bun 1.4.4, equal-length paths) against current master.
- **The estimate:**
  - The spike was about 250 KB of source for the MVP slice. A complete phase A is estimated at 600–800 KB of source; with the precompiled chunk at about 5× source (as `magma.pre` is to `magma.src`), about 3–4 MB fetched once, only by Rill sessions.
  - ggplot2 and dplyr are separate lazy groups, about 200–300 KB of source each.
  - Each PR reports its measured numbers.
- **Startup:** the spike measured about 130 ms for the mode's import over the engine's start. A2 records it in the PR, and keeps the `rill` start group to what the first cell needs.

## 7. Tests: a corpus of recorded R outputs (grader)

### 7.1 The corpus

**Layout.** `rill-tests/test_<area>_<n>.R` holds the cases, and `rill-tests/test_<area>_<n>.out` holds R 4.5.3's recorded output.

**Recording.** `rill-tests/run.py --regen` runs `oracle.py` on VM4 over ssh: one fresh `Rscript --vanilla -` per case, recording stdout, stderr and the exit status. It never runs in CI.

**Comparing.** `test/rill-corpus.test.ts` replays every case through the built CLI. It compares stdout byte for byte, the exit status, and the first `Error` line, as the spike's `compare.py` does. It is a node test, so the existing `node-tests` shards run it: CI needs **no workflow-file change** (agents never push those). `scripts/ci-paths.mjs` maps `rill-tests/` and `lib/_rill/` to the node suites.

**Seed.** The spike's 364 cases (`corpus.R`, `corpus2.R`), split by area. Every PR adds the cases for what it implements, recorded before the code is written.

**Known differences.** `rill-tests/KNOWN.md` lists each case we knowingly don't match, with the reason: an undocumented layout not yet derived, an unmatched RNG stream, or LAPACK rounding. A case leaves the list only by becoming exact.

### 7.2 Held-out discipline

Each phase sets aside a held-out file, written before the phase's code. It is scored at the phase's end and reported, as the spike's 86% first-attempt figure was, so the corpus can't only measure what was tuned against it.

### 7.3 Plots and documents

- **Graphics:** R's computed values (§5.5) as corpus cases, plus SVG description snapshots of ours.
- **ggplot2:** `ggplot_build(p)$data` and `layer_scales` outputs, printed by the oracle.
- **Rmd:** knitr's markdown output for each test document, recorded from the oracle (§12, question 1), against our knit's markdown.

### 7.4 Mutants

Grader's mutant runs apply per PR, as for every lane: each new rule has a pin that kills its mutant, or the mutant is shown equivalent.

## 8. Stop and interrupts (daybreak3)

Rill is Python on the engine, so it inherits Sagebrush's interrupt model (design/reading-rust.md §10). Stop sets the shared flag, and compiled Python loops test it every iteration. R's `for`, `while` and `repeat`, the apply family, and every builtin's loop are such loops. Rust engine calls check through `sagebrush_interrupt::check()`.

Rill adds these rules:

1. **No R construct swallows Stop.** `tryCatch`, `try`, `withCallingHandlers` and `suppressWarnings` catch R conditions (`RError`, warnings, messages). They never catch `KeyboardInterrupt` or `SystemExit`. MATLAB mode's `try/catch` follows the same rule. R's own `interrupt` condition class is not offered to handlers, a documented difference: in R, `tryCatch(..., interrupt =)` can catch Ctrl-C.
2. **`on.exit` handlers run on Stop.** They are implemented with Python's `finally`, so files are closed and `par()` is restored. A second Stop during an `on.exit` handler stops it too.
3. **State survives.** Variables defined before Stop are kept, as in the other modes. A replacement function interrupted mid-way leaves the old value, because replacement copies and then rebinds (copy-on-modify), so there is never a half-updated object.
4. **Deep recursion is an R error, not a crash.** R's `expressions` limit (5000) maps to a Rill depth bound checked in the evaluator, below the engine's stack limit. Passing it gives R's message ("evaluation nested too deeply: infinite recursion / options(expressions=)?"). `test/rill.test.ts` pins it.
5. **Allocations are bounded before they happen.** For example `rep(0, 1e10)` or `matrix(0, 1e6, 1e6)` are refused before allocating, with R's "cannot allocate vector of size …" message. The bound is the session's memory accounting, as MATLAB's LU uses it. Any new limit is registered in the limits census.
6. **Tests:** `test/rill.test.ts` pins Stop in a tight `while (TRUE)`, inside `sapply`, inside `tryCatch` (not caught), during `on.exit`, and in a long `lm`. Each run is followed by a check that the session still answers and keeps its variables. Rill is added to the `interrupt-matrix` modes list, which is a test-side table, not a workflow file.

## 9. Sandboxing: Files and Network (astra)

Rill reaches files only through Sagebrush's Python file layer, so the existing per-document switches apply unchanged (design/capabilities.md, and William's two permissions, files and network, Nov 2):

**Files.**
- These all use Python's `open`/`os`, so the page's read gate and write gate decide. No Rill module touches the page or the workspace any other way:
  - reads: `read.csv`, `read.table`, `readLines`, `scan`, `file.exists`, `list.files`, `readRDS`;
  - writes: `write.csv`, `writeLines`, `cat(file =)`, `sink`, `saveRDS`, `file.remove`, `file.rename`, `dir.create`, `png()`/`svg()`/`pdf()` devices.
- Every notebook starts with file changes off, including the person's own (#822, confinement 1b). Rill's first write raises the page's "wants to change your files" bar exactly as Python's does. Until the person allows changes, the R call fails with R's own write error.
- `file.rename` is a true rename through workspace ops, as Python's is.
- `setwd` is limited to the document's workspace.

**Network: off.**
- `url()`, `download.file`, `read.csv("https://…")` and `source("https://…")` fail with a clear Rill message saying the network is off for documents.
- `install.packages` explains what's built in.
- Nothing in Rill opens a connection. When the network permission gains a first feature, these route through it.

**Processes.**
- `system()`, `system2()` and `shell()` are refused in phases A–D. Later they may use the same ShellHost as Python's `os.system` (just-bash), under the files permission, if William wants it (§12, question 2).
- `Sys.setenv` affects only the session.

**Output.**
- HTML and Markdown from Rill (Rmd preview, `knitr::kable`-like tables) go through `safeHtml`/`renderMarkdown` with `remote: false`.
- Plots are our own SVG.
- No Rill API can emit script or reach JavaScript.

**`eval(parse(text = s))`** evaluates R inside Rill only: there is no escape to Python. Rill never exposes `py_run` or anything like reticulate.

**The gate inventory** (astra's audit) lists every Rill function that reaches a file or a process, generated from the code by a census script, like the arraybuffer census.

## 10. Performance

The spike measured, under load:
- homework programs run in about a second;
- a `for` step costs about 55 µs;
- `x[i] <- v` in a loop is $O(n^2)$, because each step copies;
- a uniform draw costs about 17 µs.

The plan, measured in each PR:

1. **Copy-on-modify with reference counts.** A vector records whether it is shared, and replacement functions update an unshared vector in place. This is R's own strategy, and it removes the $O(n^2)$ (phase A1/A3).
2. **Typed vector fast paths.** Doubles and integers of more than about 1,000 elements use numpy arrays with NA masks for arithmetic, comparison, summaries and indexing. Short vectors stay on lists.
3. **Native kernels**, per William's principle that performance means Rust kernels per runtime: the Mersenne Twister, `sort`/`order`, `rowsum`/`tabulate`-class loops, and the QR. These are added to the engine only where measurements show the need, and are interruptible (§8).

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
- **Lazy groups and budgets (§6).**
- **Docs:** README's mode list, `llms.txt`, and capabilities.md's gate inventory.

## 12. Open questions

1. **Oracle packages (for @sagebrush).** May I install `r-knitr`, `r-rmarkdown`, `r-ggplot2`, `r-dplyr` and `r-tibble` into VM4 `~/sbm-r` (micromamba, home only, as R itself), when phases B–D start, so they can be recorded as black boxes?
2. **`system()` (for William).** Should R's `system()` use the just-bash ShellHost, as Python's `os.system` does, or stay refused?
3. **Rmd output formats (for William).** Beyond HTML, which comes first: PDF through the LaTeX pipeline, or slides (`beamer_presentation` or HTML slides)?
4. **Order of A2 and A3 (for the lanes).** A2 (in the product) comes before the bulk of builtins, so teachers can try Rill early. Is that the order you want?

## 13. Estimate

From the spike report, refined by this design:

| Phases | Estimate |
|---|---|
| A (MVP base R in every host) | 14–18 agent-weeks |
| B (`.Rmd` and `\rill` in LaTeX) | 2–3 weeks |
| C (ggplot2) | 3–4 weeks |
| D (dplyr with tibble printing) | 3–4 weeks |

Each phase ends with its held-out score reported, and with no known corpus difference left unexplained in `KNOWN.md`.
