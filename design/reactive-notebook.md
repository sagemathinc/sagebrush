# A reactive notebook for sagebrush.space

**Status:** accepted direction (October 11, 2026). Step 1 is implemented:
one interpreter per notebook, Restart keeps outputs (stale), the console as a
separate scratchpad (web/test-kernels.mjs). So is step 2's analysis:
`src/dataflow.ts`, a port of marimo's `ScopedVisitor`, agrees exactly with
marimo 0.25.1 on all 3,924 cells of `test/dataflow-oracle.json` (marimo's
tests and example notebooks) and on all 13,032 top-level statements of
CPython 3.14's standard library.

**Implemented on October 11 (behind `?reactive`, see "Progress" below):**
the graph, the scheduler, the budget, errors, the agent API, `_` names,
per-cell seeds, static mutation tracking, file tracking, widgets as inputs,
the fix for redefinitions, and Resume by recompute.

William's decisions are recorded under "Decisions" at the end. It follows
William's "there's no rule that this has to be exactly a Jupyter notebook",
and Astra's repeated review suggestion: reactive like marimo, with bounds on
recompute time.

## The goal

The notebook is mainly for agents and people working together, often with
an agent writing content for a person to read. That needs one guarantee:

> **What you see is what the notebook computes.** Every output shown is the
> result of the cells as they are now, or it is visibly marked stale. There
> is no hidden state: the state is a function of the document.

Jupyter's model breaks this, through run order, edited-but-not-rerun cells,
deleted cells, and one interpreter shared by every notebook in a tab. The
TimeTravel journal (design/timetravel-replay.md) needs foreign runs and
recorded clocks precisely because it doesn't hold.

## The semantics are marimo's

William: "either the same semantics they have, or a good reason for
changes." marimo ([github.com/marimo-team/marimo](https://github.com/marimo-team/marimo),
Apache-2.0) is documented and has thought these questions through. Its rules,
from its [reactivity guide](https://docs.marimo.io/guides/reactivity/) and its
source (`marimo/_ast/visitor.py`, `marimo/_runtime/dataflow`):

- **References and definitions** come from static analysis: the globals a
  cell reads but does not define, and the globals it defines. Functions,
  classes and imports are variables too.
- **Running a cell runs every cell that references a global it defines,**
  transitively, in topological order. Ties go to the cell registered first:
  the order on the page.
- **Every global is defined by exactly one cell** (`MultipleDefinitionError`).
- **Cycles** are errors (`CycleError`), and so is **`import *`**
  (`ImportStarError`: it cannot be analyzed).
- **Mutations are not tracked.** `v[1] = 5`, `z.x = 10` and `L.append(42)`
  in a cell that does not define the object are references, not definitions.
  They trigger nothing. The advice is to mutate only in the defining cell, or
  to make new variables.
  - William's first example (`sum(v)` updated) is not tracking. Editing
    `v = [...]` reruns every cell that references `v`, in page order, and
    the `v[1] = 5` cell happens to sit above `sum(v)`.
  - His second example (`z.x = 10` leaving `z.x` showing 5) is the untracked
    case.
- **Names starting with `_` are local to their cell.** marimo mangles them
  per cell, so cells may reuse them.
- **Deleting a cell deletes its globals;** the cells referencing them are
  invalidated.
- **`del` of another cell's global** is a reference marked deleted; `global`
  in a function refers to the module's name.
- **An ancestor that raised** stops its descendants
  (`MarimoAncestorPreventedError`); so does an interrupted one
  (`MarimoAncestorStoppedError`).
- **Lazy or autorun:**
  - autorun runs the descendants, and is the default;
  - lazy marks them stale, and running a cell first reruns its stale
    ancestors;
  - disabling a cell blocks it and its descendants.

**How we keep to them:** real marimo is the oracle, as Sage, NumPy and Magma
are for the rest of Sagebrush.

- Our analysis, over our own parser's AST, gives the same definitions,
  references and deleted references as marimo's `compile_cell`. The cells
  compared are every string in marimo's tests that parses as Python, and
  every cell of its example and test notebooks. `test/marimo_oracle.py` runs
  marimo under CPython and writes `test/dataflow-oracle.json`, which
  `test/dataflow.test.ts` checks in CI without marimo.
- `DATAFLOW_ORACLE=file` checks against another corpus, such as the
  standard library's top-level statements.
- pyjs has no `ast` module, so marimo's own analyzer cannot simply run in the
  browser. That option needs an `ast` module built on pyparse; it is not
  needed for the oracle.

**Deliberate differences, each with its reason:**

| Difference | Reason |
|---|---|
| Runs on pyjs and Sagebrush's Rust engines in the page | Startup in about 120 ms, Sage and Magma modes. marimo's in-browser mode uses Pyodide. Not a semantic difference. |
| A recompute **budget** besides autorun and lazy (autorun = infinite, lazy = 0) | Cheap dependents update; expensive ones wait for a person or an agent. Both of marimo's modes remain. |
| **Per-cell seeded randomness** | `verify()` (recompute and compare) is exact. Random values still look random. |
| A **warning** on a mutation of another cell's global | marimo only advises against it. The warning tells people and agents that dependents will not rerun. Execution is unchanged. |
| **Markdown cells** | marimo writes `mo.md(...)`. Ours map to and from it on import and export. |
| **Sage and Magma modes** | Analyzed after preparsing or translation; the preparser's temporaries are `_`-prefixed, so local. |

marimo's `.py` notebook format (one function per cell) is a natural import
and export format: then marimo notebooks open in Sagebrush and the reverse.

## What marimo's users and maintainers find suboptimal

From marimo's issue tracker (October 2026), what matters for our design:

1. **The one-definition rule is the top friction.** The cases are
   `for i in ...` in two cells, `fig, ax = plt.subplots()` in two cells, and
   `df = clean(df)` chains.
   - [#1477](https://github.com/marimo-team/marimo/issues/1477) "Relax
     uniqueness constraint for write-only variables": allow several
     definitions when no cell reads the name. The maintainers found no
     correctness problem, but closed it as not planned. Their reason was the
     runtime bookkeeping: when cells are edited or deleted, which definition
     is current? They improved `marimo convert` instead.
   - Users keep hitting it: "used Marimo for about two hours and already
     tripped over this problem so many times".
   - See also [#2347](https://github.com/marimo-team/marimo/issues/2347),
     [#6489](https://github.com/marimo-team/marimo/issues/6489) (shadowing
     behind a setting), and the open
     [#7815](https://github.com/marimo-team/marimo/issues/7815) (consecutive
     redefining cells run as one unit).
2. **Mutations stay untracked** by design. "Strict mode", which copied
   values so that mutation could not leak, was too slow and is effectively
   dead ([#4199](https://github.com/marimo-team/marimo/issues/4199)).
3. **Too many overlapping execution concepts**
   ([#2100](https://github.com/marimo-team/marimo/issues/2100)): notebook
   lazy or autorun, per-cell "disabled", and requests for a per-cell
   "manual" mode for expensive or dangerous cells (writes to a production
   database).
4. **Coarse invalidation.** Editing one line of a config cell reruns
   everything that reads any of its names
   ([#9959](https://github.com/marimo-team/marimo/issues/9959)). marimo's
   direction is content-addressed caching (`mo.persistent_cache`, "cached
   execution"): rerun only what reads a value that actually changed.
5. **Files are not dependencies**
   ([#3258](https://github.com/marimo-team/marimo/issues/3258)): the fix is
   an explicit `mo.watch.file`.
6. **`del` and conditional definitions** cannot be honored by static
   analysis ([#9347](https://github.com/marimo-team/marimo/issues/9347)).
   marimo keeps the rule and does no runtime tracing.
7. **Agents:** marimo is adding agent tooling
   ([#8172](https://github.com/marimo-team/marimo/issues/8172) MCP cell
   editing and execution control,
   [#9444](https://github.com/marimo-team/marimo/issues/9444)). One reported
   problem: with autorun, an agent's coordinated edits to several cells run
   after each edit. Agents need to batch edits and run once.

**What we can do differently (proposals):**

| # | Proposal | Why |
|---|---|---|
| 1 | Allow a name to be defined by several cells **as long as no other cell reads it** (#1477). It is an error the moment a cell reads it. When a name's definers drop to one, that cell is rerun (stale, in lazy mode). | This is #1477's rule. Rerunning the remaining definer is the bookkeeping that resolves marimo's ambiguity. The graph stays exact: a name with no readers has no edges. `df = clean(df)` chains stay an error; different names (`df1`, `df2`) also make each step addressable. |
| 2 | Errors offer one-click fixes: rename to `_i`, rename the later definition, merge cells. | — |
| 3 | Two concepts only: the notebook's budget (autorun = infinite, lazy = 0) and a per-cell **manual** flag (never runs automatically, shows stale). | #2100. A separate "disabled" is not needed. |
| 4 | After a cell reruns, its dependents rerun only if a value they read changed (a hash of the value, where it can be computed cheaply; otherwise assume it changed). | marimo's own direction (#9959); fewer reruns when people and agents edit. |
| 5 | **Files are tracked automatically.** Every `open()` goes through our filesystem shim, so the runtime knows which files each cell read and wrote: a writer-to-reader edge, with no `mo.watch`. | Possible because we own the runtime; marimo would need tracing it chose not to do. Dynamic edges are recorded per run and shown in the graph. |
| 6 | **Agent transactions:** `edit([...cells])` applies several edits, then the graph runs once. | #8172's batching problem. |
| 7 | A **mutation warning**, plus `verify()`. | Recomputing from scratch shows an output that depended on an untracked mutation (William's `z.x` example would be flagged). |

Kept exactly as marimo: one definer for any name that is read; `_`-names
local; no `del` or `import *` in the graph; topological order, page order
for ties; an ancestor's error stops descendants.

## The model

1. **Each notebook has its own interpreter** (a Web Worker: about 120 ms to
   start, 1.5 s more for Sage's first import). Switching notebooks switches
   interpreters, and the few most recent stay alive.
2. **Cells form a dependency graph.**
   - Each cell's defined and used top-level names come from our own parser
     and scope analysis (the same AST as CPython's). Sage code is analyzed
     after preparsing, Magma after translation.
   - Cell B depends on cell A when B uses a name A defines.
   - Cells are shown in the author's order but run in graph order, so a name
     may be defined below its use, as in marimo and Observable.
3. **Rules that make the graph well defined** (marimo's, above):
   - **One definition per name:** a name is defined in exactly one cell. A
     second definition is an error on both cells, with a clear message.
   - **No cycles:** a cycle is an error on the cells in it.
   - **Deleting a cell deletes its names.** The cells using them show
     `NameError`, with a pointer to the deleted cell.
   - **Mutation is not tracked, as in marimo:** `L.append(5)` or `z.x = 10`
     in a cell that did not define the object references it and triggers
     nothing. We add a warning ("mutates z, defined in cell 3: cells reading
     z will not rerun"). Sage's objects are mostly immutable, so it matters
     less here.
4. **Running.**
   - Running (or editing and running) a cell reruns it and every cell
     downstream, in graph order.
   - **Bounded recompute:** each cell's last run time is known. If the
     downstream rerun is predicted under a budget (1 s by default; per
     notebook, and agents can set it), it happens at once. Otherwise the
     cells downstream are marked **stale** with "run (about 12 s)".
   - Stale outputs stay visible, greyed and labeled, never silently wrong.
   - Errors stop their dependents: a dependent shows "waiting for cell 4
     (error)", not a cascade of NameErrors.
5. **Restart** starts a new interpreter and keeps every output, marked stale;
   "Run all" recomputes in graph order. Nothing is lost by restarting.
6. **Randomness is per cell.** The seed is derived from the notebook's seed
   and the cell's id, so a cell gives the same random numbers however often,
   and in whatever order, it reruns. The clock is real.
   (`design/timetravel-replay.md`'s deterministic math library is what makes
   recompute bit-exact across browsers.)
7. **Widgets (as marimo):**
   - **Built-in UI elements** (sliders, dropdowns, ...) are reactive values.
     A widget defined in one cell and read in another is an edge, and moving
     it reruns the reading cells.
   - Third-party widgets (anywidget): not adopted; see "anywidget: not
     adopted" below.
   - Our light `ipywidgets` stays for compatibility (its controls become
     reactive values too).
   - In more detail: **widgets are inputs.** A widget defined in one cell and read (`n.value`)
   in another is an edge. Moving it reruns the reading cells within the
   budget: marimo's UI model, which subsumes `@interact`. `@interact` keeps
   working as today.
8. **The console is separate:** its own interpreter, a quick ephemeral
   scratchpad, with no access to any notebook's state. A notebook's state
   comes only from its cells.
9. **Caching (later):** a cell's outputs and values keyed by its code and
   its inputs' hashes, so reopening or resuming a notebook does not
   recompute everything.

## What becomes simpler

- **TimeTravel:**
  - Resuming a version means opening it and recomputing it, since the state
    is a function of the document.
  - The execution journal, foreign runs and clock recordings go away. Run
    times stay, for estimates.
  - The `.sbreplay` bundle becomes the notebook, its history and the files
    it reads.
- **Agents:**
  - `run(cell)` returns which cells reran, which are stale, and the errors.
  - `graph()` returns the dependencies.
  - `verify()` recomputes from scratch and compares output hashes with the
    shown outputs.
  - An agent can never leave a person looking at outputs that disagree with
    the code.
- **Reading a notebook:** the order of cells is the author's narrative. The
  order of execution is the graph's, which is not the reader's job.

## Compatibility

- `.ipynb` import and export are unchanged: cells, outputs and metadata.
- A Jupyter notebook that redefines names (`x = 1` … `x = x + 1`) opens with
  those cells flagged. A one-click fix renames the later definitions (`x_2`)
  or merges the cells. Most notebooks written top to bottom satisfy the rules
  already.
- `sagebrush notebook` (native Python) and the Jupyter kernel keep their
  models. This is the browser notebook's model.

## Size

| Step | Work |
|---|---|
| One interpreter per notebook; Restart keeps outputs (stale) | 1–2 days |
| Def/use analysis, graph, rules and their errors | 2 days |
| Scheduler (graph order, budget, stale, errors stop dependents), UI | 2–3 days |
| Per-cell seeds; widgets as inputs; console as scratch | 1–2 days |
| TimeTravel simplified to recompute; agent API (run/graph/verify) | 1–2 days |

Each step has its own browser tests.

## What a "name" is

A name is a **global variable**: a name bound at the top level of a cell. It
is bound by:

- assignment (`a = 5`, `a, b = ...`, `a += 1`, `a: int = 5`);
- `def` and `class`;
- `import x` and `from m import y` (binding `x`, `y`; `import x as z`
  binds `z`);
- a top-level `for` target, `with ... as`, an `except ... as`, a walrus `:=`;
- `global a` inside a function that assigns `a`.

Examples:

- `a = 5` / `b = 10` in one cell defines `a` and `b`. Another cell may read
  them, but `a = 6` or `a += 1` there is an error ("a is defined in cell 2").
- `a.x = 1` and `a[0] = 1` do not define `a`: they mutate it, and are flagged
  as untracked when `a` is another cell's.
- Names local to a function, a lambda or a comprehension are not globals.
- As in marimo, **names starting with `_` are private to their cell**: any
  cell may use `_i` or `_tmp` freely. They are invisible to other cells and
  never conflict.

## The budget, precisely

An action is running a cell, moving a slider, or an agent's batch of edits.
After an action, the cells downstream need to run.

- **The budget caps the wall time spent running them automatically.** In
  graph order, each cell runs if its last run time still fits in what is
  left of the budget. One that does not fit waits, marked stale with its
  time ("not rerun automatically (it takes about 12 s)"), and so do the cells
  below it. The others go on: cheap cells beside a slow one stay current.
  (Implemented this way after trying "all or nothing": one slow cell then
  left every cheap cell stale too.)
- A cell never run has no time yet, so it counts as 0, and the actual time
  used is what is subtracted.
- **The two extremes are marimo's modes:** budget $\infty$ = autorun, budget
  0 = lazy.
- **A typical Sage cell takes milliseconds,** so a budget of 2 s means
  "everything cheap is always up to date; a factorization that takes a
  minute waits for you". Per notebook; an agent can raise it to $\infty$
  before it reports, and `verify()` ignores it.
- **Manual cells** (a per-cell flag) are never run automatically, whatever
  the budget: for writes to the outside world, or long jobs.

## What owning the parser and the runtime buys

marimo is a layer on CPython: it can only analyze source and wrap
execution. pyjs is our compiler and our runtime, so several of marimo's
compromises are unnecessary.

1. **The compiler is the analyzer.** Its scope analysis (src/scope.ts)
   already decides, for every name, global or local. Definitions and
   references fall out of compilation, so they cannot drift from what runs.
2. **Cells are compiled as functions of their inputs** (marimo's own file
   format, with `@app.cell def _(v): ...`, made real at compile time).
   - A cell can only see the globals it references and can only bind its
     own definitions.
   - `_`-names are locals of that function, with no mangling pass.
   - Hidden state between cells becomes impossible by construction. This is
     what marimo's dead "strict mode" tried to do with copies.
3. **Mutations can be detected, not just warned about.**
   - The runtime's containers (list, dict, set, bytearray, NumPy arrays)
     and object attribute stores can keep a version counter, bumped on each
     mutation: a few nanoseconds.
   - After a cell runs, the runtime knows exactly which other cells'
     objects it changed (William's `v[1] = 5`, `z.x = 10`, `L.append`).
   - We can then treat the cell as an updater: its readers depend on it,
     and rerunning it reruns the definer first, then the updaters in page
     order, then the readers.
   - Deeply nested mutation (an object inside a list) only shows at the top
     level when the container itself changed. That is a stated limit, and
     `verify()` catches the rest.
   - **Implemented first statically** (October 11): the analysis finds the
     mutations visible in a cell's top-level code (`v[i] = …`, `z.x = …`,
     `del v[i]`, augmented assignment to those, `v.append(…)` and other
     in-place methods, `random.shuffle(v)`, `heapq.heappush(v, …)`). Such a
     cell is an updater: readers run after it, updaters run in page order,
     and running or deleting an updater reruns the definer and the whole
     family first, so a mutation is never applied twice. Not seen: aliases
     (`w = v; w.append(…)`) and mutation inside a function called later;
     `verify()` finds those (web/test-reactive.mjs shows it). The runtime
     counters remain the way to see everything.
4. **Files and randomness** are ours already: the filesystem layer gives
   writer-to-reader edges, and the deterministic interpreter gives per-cell
   seeds and bit-identical math across browsers.
5. **What actually ran is known.** For conditional definitions and `del`
   (marimo #9347), the runtime knows whether a run really defined `x`. A
   reader then gets a precise error ("cell 3 did not define x in its last
   run: its `if` was false") instead of a stale value.
6. **Refactoring is exact.** One-click fixes (rename to `_i`, rename a
   redefinition, merge cells) are AST edits by the same parser.
7. **Interrupting is cheap.** The interrupt flag is checked in Python loops
   and in the Rust engines, so a cell can be stopped when the budget runs
   out, and its dependents left stale.

## Decisions (William, October 11, 2026)

1. **One model:** reactive. No classic, Jupyter-order mode.
2. **Agents' consistency (`run`/`graph`/`verify`) is the main reason** for
   the model.
3. **The console is a separate, ephemeral scratchpad** with its own
   interpreter, not a view of a notebook's state.
4. **The time budget is configurable.**
   - marimo has no time budget, only "autorun" (its default) or "lazy" (mark
     dependents stale). In lazy mode, running a cell first reruns its stale
     ancestors ([docs](https://docs.marimo.io/guides/configuration/runtime_configuration/)).
   - We use a budget so that cheap dependents always update and expensive
     ones wait:
     - autorun = an infinite budget;
     - lazy = a budget of 0;
     - the default is a few seconds, per notebook.
   - As in marimo's lazy mode, running a cell first reruns its stale
     ancestors.

5. **#1477's relaxation: adopted.** A name may be defined by several cells
   as long as no other cell reads it.
6. **Automatic file tracking: adopted** (writer-to-reader edges from the
   filesystem layer).

7. **Budget default: 2 s.**
8. **Mutation tracking: adopted** (version counters in the runtime; a cell
   that mutates another cell's object becomes its updater). See "What owning
   the parser and the runtime buys", 3.
9. **Page-order scoping for redefinitions: adopted** (see below), over
   marimo's error.
10. **anywidget: not adopted.**

## Progress (October 11, 2026)

**The default since October 11** (William: "this reactive mode should be
**the** mode"). `?reactive=0` in the address turns it off in that browser,
a temporary way out while the model is new (`?reactive` turns it back on).
TimeTravel has one button, Revert to this version, which makes the version
the notebook and computes it again (fresh interpreter, the files as they
were, per-cell seeds); Resume from here is gone (its old links still work).
Changing the notebook's language analyzes every cell again, stale. A cell
just run with a syntax error is run anyway, so that the interpreter shows
where (it defines nothing). A cell reading what an interrupted cell defines
waits for it, as in marimo. Tests: test/dataflow, notebook-graph
(marimo oracles), notebook-reactive, rename (npm test), and
web/test-reactive.mjs (60 browser checks).

| Piece | Where | Notes |
|---|---|---|
| Definitions and references | src/dataflow.ts | marimo's ScopedVisitor ported; identical on 3,924 oracle cells and 13,032 stdlib statements. Sage after preparsing (and `var('x y')`), Magma after translation. |
| The graph | src/notebook-graph.ts | marimo's edges and order, identical on 3,198 notebooks; #1477; cycles as strongly connected components (marimo misses some cells); identical imports allowed; updater and file edges. |
| The scheduler | src/notebook-reactive.ts | marimo's mutate_graph (no action at a distance) and runner; stale ancestors; the budget per cell; manual cells; batch edits. |
| The analyzer | web/analyze-worker.ts (sagebrush-analyze.js, 247 kB) | its own worker, so the page stays small and analysis never waits for a running cell. |
| `_` names | src/dataflow.ts mangleLocals, src/notebook-session.ts | marimo's renaming applied to the parsed tree before compiling; deleted before the cell reruns. |
| Per-cell seeds | web/replay-env.ts, notebook.js cellSeed | SHA-256 of the notebook's seed (in the document) and the cell id; Python's random and numpy.random reseeded. numpy.random's global generator now starts from entropy, as NumPy's. |
| Mutation tracking | src/dataflow.ts `mutations` | static (visible top-level mutations); aliases and mutation inside functions are left to verify(). Runtime counters later. |
| Files | web/shims/fs.ts, web/worker.ts | each run's reads and writes; uploads rerun readers. |
| Widgets | lib/ipywidgets `_report` | the cells reading a moved widget's names rerun. (anywidget: not adopted.) |
| Fix for redefinitions | src/rename.ts | "Rename the later definitions of x (x_2, …)", keeping a Jupyter notebook's meaning; scope-aware; Sage through the preparser. |
| Agents | notebook.js applyEdits/graph/verify; WebMCP edit_notebook, notebook_graph, verify_notebook | |
| UI | index.html | Auto-run (2 s, 10 s, always, never; per notebook), Run stale, manual cells (cell menu), edited marks, errors with fixes. |
| marimo's format | web/notebook/marimo.js | File > Open reads marimo .py notebooks (identical to marimo's parser on its 198 example notebooks, 1,805 cells); File > Download as marimo writes them (marimo reads all 198 back identically). lib/marimo: mo.md (rendered Markdown output), mo.ui controls (as widgets: moving one reruns its readers), hstack/vstack, stop, state, so imported notebooks run. |
| TimeTravel | index.html replayResumed | a reactive notebook resumes a version by recomputing it, with its files as they were: no "Cannot resume here". |

**Done for the default (October 11):** the tests written for Jupyter's
order were updated (test-replay runs the journal's replay behind
?reactive=0); `sagebrush notebook` runs the same session. Was listed:

1. Tests written for Jupyter's order: test-kernels (1 check: running a cell
   now reruns its dependents), test-notebook (stops at a cell that does not
   run in graph order), test-replay (resume now recomputes; the journal's
   replay stays for notebooks opened before). Measured by building with
   reactive on: everything else passes.
2. `sagebrush notebook` (the same session in a Node worker thread) handles
   `forget`, `mangle` and `seed` (Python's random and numpy.random), but not
   yet file tracking or seeding os.urandom; it needs its own reactive test.
3. Runtime mutation counters (later).

## Page-order scoping for redefinitions (decided October 11: William)

Found while measuring the flip: every Sage user writes `R.<x> = ZZ[]`, then
`x = polygen(QQ, 'x')`, then `x = var('x')` in later cells, and reads `x` in
others. Under marimo's rule those are errors, and renaming to `x_2` is
unnatural for a polynomial variable. William chose **page-order scoping**:
a cell reads the nearest definition above it, as a paper does ("let $K$ be
..." holds until $K$ is redefined) and as a Jupyter notebook read from the
top does.

How (src/notebook-reactive.ts effectiveCodes, src/rename.ts):

- A name defined by several cells and read by one is renamed in the code
  that runs: the later definitions and the cells reading them get `xʹ2`,
  `xʹ3`, ... (U+02B9, a letter Python allows in names). The page shows the
  code as written; error messages and the graph show `x`.
- Each definition is its own variable, so the graph stays exact: editing
  the first `x` reruns only the cells reading it.
- The renames are recomputed when cells run, move or are deleted; a cell
  whose renamed code changes (a definition inserted above it) reruns.
- In Sage, `var('x')` alone on a line becomes `xʹ2 = SR.var('x')` (which
  does not set the global `x`).
- A redefinition that may not run is initialized from the previous value
  (William, October 12). Examples: `if c: x = 2`; a loop body; a `try`
  that raises first; a skipped `:=`; a function binding `global x` that
  the analysis cannot place. The new name starts as the previous value,
  and every occurrence in the cell is renamed, so a skipped redefinition
  leaves the previous value, as in Python, instead of leaving `xʹ2`
  unbound.
  - The initialization is a line of its own, after the cell's docstring
    and `__future__` imports:
    `if 'x' in (lambda: 0).__globals__ or 'x' in (lambda: 0).__builtins__: xʹ2 = (lambda: x)()  # page-order scoping`.
    It binds the new name only if the previous one is bound (a global or a
    builtin), so an unbound previous name stays unbound, as Python's would.
    It reads no name of the cell's but the previous one (a user's
    `hasattr` is never called), and reads it in a lambda, so a `global x`
    outside functions, which keeps its name, stays legal. A module's
    `global x` that comes after a use of `x` is a SyntaxError in Python, so
    it is renamed and stays one (review of 5ee9fe8). The rules are
    CPython 3.14's:
    - a read, an annotated target, or any binding counts as a use;
    - an import does not, and neither does an annotation of another name
      (evaluated later, in its own scope);
    - nor does anything in a function's, lambda's or comprehension's body
      (review of d2c5a5c).

    pyjs's compiler (src/scope.ts) now applies the same rules to `global`
    and `nonlocal` everywhere. It used to reject a global after an import,
    and accepted one after a read.

    A parenthesized annotation, `(x): int`, is not simple. Without a value
    it neither binds nor annotates `x`. A simple annotation of a name
    declared global or nonlocal is an error, except at a module's top level
    (review of d304971). A line ending in `\` before `\r\n` continues too.

    An annotation alone binds nothing. The analysis (src/dataflow.ts)
    therefore no longer counts `x: int` as a definition at a module's top
    level or in a class body, and `(x): int` nowhere. In a function, a
    simple one makes `x` local, as in CPython. marimo counts them as
    definitions, and strict mode still does. An attribute's or an item's
    annotation evaluates the object and the index, and fetches nothing
    (review of 44c5a65). An annotation's expression is a reference only where Python
    evaluates it: for a simple name at a module's or a class's top level
    (when asked for). It is never evaluated in a function, or for any other
    target. An annotation alone mutates nothing (review of 3a97ae5). The renamer leaves such never-evaluated annotations as written, and
    does not count them as reads (review of 2894ce0). "In a function" means the annotation's own
    scope: a class body inside a function evaluates its annotations, when
    they are asked for. With `from __future__ import annotations` they are
    text, kept as written. A class's annotation is asked for at a time the
    analysis cannot know, so if it names a redefined name the cell is
    refused, at the top level as inside a function (review of faca9da).

    With `from __future__ import annotations`, an annotation naming a
    redefined name is text that type-hint functions resolve, perhaps from
    another cell. Renaming the text changes it; keeping it resolves to the
    old definition. Any such cell is refused, even one that only prints the
    text (review of 72dc9fd). A module's `x: int = v` keeps its key in
    `__annotations__`: it becomes `x: int; xʹ2 = v`, and a bare `x: int`
    keeps its name.
  - When a statement shares the prologue's logical line (`"doc"; print(x)`,
    or after a `\` on the next physical line), that line is split at the
    statement, with the initialization between. Otherwise the initialization
    goes after the logical line's last physical line.
    The first part ends with a `# page-order scoping` comment, so pyjs's
    session can join the line again.
  - It isn't used where annotations naming the name are kept as text
    (`from __future__ import annotations`).
  - A bare annotation (`x: int`) is not a binding, and a loop body with a
    `break` or `continue` may skip what follows it (sagebrush-codex's
    review of 8c8211a). A cell whose only binding is a bare annotation is
    initialized, so it keeps the value (review of 5ee9fe8).
  - The cell then reads the previous definition, so editing it reruns the
    cell.
  - pyjs's session takes the line out of the text and runs the same
    statement on the first statement's line, so tracebacks keep the cell's
    line numbers. Other hosts (the CPython differential driver, Jupyter
    kernels) run the line as written.
- Names that cannot be renamed (Magma) keep marimo's error and its fix.
- marimo's rule otherwise: a name nobody reads may be defined by several
  cells (#1477), and the same import in several cells is not a conflict.

## anywidget: not adopted (William, October 11)

Third-party widget JavaScript would run in the page (or need a sandboxed
iframe and a message bridge): "fighting XSS sucks and pulling in JS so
explicitly feels like a leaky abstraction". Widgets are Sagebrush's own
(ipywidgets subset, @interact, marimo's mo.ui), drawn by the page.

## Differential fuzzing (October 11)

William: "YES. I love fuzzing." `node dist/test/fuzz-reactive.js --seed N
--cases N --steps N` (test/fuzz-lib.ts, test/fuzz_kernel.py) generates
random notebooks weighted toward scoping (redefinitions, `+=`, walrus,
`global`, `del`, `except ... as`, class bodies with compound statements,
lambdas, comprehensions and method defaults), runs them through the real
scheduler and renamer in CPython, then applies random edits, inserts,
deletes and moves. After every step, every cell the scheduler shows as
computed must print what a fresh top-to-bottom run of the notebook prints
(the cells shown with an error, a refused rename, left out). Failures are
shrunk to a few cells. The generator keeps to what the rules promise to
match plain Python: no shared mutable objects, randomness, files, run-time
conditional definitions, or functions called from other cells reading
redefined names (they read their own cell's definition, by design).

Found and fixed on the first day (each a case in
test/fuzz-reactive.test.ts, which also runs 150 random notebooks in
npm test, and fails on the code before the fix):

1. `y = 7` then `y += 4` in the next cell: marimo's analysis does not
   count `+=` as a read, so nothing was renamed and the second cell
   deleted the first one's `y` before running. `x += 1` is now a read
   (as in Python), and a name defined by several cells is renamed when a
   later definition reads the previous one.
2. A class's body, bases and decorators, and a def's defaults, read the
   previous value of the class's or function's own name (they run before
   it is bound); the renamer read them as the new one.
3. `del y` was taken as a definition by the renamer (`del yʹ2`).
4. A cell that deleted a name, edited to read it, or a reader inserted
   above the deletion, found it gone: reading or deleting a deleted name
   now reruns its definer (like an updater's family), and removing or
   editing away a `del` reruns the definer.
5. `except E as x` at the top level deletes the global `x` (Python does
   at the handler's end): now counted as deleting it (`unbinds`).
6. A move that made a cycle left the cells on it showing their old
   outputs: a cell whose renamed code changed no longer counts as a cell
   that worked before, so it shows the cycle.
7. marimo's analysis lets the functions, lambdas and comprehensions inside
   a class see the class's names (Python does not), resolves a method's
   defaults inside the method, removes references "captured" by a later
   class attribute, and keeps a class attribute defined after `del`. Fixed
   in our analysis; `analyzeCell(..., { strict: true })` is still exactly
   marimo's (both marimo oracles pass strict; 8 oracle cells differ when
   not strict, listed in test/dataflow.test.ts).
8. A cell that got an error kept the effect of its last run (a deletion, an
   in-place change): now undone as for a removed cell.
9. marimo's rule that a later definition "captures" earlier reads of a name
   in nested scopes (`def f(): return x` then `x = 0`) also dropped reads
   that run at once, in a class body or a comprehension: now only reads
   from a function's body are dropped.
10. Before a cell ran, every name it defined was deleted, including one
    another cell also defines when it was not renamed (no other cell reads
    it): a cell reading the previous value (in a lambda it calls at once)
    found it gone. Names another valid cell defines are kept, as the
    planning step already did (#1477).

After the fixes, with no difference from plain Python: 20,000 notebooks
from seed 10,001 with 8 random steps each (177,893 checks, 778,319 cell
outputs compared) and 15,000 from seed 50,001 with 12 steps (192,377
checks, 840,451 outputs). About 3% of the cells checked are shown with an
error instead: a refused rename, mostly in class bodies whose reads depend
on how the body runs, or a cycle made by a move.

**sagebrush-codex's review of the fuzzer (October 11).** Fixed: a method's
or stored lambda's body reads the redefined class by name when called (the
new class), a lambda called where it is written (`(lambda: C.a)()`) reads
the previous one; a `:=` in a default or a base binds the notebook's name;
a cell run by hand needs its definer's family whatever the budget (a
deleted name, an updater); the shrinker only tries smaller cases (it looped
on a harness error); the interpreter's death fails the run (exit 2) instead
of passing silently; and the cells after one that raises in plain Python
are compared unless they depend on it. The generator now also edits K (read
by the functions' bodies), puts methods and lambdas reading their class by
name, called in the same cell, and `:=` in defaults. Then, with no
difference from plain Python: 15,000 notebooks from seed 1 with 6 steps
(516,839 outputs compared) and 15,000 from seed 100,001 with 10 steps
(816,547). Not covered yet: budgets, manual cells, Stop, restarts and
concurrent edits (each needs its own invariant), Sage and Magma cells, and
pyjs as the interpreter (the fuzzer runs CPython).

**sagebrush-codex's and sagebrush-daybreak's review of 960105c (October 12).**
Both reviewers focused on *when* code runs. Fixed:
- Code that runs later than written reads the definition in force when it
  runs: function bodies, stored lambdas, generator expressions consumed
  later (REACT-F20, F23), and annotations (lazy in Python 3.14; never
  evaluated by pyjs) (F26).
- A definition inside a function (`global x`) takes effect where the cell
  calls it (F24).
- Refused instead of guessing: a callable used both before and after a new
  definition; a definition in code that may never run (an unconsumed
  generator, an uncalled function); a function called while its class is
  made (F21).
- A `:=` in a default inside a function with `global x` (F22).
- Renamed definitions keep `__name__` and `__qualname__` (F25):
  restoreDefNames inserts `__sb_rename__(Cʹ2, "C")` in the tree at the
  definition's last position, and the fuzzer's CPython does the same. This
  found a pyjs bug: setting an attribute on a class ignored the
  metaclass's data descriptors (`C.__name__ = ...` did nothing); also
  type's `__doc__` had no setter. Both fixed.
- `except E as x` counts as a definition (after which x is gone, as in
  Python) for renaming and the graph.
- In the default analysis, reads from module-level functions of a name the
  cell defines later are references (marimo's capture rule drops them; a
  function can be called before the definition). Strict mode is still
  exactly marimo. On marimo's oracle, 23 cells gain such references, all of
  names the cell defines.
- A lazy-only definition (`:=` in an unconsumed generator) does not hide
  the cell's later reads.
- The fuzzer now also checks that a cell raising in plain Python raises
  here, after the same output (FUZZ-F4). It applies to cells that read only
  cells above them, and whose ancestors do too. It also generates lambdas
  read before a new definition, unconsumed walrus generators, and
  `__name__`/`__qualname__` prints.

**Reviews of 3bc474f (sagebrush-codex REACT-3BC-1..8; sagebrush-daybreak
REACT-3BC-9..19, FUZZ-3BC-1; October 12).** Fixed:
- *Running at once vs later.* Calls that consume what they are given
  (list, sum, sorted, ...) run it at once; other calls (map, iter) may keep
  it, so the rename is refused.
- *Setters.* A `global x` setter takes effect only where it surely runs:
  - a plain def, called exactly once, not under if/and/or/loops;
  - not async, not a generator, not decorated, not rebound before the
    call, and not called from inside an annotation.

  Its read of the previous value needs a single call. `x = x + 1` inside
  it reads the previous value.
- *`global x`* in a class body.
- *Construction hooks.* A decorated class, or one with a metaclass, refuses
  methods that read the class.
- *Annotations* are refused when they may be asked for before the
  definition, under a decorator, or under future annotations.
- *Lazy definitions.* A definition made only in a function body or an
  unconsumed generator (however many) does not hide a later read.
- *Hygiene.* Internal names avoid every identifier written in any cell;
  `global` names are found in any script and over continued lines.
- *The internal names' map* is cleared when nothing needs renaming.
- *Names (the lowering daybreak proposed).* A renamed def or class is made
  under its written name between `__sb_push__`/`__sb_pop__`, which keep
  and restore the previous binding and move the new one to its internal
  name. That replaces patching `__name__` afterwards. Decorators,
  metaclasses, code names and nested qualified names all see the written
  name, and so do f-string `{x=}` labels and t-string expressions.
- *Fuzzer.* It compares the exception type of cells raising in plain
  Python, and generates `{x=}` prints.

Known limit: a base class's `__init_subclass__` calling a method that
reads the class by name.

**sagebrush-codex's review of e555163 (October 12).** Fixed:
- *A regression from the lowering:* it called `globals()`, which user code
  may rebind (a parameter named `globals`). It now uses
  `(lambda: 0).__globals__`, which no name can shadow.
- *Consumers by role.* Only generators passed positionally to list, tuple,
  set, frozenset, sum, sorted, min, max, any, all, and lambdas given as
  `key=` to sorted/min/max/`.sort`, run at once. Neither dict nor `.join`
  counts, nor a consumer the cell rebinds.
- *More places that may not run:* an assert's message, a chained
  comparison's later operands, a try body, a comprehension's later
  iterables, and a generator's later iterables (lazy).
- *A setter's store* must be a statement of its body, with no return, raise
  or assert before it.
- *Lowering in class bodies* that declare a name global.
- *Rebound decorators.* A rebound staticmethod, classmethod or property is
  not a plain decorator.
- *Annotations of the definition itself* are refused under future
  annotations, with a class decorator or metaclass, a method decorator, or
  when the class body mentions annotations.

The review's 30 cases are in test/fuzz-cases-e555163.json, run by the
fuzz test.

**sagebrush-codex's review of 87fd4d5 (October 12).** Every list of
"consumers" and "plain decorators" had a counterexample:
- `sum([], gen)` keeps the generator as its start;
- `max` returns one of its arguments;
- `list` may be another cell's function;
- `Box.sort(key=)` may store the key;
- a `.setter` decorator may run its function.

So none is assumed any more:
- *Calls and decorators.* A lambda or generator given to any call, and a
  decorated function whose body reads the redefined name, are refused.
- *Setters.* A setter's store must also surely run within its statement
  (not after and/or, in an assert message, a conditional branch or a later
  comparison operand). A call inside a `with` body may not run (the
  context manager may suppress an exception).
- *Own annotations.* A class body handing one of its functions to a call
  refuses the class's own annotations.
- *Two regressions fixed.* A def's own name as a setter's store was
  refused; it is now placed by the def statement itself. In pyjs, a
  definition the enclosing scope declares global was qualified with the
  scope's name; CPython uses the bare name, and so does pyjs now
  (src/scope.ts).

The fuzz test now loads the review's 96 cases
(test/fuzz-cases-87fd4d5.json), and requires the controls to run, not
just to avoid a wrong value (MUST_RUN).

**Review of 98eb351 (sagebrush-codex REACT-98EB-1..4; October 12).** All
19 earlier variants were confirmed fixed. Four groups were fixed here, with
14 failing variants:
- *Decorators run what they decorate* (98EB-1). In each case below, the
  rename is refused:
  - a function written before the new definition, with a decorator (its
    own, or its class's decorator, metaclass or body using it), since it
    may already have run;
  - a decorated def whose body reads its own name;
  - a default of a decorated function, or of a method its class may call.
- *A setter's arguments are evaluated before it runs* (98EB-2):
  `setx(x)` reads the previous x.
- *Annotations through containers and aliases* (98EB-3). Any use of a
  method's name in its class body, and `locals()`/`vars()`, refuses the
  class's own annotations.
- *A global `:=` in a comprehension* (98EB-4). In a function declaring the
  name global, it defines the module's name in the analysis (it was missed,
  so an edit did not rerun its readers). As a setter's store, it counts
  only if the comprehension surely runs: every iterable a literal with
  elements, and no filters.

The fuzzer now generates all four patterns:
- setters given the old value;
- comprehension setters over empty and non-empty iterables;
- decorators that call a function reading a name redefined below.

With the new generator, 98eb351 fails 5 cases within the first ~60; the fix
passes 3,000 random notebooks (104,758 outputs compared). The review's 27
cases are in test/fuzz-cases-98eb351.json.

**Review of 6748f98 (sagebrush-codex REACT-6748-1..3; October 12).** All 14
98EB variants were confirmed repaired. Seven of the ten new failures were
regressions introduced by the 98EB fixes; all ten are fixed:
- *Arguments that change the name first* (6748-1). Two calls now refuse:
  `setx((x := 5), x)` stores the name in an argument, and
  `setx(setx(1, 1), x)` runs a call there. A setter's arguments read the
  previous value only when they do neither.
- *Non-empty is not once* (6748-2). A comprehension that iterates more than
  once, such as `[(x := x + 1) for _ in [0, 1]]`, reads the new value from
  its second iteration on. When its literals have more than one element,
  any other occurrence of the name inside it refuses. One iteration, and
  repeated constants, still run.
- *Methods under compound statements* (6748-3). A method defined under
  `if`, `for`, `try` or `with` in a class body also counts as used, which
  refuses the class's own annotations.

The fuzzer now generates setter arguments that store the name or call the
setter, and comprehension setters that read the name in each iteration.
With it, 6748f98 fails 5 of the first cases, and the fix passes 3,000 random
notebooks (102,980 outputs compared). The review's 15 cases are in
test/fuzz-cases-6748f98.json.
