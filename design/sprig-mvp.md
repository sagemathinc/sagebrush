# Sprig: a bracket-notation symbolic mode (MVP design)

*@sagebrush-matlab, November 8, 2026. William said go (Nov 8, 8:31 PM PST: "Go: start the MVP"). This is the design; code follows once it merges, one PR at a time. It builds on the spike (`/scratch/sagebrush-reviews/mathics-spike/REPORT.md`, branch `spike-symbolic-mode`) and follows `design/rill.md`'s structure, so the lanes' rulings there carry over where they apply.*

## In plain words

- Sprig is a new language mode in Sagebrush for bracket-notation symbolic mathematics: `D[Sin[x]^2, x]`, `Integrate[x Exp[x], x]`, `Solve[x^2 - 3x + 2 == 0, x]`, `{1, 2, 3} /. 2 -> b`, `f[x_] := x^2 + 1`.
- It runs where the other modes run: `sagebrush --sprig`, `.sprig` files, the REPL, the Jupyter kernel, the web notebook and the Terminal, and in LaTeX documents.
- The mathematics is Sagebrush's own Sage symbolic layer. Sprig adds a parser, an evaluator that rewrites expressions by rules and patterns, and a printer.
- Correctness is checked against Mathics3, an open-source system for the same notation, run only as a black box: input in, output out. Where Mathics3 is wrong or leaves a problem unsolved, the mathematics decides, checked with Sage 10.10.
- The MVP is about 150 functions for undergraduate use: calculus, algebra, equation solving, linear algebra, number theory, lists, plots and TeX output. It comes in 9 slices of about one agent-week each.
- Sprig's answers agree with Mathics3 in value, but the text can differ: term order (`E^x (-1 + x)` against `(-1 + x) E^x`) and the form of an antiderivative. Sprig keeps one stable order of its own, and every such difference is listed and checked to be the same value.

---

## 1. William's decisions

- **Go** on the MVP (Nov 8, 8:31 PM PST), from the spike's proposal.
- Ground rules, relayed by @sagebrush the same evening: clean room (Mathics3 as a black-box oracle only); no vendor or product naming of the original system in code, UI or public copy; a design PR first; PR CI at most 10 minutes, with longer oracle suites nightly; one PR at a time through the lanes.

- **Rulings during review** (@sagebrush, Nov 8, final): Sprig's file extension is `.sprig` only (§3); the language's limits are compatibility defaults, separate from host protection (§5.2).

## 2. Clean-room rules (standing)

1. **Mathics3** (10.0.1, `pip install mathics3`, GPL-3.0-or-later) is run only as a program: text in, printed output out. Its source and its documentation are not read, copied or ported, and no Sprig file is derived from them.
2. The notation and the evaluation model come from general knowledge of the language. Every behaviour Sprig claims is backed by a recorded Mathics3 output (§7) or by mathematics with a recorded Sage 10.10 witness.
3. **Names.** No vendor or product name of the original system appears in code, identifiers, file names, config, UI, docs or public copy. This includes third-party highlighter and lexer names that carry it: Sprig's highlighting is our own (§11). The functions keep the notation's names (`D`, `Integrate`, `Solve`), as MATLAB mode keeps MATLAB's.
4. **Licence.** All Sprig code is new Sagebrush code under Sagebrush's licence. No new dependency.

## 3. Scope and phases

**The oracle order**, as for MATLAB mode (real MATLAB, then MathWorks' docs, then Octave):
- Mathics3's output where it answers and is mathematically right;
- the mathematics, with a recorded Sage 10.10 witness, where Mathics3 leaves the input unevaluated (the spike: `NSolve`, `TrigExpand`, `TrigReduce`, `ContourPlot`, `DSolve` with initial conditions, `CharacteristicPolynomial`) or is wrong (the spike: a double integral over a triangle returned as a function of $x$);
- otherwise Sprig refuses with a message, and the gap is filed. It never guesses, and never pins a divergence without its class (§7.3).

**In the MVP** (the spike's coverage table, rows 1–35 and 41–42; about 150 functions):
- **Notation:** the spike's operator table, complete, with positions in syntax errors and incomplete-input detection for the REPL.
- **Evaluation:**
  - standard evaluation with attributes (`HoldAll`, `HoldFirst`, `HoldRest`, `Flat`, `Orderless`, `OneIdentity`, `Listable`, `NumericFunction`, `Protected`);
  - own, down and up values; `Set`, `SetDelayed`, `Clear`, `Unset`;
  - patterns (`_`, `__`, `___`, heads, `/;`, `?`, `|`, defaults), including `Orderless`/`Flat` matching;
  - rules, `ReplaceAll`, `ReplaceRepeated`;
  - `Module`, `Block`, `With`, `Function` and `#`/`&`;
  - `Return`, `Break`, `Continue`, `Throw`/`Catch`;
  - `Hold`, `HoldForm`, `Unevaluated`, `Evaluate`;
  - messages (`f::tag`), `Quiet`, `Check`.
- **Mathematics** (each wraps the Sage layer): `D`, `Integrate` (indefinite, definite, multiple), `NIntegrate`, `Limit`, `Series`/`Normal`, `Sum`, `Product`, `Solve`, `NSolve`, `FindRoot`, `DSolve`, `Simplify`/`FullSimplify` (no assumptions; see below), `Expand`, `Factor`, `Together`, `Cancel`, `Apart`, `Collect`, `Coefficient`, `TrigExpand`, `TrigReduce`, `N` with precision.
- **Linear algebra:** `Det`, `Inverse`, `Transpose`, `Dot`, `Tr`, `Eigenvalues`, `Eigenvectors`, `CharacteristicPolynomial`, `RowReduce`, `LinearSolve`, `NullSpace`, `MatrixRank`, `IdentityMatrix`, `Cross`, `Norm`.
- **Number theory and statistics:** `Prime`, `PrimeQ`, `FactorInteger`, `GCD`, `LCM`, `Mod`, `Divisors`, `Binomial`, `Mean`, `Variance`, `StandardDeviation`.
- **Lists, control and strings:** `Table`, `Range`, `Do`, `While`, `For`, `If`, `Which`, `Switch`, `Map`, `Apply`, `Select`, `Nest`, `NestList`, `Fold`, `Part`, `Length`, `First`, `Last`, `Rest`, `Join`, `Append`, `Sort`, `Flatten`, `Total`, and the common string functions.
- **Output:** a stable canonical order; `InputForm`, `FullForm`, `OutputForm`-like text; `TeXForm`; notebook typesetting through TeX; `MatrixForm`, `TableForm`, `Grid`.
- **Graphics:** `Plot`, `Plot3D`, `ParametricPlot`, `ContourPlot`, `ListPlot`, the common options (`PlotRange`, `PlotStyle`, `AxesLabel`, `PlotLegends`), `Show`, `Export` (PNG and SVG; 3D through Sagebrush's viewer).

**Out of the MVP** (later, each with its own design note):
- `Manipulate` and dynamic interactivity;
- `NDSolve`, `Interpolation`, `Fit`;
- `Graphics[{...}]` primitives beyond what the plots need;
- assumptions (`Assuming`, `Simplify[e, x > 0]`): Mathics3 ignores them, so the oracle gives nothing to check;
- 2D typeset text in the terminal (the terminal prints linear text; the notebook typesets through TeX);
- other file formats: Sprig's extension is `.sprig` only (@sagebrush's ruling, Nov 8): no other system's source or notebook extension, as a mode association, in docs or in examples. Importing other formats can be its own later proposal;
- a fast path for tight numeric loops (§10).

## 4. Where the code lives

| Path | What it holds |
|---|---|
| `lib/_sprig/__init__.py`, `parse.py`, `expr.py`, `eval.py`, `match.py`, `fmt.py` | Sprig's start: atoms and `Expr`, the parser, the evaluator, attributes, the pattern matcher, definitions, messages, the printers, `run`/`run_cases` |
| `lib/_sprig/math.py` | the conversion to and from Sage's symbolic layer (`to_sr`, `from_sr`), and the calculus and algebra builtins |
| `lib/_sprig/lists.py`, `linalg.py`, `numth.py`, `strings.py` | the other builtins |
| `lib/_sprig/plot.py` | the plotting builtins, over Sage's `plot` family and `lib/_graphics.py` |
| `src/modes.ts` | one Sprig row (§5.1) |
| `src/cli.ts`, `src/kernel.ts`, `src/interactive.ts`, `web/worker.ts`, `src/dataflow.ts` | the host wiring, each a reviewed integration item (§11) |
| `src/sprig-complete.ts`, `web/code/` | completion and highlighting |
| `sprig-tests/` | the recorded Mathics3 outputs (§7) |
| `design/sprig.md` | the mode's living design, once the MVP lands, as `design/matlab.md` is for MATLAB |

**The parser is Python**, not TypeScript as for MATLAB and Magma. Sprig parses at run time (`ToExpression`, `Get`), and its programs are data, so one parser serves the CLI, the kernel and the web worker. TypeScript needs only incomplete-input detection for the REPL: brackets, strings and comments.

**Mathematics enters Sage only through `math.py`.** Lists, rules, patterns, strings and graphics never enter Sage. An undefined `f[x]` becomes Sage's `function('f')(x)`, so `D[f[x] g[x], x]` gives the product rule with `Derivative[1][f][x]`.

## 5. Design details

### 5.1 The mode row

Sprig is one row of `src/modes.ts` (landed for Rill), plus its membership in the subsets that support it (kernel, REPL, notebook, board, worker, LaTeX). Its kernel `language_info`: name `sprig`, file extension `.sprig`, mimetype `text/x-sprig`, and no third-party codemirror mode or pygments lexer (§2.3). Its menu label is "Sprig".

### 5.2 Evaluation

Standard evaluation rewrites until nothing changes:
1. evaluate the head;
2. evaluate the arguments unless held;
3. splice `Sequence`, flatten `Flat` heads, thread `Listable` heads, sort `Orderless` arguments;
4. try up values, then down values (most specific first), then the builtin;
5. repeat until fixed.

**The language's own limits are compatibility defaults** (@sagebrush's ruling, Nov 8; final). Recorded from Mathics3 10.0.1:
- `$RecursionLimit` is 200;
- `$IterationLimit` is 4096; an endless self-rewrite prints `$IterationLimit::itlim: Iteration limit of 4096 exceeded.` and gives `$Aborted`;
- `x //. x -> x + 1` stops at `65535 + x`: `ReplaceRepeated`'s `MaxIterations` option defaults to 65535, and `ReplaceRepeated[x, x -> x + 1, MaxIterations -> 10]` gives `10 + x`.

Sprig keeps these values, boundaries, messages and held results, because they are the language's observable behaviour. They are not host protection and grant no host authority.

**How the person raises each**, `Infinity` included:
- `$RecursionLimit = n` or `$RecursionLimit = Infinity`;
- `$IterationLimit = n` or `$IterationLimit = Infinity`;
- `ReplaceRepeated[e, r, MaxIterations -> n]` or `MaxIterations -> Infinity`, per call.

**A recorded difference from the oracle.** Mathics3 refuses `Infinity` for both variables (`$IterationLimit::limset`, and for `$RecursionLimit` an integer from 20 to 512 only; its message points to an environment variable of its own host). That is Mathics3's host limit, not the language's. Sprig accepts `Infinity` by the ruling above. These cases are in the corpus with a stated reason (§7.3), never silently different.

**What bounds a computation with the limits removed.** Nothing hidden:
- the host stack stays protected by the trampoline and its measured re-entry bound `S` (§8.3);
- growing explicit-stack and data state stays under the memory guard (§8.4);
- otherwise an endless computation runs until Stop, or until a separately authorized host allowance fires (the existing opt-in path). No iteration or time cap is added.

A person's assignment to these variables never arms, weakens or replaces an authorized host allowance or the memory guard.

**The census classes** (@sagebrush's ruling; daybreak2's LIMITS verdict may assign otherwise, and that is final). Every one is a real refusal site, never "none":

| Site | Class |
|---|---|
| the `$RecursionLimit`, `$IterationLimit` and `MaxIterations` checks | 3 (evaluation-step caps of the user's computation, user-removable) |
| the trampoline's re-entry bound `S` | 1 (host-stack protection) |
| memory reservation and refusal | 2 |
| an authorized host time or work allowance | 3, opt-in through the existing allowance path only |

**The disposition.** The census's class-3 dispositions today model only unlimited-default `_limits` and host routes. So S1 adds an explicit, reviewed language-compatibility disposition (or an equivalent truthful schema) for these three sites (daybreak2's LIMITS ruling, final). They are never routed through host authority and never marked "none".

**Pins:** each limit at its exact default, at the last allowed step and one past it (+1), at a raised value, and at `Infinity`; its message and held result; and its mutability. With `Infinity`, deep recursion still reaches the structural bound `S` cleanly. `$RecursionLimit = Infinity` and `$IterationLimit = Infinity` each run an endless computation that Stop ends, followed by a check that the session answers. An armed allowance gets its own pin, and doesn't change an ordinary session's behaviour.

**Census discovery.** Today `test/limit_sites.py`'s `tracked()` scans only `lib/[^/]+.py`, so nothing under `lib/_sprig/` would be seen. S1 must extend discovery to nested `lib/**/*.py` (with stated exclusions), at least to `lib/_sprig/**`; add a test that a refusal in a nested file is discovered; and register every site S1 adds with its class, owner and disposition.

### 5.3 Output

- **Canonical order.** `Orderless` arguments are sorted by Sprig's own total order: numbers first, then symbols alphabetically, then compound expressions by head and arguments, powers by their base. The spike showed that Mathics3's text order can't be matched without reading its source, so Sprig's order is stable, documented and tested, and differences from the oracle's order are listed and checked as values (§7.3).
- **Text.** The REPL and CLI print linear text (`x^2 + 2 x + 1`, `{{x -> 1}, {x -> 2}}`). `InputForm`, `FullForm` and `ToString` give the oracle's text where Sprig's tree is the same.
- **TeX.** `TeXForm` through Sage's `latex()`, adjusted where the oracle's TeX differs only in braces (`x^2`, not `x^{2}`). Notebooks typeset results with Sagebrush's TeX renderer.
- **Messages** (`Power::infy: Infinite expression 1 / 0 encountered.`) print on stderr with the oracle's text, recorded per case.

### 5.4 Graphics

Plots draw through Sage's `plot` family onto `lib/_graphics.py`, Sagebrush's SVG renderer, as the spike's did. As for Rill, fidelity is about **values, not pixels**: sampled curve points, ranges and ticks are compared where the oracle prints them, and our SVG descriptions are snapshot-tested (§7.6).

### 5.5 LaTeX

A `sprig` code block and an inline `\sprig{...}` in LaTeX documents run Sprig and embed the TeX of the result, through the LaTeX editor's item machinery as for the other modes. It is wired in S7 (§11).

### 5.6 Sprig's own messages

Where the oracle has a message, Sprig prints the oracle's text (§5.3). Where Sprig refuses something for its own reasons, it prints one of these, word for word. ENGINE may change the tags; the sentences stay:

| Tag | Text | When |
|---|---|---|
| `General::nesting` | `The evaluation is nested too deeply to continue here.` | the host bound `S` is reached before `$RecursionLimit` (§8.3) |
| `General::nonetwork` | `URLRead can't reach the network: it is off for documents.` | any network function (§9); the function's own name replaces `URLRead` |
| `General::noprocess` | `Run can't start a program: Sprig doesn't run programs.` | any process function (§9); the function's own name replaces `Run` |
| `General::memory` | `Table needs more memory than this session allows: <detail>.` | a refused allocation (§8.4); the function's own name, and Sagebrush's detail (need, allowance) |
| `General::notyet` | `NDSolve isn't available in Sprig yet.` | a known function outside the MVP (§3); the function's own name |

## 6. Lazy loading and size (daybreak2)

### 6.1 Group routing, final from S1's first `_sprig` file

As for Rill (design/rill.md §6.1), the routing lands with the first `lib/_sprig/` source, so no later phase renames or removes a bundle:
- **The start.** `sprig` joins `STARTS` (`["--sprig", "-c", "1"]`) and `START_ORDER` after `rill`, so a file another start uses stays in theirs. Sprig's start imports `sage_all`, so the `sage` group is a declared dependency.
- **Path rules**, before the generic `mod-` fallback:

  | Path | Group |
  |---|---|
  | in Sprig's start recording | `sprig` |
  | `_sprig/plot.py` | `sprig-plot` |
  | any other `_sprig/**` | `sprig-more` |

- **Offline ownership.** `web/offline-inventory.mts` `MODES` gains `{ id: "sprig", title: "Sprig", prefix: "sprig", needs: ["python", "sage"] }`.

### 6.2 Budget rows and markers

- **Only present groups get rows.** S1 installs the final route names (§6.1) but adds `budgets.json` rows only for the groups it measures: `sprig.src` and `sprig.pre`, and `sprig-more.src` if that group has content. S6 adds `sprig-plot.src` when `plot.py` first exists. There is never an empty future row.
- Growth of existing rows (`lib.gen.js`, `pyjs.cjs`, the TypeScript wiring) is authorized by tight `.growth` markers, measured with the exact pull_request gate against current master.

### 6.3 The CLI: keyed blobs per present family

As Rill's (design/rill.md §6.3): `scripts/lazy-lib.mjs` gets separate keys for Sprig's start and `sprig-more`, and from S6 `sprig-plot`. No Python, Sage, MATLAB, Magma or Rill start decodes a Sprig key, and an ordinary Sprig start decodes no `sprig-plot` key. `sprig-plot` is its own group (daybreak2's ruling): plotting comes only in S6, isn't needed by a symbolic first cell, and may pull a different import closure.

### 6.4 Pins (S1, extended in S6)

- Synthetic path-to-group cases for every route, including `_sprig/plot.py` to `sprig-plot`, and a shared file that stays in core, sci or sage.
- No other mode's start or `manifest.modes` entry contains a Sprig group.
- Sprig's first cell fetches and decodes only its start group and declared dependencies, never `sprig-plot`.
- The first plotting import fetches and decodes `sprig-plot` and only its declared shared dependencies (S6).
- The offline inventory owns every Sprig group exactly once and stays within its caps.
- The CLI's lazy guards (`web/test-cli-lazy-lib.mjs`) prove the same decode boundaries.

### 6.5 What each slice reports

As for Rill (design/rill.md §6.4), with these figures:
- `lib.gen.js`, `pyjs.cjs`, and the npm pack bytes;
- cold start of Python, Sage and Sprig on the CLI;
- browser stored and Brotli bytes per Sprig row;
- the offline caps' headroom.

The spike's numbers are a starting point only: `lib/_sprig.py` was 70 KB of source, about 30 KB in the CLI bundle. The MVP's source should be about 250–300 KB.

**First-use targets.** S6 also reports plotting's full cold first use (download, decode, compile, import) in the browser and the CLI, with the per-row bytes, npm pack growth, the other modes' cold starts and the offline caps' headroom. A Sprig session's first cell, measured cold in the browser and on the CLI, stays within 1.1× of Sage mode's first cell measured the same way, since Sprig's start is Sage's plus Sprig's own modules. Otherwise the PR explains the difference.

## 7. Tests: a corpus of recorded Mathics3 outputs (grader)

### 7.1 The corpus and its oracle

As `rill-tests/` (design/rill.md §7.1):
- `sprig-tests/<area>/test_<n>.sprig` hold cases separated by `(*-- <id> *)` lines; each case runs in a fresh session.
- `sprig-tests/<area>/test_<n>.out.json` hold each case's recorded stdout (the result's `InputForm` and any `Print` output), its messages, and the result's `FullForm`.
- `sprig-tests/PROVENANCE.json` records the oracle: the Mathics3 version and its dependencies' versions (`mathics --version`), the exact command, and the sha256 of every case file and output.
- `sprig-tests/run.py --regen` is the only writer of `.out.json`. It runs Mathics3 from `/scratch/matlab-tmp/mathics/venv` by hand, never in CI. An oracle bump re-records everything in one PR.

### 7.2 What is compared

For each case: the result's `InputForm` text, the `Print` output, and the message lines, byte for byte, after one stated normalization (Mathics3's Unicode arrows `⇾`/`⧴` written as `->`/`:>`), done by one function in the runner with a pin on each arrow.

### 7.3 Known differences, enforced both ways, and checked as values

`sprig-tests/KNOWN.json`, as Rill's: each entry has a case id, a class, one line of reason, and the sha256 of **our** output. A listed case must still give our recorded output, and must still differ from the oracle: if it becomes exact, the test fails with "remove from KNOWN.json".

Sprig's classes, with what backs each (the grader's TESTS ruling):

| Class | Meaning | Checked by the test |
|---|---|---|
| `term-order` | the same value, terms in Sprig's order | the oracle's recorded `FullForm` against ours, through a small `FullForm`-only parser in the runner, independent of `lib/_sprig/`. Arguments are sorted recursively, only under heads that are `Orderless` in the oracle's attributes (a fixed list in the runner: `Plus`, `Times` at least), by a total order on canonical `FullForm` text. Equal multisets of arguments, and nothing else, is `term-order` |
| `equivalent-form` | the same value written differently | the free symbols must be the same set, or it fails first. Then symbolically in Sage, `(a - b).simplify_full() == 0` (recorded `"check": "symbolic"`). Only when Sage can't decide, numerically: at least 7 seeded points per free-variable set (negative, non-integer and two complex points included), at 50 digits, passing $\lvert a - b\rvert \le 10^{-20} \max(1, \lvert a\rvert, \lvert b\rvert)$. Points where either side isn't finite are skipped, but at least 5 must be finite. Recorded `"check": "numeric"` with the count of points |
| `equivalent-form`, `"up_to_constant": true` | antiderivatives differing by a constant; `Integrate` only | $\frac{d}{dx}(a - b)$ passes the check above |
| `oracle-unevaluated` | Mathics3 returns the input unevaluated; Sprig answers | a Sage 10.10 witness, recorded with provenance (Sage version and exact command in `PROVENANCE.json`), compared to ours by the `equivalent-form` check |
| `oracle-wrong` | Mathics3's answer is wrong | the Sage witness as above, plus an independent numeric fact our answer satisfies and Mathics3's fails (a definite integral by quadrature, a root substituted back). The one-line proof is for people |
| `oracle-host-limit` | Mathics3 refuses a setting because of its own host (§5.2's `Infinity` for the limits) | a closed class: the runner holds the fixed list of oracle refusals it may cover (today `$IterationLimit::limset`, and `$RecursionLimit` outside 20–512), and an entry whose recorded oracle message isn't on the list fails. Each entry carries two pins: (a) a computation needing more than the oracle's maximum (a recursion depth of 1000 under `$RecursionLimit = Infinity`; a `//.` needing more than 65535 steps with `MaxIterations -> Infinity`) gives the right value, checked against a closed form or a Sage witness by the `equivalent-form` check; (b) a non-terminating one ends by Stop, after which the session answers and keeps its definitions. Neither uses a wall-clock bound |
| `not-implemented` | Sprig refuses, with its message | the refusal text; the entry names the slice or L-item that implements it |

So every listed difference except `not-implemented` and `oracle-host-limit` is checked as a value: symbolically where Sage can decide it, otherwise numerically at 50 digits on at least 5 finite points, and the entry records which. The checkers carry negative controls in CI. Domain, branch and constant-of-integration conditions are stated in an entry wherever they apply.

**Negative controls for every checker** ship in S0, before any Sprig code. The runner holds a fixture with, for each class, one case that must pass and at least one planted wrong answer that must fail: for `term-order`, a dropped term and a changed coefficient; for `equivalent-form`, an answer off by a constant factor and one wrong only away from 0; for `oracle-unevaluated`, a witness that disagrees; for `oracle-host-limit`, a recorded oracle message not on the list, and Sprig refusing `Infinity`. The runner fails if any control passes.

**Scoring.** A slice's held-out score reports exact, `term-order`, `equivalent-form` (symbolic and numeric separately), `oracle-unevaluated` and `oracle-wrong`, `oracle-host-limit` (on its own line, never under "same value") and `not-implemented` separately. A `not-implemented` entry never counts as passed.

### 7.4 Held-out files

As for Rill (design/rill.md §7.4): each slice's held-out file is committed with its recorded output in a small PR before the slice's first code PR, and never edited afterwards. The slice's score is reported against exactly those hashes.

### 7.5 Cost and CI budget

- **The runner mirrors Rill's** as `test/sprig-corpus-run.ts` (daybreak3's ruling; not a generalized shared runner): one CLI process per case file, each case in a fresh Sprig session (`run_cases`), and a fixed 5% of cases also run one process per case to pin fresh-session equivalence. Sprig's outcome parsing and KNOWN enforcement stay local; shared helpers may be extracted later only once both runners show identical mechanics.
- **Measured budget.** The spike measured about 1 s of start per process (Sage's import) and 10–60 ms per case, so a few hundred cases fit in about 45 s per partition across `test/sprig-corpus-{1..4}.test.ts`. S1 gives the measured numbers.
- **Not in the node suite.** node-tests shard 7 is already over the 10-minute bound, so the corpus partitions go in their own `sprig` job or shards, gated by the paths `sprig-tests/`, `lib/_sprig/` and `src/sprig*.ts`, each at most 10 minutes, as web-sync's split was done. That is a workflow-file change, which agents never push: S0 asks @sagebrush and William for it, with the measured numbers.
- Slow cases (large integrals, plots) are marked and run nightly.
- §10's per-input times are measured and reported per slice, never asserted in CI.

### 7.6 Our own snapshots

SVG descriptions and KNOWN's hashes are ours: they pin behaviour, they don't verify it. They change only through an explicit `--update` run that the PR states.

### 7.7 Mutants

The grader's mutant runs apply per PR. Each PR lists the rules it adds, so mutants map to cases. A held-out-only kill doesn't count.

## 8. Stop, recursion and memory (daybreak3)

Sprig is Python on the engine, so it inherits Sagebrush's interrupt model, as Rill does (design/rill.md §8).

### 8.1 Stop is never swallowed

`Quiet`, `Check`, `Catch` and message handling catch only Sprig's own control and message classes, by name. No bare `except`, and no `except BaseException`/`Exception` around evaluation; a census script fails the build on any. `KeyboardInterrupt` and `SystemExit` always propagate. The evaluation loop and every builtin's loop test the interrupt flag each iteration.

### 8.2 Definitions are published whole

`Set`, `SetDelayed`, `Clear` and attribute changes prepare their new definition list privately and publish it in one store, so Stop never leaves half a definition.

### 8.3 Recursion: the host stack is protected by construction

As in design/rill.md §8.4, a depth counter alone can't protect a recursive evaluator, because Python's or the browser's stack could fail first. So:
- **Evaluation runs on an explicit stack** (a trampoline): head, arguments, rule application and control flow push continuations, not host frames. Deep Sprig recursion grows a list.
- **Builtins that call back into evaluation** (`Map`, `Nest`, `Table`, `Select`, the pattern matcher's conditions) re-enter the trampoline; nested re-entries are bounded by a constant `S`, measured in S1 per host, with margin.
- **Every walk, not only function recursion:** parsing, pattern matching (with its alternatives), rewriting, printing, the Sage conversion and every builtin that walks an expression run iteratively or within `S`. A tree 10⁵ levels deep from `Nest` is a pin. Each of these loops also tests the interrupt flag.
- Passing `$RecursionLimit` gives the language's message, recorded from the oracle in S1. Passing `S` first gives `General::nesting` (§5.6). A host `RecursionError` or `RangeError` must never reach the user.
- **Pins**, in the CLI and the browser: `f[n_] := f[n + 1]`, mutual recursion, recursion through `Map`, and `$RecursionLimit = Infinity`, each followed by a check that the session still answers.

### 8.4 Memory: reserve before allocating

As in design/rill.md §8.5: `Table`, `Range`, `ConstantArray`, `Array`, `Tuples`, `Outer` and the integer and rational arithmetic compute their result size first, in Python integers, and reserve it against the session's allowance (`lib/_memguard.py`), or the browser's fixed caps where memory can't be measured. The charge is the operation's peak live storage, including continuation and parse-tree growth, definitions, the matcher's alternatives, formatting and conversion temporaries, and numeric intermediates; reservations are released on failure and on Stop. The language's limits (§5.2) are no substitute for this accounting. A refusal is `SagebrushMemoryError`, shown as `General::memory` (§5.6) with Sagebrush's detail. **Pins:** the boundary, one past it, and Stop during an allocation.

### 8.5 Tests and integration

`test/sprig.test.ts` holds §8's pins. Sprig joins the interrupt-matrix modes list (a test-side table) with Stop in a `While[True, ...]`, inside `Map`, inside `Catch` (not caught), and in a long `Integrate`, each followed by a check that the session answers and keeps its definitions.

## 9. Files, network and processes (astra)

Sprig must reach files only through Sagebrush's Python file layer, so the document's switches apply unchanged:

- **Files:** `Get`, `Import`, `ReadList` and `FileExistsQ` must read through Python's `open`/`os`. `Put`, `PutAppend`, `Export`, `DeleteFile`, `RenameFile` and `CreateDirectory` must write through it, raising the page's "wants to change your files" bar as Python does. `SetDirectory` must stay within the document's workspace.
- **Network: off.** `URLRead`, `URLFetch` and `Import["https://..."]` must fail before any connection, with `General::nonetwork` (§5.6).
- **Processes:** `Run`, `RunProcess`, `ReadList["!cmd"]` and `OpenRead["!cmd"]` must be refused in the MVP, with `General::noprocess` (§5.6). If they are wanted later, they route through just-bash as Python's `os.system` does, in their own PR with SEC review.
- **Output:** notebook HTML from Sprig (`Grid`, `TableForm`) must go through `safeHtml` with `remote: false`. Plots must be our own SVG. Sprig must offer no API that emits script.
- **The Sprig-only evaluator boundary, with negative controls.** `ToExpression` and `Get` must evaluate Sprig inside Sprig only. Symbol names, contexts and strings must never reach Python objects, module globals, imports or attributes: a symbol named `__import__`, `` Global`__class__ `` or `os` is only a Sprig symbol. S1 ships negative-control pins: such symbols evaluate to themselves, `Symbol["__import__"][...]` and `ToExpression["__builtins__"]` stay inert, and the session is unchanged.
- **The gate inventory**, generated from the code by a census script as for Rill: every Sprig route to a file, a process or the host, with its gated or refused decision, including file and import options and deferred effects. Listing a route isn't enforcement: each listed route has a behavioural pin. The behavioural pins (files off and on, network refused, processes refused, the negative controls) must ship with Sprig's first host exposure (S1's CLI, then the notebook and worker).

## 10. Performance

The spike measured, under load: about 1 s to start (Sage's import, 964 ms; Sprig's own import about 30 ms on top), 10–60 ms per homework input, about 0.3 ms per evaluation-loop step (a 2,000-step `Do` loop in about 0.65 s).

- **The MVP bar:** a homework input under 100 ms after start, measured per slice.
- **Numeric loops:** a fast path (compiling a held `Do`/`Table` body over machine numbers, as MATLAB mode's turbo path does) is out of the MVP and gets its own design note.
- **Rust kernels** only where measurements show the need, per William's principle; none are planned for the MVP.

## 11. Integration checklist (each item a reviewed PR in S7)

- **The Sprig row** (§5.1): CLI flag and `.sprig`; kernel `--mode sprig`; notebook and board worker flag; `web/notebook/types.ts`; the analyze worker (`src/dataflow.ts`, Sprig's definitions and uses, so reactive notebooks know which cells read which symbols); highlighting in `web/code/` (our own token rules); completion; docsearch (`docs-index-sprig.json`, our own one-line summaries, with examples run and compared); an Examples gallery notebook; the LaTeX `sprig` block and `\sprig{}` (§5.5); the Terminal's `sprig` command, with plan-term-xterm's shared layer.
- **A host test for each integration item:** the notebook, the Jupyter kernel, the board and the web worker each run at least one corpus case through that host.
- **Docs:** README's mode list, `llms.txt`, and capabilities.md's gate inventory.

## 12. Slices and estimate

Each slice is one PR through ENGINE (daybreak3), SEC (astra), SIZE (daybreak2), TESTS (grader) and COPY (board), about one agent-week:

| # | Slice | Contents |
|---|---|---|
| S0 | Held-out and corpus | `sprig-tests/` with its provenance, the spike's two corpora re-recorded as case files, S1's held-out file; the runner with its checkers and their negative controls (§7.3), with no Sprig code yet; the request for the `sprig` CI job (§7.5) |
| S1 | Core | `lib/_sprig/` start (final routing for all groups; budget rows and CLI keys only for groups present, §6): parser, `Expr`, the trampoline evaluator with attributes, own and down values, non-`Orderless` patterns, rules, arithmetic through Sage, the printers, messages; `--sprig` and `.sprig`; the group routing, lazy family and budget rows (§6); §8's and §9's first pins; the census's discovery extended to `lib/_sprig/**`, with its nested-refusal test, and S1's sites registered (§5.2) |
| S2 | Calculus and algebra | `math.py`; the Sage-layer gap G5 as its own engine PR (below) |
| S3 | Evaluator depth | `Orderless`/`Flat` matching, up values, scoping, `Return`/`Break`/`Throw`, the `Hold` family, `Quiet`/`Check`, the language limits |
| S4 | Lists, linear algebra, number theory, statistics, strings | `lists.py`, `linalg.py`, `numth.py`, `strings.py` |
| S5 | Output | canonical order, `TeXForm`, `MatrixForm`/`TableForm`/`Grid`, notebook typesetting |
| S6 | Graphics | `plot.py` materializes `sprig-plot` (route unchanged, nothing moved), with its budget row, CLI key and first-use measurement (§6); options, `Show`, `Export`, 3D |
| S7 | Integration | §11's items, each its own small PR |
| S8 | Hardening | the long tail found in S1–S7; L-items closed or filed |

**Estimate:** 9 slices, about 9 agent-weeks, within the spike's 8–10. S8 holds the margin, and I'll say early if a slice runs long.

**Sage-layer gaps.** The spike found five (G1–G5). On master at Nov 7, G1–G4 are fixed (re-checked: `integrate(1/x^2, x, 1, oo)` gives 1, the alternating sum gives $\pi/4$, and the two linear algebra `TypeError`s are gone). G5 remains: an arbitrary-precision real can't enter the symbolic ring (`SR(pi.n(digits=30)) + 1` is a `TypeError`). It blocks `N[e, 30]` re-entering Sage, so it is a separate engine PR in S2, which fixes Sage mode too.

## 13. Open questions

**For William:**
1. **File extensions: decided** (@sagebrush, Nov 8, final): `.sprig` only (§3).
2. **The name.** Confirm "Sprig" as the public name; the spike proposed it, and this design uses it throughout.

**For the lanes:**
3. **The language's limits: decided** (@sagebrush, Nov 8, final): compatibility defaults, user-removable, separate from host protection; class 3 unless daybreak2's LIMITS verdict assigns otherwise (§5.2).
4. **§7.3's classes: decided** (the grader's TESTS ruling): symbolic where Sage decides, else 50-digit numeric on at least 5 finite points, recorded per entry; negative controls in CI.
5. **`sprig-plot`: decided** (daybreak2): its own group (§6).
6. **The corpus runner: decided** (daybreak3): mirrored as `test/sprig-corpus-run.ts` (§7.5).
