# An R-language mode for Sagebrush: feasibility spike

@sagebrush-magma, Nov 6–7 2026. Assignment: William via @sagebrush (Nov 6, 5:49 PM PST).
Working name: **Rill** (`--rill`, `.R` files). William picks the final name.

## In plain words

It is feasible. Intro-statistics R maps well onto what Sagebrush already has, and R's printed output can be reproduced byte for byte.

In about half a day I built a working prototype: four Python modules in the engine plus a `--rill` CLI flag. Every case is compared byte for byte (stdout plus error status) against real R 4.5.3:
- **Main corpus, 254 cases:** **252** exact. I tuned the prototype against these outputs. The 2 misses are `sample()` streams that I deliberately left out (see licensing).
- **Held-out corpus, 110 cases:** written after the prototype passed the main corpus, and scored before any fix.
  - First attempt: **95 exact (86%)**.
  - After about 30 minutes of fixes: **105 (95%)**.
  - Of the first-attempt misses, 6 were functions not written yet, 6 were small formatting or semantics bugs, and 3 are layout rules R doesn't document.

Exact agreement covers `[1]`-prefixed vector printing with wrapping, named vectors, factors, lists, matrices, data frames, `summary()`, the whole `summary(lm(...))` layout with significance stars, `glm` printing, and `t.test`/`chisq.test`/`prop.test`/`binom.test`/`cor.test` output.

**`set.seed()` reproducibility:** `set.seed(n); runif(...)` and `set.seed(n); rnorm(...)` give **bit-identical streams**. They were derived only from R's outputs; see section 5 for how, and for the question this raises.

**MVP estimate: 14–18 agent-weeks** (one agent), or 16–21 including a ggplot2 subset. R is broader than the Sprig spike's language: there are more functions in common use, the printing has a long tail, and people expect base graphics, `read.csv` and seeded random numbers. The language core is the smaller part.

## Ground rules followed

- **R used only as a black box.** R 4.5.3 (conda-forge `r-base`, via micromamba) is installed in my home directory on VM4 (`~/sbm-r`), not system-wide.
  - Each case is fed to `Rscript --vanilla -` on stdin, and stdout and stderr are recorded (`oracle.py`).
  - R help pages were read as text through `tools::Rd2txt` (`rhelp.sh`): `?RNG`, `?Normal`, `?sample`, `?summary` and `?zapsmall`.
- **No R source code was read:** no C, Fortran or R-level code.
  - No function was ever printed, and `body`, `deparse`, `getAnywhere`, `edit` and `View` were never called on a function.
  - The only R values inspected were data: `.Random.seed`, outputs printed with `sprintf("%.17g")`, and `write.csv(mtcars)`/`write.csv(iris)`.
- **No CRAN package was installed or used.**
- **No Codex.** The code is new and Sagebrush's own.

## 1. What "standard intro-stats R" means (survey)

Drawn from the material common to first statistics courses (OpenIntro-style labs and typical Stat 101 homework):

| Area | What students write |
|---|---|
| Vectors | `c()`, `:`, `seq`, `rep`, arithmetic with recycling, indexing (positive, negative, logical, by name), `length`, `sort`/`order`/`rev`, `which`, `cumsum`, `round` |
| Missing values | `NA` in arithmetic and comparison, `is.na`, `na.rm = TRUE`, `complete.cases`, `NaN`/`Inf` |
| Data frames | `data.frame`, `$`, `df[rows, cols]`, `subset`, `order`, `head`/`str`/`summary`, new columns, built-in data (`mtcars`, `iris`, …), `read.csv` |
| Factors | `factor`/`levels`/`table`/`prop.table`, `cut`, `tapply`, `aggregate`, ordered factors |
| Descriptive statistics | `mean`/`median`/`var`/`sd`/`quantile`/`summary`/`IQR`/`cor`/`scale`/`fivenum` |
| Distributions | `d`/`p`/`q`/`r` for `norm`, `binom`, `pois`, `t`, `chisq`, `f`, `unif`, `exp` (sometimes `gamma`, `beta`), with `lower.tail` |
| Inference | `t.test` (one-sample, two-sample, Welch, paired, formula), `prop.test`, `binom.test`, `chisq.test`, `cor.test`; later `wilcox.test`, `aov`/`TukeyHSD`, `shapiro.test` |
| Models | `lm` + `summary`/`coef`/`predict`/`confint`/`anova`/`residuals`; logistic `glm`; formulas with `+`, `I()`, `factor()` |
| Programming | functions with defaults, `if`/`for`/`while`, `sapply`/`lapply`/`apply`/`tapply`, `paste`/`sprintf`/`cat` |
| Graphics | `hist`, `boxplot`, `plot` + `abline`, `barplot`, `qqnorm`/`qqline`; often ggplot2 basics (`ggplot(aes()) + geom_point()`) |
| Printing | the auto-printed value of every top-level expression; this is most of what "feels like R" |

## 2. How it maps onto our pieces, and what's missing

| R piece | Sagebrush piece | Status |
|---|---|---|
| Parser, evaluator, printer | New, in Python in the engine (as Sprig is), so it runs the same in the CLI, the kernel and the web worker | done for the slice |
| Vectors (typed, `NA`, attributes) | Python lists in the prototype. numpy has no integer/logical NA, so numpy needs masks if used. | done; performance work needed (section 4) |
| `p`/`q` distribution functions | `scipy.special` (`betainc`, `gammainc` and their inverses), `scipy.stats.t.ppf`, `statistics.NormalDist` (AS 241) | done: norm, binom, pois, t, chisq, f, unif, exp, gamma, beta |
| Distributions we don't have | `scipy.stats` lacks noncentral t/F/chi², `ptukey` (for `TukeyHSD`), `psignrank`/`pwilcox`, and Shapiro–Wilk | missing (also gaps for Python mode) |
| Linear models | Own Householder QR (agrees to every printed digit). `numpy.linalg` has `qr`/`lstsq`/`solve` too. | `lm`/`glm` (binomial, poisson) done; rank-deficient fits (aliased `NA` coefficients) and interactions missing |
| Formulas | Part of the R grammar; model matrix with treatment contrasts for factors, `I()` and `.` | done for main effects; `a:b`, `a*b`, `poly()` and `offset()` missing |
| Data frames | Own (row names, factors and the print layout are R-specific). The optional pandas package isn't needed; its CSV parser could serve `read.csv`. | done for the slice; `read.csv`, `merge` and wide-frame wrapping missing |
| Datasets | Data values only (`mtcars`, `iris`), in `lib/_rill_data.py` | the other ~100 `datasets` sets missing |
| RNG | Own Mersenne Twister with R's seeding (section 5) | `runif`/`rnorm` exact; `sample`/`rbinom`/`rpois` streams differ |
| Graphics | `lib/matplotlib` (`pyplot`) and `sage_plot` | not started. Base graphics map onto `pyplot` calls; ggplot2 is its own grammar layer. |
| REPL | `_rill.is_incomplete(src)` exists for the continuation prompt, the same hook as the `--magma`/`--matlab` REPL (#651) | not wired into `src/interactive.ts` |

## 3. The prototype

**Branch:** `spike-r-mode` (not a PR).
- `lib/_rill.py`:
  - the values (`Vec`, `RList`, attributes);
  - the lexer and a Pratt parser with R's operator table (from `?Syntax`);
  - the evaluator, with promises (lazy arguments), `...`, R's three-pass argument matching, closures, `<<-`, and replacement functions (`f(x) <- v` as `` x <- `f<-`(x, value = v) ``, nested);
  - `UseMethod` S3 dispatch, `substitute`/`quote`/`missing`/`match.call`, `tryCatch`, and top-level auto-printing with R's visibility rules.
- `lib/_rill_fmt.py`: R's number formatting (common significant digits, the fixed-or-scientific choice with `scipen`), the print layouts, `deparse` with R's line breaking, `cat`/`format`/`sprintf`/`formatC`, and `str`.
- `lib/_rill_base.py`: about 230 base builtins (arithmetic with recycling and NA, indexing and replacement, strings, factors, the apply family, matrices, data frames).
- `lib/_rill_stats.py`: summaries, distributions, the RNG, the five tests with `print.htest`, `lm`/`glm` with their `summary` printing, `anova`, `confint`, `predict` and `aggregate`.
- `lib/_rill_data.py`: `mtcars` and `iris` data values.
- `src/cli.ts`: `--rill`, and `.R`/`.r` files, run `_rill.run(src)` (about 15 lines, the Sprig pattern).

In all: 343 builtins and 17 S3 methods, about 6,400 non-blank lines (250 KB of source). The CLI bundle grows by about 80 KB. In the web build it would be a lazy chunk with a growth marker.

```
$ sagebrush homework.R
   Min. 1st Qu.  Median    Mean 3rd Qu.    Max. 
  10.40   15.43   19.20   20.09   22.80   33.90 

 4  6  8 
11  7 14 
       4        6        8 
26.66364 19.74286 15.10000 

	Welch Two Sample t-test

data:  mpg by am
t = -3.7671, df = 18.332, p-value = 0.001374
...
```

The whole output of `homework.R` (a 12-statement lab: `summary`, `table`, `tapply`, formula `t.test`, `summary(lm(mpg ~ wt + hp))`, `predict`, seeded `rnorm`) is **byte-identical** to `Rscript homework.R`.

### Checked against real R

`oracle.py` (on VM4) runs each case in a fresh R session. `compare.py` runs the same case in a fresh `sagebrush --rill` process and compares:
- **EXACT** means stdout is byte-identical and the error status agrees.
- When both fail, the first `Error` line of stderr must match too.

| Corpus | Cases | Exact | Differ |
|---|---|---|---|
| `corpus.R` (main; prototype tuned against it) | 254 | **252** | 2 (`sample()`, withheld) |
| `corpus2.R` (held out), first attempt | 110 | **95** | 15 |
| `corpus2.R`, after fixes | 110 | **105** | 5 |

The 15 held-out misses at first attempt (`results2-first.tsv`):

| Kind | Cases | Fixed in the spike? |
|---|---|---|
| Function not written yet | `prop.table` ×2, `confint`, `complete.cases`, `boxplot.stats`, formula `t.test(y ~ g)` | yes, all |
| Semantics bugs | `which.max` lost a 1-D table's names; ordered-factor `<`; `round()`/arithmetic dropped the `table` class | yes |
| Print detail | `summary.lm` shows all residuals when the residual df is ≤ 5; joint formatting of the p-value column; `zapsmall()` before `summary()` printing (documented in `?summary`) | yes |
| Undocumented layout rules | 2-D `table()` header lines; `summary(data.frame)` column-name centring and line wrapping; `str()` truncation counts | no (open) |
| Numerical noise | `solve(A) %*% A` shows `6.661338e-16` against our `8.881784e-16` (LAPACK's elimination order) | no |

All 7 remaining misses are in `results.tsv` and `results2.tsv`.

**About the numbers.** The main corpus measures "can it be done". The held-out first attempt, 86%, is the honest estimate of how a fresh homework snippet fares today. Most first-attempt misses were functions not written yet, not design problems.

### Timings

The project had a load average of 22–28, so these are relative only; best of 5.

| | ms |
|---|---|
| `sagebrush -c pass` (engine start) | 591 |
| `sagebrush --rill -c '1 + 1'` | 723 |
| `sagebrush --rill -c 'summary(lm(mpg ~ wt, data = mtcars))'` | 1,025 |
| `sagebrush homework.R` (12 statements, above) | 1,105 |
| a 20,000-step `for` loop | 1,828 (about 55 µs per step) |
| `x[i] <- i^2` for 2,000 steps | 1,510 (copies `x` each time; section 4) |
| `runif(1e5)` | 2,453 (pure-Python Mersenne Twister, about 17 µs per draw) |
| Real R, `Rscript -e` with any of the above (idle VM4, for scale) | 157–182 |

The mode's import costs about 130 ms on top of the engine. Homework-sized programs run in about a second. Loops and vectors of $10^5$ elements are 10–100× slower than R, so they need fast paths.

## 4. The hard parts

1. **Lazy evaluation and non-standard evaluation.** Promises are cheap to build and work in the prototype. They are what make these work:
   - the `Call:` line of `lm`;
   - `data:  x and y` in `t.test`;
   - column names from `data.frame(x, y)`;
   - `substitute`, `missing` and `with`/`subset`.

   The long tail is the tidyverse: dplyr's "tidy evaluation" (quosures, data masking) is a second evaluation model on top. Supporting `dplyr` verbs is a separate project, about 3–4 weeks.
2. **Copy-on-modify.** The semantics are easy: replacement functions copy, so `y <- x; y[1] <- 100` leaves `x` alone (tested). The cost is the problem:
   - `x[i] <- v` in a loop is $O(n^2)$.
   - R avoids that with reference counts.
   - We need a "shared" flag on vectors and in-place updates when they are unshared. That is about a week, and it touches every replacement function.
3. **S3/S4.** `UseMethod` and user-defined `print.myclass` work. Still missing:
   - `NextMethod`;
   - group generics (`Ops`, `Math`, `Summary` for classes);
   - S4 (`setClass`/`new`), which is rare in intro courses;
   - R5/R6 classes.
4. **Formula semantics.** These are needed for real data:
   - `terms` objects and `model.frame` with `NA` handling (`na.omit`);
   - `subset=` and `weights=`;
   - interactions and contrasts;
   - rank-deficient fits, which R reports as `NA` coefficients and which need a pivoting QR with a rank tolerance.

   The prototype covers main effects, factors and `I()`.
5. **RNG streams.** `set.seed` + `runif`/`rnorm` are exact. Each other generator (`sample`'s rejection sampling, `rbinom`, `rpois`, `rexp`, `rgamma`, …) is its own algorithm that must match bit for bit, or seeded homework answers differ. This is also a licensing question (section 5).
6. **Printing.** This is the biggest "feels like R" item, and it went better than expected: the core algorithms (common significant digits, fixed or scientific, column layouts, `printCoefmat`-style tables) are regular, and are reproduced exactly here. The tail:
   - 2-D tables, `str()`, `summary(data.frame)`, wide data frames and long factors;
   - `options(digits = )`;
   - UTF-8 display widths;
   - warnings printed after each top-level call.
7. **Errors and warnings.** Missing pieces:
   - `Error in f(x) :` formats with the call;
   - deferred `Warning message:` blocks;
   - `withCallingHandlers`, `warning()` → `tryCatch`, `on.exit`.

   The prototype has the simple forms.
8. **Performance.** A tree-walking interpreter in Python on our engine is fine at homework sizes. Vector operations on $10^5$ elements and RNG draws need fast paths: numpy-backed vectors with NA masks, and a native MT.
9. **Packages.** People type `library(ggplot2)` and `library(dplyr)`.
   - A sufficiently complete interpreter could load pure-R CRAN packages' code (their own licences then apply when we distribute them).
   - Packages with compiled C/C++ (Rcpp) cannot run.
   - Realistically we would reimplement a small subset of ggplot2 and dplyr, and say so.

## 5. Licensing notes

- **R is GPL-2/GPL-3. This spike used only its documentation and black-box outputs.** The help pages are GPL documents too: reading them is fine, copying their text into our docs is not. Our docs must be our own words.
- **Output formats and messages.** The prototype reproduces short output strings that are part of R's observable behaviour:
  - `Welch Two Sample t-test`;
  - the `Signif. codes:` legend;
  - error texts such as `object 'x' not found`.

  This is interoperability, as MATLAB mode reproduces Octave/MATLAB output. I flag it for William, not as a blocker.
- **The RNG needs a ruling.** What was done:
  - `set.seed(s)` fills the Mersenne Twister state with successive values of $x \mapsto 69069x + 1 \pmod{2^{32}}$, starting 52 steps after $s$.
    - $a$ and $c$ were solved from `.Random.seed`, and 52 was found by search. The fit holds for all 623 steps for 4 seeds.
    - `runif` is the published MT19937 output times $2^{-32}$.
    - `rnorm` is $\Phi^{-1}\big((\lfloor 2^{27}u_1\rfloor + u_2)/2^{27}\big)$. The exponent was found by searching 16–32: only 27 matches, on 200 of 200 draws, bit for bit.
    - The *forms* of these hypotheses came from general knowledge; the parameters were fitted to outputs. Evidence: `seeds.txt`, `rnorm42.txt`.
  - For **`sample()`** I tested one hypothesis (bits assembled from 16-bit chunks, with rejection). It reproduces R's streams. But that hypothesis came from my prior knowledge, not from a search over outputs, so I **did not put it in the prototype**.
  - **Recommendation:** use a two-person clean room for compatibility-sensitive algorithms. One agent writes a specification from outputs and published papers only; another implements it from the spec. Or William rules that output-fitting is acceptable as it stands.
- **Datasets.** `mtcars` (Motor Trend, 1974) and `iris` (Anderson 1935; Fisher 1936) are published data. Only their values were taken (via `write.csv`). Each further dataset should be checked for its source.
- **Name.** "R" is the R Foundation's. "Rill" avoids using it as our product name. Saying "runs R code" is descriptive use, but that wording is William's call. `.R` as a file extension is an interoperability convention.

## 6. MVP estimate

MVP means: the CLI, REPL, Jupyter kernel and web notebook mode; R chunks in LaTeX documents; the coverage of section 1 except ggplot2; and recorded R outputs in CI (R itself stays off the shared image).

| Work | Estimate |
|---|---|
| Language core: full grammar (raw strings, complex numbers), environments (`parent.frame`, `local`, `on.exit`), `NextMethod` and group generics, the conditions system and R's error and warning texts | 2–3 weeks |
| Base and stats builtins: about 300 functions, each with recorded-R tests | 3–4 weeks |
| Printing tail: tables, `str`, `summary.data.frame`, wide data frames, `options(digits)` | 1.5–2 weeks |
| Models: pivoting QR and aliasing, `model.frame` and `NA` handling, interactions, `anova`/`aov`/`TukeyHSD`, `predict` intervals, the glm families | 1.5–2 weeks |
| RNG generators (after the ruling) and the missing distributions | 1 week |
| Base graphics on our plotting layer (`hist`, `boxplot`, `plot`, `abline`, `barplot`, `qqnorm`, `legend`) | 1.5–2 weeks |
| I/O and data: `read.csv`/`write.csv`, the `datasets` values | 1 week |
| Performance: reference-counted copy-on-modify, numpy-backed fast paths, a native MT | 1 week |
| Integration: `kernel.ts` mode, web worker lazy chunk, REPL, completion, docsearch, examples, the LaTeX chunk hook | 1 week |
| Test infrastructure: `r-tests/` with recorded outputs, as `matlab-tests/` has Octave's | 0.5–1 week |
| **Total** | **14–18 agent-weeks**; ggplot2 subset +2–3; dplyr verbs +3–4 |

Two agents could split it: language and printing in one lane, statistics, models and graphics in the other.

## 7. Open questions for William

1. **RNG compatibility.** May we ship `set.seed` streams derived from outputs (`runif`/`rnorm`, done)? For `sample`/`rbinom`/`rpois`, should we use a formal two-person clean-room derivation, or accept non-identical seeded streams (which means homework answers that differ from R's)?
2. **Goal.** A teaching-grade R (homework, labs, notebooks), or a fallback for CoCalc's R users when CoCalc's R breaks? The second needs much higher fidelity (packages, `read.csv` of arbitrary files, graphics), so the scope differs.
3. **Graphics and packages.** Base graphics only, or a ggplot2 subset? Any tidyverse (`dplyr`, pipes on data frames)?
4. **The name** (Rill is the working name), and whether we claim `.R`/`.Rmd` files and R chunks in documents by default.
5. **The oracle in CI.** Recorded outputs generated on a VM, as MATLAB mode does with Octave? R stays off the shared image.

## Files

Everything is in `/scratch/sagebrush-reviews/r-spike/`, frozen with `SHA256SUMS`, and on the branch under `design/r-spike/`:
- `REPORT.md`: this report.
- `corpus.R`, `corpus2.R`: the cases.
- `oracle.json`, `oracle2.json`: R 4.5.3's outputs, with stdout, stderr and exit status per case.
- `results.tsv`, `results2.tsv`, `results2-first.tsv`: verdict, id, code, R output, Rill output.
- `oracle.py`, `compare.py`, `rhelp.sh`: the harness.
- `homework.R`: the demo above.
- `seeds.txt`, `rnorm42.txt`: the RNG evidence (outputs only).
- `datasets.csv`: the data values taken.

**To reproduce:**
1. Build the branch (`tsc -p . && node scripts/build-cli.mjs`).
2. On a machine with R, run `python3 oracle.py Rscript corpus.R > oracle.json`.
3. Run `python3 compare.py cli <sagebrush> oracle.json > results.tsv`.
