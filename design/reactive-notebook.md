# A reactive notebook for sagebrush.space

**Status:** accepted direction (October 11, 2026); not implemented yet.
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
3. **Rules that make the graph well defined:**
   - **One definition per name:** a name is defined in exactly one cell. A
     second definition is an error on both cells, with a clear message.
   - **No cycles:** a cycle is an error on the cells in it.
   - **Deleting a cell deletes its names.** The cells using them show
     `NameError`, with a pointer to the deleted cell.
   - **Mutation is not tracked:** `L.append(5)` in a cell that did not define
     `L` is flagged with a warning ("mutates L, defined in cell 3: changes
     made here are not tracked"). marimo has the same limit. Sage's objects
     are mostly immutable, so it matters less here.
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
7. **Widgets are inputs.** A widget defined in one cell and read (`n.value`)
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

## Still open

- **Strict one-definition rule:** recommended, with `_`-private names as the
  escape hatch (see "What a name is").
- **The budget's default value.**
