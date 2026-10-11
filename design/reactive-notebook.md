# A reactive notebook for sagebrush.space

**Status:** accepted direction (October 11, 2026). Step 1 is implemented:
one interpreter per notebook, Restart keeps outputs (stale), the console as a
separate scratchpad (web/test-kernels.mjs).
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

- Our analysis, over our own parser's AST, must give the same definitions
  and references as marimo's on its own test cases: `tests/_ast/test_visitor.py`
  (109 tests) and `tests/_runtime/test_dataflow.py` (61), under Apache-2.0,
  with attribution.
- It must also agree on notebooks and generated snippets, through a
  differential harness that runs `marimo` under CPython.
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
   - **Third-party widgets** use the **anywidget** protocol
     ([manzt/anywidget](https://github.com/manzt/anywidget), MIT), which
     marimo supports in place of ipywidgets:
     - the front end is an ES module (`render({model, el})`) running in the
       page;
     - the model's state (get/set/`change:` events) is synced with the
       Python object in the worker;
     - Python gets a light `anywidget.AnyWidget` with traitlets-style synced
       attributes.
     This opens the existing anywidget ecosystem.
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

- **The budget caps the wall time spent running them automatically.** Cells
  are started in graph order while the time used is under the budget. When
  it is exceeded, no new cell is started (the one running finishes), and the
  rest are marked stale with "run 3 stale cells (about 12 s)".
- **Prediction only drives the estimate and the order of the decision.** If
  the recorded times say the whole set fits, it simply runs; if they say it
  cannot, nothing downstream starts, rather than half of it. A cell never
  run has no time yet, so it counts as 0 and the cap protects us.
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
